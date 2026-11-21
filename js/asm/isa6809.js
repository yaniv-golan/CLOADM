/*
 * 6809 instruction set plugin for the assembler engine (js/asm/assembler.js).
 * encode(mnemonic, operand, ctx) returns the instruction bytes, or null for an unknown mnemonic.
 * ctx: { pc, ev(expr) -> {value, unresolved}, pass, line, hints (Map: per-line size choices) }
 */
import { AsmError, fit, splitArgs, noOperand } from './syntax.js';

const INH = {
  NOP: [0x12], SYNC: [0x13], DAA: [0x19], SEX: [0x1D], RTS: [0x39], ABX: [0x3A], RTI: [0x3B],
  MUL: [0x3D], SWI: [0x3F], SWI2: [0x10, 0x3F], SWI3: [0x11, 0x3F],
};
const RMW = { NEG: 0x0, COM: 0x3, LSR: 0x4, ROR: 0x6, ASR: 0x7, ASL: 0x8, LSL: 0x8, ROL: 0x9, DEC: 0xA, INC: 0xC, TST: 0xD, JMP: 0xE, CLR: 0xF };
for (const [k, v] of Object.entries(RMW)) {
  if (k === 'JMP') continue;
  INH[k + 'A'] = [0x40 | v]; INH[k + 'B'] = [0x50 | v];
}
// general ops: [prefix|null, immediate-opcode, wide, allowImm]
const GEN = {};
const g = (names, base, pre) => names.forEach((n, i) => {
  if (!n) return;
  const [name, wide, noImm] = n;
  GEN[name] = [pre, base + i, !!wide, !noImm];
});
g([['SUBA'], ['CMPA'], ['SBCA'], ['SUBD', 1], ['ANDA'], ['BITA'], ['LDA'], ['STA', 0, 1], ['EORA'], ['ADCA'], ['ORA'], ['ADDA'], ['CMPX', 1], ['JSR', 0, 1], ['LDX', 1], ['STX', 1, 1]], 0x80, null);
g([['SUBB'], ['CMPB'], ['SBCB'], ['ADDD', 1], ['ANDB'], ['BITB'], ['LDB'], ['STB', 0, 1], ['EORB'], ['ADCB'], ['ORB'], ['ADDB'], ['LDD', 1], ['STD', 1, 1], ['LDU', 1], ['STU', 1, 1]], 0xC0, null);
Object.assign(GEN, {
  CMPD: [0x10, 0x83, true, true], CMPY: [0x10, 0x8C, true, true], LDY: [0x10, 0x8E, true, true], STY: [0x10, 0x8F, true, false],
  LDS: [0x10, 0xCE, true, true], STS: [0x10, 0xCF, true, false], CMPU: [0x11, 0x83, true, true], CMPS: [0x11, 0x8C, true, true],
});
const IMM_ONLY = { ORCC: 0x1A, ANDCC: 0x1C, CWAI: 0x3C };
const BR = ['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE'];
const BRANCH = {}, LBRANCH = {};
BR.forEach((n, i) => { BRANCH[n] = 0x20 + i; LBRANCH['L' + n] = [0x10, 0x20 + i]; });
BRANCH.BHS = 0x24; BRANCH.BLO = 0x25; BRANCH.BSR = 0x8D;
LBRANCH.LBHS = [0x10, 0x24]; LBRANCH.LBLO = [0x10, 0x25]; LBRANCH.LBRA = [0x16]; LBRANCH.LBSR = [0x17];
const LEA = { LEAX: 0x30, LEAY: 0x31, LEAS: 0x32, LEAU: 0x33 };
const STACK = { PSHS: 0x34, PULS: 0x35, PSHU: 0x36, PULU: 0x37 };
const XFER = { EXG: 0x1E, TFR: 0x1F };
const REGCODE = { D: 0, X: 1, Y: 2, U: 3, S: 4, PC: 5, A: 8, B: 9, CC: 0xA, CCR: 0xA, DP: 0xB, DPR: 0xB };
const STACKBIT = { CC: 0x01, CCR: 0x01, A: 0x02, B: 0x04, D: 0x06, DP: 0x08, DPR: 0x08, X: 0x10, Y: 0x20, U: 0x40, S: 0x40, PC: 0x80 };
const IDXREG = { X: 0x00, Y: 0x20, U: 0x40, S: 0x60 };

