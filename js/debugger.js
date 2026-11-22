/*
 * Debugger: breakpoints, watchpoints, stepping, run to return, and a trace of the last N instructions,
 * for the machine a Session is running. Browser-free (the page's Debugger screen
 * part, drives this through the Session).
 *
 * Stepping goes through the machine's own runCycles one instruction at a time, so a step costs exactly
 * what the instruction costs in a free run and the emulation's timing is untouched: there is no second
 * instruction loop here. A machine left to the page's frame loop is unaffected too - the debugger only
 * wraps the bus, and while it is not stopping the wrapper passes every access straight through.
 *
 * Breakpoints stop before the instruction at the address runs. Watchpoints stop after the instruction
 * whose bus access touched the address: the bus is read and written a byte at a time (a 16-bit load is two
 * reads), and the access that matched is reported with its value. Instruction fetches are reads, so a read
 * watchpoint on a code address also sees the opcode fetch; that is what the bus did.
 *
 * A step in which no instruction runs is not an instruction here: a halted cycle (the HALT line, or the rest of a
 * halted wait), or the CoCo 3's instruction suspended by HALT past the end of a run (js/machines/coco3.js
 * haltSuspend), which runs again from its start when HALT is released. Such a step makes no trace entry, counts
 * toward no step or instruction limit, and reports no watchpoint hit: the instruction's accesses are reported once,
 * from the run that completes it (its accesses before the held one are replayed there, as the bus made them once).
 * A breakpoint or arrival address is checked once per instruction, at its start, not again while it waits. A command
 * that must return (step, step over, run to return, run to an address) waits for a halted CPU for a while
 * (HELD_FRAMES of machine time) and then stops with kind 'halted', the PC where it was; the page's Run (runTo, frame
 * by frame) just goes on, the machine halted and its frames running, until HALT is released.
 *
 * The 6809 and 6803 are covered now. The 6309 is a new name in the machine's config, and
 * its disassembly arrives with it (js/asm/disassembler.js); everything else here is CPU-independent.
 */
import { disassemble, disassembleBlock } from './asm/disassembler.js';
import { SessionError } from './errors.js';

