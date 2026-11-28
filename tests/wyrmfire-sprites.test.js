// WYRMFIRE's monsters against the walls, on the pinned engine (js/wyrmfire/pin.js) and the Freedoom level: a monster
// stands with its feet on the floor line at every distance, gets smaller the further away it is, is drawn when it is at
// the right edge of the view, shows its visible half when it is half behind a pillar, and never shows in a column whose
// wall is nearer than it is. These are what players noticed of the engine before v0.1.0 (feet floating or sunk, sprites
// gone at the right edge or when half hidden, drawn over nearer walls).
//
// The oracle is the wall projection WYRMFIRE's converter uses (its buildAtlas screen(), and wyrmfire's own
// test/harness/sprites.cjs): eyes 5 units above the floor and the floor line of something z map units away (8 a cell)
// at row 79 + 640/z. A case pokes the player and ONE monster into RAM, lets the engine draw both screen pages, and
// compares the page on the screen with the same view with the monster out of range.
// The per-column checks (the pillar and the nearer wall) compare the engine against its own variables: the monster's
// span (c0, gW) and depth (tdepth) and each column's wall (rayDistance). The depth-48 check anchors them to the same
// geometry: 12 cells straight ahead is 96 map units, 48 in the engine's half units.
//
//   node tests/wyrmfire-sprites.test.js                                 the pinned engine, with the RAM map below
//   node tests/wyrmfire-sprites.test.js --engine BIN --sym MAP          another build, with its own link map
//                                                                       (wyrmfire bin/wyrmfire.sym), e.g. an old one
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Emu = require('./load')();
const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };
const J = JSON.stringify;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The engine's RAM, from v0.1.0's link map (wyrmfire bin/wyrmfire.sym at 6af92df) and docs/FORMATS.md "Engine RAM map":
// the picture markers at $0200-$0207 (the engine writes them from its variables after every picture, src/native.c),
// the arrays it keeps at fixed addresses outside its image (`#define`s in src/native.c), and its variables.
// A re-pin moves these: the check below fails until they are re-taken from the new engine's map.
const MAP_ENGINE_SHA256 = '63783f6cd8b3508c6fdebfd1f2205b700fee2a834046578ad6e75922a98b11b8';
const MARKS = { frame: 0x200, angle: 0x201, cellX: 0x202, cellY: 0x203, health: 0x204 };
const FIXED = { wind: 0xf800, waitForAttack: 0xf840 };
const V010 = { things: 0x4dee, count: 0x4ef2, angle: 0x4ef4, health: 0x4ef5, won: 0x4efa, rayDistance: 0x4eff, px: 0x4f1f, py: 0x4f21,
  back: 0x4f23, tdepth: 0x4f56, gW: 0x4f88, c0: 0x4fa0 };
const PACK = 0x6e00;    // the HGR2 header in RAM (FORMATS.md); +7, +8 the spawn cell
const GUARD = 1;        // thing kind 1, the guard (src/native.c)

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const enginePath = arg('--engine') || path.join(ROOT, PIN.files.engine.path), symPath = arg('--sym');
const ENGINE = new Uint8Array(fs.readFileSync(enginePath)), LEVEL = new Uint8Array(fs.readFileSync(path.join(ROOT, PIN.files.level.path)));
let RAM = { ...FIXED, ...V010 };
if (symPath) {
  // a CMOC link map: "Symbol: _name (native.o) = ADDR"
  RAM = { ...FIXED, ...Object.fromEntries([...fs.readFileSync(symPath, 'utf8').matchAll(/^Symbol: _(\w+) \(native\.o\) = ([0-9A-F]+)/gm)]
    .filter((m) => m[1] in V010 || m[1] in FIXED).map((m) => [m[1], parseInt(m[2], 16)])) };
  const missing = Object.keys(V010).filter((k) => !(k in RAM));
  console.log(`engine ${enginePath} (SHA-256 ${sha(ENGINE)}), RAM from ${symPath}${missing.length ? `; not in that map (read as 0): ${missing.join(', ')}` : ''}`);
} else {
  check('the RAM map is the pinned engine\'s (re-take it from the new link map after a re-pin)', PIN.files.engine.sha256 === MAP_ENGINE_SHA256 && sha(ENGINE) === MAP_ENGINE_SHA256, PIN.files.engine.sha256);
}

const s = new Emu.Session({ welcomeMenu: false });
s.startWyrmfire(ENGINE, LEVEL);
const m = s.personMachine;
const read = (a) => (a === undefined ? 0 : s.readByte(a, m)), put = (k, ...v) => s.pokeBytes(RAM[k], v, m);
for (let f = 0; read(MARKS.frame) === 0 && f < 3000; f++) { m.setKey('ENTER', f % 50 < 25); s.runFrames(1); }
m.setKey('ENTER', false);
check('the engine draws its first picture', read(MARKS.frame) > 0);

// One picture, stopping on the instruction that bumps the frame marker: the engine's own variables (the monster's
// depth and columns) are read there, before the next picture starts to overwrite them.
const picture = () => { const n = read(MARKS.frame); for (let g = 0; read(MARKS.frame) === n; g++) { m.runCycles(m.cycle + 0x7fffffff, 1); if (g > 60e6) throw Error(`no picture; PC $${m.cpu.pc.toString(16)}`); } };
while (read(MARKS.frame) < 3) picture();
const P = [read(PACK + 7), read(PACK + 8)];

