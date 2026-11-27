// Run: node tests/basic-drawing-getput.test.js
//
// The clean-room BASIC's GET and PUT (docs/clean-room-basic-p2.md section 8) in PMODE 4, 3 and 0: GET's bytes in the
// array with and without G, PUT with every action on eight rectangles against the bitwise model in
// tests/basic/gfxmodel.js, and a round trip at another alignment (tests/basic-drawing.test.js says more;
// basic-drawing-getput12.test.js has PMODE 1 and 2).
const { getput, tally } = require('./basic/basic-drawing-lib.js');

getput([4, 3, 0]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
