/*
 * HD6309 instruction set plugin for the assembler engine (js/asm/assembler.js).
 * encode(mnemonic, operand, ctx) returns the instruction bytes, or null for an unknown mnemonic.
 *
 * The 6309 keeps the whole 6809 instruction set with the same encodings, so anything the two share is
 * handed straight to isa6809.js; only the 6309-only mnemonics and the wider register set are here.
 * Where a mnemonic exists on both but means something different on the 6309, the 6309 meaning wins:
 *   - TFR/EXG accept W, V, E, F and the zero register as well as the 6809 set;
 *   - PSHS/PULS/PSHU/PULU accept no new names (W is stacked with PSHSW/PULSW, not PSHS W);
 *   - the indexed post-byte gains E, F and W indexed forms (E,X / F,X / W,X / ,W / [,W]);
 *   - LDQ/STQ, the D/W/E/F unary family, TFM, the bit ops and the new math are new.
 *
 * Opcodes and cycles: Hitachi HD63B09E/HD63C09E data sheet, Table 9 (pp. 27-30); HD63B09EP Technical
 * Reference Guide, opcode table (pp. 10-18) and post-byte tables (pp. 24-26).
 */
import { AsmError, splitArgs, noOperand } from './syntax.js';
import { isa6809 } from './isa6809.js';

// ----- 6309-only inherent instructions: [prefix bytes] -----
const INH = {
  SEXW: [0x14],
  NEGD: [0x10, 0x40], COMD: [0x10, 0x43], LSRD: [0x10, 0x44], RORD: [0x10, 0x46],
  ASRD: [0x10, 0x47], ASLD: [0x10, 0x48], LSLD: [0x10, 0x48], ROLD: [0x10, 0x49],
  DECD: [0x10, 0x4A], INCD: [0x10, 0x4C], TSTD: [0x10, 0x4D], CLRD: [0x10, 0x4F],
  COMW: [0x10, 0x53], LSRW: [0x10, 0x54], RORW: [0x10, 0x56], ROLW: [0x10, 0x59],
  DECW: [0x10, 0x5A], INCW: [0x10, 0x5C], TSTW: [0x10, 0x5D], CLRW: [0x10, 0x5F],
  COME: [0x11, 0x43], DECE: [0x11, 0x4A], INCE: [0x11, 0x4C], TSTE: [0x11, 0x4D], CLRE: [0x11, 0x4F],
  COMF: [0x11, 0x53], DECF: [0x11, 0x5A], INCF: [0x11, 0x5C], TSTF: [0x11, 0x5D], CLRF: [0x11, 0x5F],
  PSHSW: [0x10, 0x38], PULSW: [0x10, 0x39], PSHUW: [0x10, 0x3A], PULUW: [0x10, 0x3B],
};
// LDMD and BITMD take an immediate only
const IMM_ONLY = { LDMD: [0x11, 0x3D], BITMD: [0x11, 0x3C] };

// ----- the general operand families, as [prefix, base opcode, wide] keyed by mnemonic -----
// base is the immediate opcode; direct = +0x10, indexed = +0x20, extended = +0x30, exactly as on the 6809.
const GEN = {
  // W accumulator
  SUBW: [[0x10], 0x80, true], CMPW: [[0x10], 0x81, true], SBCD: [[0x10], 0x82, true],
  ANDD: [[0x10], 0x84, true], BITD: [[0x10], 0x85, true], LDW: [[0x10], 0x86, true],
  STW: [[0x10], 0x87, true], EORD: [[0x10], 0x88, true], ADCD: [[0x10], 0x89, true],
  ORD: [[0x10], 0x8A, true], ADDW: [[0x10], 0x8B, true],
  // E accumulator
  SUBE: [[0x11], 0x80, false], CMPE: [[0x11], 0x81, false], LDE: [[0x11], 0x86, false],
  STE: [[0x11], 0x87, false], ADDE: [[0x11], 0x8B, false],
  // F accumulator
  SUBF: [[0x11], 0xC0, false], CMPF: [[0x11], 0xC1, false], LDF: [[0x11], 0xC6, false],
  STF: [[0x11], 0xC7, false], ADDF: [[0x11], 0xCB, false],
  // the new math
  // the new math: DIVD's divisor is ONE byte (data sheet Table 10 "118D DIVD Immed 25 3"; MAME's
  // disassembler table { 0x118D, 1, "DIVD", IMM }); DIVQ and MULD take a full 16-bit operand ("... 4").
  DIVD: [[0x11], 0x8D, false], DIVQ: [[0x11], 0x8E, true], MULD: [[0x11], 0x8F, true],
};
// LDQ/STQ: immediate is a page-1 opcode (CD), the memory forms live on the 0x10 page
const LDQ = { imm: 0xCD, direct: 0xDC, indexed: 0xEC, extended: 0xFC };

