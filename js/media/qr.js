/*
 * QR Code (ISO/IEC 18004:2015) for the Share screen's short link: numeric and byte mode, error correction L, M, Q or
 * H, versions 1 to 10 (a short link is about 52 characters: version 4 at level M). Written for CLOADM (no dependency);
 * tests/qr.test.js checks it against the standard's worked example (Annex I), its format and version information
 * tables, and reads every symbol back with a reader of its own.
 *
 * qrEncode(text, { ecl = 'M' }) -> { version, ecl, mask, size, modules: Uint8Array of size * size (1 = dark),
 *   row by row }. The data is UTF-8 in byte mode, or numeric mode when it is all digits. The mask is the one with
 * the lowest penalty (7.8.3).
 */
export class QrError extends Error {}

// [data codewords and blocks] per version and level: [ec codewords per block, [blocks, data codewords], ...] (Table 9)
const EC = {
  L: [null, [7, [1, 19]], [10, [1, 34]], [15, [1, 55]], [20, [1, 80]], [26, [1, 108]], [18, [2, 68]], [20, [2, 78]], [24, [2, 97]], [30, [2, 116]], [18, [2, 68], [2, 69]]],
  M: [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]],
  Q: [null, [13, [1, 13]], [22, [1, 22]], [18, [2, 17]], [26, [2, 24]], [18, [2, 15], [2, 16]], [24, [4, 19]], [18, [2, 14], [4, 15]], [22, [4, 18], [2, 19]], [20, [4, 16], [4, 17]], [24, [6, 19], [2, 20]]],
  H: [null, [17, [1, 9]], [28, [1, 16]], [22, [2, 13]], [16, [4, 9]], [22, [2, 11], [2, 12]], [28, [4, 15]], [26, [4, 13], [1, 14]], [26, [4, 14], [2, 15]], [24, [4, 12], [4, 13]], [28, [6, 15], [2, 16]]],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // Table 12
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];   // Annex E
export const QR_MAX_VERSION = 10;

const dataCodewords = (v, ecl) => EC[ecl][v].slice(1).reduce((n, [b, d]) => n + b * d, 0);

