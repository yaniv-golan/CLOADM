// The program pages (cloadm.dev/2048/, /liza/, /minesweeper/: tools/program-cards.js) and the PNG and card code their
// pictures are made with (js/media/png.js, js/video/card.js).
//  * the committed pages are what the tool writes, byte for byte; the committed cards hold the same picture it makes
//    (decoded here with Node's zlib, not the project's code, so another zlib's bytes don't matter)
//  * each page: its own title, description and 1200 x 630 og:image, and it sends the visitor to /play/?start=<program>,
//    a start the page has; the service worker keeps them for offline use
//  * PNG: a hand-built picture whose file bytes are worked out here from the specification (filter Up, 4-bit
//    packing, chunk CRCs from zlib), 8-bit palettes, and readPngHeader's refusals
//  * card: the picture area scaled by a whole number and centred on the border colour, the frame's own colours
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Emu = require('./load')();
const ROOT = path.join(__dirname, '..');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// a PNG decoded without the project's code: chunks, IHDR, PLTE, IDAT inflated and unfiltered (types 0 and 2 only:
// the ones the encoder writes; anything else is reported) -> { width, height, depth, type, palette, pixels }
function decode(buf) {
  buf = Buffer.from(buf);
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('signature');
  let o = 8, ihdr, plte, idat = [];
  const types = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (buf.readUInt32BE(o + 8 + len) !== zlib.crc32(buf.subarray(o + 4, o + 8 + len))) throw new Error(`${type} CRC`);
    types.push(type);
    if (type === 'IHDR') ihdr = data; else if (type === 'PLTE') plte = data; else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8], type = ihdr[9];
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = Math.ceil(width * depth / 8);
  const pixels = new Uint8Array(width * height);
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
  return { width, height, depth, type, palette, pixels, types, raw };
}
// a picture as colours: what a viewer sees, whatever the palette's order
const colours = (d) => Array.from(d.pixels, (i) => d.palette[i].join(','));

