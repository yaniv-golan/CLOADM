const path = require('path');
const fs = require('fs');
// Snapshot round trip for every machine family: run each family's diagnostic firmware partway,
// take a snapshot (through JSON, as a file would), keep running the original, and check that a
// machine restored from the snapshot produces exactly the same instruction trace (registers and
// cycle counts) and the same frames. Also checks the refusal of mismatched snapshots.
const { Emu, check, spec, fnv, run, counts, checkNames, missingFromSlice } = require('./state-common.js');


const cases = [
  ['dragon64', spec('sam').trace('dragon64', { regenerate: false }), 37],
  ['coco', spec('sam').trace('coco', { regenerate: false }), 41],
  ['coco3', spec('coco3').trace('coco3', { regenerate: false }), 23],
  ['coco3 128K', spec('coco3').trace('coco3', { regenerate: false, config: { ram: 128 } }), 29],
  ['mc10', spec('mc10').trace('mc10', { regenerate: false }), 31],
];
// SAM CPU rate (rate.asm reaches rate 01 at frame 15, 11 at 21, 10 at 27): mid-slice MAME state with
// config.mameCompat, cycle speed state without it; fast-rate video during the garbage display (fastvid.asm)
for (const [rate, at] of [['00', 9], ['01', 17], ['11', 23], ['10', 30]]) {
  cases.push([`dragon64 rate ${rate}`, spec('sam').rate('dragon64'), at]);
  const hw = spec('sam').rate('dragon64', { config: { mameCompat: false } });
  cases.push([`dragon64 rate ${rate} hardware`, hw, at]);
}
cases.push(['coco rate 01', spec('sam').rate('coco'), 17]);
{
  const t = spec('sam').rate('dragon64', { file: 'fastvid.asm', config: { mameCompat: false } });
  cases.push(['dragon64 fast-rate video', t, 60]);
}

for (const [name, t, at] of cases) {
  const a = t.machine();
  for (let f = 0; f < at; f++) a.runFrame();
  if (name === 'dragon64 fast-rate video') check('snapshot taken while the CPU has the VDG slot', a.sam.rate === 2 && a.vlog.length > 0);
  const text = Emu.state.toJSON(a.snapshot());
  const continued = run(a, t.regs, 40);
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  for (const k of t.keys || []) b.setKey(k, true);   // host input is not part of a snapshot
  const restored = run(b, t.regs, 40);
  check(`${name}: restored machine runs identically`, continued === restored, `(snapshot ${(text.length / 1024).toFixed(0)} KB at frame ${at})`);
  // restored in place, over its own later state: the cartridge in the port is detached before the snapshot's
  // event queue comes back, so the restored device's events (same names) stay
  if (a.cartPort) {
    a.restore(Emu.state.fromJSON(text));
    for (const k of t.keys || []) a.setKey(k, true);
    check(`${name}: restored in place over the running machine, runs identically`, run(a, t.regs, 40) === continued);
  }
}

