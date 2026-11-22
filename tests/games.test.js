// The games (examples/2048.asm, examples/minesweeper.asm, their shared examples/games.inc), headless, without
// ROMs: they assemble to the committed binaries with the fixed header the Session knows; the screen is the VDG's
// 128x192 four-colour mode; the rules hold against a model written here from the rules (2048: slide, join once,
// a new 2 or 4 on a random empty square; Minesweeper: ten mines laid after the first square, never on it or next
// to it, counts, the flood of a square with no mine next to it, flags, losing, winning), with the random numbers
// the games document (a 16-bit Galois LFSR, taps $B400, eight steps a byte, rejection sampling); the stack stays
// small; the sounds are the notes the tables give; BREAK leaves to the text screen and the Session brings the
// welcome menu back; the games are refused on the 6803 machines.
// Text drawn in the bitmap is read back through the font in games.inc.
// Run: node tests/games.test.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const include = (f) => { const p = path.join(ROOT, 'examples', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const build = (name) => Emu.assemble(fs.readFileSync(path.join(ROOT, `examples/${name}.asm`), 'utf8'), '6809', { include });
const bin = (name) => new Uint8Array(fs.readFileSync(path.join(ROOT, `examples/${name}.bin`)));

// ---- both assemble to the committed binaries, with the header the Session knows ----
const A = {};
for (const name of ['2048', 'minesweeper']) {
  const a = build(name);
  A[name] = a;
  check(`${name}.asm assembles to the committed ${name}.bin`, a.ok && Buffer.from(Emu.toBinary(a)).equals(Buffer.from(bin(name))), JSON.stringify(a.errors));
  const sym = (k) => a.symbols.get(k);
  check(`${name}: entry $3000, SEED $3003, DONE $3005 (Session GAMES)`, a.exec === Emu.GAMES.start && sym('ENTRY') === Emu.GAMES.start && sym('SEED') === Emu.GAMES.seed && sym('DONE') === Emu.GAMES.done
    && Emu.GAMES.list[name].file === `${name}.bin`);
  // The IMAGE below $4000, and the variables in RAM the game's own 32K requirement guarantees.
  // Why $4000 for the image: $3000-$3FFF is the free RAM above a game on a 16K machine (docs/game-development.md,
  // "Where a game goes"), so an image ending there runs on every machine. The FILE carries only the image: RMB
  // reserves addresses and emits no bytes (js/asm/assembler.js, toBinary), so the .bin's length is the image's,
  // and a game whose image fits may still place variables past $4000.
  // Why the variables may go above $4000, and where they must stop - the LOWEST of every other user of the RAM:
  //   * these games REFUSE under 32K: GAMES.ram = 32 (js/session.js:100) and checkGame refuses (js/session.js:3493);
  //     on a 32K machine RAM is one run 0..32767 (js/machines/sam.js:243 `a < this.ramSize ? this.ram[a]`), so
  //     $4000-$7FFF is RAM and not ROM;
  //   * the ROM the SAM maps above 32K starts at $8000 (js/machines/sam.js:246 `a < 0xC000 ? currentRom()[a-0x8000]`),
  //     so the variables must end below $8000;
  //   * the game's OWN stack grows down from $3000 (examples/minesweeper.asm:38 `LDS #$3000`, 2048.asm:35), and it
  //     stays within 32 bytes of it over a whole game (the stack check below measures it), so it never reaches the
  //     variables: the stack's lowest point ($3000 - 32) is far below $4000;
  //   * the screen is $0400-$1BFF (examples/games.inc:36-37), below both, and the no-ROM stub's own workspace
  //     ($02D6-$02DD, js/machines/stub.js:71-75) is below $0400 and is not running while a game is.
  // So the binding bound is $8000 (the ROM), and the stack is checked separately so a future change cannot grow
  // the variables into it.
  // A constant (an EQU: DTITER is 12000, a loop's count) is a number, not an address, and is left out: the
  // listing says which names an EQU defined.
  const consts = new Set(a.listing.filter((l) => /(^|\s)(EQU|=)(\s|$)/i.test(l.src)).map((l) => l.src.trim().split(/\s+/)[0].toUpperCase()));
  const live = [...a.symbols.entries()].filter(([k, v]) => !consts.has(k) && v >= 0x3000);
  const top = Math.max(0, ...live.map(([, v]) => v));
  const imgEnd = Math.max(...a.segments.map((s) => s.addr + s.data.length)) - 1;
  const STACK_TOP = 0x3000, STACK_DEPTH = 32;   // LDS #$3000, and the depth the stack check holds it to
  const varAddrs = [...new Set(a.listing.filter((l) => /^\S+\s+RMB\s/.test(l.src)).map((l) => l.src.trim().split(/\s+/)[0].toUpperCase()))]
    .map((k) => a.symbols.get(k)).filter((v) => v !== undefined);
  check(`${name}: the image ends below $4000 and the variables end below the ROM at $8000`,
    a.segments.every((s) => s.addr >= 0x3000) && imgEnd < 0x4000 && top < 0x8000,
    `image ends $${imgEnd.toString(16)}, top variable $${top.toString(16)}`);
  check(`${name}: no variable reaches the stack's floor ($3000 - ${STACK_DEPTH}); the variables sit above it`,
    varAddrs.length > 0 && Math.min(...varAddrs) > STACK_TOP - STACK_DEPTH - 1 && Math.max(...varAddrs) === top,
    `${varAddrs.length} RMB variables, $${Math.min(...varAddrs).toString(16)}..$${Math.max(...varAddrs).toString(16)}, stack floor $${(STACK_TOP - STACK_DEPTH).toString(16)}`);
}

// ---- the font, read from games.inc: ASCII $20-$5F, five rows of three pixels ----
const FONT = (() => {
  const src = include('games.inc'), at = src.indexOf('FONT    FCB');
  const rows = [];
  for (const line of src.slice(at).split('\n')) {
    const m = /FCB\s+(%[01]{3}(?:,%[01]{3}){4})/.exec(line);
    if (!m) break;
    rows.push(m[1].split(',').map((b) => parseInt(b.slice(1), 2)).join(','));
  }
  const map = new Map();
  rows.forEach((r, i) => { if (!map.has(r)) map.set(r, String.fromCharCode(0x20 + i)); });
  return map;
})();
check('the font has the 64 characters $20-$5F', FONT.size === 64, String(FONT.size));

// ---- the 1x font is PROPORTIONAL: a glyph's own width plus one blank column, so neighbours never touch ----
// FONT5A/FONT5H/...: the letters a 3-pixel cell cannot tell apart, drawn five pixels wide (games.inc), one
// label each, five rows of five bits. A letter that is not there is 3 wide, so the set is READ, not assumed.
const WIDE5 = (() => {
  const src = include('games.inc'), map = new Map();
  for (const m of src.matchAll(/^FONT5([A-Z])\s+FCB\s+(%[01]{5}(?:,%[01]{5}){4})/gm)) {
    map.set(m[1], m[2].split(',').map((b) => parseInt(b.slice(1), 2)).join(','));
  }
  return map;
})();
const glyphWidth = (ch) => (WIDE5.has(ch) ? 5 : 3);
const strWidth = (s) => [...s].reduce((n, c) => n + glyphWidth(c) + 1, 0) - 1;   // the last glyph has no blank column after it
// the tables are read by NAME, so assert every one of them is there: a renamed label would otherwise leave
// this map empty and every string would silently read as 3-wide.
{
  const src = include('games.inc');
  const labels = [...src.matchAll(/^FONT5([A-Z])\s+FCB/gm)].map((m) => m[1]).sort().join('');
  check('games.inc has a five-wide glyph table for each of A, H, R, M and W (read by name)', labels === 'AHMRW',
    `found ${JSON.stringify(labels)}, ${WIDE5.size} parsed`);
}
check('the wide letters are A, H, M, R and W, five pixels wide', [...WIDE5.keys()].sort().join('') === 'AHMRW' && WIDE5.size === 5,
  JSON.stringify([...WIDE5.keys()].sort().join('')));
for (const game of ['2048', 'minesweeper']) {
  const src = fs.readFileSync(path.join(ROOT, `examples/${game}.asm`), 'utf8');
  const long = [...src.matchAll(/^(T_\w+)\s+FCN\s+"([^"]+)"$/gm)]
    .filter(([, , s]) => strWidth(s) > 128).map(([, k, s]) => `${k} (${strWidth(s)} px)`);
  check(`${game}: every string fits the 128-pixel line (the 1x font is proportional)`, long.length === 0, long.join(', '));
}
// the 1x text on pixel row y of the bitmap, from pixel column `from` to `to`, in colour `fg`: a glyph is five
// pixels wide (WIDE5) or three (FONT), one blank column after each, so the cursor lands on every glyph's first
// pixel. The text begins at the first ink column in the band, wherever the proportional layout put it.
const inkAt = (m, y, tall, fg) => (px, row) => ((m.ram[0x400 + (y + row * tall) * 32 + (px >> 2)] >> (6 - 2 * (px & 3))) & 3) === fg;
// A glyph can start on a column with no ink (J's left column is blank) and a 1x string can start at an odd
// pixel column, so the reader tries EVERY column and keeps the one where the WHOLE expected string decodes.
// sliding the expected text is what makes it unambiguous; it returns the glyphs and their true x.
const decodeAt = (m, y, tall, fg, x0, text) => {
  const pixel = inkAt(m, y, tall, fg);
  // NOTE: shift on EVERY pixel, set or clear. Shifting only on ink ('if (pixel) bits = (bits<<1)|1')
  // drops the clear pixels and turns 1,0,1 into 1,1 — every glyph with a blank column then reads wrong.
  const cols = (x, w) => { const g = []; for (let k = 0; k < 5; k++) { let bits = 0; for (let p = 0; p < w; p++) bits = (bits << 1) | (pixel(x + p, k) ? 1 : 0); g.push(bits); } return g.join(','); };
  const three = (s) => { const g = s.split(',').map(Number); const out = []; for (const v of g) { let b = 0; for (let p = 0; p < 3; p++) if ((v >> (2 - p)) & 1) b |= 4 >> p; out.push(b); } return out.join(','); };
  const out = [];
  let x = x0;
  for (const ch of text) {
    const w = glyphWidth(ch) === 5 ? 5 : 3;
    const got = w === 5 ? [...WIDE5].find(([, v]) => v === cols(x, 5))?.[0] : FONT.get(three(cols(x, 3)));
    if (got !== ch) return null;
    out.push({ x, ch });
    x += w + 1;
  }
  return out;
};
// find where `text` was drawn in the band. The slide only FINDS the string (a glyph can start on a blank column,
// e.g. J, so the start is not the first ink). Every candidate is then pinned by its COLUMN and required to be
// UNIQUE: `hits` is every column that matches, so a caller can assert there is exactly one. A looser match would
// show up as a second hit, and the tests below fail on that rather than accepting it.
const hits = (m, y, tall, fg, text, from = 0, to = 128) => {
  const out = [];
  for (let x0 = from; x0 + strWidth(text) <= to; x0++) { const g = decodeAt(m, y, tall, fg, x0, text); if (g) out.push(g); }
  return out;
};
const place = (m, y, tall, fg, text, from = 0, to = 128) => { const h = hits(m, y, tall, fg, text, from, to); return h.length === 1 ? h[0] : null; };
// every glyph of the text in the band, where it actually was: { x, ch }
const glyphsAt = (m, y, tall = 1, fg = 3, text, from = 0, to = 128) => place(m, y, tall, fg, text, from, to);
const textAt = (m, y, tall = 1, fg = 3, text, from = 0, to = 128) => (place(m, y, tall, fg, text, from, to) ? text : '?');

// ---- the random numbers, as games.inc documents them ----
class Rng {
  constructor(seed) { this.r = seed; }
  byte() { for (let i = 0; i < 8; i++) { const c = this.r & 1; this.r >>= 1; if (c) this.r ^= 0xB400; } return this.r & 0xFF; }
  below(n) { let mask = 1; while (mask < n) mask = mask * 2 + 1; for (;;) { const a = this.byte() & mask; if (a < n) return a; } }
}