function encode(mn, opnd, pc, ev, ln, pass, hints) {
  if (INH[mn]) { noOperand(mn, opnd); return INH[mn].slice(); }
  if (IMM_ONLY[mn] !== undefined) {
    if (opnd[0] !== '#') throw new AsmError(mn + ' needs immediate operand');
    return [IMM_ONLY[mn], fit(ev(opnd.slice(1)).value, 8)];
  }
  if (BRANCH[mn] !== undefined) {
    const r = ev(opnd);
    const off = r.value - (pc + 2);
    if (pass === 2 && (off < -128 || off > 127)) throw new AsmError('branch out of range (use L' + mn + ')');
    return [BRANCH[mn], off & 0xFF];
  }
  if (LBRANCH[mn]) {
    const op = LBRANCH[mn];
    const off = ev(opnd).value - (pc + op.length + 2);
    return [...op, (off >> 8) & 0xFF, off & 0xFF];
  }
  if (STACK[mn] !== undefined) {
    let pb = 0;
    // an empty list (no operand) is a valid encoding: the part stacks nothing
    for (const r of opnd === '' ? [] : splitArgs(opnd)) {
      const k = r.toUpperCase();
      if (STACKBIT[k] === undefined) throw new AsmError('bad register ' + r);
      if ((mn === 'PSHS' || mn === 'PULS') && k === 'S') throw new AsmError('cannot stack S on S');
      if ((mn === 'PSHU' || mn === 'PULU') && k === 'U') throw new AsmError('cannot stack U on U');
      pb |= STACKBIT[k];
    }
    return [STACK[mn], pb];
  }
  if (XFER[mn] !== undefined) {
    const rs = splitArgs(opnd).map((r) => r.toUpperCase());
    if (rs.length !== 2 || REGCODE[rs[0]] === undefined || REGCODE[rs[1]] === undefined) throw new AsmError('bad registers');
    return [XFER[mn], (REGCODE[rs[0]] << 4) | REGCODE[rs[1]]];
  }
  if (LEA[mn] !== undefined) {
    const ix = indexed(opnd, pc + 1, ev, ln, pass, hints);
    if (!ix) throw new AsmError(mn + ' needs indexed operand');
    return [LEA[mn], ...ix];
  }
  if (RMW[mn] !== undefined) {
    const n = RMW[mn];
    const ix = indexed(opnd, pc + 1, ev, ln, pass, hints);
    if (ix) return [0x60 | n, ...ix];
    if (opnd[0] === '<') return [n, ev(opnd.slice(1)).value];
    const a = fit(ev(opnd.replace(/^>/, '')).value, 16);
    return [0x70 | n, (a >> 8) & 0xFF, a & 0xFF];
  }
  if (GEN[mn]) {
    const [pre, op, wide, allowImm] = GEN[mn];
    const pfx = pre ? [pre] : [];
    if (opnd[0] === '#') {
      if (!allowImm) throw new AsmError(mn + ' has no immediate mode');
      const v = fit(ev(opnd.slice(1)).value, wide ? 16 : 8);
      return wide ? [...pfx, op, (v >> 8) & 0xFF, v & 0xFF] : [...pfx, op, v & 0xFF];
    }
    const ix = indexed(opnd, pc + pfx.length + 1, ev, ln, pass, hints);
    if (ix) return [...pfx, op + 0x20, ...ix];
    if (opnd[0] === '<') return [...pfx, op + 0x10, ev(opnd.slice(1)).value & 0xFF];
    const a = fit(ev(opnd.replace(/^>/, '')).value, 16);
    return [...pfx, op + 0x30, (a >> 8) & 0xFF, a & 0xFF];
  }
  return null;
}

