// The rule a suite's result is decided by, pure and separate from the runner so every case can be tested without
// spawning a process: what counts as a suite's summary line, and whether a finished suite passed.
//
// tests/all.js is the runner; this lives apart because one case cannot be produced by a test that spawns things --
// the timeout firing in the race between a child exiting 0 and its 'close' event arriving (see verdict below) --
// and because a rule tested only through subprocesses is a rule with untested corners.
'use strict';

// The shapes a suite's normal summary line comes in: "all passed" (and its "all <what> passed" variants, "all 6803
// welcome checks passed" included), "ok 512 checks" (cpu6309, cpu6309-timing), "127/127 SSC checks passed", and
// regress's "146/146 regression hashes match (12.3 s)" -- with its shard label when all.js runs it in shards
// ("35/35 regression hashes, shard 0/4 match"). Every suite in this repo prints one of these as its last output and
// nothing after it, which is what makes its absence mean "the suite stopped early".
//
// The count summaries must show a FULL tally, numerator equal to denominator and at least one check: a passing run
// prints "146/146", never "0/12" or "0/0". The backreference (\1) is what enforces equality -- a pattern that
// accepted any N/M would accept a suite that ran none of its checks and printed "0/12 checks passed". Only the
// FIRST pair in a line is a tally: regress's shard label ("35/35 regression hashes, shard 0/4 match") has a second,
// unrelated pair, so the pattern names it separately.
// The "all ... passed" form carries no slash in its middle: no suite prints one, and allowing it let a truncated
// "all 3/12 checks passed" slip past the equality rule -- the same shape, checked only in one spelling.
// Every pattern is anchored at both ends, so a summary followed by more text on the same line ("3/3 checks passed,
// 5 FAILED") is not read as a summary. Two tails a real suite prints are allowed by name: opcodes.test.js's
// "(126 instructions)" and asm.test.js's "(assembler and LIZA)", which names the halves its tally covers.
// What remains accepted is a line with the right shape and different words ("5/5 of 100 checks passed"); pinning
// the words would need a fixed label list that every new suite breaks, and the exit-code rule blocks the realistic
// version of that, so it is a known limit rather than a guess at the labels.
const SUMMARY = [
  /^all(?: [^/]*)? passed(?: \(\d+ instructions\))?$/,
  /^ok ([1-9]\d*) checks(?: \(\d+ instructions\))?$/,
  /^([1-9]\d*)\/\1 .*passed(?: \((?:\d+ instructions|assembler and LIZA)\))?$/,
  /^([1-9]\d*)\/\1 regression hashes(?:, shard \d+\/\d+)? (?:match|recorded) \(\d+\.\d+ s\)(?: \(\d+ instructions\))?$/,
];

// The line the check reads: the last line of stdout that is not blank.
const lastLine = (out) => out.split('\n').filter((l) => l.trim()).pop() || '';
const hasSummary = (out) => SUMMARY.some((re) => re.test(lastLine(out)));

// A finished suite's verdict. `stdout` is what the suite wrote to stdout only -- a summary goes there (console.log),
// and a warning Node writes to stderr around the same moment must not stand in for it.
//
// What this cannot decide, and neither can any reader of output: a suite that prints a summary line and then stops
// doing work. That is the opposite direction from the failure this guards (a suite that stops early never reaches
// its summary), and every suite here prints its summary after its last check.
//
// `timedOut` is not redundant with `code !== 0` even though a SIGKILLed child normally reports a null code: the
// timeout can fire in the gap between a child exiting 0 and its 'close' event arriving, and then the code is 0 and
// the suite was still killed. The rule reports that as a kill, not a pass.
function verdict({ code, timedOut, guardFailed, stdout }) {
  if (timedOut) return 'killed';
  if (code !== 0) return 'exit';                 // the suite failed, or died on a signal: its own output says why
  if (guardFailed) return 'guard';               // tests/no-exit.js caught a process.exit() the suite undid
  if (!hasSummary(stdout)) return 'no-summary';  // exited 0 with the work half done: the case this rule exists for
  return 'passed';
}

module.exports = { SUMMARY, lastLine, hasSummary, verdict };
