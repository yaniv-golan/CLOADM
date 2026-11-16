// Per-opcode coverage of the 6809 core, table-driven: each row is one instruction, its bytes, the registers it
// should leave, the flags it sets and clears, and its cycle count.
//
// WHERE THE VALUES COME FROM: the Motorola MC6809 / MC6809E data sheet (Motorola, 1982; the "MC6809E
// Microprocessor" chapter), its instruction-set summary tables: the opcode map for the byte encoding, the
// "Instruction Set" table for the mnemonic-to-addressing-mode rows and cycle counts, and the effect table's
// condition-code columns (H N Z V C, marked "~" for affected, "-" for unchanged, "0"/"1" for always cleared
// or set, "?" for undefined). The assembler's own table is NOT used to generate expectations: bytes are
// written out here, so an assembler bug cannot make this test agree with it.
//
// The flags column is the check that matters as much as the result: operators that must leave a flag alone
// (LDA/LDX/LDU and the loads, stores, TFR/EXG, pushes and pulls, branches) are checked for leaving it alone,
// which the hash gate cannot detect.
const Emu = require('./load')();
const { CPU6809 } = Emu;
const F = CPU6809.FLAGS;

let failures = 0, count = 0;
const hex = (v) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');
function is(name, got, want) {
  count++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${hex(got)} want ${hex(want)}`); }
}

// A machine: memory, the program at $1000, and the bus the CPU runs on. Registers are set as the row says.
const END = [0x20, 0xFE];   // BRA * : the sentinel end of every program
function runOnce(row) {
  const mem = new Uint8Array(0x10000);
  mem.set(row.bytes, 0x1000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;   // reset -> $1000
  if (row.setup) row.setup(mem);
  const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  cpu.s = row.s ?? 0x8000; cpu.u = row.u ?? 0x8000;
  cpu.a = row.a ?? 0; cpu.b = row.b ?? 0; cpu.x = row.x ?? 0; cpu.y = row.y ?? 0; cpu.dp = row.dp ?? 0;
  cpu.cc = row.cc ?? 0;
  const cycles = cpu.step();      // exactly the one instruction
  return { cpu, mem, cycles };
}

// The rows. bytes: the encoded instruction. want: what must be true after it runs.
//   reg: { a, b, x, y, u, s, pc, cc } partial; flags: { set: [...], clear: [...], same: [...] }
const SET = (n) => F[n];   // F already holds the bit value (N = 8, Z = 4, ...)
const rows = [];
const row = (name, bytes, want = {}) => rows.push(Object.assign({ name, bytes }, want));

// ---- the eight-bit arithmetic/logic family, each in immediate, direct, indexed and extended ----
// The flag effect strings are Table D-1's own columns for every row, in the order H N Z V C. Table D-1's
// legend (programming manual appendix D) defines the marks: "-" not affected, "a" set or cleared by the
// operation (the "Test and set if true, cleared otherwise" entry), "u" undefined, "0"/"1" always cleared or
// set, and "s" the special case "Carry set if b7 is SET" (MUL). So:
//   SUBA/CMPA/SBCA  "-uaaa"   (H undefined on the sheet, so it is not asserted)
//   ANDA/BITA/EORA/ORA/LDA  "-aa0-"    ADCA "-aaaa"
//   STA "-aa0-"   (V in the always-cleared position, agreeing with our core and MAME)
//   MUL  "--a-a" with C's "s" rule; TST "-aa0-"; NEG "-uaaa"; COM "-aa01"; CLR "-0100"
//   LSR "-0a-s"  ASR "-aa-s"  ASL "-aaas"  ROL "-aaas"  ROR "-aa-s"  DEC/INC "-aaa-"
const ALU = [
  // mnemonic, opcodes { imm, dir, idx, ext }, result for A = $12 and memory = $0F, and the sheet's HNZVC
  { op: 'SUBA', o: [0x80, 0x90, 0xA0, 0xB0], res: 0x12 - 0x0F, eff: '-uaaa' },
  { op: 'CMPA', o: [0x81, 0x91, 0xA1, 0xB1], res: 0x12 - 0x0F, eff: '-uaaa', noStore: true },
  { op: 'SBCA', o: [0x82, 0x92, 0xA2, 0xB2], res: 0x12 - 0x0F, eff: '-uaaa' },
  { op: 'ANDA', o: [0x84, 0x94, 0xA4, 0xB4], res: 0x12 & 0x0F, eff: '-aa0-' },
  { op: 'BITA', o: [0x85, 0x95, 0xA5, 0xB5], res: 0x12 & 0x0F, eff: '-aa0-', noStore: true },
  { op: 'LDA',  o: [0x86, 0x96, 0xA6, 0xB6], res: 0x0F, eff: '-aa0-' },
  { op: 'STA',  o: [null, 0x97, 0xA7, 0xB7], res: 0x0F, eff: '-aa0-', store: true },
  { op: 'EORA', o: [0x88, 0x98, 0xA8, 0xB8], res: 0x12 ^ 0x0F, eff: '-aa0-' },
  { op: 'ADCA', o: [0x89, 0x99, 0xA9, 0xB9], res: 0x12 + 0x0F, eff: 'aaaaa' },
  { op: 'ORA',  o: [0x8A, 0x9A, 0xAA, 0xBA], res: 0x12 | 0x0F, eff: '-aa0-' },
  { op: 'ADDA', o: [0x8B, 0x9B, 0xAB, 0xBB], res: 0x12 + 0x0F, eff: 'aaaaa' },
];
// The memory each addressing mode reads, from the data sheet's mode definitions: direct uses DP:$xx
// ($40 here, DP=0), indexed ,X uses the address in X ($4000), extended names $4000. One setup for every row.
const MODE_MEM = 0x0F;
const setupModes = (mem) => { mem[0x40] = MODE_MEM; mem[0x4000] = MODE_MEM; };

// The five flags in H N Z V C order, turned into a row's set/clear/same lists. "a" is decided here from the
// data sheet's own definition of each bit, applied to the operands this row uses: N = bit 7 of the result,
// Z = the result is zero, V = the sign of the operands and result disagree (arithmetic) or N xor C (shifts),
// C = carry out / borrow (arithmetic) or the bit shifted out. H is only asserted for the operators whose
// effect column marks it "a" (ADC/ADD), from the carry out of bit 3.
function flagLists(eff, r, h, v, c) {
  const set = [], clear = [], same = [];
  const bit = { N: !!(r & 0x80), Z: r === 0, V: !!v, C: !!c, H: !!h };
  ['H', 'N', 'Z', 'V', 'C'].forEach((f) => {
    const kind = eff['HNZVC'.indexOf(f)];
    if (kind === '-') same.push(f);
    else if (kind === '0') clear.push(f);
    else if (kind === '1') set.push(f);
    else if (kind === 'a') (bit[f] ? set : clear).push(f);
    // "u" (undefined) is not asserted
  });
  return { set, clear, same };
}
const modes = [
  { m: 'immediate', i: 0, len: 2, cyc: 2 },
  { m: 'direct', i: 1, len: 2, cyc: 4 },
  { m: 'indexed', i: 2, len: 2, cyc: 4, idx: true },     // ,X no offset: the data sheet's "+" (no extra cycle)
  { m: 'extended', i: 3, len: 3, cyc: 5 },   // data sheet: 5, not 6 (the 6 is the read-modify-write forms)
];
// Both carry-in cases: the rows run once with every flag clear (carry in = 0) and once with every flag set
// (carry in = 1). A "cleared" check against an already-clear flag proves nothing, so the second run is what
// makes the table's V, C and H columns mean something.
for (const al of ALU) {
  for (const md of modes) {
    const opcode = al.o[md.i];
    if (opcode === null) continue;                          // STA has no immediate form
    const bytes = md.i === 0 ? [opcode, 0x0F]
      : md.m === 'direct' ? [opcode, 0x40]
      : md.i === 2 ? [opcode, 0x84]                          // ,X
      : [opcode, 0x40, 0x00];
    for (const cin of [0, 1]) {
      // the expected result and flags, worked out here from the data sheet's definitions
      const a = 0x12, m = 0x0F;
      let r, h, v, c;
      switch (al.op) {
        case 'SUBA': case 'CMPA': r = (a - m) & 0xFF; h = 0;
          v = ((a ^ m) & (a ^ r) & 0x80) !== 0; c = a < m; break;
        case 'SBCA': r = (a - m - cin) & 0xFF; h = 0;
          v = ((a ^ m) & (a ^ r) & 0x80) !== 0; c = a < m + cin; break;
        case 'ADCA': r = (a + m + cin) & 0xFF;
          h = ((a ^ m ^ r) & 0x10) !== 0;
          v = ((a ^ r) & (m ^ r) & 0x80) !== 0; c = (a + m + cin) > 0xFF; break;
        case 'ADDA': r = (a + m) & 0xFF; h = ((a ^ m ^ r) & 0x10) !== 0;
          v = ((a ^ r) & (m ^ r) & 0x80) !== 0; c = (a + m) > 0xFF; break;
        default: r = al.res & 0xFF; h = 0; v = 0; c = 0; break;   // the logic operators: V and C are "0"
      }
      const want = al.store
        ? { mem: { [md.i === 1 ? '$40' : '$4000']: 0x12 }, reg: { a: 0x12 } }   // STA writes A, A unchanged
        : { reg: { a: al.noStore ? 0x12 : r } };
      const fl = flagLists(al.eff, r, h, v, c);
      want.flags = { same: fl.same.concat(['I', 'F']), set: fl.set, clear: fl.clear };
      const tag = cin ? ' (carry in set, all flags set)' : '';
      row(`${al.op} ${md.m}${tag}`, bytes, Object.assign({}, want, {
        a, x: 0x4000, dp: 0, cc: cin ? 0xFF : 0, setup: setupModes, cycles: md.cyc,
      }));
    }
  }
}

// ---- the same family, B accumulator (Table D-1 gives the same effect strings and cycles as the A forms) ----
const ALUB = [
  { op: 'SUBB', o: [0xC0, 0xD0, 0xE0, 0xF0], res: 0x12 - 0x0F, eff: '-uaaa' },
  { op: 'CMPB', o: [0xC1, 0xD1, 0xE1, 0xF1], res: 0x12 - 0x0F, eff: '-uaaa', noStore: true },
  { op: 'SBCB', o: [0xC2, 0xD2, 0xE2, 0xF2], res: 0x12 - 0x0F, eff: '-uaaa' },
  { op: 'ANDB', o: [0xC4, 0xD4, 0xE4, 0xF4], res: 0x12 & 0x0F, eff: '-aa0-' },
  { op: 'BITB', o: [0xC5, 0xD5, 0xE5, 0xF5], res: 0x12 & 0x0F, eff: '-aa0-', noStore: true },
  { op: 'LDB',  o: [0xC6, 0xD6, 0xE6, 0xF6], res: 0x0F, eff: '-aa0-' },
  { op: 'STB',  o: [null, 0xD7, 0xE7, 0xF7], res: 0x0F, eff: '-aa0-', store: true },
  { op: 'EORB', o: [0xC8, 0xD8, 0xE8, 0xF8], res: 0x12 ^ 0x0F, eff: '-aa0-' },
  { op: 'ADCB', o: [0xC9, 0xD9, 0xE9, 0xF9], res: 0x12 + 0x0F, eff: 'aaaaa' },
  { op: 'ORB',  o: [0xCA, 0xDA, 0xEA, 0xFA], res: 0x12 | 0x0F, eff: '-aa0-' },
  { op: 'ADDB', o: [0xCB, 0xDB, 0xEB, 0xFB], res: 0x12 + 0x0F, eff: 'aaaaa' },
];
for (const al of ALUB) {
  for (const md of modes) {
    const opcode = al.o[md.i];
    if (opcode === null) continue;
    const bytes = md.i === 0 ? [opcode, 0x0F]
      : md.m === 'direct' ? [opcode, 0x40]
      : md.i === 2 ? [opcode, 0x84]
      : [opcode, 0x40, 0x00];
    for (const cin of [0, 1]) {
      const b = 0x12, m = 0x0F;
      let r, h, v, c;
      switch (al.op) {
        case 'SUBB': case 'CMPB': r = (b - m) & 0xFF; h = 0;
          v = ((b ^ m) & (b ^ r) & 0x80) !== 0; c = b < m; break;
        case 'SBCB': r = (b - m - cin) & 0xFF; h = 0;
          v = ((b ^ m) & (b ^ r) & 0x80) !== 0; c = b < m + cin; break;
        case 'ADCB': r = (b + m + cin) & 0xFF;
          h = ((b ^ m ^ r) & 0x10) !== 0;
          v = ((b ^ r) & (m ^ r) & 0x80) !== 0; c = (b + m + cin) > 0xFF; break;
        case 'ADDB': r = (b + m) & 0xFF; h = ((b ^ m ^ r) & 0x10) !== 0;
          v = ((b ^ r) & (m ^ r) & 0x80) !== 0; c = (b + m) > 0xFF; break;
        default: r = al.res & 0xFF; h = 0; v = 0; c = 0; break;
      }
      const want = al.store
        ? { mem: { [md.i === 1 ? '$40' : '$4000']: 0x12 }, reg: { b: 0x12 } }   // STB writes B, B unchanged
        : { reg: { b: al.noStore ? 0x12 : r } };
      const fl = flagLists(al.eff, r, h, v, c);
      want.flags = { same: fl.same.concat(['I', 'F']), set: fl.set, clear: fl.clear };
      const tag = cin ? ' (carry in set, all flags set)' : '';
      row(`${al.op} ${md.m}${tag}`, bytes, Object.assign({}, want, {
        b, x: 0x4000, dp: 0, cc: cin ? 0xFF : 0, setup: setupModes, cycles: md.cyc,
      }));
    }
  }
}

// ---- the sixteen-bit memory and register forms, every addressing mode ----
// Table D-1 ("Programming Aid") of the Motorola MC6809 programming manual gives the base cycles
// [immediate, direct, indexed, extended] for each; an indexed row's final "+" means add the indexed
// mode's extra cycles from the postbyte table (zero for ,X). Effect strings: SUBD/ADDD/CMPX/CMPD/CMPY/
// CMPU/CMPS "-aaaa" (H unaffected); LDD/LDX/LDU/LDY/LDS/STD/STX/STU/STY/STS "-aa0-" (V in the
// always-cleared position, H and C unaffected; see the note on the STX row below).
//
// Indexed rows use an index register other than the one under test, so that the register holding the
// value and the register forming the address cannot be confused: LDX/STX/CMPX index through Y, the
// rest through X.
const M16 = [
  // page 0 (single-byte opcodes)
  { n: 'SUBD', o: [[0x83], [0x93], [0xA3], [0xB3]], cyc: [4, 6, 6, 7], k: 'cmpD', r: 'd' },
  { n: 'ADDD', o: [[0xC3], [0xD3], [0xE3], [0xF3]], cyc: [4, 6, 6, 7], k: 'addD', r: 'd' },
  { n: 'CMPX', o: [[0x8C], [0x9C], [0xAC], [0xBC]], cyc: [4, 6, 6, 7], k: 'cmpX', r: 'x', viaY: true },
  { n: 'LDD',  o: [[0xCC], [0xDC], [0xEC], [0xFC]], cyc: [3, 5, 5, 6], k: 'load', r: 'd' },
  { n: 'STD',  o: [null, [0xDD], [0xED], [0xFD]],   cyc: [3, 5, 5, 6], k: 'store', r: 'd' },
  { n: 'LDX',  o: [[0x8E], [0x9E], [0xAE], [0xBE]], cyc: [3, 5, 5, 6], k: 'load', r: 'x', viaY: true },
  { n: 'STX',  o: [null, [0x9F], [0xAF], [0xBF]],   cyc: [3, 5, 5, 6], k: 'store', r: 'x', viaY: true },
  { n: 'LDU',  o: [[0xCE], [0xDE], [0xEE], [0xFE]], cyc: [3, 5, 5, 6], k: 'load', r: 'u' },
  { n: 'STU',  o: [null, [0xDF], [0xEF], [0xFF]],   cyc: [3, 5, 5, 6], k: 'store', r: 'u' },
  // page 2 ($10 prefixed): the D, Y and S families
  { n: 'CMPD', o: [[0x10, 0x83], [0x10, 0x93], [0x10, 0xA3], [0x10, 0xB3]], cyc: [5, 7, 7, 8], k: 'cmpD', r: 'd' },
  { n: 'CMPY', o: [[0x10, 0x8C], [0x10, 0x9C], [0x10, 0xAC], [0x10, 0xBC]], cyc: [5, 7, 7, 8], k: 'cmp', r: 'y' },
  { n: 'LDY',  o: [[0x10, 0x8E], [0x10, 0x9E], [0x10, 0xAE], [0x10, 0xBE]], cyc: [4, 6, 6, 7], k: 'load', r: 'y' },
  { n: 'STY',  o: [null, [0x10, 0x9F], [0x10, 0xAF], [0x10, 0xBF]], cyc: [4, 6, 6, 7], k: 'store', r: 'y' },
  { n: 'LDS',  o: [[0x10, 0xCE], [0x10, 0xDE], [0x10, 0xEE], [0x10, 0xFE]], cyc: [4, 6, 6, 7], k: 'load', r: 's' },
  { n: 'STS',  o: [null, [0x10, 0xDF], [0x10, 0xEF], [0x10, 0xFF]], cyc: [4, 6, 6, 7], k: 'store', r: 's' },
  // page 3 ($11 prefixed): CMPU and CMPS
  { n: 'CMPU', o: [[0x11, 0x83], [0x11, 0x93], [0x11, 0xA3], [0x11, 0xB3]], cyc: [5, 7, 7, 8], k: 'cmp', r: 'u' },
  { n: 'CMPS', o: [[0x11, 0x8C], [0x11, 0x9C], [0x11, 0xAC], [0x11, 0xBC]], cyc: [5, 7, 7, 8], k: 'cmp', r: 's' },
];
const OPERAND = 0x0102;          // the value every mode supplies
const STORE_VAL = 0x1234;        // what a store puts in memory (N=0, Z=0)
const modes16 = [
  { m: 'immediate', i: 0, fmt: () => [0x01, 0x02] },
  { m: 'direct', i: 1, fmt: () => [0x40] },
  { m: 'indexed', i: 2, fmt: (t) => [t.viaY ? 0xA4 : 0x84] },   // ,Y or ,X
  { m: 'extended', i: 3, fmt: () => [0x40, 0x00] },
];
const setup16 = (mem) => { mem[0x40] = 0x01; mem[0x41] = 0x02; mem[0x4000] = 0x01; mem[0x4001] = 0x02; };
for (const t of M16) {
  for (const md of modes16) {
    const ops = t.o[md.i];
    if (!ops) continue;                                        // the stores have no immediate form
    const bytes = [...ops, ...md.fmt(t)];
    // the register under test starts at the value the row needs: a store carries STORE_VAL, a compare
    // carries the operand (so the mode rows all end with an equal comparison: Z set, nothing else), a
    // load starts clear and must receive the operand
    const start = t.k === 'store' ? STORE_VAL : t.k === 'load' || t.k === 'addD' ? 0 : OPERAND;
    // every row starts with H, V and C set, so that a "cleared" flag is checked against a set one and
    // an "unaffected" flag is checked against a set one (the table's "-aa0-" and "-aaaa" columns)
    const s = { a: 0, b: 0, x: 0x4000, y: 0x4000, u: 0, cc: SET('H') | SET('V') | SET('C'), dp: 0, setup: setup16 };
    if (t.r === 'd') { s.a = start >> 8; s.b = start & 0xFF; } else s[t.r] = start;
    if (t.viaY) { s.y = 0x4000; s.x = start; }                 // LDX/STX/CMPX index through Y
    const want = { flags: { same: ['H', 'C'] }, cycles: t.cyc[md.i] };
    if (t.k === 'load') {
      if (t.r === 'd') { s.a = 0; s.b = 0; want.reg = { a: 0x01, b: 0x02 }; }
      else { s[t.r] = 0; want.reg = { [t.r]: OPERAND }; }
      want.flags.clear = ['N', 'Z'];
    } else if (t.k === 'addD') {
      want.reg = { a: 0x01, b: 0x02 };                         // D starts 0, so the sum is the operand
      want.flags.same = ['H'];                                 // ADDD "-aaaa": C is affected, H is not
      want.flags.clear = ['N', 'Z', 'V', 'C'];
    } else if (t.k === 'store') {
      want.mem = { [md.i === 1 ? '$40' : '$4000']: 0x12, [md.i === 1 ? '$41' : '$4001']: 0x34 };
      if (t.r === 'd') want.reg = { a: 0x12, b: 0x34 }; else want.reg = { [t.r]: STORE_VAL };
      // table D-1 "-aa0-": N and Z from the value, V in the always-cleared position, H and C unaffected
      want.flags.clear = ['N', 'Z', 'V'];
    } else {                                                   // cmpD / cmpX / cmp
      want.flags.same = ['H'];                                 // "-aaaa": C is affected, H is not
      want.flags.set = ['Z']; want.flags.clear = ['N', 'V', 'C'];
    }
    row(`${t.n} ${md.m}`, bytes, Object.assign(s, want));
  }
}
// the sixteen-bit compare flags, one row per flag, from operands chosen so only that flag can change.
// CMPD compares D with M:M+1 and sets N Z V C from the subtraction D - M (Table D-1 "-aaaa").
row('CMPD sets C on borrow', [0x10, 0x83, 0x02, 0x00], { a: 0x01, b: 0x00, cc: 0, reg: {}, flags: { set: ['N', 'C'], clear: ['Z'] }, cycles: 5 });
row('CMPD sets V on signed overflow', [0x10, 0x83, 0x00, 0x01], { a: 0x80, b: 0x00, cc: 0, reg: {}, flags: { set: ['V'], clear: ['N', 'Z', 'C'] }, cycles: 5 });
row('CMPD sets Z when equal', [0x10, 0x83, 0x12, 0x34], { a: 0x12, b: 0x34, cc: 0, reg: {}, flags: { set: ['Z'], clear: ['N', 'V', 'C'] }, cycles: 5 });
// CMPU compares U (page 3), CMPS compares S; neither writes a register
row('CMPU compares U', [0x11, 0x83, 0x02, 0x00], { u: 0x0100, cc: 0, reg: {}, flags: { set: ['N', 'C'], clear: ['Z'] }, cycles: 5 });
row('CMPS compares S', [0x11, 0x8C, 0x12, 0x34], { s: 0x1234, cc: 0, reg: {}, flags: { set: ['Z'], clear: ['N', 'V', 'C'] }, cycles: 5 });
row('CMPY compares Y', [0x10, 0x8C, 0x02, 0x00], { y: 0x0100, cc: 0, reg: {}, flags: { set: ['N', 'C'], clear: ['Z'] }, cycles: 5 });
row('CMPX compares X', [0x8C, 0x02, 0x00], { x: 0x0100, cc: 0, reg: {}, flags: { set: ['N', 'C'], clear: ['Z'] }, cycles: 4 });

// ---- LEA: load an effective address into a register (Table D-1, "--a--" for Y and X, "-----" for
// S and U; 4 cycles plus the indexed mode's extra cycles) ----
// The address each row leaves is written out here from the postbyte table, not read back from the core.
row('LEAX 16,X', [0x30, 0x88, 0x10], { x: 0x4000, cc: 0, reg: { x: 0x4010 }, flags: { clear: ['Z'] }, cycles: 5 });
row('LEAX ,X leaves X and sets Z when the address is zero', [0x30, 0x84], { x: 0x0000, cc: 0, reg: { x: 0x0000 }, flags: { set: ['Z'] }, cycles: 4 });
row('LEAY 5,X', [0x31, 0x05], { x: 0x4000, cc: 0, reg: { y: 0x4005 }, flags: { clear: ['Z'] }, cycles: 5 });
row('LEAY ,Y leaves Y', [0x31, 0xA4], { y: 0x2468, cc: SET('N') | SET('C'), reg: { y: 0x2468 }, flags: { same: ['H', 'N', 'V', 'C'], clear: ['Z'] }, cycles: 4 });
// LEAS/LEAU affect no condition code at all (Table D-1 "-----")
row('LEAS ,S leaves S and every flag', [0x32, 0xE4], { s: 0x8000, cc: SET('N') | SET('V') | SET('C'), reg: { s: 0x8000 }, flags: { same: ['H', 'N', 'Z', 'V', 'C'] }, cycles: 4 });
row('LEAU -8,U', [0x33, 0xC8, 0xF8], { u: 0x4000, cc: SET('N') | SET('C'), reg: { u: 0x3FF8 }, flags: { same: ['H', 'N', 'Z', 'V', 'C'] }, cycles: 5 });

// ---- ANDCC ($1C) and ORCC ($1A): the operand is ANDed or ORed into CC directly (Table D-1 "ddddd",
// 3 cycles, 2 bytes). Every flag is checked, so a wrongly masked bit shows up. ----
row('ANDCC clears the bits named by the operand', [0x1C, 0xEF], { cc: 0xFF, reg: { cc: 0xEF }, flags: { clear: ['I'] }, cycles: 3 });
row('ANDCC can clear several flags at once', [0x1C, 0xFA], { cc: 0xFF, reg: { cc: 0xFA }, flags: { clear: ['Z', 'C'] }, cycles: 3 });
row('ORCC sets the bits named by the operand', [0x1A, 0x50], { cc: 0x00, reg: { cc: 0x50 }, flags: { set: ['I', 'F'] }, cycles: 3 });
row('ORCC leaves the bits the operand does not name', [0x1A, 0x01], { cc: SET('N') | SET('Z'), reg: { cc: SET('N') | SET('Z') | SET('C') }, flags: { set: ['C'] }, cycles: 3 });

// ---- the branch instructions (Appendix D: all short branches are 2 bytes and 3 cycles; the long
// conditional forms are 4 bytes with 5 cycles when not taken and 6 when taken; LBRA is $16 and LBSR
// $17, 3 bytes, 5 and 9 cycles) ----
// `taken` and `not` are the condition-code values that make the branch go and not go. The offset is
// +2, so a taken branch leaves PC at $1004 (opcode, operand at $1002/$1003, then +2) and a branch not
// taken leaves it at $1002.
const SHORT_BRANCH = [
  { o: 0x20, n: 'BRA', taken: 0 }, { o: 0x21, n: 'BRN', not: 0 },
  { o: 0x22, n: 'BHI', taken: 0, not: SET('C') }, { o: 0x23, n: 'BLS', taken: SET('C'), not: 0 },
  { o: 0x24, n: 'BHS', taken: 0, not: SET('C') }, { o: 0x25, n: 'BLO', taken: SET('C'), not: 0 },
  { o: 0x26, n: 'BNE', taken: 0, not: SET('Z') }, { o: 0x27, n: 'BEQ', taken: SET('Z'), not: 0 },
  { o: 0x28, n: 'BVC', taken: 0, not: SET('V') }, { o: 0x29, n: 'BVS', taken: SET('V'), not: 0 },
  { o: 0x2A, n: 'BPL', taken: 0, not: SET('N') }, { o: 0x2B, n: 'BMI', taken: SET('N'), not: 0 },
  { o: 0x2C, n: 'BGE', taken: 0, not: SET('N') }, { o: 0x2D, n: 'BLT', taken: SET('N'), not: 0 },
  { o: 0x2E, n: 'BGT', taken: 0, not: SET('Z') }, { o: 0x2F, n: 'BLE', taken: SET('Z'), not: 0 },
];
const KEEPB = { same: ['H', 'N', 'Z', 'V', 'C'] };
for (const b of SHORT_BRANCH) {
  if (b.taken !== undefined) row(`${b.n} taken`, [b.o, 0x02], { cc: b.taken, reg: { pc: 0x1004 }, flags: KEEPB, cycles: 3 });
  if (b.not !== undefined) row(`${b.n} not taken`, [b.o, 0x02], { cc: b.not, reg: { pc: 0x1002 }, flags: KEEPB, cycles: 3 });
}
// long conditional branches: the same conditions with $10 in front, 4 bytes
const LONG_BRANCH = [
  { o: 0x21, n: 'LBRN', not: 0 }, { o: 0x22, n: 'LBHI', taken: 0, not: SET('C') },
  { o: 0x23, n: 'LBLS', taken: SET('C'), not: 0 }, { o: 0x24, n: 'LBHS', taken: 0, not: SET('C') },
  { o: 0x25, n: 'LBLO', taken: SET('C'), not: 0 }, { o: 0x26, n: 'LBNE', taken: 0, not: SET('Z') },
  { o: 0x27, n: 'LBEQ', taken: SET('Z'), not: 0 }, { o: 0x28, n: 'LBVC', taken: 0, not: SET('V') },
  { o: 0x29, n: 'LBVS', taken: SET('V'), not: 0 }, { o: 0x2A, n: 'LBPL', taken: 0, not: SET('N') },
  { o: 0x2B, n: 'LBMI', taken: SET('N'), not: 0 }, { o: 0x2C, n: 'LBGE', taken: 0, not: SET('N') },
  { o: 0x2D, n: 'LBLT', taken: SET('N'), not: 0 }, { o: 0x2E, n: 'LBGT', taken: 0, not: SET('Z') },
  { o: 0x2F, n: 'LBLE', taken: SET('Z'), not: 0 },
];
for (const b of LONG_BRANCH) {
  // 4 bytes, so after the operand PC is at $1004; +2 -> $1006 taken, $1004 not taken
  if (b.taken !== undefined) row(`${b.n} taken`, [0x10, b.o, 0x00, 0x02], { cc: b.taken, reg: { pc: 0x1006 }, flags: KEEPB, cycles: 6 });
  if (b.not !== undefined) row(`${b.n} not taken`, [0x10, b.o, 0x00, 0x02], { cc: b.not, reg: { pc: 0x1004 }, flags: KEEPB, cycles: 5 });
}
row('LBRA', [0x16, 0x00, 0x02], { cc: 0, reg: { pc: 0x1005 }, flags: KEEPB, cycles: 5 });
// LBSR pushes the address of the instruction after itself, then branches (Table D-1: 9 cycles)
row('LBSR pushes the return address and branches', [0x17, 0x00, 0x02], {
  cc: 0, reg: { pc: 0x1005, s: 0x7FFE }, mem: { '$7FFE': 0x10, '$7FFF': 0x03 }, flags: KEEPB, cycles: 9,
});

// ---- the interrupt and control instructions (data sheet, "Interrupt Functionality") ----
// SWI sets E, stacks every register, then sets I and F (19 cycles); SWI2 and SWI3 stack the same frame
// and set E but leave I and F alone (20 cycles each). CWAI ANDs its operand into CC, sets E, stacks the
// frame and waits. Table D-1 gives CWAI ">=20" cycles -- a lower bound, because the instruction then waits
// for an interrupt; what it costs before the wait is 16, established by the 6551 ACIA lockstep run against
// MAME (commit 4c49590: "CWAI checks for an interrupt after 16 cycles, not 20").
const VEC = { 0xFFFA: 0x2000, 0xFFF4: 0x3000, 0xFFF2: 0x4000 };
const vecSetup = (mem) => { mem[0xFFFA] = 0x20; mem[0xFFF4] = 0x30; mem[0xFFF2] = 0x40; };
// The stacked frame, from the data sheet's "Stacking Order" (pull order CC, A, B, DP, X, Y, U, PC, so
// the push order is the reverse and PC is at the highest address). SS starts at $8000, so with all
// registers zero but S=U=$8000 the eight bytes sit at $7FF4..$7FFF:
//   $7FF4 CC  $7FF5 A  $7FF6 B  $7FF7 DP  $7FF8/9 X  $7FFA/B Y  $7FFC/D U  $7FFE/F PC
const FRAME = (cc, pc) => ({ '$7FF4': cc, '$7FF5': 0x00, '$7FF6': 0x00, '$7FF7': 0x00, '$7FF8': 0x00,
  '$7FF9': 0x00, '$7FFA': 0x00, '$7FFB': 0x00, '$7FFC': 0x80, '$7FFD': 0x00,
  '$7FFE': pc >> 8, '$7FFF': pc & 0xFF });
row('SWI stacks every register, sets E and masks both interrupts', [0x3F], {
  cc: SET('H'), setup: vecSetup, reg: { pc: 0x2000, s: 0x7FF4 },
  mem: FRAME(SET('H') | SET('E'), 0x1001), flags: { set: ['E', 'I', 'F'] }, cycles: 19,
});
row('SWI2 stacks every register and sets E but leaves I and F', [0x10, 0x3F], {
  cc: SET('N'), setup: vecSetup, reg: { pc: 0x3000, s: 0x7FF4 },
  mem: FRAME(SET('N') | SET('E'), 0x1002), flags: { set: ['E'], clear: ['I', 'F'] }, cycles: 20,
});
row('SWI3 stacks every register and sets E but leaves I and F', [0x11, 0x3F], {
  cc: SET('V'), setup: vecSetup, reg: { pc: 0x4000, s: 0x7FF4 },
  mem: FRAME(SET('V') | SET('E'), 0x1002), flags: { set: ['E'], clear: ['I', 'F'] }, cycles: 20,
});
// CWAI, two numbers that measure different things and both hold:
//  - the instruction's own cost, before it starts waiting, is 16 cycles. That is what step() returns and
//    what the row below asserts; it was established by the 6551 ACIA lockstep run against MAME ("CWAI
//    checks for an interrupt after 16 cycles, not 20", commit 4c49590, MAME base6x09.lst CWAI).
//  - Table D-1 gives CWAI ">=20" cycles: the 16 plus the 4-cycle vector fetch that gets to the handler (the
//    handler entry of 19 for IRQ, of which CWAI's frame is already pushed). The row after this one asserts
//    that total, so the sheet's number and the measured one are both pinned, each to its own case.
row('CWAI ANDs its operand into CC, sets E and stacks the frame (16 cycles before the wait)', [0x3C, 0xEF], {
  cc: SET('C') | SET('Z'), setup: vecSetup, reg: { pc: 0x1002, s: 0x7FF4 },
  mem: FRAME(SET('C') | SET('Z') | SET('E'), 0x1002), flags: { set: ['E'], clear: ['I'] }, cycles: 16,
});
// The same instruction with an interrupt arriving while it waits: 16 for CWAI plus 4 for the vector fetch =
// 20 cycles to the handler's first instruction, which is Table D-1's ">=20". `cwaiCase` runs the two steps
// and hands back the total and where it ended up, because runOnce() deliberately runs exactly one
// instruction.
{
  const cwaiCase = () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0x3C, 0xEF], 0x1000);                 // CWAI #$EF
    mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
    mem[0xFFF8] = 0x20; mem[0xFFF9] = 0x00;        // IRQ -> $2000
    const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
    cpu.reset(); cpu.s = 0x8000; cpu.cc = 0; cpu.irqLine = false;
    const a = cpu.step();                          // CWAI runs, then waits
    cpu.irqLine = true;                            // the interrupt arrives while it waits
    const b = cpu.step();                          // the vector fetch
    return { a, b, total: a + b, pc: cpu.pc, cwai: cpu.cwai };
  };
  const r = cwaiCase();
  is('CWAI waiting: its own cost is 16 cycles', r.a, 16);
  is('CWAI waiting: the wake and vector fetch is 4 cycles', r.b, 4);
  is('CWAI waiting: 20 cycles to the handler (Table D-1 ">=20")', r.total, 20);
  is('CWAI waiting: it reaches the IRQ handler', r.pc, 0x2000);
  is('CWAI waiting: it is no longer waiting after the interrupt', r.cwai, false);
}
// RTI: with E set in the stacked CC it pulls the whole frame (15 cycles); with E clear it pulls only
// CC and PC (6 cycles). The stacked bytes are written out below, not produced by a push instruction.
const rtiFrame = (mem, at, cc) => { mem.set([cc, 0x11, 0x22, 0x33, 0x40, 0x00, 0x50, 0x00, 0x60, 0x00, 0x20, 0x00], at); };
row('RTI with E set pulls the whole frame', [0x3B], {
  setup: (m) => rtiFrame(m, 0x8000, SET('E') | SET('C')),
  reg: { cc: SET('E') | SET('C'), a: 0x11, b: 0x22, dp: 0x33, x: 0x4000, y: 0x5000, u: 0x6000, pc: 0x2000, s: 0x800C },
  flags: { set: ['E', 'C'] }, cycles: 15,
});
row('RTI with E clear pulls only CC and PC', [0x3B], {
  setup: (m) => { m[0x8000] = SET('C'); m[0x8001] = 0x20; m[0x8002] = 0x00; },
  reg: { cc: SET('C'), pc: 0x2000, s: 0x8003 },
  flags: { set: ['C'], clear: ['E'] }, cycles: 6,
});

// ---- undefined opcodes ----
// Table D-1's note: "All unused opcodes are both undefined and illegal". The data sheet gives no
// action, so nothing here asserts a hardware behaviour. What is checked is the one thing a defined or
// undefined opcode cannot do differently: it must not perform any documented operation -- the
// accumulators and index registers keep their values and neither the direct-page byte nor the extended
// byte is written. The PC advance and the cycle count are then pinned to what this core does today so
// that an accidental change shows up. MAME does not agree with several of them (it decodes $41 as NEGA
// and $8F as "store X to immediate", for example); neither behaviour is defined here. $01 is left out
// on purpose: this core decodes it in the direct-mode group as its low-nibble op rather than as a
// one-byte no-op, so even "no documented operation" is not true of it.
const ILLEGAL = [
  { b: [0x14], pc: 0x1001, cyc: 2 }, { b: [0x1B], pc: 0x1001, cyc: 2 },
  { b: [0x38], pc: 0x1001, cyc: 2 },
  { b: [0xCD, 0x55], pc: 0x1002, cyc: 3 },                 // undefined STD immediate
];
for (const u of ILLEGAL) {
  row(`undefined $${u.b[0].toString(16).toUpperCase()} has no defined effect`, u.b, {
    setup: (m) => { m[0x40] = 0xAA; m[0x4000] = 0xBB; },
    // the registers a defined opcode of this form would change keep their starting values
    reg: { a: 0, b: 0, x: 0, y: 0, dp: 0, pc: u.pc },
    mem: { '$40': 0xAA, '$4000': 0xBB },
    flags: { same: ['E', 'F', 'H', 'I', 'N', 'Z', 'V', 'C'] }, cycles: u.cyc,
  });
}
// $41 and $8F are undefined in Table D-1, but the 6809 decodes the $40-$5F row by low nibble, so $41
// runs as NEGA; MAME 0.264 decodes it the same way (m6809.lst: "case 0x40: case 0x41: set_a(); %NEG8").
// The $8F immediate form of a store has nowhere defined to write. Both are pinned as what the core and
// MAME share, not from the data sheet.
row('undefined $41 decodes as NEGA', [0x41], {
  a: 0x01, cc: 0, reg: { a: 0xFF }, flags: { set: ['N', 'C'], clear: ['Z'] }, cycles: 2,
});
row('undefined $8F immediate has no defined effect', [0x8F, 0x55], {
  setup: (m) => { m[0x40] = 0xAA; m[0x4000] = 0xBB; },
  reg: { a: 0, b: 0, x: 0, y: 0, dp: 0, pc: 0x1002 },
  mem: { '$40': 0xAA, '$4000': 0xBB },
  flags: { same: ['E', 'F', 'H', 'I', 'N', 'Z', 'V', 'C'] }, cycles: 3,
});


// ---- shifts and rotates: register forms and memory forms (Table D-1: 2 cycles for the register forms, 6
// bytes-2 / 7 bytes-3 for the memory forms, plus the indexed mode's extra cycles) ----
// Table D-1's effect strings for these, in its H N Z V C order ('-' unaffected, 'a' set or cleared by the
// operation, '0'/'1' always cleared/set, 's' the carry from a shift):
//   NEG '-uaaa' (H undefined)   COM '-aa01'   LSR '-0a-s'   ROR '-aa-s'   ASR '-aa-s'
//   ASL '-aaas'   ROL '-aaas'   DEC '-aaa-'   INC '-aaa-'   TST '-aa0-'   CLR '-0100'
// So H is unaffected everywhere here except NEG, where the sheet leaves it undefined.
const SHIFT = [
  // op, the A and B register opcodes, the indexed and extended memory opcodes, the operand, and the result.
  // eff is Table D-1's H N Z V C string for the operation.
  { op: 'NEG', a: 0x40, b: 0x50, mem: 0x60, ext: 0x70, in: 0x02, res: 0xFE, eff: '-uaaa' },
  { op: 'COM', a: 0x43, b: 0x53, mem: 0x63, ext: 0x73, in: 0x12, res: 0xED, eff: '-aa01' },
  { op: 'LSR', a: 0x44, b: 0x54, mem: 0x64, ext: 0x74, in: 0x81, res: 0x40, eff: '-0a-a' },
  { op: 'ROR', a: 0x46, b: 0x56, mem: 0x66, ext: 0x76, in: 0x81, res: 0x40, eff: '-aa-a' },
  { op: 'ASR', a: 0x47, b: 0x57, mem: 0x67, ext: 0x77, in: 0x81, res: 0xC0, eff: '-aa-a' },
  { op: 'ASL', a: 0x48, b: 0x58, mem: 0x68, ext: 0x78, in: 0x81, res: 0x02, eff: '-aaas' },
  { op: 'ROL', a: 0x49, b: 0x59, mem: 0x69, ext: 0x79, in: 0x81, res: 0x02, eff: '-aaas' },
  { op: 'DEC', a: 0x4A, b: 0x5A, mem: 0x6A, ext: 0x7A, in: 0x02, res: 0x01, eff: '-aaa-' },
  { op: 'INC', a: 0x4C, b: 0x5C, mem: 0x6C, ext: 0x7C, in: 0x02, res: 0x03, eff: '-aaa-' },
  { op: 'TST', a: 0x4D, b: 0x5D, mem: 0x6D, ext: 0x7D, in: 0x80, res: 0x80, eff: '-aa0-', noStore: true },
  { op: 'CLR', a: 0x4F, b: 0x5F, mem: 0x6F, ext: 0x7F, in: 0x12, res: 0x00, eff: '-0100' },
];
// The expected V and C for each shift, from its own definition in the data sheet: C is the bit shifted out
// (bit 7 for the left shifts, bit 0 for the right ones, and 0 for CLR which sets it); V is N xor C after the
// operation for ASL/ROL/ASR/ROR/LSR, overflow-only for DEC/INC and NEG, cleared for TST/CLR/COM.
function shiftVC(op, v, cin) {
  const r = { NEG: (-v) & 0xFF, COM: (~v) & 0xFF, LSR: v >> 1, ROR: (v >> 1) | (cin ? 0x80 : 0),
    ASR: (v >> 1) | (v & 0x80), ASL: (v << 1) & 0xFF, ROL: ((v << 1) | (cin ? 1 : 0)) & 0xFF,
    DEC: (v - 1) & 0xFF, INC: (v + 1) & 0xFF, TST: v, CLR: 0 }[op];
  const n = !!(r & 0x80);
  let c, vv;
  switch (op) {
    case 'LSR': case 'ASR': case 'ROR': c = !!(v & 1); break;
    case 'ASL': case 'ROL': c = !!(v & 0x80); break;
    case 'CLR': case 'TST': c = false; break;
    case 'COM': c = true; break;
    case 'NEG': c = v !== 0; break;
    default: c = null; break;                   // DEC/INC leave C alone
  }
  if (op === 'ASL' || op === 'ROL' || op === 'ASR' || op === 'ROR' || op === 'LSR') vv = n !== c;
  else if (op === 'DEC') vv = v === 0x80;
  else if (op === 'INC') vv = v === 0x7F;
  else if (op === 'NEG') vv = v === 0x80;
  else vv = false;                              // TST, CLR, COM clear V
  return { c, v: vv, r };
}
for (const sh of SHIFT) {
  for (const cin of [0, 1]) {
    // both CC extremes: C clear and C set. ROL/ROR read C in, so the pair also covers the carry-in; a
    // "cleared" or "unaffected" check against an already-clear bit would prove nothing.
    const cc = cin ? 0xFF : 0;
    const { c, v, r } = shiftVC(sh.op, sh.in, cin);
    const set = [], clear = [], same = ['I', 'F'];
    // H is '-' everywhere here except NEG, which is 'u' (undefined) and so is not asserted
    if (sh.eff[0] === '-') same.push('H'); else if (sh.eff[0] === '0') clear.push('H');
    (r & 0x80 ? set : clear).push('N');
    (r === 0 ? set : clear).push('Z');
    if (sh.eff[3] === '-') same.push('V'); else if (v) set.push('V'); else clear.push('V');
    if (sh.eff[4] === '-') same.push('C'); else if (c) set.push('C'); else clear.push('C');
    row(`${sh.op}A${cin ? ' (C set)' : ''}`, [sh.a], {
      a: sh.in, cc, reg: sh.noStore ? {} : { a: r }, flags: { set, clear, same }, cycles: 2,
    });
    // the memory form, direct: Table D-1 gives the direct opcode 6 cycles and 2 bytes for all of these
    // (0F/6F/7F for CLR, and so on); the indexed and extended forms follow the same flag rules.
    row(`${sh.op} direct${cin ? ' (C set)' : ''}`, [sh.reg & 0xF0 | (sh.mem & 0x0F), 0x40], {
      cc, setup: (m) => { m[0x40] = sh.in; },
      mem: { '$40': r }, flags: { set, clear, same }, cycles: 6,
    });
  }
}
// three rows that mutation testing found missing: each kills a mutant the table let survive
row('INCA from $7F sets V', [0x4C], { a: 0x7F, cc: 0, reg: { a: 0x80 }, flags: { set: ['N', 'V'] }, cycles: 2 });
row('DECA from $80 sets V', [0x4A], { a: 0x80, cc: 0, reg: { a: 0x7F }, flags: { set: ['V'], clear: ['N'] }, cycles: 2 });
row('TSTA starting with V set clears V', [0x4D], { a: 0x01, cc: SET('V'), reg: {}, flags: { clear: ['V'] }, cycles: 2 });
// DAA with C already set adds $60 (Table D-1: C is an input to the adjustment), and the carry out is set
// again, so C stays set; $10 + $60 = $70
row('DAA with C set keeps C set', [0x19], { a: 0x10, cc: SET('C'), reg: { a: 0x70 }, flags: { set: ['C'] }, cycles: 2 });

// ---- loads and stores that must not touch a flag, and TFR/EXG ----
const KEEP = { same: ['H', 'N', 'Z', 'V', 'C'] };
// Table D-1's load and store rows all read "-aa0-": N and Z from the value, V always cleared, H and C
// unaffected. The rows start with V, H and C set, so "cleared" and "unaffected" are both proven.
row('LDX sets N and Z from the value, clears V, leaves H and C', [0x8E, 0x12, 0x34], { cc: SET('H') | SET('V') | SET('C') | 0x50, reg: { x: 0x1234 }, flags: { same: ['H', 'C'], clear: ['N', 'Z', 'V'] }, cycles: 3 });
row('LDU sets N and Z, clears V, leaves H and C', [0xCE, 0x12, 0x34], { cc: SET('H') | SET('V') | SET('C') | 0x50, reg: { u: 0x1234 }, flags: { same: ['H', 'C'], clear: ['N', 'Z', 'V'] }, cycles: 3 });
// A store is the same "-aa0-": N and Z from the value stored, V cleared, H and C unaffected. This is what
// the sheet says, and our core and MAME 0.264 both do it (base6x09.lst ST16 -> set_flags(CC_NZV, ...)).
row('STX extended sets N and Z from the value, clears V, leaves H and C', [0xBF, 0x40, 0x00], { x: 0x8000, cc: SET('H') | SET('V') | SET('C'), reg: {}, mem: { '$4000': 0x80, '$4001': 0x00 }, flags: { same: ['H', 'C'], set: ['N'], clear: ['Z', 'V'] }, cycles: 6 });
row('TFR X,Y leaves the flags alone', [0x1F, 0x12], { x: 0xBEEF, cc: SET('N') | SET('V') | 0x50, reg: { y: 0xBEEF }, flags: KEEP, cycles: 6 });
// postbyte ssssdddd: A = 1000 ($8), B = 1001 ($9), so A -> B is $89
row('EXG A,B leaves the flags alone', [0x1E, 0x89], { a: 0x11, b: 0x22, cc: SET('C') | SET('N'), reg: { a: 0x22, b: 0x11 }, flags: KEEP, cycles: 8 });

// ---- stack operations ----
row('PSHS A,B,X', [0x34, 0x16], { a: 0x11, b: 0x22, x: 0x3344, cc: 0x50, reg: { s: 0x7FFC }, flags: { same: ['N', 'Z', 'V', 'C'] }, cycles: 9 });
row('PULS A,B', [0x35, 0x06], { cc: 0x50, setup: (m) => { m[0x8000] = 0x55; m[0x8001] = 0x66; }, reg: { a: 0x55, b: 0x66, s: 0x8002 }, flags: { same: ['N', 'Z', 'V', 'C'] }, cycles: 7 });

// ---- the vector/interrupt-family instructions that have no operands ----
row('NOP', [0x12], { cycles: 2, flags: { same: ['H', 'N', 'Z', 'V', 'C'] } });
row('SEX sign-extends B into A', [0x1D], { b: 0x80, cc: 0x50, reg: { a: 0xFF }, flags: { set: ['N'], clear: ['Z'] }, cycles: 2 });
row('ABX adds B to X', [0x3A], { x: 0x1000, b: 0x05, cc: 0, reg: { x: 0x1005 }, flags: { same: ['N', 'Z', 'V', 'C'] }, cycles: 3 });
// MUL: $10 * $10 = $0100, so D = $0100. Table D-1's row is "--a-a" with the note "Special Case - Carry
// set if b7 is SET": Z comes from the result (the product), C from bit 7 of its low byte ($00 -> C clear)
// and H and V are not affected. The row starts with H, V and C set so that all three are proven.
row('MUL leaves D as the product, Z from the product and C from bit 7', [0x3D], { a: 0x10, b: 0x10, cc: SET('H') | SET('V') | SET('C'), reg: { a: 0x01, b: 0x00 }, flags: { same: ['H', 'V'], clear: ['Z', 'C'] }, cycles: 11 });
// the other side of the same rule: $10 * $0C = $00C0, so the product is not zero (Z clear) and bit 7 of
// its low byte ($C0) is set, so C is set
row('MUL sets C from bit 7 of the low byte', [0x3D], { a: 0x10, b: 0x0C, cc: 0, reg: { a: 0x00, b: 0xC0 }, flags: { set: ['C'], clear: ['Z'] }, cycles: 11 });
row('DAA adds six when the low digit is above nine', [0x19], { a: 0x1A, cc: 0, reg: { a: 0x20 }, cycles: 2 });



// ---- indexed addressing: every postbyte form (data sheet, "Indexed Addressing Mode" table) ----
// Postbyte: bit 7 set means a full form; bits 6-5 the register (X, Y, U, S); bit 4 indirect (adds 3 cycles);
// bits 3-0 the form. Each row sets exactly what its mode reads, so a wrong address in the core cannot
// accidentally read the right byte. `cycles` is the whole LDA instruction (base 4 for a zero offset).
const idxRow = (name, postbyte, extra, cyc, opts = {}) => {
  const bytes = [0xA6, postbyte, ...(opts.operand || [])];
  row(`LDA ${name}`, bytes, Object.assign({
    x: 0x4000, y: 0x4000, u: 0x4000, b: opts.startB ?? 0x10, a: opts.startA ?? 0x00, dp: 0,
    setup: opts.setup, reg: { a: 0x5A }, cycles: cyc,
    flags: { same: ['H', 'V', 'C'] },
  }, opts.override || {}));
  if (extra !== undefined) void extra;
};
idxRow('5-bit offset, 5,X', 0x05, 0, 5, { setup: (m) => { m[0x4005] = 0x5A; } });
idxRow('5-bit negative offset, -5,X', 0x1B, 0, 5, { setup: (m) => { m[0x3FFB] = 0x5A; } });
idxRow(',X', 0x84, 0, 4, { setup: (m) => { m[0x4000] = 0x5A; } });
idxRow('B offset', 0x85, 0, 5, { setup: (m) => { m[0x4010] = 0x5A; } });
idxRow('A offset', 0x86, 0, 5, { startA: 0x10, setup: (m) => { m[0x4010] = 0x5A; } });
idxRow('8-bit offset', 0x88, 1, 5, { operand: [0x20], setup: (m) => { m[0x4020] = 0x5A; } });
idxRow('16-bit offset', 0x89, 2, 8, { operand: [0x12, 0x34], setup: (m) => { m[0x5234] = 0x5A; } });
idxRow('D offset', 0x8B, 0, 8, { startA: 0x00, startB: 0x10, setup: (m) => { m[0x4010] = 0x5A; } });
idxRow('8-bit PCR', 0x8C, 1, 5, { operand: [0x10], setup: (m) => { m[0x1013] = 0x5A; } });   // next instr at $1003
idxRow('16-bit PCR', 0x8D, 2, 9, { operand: [0x00, 0x20], setup: (m) => { m[0x1024] = 0x5A; } });   // next instr at $1004
// auto increment and decrement: the register's new value is part of the result
idxRow(',X+', 0x80, 0, 6, { setup: (m) => { m[0x4000] = 0x5A; }, override: { reg: { a: 0x5A, x: 0x4001 } } });
idxRow(',X++', 0x81, 0, 7, { setup: (m) => { m[0x4000] = 0x5A; }, override: { reg: { a: 0x5A, x: 0x4002 } } });
idxRow(',-X', 0x82, 0, 6, { setup: (m) => { m[0x3FFF] = 0x5A; }, override: { reg: { a: 0x5A, x: 0x3FFF } } });
idxRow(',--X', 0x83, 0, 7, { setup: (m) => { m[0x3FFE] = 0x5A; }, override: { reg: { a: 0x5A, x: 0x3FFE } } });
// indirect: the operand cell at the effective address holds a 16-bit pointer to where the data is
idxRow(',X indirect', 0x94, 0, 7, { setup: (m) => { m[0x4000] = 0x50; m[0x4001] = 0x00; m[0x5000] = 0x5A; } });
idxRow('B offset indirect', 0x95, 0, 8, { setup: (m) => { m[0x4010] = 0x50; m[0x4011] = 0x00; m[0x5000] = 0x5A; } });
idxRow('A offset indirect', 0x96, 0, 8, { startA: 0x10, setup: (m) => { m[0x4010] = 0x50; m[0x4011] = 0x00; m[0x5000] = 0x5A; } });
idxRow('8-bit offset indirect', 0x98, 1, 8, { operand: [0x20], setup: (m) => { m[0x4020] = 0x50; m[0x4021] = 0x00; m[0x5000] = 0x5A; } });
idxRow('16-bit offset indirect', 0x99, 2, 11, { operand: [0x12, 0x34], setup: (m) => { m[0x5234] = 0x50; m[0x5235] = 0x00; m[0x5000] = 0x5A; } });
idxRow('D offset indirect', 0x9B, 0, 11, { startA: 0x00, startB: 0x10, setup: (m) => { m[0x4010] = 0x50; m[0x4011] = 0x00; m[0x5000] = 0x5A; } });
idxRow('8-bit PCR indirect', 0x9C, 1, 8, { operand: [0x10], setup: (m) => { m[0x1013] = 0x50; m[0x1014] = 0x00; m[0x5000] = 0x5A; } });
idxRow('16-bit PCR indirect', 0x9D, 2, 12, { operand: [0x00, 0x20], setup: (m) => { m[0x1024] = 0x50; m[0x1025] = 0x00; m[0x5000] = 0x5A; } });
// [$9F]: the two operand bytes name the address of the pointer cell (data sheet: extra 5 cycles, 2 bytes)
idxRow('extended indirect', 0x9F, 2, 9, { operand: [0x50, 0x00], setup: (m) => { m[0x5000] = 0x60; m[0x5001] = 0x00; m[0x6000] = 0x5A; } });


// ---- the run: every row, one instruction, against the data sheet ----
for (const r of rows) {
  const got = runOnce(r);
  // the result register / memory
  for (const [k, v] of Object.entries(r.reg || {})) is(`${r.name}: ${k}`, got.cpu[k] & (k === 'a' || k === 'b' ? 0xFF : 0xFFFF), v);
  for (const [addr, v] of Object.entries(r.mem || {})) is(`${r.name}: memory ${addr}`, got.mem[parseInt(addr.slice(1), 16)], v);
  // flags: set must be set, clear must be clear, same must keep what the row started with
  const before = r.cc ?? 0;
  for (const f of (r.flags && r.flags.set) || []) is(`${r.name}: ${f} set`, (got.cpu.cc & SET(f)) !== 0, true);
  for (const f of (r.flags && r.flags.clear) || []) is(`${r.name}: ${f} clear`, (got.cpu.cc & SET(f)) !== 0, false);
  for (const f of (r.flags && r.flags.same) || []) is(`${r.name}: ${f} unchanged`, (got.cpu.cc & SET(f)) !== 0, (before & SET(f)) !== 0);
  if (r.cycles !== undefined) is(`${r.name}: cycles`, got.cycles, r.cycles);
}

console.log(`${count - failures}/${count} checks passed (${rows.length} instructions)`);
process.exitCode = failures ? 1 : 0;
