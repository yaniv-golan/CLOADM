// The name a store failure is reported under, and the two names a caller already knows.
//
// js/session.js mediaError() puts the media's name in front of whatever the store said, and leaves the session's
// own messages alone. Two of its branches already refused to repeat a name the store had carried:
// not-found (mediaError writes its own sentence) and quota (mediaError writes its own sentence). Its last branch,
// the general one, pasted the store's message after the name -- and the two real backends (js/host/media-store-fsa.js
// and -opfs.js, wrap()) put the stored path in their message, so the user read the disk twice:
//
//   work.vdk: disks/work.vdk: permission was refused
//
// All the expected strings here are derived from what the CALLER passed and from the store error's own fields
// (code, message), never by running mediaError to see what it says. Each shape is measured by what the user would
// read, and the test says which failure shape carries which outcome.
//
// Run: node tests/store-error-names.test.js
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');
const images = require('../tools/mame-diff/fdc/images');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const q = (p) => p.then((m) => ({ ok: true, m }), (e) => ({ ok: false, m: e.message }));
// the Alpha: two drives, its own disk interface, no cartridge to plug in (a fresh one per leg, as a drive's disk
// would otherwise make the next leg meet "already in drive 0")
const session = async (media) => { const s = new Emu.Session({ media }); s.switchMachine('dgnalpha'); await s.ready(); return s; };

// An asynchronous store (so the Session's writes take its queued path, as the page's backends do) whose writes
// can be refused with any MediaStoreError. `failOn`: the stored name whose write is refused; `err`: the error.
// Every other method is the in-memory store's.
class FailingStore extends MemoryMediaStore {
  get synchronous() { return false; }
  async write(name, bytes) { if (this.failOn === name) throw this.err; return this.writeSync(name, bytes); }
  async read(name) { return this.readSync(name); }
  async stat(name) { return this.statSync(name); }
  async list(prefix = '') { return this.listSync(prefix); }
  async remove(name) { const e = this.files.get(this.key(name)); if (!e) return false; this.files.delete(this.key(name)); this.bytes -= e.bytes.length; return true; }
  async rename(from, to) {
    const e = this.files.get(this.key(from));
    if (!e) throw new MediaStoreError('not-found', `${from} is not in this store`);
    if (this.files.has(this.key(to))) throw new MediaStoreError('exists', `${to} is already in this store`);
    this.files.delete(this.key(from)); this.files.set(this.key(to), { name: to, bytes: e.bytes, mtime: e.mtime });
    return { name: to, size: e.bytes.length, mtime: e.mtime };
  }
}
// the message the two real backends give (js/host/media-store-fsa.js wrap(), js/host/media-store-opfs.js: the
// stored PATH leads, then the browser's reason)
const PATH_FIRST = (path, why) => new MediaStoreError('io', `${path}: ${why}`);
// the same failure with the path inside the reason instead (a backend that words it that way)
const PATH_INSIDE = (path, why) => new MediaStoreError('io', `the folder refused ${path}: ${why}`);
const A = () => images.vdk(40, 2), B = () => images.vdk(40, 1);

