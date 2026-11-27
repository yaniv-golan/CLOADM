// Run: node tests/basic-bb10.test.js
//
// The clean-room BASIC (assembled at test time) against the original's black-box records of batch bb10
// (tests/basic/bb/bb10-real.jsonl), replayed on ours through the black-box harness and compared as
// tools/basic-bb/compare.js compares them (docs/clean-room-basic.md sections 7, 12 and 14). This part:
//  * cas-close-pending, cas-prog-display: identical: the blocks written (the leader counts the tape decoder reads, the
//    namefiles' fields, the data's hashes), the motor's runs within a field, the transcripts and the screens the
//    clears wiped;
//  * mutants, each of which turns cas-close-pending red.
// The other bb10 cases: tests/basic-bb10-cas-timing.test.js, basic-bb10-cas-open.test.js, basic-bb10-cas-ascii.test.js,
// basic-bb10-scr.test.js and basic-bb10-sound.test.js (the shared code: tests/basic/basic-bb10-lib.js).
const { identical, mutants, tally } = require('./basic/basic-bb10-lib.js');

identical(['cas-close-pending', 'cas-prog-display']);
mutants([
  ['no pause before a block (the decoder keeps every leader)', 'cassette.inc', '        EXG     A,A             ; 8', '        NOP', 'cas-close-pending'],
  ['a leader of 255 $55 before the block\'s own', 'cassette.inc', '        CLRB                    ; the leader: 256 $55 bytes', '        LDB     #255', 'cas-close-pending'],
  ['a data byte written no slower than the leader\'s', 'cassette.inc', 'CW3     PSHS    B               ; a data byte: 36 cycles more than the type\'s and the length\'s\n        NOP\n        MUL\n        MUL\n        PULS    B', 'CW3     NOP', 'cas-close-pending'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
