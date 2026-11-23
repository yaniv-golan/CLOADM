// The CoCo 3's bus log (js/machines/halt-replay.js logBus): the accesses of the instruction under way, kept so that an
// instruction HALT suspended can be run again and replay them instead of making them a second time. It is carried
// only while HALT can be asserted.
//
// Who can assert HALT: a device declaring Device.canHalt (the CoCo FDC alone; a Multi-Pak answers for the cartridges
// in its slots), or anything calling setLine(source, 'halt', level) - the CPU's own HALT line is the second half of
// the rule, so a test's or a debugger's line cannot suspend an instruction against an empty log. The log is live, so
// a device attached after an instruction started needs nothing from before it came: nothing attaches a device from
// inside a step (refused, Machine.insertCartridge), and an instruction held by HALT is at an I/O access, where the
// device answered for itself.
//
// Oracle for "the log is off": the machine runs identical frames whether or not the log is carried (the same
// instructions, registers and cycle counts, and the same rendered frame); for "the log is on": a held instruction
// replays its accesses (the controller sees no second read, and the TFM's overlapping copy keeps the bytes it read)
// and a snapshot restores it. Nothing here reads a real ROM: the firmware is written by hand into RAM.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const fdc = () => new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
// every instruction and its registers, hashed: how two runs are compared
function traceHash(m, frames) {
  let h = 0x811C9DC5, n = 0;
  const fnv = (v) => { h = Math.imul(h ^ v, 16777619) >>> 0; };
  m.cpu.trace = (c) => { n++; for (const r of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc', 'dp', 'totalCycles']) fnv(c[r]); };
  for (let i = 0; i < frames; i++) m.runFrame();
  m.cpu.trace = null;
  return { h, n, frame: Emu.frameToRGBA(m.render()).join('') };
}
// a put of the CoCo 3's own speed and memory: a program that writes and reads RAM, I/O and both, for `frames`
function busyMachine({ cart = null } = {}) {
  const m = Emu.createMachine('coco3');
  if (cart) m.insertCartridge(cart);
  m.reset(true);
  // STA/LDA over RAM, PIA0, the GIME's palette, a 6309-free loop: 8 instructions a pass
  const code = [0x86, 0x5A, 0xF7, 0x3000, 0xB6, 0x3000, 0xF7, 0xFF, 0x20, 0xB6, 0xFF, 0x01, 0xF7, 0x3001,
    0x7C, 0x3002, 0x20, 0xEE];
  code.forEach((b, i) => m.poke(0x3100 + i, b));
  m.cpu.pc = 0x3100; m.cpu.cc |= 0x50;
  return m;
}

// ---------------- who can assert HALT, and whether the log is carried ----------------
{
  const m = Emu.createMachine('coco3'); m.reset(true);
  check('no cartridge: no HALT-capable device, the bus log is not carried', m.halt.logBus === false && m.cartPort === null);
  m.insertCartridge(new Emu.RomCartridge(new Uint8Array(0x2000)));
  check('a plain Program Pak: still no HALT-capable device, the log is not carried', m.halt.logBus === false && m.cartPort.canHalt === false);
  m.ejectCartridge();
  m.insertCartridge(fdc());
  check('the CoCo FDC: HALT-capable, the log is carried', m.halt.logBus && m.cartPort.canHalt === true);
  m.ejectCartridge();
  check('the controller taken out: the log is not carried any more', m.halt.logBus === false && m.cartPort === null);
  // the Dragon and Premier boards drive no HALT line in this emulator (fdc.js updateLines)
  for (const type of ['dragonfdc', 'premierfdc']) {
    const d = Emu.createMachine('coco3'); d.reset(true);
    d.insertCartridge(new Emu.devices[type]({ rom: new Uint8Array(0x2000) }));
    check(`${type}: no HALT line, the log is not carried`, d.halt.logBus === false);
  }
  // a Multi-Pak answers for its slots
  const mp = Emu.createMachine('coco3'); mp.reset(true);
  mp.insertCartridge(new Emu.devices.multi([new Emu.RomCartridge(new Uint8Array(0x2000)), null, null, null]));
  check('a Multi-Pak with a plain Program Pak: no HALT, the log is not carried', mp.halt.logBus === false);
  mp.ejectCartridge();
  check('the Multi-Pak itself taken out: no HALT, the log is not carried', mp.halt.logBus === false);
  mp.insertCartridge(new Emu.devices.multi([null, fdc(), null, null]));
  check('a Multi-Pak with the CoCo FDC in slot 2: HALT-capable, the log is carried', mp.halt.logBus);
  // the FDC moved between slots the way the page does it (js/ui/multipak-panel.js builds a new Multi-Pak and
  // Session.insertMultiPak puts it in over the old one)
  mp.insertCartridge(new Emu.devices.multi([new Emu.RomCartridge(new Uint8Array(0x2000)), null, null, null]));
  check('the FDC taken out of its slot (a Multi-Pak rebuilt with only a Program Pak, put in): the log is not carried', mp.halt.logBus === false);
  mp.insertCartridge(new Emu.devices.multi([null, null, fdc(), null]));
  check('the FDC moved to slot 3 (rebuilt and put in over the old one): the log is carried again', mp.halt.logBus);
  mp.insertCartridge(new Emu.devices.multi([fdc(), null, null, null]));
  check('a Multi-Pak rebuilt with the FDC in slot 1, put in over the old one: the log is carried', mp.halt.logBus);
  mp.insertCartridge(new Emu.devices.multi([null, null, null, null]));
  check('...and rebuilt with every slot empty: the log is not carried', mp.halt.logBus === false);
  // a Multi-Pak nested in another is refused (nothing could find its HALT tree)
  const nest = () => new Emu.devices.multi([new Emu.devices.multi([fdc()]), null, null, null]);
  check('a Multi-Pak inside a Multi-Pak is refused at once', (() => { try { nest(); return false; } catch (e) { return /cannot hold another Multi-Pak/.test(e.message); } })());
  // a test asserting HALT directly, no device: the CPU's line keeps the CPU halted, but between instructions - it
  // cannot hold an instruction, so the log is not needed
  mp.ejectCartridge();
  const h = Emu.createMachine('coco3'); h.reset(true);
  // (`=== false`, not `!`: an older machine has no logBus at all, and !undefined would pass this)
  check('nothing attached, HALT not asserted: the log is not carried', h.halt.logBus === false);
  h.setLine('test', 'halt', true);
  check('a test asserting HALT with no device: the line halts the CPU between instructions, the log is not carried', h.halt.logBus === false && h.cpu.haltLine);
  h.setLine('test', 'halt', false);
  check('...and released again', h.halt.logBus === false && !h.cpu.haltLine);
  // and a line from a source with no log behind it, asserted from INSIDE a step (an event, a hook): it must not
  // suspend the instruction - with nothing logged the replay would drop it and its accesses would happen twice. It
  // halts the CPU between instructions, which is what a line with no device-tree delay does.
  for (const cart of [null, new Emu.RomCartridge(new Uint8Array(0x2000))]) {
    const g = Emu.createMachine('coco3');
    if (cart) g.insertCartridge(cart);
    g.reset(true);
    // LDA $FF00; BRA * : an I/O read the hold would be taken at, so the old code would suspend it
    [0xB6, 0xFF, 0x00, 0x20, 0xFB].forEach((b, i) => g.poke(0x3100 + i, b));
    g.cpu.pc = 0x3100; g.cpu.cc |= 0x50;
    const r0 = g.redirects;
    // the assert fires inside the step: a scheduled event 10 ticks after the frame's start, with the LDA of $FF00
    // under way (20 ticks long), so it lands between two of its cycles
    let where = null;
    g.schedule(g.tickAt(10), 'probe', null);
    let setErr = null;
    g.on('probe', () => { where = { inStep: g.inStep, c: g.cpu.c }; try { g.setLine('probe', 'halt', true); } catch (e) { setErr = e; } });
    let held = 0;
    for (let i = 0; i < 3; i++) { g.runFrame(); if (g.halt.haltDefer) held++; }
    g.setLine('probe', 'halt', false);
    check(`a non-device HALT asserted inside a step${cart ? ' (a Program Pak in)' : ' (nothing in the port)'}: no instruction is suspended or dropped`,
      !!where && where.inStep && where.c > 0 && !setErr && held === 0 && g.redirects === r0 && !g.cpu.haltLine,
      `asserted at ${JSON.stringify(where)}; held ${held} redirects +${g.redirects - r0}${setErr ? `; threw ${setErr.message}` : ''}`);
  }
}

// ---------------- the guards that keep canHalt from rotting ----------------
// A device that drives HALT without declaring it would suspend an instruction against a log that is not carried.
// The machine refuses it at the first HALT, naming the device, rather than silently losing the replay.
{
  class Sneaky extends Emu.Device {
    constructor() { super('sneaky'); }
    writeIO(a, v) { if (a === 0xFF42) this.host.setLine('sneaky', 'halt', !!v); }
  }
  const m = Emu.createMachine('coco3'); m.reset(true); m.runFrame();
  m.insertCartridge(new Sneaky());
  let err = null;
  try { m.write(0xFF42, 1); } catch (e) { err = e; }
  check('a device driving HALT without canHalt: refused at once, naming it, and nothing halted',
    !!err && /sneaky/.test(err.message) && /canHalt/.test(err.message) && !m.cpu.haltLine && m.cpu.haltLine === false,
    err ? err.message : 'asserted without complaint');
  check('...and a device declaring it (a class override) is accepted', (() => {
    const d = Emu.createMachine('coco3'); d.reset(true); d.runFrame();
    class Honest extends Sneaky { get canHalt() { return true; } }
    d.insertCartridge(new Honest());
    try { d.write(0xFF42, 1); return d.cpu.haltLine === true && d.halt.logBus; } catch (e) { return false; }
  })());
  // a port change is refused inside an instruction: it would let the step under way be suspended against a bus log
  // that started late. A programmer error (nothing in the page, the Session or the debugger attaches mid-step), refused
  // loudly; between instructions it is allowed.
  const inside = Emu.createMachine('coco3');
  let inErr = null;
  inside.reset(true);
  try { inside.insertCartridge(fdc()); } catch (e) { inErr = e; }
  check('a cartridge attached between instructions is attached at once', !inErr && !!inside.cartPort, inErr ? inErr.message : '');
  const s2 = Emu.createMachine('coco3');
  s2.reset(true);
  let stepErr = null, calls = 0;
  s2.cpu.trace = () => { calls++; if (!stepErr) { try { s2.insertCartridge(fdc()); } catch (e) { stepErr = e; } } };
  s2.runFrame();
  s2.cpu.trace = null;
  check('inside a step, attaching a cartridge is refused, naming the rule, and the frame still runs',
    calls > 1000 && !!stepErr && /inside an instruction/.test(stepErr.message) && !s2.cartPort,
    stepErr ? stepErr.message : 'attached');
  const s3 = Emu.createMachine('coco3');
  s3.reset(true); s3.insertCartridge(fdc());
  let outErr = null;
  s3.cpu.trace = () => { if (!outErr) { try { s3.ejectCartridge(); } catch (e) { outErr = e; } } };
  s3.runFrame();
  s3.cpu.trace = null;
  check('inside a step, taking a cartridge out is refused, naming the rule, and it stays in',
    !!outErr && /inside an instruction/.test(outErr.message) && !!s3.cartPort,
    outErr ? outErr.message : 'taken out');
}
// ---------------- the log off changes nothing ----------------
// The same program on a CoCo 3 with no cartridge, run once as it is and once with the log forced on: identical
// instructions, registers, cycle counts and rendered frame. (Built with the same code; the forced run is the
// machine before this change, which logged every access.)
{
  const a = busyMachine(), b = busyMachine();
  b.halt.busHalt = true;              // the switch read() and write() test, forced on: the run that logs every access
  // count the accesses each run logs, at busLogged itself (busN is cleared every step, so reading it after the run
  // would prove nothing): the shipped machine must log none, the forced one must log them all
  let logged = 0, forced = 0;
  const realA = a.halt.busLogged.bind(a.halt), realB = b.halt.busLogged.bind(b.halt);
  const countA = (x, v) => { logged++; return realA(x, v); }, countB = (x, v) => { forced++; return realB(x, v); };
  a.halt.busLogged = countA; b.halt.busLogged = countB;
  let ra, rb;
  try { ra = traceHash(a, 30); rb = traceHash(b, 30); }
  finally { b.halt.busHalt = false; a.halt.busLogged = realA; b.halt.busLogged = realB; }
  check('CoCo 3, no cartridge: the frames and every instruction are the same with the log on and off',
    ra.n > 1000 && ra.h === rb.h && ra.n === rb.n && ra.frame === rb.frame, `${ra.n} vs ${rb.n} instructions`);
  check('...and with no cartridge a run of 30 frames logs not one access, where the forced run logs them',
    !a.halt.logBus && !a.halt.busHalt && a.halt.haltDefer === null && logged === 0 && forced > 1000, `logged ${logged}, forced ${forced}`);
}

// ---------------- the log is carried with the controller, and a held instruction replays it ----------------
// A 6309 TFM whose source overlaps its destination, held on an empty drive's data register: run again after the
// release, each byte it read is the byte it read then, not the one it has since written itself. HALT disabled in the
// drive select latch gives what the run must end with (tests/halt-replay.test.js's oracle, here on the log's own
// switch).
function tfmRun({ select, cart = true, release = true }) {
  const m = Emu.createMachine('coco3', { cpu: '6309' });
  if (cart) m.insertCartridge(fdc());
  m.reset(true);
  const f = m.cartPort;
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  for (let a = 0xFEF0; a < 0xFF00; a++) m.poke(a, 0x10 + (a & 0x7F));
  const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, select, 0xF7, 0xFF, 0x40,
    0x11, 0x38, 0x12, 0x20, 0xFE];
  code.forEach((b, i) => m.poke(0x3000 + i, b));
  const BRA = 0x3000 + code.length - 2;
  m.cpu.x = 0xFEF0; m.cpu.y = 0xFEEF; m.cpu.w = 17; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  let held = 0;
  for (let i = 0; i < 3; i++) { m.runFrame(); if (m.halt.haltDefer) held++; }
  const logBus = m.halt.logBus, logged = m.halt.haltDefer ? m.halt.haltDefer.log.length / 2 : 0;
  // snapshot: taken while held, before the release
  const snap = release ? null : m.snapshot();
  if (release) m.write(0xFF48, 0xD8);          // Force Interrupt: INTRQ drops HALT
  for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame();
  const mem = Array.from({ length: 17 }, (_, i) => m.peek(0xFEEF + i));
  return { m, held, done: m.cpu.pc === BRA && !m.halt.haltDefer, mem, logBus, logged, snap };
}
{
  const free = tfmRun({ select: 0x0A }), held = tfmRun({ select: 0x8A });
  check('CoCo FDC attached: the log is carried, and the held TFM logged its accesses', held.logBus && held.logged >= 4, `${held.logged} accesses`);
  check('the held TFM completes after the release, with the memory of the run without HALT',
    held.held >= 2 && held.done && free.done && held.mem.join() === free.mem.join(),
    held.mem.join() === free.mem.join() ? '' : `held ${held.mem.slice(0, 6)} free ${free.mem.slice(0, 6)}`);
  // the same instruction with the controller attached from the start, to compare with the hot-plug run below
  const cold = tfmRun({ select: 0x8A });
  check('cold insert: the held TFM logs its accesses and completes', cold.held >= 2 && cold.logged >= 4 && cold.done,
    `held ${cold.held} log ${cold.logged} done ${cold.done}`);
}

// ---------------- a device attached after the session started ----------------
// The log is live. A CoCo 3 runs with no cartridge for a while, the FDC goes in (no reset), and the DOS-style read
// that leaves HALT asserted on an empty drive follows. What replay needs from BEFORE the attach: nothing of the
// machine's, because an attach never happens inside a step (a cartridge is put in between frames, from the page, the
// Session or a debugger; nothing runs a step), so no instruction under way at the attach can be suspended against a
// log that started late. The held instruction is one whose whole log was made after the device came, and by the
// time it is held its log has every access it made. This is checked against the cold insert: same held count, same
// log, and the same bytes written.
// (a check that fails still lets the rest run and the summary print: what a mutation has to show, not a crash)
const FAILED = (why) => ({ err: why, held: 0, logged: 0, dropped: -1, done: false, mem: [], crash: null });
function hotPlugRun({ hot }) {
  const m = Emu.createMachine('coco3', { cpu: '6309' });
  if (!hot) m.insertCartridge(fdc());
  m.reset(true);
  for (let i = 0; i < 5; i++) m.runFrame();
  if (hot) {
    if (m.halt.logBus) return FAILED('the log was carried with no cartridge');
    m.insertCartridge(fdc());
    if (!m.halt.logBus) return FAILED('the insert did not turn the log on');
  }
  const f = m.cartPort;
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  for (let a = 0xFEF0; a < 0xFF00; a++) m.poke(a, 0x10 + (a & 0x7F));
  const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0x8A, 0xF7, 0xFF, 0x40,
    0x11, 0x38, 0x12, 0x20, 0xFE];
  code.forEach((b, i) => m.poke(0x3000 + i, b));
  const BRA = 0x3000 + code.length - 2;
  m.cpu.x = 0xFEF0; m.cpu.y = 0xFEEF; m.cpu.w = 17; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  let held = 0;
  for (let i = 0; i < 3; i++) { m.runFrame(); if (m.halt.haltDefer) held++; }
  const logged = m.halt.haltDefer ? m.halt.haltDefer.log.length / 2 : 0;
  const r0 = m.redirects;
  m.write(0xFF48, 0xD8);
  let crash = null;
  try { for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame(); } catch (e) { crash = e; }
  const mem = Array.from({ length: 17 }, (_, i) => m.peek(0xFEEF + i));
  return { held, logged, dropped: m.redirects - r0, done: m.cpu.pc === BRA && !m.halt.haltDefer, mem, crash };
}
{
  const cold = hotPlugRun({ hot: false }), hot = hotPlugRun({ hot: true });
  check('hot-plug: the CoCo 3 ran without a HALT-capable device, the insert turned the log on, and HALT suspended the TFM',
    !cold.err && !hot.err && hot.held >= 2 && hot.logged > 0, hot.err || `held ${hot.held} log ${hot.logged}`);
  check('hot-plug: the suspended instruction replays correctly - nothing dropped, and the memory of the cold insert',
    !hot.crash && hot.dropped === 0 && hot.done && hot.mem.join() === cold.mem.join(),
    hot.crash ? hot.crash.message : `dropped ${hot.dropped} done ${hot.done} mem ${hot.mem.slice(0, 4)} cold ${cold.mem.slice(0, 4)}`);
  check('hot-plug: the whole log was made after the device came (as for the cold insert)', hot.logged === cold.logged,
    `${hot.logged} vs ${cold.logged}`);
  // The guard against a hold with no log behind it: a machine that never started the log (as this branch was before
  // for the whole machine) must not SUSPEND an instruction - with nothing logged the replay would drop it, making its
  // accesses twice. It halts the CPU between instructions instead, now that HALT from a source with no log behind it
  // cannot fall inside one (coco3.js fireEvent). This is the review's finding, pinned.
  const m = Emu.createMachine('coco3', { cpu: '6309' });
  const setBusHalt = m.devicesAttached.bind(m);
  m.devicesAttached = () => { setBusHalt(); m.halt.busHalt = false; };   // the switch the accesses read, forced off
  let ctl;
  try { ctl = (() => {
    m.insertCartridge(fdc()); m.reset(true);
    const f = m.cartPort;
    f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
    for (let i = 0; i < 3; i++) m.runFrame();
    m.write(0xFF40, 0x29);
    for (let i = 0; i < 30; i++) m.runFrame();
    const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0x8A, 0xF7, 0xFF, 0x40, 0x12, 0xB6, 0xFF, 0x4B, 0x20, 0xF9];
    code.forEach((b, i) => m.poke(0x3000 + i, b));
    m.cpu.x = 0x4000; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
    let held = 0;
    for (let i = 0; i < 3; i++) { m.runFrame(); if (m.halt.haltDefer) held++; }
    const r0 = m.redirects;
    m.write(0xFF48, 0xD8);
    m.setLine('ctl', 'halt', false);
    const crashed = (() => { try { for (let i = 0; i < 3; i++) m.runFrame(); return null; } catch (e) { return e; } })();
    return { held, dropped: m.redirects - r0, crashed, logBus: m.halt.logBus };
  })(); }
  finally { m.devicesAttached = setBusHalt; }
  check('control - a machine that never started the log: HALT holds the CPU between instructions (never a suspended one to drop)',
    ctl.held === 0 && ctl.dropped === 0 && !ctl.crashed && ctl.logBus === false,
    `held ${ctl.held} dropped ${ctl.dropped} ${ctl.crashed ? ctl.crashed.message : ''}`);
}

