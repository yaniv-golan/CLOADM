// Run: node tests/basic-fp.test.js [count]
//
// The clean-room BASIC's floating point (basic/fp.inc, basic/fpconv.inc) against the bit-exact model
// tests/basic/fpmodel.js, both written from the published description of the Microsoft Binary Format [MBF].
// The ROM is assembled at test time and its routines are called directly on the Dragon 64's CPU (a return
// address that lands on a trap, the operands written into FAC and ARG); no ROM of any kind is used.
//  * a hand-worked table: each expected packed value is worked out by hand from the format (comments), not by the
//    model: sums, products, quotients with exact and inexact results, rounding up, signs, the largest and smallest
//    numbers, overflow (?OV ERROR), underflow to 0, division by 0 (?/0 ERROR);
//  * the constants: 0.5 and the powers of ten 10^0-10^17 are the exact values rounded to nearest (BigInt);
//  * thousands of random operand pairs: add, subtract, multiply, divide, compare, each result bit for bit (FAC's
//    exponent, mantissa, guard byte and sign) as the model gives it, including which ones overflow;
//  * conversions: integers to FAC (I32FLT, GIVABF), QINT, FOUT's text for hand-worked values and random ones, FIN's
//    value for hand-worked texts and random ones, and a printed number read back, each exactly as the model of one
//    rounded step of ten a place (finTen) gives it.
const { buildBasic } = require('../tools/build-basic.js');
const F = require('./basic/fpmodel.js');
const { Emu } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else if (!quiet) console.log(`ok   ${name} ${detail}`); };
let quiet = false;
const COUNT = Number(process.argv[2]) || 3000;

const { rom, symbols } = buildBasic();
const sym = (s) => { const v = symbols.get(s); if (v == null) throw new Error(`no symbol ${s}`); return v; };
const m = Emu.createMachine('dragon64');
m.setRoms({ basic: rom, basic64: null });
m.reset(true);
for (let i = 0; i < 20; i++) m.runFrame();     // cold start: the PIAs and the direct page set up
const cpu = m.cpu, ram = m.ram;
const TRAP = 0x3000;
ram[TRAP] = 0x20; ram[TRAP + 1] = 0xFE;          // BRA *
const STOPS = new Map([[TRAP, 'ok'], [sym('OVERR'), 'OV'], [sym('DZERR'), '/0'], [sym('FCERR'), 'FC']]);
// call a ROM routine: returns 'ok' or the error it reached
function call(name) {
  cpu.s = 0x7E00;
  cpu.s -= 2; ram[cpu.s] = TRAP >> 8; ram[cpu.s + 1] = TRAP & 0xFF;
  cpu.cc |= 0x50;
  cpu.dp = 0;
  cpu.jump(sym(name));
  for (let i = 0; i < 200000; i++) {
    const stop = STOPS.get(cpu.pc);
    if (stop) return stop;
    cpu.step();
  }
  throw new Error(`${name} did not return`);
}
const FAC = sym('FACEXP'), ARG = sym('ARGEXP');
// write an unpacked model value into FAC or ARG
function put(at, v) {
  ram[at] = v.e;
  const mm = Number(v.m);
  ram[at + 1] = (mm >>> 24) & 0xFF; ram[at + 2] = (mm >>> 16) & 0xFF; ram[at + 3] = (mm >>> 8) & 0xFF; ram[at + 4] = mm & 0xFF;
  ram[at + 5] = v.x; ram[at + 6] = v.s ? 0xFF : 0;
}
const get = (at) => ({ e: ram[at], m: BigInt(((ram[at + 1] << 24) | (ram[at + 2] << 16) | (ram[at + 3] << 8) | ram[at + 4]) >>> 0), x: ram[at + 5], s: ram[at + 6] === 0xFF });
const show = (v) => (v.e === 0 ? '0' : `${v.s ? '-' : '+'}e${v.e.toString(16)} m${v.m.toString(16)} x${v.x.toString(16)}`);
const same = (a, b) => (a.e === 0 && b.e === 0) || (a.e === b.e && a.m === b.m && a.x === b.x && a.s === b.s);
const hex = (b) => (Array.isArray(b) ? b.map((x) => x.toString(16).padStart(2, '0')).join(' ') : String(b));   // (an error's name as it is)
// the model's result for an operation, or the error it raises
const model = (fn) => { try { return { r: fn() }; } catch (e) { if (e instanceof F.OV) return { err: 'OV' }; if (e instanceof F.DZ) return { err: '/0' }; throw e; } };
// a ROM binary operation on packed operands a (ARG) and b (FAC): { err } or { r (FAC unpacked), packed }
function rom2(op, a, b) {
  put(ARG, F.unpack(a)); put(FAC, F.unpack(b));
  const st = call(op);
  if (st !== 'ok') return { err: st };
  const r = get(FAC);
  put(TRAP + 0x100, r);
  ram[0x3200] = 0;
  return { r };
}
// pack FAC through the ROM's own MOVMF
function romPack(v) {
  put(FAC, v);
  cpu.x = 0x3300;
  call('MOVMF');
  return Array.from(ram.slice(0x3300, 0x3305));
}

