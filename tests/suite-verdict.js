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
const hasSummary = (out) => SUMMARY.some((re) => re.test(lastLine(liveOutput(out))));

// What a suite printed while it was still RUNNING: everything before the first NUL. The NUL is written by
// tests/no-exit.js, and only by the suite's OWN process and only into its own stdout, so any NUL means that process
// reached a shutdown event before that byte. That makes the cut safe wherever the marker lands -- including mid-line,
// which is where it lands when the last live write had no trailing newline (`process.stdout.write('working')`).
// Cutting only at a line-initial NUL (an earlier version) let exactly that case pass a suite that stopped part-way.
//
// The limit this does not fix, stated because it is real: a suite that echoes a guarded CHILD's output written with
// stdio 'inherit' shares fd 1, so the child's marker reaches the parent's stream and truncates it -- a healthy suite
// then reads as having printed no summary while running. No suite here does that (a captured child gets its own pipe
// and its marker never reaches the parent), and moving the marker to a separate fd would fix it at the cost of a
// second pipe in every spawn; that is the trade this takes today.
// The tail a reader sees keeps the marked text: see `tail` below.
const NUL = '\u0000';
const liveOutput = (out) => { const i = out.indexOf(NUL); return i < 0 ? out : out.slice(0, i); };
// A suite's output for the failure tail: the shutdown marker removed, everything kept -- a suite's own "FAIL the
// test did not finish" from an exit handler is a failure reason a reader must still see.
const tail = (out) => out.split(NUL).join('');

// A line that starts "FAIL " on STDOUT is a failure line, in the one shape every suite and both guards use
// ("FAIL <what> [<detail>]", tests/allsummary.test.js section 7c), so a suite cannot fail by printing one and
// exit 0. It is read from the WHOLE output, shutdown-time lines included: a suite that reports a failure while
// shutting down (its crash handler's "FAIL the test did not finish") has still reported one, and no real suite
// prints a FAIL line on a passing run -- measured over every suite here, none printed one, tests/allsummary.test.js
// section 7c holds it.
// What it cannot catch: a FAIL written to stderr (the verdict is given stdout alone, because stderr carries Node's
// warnings), a failure worded any other way ("12/12 checks failed; all passed"), and near-misses like "FAILED: x" --
// the exact shape "FAIL " is what the suites and both guards print, so this is the shape the gate reads.
const FAIL_LINE = /^FAIL /m;
const hasFailureLine = (out) => FAIL_LINE.test(tail(out));

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
//
// Order matters. The guard and a failure line are decided FIRST: a suite that printed "FAIL ..." has failed whatever
// else it printed or exited with, and calling it "stopped early" would misdescribe a suite that failed on purpose.
// Only a suite that printed no failure line is asked for its summary, and only from its live output.
function verdict({ code, timedOut, guardFailed, stdout }) {
  if (timedOut) return 'killed';
  if (guardFailed) return 'guard';               // tests/no-exit.js caught a process.exit() the suite undid
  if (code !== 0) return 'exit';                 // the suite failed, or died on a signal: its own output says why
  if (hasFailureLine(stdout)) return 'failed';   // exited 0 after printing "FAIL ..." (an exit handler reset it)
  if (!hasSummary(stdout)) return 'no-summary';  // exited 0 with the work half done: the case this rule exists for
  return 'passed';
}

module.exports = { SUMMARY, lastLine, hasSummary, liveOutput, tail, FAIL_LINE, hasFailureLine, verdict };
