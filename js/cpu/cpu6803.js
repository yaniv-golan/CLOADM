/*
 * CPU6803: Motorola MC6803 / MC6801 CPU core (no on-chip ROM; expanded multiplexed mode as in the Tandy MC-10).
 *
 * bus: { read(addr) -> byte, write(addr, byte), portRead(n) -> pin levels of port n (1..4),
 *        portWrite(n, value, ddr) }   (port callbacks are optional)
 * step() executes one instruction (or services one interrupt, or idles while in WAI) and returns
 * the cycles used. `trace(cpu)` is called before each instruction; `c` holds the current
 * instruction's cycle count while it executes (the machine uses it to time mid-instruction I/O);
 * `totalCycles` counts every cycle since construction.
 *
 * On-chip peripherals: ports 1-4 and their DDRs, the 16-bit free-running counter with output compare
 * and input capture (TCSR with ICF/OCF/TOF and their interrupts), 128 bytes of RAM at $80-$FF with the
 * RAM control register, and the SCI registers (storage only: the SCI shift logic is not emulated,
 * the MC-10 does not use it).
 *
 * Interrupt priority: NMI, IRQ1, ICF, OCF, TOF, SCI. The MC6801/6803 has no TRAP: undefined opcodes
 * execute as 1-byte, 4-cycle no-ops (as in MAME's m6803). Set `trapIllegal` to get the HD6301/6303
 * behaviour instead (push state, vector $FFEE).
 *
 * `mameCompat` reproduces two MAME bookkeeping artefacts so that traces can be compared with MAME
 * cycle for cycle (tools/mame-diff/mc10). They are not believed to be hardware behaviour:
 *  - on-chip timer registers are accessed with the counter value at the start of the instruction and
 *    timer flags only change at instruction boundaries (real mode: the access happens on the
 *    instruction's last cycle);
 *  - after TAP, and CLI with I previously set, MAME runs the next instruction before it accounts the
 *    2 cycles of the TAP/CLI.
 * (MAME also counts WAI's 9 cycles after the wait when the wake-up falls in the same scheduler
 * timeslice as the WAI; that depends on MAME's scheduling and is not reproduced.)
 * The one-instruction interrupt shadow after TAP / CLI is kept in both modes (MAME does it too;
 * hardware behaviour unverified).
 */
import { state } from '../util.js';

const H = 0x20, I = 0x10, N = 0x08, Z = 0x04, V = 0x02, C = 0x01;
// TCSR bits
const OLVL = 0x01, IEDG = 0x02, ETOI = 0x04, EOCI = 0x08, EICI = 0x10, TOF = 0x20, OCF = 0x40, ICF = 0x80;

// ---- cycle table (from the MC6801 data sheet instruction timing) ----
const ILLEGAL = new Set([0x00, 0x02, 0x03, 0x12, 0x13, 0x14, 0x15, 0x18, 0x1A, 0x1C, 0x1D, 0x1E, 0x1F,
  0x41, 0x42, 0x45, 0x4B, 0x4E, 0x51, 0x52, 0x55, 0x5B, 0x5E, 0x61, 0x62, 0x65, 0x6B, 0x71, 0x72, 0x75, 0x7B]);