// ---- running a game in a Session ----
const KEY = { up: 94, down: 10, left: 8, right: 9, space: 32, enter: 13, break: 3 };
// how many frames the title page takes to finish. 30 is the budget the games must meet: the old fixed-cell
// renderer drew the title well inside it, and a renderer that misses it EATS the first key (the page is still
// drawing when the player presses). Measured per game by `titleFrames`, and asserted in the title test.
const TITLE_BUDGET = 30;
function titleFrames(s, sym) {
  // TITLE ends by polling GETKEY; ENTROPY only moves once the game loop runs. Watch it come alive.
  for (let f = 1; f <= 400; f++) {
    s.runFrames(1);
    const e = s.shownMachine.ram[sym('ENTROPY')] * 256 + s.shownMachine.ram[sym('ENTROPY') + 1];
    if (e) return f;
  }
  return Infinity;
}
function start(name, { machine = 'dragon64', seed = 0x1234 } = {}) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(machine, {}, { menu: false });
  s.load(`${name}.bin`, bin(name), { remember: false });
  const m = s.shownMachine, sym = (k) => A[name].symbols.get(k);
  s.runFrames(TITLE_BUDGET);   // the title page drawn, within the budget the game must meet
  m.poke(Emu.GAMES.seed, seed >> 8); m.poke(Emu.GAMES.seed + 1, seed & 0xFF);
  // a key, then frames until the game is looking for the next one. Two kinds of loop: Minesweeper's GLOOP is
  // entered once a field (its RAWL waits for the field sync, polls POLCAT once, and counts in ENTROPY), and
  // 2048's GETKEY polls POLCAT in a tight loop until a key comes, counting every poll there. The wait has to
  // outlast the ACTION too: a key is taken at a field boundary, then dispatched (a move redraws the screen, a
  // flag plays two notes), and a key queued before that is over would land in the middle of it. So Minesweeper
  // waits for two field entries with nothing queued (the key's own field and one after it), and 2048 for the
  // ENTROPY jump only its tight loop makes.
  const perField = !!sym('RAWL');
  const settle = () => {
    let idle = 0;
    for (let i = 0; i < 400; i++) {
      const e0 = m.ram[sym('ENTROPY')] * 256 + m.ram[sym('ENTROPY') + 1];
      s.runFrames(1);
      const e1 = m.ram[sym('ENTROPY')] * 256 + m.ram[sym('ENTROPY') + 1];
      if (m.stubKeys.length) { idle = 0; continue; }
      if (perField) { if (((e1 - e0) & 0xFFFF) >= 1 && ++idle >= 2) return; }
      else if (((e1 - e0) & 0xFFFF) > 200) return;
    }
    throw new Error(`${name}: did not come back for a key`);
  };
  // BREAK stops the game at DONE: no more polls to wait for
  const press = (...keys) => { for (const k of keys) { m.stubKeys.push(typeof k === 'string' ? (KEY[k] || k.charCodeAt(0)) : k); if (k === 'break') s.runFrames(10); else settle(); } };
  const mem = (k, len = 1) => Array.from(m.ram.slice(sym(k), sym(k) + len));
  return { s, m, sym, press, settle, mem };
}

// ================= 2048 =================
// the rules, written from the game's description
function slide(line) {   // towards index 0: -> { out, score, merged }
  const tiles = line.filter((v) => v), out = [];
  let score = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) { out.push(tiles[i] + 1); score += 2 ** (tiles[i] + 1); i++; } else out.push(tiles[i]);
  }
  while (out.length < 4) out.push(0);
  return { out, score };
}
const LINES = {
  up: [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]],
  down: [[12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]],
  left: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
  right: [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]],
};
function move(board, dir) {
  const b = board.slice();
  let score = 0;
  for (const line of LINES[dir]) { const r = slide(line.map((i) => b[i])); line.forEach((i, k) => { b[i] = r.out[k]; }); score += r.score; }
  return { board: b, score, changed: b.some((v, i) => v !== board[i]) };
}
function spawn(board, rng) {
  const empty = board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const at = empty[rng.below(empty.length)];
  board[at] = rng.below(10) === 0 ? 2 : 1;
}
const canMove = (b) => ['up', 'down', 'left', 'right'].some((d) => move(b, d).changed);
const bcd = (bytes) => Number(bytes.map((x) => x.toString(16).padStart(2, '0')).join(''));
const show = (b) => b.map((v) => (v ? 2 ** v : '.')).join(' ');

