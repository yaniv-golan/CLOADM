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
const fs = require('fs'), path = require('path');
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
  // everything, its variables included, below $4000 (the stack grows down from $3000; the screen is $0400-$1BFF)
  const top = Math.max(...[...a.symbols.values()].filter((v) => v >= 0x3000 && v < 0x8000));
  check(`${name}: program and variables between $3000 and $4000`, a.segments.every((s) => s.addr >= 0x3000) && top < 0x4000, `top $${top.toString(16)}`);
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
// the text on pixel row y of the bitmap, 4-pixel cells, glyph rows `tall` apart, in colour `fg`
const textAt = (m, y, tall = 1, fg = 3, from = 0, to = 32) => {
  let s = '';
  for (let c = from; c < to; c++) {
    const g = [];
    for (let k = 0; k < 5; k++) {
      const v = m.ram[0x400 + (y + k * tall) * 32 + c];
      let bits = 0;
      for (let p = 0; p < 3; p++) if (((v >> (6 - 2 * p)) & 3) === fg) bits |= 4 >> p;
      g.push(bits);
    }
    s += FONT.get(g.join(',')) || '?';
  }
  return s.trim();
};

// ---- the random numbers, as games.inc documents them ----
class Rng {
  constructor(seed) { this.r = seed; }
  byte() { for (let i = 0; i < 8; i++) { const c = this.r & 1; this.r >>= 1; if (c) this.r ^= 0xB400; } return this.r & 0xFF; }
  below(n) { let mask = 1; while (mask < n) mask = mask * 2 + 1; for (;;) { const a = this.byte() & mask; if (a < n) return a; } }
}

