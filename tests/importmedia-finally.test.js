// Run: node tests/importmedia-finally.test.js
//
// importMedia's creation lands the name in a finally, and only at the end (js/session.js:1580):
//
//   const r = await (disk ? this.diskStoreChange(() => this.media.write(target, bytes), target) : this.media.write(target, bytes));
//   try { await this.refreshCase(); } finally { if (disk) this.creationLanded(target); }
//
// and importDiskStored does the same (its `finally { this.creationLanded(full) }`):
//
//   try { await this.refreshCase();
//         try { return await this.mountDisk(...); } catch (e) { throw new SessionError(...); } }
//   finally { this.creationLanded(full); }
//
// "Only at the end" is TWO claims, and this file proves both separately, because a landing that merely is not
// skipped satisfies the first and not the second:
//   (a) the landing is not skipped, and survives a throwing probe (cases 1-5);
//   (b) the landing is not made EARLY -- straight after the write, before the probe finishes (cases 6-7). There is a
//       real await between the write and the end (refreshCase -> measureOnce -> detectCase -> await store.list(),
//       js/session.js:1501, js/host/media-store.js:247-260), and a creation asked inside it is the exact case
//       importDiskStored's landing comment describes ("a creation asked at any point while this one runs").
//
// What the landing guards is NOT "a later import of the same name is refused": a creation asked after the first has
// finished has askedAt >= its landing, and landedRace (js/session.js:1461) only refuses a landing made AFTER the
// asker's askedAt. What it guards is a creation QUEUED BEHIND the first, asked while the first was in flight
// (askedAt below its landing): the first is stored, so the second must refuse rather than replace it.
//
// landedRace's `if (p.at <= askedAt) break` is not exercised here: creationFinished's pruning (js/session.js:1454-1458)
// empties pendingLands in every scenario this file reaches, so no entry ever sits below the break with this suite's
// ordering. The pruning itself IS pinned (case 3's "record was pruned" check).
//
// The oracle is the store's own bytes and the exact refusal text; nothing here infers them by running the code under
// test.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// A MemoryMediaStore that behaves like the real backends in the one respect that matters here: it is ASYNCHRONOUS
// and its case rule may not be known. `ready()` measures it through a listing (js/session.js:307 -> measureCase);
// `unmeasure()` puts it back to unmeasured so the next refreshCase asks the store again.
//  * unmeasure(true)  -- the listing FAILS, so detectCase rethrows and refreshCase throws with that message.
//  * unmeasure(false) -- the listing works but can be held (`gateList`), which opens the post-write window without
//    making anything throw.
// (A synchronous MemoryMediaStore cannot reach either: its Session constructor measures it through detectCaseSync at
// js/session.js:220, and measureOnce short-circuits on a measured store at media-store.js:248.)
class UnmeasuredStore extends MemoryMediaStore {
  get synchronous() { return false; }
  async list(prefix = '') {
    if (this.listGate) { const g = this.listGate; this.listGate = null; this.listWaiting = true; await g; }
    if (this.failList) throw new Error('test: the store cannot list');
    return super.listSync(prefix);
  }
  async stat(name) { return super.statSync(name); }
  async read(name) { return super.readSync(name); }
  async write(name, bytes) { return super.writeSync(name, bytes); }
  async remove(name) { return super.removeSync(name); }
  async rename(from, to) { return super.renameSync(from, to); }
  unmeasure(failList = true) { this.caseMeasured = false; this.failList = failList; }
}

const session = async (media) => { const s = new Emu.Session({ media }); s.switchMachine('dgnalpha'); await s.ready(); return s; };
const q = (p) => p.then((m) => ({ ok: true, m }), (e) => ({ ok: false, m: e.message }));
const spin = async (k = 500) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };

// hold the store's write of `name` on a promise: the creation is inside its write when the test lets go
const holdWrite = (store, name) => {
  const real = store.write.bind(store);
  let release = null, hold = 1;
  store.write = (n2, b) => { if (n2 === name && hold-- > 0) return new Promise((r) => { release = () => r(real(n2, b)); }); return real(n2, b); };
  store.armed = async () => { for (let i = 0; i < 500 && !release; i++) await new Promise((r) => setImmediate(r)); return !!release; };
  store.release = () => release && release();
  return store;
};
// hold the store's next listing: the creation has its bytes written and is inside refreshCase when this lets go
const gateList = (store) => {
  let release = null;
  const p = new Promise((r) => { release = r; });
  store.listGate = p; store.listWaiting = false;
  return {
    armed: async () => { for (let i = 0; i < 500 && !store.listWaiting; i++) await spin(2); return store.listWaiting; },
    release: () => release(),
  };
};
// a store read that reports a FAIL rather than a crash when the creation never wrote anything
const readOr = async (media, name) => { try { return await media.read(name); } catch (e) { return null; } };
const size = (b) => (b ? b.length : 'nothing');

