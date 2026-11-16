/*
 * Motorola 6809 CPU core.
 * bus: { read(addr) -> byte, write(addr, byte) }
 * step() executes one instruction (or services one interrupt) and returns cycles used.
 *
 * Bus cycles: besides real reads and writes, the 6809 spends cycles presenting other addresses: a dummy
 * read of the byte at PC, or $FFFF on "VMA" cycles. Every cycle of a step is logged in order in
 * cycleAddr[0..cycleCount) so that a machine whose memory timing depends on the address (the SAM's
 * address-dependent rate) can time each cycle. The order and addresses follow XRoar's 6809 core
 * (src/mc6809/mc6809.c, 1.13), which takes them from bus captures of real 6809s (hoglet67's 6809 decoder);
 * MAME's m6809.lst has the same cycles but presents other dummy addresses in a few places (16-bit compares
 * and adds, JSR, RTS, read-modify-write, n8,R and n16,PCR indexing). tools/mame-diff/sam/run-xroar.js checks
 * every instruction's timing at the address-dependent rate against XRoar. Dummy cycles are logged, not
 * performed (no reads with side effects). cycleCount always ends equal to c.
 */
import { state } from '../util.js';

const CWAI_ENTRY = 4; // registers already stacked by CWAI: only the vector fetch remains (calibrated against MAME)
const CYCLE_LOG = 96;  // capacity of one step's bus-cycle log (the longest instruction, TFM, logs 4 per byte)
const E = 0x80, F = 0x40, H = 0x20, I = 0x10, N = 0x08, Z = 0x04, V = 0x02, C = 0x01;
// Cycle counts per addressing mode (0 immediate, 1 direct, 2 indexed, 3 extended), by operation. These were
// array literals written at each instruction; they are constants, so they live here once. (The review called
// this a per-instruction allocation; measured, it is not - V8's escape analysis already removes such
// short-lived literals. What the change buys is less work per instruction: one table lookup instead of
// building the array, and one method call instead of creating a closure.)
const CYCLES = {
  jsr: [7, 7, 7, 8],    // JSR (BSR is immediate-only and has its own count)
  load16: [3, 5, 5, 6], // the 16-bit loads and stores: LDX/LDD/LDU and STX/STD/STU
  alu8: [2, 4, 4, 5],   // 8-bit reads and stores
  cmpd: [5, 7, 7, 8],   // CMPD, CMPY, CMPU, CMPS
  page2: [4, 6, 6, 7],  // SUBD, ADDD and CMPX; and page 2's LDY/LDS and STY/STS
};

