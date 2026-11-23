/*
 * TMS7000 instruction set plugin for the assembler engine (js/asm/assembler.js), and the same table the
 * disassembler and the CPU core read.
 *
 * Every opcode, byte length, cycle count and flag column below is transcribed from the TMS7000 Family Data
 * Manual (TI, SPND001B, 1986), Table 6-3 "TMS7000 Family Instruction Overview", pages 6-9 to 6-14, and
 * cross-checked against Appendix F "Instruction Opcode Set" (pages F-1, F-2) and Appendix E "Hexadecimal
 * Instruction Table/Opcode Map" (page E-1). Where the three disagreed the disagreement is noted on the line,
 * because the scan's OCR corrupts hex digits (D reads as 0 or O, 8 as S):
 *   - TSTA is $80 (Appendix F, and the E map's group 8 column 0), not the $B0 that Table 6-3's OCR shows.
 *     CLRC really is $B0.
 *   - NOP takes 5 cycles: Table 6-3 says 5 and Appendix A's note 1 says NOP "does not have an execution
 *     state", so the 6-cycle figure in a marginal note is a misprint.
 *   - LDSP is $0D (Table 6-3 and Appendix F); an OCR line elsewhere makes it look like $8A, which is LDA.
 *   - MOVD is $88 / $98 / $A8 (Table 6-3, Appendix F), not the $88/$89/$8A an OCR row of the E map implies.
 * The manual's opcode field layout: the opcode byte is the IR. Bit 7 clear is format 0 (bits 6-4 group,
 * bits 3-0 function); bit 7 set is format 1 (bits 6-3 group, bits 2-0 function). Within format 0 the group is
 * the addressing mode (1 Rn,A; 2 %n,A; 3 Rn,B; 4 Rn,Rn; 5 %n,B; 6 B,A; 7 %n,Rn) and the function is the
 * operation; format 1 keeps the extended/peripheral/single-operand groups. That is how the table below was
 * laid out, and it is what makes every value in it agree with the manual's own listing.
 *
 * Addressing (the manual's Section 3.2 names, and how the assembler spells them):
 *   A, B          the two accumulators
 *   Rn            register-file register, %n immediate, @n direct (extended), *Rn indirect, @n(B) indexed
 *   Pn            peripheral-file register
 *   Ofst          PC-relative offset, -128..127, encoded as (target - pc) after the operand byte
 *
 * encode() follows the engine's contract: (mnemonic, operand, ctx) -> bytes, or null if unknown.
 */
import { AsmError } from './syntax.js';

// The operation codes for the dual-operand group: the opcode byte is (group << 4) | function, so a
// single operation occupies one column of every group row.
//   function nibble: D CMP, 2 MOV, 3 AND, 4 OR, 5 XOR, 6 BTJO, 7 BTJZ, 8 ADD, 9 ADC, A SUB, B SBB,
//                    C MPY, E DAC, F DSB
// CMP is D, not 0: the manual's Appendix E grid puts CMP on row 1101 and Table 6-3's "CMP B,A 60" is
// scan damage for 6D. MAME's disassembler (an independent reading of the same manual) also has 0x6D.
const DUAL_FN = { CMP: 0xD, MOV: 0x2, AND: 0x3, OR: 0x4, XOR: 0x5, BTJO: 0x6, BTJZ: 0x7, ADD: 0x8, ADC: 0x9, SUB: 0xA, SBB: 0xB, MPY: 0xC, DAC: 0xE, DSB: 0xF };
// format 0 groups: 1 Rn,A; 2 %n,A; 3 Rn,B; 4 Rn,Rn; 5 %n,B; 6 B,A; 7 %n,Rn
const GROUP_RnA = 1, GROUP_IMM_A = 2, GROUP_RnB = 3, GROUP_RnRn = 4, GROUP_IMM_B = 5, GROUP_BA = 6, GROUP_IMM_Rn = 7;

// Build an opcode from (group, function) in format 0.
const f0 = (group, fn) => ((group & 7) << 4) | (fn & 0xF);
// ... and format 1 (bit 7 set): group in bits 6-3, function in bits 2-0.
const f1 = (group, fn) => 0x80 | ((group & 0xF) << 3) | (fn & 7);