// ---------------- Reed-Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ----------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
function rsDivisor(degree) {
  const r = new Uint8Array(degree); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
export function rsRemainder(data, degree) {
  const div = rsDivisor(degree), r = new Uint8Array(degree);
  for (const b of data) {
    const f = b ^ r[0];
    r.copyWithin(0, 1); r[degree - 1] = 0;
    for (let i = 0; i < degree; i++) r[i] ^= gfMul(div[i], f);
  }
  return r;
}

// ---------------- the codewords (7.4 to 7.6) ----------------
// text -> { version, ecl, codewords: the final interleaved sequence, data: the data codewords before interleaving }
export function qrCodewords(text, { ecl = 'M', version = null } = {}) {
  if (!EC[ecl]) throw new QrError(`no error correction level ${ecl}`);
  const numeric = /^[0-9]+$/.test(text);
  const bytes = numeric ? null : new TextEncoder().encode(text);
  const count = numeric ? text.length : bytes.length;
  const lenBits = (v) => (numeric ? (v < 10 ? 10 : 12) : (v < 10 ? 8 : 16));
  const payloadBits = numeric ? Math.floor(count / 3) * 10 + [0, 4, 7][count % 3] : count * 8;
  let v = version;
  if (v === null) for (v = 1; v <= QR_MAX_VERSION && 4 + lenBits(v) + payloadBits > dataCodewords(v, ecl) * 8; v++);
  if (v > QR_MAX_VERSION || 4 + lenBits(v) + payloadBits > dataCodewords(v, ecl) * 8) throw new QrError(`${count} characters do not fit a version ${QR_MAX_VERSION} symbol at level ${ecl}`);
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(numeric ? 0b0001 : 0b0100, 4);
  put(count, lenBits(v));
  if (numeric) for (let i = 0; i < count; i += 3) { const g = text.slice(i, i + 3); put(Number(g), [0, 4, 7, 10][g.length]); }
  else for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v, ecl) * 8;
  put(0, Math.min(4, cap - bits.length));                // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xEC; data.length < cap / 8; pad ^= 0xEC ^ 0x11) data.push(pad);
  // blocks, each with its error correction, then interleaved
  const [ecLen, ...groups] = EC[ecl][v];
  const blocks = [];
  let at = 0;
  for (const [n, len] of groups) for (let b = 0; b < n; b++) { const d = data.slice(at, at + len); at += len; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return { version: v, ecl, codewords: Uint8Array.from(out), data: Uint8Array.from(data) };
}

// ---------------- the symbol (7.7 to 7.10) ----------------
export function formatBits(ecl, mask) {
  const d = (FORMAT_BITS[ecl] << 3) | mask;
  let r = d;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((d << 10) | r) ^ 0x5412;
}
export function versionBits(v) {
  let r = v;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
  return (v << 12) | r;
}
export const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// the function patterns of a version: { size, dark, fn } (fn marks every module data may not use)
export function qrTemplate(v) {
  const size = 17 + 4 * v, dark = new Uint8Array(size * size), fn = new Uint8Array(size * size);
  const set = (r, c, on) => { dark[r * size + c] = on ? 1 : 0; fn[r * size + c] = 1; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }   // timing
  for (const [r0, c0] of [[3, 3], [3, size - 4], [size - 4, 3]]) {                        // finders and separators
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      const r = r0 + dr, c = c0 + dc, d = Math.max(Math.abs(dr), Math.abs(dc));
      if (r >= 0 && r < size && c >= 0 && c < size) set(r, c, d !== 2 && d !== 4);
    }
  }
  const al = ALIGN[v];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(al[i] + dr, al[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // the format and version areas are reserved here and written once the mask is chosen
  for (let i = 0; i < 9; i++) { fn[8 * size + i] = 1; fn[i * size + 8] = 1; }
  for (let i = 0; i < 8; i++) { fn[8 * size + size - 1 - i] = 1; fn[(size - 1 - i) * size + 8] = 1; }
  set(size - 8, 8, true);   // the dark module
  if (v >= 7) for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); fn[a * size + b] = 1; fn[b * size + a] = 1; }
  return { size, dark, fn };
}
// the order data modules are filled in (7.7.3): [row, column] pairs, upward and downward in two-column strips from the right
export function qrDataOrder(v, fn) {
  const size = 17 + 4 * v, order = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (let j = 0; j < 2; j++) { const c = right - j; if (!fn[r * size + c]) order.push([r, c]); }
    }
  }
  return order;
}
function writeFormat(dark, size, ecl, mask, v) {
  const bits = formatBits(ecl, mask), bit = (i) => (bits >>> i) & 1;
  const set = (r, c, on) => { dark[r * size + c] = on; };
  for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
  set(7, 8, bit(6)); set(8, 8, bit(7)); set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, 1);
  if (v >= 7) {
    const vb = versionBits(v);
    for (let i = 0; i < 18; i++) { const on = (vb >>> i) & 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, on); set(b, a, on); }
  }
}
// the penalty of a finished symbol (7.8.3.1)
export function qrPenalty(m, size) {
  let p = 0;
  const at = (r, c) => m[r * size + c];
  for (const horiz of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      const line = Array.from({ length: size }, (_, b) => (horiz ? at(a, b) : at(b, a)));
      for (let b = 1; b <= size; b++) {
        if (b < size && line[b] === line[b - 1]) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      // 1:1:3:1:1 with four light modules on either side (light outside the symbol counts)
      for (let b = -4; b < size; b++) {
        const get = (k) => (k < 0 || k >= size ? 0 : line[k]);
        const core = [1, 0, 1, 1, 1, 0, 1].every((v, k) => get(b + 4 + k) === v);
        if (core && [0, 1, 2, 3].every((k) => get(b + k) === 0)) p += 40;
        if (core && [0, 1, 2, 3].every((k) => get(b + 11 + k) === 0)) p += 40;
      }
    }
  }
  for (let r = 0; r + 1 < size; r++) for (let c = 0; c + 1 < size; c++) {
    const v = at(r, c);
    if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) p += 3;
  }
  const darkCount = m.reduce((n, v) => n + v, 0);
  p += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}

export function qrEncode(text, { ecl = 'M', mask = null } = {}) {
  const { version: v, codewords } = qrCodewords(text, { ecl });
  const { size, dark, fn } = qrTemplate(v);
  const order = qrDataOrder(v, fn);
  const base = dark.slice();
  order.forEach(([r, c], i) => { base[r * size + c] = i < codewords.length * 8 ? (codewords[i >> 3] >>> (7 - (i & 7))) & 1 : 0; });
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask !== null && k !== mask) continue;
    const m = base.slice();
    for (const [r, c] of order) if (MASKS[k](r, c)) m[r * size + c] ^= 1;
    writeFormat(m, size, ecl, k, v);
    const score = qrPenalty(m, size);
    if (!best || score < best.score) best = { score, mask: k, modules: m };
  }
  return { version: v, ecl, mask: best.mask, size, modules: best.modules };
}
