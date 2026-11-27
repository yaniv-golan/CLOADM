// A bit-exact model of the clean-room BASIC's floating-point arithmetic (basic/fp.inc), written from the
// Microsoft Binary Format's published description [MBF], not from any ROM: tests/basic-fp.test.js checks the 6809
// routines against it operand for operand. It models OUR algorithms (where they round, how many guard bits they
// keep); where the real ROM's results differ (black-box runs), the model is changed first and the ROM after it.
//
// Packed: 5 bytes [E, M1, M2, M3, M4]. E = 0 is zero; otherwise the value is (-1)^s x 0.1mmm... x 2^(E-128), the
// mantissa's top bit always 1 and stored as the sign s (M1 bit 7).
// Unpacked (the accumulators FAC and ARG): { e (0-255; 0 is zero), m (32-bit mantissa with its top bit set, a
// BigInt), s (true for negative), x (8 guard bits below m, 0-255) }.
//
// The rules (our own, documented in basic/fp.inc):
//  * every operation first rounds its inputs (round(): m + 1 if x >= $80, which may carry into the exponent), so
//    an operation's inputs are exactly representable; it then produces m with 8 guard bits in x;
//  * add/subtract: the smaller operand is shifted right into its guard byte (bits shifted further are lost), the
//    mantissas (with guard bytes) are added or subtracted as 40-bit numbers, and the result normalised;
//  * multiply: the 64-bit product's top 40 bits (32 + 8 guard), normalised (at most one shift);
//  * divide: 41 quotient bits by restoring division, normalised so 40 remain (32 + 8 guard);
//  * an exponent above 255 is an overflow (?OV ERROR); below 1, the result is 0;
//  * a 0 (exponent 0) keeps a mantissa, as FAC does, and is packed with it, as the original stores 2.9E-39 as
//    0,124,160,41,60 and 1E-39 as 0,32,0,0,0 [BB bb10 num-literal-bytes]: an underflow keeps the result's
//    mantissa, a product or quotient with a 0 operand, or a quotient known to be too small before it is worked out,
//    keeps FAC's (the right operand's), a sum with a 0 is the other operand.
const M32 = (1n << 32n) - 1n;

class OV extends Error { constructor() { super('OV'); } }
class DZ extends Error { constructor() { super('/0'); } }

const ZERO = () => ({ e: 0, m: 0n, s: false, x: 0 });
const unpack = (b) => ({ e: b[0], m: (BigInt(b[1] | 0x80) << 24n) | (BigInt(b[2]) << 16n) | (BigInt(b[3]) << 8n) | BigInt(b[4]), s: b[0] !== 0 && !!(b[1] & 0x80), x: 0 });
const zeroOf = (a) => ({ e: 0, m: a.m, s: false, x: 0 });   // FZERO: the exponent, sign and guard byte cleared
// round to 32 bits (the guard byte's top bit rounds up); overflow past 255 is ?OV
function round(a) {
  if (a.e === 0) return { ...a, x: 0 };
  let { e, m } = a;
  if (a.x & 0x80) {
    m += 1n;
    if (m > M32) { m >>= 1n; e++; if (e > 255) throw new OV(); }
  }
  return { e, m, s: a.s, x: 0 };
}
function pack(a) {
  const r = round(a);
  const m = Number(r.m & M32);
  return [r.e, ((m >>> 24) & 0x7F) | (r.s ? 0x80 : 0), (m >>> 16) & 0xFF, (m >>> 8) & 0xFF, m & 0xFF];
}
// a 40-bit mantissa (m << 8 | x) with exponent e and sign s, normalised; exponent below 1 gives 0
function norm40(v, e, s) {
  if (v === 0n) return ZERO();
  while (v < (1n << 39n)) { v <<= 1n; e--; }
  while (v >= (1n << 40n)) { v >>= 1n; e++; }
  if (e < 1) return { e: 0, m: v >> 8n, s: false, x: 0 };
  if (e > 255) throw new OV();
  return { e, m: v >> 8n, s, x: Number(v & 0xFFn) };
}

