/*
 * General Instrument SP0256 / SP0256A-AL2 speech processor: the microsequencer, its parameter decode and its timing
 * (stage 2). The 12-pole filter and the output are stage 3; this file produces the sample CLOCK of the chip - when an
 * instruction runs, how long its parameters are held, when the address-load request (LRQ) and the standby pin (SBY)
 * change - but not the sample VALUES.
 *
 * SOURCES
 *  - GI "SP0256 Design Objective Specification", Document Control #0380-20, rev 1981 ("GI sheet N"): the instruction
 *    groups, the branch and page machinery, the repeat register, the host handshake (LRQ, SBY, ALD) and the timing in
 *    pitch periods and 64-sample unvoiced units (sheets 12, 17-30).
 *  - GI "SP0250 Applications Manual", June 1982, pin 20 SYNC: "640ns positive pulse with a duty cycle of 312
 *    clocks"; with the 3.12 MHz crystal of the Radio Shack SP0256 datasheet (catalog 276-1784, April 1984) that is
 *    one sample every 312 clocks, 10 kHz: the hardware rate here.
 *  - MAME 0.264 src/devices/sound/sp0256.cpp (J. Zbiciak's model, ported by T. Lindner) as the BEHAVIOUR reference
 *    and the oracle (AGENTS.md 4.4): every behaviour below that GI's documents do not settle is MAME's, and is
 *    checked against MAME by tools/mame-diff/ssc (docs/verification.md). No MAME code is copied: this is our own
 *    implementation of the behaviour, and the parameter table below is restated in our own form.
 *  - The allophone ROM (the AL2's program) is copyrighted and is NOT part of this project: the caller supplies an
 *    image, as with the BASIC ROMs. Tests and comparisons use images built by tools/mame-diff/ssc/sp0256-asm.js.
 *
 * THE ROM AND ITS BIT ORDER
 * The program is a bit stream on arbitrary bit boundaries. The PC is a BIT address in a 64 KB space; the AL2's 2 KB
 * sits at $1000-$17FF (the image given here), and everything else reads 0. Bits are taken LSB first: bit b of the
 * stream is bit (b mod 8) of byte (b div 8). That is the order in which an unreversed AL2 dump speaks (MAME reads the
 * dump this way; a user's dump must be read the way it was dumped), and it matches GI's notation, which writes each
 * instruction byte as an ordinary binary number with the opcode in the high nibble: shifted out LSB first, the low
 * nibble (the immediate) comes first and the opcode second. Parameter fields are plain binary numbers in that order.
 * Branch and page addresses are the exception: their bits come most significant first, so they are reversed here.
 *
 * OPCODES are numbered here as the chip shifts them in, the first opcode bit being bit 0, which is also the number
 * GI's notation shows (MSB left): GI's RCU "0001" is SETMODE, 1; its JSR "1101" is 13; its JMP "1110" is 14. Listings
 * written in serial order, first bit left (Zbiciak's and MAME's comments, "1000 SETMODE"), are their mirror image.
 *
 * TIMING
 * The chip makes one sample per SAMPLE_CLOCKS of its 3.12 MHz clock. Each sample: if the parameters' repeat count has
 * run out, the sequencer runs instructions until one sets a new count (or it halts); then the excitation advances one
 * sample. Voiced (a non-zero pitch period P): an impulse every P + 1 samples, and the repeat count drops at each
 * impulse. Unvoiced (P = 0): the count drops every 64 samples. A PAUSE holds a period of 64. The sample at which the
 * count reaches 0 is not output: the next instruction's first sample takes its place (MAME's update loop).
 * While halted (after an RTS with no return address), the sequencer looks for a loaded address only when its idle
 * period runs out: every 64 samples. So an address loaded while the chip is idle starts up to 64 samples later.
 */
import { state } from '../util.js';

export const XTAL = 3120000;
// Clocks per sample: the hardware's 312 (above), and MAME 0.264's `CLOCK_DIVIDER (7*6*8)`, uncited in its source
// and at odds with its own "~10kHz samples" comment; used only under config.mameCompat (docs/verification.md,
// "Deviations from MAME").
export const SAMPLE_CLOCKS = { hardware: 312, mame: 336 };

const ROM_BASE = 0x1000;          // the AL2's 2 KB, in the chip's address space
const NOISE_PERIOD = 64;          // samples per repeat in unvoiced mode, and a PAUSE's period

// the parameter registers
const AM = 0, PR = 1, B0 = 2, F0 = 3, B1 = 4, F1 = 5, B2 = 6, F2 = 7, B3 = 8, F3 = 9, B4 = 10, F4 = 11, B5 = 12,
  F5 = 13, IA = 14, IP = 15;

