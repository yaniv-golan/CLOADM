// Run: node tests/basic-timing-fn.test.js
//
// The clean-room BASIC's speed against the original's (docs/clean-room-basic.md section 2): bb10 time-int (INT by
// places) and bb9 rnd-timing (RND by seed and argument), every loop's count of fields the original's or up to a few
// per cent more, and mutants of INT's and RND's cost that must each put some loop outside that range
// (tests/basic-timing.test.js says more).
const { cases, mutants, tally } = require('./basic/basic-timing-lib.js');

cases(['time-int', 'rnd-timing']);
mutants([
  ['INT does not wait for its places', 'time-int', 'mathfn.inc', '        TFR     B,A             ; bb10 time-int: INT of 3.5, 1000.5, 1E6+.5 and 1E9+.5]\n        BSR     FTRW', '        TFR     B,A\n        NOP\n        NOP'],
  ['RND does not wait', 'rnd-timing', 'mathfn.inc', 'LDB     #RNDDLY', 'LDB     #1'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
