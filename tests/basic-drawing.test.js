// Run: node tests/basic-drawing.test.js [part...]   (parts: line, circle, paint, paint-om, draw, getput, errors; all by default)
//
// The clean-room BASIC's drawing statements (docs/clean-room-basic-p2.md sections 5, 6, 8 and 9): LINE (with B, BF,
// PSET / PRESET and -(x,y) from the last point), CIRCLE (radius, colour, ratio, start and end), PAINT, DRAW (every
// command, M absolute and relative, N, B, A, S, C, X var$; and =var;) and GET / PUT (every action, G). BASIC
// programs are typed into a Dragon 64 running the image assembled from basic/ at test time (no other ROM), and the
// pages in RAM are compared byte for byte with tests/basic/gfxmodel.js, whose drawing routines are written from the
// document's algorithm descriptions (Bresenham's line, the 64-chord circle, a plain breadth-first fill for PAINT, a
// DRAW interpreter, GET / PUT pixel by pixel), not from the 6809 code. Also: clipping at the picture's edges, the
// last point each statement leaves, PAINT running out of memory (?OM ERROR) on a pathological shape, GET's bytes in
// the array and GET / PUT round trips, and the errors (?FC, ?SN, ?TM).
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');
const G = require('./basic/gfxmodel.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const { rom, symbols } = buildBasic();
const parts = process.argv.slice(2), part = (name) => !parts.length || parts.includes(name);
let seed = 4242;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % k; };

function boot() {
  const b = new Basic(rom);
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no OK at boot');
  return b;
}
// type each line and wait for OK (a program line: until the screen settles)
function typeAll(b, lines, limit = 30000) {
  for (const l of lines) {
    if (!['done', 'not-consumed'].includes(b.type(l + '\n', 40000))) throw new Error(`not typed: ${l}`);   // (not-consumed: a long statement ran on the line's last key)
    if (/^\d/.test(l)) b.run(3); else if (!b.waitOk({ limit })) throw new Error(`no OK after: ${l}`);
  }
}
const last = (b) => b.screen().slice(-2)[0];   // the line before the final OK
const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');
const word = (b, name, o = 0) => b.m.ram[symbols.get(name) + o] << 8 | b.m.ram[symbols.get(name) + o + 1];
// the four cold-start pages ($0600-$1DFF) against the model: the first difference, or '' when they agree
function diff(b, pic, from = 0x600, to = 0x1E00) {
  for (let i = from; i < to; i++) if (b.m.ram[i] !== pic.ram[i]) return `first difference at ${hex(i)}: ours ${b.m.ram[i].toString(16)}, model ${pic.ram[i].toString(16)}`;
  return '';
}
// program lines from DATA items, 12 a line
const dataLines = (from, items) => { const out = []; for (let i = 0; i < items.length; i += 12) out.push(`${from + i} DATA ${items.slice(i, i + 12).join(',')}`); return out; };
// a picture of the RAM now, and a pen in mode m on page 1
const snap = (b) => new G.Picture(b.m.ram.slice(0, 0x8000));

