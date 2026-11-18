// The gate's summary check: a suite that exits 0 without printing its normal summary line has stopped part-way
// and must be failed by name. A suite that finishes normally must still pass, unchanged.
//
// The case this exists for: a suite that leaves a promise pending. Nothing keeps the event loop alive, Node drains
// it and exits 0 with the suite half done, so the exit code cannot tell it from a pass. The runner reads the
// suite's last printed line instead -- every suite here ends with a summary, so its absence is the signal.
//
// Each case runs the real tests/all.js, copied into a scratch directory beside the suite under test, with a
// timeout forced small: the scratch copy has no room for the real suites and anything it does start must not hang
// it. The real tree is only read.
// Run: node tests/allsummary.test.js
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const TESTS = path.join(__dirname);

// all.js fails any run whose regression gate is incomplete (regress.test.js missing, or its shards not covering
// every case its --count reports), so every scratch tree here holds this stand-in for it: 12 cases, split evenly
// over however many shards all.js runs it in, each shard printing the real line's shape. It keeps that rule
// switched on in every run below; the probes are then judged alongside a gate that is complete.
const STAND_IN_REGRESS = `const a = process.argv, T = 12;
if (a.includes('--count')) console.log(T + ' regression cases');
else {
  const s = a.includes('--shard') ? a[a.indexOf('--shard') + 1] : null, k = T / (s ? Number(s.split('/')[1]) : 1);
  console.log(k + '/' + k + ' regression hashes' + (s ? ', shard ' + s : '') + ' match (0.0 s)');
}
`;
const standInRegress = (tests) => fs.writeFileSync(path.join(tests, 'regress.test.js'), STAND_IN_REGRESS);

// Copy the runner and the no-exit guard into a scratch tests/ directory, add `body` as zz-probe.test.js, run it,
// and hand back the exit status and merged output. `timeoutMs` shortens the per-suite kill so a probe that hangs
// is caught quickly rather than after the real 4 minutes; it also checks that a killed suite reads as a failure.
function gate(body, { name = 'zz-probe.test.js', timeoutMs = 60000, regress } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-'));
  const tests = path.join(dir, 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.copyFileSync(path.join(TESTS, 'all.js'), path.join(tests, 'all.js'));
  fs.copyFileSync(path.join(TESTS, 'no-exit.js'), path.join(tests, 'no-exit.js'));
  fs.copyFileSync(path.join(TESTS, 'suite-verdict.js'), path.join(tests, 'suite-verdict.js'));
  if (regress === null) { /* no regress.test.js at all */ } else if (regress === undefined) standInRegress(tests);
  else fs.writeFileSync(path.join(tests, 'regress.test.js'), regress);
  if (body !== null) fs.writeFileSync(path.join(tests, name), body);
  const r = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '1'],
    { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { CLOADM_SUITE_TIMEOUT_MS: String(timeoutMs) }) });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const failedAs = (r, name) => r.status !== 0 && new RegExp(`FAIL  ${name.replace(/[.]/g, '\\.')}`).test(r.out);

// 1. The fixture, under an ordinary suite name: it exits 0 with its work half done and must be failed.
{
  const body = fs.readFileSync(path.join(TESTS, 'fixture-stops-early.test.js'), 'utf8');
  const r = gate(body);
  check('a suite that stops part-way and exits 0 is failed by the gate', failedAs(r, 'zz-probe.test.js'),
    r.status === 0 ? 'the gate exited 0' : r.out.split('\n').filter((l) => /zz-probe/.test(l)).slice(0, 3).join(' | '));
  check('...and the run says why: no summary line printed', /without printing its summary line/.test(r.out));
  check('...and the run summary counts it', /1 of 2 suites FAILED/.test(r.out),
    (r.out.match(/.*suites FAILED.*/) || [''])[0].trim());
  // The control: the SAME body with the summary reached (the promise resolves) passes, so the failure above is
  // the missing summary and not the fixture's content, the scratch tree, or the forced timeout.
  const ok = gate(body.replace('await new Promise(() => {});', 'await Promise.resolve();'));
  check('the same suite passes once it reaches its summary', ok.status === 0, `exit ${ok.status}`);
}

