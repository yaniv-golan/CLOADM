/*
 * The link preview card: a 1200x630 picture of a machine's screen in a CRT bezel, with the caption (by default
 * "cloadm.dev") on the bezel and the name beside it, as a PNG of at most 16 colours. No canvas and no browser
 * (js/media/png.js writes the file), so the same card is made in Node (tools/capture-og.js, the site's og:image) and in
 * a page. The only pixels drawn are the frame's (what the emulated machine shows: the welcome menu on CLOADM's own
 * firmware for the og:image, never a ROM's screen) and the card's own shapes and text, in the chat terminal's
 * original font (js/video/chat-font.js).
 *   renderCard(frame, { caption, name, lines }) -> PNG bytes
 *     frame: a machine frame ({ width, height, data: colour codes, table: code -> RGBA }, js/video/frame.js), or
 *            { width, height, rgba: Uint32Array } (little-endian RGBA, as frameToRGBA gives)
 *     caption: the line on the bezel ('cloadm.dev'); name: the title beside the monitor ('CLOADM'), lines: the words
 *     under it (CARD_LINES). Characters outside the font's ASCII 0x20-0x7E are refused.
 *   cardPixels(frame, opts) -> { width, height, palette, pixels } (the indexed picture before it is a PNG)
 */
import { GLYPHS } from './chat-font.js';
import { encodeIndexedPng } from '../media/png.js';

export const CARD_W = 1200, CARD_H = 630, CARD_COLOURS = 16;
export const CARD_LINES = ['Dragon and Tandy', 'Color Computer', 'emulator, in your', 'browser.'];
// the card's own colours (css/tokens.css): the ground, the bezel's two greys, the glass, the phosphor green, the text
const OWN = { ground: [0x0B, 0x0D, 0x0C], bezel: [0x3A, 0x3F, 0x3D], shade: [0x1C, 0x20, 0x1E], glass: [0, 0, 0],
  phosphor: [0x3D, 0xF5, 0x5A], text: [0xC9, 0xCC, 0xC4] };
const KEYS = Object.keys(OWN);
// where things go (pixels of the card)
const BEZEL = { x: 30, y: 15, w: 760, h: 600, r: 44 };
const GLASS = { x: 66, y: 51, w: 688, h: 528, r: 36 };
const SCREEN = { w: 640, h: 480 };   // the frame at 4:3, nearest-neighbour
const SIDE = 830;                     // the name's column

const glyph = (ch) => {
  const hex = GLYPHS[ch];
  if (!hex) throw new Error(`card: no glyph for ${JSON.stringify(ch)} (the font has ASCII 0x20-0x7E)`);
  return hex.split(' ').map((h) => parseInt(h, 16));
};

// the frame as RGB triples, whichever form it came in
function frameRgb(frame) {
  const { width, height } = frame;
  if (!(width > 0 && height > 0)) throw new Error('card: a frame needs a width and a height');
  const n = width * height, out = new Array(n);
  const px = frame.rgba || null;
  if (!px && !(frame.data && frame.table)) throw new Error('card: a frame is { width, height, data, table } or { width, height, rgba }');
  if ((px || frame.data).length < n) throw new Error(`card: the frame has fewer than ${width}x${height} pixels`);
  for (let i = 0; i < n; i++) {
    const v = px ? px[i] : frame.table[frame.data[i]];
    out[i] = (v & 0xFF) << 16 | ((v >>> 8) & 0xFF) << 8 | ((v >>> 16) & 0xFF);
  }
  return out;
}
const dist = (a, b) => { const dr = (a >> 16) - (b >> 16), dg = ((a >> 8) & 0xFF) - ((b >> 8) & 0xFF), db = (a & 0xFF) - (b & 0xFF); return dr * dr + dg * dg + db * db; };

