// Per-opcode coverage of the MC6803 core (the CPU in the MC-10 and Alice), table-driven: each row is one
// instruction, its bytes, the registers it should leave, the flags it sets and clears, and its cycle count.
//
// WHERE THE VALUES COME FROM: the Motorola MC6801 Reference Manual (MC6801RM/AD2, May 1984), which covers
// the MC6803 too -- "the MC6803 is functionally identical to an MC6801 limited to selected modes"
// (section 2.4.2), with no on-chip ROM and with all MC6801 instructions present. The cycle and byte counts
// are the appendix A tables ("Addressing Modes, Execution Time, and Machine Code"), the flag effects are
// the "Condition Codes" prose in each appendix A entry, and the stack frames are the worked examples under
// SWI and RTI. All were read out of the PDF, not the OCR. Neither this project's assembler nor its core
// was used to produce any expected value.
//
// WHAT IS NOT TESTED, ON PURPOSE:
//  * AIM/OIM/EIM/TIM/TMM. These are Hitachi 6301/637X0 instructions, not MC6801/6803 ones: Table 4-1
//    ("MC6801 Additional Instructions") lists only ABX, ADDD, ASLD/LSLD, BHS, BLO, BRN, direct-mode JSR,
//    LDD, LSL, LSRD, MUL, PSHX, PULX, STD, SUBD and the CPX change.
//  * The on-chip peripherals (ports, timer, SCI, RAM control). tests/mc10.test.js covers those.
//  * The direct-page forms of the read-modify-write instructions: the MC6801 has extended and indexed
//    forms for those but no direct form (MC6801RM section 4.2.3), so there is nothing to test.
//
// The core's `mameCompat` timer bookkeeping is left off here: these rows look at instruction behaviour
// only, and every one of them is the same in both modes.
const Emu = require('./load')();
const { CPU6803 } = Emu;
const F = CPU6803.FLAGS;