// Each address is the one the engine uses: poked, the next picture's markers (written from those variables) follow.
{
  const spawned = [read(MARKS.cellX), read(MARKS.cellY)];
  put('angle', 5); put('health', 77); put('px', P[0] + 1, 128); put('py', P[1], 128); picture();
  const got = [read(MARKS.angle), read(MARKS.health), read(MARKS.cellX), read(MARKS.cellY)];
  check('the angle, health and position variables are the ones the engine draws from (markers $0201-$0204 follow a poke)',
    J(spawned) === J(P) && J(got) === J([5, 77, P[0] + 1, P[1]]), `spawn ${J(P)} marked ${J(spawned)}; after the poke ${J(got)}`);
}

// the page on the screen (draw() leaves `back` on the other one), 32 bytes x 160 rows
const shown = () => { const back = read(RAM.back) * 256 + read(RAM.back + 1), page = back === 0xe000 ? 0x400 : 0xe000;
  return Array.from({ length: 160 * 32 }, (_, i) => read(page + i)); };
// the player at the middle of cell P facing `angle`, one monster (or none: out of findNearby's range); two pictures a page
const FAR = [120, 100];
const view = (angle, [x, y]) => {
  for (let i = 0; i < 4; i++) {
    put('px', P[0], 128); put('py', P[1], 128); put('angle', angle); put('health', 100); put('won', 0);
    put('count', 1); put('things', x, y, GUARD, 4); put('waitForAttack', 255); put('wind', 0);
    picture();
  }
  return { page: shown(), depth: read(RAM.tdepth), c0: (read(RAM.c0) << 24) >> 24, w: read(RAM.gW),
    walls: Array.from({ length: 32 }, (_, c) => read(RAM.rayDistance + c)) };
};
// what the monster changed on the screen: its lowest and highest row, its height and the byte columns it touched
const sprite = (angle, at) => {
  const base = view(angle, FAR), v = view(angle, at);
  let top = 999, bottom = -1; const cols = new Set();
  v.page.forEach((b, i) => { if (b !== base.page[i]) { top = Math.min(top, i >> 5); bottom = Math.max(bottom, i >> 5); cols.add(i & 31); } });
  return { ...v, top, bottom, rows: bottom < 0 ? 0 : bottom - top + 1, cols: [...cols].sort((a, b) => a - b) };
};
// The engine's span for the monster (first column c0, gW wide) against the walls: a column of it on the screen is drawn
// exactly when its wall is not nearer than the monster (one unit of slack: the view tables round t/2).
const perColumn = (r) => { const want = [], hidden = [];
  for (let c = r.c0; c < r.c0 + r.w; c++) if (c >= 0 && c < 32) (r.walls[c] + 1 >= r.depth ? want : hidden).push(c);
  return { want, hidden }; };

// 1. Straight down the corridor (angle 0 = +x), the monster k cells ahead: feet on the floor line, smaller further away.
let nearer = null;
for (const k of [2, 3, 4, 6, 8, 12]) {
  const r = sprite(0, [P[0] + k, P[1]]), floor = 79 + 640 / (8 * k);
  check(`a monster ${k} cells ahead stands on the floor line (row ${floor.toFixed(1)}, +-2)`, r.bottom >= 0 && Math.abs(r.bottom - floor) <= 2, `lowest sprite row ${r.bottom}`);
  if (nearer) check(`... and is shorter than at ${nearer.k} cells (${nearer.rows} rows)`, r.rows > 0 && r.rows < nearer.rows, `${r.rows} rows`);
  nearer = { k, rows: r.rows };
}
// 2. The right edge: at (10,20) seen at angle 1 the monster is in columns 30-31, which the old engine culled.
{ const r = sprite(1, [10, 20]); check('a monster at the right edge of the view (columns 30-31) is drawn', r.cols.includes(30) || r.cols.includes(31), J(r.cols)); }
// 3. Half behind a pillar: (14,17) at angle 27. The column that sees it (6) is drawn, and the engine's span has columns
//    the pillar hides.
{ const r = sprite(27, [14, 17]), pc = perColumn(r);
  check('a monster half behind a pillar shows its visible half (column 6), and not the half behind it', r.cols.includes(6) && pc.hidden.length > 0 && !pc.hidden.some((c) => r.cols.includes(c)),
    `drawn ${J(r.cols)}, hidden by the pillar ${J(pc.hidden)}`); }
// 4. Never over a nearer wall: (18,25) at angle 0 is 12 cells ahead (depth 96 units, 48 in the engine's half units),
//    beside the corridor's far end. Every column of its span is drawn exactly when that column's wall is not nearer.
{ const r = sprite(0, [18, 25]), pc = perColumn(r);
  check('the monster 12 cells ahead is at depth 48 (12 cells x 8 units, halved)', r.depth === 48, `depth ${r.depth}`);
  check('every column of its span is drawn exactly when that column\'s wall is not nearer', pc.hidden.length > 0 && J(r.cols) === J(pc.want),
    `span ${r.c0}..${r.c0 + r.w - 1}, drawn ${J(r.cols)}, want ${J(pc.want)}, behind nearer walls ${J(pc.hidden)}`);
  const through = r.cols.filter((c) => r.walls[c] + 1 < 48);
  check('no sprite pixel lands in a column whose wall is nearer than the monster', through.length === 0, `through ${J(through)}`); }

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