// ---- the table the core and the disassembler use ----
// Each entry: { op, mn, modes: [{ form, bytes, cycles, taken }], flags: 'C','N','Z' or '' }
// form names: implied, A, B, Rn, imm, direct, indirect, indexed, rel, Pn, Rp
// cycles: the base count from Table 6-3; `taken` is the count when a branch is taken (undefined otherwise).
export const OPS = [];
const op = (mnemonic, opcode, form, bytes, cycles, flags, extra = {}) => {
  // merge only another mode of the same instruction; a different mnemonic on the same byte is its own entry
  const e = OPS.find((o) => o.op === opcode && o.mn === mnemonic);
  const mode = { op: opcode & 0xFF, form, bytes, cycles, flags, ...extra };
  if (e) e.modes.push(mode);
  else OPS.push({ op: opcode & 0xFF, mn: mnemonic, modes: [mode] });
};

// Which operations compute the carry and which clear it. Table 6-3's status column is "R R R" for the
// first group and "0 R R" for the second; every dual-operand operation sets N and Z.
const CARRY_RESULT = new Set(['ADC', 'ADD', 'CMP', 'DAC', 'DSB', 'SBB', 'SUB']);

// ---- dual-operand operations (format 0) ----
for (const [mn, fn] of Object.entries(DUAL_FN)) {
  // the manual's rows, in its order: B,A ; Rn,A ; Rn,B ; Rn,Rn ; %n,A ; %n,B ; %n,Rn
  const cyc = (() => {
    switch (mn) {
      case 'MPY': return [44, 47, 47, 49, 46, 46, 48];
      case 'DAC': case 'DSB': return [7, 10, 10, 12, 9, 9, 11];
      // BTJO and BTJZ carry a jump offset, and Table 6-3 gives them their own row: the count is two
      // higher than the plain arithmetic row because reading the offset is part of the instruction.
      // (The taken count is this plus two, per the table's footnote.)
      case 'BTJO': case 'BTJZ': return [7, 10, 10, 12, 9, 9, 11];
      default: return [5, 8, 8, 10, 7, 7, 9];
    }
  })();
  const nbytes = [1, 2, 2, 3, 2, 2, 3];
  const groups = [GROUP_BA, GROUP_RnA, GROUP_RnB, GROUP_RnRn, GROUP_IMM_A, GROUP_IMM_B, GROUP_IMM_Rn];
  const forms = ['B,A', 'Rn,A', 'Rn,B', 'Rn,Rn', 'imm,A', 'imm,B', 'imm,Rn'];
  for (let i = 0; i < 7; i++) {
    const carry = CARRY_RESULT.has(mn) ? 'result' : 'clear';
    // BTJO and BTJZ also carry an offset byte (Table 6-3 gives them their own lengths and adds two
    // cycles when the jump is taken); every other dual-operand form has no third operand.
    const branch = mn === 'BTJO' || mn === 'BTJZ' ? { taken: cyc[i] + 2, rel: true } : {};
    const n = nbytes[i] + (branch.rel ? 1 : 0);
    op(mn, f0(groups[i], fn), forms[i], n, cyc[i], 'CNZ', { carry, ...branch });
  }
}

// ---- the peripheral-file operations (format 1) ----
const PERIPH = [
  ['MOVP', { 'A,Pd': 0x82, 'B,Pd': 0x92, 'imm,Pd': 0xA2, 'Ps,A': 0x80, 'Ps,B': 0x91 }, { 'A,Pd': [2, 10], 'B,Pd': [2, 9], 'imm,Pd': [3, 11], 'Ps,A': [2, 9], 'Ps,B': [2, 8] }],
  ['ANDP', { 'A,Pd': 0x83, 'B,Pd': 0x93, 'imm,Pd': 0xA3 }, { 'A,Pd': [2, 10], 'B,Pd': [2, 9], 'imm,Pd': [3, 11] }],
  ['ORP', { 'A,Pd': 0x84, 'B,Pd': 0x94, 'imm,Pd': 0xA4 }, { 'A,Pd': [2, 10], 'B,Pd': [2, 9], 'imm,Pd': [3, 11] }],
  ['XORP', { 'A,Pd': 0x85, 'B,Pd': 0x95, 'imm,Pd': 0xA5 }, { 'A,Pd': [2, 10], 'B,Pd': [2, 9], 'imm,Pd': [3, 11] }],
  // BTJOP/BTJZP are the branching peripheral instructions: two operand bytes plus the offset byte
  ['BTJOP', { 'A,Pn': 0x86, 'B,Pn': 0x96, 'imm,Pn': 0xA6 }, { 'A,Pn': [3, 11, 13], 'B,Pn': [3, 10, 12], 'imm,Pn': [4, 12, 14] }],
  ['BTJZP', { 'A,Pn': 0x87, 'B,Pn': 0x97, 'imm,Pn': 0xA7 }, { 'A,Pn': [3, 11, 13], 'B,Pn': [3, 10, 12], 'imm,Pn': [4, 12, 14] }],
];
for (const [mn, codes, sizes] of PERIPH) {
  // BTJO/BTJZ/BTJOP/BTJZP are the four instructions whose Table 6-3 row carries a "taken" count
  const branching = mn.startsWith('BTJO') || mn.startsWith('BTJZ');
  for (const [form, code] of Object.entries(codes)) {
    const [bytes, cycles, taken] = sizes[form];
    op(mn, code, form, bytes, cycles, 'CNZ', branching ? { taken, rel: true, carry: 'clear' } : { carry: 'clear' });
  }
}

