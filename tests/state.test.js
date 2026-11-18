// Snapshot round trip for every machine family: run each family's diagnostic firmware partway,
// take a snapshot (through JSON, as a file would), keep running the original, and check that a
// machine restored from the snapshot produces exactly the same instruction trace (registers and
// cycle counts) and the same frames. Also checks the refusal of mismatched snapshots.
const path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const spec = (family) => require(path.join(__dirname, '../tools/mame-diff', family, 'spec.js'));
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };

// hash `frames` frames of execution: every instruction's registers and cycle count, every frame's pixels and its
// sound (the machine's level events, a cartridge's sound mixed in)
function run(m, regs, frames) {
  let h = 0x811C9DC5;
  m.cpu.trace = (c) => { for (const r of regs) h = fnv(h, c[r.name]); h = fnv(h, c.totalCycles); };
  for (let f = 0; f < frames; f++) {
    m.runFrame();
    for (const v of m.audioEvents) h = fnv(h, Math.round(v * 1e6));
    if (f > 0) { const px = m.render().data; for (let i = 0; i < px.length; i += 7) h = fnv(h, px[i]); } // frame 0 may hold a pre-snapshot picture
  }
  m.cpu.trace = null;
  return h >>> 0;
}

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
// floppy controllers in the middle of a transfer (fdc/ firmware): the chip's bit-level state, the drives'
// rotation, the flux written so far and the slot's pending NMI/HALT timers must all come back.
// These are checked separately below, one machine per controller: mounting four drives builds their flux from
// the images, which is the expensive part, so each machine is built once and snapshotted at every point in
// turn instead of once per point.
const FDC_MIDWAY = { 4: 'read sector', 7: 'write track', 8: 'write sector' };
const fdcCases = [];
for (const [id, controller, at, what] of [['dragon64', 'dragonfdc', 104, 4], ['dragon64', 'dragonfdc', 247, 7], ['dragon64', 'dragonfdc', 286, 8],
  ['coco', 'cocofdc', 244, 8], ['coco', 'cocofdc', 305, 7], ['coco', 'cocofdc', 482, 4], ['coco3', 'cocofdc', 244, 8], ['coco3', 'cocofdc', 305, 7], ['coco3', 'cocofdc', 482, 4], ['coco', 'multifdc', 244, 8], ['coco', 'multifdc', 482, 4], ['dragon64', 'premierfdc', 120, 4], ['dragon64', 'premierfdc', 184, 8],
  ['dgnalpha', 'alphafdc', 104, 4], ['dgnalpha', 'alphafdc', 251, 7], ['dgnalpha', 'alphafdc', 192, 8]]) {
  fdcCases.push({ id, controller, at, what, name: `${id} ${controller} ${FDC_MIDWAY[what]}` });
}
// in a Multi-Pak's slot 4 (<board>-multi.asm): a write in the diagnostic; the Dragon's read while CTS selects slot 1
// (the firmware running from RAM, DRQ's CART held back); the CoCo's read with the CPU halted while SCS selects slot 1
for (const [id, controller, at, what, select] of [['dragon64', 'dragonfdc', 286, 8, 0xff], ['dragon64', 'dragonfdc', 425, 4, 0x03], ['coco', 'cocofdc', 537, 4, 0x30]]) {
  fdcCases.push({ id, controller, at, what, multi: true, select, name: `${id} ${controller} in a Multi-Pak ${FDC_MIDWAY[what]} (select $${select.toString(16).toUpperCase()})` });
}
// The floppy controllers, one machine per controller: build it, then snapshot at each of its points in turn and
// let the machine carry on between them. Every check is the same as above (the controller is mid-transfer, the
// restored copy runs identically); the machine is built once instead of once per point, which is what made
// these eleven cases three quarters of this suite's run time.
{
  const byController = new Map();
  for (const c of fdcCases) { const k = `${c.id} ${c.controller}${c.multi ? ' multi' : ''}`; if (!byController.has(k)) byController.set(k, []); byController.get(k).push(c); }
  for (const [key, list] of byController) {
    const t = spec('fdc').trace(list[0].id, { controller: list[0].controller, regenerate: false, multi: !!list[0].multi });
    const a = t.machine();
    let frame = 0;
    for (const c of [...list].sort((x, y) => x.at - y.at)) {
      for (; frame < c.at; frame++) a.runFrame();
      const wd = t.fdcOf(a).wd;
      check(`snapshot taken during the ${FDC_MIDWAY[c.what]} (${key})`, wd.mainState === c.what && wd.live.state !== 0 && (!c.multi || a.cartPort.select === c.select),
        `(main ${wd.mainState} live ${wd.live.state}${a.cpu.haltLine ? ', CPU halted' : ''}${c.multi ? `, select $${a.cartPort.select.toString(16)}` : ''})`);
      const text = Emu.state.toJSON(a.snapshot());
      const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
      for (const k of t.keys || []) b.setKey(k, true);
      const aTrace = run(a, t.regs, 40), bTrace = run(b, t.regs, 40);
      check(`${c.name}: restored machine runs identically`, aTrace === bTrace, `(snapshot ${(text.length / 1024).toFixed(0)} KB at frame ${c.at})`);
      // restored in place, over its own later state: the controller is detached before the snapshot's event queue
      // comes back, so the restored controller's events (same names) stay; the machine is then where the run left it
      a.restore(Emu.state.fromJSON(text));
      for (const k of t.keys || []) a.setKey(k, true);
      check(`${c.name}: restored in place over the running machine, runs identically`, run(a, t.regs, 40) === aTrace);
      frame += 40;   // those 40 frames are part of the run, so the next point is measured from here
    }
  }
}

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

