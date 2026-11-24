// js/media/gif.js, the GIF encoder behind the Share screen's "Save GIF" and the README's picture: the bytes it writes
// are read back by an independent decoder written here from the GIF89a spec (header, global palette, NETSCAPE loop
// block, comment extension, graphic control delay, variable-width LZW with clear codes), and must give the original
// pixels, palette, delays and comment; a hand-built file is compared byte for byte; gifFromFrames is run on the
// machine's own rendered frames.
const Emu = require('./load')();
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

function decode(bytes) {
  const b = Buffer.from(bytes);
  let p = 6;
  const w = b.readUInt16LE(p), h = b.readUInt16LE(p + 2), flags = b[p + 4]; p += 7;
  const n = 2 << (flags & 7), palette = [];
  for (let i = 0; i < n; i++) palette.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]);
  p += n * 3;
  const frames = []; let delay = 0, loop = null, comment = '';
  for (;;) {
    const t = b[p++];
    if (t === 0x3B) break;
    if (t === 0x21) {
      const label = b[p++];
      if (label === 0xF9) delay = b.readUInt16LE(p + 2);
      if (label === 0xFF && b.slice(p + 1, p + 12).toString() === 'NETSCAPE2.0') loop = b.readUInt16LE(p + 14);
      if (label === 0xFE) { let q = p; while (b[q]) { comment += b.slice(q + 1, q + 1 + b[q]).toString('latin1'); q += b[q] + 1; } }
      while (b[p]) p += b[p] + 1;
      p++; continue;
    }
    if (t !== 0x2C) throw new Error(`bad block ${t}`);
    const fx = b.readUInt16LE(p), fy = b.readUInt16LE(p + 2), fw = b.readUInt16LE(p + 4), fh = b.readUInt16LE(p + 6);
    p += 9; // position, size, flags (no local palette)
    const min = b[p++], data = [];
    while (b[p]) { for (let i = 1; i <= b[p]; i++) data.push(b[p + i]); p += b[p] + 1; }
    p++;
    const clear = 1 << min, eoi = clear + 1, px = [];
    let table = [], size = min + 1, bits = 0, nb = 0, di = 0, prev = null;
    const reset = () => { table = []; for (let i = 0; i < clear; i++) table[i] = [i]; table[clear] = null; table[eoi] = null; size = min + 1; prev = null; };
    reset();
    // bounded: a broken encoder must fail here, fast, not grow px without end (at most the picture's pixels, and no
    // more codes than the data holds bits for)
    let codes = 0;
    const maxCodes = data.length * 8 / (min + 1) + 2;
    for (;;) {
      if (px.length > w * h || ++codes > maxCodes) throw new Error(`LZW data runs past the picture (${px.length} pixels, ${codes} codes)`);
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
    // a frame covers its rectangle; the rest is the picture as the frame before left it (disposal 1, the only one written)
    const canvas = frames.length ? frames[frames.length - 1].pixels.slice() : new Array(w * h).fill(0);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) canvas[(fy + y) * w + fx + x] = px[y * fw + x];
    frames.push({ pixels: canvas, delay, rect: [fx, fy, fw, fh] });
  }
  return { w, h, palette, frames, loop, comment };
}

