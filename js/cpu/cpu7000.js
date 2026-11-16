/*
 * CPU7000: the TMS7000 / TMS7040 CPU core. Chip only: it knows nothing about the
 * Speech/Sound Pak, cartridges or any machine; it talks through a bus and an optional peripheral hook.
 *
 * Source of truth: the TMS7000 Family Data Manual (TI, SPND001B, 1986).
 *   Section 3.1   the registers: R0 is A and R1 is B (3.1.1), the peripheral file is >0100->01FF (3.1.2),
 *                 the stack lives in the register file with an 8-bit SP loaded with >01 at reset (3.1.3),
 *                 and the status register is C=7, N=6, Z=5, I=4 (3.1.4; §9.4 says the same).
 *   Section 3.6   interrupts: five maskable levels, vectors descending from >FFFC (Table 3-12), and a
 *                 19-cycle sequence (17 out of IDLE) that pushes ST, PCH, PCL and clears ST.
 *   Section 6.2   the addressing modes; 6.2.5 defines a jump offset as ta - pcn.
 *   Appendix A    the cycle phase tables: the per-instruction counts, and the reset and interrupt sequences.
 * js/asm/isa7000.js holds the opcode table (opcode, length, cycles, status column) transcribed from
 * Table 6-3 and cross-checked against Appendix E/F; this core reads it, so the assembler and the CPU
 * cannot disagree about what a byte means.
 *
 * bus: { read(addr) -> byte, write(addr, byte) }. The register file is memory, so it goes through the bus
 *   exactly as the hardware does. The core keeps no shadow copy of A or B: they are R0 and R1, and a
 *   machine (or a test) that writes the register file sees the accumulators change, which is what the
 *   Speech/Sound Pak needs.
 * peripheral(addr, value, isWrite) -> byte | undefined: an optional hook for the peripheral file
 *   (>0100->01FF). Returning a value on a read serves it; returning undefined on a write lets it fall
 *   through to the bus. A machine hangs the timer, ports and serial registers off this.
 *
 * step() executes one instruction (or services an interrupt first, if one is pending and enabled) and
 *   returns the cycles it took. `c` holds the current instruction's count while it runs and
 *   `totalCycles` counts every cycle since construction, as CPU6803/CPU6809 do. trace(cpu) is called
 *   before each instruction.
 *
 * saveState() / loadState() carry the CPU registers only: the register file is memory and is saved by
 *   whatever owns the bus, so it is not duplicated here (same convention as CPU6803's on-chip RAM being
 *   a view into the machine's memory).
 */
import { state } from '../util.js';
import { OPS_BY_OPCODE } from '../asm/isa7000.js';

// ---- the status register (Figure 3-3, §9.4) ----
const C = 0x80, N = 0x40, Z = 0x20, I = 0x10;
const SR_MASK = 0xF0;   // bits 3-0 are reserved and read as zero; RETI/POP ST restore only these four

// ---- IOCNT0, the I/O control register (Section 3.6.3, Figure 3-16, page 3-30) ----
// P0 at >0100 on a TMS7040 (Table 3-8). Figure 3-16 puts each maskable level in a flag/enable pair:
//   bit 0 INT1 enable   bit 1 INT1 flag (write 1 to clear)
//   bit 2 INT2 enable   bit 3 INT2 flag (write 1 to clear)
//   bit 4 INT3 enable   bit 5 INT3 flag (write 1 to clear)
//   bits 6-7 memory mode (not modelled: this core has one memory map)
// The TMS7040 has no INT4/INT5, so it has no IOCNT1 (Table 3-12's note, Table 3-14 on page 3-30).
const ENABLE_BIT = [0x01, 0x04, 0x10];   // INT1, INT2, INT3
const FLAG_BIT = [0x02, 0x08, 0x20];
const ENABLE_MASK = 0x15;
const FLAG_MASK = 0x2A;
const MODE_MASK = 0xC0;

// The four general-purpose ports' data registers and DDRs (Table 3-8), as offsets into PORT_INDEX. A
// positive entry is a data register (an index into portLatch/portDdr); a negative one is its DDR.
//   P4 >0104 port A, P5 >0105 port A DDR; P6 port B, P7 DDR; P8 port C, P9 DDR; P10 port D, P11 DDR.
const PORT_INDEX = { 0x0104: 0, 0x0105: -1, 0x0106: 1, 0x0107: -2, 0x0108: 2, 0x0109: -3, 0x010A: 3, 0x010B: -4 };
const PORT_NAMES = ['A', 'B', 'C', 'D'];

