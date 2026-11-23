// Run: node tests/iotime.test.js
//
// ioTime() is "the tick at which the current instruction touches the bus" (js/machines/machine.js). Between
// instructions there is no instruction touching the bus, so the answer there must be now(). It used to be
// cycle + (the last step's length) - 1: the CPU keeps its cycle count after a step (the trace and the debugger
// read it), so a tool that looked at the machine between steps - a debugger's I/O write, a stub hook - ran the
// scheduler up to a tick the machine had not reached; and a machine restored from a snapshot, whose CPU comes
// back with a cycle count of its own, answered differently from the original for the very same write.
//
// The oracles are the machine's own behaviour, not the implementation:
//   * an event queued just after now() must not fire from an outside access, and one already due must;
//   * the same outside write must leave the original and its restoration in the same place;
//   * every real bus access INSIDE an instruction must still report that instruction's own cycle, by the
//     family's rule (one tick a cycle on the 6809/6803 machines, `div` clocks a cycle on the CoCo 3), and
//     the step's length must be what the CPU charged.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const assemble = (text, cpu, org = 0x3000) => {
  const r = Emu.assemble(` ORG $${org.toString(16)}\n` + text, cpu);
  if (!r.ok) throw new Error('test firmware does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
// TFM X+,Y+ with W = count: one step tens of thousands of cycles long, so "the last step's length" is not a
// rounding-sized error but a third of a frame (the 6309 machines only: the MC-10's CPU has no TFM).
const tfm = (count) => assemble(` LDW #$${count.toString(16).padStart(4, '0')}\n TFM X+,Y+\nHALT BRA HALT\n`, '6309');
// the MC-10's longest step is a handful of cycles, which is all its own rule can be wrong by. Its RAM starts at
// $4000 (Machine.poke writes nothing below it), so its firmware is assembled there.
const mc10Prog = assemble(' LDX #$0400\nHALT BRA HALT\n', '6803', 0x4000);
// stop between two instructions: the machine has run the first one and not the second
const between = (m) => { m.runCycles(m.cycle + 1e-9); return m; };
const boot = (r, id, config) => {
  const m = Emu.createMachine(id, config);
  m.injectAndRun(r.segments, r.exec);
  m.cpu.x = 0x0400; m.cpu.y = 0x2000;
  return between(m);            // the setup instruction
};
// a probe event at `at`, fired or not
const probe = (m, at) => { const fired = []; m.on('io-probe', (arg, when) => fired.push(when)); m.schedule(at, 'io-probe'); return fired; };

// machine, its long-step program, and the outside I/O write that makes it look at the scheduler. The MC-10's
// port writes do not process events at all; its VDG latch write does, and only when the video/sound bits change
// (js/machines/mc10.js write), so the latch is written with a value different from the one it holds.
const longStep = [['dragon64', { cpu: '6309' }, tfm(0xFFFF)], ['coco3', { cpu: '6309' }, tfm(0xFFFF)]];
const mc10 = ['mc10', {}, mc10Prog];
const ioWrite = (m, id) => {
  if (id !== 'mc10') { m.write(0xFF01, 0x00); return; }
  // the latch processes events only when the video bits change (VIDEO_BITS = $7C); bit 7 is sound alone
  m.write(0xBFFF, (m.latch ^ 0x40) & 0xFF);
};

// ---- 1. between steps, ioTime() is the machine's time ----
for (const [id, config, prog] of [...longStep, mc10]) {
  const m = boot(prog, id, config);
  const last = m.cpu.c;                    // the last step's length is still in the CPU after it
  check(`${id}: between steps ioTime() is now(), not the last step's end (last step ${last} cycles)`,
    m.ioTime() === m.cycle, `ioTime ${m.ioTime()} cycle ${m.cycle}`);
  // The exact-time clock the disk drives and the SSC card ask (js/chips/attoclock.js) is ioTime() + 1, so it
  // moves with ioTime(): between steps a device asking what time it is must get the machine's time, not a time a
  // whole instruction ahead. That path is what reached the SSC card's between-step catch-up.
  check(`${id}: between steps clockUnits() and tickAt() are reckoned from now() too`,
    m.clockUnits() === m.cycle + 1 && m.tickAt(0) === m.cycle + 1,
    `clockUnits ${m.clockUnits()}, tickAt(0) ${m.tickAt(0)}, cycle+1 ${m.cycle + 1}`);
}

// ---- 2. an outside I/O write must not run the scheduler past now() ----
for (const [id, config, prog] of [...longStep, mc10]) {
  const m = boot(prog, id, config);
  const fired = probe(m, m.cycle + 1);
  ioWrite(m, id);
  check(`${id}: an outside I/O write between steps leaves an event for now()+1 queued`, fired.length === 0,
    `fired at ${fired.join(',')}`);
  // the control: the same write does see an event that is already due, or the check above proves nothing
  const due = probe(m, m.cycle - 1);
  ioWrite(m, id);
  check(`${id}: ...and still fires an event that is already due`, due.length === 1, `fired ${due.length}`);
}

// ---- 3. original and restored answer an outside write identically ----
// The CoCo 3's ioTime() reads cpu.cycleCount, which is NOT in a snapshot (the CPU's `c` is), so after a restore
// it is whatever the fresh CPU holds. That is the precondition below: if the two machines agreed on it the check
// could not fail. The write then has to land on the same machine time in both.
for (const [id, config, prog] of [...longStep, mc10]) {
  const a = boot(prog, id, config);
  const text = Emu.state.toJSON(a.snapshot());
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const run = (m) => {
    const fired = probe(m, m.cycle + 1);
    const queued = m.queue.length;
    ioWrite(m, id);
    return { io: m.ioTime(), fired: fired.length, drained: queued - m.queue.length };
  };
  const ra = run(a), rb = run(b);
  // (the MC-10's 6803 has no cycleCount field at all: its ioTime is cpu.c based, and c IS in a snapshot, so
  // that family was never split by a restore - the precondition belongs to the two 6809 families)
  if (id !== 'mc10') {
    check(`${id}: the two machines really do start from different cycle counts (or the check below is trivial)`,
      a.cpu.cycleCount !== b.cpu.cycleCount, `original ${a.cpu.cycleCount}, restored ${b.cpu.cycleCount}`);
  }
  check(`${id}: original and restored give the same ioTime() for the same outside write`, ra.io === rb.io,
    `original ${ra.io}, restored ${rb.io}`);
  check(`${id}: original and restored drain the same events for it`, ra.drained === rb.drained && ra.fired === rb.fired,
    `original drained ${ra.drained}/fired ${ra.fired}, restored drained ${rb.drained}/fired ${rb.fired}`);
}

// ---- 4. in-step timing is untouched: every bus access inside a step still reports its own cycle ----
// TFM X+,Y+ with W = 4 moves four bytes between two PIA addresses, so at least 4 reads and 4 writes are timed;
// the exact number is each family's business (the CoCo 3 also times the I/O sync that surrounds an access, and
// that count grew when its HALT work landed), so what is asserted here is the invariant, not a total: every
// answer comes from inside the instruction, none from between steps, and each keeps its family's rule.
// Its length is 6 + 3*W cycles [Sock 6+3n]. The family rules:
//   the 6809 machines - one tick a cycle, an access on the instruction's last cycle at cycle + n - 1;
//   the CoCo 3       - a tick is a GIME clock, a cycle `div` clocks, so cycle + cycleCount*div - 1.
{
  const W = 4, len = 6 + 3 * W;
  for (const [id, config] of [['dragon64', { cpu: '6309' }], ['coco3', { cpu: '6309' }]]) {
    const m = Emu.createMachine(id, config);
    const r = tfm(W);
    m.injectAndRun(r.segments, r.exec);
    m.cpu.x = 0xFF02; m.cpu.y = 0xFF03;      // inside the PIA pair: both the read and the write are timed
    between(m);                              // past the LDW
    const start = m.cycle;
    const seen = [];
    const orig = m.ioTime.bind(m);
    m.ioTime = () => { const v = orig(); seen.push({ inStep: m.inStep, v, cycle: m.cycle, cc: m.cpu.cycleCount, c: m.cpu.c, shift: m.halt ? m.halt.ioShift : undefined }); return v; };
    between(m);                              // the TFM
    m.ioTime = orig;
    const div = id === 'coco3' ? m.div : 1;
    const inStep = seen.filter((s) => s.inStep), outside = seen.filter((s) => !s.inStep);
    check(`${id}: the step charges TFM's 6+3*W cycles`, m.cycle - start === len * div, `step ${m.cycle - start}, expected ${len * div}`);
    // the move itself is 2*W accesses, and no answer may come from between steps
    check(`${id}: the move's own accesses and no between-step answer`, inStep.length >= 2 * W && outside.length === 0,
      `${inStep.length} in-step (at least ${2 * W} for the move), ${outside.length} between steps`);
    check(`${id}: every in-step answer lies inside the instruction's own span`,
      inStep.length > 0 && inStep.every((s) => s.v >= start && s.v <= start + len * div - 1), inStep.map((s) => s.v).join(','));
    const formula = id === 'coco3'
      ? (s) => s.v === s.cycle + s.shift + s.cc * div - 1
      : (s) => s.v === s.cycle + s.c - 1;
    check(`${id}: every in-step access keeps that family's timing rule`, inStep.length > 0 && inStep.every(formula),
      inStep.length ? `e.g. ${inStep[0].v}, cycle ${inStep[0].cycle}, ${id === 'coco3' ? `cycleCount ${inStep[0].cc} x ${div}` : `c ${inStep[0].c}`}` : 'no in-step calls');
  }
}

// ---- 5. the MC-10's own in-step rule, on its own CPU's cycle count ----
{
  // LDA <$03 reads 6803 port 2, and portIn() asks the machine for its pins through bus.portRead() before it
  // masks by the DDR (js/cpu/cpu6803.js), and that is what reaches ioTime() (js/machines/mc10.js portRead).
  const m = Emu.createMachine('mc10');
  const r = assemble(' LDA <$03\nHALT BRA HALT\n', '6803', 0x4000);
  m.injectAndRun(r.segments, r.exec);
  const start = m.cycle;
  const seen = [];
  const orig = m.ioTime.bind(m);
  m.ioTime = () => { const v = orig(); seen.push({ inStep: m.inStep, v, cycle: m.cycle, c: m.cpu.c }); return v; };
  between(m);
  m.ioTime = orig;
  const inStep = seen.filter((s) => s.inStep);
  check('mc10: an I/O access inside the instruction is timed at cycle + c - 1', inStep.length > 0 && inStep.every((s) => s.v === s.cycle + s.c - 1),
    inStep.length ? `e.g. ${inStep[0].v} = ${inStep[0].cycle} + ${inStep[0].c} - 1` : 'no in-step calls');
  check('mc10: the step is the 3 cycles the direct read costs', m.cycle - start === 3, `step ${m.cycle - start}`);
}

// ---- 6. a real suspended instruction (HALT held by the disk controller), held and parked ----
// Built through the machine's own path, not by hand: fdc/coco-halt-empty.asm reads a sector on a drive with no
// disk, the controller asserts HALT, and the instruction that would touch the bus is suspended (haltSuspend)
// and parked (haltPark) with cycleCount 0. Two answers matter and they differ:
//   * while the suspended instruction's events run (haltResume, heldIo true) ioTime() is the HELD access's time,
//     d.s + d.n*div - 1 - a between-step state that must keep the in-step form, or the disk's timers see a
//     different machine;
//   * once parked it is the machine's own time.
// A mutation that drops the held branch (ioTime's gate reduced to inStep) and one that reopens the parked state
// (cycle + div - 1 there) each turn one of these red.
{
  const path = require('path');
  const spec = require(path.join(__dirname, '../tools/mame-diff/fdc/spec.js'));
  const t = spec.trace('coco3', { controller: 'cocofdc', halt: true, empty: true });
  const m = t.machine();
  let frames = 0;
  while (frames < 400) { m.runFrame(); frames++; if (m.halt.haltDefer && !m.inStep && m.cpu.cycleCount === 0) break; }
  const d = m.halt.haltDefer;
  check('a real instruction is suspended and parked by the controller\'s HALT', !!d && !m.inStep && m.cpu.cycleCount === 0,
    `frames ${frames}, cycle ${m.cycle}, cycleCount ${m.cpu.cycleCount}`);
  const parkedCycle = m.cycle;
  // parked: the machine's time, and an outside write must not drain an event at cycle + 1
  const fired = [];
  m.on('io-probe', () => fired.push(m.cycle));
  const ev = m.schedule(parkedCycle + 1, 'io-probe');
  m.write(0xFF01, 0x00);
  check('parked: ioTime() and accessStart() are the machine time', m.ioTime() === parkedCycle && m.accessStart() === parkedCycle,
    `ioTime ${m.ioTime()}, accessStart ${m.accessStart()}, cycle ${parkedCycle}`);
  check('parked: an outside write leaves an event at cycle + 1 queued', fired.length === 0 && m.queue.includes(ev),
    `fired ${fired.length}, still queued ${m.queue.includes(ev)}`);

  // held: run the suspended instruction's events again and read ioTime() inside one
  const held = [];
  m.on('held-probe', () => held.push({ inStep: m.inStep, heldIo: m.halt.heldIo, v: m.ioTime(), cycle: m.cycle }));
  m.schedule(m.cycle + 1, 'held-probe');
  m.runFrame();
  const want = m.halt.haltDefer ? m.halt.haltDefer.s + m.halt.haltDefer.n * m.div - 1 : d.s + d.n * m.div - 1;
  check('held: an event run by haltResume sees the held access\'s time, d.s + d.n*div - 1',
    held.length > 0 && held.every((h) => !h.inStep && h.heldIo && h.v === want),
    held.length ? `in-event ioTime ${held[0].v}, expected ${want}` : 'no held event ran');

  // The held state must be let go again: heldIo is a call-stack flag, so once the events have run the machine is
  // parked and must answer the machine's time. A version that sets heldIo and never clears it passes every check
  // above and poisons every later access, so this is checked on its own.
  const parkedAgain = !!m.halt.haltDefer && !m.inStep && m.cpu.cycleCount === 0;
  check('after the held events run, the machine is parked again', parkedAgain,
    `haltDefer ${!!m.halt.haltDefer}, inStep ${m.inStep}, cycleCount ${m.cpu.cycleCount}`);
  check('after the held events run, heldIo is cleared and ioTime/accessStart are the machine time',
    !m.halt.heldIo && m.ioTime() === m.cycle && m.accessStart() === m.cycle,
    `heldIo ${m.halt.heldIo}, ioTime ${m.ioTime()}, accessStart ${m.accessStart()}, cycle ${m.cycle}`);

  // A handler that throws out of haltRun must not leave heldIo set either (the finally, not the happy path).
  // The event is queued and then taken off the queue in the handler's own throw path, so nothing is left for the
  // later checks in this file to trip over; the machine's state is asserted after the catch, not just the flag.
  const before = { cycle: m.cycle, cycleCount: m.cpu.cycleCount, queue: m.queue.length };
  let caught = null;
  m.on('held-throw', () => { throw new Error('test: a held event that throws'); });
  m.schedule(m.cycle + 1, 'held-throw');
  try { m.runFrame(); } catch (e) { caught = e; }
  check('a throwing held event propagates out of runFrame', caught !== null, String(caught && caught.message));
  check('...and leaves heldIo cleared and the machine timed at its own clock',
    m.halt.heldIo === false && m.ioTime() === m.cycle && m.accessStart() === m.cycle,
    `heldIo ${m.halt.heldIo}, ioTime ${m.ioTime()}, accessStart ${m.accessStart()}, cycle ${m.cycle}`);
  check('...with no io-probe or held event left queued by the throw',
    !m.queue.some((e) => e.name === 'held-throw'),
    `queue names ${[...new Set(m.queue.map((e) => e.name))].join(',')}`);
  // and the machine still runs afterwards: one more frame must not throw and must not resurrect the held answer
  let later = null;
  try { m.runFrame(); } catch (e) { later = e; }
  check('...and the machine runs on afterwards with the machine\'s own time',
    later === null && !m.halt.heldIo && m.ioTime() === m.cycle,
    later ? `threw ${later.message}` : `heldIo ${m.halt.heldIo}, ioTime ${m.ioTime()}, cycle ${m.cycle}`);
}

// ---- 7. the CoCo 3's accessStart() has the same contract (it ends a MAME-compat slice) ----
// Reachable between steps only through syncIoMame, which ends a slice when a write changes an interrupt
// output. There it must be now(), or the slice starts a whole instruction past its access.
{
  const m = Emu.createMachine('coco3', { mameCompat: true });
  m.reset(true);
  for (let i = 0; i < 5; i++) m.runFrame();
  const worse = [];
  const orig = m.accessStart.bind(m);
  m.accessStart = () => { const v = orig(); if (!m.inStep) worse.push(v - m.cycle); return v; };
  for (const a of [0xFF90, 0xFF91, 0xFF92, 0xFF93]) for (const v of [0x00, 0x01, 0x20, 0xFF]) m.write(a, v);
  m.accessStart = orig;
  check('coco3: accessStart() between steps is now() (the slice does not start past its access)',
    worse.length > 0 && worse.every((d) => d === 0), `${worse.length} between-step calls, worst over-run ${Math.max(0, ...worse)}`);
}

// ---- 8. a step that throws does not leave the machine believing it is mid-instruction ----
// Without the try/finally, an exception out of cpu.step() would leave inStep true, and every later between-step
// access would be timed as if an instruction were running - the very bug this file is about, in another guise.
// An exception out of a step reaches the page's frame loop uncaught, so this is not hypothetical. Each family
// has its own runCycles (base Machine for the MC-10, SamMachine for the 6809s, Coco3Machine for the CoCo 3), so
// each is exercised: a mutation in one must redden this section on the machine that uses it.
for (const [id, config] of [['dragon64', {}], ['coco3', {}], ['mc10', {}]]) {
  const m = Emu.createMachine(id, config);
  m.reset(true);
  for (let i = 0; i < 3; i++) m.runFrame();       // past the constructor's own stepping
  const step = m.cpu.step.bind(m.cpu);
  m.cpu.step = () => { m.cpu.step = step; throw new Error('test: a step that throws'); };
  let caught = null;
  try { m.runCycles(m.cycle + 1e-9); } catch (e) { caught = e; }
  check(`${id}: a throwing step propagates out of runCycles`, caught !== null, String(caught && caught.message));
  check(`${id}: ...and the machine is not left mid-instruction (inStep false, ioTime() is now())`,
    m.inStep === false && m.ioTime() === m.cycle, `inStep ${m.inStep}, ioTime ${m.ioTime()}, cycle ${m.cycle}`);
}

// ---- 9. the MAME-compat check-point pass still runs inside the step ----
// processEventsMame() branches on inStep: inside a step it stops the CPU at each check point after the step's
// last access (MAME's scheduler); outside one it degenerates to a bare mameStop(0). In sam.js it is called
// straight after cpu.step(), so it must run before the flag is cleared. Clearing it first silently changes every
// mameCompat SAM trace (the gate caught exactly that: eight regression hashes).
{
  const m = Emu.createMachine('dragon64', { mameCompat: true });
  m.reset(true);
  for (let i = 0; i < 3; i++) m.runFrame();
  const seen = [];
  const orig = m.processEventsMame.bind(m);
  m.processEventsMame = () => { seen.push(m.inStep); return orig(); };
  m.runCycles(m.cycle + 1e-9);
  m.processEventsMame = orig;
  check('dragon64 mameCompat: the check-point pass runs while the step is in progress',
    seen.length > 0 && seen.every((v) => v === true), `${seen.length} calls, inStep ${[...new Set(seen)].join(',')}`);
  // and the effect: with the flag wrongly cleared, mameStop(0) is the only stop, so the CPU would never be held
  // at a check point inside the instruction. The regress hashes are the full proof; this is the direct one.
}

console.log(fail ? `${fail} of ${n} io-time checks FAILED` : `all ${n} io-time checks passed`);
process.exitCode = fail ? 1 : 0;