// ---- hand-worked table: packed [E, M1 (sign in bit 7), M2, M3, M4]; value = 0.1mmm (binary) x 2^(E-128) ----
const P = {
  one: [0x81, 0x00, 0, 0, 0],            // 1 = 0.1b x 2^1
  two: [0x82, 0x00, 0, 0, 0],            // 2 = 0.1b x 2^2
  three: [0x82, 0x40, 0, 0, 0],          // 3 = 0.11b x 2^2
  half: [0x80, 0x00, 0, 0, 0],           // 0.5
  quarter: [0x7F, 0x00, 0, 0, 0],        // 0.25
  minus5: [0x83, 0xA0, 0, 0, 0],             // -5 = -0.101b x 2^3
  ten: [0x84, 0x20, 0, 0, 0],            // 10 = 0.1010b x 2^4
  four: [0x83, 0x00, 0, 0, 0],           // 4
  max: [0xFF, 0x7F, 0xFF, 0xFF, 0xFF],   // the largest number
  min: [0x01, 0x00, 0, 0, 0],            // the smallest: 0.5 x 2^-127
  zero: [0, 0, 0, 0, 0],
};
const HAND = [
  ['FADD', P.one, P.one, [0x82, 0, 0, 0, 0]],                 // 1 + 1 = 2
  ['FADD', P.half, P.quarter, [0x80, 0x40, 0, 0, 0]],         // .5 + .25 = .75 = 0.11b x 2^0
  ['FADD', P.minus5, P.three, [0x82, 0x80, 0, 0, 0]],             // -5 + 3 = -2
  ['FADD', P.three, P.minus5, [0x82, 0x80, 0, 0, 0]],             // 3 + -5 = -2
  ['FADD', P.three, [0x82, 0xC0, 0, 0, 0], P.zero],           // 3 + -3 = 0
  ['FSUB', P.one, P.ten, [0x84, 0x90, 0, 0, 0]],              // 1 - 10 = -9 = -0.1001b x 2^4
  ['FADD', P.max, P.max, 'OV'],                               // largest + largest overflows
  ['FMUL', P.three, P.half, [0x81, 0x40, 0, 0, 0]],           // 3 x .5 = 1.5
  ['FMUL', P.minus5, P.minus5, [0x85, 0x48, 0, 0, 0]],                // -5 x -5 = 25 = 0.11001b x 2^5
  ['FMUL', P.max, P.two, 'OV'],                               // largest x 2 overflows
  ['FMUL', P.min, P.half, P.zero],                            // smallest x .5 underflows to 0
  ['FMUL', P.zero, P.minus5, [0, 0x20, 0, 0, 0]],              // 0 x -5 = 0, FAC's mantissa kept (5's, sign cleared)
  ['FDIV', P.one, P.three, [0x7F, 0x2A, 0xAA, 0xAA, 0xAB]],   // 1/3 = 0.1010...b x 2^-1: $AAAAAAAA, guard $AA rounds up
  ['FDIV', P.two, P.three, [0x80, 0x2A, 0xAA, 0xAA, 0xAB]],   // 2/3 = 0.1010...b x 2^0
  ['FDIV', P.ten, P.four, [0x82, 0x20, 0, 0, 0]],             // 10/4 = 2.5 = 0.101b x 2^2
  ['FDIV', P.minus5, P.ten, [0x80, 0x80, 0, 0, 0]],               // -5/10 = -.5
  ['FDIV', P.one, P.zero, '/0'],
  ['FDIV', P.zero, P.three, [0, 0x40, 0, 0, 0]],              // 0 / 3 = 0 with 3's mantissa, as the original's 0 / 10
  //                                                            is stored 0,32,0,0,0 [BB bb10 num-literal-bytes: 1E-40]
  ['FDIV', P.min, P.ten, [0, 0x20, 0, 0, 0]],                  // 2^-128 / 10: exponent 1 - 132 + 128 below 0, 0 at once
  //                                                            with the divisor's mantissa [BB bb10: 1E-39 likewise]
  ['FDIV', [0x04, 0x1D, 0xC8, 0x27, 0x0C], P.ten, [0, 0x7C, 0x73, 0x71, 0xAC]],   // exponent 0: 0 with the quotient's
  //                                                            mantissa, cut to 32 bits (hand: 0x9DC8270C / 0xA0000000
  //                                                            = 0.FC7371AC... in hex)
  ['FDIV', P.max, P.half, 'OV'],                              // largest / .5 overflows
];
for (const [op, a, b, want] of HAND) {
  const r = rom2(op, a, b);
  const got = r.err || hex(romPack(r.r));
  check(`hand: ${op} ${hex(a)} , ${hex(b)}`, got === (typeof want === 'string' ? want : hex(want)), `-> ${got}`);
  const mo = model(() => F.pack(({ FADD: F.add, FSUB: F.sub, FMUL: F.mul, FDIV: F.div })[op](F.unpack(a), F.unpack(b))));
  check(`hand: the model agrees: ${op}`, (mo.err || hex(mo.r)) === got, mo.err || hex(mo.r));
}

