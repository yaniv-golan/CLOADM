// The CoCo 3's instruction held by the disk controller's HALT (js/machines/halt-replay.js haltWait / haltSuspend) seen from
// outside the CPU: the CPU redirected while an instruction is suspended (a jump, a loader, the debugger setting a
// register, a snapshot), and the debugger running, stepping and watching across a held instruction.
//
// Redirect rule (MC6809E data sheet, signal descriptions, HALT: the processor halts "at the end of the present
// instruction" and stays halted "without loss of data"): an outside change meets the CPU between instructions, so the
// suspended instruction is dropped, the CPU stays halted while HALT is asserted and runs from the state it was given
// once HALT is released. Debugger oracle (AGENTS.md section 5, Debugger): stops and counts compared with the CPU's own
// trace (cpu.trace, called once per instruction at its start) and with a free run.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const hex = (v) => '$' + v.toString(16).toUpperCase();

// a CoCo 3 with the CoCo FDC, drive 0 read once (which leaves the control latch's DRQ input low), as in
// tests/fdc.test.js emptyDriveRead; start(drive select, sector, loop) runs READ SECTOR with HALT enabled, then `loop`
function machine(config) {
  const m = Emu.createMachine('coco3', config);
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  const DOS = [0x12, 0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF9];
  const start = (dsk, sector = 1, loop = DOS) => {
    [0xC6, sector, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, dsk, 0xF7, 0xFF, 0x40, ...loop].forEach((b, i) => m.poke(0x3000 + i, b));
    m.cpu.x = 0x4000; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  };
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  start(0xA9);
  for (let i = 0; i < 30; i++) m.runFrame();
  return { m, f, start };
}
const HELD = 0x3010, HELD_INC = 0x300F;               // the held instruction: the loop's LDA $FF4B (after its NOP), INC $FF4B
const INC_LOOP = [0x7C, 0xFF, 0x4B, 0x20, 0xFB];        // INC $FF4B: its read made before HALT, its write held
const OTHER = [0xB6, 0xFF, 0x03, 0xB7, 0x50, 0x00, 0x20, 0xFE];   // at $3100: LDA $FF03 (PIA0 CRB), STA $5000, BRA *
const FORCE_INTERRUPT = (m) => m.write(0xFF48, 0xD8);  // INTRQ: clears the latch's HALT enable, HALT goes

