// Floppy disks through the Session, part 1 of 4 (parts 2-4: disks-mount-race, disks-mount-case and disks-newdisk
// .test.js; the shared fixtures are in disks-common.js). On the MediaStore: disk images stored under disks/,
// mounted with readRange, written back with writeRange (only the bytes that changed), never through the media
// index; up to four drives, write-protect, download, the disk cartridge plugged in on the first mount, and the
// errors a user can run into. The machine runs our own firmware (tools/mame-diff/fdc/<board>-write.asm, from
// gen-diag.js) in place of BASIC and the DOS ROM: it writes sector 3 of track 1 on drives 0 and 1 with
// $11 + 3i and $22 + 3i, reads it back and stops the motor. The expected images are built here from
// tools/mame-diff/fdc/images.js and the sector's offset in the format, not by running the code under test.
const { Emu, images, MediaStoreError, FDC, writer, pattern, sectorOffset, expectImage, same, spyStore, session, runToHalt, log, path, assembleFile, romImage, checker } = require('./disks-common');
const { check, rejects, failures } = checker();

(async () => {
  // ---------------- Dragon 64, DragonDOS cartridge, two VDK disks
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    let events = 0;
    s.on((e) => { if (e === 'disks') events++; });
    check('no disk cartridge before the first mount', s.drives.status().dos === null && s.drives.controller === null);
    const msg = await s.drives.importImage('work.vdk', d0, 0);
    check('importDisk stores the image under disks/ and mounts it in drive 0', msg === 'work.vdk in drive 0' && !!(await media.stat('disks/work.vdk')), msg);
    check('the first mount plugs in the DragonDOS cartridge (the controller for the ROM stored)', s.drives.controller && s.drives.controller.type === 'dragonfdc' && s.drives.status().dos.id === 'dragondos');
    check('the mount read the image with readRange, all of it', media.calls.some((c) => c.m === 'readRange' && c.name === 'disks/work.vdk' && c.offset === 0 && c.length === d0.length));
    await s.drives.importImage('other.vdk', d1, 1);
    const st = s.drives.status();
    check('diskStatus: two drives with their names, sizes, not write-protected, linked to the store', st.drives.length === 2 && st.drives[0].file === 'work.vdk' && st.drives[1].file === 'other.vdk'
      && st.drives[0].size === d0.length && !st.drives[0].writeProtected && st.drives.every((d) => d.stored), JSON.stringify(st.drives));
    check("'disks' events for the cartridge and both mounts", events >= 2, String(events));
    const recentBefore = JSON.stringify(s.library.recentMedia());
    media.calls.length = 0;
    check('the writer firmware reaches HALT', runToHalt(s, halt));
    const l = log(s);
    // per drive: restore status, seek status and track, write status and count, read status and count, checksum
    const sum = pattern(0x11).reduce((a, v) => a + v, 0);
    check('firmware log: drive 0 at track 1, write status 00 with 256 bytes, read back 256 bytes with their checksum', l[2] === 1 && l[3] === 0 && l[4] === 1 && l[5] === 0 && l[6] === 0 && l[7] === 1 && l[8] === 0
      && ((l[9] << 8) | l[10]) === sum, Array.from(l).map((v) => v.toString(16)).join(' '));
    await s.drives.writesDone();
    const w0 = expectImage(d0, 12, 2, pattern(0x11)), w1 = expectImage(d1, 12, 1, pattern(0x22));
    check('drive 0: the stored image is the original with sector 3 of track 1 replaced', same(await media.read('disks/work.vdk'), w0));
    check('drive 1: the stored image is the original with its sector written', same(await media.read('disks/other.vdk'), w1));
    const writes = media.calls.filter((c) => c.m === 'write' || c.m === 'writeRange');
    // only the bytes that differ are sent: a pattern byte equal to the old one splits a sector into two ranges
    const inSector = (c, name, off) => c.name === name && c.offset >= off && c.offset + c.length <= off + 256;
    check('the store got only in-place range writes inside the written sectors, never the whole file', writes.length >= 2 && writes.every((c) => c.m === 'writeRange')
      && writes.every((c) => inSector(c, 'disks/work.vdk', sectorOffset(12, 2)) || inSector(c, 'disks/other.vdk', sectorOffset(12, 1)))
      && ['disks/work.vdk', 'disks/other.vdk'].every((n) => { const w = writes.filter((c) => c.name === n); return w.length > 0 && w.reduce((a, c) => a + c.length, 0) <= 256; }), JSON.stringify(writes));
    check('disk images never go through the media index (recent list and index names unchanged)', JSON.stringify(s.library.recentMedia()) === recentBefore
      && (await media.list('recent/')).length === 0 && (await media.list('roms/')).every((f) => !/vdk/.test(f.name)));
    const dl = await s.drives.download(0);
    check('downloadDisk(0): the written image, named as stored', dl.name === 'work.vdk' && same(dl.bytes, w0));
    // write-protect: set on drive 1, run again: nothing reaches the store and the firmware sees WP
    s.drives.setWriteProtect(1, true);
    check('setDiskWriteProtect shows in diskStatus', s.drives.status().drives[1].writeProtected);
    s.powerCycle();
    // a power cycle keeps the cartridge and its disks, as on real hardware
    const ctl = s.drives.controller;
    check('a power cycle keeps the disk cartridge and its disks', !!ctl && s.drives.controller === ctl && s.drives.status().drives.length === 2
      && s.drives.status().drives[0].file === 'work.vdk' && s.drives.status().drives[1].writeProtected, JSON.stringify(s.drives.status().drives));
    await s.drives.writesDone();
    await s.drives.mount(0, 'work.vdk');
    await s.drives.mount(1, 'other.vdk', { writeProtected: true });
    const before1 = await media.read('disks/other.vdk');
    media.calls.length = 0;
    // the firmware writes the same bytes again on drive 0 (nothing changes) and is refused on drive 1
    check('second run reaches HALT', runToHalt(s, halt));
    await s.drives.writesDone();
    const l2 = log(s);
    // drive 1's entries start at 11: its write status (WRITE PROTECT, bit 6) and count at 14-16
    check('write-protected drive 1: the write sector ends at once with WRITE PROTECT and no byte taken', l2[14] === 0x40 && l2[15] === 0 && l2[16] === 0, Array.from(l2).map((v) => v.toString(16)).join(' '));
    check('write-protected drive 1: its stored image is unchanged', same(await media.read('disks/other.vdk'), before1));
    check('rewriting identical bytes sends nothing to the store', media.calls.filter((c) => c.m.startsWith('write')).length === 0, JSON.stringify(media.calls));

    // errors
    await rejects('the same image in two drives is refused', s.drives.mount(2, 'work.vdk'), /already in drive 0/);
    await rejects('a drive past 3 is refused', s.drives.mount(4, 'work.vdk'), /no drive 4/);
    await rejects('a disk that is not stored is reported', s.drives.mount(2, 'gone.vdk'), /gone\.vdk is no longer stored/);
    await rejects('bytes that are no disk image are refused before anything is stored', s.drives.importImage('notes.dsk', new Uint8Array(1000), 2), /not a disk image/);
    check('... and nothing was stored', !(await media.stat('disks/notes.dsk')));
    await rejects('a damaged VDK is refused', s.drives.importImage('bad.vdk', d0.slice(0, 1000), 2), /bad\.vdk/);
    await rejects('download from an empty drive', s.drives.download(3), /Drive 3 is empty/);
    await rejects('importing over the image another drive holds', s.drives.importImage('work.vdk', d0, 2), /work\.vdk is in drive 0/);

    // eject keeps the stored image; a write in flight when the machine changes still reaches the store
    await s.drives.eject(1);
    check('ejectDisk empties the drive, the image stays stored', s.drives.status().drives.length === 1 && !!(await media.stat('disks/other.vdk')));
    await s.drives.importImage('fresh.vdk', d1, 1);
    s.powerCycle();
    await s.drives.eject(1);           // (a power cycle keeps the disks: fresh.vdk moves from drive 1 to drive 0)
    await s.drives.mount(0, 'fresh.vdk');
    await s.drives.mount(1, 'other.vdk');
    let f = 0;
    while (!s.drives.controller.drives[0].imageDirty && f < 600) { s.shownMachine.runFrame(); f++; }
    check('mid-run: drive 0 holds written flux not yet committed (motor still on)', s.drives.controller.drives[0].imageDirty && s.shownMachine.cpu.pc !== halt);
    // let the write finish its sector, then switch machines with the motor still running
    for (let i = 0; i < 3; i++) s.shownMachine.runFrame();
    s.switchMachine('coco');
    await s.drives.writesDone();
    check('switching machines commits the old machine\'s disks to the store', same(await media.read('disks/fresh.vdk'), expectImage(d1, 12, 1, pattern(0x11))));
  }

  // ---------------- snapshots: the disks come back as the snapshot's own copies
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    await s.drives.importImage('snap.vdk', images.vdk(40, 2), 0);
    await s.drives.importImage('snap1.vdk', images.vdk(40, 1), 1);
    runToHalt(s, halt);
    const file = await s.snapshotFile();
    const snap = await s.readSnapshot(file.bytes);
    s.openSnapshot(snap);
    const st = s.drives.status();
    check('after opening a snapshot the drives hold the snapshot\'s disks, not linked to the store', st.drives.length === 2 && st.drives[0].file === 'snap.vdk' && !st.drives[0].stored);
    const dl = await s.drives.download(0);
    check('... and Download gives the snapshot\'s image with the write in it', same(dl.bytes, expectImage(images.vdk(40, 2), 12, 2, pattern(0x11))));
    void media;
  }

  // ---------------- Delta DOS (Premier): its WD2791 stores the complement of what the CPU writes
  {
    const { s, media, halt } = session('dragon64', 'deltados', 'premier');
    check('Delta DOS is offered on the Dragon, after DragonDOS', s.drives.dosChoices().map((c) => c.id).join() === 'dragondos,deltados' && s.drives.dosChoices()[1].ready && !s.drives.dosChoices()[0].ready);
    await s.drives.importImage('delta.vdk', images.vdk(40, 2), 0);
    await s.drives.importImage('delta1.vdk', images.vdk(40, 1), 1);
    check('the mount plugs in the cartridge whose ROM is stored (Premier FDC)', s.drives.controller.type === 'premierfdc');
    check('Premier writer reaches HALT', runToHalt(s, halt));
    await s.drives.writesDone();
    check('Delta: the stored sector holds the complement of the bytes written', same(await media.read('disks/delta.vdk'), expectImage(images.vdk(40, 2), 12, 2, pattern(0x11).map((v) => v ^ 0xff))));
  }

  // ---------------- CoCo, Disk BASIC cartridge, a JVC (.dsk) image
  {
    const { s, media, halt } = session('coco', 'rsdos', 'coco');
    const d0 = images.jvc(40, 2);
    await s.drives.importImage('coco.dsk', d0, 0);
    await s.drives.importImage('coco1.dsk', images.jvc(40, 1), 1);
    check('CoCo: the RS-DOS cartridge goes in', s.drives.controller.type === 'cocofdc' && s.drives.status().dos.id === 'rsdos');
    check('CoCo writer reaches HALT', runToHalt(s, halt));
    await s.drives.writesDone();
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
    s.loadSavedRoms(); s.shownMachine.reset(true);
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    check('Alpha: the only disk choice is the built-in interface', s.drives.dosChoices().map((c) => c.id).join() === 'builtin' && s.drives.status().dos.id === 'builtin' && s.drives.count === 2);
    await s.drives.importImage('alpha0.vdk', d0, 0);
    await s.drives.importImage('alpha1.vdk', d1, 1);
    check('Alpha: mounting uses the built-in drives; no cartridge goes in', s.shownMachine.cartPort === null && s.drives.controller === s.shownMachine.fdc && s.drives.status().drives.length === 2);
    await rejects('Alpha: drive 2 is not fitted', s.drives.importImage('x.vdk', d1, 2), /no drive 2 \(drives 0 to 1\)/);
    await rejects('Alpha: insertDiskDos is refused, the interface is built in', Promise.resolve().then(() => s.drives.insertDos('builtin')), /built in/);
    await rejects('Alpha: a DragonDOS cartridge is not offered', Promise.resolve().then(() => s.drives.insertDos('dragondos')), /can't take the DragonDOS/);
    let lit = false;
    const halt = a.symbols.get('HALT');
    for (let f = 0; f < 600 && s.shownMachine.cpu.pc !== halt; f++) { s.shownMachine.runFrame(); if (s.drives.activity()[0]) lit = true; }
    check('Alpha: the write firmware reaches HALT', s.shownMachine.cpu.pc === halt);
    check('the drive light comes on while drive 0 works, and is off once the firmware stops', lit && !s.drives.activity().some(Boolean));
    s.drives.flush();
    await s.drives.writesDone();
    check('Alpha: the stored image has the sector the firmware wrote', same(await media.read('disks/alpha0.vdk'), expectImage(d0, 12, 2, pattern(0x11))));
    check('Alpha: drive 1 too', same(await media.read('disks/alpha1.vdk'), expectImage(d1, 12, 1, pattern(0x22))));
    s.powerCycle();
    check('Alpha: a power cycle keeps the disks in the built-in drives', s.drives.status().drives.length === 2);
  }

  // ---------------- a disk controller in a Multi-Pak's slot (MAME -ext multi, run.js --fdc --multi)
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    const pak = { name: 'game.rom', bytes: new Uint8Array(0x4000).map((_, i) => (i * 5 + 1) & 0xff) };
    const msg = s.insertMultiPak([pak, null, null, { dos: 'dragondos' }]);
    const mp = s.shownMachine.cartPort;
    check('Multi-Pak: a DragonDOS controller in slot 4 next to a Program Pak in slot 1', mp.type === 'multi' && mp.cart(1).type === 'rom' && mp.cart(4).type === 'dragonfdc'
      && /Multi-Pak \(1: game\.rom, 2: empty, 3: empty, 4: DragonDOS cartridge\)/.test(msg), msg);
    check('Multi-Pak: the drives use the controller in the slot', s.drives.controller === mp.cart(4) && s.drives.status().dos.id === 'dragondos' && s.drives.count === 4);
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    await s.drives.importImage('mp0.vdk', d0, 0);
    await s.drives.importImage('mp1.vdk', d1, 1);
    check('Multi-Pak: mounting keeps the Multi-Pak in the port (no DOS cartridge replaces it)', s.shownMachine.cartPort === mp && s.drives.status().drives.length === 2);
    check('Multi-Pak: the writer firmware (the DOS ROM in slot 4, the switch on slot 4) reaches HALT', runToHalt(s, halt));
    s.drives.flush();
    await s.drives.writesDone();
    check('Multi-Pak: the stored images have the sectors the firmware wrote', same(await media.read('disks/mp0.vdk'), expectImage(d0, 12, 2, pattern(0x11)))
      && same(await media.read('disks/mp1.vdk'), expectImage(d1, 12, 1, pattern(0x22))));
    await rejects('Multi-Pak: two disk controllers are refused', Promise.resolve().then(() => s.insertMultiPak([{ dos: 'dragondos' }, null, null, { dos: 'dragondos' }])), /one disk controller/);
    await rejects('Multi-Pak: a controller of another family is refused', Promise.resolve().then(() => s.insertMultiPak([null, null, null, { dos: 'rsdos' }])), /slot 4: the Dragon 64 can't take the Disk BASIC/);
    await rejects('Multi-Pak: a controller without its ROM is refused, naming the ROM', Promise.resolve().then(() => s.insertMultiPak([null, null, null, { dos: 'deltados' }])), /slot 4: the Delta DOS cartridge needs its ROM \(deltados\.rom\)/);
    check('Multi-Pak: after the refusals the first Multi-Pak is still in', s.shownMachine.cartPort === mp);
    s.insertMultiPak([pak, null, null, null]);
    await rejects('Multi-Pak: with no controller in it, a mount is refused rather than replacing the Multi-Pak', s.drives.importImage('mp2.vdk', d1, 0), /The Multi-Pak has no disk controller/);
    check('... and the Multi-Pak stays in the port', s.shownMachine.cartPort.type === 'multi' && s.drives.controller === null);
  }
  {
    // the CoCo: Disk BASIC's controller in slot 2 with the switch on slot 2 (MAME offers slot 4 only; the Multi-Pak
    // routes SCS and CTS to every slot alike)
    const { s, media, halt } = session('coco', 'rsdos', 'coco');
    s.insertMultiPak([null, { dos: 'rsdos' }, null, null], { switchSlot: 2 });
    check('Multi-Pak (CoCo): the controller in slot 2', s.drives.controller === s.shownMachine.cartPort.cart(2) && s.drives.status().dos.id === 'rsdos');
    const d0 = images.jvc(40, 2);
    await s.drives.importImage('mpcoco.dsk', d0, 0);
    await s.drives.importImage('mpcoco1.vdk', images.vdk(40, 1), 1);
    check('Multi-Pak (CoCo): the writer firmware reaches HALT from slot 2', runToHalt(s, halt));
    s.drives.flush();
    await s.drives.writesDone();
    check('Multi-Pak (CoCo): the stored JVC image has the sector written', same(await media.read('disks/mpcoco.dsk'), expectImage(d0, 2, 2, pattern(0x11))));
  }

  // ---------------- a dropped DOS ROM is a ROM, not a program cartridge
  check('ddos10.rom, deltados.rom and disk11.rom are taken as ROM images (by their usual names)', ['ddos10.rom', 'deltados.rom', 'disk11.rom'].every((n) => Emu.Session.isRom(n, new Uint8Array(0x2000).fill(1)))
    && !Emu.Session.isRom('game.rom', new Uint8Array(0x2000).fill(1)));

  // ---------------- no ROM, no drives
  {
    const { s } = session('dragon64', null, 'dragon');
    // without a disk ROM the disk still goes in, on the controller alone (tests/disk-bare.test.js has the rest)
    const bare = await s.drives.importImage('x.vdk', images.vdk(40, 1), 0);
    check('without a disk ROM the mount goes in on the disk controller alone, and says so', /^x\.vdk is in drive 0, on the disk controller only \(no disk ROM\)/.test(bare)
      && s.drives.status().dos.bare && s.drives.controller.romBytes === null, bare);
    await s.drives.eject(0);
    await rejects('insertDiskDos without its ROM', Promise.resolve().then(() => s.drives.insertDos('dragondos')), /needs its ROM \(ddos10\.rom\)/);
    await rejects('a CoCo cartridge on the Dragon is refused', Promise.resolve().then(() => s.drives.insertDos('rsdos')), /can't take the Disk BASIC/);
    s.switchMachine('mc10');
    await rejects('the MC-10 has no disk drives', s.drives.importImage('x.vdk', images.vdk(40, 1), 0), /no disk drives/);
    check('loading a disk image as a program says it goes in a drive', (() => { try { s.load('x.vdk', images.vdk(40, 1)); return false; } catch (e) { return /go in a disk drive/.test(e.message); } })());
  }

  // ---------------- a store that refuses the write: reported once by diskWritesDone
  {
    const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
    await s.drives.importImage('full.vdk', images.vdk(40, 2), 0);
    await s.drives.importImage('full1.vdk', images.vdk(40, 1), 1);
    media.writeRange = () => Promise.reject(new MediaStoreError('quota', 'no space'));
    let errEvent = false;
    s.on((e) => { if (e === 'diskerror') errEvent = true; });
    runToHalt(s, halt);
    await s.drives.writing;      // the chain settles (its error is kept for diskWritesDone)
    check('the drive is marked unsaved with the reason, before diskWritesDone is asked', /space|quota/i.test(s.drives.status().drives[0].unsaved || ''), String(s.drives.status().drives[0].unsaved));
    await rejects('a refused disk write is reported by diskWritesDone', s.drives.writesDone(), /space|quota|full\.vdk/i);
    check("... with a 'diskerror' event", errEvent);
    // reported once: the error is cleared, so the next call resolves (and the refused write left the image as it was)
    let second = 'resolved';
    try { await s.drives.writesDone(); } catch (e) { second = `rejected: ${e.message}`; }
    check('... once: the next diskWritesDone() resolves', second === 'resolved', second);
    check('... and the stored image is the one imported (the refused write did not land)', same(await media.read('disks/full.vdk'), images.vdk(40, 2)));
    check('both drives stay marked unsaved after the error is reported (their changes are still only in the drives)', s.drives.status().drives.every((d) => !!d.unsaved));
    await s.drives.eject(0);
    await s.drives.mount(0, 'full.vdk');
    check('mounting the image again from the store clears the mark', s.drives.status().drives.find((d) => d.drive === 0).unsaved === null);
  }

  // ---------------- mountDisk's read-again limit counts changes to the image being read
  // (another drive writing its own disk while the mount reads must not make a valid mount fail after 4 tries)
  {
    const { s, media } = session('dragon64', 'dragondos', 'dragon');
    await s.drives.importImage('a.vdk', images.vdk(40, 2), 0);
    await s.drives.importImage('b.vdk', images.vdk(40, 1), 1);
    await s.drives.eject(0);                 // drive 0 free for the mount below; drive 1 keeps its disk
    const d1 = s.drives.controller.drives[1];
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // a slow store: the mount waits long enough for drive 1 to hand over 60 changes (far more than 4)
    const realStat = media.stat.bind(media), realRange = media.readRange.bind(media), realRangeW = media.writeRange.bind(media);
    let readsOfA = 0;
    media.stat = async (name) => { await sleep(8); return realStat(name); };
    media.readRange = async (name, ...a) => { if (name === 'disks/a.vdk') readsOfA++; await sleep(8); return realRange(name, ...a); };
    media.writeRange = async (...a) => { await sleep(4); return realRangeW(...a); };
    // the mount starts first and parks inside its wait on the slow store; drive 1 then writes its OWN disk
    // continuously, each change queued (and landing) while the mount is still waiting for its read
    const pending = s.drives.mount(0, 'a.vdk').then((m) => m, (e) => e);
    let foreign = 0, foreignInFlight = 0;
    const pump = (async () => {
      for (let i = 0; i < 60; i++) {
        d1.media.onWrite(0x100 + 0x40 * (i % 2000), new Uint8Array([0x5A]), d1.media.bytes.length);
        foreign++;
        if (s.drives.queued > s.drives.landed) foreignInFlight++;
        await sleep(1);
      }
    })();
    const msg = await pending;
    await pump;
    await s.drives.writesDone().catch(() => {});
    const d0 = s.drives.controller.drives[0], storedA = await media.read('disks/a.vdk'), storedB = await media.read('disks/b.vdk');
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
    await s.drives.eject(0);
    const sameDrive = s.drives.controller.drives[0];
    const link = s.drives.link('disks/a.vdk');
    let n2 = 0;
    const realStat2 = media.stat.bind(media);
    media.stat = async (name) => {
      if (name === 'disks/a.vdk' && n2 < 10) { n2++; link(0x200, new Uint8Array([0x40 + n2]), sameDrive.media ? sameDrive.media.bytes.length : 0); }
      return realStat2(name);
    };
    const again = await s.drives.mount(0, 'a.vdk').then((m) => m, (e) => e);
    media.stat = realStat2;
    check('when the image being read keeps changing on every read the mount still gives up (it does not retry forever)',
      again instanceof Emu.SessionError && /kept writing while it was read; try again/.test(again.message), again instanceof Error ? again.message : String(again));
    check('... after 4 reads (the first and three more: the same limit as before)', n2 === 4, String(n2));
  }
  // ---------------- after a mount the Session runs the drive's round-trip check in the background
  // (DiskDrives.checkLater, js/chips/floppy.js get mountBytes), so the first snapshot after a mount - a restore
  // point at the start of a Claude turn - does not pay for it, and gets what the check made at mount would give.
  {
    const sd = images.dmk(10, 2); sd[4] = 0x40;     // single density: the drive keeps its mounted bytes
    const run = async (eager) => {
      const { s } = session('dragon64', 'dragondos', 'dragon');
      await s.drives.importImage('sd.dmk', sd, 0);
      await s.drives.importImage('dd.vdk', images.vdk(40, 2), 1);
      const drives = s.drives.controller.drives.slice(0, 2);
      if (eager) for (const d of drives) void d.mountBytes;
      await s.drives.checked();
      const checked = drives.every((d) => d.pendingBytes === null);
      const t = performance.now();
      const snap = s.shownMachine.snapshot();
      const ms = performance.now() - t;
      return { checked, ms, text: Emu.state.toJSON(snap), kept: drives.map((d) => !!d.mountBytes) };
    };
    const eager = await run(true), bg = await run(false);
    check('after a mount the background check has run on both drives', bg.checked);
    check('so the first snapshot after the mounts is quick (under 50 ms)', bg.ms < 50, `${bg.ms.toFixed(1)} ms`);
    check('the drives keep the mounted bytes exactly where the check at mount says (SD DMK yes, VDK no)',
      JSON.stringify(bg.kept) === '[true,false]' && JSON.stringify(eager.kept) === '[true,false]', JSON.stringify(bg.kept));
    check('and that snapshot is the one a check at mount gives', bg.text === eager.text, `${bg.text.length} vs ${eager.text.length} chars`);
  }
  const fail = failures();
  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
