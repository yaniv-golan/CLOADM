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
const read = async (media, name) => media.read(name).catch(() => null);   // null when it is not there
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

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
    const m2 = (await q(s2.library.importMedia('work.vdk', A()))).m;
    const m3 = (await q(s3.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'blank.vdk' }))).m;
    check('importDisk, importMedia and newDisk all report the same refused write the same way',
      m1 === `work.vdk: ${why}` && m2 === m1 && m3 === `blank.vdk: ${why}`, `${m1} | ${m2} | ${m3}`);
    // the same import given as a PATH (a browser may hand over a relative path, and Windows separators too): the
    // store's message leads with the STORED name, and the file must still be named once, as its own file name
    for (const given of ['dir/work.vdk', 'C:\\dir\\work.vdk']) {
      const sm = await mk(); sm.media.failOn = 'disks/work.vdk';
      const got = (await q(sm.library.importMedia(given, A()))).m;
      check(`importMedia given as ${JSON.stringify(given)} is named once, by its file name`, got === `work.vdk: ${why}`, got);
    }
    // (3) a NON-disk file given as a path is stored as library/dir/prog.bin, so a failure reports the name the
    // Library shows -- "dir/prog.bin" -- not just the leaf, which would not match anything on screen
    {
      const sm = await mk(); sm.media.failOn = 'library/dir/prog.bin'; sm.media.err = PATH_FIRST('library/dir/prog.bin', why);
      const got = (await q(sm.library.importMedia('dir/prog.bin', new Uint8Array(4)))).m;
      check('a failed library import given as a path reports the library-relative name', got === `dir/prog.bin: ${why}`, got);
    }
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
    // a rename that fails at its DESTINATION: the destination's path is where it failed, and it is kept
    const m3 = new FailingStore();
    const s3 = await session(m3);
    await m3.writeSync('disks/a.vdk', A());
    m3.rename = async (from, to) => { throw PATH_FIRST(to, why); };
    const rn = await q(s3.library.renameMedia('disks/a.vdk', 'disks/b.vdk'));   // a valid new name, refused by the store
    check('a rename refused at its destination keeps the destination path',
      !rn.ok && rn.m === `disks/a.vdk: disks/b.vdk: ${why}`, rn.m);
  }

  // ---------------- the branches that already wrote their own sentence keep it ----------------
  {
    const s = await session(new MemoryMediaStore());
    check('not-found: the session\'s own sentence, the name once',
      s.library.mediaError(new MediaStoreError('not-found', 'disks/work.vdk is not in this store'), 'work.vdk').message
        === 'work.vdk is no longer stored in this browser; load it again.');
    // the page's backends word quota with the path in it ("No space left for disks/UTILS.DSK"), the in-memory one
    // without; either way the session says the disk once, and says what to do
    for (const msg of ['No space left for disks/UTILS.DSK', 'No space left in this store (1024 bytes)', 'No space left for UTILS.DSK']) {
      const got = s.library.mediaError(new MediaStoreError('quota', msg), 'UTILS.DSK').message;
      check(`quota ("${msg}"): the disk is named once and nothing else`, got === "No space left in this browser's storage for UTILS.DSK. Delete something, or save your media as files.", got);
    }
    // a session message is handed on untouched, whatever name the caller passed
    const own = new Emu.SessionError('There is already a disk named work.vdk in your library: choose another name.');
    check('a SessionError passes through unchanged', s.library.mediaError(own, 'work.vdk') === own);
    // a name given with its prefix is the name the user typed; it is named once like any other
    check('a caller\'s prefixed name is reported once',
      s.library.mediaError(PATH_FIRST('disks/UTILS.DSK', 'permission was refused'), 'disks/UTILS.DSK', 'disks/UTILS.DSK').message === 'disks/UTILS.DSK: permission was refused');
    // a name with a space in it: the stored path leads, so it must be stripped -- a rule that only matched a
    // no-space prefix would leave the file named twice here
    check('a name with a space is named once',
      s.library.mediaError(PATH_FIRST('disks/My Disk.vdk', 'permission was refused'), 'My Disk.vdk', 'disks/My Disk.vdk').message === 'My Disk.vdk: permission was refused');
    // a DIFFERENT file's path must not be stripped: the reader has to see where it failed
    check('a reason naming a different file keeps its path (where it failed is not lost)',
      s.library.mediaError(PATH_FIRST('disks/sub/a.vdk', 'permission was refused'), 'a.vdk', 'disks/a.vdk').message === 'a.vdk: disks/sub/a.vdk: permission was refused');
    // nor may a name that merely ENDS with this one be taken for it (under a rule that matches "/"+name, xa.vdk
    // would be stripped for a.vdk and the reader would read "a.vdk: no")
    check('a reason led by a name this one is only a suffix of is kept whole',
      s.library.mediaError(PATH_FIRST('disks/xa.vdk', 'no'), 'a.vdk', 'disks/a.vdk').message === 'a.vdk: disks/xa.vdk: no');
    // (2) the page's background-write listener (js/ui/main.js) reports a failed index write. It used to call
    // mediaError without the stored name, so a ROM image's path was repeated. The rule lives on the Session now
    // (indexWriteError), where the page's one-line listener takes it from and this test pins it.
    check('a background index write failure names the ROM once',
      s.library.indexWriteError('roms/1234abcd.rom', PATH_FIRST('roms/1234abcd.rom', 'permission was refused')) === 'roms/1234abcd.rom: permission was refused',
      s.library.indexWriteError('roms/1234abcd.rom', PATH_FIRST('roms/1234abcd.rom', 'permission was refused')));
    check('... and a failure whose reason names nothing is still named and explained',
      s.library.indexWriteError('roms/sockets.json', new MediaStoreError('quota', 'no space')) === "No space left in this browser's storage for roms/sockets.json. Delete something, or save your media as files.");
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
    const im = await q(s.library.importMedia('disks/', A()));
    check('importMedia "disks/": refused the same way', !im.ok && im.m === 'A disk image needs a name.', im.m);
    // a file that is NOT a disk image, dropped with a path that ends in a separator: refused as a file, not as a disk
    // (what it is comes from its bytes; on main it was stored under a name that was only a prefix)
    const prog = new Uint8Array(64).fill(7);
    const imf = await q(s.library.importMedia('programs/', prog));
    check('importMedia "programs/" of a program: refused as a file that needs a name',
      !imf.ok && imf.m === 'A file needs a name.', imf.m);
    check('... and nothing was stored under a prefix-only name',
      !(await media.list()).some((e) => e.name.endsWith('/')), JSON.stringify((await media.list()).map((e) => e.name)));
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
  // Every base that is not a file name is refused at every door: a trailing separator, whitespace only, and the
  // segment '.' or '..' (a folder store and OPFS cannot hold either; libName already refuses '..' for library names,
  // and a disk name must not reach the store with one)
  {
    const media = new MemoryMediaStore();
    const s = await session(media);
    for (const given of ['disks/a/', 'disks/a//', 'disks/a\\', ' ', 'disks/ ', 'disks/.', 'disks/..', 'x/..', 'disks/./']) {
      const r = await q(s.importDisk(given, B(), 0));
      check(`importDisk ${JSON.stringify(given)}: refused as a name`, !r.ok && r.m === 'A disk image needs a name.', r.m || 'accepted');
    }
    const nd = await q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'disks/ ' }));
    check('newDisk "disks/ ": refused as a name', !nd.ok && nd.m === 'A disk image needs a name.', nd.m || 'accepted');
    const mt = await q(s.mountDisk(0, 'disks/..'));
    check('mountDisk "disks/..": refused as a name', !mt.ok && mt.m === 'A disk image needs a name.', mt.m || 'accepted');
    const im = await q(s.library.importMedia('x/..', B()));
    check('importMedia "x/..": refused as a name', !im.ok && im.m === 'A disk image needs a name.', im.m || 'accepted');
    check('nothing was written by any of them', (await media.list()).length === 0, JSON.stringify((await media.list()).map((e) => e.name)));
    // (1) SURROUNDING SPACES ARE PART OF A FILE'S NAME. Round 2 refused them everywhere and stranded every disk a
    // main-era store already held under such a name: a mount of a stored " a.vdk" said "A disk image needs a name."
    // Only whitespace-ONLY names are not names; a name with spaces around it is one.
    {
      const m2 = new MemoryMediaStore({ caseInsensitive: false });
      await m2.writeSync('disks/ a.vdk', A());
      await m2.writeSync('disks/b.vdk ', B());
      const s2 = await session(m2);
      const mnt = await q(s2.mountDisk(0, ' a.vdk'));
      const mnt2 = await q(s2.mountDisk(1, 'disks/b.vdk '));
      check('a disk stored as " a.vdk" still mounts (names with surrounding spaces are names)',
        mnt.ok && same(await read(m2, 'disks/ a.vdk'), A()), mnt.m || 'refused');
      check('... and one stored as "b.vdk " mounts too', mnt2.ok && same(await read(m2, 'disks/b.vdk '), B()), mnt2.m || 'refused');
      const im = await q(s2.importDisk('c.vdk ', B(), 1));
      check('... and a disk may be imported under a name with a trailing space', im.ok && im.m === 'c.vdk  in drive 1', im.m || 'refused');
      const pm = await q(s2.library.importMedia(' prog.bin', new Uint8Array(4)));
      check('... and a library file under a name with a leading space', pm.ok, pm.m || 'refused');
    }
    // a leading dot is a file name, not a segment: it stays allowed
    const okDot = await q(s.importDisk('disks/.vdk', B(), 0));
    check('... but a file whose name starts with a dot is a name', okDot.ok && okDot.m === '.vdk in drive 0', okDot.m || 'refused');
  }

  // ---------------- a rename's destination is a name it MAKES ----------------
  // The rule that guards a new name must cover the rename destination too, or a rename puts a name in the store that
  // no mount can then read back: `renameMedia('disks/r.vdk', ' ')` stored `disks/ ` and
  // `renameMedia('disks/r.vdk', 'sub/x.vdk')` stored `disks/sub/x.vdk`.
  {
    for (const [to, why] of [[' ', /empty or only spaces/], ['sub/x.vdk', /folder separator/]]) {
      const media = new MemoryMediaStore();          // fresh each time: the first must not disturb the second
      await media.writeSync('disks/r.vdk', A());
      const s = await session(media);
      const r = await q(s.library.renameMedia('disks/r.vdk', to));
      // refused for a REASON, not with the generic "needs a name" (which would misdescribe 'sub/x.vdk')
      check(`a disk rename to ${JSON.stringify(to)} is refused, saying what is wrong`,
        !r.ok && why.test(r.m) && !/needs a name\.?$/.test(r.m), r.m || 'allowed');
      check(`... ${JSON.stringify(to)} left the store as it was`, (await media.list('disks/')).map((e) => e.name).join() === 'disks/r.vdk',
        JSON.stringify((await media.list('disks/')).map((e) => e.name)));
    }
    // a library (non-disk) rename is untouched: the rule is about disk image names
    const media = new MemoryMediaStore();
    await media.writeSync('library/prog.bin', new Uint8Array(4));
    const s = await session(media);
    const lib = await q(s.library.renameMedia('prog.bin', 'sub/prog2.bin'));
    check('... a library rename keeps its folders (the disk rule does not reach it)', lib.ok, lib.m || 'refused');
  }

  // ---------------- a name ALREADY in the store is still read back ----------------
  // The rule decides what CLOADM may CREATE. It must not decide what it can READ: a store from an earlier build holds
  // 'disks/ ' and 'disks/sub/x.vdk' (main let both be renamed into place), and refusing to name them would strand
  // them -- the same fault as refusing a stored " a.vdk". Each store below is seeded DIRECTLY, not through the code
  // under test.
  {
    const media = new MemoryMediaStore({ caseInsensitive: false });
    await media.writeSync('disks/ ', A());
    await media.writeSync('disks/sub/x.vdk', B());
    const s = await session(media);
    const a = await q(s.mountDisk(0, 'disks/ '));
    const b = await q(s.mountDisk(1, 'disks/sub/x.vdk'));
    check('a stored blank name ("disks/ ") still mounts (it is not a name being made)', a.ok && a.m === '  in drive 0', a.m || 'refused');
    check('a stored nested name ("disks/sub/x.vdk") still mounts, as it did on main', b.ok && b.m === 'sub/x.vdk in drive 1', b.m || 'refused');
    // (a bare name is the file's own name, as on main: 'x.vdk' names disks/x.vdk, not disks/sub/x.vdk)
    const c = await q(s.mountDisk(1, 'x.vdk'));
    check('... a bare name is the leaf, as on main (so x.vdk is not the nested file)', !c.ok && /no longer stored/.test(c.m), c.m || 'mounted something');
    // but MAKING such a name is still refused, at every door
    const mk2 = await q(s.importDisk('disks/sub/y.vdk', A(), 0));
    check('... while MAKING a nested name is still refused', !mk2.ok, mk2.m || 'accepted');
  }

  console.log(fail ? `${fail} of ${n} store-error-naming checks FAILED` : `${n}/${n} store-error-naming checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
