/*
 * PNG writing for pictures with a small palette (the link preview card, js/video/card.js): no canvas, no browser, no
 * dependency, so it runs in Node and in a page alike.
 *   encodeIndexedPng(width, height, palette, pixels) -> PNG bytes
 *     palette: [[r, g, b], ...] (at most 256 colours); pixels: Uint8Array of palette indices, row by row.
 *     The bit depth is the smallest that holds the palette (1, 2, 4 or 8 bits a pixel); colour type 3 (indexed).
 *   deflate(bytes) -> raw DEFLATE data (RFC 1951): LZ77 over a 32K window, one block of fixed Huffman codes.
 *   zlib(bytes) -> the zlib stream PNG's IDAT holds (RFC 1950: header, deflate, Adler-32).
 * js/media/zip.js's inflate reads the deflate data back (tests/card.test.js round-trips both).
 */
import { crc32 } from '../util.js';

// ---------------- deflate (RFC 1951), fixed Huffman codes ----------------
// length codes 257..285: base lengths and extra bits (RFC 1951 3.2.5)
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const WINDOW = 32768, MIN_MATCH = 3, MAX_MATCH = 258, MAX_CHAIN = 64, HASH_BITS = 15;

class BitWriter {
  constructor() { this.out = []; this.bits = 0; this.n = 0; }
  // value's low `count` bits, least significant first (DEFLATE's order for everything but Huffman codes)
  put(value, count) {
    this.bits |= value << this.n; this.n += count;
    while (this.n >= 8) { this.out.push(this.bits & 0xFF); this.bits >>>= 8; this.n -= 8; }
  }
  // a Huffman code, most significant bit first
  code(value, count) { let r = 0; for (let i = 0; i < count; i++) r = (r << 1) | ((value >> i) & 1); this.put(r, count); }
  bytes() { if (this.n) this.out.push(this.bits & 0xFF); return Uint8Array.from(this.out); }
}
// the fixed literal/length code (RFC 1951 3.2.6)
const literal = (w, v) => {
  if (v < 144) w.code(0x30 + v, 8);
  else if (v < 256) w.code(0x190 + v - 144, 9);
  else if (v < 280) w.code(v - 256, 7);
  else w.code(0xC0 + v - 280, 8);
};
const lengthCode = (len) => { let i = LEN_BASE.length - 1; while (LEN_BASE[i] > len) i--; return i; };
const distCode = (d) => { let i = DIST_BASE.length - 1; while (DIST_BASE[i] > d) i--; return i; };

export function deflate(src) {
  const w = new BitWriter();
  w.put(1, 1); w.put(1, 2);   // BFINAL, BTYPE 01: one block, fixed codes
  const head = new Int32Array(1 << HASH_BITS).fill(-1), prev = new Int32Array(WINDOW);
  const hash = (i) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & ((1 << HASH_BITS) - 1);
  const insert = (i) => { if (i + MIN_MATCH > src.length) return; const h = hash(i); prev[i % WINDOW] = head[h]; head[h] = i; };
  let i = 0;
  while (i < src.length) {
    let best = 0, bestDist = 0;
    if (i + MIN_MATCH <= src.length) {
      let p = head[hash(i)], chain = MAX_CHAIN;
      const max = Math.min(MAX_MATCH, src.length - i);
      while (p >= 0 && i - p <= WINDOW && chain-- > 0) {
        let l = 0;
        while (l < max && src[p + l] === src[i + l]) l++;
        if (l > best) { best = l; bestDist = i - p; if (l === max) break; }
        const q = prev[p % WINDOW];
        if (q >= p) break;   // (a slot the window has since reused)
        p = q;
      }
    }
    if (best >= MIN_MATCH) {
      const lc = lengthCode(best), dc = distCode(bestDist);
      literal(w, 257 + lc); w.put(best - LEN_BASE[lc], LEN_EXTRA[lc]);
      w.code(dc, 5); w.put(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);
      for (let k = 0; k < best; k++) insert(i + k);
      i += best;
    } else { literal(w, src[i]); insert(i); i++; }
  }
  literal(w, 256);   // end of block
  return w.bytes();
}

const adler32 = (b) => { let a = 1, s = 0; for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; } return ((s << 16) | a) >>> 0; };
export function zlib(src) {
  const d = deflate(src), out = new Uint8Array(d.length + 6);
  out[0] = 0x78; out[1] = 0x01;   // deflate, 32K window, no dictionary (0x7801 % 31 === 0)
  out.set(d, 2);
  const a = adler32(src);
  out.set([a >>> 24, (a >>> 16) & 0xFF, (a >>> 8) & 0xFF, a & 0xFF], d.length + 2);
  return out;
}

// ---------------- PNG ----------------
const u32 = (v) => [v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
const chunk = (type, data) => {
  const body = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat([...data]));
  return [...u32(data.length), ...body, ...u32(parseInt(crc32(body), 16))];
};
export function encodeIndexedPng(width, height, palette, pixels) {
  if (!palette.length || palette.length > 256) throw new Error(`png: a palette of 1 to 256 colours, not ${palette.length}`);
  if (pixels.length !== width * height) throw new Error(`png: ${pixels.length} pixels for ${width}x${height}`);
  const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
  const per = 8 / depth, stride = Math.ceil(width / per);
  const raw = new Uint8Array((stride + 1) * height);   // each row: filter 0 (none), then the packed pixels
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x];
      if (v >= palette.length) throw new Error(`png: pixel ${x},${y} is colour ${v}, past the palette`);
      raw[o + Math.floor(x / per)] |= v << (8 - depth * (1 + (x % per)));
    }
  }
  const ihdr = [...u32(width), ...u32(height), depth, 3, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', ihdr), ...chunk('PLTE', palette.flat()), ...chunk('IDAT', zlib(raw)), ...chunk('IEND', [])]);
}