// TFM is a subroutine call for the step-over logic as much as JSR is: it transfers control to the block
// move, and the 6309 also adds the whole 6309-only call set.
const CALLS = {
  '6809': new Set(['JSR', 'BSR', 'LBSR']),
  '6803': new Set(['JSR', 'BSR']),
  '6309': new Set(['JSR', 'BSR', 'LBSR']),
};
// registers a front end may read and write, per CPU
// The 6309 adds the W, V, E and F registers and the 32-bit Q accumulator; `d`, `w` and `q` are getters
// on that core (js/cpu/cpu6309.js), so the same read loop serves it.
const REGS = {
  '6809': ['a', 'b', 'd', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'],
  '6803': ['a', 'b', 'd', 'x', 's', 'pc', 'cc'],
  '6309': ['a', 'b', 'd', 'e', 'f', 'w', 'v', 'q', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc', 'md'],
};
// How a screen lays the registers out, per CPU: the program counter first, then the accumulators, then the
// index and stack pointers, MD and DP. CC is not here - it is shown as its condition-code buttons (FLAGS)
// rather than a hex field. The panel reads these tables from here rather than keeping its own copy, so a new
// CPU has one place to be added and cannot be missing from the screen.
export const REGISTER_ORDER = {
  '6809': ['pc', 'a', 'b', 'dp', 'x', 'y', 'u', 's'],
  '6803': ['pc', 'a', 'b', 'd', 'x', 's'],
  // the 6809's set plus E F W Q V MD, grouped as the core has them: A/B/E/F, then D/W/Q (each the pair
  // above it, so Q is D:W), then V and the mode/error register; X Y U S and DP follow as on the 6809
  '6309': ['pc', 'a', 'b', 'e', 'f', 'd', 'w', 'q', 'v', 'md', 'x', 'y', 'u', 's', 'dp'],
};
// How many hex digits a register's field shows, by register: two for a byte, four for a word, eight for the
// 6309's 32-bit Q. A screen reads a register's width from here rather than testing names itself. CC is not
// here: it is not a hex field (a screen draws it as its condition-code buttons), so it has no width.
export const REGISTER_DIGITS = Object.freeze({
  a: 2, b: 2, e: 2, f: 2, dp: 2, md: 2,
  d: 4, w: 4, x: 4, y: 4, u: 4, s: 4, pc: 4, v: 4,
  q: 8,
});
// the condition codes a screen shows, most significant bit first. The 6309 shares the 6809's CC layout
// (CPU6309.FLAGS is CPU6809.FLAGS).
export const FLAGS = {
  '6809': ['E', 'F', 'H', 'I', 'N', 'Z', 'V', 'C'],
  '6803': ['H', 'I', 'N', 'Z', 'V', 'C'],
  '6309': ['E', 'F', 'H', 'I', 'N', 'Z', 'V', 'C'],
};
// the registers copied into every trace entry
// the longest 6809 encoding, which is what this trace holds: LDY [$1234,X] is 10, the opcode, the postbyte and
// two address bytes. The 6309 gets its own disassembler and table (see js/asm/disassembler.js),
// and its longest encodings must be checked against this constant when that arrives.
const TRACE_BYTES = 5;
// "the labels are stale", distinct from every possible symbol source (a Map, a function's result, or null for
// none): see setSymbols() at the top of the traces section
const NO_SYMBOLS = Symbol('stale symbol source');
const TRACE_REGS = {
  '6809': ['a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'],
  '6803': ['a', 'b', 'x', 's', 'cc'],
  // the 6309's own state is what makes a trace differ between two runs, so it is in every entry
  '6309': ['a', 'b', 'e', 'f', 'x', 'y', 'u', 's', 'dp', 'cc', 'md'],
};

// how long a command that must return waits for a halted CPU before it stops with kind 'halted', in frames of
// machine time: a single step one frame; step over, run to return and run to an address two seconds (a disk's DRQ
// comes within a revolution, 0.2 s, once the motor runs; a sector not found ends the command after 5 revolutions, 1 s)
const HELD_FRAMES = { step: 1, run: 120 };

const isAddr = (v) => Number.isInteger(v) && v >= 0 && v <= 0xFFFF;

// The disassembler to read a machine's code with, and the direct page to resolve a direct operand against.
// A machine's config.cpu names the core it runs (6809, 6309, 6803), and the 6309 has its own instruction
// table - reading its code with the 6809's shows its own instructions (LDQ, AIM, TFM, ...) as data, since
// the 6809 decodes those opcodes differently or not at all. The DP is the CPU's own on the 6809 and the 6309
// (they share the direct mode); the 6803 has none. Every place that shows a machine's code uses this, so the
// debugger, the trace and "what is this code doing?" cannot disagree.
export function codeDisassembly(machine) {
  // a machine mid-construction (or a stub) may have no config or no CPU yet: 6809 with no direct page, which is
  // what an unset machine reads as, and what the tool this replaced assumed
  const cpu = (machine.config && machine.config.cpu) || '6809', core = machine.cpu;
  // the 6803 has no direct mode and no DP register; say so here rather than infer it from the core's shape, so a
  // 6803 core that ever gains a `dp` field cannot start feeding it to the disassembler unnoticed
  return { cpu, dp: cpu === '6803' || !core || !('dp' in core) ? 0 : core.dp };
}

export class Debugger {
  // machine: a Machine (or a family subclass) that has been reset and has its CPU
  // opts.traceSize: how many instructions trace() keeps (0 turns the trace off)
  // opts.symbols: a Map name -> address (the assembler's), or a function returning one, or null
  constructor(machine, { traceSize = 64, symbols = null } = {}) {
    this.machine = machine;
    this.cpu = machine.config.cpu;
    if (!REGS[this.cpu]) throw new SessionError(`the debugger has no register set for CPU ${this.cpu}`);
    this.traceSize = Math.max(0, traceSize | 0);
    this._symbols = symbols;
    this._labels = new Map();
    this._symbolsSource = NO_SYMBOLS;   // nothing read yet, so the first read always builds the labels
    this.bps = new Set();          // breakpoint addresses
    this.wps = [];                 // watchpoints: { start, size, read, write }
    this.log = [];                 // the trace ring buffer, oldest first
    this.steps = 0;                // instructions executed by step()/run()/stepOver()/runToReturn()
    this.stopped = false;
    this.stopReason = null;
    this.skipBp = null;            // an address whose breakpoint is not to fire again (set by a stop)
    this.untilPc = null;           // a one-shot arrival address (step over, run to, run to return)
    this.untilS = null;            // ...reached only with the stack pointer at or above this (not in a deeper call)
    this.hit = null;               // the watchpoint hit of the instruction just executed
    this.checkedPc = null;         // the PC whose instruction has had its breakpoint check and hasn't run yet (_go)
    this.checkedAt = 0;            // ...and the machine's redirect count then (an outside change makes it a new one)
    // the family's read, for the debugger's own view (never through the bus taps)
    this._peekMap = this._peekMapFor(machine, machine.read.bind(machine));
    this._attach();
    machine.debugger = this;       // the machine's snapshot carries its breakpoints and watchpoints
  }

  // ---------------- bus ----------------
  // The watchpoints are a client of the machine's bus taps (js/machines/bustaps.js): a tap over the whole address
  // space for each kind of access some watchpoint watches, and none while no watchpoint does, so a debugger with no
  // watchpoints leaves the bus as it is. Every real bus access (and only a real one: the 6809's dummy cycles never
  // reach the bus) of a watched kind passes through _access. The taps take replays: an instruction the CoCo 3
  // suspends reports its accesses again from the run that completes it (_stepOnce drops what the suspended run saw).
  _attach() {
    this._taps = { read: null, write: null };
    this._syncTaps();
  }
  _syncTaps() {
    const taps = this._taps, bus = this.machine.busTaps;
    if (!taps) return;
    for (const kind of ['read', 'write']) {
      const want = this.wps.some((w) => w[kind]);
      if (want && !taps[kind]) {
        const fn = (a, v) => this._access(kind, a, v);
        taps[kind] = kind === 'read' ? bus.addReadTap({ start: 0, end: 0xFFFF }, fn, { replays: true })
          : bus.addWriteTap({ start: 0, end: 0xFFFF }, fn, { replays: true });
      } else if (!want && taps[kind]) { taps[kind](); taps[kind] = null; }
    }
  }
  // unhook (the machine is thrown away, or a new debugger takes its place)
  detach() {
    const m = this.machine, taps = this._taps;
    if (taps) { if (taps.read) taps.read(); if (taps.write) taps.write(); }
    this._taps = null;
    if (m.debugger === this) m.debugger = null;
  }
  get attached() { return this._taps !== null; }
  _access(kind, address, value) {
    if (this.hit) return;          // the first access of this instruction that matches is the one reported
    for (const w of this.wps) {
      if (kind === 'read' ? !w.read : !w.write) continue;
      if (address < w.start || address >= w.start + w.size) continue;
      this.hit = { access: kind, address, value, size: 1 };
      return;
    }
  }

  // ---------------- symbols and disassembly ----------------
  // setSymbols() marks the source stale, so the next read of the trace notices and redoes its entries. The marker
  // is a sentinel rather than null: with no symbols the source IS null, so null could not mean "stale" without
  // also meaning "nothing changed" - setSymbols(null) left entries decoded against the old symbols in place.
  setSymbols(symbols) { this._symbols = symbols; this._labels = new Map(); this._symbolsSource = NO_SYMBOLS; }
  _labelsNow() {
    const s = typeof this._symbols === 'function' ? this._symbols() : this._symbols;
    if (s !== this._symbolsSource) {
      this._symbolsSource = s;
      this._labels = new Map();
      if (s) for (const [name, addr] of s) if (!this._labels.has(addr)) this._labels.set(addr, name);
      this._invalidateTrace();   // an entry decoded against the old labels must be redone
    }
    return this._labels;
  }
  // dropping the decoded text keeps trace() truthful when the symbols change under it
  _invalidateTrace() { for (const e of this.log) e._dis = undefined; }
  // a side-effect-free byte read: the debugger's own disassembly and memory view use this. It reads memory
  // directly and never goes through the watchpoint hook, so looking at a watched byte does not stop the
  // machine as if the program had touched it. Every family has a peek now - the SAM and CoCo 3 through their
  // memory maps, the MC-10 through its own, which answers $BFFF as a keyboard with no keys down instead of
  // touching the latch. The fallback below is for a machine that has none.
  peek(a) { return this._peekMap(a & 0xFFFF); }
  _peekMapFor(m, read) {
    if (typeof m.peek === 'function') return (a) => m.peek(a);   // every family: through its own map
    return (a) => (a === 0xBFFF ? 0xFF : read(a));   // no peek: the machine's read, never the $BFFF latch
  }
  // The direct page the disassembly resolves a direct operand against: the CPU's own DP, on the 6809 and the
  // 6309 alike (the 6309 shares the 6809's direct mode and has the register). The 6803 has no DP, so a direct
  // operand there is the absolute address the byte names - which is what it passes for.
  _disOpts() { const labels = this._labelsNow(); return { peek: (a) => this.peek(a), dp: codeDisassembly(this.machine).dp, labelOf: (a) => labels.get(a) || null }; }
  // disassemble `count` instructions from addr -> the disassembler's instruction records
  disassemble(addr, count = 1) { return disassembleBlock(this.cpu, addr & 0xFFFF, count, this._disOpts()); }

  // ---------------- breakpoints ----------------
  addBreakpoint(addr) {
    if (!isAddr(addr)) throw new SessionError(`breakpoint address must be a whole number from 0 to $FFFF (got ${addr})`);
    this.bps.add(addr);
    // the instruction at the PC, halted before it starts, is checked again (one under way, held by HALT, never is: _go)
    this.checkedPc = null;
    return addr;
  }
  removeBreakpoint(addr) { return this.bps.delete(addr); }
  clearBreakpoints() { this.bps.clear(); }
  breakpoints() { return [...this.bps].sort((a, b) => a - b); }

  // ---------------- watchpoints ----------------
  // start: first address; size: how many bytes; opts.read / opts.write: which accesses stop the machine
  addWatchpoint(start, size = 1, { read = true, write = true } = {}) {
    if (!isAddr(start)) throw new SessionError(`watchpoint address must be a whole number from 0 to $FFFF (got ${start})`);
    if (!Number.isInteger(size) || size < 1) throw new SessionError(`watchpoint range size must be at least 1 (got ${size})`);
    if (start + size - 1 > 0xFFFF) throw new SessionError(`watchpoint range $${start.toString(16).toUpperCase()}-$${(start + size - 1).toString(16).toUpperCase()} runs past the end of memory`);
    if (!read && !write) throw new SessionError('a watchpoint must watch reads, writes, or both');
    const w = { start, size, read: !!read, write: !!write };
    this.wps.push(w); this._syncTaps(); return w;
  }
  removeWatchpoint(w) { const i = this.wps.indexOf(w); if (i >= 0) { this.wps.splice(i, 1); this._syncTaps(); } return i >= 0; }
  clearWatchpoints() { this.wps.length = 0; this._syncTaps(); }
  watchpoints() { return this.wps.map((w) => ({ ...w })); }

  // ---------------- running ----------------
  // the program counter, for a front end that only wants to know where the machine is
  get pc() { return this.machine.cpu.pc; }
  _stop(kind, info) {
    this.stopped = true;
    this.skipBp = this.machine.cpu.pc;   // continuing from here must not stop on the same breakpoint again
    this.stopReason = Object.assign({ kind }, info);
  }
  // One CPU step through the machine's own timing, with the trace entry the step produced -> its cycles, or null
  // when no instruction ran: a halted cycle, or an instruction HALT suspended (it runs again, from its start, in a
  // later step: that one is the instruction). Its watchpoint hits are dropped with it.
  _stepOnce() {
    const m = this.machine, cpu = m.cpu;
    const before = { pc: cpu.pc };
    for (const r of TRACE_REGS[this.cpu]) before[r] = cpu[r];
    const t0 = cpu.totalCycles, c0 = m.cycle;
    // exactly one instruction through the family's own runCycles (the SAM rate, the CoCo 3 clock change, the
    // MC-10 latch timing and the stub hooks stay in charge, so a step costs what the instruction costs)
    m.runCycles(Infinity, 1);
    if (m.cpuHeld || cpu.stepHalted || (m.cycle === c0 && cpu.totalCycles === t0)) { this.hit = null; return null; }
    const cycles = cpu.totalCycles - t0;
    // the instruction is done: the run-end hooks (the memory-write observer's delivery, which may stop the run)
    if (m.runEndWatch !== null) m.runEndWatch();
    this.steps++;
    this.checkedPc = null;         // the next instruction gets its own breakpoint check
    this._record(before, cycles);
    return cycles;
  }
  // the CPU waits for HALT's release: the line is asserted, or an instruction is suspended. (The rest of a halted
  // wait after the release, cpu.haltTail, is not a wait: the time it charges has passed, and it goes at once.)
  _waiting() { return this.machine.cpuHeld || !!this.machine.cpu.haltLine; }
  // a command that must return has waited `frames` of machine time since `since` with no instruction: it stops
  _heldTooLong(since, frames) {
    const m = this.machine;
    if (m.cycle - since < frames * m.frameCycles) return false;
    this._stop('halted', { pc: m.cpu.pc });
    return true;
  }
  _record(before, cycles) {
    if (this.traceSize === 0) return;
    // The bytes are copied here and the text is made when trace() is asked: disassembling every instruction to
    // keep 64 of them made a traced run several times slower than a free one, and most runs never read the log.
    // peek() is the machine's memory as it stands later, which is not what the instruction was fetched from, so
    // the bytes are taken as it runs. TRACE_BYTES is the longest 6809 encoding (LDY [$1234,X]: 10, the opcode,
    // the postbyte and two address bytes); the 6309 core shares this 6809 disassembler and adds no longer forms.
    const e = { pc: before.pc, cycles, bytes: [] };
    for (let i = 0; i < TRACE_BYTES; i++) e.bytes.push(this.peek((before.pc + i) & 0xFFFF));
    // dp too: a direct-mode operand is resolved against the dp the instruction ran with, not the one now
    for (const r of TRACE_REGS[this.cpu]) e[r] = before[r];
    this.log.push(e);
    if (this.log.length > this.traceSize) this.log.shift();
  }
  // an entry's disassembly from the bytes copied when it ran, against the dp it ran with and the current labels
  // (so trace() says what disassembling the entry now would say)
  _disassemble(e) {
    const base = e.pc, bytes = e.bytes;
    return disassemble(this.cpu, base, { peek: (a) => bytes[a - base] & 0xFF, dp: e.dp === undefined ? 0 : e.dp,
      labelOf: (a) => this._labelsNow().get(a) || null });
  }
  // Run up to `max` instructions, stopping at a breakpoint (before it runs), at an arrival address
  // (step over / run to / run to return) or after an instruction a watchpoint saw.
  // Continuing from a stop does not stop on the same breakpoint again, so Run moves on from a breakpoint.
  run(max = 1000000) { const n = this._go((i) => i < max, max, HELD_FRAMES.run); this._syncFrames(); return n; }
  // Run until the machine's tick reaches `end` (a frame's end: Machine.runFrame(runTo) passes it), stopping as
  // run() does -> true when it got there, false when it stopped first. A machine waiting for the store
  // (m.stall) gives way too, without a stop: Machine.runFrame sees the stall and keeps the frame open.
  runTo(end) {
    const m = this.machine;
    this._go(() => m.cycle < end && !m.stall, -1, 0);
    return !this.stopped;
  }
  // a whole frame of the machine under the debugger -> false when it stopped part way (the frame stays open)
  runFrame() { return this.machine.runFrame((end) => this.runTo(end)); }
  // anything set that can stop a running machine: the frame loop runs it through the debugger only then
  get armed() { return this.bps.size > 0 || this.wps.length > 0; }
  // stop the machine where it is, at the next instruction (the front end's Pause)
  halt() { this._stop('halt', { pc: this.machine.cpu.pc }); }
  // Frame bookkeeping follows machine time. A command that runs outside the frame loop (step, Over, Out, Run to)
  // closes each frame its instructions pass, through the machine's own runFrame with nothing left to run, at the
  // point a free run would close it: after the instruction that reaches the frame's end, before the next one starts
  // (its events, sound, tape, typist and the family's own end-of-frame work included). A frame not yet open is
  // opened before an instruction runs, as the frame loop opens it. Without this, a long Over left the machine
  // frames ahead of its open frame, and Run then closed one empty frame per frame of real time before the first
  // instruction ran again. In the frame loop (runTo) the frame is open and short of its end, so this does nothing.
  _syncFrames() {
    const m = this.machine;
    while (!m.stall) {
      if (m.cycle < m.frameBase + m.frameCycles) { if (!m.frameOpen) m.runFrame(() => false); return; }
      m.runFrame(() => true);
    }
  }
  // i counts the instructions run (_stepOnce); heldFrames: how long a halted CPU is waited for (0: as long as `more`)
  _go(more, max, heldFrames) {
    const m = this.machine, cpu = m.cpu;
    const skip = this.skipBp;
    this.skipBp = null;
    this.stopped = false; this.stopReason = null; this.hit = null;
    let i = 0, first = true, since = -1;
    while (more(i)) {
      this._syncFrames();
      // once per instruction, at its start: not again while it waits for HALT's release (it is under way)
      // (an outside change drops an instruction held by HALT: the one at PC is new). An instruction still held is under
      // way: it had its check when it started, or started with no debugger running it, and gets none now
      m.cpuCheck();
      if (m.cpuHeld) { this.checkedPc = cpu.pc; this.checkedAt = m.redirects; }
      else if (this.checkedPc !== cpu.pc || this.checkedAt !== m.redirects) {
        if (this.untilPc !== null && cpu.pc === this.untilPc && (this.untilS === null || cpu.s >= this.untilS)) {
          const at = this.untilPc; this.untilPc = null; this.untilS = null;
          this._stop('until', { address: at, pc: cpu.pc });
          return i;
        }
        if (!(first && skip === cpu.pc) && this.bps.has(cpu.pc)) {
          this._stop('breakpoint', { address: cpu.pc, pc: cpu.pc });
          return i;
        }
        this.checkedPc = cpu.pc; this.checkedAt = m.redirects;
      }
      first = false;
      this.hit = null;
      const at = m.cycle;
      if (this._stepOnce() === null) {
        if (m.stall) break;        // waiting for the store: no time passes (Machine.runFrame keeps the frame open)
        if (heldFrames && this._waiting()) { if (since < 0) since = at; if (this._heldTooLong(since, heldFrames)) return i; }
        continue;
      }
      since = -1;
      i++;
      if (this.hit) { const h = this.hit; this.hit = null; this._stop('watchpoint', h); return i; }
      if (this.stopped) return i;  // a run-end hook stopped it after this instruction (a memory-write observer: 'write')
    }
    this.skipBp = null;
    return max < 0 ? max : i;
  }
  // execute exactly one instruction (a step ignores breakpoints and arrival addresses) -> its cycles. With the CPU
  // halted, it waits a frame of machine time (HELD_FRAMES.step) for an instruction to run, then stops with kind
  // 'halted' and returns 0, the PC unchanged (an instruction HALT suspended is still to run from its start).
  step() {
    this.stopped = false; this.stopReason = null; this.hit = null;
    let since = -1;
    for (;;) {
      this._syncFrames();
      const at = this.machine.cycle;
      const cycles = this._stepOnce();
      if (cycles === null) {
        if (this.machine.stall) return 0;
        if (!this._waiting()) continue;
        if (since < 0) since = at;
        if (this._heldTooLong(since, HELD_FRAMES.step)) return 0;
        continue;
      }
      if (this.hit) { const h = this.hit; this.hit = null; this._stop('watchpoint', h); }
      this._syncFrames();
      return cycles;
    }
  }
  // Run to an arrival address (and stack level), at most `max` instructions. A breakpoint or watchpoint may stop
  // it first. If neither happens within `max`, it stops anyway with kind 'limit': a command that was asked to
  // stop somewhere never leaves the machine running free.
  _runToArrival(pc, s, max) {
    this.stopped = false; this.stopReason = null;
    this.untilPc = pc; this.untilS = s;
    // (a CPU halted before the instruction at its PC starts is at that address: it counts as arrived)
    if (!this.machine.cpuHeld) this.checkedPc = null;
    const ran = this.run(max);
    this.untilPc = null; this.untilS = null;
    if (!this.stopped) this._stop('limit', { pc: this.machine.cpu.pc, instructions: ran });
    return ran;
  }
  // Step over a subroutine call: run the whole call and stop after it, back at the caller's stack level (a
  // recursive call that passes the same address deeper down does not count); any other instruction is one step.
  stepOver(max = 1000000) {
    const cpu = this.machine.cpu, pc = cpu.pc;
    const ins = this.disassemble(pc, 1)[0];
    if (!CALLS[this.cpu].has(ins.mnemonic)) { this.step(); return; }
    this._runToArrival((pc + ins.size) & 0xFFFF, cpu.s, max);
  }
  // Run until the current subroutine returns: the return address sits at the top of the stack (where each core
  // keeps it: cpu.returnAddress). The return is the arrival there with the stack above where it is now (so the
  // same address reached in a deeper call does not count).
  runToReturn(max = 1000000) {
    const cpu = this.machine.cpu, target = cpu.returnAddress((a) => this.peek(a));
    this._runToArrival(target, cpu.s + 1, max);
  }
  // run until the program counter reaches addr (at most max instructions; then it stops with kind 'limit')
  runUntil(addr, max = 1000000) {
    if (!isAddr(addr)) throw new SessionError(`run-to address must be a whole number from 0 to $FFFF (got ${addr})`);
    return this._runToArrival(addr, null, max);
  }
  // let the machine run freely again (the front end resumes its frame loop). skipBp stays set, so a Run that
  // follows one step later still moves past the breakpoint it stopped on.
  resume() { this.stopped = false; this.stopReason = null; }

  // ---------------- trace ----------------
  // the log as the front end wants it: each entry with its text, bytes and size, disassembled now from the bytes
  // kept with it (an entry is disassembled at most once; the result is cached on it)
  trace() {
    this._labelsNow();   // notice a changed symbol source even when every entry is cached, and drop their text
    return this.log.map((e) => {
      if (!e._dis) { const ins = this._disassemble(e); e._dis = { text: ins.text, size: ins.size, bytes: ins.bytes }; }
      return Object.assign({}, e, { text: e._dis.text, bytes: e._dis.bytes, size: e._dis.size });
    });
  }
  clearTrace() { this.log.length = 0; }

  // ---------------- registers and memory ----------------
  registers() {
    const cpu = this.machine.cpu, out = {};
    for (const r of REGS[this.cpu]) out[r] = cpu[r];   // d is a getter on both cores
    return out;
  }
  setRegister(name, value) {
    if (!REGS[this.cpu].includes(name)) throw new SessionError(`unknown register "${name}" for the ${this.cpu}`);
    if (!Number.isInteger(value)) throw new SessionError(`register ${name} needs a whole number (got ${value})`);
    const cpu = this.machine.cpu;
    const BYTE = new Set(['a', 'b', 'e', 'f', 'dp', 'cc', 'md']);
    const was = cpu[name];
    if (name === 'q') cpu.q = value >>> 0;
    else cpu[name] = BYTE.has(name) ? value & 0xFF : value & 0xFFFF;
    // a change drops an instruction under way (held by HALT): the CPU goes on from the state it was given (the same
    // value written back changes nothing)
    if (cpu[name] !== was) this.machine.cpuRedirected();
  }
  // memory as the machine sees it, without a bus cycle; writing goes through the bus, so a poke lands where
  // the machine's memory map puts it (including the CoCo 3's MMU)
  read(addr) { return this.peek(addr); }
  peekBytes(addr, count) { return Array.from({ length: count }, (_, i) => this.peek(addr + i)); }
  write(addr, bytes) {
    if (!isAddr(addr)) throw new SessionError(`address must be a whole number from 0 to $FFFF (got ${addr})`);
    [...bytes].forEach((b, i) => this.machine.busTaps.rawWrite((addr + i) & 0xFFFF, b & 0xFF));
    return bytes.length;
  }

  // ---------------- state (snapshots) ----------------
  saveState() {
    return { breakpoints: this.breakpoints(), watchpoints: this.watchpoints() };
  }
  loadState(s) {
    this.bps = new Set((s.breakpoints || []).map((a) => a & 0xFFFF));
    this.wps = (s.watchpoints || []).map((w) => ({ start: w.start & 0xFFFF, size: w.size, read: !!w.read, write: !!w.write }));
    this._syncTaps();
    this.stopped = false; this.stopReason = null; this.skipBp = null; this.untilPc = null; this.untilS = null; this.hit = null;
    this.checkedPc = null;
    this.log.length = 0;
  }
}