// 1b. The regression-gate rule itself: every suite below passes and exits 0, yet a run whose regression gate is
// incomplete must fail, whichever way it is incomplete. Each probe is paired with the complete stand-in (the control
// every other case here runs with), so the failure is the gate's completeness and nothing else.
{
  const pass = "console.log('ok   first');\nconsole.log('all passed');\n";
  const INCOMPLETE = /all \d+ suites exited 0, but the regression gate is incomplete: FAILED/;
  // its shards report fewer cases than its own --count (12 each time, 11 run)
  const fewer = gate(pass, { regress: STAND_IN_REGRESS.replace("k = T / (s ? Number(s.split('/')[1]) : 1);", "k = T / (s ? Number(s.split('/')[1]) : 1) - 1;") });
  check('a regression gate whose shards ran fewer cases than --count fails the run', fewer.status !== 0 && /-- INCOMPLETE/.test(fewer.out) && INCOMPLETE.test(fewer.out),
    `exit ${fewer.status}: ${(fewer.out.match(/^regress .*/m) || [''])[0]}`);
  // no regress.test.js at all
  const none = gate(pass, { regress: null });
  check('a run with no regress.test.js fails, saying the regression gate did not run', none.status !== 0 && /regression gate did not run/.test(none.out) && INCOMPLETE.test(none.out),
    `exit ${none.status}: ${(none.out.match(/^regress.*/m) || [''])[0]}`);
  // the control: the same passing suite beside the complete stand-in passes, so the two failures above are the gate
  const whole = gate(pass);
  check('the same suite beside a complete regression gate passes', whole.status === 0 && /regress 12\/12 included/.test(whole.out), `exit ${whole.status}`);
}

// 2. A suite that finishes normally still passes, in every summary shape the real suites print. The regress shard
// form is one of them: all.js runs regress as four shards on a multi-core machine, and each shard's line carries
// its shard label, so a pattern that only accepted the unsharded line failed the gate on every machine with 4+
// cores while passing on a laptop with 2. It is pinned here for that reason.
{
  const shapes = [
    ["console.log('ok   first');", "console.log('all passed');"],
    ["console.log('ok   first');", "console.log('127/127 SSC checks passed');"],
    ["console.log('ok   first');", "console.log('ok 512 checks');"],
    ["console.log('ok   first');", "console.log('109/109 checks passed (assembler and LIZA)');"],
    ["console.log('ok   first');", "console.log('146/146 regression hashes match (12.3 s)');"],
    ["console.log('ok   first');", "console.log('35/35 regression hashes, shard 0/4 match (34.8 s)');"],
  ];
  const bad = [];
  for (const lines of shapes) {
    const r = gate(lines.join('\n') + '\nprocess.exitCode = 0;\n');
    if (r.status !== 0) bad.push(`${lines[1]} -> exit ${r.status}`);
  }
  check('every summary shape a suite here prints still passes', bad.length === 0, bad.join('; '));
}