// ---- LINE in every mode: every octant both ways, lengths 0 and 1, B, BF (corners either way), PRESET, -(x,y) ----
// DATA: kind (0 PSET, 1 PRESET, 2 PSET B, 3 PSET BF, 4 PRESET BF, 5 -(x,y) PSET, 6 PRESET B), x1, y1, x2, y2
if (part('line')) {
  const segs = [];
  const ends = [[200, 96], [200, 120], [200, 168], [160, 168], [128, 168], [96, 168], [56, 168], [56, 120], [56, 96], [56, 72], [56, 24], [96, 24], [128, 24], [160, 24], [200, 24], [200, 72]];
  for (const [x, y] of ends) segs.push([0, 128, 96, x, y], [0, x, y, 128, 96]);
  segs.push([0, 10, 10, 10, 10], [0, 20, 10, 21, 10], [0, 30, 10, 31, 11], [0, 40, 10, 40, 11], [0, 10, 180, 250, 183], [0, 240, 20, 243, 90], [0, 0, 0, 255, 191], [0, 255, 0, 0, 191]);
  segs.push([2, 20, 20, 80, 60], [3, 100, 20, 160, 60], [3, 230, 60, 180, 20], [4, 110, 30, 150, 50], [1, 100, 20, 160, 60], [6, 120, 25, 140, 55], [2, 5, 170, 5, 170], [3, 10, 170, 11, 171]);
  segs.push([5, 0, 0, 200, 100], [5, 0, 0, 200, 150], [5, 0, 0, 0, 191], [5, 0, 0, 255, 0], [3, 0, 185, 255, 191], [2, 0, 0, 255, 191]);
  for (let i = 0; i < 24; i++) segs.push([rnd(7), rnd(256), rnd(192), rnd(256), rnd(192)]);
  const plans = [[4, 1, null], [0, 1, [1, 0]], [3, 0, [3, 2]], [1, 1, [7, 6]], [2, 0, null], [3, 1, [0, 8]]];
  for (const [m, s, color] of plans) {
    const b = boot();
    const lines = [`10 PMODE ${m},1:SCREEN 1,${s}${color ? `:COLOR ${color[0]},${color[1]}` : ''}:PCLS`,
      '20 READ K,A,B,C,D:IF K<0 THEN END', '30 ON K+1 GOSUB 40,41,42,43,44,45,46:GOTO 20',
      '40 LINE(A,B)-(C,D),PSET:RETURN', '41 LINE(A,B)-(C,D),PRESET:RETURN', '42 LINE(A,B)-(C,D),PSET,B:RETURN', '43 LINE(A,B)-(C,D),PSET,BF:RETURN',
      '44 LINE(A,B)-(C,D),PRESET,BF:RETURN', '45 LINE-(C,D),PSET:RETURN', '46 LINE(A,B)-(C,D),PRESET,B:RETURN',
      ...dataLines(100, segs.map((q) => q.join(','))), '999 DATA -1,0,0,0,0'];
    typeAll(b, lines);
    const pic = snap(b);
    typeAll(b, ['RUN'], 60000);
    const pen = new G.Pen(pic, m, 1), dflt = G.defaults(m, s), fg = color ? color[0] : dflt.fg, bg = color ? color[1] : dflt.bg;
    pic.cls(m, 1, bg);
    let lx = 128, ly = 96;
    for (const [k, x1, y1, x2, y2] of segs) {
      const sx = k === 5 ? lx : x1, sy = k === 5 ? ly : y1, c = [0, 1, 0, 0, 1, 0, 1][k] ? bg : fg;
      if (k === 2 || k === 6) pen.box(sx, sy, x2, y2, c); else if (k === 3 || k === 4) pen.boxFill(sx, sy, x2, y2, c); else pen.line(sx, sy, x2, y2, c);
      lx = x2; ly = y2;
    }
    const d = diff(b, pic);
    check(`LINE in PMODE ${m}, colour set ${s}${color ? `, COLOR ${color}` : ''}: ${segs.length} lines, boxes and filled boxes as the model`, !d, d);
    check(`LINE in PMODE ${m}: the last point is the last line's end`, word(b, 'LASTX') === lx && word(b, 'LASTY') === ly, `${word(b, 'LASTX')},${word(b, 'LASTY')}`);
  }
}

