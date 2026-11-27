// Run: node tests/basic-drawing-paint.test.js
//
// The clean-room BASIC's PAINT and DRAW (docs/clean-room-basic-p2.md sections 5 and 6): PAINT on ten hand-built shapes
// in every PMODE against a breadth-first fill, and up to another colour; DRAW (every command, M, N, B, A, S, C, X
// var$; and =var;) in PMODE 4, 3 and 0 against the interpreter in tests/basic/gfxmodel.js, with the last point, angle
// and scale after (tests/basic-drawing.test.js says more).
const { paint, draw, tally } = require('./basic/basic-drawing-lib.js');

paint();
draw();
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