// ---- extended addressing: LDA, STA, CMPA, BR, CALL ----
const EXT = [
  ['LDA', { direct: [0x8A, 3, 11], indirect: [0x9A, 2, 10], indexed: [0xAA, 3, 13] }, 'NZ'],
  ['STA', { direct: [0x8B, 3, 11], indirect: [0x9B, 2, 10], indexed: [0xAB, 3, 13] }, 'NZ'],
  ['CMPA', { direct: [0x8D, 3, 12], indirect: [0x9D, 2, 11], indexed: [0xAD, 3, 14] }, 'CNZ'],
  ['BR', { direct: [0x8C, 3, 10], indirect: [0x9C, 2, 9], indexed: [0xAC, 3, 12] }, ''],
  ['CALL', { direct: [0x8E, 3, 14], indirect: [0x9E, 2, 13], indexed: [0xAE, 3, 16] }, ''],
];
for (const [mn, forms, flags] of EXT) {
  for (const [form, [code, bytes, cycles]] of Object.entries(forms)) op(mn, code, form, bytes, cycles, flags);
}

// ---- MOVD (move double): page 6-44 and Appendix A Table A-17 ----
// The immediate is 16 bits and big-endian (">1234" encodes 12 34); the indexed form is written
// %>ADDR(B) and is the 16-bit constant added to B (not an address, so it is not a memory read).
for (const [form, [code, bytes, cycles]] of Object.entries({ 'imm,Rp': [0x88, 4, 15], 'imm(B),Rp': [0xA8, 4, 17], 'Rp,Rp': [0x98, 3, 14] })) {
  op('MOVD', code, form, bytes, cycles, 'CNZ');
}

