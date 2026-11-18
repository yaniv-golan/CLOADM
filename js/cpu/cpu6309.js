/*
 * Hitachi HD6309 CPU core: the 6809 core (js/cpu/cpu6809.js) plus the 6309's extra registers,
 * extra instructions, native mode and error traps. 6809 behaviour is untouched: every instruction
 * the 6309 shares with the 6809 runs the parent's code and keeps the parent's emulation-mode timing,
 * which is what the regression hashes pin.
 *
 * Sources (all cited in the tests as well):
 *  - Hitachi "HD63B09E / HD63C09E CMOS MPU" data sheet, Table 9 "HD6309E Instruction Set Table"
 *    (pp. 27-30: opcode, mode, cycle count, length, condition codes) and Table 4/5 (pp. 24-25).
 *  - "HD63B09EP Technical Reference Guide", Chet Simpson & Alan DeKok, 1994: registers (p. 2),
 *    modes (p. 3), inter-register (p. 4), bit manipulation (p. 4), bit transfers (p. 5),
 *    block transfers (p. 6), new math (p. 7), error trapping (p. 7), opcode table (pp. 10-18),
 *    post-byte tables (pp. 24-26).
 *  - "Addendum to The 6309 Book", Tim Lindner, 2003: indexed post-bytes with separate emulation (EM)
 *    and native-mode (NM) cycle columns (pp. A-12a..A-12d).
 *
 * Timing. A 6309 runs every 6809 instruction in fewer cycles in native mode. The data sheet gives
 * both counts per opcode ("Cycles 6809 (6309)"); NATIVE_SAVE below is that difference, per opcode,
 * generated from the table. In emulation mode (MD bit 0 clear) the 6809 counts apply unchanged.
 *
 * Registers (reference guide p. 2):
 *   E, F   8-bit accumulators; W = E:F (E high); Q = D:W (32-bit, A:B:E:F)
 *   V      16-bit, only reachable by TFR/EXG and the inter-register ops
 *   MD     8-bit mode/error register: bit 0 native mode, bit 1 FIRQ behaves as IRQ,
 *          bit 6 illegal-instruction trap seen, bit 7 divide-by-zero trap seen
 *   0      a read-only zero register (post-byte field values 0xC and 0xD both read as zero)
 *
 * Traps (reference guide p. 7): an illegal opcode, or a division by zero, pushes the machine state
 * and jumps through the vector at $FFF0/$FFF1, setting the matching MD bit.
 */
import { CPU6809 } from './cpu6809.js';
import { state } from '../util.js';

const FL = CPU6809.FLAGS;
const N_F = FL.N, Z_F = FL.Z, V_F = FL.V, C_F = FL.C, H_F = FL.H, E_F = FL.E, I_F = FL.I, F_F = FL.F;

// native-mode cycle saving per opcode, in the "prefix+opcode" hex form used by the keys below.
// Generated from the data sheet's "Cycles 6809 (6309)" column; a positive number is cycles saved.
// (SWI/SWI2 are the two exceptions: they take 2 MORE cycles on a 6309, hence the negative entries.)
const NATIVE_SAVE = {
  '00':1, '03':1, '04':1, '06':1, '07':1, '08':1, '09':1, '0A':1, '0C':1, '0D':2,
  '0E':1, '0F':1, '103F':-2, '113F':-2, '1040':1, '1043':1, '1044':1, '1046':1, '1047':1, '1048':1, '1049':1,
  '104A':1, '104C':1, '104D':1, '104F':1, '1053':1, '1054':1, '1056':1, '1059':1, '105A':1, '105C':1,
  '105D':1, '105F':1, '1080':1, '1081':1, '1082':1, '1083':1, '1084':1, '1085':1, '1086':0, '1088':1,
  '1089':1, '108A':1, '108B':1, '108C':1, '108E':0, '1090':2, '1091':2, '1092':2, '1093':2, '1094':2,
  '1095':2, '1096':1, '1097':1, '1098':2, '1099':2, '109A':2, '109B':2, '109C':2, '109E':1, '109F':1,
  '10A0':1, '10A1':1, '10A2':1, '10A3':1, '10A4':1, '10A5':1, '10A8':1, '10A9':1, '10AA':1, '10AB':1,
  '10AC':1, '10B0':2, '10B1':2, '10B2':2, '10B3':2, '10B4':2, '10B5':2, '10B6':1, '10B7':1, '10B8':2,
  '10B9':2, '10BA':2, '10BB':2, '10BC':2, '10BE':1, '10BF':1, '10DC':1, '10DD':1, '10DE':1, '10DF':1,
  '10FE':1, '10FF':1, '1130':1, '1131':1, '1132':1, '1133':1, '1134':1, '1135':1, '1136':1, '1137':1,
  '1143':1, '114A':1, '114C':1, '114D':1, '114F':1, '1153':1, '115A':1, '115C':1, '115D':1, '115F':1,
  '1183':1, '118C':1, '1190':1, '1191':1, '1193':2, '1196':1, '1197':1, '119B':1, '119C':2, '119D':1,
  '119E':1, '119F':1, '11A3':1, '11B0':1, '11B1':1, '11B3':2, '11B6':1, '11B7':1, '11BB':1, '11BC':2,
  '11BD':1, '11BE':1, '11BF':1, '11D0':1, '11D1':1, '11D6':1, '11D7':1, '11DB':1, '11F0':1, '11F1':1,
  '11F6':1, '11F7':1, '11FB':1, '12':1, '13':1, '16':1, '17':2, '19':1, '1A':1, '1D':1,
  '1E':3, '1F':2, '34':1, '35':1, '36':1, '37':1, '39':1, '3A':2, '3C':2, '3D':1,
  '3F':-2, '40':1, '43':1, '44':1, '46':1, '47':1, '48':1, '49':1, '4A':1, '4C':1,
  '4D':1, '4F':1, '50':1, '53':1, '54':1, '56':1, '57':1, '58':1, '59':1, '5A':1,
  '5C':1, '5D':1, '5F':1, '6D':1, '70':1, '73':1, '74':1, '76':1, '77':1, '78':1,
  '79':1, '7A':1, '7C':1, '7D':2, '7E':1, '7F':1, '83':1, '8C':1, '8D':1, '90':1,
  '91':1, '92':1, '93':2, '94':1, '95':1, '96':1, '97':1, '98':1, '99':1, '9A':1,
  '9B':1, '9C':2, '9D':1, '9E':1, '9F':1, 'A3':1, 'AC':1, 'AD':1, 'B0':1, 'B1':1,
  'B2':1, 'B3':2, 'B4':1, 'B5':1, 'B6':1, 'B7':1, 'B8':1, 'B9':1, 'BA':1, 'BB':1,
  'BC':2, 'BD':1, 'BE':1, 'BF':1, 'C3':1, 'D0':1, 'D1':1, 'D2':1, 'D3':2, 'D4':1,
  'D5':1, 'D6':1, 'D7':1, 'D8':1, 'D9':1, 'DA':1, 'DB':1, 'DC':1, 'DD':1, 'DE':1,
  'DF':1, 'E3':1, 'F0':1, 'F1':1, 'F2':1, 'F3':2, 'F4':1, 'F5':1, 'F6':1, 'F7':1,
  'F8':1, 'F9':1, 'FA':1, 'FB':1, 'FC':1, 'FD':1, 'FE':1, 'FF':1,
};

class CPU6309 extends CPU6809 {
  constructor(bus) {
    super(bus);
    this.e = 0; this.f = 0;      // 8-bit accumulators; W = E:F
    this.v = 0;                  // 16-bit, only through TFR/EXG and the inter-register ops
    this.md = 0;                 // mode/error register
    this._key = '';              // the opcode key of the instruction just decoded (native timing)
    this._opKey = '';            // the same key, kept for the mameCompat lookup (ownTiming clears _key)
    this._ownSave = 0;           // the native saving a 6309-only handler set for itself
    this._postSave = 0;          // the native saving the indexed post byte added
    this._mameDivZero = 0;       // the divide just trapped (mameCompat: its delta depends on it)
    this._pre6309 = [0, 0, 0, '', ''];   // those below at the start of the step (mark/rewind)
  }

  // ---- the new registers ----
  get w() { return (this.e << 8) | this.f; }
  set w(v) { this.e = (v >> 8) & 0xFF; this.f = v & 0xFF; }
  get q() { return ((this.d << 16) | this.w) >>> 0; }
  set q(v) { this.d = (v >>> 16) & 0xFFFF; this.w = v & 0xFFFF; }
  get native() { return !!(this.md & 0x01); }
  get firqAsIrq() { return !!(this.md & 0x02); }

  reset() {
    super.reset();
    this.md = 0;                 // a reset leaves emulation mode
    // V is documented as unchanged by a reset (reference guide p. 2), so its power-on value is not
    // specified. MAME's m6309 powers up with $FFFF and nothing can rely on another value; match it.
    this.v = 0xFFFF;
  }

  // (CPU6809.mark) the 6309's own registers too, the divide-by-zero mark its trap timing reads, and the native-mode
  // savings an instruction adds up as it goes (postInstruction clears them, which a step taken back never reached)
  mark() {
    super.mark();
    const p = this.pre;
    p[12] = this.e; p[13] = this.f; p[14] = this.v; p[15] = this.md;
    this._pre6309 = [this._mameDivZero, this._postSave, this._ownSave, this._key, this._opKey];
  }
  rewind() {
    super.rewind();
    const p = this.pre;
    this.e = p[12]; this.f = p[13]; this.v = p[14]; this.md = p[15];
    [this._mameDivZero, this._postSave, this._ownSave, this._key, this._opKey] = this._pre6309;
  }

  saveState() { return Object.assign(super.saveState(), state.save(this, CPU6309.EXTRA_STATE)); }
  loadState(s) { super.loadState(s); state.load(this, s, CPU6309.EXTRA_STATE); }

  // ---- register file shared with TFR/EXG and the inter-register instructions ----
  // 0 D, 1 X, 2 Y, 3 U, 4 S, 5 PC, 6 W, 7 V, 8 A, 9 B, A CC, B DP, C 0, D 0, E E, F F
  getReg6309(code) {
    switch (code) {
      case 0x6: return this.w;
      case 0x7: return this.v;
      case 0xE: return this.e;
      case 0xF: return this.f;
      case 0xC: case 0xD: return 0;         // the zero register
      default: return super.getReg(code);
    }
  }
  setReg6309(code, v) {
    switch (code) {
      case 0x6: this.w = v & 0xFFFF; break;
      case 0x7: this.v = v & 0xFFFF; break;
      case 0xE: this.e = v & 0xFF; break;
      case 0xF: this.f = v & 0xFF; break;
      case 0xC: case 0xD: break;            // writes to the zero register are discarded
      default: super.setReg(code, v);
    }
  }
  // TFR/EXG value rule, measured on MAME 0.289's m6309 and matching its read_exgtfr_register/
  // write_exgtfr_register (hd6309.cpp): a 16-bit source is read whole; an 8-bit source is REPLICATED to
  // both bytes (A=$12 -> $1212). A 16-bit value written to an 8-bit register takes the HIGH byte for
  // A, E and DP and the LOW byte for B, F and CC. The zero register is 16-bit, so TFR 0,D clears D and
  // TFR D,0 writes nowhere.
  xferVal6309(src, dstCode) {
    const wide = (c) => (c < 8) || c === 12 || c === 13;      // D X Y U S PC W V 0 are 16-bit
    const v = this.getReg6309(src);
    return wide(src) ? (v & 0xFFFF) : ((v & 0xFF) << 8 | (v & 0xFF));
  }
  // write one half of a transfer; the high byte for A/E/DP, the low byte for B/F/CC, whole for 16-bit.
  setXfer6309(code, v) {
    if (code === 8 || code === 11 || code === 14) this.setReg6309(code, (v >> 8) & 0xFF);
    else this.setReg6309(code, v & 0xFFFF);
  }

