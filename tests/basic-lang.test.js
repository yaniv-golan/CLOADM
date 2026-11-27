// Run: node tests/basic-lang.test.js [case ...]
//
// The clean-room BASIC (docs/clean-room-basic.md), assembled from basic/ at test time (no ROM is used): every case in
// tests/basic/cases is typed into a Dragon 64 running it, through the keyboard matrix, and the transcript (every
// line that reached the screen, tests/basic/harness.js) must be exactly tests/basic/expected/<case>.txt, with the
// case ending normally and nothing flagged. Each expected file's first lines (#) give where its output comes from:
// [UM] the user manuals, [BB] a black-box run on the real ROM, [OWN] our own decision. Cases marked "# bb-only"
// are for the black-box run alone (the probes, and the P2 graphics and sound cases, gfx-* and snd-*, whose statements
// our ROM does not have yet: tools/basic-bb/run.js --ours runs them to the end) and are only linted here. Every case
// passes the lint (tools/basic-bb/lint.js), so the same files can be run on the real ROM.
// This part runs every case but the numbers-and-strings ones (fn-, num-, print-, str- and using-), which are
// tests/basic-lang-num.test.js's; names given on the command line run only those of its cases. The runner:
// tests/basic/basic-lang-lib.js.
const { runCases, inNum, tally } = require('./basic/basic-lang-lib.js');

runCases((name) => !inNum(name));
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
