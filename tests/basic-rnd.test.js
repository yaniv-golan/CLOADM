// Run: node tests/basic-rnd.test.js
//
// The clean-room BASIC's RND against the original's sequence, from the black-box record bb8 rnd-seq
// (tests/basic/bb/bb8-real.jsonl; docs/clean-room-basic.md section 5, provenance item 15):
//  * the case's own program (tests/basic/cases/rnd-seq.bas, its value lines), replayed on ours: every one of its 434
//    printed values and the five bytes each is stored as, the same as the original's: 200 of RND(0) from a cold
//    start, RND(1) (one step each), RND(6), RND(100) and RND(65535), and RND(-1), RND(-2) and RND(-12345) with the
//    50 values after each, and RND(-1) again;
//  * the seed in RAM at 278-281, high byte first: after RND(-1) and 11 of RND(0), 5 173 54 120 (the record's bytes);
//  * the generator's formula on the CPU from chosen seeds (tests/basic-math.test.js's way of calling the ROM): the
//    seed and the fraction's exact bytes, for seeds whose fraction is small (normalised by several places, the guard
//    byte shifted in), for seeds whose next state is 0, has leading zero bytes or is all ones, and for 10,000
//    consecutive calls from the cold-start seed.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const built = buildBasic();

// the record: the lines from RUN to the SIN probe (the values, their bytes and the headings)
const real = fs.readFileSync(path.join(__dirname, 'basic/bb/bb8-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.case === 'rnd-seq');
const valuePart = (t) => { const a = t.indexOf('RUN') + 1, b = t.indexOf('SIN CHANGES'); return t.slice(a, b < 0 ? undefined : b); };
const want = valuePart(real.transcript);
const VALUE = /^ *-?[.0-9E+-]+ +\d+,\d+,\d+,\d+,\d+,$/;
check('the record holds 434 values with their bytes', want.filter((l) => VALUE.test(l)).length === 434, String(want.filter((l) => VALUE.test(l)).length));

// ---- the case's program up to the RAM probe, on ours ----
{
  const text = fs.readFileSync(path.join(__dirname, 'basic/cases/rnd-seq.bas'), 'utf8').split('\n')
    .filter((l) => !/^(9\d|1\d\d|8\d\d) /.test(l)).map((l) => (l === 'RUN' ? '85 END\nRUN' : l)).join('\n');
  const r = runCase(built.rom, text);
  const got = valuePart(r.transcript).slice(0, want.length);
  const diff = want.findIndex((l, i) => got[i] !== l);
  check('rnd-seq on ours: every value and its bytes as the original printed them', r.status === 'ok' && diff < 0,
    diff < 0 ? '' : `line ${diff}: ours ${JSON.stringify(got[diff])}, the original ${JSON.stringify(want[diff])}`);
}

// ---- the seed's bytes at 278-281 ----
{
  const r = runCase(built.rom, '10 R=RND(-1):FOR I=1 TO 11:R=RND(0):NEXT:PRINT PEEK(278);PEEK(279);PEEK(280);PEEK(281)\nRUN\n');
  check('after RND(-1) and 11 of RND(0) the seed at 278-281 is 5 173 54 120, as on the original', r.transcript.includes(' 5  173  54  120'), JSON.stringify(r.transcript));
}
{
  const r = runCase(built.rom, 'PRINT PEEK(278);PEEK(279);PEEK(280);PEEK(281)\n');
  check('the seed at a cold start: 79 199 82 89 ($4FC75259)', r.transcript.includes(' 79  199  82  89'), JSON.stringify(r.transcript));
}
{
  // a seed POKEd in: the next value is the generator's step from it ($80000000, as RND(-1) makes it)
  const r = runCase(built.rom, 'POKE 278,128:POKE 279,0:POKE 280,0:POKE 281,0:PRINT RND(0)\n');
  check('POKE 278-281 sets the seed: $80000000 gives RND(-1)\'s first value', r.transcript.includes(' .522222849'), JSON.stringify(r.transcript));
}

// ---- the formula on the CPU ----
{
  const { Emu } = require('./basic/harness.js');
  const sym = (s) => built.symbols.get(s);
  const m = Emu.createMachine('dragon64');
  m.setRoms({ basic: built.rom, basic64: null });
  m.reset(true);
  for (let i = 0; i < 20; i++) m.runFrame();
  const cpu = m.cpu, ram = m.ram, TRAP = 0x3000, FAC = sym('FACEXP'), SEED = sym('SEED');
  ram[TRAP] = 0x20; ram[TRAP + 1] = 0xFE;
  const call = (name) => {
    cpu.s = 0x7E00; cpu.s -= 2; ram[cpu.s] = TRAP >> 8; ram[cpu.s + 1] = TRAP & 0xFF;
    cpu.cc |= 0x50; cpu.dp = 0; cpu.jump(sym(name));
    for (let i = 0; i < 200000; i++) { if (cpu.pc === TRAP) return; cpu.step(); }
    throw new Error(`${name} did not return`);
  };
  // the model: seed' = seed x $40E64DAB + $05B0658B (mod 2^32); the fraction is seed' / 2^32 with the product's bits
  // 40-47 as the 8 bits below it, normalised, then rounded to 32 bits at the guard byte's top bit
  const model = (s) => {
    const p = BigInt(s) * 0x40E64DABn, y = (p + 0x05B0658Bn) & 0xFFFFFFFFn, g = (p >> 40n) & 0xFFn;
    let v = (y << 8n) | g, e = 128;
    if (v === 0n) return { seed: 0, bytes: [0, 0, 0, 0, 0] };
    while (!(v & (1n << 39n))) { v <<= 1n; e--; }
    let top = v >> 8n;
    if (v & 0x80n) { top++; if (top === 1n << 32n) { top = 1n << 31n; e++; } }
    return { seed: Number(y), bytes: [e, Number(top >> 24n) & 0x7F, Number((top >> 16n) & 0xFFn), Number((top >> 8n) & 0xFFn), Number(top & 0xFFn)] };
  };
  const SCR = 0x3100;   // FAC packed by MOVMF (rounded, as a variable would hold it)
  let ok = true, detail = '';
  // seeds whose next value needs a shift of 0 to 7 places, a seed of 0, and a run from it; then seeds chosen (by undoing
  // a step) so the next state is 0, $00123456, $00001234, $00000012 (the guard byte shifted in by 8, 16 and 24
  // places and more), $FFFFFFFF (rounding carries into the exponent) and fractions at 1/3, 2/3, .8 and .4
  const inv = (() => { let x = 1n; for (let i = 0; i < 6; i++) x = (x * (2n - 0x40E64DABn * x)) % (1n << 32n); return (x + (1n << 32n)) % (1n << 32n); })();
  const prevOf = (t) => Number((((BigInt(t) - 0x05B0658Bn) % (1n << 32n) + (1n << 32n)) % (1n << 32n) * inv) % (1n << 32n));
  const seeds = [0x8D5853C7, 0x9C173D37, 0xEE0790A7, 0, 0x4FC75259, 0xFFFFFFFF];
  for (const t of [0, 0x00123456, 0x00001234, 0x12, 0xFFFFFFFF, 0x55555555, 0xAAAAAAAA, 0xCCCCCCCC, 0x66666666]) seeds.push(prevOf(t));
  const targeted = seeds.length;
  // and 10,000 consecutive calls from the cold-start seed
  let s = 0x4FC75259;
  for (let i = 0; i < 10000; i++) { seeds.push(s); s = model(s).seed; }
  for (const s0 of seeds) {
    ram[SEED] = s0 >>> 24; ram[SEED + 1] = (s0 >>> 16) & 0xFF; ram[SEED + 2] = (s0 >>> 8) & 0xFF; ram[SEED + 3] = s0 & 0xFF;
    for (let k = 0; k < 7; k++) ram[FAC + k] = 0;   // RND(0): FAC holds the argument when RN1 is reached
    call('RN1');
    cpu.x = SCR; call('MOVMF');
    const w = model(s0), seed = ((ram[SEED] << 24) | (ram[SEED + 1] << 16) | (ram[SEED + 2] << 8) | ram[SEED + 3]) >>> 0;
    const bytes = Array.from(ram.slice(SCR, SCR + 5));
    if (seed !== w.seed || bytes.join() !== w.bytes.join()) { ok = false; detail = `seed ${s0.toString(16)}: got ${seed.toString(16)} ${bytes}, want ${w.seed.toString(16)} ${w.bytes}`; break; }
  }
  check(`RND(0): seed x $40E64DAB + $05B0658B mod 2^32, the product's bits 40-47 below it, normalised and rounded: ${targeted} chosen seeds (next state 0, with leading zero bytes, all ones) and 10,000 in a row from cold start`, ok, detail);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
