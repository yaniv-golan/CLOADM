// Run: node tests/basic-lang-num.test.js [case ...]
//
// The clean-room BASIC's cases on numbers and strings (tests/basic/cases and tests/basic/own whose names begin fn-,
// num-, print-, str- or using-: the functions, number literals, PRINT and PRINT USING, the string functions): each
// is typed into a Dragon 64 running our BASIC, assembled from basic/ at test time (no ROM is used), and its transcript
// must be exactly tests/basic/expected/<case>.txt, as tests/basic-lang.test.js (which runs every other case) says; the
// black-box-only ones are only linted. Names given on the command line run only those of its cases. The runner:
// tests/basic/basic-lang-lib.js.
const { runCases, inNum, tally } = require('./basic/basic-lang-lib.js');

runCases(inNum);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
