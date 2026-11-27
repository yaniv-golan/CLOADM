// Run: node tests/basic-cassette-data-read.test.js
//
// The clean-room BASIC's cassette data files (basic/cassette.inc, docs/clean-room-basic.md; the black-box cases
// cas-files of bb4 and cas-data2, cas-data-errors and cas-left-open of bb8): the mutants of
// the read and forms sections (whose checks on ours are in tests/basic-cassette-data.test.js), each reading the tape
// our ROM writes in the write section.
// The checks and the mutants are in tests/basic/basic-cassette-lib.js (dataFileChecks, MUTANTS): each file runs a group
// of its sections on ours, in order on one machine, and the mutants of those sections, each through its section from a
// fresh machine. The rest of the cassette tests: tests/basic-cassette.test.js.
const { tally, ourTape, runMutants } = require('./basic/basic-cassette-lib.js');

runMutants(['read', 'forms'], ourTape());
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