// 2b. A count summary must be a FULL tally. A suite that ran none of its checks and printed "0/12 checks passed"
// (from an exit handler, say, after a pending promise drained the loop) used to pass: the pattern took any N/M.
// A passing run prints N/N, so numerator = denominator and at least one check is required. Found by an
// adversarial review that fed exactly these lines through the runner.
{
  const truncated = ["0/12 checks passed", "0/0 checks passed", "12/127 checks passed", "ok 0 checks",
    "12/127 regression hashes match (1.0 s)", "all 3/12 checks passed", "all 0/500 checks passed",
    "12/12 checks passed, 5 FAILED", "ok 512 checks and 900 were skipped"];
  const bad = [];
  for (const line of truncated) {
    const r = gate(`console.log('${line}');\n`);
    if (r.status === 0) bad.push(line);
  }
  check('a truncated count summary, or one with text after it, is not a pass', bad.length === 0, bad.join('; '));
  // the two forms a real suite ends with that are not a bare tally: the instruction count opcodes.test.js adds, and
  // the shard label regress adds. Both must still pass, so the anchors above do not reject real output.
  const tails = [["console.log('126/126 checks passed (126 instructions)');", 'an instruction-count tail'],
    ["console.log('35/35 regression hashes, shard 0/4 match (3.4 s)');", 'a shard label']];
  const rejected = [];
  for (const [body, what] of tails) {
    if (gate(body + '\n').status !== 0) rejected.push(what);
  }
  check('a count line with a real suite\'s tail (instructions, shard) still passes', rejected.length === 0, rejected.join('; '));
  // the control: the full tally of the same shape passes, so the rejection is the count and not the shape
  const full = gate("console.log('12/12 checks passed');\n");
  check('...and the full tally of that shape passes', full.status === 0, `exit ${full.status}`);
}