// ---- CIRCLE: radii, ratios, arcs, colours, edges ----
if (part('circle')) {
  const circles = [];
  for (const r of [0, 1, 2, 3, 5, 10, 20, 40, 70, 95, 100]) circles.push([128, 96, r]);
  circles.push([20, 20, 1], [40, 20, 2], [60, 20, 4], [20, 170, 6], [128, 96, 255], [0, 0, 30], [255, 191, 40], [5, 96, 30], [250, 96, 30], [128, 5, 30], [128, 186, 30]);
  circles.push([40, 40, 30, 1, 0], [120, 40, 30, 1, 0.25], [200, 40, 30, 1, 0.5], [40, 130, 20, 1, 2], [120, 130, 15, 1, 4], [200, 130, 40, 1, 0.75], [200, 130, 40, 1, 1.5], [60, 60, 50, 1, 1.2]);
  circles.push([40, 40, 30, 1, 1, 0, 0.25], [120, 40, 30, 1, 1, 0.25, 0.5], [200, 40, 30, 1, 1, 0.5, 0.75], [40, 120, 30, 1, 1, 0.75, 1], [120, 120, 30, 1, 1, 0.9, 0.1],
    [200, 120, 30, 1, 1, 0.3, 0.3], [40, 170, 15, 1, 1, 0, 0.01], [120, 170, 15, 1, 0.5, 0.125, 0.625], [200, 170, 15, 1, 1.2, 0.6, 0.4], [60, 150, 30, 2, 0.5, 0.25, 0.75], [100, 100, 60, 1, 1, 0.33]);
  const fmt = (q) => `CIRCLE(${q[0]},${q[1]}),${q.slice(2).join(',')}`;
  for (const [m, s, colours] of [[4, 1, false], [0, 0, false], [3, 0, true], [1, 1, true]]) {
    const b = boot();
    const list = circles.map((q) => (colours && q.length === 3 ? [...q, 1 + rnd(8)] : q));
    const lines = [`10 PMODE ${m},1:SCREEN 1,${s}:PCLS:PSET(7,9)`, ...list.map((q, i) => `${20 + i} ${fmt(q)}`)];
    typeAll(b, lines);
    const pic = snap(b);
    typeAll(b, ['RUN'], 60000);
    const pen = new G.Pen(pic, m, 1), dflt = G.defaults(m, s);
    pic.cls(m, 1, dflt.bg);
    pen.plot(7, 9, dflt.fg);
    for (const [x, y, r, c = dflt.fg, h, st, e] of list) pen.circle(x, y, r, c, h, st, e);
    const d = diff(b, pic);
    check(`CIRCLE in PMODE ${m}, colour set ${s}: ${list.length} circles, ellipses and arcs (some off the edges) as the model`, !d, d);
    check(`CIRCLE in PMODE ${m}: the last point is left where PSET put it`, word(b, 'LASTX') === 7 && word(b, 'LASTY') === 9);
  }
}