(async () => {
  const dw = require('../tools/mame-diff/drivewire/spec.js');
  const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
  const fw = dw.firmware('coco');
  const a = await dw.fixture();
  const m = Emu.createMachine('coco', { becker: true });
  m.setRoms(fw.slots); m.becker.attach(a.server); m.reset(true);
  const mid = () => a.server.available > 100 && !m.stall;
  for (let guard = 0; guard < 2000000 && !mid(); guard++) { m.runCycles(m.cycle + 1); if (m.stall) await m.stall; }
  check('coco: snapshot with a DriveWire sector part way to the machine', mid(), `(${a.server.available} bytes waiting)`);
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  // the restored machine's server: the same disks as they are now, the same drives
  const b = await dw.fixture();
  for (const e of await a.store.list()) await b.store.write(e.name, await a.store.read(e.name));
  const r = Emu.restoreSnapshot(saved, m.roms);
  r.becker.attach(b.server);
  const finish = async (mm, fx) => {
    let h = 0x811C9DC5;
    mm.cpu.trace = (c) => { for (const k of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc']) h = fnv(h, c[k]); h = fnv(h, c.totalCycles); };
    for (let f = 0; f < 2000 && mm.cpu.pc !== fw.haltPc; f++) while (!mm.runFrame()) await mm.stall;
    const o = await dw.outcome((x) => mm.read(x), fx.store, fx.out);
    return { h: h >>> 0, done: o.done, log: o.log.join(), files: JSON.stringify(o.files) };
  };
  const cont = await finish(m, a), rest = await finish(r, b);
  check('coco: the restored machine finishes dw.asm identically (trace, log, disks)', cont.done && rest.h === cont.h && rest.log === cont.log && rest.files === cont.files);
  await sscMidCommand();
  await nitros9MidBoot();
  await nitros9FloppyMidRead();

  // The DriveWire server's 30 channel records (15 serial, 15 window channels 128-142) in a machine snapshot: all
  // 30 are saved, and a snapshot with fewer is damaged and refused. The Becker port holds link state until a
  // server is attached, so the refusal comes at attach(), the moment a real page connects one.
  {
    const good = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
    check('coco: the snapshot carries all 30 channel records', good.state.becker.channels.length === 30);
    check(`coco: the snapshot is format ${Emu.SNAPSHOT_VERSION}`, good.version === Emu.SNAPSHOT_VERSION, String(good.version));
    const broken = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
    broken.state.becker.channels = broken.state.becker.channels.slice(0, 15);
    let refused = '';
    try { const bad = Emu.restoreSnapshot(broken, m.roms); bad.becker.attach(b.server); } catch (e) { refused = e.message; }
    check('coco: a snapshot missing window channel records is refused', /wrong size/.test(refused), refused);
  }

  // A drive keeps the geometry it mounted with (`geometry`) instead of deriving it from its bytes on restore: an
  // OS-9 image states its geometry in its first sector, so a guest that rewrote LSN 0 would otherwise make a 40x2
  // disk come back as 80x1.
  {
    const images = require('../tools/mame-diff/fdc/images');
    const os9 = Uint8Array.from(images.os9(40, 2));
    const mk = () => {
      const mm = Emu.createMachine('coco');
      const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
      mm.insertCartridge(f);
      f.mount(0, { bytes: os9.slice(), format: 'jvc', name: 'x.dsk', writeProtected: false });
      return mm.cartPort.drives[0];
    };
    const dNow = mk();
    dNow.media.bytes.fill(0, 0, 256);
    const saved = Emu.state.fromJSON(Emu.state.toJSON(dNow.saveState()));
    const dBack = mk();
    let err = '';
    try { dBack.loadState(saved); } catch (e) { err = e.message; }
    check('a drive snapshot keeps 40x2 after the guest rewrote LSN 0', !err && dBack.geometry.tracks === 40 && dBack.geometry.heads === 2,
      err || JSON.stringify(dBack.geometry));
    // a drive snapshot with no geometry is damaged: refused with a message that names the key
    {
      const bad = Emu.state.fromJSON(Emu.state.toJSON(mk().saveState()));
      delete bad.geometry;
      let why = '';
      try { mk().loadState(bad); } catch (e) { why = e.message; }
      check('a drive snapshot with no geometry is refused, naming the key', /missing "geometry"/.test(why), why);
    }
    // why the geometry is saved: the same bytes, derived again, come back 80x1
    const derived = Emu.diskGeometry(saved.media.bytes, 'jvc');
    check('...and the same bytes derived again come back 80x1 (what the saved geometry prevents)',
      derived.tracks === 80 && derived.heads === 1, JSON.stringify(derived));
  }

  // A write to a track the image does not cover: the drive makes an empty track neutral (MG_N) and splices the
  // written flux into it (js/chips/floppy.js writeFlux). That track exists in no image - saveDisk cannot write
  // it - so the snapshot's own flux is the only place it survives. Restore must rebuild it from s.written,
  // which is what this checks: a 40-track image in an 84-track drive leaves track 41 empty.
  {
    const fdcSpec = spec('fdc').trace('dragon64', { controller: 'dragonfdc', regenerate: false });
    const fm = fdcSpec.machine();
    for (let f = 0; f < 40; f++) fm.runFrame();           // the firmware spins drive 0
    const d = fdcSpec.fdcOf(fm).drives[0];
    d.cyl = 41; d.ss = 0;
    const empty = d.buffer().length;   // 0: the image stops at track 39, so nothing has been built here
    const start = d.revStart, span = d.revTime;
    const flux = [start + span / 4n, start + span / 2n, start + (span * 3n) / 4n];
    d.writeFlux(start, start + span, flux);
    const after = d.buffer().slice();
    const kinds = {};
    for (const c of after) kinds[Emu.mgType(c)] = (kinds[Emu.mgType(c)] || 0) + 1;
    check('a write past the image leaves a half-neutral track', empty === 0 && kinds[1] === 1 && kinds[0] === 3 && kinds[3] === 1,
      `${empty} cells before, ${after.length} after, types ${JSON.stringify(kinds)}`);
    const text = Emu.state.toJSON(fm.snapshot());
    const r = Emu.restoreSnapshot(Emu.state.fromJSON(text), fm.roms);
    const rd = fdcSpec.fdcOf(r).drives[0];
    rd.cyl = 41; rd.ss = 0;
    const back = rd.buffer();
    check('the restored drive rebuilds that track from the snapshot\'s flux, cell for cell',
      back.length === after.length && back.every((c, i) => c === after[i]), `${back.length} cells`);
  }

  // A disk image that does not survive a round trip through its own format. Single-density DMK is one: the FM
  // track bytes are read into flux and written back by saveDisk() as a different but equivalent encoding, so
  // loadDisk(media.bytes) after a commit no longer gives the flux the drive had. Restoring a drive from
  // media.bytes alone therefore loses what the firmware wrote, and the drive must keep the image it mounted.
  {
    const fdcSpec = spec('fdc').trace('dragon64', { controller: 'dragonfdc', regenerate: false });
    const fm = fdcSpec.machine();
    for (let f = 0; f < 40; f++) fm.runFrame();
    const d = fdcSpec.fdcOf(fm).drives[0];
    const img = require('../tools/mame-diff/fdc/images').dmk(10, 2);
    img[4] = 0x40;                                   // bit 6: single density (FM), dmk_dsk.cpp
    d.mount({ bytes: img, format: 'dmk', name: 'sd.dmk', writeProtected: false });
    d.cyl = 2; d.ss = 0;
    const start = d.revStart, span = d.revTime;
    d.writeFlux(start, start + span, [start + span / 4n, start + span / 2n, start + (span * 3n) / 4n]);
    d.imageDirty = true;
    d.flush();                                       // commit, as the motor stopping does
    const before = Array.from({ length: d.image.count }, (_, k) => d.image.track(k).slice());
    const text = Emu.state.toJSON(fm.snapshot());
    const r = Emu.restoreSnapshot(Emu.state.fromJSON(text), fm.roms);
    const rd = fdcSpec.fdcOf(r).drives[0];
    let differ = 0;
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = i < rd.image.count ? rd.image.track(i) : [];
      if (!(a.length === b.length && a.every((v, k) => v === b[k]))) differ++;
    }
    check('a single-density DMK survives a write, commit, snapshot and restore, cell for cell', differ === 0,
      `${differ} of ${before.filter((t) => t.length).length} written tracks differ`);
    // and the restored drive's media.bytes is the COMMITTED image, not the mounted one it rebuilt from: flush()
    // diffs against media.bytes to tell the host which bytes changed, so seeding it with the mounted image would
    // lose the writes the snapshot carries and report them again on the next flush.
    const committed = d.media.bytes, restoredCommitted = rd.media.bytes;
    check('a restore from the mounted bytes still carries the committed image',
      committed.length === restoredCommitted.length && committed.every((v, i) => v === restoredCommitted[i]),
      `${restoredCommitted.length} vs ${committed.length} bytes`);
    let reported = null;
    rd.media.onWrite = (off, bytes) => { reported = { off, n: bytes.length }; };
    rd.imageDirty = true;
    rd.flush();
    check('a flush after the restore reports nothing changed', reported === null,
      reported ? `${reported.n} bytes reported at ${reported.off}` : 'nothing reported');
  }

  // The drive decides whether to keep its mounted bytes lazily (js/chips/floppy.js get mountBytes): not at mount,
  // but the first time a snapshot needs the answer. That answer must be the one an eager check at mount gives,
  // even when the disk has been written and committed before the first snapshot. Two single-density DMK drives
  // (the case that needs the mounted bytes): one asked at mount (eager), one asked only by its first snapshot,
  // after a write and a commit. Their snapshots, the restored flux and the disk exported after a further write on
  // the restored drive must all be the same.
  {
    const fdcSpec = spec('fdc').trace('dragon64', { controller: 'dragonfdc', regenerate: false });
    const img = require('../tools/mame-diff/fdc/images').dmk(10, 2);
    img[4] = 0x40;                                   // bit 6: single density (FM)
    const write = (d, cyl) => {
      d.cyl = cyl; d.ss = 0;
      const start = d.revStart, span = d.revTime;
      d.writeFlux(start, start + span, [start + span / 4n, start + span / 2n, start + (span * 3n) / 4n]);
      d.imageDirty = true;
      d.flush();
    };
    const run = (eager) => {
      const fm = fdcSpec.machine();
      for (let f = 0; f < 40; f++) fm.runFrame();
      const d = fdcSpec.fdcOf(fm).drives[0];
      d.mount({ bytes: img.slice(), format: 'dmk', name: 'sd.dmk', writeProtected: false });
      const keptAtMount = eager ? !!d.mountBytes : null;
      write(d, 2);
      const text = Emu.state.toJSON(fm.snapshot());
      const r = Emu.restoreSnapshot(Emu.state.fromJSON(text), fm.roms);
      const rd = fdcSpec.fdcOf(r).drives[0];
      const flux = JSON.stringify(Array.from({ length: rd.image.count }, (_, k) => rd.image.track(k)));
      write(rd, 4);
      return { keptAtMount, text, flux, exported: rd.media.bytes.slice(), live: JSON.stringify(Array.from({ length: d.image.count }, (_, k) => d.image.track(k))) };
    };
    const eager = run(true), lazy = run(false);
    check('a single-density DMK is one the drive keeps its mounted bytes for', eager.keptAtMount === true);
    check('lazy: the first snapshot after a write and commit equals the eager one', lazy.text === eager.text,
      `${lazy.text.length} vs ${eager.text.length} chars`);
    check('lazy: the restored drive has the flux the live drive had, cell for cell', lazy.flux === lazy.live && lazy.flux === eager.flux);
    check('lazy: the disk exported after a write on the restored drive equals the eager one',
      lazy.exported.length === eager.exported.length && lazy.exported.every((v, i) => v === eager.exported[i]));
  }

  // THE SPLIT IS FAITHFUL: this suite's check names must be exactly its slice of the names the unsplit suite ran.
// Counting alone would let a dropped check and a duplicated one cancel out; the names cannot.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-check-names.json'), 'utf8'))['state'];
  const { missing, extra } = missingFromSlice(checkNames(), manifest);
  // an ordinary check of its own, so a slice mismatch is COUNTED like every other failure and the summary's
  // "ok/total" adds up (it used to bump the failure count without a matching name, printing 14/15 when 15 ran)
  check('state: its checks are exactly its slice of the unsplit suite\'s names', !missing.length && !extra.length,
    missing.length || extra.length ? `${missing.length} missing, ${extra.length} extra` : '');
  for (const n of missing.slice(0, 3)) console.log(`  missing: ${n}`);
  for (const n of extra.slice(0, 3)) console.log(`  extra:   ${n}`);
}
const __c = counts();
  console.log(`\n${__c.ok}/${__c.ok + __c.fail} state checks passed`);
  process.exitCode = __c.fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });

// The Speech/Sound Pak: a snapshot taken part way through a command must carry the PIC's
// position in time as well as its registers and the card's state, so the restored card services the command
// and releases the busy flag at exactly the same moment as the uninterrupted one.
async function sscMidCommand() {
  const { buildPic, buildSp0256 } = require('../tools/mame-diff/ssc/gen-roms.js');
  const mk = () => {
    const m = Emu.createMachine('coco', { mameCompat: true });
    m.setRoms({ bas: new Uint8Array(0x2000), extbas: new Uint8Array(0x2000) });
    m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: buildPic(), sp0256Rom: buildSp0256() }));
    m.reset(true);
    return m;
  };
  const a = mk();
  const pak = a.cartPort;
  // let the card's clock bring the PIC out of reset, then issue a command and snapshot before checking its
  // status: a status read would catch the card up, so the snapshot must be taken first for the flag to be
  // observed mid-command.
  a.runCycles(a.cycle + 4000);
  // the card's firmware leaves INT3 masked (it writes $0C to IOCNT0, which Figure 3-16 makes INT2's field), so
  // this test enables INT3 itself: it is about the snapshot carrying the card's state, not about the firmware
  pak.tms7040.writeIocnt0(0x30);   // INT3 enable (bit 4), Figure 3-16
  pak.writeIO(0xFF7E, 0x35);
  const busyMid = pak.busy;
  const text = Emu.state.toJSON(a.snapshot());
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  // let both finish the command on the card's own clock, and compare the state they arrive at: the PIC's
  // program counter and the allophone it loaded must match, and the restored card must not need materially
  // longer to get there (its saved position in time is what makes that so).
  const finish = (m) => {
    const p = m.cartPort;
    let n = 0;
    while (p.busy && n < 200000) { m.runCycles(m.cycle + 2); n++; }
    p.readIO(0xFF7E);
    return { n, busy: p.busy, pc: p.tms7040.pc, ib: p.sp0256.ib };
  };
  const fa = finish(a), fb = finish(b);
  check('ssc: the busy flag is set with a command part way through', busyMid, `(busy at snapshot: ${busyMid})`);
  check('ssc: the restored card finishes the command in the same time and state',
    !fa.busy && !fb.busy && fb.pc === fa.pc && fb.ib === fa.ib && Math.abs(fb.n - fa.n) <= 4,
    `(${fa.n} vs ${fb.n} cycles, pc ${fa.pc.toString(16)} vs ${fb.pc.toString(16)}, allophone ${fa.ib}/${fb.ib})`);
  await sscMidTone();
}