// ---------------- 1. the CPU redirected while an instruction is suspended ----------------
// INC $FF4B held on an empty drive (drive 1), suspended at frame ends. The CPU is then redirected to OTHER, or a
// register is set. Expected: the INC is dropped (no write to $FF4B ever), the CPU runs no instruction while HALT is
// asserted, and after the release LDA $FF03 reads PIA0 itself (the value PIA0 returned), not the INC's logged byte.
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }], ['6309', { cpu: '6309' }]]) {
  for (const how of ['cpu.pc', 'Machine.jump', 'Debugger.setRegister pc', 'injectAndRun', 'Debugger.setRegister a', 'snapshot']) {
    const { m, f, start } = machine(config);
    start(0xAA, 1, INC_LOOP);
    OTHER.forEach((b, i) => m.poke(0x3100 + i, b));
    for (let i = 0; i < 5; i++) m.runFrame();
    const was = !!m.halt.haltDefer && m.cpu.pc === HELD_INC && m.cpu.haltLine;
    let fdcReads = 0, fdcWrites = 0, piaReads = [];
    const rd = f.readIO.bind(f), wr = f.writeIO.bind(f), prd = m.pia0.read.bind(m.pia0);
    f.readIO = (a) => { if (a === 0xFF4B) fdcReads++; return rd(a); };
    f.writeIO = (a, v) => { if (a === 0xFF4B) fdcWrites++; wr(a, v); };
    m.pia0.read = (r) => { const v = prd(r); if (r === 3) piaReads.push(v); return v; };
    let ran = 0;
    m.cpu.trace = () => { ran++; };
    let dbg = null, target = 0x3100;
    if (how === 'cpu.pc') m.cpu.pc = 0x3100;
    else if (how === 'Machine.jump') m.jump(0x3100);
    else if (how === 'Debugger.setRegister pc') { dbg = new Emu.Debugger(m); dbg.setRegister('pc', 0x3100); }
    else if (how === 'injectAndRun') m.injectAndRun([{ addr: 0x3100, data: OTHER }], 0x3100);
    else if (how === 'Debugger.setRegister a') { dbg = new Emu.Debugger(m); dbg.setRegister('a', 0x12); target = HELD_INC; }
    else {
      // a snapshot taken after the change (the change drops the instruction: the file doesn't carry it stale)
      m.cpu.pc = 0x3100;
      const st = m.saveState();
      check(`redirect while suspended (${label}, ${how}): the snapshot taken after the change holds no suspended instruction`, st.haltDefer === null);
    }
    // injectAndRun without ROMs resets the stub machine: a reset drops the instruction too, and the CPU isn't halted then
    const reset = how === 'injectAndRun' && m.useStub;
    for (let i = 0; i < 3; i++) m.runFrame();
    if (!reset) {
      check(`redirect while suspended (${label}, ${how}): no instruction runs while HALT is asserted, none held`,
        was && ran === 0 && m.halt.haltDefer === null && m.cpu.haltLine && m.cpu.pc === target, `was ${was} ran ${ran} defer ${!!m.halt.haltDefer} pc ${hex(m.cpu.pc)} halt ${m.cpu.haltLine}`);
      FORCE_INTERRUPT(m);
      for (let i = 0; i < 2; i++) m.runFrame();
    }
    if (target === 0x3100) {
      check(`redirect while suspended (${label}, ${how}): after the release LDA $FF03 reads PIA0 (${piaReads.map(hex)}), not the INC's byte; the INC's write never happens`,
        piaReads.length >= 1 && m.ram[0x5000] === piaReads[0] && fdcWrites === 0 && m.cpu.pc === 0x3106,
        `$5000 ${hex(m.ram[0x5000])} pia ${piaReads.map(hex)} writes ${fdcWrites} pc ${hex(m.cpu.pc)}`);
    } else {
      // a register set: the INC runs again from its start, its read of $FF4B made again (not replayed), then its write
      check(`redirect while suspended (${label}, ${how}): after the release the INC runs from its start, its read made again`,
        fdcReads >= 1 && fdcWrites >= 1 && m.halt.haltDefer === null && m.cpu.a === 0x12, `reads ${fdcReads} writes ${fdcWrites} a ${hex(m.cpu.a)}`);
    }
    m.cpu.trace = null;
    if (dbg) dbg.detach();
  }
}

// memory the suspended instruction had fetched written from outside (the debugger's memory view, a poke tool): the
// instruction is dropped as for a register (its code is now another instruction); a write elsewhere, and a register
// written with the value it has, keep it
for (const [label, config] of [['hardware timing', undefined], ['6309', { cpu: '6309' }]]) {
  for (const how of ['Debugger.write over the code', 'Machine.poke over the code', 'Debugger.write elsewhere', 'Debugger.setRegister same value']) {
    const { m, f, start } = machine(config);
    start(0xAA, 1, INC_LOOP);
    for (let i = 0; i < 5; i++) m.runFrame();
    const was = !!m.halt.haltDefer;
    let fdcReads = 0, fdcWrites = 0, piaReads = [];
    const rd = f.readIO.bind(f), wr = f.writeIO.bind(f), prd = m.pia0.read.bind(m.pia0);
    f.readIO = (a) => { if (a === 0xFF4B) fdcReads++; return rd(a); };
    f.writeIO = (a, v) => { if (a === 0xFF4B) fdcWrites++; wr(a, v); };
    m.pia0.read = (r) => { const v = prd(r); if (r === 3) piaReads.push(v); return v; };
    const dbg = new Emu.Debugger(m);
    const over = how.endsWith('over the code');
    if (how === 'Debugger.write over the code') dbg.write(HELD_INC, OTHER);
    else if (how === 'Machine.poke over the code') OTHER.forEach((b, i) => m.poke(HELD_INC + i, b));
    else if (how === 'Debugger.write elsewhere') dbg.write(0x5800, [1, 2, 3]);
    else dbg.setRegister('pc', m.cpu.pc);
    for (let i = 0; i < 3; i++) dbg.runFrame();
    const kept = !!m.halt.haltDefer;
    FORCE_INTERRUPT(m);
    for (let i = 0; i < 2; i++) dbg.runFrame();
    if (over) {
      check(`code written under a suspended INC (${label}, ${how}): dropped; after the release LDA $FF03 reads PIA0, the INC's write never happens`,
        was && !kept && piaReads.length >= 1 && m.ram[0x5000] === piaReads[0] && fdcWrites === 0 && fdcReads === 0, `kept ${kept} $5000 ${hex(m.ram[0x5000])} pia ${piaReads.map(hex)} r/w ${fdcReads}/${fdcWrites}`);
    } else {
      check(`a suspended INC (${label}, ${how}): kept; after the release it completes with its read replayed, not made again (one write more than reads as the loop runs on)`,
        was && kept && fdcReads > 0 && fdcWrites === fdcReads + 1 && m.halt.haltDefer === null, `kept ${kept} r/w ${fdcReads}/${fdcWrites}`);
    }
    dbg.detach();
  }
}

