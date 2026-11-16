/*
 * General Instrument SP0256 / SP0256A-AL2 speech processor: the microsequencer and the host interface.
 *
 * This is stage 1 of the Speech/Sound Pak work. It implements, from GI's own documents, the parts of the chip that
 * do not depend on the bit-precision maps: instruction framing, the branch and page machinery, the RCU
 * (mode and repeat-prefix) instruction, the host handshake (LRQ/SBY/IBF), entry-point addressing and the
 * sample-period timing. It does NOT yet decode the parameter-load instructions, and it contains no
 * filter and no DAC -- see "WHAT IS HELD" below.
 *
 * WHAT IS IMPLEMENTED, AND WHERE EACH FACT COMES FROM
 * (GI "SP0256 Design Objective Specification", Document Control #0380-20, rev 1981; pages cited as
 *  "GI sheet N" are that document's own sheet numbers):
 *  - Bit-addressed program counter. Instructions and their data are a bit stream on arbitrary bit
 *    boundaries; JMP/JSR/RET targets are byte-aligned (GI sheets 23 and 25: "the beginning and end of an
 *    instruction sequence may occur anywhere within a byte boundary", and a branch "always cause[s] a
 *    branch to a byte boundary").
 *  - 16-bit PC; a 4-bit PAGE register that "powers up to the value 0001" and cannot be loaded with 0
 *    (GI sheet 26). JMP and JSR take a 12-bit address whose upper 4 bits come from PAGE.
 *  - Branch control group (GI sheets 20 and 26-28): JSR saves the PC in a ONE-deep return register and
 *    sets the return flag; RET pops it when the flag is set, and otherwise takes the pending command
 *    address from IB; with neither it stops the sequencer and raises SBY. PAG (0000 with a non-zero low
 *    nibble) sets PAGE.
 *  - RCU (GI sheet 18: code 0001): loads the upper 2 bits of the repeat register (N4,N3), the precision
 *    select bit (P) and the filter-order select bit (M). Its bits are 0001 MP N4 N3, i.e. M at bit 1 and
 *    P at bit 0, taken literally from that row's "0001MPN_4N_3" code cell.
 *  - Host interface (GI sheet 30, "Input Handshake Control"): LRQ is an OUTPUT driven LOW while IBF is
 *    set. ALD latches the 8 input bits into IB and sets IBF. A branch, and an RET that consumes IB,
 *    clear IBF. SBY is high while the sequencer is stopped waiting for an address (GI sheet 27).
 *  - Entry points (GI sheet 29): the IB byte selects one of 256 entry points "spaced at 2 byte
 *    increments", so the bit address of entry n is n*16.
 *  - Timing (GI sheet 17): after a parameter instruction the sequencer holds the parameters for "the last
 *    of R pitch periods (or 64 X R samples in unvoiced mode)". Unvoiced means P = 0 (GI sheet 12). One
 *    sample is one VTM period; the VTM runs at 10 kHz, which is the 3.12 MHz crystal divided by 312
 *    (GI "SP0250 Applications Manual", June 1982, pin 20 SYNC: "640ns positive pulse with a duty cycle of
 *    312 clocks"; 3.12e6 / 312 = 10000; the 3.12 MHz crystal is from the Radio Shack SP0256 datasheet,
 *    catalog 276-1784).
 *
 * WHAT IS HELD, AND WHY
 * The parameter-load instructions (everything except RCU, PAG/JMP/JSR/RET) decode a variable-length bit
 * field per parameter, and the number and position of those bits comes from GI's two bit-precision-map
 * tables (GI sheets 21 and 22, "HIGH/LOW PRECISION (P=1/P=0) BIT MAP"). Those tables are the one thing in
 * the document that will not resolve: the only available scan is a 300-dpi JPEG in which the 'D' (data)
 * and 'X' (unused) glyphs are near-identical marks, and the readings that a pixel classifier produces
 * contradict the only clean text of the same fields. Guessing them would put invented numbers into the
 * decode, so the load instructions are not decoded here at all: `step()` reports OPCODE_UNMAPPED for them
 * rather than pretending. They are to be settled by measurement in the stage that has MAME's Speech/Sound
 * Pak and `-wavwrite` as its oracle (AGENTS.md 4.6): a hand-built ROM exercising each mode, run through
 * MAME's `coco_ssc`. There is deliberately no placeholder table and no stub: an unused table is dead code.
 *
 * OPCODE CORRESPONDENCE, FOR WHOEVER SETTLES THE MAPS LATER
 * Gi's register-modification codes are read as printed (GI sheets 18-19). The widely copied reverse-
 * engineering document (J. Zbiciak and F. Palazzolo, "SP0256 Instruction Set", 2000; the same text at
 * spatula-city.org/~im14u2c/intv/tech/sp0256_instr_set.html) numbers the SAME instructions with the
 * opcode nibble read back to front, i.e. its opcode is GI's opcode with the four bits reversed:
 *      Zbiciak 0001 "LOADALL, all parameters at full 8-bit precision" = GI 1000, "FPL(API): All
 *              parameters ... loaded with full 8 bit precision for this instruction only";
 *      Zbiciak 1000 SETMODE                                    = GI 0001 RCU (repeat MSBs, P and M);
 *      Zbiciak 1011 JSR                                        = GI 1101 (JSR);
 *      Zbiciak 0111 JMP                                        = GI 1110 (JMP).
 * That is a 16-for-16 semantic match, so the correspondence is reliable; but the document is an
 * implementation reference only, like MAME's sp0256.cpp, and no expected value in this file comes from
 * it. It is cited here solely so that a later reader can map one numbering onto the other.
 *
 * SOURCES: as above, plus the Radio Shack "SP0256 Narrator Speech Processor" datasheet (catalog 276-1784,
 * April 1984) for the pins and the crystal. All were read as PDFs; where the OCR of a scanned page
 * disagreed with the printed page, the page was read directly. The allophone ROM (the AL2 program) is
 * copyrighted and is NOT part of this project: the caller supplies an image, as with the BASIC ROMs.
 */
