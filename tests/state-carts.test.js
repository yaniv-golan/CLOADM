// Run: node tests/state-carts.test.js
//
// Cartridges, a Multi-Pak and the Speech/Sound Pak snapshotted mid-activity, with the ssc helpers they use. Split out
// of state.test.js; the checks are unchanged. This suite has its own case list: the cartridge cases only.
const fs = require('fs'), path = require('path');
const { Emu, spec, check, run, fnv, counts, checkNames, missingFromSlice } = require('./state-common.js');

const cases = [];
// cartridges (cart/ firmware): mid bank loop, a Games Master tone and noise playing (PSG registers, its
// stream position and the slot's Q-tied CART), Orchestra-90 DAC ramps, a Multi-Pak with its slots
for (const [setup, at, what] of [['banked', 1, 'stepping through the banks'], ['gmc', 9, 'tone playing'], ['gmc', 70, 'noise playing'],
  ['orch90', 6, 'DAC ramp'], ['multi', 3, 'DAC writes in slot 2']]) {
  cases.push([`coco ${setup} (${what})`, spec('cart').trace('coco', { setup }), at]);
}
// the same on the CoCo 3 (GIME, its CART input EI0) and the Dragon 64
for (const [id, setup, at, what] of [['coco3', 'gmc', 9, 'tone playing'], ['coco3', 'multi', 3, 'DAC writes in slot 2'], ['dragon64', 'multi', 3, 'DAC writes in slot 2']]) {
  cases.push([`${id} ${setup} (${what})`, spec('cart').trace(id, { setup }), at]);
}
for (const [name, t, at] of cases) {
  const a = t.machine();
  for (let f = 0; f < at; f++) a.runFrame();
  // (the fast-rate video check belongs to state.test.js, which owns that case; this list has no such case)
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

// The GIME's vertical fine scroll ($FF9C; coco3/gen-vsc.js, part 1: 8-line text, VSC stepped 0-12), on the machine
// as shipped (no mameCompat: MAME never scrolls). Two points: in the body of a scrolled field, partway through a row
// (the latched VSC, `vsc`, in use), and between a write to $FF9C and the next field's start, where the register
// already holds the next value and the field still shows the latched one: both must run on identically.
{
  const t = spec('coco3').vsc('coco3', { part: 1, regenerate: false, config: { mameCompat: false } });
  const points = [
    ['in the body of a scrolled field', (g) => g.zone === 1 && g.vsc > 1 && g.logical > 40 && g.lineInRow !== 0],
    ['after a $FF9C write, before the field latches it', (g) => g.vsc > 0 && (g.regs[12] & 0x0F) !== g.vsc],
  ];
  for (const [what, at] of points) {
    const a = t.hardware(), g = a.gime;
    let guard = 0;
    while (!at(g) && guard++ < 4000000) a.runCycles(a.cycle + 1);
    check(`vertical scroll: snapshot taken ${what}`, at(g), JSON.stringify({ zone: g.zone, vsc: g.vsc, ff9c: g.regs[12], lineInRow: g.lineInRow }));
    const text = Emu.state.toJSON(a.snapshot());
    const continued = run(a, t.regs, 40);
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
    check(`vertical scroll, ${what}: restored machine runs identically (trace and frames)`, run(b, t.regs, 40) === continued);
  }
}

// Disk tracks are built on first use (FloppyImage.track). A snapshot taken mid-transfer, while most of every disk is
// still unbuilt, restores into a machine whose drives build the tracks the firmware goes on to reach only then. It
// must run exactly as the machine that was never interrupted, and as a restore that builds every track at once.
{
  const t = spec('fdc').trace('dragon64', { controller: 'dragonfdc', regenerate: false });
  const a = t.machine();
  const cyls = (m) => t.fdcOf(m).drives.map((d) => d.cyl).join();
  const before = new Set();
  for (let f = 0; f < 104; f++) { a.runFrame(); before.add(cyls(a)); }
  const wd = t.fdcOf(a).wd;
  check('lazy tracks: snapshot taken during a read sector', wd.mainState === 4 && wd.live.state !== 0, `(main ${wd.mainState} live ${wd.live.state})`);
  const text = Emu.state.toJSON(a.snapshot());
  const lazy = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const eager = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const allTracks = (m) => t.fdcOf(m).drives.map((d) => (d.image ? JSON.stringify(Array.from({ length: d.image.count }, (_, k) => d.image.track(k))) : ''));
  allTracks(eager);                                    // every track of every drive built now
  const after = new Set();
  const traces = [a, lazy, eager].map((m) => {
    const frame = m.runFrame.bind(m);
    m.runFrame = () => { frame(); after.add(cyls(m)); };   // the cylinders each drive is on, frame by frame
    const h = run(m, t.regs, 200);
    delete m.runFrame;
    return h;
  });
  check('lazy tracks: the firmware goes on to cylinders it had not reached at the snapshot', [...after].some((c) => !before.has(c)), [...after].join(' / '));
  check('lazy tracks: restored with tracks built on demand, runs as the uninterrupted machine (trace and frames)', traces[1] === traces[0]);
  check('lazy tracks: restored with every track built at once, runs the same', traces[2] === traces[0]);
  const fa = allTracks(a), fl = allTracks(lazy), fe = allTracks(eager);
  check('lazy tracks: all three end with the same flux on all four drives', fa.every((x, i) => x === fl[i] && x === fe[i]));
}

// restored in place while the CoCo FDC holds the CPU halted (HALT on DRQ): the old controller's detach must not
// leave the hub believing HALT is already released, or the restored controller's release is lost
{
  const t = spec('fdc').trace('coco', { controller: 'cocofdc', regenerate: false });
  const a = t.machine();
  let f = 0;
  do { a.runFrame(); f++; } while (!(a.cpu.haltLine && a.cartPort.lines.level('halt')) && f < 2000);
  const text = Emu.state.toJSON(a.snapshot());
  const continued = run(a, t.regs, 40);
  a.restore(Emu.state.fromJSON(text));
  check(`coco cocofdc with the CPU halted (frame ${f}): restored in place, runs identically`, f < 2000 && run(a, t.regs, 40) === continued);
}

// CoCo 3: a snapshot taken while HALT holds an instruction past the end of the frame (HaltReplay.haltSuspend: a read
// sector with HALT on DRQ, drive 1's sector 4 coming round 11 frames later). Two held accesses: the LDA of the data
// register (nothing before it in the instruction), and the write of an INC of it (its read made before, kept in the
// snapshot and replayed). Restored into a fresh machine, the trace and frames go on as on the machine that ran on.
function cocoHaltSuspended(config, prog, label) {
  const images = require('../tools/mame-diff/fdc/images');
  const machine = () => { const m = Emu.createMachine('coco3', config); m.insertCartridge(new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) })); return m; };
  const a = machine(), f = a.cartPort;
  a.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
  for (let i = 0; i < 3; i++) a.runFrame();
  // the sector, READ SECTOR, then the control latch (drive, motor, DDEN, HALT enable); interrupts masked
  const start = (dsk, sector, loop, pre = []) => {
    [...pre, 0xC6, sector, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, dsk, 0xF7, 0xFF, 0x40, ...loop].forEach((b, i) => a.poke(0x3000 + i, b));
    a.cpu.x = 0x4000; a.cpu.pc = 0x3000; a.cpu.cc |= 0x50;
  };
  a.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) a.runFrame();   // spin up
  start(0xA9, 1, [0x12, 0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF9]);   // drive 0: leaves the latch's DRQ input low
  for (let i = 0; i < 30; i++) a.runFrame();
  start(0xAA, 4, prog.loop, prog.pre);
  if (prog.pre) a.cpu.y = 0;
  for (let i = 0; i < 3; i++) a.runFrame();
  const d = a.halt.haltDefer;
  check(`coco3 (${label}) ${prog.name}: suspended by HALT at the end of a frame, the held access's earlier I/O kept`,
    !!d && d.rel < 0 && a.cpu.pc === prog.pc && d.log.filter((v, i) => i % 2 === 0 && v >= 0xFF00).length === prog.log,
    d ? `pc ${a.cpu.pc.toString(16)} log ${d.log}` : 'not suspended');
  const text = Emu.state.toJSON(a.snapshot());
  const regs = ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc', 'dp'].map((name) => ({ name }));
  const continued = run(a, regs, 20);
  const b = machine();
  b.restore(Emu.state.fromJSON(text));
  const restored = run(b, regs, 20);
  check(`coco3 (${label}) ${prog.name}: restored into a fresh machine while suspended, runs on identically (trace, frames)`,
    restored === continued && a.halt.haltDefer === null && b.halt.haltDefer === null, `${restored} vs ${continued}`);
  // a version 1 file has no haltDefer: it restores, with nothing suspended (no version 1 build suspended an
  // instruction); the same file at the current version is refused as damaged
  const old = Emu.state.fromJSON(Emu.state.toJSON(b.snapshot()));
  delete old.state.haltDefer;
  let err = null;
  try { b.restore(Object.assign({}, old, { version: 1 })); } catch (e) { err = e; }
  check(`coco3 (${label}) ${prog.name}: a version 1 snapshot (no haltDefer) restores`, !err && b.halt.haltDefer === null, err ? err.message : '');
  err = null;
  try { b.restore(old); } catch (e) { err = e; }
  check(`coco3 (${label}) ${prog.name}: a version ${Emu.SNAPSHOT_VERSION} snapshot without haltDefer is refused`, !!err && /missing "haltDefer"/.test(err.message), err ? err.message : 'restored');
  // ...and a file without the optional outsideWrites key (any file from before this build, and one this build writes
  // with nothing queued) restores owing no outside write
  const optional = Emu.state.fromJSON(Emu.state.toJSON(b.snapshot()));
  delete optional.state.outsideWrites;
  err = null;
  try { b.restore(optional); } catch (e) { err = e; }
  check(`coco3 (${label}) ${prog.name}: a snapshot without outsideWrites (the optional key) restores owing no outside write`,
    !err && Array.isArray(b.halt.outsideWrites) && b.halt.outsideWrites.length === 0, err ? err.message : `${b.halt.outsideWrites.length} owed`);
}
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
  cocoHaltSuspended(config, { name: 'LDA $FF4B', loop: [0x12, 0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF9], pc: 0x3010, log: 0 }, label);
  cocoHaltSuspended(config, { name: 'INC $FF4B', loop: [0x7C, 0xFF, 0x4B, 0x20, 0xFB], pc: 0x300F, log: 1 }, label);
}
// the HD6309 in native mode (LDMD #1): LDA $FF4B,Y, whose post byte's native saving is added as the instruction goes
for (const [label, config] of [['6309 native, hardware timing', { cpu: '6309' }], ['6309 native, MAME timing', { cpu: '6309', mameCompat: true }]]) {
  cocoHaltSuspended(config, { name: 'LDA $FF4B,Y', pre: [0x11, 0x3D, 0x01], loop: [0x12, 0xA6, 0xA9, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF8], pc: 0x3013, log: 0 }, label);
}

