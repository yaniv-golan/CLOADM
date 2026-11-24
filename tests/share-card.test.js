// The share card (js/video/bezel.js shareCardPicture / renderShareCard): the Share screen's "Save picture" and a short
// link's preview picture, one renderer. Decoded here with Node's zlib, not the project's code. Checked: the card is
// 1200 x 630 (at least 1200 wide); the picture in the glass is the frame at true pixels, every pixel compared with
// frameToRGBA's colour for the frame pixel it shows (the place worked out here from the frame's shape, not taken from
// the renderer), on a VDG-shaped frame of 40 colours and a GIME-shaped one; the name beside the monitor is drawn, glyph
// by glyph from the chat font, at the largest size that fits; "cloadm.dev" is on the lip and no other words are drawn;
// a long or non-ASCII name is made drawable; and the Session's sharePicture and previewPicture are this card.
const zlib = require('zlib');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

// an indexed PNG decoded without the project's code (filters 0 and 2, 4 or 8 bits) -> { width, height, palette, pixels }
function decode(buf) {
  buf = Buffer.from(buf);
  let o = 8, ihdr, plte, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = data; else if (type === 'PLTE') plte = data; else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8];
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
  return { width, height, palette, pixels };
}
const at = (d, x, y) => d.palette[d.pixels[y * d.width + x]].join(',');
const rgbaOf = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF].join(',');

