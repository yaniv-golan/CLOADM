// Booting NitrOS-9 from the page's Session (Session.bootNitros9 and friends, js/config.js nitros9=): the user's
// DriveWire image in drive 0 on the Becker port, our loader (js/machines/nitros9.js) in place of the CoCo 3 ROM.
//  - with hand-built boot disks (tools/nitros9/os9-image.js, no NitrOS-9 bytes): the machine it makes, the loader running
//    the boot track, reset, leaving, the errors (wrong machine, no image, not OS-9, the wrong build), the link,
//    sharing (never a snapshot of NitrOS-9), picking the image for a link;
//  - with a hand-built floppy (40 tracks, two sides): the floppy loader, the ROM-less disk controller, reset,
//    leaving, the link, a Multi-Pak, an 80-track image;
//  - with the official v3.3.0 Becker and _40d_1 floppy images, when tools/nitros9/fetch.js has cached them (skipped with the reason
//    otherwise): the Session boots each to the shell and `dir` lists the root, read from the screen as
//    tests/nitros9.test.js does (that test checks the same boot against MAME 0.264's DriveWire transactions, at
//    512K), at 512K and at 128K.
const Emu = require('./load')();
const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
const { cached } = require('../tools/nitros9/fetch.js');
const lib = require('../tools/nitros9/lib.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const { Session, parseUrlConfig, nitros9LoaderRom, NITROS9_STATUS } = Emu;
// true only when p rejects with a SessionError whose message matches re; anything else (no error at all, another
// error, another message) is false, and what happened instead is printed
const rejects = async (p, re) => {
  let r;
  try { await p; r = 'no error'; } catch (e) { r = e instanceof Emu.SessionError && re.test(e.message) ? true : e.message; }
  if (r !== true) console.log(`  (expected a SessionError matching ${re}: ${r})`);
  return r === true;
};
const frames = async (s, n, until) => {
  const m = s.shownMachine;
  for (let f = 0; f < n; f++) { while (!m.runFrame()) await m.stall; if (until && until()) return true; }
  return false;
};
const status = (m) => m.read(NITROS9_STATUS.addr);

(async () => {
  const { driveHeader } = await import('../js/ui/drives.js');   // the drives card's header (no DOM needed)
  const s = new Session();
  s.switchMachine('coco3', { cpu: '6809', ram: 128, becker: false }, { menu: false });
  await s.importDriveWireImage('boot6809.dsk', makeOs9Disk(Emu, { cpu: '6809' }));
  await s.importDriveWireImage('boot6309.dsk', makeOs9Disk(Emu, { cpu: '6309' }));
  await s.importDriveWireImage('blank.dsk', new Uint8Array(630 * 256));
  await s.importDriveWireImage('bitbanger.dsk', makeOs9Disk(Emu, { port: 'bitbanger' }));

  // ---- errors
  check('no image: says where to get one', await rejects(s.bootNitros9(''), /No NitrOS-9 image.*nos96809l2v030300coco3\.zip.*nos96309l2v030300coco3\.zip.*sourceforge\.net\/projects\/nitros9\/files\/releases\/v3\.3\.0\/.*_becker\.dsk.*_40d_1\.dsk/));
  check('an image not in the library', await rejects(s.bootNitros9('gone.dsk'), /no image called gone\.dsk in your library/));
  {
    // a store that fails with something other than not-found must be reported as that, not as a missing image
    const real = s.media;
    s.media = { read: async (n) => { if (n.endsWith('broken.dsk')) throw new Emu.MediaStoreError('io', 'the disk is on fire'); return real.read(n); } };
    check('a storage error is reported as one, not as "no image"', await rejects(s.bootNitros9('broken.dsk'), /^broken\.dsk: the disk is on fire$/));
    s.media = real;
  }
  check('a blank (not OS-9) image', await rejects(s.bootNitros9('blank.dsk'), /blank\.dsk: It isn't an OS-9 disk/));
  check('the bit-banger build', await rejects(s.bootNitros9('bitbanger.dsk'), /bit-banger.*_becker\.dsk/));
  // bootNitros9 always mounts into DriveWire drive 0, so an image another drive already holds is refused there.
  // The message has to say what to do: the plain refusal ("already in DriveWire drive 1") leaves the person with
  // no next step, and this path (Boot NitrOS-9 from the slot) has no eject button of its own.
  await s.mountDriveWire(1, 'boot6809.dsk');
  check('bootNitros-9: an image another DriveWire drive holds is refused, saying to eject it there first',
    await rejects(s.bootNitros9('boot6809.dsk'), /boot6809\.dsk.*already in DriveWire drive 1: eject it there first/));
  check('... and the failed boot changed nothing (drive 1 still has it, drive 0 empty)', s.driveWireMounts.length === 1 && s.driveWireMounts[0].drive === 1 && !s.nitros9Running);
  s.ejectDriveWire(1);
  check('a failed boot leaves the machine as it was (BASIC socket, Becker port off)', !s.nitros9Running && s.shownMachine.config.becker === false && !s.driveWireMounts.length);
  check('addAndBootNitros9 refuses a bad file before keeping it', await rejects(s.addAndBootNitros9('x.dsk', new Uint8Array(300)), /x\.dsk: It isn't a disk image of whole 256-byte sectors/) &&
    !(await s.driveWireImages()).some((x) => x.name === 'x.dsk'));
  {
    const d = new Session();
    d.switchMachine('dragon64', undefined, { menu: false });
    await d.importDriveWireImage('boot6809.dsk', makeOs9Disk(Emu));
    check('another machine (Dragon 64): NitrOS-9 boots on the CoCo 3', await rejects(d.bootNitros9('boot6809.dsk'), /on the CoCo 3.*not the Dragon 64.*Switch to the CoCo 3/));
    d.switchMachine('coco3p', undefined, { menu: false });
    check('the PAL CoCo 3: refused too (the release\'s DriveWire images are 60 Hz builds)', await rejects(d.bootNitros9('boot6809.dsk'), /not the CoCo 3 \(PAL\)/));
  }

  // ---- the image list
  {
    const list = await s.nitros9Images(), by = Object.fromEntries(list.map((x) => [x.name, x]));
    check('nitros9Images: each image with what it is', by['boot6809.dsk'].cpu === '6809' && !by['boot6809.dsk'].reason && by['boot6309.dsk'].cpu === '6309' && /isn't an OS-9/.test(by['blank.dsk'].reason) && by['bitbanger.dsk'].boot === 'drivewire');
    check('pickNitros9Image: by CPU when drive 0 has none', (await s.pickNitros9Image('6309')).name === 'boot6309.dsk' && (await s.pickNitros9Image('6809')).name === 'boot6809.dsk');
  }

  // ---- booting the 6809 build on a 6809 CoCo 3 without the Becker port
  let msg = await s.bootNitros9('boot6809.dsk');
  let m = s.shownMachine;
  check('booted: message', /Booting NitrOS-9\/6809 from boot6809\.dsk over DriveWire$/.test(msg), msg);
  check('the machine: a CoCo 3, Becker port on, CPU and RAM kept', m.id === 'coco3' && m.config.becker === true && m.config.cpu === '6809' && m.config.ram === 128, JSON.stringify(m.config));
  check('the Becker port is served by the Session\'s DriveWire server', m.becker.server === s.drivewire);
  check('the image is in DriveWire drive 0', s.driveWireMounts.some((d) => d.drive === 0 && d.name === 'boot6809.dsk'));
  check('our loader is the internal ROM (no ROM of the user\'s)', m.roms.basic === nitros9LoaderRom('drivewire') && s.nitros9Running && s.romCodeIn() === 'nitros9');
  check('bootStatus: nitros9, never "no OK after 5 seconds"', s.bootStatus().state === 'nitros9');
  await frames(s, 600);
  check('the boot track ran: the loader jumped and the boot track\'s code set $0102', status(m) === NITROS9_STATUS.jumped && m.read(0x0102) === 0x5A, `status $${status(m).toString(16)}`);
  check('bootStatus still nitros9 after 10 seconds', s.bootStatus(5).state === 'nitros9');

  // reset boots again: the loader stays in the socket
  m.write(NITROS9_STATUS.addr, 0xEE); m.write(0x0102, 0);
  s.reset();
  await frames(s, 120);
  check('reset: it boots the image again', status(m) === NITROS9_STATUS.jumped && m.read(0x0102) === 0x5A);
  s.powerCycle({ menu: false });
  await frames(s, 120);
  check('power cycle: it boots the image again', s.nitros9Running && status(m) === NITROS9_STATUS.jumped && m.read(0x0102) === 0x5A);

  // the link and sharing
  {
    const url = s.shareUrl('https://cloadm.dev/play/');
    const back = parseUrlConfig(new URL(url).search);
    check('share link: the CoCo 3, its options (Becker port on) and nitros9=1, no image name', /nitros9=1/.test(url) && !/boot6809/.test(url) && back.machine === 'coco3' && back.config.becker === true && back.nitros9 === true && !back.errors.length, url);
    check('share: never a snapshot of NitrOS-9 (its memory is the user\'s NitrOS-9)', await rejects(s.shareFile(), /NitrOS-9 moment isn't shared as a snapshot/));
    check('the embed API\'s peek refuses while NitrOS-9 runs', (() => { try { new Emu.EmbedApi(s, () => {}).peek(0x2600, 4); return false; } catch (e) { return /NitrOS-9 runs from your own image/.test(e.message); } })());
  }

  // a 6309 build on the 6809 CoCo 3: the machine becomes a 6309 one
  msg = await s.bootNitros9('boot6309.dsk');
  m = s.shownMachine;
  check('the 6309 build switches the CPU to the HD6309, and says so', m.config.cpu === '6309' && /switched to the HD6309/.test(msg) && m.cpu.constructor.name === 'CPU6309', msg);
  check('drive 0 now has the 6309 image', s.driveWireMounts.find((d) => d.drive === 0).name === 'boot6309.dsk');
  check('pickNitros9Image: drive 0\'s image first', (await s.pickNitros9Image('6809')).name === 'boot6309.dsk');
  await frames(s, 120);
  check('the 6309 boot track runs', status(m) === NITROS9_STATUS.jumped && m.read(0x0102) === 0x5A);
  msg = await s.bootNitros9('boot6809.dsk');
  check('the 6809 build on the 6309 machine keeps the HD6309', s.shownMachine.config.cpu === '6309' && !/switched/.test(msg));

  // leaving: the ROMs back (none stored here: the stub)
  s.leaveNitros9();
  check('Back to BASIC: our loader out, the machine on its own ROMs (here none: the stub)', !s.nitros9Running && s.shownMachine.useStub && s.bootStatus().state === 'stub');
  check('the share link no longer boots NitrOS-9', !/nitros9/.test(s.shareUrl('https://cloadm.dev/play/')));
  // another machine and back: the user's ROMs, not the loader
  await s.bootNitros9('boot6809.dsk');
  s.switchMachine('coco3', undefined, { menu: false });
  check('switching machine puts the ROMs back', !s.nitros9Running);

  // ---- the link's parameter (js/config.js)
  {
    const p = (q) => parseUrlConfig(q, 'dragon64');
    check('nitros9=1 alone means the CoCo 3', p('?nitros9=1').machine === 'coco3' && p('?nitros9=1').nitros9 === true && !p('?nitros9=1').errors.length);
    check('nitros9 (no value) is 1', p('?machine=coco3&nitros9').nitros9 === true);
    check('nitros9=NAME', p('?machine=coco3&cpu=6309&nitros9=my%20boot.dsk').nitros9 === 'my boot.dsk' && p('?machine=coco3&cpu=6309&nitros9=my%20boot.dsk').config.cpu === '6309');
    check('nitros9 with another machine: an error, ignored', p('?machine=dragon64&nitros9=1').nitros9 === null && /NitrOS-9 boots on the CoCo 3/.test(p('?machine=dragon64&nitros9=1').errors[0]));
    check('nitros9 with a path in the name: an error', p('?machine=coco3&nitros9=a/b.dsk').nitros9 === null && /nitros9=a\/b\.dsk/.test(p('?machine=coco3&nitros9=a/b.dsk').errors[0]));
    check('nitros9=0: nothing', p('?machine=coco3&nitros9=0').nitros9 === null && !p('?machine=coco3&nitros9=0').errors.length);
    const u = Emu.buildUrl('https://cloadm.dev/play/', { machine: 'coco3', config: { cpu: '6309' }, nitros9: 'my boot.dsk' });
    check('buildUrl round trip', p(new URL(u).search).nitros9 === 'my boot.dsk', u);
  }

  // ---- the release images, through the Session: boot to the shell, dir
  const PROMPT = '{Term|02}/DD:';
  for (const [cpu, ram] of [['6809', 512], ['6309', 512], ['6809', 128], ['6309', 128]]) {
    const image = `nos9${cpu}l2v030300coco3_becker.dsk`, { bytes, reason } = cached(image);
    if (!bytes) { console.log(`skip ${cpu} release image: ${reason}`); continue; }
    const r = new Session();
    r.switchMachine('coco3', { cpu: '6809', ram }, { menu: false });
    const said = await r.addAndBootNitros9(image, bytes);
    const mm = r.shownMachine, screen = () => lib.screenText(mm);
    const prompted = await frames(r, 40 * 60, () => screen().includes(PROMPT));
    check(`${cpu} ${ram}K: the Session boots the release image to the shell prompt`, prompted && mm.config.cpu === cpu && mm.config.ram === ram, `${said}; ${JSON.stringify(screen().slice(-3))}`);
    check(`${cpu} ${ram}K: NitrOS-9's banner`, screen().includes(`NitrOS-9/${cpu} Level 2 V3.3.0`));
    r.typeText('dir\r');
    const listed = await frames(r, 20 * 60, () => { const l = screen(), d = l.findIndex((x) => x.startsWith(' Directory of ')); return d >= 0 && l.slice(d + 1).includes(PROMPT); });
    const l = screen(), d = l.findIndex((x) => x.startsWith(' Directory of '));
    const names = d >= 0 ? l.slice(d + 1, l.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
    check(`${cpu} ${ram}K: dir typed through the Session lists the root`, listed && ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup', 'NITROS9'].every((n) => names.includes(n)), JSON.stringify(names));
  }

  // ---- floppies: a hand-built NitrOS-9 floppy (40 tracks, two sides, DD on rb1773), the floppy loader
  {
    const f = new Session();
    f.switchMachine('coco3', { cpu: '6809', ram: 128, becker: false }, { menu: false });
    const disk = makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' });
    const said = await f.addAndBootNitros9('floppy9.dsk', disk);
    const fm = f.shownMachine;
    check('floppy: booted from floppy drive 0, the 6309 build on the HD6309, the Becker port left off',
      /Booting NitrOS-9\/6309 from floppy9\.dsk in floppy drive 0 \(switched to the HD6309/.test(said) && fm.config.cpu === '6309' && fm.config.becker === false, said);
    check('floppy: kept with the library\'s disks, and listed as a floppy', (await f.media.list('disks/')).some((e) => e.name === 'disks/floppy9.dsk') &&
      (await f.nitros9Images()).some((x) => x.name === 'floppy9.dsk' && x.store === 'disk' && x.boot === 'floppy' && !x.reason));
    check('floppy: the CoCo disk controller with no ROM of its own, the image in drive 0',
      fm.cartPort instanceof Emu.DiskController && fm.cartPort.type === 'cocofdc' && !fm.cartPort.romBytes && f.diskStatus().drives.some((d) => d.drive === 0 && d.name === 'disks/floppy9.dsk'));
    check('floppy: our floppy loader is the internal ROM', fm.roms.basic === nitros9LoaderRom('floppy') && f.nitros9Loader() === 'floppy' && f.bootStatus().state === 'nitros9');
    await frames(f, 600);
    check('floppy: the loader read the boot track (track 34, side 0) and jumped: its code set $0102', status(fm) === NITROS9_STATUS.jumped && fm.read(0x0102) === 0x5A, `status $${status(fm).toString(16)}`);
    // a Disk BASIC ROM stored now (our own bytes) is not for this controller while NitrOS-9 runs on it: no reset
    // puts it in, and the drives card does not say one will
    f.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
    const head = driveHeader(f);
    check('floppy: a disk ROM stored meanwhile is not waiting for a reset, and the drives card says no disk ROM', !f.diskRomWaiting
      && head.dos === 'no disk ROM' && head.hint === 'disks work for programs that read them directly', JSON.stringify(head));
    fm.write(NITROS9_STATUS.addr, 0xEE); fm.write(0x0102, 0);
    f.reset();
    await frames(f, 600);
    check('floppy: reset boots it again', status(fm) === NITROS9_STATUS.jumped && fm.read(0x0102) === 0x5A);
    check('floppy: and leaves the controller without a ROM (NitrOS-9 drives it)', fm.cartPort instanceof Emu.DiskController && fm.cartPort.romBytes === null && !f.diskRomWaiting);
    check('floppy: the link boots NitrOS-9 (nitros9=1), and picks the floppy in drive 0', /nitros9=1/.test(f.shareUrl('https://cloadm.dev/play/')) && (await f.pickNitros9Image('6809')).name === 'floppy9.dsk');
    f.leaveNitros9();
    check('floppy: Back to BASIC takes the ROM-less controller out (the disk stays in the library)', !f.nitros9Running && !f.shownMachine.cartPort && (await f.media.list('disks/')).length === 1);
    check('floppy: by name from the link, found with the disks', /in floppy drive 0/.test(await f.bootNitros9('floppy9.dsk')));
    f.shownMachine.insertCartridge(new Emu.devices.multi([null, null, null, null]));
    check('floppy: not through a Multi-Pak', await rejects(f.bootNitros9('floppy9.dsk', 'disk'), /take the Multi-Pak out/));
    const big = makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 2880 });
    check('floppy: an 80-track one is refused before it is kept', await rejects(f.addAndBootNitros9('big.dsk', big), /big\.dsk: .*80 tracks/) && !(await f.media.list('disks/')).some((e) => e.name === 'disks/big.dsk'));
  }
  // ---- a floppy image the Session is given goes through the disk write queue (diskStoreChange), like every other
  // stored image: a mount reading that name meanwhile waits for it, so a torn read is impossible, and the drives'
  // writes are ordered against it. (Pins this half of the v0.1.5 train's session.js conflict: if a resolution drops
  // the reroute and writes media directly, this goes red.)
  {
    const q = new Session();
    q.switchMachine('coco3', { cpu: '6809', ram: 128, becker: false }, { menu: false });
    const disk = makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440 });
    const calls = [];
    const realChange = q.diskStoreChange.bind(q);
    q.diskStoreChange = (op, name) => { calls.push({ name, queuedBefore: q.diskQueued }); return realChange(op, name); };
    const said = await q.addAndBootNitros9('queued9.dsk', disk);
    check('floppy image: the write is queued through diskStoreChange under disks/<name> (not a direct media write)',
      calls.length === 1 && calls[0].name === 'disks/queued9.dsk', `${JSON.stringify(calls)} | ${said}`);
    // and the queue really waits for it: hold the store's write of that image open, start the boot, and the write
    // must not have finished while the queue was being waited on
    const q2 = new Session();
    q2.switchMachine('coco3', { cpu: '6809', ram: 128, becker: false }, { menu: false });
    const realWrite = q2.media.write.bind(q2.media);
    let held = false, release = null;
    // resolved from inside the stub, so the test waits for the write to actually arrive rather than for a delay
    let arrived = null;
    const reached = new Promise((res) => { arrived = res; });
    q2.media.write = async (name, bytes) => {
      if (name === 'disks/held9.dsk' && !held) { held = true; arrived(); await new Promise((r) => { release = r; }); }
      return realWrite(name, bytes);
    };
    const booting = q2.addAndBootNitros9('held9.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440 })).then((m) => m, (e) => e);
    // the write is in the chain, and the queue is waiting on it. Bounded: if the write never reaches media.write the
    // test reports that instead of waiting for it forever
    let bound = null;
    const arrivedIn = await Promise.race([reached.then(() => true), new Promise((res) => { bound = setTimeout(() => res(false), 5000); })]);
    clearTimeout(bound);
    check('floppy image: the store write arrives (the chain reaches it)', arrivedIn, arrivedIn ? '' : 'media.write was never called for disks/held9.dsk');
    // it never arrived: fail here rather than wait on `booting`, which could only be released by the write
    if (!arrivedIn) throw new Error('the stubbed store write for disks/held9.dsk never arrived');
    // the oracle for the reroute is the next check: `settledWhileHeld` goes red if the write is not in the chain.
    // This one can only fail if the stub stops matching, and it exists so that such a change fails in 5 s instead
    // of hanging on `booting` forever.
    let settledWhileHeld = 'resolved';
    await Promise.race([q2.diskWritesSettled().then(() => {}, () => {}), new Promise((r) => setTimeout(() => { settledWhileHeld = 'waiting'; r(); }, 50))]);
    check('floppy image: the disk queue does not settle while that write is held (it is in the chain, not alongside it)',
      held && settledWhileHeld === 'waiting', `${held ? '' : 'write not held; '}${settledWhileHeld}`);
    if (release) release();
    const out = await booting;
    check('floppy image: once released, it boots', typeof out === 'string' && /in floppy drive 0/.test(out), typeof out === 'string' ? out : (out && out.message));
  }
  // the release floppies, through the Session: boot, Return at setime's prompt, dir
  for (const [cpu, ram] of [['6809', 512], ['6309', 512], ['6809', 128], ['6309', 128]]) {
    const image = `nos9${cpu}l2v030300coco3_40d_1.dsk`, { bytes, reason } = cached(image);
    if (!bytes) { console.log(`skip ${cpu} release floppy: ${reason}`); continue; }
    const r = new Session();
    r.switchMachine('coco3', { cpu: '6809', ram }, { menu: false });
    const said = await r.addAndBootNitros9(image, bytes);
    const mm = r.shownMachine, screen = () => lib.screenText(mm);
    // setime's prompt (answered with Return), or straight to the shell: the 6809 build at 128K runs no setime, in
    // MAME 0.264 as here (its startup stops early; seen on MAME's screen, not compared automatically)
    const at = () => screen().some((x) => x.startsWith('Time ?')) || screen()[screen().length - 1] === PROMPT;
    const reached = await frames(r, 60 * 60, at);
    const asked = screen().some((x) => x.startsWith('Time ?'));
    if (asked) r.typeText('\r');
    const prompted = await frames(r, 30 * 60, () => screen()[screen().length - 1] === PROMPT);
    check(`${cpu} ${ram}K floppy: the Session boots the release floppy to the shell${asked ? ' (setime\'s prompt answered)' : ''}`,
      reached && prompted && (asked || (cpu === '6809' && ram === 128)) && mm.config.cpu === cpu && mm.config.ram === ram, `${said}; ${JSON.stringify(screen().slice(-3))}`);
    r.typeText('dir\r');
    const listed = await frames(r, 20 * 60, () => { const l = screen(), d = l.findIndex((x) => x.startsWith(' Directory of ')); return d >= 0 && l.slice(d + 1).includes(PROMPT); });
    const l = screen(), d = l.findIndex((x) => x.startsWith(' Directory of '));
    const names = d >= 0 ? l.slice(d + 1, l.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
    check(`${cpu} ${ram}K floppy: dir lists the root`, listed && ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup'].every((n) => names.includes(n)), JSON.stringify(names));
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