// 2c. No FAILURE line may read as a summary. asm.test.js builds its failure line from a count, and the first form
// counted the checks that PASSED ("108/109 assembler checks failed" for one failure) -- the wrong number where a
// reader looks for the failures.
//
// This runs asm's REAL failure branch, not a copy of its strings: the source is read, its failure branch is lifted
// out, and it is evaluated with fail/n/ok set to what a one-check failure gives. A hardcoded list of the strings
// would pass no matter what the branch did -- the first version of this check did exactly that and survived both
// mutations (wrong count restored; the line rewritten to read as a pass).
{
  const src = fs.readFileSync(path.join(TESTS, 'asm.test.js'), 'utf8');
  const branch = /\n(if \(fail \|\| !ok\) \{[\s\S]*?\n\} else console\.log\([^\n]*\);)/.exec(src);
  check('asm\'s summary branch is found in its source', !!branch, branch ? '' : 'the if (fail || !ok) block was not found');
  // run the branch with a one-check failure (fail 1 of n 109), the LIZA half good, collecting what it prints
  let printed = [];
  const runBranch = (failN, okFlag) => {
    printed = [];
    const fakeLog = (...a) => printed.push(a.join(' '));
    new Function('fail', 'n', 'ok', 'console', branch[1])(failN, 109, okFlag, { log: fakeLog });
    return printed.join('\n');
  };
  const oneFail = runBranch(1, true);
  const { SUMMARY: pats } = require('./suite-verdict.js');
  const isSummary = (line) => pats.some((re) => re.test(line));
  // (a) the count is the failures, not the passes: one failure in 109 says "1/109", never "108/109"
  check('asm\'s failure count is the failures, not the passes', /^1\/109 assembler checks failed/.test(oneFail) && !/\b108\//.test(oneFail), oneFail);
  // (b) no line it prints on failure matches a summary pattern -- for every combination its flags allow
  const leaks = [];
  for (const [f, ok] of [[1, true], [0, false], [1, false]]) {
    for (const line of runBranch(f, ok).split('\n')) if (isSummary(line)) leaks.push(`fail=${f} ok=${ok}: ${line}`);
  }
  check('asm\'s failure lines cannot match a summary pattern', leaks.length === 0, leaks.join(' | '));
  // (c) through the real runner, exit 0: the worst case, where the exit code cannot fail it either
  const r = gate(`console.log(${JSON.stringify(oneFail)});\n`);
  check('...and a suite whose last line is that failure line is failed by the gate', r.status !== 0,
    r.status === 0 ? 'the gate exited 0' : '');
}

// 3. A summary printed EARLY and then buried by a crash is not a pass: the runner reads the last line, so a suite
// whose remaining output follows its summary cannot slip through.
{
  const r = gate("console.log('all passed');\nconsole.log('FAIL later work exploded');\nprocess.exitCode = 0;\n");
  check('a summary followed by more output is not a pass', failedAs(r, 'zz-probe.test.js'),
    r.status === 0 ? 'the gate exited 0' : '');
}

// 4. A suite that fails normally is still failed as it was, with its own exit code and output (the summary check
// must not be the thing that catches ordinary failures, or a real failure's tail is lost).
{
  const r = gate("console.log('FAIL a real check');\nconsole.log('1 FAILED');\nprocess.exitCode = 1;\n");
  check('an ordinary failure is still failed and its own output shown', failedAs(r, 'zz-probe.test.js') && /FAIL a real check/.test(r.out),
    `exit ${r.status}`);
  // A suite that fails and prints no summary at all is still a failure for its own reason -- it must not be
  // described as a suite that stopped early, which would misreport what happened (its exit code already failed it).
  const silent = gate("console.log('FAIL a real check');\nprocess.exitCode = 1;\n");
  check('a failing suite with no summary is failed, and not called a suite that stopped early',
    failedAs(silent, 'zz-probe.test.js') && !/without printing its summary line/.test(silent.out),
    silent.status === 0 ? 'the gate exited 0' : (silent.out.match(/exited .*/) || [''])[0].trim());
}

// 5. The verdict rule itself, called directly. Two of its cases cannot be produced by spawning a suite: the
// timeout firing in the race between a child exiting 0 and its 'close' event arriving (the code is 0 and the suite
// was still killed), and a guard failure (the exit guard's FAIL line with the suite having undone its exitCode).
// Those are why the rule is a pure function in tests/suite-verdict.js rather than code inline in the runner, and
// they are tested here so no branch of it is unreachable and untested.
{
  const { verdict } = require('./suite-verdict.js');
  const cases = [
    ['a suite that finished and printed its summary passes', { code: 0, timedOut: false, guardFailed: false, stdout: 'ok x\nall passed\n' }, 'passed'],
    ['a suite that exited 0 with no summary stopped early', { code: 0, timedOut: false, guardFailed: false, stdout: 'ok x\n' }, 'no-summary'],
    ['a suite that exited non-zero is a failure, not a stopped-early one', { code: 1, timedOut: false, guardFailed: false, stdout: '3 FAILED\n' }, 'exit'],
    ['the exit guard catches a suite that undid its own exitCode', { code: 0, timedOut: false, guardFailed: true, stdout: 'all passed\n' }, 'guard'],
    // the race: killed between exiting 0 and 'close'. code is 0, so only timedOut can tell this from a pass.
    ['a kill that fires after the child exited 0 is not a pass', { code: 0, timedOut: true, guardFailed: false, stdout: 'all passed\n' }, 'killed'],
    ['a kill of a suite with no summary is a kill, not a stopped-early pass', { code: 0, timedOut: true, guardFailed: false, stdout: '' }, 'killed'],
    ['a signal death has no code and is a failure', { code: null, timedOut: false, guardFailed: false, stdout: '' }, 'exit'],
  ];
  const wrong = [];
  for (const [name, input, want] of cases) {
    const got = verdict(input);
    if (got !== want) wrong.push(`${name}: got ${got}, want ${want}`);
  }
  check('the verdict rule: every case, including the timeout race', wrong.length === 0, wrong.join('; '));

  // ...and the timedOut branch is the one that would otherwise be dead code. Removing it must change the race case,
  // which is what makes this a test of the rule and not a restatement of it.
  const { lastLine } = require('./suite-verdict.js');
  check('the summary is read from the LAST line, not any line', lastLine('all passed\nok x\n') === 'ok x'
    && lastLine('ok x\n\nall passed\n\n') === 'all passed', JSON.stringify(lastLine('all passed\nok x\n')));
}

// 5b. A suite that prints a summary-shaped line MID-RUN and then stops must fail. This is the hole found against an
// earlier commit: a real suite (asm.test.js) printed a tally partway through, and truncating the file there made it
// pass. The fixture below is that shape in miniature; the runner reads the LAST line, so the earlier one does not
// count. (asm itself is held to having one summary by the static check in section 7.)
{
  const body = "console.log('7/7 assembler checks passed');\n"                       // summary-shaped, mid-run
    + "console.log('working...');\n"
    + "(async () => { await new Promise(() => {}); console.log('all passed'); })();\n";
  const r = gate(body);
  check('a mid-run summary-shaped line does not let a suite that stops early pass', failedAs(r, 'zz-probe.test.js'),
    r.status === 0 ? 'the gate exited 0' : '');
  check('...and it is reported as a stopped-early suite', /without printing its summary line/.test(r.out));
  // the control: the same suite with the summary LAST passes, so what fails it above is the order, not the content
  const ok = gate("console.log('working...');\nconsole.log('7/7 assembler checks passed');\n");
  check('...and the same line as the LAST line passes', ok.status === 0, `exit ${ok.status}`);
}

// 5c. A suite killed for hanging is a failure for the timeout reason, not reported as a missing summary (one reason
// per failure, so the output says what actually happened).
{
  const r = gate("console.log('ok   first');\nsetInterval(() => {}, 1000);\n", { timeoutMs: 2000 });
  check('a suite killed for hanging fails, and the run says it was killed', failedAs(r, 'zz-probe.test.js') && /killed after 2 s/.test(r.out),
    r.status === 0 ? 'the gate exited 0' : (r.out.match(/killed after.*/) || [''])[0].trim());
  check('...and is not reported as a missing summary', !/without printing its summary line/.test(r.out));
}

// 6. The fixture is not in the gate's file list. A runner run over a directory that DOES hold a fixture must
// report only the stand-in regress suite and exit 0 -- the fixture neither run nor failed. The fixture is copied in under its own name,
// exactly where it sits in the real tree, so the exclusion is what keeps it out and nothing else.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-'));
  const tests = path.join(dir, 'tests');
  fs.mkdirSync(tests, { recursive: true });
  for (const f of ['all.js', 'no-exit.js', 'suite-verdict.js', 'fixture-stops-early.test.js']) fs.copyFileSync(path.join(TESTS, f), path.join(tests, f));
  standInRegress(tests);
  const r = cp.spawnSync(process.execPath, [path.join(tests, 'all.js')], { encoding: 'utf8', timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const out = (r.stdout || '') + (r.stderr || '');
  check('fixture-*.test.js files are left out of the gate', r.status === 0 && /all 1 suites passed/.test(out),
    (out.match(/.*suites.*/) || [''])[0].trim());
}

// 6b. The summary is read from stdout alone: a suite that warns on stderr after printing its summary has still
// finished, and must pass. Node emits warnings asynchronously on stderr (process warnings at exit among them), so
// a run that reads the two streams as one can see a warning as its "last line" and fail a healthy suite. Nothing
// is lost to a reader by this: the streams are joined again for the failure tail, which is checked here too.
{
  const r = gate("console.log('all passed');\nconsole.error('(node:1) ExperimentalWarning: something');\n");
  check('a warning on stderr after the summary does not fail the suite', r.status === 0, `exit ${r.status}`);
  // a failing suite's stderr still reaches the tail a reader sees (stderr is kept, only not read as the summary)
  const f = gate("console.error('FAIL written to stderr');\nconsole.log('1 FAILED');\nprocess.exitCode = 1;\n");
  check('...and a failing suite\'s stderr is still shown', /FAIL written to stderr/.test(f.out), f.status === 0 ? 'the gate exited 0' : '');
}

// 6c. Sharded suites go through the same spawnSuite (all.js runs regress as four shards on 4+ cores), so a shard
// that stops part-way must fail the suite too -- and a healthy shard's line, which carries its shard label, must
// pass. A pattern that accepted only the unsharded line failed the gate on every multi-core machine while passing
// on a small one; pinning the label form here is what keeps that from returning.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-'));
  const tests = path.join(dir, 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.copyFileSync(path.join(TESTS, 'all.js'), path.join(tests, 'all.js'));
  fs.copyFileSync(path.join(TESTS, 'no-exit.js'), path.join(tests, 'no-exit.js'));
  fs.copyFileSync(path.join(TESTS, 'suite-verdict.js'), path.join(tests, 'suite-verdict.js'));
  // the runner, with the probe suite sharded, so the ordinary shard machinery spawns it
  const runner = fs.readFileSync(path.join(TESTS, 'all.js'), 'utf8')
    .replace("const SHARDS = { 'regress.test.js':", "const SHARDS = { 'zz-shardprobe.test.js': 2, 'regress.test.js':");
  fs.writeFileSync(path.join(tests, 'all.js'), runner);
  standInRegress(tests);
  // a shard that prints the real regress line and finishes: the suite passes
  fs.writeFileSync(path.join(tests, 'zz-shardprobe.test.js'),
    "const i = process.argv[process.argv.indexOf('--shard') + 1] || '0/1';\nconsole.log(`9/9 regression hashes, shard ${i} match (1.0 s)`);\n");
  const ok = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '2'], { encoding: 'utf8', timeout: 120000 });
  const okOut = (ok.stdout || '') + (ok.stderr || '');
  check('a healthy shard\'s summary line, with its shard label, passes', ok.status === 0,
    ok.status === 0 ? '' : okOut.split('\n').filter((l) => /zz-shardprobe|summary/.test(l)).slice(0, 2).join(' | '));
  // a shard that stops part-way (one shard silent) fails the suite
  fs.writeFileSync(path.join(tests, 'zz-shardprobe.test.js'),
    "const i = process.argv[process.argv.indexOf('--shard') + 1] || '0/1';\nif (i === '0/2') console.log(`9/9 regression hashes, shard ${i} match (1.0 s)`);\n");
  const bad = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '2'], { encoding: 'utf8', timeout: 120000 });
  const badOut = (bad.stdout || '') + (bad.stderr || '');
  check('a shard that stops part-way fails the sharded suite', bad.status !== 0 && /FAIL  zz-shardprobe\.test\.js/.test(badOut),
    bad.status === 0 ? 'the gate exited 0' : '');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. The summary list is not vacuous for the real suites: every suite in this repo prints ONE summary line the