// returns postbyte + extra bytes, or null if operand is not indexed. pcAfterOp = address of the postbyte
function indexed(opnd, pcAfterOp, ev, ln, pass, hints) {
  let s = opnd.trim();
  let ind = 0;
  if (s[0] === '[' && s[s.length - 1] === ']') { ind = 0x10; s = s.slice(1, -1).trim(); }
  const parts = splitArgs(s);
  if (parts.length === 1) {
    if (!ind) return null;
    const a = fit(ev(parts[0]).value, 16); // extended indirect
    return [0x9F, (a >> 8) & 0xFF, a & 0xFF];
  }
  if (parts.length !== 2) throw new AsmError('bad indexed operand');
  let [off, reg] = parts;
  reg = reg.toUpperCase().replace(/\s/g, '');
  off = off.trim();
  // a size prefix forces the offset's form: << 5 bits, < 8 bits, > 16 bits (as the disassembler writes them)
  let force = null;
  if (off.startsWith('<<')) { force = 5; off = off.slice(2).trim(); } else if (off[0] === '<') { force = 8; off = off.slice(1).trim(); } else if (off[0] === '>') { force = 16; off = off.slice(1).trim(); }
  if (reg === 'PCR' || reg === 'PC') {
    const key = ln;
    const r = ev(off);
    if (force === 5) throw new AsmError('invalid size prefix: PCR has no 5-bit offset');
    let long = hints.get(key);
    if (pass === 1) {
      const d8 = r.value - (pcAfterOp + 2);
      long = force ? force === 16 : r.unresolved || d8 < -128 || d8 > 127;
      hints.set(key, long);
    }
    if (!long) {
      const d = r.value - (pcAfterOp + 2);
      if (pass === 2 && (d < -128 || d > 127)) throw new AsmError(`PCR offset ${d} out of range for 8 bits`);
      return [0x8C | ind, d & 0xFF];
    }
    const d = r.value - (pcAfterOp + 3);
    return [0x8D | ind, (d >> 8) & 0xFF, d & 0xFF];
  }
  let m = /^(-{0,2})([XYUS])(\+{0,2})$/.exec(reg);
  if (force && (!off || /^[ABD]$/i.test(off))) throw new AsmError('a size prefix needs a constant offset');
  if (!m) throw new AsmError('bad index register ' + reg);
  const rr = IDXREG[m[2]];
  if (m[1] || m[3]) {
    if (off) throw new AsmError('offset not allowed with auto inc/dec');
    if (m[1] && m[3]) throw new AsmError('bad index register ' + reg);
    if (ind && (m[1] === '-' || m[3] === '+')) throw new AsmError('invalid indirect mode');
    const mode = m[3] === '+' ? 0x0 : m[3] === '++' ? 0x1 : m[1] === '-' ? 0x2 : 0x3;
    return [0x80 | rr | ind | mode];
  }
  const ou = off.toUpperCase();
  if (off === '') return [0x84 | rr | ind];
  if (ou === 'A') return [0x86 | rr | ind];
  if (ou === 'B') return [0x85 | rr | ind];
  if (ou === 'D') return [0x8B | rr | ind];
  const r = ev(off);
  let form = hints.get(ln);
  if (pass === 1) {
    const v = r.value;
    if (force) {
      if (force === 5 && ind) throw new AsmError('invalid size prefix: no 5-bit offset with indirect');
      form = force;
    } else if (r.unresolved) form = 16;
    else if (v === 0) form = 0;
    else if (!ind && v >= -16 && v <= 15) form = 5;
    else if (v >= -128 && v <= 127) form = 8;
    else form = 16;
    hints.set(ln, form);
  }
  const v = fit(r.value, 16);
  if (form === 0) return [0x84 | rr | ind];
  if (form === 5) { if (v < -16 || v > 15) throw new AsmError(`offset ${v} out of range for 5 bits`); return [rr | (v & 0x1F)]; }
  if (form === 8) { if (v < -128 || v > 127) throw new AsmError(`offset ${v} out of range for 8 bits`); return [0x88 | rr | ind, v & 0xFF]; }
  return [0x89 | rr | ind, (v >> 8) & 0xFF, v & 0xFF];
}

// build a DragonDOS binary (single contiguous block) or DECB segmented binary
export const isa6809 = { name: '6809', encode: (mn, opnd, ctx) => encode(mn, opnd, ctx.pc, ctx.ev, ctx.line, ctx.pass, ctx.hints) };