function add(a0, b0) {
  let a = round(a0), b = round(b0);
  if (a.e === 0) return b;                        // (FAC as it is when ARG is 0)
  if (b.e === 0) return a;
  if (b.e > a.e) [a, b] = [b, a];                 // a: the larger exponent
  const d = a.e - b.e;
  const av = a.m << 8n;
  const bv = d >= 40 ? 0n : (b.m << 8n) >> BigInt(d);
  if (a.s === b.s) return norm40(av + bv, a.e, a.s);
  let v = av - bv, s = a.s;
  if (v < 0n) { v = -v; s = !s; }
  return norm40(v, a.e, s);
}
const neg = (a) => (a.e === 0 ? a : { ...a, s: !a.s });
const sub = (a, b) => add(a, neg(b));              // a - b

function mul(a0, b0) {
  const a = round(a0), b = round(b0);
  if (a.e === 0 || b.e === 0) return zeroOf(b);
  const p = a.m * b.m;                            // 64 bits, >= 2^62
  return norm40(p >> 24n, a.e + b.e - 128, a.s !== b.s);
}

function div(a0, b0) {                            // a / b
  const a = round(a0), b = round(b0);
  if (b.e === 0) throw new DZ();
  if (a.e === 0) return zeroOf(b);
  if (a.e - b.e + 128 < 0) return zeroOf(b);      // too small whatever the mantissas
  let r = a.m, q = 0n;
  for (let i = 0; i < 41; i++) {                  // quotient bits 2^0 .. 2^-40
    q <<= 1n;
    if (r >= b.m) { r -= b.m; q |= 1n; }
    r <<= 1n;
  }
  // q / 2^40 is the mantissa ratio, in (0.5, 2): a value v x 2^-40 with v < 2^41
  return norm40(q, a.e - b.e + 128, a.s !== b.s);
}

function cmp(a0, b0) {                            // -1, 0, 1 for a < b, a == b, a > b (after rounding)
  const a = round(a0), b = round(b0);
  const sg = (v) => (v.e === 0 ? 0 : v.s ? -1 : 1);
  if (sg(a) !== sg(b)) return sg(a) < sg(b) ? -1 : 1;
  if (sg(a) === 0) return 0;
  const mag = a.e !== b.e ? (a.e > b.e ? 1 : -1) : a.m === b.m ? 0 : a.m > b.m ? 1 : -1;
  return a.s ? -mag : mag;
}

// a JavaScript number (only for building test operands: exact for values representable in 32 bits of mantissa)
function fromNumber(n) {
  if (n === 0) return ZERO();
  const s = n < 0;
  let v = Math.abs(n), e = 128;
  while (v >= 1) { v /= 2; e++; }
  while (v < 0.5) { v *= 2; e--; }
  const scaled = v * 2 ** 40;                      // 40 bits: mantissa and guard
  return norm40(BigInt(Math.floor(scaled)), e, s);
}
// the exact value as a JavaScript number (for checks)
const toNumber = (a) => (a.e === 0 ? 0 : (a.s ? -1 : 1) * Number(a.m) * 2 ** (a.e - 128 - 32) + 0 * a.x);

// ---- conversions (basic/fpconv.inc) ----
const TEN = unpack([0x84, 0x20, 0, 0, 0]), HALF = unpack([0x80, 0, 0, 0, 0]);
const E8 = unpack([0x9B, 0x3E, 0xBC, 0x20, 0]), E9 = unpack([0x9E, 0x6E, 0x6B, 0x28, 0]);
// POWTAB (basic/fpconv.inc): 10^0 to 10^17 packed, rounded to nearest (exact up to 10^13)
const POWBYTES = [
  [0x81, 0x00, 0x00, 0x00, 0x00], [0x84, 0x20, 0x00, 0x00, 0x00], [0x87, 0x48, 0x00, 0x00, 0x00], [0x8A, 0x7A, 0x00, 0x00, 0x00],
  [0x8E, 0x1C, 0x40, 0x00, 0x00], [0x91, 0x43, 0x50, 0x00, 0x00], [0x94, 0x74, 0x24, 0x00, 0x00], [0x98, 0x18, 0x96, 0x80, 0x00],
  [0x9B, 0x3E, 0xBC, 0x20, 0x00], [0x9E, 0x6E, 0x6B, 0x28, 0x00], [0xA2, 0x15, 0x02, 0xF9, 0x00], [0xA5, 0x3A, 0x43, 0xB7, 0x40],
  [0xA8, 0x68, 0xD4, 0xA5, 0x10], [0xAC, 0x11, 0x84, 0xE7, 0x2A], [0xAF, 0x35, 0xE6, 0x20, 0xF5], [0xB2, 0x63, 0x5F, 0xA9, 0x32],
  [0xB6, 0x0E, 0x1B, 0xC9, 0xBF], [0xB9, 0x31, 0xA2, 0xBC, 0x2F]];
