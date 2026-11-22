// THE CURSOR THE RENDERER ACTUALLY USES, not a formula that agrees with itself.
// The previous version of this check recomputed "every advance is 4 or 6" and applied its own `& ~1`, so it
// could not fail when CENTRE stopped aligning or when TILEAT computed an odd column: VTAB points the odd-phase
// slots at the even tables, so the PIXELS still look even and every picture-based check stays green.
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
  const seen = [];
  m.pcWatch = (pc) => { if (pc === PCPROP) seen.push({ pcol: m.ram[PCOL], w: m.ram[PCGW] }); };
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
if (bad) console.log(`\n${bad} of ${n} 1x glyphs drawn at an odd phase`);
else console.log(`\nall ${n} 1x glyphs drawn at phase 0 or 2 passed`);
process.exitCode = bad ? 1 : 0;