const A = () => images.vdk(40, 2), B = () => images.vdk(40, 1);
const NAME = 'work.vdk', FULL = 'disks/work.vdk';
const REFUSAL = `There is already a disk named ${NAME} in your library: choose another name.`;

(async () => {
  // ---------------- 1. importMedia: refreshCase throws after the store has taken the bytes ----------------
  // The first import is held inside its store write; a second import of the same name is asked while it is held
  // (so it queues behind it, askedAt below the first's landing); then the write is released and refreshCase throws.
  {
    const media = holdWrite(new UnmeasuredStore(), FULL), s = await session(media);
    media.unmeasure();
    const p1 = q(s.library.importMedia(NAME, A()));
    check('importMedia: the first import is at its store write before the second is asked', await media.armed());
    const p2 = q(s.library.importMedia(NAME, B()));
    media.release();
    const r1 = await p1, r2 = await p2;
    // the error the code intends: mediaError's fallback, "<name>: <refreshCase's message>" (js/session.js:1589)
    check('importMedia: a throwing refreshCase is reported as the import\'s error, by name and reason',
      !r1.ok && r1.m === `${NAME}: test: the store cannot list`, r1.m);
    check('importMedia: its bytes ARE stored (the write had landed before refreshCase)',
      same(await readOr(media, FULL), A()), `stored ${size(await readOr(media, FULL))} bytes`);
    check('importMedia: the creation queued behind it is refused, by the exact library message',
      !r2.ok && r2.m === REFUSAL, r2.m);
    check('importMedia: the store still holds the FIRST image (the queued second did not replace it)',
      same(await readOr(media, FULL), A()));
  }

  // ---------------- 2. control: the same shape, refreshCase succeeding ----------------
  {
    const media = holdWrite(new UnmeasuredStore(), FULL), s = await session(media);
    const p1 = q(s.library.importMedia(NAME, A()));
    check('control: the first import is at its store write before the second is asked', await media.armed());
    const p2 = q(s.library.importMedia(NAME, B()));
    media.release();
    const r1 = await p1, r2 = await p2;
    check('control: the first import succeeds', r1.ok && typeof r1.m === 'object' && r1.m.stored !== undefined, JSON.stringify(r1.m));
    check('control: the creation queued behind it is refused by the same exact message', !r2.ok && r2.m === REFUSAL, r2.m);
    check('control: the store still holds the first image', same(await readOr(media, FULL), A()));
  }

  // ---------------- 3. a creation asked AFTER the first finished is a deliberate replace, not a stale block ----------------
  // And the landing record is pruned once nothing is queued (creationFinished, js/session.js:1454-1458): pendingLands
  // does not grow without bound and cannot refuse a name later.
  {
    const media = new MemoryMediaStore(), s = await session(media);
    const r1 = await q(s.library.importMedia(NAME, A()));
    const landedAfterFirst = s.library.landing;
    // The first was a disk image, so it landed (creationLanded) and was queued; once its creation finished with
    // nothing behind it, creationFinished pruned the record - so nothing is pending now, and the second import is a
    // deliberate replace by the same rule that lets a finished name be taken again.
    const pendingNow = JSON.stringify(s.library.pendingLands);
    const r2 = await q(s.library.importMedia(NAME, B()));
    check('after it finished: the same name imports again, as a deliberate replace (no stale record refuses it)',
      r1.ok && r2.ok, `${JSON.stringify(r1.m)} / ${JSON.stringify(r2.m)}`);
    check('after it finished: the store now holds the second image', same(await readOr(media, FULL), B()));
    check('after it finished: the first landed, and its record was pruned once nothing was queued behind it',
      landedAfterFirst === 1 && pendingNow === '[]', `landing ${landedAfterFirst}, pending after it ${pendingNow}`);
  }

  // ---------------- 4. importDiskStored: the same finally ----------------
  // importDiskStored is the other way a disk image's name is created (the drives' import), and it lands the same
  // way. Held at its own store write, a second import of the name queued behind it, refreshCase throwing: the first
  // reports the throw, its bytes are stored, and the queued second refuses.
  {
    const media = holdWrite(new UnmeasuredStore(), FULL), s = await session(media);
    media.unmeasure();
    const p1 = q(s.drives.importImage(NAME, A(), 0));
    check('importDiskStored: the first import is at its store write before the second is asked', await media.armed());
    const p2 = q(s.drives.importImage(NAME, B(), 1));
    media.release();
    const r1 = await p1, r2 = await p2;
    // The creation reports its errors the way importMedia does: mediaError's fallback, "<name>: <reason>". The name
    // is the creation's `base`, so it does not depend on which caller asked (importDisk here, newDisk in case 9).
    check('importDiskStored: a throwing refreshCase is reported as the import\'s error, by name and reason',
      !r1.ok && r1.m === `${NAME}: test: the store cannot list`, r1.m);
    check('importDiskStored: its bytes ARE stored', same(await readOr(media, FULL), A()));
    check('importDiskStored: the creation queued behind it is refused by the exact library message',
      !r2.ok && r2.m === REFUSAL, r2.m);
    check('importDiskStored: the store still holds the FIRST image', same(await readOr(media, FULL), A()));
  }

  // ---------------- 5. importDiskStored control ----------------
  {
    const media = holdWrite(new UnmeasuredStore(), FULL), s = await session(media);
    const p1 = q(s.drives.importImage(NAME, A(), 0));
    check('importDiskStored control: the first import is at its store write', await media.armed());
    const p2 = q(s.drives.importImage(NAME, B(), 1));
    media.release();
    const r1 = await p1, r2 = await p2;
    check('importDiskStored control: the first import succeeds and mounts', r1.ok && r1.m === `${NAME} in drive 0`, r1.m);
    check('importDiskStored control: the queued second is refused by the exact message', !r2.ok && r2.m === REFUSAL, r2.m);
    check('importDiskStored control: the store still holds the first image', same(await readOr(media, FULL), A()));
  }

  // ---------------- 6. the landing is at the END, not straight after the write (importMedia) ----------------
  // Here nothing throws: the store's listing is HELD, so refreshCase is inside its await when the second creation
  // is asked. This is the window importDiskStored's landing comment names. With the landing made at the end, the first has not
  // landed when the second is asked (askedAt below it) and the second refuses. With the landing made straight after
  // the write, it has already landed, the second's askedAt equals it, landedRace breaks, and the second replaces
  // the first -- which is the defect this case exists to catch.
  {
    const media = new UnmeasuredStore(), s = await session(media);
    media.unmeasure(false);   // unmeasured, so refreshCase asks; the listing is holdable and does not fail
    const gate = gateList(media);
    const before = s.library.landing;
    const p1 = q(s.library.importMedia(NAME, A()));
    check('importMedia at the end: the first import is inside its case probe, past its write', await gate.armed());
    check('importMedia at the end: the first creation has NOT landed while its probe is pending',
      s.library.landing === before, `landing ${s.library.landing}, was ${before}`);
    const p2 = q(s.library.importMedia(NAME, B()));
    gate.release();
    const r1 = await p1, r2 = await p2;
    check('importMedia at the end: the first import succeeds', r1.ok, JSON.stringify(r1.m));
    check('importMedia at the end: a creation asked inside the probe is refused, by the exact library message',
      !r2.ok && r2.m === REFUSAL, r2.m);
    check('importMedia at the end: the store still holds the FIRST image', same(await readOr(media, FULL), A()));
  }

  // ---------------- 7. the same window on the importDiskStored path ----------------
  {
    const media = new UnmeasuredStore(), s = await session(media);
    media.unmeasure(false);
    const gate = gateList(media);
    const before = s.library.landing;
    const p1 = q(s.drives.importImage(NAME, A(), 0));
    check('importDiskStored at the end: the first import is inside its case probe, past its write', await gate.armed());
    check('importDiskStored at the end: the first creation has NOT landed while its probe is pending',
      s.library.landing === before, `landing ${s.library.landing}, was ${before}`);
    const p2 = q(s.drives.importImage(NAME, B(), 1));
    gate.release();
    const r1 = await p1, r2 = await p2;
    check('importDiskStored at the end: the first import succeeds and mounts', r1.ok && r1.m === `${NAME} in drive 0`, r1.m);
    check('importDiskStored at the end: a creation asked inside the probe is refused by the exact message',
      !r2.ok && r2.m === REFUSAL, r2.m);
    check('importDiskStored at the end: the store still holds the FIRST image', same(await readOr(media, FULL), A()));
  }

  // ---------------- 8. the diskStoreChange path, and the variant that cannot reach the finally ----------------
  // Cases 1-3 and 6 all take the diskStoreChange branch: a .vdk is detected as a disk image, so `disk` is true at
  // js/session.js:1566 and the write runs through `this.diskStoreChange(() => this.media.write(...), target)`
  // (the `write` closure). What this section pins is the other half: a target that is mounted in a drive is refused
  // by checkNotInDrive, before any creation's turn, so the finally is never entered for it. There is no test to
  // write for "a mounted target whose refreshCase throws": the refusal comes first, by name and with the drive, and
  // nothing is written.
  // The spy is what makes this a claim about the OUTER call (the checkNotInDrive before createExclusive) rather than
  // about the inner one (the same check inside `write`): removing the outer call still refuses, so a check that only
  // reads the message passes for the wrong reason. Counting createExclusive tells the two apart.
  {
    const media = new UnmeasuredStore(), s = await session(media);
    let exclusive = 0;
    const realExclusive = s.library.createExclusive.bind(s.library);
    s.library.createExclusive = (op) => { exclusive++; return realExclusive(op); };
    // mount the name first: the first import's bytes land and the mount succeeds while refreshCase still works
    await q(s.drives.importImage(NAME, A(), 0));
    media.unmeasure();   // from here refreshCase would throw, if it were ever reached
    const before = await readOr(media, FULL);
    exclusive = 0;
    // importMedia over the mounted name: refused synchronously, by checkNotInDrive
    const r = await q(s.library.importMedia(NAME, B()));
    check('mounted target: importMedia is refused by name and drive',
      !r.ok && r.m === `${NAME} is in drive 0; eject it before you replace it.`, r.m);
    check('mounted target: the refusal comes before any creation turn (no createExclusive was entered)',
      exclusive === 0, `createExclusive calls: ${exclusive}`);
    check('mounted target: nothing was written, so the mounted image is unchanged',
      same(await readOr(media, FULL), before));
    check('mounted target: refreshCase was never the reason (its throw did not reach the caller)',
      !(r.m || '').includes('test: the store cannot list'), r.m);
  }

  // ---------------- 9. newDisk: the same creation, so the same named error ----------------
  // newDisk holds the creation turn itself and calls importDiskStored directly (inside its createExclusive); it never goes
  // through importDisk. So the wrapping cannot live in importDisk: it is done ONCE inside importDiskStored, and this
  // case is the second caller's proof of it -- without the wrap this reports the bare store message, exactly as
  // case 4 did before.
  {
    const media = holdWrite(new UnmeasuredStore(), FULL), s = await session(media);
    const p1 = q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: NAME }));
    check('newDisk: the creation is at its store write before the probe can throw', await media.armed());
    media.unmeasure();   // from here the case probe throws; the held write is released below
    media.release();
    const r1 = await p1;
    check('newDisk: a throwing refreshCase is reported as the creation\'s error, by name and reason',
      !r1.ok && r1.m === `${NAME}: test: the store cannot list`, r1.m);
    check('newDisk: its blank IS stored (the write had landed before refreshCase)',
      same(await readOr(media, FULL), Emu.blankDisk('vdk', 40, 1)), `stored ${size(await readOr(media, FULL))} bytes`);
  }

  // ---------------- 10. newDisk: an error the creation already phrased is not named twice ----------------
  // The "saved to your Library but not put in drive" message is thrown inside the creation (its inner mount catch) and
  // is already a SessionError naming the disk. mediaError must hand it on unchanged: the wrap this branch adds must
  // not turn it into "work.vdk: work.vdk was saved ...". The mount is made to fail the way a stored image that has
  // gone missing does (stat finds nothing).
  {
    const media = new UnmeasuredStore(), s = await session(media);
    const realStat = media.stat.bind(media);
    media.stat = async (n) => (n === FULL ? null : realStat(n));
    const r1 = await q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: NAME }));
    check('newDisk: a mount that fails keeps the creation\'s exact "saved but not put in drive" wording, with no second name',
      !r1.ok && r1.m === `${NAME} was saved to your Library but not put in drive 0: ${NAME} is no longer stored in this browser; load it again.`, r1.m);
    check('newDisk: ... and the blank it saved is still in the store', same(await readOr(media, FULL), Emu.blankDisk('vdk', 40, 1)));
  }

  // ---------------- 11. newDisk: the listing at the creation's own check is named too ----------------
  // newDisk chooses and checks its name before it calls importDiskStored and before any write, so a failing listing
  // there is a raw store error too. It is still this creation's, and is named the same way; the reference is the
  // name asked for. Nothing was written: the failure is before the write.
  {
    const media = new UnmeasuredStore(), s = await session(media);
    media.unmeasure();   // the creation's listDisks() throws: "test: the store cannot list"
    const r1 = await q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: NAME }));
    check('newDisk: a failing listing at its own name check is reported by name and reason',
      !r1.ok && r1.m === `${NAME}: test: the store cannot list`, r1.m);
    check('newDisk: ... and nothing was stored (the failure is before the write)', media.listSync('disks').length === 0);
  }

  // ---------------- 12. the name-less and the already-named store message ----------------
  // Two shapes nothing above reaches, both measured against what the SAME creation reports through importMedia,
  // which is the form this branch set out to match (and not a form invented here).
  //
  // (a) No name asked, healthy store: newDisk picks one, so the listing must still be reached and the disk made.
  //     This is the control that keeps the naming code from breaking the unnamed path.
  // (c) No name asked, FAILING store: the name is CHOSEN FROM THE LISTING, so the listing can fail before any name
  //     exists -- the one case where the creation has no name to report under. It must still say something useful
  //     rather than the bare store text (which is the gap this branch exists to close).
  // (d) A name that leaves an empty label ("disks/" keeps nothing after the prefix) is now REFUSED by every disk
  //     door (diskStoreName), so the label question below is answered before any listing: the refusal is the
  //     creation's own message and is handed on unchanged. (Names with a base still take the old path.)
  // (b) A store message that itself names the file: mediaError drops a leading copy of the stored path (it is the
  //     same file), so the creation names the disk once and the reason follows. The test pins PARITY with
  //     importMedia -- the same failure through either door reads the same -- rather than a form invented here.
  {
    const media = new UnmeasuredStore(), s = await session(media);
    const r = await q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }));
    check('newDisk: with no name asked it still makes one (the naming code did not break the unnamed path)',
      r.ok && r.m === 'New blank disk: disk-1.vdk in drive 0', r.m);
    check('newDisk: ... and the store holds it under the chosen name', same(await readOr(media, 'disks/disk-1.vdk'), Emu.blankDisk('vdk', 40, 1)));
  }
  {
    // a store whose listing fails outright, with no name asked: the failure comes before a name is chosen
    const media = new UnmeasuredStore(), s = await session(media);
    media.unmeasure();   // listDisks() throws "test: the store cannot list"
    const r = await q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }));
    check('newDisk: with no name asked, a failing listing is still reported with a label, not bare',
      !r.ok && r.m === 'A new disk: test: the store cannot list', r.m);
  }
  {
    // a name with nothing after the prefix is refused before any store work: the listing is never asked
    const media = new UnmeasuredStore(), s = await session(media);
    media.unmeasure();
    const r = await q(s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'disks/' }));
    check('newDisk: a name that leaves an empty label is refused as a name, whatever the store is doing',
      !r.ok && r.m === 'A disk image needs a name.', r.m);
  }
  {
    // A store failure with the shape a real backend uses for a refused operation: its message already carries the
    // path (js/host/media-store-fsa.js wrap: `${name}: ...`). Raised by the case PROBE, which is inside the creation
    // and has no catch of its own, so it reaches the creation's catch -- the path this branch added. importMedia
    // reports the same shape for the same reason, so the test pins parity with it, not the repetition itself.
    class ListFails extends UnmeasuredStore {
      async list(prefix = '') { if (this.caseMeasured === false) throw new Error(`${FULL}: permission was refused`); return super.list(prefix); }
    }
    const media = new ListFails(), s = await session(media);
    media.unmeasure(false);   // unmeasured, so refreshCase lists; the listing then fails with a path-bearing message
    const viaDisk = await q(s.drives.importImage(NAME, A(), 0));
    // importMedia on the same store, fresh, so the two are the same failure by the same code path
    const media2 = new ListFails(), s2 = await session(media2);
    media2.unmeasure(false);
    const viaMedia = await q(s2.library.importMedia(NAME, A()));
    check('the creation reports a store failure exactly as importMedia does (one rule for the name)',
      !viaDisk.ok && !viaMedia.ok && viaDisk.m === viaMedia.m, `${viaDisk.m} | ${viaMedia.m}`);
    // the store leads its message with the stored path; because that is this same file, its copy is dropped and
    // the disk is named once (the store's reason follows) -- see MediaLibrary.mediaError's `stored`
    check('... and that failure names the disk once, not twice',
      !viaDisk.ok && viaDisk.m === `${NAME}: permission was refused`, viaDisk.m);
  }

  // The gate's count form (tests/suite-verdict.js): numerator and denominator equal, at least one check. The
  // all-form cannot carry this label -- its pattern stops at a slash ("all 21 checks passed" is accepted,
  // "all 21 import/creation-landing checks passed" is not) -- which the gate caught when this file first used it.
  console.log(fail ? `${fail} of ${n} import/creation-landing checks FAILED` : `${n}/${n} import/creation-landing checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
