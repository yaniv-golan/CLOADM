// The CoCo 3's HALT inside an instruction (machine.halt, one per Coco3Machine): the cartridge slot's HALT can fall
// between an instruction's bus cycles, and MAME 0.264's 6809 is suspended there and finishes the instruction once HALT
// is released. This holds what that needs, as js/machines/coco3.js had it: where HALT arrived and was released in the
// last step (haltArrived, haltReleased: the rest of the instruction as cpu.haltTail); an I/O access that waits for the
// release (haltWait, haltRun, haltFinish); an instruction still held when the run ends, suspended and parked (haltSuspend,
// haltPark) and run again from its start once released, its bus accesses so far replayed from the bus log rather than
// made again (haltResume, busLogged, replayRead, replayWrite); dropped when the CPU is redirected or changed from outside
// (haltCancel, cpuCheck, replayDropped); and the writes from outside made while it is held, queued until the machine's
// own time (outsideWrite, flushOutsideWrites). The machine keeps the bus decode and the run loop, which read and set
// these fields where they always did; every cycle and every snapshot byte is the same as before the move (the MAME
// comparisons run.js coco3 --fdc cocofdc --halt [--empty] and the regression hashes; tests/halt-replay-split.test.js).

// an event at tick T is seen before an instruction starting at tick a when T < a + (clocks per cycle) (see
// Coco3Machine.ioTime); events on fractional ticks (the exact-time devices, js/chips/attoclock.js) too, whose times carry
// rounding error, so the bound is just under it: by 1e-6, or by a few steps of the double once ticks are large (past
// 2^34 ticks a fixed 1e-6 is less than half a step and the bound rounds back up to the tick itself)
export const justUnder = (x) => x - Math.max(1e-6, x * 2 ** -50);
// thrown out of the CPU's step when HALT holds an instruction past the end of the run (HaltReplay.haltSuspend)
export const SUSPEND = Object.freeze({ suspended: 'halt' });
// thrown out of the CPU's step when a suspended instruction, run again, doesn't make the accesses it logged (only a
// malformed snapshot can cause it: HaltReplay.replayRead)
export const REPLAY_MISMATCH = Object.freeze({ replay: 'mismatch' });

