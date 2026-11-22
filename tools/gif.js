// A minimal animated-GIF encoder (GIF89a, global palette, LZW, looping), for tools/capture-gif.js. Dev tool only.
//   encodeGif({ width, height, palette: [[r,g,b],...], frames: [{ pixels: Uint8Array (palette indices), delay: cs }] })
//   returns a Buffer. Palette size is padded to a power of two (2..256).
'use strict';

function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1, out = [];
  let bits = 0, nbits = 0, size = minCode + 1, next = eoi + 1, dict = new Map();
  const put = (code) => {
    bits |= code << nbits; nbits += size;
    while (nbits >= 8) { out.push(bits & 255); bits >>>= 8; nbits -= 8; }
  };
  put(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next - 1 === (1 << size) && size < 12) size++;
    } else { put(clear); dict = new Map(); next = eoi + 1; size = minCode + 1; }
    prefix = k;
  }
  put(prefix); put(eoi);
  if (nbits > 0) out.push(bits & 255);
  return Buffer.from(out);
}

function encodeGif({ width, height, palette, frames, loop = 0 }) {
  let depth = 1; while ((1 << depth) < palette.length) depth++;
  if (depth > 8) throw new Error('palette over 256 colours');
  const parts = [], u16 = (n) => Buffer.from([n & 255, n >> 8 & 255]);
  parts.push(Buffer.from('GIF89a'), u16(width), u16(height), Buffer.from([0x80 | (depth - 1) << 4 | (depth - 1), 0, 0]));
  const pal = Buffer.alloc(3 << depth);
  palette.forEach((c, i) => pal.set(c, i * 3));
  parts.push(pal);
  parts.push(Buffer.from([0x21, 0xFF, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1]), u16(loop), Buffer.from([0]));
  const minCode = Math.max(2, depth);
  for (const f of frames) {
    if (f.pixels.length !== width * height) throw new Error('frame size mismatch');
    parts.push(Buffer.from([0x21, 0xF9, 4, 0x04]), u16(f.delay), Buffer.from([0, 0]));
    parts.push(Buffer.from([0x2C, 0, 0, 0, 0]), u16(width), u16(height), Buffer.from([0]));
    parts.push(Buffer.from([minCode]));
    const data = lzw(f.pixels, minCode);
    for (let o = 0; o < data.length; o += 255) { const n = Math.min(255, data.length - o); parts.push(Buffer.from([n]), data.subarray(o, o + n)); }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3B]));
  return Buffer.concat(parts);
}

module.exports = { encodeGif };