// The interrupt hub's levels survive a snapshot: two sources hold IRQ, then one lets go after the restore, and
// IRQ stays asserted because the other still holds it (a fresh hub knowing only the CPU's line would release it);
// the same with a source holding two lines (a disk controller's NMI and HALT)
{
  for (const id of ['dragon64', 'coco3']) {
    const a = Emu.createMachine(id); a.reset(true);
    a.setLine('test-a', 'irq', true); a.setLine('test-b', 'irq', true); a.setLine('test-c', 'halt', true); a.setLine('test-c', 'nmi', false);
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(Emu.state.toJSON(a.snapshot())), a.roms);
    const held = b.cpu.irqLine && b.cpu.haltLine;
    b.setLine('test-a', 'irq', false);
    b.setLine('test-c', 'nmi', false);
    check(`${id}: hub levels restored: IRQ held by another source stays asserted, HALT stays held`, held && b.cpu.irqLine && b.cpu.haltLine && b.interrupts.level('test-b', 'irq'));
    b.setLine('test-b', 'irq', false); b.setLine('test-c', 'halt', false);
    check(`${id}: ...and goes once the last source lets go`, !b.cpu.irqLine && !b.cpu.haltLine);
  }
}

// The Dragon Alpha's AY-3-8912 in the middle of each sound (alpha/sound.asm): the generators' counters, the
// noise register, the envelope and the stream position must come back, so the restored machine makes exactly
// the same sound (every level change of the next 40 frames) and runs the same instructions
{
  const s = spec('alpha').sound('dgnalpha');
  for (const at of [20, 60, 100, 140, 175]) {
    const a = s.machine();
    for (let f = 0; f < at; f++) a.runFrame();
    const text = Emu.state.toJSON(a.snapshot());
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
    const sound = (m) => { const out = []; for (let f = 0; f < 40; f++) { m.runFrame(); out.push(...m.audioEvents); } return out; };
    const sa = sound(a), sb = sound(b);
    check(`dgnalpha AY at frame ${at} (phase ${a.ram[0x7000]}): restored machine makes the same sound`, sa.join() === sb.join() && sa.length > 40 && a.cpu.pc === b.cpu.pc && a.cpu.totalCycles === b.cpu.totalCycles,
      `(${sa.length / 2} level events)`);
  }
}

