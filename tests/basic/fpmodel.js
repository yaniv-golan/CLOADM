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
//  * an exponent above 255 is an overflow (?OV ERROR); below 1, the result is 0.
const M32 = (1n << 32n) - 1n;

class OV extends Error { constructor() { super('OV'); } }
class DZ extends Error { constructor() { super('/0'); } }

const ZERO = () => ({ e: 0, m: 0n, s: false, x: 0 });
const unpack = (b) => (b[0] === 0 ? ZERO() : { e: b[0], m: (BigInt(b[1] | 0x80) << 24n) | (BigInt(b[2]) << 16n) | (BigInt(b[3]) << 8n) | BigInt(b[4]), s: !!(b[1] & 0x80), x: 0 });
// round to 32 bits (the guard byte's top bit rounds up); overflow past 255 is ?OV
function round(a) {
  if (a.e === 0) return ZERO();
  let { e, m } = a;
  if (a.x & 0x80) {
    m += 1n;
    if (m > M32) { m >>= 1n; e++; if (e > 255) throw new OV(); }
  }
  return { e, m, s: a.s, x: 0 };
}
function pack(a) {
  const r = round(a);
  if (r.e === 0) return [0, 0, 0, 0, 0];
  const m = Number(r.m & M32);
  return [r.e, ((m >>> 24) & 0x7F) | (r.s ? 0x80 : 0), (m >>> 16) & 0xFF, (m >>> 8) & 0xFF, m & 0xFF];
}
// a 40-bit mantissa (m << 8 | x) with exponent e and sign s, normalised; exponent below 1 gives 0
function norm40(v, e, s) {
  if (v === 0n) return ZERO();
  while (v < (1n << 39n)) { v <<= 1n; e--; }
  while (v >= (1n << 40n)) { v >>= 1n; e++; }
  if (e < 1) return ZERO();
  if (e > 255) throw new OV();
  return { e, m: v >> 8n, s, x: Number(v & 0xFFn) };
}

function add(a0, b0) {
  let a = round(a0), b = round(b0);
  if (b.e === 0) return a;
  if (a.e === 0) return b;
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
  if (a.e === 0 || b.e === 0) return ZERO();
  const p = a.m * b.m;                            // 64 bits, >= 2^62
  return norm40(p >> 24n, a.e + b.e - 128, a.s !== b.s);
}

function div(a0, b0) {                            // a / b
  const a = round(a0), b = round(b0);
  if (b.e === 0) throw new DZ();
  if (a.e === 0) return ZERO();
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
  // big steps of 1E9 from 1E17 down and from below 1 up, then single steps of 10, each rounded: the real ROM prints
  // 1E5 - 6 x 2^-15 (its SQR(1E10)) as 99999.9999, which four rounded steps give and one product by 1E4 does not
  // [BB bb1 fn-math, bb2 fn-sqr-bits]
  while (cmp(a, P[17]) >= 0) { a = div(a, P[9]); e10 += 9; }
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
  while (e10 >= 9) { a = mul(P[9], a); e10 -= 9; }
  while (e10 <= -9) { a = div(a, P[9]); e10 += 9; }
  if (e10 > 0) a = mul(P[e10], a);
  if (e10 < 0) a = div(a, P[-e10]);
  if (neg && a.e !== 0) a = { ...a, s: true };
  return { value: a, rest: t.slice(i) };
}

module.exports = { POWBYTES, fromU32, fromI16, qint, mul10, div10, fout, fin, TEN, HALF, E8, E9, ZERO, unpack, pack, round, norm40, add, sub, neg, mul, div, cmp, fromNumber, toNumber, OV, DZ };