(async () => {
  const tool = require('../tools/program-cards.js');
  const made = await tool.build();

  // ---------------- the committed pages and cards are the tool's ----------------
  for (const name of tool.NAMES) {
    const html = fs.readFileSync(path.join(ROOT, name, 'index.html'), 'utf8');
    check(`${name}: the committed page is what tools/program-cards.js writes`, html === made[`${name}/index.html`]);
    const card = fs.readFileSync(path.join(ROOT, 'img', `card-${name}.png`));
    const a = decode(card), b = decode(made[`img/card-${name}.png`]);
    const ca = colours(a), cb = colours(b);
    check(`${name}: the committed card is the picture the tool makes (decoded, colour by colour)`, a.width === b.width && a.height === b.height
      && ca.length === cb.length && ca.every((c, i) => c === cb[i]));
    check(`${name}: the card is 1200 x 630, indexed, 16 colours or fewer, under 32 KB`, a.width === 1200 && a.height === 630 && a.type === 3 && a.palette.length <= 16 && card.length <= 32768,
      `${a.palette.length} colours, ${card.length} bytes`);
    const meta = (prop) => { const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html); return m && m[1]; };
    const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1];
    check(`${name}: its own og:title, og:description, og:url and og:image, a large-image card`,
      meta('og:title') === title && /CLOADM$/.test(title) && meta('og:description').length > 40 && meta('description') === meta('og:description')
      && meta('og:url') === `https://cloadm.dev/${name}/` && meta('og:image') === `https://cloadm.dev/img/card-${name}.png`
      && meta('og:image:width') === '1200' && meta('og:image:height') === '630' && meta('twitter:card') === 'summary_large_image', title);
    const to = `../play/?start=${name}`;
    check(`${name}: it sends the visitor to /play/?start=${name} (a script that keeps a fragment, and a refresh without one)`,
      html.includes(`<meta http-equiv="refresh" content="0; url=${to}">`) && html.includes(`location.replace('${to}' + location.hash)`) && html.includes(`<a href="${to}">`));
    const cfg = Emu.parseUrlConfig(`?start=${name}`);
    check(`${name}: start=${name} is a start the page has`, cfg.start === name && !cfg.errors.length, JSON.stringify(cfg.errors));
  }
  const titles = tool.NAMES.map((n) => tool.PROGRAMS[n].title), images = new Set(tool.NAMES.map((n) => fs.readFileSync(path.join(ROOT, 'img', `card-${n}.png`)).toString('base64')));
  check('every page has a title and a picture of its own', new Set(titles).size === titles.length && images.size === titles.length);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  check('the service worker keeps the pages and their cards', tool.NAMES.every((n) => sw.includes(`'${n}/'`) && sw.includes(`'${n}/index.html'`) && sw.includes(`'img/card-${n}.png'`)));

  // ---------------- PNG: a hand-built picture ----------------
  {
    // 3 x 2, palette black, red, white: row 0 = 0 1 2, row 1 = 2 2 0. 4-bit: row 0 packs to 01 20, row 1 to 22 00.
    // Filter Up: row 0 less a row of zeroes = 01 20; row 1 less row 0 = (22-01) (00-20) = 21 E0.
    const bytes = await Emu.encodeIndexedPng({ width: 3, height: 2, pixels: Uint8Array.from([0, 1, 2, 2, 2, 0]), palette: [[0, 0, 0], [255, 0, 0], [255, 255, 255]] });
    const d = decode(bytes);
    check('PNG: the chunks are IHDR, PLTE, IDAT, IEND, every CRC right', d.types.join() === 'IHDR,PLTE,IDAT,IEND');
    check('PNG: IHDR 3 x 2, bit depth 4 (a palette of 16 or fewer), colour type 3, no interlace',
      Buffer.from(bytes.subarray(16, 29)).equals(Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 4, 3, 0, 0, 0])));
    // (the signature, 8 bytes, then IHDR: 4 length + 4 type + 13 + 4 CRC = 33; PLTE's data after its length and type)
    check('PNG: PLTE holds the colours in order', Buffer.from(bytes.subarray(41, 50)).equals(Buffer.from([0, 0, 0, 255, 0, 0, 255, 255, 255])));
    check('PNG: the rows as worked out by hand (filter Up, two pixels a byte)', d.raw.equals(Buffer.from([2, 0x01, 0x20, 2, 0x21, 0xE0])), d.raw.toString('hex'));
    const head = Emu.readPngHeader(bytes);
    check('readPngHeader: size, depth, type and palette', head.width === 3 && head.height === 2 && head.depth === 4 && head.colourType === 3 && head.interlace === 0
      && JSON.stringify(head.palette) === '[[0,0,0],[255,0,0],[255,255,255]]' && head.chunks.join() === 'IHDR,PLTE,IDAT,IEND');
    // 17 colours: 8 bits a pixel
    const big = await Emu.encodeIndexedPng({ width: 17, height: 1, pixels: Uint8Array.from({ length: 17 }, (_, i) => i), palette: Array.from({ length: 17 }, (_, i) => [i, i, i]) });
    const db = decode(big);
    check('PNG: 17 colours are 8 bits a pixel, and read back', db.depth === 8 && Array.from(db.pixels).join() === Array.from({ length: 17 }, (_, i) => i).join());
    check('PNG: a pixel past the palette is refused', await Emu.encodeIndexedPng({ width: 1, height: 1, pixels: Uint8Array.from([3]), palette: [[0, 0, 0]] }).then(() => false, (e) => e instanceof Emu.PngError));
    const crcBad = Uint8Array.from(bytes); crcBad[20] ^= 1;
    const cut = bytes.subarray(0, bytes.length - 6);
    const noIhdr = Uint8Array.from(bytes); noIhdr.set([0x50, 0x4C, 0x54, 0x45], 12);
    const extra = Uint8Array.from([...bytes, 0]);
    for (const [what, b, re] of [['not a PNG', Uint8Array.from([1, 2, 3]), /not a PNG/], ['a damaged IHDR', crcBad, /IHDR chunk is damaged/], ['cut short', cut, /cut short|IEND/],
      ['IHDR not first', noIhdr, /damaged|first chunk/], ['bytes after IEND', extra, /IEND/]]) {
      const e = throws(() => Emu.readPngHeader(b));
      check(`readPngHeader refuses: ${what}`, e instanceof Emu.PngError && re.test(e.message), e ? e.message : 'accepted');
    }
  }

  // ---------------- card ----------------
  {
    // a 20 x 10 frame with a 4 x 2 picture area at (8, 4): border code 7, area codes 1 and 2
    const f = new Emu.Frame(20, 10, 2, { x: 8, y: 4, width: 4, height: 2 });
    f.data.fill(7);
    f.data.set([1, 2, 1, 2], 4 * 20 + 8); f.data.set([2, 2, 1, 1], 5 * 20 + 8);
    f.table[7] = Emu.rgb(1, 2, 3); f.table[1] = Emu.rgb(200, 0, 0); f.table[2] = Emu.rgb(0, 0, 200);
    const c = Emu.cardPicture(f, 30, 15);
    // 30 / 4 = 7, 15 / 2 = 7: scaled 7 times, 28 x 14, at (1, 0)
    const at = (x, y) => c.palette[c.pixels[y * 30 + x]].join(',');
    check('card: the border colour first and around the picture', c.palette.length === 3 && c.palette[0].join() === '1,2,3' && at(0, 0) === '1,2,3' && at(29, 14) === '1,2,3');
    check('card: the picture area scaled by the largest whole number that fits, centred', at(1, 0) === '200,0,0' && at(7, 6) === '200,0,0' && at(8, 0) === '0,0,200'
      && at(28, 0) === '0,0,200' && at(1, 7) === '0,0,200' && at(28, 13) === '200,0,0' && at(1, 14) === '1,2,3');
    // a frame without a fixed area whose pixels are half as wide as tall (the GIME's 640 x 240, 4:3): rows doubled
    const g = new Emu.Frame(8, 3, 4 / 3);
    g.data.set([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
    g.table[0] = Emu.rgb(9, 9, 9); g.table[1] = Emu.rgb(1, 1, 1); g.table[2] = Emu.rgb(2, 2, 2);
    const h = Emu.cardPicture(g, 16, 12);
    const hat = (x, y) => h.palette[h.pixels[y * 16 + x]].join(',');
    check('card: pixels half as wide as tall are shown twice as tall', hat(0, 0) === '1,1,1' && hat(0, 3) === '1,1,1' && hat(0, 4) === '2,2,2' && hat(0, 7) === '2,2,2' && hat(0, 8) === '9,9,9');
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
