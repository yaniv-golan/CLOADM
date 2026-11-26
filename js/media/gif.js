/*
 * A small animated-GIF encoder (GIF89a: global palette, LZW, looping, an optional comment), in plain JS with no
 * dependency: the Share screen's "Save GIF" (js/ui/share.js) and tools/capture-gif.js (the README's picture) both use it.
 *   encodeGif({ width, height, palette: [[r,g,b],...], frames: [{ pixels: Uint8Array (palette indices), delay: cs,
 *     x, y, w, h: the part of the picture it covers, all of it when left out }],
 *     loop = 0 (forever), comment = '' }) -> Uint8Array. The palette is padded to a power of two (2..256).
 *   gifFromFrames(rendered, { scale = 2, delay, comment }) -> { bytes, width, height, frames, colours }: the machine's
 *     own rendered frames ({ width, height, data: colour indices, table: packed 0xBBGGRR }) at true pixels, scaled
 *     `scale` times, with no CRT look. After the first, each frame holds only the rectangle that changed (the rest is
 *     kept: disposal 1); a frame the same as the one before it adds its time to that frame instead.
 * tests/gif.test.js decodes what it writes with a decoder written there from the GIF89a specification.
 */
const ascii = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0) & 0x7F);

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
  return out;
}

// data -> sub-blocks of at most 255 bytes, then the 0 terminator
function subBlocks(parts, data) {
  for (let o = 0; o < data.length; o += 255) { const n = Math.min(255, data.length - o); parts.push([n], data.slice(o, o + n)); }
  parts.push([0]);
}

export function encodeGif({ width, height, palette, frames, loop = 0, comment = '' }) {
  let depth = 1; while ((1 << depth) < palette.length) depth++;
  if (depth > 8) throw new Error('palette over 256 colours');
  const parts = [], u16 = (n) => [n & 255, n >> 8 & 255];
  parts.push(ascii('GIF89a'), u16(width), u16(height), [0x80 | (depth - 1) << 4 | (depth - 1), 0, 0]);
  const pal = new Uint8Array(3 << depth);
  palette.forEach((c, i) => pal.set(c, i * 3));
  parts.push(pal);
  parts.push([0x21, 0xFF, 11], ascii('NETSCAPE2.0'), [3, 1], u16(loop), [0]);
  if (comment) { parts.push([0x21, 0xFE]); subBlocks(parts, ascii(comment)); }
  const minCode = Math.max(2, depth);
  for (const f of frames) {
    // a frame may cover part of the picture (x, y, w, h): the rest stays as the frame before left it (disposal 1)
    const x = f.x || 0, y = f.y || 0, w = f.w || width, h = f.h || height;
    if (f.pixels.length !== w * h || x + w > width || y + h > height) throw new Error('frame size mismatch');
    parts.push([0x21, 0xF9, 4, 0x04], u16(f.delay), [0, 0]);
    parts.push([0x2C], u16(x), u16(y), u16(w), u16(h), [0]);
    parts.push([minCode]);
    subBlocks(parts, lzw(f.pixels, minCode));
  }
  parts.push([0x3B]);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function gifFromFrames(rendered, { scale = 2, delay = 4, comment = '' } = {}) {
  if (!rendered.length) throw new Error('no frames');
  const { width: w, height: h } = rendered[0];
  const colours = new Map(), palette = [], frames = [];
  let last = null;
  for (const f of rendered) {
    if (f.width !== w || f.height !== h) throw new Error('frame size changed');
    // the frame as packed colours (its table can differ from frame to frame: a palette change mid-clip)
    const packed = new Uint32Array(w * h);
    for (let i = 0; i < packed.length; i++) packed[i] = f.table[f.data[i]] & 0xFFFFFF;
    // the rectangle that changed since the frame before (all of the first); none: the frame before lasts longer
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (last) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (packed[y * w + x] !== last[y * w + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) { frames[frames.length - 1].delay += delay; continue; }
    }
    last = packed;
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1, px = new Uint8Array(rw * scale * rh * scale);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const c = packed[(y0 + y) * w + x0 + x];
        let k = colours.get(c);
        if (k === undefined) {
          if (colours.size === 256) throw new Error('more than 256 colours');
          k = colours.size; colours.set(c, k); palette.push([c & 255, c >> 8 & 255, c >> 16 & 255]);
        }
        for (let dy = 0; dy < scale; dy++) px.fill(k, ((y * scale + dy) * rw + x) * scale, ((y * scale + dy) * rw + x + 1) * scale);
      }
    }
    frames.push({ pixels: px, delay, x: x0 * scale, y: y0 * scale, w: rw * scale, h: rh * scale });
  }
  if (palette.length < 2) palette.push([0, 0, 0]);
  const bytes = encodeGif({ width: w * scale, height: h * scale, palette, frames, comment });
  return { bytes, width: w * scale, height: h * scale, frames: frames.length, colours: colours.size };
}
