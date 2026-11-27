// Run: node tests/basic-drawing-line.test.js
//
// The clean-room BASIC's LINE (docs/clean-room-basic-p2.md section 5) in PMODE 1 and 3 (colour set 1) and 2 (colour set 0):
// every octant both ways, lengths 0 and 1, B, BF, PRESET, -(x,y) and random lines, the page compared byte for byte
// with tests/basic/gfxmodel.js, and the last point after (tests/basic-drawing.test.js says more, and has the other
// modes).
const { line, tally } = require('./basic/basic-drawing-lib.js');

line([3, 4, 5]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