class CPU7000 {
  constructor(bus = null) {
    this.bus = bus;
    this.peripheral = null;
    // portIn(port) -> the pin levels the outside world drives, for ports 'A'..'D'. A port line reads as an
    // input unless its DDR bit is set (§3.2, and MAME's tms7000_pf_r: "(in & ~ddr) | (latch & ddr)").
    this.portIn = null;
    // portOut(port, value, isData) -> void: called after a port or DDR write, so a device wired to the lines
    // can react (MAME's in_porta/out_porta callbacks). `isData` is false for a DDR write.
    this.portOut = null;
    this.portLatch = new Uint8Array(4);   // A..D data, as last written
    this.portDdr = new Uint8Array(4);     // A..D data-direction, 1 = output
    this.sp = 0x01;
    this.st = 0;
    this.pc = 0;
    this.c = 0;
    this.totalCycles = 0;
    this.trace = null;
    this.irqPending = [false, false, false, false, false];   // INT1..INT5, Table 3-12
    this.iocnt0 = 0;                                    // IOCNT0, Figure 3-16 (flags and enables)
    this.idle = false;
    this.reset();
  }

  // ---- memory ----
  // The hook is offered only the peripheral file itself (>0100->01FF, §3.1.2). Everything else, vectors
  // and code included, is the bus's, so a machine's reset and instruction fetches never touch a port.
  //
  // The four general-purpose ports are part of the chip, not the board: their data registers (P4, P6, P8,
  // P10) and DDRs (P5, P7, P9, P11, Table 3-8) belong to the core, and a port reads its input pins wherever
  // its DDR bit is clear (MAME's tms7000_pf_r). The board only supplies the pin levels, through portIn.
  read8(addr) {
    addr &= 0xFFFF;
    if (addr === 0x0100) return this.iocnt0;   // IOCNT0 is the chip's own (Figure 3-16)
    const port = PORT_INDEX[addr];
    if (port !== undefined) {
      if (port < 0) return this.portDdr[-port - 1];
      return ((this.portIn ? this.portIn(PORT_NAMES[port]) : 0x00) & ~this.portDdr[port]) | (this.portLatch[port] & this.portDdr[port]);
    }
    if (this.peripheral && addr >= 0x0100 && addr <= 0x01FF) {
      const v = this.peripheral(addr, 0, false);
      if (v !== undefined && v !== null) return v & 0xFF;
    }
    return this.bus ? this.bus.read(addr) & 0xFF : 0;
  }
  write8(addr, v) {
    addr &= 0xFFFF; v &= 0xFF;
    if (addr === 0x0100) { this.writeIocnt0(v); return; }   // IOCNT0: enables read/write, flags clear on 1
    const port = PORT_INDEX[addr];
    if (port !== undefined) {
      // A DDR write stores the direction only. It is NOT a port write: MAME's tms7000_pf_w separates the two
      // cases and comments on the direction one "changing port direction does not change(refresh) the output
      // pins", so the board's port_out callback is not called. Reporting it would let a DDR write drive the
      // lines, which is how a firmware's DDR setup was clearing the Speech/Sound Pak's busy flag.
      if (port < 0) { this.portDdr[-port - 1] = v; return; }
      this.portLatch[port] = v;
      // A data write drives the pins that are configured as outputs, and only those: MAME calls
      // m_port_out_cb[port](data & m_port_ddr[port]) (tms7000_pf_w, the "port data" case), so a line whose DDR
      // bit is clear stays an input and is not driven.
      if (this.portOut) this.portOut(PORT_NAMES[port], v & this.portDdr[port], true);
      return;
    }
    if (this.peripheral && addr >= 0x0100 && addr <= 0x01FF) {
      if (this.peripheral(addr, v, true) !== undefined) return;
    }
    if (this.bus) this.bus.write(addr, v);
  }
  fetch8() { const v = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const hi = this.fetch8(); return (hi << 8) | this.fetch8(); }

  // A and B are R0 and R1 (3.1.1): they live in the register file, not the peripheral file
  get a() { return this.bus ? this.bus.read(0) & 0xFF : 0; }
  get b() { return this.bus ? this.bus.read(1) & 0xFF : 0; }

  // ---- status ----
  get carry() { return (this.st & C) !== 0; }
  set carry(v) { this.st = v ? (this.st | C) : (this.st & ~C); }
  get intEnable() { return (this.st & I) !== 0; }
  set intEnable(v) { this.st = v ? (this.st | I) : (this.st & ~I); }
  // N and Z from a result byte (3.1.4)
  setNZ(v) {
    const b = v & 0xFF;
    this.st = (this.st & ~(N | Z)) | (b & 0x80 ? N : 0) | (b === 0 ? Z : 0);
  }
  // The "R R R" status column: N and Z on the result, C from a subtraction's borrow or an addition's carry.
  setCNZ(carry, v) { this.st = (this.st & ~C) | (carry ? C : 0); this.setNZ(v); }

