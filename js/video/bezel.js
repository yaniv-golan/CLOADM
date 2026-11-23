/*
 * The site's link preview (og:image, tools/capture-og.js): a machine's picture on a CRT, 1200 x 630, at most 16
 * colours. Built on the shared card code: js/video/card.js's cardPicture draws the frame into the glass (its picture area
 * scaled by a whole number, centred on the border colour, the frame's own colours) and js/media/png.js writes the file.
 * This adds the monitor around it: the bezel, its darker lip with the caption on it ("cloadm.dev"), and beside it the
 * logo, the name and a few words, in the chat terminal's original font (js/video/chat-font.js). No canvas, no browser,
 * and no pixel but the frame's and these shapes.
 *   bezelPicture(frame, { caption, name, lines }) -> { width, height, pixels, palette }
 *   renderBezelCard(frame, opts) -> Promise of PNG bytes
 * Characters outside the font's ASCII 0x20-0x7E, or text too long for its place, are refused.
 */
import { GLYPHS } from './chat-font.js';
import { cardPicture, CARD_WIDTH, CARD_HEIGHT } from './card.js';
import { encodeIndexedPng } from '../media/png.js';

export const BEZEL_COLOURS = 16;
export const BEZEL_LINES = ['Dragon and Tandy', 'Color Computer', 'emulator, in your', 'browser.'];
// the card's own colours (css/tokens.css): the ground, the bezel's two greys, the glass, the phosphor green, the text
const OWN = [[0x0B, 0x0D, 0x0C], [0x3A, 0x3F, 0x3D], [0x1C, 0x20, 0x1E], [0, 0, 0], [0x3D, 0xF5, 0x5A], [0xC9, 0xCC, 0xC4]];
const [GROUND, BEZEL_C, SHADE, GLASS_C, PHOSPHOR, TEXT] = [0, 1, 2, 3, 4, 5];
// where things go (pixels of the card)
export const BEZEL = { x: 30, y: 15, w: 760, h: 600, r: 44 };
export const GLASS = { x: 66, y: 51, w: 688, h: 528, r: 36 };
export const SCREEN = { x: 90, y: 75, w: 640, h: 480 };   // cardPicture's box inside the glass
const LIP = 120;      // the bezel's darker lower part, the caption on it
const SIDE = 830;     // the name's column

const glyph = (ch) => {
  const hex = GLYPHS[ch];
  if (!hex) throw new Error(`card: no glyph for ${JSON.stringify(ch)} (the font has ASCII 0x20-0x7E)`);
  return hex.split(' ').map((h) => parseInt(h, 16));
};
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function bezelPicture(frame, { caption = 'cloadm.dev', name = 'CLOADM', lines = BEZEL_LINES } = {}) {
  const W = CARD_WIDTH, H = CARD_HEIGHT, pixels = new Uint8Array(W * H).fill(GROUND);
  const shot = cardPicture(frame, SCREEN.w, SCREEN.h);
  // the palette: the card's own colours, then the picture's, most used first, to 16; a picture of more colours than fit
  // has the rest drawn in the nearest colour kept
  const used = new Array(shot.palette.length).fill(0);
  for (const v of shot.pixels) used[v]++;
  const palette = OWN.map((c) => c.slice()), map = new Array(shot.palette.length);
  const order = shot.palette.map((_, i) => i).sort((a, b) => used[b] - used[a]);
  for (const i of order) {
    const c = shot.palette[i], same = palette.findIndex((p) => p.join() === c.join());
    if (same >= 0) map[i] = same;
    else if (palette.length < BEZEL_COLOURS) { map[i] = palette.length; palette.push(c.slice()); }
  }
  for (const i of order) if (map[i] === undefined) map[i] = palette.reduce((b, p, k) => (dist(p, shot.palette[i]) < dist(palette[b], shot.palette[i]) ? k : b), 0);

  const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) pixels.fill(c, j * W + x, j * W + x + w); };
  // a rounded rectangle: each row's span shortened by the corner's circle
  const rounded = ({ x, y, w, h, r }, c) => {
    for (let j = 0; j < h; j++) {
      const dy = j < r ? r - j - 0.5 : j >= h - r ? j - (h - r) + 0.5 : 0;
      const inset = dy ? Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy))) : 0;
      rect(x + inset, y + j, w - 2 * inset, 1, c);
    }
  };
  // text in the chat font, s card pixels a font pixel
  const text = (str, x, y, s, c) => [...str].forEach((ch, k) => glyph(ch).forEach((row, j) => {
    for (let i = 0; i < 6; i++) if ((row >> (5 - i)) & 1) rect(x + (k * 6 + i) * s, y + j * s, s, s, c);
  }));
  const fits = (str, s, room, what) => { if (str.length * 6 * s > room) throw new Error(`card: the ${what} "${str}" is too long`); };

  // the monitor: the bezel, its lower lip a shade darker, the glass, the picture
  rounded(BEZEL, BEZEL_C);
  for (let j = BEZEL.y + BEZEL.h - LIP; j < BEZEL.y + BEZEL.h; j++) for (let i = BEZEL.x; i < BEZEL.x + BEZEL.w; i++) if (pixels[j * W + i] === BEZEL_C) pixels[j * W + i] = SHADE;
  rounded(GLASS, GLASS_C);
  for (let j = 0; j < SCREEN.h; j++) for (let i = 0; i < SCREEN.w; i++) pixels[(SCREEN.y + j) * W + SCREEN.x + i] = map[shot.pixels[j * SCREEN.w + i]];
  // the caption on the lip, under the glass, centred
  fits(caption, 3, BEZEL.w - 2 * BEZEL.r, 'caption');
  text(caption, BEZEL.x + Math.round((BEZEL.w - caption.length * 18) / 2), GLASS.y + GLASS.h + 6, 3, PHOSPHOR);
  // beside it: the logo (four squares, one dark), the name, the words
  const q = 22;
  rect(SIDE, 170, q, q, PHOSPHOR); rect(SIDE + q + 2, 170, q, q, SHADE);
  rect(SIDE, 170 + q + 2, q, q, PHOSPHOR); rect(SIDE + q + 2, 170 + q + 2, q, q, PHOSPHOR);
  fits(name, 7, W - SIDE - 20, 'name');
  text(name, SIDE, 236, 7, TEXT);
  lines.forEach((l, k) => { fits(l, 3, W - SIDE - 20, 'line'); text(l, SIDE, 320 + k * 34, 3, TEXT); });
  return { width: W, height: H, pixels, palette };
}

export const renderBezelCard = (frame, opts) => encodeIndexedPng(bezelPicture(frame, opts));
