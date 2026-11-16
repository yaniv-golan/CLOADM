// Run: node tests/cpu6309.test.js
//
// Hitachi HD6309: every 6309-only instruction and addressing mode, its encoded length, its results, its
// condition codes and its cycle count in both CPU modes, plus the divide-by-zero trap and the TFR/EXG rules.
//
// Tests are written as 6309 assembly and run through the project's own assembler, so a test exercises the
// encoder and the CPU together (as the lockstep firmware does) and no opcode is hand-entered here -- except
// for the four TFM forms, which are emitted as raw bytes so that a defect in the assembler's TFM encoder
// cannot hide a defect in the core. That exception is explained where it is used, in section 5.
//
// Expected values, in order of authority:
//  - Hitachi "HD63B09EP Technical Reference Guide" (Simpson & DeKok, 1994), Table 9 "Opcode table"
//    (pp. 27-30) with its "Cycles 6809 (6309)" column: the unbracketed number is the count in 6809
//    emulation mode and the bracketed one the count in 6309 native mode. [G <page>]
//  - "Sock's Accelerated 6309 CPU Cycle Charts" (sock/cocofile/4mzcycle.html), which Tim Lindner's
//    "Addendum to The 6309 Book" cites and which prints three counts: A (6309 emulation), B (6309
//    native), C (accelerated). Where the guide and the chart differ the chart is used and the row says
//    so. [S]
//  - Hitachi HD6309E data sheet Table 9/10 (1991 8/16-bit Microprocessor Data Book, U70-B), for the
//    encoded length of each instruction. [DS <page>]
//
// MAME 0.289's m6309 is NOT an oracle for timing: measured with a loop-differential firmware it charges
// MULD 4 cycles (docs: 28), SEXW 1 (docs: 4), BITMD 3 (docs: 4), and takes the native-mode count for
// ANDD/ORD/EORD/BITD in emulation mode. Those are MAME bugs and the tests follow the hardware. See the
// "MAME deviation" table at the end of this file and docs/cpu6309.md.
const Emu = require('./load')();
const { CPU6309, CPU6809 } = Emu;