  reset() {
    this.st = 0;
    this.sp = 0x01;
    this.idle = false;
    this.irqPending = [false, false, false, false, false];
    // §3.6.1 step 2 and §3.6.3's closing paragraph: "All Os are written to the IOCNT0 register. This disables
    // INT1, INT2, and INT3 and leaves the INTn flag bits unchanged" - the enables and memory-mode bits clear,
    // the flags keep whatever they had. A reset that does not restore from a snapshot therefore starts from
    // flags clear too, since the constructor initialises the field.
    this.iocnt0 = (this.iocnt0 || 0) & FLAG_MASK;
    // The DDRs clear at reset, with port B's fixed at $FF (MAME's device_start: "memset(m_port_ddr, 0, 4);
    // m_port_ddr[1] = 0xff"). §3.6.1 puts it the other way for the pins; MAME's is what the hardware does
    // and what the SSC's firmware relies on.
    this.portLatch.fill(0);
    this.portDdr.fill(0);
    this.portDdr[1] = 0xFF;
    // The vector comes from the bus, never the peripheral hook: the hook is offered only the peripheral
    // file, and reading ROM through it would let a port answer for an address it does not own.
    const hi = this.bus ? this.bus.read(0xFFFE) & 0xFF : 0;
    const lo = this.bus ? this.bus.read(0xFFFF) & 0xFF : 0;
    this.pc = (hi << 8) | lo;
  }
  // start at an address (leaves IDLE)
  jump(addr) { this.pc = addr & 0xFFFF; this.idle = false; }
  // An interrupt request from a device: level 1..3 -> INT1..INT3, the maskable levels a TMS7040 has (Table
  // 3-12's note: INT4/INT5 "apply to TMS70x2 and TMS70Cx2 devices only", and Table 3-14 gives IOCNT1 to those
  // parts alone). `on` drives the input pin. The pin's active edge sets the level's flag bit in IOCNT0 and
  // leaves it latched there (Section 3.6.3 and page 3-32: INTn going active latches a 1 that "stays latched
  // when the signal goes inactive"); dropping the pin does NOT drop the flag. The flag is cleared only by
  // writing a 1 to its clear bit or by the CPU acknowledging the interrupt (page 3-29).
  interrupt(level, on = true) {
    if (level < 1 || level > 3) return;
    this.irqPending[level - 1] = on;
    if (on) this.iocnt0 |= FLAG_BIT[level - 1];
  }
  // Does IOCNT0 currently let this level be recognised? §3.6.3's first condition - "A 1 must be written to the
  // INTn enable bit" - plus a set flag, which is what the input's active edge latched. The global I bit is
  // checked by step() before it asks.
  irqEnabled(level) {
    return (this.irqPending[level - 1] || (this.iocnt0 & FLAG_BIT[level - 1]) !== 0)
      && (this.iocnt0 & ENABLE_BIT[level - 1]) !== 0;
  }
  // Writes to IOCNT0 (P0, >0100) are the chip's, not the board's, so the core owns the register. Figure 3-16:
  // the enable bits (0, 2, 4) are read/write, the memory-mode bits (6-7) are read/write, and the flag bits
  // (1, 3, 5) clear on a written 1 and are untouched by a written 0 (page 3-32: "When a 1 is written to the
  // INTn clear bit, the Pulse flip-flop is cleared. Writing a 0 to the INTn clear bit has no effect").
  writeIocnt0(v) {
    const flags = this.iocnt0 & FLAG_MASK;
    this.iocnt0 = (v & (ENABLE_MASK | MODE_MASK)) | (flags & ~v);
  }

  fetchVector(addr) { return (this.read8(addr) << 8) | this.read8(addr + 1); }

  // ---- the stack: SP points at the top entry; PUSH increments then stores, POP moves then decrements ----
  // (§3.1.3, and the PUSH/POP pages 6-50/6-51; Appendix A Table A-14's phases say the same.)
  push(v) { this.sp = (this.sp + 1) & 0xFF; this.write8(this.sp, v); }
  pop() { const v = this.read8(this.sp); this.sp = (this.sp - 1) & 0xFF; return v; }