// ---- PAINT on hand-built shapes (the pixels put straight into the page), against a breadth-first fill ----
if (part('paint')) {
  // each shape: a function drawing its border with pen.plot / line in colour c, and the start point
  // a square spiral, its corridor 8 points wide
  const spiral = (pen, c) => {
    const pts = [[20, 20]];
    for (let x0 = 20, y0 = 20, x1 = 235, y1 = 171; x1 - x0 > 16 && y1 - y0 > 16; x0 += 8, y0 += 8, x1 -= 8, y1 -= 8) pts.push([x1, y0], [x1, y1], [x0, y1], [x0, y0 + 8], [x0 + 8, y0 + 8]);
    for (let i = 1; i < pts.length; i++) pen.line(...pts[i - 1], ...pts[i], c);
  };
  const shapes = [
    { name: 'a rectangle', draw: (p, c) => p.box(10, 10, 70, 60, c), at: [40, 30] },
    { name: 'a U', draw: (p, c) => { p.line(180, 10, 195, 10, c); p.line(195, 10, 195, 55, c); p.line(195, 55, 225, 55, c); p.line(225, 55, 225, 10, c); p.line(225, 10, 240, 10, c); p.line(240, 10, 240, 70, c); p.line(240, 70, 180, 70, c); p.line(180, 70, 180, 10, c); }, at: [185, 60] },
    { name: 'a spiral', draw: spiral, at: [130, 100] },
    { name: 'a shape with holes', draw: (p, c) => { p.box(20, 20, 200, 150, c); for (let i = 0; i < 6; i++) p.box(30 + i * 28, 40, 45 + i * 28, 60 + i * 10, c); p.boxFill(100, 120, 110, 130, c); }, at: [25, 25] },
    { name: 'a ring', draw: (p, c) => { p.circle(128, 96, 60, c); p.circle(128, 96, 30, c); }, at: [128, 50] },
    { name: 'a one-pixel gap that leaks', draw: (p, c) => { p.box(60, 60, 120, 120, c); p.plot(90, 60, 0); }, at: [90, 90] },
    { name: 'a diagonal gap that does not leak (4-connected)', draw: (p, c) => { p.line(10, 100, 100, 10, c); p.line(11, 100, 101, 10, c); p.line(0, 100, 10, 100, c); p.line(101, 10, 101, 0, c); }, at: [5, 5] },
    { name: 'shapes touching every edge', draw: (p, c) => { p.line(0, 50, 255, 50, c); p.line(128, 0, 128, 191, c); p.circle(128, 50, 20, c); }, at: [0, 0] },
    { name: 'no border in reach (the whole picture)', draw: () => {}, at: [77, 77] },
    { name: 'a fill whose start is a border pixel', draw: (p, c) => p.box(10, 10, 20, 20, c), at: [10, 15] },
  ];
  for (const [m, paint, border] of [[4, 1, 1], [3, 3, 4], [0, 1, 1], [1, 2, 4], [2, 1, 1]]) {
    for (const sh of shapes) {
      const b = boot();
      typeAll(b, [`PMODE ${m},1:PCLS 0`]);
      const pic = snap(b), pen = new G.Pen(pic, m, 1);
      sh.draw(pen, border);
      // pixels already of the paint colour inside the region (they stop the fill too)
      if (G.MODES[m].bpp === 2) { pen.plot(150, 150, paint); pen.plot(151, 150, paint); pen.plot(41, 31, paint); }
      b.m.ram.set(pic.ram.slice(0x600, 0x1E00), 0x600);
      typeAll(b, [`PAINT(${sh.at[0]},${sh.at[1]}),${paint},${border}`], 400000);
      pen.paint(sh.at[0], sh.at[1], paint, border);
      const d = diff(b, pic);
      check(`PAINT in PMODE ${m} (${paint} up to ${border}): ${sh.name}`, !d && last(b) !== '?OM ERROR', d || last(b));
    }
  }
  // PMODE 3, a different border: a fill up to colour 4 crosses lines of colour 2
  const b = boot();
  typeAll(b, ['PMODE 3,1:PCLS 1']);
  const pic = snap(b), pen = new G.Pen(pic, 3, 1);
  pen.box(10, 10, 100, 90, 4); pen.line(50, 10, 50, 90, 2); pen.circle(70, 50, 15, 3);
  b.m.ram.set(pic.ram.slice(0x600, 0x1E00), 0x600);
  typeAll(b, ['PAINT(20,20),3,4'], 400000);
  pen.paint(20, 20, 3, 4);
  check('PAINT in PMODE 3: colour 3 up to colour 4 goes over the lines of colour 2 and stops at its own colour', !diff(b, pic), diff(b, pic));
  typeAll(b, ['PMODE 3,1:PCLS 1:COLOR 2,1:LINE(10,10)-(60,60),PSET,B:PAINT(30,30)'], 400000);
  const p2 = snap(b);
  check('PAINT with no colours: the foreground up to the foreground', p2.get(3, 1, 30, 30) === G.value(3, 2) && p2.get(3, 1, 70, 70) === G.value(3, 1));
}

// ---- PAINT runs out of memory: a comb of one-pixel teeth leaves a stretch per tooth to be seeded ----
if (part('paint-om')) {
  const b = boot();
  typeAll(b, ['PMODE 4,1:PCLS']);
  const pic = snap(b), pen = new G.Pen(pic, 4, 1);
  for (let y = 1; y < 192; y += 2) for (let x = 1; x < 256; x += 2) pen.plot(x, y, 1);
  b.m.ram.set(pic.ram.slice(0x600, 0x1E00), 0x600);
  typeAll(b, ['A=7:PAINT(0,0),1,1'], 400000);
  check('PAINT of a comb with a tooth every other pixel: ?OM ERROR when the seeds fill free memory', last(b) === '?OM ERROR', last(b));
  typeAll(b, ['PRINT A;MEM>1000']);
  check('after it, BASIC goes on (the variables kept, the stack whole)', last(b) === ' 7 -1', last(b));
  typeAll(b, ['CLS:DIM Z(3000):PMODE 4,1:PCLS:LINE(0,0)-(255,191),PSET,B:PAINT(9,9),1,1'], 400000);
  check('with most memory taken by an array, a whole-picture fill still ends without ?OM ERROR', b.screen().slice(-1)[0] === 'OK' && !b.screen().join().includes('?OM'), last(b));
}