// a breakpoint added on a suspended instruction, then the instruction dropped by an outside change other than the
// debugger's (a register written directly, Machine.jump to the same address): the CPU is between instructions at
// that address, so the breakpoint stops before the instruction runs from its start
for (const how of ['cpu.a written', 'Machine.jump to the same PC']) {
  const { m, start } = machine();
  start(0xAA, 1, INC_LOOP);
  const dbg = new Emu.Debugger(m);
  dbg.addBreakpoint(0x0000);
  for (let i = 0; i < 5; i++) dbg.runFrame();
  dbg.addBreakpoint(HELD_INC);
  let ran = 0;
  m.cpu.trace = (c) => { if (c.pc === HELD_INC) ran++; };
  if (how === 'cpu.a written') m.cpu.a ^= 0x55; else m.jump(HELD_INC);
  FORCE_INTERRUPT(m);
  let stopped = false;
  for (let i = 0; i < 3 && !stopped; i++) stopped = !dbg.runFrame();
  m.cpu.trace = null;
  check(`a suspended INC dropped by ${how}, a breakpoint on it: stops before it runs again`,
    stopped && dbg.stopReason.kind === 'breakpoint' && m.cpu.pc === HELD_INC && ran === 0 && m.halt.haltDefer === null, `stopped ${stopped} ${JSON.stringify(dbg.stopReason)} ran ${ran}`);
  dbg.detach();
}

// memory the instruction never read keeps it: INC ,X (X = $FF4B) presents the next opcode's address in an idle cycle,
// which reads nothing; that byte written (and put back before the release) keeps the INC: the run is the run without
// the write (the data register's reads, the trace)
const idleCycle = (write) => {
  const { m, f, start } = machine();
  start(0xAA, 1, [0x8E, 0xFF, 0x4B, 0x6C, 0x84, 0x20, 0xFC]);   // LDX #$FF4B; INC ,X ($3012); BRA
  for (let i = 0; i < 5; i++) m.runFrame();
  const held = !!m.halt.haltDefer && m.cpu.pc === 0x3012;
  const idle = [...m.halt.haltDefer.mem].filter((v, i) => i % 2 === 0).includes(0x3014);
  let reads = 0;
  const rd = f.readIO.bind(f);
  f.readIO = (a) => { if (a === 0xFF4B) reads++; return rd(a); };
  const dbg = new Emu.Debugger(m);
  if (write) dbg.write(0x3014, [0x12]);
  m.runFrame();
  if (write) dbg.write(0x3014, [0x20]);
  m.runFrame();
  const kept = !!m.halt.haltDefer;
  const t = [];
  m.cpu.trace = (c) => { if (t.length < 400) t.push(c.pc, c.totalCycles); };
  FORCE_INTERRUPT(m); m.runFrame();
  m.cpu.trace = null;
  dbg.detach();
  return { held, idle, kept, reads, t: t.join() };
};
{
  const a = idleCycle(false), b = idleCycle(true);
  check('a suspended INC ,X: the byte of its idle cycle written from outside keeps it; the run is the run without the write',
    b.held && !b.idle && b.kept && a.reads === b.reads && a.t === b.t, `held ${b.held} idle ${b.idle} kept ${b.kept} reads ${a.reads}/${b.reads} same trace ${a.t === b.t}`);
}