// The AY's own state, mid-tone: the tone phase counters, the noise RNG, the envelope step, the level last
// reported to the mixer and the stream divider all have to survive save/load, or a restored Pak restarts its
// waveform and the samples differ. The test plays the tone firmware for a while, snapshots, restores, and then
// requires the two machines' audio-event streams to be IDENTICAL from that point on.
async function sscMidTone() {
  const { toneFirmware } = require('../tools/mame-diff/ssc/audio.js');
  const { buildAsm } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const mk = () => {
    const m = Emu.createMachine('coco', { mameCompat: true });
    m.setRoms({ bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12), extbas: new Uint8Array(0x2000).fill(0x12) });
    m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: new Uint8Array(0x800) }));
    m.reset(true);
    return m;
  };
  const a = mk();
  for (let f = 0; f < 40; f++) a.runFrame();       // the tone is playing (frames 30-34 issue the command)
  const ayMid = a.cartPort.ay;
  const phaseMid = ayMid.tones.map((t) => t.count);
  // A channel must actually be AUDIBLE. Two weaker forms do not establish that, and both were measured failing:
  //   tones.some(period > 0)  - a period with every volume at 0 is silent;
  //   volEnabled.some(...)    - volEnabled is the waveform/noise gate only (ay8910.js:118) and ignores volume.
  // So this requires a waveform gate that is ON *and* a non-zero volume register for that channel. AY_VOLUME[0]
  // is -0.125, so silence is not zero and cannot be tested by "!== 0" either.
  const audible = ayMid.volEnabled.some((on, c) => on && ayMid.regs[8 + c] !== 0);
  check('ssc audio: a tone is playing when the snapshot is taken', audible,
    `periods ${ayMid.tones.map((t) => t.period).join(',')} volumes ${ayMid.regs.slice(8, 11).join(',')} enabled ${ayMid.volEnabled.join(',')}`);
  const text = Emu.state.toJSON(a.snapshot());
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const restored = b.cartPort.ay;
  check('ssc audio: the AY\'s phase counters survive the snapshot',
    restored.tones.every((t, i) => t.count === phaseMid[i]), `${restored.tones.map((t) => t.count).join(',')} vs ${phaseMid.join(',')}`);
  check('ssc audio: the level last reported to the mixer survives', b.cartPort.ayLevel === a.cartPort.ayLevel,
    `${b.cartPort.ayLevel} vs ${a.cartPort.ayLevel}`);
  // the two machines now produce the same sound: every level change from here on must match
  const run = (m) => {
    const ev = [];
    const frames = 30;
    for (let f = 0; f < frames; f++) {
      m.runFrame();
      for (let i = 0; i < m.audioEvents.length; i += 2) ev.push(`${m.audioEvents[i]}:${m.audioEvents[i + 1].toFixed(9)}`);
    }
    return ev;
  };
  const ea = run(a), eb = run(b);
  const same = ea.length === eb.length && ea.every((x, i) => x === eb[i]);
  let firstDiff = -1;
  if (!same) for (let i = 0; i < Math.min(ea.length, eb.length); i++) if (ea[i] !== eb[i]) { firstDiff = i; break; }
  check('ssc audio: the restored Pak plays on identically, level change for level change', same,
    same ? `${ea.length} events` : `${ea.length} vs ${eb.length} events, first difference at ${firstDiff} (${ea[firstDiff]} vs ${eb[firstDiff]})`);
}