(async () => {
  const { renderShareCard, shareCardPicture, SCREEN, NAME_ROOM } = await import('../js/video/bezel.js');
  const { GLYPHS } = await import('../js/video/chat-font.js');

  // the picture in the glass, pixel for pixel against frameToRGBA: the frame's picture area scaled by the largest whole
  // number that fits SCREEN (a GIME line shown twice as tall), centred. Worked out here from the frame's shape.
  const exactIn = (d, frame) => {
    const a = frame.active || { x: 0, y: 0, width: frame.width, height: frame.height }, px = Emu.frameToRGBA(frame);
    const tall = Math.max(1, Math.round(frame.width / (frame.aspect * frame.height)));
    const k = Math.min(Math.floor(SCREEN.w / a.width), Math.floor(SCREEN.h / (a.height * tall)));
    const w = a.width * k, h = a.height * k * tall, x0 = (SCREEN.w - w) >> 1, y0 = (SCREEN.h - h) >> 1;
    let bad = 0, n = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      n++;
      if (at(d, SCREEN.x + x0 + i, SCREEN.y + y0 + j) !== rgbaOf(px[(a.y + Math.floor(j / (k * tall))) * frame.width + a.x + Math.floor(i / k)])) bad++;
    }
    return { bad, n, k };
  };

  // a VDG-shaped frame of 40 colours (more than a link preview's 16): a saved picture keeps every one exactly
  const vdg = new Emu.Frame(320, 240, 4 / 3, { x: 32, y: 24, width: 256, height: 192 });
  for (let c = 0; c < 40; c++) vdg.table[c] = Emu.rgb((c * 37) & 0xFF, (c * 91) & 0xFF, (c * 53 + 7) & 0xFF);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) vdg.data[y * 320 + x] = (x * 7 + y * 3) % 40;
  const png = await renderShareCard(vdg, { name: 'Dragon 64' }), d = decode(png);
  check('share card: 1200 x 630, so at least 1200 wide', d.width === 1200 && d.height === 630 && d.width >= 1200, `${d.width} x ${d.height}`);
  const e = exactIn(d, vdg);
  check('share card: every pixel of a 40-colour VDG picture is frameToRGBA\'s colour, at true pixels (2x)', e.bad === 0 && e.n === 512 * 384 && e.k === 2, JSON.stringify(e));
  check('share card: readPngHeader takes it', Emu.readPngHeader(png).chunks.join() === 'IHDR,PLTE,IDAT,IEND');

  // a GIME-shaped frame (640 x 240, each line shown twice as tall), 64 colours
  const gime = new Emu.Frame(640, 240, 4 / 3, { x: 0, y: 12, width: 640, height: 216 });
  for (let c = 0; c < 64; c++) gime.table[c] = Emu.rgb(((c >> 4) & 3) * 85, ((c >> 2) & 3) * 85, (c & 3) * 85);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 640; x++) gime.data[y * 640 + x] = (x + y * 5) % 64;
  const dg = decode(await renderShareCard(gime, { name: 'CoCo 3' })), eg = exactIn(dg, gime);
  check('share card: every pixel of a 64-colour GIME picture is frameToRGBA\'s colour, at true pixels (1x, lines doubled)', eg.bad === 0 && eg.n === 640 * 432, JSON.stringify(eg));

  // the name, beside the monitor: each glyph of the chat font drawn at the largest of 7..3 card pixels a font pixel that
  // fits the room, in the card's text colour on its ground; checked bit by bit against the font, the size worked out here
  const nameAt = (dd, name) => {
    const s = [7, 6, 5, 4, 3].find((z) => name.length * 6 * z <= NAME_ROOM);
    let bad = 0;
    [...name].forEach((ch, k) => GLYPHS[ch].split(' ').map((h) => parseInt(h, 16)).forEach((row, j) => {
      for (let i = 0; i < 6; i++) {
        const on = (row >> (5 - i)) & 1, c = at(dd, 830 + (k * 6 + i) * s + 1, 236 + j * s + 1);
        if (c !== (on ? '201,204,196' : '11,13,12')) bad++;
      }
    }));
    return { s, bad };
  };
  const n1 = nameAt(d, 'Dragon 64');
  check('share card: the machine\'s name "Dragon 64" is drawn beside the monitor, glyph by glyph, at 6 card pixels a font pixel (the largest that fits)', n1.bad === 0 && n1.s === 6, JSON.stringify(n1));
  const prog = decode(await renderShareCard(vdg, { name: 'Minesweeper' })), n2 = nameAt(prog, 'Minesweeper');
  check('share card: a program\'s name ("Minesweeper") in the largest size that fits (5)', n2.bad === 0 && n2.s === 5, JSON.stringify(n2));
  // "cloadm.dev" on the lip, centred under the glass, and no words but the name and it: below the name's line and
  // above the lip, the side column is the ground only
  const lip = (dd) => { let bad = 0; const cap = 'cloadm.dev', x0 = 30 + Math.round((760 - cap.length * 18) / 2), y0 = 51 + 528 + 6;
    [...cap].forEach((ch, k) => GLYPHS[ch].split(' ').map((h) => parseInt(h, 16)).forEach((row, j) => { for (let i = 0; i < 6; i++) if (((row >> (5 - i)) & 1) && at(dd, x0 + (k * 6 + i) * 3 + 1, y0 + j * 3 + 1) !== '61,245,90') bad++; })); return bad; };
  let words = 0;
  for (let y = 300; y < 630; y++) for (let x = 830; x < 1200; x++) if (at(d, x, y) !== '11,13,12') words++;
  check('share card: "cloadm.dev" on the lip, and no other words (no URL, no tagline) beside the monitor', lip(d) === 0 && words === 0, `${lip(d)} caption pixels wrong, ${words} pixels drawn under the name`);
  // another name changes only the name's place
  let outside = 0;
  for (let y = 0; y < 630; y++) for (let x = 0; x < 1200; x++) if (at(d, x, y) !== at(prog, x, y) && !(x >= 830 && y >= 236 && y < 236 + 8 * 7)) outside++;
  check('share card: another name changes only the name\'s place', outside === 0, `${outside} pixels`);
  // names the font can't draw as they are
  const long = decode(await renderShareCard(vdg, { name: 'A machine with a name far longer than the room beside the monitor' })), nl = nameAt(long, 'A machine with a...');
  const accent = decode(await renderShareCard(vdg, { name: 'Prológica CP-400' })), n3 = nameAt(accent, 'Prologica CP-400');
  check('share card: a name too long even at the smallest size is cut with "...", and a letter outside the font is drawn plain ("Prológica" -> "Prologica")',
    nl.bad === 0 && nl.s === 3 && n3.bad === 0, JSON.stringify({ nl, n3 }));

  // the colours a link preview may hold: 16. A picture whose colours don't all fit is not exact (the Session then sends
  // no preview); a few colours are exact, and the same card.
  check('share card at 16 colours: a 40-colour picture is not exact, a 4-colour one is', !shareCardPicture(vdg, { name: 'x', colours: 16 }).exact
    && (() => { const f = new Emu.Frame(320, 240, 4 / 3, vdg.active); for (let c = 0; c < 4; c++) f.table[c] = Emu.rgb(c * 60, 200, 0); for (let i = 0; i < f.data.length; i++) f.data[i] = i % 4; return shareCardPicture(f, { name: 'x', colours: 16 }).exact; })());

  // the Session: "Save picture" (sharePicture) and the short link's preview (previewPicture) are this card of the shown
  // machine's frame, named for the machine; the preview is the same picture, pixel for pixel
  const s = new Emu.Session(); s.switchMachine('dragon64');
  for (let i = 0; i < 3; i++) s.shownMachine.runFrame();
  const saved = decode(await s.sharePicture()), preview = decode(await s.previewPicture()), frame = s.shownMachine.render();
  let diff = 0;
  for (let i = 0; i < saved.pixels.length; i++) if (saved.palette[saved.pixels[i]].join() !== preview.palette[preview.pixels[i]].join()) diff++;
  check('Session: sharePicture is the share card of the shown frame, named "Dragon 64", every picture pixel exact', saved.width === 1200 && exactIn(saved, frame).bad === 0 && nameAt(saved, 'Dragon 64').bad === 0);
  check('Session: previewPicture (the short link\'s) is the same card, pixel for pixel, at 16 colours or fewer', diff === 0 && preview.palette.length <= 16, `${diff} pixels differ`);
  check('Session: shareCardName is the machine\'s name without "Tandy"', (() => { const t = new Emu.Session(); t.switchMachine('coco2'); return t.shareCardName(null) === t.shownMachine.profile.name.replace(/^Tandy /, ''); })());

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