// ---- DRAW against the interpreter of section 6 ----
if (part('draw')) {
  const progs = [
    { name: 'the cold-start point, the eight directions with N, moves without a length', lines: ['DRAW "U20L20D20"', 'DRAW "BM128,96NU40NE40NR40NF40ND40NG40NL40NH40"', 'DRAW "BM20,20RRRRDDDDLLLLUUUU":DRAW "BM20,40R10BR10R10":DRAW "BM20,60E5F5G5H5"'] },
    { name: 'M absolute and relative, B, N', lines: ['DRAW "BM20,100M60,140M+20,-20M-10,+30BM+10,+10D10"', 'DRAW "NM200,10NM+30,+60;M-5,-5"'] },
    { name: 'angles A0-A3, and an angle lasting into the next DRAW', lines: ['DRAW "BM40,96A0U20R10D5":DRAW "BM100,96A1U20R10D5":DRAW "BM160,96A2U20R10D5":DRAW "BM220,96A3U20R10D5"', 'DRAW "BM40,170U20R10":DRAW "A0"', 'DRAW "A1":DRAW "BM100,170U20R10E7":DRAW "A0"'] },
    { name: 'scales S1-S62 (S3, S5 rounding down) and a scale lasting', lines: ['DRAW "BM10,40S1U8R8D8L8":DRAW "BM30,40S2U8R8D8L8":DRAW "BM60,40S4U8R8D8L8":DRAW "BM100,40S8U8R8D8L8"', 'DRAW "BM150,40S16U8R8D8L8":DRAW "BM200,40S62U1R1D1L1":DRAW "BM10,100S3U5R5D5L5":DRAW "BM40,100S5U5R5D5L5M+3,+7"', 'DRAW "S8":DRAW "BM80,120U5R5D5L5":DRAW "S4"'] },
    { name: 'X substrings (nested), =var; for lengths and for M, spaces and ;', vars: { A$: 'U10R10D10L10', B$: 'XA$;BR15XA$;', N: 25, X: 200, Y: 100 }, lines: ['A$="U10R10D10L10":B$="XA$;BR15XA$;"', 'DRAW "BM50,150XA$;BM80,150XB$;"', 'N=25:DRAW "BM150,150 R=N; D=N;;":X=200:Y=100:DRAW "BM=X;,=Y;U10M+=N;,-=N;"'] },
    { name: 'moves off every edge are clipped point by point', lines: ['DRAW "BM240,40R30":DRAW "BM10,60;L30":DRAW "BM60,10;U30":DRAW "BM60,180;D30":DRAW "BM240,180;F30":DRAW "BM5,5H40F80"', 'DRAW "BM250,100S62R100D100L255U255"'] },
  ];
  for (const [m, s] of [[4, 1], [3, 0], [0, 1]]) for (const pr of progs) {
    const b = boot();
    const pre = `PMODE ${m},1:SCREEN 1,${s}:PCLS`;
    typeAll(b, [pre]);
    const pic = snap(b), pen = new G.Pen(pic, m, 1), st = { x: 128, y: 96, angle: 0, scale: 4, fg: G.defaults(m, s).fg };
    typeAll(b, pr.lines, 60000);
    const vars = pr.vars || {};
    for (const l of pr.lines) for (const mt of l.matchAll(/DRAW "([^"]*)"/g)) G.draw(pen, st, mt[1], vars);
    const d = diff(b, pic);
    check(`DRAW in PMODE ${m}: ${pr.name}`, !d && !b.screen().join().includes('ERROR'), d || b.screen().slice(-2).join('|'));
    check(`DRAW in PMODE ${m}: ${pr.name}: the last point, angle and scale after`, word(b, 'LASTX') === (st.x & 0xFFFF) && word(b, 'LASTY') === (st.y & 0xFFFF) && b.m.ram[symbols.get('DRANG')] === st.angle && b.m.ram[symbols.get('DRSCL')] === st.scale,
      `${word(b, 'LASTX')},${word(b, 'LASTY')} model ${st.x},${st.y}`);
  }
  // C: the colour, in PMODE 3; it becomes the foreground
  const b = boot();
  typeAll(b, ['PMODE 3,1:SCREEN 1,0:PCLS', 'DRAW "BM20,20C2R20C3D20C4L20C1U20":DRAW "BM60,20R20D20L20U20":DRAW "C0BM100,20R20D20":PSET(5,5)']);
  const pic = snap(b);
  pic.cls(3, 1, 1);
  const pen = new G.Pen(pic, 3, 1), st = { x: 128, y: 96, angle: 0, scale: 4, fg: 4 };
  for (const t of ['BM20,20C2R20C3D20C4L20C1U20', 'BM60,20R20D20L20U20', 'C0BM100,20R20D20']) G.draw(pen, st, t);
  pen.plot(5, 5, st.fg);
  check('DRAW C in PMODE 3: each colour, lasting into the next DRAW and into PSET\'s foreground', !diff(b, pic), diff(b, pic));
}

