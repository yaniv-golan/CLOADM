// Run: node tests/basic-timing.test.js
//
// The clean-room BASIC's speed against the original's, by the black-box timing probes (docs/clean-room-basic.md
// section 2, "The original's cost model"): bb10 time-literals (X= a constant of 1 to 6 digits, with 0s and a point).
// The case is run on ours as the original ran it, and every loop's count of fields must be the original's or more
// (ours is never to be faster: loops time games), and at most a few per cent more (TOL). Then mutants of the cost
// model, each of which must put some loop outside that range. The other probes: tests/basic-timing-ops.test.js
// (time-ops), basic-timing-mul.test.js (time-mul), basic-timing-fn.test.js (time-int, rnd-timing),
// basic-timing-motor.test.js (time-motor) and basic-timing-loopb.test.js (time-loopb); the shared code is
// tests/basic/basic-timing-lib.js.
const { cases, mutants, tally } = require('./basic/basic-timing-lib.js');

cases(['time-literals']);
mutants([
  ['a digit waits a tenth less', 'time-literals', 'fpconv.inc', 'LDB     #FIDLY\nFPW1', 'LDB     #FIDLY*9/10\nFPW1'],
  ['a 0 does not wait', 'time-literals', 'fpconv.inc', 'LDB     #FIZERO', 'LDB     #1'],
  ['a digit\'s wait does not hang on its bits', 'time-literals', 'fpconv.inc', 'ADDB    #FINRM', 'ADDB    #0'],
  ['the places\' quotient does not wait for its 1s', 'time-literals', 'fp.inc', '        BEQ     FD4A', '        BRA     FD4A'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
