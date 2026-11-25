/*
 * A machine's picture as a link card (1200 x 630, the size link previews use): the program pages' pictures
 * (tools/program-cards.js) and a share link's preview picture.
 *
 * The picture area (the VDG's fixed 256 x 192 when the frame says where it is, else the whole frame) is scaled up by
 * the largest whole number that fits, with the frame's pixel shape kept, and centred on the border's colour (the
 * frame's top-left pixel). The colours are the frame's own, one palette entry per colour code used, so a VDG picture
 * has at most 16 (+ the border, which is one of them).
 */
export const CARD_WIDTH = 1200, CARD_HEIGHT = 630;

// frame (js/video/frame.js) -> { width, height, pixels: Uint8Array of palette indices, palette: [[r, g, b], ...] }
export function cardPicture(frame, width = CARD_WIDTH, height = CARD_HEIGHT) {
  const a = frame.active || { x: 0, y: 0, width: frame.width, height: frame.height };
  // how many times taller than wide one frame pixel is shown (1 on the VDG's 320 x 240, 2 on the GIME's 640 x 240)
  const tall = Math.max(1, Math.round(frame.width / (frame.aspect * frame.height)));
  const k = Math.max(1, Math.min(Math.floor(width / a.width), Math.floor(height / (a.height * tall))));
  const w = a.width * k, h = a.height * k * tall, x0 = (width - w) >> 1, y0 = (height - h) >> 1;
  const index = new Map(), palette = [];
  const colourOf = (code) => {
    let i = index.get(code);
    if (i === undefined) {
      const v = frame.table[code];
      i = palette.length; index.set(code, i); palette.push([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF]);
    }
    return i;
  };
  const pixels = new Uint8Array(width * height).fill(colourOf(frame.data[0]));
  for (let y = 0; y < h; y++) {
    const src = (a.y + Math.floor(y / (k * tall))) * frame.width + a.x, o = (y0 + y) * width + x0;
    for (let x = 0; x < w; x++) pixels[o + x] = colourOf(frame.data[src + Math.floor(x / k)]);
  }
  return { width, height, pixels, palette };
}