// NitrOS-9 booted from the page (Session.bootNitros9): our loader in the CoCo 3's ROM socket, the boot disk in
// DriveWire drive 0. A snapshot file taken while the loader is part way through a boot-track sector (the server
// holds bytes not yet read) opens in a fresh Session that has the same image in drive 0 and no ROMs at all (the
// loader is built in), and both run on identically: every instruction and cycle, every frame.
// The disk is hand-built (tools/nitros9/os9-image.js); its boot track's code fills the text screen in a loop.
async function nitros9MidBoot() {
  const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
  const disk = makeOs9Disk(Emu, { code: `
AGAIN   LDX     #$0400
FILL    INC     ,X+
        CMPX    #$0600
        BNE     FILL
        BRA     AGAIN` });
  const session = async () => {
    const s = new Emu.Session();
    s.switchMachine('coco3', { cpu: '6809', ram: 128 }, { menu: false });
    await s.importDriveWireImage('n9.dsk', disk);
    return s;
  };
  const a = await session();
  await a.bootNitros9('n9.dsk');
  const m = a.shownMachine;
  const mid = () => a.drivewire.available > 100 && !m.stall;
  for (let guard = 0; guard < 2000000 && !mid(); guard++) { m.runCycles(m.cycle + 1); if (m.stall) await m.stall; }
  check('nitros9: snapshot with a boot-track sector part way to the machine', mid() && m.read(0x0100) === 0, `(${a.drivewire.available} bytes waiting)`);
  const file = await a.snapshotFile();
  const b = await session();
  await b.mountDriveWire(0, 'n9.dsk');
  let err = null;
  try { b.openSnapshot(await b.readSnapshot(file.bytes)); } catch (e) { err = e; }
  check('nitros9: the snapshot opens in a browser without ROMs (the loader is built in)', !err && b.nitros9Running && b.shownMachine.roms.basic === Emu.nitros9LoaderRom('drivewire'), err ? err.message : '');
  const finish = async (mm) => {
    let h = 0x811C9DC5, fh = 0x811C9DC5;
    mm.cpu.trace = (c) => { for (const k of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc']) h = fnv(h, c[k]); h = fnv(h, c.totalCycles); };
    for (let f = 0; f < 300; f++) {
      while (!mm.runFrame()) await mm.stall;
      const px = Emu.frameToRGBA(mm.render());
      for (let i = 0; i < px.length; i += 7) fh = fnv(fh, px[i]);
    }
    return { h: h >>> 0, fh: fh >>> 0, booted: mm.read(0x0100) === 1, screen: mm.read(0x0400) | mm.read(0x05FF) };
  };
  const cont = await finish(m), rest = await finish(b.shownMachine);
  check('nitros9: the restored machine finishes the boot and runs on identically (trace, frames)', cont.booted && cont.screen && rest.h === cont.h && rest.fh === cont.fh,
    JSON.stringify({ cont, rest }));
}

// NitrOS-9 from a floppy (Session.bootNitros9 with a floppy image): our floppy loader in the ROM socket, the CoCo disk
// controller with no ROM of its own, the disk in drive 0. A snapshot file taken in the middle of a halted sector read
// (the CPU held by the controller's HALT, part of the sector in memory) opens in a fresh Session that has the same
// disk in its library and no ROMs, and both run on identically: every instruction and cycle, every frame, and the
// boot track ends up the same. In the page's mode (not mameCompat), where HALT now suspends as MAME's does.
async function nitros9FloppyMidRead() {
  const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
  const disk = makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, code: `
AGAIN   LDX     #$0400
FILL    INC     ,X+
        CMPX    #$0600
        BNE     FILL
        BRA     AGAIN` });
  const session = async () => {
    const s = new Emu.Session();
    s.switchMachine('coco3', { cpu: '6809', ram: 128 }, { menu: false });
    await s.media.write('disks/n9floppy.dsk', disk);
    return s;
  };
  const a = await session();
  await a.bootNitros9('n9floppy.dsk', 'disk');
  const m = a.shownMachine;
  // halted inside a sector of the boot track, after its first bytes and before its last
  const mid = () => m.cpu.haltLine && !m.stall && m.cpu.x > 0x2680 && (m.cpu.x & 0xFF) > 0x10 && (m.cpu.x & 0xFF) < 0xF0;
  for (let guard = 0; guard < 4000000 && !mid(); guard++) { m.runCycles(m.cycle + 1); if (m.stall) await m.stall; }
  check('nitros9 floppy: snapshot with the CPU halted part way through a boot-track sector', mid() && m.read(0x0100) === 0 && !m.config.mameCompat,
    `(X $${m.cpu.x.toString(16)})`);
  const file = await a.snapshotFile();
  const b = await session();
  let err = null;
  try { b.openSnapshot(await b.readSnapshot(file.bytes)); } catch (e) { err = e; }
  check('nitros9 floppy: the snapshot opens without ROMs (the loader is built in, the controller needs none)',
    !err && b.nitros9Loader() === 'floppy' && b.shownMachine.roms.basic === Emu.nitros9LoaderRom('floppy') && b.shownMachine.cartPort instanceof Emu.DiskController, err ? err.message : '');
  const finish = async (mm) => {
    let h = 0x811C9DC5, fh = 0x811C9DC5;
    mm.cpu.trace = (c) => { for (const k of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc']) h = fnv(h, c[k]); h = fnv(h, c.totalCycles); };
    for (let f = 0; f < 300; f++) {
      while (!mm.runFrame()) await mm.stall;
      const px = Emu.frameToRGBA(mm.render());
      for (let i = 0; i < px.length; i += 7) fh = fnv(fh, px[i]);
    }
    const track = [];
    for (let i = 0; i < 18 * 256; i += 97) track.push(mm.read(0x2600 + i));
    return { h: h >>> 0, fh: fh >>> 0, booted: mm.read(0x0100) === 1, track: track.join(), screen: mm.read(0x0400) | mm.read(0x05FF) };
  };
  const cont = await finish(m), rest = await finish(b.shownMachine);
  const want = [];
  for (let i = 0; i < 18 * 256; i += 97) want.push(disk[(34 * 36) * 256 + i]);
  check('nitros9 floppy: the restored machine finishes the read and the boot identically (trace, frames, the boot track as on the disk)',
    cont.booted && cont.screen && cont.track === want.join() && rest.h === cont.h && rest.fh === cont.fh && rest.track === cont.track,
    JSON.stringify({ cont: { h: cont.h, fh: cont.fh, booted: cont.booted }, rest: { h: rest.h, fh: rest.fh, booted: rest.booted } }));
}