  // ---- native mode: the interrupt stack gains E and F, and every instruction is faster ----
  pushAll() {
    if (!this.native) { super.pushAll(); return; }
    // CC, A, B, E, F, DP, X, Y, U, PC (reference guide p. 3)
    this.pushS16(this.pc); this.pushS16(this.u); this.pushS16(this.y); this.pushS16(this.x);
    this.pushS8(this.dp); this.pushS8(this.f); this.pushS8(this.e);
    this.pushS8(this.b); this.pushS8(this.a); this.pushS8(this.cc);
  }

  // Timing. Every handler logs its emulation-mode bus sequence and sets `c` to the emulation-mode cycle
  // count. padInternal() fills the log up to `c` with internal cycles (MULD's 28 cycles are 4 bus cycles and
  // 24 internal ones), exactly as the 6809 logs MUL's 9 internal cycles. Native mode is then shorter by a
  // stated number of cycles, which the hardware achieves by running that many internal cycles as part of the
  // instruction: dropInternal() takes them off the log and off `c`, so cycleCount stays the true bus
  // sequence and the machines that time every cycle (sam.js, coco3.js) see the native-mode sequence.
  //
  // With cpu.mameCompat (the machines set it from config.mameCompat) the hardware count is then replaced
  // by MAME 0.289's, so a lockstep comparison can run strict: mameTiming() applies the measured delta for
  // the instruction and its mode on top of the hardware result. The product default is the hardware.
  postInstruction() {
    const key = this._key, own = this._ownSave, post = this._postSave, opKey = this._opKey;
    this._key = ''; this._ownSave = 0; this._postSave = 0; this._opKey = '';
    this.padInternal();
    const save = this.native ? own + post + (NATIVE_SAVE[key] || 0) : 0;
    if (save > 0) { this.dropInternal(save); this.compact(); }
    else if (save < 0) {                 // SWI/SWI2/SWI3 run 2 cycles longer in native mode
      this.c -= save;                    // (save is negative, so this adds the cycles)
      this.padInternal();
    }
    if (this.mameCompat) this.mameTiming(opKey);
  }
  // a 6309-only handler that set its own emulation-mode count: `save` is its native saving
  ownTiming(save = 0) { this._key = ''; this._ownSave = save; }

  // Where MAME 0.289's m6309 core charges a different number of cycles from the hardware, keyed by the
  // opcode and the mode ('E' emulation, 'N' native). Each value is ours - MAME, measured instruction by
  // instruction with tools/mame-diff/6309/sweep.asm on local MAME 0.289 (the sweep runs every 6309-only
  // instruction in every addressing mode in both modes); the comment on each group is the cause, read from
  // MAME's own source (hd6309.cpp, hd6309.lst, base6x09.lst at mame0289).
  // Consulted only with cpu.mameCompat. The hardware figure (Atkinson / the data book) stays the default.
  // The divide-by-zero case is in MAME_DELTA_DIVZERO below, because there the delta depends on the operand.
  mameTiming(key) {
    const k = `${key}/${this.native ? 'N' : 'E'}`;
    const div0 = this._mameDivZero ? MAME_DELTA_DIVZERO[k] : undefined;
    this._mameDivZero = 0;
    const d = div0 !== undefined ? div0 : (MAME_DELTA[k] || 0);
    if (!d) return;
    // d is ours - MAME. A positive d means MAME runs the instruction in fewer cycles, so that many
    // internal cycles are dropped (compact() takes them off both the log and c); a negative d means MAME
    // runs it longer, so the log is padded with internal cycles up to the new count.
    if (d > 0) { this.droppedInternal = 0; this.dropInternal(d); this.compact(); }
    else {
      this.c -= d;                        // MAME's count is the larger one
      this.padInternal();
    }
  }

  // ---- the illegal-instruction trap ----
  // An undefined opcode sets MD bit 6, stacks the machine state and jumps through the illegal-instruction
  // vector at $FFF0/$FFF1, the same sequence a divide by zero uses [Atkinson p. 59; guide p. 7]. The
  // The opcode's own fetch is already logged; trap() adds the interrupt sequence. The illegal path
  // charges ILLEGAL_SEQUENCE (18), one less than the divide path's DIVIDE_SEQUENCE (19); the 19 this
  // comment used to give came from the 6809's SWI, which is a different instruction.
  undefinedOp() { this.trap(0x40, ILLEGAL_SEQUENCE); }
  undefinedPrefixed() { this.trap(0x40, ILLEGAL_SEQUENCE); }

  // ---- interrupts: MD bit 1 makes FIRQ behave as IRQ ----
  // With MD bit 1 (FM) set, "the FIRQ will operate the same as the IRQ": it stacks the entire state,
  // native mode included (CC A B E F DP X Y U PC), instead of just CC and PC [guide "Modes of the Fast
  // Interrupt Request (FIRQ)" p. 4; Atkinson p. 34, MD bit 1]. It still vectors through $FFF6 and still
  // sets F, and its cycle count is IRQ's (19, or 10 with the fast path's two-byte frame) because the push
  // is the only difference. The whole-state flag in the frame is CC.E, which pushAll sets in native mode.
  checkInterrupts() {
    if (!this.firqAsIrq || !this.firqLine || (this.cc & F_F)) return super.checkInterrupts();
    // an NMI or IRQ that is also pending takes precedence, exactly as the parent orders them
    if ((this.nmiPending && this.nmiArmed) || (this.irqLine && !(this.cc & I_F))) return super.checkInterrupts();
    const fromCwai = this.cwai, fromSync = this.syncing;
    this.syncing = false;
    if (this.cwai) this.cwai = false;
    else { this.dpc(); this.dpc(); this.vma(1); this.cc |= E_F; this.pushAll(); }
    this.cc |= F_F | I_F;
    this.vma(1); this.pc = this.read16(0xFFF6); this.vma(1);
    // CWAI_ENTRY=4 for the vector fetch; otherwise the IRQ-length sequence. A SYNC released by the interrupt
    // adds the cycle its wait ends with (base6x09.lst SYNC: @eat(1)), as the parent's paths do.
    return (fromCwai ? 4 : 19) + (fromSync ? 1 : 0);
  }

  // ---- indexed addressing: the 6309's own post bytes and its cheaper native forms ----
  // The 6809's post bytes are the parent's (indexedPost); native mode is cheaper on several of them, and the
  // 6309 adds post bytes of its own, decoded here. Every mode logs its emulation-mode bus sequence and
  // charges its emulation cost; the native cost goes into _postSave. Both columns are Lindner's tables in
  // "Addendum to The 6309 Book" (Appendix A, A-12a..d), which Atkinson's Indexed Addressing Mode Table
  // (p. 150) agrees with on every form it lists.
  indexedPost(pb) {
    if (!(pb & 0x80)) return super.indexedPost(pb);        // 5-bit offset: 1 cycle in both modes
    const k = POST6309_MODE[pb];
    if (k) return this.post6309(pb, k);
    if (this.native) this._postSave += POST6809_SAVE[pb & 0x1F] || 0;
    return super.indexedPost(pb);
  }
  // one of the 6309's post bytes. `k` is its mode name; it starts with 'i' for the indirect forms. Each
  // handler logs its real accesses and dummy cycles and charges the emulation cost.
  post6309(pb, k) {
    const r = this.getIdxReg((pb >> 5) & 3), ind = k[0] === 'i', mode = ind ? k.slice(1) : k;
    const em = POST6309_EM[k];
    if (this.native) this._postSave += em - POST6309_NM[k];
    this.c += em;                                          // the mode's emulation cost
    // the pointer the indirect form reads; its cycles are part of `em`, so only log the read
    const deref = (ea) => this.read16(ea & 0xFFFF);
    switch (mode) {
      case 'E': case 'F': {                                // E,R 1/1   F,R 1/1   [E,R] 4/4   [F,R] 4/4
        const ea = (r + (((mode === 'E' ? this.e : this.f) ^ 0x80) - 0x80)) & 0xFFFF;
        this.vma(1);
        return ind ? deref(ea) : ea;
      }
      case 'W': {                                          // W,R 4/1   [W,R] 7/4
        const ea = (r + this.w) & 0xFFFF;
        this.dpc(); this.dpc(1); this.vma(3);
        return ind ? deref(ea) : ea;
      }
      case 'n': return ind ? deref(this.w) : this.w;       // ,W 0/0   [,W] 3/3
      case 'nW': {                                         // n,W 5/2  [n,W] 5/5
        const o = this.fetch16(), ea = (this.w + o) & 0xFFFF;
        this.vma(ind ? 2 : 4);
        return ind ? deref(ea) : ea;
      }
      case 'W++': {                                        // ,W++ 3/1 [,W++] 4/4
        const w = this.w; this.w = (w + 2) & 0xFFFF; this.dpc(); this.vma(ind ? 2 : 3);
        return ind ? deref(w) : w;
      }
      case '--W': {                                        // ,--W 3/1 [,--W] 4/4
        this.w = (this.w - 2) & 0xFFFF; this.dpc(); this.vma(ind ? 2 : 3);
        return ind ? deref(this.w) : this.w;
      }
      default: throw new Error(`post6309: unknown mode ${k}`);
    }
  }