// ---- constants: exact values rounded to nearest ----
function exactPacked(num, den = 1n) {            // num/den > 0, rounded to nearest, ties up
  let e = 128, v = num, d = den;
  while (v >= d) { d *= 2n; e++; }
  while (v * 2n < d) { v *= 2n; e--; }
  let m = (v << 33n) / d;                          // 33 bits: 32 and one more to round
  m = (m + 1n) >> 1n;
  if (m >= 1n << 32n) { m >>= 1n; e++; }
  const k = Number(m);
  return [e, (k >>> 24) & 0x7F, (k >>> 16) & 0xFF, (k >>> 8) & 0xFF, k & 0xFF];
}
const romBytes = (at, len) => Array.from(rom.slice(at - 0x8000, at - 0x8000 + len));
check('constant 0.5', hex(romBytes(sym('FPHALF'), 5)) === hex(exactPacked(1n, 2n)));
for (let k = 0; k <= 17; k++) {
  const got = romBytes(sym('POWTAB') + 5 * k, 5);
  check(`constant 10^${k}`, hex(got) === hex(exactPacked(10n ** BigInt(k))) && hex(got) === hex(F.POWBYTES[k]), hex(got));
}

// ---- random operands against the model ----
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed; };
const rndPacked = (spread) => {
  if (rnd() % 23 === 0) return [0, 0, 0, 0, 0];
  const e = Math.max(1, Math.min(255, 128 + (rnd() % (2 * spread + 1)) - spread));
  const b = [e, rnd() & 0xFF, rnd() & 0xFF, rnd() & 0xFF, rnd() & 0xFF];
  if (rnd() % 7 === 0) { b[3] = 0; b[4] = 0; }   // short mantissas: exact results and ties
  return b;
};
const OPS = { FADD: F.add, FSUB: F.sub, FMUL: F.mul, FDIV: F.div };
quiet = true;
const bad = {};
for (const op of Object.keys(OPS)) {
  let mism = 0, errs = 0;
  for (let i = 0; i < COUNT; i++) {
    const spread = i % 3 === 0 ? 130 : i % 3 === 1 ? 40 : 4;
    const a = rndPacked(spread), b = rndPacked(op === 'FADD' || op === 'FSUB' ? spread : spread);
    // FAC as an unrounded result sometimes: a guard byte to round first
    const fb = F.unpack(b);
    if (fb.e && rnd() % 4 === 0) fb.x = rnd() & 0xFF;
    put(ARG, F.unpack(a)); put(FAC, fb);
    const st = call(op);
    const mo = model(() => OPS[op](F.unpack(a), fb));
    const ok = st === 'ok' ? !mo.err && same(get(FAC), mo.r) : mo.err === st;
    if (st !== 'ok') errs++;
    if (!ok) { mism++; if (!bad[op]) bad[op] = `${hex(a)} , ${hex(b)} x${fb.x}: rom ${st === 'ok' ? show(get(FAC)) : st} model ${mo.err || show(mo.r)}`; }
  }
  quiet = false;
  check(`random ${op}: ${COUNT} operand pairs bit for bit (${errs} overflow or /0)`, mism === 0, bad[op] || '');
  quiet = true;
}
{
  let mism = 0, first = '';
  for (let i = 0; i < COUNT; i++) {
    const a = rndPacked(i % 2 ? 3 : 100), b = i % 5 === 0 ? a.slice() : rndPacked(i % 2 ? 3 : 100);
    const fb = F.unpack(b);
    if (fb.e && rnd() % 4 === 0) fb.x = rnd() & 0xFF;
    put(ARG, F.unpack(a)); put(FAC, fb);
    call('FCMP');
    const got = (cpu.a << 24) >> 24, want = F.cmp(F.unpack(a), fb);
    if (got !== want) { mism++; if (!first) first = `${hex(a)} , ${hex(b)}: rom ${got} model ${want}`; }
  }
  quiet = false;
  check(`random FCMP: ${COUNT} pairs`, mism === 0, first);
}
{
  // NXCMP, NEXT's compare: the limit packed at X against the loop variable in FAC (just stored, so rounded). Its
  // answer (A) must be FCMP's for every pair: one sign or two, zeros, equal values, values that differ only in a
  // low mantissa byte or only in the sign.
  let mism = 0, first = '';
  for (let i = 0; i < COUNT; i++) {
    const a = rndPacked(i % 2 ? 3 : 100);
    let b = i % 5 === 0 ? a.slice() : rndPacked(i % 2 ? 3 : 100);
    if (i % 7 === 1) { b = a.slice(); b[4 - (i % 3)] ^= 1 << (rnd() & 7); }
    if (i % 11 === 2) { b = a.slice(); b[1] ^= 0x80; }
    for (let k = 0; k < 5; k++) ram[0x3300 + k] = a[k];
    put(FAC, F.unpack(b));
    cpu.x = 0x3300;
    call('NXCMP');
    const got = (cpu.a << 24) >> 24, want = F.cmp(F.unpack(a), F.unpack(b));
    if (got !== want) { mism++; if (!first) first = `${hex(a)} , ${hex(b)}: rom ${got} model ${want}`; }
  }
  check(`random NXCMP (NEXT's compare): ${COUNT} pairs, as FCMP`, mism === 0, first);
}
quiet = false;