(async () => {
const { encodeGif, gifFromFrames } = await import('../js/media/gif.js');
const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
// a small hand-built frame pair
{
  const a = Uint8Array.from([0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0, 1]), b = Uint8Array.from([4, 4, 4, 4, 0, 0, 0, 0, 2, 2, 2, 2]);
  const g = encodeGif({ width: 4, height: 3, palette, frames: [{ pixels: a, delay: 20 }, { pixels: b, delay: 7 }] });
  const d = decode(g);
  check('header and size', Buffer.from(g.slice(0, 6)).toString() === 'GIF89a' && d.w === 4 && d.h === 3);
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
// a frame covering part of the picture: placed where it says, the rest kept
{
  const a = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]), part = Uint8Array.from([4, 3]);
  const d = decode(encodeGif({ width: 3, height: 3, palette, frames: [{ pixels: a, delay: 5 }, { pixels: part, delay: 5, x: 1, y: 2, w: 2, h: 1 }] }));
  check('a part frame lands at its place and keeps the rest', d.frames[1].pixels.join() === '0,0,0,0,0,0,0,4,3' && d.frames[1].rect.join() === '1,2,2,1');
  let e = ''; try { encodeGif({ width: 3, height: 3, palette, frames: [{ pixels: part, delay: 5, x: 2, y: 2, w: 2, h: 1 }] }); } catch (x) { e = x.message; }
  check('a part frame outside the picture is refused', /size/.test(e), e);
}
// error cases
{
  let e = ''; try { encodeGif({ width: 2, height: 2, palette, frames: [{ pixels: new Uint8Array(3), delay: 1 }] }); } catch (x) { e = x.message; }
  check('a frame of the wrong size is refused', /size/.test(e), e);
  e = ''; try { encodeGif({ width: 1, height: 1, palette: new Array(257).fill([0, 0, 0]), frames: [] }); } catch (x) { e = x.message; }
  check('more than 256 colours is refused', /256/.test(e), e);
}
// a hand-built file, byte for byte: 2x1, black then white, 10 cs. Its LZW, worked by hand from the specification:
// minimum code size 2, so clear = 4, end = 5 and 3-bit codes; the codes are clear, 0, 1, end = 4, 0, 1, 5, packed
// least significant bit first: 4 | 0 << 3 | 1 << 6 | 5 << 9 = 0x0A44 -> bytes 0x44 0x0A.
{
  const want = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xFF, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x21, 0xFE, 3]), Buffer.from('Hi!'), Buffer.from([0]),
    Buffer.from([0x21, 0xF9, 4, 4, 10, 0, 0, 0]), Buffer.from([0x2C, 0, 0, 0, 0, 2, 0, 1, 0, 0]), Buffer.from([2, 2, 0x44, 0x0A, 0, 0x3B])]);
  const got = Buffer.from(encodeGif({ width: 2, height: 1, palette: [[0, 0, 0], [255, 255, 255]], frames: [{ pixels: Uint8Array.from([0, 1]), delay: 10 }], comment: 'Hi!' }));
  check('a hand-built 2x1 GIF with a comment, byte for byte', got.equals(want), got.toString('hex'));
}
// a comment longer than one sub-block (255 bytes) is split and read back whole
{
  const long = 'Freedoom: https://freedoom.github.io/ '.repeat(10);
  const d = decode(encodeGif({ width: 1, height: 1, palette, frames: [{ pixels: Uint8Array.from([1]), delay: 1 }], comment: long }));
  check('a long comment survives the sub-block split', d.comment === long && long.length > 255);
  check('no comment, no comment block', !decode(encodeGif({ width: 1, height: 1, palette, frames: [{ pixels: Uint8Array.from([1]), delay: 1 }] })).comment);
}
// gifFromFrames on the machine's own frames: true pixels scaled 2x, a repeated frame lengthens the one before it
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const m = s.shownMachine, rendered = [];
  const grab = () => { const f = m.render(); rendered.push({ width: f.width, height: f.height, data: Uint8Array.from(f.data), table: Array.from(f.table) }); };
  for (let i = 0; i < 40; i++) m.runFrame();
  grab(); grab();                       // the same picture twice
  m.poke(0x400, 0x41); m.runFrame(); grab();   // a changed one
  const g = gifFromFrames(rendered, { scale: 2, delay: 4, comment: 'CLOADM' });
  const d = decode(g.bytes), f = rendered[2];
  check('gifFromFrames: twice the size, two frames (the repeat merged: 8 cs), the comment', d.w === f.width * 2 && d.h === f.height * 2 && d.frames.length === 2
    && d.frames[0].delay === 8 && d.frames[1].delay === 4 && d.comment === 'CLOADM' && g.frames === 2, JSON.stringify({ w: d.w, h: d.h, n: d.frames.length, delays: d.frames.map((x) => x.delay) }));
  let same = true;
  for (let y = 0; y < d.h && same; y++) for (let x = 0; x < d.w; x++) {
    const c = f.table[f.data[(y >> 1) * f.width + (x >> 1)]] & 0xFFFFFF, p = d.palette[d.frames[1].pixels[y * d.w + x]];
    if (p[0] !== (c & 255) || p[1] !== (c >> 8 & 255) || p[2] !== (c >> 16 & 255)) { same = false; break; }
  }
  check('gifFromFrames: every pixel is the machine\'s own colour, each one a 2x2 block', same);
  check('gifFromFrames: the second frame holds only the rectangle that changed (one character cell, at 2x)', JSON.stringify(d.frames[1].rect) !== JSON.stringify([0, 0, d.w, d.h])
    && d.frames[1].rect[2] <= 2 * 16 && d.frames[1].rect[3] <= 2 * 16, JSON.stringify(d.frames[1].rect));
  let e = ''; try { gifFromFrames([]); } catch (x) { e = x.message; }
  check('gifFromFrames: no frames is refused', /no frames/.test(e));
}
console.log(fail ? `${fail} FAILED` : 'all gif checks passed');
process.exitCode = fail ? 1 : 0;
})();