const P = POWBYTES.map(unpack);
const fromU32 = (n) => norm40(BigInt(n >>> 0) << 8n, 160, false);          // I32FLT
const fromI16 = (d) => { const v = fromU32(Math.abs(d)); return d < 0 ? neg(v) : v; };   // GIVABF
function qint(a0) {                                                          // QINT: |a| truncated
  const a = round(a0);
  if (a.e <= 128) return 0n;
  return a.m >> BigInt(160 - a.e);
}
const mul10 = (a) => mul(TEN, a);
const div10 = (a) => div(round(a), TEN);

// FOUT: ' ' or '-', then the digits
function fout(a0) {
  let a = round(a0);
  const sign = a.s ? '-' : ' ';
  if (a.e === 0) return sign + '0';
  a = { ...a, s: false };
  let e10 = 0;
  // big steps of 1E9 from below 1 up, then single steps of 10, each rounded: the real ROM prints 1E5 - 6 x 2^-15
  // (its SQR(1E10)) as 99999.9999, which four rounded steps give and one product by 1E4 does not [BB bb1 fn-math,
  // bb2 fn-sqr-bits]; from 1E9 up single quotients by 10 only: it prints 8E37's bytes as 8E+37 and
  // 9.99999999E17's as 9.99999999E+17, which steps of 1E9 do not give [BB bb10 num-print-big, bb9 rnd-args]
  while (cmp(a, P[0]) < 0) { a = mul(P[9], a); e10 -= 9; }
  while (cmp(a, E8) < 0) { a = mul10(a); e10--; }
  while (cmp(a, E9) >= 0) { a = div10(a); e10++; }
  let n = qint(add(HALF, a));
  if (n >= 1000000000n) { n = 100000000n; e10++; }
  const d = n.toString();
  let nd = 9;
  while (nd > 1 && d[nd - 1] === '0') nd--;
  const E = e10 + 8;
  let out = sign;
  if (E >= -2 && E <= 8) {
    if (E >= 0) { out += d.slice(0, E + 1); if (nd > E + 1) out += '.' + d.slice(E + 1, nd); }
    else out += '.' + '0'.repeat(-E - 1) + d.slice(0, nd);
  } else {
    out += d[0] + (nd > 1 ? '.' + d.slice(1, nd) : '') + 'E' + (E < 0 ? '-' : '+') + String(Math.abs(E)).padStart(2, '0');
  }
  return out;
}

// FIN: text to a number, as the ROM reads it: digits kept while they fit in 32 bits and the first one past them, later ones only places (spaces skipped; '+' and '-' may be the tokens, passed as such)
function fin(text, { plus = '+', minus = '-' } = {}) {
  const t = text.replace(/ /g, '');
  let i = 0, neg = false, dp = false, e10 = 0, n = 0n, dropped = false;
  if (t[i] === '-' || t[i] === minus) { neg = true; i++; } else if (t[i] === '+' || t[i] === plus) i++;
  for (;;) {
    const c = t[i];
    if (c >= '0' && c <= '9') {
      const d = BigInt(c.charCodeAt(0) - 48);
      if (!dropped && (n < 429496729n || (n === 429496729n && d <= 5n))) { n = n * 10n + d; if (dp) e10--; }
      else if (!dropped) {                         // past 32 bits: the first such digit is kept too (up to 36
        n = n * 10n + d;                           // bits, rounded to 32 when next used) [BB bb9 rnd-args]
        dropped = true;
        if (dp) e10--;
      } else if (!dp) e10++;                       // later ones only count as places
      i++;
    } else if (c === '.' && !dp) { dp = true; i++; }
    else break;
  }
  if (t[i] === 'E') {
    i++;
    let es = false, ex = 0;
    if (t[i] === '-' || t[i] === minus) { es = true; i++; } else if (t[i] === '+' || t[i] === plus) i++;
    while (t[i] >= '0' && t[i] <= '9') { if (ex < 1000) ex = ex * 10 + (t.charCodeAt(i) - 48); i++; }
    e10 += es ? -ex : ex;
  }
  let a = norm40(n << 8n, 160, false);
  for (; e10 > 0; e10--) a = mul10(a);           // one product or quotient by 10 a place [BB bb9 rnd-args, rnd-neg]
  for (; e10 < 0; e10++) a = div10(a);
  if (neg && a.e !== 0) a = { ...a, s: true };
  return { value: a, rest: t.slice(i) };
}

