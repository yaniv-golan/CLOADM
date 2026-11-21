// Floppy disks through the Session, part 4 of 4: a new blank disk (Session.newDisk) formatted by our firmware,
// and a new disk against an import of its name (newDisk vs importDisk / importMedia) and the creation lock. Split
// from tests/disks.test.js to keep each suite well under tests/all.js's per-suite cap; fixtures in disks-common.js.
const { Emu, images, MemoryMediaStore, MediaStoreError, FDC, same, spyStore, session, runToHalt, path, assembleFile, romImage, checker } = require('./disks-common');
const { check, rejects, failures } = checker();

(async () => {
  // ---------------- a new blank disk (Session.newDisk), formatted by our firmware (<board>-format-<T>x<H>.asm,
  // the one compared with MAME): every write reaches the stored image. The expected image is built here from the
  // format (header, then each track and side's sectors in order, each 256 bytes of formatFill(track, side))
  {
    const { formatFill } = require(path.join(FDC, 'gen-diag'));
    const expected = (header, tracks, heads) => {
      const out = new Uint8Array(header.length + tracks * heads * 18 * 256);
      out.set(header);
      for (let t = 0; t < tracks; t++) for (let h = 0; h < heads; h++) out.fill(formatFill(t, h), header.length + (t * heads + h) * 4608, header.length + (t * heads + h + 1) * 4608);
      return out;
    };
    for (const [machine, dos, board, format, tracks, heads, header, file] of [
      ['dragon64', 'dragondos', 'dragon', 'vdk', 40, 1, [0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, 40, 1, 0, 0], 'disk-1.vdk'],
      ['coco', 'rsdos', 'coco', 'jvc', 35, 1, [], 'disk-1.dsk']]) {
      const { s, media } = session(machine, null, board);
      const fw = assembleFile(path.join(FDC, `${board}-format-${tracks}x${heads}.asm`), '6809');
      s.roms.put(dos, 'rom', romImage(fw, 0xC000, 0x2000, 0x00), 'format.rom');
      const offered = s.blankDiskChoices().find((c) => c.format === format && c.tracks === tracks && c.heads === heads);
      check(`${machine}: the new-disk sizes offer ${format.toUpperCase()} ${tracks} x ${heads}`, !!offered, JSON.stringify(s.blankDiskChoices()));
      const msg = await s.newDisk(0, { format, tracks, heads });
      check(`${machine}: newDisk stores ${file} (the first free name), plugs the disk cartridge in and mounts it`, msg === `New blank disk: ${file} in drive 0` && s.diskStatus().drives[0].file === file
        && same(await media.read(`disks/${file}`), Emu.blankDisk(format, tracks, heads)), msg);
      check(`${machine}: the format firmware reaches HALT`, runToHalt(s, fw.symbols.get('HALT'), 3000));
      s.flushDisks();
      await s.diskWritesDone();
      check(`${machine}: the stored image is the formatted disk, every track and side`, same(await media.read(`disks/${file}`), expected(header, tracks, heads)));
      const again = await s.newDisk(1, { format, tracks, heads });
      check(`${machine}: a second new disk takes the next free name`, /disk-2\./.test(again), again);
    }
    // what can't be made
    const { s } = session('dragon64', 'dragondos', 'dragon');
    await s.newDisk(0, { format: 'dmk', tracks: 40, heads: 2 }, { name: 'raw.dmk' });
    check('a DMK blank: stored and mounted, unformatted (no sector anywhere)', s.diskStatus().drives[0].file === 'raw.dmk'
      && [0, 39].every((t) => Emu.readTrackSectors(s.diskController.drives[0].image, t, 0).length === 0));
    await rejects('newDisk: a name already in the library is refused (a new disk never replaces one)', s.newDisk(1, { format: 'dmk', tracks: 40, heads: 2 }, { name: 'raw.dmk' }), /already a disk named raw\.dmk/);
    await rejects('newDisk: a name whose extension is another format is refused', s.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'x.dmk' }), /VDK image needs a name ending \.vdk/);
    await rejects('newDisk: an unknown format is refused', s.newDisk(1, { format: 'adf', tracks: 40, heads: 1 }), /VDK, JVC or DMK/);
    await rejects('newDisk: more tracks than the drive has are refused', s.newDisk(1, { format: 'vdk', tracks: 83, heads: 1 }), /1 to 82 tracks, not 83/);
    await rejects('newDisk: three sides are refused', s.newDisk(1, { format: 'vdk', tracks: 40, heads: 3 }), /1 or 2 sides/);
    await rejects('newDisk: a single-sided DMK is refused (MAME 0.264 cannot load one)', s.newDisk(1, { format: 'dmk', tracks: 40, heads: 1 }), /double-sided/);
    await rejects('newDisk: no drive 4', s.newDisk(4, { format: 'vdk', tracks: 40, heads: 1 }), /no drive 4/);
    const c = session('coco', 'rsdos', 'coco').s;
    await rejects("newDisk: the CoCo's 40-track drives take no 80-track disk", c.newDisk(0, { format: 'jvc', tracks: 80, heads: 2 }), /1 to 42 tracks, not 80/);
    // the Dragon Alpha: its own 3.5" drives (80 tracks, two sides), two of them fitted
    const al = new Emu.Session({ media: spyStore() });
    al.switchMachine('dgnalpha');
    check('Alpha: the new-disk sizes are its 3.5" drives\' (80 x 2, 40 x 2, VDK)', al.blankDiskChoices().map((b) => `${b.format} ${b.tracks}x${b.heads} ${b.size}`).join() === 'vdk 80x2 720K,vdk 40x2 360K',
      JSON.stringify(al.blankDiskChoices()));
    const am = await al.newDisk(1, { format: 'vdk', tracks: 80, heads: 2 });
    check('Alpha: a new disk goes into its built-in drive, no cartridge', am === 'New blank disk: disk-1.vdk in drive 1' && al.shownMachine.cartPort === null && al.diskController === al.shownMachine.fdc
      && al.diskStatus().drives[0].drive === 1 && al.diskStatus().drives[0].size === 12 + 80 * 2 * 4608, am);
    await rejects('Alpha: no new disk in drive 2 (two drives fitted)', al.newDisk(2, { format: 'vdk', tracks: 80, heads: 2 }), /no drive 2/);
    const mc = new Emu.Session({ media: spyStore() });
    mc.switchMachine('mc10');
    check('the MC-10 offers no new disk', mc.blankDiskChoices().length === 0);
    await rejects('newDisk on the MC-10: no drives', mc.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }), /no disk drives/);
  }

  // ---------------- a new disk against an import of its name (Session.newDisk vs importDisk / importMedia).
  // Both check the library for the name and then write it, with awaits in between (the listing, the wait for
  // the drives' writes), so without the creation lock both can pass the check and the second write replaces the
  // first's bytes. The store's stat for the new disk's read-back is held on a deferred promise (no sleeps): the
  // import is started while the new disk waits there -- the interleaving that lost the blank's bytes before.
  {
    const held = (store) => {
      let gate = null, release = null, hold = 0, isHeld = false;
      const orig = store.stat.bind(store);
      let missing = false;
      // missing: the held read-back then finds nothing (a mount that fails for a reason other than a library move)
      store.holdReadBack = (opts = {}) => { hold = 1; missing = !!opts.missing; gate = new Promise((r) => { release = r; }); };
      store.release = () => release();
      store.stat = async (n) => { if (hold > 0) { hold--; isHeld = true; await gate; isHeld = false; if (missing) { missing = false; return null; } } return orig(n); };
      store.held = async () => { for (let i = 0; i < 500 && !isHeld; i++) await new Promise((r) => setImmediate(r)); return isHeld; };
      return store;
    };
    const alphaOn = (store) => { const s = new Emu.Session({ media: store }); s.switchMachine('dgnalpha'); return s; };
    const vdk40x2 = () => images.vdk(40, 2);
    const q = (p) => p.then((m) => ({ ok: true, m }), (e) => ({ ok: false, m: e.message }));

    // 1. newDisk first, held at its read-back; the import starts meanwhile and must be ordered behind it
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      const where = await media.held();
      const p2 = q(s.importDisk(N, vdk40x2(), 1));
      let early = false; p2.then(() => { early = true; });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      check('newDisk first: the import of its name waits (it has not settled while the read-back is held)', where && !early);
      media.release();
      const r1 = await p1, r2 = await p2;
      check('newDisk first: the new disk is stored and mounted, as alone', r1.ok && r1.m === 'New blank disk: blank.vdk in drive 0', r1.m);
      check('newDisk first: the import is refused as a second creation of the name (not a silent overwrite)', !r2.ok && /There is already a disk named blank\.vdk in your library/.test(r2.m), r2.m);
      check('newDisk first: the store still holds the blank\'s bytes, under its name', same(await media.read('disks/blank.vdk'), Emu.blankDisk('vdk', 40, 2)));
      check('newDisk first: no import ever reached the store (the blank is all that is there)', (await media.list('disks/')).map((f) => f.name).join() === 'disks/blank.vdk', JSON.stringify(await media.list('disks/')));
    }
    // 2. the other order: the import is held at its own store write, the new disk started while it is held. A
    //    new disk on the synchronous store would otherwise finish its whole check before the import was done
    //    with nothing held, so it would pass even without the serialisation; held, the import owns the turn.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const realWrite = media.write.bind(media);
      let release = null, hold = 1, atWrite = false;
      media.write = (n, b) => { if (n === 'disks/blank.vdk' && hold-- > 0) return new Promise((r) => { release = () => r(realWrite(n, b)); }); return realWrite(n, b); };
      const p2 = q(s.importDisk(N, vdk40x2(), 1));
      for (let i = 0; i < 500 && !release; i++) await new Promise((r) => setImmediate(r));
      atWrite = !!release;
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      if (release) release();
      const r2 = await p2, r1 = await p1;
      check('import first: the import was at its store write when the new disk started', atWrite);
      check('import first: the import is stored and mounted, as alone', r2.ok && r2.m === 'blank.vdk in drive 1', r2.m);
      check('import first: the new disk is refused with the library\'s "already exists"', !r1.ok && /There is already a disk named blank\.vdk in your library: choose another name\./.test(r1.m), r1.m);
      check('import first: the store holds the imported image, not a blank written over it', same(await media.read('disks/blank.vdk'), vdk40x2()));
      check('import first: no blank disk was ever mounted (drive 0 is empty)', s.diskStatus().drives.length === 1 && s.diskStatus().drives[0].drive === 1, JSON.stringify(s.diskStatus().drives));
    }
    // 3. the Library's import (importMedia) of the same name, against the new disk: ordered behind it and then
    //    refused as the disk it now is (in a drive, so not replaced) -- not written over it
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      await media.held();
      const p2 = q(s.importMedia(N, vdk40x2()));
      let early = false; p2.then(() => { early = true; });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      check('Library import: importing the same name waits for the new disk to finish', !early);
      media.release();
      const r1 = await p1, r2 = await p2;
      check('Library import: the new disk is stored and mounted', r1.ok && r1.m === 'New blank disk: blank.vdk in drive 0', r1.m);
      check('Library import: importing the same name is then refused as a second creation of it', !r2.ok && /There is already a disk named blank\.vdk in your library/.test(r2.m), r2.m);
      check('Library import: the store still holds the blank (no write of the import landed)', same(await media.read('disks/blank.vdk'), Emu.blankDisk('vdk', 40, 2)));
    }
    // 3b. the reverse: the Library import is held at its store write and the new disk started while it is held.
    //    Without the serialisation this is the one order that loses bytes with no error at all: the new disk's
    //    listing sees an empty store, its write lands over the import's, and both calls report success (the
    //    import never mounted, so the new disk's second diskHolder check finds nothing). The import's bytes are
    //    gone and nothing refused them.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const realWrite = media.write.bind(media);
      let release = null, hold = 1;
      media.write = (n, b) => { if (n === 'disks/blank.vdk' && hold-- > 0) return new Promise((r) => { release = () => r(realWrite(n, b)); }); return realWrite(n, b); };
      const p2 = q(s.importMedia(N, vdk40x2()));
      for (let i = 0; i < 500 && !release; i++) await new Promise((r) => setImmediate(r));
      const atWrite = !!release;
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      if (release) release();
      const r2 = await p2, r1 = await p1;
      check('Library import first: the import was at its store write when the new disk started', atWrite);
      check('Library import first: the import is stored, as alone', r2.ok, r2.m);
      check('Library import first: the new disk is refused with the library\'s "already exists"', !r1.ok && /There is already a disk named blank\.vdk in your library: choose another name\./.test(r1.m), r1.m);
      check('Library import first: the store still holds the imported image, not a blank written over it', same(await media.read('disks/blank.vdk'), vdk40x2()));
      check('Library import first: no blank disk was ever mounted (drive 0 is empty)', s.diskStatus().drives.length === 0, JSON.stringify(s.diskStatus().drives));
    }
    // 4. the case variant, interleaved: on a store that does not tell cases apart GAME.DSK is held while game.dsk
    //    (another case, one name) is asked for -> it waits and is refused; on one that does, they are two names, so
    //    it goes into drive 1 at once (the control).
    {
      const media = held(new MemoryMediaStore({ caseInsensitive: true })), s = alphaOn(media);
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: 'GAME.DSK' }));
      await media.held();
      const p2 = q(s.importDisk('game.dsk', images.vdk(20, 1), 1));
      let early = false; p2.then(() => { early = true; });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      check('case-insensitive: the other spelling (one name here) waits while GAME.DSK is held', !early, `settled=${early}`);
      media.release();
      const r1 = await p1, r2 = await p2;
      check('case-insensitive: GAME.DSK held and game.dsk imported meanwhile is refused as one name',
        r1.ok && !r2.ok && r2.m === 'There is already a disk named GAME.DSK in your library: choose another name.', `${r1.m} | ${r2.m}`);
      check('case-insensitive: and the library still has only GAME.DSK', (await media.list('disks/')).map((f) => f.name).join() === 'disks/GAME.DSK');
    }
    {
      const media = held(new MemoryMediaStore({ caseInsensitive: false })), s = alphaOn(media);
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: 'GAME.DSK' }));
      await media.held();
      const p2 = q(s.importDisk('game.dsk', images.vdk(20, 1), 1));
      media.release();
      const r1 = await p1, r2 = await p2;
      // CASE-SENSITIVE CONTROL: here GAME.DSK and game.dsk are two names (sameName says so), so the second is not a
      // second creation of the first and goes in. This is what pins the rule to the store's own comparison rather
      // than to a case-folding guess.
      check('case-sensitive: game.dsk is another disk and goes into drive 1 meanwhile', r1.ok && r2.ok && r2.m === 'game.dsk in drive 1', `${r1.m} | ${r2.m}`);
      check('case-sensitive: the two spellings are two files, each its own bytes', (await media.list('disks/')).map((f) => f.name).join() === 'disks/GAME.DSK,disks/game.dsk'
        && same(await media.read('disks/GAME.DSK'), Emu.blankDisk('vdk', 40, 2)) && same(await media.read('disks/game.dsk'), images.vdk(20, 1)));
    }
    // 5. the first free name, chosen ahead of an import still writing disk-1.vdk: the new disk takes disk-2,
    //    never the name the import is about to make
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media);
      const slow = media.write.bind(media);
      let release = null; media.write = (n, b) => (n === 'disks/disk-1.vdk' ? new Promise((r) => { release = () => r(slow(n, b)); }) : slow(n, b));
      const p2 = q(s.importDisk('disk-1.vdk', images.vdk(20, 1), 1));
      for (let i = 0; i < 40 && !release; i++) await new Promise((r) => setImmediate(r));
      const heldAtWrite = !!release;
      // the import's write lands now (and it mounts); the new disk, started before it finished, must not pick
      // the name it can see is being made
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }));
      if (release) release();
      const r2 = await p2, r1 = await p1;
      check('the first free name is taken past a disk a queued import has just made', heldAtWrite && r2.ok && r1.ok && r1.m === 'New blank disk: disk-2.vdk in drive 0', `${r1.m} | ${r2.m}`);
      check('... and both are stored, one each', (await media.list('disks/')).map((f) => f.name).join() === 'disks/disk-1.vdk,disks/disk-2.vdk');
    }
    // 6. a failed creation does not hold the creation slot: the next new disk runs
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media);
      await s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'taken.vdk' });
      const bad = await q(s.newDisk(1, { format: 'jvc', tracks: 40, heads: 1 }, { name: 'x.dmk' }));
      check('the refused new disk (wrong extension) says why', !bad.ok && /JVC image needs a name ending \.dsk/.test(bad.m), bad.m);
      const ok = await q(s.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'x.vdk' }));
      check('a failed creation lets the next one run (it does not leave the creation slot taken)', ok.ok && /x\.vdk in drive 1/.test(ok.m), ok.m);
      // a store that throws does not wedge the queue either: the next creation still runs
      const realWrite = MemoryMediaStore.prototype.write;
      media.write = () => Promise.reject(new MediaStoreError('io', 'boom'));
      const broke = await q(s.newDisk(1, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'y.vdk' }));
      delete media.write;   // back to the prototype's own write (the store is a MemoryMediaStore)
      const after = await q(s.importDisk('z.vdk', images.vdk(40, 1), 0));
      check('a creation whose store write throws does not wedge the creation queue', !broke.ok && /boom/.test(broke.m) && after.ok, `${broke.m} | ${after.m}`);
    }
    // 7. SAME drive: the second creation of a name must refuse, not eject the first and replace it. The
    //    diskHolder checks cannot see this one -- they look for the image in a drive, and the import's own
    //    eject removes it before its re-check -- so it was the remaining silent overwrite. Both orders, each
    //    with the first creation held so the second is genuinely queued behind it.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      const where = await media.held();
      const p2 = q(s.importDisk(N, vdk40x2(), 0));      // the SAME drive 0
      media.release();
      const r1 = await p1, r2 = await p2;
      check('same drive, newDisk first: the new disk is held while the import of its name queues on drive 0', where && r1.ok, `${where} | ${r1.m}`);
      check('same drive, newDisk first: the import is refused as a second creation of the name', !r2.ok && /There is already a disk named blank\.vdk in your library: choose another name\./.test(r2.m), r2.m);
      check('same drive, newDisk first: the store still holds the blank, not the import\'s bytes', same(await media.read('disks/blank.vdk'), Emu.blankDisk('vdk', 40, 2)));
      check('same drive, newDisk first: drive 0 still holds the blank', s.diskStatus().drives.length === 1 && s.diskStatus().drives[0].file === N, JSON.stringify(s.diskStatus().drives));
    }
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const realWrite = media.write.bind(media);
      let release = null, hold = 1;
      media.write = (n, b) => { if (n === 'disks/blank.vdk' && hold-- > 0) return new Promise((r) => { release = () => r(realWrite(n, b)); }); return realWrite(n, b); };
      const p2 = q(s.importDisk(N, vdk40x2(), 0));      // the import first, drive 0, held at its store write
      for (let i = 0; i < 500 && !release; i++) await new Promise((r) => setImmediate(r));
      const atWrite = !!release;
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));   // the new disk second, same drive
      if (release) release();
      const r2 = await p2, r1 = await p1;
      check('same drive, import first: the import is held at its store write while the new disk queues on drive 0', atWrite && r2.ok, `${atWrite} | ${r2.m}`);
      check('same drive, import first: the new disk is refused as a second creation of the name', !r1.ok && /There is already a disk named blank\.vdk in your library: choose another name\./.test(r1.m), r1.m);
      check('same drive, import first: the store still holds the imported image', same(await media.read('disks/blank.vdk'), vdk40x2()));
    }
    // 7b. SAME drive, the two spellings differ only in case. On a store that does not tell cases apart they are one
    //     file, so this is 7 in another spelling: it was the remaining silent overwrite, because the pending name
    //     was keyed by the exact string (GAME.DSK and game.dsk were two keys). Red on the previous head.
    {
      const media = held(new MemoryMediaStore({ caseInsensitive: true })), s = alphaOn(media);
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: 'GAME.DSK' }));
      await media.held();
      const p2 = q(s.importDisk('game.dsk', images.vdk(20, 1), 0));   // SAME drive, other spelling
      media.release();
      const r1 = await p1, r2 = await p2;
      check('same drive, other case: the import of the same file is refused (one name on this store)', r1.ok && !r2.ok
        && r2.m === 'There is already a disk named GAME.DSK in your library: choose another name.', `${r1.m} | ${r2.m}`);
      check('same drive, other case: the store still holds the blank', same(await media.read('disks/GAME.DSK'), Emu.blankDisk('vdk', 40, 2)));
      check('same drive, other case: one file, still in drive 0', (await media.list('disks/')).map((f) => f.name).join() === 'disks/GAME.DSK'
        && s.diskStatus().drives.length === 1 && s.diskStatus().drives[0].file === 'GAME.DSK');
    }
    // 7c. SAME drive, the new disk's name is AUTO-chosen (disk-1.vdk, picked inside its turn). An import of the
    //     name it picks, asked while that creation was still running, must be refused too: it was the second silent
    //     overwrite, because a creation that does not know its name when asked was never counted. Red before.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media);
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }));   // no name: disk-1.vdk
      await media.held();
      // the ORDER this case is about: the new disk has already chosen and written disk-1.vdk, but has not landed it
      // (no creation has finished), so the import below is asked while that creation is still in flight
      check('auto-named: the new disk has written disk-1.vdk and not yet landed it when the import is asked',
        (await media.list('disks/')).map((f) => f.name).join() === 'disks/disk-1.vdk' && s.landing === 0, `landing=${s.landing}`);
      const p2 = q(s.importDisk('disk-1.vdk', images.vdk(20, 1), 0));       // SAME drive, the name it will pick
      media.release();
      const r1 = await p1, r2 = await p2;
      check('auto-named: the new disk stored disk-1.vdk', r1.ok && r1.m === 'New blank disk: disk-1.vdk in drive 0', r1.m);
      check('auto-named: an import of the name it picked, asked meanwhile, is refused', !r2.ok
        && r2.m === 'There is already a disk named disk-1.vdk in your library: choose another name.', r2.m);
      check('auto-named: the store still holds the blank',
        same(await media.read('disks/disk-1.vdk'), Emu.blankDisk('vdk', 40, 2)));
    }
    // 8. a Library import queued behind a creation must not write into the library while it is being moved. The
    //    move copies what is in the store when it lists it; a write that lands afterwards is in the old place, so
    //    the import claims success and the moved library lacks it. The move is held in flight (its own write to the
    //    new store) while the creation ahead of the import finishes, so the import's turn comes mid-move.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const target = new MemoryMediaStore();
      const realTargetWrite = target.write.bind(target);
      let tRelease = null, tHold = 1;
      target.write = (n, b) => { if (tHold-- > 0) return new Promise((r) => { tRelease = () => r(realTargetWrite(n, b)); }); return realTargetWrite(n, b); };
      media.holdReadBack();
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      await media.held();
      const p2 = q(s.importMedia('late.dsk', images.vdk(40, 1)));   // queued behind the held new disk
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const moving = s.moveMedia(target);                            // starts, and is held at its own write
      for (let i = 0; i < 50 && !tRelease; i++) await new Promise((r) => setImmediate(r));
      media.release();                                               // the new disk finishes; the import's turn comes now
      const r2 = await p2;
      if (tRelease) tRelease();   // let the move finish before waiting on it
      const move = await moving.then((r) => ({ ok: true, r }), (e) => ({ ok: false, m: e.message }));
      const r1 = await p1;
      // the new disk stored its blank before the move began; its mount then found the library moving, so it says
      // so (the image is in the store and mountable again) rather than mounting into a library being replaced
      check('move: the new disk in front of the queue stored its image, and its mount says the library is moving',
        !r1.ok && /saved to your Library but not put in drive 0: The library is being moved/.test(r1.m) && !!(await media.stat('disks/blank.vdk')), r1.m);
      check('move: the move itself completed', move.ok, move.m || '');
      check('move: a Library import whose turn comes mid-move is refused rather than written into the library being left',
        !r2.ok && /being moved/.test(r2.m), r2.m);
      check('move: the moved library does not hold an image the import claimed to store', !(await target.stat('disks/late.dsk')), JSON.stringify((await target.list('disks/')).map((f) => f.name)));
    }
    // 9. a creation whose store write does not answer holds the turn: there is no deadline, so nothing runs
    //    alongside it. A second creation of ANOTHER name and a retry of the SAME name, both asked while it hangs,
    //    wait (no store write, no mount); when the store answers, the first lands and mounts, the other name follows,
    //    and the retry is refused as a second creation -- the first's bytes kept, the name in one drive.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media);
      const realWrite = media.write.bind(media);
      let releaseStuck = null;
      media.write = (n, b) => (n === 'disks/stuck.vdk' && !releaseStuck ? new Promise((r) => { releaseStuck = () => r(realWrite(n, b)); }) : realWrite(n, b));
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'stuck.vdk' }));
      for (let i = 0; i < 500 && !releaseStuck; i++) await new Promise((r) => setImmediate(r));
      const p2 = q(s.importDisk('after.vdk', images.vdk(40, 1), 1));
      const p3 = q(s.importDisk('stuck.vdk', images.vdk(20, 1), 1));
      let settled = 0; p1.then(() => settled++); p2.then(() => settled++); p3.then(() => settled++);
      for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
      check('no deadline: while the store write hangs, nothing has settled and nothing else was written or mounted',
        !!releaseStuck && settled === 0 && (await media.list('disks/')).length === 0 && s.diskStatus().drives.length === 0,
        `settled=${settled} ${JSON.stringify((await media.list('disks/')).map((f) => f.name))} ${JSON.stringify(s.diskStatus().drives)}`);
      releaseStuck();
      const r1 = await p1, r2 = await p2, r3 = await p3;
      check('no deadline: once the store answers, the hung creation lands and mounts', r1.ok && r1.m === 'New blank disk: stuck.vdk in drive 0', r1.m);
      check('no deadline: the creation of another name queued behind it then runs', r2.ok && r2.m === 'after.vdk in drive 1', r2.m);
      check('no deadline: the retry of the same name is refused as a second creation', !r3.ok && r3.m === 'There is already a disk named stuck.vdk in your library: choose another name.', r3.m);
      check('no deadline: the store holds the first creation\'s bytes and the other name, nothing more',
        (await media.list('disks/')).map((f) => f.name).join() === 'disks/after.vdk,disks/stuck.vdk'
        && same(await media.read('disks/stuck.vdk'), Emu.blankDisk('vdk', 40, 1)) && same(await media.read('disks/after.vdk'), images.vdk(40, 1)));
      check('no deadline: stuck.vdk is in one drive only (0), after.vdk in 1',
        s.diskStatus().drives.map((d) => `${d.drive}:${d.file}`).join() === '0:stuck.vdk,1:after.vdk', JSON.stringify(s.diskStatus().drives));
      check('no deadline: with the queue empty, no landing is kept', s.pendingLands.length === 0 && s.creationsAsked.length === 0, JSON.stringify(s.pendingLands));
    }
    // 10. R3: the first creation FAILS (its store write is refused) while a creation of the same name is queued: the
    //     queued one is not a second creation of anything and succeeds, its bytes stored and mounted.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      let reject = null;
      const realWrite = media.write.bind(media);
      media.write = (n, b) => (n === 'disks/blank.vdk' && !reject ? new Promise((_, j) => { reject = () => j(new MediaStoreError('io', 'boom')); }) : realWrite(n, b));
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      for (let i = 0; i < 500 && !reject; i++) await new Promise((r) => setImmediate(r));
      const p2 = q(s.importDisk(N, images.vdk(20, 1), 1));
      reject();
      const r1 = await p1, r2 = await p2;
      check('first fails: the new disk is refused with the store\'s error', !r1.ok && /boom/.test(r1.m), r1.m);
      check('first fails: the import of the same name queued meanwhile goes in', r2.ok && r2.m === 'blank.vdk in drive 1', r2.m);
      check('first fails: the store holds the import\'s bytes, in drive 1 only', same(await media.read('disks/blank.vdk'), images.vdk(20, 1))
        && s.diskStatus().drives.map((d) => `${d.drive}:${d.file}`).join() === '1:blank.vdk', JSON.stringify(s.diskStatus().drives));
    }
    // 11. a deliberate replace: an import of a name asked AFTER newDisk made it finished is a disk taking a newer copy
    //     of itself (into the drive that holds it), not a second creation, and is allowed.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const r1 = await q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      const r2 = await q(s.importDisk(N, images.vdk(20, 1), 0));
      check('replace after newDisk: both succeed', r1.ok && r2.ok && r2.m === 'blank.vdk in drive 0', `${r1.m} | ${r2.m}`);
      check('replace after newDisk: the store holds the newer bytes, in drive 0', same(await media.read('disks/blank.vdk'), images.vdk(20, 1))
        && s.diskStatus().drives.map((d) => `${d.drive}:${d.file}`).join() === '0:blank.vdk', JSON.stringify(s.diskStatus().drives));
    }
    // 12. multi-waiter pruning and spelling: A (GAME.DSK, held) is followed by B (other.dsk) and C (game.dsk) asked
    //     meanwhile, on a case-insensitive store. While C still waits, pruning after A must keep A's landing (C was
    //     asked before it), and C's refusal names the spelling that landed. Then a deliberate replace in another case
    //     (Game.dsk, asked after all finished) lands, and a creation racing IT is refused with ITS spelling, not the
    //     first one ever landed.
    {
      const media = held(new MemoryMediaStore({ caseInsensitive: true })), s = alphaOn(media);
      media.holdReadBack();
      const pa = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: 'GAME.DSK' }));
      await media.held();
      const pb = q(s.importDisk('other.dsk', images.vdk(40, 1), 1));
      const pc = q(s.importDisk('game.dsk', images.vdk(20, 1), 1));
      media.release();
      const ra = await pa, rb = await pb, rc = await pc;
      check('multi-waiter: A and B go in, C (A\'s name, other case) is refused naming A\'s spelling', ra.ok && rb.ok && !rc.ok
        && rc.m === 'There is already a disk named GAME.DSK in your library: choose another name.', `${ra.m} | ${rb.m} | ${rc.m}`);
      await s.ejectDisk(0);
      media.holdReadBack();
      const pd = q(s.importDisk('Game.dsk', images.vdk(40, 2), 0));     // a deliberate replace, asked after A finished
      await media.held();
      const pe = q(s.importDisk('gAME.dsk', images.vdk(20, 1), 1));     // asked while D is in flight
      media.release();
      const rd = await pd, re = await pe;
      check('spelling: the replace lands, and the creation racing it is refused naming the spelling that landed last',
        rd.ok && !re.ok && re.m === 'There is already a disk named Game.dsk in your library: choose another name.', `${rd.m} | ${re.m}`);
      check('spelling: the store holds the replace\'s bytes, in drive 0 only', same(await media.read('disks/GAME.DSK'), images.vdk(40, 2))
        && s.diskStatus().drives.filter((d) => s.sameName(d.name, 'disks/game.dsk')).map((d) => d.drive).join() === '0', JSON.stringify(s.diskStatus().drives));
      check('pruning: with the queue empty, no landing is kept', s.pendingLands.length === 0 && s.creationsAsked.length === 0, JSON.stringify(s.pendingLands));
    }
     // 13. the new disk's blank is stored but its mount FAILS (not because the library is moving: the read-back finds
    //     nothing), while an import of its name is queued. The creation still landed the name, so the import is
    //     refused and the blank's bytes are kept -- not silently replaced because the first creation did not mount.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      media.holdReadBack({ missing: true });
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      const where = await media.held();
      const p2 = q(s.importDisk(N, images.vdk(20, 1), 1));
      media.release();
      const r1 = await p1, r2 = await p2;
      check('mount fails: the new disk says it was saved but not put in drive 0', where && !r1.ok && r1.m.startsWith('blank.vdk was saved to your Library but not put in drive 0: '), r1.m);
      check('mount fails: the import queued meanwhile is refused as a second creation', !r2.ok && r2.m === 'There is already a disk named blank.vdk in your library: choose another name.', r2.m);
      check('mount fails: the store holds the blank\'s bytes and no drive holds it', same(await media.read('disks/blank.vdk'), Emu.blankDisk('vdk', 40, 2)) && s.diskStatus().drives.length === 0, JSON.stringify(s.diskStatus().drives));
    }
    // 14. the store's case probe THROWS once, straight after the new disk's write (refreshCase): the name is stored,
    //     so the creation must still land it, and an import of the name queued meanwhile is refused.
    {
      const media = held(new MemoryMediaStore()), s = alphaOn(media), N = 'blank.vdk';
      const realWrite = media.write.bind(media);
      let release = null, armed = false;
      media.write = (n, b) => (n === 'disks/blank.vdk' && !release ? new Promise((r) => { release = () => r(realWrite(n, b).then((x) => { armed = true; media.caseMeasured = false; return x; })); }) : realWrite(n, b));
      Object.defineProperty(media, 'declaresCase', { configurable: true, get: () => { if (armed) { armed = false; return false; } return true; } });
      const p1 = q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 2 }, { name: N }));
      for (let i = 0; i < 500 && !release; i++) await new Promise((r) => setImmediate(r));
      const p2 = q(s.importDisk(N, images.vdk(20, 1), 1));
      release();
      const r1 = await p1, r2 = await p2;
      check('case probe throws: the new disk reports the probe\'s error, by name', !r1.ok && r1.m === `blank.vdk: a synchronous store must declare caseInsensitive`, r1.m);
      check('case probe throws: the import queued meanwhile is refused as a second creation', !r2.ok && r2.m === 'There is already a disk named blank.vdk in your library: choose another name.', r2.m);
      check('case probe throws: the store holds the blank\'s bytes', same(await media.read('disks/blank.vdk'), Emu.blankDisk('vdk', 40, 2)));
    }
  }
  const fail = failures();
  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
