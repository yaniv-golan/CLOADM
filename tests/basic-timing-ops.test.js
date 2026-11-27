// Run: node tests/basic-timing-ops.test.js
//
// The clean-room BASIC's speed against the original's (docs/clean-room-basic.md section 2): bb10 time-ops (PEEK, AND,
// +, STR$, VAL and READ of 32767 and 1), every loop's count of fields the original's or up to a few per cent more, and
// mutants of the cost model that must each put some loop outside that range (tests/basic-timing.test.js says more).
const { cases, mutants, tally } = require('./basic/basic-timing-lib.js');

cases(['time-ops']);
mutants([
  ['AND does not wait', 'time-ops', 'expr.inc', 'LDB     #ANDDLY', 'LDB     #1'],
  ['the conversion to an integer does not wait for its places', 'time-ops', 'fpconv.inc', 'QIW     PSHS    D\n        PULS    D', 'QIW     NOP\n        NOP'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