// finTen: what reading a number gives by the rule the original's readings fit [BB bb9 rnd-args: RND(4294967296) and
// RND(1E38) from 9 seeds; rnd-neg: the seeds RND(-1E30), RND(-1E-30), RND(-1.00000001), RND(-.999999999) leave],
// written from that rule with exact fractions, not from the ROM's routines: the digits make a whole number, exactly
// while it fits in 32 bits and with the first digit past them too (later digits only places); that is rounded to 32
// bits, then multiplied or divided by 10 once for each place of the decimal exponent (the places after the point
// taken from the exponent), each result rounded to 32 bits: to nearest, a half up. A result below 2^-128 is 0, one
// of 2^127 or more ?OV ERROR. Returns the five packed bytes, or 'OV'.
function finTen(text) {
  const t = text.replace(/ /g, '');
  let i = 0, neg = false, dp = false, e10 = 0, n = 0n, past = false;
  if (t[i] === '-') { neg = true; i++; } else if (t[i] === '+') i++;
  for (;;) {
    const c = t[i];
    if (c >= '0' && c <= '9') {
      const d = BigInt(c.charCodeAt(0) - 48);
      if (!past) { if (n * 10n + d > M32) past = true; n = n * 10n + d; if (dp) e10--; }
      else if (!dp) e10++;
      i++;
    } else if (c === '.' && !dp) { dp = true; i++; }
    else break;
  }
  if (t[i] === 'E') {
    i++;
    let es = false, ex = 0;
    if (t[i] === '-') { es = true; i++; } else if (t[i] === '+') i++;
    while (t[i] >= '0' && t[i] <= '9') { ex = (ex * 10 + t.charCodeAt(i) - 48) & 0xFF; i++; }   // a byte that wraps
    if (ex > 127) ex -= 256;
    e10 += es ? -ex : ex;
  }
  if (n === 0n) return [0, 0, 0, 0, 0];
  // num / den rounded to 32 bits: { m, E } with value m x 2^(E - 160), or null below 2^-128
  const r32 = (num, den) => {
    let s = 0;                                                   // m = floor(num 2^s / den) in [2^31, 2^32)
    while (((num << BigInt(Math.max(s, 0))) >> BigInt(Math.max(-s, 0))) / den >= 1n << 32n) s--;
    while (((num << BigInt(Math.max(s, 0))) >> BigInt(Math.max(-s, 0))) / den < 1n << 31n) s++;
    const q = (k) => (k >= 0 ? (num << BigInt(k)) / den : num / (den << BigInt(-k)));
    let m = q(s), E = 160 - s;
    if (E < 1) return null;
    if (q(s + 1) & 1n) { m += 1n; if (m === 1n << 32n) { m >>= 1n; E++; } }
    if (E > 255) throw new OV();
    return { m, E };
  };
  const frac = (v) => (v.E >= 160 ? [v.m << BigInt(v.E - 160), 1n] : [v.m, 1n << BigInt(160 - v.E)]);
  let v;
  try {
    v = r32(n, 1n);
    for (; e10 > 0; e10--) { const [a, b] = frac(v); v = r32(a * 10n, b); }
    for (; e10 < 0; e10++) {
      // a quotient below 2^-128 is 0 with a mantissa [BB bb10 num-literal-bytes]: 10's (FAC's, the divisor's) when
      // the dividend is 0 or its exponent byte below 4, so that the quotient is known to be too small before it is
      // worked out (1E-39, 1E-40: 0,32,0,0,0), else the quotient's own, cut to 32 bits (2.9E-39: 0,124,160,41,60)
      if (v.E < 4) { v = { m: 0xA0000000n, E: 0 }; continue; }
      const [a, b] = frac(v);
      v = r32(a, b * 10n) || { m: (a << 160n) / (b * 10n), E: 0 };
    }
  } catch (e) { if (e instanceof OV) return 'OV'; throw e; }
  if (v.E === 0) neg = false;
  const m = Number(v.m);
  return [v.E, ((m >>> 24) & 0x7F) | (neg ? 0x80 : 0), (m >>> 16) & 0xFF, (m >>> 8) & 0xFF, m & 0xFF];
}

