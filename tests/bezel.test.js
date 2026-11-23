// The og:image card (js/video/bezel.js): a machine's frame on a CRT, 1200 x 630, at most 16 colours, written by the
// shared js/media/png.js with the picture drawn by the shared js/video/card.js (tests/png-card.test.js tests those).
// Decoded here with Node's zlib, not the project's code. Checked: the size and the palette; the picture in the glass is
// cardPicture's, pixel for pixel; the caption ("cloadm.dev") is on the bezel's lip, and another caption changes only
// that; a frame of many colours still gives 16; bad text is refused. The committed img/og.png (tools/capture-og.js) is
// this card: everything but the picture is the renderer's, pixel for pixel.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

// an indexed PNG decoded without the project's code (filters 0 and 2, 4 or 8 bits) -> { width, height, depth, type, palette, pixels }
function decode(buf) {
  buf = Buffer.from(buf);
  let o = 8, ihdr, plte, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (buf.readUInt32BE(o + 8 + len) !== zlib.crc32(buf.subarray(o + 4, o + 8 + len))) throw new Error(`${type} CRC`);
    if (type === 'IHDR') ihdr = data; else if (type === 'PLTE') plte = data; else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8], type = ihdr[9];
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = Math.ceil(width * depth / 8), pixels = new Uint8Array(width * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xFF;
    else if (f !== 0) throw new Error(`filter ${f}`);
    for (let x = 0; x < width; x++) pixels[y * width + x] = depth === 8 ? line[x] : (line[x >> 1] >> (x & 1 ? 0 : 4)) & 0xF;
    prev = line;
  }
  const palette = [];
  for (let i = 0; i < plte.length; i += 3) palette.push([plte[i], plte[i + 1], plte[i + 2]]);
  return { width, height, depth, type, palette, pixels };
}
const at = (d, x, y) => d.palette[d.pixels[y * d.width + x]].join(',');

(async () => {
  const { bezelPicture, renderBezelCard, SCREEN } = await import('../js/video/bezel.js');

  // a VDG-shaped frame: 320 x 240 with the 256 x 192 picture area at (32, 24), a pattern that changes every pixel
  const frame = new Emu.Frame(320, 240, 4 / 3, { x: 32, y: 24, width: 256, height: 192 });
  const cols = [[0, 0, 0], [48, 216, 43], [242, 234, 74], [42, 53, 232], [216, 32, 42], [0, 59, 0]];
  cols.forEach(([r, g, b], i) => { frame.table[i] = Emu.rgb(r, g, b); });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) frame.data[y * 320 + x] = (x * 7 + y * 3) % cols.length;
  const png = await renderBezelCard(frame), d = decode(png);
  check('bezel: 1200 x 630, indexed, 4 bits a pixel, at most 16 colours, under 32 KB', d.width === 1200 && d.height === 630 && d.type === 3 && d.depth === 4
    && d.palette.length <= 16 && png.length <= 32768, `${d.palette.length} colours, ${png.length} bytes`);
  check('bezel: readPngHeader takes it (every CRC, IHDR first, IEND last)', Emu.readPngHeader(png).chunks.join() === 'IHDR,PLTE,IDAT,IEND');
  // the glass holds cardPicture's picture of the frame, pixel for pixel
  const shot = Emu.cardPicture(frame, SCREEN.w, SCREEN.h);
  let wrong = 0;
  for (let j = 0; j < SCREEN.h; j++) for (let i = 0; i < SCREEN.w; i++) if (at(d, SCREEN.x + i, SCREEN.y + j) !== shot.palette[shot.pixels[j * SCREEN.w + i]].join()) wrong++;
  check('bezel: the glass holds cardPicture\'s picture of the frame, pixel for pixel', wrong === 0, `${wrong} pixels differ`);
  check('bezel: the frame\'s picture area is scaled 2x (512 x 384) in it', at(d, SCREEN.x + 64, SCREEN.y + 48) === cols[(32 * 7 + 24 * 3) % 6].join()
    && at(d, SCREEN.x + 66, SCREEN.y + 48) === cols[(33 * 7 + 24 * 3) % 6].join(), `${at(d, SCREEN.x + 64, SCREEN.y + 48)} ${at(d, SCREEN.x + 66, SCREEN.y + 48)}`);
  check('bezel: outside the glass are the bezel and the ground', at(d, 40, 300) === '58,63,61' && at(d, 5, 5) === '11,13,12' && at(d, 100, 600) === '28,32,30',
    `${at(d, 40, 300)} ${at(d, 5, 5)} ${at(d, 100, 600)}`);

  // the caption: on the lip, under the glass, in phosphor green; another caption changes that and nothing else
  const c = bezelPicture(frame), green = c.palette.findIndex((p) => p.join() === '61,245,90');
  const lip = (p) => { const out = []; for (let y = 585; y < 612; y++) for (let x = 60; x < 760; x++) out.push(p.pixels[y * 1200 + x]); return out; };
  check('bezel: "cloadm.dev" is drawn on the lip in phosphor green', lip(c).filter((v) => v === green).length > 300);
  const other = bezelPicture(frame, { caption: 'cloadm.dev/2048/' });
  check('bezel: another caption changes the lip and nothing above it', lip(other).join() !== lip(c).join()
    && Buffer.from(other.pixels.subarray(0, 580 * 1200)).equals(Buffer.from(c.pixels.subarray(0, 580 * 1200))));
  check('bezel: a caption outside the font (ASCII 0x20-0x7E) is refused', throws(() => bezelPicture(frame, { caption: 'café' }), /no glyph/));
  check('bezel: a caption too long for the bezel is refused', throws(() => bezelPicture(frame, { caption: 'x'.repeat(60) }), /too long/));

  // a frame of many colours (a CoCo 3's): still 16, each of the rest drawn in the nearest kept
  const many = new Emu.Frame(256, 192);
  for (let i = 0; i < 64; i++) many.table[i] = Emu.rgb((i & 3) * 85, ((i >> 2) & 3) * 85, ((i >> 4) & 3) * 85);
  for (let k = 0; k < many.data.length; k++) many.data[k] = k % 64;
  const dm = decode(await renderBezelCard(many));
  check('bezel: 64 colours in the frame, 16 in the card', dm.palette.length === 16 && dm.depth === 4, String(dm.palette.length));

  // the committed og:image is this card: all but the glass's picture matches, pixel for pixel
  const og = decode(fs.readFileSync(path.join(__dirname, '..', 'img', 'og.png')));
  let off = 0;
  for (let y = 0; y < 630; y++) for (let x = 0; x < 1200; x++) {
    if (x >= SCREEN.x && x < SCREEN.x + SCREEN.w && y >= SCREEN.y && y < SCREEN.y + SCREEN.h) continue;
    if (at(og, x, y) !== at(d, x, y)) off++;
  }
  check('img/og.png: 1200 x 630, at most 16 colours; the bezel, "cloadm.dev" and the name are this renderer\'s',
    og.width === 1200 && og.height === 630 && og.palette.length <= 16 && off === 0, `${off} pixels differ, ${og.palette.length} colours`);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