// LIZA for the 6803: a snapshot taken in the middle of a conversation on the MC-10,
// restored into a fresh machine, carries on exactly as the uninterrupted run does - the next typed
// line gets the same reply and every frame matches.
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../examples/liza6803.asm'), 'utf8');
  const include = (n) => { const p = path.join(__dirname, '../examples', n); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const asm = Emu.assemble(src, '6803', { include, defines: { MC10: 1, ALICE: 0 } });   // the MC-10 build
  const boot = (m) => { m.injectAndRun(asm.segments, asm.exec); for (let i = 0; i < 20; i++) m.runFrame(); };
  const type = (m, text) => { for (const ch of (text + '\r').toUpperCase()) { m.stubKeys.push(ch.charCodeAt(0)); m.runFrame(); m.runFrame(); } };
  const screen = (m) => { const b = m.profile.textScreen; let s = ''; for (let i = 0; i < 512; i++) { const c = m.ram[b + i] & 0x3F; s += String.fromCharCode(c < 0x20 ? c + 0x40 : c); } return s; };
  const a = Emu.createMachine('mc10', { ram: 20 });
  boot(a);
  type(a, 'Hello'); type(a, 'I need a holiday');
  for (let i = 0; i < 20; i++) a.runFrame();
  check('LIZA 6803: the conversation is under way before the snapshot', /WHY DO YOU NEED A HOLIDAY\?/.test(screen(a).replace(/\s+/g, ' ')));
  const text = Emu.state.toJSON(a.snapshot());
  const regs = ['pc', 'a', 'b', 'x', 's', 'cc'].map((n) => ({ name: n }));
  // keep talking on the original
  type(a, 'I feel tired');
  const continued = run(a, regs, 30);
  // restore the snapshot into a fresh machine and keep talking the same way
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  type(b, 'I feel tired');
  const restored = run(b, regs, 30);
  check('LIZA 6803: restored mid-conversation runs identically', continued === restored,
    `(snapshot ${(text.length / 1024).toFixed(0)} KB)`);
  check('LIZA 6803: the restored machine gives the same reply', screen(a).replace(/\s+/g, ' ') === screen(b).replace(/\s+/g, ' '),
    screen(b).replace(/\s+/g, ' ').slice(-50));
}