// ---- conversions ----
function romFout(v) {
  put(FAC, v);
  call('FOUT');
  let s = '', at = cpu.x;
  while (ram[at]) s += String.fromCharCode(ram[at++]);
  return s;
}
function romFin(text) {
  const at = 0x3400;
  for (let i = 0; i < text.length; i++) ram[at + i] = text.charCodeAt(i);
  ram[at + text.length] = 0;
  const T = sym('TXTPTR');
  ram[T] = at >> 8; ram[T + 1] = at & 0xFF;
  const st = call('FIN');
  return { st, v: get(FAC), rest: (ram[T] << 8 | ram[T + 1]) - at };
}
for (const [d, want] of [[0, [0, 0, 0, 0, 0]], [1, P.one], [-5, P.minus5], [10, P.ten], [-32768, [0x90, 0x80, 0, 0, 0]], [32767, [0x8F, 0x7F, 0xFE, 0, 0]]]) {
  cpu.a = (d >> 8) & 0xFF; cpu.b = d & 0xFF;
  call('GIVABF');
  check(`GIVABF ${d}`, hex(romPack(get(FAC))) === hex(want), hex(romPack(get(FAC))));
}
for (const [u, want] of [[1, P.one], [1000000000, F.POWBYTES[9]], [0xFFFFFFFF, [0xA0, 0x7F, 0xFF, 0xFF, 0xFF]]]) {
  const fm = sym('FACM');
  ram[fm] = u >>> 24; ram[fm + 1] = (u >>> 16) & 0xFF; ram[fm + 2] = (u >>> 8) & 0xFF; ram[fm + 3] = u & 0xFF;
  call('I32FLT');
  check(`I32FLT ${u}`, hex(romPack(get(FAC))) === hex(want), hex(romPack(get(FAC))));
}
for (const [packed, want] of [[P.three, 3], [[0x82, 0x60, 0, 0, 0], 3], [P.half, 0], [[0x9E, 0x6E, 0x6B, 0x28, 0], 1000000000], [P.minus5, 5]]) {
  put(FAC, F.unpack(packed));
  call('QINT');
  const fm = sym('FACM'), got = ((ram[fm] << 24) | (ram[fm + 1] << 16) | (ram[fm + 2] << 8) | ram[fm + 3]) >>> 0;
  check(`QINT ${hex(packed)}`, got === want, String(got));
}
// FOUT: hand-worked texts (nine significant digits, rounded; fixed point from .01 to below 1E9)
const FOUTS = [
  [P.zero, ' 0'], [P.one, ' 1'], [[0x81, 0x80, 0, 0, 0], '-1'], [P.half, ' .5'], [[0x7F, 0x80, 0, 0, 0], '-.25'],
  [P.ten, ' 10'], [[0x81, 0x40, 0, 0, 0], ' 1.5'], [F.POWBYTES[9], ' 1E+09'], [F.POWBYTES[8], ' 100000000'],
  [[0x7F, 0x2A, 0xAA, 0xAA, 0xAB], ' .333333333'], [[0x80, 0x2A, 0xAA, 0xAA, 0xAB], ' .666666667'],
  [exactPacked(1n, 100n), ' .01'], [exactPacked(1n, 1000n), ' 1E-03'], [exactPacked(123456789n), ' 123456789'],
  [exactPacked(1234567891n), ' 1.23456789E+09'], [exactPacked(15n, 10n), ' 1.5'], [exactPacked(1n, 10n ** 10n), ' 1E-10'],
  [P.max, ' 1.70141183E+38'], [P.min, ' 2.93873588E-39'], [exactPacked(314159265n, 100000000n), ' 3.14159265'],
];
for (const [packed, want] of FOUTS) {
  const got = romFout(F.unpack(packed));
  check(`FOUT ${hex(packed)}`, got === want && F.fout(F.unpack(packed)) === want, `${JSON.stringify(got)} model ${JSON.stringify(F.fout(F.unpack(packed)))}`);
}
// the original's printing of numbers from 1E17 up, bytes and text [BB bb10 num-print-big; bb9 rnd-args: seed 3's
// RND(1E38), 254,112,189,194,29, is 8E+37]: one quotient by 10 at a time from 1E9 up, each rounded (the old steps of
// 1E9 from 1E17 printed 8E37's bytes as 8.00000001E+37 and 9.99999999E17's as 1E+18)
for (const [packed, want] of [[[185, 49, 162, 188, 47], ' 1E+17'], [[186, 5, 58, 13, 35], ' 1.5E+17'], [[188, 94, 11, 107, 58], ' 9.99999999E+17'], [[188, 94, 11, 107, 59], ' 1E+18'], [[189, 9, 16, 135, 165], ' 1.23456789E+18'], [[192, 10, 199, 35, 5], ' 1E+19'], [[194, 114, 220, 125, 72], ' 7E+19'], [[195, 45, 120, 235, 198], ' 1E+20'], [[212, 35, 100, 201, 131], ' 1.23456789E+25'], [[230, 23, 118, 23, 91], ' 3E+30'], [[245, 26, 19, 11, 152], ' 1E+35'], [[254, 82, 166, 9, 216], ' 7.00000001E+37'], [[254, 109, 187, 98, 229], ' 7.90000002E+37'], [[254, 112, 189, 194, 30], ' 8E+37'], [[254, 112, 189, 194, 35], ' 8.00000001E+37'], [[254, 127, 201, 158, 65], ' 8.50000001E+37'], [[255, 7, 106, 189, 49], ' 9.00000001E+37'], [[255, 22, 118, 153, 80], ' 1E+38'], [[255, 22, 118, 153, 83], ' 1E+38'], [[255, 97, 177, 229, 253], ' 1.5E+38'], [[255, 127, 201, 158, 65], ' 1.7E+38'], [[254, 240, 189, 194, 30], '-8E+37'], [[187, 5, 58, 13, 35], ' 3E+17'], [[189, 0, 0, 0, 0], ' 1.15292151E+18'], [[195, 0, 0, 0, 44], ' 7.37869779E+19'], [[255, 0, 0, 0, 44], ' 8.50705935E+37'], [[254, 112, 189, 194, 29], ' 8E+37']]) {
  const got = romFout(F.unpack(packed));
  check(`FOUT ${hex(packed)} is the original's ${JSON.stringify(want)} [BB bb10]`, got === want && F.fout(F.unpack(packed)) === want, `${JSON.stringify(got)} model ${JSON.stringify(F.fout(F.unpack(packed)))}`);
}
quiet = true;
{
  let mism = 0, first = '';
  for (let i = 0; i < COUNT / 3; i++) {
    const v = F.unpack(rndPacked(i % 2 ? 140 : 30));
    const got = romFout(v), want = F.fout(v);
    if (got !== want) { mism++; if (!first) first = `${show(v)}: rom ${got} model ${want}`; }
  }
  quiet = false;
  check(`random FOUT: ${Math.floor(COUNT / 3)} numbers as the model prints them`, mism === 0, first);
}
// FIN: hand-worked values
const FINS = [
  ['1', P.one, 1], ['10', P.ten, 2], ['.5', P.half, 2], ['-5', P.minus5, 2], ['1E1', P.ten, 3], ['100E-1', P.ten, 6],
  ['0.25', exactPacked(1n, 4n), 4], ['1 0', P.ten, 3], ['1000000000', F.POWBYTES[9], 10], ['12345678912', exactPacked(12345678910n), 11], ['4294967296', exactPacked(4294967296n), 10], ['42949672951', exactPacked(42949672951n), 11],
  // the first digit past 32 bits is kept, then the whole rounded: 2^32 exactly, as the original reads it [BB bb9
  // rnd-args]; 2^32 + 1 is a tie (up); a tenth digit after the point (2^32 / 10, one rounding); an eleventh only a
  // place: 12345678901 rounded to 32 bits (12345678900), x 10
  ['4294967297', exactPacked(4294967298n), 10], ['42949672959', exactPacked(42949672959n), 11],
  ['429496729.6', exactPacked(4294967296n, 10n), 11], ['123456789012', exactPacked(123456789000n), 12],
  ['3:', P.three, 1], ['1E', P.one, 2], ['1.5.5', exactPacked(3n, 2n), 3], ['0', P.zero, 1],
];
quiet = false;
for (const [text, want, len] of FINS) {
  const r = romFin(text);
  const got = hex(romPack(r.v));
  check(`FIN ${JSON.stringify(text)}`, r.st === 'ok' && got === hex(want) && got === hex(F.finTen(text)) && r.rest === len, `${got} (${r.rest} characters), steps-of-ten model ${hex(F.finTen(text))}`);
}
check('FIN 1E39 overflows', romFin('1E39').st === 'OV' && F.finTen('1E39') === 'OV');
check('FIN 1E-50 is 0', romFin('1E-50').v.e === 0 && F.finTen('1E-50')[0] === 0);
// below the smallest number: 0, stored with a mantissa [BB bb10 num-literal-bytes]
for (const [text, want] of [['2.9E-39', [0, 124, 160, 41, 60]], ['1E-39', [0, 32, 0, 0, 0]], ['1E-40', [0, 32, 0, 0, 0]], ['-0', [0, 0, 0, 0, 0]], ['5E-39', [1, 89, 199, 220, 238]], ['1.70141183E38', [255, 127, 255, 255, 248]]]) {
  const r = romFin(text), got = hex(romPack(r.v));
  check(`FIN ${text} is stored as the original's ${hex(want)} [BB bb10]`, r.st === 'ok' && got === hex(want) && hex(F.finTen(text)) === hex(want), `${got}, steps-of-ten model ${hex(F.finTen(text))}`);
}
check('FIN 1.7014119E38 overflows [BB bb10]', romFin('1.7014119E38').st === 'OV' && F.finTen('1.7014119E38') === 'OV');
// the original's readings, from what RND made of them [BB bb9 rnd-args: RND(1E38) from 9 seeds fits only $96769953;
// rnd-neg: the seed RND(-x) leaves is a step from x's mantissa]: one or two units above the nearest, as one rounded
// product or quotient by 10 a place gives
for (const [text, want] of [['1E38', [0xFF, 0x16, 0x76, 0x99, 0x53]], ['1E30', [0xE4, 0x49, 0xF2, 0xC9, 0xCF]], ['1E-30', [0x1D, 0x22, 0x42, 0x5F, 0xF8]],
  ['1.00000001', [0x81, 0x00, 0x00, 0x00, 0x16]], ['.999999999', [0x80, 0x7F, 0xFF, 0xFF, 0xFD]]]) {
  const r = romFin(text), got = hex(romPack(r.v));
  check(`FIN ${text} is the original's ${hex(want)} [BB bb9]`, r.st === 'ok' && got === hex(want) && hex(F.finTen(text)) === hex(want), `${got}, steps-of-ten model ${hex(F.finTen(text))}`);
}
quiet = true;
{
  let mism = 0, ten = 0, trip = 0, first = '', firstTen = '', firstTrip = '';
  for (let i = 0; i < COUNT / 3; i++) {
    const digits = String(rnd() % 1000000000).replace(/^0+/, '') || '0';
    const dot = rnd() % (digits.length + 1), e = (rnd() % 60) - 30;
    let text = digits.slice(0, dot) + (dot < digits.length ? '.' + digits.slice(dot) : '') + (i % 2 ? `E${e}` : '');
    if (i % 3 === 0) text = '-' + text;
    const r = romFin(text);
    const mo = model(() => F.fin(text).value);
    const ok = r.st === 'ok' ? !mo.err && same(r.v, mo.r) : mo.err === r.st;
    if (!ok) { mism++; if (!first) first = `${text}: rom ${r.st === 'ok' ? show(r.v) : r.st} model ${mo.err || show(mo.r)}`; }
    // the five bytes, as the steps-of-ten model (written from the rule, not the routines) reads the text
    const want = F.finTen(text), got = r.st === 'ok' ? romPack(r.v) : r.st;
    if (hex(got) !== hex(want)) { ten++; if (!firstTen) firstTen = `${text}: rom ${hex(got)} model ${hex(want)}`; }
    // what PRINT shows, read back in: exactly the bytes the steps-of-ten model reads from that text, and printed
    // again, what the model prints for them. This check was "moves by at most one in the ninth digit", an assumption
    // of ours: the original reads by one rounded step of 10 a place [BB bb9 rnd-args, rnd-neg], so a number whose
    // reading takes 15 steps or more can come back two away; it is now held to the model, exactly
    if (r.st === 'ok' && !mo.err) {
      const back = romFout(r.v), rb = romFin(back.trim()), wantBack = F.finTen(back.trim());
      const again = romFout(rb.v), wantAgain = Array.isArray(wantBack) ? F.fout(F.unpack(wantBack)) : wantBack;
      if (rb.st !== 'ok' || hex(romPack(rb.v)) !== hex(wantBack) || again !== wantAgain) { trip++; if (!firstTrip) firstTrip = `${text} -> ${back} -> rom ${hex(romPack(rb.v))} ${again}, model ${hex(wantBack)} ${wantAgain}`; }
    }
  }
  quiet = false;
  check(`random FIN: ${Math.floor(COUNT / 3)} texts as the model reads them`, mism === 0, first);
  check(`random FIN: ${Math.floor(COUNT / 3)} texts, the five bytes as the steps-of-ten model reads them`, ten === 0, `${ten} differ, first ${firstTen}`);
  check('a number printed and read back: the bytes the steps-of-ten model reads from the printed text, and printed again as the model prints them', trip === 0, `${trip} differ, first ${firstTrip}`);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