export function cardPixels(frame, { caption = 'cloadm.dev', name = 'CLOADM', lines = CARD_LINES } = {}) {
  const W = CARD_W, H = CARD_H, pixels = new Uint8Array(W * H);
  const rgb = frameRgb(frame);
  // the palette: the card's own colours first, then the frame's, most used first; a frame of more colours than fit
  // has the rest drawn in the nearest colour kept
  const counts = new Map();
  for (const v of rgb) counts.set(v, (counts.get(v) || 0) + 1);
  const own = KEYS.map((k) => (OWN[k][0] << 16) | (OWN[k][1] << 8) | OWN[k][2]);
  const palette = own.slice();
  for (const [v] of [...counts].sort((a, b) => b[1] - a[1])) if (!palette.includes(v) && palette.length < CARD_COLOURS) palette.push(v);
  const index = new Map();
  for (const v of counts.keys()) {
    let best = 0;
    for (let i = 1; i < palette.length; i++) if (dist(palette[i], v) < dist(palette[best], v)) best = i;
    index.set(v, best);
  }
  const C = Object.fromEntries(KEYS.map((k, i) => [k, i]));

  pixels.fill(C.ground);
  const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) pixels.fill(c, j * W + x, j * W + x + w); };
  // a rounded rectangle: each row's span shortened by the corner's circle
  const rounded = ({ x, y, w, h, r }, c) => {
    for (let j = 0; j < h; j++) {
      const dy = j < r ? r - j - 0.5 : j >= h - r ? j - (h - r) + 0.5 : 0;
      const inset = dy ? Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy))) : 0;
      rect(x + inset, y + j, w - 2 * inset, 1, c);
    }
  };
  // text in the chat font, `s` card pixels a font pixel; returns the width drawn
  const text = (str, x, y, s, c) => {
    [...str].forEach((ch, k) => glyph(ch).forEach((row, j) => {
      for (let i = 0; i < 6; i++) if ((row >> (5 - i)) & 1) rect(x + (k * 6 + i) * s, y + j * s, s, s, c);
    }));
    return str.length * 6 * s;
  };

  // the monitor: the bezel, its lower lip a shade darker, the glass, the picture
  rounded(BEZEL, C.bezel);
  for (let j = BEZEL.y + BEZEL.h - 120; j < BEZEL.y + BEZEL.h; j++) for (let i = BEZEL.x; i < BEZEL.x + BEZEL.w; i++) if (pixels[j * W + i] === C.bezel) pixels[j * W + i] = C.shade;
  rounded(GLASS, C.glass);
  const sx = GLASS.x + (GLASS.w - SCREEN.w) / 2, sy = GLASS.y + (GLASS.h - SCREEN.h) / 2;
  for (let j = 0; j < SCREEN.h; j++) {
    const fy = Math.floor(j * frame.height / SCREEN.h);
    for (let i = 0; i < SCREEN.w; i++) pixels[(sy + j) * W + sx + i] = index.get(rgb[fy * frame.width + Math.floor(i * frame.width / SCREEN.w)]);
  }
  // the caption on the bezel, under the glass, centred
  const cs = 3, cw = caption.length * 6 * cs;
  if (cw > BEZEL.w - 2 * BEZEL.r) throw new Error(`card: the caption "${caption}" is too long for the bezel`);
  text(caption, BEZEL.x + Math.round((BEZEL.w - cw) / 2), GLASS.y + GLASS.h + 6, cs, C.phosphor);

  // beside it: the logo (four squares, one dark), the name, the words
  const q = 22;
  rect(SIDE, 170, q, q, C.phosphor); rect(SIDE + q + 2, 170, q, q, C.shade);
  rect(SIDE, 170 + q + 2, q, q, C.phosphor); rect(SIDE + q + 2, 170 + q + 2, q, q, C.phosphor);
  const ns = 7;
  if (name.length * 6 * ns > W - SIDE - 20) throw new Error(`card: the name "${name}" is too long`);
  text(name, SIDE, 236, ns, C.text);
  lines.forEach((l, k) => {
    if (l.length * 18 > W - SIDE - 20) throw new Error(`card: the line "${l}" is too long`);
    text(l, SIDE, 320 + k * 34, 3, C.text);
  });
  return { width: W, height: H, palette: palette.map((v) => [v >> 16, (v >> 8) & 0xFF, v & 0xFF]), pixels };
}

export function renderCard(frame, opts = {}) {
  const c = cardPixels(frame, opts);
  return encodeIndexedPng(c.width, c.height, c.palette, c.pixels);
}