export class HaltReplay {
  // machine: the Coco3Machine it belongs to (its CPU, clock, bus and events)
  constructor(machine) {
    this.machine = machine;
    // HALT arriving inside an instruction (config.mameCompat; see fireEvent): the step that ran last, the HALT
    this.stepS = 0; this.stepN = 0; this.haltAt = -1;
    this.haltS = -1; this.haltK = 0; this.haltN = 0;
    this._busHalt = false;
    this.haltDefer = null;   // an I/O access waiting for HALT to be released (haltWait); between steps, the suspended
                             // instruction (haltSuspend)
    this.ioShift = 0;        // ticks the rest of a step runs later than its start says (the wait in haltWait)
    // true while a suspended instruction's events run between steps (haltResume): ioTime() must then report the
    // held access's time, not the machine's. An explicit flag rather than a test on ioShift, which is legitimately
    // 0 for an access held at the instruction's own start - the guard must not depend on that.
    this.heldIo = false;
    // writes from outside the CPU that must wait for the machine's own time before they land (write, outsideWrite):
    // made in a held access's window, or behind a write already waiting. They are owed to the machine, so they
    // travel in its snapshot (a restore would otherwise drop a debugger's write made while an instruction was
    // held); a reset drops them (a reset drops every access made while an instruction was held, and the same write
    // made while parked is wiped by one too).
    this.outsideWrites = [];
    // every bus access of an instruction that may be suspended by HALT, in order (busLogged): its address and the
    // byte read or written. A step run again after HALT suspended it gets its first accesses from here (replayRead),
    // not from the bus. Kept only while a device that can assert HALT is attached (logBus): carrying it was worth
    // 4.4% frames/s on a CoCo 3 without the controller (the median of five paired runs), and only the CoCo FDC's
    // HALT can suspend an instruction (fireEvent / logBus)
    this.busA = new Int32Array(256); this.busV = new Uint8Array(256); this.busN = 0;
    this.busAt = 0;          // the next access of a step run again
    this.replayN = -1;       // how many of its accesses are replayed (-1: not replaying)
    this.busHalt = false;    // a HALT-capable device is attached (devicesAttached; see logBus)
    this.waitLimit = Infinity; // haltWait waits no later than this tick (the end of the run: runCycles)
  }
  // Whether the bus log is carried: an instruction can be suspended only by HALT, and HALT reaches the CPU from a
  // device through its slot's line timer (a SlotDevice's CartSlot: only the CoCo FDC drives an 'halt' line), so the
  // log is needed while a device declaring Device.canHalt is attached (a Multi-Pak answers for its slots). A line
  // asserted any other way (a test or the debugger calling setLine) takes the CPU between instructions: there is no
  // step to hold, so nothing to log. A held instruction keeps its log whatever is attached now, as its step run
  // again replays against it and may be held again (a restored snapshot whose controller was then taken out).
  // The log is live, so a device attached later needs nothing from before it came: a step never spans an attach.
  // A snapshot's haltDefer was logged while its device was attached, and Machine.loadState attaches the cartridge
  // before the rest of the state comes back, so a restored suspended instruction keeps its log.
  get logBus() { return this.busHalt || this.haltDefer !== null; }
  // haltDefer and busHalt are what logBus is made of, and the machine's bus reads and writes test it on every access.
  // So they keep the machine's one flag for it (machine.halting) in step whatever sets them, and the machine's read
  // and write stay small enough to be inlined: with the two fields read through this object on every access instead,
  // a CoCo 3 ran 4-6% slower (the paired measurement in the D14 report).
  get haltDefer() { return this._haltDefer; }
  set haltDefer(d) { this._haltDefer = d; this.machine.halting = this._busHalt || d !== null; }
  get busHalt() { return this._busHalt; }
  set busHalt(on) { this._busHalt = on; this.machine.halting = on || this._haltDefer !== null; }
  // the access the CPU is making is a replayed one (replayRead / replayWrite): made before the step was suspended,
  // so the bus taps reported it then (js/machines/bustaps.js)
  replaying() { return this.machine.inStep && this.replayN >= 0 && this.busAt < this.replayN; }
  busLogged(a, v) {
    const n = this.busN;
    if (n === this.busA.length) {          // (a long 6309 TFM: the log grows, keeping what it holds)
      const A = new Int32Array(2 * n), V = new Uint8Array(2 * n);
      A.set(this.busA); V.set(this.busV); this.busA = A; this.busV = V;
    }
    this.busA[n] = a; this.busV[n] = v; this.busN = n + 1;
  }
  replayRead(a) {
    const i = this.busAt;
    if (i < this.replayN) {
      if (this.busA[i] !== a) throw REPLAY_MISMATCH;
      this.busAt = i + 1;
      return this.busV[i];
    }
    this.replayEnd(a);
    const v = this.machine.busRead(a);
    this.busLogged(a, v);
    return v;
  }
  // -> true when the write was made before the step was suspended (replayed: not made again)
  replayWrite(a, v) {
    const i = this.busAt;
    if (i < this.replayN) {
      if (this.busA[i] !== a || this.busV[i] !== (v & 0xFF)) throw REPLAY_MISMATCH;
      this.busAt = i + 1;
      return true;
    }
    this.replayEnd(a);
    return false;
  }
  // the first access after the replayed ones is the held one: an I/O access in the bus cycle it was held in
  replayEnd(a) {
    if (a < 0xFF00 || a >= 0xFFE0 || this.machine.cpu.cycleCount !== this.haltDefer.n) throw REPLAY_MISMATCH;
    this.replayN = -1;
  }
  // A write from outside the CPU made while a suspended instruction's events run (heldIo, haltResume): it must not
  // land there. ioWrite would pump the scheduler at the held access's time, which is behind the machine's own time,
  // and a rate write would take its !inStep branch and call haltCancel, ending the instruction from inside the run of
  // that instruction's own events (haltResume then parks with a stale local d). So it is queued, and runCycles makes
  // it between instructions, at the machine's time - where an outside access lands anyway (docs/verification.md:
  // a parked CPU's cycle count is 0 and an access from outside is timed at the machine's time).
  //
  // Only an event handler is ever IN the window (heldIo is true only synchronously, inside haltRun): a UI POKE or
  // a debugger-panel write, which arrive between frames, never finds it. While a queue is still waiting (after a
  // stall, say) such a write is queued too, by the rule in write()/poke() - behind what is already owed, and
  // flushed when the machine next runs, so a paused machine shows it after the next frame, not at once.
  // A read is NOT deferred: ioRead services it in the window, at the held access's time, and its device side
  // effects happen there (see the note on reads below).
  outsideWrite(a, v) { this.outsideWrites.push({ a: a & 0xFFFF, v: v & 0xFF, poke: false }); }
  // Make the queued writes, in order, at the machine's own time: each through busWrite (below the debugger's
  // wrapper and write()'s queueing branch), so it lands and is timed as one made between instructions is - the
  // machine's own time, its device side effects at once.
  //
  // runCycles calls it at the top of its loop and after it: before an instruction starts, and once the run has
  // ended, so a frame (or slice) that ends while the CPU is parked still makes them in the same run, with no
  // future instruction to wait for; haltResume's catch does the same for a run that throws out of the window. A
  // write can outlive its run in exactly one way - a stall (a DriveWire write sets m.stall through
  // Machine.waitFor) - and the queue then goes with the run the stall ends in; runCycles stops at once when a
  // flushed write sets one, before any instruction runs under it.
  //
  // The debugger's access hook is bypassed: when a debugger is attached, this.machine.write is its wrapper, which reports
  // every write as a watchpoint access. The flush goes through busWrite, below it, so a queued write - the
  // debugger's own, which Debugger.write also makes without reporting - fires no watchpoint for it.
  flushOutsideWrites() {
    if (!this.outsideWrites.length || this.machine.stall || this.machine.inStep || this.heldIo) return;   // (never mid-access)
    // ONE entry at a time, off the queue itself: a write's device side effects can pump events, and a handler that
    // writes or pokes from one must queue BEHIND the entry being made and those still waiting, not land ahead of them
    // in an empty queue. So the head stays on the queue while it is made, and is taken off only once it has landed
    // (the last entry too: shifted first, its own ioSync would find the queue empty).
    // Each goes through busWrite(), which is exactly what an outside write between instructions does (write()'s
    // !inStep branch is a bare busWrite) - so it is timed and lands as one made here would, and it passes neither
    // the debugger's wrapper (no watchpoint fires for a write the debugger made) nor write()'s queueing branch, which
    // would see a non-empty queue and put it back. A poke keeps poke's semantics: the memory image, even under ROM.
    while (this.outsideWrites.length && !this.machine.stall && !this.machine.inStep && !this.heldIo) {
      const w = this.outsideWrites[0];
      if (w.poke) this.machine.pokeNow(w.a, w.v); else this.machine.busWrite(w.a, w.v);
      this.outsideWrites.shift();
    }
  }
  // An I/O access in an instruction that HALT suspended at an earlier check point: MAME's 6809 makes the access
  // only once HALT is released, so it reads (or writes) the device as it is then. A disk controller's halted
  // read loop depends on it: HALT, delayed by the cartridge slot, often arrives inside the LDA of the next byte,
  // before its read cycle. The machine's events run on until the release (haltDefer.rel), then up to the
  // access's own time; runCycles charges the rest of the instruction from the release (haltReleased).
  //
  // The wait goes no further than the run does (waitLimit: the end of the frame, or of the slice runCycles was
  // given). If HALT is still asserted there - a read sector on an empty drive never brings its DRQ - the
  // instruction is suspended (haltSuspend) and the frame ends; the machine's time, video and events run on,
  // frame after frame, while the CPU waits (haltResume).
  haltWait() {
    // (only in an instruction: an interrupt's entry, which reaches I/O only with S in the I/O page, isn't held)
    if (this.haltAt < 0 || !this.machine.inStep || this.haltDefer || !this.machine.cpu.executing) return;
    const s = this.machine.cycle, div = this.machine.div, ns = this.machine.cpu.cycleNoStop, cur = this.machine.cpu.cycleCount - 1;
    let k = -1;
    for (let i = Math.max(1, Math.floor((this.haltAt - s) / div)); i <= cur; i++) if (!ns[i - 1]) { k = i; break; }
    if (k < 0) return;                            // no check point before this access: it happens now
    this.haltAt = -1;
    const d = this.haltDefer = { s, k, rel: -1, n: this.machine.cpu.cycleCount, speedChange: this.machine.speedChange, log: null, resume: false, regs: null, mem: null };
    if (this.haltRun(d)) this.haltFinish(d);
    else this.haltSuspend(d);
  }
  // the machine's events up to HALT's release, or to waitLimit -> false when HALT is still asserted there
  haltRun(d) {
    const q = this.machine.queue, limit = this.waitLimit;
    while (this.machine.cpu.haltLine && q.length && q[0].at < limit) {
      const before = q[0];
      this.machine.processEvents(q[0].at);
      if (q[0] === before) return true;           // (nothing more can run: the access goes ahead)
    }
    return !(this.machine.cpu.haltLine && q.length);
  }
  // the rest of the instruction, the held access included, runs from the release (on the cycle grid, as haltReleased)
  haltFinish(d) {
    if (d.rel < 0) return;
    this.ioShift = (Math.floor((d.rel - d.s) / this.machine.div) - d.k) * this.machine.div;
    this.machine.processEvents(justUnder(this.machine.ioTime() + 1));
  }
  // HALT still asserted at waitLimit: the step is abandoned (runCycles rewinds the CPU to the instruction's start)
  // and kept in haltDefer with the bus accesses it made before the held one (its log); the time moves on.
  haltSuspend(d) {
    d.log = [];
    for (let i = 0; i < this.busN; i++) d.log.push(this.busA[i], this.busV[i]);
    this.haltPark(d);
    throw SUSPEND;
  }
  // the time moves on to waitLimit (on the instruction's cycle grid). Between runs no instruction is under way: the
  // CPU's cycle count is 0, so an access from outside (the debugger, a loaded file's restore) is timed at the machine's
  // time, not the held access's, however long the instruction (a 6309 TFM's count reaches 196,611)
  haltPark(d) {
    const div = this.machine.div;
    this.machine.cycle = Math.max(this.machine.cycle, d.s + Math.ceil((this.waitLimit - d.s) / div) * div);
    this.ioShift = 0;
    this.machine.cpu.cycleCount = 0;
  }
  // a suspended instruction's wait goes on -> true when it can run again (HALT released, or nothing left to run).
  // While its events run, ioTime() is the held access's, as in haltWait (the CPU's cycleCount at the access, ioShift
  // back to the instruction's start) - heldIo says so, since ioShift itself may be 0 for an access at the
  // instruction's start; between runs it is the machine's time, for an access from outside the CPU.
  haltResume() {
    const d = this.haltDefer;
    if (d.rel < 0) {
      this.machine.cpu.cycleCount = d.n; this.ioShift = d.s - this.machine.cycle;
      this.heldIo = true;
      let go;
      try { go = this.haltRun(d); } catch (e) {
        // a held event that threw on its way out of the frame: the window is over, and what the bus was told in it
        // is still owed - this run is not coming back to drain the queue. Made now, in the parked machine, exactly
        // as one made while parked is (write(): an outside change drops the suspended instruction).
        this.heldIo = false;
        this.ioShift = 0;
        if (this.outsideWrites.length) this.flushOutsideWrites();
        throw e;
      }
      this.heldIo = false;
      this.ioShift = 0;
      if (!go) { this.haltPark(d); return false; }
      // HALT dropped outside an event (the cartridge taken out: its lines go at once, js/machines/bus.js detach):
      // released now, where the time has got to, not at the instruction's start
      if (d.rel < 0 && !this.machine.cpu.haltLine) d.rel = this.machine.cycle;
    }
    // run again from its start, as when it was suspended, its accesses so far replayed
    d.now = this.machine.cycle;
    this.machine.cycle = d.s; this.ioShift = 0;
    this.busN = 0;
    for (let i = 0; i < d.log.length; i += 2) this.busLogged(d.log[i], d.log[i + 1]);
    this.busAt = 0; this.replayN = this.busN;
    d.resume = true;
    return true;
  }
  // The CPU redirected from outside while an instruction is suspended: a jump or a loader (Machine.jump,
  // injectAndRun), the debugger setting a register, any write to the CPU's registers or to memory the instruction had
  // fetched, read or written before its held access (cpuCheck sees those at the next run, debugger check or snapshot).
  // The suspended instruction is dropped: the CPU is between instructions with the state it
  // was given, still halted while HALT is asserted, and runs from that state once HALT is released.
  // Source: the MC6809E data sheet (Motorola, MC6809E/D, "HALT" under the signal descriptions; page not cited, no copy
  // could be reached when this was written): HALT stops the processor "at the end of the present instruction" and it
  // remains halted "without loss of data", so on the hardware an outside change can only meet it between instructions. Our
  // suspended instruction has changed no register yet (cpu.rewind), so dropping it puts the CPU exactly there. The
  // bus accesses it made before its held one were made, and stay made. (MAME 0.264's debugger, writing PC, only sets
  // m_pc: its 6809 carries on through the rest of the old instruction's microcode from the new address,
  // m6809.cpp state_import; an artefact of the emulator with no hardware counterpart, not reproduced.)
  // (`fast`: the GIME's rate while the instruction waited; an outside speed write that drops it passes the rate before
  // it. That drop is a deviation from MAME, which continues the instruction at the new clock: see writeIO.)
  haltCancel(fast = this.machine.gime.fast) {
    const d = this.haltDefer;
    if (!d || this.machine.inStep) return;
    this.haltDefer = null; this.busN = 0; this.replayN = -1; this.ioShift = 0; this.haltS = -1;
    // the CPU has been halted from the instruction's start to now: those cycles count (as haltTail charges them for an
    // instruction that is kept), at the rate it ran, and after a speed change it made before its held access (in the
    // GIME already: the clock follows it) at the new rate from the end of that write's cycle (as clockChanged)
    let t = d.s, n = 0;
    if (d.speedChange >= 0) { n = d.speedChange; t = d.s + n * this.machine.div; this.machine.div = fast ? 2 : 4; }
    this.machine.cpu.totalCycles += n + Math.max(0, Math.round((this.machine.cycle - t) / this.machine.div));
    this.machine.redirects++;
  }
  // The suspended instruction run again from its start (Coco3Machine.runCycles, which has set inStep and the step's
  // time): cpu.rerun, its bus accesses before the held one replayed (replayRead, replayWrite), not made again.
  // -> the cycles it ran, or -1 when it was dropped (replayDropped: it did not make the accesses it logged, or did not
  // reach its held one), and the run goes on to the next instruction. Out of runCycles' own body: it is rare, and the
  // loop runs every instruction.
  rerun(d) {
    const m = this.machine;
    let n;
    try { n = m.cpu.rerun(); } catch (e) {
      if (e !== REPLAY_MISMATCH) throw e;
      n = -1;
    } finally { m.inStep = false; }
    if (n < 0 || this.replayN >= 0) { this.replayDropped(d, Math.max(0, n)); return -1; }
    return n;
  }
  // A suspended instruction run again that did not make the accesses it logged, or did not reach its held one (a
  // snapshot whose log doesn't belong to its instruction: replayRead). None of its accesses reached the bus, so it is
  // dropped as for a redirect (haltCancel): the CPU is between instructions where HALT's release found it, and runs
  // the instruction afresh.
  // (`ran`: the cycles the CPU counted if the replay ran the instruction to its end, the log holding all its accesses)
  replayDropped(d, ran) {
    this.replayN = -1;
    this.machine.cpu.rewind();
    this.machine.cpu.totalCycles -= ran;
    this.machine.cycle = d.now;
    this.haltCancel();
  }
  // what the suspended instruction waits with: the registers (cpu.mark; the 6309's too) and, as memory holds them now,
  // the bytes below the I/O page of every bus access it made (its log: its code, operands, stack, reads and writes;
  // not its idle cycles, which access nothing). The snapshot keeps the bytes (haltDefer.mem); a loaded file's
  // registers are its CPU's (mem: false).
  haltKeep(d, mem = true) {
    const cpu = this.machine.cpu;
    cpu.mark();
    d.regs = Array.from(cpu.pre);
    if (!mem) return;
    const m = [];
    for (let i = 0; i < d.log.length; i += 2) { const a = d.log[i]; if (a < 0xFF00) m.push(a, this.machine.peek(a)); }
    d.mem = m;
  }
  // an instruction suspended with registers or memory changed since (from outside: nothing else runs) is dropped
  cpuCheck() {
    const d = this.haltDefer;
    if (!d || this.machine.inStep || !d.regs) return;
    this.machine.cpu.mark();
    const p = this.machine.cpu.pre, r = d.regs, mem = d.mem;
    let same = true;
    for (let i = 0; i < r.length && same; i++) if (p[i] !== r[i]) same = false;
    for (let i = 0; i < mem.length && same; i += 2) if (this.machine.peek(mem[i]) !== mem[i + 1]) same = false;
    if (!same) this.haltCancel();
  }
  // HALT asserted at tick haltAt: inside the step that just ran (stepS, stepN)?
  haltArrived() {
    const at = this.haltAt, s = this.stepS, n = this.stepN, div = this.machine.div, ns = this.machine.cpu.cycleNoStop;
    this.haltAt = -1;
    if (!(at > s && at < s + n * div)) return;
    for (let k = Math.max(1, Math.floor((at - s) / div)); k < n; k++) {
      if (!ns[k - 1]) { this.haltS = s; this.haltK = k; this.haltN = n; return; }
    }
  }
  // released at tick at (before the step starting at this.machine.cycle): the rest of the suspended instruction
  haltReleased(at) {
    const div = this.machine.div, next = Math.floor((at - this.haltS) / div) + this.haltN - this.haltK;
    this.machine.cpu.haltTail = Math.max(0, next - Math.round((this.machine.cycle - this.haltS) / div));
    this.haltS = -1;
  }
}
// saved in snapshots, after the machine's own (Coco3Machine.STATE): the last step and where HALT arrived in it
HaltReplay.STATE = ['stepS', 'stepN', 'haltAt', 'haltS', 'haltK', 'haltN'];