// a snapshot keeps what the instruction's bus cycles saw: after a round trip, a change to INC [,X]'s pointer drops it
// (as without the round trip) and a change elsewhere (past its code) keeps it
for (const how of ['pointer', 'elsewhere', 'none']) {
  const run = (trip) => {
    const { m, f, start } = machine();
    m.poke(0x4000, 0xFF); m.poke(0x4001, 0x4B);
    start(0xAA, 1, [0x6C, 0x94, 0x20, 0xFC]);          // INC [,X] (X = $4000 -> $FF4B); BRA
    for (let i = 0; i < 5; i++) m.runFrame();
    let mm = m;
    if (trip) { mm = machine().m; mm.loadState(Emu.state.fromJSON(Emu.state.toJSON(m.saveState()))); }
    if (how === 'pointer') mm.poke(0x4001, 0x4A);
    else if (how === 'elsewhere') mm.poke(0x3013, 0xFD);
    mm.runFrame();
    const kept = !!mm.halt.haltDefer;
    const t = [];
    mm.cpu.trace = (c) => { if (t.length < 50) t.push(c.pc, c.totalCycles); };
    FORCE_INTERRUPT(mm); mm.runFrame(); mm.runFrame();
    return { kept, t: t.join() };
  };
  const a = run(false), b = run(true);
  check(`a suspended INC [,X], change: ${how}: the same after a snapshot round trip (${a.kept ? 'kept' : 'dropped'}, the same trace)`,
    a.kept === (how !== 'pointer') && b.kept === a.kept && a.t === b.t && a.t.length > 0, `kept ${a.kept}/${b.kept} same trace ${a.t === b.t}`);
}

// the debugger never stops at an instruction under way: after a breakpoint's one stop the instruction is suspended;
// a snapshot round trip (the machine's, with its debugger), or a debugger made only once it is held (the page runs
// the machine without one while nothing is set), doesn't stop at it again
for (const how of ['snapshot round trip', 'debugger made while held']) {
  const { m, start } = machine();
  start(0xAA, 1, INC_LOOP);
  let dbg, stops = 0;
  if (how === 'snapshot round trip') {
    dbg = new Emu.Debugger(m);
    dbg.addBreakpoint(HELD_INC);
    for (let i = 0; i < 5; i++) if (!dbg.runFrame()) { stops++; dbg.resume(); }
    m.loadState(Emu.state.fromJSON(Emu.state.toJSON(m.saveState())));
  } else {
    for (let i = 0; i < 5; i++) m.runFrame();
    dbg = new Emu.Debugger(m);
    dbg.addBreakpoint(HELD_INC);
  }
  const before = stops;
  for (let i = 0; i < 5; i++) if (!dbg.runFrame()) { stops++; dbg.resume(); }
  check(`breakpoint on a suspended INC, ${how}: no stop while it is under way`,
    (how === 'snapshot round trip' ? before === 1 : before === 0) && stops === before && !!m.halt.haltDefer && m.cpu.pc === HELD_INC, `stops ${before}/${stops} held ${!!m.halt.haltDefer}`);
  dbg.detach();
}

