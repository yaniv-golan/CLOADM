// THE CURSOR THE RENDERER ACTUALLY USES, not a formula that agrees with itself.
// The previous version of this check recomputed "every advance is 4 or 6" and applied its own `& ~1`, so it
// could not fail when CENTRE stopped aligning or when TILEAT computed an odd column: the renderer always produced
// an even-looking COLUMN, so every picture-based check stayed green.
//
// This runs the real game and reads PCOL as PCPROP is entered -- the phase the renderer selects a table with.
// An odd PCOL is what breaks the two-byte row write for a five-wide glyph, so it is the thing to assert.
//
// Run by tests/all.js. Usage: node tests/cursor-phases.test.js [tree] [frames]
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const FRAMES = Number(process.argv[3] || 60);
const Emu = require(path.join(ROOT, 'tests/load'))();
const read = (f) => fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8');

const results = [];
for (const game of ['2048', 'minesweeper']) {
  const A = Emu.assemble(read(`${game}.asm`), '6809', { include: read });
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  s.load(`${game}.bin`, new Uint8Array(Emu.toBinary(A)), { remember: false });
  const m = s.machine, sy = (k) => A.symbols.get(k);
  const PCPROP = sy('PCPROP'), PCOL = sy('PCOL'), PCGW = sy('PCGW');
  // pcWatch is called with the PC before every instruction, at full speed: no stepping loop, no slowdown.
  // PCPROP is entered exactly ONCE PER GLYPH -- that is the sampling point. Its WIDTH (PCGW) is only correct
  // after PCFIND, which PCPROP calls first, so the width is taken when the glyph is drawn: PCFIND has run by the
  // time PCDOROW is reached, and the entry records PCOL there while counting the glyph at PCPROP.
  const PCDOROW = sy('PCDOROW');
  const seen = [];
  let pending = null;
  m.pcWatch = (pc) => {
    if (pc === PCPROP) pending = { pcol: m.ram[PCOL], w: -1 };
    else if (pc === PCDOROW && pending) { pending.w = m.ram[PCGW]; seen.push(pending); pending = null; }
  };
  s.runFrames(FRAMES);
  m.pcWatch = null;
  const odd = seen.filter((x) => x.pcol % 2 !== 0);
  const wideOdd = odd.filter((x) => x.w >= 5);
  results.push({ game, calls: seen.length, odd: odd.length, wideOdd: wideOdd.length,
    phases: [...new Set(seen.map((x) => `${x.w}@${x.pcol}`))].sort().join(' ') });
}
for (const r of results) {
  console.log(`${r.game}: ${r.calls} glyphs drawn; phases seen: ${r.phases}`);
  console.log(`  odd PCOL: ${r.odd}, of which five-wide (the corrupting case): ${r.wideOdd}`);
}
const bad = results.reduce((n, r) => n + r.odd, 0);
// The runner reads the LAST non-blank line, and it must be summary-shaped (tests/suite-verdict.js).
const n = results.reduce((a, r) => a + r.calls, 0);
// A FLOOR, so the check cannot pass by observing nothing: a renamed PCPROP, or a hook that never fires, would
// otherwise print "all 0 glyphs ... passed". 242 are seen; require most of them.
const FLOOR = 200;
if (n < FLOOR) { console.log(`\n${n} of at least ${FLOOR} 1x glyphs observed -- the hook did not see the renderer`); process.exitCode = 1; }
else if (bad) { console.log(`\n${bad} of ${n} 1x glyphs drawn at an odd phase`); process.exitCode = 1; }
else { console.log(`\nall ${n} 1x glyphs drawn at phase 0 or 2 passed`); process.exitCode = 0; }