// ---- single-operand operations ----
const SINGLE = [
  ['CLR', { A: 0xB5, B: 0xC5, Rd: 0xD5 }, [1, 1, 2], [5, 5, 7], 'Z'],
  ['DEC', { A: 0xB2, B: 0xC2, Rd: 0xD2 }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['DECD', { A: 0xBB, B: 0xCB, Rp: 0xDB }, [1, 1, 2], [9, 9, 11], 'CNZ'],
  ['INC', { A: 0xB3, B: 0xC3, Rd: 0xD3 }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['INV', { A: 0xB4, B: 0xC4, Rd: 0xD4 }, [1, 1, 2], [5, 5, 7], 'NZ'],
  ['POP', { A: 0xB9, B: 0xC9, Rd: 0xD9 }, [1, 1, 2], [6, 6, 8], 'CNZ'],
  ['PUSH', { A: 0xB8, B: 0xC8, Rs: 0xD8 }, [1, 1, 2], [6, 6, 8], 'CNZ'],
  ['RL', { A: 0xBE, B: 0xCE, Rd: 0xDE }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['RLC', { A: 0xBF, B: 0xCF, Rd: 0xDF }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['RR', { A: 0xBC, B: 0xCC, Rd: 0xDC }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['RRC', { A: 0xBD, B: 0xCD, Rd: 0xDD }, [1, 1, 2], [5, 5, 7], 'CNZ'],
  ['SWAP', { A: 0xB7, B: 0xC7, Rn: 0xD7 }, [1, 1, 2], [8, 8, 10], 'CNZ'],
  ['XCHB', { A: 0xB6, B: 0xC6, Rn: 0xD6 }, [1, 1, 2], [6, 6, 8], 'CNZ'],
];
for (const [mn, codes, nbytes, cyc, flags] of SINGLE) {
  const keys = Object.keys(codes);
  keys.forEach((form, i) => op(mn, codes[form], form, nbytes[i], cyc[i], flags));
}
// CLRC and TSTA share opcode $B0 (Appendix F lists both on that byte; MAME's disassembler does too): the
// instruction clears carry and then sets N and Z from A, so CLRC's "0 -> C" is the same byte.
op('TSTA', 0xB0, 'implied', 1, 6, 'NZ');   // manual: 0 -> C, then N and Z on A
op('TSTB', 0xC1, 'implied', 1, 6, 'NZ');

// ---- implied operations ----
for (const [mn, code, cycles, flags] of [
  ['NOP', 0x00, 5, ''], ['IDLE', 0x01, 6, ''], ['EINT', 0x05, 5, ''], ['DINT', 0x06, 5, ''],
  ['SETC', 0x07, 5, ''], ['CLRC', 0xB0, 6, 'NZ'], ['LDSP', 0x0D, 5, ''], ['STSP', 0x09, 6, ''],
  ['PUSH ST', 0x0E, 6, 'CNZ'], ['POP ST', 0x08, 6, 'CNZ'], ['RETS', 0x0A, 7, ''],
  ['RETI', 0x0B, 9, ''],
]) op(mn, code, 'implied', 1, cycles, flags);
// MOV's register forms that are not part of the dual-operand grid. MOV B,A ($62) comes from the grid.
op('MOV', 0xC0, 'A,B', 1, 6, 'NZ');   // Table 6-3: A,B C0, 1 byte, 6 cycles
op('MOV', 0xD0, 'A,Rd', 2, 8, 'NZ');
op('MOV', 0xD1, 'B,Rd', 2, 7, 'NZ');
// $B1 is not in Table 6-3 (the manual's grid has no B,A entry on the $B row), but MAME executes it as the
// same B->A move the $B0 row implies, 5 cycles, and its disassembler calls it MOV B,A. The core executes it
// so that behaviour matches the only implementation of this part outside the manual. `undocumented: true`
// keeps it out of the disassembler: the assembler has one spelling for MOV B,A (the documented $62), so a
// disassembly that named $B1 would not reassemble to its own bytes.
op('MOV', 0xB1, 'B,A', 1, 5, 'NZ', { undocumented: true });

// ---- relative jumps (2 bytes; +2 cycles when taken) ----
const JUMPS = { 'JMP': [0xE0, 7], 'JC': [0xE3, 5], 'JHS': [0xE3, 5], 'JZ': [0xE2, 5], 'JEQ': [0xE2, 5],
  'JN': [0xE1, 5], 'JLT': [0xE1, 5], 'JNZ': [0xE6, 5], 'JNE': [0xE6, 5], 'JP': [0xE4, 5], 'JGT': [0xE4, 5],
  'JPZ': [0xE5, 5], 'JGE': [0xE5, 5], 'JNC': [0xE7, 5], 'JL': [0xE7, 5] };
for (const [mn, [code, cycles]] of Object.entries(JUMPS)) {
  const taken = mn === 'JMP' ? undefined : cycles + 2;
  op(mn, code, 'rel', 2, cycles, '', taken ? { taken } : {});
}
// DJNZ is a single-operand jump: BA/CA (2 bytes) and DA (3 bytes)
op('DJNZ', 0xBA, 'A,rel', 2, 7, '', { taken: 9 });
op('DJNZ', 0xCA, 'B,rel', 2, 7, '', { taken: 9 });
op('DJNZ', 0xDA, 'Rn,rel', 3, 9, '', { taken: 11 });

// ---- TRAP 0-23 ($FF down to $E8) ----
// The opcode is the low byte of the trap's vector address: Trap 0 is at >FFFE/>FFFF and Trap 23 at
// >FFD0/>FFD1 (page 6-64), so TRAP 0 is $FF and TRAP 23 is $E8. MAME's disassembler agrees.
for (let i = 0; i < 24; i++) op(`TRAP ${i}`, 0xFF - i, 'implied', 1, 14, '');

// opcode -> entry (first match; a mnemonic alias such as JHS/JC shares a code)
const BY_OPCODE = new Map();
for (const e of OPS) if (!BY_OPCODE.has(e.op)) BY_OPCODE.set(e.op, e);

export const OPS_BY_OPCODE = BY_OPCODE;
export { DUAL_FN, f0, f1, GROUP_RnA, GROUP_IMM_A, GROUP_RnB, GROUP_RnRn, GROUP_IMM_B, GROUP_BA, GROUP_IMM_Rn };

// ---- the assembler's view ----
// The engine calls encode(mnemonic, operand, ctx). ctx: { pc, ev(expr) -> {value, unresolved}, pass }.
// ctx.ev resolves a whole expression, so a branch target written as a label becomes its address.
//
// Hex: this part's literature writes hex as ">FFE0", and the engine's expression syntax writes it as
// "$FFE0". The manual's spelling is translated to the engine's here, inside this instruction set, so the
// 6809/6803 (where ">" means "force extended addressing") are not affected. "%" keeps its own meaning
// (immediate), so a ">" straight after "%" is left alone.
const normaliseHex = (opnd) => (opnd || '')
  .replace(/%>([0-9A-Fa-f])/g, (m, d) => `%$${d}`)            // "%>12" -> "%$12"
  .replace(/(^|[^%$])>([0-9A-Fa-f])/g, (m, pre, d) => `${pre}$${d}`);   // ">0100" -> "$0100"

export function encode(mn, operand, ctx) {
  const up = (mn || '').toUpperCase().trim();
  if (!up) return null;
  const args = normaliseHex(operand).split(',').map((s) => s.trim()).filter((s) => s !== '');

  // TRAP n
  if (up === 'TRAP') {
    const n = num(args[0], ctx);
    if (!(n >= 0 && n <= 23)) throw new AsmError('TRAP takes 0-23');
    return [0xFF - n];
  }
  // "PUSH ST" / "POP ST": the mnemonic is the two words
  if (args.length === 0 && (up === 'PUSH' || up === 'POP')) throw new AsmError(`${up} needs an operand (A, B, Rn, or ST)`);
  if (args.length === 1 && /^ST$/i.test(args[0]) && (up === 'PUSH' || up === 'POP')) {
    return [up === 'PUSH' ? 0x0E : 0x08];
  }

  const cands = OPS.filter((e) => e.mn === up);
  if (!cands.length) return null;
  for (const e of cands) {
    for (const mode of e.modes) {
      const bytes = tryForm(up, mode, args, ctx);
      if (bytes) return bytes;
    }
  }
  throw new AsmError(`${up}: unsupported operands ${operand}`);
}

// An operand the encoder has to turn into a number: %n is an immediate (hex, as the manual writes it),
// and anything else is an expression, so a label or a constant works.
const num = (s, ctx) => {
  if (s === undefined) return NaN;
  const m = /^%\$?([0-9A-Fa-f]+)$/.exec(s.trim());
  if (m) return parseInt(m[1], 16);
  if (/^\d+$/.test(s.trim())) return +s.trim();
  const r = evalAt(s, ctx);
  return r ? r.value : NaN;
};
// evaluate an expression in the engine's context, or null if it cannot be resolved yet
const evalAt = (s, ctx) => {
  if (!ctx || !ctx.ev) return null;
  try { return ctx.ev(s); } catch { return null; }
};
// a register operand: A, B, Rn
const regOf = (s) => {
  const u = (s || '').toUpperCase();
  if (u === 'A' || u === 'B') return { r: u };
  const m = /^R(\d+)$/.exec(u);
  if (m) return { r: 'Rn', n: +m[1] };
  return null;
};
const immOf = (s) => { const m = /^%\$?([0-9A-Fa-f]+)$/.exec((s || '').trim()); return m ? parseInt(m[1], 16) : null; };
// A 16-bit address operand, from a literal, a symbol or an expression. `kind` is what the form needs.
// The value is resolved through the engine, so "@TABLE" and "TABLE+2" both work; in pass 1 a forward
// symbol is unresolved and encodes as zero, which the second pass then corrects.
const addrOf = (text, ctx) => {
  const s = (text || '').trim();
  if (!s) return null;
  const r = evalAt(s, ctx);
  if (!r) return null;
  return { addr: r.value & 0xFFFF, unresolved: !!r.unresolved };
};
// an extended operand: @addr, @addr(B), *Rn
const extOf = (s, ctx) => {
  const u = (s || '').trim();
  let m = /^\*R(\d+)$/i.exec(u); if (m) return { kind: 'indirect', n: +m[1] };
  m = /^@(.+)\(B\)$/i.exec(u); if (m) { const a = addrOf(m[1], ctx); return a ? { kind: 'indexed', ...a } : null; }
  m = /^@(.+)$/.exec(u); if (m) { const a = addrOf(m[1], ctx); return a ? { kind: 'direct', ...a } : null; }
  return null;
};
// MOVD's indexed immediate: %ADDR(B), a 16-bit constant added to B (page 6-44)
const movdIndexed = (s, ctx) => {
  const m = /^%(.+)\(B\)$/i.exec((s || '').trim());
  return m ? addrOf(m[1], ctx) : null;
};
const word = (v) => [(v >> 8) & 0xFF, v & 0xFF];

// try to encode one table entry's form against the parsed operands
function tryForm(mn, mode, args, ctx) {
  const form = mode.form;
  const one = (a) => args.length === 1 && form === a;
  // two register literals with nothing else: B,A and A,B
  if (/^[AB],[AB]$/.test(form) && args.length === 2 && args[0].toUpperCase() === form[0] && args[1].toUpperCase() === form[2]) return [mode.op];
  // A,Rd / B,Rd: an accumulator to a register-file register
  if (/^[AB],Rd$/.test(form) && args.length === 2 && args[0].toUpperCase() === form[0] && regOf(args[1])?.r === 'Rn') return [mode.op, regOf(args[1]).n & 0xFF];
  // DJNZ A,rel / B,rel / Rn,rel
  if (form === 'A,rel' && /^A$/i.test(args[0] || '') && args.length === 2) return [mode.op, relOf(args[1], ctx, mode.bytes)];
  if (form === 'B,rel' && /^B$/i.test(args[0] || '') && args.length === 2) return [mode.op, relOf(args[1], ctx, mode.bytes)];
  if (form === 'Rn,rel' && regOf(args[0])?.r === 'Rn' && args.length === 2) return [mode.op, regOf(args[0]).n & 0xFF, relOf(args[1], ctx, mode.bytes)];
  // A branching dual-operand form: source and destination, then the offset byte
  if (mode.rel && args.length === 3) {
    const head = tryForm(mn, { ...mode, rel: false, bytes: mode.bytes - 1 }, args.slice(0, 2), ctx);
    return head ? [...head, relOf(args[2], ctx, mode.bytes)] : null;
  }
  if (form === 'Rn,A' && regOf(args[0])?.r === 'Rn' && regOf(args[1])?.r === 'A') return [mode.op, regOf(args[0]).n & 0xFF];
  if (form === 'Rn,B' && regOf(args[0])?.r === 'Rn' && regOf(args[1])?.r === 'B') return [mode.op, regOf(args[0]).n & 0xFF];
  if (form === 'Rn,Rn' && regOf(args[0])?.r === 'Rn' && regOf(args[1])?.r === 'Rn') return [mode.op, regOf(args[0]).n & 0xFF, regOf(args[1]).n & 0xFF];
  if (form === 'imm,A' && immOf(args[0]) !== null && regOf(args[1])?.r === 'A') return [mode.op, immOf(args[0]) & 0xFF];
  if (form === 'imm,B' && immOf(args[0]) !== null && regOf(args[1])?.r === 'B') return [mode.op, immOf(args[0]) & 0xFF];
  if (form === 'imm,Rn' && immOf(args[0]) !== null && regOf(args[1])?.r === 'Rn') return [mode.op, immOf(args[0]) & 0xFF, regOf(args[1]).n & 0xFF];
  // single operand: A / B / Rn / Rd / Rp / Rs
  if (['A', 'B', 'Rn', 'Rd', 'Rp', 'Rs'].includes(form) && one(form)) {
    if (form === 'A' && /^A$/i.test(args[0])) return [mode.op];
    if (form === 'B' && /^B$/i.test(args[0])) return [mode.op];
    if ((form === 'Rn' || form === 'Rd' || form === 'Rp' || form === 'Rs') && regOf(args[0])?.r === 'Rn') return [mode.op, regOf(args[0]).n & 0xFF];
  }
  // peripheral forms
  if (form === 'A,Pd' && /^A$/i.test(args[0]) && /^P\d+$/i.test(args[1])) return [mode.op, pnum(args[1])];
  if (form === 'B,Pd' && /^B$/i.test(args[0]) && /^P\d+$/i.test(args[1])) return [mode.op, pnum(args[1])];
  if (form === 'Ps,A' && /^P\d+$/i.test(args[0]) && /^A$/i.test(args[1])) return [mode.op, pnum(args[0])];
  if (form === 'Ps,B' && /^P\d+$/i.test(args[0]) && /^B$/i.test(args[1])) return [mode.op, pnum(args[0])];
  if ((form === 'imm,Pd' || form === 'imm,Pn') && immOf(args[0]) !== null && /^P\d+$/i.test(args[1] || '')) return [mode.op, immOf(args[0]) & 0xFF, pnum(args[1])];
  // BTJOP/BTJZP take A or B as the source, so the form's own letter is what has to match
  if (form === 'A,Pn' && /^A$/i.test(args[0]) && /^P\d+$/i.test(args[1] || '')) return [mode.op, pnum(args[1])];
  if (form === 'B,Pn' && /^B$/i.test(args[0]) && /^P\d+$/i.test(args[1] || '')) return [mode.op, pnum(args[1])];
  // extended
  // extended: @addr and @addr(B) take a symbol or an expression, *Rn a register pair
  const e = args.length === 1 ? extOf(args[0], ctx) : null;
  if (e) {
    if (form === 'direct' && e.kind === 'direct') return [mode.op, ...word(e.addr)];
    if (form === 'indirect' && e.kind === 'indirect') return [mode.op, e.n & 0xFF];
    if (form === 'indexed' && e.kind === 'indexed') return [mode.op, ...word(e.addr)];
  }
  // MOVD: a 16-bit immediate, the indexed immediate, or one register pair from another
  if (form === 'imm,Rp' && movdIndexed(args[0], ctx) === null && immOf(args[0]) !== null && /^R\d+$/i.test(args[1] || '')) return [mode.op, ...word(immOf(args[0])), +/^R(\d+)$/i.exec(args[1])[1]];
  if (form === 'imm(B),Rp') { const ix = movdIndexed(args[0], ctx); if (ix && /^R\d+$/i.test(args[1] || '')) return [mode.op, ...word(ix.addr), +/^R(\d+)$/i.exec(args[1])[1]]; }
  if (form === 'Rp,Rp' && /^R\d+$/i.test(args[0] || '') && /^R\d+$/i.test(args[1] || '')) return [mode.op, +/^R(\d+)$/i.exec(args[0])[1], +/^R(\d+)$/i.exec(args[1])[1]];
  // relative jumps: the operand is a target address
  if (form === 'rel' && args.length === 1) return [mode.op, relOf(args[0], ctx, mode.bytes)];
  // implied
  if (form === 'implied' && args.length === 0) return [mode.op];
  return null;
}
const pnum = (s) => +/^P(\d+)$/i.exec(s)[1];
// The offset byte for a jump: target address minus the address of the instruction after this one
// (Section 6.2.5 and Table 6-1: offset = ta - pcn, pcn being the next instruction's address). The
// operand is an address, as the manual's programs write it ("JMP THERE"), not a raw offset.
const relOf = (s, ctx, bytes) => {
  // A jump has one addressing mode, the offset, and no operand prefix: "@" belongs to the address operands (CALL
  // @LABEL, BR @LABEL, LDA @LABEL) and means nothing here. It is not an expression, so it would evaluate to nothing
  // and encode as offset 0 (a jump to the next instruction) without a word.
  const t = (s || '').trim();
  if (t.startsWith('@')) throw new AsmError(`a jump's target is written as a plain label or address ("${t.slice(1).trim()}"), not with @: @ marks an address operand, as in CALL @LABEL, and a relative jump takes none`);
  const r = evalAt(s, ctx);
  if (!r || r.unresolved) return 0;   // pass 1: the instruction's length is what it would be either way
  return (r.value - (ctx.pc + bytes)) & 0xFF;
};