  // ---- decode: page 1 additions (bit operations on memory) ----
  exec(op) {
    this._key = this._opKey = op.toString(16).toUpperCase().padStart(2, '0');
    // An opcode the 6309 has no instruction for traps through $FFF0. The 6809 core is looser (its unary and
    // ALU rows run some undefined low nibbles as NOPs), so the guard is here rather than in the parent.
    if (!LEGAL1[op]) { this.undefinedOp(); return; }
    // AIM/OIM/EIM/TIM: [opcode][mask][operand] — opcodes 01 02 05 0B and their indexed/extended forms
    const bitOp = BITOP_PAGE1[op];
    if (bitOp) { this.bitOpMemory(op, bitOp); return; }
    // LDQ #imm shares the page-1 row with LDD: LDD is CC, LDQ is CD (mnemonic table p. 22:
    // "LDQ | CD 5 5 | 10 8/7 3 | 10 8+ 3+ | 10 9/8 4")
    if (op === 0xCD) {
      // LDQ #imm: 5 cycles in both modes. N and Z follow the 32-bit result [Atkinson p.94].
      this.c = 5; this.ownTiming();       // 5 in both modes [S CD 5/5/5]
      this.q = ((this.fetch16() << 16) | this.fetch16()) >>> 0;
      this.cc = (this.cc & ~(N_F | Z_F)) | (this.q & 0x80000000 ? N_F : 0) | (this.q ? 0 : Z_F);
      return;
    }
    // SEXW is page 1, opcode 14 (data sheet Table 9: "14 SEXW Inherent 4 4 1"): sign-extend W into D.
    // 4 cycles in both modes [Sock's chart 14 4/4/3 1; guide p.27].
    if (op === 0x14) { this.c = 4; this.ownTiming(); this.dpc(); this.sexw(); return; }
    // TFR/EXG are decoded here rather than in the parent because the 6309's transfer rules differ: an
    // 8-bit source is replicated to both bytes and a 16-bit-to-8-bit write takes the high byte (measured
    // on MAME's m6309; see xferVal6309). Native mode saves 2 cycles on each [Sock 1F 6/4/4, 1E 8/5/5].
    if (op === 0x1F || op === 0x1E) { this.tfrExg(op === 0x1F); return; }
    // RTI: in native mode the entire-state frame has E and F as well, between DP and B
    // [guide p. 2, register stacking order: CC A B E F DP X Y U PC; Atkinson p. 1503 "RTI 3B 15/17"].
    if (op === 0x3B) { this.rti6309(); return; }
    // CWAI is 22 cycles on a 6309 in emulation mode and 20 in native mode [Atkinson p. 1470; Sock
    // "3C 22/20"; the guide's Table 9 "22 (20)"]. Native mode stacks two more bytes (E and F), so the
    // longer frame is inside the emulation figure: log 22, and native drops the 2 internal cycles that
    // pay for the extra push. The parent's 20-cycle CWAI (which MAME's m6809 also takes) is its 6809 rule.
    if (op === 0x3C) { this.cwai6309(); return; }
    super.exec(op);
  }
  // RTI in native mode pops CC A B E F DP X Y U PC (12 bytes) and takes 17 cycles; emulation mode is the
  // parent's 6/15 [guide p. 2; Atkinson p. 1503 "3B 15/17"; Sock "RTI 6/6" is the emulation figure]. The
  // frame is decided by the CC.E bit of the frame being restored, and a native-mode interrupt sets E.
  rti6309() {
    this.c = 6;
    this.dpc();
    this.cc = this.pullS8();
    if (this.cc & E_F) {
      if (this.native) {
        this.c = 17;
        this.a = this.pullS8(); this.b = this.pullS8(); this.e = this.pullS8(); this.f = this.pullS8();
        this.dp = this.pullS8(); this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
      } else {
        this.c = 15;
        this.a = this.pullS8(); this.b = this.pullS8(); this.dp = this.pullS8();
        this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
      }
    }
    this.pc = this.pullS16();
    this.addr(this.s);
    this.ownTiming();
    while (this.cycleCount < this.c) this.vma(1);
  }
  cwai6309() {
    // 22 emulation / 20 native [Atkinson p. 1470; Sock "3C 22/20"; guide Table 9 "22 (20)"]. Native mode
    // stacks two more bytes (E and F), which it pays for out of its shorter instruction: the emulation frame
    // is 10 pushed bytes and 12 idle cycles, the native one 12 bytes and 4. Both are logged as they happen,
    // so `c` is final for the mode and postInstruction() has nothing to adjust.
    //
    // MAME 0.289 charges CWAI 16 (base6x09.lst: the mask fetch, a dummy read, a dummy VMA and the 12 pushes)
    // and then 4 more for the vector fetch, which it takes as INTERRUPT_VECTOR on the next step, so its CWAI
    // plus entry is 20. Its CWAI does none of the idle time this one does. Under config.mameCompat the count
    // is MAME's 16 and the wait is not charged here at all; the vector fetch is the entry step's 4, and the
    // time spent waiting is passed over, exactly as MAME's eat_remaining() covers it. Applying that as an
    // ordinary MAME_DELTA cannot work: the 6 cycles are 4 internal ones plus 2 that were never logged, and
    // dropInternal() can only take away cycles that are in the log.
    this.cc &= this.fetch8();
    this.dpc(); this.vma(1);
    this.cc |= E_F; this.pushAll(); this.cwai = true;
    if (this.mameCompat) {
      this.c = this.cycleCount;      // MAME's 16 for this instruction; the log already holds them
      this.ownTiming();
      return;
    }
    this.c = this.native ? 20 : 22;
    this.ownTiming();
    while (this.cycleCount < this.c) this.vma(1);
  }

  // SEXW: D = sign extension of W. N follows bit 15 of W, Z is set only when both D and W are zero
  // (reference guide p. 7; MAME's hd6309.lst SEXW: keeps V and C).
  sexw() {
    const w = this.w;
    this.d = w & 0x8000 ? 0xFFFF : 0x0000;
    this.cc = (this.cc & ~(N_F | Z_F)) | (w & 0x8000 ? N_F : 0) | (this.d === 0 && w === 0 ? Z_F : 0);
  }

  // TFR (isTfr) / EXG: [1F|1E][(r0<<4)|r1]
  tfrExg(isTfr) {
    this.c = isTfr ? 6 : 8; this.ownTiming(isTfr ? 2 : 3);   // TFR 6/4, EXG 8/5 [S 1F 6/4 1E 8/5]
    const pb = this.fetch8(), r0 = pb >> 4, r1 = pb & 0x0F;
    this.noStop();
    this.vma(isTfr ? 4 : 6);
    const v0 = this.xferVal6309(r0, r1);
    if (isTfr) { this.setXfer6309(r1, v0); return; }
    const v1 = this.xferVal6309(r1, r0);
    this.setXfer6309(r1, v0); this.setXfer6309(r0, v1);
  }

  // ---- page 2 (0x10 prefix) ----
  // Only the opcodes in LEGAL2 exist; any other second byte is an illegal instruction and traps. The ones
  // this core does not decode itself (long branches, SWI2, CMPD/CMPY/LDY/STY/LDS/STS) are the parent's.
  execPage2(op) {
    this._key = this._opKey = '10' + op.toString(16).toUpperCase().padStart(2, '0');
    // NEGW, ASRW and ASLW ($1050/$1057/$1058) are not instructions the part has: Atkinson's opcode map
    // leaves those cells blank (printed p. 152) and its instruction pages say so in words (NEG p. 101,
    // ASRD p. 18, ASLD p. 16), and an undefined opcode takes the Illegal Instruction exception (p. 153,
    // note 4). So by default they trap. MAME 0.289 runs them as the W forms of NEG/ASR/ASL at 3 cycles, and
    // the lockstep compares against MAME, so under config.mameCompat they keep doing that.
    if (MAME_ONLY_W_UNARY.has(op)) {
      if (this.mameCompat) { this.unaryD(op); return; }
      this.undefinedPrefixed(); return;
    }
    if (!LEGAL2[op]) { this.undefinedPrefixed(); return; }
    if (this.page2(op)) return;
    super.execPage2(op);
  }

  // ---- page 3 (0x11 prefix) ----
  execPage3(op) {
    this._key = this._opKey = '11' + op.toString(16).toUpperCase().padStart(2, '0');
    if (!LEGAL3[op]) { this.undefinedPrefixed(); return; }
    if (this.page3(op)) return;
    super.execPage3(op);
  }

  // ---- helpers shared by the new instructions ----
  // effective address for a direct/indexed/extended operand (mode 1/2/3), with the base cycles
  eaModed(mode) { return mode === 1 ? this.dir() : mode === 2 ? this.indexed() : this.ext(); }

  // condition code setting for the 8/16-bit register operations (N,Z from the result, V cleared)
  ldFlags(v, wide) {
    if (wide) { this.cc = (this.cc & ~(N_F | Z_F | V_F)) | (v & 0x8000 ? N_F : 0) | ((v & 0xFFFF) ? 0 : Z_F); }
    else { this.cc = (this.cc & ~(N_F | Z_F | V_F)) | (v & 0x80 ? N_F : 0) | ((v & 0xFF) ? 0 : Z_F); }
  }

  // ---- the bit operations on memory (AIM, OIM, EIM, TIM) ----
  // [opcode][immediate mask][operand]; N and Z are set from the result (TIM from the AND only).
  bitOpMemory(op, kind) {
    // direct opcodes are 0x0x, indexed 0x6x, extended 0x7x; the addressing mode is encoded in the high
    // nibble (0, 6, 7), not in the 6809's 2-bit mode field.
    const hi = op >> 4;
    const mode = hi === 0 ? 0 : hi === 6 ? 1 : 3;
    const mask = this.fetch8();
    let ea;
    this.c = mode === 0 ? 6 : 7; this.ownTiming(mode === 0 ? 0 : 1);   // 6 direct, 7 indexed/ext [S 6/6, 7+/7+]
    if (mode === 0) { ea = (this.dp << 8) | this.fetch8(); }
    else if (mode === 1) { ea = this.indexed(); }
    else { ea = this.fetch16(); }             // extended: no dummy after the address (7 cycles, Sock)
    const m = this.read8(ea);
    let r;
    switch (kind) {
      case 'A': r = m & mask; break;
      case 'O': r = m | mask; break;
      case 'E': r = m ^ mask; break;
      default: r = m & mask; break;            // TIM: test only
    }
    this.cc = (this.cc & ~(N_F | Z_F | V_F)) | (r & 0x80 ? N_F : 0) | (r ? 0 : Z_F);
    if (kind === 'T') { this.vma(1); return; }  // no write
    this.vma(1);
    this.write8(ea, r);
  }

  // ---- page 2 instructions ----
  page2(op) {
    const m = (op >> 4) & 3;                  // 0 immediate, 1 direct, 2 indexed, 3 extended
    const lo = op & 0x0F;
    // ADDR, ADCR, SUBR, SBCR, ANDR, ORR, EORR, CMPR (0x30..0x37): [10][op][postbyte]
    if (op >= 0x30 && op <= 0x37) { this.interReg(op); return true; }
    // PSHSW/PULSW/PSHUW/PULUW (0x38..0x3B)
    if (op >= 0x38 && op <= 0x3B) { this.pushPullW(op); return true; }
    // D-register unary ops 0x40..0x5F
    if (op >= 0x40 && op < 0x60) { this.unaryD(op); return true; }
    // W-register unary ops 0x50..0x5F are shared with the D block above by low nibble; handled there
    // 16-bit operands: 0x80..0xBF, but only W/LDQ/LDE/LDF families and CMPD/CMPY/CMPX/CMPU/CMPS
    if (op >= 0x80) { return this.page2Wide(op, m, lo); }
    return false;
  }

  // ADDR &c.: postbyte = (r0 << 4) | r1, result into r1 (reference guide p. 4)
  // A register's size for the inter-register rules: D X Y U S PC W V are 16-bit; A B CC DP E F are 8-bit.
  isWideReg6309(c) { return c < 8 || c === 12 || c === 13; }