// runner accepts, and no second summary-shaped line anywhere.
//
// Read from each file rather than by running them (that is the gate's job). The reader is deliberately blunt about
// what "prints a summary" means: it takes the STRINGS AND TEMPLATES in every console.log / process.stdout.write call,
// joins a call's arguments with a space (console.log(a, b) prints "a b"), fills each ${...} with the number a PASSING
// run gives it ("7", and both halves of a `${X}/${X}` tally get the same 7, so the numerator equals the denominator
// the way a pass prints it), and asks whether the result matches a summary pattern. That covers the two writers a
// suite could use and any number of arguments -- an earlier version looked only at single-quoted strings inside
// console.log( lines, so a summary printed with stdout.write, or as a second console.log argument, was invisible
// while the gate accepted it: a blind spot the check's own comment denied. Both were reproduced before this was
// rewritten.
//
// Why ONE matters: a summary-shaped line partway through a suite is what let a truncation pass the gate once
// (asm.test.js printed a tally at line 126 and the file stopped there -- it passed on eb06896). So a suite may have
// exactly one summary-shaped output, wherever it sits; a second one anywhere is reported. Nineteen suites end with a
// crash handler line (eleven of them log from it), and those print only on a crash: they are not summaries, and the
// reader treats them as the non-summaries they are.
//
// Exemptions, each with what still holds it:
//  * regress.test.js builds its line from a label variable, so a static read sees "7/7 7 7 (7 s)": no word in the
//    source it can see. Its shape is pinned by the runner's last pattern and exercised by every gate run, sharded.
//  * allsummary.test.js and exitguard.test.js hold whole SUITE BODIES in strings to feed the runner, so a static read
//    of the FILE cannot tell what the suite prints from what it feeds a probe. They are held by the gate's own run
//    and by their own checks; and they are held here to the one thing that is readable: their own final summary.
{
  const STATIC_EXEMPT = {
    'regress.test.js': 'its summary is assembled from the shard label variable',
    'allsummary.test.js': 'it holds probe suite bodies in strings, several of which print a summary',
    'exitguard.test.js': 'it holds probe suite bodies in strings, several of which print a summary',
  };
  const { SUMMARY: pats } = require('./suite-verdict.js');
  check('the runner\'s summary patterns are readable', Array.isArray(pats) && pats.length >= 4 && pats.every((p) => p instanceof RegExp),
    `${pats.length} pattern(s)`);

  // One call per LINE: every line that makes a console.log / process.stdout.write call contributes what that
  // call can print. Line-scoped on purpose -- a call's whole span matched with [\s\S] can swallow the lines
  // between two calls and lose them, which an earlier version of this reader did (every suite read as having no
  // summary). Every call in this repo is written on one line; a call split across lines is not seen, which is
  // stated here rather than pretended away.
  const PRINT = /\b(?:console\.log|process\.stdout\.write)\s*\(/;
  const prints = (src) => {
    const out = [];
    for (const line of src.split('\n')) {
      if (!PRINT.test(line)) continue;
      // the arguments' string and template literals, joined by a space (console.log(a, b) prints "a b"); a bare
      // identifier contributes nothing readable and is left out
      const parts = [...line.matchAll(/'([^']*)'|`([^`]*)`/g)]
        .map((x) => (x[1] ?? x[2]).replace(/\$\{[^}]*\}/g, '7').replace(/\\n/g, '\n'));
      if (parts.length) out.push(parts);
    }
    return out;
  };
  // a call prints its arguments in order, so "what it can print" is any ONE of them (console.log(a ? x : y, b)
  // prints one of the branches and then b) and also their join (console.log(a, b) prints "a b"). Either may be
  // the summary; matching on both is what makes a multi-argument summary visible instead of invisible.
  const norm = (t) => t.replace(/^\s+/, '').replace(/\s+$/, '');
  const isSummaryArgs = (parts) => pats.some((re) => parts.some((t) => re.test(norm(t))) || re.test(norm(parts.join(' '))));

  const suites = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js') && !f.startsWith('fixture-'));
  const missing = [], ambiguous = [], exemptBad = [];
  for (const f of suites) {
    const src = fs.readFileSync(path.join(TESTS, f), 'utf8');
    const all = prints(src);
    const shaped = all.filter(isSummaryArgs);
    if (STATIC_EXEMPT[f]) {
      // not skipped: an exempt file is still held to its own final summary, which is readable for the two guards.
      // What this does NOT give them is the "exactly one" rule above -- their bodies hold probe suites that print
      // summaries on purpose, so a truncation of one of these files could still end on a probe body's line and pass
      // here. Both are guard suites whose contents are exercised by their own checks and by the gate's own run on
      // every commit, so that is the cover they have; it is not the same guarantee as the rule above, and the
      // comment says so rather than implying it.
      if (f === 'regress.test.js') continue;         // its own line is unreadable here (see the exemption)
      const last = all[all.length - 1];
      if (!last || !isSummaryArgs(last)) exemptBad.push(`${f}: its last printed text is not a summary`);
      continue;
    }
    if (shaped.length === 0) missing.push(`${f}: no summary-shaped output`);
    else if (shaped.length > 1) ambiguous.push(`${f}: ${shaped.length} summary-shaped outputs`);
  }
  check('every suite has exactly one summary-shaped output', ambiguous.length === 0, ambiguous.join(' | '));
  check('every suite prints a line the runner accepts as its summary', missing.length === 0, missing.join(' | '));
  check('every exempt suite still ends with a summary line', exemptBad.length === 0, exemptBad.join(' | '));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