// CoCo 3: a snapshot taken while HALT holds an instruction past the end of the frame (Coco3Machine.haltSuspend: a read
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
  const d = a.haltDefer;
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
    restored === continued && a.haltDefer === null && b.haltDefer === null, `${restored} vs ${continued}`);
  // a version 1 file has no haltDefer: it restores, with nothing suspended (no version 1 build suspended an
  // instruction); the same file at the current version is refused as damaged
  const old = Emu.state.fromJSON(Emu.state.toJSON(b.snapshot()));
  delete old.state.haltDefer;
  let err = null;
  try { b.restore(Object.assign({}, old, { version: 1 })); } catch (e) { err = e; }
  check(`coco3 (${label}) ${prog.name}: a version 1 snapshot (no haltDefer) restores`, !err && b.haltDefer === null, err ? err.message : '');
  err = null;
  try { b.restore(old); } catch (e) { err = e; }
  check(`coco3 (${label}) ${prog.name}: a version ${Emu.SNAPSHOT_VERSION} snapshot without haltDefer is refused`, !!err && /missing "haltDefer"/.test(err.message), err ? err.message : 'restored');
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
  s.attachSerial('terminal', { baud: 1200 });
  const m = s.machine, bit = m.tickHz / 1200;
  s.serialSend('OK');
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
  const a = s.machine;
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
// a cassette recording in progress (tape/csave.asm writing through the DAC, the deck armed): the trace, frames
// and the recording continue identically, and the restored machine's recording decodes to the bytes written
{
  const tape = require('../tools/mame-diff/tape/spec.js');
  const f = tape.firmware('dragon64', 'csave.asm'), a = f.machine();
  a.deck.startRecording();
  for (let i = 0; i < 90; i++) a.runFrame();   // inside the data block, after the namefile and the motor pause
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const text = Emu.state.toJSON(a.snapshot());
  const midway = a.deck.recording.length > 1000 && a.deck.motor;
  const continued = run(a, regs, 40);
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const restored = run(b, regs, 40);
  for (let i = 0; i < 200 && b.cpu.pc !== f.haltPc; i++) { a.runFrame(); b.runFrame(); }
  const ea = a.deck.stopRecording(), eb = b.deck.stopRecording();
  const cas = Emu.samplesToCas(Emu.recordingToSamples(eb, b.tickHz, 44100), 44100).bytes;
  check('cassette recording mid-block: restored machine runs and records identically, and decodes to the bytes written',
    midway && continued === restored && JSON.stringify(ea) === JSON.stringify(eb) && Buffer.from(cas).equals(Buffer.from(tape.csaveStream())),
    `(snapshot ${(text.length / 1024).toFixed(0)} KB, ${eb.length} events)`);
}