// ---------------- a snapshot loaded over a machine whose port holds a different device ----------------
// The log follows the file's port, either way: a file with no cartridge restores a machine that stops logging (its
// busHalt must not stay true from the machine it was loaded over), and a file with the controller turns it on.
{
  const withCart = Emu.createMachine('coco3');
  withCart.reset(true); withCart.insertCartridge(fdc()); withCart.runFrame();
  const fileWith = Emu.state.toJSON(withCart.snapshot());
  const bare = Emu.createMachine('coco3');
  bare.reset(true); bare.runFrame();
  const fileNone = Emu.state.toJSON(bare.snapshot());
  const over = Emu.createMachine('coco3');
  over.reset(true); over.insertCartridge(fdc()); over.runFrame();
  over.restore(Emu.state.fromJSON(fileNone));
  check('a no-cartridge file loaded over a machine with the controller: the port is empty and the log stops',
    over.cartPort === null && !over.halt.busHalt && !over.halt.logBus, `cart ${over.cartPort} busHalt ${over.halt.busHalt}`);
  const over2 = Emu.createMachine('coco3');
  over2.reset(true); over2.runFrame();
  over2.restore(Emu.state.fromJSON(fileWith));
  check('a controller file loaded over a machine with nothing: the controller is in and the log starts',
    !!over2.cartPort && over2.halt.busHalt && over2.halt.logBus, `cart ${over2.cartPort && over2.cartPort.type} busHalt ${over2.halt.busHalt}`);
}