  // ---- executing ----
  step() {
    if (this.trace) this.trace(this);
    this.c = 0;
    let cycles;
    if (this.intEnable) {
      // Three conditions must hold (Section 3.6.3, page 3-31): the level's IOCNT0 enable bit is set, the
      // global I bit is set, and it is the highest-priority level asserting. A TMS7040 has INT1-INT3 only.
      for (let lvl = 1; lvl <= 3; lvl++) {
        if (this.irqEnabled(lvl)) {
          this.irqPending[lvl - 1] = false;
          this.iocnt0 &= ~FLAG_BIT[lvl - 1];      // the ACK line clears the flag (page 3-29)
          cycles = this.takeInterrupt(lvl); this.totalCycles += cycles; return cycles;
        }
      }
    }
    if (this.idle) { this.c = 1; this.totalCycles += this.c; return this.c; }
    const at = this.pc;
    const opcode = this.fetch8();
    const entry = OPS_BY_OPCODE.get(opcode);
    if (!entry) { this.c = 5; this.totalCycles += this.c; return this.c; }   // illegal: 5 cycles, no effect
    this.dispatch(entry, entry.modes[0], at);
    this.totalCycles += this.c;
    return this.c;
  }

  // Section 3.6.2 and page 6-29: push ST, then PCH, then PCL, then clear the status register and load the
  // PC from the vector. Table A-3 counts 19 cycles; 17 when the interrupt ends an IDLE (Section 3.6.2),
  // and in that case the pushed PC is the instruction after IDLE (Table A-3's note: "do not decrement PC").
  takeInterrupt(level) {
    const fromIdle = this.idle;
    const pushPc = fromIdle ? (this.pc + 1) & 0xFFFF : this.pc;
    this.push(this.st);
    this.push(pushPc >> 8);
    this.push(pushPc & 0xFF);
    this.st = 0;
    this.pc = this.fetchVector(0xFFFC - (level - 1) * 2);   // Table 3-12: INT1 >FFFC, INT2 >FFFA, ...
    this.idle = false;
    return fromIdle ? 17 : 19;
  }

  // ---- operand helpers, one per form in js/asm/isa7000.js ----
  // A register-file address. The register file is the low 128 (TMS7040) or 256 bytes of memory, so the
  // operand byte is the address, masked to what the part has.
  regAddr(n) { return n & 0xFF; }
  // A register pair's address: the operand names the LSB, the MSB is the register before it (§6.2.7,
  // and the "Rp should be greater than 0" note on page 6-44).
  readPair(n) { const a = this.regAddr(n); return (this.read8((a - 1) & 0xFF) << 8) | this.read8(a); }
  writePair(n, v) { const a = this.regAddr(n); this.write8((a - 1) & 0xFF, (v >> 8) & 0xFF); this.write8(a, v & 0xFF); }
  // The effective address of an extended operand, from its mode (§6.2.6-6.2.8).
  extAddr(form) {
    if (form === 'direct') return this.fetch16();
    if (form === 'indirect') return this.readPair(this.fetch8());
    if (form === 'indexed') return (this.fetch16() + this.read8(1)) & 0xFFFF;
    throw new Error(`not an extended form: ${form}`);
  }

  // ---- the operations ----
  // Each returns the value to store, or null for "nothing is written" (CMP, BTJO, BR, ...), and sets the
  // status bits itself. The addressing is done by the caller, which is what lets one operation serve all
  // of its modes: Table A-5's addressing phases are the same for every dual-operand instruction.

