// tools/gif.js, the GIF encoder behind the README's picture: the bytes it writes are read back by an independent
// decoder written here from the GIF89a spec (header, global palette, NETSCAPE loop block, graphic control delay,
// variable-width LZW with clear codes), and must give the original pixels, palette and delays.
const { encodeGif } = require('../tools/gif.js');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

function decode(b) {
  let p = 6;
  const w = b.readUInt16LE(p), h = b.readUInt16LE(p + 2), flags = b[p + 4]; p += 7;
  const n = 2 << (flags & 7), palette = [];
  for (let i = 0; i < n; i++) palette.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]);
  p += n * 3;
  const frames = []; let delay = 0, loop = null;
  for (;;) {
    const t = b[p++];
    if (t === 0x3B) break;
    if (t === 0x21) {
      const label = b[p++];
      if (label === 0xF9) delay = b.readUInt16LE(p + 2);
      if (label === 0xFF && b.slice(p + 1, p + 12).toString() === 'NETSCAPE2.0') loop = b.readUInt16LE(p + 14);
      while (b[p]) p += b[p] + 1;
      p++; continue;
    }
    if (t !== 0x2C) throw new Error(`bad block ${t}`);
    p += 9; // position, size, flags (no local palette)
    const min = b[p++], data = [];
    while (b[p]) { for (let i = 1; i <= b[p]; i++) data.push(b[p + i]); p += b[p] + 1; }
    p++;
    const clear = 1 << min, eoi = clear + 1, px = [];
    let table = [], size = min + 1, bits = 0, nb = 0, di = 0, prev = null;
    const reset = () => { table = []; for (let i = 0; i < clear; i++) table[i] = [i]; table[clear] = null; table[eoi] = null; size = min + 1; prev = null; };
    reset();
    for (;;) {
      while (nb < size && di < data.length) { bits |= data[di++] << nb; nb += 8; }
      const code = bits & ((1 << size) - 1); bits >>>= size; nb -= size;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let seq;
      if (code < table.length) seq = table[code]; else seq = prev.concat(prev[0]);
      px.push(...seq);
      if (prev) { table.push(prev.concat(seq[0])); if (table.length === (1 << size) && size < 12) size++; }
      prev = seq;
    }
    frames.push({ pixels: px, delay });
  }
  return { w, h, palette, frames, loop };
}

const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
// a small hand-built frame pair
{
  const a = Uint8Array.from([0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1]), b = Uint8Array.from([4, 4, 4, 4, 0, 0, 0, 0, 2, 2, 2, 2]);
  const g = encodeGif({ width: 4, height: 3, palette, frames: [{ pixels: a, delay: 20 }, { pixels: b, delay: 7 }] });
  const d = decode(g);
  check('header and size', g.slice(0, 6).toString() === 'GIF89a' && d.w === 4 && d.h === 3);
  check('the palette is kept, padded to a power of two', JSON.stringify(d.palette.slice(0, 5)) === JSON.stringify(palette) && d.palette.length === 8);
  check('two frames with their delays', d.frames.length === 2 && d.frames[0].delay === 20 && d.frames[1].delay === 7);
  check('pixels round-trip', d.frames[0].pixels.join() === a.join() && d.frames[1].pixels.join() === b.join());
  check('loops forever', d.loop === 0);
  check('ends with the trailer', g[g.length - 1] === 0x3B);
}
// a big noisy frame forces the dictionary to fill (4096 codes) and restart with a clear code
{
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 8;
  const big = new Uint8Array(200 * 150).map(() => rnd() % 5);
  const d = decode(encodeGif({ width: 200, height: 150, palette, frames: [{ pixels: big, delay: 1 }] }));
  check('noise round-trips through dictionary resets', d.frames[0].pixels.length === big.length && d.frames[0].pixels.every((v, i) => v === big[i]));
}
// error cases
{
  let e = ''; try { encodeGif({ width: 2, height: 2, palette, frames: [{ pixels: new Uint8Array(3), delay: 1 }] }); } catch (x) { e = x.message; }
  check('a frame of the wrong size is refused', /size/.test(e), e);
  e = ''; try { encodeGif({ width: 1, height: 1, palette: new Array(257).fill([0, 0, 0]), frames: [] }); } catch (x) { e = x.message; }
  check('more than 256 colours is refused', /256/.test(e), e);
}
console.log(fail ? `${fail} FAILED` : 'all gif checks passed');
process.exitCode = fail ? 1 : 0;