  // Inter-register ops (ADDR..CMPR): postbyte = (r0 << 4) | r1, result into r1 [G p.4].
  // When one operand is 8-bit and the other 16-bit, MAME's register_register_op "promotes" BOTH: an 8-bit
  // register is widened to the 16-bit register that contains it (A/B -> D, E/F -> W, CC/DP/0 -> the zero
  // temp), the operation runs at 16 bits, and the result goes to that 16-bit register. That is the rule
  // measured on MAME 0.289 (ANDR D,B with D=$00F0, B=$0F leaves B alone and clears D), and the guide
  // describes it as "mixed-size inter-register operations default to using identical sized register"
  // (p.4). Without promotion the destination keeps its own width.
  interReg(op) {
    this.c = 4; this.ownTiming();      // 4 in both modes [S 10 30 4/4/3]
    const pb = this.fetch8();
    this.noStop();
    this.vma(1);
    const r0 = pb >> 4, r1 = pb & 0x0F;
    const promote = this.isWideReg6309(r0) !== this.isWideReg6309(r1);
    // the destination register (and its size) after promotion
    const dst = promote ? { 8: 0, 9: 0, 0xA: 0xC, 0xB: 0xC, 0xE: 6, 0xF: 6 }[r1] ?? r1 : r1;
    const wide = promote || this.isWideReg6309(r1);
    const a = this.promotedReg6309(r0, promote), b = this.promotedReg6309(r1, promote);
    // Operand order: r1' <- r1 OP r0, destination plus source [Atkinson p.47 "r1' <- r1 + r0"; measured
    // on MAME 0.289: ADDR X,Y with X=$0100, Y=$0002 leaves Y=$0102, SUBR X,Y leaves Y=$FF02].
    let res;
    switch (op) {
      case 0x30: res = b + a; break;                                   // ADDR
      case 0x31: res = b + a + (this.cc & C_F ? 1 : 0); break;         // ADCR
      case 0x32: res = b - a; break;                                   // SUBR
      case 0x33: res = b - a - (this.cc & C_F ? 1 : 0); break;         // SBCR
      case 0x34: res = b & a; break;                                   // ANDR
      case 0x35: res = b | a; break;                                   // ORR
      case 0x36: res = b ^ a; break;                                   // EORR
      default: res = b - a; break;                                     // CMPR (flags only)
    }
    if (op === 0x37) {                       // CMPR: flags only
      this.subFlags6309(res, wide);
      return;
    }
    this.setReg6309(dst, res & (wide ? 0xFFFF : 0xFF));
    // ADDR/ADCR/SUBR/SBCR run through the add/subtract flag rules, which set H for the 8-bit forms;
    // ANDR/ORR/EORR are logical and clear H. (MAME's changelog records "Fixed ADDR and ADCR opcodes not
    // to clear the H condition code", i.e. the arithmetic forms keep H.)
    if (op === 0x34 || op === 0x35 || op === 0x36) {
      this.ldFlags(res, wide);              // N/Z from the result, V cleared, H untouched here
      if (!wide) this.cc &= ~H_F;
    } else {
      // flags take (minuend/addend, operand): the destination is r1
      this.addSubFlags6309(b, a, res, wide, op === 0x32 || op === 0x33);
    }
  }
  // the value of register `code` widened for a promoted operation: an 8-bit register contributes the
  // whole 16-bit register that contains it (A/B -> D, E/F -> W, CC/DP/0 -> zero)
  promotedReg6309(code, promote) {
    if (!promote) return this.getReg6309(code);
    switch (code) {
      case 8: case 9: return this.d;                 // A, B -> D
      case 0xE: case 0xF: return this.w;             // E, F -> W
      case 0xA: case 0xB: case 0xC: case 0xD: return 0;
      default: return this.getReg6309(code);
    }
  }

  // flags after an inter-register add/subtract (H, N, Z, V, C as for the memory forms)
  // flags after an inter-register add/subtract (H, N, Z, V, C as for the memory forms). `isSub` says
  // whether the operation was a subtraction (SUBR/SBCR/CMPR); it is passed rather than read from the
  // opcode key, because a handler that set its own cycle count has already cleared the key.
  addSubFlags6309(a, b, res, wide, isSub) {
    const sign = wide ? 0x8000 : 0x80, top = wide ? 0x10000 : 0x100;
    const mask = top - 1;
    const rr = res & mask;
    let cc = this.cc & ~(N_F | Z_F | V_F | C_F);
    if (!wide) cc &= ~H_F;
    if (isSub) {
      if (rr & sign) cc |= N_F;
      if (!rr) cc |= Z_F;
      if (((a ^ b) & (a ^ rr) & sign)) cc |= V_F;
      if (res < 0) cc |= C_F;
    } else {
      if (rr & sign) cc |= N_F;
      if (!rr) cc |= Z_F;
      if ((a ^ rr) & (b ^ rr) & sign) cc |= V_F;
      if (res & top) cc |= C_F;
      if (!wide && ((a ^ b ^ rr) & 0x10)) cc |= H_F;
    }
    this.cc = cc;
  }
  subFlags6309(res, wide) {
    const sign = wide ? 0x8000 : 0x80, top = wide ? 0x10000 : 0x100, mask = top - 1;
    const rr = res & mask;
    let cc = this.cc & ~(N_F | Z_F | V_F | C_F);
    if (rr & sign) cc |= N_F;
    if (!rr) cc |= Z_F;
    if (res < 0) cc |= C_F;
    this.cc = cc;
  }

  pushPullW(op) {
    this.c = 6; this.ownTiming();
    if (op === 0x38) { this.pushS16(this.w); this.addr(this.s); }          // PSHSW
    else if (op === 0x39) { this.w = this.pullS16(); this.addr(this.s); }  // PULSW
    else if (op === 0x3A) { this.pushU16(this.w); this.addr(this.u); }     // PSHUW
    else { this.w = this.pullU16(); this.addr(this.u); }                   // PULUW
  }

  // D-register unary ops: NEGD COMD LSRD RORD ASRD ASLD ROLD DECD INCD TSTD CLRD, and the W forms
  unaryD(op) {
    const isW = (op >> 4) === 5;              // 0x5x operates on W
    const lo = op & 0x0F;
    this.c = 3; this.ownTiming(1);                     // [S 10 3/2]
    this.dpc();
    const v = isW ? this.w : this.d;
    const r = this.unary6309(lo, v, true);      // D and W are both 16-bit
    if (r >= 0) { if (isW) this.w = r; else this.d = r; }
  }

  // the 16-bit unary operations, by low nibble, matching the 8-bit table
  unary6309(lo, v, wide) {
    const sign = wide ? 0x8000 : 0x80, top = wide ? 0x10000 : 0x100, mask = top - 1;
    let r;
    switch (lo) {
      case 0x0: r = (-v) & mask; this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | (v === sign ? V_F : 0) | (v ? C_F : 0); this.nzW(r, wide); return r;
      // COM: V is always cleared and C always set [Atkinson "COM (accumulator)", printed p. 53: "V The Overflow flag is always cleared";
      // the 8-bit path above does the same, and MAME's COM8 (base6x09.lst) clears V then sets C]
      case 0x3: r = (~v) & mask; this.cc = (this.cc & ~(N_F | Z_F | V_F)) | C_F; this.nzW(r, wide); return r;
      case 0x4: r = v >> 1; this.cc = (this.cc & ~(N_F | Z_F | C_F)) | (v & 1 ? C_F : 0) | (r ? 0 : Z_F); return r;
      case 0x6: r = (v >> 1) | (this.cc & C_F ? sign : 0);
        this.cc = (this.cc & ~C_F) | (v & 1 ? C_F : 0); this.nzW(r, wide); return r;
      case 0x7: r = (v >> 1) | (v & sign); this.cc = (this.cc & ~C_F) | (v & 1 ? C_F : 0); this.nzW(r, wide); return r;
      case 0x8: r = (v << 1) & mask;
        this.cc = (this.cc & ~(V_F | C_F)) | (v & sign ? C_F : 0) | ((v ^ (v << 1)) & sign ? V_F : 0); this.nzW(r, wide); return r;
      case 0x9: r = ((v << 1) | (this.cc & C_F)) & mask;
        // ROL: C receives bit 15, V is bits 14 XOR 15 of the original [Atkinson p.4338]. MAME's ROL16 runs
        // rotate_left() through set_flags(CC_NZV, new, new, new), whose V term
        // (a ^ b ^ r ^ (r >> 1)) & 0x8000 is (r >> 1) & 0x8000 once a = b = r, i.e. bit 14 of the result --
        // and the result's bit 14 is an AND of the original bits 13 and 14, which makes the term 0 for
        // every value. So MAME always clears V here, where the hardware sets it for bit14 ^ bit15.
        this.cc = (this.cc & ~(V_F | C_F)) | (v & sign ? C_F : 0) |
          (this.mameCompat && wide ? 0 : ((v ^ (v << 1)) & sign ? V_F : 0));
        this.nzW(r, wide); return r;
      case 0xA: r = (v - 1) & mask;
        // DEC leaves C alone on the hardware [Atkinson p.130]; MAME's DEC16 sets it from the borrow
        this.cc = this.mameCompat && wide ? (this.cc & ~(V_F | C_F)) | (v === sign ? V_F : 0) | (v ? 0 : C_F)
          : (this.cc & ~V_F) | (v === sign ? V_F : 0);
        this.nzW(r, wide); return r;
      case 0xC: r = (v + 1) & mask;
        // INC likewise: the hardware leaves C, MAME's INC16 sets it from the carry
        this.cc = this.mameCompat && wide ? (this.cc & ~(V_F | C_F)) | (v === (sign - 1) ? V_F : 0) | (r ? 0 : C_F)
          : (this.cc & ~V_F) | (v === (sign - 1) ? V_F : 0);
        this.nzW(r, wide); return r;
      case 0xD: this.cc = this.cc & ~V_F; this.nzW(v, wide); return -1;   // TSTD/TSTW: V always cleared
      case 0xF: this.cc = (this.cc & ~(N_F | V_F | C_F)) | Z_F; return 0; // CLRD/CLRW
    }
    return -1;
  }
  nzW(r, wide) {
    if (wide) { this.cc = (this.cc & ~(N_F | Z_F)) | (r & 0x8000 ? N_F : 0) | (r ? 0 : Z_F); }
    else { this.cc = (this.cc & ~(N_F | Z_F)) | (r & 0x80 ? N_F : 0) | (r ? 0 : Z_F); }
  }

