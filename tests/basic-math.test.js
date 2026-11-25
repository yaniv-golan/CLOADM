// Run: node tests/basic-math.test.js [count]
//
// The clean-room BASIC's numeric functions (basic/mathfn.inc) against the exact values: each routine is called on
// the Dragon 64's CPU (as in tests/basic-fp.test.js) with a packed argument, and the packed result is compared
// with JavaScript's Math on that same argument's exact value. Our approximations are our own (Taylor series after
// a reduction, LOG and EXP's in base 2 as the original's), so the oracle is the mathematical value, not another
// BASIC; the tolerances say how close they come, as a multiple of the 5-byte format's unit in the last place (2^-31 relative), and are the
// project's accuracy claim for these functions. Also: exact results where the format can hold them (SQR of
// squares, whole powers, INT and FIX), the error cases (?FC ERROR, ?OV ERROR, ?/0 ERROR), RND's generator against
// its formula, and the constants of tools/basic-consts.js against Math.
const { buildBasic } = require('../tools/build-basic.js');
const F = require('./basic/fpmodel.js');
const { Emu } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const COUNT = Number(process.argv[2]) || 600;

const { rom, symbols } = buildBasic();
const sym = (s) => { const v = symbols.get(s); if (v == null) throw new Error(`no symbol ${s}`); return v; };
const m = Emu.createMachine('dragon64');
m.setRoms({ basic: rom, basic64: null });
m.reset(true);
for (let i = 0; i < 20; i++) m.runFrame();
const cpu = m.cpu, ram = m.ram, TRAP = 0x3000;
ram[TRAP] = 0x20; ram[TRAP + 1] = 0xFE;
const STOPS = new Map([[TRAP, 'ok'], [sym('OVERR'), 'OV'], [sym('DZERR'), '/0'], [sym('FCERR'), 'FC']]);
function call(name) {
  cpu.s = 0x7E00; cpu.s -= 2; ram[cpu.s] = TRAP >> 8; ram[cpu.s + 1] = TRAP & 0xFF;
  cpu.cc |= 0x50; cpu.dp = 0; cpu.jump(sym(name));
  for (let i = 0; i < 2000000; i++) { const st = STOPS.get(cpu.pc); if (st) return st; cpu.step(); }
  throw new Error(`${name} did not return`);
}
const FAC = sym('FACEXP'), ARG = sym('ARGEXP');
function put(at, v) {
  ram[at] = v.e; const mm = Number(v.m);
  ram[at + 1] = (mm >>> 24) & 0xFF; ram[at + 2] = (mm >>> 16) & 0xFF; ram[at + 3] = (mm >>> 8) & 0xFF; ram[at + 4] = mm & 0xFF;
  ram[at + 5] = v.x; ram[at + 6] = v.s ? 0xFF : 0;
}
const get = (at) => F.round({ e: ram[at], m: BigInt(((ram[at + 1] << 24) | (ram[at + 2] << 16) | (ram[at + 3] << 8) | ram[at + 4]) >>> 0), x: ram[at + 5], s: ram[at + 6] === 0xFF });
const num = (v) => F.toNumber(v);
const packedOf = (x) => F.round(F.fromNumber(x));      // the format's nearest-below-ish number to x (40 bits, rounded)
// a function on the ROM: { st, v } for a packed argument value a (and b for ^)
function rom1(name, a, b) {
  if (b !== undefined) { put(ARG, a); put(FAC, b); } else put(FAC, a);
  const st = call(name);
  return { st, v: st === 'ok' ? num(get(FAC)) : null };
}
const ULP = 2 ** -31;
// error in units of the result's last place (relative), or absolute for results near 0 (scale given)
function err(got, want, absScale = 0) {
  const denom = Math.max(Math.abs(want), absScale);
  return denom === 0 ? (got === 0 ? 0 : Infinity) : Math.abs(got - want) / denom / ULP;
}
let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x80000000; };

