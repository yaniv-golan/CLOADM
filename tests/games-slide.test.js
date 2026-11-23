// The 2048 tile slide: a move's tiles slide to their destinations over a few fields, the merged tiles flash,
// then the new tile pops in. Written BEFORE the animation exists, so these fail on the build that has none.
// Run: node tests/games-slide.test.js
//
// Geometry (examples/2048.asm): TILEX 2, TILEY 24, a column every 7 bytes, a row every 40 rows, a tile 6 bytes
// by 34 rows, the screen at $0400. Fields are the emulator's own video fields: the loop counts the field in
// ENTROPY, so "one field passed" means that byte moved.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const include = (f) => { const p = path.join(__dirname, '../examples', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const A = Emu.assemble(fs.readFileSync(path.join(__dirname, '../examples/2048.asm'), 'utf8'), '6809', { include });
const BIN = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/2048.bin')));
const SYM = (k) => A.symbols.get(k);

const KEY = { up: 94, down: 10, left: 8, right: 9, space: 32 };
const TILEX = 2, TILEY = 24, COLSTEP = 7, ROWSTEP = 40, TILEW = 6, TILEH = 34;
const SCR = 0x400;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// the tile box at (col,row): a signature of its bytes and how many of them are inked
const box = (m, col, row) => {
  const a = SCR + (TILEY + row * ROWSTEP) * 32 + TILEX + col * COLSTEP;
  let sig = 0, ink = 0;
  for (let r = 0; r < TILEH; r++) for (let b = 0; b < TILEW; b++) {
    const v = m.ram[a + r * 32 + b];
    if (v) ink++;
    sig = (sig * 31 + v) & 0x7FFFFFFF;
  }
  return { sig, ink };
};
// the ink in a board slot (col, row): how many of the tile's 34x6 bytes are non-zero. A still board keeps a
// slot's count constant; a tile sliding INTO or THROUGH slots changes them over fields, which is the signal.
const slotInk = (m, col, row) => {
  let k = 0;
  for (let r = 0; r < TILEH; r++) for (let b = 0; b < TILEW; b++) if (m.ram[SCR + (TILEY + row * ROWSTEP + r) * 32 + TILEX + col * COLSTEP + b]) k++;
  return k;
};
const rowInk = (m, row) => [0, 1, 2, 3].map((c) => slotInk(m, c, row)).join(' ');
// a slot's 34x6 bytes, row by row (34 rows of 6)
const boxRows = (m, col, row) => {
  const a = SCR + (TILEY + row * ROWSTEP) * 32 + TILEX + col * COLSTEP;
  const out = [];
  for (let r = 0; r < TILEH; r++) out.push([0, 1, 2, 3, 4, 5].map((b) => m.ram[a + r * 32 + b]));
  return out;
};
// the dominant even-row body byte DRAWN in a slot right now (0 when nothing is drawn). A tile mid-flight is
// caught part-painted, so this reads the rows already on screen, not a whole tile.
const boxBody = (m, col, row) => {
  const h = new Map();
  for (const [i, r] of boxRows(m, col, row).entries()) if ((i & 1) === 0 && r[0]) h.set(r[0], (h.get(r[0]) || 0) + 1);
  if (!h.size) return 0;
  return [...h.entries()].sort((a, b) => b[1] - a[1])[0][0];
};
const fieldByte = (m) => m.ram[SYM('ENTROPY')] * 256 + m.ram[SYM('ENTROPY') + 1];
const gameMoves = (m) => m.ram[SYM('MOVES')] * 256 + m.ram[SYM('MOVES') + 1];
const nextField = (s, m) => {
  const e0 = fieldByte(m);
  for (let f = 0; f < 40; f++) { s.runFrames(1); if (fieldByte(m) !== e0) return; }
  throw new Error('no field passed');
};

function startGame(seed = 0x5EED) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  s.load('2048.bin', BIN, { remember: false });
  const m = s.shownMachine;
  s.runFrames(30);
  m.poke(Emu.GAMES.seed, seed >> 8); m.poke(Emu.GAMES.seed + 1, seed & 0xFF);
  m.stubKeys.push(KEY.space);
  for (let f = 0; f < 40; f++) s.runFrames(1);
  return { s, m };
}
// a known board, written straight into BOARD and DRAWN (R redraws nothing, so a move is what paints it: write
// the board, then press a move that changes nothing to get a clean picture is not possible, so write and then
// let the caller's move be the first paint; the checks below read the board AFTER the animation settles)
function setBoard(m, cells) {
  const B = SYM('BOARD');
  for (let i = 0; i < 16; i++) m.poke(B + i, 0);
  for (const [i, v] of cells) m.poke(B + i, v);
}
const settle = (s, m, fields = 40) => { for (let f = 0; f < fields; f++) s.runFrames(1); };

// ---- (a) the tiles SLIDE, in BOTH axes, and every square they cross is drawn. A check on "more than one row
// shape" alone passes a slide that skips its middle column (SPSTEP 1,1,2 -> 1,1,1 still gives 3 shapes: empty,
// moved, arrived). So this asserts the stronger thing: for each of LEFT, RIGHT, UP, DOWN, every square the tile
// passes OVER carries the mover's own body ($55 for a 2) on some frame while the slide runs. A square skipped,
// or drawn as another value, fails.
{
  // A 2's even-row body is $55 (STYLES value 1). Each case lists the squares STRICTLY BETWEEN the start and
  // the destination, which the tile must be drawn on; the start is never repainted (it was empty here) and the
  // destination is where it ends. Sampling stops at the spawn (POP first set): the new tile can also be a 2, and
  // would otherwise satisfy the crossed squares it lands on.
  const body55 = 0x55;
  const cases = [
    { dir: KEY.left, from: 3, cells: [1, 2], name: 'LEFT', at: (m, k) => boxBody(m, k, 0) },
    { dir: KEY.right, from: 0, cells: [1, 2], name: 'RIGHT', at: (m, k) => boxBody(m, k, 0) },
    { dir: KEY.up, from: 15, cells: [7, 11], name: 'UP', at: (m, k) => boxBody(m, 3, k >> 2) },
    { dir: KEY.down, from: 0, cells: [4, 8], name: 'DOWN', at: (m, k) => boxBody(m, 0, k >> 2) },
  ];
  const bad = [];
  for (const c of cases) {
    const { s, m } = startGame();
    setBoard(m, [[c.from, 1]]);                  // one 2 at the far end of its line
    m.stubKeys.push(c.dir);
    const crossed = new Set();
    for (let f = 0; f < 40; f++) {
      s.runFrames(1);
      if (m.ram[SYM('POP')]) break;              // the spawn started: no more slide to see
      for (const k of c.cells) if (c.at(m, k) === body55) crossed.add(k);
    }
    const missing = c.cells.filter((k) => !crossed.has(k));
    if (missing.length) bad.push(`${c.name}: never showed the mover on square(s) ${missing.join(',')}`);
  }
  check('2048 slide: LEFT, RIGHT, UP and DOWN each draw the mover on every square it crosses (the middle ones too)',
    bad.length === 0, bad.join('; ') || 'all four directions crossed every square');
}