// the suspended instruction in a snapshot: where it started (s), its stop point (k), its held access (n), HALT's
// release (rel, -1 while waiting), the speed change it made before (speedChange), its bus accesses so far, address and
// byte (log: replayed when it runs again; one that doesn't match the instruction drops it, replayDropped) and the memory
// they touched below the I/O page, address and byte as it was when suspended (mem: the log's addresses there, in order;
// an outside change to a byte drops the instruction, cpuCheck)
export function haltDeferState(d) {
  for (const k of ['s', 'k', 'rel', 'n', 'speedChange']) if (typeof d[k] !== 'number') throw new Error(`snapshot: "haltDefer.${k}" is not a number`);
  const pairs = (l, top) => Array.isArray(l) && l.length % 2 === 0 && l.every((v, i) => Number.isInteger(v) && v >= 0 && v <= (i % 2 ? 0xFF : top));
  if (!pairs(d.log, 0xFFFF)) throw new Error('snapshot: "haltDefer.log" is not a list of address, byte pairs');
  if (!pairs(d.mem, 0xFEFF)) throw new Error('snapshot: "haltDefer.mem" is not a list of address, byte pairs');
  const touched = d.log.filter((v, i) => i % 2 === 0 && v < 0xFF00);
  if (touched.length * 2 !== d.mem.length || touched.some((a, i) => d.mem[2 * i] !== a)) throw new Error('snapshot: "haltDefer.mem" is not the memory of "haltDefer.log"');
  return { s: d.s, k: d.k, rel: d.rel, n: d.n, speedChange: d.speedChange, log: d.log.slice(), resume: false, regs: null, mem: d.mem.slice() };
}