  // dual-operand: (s) OP (d) -> (d), where s and d are read before the write
  dual(entry, mode) {
    const mn = entry.mn;
    const form = mode.form;
    // read the operands for this form; `store` puts the result back, or is null when nothing is stored
    let s, d, store;
    switch (form) {
      case 'B,A': s = this.read8(1); d = this.read8(0); store = (v) => this.write8(0, v); break;
      case 'Rn,A': s = this.read8(this.fetch8()); d = this.read8(0); store = (v) => this.write8(0, v); break;
      case 'Rn,B': s = this.read8(this.fetch8()); d = this.read8(1); store = (v) => this.write8(1, v); break;
      case 'Rn,Rn': { const rs = this.fetch8(); s = this.read8(rs); const rd = this.fetch8(); d = this.read8(rd); store = (v) => this.write8(rd, v); break; }
      case 'imm,A': s = this.fetch8(); d = this.read8(0); store = (v) => this.write8(0, v); break;
      case 'imm,B': s = this.fetch8(); d = this.read8(1); store = (v) => this.write8(1, v); break;
      case 'imm,Rn': { s = this.fetch8(); const rd = this.fetch8(); d = this.read8(rd); store = (v) => this.write8(rd, v); break; }
      // peripheral forms: (s) OP (Pn) -> (Pn), read before the write (page 6-45's note)
      case 'A,Pd': s = this.read8(0); { const p = this.fetch8(); d = this.readP(p); store = (v) => this.writeP(p, v); } break;
      case 'B,Pd': s = this.read8(1); { const p = this.fetch8(); d = this.readP(p); store = (v) => this.writeP(p, v); } break;
      case 'imm,Pd': case 'imm,Pn': s = this.fetch8(); { const p = this.fetch8(); d = this.readP(p); store = (v) => this.writeP(p, v); } break;
      case 'Ps,A': { const p = this.fetch8(); s = this.readP(p); } d = this.read8(0); store = (v) => this.write8(0, v); break;
      case 'Ps,B': { const p = this.fetch8(); s = this.readP(p); } d = this.read8(1); store = (v) => this.write8(1, v); break;
      case 'A,Pn': s = this.read8(0); { const p = this.fetch8(); d = this.readP(p); store = (v) => this.writeP(p, v); } break;
      case 'B,Pn': s = this.read8(1); { const p = this.fetch8(); d = this.readP(p); store = (v) => this.writeP(p, v); } break;
      default: throw new Error(`${mn}: unhandled dual form ${form}`);
    }
    // the operation itself, from its per-instruction page
    let write = null;
    switch (mn) {
      case 'ADD': { const r = s + d; this.setCNZ(r > 0xFF, r); write = r; break; }      case 'ADC': { const r = s + d + (this.carry ? 1 : 0); this.setCNZ(r > 0xFF, r); write = r; break; }
      case 'SUB': { const r = d - s; this.setCNZ(!(d < s), r); write = r; break; }        // C is no-borrow (page 6-62)
      case 'SBB': { const r = d - s - (this.carry ? 0 : 1); this.setCNZ(!(d < s + (this.carry ? 0 : 1)), r); write = r; break; }
      case 'AND': this.setCNZ(false, s & d); write = s & d; break;
      case 'OR': this.setCNZ(false, s | d); write = s | d; break;
      case 'XOR': this.setCNZ(false, s ^ d); write = s ^ d; break;
      // MOV: (s) -> (Rd) (page 6-43), with N and Z set on the value moved
      case 'MOV': this.setNZ(s); write = s; break;
      case 'CMP': {
        // page 6-27 and Table 6-4: C is 1 if the destination is not less than the source, N is the sign
        // of the result, Z is set when they are equal. (Table 6-4 row "7F 7F" gives C=1, N=0, Z=1.)
        const r = (d - s) & 0xFF;
        this.setCNZ(!((d & 0xFF) < s), r);
        write = null;
        break;
      }
      case 'MPY': {
        const r = s * d;                        // the 16-bit product, MSB in A (page 6-46)
        this.write8(0, (r >> 8) & 0xFF);
        this.write8(1, r & 0xFF);
        this.setCNZ(false, (r >> 8) & 0xFF);
        write = null;
        break;
      }
      case 'DAC': { write = this.bcdAdd(s, d, this.carry); break; }
      case 'DSB': { write = this.bcdSub(d, s, this.carry); break; }
      // ANDP/ORP/XORP read the peripheral register, combine it and write it back (pages 6-18, 6-49, 6-69)
      case 'ANDP': this.setCNZ(false, s & d); write = s & d; break;
      case 'ORP': this.setCNZ(false, s | d); write = s | d; break;
      case 'XORP': this.setCNZ(false, s ^ d); write = s ^ d; break;
      case 'BTJOP': {
        // page 6-21: jump if (s) AND (Pn) is non-zero
        const r = s & d;
        this.setCNZ(false, r);
        this.branchOn(r !== 0, mode);
        return;
      }
      case 'BTJZP': {
        // page 6-22: jump if (s) AND NOT(Pn) is non-zero
        const r = s & (~d & 0xFF);
        this.setCNZ(false, r);
        this.branchOn(r !== 0, mode);
        return;
      }
      case 'BTJO': {
        const r = s & d;
        this.setCNZ(false, r);
        this.branchOn(r !== 0, mode);
        return;
      }
      case 'BTJZ': {
        // page 6-21: jump if (s) AND NOT(destination) is non-zero
        const r = s & (~d & 0xFF);
        this.setCNZ(false, r);
        this.branchOn(r !== 0, mode);
        return;
      }
      default: throw new Error(`${mn}: no dual-operand operation`);
    }
    this.c = mode.cycles;
    if (write !== null && store) store(write & 0xFF);
  }