// a dropped instruction's wait counts in the CPU's cycles, as a kept one's does: the machine's time and the CPU's
// cycles stay in step (a jump to the same address, against no jump)
{
  const drift = (jump) => {
    const { m, start } = machine();
    start(0xAA, 1, INC_LOOP);
    for (let i = 0; i < 5; i++) m.runFrame();
    if (jump) m.jump(HELD_INC);
    FORCE_INTERRUPT(m);
    for (let i = 0; i < 3; i++) m.runFrame();
    return { d: m.cycle - m.cpu.totalCycles * m.div, div: m.div };
  };
  const a = drift(false), b = drift(true);
  check('a dropped instruction: the CPU\'s cycles keep up with the machine\'s time as a kept one\'s do',
    a.div === b.div && Math.abs(a.d - b.d) <= 32 * a.div, `drift ${a.d} vs ${b.d}`);
}
// ...also one that changed the CPU speed before its held access (STD ,X with X = $FFD8 at 1.78 MHz: its write to $FFD8
// slows the CPU, its write to $FFD9 is held): the cycles up to the end of that write (the instruction's cycle count at
// it, speedChange) at the old rate, the rest of the time at the new rate, as clockChanged places a speed change; the
// halted cycles after the drop then count at the new rate too
{
  const m = Emu.createMachine('coco3');
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f); m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  // STA $FFD9 (1.78 MHz); READ SECTOR on drive 1 (empty) with HALT; NOP; STD ,X; BRA *
  [0xB7, 0xFF, 0xD9, 0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0xAA, 0xF7, 0xFF, 0x40,
    0x12, 0xED, 0x84, 0x20, 0xFE].forEach((b, i) => m.poke(0x3000 + i, b));
  m.cpu.x = 0xFFD8; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  for (let i = 0; i < 5; i++) m.runFrame();
  const d = m.halt.haltDefer, sc = d ? d.speedChange : -1, s0 = d ? d.s : 0, oldDiv = m.div, c0 = m.cycle, t0 = m.cpu.totalCycles;
  m.cpu.a ^= 1;                                        // the drop
  m.cpuCheck();
  const added = m.cpu.totalCycles - t0, want = sc + Math.round((c0 - (s0 + sc * oldDiv)) / 4);
  const t1 = m.cpu.totalCycles, c1 = m.cycle;
  for (let i = 0; i < 2; i++) m.runFrame();
  check('a dropped instruction that slowed the CPU: its halted time counts at the old rate to its write, the new one after',
    sc >= 0 && oldDiv === 2 && m.div === 4 && !m.gime.fast && m.halt.haltDefer === null && added === want && (m.cpu.totalCycles - t1) * 4 === m.cycle - c1,
    `speedChange ${sc} div ${oldDiv}->${m.div} added ${added} want ${want}, after: ${m.cpu.totalCycles - t1} cycles in ${m.cycle - c1} ticks`);
}

// a write to the SAM rate bits from outside the CPU (the debugger's memory write) while an instruction is suspended: the
// outside write sets the divider at once (tests/coco3.test.js), and the suspended instruction, timed on the old rate's
// grid, is dropped as for any change from outside (haltCancel): its halted time counts at the old rate (to the end of
// its own speed-changing write, if it made one, then at that write's rate) and the CPU runs on at the new rate, before
// and after HALT's release
// STA <rate> ; READ SECTOR on drive 1 (empty) with HALT; NOP; STD ,X; BRA *
const STD_HELD = (rate) => [0xB7, 0xFF, rate, 0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48,
  0xC6, 0xAA, 0xF7, 0xFF, 0x40, 0x12, 0xED, 0x84, 0x20, 0xFE];
for (const [label, prog, x, fast, outside] of [
  ['INC held at 0.89 MHz', null, 0, false, 0xFFD9],
  // at 1.78 MHz, X = $FFD8: the STD slows the CPU, then its write to $FFD9 is held
  ['STD ,X held after it slowed the CPU', STD_HELD(0xD9), 0xFFD8, true, 0xFFD9],
  // at 0.89 MHz, X = $FFD9: the STD speeds the CPU up (SAM R1), its write to $FFDA is held; the outside write then sets R0,
  // which the GIME reports but which leaves the rate fast: the halted time after the STD's write counts at 1.78 MHz
  ['STD ,X held after it sped the CPU up, then R0 set from outside', STD_HELD(0xD8), 0xFFD9, true, 0xFFD7],
]) {
  const { m, start } = machine();
  if (prog) { prog.forEach((b, i) => m.poke(0x3000 + i, b)); m.cpu.x = x; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50; } else start(0xAA, 1, INC_LOOP);
  for (let i = 0; i < 5; i++) m.runFrame();
  const d = m.halt.haltDefer, sc = d ? d.speedChange : -1, s0 = d ? d.s : 0, oldDiv = m.div, c0 = m.cycle, t0 = m.cpu.totalCycles;
  const midDiv = sc >= 0 ? (m.gime.fast ? 2 : 4) : oldDiv;   // the rate the instruction's own write set
  const dbg = new Emu.Debugger(m);
  dbg.write(outside, [0]);
  dbg.detach();
  const added = m.cpu.totalCycles - t0, t = s0 + Math.max(0, sc) * oldDiv, want = Math.max(0, sc) + Math.round((c0 - t) / midDiv);
  const t1 = m.cpu.totalCycles, c1 = m.cycle;
  for (let i = 0; i < 2; i++) m.runFrame();
  check(`an outside ${hex(outside)} while an instruction is suspended (${label}): dropped, its halted time counted, the CPU at 1.78 MHz`,
    !!d && (sc >= 0) === fast && m.halt.haltDefer === null && m.gime.fast && m.div === 2 && added === want && (m.cpu.totalCycles - t1) * 2 === m.cycle - c1,
    `held ${!!d} speedChange ${sc} div ${oldDiv}->${m.div} added ${added} want ${want}, after: ${m.cpu.totalCycles - t1} cycles in ${m.cycle - c1} ticks`);
  FORCE_INTERRUPT(m);
  for (let i = 0; i < 2; i++) m.runFrame();
  const t2 = m.cpu.totalCycles, c2 = m.cycle;
  m.runFrame();
  check(`an outside ${hex(outside)} while an instruction is suspended (${label}): after the release still 1.78 MHz`,
    !m.cpu.haltLine && m.div === 2 && m.cpu.totalCycles - t2 > 20000 && (m.cpu.totalCycles - t2) * 2 === m.cycle - c2,
    `halt ${m.cpu.haltLine} div ${m.div}: ${m.cpu.totalCycles - t2} cycles in ${m.cycle - c2} ticks`);
}

