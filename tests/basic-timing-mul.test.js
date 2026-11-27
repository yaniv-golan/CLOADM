// Run: node tests/basic-timing-mul.test.js
//
// The clean-room BASIC's speed against the original's (docs/clean-room-basic.md section 2): bb10 time-mul (X=Y*Z by
// the operands' bytes and bits, both ways round), every loop's count of fields the original's or up to a few per cent
// more, and mutants of the product's cost that must each put some loop outside that range (tests/basic-timing.test.js
// says more).
const { cases, mutants, tally } = require('./basic/basic-timing-lib.js');

cases(['time-mul']);
mutants([
  ['the product scans the left operand', 'time-mul', 'fp.inc', '        LDU     #FACM+4         ; FAC\'s bytes from the last', '        LDU     #ARGM+4         ; FAC\'s bytes from the last'],
  ['the product does not wait for the bits set', 'time-mul', 'fp.inc', 'ADDB    #MBIT', 'ADDB    #0'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
