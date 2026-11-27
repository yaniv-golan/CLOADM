// The shared part of tests/basic-gfx*.test.js: the clean-room BASIC's graphics foundation (docs/clean-room-basic-p2.md
// sections 3, 5, 9 and 10), typed into a Dragon 64 running the image assembled from basic/ at test time (no other ROM),
// the pages in RAM compared byte for byte with tests/basic/gfxmodel.js, a reference model written from the document's
// tables, not from the 6809 code. Here: the helpers that type, the random test data (drawn in one place, in a fixed
// order, so that every part sees the same values whichever parts run) and the PSET runs against the model.
const { buildBasic } = require('../../tools/build-basic.js');
const { Basic } = require('./harness.js');
const G = require('./gfxmodel.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });

const { rom, symbols } = buildBasic();
let seed = 12345;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % k; };

function boot() {
  const b = new Basic(rom);
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no OK at boot');
  return b;
}
// type each line and wait for OK (a program line: until the screen settles)
function typeAll(b, lines) {
  for (const l of lines) {
    if (b.type(l + '\n', 40000) !== 'done') throw new Error(`not typed: ${l}`);
    if (/^\d/.test(l)) b.run(3); else if (!b.waitOk({ limit: 6000 })) throw new Error(`no OK after: ${l}`);
  }
}
const last = (b) => { const s = b.screen(); return s.slice(-2)[0]; };   // the line before the final OK
const ramEq = (a, b, from, to) => { for (let i = from; i < to; i++) if (a[i] !== b[i]) return i; return -1; };
const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

// the random data of every part, drawn in this order: the PSET runs' colours, then each run's points, then PPOINT's
// bytes and points, PCOPY's page, the points of SET and RESET.
// The PSET runs (PSET, PRESET, PCLS and COLOR in every mode and colour set, against the model). Each run: PMODE m,p :
// SCREEN 1,s : COLOR f,b (or none: the mode's defaults) : PCLS [c], then points from DATA (x, y, colour 0-8; 9 = PSET
// with no colour, -1 = PRESET).
const plans = [];
for (let m = 0; m <= 4; m++) for (let s = 0; s <= 1; s++) plans.push({ m, p: 1, s, color: s ? null : [rnd(9), rnd(9)], pcls: s ? rnd(9) : null });
plans.push({ m: 0, p: 4, s: 0, color: [2, 3], pcls: null }, { m: 1, p: 3, s: 1, color: null, pcls: 6 }, { m: 2, p: 3, s: 0, color: [5, 7], pcls: 8 });
for (const pl of plans) {
  const pts = [[0, 0, 9], [255, 0, 9], [0, 191, 9], [255, 191, 9], [1, 5, 9], [2, 5, 9], [3, 5, 9], [4, 6, -1]];
  for (let c = 0; c <= 8; c++) pts.push([10 + c * 3, 20, c], [11 + c * 3, 21, c]);
  for (let i = 0; i < 40; i++) pts.push([rnd(256), rnd(192), rnd(11) - 1]);
  pl.pts = pts;
}
const ppointBytes = Array.from({ length: 64 }, () => rnd(256));
const ppointCoords = [];
for (let i = 0; i < 24; i++) ppointCoords.push([rnd(256), rnd(8)]);
ppointCoords.push([0, 0], [255, 7], [1, 0], [2, 0], [3, 0], [7, 1]);
const pcopySrc = Array.from({ length: 1536 }, () => rnd(256));
const setOps = [];
for (let i = 0; i < 60; i++) setOps.push([rnd(64), rnd(32), rnd(3) === 0 ? -1 : rnd(9)]);
setOps.push([0, 0, 3], [1, 0, 4], [63, 31, 2], [10, 10, 0]);

// the PSET runs whose plan passes keep(pl), each on a fresh machine
function runPlans(keep) {
  for (const pl of plans.filter(keep)) {
    const b = boot();
    const pts = pl.pts;
    const data = pts.map((q) => q.join(','));
    const lines = [`10 PMODE ${pl.m},${pl.p}:SCREEN 1,${pl.s}${pl.color ? `:COLOR ${pl.color[0]},${pl.color[1]}` : ''}:PCLS${pl.pcls != null ? ` ${pl.pcls}` : ''}`,
      '20 READ X,Y,C:IF X<0 THEN END', '30 IF C<0 THEN PRESET(X,Y):GOTO 20', '40 IF C=9 THEN PSET(X,Y):GOTO 20', '50 PSET(X,Y,C):GOTO 20'];
    for (let i = 0; i < data.length; i += 12) lines.push(`${100 + i} DATA ${data.slice(i, i + 12).join(',')}`);
    lines.push('999 DATA -1,0,0');
    typeAll(b, lines);
    const before = Uint8Array.from(b.m.ram.slice(0, 0x8000));
    typeAll(b, ['RUN']);
    const pic = new G.Picture(before), d = G.MODES[pl.m];
    const dflt = G.defaults(pl.m, pl.s), fg = pl.color ? pl.color[0] : dflt.fg, bg = pl.color ? pl.color[1] : dflt.bg;
    pic.cls(pl.m, pl.p, pl.pcls != null ? pl.pcls : bg);
    for (const [x, y, c] of pts) pic.set(pl.m, pl.p, x, y, c === 9 ? fg : c < 0 ? bg : c);
    const start = G.pageStart(pl.p), end = start + d.pages * G.PAGE;
    const at = ramEq(pic.ram, b.m.ram, 0x600, 0x1E00);
    const name = `PMODE ${pl.m},${pl.p} set ${pl.s}${pl.color ? ` COLOR ${pl.color}` : ' (default colours)'}${pl.pcls != null ? ` PCLS ${pl.pcls}` : ''}`;
    check(`${name}: pages ${hex(start)}-${hex(end - 1)} as the model, the other pages untouched`, at < 0,
      at < 0 ? '' : `first difference at ${hex(at)}: ours ${b.m.ram[at].toString(16)}, model ${pic.ram[at].toString(16)}`);
    check(`${name}: back to text at OK`, !b.graphicsShown() && b.m.sam.vmode === 0 && b.m.sam.displayBase === 0x400);
  }
}

module.exports = { G, check, tally, symbols, boot, typeAll, last, ramEq, hex, runPlans, ppointBytes, ppointCoords, pcopySrc, setOps };
