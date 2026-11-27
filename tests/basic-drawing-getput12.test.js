// Run: node tests/basic-drawing-getput12.test.js
//
// The clean-room BASIC's GET and PUT (docs/clean-room-basic-p2.md sections 8 and 9) in PMODE 1 and 2, as
// basic-drawing-getput.test.js checks them in the other modes, and their errors: an array too small or not DIMmed,
// an element after GET, the wrong syntax and rectangles off the picture (tests/basic-drawing.test.js says more).
const { getput, tally } = require('./basic/basic-drawing-lib.js');

getput([1, 2], true);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