class CPU6809 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.x = 0; this.y = 0; this.u = 0; this.s = 0;
    this.pc = 0; this.dp = 0; this.cc = I | F;
    this.opPc = 0;          // start of the instruction being executed (only meaningful during one)
    this.irqLine = false;   // level-triggered, set by machine
    this.firqLine = false;  // level-triggered, set by machine
    this.haltLine = false;  // HALT input (e.g. a disk controller holding the CPU during a transfer)
    // cycles of an instruction still to run after HALT is released: MAME suspends its 6809 at the check point
    // where HALT arrives, inside an instruction, and runs the rest after; the machine sets this with
    // config.mameCompat (a real 6809 halts at the end of the instruction)
    this.haltTail = 0;
    this.nmiPending = false;
    this.nmiArmed = false;
    this.cwai = false;
    this.syncing = false;
    this.c = 0;             // cycles of current instruction
    this.cycleAddr = new Int32Array(CYCLE_LOG);   // address of each bus cycle of the current step
    this.cycleCount = 0;
    // 1 where MAME's m6809 cannot stop after this cycle (no '@' check point in m6809.lst: a multi-cycle
    // dummy_vma(n), or a statement without '@'); used only to reproduce MAME's scheduler slices (mameCompat)
    this.cycleNoStop = new Uint8Array(CYCLE_LOG);
    // 1 where the cycle is internal: a dummy read at PC or a $FFFF VMA cycle, with no memory access.
    // The HD6309 in native mode runs some of them as part of its shorter instruction (dropInternal).
    this.cycleInternal = new Uint8Array(CYCLE_LOG);
    this.cycleDrop = new Uint8Array(CYCLE_LOG);      // cycles removed by dropInternal() this step
    this.droppedInternal = 0;   // internal cycles dropped from the current step (native mode)
    this.trace = null;      // optional hook called before each instruction (tests, debugger)
    this.mameCompat = false; // reproduce MAME's m6809 where it differs (comparisons only; set by the machine)
    this.totalCycles = 0;
  }

  reset() {
    this.dp = 0;
    this.cc = I | F;
    this.nmiArmed = false;
    this.nmiPending = false;
    this.cwai = false;
    this.syncing = false;
    this.pc = this.read16(0xFFFE);
  }

  // an NMI edge: taken only once the program has loaded S (LDS, LEAS or TFR r,S; not EXG). An edge before that is
  // lost, not kept for later (MAME 0.264 m6809.cpp execute_set_input, m6809.lst TFR, base6x09.lst LD16/LEA_us)
  nmi() { if (this.nmiArmed) this.nmiPending = true; }

  saveState() { return state.save(this, CPU6809.STATE); }
  loadState(s) { state.load(this, s, CPU6809.STATE); }
  // start executing at addr (used to run injected programs)
  jump(addr) { this.pc = addr & 0xFFFF; this.cwai = false; this.syncing = false; }

  // ---- memory helpers ----
  read8(a) { this.cycleNoStop[this.cycleCount] = 0; this.cycleInternal[this.cycleCount] = 0; this.cycleAddr[this.cycleCount++] = a & 0xFFFF; return this.bus.read(a & 0xFFFF); }
  write8(a, v) { this.cycleNoStop[this.cycleCount] = 0; this.cycleInternal[this.cycleCount] = 0; this.cycleAddr[this.cycleCount++] = a & 0xFFFF; this.bus.write(a & 0xFFFF, v & 0xFF); }
  // a cycle that presents address `a` without a transfer here (dummy reads, the read before CLR's write)
  addr(a) { this.cycleNoStop[this.cycleCount] = 0; this.cycleInternal[this.cycleCount] = 1; this.cycleAddr[this.cycleCount++] = a & 0xFFFF; }
  dpc(off = 0) { this.addr(this.pc + off); }                    // dummy read of the byte at PC
  // n cycles at $FFFF (no valid memory address); as one MAME dummy_vma(n), it can only stop after the last
  vma(n) { while (n-- > 0) { this.cycleNoStop[this.cycleCount] = n > 0 ? 1 : 0; this.cycleInternal[this.cycleCount] = 1; this.cycleAddr[this.cycleCount++] = 0xFFFF; } }
  // the last `k` cycles form one MAME statement; the most recent cycle has no MAME check point after it (k = 1)
  noStop(k = 1) { for (let i = this.cycleCount - k; i < this.cycleCount - (k > 1 ? 1 : 0); i++) this.cycleNoStop[i] = 1; }
  read16(a) { return (this.read8(a) << 8) | this.read8(a + 1); }
  write16(a, v) { this.write8(a, v >> 8); this.write8(a + 1, v); }
  fetch8() { this.cycleNoStop[this.cycleCount] = 0; this.cycleInternal[this.cycleCount] = 0; this.cycleAddr[this.cycleCount++] = this.pc; const v = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const h = this.fetch8(); return (h << 8) | this.fetch8(); }

  // Drop the internal (dummy) bus cycles of the current step: the last `k` of them, wherever they sit in the
  // log, are removed and the cycle count goes with them. A real access is never removed (the search skips
  // them), so what is left is still the true bus sequence: cycleCount always ends equal to c. The HD6309 in
  // native mode runs a 6809 instruction's trailing dummy cycles as part of its shorter instruction
  // [Atkinson, Indexed Addressing Mode Table p. 150: ',R+' 2/1, 'D,R' 4/2, 'mmnn,PC' 5/3, ...]; the
  // 6309-only instructions use it too. Removal is recorded in `cycleDrop` and applied by compact() at the
  // end of the step, so the order of the handler's logging does not matter.
  dropInternal(k) {
    if (k <= 0) return;
    const isInt = (i) => this.cycleInternal[i] && !this.cycleDrop[i];
    let i = this.cycleCount, left = k;
    while (left > 0) {
      i--;
      if (i < 0) throw new Error(`dropInternal(${k}): only ${k - left} internal cycles in the log`);
      if (isInt(i)) { this.cycleDrop[i] = 1; left--; }
    }
    this.droppedInternal += k;
  }
  // Fill the cycle log up to `c` with internal cycles: the instruction's internal execution time that is not
  // a memory access (MULD's 28 cycles are 4 bus cycles and 24 of these). They are logged at $FFFF, exactly
  // as the 6809's own internal cycles are (MUL: vma(9)).
  padInternal() {
    while (this.cycleCount < this.c) this.vma(1);
  }
  // compact the cycle log after drops: keep the cycles that were not dropped, in order
  compact() {
    let n = 0, dropped = 0;
    for (let i = 0; i < this.cycleCount; i++) {
      if (this.cycleDrop[i]) { dropped++; continue; }
      this.cycleAddr[n] = this.cycleAddr[i];
      this.cycleNoStop[n] = this.cycleNoStop[i];
      this.cycleInternal[n] = this.cycleInternal[i];
      n++;
    }
    this.cycleCount = n;
    this.cycleDrop.fill(0, 0, this.cycleCount + dropped);
    if (dropped !== this.droppedInternal) throw new Error(`compact: dropped ${dropped}, expected ${this.droppedInternal}`);
    this.c -= dropped;
  }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xFF; this.b = v & 0xFF; }

  pushS8(v) { this.s = (this.s - 1) & 0xFFFF; this.write8(this.s, v); }
  pushS16(v) { this.pushS8(v); this.pushS8(v >> 8); }
  pullS8() { const v = this.read8(this.s); this.s = (this.s + 1) & 0xFFFF; return v; }
  pullS16() { const h = this.pullS8(); return (h << 8) | this.pullS8(); }
  pushU8(v) { this.u = (this.u - 1) & 0xFFFF; this.write8(this.u, v); }
  pushU16(v) { this.pushU8(v); this.pushU8(v >> 8); }
  pullU8() { const v = this.read8(this.u); this.u = (this.u + 1) & 0xFFFF; return v; }
  pullU16() { const h = this.pullU8(); return (h << 8) | this.pullU8(); }

  pushAll() {
    this.pushS16(this.pc); this.pushS16(this.u); this.pushS16(this.y); this.pushS16(this.x);
    this.pushS8(this.dp); this.pushS8(this.b); this.pushS8(this.a); this.pushS8(this.cc);
  }

  // ---- addressing ----
  dir() { const ea = (this.dp << 8) | this.fetch8(); this.vma(1); return ea; }
  ext() { const ea = this.fetch16(); this.vma(1); return ea; }
  // the effective address for an indexed/direct/extended op, by its addressing mode (0 immediate is never
  // asked for: those paths fetch the operand). A method rather than a closure, so nothing is allocated per
  // instruction: this is the 6809's hot path.
  ea16(mode) { return mode === 1 ? this.dir() : mode === 2 ? this.indexed() : this.ext(); }

  getIdxReg(r) { return r === 0 ? this.x : r === 1 ? this.y : r === 2 ? this.u : this.s; }
  setIdxReg(r, v) {
    v &= 0xFFFF;
    if (r === 0) this.x = v; else if (r === 1) this.y = v; else if (r === 2) this.u = v; else this.s = v;
  }

  indexed() { return this.indexedPost(this.fetch8()); }
  // the indexed addressing modes, from an already-fetched post byte: the HD6309 adds post bytes of its
  // own (E,X / F,X / W,X / ,W / [,W] and friends), so the decode is a method the 6309 core overrides.
  indexedPost(pb) {
    const rc = (pb >> 5) & 3;
    const r = this.getIdxReg(rc);
    let ea;
    if (!(pb & 0x80)) {
      let off = pb & 0x1F; if (off & 0x10) off -= 32;
      this.c += 1; this.dpc(); this.vma(1);
      return (r + off) & 0xFFFF;
    }
    switch (pb & 0x0F) {
      case 0x0: ea = r; this.setIdxReg(rc, r + 1); this.c += 2; this.dpc(); this.vma(2); break;
      case 0x1: ea = r; this.setIdxReg(rc, r + 2); this.c += 3; this.dpc(); this.vma(3); break;
      case 0x2: ea = (r - 1) & 0xFFFF; this.setIdxReg(rc, ea); this.c += 2; this.dpc(); this.vma(2); break;
      case 0x3: ea = (r - 2) & 0xFFFF; this.setIdxReg(rc, ea); this.c += 3; this.dpc(); this.vma(3); break;
      case 0x4: ea = r; this.dpc(); break;
      case 0x5: ea = r + ((this.b ^ 0x80) - 0x80); this.c += 1; this.dpc(); this.vma(1); break;
      case 0x6: ea = r + ((this.a ^ 0x80) - 0x80); this.c += 1; this.dpc(); this.vma(1); break;
      case 0x8: { const o = this.fetch8(); ea = r + ((o ^ 0x80) - 0x80); this.c += 1; this.vma(1); break; }
      case 0x9: ea = r + this.fetch16(); this.c += 4; this.vma(3); break;
      case 0xB: ea = r + this.d; this.c += 4; this.dpc(); this.dpc(1); this.vma(3); break;
      case 0xC: { const o = this.fetch8(); ea = this.pc + ((o ^ 0x80) - 0x80); this.c += 1; this.vma(1); break; }
      case 0xD: { const o = this.fetch16(); ea = this.pc + o; this.c += 5; this.dpc(); this.vma(3); this.noStop(4); break; }
      case 0xF: ea = this.fetch16(); this.c += 2; this.vma(1); break;
      default: ea = r; this.dpc(); break; // undefined modes (our count keeps one cycle here; MAME has none)
    }
    ea &= 0xFFFF;
    if (pb & 0x10) { ea = this.read16(ea); this.c += 3; this.vma(1); }
    return ea;
  }

  // ---- flag helpers ----
  nz8(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x80 ? N : 0) | (r & 0xFF ? 0 : Z); }
  nz16(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x8000 ? N : 0) | (r & 0xFFFF ? 0 : Z); }
  ld8(r) { this.cc = (this.cc & ~(N | Z | V)) | (r & 0x80 ? N : 0) | (r ? 0 : Z); return r; }
  ld16(r) { this.cc = (this.cc & ~(N | Z | V)) | (r & 0x8000 ? N : 0) | (r ? 0 : Z); return r; }

  add8(a, b, cin) {
    const r = a + b + cin;
    this.cc = (this.cc & ~(H | N | Z | V | C)) |
      ((a ^ b ^ r) & 0x10 ? H : 0) | (r & 0x80 ? N : 0) | (r & 0xFF ? 0 : Z) |
      ((a ^ r) & (b ^ r) & 0x80 ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  sub8(a, b, cin) {
    const r = a - b - cin;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x80 ? N : 0) | (r & 0xFF ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x80 ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  add16(a, b) {
    const r = a + b;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x8000 ? N : 0) | (r & 0xFFFF ? 0 : Z) |
      ((a ^ r) & (b ^ r) & 0x8000 ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x8000 ? N : 0) | (r & 0xFFFF ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x8000 ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }

  // unary ops (NEG, COM, ...) by low nibble of opcode; returns result or -1 for no write
  unary(lo, v) {
    let r, cc = this.cc;
    switch (lo) {
      case 0x2: if (cc & C) { r = (~v) & 0xFF; this.cc = (cc & ~(N | Z | V)) | C; this.nz8(r); return r; }
      /* falls through */
      case 0x0: case 0x1:
        r = (-v) & 0xFF;
        this.cc = (cc & ~(N | Z | V | C)) | (v === 0x80 ? V : 0) | (v ? C : 0); this.nz8(r); return r;
      case 0x3: r = (~v) & 0xFF; this.cc = (cc & ~(N | Z | V)) | C; this.nz8(r); return r;
      case 0x4: case 0x5: r = v >> 1; this.cc = (cc & ~(N | Z | C)) | (v & 1 ? C : 0) | (r ? 0 : Z); return r;
      case 0x6: r = (v >> 1) | (cc & C ? 0x80 : 0); this.cc = (cc & ~C) | (v & 1 ? C : 0); this.nz8(r); return r;
      case 0x7: r = (v >> 1) | (v & 0x80); this.cc = (cc & ~C) | (v & 1 ? C : 0); this.nz8(r); return r;
      case 0x8: r = (v << 1) & 0xFF;
        this.cc = (cc & ~(V | C)) | (v & 0x80 ? C : 0) | ((v ^ (v << 1)) & 0x80 ? V : 0); this.nz8(r); return r;
      case 0x9: r = ((v << 1) | (cc & C)) & 0xFF;
        this.cc = (cc & ~(V | C)) | (v & 0x80 ? C : 0) | ((v ^ (v << 1)) & 0x80 ? V : 0); this.nz8(r); return r;
      case 0xA: case 0xB: r = (v - 1) & 0xFF; this.cc = (cc & ~V) | (v === 0x80 ? V : 0); this.nz8(r); return r;
      case 0xC: r = (v + 1) & 0xFF; this.cc = (cc & ~V) | (v === 0x7F ? V : 0); this.nz8(r); return r;
      case 0xD: this.cc = cc & ~V; this.nz8(v); return -1;
      case 0xF: case 0xE: this.cc = (cc & ~(N | V | C)) | Z; return 0;
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
      case 0xF: return !!(cc & Z) || (!(cc & N) !== !(cc & V));
    }
    return false;
  }

  getReg(code) {
    switch (code) {
      case 0x0: return this.d; case 0x1: return this.x; case 0x2: return this.y;
      case 0x3: return this.u; case 0x4: return this.s; case 0x5: return this.pc;
      case 0x8: return this.a; case 0x9: return this.b; case 0xA: return this.cc; case 0xB: return this.dp;
    }
    return 0xFFFF;
  }
  setReg(code, v) {
    switch (code) {
      case 0x0: this.d = v & 0xFFFF; break; case 0x1: this.x = v & 0xFFFF; break;
      case 0x2: this.y = v & 0xFFFF; break; case 0x3: this.u = v & 0xFFFF; break;
      case 0x4: this.s = v & 0xFFFF; break; case 0x5: this.pc = v & 0xFFFF; break;
      case 0x8: this.a = v & 0xFF; break; case 0x9: this.b = v & 0xFF; break;
      case 0xA: this.cc = v & 0xFF; break; case 0xB: this.dp = v & 0xFF; break;
    }
  }
  // value of a register converted for transfer to a register of another size
  xferVal(src, dstCode) {
    const v = this.getReg(src);
    const srcWide = src < 8, dstWide = dstCode < 8;
    if (srcWide && !dstWide) return v & 0xFF;
    if (!srcWide && dstWide) return 0xFF00 | v;
    return v;
  }

  // ---- interrupts ----
  checkInterrupts() {
    const fromCwai = this.cwai;
    // SYNC ends its wait with one more cycle (MAME base6x09.lst SYNC: the loop, then @eat(1)) which the
    // interrupt is then taken after. On the masked-release path just below that cycle is already charged;
    // when an interrupt is actually taken it has to be added here, or the entry comes out one cycle short.
    const fromSync = this.syncing;
    if (this.nmiPending && this.nmiArmed) {
      this.nmiPending = false;
      this.syncing = false;
      if (this.cwai) this.cwai = false; else { this.dpc(); this.dpc(); this.vma(1); this.cc |= E; this.pushAll(); }
      this.cc |= I | F;
      this.vma(1); this.pc = this.read16(0xFFFC); this.vma(1);
      return (fromCwai ? CWAI_ENTRY : 19) + (fromSync ? 1 : 0);
    }
    if (this.firqLine && !(this.cc & F)) {
      this.syncing = false;
      if (this.cwai) this.cwai = false;
      else { this.dpc(); this.dpc(); this.vma(1); this.cc &= ~E; this.pushS16(this.pc); this.pushS8(this.cc); }
      this.cc |= F | I;
      this.vma(1); this.pc = this.read16(0xFFF6); this.vma(1);
      return (fromCwai ? CWAI_ENTRY : 10) + (fromSync ? 1 : 0);
    }
    if (this.irqLine && !(this.cc & I)) {
      this.syncing = false;
      if (this.cwai) this.cwai = false; else { this.dpc(); this.dpc(); this.vma(1); this.cc |= E; this.pushAll(); }
      this.cc |= I;
      this.vma(1); this.pc = this.read16(0xFFF8); this.vma(1);
      return (fromCwai ? CWAI_ENTRY : 19) + (fromSync ? 1 : 0);
    }
    return 0;
  }

  // will the next step() execute the instruction at pc (rather than halt, wait, or take an interrupt)?
  // The machine runs PC hooks only then, so an interrupt arriving at a hooked address doesn't run the
  // hook twice (once now, once after the RTI).
  willExecute() {
    if (this.haltLine || this.haltTail || this.cwai || this.syncing) return false;
    return !((this.nmiPending && this.nmiArmed) || (this.firqLine && !(this.cc & F)) || (this.irqLine && !(this.cc & I)));
  }
  step() {
    this.cycleCount = 0;
    this.droppedInternal = 0;
    if (this.haltLine || this.haltTail) {                                   // halted: no instruction, no interrupt
      if (!this.haltLine) this.haltTail--;
      this.vma(1); this.totalCycles += 1; return 1;
    }
    if (this.nmiPending || this.firqLine || this.irqLine) {
      const ic = this.checkInterrupts();
      if (ic) { this.totalCycles += ic; return ic; }
      if (this.syncing) { this.syncing = false; this.vma(1); this.totalCycles += 1; return 1; } // masked interrupt releases SYNC
    }
    if (this.cwai || this.syncing) { this.vma(1); this.totalCycles += 1; return 1; }
    if (this.trace) this.trace(this);
    this.c = 0;
    this.opPc = this.pc;          // where the instruction being executed starts (MAME's pcbase())
    this.exec(this.fetch8());
    this.postInstruction();       // the CPU's own adjustment to the step (the 6309's native-mode timing)
    this.totalCycles += this.c;
    return this.c;
  }
  // called once per executed instruction, after its handler: the 6809 has nothing to add
  postInstruction() {}
  // an undefined page-1 opcode: a 6809 runs it as a 2-cycle NOP (opcode, then a dummy read at PC). The
  // HD6309 traps instead, so its core overrides this.
  undefinedOp() { this.c = 2; this.dpc(); }
  // an undefined opcode after a 0x10/0x11 prefix: the two fetches are already logged, so a 6809 charges
  // 2 cycles and logs nothing more. The HD6309 traps.
  undefinedPrefixed() { this.c = 2; }

  // 8-bit accumulator ALU op by low nibble (0x80..0xFF rows)
  alu8(lo, acc, m) {
    switch (lo) {
      case 0x0: return this.sub8(acc, m, 0);
      case 0x1: this.sub8(acc, m, 0); return acc;
      case 0x2: return this.sub8(acc, m, this.cc & C);
      case 0x4: return this.ld8(acc & m);
      case 0x5: this.ld8(acc & m); return acc;
      case 0x6: return this.ld8(m);
      case 0x8: return this.ld8(acc ^ m);
      case 0x9: return this.add8(acc, m, this.cc & C);
      case 0xA: return this.ld8(acc | m);
      case 0xB: return this.add8(acc, m, 0);
    }
    return acc;
  }

  exec(op) {
    // ---- read-modify-write memory ops: 0x00-0x0F, 0x60-0x7F ----
    if (op < 0x10 || (op >= 0x60 && op < 0x80)) {
      let ea;
      if (op < 0x10) { this.c = 6; ea = this.dir(); }
      else if (op < 0x70) { this.c = 6; ea = this.indexed(); }
      else { this.c = 7; ea = this.ext(); }
      const lo = op & 0x0F;
      if (lo === 0x0E) { this.pc = ea; this.c -= 3; return; } // JMP
      if (lo === 0x0D) { this.unary(0xD, this.read8(ea)); this.vma(2); return; } // TST
      // CLR reads its operand before writing 0 (MC6809 data sheet, cycle-by-cycle: read, VMA, write; MAME CLR8
      // @read_operand), so it clears a PIA's flags like any other read of the data register
      if (lo === 0x0F) { this.read8(ea); this.vma(1); this.write8(ea, this.unary(0xF, 0)); return; }
      const r = this.unary(lo, this.read8(ea));
      this.vma(1);
      if (r >= 0) this.write8(ea, r); else this.addr(ea);
      return;
    }
    if (op >= 0x40 && op < 0x60) {
      this.c = 2;
      const lo = op & 0x0F;
      this.dpc();
      if (op < 0x50) { const r = this.unary(lo, this.a); if (r >= 0) this.a = r; }
      else { const r = this.unary(lo, this.b); if (r >= 0) this.b = r; }
      return;
    }
    if (op >= 0x20 && op < 0x30) { // short branches
      this.c = 3;
      const o = this.fetch8();
      this.vma(1);
      if (this.cond(op & 0xF)) this.pc = (this.pc + ((o ^ 0x80) - 0x80)) & 0xFFFF;
      return;
    }
    if (op >= 0x80) { this.execHigh(op); return; }

    switch (op) {
      case 0x10: this.execPage2(this.fetch8()); return;
      case 0x11: this.execPage3(this.fetch8()); return;
      case 0x12: this.c = 2; this.dpc(); return; // NOP
      case 0x13: // SYNC: opcode, a dummy read at PC, then $FFFF cycles until an interrupt line is asserted
        // (Motorola MC6809 data sheet, instruction table: SYNC ">= 4" cycles; with an interrupt already
        // pending this core takes 4 + 1 to release = 5). MAME's m6809 (src/devices/cpu/m6809/base6x09.lst,
        // SYNC) waits right after the dummy read, so it takes 2 + 1 = 3; mameCompat reproduces that.
        // tests/cpu.test.js checks both paths, pending and waiting.
        if (this.mameCompat) { this.c = 2; this.dpc(); } else { this.c = 4; this.dpc(); this.vma(2); }
        this.syncing = true; return;
      case 0x16: { this.c = 5; const o = this.fetch16(); this.vma(1); this.vma(1); this.pc = (this.pc + o) & 0xFFFF; return; } // LBRA
      case 0x17: { this.c = 9; const o = this.fetch16(); this.vma(4); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xFFFF; return; } // LBSR
      case 0x19: { // DAA
        this.c = 2; this.dpc();
        const a = this.a, lsn = a & 0x0F, msn = a & 0xF0;
        let cf = 0;
        if ((this.cc & H) || lsn > 9) cf |= 0x06;
        if ((this.cc & C) || msn > 0x90 || (msn > 0x80 && lsn > 9)) cf |= 0x60;
        const r = a + cf;
        this.a = r & 0xFF;
        this.cc = (this.cc & ~(N | Z | V)) | (r & 0x100 ? C : 0);
        this.nz8(this.a);
        return;
      }
      case 0x1A: this.c = 3; this.cc |= this.fetch8(); this.noStop(); this.dpc(); return; // ORCC
      case 0x1C: this.c = 3; this.cc &= this.fetch8(); this.noStop(); this.dpc(); return; // ANDCC
      case 0x1D: this.c = 2; this.dpc(); this.a = this.b & 0x80 ? 0xFF : 0; this.nz16(this.d); return; // SEX
      case 0x1E: { // EXG
        this.c = 8;
        const pb = this.fetch8(), r1 = pb >> 4, r2 = pb & 0xF;
        this.noStop();
        this.vma(6);
        const v1 = this.xferVal(r1, r2), v2 = this.xferVal(r2, r1);
        this.setReg(r2, v1); this.setReg(r1, v2);
        return;
      }
      case 0x1F: { // TFR
        this.c = 6;
        const pb = this.fetch8(), r1 = pb >> 4, r2 = pb & 0xF;
        this.noStop();
        this.vma(4);
        this.setReg(r2, this.xferVal(r1, r2));
        if (r2 === 4) this.nmiArmed = true;   // TFR r,S arms NMI; EXG with S does not (MAME m6809.lst TFR, EXG)
        return;
      }
      case 0x30: this.c = 4; this.x = this.indexed(); this.vma(1); this.cc = (this.cc & ~Z) | (this.x ? 0 : Z); return;
      case 0x31: this.c = 4; this.y = this.indexed(); this.vma(1); this.cc = (this.cc & ~Z) | (this.y ? 0 : Z); return;
      case 0x32: this.c = 4; this.s = this.indexed(); this.vma(1); this.nmiArmed = true; return;
      case 0x33: this.c = 4; this.u = this.indexed(); this.vma(1); return;
      case 0x34: { // PSHS
        this.c = 5; const pb = this.fetch8();
        this.vma(2); this.addr(this.s);
        if (pb & 0x80) { this.pushS16(this.pc); this.c += 2; }
        if (pb & 0x40) { this.pushS16(this.u); this.c += 2; }
        if (pb & 0x20) { this.pushS16(this.y); this.c += 2; }
        if (pb & 0x10) { this.pushS16(this.x); this.c += 2; }
        if (pb & 0x08) { this.pushS8(this.dp); this.c += 1; }
        if (pb & 0x04) { this.pushS8(this.b); this.c += 1; }
        if (pb & 0x02) { this.pushS8(this.a); this.c += 1; }
        if (pb & 0x01) { this.pushS8(this.cc); this.c += 1; }
        return;
      }
      case 0x35: { // PULS
        this.c = 5; const pb = this.fetch8();
        this.vma(2);
        if (pb & 0x01) { this.cc = this.pullS8(); this.c += 1; }
        if (pb & 0x02) { this.a = this.pullS8(); this.c += 1; }
        if (pb & 0x04) { this.b = this.pullS8(); this.c += 1; }
        if (pb & 0x08) { this.dp = this.pullS8(); this.c += 1; }
        if (pb & 0x10) { this.x = this.pullS16(); this.c += 2; }
        if (pb & 0x20) { this.y = this.pullS16(); this.c += 2; }
        if (pb & 0x40) { this.u = this.pullS16(); this.c += 2; }
        if (pb & 0x80) { this.pc = this.pullS16(); this.c += 2; }
        this.addr(this.s);
        return;
      }
      case 0x36: { // PSHU
        this.c = 5; const pb = this.fetch8();
        this.vma(2); this.addr(this.u);
        if (pb & 0x80) { this.pushU16(this.pc); this.c += 2; }
        if (pb & 0x40) { this.pushU16(this.s); this.c += 2; }
        if (pb & 0x20) { this.pushU16(this.y); this.c += 2; }
        if (pb & 0x10) { this.pushU16(this.x); this.c += 2; }
        if (pb & 0x08) { this.pushU8(this.dp); this.c += 1; }
        if (pb & 0x04) { this.pushU8(this.b); this.c += 1; }
        if (pb & 0x02) { this.pushU8(this.a); this.c += 1; }
        if (pb & 0x01) { this.pushU8(this.cc); this.c += 1; }
        return;
      }
      case 0x37: { // PULU
        this.c = 5; const pb = this.fetch8();
        this.vma(2);
        if (pb & 0x01) { this.cc = this.pullU8(); this.c += 1; }
        if (pb & 0x02) { this.a = this.pullU8(); this.c += 1; }
        if (pb & 0x04) { this.b = this.pullU8(); this.c += 1; }
        if (pb & 0x08) { this.dp = this.pullU8(); this.c += 1; }
        if (pb & 0x10) { this.x = this.pullU16(); this.c += 2; }
        if (pb & 0x20) { this.y = this.pullU16(); this.c += 2; }
        if (pb & 0x40) { this.s = this.pullU16(); this.c += 2; }
        if (pb & 0x80) { this.pc = this.pullU16(); this.c += 2; }
        this.addr(this.u);
        return;
      }
      case 0x39: this.c = 5; this.dpc(); this.pc = this.pullS16(); this.vma(1); return; // RTS
      case 0x3A: this.c = 3; this.dpc(); this.vma(1); this.x = (this.x + this.b) & 0xFFFF; return; // ABX
      case 0x3B: // RTI
        this.c = 6;
        this.dpc();
        this.cc = this.pullS8();
        if (this.cc & E) {
          this.c = 15;
          this.a = this.pullS8(); this.b = this.pullS8(); this.dp = this.pullS8();
          this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
        }
        this.pc = this.pullS16();
        this.addr(this.s);
        return;
      case 0x3C: // CWAI
        // opcode, mask, a dummy read, a dead cycle and 12 pushes; then it waits, checking for an interrupt from
        // the next cycle on (MAME base6x09.lst CWAI)
        this.c = 16;
        this.cc &= this.fetch8();
        this.dpc(); this.vma(1);
        this.cc |= E; this.pushAll(); this.cwai = true;
        return;
      case 0x3D: { // MUL
        this.c = 11;
        this.dpc(); this.vma(9);
        const r = this.a * this.b;
        this.d = r;
        this.cc = (this.cc & ~(Z | C)) | (r ? 0 : Z) | (r & 0x80 ? C : 0);
        return;
      }
      case 0x3F: // SWI
        this.c = 19;
        this.dpc(); this.vma(1);
        this.cc |= E; this.pushAll(); this.cc |= I | F;
        this.vma(1); this.pc = this.read16(0xFFFA); this.vma(1);
        return;
      default: this.undefinedOp(); // undefined: a 6809 NOP, a 6309 trap
    }
  }

  execHigh(op) {
    const mode = (op >> 4) & 3; // 0 imm, 1 dir, 2 idx, 3 ext
    const lo = op & 0x0F;
    const isB = op >= 0xC0;

    // 16-bit / control ops
    if (lo === 0x3 || lo >= 0xC) {
      if (!isB) {
        if (lo === 0x3) { // SUBD
          this.c = CYCLES.page2[mode];
          const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode));
          this.vma(1);
          this.d = this.sub16(this.d, m); return;
        }
        if (lo === 0xC) { // CMPX
          this.c = CYCLES.page2[mode];
          const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode));
          this.vma(1);
          this.sub16(this.x, m); return;
        }
        if (lo === 0xD) { // BSR / JSR
          if (mode === 0) {
            this.c = 7; const o = this.fetch8();
            this.vma(3);
            this.pushS16(this.pc); this.pc = (this.pc + ((o ^ 0x80) - 0x80)) & 0xFFFF; return;
          }
          this.c = CYCLES.jsr[mode];
          const ea = this.ea16(mode); this.addr(ea); this.vma(1); this.pushS16(this.pc); this.pc = ea; return;
        }
        if (lo === 0xE) { // LDX
          this.c = CYCLES.load16[mode];
          this.x = this.ld16(mode === 0 ? this.fetch16() : this.read16(this.ea16(mode))); return;
        }
        // STX
        this.c = CYCLES.load16[mode];
        if (mode === 0) { this.fetch8(); this.dpc(); return; }
        { const ea = this.ea16(mode); this.write16(ea, this.ld16(this.x)); }
        return;
      } else {
        if (lo === 0x3) { // ADDD
          this.c = CYCLES.page2[mode];
          const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode));
          this.vma(1);
          this.d = this.add16(this.d, m); return;
        }
        if (lo === 0xC) { // LDD
          this.c = CYCLES.load16[mode];
          this.d = this.ld16(mode === 0 ? this.fetch16() : this.read16(this.ea16(mode))); return;
        }
        if (lo === 0xD) { // STD
          this.c = CYCLES.load16[mode];
          if (mode === 0) { this.fetch8(); this.dpc(); return; }
          { const ea = this.ea16(mode); this.write16(ea, this.ld16(this.d)); }
          return;
        }
        if (lo === 0xE) { // LDU
          this.c = CYCLES.load16[mode];
          this.u = this.ld16(mode === 0 ? this.fetch16() : this.read16(this.ea16(mode))); return;
        }
        // STU
        this.c = CYCLES.load16[mode];
        if (mode === 0) { this.fetch8(); this.dpc(); return; }
        { const ea = this.ea16(mode); this.write16(ea, this.ld16(this.u)); }
        return;
      }
    }

    this.c = CYCLES.alu8[mode];
    if (lo === 0x7) { // STA / STB
      if (mode === 0) { this.fetch8(); return; }
      const ea = this.ea16(mode);
      const v = isB ? this.b : this.a;
      this.write8(ea, this.ld8(v));
      this.noStop();
      return;
    }
    const m = mode === 0 ? this.fetch8() : this.read8(this.ea16(mode));
    this.noStop();
    if (isB) this.b = this.alu8(lo, this.b, m);
    else this.a = this.alu8(lo, this.a, m);
  }

  execPage2(op) {
    if (op >= 0x20 && op < 0x30) { // long branches
      this.c = 5;
      const o = this.fetch16();
      this.vma(1);
      if (this.cond(op & 0xF)) { this.pc = (this.pc + o) & 0xFFFF; this.c = 6; this.vma(1); }
      return;
    }
    if (op === 0x3F) { // SWI2
      this.c = 20; this.dpc(); this.vma(1); this.cc |= E; this.pushAll(); this.vma(1); this.pc = this.read16(0xFFF4); this.vma(1); return;
    }
    if (op < 0x80) { this.undefinedPrefixed(); return; }
    const mode = (op >> 4) & 3, lo = op & 0x0F, isB = op >= 0xC0;
    if (!isB) {
      if (lo === 0x3) { this.c = CYCLES.cmpd[mode]; const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode)); this.vma(1); this.sub16(this.d, m); return; } // CMPD
      if (lo === 0xC) { this.c = CYCLES.cmpd[mode]; const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode)); this.vma(1); this.sub16(this.y, m); return; } // CMPY
      if (lo === 0xE) { this.c = CYCLES.page2[mode]; this.y = this.ld16(mode === 0 ? this.fetch16() : this.read16(this.ea16(mode))); return; } // LDY
      if (lo === 0xF && mode) { this.c = CYCLES.page2[mode]; const ea = this.ea16(mode); this.write16(ea, this.ld16(this.y)); return; } // STY
    } else {
      if (lo === 0xE) { this.c = CYCLES.page2[mode]; this.s = this.ld16(mode === 0 ? this.fetch16() : this.read16(this.ea16(mode))); this.nmiArmed = true; return; } // LDS
      if (lo === 0xF && mode) { this.c = CYCLES.page2[mode]; const ea = this.ea16(mode); this.write16(ea, this.ld16(this.s)); return; } // STS
    }
    this.undefinedPrefixed();
  }

  execPage3(op) {
    if (op === 0x3F) { // SWI3
      this.c = 20; this.dpc(); this.vma(1); this.cc |= E; this.pushAll(); this.vma(1); this.pc = this.read16(0xFFF2); this.vma(1); return;
    }
    if (op >= 0x80 && op < 0xC0) {
      const mode = (op >> 4) & 3, lo = op & 0x0F;
      if (lo === 0x3 || lo === 0xC) {
        this.c = CYCLES.cmpd[mode];
        const m = mode === 0 ? this.fetch16() : this.read16(this.ea16(mode));
        this.vma(1);
        this.sub16(lo === 0x3 ? this.u : this.s, m); // CMPU / CMPS
        return;
      }
    }
    this.undefinedPrefixed();
  }
}

CPU6809.FLAGS = { E, F, H, I, N, Z, V, C };
CPU6809.STATE = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc', 'irqLine', 'firqLine', 'haltLine', 'haltTail', 'nmiPending', 'nmiArmed', 'cwai', 'syncing', 'c', 'totalCycles'];

export { CPU6809 };
