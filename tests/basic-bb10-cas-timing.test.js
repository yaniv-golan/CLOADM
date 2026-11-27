// Run: node tests/basic-bb10-cas-timing.test.js
//
// bb10 cas-timing (tests/basic/bb/bb10-real.jsonl) replayed on the clean-room BASIC (docs/clean-room-basic.md sections
// 7, 12 and 14): identical to the original's record (the blocks written, the motor's runs within a field, the
// transcript), no block written faster, and mutants of the cassette's waits, each of which turns it red. The rest of
// bb10: tests/basic-bb10.test.js.
const { identical, mutants, tally } = require('./basic/basic-bb10-lib.js');

identical(['cas-timing']);
mutants([
  ['no wait after the motor starts to read', 'cassette.inc', 'CRBLK   BSR     CMSTD', 'CRBLK   JSR     CASON', 'cas-timing'],
  ['a character to the tape at the old pace', 'cassette.inc', 'CTDLY   EQU     11 ', 'CTDLY   EQU     36 ', 'cas-timing'],
  ['a record read with no wait', 'cassette.inc', 'CRDDLY  EQU     245 ', 'CRDDLY  EQU     1 ', 'cas-timing'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