// ---- GET and PUT ----
// the bytes of numeric array `name` (one letter), from its first element on
function arrayBytes(b, name) {
  const ram = b.m.ram, aryend = word(b, 'ARYEND');
  for (let x = word(b, 'ARYTAB'); x < aryend; x += ram[x + 2] << 8 | ram[x + 3]) {
    if (ram[x] === name.charCodeAt(0) && ram[x + 1] === 0) { const h = 5 + 2 * ram[x + 4]; return { at: x + h, size: (ram[x + 2] << 8 | ram[x + 3]) - h, dims: ram[x + 4], first: ram[x + 5] << 8 | ram[x + 6] }; }
  }
  return null;
}
if (part('getput')) {
  const rects = [[16, 16, 31, 31], [19, 17, 28, 30], [0, 0, 7, 0], [0, 0, 255, 0], [3, 5, 3, 5], [250, 180, 255, 191], [100, 60, 60, 20], [1, 2, 6, 3]];
  const ACTS = ['PSET', 'PRESET', 'AND', 'OR', 'NOT', ''];
  for (const m of [4, 3, 0, 1, 2]) {
    const b = boot();
    typeAll(b, ['DIM A(1300),B(300)', `PMODE ${m},1:PCLS`]);
    const bytes = Array.from({ length: 0x1800 }, () => rnd(256));
    b.m.ram.set(bytes, 0x600);
    let bad = '';
    for (const [x1, y1, x2, y2] of rects) {
      const pic = snap(b);
      typeAll(b, [`GET(${x1},${y1})-(${x2},${y2}),A,G`]);
      const want = G.getRect(pic, m, 1, x1, y1, x2, y2), a = arrayBytes(b, 'A');
      const got = [...b.m.ram.slice(a.at, a.at + want.length)];
      if (!bad && got.join() !== want.join()) bad = `GET(${x1},${y1})-(${x2},${y2}): ours ${got.slice(0, 8)}, model ${want.slice(0, 8)}`;
    }
    check(`GET in PMODE ${m}: the array's bytes as the model (${rects.length} rectangles, one a whole row, one a pixel)`, !bad, bad);
    bad = '';
    for (const [x1, y1, x2, y2] of rects) for (const act of ACTS) {
      const a = arrayBytes(b, 'A'), fill = Array.from({ length: 300 }, () => rnd(256));
      b.m.ram.set(fill, a.at);
      const pic = snap(b);
      typeAll(b, [`PUT(${x2},${y1})-(${x1},${y2}),A${act ? ',' + act : ''}`]);
      G.putRect(pic, m, 1, x1, y1, x2, y2, fill, act || 'PSET');
      const d = diff(b, pic);
      if (!bad && d) bad = `PUT(${x1},${y1})-(${x2},${y2}),A,${act}: ${d}`;
    }
    check(`PUT in PMODE ${m}: every action (and none) on ${rects.length} rectangles, against the bitwise model`, !bad, bad);
    // a round trip: GET a rectangle, PUT it elsewhere at another alignment, GET that back
    typeAll(b, ['GET(10,10)-(40,30),A,G:PUT(103,121)-(133,141),A,PSET:GET(103,121)-(133,141),B']);
    const pic = snap(b), A = arrayBytes(b, 'A'), B = arrayBytes(b, 'B'), len = G.getRect(pic, m, 1, 10, 10, 40, 30).length;
    check(`GET / PUT round trip in PMODE ${m} at another alignment: the same bytes back`, A.size >= len && b.m.ram.slice(A.at, A.at + len).join() === b.m.ram.slice(B.at, B.at + len).join() && B.size >= len);
  }
  const b = boot();
  typeAll(b, ['PMODE 4,1:PCLS:DIM S(1)', 'GET(0,0)-(15,5),S,G']);
  check('GET into an array one byte too small: ?FC ERROR', last(b) === '?FC ERROR', last(b));
  typeAll(b, ['GET(0,0)-(15,4),S,G']);
  check('GET into an array just big enough: no error', b.screen().slice(-1)[0] === 'OK' && !b.screen().slice(-2)[0].includes('ERROR'));
  typeAll(b, ['GET(0,0)-(7,7),U,G']);
  const u = arrayBytes(b, 'U');
  check('GET into an array not DIMmed: made with 11 elements, as any array', u && u.dims === 1 && u.first === 11 && u.size === 55);
  for (const [line, err] of [['PUT(0,0)-(7,7),S,XOR', 'SN'], ['GET(0,0)-(7,7),S,X', 'SN'], ['GET(0,0)-(7,7),S$', 'TM'], ['PUT(0,0)-(7,7)', 'SN'], ['GET(0,0)-(256,7),S', 'FC'], ['PUT(0,0)-(8,192),S', 'FC'], ['GET(0,0),S', 'SN']]) {
    typeAll(b, [line]);
    check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b));
  }
}

