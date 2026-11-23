// The link preview card (js/video/card.js renderCard, js/media/png.js): a 1200x630 PNG of at most 16 colours, a
// machine's frame in a CRT bezel with the caption on it, made without a browser. The PNG is decoded here
// independently (chunks and CRCs read by hand, the zlib stream through js/media/zip.js's inflate), and its pixels are
// checked against the frame they came from: the picture is the frame's own colours, nearest-neighbour; the caption is
// drawn on the bezel and changes with it; a frame of many colours still gives 16. The committed img/og.png is such a
// card (tools/capture-og.js): its bezel, caption and name are the renderer's, pixel for pixel.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

(async () => {
  const { renderCard, cardPixels, CARD_W, CARD_H } = await import('../js/video/card.js');
  const { deflate, encodeIndexedPng } = await import('../js/media/png.js');
  const { inflate } = await import('../js/media/zip.js');
  const { crc32 } = await import('../js/util.js');

  // ---- an independent PNG reader: indexed, filter 0 rows (what the encoder writes; anything else is a failure) ----
  const decode = (png) => {
    const b = Buffer.from(png);
    if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) throw new Error('no PNG signature');
    let o = 8, ihdr, plte, idat = [], crcOk = true;
    const types = [];
    while (o < b.length) {
      const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
      if (parseInt(crc32(b.subarray(o + 4, o + 8 + len)), 16) !== b.readUInt32BE(o + 8 + len)) crcOk = false;
      types.push(type);
      if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
      if (type === 'PLTE') plte = [...Array(len / 3)].map((_, i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
      if (type === 'IDAT') idat.push(data);
      o += 12 + len;
    }
    const z = Buffer.concat(idat), per = 8 / ihdr.depth, stride = Math.ceil(ihdr.w / per);
    if ((z[0] & 0x0F) !== 8 || ((z[0] << 8) | z[1]) % 31) throw new Error('not a zlib deflate stream');
    const raw = inflate(z.subarray(2, z.length - 4), (stride + 1) * ihdr.h);
    let a = 1, s2 = 0; for (const v of raw) { a = (a + v) % 65521; s2 = (s2 + a) % 65521; }
    const adlerOk = (((s2 << 16) | a) >>> 0) === z.readUInt32BE(z.length - 4);
    const px = new Uint8Array(ihdr.w * ihdr.h);
    let filtersOk = true;
    for (let y = 0; y < ihdr.h; y++) {
      if (raw[y * (stride + 1)] !== 0) filtersOk = false;
      for (let x = 0; x < ihdr.w; x++) px[y * ihdr.w + x] = (raw[y * (stride + 1) + 1 + Math.floor(x / per)] >> (8 - ihdr.depth * (1 + (x % per)))) & ((1 << ihdr.depth) - 1);
    }
    return { ihdr, plte, px, crcOk, adlerOk, filtersOk, types };
  };
  const rgbOf = (d, x, y) => d.plte[d.px[y * d.ihdr.w + x]].join(',');

  // ---- 1. deflate: round trips through the inflate CLOADM already has, and compresses what repeats ----
  for (const [what, bytes] of [['empty', new Uint8Array(0)], ['one byte', Uint8Array.of(7)],
    ['a repeating pattern', new Uint8Array(100000).map((_, i) => (i * 7) % 13)], ['noise', new Uint8Array(40000).map((_, i) => (i * 2654435761 >>> 13) & 0xFF)]]) {
    const d = deflate(bytes);
    check(`deflate: ${what} inflates back to the same bytes`, Buffer.from(inflate(d, bytes.length)).equals(Buffer.from(bytes)));
  }
  check('deflate: a repeating pattern shrinks at least 10 times', deflate(new Uint8Array(100000).map((_, i) => (i * 7) % 13)).length < 10000);

  // ---- 2. a machine frame: the welcome-style picture of a few colours ----
  const frame = new Emu.Frame(320, 240);
  const cols = [[0, 0, 0], [48, 216, 43], [242, 234, 74], [42, 53, 232], [216, 32, 42], [0, 59, 0]];
  cols.forEach(([r, g, b], i) => { frame.table[i] = Emu.rgb(r, g, b); });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) frame.data[y * 320 + x] = (x * 7 + y * 3) % cols.length;   // (changes every row and column: a picture off by one pixel shows)
  const png = renderCard(frame), d = decode(png);
  check('card: 1200x630, indexed (colour type 3), not interlaced', d.ihdr.w === CARD_W && d.ihdr.h === CARD_H && CARD_W === 1200 && CARD_H === 630 && d.ihdr.colour === 3 && d.ihdr.interlace === 0, JSON.stringify(d.ihdr));
  check('card: at most 16 colours (PLTE), 4 bits a pixel or fewer', d.plte.length <= 16 && d.ihdr.depth <= 4, `${d.plte.length} colours, ${d.ihdr.depth} bits`);
  check('card: chunks IHDR PLTE IDAT IEND, every CRC right, the Adler-32 right, rows unfiltered', d.types.join() === 'IHDR,PLTE,IDAT,IEND' && d.crcOk && d.adlerOk && d.filtersOk, d.types.join());
  const c = cardPixels(frame);
  check('card: the PNG holds exactly the pixels cardPixels drew', Buffer.from(d.px).equals(Buffer.from(c.pixels)));
  // the picture: the frame at 640x480 in the glass, each card pixel the frame's colour at that spot
  const SX = 90, SY = 75;
  let wrong = 0;
  for (let j = 0; j < 480; j += 7) for (let i = 0; i < 640; i += 5) {
    const v = frame.table[frame.data[(j >> 1) * 320 + (i >> 1)]];
    if (rgbOf(d, SX + i, SY + j) !== [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF].join(',')) wrong++;
  }
  check('card: the picture is the frame\'s own colours, scaled 2x in the glass', wrong === 0, `${wrong} pixels differ`);
  check('card: outside the glass is the bezel, not the frame', rgbOf(d, 40, 300) === '58,63,61' && rgbOf(d, 5, 5) === '11,13,12', `${rgbOf(d, 40, 300)} ${rgbOf(d, 5, 5)}`);
  // { width, height, rgba } gives the same card as the frame itself
  const rgba = Emu.frameToRGBA(frame);
  check('card: an RGBA frame gives the same card', Buffer.from(renderCard({ width: 320, height: 240, rgba })).equals(Buffer.from(png)));

  // ---- 3. the caption: on the bezel, under the glass, in the phosphor green; another caption changes it ----
  const capBox = (px) => { const out = []; for (let y = 585; y < 610; y++) for (let x = 60; x < 760; x++) out.push(px[y * CARD_W + x]); return out; };
  const green = c.palette.findIndex((p) => p.join() === '61,245,90');
  check('card: "cloadm.dev" is drawn on the bezel in phosphor green', capBox(c.pixels).filter((v) => v === green).length > 300);
  const other = cardPixels(frame, { caption: 'cloadm.dev/2048/' });
  check('card: another caption draws other pixels there, and only there and nowhere in the picture',
    capBox(other.pixels).join() !== capBox(c.pixels).join() && Buffer.from(other.pixels.subarray(0, 580 * CARD_W)).equals(Buffer.from(c.pixels.subarray(0, 580 * CARD_W))));
  const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
  check('card: a caption outside the font (ASCII 0x20-0x7E) is refused', throws(() => renderCard(frame, { caption: 'café' }), /no glyph/));
  check('card: a caption too long for the bezel is refused', throws(() => renderCard(frame, { caption: 'x'.repeat(60) }), /too long/));
  check('card: a frame without pixels is refused', throws(() => renderCard({ width: 320, height: 240 }), /a frame is/));

  // ---- 4. a frame of many colours (a CoCo 3 picture): still 16, each pixel the nearest kept ----
  const many = new Emu.Frame(256, 192);
  for (let i = 0; i < 64; i++) many.table[i] = Emu.rgb((i & 3) * 85, ((i >> 2) & 3) * 85, ((i >> 4) & 3) * 85);
  for (let k = 0; k < many.data.length; k++) many.data[k] = k % 64;
  const dm = decode(renderCard(many));
  check('card: 64 colours in the frame, 16 in the card', dm.plte.length === 16 && dm.ihdr.depth === 4, String(dm.plte.length));
  check('encodeIndexedPng: a pixel past the palette is refused', throws(() => encodeIndexedPng(2, 1, [[0, 0, 0]], Uint8Array.of(0, 1)), /past the palette/));

  // ---- 5. the committed og:image is this renderer's card: everything but the picture matches, pixel for pixel ----
  const og = decode(fs.readFileSync(path.join(__dirname, '..', 'img', 'og.png')));
  check('img/og.png: 1200x630, at most 16 colours', og.ihdr.w === 1200 && og.ihdr.h === 630 && og.plte.length <= 16 && og.crcOk && og.adlerOk);
  let off = 0;
  for (let y = 0; y < CARD_H; y += 3) for (let x = 0; x < CARD_W; x += 3) {
    if (x >= SX && x < SX + 640 && y >= SY && y < SY + 480) continue;   // the picture itself: the welcome menu's
    if (rgbOf(og, x, y) !== rgbOf(d, x, y)) off++;
  }
  check('img/og.png: the bezel, the caption "cloadm.dev" and the name are renderCard\'s', off === 0, `${off} pixels differ`);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