// ---------------- a snapshot of a held instruction, restored with and without its device ----------------
{
  const held = tfmRun({ select: 0x8A, release: false });
  const st = Emu.state.toJSON(held.snap);
  // (a machine whose log never ran leaves a held instruction with nothing logged, and the file is refused as damaged:
  // that is a failure for this check, not a crash for the suite)
  const restore = (snap, roms) => { try { return { m: Emu.restoreSnapshot(Emu.state.fromJSON(snap), roms) }; } catch (e) { return { err: e }; } };
  const r = restore(st, held.m.roms);
  check('a snapshot of the held instruction is a file that loads', !r.err, r.err ? r.err.message : '');
  const b = r.m || Emu.createMachine('coco3', { cpu: '6309' });   // (a stand-in: the checks below fail on it)
  check('snapshot of a held instruction restored with its controller: the log is carried, the instruction is kept',
    b.halt.logBus && !!b.halt.haltDefer, `logBus ${b.halt.logBus} defer ${!!b.halt.haltDefer}`);
  b.write(0xFF48, 0xD8);
  let crash = null;
  try { for (let i = 0; i < 3; i++) b.runFrame(); } catch (e) { crash = e; }
  check('...and it completes after the release, as the source did', !crash && !b.halt.haltDefer, crash ? crash.message : '');
  // the same file opened with the controller taken out: the log is gone with it, and releasing HALT drops the
  // suspended instruction (haltCancel's rule for a redirect) instead of replaying against a log that is no longer
  // kept - no crash, the machine runs on
  const r2 = restore(st, held.m.roms);
  const c = r2.m || Emu.createMachine('coco3', { cpu: '6309' });
  try { c.ejectCartridge(); } catch (e) { /* none */ }
  let crash2 = null, ran = 0;
  // (logBus stays true: a held instruction keeps its own log, and its step run again may be held again)
  check('snapshot restored and the controller taken out: the suspended instruction keeps its own log, and still replays',
    c.halt.logBus && !!c.halt.haltDefer && c.halt.haltDefer.log.length > 0);
  c.setLine('test', 'halt', false);
  c.write(0xFF48, 0xD8);
  c.cpu.trace = () => { ran++; };
  try { for (let i = 0; i < 3; i++) c.runFrame(); } catch (e) { crash2 = e; }
  c.cpu.trace = null;
  // the memory as the run with HALT disabled ends: the TFM replayed the bytes it read, not the ones it wrote
  const want = tfmRun({ select: 0x0A }).mem;
  const got = Array.from({ length: 17 }, (_, i) => c.peek(0xFEEF + i));
  check('...and releasing HALT completes it with the memory of the run without HALT',
    !crash2 && !c.halt.haltDefer && ran > 0 && got.join() === want.join(),
    crash2 ? crash2.message : `got ${got.slice(0, 4)} want ${want.slice(0, 4)}`);
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