// a loaded suspended instruction's times, against the machine's (cycle): whole ticks; it started (s) no later than now;
// its held access (n, the CPU's cycle count at it) comes after its logged accesses, within the cycles they can take (a
// TFM takes 3 for 2 accesses), its stop point (k) before it and a speed change it made (speedChange, -1 for none) too;
// HALT's release (rel, -1 while waiting) between its start and the end of the CPU cycle under way now (an event's time:
// a released device's events need not fall on whole ticks; an access from outside while held sees events up to then,
// ioTime). Out of range they would run the machine's time
// far off (or the CPU's count), so the file is refused.
export function haltDeferTimes(d, cycle) {
  const whole = (v) => Number.isSafeInteger(v);
  const accesses = d.log.length / 2;
  const bad = (what) => { throw new Error(`snapshot: "haltDefer.${what}" is out of range`); };
  if (!whole(d.s) || d.s < 0 || d.s > cycle) bad('s');
  if (!whole(d.n) || d.n < accesses + 1 || d.n > 2 * (accesses + 1) + 32) bad('n');
  if (!whole(d.k) || d.k < 1 || d.k > d.n) bad('k');
  if (!whole(d.speedChange) || d.speedChange < -1 || d.speedChange > d.n) bad('speedChange');
  if (!Number.isFinite(d.rel) || (d.rel !== -1 && (d.rel < d.s || d.rel >= cycle + 4))) bad('rel');
}
