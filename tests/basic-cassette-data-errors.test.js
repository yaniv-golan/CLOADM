// Run: node tests/basic-cassette-data-errors.test.js
//
// The clean-room BASIC's cassette data files (basic/cassette.inc, docs/clean-room-basic.md; the black-box cases
// cas-files of bb4 and cas-data2, cas-data-errors and cas-left-open of bb8): OPEN "I"
// with a name passing another file, numbers split at commas, ?FD ERROR (section named); ?FM, ?AO (the file left open),
// ?NO, ?DN and ?FM ERROR, CLOAD going ahead with a file open, OPEN to #0 and #-2 (section errors); and the mutants of
// the errors section.
// The checks and the mutants are in tests/basic/basic-cassette-lib.js (dataFileChecks, MUTANTS): each file runs a group
// of its sections on ours, in order on one machine, and the mutants of those sections, each through its section from a
// fresh machine. The rest of the cassette tests: tests/basic-cassette.test.js.
const { tally, runOurs, runMutants } = require('./basic/basic-cassette-lib.js');

runOurs(['named', 'errors']);
runMutants(['errors']);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
