// Run: node tests/basic-gfx-pset.test.js
//
// The clean-room BASIC's PSET, PRESET, PCLS and COLOR in PMODE 0, 1 and 2 (docs/clean-room-basic-p2.md sections 3, 5
// and 9), every colour set, on page 1 and on others: BASIC programs typed into a Dragon 64 running the image assembled
// from basic/ at test time (no other ROM) draw points from DATA, and the pages in RAM are compared byte for byte with
// tests/basic/gfxmodel.js, a reference model written from the document's tables, not from the 6809 code; the text
// screen is back at OK. PMODE 3 and 4 and the rest of the graphics: tests/basic-gfx.test.js.
const { tally, runPlans } = require('./basic/basic-gfx-lib.js');

// Each run: PMODE m,p : SCREEN 1,s : COLOR f,b (or none: the mode's defaults) : PCLS [c], then points from DATA
// (x, y, colour 0-8; 9 = PSET with no colour, -1 = PRESET).
runPlans((pl) => pl.m <= 2);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