(async () => {
  // ---------------- the general branch: a store failure that embeds the stored path names the disk once ----------------
  // Each is the same creation (a new blank disk of NAME, at js/session.js newDisk) refused at its store write, so the
  // only variable is the store's wording.
  {
    const why = 'permission was refused';
    const media = new FailingStore(); media.failOn = 'disks/work.vdk'; media.err = PATH_FIRST('disks/work.vdk', why);
    const s = await session(media);
    const r = await q(s.importDisk('work.vdk', A(), 0));
    // the caller's name, then the store's reason -- the path the store led with is the same name and is dropped
    check('a reason that leads with the name is not repeated in front of it',
      !r.ok && r.m === `work.vdk: ${why}`, r.m);
  }
  {
    const why = 'The browser said no';
    const media = new FailingStore(); media.failOn = 'disks/work.vdk'; media.err = PATH_INSIDE('disks/work.vdk', why);
    const s = await session(media);
    const r = await q(s.importDisk('work.vdk', A(), 0));
    // the reason does not lead with the name, so the name goes in front with the reason intact: the path in the
    // reason is how CLOADM stores the file, which is not the name the person asked for
    check('a reason that mentions the stored path elsewhere keeps it, behind the person\'s name',
      !r.ok && r.m === `work.vdk: the folder refused disks/work.vdk: ${why}`, r.m);
  }
  {
    // a store failure that names nothing: the name must still be there (the branch's original job)
    const media = new FailingStore(); media.failOn = 'disks/work.vdk'; media.err = new MediaStoreError('io', 'the write failed');
    const s = await session(media);
    const r = await q(s.importDisk('work.vdk', A(), 0));
    check('a refusal that names nothing is reported with the name and the reason', !r.ok && r.m === 'work.vdk: the write failed', r.m);
  }
  {
    // every shape above is ONE rule: mediaError is called with a name the caller chose, and each creation path
    // reports through it. The disk creation, the library import and a new blank disk must agree.
    const why = 'permission was refused';
    const mk = async () => { const media = new FailingStore(); media.err = PATH_FIRST('disks/work.vdk', why); return session(media); };
    const s1 = await mk(); s1.media.failOn = 'disks/work.vdk';
    const s2 = await mk(); s2.media.failOn = 'disks/work.vdk';
    const s3 = await mk(); s3.media.failOn = 'disks/blank.vdk'; s3.media.err = PATH_FIRST('disks/blank.vdk', why);
    const m1 = (await q(s1.importDisk('work.vdk', A(), 0))).m;
    const m2 = (await q(s2.importMedia('work.vdk', A()))).m;
    const m3 = (await q(s3.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'blank.vdk' }))).m;
    check('importDisk, importMedia and newDisk all report the same refused write the same way',
      m1 === `work.vdk: ${why}` && m2 === m1 && m3 === `blank.vdk: ${why}`, `${m1} | ${m2} | ${m3}`);
  }
  {
    // the stored name is not the caller's name: a mount reads disks/work.vdk and reports 'work.vdk'
    const why = 'the folder went away';
    const media = new FailingStore(); media.failOn = null;
    const s = await session(media);
    const realRange = media.readRange.bind(media);
    media.readRange = async (name, ...a) => { if (name === 'disks/work.vdk') throw PATH_FIRST(name, why); return realRange(name, ...a); };
    await media.writeSync('disks/work.vdk', A());
    const r = await q(s.mountDisk(0, 'work.vdk'));
    check('a refused read is reported under the store\'s reason once (it led with the same name)',
      !r.ok && r.m === `work.vdk: ${why}`, r.m);
  }

  // ---------------- the branches that already wrote their own sentence keep it ----------------
  {
    const s = await session(new MemoryMediaStore());
    check('not-found: the session\'s own sentence, the name once',
      s.mediaError(new MediaStoreError('not-found', 'disks/work.vdk is not in this store'), 'work.vdk').message
        === 'work.vdk is no longer stored in this browser; load it again.');
    // the page's backends word quota with the path in it ("No space left for disks/UTILS.DSK"), the in-memory one
    // without; either way the session says the disk once, and says what to do
    for (const msg of ['No space left for disks/UTILS.DSK', 'No space left in this store (1024 bytes)', 'No space left for UTILS.DSK']) {
      const got = s.mediaError(new MediaStoreError('quota', msg), 'UTILS.DSK').message;
      check(`quota ("${msg}"): the disk is named once and nothing else`, got === "No space left in this browser's storage for UTILS.DSK. Delete something, or save your media as files.", got);
    }
    // a session message is handed on untouched, whatever name the caller passed
    const own = new Emu.SessionError('There is already a disk named work.vdk in your library: choose another name.');
    check('a SessionError passes through unchanged', s.mediaError(own, 'work.vdk') === own);
    // a name given with its prefix is the name the user typed; it is named once like any other
    check('a caller\'s prefixed name is reported once',
      s.mediaError(PATH_FIRST('disks/UTILS.DSK', 'permission was refused'), 'disks/UTILS.DSK').message === 'disks/UTILS.DSK: permission was refused');
    // the library's own one-file actions pass the STORED name, and a backend may lead with the bare one: name.endsWith
    // is the half of the rule that keeps that from being said twice
    check('a stored name against a reason led by the bare name is reported once',
      s.mediaError(PATH_FIRST('UTILS.DSK', 'permission was refused'), 'disks/UTILS.DSK').message === 'disks/UTILS.DSK: permission was refused');
  }

  // ---------------- a disk name must have something after the prefix ----------------
  // The empty base is reachable from all three doors: the library's import (detectMedia reads a disk by its bytes,
  // so 'disks/' is a disk), a new blank disk's name, and a mount of a stored name. None may create or mount it:
  // the store would hold a blob literally named 'disks/', listed with no file name, and the messages read " in
  // drive 0".
  {
    const media = new MemoryMediaStore({ caseInsensitive: true });   // a folder on APFS/NTFS: 'disks/' is its own name
    const s = await session(media);
    for (const given of ['disks/', 'disks\\', 'disks//']) {
      const r = await q(s.importDisk(given, A(), 0));
      check(`importDisk ${JSON.stringify(given)}: refused as a name with nothing after the prefix`,
        !r.ok && r.m === 'A disk image needs a name.', r.m);
    }
    const im = await q(s.importMedia('disks/', A()));
    check('importMedia "disks/": refused the same way', !im.ok && im.m === 'A disk image needs a name.', im.m);
    const nd = await q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'disks/' }));
    check('newDisk {name: "disks/"}: refused the same way', !nd.ok && nd.m === 'A disk image needs a name.', nd.m);
    const mt = await q(s.mountDisk(0, 'disks/'));
    check('mountDisk "disks/": refused the same way', !mt.ok && mt.m === 'A disk image needs a name.', mt.m);
    check('nothing was written: the store holds no bare prefix', (await media.list()).length === 0, JSON.stringify((await media.list()).map((e) => e.name)));
    // the names that DO have a base are unaffected, at every door
    const s2 = await session(new MemoryMediaStore());
    const okImport = await q(s2.importDisk('a.vdk', A(), 0));
    const okNew = await q(s2.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'b.vdk' }));
    const okMount = await q(s2.mountDisk(1, 'b.vdk'));
    check('a name with a base still works at all three doors',
      okImport.ok && okNew.ok && okMount.ok && okImport.m === 'a.vdk in drive 0' && okNew.m === 'New blank disk: b.vdk in drive 1' && okMount.m === 'b.vdk in drive 1',
      `${okImport.m} | ${okNew.m} | ${okMount.m}`);
    // and no name asked is still a name chosen (the empty label is not the empty name)
    const s3 = await session(new MemoryMediaStore());
    const auto = await q(s3.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }));
    check('no name asked: still chooses one', auto.ok && /^New blank disk: disk-\d+\.vdk in drive 0$/.test(auto.m), auto.m);
  }
  // a dot-only base ('disks/.') is a name the store may hold, and it is not the prefix: it keeps working
  {
    const media = new MemoryMediaStore();
    const s = await session(media);
    const r = await q(s.importDisk('disks/.', B(), 0));
    check('... but a base that is only dots is a name, not the prefix', r.ok && r.m === '. in drive 0', r.m);
  }

  console.log(fail ? `${fail} of ${n} store-error-naming checks FAILED` : `${n}/${n} store-error-naming checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