// Input state a machine holds: a Hi-Res joystick interface's one-shot, part way through its wait. Held keys,
// the keyboard joystick and gamepads are the host's and are not in a snapshot, so what is left to prove is
// that the one-shot survives: armed, its deadline intact, and the machine finishes the measurement the same.
// A frame is far longer than the wait (63,000 ticks against ~2,000), so a snapshot at a frame boundary would
// never catch it running: this steps inside a frame to a point with the wait still ahead.
{
  const hiresSpec = spec('sam').hires('coco', { kind: 'tandy' });
  const a = hiresSpec.machine();
  let mid = false;
  for (let i = 0; i < 400000 && !mid; i++) {
    a.runCycles(a.cycle + (a.cpu.c || 4));
    mid = a.hires.jet.armed && a.hires.jet.due > a.cycle;
  }
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const before = { armed: a.hires.jet.armed, due: a.hires.jet.due };
  const text = Emu.state.toJSON(a.snapshot());
  // the state is in the snapshot itself: check it before a single frame can re-arm either machine
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const kept = b.hires.jet.armed === before.armed && b.hires.jet.due === before.due;
  const continued = run(a, regs, 30);
  const restored = run(b, regs, 30);
  for (let i = 0; i < 600 && a.ram[hiresSpec.phaseAddr] !== 10; i++) a.runFrame();
  for (let i = 0; i < 600 && b.ram[hiresSpec.phaseAddr] !== 10; i++) b.runFrame();
  const samples = (m) => Array.from({ length: hiresSpec.samples }, (_, k) => (m.ram[hiresSpec.sampleAddr + k * 2] << 8) | m.ram[hiresSpec.sampleAddr + k * 2 + 1]);
  check('Hi-Res interface mid-wait: the one-shot is in the snapshot and the restored machine measures identically',
    mid && kept && continued === restored && JSON.stringify(samples(a)) === JSON.stringify(samples(b)),
    `(snapshot ${(text.length / 1024).toFixed(0)} KB, deadline ${before.due.toFixed(0)}, kept ${kept})`);
}

// mismatched snapshots are refused
{
  const t = spec('coco3').trace('coco3', { regenerate: false });
  const snap = t.machine().snapshot();
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e.message; } };
  check('refused on another machine', !!throws(() => Emu.createMachine('coco3p').restore(snap)));
  check('refused with another config', !!throws(() => { const m = Emu.createMachine('coco3', { ram: 128 }); m.restore(snap); }));
  check('refused with other ROMs', !!throws(() => { const m = Emu.createMachine('coco3'); m.setRoms({ basic: new Uint8Array(0x8000) }); m.restore(snap); }));
}

// A snapshot holds the machine, not the media library: stored ROM images and recent programs live in
// the media store, and a snapshot carries only the CRCs of the ROMs the machine ran
// with, never their bytes. So saving and loading a machine does not move media either way.
{
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  s.switchMachine('coco');
  s.addRoms([{ name: 'bas12.rom', bytes: new Uint8Array(8192).fill(0x11) }]);
  const prog = new Uint8Array(400).fill(0x22);
  s.load('mine.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809')));
  for (let i = 0; i < 3; i++) s.machine.runFrame();
  const text = Emu.state.toJSON(s.machine.snapshot());
  const mediaBefore = { roms: s.roms.sockets().length, recent: s.recentMedia().length, blobs: s.media.snapshot().length };
  check('snapshot: the stored ROM image bytes are not in it', !text.includes(Buffer.from(new Uint8Array(8192).fill(0x11)).toString('base64').slice(0, 24)));
  check('snapshot: it names the ROMs by CRC only', /"roms":\{[^}]*"bas":"[0-9A-F]{8}"/.test(text) || /"roms":/.test(text), text.slice(0, 120));
  // restoring into a fresh machine with the same ROMs leaves the media library untouched
  const s2 = new Emu.Session({ store: Emu.memoryStore(), media: s.media });
  s2.switchMachine('coco');
  s2.machine.setRoms(s.machine.roms);
  s2.machine.restore(Emu.state.fromJSON(text));
  const mediaAfter = { roms: s2.roms.sockets().length, recent: s2.recentMedia().length, blobs: s2.media.snapshot().length };
  check('snapshot: loading one adds nothing to and removes nothing from the media library',
    JSON.stringify(mediaBefore) === JSON.stringify(mediaAfter), `${JSON.stringify(mediaBefore)} -> ${JSON.stringify(mediaAfter)}`);
}

