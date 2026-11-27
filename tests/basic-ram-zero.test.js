// Run: node tests/basic-ram-zero.test.js
//
// The mutants of the clean-room BASIC's wait for a 0 in a number (FIN, fpconv.inc): a tenth more and a tenth less,
// each of which must take one of ram-pointers2's eight timing loops out of the original's count .. +2 fields
// (tests/basic-ram-loops.test.js checks the loops themselves; tests/basic-ram.test.js says more).
const { tally, loopMutants } = require('./basic/basic-ram-lib.js');

loopMutants([
  ['a 0 waits a tenth more', 'LDB     #FIZERO', 'LDB     #FIZERO*11/10'],
  ['a 0 waits a tenth less', 'LDB     #FIZERO', 'LDB     #FIZERO*9/10'],
]);

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
