// A JavaScript reference model of the clean-room BASIC's graphics pages (docs/clean-room-basic-p2.md sections 3, 5,
// 6 and 8), written from the document's tables, rules and algorithm descriptions, not from the 6809 code in basic/:
// which byte and bits a point is in each PMODE, what a colour number puts there, what PPOINT reads back, the default
// colours, the semigraphics characters of SET, RESET and POINT; and the drawing statements: LINE (Bresenham's
// algorithm as section 5 states it), CIRCLE (the 64-chord polygon), PAINT (a plain breadth-first 4-connected fill,
// not the scan-line algorithm), DRAW (an interpreter of section 6's commands) and GET / PUT (pixel by pixel).
// tests/basic-gfx.test.js and tests/basic-drawing.test.js compare the machine's RAM with it byte for byte.

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

// ---- the drawing statements (sections 5, 6 and 8) ----
// A pen draws on a picture in mode m from page p: points in 256 x 192 coordinates, off the picture not drawn.
class Pen {
  constructor(pic, m, p) { Object.assign(this, { pic, m, p }); }
  plot(x, y, c) { if (x >= 0 && x <= 255 && y >= 0 && y <= 191) this.pic.set(this.m, this.p, x, y, c); }
  // Bresenham's integer line: step along the major axis; the error term starts at half the major delta (rounded
  // down), loses the minor delta at each step, and when it goes negative gets the major delta back while the minor
  // axis steps. Both ends drawn.
  line(x1, y1, x2, y2, c) {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1), sx = x2 < x1 ? -1 : 1, sy = y2 < y1 ? -1 : 1;
    const xMajor = dx >= dy, major = xMajor ? dx : dy, minor = xMajor ? dy : dx;
    let x = x1, y = y1, e = Math.floor(major / 2);
    for (let i = 0; ; i++) {
      this.plot(x, y, c);
      if (i === major) break;
      e -= minor;
      if (e < 0) { e += major; if (xMajor) y += sy; else x += sx; }
      if (xMajor) x += sx; else y += sy;
    }
  }
  box(x1, y1, x2, y2, c) { this.line(x1, y1, x2, y1, c); this.line(x2, y1, x2, y2, c); this.line(x2, y2, x1, y2, c); this.line(x1, y2, x1, y1, c); }
  boxFill(x1, y1, x2, y2, c) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) this.plot(x, y, c);
  }
  // CIRCLE: corners at whole 1/64 turns, x = cx + r cos, y = cy + r h sin (h in 8.8 fixed point, its fraction
  // dropped), each offset rounded to the nearest whole point with an 8-bit sine table; start and end to the nearest
  // 1/64 turn; an end at or before the start goes on past 0; the same start and end draw the whole circle
  circle(cx, cy, r, c, h = 1, s = 0, e = 1) {
    const sine = (k) => (k === 16 ? 256 : Math.round(256 * Math.sin(k * Math.PI / 32)));
    const frac = (v, f) => (f === 256 ? v : (v * f + 128) >> 8);
    const ry = (Math.floor(h * 256) * r + 128) >> 8;
    // v x sin(j/64 turn), signed: the quarter gives the table index and the sign
    const off = (v, j) => { j &= 63; const k = j & 15, q = j >> 4, m = frac(v, sine(q & 1 ? 16 - k : k)); return q >= 2 ? -m : m; };
    const corner = (j) => [cx + off(r, j + 16), cy + off(ry, j)];
    const turn = (t) => (Math.floor(t * 128) + 1) >> 1;
    const j0 = turn(s), n = ((turn(e) - j0) & 63) || 64;
    let [x, y] = corner(j0);
    for (let i = 1; i <= n; i++) { const [nx, ny] = corner(j0 + i); this.line(x, y, nx, ny, c); x = nx; y = ny; }
  }
  // PAINT: the 4-connected region of the start in the mode's own pixels, up to pixels of the border or the paint
  // colour (a plain breadth-first fill)
  paint(x, y, c, b) {
    const d = MODES[this.m], W = 256 >> d.xh, H = 192 >> d.yh, pv = value(this.m, c), bv = value(this.m, b);
    const stop = (i, j) => { const v = this.pic.get(this.m, this.p, i << d.xh, j << d.yh); return v === pv || v === bv; };
    const queue = [[x >> d.xh, y >> d.yh]], seen = new Set();
    while (queue.length) {
      const [i, j] = queue.shift();
      if (i < 0 || i >= W || j < 0 || j >= H || seen.has(j * W + i)) continue;
      seen.add(j * W + i);
      if (stop(i, j)) continue;
      this.pic.set(this.m, this.p, i << d.xh, j << d.yh, c);
      queue.push([i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]);
    }
  }
}

