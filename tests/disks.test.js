// Floppy disks through the Session (on the MediaStore): disk images stored under disks/,
// mounted with readRange, written back with writeRange (only the bytes that changed), never through the media
// index; up to four drives, write-protect, download, the disk cartridge plugged in on the first mount, and the
// errors a user can run into. The machine runs our own firmware (tools/mame-diff/fdc/<board>-write.asm, from
// gen-diag.js) in place of BASIC and the DOS ROM: it writes sector 3 of track 1 on drives 0 and 1 with
// $11 + 3i and $22 + 3i, reads it back and stops the motor. The expected images are built here from
// tools/mame-diff/fdc/images.js and the sector's offset in the format, not by running the code under test.
const path = require('path');
const Emu = require('./load')();
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
const images = require('../tools/mame-diff/fdc/images');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (name, p, re) => { let msg = null; try { await p; } catch (e) { msg = e instanceof Emu.SessionError ? e.message : `not a SessionError: ${e.message}`; } check(name, msg !== null && re.test(msg), msg === null ? 'did not reject' : msg); };

const FDC = path.join(__dirname, '../tools/mame-diff/fdc');
require(path.join(FDC, 'gen-diag')).write();
const boot = romImage(assembleFile(path.join(FDC, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12);
const writer = (board) => { const a = assembleFile(path.join(FDC, `${board}-write.asm`), '6809'); return { rom: romImage(a, 0xC000, 0x2000, 0x00), halt: a.symbols.get('HALT') }; };
const pattern = (first) => Array.from({ length: 256 }, (_, i) => (first + 3 * i) & 0xff);
// sector 3 of track 1, side 0, after the header (VDK 12 bytes, a two-sided JVC 2), sectors in order
const sectorOffset = (header, heads) => header + ((1 * heads + 0) * 18 + 2) * 256;
const expectImage = (bytes, header, heads, data) => { const e = bytes.slice(); e.set(data, sectorOffset(header, heads)); return e; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// a MemoryMediaStore that records the writes it receives
function spyStore(opts) {
  const st = new MemoryMediaStore(opts);
  st.calls = [];
  for (const m of ['write', 'writeRange', 'read', 'readRange']) {
    const orig = st[m].bind(st);
    st[m] = (name, ...a) => { st.calls.push({ m, name, offset: m.endsWith('Range') ? a[0] : null, length: m === 'writeRange' ? a[1].length : m === 'write' ? a[0].length : m === 'readRange' ? a[1] : null }); return orig(name, ...a); };
  }
  return st;
}
// a session on `machine` with our boot firmware as BASIC and the writer as the DOS ROM of `dos`
// (storeOpts: MemoryMediaStore's options, e.g. { caseInsensitive: true }; media: a store to use instead)
function session(machine, dos, board, { storeOpts, media: given } = {}) {
  const media = given || spyStore(storeOpts);
  const s = new Emu.Session({ media });
  return { s, media, halt: putRoms(s, machine, dos, board) };
}
// our firmware as the machine's BASIC and as the DOS ROM, on `machine` -> the writer's HALT address
function putRoms(s, machine, dos, board) {
  s.switchMachine(machine);
  const p = Emu.profiles[machine];
  for (const sl of p.roms) s.roms.put(machine, sl.id, boot.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size), 'boot.rom');
  s.loadSavedRoms();
  const w = writer(board);
  if (dos) s.roms.put(dos, 'rom', w.rom, 'firmware.rom');
  return w.halt;
}
const runToHalt = (s, halt, frames = 600) => { let f = 0; while (s.machine.cpu.pc !== halt && f < frames) { s.machine.runFrame(); f++; } return s.machine.cpu.pc === halt; };
const log = (s) => s.machine.ram.slice(0x6000, 0x6000 + 32);

(async () => {
  // ---------------- Dragon 64, DragonDOS cartridge, two VDK disks
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    let events = 0;
    s.on((e) => { if (e === 'disks') events++; });
    check('no disk cartridge before the first mount', s.diskStatus().dos === null && s.diskController === null);
    const msg = await s.importDisk('work.vdk', d0, 0);
    check('importDisk stores the image under disks/ and mounts it in drive 0', msg === 'work.vdk in drive 0' && !!(await media.stat('disks/work.vdk')), msg);
    check('the first mount plugs in the DragonDOS cartridge (the controller for the ROM stored)', s.diskController && s.diskController.type === 'dragonfdc' && s.diskStatus().dos.id === 'dragondos');
    check('the mount read the image with readRange, all of it', media.calls.some((c) => c.m === 'readRange' && c.name === 'disks/work.vdk' && c.offset === 0 && c.length === d0.length));
    await s.importDisk('other.vdk', d1, 1);
    const st = s.diskStatus();
    check('diskStatus: two drives with their names, sizes, not write-protected, linked to the store', st.drives.length === 2 && st.drives[0].file === 'work.vdk' && st.drives[1].file === 'other.vdk'
      && st.drives[0].size === d0.length && !st.drives[0].writeProtected && st.drives.every((d) => d.stored), JSON.stringify(st.drives));
    check("'disks' events for the cartridge and both mounts", events >= 2, String(events));
    const recentBefore = JSON.stringify(s.recentMedia());
    media.calls.length = 0;
    check('the writer firmware reaches HALT', runToHalt(s, halt));
    const l = log(s);
    // per drive: restore status, seek status and track, write status and count, read status and count, checksum
    const sum = pattern(0x11).reduce((a, v) => a + v, 0);
    check('firmware log: drive 0 at track 1, write status 00 with 256 bytes, read back 256 bytes with their checksum', l[2] === 1 && l[3] === 0 && l[4] === 1 && l[5] === 0 && l[6] === 0 && l[7] === 1 && l[8] === 0
      && ((l[9] << 8) | l[10]) === sum, Array.from(l).map((v) => v.toString(16)).join(' '));
    await s.diskWritesDone();
    const w0 = expectImage(d0, 12, 2, pattern(0x11)), w1 = expectImage(d1, 12, 1, pattern(0x22));
    check('drive 0: the stored image is the original with sector 3 of track 1 replaced', same(await media.read('disks/work.vdk'), w0));
    check('drive 1: the stored image is the original with its sector written', same(await media.read('disks/other.vdk'), w1));
    const writes = media.calls.filter((c) => c.m === 'write' || c.m === 'writeRange');
    // only the bytes that differ are sent: a pattern byte equal to the old one splits a sector into two ranges
    const inSector = (c, name, off) => c.name === name && c.offset >= off && c.offset + c.length <= off + 256;
    check('the store got only in-place range writes inside the written sectors, never the whole file', writes.length >= 2 && writes.every((c) => c.m === 'writeRange')
      && writes.every((c) => inSector(c, 'disks/work.vdk', sectorOffset(12, 2)) || inSector(c, 'disks/other.vdk', sectorOffset(12, 1)))
      && ['disks/work.vdk', 'disks/other.vdk'].every((n) => { const w = writes.filter((c) => c.name === n); return w.length > 0 && w.reduce((a, c) => a + c.length, 0) <= 256; }), JSON.stringify(writes));
    check('disk images never go through the media index (recent list and index names unchanged)', JSON.stringify(s.recentMedia()) === recentBefore
      && (await media.list('recent/')).length === 0 && (await media.list('roms/')).every((f) => !/vdk/.test(f.name)));
    const dl = await s.downloadDisk(0);
    check('downloadDisk(0): the written image, named as stored', dl.name === 'work.vdk' && same(dl.bytes, w0));
    // write-protect: set on drive 1, run again: nothing reaches the store and the firmware sees WP
    s.setDiskWriteProtect(1, true);
    check('setDiskWriteProtect shows in diskStatus', s.diskStatus().drives[1].writeProtected);
    s.powerCycle();
    // a power cycle keeps the cartridge and its disks, as on real hardware
    const ctl = s.diskController;
    check('a power cycle keeps the disk cartridge and its disks', !!ctl && s.diskController === ctl && s.diskStatus().drives.length === 2
      && s.diskStatus().drives[0].file === 'work.vdk' && s.diskStatus().drives[1].writeProtected, JSON.stringify(s.diskStatus().drives));
    await s.diskWritesDone();
    await s.mountDisk(0, 'work.vdk');
    await s.mountDisk(1, 'other.vdk', { writeProtected: true });
    const before1 = await media.read('disks/other.vdk');
    media.calls.length = 0;
    // the firmware writes the same bytes again on drive 0 (nothing changes) and is refused on drive 1
    check('second run reaches HALT', runToHalt(s, halt));
    await s.diskWritesDone();
    const l2 = log(s);
    // drive 1's entries start at 11: its write status (WRITE PROTECT, bit 6) and count at 14-16
    check('write-protected drive 1: the write sector ends at once with WRITE PROTECT and no byte taken', l2[14] === 0x40 && l2[15] === 0 && l2[16] === 0, Array.from(l2).map((v) => v.toString(16)).join(' '));
    check('write-protected drive 1: its stored image is unchanged', same(await media.read('disks/other.vdk'), before1));
    check('rewriting identical bytes sends nothing to the store', media.calls.filter((c) => c.m.startsWith('write')).length === 0, JSON.stringify(media.calls));

    // errors
    await rejects('the same image in two drives is refused', s.mountDisk(2, 'work.vdk'), /already in drive 0/);
    await rejects('a drive past 3 is refused', s.mountDisk(4, 'work.vdk'), /no drive 4/);
    await rejects('a disk that is not stored is reported', s.mountDisk(2, 'gone.vdk'), /gone\.vdk is no longer stored/);
    await rejects('bytes that are no disk image are refused before anything is stored', s.importDisk('notes.dsk', new Uint8Array(1000), 2), /not a disk image/);
    check('... and nothing was stored', !(await media.stat('disks/notes.dsk')));
    await rejects('a damaged VDK is refused', s.importDisk('bad.vdk', d0.slice(0, 1000), 2), /bad\.vdk/);
    await rejects('download from an empty drive', s.downloadDisk(3), /Drive 3 is empty/);
    await rejects('importing over the image another drive holds', s.importDisk('work.vdk', d0, 2), /work\.vdk is in drive 0/);

    // eject keeps the stored image; a write in flight when the machine changes still reaches the store
    await s.ejectDisk(1);
    check('ejectDisk empties the drive, the image stays stored', s.diskStatus().drives.length === 1 && !!(await media.stat('disks/other.vdk')));
    await s.importDisk('fresh.vdk', d1, 1);
    s.powerCycle();
    await s.ejectDisk(1);           // (a power cycle keeps the disks: fresh.vdk moves from drive 1 to drive 0)
    await s.mountDisk(0, 'fresh.vdk');
    await s.mountDisk(1, 'other.vdk');
    let f = 0;
    while (!s.diskController.drives[0].imageDirty && f < 600) { s.machine.runFrame(); f++; }
    check('mid-run: drive 0 holds written flux not yet committed (motor still on)', s.diskController.drives[0].imageDirty && s.machine.cpu.pc !== halt);
    // let the write finish its sector, then switch machines with the motor still running
    for (let i = 0; i < 3; i++) s.machine.runFrame();
    s.switchMachine('coco');
    await s.diskWritesDone();
    check('switching machines commits the old machine\'s disks to the store', same(await media.read('disks/fresh.vdk'), expectImage(d1, 12, 1, pattern(0x11))));
  }

  // ---------------- snapshots: the disks come back as the snapshot's own copies
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    await s.importDisk('snap.vdk', images.vdk(40, 2), 0);
    await s.importDisk('snap1.vdk', images.vdk(40, 1), 1);
    runToHalt(s, halt);
    const file = await s.snapshotFile();
    const snap = await s.readSnapshot(file.bytes);
    s.openSnapshot(snap);
    const st = s.diskStatus();
    check('after opening a snapshot the drives hold the snapshot\'s disks, not linked to the store', st.drives.length === 2 && st.drives[0].file === 'snap.vdk' && !st.drives[0].stored);
    const dl = await s.downloadDisk(0);
    check('... and Download gives the snapshot\'s image with the write in it', same(dl.bytes, expectImage(images.vdk(40, 2), 12, 2, pattern(0x11))));
    void media;
  }

  // ---------------- Delta DOS (Premier): its WD2791 stores the complement of what the CPU writes
  {
    const { s, media, halt } = session('dragon64', 'deltados', 'premier');
    check('Delta DOS is offered on the Dragon, after DragonDOS', s.diskDosChoices().map((c) => c.id).join() === 'dragondos,deltados' && s.diskDosChoices()[1].ready && !s.diskDosChoices()[0].ready);
    await s.importDisk('delta.vdk', images.vdk(40, 2), 0);
    await s.importDisk('delta1.vdk', images.vdk(40, 1), 1);
    check('the mount plugs in the cartridge whose ROM is stored (Premier FDC)', s.diskController.type === 'premierfdc');
    check('Premier writer reaches HALT', runToHalt(s, halt));
    await s.diskWritesDone();
    check('Delta: the stored sector holds the complement of the bytes written', same(await media.read('disks/delta.vdk'), expectImage(images.vdk(40, 2), 12, 2, pattern(0x11).map((v) => v ^ 0xff))));
  }

  // ---------------- CoCo, Disk BASIC cartridge, a JVC (.dsk) image
  {
    const { s, media, halt } = session('coco', 'rsdos', 'coco');
    const d0 = images.jvc(40, 2);
    await s.importDisk('coco.dsk', d0, 0);
    await s.importDisk('coco1.dsk', images.jvc(40, 1), 1);
    check('CoCo: the RS-DOS cartridge goes in', s.diskController.type === 'cocofdc' && s.diskStatus().dos.id === 'rsdos');
    check('CoCo writer reaches HALT', runToHalt(s, halt));
    await s.diskWritesDone();
    // JVC: a 2-byte header (18 sectors, 2 sides) on a double-sided image, then the sectors in order
    check('CoCo: the stored JVC image has the sector written', d0.length === 2 + 40 * 2 * 18 * 256 && same(await media.read('disks/coco.dsk'), expectImage(d0, 2, 2, pattern(0x11))));
  }

  // ---------------- the Dragon Alpha: its own disk interface, never a cartridge (alpha-write.asm as its boot ROM)
  {
    const media = spyStore();
    const s = new Emu.Session({ media });
    s.switchMachine('dgnalpha');
    const a = assembleFile(path.join(FDC, 'alpha-write.asm'), '6809');
    s.roms.put('dgnalpha', 'boot', romImage(a, 0xA000, 0x2000, 0x00), 'boot.rom');
    s.roms.put('dgnalpha', 'basic', new Uint8Array(0x4000).fill(0x12), 'basic.rom');
    s.roms.put('dragondos', 'rom', new Uint8Array(0x2000), 'ddos10.rom');   // a DOS ROM stored: still not used
    s.loadSavedRoms(); s.machine.reset(true);
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    check('Alpha: the only disk choice is the built-in interface', s.diskDosChoices().map((c) => c.id).join() === 'builtin' && s.diskStatus().dos.id === 'builtin' && s.driveCount === 2);
    await s.importDisk('alpha0.vdk', d0, 0);
    await s.importDisk('alpha1.vdk', d1, 1);
    check('Alpha: mounting uses the built-in drives; no cartridge goes in', s.machine.cartPort === null && s.diskController === s.machine.fdc && s.diskStatus().drives.length === 2);
    await rejects('Alpha: drive 2 is not fitted', s.importDisk('x.vdk', d1, 2), /no drive 2 \(drives 0 to 1\)/);
    await rejects('Alpha: insertDiskDos is refused, the interface is built in', Promise.resolve().then(() => s.insertDiskDos('builtin')), /built in/);
    await rejects('Alpha: a DragonDOS cartridge is not offered', Promise.resolve().then(() => s.insertDiskDos('dragondos')), /can't take the DragonDOS/);
    let lit = false;
    const halt = a.symbols.get('HALT');
    for (let f = 0; f < 600 && s.machine.cpu.pc !== halt; f++) { s.machine.runFrame(); if (s.diskActivity()[0]) lit = true; }
    check('Alpha: the write firmware reaches HALT', s.machine.cpu.pc === halt);
    check('the drive light comes on while drive 0 works, and is off once the firmware stops', lit && !s.diskActivity().some(Boolean));
    s.flushDisks();
    await s.diskWritesDone();
    check('Alpha: the stored image has the sector the firmware wrote', same(await media.read('disks/alpha0.vdk'), expectImage(d0, 12, 2, pattern(0x11))));
    check('Alpha: drive 1 too', same(await media.read('disks/alpha1.vdk'), expectImage(d1, 12, 1, pattern(0x22))));
    s.powerCycle();
    check('Alpha: a power cycle keeps the disks in the built-in drives', s.diskStatus().drives.length === 2);
  }

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
    check('Alpha: a new disk goes into its built-in drive, no cartridge', am === 'New blank disk: disk-1.vdk in drive 1' && al.machine.cartPort === null && al.diskController === al.machine.fdc
      && al.diskStatus().drives[0].drive === 1 && al.diskStatus().drives[0].size === 12 + 80 * 2 * 4608, am);
    await rejects('Alpha: no new disk in drive 2 (two drives fitted)', al.newDisk(2, { format: 'vdk', tracks: 80, heads: 2 }), /no drive 2/);
    const mc = new Emu.Session({ media: spyStore() });
    mc.switchMachine('mc10');
    check('the MC-10 offers no new disk', mc.blankDiskChoices().length === 0);
    await rejects('newDisk on the MC-10: no drives', mc.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }), /no disk drives/);
  }
  // ---------------- a disk controller in a Multi-Pak's slot (MAME -ext multi, run.js --fdc --multi)
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    const pak = { name: 'game.rom', bytes: new Uint8Array(0x4000).map((_, i) => (i * 5 + 1) & 0xff) };
    const msg = s.insertMultiPak([pak, null, null, { dos: 'dragondos' }]);
    const mp = s.machine.cartPort;
    check('Multi-Pak: a DragonDOS controller in slot 4 next to a Program Pak in slot 1', mp.type === 'multi' && mp.cart(1).type === 'rom' && mp.cart(4).type === 'dragonfdc'
      && /Multi-Pak \(1: game\.rom, 2: empty, 3: empty, 4: DragonDOS cartridge\)/.test(msg), msg);
    check('Multi-Pak: the drives use the controller in the slot', s.diskController === mp.cart(4) && s.diskStatus().dos.id === 'dragondos' && s.driveCount === 4);
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    await s.importDisk('mp0.vdk', d0, 0);
    await s.importDisk('mp1.vdk', d1, 1);
    check('Multi-Pak: mounting keeps the Multi-Pak in the port (no DOS cartridge replaces it)', s.machine.cartPort === mp && s.diskStatus().drives.length === 2);
    check('Multi-Pak: the writer firmware (the DOS ROM in slot 4, the switch on slot 4) reaches HALT', runToHalt(s, halt));
    s.flushDisks();
    await s.diskWritesDone();
    check('Multi-Pak: the stored images have the sectors the firmware wrote', same(await media.read('disks/mp0.vdk'), expectImage(d0, 12, 2, pattern(0x11)))
      && same(await media.read('disks/mp1.vdk'), expectImage(d1, 12, 1, pattern(0x22))));
    await rejects('Multi-Pak: two disk controllers are refused', Promise.resolve().then(() => s.insertMultiPak([{ dos: 'dragondos' }, null, null, { dos: 'dragondos' }])), /one disk controller/);
    await rejects('Multi-Pak: a controller of another family is refused', Promise.resolve().then(() => s.insertMultiPak([null, null, null, { dos: 'rsdos' }])), /slot 4: the Dragon 64 can't take the Disk BASIC/);
    await rejects('Multi-Pak: a controller without its ROM is refused, naming the ROM', Promise.resolve().then(() => s.insertMultiPak([null, null, null, { dos: 'deltados' }])), /slot 4: the Delta DOS cartridge needs its ROM \(deltados\.rom\)/);
    check('Multi-Pak: after the refusals the first Multi-Pak is still in', s.machine.cartPort === mp);
    s.insertMultiPak([pak, null, null, null]);
    await rejects('Multi-Pak: with no controller in it, a mount is refused rather than replacing the Multi-Pak', s.importDisk('mp2.vdk', d1, 0), /The Multi-Pak has no disk controller/);
    check('... and the Multi-Pak stays in the port', s.machine.cartPort.type === 'multi' && s.diskController === null);
  }
  {
    // the CoCo: Disk BASIC's controller in slot 2 with the switch on slot 2 (MAME offers slot 4 only; the Multi-Pak
    // routes SCS and CTS to every slot alike)
    const { s, media, halt } = session('coco', 'rsdos', 'coco');
    s.insertMultiPak([null, { dos: 'rsdos' }, null, null], { switchSlot: 2 });
    check('Multi-Pak (CoCo): the controller in slot 2', s.diskController === s.machine.cartPort.cart(2) && s.diskStatus().dos.id === 'rsdos');
    const d0 = images.jvc(40, 2);
    await s.importDisk('mpcoco.dsk', d0, 0);
    await s.importDisk('mpcoco1.vdk', images.vdk(40, 1), 1);
    check('Multi-Pak (CoCo): the writer firmware reaches HALT from slot 2', runToHalt(s, halt));
    s.flushDisks();
    await s.diskWritesDone();
    check('Multi-Pak (CoCo): the stored JVC image has the sector written', same(await media.read('disks/mpcoco.dsk'), expectImage(d0, 2, 2, pattern(0x11))));
  }

  // ---------------- a dropped DOS ROM is a ROM, not a program cartridge
  check('ddos10.rom, deltados.rom and disk11.rom are taken as ROM images (by their usual names)', ['ddos10.rom', 'deltados.rom', 'disk11.rom'].every((n) => Emu.Session.isRom(n, new Uint8Array(0x2000).fill(1)))
    && !Emu.Session.isRom('game.rom', new Uint8Array(0x2000).fill(1)));

  // ---------------- no ROM, no drives
  {
    const { s } = session('dragon64', null, 'dragon');
    await rejects('without a DOS ROM the mount says which ROM is needed', s.importDisk('x.vdk', images.vdk(40, 1), 0), /DragonDOS cartridge \(ddos10\.rom\) or Delta DOS cartridge \(deltados\.rom\)/);
    await rejects('insertDiskDos without its ROM', Promise.resolve().then(() => s.insertDiskDos('dragondos')), /needs its ROM \(ddos10\.rom\)/);
    await rejects('a CoCo cartridge on the Dragon is refused', Promise.resolve().then(() => s.insertDiskDos('rsdos')), /can't take the Disk BASIC/);
    s.switchMachine('mc10');
    await rejects('the MC-10 has no disk drives', s.importDisk('x.vdk', images.vdk(40, 1), 0), /no disk drives/);
    check('loading a disk image as a program says it goes in a drive', (() => { try { s.load('x.vdk', images.vdk(40, 1)); return false; } catch (e) { return /go in a disk drive/.test(e.message); } })());
  }

  // ---------------- a store that refuses the write: reported once by diskWritesDone
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    await s.importDisk('full.vdk', images.vdk(40, 2), 0);
    await s.importDisk('full1.vdk', images.vdk(40, 1), 1);
    media.writeRange = () => Promise.reject(new MediaStoreError('quota', 'no space'));
    let errEvent = false;
    s.on((e) => { if (e === 'diskerror') errEvent = true; });
    runToHalt(s, halt);
    await s.diskWriting;      // the chain settles (its error is kept for diskWritesDone)
    check('the drive is marked unsaved with the reason, before diskWritesDone is asked', /space|quota/i.test(s.diskStatus().drives[0].unsaved || ''), String(s.diskStatus().drives[0].unsaved));
    await rejects('a refused disk write is reported by diskWritesDone', s.diskWritesDone(), /space|quota|full\.vdk/i);
    check("... with a 'diskerror' event", errEvent);
    // reported once: the error is cleared, so the next call resolves (and the refused write left the image as it was)
    let second = 'resolved';
    try { await s.diskWritesDone(); } catch (e) { second = `rejected: ${e.message}`; }
    check('... once: the next diskWritesDone() resolves', second === 'resolved', second);
    check('... and the stored image is the one imported (the refused write did not land)', same(await media.read('disks/full.vdk'), images.vdk(40, 2)));
    check('both drives stay marked unsaved after the error is reported (their changes are still only in the drives)', s.diskStatus().drives.every((d) => !!d.unsaved));
    await s.ejectDisk(0);
    await s.mountDisk(0, 'full.vdk');
    check('mounting the image again from the store clears the mark', s.diskStatus().drives.find((d) => d.drive === 0).unsaved === null);
  }

  // ---------------- mountDisk's read-again limit counts changes to the image being read
  // (another drive writing its own disk while the mount reads must not make a valid mount fail after 4 tries)
  {
    const { s, media } = session('dragon64', 'dragondos', 'dragon');
    await s.importDisk('a.vdk', images.vdk(40, 2), 0);
    await s.importDisk('b.vdk', images.vdk(40, 1), 1);
    await s.ejectDisk(0);                 // drive 0 free for the mount below; drive 1 keeps its disk
    const d1 = s.diskController.drives[1];
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // a slow store: the mount waits long enough for drive 1 to hand over 60 changes (far more than 4)
    const realStat = media.stat.bind(media), realRange = media.readRange.bind(media), realRangeW = media.writeRange.bind(media);
    let readsOfA = 0;
    media.stat = async (name) => { await sleep(8); return realStat(name); };
    media.readRange = async (name, ...a) => { if (name === 'disks/a.vdk') readsOfA++; await sleep(8); return realRange(name, ...a); };
    media.writeRange = async (...a) => { await sleep(4); return realRangeW(...a); };
    // the mount starts first and parks inside its wait on the slow store; drive 1 then writes its OWN disk
    // continuously, each change queued (and landing) while the mount is still waiting for its read
    const pending = s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
    let foreign = 0, foreignInFlight = 0;
    const pump = (async () => {
      for (let i = 0; i < 60; i++) {
        d1.media.onWrite(0x100 + 0x40 * (i % 2000), new Uint8Array([0x5A]), d1.media.bytes.length);
        foreign++;
        if (s.diskQueued > s.diskLanded) foreignInFlight++;
        await sleep(1);
      }
    })();
    const msg = await pending;
    await pump;
    await s.diskWritesDone().catch(() => {});
    const d0 = s.diskController.drives[0], storedA = await media.read('disks/a.vdk'), storedB = await media.read('disks/b.vdk');
    check('setup: drive 1\'s changes were queued while the mount was waiting (so this test exercises that case)',
      foreignInFlight >= 4, `${foreignInFlight} of ${foreign} queued mid-wait`);
    check('a mount while drive 1 writes its own disk throughout: it mounts (the session saw many changes, no false "kept writing")',
      msg === 'a.vdk in drive 0' && d0.loaded && same(d0.media.bytes, storedA), msg instanceof Error ? msg.message : msg);
    // the mount had nothing to wait for again: it read the image once (another drive's changes are not its own)
    check('... having read the image once (it did not repeat its read for the other drive\'s changes)', readsOfA === 1, `reads=${readsOfA}`);
    check('... and drive 1\'s changes are all in its own image',
      Array.from({ length: 60 }, (_, i) => storedB[0x100 + 0x40 * (i % 2000)]).every((v) => v === 0x5A),
      Array.from({ length: 60 }, (_, i) => storedB[0x100 + 0x40 * (i % 2000)]).filter((v) => v === 0x5A).length + '/60');
    check('... and the mounted image is the one it was stored as (drive 1\'s writes reached it nowhere)',
      same(storedA, images.vdk(40, 2)));
    media.stat = realStat; media.readRange = realRange; media.writeRange = realRangeW;
    // while the image being read keeps changing (a change to IT through every read), the mount still gives up.
    // A link of that name is exactly a drive's own queued change to it, so every read sees another change.
    await s.ejectDisk(0);
    const sameDrive = s.diskController.drives[0];
    const link = s.diskLink('disks/a.vdk');
    let n2 = 0;
    const realStat2 = media.stat.bind(media);
    media.stat = async (name) => {
      if (name === 'disks/a.vdk' && n2 < 10) { n2++; link(0x200, new Uint8Array([0x40 + n2]), sameDrive.media ? sameDrive.media.bytes.length : 0); }
      return realStat2(name);
    };
    const again = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
    media.stat = realStat2;
    check('when the image being read keeps changing on every read the mount still gives up (it does not retry forever)',
      again instanceof Emu.SessionError && /kept writing while it was read; try again/.test(again.message), again instanceof Error ? again.message : String(again));
    check('... after 4 reads (the first and three more: the same limit as before)', n2 === 4, String(n2));
  }

  // ---------------- a change to the image the mount reads, made through the Library, names that image
  // (a rename onto it, an import over it, a delete of it, and a write under another CASE spelling of it): each must
  // make the mount re-read, or fail clearly. This pins the names the diskStoreChange call sites pass.
  {
    // wraps readRange for `image`: counts reads, and after the first one has returned runs `during()` (which queues
    // a Library change) before letting the mount go on, so the change lands while the mount is still inside its read
    const raceFirstRead = (media, image, during) => {
      const real = media.readRange.bind(media);
      let reads = 0;
      media.readRange = async (name, ...a) => {
        const out = await real(name, ...a);
        if (name === image && ++reads === 1 && during) await during();
        return out;
      };
      return () => reads;
    };
    const setup = async () => {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('x.vdk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);                        // drive 0 free for the mount
      return { s, media };
    };
    // a rename onto the mounted name. The name has to be free for the rename to happen at all, so inside the race
    // x.vdk is removed from the store directly (a Library delete would be a change to x and would be noticed by its
    // own tag) and y.vdk is then renamed onto it through the Library. The only disk change QUEUED during the read is
    // that rename, and it names 'disks/x.vdk' only as the destination: tag it [src] alone and nothing is numbered
    // for 'disks/x.vdk' while the mount reads, so the mount returns the stale image.
    {
      const { s, media } = await setup();
      const y = images.vdk(40, 1);
      await s.importDisk('y.vdk', y, 1); await s.ejectDisk(1);
      let renamed = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => {
        await media.remove('disks/x.vdk');
        renamed = await s.renameMedia('disks/y.vdk', 'disks/x.vdk').then(() => 'ok', (e) => e.message);
      });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0];
      check('a rename onto the image being mounted: the mount reads again and holds the renamed image (not the stale one)',
        renamed === 'ok' && reads() === 2 && d.loaded && same(d.media.bytes, y) && same(d.media.bytes, await media.read('disks/x.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads()}; rename=${renamed}`);
    }
    // an import over the mounted name
    {
      const { s, media } = await setup();
      const fresh = images.vdk(40, 1); fresh.fill(0x77, 0x2000, 0x2100);
      let imported = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => { imported = await s.importMedia('disks/x.vdk', fresh).then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0];
      check('an import over the image being mounted: the mount reads again and holds the imported bytes',
        reads() === 2 && d.loaded && same(d.media.bytes, fresh), `${out instanceof Error ? out.message : out}; reads=${reads()}; import=${imported}`);
    }
    // importDisk over the image being mounted (into another drive): its write is tagged with the image's name, so
    // the mount reading meanwhile reads again and holds the imported bytes. The import's own mount then finds the
    // image in drive 0 and says so. The hook returns once the import's write has started in the disk queue (the
    // store's write is called), so the change is counted but has not landed when the mount decides.
    {
      const { s, media } = await setup();
      const fresh = images.vdk(40, 2); fresh.fill(0x6E, 0x2000, 0x2100);
      const realWrite = media.write.bind(media);
      let started = null; const writeStarted = new Promise((res) => { started = res; });
      media.write = (name, ...a) => { if (name === 'disks/x.vdk') started(); return realWrite(name, ...a); };
      let imported = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => {
        imported = s.importDisk('x.vdk', fresh, 1).then(() => 'ok', (e) => e.message);
        await writeStarted;
      });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      const importResult = await imported;
      media.write = realWrite;
      const d = s.diskController.drives[0];
      check('importDisk over the image being mounted: the mount reads again and holds the imported bytes',
        out === 'x.vdk in drive 0' && d.loaded && same(d.media.bytes, fresh) && same(fresh, await media.read('disks/x.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads()} (the import's own mount reads it too)`);
      check('... and the import says it was saved but is in drive 0, not put in drive 1',
        /x\.vdk was saved to your Library but not put in drive 1: .*already in drive 0/.test(String(importResult)) && !s.diskController.drives[1].loaded,
        String(importResult));
    }
    // The count is taken BEFORE the mount waits for the queued writes. Another file's write (W1) is held in the
    // store, so the mount's wait is still open when a write to this image (W2) is queued; W2 is held until the
    // mount's first read has returned. The mount must count W2 as a change under its read and read again; a count
    // taken after the wait would already include W2 and keep the bytes from before it.
    {
      const { s, media } = await setup();
      const x = await media.read('disks/x.vdk');
      await s.importDisk('y.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      const realRange = media.writeRange.bind(media);
      const gate = () => { let open; const p = new Promise((res) => { open = res; }); return { p, open }; };
      const g1 = gate(), g2 = gate();
      let w1Started = null; const w1 = new Promise((res) => { w1Started = res; });
      media.writeRange = async (name, ...a) => {
        if (name === 'disks/y.vdk') { w1Started(); await g1.p; }
        if (name === 'disks/x.vdk') await g2.p;
        return realRange(name, ...a);
      };
      s.diskLink('disks/y.vdk')(0x100, new Uint8Array([0x11]), 12 + 40 * 1 * 18 * 256);   // W1, held
      await w1;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => { g2.open(); });
      const pending = s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);   // counts, then waits on W1
      s.diskLink('disks/x.vdk')(0x800, new Uint8Array([0x99]), x.length);  // W2, queued during that wait
      g1.open();
      const out = await pending;
      media.writeRange = realRange;
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/x.vdk');
      check('a write to the image queued while the mount waits for earlier writes: the mount reads again and holds it',
        out === 'x.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x800] === 0x99 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The drive is flushed again after the read. The image is in drive 0 already and mounted there again; while the
    // store is read, the machine writes to that drive (our writer firmware), and it is stopped as soon as drive 0
    // holds written data, before the firmware stops the motor (which would commit it on its own). Those writes sit in
    // the drive until flushed: the flush after the read hands them to the store as changes to this image, so the
    // mount reads again and holds them. Without it they would only be handed over when the drive is emptied for the
    // new mount, after the decision, and the drive would hold the bytes from before.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
      await s.importDisk('p0.vdk', d0, 0);
      await s.importDisk('p1.vdk', d1, 1);
      const drive0 = s.diskController.drives[0];
      let dirty = false;
      const reads = raceFirstRead(media, 'disks/p0.vdk', async () => {
        for (let f = 0; f < 600 && !drive0.imageDirty; f++) s.machine.runFrame();
        dirty = drive0.imageDirty;
      });
      const out = await s.mountDisk(0, 'p0.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/p0.vdk');
      check('the machine writes the drive (not yet committed) while it is mounted again: the flush after the read makes the mount read again and hold those writes',
        dirty && out === 'p0.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && !same(stored, d0),
        `${out instanceof Error ? out.message : out}; dirty=${dirty}; reads=${reads()}`);
    }
    // a delete of the very image being mounted: the re-read finds it gone, so the mount fails clearly
    {
      const { s, media } = await setup();
      await s.importDisk('w.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      let deleted = null;
      raceFirstRead(media, 'disks/x.vdk', async () => { deleted = await s.deleteMedia('disks/x.vdk').then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      check('a delete of the very image being mounted: the mount fails clearly rather than holding a deleted image',
        out instanceof Emu.SessionError && /x\.vdk is no longer stored/.test(out.message) && !s.diskController.drives[0].loaded,
        `${out instanceof Error ? out.message : out}; delete=${deleted}`);
    }
    // a rename AWAY from the mounted name (the source name): the mount must notice that too, and the re-read then
    // finds the name gone, so it fails clearly. Pins the [src] half of the rename's names.
    {
      const { s, media } = await setup();
      let away = null;
      raceFirstRead(media, 'disks/x.vdk', async () => { away = await s.renameMedia('disks/x.vdk', 'disks/moved.vdk').then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      check('a rename AWAY from the image being mounted: the mount re-reads, finds it gone and fails clearly',
        away === 'ok' && out instanceof Emu.SessionError && /x\.vdk is no longer stored/.test(out.message) && !s.diskController.drives[0].loaded,
        `${out instanceof Error ? out.message : out}; rename=${away}`);
    }
    // a distinct file whose name differs only in case must NOT be able to fail the mount, nor keep it re-reading:
    // on a case-sensitive store disks/WORK.DSK and disks/work.DSK are two files, and the mount follows the store's
    // rule (Session.sameName). The writer is not bound: it writes on every read the mount makes, so the mount has to
    // stop on the store's rule, not on the writer going quiet.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('work.DSK', images.vdk(40, 2), 0);
      await s.importDisk('WORK.DSK', images.vdk(40, 1), 1);
      await s.ejectDisk(0);
      const other = s.diskController.drives[1];
      let reads = 0;
      const realRange = media.readRange.bind(media);
      // while the mount reads its own file, drive 1 keeps writing the OTHER file (which folds to the same key)
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.DSK') {
          reads++;
          other.media.onWrite(0x100 + 0x10 * reads, new Uint8Array([0x5A]), other.media.bytes.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.DSK').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0];
      check('another file whose name folds to the same key writes throughout: the mount still mounts (its budget is its own name\'s)',
        out === 'work.DSK in drive 0' && d.loaded,
        `${out instanceof Error ? out.message : out}; reads=${reads}`);
      check('... having read once: on this store the other spelling is a separate file, so nothing was re-read',
        reads === 1, `reads=${reads}`);
      check('... and it holds its own image (the other file\'s writes reached it nowhere)',
        !!d.media && same(d.media.bytes, images.vdk(40, 2)), d.loaded ? 'the mounted image is not the one stored for this name' : 'not mounted');
    }
    // the same, with the roles swapped: mount the ALREADY-lower-case name while drive 1 keeps writing the upper-case
    // one (a count kept under the lower-cased name would put the other file's writes on this mount's budget).
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('WORK.DSK', images.vdk(40, 1), 1);
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      const other = s.diskController.drives[1];
      let reads = 0;
      const realRange = media.readRange.bind(media);
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk') {
          reads++;
          other.media.onWrite(0x100 + 0x10 * reads, new Uint8Array([0x5A]), other.media.bytes.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0];
      check('mounting the lower-case name while the other file\'s spelling folds onto it is written throughout: it still mounts',
        out === 'work.dsk in drive 0' && d.loaded, `${out instanceof Error ? out.message : out}; reads=${reads}`);
      check('... having read once (the two spellings are two stored files here)', reads === 1, `reads=${reads}`);
      check('... and it holds its own image (the other file\'s writes reached it nowhere)',
        !!d.media && same(d.media.bytes, images.vdk(40, 2)), d.loaded ? 'the mounted image is not the one stored for this name' : 'not mounted');
    }
    // A store that holds both spellings as ONE file (a File System Access folder on macOS or Windows; here
    // MemoryMediaStore({ caseInsensitive: true })): the other spelling IS this file, so its writes are this image's
    // changes and spend the mount's budget: without let-up the mount gives up after four reads, clearly and bounded.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      let reads = 0;
      const realRange = media.readRange;
      // each read of the image is followed by a write to it under the OTHER spelling (the link names WORK.DSK). The
      // writer stops after 20 writes so the test stays bounded even if the limit is removed.
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk' && reads < 20) {
          reads++;
          const cur = await media.read('disks/work.dsk');
          s.diskLink('disks/WORK.DSK')(0x100, new Uint8Array([reads & 0xFF]), cur.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      check('a case-insensitive store whose image keeps changing under another spelling: the mount gives up clearly',
        out instanceof Emu.SessionError && /kept writing while it was read; try again/.test(out.message),
        out instanceof Error ? out.message : String(out));
      check('... after 4 reads (the first and three more: one limit, because these are this image\'s own writes)',
        reads === 4, `reads=${reads}`);
      check('... and nothing was mounted', !s.diskController.drives[0].loaded);
    }
    // A write under the other spelling that is STILL LANDING when the read returns must not be missed (a case-
    // insensitive store). Pass 1 has a byte-neutral rewrite (a byte comparison would be fooled by it); pass 2's
    // real write is queued as that read finishes, so the mount must count it rather than look at bytes.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      let reads = 0;
      const realRange = media.readRange;
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk') {
          reads++;
          if (reads === 1) {
            const cur = await media.read('disks/work.dsk');
            s.diskLink('disks/WORK.DSK')(0x100, cur.slice(0x100, 0x104), cur.length);
            await s.diskWritesDone().catch(() => {});
          } else if (reads === 2) {
            s.diskLink('disks/WORK.DSK')(0x400, new Uint8Array([0x77, 0x77, 0x77, 0x77]), (await media.stat('disks/work.dsk')).size);
          }
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0], stored = await media.read('disks/work.dsk');
      check('a write under another spelling that lands after the read returns is not missed (case-insensitive store)',
        out === 'work.dsk in drive 0' && d.loaded && !!d.media && d.media.bytes[0x400] === 0x77 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads}; mounted=${d.loaded}${d.media ? `; byte=${d.media.bytes[0x400]}` : ''}`);
    }
    // The one rule, both ways: mounting a.vdk while A.vdk is written during the read. On a case-sensitive store A.vdk
    // is another file: the mount never re-reads and holds a.vdk as stored. On a case-insensitive one it is this very
    // file: the mount re-reads and holds the current bytes.
    for (const caseInsensitive of [false, true]) {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      if (!caseInsensitive) { await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1); }
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      const held = d.loaded && same(d.media.bytes, stored);
      if (!caseInsensitive) {
        check('case-sensitive store: a write to A.vdk during a.vdk\'s mount does not re-read it, and the drive holds a.vdk as stored',
          out === 'a.vdk in drive 0' && reads() === 1 && held && same(stored, a) && (await media.read('disks/A.vdk'))[0x300] === 0x5A,
          `${out instanceof Error ? out.message : out}; reads=${reads()}`);
      } else {
        check('case-insensitive store: a write to A.vdk during a.vdk\'s mount re-reads it, and the drive holds the current bytes',
          out === 'a.vdk in drive 0' && reads() === 2 && held && stored[0x300] === 0x5A,
          `${out instanceof Error ? out.message : out}; reads=${reads()}`);
      }
    }
    // Review finding 1: a write to the image's own name queued in the window after the read returns and before the
    // mount decides (nothing awaited: it is still landing) must be seen, so the drive gets the new bytes. Both stores.
    for (const caseInsensitive of [false, true]) {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/a.vdk')(0x500, new Uint8Array([0x66]), a.length);   // queued, not waited for
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check(`an own-name write queued as the read returns is not missed: the drive holds the new bytes (${caseInsensitive ? 'case-insensitive' : 'case-sensitive'} store)`,
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x500] === 0x66 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The reviewer's finding 1 probe, as it was found: on a case-sensitive store another spelling changes during the
    // read, and an own-name write is queued the moment the store is listed (the mount used to list the store, after
    // its change check, to ask whether the two spellings were one file). Whatever the mount does in that window, the
    // drive must end up holding the image as stored once every write has landed, not the bytes from before.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: false } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1);
      const realList = media.list.bind(media);
      let injected = false;
      media.list = async (...x) => {
        if (!injected) { injected = true; s.diskLink('disks/a.vdk')(0x700, new Uint8Array([0x3C]), a.length); }
        return realList(...x);
      };
      raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      media.list = realList;
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('finding 1 probe: an own-name write in the window after the change check does not leave the drive on stale bytes',
        out === 'a.vdk in drive 0' && d.loaded && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; injected=${injected}; drive[0x700]=${d.loaded ? d.media.bytes[0x700] : '-'}; stored[0x700]=${stored[0x700]}`);
    }
    // Review finding 3: on a case-sensitive store the mount's own name AND a separate other spelling both change in
    // one read. The other file is not this image, but its own change is: it must re-read and hold the new bytes.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: false } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        s.diskLink('disks/a.vdk')(0x600, new Uint8Array([0x44]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('case-sensitive store, own name and another spelling both written in one read: the mount re-reads and holds the new bytes',
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && stored[0x600] === 0x44 && stored[0x300] !== 0x5A,
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // FAIL SAFE on a store whose rule is not measured: its measurement finds nothing to put the question with (it
    // lists nothing to measure), so the Session takes it as case-insensitive (main's rule, js/host/media-store.js
    // detectCase). The mount must then re-read on another spelling's write, and the drive must hold what is stored,
    // whether the store in fact folds (the write was to this image: the re-read is what gets it) or not.
    class UnmeasuredStore extends MemoryMediaStore {
      constructor(fold) { super(); this._fold = fold; this.declaresCase = false; this.caseInsensitive = null; }
      get synchronous() { return false; }
      key(name) { return this._fold ? name.toLowerCase() : name; }
      async _listing() { return []; }   // the measurement's own listing: nothing to ask about, so never measured
    }
    for (const fold of [true, false]) {
      const media = new UnmeasuredStore(fold);
      const s = new Emu.Session({ media });
      await s.ready();                       // the index of an asynchronous store loads first, then the ROMs go in
      putRoms(s, 'dragon64', 'dragondos', 'dragon');
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      if (!fold) await media.write('disks/A.vdk', images.vdk(40, 2));
      check(`setup: the store's rule is unmeasured and the Session takes it as case-insensitive (store ${fold ? 'folds' : 'keeps spellings apart'})`,
        media.caseMeasured !== true && s.caseInsensitive === true);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check(`unmeasured store (${fold ? 'in fact folds' : 'in fact keeps spellings apart'}): another spelling's write re-reads, and the drive holds the stored bytes`,
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && (stored[0x300] === 0x5A) === fold,
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The rule is taken once per pass. Here the store is unmeasured when the mount counts (so A.vdk's earlier change
    // counts as this image's), is measured case-sensitive during the read, and the image's own name changes once in
    // that read. Summed by one rule the counts differ and the mount reads again; summed by the rule before and the
    // rule after, A.vdk's one earlier change and the own one cancel out and the mount would keep the old bytes.
    {
      const media = new UnmeasuredStore(false);
      let measurable = false;
      media._listing = async (prefix) => (measurable ? MemoryMediaStore.prototype.list.call(media, prefix) : []);
      const s = new Emu.Session({ media });
      await s.ready();
      putRoms(s, 'dragon64', 'dragondos', 'dragon');
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await media.write('disks/A.vdk', images.vdk(40, 2));
      s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
      await s.diskWritesDone();
      const unmeasured = s.caseInsensitive === true && media.caseMeasured !== true;
      let measured = null;
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        measurable = true;
        measured = await s.refreshCase();
        s.diskLink('disks/a.vdk')(0x900, new Uint8Array([0x42]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('the store is measured case-sensitive during the read and the image changes once: the mount still reads again (one rule per pass)',
        unmeasured && measured === false && out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x900] === 0x42 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; unmeasured=${unmeasured}; measured=${measured}; reads=${reads()}`);
    }
    // mounting under UPPER case while the write comes in lower case, on a case-insensitive store: the mount re-reads
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('upper.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      let reads = 0;
      const realRange = media.readRange;
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/UPPER.vdk' && ++reads === 1) {
          s.diskLink('disks/upper.vdk')(0x300, new Uint8Array([0x5A]), 12 + 40 * 1 * 18 * 256);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'disks/UPPER.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0];
      check('mounting under UPPER case, a change queued under lower case: the mount re-reads (case-insensitive store)',
        reads === 2 && d.loaded && d.media.bytes[0x300] === 0x5A && same(d.media.bytes, await media.read('disks/upper.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads}`);
    }
  }

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