// A snapshot taken in the middle of an active scanline, after a mid-line mode change. Lines are drawn as
// the beam passes them, so the machine holds a "beam" record (which line, how far along, the mode, the
// bytes fetched so far) and the picture drawn so far. A frame boundary always lands in the border, so a
// snapshot at a frame boundary would not exercise them: this steps into a swept line of the raster
// firmware (tools/mame-diff/<family>/raster.asm), snapshots there, and requires the restored machine to
// draw the rest of that frame and the next ones exactly as the original does.
for (const [name, family, id, config] of [
  ['dragon64 (MAME timing)', 'sam', 'dragon64', { mameCompat: true }],
  ['dragon64 (hardware timing)', 'sam', 'dragon64', { mameCompat: false }],
  ['mc10 (MAME timing)', 'mc10', 'mc10', { mameCompat: true }],
]) {
  const t = spec(family).raster(id, { regenerate: false, config });
  const m = t.machine();
  // into the first swept field of the first case (the frame before it shows the plain lead-in picture, so a
  // line the restored machine failed to draw would show)
  for (let f = 0; f < 400 && !(m.ram[t.phaseAddr] === 1 && m.ram[t.fieldAddr] === t.fields - 2); f++) m.runFrame();
  // then a few cycles at a time into a swept line: on the SAM machines one already split and part drawn; on
  // the MC-10 (whose beam moves only at a write) one that began in the swept state, before its first write
  let guard = 0;
  const midLine = () => m.beam && (family === 'mc10'
    ? m.beam.body >= 20 && m.beam.pos === 0 && m.beam.latch !== 0 && m.cycle - m.beam.lineStart > 10
    : m.beam.pos >= 4 && m.beam.pos < 28 && m.beam.split);
  while (guard++ < 400000 && !(m.ram[t.fieldAddr] === t.fields - 3 && midLine())) m.runCycles(m.cycle + 1);
  check(`${name}: stops part way along a split line`, m.ram[t.fieldAddr] === t.fields - 3 && midLine(), m.beam ? `(row ${m.beam.y}, position ${m.beam.pos})` : '(no line)');
  if (!(m.ram[t.fieldAddr] === t.fields - 3 && midLine())) continue;
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const runOn = (mm) => {
    let h = 0x811C9DC5;
    for (let f = 0; f < 3; f++) { mm.runFrame(); const px = mm.render().data; for (let k = 0; k < px.length; k += 3) h = fnv(h, px[k]); }
    return h >>> 0;
  };
  const cont = runOn(m);
  check(`${name}: the restored machine draws the rest of the line and the next frames identically`,
    runOn(Emu.restoreSnapshot(saved, m.roms)) === cont);
}