  // MOVP: the same instruction moves either way (page 6-45), so its operand order decides direction
  movp(entry, mode) {
    const form = mode.form;
    let v;
    switch (form) {
      case 'Ps,A': v = this.readP(this.fetch8()); this.write8(0, v); break;
      case 'Ps,B': v = this.readP(this.fetch8()); this.write8(1, v); break;
      case 'A,Pd': { v = this.read8(0); const p = this.fetch8(); this.writeP(p, v); break; }
      case 'B,Pd': { v = this.read8(1); const p = this.fetch8(); this.writeP(p, v); break; }
      case 'imm,Pd': { v = this.fetch8(); const p = this.fetch8(); this.writeP(p, v); break; }
      default: throw new Error(`MOVP: unhandled form ${form}`);
    }
    this.setCNZ(false, v);
    this.c = mode.cycles;
  }

  // The peripheral file is memory at >0100 + n (3.1.2), so the hook and the bus see the same accesses.
  readP(n) { return this.read8(0x0100 + n); }
  writeP(n, v) { this.write8(0x0100 + n, v); }

  // ---- packed BCD, from the DAC and DSB pages (6-29, 6-34) and §9.11.6's worked routine ----
  // DAC: (s) + (d) + C, adjusted to a packed-BCD result; C is set when the sum reaches 100 decimal.
  bcdAdd(s, d, carry) {
    const sum = s + d + (carry ? 1 : 0);
    let lo = (s & 0x0F) + (d & 0x0F) + (carry ? 1 : 0);
    let hi = (s >> 4) + (d >> 4);
    if (lo > 9) { lo -= 10; hi += 1; }                    // the half-carry correction
    const decimalCarry = hi > 9;
    if (decimalCarry) hi -= 10;
    const r = ((hi << 4) | lo) & 0xFF;
    this.setCNZ(decimalCarry, r);
    return r;
  }
  // DSB: (d) - (s) - 1 + C, adjusted; C is the no-borrow bit (page 6-34: "1 no borrow required").
  bcdSub(d, s, carry) {
    const borrowIn = carry ? 0 : 1;
    let lo = (d & 0x0F) - (s & 0x0F) - borrowIn;
    let hi = (d >> 4) - (s >> 4);
    if (lo < 0) { lo += 10; hi -= 1; }
    const noBorrow = hi >= 0;
    if (hi < 0) hi += 10;
    const r = (((hi & 0x0F) << 4) | (lo & 0x0F)) & 0xFF;
    this.setCNZ(noBorrow, r);
    return r;
  }

  signed8(v) { return (v << 24) >> 24; }

  // A bit-test's jump: the offset byte is read either way, and the PC is adjusted only when the test
  // passes (Table A-5: "add two to the cycle count if the branch is taken"). The offset is from the
  // address after the offset byte (§6.2.5), which is where pc already points once it is read.
  branchOn(taken, mode) {
    const off = this.signed8(this.fetch8());
    if (taken) this.pc = (this.pc + off) & 0xFFFF;
    this.c = taken && mode && mode.taken !== undefined ? mode.taken : (mode ? mode.cycles : this.c);
  }

  // single-operand operations, from their pages
  single(entry, mode) {
    const mn = entry.mn;
    const form = mode.form;
    let addr, val, isReg = false;
    if (form === 'A') { addr = 0; isReg = true; }
    else if (form === 'B') { addr = 1; isReg = true; }
    else addr = this.fetch8();

    switch (mn) {
      case 'CLR': this.write8(addr, 0); this.setCNZ(false, 0); this.st |= Z; this.st &= ~(C | N); break;
      case 'INC': { const v = this.read8(addr); const r = v + 1; this.write8(addr, r); this.setCNZ(v === 0xFF, r); break; }
      // page 6-30: "C = 0 if (Rd) decrements from >00 to >FF; 1 otherwise"
      case 'DEC': { const v = this.read8(addr); const r = v - 1; this.write8(addr, r); this.setCNZ(v !== 0x00, r); break; }
      case 'INV': { const r = ~this.read8(addr); this.write8(addr, r); this.setCNZ(false, r); break; }
      case 'SWAP': { const v = this.read8(addr); const r = ((v << 4) | (v >> 4)) & 0xFF; this.write8(addr, r); this.setCNZ(r & 0x01, r); break; }
      case 'RL': { const v = this.read8(addr); const r = ((v << 1) | (v >> 7)) & 0xFF; this.write8(addr, r); this.setCNZ((v & 0x80) !== 0, r); break; }
      case 'RLC': { const v = this.read8(addr); const r = ((v << 1) | (this.carry ? 1 : 0)) & 0xFF; this.write8(addr, r); this.setCNZ((v & 0x80) !== 0, r); break; }
      case 'RR': { const v = this.read8(addr); const r = ((v >> 1) | ((v & 0x01) << 7)) & 0xFF; this.write8(addr, r); this.setCNZ((v & 0x01) !== 0, r); break; }
      case 'RRC': { const v = this.read8(addr); const r = ((v >> 1) | (this.carry ? 0x80 : 0)) & 0xFF; this.write8(addr, r); this.setCNZ((v & 0x01) !== 0, r); break; }
      case 'PUSH': { const v = this.read8(addr); this.push(v); this.setCNZ(false, v); break; }
      case 'POP': { const v = this.pop(); this.write8(addr, v); this.setCNZ(false, v); break; }
      case 'XCHB': { const b = this.read8(1); const v = this.read8(addr); this.write8(1, v); this.write8(addr, b); this.setCNZ(false, v); break; }
      case 'DECD': {
        const v = this.readPair(addr); const r = (v - 1) & 0xFFFF;
        this.writePair(addr, r);
        const msb = (r >> 8) & 0xFF;
        this.setCNZ(msb !== 0xFF ? true : false, msb);          // page 6-31: C=0 only on >00 -> >FF
        break;
      }
      case 'DJNZ': {
        const r = this.read8(addr) - 1;
        this.write8(addr, r);
        const off = this.fetch8();
        if (r !== 0) { this.pc = (this.pc + this.signed8(off)) & 0xFFFF; this.c = mode.taken; return; }
        this.c = mode.cycles;
        return;
      }
      default: this.movSingle(entry, mode, addr); return;
    }
    this.c = mode.cycles;
  }

