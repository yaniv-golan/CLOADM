// Run: node tests/basic-math.test.js [count]
//
// The clean-room BASIC's numeric functions (basic/mathfn.inc) against the exact values: each routine is called on
// the Dragon 64's CPU (as in tests/basic-fp.test.js) with a packed argument, and the packed result is compared
// with JavaScript's Math on that same argument's exact value. Our approximations are our own (Taylor series after
// a reduction, LOG and EXP's in base 2 and SIN's in turns as the original's), so the oracle is the mathematical value, not another
// BASIC; the tolerances say how close they come, as a multiple of the 5-byte format's unit in the last place (2^-31 relative), and are the
// project's accuracy claim for these functions. Also: exact results where the format can hold them (SQR of
// squares, whole powers, INT and FIX), the error cases (?FC ERROR, ?OV ERROR, ?/0 ERROR), and the constants of
// tools/basic-consts.js against Math. (RND: tests/basic-rnd.test.js.)
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
// LOG near 1: the reduction's - 1/2 cancels there, as the original's does (its LOG(1.1) is 27 units from the nearest,
// its LOG(.5) and LOG(2) one unit either side of ln 2) [BB bb10 fn-last-bit], so the bound that was here (3 units)
// is not the oracle: the ROM is held to the model of its steps (tests/basic/fpmodel.js log) bit for bit, and to the
// error those steps and the series allow, absolute in log2 m: q = sqrt 2 / (m + sqrt 1/2), from .83 to 1.17, rounded
// to nearest, at most half its last place (2^-32 from 1 up), which t P(t^2) carries times P (under 2.9): 1.45 x 2^-31;
// t P and 1/2 less it rounded at 2^-33 each: .5 x 2^-31; the series' own error, the least-squares fit's (1.11 x 2^-31
// at most, exact arithmetic over t from -.1716 to .1716) and its third term's 91 units (.2 x 2^-31): 3.26 x 2^-31 in
// all, held to 3.5; then x ln 2, and the result's own unit
{
  let mism = 0, first = '', worst = 0, at = null;
  for (let i = 0; i < COUNT; i++) {
    const a = packedOf(i < COUNT / 2 ? 0.5 + rnd() : 10 ** (rnd() * 60 - 30)), r = rom1('FLOG', a);
    const mo = F.pack(F.round(F.log(a))), got = r.st === 'ok' ? F.pack(get(FAC)) : r.st;
    if (String(got) !== String(mo)) { mism++; if (!first) first = `${num(a)}: rom ${got} model ${mo}`; }
    const e = Math.abs(r.v - Math.log(num(a))) / (Math.LN2 * (3 * 2 ** -31 + 2 ** -32) + ULP * Math.abs(Math.log(num(a))));
    if (i < COUNT / 2 && e > worst) { worst = e; at = num(a); }
  }
  check(`LOG: ${COUNT} arguments bit for bit as the model of its steps`, mism === 0, first);
  check('LOG near 1: within the error its steps allow', worst <= 1, `worst ${worst.toFixed(3)} of the bound at ${at}`);
}
// EXP works in base 2 as the original does [BB bb2 fn-sqr-bits]: t = x / ln 2 rounded to 32 bits is off by up to
// |t| 2^-32, and 1/ln 2's own rounding adds as much again, so e^x is off by up to ln 2 |t| 2^-31 = |x| units, plus
// the series' 3
sweep('EXP', 'FEXP', (i) => rnd() * 170 - 85, Math.exp, { tol: [3, Math.abs, '|x|'] });
// SIN, COS and TAN work in turns, as the original [BB bb10 fn-last-bit, fn-trig-big], so they are as exact as x / 2 pi
// rounded, not as the sine: the bounds that were here (2 units of 1 for SIN and COS, 2 of the result for small
// arguments) were our own, and the original is outside them (SIN(.001) 82 units below the nearest, SIN(100) 56,
// COS(100) 84). Held instead to the model of the same steps (tests/basic/fpmodel.js sin, cos, tan) bit for bit, to the
// original's own 39 values, and to the error the steps allow: y = x / 2 pi is off by up to |y| 2^-32 for its
// rounding and as much again for 2 pi's, the fold rounds v at 1/4's place (2^-34 of a turn), and the series is
// within 2 units, so the sine is within 2 pi (|y| 2^-31 + 2^-33) + 2 units of 1, plus one more turn's rounding (x +
// pi/2 for COS, |x| 2^-32)
const trigModel = { FSIN: F.sin, FCOS: F.cos, FTAN: F.tan };
for (const [fnName, exact] of [['FSIN', Math.sin], ['FCOS', Math.cos]]) {
  let mism = 0, first = '', worst = 0, at = null;
  for (let i = 0; i < COUNT; i++) {
    const x = (rnd() - 0.5) * 10 ** (rnd() * 12 - 5), a = packedOf(x);
    const r = rom1(fnName, a);
    let mo; try { mo = F.pack(trigModel[fnName](a)); } catch (e) { mo = e.message; }
    const got = r.st === 'ok' ? F.pack(get(FAC)) : r.st;
    if (String(got) !== String(mo)) { mism++; if (!first) first = `${num(a)}: rom ${got} model ${mo}`; }
    const xv = num(a), bound = (2 * Math.PI * (Math.abs(xv / (2 * Math.PI)) * 2 ** -31 + 2 ** -33) + 2 * ULP + (fnName === 'FCOS' ? Math.abs(xv) * 2 ** -32 : 0));
    if (r.st === 'ok') { const e = Math.abs(r.v - exact(xv)) / bound; if (e > worst) { worst = e; at = xv; } }
  }
  check(`${fnName.slice(1)}: ${COUNT} arguments from 1E-5 to 1E7 bit for bit as the model of its steps`, mism === 0, first);
  check(`${fnName.slice(1)}: within the error its steps allow`, worst <= 1, `worst ${worst.toFixed(3)} of the bound at ${at}`);
}
{
  let mism = 0, first = '';
  for (let i = 0; i < COUNT; i++) {
    const a = packedOf((rnd() - 0.5) * 10 ** (rnd() * 12 - 5)), r = rom1('FTAN', a);
    let mo; try { mo = F.pack(F.tan(a)); } catch (e) { mo = e.message; }
    const got = r.st === 'ok' ? F.pack(get(FAC)) : r.st;
    if (String(got) !== String(mo)) { mism++; if (!first) first = `${num(a)}: rom ${got} model ${mo}`; }
  }
  check(`TAN: ${COUNT} arguments bit for bit as the model of its steps`, mism === 0, first);
}
// the original's values, bit for bit [BB bb10 fn-last-bit: the argument as read, the five bytes of the result]
for (const [fnName, rec] of [['FSIN', [['.001', [119, 3, 18, 108, 215]], ['.1', [125, 76, 117, 118, 89]], ['.5', [127, 117, 119, 67, 161]], ['1', [128, 87, 106, 164, 119]], ['1.5', [128, 127, 91, 212, 218]], ['2', [128, 104, 199, 183, 86]], ['3', [126, 16, 129, 195, 103]], ['3.14159265', [100, 123, 83, 209, 75]], ['4', [128, 193, 189, 206, 238]], ['6', [127, 143, 15, 140, 79]], ['10', [128, 139, 68, 247, 177]], ['100', [128, 129, 161, 45, 132]], ['-.7', [128, 164, 235, 115, 75]]]],
  ['FCOS', [['.001', [128, 127, 255, 247, 156]], ['.1', [128, 126, 184, 151, 205]], ['.5', [128, 96, 169, 64, 50]], ['1', [128, 10, 81, 64, 126]], ['1.5', [125, 16, 222, 170, 120]], ['2', [127, 213, 17, 50, 185]], ['3', [128, 253, 112, 37, 245]], ['3.14159265', [129, 128, 0, 0, 0]], ['4', [128, 167, 85, 48, 52]], ['6', [128, 117, 205, 184, 76]], ['10', [128, 214, 205, 100, 71]], ['100', [128, 92, 192, 238, 79]], ['-.7', [128, 67, 204, 178, 148]]]],
  ['FTAN', [['.001', [119, 3, 18, 113, 34]], ['.1', [125, 77, 124, 67, 183]], ['.5', [128, 11, 218, 122, 223]], ['1', [129, 71, 89, 34, 228]], ['1.5', [132, 97, 159, 106, 144]], ['2', [130, 139, 215, 177, 113]], ['3', [126, 145, 247, 184, 139]], ['3.14159265', [100, 251, 83, 209, 75]], ['4', [129, 20, 51, 124, 221]], ['6', [127, 148, 254, 195, 111]], ['10', [128, 37, 250, 249, 169]], ['100', [128, 150, 83, 166, 90]], ['-.7', [128, 215, 160, 54, 26]]]]]) {
  for (const [text, want] of rec) {
    const a = F.unpack(F.finTen(text)), r = rom1(fnName, a);
    const got = r.st === 'ok' ? F.pack(get(FAC)) : r.st;
    check(`${fnName.slice(1)}(${text}) is the original's ${want} [BB bb10 fn-last-bit]`, String(got) === String(want) && String(F.pack(trigModel[fnName](a))) === String(want), String(got));
  }
}
// large arguments: from 2^32 turns on the fraction is 0; at 1E9 a sixteenth of a turn [BB bb10 fn-trig-big]
for (const [fnName, text, want] of [['FSIN', '1E9', ' .707106781'], ['FSIN', '-1E9', '-.707106781'], ['FCOS', '1E9', ' .923879533'], ['FCOS', '-1E9', ' .707106781'], ['FTAN', '1E9', ' 1'], ['FTAN', '-1E9', '-1'],
  ['FSIN', '1000000', '-.34985613'], ['FCOS', '1000000', ' .936803442'], ['FTAN', '-1000000', ' .373457349'], ['FSIN', '1E10', ' 0'], ['FCOS', '1E20', ' 0'], ['FTAN', '1E38', ' 0'], ['FSIN', '1E5', ' .0357533055'], ['FCOS', '1E5', '-.999361503'], ['FTAN', '1E5', '-.0357761791']]) {
  const r = rom1(fnName, F.unpack(F.finTen(text)));
  const got = r.st === 'ok' ? F.fout(get(FAC)) : r.st;
  check(`${fnName.slice(1)}(${text}) prints as the original's ${JSON.stringify(want)} [BB bb10 fn-trig-big]`, got === want, JSON.stringify(got));
}
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
// the original's 13 LOG values, bit for bit, ROM and model [BB bb10 fn-last-bit: the argument as read, the five bytes]
for (const [text, want] of [['.001', '131,221,12,84,205'], ['.1', '130,147,93,141,221'], ['.5', '128,177,114,23,247'], ['.9', '125,215,199,65,18'],
  ['1.1', '125,67,49,251,232'], ['2', '128,49,114,23,249'], ['3', '129,12,159,83,214'], ['10', '130,19,93,141,222'], ['100', '131,19,93,141,222'],
  ['1E10', '133,56,52,241,85'], ['1E-10', '133,184,52,241,85'], ['1E30', '135,10,39,181,0'], ['12345', '132,22,188,113,54']]) {
  const a = F.round(F.unpack(F.finTen(text))), r = rom1('FLOG', a);
  const got = r.st === 'ok' ? F.pack(get(FAC)) : r.st;
  check(`LOG(${text}) is the original's ${want} [BB bb10 fn-last-bit]`, String(got) === want && String(F.pack(F.round(F.log(a)))) === want, String(got));
}
// LOG(1) is ln 2 x 2^-32, not 0: L at m = 1/2 is that much above -1, which puts LOG(.5) and LOG(2) one unit either
// side of ln 2 as the original's are [BB bb10 fn-last-bit]; the original's LOG(1) itself is not recorded yet (bb13c)
ex('LOG(1) is ln 2 x 2^-32 (the model\'s)', 'FLOG', 1, F.toNumber(F.unpack([96, 49, 114, 23, 248])));
ex('EXP(0) = 1', 'FEXP', 0, 1);
ex('SIN(0) = 0', 'FSIN', 0, 0);
ex('COS(0) = 1', 'FCOS', 0, 1);
ex('ATN(0) = 0', 'FATN', 0, 0);
// ^ is always EXP(y LOG |x|), whole exponents too, as the original's: its five bytes [BB bb13c fn-log-pow]
const POW = [[2, 2, '131,0,0,0,1'], [2, 10, '139,0,0,0,6'], [2, -1, '127,127,255,255,255'], [2, 30, '159,0,0,0,0'], [2, 60, '189,0,0,0,0'],
  [10, -2, '122,35,215,10,61'], [-2, 3, '132,128,0,0,1'], [-2, 2, '131,0,0,0,1'], [0, 0, '129,0,0,0,0'], [0, 2, '0,0,0,0,0']];
