// Run: node tests/basic-drawing-circle.test.js
//
// The clean-room BASIC's CIRCLE (docs/clean-room-basic-p2.md section 5) in PMODE 4, 0, 3 and 1: radii, ratios, arcs,
// colours and circles across the edges, the page compared byte for byte with tests/basic/gfxmodel.js, and the last
// point left as it was; and PAINT running out of memory (?OM ERROR) on a comb of one-pixel teeth, BASIC going on after
// it (tests/basic-drawing.test.js says more).
const { circle, paintOm, tally } = require('./basic/basic-drawing-lib.js');

circle();
paintOm();
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