// opcodes, numbered as shifted in (bit 0 first)
export const OP = { RTS_PAG: 0, SETMODE: 1, LOAD_4: 2, LOAD_C: 3, LOAD_2: 4, SETMSB_A: 5, SETMSB_6: 6, LOAD_E: 7,
  LOADALL: 8, DELTA_9: 9, SETMSB_5: 10, DELTA_D: 11, SETMSB_3: 12, JSR: 13, JMP: 14, PAUSE: 15 };

/*
 * The parameter fields each load instruction reads, per mode. A field is [register, bits, shift, kind]: `bits` are
 * read, shifted left by `shift` (the register keeps its top `bits` bits), and then:
 *   'set'    the register takes the value;
 *   'msb'    the value replaces the register's top bits, keeping its low `shift` bits;
 *   'delta'  the value, sign-extended, is added to the register.
 * 'clrAll' and 'clr5' entries clear every register, or B5 and F5, before the fields after them. The mode is the
 * two-bit M/P value SETMODE leaves (its immediate's bits 3 and 2); `modes` lists [mode 0, mode 1, mode 2, mode 3].
 * These are GI's bit-precision maps (sheets 21-22), which the stage-1 work could not read from GI's scan; they are
 * as MAME 0.264 has them, and each one is exercised against MAME by tools/mame-diff/ssc (a wrong width misframes
 * every instruction after it, which changes the timing that comparison measures).
 */
const f = (reg, bits, shift = 0, kind = 'set') => [reg, bits, shift, kind];
const CLR_ALL = ['clrAll'], CLR5 = ['clr5'];
const coefLow = [f(B0, 3, 4), f(F0, 5, 3), f(B1, 3, 4), f(F1, 5, 3), f(B2, 3, 4), f(F2, 5, 3), f(B3, 4, 3), f(F3, 6, 2),
  f(B4, 7, 1), f(F4, 6, 2)];
const coefHigh = [f(B0, 6, 1), f(F0, 6, 2), f(B1, 6, 1), f(F1, 6, 2), f(B2, 6, 1), f(F2, 6, 2), f(B3, 6, 1), f(F3, 7, 1),
  f(B4, 8), f(F4, 8)];
const stage5 = [f(B5, 8), f(F5, 8)];
const interp5 = [f(IA, 5), f(IP, 5)];
const ampPer = [CLR_ALL, f(AM, 6, 2), f(PR, 8)];
const d = (reg, bits, shift = 0) => f(reg, bits, shift, 'delta');
const m = (reg, bits, shift = 0) => f(reg, bits, shift, 'msb');
const load2C = (interp) => [
  [...ampPer, ...coefLow, ...(interp ? interp5 : [])],
  [...ampPer, ...coefLow, ...stage5, ...(interp ? interp5 : [])],
  [...ampPer, ...coefHigh, ...(interp ? interp5 : [])],
  [...ampPer, ...coefHigh, ...stage5, ...(interp ? interp5 : [])],
];
const setmsb35 = (interp) => {
  const low = [f(AM, 6, 2), f(PR, 8), m(F0, 5, 3), m(F1, 5, 3), m(F2, 5, 3), ...(interp ? interp5 : [])];
  const high = [f(AM, 6, 2), f(PR, 8), m(F0, 6, 2), m(F1, 6, 2), m(F2, 6, 2), ...(interp ? interp5 : [])];
  return [[CLR5, ...low], low, [CLR5, ...high], high];
};
const loadAll = [CLR_ALL, f(AM, 8), f(PR, 8), ...[B0, F0, B1, F1, B2, F2, B3, F3, B4, F4, B5, F5].map((r) => f(r, 8))];
const load4Low = [...ampPer, f(B3, 4, 3), f(F3, 6, 2), f(B4, 7, 1), f(F4, 6, 2)];
const load4High = [...ampPer, f(B3, 6, 1), f(F3, 7, 1), f(B4, 8), f(F4, 8)];
const setmsb6Low = [f(AM, 6, 2), m(F3, 6, 2), m(F4, 6, 2)];
const setmsb6High = [f(AM, 6, 2), m(F3, 7, 1), m(F4, 8)];
const setmsbALow = [f(AM, 6, 2), m(F0, 5, 3), m(F1, 5, 3), m(F2, 5, 3)];
const setmsbAHigh = [f(AM, 6, 2), m(F0, 6, 2), m(F1, 6, 2), m(F2, 6, 2)];
const delta9Low = [d(AM, 4, 2), d(PR, 5), d(B0, 3, 4), d(F0, 3, 3), d(B1, 3, 4), d(F1, 3, 3), d(B2, 3, 4), d(F2, 3, 3),
  d(B3, 3, 3), d(F3, 4, 2), d(B4, 4, 1), d(F4, 4, 2)];