// The 200-E under config.mameCompat keeps two pieces of MAME's VDG state across lines and fields: MAME's own
// INTEXT bit, which decides whether a PIA1 port B write splits the line (mameIntext), and the character bank
// sampled once per field (charBankLatch; js/machines/sam.js). Snapshots where each one decides what comes next
// must continue identically, and the field must matter: the same snapshot with it flipped must not.
//   mameIntext: raster case 11 (PB1 written along every line at SAM V 1, where a split moves the display
//     counter), at the start of a swept line, before its first write: whether that write splits the line
//     depends on it;
//   charBankLatch: the first field of case 15 once its setup has put PB at text: still drawn with the bank
//     case 14 left (PB4 = 1).
for (const [caseNo, field, at] of [
  [11, 'mameIntext', (m, t) => m.ram[t.fieldAddr] === t.fields - 4 && m.beam && !m.beam.split && m.beam.pos === 0 && m.beam.body >= 24 && m.beam.body < 60],
  [15, 'charBankLatch', (m) => m.charBankLatch === 1 && (m.pia1.b.outValue() & 0xF8) === 0 && m.beam && m.beam.body >= 24],
]) {
  const t = spec('sam').raster('dragon200e', { regenerate: false });
  const m = t.machine();
  for (let f = 0; f < 2000 && !(m.ram[t.phaseAddr] === caseNo - 1 && m.ram[t.fieldAddr] === 1); f++) m.runFrame();
  const mid = () => m.ram[t.phaseAddr] === caseNo && at(m, t);
  for (let guard = 0; guard < 2000000 && !mid(); guard++) m.runCycles(m.cycle + 1);
  check(`dragon200e case ${caseNo}: stops where ${field} decides what follows`, mid(), m.beam ? `(row ${m.beam.y}, position ${m.beam.pos})` : '');
  const json = Emu.state.toJSON(m.snapshot());
  // run on by cycles, not runFrame(): the cycle-by-cycle search above has left the frame bookkeeping behind
  const start = m.cycle;
  const runOn = (mm) => {
    let h = 0x811C9DC5;
    for (let f = 1; f <= 3; f++) { mm.runCycles(start + f * mm.frameCycles); const px = mm.render().data; for (let k = 0; k < px.length; k++) h = fnv(h, px[k]); }
    return h >>> 0;
  };
  const cont = runOn(m);
  check(`dragon200e case ${caseNo}: the restored machine continues identically`, runOn(Emu.restoreSnapshot(Emu.state.fromJSON(json), m.roms)) === cont);
  const other = Emu.restoreSnapshot(Emu.state.fromJSON(json), m.roms);
  other[field] ^= 1;
  check(`dragon200e case ${caseNo}: ${field} is load-bearing (flipped, the picture differs)`, runOn(other) !== cont);
}

// A serial character in flight: the CoCo's and the MC-10's printer firmware send bytes on the
// bit-banger at 600 baud; a snapshot taken part way through a character, restored into a fresh machine, must
// print exactly what the uninterrupted machine prints. The Dragon's parallel printer has its output in the
// snapshot too.
for (const [id, family] of [['coco', 'sam'], ['mc10', 'mc10'], ['dragon64', 'sam']]) {
  const t = spec(family).printer(id);
  const m = t.machine();
  const mid = () => m.printed.length >= 6 && (m.bitBanger ? m.bitBanger.rx.start !== null && m.bitBanger.rx.edges.length > 2 : m.printed.length < 100);
  for (let guard = 0; guard < 400000 && !mid(); guard++) { m.runCycles(m.cycle + 1); if (m.bitBanger) m.bitBanger.flush(m.cycle); }
  check(`${id}: snapshot ${m.bitBanger ? 'part way through a serial character' : 'while printing'}`, mid(), `(${m.printed.length} bytes printed)`);
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const finish = (mm) => {
    let after = -1;
    for (let f = 0; f < 3600 && after !== 0; f++) {
      mm.runFrame();
      if (after < 0 && mm.read(t.doneAddr) === 0xFF) after = 30; else if (after > 0) after--;
    }
    return mm.printed.join(',');
  };
  const cont = finish(m);
  check(`${id}: the restored machine prints the same`, finish(Emu.restoreSnapshot(saved, m.roms)) === cont, `(${cont.split(',').length} bytes)`);
}