import { state } from '../util.js';

const SAMPLE_RATE = 10000;   // 3.12 MHz / 312 (see the TIMING note above)

/*
 * The register-modification opcodes, as printed on GI sheets 18-19. The top nibble is the code; the low
 * nibble is the low 4 bits of the repeat register, unless it is zero, which chains this instruction with
 * the one after it (GI sheet 23). Only RCU is decoded by this file; the others are listed so that the
 * framing code can recognise them and report them as not yet mapped, and so that a later reader has the
 * numbers in one place.
 */
const RM_OPCODE = {
  RCU: 0b0001,   // repeat upper bits, precision select (P), filter order select (M)
  PRL: 0b0010, FRL: 0b0011, FRL_AP: 0b0100, FFL: 0b0101, FFU: 0b0110, PCT: 0b0111,
  FPL_AP: 0b1000, DFRL: 0b1001, FRLP: 0b1010, DPRL: 0b1011, FFL_AP: 0b1100, SIL: 0b1111,
};
const RM_NAMES = Object.fromEntries(Object.entries(RM_OPCODE).map(([k, v]) => [v, k]));

// Branch control (GI sheet 20). RET and PAG share the byte 0000 and are told apart by the low nibble:
// 0000 0000 is RET, and 0000 with a non-zero low nibble is PAG carrying the new page. JSR is 1101 and
// JMP is 1110, each followed by 8 more address bits; the instruction byte's low nibble is address bits
// 11-8. (1111 is not a branch: it is the register-modification instruction SIL.)
const BR_RET_PAG = 0x0, BR_JMP = 0xE, BR_JSR = 0xD;

// OPCODE_UNMAPPED: a register-modification instruction whose data layout needs the precision maps, which
// are held (see the header). step() returns this so a caller can tell "not decoded yet" from "done".
const OPCODE_UNMAPPED = 'unmapped';

const STATE = ['pc', 'pag', 'rb', 'retFlag', 'ib', 'ibf', 'repeatPrefix', 'mode', 'R', 'P',
  'waiting', 'halted', 'pendPeriod'];