  // MOV's single-register forms: A,B ; A,Rd ; B,Rd (page 6-43)
  movSingle(entry, mode, addr) {
    const form = mode.form;
    if (form === 'A,B') { this.write8(1, this.read8(0)); this.setCNZ(false, this.read8(1)); }
    else if (form === 'A,Rd') { const v = this.read8(0); this.write8(addr, v); this.setCNZ(false, v); }
    else if (form === 'B,Rd') { const v = this.read8(1); this.write8(addr, v); this.setCNZ(false, v); }
    else throw new Error(`MOV: unhandled form ${form}`);
    this.c = mode.cycles;
  }

  // MOVD: a 16-bit value into a register pair, the operand naming the LSB's register (page 6-44)
  movd(entry, mode) {
    let v;
    if (mode.form === 'imm,Rp') v = this.fetch16();
    else if (mode.form === 'imm(B),Rp') v = (this.fetch16() + this.read8(1)) & 0xFFFF;
    else if (mode.form === 'Rp,Rp') v = this.readPair(this.fetch8());
    else throw new Error(`MOVD: unhandled form ${mode.form}`);
    const r = this.fetch8();
    this.writePair(r, v);
    this.setCNZ(false, (v >> 8) & 0xFF);
    this.c = mode.cycles;
  }

  // the instructions with no operands (pages 6-32 .. 6-61)
  implied(entry, mode) {
    switch (entry.mn) {
      case 'NOP': break;
      case 'IDLE': this.idle = true; this.pc = (this.pc - 1) & 0xFFFF; break;   // page 6-35: the PC stays on IDLE
      case 'EINT': this.st |= I | C | N | Z; break;
      case 'DINT': this.st &= ~(I | C | N | Z); break;
      case 'SETC': this.st = (this.st & ~(N)) | C | Z; break;                    // Table 6-3: 1 0 1 x
      case 'CLRC': case 'TSTA': this.st = (this.st & ~C); this.setNZ(this.read8(0)); break;
      case 'TSTB': this.st &= ~C; this.setNZ(this.read8(1)); break;
      case 'LDSP': this.sp = this.read8(1); break;
      case 'STSP': this.write8(1, this.sp); break;
      case 'PUSH ST': this.push(this.st); break;
      case 'POP ST': this.st = this.pop() & SR_MASK; break;
      case 'RETS': { const lo = this.pop(); const hi = this.pop(); this.pc = (hi << 8) | lo; break; }
      case 'RETI': {
        const lo = this.pop(); const hi = this.pop(); this.st = this.pop() & SR_MASK;
        this.pc = (hi << 8) | lo;
        break;
      }
      default:
        if (entry.mn.startsWith('TRAP ')) { this.trap(+entry.mn.slice(5)); this.c = mode.cycles; return; }
        throw new Error(`unhandled implied instruction ${entry.mn}`);
    }
    this.c = mode.cycles;
  }

  // TRAP: a one-byte call through the trap vector table (page 6-64, Table A-20). The vector address is
  // >FF00 + 2n for trap 0 and counts down, so trap 0 is at >FFFE and trap 23 at >FFD0.
  trap(n) {
    const addr = (0xFFFE - n * 2) & 0xFFFF;
    const target = this.fetchVector(addr);
    this.push(this.pc >> 8);
    this.push(this.pc & 0xFF);
    this.pc = target;
  }

