// Run: node tests/basic-bb10-cas-open.test.js
//
// bb10 cas-left-open2 (tests/basic/bb/bb10-real.jsonl) replayed on the clean-room BASIC (docs/clean-room-basic.md
// sections 7, 12 and 14): OPEN "I" typed, identical to the original's record (the tape read, the transcript, the
// screens the clears wiped), and mutants of OPEN "I", each of which turns it red. The rest of bb10:
// tests/basic-bb10.test.js.
const { identical, mutants, tally } = require('./basic/basic-bb10-lib.js');

identical(['cas-left-open2']);
mutants([
  ['OPEN "I" typed without the search\'s clear and S', 'cassette.inc', '        JSR     CFIND           ; (shown as CLOAD shows it, unless in a program: CQUIET)', '        JSR     CF1', 'cas-left-open2'],
  ['OPEN "I" reads no data block', 'cassette.inc', '        BSR     CFILL           ; data block is read now [BB bb10 cas-left-open2: OPEN "I" typed, F GOOD, then f]', '        NOP\n        NOP', 'cas-left-open2'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