// The serial terminal: a byte on its way to the machine is part of the snapshot. The CoCo with
// the terminal plugged in at 1200 baud and "OK" queued; snapshot part way through the first byte; the restored
// machine's RXD must follow the same frames, and the device must still be the terminal at 1200 baud.
{
  const s = new Emu.Session();
  s.switchMachine('coco');
  s.serial.attach('terminal', { baud: 1200 });
  const m = s.shownMachine, bit = m.tickHz / 1200;
  s.serial.send('OK', { text: true });
  m.runCycles(m.cycle + Math.round(4.5 * bit));
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const r = Emu.restoreSnapshot(saved, m.roms);
  // (sampling moves the line on, so each machine is sampled once)
  const sample = (mm) => { const out = []; for (let k = 0; k < 20; k++) out.push(mm.bitBanger.rxd(m.cycle + k * bit)); return out.join(''); };
  check('coco: the restored machine has the terminal at 1200 baud', r.bitBanger.kind === 'terminal' && r.bitBanger.baud === 1200);
  const fromR = sample(r), fromM = sample(m);
  check('coco: the restored machine receives the rest of the bytes on its way', fromR === fromM && fromR.includes('0'), fromR);
}

// The Dragon 64's 6551 ACIA with a loopback plug: a snapshot taken while a byte is being shifted
// out (and its echo shifted in), restored into a fresh machine, must run the ACIA firmware on to its HALT with the
// same instructions, cycle counts and bytes read back as the uninterrupted machine.
{
  const t = spec('sam').serial('dragon64');
  const m = t.machine(), c = m.acia.chip;
  const mid = () => c.txState === 1 && c.txOutput === 1 && c.txBits >= 3 && c.rxState === 1 && m.ram[0x7000] !== 0xFF;
  for (let guard = 0; guard < 400000 && !mid(); guard++) m.runCycles(m.cycle + 1);
  check('dragon64: snapshot while the ACIA shifts a byte out and back in', mid(), `(tx bit ${c.txBits}, rx state ${c.rxState})`);
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const finish = (mm) => {
    let h = 0x811C9DC5, halted = false;
    mm.cpu.trace = (cpu) => { for (const r of t.regs) h = fnv(h, cpu[r.name]); h = fnv(h, cpu.totalCycles); if (cpu.pc === t.haltPc) halted = true; };
    for (let f = 0; f < 600 && !halted; f++) mm.runFrame();
    return `${h >>> 0} ${halted} ${[...mm.ram.slice(0x7100, 0x7200)].join(',')}`;
  };
  const cont = finish(m);
  check('dragon64: the restored machine runs the ACIA firmware on identically to HALT', finish(Emu.restoreSnapshot(saved, m.roms)) === cont && cont.includes(' true '));
}

// A snapshot part-way along a composite-coloured line. The VDG keeps the mode and byte each
// line began with (MAME's m_mode[0]); they decide the line's composite colour when it ends, so the restored
// machine must have them. The raster firmware's lines that change mode part way along: case 16 (begins in
// 256x192, NTSC artifact colours) on the CoCo, case 17 (begins in four colours, PAL blending on odd lines) on
// the Dragon 64.
for (const [id, caseNo] of [['coco', 16], ['dragon64', 17]]) {
  const t = spec('sam').raster(id, { regenerate: false });
  const m = t.machine();
  for (let f = 0; f < 400 && !(m.ram[t.phaseAddr] === caseNo && m.ram[t.fieldAddr] === t.fields - 2); f++) m.runFrame();
  const mid = () => m.ram[t.fieldAddr] === t.fields - 3 && m.beam && m.beam.split && m.beam.body % 2 === 1 && m.beam.pos >= 4 && m.beam.pos < 28;
  for (let guard = 0; guard < 400000 && !mid(); guard++) m.runCycles(m.cycle + 1);
  check(`${id}: stops part way along a composite-coloured line, after its mode changed`, mid(), m.beam ? `(row ${m.beam.y}, position ${m.beam.pos})` : '');
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  // the picture as soon as that line is finished (a whole frame later the next field has redrawn it), then
  // two more frames
  const runOn = (mm) => {
    let h = 0x811C9DC5;
    const hash = () => { const px = mm.render().data; for (let k = 0; k < px.length; k++) h = fnv(h, px[k]); };
    const y = mm.beam.y;
    for (let guard = 0; guard < 10000 && mm.beam && mm.beam.y === y; guard++) mm.runCycles(mm.cycle + 1);
    hash();
    for (let f = 0; f < 2; f++) { mm.runFrame(); hash(); }
    return h >>> 0;
  };
  const cont = runOn(m);
  check(`${id}: the restored machine finishes that line with the same composite colour`, runOn(Emu.restoreSnapshot(saved, m.roms)) === cont);
}