// a snapshot loaded into a machine with an instruction suspended replaces it with the file's state: the restored
// machine runs on as the machine the file came from
{
  const { m: a, start: sa } = machine();
  sa(0xA9, 2);                                         // drive 0 has its disk: a read that completes
  for (let i = 0; i < 2; i++) a.runFrame();
  const snap = Emu.state.toJSON(a.saveState());
  const { m: b, start: sb } = machine();
  sb(0xAA, 1, INC_LOOP);
  for (let i = 0; i < 5; i++) b.runFrame();
  const wasHeld = !!b.halt.haltDefer;
  b.loadState(Emu.state.fromJSON(snap));
  const ta = [], tb = [];
  a.cpu.trace = (c) => ta.push(c.pc, c.a, c.x, c.totalCycles);
  b.cpu.trace = (c) => tb.push(c.pc, c.a, c.x, c.totalCycles);
  for (let i = 0; i < 20; i++) { a.runFrame(); b.runFrame(); }
  check('a snapshot loaded over a suspended instruction: the restored machine runs as the original (trace)',
    wasHeld && b.halt.haltDefer === null && ta.length > 1000 && ta.length === tb.length && ta.every((v, i) => v === tb[i]), `${ta.length} vs ${tb.length}`);
}

// ---------------- 2. the debugger across a held instruction ----------------
// A free run's trace (cpu.trace: pc, registers, total cycles at each instruction's start) and each instruction's
// cycles (cpu.execute's result, once per completed instruction), for `frames` frames' worth of instructions.
function freeRun(config, setup, count) {
  const { m, f, start } = machine(config);
  setup(m, f, start);
  const t = [], cyc = [];
  m.cpu.trace = (c) => { if (t.length < count) t.push([c.pc, c.a, c.b, c.x, c.cc]); };
  const ex = m.cpu.execute.bind(m.cpu);
  m.cpu.execute = () => { const n = ex(); cyc.push(n); return n; };
  while (t.length < count) m.runFrame();
  return { t, cyc };
}
const sector4 = (m, f, start) => { f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' }); start(0xAA, 4); };

for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
  // 2a. single steps across the held LDA (released by DRQ 11 frames later): one trace entry per traced instruction,
  // the same registers and cycles as the free run; a step while held waits a frame and stops 'halted', PC unchanged
  {
    const N = 40;
    const free = freeRun(config, sector4, N);
    const { m, f, start } = machine(config);
    sector4(m, f, start);
    const dbg = new Emu.Debugger(m, { traceSize: 1000 });
    const traced = [];
    m.cpu.trace = (c) => traced.push([c.pc, c.a, c.b, c.x, c.cc]);
    let halted = 0, haltedOk = true, calls = 0;
    while (dbg.steps < N && calls < 10000) {
      const pc = m.cpu.pc, c0 = m.cycle, n = dbg.log.length;
      const r = dbg.step(); calls++;
      if (dbg.stopped && dbg.stopReason.kind === 'halted') {
        halted++;
        if (!(r === 0 && m.cpu.pc === pc && dbg.log.length === n && m.cycle - c0 >= m.frameCycles && m.cycle - c0 < 2 * m.frameCycles)) haltedOk = false;
      }
    }
    m.cpu.trace = null;
    const log = dbg.log.slice(0, N);
    const same = log.every((e, i) => [e.pc, e.a, e.b, e.x, e.cc].join() === free.t[i].join() && e.cycles === free.cyc[i]);
    check(`debugger single step across a held LDA (${label}): ${N} steps = ${N} traced instructions, as the free run (registers, cycles)`,
      dbg.steps === N && log.length === N && same && traced.length === N && traced.every((t, i) => t.join() === free.t[i].join()) && log.every((e) => e.cycles > 0),
      `steps ${dbg.steps} log ${log.length} traced ${traced.length} same ${same}`);
    check(`debugger single step while held (${label}): each waits a frame and stops 'halted' with the PC unchanged and no trace entry (${halted} of them)`,
      halted >= 9 && haltedOk, `${halted} halted, ok ${haltedOk}`);
    dbg.detach();
  }

  // 2b. a breakpoint on the held LDA: Run (frame by frame, resumed after each stop) stops once per execution of it,
  // each stop at the registers the trace shows for it; and stepping from a stop changes nothing in the trace
  {
    const N = 300;
    const free = freeRun(config, sector4, N);
    const { m, f, start } = machine(config);
    sector4(m, f, start);
    const dbg = new Emu.Debugger(m);
    dbg.addBreakpoint(HELD);
    const traced = [], stops = [];
    m.cpu.trace = (c) => traced.push([c.pc, c.a, c.b, c.x, c.cc]);
    for (let fr = 0; fr < 2000 && traced.length < N; fr++) {
      if (!dbg.runFrame()) { stops.push([m.cpu.pc, m.cpu.a, m.cpu.b, m.cpu.x, m.cpu.cc, traced.length]); dbg.resume(); }
    }
    m.cpu.trace = null;
    const t = traced.slice(0, N), atHeld = [];
    t.forEach((e, i) => { if (e[0] === HELD) atHeld.push(i); });
    const inRange = stops.filter((s) => s[5] < N);
    const exact = inRange.length === atHeld.length && inRange.every((s, i) => s[5] === atHeld[i] && s.slice(0, 5).join() === t[atHeld[i]].join());
    check(`debugger breakpoint on the held LDA (${label}): Run stops once per execution (${atHeld.length}), at the traced registers`,
      atHeld.length > 50 && exact && t.every((e, i) => e.join() === free.t[i].join()), `stops ${inRange.length} executions ${atHeld.length}`);
    dbg.detach();
  }

  // 2c. Run on an empty drive: the machine stays halted and frames go on, with a breakpoint elsewhere and with one on
  // the held instruction itself (after its one stop); no stop, no trace entry, no step counted
  for (const where of ['elsewhere', 'on the held instruction']) {
    const { m, start } = machine(config);
    start(0xAA);
    const dbg = new Emu.Debugger(m);
    dbg.addBreakpoint(where === 'elsewhere' ? 0x0000 : HELD);
    let stops = 0;
    // (the instructions up to the held one run first; then 100 frames)
    for (let i = 0; i < 3; i++) if (!dbg.runFrame()) { stops++; dbg.resume(); }
    const steps0 = dbg.steps, log0 = dbg.log.length, frame0 = m.frameCount, s0 = stops;
    for (let i = 0; i < 100; i++) if (!dbg.runFrame()) { stops++; dbg.resume(); }
    check(`debugger Run on an empty drive, breakpoint ${where} (${label}): 100 frames, no stop, no instruction counted`,
      (where === 'elsewhere' ? s0 === 0 : s0 === 1) && stops === s0 && dbg.steps === steps0 && dbg.log.length === log0 && m.frameCount - frame0 === 100 && !!m.halt.haltDefer && m.cpu.pc === HELD,
      `stops ${s0}/${stops} steps ${dbg.steps - steps0} log ${dbg.log.length - log0} frames ${m.frameCount - frame0}`);
    dbg.detach();
  }

  // 2d. a read watchpoint on $FF4B with INC $FF4B held (its read made before HALT, replayed when it runs to its end):
  // one stop per read the controller saw, with the value it gave
  {
    const { m, f, start } = machine(config);
    f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
    start(0xAA, 4, INC_LOOP);
    const reads = [];
    const rd = f.readIO.bind(f);
    f.readIO = (a) => { const v = rd(a); if (a === 0xFF4B) reads.push(v); return v; };
    const dbg = new Emu.Debugger(m);
    dbg.addWatchpoint(0xFF4B, 1, { read: true, write: false });
    const hits = [];
    for (let fr = 0; fr < 400 && reads.length < 50; fr++) {
      if (!dbg.runFrame()) { hits.push(dbg.stopReason.value); dbg.resume(); }
    }
    // (the last read may be in an instruction that hasn't completed: its hit comes with its completion)
    const done = m.halt.haltDefer ? reads.length - 1 : reads.length;
    check(`debugger read watchpoint on a held INC $FF4B (${label}): ${hits.length} stops for ${reads.length} controller reads, the same values`,
      reads.length >= 50 && hits.length === done && hits.every((v, i) => v === reads[i]), `hits ${hits.length} reads ${reads.length}`);
    dbg.detach();
  }

  // 2e. run to return over a held read: JSR to LDA $FF4B / RTS. An empty drive: it stops 'halted' after two seconds of
  // machine time, counting only the instructions that ran (the traced ones); with the disk, it returns, its count the
  // traced count
  for (const disk of [false, true]) {
    const { m, f, start } = machine(config);
    if (disk) f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
    // (the loop's NOP becomes JSR $3200; at $3200: LDA $FF4B, STA ,X+, RTS; HALT comes before the LDA or inside it)
    start(0xAA, 4, [0xBD, 0x32, 0x00, 0x20, 0xFB]);
    [0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x39].forEach((b, i) => m.poke(0x3200 + i, b));
    const dbg = new Emu.Debugger(m);
    dbg.runUntil(0x3200, 100);                         // into the subroutine (no HALT yet: the command's latch write is ahead)
    const into = dbg.stopReason && dbg.stopReason.kind === 'until';
    let traced = 0;
    m.cpu.trace = () => { traced++; };
    const t0 = Date.now(), c0 = m.cycle;
    dbg.runToReturn();
    const ms = Date.now() - t0;
    m.cpu.trace = null;
    const r = dbg.stopReason || {};
    if (!disk) {
      check(`debugger run to return over a read on an empty drive (${label}): stops 'halted' after two seconds, ${traced} instructions, not a million`,
        into && r.kind === 'halted' && m.cpu.pc === 0x3200 && m.cpu.haltLine && traced === 0 && m.cycle - c0 >= 120 * m.frameCycles && m.cycle - c0 < 122 * m.frameCycles && ms < 5000,
        `into ${into} halt ${m.cpu.haltLine} held ${!!m.halt.haltDefer} traced ${traced} kind ${r.kind} pc ${hex(m.cpu.pc)} frames ${((m.cycle - c0) / m.frameCycles).toFixed(1)} ${ms} ms`);
      // the 'limit' count is completed instructions only: a run to an address the program never reaches
      // (counted as cpu.execute completes: the held LDA, traced when it started, completes in it; and the NMI the
      // Force Interrupt's INTRQ brings, whose entry the debugger counts as a step, as it always has)
      const l = (() => {
        dbg.resume(); FORCE_INTERRUPT(m);
        let n = 0;
        const ex = m.cpu.execute.bind(m.cpu), ci = m.cpu.checkInterrupts.bind(m.cpu);
        m.cpu.execute = () => { const c = ex(); n++; return c; };
        m.cpu.checkInterrupts = () => { const c = ci(); if (c) n++; return c; };
        dbg.runUntil(0x0000, 500);
        delete m.cpu.execute; delete m.cpu.checkInterrupts;
        return n;
      })();
      check(`debugger run to an address after the release (${label}): its limit counts the instructions completed`, dbg.stopReason.kind === 'limit' && dbg.stopReason.instructions === 500 && l === 500, `${JSON.stringify(dbg.stopReason)} traced ${l}`);
    } else {
      check(`debugger run to return over a held read with the disk (${label}): returns at the caller, the traced instructions only`,
        into && r.kind === 'until' && m.cpu.pc === 0x3012 && traced === 3 && m.halt.haltDefer === null, `kind ${r.kind} pc ${hex(m.cpu.pc)} traced ${traced}`);
    }
    dbg.detach();
  }
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