const REGCODE6309 = { D: 0, X: 1, Y: 2, U: 3, S: 4, PC: 5, W: 6, V: 7, A: 8, B: 9, CC: 0xA, CCR: 0xA, DP: 0xB, DPR: 0xB, E: 0xE, F: 0xF, ZERO: 0xC, '0': 0xC };

function encode(mn, opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  // the 6309-only inherent set and the immediate-only pair
  if (INH[mn]) { noOperand(mn, opnd); return INH[mn].slice(); }
  if (IMM_ONLY[mn]) {
    if (opnd[0] !== '#') throw new AsmError(mn + ' needs immediate operand');
    return [...IMM_ONLY[mn], ev(opnd.slice(1)).value & 0xFF];
  }
  if (mn === 'LDQ') return encodeLDQ(opnd, ctx);
  if (mn === 'STQ') return encodeSTQ(opnd, ctx);
  if (GEN[mn]) return encodeGen(mn, opnd, ctx);
  if (mn === 'TFM') return encodeTFM(opnd, ctx);
  if (mn === 'ADDR' || mn === 'ADCR' || mn === 'SUBR' || mn === 'SBCR' || mn === 'ANDR' ||
      mn === 'ORR' || mn === 'EORR' || mn === 'CMPR') return encodeInterReg(mn, opnd, ctx);
  // TFR/EXG accept the 6309 registers (W, V, E, F and the zero register) as well as the 6809 set
  // (reference guide p. 4). Any operand naming one of those has to be encoded here; everything else
  // falls through to the 6809 encoder, which produces the same bytes.
  if (mn === 'TFR' || mn === 'EXG') return encodeXfer(mn, opnd, ctx);
  if (BITMEM[mn]) return encodeBitMem(mn, opnd, ctx);
  if (BITIMM[mn]) return encodeBitImm(mn, opnd, ctx);
  // everything the 6809 also has (including TFR/EXG and the indexed modes) goes to the 6809 encoder,
  // but with the 6309's register set available so TFR W,D and EXG E,F assemble.
  return isa6809.encode(mn, opnd, ctx);
}

// ---- general families (SUBE, LDW, DIVD, ...) ----
function encodeGen(mn, opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  const [pfx, op, wide] = GEN[mn];
  if (opnd[0] === '#') {
    const v = ev(opnd.slice(1)).value;
    return wide ? [...pfx, op, (v >> 8) & 0xFF, v & 0xFF] : [...pfx, op, v & 0xFF];
  }
  const ix = indexed6309(opnd, pc + pfx.length + 1, ev, line, pass, hints);
  if (ix) return [...pfx, op + 0x20, ...ix];
  if (opnd[0] === '<') return [...pfx, op + 0x10, ev(opnd.slice(1)).value & 0xFF];
  const a = ev(opnd.replace(/^>/, '')).value;
  return [...pfx, op + 0x30, (a >> 8) & 0xFF, a & 0xFF];
}

