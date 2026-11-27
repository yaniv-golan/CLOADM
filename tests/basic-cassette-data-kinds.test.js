// Run: node tests/basic-cassette-data-kinds.test.js
//
// The clean-room BASIC's cassette data files (basic/cassette.inc, docs/clean-room-basic.md; the black-box cases
// cas-files of bb4 and cas-data2, cas-data-errors and cas-left-open of bb8): items left in
// a record dropped, OPEN "I" of machine code or a tokenised program ?FM ERROR and of a program as text read (section
// kinds); an error in PRINT #-1 shown on the screen (section errout); and the mutants of both.
// The checks and the mutants are in tests/basic/basic-cassette-lib.js (dataFileChecks, MUTANTS): each file runs a group
// of its sections on ours, in order on one machine, and the mutants of those sections, each through its section from a
// fresh machine. The rest of the cassette tests: tests/basic-cassette.test.js.
const { tally, runOurs, runMutants } = require('./basic/basic-cassette-lib.js');

runOurs(['kinds', 'errout']);
runMutants(['kinds', 'errout']);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