  // relative jumps (pages 6-39, 6-40): the offset is added to the address after the instruction
  rel(entry, mode) {
    const off = this.signed8(this.fetch8());
    let taken = false;
    switch (entry.mn) {
      case 'JMP': taken = true; break;
      case 'JC': case 'JHS': taken = this.carry; break;
      case 'JNC': case 'JL': taken = !this.carry; break;
      case 'JZ': case 'JEQ': taken = (this.st & Z) !== 0; break;
      case 'JNZ': case 'JNE': taken = (this.st & Z) === 0; break;
      case 'JN': case 'JLT': taken = (this.st & N) !== 0; break;
      case 'JP': case 'JGT': taken = (this.st & (N | Z)) === 0; break;
      case 'JPZ': case 'JGE': taken = (this.st & N) === 0; break;
      default: throw new Error(`unhandled jump ${entry.mn}`);
    }
    if (taken) { this.pc = (this.pc + off) & 0xFFFF; this.c = mode.taken !== undefined ? mode.taken : mode.cycles; }
    else this.c = mode.cycles;
  }

  // extended addressing: LDA, STA, CMPA, BR, CALL (pages 6-19, 6-24, 6-28, 6-41, 6-60)
  extended(entry, mode) {
    // The operand bytes are read before anything is pushed: CALL's pushed address is the instruction
    // after them (page 6-24), so the effective address has to be computed first.
    const addr = this.extAddr(mode.form);
    switch (entry.mn) {
      case 'LDA': { const v = this.read8(addr); this.write8(0, v); this.setCNZ(false, v); break; }
      case 'STA': { const v = this.read8(0); this.write8(addr, v); this.setCNZ(false, v); break; }
      case 'CMPA': { const a = this.read8(0); const r = (a - this.read8(addr)) & 0xFF; this.setCNZ(!(a < this.read8(addr)), r); break; }
      case 'BR': this.pc = addr; break;
      case 'CALL': this.push(this.pc >> 8); this.push(this.pc & 0xFF); this.pc = addr; break;
      default: throw new Error(`unhandled extended instruction ${entry.mn}`);
    }
    this.c = mode.cycles;
  }
}

// The dispatch a core uses for each mnemonic. Keeping it as data means an instruction this table does not
// name fails loudly instead of executing as a no-op.
CPU7000.prototype.dispatch = function dispatch(entry, mode) {
  const mn = entry.mn;
  if (mode.form === 'implied' || mn === 'PUSH ST' || mn === 'POP ST') return this.implied(entry, mode);
  if (mode.form === 'A,rel' || mode.form === 'B,rel' || mode.form === 'Rn,rel') return this.single(entry, mode);
  if (mode.form === 'rel') return this.rel(entry, mode);
  if (mn === 'CALL' || mn === 'BR' || mn === 'LDA' || mn === 'STA' || mn === 'CMPA') return this.extended(entry, mode);
  if (mn === 'MOVD') return this.movd(entry, mode);
  if (mn === 'MOVP') return this.movp(entry, mode);
  // dual-operand operations: every form that names two operands
  if (['B,A', 'Rn,A', 'Rn,B', 'Rn,Rn', 'imm,A', 'imm,B', 'imm,Rn', 'A,Pd', 'B,Pd', 'imm,Pd',
    'Ps,A', 'Ps,B', 'A,Pn', 'B,Pn', 'imm,Pn'].includes(mode.form)) return this.dual(entry, mode);
  // single-operand operations and MOV's register forms
  if (['A', 'B', 'Rn', 'Rd', 'Rp', 'Rs', 'A,B', 'A,Rd', 'B,Rd'].includes(mode.form)) return this.single(entry, mode);
  throw new Error(`no dispatch for ${mn} ${mode.form}`);
};

CPU7000.FLAGS = { C, N, Z, I };
// Every register the core keeps, including the three that are state and were missing before: IOCNT0 and the
// ports' data and direction latches. The direction latches matter twice over - a port reads through them
// (read8) and drives through them (write8 masks the value by the DDR), so a restored core without them reads
// its pins as inputs and drives nothing (AGENTS section 4.5: every stateful part belongs in the snapshot).
CPU7000.STATE = ['sp', 'st', 'pc', 'c', 'totalCycles', 'idle', 'irqPending', 'iocnt0', 'portLatch', 'portDdr'];

// snapshots (AGENTS.md section 4.5): the registers only; the register file belongs to the bus owner
CPU7000.prototype.saveState = function saveState() { return state.save(this, CPU7000.STATE); };
CPU7000.prototype.loadState = function loadState(s) { state.load(this, s, CPU7000.STATE); };

export { CPU7000 };