// The CoCo 3's artifact colours: the GIME gives the mixes of each background / foreground pair
// colour codes as pairs come into use, and a snapshot must keep them. vdg.asm's RG6 CSS 1 phase, after RG6 CSS 0
// has taken the first codes; snapshot part way through a field, restore, and the frames must continue identically,
// colour codes and colours.
{
  const m = spec('coco3').video('coco3').machine();
  m.setComposite(1);
  for (let f = 0; f < 1500 && m.ram[0x7F00] !== 16; f++) m.runFrame();
  for (let f = 0; f < 3; f++) m.runFrame();
  m.runCycles(m.cycle + 40000);
  check('coco3: two background / foreground pairs have artifact colour codes', m.gime.mixKeys.length === 2, `(${m.gime.mixKeys.length})`);
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const runOn = (mm) => {
    let h = 0x811C9DC5;
    for (let f = 0; f < 3; f++) { mm.runFrame(); for (const v of Emu.frameToRGBA(mm.render())) h = fnv(h, v); const d = mm.render().data; for (let k = 0; k < d.length; k++) h = fnv(h, d[k]); }
    return h >>> 0;
  };
  const cont = runOn(m);
  // (composite colour is a display setting, applied to every machine by the Session, not machine state)
  const r = Emu.restoreSnapshot(saved, m.roms);
  r.setComposite(1);
  check('coco3: the restored machine continues with the same artifact colours', runOn(r) === cont);
}

// The CoCo 3's composite monitor: artifact mixes are made from the palette in use, and mixKeys keeps the
// pairs' colour codes so a restored machine makes them again. vdg-composite.asm's "RG6 CSS0 BPI" phase (56): artifact
// colours on the phase-inverted composite palette. Snapshot part way through a field, restore into a fresh machine
// on the composite monitor, and the picture at once and the frames after must be the same, colours and codes.
{
  const v = spec('coco3').video('coco3', { file: 'vdg-composite.asm' });
  const m = v.machine();
  m.gime.artifact = 1; m.monitor = 'composite';
  for (let f = 0; f < 2400 && m.ram[0x7F00] !== 56; f++) m.runFrame();
  for (let f = 0; f < 3; f++) m.runFrame();
  m.runCycles(m.cycle + 40000);
  check('coco3 composite: in the BPI phase, with artifact pairs in use', m.ram[0x7F00] === 56 && (m.gime.regs[8] & 0x20) !== 0 && m.gime.mixKeys.length > 0,
    `(phase ${m.ram[0x7F00]}, ${m.gime.mixKeys.length} pairs)`);
  check('coco3 composite: mixKeys holds colour codes', m.gime.mixKeys.every(([a, b]) => a < 64 && b < 64));
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const pic = (mm) => { let h = 0x811C9DC5; for (const x of Emu.frameToRGBA(mm.render())) h = fnv(h, x); return h >>> 0; };
  const runOn = (mm) => { let h = pic(mm); for (let f = 0; f < 3; f++) { mm.runFrame(); h = fnv(h, pic(mm)); const d = mm.render().data; for (let k = 0; k < d.length; k++) h = fnv(h, d[k]); } return h >>> 0; };
  const r = Emu.restoreSnapshot(saved, m.roms);
  r.gime.artifact = 1; r.monitor = 'composite';                 // display settings, applied by the Session
  check('coco3 composite: the restored picture has the same colours at once', pic(r) === pic(m));
  const cont = runOn(m);
  check('coco3 composite: the restored machine continues identically', runOn(r) === cont);
}

