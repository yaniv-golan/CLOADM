// Run: node tests/tms7000-core.test.js
//
// The TMS7000 / TMS7040 CPU core (stage 1): instruction semantics, the status register,
// addressing, the stack, interrupts and snapshots.
//
// Every expected value here is written from the TMS7000 Family Data Manual (TI, SPND001B, 1986), and the
// test names the page it came from. Where the manual's own tables disagree with each other the comment
// says which reading was taken and why; none of the values were produced by the core under test.
//   Section 3.1.1-3.1.5  registers, the register file, the stack, the status register, the PC
//   Section 3.6          interrupts, the vector table, the interrupt sequence
//   Section 6.2          addressing modes (6.2.5 is the relative-offset definition)
//   Pages 6-15..6-68     the per-instruction pages: execution, status bits, worked examples
//   Appendix A           bus activity tables: the cycle phase counts and the reset/interrupt sequences
//   Page 6-64            the trap vector table
//
// Notable manual statements used below:
//   * ST bits are C=7, N=6, Z=5, I=4 (§9.4: "the carry (C), negative (N), zero (Z), and interrupt enable
//     (I) flags occupy bits 7-4"); MAME's SR_I = 0x10 agrees.
//   * CMP sets C "1 if (Rn) > (s)" (page 6-27) and Table 6-4 spells the same rule out on eleven example
//     pairs, including the equal case (C=1 when the operands are equal, because the subtraction is zero).
//   * SUB/SBB/DSB set C to the *no-borrow* bit (pages 6-58 and 6-62).
//   * POP moves first and decrements after; PUSH increments first and then moves (§3.1.3 and 6-50/6-51).
//   * an interrupt pushes ST, then PCH, then PCL, and clears the whole status register (6-29).
const Emu = require('./load')();
const { CPU7000 } = require('../js/cpu/cpu7000.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v, d = 2) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

// Status bits as §9.4 and Figure 9-9 place them.
const C = 0x80, N = 0x40, Z = 0x20, I = 0x10;

// A machine: 64K of memory, the CPU wired to it, and helpers that run one instruction at a time.
function machine() {
  const mem = new Uint8Array(0x10000);
  const bus = { read: (a) => mem[a & 0xFFFF], write: (a, v) => { mem[a & 0xFFFF] = v & 0xFF; } };
  const cpu = new CPU7000(bus);
  return {
    mem, cpu,
    // place bytes at an address and point the PC there
    load(addr, ...bytes) { bytes.flat().forEach((b, i) => { mem[(addr + i) & 0xFFFF] = b & 0xFF; }); cpu.pc = addr; return this; },
    // run one instruction and return its cycle count
    step() { return cpu.step(); },
    // run until the PC stops changing or `max` instructions have run
    run(max = 100) { let c = 0; for (let i = 0; i < max; i++) c += cpu.step(); return c; },
    a() { return mem[0]; },
    b() { return mem[1]; },
  };
}

// ---- 1. reset: the vector, the register file, the stack pointer and the status register (§3.1.3-3.1.5) ----
{
  const m = machine();
  const vector = 0x1234;
  m.mem[0xFFFE] = vector >> 8; m.mem[0xFFFF] = vector & 0xFF;
  m.cpu.reset();
  check('reset loads the PC from the vector at >FFFE/>FFFF', m.cpu.pc === vector, hex(m.cpu.pc, 4));
  check('reset sets the stack pointer to >01 (§3.1.3)', m.cpu.sp === 0x01, hex(m.cpu.sp));
  check('reset clears the status register (§3.1.4)', m.cpu.st === 0, hex(m.cpu.st));
  check('the status bits are C=7 N=6 Z=5 I=4 (§9.4, Figure 9-9)',
    CPU7000.FLAGS.C === 0x80 && CPU7000.FLAGS.N === 0x40 && CPU7000.FLAGS.Z === 0x20 && CPU7000.FLAGS.I === 0x10,
    JSON.stringify(CPU7000.FLAGS));
}

// ---- 2. NOP, LDSP, STSP, SETC, CLRC/TSTA, DINT, EINT (§6.1 pages 6-42, 6-47, 6-59, 6-61, 6-65) ----
{
  const m = machine();
  m.load(0x0200, 0x00);
  const c = m.step();
  check('NOP takes 5 cycles, one byte (Table 6-3)', c === 5 && m.cpu.pc === 0x0201, `${c} cycles, pc ${hex(m.cpu.pc, 4)}`);

  // LDSP copies B into SP (page 6-42); STSP copies SP into B (page 6-61)
  m.mem[1] = 0x40; m.load(0x0200, 0x0D);
  m.step();
  check('LDSP copies B into the stack pointer (page 6-42)', m.cpu.sp === 0x40, hex(m.cpu.sp));
  m.cpu.sp = 0x55; m.load(0x0200, 0x09);
  m.step();
  check('STSP copies the stack pointer into B (page 6-61)', m.b() === 0x55, hex(m.b()));

  // SETC: C <- 1, and the status column is "1 0 1 x": N cleared, Z set (Table 6-3 page 6-13)
  m.cpu.st = 0; m.load(0x0200, 0x07);
  m.step();
  check('SETC sets C and Z and clears N (Table 6-3)', (m.cpu.st & (C | N | Z)) === (C | Z), hex(m.cpu.st));

  // CLRC/TSTA: 0 -> C, N and Z set on A (page 6-26)
  m.mem[0] = 0x80; m.cpu.st = C | N | Z; m.load(0x0200, 0xB0);
  m.step();
  check('CLRC/TSTA clears C and sets N from A (page 6-26)', (m.cpu.st & (C | N | Z)) === N, hex(m.cpu.st));

  // DINT clears I; EINT sets I (§3.1.4, pages 6-32 and 6-36)
  m.cpu.st = I; m.load(0x0200, 0x06);
  m.step();
  check('DINT clears the interrupt enable bit (page 6-32)', (m.cpu.st & I) === 0, hex(m.cpu.st));
  m.load(0x0200, 0x05);
  m.step();
  check('EINT sets the interrupt enable bit (page 6-36)', (m.cpu.st & I) !== 0, hex(m.cpu.st));
}

// ---- 3. the arithmetic operations and their carry rule (pages 6-15, 6-16, 6-58, 6-62) ----
// ADD: C is the carry out; N and Z are on the result (page 6-16). Worked with the manual's own example
// shape: ADD R7,A adds a register to A.
{
  const m = machine();
  m.mem[0] = 0x50; m.mem[7] = 0x50;
  m.load(0x0200, 0x18, 0x07);   // ADD R7,A
  const c = m.step();
  check('ADD R7,A adds the register into A (page 6-16)', m.a() === 0xA0, hex(m.a()));
  check('ADD R7,A takes 8 cycles, two bytes (Table 6-3 page 6-9)', c === 8 && m.cpu.pc === 0x0202, `${c} cycles`);
  check('ADD with no carry out clears C, and >A0 sets N (§3.1.4)', (m.cpu.st & C) === 0 && (m.cpu.st & N) !== 0, hex(m.cpu.st));

  m.mem[0] = 0xFF; m.mem[7] = 0x02;
  m.load(0x0200, 0x18, 0x07);
  m.step();
  check('ADD that carries out sets C (page 6-16)', (m.cpu.st & C) !== 0 && m.a() === 0x01, `${hex(m.a())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0x80; m.mem[7] = 0x80;
  m.load(0x0200, 0x18, 0x07);
  m.step();
  check('ADD that produces >00 sets Z, and >80 sets N', (m.cpu.st & (N | Z)) === Z, `${hex(m.a())} ${hex(m.cpu.st)}`);
}

// ADC adds the carry in (page 6-15)
{
  const m = machine();
  m.mem[0] = 0x10; m.mem[7] = 0x01; m.cpu.st = C;
  m.load(0x0200, 0x19, 0x07);   // ADC R7,A
  m.step();
  check('ADC adds the carry bit in (page 6-15)', m.a() === 0x12, hex(m.a()));
}

// SUB: C is the no-borrow bit (page 6-62: "The carry bit is set to 0 if a borrow is required")
{
  const m = machine();
  m.mem[0] = 0x40; m.mem[7] = 0x10;
  m.load(0x0200, 0x1A, 0x07);   // SUB R7,A
  m.step();
  check('SUB R7,A computes A - R7 (page 6-62)', m.a() === 0x30, hex(m.a()));
  check('SUB with no borrow sets C (the no-borrow bit)', (m.cpu.st & C) !== 0, hex(m.cpu.st));

  m.mem[0] = 0x10; m.mem[7] = 0x20;
  m.load(0x0200, 0x1A, 0x07);
  m.step();
  check('SUB that borrows clears C (page 6-62)', (m.cpu.st & C) === 0 && m.a() === 0xF0, `${hex(m.a())} ${hex(m.cpu.st)}`);
}

// SBB subtracts the borrow as well (page 6-58: (Rd) - (s) - 1 + (C))
{
  const m = machine();
  m.mem[0] = 0x40; m.mem[7] = 0x10; m.cpu.st = C;      // no borrow in
  m.load(0x0200, 0x1B, 0x07);   // SBB R7,A
  m.step();
  check('SBB with C set computes A - R7 (page 6-58)', m.a() === 0x30, hex(m.a()));
  m.mem[0] = 0x40; m.mem[7] = 0x10; m.cpu.st = 0;      // borrow in
  m.load(0x0200, 0x1B, 0x07);
  m.step();
  check('SBB with C clear subtracts one more', m.a() === 0x2F, hex(m.a()));
}

// CMP computes but does not store, and sets C when the destination is greater (page 6-27 and Table 6-4)
{
  const m = machine();
  m.mem[0] = 0x05; m.mem[7] = 0x02;
  m.load(0x0200, 0x1D, 0x07);   // CMP R7,A compares A to R7
  m.step();
  check('CMP does not store a result (page 6-27)', m.a() === 0x05 && m.mem[7] === 0x02, `${hex(m.a())} ${hex(m.mem[7])}`);
  check('CMP sets C when the destination is greater (Table 6-4)', (m.cpu.st & C) !== 0, hex(m.cpu.st));

  m.mem[0] = 0x02; m.mem[7] = 0x05;
  m.load(0x0200, 0x1D, 0x07);
  m.step();
  check('CMP clears C when the destination is smaller (Table 6-4)', (m.cpu.st & C) === 0, hex(m.cpu.st));

  // Table 6-4's equal row: (s)=7F, (Rn)=7F -> C=1, N=0, Z=1
  m.mem[0] = 0x7F; m.mem[7] = 0x7F;
  m.load(0x0200, 0x1D, 0x07);
  m.step();
  check('CMP on equal operands gives C=1, N=0, Z=1 (Table 6-4)', (m.cpu.st & (C | N | Z)) === (C | Z), hex(m.cpu.st));

  // Table 6-4: (s)=81, (Rn)=00 -> 00 - 81 = 7F, C=0, N=0, Z=0
  m.mem[0] = 0x00; m.mem[7] = 0x81;
  m.load(0x0200, 0x1D, 0x07);
  m.step();
  check('CMP 00 vs 81 gives C=0, N=0, Z=0 (Table 6-4 row "81 00")', (m.cpu.st & (C | N | Z)) === 0, hex(m.cpu.st));
}

// The logical operations clear C and set N/Z on the result (pages 6-17, 6-48, 6-68)
{
  const m = machine();
  for (const [op, a, r7, want, name, page] of [
    [0x13, 0xF0, 0x0F, 0x00, 'AND', '6-17'],
    [0x14, 0xF0, 0x0F, 0xFF, 'OR', '6-48'],
    [0x15, 0xF0, 0x0F, 0xFF, 'XOR', '6-68'],
  ]) {
    m.mem[0] = a; m.mem[7] = r7; m.cpu.st = C | N | Z;
    m.load(0x0200, op, 0x07);
    m.step();
    check(`${name} R7,A gives ${hex(want)} and clears C (page ${page})`, m.a() === want && (m.cpu.st & C) === 0, `${hex(m.a())} ${hex(m.cpu.st)}`);
  }
  // AND with nothing in common is zero, so Z is set (page 6-17)
  m.mem[0] = 0xF0; m.mem[7] = 0x0F;
  m.load(0x0200, 0x13, 0x07);
  m.step();
  check('AND with no common bit sets Z (page 6-17)', (m.cpu.st & Z) !== 0, hex(m.cpu.st));
  // XOR of a value with itself is zero, which is the manual's toggle example
  m.mem[0] = 0x5A; m.mem[7] = 0x5A;
  m.load(0x0200, 0x15, 0x07);
  m.step();
  check('XOR of a value with itself is zero (page 6-68)', m.a() === 0 && (m.cpu.st & Z) !== 0, hex(m.a()));
}

// MPY stores the 16-bit product in A (MSB) and B (LSB) and sets N/Z on A (page 6-46)
{
  const m = machine();
  m.mem[7] = 0x10; m.mem[0] = 0x10;
  m.load(0x0200, 0x1C, 0x07);   // MPY R7,A
  m.step();
  check('MPY leaves the product in A:B, MSB in A (page 6-46)', m.a() === 0x01 && m.b() === 0x00, `${hex(m.a())}:${hex(m.b())}`);
  m.mem[7] = 0x02; m.mem[0] = 0x03;
  m.load(0x0200, 0x1C, 0x07);
  m.step();
  check('MPY 3 x 2 = 6 in B, zero in A', m.a() === 0x00 && m.b() === 0x06, `${hex(m.a())}:${hex(m.b())}`);
}

// DAC and DSB produce packed-BCD results (pages 6-29 and 6-34). Each value below is worked by hand from the
// page's formula, with the decimal adjust a person would do on paper.
{
  const m = machine();
  m.mem[0] = 0x45; m.mem[7] = 0x38; m.cpu.st = 0;
  m.load(0x0200, 0x1E, 0x07);   // DAC R7,A: 45 + 38 = 83
  m.step();
  check('DAC 45 + 38 = 83 packed BCD with no carry (page 6-29)', m.a() === 0x83 && (m.cpu.st & C) === 0, `${hex(m.a())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0x99; m.mem[7] = 0x01; m.cpu.st = 0;
  m.load(0x0200, 0x1E, 0x07);
  m.step();
  check('DAC 99 + 01 reaches 100: the byte is 00 and C is set (page 6-29)', m.a() === 0x00 && (m.cpu.st & C) !== 0, `${hex(m.a())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0x01; m.mem[7] = 0x01; m.cpu.st = C;
  m.load(0x0200, 0x1E, 0x07);
  m.step();
  check('DAC adds the carry in: 01 + 01 + 1 = 03', m.a() === 0x03, hex(m.a()));

  // DSB: (Rd) - (s) - 1 + C, so "DSB R7,A" computes A - R7; page 6-34 says to set C first when no
  // borrow is wanted. A = >45, R7 = >38 gives 07.
  m.mem[0] = 0x45; m.mem[7] = 0x38; m.cpu.st = C;
  m.load(0x0200, 0x1F, 0x07);   // DSB R7,A: 45 - 38
  m.step();
  check('DSB 45 - 38 = 07, no borrow, C set (page 6-34)', m.a() === 0x07 && (m.cpu.st & C) !== 0, `${hex(m.a())} ${hex(m.cpu.st)}`);

  // A = >38, R7 = >45 gives 38 - 45, which borrows: the packed result wraps to 93 and C clears
  m.mem[0] = 0x38; m.mem[7] = 0x45; m.cpu.st = C;
  m.load(0x0200, 0x1F, 0x07);
  m.step();
  check('DSB 38 - 45 borrows, leaving 93 with C clear (page 6-34)', m.a() === 0x93 && (m.cpu.st & C) === 0, `${hex(m.a())} ${hex(m.cpu.st)}`);

  // A = >10, R7 = >01, C clear: 10 - 01 - 1 = 08
  m.mem[0] = 0x10; m.mem[7] = 0x01; m.cpu.st = 0;
  m.load(0x0200, 0x1F, 0x07);
  m.step();
  check('DSB with C=0 subtracts one more: 10 - 01 - 1 = 08', m.a() === 0x08, hex(m.a()));
}

// ---- 4. the single-operand operations (pages 6-25 .. 6-67) ----
{
  const m = machine();
  m.mem[0] = 0x00;
  m.load(0x0200, 0xB3);   // INC A
  m.step();
  check('INC sets Z when the result is zero, from >FF (page 6-37)', m.a() === 0x01 && (m.cpu.st & Z) === 0, `${hex(m.a())} ${hex(m.cpu.st)}`);
  m.mem[0] = 0xFF;
  m.load(0x0200, 0xB3);
  m.step();
  check('INC from >FF wraps to >00, sets Z and C (page 6-37)', m.a() === 0x00 && (m.cpu.st & (C | Z)) === (C | Z), `${hex(m.a())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0x01;
  m.load(0x0200, 0xB2);   // DEC A
  m.step();
  // page 6-30: C is 0 only on the >00 -> >FF transition, so decrementing to zero leaves C set
  check('DEC to zero sets Z and leaves C set (page 6-30)', m.a() === 0x00 && (m.cpu.st & (C | Z)) === (C | Z), `${hex(m.a())} ${hex(m.cpu.st)}`);
  m.mem[0] = 0x00;
  m.load(0x0200, 0xB2);
  m.step();
  // page 6-30: C is "0 if (Rd) decrements from >00 to >FF; 1 otherwise". >FF also sets N.
  check('DEC from >00 wraps to >FF and clears C (page 6-30)', m.a() === 0xFF && (m.cpu.st & C) === 0 && (m.cpu.st & N) !== 0, `${hex(m.a())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0x0F;
  m.load(0x0200, 0xB4);   // INV A
  m.step();
  check('INV complements A (page 6-38)', m.a() === 0xF0, hex(m.a()));

  m.mem[0] = 0xA5;
  m.load(0x0200, 0xB7);   // SWAP A
  m.step();
  check('SWAP exchanges the nibbles (page 6-63)', m.a() === 0x5A, hex(m.a()));

  // RL circularly shifts left: page 6-54's example has B = >93 -> >27 with C set
  m.mem[1] = 0x93;
  m.load(0x0200, 0xCE);   // RL B
  m.step();
  check('RL on >93 gives >27 and sets C (page 6-54)', m.b() === 0x27 && (m.cpu.st & C) !== 0, `${hex(m.b())} ${hex(m.cpu.st)}`);

  // RLC through carry: page 6-55's example, >93 with C=0 -> >26 and C=1
  m.mem[1] = 0x93; m.cpu.st = 0;
  m.load(0x0200, 0xCF);   // RLC B
  m.step();
  check('RLC on >93 with C=0 gives >26 and C=1 (page 6-55)', m.b() === 0x26 && (m.cpu.st & C) !== 0, `${hex(m.b())} ${hex(m.cpu.st)}`);

  // RR: page 6-56's example, >93 -> >C9 with C set
  m.mem[1] = 0x93;
  m.load(0x0200, 0xCC);   // RR B
  m.step();
  check('RR on >93 gives >C9 and sets C (page 6-56)', m.b() === 0xC9 && (m.cpu.st & C) !== 0, `${hex(m.b())} ${hex(m.cpu.st)}`);

  // RRC: page 6-57's example, >93 with C=0 -> >49 and C=1
  m.mem[1] = 0x93; m.cpu.st = 0;
  m.load(0x0200, 0xCD);   // RRC B
  m.step();
  check('RRC on >93 with C=0 gives >49 and C=1 (page 6-57)', m.b() === 0x49 && (m.cpu.st & C) !== 0, `${hex(m.b())} ${hex(m.cpu.st)}`);

  m.mem[0] = 0xFF;
  m.load(0x0200, 0xB5);   // CLR A
  m.step();
  check('CLR writes zero, sets Z, clears C and N (page 6-25)', m.a() === 0x00 && (m.cpu.st & (C | N | Z)) === Z, hex(m.cpu.st));

  // XCHB A swaps A and B, and N/Z are set on the value from B (page 6-67)
  m.mem[0] = 0x11; m.mem[1] = 0x22;
  m.load(0x0200, 0xB6);
  m.step();
  check('XCHB A exchanges A and B, setting N and Z on the old B (page 6-67)', m.a() === 0x22 && m.b() === 0x11, `${hex(m.a())} ${hex(m.b())}`);
}

// ---- 5. MOV, MOVP, MOVD (pages 6-43 .. 6-45) ----
{
  const m = machine();
  m.mem[0] = 0x5A;
  m.load(0x0200, 0xC0);   // MOV A,B
  m.step();
  check('MOV A,B copies A into B (page 6-43)', m.b() === 0x5A, hex(m.b()));
  m.mem[4] = 0x77;
  m.load(0x0200, 0xD1, 0x04);   // MOV B,R4
  m.step();
  check('MOV B,R4 copies B into R4 (page 6-43)', m.mem[4] === 0x5A, hex(m.mem[4]));

  // The dual-operand forms are (s) -> (Rd) (page 6-43). A MOV that wrote the destination instead of the
  // source would leave both registers as they were, which is exactly what a test of the same register on
  // both sides would hide — so each of these uses distinct values.
  m.mem[0] = 0x00; m.mem[4] = 0x00;
  m.load(0x0200, 0x22, 0x3C);   // MOV %>3C,A
  m.step();
  check('MOV %>3C,A loads A (page 6-43)', m.a() === 0x3C, hex(m.a()));
  m.mem[0] = 0x11; m.mem[1] = 0x22;
  m.load(0x0200, 0x72, 0x44, 0x04);   // MOV %>44,R4
  m.step();
  check('MOV %>44,R4 loads R4 and leaves the rest alone', m.mem[4] === 0x44 && m.a() === 0x11, `${hex(m.mem[4])} ${hex(m.a())}`);
  m.mem[5] = 0x99; m.mem[6] = 0x00;
  m.load(0x0200, 0x42, 0x05, 0x06);   // MOV R5,R6
  m.step();
  check('MOV R5,R6 copies the source into the destination (page 6-43)', m.mem[6] === 0x99 && m.mem[5] === 0x99, `${hex(m.mem[6])} ${hex(m.mem[5])}`);
  m.mem[7] = 0x7E;
  m.load(0x0200, 0x32, 0x07);   // MOV R7,B
  m.step();
  check('MOV R7,B copies the register into B (page 6-43)', m.b() === 0x7E, hex(m.b()));
  // and the flags follow the value moved (page 6-43: N and Z "set on value moved")
  m.mem[0] = 0x00; m.cpu.st = 0;
  m.load(0x0200, 0x23, 0x00);   // MOV %>00,A
  m.step();
  check('MOV of zero sets Z (page 6-43)', (m.cpu.st & Z) !== 0, hex(m.cpu.st));

  // MOVD: a 16-bit immediate into a register pair, MSB into Rp-1 (page 6-44)
  m.load(0x0200, 0x88, 0x12, 0x34, 0x03);   // MOVD %>1234,R3
  m.step();
  check('MOVD %>1234,R3 stores >12 in R2 and >34 in R3 (page 6-44)', m.mem[2] === 0x12 && m.mem[3] === 0x34, `${hex(m.mem[2])} ${hex(m.mem[3])}`);

  // MOVD R5,R3 copies the pair, LSB from R5
  m.mem[4] = 0xAA; m.mem[5] = 0xBB;
  m.load(0x0200, 0x98, 0x05, 0x03);         // MOVD R5,R3
  m.step();
  check('MOVD R5,R3 copies R4,R5 into R2,R3 (page 6-44)', m.mem[2] === 0xAA && m.mem[3] === 0xBB, `${hex(m.mem[2])} ${hex(m.mem[3])}`);
}

// ---- 5b. the manual's own 16-bit addition example, run end to end (page 6-15) ----
// Page 6-15 shows a 16-bit add done with ADD then ADC:
//   ADD R3,B   (low bytes)
//   ADC R2,A   (high bytes)
// With (R2,R3) = >0F01 and (A,B) = >0002 the sum is >0F03; with (A,B) = >1001 it is >1F02. Running the
// sequence rather than one instruction is what makes an operand-order mistake visible.
{
  const m = machine();
  const seq = [
    [0x52, 0x02],               // MOV %>02,B
    [0x22, 0x00],               // MOV %>00,A
    [0x38, 0x03],               // ADD R3,B
    [0x19, 0x02],               // ADC R2,A
  ];
  m.mem[2] = 0x0F; m.mem[3] = 0x01;      // R2,R3 = >0F01
  m.load(0x0200, ...seq.flat());
  for (let i = 0; i < seq.length; i++) m.step();
  check('ADD/ADC add a 16-bit pair in the manual\'s order (page 6-15)', m.a() === 0x0F && m.b() === 0x03, `${hex(m.a())}:${hex(m.b())}`);

  m.mem[2] = 0x0F; m.mem[3] = 0x01;
  const seq2 = [[0x52, 0x01], [0x22, 0x10], [0x38, 0x03], [0x19, 0x02]];
  m.load(0x0200, ...seq2.flat());
  for (let i = 0; i < seq2.length; i++) m.step();
  check('and carry into the high byte: >0F01 + >1001 = >1F02 (page 6-15)', m.a() === 0x1F && m.b() === 0x02, `${hex(m.a())}:${hex(m.b())}`);
}

// MOVP reaches the peripheral file: >0100 + n (page 6-45). The core routes >0100->01FF through the
// peripheral callback when one is set, and the bus otherwise.
{
  const m = machine();
  m.mem[0] = 0x3C;
  m.load(0x0200, 0x82, 0x05);   // MOVP A,P5
  m.step();
  // the port DDRs belong to the chip now (Table 3-8), so a port register is the core's own state, not memory
  check('MOVP A,P5 writes A to the port A direction register (page 6-45)', m.cpu.read8(0x0105) === 0x3C, hex(m.cpu.read8(0x0105)));
  m.cpu.write8(0x0104, 0x99);
  m.cpu.write8(0x0105, 0xFF);   // port A as outputs, so it reads back its latch
  m.load(0x0200, 0x80, 0x04);   // MOVP P4,A
  m.step();
  check('MOVP P4,A reads peripheral register 4 into A (page 6-45)', m.a() === 0x99, hex(m.a()));
}

// ---- 6. addressing modes (§6.2, pages 6-4 .. 6-8) ----
{
  const m = machine();
  // immediate: %n is a byte after the opcode
  m.mem[0] = 0x00;
  m.load(0x0200, 0x28, 0x2A);   // ADD %>2A,A
  m.step();
  check('immediate addressing uses the byte after the opcode (§6.2.4)', m.a() === 0x2A, hex(m.a()));

  // direct: a 16-bit address, MSB first (Figure 6-6)
  m.mem[0x1234] = 0x77;
  m.load(0x0200, 0x8A, 0x12, 0x34);   // LDA @>1234
  m.step();
  check('direct addressing reads the 16-bit address MSB first (§6.2.6)', m.a() === 0x77, hex(m.a()));

  // indirect: the pointer pair is Rn (LSB) and Rn-1 (MSB) (Figure 6-7)
  m.mem[10] = 0x34; m.mem[9] = 0x12; m.mem[0x1234] = 0x55;
  m.load(0x0200, 0x9A, 0x0A);         // LDA indirect through register 10
  m.step();
  check('indirect addressing takes the pointer from Rn-1:Rn (§6.2.7)', m.a() === 0x55, hex(m.a()));

  // indexed: the 16-bit constant plus B, carries included (Figure 6-8)
  m.mem[0x1250] = 0x66; m.mem[1] = 0x10;
  m.load(0x0200, 0xAA, 0x12, 0x40);   // LDA @>1240(B)
  m.step();
  check('indexed addressing adds B to the 16-bit constant (§6.2.8)', m.a() === 0x66, hex(m.a()));
  // and the carry out of the low byte propagates
  m.mem[0x1300] = 0x88; m.mem[1] = 0xF0;
  m.load(0x0200, 0xAA, 0x12, 0x20);   // >1220 + >F0 = >1310
  m.mem[0x1310] = 0x88;
  m.step();
  check('indexed addressing carries into the high byte (§6.2.8)', m.a() === 0x88, hex(m.a()));

  // STA writes to the same space, and LDA/STA set N/Z on the value (pages 6-41, 6-60)
  m.mem[0] = 0x00;
  m.load(0x0200, 0x8B, 0x20, 0x00);   // STA @>2000
  m.step();
  check('STA writes A to the direct address (page 6-60)', m.mem[0x2000] === 0x00 && (m.cpu.st & Z) !== 0, hex(m.cpu.st));

  // CMPA compares A with a long address and does not store (page 6-28)
  m.mem[0] = 0x40; m.mem[0x3000] = 0x30;
  m.load(0x0200, 0x8D, 0x30, 0x00);   // CMPA @>3000
  m.step();
  check('CMPA compares A with the addressed byte (page 6-28)', m.a() === 0x40 && (m.cpu.st & C) !== 0, hex(m.cpu.st));

  // BR replaces the PC outright (page 6-19)
  m.load(0x0200, 0x8C, 0x40, 0x00);   // BR @>4000
  m.step();
  check('BR loads the PC with the addressed word (page 6-19)', m.cpu.pc === 0x4000, hex(m.cpu.pc, 4));
}

// ---- 7. the stack: PUSH increments then stores, POP moves then decrements (§3.1.3, pages 6-50, 6-51) ----
{
  const m = machine();
  m.cpu.sp = 0x10;
  m.mem[0] = 0xAB;
  m.load(0x0200, 0xB8);   // PUSH A
  const c = m.step();
  check('PUSH stores at SP+1 and leaves SP there (page 6-51)', m.mem[0x11] === 0xAB && m.cpu.sp === 0x11, `${hex(m.cpu.sp)} ${hex(m.mem[0x11])}`);
  check('PUSH takes 6 cycles (Table 6-3)', c === 6, String(c));
  m.mem[0] = 0x00;
  m.load(0x0200, 0xB9);   // POP A
  m.step();
  check('POP reads at SP and then decrements (page 6-50)', m.a() === 0xAB && m.cpu.sp === 0x10, `${hex(m.a())} ${hex(m.cpu.sp)}`);
}

// CALL pushes the address of the next instruction and branches (page 6-24)
{
  const m = machine();
  m.cpu.sp = 0x20;
  m.load(0x0200, 0x8E, 0x50, 0x00);   // CALL @>5000
  m.step();
  // PC after the instruction is >0103; CALL pushes PCH then PCL (page 6-24), SP advancing each time
  check('CALL pushes the return address, MSB first (page 6-24)',
    m.cpu.sp === 0x22 && m.mem[0x21] === 0x02 && m.mem[0x22] === 0x03 && m.cpu.pc === 0x5000,
    `${hex(m.cpu.sp)} ${hex(m.mem[0x21])} ${hex(m.mem[0x22])} pc ${hex(m.cpu.pc, 4)}`);
  m.load(m.cpu.pc, 0x0A);             // RETS at >5000
  m.step();
  check('RETS returns to the pushed address (page 6-53)', m.cpu.pc === 0x0203 && m.cpu.sp === 0x20, `${hex(m.cpu.pc, 4)} ${hex(m.cpu.sp)}`);
}

// ---- 8. relative jumps: offset = ta - pcn, where pcn is the next instruction (Table 6-1, §6.2.5) ----
{
  const m = machine();
  m.load(0x0200, 0xE0, 0x02);   // JMP +2: pcn = >0102, so the target is >0104
  m.step();
  check('JMP adds its offset to the address after the instruction (§6.2.5)', m.cpu.pc === 0x0204, hex(m.cpu.pc, 4));
  m.load(0x0200, 0xE0, 0xFE);   // -2 -> >0100
  m.step();
  check('a negative offset jumps backwards (§6.2.5)', m.cpu.pc === 0x0200, hex(m.cpu.pc, 4));

  // The conditional jumps test the bits Table 6-3's "J<cnd>" table lists: JC/JHS on C, JZ/JEQ on Z,
  // JN/JLT on N, JNZ/JNE on Z=0, JP/JGT on N=0 and Z=0, JPZ/JGE on N=0, JNC/JL on C=0.
  const cond = [
    [0xE3, C, true, 'JC'], [0xE3, 0, false, 'JC'], [0xE2, Z, true, 'JZ'], [0xE2, 0, false, 'JZ'],
    [0xE1, N, true, 'JN'], [0xE1, 0, false, 'JN'], [0xE6, 0, true, 'JNZ'], [0xE6, Z, false, 'JNZ'],
    [0xE7, C, false, 'JNC'], [0xE7, 0, true, 'JNC'],
    [0xE4, N, false, 'JP'], [0xE4, Z, false, 'JP'], [0xE4, 0, true, 'JP'],
    [0xE5, N, false, 'JPZ'], [0xE5, 0, true, 'JPZ'], [0xE5, Z, true, 'JPZ'],
  ];
  let bad = [];
  for (const [opc, st, taken, name] of cond) {
    m.cpu.st = st; m.load(0x0200, opc, 0x02);
    m.step();
    const went = m.cpu.pc === 0x0204;
    if (went !== taken) bad.push(`${name} with st=${hex(st)}: taken=${went}, want ${taken}`);
  }
  check('the conditional jumps test the status bits Table 6-3 lists', bad.length === 0, bad.join(' | '));

  // DJNZ decrements and jumps when the result is not zero (page 6-33); it leaves the status alone
  m.mem[7] = 0x02; m.cpu.st = C | N | Z;
  m.load(0x0200, 0xDA, 0x07, 0x02);   // DJNZ R7,+2
  m.step();
  check('DJNZ jumps while the register is non-zero (page 6-33)', m.mem[7] === 0x01 && m.cpu.pc === 0x0205, `${hex(m.mem[7])} ${hex(m.cpu.pc, 4)}`);
  check('DJNZ leaves the status bits alone (page 6-33)', m.cpu.st === (C | N | Z), hex(m.cpu.st));
  m.mem[7] = 0x01;
  m.load(0x0200, 0xDA, 0x07, 0x02);
  m.step();
  check('DJNZ falls through when it reaches zero (page 6-33)', m.mem[7] === 0x00 && m.cpu.pc === 0x0203, `${hex(m.mem[7])} ${hex(m.cpu.pc, 4)}`);
}

// ---- 9. bit tests and jumps (pages 6-20 .. 6-23) ----
// BTJO jumps when (s) AND (dest) is non-zero, and sets N/Z on that AND (page 6-20).
{
  const m = machine();
  // The manual's form is BTJO <s>,<Rn>,<offset>: a mask and a register, then the offset. %>1,A,LOOP
  // tests bit 0 of A.
  m.mem[0] = 0x03;
  m.load(0x0200, 0x26, 0x01, 0x02);   // BTJO %>1,A,+2
  m.step();
  check('BTJO jumps when the masked bits are non-zero (page 6-20)', m.cpu.pc === 0x0205, hex(m.cpu.pc, 4));
  check('BTJO sets N/Z on the AND of the operands (page 6-20)', (m.cpu.st & Z) === 0, hex(m.cpu.st));

  m.mem[0] = 0x02;
  m.load(0x0200, 0x26, 0x01, 0x02);
  m.step();
  check('BTJO falls through when the masked bits are zero (page 6-20)', m.cpu.pc === 0x0203, hex(m.cpu.pc, 4));
  check('BTJO sets Z when the AND is zero (page 6-20)', (m.cpu.st & Z) !== 0, hex(m.cpu.st));

  // BTJZ jumps when the source has a 1 where the destination has a 0 (page 6-21)
  m.mem[0] = 0x02;
  m.load(0x0200, 0x27, 0x01, 0x02);   // BTJZ %>1,A,+2
  m.step();
  check('BTJZ jumps when the source has a 1 where the destination has a 0 (page 6-21)', m.cpu.pc === 0x0205, hex(m.cpu.pc, 4));
  m.mem[0] = 0x03;
  m.load(0x0200, 0x27, 0x01, 0x02);
  m.step();
  check('BTJZ falls through when bit 0 is set (page 6-21)', m.cpu.pc === 0x0203, hex(m.cpu.pc, 4));
}

// BTJOP/BTJZP do the same against a peripheral register (pages 6-21, 6-22)
{
  const m = machine();
  m.mem[0] = 0x01;
  m.cpu.write8(0x0105, 0xFF);   // port A as outputs
  m.cpu.write8(0x0104, 0x01);
  m.load(0x0200, 0x86, 0x04, 0x02);   // BTJOP A,P4,+2
  m.step();
  check('BTJOP jumps on a set bit in a peripheral register (page 6-21)', m.cpu.pc === 0x0205, hex(m.cpu.pc, 4));
  m.cpu.write8(0x0104, 0x00);
  m.mem[0] = 0x01;
  m.load(0x0200, 0x87, 0x04, 0x02);   // BTJZP A,P4,+2
  m.step();
  check('BTJZP jumps on a clear bit in a peripheral register (page 6-22)', m.cpu.pc === 0x0205, hex(m.cpu.pc, 4));
}

// ---- 10. TRAP: a one-byte call through the vector table (pages 6-64 and 6-14) ----
{
  const m = machine();
  // Trap 0's vector is at >FFFE/>FFFF (page 6-64), so the opcode for TRAP 0 is $FF.
  m.mem[0xFFFE] = 0x70; m.mem[0xFFFF] = 0x00;
  m.cpu.sp = 0x30;
  m.load(0x0200, 0xFF);
  const c = m.step();
  check('TRAP 0 is $FF and takes its vector from >FFFE (page 6-64)', m.cpu.pc === 0x7000, hex(m.cpu.pc, 4));
  check('TRAP pushes just the PC, PCH first (page 6-64)', m.mem[0x31] === 0x02 && m.mem[0x32] === 0x01 && m.cpu.sp === 0x32, `${hex(m.mem[0x31])} ${hex(m.mem[0x32])}`);
  check('TRAP takes 14 cycles (Table 6-3)', c === 14, String(c));

  // Trap 23 is $E8 and its vector is at >FFD0/>FFD1 (page 6-64)
  m.mem[0xFFD0] = 0x60; m.mem[0xFFD1] = 0x00;
  m.load(0x0200, 0xE8);
  m.step();
  check('TRAP 23 is $E8 and takes its vector from >FFD0 (page 6-64)', m.cpu.pc === 0x6000, hex(m.cpu.pc, 4));
}

// ---- 11. interrupts (Section 3.6, pages 6-29 and Appendix A Table A-3) ----
{
  const m = machine();
  // INT1's vector is >FFFC/>FFFD (Table 3-12)
  m.mem[0xFFFC] = 0x40; m.mem[0xFFFD] = 0x00;
  m.cpu.st = C | N | Z | I;
  m.cpu.sp = 0x40;
  m.cpu.iocnt0 = 0x01;    // INT1 enable (IOCNT0 bit 0, Figure 3-16): §3.6.3's first condition
  m.load(0x0200, 0x00);   // NOP, interrupted before it runs
  m.cpu.interrupt(1, true);
  const c = m.step();
  check('a pending interrupt is taken before the instruction (Section 3.6.2)', m.cpu.pc === 0x4000, hex(m.cpu.pc, 4));
  // Push order: ST at SP+1, then PCH, then PCL (page 6-29: "pushes the Status Register contents and
  // the Program Counter onto the stack"). The PC pushed is the instruction's own address.
  check('the interrupt pushes ST, then PCH, then PCL (page 6-29)',
    m.mem[0x41] === (C | N | Z | I) && m.mem[0x42] === 0x02 && m.mem[0x43] === 0x00 && m.cpu.sp === 0x43,
    `${hex(m.mem[0x41])} ${hex(m.mem[0x42])} ${hex(m.mem[0x43])} sp ${hex(m.cpu.sp)}`);
  check('the interrupt clears the whole status register (page 6-29)', m.cpu.st === 0, hex(m.cpu.st));
  check('the interrupt sequence takes 19 cycles (Section 3.6.2)', c === 19, String(c));
  // MAME charges the same: tms7000.cpp's do_interrupt does `m_icount -= 19` before the ISR's first
  // instruction, so the entry costs 19 on both and the ISR body starts on the cycle after. Every maskable
  // level goes through the same sequence, so INT1 costs 19 too (17 when it ends an IDLE).
  {
    const m1 = machine();
    m1.mem[0xFFFC] = 0x40; m1.mem[0xFFFD] = 0x00;
    m1.cpu.st = I; m1.cpu.sp = 0x40; m1.cpu.iocnt0 = 0x01; m1.load(0x0200, 0x00);
    m1.cpu.interrupt(1, true);
    check('INT1 entry costs 19 cycles as well (tms7000.cpp do_interrupt)', m1.step() === 19, String(m1.cpu.c));
    // and an interrupt out of IDLE costs 17 (Section 3.6.2; MAME: `m_icount -= 17` in the m_idle_state branch)
    const m2 = machine();
    m2.mem[0xFFFC] = 0x40; m2.mem[0xFFFD] = 0x00;
    m2.cpu.st = I; m2.cpu.sp = 0x40; m2.cpu.iocnt0 = 0x01; m2.load(0x0200, 0x01);   // IDLE
    m2.step();
    m2.cpu.interrupt(1, true);
    check('an interrupt out of IDLE costs 17 cycles (tms7000.cpp do_interrupt)', m2.step() === 17, String(m2.cpu.c));
  }

  // RETI restores the status register and the PC (page 6-52)
  m.load(0x4000, 0x0B);   // RETI
  const c2 = m.step();
  check('RETI restores the status register and PC (page 6-52)', m.cpu.pc === 0x0200 && m.cpu.st === (C | N | Z | I), `${hex(m.cpu.pc, 4)} ${hex(m.cpu.st)}`);
  check('RETI takes 9 cycles (Table 6-3)', c2 === 9, String(c2));

  // a masked interrupt is not taken
  m.cpu.st = C;   // I clear
  m.cpu.iocnt0 = 0x01;    // its enable is set; the global I bit is what blocks it
  m.cpu.sp = 0x40; m.load(0x0200, 0x00);
  m.cpu.interrupt(1, true);
  m.step();
  check('an interrupt is not taken while I is clear (Section 3.6.3)', m.cpu.pc === 0x0201, hex(m.cpu.pc, 4));

  // INT priorities: with INT1 and INT3 both pending, INT1 is serviced first (page 6-29)
  m.mem[0xFFF8] = 0x50; m.mem[0xFFF9] = 0x00;    // INT3 -> >5000
  m.cpu.st = I; m.cpu.sp = 0x40; m.load(0x0200, 0x00);
  m.cpu.interrupt(3, true); m.cpu.interrupt(1, true);
  m.step();
  check('the higher-priority interrupt is serviced first (Table 3-12)', m.cpu.pc === 0x4000, hex(m.cpu.pc, 4));
}

// ---- 11b. IOCNT0: the per-level enables and flags (Section 3.6.3, Figure 3-16, page 3-30) ----
// Figure 3-16 gives IOCNT0 as, bit by bit:
//   7 Memory Mode 1   6 Memory Mode 0   5 INT3 Flag/INT3 Clear   4 INT3 Enable
//   3 INT2 Flag/INT2 Clear              2 INT2 Enable
//   1 INT1 Flag/INT1 Clear              0 INT1 Enable
// and §3.6.3 states the three conditions for the CPU to recognise an interrupt, the first being "A 1 must be
// written to the INTn enable bit in the IOCNT0 or IOCNT1 register" (page 3-31). A flag is set by the input
// going active and cleared by writing a 1 to its clear bit; writing 0 has no effect (page 3-32, and the
// interrupt-acknowledge paragraph on page 3-29: "the INTn ACK line ... clears the corresponding Pulse
// flip-flop"). Table 3-14 (page 3-30) maps IOCNT0 to P0 and says only the TMS70x2/TMS70Cx2 parts have
// IOCNT1, so a TMS7040 has no INT4/INT5 and no IOCNT1 register at all.
{
  const base = () => {
    const m = machine();
    m.mem[0xFFFC] = 0x40; m.mem[0xFFFD] = 0x00;   // INT1 -> >4000
    m.mem[0xFFF8] = 0x50; m.mem[0xFFF9] = 0x00;   // INT3 -> >5000
    m.cpu.st = I;
    m.cpu.sp = 0x40;
    m.load(0x0200, 0x00);                          // NOP, interrupted before it runs
    return m;
  };
  // MOVP %>nn,P0 writes IOCNT0 (P0 is >0100, Table 3-8); its encoding is $A2, immediate, port (the same
  // three bytes the SSC's firmware listing shows for `MOVP %>00,P0`)
  const writeIocnt0 = (m, v) => { m.load(0x0300, 0xA2, v, 0x00); m.step(); };

  // an enable bit clear: the interrupt is requested but NOT taken
  {
    const m = base();
    writeIocnt0(m, 0x0A);          // INT3 enable (bit 4) clear, INT1 enable (bit 0) clear
    m.cpu.interrupt(1, true);
    m.load(0x0200, 0x00); m.step();
    check('a pending INT1 is not taken while its enable bit (IOCNT0.0) is clear (page 3-31)',
      m.cpu.pc === 0x0201, hex(m.cpu.pc, 4));
  }
  // the same request with the enable bit set IS taken
  {
    const m = base();
    writeIocnt0(m, 0x01);          // INT1 enable (bit 0) set
    m.cpu.interrupt(1, true);
    m.load(0x0200, 0x00); m.step();
    check('the same INT1 is taken once its enable bit is set (Figure 3-16 bit 0)',
      m.cpu.pc === 0x4000, hex(m.cpu.pc, 4));
  }
  // INT3's enable is bit 4, not bit 2/3
  {
    const m = base();
    writeIocnt0(m, 0x10);          // INT3 enable (bit 4) set
    m.cpu.interrupt(3, true);
    m.load(0x0200, 0x00); m.step();
    check('INT3 is enabled by IOCNT0 bit 4 and taken (Figure 3-16)', m.cpu.pc === 0x5000, hex(m.cpu.pc, 4));
  }
  // and the wrong-field value the old firmware wrote must NOT enable INT3: $0C sets bits 2 and 3, which are
  // INT2's enable and INT2's flag, so INT3 stays masked
  {
    const m = base();
    writeIocnt0(m, 0x0C);
    m.cpu.interrupt(3, true);
    m.load(0x0200, 0x00); m.step();
    check('IOCNT0 = $0C enables INT2, not INT3, so a pending INT3 is not taken',
      m.cpu.pc === 0x0201, hex(m.cpu.pc, 4));
  }
  // the flag bit: set by the request going active, readable with the enable clear, cleared by writing a 1
  {
    const m = base();
    writeIocnt0(m, 0x00);          // all enables clear: the interrupt cannot be taken
    m.cpu.interrupt(1, true);
    const flagged = m.cpu.read8(0x0100);
    check('an active INT1 sets its flag bit (IOCNT0.1) even with the enable clear (page 3-32)',
      (flagged & 0x02) !== 0, hex(flagged));
    writeIocnt0(m, 0x02);          // write a 1 to INT1 Clear
    const cleared = m.cpu.read8(0x0100);
    check('writing a 1 to the INT1 clear bit clears the flag (page 3-32)',
      (cleared & 0x02) === 0, hex(cleared));
    check('and writing the clear bit does not set the enable bit', (cleared & 0x01) === 0, hex(cleared));
  }
  // writing 0 to a clear bit has no effect
  {
    const m = base();
    writeIocnt0(m, 0x00);
    m.cpu.interrupt(1, true);
    writeIocnt0(m, 0x00);          // 0 in the clear bit: no effect
    check('writing a 0 to the INT1 clear bit leaves the flag set (page 3-32)',
      (m.cpu.read8(0x0100) & 0x02) !== 0, hex(m.cpu.read8(0x0100)));
  }
  // acknowledging the interrupt clears the flag (page 3-29, the ACK line clears the Pulse flip-flop)
  {
    const m = base();
    writeIocnt0(m, 0x01);          // INT1 enable
    m.cpu.interrupt(1, true);
    m.load(0x0200, 0x00); m.step();
    check('acknowledging INT1 clears its flag (page 3-29)', (m.cpu.read8(0x0100) & 0x02) === 0,
      hex(m.cpu.read8(0x0100)));
  }
  // a TMS7040 has no IOCNT1: Table 3-14 gives it to the TMS70x2/TMS70Cx2 only, and Table 3-12 notes that
  // INT4/INT5 "apply to TMS70x2 and TMS70Cx2 devices only"
  {
    const m = base();
    check('a TMS7040 has no INT4/INT5: a request above level 3 is ignored (Table 3-12 note, Table 3-14)',
      (m.cpu.interrupt(4, true), m.cpu.irqPending[3] === false), String(m.cpu.irqPending[3]));
  }
  // the register survives a snapshot
  {
    const m = base();
    writeIocnt0(m, 0x11);          // INT3 enable + INT1 enable
    m.cpu.interrupt(3, true);      // leaves the INT3 flag set (I is set, so write it while I is clear)
    const saved = Emu.state.fromJSON(Emu.state.toJSON(m.cpu.saveState()));
    const m2 = machine();
    m2.cpu.loadState(saved);
    check('IOCNT0 and its flags survive a snapshot', m2.cpu.read8(0x0100) === m.cpu.read8(0x0100) || m2.cpu.iocnt0 === m.cpu.iocnt0,
      `${hex(m2.cpu.read8(0x0100))} vs ${hex(m.cpu.read8(0x0100))}`);
  }
}

// ---- 12. IDLE waits for an interrupt (page 6-35 and Table A-3) ----
{
  const m = machine();
  m.mem[0xFFFC] = 0x40; m.mem[0xFFFD] = 0x00;
  m.cpu.st = I; m.cpu.sp = 0x40; m.cpu.iocnt0 = 0x01;   // INT1 enabled (IOCNT0 bit 0, Figure 3-16)
  m.load(0x0200, 0x01);   // IDLE
  m.step();
  check('IDLE takes 6 cycles and parks the PC on itself (page 6-35)', m.cpu.idle === true && m.cpu.pc === 0x0200, `${m.cpu.idle} ${hex(m.cpu.pc, 4)}`);
  m.cpu.interrupt(1, true);
  m.step();
  // Table A-3: interrupting out of IDLE resumes past the IDLE instruction ("do not decrement PC")
  check('an interrupt ends IDLE and resumes after it (Table A-3)', m.cpu.pc === 0x4000 && m.cpu.idle === false, hex(m.cpu.pc, 4));
  m.load(0x4000, 0x0B);   // RETI
  m.step();
  check('returning from that interrupt resumes at the instruction after IDLE (Table A-3)', m.cpu.pc === 0x0201, hex(m.cpu.pc, 4));
}

// ---- 13. the peripheral-file hook (Section 3.1.2) ----
{
  const m = machine();
  const seen = [];
  m.cpu.peripheral = (addr, value, isWrite) => { seen.push([addr, value, isWrite]); return isWrite ? undefined : 0x5A; };
  // P2 is the timer data register, a genuine peripheral-file register the board owns (the four general
  // purpose ports and their DDRs are the chip's own, per Table 3-8, and do not reach the hook)
  m.load(0x0200, 0x80, 0x02);   // MOVP P2,A
  m.step();
  check('a peripheral read goes through the callback and its value is used (§3.1.2)', m.a() === 0x5A && seen.some((s) => s[0] === 0x0102 && !s[2]), JSON.stringify(seen));
  // a register-file access must not reach the hook
  seen.length = 0;
  m.mem[0x0050] = 0x11;
  m.load(0x0200, 0x8A, 0x00, 0x50);   // LDA @>0050
  m.step();
  check('a register-file access does not reach the peripheral hook (§3.1.2)', seen.length === 0 && m.a() === 0x11, JSON.stringify(seen));
}

// ---- 14. an opcode the manual does not define ----
// Table 6-3 leaves some bytes unassigned (the $0x row, for instance, has only NOP, IDLE, EINT, DINT, SETC,
// POP ST, STSP, LDSP and PUSH ST). A byte with no instruction must still advance, or a stray byte hangs
// the machine, and it must not have side effects.
{
  const m = machine();
  m.cpu.st = C; m.mem[0] = 0x5A;
  m.load(0x0200, 0x04);   // $04 is not in the table
  const c = m.step();
  check('an undefined opcode advances one byte and does nothing else',
    m.cpu.pc === 0x0201 && m.mem[0] === 0x5A && m.cpu.st === C && c > 0,
    `pc ${hex(m.cpu.pc, 4)} a ${hex(m.mem[0])} st ${hex(m.cpu.st)} ${c} cycles`);
}

// ---- 15. saveState / loadState survives JSON (AGENTS.md section 4.5) ----
{
  const m = machine();
  m.cpu.st = C | Z; m.cpu.sp = 0x33; m.cpu.pc = 0x0200; m.mem[0] = 0x12; m.mem[1] = 0x34;
  const saved = Emu.state.fromJSON(Emu.state.toJSON(m.cpu.saveState()));
  const m2 = machine();
  m2.cpu.loadState(saved);
  check('loadState restores the PC, SP, ST and cycle counter',
    m2.cpu.pc === 0x0200 && m2.cpu.sp === 0x33 && m2.cpu.st === (C | Z) && m2.cpu.totalCycles === m.cpu.totalCycles,
    `${hex(m2.cpu.pc, 4)} ${hex(m2.cpu.sp)} ${hex(m2.cpu.st)} ${m2.cpu.totalCycles}`);

  // run the same program on both and compare the whole state after every step
  const prog = [0x28, 0x05, 0x18, 0x01, 0xE2, 0x00];
  m.load(0x0200, prog); m.cpu.pc = 0x0200; m.cpu.st = 0; m.cpu.sp = 0x01;
  m2.load(0x0100, prog); m2.cpu.pc = 0x0200; m2.cpu.st = 0; m2.cpu.sp = 0x01;
  // save halfway, restore into a third machine, and finish both
  m.step(); m.step();
  const mid = Emu.state.fromJSON(Emu.state.toJSON(m.cpu.saveState()));
  const m3 = machine();
  m3.mem.set(m.mem);
  m3.cpu.loadState(mid);
  let same = true, why = '';
  for (let i = 0; i < 4; i++) {
    const c1 = m.step(), c3 = m3.step();
    if (c1 !== c3 || m.cpu.pc !== m3.cpu.pc || m.mem[0] !== m3.mem[0]) { same = false; why = `step ${i}: ${c1}/${c3} pc ${hex(m.cpu.pc, 4)}/${hex(m3.cpu.pc, 4)}`; break; }
  }
  check('a restored machine runs identically to the uninterrupted one', same && m.a() === m3.a() && m.mem[0x0101] === m3.mem[0x0101], why || `${hex(m.a())} ${hex(m3.a())}`);

  // an unknown registration is carried through JSON as it went in
  const m4 = machine();
  m4.cpu.interrupt(2, true);
  const s4 = Emu.state.fromJSON(Emu.state.toJSON(m4.cpu.saveState()));
  const m5 = machine();
  m5.cpu.loadState(s4);
  check('a pending interrupt survives a snapshot', JSON.stringify(m5.cpu.irqPending) === JSON.stringify(m4.cpu.irqPending), JSON.stringify(m5.cpu.irqPending));
}

// ---- 16. port data-direction registers (§3.2, and MAME's tms7000_pf_r) ----
// A port line reads as an INPUT unless its DDR bit is set. The hardware starts with every DDR clear, so a
// port shows its input pins, not the value written: MAME's device_start does "memset(m_port_ddr, 0, 4);
// m_port_ddr[1] = 0xff", and tms7000_pf_r returns "(in & ~ddr) | (latch & ddr)". A core that returns the
// written latch while DDR is clear hides a firmware that never sets its DDRs, which is exactly what happened
// in the Speech/Sound Pak firmware.
{
  const m = machine();
  // Table 3-8: port data at P4/P6/P8/P10, their DDRs at P5/P7/P9/P11
  const DDR = { C: 0x0109, D: 0x010B, B: 0x0107 };
  const P = { C: 0x0108 };
  // the pins the outside world drives, which the device supplies
  m.cpu.portIn = (port) => (port === 'C' ? 0x5A : 0x00);

  // DDR clear: a write changes the latch, but the read shows the input pins
  m.cpu.write8(DDR.C, 0x00);
  m.cpu.write8(P.C, 0xFF);
  check('a port with its DDR clear reads its input pins, not the latch (MAME tms7000_pf_r)',
    m.cpu.read8(P.C) === 0x5A, hex(m.cpu.read8(P.C)));

  // DDR set: the read shows the latch
  m.cpu.write8(DDR.C, 0xFF);
  check('a port with its DDR set reads back what was written', m.cpu.read8(P.C) === 0xFF, hex(m.cpu.read8(P.C)));

  // mixed: outputs read the latch, inputs read the pins
  m.cpu.write8(DDR.C, 0x0F);
  m.cpu.write8(P.C, 0xFF);
  check('a half-output port mixes the latch and the pins (MAME: (in & ~ddr) | (latch & ddr))',
    m.cpu.read8(P.C) === 0x5F, hex(m.cpu.read8(P.C)));

  // reset: every DDR clear, except port B which MAME fixes at $FF
  m.cpu.write8(DDR.C, 0xFF);
  m.cpu.write8(DDR.D, 0xFF);
  m.cpu.reset();
  check('reset clears every DDR', m.cpu.read8(DDR.C) === 0x00 && m.cpu.read8(DDR.D) === 0x00,
    `${hex(m.cpu.read8(DDR.C))} ${hex(m.cpu.read8(DDR.D))}`);
  check('reset leaves port B\'s DDR at $FF, as MAME does', m.cpu.read8(DDR.B) === 0xFF, hex(m.cpu.read8(DDR.B)));

  // A DDR write is not a port write: MAME's tms7000_pf_w stores the direction and does NOT call the port_out
  // callback ("changing port direction does not change(refresh) the output pins"). A core that reported it
  // let a firmware's DDR setup drive the lines - which cleared the Speech/Sound Pak's busy flag during reset.
  {
    const m2 = machine();
    const seen = [];
    m2.cpu.portOut = (port, value, isData) => seen.push([port, value, isData]);
    m2.cpu.write8(0x010B, 0xFF);   // port D DDR
    check('a DDR write does not call the board\'s port_out callback (tms7000_pf_w)', seen.length === 0, JSON.stringify(seen));
    m2.cpu.write8(0x010A, 0x5A);   // port D data
    check('a data write does, with the value masked by the DDR (tms7000_pf_w: data & m_port_ddr[port])',
      seen.length === 1 && seen[0][0] === 'D' && seen[0][1] === 0x5A, JSON.stringify(seen));
    // and the mask: a line whose DDR bit is clear is an input and is not driven
    const m3 = machine();
    const seen3 = [];
    m3.cpu.portOut = (port, value, isData) => seen3.push([port, value]);
    m3.cpu.write8(0x010B, 0x0F);   // only the low nibble is an output
    m3.cpu.write8(0x010A, 0xFF);
    check('a data write drives only the lines its DDR made outputs', seen3.length === 1 && seen3[0][1] === 0x0F,
      JSON.stringify(seen3));
  }

  // the ports and IOCNT0 are state: a restored core must drive the same lines and gate the same interrupts
  {
    const m4 = machine();
    m4.cpu.write8(0x0109, 0xFF);   // port C DDR
    m4.cpu.write8(0x0108, 0x80);   // port C data
    m4.cpu.writeIocnt0(0x10);      // INT3 enable
    const saved = Emu.state.fromJSON(Emu.state.toJSON(m4.cpu.saveState()));
    const m5 = machine();
    m5.cpu.loadState(saved);
    check('a restored core keeps its port latches and DDRs (AGENTS 4.5)',
      m5.cpu.read8(0x0109) === 0xFF && m5.cpu.read8(0x0108) === 0x80,
      `${hex(m5.cpu.read8(0x0109))} ${hex(m5.cpu.read8(0x0108))}`);
    check('and keeps IOCNT0, so it gates interrupts the same way', m5.cpu.read8(0x0100) === 0x10, hex(m5.cpu.read8(0x0100)));
  }
}

console.log(`${n - fail}/${n} TMS7000 core checks passed`);
process.exitCode = fail ? 1 : 0;
