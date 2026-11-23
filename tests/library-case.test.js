// Disk names on a store that does not tell upper from lower case (File System Access on APFS or NTFS, and
// measured, not assumed: js/host/media-store.js CASE). GAME.DSK and game.dsk are ONE file there, so every
// Library and drive guard must treat them as one name, and a case-sensitive store (OPFS on ext4, and the
// in-memory default) must keep today's behaviour exactly.
//
// Each scenario runs against BOTH stores from the same code, so the case-sensitive run pins today's behaviour
// and the case-insensitive run pins the fix. The images are synthetic VDK blanks (js/media/disk.js), so no ROM
// is needed for the guards: a mount only needs a stored disk ROM, and a 0x39 stub stands in for it.
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const refuses = async (p, re) => { try { await p; return { refused: false, message: 'did not reject' }; } catch (e) { return { refused: e instanceof Emu.SessionError && re.test(e.message), message: e.message, error: e }; } };

// a session on the CoCo with a stub disk ROM in place, so a mount can plug the rsdos cartridge in
async function session({ caseInsensitive }) {
  const media = new MemoryMediaStore({ caseInsensitive });
  const s = new Emu.Session({ media });
  s.switchMachine('coco');
  s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
  await s.ready();
  return { s, media };
}
// A blank 40-track single-sided VDK image, built here from the format's own layout (js/media/disk.js documents
// it: 'd','k', a little-endian header size, then the geometry at bytes 8 and 9, and 18 x 256-byte sectors per
// track), not by calling the code under test. These tests only need an image the format check accepts: no sector
// is ever read.
const vdk = () => {
  const header = 12, tracks = 40, heads = 1;
  const bytes = new Uint8Array(header + tracks * heads * 18 * 256);
  bytes[0] = 0x64; bytes[1] = 0x6B; bytes[2] = header & 0xFF; bytes[3] = header >> 8;
  bytes[8] = tracks; bytes[9] = heads;
  return bytes;
};
const names = async (s) => (await s.library.listMedia()).map((x) => x.name).join();