const delta9High = [d(AM, 4, 2), d(PR, 5), d(B0, 4, 1), d(F0, 4, 2), d(B1, 4, 1), d(F1, 4, 2), d(B2, 4, 1), d(F2, 4, 2),
  d(B3, 4, 1), d(F3, 5, 1), d(B4, 5), d(F4, 5)];
const deltaDLow = [d(AM, 4, 2), d(PR, 5), d(B3, 3, 3), d(F3, 4, 2), d(B4, 4, 1), d(F4, 4, 2)];
const deltaDHigh = [d(AM, 4, 2), d(PR, 5), d(B3, 4, 1), d(F3, 5, 1), d(B4, 5), d(F4, 5)];
const delta5 = [d(B5, 5), d(F5, 5)];
export const FIELDS = {
  [OP.LOADALL]: [loadAll, [...loadAll, f(IA, 8), f(IP, 8)], loadAll, [...loadAll, f(IA, 8), f(IP, 8)]],
  [OP.LOAD_4]: [load4Low, [...load4Low, ...stage5], load4High, [...load4High, ...stage5]],
  [OP.LOAD_C]: load2C(false),
  [OP.LOAD_2]: load2C(true),
  [OP.SETMSB_6]: [[CLR5, ...setmsb6Low], [...setmsb6Low, m(F5, 8)], [CLR5, ...setmsb6High], [...setmsb6High, m(F5, 8)]],
  [OP.SETMSB_A]: [[CLR5, ...setmsbALow], setmsbALow, [CLR5, ...setmsbAHigh], setmsbAHigh],
  [OP.DELTA_9]: [delta9Low, [...delta9Low, ...delta5], delta9High, [...delta9High, ...delta5]],
  [OP.DELTA_D]: [deltaDLow, [...deltaDLow, ...delta5], deltaDHigh, [...deltaDHigh, ...delta5]],
  [OP.LOAD_E]: [0, 1, 2, 3].map(() => [f(AM, 6, 2), f(PR, 8)]),
  [OP.SETMSB_5]: setmsb35(false),
  [OP.SETMSB_3]: setmsb35(true),
  [OP.PAUSE]: [0, 1, 2, 3].map(() => [CLR_ALL]),
};

const rev4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);
const rev8 = (v) => (rev4(v & 15) << 4) | rev4(v >> 4);
const s8 = (v) => (v << 24) >> 24;                    // to a signed byte, as the chip's 8-bit registers hold it

const STATE = ['pc', 'stack', 'page', 'mode', 'halted', 'lrq', 'ald', 'sby', 'silent', 'r', 'rpt', 'cnt', 'per', 'amp',
  'interp', 'rng'];

export class SP0256 {
  // rom: the 2 KB program image at $1000 (null: no data, every fetch reads 0)
  constructor({ rom = null } = {}) {
    this.rom = rom;
    this.r = new Uint8Array(16);
    this.reset();
  }

  reset() {
    this.pc = 0;                 // a BIT address
    this.stack = 0;              // the one return address (a bit address; 0 = none)
    this.page = ROM_BASE << 3;   // the page JMP and JSR take their top 4 address bits from
    this.mode = 0;               // SETMODE's result: bits 1-2 the M/P mode, bits 4-5 the repeat count's high bits
    this.halted = true;
    this.lrq = true;             // high: ready for an address (LRQ is active low on the pin)
    this.ald = 0;                // the loaded address, as a bit offset
    this.sby = true;             // standby: high while idle
    this.silent = true;
    this.r.fill(0);
    this.rpt = -1;               // repeats left of the current parameters
    this.cnt = 0;                // samples to the next impulse (voiced) or repeat (unvoiced)
    this.per = 0;
    this.amp = 0;
    this.interp = false;
    this.rng = 1;                // the unvoiced excitation's 15-bit shift register
  }

  // ---------------- host interface ----------------
  // ALD: load an address (the 8-bit command), as GI sheet 30 has it. Ignored while one is already waiting (LRQ low).
  // The chip leaves standby, and LRQ goes low until the sequencer takes the address.
  loadAddress(n) {
    if (!this.lrq) return false;
    this.lrq = false;
    this.ald = (n & 0xff) << 4;   // entry n is at byte ROM_BASE + 2n
    this.sby = false;
    return true;
  }