// ---- (b) merged tiles flash ----
{
  const { s, m } = startGame();
  setBoard(m, [[0, 1], [1, 1]]);               // 2 2 . . : LEFT joins at (0,0)
  m.stubKeys.push(KEY.left);
  const looks = [];
  for (let f = 0; f < 12; f++) { nextField(s, m); looks.push(box(m, 0, 0).sig); }
  const uniq = [...new Set(looks)];
  check('2048 slide: the merged tile flashes (its look changes more than the final one)',
    uniq.length >= 3, `${uniq.length} distinct looks of the joined tile over 12 fields`);
}

// ---- (c) the new tile pops is checked thoroughly as (g) below (the two sizes from the geometry); the old
// "ink under 300 anywhere" test here was satisfied by any full tile (a full tile inks 204 < 300), so it is gone.

// ---- (d) the game state is the model's, unchanged by how it is drawn ----
{
  const { s, m } = startGame();
  setBoard(m, [[0, 1], [1, 1], [2, 2], [3, 0]]);   // 2 2 4 . -> LEFT: 4 4 . . then a new tile in the empty run
  m.stubKeys.push(KEY.left);
  settle(s, m, 40);
  const B = SYM('BOARD'), got = Array.from(m.ram.slice(B, B + 16));
  // the rule: left packs to 4 4, then ONE new tile appears somewhere in the empty run (indices 2..15)
  const spawned = got.slice(2).filter((v) => v).length;
  check('2048 slide: the animation does not change the board the move made (rule state, then one spawn)',
    got[0] === 2 && got[1] === 2 && spawned === 1, `board ${got.join(',')}`);
}

// ---- (e) a key during the animation finishes it AT ONCE and is applied as the next move. To prove the key
// came WHILE the slide was running (and not before it or after it), the check requires: at least one
// intermediate-slot field seen before the key, and NO intermediate-slot field after it. A build that ignores
// the key and plays the slide out first fails on the second half; one that applies keys only before the slide
// fails on the first. ----
{
  const { s, m } = startGame();
  setBoard(m, [[3, 1]]);                 // one 2 at (3,0): a slide from col 3 to col 0
  const B = SYM('BOARD');
  m.stubKeys.push(KEY.left);
  // step fields until the slide is visibly under way: a row shape that is neither all-empty nor all-arrived
  const shapes = new Set();
  let slideFieldsSeen = 0;
  for (let f = 0; f < 8; f++) {
    nextField(s, m);
    const shape = rowInk(m, 0);
    shapes.add(shape);
    if (shapes.size >= 2) slideFieldsSeen++;      // a second shape is the slide running
    if (shapes.size >= 2) break;
  }
  const beforeKey = slideFieldsSeen;
  // mid-animation: RIGHT must be taken, and must END the animation (no further intermediate shapes)
  m.stubKeys.push(KEY.right);
  nextField(s, m);
  const afterKey = [];
  for (let f = 0; f < 10; f++) { nextField(s, m); afterKey.push(rowInk(m, 0)); }
  settle(s, m, 20);
  const got = Array.from(m.ram.slice(B, B + 16));
  const rightmost = got.reduce((at, v, i) => (v ? i : at), -1);
  const stillSliding = [...new Set(afterKey)].length > 2;   // an ended animation settles to one shape
  check('2048 slide: a key DURING the animation ends it at once and is applied as the next move',
    beforeKey > 0 && !stillSliding && rightmost >= 3,
    `intermediate fields before the key ${beforeKey}; shapes after the key ${[...new Set(afterKey)].length}; furthest tile ${rightmost}; board ${got.join(',')}`);
}