// DRAW (section 6): run the command string s from the state st = { x, y, angle, scale, fg }, which it updates; vars
// gives the values of =var; and X var$;. Throws 'FC' for a bad command or value.
const DIRS = { U: [0, -1], E: [1, -1], R: [1, 0], F: [1, 1], D: [0, 1], G: [-1, 1], L: [-1, 0], H: [-1, -1] };
const TURNS = 'UERFDGLH';
function draw(pen, st, s, vars = {}) {
  let i = 0, noDraw = false, back = false;
  const fc = () => { throw new Error('FC'); };
  const num = () => {           // =var; or digits (0-255); null if none
    if (s[i] === '=') {
      const j = s.indexOf(';', i); if (j < 0) fc();
      const v = vars[s.slice(i + 1, j)]; i = j + 1;
      if (!(v >= 0 && v < 256)) fc();
      return Math.floor(v);
    }
    let v = null;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') { v = (v || 0) * 10 + Number(s[i++]); if (v > 255) fc(); }
    return v;
  };
  const len = (n) => Math.floor(n * st.scale / 4);
  const move = (x, y) => {
    const ox = st.x, oy = st.y;
    if (!noDraw) pen.line(st.x, st.y, x, y, st.fg);
    st.x = x; st.y = y;
    if (back) { st.x = ox; st.y = oy; }
    noDraw = back = false;
  };
  const part = (cur) => {
    const sg = s[i] === '+' ? 1 : s[i] === '-' ? -1 : 0;
    if (sg) { i++; return cur + sg * len(num() || 0); }
    return num() || 0;
  };
  while (i < s.length) {
    const ch = s[i++];
    if (ch === ' ' || ch === ';') continue;
    if (ch === 'X') { const j = s.indexOf(';', i); if (j < 0) fc(); draw(pen, st, vars[s.slice(i, j)] || '', vars); i = j + 1; continue; }
    if (TURNS.includes(ch)) {
      const [dx, dy] = DIRS[TURNS[(TURNS.indexOf(ch) + 2 * st.angle) & 7]], n = num(), l = len(n === null ? 1 : n);
      move(st.x + dx * l, st.y + dy * l);
    } else if (ch === 'M') {
      const x = part(st.x); if (s[i++] !== ',') fc(); const y = part(st.y); move(x, y);
    } else if (ch === 'B') noDraw = true;
    else if (ch === 'N') back = true;
    else if (ch === 'C') { const v = num() || 0; if (v > 8) fc(); st.fg = v; }
    else if (ch === 'A') { const v = num() || 0; if (v > 3) fc(); st.angle = v; }
    else if (ch === 'S') { const v = num() || 0; if (v < 1 || v > 62) fc(); st.scale = v; }
    else fc();
  }
}

// GET and PUT (section 8): the rectangle in the mode's own pixels; its bits (1 or 2 a pixel, a pixel's high bit
// first), row by row, each row from a new byte. getRect -> the bytes; putRect applies bytes with an action.
function rect(m, x1, y1, x2, y2) {
  const d = MODES[m];
  return { d, l: Math.min(x1, x2) >> d.xh, r: Math.max(x1, x2) >> d.xh, t: Math.min(y1, y2) >> d.yh, b: Math.max(y1, y2) >> d.yh };
}
function getRect(pic, m, p, x1, y1, x2, y2) {
  const { d, l, r, t, b } = rect(m, x1, y1, x2, y2), rb = (((r - l + 1) * d.bpp) + 7) >> 3, out = [];
  for (let j = t; j <= b; j++) {
    const row = new Array(rb).fill(0);
    let k = 0;
    for (let i = l; i <= r; i++) {
      const v = pic.get(m, p, i << d.xh, j << d.yh);
      for (let q = d.bpp - 1; q >= 0; q--, k++) if ((v >> q) & 1) row[k >> 3] |= 0x80 >> (k & 7);
    }
    out.push(...row);
  }
  return out;
}
const ACTIONS = { PSET: (s) => s, PRESET: (s) => 1 - s, AND: (s, d) => s & d, OR: (s, d) => s | d, NOT: (s, d) => 1 - d };
function putRect(pic, m, p, x1, y1, x2, y2, bytes, action = 'PSET') {
  const { d, l, r, t, b } = rect(m, x1, y1, x2, y2), rb = (((r - l + 1) * d.bpp) + 7) >> 3, f = ACTIONS[action];
  for (let j = t; j <= b; j++) {
    let k = 0;
    for (let i = l; i <= r; i++) {
      const old = pic.get(m, p, i << d.xh, j << d.yh);
      let v = 0;
      for (let q = d.bpp - 1; q >= 0; q--, k++) v |= f((bytes[(j - t) * rb + (k >> 3)] >> (7 - (k & 7))) & 1, (old >> q) & 1) << q;
      const at = pixel(m, p, i << d.xh, j << d.yh);
      pic.ram[at.addr] = (pic.ram[at.addr] & ~(at.mask << at.shift)) | (v << at.shift);
    }
  }
}

module.exports = { MODES, PAGE, pageStart, pixel, value, ppoint, defaults, Picture, sgCell, sgSet, sgReset, sgPoint, Pen, draw, getRect, putRect };