  // 0x80..0xBF on page 2. The 0x8x row mixes registers by low nibble (data sheet Table 9, pp. 29-30):
  //   0 SUBW  1 CMPW  2 SBCD(D)  3 CMPD  4 ANDD(D)  5 BITD(D)  6 LDW  7 STW
  //   8 EORD(D)  9 ADCD(D)  A ORD(D)  B ADDW  C CMPY  E LDY  F STY
  // Cycles per addressing mode, emulation / native, from the guide's Table 9 (pp. 28-29) and Sock's chart.
  // One table per instruction family; [mode] = 0 immediate, 1 direct, 2 indexed, 3 extended.
  static get CYC() {
    return CPU6309._cyc || (CPU6309._cyc = {
      ldq:     { em: [0, 8, 8, 9], nm: [0, 7, 8, 8] },     // indexed 8+ is 8 for the bare postbyte
      ldw:     { em: [4, 6, 6, 7], nm: [4, 5, 6, 6] },
      stw:     { em: [4, 6, 6, 7], nm: [4, 5, 6, 6] },
      addw:    { em: [5, 7, 7, 8], nm: [4, 5, 6, 6] },      // SUBW/ADDW/CMPW/SBCD/ADCD/ORD/EORD/ANDD/BITD
      lde:     { em: [3, 5, 5, 6], nm: [3, 4, 5, 5] },      // LDE/STE/LDF/STF/SUBE/CMPE/ADDE/SUBF/CMPF/ADDF
      bitmem:  { em: [6, 7, 7, 7], nm: [6, 6, 6, 6] },      // AIM/OIM/EIM/TIM
    });
  }

  // ---- page 2 wide operands ----
  page2Wide(op, m, lo) {
    const T = CPU6309.CYC;
    const ea16 = () => this.eaModed(m);
    const cyc = (t) => { this.c = t.em[m]; this.ownTiming(t.em[m] - t.nm[m]); };
    // LDQ/STQ: N from bit 31 of Q, Z when Q is zero, V always cleared, C unaffected [Atkinson pp.94, 130]
    if (op === 0xDC || op === 0xEC || op === 0xFC) {
      cyc(T.ldq); this.q = this.load32(ea16()); this.ldqFlags(); return true;
    }
    if (op === 0xDD || op === 0xED || op === 0xFD) {
      cyc(T.ldq); this.store32(ea16(), this.q); this.ldqFlags(); return true;
    }
    // the W family (0 SUBW, 1 CMPW, 6 LDW, 7 STW, B ADDW)
    if (lo === 0x0 || lo === 0x1 || lo === 0x6 || lo === 0x7 || lo === 0xB) {
      if (lo === 0x6) { cyc(T.ldw); this.w = this.ld16(m === 0 ? this.fetch16() : this.read16(ea16())); return true; }
      if (lo === 0x7 && m) { cyc(T.stw); this.write16(ea16(), this.ld16(this.w)); return true; }
      cyc(T.addw);
      const v = m === 0 ? this.fetch16() : this.read16(ea16());
      if (lo === 0x0) this.w = this.sub16(this.w, v);
      else if (lo === 0x1) this.sub16(this.w, v);
      else this.w = this.add16(this.w, v);
      return true;
    }
    // the D family (2 SBCD, 4 ANDD, 5 BITD, 8 EORD, 9 ADCD, A ORD)
    if (lo === 0x2 || lo === 0x4 || lo === 0x5 || lo === 0x8 || lo === 0x9 || lo === 0xA) {
      cyc(T.addw);
      const v = m === 0 ? this.fetch16() : this.read16(ea16());
      switch (lo) {
        case 0x2: this.d = this.sub16(this.d, v + (this.cc & C_F ? 1 : 0)); break;
        case 0x4: this.d = this.ld16(this.d & v); break;
        case 0x5: this.ld16(this.d & v); break;
        case 0x8: this.d = this.ld16(this.d ^ v); break;
        case 0x9: this.d = this.add16(this.d, v + (this.cc & C_F ? 1 : 0)); break;
        case 0xA: this.d = this.ld16(this.d | v); break;
      }
      return true;
    }
    return false;   // CMPD/CMPY/LDY/STY stay with the parent (6809 encodings)
  }

  load32(ea) { const hi = this.read16(ea); return ((hi << 16) | this.read16(ea + 2)) >>> 0; }
  store32(ea, v) { this.write16(ea, (v >>> 16) & 0xFFFF); this.write16(ea + 2, v & 0xFFFF); }
  // the flags LDQ/STQ and LDQ #imm set: N from bit 31 of Q, Z when Q is zero, V cleared, C unaffected
  // [Atkinson pp.94, 130]
  ldqFlags() {
    const q = this.q;
    this.cc = (this.cc & ~(N_F | Z_F | V_F)) | (q & 0x80000000 ? N_F : 0) | (q ? 0 : Z_F);
  }

  // ---- page 3 (0x11 prefix) ----
  page3(op) {
    // bit transfers/manipulation on memory: 0x30..0x37 [11][op][postbyte][direct]
    if (op >= 0x30 && op <= 0x37) { this.bitMemory(op); return true; }
    // TFM: 0x38..0x3B
    if (op >= 0x38 && op <= 0x3B) { this.tfm(op); return true; }
    if (op === 0x3C) { this.c = 4; this.ownTiming(); this.bitmd(); return true; }   // BITMD #imm, 4 both
    if (op === 0x3D) { this.c = 5; this.ownTiming(); this.ldmd(); return true; }   // LDMD 5 in both [A p.1557]
    // E/F register unary ops
    if (op >= 0x40 && op < 0x60) { this.unaryEF(op); return true; }
    // E/F/W arithmetic and the new math, plus LDE/STE/LDF/STF (0x80..0xBF, 0xC0..0xFF)
    return this.page3Wide(op);
  }

  // BITMD #mask: a plain 8-bit AND of the MD register with the immediate, setting H, N, Z and V from
  // the result like BITB/BITA (MAME's hd6309.lst encodes it as `set_regop8(m_md); set_imm(); %BIT8`,
  // and its changelog records "Fixed BITMD opcode to only effect the Z condition code" as a correction
  // to an older implementation). 4 cycles in both modes [Sock 11 4/4/3].
  // MD bits 6 and 7 are NOT cleared: MAME 0.289 leaves them, despite Atkinson's prose on printed p.33
  // saying it clears what it tested. His formula on that line is OCR-damaged (the overbar that would make it
  // a clear is missing), so prose and formula contradict each other and the hardware is unmeasured: sources
  // inconclusive; follows MAME 0.289, in both modes, with no mameCompat split.
  // Measured, with MD set up before the instruction: BITMD #$40 with MD=$40 leaves $40, and with MD=$C0
  // leaves $C0 (the sweep's 0.289 trace at 8AB8, where both registers agree instruction by instruction --
  // the lockstep compares MD, so this is not inferred from one instruction). The bits therefore accumulate
  // across exceptions: by the sweep's second trap both are set, which is why the trap handler composes both
  // BITMD results instead of treating the first hit as the kind.
  bitmd() { this.ld8(this.md & this.fetch8()); }   // ld8 sets N/Z/V; H is left alone

  // LDMD writes bits 0-1 only; bits 2-7 (the /0 and IL trap flags) keep their value [Atkinson p.144].
  ldmd() {
    const v = this.fetch8();
    // The hardware writes bits 0-1 and leaves the rest alone, and changes no condition code flags
    // [Atkinson p.144]. MAME's dispatch runs LDMD as set_regop8(m_md) + LD8: the whole byte is replaced
    // (so bits 2-7, the trap flags, are cleared) and N, Z and V are set from it.
    if (this.mameCompat) { this.md = v; this.ld8(v); return; }
    this.md = (this.md & 0xFC) | (v & 0x03);
  }

  // TFM: [11][38..3B][postbyte], postbyte = (source << 4) | destination
  // Which pointer moves is the whole difference between the four forms [Atkinson printed p.136 gives the
  // instruction; the names "Block Move Incrementing" 38, "Block Move Decrementing" 39, "Block Write to
  // address" 3A and "Block Read from address" 3B are in his Programming Aid table, printed p.149, and his
  // opcode map, printed p.152, spells the operands r+,r+ / r-,r- / r+,r / r,r+]: only 39 decrements, and of
  // the two single-pointer forms 3A advances the SOURCE (destination fixed) and 3B advances the DESTINATION
  // (source fixed). The reference guide's prose on its Page 6 garbles these two by saying 3B increments R0,
  // contradicting its own "R1 stays the same" two lines earlier. (The assembler's encoder had the same
  // 3A/3B confusion; it is fixed on cloadm-10-6309-disasm.)
  tfm(op) {
    const pb = this.fetch8();
    const srcCode = pb >> 4, dstCode = pb & 0x0F;
    // 38 walks both up; 39 walks both down; 3A walks the source up and parks the destination;
    // 3B walks the destination up and parks the source
    const srcMoves = op !== 0x3B, dstMoves = op !== 0x3A, dec = op === 0x39;
    let src = this.getReg6309(srcCode) & 0xFFFF;
    let dst = this.getReg6309(dstCode) & 0xFFFF;
    const count = this.w;
    this.c = 6 + 3 * count; this.ownTiming();   // [S 6+3n both modes]
    this.reserveLog(this.c + 8);                // (its cycles, and the native-mode adjustment's slack)
    for (let i = 0; i < count; i++) {
      this.write8(dst, this.read8(src));
      if (srcMoves) src = dec ? (src - 1) & 0xFFFF : (src + 1) & 0xFFFF;
      if (dstMoves) dst = dec ? (dst - 1) & 0xFFFF : (dst + 1) & 0xFFFF;
    }
    // the pointer registers move only in the forms the instruction increments/decrements
    if (op === 0x38) { this.setReg6309(srcCode, (this.getReg6309(srcCode) + count) & 0xFFFF); this.setReg6309(dstCode, (this.getReg6309(dstCode) + count) & 0xFFFF); }
    else if (op === 0x39) { this.setReg6309(srcCode, (this.getReg6309(srcCode) - count) & 0xFFFF); this.setReg6309(dstCode, (this.getReg6309(dstCode) - count) & 0xFFFF); }
    else if (op === 0x3A) { this.setReg6309(srcCode, (this.getReg6309(srcCode) + count) & 0xFFFF); }
    else { this.setReg6309(dstCode, (this.getReg6309(dstCode) + count) & 0xFFFF); }
    this.w = 0;
  }

  unaryEF(op) {
    const isF = (op >> 4) === 5;
    const lo = op & 0x0F;
    this.c = 3; this.ownTiming(1);                     // [S 11 3/2]
    this.dpc();
    const v = isF ? this.f : this.e;
    const r = this.unary6309(lo, v, false);
    if (r >= 0) { if (isF) this.f = r; else this.e = r; }
  }