// ---- errors (section 9) ----
if (part('errors')) {
  const b = boot();
  const cases = [['LINE(0,0)(10,10),PSET', 'SN'], ['LINE(0,0)-(10,10)', 'SN'], ['LINE(0,0)-(10,10),XSET', 'SN'], ['LINE(0,0)-(10,10),PSET,X', 'SN'], ['LINE(0,0)-(256,10),PSET', 'FC'], ['LINE-(0,192),PSET', 'FC'],
    ['CIRCLE(128,96)', 'SN'], ['CIRCLE(128,96),10,9', 'FC'], ['CIRCLE(128,96),10,1,5', 'FC'], ['CIRCLE(128,96),10,1,-1', 'FC'], ['CIRCLE(128,96),10,1,1,1.5,.5', 'FC'], ['CIRCLE(128,96),10,1,1,0,1.01', 'FC'], ['CIRCLE(128,96),256', 'FC'], ['CIRCLE(256,96),10', 'FC'],
    ['PAINT(128,96),9', 'FC'], ['PAINT(128,96),1,9', 'FC'], ['PAINT(128,192),1', 'FC'], ['PAINT 1,1', 'SN'],
    ['DRAW "Q"', 'FC'], ['DRAW 5', 'TM'], ['DRAW "A4"', 'FC'], ['DRAW "S63"', 'FC'], ['DRAW "S0"', 'FC'], ['DRAW "C9"', 'FC'], ['DRAW "U256"', 'FC'], ['DRAW "M10"', 'FC'], ['DRAW "M10,"', 'FC'],
    ['DRAW "XZ$"', 'FC'], ['DRAW "X5;"', 'SN'], ['DRAW "U=Z$;"', 'TM'], ['N=300:DRAW "U=N;"', 'FC'], ['N=-1:DRAW "U=N;"', 'FC'], ['DRAW "XN;"', 'TM']];
  for (const [line, err] of cases) {
    typeAll(b, [line]);
    const got = last(b), ok = err === 'OK' ? b.screen().slice(-1)[0] === 'OK' && !got.includes('ERROR') : got === `?${err} ERROR`;
    check(`${line}: ${err === 'OK' ? 'no error' : `?${err} ERROR`}`, ok, got);
  }
  typeAll(b, ['A$="XA$;":DRAW A$'], 60000);
  check('DRAW of a string that runs itself as a substring: ?OM ERROR (the stack check), not a crash', last(b) === '?OM ERROR', last(b));
  typeAll(b, ['PRINT 1+1']);
  check('and BASIC goes on after it', last(b) === ' 2');
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