{
  // the title page must be DRAWN within the budget, or the player's first key is eaten while it still draws
  {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine('dragon64', {}, { menu: false });
    s.load('2048.bin', bin('2048'), { remember: false });
    const f = titleFrames(s, (k) => A['2048'].symbols.get(k));
    s.close?.();
    check('2048: the title page is drawn within 30 frames (a slower one eats the first key)', f <= TITLE_BUDGET, `${f} frames`);
  }
  const g = start('2048', { seed: 0xBEEF });
  check('2048: the title page', textAt(g.m, 108, 2, 2, 'JOIN THE TILES TO MAKE 2048') === 'JOIN THE TILES TO MAKE 2048'
    && textAt(g.m, 172, 1, 3, 'PRESS A KEY TO PLAY') === 'PRESS A KEY TO PLAY',
    JSON.stringify([textAt(g.m, 108, 2, 2, 'JOIN THE TILES TO MAKE 2048'), textAt(g.m, 172, 1, 3, 'PRESS A KEY TO PLAY')]));
  // THE 1x ALIGNMENT INVARIANT: every glyph of every 1x line starts at an even pixel column (phase 0 or 2), AND
  // the string starts exactly where an even-aligned CENTRE would put it: start = (128 - width) >> 2 << 1. The
  // slide only FINDS the string; the start column is then pinned against the formula and required to be UNIQUE,
  // so a looser reader (one that accepted the string at another column) fails here instead of passing.
  {
    const odd = [], where = [];
    for (const [line, row, tall, fg, text] of [['T_JOIN', 108, 2, 2, 'JOIN THE TILES TO MAKE 2048'],
      ['T_KEYS1', 130, 1, 2, 'ARROWS OR WASD SLIDE THEM'], ['T_KEYS2', 140, 1, 2, 'R STARTS AGAIN'],
      ['T_KEYS3', 150, 1, 2, 'BREAK LEAVES'], ['T_PRESS', 172, 1, 3, 'PRESS A KEY TO PLAY']]) {
      const hs = hits(g.m, row, tall, fg, text);
      const want = ((128 - strWidth(text)) >> 1) & ~1;          // even-aligned centre
      // not found is a FAILURE, not "skip": an empty list must not make the parity check pass by doing nothing
      if (hs.length !== 1) { where.push(`${line}: ${hs.length} matches (want exactly 1 at ${want})`); odd.push(`${line}: not found`); continue; }
      const gs = hs[0];
      if (gs[0].x !== want) where.push(`${line}: starts at ${gs[0].x}, the even-aligned centre is ${want}`);
      for (const gl of gs) if (gl.x % 2) odd.push(`${line} '${gl.ch}' @${gl.x}`);
    }
    check('2048: every 1x title glyph starts at an even pixel column (the renderer needs phase 0 or 2)', odd.length === 0, odd.join(', '));
    check('2048: each 1x title string is found in exactly one place, at the even-aligned centre', where.length === 0, where.join('; '));
  }
  check('2048: the four-colour 128x192 mode at $0400 (VDG CG6, SAM V=6, F=2)', (g.m.pia1.saveState().b.or & 0xF8) === 0xE0 && (g.m.sam.reg & 0x3FF) === (6 | (2 << 3)));
  g.press('space');
  const rng = new Rng(0xBEEF);
  let model = new Array(16).fill(0), score = 0;
  spawn(model, rng); spawn(model, rng);
  check('2048: a new game has the two tiles the seed gives', show(g.mem('BOARD', 16)) === show(model), `${show(g.mem('BOARD', 16))} / ${show(model)}`);
  check('2048: the game screen (keys on the footer)', textAt(g.m, 185, 1, 2, 'ARROWS  R=NEW  BREAK=QUIT') === 'ARROWS  R=NEW  BREAK=QUIT', textAt(g.m, 185, 1, 2, 'ARROWS  R=NEW  BREAK=QUIT'));
  // THE TILE'S NUMBER IS INSIDE THE TILE AND CENTRED IN IT. Sampled from a FRESH session still on the title
  // page: the game board has only two tiles, so doing this after g.press('space') looked at empty squares and
  // the check could not fail. SQCOL and TILEW are BYTE quantities: tile n starts at pixel SQCOL*4, 24 px wide.
  // The digits are NOT one colour: STYLES gives the demo tiles different text colours (tile 2's is 3, the
  // others 2), so "the number's colour" is read per tile as "anything that is not the tile's own body", which
  // is what the eye sees and what survives a palette change.
  {
    const g2 = start('2048', { seed: 0xBEEF });          // a fresh session, still on the title page
    const px = (x, y) => (g2.m.ram[0x400 + y * 32 + (x >> 2)] >> (6 - 2 * (x & 3))) & 3;
    const bad = [];
    for (const [i, val, digits] of [[0, 2, 1], [1, 16, 2], [2, 128, 3], [3, 2048, 4]]) {
      const sqcol = 2 + 7 * i, x0 = sqcol * 4, x1 = x0 + 23;
      const xa = x0 + 4, xb = x1 - 4, ya = 74, yb = 83;   // inside the border, the digits' own band
      // the tile's body colour: the most common colour in the band. Anything else is digit ink.
      const hist = [0, 0, 0, 0];
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) hist[px(x, y)]++;
      const body = hist.indexOf(Math.max(...hist));
      let n = 0, lo = -1, hi = -1;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) if (px(x, y) !== body) { n++; if (lo < 0) lo = x; hi = x; }
      if (!n) { bad.push(`${val}: no digits in its box (px ${x0}..${x1})`); continue; }
      // CENTRED: the ink's midpoint is within a pixel of the box's, for every digit count (a stale x4 of the
      // byte column lands a 4-digit number hard against one edge, which "present" alone would have accepted)
      const want = x0 + 11.5, got = (lo + hi) / 2;
      if (Math.abs(got - want) > 1.5) bad.push(`${val} (${digits} digits): ink centred at ${got}, the box's centre is ${want}`);
    }
    check('2048: a tile\'s number is inside its own box and centred in it (the 1x column is converted from bytes)', bad.length === 0, bad.join('; '));
  }
  // a known game: 60 moves from the seed, the board and the score after each one as the rules give
  const dirs = ['left', 'up', 'right', 'down'];
  let same = true, firstBad = '', merges = 0;
  for (let i = 0; i < 60 && same; i++) {
    const d = i % 7 === 3 ? 'right' : dirs[(i * 3) % 4] === 'down' && i % 2 ? 'left' : dirs[(i * 3) % 4];
    const r = move(model, d);
    if (r.changed) { model = r.board; score += r.score; spawn(model, rng); if (r.score) merges++; }
    g.press(d === 'up' ? 'W' : d);   // W A S D as well as the arrows
    const got = g.mem('BOARD', 16), sc = bcd(g.mem('SCORE', 3));
    if (show(got) !== show(model) || sc !== score) { same = false; firstBad = `move ${i} ${d}: ${show(got)} score ${sc}, model ${show(model)} score ${score}`; }
  }
  check('2048: 60 scripted moves give the board and score of the rules', same && merges > 10, firstBad || `${merges} moves joined tiles, score ${score}`);
  // the score on the screen: six digits, leading zeros as spaces, red, 10 rows tall at byte 14
  // the score on the screen: digits centered in the score's cell (bytes 14-19, i.e. pixels 56-79) and the best
  // score's (bytes 22-27, pixels 88-111), red, 10 rows tall
  const shown = [textAt(g.m, 7, 2, 3, String(score), 56, 80), textAt(g.m, 7, 2, 3, String(score), 88, 112)];
  // SCORE and BEST are two SEPARATE strings, printed at bytes 14 and 22 (14*4 and 22*4 pixels). Reading them as
  // one run of text only worked while every cell was the same width: the proportional font changes the gap
  // between them, so a single 'SCORE   BEST' literal pinned fixed-cell spacing rather than the labels being
  // right. Split, each label must be found at EXACTLY its own column — "each appears somewhere" would accept a
  // label drawn at the wrong byte, which is what this check exists to catch.
  const sAt = glyphsAt(g.m, 1, 1, 2, 'SCORE', 0, 128), bAt = glyphsAt(g.m, 1, 1, 2, 'BEST', 0, 128);
  const scoreLabel = sAt && sAt[0].x === 14 * 4, bestLabel = bAt && bAt[0].x === 22 * 4;
  check('2048: the score and the best score are shown, each label at its own column (14 and 22 in bytes)',
    shown[0] === String(score) && shown[1] === String(score) && scoreLabel && bestLabel,
    JSON.stringify([shown, sAt ? sAt[0].x : null, bAt ? bAt[0].x : null, 'want 56 and 88']));
  check('2048: MOVES counts the moves that changed the board', g.mem('MOVES', 2)[1] > 30);

  // a join doubles a tile, once per move: 2 2 2 2 -> 4 4, and 4 4 . . -> 8
  const pokeBoard = (b) => b.forEach((v, i) => g.m.poke(g.sym('BOARD') + i, v));
  g.press('R');
  pokeBoard([1, 1, 1, 1, 2, 2, 0, 0, 3, 0, 3, 0, 0, 0, 0, 0]);
  const before = bcd(g.mem('SCORE', 3));
  g.press('left');
  const b = g.mem('BOARD', 16);
  check('2048: LEFT joins 2 2 2 2 into 4 4, 4 4 into 8, 8 . 8 into 16', b[0] === 2 && b[1] === 2 && b[2] === 0 && b[4] === 3 && b[5] === 0 && b[8] === 4 && b[9] === 0
    && bcd(g.mem('SCORE', 3)) - before === 4 + 4 + 8 + 16, show(b));
  check('2048: and a new tile came (one more than the joins left)', b.filter((v) => v).length === 5, show(b));
  // a move that changes nothing brings no tile
  pokeBoard([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g.press('left');
  check('2048: a move that changes nothing brings no new tile', show(g.mem('BOARD', 16)) === show([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

  // 2048 made: said once, and play goes on
  pokeBoard([10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g.press('left');
  check('2048: joining two 1024s makes 2048 and says so', g.mem('BOARD')[0] === 11 && g.mem('WONSEEN')[0] === 1 && textAt(g.m, 185, 1, 3, 'YOU MADE 2048! PLAY ON') === 'YOU MADE 2048! PLAY ON', textAt(g.m, 185, 1, 3, 'YOU MADE 2048! PLAY ON'));
  const moves = g.mem('MOVES', 2)[1];
  g.press('right');
  check('2048: play goes on after 2048', g.mem('MOVES', 2)[1] === moves + 1 && g.mem('BOARD', 16).includes(11) && g.mem('LOST')[0] === 0);

  // a full board whose only join is vertical is not over: RIGHT fills the last square, leaving 16 over 16 in the
  // right-hand column (the model checks it for both new tiles)
  const vert = [1, 2, 1, 2, 2, 1, 2, 1, 3, 4, 3, 4, 3, 5, 4, 0];
  const vAfter = move(vert, 'right').board;
  check('2048: (the model: after RIGHT on this board only UP or DOWN moves, whichever tile comes)', [1, 2].every((v) => { const x = vAfter.slice(); x[vAfter.indexOf(0)] = v;
    return !move(x, 'left').changed && !move(x, 'right').changed && move(x, 'up').changed; }));
  g.press('R');
  pokeBoard(vert);
  g.press('right');
  const scoreV = bcd(g.mem('SCORE', 3)), full = g.mem('BOARD', 16), up = move(full, 'up');
  check('2048: a full board with a vertical join left is not over', g.mem('LOST')[0] === 0 && full.every((v) => v), show(full));
  g.press('up');
  const afterUp = g.mem('BOARD', 16);
  check('2048: and UP joins the two 16s into a 32', bcd(g.mem('SCORE', 3)) === scoreV + up.score && up.score === 32 && afterUp[11] === 5
    && afterUp.every((v, i) => v === up.board[i] || up.board[i] === 0), `${show(afterUp)} score ${bcd(g.mem('SCORE', 3)) - scoreV}`);
  // game over: a board where RIGHT fills the last square, and whichever tile comes, no move is left
  // (found from the rules: the model checks it for both new tiles)
  const last = [1, 2, 1, 2, 2, 1, 2, 1, 3, 4, 3, 4, 5, 6, 5, 0];
  const after = move(last, 'right').board;
  const stuck = [1, 2].every((v) => { const x = after.slice(); x[after.indexOf(0)] = v; return !canMove(x); });
  check('2048: (the model: RIGHT on this board leaves no move, whichever tile comes)', move(last, 'right').changed && stuck);
  g.press('R');
  pokeBoard(last);
  g.press('right');
  check('2048: no move left: game over', g.mem('LOST')[0] === 1 && textAt(g.m, 185, 1, 3, 'NO MOVES LEFT. R PLAYS AGAIN') === 'NO MOVES LEFT. R PLAYS AGAIN', textAt(g.m, 185, 1, 3, 'NO MOVES LEFT. R PLAYS AGAIN'));
  const frozen = show(g.mem('BOARD', 16));
  g.press('left', 'up');
  check('2048: after game over the arrows do nothing', show(g.mem('BOARD', 16)) === frozen);
  g.press('R');
  check('2048: R starts again: two tiles, score 0, the best score kept', g.mem('BOARD', 16).filter((v) => v).length === 2 && bcd(g.mem('SCORE', 3)) === 0
    && g.mem('LOST')[0] === 0 && bcd(g.mem('BEST', 3)) >= score);
  // BREAK: the text screen, cleared, and DONE
  g.press('break');
  check('2048: BREAK leaves: text mode, a blank screen, stopped at DONE', g.m.cpu.pc === Emu.GAMES.done && (g.m.pia1.saveState().b.or & 0x80) === 0
    && (g.m.sam.reg & 7) === 0 && g.s.screenText().every((l) => !l.trim()));
}

// ---- the best score (BEST): a game's own, kept while 2048 runs, shown beside SCORE ----
// It is in the game's RAM at $3000+ (it does not survive a reload: nothing about the games is persisted), R does
// not clear it, and it only ever rises. Each check below names what would make it fail.
{
  const g = start('2048', { seed: 0x5EED });
  g.press('space');                                    // the title page
  const best0 = bcd(g.mem('BEST', 3));
  check('2048 BEST: a new game starts it at 0', best0 === 0 && bcd(g.mem('SCORE', 3)) === 0, String(best0));
  // a join raises SCORE and BEST together: 2 2 in the top row scores 4
  const poke = (b) => b.forEach((v, i) => g.m.poke(g.sym('BOARD') + i, v));
  poke([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g.press('left');
  const sc1 = bcd(g.mem('SCORE', 3)), best1 = bcd(g.mem('BEST', 3));
  check('2048 BEST: it rises with the score when the score passes it', sc1 === 4 && best1 === 4, `score ${sc1} best ${best1}`);
  // and the screen shows it: BEST's six digits sit at pixels 88-111 of the score row, leading zeros as spaces
  // shown beside SCORE: SCORE's digits and BEST's are drawn on the score row, one field after the other, and the
  // right margin is clear (BEST's field ends inside the 128 pixels). Both read 4 here, so the two glyphs' bitmaps
  // are the same - which is what "it is shown, and shows the value BEST holds" means.
  const ink = (px, k) => ((g.m.ram[0x400 + (7 + k) * 32 + (px >> 2)] >> (6 - 2 * (px & 3))) & 3) === 3;
  const SCOREX = 76, BESTX = 108;   // the two digits' first pixel, found from the row (3 pixels a digit)
  const alike = (x, y) => { for (let k = 0; k < 10; k++) for (let px = 0; px < 3; px++) if (ink(x + px, k) !== ink(y + px, k)) return false; return true; };
  let rightmost = -1;
  for (let px = 0; px < 128; px++) for (let k = 0; k < 10; k++) if (ink(px, k)) rightmost = px;
  check('2048 BEST: SCORE and BEST both show 4 on the score row, and BEST ends inside the 128 pixels',
    alike(SCOREX, BESTX) && rightmost < 128 && BESTX > SCOREX, `rightmost ${rightmost} best@${BESTX}`);
  // R starts a new game with SCORE 0 and leaves BEST alone (the check that fails if NEWGAME clears BEST too)
  g.press('R');
  check('2048 BEST: R clears the score but keeps the best', bcd(g.mem('SCORE', 3)) === 0 && bcd(g.mem('BEST', 3)) === 4,
    `score ${bcd(g.mem('SCORE', 3))} best ${bcd(g.mem('BEST', 3))}`);
  // a game that never catches up does not lower it: poke a small score and play a move that scores 0
  g.m.poke(g.sym('SCORE'), 0); g.m.poke(g.sym('SCORE') + 1, 0); g.m.poke(g.sym('SCORE') + 2, 0);
  poke([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g.press('left');                                     // nothing joins: SCORE stays 0
  check('2048 BEST: a lower score never lowers it', bcd(g.mem('BEST', 3)) === 4 && bcd(g.mem('SCORE', 3)) === 0,
    `score ${bcd(g.mem('SCORE', 3))} best ${bcd(g.mem('BEST', 3))}`);
  // a higher score raises it, and it holds the higher value
  g.m.poke(g.sym('SCORE'), 0x00); g.m.poke(g.sym('SCORE') + 1, 0x12); g.m.poke(g.sym('SCORE') + 2, 0x34);
  poke([3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g.press('left');                                     // 8 + 8 = 16 more
  check('2048 BEST: a higher score raises it, and it holds', bcd(g.mem('BEST', 3)) === 1234 + 16,
    `best ${bcd(g.mem('BEST', 3))} score ${bcd(g.mem('SCORE', 3))}`);
  // it fits the line: SCORE's six digits end before BEST's begin, and BEST's end inside 128 pixels.
  // SCORE is at pixel 56, BEST at 88: six digits of 8 pixels (2x, 4-byte cells) is 48, so SCORE ends at 104
  // only if it is full - the fixture is that the two fields' ink never overlaps and the right margin is clear.
  const inked = (a, b) => { for (let px = a; px < b; px++) for (let k = 0; k < 10; k++) if (((g.m.ram[0x400 + (7 + k) * 32 + (px >> 2)] >> (6 - 2 * (px & 3))) & 3) === 3) return true; return false; };
  check('2048 BEST: SCORE ends before BEST begins and BEST ends inside the line',
    inked(80, 88) === false && inked(120, 128) === false, `gap ${inked(80, 88)} margin ${inked(120, 128)}`);
  g.press('break');
}

// 2048's move cue: one tone per move, its pitch from the biggest join, and the half period is EXACT in cycles
// (a zero-crossing rate over a 60 ms note cannot resolve a semitone; 5*A+22 can). A move that joins nothing plays
// C5 (A=167 -> 857); a join of two 4s (MERGED=1) also plays C5, one of two 8s (MERGED=2) plays D5 (A=148 -> 762).
{
  const halvesOf = (edges) => { const out = []; for (let i = 1; i < edges.length; i++) if (Math.abs(edges[i][1] - edges[i - 1][1]) > 0.8) out.push(edges[i][0] - edges[i - 1][0]); return out; };
  const cueHalves = (g, key, poke) => {
    const m = g.m, edges = [];
    if (poke) poke(m);
    m.stubKeys.push(key);
    for (let i = 0; i < 20; i++) { const base = m.frameBase; m.runFrame(); for (let k = 2; k < m.audioEvents.length; k += 2) edges.push([base + m.audioEvents[k], m.audioEvents[k + 1]]); }
    return halvesOf(edges);
  };
  const g = start('2048', { seed: 0xBEEF });
  g.press('space');   // deal
  const plain = cueHalves(g, 8);   // LEFT, no join
  check('2048: a move with no join plays C5 exactly (half periods of 5*167+22 = 857, +-2)',
    plain.length >= 50 && plain.every((h) => Math.abs(h - 857) <= 2), `${plain.length} halves, ${[...new Set(plain)].slice(0, 4).join(',')}`);
  // MERGED is the VALUE OF THE JOINED TILE (a 4 is level 3: two level-2 tiles double into it), and the note is
  // PENTA[MERGED-1], so a join making a 4 plays E5 (A=131 -> 677) and one making an 8 plays G5 (A=110 -> 572).
  // A move that joins nothing plays C5 (A=167 -> 857).
  const g2 = start('2048', { seed: 0xBEEF });
  g2.press('space', 'R');
  const joined = cueHalves(g2, 8, (m) => [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].forEach((v, i) => m.poke(g2.sym('BOARD') + i, v)));
  check('2048: a move whose join makes a 4 plays E5 exactly (half periods of 5*131+22 = 677, +-2)',
    joined.length >= 50 && joined.every((h) => Math.abs(h - 677) <= 2), `${joined.length} halves, ${[...new Set(joined)].slice(0, 4).join(',')}`);
  const g3 = start('2048', { seed: 0xBEEF });
  g3.press('space', 'R');
  const two = cueHalves(g3, 8, (m) => [3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].forEach((v, i) => m.poke(g3.sym('BOARD') + i, v)));
  check('2048: a move whose join makes an 8 plays G5 exactly (half periods of 5*110+22 = 572, +-2)',
    two.length >= 50 && two.every((h) => Math.abs(h - 572) <= 2), `${two.length} halves, ${[...new Set(two)].slice(0, 4).join(',')}`);
}
for (const machine of ['dragon32', 'coco', 'coco3', 'dragon64:6309']) {
  const [id, cpu] = machine.split(':');
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(id, cpu ? { cpu } : {}, { menu: false });
  s.load('2048.bin', bin('2048'), { remember: false });
  s.runFrames(30); s.shownMachine.poke(Emu.GAMES.seed, 0xBE); s.shownMachine.poke(Emu.GAMES.seed + 1, 0xEF);
  s.shownMachine.stubKeys.push(32); s.runFrames(20);
  s.shownMachine.stubKeys.push(8); s.runFrames(20);
  const rng = new Rng(0xBEEF), model = new Array(16).fill(0);
  spawn(model, rng); spawn(model, rng);
  const r = move(model, 'left'); if (r.changed) spawn(r.board, rng);
  const got = Array.from(s.shownMachine.ram.slice(A['2048'].symbols.get('BOARD'), A['2048'].symbols.get('BOARD') + 16));
  check(`2048 on the ${s.shownMachine.profile.name}${cpu ? ` (${cpu})` : ''}: the same game`, show(got) === show(r.changed ? r.board : model), show(got));
}

// ================= Minesweeper =================
const nb = (i) => { const out = []; const x = i & 7, y = i >> 3; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const X = x + dx, Y = y + dy; if (X >= 0 && X < 8 && Y >= 0 && Y < 8) out.push(Y * 8 + X); } return out; };
{
  // the first square is always safe, and opens an area: 40 seeds
  let safe = true, detail = '';
  for (let seed = 1; seed <= 40 && safe; seed++) {
    const g = start('minesweeper', { seed: seed * 977 });
    g.press('space');   // the title
    g.press('space');   // the middle square (3, 3)
    const field = g.mem('FIELD', 64), state = g.mem('STATE', 64);
    const mines = field.map((v, i) => (v & 0x80 ? i : -1)).filter((i) => i >= 0);
    const keep = [27, ...nb(27)];
    // counts and the flood, from the rules
    const count = (i) => nb(i).filter((j) => field[j] & 0x80).length;
    const open = new Set([27]), queue = [27];
    while (queue.length) { const c = queue.shift(); if (count(c)) continue; for (const j of nb(c)) if (!open.has(j)) { open.add(j); queue.push(j); } }
    const ok = g.mem('LOST')[0] === 0 && mines.length === 10 && !mines.some((i) => keep.includes(i))
      && field.every((v, i) => (v & 0x80) || (v & 0x0F) === count(i))
      && state.every((v, i) => (v === 1) === open.has(i)) && g.mem('OPENED')[0] === open.size;
    if (!ok) { safe = false; detail = `seed ${seed * 977}: mines ${mines} open ${[...open]} state ${state}`; }
  }
  check('Minesweeper: 40 games: the first square is safe, no mine next to it, ten mines, every count right, the flood opens what the rules open', safe, detail);
}
{
  {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine('dragon64', {}, { menu: false });
    s.load('minesweeper.bin', bin('minesweeper'), { remember: false });
    const f = titleFrames(s, (k) => A.minesweeper.symbols.get(k));
    s.close?.();
    check('Minesweeper: the title page is drawn within 30 frames (a slower one eats the first key)', f <= TITLE_BUDGET, `${f} frames`);
  }
  const g = start('minesweeper', { seed: 0x5EED });
  // THE SAME ALIGNMENT INVARIANT AS 2048'S TITLE, for Minesweeper: every glyph on an even pixel column, and each
  // string found in exactly one place, at the computed even-aligned centre. Without this only 2048's title was
  // pinned, so a renderer change could move Minesweeper's text and nothing would say so.
  {
    const odd = [], where = [];
    for (const [line, row, tall, fg, text] of [['T_GOAL1', 96, 2, 3, 'TEN MINES ARE HIDDEN'],
      ['T_GOAL2', 110, 2, 3, 'OPEN EVERY OTHER SQUARE'], ['T_KEYS1', 132, 1, 1, 'ARROWS MOVE  SPACE OPENS'],
      ['T_KEYS2', 142, 1, 1, 'F FLAGS A MINE  R START'], ['T_KEYS3', 152, 1, 1, 'A NUMBER: MINES NEXT TO IT'],
      ['T_PRESS', 174, 1, 2, 'PRESS A KEY TO PLAY']]) {
      const hs = hits(g.m, row, tall, fg, text);
      const want = ((128 - strWidth(text)) >> 1) & ~1;
      if (hs.length !== 1) { where.push(`${line}: ${hs.length} matches (want exactly 1 at ${want})`); odd.push(`${line}: not found`); continue; }
      const gs = hs[0];
      if (gs[0].x !== want) where.push(`${line}: starts at ${gs[0].x}, the even-aligned centre is ${want}`);
      for (const gl of gs) if (gl.x % 2) odd.push(`${line} '${gl.ch}' @${gl.x}`);
    }
    check('Minesweeper: every 1x title glyph starts at an even pixel column (the renderer needs phase 0 or 2)', odd.length === 0, odd.join(', '));
    check('Minesweeper: each 1x title string is found in exactly one place, at the even-aligned centre', where.length === 0, where.join('; '));
  }
  check('Minesweeper: the title page', textAt(g.m, 96, 2, 3, 'TEN MINES ARE HIDDEN') === 'TEN MINES ARE HIDDEN' && textAt(g.m, 174, 1, 2, 'PRESS A KEY TO PLAY') === 'PRESS A KEY TO PLAY',
    JSON.stringify([textAt(g.m, 96, 2, 3, 'TEN MINES ARE HIDDEN'), textAt(g.m, 174, 1, 2, 'PRESS A KEY TO PLAY')]));
  check('Minesweeper: the second colour set (CSS)', (g.m.pia1.saveState().b.or & 0xF8) === 0xE8);
  // the stack: a pattern under it, to see how deep it goes over a whole game
  // (below where S is now: the game waits in GETKEY, its return addresses above S)
  const s0 = g.m.cpu.s;
  for (let a = 0x1C00; a < s0; a++) g.m.poke(a, 0x5A);
  g.press('space');
  check('Minesweeper: the game screen', textAt(g.m, 16, 1, 3, 'SPACE OPENS  F FLAGS') === 'SPACE OPENS  F FLAGS' && textAt(g.m, 2, 2, 3, '10') === '10', JSON.stringify([textAt(g.m, 16, 1, 3, 'SPACE OPENS  F FLAGS'), textAt(g.m, 2, 2, 3, '10')]));
  // the cursor stays on the field
  g.press('up', 'up', 'up', 'up', 'left', 'left', 'left', 'left');
  check('Minesweeper: the cursor stops at the corner', g.mem('CURX', 2).join() === '0,0');
  g.press('right', 'right', 'right', 'down', 'down', 'down');
  check('Minesweeper: and moves back to the middle', g.mem('CURX', 2).join() === '3,3');
  // a flag before the first square: on and off
  g.press('F');
  check('Minesweeper: F flags a hidden square; the counter says 9', g.mem('STATE', 64)[27] === 2 && g.mem('FLAGS')[0] === 1 && textAt(g.m, 2, 2, 3, '09') === '09');
  g.press('space');
  check('Minesweeper: a flagged square does not open', g.mem('STATE', 64)[27] === 2 && g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0);
  g.press('F');
  check('Minesweeper: F again takes the flag off', g.mem('STATE', 64)[27] === 0 && g.mem('FLAGS')[0] === 0 && textAt(g.m, 2, 2, 3, '10') === '10');
  g.press('enter');   // ENTER opens as SPACE does
  check('Minesweeper: ENTER opens the square', g.mem('STATE', 64)[27] === 1 && g.mem('PLANTED')[0] === 10);
  g.press('F');
  check('Minesweeper: F on an open square does nothing', g.mem('STATE', 64)[27] === 1 && g.mem('FLAGS')[0] === 0);

  // win: open every safe square, walking the cursor there
  const field = g.mem('FIELD', 64);
  const goTo = (i) => {
    const [x, y] = g.mem('CURX', 2), tx = i & 7, ty = i >> 3;
    const keys = [];
    for (let k = x; k < tx; k++) keys.push('right'); for (let k = x; k > tx; k--) keys.push('left');
    for (let k = y; k < ty; k++) keys.push('down'); for (let k = y; k > ty; k--) keys.push('up');
    g.press(...keys);
  };
  // flag every mine but one first (at most ten flags: an eleventh is refused)
  const mines = field.map((v, i) => (v & 0x80 ? i : -1)).filter((i) => i >= 0);
  for (const i of mines) { goTo(i); g.press('F'); }
  check('Minesweeper: ten flags on the ten mines; the counter says 00', g.mem('FLAGS')[0] === 10 && textAt(g.m, 2, 2, 3, '00') === '00');
  const extra = g.mem('STATE', 64).findIndex((v) => v === 0);
  goTo(extra); g.press('F');
  check('Minesweeper: an eleventh flag is refused', g.mem('STATE', 64)[extra] === 0 && g.mem('FLAGS')[0] === 10);
  for (let i = 0; i < 64; i++) if (!(field[i] & 0x80) && g.mem('STATE', 64)[i] === 0) { goTo(i); g.press('space'); }
  check('Minesweeper: opening the 54 safe squares wins', g.mem('WON')[0] === 1 && g.mem('OPENED')[0] === 54 && g.mem('LOST')[0] === 0
    && textAt(g.m, 16, 1, 3, 'ALL CLEAR! R PLAYS AGAIN') === 'ALL CLEAR! R PLAYS AGAIN', textAt(g.m, 16, 1, 3, 'ALL CLEAR! R PLAYS AGAIN'));
  // the stack: how far below $3000 it went, and nothing between the screen and it was touched
  let low = 0x3000;
  for (let a = 0x1C00; a < s0; a++) if (g.m.ram[a] !== 0x5A) { low = a; break; }
  check('Minesweeper: the stack stays within 32 bytes of $3000 over a whole game (no recursion)', 0x3000 - low <= 32, `${0x3000 - low} bytes`);
  g.press('space', 'F', 'left');
  check('Minesweeper: after a win only R and BREAK do anything', g.mem('WON')[0] === 1 && g.mem('FLAGS')[0] === 10);

  // lose: a new game, then a mine
  g.press('R');
  check('Minesweeper: R starts again', g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0 && g.mem('FLAGS')[0] === 0 && g.mem('CURX', 2).join() === '3,3');
  g.press('space');
  const f2 = g.mem('FIELD', 64), boom = f2.findIndex((v) => v & 0x80);
  goTo(boom); g.press('space');
  check('Minesweeper: opening a mine loses: BOOM', g.mem('LOST')[0] === 1 && g.mem('BOOMSQ')[0] === boom && textAt(g.m, 16, 1, 3, 'BOOM! R PLAYS AGAIN') === 'BOOM! R PLAYS AGAIN', textAt(g.m, 16, 1, 3, 'BOOM! R PLAYS AGAIN'));
  // the mines show: the one that went off on orange, the others on buff; the field's pixels say which
  const sq = (i) => 0x400 + (24 + 20 * (i >> 3) + 9) * 32 + 4 + 3 * (i & 7);   // a row through the sprite's middle
  const other = f2.findIndex((v, i) => (v & 0x80) && i !== boom);
  const px = (a) => [0, 1, 2].flatMap((k) => [6, 4, 2, 0].map((sh) => (g.m.ram[a + k] >> sh) & 3)).slice(0, 11);   // the square's 11 pixels
  check('Minesweeper: the mine that went off is on orange, another mine shows magenta on buff', px(sq(boom)).includes(3) && px(sq(other)).includes(2)
    && px(sq(other)).includes(0) && !px(sq(other)).includes(3), JSON.stringify([px(sq(boom)), px(sq(other))]));
  g.press('break');
  check('Minesweeper: BREAK leaves: text mode, stopped at DONE', g.m.cpu.pc === Emu.GAMES.done && (g.m.pia1.saveState().b.or & 0x80) === 0);
}

// sounds: the flag's two notes are C5 then G5 (delays 167 and 110, 24 and 24 half periods); TONE's half period
// is 5*D+22 cycles, so 857 and 572. The old cue was a 17 ms ~1754 Hz buzz.
{
  const g = start('minesweeper', { seed: 7 });
  g.press('space');
  const m = g.m, edges = [];
  m.stubKeys.push(70);   // F on a HIDDEN square: the only case that plays the flag
  for (let i = 0; i < 20; i++) { const base = m.frameBase; m.runFrame(); for (let k = 2; k < m.audioEvents.length; k += 2) edges.push([base + m.audioEvents[k], m.audioEvents[k + 1]]); }
  const halves = [];
  for (let i = 1; i < edges.length; i++) if (Math.abs(edges[i][1] - edges[i - 1][1]) > 0.8) halves.push(edges[i][0] - edges[i - 1][0]);
  const near = (h, d) => Math.abs(h - (5 * d + 22)) <= 3;
  const a = halves.filter((h) => near(h, 167)).length, b = halves.filter((h) => near(h, 110)).length;
  check('Minesweeper: F plays C5 then G5 (24 half periods at 5*167+22 and 5*110+22 cycles)', a >= 22 && a <= 24 && b >= 22 && b <= 24, `${a} ${b} of ${halves.length}`);
  // The open tick is E5 (A=131 -> 677 cycles a half period). A zero-crossing RATE over a 30 ms burst can only
  // resolve ~44 cents, so a semitone error (6%) would pass an 8% pitch test; the half period in CYCLES is exact.
  // The same for F on an open square (A=200 -> 1022), which is only ~9 ms long.
  const halfCycles = (from) => { const out = []; for (let i = 1; i < from.length; i++) if (Math.abs(from[i][1] - from[i - 1][1]) > 0.8) out.push(from[i][0] - from[i - 1][0]); return out; };
  const g2 = start('minesweeper', { seed: 7 });
  g2.press('space');
  const m2 = g2.m, openEdges = [];
  m2.stubKeys.push(32);   // SPACE: opens the first square (always safe) -> the E5 tick
  for (let i = 0; i < 20; i++) { const base = m2.frameBase; m2.runFrame(); for (let k = 2; k < m2.audioEvents.length; k += 2) openEdges.push([base + m2.audioEvents[k], m2.audioEvents[k + 1]]); }
  const openHalves = halfCycles(openEdges);
  check('Minesweeper: the open tick is E5 exactly (every half period 5*131+22 = 677 cycles, +-2)',
    openHalves.length >= 20 && openHalves.every((h) => Math.abs(h - 677) <= 2),
    `${openHalves.length} half periods, ${[...new Set(openHalves)].slice(0, 5).join(',')}`);
  const g3 = start('minesweeper', { seed: 7 });
  g3.press('space', 'space');   // open (3,3), then F on it: the low note A=200 -> 1022
  const m3 = g3.m, buzzEdges = [];
  m3.stubKeys.push(70);
  for (let i = 0; i < 20; i++) { const base = m3.frameBase; m3.runFrame(); for (let k = 2; k < m3.audioEvents.length; k += 2) buzzEdges.push([base + m3.audioEvents[k], m3.audioEvents[k + 1]]); }
  const buzzHalves = halfCycles(buzzEdges);
  check('Minesweeper: F on an OPEN square is the low note exactly (half periods of 5*200+22 = 1022, +-2)',
    buzzHalves.length >= 6 && buzzHalves.every((h) => Math.abs(h - 1022) <= 2),
    `${buzzHalves.length} half periods, ${[...new Set(buzzHalves)].slice(0, 5).join(',')}`);
}

// the Session: runGame, the last run, the menu after BREAK, the carry-on line, and no games on a 6803
{
  const st = new Map(), store = { get: (k) => (st.has(k) ? st.get(k) : null), set: (k, v) => st.set(k, String(v)), remove: (k) => st.delete(k), keys: () => [...st.keys()] };
  const s = new Emu.Session({ store });
  s.switchMachine('dragon64');
  const events = [];
  let runningAtGame = null;
  let controlsAtGame = null;
  s.on((e) => { events.push(e); if (e === 'program') { runningAtGame = s.gameRunning; controlsAtGame = s.programControls; } });
  check('Session.gameRunning: false on the welcome menu', s.gameRunning === false);
  s.runGame('minesweeper', bin('minesweeper'));
  check('Session.runGame emits program, with gameRunning already true for the listeners (the touch panel\'s pad)', runningAtGame === true && s.gameRunning === true, events.join());
  check('Session.programControls: Minesweeper is played with the arrows, F and a joystick (UX R30, R32)', JSON.stringify(controlsAtGame) === '{"id":"minesweeper","input":"arrows","extra":["F"],"joystick":true}', JSON.stringify(controlsAtGame));
  check('Session.runGame remembers the game as the last run', JSON.stringify(s.lastRun) === '{"kind":"game","name":"Minesweeper"}' && s.carryOn && s.carryOn.name === 'Minesweeper');
  s.runFrames(5); s.shownMachine.stubKeys.push(32); s.runFrames(20); s.shownMachine.stubKeys.push(3); s.runFrames(20);
  check('BREAK in a game: the Session emits menu', events.includes('menu'), events.filter((e) => !/^(frame|status)/.test(e)).join());
  check('Session.gameRunning: false once the game is left; no program controls on the welcome menu', s.gameRunning === false && s.programControls === null);
  s.startWelcome(bin('welcome'), { greeting: 'back', carryOn: s.carryOn.name });
  s.runFrames(50);
  check('the welcome menu offers it back as option 6', s.screenText()[12].trim() === '6 CARRY ON WITH MINESWEEPER', s.screenText()[12]);
  let err = null;
  try { s.gameFile('tetris'); } catch (e) { err = e; }
  check('an unknown game is a SessionError', err instanceof Emu.SessionError);
  s.switchMachine('mc10');
  err = null;
  try { s.runGame('2048', bin('2048')); } catch (e) { err = e; }
  check('the games are refused on the MC-10, saying why; no carry-on line for them there', err instanceof Emu.SessionError && /6809/.test(err.message) && s.carryOn === null, err && err.message);
  // under 32K: refused before anything is loaded (the SAM would be set for chips the machine hasn't)
  for (const ram of [4, 16]) {
    s.switchMachine('coco', { ram });
    const before = s.shownMachine.ram[0x3000];
    err = null;
    try { s.runGame('2048', bin('2048')); } catch (e) { err = e; }
    check(`the games are refused on a ${ram}K CoCo, saying why, with nothing loaded`, err instanceof Emu.SessionError
      && err.message === `2048 needs 32K RAM or more; this CoCo 1/2 has ${ram}K. Switch the RAM option to 32K or 64K to play it.`
      && JSON.stringify(s.gameNeeds()) === JSON.stringify({ ram: 32, have: ram }) && s.shownMachine.ram[0x3000] === before, err && err.message);
  }
  s.switchMachine('coco', { ram: 32 });
  check('a 32K CoCo has what the games need', s.gameNeeds() === null);
  // Minesweeper too: the SAME refusal is enforced where the game is loaded, which is what makes the variables
  // above $4000 legitimate (see the image/variable check at the top of this file)
  {
    const before = s.shownMachine.ram[0x3000];
    s.switchMachine('coco', { ram: 16 });
    let merr = null;
    try { s.runGame('minesweeper', bin('minesweeper')); } catch (e) { merr = e; }
    check('Minesweeper is refused on a 16K CoCo, saying why, with nothing loaded',
      merr instanceof Emu.SessionError && /^Minesweeper needs 32K RAM or more; this CoCo 1\/2 has 16K/.test(merr.message)
      && s.shownMachine.ram[0x3000] === before, merr && merr.message);
    s.switchMachine('coco', { ram: 32 });
  }
  s.runGame('2048', bin('2048'));
  const was = s.gameRunning;
  check('Session.programControls: 2048 is played with the arrows alone', JSON.stringify(s.programControls) === '{"id":"2048","input":"arrows","extra":[],"joystick":false}', JSON.stringify(s.programControls));
  s.switchMachine('dragon64');
  check('Session.gameRunning: a machine switch ends it (the game ran on the old machine)', was === true && s.gameRunning === false && s.programControls === null);
}

// BREAK on the title page leaves too; the game puts the SAM's memory size back as it found it (SAMEXIT, set by the
// Session from the machine), after running with M=10. The built-in firmware already leaves M=10 on a 64K machine (the
// Session records that), so SAMEXIT is then set to 16K (M=01): a game that left M at 10 instead of putting back what
// SAMEXIT holds fails here.
for (const name of ['2048', 'minesweeper']) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  const m = s.shownMachine;
  s.runGame(name, bin(name));
  const recorded = m.ram[Emu.GAMES.samExit] === m.sam.memSize && m.sam.memSize === 2;
  const m0 = 1;
  m.poke(Emu.GAMES.samExit, m0);
  s.runFrames(30);
  const during = m.sam.memSize, samExit = m.ram[Emu.GAMES.samExit];
  m.stubKeys.push(3); s.runFrames(10);
  check(`${name}: BREAK on the title page leaves (text mode, DONE); the SAM's M is back to ${m0} after ${during} while it ran`, m.cpu.pc === Emu.GAMES.done
    && (m.pia1.saveState().b.or & 0x80) === 0 && recorded && m.sam.memSize === m0 && during === 2 && samExit === m0 && A[name].symbols.get('SAMEXIT') === Emu.GAMES.samExit);
}

// With BASIC ROMs: BREAK hands the machine back to BASIC, started cold. A stand-in BASIC (our own firmware, no ROM
// code: it sets the SAM as BASIC does, M=10, clears the text screen and prints OK and then COLD or WARM from BASIC's
// warm-start flag at $0071, which it then sets to $55, as BASIC does; its POLCAT reads SPACE and BREAK from the
// matrix) boots; the reset button gives WARM (the control); the game runs on it; BREAK leaves the game, the Session
// clears the flag and presses reset, and BASIC is back started cold: OK COLD on the text screen, its SAM settings,
// and the 'reset' event (?start= goes with it on the page).
{
  const STANDIN = `
LAST    EQU     $7F80
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     $FF01
        CLR     $FF00
        LDA     #$04
        STA     $FF01
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        STA     $FFDA
        STA     $FFDD
        STA     $FFC0
        STA     $FFC2
        STA     $FFC4
        STA     $FFC6
        STA     $FFC9
        STA     $FFCA
        STA     $FFCC
        STA     $FFCE
        STA     $FFD0
        STA     $FFD2
        LDA     $FF22
        ANDA    #$07
        STA     $FF22
        LDX     #$0400
        LDD     #$6060
CLS     STD     ,X++
        CMPX    #$0600
        BNE     CLS
        LDD     #$4F4B
        STD     $0400
        LDX     #COLDS
        LDA     $71
        CMPA    #$55
        BNE     PR
        LDX     #WARMS
PR      LDY     #$0403
PRL     LDA     ,X+
        BEQ     PRD
        STA     ,Y+
        BRA     PRL
PRD     LDA     #$55
        STA     $71
        CLR     LAST
IDLE    BRA     IDLE
POLCAT  PSHS    B
        LDA     #$7F
        STA     $FF02
        LDA     $FF00
        BITA    #$20
        BEQ     GOTSP
        LDA     #$FB
        STA     $FF02
        LDA     $FF00
        BITA    #$40
        BEQ     GOTBR
        CLR     LAST
        CLRA
        PULS    B,PC
GOTSP   LDB     #$20
        BRA     GOT
GOTBR   LDB     #$03
GOT     CMPB    LAST
        BEQ     NONE
        STB     LAST
        TFR     B,A
        TSTA
        PULS    B,PC
NONE    CLRA
        PULS    B,PC
COLDS   FCB     $43,$4F,$4C,$44,0
WARMS   FCB     $57,$41,$52,$4D,0
        ORG     $A000
        FDB     POLCAT
        ORG     $BFFE
        FDB     RESET
`;
  const asm = Emu.assemble(STANDIN, '6809');
  const rom = new Uint8Array(0x4000).fill(0x12);
  for (const seg of asm.segments) rom.set(seg.data, seg.addr - 0x8000);
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  s.addRoms([{ name: 'd64_1.rom', bytes: rom }, { name: 'd64_2.rom', bytes: new Uint8Array(0x4000).fill(0x13) }]);
  const m = s.shownMachine;
  s.runFrames(10);
  const booted = m.hasRom && s.screenText()[0].trim() === 'OK COLD' && m.cpu.pc === asm.symbols.get('IDLE');
  check('(the stand-in BASIC boots cold: OK COLD on the text screen)', asm.ok && booted, JSON.stringify(s.screenText()[0]));
  s.reset(); s.runFrames(10);
  check('(the control: the reset button with BASIC is a warm start, OK WARM)', s.screenText()[0].trim() === 'OK WARM', JSON.stringify(s.screenText()[0]));
  const events = [];
  s.on((e) => events.push(e));
  s.runGame('2048', bin('2048'));
  s.runFrames(30);
  const hold = (key) => { m.setKey(key, true); s.runFrames(3); m.setKey(key, false); s.runFrames(20); };
  hold('SPACE');
  const playing = (m.pia1.saveState().b.or & 0x80) !== 0 && m.ram[A['2048'].symbols.get('BOARD')] !== undefined
    && Array.from(m.ram.slice(A['2048'].symbols.get('BOARD'), A['2048'].symbols.get('BOARD') + 16)).filter((v) => v).length === 2;
  check('2048 with BASIC ROMs: it runs, reading SPACE through BASIC\'s POLCAT (two tiles on the board)', playing && m.ram[Emu.GAMES.samExit] === 2);
  hold('BREAK');
  s.runFrames(10);
  check('2048 with BASIC ROMs: BREAK hands the machine back to BASIC started cold (OK COLD, text mode, SAM M=10, at its idle loop)',
    events.includes('reset') && !events.includes('menu') && s.screenText()[0].trim() === 'OK COLD' && (m.pia1.saveState().b.or & 0x80) === 0
    && m.sam.memSize === 2 && m.cpu.pc === asm.symbols.get('IDLE') && m.hasRom, `${events.filter((e) => !/^(frame|status)/.test(e)).join()} | ${JSON.stringify(s.screenText()[0])}`);
}

// the flood leaves flagged squares alone: a flagged blank square inside the area the first square opens stays
// flagged and closed, the flood does not go through it, and FLAGS is unchanged (the model: the rules' flood with that
// square left out; the mines from the documented random numbers, laid as the game lays them)
{
  const layMines = (seed, first) => {
    const rng = new Rng(seed), field = new Array(64).fill(0);
    for (const i of [first, ...nb(first)]) field[i] = 0x40;
    let planted = 0;
    while (planted < 10) { const b = rng.below(64); if (field[b]) continue; field[b] = 0x80; planted++; }
    return field.map((v) => (v & 0x80 ? 0x80 : 0));
  };
  const count = (field, i) => nb(i).filter((j) => field[j]).length;
  const flood = (field, first, flagged) => {
    const open = new Set([first]), queue = [first];
    while (queue.length) { const c = queue.shift(); if (count(field, c)) continue; for (const j of nb(c)) if (j !== flagged && !open.has(j)) { open.add(j); queue.push(j); } }
    return open;
  };
  // a seed whose first square opens an area with another blank square in it, one whose neighbours open only through it
  let seed = 0, flagAt = -1, field = null;
  for (let sd = 1; sd < 500 && flagAt < 0; sd++) {
    const f = layMines(sd * 131, 27), all = flood(f, 27, -1);
    for (const c of all) if (c !== 27 && !count(f, c) && flood(f, 27, c).size < all.size - 1) { seed = sd * 131; flagAt = c; field = f; break; }
  }
  const g = start('minesweeper', { seed });
  g.press('space');
  const [x, y] = [flagAt & 7, flagAt >> 3], moves = [];
  for (let k = 3; k < x; k++) moves.push('right'); for (let k = 3; k > x; k--) moves.push('left');
  for (let k = 3; k < y; k++) moves.push('down'); for (let k = 3; k > y; k--) moves.push('up');
  g.press(...moves, 'F');
  const back = moves.map((k) => ({ right: 'left', left: 'right', up: 'down', down: 'up' })[k]);
  g.press(...back, 'space');
  const got = g.mem('FIELD', 64).map((v) => v & 0x80), state = g.mem('STATE', 64), want = flood(field, 27, flagAt);
  check('Minesweeper: (the model lays the mines the game laid)', got.join() === field.join());
  check(`Minesweeper: a flagged blank square in the first square's area (${x}, ${y}) stays flagged and closed, the flood goes round it, FLAGS stays 1`,
    seed > 0 && state[flagAt] === 2 && g.mem('FLAGS')[0] === 1 && state.every((v, i) => (i === flagAt ? v === 2 : (v === 1) === want.has(i))) && g.mem('OPENED')[0] === want.size,
    `seed ${seed} flag ${flagAt}: open ${state.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0)} want ${[...want]}`);
}

// the screens and the sound, through the command line (--expect-screenshot, --wav): scripted runs match the reference
// pictures in tests/fixtures/games (made by these same commands with --screenshot and looked at: the title pages, a
// 2048 board after six moves, a Minesweeper field after the first square, two moves and an F on an open square), pixel
// for pixel, and Minesweeper's recorded sounds match tests/fixtures/games/minesweeper-sounds.sha256.json, which holds
// the SHA-256 of their PCM samples (the recording itself is not committed: media files are refused by the pre-push
// guard; set CLOADM_KEEP_WAV to a path outside the repo to hear it). What the recording holds is checked from the
// samples: the first square's click, two cursor ticks,
// the low buzz of F on an open square, three ticks to the mine at (6, 3), its flag's chirp on and off, and the
// explosion (noise, the colours flashing, slower noise): bursts at full swing on the DAC (320 a step, mid level 32;
// a level that changes within a sample's stretch is averaged).
{
  const os = require('os'), { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-games-'));
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), ...args], { encoding: 'utf8' });
  const fix = (f) => path.join(__dirname, 'fixtures/games', f);
  const r1 = cli(['-m', 'dragon64', '--program', '2048', '--frames', '30', '--expect-screenshot', fix('2048-title.png'), '--poke', '$3003=$BE,$EF',
    '--type', ' ', '--frames', '20', '--type', '{LEFT}{UP}{LEFT}{UP}{RIGHT}{DOWN}', '--frames', '30', '--expect-screenshot', fix('2048-board.png')]);
  check('2048: the title page and the board after six moves match their reference pictures (--expect-screenshot)', r1.status === 0, r1.stderr);
  const lost = `$${A.minesweeper.symbols.get('LOST').toString(16)}=1`, wavFile = path.join(dir, 'sounds.wav');
  const r2 = cli(['-m', 'dragon64', '--program', 'minesweeper', '--frames', '30', '--expect-screenshot', fix('minesweeper-title.png'), '--poke', '$3003=$5E,$ED',
    '--type', ' ', '--frames', '20', '--wav', wavFile, '--type', ' ', '--frames', '20', '--type', '{RIGHT}{DOWN}F', '--frames', '20',
    '--expect-screenshot', fix('minesweeper-board.png'), '--type', '{UP}{RIGHT}{RIGHT}', '--frames', '5', '--type', 'F', '--frames', '10', '--type', 'F',
    '--frames', '10', '--type', ' ', '--frames', '60', '--wav-stop', '--expect-mem', lost]);
  check('Minesweeper: the title page and the field match their reference pictures; the mine at (6, 3) loses', r2.status === 0, r2.stderr);
  // under 32K the command line refuses too (exit 3, rejected), saying why
  const r4 = cli(['-m', 'coco', '-o', 'ram=16', '--program', '2048']);
  check('the command line refuses the games on a 16K CoCo (exit 3, the reason)', r4.status === 3 && /2048 needs 32K RAM or more; this CoCo 1\/2 has 16K/.test(r4.stderr), r4.stderr);
  // the reference picture is not blind: the title page is not the field
  const r3 = cli(['-m', 'dragon64', '--program', 'minesweeper', '--frames', '30', '--expect-screenshot', fix('minesweeper-board.png')]);
  check('(--expect-screenshot fails on another picture: the title page is not the field)', r3.status === 1, String(r3.status));
  const wav = fs.existsSync(wavFile) ? fs.readFileSync(wavFile) : Buffer.alloc(0);
  // The recording is not committed (media files are refused by the repository's pre-push guard), so its PCM samples
  // are compared by SHA-256 against a small JSON fixture: as strict as the byte-for-byte comparison it replaces.
  const want = JSON.parse(fs.readFileSync(fix('minesweeper-sounds.sha256.json'), 'utf8'));
  const pcm = wav.subarray(44);
  const got = crypto.createHash('sha256').update(pcm).digest('hex');
  // The fixture records the WAV HEADER's fields too, and they were never checked: a recording that came back at
  // another rate, or in stereo, or 8-bit, would still have matched a PCM hash taken from its own bytes. They are
  // read from the header the CLI wrote (not assumed: the hash covers the data from byte 44, so the header is the
  // only place these live), and compared with the fixture.
  const hdr = { sampleRate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), bits: wav.readUInt16LE(34) };
  const hdrOk = wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE'
    && wav.toString('ascii', 36, 40) === 'data' && wav.readUInt32LE(40) === pcm.length
    && hdr.sampleRate === want.sampleRate && hdr.channels === want.channels && hdr.bits === want.bits;
  check('Minesweeper: the WAV header of the recording says what the fixture does (RIFF/WAVE, its rate, channels and bits)',
    hdrOk, `${JSON.stringify(hdr)} vs ${JSON.stringify({ sampleRate: want.sampleRate, channels: want.channels, bits: want.bits })}, data chunk ${wav.length >= 44 ? wav.readUInt32LE(40) : '-'} of ${pcm.length}`);
  check('Minesweeper: its recorded sounds match tests/fixtures/games/minesweeper-sounds.sha256.json (SHA-256 of the PCM)',
    pcm.length === want.pcmBytes && got === want.sha256, `${pcm.length} bytes, ${got}`);
  // A person can listen to the recording, but it is written OUTSIDE the repository: CLOADM_KEEP_WAV names the file.
  if (process.env.CLOADM_KEEP_WAV && wav.length) {
    fs.writeFileSync(process.env.CLOADM_KEEP_WAV, wav);
    console.log(`(the recording was written to ${process.env.CLOADM_KEEP_WAV}, outside the repository)`);
  }
  const samples = [];
  for (let i = 44; i + 1 < wav.length; i += 2) samples.push(wav.readInt16LE(i));
  // The DAC rests at 0 (the games leave their silence there: a level that changed every field would be heard
  // as a 50 or 60 Hz tone - see the joystick section of games.inc), so silence is a sample at 0, not at 32
  // steps, and a burst is any run of samples away from it.
  const REST = 0;
  const bursts = [];
  let cur = null;
  samples.forEach((v, i) => { if (v !== REST) { if (cur && i - cur[1] <= 200) cur[1] = i; else { cur = [i, i]; bursts.push(cur); } } });
  const len = (b) => b[1] - b[0], full = (b) => { const x = samples.slice(b[0], b[1] + 1); return Math.max(...x) === 63 * 320 && Math.min(...x) <= 320; };
  // The floor in full() is not decoration: a burst that reaches the top and never comes down is not the
  // game's square wave, and the DAC's step is 320, so a sample within one step of silence is "at the
  // bottom". Shown on a synthetic burst, because the real recording has none that stays up (so the
  // recording alone could not tell the two versions of this predicate apart).
  {
    const up = new Array(40).fill(63 * 320), wave = [];
    for (let i = 0; i < 40; i++) wave.push(i % 2 ? 63 * 320 : 0);
    const isFull = (x) => { const m = Math.max(...x), n = Math.min(...x); return m === 63 * 320 && n <= 320; };
    check('Minesweeper: the burst predicate rejects a level that never comes down (the floor is load-bearing)',
      isFull(wave) === true && isFull(up) === false, `wave ${isFull(wave)}, stuck-high ${isFull(up)}`);
  }
  const what = bursts.map((b) => `${(b[0] / 44100).toFixed(2)}+${(len(b) / 44100).toFixed(3)}`).join(' ');
  // The cue list, in order: the first square's open tick (E5), two cursor ticks (the right arrow, the down
  // arrow), the low buzz of F on an OPEN square, three cursor ticks to (6,3), the flag's C5-G5 on and off, and
  // the mine: one noise burst. Every burst is at full swing on the DAC (top to bottom, 63 steps), and every
  // TONE cue has a pitch.
  check('Minesweeper: the recording is 10 bursts (open tick, 2 cursor ticks, buzz, 3 ticks, 2 flag chirps, the mine), all at full swing',
    bursts.length === 10 && bursts.every(full) && samples.every((v) => v >= 0 && v <= 63 * 320), what);
  // pitch by zero crossings about the rest level, over the burst's span; +-8% covers the DAC's step quantisation.
  // A burst that holds TWO notes (the flag's C5 then G5, no rest between) reads as their mean, so that one is
  // compared with the mean and each note is checked for what it is by the half-period counts in the edge test.
  const rest = 32 * 320;
  // ASSERT, don't throw: if the recording is wrong (a table entry changed, a burst missing) these must FAIL and
  // let the checks after them run. Reading b[0] of an undefined burst threw a TypeError, which aborted the rest
  // of the suite and made a single wrong table entry look like one PNG failure followed by a crash.
  if (bursts.length < 10) {
    check('Minesweeper: the recording holds the ten cues the analysis below measures', false, `only ${bursts.length} burst(s) in the recording`);
  } else {
  const zc = (b) => { let n = 0; for (let i = b[0] + 1; i <= b[1]; i++) if ((samples[i - 1] < rest) !== (samples[i] < rest)) n++; return n; };
  const hz = (b) => zc(b) / 2 / (len(b) / 44100);
  const near = (v, want) => Math.abs(v - want) / want <= 0.08;
  const cue = { open: hz(bursts[0]), buzz: hz(bursts[3]), flagOn: hz(bursts[7]), flagOff: hz(bursts[8]) };
  // the open tick is E5 (A=131 -> 660.9 Hz), 30 ms long: 39 crossings, so +-8% is real resolution there
  check('Minesweeper: the open tick is E5 (~661 Hz)',
    near(cue.open, 660.9), JSON.stringify(cue));
  // F on an OPEN square keeps the game's old low note (A=200 -> 437.8 Hz), but the burst is only ~9 ms: about 8
  // half periods, so a crossing count cannot resolve it better than ~12%. It is checked for being clearly LOWER
  // than the open tick, which a wrong high pitch would break; its exact length is not claimed from the WAV.
  check('Minesweeper: the F-on-an-open-square buzz is clearly lower than the open tick (about 8 half periods measured)',
    cue.buzz < cue.open * 0.75, JSON.stringify(cue));
  check('Minesweeper: the flag plays C5 then G5 (a rising pair, ~523 then ~784 Hz) and the unflag the same two falling',
    near(cue.flagOn, (523.25 + 783.99) / 2) && near(cue.flagOff, (523.25 + 783.99) / 2), JSON.stringify(cue));
  check('Minesweeper: the flag cue is a tone, not the old buzz (longer than 25 ms, fewer than 40 level changes per note)',
    len(bursts[7]) / 44100 > 0.025 && zc(bursts[7]) < 60, `${(len(bursts[7]) / 44100 * 1000).toFixed(1)} ms, ${zc(bursts[7])} crossings`);
  check('Minesweeper: the mine is one noise burst of about 150 ms (not three), with many level changes',
    len(bursts[9]) / 44100 > 0.12 && len(bursts[9]) / 44100 < 0.20 && zc(bursts[9]) > 400,
    `${(len(bursts[9]) / 44100 * 1000).toFixed(1)} ms, ${zc(bursts[9])} crossings`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ================= THE ANALOGUE JOYSTICK'S COMPARATOR =================
// The games read a joystick by writing a value to the DAC and asking whether the pot is at or above it, so the
// BOUNDARY is the whole contract: `joy >= dac` sets bit 7 of PIA0 port A. Both axes, both ports, checked either
// side of the comparator's own level -- not one point in the middle, which a wrong comparison would also pass.
{
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('coco', {}, { menu: false });
  const m = s.personMachine;
  // the ROM's own read: CB2 selects the port, CA2 the axis, the DAC is PIA1 port A bits 7-2
  // PIA register 0 is the port, 1 the control register; CA2/CB2 are control-register bits 5-3 (0x04 = output
  // low, 0x0C = output high). The port reads data only when the control register's bit 2 selects the data
  // direction register, so each port is put in "read the pins" mode once.
  // C2 as an output in the chip's MANUAL mode: control bit 5 (0x20) sets it to output, bit 4 (0x10) selects
  // manual, and bit 3 is the level. So 0x34 = output low, 0x3C = output high. (0x04 is neither: it leaves C2
  // an input, which reads false, so every axis and port select silently did nothing.)
  const C2_LOW = 0x34, C2_HIGH = 0x3C;
  // The DAC lives on PIA1 port A, whose pins must be OUTPUTS first: control bit 2 selects the data direction
  // register, and until it is set the DDR is 0, so a write to register 0 lands in the DDR instead of the output
  // register and the DAC reads 63 (all pins pulled high). The game's INIT does exactly this.
  m.pia1.write(1, 0x00);            // CR bit 2 clear: register 0 is the DDR
  m.pia1.write(0, 0xFE);            // bits 7-1 outputs (the DAC), bit 0 the cassette input
  m.pia1.write(1, 0x04);            // CR bit 2 set: register 0 is the output register again
  const comparatorHigh = (port, axis, dac) => {
    m.pia0.write(3, port ? C2_HIGH : C2_LOW);       // PIA0 CB2: which joystick
    m.pia0.write(1, axis ? C2_HIGH : C2_LOW);       // PIA0 CA2: which axis
    m.pia1.write(0, (dac & 0x3F) << 2);             // PIA1 port A: the DAC
    return (m.pia0.read(0) & 0x80) !== 0;
  };
  const cases = [];
  for (const port of [0, 1]) {
    for (const axis of [0, 1]) {
      for (const level of [24, 40]) {          // the two levels the game's own reading uses
        m.joy[port][axis] = level;
        cases.push(
          [port, axis, level, level - 1, true],   // dac below the pot: high
          [port, axis, level, level, true],       // equal: high, the boundary belongs to the pot
          [port, axis, level, level + 1, false],  // dac above: low
        );
      }
    }
  }
  const bad = [];
  for (const [port, axis, level, dac, want] of cases) {
    m.joy[port][axis] = level;
    const got = comparatorHigh(port, axis, dac);
    if (got !== want) bad.push(`port ${port} axis ${axis} pot ${level} dac ${dac}: got ${got}, want ${want}`);
  }
  check('the joystick comparator: joy >= DAC reads high, either side, on both axes of both ports', bad.length === 0, bad.slice(0, 6).join('; '));
  // and the port/axis selection really selects: a pot high on one axis must not answer for the other
  m.joy[0][0] = 63; m.joy[0][1] = 0;
  const selOk = comparatorHigh(0, 0, 32) === true && comparatorHigh(0, 1, 32) === false;
  check('the joystick comparator: CA2 selects the axis, so the other axis does not answer for it', selOk,
    `x63 at dac 32: ${comparatorHigh(0, 0, 32)}, y0 at dac 32: ${comparatorHigh(0, 1, 32)}`);
  m.joy[0][0] = 63; m.joy[1][0] = 0;
  const portOk = comparatorHigh(0, 0, 32) === true && comparatorHigh(1, 0, 32) === false;
  check('the joystick comparator: PIA0 CB2 selects the port, so the other joystick does not answer', portOk,
    `port0 x63 at dac 32: ${comparatorHigh(0, 0, 32)}, port1 x0 at dac 32: ${comparatorHigh(1, 0, 32)}`);
  s.close?.();
}

// ================= MINESWEEPER ON THE JOYSTICK =================
// The game reads both sticks once a field (RAWL), two comparator tests an axis at DAC 40 and 24, and the
// stick's steps are counted in fields by the FS flag, at 300 ms and then every 120 ms (15 and 6 fields at
// 50 Hz, 18 and 7 at 60). Fire: a tap under 400 ms opens on the release, a press of exactly 400 ms (20
// fields at 50 Hz, 24 at 60) or longer flags on that field, and after a win or a loss fire starts again on
// its release. The tests below measure the game's own state
// (CURX/CURY, STATE, FLAGS) after the emulator has run frames, which is the only thing a player sees.
{
  // a game in its loop, with the stick where the test puts it; `machine` sets both the field rate and the
  // axis range (a Dragon is 50 Hz, a CoCo 60)
  const loop = (machine = 'dragon64') => {
    const g = start('minesweeper', { machine, seed: 0x5EED });
    g.press('space');                                   // the title
    return g;
  };
  const cursor = (g) => g.mem('CURX', 2).join(',');
  // a stick direction as the page sets it: axisValue of +-1 is 63/0, and 32 is centred
  const RIGHT = 63, LEFT = 0, UP = 0, DOWN = 63, MID = 32;

  // ---- a new direction steps once, then after 300 ms, then every 120 ms; counted in fields ----
  for (const [machine, hz, firstRepeat, thenEvery, wantSteps] of [['dragon64', 50, 15, 6, 7], ['coco', 60, 18, 7, 7]]) {
    const g = loop(machine);
    // walk to x=0 so seven steps fit before the field's edge (the cursor clamps there)
    for (let i = 0; i < 4; i++) { g.press('left'); }
    const x0 = g.mem('CURX')[0];
    g.m.joy[0][0] = RIGHT;
    const at = [];
    let last = g.mem('CURX')[0];
    for (let f = 1; f <= hz; f++) { g.s.runFrames(1); const v = g.mem('CURX')[0]; if (v !== last) { at.push(f); last = v; } }
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    check(`Minesweeper stick (${hz} Hz): a held stick steps at field 1, then every ${firstRepeat}, then ${thenEvery} - ${wantSteps} steps in a second`,
      x0 === 0 && at.length === wantSteps && at[0] === 1 && gaps[0] === firstRepeat && gaps.slice(1).every((d) => d === thenEvery),
      `x0 ${x0}, steps at ${at.join(',')} (gaps ${gaps.join(',')})`);
    check(`Minesweeper stick (${hz} Hz): the field rate it detected is the machine's`, g.mem('FSRATE')[0] === (hz === 60 ? 1 : 0), String(g.mem('FSRATE')[0]));
  }

  // ---- the dead zone: a light push is 24 or 39 on the machine's axis, and neither moves the cursor ----
  {
    const g = loop();
    const seen = [];
    for (const v of [24, 32, 39, 36, 40, 23]) {
      g.m.joy[0][0] = v;
      g.s.runFrames(3);
      seen.push(`${v}:${cursor(g)}`);
    }
    check('Minesweeper stick: 24 to 39 (the page\'s dead zone) does not move the cursor; 40 and 23 do',
      seen[0] === '24:3,3' && seen[1] === '32:3,3' && seen[2] === '39:3,3' && seen[3] === '36:3,3' && seen[4] === '40:4,3' && seen[5] === '23:3,3', seen.join(' '));
  }

  // ---- centring the stick ends the press: pushing the SAME way again steps at once and then repeats at
  // 300 ms, exactly as the first push did. (The bug: GLCENTRE cleared the repeat wait but not the direction
  // remembered, so a re-push was "the same direction", spent 0 fields as a wait - DEC 0 is $FF - and then
  // took 256 fields to move.) The cursor starts at (3,3) and two steps fit before the field's edge, which
  // is all the 300 ms repeat needs; no key is pressed between the two pushes, because a key clears JOYPRE
  // and would hide the bug. ----
  for (const [machine, hz, firstRepeat] of [['dragon64', 50, 15], ['coco', 60, 18]]) {
    const g = loop(machine);
    const stepsOf = (fields) => {
      const at = [];
      let last = g.mem('CURX')[0];
      for (let f = 1; f <= fields; f++) { g.s.runFrames(1); const v = g.mem('CURX')[0]; if (v !== last) { at.push(f); last = v; } }
      return at;
    };
    g.m.joy[0][0] = RIGHT;
    const first = stepsOf(firstRepeat + 3);
    // back to the centre with nothing else touched: a key would clear JOYPRE, and moving the stick the
    // other way would make the next push a NEW direction, either of which would hide the bug
    g.m.joy[0][0] = MID;
    g.s.runFrames(3);
    const from = g.mem('CURX')[0];
    g.m.joy[0][0] = RIGHT;
    const again = stepsOf(firstRepeat + 3);
    const gaps = again.slice(1).map((v, i) => v - again[i]);
    check(`Minesweeper stick (${hz} Hz): the same direction pushed again after the centre steps at once, then at ${firstRepeat}`,
      first.length === 2 && first[0] === 1 && first[1] === 1 + firstRepeat && from === 5 &&
        again.length === 2 && again[0] === 1 && gaps[0] === firstRepeat,
      `first push from x=3 at ${first.join(',')}; re-push from x=${from} at ${again.join(',')} (gap ${gaps.join(',')})`);
  }

  // ---- a restart press longer than the hold time must not leak into the new game. Fire restarts on its
  // RELEASE, and the field it comes up on is the only one that acts: a 25-field press after a loss starts a
  // new game and then does nothing, rather than restarting it and opening the centre square. ----
  {
    const lose = (machine) => {
      const g = loop(machine);
      g.press('space');
      const f = g.mem('FIELD', 64), mine = f.findIndex((v) => v & 0x80);
      const [x, y] = g.mem('CURX', 2), keys = [];
      for (let k = x; k < (mine & 7); k++) keys.push('right'); for (let k = x; k > (mine & 7); k--) keys.push('left');
      for (let k = y; k < (mine >> 3); k++) keys.push('down'); for (let k = y; k > (mine >> 3); k--) keys.push('up');
      g.press(...keys, 'space');
      return g;
    };
    for (const [machine, hz] of [['dragon64', 50], ['coco', 60]]) {
      const g = lose(machine);
      const lost = g.mem('LOST')[0];
      g.m.fire[0] = true;
      g.s.runFrames(Math.round(hz / 2));                 // half a second, well past the 400 ms hold
      g.m.fire[0] = false;
      g.s.runFrames(6);
      check(`Minesweeper fire (${hz} Hz): a half-second press after a loss restarts, and its release does not open a square`,
        lost === 1 && g.mem('LOST')[0] === 0 && g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0 && g.mem('STATE', 64)[27] === 0 && g.mem('FLAGS')[0] === 0,
        `lost was ${lost}, then LOST ${g.mem('LOST')[0]} OPENED ${g.mem('OPENED')[0]} PLANTED ${g.mem('PLANTED')[0]} STATE27 ${g.mem('STATE', 64)[27]}`);
    }
    // ... and after a WIN the same: open every safe square, then a long press restarts without opening
    {
      const g = loop('dragon64');
      g.press('space');
      const field = g.mem('FIELD', 64);
      const goTo = (i) => {
        const [x, y] = g.mem('CURX', 2), keys = [];
        for (let k = x; k < (i & 7); k++) keys.push('right'); for (let k = x; k > (i & 7); k--) keys.push('left');
        for (let k = y; k < (i >> 3); k++) keys.push('down'); for (let k = y; k > (i >> 3); k--) keys.push('up');
        g.press(...keys);
      };
      for (let i = 0; i < 64; i++) if (!(field[i] & 0x80)) { goTo(i); g.press('space'); }
      const won = g.mem('WON')[0];
      g.m.fire[0] = true;
      g.s.runFrames(25);
      g.m.fire[0] = false;
      g.s.runFrames(6);
      check('Minesweeper fire: after a win, a half-second press restarts too, and its release does not open a square',
        won === 1 && g.mem('WON')[0] === 0 && g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0 && g.mem('STATE', 64)[27] === 0,
        `won was ${won}, then WON ${g.mem('WON')[0]} OPENED ${g.mem('OPENED')[0]} PLANTED ${g.mem('PLANTED')[0]} STATE27 ${g.mem('STATE', 64)[27]}`);
    }
  }

  // ---- both axes deflected at once is a tie (two comparator tests cannot say which is further out): the
  // axis that moved last wins, and with nothing moved yet, the x axis - so the first diagonal goes across.
  // "Last" is since the stick left the centre: centring it is a new press, so a diagonal after that starts
  // from x again, and the same goes after a key move (the key is not the stick). ----
  {
    const g = loop();
    const diag = () => { g.m.joy[0][0] = RIGHT; g.m.joy[0][1] = DOWN; g.s.runFrames(3); g.m.joy[0][0] = MID; g.m.joy[0][1] = MID; g.s.runFrames(1); };
    diag();
    const first = cursor(g);                             // nothing moved yet: x
    g.press('up');                                       // a key: y moved last
    const afterUp = cursor(g);
    diag();
    const fromKey = cursor(g);                           // the key's y, not the stick's
    // a key sets its own axis the right way round: y for the arrows up and down, x for left and right.
    // (MOVE and TONE both return normally - MOVE's JMP TONE is a tail call only in that TONE returns to
    // MOVE's caller - so JOYLAST is written in the same pass as the move; one frame later is enough.)
    g.m.stubKeys.push(94); g.s.runFrames(3); const yLast = g.mem('JOYLAST')[0];   // UP
    g.m.stubKeys.push(9); g.s.runFrames(3); const xLast = g.mem('JOYLAST')[0];    // RIGHT
    g.s.runFrames(2);
    check('Minesweeper stick: with both axes deflected the axis that moved last wins (x before anything has)',
      first === '4,3' && afterUp === '4,2' && fromKey === '4,3' && yLast === 1 && xLast === 0,
      `${first} / ${afterUp} -> ${fromKey}; up said ${yLast}, right said ${xLast}`);
  }

  // ---- both sticks move it, and both fire buttons act ----
  {
    const g = loop();
    g.m.joy[1][0] = LEFT;                                // the LEFT joystick, pushed left
    g.s.runFrames(3);
    check('Minesweeper stick: the left joystick moves the cursor too', cursor(g) === '2,3', cursor(g));
    const g2 = loop();
    g2.m.fire[1] = true; g2.s.runFrames(1); g2.m.fire[1] = false; g2.s.runFrames(3);
    check('Minesweeper fire: the second button opens on a tap as the first does', g2.mem('STATE', 64)[27] === 1, JSON.stringify(g2.mem('STATE', 64)[27]));
  }

  // ---- one button: the exact 400 ms boundary. RAWL counts a press's own first field, so a press held
  // for exactly FW400 fields (20 at 50 Hz, 24 at 60) FLAGS on its last field, and one field less opens on
  // the release. The old code started the count at 0 on the first field, so 20 opened and 21 flagged.
  // Fields are counted the way the game counts them - by the ENTROPY byte RAWL moves once a field, not by
  // frames (a frame holds one field but is not aligned with it), the same measure the settle() helper uses. ----
  for (const [machine, hz, fw400] of [['dragon64', 50, 20], ['coco', 60, 24]]) {
    // per FIELD (the ENTROPY byte RAWL moves once a field, not a frame: a frame holds one field but is
    // not aligned with it), the action the field decided (IN: 'F' is the flag) and the square's state.
    // The boundary is measured on IN, the action the field itself decided. Measured on the merged build: the
    // flag's PIXELS are drawn in that same field (the square's glyph bytes change while STATE is still 0), and
    // the STATE variable follows one field later; so the screen shows the flag when the press is decided, and
    // only the bookkeeping trails.
    const press = (n) => {
      const g = loop(machine);
      const ent = () => g.mem('ENTROPY', 2)[0] * 256 + g.mem('ENTROPY', 2)[1];
      let last = ent();
      g.m.fire[0] = true;
      const acts = [];
      for (let f = 1; f <= n; f++) {
        for (let frame = 0; frame < 20; frame++) { g.s.runFrames(1); const e = ent(); if (e !== last) { last = e; break; } }
        acts.push(g.mem('IN')[0]);
      }
      g.m.fire[0] = false;
      g.s.runFrames(3);
      return { g, flagField: acts.indexOf(70) + 1 };
    };
    const short = press(fw400 - 1);
    check(`Minesweeper fire (${hz} Hz): a press of ${fw400 - 1} fields (400 ms less one) never flags, and opens on the release`,
      short.flagField === 0 && short.g.mem('STATE', 64)[27] === 1 && short.g.mem('FLAGS')[0] === 0 && short.g.mem('OPENED')[0] > 0,
      `flagged on field ${short.flagField || 'never'}, then STATE27 ${short.g.mem('STATE', 64)[27]} FLAGS ${short.g.mem('FLAGS')[0]} OPENED ${short.g.mem('OPENED')[0]}`);
    const exact = press(fw400);
    check(`Minesweeper fire (${hz} Hz): a press of exactly ${fw400} fields (400 ms) FLAGS on its ${fw400}th field, and its release opens nothing`,
      exact.flagField === fw400 && exact.g.mem('STATE', 64)[27] === 2 && exact.g.mem('FLAGS')[0] === 1 && exact.g.mem('OPENED')[0] === 0,
      `flagged on field ${exact.flagField || 'never'} (want ${fw400}), then STATE27 ${exact.g.mem('STATE', 64)[27]} FLAGS ${exact.g.mem('FLAGS')[0]} OPENED ${exact.g.mem('OPENED')[0]}`);
    // a tap well under the hold time still opens, on the release
    const tap = loop(machine);
    tap.m.fire[0] = true;
    tap.s.runFrames(Math.floor(fw400 / 2));
    const midTap = tap.mem('STATE', 64)[27];
    tap.m.fire[0] = false;
    tap.s.runFrames(3);
    check(`Minesweeper fire (${hz} Hz): a tap under 400 ms opens the square, on the release`, midTap === 0 && tap.mem('STATE', 64)[27] === 1 && tap.mem('FLAGS')[0] === 0,
      `mid-tap ${midTap}, after the release ${tap.mem('STATE', 64)[27]} flags ${tap.mem('FLAGS')[0]}`);
  }

  // ---- after a win or a loss, fire starts again (as R does), on its RELEASE ----
  {
    const g = loop();
    g.press('space');                                   // open (3,3): the mines are laid
    const f2 = g.mem('FIELD', 64);
    const mine = f2.findIndex((v) => v & 0x80);
    const [x, y] = g.mem('CURX', 2);
    const keys = [];
    for (let k = x; k < (mine & 7); k++) keys.push('right'); for (let k = x; k > (mine & 7); k--) keys.push('left');
    for (let k = y; k < (mine >> 3); k++) keys.push('down'); for (let k = y; k > (mine >> 3); k--) keys.push('up');
    g.press(...keys, 'space');
    const lost = g.mem('LOST')[0] === 1;
    const opened = g.mem('OPENED')[0];
    g.m.fire[0] = true; g.s.runFrames(1); g.m.fire[0] = false; g.s.runFrames(4);
    check('Minesweeper fire: after a loss, fire starts a new game (as R does)',
      lost && g.mem('LOST')[0] === 0 && g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0, `lost was ${lost}, opened was ${opened}`);
  }

  // ---- a loss BY FIRE stays lost: the tap that opens a mine loses on its release, and the over screen must stay
  // up while the button is idle. (The release also marks "fire came up this field", which is what restarts a
  // finished game: if that mark is not cleared at the start of each field, the very next field restarts and the
  // loss is never seen. Only the sound hash noticed that before, by the timing of the cues.) ----
  for (const [machine, hz] of [['dragon64', 50], ['coco', 60]]) {
    const g = loop(machine);
    g.press('space');                                   // open (3,3) and lay the mines
    const f = g.mem('FIELD', 64), mine = f.findIndex((v) => v & 0x80);
    const [x, y] = g.mem('CURX', 2), keys = [];
    for (let k = x; k < (mine & 7); k++) keys.push('right'); for (let k = x; k > (mine & 7); k--) keys.push('left');
    for (let k = y; k < (mine >> 3); k++) keys.push('down'); for (let k = y; k > (mine >> 3); k--) keys.push('up');
    g.press(...keys);
    // a tap: down a few fields, up (under 400 ms, so it opens rather than flags)
    g.m.fire[0] = true;
    g.s.runFrames(3);
    g.m.fire[0] = false;
    g.s.runFrames(4);
    const lostByFire = g.mem('LOST')[0];
    // idle for several fields with the button up: nothing may restart it
    g.s.runFrames(hz);
    check(`Minesweeper fire (${hz} Hz): a tap that opens a mine loses, and the loss stays up while fire is idle`,
      lostByFire === 1 && g.mem('LOST')[0] === 1 && g.mem('OPENED')[0] > 0 && g.mem('PLANTED')[0] === 10,
      `lost by the tap ${lostByFire}, a second later LOST ${g.mem('LOST')[0]} OPENED ${g.mem('OPENED')[0]} PLANTED ${g.mem('PLANTED')[0]}`);
  }

  // ---- the phantom table itself: BOTH machines' row 0 and 1, because which matrix the ROM scans cannot
  // be told from the game. This is a TABLE check, not a behaviour one, and it has to be: no key in a
  // Dragon's rows is a key the game acts on ('0'-'/' with fire up do nothing here), so no Dragon phantom
  // can be shown to matter - only that the table holds those rows if one ever does. The CoCo half IS
  // behaviour-tested above, where 'F' flags with fire up. ----
  {
    // the committed image, at its own addresses (the .bin is a file, its bytes are not addresses)
    const img = new Uint8Array(0x10000);
    for (const seg of A.minesweeper.segments) img.set(seg.data, seg.addr);
    const at = (k) => A.minesweeper.symbols.get(k);
    const table = [];
    for (let i = at('PHANTOM'); img[i] !== 0; i++) table.push(img[i]);
    const dragon = [], coco = [];
    for (let c = 48; c <= 57; c++) dragon.push(c);
    for (const c of [58, 59, 44, 45, 46, 47]) dragon.push(c);              // : ; , - . /
    coco.push(64); for (let c = 65; c <= 79; c++) coco.push(c);            // @ A-G, H-O
    const want = [...new Set([...dragon, ...coco])].sort((a, b) => a - b);
    const got = [...table].sort((a, b) => a - b);
    check('Minesweeper: PHANTOM holds both machines\' matrix rows 0 and 1 (the union), so a ROM of either family is covered',
      got.join() === want.join() && table.length === want.length,
      `${table.length} entries: ${table.map((c) => String.fromCharCode(c)).join('')}`);
    // and none of the game's own keys is in it except F, which a held fire makes moot
    const gameKeys = ['R', ' '].map((c) => c.charCodeAt(0));
    check('Minesweeper: the phantom table leaves the game\'s keys alone (only F is in it, and a held fire flags anyway)',
      !gameKeys.some((k) => table.includes(k)) && table.includes(70),
      table.includes(70) ? 'F is in the table' : 'F is NOT in the table');
  }

  // ---- fire never reads as a key: the ROM can hand back a phantom from matrix row 0 or 1 while fire is
  // down, and those are ignored then (and only then). Which machine's rows those are cannot be known from
  // the game, so BOTH families' rows are dropped on every machine. The phantom is injected through the
  // stub's queue, because the no-ROM stub hands out queued keys rather than scanning the matrix, so what
  // is tested is the game's own filter, which is what a real POLCAT's phantom would meet.
  // Only the keys that MEAN something with fire up can prove the filter: 'F' is in a CoCo row 0, and 0,
  // 8 and @ are not game keys at all (dropping them changes nothing), so those cases would pass with the
  // filter deleted. Each case here is a key the game acts on with fire up, on every family. ----
  {
    for (const [machine, key, ch, rows] of [
      ['dragon64', 70, 'F', 'CoCo row 0 @ A-G - but also a Dragon matrix key: solid on a Dragon'],
      ['coco', 70, 'F', 'CoCo row 0'],
      ['coco3p', 70, 'F', 'CoCo row 0 (the CoCo 3 PAL scans the CoCo matrix)'],
      ['tanodr64', 70, 'F', 'CoCo row 0 (the Tano scans the CoCo matrix: NOT the Dragon table)'],
    ]) {
      // the key DOES act with fire up: the control that makes the case non-vacuous
      const ctl = loop(machine);
      ctl.m.stubKeys.push(key);
      ctl.s.runFrames(3);
      const acts = ctl.mem('STATE', 64)[27] === 2 && ctl.mem('FLAGS')[0] === 1;
      const g = loop(machine);
      g.m.fire[0] = true;
      g.s.runFrames(2);                                 // fire is down and counted
      const was = g.mem('STATE', 64)[27], fl = g.mem('FLAGS')[0], cur = cursor(g);
      g.m.stubKeys.push(key);
      g.s.runFrames(3);
      check(`Minesweeper fire + a phantom '${ch}' (${rows}): ignored while fire is down, and a real key otherwise`,
        acts && g.mem('STATE', 64)[27] === was && g.mem('FLAGS')[0] === fl && cursor(g) === cur && g.mem('OPENED')[0] === 0,
        `with fire up it flags: ${acts}; with fire down ${was}/${fl}/${cur} -> ${g.mem('STATE', 64)[27]}/${g.mem('FLAGS')[0]}/${cursor(g)}`);
      g.m.fire[0] = false;
      g.s.runFrames(3);
    }
    // keys keep working with fire down: an arrow still moves, and SPACE still opens
    const a = loop('coco');
    a.m.fire[0] = true; a.s.runFrames(2);
    a.m.stubKeys.push(8);                               // LEFT
    a.s.runFrames(3);
    check('Minesweeper fire: with fire down the arrows still move the cursor', cursor(a) === '2,3', cursor(a));
  }

  // ---- the keys the game already had keep working, with the stick still ----
  {
    const g = loop();
    g.press('right', 'right', 'down');
    const moved = cursor(g);
    // (F acts on the square under the cursor, (5,4) here, not on (3,3): read the square it flagged)
    const at = g.mem('CURY')[0] * 8 + g.mem('CURX')[0];
    g.press('F');
    const flagged = g.mem('STATE', 64)[at] === 2 && g.mem('FLAGS')[0] === 1;
    g.press('F');
    const unflagged = g.mem('STATE', 64)[at] === 0 && g.mem('FLAGS')[0] === 0;
    g.press('space');
    const opened = g.mem('OPENED')[0] > 0;
    g.press('R');
    check('Minesweeper keys: the arrows, F, SPACE and R still work (the stick is centred)',
      moved === '5,4' && flagged && unflagged && opened && g.mem('OPENED')[0] === 0 && cursor(g) === '3,3',
      `moved ${moved}, flagged ${flagged}, unflagged ${unflagged}, opened ${opened}`);
  }

  // ---- and the buzz the spec is about: with the joystick read every field, a 2 s recording of an idle
  // stick has no line at the field rate (nor at the other rate) above the noise floor ----
  {
    const RATE = 44100;
    const lineHz = (x, hz) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const t = 2 * Math.PI * hz * i / RATE; re += x[i] * Math.cos(t); im += x[i] * Math.sin(t); } return 2 * Math.hypot(re, im) / x.length; };
    const record = (machine, fps) => {
      const s = new Emu.Session({ welcomeMenu: false });
      s.switchMachine(machine, {}, { menu: false });
      s.load('minesweeper.bin', bin('minesweeper'), { remember: false });
      const m = s.personMachine;
      s.runFrames(30); m.poke(Emu.GAMES.seed, 0x5E); m.poke(Emu.GAMES.seed + 1, 0xED);
      m.stubKeys.push(32); s.runFrames(60);             // in the game, the stick idle
      const chunks = [];
      const out = new Emu.AudioOutput(RATE, { buffered: () => 0, write: (c) => chunks.push(c) }, { highPass: false });
      for (let f = 0; f < 2 * fps; f++) { m.runFrame(); out.push(m.audioEvents, m.frameCycles, fps); }
      const n = chunks.reduce((a, c) => a + c.length, 0), x = new Float32Array(n);
      let at = 0; for (const c of chunks) { x.set(c, at); at += c.length; }
      return x;
    };
    for (const [machine, fps] of [['dragon64', 50], ['coco', 60]]) {
      const x = record(machine, fps);
      const a50 = lineHz(x, 50), a60 = lineHz(x, 60);
      check(`Minesweeper sound (${fps} Hz machine): 2 s of an idle stick has no 50 or 60 Hz line (the joystick read does not buzz)`,
        a50 < 1e-3 && a60 < 1e-3, `50 Hz ${a50.toExponential(2)}, 60 Hz ${a60.toExponential(2)}`);
    }
  }
}

console.log(fail ? `${fail} of ${n} game checks FAILED` : `all ${n} game checks passed`);
process.exitCode = fail ? 1 : 0;