// Every scenario is written so a failure is a FAIL line, not a thrown suite: the setup steps that a mutation can
// break are themselves checked, and a throw is caught per block and reported as one.
const block = async (name, fn) => {
  try { await fn(); } catch (e) { fail++; console.log(`FAIL ${name}: threw ${e && e.message}`); }
};
(async () => {
  // Who says what: the store declares or is measured, the Session follows it
  {
    const ci = new Emu.Session({ media: new MemoryMediaStore({ caseInsensitive: true }) });
    const cs = new Emu.Session({ media: new MemoryMediaStore() });
    check('case: the Session follows a store that declares its rule (both ways)', ci.library.caseInsensitive === true && cs.library.caseInsensitive === false);
    await ci.ready(); await cs.ready();
    check('case: ready() leaves the declared answer alone', ci.library.caseInsensitive === true && cs.library.caseInsensitive === false);
    // a store whose answer is nobody's yet (the browser backends before ready() has measured them)
    const raw = new (class { constructor() { this.synchronous = false; } })(() => {});
    const s = new Emu.Session({ media: Object.assign(raw, { synchronous: false }) });
    check('case: a store with no answer yet starts at the safe one (case-insensitive)', s.library.caseInsensitive === true);
  }

  // ---- 1. the same disk name in another case on drive 2 is refused, naming drive 1 ----
  await block('1 the same disk name in another case on drive 2 is refused, naming drive 1', async () => {
    const { s } = await session({ caseInsensitive: true });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    const r = await refuses(s.drives.mount(1, 'game.dsk'), /GAME\.DSK is already in drive 0/);
    check('case-insensitive: GAME.DSK in drive 0 refuses game.dsk in drive 1, naming the drive and the stored spelling', r.refused, r.message);
    check('case-insensitive: and nothing was mounted in drive 1', s.drives.status().drives.length === 1 && s.drives.status().drives[0].file === 'GAME.DSK');
    // the exact match still behaves as before
    const exact = await refuses(s.drives.mount(1, 'GAME.DSK'), /GAME\.DSK is already in drive 0/);
    check('case-insensitive: the exact name is refused as before', exact.refused, exact.message);
  });
  {
    const { s } = await session({ caseInsensitive: false });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    // the store really has both names, so the only question is whether the GUARD lets the pair into two drives
    await s.library.importMedia('game.dsk', vdk());
    const msg = await s.drives.mount(1, 'game.dsk').then((m) => m, (e) => `ERR ${e.message}`);
    check('case-sensitive: game.dsk is another disk and mounts in drive 1 (today\'s behaviour kept)', /game\.dsk in drive 1$/.test(msg), msg);
    check('case-sensitive: two drives hold the two names', s.drives.status().drives.map((d) => d.file).join() === 'GAME.DSK,game.dsk');
  }

  // ---- 2. import over a mounted disk in another case is refused ----
  await block('2 import over a mounted disk in another case is refused', async () => {
    const { s, media } = await session({ caseInsensitive: true });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    const before = (await media.read('disks/GAME.DSK')).slice();
    const r = await refuses(s.library.importMedia('game.dsk', vdk()), /is in drive 0; eject it before you replace it/);
    check('case-insensitive: importing over a disk mounted in another case is refused', r.refused, r.message);
    check('case-insensitive: and the mounted image is untouched', (await media.read('disks/GAME.DSK')).every((v, i) => v === before[i]));
    const i2 = await refuses(s.drives.importImage('game.dsk', vdk(), 1), /is in drive 0; eject it there first/);
    check('case-insensitive: importDisk into another drive is refused the same way', i2.refused, i2.message);
  });
  {
    const { s, media } = await session({ caseInsensitive: false });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    const before = (await media.read('disks/GAME.DSK')).slice();
    const msg = await s.drives.importImage('game.dsk', vdk(), 1).then((m) => m, (e) => `ERR ${e.message}`);
    check('case-sensitive: importing game.dsk over GAME.DSK in a drive is allowed, as two files', /game\.dsk in drive 1$/.test(msg), msg);
    check('case-sensitive: the disk in drive 0 is untouched by the import of the other name', (await media.read('disks/GAME.DSK')).every((v, i) => v === before[i]));
  }

  // ---- 3. rename and delete of a mounted disk in another case are refused ----
  await block('3 rename and delete of a mounted disk in another case are refused', async () => {
    const { s } = await session({ caseInsensitive: true });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    const ren = await refuses(s.library.renameMedia('disks/game.dsk', 'OTHER.DSK'), /is in drive 0; eject it before you rename it/);
    const del = await refuses(s.library.deleteMedia('disks/game.dsk'), /is in drive 0; eject it before you delete it/);
    check('case-insensitive: a mounted disk cannot be renamed or deleted under its other-case name', ren.refused && del.refused, `${ren.message} | ${del.message}`);
    check('case-insensitive: the refusal names the stored spelling when the caller used another', /game\.dsk \(stored as GAME\.DSK\) is in drive 0/.test(ren.message), ren.message);
    check('case-insensitive: the disk is still there and still in the drive', (await names(s)) === 'disks/GAME.DSK' && s.drives.status().drives[0].file === 'GAME.DSK');
    // checkNotInDrive is what the Library panel calls before it even opens the rename field, and it is synchronous
    let syncThrown = null; try { s.drives.checkNotInDrive('disks/game.dsk', 'rename'); } catch (e) { syncThrown = e; }
    check('case-insensitive: the Library\'s synchronous checkNotInDrive refuses the other case too', syncThrown instanceof Emu.SessionError, syncThrown && syncThrown.message);
    let syncOk = true; try { s.drives.checkNotInDrive('disks/OTHER.DSK', 'rename'); } catch (e) { syncOk = false; }
    check('case-insensitive: checkNotInDrive still lets an unrelated name through', syncOk);
  });
  {
    const { s } = await session({ caseInsensitive: false });
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    await s.library.importMedia('game.dsk', vdk());
    const ren = await s.library.renameMedia('disks/game.dsk', 'OTHER.DSK').then(() => null, (e) => e);
    check('case-sensitive: what the drive holds is not what the other case names, so the guard does not refuse the rename',
      ren === null || !/is in drive/.test(ren.message), ren && ren.message);
    let syncOk = true; try { s.drives.checkNotInDrive('disks/game.dsk', 'rename'); } catch (e) { syncOk = false; }
    check('case-sensitive: checkNotInDrive lets the other case through (it is another file here)', syncOk);
  }

  // ---- 3b. re-importing into the drive that already holds the disk, under its other spelling ----
  await block('3b re-importing the same disk file into the drive holding it', async () => {
    // importDisk lets you replace the disk IN a drive by importing a new file over it. On a folding store the
    // drive holds GAME.DSK while the import is named game.dsk: the same file. The eject that clears the drive
    // before the write has to see that, or the drive keeps its old image while the store gets the new bytes.
    const { s, media } = await session({ caseInsensitive: true });
    const first = vdk(); first[12] = 0x11;           // a recognisable image in the drive
    const second = vdk(); second[12] = 0x22;          // the file being imported over it
    await s.drives.importImage('GAME.DSK', first, 0);
    check('3b: drive 0 holds GAME.DSK', s.drives.status().drives.length === 1 && s.drives.status().drives[0].file === 'GAME.DSK');
    const msg = await s.drives.importImage('game.dsk', second, 0).then((m) => m, (e) => `ERR ${e.message}`);
    check('3b: re-importing under the other spelling is accepted, not refused by the holder check', !/^ERR /.test(msg), msg);
    const stored = await media.read('disks/GAME.DSK');
    check('3b: the store now holds the NEW bytes under the name the disk already had',
      stored[12] === 0x22, `byte 12 = ${stored[12]}`);
    check('3b: and drive 0 still holds that one disk',
      s.drives.status().drives.length === 1 && s.drives.status().drives[0].drive === 0);
  });

  // ---- 4. newDisk: a name already there in another case is refused, and the auto-name skips it ----
  await block('4 newDisk: a name already there in another case is refused, and the auto-name skips it', async () => {
    const { s } = await session({ caseInsensitive: true });
    await s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'disk-1.vdk' });
    const r = await refuses(s.drives.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'DISK-1.VDK' }), /There is already a disk named disk-1\.vdk/);
    check('case-insensitive: newDisk refuses a name that is another case of a stored disk, naming the stored spelling', r.refused, r.message);
    const auto = await s.drives.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }).then((m) => m, (e) => `ERR ${e.message}`);
    check('case-insensitive: the auto-named new disk is disk-2, not another disk-1', /disk-2\.vdk in drive 1/.test(auto) && (await names(s)) === 'disks/disk-1.vdk,disks/disk-2.vdk', `${auto} | ${await names(s)}`);
  });
  {
    const { s } = await session({ caseInsensitive: false });
    await s.drives.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'disk-1.vdk' });
    const ok = await s.drives.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'DISK-1.VDK' }).then((m) => m, (e) => `ERR ${e.message}`);
    check('case-sensitive: DISK-1.VDK is a different name and is accepted', /DISK-1\.VDK in drive 1/.test(ok), ok);
  }

  // ---- 5. a case-only rename is refused on a store that cannot do it ----
  await block('5 a case-only rename is refused on a store that cannot do it', async () => {
    const { s } = await session({ caseInsensitive: true });
    await s.library.importMedia('GAME.DSK', vdk());
    const r = await refuses(s.library.renameMedia('disks/GAME.DSK', 'game.dsk'), /does not tell upper from lower case/);
    check('case-insensitive: renaming GAME.DSK to game.dsk is refused (it would replace the file, then delete it)', r.refused, r.message);
    check('case-insensitive: the disk is still there under its name', (await names(s)) === 'disks/GAME.DSK');
  });
  {
    const { s } = await session({ caseInsensitive: false });
    await s.library.importMedia('GAME.DSK', vdk());
    const r = await s.library.renameMedia('disks/GAME.DSK', 'game.dsk').then((x) => x, (e) => `ERR ${e.message}`);
    check('case-sensitive: the case-only rename is allowed, as before', r && r.name === 'disks/game.dsk', JSON.stringify(r));
  }

  // ---- 6. an empty store starts at the safe answer and is measured once it has a name ----
  await block('6 an empty store starts at the safe answer and is measured once it has a name', async () => {
    // the same store shape the browser's asynchronous backends have (no declared rule, so it is measured)
    class Raw {
      constructor({ fold, synchronous = false } = {}) { this.fold = fold; this.synchronous = synchronous; this.m = new Map(); }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { const old = this.m.get(this.k(n)); this.m.set(this.k(n), { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: Date.now() }; }
      async stat(n) { this.stats = (this.stats || []).concat(n); const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list(p = '') { return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => this.fold ? f.name.toLowerCase().startsWith(p.toLowerCase()) : f.name.startsWith(p)); }
      async read(n) { const e = this.m.get(this.k(n)); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`);
        return e.b.slice(); }
      async remove(n) { return this.m.delete(this.k(n)); }
    }
    // (no ROM stub: that would write roms/sockets.json, and the store would no longer be empty)
    const media = new Raw({ fold: false });
    const s = new Emu.Session({ media });
    s.switchMachine('coco');
    await s.ready();
    // ready() measures the empty store: nothing to ask about, so the safe answer, and no measurement recorded
    check('empty store: with nothing to ask about, ready() leaves the safe answer (case-insensitive)', s.library.caseInsensitive === true && !media.caseMeasured, String(media.caseInsensitive));
    // before a name exists the conservative rule applies: a name that is only another case is the same disk
    await s.library.importMedia('GAME.DSK', vdk());
    check('empty store, after its first name: re-measured, and this store is case-SENSITIVE', s.library.caseInsensitive === false);
    // The question must be put with the name the import just wrote: stat that name with its case flipped. (A
    // measurement taken before the write had no name to ask about, and the store would stay at the safe answer.)
    check('the measurement asked the store about the name the import just wrote, case-flipped',
      media.stats.includes('DISKS/game.dsk'), (media.stats || []).join(' '));
    await s.library.importMedia('game.DSK', vdk());
    check('so the two names are two files, as the store showed', (await names(s)) === 'disks/GAME.DSK,disks/game.DSK');
    // and the same store shape that folds its names is measured case-insensitive and refuses the second
    const fold = new Raw({ fold: true });
    const t = new Emu.Session({ media: fold });
    t.switchMachine('coco');
    await t.ready();
    check('empty folding store: ready() leaves the safe answer too', t.library.caseInsensitive === true && !fold.caseMeasured);
    await t.library.importMedia('GAME.DSK', vdk());
    check('empty folding store, after its first name: still case-insensitive (measured)', t.library.caseInsensitive === true);
    await t.library.importMedia('game.DSK', vdk());
    check('so the second import replaced the first: one file, spelling of the first', (await names(t)) === 'disks/GAME.DSK');
    check('the folding store was measured from its first name and keeps that answer', fold.caseMeasured === true && fold.caseInsensitive === true);
  });

  // ---- 7. an importDisk onto an empty asynchronous store measures after its own write ----
  await block('7 an importDisk onto an empty asynchronous store measures after its own write', async () => {
    // the same Raw store as above, with a disk ROM stub: this is the path a drive takes, not the Library's
    const Raw = class {
      constructor({ fold }) { this.fold = fold; this.m = new Map(); this.synchronous = false; this.stats = []; }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { const old = this.m.get(this.k(n)); this.m.set(this.k(n), { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: Date.now() }; }
      async stat(n) { this.stats.push(n); const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list(p = '') { return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => f.name.startsWith(p)); }
      async read(n) { const e = this.m.get(this.k(n)); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); }
      async readRange(n, off, len) { return (await this.read(n)).slice(off, off + len); }
      async writeRange() { throw new Error('not used by these guards'); }
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); }
      async clear(p = '') { let n = 0; for (const e of [...this.m.values()]) if (e.name.startsWith(p)) { this.m.delete(this.k(e.name)); n++; } return n; }
      async remove(n) { return this.m.delete(this.k(n)); }
    };
    for (const fold of [true, false]) {
      const media = new Raw({ fold });
      const s = new Emu.Session({ media });
      await s.ready();                      // an empty store: nothing to ask about, so the safe answer
      s.switchMachine('coco');
      s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
      await s.drives.importImage('GAME.DSK', vdk(), 0);
      // the question is stat(game.dsk) of GAME.DSK, case-flipped: that is exactly the name the write put in
      check(`importDisk onto an empty ${fold ? 'folding' : 'plain'} store: measured from the name it wrote`,
        media.caseMeasured === true && s.library.caseInsensitive === fold && media.stats.includes('DISKS/game.dsk'), media.stats.join(' '));
      // and the guard now stops the other case from reaching a second drive
      const again = await s.drives.mount(1, 'game.dsk').then(() => null, (e) => e.message);
      check(`importDisk onto an empty ${fold ? 'folding' : 'plain'} store: the guard agrees with the store's answer`,
        fold ? /is already in drive 0/.test(again || '') : again !== null && !/is already in drive/.test(again), String(again));
    }
  });

  // ---- 7b. a store measured behind the Session's back: the Session takes the store's answer ----
  await block("7b a store measured behind the Session's back: the Session takes the store's answer", async () => {
    // The real backends measure themselves: every list() asks the store for its rule (js/host/media-store-fsa.js
    // _case). So a Library refresh or an index load can settle a store the Session has only guessed at. On an
    // empty folder the Session's guess is the safe answer (case-insensitive); if it kept that guess, a
    // case-sensitive folder would refuse a disk that is genuinely a different file.
    const Raw = class {
      constructor({ fold }) { this.fold = fold; this.m = new Map(); this.synchronous = false; }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { const old = this.m.get(this.k(n)); this.m.set(this.k(n), { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: Date.now() }; }
      async stat(n) { const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list(p = '') {
        // what a real backend does inside list(): measure its own rule, read-only, from a name and a stat
        if (!this.caseMeasured) {
          const names = [...this.m.values()].map((e) => e.name).filter((n) => /[A-Za-z]/.test(n)).sort((x, y) => x.length - y.length || (x < y ? -1 : 1));
          this.caseInsensitive = names.length ? !!this.m.get(this.k(flipCaseOf(names[0]))) : true;
          if (names.length) this.caseMeasured = true;
        }
        return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => this.k(f.name).startsWith(this.k(p)));
      }
      async read(n) { const e = this.m.get(this.k(n)); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); }
      async readRange(n, off, len) { return (await this.read(n)).slice(off, off + len); }
      async writeRange() { throw new Error('not used here'); }
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); }
      async clear(p = '') { let n = 0; for (const e of [...this.m.values()]) if (e.name.startsWith(p)) { this.m.delete(this.k(e.name)); n++; } return n; }
      async remove(n) { return this.m.delete(this.k(n)); }
    };
    // the flip the store's own measurement uses (the same rule the store module documents)
    const flipCaseOf = (n) => n.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    for (const fold of [true, false]) {
      const media = new Raw({ fold });
      const s = new Emu.Session({ media });
      await s.ready();
      check(`measured behind the Session's back (${fold ? 'folding' : 'plain'} store): the guess starts at the safe answer`,
        s.library.caseInsensitive === true && !media.caseMeasured);
      // an empty listing settles nothing (there is no name to ask with): the store stays unmeasured
      await s.library.listMedia();
      check(`measured behind the Session's back (${fold ? 'folding' : 'plain'} store): an empty listing leaves the guess`,
        s.library.caseInsensitive === true && !media.caseMeasured);
      // a write gives the store a name; the guards must follow the answer the STORE settles on
      await s.library.importMedia('GAME.DSK', vdk());
      check(`measured behind the Session's back (${fold ? 'folding' : 'plain'} store): after a write the Session follows the store`,
        s.library.caseInsensitive === fold && media.caseInsensitive === fold, `session=${s.library.caseInsensitive} store=${media.caseInsensitive}`);
      await s.library.importMedia('game.DSK', vdk());
      const names = (await s.library.listMedia()).map((x) => x.name).join();
      check(`measured behind the Session's back (${fold ? 'folding' : 'plain'} store): the two spellings are one file or two, as the store said`,
        fold ? names === 'disks/GAME.DSK' : names === 'disks/GAME.DSK,disks/game.DSK', names);
    }
  });

  // ---- 7c. a store measured by its own listing while the Session still holds its guess ----
  await block('7c a store measured by its own listing while the Session still holds its guess', async () => {
    // The real divergence (found in review): a write that does not go through the Library (a DriveWire image) gives
    // the store a name without the Session re-measuring; the next Library listing then settles the store's own
    // answer, and the two disagree. ready()'s guess is the safe answer (case-insensitive), so on a case-SENSITIVE
    // folder a genuinely different game.dsk would be refused as if it were the one in the drive.
    const Raw = class {
      constructor({ fold }) { this.fold = fold; this.m = new Map(); this.synchronous = false; }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { const old = this.m.get(this.k(n)); this.m.set(this.k(n), { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: Date.now() }; }
      async stat(n) { const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list(p = '') {
        if (!this.caseMeasured) {
          const names = [...this.m.values()].map((e) => e.name).filter((n) => /[A-Za-z]/.test(n)).sort((x, y) => x.length - y.length || (x < y ? -1 : 1));
          this.caseInsensitive = names.length ? !!this.m.get(this.k(names[0].replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())))) : true;
          if (names.length) this.caseMeasured = true;
        }
        return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => this.k(f.name).startsWith(this.k(p)));
      }
      async read(n) { const e = this.m.get(this.k(n)); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); }
      async readRange(n, o, l) { return (await this.read(n)).slice(o, o + l); }
      async writeRange() { throw new Error('not used here'); }
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); }
      async clear(p = '') { let n = 0; for (const e of [...this.m.values()]) if (e.name.startsWith(p)) { this.m.delete(this.k(e.name)); n++; } return n; }
      async remove(n) { return this.m.delete(this.k(n)); }
    };
    const media = new Raw({ fold: false });
    const s = new Emu.Session({ media });
    await s.ready();
    check('a write off the Library path: the Session still holds ready()\'s safe guess', s.library.caseInsensitive === true && !media.caseMeasured);
    await s.importDriveWireImage('PIC.DSK', new Uint8Array(256));   // a name, no Library refresh
    await s.library.listMedia();                                            // the Library refresh: the store measures itself
    check('a Library listing then settles the store: the Session takes that answer, it does not keep its guess',
      media.caseInsensitive === false && s.library.caseInsensitive === false, `session=${s.library.caseInsensitive} store=${media.caseInsensitive}`);
    s.switchMachine('coco');
    s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
    await s.drives.importImage('GAME.DSK', vdk(), 0);
    const second = await s.drives.importImage('game.DSK', vdk(), 1).then((m) => m, (e) => `ERR ${e.message}`);
    check('a case-sensitive folder: a genuinely different game.dsk is not refused as though the drive held it',
      /game\.DSK in drive 1$/.test(second), second);
  });

  // ---- 7d. any route that makes a real backend measure itself reaches the guards ----
  await block('7d any route that makes a real backend measure itself reaches the guards', async () => {
    // A real backend measures its own rule inside list(). driveWireImages() lists the DriveWire prefix and nothing
    // else, so on a case-SENSITIVE folder this is a settled store the Session never measured itself. The answer the
    // guards read must be the store's, not ready()'s guess.
    const Raw = class {
      constructor({ fold }) { this.fold = fold; this.m = new Map(); this.synchronous = false; }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { const old = this.m.get(this.k(n)); this.m.set(this.k(n), { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: Date.now() }; }
      async stat(n) { const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list(p = '') {
        if (!this.caseMeasured) {
          const names = [...this.m.values()].map((e) => e.name).filter((n) => /[A-Za-z]/.test(n)).sort((x, y) => x.length - y.length || (x < y ? -1 : 1));
          this.caseInsensitive = names.length ? !!this.m.get(this.k(names[0].replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())))) : true;
          if (names.length) this.caseMeasured = true;
        }
        return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => this.k(f.name).startsWith(this.k(p)));
      }
      async read(n) { const e = this.m.get(this.k(n)); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); }
      async readRange(n, o, l) { return (await this.read(n)).slice(o, o + l); }
      async writeRange() { throw new Error('not used here'); }
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); }
      async clear(p = '') { let n = 0; for (const e of [...this.m.values()]) if (e.name.startsWith(p)) { this.m.delete(this.k(e.name)); n++; } return n; }
      async remove(n) { return this.m.delete(this.k(n)); }
    };
    const media = new Raw({ fold: false });
    const s = new Emu.Session({ media });
    await s.ready();
    await s.importDriveWireImage('PIC.DSK', new Uint8Array(256));   // a name, off the Library path
    await s.driveWireImages();                                      // a listing of the DriveWire prefix only
    check('a DriveWire listing settles the store: the answer the guards read is the store\'s',
      media.caseMeasured === true && media.caseInsensitive === false && s.library.caseInsensitive === false,
      `session=${s.library.caseInsensitive} store=${media.caseInsensitive}`);
  });

  // ---- 7e. a case-SENSITIVE store holding a DIFFERENT file at the flipped path ----
  {
    // Round 2's blocker: asking "is there an entry at the flipped path" is not the question. A case-sensitive
    // folder can hold a genuinely different file whose name is the flip of a name about to be written (the user's
    // own DISKS/GAME.dsk), and a probe of existence then calls the two one file. Both the listing measurement and
    // the after-a-write one must compare the name the store REPORTS, not whether something is there.
    const exact = new Map();   // a store that tells names apart: the key is the name
    const store = {
      synchronous: false,
      async write(n, b) { const old = exact.get(n); exact.set(n, { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: 1 }; },
      async stat(n) { const e = exact.get(n); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; },
      async list(p = '') { return [...exact.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => f.name.startsWith(p)); },
      async read(n) { const e = exact.get(n); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); },
      async readRange(n, o, l) { return (await this.read(n)).slice(o, o + l); },
      async writeRange() { throw new Error('not used here'); },
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); },
      async clear(pr = '') { let n = 0; for (const e of [...exact.values()]) if (e.name.startsWith(pr)) { exact.delete(e.name); n++; } return n; },
      async remove(n) { return exact.delete(n); },
    };
    // the person's own file, a different real path, and the SHORTEST name with a letter, so it is the one the
    // listing measurement puts the question with (a longer neighbour would hide the defect)
    // A case-sensitive folder holding TWO genuinely different files whose names are each other's flip. The
    // listing measurement puts its question with the shortest name with a letter, so that must be one of them.
    await store.write('disks/game.DSK', Uint8Array.of(1));
    await store.write('DISKS/GAME.dsk', Uint8Array.of(2));
    const s = new Emu.Session({ media: store });
    await s.ready();
    check('a different file at the flipped path: the listing measurement still says the store tells names apart',
      store.caseMeasured === true && store.caseInsensitive === false, `store=${store.caseInsensitive}`);
    await s.library.importMedia('game.DSK', Uint8Array.of(3));       // its flip is the file above
    check('a different file at the flipped path: an import does not flip the answer, and the store is not re-decided',
      store.caseInsensitive === false && s.library.caseInsensitive === false, `session=${s.library.caseInsensitive} store=${store.caseInsensitive}`);
    await s.library.importMedia('OTHER.DSK', Uint8Array.of(4));
    check('a different file at the flipped path: a later import leaves it alone too', store.caseInsensitive === false && s.library.caseInsensitive === false);
  }
  {
    // The after-a-write probe on an EMPTY-at-start store: the folder is settled by nothing yet, so the import's own
    // name is the question, and a different real file at its flip must not make it read as one entry.
    const exact = new Map();
    const store = {
      synchronous: false,
      async write(n, b) { const old = exact.get(n); exact.set(n, { name: old ? old.name : n, b }); return { name: old ? old.name : n, size: b.length, mtime: 1 }; },
      async stat(n) { const e = exact.get(n); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; },
      async list(p = '') { return [...exact.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })).filter((f) => f.name.startsWith(p)); },
      async read(n) { const e = exact.get(n); if (!e) throw new MediaStoreError('not-found', `${n} is not in this store`); return e.b.slice(); },
      async readRange(n, o, l) { return (await this.read(n)).slice(o, o + l); },
      async writeRange() { throw new Error('not used here'); },
      async rename(a, b) { const e = await this.read(a); await this.write(b, e); await this.remove(a); return this.stat(b); },
      async clear(pr = '') { let n = 0; for (const e of [...exact.values()]) if (e.name.startsWith(pr)) { exact.delete(e.name); n++; } return n; },
      async remove(n) { return exact.delete(n); },
    };
    const s = new Emu.Session({ media: store });
    await s.ready();
    check('an empty folder is unmeasured at ready()', store.caseMeasured !== true);
    await exact.set('DISKS/GAME.dsk', { name: 'DISKS/GAME.dsk', b: Uint8Array.of(1) });   // the flip of what is about to be written
    await s.library.importMedia('game.DSK', Uint8Array.of(3));
    check('a different file at the flip does not make the import read as one entry',
      store.caseMeasured === true && store.caseInsensitive === false && s.library.caseInsensitive === false,
      `session=${s.library.caseInsensitive} store=${store.caseInsensitive}`);
  }

  // ---- 8. moving the library to a store with another rule re-measures ----
  await block('8 moving the library to a store with another rule re-measures', async () => {
    const a = new MemoryMediaStore({ caseInsensitive: true });
    const s = new Emu.Session({ media: a });
    s.switchMachine('coco');
    await s.ready();
    check('move: the first store folds names', s.library.caseInsensitive === true);
    const b = new MemoryMediaStore({ caseInsensitive: false });
    await s.library.moveMedia(b);
    check('move: after moving, the Session follows the new store\'s rule', s.library.caseInsensitive === false, String(s.library.caseInsensitive));
  });

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