let failures = 0, count = 0;
function check(name, got, want) {
  count++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${hex(got)} want ${hex(want)}`); }
}
const hex = (v) => (typeof v === 'number' ? '$' + v.toString(16).toUpperCase() : String(v));
const F = CPU6309.FLAGS;

// Assemble `src` with the 6309 assembler and return its bytes and symbol table. Instruction lines in the
// sources below are written with a leading space, as the assembler expects (a line starting at column 0 is
// a label).
function asm(src) {
  const r = Emu.assemble(src, '6309');
  if (!r.ok) throw new Error(r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  return { bytes: Array.from(r.segments[0].data), sym: r.symbols, seg: r.segments[0], addr: r.segments[0].addr };
}

// Build a CPU with `src` at $1000 (plus optional data), reset, and run n instructions (default: to HALT).
function run(src, { native = false, setup, steps = 0, at = 0x1000, mameCompat = false } = {}) {
  const a = asm(` ORG $${at.toString(16)}\n${src}\n BRA *\n END`);
  const mem = new Uint8Array(0x10000);
  mem.set(a.bytes, a.addr);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
  const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
  cpu.reset();
  cpu.s = 0x8000;
  if (setup) setup(cpu, mem);
  if (native) { cpu.md |= 1; }
  if (mameCompat) cpu.mameCompat = true;
  let ran = 0, cycles = 0;
  const limit = steps || 10000;
  while (ran < limit) {
    if (steps && ran === steps) break;
    const pc = cpu.pc;
    if (mem[pc] === 0x20 && mem[pc + 1] === 0xFE) break;   // BRA *
    cycles += cpu.step();
    ran++;
  }
  return { cpu, mem, cycles, ran };
}

// cycle count of the single instruction in `src`, in the given mode
function cyclesOf(src, native = false, setup, mameCompat = false) {
  return run(indent(src), { native, setup, steps: 1, mameCompat }).cycles;
}

// table rows store instructions unindented for readability; give each line the leading space the
// assembler needs (a line starting at column 0 is a label)
const indent = (src) => src.split('\n').map((l) => (l.trim() && !/^\s/.test(l) ? ' ' + l : l)).join('\n');

// ---------------------------------------------------------------------------------------------
// 1. Registers
// ---------------------------------------------------------------------------------------------
{
  const { cpu } = run(' LDD #$1122\n LDW #$3344');
  check('Q = D:W', cpu.q, 0x11223344);
  check('W = E:F', cpu.w, 0x3344);
  cpu.q = 0xAABBCCDD;
  check('Q write splits into D:W', cpu.d, 0xAABB);
  check('Q write splits into W', cpu.w, 0xCCDD);
  check('E', cpu.e, 0xCC);
  check('F', cpu.f, 0xDD);
}

// ---------------------------------------------------------------------------------------------
// 2. TFR / EXG with the 6309 register file.
// Rules measured on MAME 0.289's m6309 (read_exgtfr_register/write_exgtfr_register in hd6309.cpp):
// an 8-bit source is replicated into both bytes (A=$12 -> $1212); a 16-bit value written to A, E or DP
// takes the HIGH byte, and to B, F or CC the LOW byte; the zero register is 16-bit. [G p.4]
// ---------------------------------------------------------------------------------------------
{
  const { cpu } = run(' LDA #$12\n TFR A,X', { setup: (c) => { c.x = 0; } });
  check('TFR A,X replicates', cpu.x, 0x1212);
}
{
  const { cpu } = run(' LDE #$34\n TFR E,Y', { setup: (c) => { c.y = 0; } });
  check('TFR E,Y replicates', cpu.y, 0x3434);
}
{
  const { cpu } = run(' LDX #$ABCD\n TFR X,A', { setup: (c) => { c.a = 0; } });
  check('TFR X,A takes the high byte', cpu.a, 0xAB);
}
{
  const { cpu } = run(' LDX #$ABCD\n TFR X,E', { setup: (c) => { c.e = 0; } });
  check('TFR X,E takes the high byte', cpu.e, 0xAB);
}
{
  const { cpu } = run(' LDD #$1234\n TFR 0,D', { setup: (c) => { c.d = 0x1234; } });
  check('TFR 0,D clears D', cpu.d, 0);
}
{
  const { cpu } = run(' LDD #$1234\n TFR D,0', { setup: (c) => { c.d = 0x1234; } });
  check('TFR D,0 writes nowhere', cpu.d, 0x1234);
}
{
  const { cpu } = run(' LDE #$12\n LDF #$34\n EXG E,F');
  check('EXG E,F -> E', cpu.e, 0x34);
  check('EXG E,F -> F', cpu.f, 0x12);
}
{
  const { cpu } = run(' LDW #$ABCD\n TFR W,D', { setup: (c) => { c.d = 0; } });
  check('TFR W,D', cpu.d, 0xABCD);
}
{
  const { cpu } = run(' LDW #$ABCD\n TFR D,W', { setup: (c) => { c.d = 0x1234; c.w = 0; } });
  check('TFR D,W', cpu.w, 0x1234);
}
// V is a plain 16-bit register reachable only through TFR/EXG [G p.3]; reset leaves it unchanged
{
  const { cpu } = run(' TFR D,V', { setup: (c) => { c.d = 0xBEEF; } });
  check('TFR D,V', cpu.v, 0xBEEF);
}

// ---------------------------------------------------------------------------------------------
// 3. SEXW
// ---------------------------------------------------------------------------------------------
{
  const cases = [[0xFF80, 0xFFFF, true, false], [0x0001, 0x0000, false, false],
    [0x0000, 0x0000, false, true], [0x8000, 0xFFFF, true, false], [0x7FFF, 0x0000, false, false]];
  for (const [w, d, n, z] of cases) {
    const { cpu } = run(' SEXW', { setup: (c) => { c.w = w; c.d = 0x5555; } });
    check(`SEXW W=$${w.toString(16)} -> D`, cpu.d, d);
    check(`SEXW W=$${w.toString(16)} N`, !!(cpu.cc & F.N), n);
    check(`SEXW W=$${w.toString(16)} Z`, !!(cpu.cc & F.Z), z);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Encoded lengths [DS pp.379-380]
// ---------------------------------------------------------------------------------------------
const LENGTHS = [
  ['LDQ #', 'LDQ #$11223344', 5], ['LDQ direct', 'LDQ <$10', 3], ['LDQ indexed', 'LDQ ,X', 3],
  ['LDQ extended', 'LDQ $3000', 4], ['STQ direct', 'STQ <$10', 3], ['STQ extended', 'STQ $3000', 4],
  ['LDW #', 'LDW #$1234', 4], ['STW direct', 'STW <$10', 3],
  ['LDE #', 'LDE #$5A', 3], ['STE direct', 'STE <$10', 3], ['LDF #', 'LDF #$A5', 3], ['STF direct', 'STF <$10', 3],
  // DIVD's immediate is ONE byte; DIVQ's and MULD's are two [DS p.379; MAME disassembler { 0x118D, 1 }]
  ['DIVD #', 'DIVD #$07', 3], ['DIVQ #', 'DIVQ #$0003', 4], ['MULD #', 'MULD #$0010', 4],
  ['SEXW', 'SEXW', 1], ['CLRD', 'CLRD', 2], ['PSHSW', 'PSHSW', 2], ['LDMD #', 'LDMD #$01', 3],
  ['BITMD #', 'BITMD #$C0', 3], ['AIM direct', 'AIM #$0F,<$10', 3], ['TIM extended', 'TIM #$01,$3000', 4],
  ['ADDR', 'ADDR D,X', 3], ['CMPR', 'CMPR D,Y', 3], ['BAND', 'BAND A,0,7,<$10', 4], ['STBT', 'STBT A,7,0,<$10', 4],
  ['TFM X+,Y+', 'TFM X+,Y+', 3], ['TFM X-,Y-', 'TFM X-,Y-', 3],
  ['TFM X+,Y', 'TFM X+,Y', 3], ['TFM X,Y+', 'TFM X,Y+', 3],
];
for (const [name, src, want] of LENGTHS) {
  const a = asm(` ORG $1000\n${indent(src)}\n BRA *\n END`);
  check(`length ${name}`, a.bytes.length - 2, want);
}

// TFM has exactly four forms, one per opcode; any other shape is not an instruction and must be rejected
// rather than quietly mapped onto the nearest one [Atkinson printed p.136 gives the four rows
// (r0+,r1+ / r0-,r1- / r0+,r1 / r0,r1+), and his Programming Aid table, printed p.149, names them; the guide
// p. 6 and its mnemonic table printed p. 25 give the same four].
//
// The encoder used to fall through a direction chain, so four different kinds of wrong spelling each became
// a DIFFERENT instruction with no diagnostic:
//   TFM X,Y   -> 11 3B 12  (is TFM X,Y+)
//   TFM X+,U- -> 11 39 13  (is TFM X-,U-)
//   TFM X-,Y+ -> 11 39 12  (is TFM X-,Y-)
//   TFM X-,Y  -> 11 39 12  (is TFM X-,Y-)
//   TFM X,Y-  -> 11 39 12  (is TFM X-,Y-)
// The guard is on the direction PAIR, so these and every other non-form go the same way.

// Every legal form for every register pair: 5 registers x 5 x 4 direction pairs = 100 encodings. The opcode
// comes from the direction pair and the postbyte from the two registers, and both are asserted, so a guard
// that wrongly rejected a nameable form (e.g. one naming D, U or S) fails here rather than passing because
// the old tests only ever wrote X and Y.
{
  const RC = { D: 0x0, X: 0x1, Y: 0x2, U: 0x3, S: 0x4 };
  const DIRS = [['+', '+', 0x38], ['-', '-', 0x39], ['+', '', 0x3A], ['', '+', 0x3B]];
  let wrong = [];
  for (const [sr, src] of Object.entries(RC)) for (const [dr, dst] of Object.entries(RC)) {
    for (const [a, b, op] of DIRS) {
      const text = `TFM ${sr}${a},${dr}${b}`;
      const r = Emu.assemble(` ORG $1000\n ${text}\n END`, '6309');
      const by = r.ok ? Array.from(r.segments[0].data) : [];
      const want = [0x11, op, (src << 4) | dst];
      if (!r.ok || by.join(',') !== want.join(',')) wrong.push(`${text} -> ${r.ok ? by.map((x) => x.toString(16)) : r.errors[0].message} want ${want.map((x) => x.toString(16))}`);
    }
  }
  check('all 100 legal TFM encodings (every register pair and direction pair)', wrong.length, 0);
}
// Every shape that is not one of the four, over several register pairs so the rule cannot be satisfied by
// special-casing the pair a test happens to name.
{
  const bad = ['X,Y', 'D,U', 'S,D', 'U,X', 'Y,D',            // both parked: no opcode parks both
    'X+,Y-', 'X-,Y+', 'D+,U-', 'U-,S+',                     // mixed: no opcode moves one up and one down
    'X-,Y', 'X,Y-', 'U-,D', 'S,D-',                      // one-sided minus: no such form
    'X,X', 'D,D'];                                         // both parked, same register: still no such form
  const notRejected = bad.filter((f) => Emu.assemble(` ORG $1000\n TFM ${f}\n END`, '6309').ok);
  check('every non-form TFM spelling is rejected', notRejected.join(' '), '');
  // the message has to name TFM and say what the four forms are, not just fail
  const msg = (Emu.assemble(' ORG $1000\n TFM X+,Y-\n END', '6309').errors[0] || {}).message || '';
  check('the rejection names TFM', /TFM/.test(msg), true);
  // all four forms, not just that the word TFM appears: a message naming only two of them would leave the
  // user without the pair they need. The four are R+,R+ / R-,R- / R+,R / R,R+.
  const allFour = ['R+,R+', 'R-,R-', 'R+,R', 'R,R+'].every((f) => msg.includes(f));
  check('the rejection names all four legal forms', allFour, true);
}

// ---------------------------------------------------------------------------------------------
// 5. Results and condition codes
// ---------------------------------------------------------------------------------------------
{
  const { cpu } = run(' ANDD #$0F0F', { setup: (c) => { c.d = 0xAABB; } });
  check('ANDD result', cpu.d, 0x0A0B);
  check('ANDD clears V', cpu.cc & F.V, 0);
}
{
  const { cpu } = run(' ORD #$F0F0', { setup: (c) => { c.d = 0x0A0B; } });
  check('ORD result', cpu.d, 0xFAFB);
  check('ORD N', cpu.cc & F.N, F.N);
}
{
  const { cpu } = run(' LDD #$0064\n DIVD #$07');
  // DIVD puts the quotient in B and the remainder in A -- the result is in D, and W is untouched
  // [Atkinson p.59 "ACCB' <- ACCD / (M); ACCA' <- ACCD MOD (M)"].
  check('DIVD quotient in B', cpu.b, 14);
  check('DIVD remainder in A', cpu.a, 2);
  check('DIVD leaves W alone', cpu.w, 0);
}
{
  const { cpu } = run(' LDD #$0010\n MULD #$0010');
  check('MULD result', cpu.q >>> 0, 0x100);
}
{
  const { cpu } = run(' ADDE #$05', { setup: (c) => { c.e = 0x10; } });
  check('ADDE result', cpu.e, 0x15);
}
{
  const { cpu } = run(' SUBW #$0004', { setup: (c) => { c.w = 0x0100; } });
  check('SUBW result', cpu.w, 0x00FC);
}
{
  const { cpu } = run(' CLRD', { setup: (c) => { c.d = 0x1234; } });
  check('CLRD result', cpu.d, 0);
  check('CLRD Z', !!(cpu.cc & F.Z), true);
}
{
  // COMD/COMW/COME/COMF: ones-complement the register, V always cleared and C always set [Atkinson
  // "COM (accumulator)", printed p. 53; MAME's COM8 does the same]. The result and both flags are checked
  // for each form, because the V clearing was missing here and no test noticed.
  const com = (src, setup, read) => { const r = run(' ' + src, { setup, steps: 1 }); return { got: read(r.cpu), cc: r.cpu.cc }; };
  const cases = [
    ['COMD', (c) => { c.d = 0x1234; }, (c) => c.d, 0xEDCB],
    ['COMW', (c) => { c.w = 0x00FF; }, (c) => c.w, 0xFF00],
    ['COME', (c) => { c.e = 0x0F; }, (c) => c.e, 0xF0],
    ['COMF', (c) => { c.f = 0xA5; }, (c) => c.f, 0x5A],
  ];
  for (const [name, setup, read, want] of cases) {
    // start with V set and C clear, so a missing clear/set would show either way
    const r = com(name, (c) => { setup(c); c.cc = F.V; }, read);
    check(`${name} result`, r.got, want);
    check(`${name} clears V`, !!(r.cc & F.V), false);
    check(`${name} sets C`, !!(r.cc & F.C), true);
  }
  // and the zero result still sets Z, so the NZ flags are not lost while V is cleared
  const z = com('COME', (c) => { c.e = 0xFF; c.cc = F.V; }, (c) => c.e);
  check('COME of $FF gives 0', z.got, 0);
  check('COME sets Z for a zero result', !!(z.cc & F.Z), true);
}
{
  // NEGD is NEG on W's low word. Its flags follow the 8-bit NEG rule at the word size [data sheet NEG:
  // V set only for the most negative value, C set unless the operand was 0], and a mutant that got either
  // one wrong would keep every earlier result check passing.
  const neg = (d) => run(' NEGD', { setup: (c) => { c.d = d; } }).cpu;
  check('NEGD result', neg(0x0001).d, 0xFFFF);
  const one = neg(0x0001);
  check('NEGD sets C for a non-zero operand', !!(one.cc & F.C), true);
  check('NEGD clears V for a non-zero operand', !!(one.cc & F.V), false);
  const zero = neg(0x0000);
  check('NEGD leaves C clear for 0', !!(zero.cc & F.C), false);
  check('NEGD leaves V clear for 0', !!(zero.cc & F.V), false);
  const min = neg(0x8000);
  check('NEGD sets V at $8000 (the most negative word)', !!(min.cc & F.V), true);
  check('NEGD sets C at $8000', !!(min.cc & F.C), true);
}
// AIM/OIM/EIM/TIM on memory, with N/Z from the result [G p.4]
{
  const { cpu, mem } = run(' AIM #$0F,<$10', { setup: (c, m) => { m[0x10] = 0xAA; } });
  check('AIM direct result', mem[0x10], 0x0A);
  check('AIM N', !!(cpu.cc & F.N), false);
  check('AIM Z', !!(cpu.cc & F.Z), false);
}
{
  const { mem } = run(' LDX #$0010\n AIM #$0F,,X', { setup: (c, m) => { m[0x10] = 0xAA; } });
  check('AIM indexed result', mem[0x10], 0x0A);
}
{
  const { mem } = run(' AIM #$0F,$2010', { setup: (c, m) => { m[0x2010] = 0xAA; } });
  check('AIM extended result', mem[0x2010], 0x0A);
}
{
  const { mem } = run(' TIM #$01,<$10', { setup: (c, m) => { m[0x10] = 0xFF; } });
  check('TIM does not write', mem[0x10], 0xFF);
}
// the bit operations on memory [Atkinson p.20]: postbyte bits 5-3 are the memory SOURCE bit, bits 2-0 the
// register DESTINATION bit, and the operation writes the register's bit: r.dstBit' <- r.dstBit OP mem.srcBit.
// The syntax is BAND register,sourceBit,destinationBit,address.
{
  // BAND A,7,0,<$10 : A bit 0 AND memory bit 7 -> A bit 0
  const { cpu } = run(' BAND A,7,0,<$10', { setup: (c, m) => { c.a = 0x01; m[0x10] = 0x80; } });
  check('BAND sets bit', cpu.a & 1, 1);
}
{
  const { cpu } = run(' BIAND A,7,0,<$10', { setup: (c, m) => { c.a = 0x01; m[0x10] = 0x00; } });
  check('BIAND inverted', cpu.a & 1, 1);
}
{
  const { cpu } = run(' LDBT A,7,0,<$10', { setup: (c, m) => { m[0x10] = 0x80; c.a = 0; } });
  check('LDBT copies memory bit to the register', cpu.a & 1, 1);
}
{
  // STBT reverses the roles: the register bit is the SOURCE (3rd operand position in the syntax is the
  // register bit) and the memory bit is the destination [Atkinson p.148 "M8.dstBit = R.srcBit"].
  const { mem } = run(' STBT A,7,0,<$10', { setup: (c, m) => { c.a = 0x01; m[0x10] = 0x00; } });
  check('STBT writes the register bit to memory', mem[0x10], 0x80);
}
{
  // no condition code flags are affected by these instructions: leaving A non-zero must not clear Z
  const { cpu } = run(' BAND A,7,0,<$10', { setup: (c, m) => { c.a = 0x01; m[0x10] = 0x80; c.cc = 0x04; } });
  check('BAND leaves the flags alone', cpu.cc, 0x04);
}
// inter-register ops [G p.4]. Same-size forms only: the guide says mixed-size inter-register results are
// "unknown" (p.4), so there is nothing to assert for them; the core promotes to the 16-bit containing
// register, which is what MAME 0.289 does.
{
  const { cpu } = run(' ADDR D,X', { setup: (c) => { c.d = 0xFFFF; c.x = 0x0001; } });
  check('ADDR D,X result', cpu.x, 0);
  check('ADDR D,X carry', cpu.cc & F.C, F.C);
}
{
  const { cpu } = run(' ANDR A,B', { setup: (c) => { c.a = 0xF0; c.b = 0x0F; c.cc = 0x20; } });
  check('ANDR A,B result', cpu.b, 0);
  check('ANDR A,B clears H', cpu.cc & F.H, 0);
}
{
  const { cpu } = run(' ORR A,B', { setup: (c) => { c.a = 0xF0; c.b = 0x0F; } });
  check('ORR A,B result', cpu.b, 0xFF);
}
{
  // r1' <- r1 - r0, so SUBR X,Y leaves Y = Y - X [Atkinson p.47 pattern "r1' <- r1 + r0"]
  const { cpu } = run(' SUBR X,Y', { setup: (c) => { c.x = 0x0100; c.y = 0x0001; } });
  check('SUBR X,Y result', cpu.y, 0xFF01);
}
// TFM: 6 + 3 per byte, W counts down to 0, and WHICH POINTER MOVES is the whole difference between the
// four forms [Atkinson printed p.136 gives the instruction; the names "TFM r0+, r1" = "Block Write to
// address" (the source advances and the destination address stays put) and "TFM r0, r1+" = "Block Read from
// address" (the destination advances and the source stays put) are in his Programming Aid table, printed
// p.149. Only "TFM r0-, r1-" moves either pointer down, and only "TFM r0+, r1+" moves both up. The reference
// guide's prose on its Page 6 garbles these two ("TFM r0,r1+ - Read from R0 into R1, only incrementing R0"),
// contradicting its own earlier line "R1 stays the same"; Atkinson's names and his opcode map (printed p.152:
// 3A "TFM r+,r", 3B "TFM r,r+") agree with each other and with MAME.].
//
// The bytes come from FCB, not from a mnemonic: the assembler's own TFM encoder is fixed on its own branch,
// and a core test must not be able to pass because an encoder bug sent a different opcode.
// Both test windows are filled with recognisable bytes so an address that is written twice, or not at all,
// shows up in the result: $1FF0..$200F counts up from $A0, so a read one byte either side of the source is a
// different value, and the source at $2000 is $B0..$B3; the destination window $2FF0..$300F is all $EE.
const TFM_SRC = 0x2000, TFM_DST = 0x3000;
function tfmRun(op) {
  const a = run(` FCB $11,$${op.toString(16).toUpperCase()},$12`, {       // postbyte $12: source X (1), destination Y (2)
    steps: 1,
    setup: (c, m) => {
      c.w = 4; c.x = TFM_SRC; c.y = TFM_DST;
      for (let i = 0; i < 0x20; i++) { m[0x1FF0 + i] = (0xA0 + i) & 0xFF; m[0x2FF0 + i] = 0xEE; }
    },
  });
  const win = [];
  for (let i = 0x2FF8; i <= 0x3007; i++) win.push(a.mem[i].toString(16).toUpperCase().padStart(2, '0'));
  return { cpu: a.cpu, cycles: a.cycles, dst: win.join(' ') };
}
// $2FF8..$3007 with only the named destination bytes written, the rest left at $EE
const tfmWin = (map) => {
  const cells = new Array(16).fill('EE');
  for (const [addr, v] of Object.entries(map)) cells[addr - 0x2FF8] = v;
  return cells.join(' ');
};
{
  // $1138 TFM X+,Y+: block move, both pointers up [Atkinson p.136]. Source $2000.. is $B0..$B3.
  const t = tfmRun(0x38);
  check('TFM X+,Y+ destination', t.dst, tfmWin({ 0x3000: 'B0', 0x3001: 'B1', 0x3002: 'B2', 0x3003: 'B3' }));
  check('TFM X+,Y+ X', t.cpu.x, 0x2004);
  check('TFM X+,Y+ Y', t.cpu.y, 0x3004);
  check('TFM W cleared', t.cpu.w, 0);
  check('TFM X+,Y+ cycles (6+3n, n=4)', t.cycles, 18);
}
{
  // $1139 TFM X-,Y-: block move down, both pointers down. Reads $2000,$1FFF,$1FFE,$1FFD ($B0,$AF,$AE,$AD)
  // and writes $3000,$2FFF,$2FFE,$2FFD [Atkinson p.136].
  const t = tfmRun(0x39);
  check('TFM X-,Y- destination', t.dst, tfmWin({ 0x2FFD: 'AD', 0x2FFE: 'AE', 0x2FFF: 'AF', 0x3000: 'B0' }));
  check('TFM X-,Y- X', t.cpu.x, 0x1FFC);
  check('TFM X-,Y- Y', t.cpu.y, 0x2FFC);
  check('TFM X-,Y- cycles (6+3n, n=4)', t.cycles, 18);
}
{
  // $113A TFM X+,Y: "Block Write to address" -- the source advances, the DESTINATION STAYS PUT, so all four
  // bytes land on $3000 and the last one read ($B3) is what stays there; the neighbours are untouched
  // [Atkinson p.136].
  const t = tfmRun(0x3A);
  check('TFM X+,Y destination', t.dst, tfmWin({ 0x3000: 'B3' }));
  check('TFM X+,Y X advanced', t.cpu.x, 0x2004);
  check('TFM X+,Y Y fixed', t.cpu.y, 0x3000);
  check('TFM X+,Y cycles (6+3n, n=4)', t.cycles, 18);
}
{
  // $113B TFM X,Y+: "Block Read from address" -- the SOURCE STAYS PUT, so the same byte ($B0) is read four
  // times and the destination fills with it; reading $1FFF ($AF) instead would need the source to have
  // moved [Atkinson p.136].
  const t = tfmRun(0x3B);
  check('TFM X,Y+ destination', t.dst, tfmWin({ 0x3000: 'B0', 0x3001: 'B0', 0x3002: 'B0', 0x3003: 'B0' }));
  check('TFM X,Y+ X fixed', t.cpu.x, 0x2000);
  check('TFM X,Y+ Y advanced', t.cpu.y, 0x3004);
  check('TFM X,Y+ cycles (6+3n, n=4)', t.cycles, 18);
}


// ---------------------------------------------------------------------------------------------
// 6. LDMD / BITMD and the MD register [G pp.2,7]
// ---------------------------------------------------------------------------------------------
{
  const { cpu } = run(' LDMD #$01');
  check('LDMD native', cpu.md & 1, 1);
}
{
  const { cpu } = run(' LDMD #$FF');
  check('LDMD writes only bits 0-1', cpu.md, 0x03);
}
{
  // bits 2-7 of MD keep their value: the trap flags must survive an LDMD [Atkinson p.144 "Bits 2 through
  // 7 of the MD register are not affected by this instruction, so it cannot be used to alter the /0 and
  // IL status bits."]
  const { cpu } = run(' LDMD #$00', { setup: (c) => { c.md = 0xC2; } });
  check('LDMD preserves the trap flags', cpu.md, 0xC0);
}
{
  // BITMD is a plain 8-bit AND of MD with the immediate (MAME: `set_regop8(m_md); set_imm(); BIT8`)
  const { cpu } = run(' BITMD #$C0', { setup: (c) => { c.md = 0xC0; c.cc = 0x00; } });
  check('BITMD N from bit 7', !!(cpu.cc & F.N), true);
  check('BITMD Z clear on a non-zero result', !!(cpu.cc & F.Z), false);
}
{
  const { cpu } = run(' BITMD #$40', { setup: (c) => { c.md = 0x80; c.cc = 0x00; } });
  check('BITMD Z when the mask matches nothing', !!(cpu.cc & F.Z), true);
}
{
  // BITMD does NOT clear the MD bits it tested. Sources are inconclusive -- Atkinson's prose on printed
  // p.33 says it clears them ("you can only test for each condition once") while his formula on the same
  // line, which is missing the overbar that would make it a clear, says it does not -- and the hardware is
  // unmeasured. Following the standing rule for inconclusive sources, it follows MAME 0.289, measured with
  // tools/mame-diff/6309/sweep.asm: MD=$40 after BITMD #$40 with MD=$40, and MD=$C0 after BITMD #$40 with
  // MD=$C0. The bits accumulate, which is what makes the sweep's trap handler compose both test results.
  const { cpu } = run(' BITMD #$40', { setup: (c) => { c.md = 0xC0; c.cc = 0x00; } });
  check('BITMD leaves the tested MD bits set (sources inconclusive; follows MAME 0.289)', cpu.md, 0xC0);
  // Which is why the trap handler tests one bit at a time and ORs the results: the two tests read the same
  // register, and a bit once set stays set for the next exception.
  const il = run(' BITMD #$40', { setup: (c) => { c.md = 0x40; c.cc = 0x00; } });
  check('BITMD #$40 with IL set: Z clear', !!(il.cpu.cc & F.Z), false);
  const div = run(' BITMD #$80', { setup: (c) => { c.md = 0x40; c.cc = 0x00; } });
  check('BITMD #$80 with only IL set: Z set (not a divide)', !!(div.cpu.cc & F.Z), true);
  const low = run(' BITMD #$C0', { setup: (c) => { c.md = 0x03; c.cc = 0x00; } });
  check('BITMD leaves MD bits 0-5 alone (the mode bits)', low.cpu.md, 0x03);
}

// ---------------------------------------------------------------------------------------------
// 7. Cycle counts, EMULATION mode [G pp.27-30 / S]
// ---------------------------------------------------------------------------------------------
const CYC_EM = [
  ['LDQ #', 'LDQ #$11223344', 5], ['LDQ direct', 'LDQ <$10', 8], ['LDQ indexed', 'LDQ ,X', 8],
  ['LDQ extended', 'LDQ $3000', 9], ['STQ direct', 'STQ <$10', 8], ['STQ extended', 'STQ $3000', 9],
  ['LDW #', 'LDW #$1234', 4], ['STW direct', 'STW <$10', 6], ['LDW direct', 'LDW <$10', 6], ['LDW indexed', 'LDW ,X', 6],
  ['ADDW #', 'ADDW #$0010', 5], ['SUBW #', 'SUBW #$0004', 5], ['CMPW #', 'CMPW #$010C', 5],
  // the AND/OR/EOR family is 5 in emulation, 4 in native [G p.28; S 5/4/4] -- MAME charges 4 in both
  ['ANDD #', 'ANDD #$0F0F', 5], ['ORD #', 'ORD #$F0F0', 5], ['EORD #', 'EORD #$FFFF', 5],
  ['ADCD #', 'ADCD #$0101', 5], ['SBCD #', 'SBCD #$0101', 5], ['BITD #', 'BITD #$0F0F', 5],
  ['ADDW direct', 'ADDW <$10', 7], ['ANDD direct', 'ANDD <$10', 7],
  ['LDE #', 'LDE #$5A', 3], ['LDE direct', 'LDE <$10', 5], ['ADDE #', 'ADDE #$01', 3],
  ['SUBE direct', 'SUBE <$10', 5], ['LDF #', 'LDF #$A5', 3], ['ADDF direct', 'ADDF <$10', 5],
  ['CLRD', 'CLRD', 3], ['CLRW', 'CLRW', 3], ['CLRE', 'CLRE', 3], ['CLRF', 'CLRF', 3],
  ['NEGD', 'NEGD', 3], ['TSTD', 'TSTD', 3], ['TSTW', 'TSTW', 3],
  ['PSHSW', 'PSHSW', 6], ['PULSW', 'PULSW', 6], ['PSHUW', 'PSHUW', 6], ['PULUW', 'PULUW', 6],
  ['ADDR', 'ADDR D,X', 4], ['CMPR', 'CMPR D,X', 4],
  // SEXW is 4 in both modes [G p.27; S 14 4/4/3] -- MAME charges 1
  ['SEXW', 'SEXW', 4],
  ['AIM direct', 'AIM #$0F,<$10', 6], ['AIM indexed', 'AIM #$0F,,X', 7], ['AIM extended', 'AIM #$0F,$2010', 7],
  ['BAND', 'BAND A,0,7,<$10', 7], ['STBT', 'STBT A,7,0,<$10', 8],
  // BITMD is 4 in both modes [G p.29; S 11 4/4/3] -- MAME charges 3
  ['BITMD #', 'BITMD #$C0', 4],
  ['LDMD #', 'LDMD #$00', 5],
  // MULD is 28 in both modes [G p.29; S 11 28/28/17] -- MAME charges 4
  ['MULD #', 'MULD #$0010', 28], ['MULD direct', 'MULD <$10', 30], ['MULD extended', 'MULD $2010', 31],
  ['DIVD #', 'DIVD #$07', 25],
  // DIVQ immediate: the guide's detailed table (p.29) prints 36 and Sock's chart prints 34. Sock's chart
  // is the one Lindner's addendum cites and prints the emulation/native columns explicitly, so 34 is used;
  // the MAME core charges 25 + addressing, which is a third figure and is a known deviation (see below).
  ['DIVQ #', 'DIVQ #$0003', 34],
];
for (const [name, src, want] of CYC_EM) {
  check(`em cycles ${name}`, cyclesOf(src, false, (c) => { c.q = 0x10; c.x = 0x2010; }), want);
}
// The new math's indexed forms are written "30+", "27+", "36+" [Atkinson pp.101, 59, 60; guide 11AF, 11AD,
// 11AE]: the base figure plus the indexed post byte's own cost. The base figure was being assigned after the
// post byte had been decoded, which wiped its cost, so every indexed form came out at the ,X figure. These
// check the post byte is added -- the delta between forms, which is what the "+" states -- in both modes.
// The post byte costs are the guide's table (p.11) and Lindner's A-12a..d: ,R+ 2/1 and n,R 1/1.
{
  const ix = (src, nm) => cyclesOf(src, nm, (c, mem) => {
    c.d = 0x64; c.q = 0x100; c.x = 0x2000;
    // a divisor at ,X and at 2,X: zero would divide by zero and trap instead
    mem[0x2000] = 0x07; mem[0x2001] = 0x00; mem[0x2002] = 0x07; mem[0x2003] = 0x00;
  });
  for (const [name, src, atX] of [
    // [mnemonic, sample instruction, the ,X figure: 30/27/36 in emulation [A pp.101, 59, 60]]
    ['MULD', 'MULD ,X', 30], ['DIVD', 'DIVD ,X', 27], ['DIVQ', 'DIVQ ,X', 36],
  ]) {
    check(`${name} indexed ,X em`, ix(src, false), atX);
    const plus = src.replace(',X', ',X+'), off = src.replace(',X', '2,X');
    check(`${name} ,X+ adds the 2-cycle post byte (em)`, ix(plus, false) - ix(src, false), 2);
    check(`${name} ,X+ adds the 1-cycle post byte (native)`, ix(plus, true) - ix(src, true), 1);
    check(`${name} n,X adds the 1-cycle post byte (em)`, ix(off, false) - ix(src, false), 1);
    check(`${name} n,X adds the 1-cycle post byte (native)`, ix(off, true) - ix(src, true), 1);
    // the base figure itself must not change with the form (the old bug reported the base for every form)
    check(`${name} ,X+ is not the ,X figure`, ix(plus, false) !== ix(src, false), true);
  }
}
// DIVD adds a cycle for each negative operand and takes one back on two's-complement overflow, and a
// range overflow leaves the accumulators unmodified with V set and 13 fewer cycles [Atkinson p.59]
{
  check('DIVD negative dividend', cyclesOf('DIVD #$07', false, (c) => { c.d = (-100) & 0xFFFF; }), 26);
  check('DIVD negative divisor', cyclesOf('DIVD #$FF', false, (c) => { c.d = 100; }), 26);
  check('DIVD negative both', cyclesOf('DIVD #$FF', false, (c) => { c.d = (-100) & 0xFFFF; }), 27);
  check('DIVD range overflow cycles', cyclesOf('DIVD #$03', false, (c) => { c.d = 900; }), 25 - 13);
  const { cpu, mem } = run(' DIVD #$03', { setup: (c) => { c.d = 900; } });
  check('DIVD range overflow leaves D', cpu.d, 900);
  check('DIVD range overflow sets V', !!(cpu.cc & F.V), true);
  check('DIVD range overflow clears N,Z,C', cpu.cc & (F.N | F.Z | F.C), 0);
}
// DIVQ: quotient in W, remainder in D; range overflow 21 fewer cycles [Atkinson p.60]
{
  check('DIVQ immediate cycles', cyclesOf('DIVQ #$0003', false, (c) => { c.q = 0x100; }), 34);
  const { cpu } = run(' DIVQ #$0003', { setup: (c) => { c.q = 0x100; } });
  check('DIVQ quotient in W', cpu.w, 0x100 / 3 | 0);
  check('DIVQ remainder in D', cpu.d, 0x100 % 3);
  check('DIVQ range overflow cycles', cyclesOf('DIVQ #$0003', false, (c) => { c.q = 210000; }), 34 - 21);
  const o = run(' DIVQ #$0003', { setup: (c) => { c.q = 210000; } });
  check('DIVQ range overflow leaves Q', o.cpu.q, 210000);
}

// ---------------------------------------------------------------------------------------------
// 8. Cycle counts, NATIVE mode [G pp.27-30 / S]
// Each row: instruction, native count, emulation count.
// ---------------------------------------------------------------------------------------------
const CYC_NM = [
  ['NOP', 'NOP', 1, 2], ['LDA #', 'LDA #$01', 2, 2], ['LDD #', 'LDD #$0001', 3, 3],
  ['ADDD #', 'ADDD #$0001', 3, 4], ['SUBD #', 'SUBD #$0001', 3, 4], ['CMPX #', 'CMPX #$0001', 3, 4],
  ['LDA direct', 'LDA <$10', 3, 4], ['STA direct', 'STA <$10', 3, 4],
  ['STA extended', 'STA $2010', 4, 5], ['NEG direct', 'NEG <$10', 5, 6],
  ['LBRA', 'LBRA 0', 4, 5],
  ['LDQ #', 'LDQ #$11223344', 5, 5], ['LDQ direct', 'LDQ <$10', 7, 8], ['LDQ extended', 'LDQ $3000', 8, 9],
  ['STQ direct', 'STQ <$10', 7, 8],
  ['LDW #', 'LDW #$1234', 4, 4], ['STW direct', 'STW <$10', 5, 6],
  ['ADDW #', 'ADDW #$0010', 4, 5], ['SUBW #', 'SUBW #$0004', 4, 5], ['CMPW #', 'CMPW #$010C', 4, 5],
  ['ANDD #', 'ANDD #$0F0F', 4, 5], ['ORD #', 'ORD #$F0F0', 4, 5], ['EORD #', 'EORD #$FFFF', 4, 5],
  ['NEGD', 'NEGD', 2, 3], ['CLRW', 'CLRW', 2, 3], ['CLRE', 'CLRE', 2, 3],
  ['LDE #', 'LDE #$5A', 3, 3], ['LDE direct', 'LDE <$10', 4, 5],
  ['AIM direct', 'AIM #$0F,<$10', 6, 6], ['BAND', 'BAND A,0,7,<$10', 6, 7],
  ['SEXW', 'SEXW', 4, 4], ['BITMD #', 'BITMD #$C0', 4, 4], ['LDMD #', 'LDMD #$00', 5, 5],
  ['MULD #', 'MULD #$0010', 28, 28],
  ['TFR', 'TFR D,X', 4, 6], ['EXG', 'EXG D,X', 5, 8],
  // The ordinary 6809 instructions, whose native savings a wrong NATIVE_SAVE entry would change without any
  // earlier row failing: RTS and JSR were the reviewer's example. Figures are Atkinson's own instruction table
  // ("5/4" is emulation/native there, so the native column is the second number).
  ['RTS', 'RTS', 4, 5],                                  // 39 5/4
  ['JSR direct', 'JSR <$10', 6, 7],                      // AD 7/6
  ['JSR extended', 'JSR $2010', 7, 8],                   // BD 8/7
  ['JSR indexed', 'JSR ,X', 6, 7],                       // AD 7+/6+
  ['PSHS', 'PSHS A', 5, 6],                              // 34 5/4 + one per byte pushed
  ['PULS', 'PULS A', 5, 6],                              // 35 5/4 + one per byte
  ['SWI', 'SWI', 21, 19],                                // 3F 19/21: native is LONGER, it stacks E and F
  ['SWI2', 'SWI2', 22, 20],                              // 103F 20/22
  ['SWI3', 'SWI3', 22, 20],                              // 113F 20/22
  ['MUL', 'MUL', 10, 11],                                // 3D 11/10
];
for (const [name, src, wantNm, wantEm] of CYC_NM) {
  check(`native cycles ${name}`, cyclesOf(src, true, (c) => { c.d = 0x10; c.x = 0x2010; }), wantNm);
  check(`em cycles ${name}`, cyclesOf(src, false, (c) => { c.d = 0x10; c.x = 0x2010; }), wantEm);
}

// ---------------------------------------------------------------------------------------------
// 8a. Indexed post bytes: every form's cost, emulation and native [Lindner A-12a..d]
// The rows are the X family; the Y, U and S forms carry the same numbers. Each entry is the cycles the
// addressing mode adds beyond the instruction's own (LDA ,X is 4, so A6 84 with X=0 and a 1-cycle post byte
// costs 5). The test runs `LDA <form>` and subtracts the 4-cycle base.
// ---------------------------------------------------------------------------------------------
{
  // [post byte, emulation cost, native cost]
  const POST = [
    [0x84, 0, 0],   // ,X
    [0x80, 2, 1],   // ,X+
    [0x81, 3, 2],   // ,X++
    [0x82, 2, 1],   // ,-X
    [0x83, 3, 2],   // ,--X
    [0x85, 1, 1],   // B,X
    [0x86, 1, 1],   // A,X
    [0x87, 1, 1],   // E,X
    [0x8A, 1, 1],   // F,X
    [0x88, 1, 1],   // nn,X
    [0x89, 4, 3],   // mmnn,X
    [0x8B, 4, 2],   // D,X
    [0x8C, 1, 1],   // nn,PC
    [0x8D, 5, 3],   // mmnn,PC
    [0x8E, 4, 1],   // W,X
    [0x8F, 0, 0],   // ,W
    [0xAF, 5, 2],   // nn,W
    [0xCF, 3, 1],   // ,W++
    [0xEF, 3, 1],   // ,--W
    [0x94, 3, 3],   // [,X]
    [0x91, 6, 5],   // [,X++]
    [0x93, 6, 5],   // [,--X]
    [0x95, 4, 4],   // [B,X]
    [0x96, 4, 4],   // [A,X]
    [0x97, 4, 4],   // [E,X]
    [0x9A, 4, 4],   // [F,X]
    [0x98, 4, 4],   // [nn,X]
    [0x99, 7, 7],   // [mmnn,X]
    [0x9B, 7, 5],   // [D,X]
    [0x9C, 4, 4],   // [nn,PC]
    [0x9D, 8, 6],   // [mmnn,PC]
    [0x9E, 7, 4],   // [W,X]
    [0x90, 3, 3],   // [,W]
    [0xB0, 5, 5],   // [nn,W]
    [0xD0, 4, 4],   // [,W++]
    [0xF0, 4, 4],   // [,--W]
  ];
  const pmem = new Uint8Array(0x10000);
  for (const [pb, em, nm] of POST) {
    const bytes = [0xA6, pb, 0x10, 0x20];
    const t = (native) => {
      pmem.fill(0x12); pmem.set(bytes, 0x1000); pmem[0xFFFE] = 0x10; pmem[0xFFFF] = 0;
      const cpu = new CPU6309({ read: (a) => pmem[a], write: (a, v) => { pmem[a] = v; } });
      cpu.reset(); cpu.s = 0x8000; cpu.u = 0x7000; cpu.x = 0x2000; cpu.y = 0x2100; cpu.dp = 0; cpu.cc = 0x10;
      cpu.d = 0x10; cpu.e = 2; cpu.f = 3; cpu.w = 0x2000;
      if (native) cpu.md |= 1;
      cpu.c = 0; return cpu.step();
    };
    check(`post byte ${hex(pb)} emulation`, t(false) - 4, em);
    check(`post byte ${hex(pb)} native`, t(true) - 4, nm);
  }
}

// ---------------------------------------------------------------------------------------------
// 8b. Native-mode RTI restores the E and F frame [guide p. 2; Atkinson "RTI 3B 15/17"]
// ---------------------------------------------------------------------------------------------
{
  const r = Emu.assemble(' ORG $1000\n RTI\n BRA *\n END', '6309');
  const rmem = new Uint8Array(0x10000);
  rmem.fill(0x12); rmem.set(r.segments[0].data, 0x1000); rmem[0xFFFE] = 0x10; rmem[0xFFFF] = 0;
  const cpu = new CPU6309({ read: (a) => rmem[a], write: (a, v) => { rmem[a] = v; } });
  cpu.reset(); cpu.md |= 1; cpu.cc = 0x90;          // native, CC.E set: an entire-state frame
  cpu.a = 0x11; cpu.b = 0x22; cpu.e = 0x33; cpu.f = 0x44; cpu.dp = 0x55;
  cpu.x = 0x6666; cpu.y = 0x7777; cpu.u = 0x8888; cpu.pc = 0x1234;
  cpu.pushAll();
  cpu.a = cpu.b = cpu.e = cpu.f = cpu.dp = 0; cpu.x = cpu.y = cpu.u = 0;
  cpu.pc = 0x1000; cpu.cc = 0x50; cpu.md |= 1;
  const n = cpu.step();
  check('native RTI cycles', n, 17);
  check('native RTI restores A', cpu.a, 0x11);
  check('native RTI restores E', cpu.e, 0x33);
  check('native RTI restores F', cpu.f, 0x44);
  check('native RTI restores X', cpu.x, 0x6666);
  check('native RTI restores PC', cpu.pc, 0x1234);
}

// ---------------------------------------------------------------------------------------------
// 8c. Decode fixes: SWI3 is not MULD, ST immediate forms are illegal, LDMD and CWAI have their counts
// ---------------------------------------------------------------------------------------------
{
  // SWI3 (0x113F) must vector through $FFF2, not run as the F bank's MULD
  const r = Emu.assemble(' ORG $1000\n SWI3\n BRA *\n END', '6309');
  const m = new Uint8Array(0x10000);
  m.fill(0x12); m.set(r.segments[0].data, 0x1000);
  m[0xFFF2] = 0x22; m[0xFFF3] = 0x00; m[0xFFFE] = 0x10; m[0xFFFF] = 0x00;
  const cpu = new CPU6309({ read: (a) => m[a], write: (a, v) => { m[a] = v; } });
  cpu.reset(); cpu.s = 0x8000; cpu.cc = 0x10;
  const n = cpu.step();
  check('SWI3 vectors through $FFF2', cpu.pc, 0x2200);
  check('SWI3 cycles', n, 20);
}
{
  // CWAI is 22 cycles in emulation mode on a 6309 and 20 in native [Atkinson p. 1470; Sock "3C 22/20"]
  check('CWAI emulation cycles', cyclesOf('CWAI #$00', false), 22);
  check('CWAI native cycles', cyclesOf('CWAI #$00', true), 20);
}

// A bare CPU test has no machine to map ROM, so this places the trap vector in memory and starts at the
// test code directly. The handler records that it ran in A and stops.
// ---------------------------------------------------------------------------------------------
{
  const r = Emu.assemble(` ORG $1000
 LDD #$0010
 DIVD #$00
 NOP
 BRA *
 ORG $1200
TRAP LDA #$EE
 BRA *
 END`, '6309');
  if (!r.ok) throw new Error(r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const mem = new Uint8Array(0x10000);
  for (const s of r.segments) mem.set(s.data, s.addr);
  const trap = r.symbols.get('TRAP');
  mem[0xFFF0] = trap >> 8; mem[0xFFF1] = trap & 0xFF;
  const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
  cpu.reset(); cpu.s = 0x8000; cpu.cc = 0x10; cpu.pc = 0x1000;
  for (let i = 0; i < 10 && cpu.a !== 0xEE; i++) cpu.step();
  check('div0 sets MD bit 7', cpu.md & 0x80, 0x80);
  check('div0 reaches the handler', cpu.a, 0xEE);
  check('div0 stacks in emulation mode', cpu.s, 0x8000 - 12);
}
// the trap itself costs cycles: the stack push and the vector fetch, like any interrupt. The divide does
// its internal cycles, then the trap behaves as a software interrupt [Atkinson p.59 describes the sequence:
// set MD bit 7, stack the machine state, jump to $FFF0].
{
  const r = Emu.assemble(` ORG $1000
 LDX #$2200
 DIVD #$00
 BRA *
 END`, '6309');
  const mem = new Uint8Array(0x10000);
  for (const s of r.segments) mem.set(s.data, s.addr);
  mem[0xFFF0] = 0x22; mem[0xFFF1] = 0x00;              // trap target: a byte of 0 = an undefined opcode, enough
  const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
  cpu.reset(); cpu.s = 0x8000; cpu.pc = 0x1000;
  cpu.step();                                            // LDX
  const n = cpu.step();                                  // DIVD #0, which traps
  // Exactly, not "more than": a mutant that changed the 19-cycle interrupt sequence kept "> 25" true while
  // breaking the lockstep. DIVD is 28 cycles in emulation mode here, then the trap's 19 for the stack push
  // and the vector fetch [trap() in js/cpu/cpu6309.js], and a divide already charging its own internal time
  // does not add the same 19 again (the log is padded to the final count, not summed twice).
  check('div0 total cycles are the divide plus the interrupt sequence', n, 28 + 16);
  check('div0 reached the vector', cpu.pc, 0x2200);
}

// CMPW is SUBW without the store: N, Z, V and C come from the subtraction [Atkinson's CMP page: the
// comparison is a subtraction that is not stored]. No test pinned them, so a mutant that dropped any one
// passed. Each case is a boundary where that flag differs from its default.
{
  const cmp = (w) => run(' CMPW #$010C', { setup: (c) => { c.w = w; }, steps: 1 }).cpu;
  const eq = cmp(0x010C);
  check('CMPW Z set when equal', !!(eq.cc & F.Z), true);
  check('CMPW C clear when equal', !!(eq.cc & F.C), false);
  check('CMPW N clear when equal', !!(eq.cc & F.N), false);
  const lt = cmp(0x010B);                                // $010B - $010C borrows
  check('CMPW C set when the minuend is smaller', !!(lt.cc & F.C), true);
  check('CMPW N set when the result is negative', !!(lt.cc & F.N), true);
  const gt = cmp(0x0200);
  check('CMPW C clear when the minuend is larger', !!(gt.cc & F.C), false);
  check('CMPW N clear when the result is positive', !!(gt.cc & F.N), false);
  const ovf = cmp(0x7FFF);                              // $7FFF - $010C does not overflow, but $8001 - $010C does
  check('CMPW V clear when no signed overflow', !!(ovf.cc & F.V), false);
  const ovfPos = cmp(0x8001);   // $8001 - $010C = $7CF5: positive minus positive, result negative -> V
  check('CMPW V reflects a signed overflow when there is one', (ovfPos.cc & F.V) !== 0, true);
  // CMPW is a comparison: it sets the flags from the subtraction but does not store it, so W must come out of
  // every case above exactly as it went in. SUBW runs the same code path WITH the store, so a mutant that
  // turned CMPW into SUBW would leave every flag check above passing.
  for (const w of [0x010C, 0x010B, 0x0200, 0x7FFF, 0x8001, 0x0000]) {
    check('CMPW leaves W unchanged (' + w.toString(16) + ')', cmp(w).w, w);
  }
}

// ---------------------------------------------------------------------------------------------
// 9a. The illegal-instruction trap [Atkinson p. 59; guide p. 7]
// An undefined opcode sets MD bit 6 and vectors through $FFF0. Every opcode MAME's hd6309.lst has no case for
// must trap; every opcode it does have must not. The legal sets are transcribed from that dispatch table (the
// same opcodes as Atkinson's and the Hitachi data book's tables).
// ---------------------------------------------------------------------------------------------
{
  const trapFor = (bytes) => {
    const m = new Uint8Array(0x10000);
    m.fill(0x12); m.set(bytes, 0x1000); m[0xFFFE] = 0x10; m[0xFFFF] = 0;
    for (const v of [0xFFF0, 0xFFF2, 0xFFF4, 0xFFF6, 0xFFF8, 0xFFFA, 0xFFFC]) { m[v] = 0x30; m[v + 1] = 0x00; }
    m[0x3000] = 0x12;
    const cpu = new CPU6309({ read: (a) => m[a], write: (a, v) => { m[a] = v; } });
    cpu.reset(); cpu.s = 0x8000; cpu.u = 0x7000; cpu.x = 0x2000; cpu.dp = 0; cpu.cc = 0x10;
    cpu.d = 0x10; cpu.w = 4; cpu.q = 0x10;
    const n = cpu.step();
    return { trapped: !!(cpu.md & 0x40), pc: cpu.pc, cycles: n };
  };
  // a sample of opcodes with no instruction on the 6309: page 1, page 2 and page 3
  for (const [name, bytes] of [['page 1 $41', [0x41, 0x00, 0x10]], ['page 1 $87', [0x87, 0x00, 0x10]],
    ['page 1 $CF', [0xCF, 0x00, 0x10]], ['page 2 $20', [0x10, 0x20, 0x00, 0x10]], ['page 2 $41', [0x10, 0x41, 0x00, 0x10]],
    ['page 3 $40', [0x11, 0x40, 0x00, 0x10]], ['page 3 $84', [0x11, 0x84, 0x00, 0x10]]]) {
    const r = trapFor(bytes);
    check(`illegal ${name} traps`, r.trapped, true);
    check(`illegal ${name} vectors through $FFF0`, r.pc, 0x3000);
  }
  // and a few legal opcodes must not trap
  for (const [name, bytes] of [['NOP', [0x12, 0x12]], ['SWI3', [0x11, 0x3F, 0x12]], ['SEXW', [0x14, 0x12]],
    ['LDQ #', [0xCD, 0x11, 0x22, 0x33, 0x44]], ['OIM direct', [0x01, 0x0F, 0x10]], ['LDMD', [0x11, 0x3D, 0x00]]]) {
    check(`legal ${name} does not trap`, trapFor(bytes).trapped, false);
  }
}

// ---------------------------------------------------------------------------------------------
// 10. Snapshots carry the new registers
// ---------------------------------------------------------------------------------------------
{
  const { cpu } = run(' LDW #$ABCD\n TFR D,V\n LDMD #$01');
  const json = JSON.parse(JSON.stringify(cpu.saveState()));
  const c2 = new CPU6309({ read: () => 0, write: () => {} });
  c2.loadState(json);
  check('snapshot W', c2.w, cpu.w);
  check('snapshot V', c2.v, cpu.v);
  check('snapshot MD', c2.md, cpu.md);
  check('snapshot E', c2.e, cpu.e);
  check('snapshot F', c2.f, cpu.f);
}

// ---------------------------------------------------------------------------------------------
// 12. mameCompat: MAME 0.289's cycles and flags, off by default (the product default is the hardware)
// The table is measured from tools/mame-diff/6309/sweep.asm on local MAME 0.289 (MAME_DELTA in
// js/cpu/cpu6309.js); these checks pin the behaviour those measurements established, so the compat path
// is tested in Node as well as by the lockstep.
// ---------------------------------------------------------------------------------------------
{
  const mc = (src, native = false, setup) => cyclesOf(src, native, setup, true);
  const hw = (src, native = false, setup) => cyclesOf(src, native, setup, false);
  // seed memory too: an uninitialised divisor is zero, which traps instead of dividing
  const set = (c, mem) => { c.d = 0x64; c.q = 0x100; c.x = 0x2000; if (mem) { mem[0x10] = 0x07; mem[0x11] = 0; mem[0x2010] = 0x07; mem[0x2011] = 0; } };

  // [name, instruction, the cycles MAME 0.289 charges, the hardware figure our default keeps]
  const CASES = [
    ['MULD #', 'MULD #$0010', 4, 28],
    ['MULD direct', 'MULD <$10', 6, 30],
    ['MULD extended', 'MULD $2010', 7, 31],
    ['SEXW', 'SEXW', 1, 4],
    ['BITMD', 'BITMD #$C0', 3, 4],
    ['LDMD', 'LDMD #$00', 3, 5],
    ['ANDD #', 'ANDD #$0F0F', 4, 5],
    ['ANDD direct', 'ANDD <$10', 6, 7],
    ['EORD #', 'EORD #$FFFF', 4, 5],
    ['ORD extended', 'ORD $2010', 7, 8],
    ['ADDR', 'ADDR D,X', 5, 4],
    ['SUBR', 'SUBR D,X', 5, 4],
    ['CMPR', 'CMPR D,X', 5, 4],
    ['AIM direct', 'AIM #$0F,<$10', 7, 6],
    ['AIM extended', 'AIM #$0F,$2010', 8, 7],
    ['PULSW', 'PULSW', 7, 6],
    ['PULUW', 'PULUW', 7, 6],
    ['BAND', 'BAND A,0,7,<$10', 10, 7],
    ['LDBT', 'LDBT A,6,1,<$10', 10, 7],
    ['STBT', 'STBT A,7,0,<$10', 9, 8],
    ['DIVD #', 'DIVD #$07', 28, 25],
    ['DIVD direct', 'DIVD <$10', 30, 27],
    ['DIVQ #', 'DIVQ #$0003', 29, 34],
    ['DIVQ direct', 'DIVQ <$10', 31, 36],
  ];
  for (const [name, src, wantMame, wantHw] of CASES) {
    check('mameCompat cycles ' + name, mc(src, false, set), wantMame);
    check('hardware cycles ' + name + ' (unchanged)', hw(src, false, set), wantHw);
  }
  // native mode: the same table, and the hardware default still applies when compat is off
  check('mameCompat MULD # native', mc('MULD #$0010', true, set), 4);
  check('mameCompat DIVQ # native', mc('DIVQ #$0003', true, set), 28);
  check('mameCompat ANDCC native', mc('ANDCC #$FE', true), 2);
  check('hardware ANDCC native', hw('ANDCC #$FE', true), 3);

  // the bus log still matches the count in compat mode (the machines walk it cycle by cycle)
  {
    const { cpu } = run(' MULD #$0010', { setup: set, steps: 1, mameCompat: true });
    check('mameCompat MULD bus log matches its count', cpu.cycleCount, cpu.c);
    check('mameCompat MULD drops the internal cycles', cpu.c, 4);
  }

  // flag rules: the ones MAME gets wrong (reproduced only in compat mode), and the ones it shares with
  // the hardware (which must behave the same in both modes, so a stray compat branch cannot hide here)
  const flagsOf = (src, cc, setup, compat) => {
    const { cpu } = run(src, { setup: (c) => { c.cc = cc; setup(c); }, steps: 1, mameCompat: compat });
    return cpu.cc;
  };
  // DECW: MAME sets C from the borrow, the hardware leaves C alone [Atkinson p.130]
  // MAME's DEC16 sets C from the subtraction's own carry (w=0 borrows, so both leave C set here)
  check('mameCompat DECW sets C when 0 borrows', flagsOf(' DECW', 0x00, (c) => { c.w = 0; }, true) & F.C, F.C);
  check('hardware DECW leaves C on a borrow', flagsOf(' DECW', 0x01, (c) => { c.w = 0; }, false) & F.C, F.C);
  check('mameCompat DECW clears C on no borrow', flagsOf(' DECW', 0x00, (c) => { c.w = 1; }, true) & F.C, 0);
  check('hardware DECW leaves C clear on no borrow', flagsOf(' DECW', 0x00, (c) => { c.w = 1; }, false) & F.C, 0);
  // INCW: the same, from the carry
  // and INC16 sets C when the word wraps (0xFFFF + 1 carries)
  check('mameCompat INCW sets C when  carries', flagsOf(' INCW', 0x00, (c) => { c.w = 0xFFFF; }, true) & F.C, F.C);
  check('hardware INCW leaves C', flagsOf(' INCW', 0x01, (c) => { c.w = 0xFFFF; }, false) & F.C, F.C);
  // LSRW: agreement -- MAME's LSR16 sets C from bit 0 [base6x09.lst], as the hardware does, so the
  // commpat path has no branch here and both modes must set it
  check('mameCompat LSRW sets C from bit 0', flagsOf(' LSRW', 0x00, (c) => { c.w = 1; }, true) & F.C, F.C);
  check('hardware LSRW sets C from bit 0', flagsOf(' LSRW', 0x00, (c) => { c.w = 1; }, false) & F.C, F.C);
  // TSTW: agreement too -- V is cleared in both. Atkinson's aid prints V as "0" for TSTD/TSTW, and
  // MAME's set_flags(mask, r) is set_flags(mask, 0, r, r), whose V term (0 ^ r ^ r ^ (r >> 1)) & 0x8000
  // is (r >> 1) & 0x8000, which a shift can never set. So V is preset here, or the check proves nothing.
  check('mameCompat TSTW clears V', flagsOf(' TSTW', 0x02, (c) => { c.w = 0xFFFF; }, true) & F.V, 0);
  check('hardware TSTW clears V', flagsOf(' TSTW', 0x02, (c) => { c.w = 0xFFFF; }, false) & F.V, 0);
  check('mameCompat TSTW clears V on a zero word', flagsOf(' TSTW', 0x02, (c) => { c.w = 0; }, true) & F.V, 0);
  // ROLW: the hardware sets V from bits 14^15, MAME's expression is always zero
  check('mameCompat ROLW leaves V', flagsOf(' ROLW', 0x00, (c) => { c.w = 0x8000; }, true) & F.V, 0);
  check('hardware ROLW sets V', flagsOf(' ROLW', 0x00, (c) => { c.w = 0x8000; }, false) & F.V, F.V);
  // LDMD: the hardware keeps MD bits 2-7 and changes no flags; MAME replaces the byte and sets N/Z/V
  {
    const { cpu } = run(' LDMD #$00', { setup: (c) => { c.md = 0xC1; c.cc = 0x58; }, steps: 1, mameCompat: true });
    check('mameCompat LDMD replaces MD', cpu.md, 0x00);
    check('mameCompat LDMD sets Z from the byte', cpu.cc & F.Z, F.Z);
    const { cpu: h } = run(' LDMD #$00', { setup: (c) => { c.md = 0xC1; c.cc = 0x58; }, steps: 1, mameCompat: false });
    check('hardware LDMD keeps MD bits 2-7', h.md, 0xC0);
    check('hardware LDMD changes no flags', h.cc, 0x58);
  }
  // The illegal-instruction trap leaves I and F alone, in both modes: no source states the hardware's
  // behaviour, so the default follows MAME's SOFTWARE_INTERRUPT (AGENTS 4.6). Run from both starting
  // states, so "leaves them alone" cannot pass by being a clear-everything or a set-everything trap.
  for (const compat of [false, true]) {
    const label = compat ? 'mameCompat' : 'default';
    const set = run(' FCB $41', { setup: (c) => { c.cc = F.I | F.F; }, steps: 1, mameCompat: compat }).cpu;
    check(`${label} trap leaves I/F set`, set.cc & (F.I | F.F), F.I | F.F);
    const clear = run(' FCB $41', { setup: (c) => { c.cc = 0; }, steps: 1, mameCompat: compat }).cpu;
    check(`${label} trap leaves I/F clear`, clear.cc & (F.I | F.F), 0);
    check(`${label} trap still sets E`, set.cc & F.E, F.E);          // the whole state was stacked
    check(`${label} trap still sets the MD bit`, set.md & 0x40, 0x40); // the illegal-instruction bit
  }
}

// ---------------------------------------------------------------------------------------------
// 13. Interrupt frames: IRQ, FIRQ, FIRQ-as-IRQ, CWAI and SYNC in both modes
// The sweep (tools/mame-diff/6309) runs the same cases in MAME and here, on all four HD6309 machines; these
// pin the frame shapes and the two cycle rules the sweep's measurements established, so a regression shows
// up in Node. Emulation mode stacks CC A B DP X Y U PC (8 bytes); native mode adds E and F (10 bytes); a
// plain FIRQ stacks only CC and PC; FIRQ-as-IRQ (MD bit 1) stacks the whole state.
// ---------------------------------------------------------------------------------------------
{
  // a CPU at $1000 with an IRQ vector at $3000 (an RTS) and a known stack
  const irqCpu = ({ native = false, compat = true, md = 0 } = {}) => {
    const a = asm(` ORG $1000\n LDS #$8000\n ORCC #$EF\n BRA *\n END`);
    const mem = new Uint8Array(0x10000);
    mem.set(a.bytes, a.addr);
    mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
    const put = (addr, v) => { mem[addr] = v; };
    put(0xFFF8, 0x30); put(0xFFF9, 0x00);   // IRQ vector -> $3000
    put(0xFFF6, 0x31); put(0xFFF7, 0x00);   // FIRQ vector -> $3100
    put(0x3000, 0x39); put(0x3100, 0x39);   // RTS at each
    const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
    cpu.reset();
    if (native) cpu.md |= 1;
    if (md) { cpu.md = md; if (!(md & 1)) cpu.md |= native ? 1 : 0; }
    cpu.mameCompat = compat;
    cpu.s = 0x8000; cpu.cc &= ~0xF0;        // I and F clear, so the interrupt is taken
    // take the "LDS #$8000" out of the way: start just after it
    cpu.pc = 0x1000;
    return { cpu, mem };
  };
  for (const native of [false, true]) {
    const mode = native ? 'native' : 'emulation';
    // The stack the interrupt consumes is the difference between S before and after the whole-state frame.
    const frame = (md) => {
      const { cpu } = irqCpu({ native, md });
      cpu.irqLine = true;
      let steps = 0;
      while (steps < 10 && cpu.pc !== 0x3000) { cpu.step(); steps++; }
      return { depth: 0x8000 - cpu.s, pc: cpu.pc, cc: cpu.cc };
    };
    const irq = frame(0);
    check(`IRQ ${mode}: vectors to $FFF8`, irq.pc, 0x3000);
    // whole state: CC A B [E F] DP X Y U PC = 12 bytes emulation, 14 native (E and F are the two extras)
    check(`IRQ ${mode}: stacks ${native ? 14 : 12} bytes`, irq.depth, native ? 14 : 12);
    // CWAI under mameCompat charges MAME's 16 for the instruction, not the 6309's 22 (MAME_DELTA has no entry
    // for it, because the difference is internal cycles the log does not hold; cwai6309() handles it).
    const cwaiCost = (compat) => {
      const a = asm(' ORG $1000\n CWAI #$EF\n BRA *\n END');
      const mem = new Uint8Array(0x10000); mem.set(a.bytes, a.addr);
      mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
      const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
      cpu.reset(); cpu.mameCompat = compat; cpu.s = 0x8000; cpu.pc = 0x1000;
      return cpu.step();
    };
    check(`CWAI ${mode}: MAME charges 16 for the instruction under mameCompat`, cwaiCost(true), 16);
  }
  // The hardware default keeps the 6309's own 22 (emulation) and 20 (native) for CWAI [Atkinson "CWAI", printed p. 55].
  const hwCwai = (native) => {
    const a = asm(' ORG $1000\n CWAI #$EF\n BRA *\n END');
    const mem = new Uint8Array(0x10000); mem.set(a.bytes, a.addr);
    mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
    const cpu = new CPU6309({ read: (x) => mem[x], write: (x, v) => { mem[x] = v; } });
    cpu.reset(); cpu.mameCompat = false; cpu.s = 0x8000; cpu.pc = 0x1000;
    if (native) cpu.md |= 1;
    return cpu.step();
  };
  check('CWAI emulation: the hardware figure is 22 [Atkinson "CWAI", printed p. 55]', hwCwai(false), 22);
  check('CWAI native: the hardware figure is 20 [Atkinson "CWAI", printed p. 55]', hwCwai(true), 20);
  // FIRQ-as-IRQ: with MD bit 1 set a FIRQ stacks the whole state, like an IRQ, and vectors through $FFF6.
  for (const native of [false, true]) {
    const mode = native ? 'native' : 'emulation';
    const run = (md) => {
      const { cpu } = irqCpu({ native, md });
      cpu.firqLine = true;
      let steps = 0;
      while (steps < 10 && cpu.pc !== 0x3100) { cpu.step(); steps++; }
      return { depth: 0x8000 - cpu.s, pc: cpu.pc };
    };
    const plain = run(0), asIrq = run(0x02);
    check(`FIRQ ${mode}: plain FIRQ stacks only CC and PC (3 bytes: 1 + 2)`, plain.depth, 3);
    check(`FIRQ ${mode}: plain FIRQ vectors through $FFF6`, plain.pc, 0x3100);
    check(`FIRQ-as-IRQ ${mode}: stacks the whole state (${native ? 14 : 12} bytes)`, asIrq.depth, native ? 14 : 12);
    check(`FIRQ-as-IRQ ${mode}: still vectors through $FFF6`, asIrq.pc, 0x3100);
  }
}

