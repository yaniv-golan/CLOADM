// Run: node tests/basic-drawing.test.js
//
// The clean-room BASIC's drawing statements (docs/clean-room-basic-p2.md sections 5, 6, 8 and 9): LINE (with B, BF,
// PSET / PRESET and -(x,y) from the last point), CIRCLE (radius, colour, ratio, start and end), PAINT, DRAW (every
// command, M absolute and relative, N, B, A, S, C, X var$; and =var;) and GET / PUT (every action, G). BASIC
// programs are typed into a Dragon 64 running the image assembled from basic/ at test time (no other ROM), and the
// pages in RAM are compared byte for byte with tests/basic/gfxmodel.js, whose drawing routines are written from the
// document's algorithm descriptions (Bresenham's line, the 64-chord circle, a plain breadth-first fill for PAINT, a
// DRAW interpreter, GET / PUT pixel by pixel), not from the 6809 code. Also: clipping at the picture's edges, the
// last point each statement leaves, PAINT running out of memory (?OM ERROR) on a pathological shape, GET's bytes in
// the array and GET / PUT round trips, and the errors (?FC, ?SN, ?TM). The parts (tests/basic/basic-drawing-lib.js):
//  * this file: LINE in PMODE 4, 0 and 3 (colour set 0), the errors (section 9), DRAW with spaces before numbers;
//  * basic-drawing-line.test.js: LINE in PMODE 1, 2 and 3 (colour set 1);
//  * basic-drawing-circle.test.js: CIRCLE, and PAINT running out of memory;
//  * basic-drawing-paint.test.js: PAINT on hand-built shapes, and DRAW;
//  * basic-drawing-getput.test.js: GET and PUT in PMODE 4, 3 and 0;
//  * basic-drawing-getput12.test.js: GET and PUT in PMODE 1 and 2, and their errors.
const { line, errors, spaces, tally } = require('./basic/basic-drawing-lib.js');

line([0, 1, 2]);
errors();
spaces();
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