// ---- running a game in a Session ----
const KEY = { up: 94, down: 10, left: 8, right: 9, space: 32, enter: 13, break: 3 };
function start(name, { machine = 'dragon64', seed = 0x1234 } = {}) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(machine, {}, { menu: false });
  s.load(`${name}.bin`, bin(name), { remember: false });
  const m = s.machine, sym = (k) => A[name].symbols.get(k);
  s.runFrames(30);   // the title page drawn
  m.poke(Emu.GAMES.seed, seed >> 8); m.poke(Emu.GAMES.seed + 1, seed & 0xFF);
  // a key, then frames until the game waits for the next (ENTROPY counts its polls)
  const settle = () => {
    for (let i = 0; i < 400; i++) {
      const e0 = m.ram[sym('ENTROPY')] * 256 + m.ram[sym('ENTROPY') + 1];
      s.runFrames(1);
      const e1 = m.ram[sym('ENTROPY')] * 256 + m.ram[sym('ENTROPY') + 1];
      if (!m.stubKeys.length && ((e1 - e0) & 0xFFFF) > 200) return;
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
  const g = start('2048', { seed: 0xBEEF });
  check('2048: the title page', textAt(g.m, 108, 2, 2) === 'JOIN THE TILES TO MAKE 2048' && textAt(g.m, 172, 1, 3) === 'PRESS A KEY TO PLAY',
    JSON.stringify([textAt(g.m, 108, 2, 2), textAt(g.m, 172, 1, 3)]));
  check('2048: the four-colour 128x192 mode at $0400 (VDG CG6, SAM V=6, F=2)', (g.m.pia1.saveState().b.or & 0xF8) === 0xE0 && (g.m.sam.reg & 0x3FF) === (6 | (2 << 3)));
  g.press('space');
  const rng = new Rng(0xBEEF);
  let model = new Array(16).fill(0), score = 0;
  spawn(model, rng); spawn(model, rng);
  check('2048: a new game has the two tiles the seed gives', show(g.mem('BOARD', 16)) === show(model), `${show(g.mem('BOARD', 16))} / ${show(model)}`);
  check('2048: the game screen (keys on the footer)', textAt(g.m, 185, 1, 2) === 'ARROWS MOVE  R NEW  BREAK LEAVES', textAt(g.m, 185, 1, 2));
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
  const shown = [textAt(g.m, 7, 2, 3, 14, 20), textAt(g.m, 7, 2, 3, 22, 28)], labels = textAt(g.m, 1, 1, 2, 12);
  check('2048: the score and the best score are shown', shown[0] === String(score) && shown[1] === String(score) && labels === 'SCORE   BEST', JSON.stringify([shown, labels]));
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
  check('2048: joining two 1024s makes 2048 and says so', g.mem('BOARD')[0] === 11 && g.mem('WONSEEN')[0] === 1 && textAt(g.m, 185) === 'YOU MADE 2048! PLAY ON', textAt(g.m, 185));
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
  check('2048: no move left: game over', g.mem('LOST')[0] === 1 && textAt(g.m, 185) === 'NO MOVES LEFT. R PLAYS AGAIN', textAt(g.m, 185));
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

// the same game on the other 6809 families
for (const machine of ['dragon32', 'coco', 'coco3', 'dragon64:6309']) {
  const [id, cpu] = machine.split(':');
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(id, cpu ? { cpu } : {}, { menu: false });
  s.load('2048.bin', bin('2048'), { remember: false });
  s.runFrames(30); s.machine.poke(Emu.GAMES.seed, 0xBE); s.machine.poke(Emu.GAMES.seed + 1, 0xEF);
  s.machine.stubKeys.push(32); s.runFrames(20);
  s.machine.stubKeys.push(8); s.runFrames(20);
  const rng = new Rng(0xBEEF), model = new Array(16).fill(0);
  spawn(model, rng); spawn(model, rng);
  const r = move(model, 'left'); if (r.changed) spawn(r.board, rng);
  const got = Array.from(s.machine.ram.slice(A['2048'].symbols.get('BOARD'), A['2048'].symbols.get('BOARD') + 16));
  check(`2048 on the ${s.machine.profile.name}${cpu ? ` (${cpu})` : ''}: the same game`, show(got) === show(r.changed ? r.board : model), show(got));
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
  const g = start('minesweeper', { seed: 0x5EED });
  check('Minesweeper: the title page', textAt(g.m, 96, 2, 3) === 'TEN MINES ARE HIDDEN' && textAt(g.m, 174, 1, 2) === 'PRESS A KEY TO PLAY',
    JSON.stringify([textAt(g.m, 96, 2, 3), textAt(g.m, 174, 1, 2)]));
  check('Minesweeper: the second colour set (CSS)', (g.m.pia1.saveState().b.or & 0xF8) === 0xE8);
  // the stack: a pattern under it, to see how deep it goes over a whole game
  // (below where S is now: the game waits in GETKEY, its return addresses above S)
  const s0 = g.m.cpu.s;
  for (let a = 0x1C00; a < s0; a++) g.m.poke(a, 0x5A);
  g.press('space');
  check('Minesweeper: the game screen', textAt(g.m, 16) === 'SPACE OPENS  F FLAGS' && textAt(g.m, 2, 2, 3) === '10', JSON.stringify([textAt(g.m, 16), textAt(g.m, 2, 2, 3)]));
  // the cursor stays on the field
  g.press('up', 'up', 'up', 'up', 'left', 'left', 'left', 'left');
  check('Minesweeper: the cursor stops at the corner', g.mem('CURX', 2).join() === '0,0');
  g.press('right', 'right', 'right', 'down', 'down', 'down');
  check('Minesweeper: and moves back to the middle', g.mem('CURX', 2).join() === '3,3');
  // a flag before the first square: on and off
  g.press('F');
  check('Minesweeper: F flags a hidden square; the counter says 9', g.mem('STATE', 64)[27] === 2 && g.mem('FLAGS')[0] === 1 && textAt(g.m, 2, 2, 3) === '09');
  g.press('space');
  check('Minesweeper: a flagged square does not open', g.mem('STATE', 64)[27] === 2 && g.mem('OPENED')[0] === 0 && g.mem('PLANTED')[0] === 0);
  g.press('F');
  check('Minesweeper: F again takes the flag off', g.mem('STATE', 64)[27] === 0 && g.mem('FLAGS')[0] === 0 && textAt(g.m, 2, 2, 3) === '10');
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
  check('Minesweeper: ten flags on the ten mines; the counter says 00', g.mem('FLAGS')[0] === 10 && textAt(g.m, 2, 2, 3) === '00');
  const extra = g.mem('STATE', 64).findIndex((v) => v === 0);
  goTo(extra); g.press('F');
  check('Minesweeper: an eleventh flag is refused', g.mem('STATE', 64)[extra] === 0 && g.mem('FLAGS')[0] === 10);
  for (let i = 0; i < 64; i++) if (!(field[i] & 0x80) && g.mem('STATE', 64)[i] === 0) { goTo(i); g.press('space'); }
  check('Minesweeper: opening the 54 safe squares wins', g.mem('WON')[0] === 1 && g.mem('OPENED')[0] === 54 && g.mem('LOST')[0] === 0
    && textAt(g.m, 16) === 'ALL CLEAR! R PLAYS AGAIN', textAt(g.m, 16));
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
  check('Minesweeper: opening a mine loses: BOOM', g.mem('LOST')[0] === 1 && g.mem('BOOMSQ')[0] === boom && textAt(g.m, 16) === 'BOOM! R PLAYS AGAIN', textAt(g.m, 16));
  // the mines show: the one that went off on orange, the others on buff; the field's pixels say which
  const sq = (i) => 0x400 + (24 + 20 * (i >> 3) + 9) * 32 + 4 + 3 * (i & 7);   // a row through the sprite's middle
  const other = f2.findIndex((v, i) => (v & 0x80) && i !== boom);
  const px = (a) => [0, 1, 2].flatMap((k) => [6, 4, 2, 0].map((sh) => (g.m.ram[a + k] >> sh) & 3)).slice(0, 11);   // the square's 11 pixels
  check('Minesweeper: the mine that went off is on orange, another mine shows magenta on buff', px(sq(boom)).includes(3) && px(sq(other)).includes(2)
    && px(sq(other)).includes(0) && !px(sq(other)).includes(3), JSON.stringify([px(sq(boom)), px(sq(other))]));
  g.press('break');
  check('Minesweeper: BREAK leaves: text mode, stopped at DONE', g.m.cpu.pc === Emu.GAMES.done && (g.m.pia1.saveState().b.or & 0x80) === 0);
}

// sounds: the flag's two notes (delay 60 for 24 half periods, then 40 for 36): a half period is 5*D+22 cycles
{
  const g = start('minesweeper', { seed: 7 });
  g.press('space');
  const m = g.m, edges = [];
  m.stubKeys.push(70);   // F
  for (let i = 0; i < 20; i++) { const base = m.frameBase; m.runFrame(); for (let k = 2; k < m.audioEvents.length; k += 2) edges.push([base + m.audioEvents[k], m.audioEvents[k + 1]]); }
  const halves = [];
  for (let i = 1; i < edges.length; i++) if (Math.abs(edges[i][1] - edges[i - 1][1]) > 0.8) halves.push(edges[i][0] - edges[i - 1][0]);
  const near = (h, d) => Math.abs(h - (5 * d + 22)) <= 3;
  const a = halves.filter((h) => near(h, 60)).length, b = halves.filter((h) => near(h, 40)).length;
  check('Minesweeper: F plays the flag notes (about 23 then 35 half periods at 5*60+22 and 5*40+22 cycles)', a >= 22 && a <= 24 && b >= 34 && b <= 36, `${a} ${b} of ${halves.length}`);
}

// the Session: runGame, the last run, the menu after BREAK, the carry-on line, and no games on a 6803
{
  const st = new Map(), store = { get: (k) => (st.has(k) ? st.get(k) : null), set: (k, v) => st.set(k, String(v)), remove: (k) => st.delete(k), keys: () => [...st.keys()] };
  const s = new Emu.Session({ store });
  s.switchMachine('dragon64');
  const events = [];
  s.on((e) => events.push(e));
  s.runGame('minesweeper', bin('minesweeper'));
  check('Session.runGame remembers the game as the last run', JSON.stringify(s.lastRun) === '{"kind":"game","name":"Minesweeper"}' && s.carryOn && s.carryOn.name === 'Minesweeper');
  s.runFrames(5); s.machine.stubKeys.push(32); s.runFrames(20); s.machine.stubKeys.push(3); s.runFrames(20);
  check('BREAK in a game: the Session emits menu', events.includes('menu'), events.filter((e) => !/^(frame|status)/.test(e)).join());
  s.startWelcome(bin('welcome'), { greeting: 'back', carryOn: s.carryOn.name });
  s.runFrames(50);
  check('the welcome menu offers it back as option 6', s.screenText()[13].trim() === '6 CARRY ON WITH MINESWEEPER', s.screenText()[13]);
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
    const before = s.machine.ram[0x3000];
    err = null;
    try { s.runGame('2048', bin('2048')); } catch (e) { err = e; }
    check(`the games are refused on a ${ram}K CoCo, saying why, with nothing loaded`, err instanceof Emu.SessionError
      && err.message === `2048 needs 32K RAM or more; this CoCo 1/2 has ${ram}K. Switch the RAM option to 32K or 64K to play it.`
      && JSON.stringify(s.gameNeeds()) === JSON.stringify({ ram: 32, have: ram }) && s.machine.ram[0x3000] === before, err && err.message);
  }
  s.switchMachine('coco', { ram: 32 });
  check('a 32K CoCo has what the games need', s.gameNeeds() === null);
}

// BREAK on the title page leaves too; the game puts the SAM's memory size back as it found it (SAMEXIT, set by the
// Session from the machine: 4K on the built-in firmware, M=0), after running with M=10
for (const name of ['2048', 'minesweeper']) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  const m = s.machine;
  const m0 = m.sam.memSize;
  s.runGame(name, bin(name));
  s.runFrames(30);
  const during = m.sam.memSize, samExit = m.ram[Emu.GAMES.samExit];
  m.stubKeys.push(3); s.runFrames(10);
  check(`${name}: BREAK on the title page leaves (text mode, DONE); the SAM's M is back to ${m0} after ${during} while it ran`, m.cpu.pc === Emu.GAMES.done
    && (m.pia1.saveState().b.or & 0x80) === 0 && m.sam.memSize === m0 && during === 2 && samExit === m0 && A[name].symbols.get('SAMEXIT') === Emu.GAMES.samExit);
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
  const m = s.machine;
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
// for pixel, and Minesweeper's sounds match tests/fixtures/games/minesweeper-sounds.wav byte for byte (made by this
// run with --wav). What the recording holds is checked from the samples: the first square's click, two cursor ticks,
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
  check('Minesweeper: its sounds match tests/fixtures/games/minesweeper-sounds.wav byte for byte (--wav)', wav.equals(fs.readFileSync(fix('minesweeper-sounds.wav'))), `${wav.length} bytes`);
  const samples = [];
  for (let i = 44; i + 1 < wav.length; i += 2) samples.push(wav.readInt16LE(i));
  const bursts = [];
  let cur = null;
  samples.forEach((v, i) => { if (v !== 32 * 320) { if (cur && i - cur[1] <= 200) cur[1] = i; else { cur = [i, i]; bursts.push(cur); } } });
  const len = (b) => b[1] - b[0], full = (b) => { const x = samples.slice(b[0], b[1] + 1); return Math.max(...x) === 63 * 320 && Math.min(...x) <= 320; };
  const what = bursts.map((b) => `${(b[0] / 44100).toFixed(2)}+${(len(b) / 44100).toFixed(3)}`).join(' ');
  check('Minesweeper: the recording is click, 2 ticks, buzz, 3 ticks, chirp, chirp, and the explosion in two parts, every burst at full swing',
    bursts.length === 11 && bursts.every(full) && samples.every((v) => v >= 0 && v <= 63 * 320)
    && [1, 2, 4, 5, 6].every((i) => len(bursts[i]) < len(bursts[0])) && len(bursts[3]) > len(bursts[1])
    && len(bursts[9]) > 4 * len(bursts[7]) && len(bursts[10]) > len(bursts[9]), what);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `${fail} of ${n} game checks FAILED` : `all ${n} game checks passed`);
process.exitCode = fail ? 1 : 0;