  // ---------------- the ROM bit stream ----------------
  byteAt(a) {
    a &= 0xffff;
    if (!this.rom || a < ROM_BASE || a >= ROM_BASE + this.rom.length) return 0;
    return this.rom[a - ROM_BASE];
  }
  bits(n) {
    const v = ((this.byteAt((this.pc >> 3) + 1) << 8) | this.byteAt(this.pc >> 3)) >> (this.pc & 7);
    this.pc += n;
    return v & ((1 << n) - 1);
  }

  // ---------------- one sample ----------------
  // Advance one sample period: run the sequencer when the repeat count has run out, then the excitation.
  sample() {
    for (;;) {
      if (this.rpt <= 0) this.micro();
      if (this.excite()) return;
    }
  }

  // One step of the excitation. False when the repeat count runs out on it: that step is not a sample.
  excite() {
    let interpolate = false;
    if (this.per) {
      if (this.cnt <= 0) { this.cnt += this.per; this.rpt--; interpolate = this.interp; }
      else this.cnt--;
    } else {
      if (--this.cnt <= 0) { interpolate = this.interp; this.cnt = NOISE_PERIOD; this.rpt--; }
      this.rng = (this.rng >>> 1) ^ (this.rng & 1 ? 0x4001 : 0);
    }
    if (interpolate) {
      this.r[AM] += this.r[IA];
      this.r[PR] += this.r[IP];
      this.decodeAmpPer();
    }
    return this.rpt > 0;
  }

  decodeAmpPer() {
    this.amp = (this.r[AM] & 0x1f) << ((this.r[AM] & 0xe0) >> 5);
    this.per = this.r[PR];
  }

  // ---------------- the sequencer ----------------
  micro() {
    while (this.rpt <= 0) {
      if (this.halted && !this.lrq) {           // an address is waiting: start there
        this.pc = (ROM_BASE << 3) | this.ald;
        this.halted = false;
        this.lrq = true;
        this.ald = 0;
        this.r.fill(0);
      }
      if (this.halted) {                        // idle: look again after one idle period
        this.rpt = 1;
        this.lrq = true;
        this.ald = 0;
        this.r.fill(0);
        this.sby = true;
        return;
      }
      const immed = this.bits(4), op = this.bits(4);
      let repeat = 0;
      if (op === OP.RTS_PAG) {
        if (immed) {
          this.page = (rev4(immed) << 12) << 3;                     // PAG: the top 4 address bits
        } else {
          const to = this.stack;                                    // RTS
          this.stack = 0;
          if (to) this.pc = to;
          else { this.halted = true; this.pc = 0; }
          this.mode &= 0x0f;
          continue;
        }
      } else if (op === OP.JMP || op === OP.JSR) {
        const target = (this.page >> 3) | (rev4(immed) << 8) | rev8(this.bits(8));
        if (op === OP.JSR) this.stack = (this.pc + 7) & ~7;         // the byte after the instruction
        this.pc = target << 3;
        this.mode &= 0x0f;
        continue;
      } else if (op === OP.SETMODE) {
        this.mode = ((immed & 8) >> 2) | (immed & 4) | ((immed & 3) << 4);
      } else {
        repeat = immed | (this.mode & 0x30);
      }
      if (op !== OP.SETMODE) this.mode &= 0x0f;
      if (!repeat) continue;                    // a load with no repeat reads none of its fields
      this.rpt = repeat + 1;
      this.loadFields(op);
      if (op === OP.PAUSE) { this.silent = true; this.r[PR] = NOISE_PERIOD; }
      this.decodeAmpPer();
      this.cnt = 0;
      this.interp = !!(this.r[IA] || this.r[IP]);
      return;
    }
  }

  loadFields(op) {
    const fields = FIELDS[op];
    if (!fields) return;
    for (const [reg, bits, shift, kind] of fields[(this.mode & 6) >> 1]) {
      if (reg === 'clrAll') { this.r.fill(0); this.silent = true; continue; }
      if (reg === 'clr5') { this.r[B5] = 0; this.r[F5] = 0; continue; }
      let v = s8(this.bits(bits));
      if (kind === 'delta' && (v & (1 << (bits - 1)))) v |= -1 << bits;
      v = s8(v << shift);
      this.silent = false;
      if (kind === 'msb') this.r[reg] = (this.r[reg] & ~(~0 << shift)) | v;
      else if (kind === 'delta') this.r[reg] += v;
      else this.r[reg] = v;
    }
  }

  saveState() {
    const s = state.save(this, STATE);
    s.r = Array.from(this.r);
    return s;
  }
  loadState(s) {
    state.load(this, s, STATE.filter((k) => k !== 'r'));
    if (!('r' in s)) throw new Error('snapshot: missing "r"');
    this.r.set(s.r);
  }
}