const CYC = new Uint8Array(256);
(function buildCycles() {
  const set = (ops, n) => ops.forEach((o) => { CYC[o] = n; });
  for (let o = 0; o < 0x20; o++) CYC[o] = 2;
  set([0x04, 0x05, 0x08, 0x09], 3);                       // LSRD ASLD INX DEX
  for (let o = 0x20; o < 0x30; o++) CYC[o] = 3;          // branches
  set([0x30, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3A], 3);     // TSX INS DES TXS PSHA PSHB ABX
  set([0x32, 0x33, 0x3C], 4);                             // PULA PULB PSHX
  set([0x38, 0x39], 5);                                   // PULX RTS
  set([0x3B, 0x3D], 10); CYC[0x3E] = 9; CYC[0x3F] = 12;   // RTI MUL WAI SWI
  for (let o = 0x40; o < 0x60; o++) CYC[o] = 2;
  for (let o = 0x60; o < 0x80; o++) CYC[o] = 6;
  CYC[0x6E] = 3; CYC[0x7E] = 3;                           // JMP
  for (let o = 0x80; o < 0x100; o++) {
    const mode = (o >> 4) & 3, lo = o & 0xF, b = o >= 0xC0;
    let n = [2, 3, 4, 4][mode];                           // 8-bit ops
    if (lo === 0x3 || (!b && lo === 0xC)) n = [4, 5, 6, 6][mode];          // SUBD ADDD CPX
    else if (lo === 0xE || (b && lo === 0xC)) n = [3, 4, 5, 5][mode];      // LDS LDX LDD
    else if (lo === 0xF || (b && lo === 0xD)) n = [3, 4, 5, 5][mode];      // STS STX STD
    else if (!b && lo === 0xD) n = [6, 5, 6, 6][mode];                     // BSR JSR
    CYC[o] = n;
  }
  CYC[0xCD] = 4;                                          // undefined STD immediate
  for (const o of ILLEGAL) CYC[o] = 4;
})();

