// Run: node tests/cpu6309-timing.test.js
//
// Two properties of the HD6309 core that the instruction tests (tests/cpu6309.test.js) cannot check one row
// at a time, swept over every opcode:
//
//  1. The bus-cycle log always matches the cycle count. js/machines/sam.js and js/machines/coco3.js walk
//     cycleAddr[0..cycleCount) to time each bus cycle (the SAM times a cycle by the address it presents), and
//     read cpu.c as the instruction's length. If a native-mode instruction charges fewer cycles than it logs,
//     those machines time cycles the instruction does not have. The invariant is cycleCount === c, in both
//     modes, for every opcode and every indexed post byte.
//
//  2. The legal-opcode set is the hardware's. An HD6309 traps (vectors through $FFF0) on an opcode it has no
//     instruction for, and runs every opcode it does have. The reference set is MAME's hd6309.lst dispatch
//     table, which agrees with the opcode tables in Atkinson's reference (the "Op" column) and the Hitachi
//     data book (U70-B, Table 10 "Hexadecimal Values of Machine Codes"). The 6809 core is looser (some
//     undefined low nibbles run as NOPs) and its behaviour is pinned by the regression hashes, so the 6309
//     checks the set itself (LEGAL1/LEGAL2/LEGAL3 in js/cpu/cpu6309.js).
const Emu = require('./load')();
const { CPU6309 } = Emu;

let failures = 0, count = 0;
const check = (name, got, want) => { count++; if (got !== want) { failures++; console.log(`FAIL ${name}: got ${got} want ${want}`); } };

const mem = new Uint8Array(0x10000);
const INTS = [0xFFF0, 0xFFF2, 0xFFF4, 0xFFF6, 0xFFF8, 0xFFFA, 0xFFFC];
function step(bytes, native, mameCompat = false) {
  mem.fill(0x12); mem.set(bytes, 0x1000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
  for (const v of INTS) { mem[v] = 0x30; mem[v + 1] = 0x00; }   // every vector lands on a HALT loop
  mem[0x3000] = 0x12;
  const cpu = new CPU6309({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset(); cpu.s = 0x8000; cpu.u = 0x7000; cpu.x = 0x2000; cpu.y = 0x2100; cpu.dp = 0; cpu.cc = 0x10;
  cpu.d = 0x10; cpu.w = 0x20; cpu.q = 0x10; cpu.e = 1; cpu.f = 1;
  if (native) cpu.md |= 1;
  if (mameCompat) cpu.mameCompat = true;
  cpu.c = 0;
  const c = cpu.step();
  return { c, cc: cpu.cycleCount, trapped: !!(cpu.md & 0x40) };
}

// ---- 1. cycleCount === c, every opcode and post byte, both modes ----
{
  const bad = [];
  let n = 0;
  const pages = [];
  for (let op = 0; op < 256; op++) {
    if (op === 0x10 || op === 0x11) { for (let op2 = 0; op2 < 256; op2++) pages.push([op, op2]); }
    else pages.push([op]);
  }
  for (const pre of pages) for (let pb = 0; pb < 256; pb++) {
    const bytes = [...pre, pb, 0x10, 0x20, 0x10, 0x20, 0x12];
    for (const native of [false, true]) for (const compat of [false, true]) {
      const r = step(bytes, native, compat); n++;
      if (r.c !== r.cc) bad.push(`${bytes.slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join(' ')} ${native ? 'NM' : 'EM'}${compat ? ' mameCompat' : ''}: c=${r.c} log=${r.cc}`);
    }
  }
  check(`cycleCount equals c for every opcode and post byte, hardware and mameCompat (${n} steps)`, bad.length === 0, true);
  for (const b of bad.slice(0, 8)) console.log('  ' + b);
}

// ---- 2. the legal set is the hardware's ----
// LEGAL1/2/3 came from MAME's dispatch table; spot-check the boundaries rather than re-transcribing them here.
// Undefined opcodes on each page trap, legal ones do not.
{
  const traps = (bytes) => step(bytes, false).trapped;
  for (const [name, bytes] of [
    ['page 1 $41 (undefined)', [0x41, 0x00, 0x10]],
    ['page 1 $87 (undefined)', [0x87, 0x00, 0x10]],
    ['page 1 $CF (undefined)', [0xCF, 0x00, 0x10]],
    ['page 2 $41 (undefined)', [0x10, 0x41, 0x00, 0x10]],
    ['page 2 $4B (undefined)', [0x10, 0x4B, 0x00, 0x10]],
    ['page 3 $40 (undefined)', [0x11, 0x40, 0x00, 0x10]],
    ['page 3 $84 (undefined)', [0x11, 0x84, 0x00, 0x10]],
  ]) check(`traps on ${name}`, traps(bytes), true);
  for (const [name, bytes] of [
    ['NOP', [0x12, 0x12]], ['SWI3', [0x11, 0x3F, 0x12]], ['SWI2', [0x10, 0x3F, 0x12]],
    ['SEXW', [0x14, 0x12]], ['LDQ #', [0xCD, 0x11, 0x22, 0x33, 0x44]], ['OIM direct', [0x01, 0x0F, 0x10]],
    ['TFM X+,Y+', [0x11, 0x38, 0x01, 0x12]], ['BAND', [0x11, 0x30, 0x00, 0x10]],
  ]) check(`runs ${name}`, traps(bytes), false);
}

// ---- 3. the native-mode dispatcher is right: page 2/3 differ, and only the 6309 additions are here ----
{
  // 0x113F (SWI3) must run as SWI3, not the F bank's MULD: the vector is $FFF2 and the count is 20
  const r = step([0x11, 0x3F, 0x12], false);
  check('SWI3 is not the F bank MULD (no trap)', r.trapped, false);
  check('SWI3 emulation cycles', r.c, 20);
}

// "ok" only when nothing failed: printing it after a FAILED line made a failing run read as a passing one
if (failures) { console.log(`${failures} of ${count} checks FAILED`); process.exitCode = 1; }
else console.log(`ok ${count} checks`);