// ---- LDQ / STQ ----
function encodeLDQ(opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  if (opnd[0] === '#') { const v = ev(opnd.slice(1)).value; return [LDQ.imm, (v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; }
  const ix = indexed6309(opnd, pc + 2, ev, line, pass, hints);
  if (ix) return [0x10, LDQ.indexed, ...ix];
  if (opnd[0] === '<') return [0x10, LDQ.direct, ev(opnd.slice(1)).value & 0xFF];
  const a = ev(opnd.replace(/^>/, '')).value;
  return [0x10, LDQ.extended, (a >> 8) & 0xFF, a & 0xFF];
}
function encodeSTQ(opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  if (opnd[0] === '#') throw new AsmError('STQ has no immediate mode');
  const ix = indexed6309(opnd, pc + 2, ev, line, pass, hints);
  if (ix) return [0x10, LDQ.indexed + 1, ...ix];
  if (opnd[0] === '<') return [0x10, LDQ.direct + 1, ev(opnd.slice(1)).value & 0xFF];
  const a = ev(opnd.replace(/^>/, '')).value;
  return [0x10, LDQ.extended + 1, (a >> 8) & 0xFF, a & 0xFF];
}

// ---- TFR/EXG: [1F|1E][(r0<<4)|r1] with the full 6309 register file ----
// W (6), V (7) and E/F (E/F) join the 6809 set; codes C and D are the zero register, which is readable
// but drops writes (reference guide pp. 2, 4).
function encodeXfer(mn, opnd, ctx) {
  const rs = splitArgs(opnd).map((r) => r.trim().toUpperCase());
  if (rs.length !== 2) throw new AsmError(mn + ' needs two registers');
  const a = REGCODE6309[rs[0]], b = REGCODE6309[rs[1]];
  if (a === undefined || b === undefined) throw new AsmError('bad registers');
  return [mn === 'TFR' ? 0x1F : 0x1E, (a << 4) | b];
}

// ---- inter-register: [10][30..37][(r0<<4)|r1] ----
const INTER = { ADDR: 0x30, ADCR: 0x31, SUBR: 0x32, SBCR: 0x33, ANDR: 0x34, ORR: 0x35, EORR: 0x36, CMPR: 0x37 };
function encodeInterReg(mn, opnd, ctx) {
  const rs = splitArgs(opnd).map((r) => r.trim().toUpperCase());
  if (rs.length !== 2) throw new AsmError(mn + ' needs two registers');
  const a = REGCODE6309[rs[0]], b = REGCODE6309[rs[1]];
  if (a === undefined || b === undefined) throw new AsmError('bad register for ' + mn + ': ' + opnd);
  return [0x10, INTER[mn], (a << 4) | b];
}

// ---- TFM: [11][38..3B][(from<<4)|to], with + or - on each operand ----
function encodeTFM(opnd, ctx) {
  const parts = splitArgs(opnd).map((s) => s.trim().toUpperCase().replace(/\s+/g, ''));
  if (parts.length !== 2) throw new AsmError('TFM needs two operands, e.g. TFM X+,Y+');
  // R+ / R- move that pointer; a bare R leaves it fixed (guide p. 6: "TFM r0+,r1", "TFM r0,r1+")
  const form = (s) => {
    const m = /^([XYUSD])([+-])?$/.exec(s);
    if (!m) throw new AsmError('TFM operands are R, R+ or R- (X, Y, U, S, D): ' + s);
    return { reg: REGCODE6309[m[1]], dir: m[2] || '' };
  };
  const f = form(parts[0]), t = form(parts[1]);
  // Gate on the DIRECTION PAIR, not on the operand shapes: the instruction set has exactly four, one per
  // opcode, and anything else cannot be expressed [Atkinson printed p.136 lists r0+,r1+ / r0-,r1- / r0+,r1 /
  // r0,r1+ and his Programming Aid table, printed p.149, names them; the guide's p. 6 and its mnemonic table
  // printed p. 25 give the same four]. The previous chain silently mapped everything else onto the nearest
  // arm, so several distinct spellings became a different instruction with no diagnostic:
  //   TFM X,Y    -> 3B (same bytes as TFM X,Y+)      both pointers parked
  //   TFM X+,U-  -> 39 (same bytes as TFM X-,U-)     mixed directions
  //   TFM X-,Y+  -> 39 (same bytes as TFM X-,Y-)     mixed directions
  //   TFM X-,Y   -> 39 (same bytes as TFM X-,Y-)     one-sided minus
  //   TFM X,Y-   -> 39 (same bytes as TFM X-,Y-)     one-sided minus
  // Only '-' is shared by a pair whose two halves differ, and only in 39, where both are '-'.
  // Only four direction pairs exist, one per opcode: both up (38), both down (39), source up and
  // destination parked (3A), destination up and source parked (3B). Keyed on the two direction characters,
  // with 'n' for a bare register, so the lookup is exhaustive by construction.
  const PAIRS = { '++': 0x38, '--': 0x39, '+n': 0x3A, 'n+': 0x3B };
  const op = PAIRS[(f.dir || 'n') + (t.dir || 'n')];
  if (op === undefined) {
    throw new AsmError(`TFM has four forms and no mixed-direction or both-parked one: ${parts[0]},${parts[1]} ` +
      'matches none of TFM R+,R+ / TFM R-,R- / TFM R+,R / TFM R,R+');
  }
  return [0x11, op, (f.reg << 4) | t.reg];
}

// ---- AIM/OIM/EIM/TIM: [opcode][mask][operand], page 1 (data sheet Table 9; guide pp. 4, 25) ----
const BITIMM = { OIM: 0x01, AIM: 0x02, EIM: 0x05, TIM: 0x0B };
function encodeBitImm(mn, opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  const comma = opnd.indexOf(',');
  if (opnd[0] !== '#' || comma < 0) throw new AsmError(mn + ' takes #mask,address');
  const mask = ev(opnd.slice(1, comma)).value & 0xFF;
  const ea = opnd.slice(comma + 1).trim();
  const base = BITIMM[mn];
  const ix = indexed6309(ea, pc + 3, ev, line, pass, hints);
  if (ix) return [base + 0x60, mask, ...ix];
  if (ea[0] === '<') return [base, mask, ev(ea.slice(1)).value & 0xFF];
  const a = ev(ea.replace(/^>/, '')).value;
  return [base + 0x70, mask, (a >> 8) & 0xFF, a & 0xFF];
}

// ---- bit operations on memory: [11][30..37][postbyte][direct] ----
const BITMEM = { BAND: 0x30, BIAND: 0x31, BOR: 0x32, BIOR: 0x33, BEOR: 0x34, BIEOR: 0x35, LDBT: 0x36, STBT: 0x37 };
const BITREG = { CC: 0, CCR: 0, A: 1, B: 2 };
function encodeBitMem(mn, opnd, ctx) {
  const { ev } = ctx;
  // BOR A,1,7,$00  -> register, source bit, destination bit, direct address
  const p = splitArgs(opnd).map((s) => s.trim().toUpperCase());
  if (p.length !== 4) throw new AsmError(mn + ' takes register, source bit, destination bit, address');
  const reg = BITREG[p[0]];
  if (reg === undefined) throw new AsmError(mn + ': register must be CC, A or B');
  const src = Number(ev(p[1]).value) & 7, dst = Number(ev(p[2]).value) & 7;
  const addr = ev(p[3].replace(/^</, '')).value & 0xFF;
  return [0x11, BITMEM[mn], (reg << 6) | (src << 3) | dst, addr];
}

/*
 * The 6309 indexed post-byte gains E, F and W forms. Everything else is the 6809 table, so this
 * delegates to the 6809 encoder unless the operand names one of those registers, and returns null for
 * a non-indexed operand.
 */
function indexed6309(opnd, pcAfterOp, ev, line, pass, hints) {
  const s = opnd.trim();
  if (!/,|\[/.test(s)) return null;
  // W/E/F forms (addendum pp. A-12a..d): E,X (0x87) F,X (0x8A) ,W (0x8F) mmnn,W (0xAF),
  // plus their indirect forms ([...] adds 0x10) and the ,W++ / ,--W auto forms.
  const ind = s.startsWith('[') ? 0x10 : 0;
  const inner = s.replace(/^\[/, '').replace(/\]$/, '').trim().toUpperCase();
  const mW = /^,?(W)(\+\+|--)?$/.exec(inner.replace(/\s+/g, ''));
  if (mW) {
    if (mW[2] === '++') return [0xCF | ind];      // ,W++  (auto-increment W)
    if (mW[2] === '--') return [0xEF | ind];      // ,--W  (auto-decrement W)
    return [0x8F | ind];                          // ,W
  }
  // E,X / F,X / W,X
  const m2 = /^(E|F|W),(X|Y|U|S)$/.exec(inner.replace(/\s+/g, ''));
  if (m2) {
    const rr = { X: 0x00, Y: 0x20, U: 0x40, S: 0x60 }[m2[2]];
    const code = m2[1] === 'E' ? 0x87 : m2[1] === 'F' ? 0x8A : 0x8E;
    return [rr | code | ind];
  }
  // mmnn,W / [mmnn,W]  and  nn,W / [nn,W]
  const mOff = /^(.+),(W)$/.exec(inner.replace(/\s+/g, ''));
  if (mOff) {
    const v = ev(mOff[1]).value;
    return [0xAF | ind, (v >> 8) & 0xFF, v & 0xFF];
  }
  // otherwise the 6809 rules apply unchanged
  return isa6809Indexed(opnd, pcAfterOp, ev, line, pass, hints);
}

// isa6809's indexed() is not exported; reach it through the 6809 encoder's own LEA path by encoding a
// throwaway LEAX and taking the post-byte. That keeps one implementation of the 6809 post-byte rules.
function isa6809Indexed(opnd, pcAfterOp, ev, line, pass, hints) {
  const ctx = { pc: pcAfterOp - 1, ev, pass, line, hints };
  const bytes = isa6809.encode('LEAX', opnd, ctx);
  if (!bytes || bytes[0] !== 0x30) return null;
  return bytes.slice(1);
}

const isa6309 = { name: '6309', encode: (mn, opnd, ctx) => encode(mn.toUpperCase(), opnd.trim(), ctx) };

export { isa6309 };