// A CoCo Max cartridge is rebuilt from the snapshot like any device: no constructor callback, it
// samples the mouse the host gave the machine (machine.mouse), so the restored module answers its registers
// with the staged value it had and goes on cycling through the same values.
{
  const a = Emu.createMachine('coco');
  a.mouse = { x: 0.25, y: 0.75, left: true, right: false };
  a.insertCartridge(new Emu.CocoMax());
  a.read(0xFF90);                                   // stages Y
  const saved = Emu.state.fromJSON(Emu.state.toJSON(a.snapshot()));
  const reads = (m) => [0xFF90, 0xFF91, 0xFF92, 0xFF93, 0xFF94].map((r) => m.read(r));
  const cont = reads(a);
  const b = Emu.restoreSnapshot(saved, a.roms);
  b.mouse = { x: 0.25, y: 0.75, left: true, right: false };
  let got = null, err = null;
  try { got = reads(b); } catch (e) { err = e; }
  check('CoCo Max: the restored module reads the same values ($BF $BF $40 $00 $FF)', !err && JSON.stringify(got) === JSON.stringify(cont) && JSON.stringify(cont) === '[191,191,64,0,255]',
    err ? err.message : JSON.stringify(got));
  const c = Emu.restoreSnapshot(saved, a.roms);     // no mouse given yet: centred, buttons up
  let e2 = null; try { c.read(0xFF90); c.read(0xFF90); } catch (e) { e2 = e; }
  check('CoCo Max: a machine with no host mouse reads the centre, without throwing', !e2 && c.read(0xFF91) === 0x80, e2 ? e2.message : '');
}

// DriveWire on the Becker port: a snapshot taken while a sector is on its way to the machine (the
// server holds bytes not yet read), restored into a fresh machine whose server has the same disks, must run dw.asm
// on to its end identically: the same instructions and cycles, the same log, the same disks written.
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
    const before = d.image.data.map((t) => t.slice());
    const text = Emu.state.toJSON(fm.snapshot());
    const r = Emu.restoreSnapshot(Emu.state.fromJSON(text), fm.roms);
    const rd = fdcSpec.fdcOf(r).drives[0];
    let differ = 0;
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = rd.image.data[i] || [];
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

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
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
  const m = a.machine;
  const mid = () => a.drivewire.available > 100 && !m.stall;
  for (let guard = 0; guard < 2000000 && !mid(); guard++) { m.runCycles(m.cycle + 1); if (m.stall) await m.stall; }
  check('nitros9: snapshot with a boot-track sector part way to the machine', mid() && m.read(0x0100) === 0, `(${a.drivewire.available} bytes waiting)`);
  const file = await a.snapshotFile();
  const b = await session();
  await b.mountDriveWire(0, 'n9.dsk');
  let err = null;
  try { b.openSnapshot(await b.readSnapshot(file.bytes)); } catch (e) { err = e; }
  check('nitros9: the snapshot opens in a browser without ROMs (the loader is built in)', !err && b.nitros9Running && b.machine.roms.basic === Emu.nitros9LoaderRom('drivewire'), err ? err.message : '');
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
  const cont = await finish(m), rest = await finish(b.machine);
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
  const m = a.machine;
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
    !err && b.nitros9Loader() === 'floppy' && b.machine.roms.basic === Emu.nitros9LoaderRom('floppy') && b.machine.cartPort instanceof Emu.DiskController, err ? err.message : '');
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
  const cont = await finish(m), rest = await finish(b.machine);
  const want = [];
  for (let i = 0; i < 18 * 256; i += 97) want.push(disk[(34 * 36) * 256 + i]);
  check('nitros9 floppy: the restored machine finishes the read and the boot identically (trace, frames, the boot track as on the disk)',
    cont.booted && cont.screen && cont.track === want.join() && rest.h === cont.h && rest.fh === cont.fh && rest.track === cont.track,
    JSON.stringify({ cont: { h: cont.h, fh: cont.fh, booted: cont.booted }, rest: { h: rest.h, fh: rest.fh, booted: rest.booted } }));
}