let failures = 0, count = 0;
const hex = (v) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');
function is(name, got, want) {
  count++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${hex(got)} want ${hex(want)}`); }
}

// The program runs at $1000. A CC always has bits 6 and 7 set: reset does it, and so do TAP and RTI
// ("bits 6 and 7 of the CCR are effectively read-only bits fixed at 1", MC6801RM section 4.3.1).
const CC1 = 0xC0;
// The 6803 stack: PSH "stores in the stack at the address contained in the stack pointer. The stack
// pointer is then decremented", and PUL "increments then loads" -- the reverse of the 6809. So the rows
// below put their fixtures at S, S+1, ... and expect S to end above them.
const runOnce = (row) => {
  const mem = new Uint8Array(0x10000);
  mem.set(row.bytes, 0x1000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
  if (row.setup) row.setup(mem);
  const cpu = new CPU6803({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  // the core's on-chip RAM ($80-$FF) shadows the flat test memory; switch it off so that a row which
  // addresses $0080-$00FF reads the test memory it set up (RAM control register, $14, bit 6)
  cpu.ramc = 0;
  cpu.s = row.s ?? 0x8000;
  cpu.a = row.a ?? 0; cpu.b = row.b ?? 0; cpu.x = row.x ?? 0; cpu.cc = row.cc ?? CC1;
  const cycles = cpu.step();
  return { cpu, mem, cycles };
};

const SET = (n) => F[n];
const rows = [];
const row = (name, bytes, want = {}) => rows.push(Object.assign({ name, bytes }, want));

// ---- the eight-bit ALU family, both accumulators, immediate/direct/indexed/extended ----
// Per-operator flag effects from appendix A, written out rather than derived: `nz` says N and Z come from
// the result, `v` is 'clear' or 'aff' (V is written), `h` is 'same' or 'aff', `c` is 'same' or 'aff'.
const ALU = [
  { op: 'SUBA', o: [0x80, 0x90, 0xA0, 0xB0], res: 0x12 - 0x0F, v: 'aff', c: 'aff' },
  { op: 'CMPA', o: [0x81, 0x91, 0xA1, 0xB1], res: 0x12 - 0x0F, v: 'aff', c: 'aff', noStore: true },
  { op: 'SBCA', o: [0x82, 0x92, 0xA2, 0xB2], res: 0x12 - 0x0F, v: 'aff', c: 'aff' },
  { op: 'ANDA', o: [0x84, 0x94, 0xA4, 0xB4], res: 0x12 & 0x0F, v: 'clear', c: 'same' },
  { op: 'BITA', o: [0x85, 0x95, 0xA5, 0xB5], res: 0x12 & 0x0F, v: 'clear', c: 'same', noStore: true },
  { op: 'LDAA', o: [0x86, 0x96, 0xA6, 0xB6], res: 0x0F, v: 'clear', c: 'same' },
  { op: 'STAA', o: [null, 0x97, 0xA7, 0xB7], res: 0x0F, v: 'clear', c: 'same', store: true },
  { op: 'EORA', o: [0x88, 0x98, 0xA8, 0xB8], res: 0x12 ^ 0x0F, v: 'clear', c: 'same' },
  { op: 'ADCA', o: [0x89, 0x99, 0xA9, 0xB9], res: 0x12 + 0x0F, v: 'aff', c: 'aff', h: 'aff' },
  { op: 'ORAA', o: [0x8A, 0x9A, 0xAA, 0xBA], res: 0x12 | 0x0F, v: 'clear', c: 'same' },
  { op: 'ADDA', o: [0x8B, 0x9B, 0xAB, 0xBB], res: 0x12 + 0x0F, v: 'aff', c: 'aff', h: 'aff' },
];
const ALUB = [
  { op: 'SUBB', o: [0xC0, 0xD0, 0xE0, 0xF0], res: 0x12 - 0x0F, v: 'aff', c: 'aff' },
  { op: 'CMPB', o: [0xC1, 0xD1, 0xE1, 0xF1], res: 0x12 - 0x0F, v: 'aff', c: 'aff', noStore: true },
  { op: 'SBCB', o: [0xC2, 0xD2, 0xE2, 0xF2], res: 0x12 - 0x0F, v: 'aff', c: 'aff' },
  { op: 'ANDB', o: [0xC4, 0xD4, 0xE4, 0xF4], res: 0x12 & 0x0F, v: 'clear', c: 'same' },
  { op: 'BITB', o: [0xC5, 0xD5, 0xE5, 0xF5], res: 0x12 & 0x0F, v: 'clear', c: 'same', noStore: true },
  { op: 'LDAB', o: [0xC6, 0xD6, 0xE6, 0xF6], res: 0x0F, v: 'clear', c: 'same' },
  { op: 'STAB', o: [null, 0xD7, 0xE7, 0xF7], res: 0x0F, v: 'clear', c: 'same', store: true },
  { op: 'EORB', o: [0xC8, 0xD8, 0xE8, 0xF8], res: 0x12 ^ 0x0F, v: 'clear', c: 'same' },
  { op: 'ADCB', o: [0xC9, 0xD9, 0xE9, 0xF9], res: 0x12 + 0x0F, v: 'aff', c: 'aff', h: 'aff' },
  { op: 'ORAB', o: [0xCA, 0xDA, 0xEA, 0xFA], res: 0x12 | 0x0F, v: 'clear', c: 'same' },
  { op: 'ADDB', o: [0xCB, 0xDB, 0xEB, 0xFB], res: 0x12 + 0x0F, v: 'aff', c: 'aff', h: 'aff' },
];
// cycles and bytes from the appendix A tables: immediate 2/2, direct 3/2, indexed 4/2, extended 4/3
const m6803 = [
  { m: 'immediate', i: 0, cyc: 2 },
  { m: 'direct', i: 1, cyc: 3 },
  { m: 'indexed', i: 2, cyc: 4 },
  { m: 'extended', i: 3, cyc: 4 },
];
// The 6803's "indexed" mode is a plain unsigned 8-bit offset from X with no postbyte (MC6801RM 4.2.5),
// so its operand byte is the offset itself; direct mode is page zero.
const MODE_MEM = 0x0F;
const setupModes = (mem) => { mem[0x40] = MODE_MEM; mem[0x4000] = MODE_MEM; mem[0x4010] = MODE_MEM; };
const eaOf = (md) => (md.m === 'direct' ? '$40' : md.m === 'indexed' ? '$4010' : '$4000');
for (const [list, acc] of [[ALU, 'a'], [ALUB, 'b']]) {
  for (const al of list) {
    for (const md of m6803) {
      const opcode = al.o[md.i];
      if (opcode === null) continue;                        // the stores have no immediate form
      const bytes = md.i === 0 ? [opcode, 0x0F]
        : md.m === 'direct' ? [opcode, 0x40]
        : md.m === 'indexed' ? [opcode, 0x10]
        : [opcode, 0x40, 0x00];
      const r = al.res & 0xFF;
      const want = { flags: { same: ['I'], set: [], clear: [] } };
      if (al.store) {
        want.mem = { [eaOf(md)]: 0x12 };
        want.reg = { [acc]: 0x12 };
      } else {
        want.reg = { [acc]: al.noStore ? 0x12 : r };
      }
      if (!al.noStore) {                                     // N and Z come from the result for every op
        if (r & 0x80) want.flags.set.push('N'); else want.flags.clear.push('N');
        if (r === 0) want.flags.set.push('Z'); else want.flags.clear.push('Z');
      } else {                                               // a compare still sets N and Z, from its difference
        if (r & 0x80) want.flags.set.push('N'); else want.flags.clear.push('N');
        if (r === 0) want.flags.set.push('Z'); else want.flags.clear.push('Z');
      }
      if (al.v === 'clear') want.flags.clear.push('V');      // "V: Cleared."
      // for the operators that write V the value is not pinned here (the dedicated rows below do)
      // C: the operators that write it get their value from the result, which these rows do not try to
      // pin down (the dedicated rows below do, including the carry-in cases), so C is not asserted for
      // them. Where the manual says C is unaffected, that is asserted.
      if (al.c === 'same') want.flags.same.push('C');
      if (al.h !== 'aff') want.flags.same.push('H');
      // H and V start set, so that "unaffected" and "cleared" are proven against a set bit; C starts
      // clear so that the ADC rows add no carry in (the carry-in row below covers the other case)
      Object.assign(want, { [acc]: 0x12, x: 0x4000, cc: CC1 | SET('H') | SET('V'),
        setup: setupModes, cycles: md.cyc });
      row(`${al.op} ${md.m}`, bytes, want);
    }
  }
}

// ---- the sixteen-bit loads, stores and arithmetic ----
// Appendix A: LDD/LDX/LDS are 3/4/5/5 cycles, STD/STX/STS 4/5/5 (no immediate form), ADDD/SUBD and the
// 6801's full-flag CPX 4/5/6/6.
const ALU16 = [
  { n: 'ADDD', o: [0xC3, 0xD3, 0xE3, 0xF3], cyc: [4, 5, 6, 6], k: 'add', r: 'd' },
  { n: 'SUBD', o: [0x83, 0x93, 0xA3, 0xB3], cyc: [4, 5, 6, 6], k: 'sub', r: 'd' },
  { n: 'CPX',  o: [0x8C, 0x9C, 0xAC, 0xBC], cyc: [4, 5, 6, 6], k: 'cmp', r: 'x' },
  { n: 'LDD',  o: [0xCC, 0xDC, 0xEC, 0xFC], cyc: [3, 4, 5, 5], k: 'load', r: 'd' },
  { n: 'STD',  o: [null, 0xDD, 0xED, 0xFD], cyc: [3, 4, 5, 5], k: 'store', r: 'd' },
  { n: 'LDX',  o: [0xCE, 0xDE, 0xEE, 0xFE], cyc: [3, 4, 5, 5], k: 'load', r: 'x' },
  { n: 'STX',  o: [null, 0xDF, 0xEF, 0xFF], cyc: [3, 4, 5, 5], k: 'store', r: 'x' },
  { n: 'LDS',  o: [0x8E, 0x9E, 0xAE, 0xBE], cyc: [3, 4, 5, 5], k: 'load', r: 's' },
  { n: 'STS',  o: [null, 0x9F, 0xAF, 0xBF], cyc: [3, 4, 5, 5], k: 'store', r: 's' },
];
const VALUE = 0x0102, STORE = 0x1234;
const setup16 = (mem) => { mem[0x40] = 0x01; mem[0x41] = 0x02; mem[0x4000] = 0x01; mem[0x4001] = 0x02; mem[0x4010] = 0x01; mem[0x4011] = 0x02; mem[0x1244] = 0x00; };
for (const t of ALU16) {
  for (const md of m6803) {
    const opcode = t.o[md.i];
    if (opcode === null) continue;
    const bytes = md.i === 0 ? [opcode, 0x01, 0x02]
      : md.m === 'direct' ? [opcode, 0x40]
      : md.m === 'indexed' ? [opcode, 0x10]
      : [opcode, 0x40, 0x00];
    // STX and CPX index through X, which is also the register under test: the base is set to the
    // register's value and the operand byte (offset $10) selects the operand cell, so the effective
    // address is value + $10. Every other indexed row addresses X+$10 from a base of $4000.
    const selfIdx = (t.n === 'STX' || t.n === 'CPX') && md.m === 'indexed';
    const base = selfIdx ? (t.k === 'store' ? STORE : VALUE) : 0x4000;
    const ea = md.m === 'direct' ? 0x40 : md.m === 'extended' ? 0x4000 : md.m === 'indexed' ? base + 0x10 : 0;
    const s = { x: 0x4000, cc: CC1 | SET('H') | SET('V') | SET('C'),
      setup: (m) => { setup16(m); if (md.m !== 'immediate') { m[ea] = 0x01; m[ea + 1] = 0x02; } } };
    const start = t.k === 'store' ? STORE : t.k === 'cmp' || t.k === 'sub' ? VALUE : 0;
    if (t.r === 'd') { s.a = start >> 8; s.b = start & 0xFF; } else s[t.r] = start;
    if (md.m === 'indexed' && t.r === 'x') s.x = base;
    if (t.k === 'load' && t.r === 's') s.s = 0;              // LDS's own result is the stack pointer
    // appendix A: every one of these leaves H and I alone and writes V (cleared for the loads and
    // stores, from the operation for ADDD/SUBD/CPX); C is written only by the arithmetic and compares
    const want = { flags: { same: ['H', 'I'], set: [], clear: ['V'] }, cycles: t.cyc[md.i] };
    if (t.k === 'load' || t.k === 'store') want.flags.same.push('C');
    if (t.k === 'load') {
      if (t.r === 'd') want.reg = { a: 0x01, b: 0x02 }; else want.reg = { [t.r]: VALUE };
      want.flags.clear.push('N', 'Z');
    } else if (t.k === 'store') {
      // N and Z from the register stored, V cleared (appendix A)
      want.mem = { ['$' + ea.toString(16).toUpperCase()]: 0x12, ['$' + (ea + 1).toString(16).toUpperCase()]: 0x34 };
      if (t.r === 'd') want.reg = { a: 0x12, b: 0x34 }; else want.reg = { [t.r]: STORE };
      want.flags.clear.push('N', 'Z');
    } else if (t.k === 'add') {                              // D starts 0, so the sum is the operand
      want.reg = { a: 0x01, b: 0x02 }; want.flags.clear.push('N', 'Z', 'C');
    } else {                                                 // SUBD/CPX: equal operands leave zero
      want.flags.set.push('Z'); want.flags.clear.push('N', 'C');
    }
    if (t.k === 'add' || t.k === 'sub' || t.k === 'cmp') want.flags.same = ['H', 'I'];
    row(`${t.n} ${md.m}`, bytes, Object.assign(s, want));
  }
}

// ---- shifts and rotates: the accumulator forms and the memory forms ----
// Appendix A: every one is 2 cycles for the A and B forms, 6 cycles and 2 bytes indexed, 6 cycles and 3
// bytes extended. N and Z come from the result; V is N xor C after the shift; C is the bit shifted out.
// The rows start with C clear so that ROL/ROR keep their plain result; the carry-in cases have their own
// rows below.
const SHIFT = [
  { op: 'NEG', a: 0x40, b: 0x50, mem: 0x60, ext: 0x70, in: 0x02, res: 0xFE },
  { op: 'COM', a: 0x43, b: 0x53, mem: 0x63, ext: 0x73, in: 0x12, res: 0xED },
  { op: 'LSR', a: 0x44, b: 0x54, mem: 0x64, ext: 0x74, in: 0x81, res: 0x40 },
  { op: 'ROR', a: 0x46, b: 0x56, mem: 0x66, ext: 0x76, in: 0x81, res: 0x40 },
  { op: 'ASR', a: 0x47, b: 0x57, mem: 0x67, ext: 0x77, in: 0x81, res: 0xC0 },
  { op: 'ASL', a: 0x48, b: 0x58, mem: 0x68, ext: 0x78, in: 0x81, res: 0x02 },
  { op: 'LSL', a: 0x48, b: 0x58, mem: 0x68, ext: 0x78, in: 0x81, res: 0x02 },   // LSL is the same opcode as ASL
  { op: 'ROL', a: 0x49, b: 0x59, mem: 0x69, ext: 0x79, in: 0x81, res: 0x02 },
  { op: 'DEC', a: 0x4A, b: 0x5A, mem: 0x6A, ext: 0x7A, in: 0x02, res: 0x01 },
  { op: 'INC', a: 0x4C, b: 0x5C, mem: 0x6C, ext: 0x7C, in: 0x02, res: 0x03 },
  { op: 'TST', a: 0x4D, b: 0x5D, mem: 0x6D, ext: 0x7D, in: 0x80, res: 0x80, noStore: true },
  { op: 'CLR', a: 0x4F, b: 0x5F, mem: 0x6F, ext: 0x7F, in: 0x12, res: 0x00 },
];
for (const sh of SHIFT) {
  row(`${sh.op}A`, [sh.a], { a: sh.in, cc: CC1, reg: { a: sh.res }, flags: { same: ['H', 'I'] }, cycles: 2 });
  row(`${sh.op}B`, [sh.b], { b: sh.in, cc: CC1, reg: { b: sh.res }, flags: { same: ['H', 'I'] }, cycles: 2 });
  row(`${sh.op} indexed`, [sh.mem, 0x00], {
    x: 0x4000, cc: CC1, setup: (m) => { m[0x4000] = sh.in; },
    mem: { '$4000': sh.res }, flags: { same: ['H', 'I'] }, cycles: 6,
  });
  row(`${sh.op} extended`, [sh.ext, 0x40, 0x00], {
    cc: CC1, setup: (m) => { m[0x4000] = sh.in; },
    mem: { '$4000': sh.res }, flags: { same: ['H', 'I'] }, cycles: 6,
  });
}
// the shift flags proper, one row per flag, from the manual's prose ("V = N xor C after the shift")
// ASL: $81 -> $02, so C=1, N=0, V=1
row('ASLA sets C from bit 7 and V from N xor C', [0x48], { a: 0x81, cc: CC1, reg: { a: 0x02 }, flags: { set: ['C', 'V'], clear: ['N'] }, cycles: 2 });
// LSR: N is always cleared, C is bit 0 before, so V tracks C
row('LSRA sets C from bit 0 and clears N, V from N xor C', [0x44], { a: 0x81, cc: CC1, reg: { a: 0x40 }, flags: { set: ['C', 'V'], clear: ['N'] }, cycles: 2 });
row('LSRA with bit 0 clear clears C and V', [0x44], { a: 0x80, cc: CC1, reg: { a: 0x40 }, flags: { clear: ['N', 'C', 'V'] }, cycles: 2 });
// ROL: C out of bit 7, C in at bit 0. $80 with C set -> $01: N=0, C=1, V=1
row('ROLA takes C out of bit 7 and in at bit 0', [0x49], { a: 0x80, cc: CC1 | SET('C'), reg: { a: 0x01 }, flags: { set: ['C', 'V'], clear: ['N'] }, cycles: 2 });
// ROR: C out of bit 0, in at bit 7. $02 with C set -> $81: N=1, C=0, V=1
row('RORA takes C out of bit 0 and in at bit 7', [0x46], { a: 0x02, cc: CC1 | SET('C'), reg: { a: 0x81 }, flags: { set: ['N', 'V'], clear: ['C'] }, cycles: 2 });
// DEC overflows only on $80; INC only on $7F; neither touches C
row('DECA overflows on $80 only', [0x4A], { a: 0x80, cc: CC1 | SET('C'), reg: { a: 0x7F }, flags: { set: ['V'], clear: ['N', 'Z'], same: ['C'] }, cycles: 2 });
row('INCA overflows on $7F only', [0x4C], { a: 0x7F, cc: CC1 | SET('C'), reg: { a: 0x80 }, flags: { set: ['N', 'V'], clear: ['Z'], same: ['C'] }, cycles: 2 });
// CLR sets Z and clears N, V and C
row('CLRA sets Z and clears N, V, C', [0x4F], { a: 0x55, cc: CC1 | SET('N') | SET('V') | SET('C'), reg: { a: 0 }, flags: { set: ['Z'], clear: ['N', 'V', 'C'] }, cycles: 2 });
// COM: V cleared, C set
row('COMA clears V and sets C', [0x43], { a: 0x12, cc: CC1 | SET('V'), reg: { a: 0xED }, flags: { set: ['N', 'C'], clear: ['Z', 'V'] }, cycles: 2 });
// NEG: C set except on $00, V only on $80
row('NEGA overflows on $80 and sets C', [0x40], { a: 0x80, cc: CC1, reg: { a: 0x80 }, flags: { set: ['N', 'V', 'C'] }, cycles: 2 });
row('NEGA of $00 leaves C clear', [0x40], { a: 0x00, cc: CC1 | SET('C'), reg: { a: 0x00 }, flags: { set: ['Z'], clear: ['N', 'V', 'C'] }, cycles: 2 });
// TST: N and Z from the value, V and C both cleared, no store
row('TSTA sets N from the value, clears Z, V and C', [0x4D], { a: 0x80, cc: CC1 | SET('V') | SET('C'), reg: {}, flags: { set: ['N'], clear: ['Z', 'V', 'C'] }, cycles: 2 });

// ---- the double-accumulator shifts ----
// ASLD/LSLD is $05 and LSRD is $04, 3 cycles 1 byte (Table 4-1 and appendix A). N and Z from the result,
// V = N xor C after the shift, C is the bit shifted out of the 16-bit register.
row('ASLD shifts D left, C from bit 15', [0x05], { a: 0x80, b: 0x00, cc: CC1, reg: { a: 0x00, b: 0x00 }, flags: { set: ['Z', 'V', 'C'], clear: ['N'] }, cycles: 3 });
row('LSLD is ASLD', [0x05], { a: 0x40, b: 0x00, cc: CC1, reg: { a: 0x80, b: 0x00 }, flags: { set: ['N', 'V'], clear: ['Z', 'C'] }, cycles: 3 });
row('LSRD shifts D right, C from bit 0, N always cleared', [0x04], { a: 0x00, b: 0x01, cc: CC1, reg: { a: 0x00, b: 0x00 }, flags: { set: ['Z', 'V', 'C'], clear: ['N'] }, cycles: 3 });

// ---- the accumulator and index/stack-pointer inherent instructions ----
const KEEP = { same: ['H', 'I', 'N', 'Z', 'V', 'C'] };
row('CBA subtracts B from A and sets the flags', [0x11], { a: 0x12, b: 0x0F, cc: CC1, reg: {}, flags: { clear: ['N', 'Z', 'V', 'C'] }, cycles: 2 });
row('SBA is CBA', [0x10], { a: 0x12, b: 0x0F, cc: CC1, reg: {}, flags: { clear: ['N', 'Z', 'V', 'C'] }, cycles: 2 });
row('ABA adds B to A', [0x1B], { a: 0x12, b: 0x0F, cc: CC1, reg: { a: 0x21 }, flags: { clear: ['N', 'Z', 'V', 'C'] }, cycles: 2 });
row('TAB copies A to B and clears V', [0x16], { a: 0x80, cc: CC1 | SET('V'), reg: { b: 0x80 }, flags: { set: ['N'], clear: ['Z', 'V'] }, cycles: 2 });
row('TBA copies B to A and clears V', [0x17], { a: 0x00, b: 0x00, cc: CC1 | SET('V'), reg: { a: 0x00 }, flags: { set: ['Z'], clear: ['N', 'V'] }, cycles: 2 });
// MUL is 10 cycles (appendix A; Table 4-1 also says 10 E-cycles) and the manual's only affected flag is
// C, taken from bit 7 of the low byte of the product ("C: Set if bit 7 of result (ACCB B7) is set"); N, Z
// and V are "not affected".
row('MUL multiplies the accumulators into D, C from bit 7 of the low byte', [0x3D], { a: 0x10, b: 0x10, cc: CC1, reg: { a: 0x01, b: 0x00 }, flags: { same: ['N', 'Z', 'V'], clear: ['C'] }, cycles: 10 });
row('MUL sets C when bit 7 of the low byte is set', [0x3D], { a: 0x10, b: 0x0C, cc: CC1, reg: { a: 0x00, b: 0xC0 }, flags: { set: ['C'], same: ['N', 'Z', 'V'] }, cycles: 10 });
// DAA: operates on A and C. The manual's V column says "not defined", so V is not checked.
row('DAA adds six when the low digit is above nine', [0x19], { a: 0x1A, cc: CC1, reg: { a: 0x20 }, flags: { clear: ['N', 'Z'] }, cycles: 2 });
row('DAA fixes up an addition that carried out of a digit', [0x19], { a: 0x9A, cc: CC1, reg: { a: 0x00 }, flags: { set: ['Z', 'C'], clear: ['N'] }, cycles: 2 });

// ABX adds B to X and affects no flag; DEX/INX affect only Z
row('ABX adds B to X and affects no flag', [0x3A], { x: 0x4000, b: 0x05, cc: CC1 | SET('N') | SET('V') | SET('C'), reg: { x: 0x4005 }, flags: KEEP, cycles: 3 });
row('INX affects only Z', [0x08], { x: 0xFFFF, cc: CC1 | SET('N') | SET('C'), reg: { x: 0x0000 }, flags: { set: ['Z'], same: ['H', 'N', 'V', 'C'] }, cycles: 3 });
row('DEX affects only Z', [0x09], { x: 0x0001, cc: CC1 | SET('N') | SET('C'), reg: { x: 0x0000 }, flags: { set: ['Z'], same: ['H', 'N', 'V', 'C'] }, cycles: 3 });

// ---- the condition-code instructions ----
// Appendix A: CLC/CLI/CLV/SEC/SEI/SEV are 2 cycles and 1 byte, and each changes only its own bit.
row('CLC clears C only', [0x0C], { cc: CC1 | SET('V') | SET('C') | SET('I') | SET('N'), flags: { clear: ['C'], same: ['H', 'I', 'N', 'Z', 'V'] }, cycles: 2 });
row('CLV clears V only', [0x0A], { cc: CC1 | SET('V') | SET('C') | SET('N'), flags: { clear: ['V'], same: ['H', 'I', 'N', 'Z', 'C'] }, cycles: 2 });
row('SEC sets C only', [0x0D], { cc: CC1, flags: { set: ['C'], same: ['H', 'N', 'Z', 'V'] }, cycles: 2 });
row('SEV sets V only', [0x0B], { cc: CC1, flags: { set: ['V'], same: ['H', 'N', 'Z', 'C'] }, cycles: 2 });
row('CLI clears I only', [0x0E], { cc: CC1 | SET('I') | SET('C'), flags: { clear: ['I'], same: ['H', 'N', 'Z', 'V', 'C'] }, cycles: 2 });
row('SEI sets I only', [0x0F], { cc: CC1 | SET('C'), flags: { set: ['I'], same: ['H', 'N', 'Z', 'V', 'C'] }, cycles: 2 });
// TPA copies CC to A, with A's bits 6-7 read as 1 ("Bit positions 6 and 7 of Accumulator A are
// effectively read as 1's", appendix A). A legal CC already has both set, so the row checks the whole byte.
row('TPA copies CC to A with the top two bits set', [0x07], { cc: CC1 | SET('H') | SET('I') | SET('N') | SET('Z') | SET('V') | SET('C'), reg: { a: 0xFF }, flags: KEEP, cycles: 2 });
// TAP copies A's bits 0-5 into CC; bits 6-7 of CC read as 1, so A=$00 leaves CC=$C0
row('TAP copies A into CC with the top two bits fixed at 1', [0x06], { a: 0x00, cc: CC1 | SET('I'), reg: { cc: CC1 }, flags: { clear: ['I'] }, cycles: 2 });

// ---- the stack instructions ----
// PSH stores at S and then decrements; PUL increments then loads (appendix A, PSH and PUL).
row('PSHA stores A at S and decrements', [0x36], { a: 0x55, s: 0x8000, cc: CC1 | SET('N') | SET('C'), mem: { '$8000': 0x55 }, reg: { s: 0x7FFF }, flags: KEEP, cycles: 3 });
row('PSHB stores B at S and decrements', [0x37], { b: 0x66, s: 0x8000, mem: { '$8000': 0x66 }, reg: { s: 0x7FFF }, flags: KEEP, cycles: 3 });
row('PULA increments S and loads A', [0x32], { s: 0x7FFF, setup: (m) => { m[0x8000] = 0x77; }, reg: { a: 0x77, s: 0x8000 }, flags: KEEP, cycles: 4 });
row('PULB increments S and loads B', [0x33], { s: 0x7FFF, setup: (m) => { m[0x8000] = 0x88; }, reg: { b: 0x88, s: 0x8000 }, flags: KEEP, cycles: 4 });
// PSHX pushes IXL then IXH: with S=$8000, IXL lands at $8000 and IXH at $7FFF
row('PSHX pushes X low byte then high', [0x3C], { x: 0x1234, s: 0x8000, mem: { '$8000': 0x34, '$7FFF': 0x12 }, reg: { s: 0x7FFE }, flags: KEEP, cycles: 4 });
row('PULX pulls X high byte then low', [0x38], { s: 0x7FFE, setup: (m) => { m[0x7FFF] = 0x12; m[0x8000] = 0x34; }, reg: { x: 0x1234, s: 0x8000 }, flags: KEEP, cycles: 5 });
row('TSX copies S+1 to X', [0x30], { s: 0x0FFE, reg: { x: 0x0FFF }, flags: KEEP, cycles: 3 });
row('TXS copies X-1 to S', [0x35], { x: 0x2001, reg: { s: 0x2000 }, flags: KEEP, cycles: 3 });
row('INS increments S only', [0x31], { s: 0x1000, cc: CC1 | SET('N') | SET('C'), reg: { s: 0x1001 }, flags: KEEP, cycles: 3 });
row('DES decrements S only', [0x34], { s: 0x1000, cc: CC1 | SET('N') | SET('C'), reg: { s: 0x0FFF }, flags: KEEP, cycles: 3 });
row('RTS pulls the return address', [0x39], { s: 0x8000, setup: (m) => { m[0x8001] = 0x20; m[0x8002] = 0x00; }, reg: { pc: 0x2000, s: 0x8002 }, flags: KEEP, cycles: 5 });
// BSR at $1000 is two bytes, so it pushes $1002; PSH order is low byte first, so $1002 -> $8000=02, $7FFF=10
row('BSR pushes the return address and branches', [0x8D, 0x02], {
  cc: CC1, reg: { pc: 0x1004, s: 0x7FFE }, mem: { '$8000': 0x02, '$7FFF': 0x10 }, flags: KEEP, cycles: 6,
});
// JSR direct: the operand byte is the target address in page zero (the 6801's added direct mode)
row('JSR direct pushes the return address and jumps to the page-zero address', [0x9D, 0x40], {
  cc: CC1, reg: { pc: 0x0040, s: 0x7FFE }, mem: { '$8000': 0x02, '$7FFF': 0x10 }, flags: KEEP, cycles: 5,
});
row('JMP extended', [0x7E, 0x20, 0x00], { cc: CC1, reg: { pc: 0x2000 }, flags: KEEP, cycles: 3 });
row('JMP indexed', [0x6E, 0x10], { x: 0x2000, cc: CC1, reg: { pc: 0x2010 }, flags: KEEP, cycles: 3 });

// ---- the branches ----
// Every 6803 branch is 2 bytes and 3 cycles (Figure 4-2 and appendix A); the 6801 family has no long
// branches. The offset is +2, so a branch not taken leaves PC at $1002 and a branch taken at $1004.
const BRANCH = [
  { o: 0x20, n: 'BRA', taken: CC1 }, { o: 0x21, n: 'BRN', not: CC1 },
  { o: 0x22, n: 'BHI', taken: CC1, not: CC1 | SET('C') }, { o: 0x23, n: 'BLS', taken: CC1 | SET('C'), not: CC1 },
  { o: 0x24, n: 'BCC', taken: CC1, not: CC1 | SET('C') }, { o: 0x25, n: 'BCS', taken: CC1 | SET('C'), not: CC1 },
  { o: 0x26, n: 'BNE', taken: CC1, not: CC1 | SET('Z') }, { o: 0x27, n: 'BEQ', taken: CC1 | SET('Z'), not: CC1 },
  { o: 0x28, n: 'BVC', taken: CC1, not: CC1 | SET('V') }, { o: 0x29, n: 'BVS', taken: CC1 | SET('V'), not: CC1 },
  { o: 0x2A, n: 'BPL', taken: CC1, not: CC1 | SET('N') }, { o: 0x2B, n: 'BMI', taken: CC1 | SET('N'), not: CC1 },
  { o: 0x2C, n: 'BGE', taken: CC1, not: CC1 | SET('N') }, { o: 0x2D, n: 'BLT', taken: CC1 | SET('N'), not: CC1 },
  { o: 0x2E, n: 'BGT', taken: CC1, not: CC1 | SET('Z') }, { o: 0x2F, n: 'BLE', taken: CC1 | SET('Z'), not: CC1 },
];
for (const b of BRANCH) {
  if (b.taken !== undefined) row(`${b.n} taken`, [b.o, 0x02], { cc: b.taken, reg: { pc: 0x1004 }, flags: { same: ['H', 'I', 'N', 'Z', 'V', 'C'] }, cycles: 3 });
  if (b.not !== undefined) row(`${b.n} not taken`, [b.o, 0x02], { cc: b.not, reg: { pc: 0x1002 }, flags: { same: ['H', 'I', 'N', 'Z', 'V', 'C'] }, cycles: 3 });
}

// ---- SWI, WAI and RTI ----
// The manual's SWI worked example fixes the frame. An SWI at $EFFF with S=$EFFF leaves S=$EFF8 and, from
// low to high address, $EFF9 = CC, $EFFA = ACCB, $EFFB = ACCA, $EFFC = IXH, $EFFD = IXL, $EFFE = PCH,
// $EFFF = PCL (the push order is PCL, PCH, IXL, IXH, ACCA, ACCB, CCR, each followed by S = S-1).
// With S=$8000 and the SWI at $1000 (PC already $1001 when the frame is pushed), that is:
//   $8000 PCL  $7FFF PCH  $7FFE IXL  $7FFD IXH  $7FFC ACCA  $7FFB ACCB  $7FFA CC   and S ends at $7FF9
// The stacked CC is the one from *before* the SWI: the manual pushes the CCR first and sets I after
// ("The condition code register is then pushed ... The interrupt mask bit is then set"), so the frame
// holds no I bit that the programmer did not already have.
row('SWI stacks the frame in the manual order, sets I and vectors', [0x3F], {
  a: 0x34, b: 0x12, x: 0x5678, s: 0x8000, cc: CC1 | SET('Z'),
  setup: (m) => { m[0xFFFA] = 0x20; m[0xFFFB] = 0x00; },
  reg: { pc: 0x2000, s: 0x7FF9 },
  mem: { '$8000': 0x01, '$7FFF': 0x10, '$7FFE': 0x78, '$7FFD': 0x56, '$7FFC': 0x34, '$7FFB': 0x12, '$7FFA': CC1 | SET('Z') },
  flags: { set: ['I'], same: ['H', 'N', 'Z', 'V', 'C'] }, cycles: 12,
});
// WAI pushes the same frame and waits (9 cycles). PC is $1001 when it pushes, and I is not set (the
// manual: the I bit is "not affected until the 10th E-cycle of the interrupt sequence")
row('WAI stacks the frame and waits', [0x3E], {
  a: 0x34, b: 0x12, x: 0x5678, s: 0x8000, cc: CC1 | SET('Z'),
  reg: { s: 0x7FF9 },
  mem: { '$8000': 0x01, '$7FFF': 0x10, '$7FFE': 0x78, '$7FFD': 0x56, '$7FFC': 0x34, '$7FFB': 0x12, '$7FFA': CC1 | SET('Z') },
  flags: KEEP, cycles: 9,
});
// RTI pulls in the reverse order (CC, ACCB, ACCA, IXH, IXL, PCH, PCL), each pull doing S = S+1 first, so
// the first byte read is at S+1. 10 cycles (appendix A).
row('RTI pulls the frame back in the manual order', [0x3B], {
  s: 0x7FFA, cc: CC1,
  setup: (m) => { m[0x7FFB] = CC1 | SET('Z'); m[0x7FFC] = 0x12; m[0x7FFD] = 0x34; m[0x7FFE] = 0x56; m[0x7FFF] = 0x78; m[0x8000] = 0x10; m[0x8001] = 0x02; },
  reg: { pc: 0x1002, a: 0x34, b: 0x12, x: 0x5678, s: 0x8001 },
  flags: { set: ['Z'] }, cycles: 10,
});

// ---- NOP ----
row('NOP', [0x01], { cc: CC1 | SET('N') | SET('C'), flags: KEEP, cycles: 2 });

// ---- the run: every row, one instruction, against the manual ----
for (const r of rows) {
  const got = runOnce(r);
  for (const [k, v] of Object.entries(r.reg || {})) is(`${r.name}: ${k}`, got.cpu[k] & (k === 'a' || k === 'b' ? 0xFF : 0xFFFF), v);
  for (const [addr, v] of Object.entries(r.mem || {})) is(`${r.name}: memory ${addr}`, got.mem[parseInt(addr.slice(1), 16)], v);
  const before = r.cc ?? CC1;
  for (const f of (r.flags && r.flags.set) || []) is(`${r.name}: ${f} set`, (got.cpu.cc & SET(f)) !== 0, true);
  for (const f of (r.flags && r.flags.clear) || []) is(`${r.name}: ${f} clear`, (got.cpu.cc & SET(f)) !== 0, false);
  for (const f of (r.flags && r.flags.same) || []) is(`${r.name}: ${f} unchanged`, (got.cpu.cc & SET(f)) !== 0, (before & SET(f)) !== 0);
  if (r.cycles !== undefined) is(`${r.name}: cycles`, got.cycles, r.cycles);
}

console.log(`${count - failures}/${count} checks passed (${rows.length} instructions)`);
process.exitCode = failures ? 1 : 0;
