// A JavaScript reference model of the clean-room BASIC's graphics pages (docs/clean-room-basic-p2.md sections 3 and
// 5), written from the document's tables and rules, not from basic/gfx.inc: which byte and bits a point is in each
// PMODE, what a colour number puts there, what PPOINT reads back, the default colours, and the semigraphics
// characters of SET, RESET and POINT. tests/basic-gfx.test.js compares the machine's RAM with it byte for byte.

// section 3's table: bytes a row, x halved, y halved, bits a pixel, pages; the VDG's GM bits and the SAM's V [HW]
const MODES = [
  { bpr: 16, xh: 1, yh: 1, bpp: 1, pages: 1, gm: 3, v: 3 },
  { bpr: 32, xh: 1, yh: 1, bpp: 2, pages: 2, gm: 4, v: 4 },
  { bpr: 16, xh: 1, yh: 0, bpp: 1, pages: 2, gm: 5, v: 5 },
  { bpr: 32, xh: 1, yh: 0, bpp: 2, pages: 4, gm: 6, v: 6 },
  { bpr: 32, xh: 0, yh: 0, bpp: 1, pages: 4, gm: 7, v: 6 },
];
const PAGE = 0x600;
const pageStart = (p) => 0x600 + (p - 1) * PAGE;

// the byte and mask of point (x 0-255, y 0-191) in mode m from page p: 8 pixels a byte or 4 of two bits, the
// leftmost in the top bits
function pixel(m, p, x, y) {
  const d = MODES[m], xs = x >> d.xh, ys = y >> d.yh, row = pageStart(p) + ys * d.bpr;
  if (d.bpp === 1) return { addr: row + (xs >> 3), shift: 7 - (xs & 7), mask: 1 };
  return { addr: row + (xs >> 2), shift: 6 - 2 * (xs & 3), mask: 3 };
}
// the value colour c (0-8) puts in a pixel: four colours (c - 1) AND 3; two colours 0 for black, 1 for any other
const value = (m, c) => (MODES[m].bpp === 2 ? (c - 1) & 3 : (c ? 1 : 0));
// what PPOINT returns for pixel value v with colour set s
const ppoint = (m, s, v) => (MODES[m].bpp === 2 ? v + 1 + 4 * s : (v ? 1 + 4 * s : 0));
// the default foreground and background after PMODE (and at cold start) with colour set s
const defaults = (m, s) => (MODES[m].bpp === 2 ? { fg: 4 + 4 * s, bg: 1 + 4 * s } : { fg: 1 + 4 * s, bg: 0 });

// A picture: the bytes of $0600 up to $7FFF (as RAM is), drawn on as the statements say
class Picture {
  constructor(ram) { this.ram = Uint8Array.from(ram); }
  set(m, p, x, y, c) {
    const q = pixel(m, p, x, y), v = value(m, c);
    this.ram[q.addr] = (this.ram[q.addr] & ~(q.mask << q.shift)) | (v << q.shift);
  }
  get(m, p, x, y) { const q = pixel(m, p, x, y); return (this.ram[q.addr] >> q.shift) & q.mask; }
  cls(m, p, c) {
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) this.set(m, p, x, y, c);
  }
}

// semigraphics-4 on the text screen: the cell of point (x 0-63, y 0-31) and its element bit (bit 3 top left, 2 top
// right, 1 bottom left, 0 bottom right); SET's character, RESET's, POINT's value [HW, the MC6847 data sheet; OWN for
// colour 0 and for a cell holding a text character]
const sgCell = (x, y) => ({ addr: 0x400 + (y >> 1) * 32 + (x >> 1), bit: 8 >> ((x & 1) + 2 * (y & 1)) });
const sgSet = (old, bit, c) => 0x80 | (((c - 1) & 7) << 4) | (old & 0x80 ? old & 0x0F : 0) | bit;
const sgReset = (old, bit) => (old & 0x80 ? old : 0x80) & ~bit;
const sgPoint = (old, bit) => (!(old & 0x80) ? -1 : old & bit ? ((old >> 4) & 7) + 1 : 0);

module.exports = { MODES, PAGE, pageStart, pixel, value, ppoint, defaults, Picture, sgCell, sgSet, sgReset, sgPoint };
