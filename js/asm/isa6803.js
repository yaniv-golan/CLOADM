/*
 * 6801/6803 instruction set plugin for the assembler engine (js/asm/assembler.js).
 * encode(mnemonic, operand, ctx) returns the instruction bytes, or null for an unknown mnemonic.
 * ctx: { pc, ev(expr) -> {value, unresolved}, pass, line, hints (Map: per-line size choices) }
 * Operands: #imm  <direct  >extended  addr  n,X  ,X  X   (n = 0..255)
 * A plain address uses direct mode when it is known to be below $100 in pass 1 and the
 * instruction has a direct form. Both 6800-style (LDAA, STAB, ORAA, CPX) and 6809-style
 * (LDA, STB, ORA, CMPX) names are accepted.
 */
import { AsmError, fit, splitArgs } from './syntax.js';

const INH = {
  NOP: 0x01, LSRD: 0x04, ASLD: 0x05, LSLD: 0x05, TAP: 0x06, TPA: 0x07, INX: 0x08, DEX: 0x09,
  CLV: 0x0A, SEV: 0x0B, CLC: 0x0C, SEC: 0x0D, CLI: 0x0E, SEI: 0x0F,
  SBA: 0x10, CBA: 0x11, TAB: 0x16, TBA: 0x17, DAA: 0x19, ABA: 0x1B,
  TSX: 0x30, INS: 0x31, PULA: 0x32, PULB: 0x33, DES: 0x34, TXS: 0x35, PSHA: 0x36, PSHB: 0x37,
  PULX: 0x38, RTS: 0x39, ABX: 0x3A, RTI: 0x3B, PSHX: 0x3C, MUL: 0x3D, WAI: 0x3E, SWI: 0x3F,
};
// read-modify-write ops: accumulator forms 0x40/0x50, memory forms 0x60 (indexed) / 0x70 (extended)
const RMW = { NEG: 0x0, COM: 0x3, LSR: 0x4, ROR: 0x6, ASR: 0x7, ASL: 0x8, LSL: 0x8, ROL: 0x9, DEC: 0xA, INC: 0xC, TST: 0xD, JMP: 0xE, CLR: 0xF };
for (const [k, v] of Object.entries(RMW)) {
  if (k === 'JMP') continue;
  INH[k + 'A'] = 0x40 | v; INH[k + 'B'] = 0x50 | v;
}
// general ops: [immediate opcode, wide immediate, has immediate]
const GEN = {};
const g = (base, list) => list.forEach((n, i) => {
  for (const name of n[0].split('/')) GEN[name] = [base + i, !!n[1], !n[2]];
});
g(0x80, [['SUBA'], ['CMPA'], ['SBCA'], ['SUBD', 1], ['ANDA'], ['BITA'], ['LDAA/LDA'], ['STAA/STA', 0, 1],
  ['EORA'], ['ADCA'], ['ORAA/ORA'], ['ADDA'], ['CPX/CMPX', 1], ['JSR', 0, 1], ['LDS', 1], ['STS', 1, 1]]);
g(0xC0, [['SUBB'], ['CMPB'], ['SBCB'], ['ADDD', 1], ['ANDB'], ['BITB'], ['LDAB/LDB'], ['STAB/STB', 0, 1],
  ['EORB'], ['ADCB'], ['ORAB/ORB'], ['ADDB'], ['LDD', 1], ['STD', 1, 1], ['LDX', 1], ['STX', 1, 1]]);
const BRANCH = {};
['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE']
  .forEach((n, i) => { BRANCH[n] = 0x20 + i; });
BRANCH.BHS = 0x24; BRANCH.BLO = 0x25; BRANCH.BSR = 0x8D;

// indexed operand "n,X" / ",X" / "X": returns the offset expression, or null
function indexedOffset(opnd) {
  const parts = splitArgs(opnd);
  if (parts.length === 2 && parts[1].toUpperCase() === 'X') return parts[0];
  if (parts.length === 1 && parts[0].toUpperCase() === 'X') return '';
  if (parts.length > 1) throw new AsmError('bad indexed operand (the 6801 only has n,X)');
  return null;
}
function offset8(ev, off) {
  if (off === '') return 0;
  const v = ev(off).value;
  if (v < 0 || v > 255) throw new AsmError('index offset out of range (0-255)');
  return v;
}

function encode(mn, opnd, ctx) {
  const { pc, ev, pass, line, hints } = ctx;
  if (INH[mn] !== undefined) { if (opnd) throw new AsmError(mn + ' takes no operand'); return [INH[mn]]; }
  if (BRANCH[mn] !== undefined) {
    const off = ev(opnd).value - (pc + 2);
    if (pass === 2 && (off < -128 || off > 127)) throw new AsmError('branch out of range');
    return [BRANCH[mn], off & 0xFF];
  }
  if (RMW[mn] !== undefined) {
    const n = RMW[mn];
    const ix = indexedOffset(opnd);
    if (ix !== null) return [0x60 | n, offset8(ev, ix)];
    if (opnd[0] === '#') throw new AsmError(mn + ' has no immediate mode');
    if (opnd[0] === '<') throw new AsmError(mn + ' has no direct mode');
    const a = fit(ev(opnd.replace(/^>/, '')).value, 16);
    return [0x70 | n, (a >> 8) & 0xFF, a & 0xFF];
  }
  if (GEN[mn]) {
    const [op, wide, allowImm] = GEN[mn];
    if (opnd[0] === '#') {
      if (!allowImm) throw new AsmError(mn + ' has no immediate mode');
      const v = fit(ev(opnd.slice(1)).value, wide ? 16 : 8);
      return wide ? [op, (v >> 8) & 0xFF, v & 0xFF] : [op, v & 0xFF];
    }
    if (!opnd) throw new AsmError(mn + ' needs an operand');
    const ix = indexedOffset(opnd);
    if (ix !== null) return [op + 0x20, offset8(ev, ix)];
    if (opnd[0] === '<') return [op + 0x10, ev(opnd.slice(1)).value & 0xFF];
    if (opnd[0] === '>') { const a = fit(ev(opnd.slice(1)).value, 16); return [op + 0x30, (a >> 8) & 0xFF, a & 0xFF]; }
    const r = ev(opnd);
    fit(r.value, 16);
    let direct = hints.get(line);
    if (pass === 1) { direct = !r.unresolved && r.value >= 0 && r.value < 0x100; hints.set(line, direct); }
    if (direct) return [op + 0x10, r.value & 0xFF];
    return [op + 0x30, (r.value >> 8) & 0xFF, r.value & 0xFF];
  }
  return null;
}

export const isa6803 = { name: '6803', encode };
