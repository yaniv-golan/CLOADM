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
//    consecutive calls from the cold-start seed, whose bytes folded as bb9 rnd-long folds them give the original's
//    five checksums of its first 10,000 (it reached the case's #timeout after that block);
// and from the record bb9 (tests/basic/bb/bb9-real.jsonl):
//  * rnd-args on the CPU: RND(n) for 19 arguments from 9 seeds, all 171 values' five bytes and the seed after, the
//    arguments as the original reads them: INT(f x INT(n) + 1), f rounded, the product rounded, the sum rounded;
//  * rnd-neg on the CPU: 16 negative arguments and five forms of 0 (an exponent byte of 0 is 0, sign bit or not),
//    each with the two RND(0) after it;
//  * rnd-state replayed on ours, line for line: $0115 is 128 from a cold start, RND neither reads nor writes it,
//    NEW, CLEAR and RUN leave $0115-$0119;
//  * mutants (built from edited source) that must turn these red: $0115 left 0, n not made whole first, an exponent
//    of 0 with the sign bit set reseeding.
const fs = require('fs'), path = require('path');
const { runCase, Emu } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
const F = require('./basic/fpmodel.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const built = buildBasic();
const bb9 = fs.readFileSync(path.join(__dirname, 'basic/bb/bb9-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const real9 = (name) => bb9.find((r) => r.case === name);
// a record's screen lines joined where a line of 32 characters ran on into the next
const logical = (t) => { const out = []; let cur = ''; for (const l of t) { cur += l; if (l.length < 32) { out.push(cur); cur = ''; } } if (cur) out.push(cur); return out; };
const afterRun = (t) => { const l = logical(t); return l.slice(l.indexOf('RUN') + 1); };
const BYTES = /(\d+),(\d+),(\d+),(\d+),(\d+),\/(\d+),(\d+),(\d+),(\d+),(\d+),$/;
const bytesOf = (line) => { const m = BYTES.exec(line); if (!m) throw new Error(`no bytes in ${JSON.stringify(line)}`); return { value: m.slice(1, 6).map(Number), ram: m.slice(6, 11).map(Number) }; };

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
  // bb9 rnd-long's first block: every 2,000 calls the checksum S (S x 7 + each of the five bytes, mod 65521) and the
  // seed bytes; the original reached the case's #timeout after it [BB bb9 rnd-long]
  // (its lines as one text: a line of 32 characters ran on into the next, a shorter one ended in a space the screen
  // does not show)
  const longT = real9('rnd-long').transcript, longText = longT.slice(longT.indexOf('RUN') + 1).map((l) => (l.length === 32 ? l : `${l} `)).join('');
  const longWant = [...longText.matchAll(/ 1 +(\d+) +(\d+) +(\d+) +(\d+) +(\d+) +(\d+) +(\d+) /g)].map((m) => m.slice(1).map(Number));
  const longGot = [];
  let fold = 0;
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
  for (let i = 0; i < seeds.length; i++) {
    const s0 = seeds[i];
    ram[SEED] = s0 >>> 24; ram[SEED + 1] = (s0 >>> 16) & 0xFF; ram[SEED + 2] = (s0 >>> 8) & 0xFF; ram[SEED + 3] = s0 & 0xFF;
    for (let k = 0; k < 7; k++) ram[FAC + k] = 0;   // RND(0): FAC holds the argument when RN1 is reached
    call('RN1');
    cpu.x = SCR; call('MOVMF');
    const w = model(s0), seed = ((ram[SEED] << 24) | (ram[SEED + 1] << 16) | (ram[SEED + 2] << 8) | ram[SEED + 3]) >>> 0;
    const bytes = Array.from(ram.slice(SCR, SCR + 5));
    if (seed !== w.seed || bytes.join() !== w.bytes.join()) { ok = false; detail = `seed ${s0.toString(16)}: got ${seed.toString(16)} ${bytes}, want ${w.seed.toString(16)} ${w.bytes}`; break; }
    if (i >= targeted) {
      for (const b of bytes) fold = (fold * 7 + b) % 65521;
      if ((i - targeted + 1) % 2000 === 0) longGot.push([i - targeted + 1, fold, ram[SEED - 1], ram[SEED], ram[SEED + 1], ram[SEED + 2], ram[SEED + 3]]);
    }
  }
  check('bb9 rnd-long: the first 10,000 from a cold start fold to the original\'s five checksums, with its seed bytes and 128 at $0115 (all the original printed before its #timeout)',
    longWant.length === 5 && JSON.stringify(longGot) === JSON.stringify(longWant), `ours ${JSON.stringify(longGot)}, the original ${JSON.stringify(longWant)}`);
  check(`RND(0): seed x $40E64DAB + $05B0658B mod 2^32, the product's bits 40-47 below it, normalised and rounded: ${targeted} chosen seeds (next state 0, with leading zero bytes, all ones) and 10,000 in a row from cold start`, ok, detail);
}

// ---- bb9: RND's argument, on the CPU ----
// a number packed to nearest, ties up (BigInt, from the decimal text; independent of the ROM's FIN)
const packDec = (text) => {
  const neg = text[0] === '-', t = neg ? text.slice(1) : text;
  let [mant, ex] = t.split('E'); ex = Number(ex || 0);
  const [ip, fp = ''] = mant.split('.');
  let num = BigInt((ip || '0') + fp), den = 1n; ex -= fp.length;
  if (ex >= 0) num *= 10n ** BigInt(ex); else den = 10n ** BigInt(-ex);
  if (num === 0n) return [0, 0, 0, 0, 0];
  let e = 128;
  while (num >= den) { den *= 2n; e++; }
  while (num * 2n < den) { num *= 2n; e--; }
  let m = ((num << 33n) / den + 1n) >> 1n;
  if (m === 1n << 32n) { m >>= 1n; e++; }
  return [e, Number((m >> 24n) & 0x7Fn) | (neg ? 0x80 : 0), Number((m >> 16n) & 0xFFn), Number((m >> 8n) & 0xFFn), Number(m & 0xFFn)];
};
// RND of a packed argument from a seed: the result's five bytes as a variable holds them, and $0115-$0119 after
function rndMachine(rom, symbols) {
  const sym = (s) => symbols.get(s);
  const m = Emu.createMachine('dragon64');
  m.setRoms({ basic: rom, basic64: null });
  m.reset(true);
  for (let i = 0; i < 20; i++) m.runFrame();
  const cpu = m.cpu, ram = m.ram, TRAP = 0x3000, FAC = sym('FACEXP'), SEED = sym('SEED'), SCR = 0x3100;
  ram[TRAP] = 0x20; ram[TRAP + 1] = 0xFE;
  const call = (name) => {
    cpu.s = 0x7E00; cpu.s -= 2; ram[cpu.s] = TRAP >> 8; ram[cpu.s + 1] = TRAP & 0xFF;
    cpu.cc |= 0x50; cpu.dp = 0; cpu.jump(sym(name));
    for (let i = 0; i < 2000000; i++) { if (cpu.pc === TRAP) return; cpu.step(); }
    throw new Error(`${name} did not return`);
  };
  const setSeed = (b) => b.forEach((v, i) => { ram[SEED + i] = v; });
  const rnd = (arg) => {
    ram[FAC] = arg[0]; ram[FAC + 1] = arg[1] | 0x80; ram[FAC + 2] = arg[2]; ram[FAC + 3] = arg[3]; ram[FAC + 4] = arg[4];
    ram[FAC + 5] = 0; ram[FAC + 6] = arg[1] & 0x80 ? 0xFF : 0;
    call('RNDF');
    cpu.x = SCR; call('MOVMF');
    return { value: Array.from(ram.slice(SCR, SCR + 5)), ram: Array.from(ram.slice(SEED - 1, SEED + 4)) };
  };
  return { setSeed, rnd };
}
const ARGS = ['0', '1', '2', '3', '6', '.1', '.5', '.999', '1.1', '1.5', '2.5', '3.9', '2.999999', '65535', '1E9', '4294967295', '4294967296', '1E10', '1E38'];
const ARGSEEDS = [[208, 20, 65, 94], [51, 182, 42, 93], [142, 195, 186, 195], [125, 155, 9, 145], [151, 88, 19, 92], [51, 128, 35, 97], [108, 114, 88, 95], [142, 162, 146, 251], [104, 75, 50, 149]];
// the arguments as the original reads them, one rounded step of ten a place (tests/basic/fpmodel.js finTen): 1E38
// two units above the nearest, $96769953 (every seed's RND(1E38) fits that and no other), .999 and 2.999999 one
// above (docs/clean-room-basic.md section 5). The values are checked on the CPU from these bytes, not through FIN.
const argBytes = (a) => F.finTen(a);
function argsBad(rom, symbols) {
  const lines = afterRun(real9('rnd-args').transcript), M = rndMachine(rom, symbols), bad = [];
  let k = 0;
  for (const s of ARGSEEDS) {
    for (const a of ARGS) {
      const want = bytesOf(lines[k * 2 + 1]); k++;
      M.setSeed(s);
      const got = M.rnd(argBytes(a));
      if (got.value.join() !== want.value.join() || got.ram.join() !== want.ram.join()) bad.push(`seed ${s} RND(${a}): ours ${got.value}/${got.ram}, the original ${want.value}/${want.ram}`);
    }
  }
  return { bad, k };
}
{
  const { bad, k } = argsBad(built.rom, built.symbols);
  check(`bb9 rnd-args: all ${k} of RND(n) for 19 arguments from 9 seeds, five bytes and $0115-$0119, as the original (INT(f x INT(n) + 1))`, k === 171 && bad.length === 0, `${bad.length} differ: ${bad.slice(0, 3).join('; ')}`);
}
// rnd-neg: from the seed 208 20 65 94 each time; the original's readings of -1E-30, -1E30, -1.00000001 and
// -.999999999 have the mantissas $A2425FF8, $C9F2C9CF, $80000016 and $FFFFFFFD (the step undone from the seed it left;
// one or two units above the nearest); the forms of 0: an exponent byte of 0 with the mantissa of 5, sign bit clear and set
const NEGS = [['-1'], ['-2'], ['-4'], ['-.5'], ['-3'], ['-1.5'], ['-6'], ['-12345'], ['-12345'], ['-24690'], ['-1E-30', 0xA2425FF8],
  ['-1E30', 0xC9F2C9CF], ['-1.00000001', 0x80000016], ['-65535'], ['-4294967295'], ['-.999999999', 0xFFFFFFFD],
  ['0'], ['-0', [0, 0, 0, 0, 0]], ['1-1', [0, 0, 0, 0, 0]], ['E0', [0, 0x20, 0, 0, 0]], ['-E0', [0, 0xA0, 0, 0, 0]]];
const negArg = ([name, x]) => {
  if (Array.isArray(x)) return x;
  const b = packDec(name);
  return x === undefined ? b : [b[0], x >>> 24, (x >>> 16) & 0xFF, (x >>> 8) & 0xFF, x & 0xFF];   // (negative: the sign bit is the mantissa's top bit)
};
function negBad(rom, symbols) {
  const lines = afterRun(real9('rnd-neg').transcript), M = rndMachine(rom, symbols), bad = [];
  NEGS.forEach((e, i) => {
    const name = e[0], arg = negArg(e);
    M.setSeed([208, 20, 65, 94]);
    const got = [M.rnd(arg), M.rnd([0, 0, 0, 0, 0]), M.rnd([0, 0, 0, 0, 0])];
    const want = [1, 2, 3].map((j) => bytesOf(lines[i * 4 + j]));
    if (got.some((g, j) => g.value.join() !== want[j].value.join() || g.ram.join() !== want[j].ram.join())) bad.push(`RND(${name}): ours ${got.map((g) => g.value)}, the original ${want.map((w) => w.value)}`);
  });
  return bad;
}
{
  const bad = negBad(built.rom, built.symbols);
  check(`bb9 rnd-neg: ${NEGS.length} arguments (negative, and 0 in five forms: an exponent byte of 0 is 0 even with the sign bit set), each with the next two RND(0), bytes and $0115-$0119 as the original`, bad.length === 0, bad.slice(0, 3).join('; '));
}

// ---- bb9 rnd-state, replayed on ours ----
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${name}.bas`), 'utf8');
{
  const r = runCase(built.rom, 'PRINT PEEK(277)\n');
  check('$0115 (277) is 128 at a cold start [BB bb9 rnd-state]', r.transcript.includes(' 128'), JSON.stringify(r.transcript));
}
{
  const want = real9('rnd-state').transcript, got = runCase(built.rom, caseText('rnd-state')).transcript;
  const d = want.findIndex((l, i) => got[i] !== l);
  check('bb9 rnd-state on ours, line for line: 128 at $0115 from a cold start, RND neither reading nor writing it, each of $0115-$0119 changed alone, NEW, CLEAR and RUN leaving them',
    d < 0 && got.length === want.length, d < 0 ? '' : `line ${d}: ours ${JSON.stringify(got[d])}, the original ${JSON.stringify(want[d])}`);
}
// ---- mutants (built from edited source): each must turn a check above red ----
for (const [name, file, from, to, test] of [
  ['$0115 left 0 at a cold start', 'boot.inc', 'LDD     #$804F', 'LDD     #$004F', (rom) => !runCase(rom, 'PRINT PEEK(277)\n').transcript.includes(' 128')],
  ['n not made whole before the product', 'mathfn.inc', '        JSR     FTRUNC          ; INT(n)\n', '', (rom, sy) => argsBad(rom, sy).bad.length > 0],
  ['an exponent of 0 with the sign bit set reseeds', 'mathfn.inc', 'BEQ     RN1             ; 0, whatever its sign', 'BRN     RN1             ; 0, whatever its sign', (rom, sy) => negBad(rom, sy).length > 0],
]) {
  let used = false;
  const mb = buildBasic({ edit: (f, text) => { if (f !== file) return text; if (!text.includes(from)) throw new Error(`mutant ${name}: no ${from}`); used = true; return text.replace(from, to); } });
  check(`mutant "${name}" turns its check red`, used && test(mb.rom, mb.symbols));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