// ---- (j) A KEY CUTS THE SLIDE AND THE SCREEN IS LEFT EQUAL TO THE BOARD. After a cut the game redraws the
// whole board (the cut move is drawn whole); this asserts that, at a cut in each phase (field 1, field 2, the
// flash, the pop): once it settles, every square's body is exactly the one its BOARD value's STYLES entry
// gives, and no square holds a leftover of the animation. A mutant that skips the redraw after a cut leaves a
// half-drawn or empty square, and every phase then fails.
{
  // each slot's even-row body byte must equal its value's even fill; a value 0 slot must be all zero
  const EVEN = { 0: 0x00, 1: 0x55, 2: 0xFF, 3: 0x77, 4: 0x66, 5: 0xEE };
  const mismatch = (m) => {
    const B = SYM('BOARD'), out = [];
    for (let sq = 0; sq < 16; sq++) {
      const v = m.ram[B + sq], want = EVEN[v];
      const body = boxBody(m, sq & 3, sq >> 2) & 0xFF;
      const ink = slotInk(m, sq & 3, sq >> 2);
      if (v === 0 ? ink !== 0 : (body !== want || ink !== TILEW * TILEH)) out.push(`sq ${sq} value ${v}: body $${body.toString(16)} (want $${want.toString(16)}), ink ${ink}`);
    }
    return out;
  };
  const bad = [];
  // cut after 1 field, after 2 fields, and during the flash; plus a pop-phase cut
  for (const cutAfter of [1, 2, 3]) {
    const { s, m } = startGame();
    setBoard(m, [[0, 1], [1, 1], [3, 1]]);       // a join at col 0, and a tile to move
    m.stubKeys.push(KEY.left);
    for (let f = 0; f < cutAfter; f++) nextField(s, m);
    // a key that CHANGES the board (RIGHT moves the tiles in row 0), so the game takes the SKIP path and
    // redraws the whole board; UP can leave the board unchanged here and would not exercise that path
    m.stubKeys.push(KEY.right);
    settle(s, m, 40);
    const errs = mismatch(m);
    if (errs.length) bad.push(`cut after ${cutAfter} field(s): ${errs.slice(0, 3).join('; ')}`);
  }
  // a cut during the POP: press after the slide has ended (POP set), then settle
  {
    const { s, m } = startGame();
    setBoard(m, [[3, 1]]);
    m.stubKeys.push(KEY.left);
    for (let f = 0; f < 40 && !m.ram[SYM('POP')]; f++) s.runFrames(1);
    m.stubKeys.push(KEY.right);                  // a changing key, to take the SKIP path
    settle(s, m, 40);
    const errs = mismatch(m);
    if (errs.length) bad.push(`cut during the pop: ${errs.slice(0, 3).join('; ')}`);
  }
  check('2048 slide: after a key cuts the animation (a slide field, the flash, the pop), every square on the screen is the one its board value draws',
    bad.length === 0, bad.slice(0, 4).join(' | ') || 'every phase left the screen equal to the board');
}

// ---- the order: slide fields, THEN the merge flash, THEN the pop ----
{
  const { s, m } = startGame();
  setBoard(m, [[0, 1], [1, 1]]);         // 2 2 . . : LEFT slides col 1 onto col 0 and joins
  m.stubKeys.push(KEY.left);
  const SMALL = (TILEW - 2) * (TILEH - 14), FULL = TILEW * TILEH;
  const timeline = [];
  for (let f = 0; f < 16; f++) {
    nextField(s, m);
    // a POPPING tile is a slot at exactly the small size; "any ink under 300" also catches a full tile (204)
    const small = [0, 1, 2, 3].some((c) => box(m, c, 0).ink === SMALL || box(m, c, 0).ink === SMALL - 1);
    // the flash is the $AA/$55 field at the joined square
    const rows = boxRows(m, 0, 0);
    const flash = boxBody(m, 0, 0) === 0xAA;
    timeline.push({ f, small, flash, joined: box(m, 0, 0).sig });
  }
  const firstFlash = timeline.findIndex((t) => t.flash);
  const firstPop = timeline.findIndex((t) => t.small);
  check('2048 slide: the order is slide, then the merge flash, then the pop (the flash precedes the pop)',
    firstFlash >= 0 && firstPop > firstFlash,
    `first flash field ${firstFlash}, first small-tile field ${firstPop}, timeline ${timeline.map((t) => (t.flash ? 'F' : '') + (t.small ? 'p' : '')).join(' ')}`);
}