class CPU6803 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.x = 0; this.s = 0; this.pc = 0; this.cc = 0xC0 | I;
    this.irqLine = false;      // IRQ1, level-triggered
    this.nmiPending = false;
    this.waiting = false;      // WAI
    this.shadow = false;       // interrupts not recognised before the next instruction (after TAP/CLI)
    this.deferred = 0;         // mameCompat: cycles still to be accounted
    this.deferMe = false;
    this.c = 0;
    this.t0 = 0;               // totalCycles at the start of the current instruction
    this.totalCycles = 0;
    this.trace = null;
    this.mameCompat = false;
    this.trapIllegal = false;
    this.modeBits = 0x40;      // port 2 bits 5-7 read back the operating mode latched at reset (mode 2)
    this.iram = new Uint8Array(128);
    this.ddr = new Uint8Array(4);
    this.port = new Uint8Array(4);
    this.resetPeripherals();
  }

  resetPeripherals() {
    this.ddr.fill(0);
    // port 2 drives nothing until its data register has been written (or the output compare drives P21): MAME 0.264
    // m6801.cpp write_port2 returns while !m_port2_written, which reset clears (device_reset) and a data write sets
    // (p2_data_w). The MC6803's data registers are not set by reset, so making P20 an output before writing its data
    // has no defined level on the hardware; MAME drives none, and nor do we (a stub or program that sets the DDR
    // first then prints no stray start bit: tools/mame-diff/mc10/printer-glitch.asm).
    this.p2Written = false;
    this.p3csr = 0;
    this.tcsr = 0; this.pend = 0;
    this.ocr = 0xFFFF; this.icr = 0; this.latch09 = 0;
    this.tin = 1;
    this.rmcr = 0; this.trcsr = 0x20; this.rdr = 0; this.tdr = 0;
    this.ramc = (this.ramc || 0) | 0x40;
    // counter(t) = (ctBase + t - tBase) & 0xFFFF; events at times <= *Done are already handled
    this.ctBase = 0; this.tBase = this.totalCycles;
    this.ocDone = this.totalCycles; this.ovDone = this.totalCycles;
    this.calcNext();
  }

  reset() {
    this.cc = 0xC0 | I;
    this.waiting = false; this.shadow = false; this.deferred = 0;
    this.nmiPending = false;
    this.resetPeripherals();
    this.pc = this.read16(0xFFFE);
  }

  nmi() { this.nmiPending = true; }
  // start executing at addr (leaves any WAI state)
  jump(addr) { this.pc = addr & 0xFFFF; this.waiting = false; this.shadow = false; }

  // the on-chip RAM (iram) is a view into the machine's memory and is saved with it; the next
  // timer event times are derived (calcNext)
  saveState() { return state.save(this, CPU6803.STATE); }
  // A file saved before p2Written existed has none: it was saved by a build that always drove port 2, so it restores
  // as written (true), keeping that behaviour. A current file always carries it. (This adds a field to the 6803's
  // state only; a 6809/6309/7000 snapshot is unchanged, so SNAPSHOT_VERSION does not move.)
  loadState(s) {
    if (!('p2Written' in s)) s = Object.assign({ p2Written: true }, s);
    state.load(this, s, CPU6803.STATE);
    this.calcNext();
  }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xFF; this.b = v & 0xFF; }
  // cycle at which the current instruction's data access happens
  ioTime() { return this.mameCompat ? this.t0 : this.t0 + (this.c > 0 ? this.c - 1 : 0); }

  // ---------------- free-running timer ----------------
  counterAt(t) { return (this.ctBase + (t - this.tBase)) & 0xFFFF; }
  // first time > done at which the counter holds value v
  hitAfter(done, v) { let d = (v - this.counterAt(done)) & 0xFFFF; if (d === 0) d = 0x10000; return done + d; }
  calcNext() {
    this.nextOc = this.hitAfter(this.ocDone, this.ocr);
    this.nextOv = this.hitAfter(this.ovDone, 0xFFFF);
    this.nextEvent = Math.min(this.nextOc, this.nextOv);
  }
  // apply timer events up to and including time t
  timerSync(t) {
    while (this.nextEvent <= t) {
      if (this.nextOc <= this.nextOv) {
        this.ocDone = this.nextOc;
        this.tcsr |= OCF; this.pend |= OCF;
        if (this.ddr[1] & 0x02) { // output compare drives P21 when it is an output
          this.port[1] = (this.port[1] & ~0x02) | ((this.tcsr & OLVL) << 1);
          this.p2Written = true;   // (MAME m6801.cpp: the output compare sets m_port2_written too)
          this.writePort(1);
        }
      } else {
        this.ovDone = this.nextOv;
        this.tcsr |= TOF; this.pend |= TOF; // TOF is set when the counter holds $FFFF
      }
      this.calcNext();
    }
  }
  // counter / compare register changed at time t: events at t itself count in MAME (compat) mode
  timerRestart(t) {
    const done = this.mameCompat ? t - 1 : t;
    this.ocDone = done; this.ovDone = done;
    this.calcNext();
  }
  // input capture pin (P20): call with the pin level whenever it changes
  setTin(level) {
    level = level ? 1 : 0;
    if (level === this.tin) return;
    this.tin = level;
    if (this.ddr[1] & 0x01) return; // P20 is an output
    if (((this.tcsr & IEDG) ? 1 : 0) !== level) return; // IEDG=0: falling edge, 1: rising edge
    const t = this.totalCycles;
    this.timerSync(t);
    this.icr = this.counterAt(t);
    this.tcsr |= ICF; this.pend |= ICF;
  }

  // ---------------- on-chip registers ----------------
  writePort(n) {
    if (n === 1 && !this.p2Written) return;
    const ddr = this.ddr[n];
    if (this.bus.portWrite) this.bus.portWrite(n + 1, ((this.port[n] & ddr) | (~ddr & 0xFF)) & (n === 1 ? 0x1F : 0xFF), ddr);
  }
  portIn(n) {
    const ddr = this.ddr[n];
    const pins = this.bus.portRead ? this.bus.portRead(n + 1) : 0xFF;
    return ((pins & ~ddr) | (this.port[n] & ddr)) & 0xFF;
  }
  regRead(a) {
    switch (a) {
      case 0x00: case 0x01: case 0x04: case 0x05: return 0xFF; // DDRs are write-only
      case 0x02: return this.portIn(0);
      case 0x03: return (this.portIn(1) & 0x1F) | (this.modeBits & 0xE0);
      case 0x06: return this.portIn(2);
      case 0x07: return this.portIn(3);
      case 0x08: this.timerSync(this.ioTime()); this.pend = 0; return this.tcsr;
      // no low-byte latch: $0A reads the live counter (as MAME; within one LDD both bytes are
      // read at the same ioTime, so they are consistent)
      case 0x09: {
        const t = this.ioTime(); this.timerSync(t);
        if (!(this.pend & TOF)) this.tcsr &= ~TOF;
        return this.counterAt(t) >> 8;
      }
      case 0x0A: return this.counterAt(this.ioTime()) & 0xFF;
      case 0x0B: return this.ocr >> 8;
      case 0x0C: return this.ocr & 0xFF;
      // ICR high byte first (MAME 0.264 returns the two bytes swapped; that looks like a MAME bug)
      case 0x0D: this.timerSync(this.ioTime()); if (!(this.pend & ICF)) this.tcsr &= ~ICF; return this.icr >> 8;
      case 0x0E: return this.icr & 0xFF;
      case 0x0F: return this.p3csr;
      case 0x10: return this.rmcr;
      case 0x11: return this.trcsr;
      case 0x12: return this.rdr;
      case 0x14: return this.ramc | 0x3F; // bits 0-5 unused, read as 1
    }
    return this.bus.read(a); // $13 (write-only) and $15-$1F: reserved, external bus
  }
  regWrite(a, v) {
    switch (a) {
      case 0x00: case 0x01: case 0x04: case 0x05: {
        const n = a < 2 ? a : a - 2;
        if (this.ddr[n] !== v) { this.ddr[n] = v; this.writePort(n); }
        return;
      }
      case 0x02: this.port[0] = v; this.writePort(0); return;
      case 0x03: this.port[1] = v; this.p2Written = true; this.writePort(1); return;
      case 0x06: this.port[2] = v; this.writePort(2); return;
      case 0x07: this.port[3] = v; this.writePort(3); return;
      case 0x08: { const t = this.ioTime(); this.timerSync(t); this.tcsr = (v & 0x1F) | (this.tcsr & 0xE0); this.pend &= this.tcsr; return; }
      case 0x09: case 0x0A: {
        // a write to $09 presets the counter to $FFF8. A write to $0A loads latch:value - that is the
        // HD6301 double-byte write, which MAME also applies to the 6801 (6801 data sheet: $09 only).
        const t = this.ioTime(); this.timerSync(t);
        let val;
        if (a === 0x09) { this.latch09 = v; val = 0xFFF8; } else val = (this.latch09 << 8) | v;
        this.ctBase = val; this.tBase = t;
        this.timerRestart(t);
        return;
      }
      case 0x0B: case 0x0C: {
        const t = this.ioTime(); this.timerSync(t);
        if (!(this.pend & OCF)) this.tcsr &= ~OCF;
        const nv = a === 0x0B ? (this.ocr & 0xFF) | (v << 8) : (this.ocr & 0xFF00) | v;
        if (nv !== this.ocr) {
          this.ocr = nv;
          const done = this.mameCompat ? t - 1 : t;
          this.ocDone = done;
          this.calcNext();
        }
        return;
      }
      case 0x0F: this.p3csr = v; return;
      case 0x10: this.rmcr = v; return;
      case 0x11: this.trcsr = (this.trcsr & 0xE0) | (v & 0x1F); return;
      case 0x13: this.tdr = v; return;
      case 0x14: this.ramc = v; return;
    }
    if (a > 0x14) this.bus.write(a, v);
  }

  // ---------------- memory ----------------
  read8(a) {
    a &= 0xFFFF;
    if (a < 0x100) {
      if (a < 0x20) return this.regRead(a);
      if (a >= 0x80 && (this.ramc & 0x40)) return this.iram[a - 0x80];
    }
    return this.bus.read(a);
  }
  write8(a, v) {
    a &= 0xFFFF; v &= 0xFF;
    if (a < 0x100) {
      if (a < 0x20) { this.regWrite(a, v); return; }
      if (a >= 0x80 && (this.ramc & 0x40)) { this.iram[a - 0x80] = v; return; }
    }
    this.bus.write(a, v);
  }
  read16(a) { return (this.read8(a) << 8) | this.read8(a + 1); }
  write16(a, v) { this.write8(a, v >> 8); this.write8(a + 1, v); }
  fetch8() { const v = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const h = this.fetch8(); return (h << 8) | this.fetch8(); }
  push8(v) { this.write8(this.s, v); this.s = (this.s - 1) & 0xFFFF; }
  push16(v) { this.push8(v); this.push8(v >> 8); }
  pull8() { this.s = (this.s + 1) & 0xFFFF; return this.read8(this.s); }
  // The return address a JSR/BSR left on the stack, read with rd (a side-effect-free peek): the 6803 pushes the low
  // byte first and post-decrements, so S points below it and the address is at S+1 (high) and S+2 (low)
  // (MC6803 data sheet, JSR/RTS).
  returnAddress(rd) { const a = (this.s + 1) & 0xFFFF; return (rd(a) << 8) | rd((a + 1) & 0xFFFF); }
  pull16() { const h = this.pull8(); return (h << 8) | this.pull8(); }
  pushAll() { this.push16(this.pc); this.push16(this.x); this.push8(this.a); this.push8(this.b); this.push8(this.cc); }

  // ---------------- flags ----------------
  nz8(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x80 ? N : 0) | (r & 0xFF ? 0 : Z); }
  ld8(r) { this.cc = (this.cc & ~(N | Z | V)) | (r & 0x80 ? N : 0) | (r ? 0 : Z); return r; }
  ld16(r) { this.cc = (this.cc & ~(N | Z | V)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z); return r; }
  add8(a, b, cin) {
    const r = a + b + cin;
    this.cc = (this.cc & ~(H | N | Z | V | C)) | ((a ^ b ^ r) & 0x10 ? H : 0) | (r & 0x80 ? N : 0) |
      (r & 0xFF ? 0 : Z) | ((a ^ r) & (b ^ r) & 0x80 ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  sub8(a, b, cin) {
    const r = a - b - cin;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r & 0xFF ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x80 ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  add16(a, b) {
    const r = a + b;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | (r & 0xFFFF ? 0 : Z) |
      ((a ^ r) & (b ^ r) & 0x8000 ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | (r & 0xFFFF ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x8000 ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }
  // V = N xor C after a shift
  nvc(r, c) {
    const n = r & 0x80 ? N : 0;
    this.cc = (this.cc & ~(N | Z | V | C)) | n | (r ? 0 : Z) | (c ? C : 0) | ((!!n) !== (!!c) ? V : 0);
    return r;
  }
  // unary op by low nibble of opcode; returns the result or -1 when nothing is written
  unary(lo, v) {
    const cc = this.cc;
    switch (lo) {
      case 0x0: { const r = (-v) & 0xFF; this.cc = (cc & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r ? 0 : Z) | (v === 0x80 ? V : 0) | (v ? C : 0); return r; }
      case 0x3: { const r = (~v) & 0xFF; this.cc = (cc & ~(N | Z | V)) | C; this.nz8(r); return r; }
      case 0x4: return this.nvc(v >> 1, v & 1);
      case 0x6: return this.nvc((v >> 1) | (cc & C ? 0x80 : 0), v & 1);
      case 0x7: return this.nvc((v >> 1) | (v & 0x80), v & 1);
      case 0x8: return this.nvc((v << 1) & 0xFF, v & 0x80);
      case 0x9: return this.nvc(((v << 1) | (cc & C)) & 0xFF, v & 0x80);
      case 0xA: { const r = (v - 1) & 0xFF; this.cc = (cc & ~V) | (r === 0x7F ? V : 0); this.nz8(r); return r; }
      case 0xC: { const r = (v + 1) & 0xFF; this.cc = (cc & ~V) | (r === 0x80 ? V : 0); this.nz8(r); return r; }
      case 0xD: this.cc = cc & ~(V | C); this.nz8(v); return -1;
      case 0xF: this.cc = (cc & ~(N | V | C)) | Z; return 0;
    }
    return -1;
  }
  cond(c) {
    const cc = this.cc;
    switch (c) {
      case 0x0: return true;
      case 0x1: return false;
      case 0x2: return !(cc & (C | Z));
      case 0x3: return !!(cc & (C | Z));
      case 0x4: return !(cc & C);
      case 0x5: return !!(cc & C);
      case 0x6: return !(cc & Z);
      case 0x7: return !!(cc & Z);
      case 0x8: return !(cc & V);
      case 0x9: return !!(cc & V);
      case 0xA: return !(cc & N);
      case 0xB: return !!(cc & N);
      case 0xC: return !(cc & N) === !(cc & V);
      case 0xD: return !(cc & N) !== !(cc & V);
      case 0xE: return !(cc & Z) && (!(cc & N) === !(cc & V));
      default: return !!(cc & Z) || (!(cc & N) !== !(cc & V));
    }
  }

  // ---------------- interrupts ----------------
  // which on-chip (IRQ2) source is requesting, as its vector, or 0
  irq2Vector() {
    const t = this.tcsr;
    if ((t & (ICF | EICI)) === (ICF | EICI)) return 0xFFF6;
    if ((t & (OCF | EOCI)) === (OCF | EOCI)) return 0xFFF4;
    if ((t & (TOF | ETOI)) === (TOF | ETOI)) return 0xFFF2;
    const s = this.trcsr;
    if ((s & 0x10) && (s & 0xC0)) return 0xFFF0;
    if ((s & 0x24) === 0x24) return 0xFFF0;
    return 0;
  }
  pendingVector() {
    if (this.nmiPending) { this.nmiPending = false; return 0xFFFC; }
    if (this.cc & I) return 0;
    if (this.irqLine) return 0xFFF8;
    return this.irq2Vector();
  }
  enterInterrupt(vec) {
    let n;
    if (this.waiting) { this.waiting = false; n = 4; } else { this.pushAll(); n = 12; }
    this.cc |= I;
    this.pc = this.read16(vec);
    return n;
  }

  // will the next step() execute the instruction at pc (rather than wait or take an interrupt)? Used
  // for PC hooks, so that an interrupt arriving at a hooked address doesn't run the hook twice.
  willExecute() {
    if (!this.shadow && (this.nmiPending || (!(this.cc & I) && (this.irqLine || this.irq2Vector())))) return false;
    return !this.waiting;
  }
  step() {
    const start = this.totalCycles;
    this.t0 = start;
    this.timerSync(start);
    if (this.shadow) this.shadow = false;
    else if (this.nmiPending || this.irqLine || this.tcsr & 0xE0 || this.trcsr & 0xC0 || (this.trcsr & 0x24) === 0x24) {
      const vec = this.pendingVector();
      if (vec) {
        this.c = this.enterInterrupt(vec) + this.deferred;
        this.deferred = 0;
        this.totalCycles += this.c;
        return this.c;
      }
    }
    if (this.waiting) {
      // idle until the next timer event (bounded so that the machine sees time pass)
      let n = Math.min(64, Math.max(1, this.nextEvent - start));
      this.totalCycles += n;
      return n;
    }
    if (this.trace) this.trace(this);
    const op = this.fetch8();
    this.c = CYC[op];
    this.exec(op);
    let n = this.c;
    if (this.deferMe) { this.deferMe = false; if (this.mameCompat) { this.deferred += n; n = 0; } }
    else if (this.deferred) { n += this.deferred; this.deferred = 0; }
    this.totalCycles += n;
    return n;
  }

  exec(op) {
    if (op >= 0x80) { this.execHigh(op); return; }
    if (op >= 0x20 && op < 0x30) {
      const o = this.fetch8();
      if (this.cond(op & 0xF)) this.pc = (this.pc + ((o ^ 0x80) - 0x80)) & 0xFFFF;
      return;
    }
    if (op >= 0x40) {
      const lo = op & 0xF;
      if (ILLEGAL.has(op)) { this.illegal(); return; }
      if (op < 0x60) {
        if (op < 0x50) { const r = this.unary(lo, this.a); if (r >= 0) this.a = r; }
        else { const r = this.unary(lo, this.b); if (r >= 0) this.b = r; }
        return;
      }
      const ea = op < 0x70 ? (this.x + this.fetch8()) & 0xFFFF : this.fetch16();
      if (lo === 0xE) { this.pc = ea; return; } // JMP
      if (lo === 0xF) { this.write8(ea, this.unary(0xF, 0)); return; } // CLR: no read cycle
      const r = this.unary(lo, this.read8(ea));
      if (r >= 0) this.write8(ea, r);
      return;
    }
    switch (op) {
      case 0x01: return; // NOP
      case 0x04: { const d = this.d, r = d >> 1; this.d = r; // LSRD
        this.cc = (this.cc & ~(N | Z | V | C)) | (r ? 0 : Z) | (d & 1 ? C | V : 0); return; }
      case 0x05: { const d = this.d, r = (d << 1) & 0xFFFF; this.d = r; // ASLD
        const n = r & 0x8000 ? N : 0, c = d & 0x8000 ? C : 0;
        this.cc = (this.cc & ~(N | Z | V | C)) | n | c | (r ? 0 : Z) | ((!!n) !== (!!c) ? V : 0); return; }
      case 0x06: this.cc = this.a | 0xC0; this.shadow = true; this.deferMe = true; return; // TAP (bits 6-7 read as 1)
      case 0x07: this.a = this.cc; return; // TPA
      case 0x08: this.x = (this.x + 1) & 0xFFFF; this.cc = (this.cc & ~Z) | (this.x ? 0 : Z); return;
      case 0x09: this.x = (this.x - 1) & 0xFFFF; this.cc = (this.cc & ~Z) | (this.x ? 0 : Z); return;
      case 0x0A: this.cc &= ~V; return;
      case 0x0B: this.cc |= V; return;
      case 0x0C: this.cc &= ~C; return;
      case 0x0D: this.cc |= C; return;
      case 0x0E: if (this.cc & I) { this.shadow = true; this.deferMe = true; } this.cc &= ~I; return; // CLI
      case 0x0F: this.cc |= I; return;
      case 0x10: this.a = this.sub8(this.a, this.b, 0); return; // SBA
      case 0x11: this.sub8(this.a, this.b, 0); return; // CBA
      case 0x16: this.b = this.ld8(this.a); return; // TAB
      case 0x17: this.a = this.ld8(this.b); return; // TBA
      case 0x19: { // DAA (V cleared; C keeps a previous carry)
        const a = this.a, lsn = a & 0x0F, msn = a & 0xF0;
        let cf = 0;
        if (lsn > 9 || (this.cc & H)) cf |= 0x06;
        if (msn > 0x90 || (this.cc & C) || (msn > 0x80 && lsn > 9)) cf |= 0x60;
        const r = a + cf;
        this.a = r & 0xFF;
        this.cc = (this.cc & ~(N | Z | V)) | (r & 0x100 ? C : 0);
        this.nz8(this.a);
        return;
      }
      case 0x1B: this.a = this.add8(this.a, this.b, 0); return; // ABA
      case 0x30: this.x = (this.s + 1) & 0xFFFF; return; // TSX
      case 0x31: this.s = (this.s + 1) & 0xFFFF; return; // INS
      case 0x32: this.a = this.pull8(); return;
      case 0x33: this.b = this.pull8(); return;
      case 0x34: this.s = (this.s - 1) & 0xFFFF; return; // DES
      case 0x35: this.s = (this.x - 1) & 0xFFFF; return; // TXS
      case 0x36: this.push8(this.a); return;
      case 0x37: this.push8(this.b); return;
      case 0x38: this.x = this.pull16(); return; // PULX
      case 0x39: this.pc = this.pull16(); return; // RTS
      case 0x3A: this.x = (this.x + this.b) & 0xFFFF; return; // ABX
      case 0x3B: // RTI
        this.cc = this.pull8() | 0xC0; this.b = this.pull8(); this.a = this.pull8();
        this.x = this.pull16(); this.pc = this.pull16();
        return;
      case 0x3C: this.push16(this.x); return; // PSHX
      case 0x3D: { const r = this.a * this.b; this.d = r; this.cc = (this.cc & ~C) | (r & 0x80 ? C : 0); return; } // MUL
      case 0x3E: // WAI
        this.pushAll(); this.waiting = true;
        return;
      case 0x3F: this.pushAll(); this.cc |= I; this.pc = this.read16(0xFFFA); return; // SWI
    }
    this.illegal();
  }

  illegal() {
    if (!this.trapIllegal) return; // MC6801/6803: no-op (4 cycles)
    // HD6301/6303 TRAP: the stacked PC is the address of the offending opcode
    this.pc = (this.pc - 1) & 0xFFFF;
    this.pushAll(); this.cc |= I;
    this.pc = this.read16(0xFFEE);
    this.c = 12;
  }

  execHigh(op) {
    const mode = (op >> 4) & 3; // 0 imm, 1 dir, 2 idx, 3 ext
    const lo = op & 0x0F, isB = op >= 0xC0;
    const ea = () => (mode === 1 ? this.fetch8() : mode === 2 ? (this.x + this.fetch8()) & 0xFFFF : this.fetch16());
    const m16 = () => (mode === 0 ? this.fetch16() : this.read16(ea()));
    switch (lo) {
      case 0x3: if (isB) this.d = this.add16(this.d, m16()); else this.d = this.sub16(this.d, m16()); return; // ADDD / SUBD
      case 0x7: { // STA / STB (immediate form: undefined, stores into the operand byte)
        const v = this.ld8(isB ? this.b : this.a);
        let addr;
        if (mode === 0) { addr = this.pc; this.pc = (this.pc + 1) & 0xFFFF; } else addr = ea();
        this.write8(addr, v);
        return;
      }
      case 0xC:
        if (isB) this.d = this.ld16(m16()); // LDD
        else this.sub16(this.x, m16()); // CPX (full flags on the 6801)
        return;
      case 0xD:
        if (!isB) { // BSR / JSR
          if (mode === 0) { const o = this.fetch8(); this.push16(this.pc); this.pc = (this.pc + ((o ^ 0x80) - 0x80)) & 0xFFFF; return; }
          const t = ea(); this.push16(this.pc); this.pc = t; return;
        }
        // STD (immediate form undefined: stores into the operand bytes)
        this.st16(mode, this.d, ea);
        return;
      case 0xE: { const v = this.ld16(m16()); if (isB) this.x = v; else this.s = v; return; } // LDX / LDS
      case 0xF: this.st16(mode, isB ? this.x : this.s, ea); return; // STX / STS
    }
    const m = mode === 0 ? this.fetch8() : this.read8(ea());
    const acc = isB ? this.b : this.a;
    let r = acc;
    switch (lo) {
      case 0x0: r = this.sub8(acc, m, 0); break;
      case 0x1: this.sub8(acc, m, 0); break;
      case 0x2: r = this.sub8(acc, m, this.cc & C); break;
      case 0x4: r = this.ld8(acc & m); break;
      case 0x5: this.ld8(acc & m); break;
      case 0x6: r = this.ld8(m); break;
      case 0x8: r = this.ld8(acc ^ m); break;
      case 0x9: r = this.add8(acc, m, this.cc & C); break;
      case 0xA: r = this.ld8(acc | m); break;
      case 0xB: r = this.add8(acc, m, 0); break;
    }
    if (isB) this.b = r; else this.a = r;
  }
  st16(mode, v, ea) {
    this.ld16(v);
    let addr;
    if (mode === 0) { addr = this.pc; this.pc = (this.pc + 2) & 0xFFFF; } else addr = ea();
    this.write16(addr, v);
  }
}

CPU6803.FLAGS = { H, I, N, Z, V, C };
CPU6803.TCSR = { OLVL, IEDG, ETOI, EOCI, EICI, TOF, OCF, ICF };
CPU6803.CYCLES = CYC;
CPU6803.ILLEGAL = ILLEGAL;
CPU6803.STATE = ['a', 'b', 'x', 's', 'pc', 'cc', 'irqLine', 'nmiPending', 'waiting', 'shadow', 'deferred', 'deferMe', 'c', 't0',
  'totalCycles', 'modeBits', 'ddr', 'port', 'p3csr', 'tcsr', 'pend', 'ocr', 'icr', 'latch09', 'tin', 'rmcr', 'trcsr', 'rdr', 'tdr',
  'ramc', 'ctBase', 'tBase', 'ocDone', 'ovDone', 'p2Written'];

export { CPU6803 };