// ---------------------------------------------------------------------------------------------
// 14. The sweep firmware's own structure
// The 6309 lockstep measures what sweep.asm does, so a mistake in the generator is invisible if the sweep
// still runs to HALT: it just compares less than it claims. That happened once -- a generator edit deleted
// the LDMD that starts the second block, so the "native" half ran in emulation mode and every run was green
// while proving half of what it said. These checks read the generated file and fail on that class of mistake.
// ---------------------------------------------------------------------------------------------
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '../tools/mame-diff/6309');
  const gen = path.join(dir, 'gen-sweep.js');
  check('the sweep generator is present', fs.existsSync(gen), true);
  // Both generated variants: sweep.asm for the 16K ROM window (Dragon/CoCo) and sweep32.asm for the CoCo 3's
  // 32K one. They come from the same generator, so they must both carry the structure below -- checking only
  // one leaves the other free to be regenerated wrong and never compared.
  for (const file of ['sweep.asm', 'sweep32.asm']) {
    const sweep = fs.readFileSync(path.join(dir, file), 'utf8');
    const tag = (what) => `${file}: ${what}`;
    check(tag('the generated firmware is present'), sweep.length > 1000, true);
    const blocks = sweep.split(/; -+ (emulation|native) mode block -+/);
    check(tag('has an emulation-mode block and a native-mode block'), blocks.length >= 5, true);
    // The native block must be preceded by an LDMD #$01 after the emulation block, or the second block runs in
    // the wrong mode. Look for the mode switch between the two block headers.
    const iEm = sweep.indexOf('emulation mode block');
    const iNm = sweep.indexOf('native mode block');
    check(tag('the native block comes after the emulation block'), iEm >= 0 && iNm > iEm, true);
    check(tag('the second block is switched into native mode (LDMD #$01 before it)'),
      /LDMD\s+#\$01/.test(sweep.slice(iEm, iNm)), true);
    // and the tail switches back, so the trap section is not run in native mode by accident
    const iHalt = sweep.indexOf('HALT    BRA');
    check(tag('the tail returns to emulation mode before HALT'),
      /LDMD\s+#\$00/.test(sweep.slice(iNm, iHalt)), true);
    // the vectors sit at the top of the window each variant is built for: $BFF0 in the 16K image, $FFF0 in 32K
    const vectors = file === 'sweep32.asm' ? '$FFF0' : '$BFF0';
    check(tag(`the vectors sit at ${vectors}`), sweep.includes(`ORG     ${vectors}`), true);
    // The four TFM forms must all appear, as raw bytes, twice each (one per mode block). Both halves matter:
    // this is the coverage that the TFM 3A/3B fix depends on, and the mnemonic form would let an assembler
    // bug silently substitute 3A for 3B again -- which is exactly how opcode 3B went unexecuted before.
    const tfmOps = ['38', '39', '3A', '3B'].map((op) => sweep.split(`FCB     $11,$${op},$12`).length - 1);
    check(tag('the four TFM opcodes are each emitted as raw bytes in both blocks'),
      tfmOps.join(','), '2,2,2,2');
    // and each of those cases folds its destination window into a register, so the lockstep (which compares
    // registers and cycles, never memory) can actually see where the bytes went. $070/$072/$074/$076 in the
    // emulation block and $370/$372/$374/$376 in the native one.
    const folds = ['070', '072', '074', '076', '370', '372', '374', '376']
      .map((slot) => sweep.split(`STD     >BUF+$${slot}`).length - 1);
    check(tag('every TFM case folds its destination into a stored register'), folds.join(','), '1,1,1,1,1,1,1,1');
  }
  // and the two files must differ only in that window, not in the program. Compare instruction lines with
  // their trailing comments removed (the ORG line carries the same comment in both, only its operand differs).
  const lines = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith(';'))
    .map((l) => l.replace(/\s*;.*$/, '').trim());
  const a = lines('sweep.asm'), b = lines('sweep32.asm');
  check('the two variants carry the same program lines', a.length === b.length, true);
  const differing = a.map((l, i) => (l === b[i] ? null : `${i}: ${l} | ${b[i]}`)).filter(Boolean);
  check('the two variants differ in exactly one line, the vector base',
    differing.length === 1 && /ORG\s+\$[BF]FF0/.test(differing[0]), true);

  // Both trap cases must actually run. They vector to the same handler, so before it returned with RTI only
  // the first of the two ever executed and the lockstep compared less than it claimed -- the same class of
  // mistake as the deleted LDMD above. A lockstep cannot catch this (it compares our emulation with MAME
  // running the same firmware, so breaking the firmware changes both sides alike), so the guard is here:
  // run the image on a real machine and require both traps to have been taken.
  {
    const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
    const dir2 = require('path').join(__dirname, '../tools/mame-diff/6309');
    const asm = assembleFile(require('path').join(dir2, 'sweep.asm'), '6309');
    const prof = Emu.profiles.dragon64;
    const span = Math.max(...prof.roms.map((s) => s.at + s.size)) - 0x8000;
    const m = Emu.createMachine('dragon64', { cpu: '6309', mameCompat: true });
    const img = romImage(asm, 0x8000, span, 0x12), slots = {};
    for (const sl of prof.roms) slots[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
    m.setRoms(slots); m.reset(true);
    const trapPc = asm.symbols.get('TRAP');
    const resIl = asm.symbols.get('RESIL'), resDiv = asm.symbols.get('RESDIV');
    let traps = 0, halted = false, n = 0;
    const resumes = [];
    m.cpu.trace = (c) => {
      if (c.pc === trapPc) traps++;
      // the stacked PC the handler stored is asserted per trap below; here collect the resume points it
      // actually returned to, in order, so the two can be compared with the two labels exactly
      if (c.pc === resIl || c.pc === resDiv) resumes.push(c.pc);
      if (c.pc === asm.symbols.get('HALT')) halted = true;
      n++;
    };
    for (let f = 0; f < 600 && !halted; f++) m.runFrame();
    m.cpu.trace = null;
    check('the sweep takes BOTH trap cases (the handler returns past each)', traps, 2);
    check('the sweep still reaches HALT with both traps taken', halted, true);
    // The firmware resumed at the illegal trap's NOP and then the divide trap's NOP, in that order. An exact
    // comparison: a stacked PC one byte off, or either trap resuming at the wrong place, fails here.
    check('control returns to RESIL then RESDIV, exactly',
      resumes.map((x) => x.toString(16)).join(','), [resIl, resDiv].map((x) => x.toString(16)).join(','));
    // the marker records the MD status bits as they stand at the last trap; MAME does not clear them (see the
    // BITMD block above), so by the second exception both are set
    check('the trap marker reports both status bits set by the second trap', m.read(0x6000 + 0x7FE), 0xC0);
    // and the stacked PC the handler recorded is the exact resume label of the last (divide) trap
    const resume = (m.read(0x6000 + 0x7F0) << 8) | m.read(0x6000 + 0x7F1);
    check('the recorded stacked PC is exactly RESDIV', resume, resDiv);
  }
}

// ---------------------------------------------------------------------------------------------
// 15. The 8-bit read-modify-write family on memory, through a REAL MACHINE
// These run on a Dragon 64 built by createMachine, not on a bare CPU: the MAME deltas are applied in
// postInstruction()/mameTiming(), which only a machine drives end to end, and the bug this replaces was a
// delta that looked right on a bare CPU and never reached the machine. Each instruction runs from the sweep's
// own native block, so the PC, the mode and the surrounding bus activity are the ones the lockstep compares.
// The expected figures are Atkinson's, each on its own page: NEG 6/5 p.103, COM 6/5 p.54, LSR 6/5 p.98,
// ROR 6/5 p.118, ASR 6/5 p.18, ASL 6/5 p.16, ROL 6/5 p.116; DEC p.58, INC p.68 and CLR p.49 are also 6/5,
// and TST is 6/4 p.141. Default must be Atkinson's; under mameCompat MAME's figure is one cycle less for the
// seven that differ, and equal for DEC/INC/CLR/TST.
// ---------------------------------------------------------------------------------------------
{
  const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
  const dir = require('path').join(__dirname, '../tools/mame-diff/6309');
  const asm = assembleFile(require('path').join(dir, 'sweep.asm'), '6309');
  const prof = Emu.profiles.dragon64;
  const span = Math.max(...prof.roms.map((s) => s.at + s.size)) - 0x8000;
  const img = romImage(asm, 0x8000, span, 0x12);
  const slots = {};
  for (const sl of prof.roms) slots[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  // [direct opcode, name, Atkinson's native figure direct/indexed/extended, printed page, does MAME charge
  // one less in every mode?]. The indexed opcode is base+0x60 and the extended base+0x70, as Atkinson's own
  // rows give them (e.g. NEG "00 6/5 2 | 60 6+ 2+ | 70 7/6 3", printed p. 103).
  const FAM = [
    [0x00, 'NEG', [5, 6, 6], 103, true], [0x03, 'COM', [5, 6, 6], 54, true],
    [0x04, 'LSR', [5, 6, 6], 98, true], [0x06, 'ROR', [5, 6, 6], 118, true],
    [0x07, 'ASR', [5, 6, 6], 18, true], [0x08, 'ASL', [5, 6, 6], 16, true],
    [0x09, 'ROL', [5, 6, 6], 116, true],
    [0x0D, 'TST', [4, 5, 5], 141, false], [0x0A, 'DEC', [5, 6, 6], 58, false],
    [0x0C, 'INC', [5, 6, 6], 68, false], [0x0F, 'CLR', [5, 6, 6], 49, false],
  ];
  const MODES = ['direct', 'indexed', 'extended'];
  const offs = (base) => [base, base + 0x60, base + 0x70];
  const wanted = new Set(FAM.flatMap(([base]) => offs(base)));
  const measure = (compat) => {
    const m = Emu.createMachine('dragon64', { cpu: '6309', mameCompat: compat });
    m.setRoms(slots); m.reset(true);
    const c = m.cpu, out = {};
    let n = 0;
    while (n < 400000 && Object.keys(out).length < wanted.size) {
      const pc = c.pc, before = c.totalCycles, op = c.bus.read(pc);
      c.step(); n++;
      // native mode only; the sweep's block runs every one of these with its own operand and the cost
      // includes that operand fetch. Only the first sighting of each opcode is kept.
      if ((c.md & 1) && wanted.has(op) && out[op] === undefined) out[op] = c.totalCycles - before;
    }
    return out;
  };
  const hw = measure(false), mc = measure(true);
  for (const [base, name, atkinson, page, mameDiffers] of FAM) {
    offs(base).forEach((op, i) => {
      const mode = MODES[i], want = atkinson[i];
      check(`${name} ${mode} on memory, default = Atkinson (printed p. ${page})`, hw[op], want);
      check(`${name} ${mode} on memory, mameCompat = MAME (${mameDiffers ? 'one less' : 'agrees'})`,
        mc[op], mameDiffers ? want - 1 : want);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 9b. NEGW, ASRW and ASLW are not 6309 instructions, so the core must trap on them by default.
// The hardware has no such opcodes: Atkinson's opcode map leaves those cells blank (printed p. 152), and
// its instruction pages say so in as many words - "The 6309 does not provide instructions for negating the
// E, F, W and Q accumulators" (NEG, printed p. 101), "does not provide a variant of ASR to operate on the W
// accumulator" (ASRD, printed p. 18), "The D accumulator is the only 16-bit register for which an ASL
// instruction has been provided" (ASLD, printed p. 16). Undefined opcodes take the Illegal Instruction
// exception (printed p. 153, note 4), which is MD bit 6 and the $FFF0 vector, exactly as for any other
// undefined opcode. MAME 0.289 executes them as NEG16/ASR16/ASL16 at 3 cycles instead, so under
// config.mameCompat they must keep doing that - that is what the lockstep compares.
// ---------------------------------------------------------------------------------------------
{
  const runTrap = (bytes, compat) => {
    const m = new Uint8Array(0x10000);
    m.fill(0x12); m.set(bytes, 0x1000); m[0xFFFE] = 0x10; m[0xFFFF] = 0;
    for (const v of [0xFFF0, 0xFFF2, 0xFFF4, 0xFFF6, 0xFFF8, 0xFFFA, 0xFFFC]) { m[v] = 0x30; m[v + 1] = 0x00; }
    m[0x3000] = 0x12;
    const cpu = new CPU6309({ read: (a) => m[a], write: (a, v) => { m[a] = v; } });
    cpu.mameCompat = compat;
    cpu.reset(); cpu.s = 0x8000; cpu.u = 0x7000; cpu.x = 0x2000; cpu.dp = 0; cpu.cc = 0x10;
    cpu.w = 0xFFFF; cpu.d = 0xFFFF;
    const n = cpu.step();
    return { pc: cpu.pc, md: cpu.md, cycles: n, w: cpu.w, d: cpu.d };
  };
  for (const [name, bytes] of [['NEGW $1050', [0x10, 0x50]], ['ASRW $1057', [0x10, 0x57]], ['ASLW $1058', [0x10, 0x58]]]) {
    const r = runTrap(bytes, false);
    check(`${name} traps by default (MD bit 6)`, !!(r.md & 0x40), true);
    check(`${name} vectors through $FFF0 by default`, r.pc, 0x3000);
    const c = runTrap(bytes, true);
    check(`${name} under mameCompat runs as MAME does (no trap)`, !!(c.md & 0x40), false);
    check(`${name} under mameCompat is 3 cycles, as MAME charges`, c.cycles, 3);
  }
  // the shift/negation must not have happened in the default path: W and D are untouched by a trap
  const neg = runTrap([0x10, 0x50], false);
  check('NEGW by default leaves W and D alone', neg.w === 0xFFFF && neg.d === 0xFFFF, true);
}

// ---------------------------------------------------------------------------------------------
// 9c. The trap's cycle count.
// No primary source gives the figure: Atkinson's programming-aid table has rows for SWI, SWI2 and SWI3 -
// the instructions that share the vector and the whole-state push - but no row for an illegal opcode or
// the trap as an instruction (printed p. 149), and its prose (pp. 59, 60) describes the stacking and the
// $FFF0 vector without a cycle count; the HD63B09EP guide's "Error Trapping" section (printed p. 7) and
// the Hitachi data book give none either. With no source, the default follows MAME (AGENTS 4.6), which
// charges the page-1 illegal opcode 19 cycles and a prefixed one 20, measured on 0.289 and 0.264 by
// tools/mame-diff/6309/illegal-probe.js. The controls in that firmware show the trap sequence itself is
// not in question: SWI3 (same vector and push) is 20 in both, and DIVD by zero (same trap) is 44 in both.
// So only the illegal path's own overhead moves, by one cycle.
// ---------------------------------------------------------------------------------------------
{
  const trapCycles = (bytes) => {
    const m = new Uint8Array(0x10000);
    m.fill(0x12); m.set(bytes, 0x1000);
    m[0xFFF0] = 0x30; m[0xFFF1] = 0; m[0xFFFE] = 0x10; m[0xFFFF] = 0; m[0x3000] = 0x12;
    const cpu = new CPU6309({ read: (a) => m[a], write: (a, v) => { m[a] = v; } });
    cpu.reset(); cpu.s = 0x8000; cpu.cc = 0x10;
    const t = cpu.totalCycles;
    cpu.step();
    return { cycles: cpu.totalCycles - t, pc: cpu.pc, md: cpu.md };
  };
  const p1 = trapCycles([0x15]);
  check('an undefined page-1 opcode traps', !!(p1.md & 0x40) && p1.pc === 0x3000, true);
  check('an undefined page-1 opcode costs 19 cycles, as MAME charges', p1.cycles, 19);
  const p2 = trapCycles([0x10, 0x20]);
  check('an undefined prefixed opcode traps', !!(p2.md & 0x40) && p2.pc === 0x3000, true);
  check('an undefined prefixed opcode costs 20 cycles, as MAME charges', p2.cycles, 20);
}

// The probe that measured the trap figures above must stay runnable. A merge on this branch once kept
// tools/mame-diff/6309/illegal-probe.js (js/cpu/cpu6309.js and this file both refer to it) while leaving the
// illegal.asm it reads deleted: nothing in tests/all.js executes the probe, so the tree was green with the
// tool broken, and merging back would have deleted the firmware from main. illegal.asm is hand-written, not
// generated (gen-sweep.js writes only sweep.asm), so nothing would have restored it. These two checks make
// that state fail here instead of silently.
{
  const fs2 = require('fs'), path2 = require('path');
  const pdir = path2.join(__dirname, '../tools/mame-diff/6309');
  const asmFile = path2.join(pdir, 'illegal.asm'), probeFile = path2.join(pdir, 'illegal-probe.js');
  check('the illegal-trap probe is present', fs2.existsSync(probeFile), true);
  check('the firmware that probe reads is present (illegal.asm is hand-written, not generated)',
    fs2.existsSync(asmFile), true);
  const a = fs2.existsSync(asmFile) ? Emu.assemble(fs2.readFileSync(asmFile, 'utf8'), '6309') : null;
  check('that firmware assembles for the 6309', !!(a && a.ok), true);
}

// "ok" only when nothing failed: printing it after a FAILED line made a failing run read as a passing one
if (failures) { console.log(`${failures} of ${count} checks FAILED`); process.exitCode = 1; }
else console.log(`ok ${count} checks`);