  // page 3, 0x80..0xFF: the E bank (0x80..0xBF) and the F bank (0xC0..0xFF). The two banks do not share a
  // row: only the E bank has the 16-bit U/S compares and the whole DIV/MULD group, and only the F bank's
  // 8-bit group exists at all. Decoding by low nibble alone would accept opcodes the chip treats as illegal,
  // so each bank has its own table [MAME hd6309.lst page-3 dispatch; Atkinson pp. 5409-5700].
  page3Wide(op) {
    if (op < 0x80) return false;              // below 0x80 belongs to the 6809 (SWI3 is 0x113F)
    const m = (op >> 4) & 3;
    const lo = op & 0x0F;
    const bank = op >= 0xC0 ? 'F' : 'E';
    const ea = () => this.eaModed(m);
    const kind = (bank === 'E' ? PAGE3_E : PAGE3_F)[lo];
    if (!kind) return false;
    if (bank === 'E' && (op === 0x83 || op === 0x93 || op === 0xA3 || op === 0xB3)) return false; // 6809 CMPU
    if (lo === 0xD || lo === 0xE || lo === 0xF) { return this.newMath(op, kind, m); }
    const acc = bank;
    const get = () => bank === 'F' ? this.f : this.e;
    const set = (v) => { if (bank === 'F') this.f = v; else this.e = v; };
    const T = CPU6309.CYC.lde;
    const cyc = () => { this.c = T.em[m]; this.ownTiming(T.em[m] - T.nm[m]); };
    if (lo === 0x6) { cyc(); set(this.ld8(m === 0 ? this.fetch8() : this.read8(ea()))); return true; }
    if (lo === 0x7) {                        // ST has no immediate form: 0x1187/0x11C7 are illegal
      if (!m) return false;
      cyc(); this.write8(ea(), this.ld8(get())); return true;
    }
    cyc();
    const v = m === 0 ? this.fetch8() : this.read8(ea());
    switch (kind) {
      case 'SUB': set(this.sub8(get(), v, 0)); break;
      case 'CMP': this.sub8(get(), v, 0); break;
      case 'AND': set(this.ld8(get() & v)); break;
      case 'BIT': this.ld8(get() & v); break;
      case 'EOR': set(this.ld8(get() ^ v)); break;
      case 'ADC': set(this.add8(get(), v, this.cc & C_F)); break;
      case 'OR': set(this.ld8(get() | v)); break;
      case 'ADD': set(this.add8(get(), v, 0)); break;
      default: return false;
    }
    return true;
  }

  // DIVD / DIVQ / MULD: [11][8D..BF][operand]. DIVD's operand is ONE byte; DIVQ's and MULD's are two
  // (data sheet Table 10: 118D "3" bytes total, 118E/118F "4"). Cycle counts follow the hardware chart
  // (Sock's 6309 cycle chart, cited by Lindner's addendum): the base figure is the internal execution
  // time, plus one cycle for each negative operand, and the divide instructions change their count again
  // on overflow. MAME's divd()/divq() implement the same model (hd6309.cpp).
  //
  // The indexed forms are written "30+", "27+", "36+" in Atkinson's tables (pp. 101, 59, 60) and
  // "30+", "27+", "36+" in the guide's (11AF, 11AD, 11AE): the plus is the post byte's own cost, which
  // the addressing mode adds. So the operand is decoded FIRST and its cost kept, and the base figure is
  // added to it -- setting `c` afterwards would overwrite the post byte's cycles.
  newMath(op, kind, m) {
    const wide = kind !== 'DIVD';
    const nm = this.native;
    const before = this.c;
    const ea = m === 0 ? null : this.eaModed(m);
    const post = this.c - before;                 // the indexed post byte's cost (0 for direct/extended)
    if (kind === 'MULD') {
      const v = m === 0 ? this.fetch16() : this.read16(ea);
      this.c = post + (m === 0 ? 28 : (nm ? [0, 29, 29, 30][m] : [0, 30, 30, 31][m]));   // [A p.101; G p.29]
      this.ownTiming();
      const r = ((this.d | 0) * ((v << 16) >> 16)) | 0;   // signed 16x16
      this.q = r >>> 0;
      this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | (r & 0x80000000 ? N_F : 0) | (r ? 0 : Z_F);
      return true;
    }
    const v = m === 0 ? (wide ? this.fetch16() : this.fetch8()) : (wide ? this.read16(ea) : this.read8(ea));
    if (kind === 'DIVD') {
      // DIVD: quotient in B, remainder in A -- the result lands in D and W is untouched [Atkinson pp.59;
      // MAME hd6309.cpp divd(): "m_q.r.a = remainder; m_q.r.b = quotient"]. The guide's prose ("quotient in
      // W and the modulo in D", p.7) is the DIVQ rule, misstated for DIVD.
      // Cycles: 25 immediate / 27 direct / 27+ indexed / 28 extended in emulation, one fewer in native
      // [Atkinson p.59; Sock 25/25, 27/26, 28/27].
      this.c = post + (m === 0 ? 25 : (nm ? [0, 26, 27, 27][m] : [0, 27, 27, 28][m]));
      const divisor = (v << 24) >> 24;                    // signed 8-bit
      if (!divisor) { this._mameDivZero = 1; this.trap(0x80, DIVIDE_SEQUENCE); return true; }   // divide by zero
      const dividend = (this.d << 16) >> 16;              // signed 16-bit
      const quo = (dividend / divisor) | 0;
      const rem = dividend % divisor;
      if (quo > 0x7F || quo < -0x80) {
        // range overflow: the accumulators are left unmodified; V set, N/Z/C cleared, 13 fewer cycles
        this.c -= 13;
        this.ownTiming();
        this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | V_F;
        return true;
      }
      this.a = rem & 0xFF; this.b = quo & 0xFF;
      // one extra cycle for each negative operand; the two's-complement overflow case is one fewer
      if (dividend < 0) this.c++;
      if (divisor < 0) this.c++;
      // a two's-complement overflow means the sign of the quotient is wrong: N and V both set
      const twos = (quo < 0) !== ((dividend < 0) !== (divisor < 0));
      if (twos) this.c--;
      this.ownTiming();
      this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | (quo & 0x80 ? N_F : 0) | (quo ? 0 : Z_F) |
        (twos ? V_F : 0) | (quo & 1 ? C_F : 0);           // C is the quotient's bit 0 [Atkinson p.59]
      return true;
    }
    // DIVQ: signed 32 by 16, quotient in W and remainder in D [Atkinson p.60].
    // Cycles 34 immediate / 36 / 36+ / 37 in emulation, one fewer in native [Atkinson p.60; Sock 34/34].
    this.c = post + (m === 0 ? 34 : (nm ? [0, 35, 36, 36][m] : [0, 36, 36, 37][m]));
    const divisor = (v << 16) >> 16;
    if (!divisor) { this._mameDivZero = 1; this.trap(0x80, DIVIDE_SEQUENCE); return true; }
    const dividend = (this.q | 0);
    const quo = (dividend / divisor) | 0;
    const rem = dividend % divisor;
    if (quo > 0x7FFF || quo < -0x8000) {
      // range overflow: accumulators unmodified, V set, N/Z/C cleared, 21 fewer cycles [Atkinson p.60]
      this.c -= 21;
      this.ownTiming();
      this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | V_F;
      return true;
    }
    this.w = quo & 0xFFFF; this.d = rem & 0xFFFF;
    if (dividend < 0) this.c++;
    if (divisor < 0) this.c++;
    this.ownTiming();
    this.cc = (this.cc & ~(N_F | Z_F | V_F | C_F)) | (quo & 0x8000 ? N_F : 0) | (quo ? 0 : Z_F) |
      (quo & 1 ? C_F : 0);                                // C is the quotient's bit 0 [Atkinson p.60]
    return true;
  }

  // ---- bit transfers/manipulation on memory (BAND..STBT), 0x11 0x30..0x37 ----
  // Postbyte [Atkinson p.20]: bits 7-6 the register (00 CC, 01 A, 10 B, 11 invalid), bits 5-3 the SOURCE
  // bit, which is the MEMORY bit, bits 2-0 the DESTINATION bit, which is the REGISTER bit. The operation
  // writes the register's destination bit: r.dstBit' <- r.dstBit OP mem.srcBit. STBT is the reverse: it
  // copies the register bit into the memory bit. No condition code flags are affected (except that using
  // CC as the register of course changes CC itself).
  bitMemory(op) {
    const pb = this.fetch8();
    const reg = (pb >> 6) & 3;        // 0 CC, 1 A, 2 B, 3 invalid
    const srcBit = (pb >> 3) & 7;     // the memory bit
    const dstBit = pb & 7;            // the register bit
    const dir = this.fetch8();
    const ea = (this.dp << 8) | dir;
    this.c = 7; this.ownTiming(1);                     // BAND..LDBT 7/6 [Atkinson p.20; S 1130 7/6/5]
    this.vma(1);
    const mem = this.read8(ea);
    const getAcc = () => (reg === 0 ? this.cc : reg === 1 ? this.a : this.b);
    const setAcc = (v) => { if (reg === 0) this.cc = v & 0xFF; else if (reg === 1) this.a = v & 0xFF; else this.b = v & 0xFF; };
    const acc = getAcc();
    const accBit = (acc >> dstBit) & 1;      // the register's destination bit
    const memBit = (mem >> srcBit) & 1;      // the memory's source bit
    let r;
    switch (op) {
      case 0x30: r = accBit & memBit; break;              // BAND
      case 0x31: r = accBit & (memBit ^ 1); break;        // BIAND
      case 0x32: r = accBit | memBit; break;              // BOR
      case 0x33: r = accBit | (memBit ^ 1); break;        // BIOR
      case 0x34: r = accBit ^ memBit; break;              // BEOR
      case 0x35: r = accBit ^ (memBit ^ 1); break;        // BIEOR
      case 0x36: r = memBit; break;                       // LDBT: register bit <- memory bit
      case 0x37: {                                        // STBT: M8.dstBit = R.srcBit [Atkinson p.148]
        // for STBT the roles reverse: the register bit is the SOURCE (postbyte bits 2-0) and the memory
        // bit is the DESTINATION (bits 5-3)
        this.c = 8; this.ownTiming(1);                  // STBT 8/7 [Atkinson p.148]
        const rBit = (acc >> dstBit) & 1;
        const out = rBit ? mem | (1 << srcBit) : mem & ~(1 << srcBit);
        this.write8(ea, out);
        this.cc = (this.cc & ~(N_F | Z_F)) | (out & 0x80 ? N_F : 0) | (out ? 0 : Z_F);   // N,Z only
        return;
      }
      default: return;
    }
    setAcc(r ? acc | (1 << dstBit) : acc & ~(1 << dstBit));
  }

