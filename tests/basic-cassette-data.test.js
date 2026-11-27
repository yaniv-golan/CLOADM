// Run: node tests/basic-cassette-data.test.js
//
// The clean-room BASIC's cassette data files (basic/cassette.inc, docs/clean-room-basic.md; the black-box cases
// cas-files of bb4 and cas-data2, cas-data-errors and cas-left-open of bb8): the hand-derived records
// checked against the original's data hash; OPEN "O" / PRINT #-1 / CLOSE write a type-1 namefile, the records and an
// end-of-file block, the motor run three times; OPEN "I" / INPUT #-1 / LINE INPUT #-1 / EOF(-1) read them back with
// the screen untouched, ?IE ERROR past the end; the forms without #, ?NO and ?ID ERROR (sections write, read, forms),
// and the mutants of the write section.
// The checks and the mutants are in tests/basic/basic-cassette-lib.js (dataFileChecks, MUTANTS): each file runs a group
// of its sections on ours, in order on one machine, and the mutants of those sections, each through its section from a
// fresh machine. The rest of the cassette tests: tests/basic-cassette.test.js.
const { check, tally, FILEDATA, REAL_SHA, sha, runOurs, runMutants } = require('./basic/basic-cassette-lib.js');

check('data file: the hand-derived records have the original\'s data hash', sha(FILEDATA) === REAL_SHA && FILEDATA.length === 35);
runOurs(['write', 'read', 'forms']);
runMutants(['write']);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