// ---- SIN, COS and TAN (basic/mathfn.inc), in turns, as the original [BB bb10 fn-last-bit: all 39 of its SIN, COS
// and TAN values bit for bit; fn-trig-big]. Written in turns with the constants 1/4 and 1/2, where the ROM works in
// half turns (2f, 1/2 and 1: the same bits, a power of two apart) ----
// INT (floor), for |a| below 2^32 exactly
function fint(a0) {
  const a = round(a0);
  if (a.e === 0 || a.e >= 160) return a;
  const sh = 160 - a.e;
  const q = a.e <= 128 ? 0n : a.m >> BigInt(sh);
  const fr = a.e <= 128 ? a.m !== 0n : (a.m & ((1n << BigInt(sh)) - 1n)) !== 0n;
  const n = a.s && fr ? q + 1n : q;
  if (n === 0n) return ZERO();
  const v = norm40(n << 8n, 160, a.s);
  return round(v);
}
// SIN's series in turns, u x (c1 + c3 u^2 + ... + c11 u^10), highest power first: tools/basic-consts.js's SINSER,
// each a power of two apart (2^(2k+1) for u^(2k+1)) from the half-turn coefficients it holds
const SINTURNS = [[132, 230, 79, 213, 12], [134, 40, 10, 61, 47], [135, 153, 104, 154, 109], [135, 35, 53, 224, 93], [134, 165, 93, 231, 43], [131, 73, 15, 218, 162]];
const TWOPI = unpack([131, 73, 15, 218, 162]), PIO2 = unpack([129, 73, 15, 218, 162]), QTR = unpack([127, 0, 0, 0, 0]), ONE = unpack([129, 0, 0, 0, 0]);
// x / 2 pi less its INT: f from 0 to below 1
const turnsOf = (x) => { const y = div(round(x), TWOPI); return sub(y, fint(y)); };
// the sine of f turns: g = f, or f - 1/2 with the sign changed; u = 1/4 - |1/4 - g|, each rounded; u x the series
function sinTurns(f) {
  let g = round(f), flip = false;
  if (cmp(g, HALF) >= 0) { g = sub(g, HALF); flip = true; }
  let a = round(sub(QTR, g));
  a = { ...a, s: false };
  const u = round(sub(QTR, a));
  const u2 = round(mul(u, u));
  let acc = unpack(SINTURNS[0]);
  for (let i = 1; i < SINTURNS.length; i++) acc = add(unpack(SINTURNS[i]), mul(u2, acc));    // (ARG, FAC as the ROM has them)
  const r = mul(u, acc);
  return flip ? neg(r) : r;
}
const sin = (x) => sinTurns(turnsOf(x));
const cos = (x) => sin(add(PIO2, round(x)));                          // SIN(x + pi/2), the sum rounded
function tan(x) {                                                      // SIN(x) over the sine of 1/4 - f turns
  const f = round(turnsOf(x));
  let c = round(sub(QTR, f));
  if (c.s && c.e !== 0) c = add(c, ONE);
  return div(round(sinTurns(f)), round(sinTurns(c)));
}

module.exports = { fint, sin, cos, tan, SINTURNS, POWBYTES, fromU32, fromI16, qint, mul10, div10, fout, fin, finTen, TEN, HALF, E8, E9, ZERO, unpack, pack, round, norm40, add, sub, neg, mul, div, cmp, fromNumber, toNumber, OV, DZ };