  // ---- error traps ----
  // The trap sequence's cost after the opcode's own fetch: the dummy cycles, the whole-state push and the
  // vector fetch. MAME charges an undefined page-1 opcode 19 cycles in total and a prefixed one 20, i.e.
  // 18 here plus the 1 or 2 bytes of opcode already logged. No primary source gives the figure (Atkinson
  // printed p. 149 has SWI/SWI2/SWI3 and no trap row; its prose pp. 59-60 and the guide's p. 7 describe the
  // sequence without one), so the default follows MAME, per AGENTS 4.6. The 19 this used to charge came
  // from the 6809's SWI, which is a different instruction: SWI3, which shares this vector and push, is 20
  // in both emulators, and a divide by zero, which takes this same trap, is 44 in both - so the difference
  // was the illegal path's own overhead, not the sequence.
  // Measured with tools/mame-diff/6309/illegal-probe.js.
  // The trap sets the matching MD bit, stacks the machine state and jumps through $FFF0/$FFF1 [Atkinson
  // p.59: "set bit 7 in the MD register, stack the machine state and jump to the address taken from the
  // Illegal Instruction vector at $FFF0"]. The stack push and the vector fetch take bus cycles, so they are
  // charged to the instruction that trapped: with the state already stacked (pushAll writes the bytes) the
  // cost is the dummy cycles a software interrupt spends, which the 6809 charges as 19 per SWI. The divide
  // instructions charge their own internal cycles on top, as MAME's divd()/divq() do (their eat() runs
  // before the trap).
  trap(mdBit, sequence) {
    this.md |= mdBit;
    // A divide (which has already charged its own cycles into `c`) traps after its internal time; an
    // undefined opcode has charged nothing but its fetch, which is in the log. Either way the caller's
    // `sequence` (ILLEGAL_SEQUENCE 18 or DIVIDE_SEQUENCE 19) is what the interrupt adds, and the log is
    // padded to the final count.
    if (!this.c) this.c = this.cycleCount;
    this.cc |= E_F;
    this.dpc(); this.vma(1);          // the cycles a software interrupt spends before the push
    this.pushAll();
    // The trap leaves I and F as they were, following MAME, whose illegal-instruction and divide-by-zero
    // traps go through SOFTWARE_INTERRUPT -- the SWI2/SWI3 path, which (unlike its SWI) never sets them.
    // No source states what the hardware does here: Atkinson p.59 and the guide describe the stacking and
    // the $FFF0 vector but not CC, and the data book has no 6309 trap section (its TRAP sections are the
    // HD6303X/HD6303Y, vector $FFEE). Masking both, as NMI/FIRQ/IRQ/SWI do, is a plausible alternative and
    // is not verified; with no primary source for it, MAME -- the reference -- decides (AGENTS 4.6).
    this.vma(1); this.pc = this.read16(0xFFF0); this.vma(1);
    this.c += sequence;
    this.padInternal();
    if (this.c < this.cycleCount) this.c = this.cycleCount;
  }
}

// page-1 bit ops: opcode -> 'A' (AIM), 'O' (OIM), 'E' (EIM), 'T' (TIM)
const BITOP_PAGE1 = {
  0x01: 'O', 0x02: 'A', 0x05: 'E', 0x0B: 'T',
  0x61: 'O', 0x62: 'A', 0x65: 'E', 0x6B: 'T',
  0x71: 'O', 0x72: 'A', 0x75: 'E', 0x7B: 'T',
};

// page 3 by bank and low nibble [MAME hd6309.lst page-3 dispatch]: the E bank has the 16-bit compares,
// LDE/STE and the divide/multiply group; the F bank has its 8-bit operations only.
// The opcodes page 2 and page 3 decode [MAME hd6309.lst page-2/page-3 dispatch]. A 0x10/0x11 prefix
// with any other second byte is an illegal instruction on a 6309 and traps through $FFF0, so the core
// only claims a page-2/page-3 opcode that is in these sets and lets the rest fall through to the trap.
// The opcodes page 1 decodes on a 6309 [MAME hd6309.lst page-1 dispatch]. The 6809 core is more
// permissive (its unary and ALU rows accept some undefined low nibbles as NOPs); on a 6309 the same
// opcodes are illegal and trap.
const LEGAL1 = { 0x00: 1, 0x01: 1, 0x02: 1, 0x03: 1, 0x04: 1, 0x05: 1, 0x06: 1, 0x07: 1, 0x08: 1, 0x09: 1, 0x0A: 1, 0x0B: 1, 0x0C: 1, 0x0D: 1, 0x0E: 1, 0x0F: 1, 0x10: 1, 0x11: 1, 0x12: 1, 0x13: 1, 0x14: 1, 0x16: 1, 0x17: 1, 0x19: 1, 0x1A: 1, 0x1C: 1, 0x1D: 1, 0x1E: 1, 0x1F: 1, 0x20: 1, 0x21: 1, 0x22: 1, 0x23: 1, 0x24: 1, 0x25: 1, 0x26: 1, 0x27: 1, 0x28: 1, 0x29: 1, 0x2A: 1, 0x2B: 1, 0x2C: 1, 0x2D: 1, 0x2E: 1, 0x2F: 1, 0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 1, 0x35: 1, 0x36: 1, 0x37: 1, 0x39: 1, 0x3A: 1, 0x3B: 1, 0x3C: 1, 0x3D: 1, 0x3F: 1, 0x40: 1, 0x43: 1, 0x44: 1, 0x46: 1, 0x47: 1, 0x48: 1, 0x49: 1, 0x4A: 1, 0x4C: 1, 0x4D: 1, 0x4F: 1, 0x50: 1, 0x53: 1, 0x54: 1, 0x56: 1, 0x57: 1, 0x58: 1, 0x59: 1, 0x5A: 1, 0x5C: 1, 0x5D: 1, 0x5F: 1, 0x60: 1, 0x61: 1, 0x62: 1, 0x63: 1, 0x64: 1, 0x65: 1, 0x66: 1, 0x67: 1, 0x68: 1, 0x69: 1, 0x6A: 1, 0x6B: 1, 0x6C: 1, 0x6D: 1, 0x6E: 1, 0x6F: 1, 0x70: 1, 0x71: 1, 0x72: 1, 0x73: 1, 0x74: 1, 0x75: 1, 0x76: 1, 0x77: 1, 0x78: 1, 0x79: 1, 0x7A: 1, 0x7B: 1, 0x7C: 1, 0x7D: 1, 0x7E: 1, 0x7F: 1, 0x80: 1, 0x81: 1, 0x82: 1, 0x83: 1, 0x84: 1, 0x85: 1, 0x86: 1, 0x88: 1, 0x89: 1, 0x8A: 1, 0x8B: 1, 0x8C: 1, 0x8D: 1, 0x8E: 1, 0x90: 1, 0x91: 1, 0x92: 1, 0x93: 1, 0x94: 1, 0x95: 1, 0x96: 1, 0x97: 1, 0x98: 1, 0x99: 1, 0x9A: 1, 0x9B: 1, 0x9C: 1, 0x9D: 1, 0x9E: 1, 0x9F: 1, 0xA0: 1, 0xA1: 1, 0xA2: 1, 0xA3: 1, 0xA4: 1, 0xA5: 1, 0xA6: 1, 0xA7: 1, 0xA8: 1, 0xA9: 1, 0xAA: 1, 0xAB: 1, 0xAC: 1, 0xAD: 1, 0xAE: 1, 0xAF: 1, 0xB0: 1, 0xB1: 1, 0xB2: 1, 0xB3: 1, 0xB4: 1, 0xB5: 1, 0xB6: 1, 0xB7: 1, 0xB8: 1, 0xB9: 1, 0xBA: 1, 0xBB: 1, 0xBC: 1, 0xBD: 1, 0xBE: 1, 0xBF: 1, 0xC0: 1, 0xC1: 1, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1, 0xC8: 1, 0xC9: 1, 0xCA: 1, 0xCB: 1, 0xCC: 1, 0xCD: 1, 0xCE: 1, 0xD0: 1, 0xD1: 1, 0xD2: 1, 0xD3: 1, 0xD4: 1, 0xD5: 1, 0xD6: 1, 0xD7: 1, 0xD8: 1, 0xD9: 1, 0xDA: 1, 0xDB: 1, 0xDC: 1, 0xDD: 1, 0xDE: 1, 0xDF: 1, 0xE0: 1, 0xE1: 1, 0xE2: 1, 0xE3: 1, 0xE4: 1, 0xE5: 1, 0xE6: 1, 0xE7: 1, 0xE8: 1, 0xE9: 1, 0xEA: 1, 0xEB: 1, 0xEC: 1, 0xED: 1, 0xEE: 1, 0xEF: 1, 0xF0: 1, 0xF1: 1, 0xF2: 1, 0xF3: 1, 0xF4: 1, 0xF5: 1, 0xF6: 1, 0xF7: 1, 0xF8: 1, 0xF9: 1, 0xFA: 1, 0xFB: 1, 0xFC: 1, 0xFD: 1, 0xFE: 1, 0xFF: 1 };
const LEGAL2 = { 0x21: 1, 0x22: 1, 0x23: 1, 0x24: 1, 0x25: 1, 0x26: 1, 0x27: 1, 0x28: 1, 0x29: 1, 0x2A: 1, 0x2B: 1, 0x2C: 1, 0x2D: 1, 0x2E: 1, 0x2F: 1, 0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 1, 0x35: 1, 0x36: 1, 0x37: 1, 0x38: 1, 0x39: 1, 0x3A: 1, 0x3B: 1, 0x3F: 1, 0x40: 1, 0x43: 1, 0x44: 1, 0x46: 1, 0x47: 1, 0x48: 1, 0x49: 1, 0x4A: 1, 0x4C: 1, 0x4D: 1, 0x4F: 1, 0x53: 1, 0x54: 1, 0x56: 1, 0x59: 1, 0x5A: 1, 0x5C: 1, 0x5D: 1, 0x5F: 1, 0x80: 1, 0x81: 1, 0x82: 1, 0x83: 1, 0x84: 1, 0x85: 1, 0x86: 1, 0x88: 1, 0x89: 1, 0x8A: 1, 0x8B: 1, 0x8C: 1, 0x8E: 1, 0x90: 1, 0x91: 1, 0x92: 1, 0x93: 1, 0x94: 1, 0x95: 1, 0x96: 1, 0x97: 1, 0x98: 1, 0x99: 1, 0x9A: 1, 0x9B: 1, 0x9C: 1, 0x9E: 1, 0x9F: 1, 0xA0: 1, 0xA1: 1, 0xA2: 1, 0xA3: 1, 0xA4: 1, 0xA5: 1, 0xA6: 1, 0xA7: 1, 0xA8: 1, 0xA9: 1, 0xAA: 1, 0xAB: 1, 0xAC: 1, 0xAE: 1, 0xAF: 1, 0xB0: 1, 0xB1: 1, 0xB2: 1, 0xB3: 1, 0xB4: 1, 0xB5: 1, 0xB6: 1, 0xB7: 1, 0xB8: 1, 0xB9: 1, 0xBA: 1, 0xBB: 1, 0xBC: 1, 0xBE: 1, 0xBF: 1, 0xCE: 1, 0xDC: 1, 0xDD: 1, 0xDE: 1, 0xDF: 1, 0xEC: 1, 0xED: 1, 0xEE: 1, 0xEF: 1, 0xFC: 1, 0xFD: 1, 0xFE: 1, 0xFF: 1 };
// page-2 opcodes the hardware does not have and MAME does; see execPage2
const MAME_ONLY_W_UNARY = new Set([0x50, 0x57, 0x58]);   // NEGW, ASRW, ASLW
// the trap sequence's cycles after the opcode fetch, per caller (see CPU6309.trap). An illegal opcode
// charges 18 after its own 1 or 2 bytes, which makes MAME's 19 and 20. A divide by zero has already
// charged the divide's internal time, and MAME's figure for that is 44 with a 16-bit divide (28) plus the
// same 16 the sequence costs from a divide's starting point, so it keeps 19.
const ILLEGAL_SEQUENCE = 18;
const DIVIDE_SEQUENCE = 19;