// ---- (f) THE FLASH IS THE HIGHLIGHT PATTERN, ON THE JOIN SQUARES, ALL AT ONCE. The flash fills each
// square in MRGL with $AA on even rows and $55 on odd ones - a fill no tile's body uses. The flash's field
// tick is the ENTROPY write inside FLASH's SLFIELD, which comes AFTER both boxes are painted and before the
// VSYNC wait; watching that write and reading the screen at that instant is deterministic (no frame-boundary
// guesswork). At that instant EVERY MRGL square must hold the highlight and NO other square may; a field
// later, those squares hold their tiles' own bodies again.
{
  const EVEN = { 1: 0x55, 2: 0xFF, 3: 0x77, 4: 0x66, 5: 0xEE };
  const isFlash = (m, sq) => {
    const rows = boxRows(m, sq & 3, sq >> 2);
    const tally = (which) => { const h = new Map(); rows.forEach((row, i) => { if ((i & 1) === which) row.forEach((v) => h.set(v, (h.get(v) || 0) + 1)); }); return [...h.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
    return tally(0) === 0xAA && tally(1) === 0x55;
  };
  // joins away from square 0 in all four directions, and two joins in one move
  const cases = [
    { name: 'LEFT, a join away from 0', cells: [[3, 2], [2, 2]], key: KEY.left },
    { name: 'RIGHT', cells: [[0, 4], [1, 4]], key: KEY.right },
    { name: 'UP, a join away from 0', cells: [[12, 2], [8, 2]], key: KEY.up },
    { name: 'DOWN', cells: [[0, 2], [4, 2]], key: KEY.down },
    { name: 'LEFT, two joins', cells: [[0, 1], [1, 1], [2, 1], [3, 1]], key: KEY.left },
  ];
  const bad = [];
  for (const c of cases) {
    const { s, m } = startGame();
    setBoard(m, c.cells);
    m.stubKeys.push(c.key);
    // the flash's own field tick: FLASH's SLFIELD writes ENTROPY. Watch it; the first write after the slide is
    // the flash field (the slide's own SLFIELD writes come first, all before FLASH's boxes are painted).
    let joins = null;
    const ticks = [];                        // the flashing set at EVERY field tick taken while FLMARK = 1
    const afterFlash = [];                   // the first tick AFTER the flash: those squares must be restored
    let fieldInRestore = 0;                  // a field tick seen while the restore was under way (the flash held)
    let flashAtCycle = -1;                   // the machine's time at the flash tick
    const heldFields = [];                   // cases where the restore did not finish inside the flash's field
    const w = s.watchWrites({ start: SYM('ENTROPY'), end: SYM('ENTROPY') + 1 }, (e) => {
      // The program sets FLMARK just before the flash's field tick and clears it before the restore, so every
      // ENTROPY write seen while FLMARK = 1 is a field tick of the flash itself. The whole point of the flash is
      // that EVERY join square is highlighted AT EACH such tick: an extra SLFIELD inside the paint loop would
      // give an early tick with only some boxes painted, and that tick's set is caught here.
      if (m.ram[SYM('FLMARK')]) {
        // STD ENTROPY is a 16-bit store: the tap reports both bytes, so count a tick on the LOW byte's write only
        if (e.address !== SYM('ENTROPY') + 1) return;
        if (!joins) joins = [...m.ram.slice(SYM('MRGL'), SYM('MRGL') + m.ram[SYM('MRGN')])].sort((a, b) => a - b);
        const flashing = [];
        for (let sq = 0; sq < 16; sq++) if (isFlash(m, sq)) flashing.push(sq);
        ticks.push(flashing.sort((a, b) => a - b));
        flashAtCycle = e.at;                 // the machine's time at the flash's own tick
      } else if (ticks.length && afterFlash.length === 0 && e.address === SYM('ENTROPY') + 1) {
        // the first field tick after the flash: the boxes must already be back to their tiles' own bodies.
        const still = [];
        for (const sq of joins) if (isFlash(m, sq)) still.push(sq);
        afterFlash.push(still);
      }
      // A tick while the restore is under way (FLREST = 1) means the flash was held into a second field, by an
      // extra SLFIELD after the flash's tick. Independent of FLMARK.
      if (e.address === SYM('ENTROPY') + 1 && m.ram[SYM('FLREST')] && ticks.length) fieldInRestore++;
    });
    // run until the flash and the tick after it are both seen (the spawn may be under way by then: the restore
    // happens at the end of the flash field, before the pop)
    for (let f = 0; f < 400; f++) {
      s.runFrames(1);
      if (ticks.length && afterFlash.length) break;
      if (m.ram[SYM('POP')] && !ticks.length) break;   // the spawn began before any flash (never on these boards)
    }
    w.remove();
    if (!ticks.length) { bad.push(`${c.name}: the flash field tick was never seen`); continue; }
    // exactly ONE field tick while the flash is up (the "one-field flash" spec), and at every such tick the
    // highlighted set is EXACTLY the join squares
    if (ticks.length !== 1) bad.push(`${c.name}: ${ticks.length} field ticks while flashing, want 1 (sets ${ticks.map((t) => '[' + t.join(',') + ']').join(' ')})`);
    ticks.forEach((got, i) => {
      if (JSON.stringify(got) !== JSON.stringify(joins)) bad.push(`${c.name}, flash tick ${i + 1}: highlight on [${got.join(',')}], the joins are [${joins.join(',')}]`);
    });
    // The field after the flash: sampled at the next frame end after the restore, the joins must be tiles again.
    // (The flash itself is painted, ticked and restored inside one field, so no frame end need show it; what must
    // NOT happen is the highlight still being up a frame later, which is what a flash held by an extra SLFIELD or
    // a bare VSYNC does.)
    if (joins && joins.length) {
      s.runFrames(2);
      const still = joins.filter((sq) => isFlash(m, sq));
      if (still.length) heldFields.push(`${c.name}: the highlight was still up two frames after the flash ([${still.join(',')}])`);
    }
    // the field after the flash: those squares are back to their tiles (no highlight left)
    if (fieldInRestore) bad.push(`${c.name}: ${fieldInRestore} field tick(s) while the restore was under way (the flash was held for a second field)`);
    heldFields.forEach((h) => bad.push(h));
    if (!afterFlash.length) bad.push(`${c.name}: no field tick after the flash to check the restore`);
    else if (afterFlash[0].length) bad.push(`${c.name}: the field after the flash still shows the highlight on [${afterFlash[0].join(',')}] (the flash was held for a second field)`);
  }
  check('2048 slide: at the flash field every join square holds the highlight and no other square does (all four directions, one and two joins)',
    bad.length === 0, bad.slice(0, 3).join('; ') || 'every case: exactly the join squares flashed, together');
}

// ---- (g) THE NEW TILE POPS: SMALL (4x20 = 80 inked bytes) before FULL (6x34 = 204). Both sizes are
// derived from the geometry: a full tile is TILEW x TILEH (its fill has no $00, so its ink is exactly
// that); the pop draws TILEW-2 by TILEH-14 inside a box painted the empty fill, so its ink is exactly
// (TILEW-2)*(TILEH-14). The pop's fields go through the same field clock as the slide (VSYNC, an ENTROPY tick
// and a POLCAT poll each), but the pop's own fields are shorter than a frame sampler can rely on, so it is
// sampled PER FRAME from the spawn event: a run of frames at SMALL, then the tile at FULL.
{
  const FULL = TILEW * TILEH;               // 204
  const SMALL = (TILEW - 2) * (TILEH - 14); // 4 x 20 = 80
  const { s, m } = startGame();
  setBoard(m, [[3, 1]]);                    // one 2 at (3,0): LEFT lands it, then spawns one new tile
  m.stubKeys.push(KEY.left);
  // The window is anchored to the move's own events, not a frame count: run until the spawn begins (POP set),
  // then to the frame POP clears (the tile is full). A busy wait anywhere in the slide just delays POP; the
  // window moves with it. Each slot's ink is recorded per frame over that window.
  const bySlot = new Map();
  // Keep a rolling one-frame history: when POP first shows, the frame BEFORE it (the slot still empty) belongs
  // to the sequence too, so the window is [one frame before POP .. the frame POP clears].
  let prevInks = null, started = false;
  for (let f = 0; f < 400; f++) {
    const cur = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) cur.push({ k: `${c},${r}`, ink: slotInk(m, c, r) });
    const pop = m.ram[SYM('POP')];
    if (pop && !started) {
      started = true;
      if (prevInks) for (const { k, ink } of prevInks) { if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(ink); }
    }
    if (started) for (const { k, ink } of cur) { if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(ink); }
    if (started && !pop) { for (let k = 0; k < 3; k++) { s.runFrames(1); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { const kk = `${c},${r}`; bySlot.get(kk).push(slotInk(m, c, r)); } } break; }  // a few frames for the full draw
    prevInks = cur;
    s.runFrames(1);
  }
  // a slot that pops, ANYWHERE in the window: EMPTY, then a run of >=2 small frames (ink <= SMALL), then a
  // later FULL (part-painted frames between are allowed). Scanning for the sequence rather than anchoring on
  // the first FULL lets a slot that also held a sliding tile earlier still qualify.
  const popped = [];
  for (const [k, series] of bySlot) {
    let ok = false;
    for (let i = 0; i < series.length && !ok; i++) {
      if (series[i] !== 0) continue;                       // an empty frame
      let j = i + 1, small = 0;
      while (j < series.length && series[j] > 0 && series[j] <= SMALL) { small++; j++; }
      if (small < 2) continue;
      while (j < series.length && series[j] > SMALL && series[j] < FULL) j++;   // part-painted
      if (j < series.length && series[j] === FULL) ok = true;
    }
    if (ok) popped.push(k);
  }
  check('2048 slide: the new tile is SMALL (4x20 = 80 bytes) before FULL (6x34 = 204), both from the geometry',
    FULL === 204 && SMALL === 80 && popped.length === 1,
    `full ${FULL}, small ${SMALL}, popped [${popped.join(' ')}], series ${[...bySlot].map(([k, v]) => k + ':' + [...new Set(v)].join('/')).join(' ')}`);
}

// ---- (h) A SLIDING FIELD SHOWS THE MOVER'S OWN VALUE. A 4 (value 2, even-row body $FF) at (3,0) slides
// LEFT to (0,0). While the slide runs (MFIELD < SLIDEF) it sits on columns 1 and 2; the rows DRAWN there
// must carry that $FF body. Read as drawn, not "a whole 204-ink tile": a frame is sampled mid-draw, so
// the tile is often part-painted, but the bytes already on screen are the mover's own.
{
  const SLIDEF = 3;
  const { s, m } = startGame();
  setBoard(m, [[3, 2]]);                   // a 4 at (3,0), LEFT takes it to (0,0)
  m.stubKeys.push(KEY.left);
  const wrong = [];
  let midFields = 0;
  for (let f = 0; f < 20; f++) {
    s.runFrames(1);
    if (m.ram[SYM('MFIELD')] >= SLIDEF) continue;   // the slide is still running
    for (let c = 1; c < 3; c++) {          // the mover passes through columns 1 and 2
      const rows = boxRows(m, c, 0);
      const h = new Map();
      rows.forEach((row, i) => { if ((i & 1) === 0 && row[0]) h.set(row[0], (h.get(row[0]) || 0) + 1); });
      if (!h.size) continue;               // nothing drawn here yet
      midFields++;
      const body = [...h.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (body !== 0xFF) wrong.push(`frame ${f} col ${c}: body $${body.toString(16)}, a 4's is $ff`);
    }
  }
  check('2048 slide: while the slide runs, the middle columns show the mover\'s own value (a 4\'s $FF body), not a merged one',
    midFields > 0 && wrong.length === 0, `${midFields} mid-slide reads; ${wrong.slice(0, 3).join('; ')}`);
}

// ---- (i) A JOINING TILE SHOWS WHAT IT WAS, NOT WHAT IT BECOMES. A tile that joins can travel more than
// one square: [2,0,2] LEFT sends the col-2 2 across col 1 to join the 2 at col 0, and
// [4,0,0,4] LEFT sends a 4 the same way. The tile in flight must carry its OWN body ($55 for a 2, $FF for
// a 4) - not the merged value's, which the board already holds at its destination and which appears on
// the flash. This is the case the old slide got wrong: it drew BOARD[to], so a merging tile slid in
// showing the merged value (a 4 sliding in to meet a 2; an 8 sliding in to meet a 4).
{
  const SLIDEF = 3;
  // tile value -> the even-row body its STYLES entry gives (read above: 1 -> $55, 2 -> $FF, 3 -> $77)
  const OWN = { 1: 0x55, 2: 0xFF };
  const cases = [
    { cells: [[0, 1], [2, 1]], src: 1, merged: 2, what: 'a 2 joining a 2' },   // 2 + 2 -> 4, two squares apart
    { cells: [[0, 2], [2, 2]], src: 2, merged: 3, what: 'a 4 joining a 4' },   // 4 + 4 -> 8, two squares apart
  ];
  const bad = [];
  const reads = [];                              // reads per leg: must be >= 2 on EACH
  for (const c of cases) {
    const { s, m } = startGame();
    setBoard(m, c.cells);
    m.stubKeys.push(KEY.left);
    let legReads = 0;
    for (let f = 0; f < 20; f++) {
      s.runFrames(1);
      // the slide is over when the spawn begins OR once the mover has arrived and drawn at its destination
      // (col 0); either way, do not read the spawn's own tile as the mover
      if (m.ram[SYM('POP')]) break;
      if (m.ram[SYM('MFIELD')] >= SLIDEF && slotInk(m, 0, 0) === TILEW * TILEH) break;
      for (const col of [1, 2]) {
        const rows = boxRows(m, col, 0);
        const h = new Map();
        rows.forEach((row, i) => { if ((i & 1) === 0 && row[0]) h.set(row[0], (h.get(row[0]) || 0) + 1); });
        if (!h.size) continue;
        legReads++;
        const body = [...h.entries()].sort((a, b) => b[1] - a[1])[0][0];
        if (body !== OWN[c.src]) bad.push(`frame ${f} col ${col} (${c.what}): body $${body.toString(16)}, its own is $${OWN[c.src].toString(16)}`);
      }
    }
    reads.push(legReads);
    // the board after the move really holds the merged value, so the check is chasing the right pair
    const dest = m.ram[SYM('BOARD')];
    if (dest !== c.merged) bad.push(`${c.what}: destination value ${dest}, want ${c.merged}`);
  }
  // BOTH legs must have been seen in flight, at least twice each: one leg passing on its own is not the rule
  const legsOk = reads.every((r) => r >= 2);
  if (!legsOk) bad.push(`in-flight reads per leg ${reads.join(' and ')}, want at least 2 each`);
  check('2048 slide: a joining tile slides in showing its own value (a 2\'s $55, a 4\'s $FF), not the merged value it becomes',
    legsOk && bad.length === 0, `reads per leg [${reads.join(', ')}]; ${bad.slice(0, 4).join('; ')}`);
}

// ---- (k) EVERY MOVER IS DRAWN ON THE SQUARE THE MOVE PUTS IT, at every field of the slide. Row [.,2,2,4] LEFT
// moves 1->0, 2->0 and 3->1; at field f mover (from,to) sits at from + step*SPSTEP[(f-1)*SLIDEF + travel-1], and
// that square must show the mover's OWN body. Counting tiles is too weak (two tiles can overlap and keep the
// count up while one is missing); this checks IDENTITY and POSITION, so a slide that blanks a square and skips
// an unmoved mover shows as a square with no body where the model puts one.
{
  const { s, m } = startGame();
  setBoard(m, [[1, 1], [2, 1], [3, 2]]);   // row0: .,2,2,4  -> the movers 1->0 (v1), 2->0 (v1), 3->1 (v2)
  m.stubKeys.push(KEY.left);
  const MFR = SYM('MFR'), MVF = SYM('MVF'), EVEN = { 1: 0x55, 2: 0xFF, 3: 0x77, 4: 0x66 };
  let movers = null;
  const bad = [];
  let prevE = m.ram[SYM('ENTROPY')] * 256 + m.ram[SYM('ENTROPY') + 1];
  for (let f = 0; f < 400; f++) {
    s.runFrames(1);
    const e = m.ram[SYM('ENTROPY')] * 256 + m.ram[SYM('ENTROPY') + 1];
    if (e === prevE) continue;
    prevE = e;
    const mf = m.ram[SYM('MFIELD')];
    if (mf === 0) continue;
    if (m.ram[SYM('POP')]) break;
    if (mf >= 3) continue;                  // the arrival field merges/flashes: the movers' own bodies are no
                                            // longer what is drawn there (the flash, then the merged tile)
    if (!movers) {
      const n = m.ram[SYM('MOVN')];
      movers = [];
      for (let i = 0; i < n; i++) movers.push({ from: m.ram[MFR + 2 * i], to: m.ram[MFR + 2 * i + 1], val: m.ram[MVF + i] });
    }
    // where the model puts each mover at this field
    for (const mv of movers) {
      const travel = Math.abs(mv.to - mv.from);
      const vert = travel >= 4;
      const dist = vert ? travel >> 2 : travel;                      // the move's length in squares
      const step = vert ? (mv.to < mv.from ? -4 : 4) : (mv.to < mv.from ? -1 : 1);
      // SPSTEP is SLIDEF rows of SLIDEF: row `dist-1` (a slide of dist squares) holds the squares reached at
      // fields 1..SLIDEF. Row 1 = 0,1,1; row 2 = 1,1,2; row 3 = 1,2,3.
      const SPSTEP = [[0, 1, 1], [1, 1, 2], [1, 2, 3]];
      const travelled = SPSTEP[dist - 1][mf - 1];
      const sq = mv.from + step * travelled;
      if (sq < 0 || sq > 15) { bad.push(`MF${mf}: mover ${mv.from}->${mv.to} at square ${sq}, out of range`); continue; }
      const body = boxBody(m, sq & 3, sq >> 2);
      if (body !== EVEN[mv.val]) bad.push(`MF${mf}: mover ${mv.from}->${mv.to}(v${mv.val}) should be on square ${sq} (body $${EVEN[mv.val].toString(16)}), that square shows $${body.toString(16)}`);
    }
  }
  check('2048 slide: at every field, each mover is drawn on the square the move puts it (identity and position)',
    !!movers && movers.length === 3 && bad.length === 0,
    bad.slice(0, 4).join('; ') || 'every mover on its square, every field');
}

// ---- (l) A KEY CUTS THE POP, TOO. The pop is part of the move's animation, so a key pressed during it ends it
// at once and is the next move - not held until the pop's own fields run out. Press RIGHT while the new tile
// pops (POP set); the cut move must be applied within a field or two (one ENTROPY tick), and exactly once.
{
  const { s, m } = startGame();
  setBoard(m, [[3, 1]]);                   // a 2 at (3,0); LEFT lands it at col 0, then a tile pops
  const moves = () => m.ram[SYM('MOVES')] * 256 + m.ram[SYM('MOVES') + 1];
  m.stubKeys.push(KEY.left);
  let pressedAt = -1, appliedAt = -1;
  for (let f = 0; f < 300; f++) {
    const popNow = m.ram[SYM('POP')];
    if (popNow && pressedAt < 0) { pressedAt = f; m.stubKeys.push(KEY.right); }
    s.runFrames(1);
    if (pressedAt >= 0 && appliedAt < 0 && moves() === 2) appliedAt = f;
  }
  const waited = appliedAt - pressedAt;
  check('2048 slide: a key pressed during the pop ends it at once and is applied as the next move',
    pressedAt >= 0 && appliedAt >= 0 && waited >= 0 && waited <= 2 && moves() === 2,
    `RIGHT pressed at frame ${pressedAt}, applied at ${appliedAt} (waited ${waited}); MOVES ${moves()} (want 2)`);
}

// ---- (m) THE KEY QUEUE: every key is played, in order, and survives R. LEFT,R,LEFT (each pressed 0..3 frames
// apart) must apply LEFT, then R, then LEFT - MOVES 1 in the new game; LEFT,R,LEFT,RIGHT must apply the RIGHT too
// (MOVES 2). R must not drop keys that were queued behind it.
{
  const R = 82;                              // 'R
  const bad = [];
  for (const seq of [['left', 'r', 'left'], ['left', 'r', 'left', 'right']]) {
    for (const gap of [0, 1, 2, 3]) {
      const { s, m } = startGame();
      setBoard(m, [[2, 1], [5, 2], [9, 1]]);   // tiles a LEFT/RIGHT will change
      m.stubKeys.push(KEY[seq[0]]);
      for (let f = 0; f < gap; f++) s.runFrames(1);
      for (const k of seq.slice(1)) { m.stubKeys.push(k === 'r' ? R : KEY[k]); for (let f = 0; f < gap; f++) s.runFrames(1); }
      for (let f = 0; f < 600; f++) s.runFrames(1);
      const want = seq.length - 2;           // R does not count as a move
      const got = gameMoves(m);
      if (got !== want) bad.push(`${seq.join(',')} gap ${gap}: MOVES=${got}, want ${want}`);
    }
  }
  check('2048 slide: keys queued behind R are still played, in order (LEFT,R,LEFT and LEFT,R,LEFT,RIGHT)',
    bad.length === 0, bad.slice(0, 4).join('; ') || 'every key applied, in order, at every gap');
}

// ---- (n) THE QUEUE ITSELF: depth and order. Driven by a tiny routine
// written into RAM that calls the game's own KQPUSH / KQPOP, so the queue is exercised exactly as the game does.
{
  const bad = [];
  const KQ = SYM('KQ'), KQN = SYM('KQN'), KQPUSH = SYM('KQPUSH'), KQPOP = SYM('KQPOP'), KQKEY = SYM('KQKEY');
  // a routine at $2800 (free RAM below the stack's floor): push KQ + i for i = 0..4, then stop
  const { s, m } = startGame();
  const CODE = 0x2800, SENT = 0x27F0;
  let p2 = CODE;
  const emit = (...bs) => { for (const x of bs) m.poke(p2++, x); };
  for (let i = 0; i < 5; i++) {
    emit(0x86, 1 + i);                       // LDA #1+i
    emit(0xB7, KQKEY >> 8, KQKEY & 0xFF);    // STA KQKEY
    emit(0xBD, KQPUSH >> 8, KQPUSH & 0xFF);  // JSR KQPUSH
  }
  emit(0x20, 0xFE);                          // BRA * (stop here)
  m.poke(SENT, 0xDE); m.poke(SENT + 1, 0xAD);
  m.cpu.pc = CODE; m.cpu.s = SENT + 2;
  for (let f = 0; f < 5; f++) s.runFrames(1);
  const q = Array.from(m.ram.slice(KQ, KQ + 4));
  if (m.ram[KQN] !== 4) bad.push(`depth: KQN=${m.ram[KQN]} after 5 pushes, want 4`);
  if (q.join(',') !== '1,2,3,4') bad.push(`order: KQ=[${q.join(',')}], want 1,2,3,4 (the fifth dropped)`);
  // Overflow is the DEPTH assertion above, and only that. A sentinel past the queue CANNOT fail: a push writes
  // KQ[KQN] and KQN itself sits at KQ+4, so an uncapped queue corrupts KQN before it ever reaches KQ+5.
  // Measured with the cap removed entirely (CMPB #8) and these same five pushes: KQN reads 6 (the fifth push
  // wrote KQ+4, which is KQN, and INC KQN made it 6) and KQTMP (KQ+5) is still 0, so the depth assertion is
  // what catches a spill - there is nothing else to assert.
  // pop them back: oldest first, and the queue empties
  {
    const { s: s2, m: m2 } = startGame();
    let q2 = CODE;
    const em2 = (...bs) => { for (const x of bs) m2.poke(q2++, x); };
    for (let i = 0; i < 3; i++) em2(0x86, 7 + i, 0xB7, KQKEY >> 8, KQKEY & 0xFF, 0xBD, KQPUSH >> 8, KQPUSH & 0xFF);
    // pop 3, parking each in $27E0+i
    for (let i = 0; i < 3; i++) em2(0xBD, KQPOP >> 8, KQPOP & 0xFF, 0xB7, 0x27, 0xE0 + i);
    em2(0x20, 0xFE);
    m2.poke(SENT, 0xDE); m2.poke(SENT + 1, 0xAD);
    m2.cpu.pc = CODE; m2.cpu.s = SENT + 2;
    for (let f = 0; f < 5; f++) s2.runFrames(1);
    const pops = Array.from(m2.ram.slice(0x27E0, 0x27E3));
    if (pops.join(',') !== '7,8,9') bad.push(`pop order: [${pops.join(',')}], want 7,8,9`);
    if (m2.ram[KQN] !== 0) bad.push(`after 3 pops KQN=${m2.ram[KQN]}, want 0`);
  }
  // a CoCo 3 (RAM garbage at power-on) with SEVERAL keys queued: every one plays, in order
  {
    const s2 = new Emu.Session({ welcomeMenu: false });
    s2.switchMachine('coco3', {}, { menu: false });
    s2.load('2048.bin', BIN, { remember: false });
    const m2 = s2.shownMachine;
    s2.runFrames(30);
    m2.poke(Emu.GAMES.seed, 0x5E); m2.poke(Emu.GAMES.seed + 1, 0xED);
    m2.stubKeys.push(32);
    for (let f = 0; f < 40; f++) s2.runFrames(1);
    setBoard(m2, [[2, 1], [5, 2], [9, 1]]);
    m2.stubKeys.push(KEY.left);
    for (let f = 0; f < 2; f++) s2.runFrames(1);
    m2.stubKeys.push(KEY.right); m2.stubKeys.push(KEY.down);
    for (let f = 0; f < 800; f++) s2.runFrames(1);
    if (gameMoves(m2) !== 3) bad.push(`CoCo 3 with three keys queued: MOVES=${gameMoves(m2)}, want 3`);
  }
  check('2048 slide: the queue holds four (a fifth push is dropped) and pops oldest first',
    bad.length === 0, bad.slice(0, 3).join('; ') || 'depth 4, drops the fifth, pops in order');
}

// ---- (o) THE FLASH LASTS ONE FIELD. Its duration is measured in machine cycles from FLMARK going up (before
// the first box is painted) to FLREST going up (the restore begins): d = t(FLREST) - t(FLMARK). One field is the
// machine's own frameCycles (read from the machine, never hard-coded). The spec's "a one-field flash" wants the
// flash up for a whole field and not two: approximately F <= d < 2F. Measured on a 50 Hz Dragon (PAL) and a
// 60 Hz CoCo (NTSC), and reported for each.
{
  const runs = [];
  for (const [model, opts] of [['dragon64', {}], ['coco', {}]]) {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine(model, opts, { menu: false });
    s.load('2048.bin', BIN, { remember: false });
    const m = s.shownMachine;
    s.runFrames(30);
    m.poke(Emu.GAMES.seed, 0x5E); m.poke(Emu.GAMES.seed + 1, 0xED);
    m.stubKeys.push(32);
    for (let f = 0; f < 40; f++) s.runFrames(1);
    setBoard(m, [[0, 1], [1, 1]]);            // a join at 0: one flash
    let tOn = -1, tOff = -1;
    const w = s.watchWrites({ start: SYM('FLMARK'), end: SYM('FLMARK') }, (e) => {
      if (e.value === 1 && tOn < 0) tOn = e.at;
    });
    const w2 = s.watchWrites({ start: SYM('FLREST'), end: SYM('FLREST') }, (e) => {
      if (e.value === 1 && tOn >= 0 && tOff < 0) tOff = e.at;
    });
    m.stubKeys.push(KEY.left);
    for (let f = 0; f < 200 && tOff < 0; f++) s.runFrames(1);
    w.remove(); w2.remove();
    runs.push({ model, F: m.frameCycles, fps: m.fps, d: tOff >= 0 && tOn >= 0 ? tOff - tOn : -1 });
  }
  // ONE field, and not two: the measured d/F is 0.999 on head and 1.998 with a field inserted (both mutants).
  // A bound of "F <= d < 2F" would pass both mutants, so the bound is centred on one field.
  const bad = runs.filter((r) => r.d < 0 || !(r.d >= r.F * 0.95 && r.d < r.F * 1.5));
  const what = runs.map((r) => `${r.model} (${r.fps.toFixed(0)} Hz): d=${r.d} cycles, F=${r.F}, d/F=${(r.d / r.F).toFixed(3)}`).join('; ');
  check('2048 slide: the flash lasts one field (0.95F <= d < 1.5F) on a 50 Hz Dragon and a 60 Hz CoCo',
    bad.length === 0, what);
}

// ---- (p) NOTHING IS LEFT BEHIND. A square a mover has left must be drawn EMPTY on that field, unless another
// mover is on it. A slide that draws the movers but never empties where they were leaves a TRAIL of copies: a 2
// sliding from square 3 to 0 keeps copies at 3 and 2 until SHOWALL, which "nothing is left behind" forbids.
//
// What it reads: the mover table (MFR, two bytes a mover) for each mover's from and to; a COPY of SPSTEP held in
// this test (not MVF, which is the mover's VALUE and plays no part here); and the screen bytes at each candidate
// square. The model picks the squares by position; the verdict on each is an INK TEST (any non-zero byte), not a
// value check - what value is drawn there is other checks' business.
// What it covers: one scenario, a single 2 sliding from square 3 to 0 by LEFT. Sampled INSIDE the field tick,
// after that field's draws, so a frame boundary cannot catch a draw part-way.
{
  const { s, m } = startGame();
  setBoard(m, [[3, 1]]);                    // one 2 at square 3: LEFT takes it to square 0
  m.stubKeys.push(KEY.left);
  const MFR = SYM('MFR');
  // SPSTEP as SPLACE reads it: SPSTEP[(field-1)*SLIDEF + MK-1], the flat table 0,1,1,1,1,2,1,2,3
  const SPSTEP = [0, 1, 1, 1, 1, 2, 1, 2, 3];
  let movers = null;
  const bad = [];
  const w = s.watchWrites({ start: SYM('ENTROPY'), end: SYM('ENTROPY') + 1 }, (e) => {
    if (e.address !== SYM('ENTROPY') + 1) return;        // STD ENTROPY reports both bytes
    const mf = m.ram[SYM('MFIELD')];
    if (mf === 0 || m.ram[SYM('POP')]) return;
    if (!movers) {
      const n = m.ram[SYM('MOVN')];
      movers = [];
      for (let i = 0; i < n; i++) movers.push({ from: m.ram[MFR + 2 * i], to: m.ram[MFR + 2 * i + 1] });
      if (!n) return;
    }
    const occupied = new Set();
    for (const mv of movers) {
      const travel = Math.abs(mv.to - mv.from);
      const vert = travel >= 4;
      const dist = vert ? travel >> 2 : travel;
      const step = vert ? (mv.to < mv.from ? -4 : 4) : (mv.to < mv.from ? -1 : 1);
      occupied.add(mv.from + step * SPSTEP[(mf - 1) * 3 + (dist - 1)]);
    }
    const lo = Math.min(...movers.map((mv) => Math.min(mv.from, mv.to)));
    const hi = Math.max(...movers.map((mv) => Math.max(mv.from, mv.to)));
    for (let sq = lo; sq <= hi; sq++) {
      if (occupied.has(sq)) continue;                     // a mover is on it this field
      if (m.ram[SYM('BOARD') + sq] !== 0) continue;       // a tile rests there
      const ink = slotInk(m, sq & 3, sq >> 2);
      if (ink > 0) bad.push(`MF${mf}: square ${sq} has no mover on it but shows ${ink} bytes of ink (a copy left behind)`);
    }
  });
  for (let f = 0; f < 400 && !m.ram[SYM('POP')]; f++) s.runFrames(1);
  w.remove();
  check('2048 slide: every square a mover has left is drawn empty on that field (nothing is left behind)',
    !!movers && movers.length > 0 && bad.length === 0,
    bad.slice(0, 4).join('; ') || 'no square keeps a copy of a mover that has moved on');
}

console.log(fail ? `${fail} of ${n} slide checks FAILED` : `all ${n} slide checks passed`);
process.exitCode = fail ? 1 : 0;
