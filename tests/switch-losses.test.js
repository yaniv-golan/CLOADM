// What a machine switch or a RAM change takes out of the machine in use: Session.takenOut lists the
// tape, the cartridge (with its file when it came from one) and the disks in the drives, from the old machine; it
// leaves out DriveWire disks (the Session's: they stay mounted) and a Speech/Sound Pak the new machine's `ssc` option
// puts back. DiskDrives.keepSnapshot stores the disk that came with a snapshot in the Library and links the drive
// to it. The machine runs our own firmware as the DOS ROM (tools/mame-diff/fdc/dragon-write.asm); disk images are
// built by tools/mame-diff/fdc/images.js. The expected lists are written out here, not produced by the code under test.
const path = require('path');
const Emu = require('./load')();
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
const images = require('../tools/mame-diff/fdc/images');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { TMS7040_ROM_SIZE } = require('../js/machines/ssc.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (name, p, re) => { let msg = null; try { await p; } catch (e) { msg = e instanceof Emu.SessionError ? e.message : `not a SessionError: ${e.message}`; } check(name, msg !== null && re.test(msg), msg === null ? 'did not reject' : msg); };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const json = (x) => JSON.stringify(x);

const dos = romImage(assembleFile(path.join(__dirname, '../tools/mame-diff/fdc/dragon-write.asm'), '6809'), 0xC000, 0x2000, 0x00);
const tape = new Uint8Array(300).fill(0x55);
const cart = new Uint8Array(8192).fill(0x12); cart[0] = 0x20; cart[1] = 0xFE;   // BRA * at $C000

(async () => {
  // ---- a tape and a disk on the Dragon 64 (the disk controller itself is not named: its disk is)
  {
    const media = new MemoryMediaStore();
    const s = new Emu.Session({ media });
    s.switchMachine('dragon64');
    check('nothing in the machine: nothing taken out', json(s.takenOut('dragon32')) === '[]', json(s.takenOut('dragon32')));
    s.roms.put('dragondos', 'rom', dos, 'ddos10.rom');
    await s.drives.importImage('WORK.VDK', images.vdk(40, 1), 0);
    s.insertTape('GAME.CAS', tape);
    const out = s.takenOut('dragon32');
    check('a tape and a disk: both named, the disk with its drive and stored (in the Library)',
      json(out) === json([{ kind: 'tape', name: 'GAME.CAS' }, { kind: 'disk', name: 'WORK.VDK', drive: 0, stored: true }]), json(out));
    check('a RAM change (the same model) takes out the same', json(s.takenOut('dragon64', { ram: 64 })) === json(out));
    check('takenOut only reports: the machine still has them', !!s.shownMachine.deck.tape && s.drives.status().drives.length === 1);

    // ---- a snapshot's own disk: stored false; keepSnapshotDisk puts it in the Library and links the drive
    const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
    await s.drives.eject(0);
    await s.library.deleteMedia('disks/WORK.VDK');
    s.openSnapshot(snap);
    const before = s.takenOut('dragon32').find((t) => t.kind === 'disk');
    check('a snapshot\'s own disk is listed as not stored', !!before && before.stored === false && before.name === 'WORK.VDK', json(before));
    const bytes = (await s.drives.download(0)).bytes;
    const msg = await s.drives.keepSnapshot(0);
    check('keepSnapshotDisk says so', msg === 'Saved WORK.VDK to your Library', msg);
    check('... the image is in the Library, byte for byte', same(await media.read('disks/WORK.VDK'), bytes));
    check('... and the drive is linked to it (stored, a store link for its writes)', s.drives.status().drives[0].stored === true && s.drives.stored(s.shownMachine).length === 1);
    await rejects('a disk already in the Library is refused', s.drives.keepSnapshot(0), /WORK\.VDK is already in your Library/);
    await rejects('an empty drive is refused', s.drives.keepSnapshot(1), /Drive 1 is empty/);
    // a name the Library already has belongs to another disk: refused, nothing overwritten
    s.openSnapshot(snap);
    const other = images.vdk(40, 2);
    await media.write('disks/WORK.VDK', other);
    await rejects('a name the Library already has is refused', s.drives.keepSnapshot(0), /already has a disk named WORK\.VDK/);
    check('... and the Library\'s disk is left as it was', same(await media.read('disks/WORK.VDK'), other));
  }

  // ---- Save to Library while the Library moves: a move that starts while keepSnapshotDisk looks in
  // the store waits for it, so the save lands in the old store and is copied; a different WORK.VDK already in the new
  // store is never overwritten, and the drive is not linked mid-move
  {
    const from = new MemoryMediaStore(), to = new MemoryMediaStore();
    const s = new Emu.Session({ media: from });
    await s.ready();
    s.switchMachine('dragon64');
    s.roms.put('dragondos', 'rom', dos, 'ddos10.rom');
    await s.drives.importImage('WORK.VDK', images.vdk(40, 1), 0);
    const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
    await s.drives.eject(0);
    await s.library.deleteMedia('disks/WORK.VDK');
    s.openSnapshot(snap);
    const theirs = images.vdk(40, 2);
    await to.write('disks/WORK.VDK', theirs);
    const stat = from.stat.bind(from);
    from.stat = async (n) => { await new Promise((r) => setTimeout(r, 200)); return stat(n); };
    const keep = s.drives.keepSnapshot(0).then((m) => m, (e) => e);
    await new Promise((r) => setTimeout(r, 10));
    const move = s.library.moveMedia(to).then((m) => m, (e) => e);
    const [kept, moved] = await Promise.all([keep, move]);
    from.stat = stat;
    check('a move started during Save to Library: the new store\'s own WORK.VDK is not overwritten', same(await to.read('disks/WORK.VDK'), theirs),
      `${kept && kept.message || kept} / ${moved && moved.message || JSON.stringify(moved)}`);
    check('... the save landed in the store it was made in (the old one)', !!(await from.stat('disks/WORK.VDK')));
  }

  // ---- the other order (delta review a): a move already copying, then Save to Library: refused, nothing written in
  // either store and the drive left unlinked (without libraryOp the save went into the old store behind the copy)
  {
    const from = new MemoryMediaStore(), to = new MemoryMediaStore();
    const s = new Emu.Session({ media: from });
    await s.ready();
    s.switchMachine('dragon64');
    s.roms.put('dragondos', 'rom', dos, 'ddos10.rom');
    await s.drives.importImage('WORK.VDK', images.vdk(40, 1), 0);
    const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
    await s.drives.eject(0);
    await s.library.deleteMedia('disks/WORK.VDK');
    s.openSnapshot(snap);                                      // the snapshot's own disk: not linked, so the move may start
    let release;
    const gate = new Promise((r) => { release = r; });
    const write = to.write.bind(to);
    to.write = async (n, b) => { await gate; return write(n, b); };   // the copy is held part-way
    const move = s.library.moveMedia(to).then((m) => m, (e) => e);
    await new Promise((r) => setTimeout(r, 20));
    const kept = await s.drives.keepSnapshot(0).then((m) => m, (e) => e);
    release();
    const moved = await move;
    to.write = write;
    check('a Save to Library while a move copies is refused (the library is being moved)', kept instanceof Error && /being moved/.test(kept.message),
      kept instanceof Error ? kept.message : String(kept));
    check('... nothing was written to either store, and the drive is still the snapshot\'s own', !(await from.stat('disks/WORK.VDK')) && !(await to.stat('disks/WORK.VDK'))
      && s.drives.status().drives[0].stored === false, JSON.stringify(moved));
  }

  // ---- a write the store refuses (delta review b): the drive's link to the Library is undone, so the drive stays the
  // snapshot's own (not stored, its writes going nowhere) and Save to Library can be tried again
  {
    const media = new MemoryMediaStore();
    const s = new Emu.Session({ media });
    await s.ready();
    s.switchMachine('dragon64');
    s.roms.put('dragondos', 'rom', dos, 'ddos10.rom');
    await s.drives.importImage('WORK.VDK', images.vdk(40, 1), 0);
    const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
    await s.drives.eject(0);
    await s.library.deleteMedia('disks/WORK.VDK');
    s.openSnapshot(snap);
    const write = media.write.bind(media);
    media.write = async (n, b) => { if (n === 'disks/WORK.VDK') { const e = new Error('full'); e.code = 'quota'; throw e; } return write(n, b); };
    const refused = await s.drives.keepSnapshot(0).then((m) => m, (e) => e);
    media.write = write;
    const d = s.drives.status().drives[0];
    check('a refused write: Save to Library fails with the store\'s reason', refused instanceof Error && /No space left/.test(refused.message), refused instanceof Error ? refused.message : String(refused));
    check('... and the drive is unlinked again: not stored, no store link, under its snapshot name', d.stored === false && s.drives.stored(s.shownMachine).length === 0, JSON.stringify(d));
    const again = await s.drives.keepSnapshot(0).then((m) => m, (e) => e);
    check('... so a retry saves it', again === 'Saved WORK.VDK to your Library' && s.drives.status().drives[0].stored === true, String(again && again.message || again));
  }

  // ---- a cartridge loaded from a file: named by it
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon32');
    s.load('GAME.DGN', cart);
    check('a cartridge is named by its file', json(s.takenOut('coco')) === json([{ kind: 'cartridge', name: 'GAME.DGN' }]), json(s.takenOut('coco')));
  }

  // ---- the Speech/Sound Pak: left out when the new machine puts it back, named when it does not
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('coco');
    s.roms.put('ssc', 'tms7040', new Uint8Array(TMS7040_ROM_SIZE).fill(0xFF), 'pic.rom');
    s.insertSsc();
    check('the Pak is in', s.sscInserted);
    check('a RAM change keeps the Pak (its ssc option puts it back): not listed', json(s.takenOut('coco', Object.assign({}, s.shownMachine.config, { ram: 16 }))) === '[]',
      json(s.takenOut('coco', Object.assign({}, s.shownMachine.config, { ram: 16 }))));
    check('a model without it: the Pak is taken out, as a cartridge', json(s.takenOut('dragon32')) === json([{ kind: 'cartridge', name: null }]), json(s.takenOut('dragon32')));
  }

  // ---- DriveWire: the Session's disks, not the machine's: not listed, still mounted after the switch
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('coco3', { ram: 512, becker: true });
    const n = await s.newDriveWireImage('dw.dsk');
    await s.mountDriveWire(0, n);
    check('a DriveWire disk is not listed', json(s.takenOut('coco')) === '[]', json(s.takenOut('coco')));
    s.chooseMachine('coco');
    check('... and stays mounted after the switch', s.driveWireMounts.some((d) => d.drive === 0 && d.name === n), json(s.driveWireMounts));
  }

  // ---- switchLoses: would the switch lose something of the person's? Their input reached the machine (a key, a typed
  // line, a load, a POKE) or the switch takes something out. A link's moment opens without the switch question only
  // when it would not (js/ui/snapshot-panel.js): a page just opened holds nothing of theirs.
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon64');
    for (let i = 0; i < 5; i++) s.shownMachine.runFrame();   // (its own running is not the person's)
    check('switchLoses: a fresh machine, nothing in it: nothing to lose', s.switchLoses('coco') === false && s.switchLoses('mc10', { ram: 20 }) === false);
    s.typeText('10 PRINT "HI"\n');
    check('switchLoses: a line typed: something to lose', s.switchLoses('coco') === true);
    s.chooseMachine('coco');
    check('switchLoses: ... and none on the machine switched to (its own count)', s.switchLoses('dragon64') === false);
    s.load('prog.bin', Uint8Array.from([0x00, 0x00, 0x02, 0x30, 0x00, 0x20, 0xFE, 0xFF, 0x00, 0x00, 0x30, 0x00]));
    check('switchLoses: a program loaded: something to lose', s.switchLoses('dragon64') === true);
    // a tape that came in a moment (opening one is not a touch): nothing typed, but the switch takes the tape out
    const t = new Emu.Session({ media: new MemoryMediaStore() });
    t.switchMachine('dragon64');
    t.insertTape('GAME.CAS', tape);
    const withTape = await t.readSnapshot((await t.snapshotFile()).bytes);
    const v = new Emu.Session({ media: new MemoryMediaStore() });
    v.switchMachine('dragon64');
    v.openSnapshot(withTape);
    check('switchLoses: a tape in the deck, no input (a switch takes the tape out): something to lose', v.touches() === 0 && v.switchLoses('coco') === true, String(v.touches()));
    const u = new Emu.Session({ media: new MemoryMediaStore() });
    u.switchMachine('dragon64');
    u.shownMachine.poke(0x0600, 1);   // the machine's own poke (a program's write) is not the person's
    check('switchLoses: the machine\'s own write is not a touch', u.switchLoses('coco') === false);
  }

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