const LEGAL3 = { 0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 1, 0x35: 1, 0x36: 1, 0x37: 1, 0x38: 1, 0x39: 1, 0x3A: 1, 0x3B: 1, 0x3C: 1, 0x3D: 1, 0x3F: 1, 0x43: 1, 0x4A: 1, 0x4C: 1, 0x4D: 1, 0x4F: 1, 0x53: 1, 0x5A: 1, 0x5C: 1, 0x5D: 1, 0x5F: 1, 0x80: 1, 0x81: 1, 0x83: 1, 0x86: 1, 0x8B: 1, 0x8C: 1, 0x8D: 1, 0x8E: 1, 0x8F: 1, 0x90: 1, 0x91: 1, 0x93: 1, 0x96: 1, 0x97: 1, 0x9B: 1, 0x9C: 1, 0x9D: 1, 0x9E: 1, 0x9F: 1, 0xA0: 1, 0xA1: 1, 0xA3: 1, 0xA6: 1, 0xA7: 1, 0xAB: 1, 0xAC: 1, 0xAD: 1, 0xAE: 1, 0xAF: 1, 0xB0: 1, 0xB1: 1, 0xB3: 1, 0xB6: 1, 0xB7: 1, 0xBB: 1, 0xBC: 1, 0xBD: 1, 0xBE: 1, 0xBF: 1, 0xC0: 1, 0xC1: 1, 0xC6: 1, 0xCB: 1, 0xD0: 1, 0xD1: 1, 0xD6: 1, 0xD7: 1, 0xDB: 1, 0xE0: 1, 0xE1: 1, 0xE6: 1, 0xE7: 1, 0xEB: 1, 0xF0: 1, 0xF1: 1, 0xF6: 1, 0xF7: 1, 0xFB: 1 };
const PAGE3_E = { 0x0: 'SUB', 0x1: 'CMP', 0x3: 'CMPU', 0x4: 'AND', 0x5: 'BIT', 0x6: 'LD', 0x7: 'ST',
  0x8: 'EOR', 0x9: 'ADC', 0xA: 'OR', 0xB: 'ADD', 0xD: 'DIVD', 0xE: 'DIVQ', 0xF: 'MULD' };const PAGE3_F = { 0x0: 'SUB', 0x1: 'CMP', 0x6: 'LD', 0x7: 'ST', 0xB: 'ADD' };

// ---- the 6309's indexed post bytes [Lindner, Addendum to The 6309 Book, Appendix A, tables A-12a..d] ----
// The mode of each, by post byte. E,R / F,R / W,R and their indirect forms exist for X, Y, U and S; the ,W
// family (8F AF CF EF and 90 B0 D0 F0) has no index register.
const POST6309_MODE = {};
for (const [low, mode] of [[0x7, 'E'], [0xA, 'F'], [0xE, 'W']]) {
  for (let rc = 0; rc < 4; rc++) {
    POST6309_MODE[0x80 | (rc << 5) | low] = mode;
    POST6309_MODE[0x90 | (rc << 5) | low] = `i${mode}`;
  }
}
POST6309_MODE[0x8F] = 'n';   POST6309_MODE[0xAF] = 'nW';   POST6309_MODE[0xCF] = 'W++';   POST6309_MODE[0xEF] = '--W';
POST6309_MODE[0x90] = 'in';  POST6309_MODE[0xB0] = 'inW';  POST6309_MODE[0xD0] = 'iW++';  POST6309_MODE[0xF0] = 'i--W';
// emulation / native cost of each mode, the cycles beyond the instruction's own base
//   E,R 1/1   F,R 1/1   W,R 4/1   [E,R] 4/4  [F,R] 4/4  [W,R] 7/4
//   ,W 0/0    n,W 5/2   ,W++ 3/1  ,--W 3/1   [,W] 3/3   [n,W] 5/5  [,W++] 4/4  [,--W] 4/4
const POST6309_EM = { E: 1, F: 1, W: 4, n: 0, nW: 5, 'W++': 3, '--W': 3, iE: 4, iF: 4, iW: 7, in: 3, inW: 5, 'iW++': 4, 'i--W': 4 };
const POST6309_NM = { E: 1, F: 1, W: 1, n: 0, nW: 2, 'W++': 1, '--W': 1, iE: 4, iF: 4, iW: 4, in: 3, inW: 5, 'iW++': 4, 'i--W': 4 };
// the 6809 post bytes whose native count is lower than the emulation count the parent logs:
//   ,R+ 2/1  ,R++ 3/2  ,-R 2/1  ,--R 3/2  nn,R 4/3  D,R 4/2  nn,PCR 5/3  [nn,PCR] 8/6
const POST6809_SAVE = { 0x00: 1, 0x01: 1, 0x02: 1, 0x03: 1, 0x09: 1, 0x0B: 2, 0x0D: 2, 0x11: 1, 0x13: 1, 0x1B: 2, 0x1D: 2 };

// ---- MAME 0.289 compatibility (cpu.mameCompat only; the product default is the hardware above) ----
// Every value is ours - MAME, measured instruction by instruction on local MAME 0.289 with
// tools/mame-diff/6309/sweep.asm, which runs each 6309-only instruction in every addressing mode in both
// modes. The comment on each group is the cause, read from MAME's own source at mame0289 (hd6309.cpp,
// hd6309.lst, base6x09.lst). Keys are "<opcode>/<E|N>": E emulation mode, N native.
const MAME_DELTA = {
  // Every entry's cause is a statement in MAME 0.289's source at src/devices/cpu/m6809/; each group names
  // the one that makes the figure differ, so it can be re-checked without re-measuring. The value is
  // OURS - MAME, measured with tools/mame-diff/6309/sweep.asm.

  // AIM/OIM/EIM/TIM on page 1 (and behind a 0x10 prefix): hd6309.lst's page-1 dispatch charges these with
  // an `eat()` call, one cycle more than the data book's figure. The same handler covers 0x01/0x02/0x05/
  // 0x0B/0x72 and their 0x1030-family forms.
  '01/E': -1, '02/E': -1, '05/E': -1, '0B/E': -1, '72/E': -1,
  '1030/E': -1, '1032/E': -1, '1037/E': -1, '1039/E': -1, '103B/E': -1,

  // MULD/DIVD/DIVQ are the only 6309 instructions MAME times with a computed target, not a fixed eat():
  // hd6309.cpp muld() charges no cycles of its own (muld() does no eat at all, so its 4 cycles are the two
  // operand fetches), and divd()/divq() start from a base (divq: "24 native, 25 emulation" in its own
  // comment) and add or subtract a cycle per sign fix-up and per overflow. The data book gives a fixed
  // 28/30/31 and 25+/27+/34+/36+ instead, so the two disagree by a figure that depends on the operands.
  // The sweep uses operands with no sign fix-ups, so these are the deltas at that operand.
  '118F/E': 24, '118F/N': 24,      // MULD, MAME's 4 against the data book's 28 (and 28-2 native)
  '119F/E': 24, '119F/N': 24,      // MULD direct/indexed
  '11AF/E': 24, '11AF/N': 23,      // MULD extended
  '11BF/E': 24, '11BF/N': 24,      // MULD indexed
  '118D/E': -3, '118D/N': -2,      // DIVD / DIVQ, MAME's base 25/24 against the data book's 25/34...
  '118E/E': 5,  '118E/N': 6,       // ...and 34/36, whose "+" the data book adds to a shorter base
  '119D/E': -3, '119D/N': -2,
  '119E/E': 5,  '119E/N': 6,
  '11AD/E': -3, '11AD/N': -2,
  '11AE/E': 5,  '11AE/N': 6,
  '11BD/E': -3, '11BD/N': -2,
  '11BE/E': 5,  '11BE/N': 6,

  // SEXW: hd6309.lst dispatches 0x14 straight to %SEXW with no eat() at all, and SEXW itself only sets the
  // flags, so MAME charges the one opcode fetch. The data book gives 4, hence 3 in both modes.
  '14/E': 3, '14/N': 3,

  // The remaining 0x10/0x11-prefixed forms: MAME's page-2 and page-3 dispatch (hd6309.lst, the
  // `case 0x00..0x7B` blocks around the indexed-postbyte handler) times each family with its own eat(),
  // and these are the ones where that figure differs from the data book's, in the direction of the sign.
  '1084/E': 1, '1088/E': 1, '108A/E': 1, '1094/E': 1, '10A4/E': 1, '10A8/E': 1, '10BA/E': 1,
  '1130/E': -3, '1131/E': -3, '1132/E': -3, '1133/E': -3, '1134/E': -3, '1135/E': -3, '1136/E': -3,
  '1137/E': -1,
  '113C/E': 1,
  '113D/E': 2, '113D/N': 2,
  '1C/N': 1,

  // The 8-bit read-modify-write family on memory, in NATIVE mode and in EVERY memory mode. Atkinson gives
  // each of these 6/5 direct, 6+ indexed and 7/6 extended, on its own page: NEG p. 103, COM p. 54, LSR p. 98,
  // ROR p. 118, ASR p. 18, ASL p. 16, ROL p. 116. This core follows the table. MAME charges one cycle less in
  // native mode for those seven in all three modes, so each opcode needs its own entry: the direct opcode is
  // the 0x0n base, the indexed form is base+0x20 and the extended form base+0x30 (Atkinson's own table rows
  // give them, e.g. NEG "00 6/5 2 | 60 6+ 2+ | 70 7/6 3").
  //
  // DEC (p. 58), INC (p. 68), CLR (p. 49) are the same 6/5 in that table and MAME also charges 5, so they
  // AGREE and must have no entry; TST (p. 141) is 6/4 direct, 6+ indexed and 7/5 extended, and MAME agrees
  // there too. The sweep runs all eleven instructions in all three memory modes, so an entry on an agreeing
  // instruction, or a missing one on a differing mode, fails the lockstep immediately.
  '00/N': 1, '60/N': 1, '70/N': 1,   // NEG   direct / indexed / extended
  '03/N': 1, '63/N': 1, '73/N': 1,   // COM
  '04/N': 1, '64/N': 1, '74/N': 1,   // LSR
  '06/N': 1, '66/N': 1, '76/N': 1,   // ROR
  '07/N': 1, '67/N': 1, '77/N': 1,   // ASR
  '08/N': 1, '68/N': 1, '78/N': 1,   // ASL
  '09/N': 1, '69/N': 1, '79/N': 1,   // ROL
};
// The divide-by-zero case, where MAME's eat() total does not follow the same rule as a real divide: the
// sweep's DIVD #$00 reaches this. Measured separately because the same opcode has a different delta after it.
const MAME_DELTA_DIVZERO = { '118D/E': 0 };

CPU6309.FLAGS = CPU6809.FLAGS;
CPU6309.EXTRA_STATE = ['e', 'f', 'v', 'md'];
CPU6309.STATE = CPU6809.STATE.concat(CPU6309.EXTRA_STATE);
CPU6309.NATIVE_SAVE = NATIVE_SAVE;

export { CPU6309 };