export class SP0256 {
  /*
   * rom: the speech ROM image. The PC counts BITS, so bit b of the stream is bit (7 - b % 8) of
   * rom[b >> 3]; a missing byte reads as 0, as an unpopulated ROM does.
   */
  constructor({ rom = null, sampleRate = SAMPLE_RATE } = {}) {
    this.rom = rom;
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset() {
    this.pc = 0;              // bit address
    this.pag = 1;             // GI sheet 26: "It powers up to the value 0001"
    this.rb = 0;              // the one-deep return register
    this.retFlag = false;
    this.ib = 0;              // the command-address register
    this.ibf = false;         // input-buffer flag: an address is waiting
    this.repeatPrefix = 0;    // the 2 high bits of the repeat register
    this.mode = 0;            // M and P, as bits 1 and 0 of the RCU nibble
    this.R = 0;
    this.P = 0;
    this.waiting = false;     // stopped at RET with no address loaded (SBY high)
    this.halted = false;
    this.pendPeriod = 0;      // samples the last decoded instruction holds its parameters for
    this.lastStep = null;     // what the last step() did, for tests and the debugger
  }

  // ---------------- host interface (GI sheet 30) ----------------
  // LRQ is an output, LOW while IBF is set; `lrq` is that pin's level.
  get lrq() { return this.ibf; }
  // SBY: high while the sequencer is stopped with no address to start (GI sheet 27).
  get sby() { return this.waiting; }

  // ALD: latch the 8 input bits into IB and set IBF. (GI: "the 8 bits of data ... pulsing the ALD input.
  // The falling edge of ALD will cause LRQ to go low, where it will remain until the internal IBF flag is
  // reset by an RET instruction.")
  loadAddress(addr) {
    this.ib = addr & 0xff;
    this.ibf = true;
  }

  // ---------------- ROM bit stream ----------------
  bitAt(addr) {
    if (!this.rom) return 0;
    const byte = this.rom[(addr >> 3) | 0];
    return byte === undefined ? 0 : (byte >> (7 - (addr & 7))) & 1;
  }
  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) { v = (v << 1) | this.bitAt(this.pc); this.pc++; }
    return v;
  }

  // ---------------- sequencer ----------------
  /*
   * Execute one instruction. Returns the number of samples the sequencer holds the parameters for (0 when
   * the instruction does not produce a period, which is every control instruction), or OPCODE_UNMAPPED
   * when the instruction is a parameter load, whose framing is held.
   */
  step() {
    if (this.waiting) {
      if (!this.ibf) { this.lastStep = { op: 'wait' }; return 0; }
      this.beginAtCommand();
      return this.period();
    }
    const top = this.readBits(4);
    const low = this.readBits(4);
    this.lastStep = { op: null, top, low };
    // 0000 is RET when the low nibble is zero and PAG otherwise (GI sheet 20)
    if (top === BR_RET_PAG) return low === 0 ? this.doRET() : this.doPAG(low);
    if (top === BR_JMP) return this.doJMP(this.target(low));
    if (top === BR_JSR) return this.doJSR(this.target(low));
    if (top === RM_OPCODE.RCU) return this.doRCU(low);
    if (RM_NAMES[top]) {
      // A parameter-load instruction: its code is GI's, but the data that follows is framed by the
      // precision maps, which are held. Report it rather than guess its length and fall out of step.
      this.halted = true;
      this.lastStep = { op: RM_NAMES[top], unmapped: true };
      return OPCODE_UNMAPPED;
    }
    // An undefined code: GI's tables leave these unassigned. Treat the byte as consumed and do nothing.
    this.lastStep = { op: 'undefined', top, low };
    return 0;
  }

  // 12-bit branch target: the low nibble is address bits 11-8, then 8 more bits; PAGE supplies 15-12.
  target(low) {
    return ((this.pag << 12) | (low << 8) | this.readBits(8)) & 0xffff;
  }

  // PAG: 0000 with a non-zero low nibble sets the page for the next JMP/JSR (GI sheet 20)
  doPAG(page) {
    this.pag = page;                 // "The value of the PAG instruction must be greater than zero"
    this.lastStep.op = 'PAG';
    return 0;
  }

  doJMP(addr) { this.ibf = false; this.pc = addr; this.lastStep.op = 'JMP'; return 0; }
  doJSR(addr) { this.rb = this.pc; this.retFlag = true; this.ibf = false; this.pc = addr; this.lastStep.op = 'JSR'; return 0; }
  doRET() {
    if (this.retFlag) {
      this.pc = this.rb; this.retFlag = false; this.ibf = false; this.lastStep.op = 'RET';
      return 0;
    }
    if (this.ibf) { this.beginAtCommand(); return this.period(); }
    // "the controller will disable any further output from the VTM, and wait for the IBF flag to become
    // set. The SBY (standby) pin will go high" (GI sheet 27)
    this.waiting = true;
    this.lastStep.op = 'RET-halt';
    return 0;
  }
  // a new entry point: IB * 16 bits (GI sheet 29: entry points "spaced at 2 byte increments")
  beginAtCommand() {
    this.pc = (this.ib * 16) & 0xffff;
    this.ibf = false;
    this.waiting = false;
    this.halted = false;
    this.lastStep = { op: 'entry', addr: this.pc };
  }

  // RCU: 0001 MP N4 N3 -- M at bit 1, P at bit 0 (GI sheet 18, "0001MPN4N3")
  doRCU(low) {
    this.mode = low & 0x03;                       // bit 1 = M (filter order), bit 0 = P (precision)
    this.repeatPrefix = (low >> 2) & 0x03;        // N4,N3: the repeat register's top two bits
    this.R = this.repeatPrefix << 4;
    this.lastStep.op = 'RCU';
    return 0;
  }

  // The number of samples the last parameter instruction holds: R pitch periods of P samples, or 64
  // samples per repeat in unvoiced mode (P = 0). GI sheet 12/17.
  period() {
    const reps = this.R || 1;
    return reps * (this.P !== 0 ? this.P : 64);
  }

  saveState() { return state.save(this, STATE); }
  loadState(s) { state.load(this, s, STATE); }
}

SP0256.SAMPLE_RATE = SAMPLE_RATE;
SP0256.OPCODE_UNMAPPED = OPCODE_UNMAPPED;
SP0256.RM_OPCODE = RM_OPCODE;
export { SAMPLE_RATE, OPCODE_UNMAPPED, RM_OPCODE };