for (const [a, b, want] of POW) {
  const r = rom1('FPOWER', packedOf(a), packedOf(b));
  check(`${a}^${b} is the original's ${want} [BB bb13c]`, r.st === 'ok' && String(F.pack(get(FAC))) === want, r.st === 'ok' ? String(F.pack(get(FAC))) : r.st);
}
// mutants of ^'s rules, each built and run in a machine of its own: one value of POW must no longer be the original's
{
  const powOn = (built, a, b) => {
    const mm = Emu.createMachine('dragon64');
    mm.setRoms({ basic: built.rom, basic64: null });
    mm.reset(true);
    for (let i = 0; i < 20; i++) mm.runFrame();
    const s = (n) => built.symbols.get(n), c = mm.cpu, r = mm.ram;
    r[TRAP] = 0x20; r[TRAP + 1] = 0xFE;
    const at = (v, x) => { r[x] = v.e; const q = Number(v.m); r[x + 1] = (q >>> 24) & 255; r[x + 2] = (q >>> 16) & 255; r[x + 3] = (q >>> 8) & 255; r[x + 4] = q & 255; r[x + 5] = v.x; r[x + 6] = v.s ? 0xFF : 0; };
    at(packedOf(a), s('ARGEXP')); at(packedOf(b), s('FACEXP'));
    c.s = 0x7E00 - 2; r[c.s] = TRAP >> 8; r[c.s + 1] = TRAP & 0xFF; c.cc |= 0x50; c.dp = 0; c.jump(s('FPOWER'));
    const stop = new Set([TRAP, s('OVERR'), s('DZERR'), s('FCERR')]);
    for (let i = 0; i < 2000000 && !stop.has(c.pc); i++) c.step();
    if (c.pc !== TRAP) return 'err';
    const f = s('FACEXP');
    return String(F.pack(F.round({ e: r[f], m: BigInt(((r[f + 1] << 24) | (r[f + 2] << 16) | (r[f + 3] << 8) | r[f + 4]) >>> 0), x: r[f + 5], s: r[f + 6] === 0xFF })));
  };
  for (const [what, from, to] of [
    ['a base below 0 to an odd power keeps no sign', '        ANDB    #1\n', '        ANDB    #0\n'],
    ['a base below 0 left below 0 for LOG', '        FCB     F_LD+6,0\n        CLR     <FACSGN\n', '        FCB     F_LD+6,0\n        NOP\n        NOP\n'],
    ['0 to the power 0 is 0', '        BEQ     PW0\n', '        BRN     PW0\n'],
  ]) {
    const built = buildBasic({ edit: (f, t) => { if (f !== 'mathfn.inc') return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`); return t.replace(from, to); } });
    const bad = POW.filter(([a, b, want]) => powOn(built, a, b) !== want);
    check(`^ mutant "${what}": no longer the original's`, bad.length > 0, bad.map(([a, b]) => `${a}^${b}`).join(' '));
  }
}
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
// the constants against Math (they are rounded to nearest from 36 digits, so within half a unit)
for (const [name, want] of [['PIO2', Math.PI / 2], ['TWOPI', 2 * Math.PI], ['QUARTR', 0.25], ['LN2', Math.LN2], ['INVLN2', 1 / Math.LN2], ['SQRT3', Math.sqrt(3)], ['PIO6', Math.PI / 6], ['SQRHLF', Math.SQRT1_2], ['SQRT2', Math.SQRT2], ['TANP12', 2 - Math.sqrt(3)]]) {
  const at = sym(name) - 0x8000, v = num(F.unpack(Array.from(rom.slice(at, at + 5))));
  check(`constant ${name}`, err(v, want) <= 0.5, `${v}`);
}
// SIN's series: the model's coefficients (in turns) a power of two from the ROM's (in half turns)
{
  const at = sym('SINSER') - 0x8000;
  const same = F.SINTURNS.every((b, i) => String(Array.from(rom.slice(at + 5 * i, at + 5 * i + 5))) === String([b[0] - (11 - 2 * i), ...b.slice(1)]));
  check('SIN\'s series: the model\'s six coefficients in half turns', same);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