// tol: units in the last place, or [units, more, what]: units + more(x) for the argument x, more described by what
// (EXP's error grows with its argument, below)
function sweep(name, fnName, argGen, exact, { tol, absScale = 0 }) {
  const [t0, more, what] = Array.isArray(tol) ? tol : [tol, () => 0, ''];
  let worst = 0, at = null, bad = null;
  for (let i = 0; i < COUNT; i++) {
    const a = packedOf(argGen(i));
    const r = rom1(fnName, a);
    if (r.st !== 'ok') { bad = bad || `${num(a)}: ${r.st}`; continue; }
    const e = err(r.v, exact(num(a)), absScale) - more(num(a));
    if (e > worst) { worst = e; at = num(a); }
  }
  check(`${name}: ${COUNT} arguments within ${t0}${what ? ` + ${what}` : ''} units in the last place`, !bad && worst <= t0, `worst ${worst.toFixed(2)}${what ? ` beyond ${what}` : ''} at ${at}${bad ? `; ${bad}` : ''}`);
}
// SQR is x^.5, EXP(.5 LOG x) [BB bb1 fn-math: the original's SQR(1E10) is 99999.9999]: .5 LOG x, up to 23 here, is
// rounded to 32 bits (up to 2^-28 absolute, 8 units of the result's last place), plus EXP's own (below) for .5 LOG x
sweep('SQR', 'FSQR', (i) => 10 ** (rnd() * 40 - 20), Math.sqrt, { tol: [10, (x) => Math.abs(Math.log(x) / 2), '|.5 LOG x|'] });
sweep('LOG', 'FLOG', (i) => 10 ** (rnd() * 60 - 30), Math.log, { tol: 2, absScale: 1 });
sweep('LOG near 1', 'FLOG', (i) => 0.5 + rnd(), Math.log, { tol: 3, absScale: 0.05 });
// EXP works in base 2 as the original does [BB bb2 fn-sqr-bits]: t = x / ln 2 rounded to 32 bits is off by up to
// |t| 2^-32, and 1/ln 2's own rounding adds as much again, so e^x is off by up to ln 2 |t| 2^-31 = |x| units, plus
// the series' 3
sweep('EXP', 'FEXP', (i) => rnd() * 170 - 85, Math.exp, { tol: [3, Math.abs, '|x|'] });
sweep('SIN', 'FSIN', (i) => rnd() * 200 - 100, Math.sin, { tol: 2, absScale: 1 });
sweep('COS', 'FCOS', (i) => rnd() * 200 - 100, Math.cos, { tol: 2, absScale: 1 });
sweep('SIN of small arguments', 'FSIN', (i) => (rnd() - 0.5) * 1e-3, Math.sin, { tol: 2 });
sweep('ATN', 'FATN', (i) => Math.tan((rnd() - 0.5) * 3.1), Math.atan, { tol: 4 });
{
  let worst = 0, at = null, bad = null;
  for (let i = 0; i < COUNT / 2; i++) {
    const a = packedOf(0.01 + rnd() * 100), b = packedOf((rnd() - 0.5) * 20);
    const r = rom1('FPOWER', a, b);
    if (r.st !== 'ok') { bad = bad || `${num(a)}^${num(b)}: ${r.st}`; continue; }
    const want = num(a) ** num(b), e = err(r.v, want);
    if (e > worst) { worst = e; at = `${num(a)}^${num(b)}`; }
  }
  check(`^: ${COUNT / 2} pairs within 64 units in the last place (EXP(b LOG a) magnifies LOG's error by b ln a)`, !bad && worst <= 64, `worst ${worst.toFixed(2)} at ${at}${bad ? `; ${bad}` : ''}`);
}
// exact cases
const ex = (name, fnName, a, want, b) => { const r = rom1(fnName, packedOf(a), b === undefined ? undefined : packedOf(b)); check(`${name}`, r.st === 'ok' && r.v === want, `${r.st} ${r.v}`); };
for (const k of [1, 4, 9, 16, 0.25, 0.0625]) ex(`SQR(${k}) is exact`, 'FSQR', k, Math.sqrt(k));
{
  const r = rom1('FSQR', packedOf(1e10));
  check('SQR(1E10) is not exact: below 100000 by under 5E-9 of it [BB bb1 fn-math]', r.st === 'ok' && r.v < 1e5 && r.v > 1e5 * (1 - 5e-9), `${r.v}`);
  let same = true, at = '';
  for (let i = 0; i < 40 && same; i++) {
    const a = packedOf(10 ** (rnd() * 40 - 20)), s = rom1('FSQR', a), p = rom1('FPOWER', a, packedOf(0.5));
    if (s.v !== p.v) { same = false; at = `${num(a)}: ${s.v} ${p.v}`; }
  }
  check('SQR(x) is x^.5 [BB bb1 fn-math]', same, at);
}
// the original's own values, bit for bit [BB bb2 fn-sqr-bits]
ex('SQR(1E10) is 100000 - 6 x 2^-15 [BB bb2]', 'FSQR', 1e10, 1e5 - 6 * 2 ** -15);
ex('SQR(144) is 12 - 3 x 2^-28 [BB bb2]', 'FSQR', 144, 12 - 3 * 2 ** -28);
ex('SQR(65536) is 256 [BB bb2]', 'FSQR', 65536, 256);
ex('EXP(11.5129255) is 100000 + 113 x 2^-15 [BB bb2]', 'FEXP', 11.5129255, 1e5 + 113 * 2 ** -15);
ex('SQR(0) = 0', 'FSQR', 0, 0);
ex('LOG(1) = 0', 'FLOG', 1, 0);
ex('EXP(0) = 1', 'FEXP', 0, 1);
ex('SIN(0) = 0', 'FSIN', 0, 0);
ex('COS(0) = 1', 'FCOS', 0, 1);
ex('ATN(0) = 0', 'FATN', 0, 0);
ex('2^10 = 1024', 'FPOWER', 2, 1024, 10);
ex('(-2)^3 = -8', 'FPOWER', -2, -8, 3);
ex('10^-2 by whole powers: 1/100 rounded once', 'FPOWER', 10, num(F.round(F.div(F.unpack([0x81, 0, 0, 0, 0]), F.unpack([0x87, 0x48, 0, 0, 0])))), -2);
ex('0^0 = 1', 'FPOWER', 0, 1, 0);
ex('0^2 = 0', 'FPOWER', 0, 0, 2);
ex('3^0 = 1', 'FPOWER', 3, 1, 0);
for (const [x, i, f] of [[3.7, 3, 3], [-3.7, -4, -3], [-3, -3, -3], [0.5, 0, 0], [-0.5, -1, 0], [123456.75, 123456, 123456], [-1e-30, -1, 0], [1e20, 1e20, 1e20]]) {
  const a = packedOf(x);
  const ri = rom1('FINT', a), rf = rom1('FTRUNC', a);
  check(`INT(${x}) = ${i}, FIX(${x}) = ${f}`, ri.v === num(packedOf(i)) && rf.v === num(packedOf(f)), `${ri.v} ${rf.v}`);
}
// errors
const errOf = (fnName, a, b) => rom1(fnName, packedOf(a), b === undefined ? undefined : packedOf(b)).st;
check('SQR(-1) is ?FC ERROR', errOf('FSQR', -1) === 'FC');
check('LOG(0) and LOG(-1) are ?FC ERROR', errOf('FLOG', 0) === 'FC' && errOf('FLOG', -1) === 'FC');
check('EXP(89) is ?OV ERROR', errOf('FEXP', 89) === 'OV');
check('EXP(-90) is 0', rom1('FEXP', packedOf(-90)).v === 0);
check('EXP(-89) is 0 (its power of 2, -129, is below a byte\'s)', rom1('FEXP', packedOf(-89)).v === 0);
check('EXP(-88.7) is e^-88.7, near the smallest number', Math.abs(rom1('FEXP', packedOf(-88.7)).v / Math.exp(-88.7) - 1) < 1e-7);
check('(-8)^(1/3) is ?FC ERROR', errOf('FPOWER', -8, 1 / 3) === 'FC');
check('0^-1 is ?/0 ERROR', errOf('FPOWER', 0, -1) === '/0');
check('2^200 is ?OV ERROR', errOf('FPOWER', 2, 200) === 'OV');
// RND: the generator's formula, from the seed in RAM
{
  const SEED = sym('SEED');
  const seedOf = () => (ram[SEED] | (ram[SEED + 1] << 8) | (ram[SEED + 2] << 16) | (ram[SEED + 3] << 24)) >>> 0;
  ram[SEED] = 0x78; ram[SEED + 1] = 0x56; ram[SEED + 2] = 0x34; ram[SEED + 3] = 0x12;
  let s = 0x12345678, ok = true, detail = '';
  for (let i = 0; i < 50; i++) {
    // RND(0) through the function's body: FAC holds the argument when RN1 is reached
    put(FAC, F.ZERO());
    call('RN1');
    s = Number((BigInt(s) * 1664525n + 1013904223n) & 0xFFFFFFFFn);
    const want = s / 2 ** 32, got = num(get(FAC));
    if (seedOf() !== s || Math.abs(got - want) > 2 ** -32) { ok = false; detail = `step ${i}: seed ${seedOf().toString(16)} want ${s.toString(16)}, value ${got} want ${want}`; break; }
  }
  check('RND(0): seed x 1664525 + 1013904223 mod 2^32, as a fraction', ok, detail);
}
// the constants against Math (they are rounded to nearest from 36 digits, so within half a unit)
for (const [name, want] of [['PIO2', Math.PI / 2], ['TWOOPI', 2 / Math.PI], ['LN2', Math.LN2], ['INVLN2', 1 / Math.LN2], ['SQRT3', Math.sqrt(3)], ['PIO6', Math.PI / 6], ['SQRHLF', Math.SQRT1_2], ['TANP12', 2 - Math.sqrt(3)]]) {
  const at = sym(name) - 0x8000, v = num(F.unpack(Array.from(rom.slice(at, at + 5))));
  check(`constant ${name}`, err(v, want) <= 0.5, `${v}`);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