// the welcome program mid-tune (stub firmware, DAC sound): the trace, frames and sound continue identically
{
  const fs = require('fs');
  const s = new Emu.Session();
  s.switchMachine('dragon64');
  s.startWelcome(new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/welcome.bin'))));
  s.welcomeSound();
  const a = s.shownMachine;
  for (let f = 0; f < 60; f++) a.runFrame();   // the stripe is built by frame 32; the tune starts then
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const withSound = (m) => { let h = 0x811C9DC5; const frame = m.runFrame.bind(m); m.runFrame = () => { frame(); for (const v of m.audioEvents) h = fnv(h, Math.round(v * 1e6)); }; return () => h >>> 0; };
  const tuneOn = a.audioEvents.length > 20;
  const text = Emu.state.toJSON(a.snapshot());
  const soundA = withSound(a), continued = run(a, regs, 40);
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const soundB = withSound(b), restored = run(b, regs, 40);
  check('welcome program mid-tune: restored machine runs identically, sound included', tuneOn && continued === restored && soundA() === soundB(),
    `(snapshot ${(text.length / 1024).toFixed(0)} KB at frame 60)`);
}

// A debugger attached to the machine travels in the snapshot: its breakpoints and// watchpoints come back, a restored machine with a debugger still runs and draws identically (the debugger's
// bus wrapper and its trace change nothing), a machine without one is unchanged, and a snapshot taken with a
// debugger restores into a machine that gets one.
{
  const t = spec('sam').trace('dragon64', { regenerate: false });
  const withDbg = (m, addr) => { const d = new Emu.Debugger(m, { traceSize: 16 }); d.addBreakpoint(addr); d.addWatchpoint(0x4000, 2, { write: true, read: false }); return d; };
  const a = t.machine();
  for (let f = 0; f < 9; f++) a.runFrame();
  const dbgA = withDbg(a, 0x1234);              // an address the firmware never runs
  const text = Emu.state.toJSON(a.snapshot());
  const continued = run(a, t.regs, 40);
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const restored = run(b, t.regs, 40);
  check('a debugger in the snapshot: the restored machine runs identically', continued === restored, `(snapshot ${(text.length / 1024).toFixed(0)} KB)`);
  check('a debugger in the snapshot: its breakpoints and watchpoints come back',
    b.debugger && JSON.stringify(b.debugger.breakpoints()) === JSON.stringify(dbgA.breakpoints())
    && JSON.stringify(b.debugger.watchpoints()) === JSON.stringify(dbgA.watchpoints()));
  check('a debugger in the snapshot: the restored debugger is attached to the restored machine', b.debugger && b.debugger.machine === b);
  // a snapshot without a debugger restores without one (nothing new in a snapshot of a plain machine)
  const plain = t.machine();
  for (let f = 0; f < 5; f++) plain.runFrame();
  const plainText = Emu.state.toJSON(plain.snapshot());
  check('a machine with no debugger stores no debugger state', !/"debugger":\{/.test(plainText) && /"debugger":null/.test(plainText));
  check('a plain snapshot restores with no debugger', Emu.restoreSnapshot(Emu.state.fromJSON(plainText), plain.roms).debugger === null);
  // a 6803 machine too
  const m10 = spec('mc10').trace('mc10', { regenerate: false }).machine();
  for (let f = 0; f < 7; f++) m10.runFrame();
  withDbg(m10, 0x1234);
  const t10 = Emu.state.toJSON(m10.snapshot());
  const b10 = Emu.restoreSnapshot(Emu.state.fromJSON(t10), m10.roms);
  check('the MC-10: debugger state survives the snapshot too', b10.debugger && b10.debugger.breakpoints().length === 1 && b10.debugger.cpu === '6803');
}
// THE SPLIT IS FAITHFUL: this suite's check names must be exactly its slice of the names the unsplit suite ran.
// Counting alone would let a dropped check and a duplicated one cancel out; the names cannot.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-check-names.json'), 'utf8'))['state-carts'];
  const { missing, extra } = missingFromSlice(checkNames(), manifest);
  // an ordinary check of its own, so a slice mismatch is COUNTED like every other failure and the summary's
  // "ok/total" adds up (it used to bump the failure count without a matching name, printing 14/15 when 15 ran)
  check('state-carts: its checks are exactly its slice of the unsplit suite\'s names', !missing.length && !extra.length,
    missing.length || extra.length ? `${missing.length} missing, ${extra.length} extra` : '');
  for (const n of missing.slice(0, 3)) console.log(`  missing: ${n}`);
  for (const n of extra.slice(0, 3)) console.log(`  extra:   ${n}`);
}
const __c = counts();
console.log(`\n${__c.ok}/${__c.ok + __c.fail} state-carts checks passed`);
process.exitCode = __c.fail ? 1 : 0;
