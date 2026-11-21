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
function gate(body, { name = 'zz-probe.test.js', timeoutMs = 60000, regress, args = [], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-'));
  const tests = path.join(dir, 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.copyFileSync(path.join(TESTS, 'all.js'), path.join(tests, 'all.js'));
  fs.copyFileSync(path.join(TESTS, 'no-exit.js'), path.join(tests, 'no-exit.js'));
  fs.copyFileSync(path.join(TESTS, 'suite-verdict.js'), path.join(tests, 'suite-verdict.js'));
  if (regress === null) { /* no regress.test.js at all */ } else if (regress === undefined) standInRegress(tests);
  else fs.writeFileSync(path.join(tests, 'regress.test.js'), regress);
  if (body !== null) fs.writeFileSync(path.join(tests, name), body);
  for (const [n, b] of Object.entries(extra)) fs.writeFileSync(path.join(tests, n), b);
  const r = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '1', ...args],
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

// 1d. `regress.test.js --count` that never answers must FAIL the run, not hang it. `regressIncluded()` used to call
// execFileSync with no timeout, so a child that never exited left the gate waiting forever (the whole machine's gate
// queue was held by one such child). The gate now kills it and fails, naming the child.
//
// The probe's own bound is the point: the stand-in never exits, so a regression here would hang THIS suite. The
// runner is therefore spawned with a hard timeout AND its own process group (so the kill reaches every descendant),
// and the test asserts the gate reported the kill -- "did not answer within N ms and was killed" -- rather than
// merely that something failed. N comes from CLOADM_REGRESS_COUNT_TIMEOUT_MS, set low here (1500 ms; the real
// --count answers in about 55 ms, see tests/all.js).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-count-'));
  const t = path.join(dir, 'tests'); fs.mkdirSync(t, { recursive: true });
  for (const f of ['all.js', 'no-exit.js', 'suite-verdict.js']) fs.copyFileSync(path.join(TESTS, f), path.join(t, f));
  // A stand-in whose --count never answers, and which spawns its own child, to prove the kill reaches descendants.
  // The token reaches every process this probe can start: it is set in the environment below, all.js copies its
  // environment into every child it spawns (guardEnv), the stand-in reads it from there, and it puts it in ITS
  // child's argv -- so an orphaned --count child (ppid 1) is found by `pgrep -f TOKEN` even though its own argv is
  // only the file path. The temp dir's name is swept too, for anything that lost the token.
  const TOKEN = `allsummary-count-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(t, 'regress.test.js'), [
    "const cp = require('child_process');",
    "const TOKEN = process.env.CLOADM_REGRESS_COUNT_TOKEN || 'no-token';",
    "if (process.argv.includes('--count')) {",
    "  cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', TOKEN], { stdio: 'ignore' });",
    '  setInterval(() => {}, 1000);',
    "} else console.log('12/12 regression hashes match (0.0 s)');",
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(t, 'zz-ok.test.js'), "console.log('all passed');\n");
  const r = cp.spawnSync(process.execPath, [path.join(t, 'all.js'), '--jobs', '1'], {
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', detached: true,
    env: Object.assign({}, process.env, {
      CLOADM_REGRESS_COUNT_TIMEOUT_MS: '1500', CLOADM_SUITE_TIMEOUT_MS: '8000',
      CLOADM_REGRESS_COUNT_TOKEN: TOKEN,   // inherited by all.js, then by the --count child (guardEnv copies env)
    }),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // Nothing this probe started may survive. Two paths must be swept, and the review found the second was not:
  //  * the GREEN path -- all.js kills its own --count group; nothing should be left;
  //  * the MUTATION path -- spawnSync's timeout SIGKILLs all.js alone, so the --count child is orphaned to pid 1 and
  //    its own child with it, and no in-process cleanup of all.js can run. The sweep below is what catches them, and
  //    the group kill of the spawnSync leader covers the case where all.js itself is still alive.
  try { process.kill(-r.pid, 'SIGKILL'); } catch (e) {}   // the leader's group, if it outlived the timeout
  // Fail closed: rc 1 is pgrep's "no match" and a clean empty answer; anything else (pgrep missing, permission,
  // timeout) must NOT read as "nothing survived". The same shape is in tests/allsignal.test.js (review of 054).
  const survivorsOf = () => {
    const found = new Set();
    for (const pat of [TOKEN, path.basename(dir)]) {
      let r;
      try { r = cp.execFileSync('pgrep', ['-f', pat], { encoding: 'utf8', timeout: 5000 }); }
      catch (e) {
        if (e.status === 1 && !e.stdout) continue;                 // rc 1, no output: no match
        if (typeof e.stdout === 'string' && e.stdout.trim()) { for (const pid of e.stdout.trim().split('\n')) found.add(pid); continue; }
        return `pgrep could not be run (${e.status === undefined ? e.message : `rc ${e.status}`})`;
      }
      for (const pid of r.trim().split('\n').filter(Boolean)) found.add(pid);
    }
    return [...found].join('\n');
  };
  let survivors = survivorsOf();
  fs.rmSync(dir, { recursive: true, force: true });
  if (survivors) { for (const pat of [TOKEN, path.basename(dir)]) { try { cp.execFileSync('pkill', ['-9', '-f', pat], { timeout: 5000 }); } catch (e) {} } }
  // after the sweep nothing may remain either: a sweep that failed would otherwise look like a clean run
  if (survivors && survivorsOf()) survivors += ' (STILL ALIVE after pkill)';
  check('a regress --count that never answers fails the run, naming the kill', r.status !== 0
    && /regress: regress\.test\.js --count did not answer within 1500 ms and was killed with its process group/.test(out)
    && /regression gate cannot be checked, so this run FAILS/.test(out),
    `exit ${r.status}: ${(out.match(/^regress: .*/m) || [''])[0].slice(0, 160)}`);
  check('...and it still exits promptly rather than hanging the gate', r.signal !== 'SIGKILL' && (r.status === 1),
    r.signal ? `the probe had to be SIGKILLed (${r.signal})` : `exit ${r.status}`);
  check('...and leaves no process of the hung child behind', !survivors.trim(), survivors.trim().split('\n').slice(0, 3).join(' '));
}

// 1c. A summary printed while the process is SHUTTING DOWN is not the suite reaching its summary. A suite that
// stops part-way still drains the event loop, so it can print "all passed" from a beforeExit or exit handler --
// and on main the gate read that as a pass. tests/no-exit.js now marks every write made from the first shutdown
// event (a NUL), and the verdict reads the live output only. Both events below run through the real runner; note
// that both stop at a promise that never settles, so `beforeExit` is the event that fires in each and no case here
// reaches the `exit`-only path (a crash) -- the reason is in tests/no-exit.js.
{
  const stopping = (event) => `process.on('${event}', () => { console.log('all passed'); });\n`
    + "(async () => { await new Promise(() => {}); })();\n";        // a promise that never settles
  const missed = [];
  for (const event of ['exit', 'beforeExit']) {
    const r = gate(stopping(event));
    if (r.status === 0) missed.push(`${event}: the gate exited 0`);
    else if (!failedAs(r, 'zz-probe.test.js')) missed.push(`${event}: the suite was not named as failing`);
    else if (!/without printing its summary line/.test(r.out)) missed.push(`${event}: not reported as a missing summary`);
  }
  check('a summary printed only from an exit or beforeExit handler does not pass', missed.length === 0, missed.join(' | '));
  // the control: the same summary, printed by the suite while it runs, reaches the gate
  const ok = gate("console.log('ok   first');\nconsole.log('all passed');\n");
  check('...and the same line printed while running still passes', ok.status === 0, `exit ${ok.status}`);
  // ...and a suite that reaches its summary WHILE RUNNING and then prints something at exit still passes -- which
  // it did NOT on main: the reader took the last line, so that healthy suite was failed there. Reading the live
  // output is what fixes it. (This is a fix, not a preserved behaviour; a review caught the earlier wording.)
  const trailing = gate("console.log('all passed');\nprocess.on('exit', () => { console.log('cleanup note printed at exit'); });\n");
  check('...and a line printed at exit after a live summary does not fail a healthy suite', trailing.status === 0,
    trailing.status === 0 ? '' : trailing.out.split('\n').filter((l) => /zz-probe/.test(l)).slice(0, 2).join(' | '));
  // the tail a reader sees keeps a shutdown-time line: a suite's own FAIL there is visible in the run's output,
  // and (2d) fails it. Both, so dropping the marked lines from the tail would show up here.
  const late = gate("process.on('exit', () => console.log('FAIL the exit handler saw something wrong'));\n");
  check('...and a shutdown-time line is still shown in the failure tail', /FAIL the exit handler saw something wrong/.test(late.out),
    late.status === 0 ? 'the gate exited 0' : '');
  // The marker cuts at ANY NUL, not only a line-initial one: a live write with no trailing newline puts the marker
  // mid-line, and a line-initial-only rule then read the shutdown-time summary as live and PASSED a suite that
  // stopped part-way. That was the one MAJOR finding of review round 2; this probe is it.
  const partial = gate("process.stdout.write('working');\n"
    + "process.on('exit', () => process.stdout.write('\\nall passed\\n'));\n"
    + "(async () => { await new Promise(() => {}); })();\n");
  check('a summary printed at exit after a partial live line does not pass', partial.status !== 0 && failedAs(partial, 'zz-probe.test.js'),
    partial.status === 0 ? 'the gate exited 0' : '');
  // ...and a suite that finishes its work and prints its summary live still passes, with a partial line before it:
  const partialOk = gate("process.stdout.write('working');\nconsole.log('\\nall passed');\n");
  check('...and the same shape with the summary printed live still passes', partialOk.status === 0, `exit ${partialOk.status}`);
  // A guard failure raised DURING shutdown must still be reported as the guard's, not as a printed FAIL: the guard
  // writes its line after the marker, so the regex has to read the tail (review round 2, finding 3). The suite calls
  // process.exit() from a beforeExit handler, which the guard blocks; it also resets exitCode at exit.
  const guarded = gate("process.on('beforeExit', () => { try { process.exit(0); } catch (e) {} });\n"
    + "process.on('exit', () => { process.exitCode = 0; });\n");
  check('a process.exit() called during shutdown is reported as the guard\'s failure', guarded.status !== 0
    && /process\.exit\(\) called at/.test(guarded.out) && !/printed a FAIL line and exited/.test(guarded.out),
    guarded.status === 0 ? 'the gate exited 0' : (guarded.out.match(/zz-probe\.test\.js: .*/) || [''])[0]);
  // Stated limit (tests/no-exit.js): a suite that does its work, then schedules more from a beforeExit handler and
  // prints its summary there, reads as having printed no summary while running. Pinned as the known behaviour: the
  // obvious fix (clearing the latch on the next turn) kept the loop alive forever and hung every suite, so this is a
  // deliberate trade, not an oversight. No suite here does it.
  const continued = gate("let first = true;\n"
    + "process.on('beforeExit', () => { if (first) { first = false; setTimeout(() => console.log('all passed'), 0); } });\n");
  check('a suite that continues from beforeExit after its work is failed -- the stated limit', continued.status !== 0,
    continued.status === 0 ? 'it passed: the limit is gone, update the comment' : '');
  // The exit-only path: an uncaught throw skips beforeExit but still runs exit handlers, so a suite that crashes
  // AFTER scheduling a throw and prints its summary from an exit handler must be failed. This is the only case that
  // reaches the `exit` listener in tests/no-exit.js -- removing that listener must turn it red (review, 054 item 3).
  const crashed = gate("process.on('exit', () => { console.log('all passed'); process.exitCode = 0; });\n"
    + "setTimeout(() => { throw new Error('boom'); }, 10);\n");
  check('a summary printed from an exit handler after a crash does not pass', crashed.status !== 0 && failedAs(crashed, 'zz-probe.test.js'),
    crashed.status === 0 ? 'the gate exited 0' : '');
  // A chunk that is not a string keeps its bytes when the marker is put in front of it. A helper suite must not be
  // corrupted by the guard: String(Buffer.from([0xE9,0x41])) is "233,65" and a latin1 string written back is
  // re-encoded as UTF-8 (0xC3 0xA9), so both old spellings changed a binary write. Read here as raw bytes, which the
  // spawn must therefore NOT decode; a mutation to either spelling turns this red.
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsummary-bytes-'));
  const bscript = path.join(bdir, 'w.js');
  fs.writeFileSync(bscript, "process.on('exit', () => { process.stdout.write(Buffer.from([0xE9, 0x41])); });\n");
  // a minimal env: the guard is preloaded explicitly, and inheriting NODE_OPTIONS would load a second copy of it
  const br = cp.spawnSync(process.execPath, ['--require', path.join(TESTS, 'no-exit.js'), bscript],
    { encoding: 'buffer', env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  fs.rmSync(bdir, { recursive: true, force: true });
  const got = br.stdout ? [...br.stdout] : [];
  check('a binary write at shutdown keeps its bytes behind the marker', got.length === 3 && got[0] === 0 && got[1] === 0xE9 && got[2] === 0x41,
    `bytes ${got.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
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
// asm has two halves: its assembler checks are counted (n, fail) and its LIZA conversation is a handful of screen
// checks behind one `ok` flag. A LIZA failure used to print only "MISSING: <text>" / "no repeat detection", with no
// "FAIL " and nothing in the tally but the summary's last word "LIZA conversation FAILED" -- a reader had to know to
// look there. It prints in the gate's one failure shape now, which is also what makes it fail a suite that (were it
// to) exit 0. This runs asm's REAL LIZA expectations, with one of them broken, in a scratch copy: the copy must print
// a line starting "FAIL ", name it LIZA, and fail.
//
// This runs asm's REAL failure branch, not a copy of its strings: the source is read, its failure branch is lifted
// out, and it is evaluated with fail/n/ok set to what a one-check failure gives. A hardcoded list of the strings
// would pass no matter what the branch did -- the first version of this check did exactly that and survived both
// mutations (wrong count restored; the line rewritten to read as a pass).
{
  // a scratch copy of the tree, asm.test.js with one LIZA greeting broken, run for real
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-liza-'));
  for (const d of ['tests', 'examples', 'js']) {
    fs.cpSync(path.join(TESTS, '..', d), path.join(dir, d), { recursive: true });
  }
  const asmCopy = path.join(dir, 'tests', 'asm.test.js');
  const real = fs.readFileSync(asmCopy, 'utf8');
  const broken = real.replace("'HELLO. WHAT WOULD YOU LIKE'", "'NO SUCH GREETING FROM LIZA'");
  fs.writeFileSync(asmCopy, broken);
  const r = cp.spawnSync(process.execPath, [asmCopy], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const out = (r.stdout || '') + (r.stderr || '');
  check('a broken LIZA check prints a "FAIL " line naming LIZA, and asm fails',
    broken !== real && r.status !== 0 && /^FAIL LIZA: /m.test(out) && /LIZA conversation FAILED/.test(out),
    r.status === 0 ? 'asm exited 0 with a broken LIZA check' : (out.match(/^FAIL .*/m) || [''])[0]);
}

// 2c-branch. asm's counted failure line: the count is the FAILURES, and the line cannot read as a summary.
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

// 2d. A "FAIL " line fails a suite even when it exits 0. The gate read only the exit code and the summary, so a
// suite whose last line was a summary-shaped pass and which printed "FAIL ..." earlier exited green: a check that
// failed and then let a later "all passed" stand was a pass. One shape is used by every suite and both guards
// ("FAIL <what>"), and a real suite never prints it on a passing run -- measured on every suite, section 7c holds
// it -- so the gate can read it as a failure unconditionally.
//
// What it does not catch, and no reader can: a failure worded any other way ("12/12 checks failed; all passed").
// That is pinned below so the limit is stated, not implied.
{
  const bodies = [
    ['a FAIL line before a passing summary', "console.log('FAIL a check');\nconsole.log('all passed');\n"],
    ['a FAIL line first, a tally after it', "console.log('FAIL a check');\nconsole.log('12/12 checks passed');\n"],
  ];
  const missed = [];
  for (const [what, body] of bodies) {
    const r = gate(body);
    if (r.status === 0) missed.push(what);
    else if (!/printed a FAIL line and exited \d+/.test(r.out)) missed.push(`${what}: no reason given`);
  }
  check('a suite that prints a FAIL line and exits 0 is failed, and the run says why', missed.length === 0, missed.join(' | '));
  // the control: the same suite without the FAIL line passes, so the FAIL line is what fails it
  const ok = gate("console.log('all passed');\n");
  check('...and the same suite without the FAIL line passes', ok.status === 0, `exit ${ok.status}`);
  // the limit, stated: a failure not spelled "FAIL " at the start of a line is still read by the summary rules
  const other = gate("console.log('12/12 checks failed; all passed');\n");
  check('a failure worded any other way is a known limit, not a check', other.status === 0,
    other.status === 0 ? 'accepted, as the comment states' : 'the gate now catches it -- tighten the comment');
  // and a FAIL line during shutdown fails the suite for THAT reason, not because it happened to have no summary:
  // the suite here prints its live summary and only the FAIL while shutting down, and the run must say a FAIL line
  // failed it. Reading the whole output (not the live one) for FAIL is what this holds: with shutdown lines cut,
  // this healthy-looking suite would pass.
  const late = gate("console.log('all passed');\nprocess.on('exit', () => console.log('FAIL the test did not finish'));\n");
  check('a FAIL line printed while shutting down fails the suite, and for that reason',
    late.status !== 0 && /printed a FAIL line and exited \d+/.test(late.out) && !/without printing its summary line/.test(late.out),
    late.status === 0 ? 'the gate exited 0' : (late.out.match(/zz-probe\.test\.js: .*/) || [''])[0]);
}

// 2e. Every summary pattern must be anchored at BOTH ends, and the anchor must be what rejects the line, not the
// end of the string. A pattern is only as good as its rejected cases: this drops each pattern's leading '^' and
// trailing '$' in turn, and for every mutation asserts that some line this gate must reject is now accepted (or a
// line it must accept is now rejected). A mutation nothing notices is an anchor no test holds -- exactly the
// "unpinned anchor" this exists for. The cases are the runner's own: the truncated and suffixed summaries 2b
// rejects, and the real summaries 2 it accepts.
{
  const { SUMMARY: pats } = require('./suite-verdict.js');
  const reject = [
    'A summary line lead-in: all passed',                 // whatever comes BEFORE a summary is not a summary
    'SUMMARY ok 512 checks', 'SUMMARY 127/127 SSC checks passed',   // a '^' with no text before the line
    'SUMMARY 146/146 regression hashes match (1.2 s)', 'SUMMARY 35/35 regression hashes, shard 0/4 match (1.0 s)',
    'x/12 checks passed', 'all 3/12 checks passed', '12/12 checks passed, 5 FAILED',
    'ok 512 checks and 900 were skipped', 'all passed and then some',
    '146/146 regression hashes match (1.2 s) and more', '35/35 regression hashes, shard 0/4 match (1.0 s) done',
  ];
  const accept = ['all passed', 'ok 512 checks', '127/127 SSC checks passed',
    '146/146 regression hashes match (12.3 s)', '35/35 regression hashes, shard 0/4 match (1.0 s)'];
  const matches = (set, line) => set.some((re) => re.test(line));
  const notices = [];
  for (let i = 0; i < pats.length; i++) {
    for (const end of ['start', 'end']) {
      const src = pats[i].source;
      let mutated;
      // Dropping the '^' or the '$' of a pattern that is not anchored there would be a no-op; skip that pattern for
      // that end, since the check is about anchors each pattern has, not anchors it never had.
      if (end === 'start') { if (!src.startsWith('^')) continue; mutated = new RegExp(src.slice(1)); }
      else { if (!src.endsWith('$')) continue; mutated = new RegExp(src.slice(0, -1)); }
      const set = pats.slice(); set[i] = mutated;
      // a mutation is PINNED when a line the runner must REJECT is now accepted. Only the reject side can pin: an
      // anchor can only NARROW what a pattern matches, so dropping one can never make an accepted line fail, and an
      // accept-side case is unreachable (a review measured that the first version's accept half never fired).
      const newlyAccepted = reject.filter((l) => !matches(pats, l) && matches(set, l));
      if (newlyAccepted.length === 0) notices.push(`pattern ${i} ('${src.slice(0, 24)}…') without its ${end} anchor changes no rejected line`);
    }
  }
  check('every summary pattern is anchored at both ends, and the anchor is load-bearing', notices.length === 0, notices.join(' | '));
  // the control: with the anchors in place, the runner rejects every rejected line and accepts every accepted one --
  // so the mutations above were the only reason those lines changed verdict
  const wrong = reject.filter((l) => matches(pats, l)).concat(accept.filter((l) => !matches(pats, l)));
  check('...and the unmutated patterns reject and accept exactly those lines', wrong.length === 0, wrong.join(' | '));
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
    // the guard is decided BEFORE the exit code: a suite that called process.exit() and also exited 1 is reported as
    // the guard's failure, so a reader is not told the wrong reason. (Review, 054 item 4: removing the reorder kept
    // every case green, so this is the case that pins it.)
    ['a guard failure with a non-zero exit is the guard\'s failure, not a plain exit', { code: 1, timedOut: false, guardFailed: true, stdout: 'FAIL x: process.exit() called at 1: process.exit()\n' }, 'guard'],
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
  check('...and it is reported as having printed no summary while running', /without printing its summary line/.test(r.out));
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
// Read from each file rather than by running them (that is the gate's job). What "prints a summary" means here: a
// call to a writer (console.log, console.info, console.debug, process.stdout.write -- console.warn and console.error
// go to stderr, which the runner never reads as a summary) contributes the text its arguments can produce, and the
// text is asked whether it matches a summary pattern. For each argument the reader takes
//
//  * the string literals it is built from, in both quote styles, joined as a concatenation would print them
//    ("7/7" + " checks passed" -> "7/7 checks passed"), with a '+ variable' or a template's ${...} filled with the
//    number a PASSING run gives it ("7"; both halves of a ${X}/${X} tally get the same 7, so the numerator equals
//    the denominator the way a pass prints it);
//  * for a printf-style call (console.log('%d/%d checks passed', 7, 7)) the format string with each %d/%i/%s/%f
//    replaced by that same 7, since a matching summary is exactly what a passing run's numbers print;
//  * arguments printed in order, a space between them (console.log('all', 'passed') -> "all passed"), while the
//    literals of one argument join with no space (a concatenation). A summary written either way is read.
//
// Every earlier version of this reader had a blind spot that made a real summary invisible while the gate accepted
// it: single quotes only (a double-quoted summary), console.log only (stdout.write, then console.info), a join of
// THREE OR MORE literals (the two-literal form happened to read as one, by luck -- a review measured both), and %d
// formats. The first three, double quotes and console.info were reproduced as reading ZERO summaries on base; the
// multi-literal one is pinned as a shape the reader must read. Section 7b pins all of them through this same reader.
//
// Why ONE matters: a summary-shaped line partway through a suite is what let a truncation pass the gate once
// (asm.test.js printed a tally at line 126 and the file stopped there -- it passed on eb06896). So a suite may have
// exactly one summary-shaped output, wherever it sits; a second one anywhere is reported. Nineteen suites end with a
// crash handler line (eleven of them log from it), and those print only on a crash: they are not summaries, and the
// reader treats them as the non-summaries they are.
//
// The reader does not evaluate code: a summary assembled at run time from pieces it cannot see (`[a, b].join(' ')`,
// a summary kept in a variable that a helper fills) is not read. That is why regress.test.js is exempt below.
//
// Exemptions, each with what still holds it:
//  * regress.test.js builds its line from a label variable, so a static read sees "7/7 7 7 (7 s)": the words
//    "regression hashes" and "match" are not in the console.log call the reader can see. Its shape is pinned by the
//    runner's last pattern and exercised by every gate run, sharded -- with its real output, section 2's shard
//    shape and the live gate.
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

  const norm = (t) => t.replace(/^\s+/, '').replace(/\s+$/, '');
  const isSummary = (t) => pats.some((re) => re.test(norm(t)));

  // One call per LINE, for the calls this repo writes: every writer call is on one line, and line scoping is what
  // keeps a misread to that line instead of swallowing the file (an earlier reader matched a call's whole span
  // with [\s\S] and lost every call after an unbalanced quote). A call split across lines is not seen, which is
  // stated here rather than pretended away.
  const PRINT = /\b(?:console\.(?:log|info|debug)|process\.stdout\.write)\s*\(/;
  // A line that is entirely a comment prints nothing; a call named there must not be counted as output. (A call
  // commented out at the END of a live line is not handled -- no suite here writes that, and a block comment is
  // not either: no suite here comments out a summary, and both are stated rather than pretended away.)
  const isComment = (line) => /^\s*\/\//.test(line);
  const printerLines = (src) => src.split('\n').filter((l) => !isComment(l) && PRINT.test(l));
  // The string and template literals on the line, both quote styles. `\\.` skips an escaped character so a quote
  // inside a string ("it's") does not end it early.
  const literals = (line) => [...line.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)]
    .map((x) => (x[1] ?? x[2] ?? x[3]));
  // What a run of literals prints: templates' ${...} and concatenated variables are numbers a passing run gives 7.
  const fill = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\$\{[^}]*\}/g, '7');
  // A printf format with its specifiers filled the way a passing run fills them. Only the seven-number placeholder
  // is used, as everywhere else here: the reader is asking whether the SHAPE can be a summary.
  const fmt = (s) => fill(s).replace(/%[disf]/g, '7').replace(/%%/g, '%');

  // The texts a line's writer call can print, as the reader understands it. A call's arguments are what separate
  // them: `console.log('all', 'passed')` prints "all passed" (a space between arguments), while
  // `console.log('7/7' + ' checks passed')` prints "7/7 checks passed" (a concatenation, no space). Only the
  // literals of ONE argument are joined without a separator; the arguments' own texts are joined with a space.
  // Splitting on commas that are not inside a literal is the closest this reader gets to the argument list; a
  // comma inside a nested call would split an argument, which for a summary call never changes whether one is
  // found (the pieces are joined again either way).
  const splitArgs = (line) => {
    // the WRITER CALL's opening paren, not the first paren on the line: `if (ok) console.log('all passed')` has an
    // earlier one, and starting there made the call's own text invisible (the review found it; base read that line)
    const m = PRINT.exec(line);
    const open = m ? m.index + m[0].length - 1 : -1;
    if (open < 0) return [];
    const args = [];
    let cur = '', quote = null, depth = 0;
    for (let i = open + 1; i < line.length; i++) {
      const c = line[i], prev = line[i - 1];
      if (quote) { cur += c; if (c === quote && prev !== '\\') quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) args.push(cur);
    return args;
  };
  const textsOf = (arg) => {
    const lits = literals(arg).map(fill);
    if (!lits.length) return [];
    return [...lits, lits.join(''), fmt(lits[0])];
  };
  const printsOf = (line) => {
    const args = splitArgs(line);
    if (!args.length) return [];
    const per = args.map(textsOf).filter((t) => t.length);
    if (!per.length) return [];
    const out = new Set(per.flat());
    // the arguments printed in order, a space between them: console.log(a, b) prints "a b". Each argument
    // contributes any one of its texts, so the space join is taken over every combination the reader can name.
    let joined = [''];
    for (const t of per) joined = joined.flatMap((a) => t.map((b) => (a ? a + ' ' + b : b)));
    for (const j of joined) out.add(j);
    // a printf call: the first argument's format with the next numbers filled, as a passing run fills them
    if (per.length > 1) out.add(fmt(literals(args[0])[0] || '').replace(/%[disf]/g, '7'));
    return [...out];
  };
  // a call prints its arguments in order, so "what it can print" is any ONE of them and also their join; matching
  // on both is what makes a multi-argument summary visible instead of invisible.
  const shapedOf = (src) => printerLines(src).flatMap(printsOf).filter(isSummary);

  const suites = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js') && !f.startsWith('fixture-'));
  const missing = [], ambiguous = [], exemptBad = [];
  for (const f of suites) {
    const src = fs.readFileSync(path.join(TESTS, f), 'utf8');
    const shaped = shapedOf(src);
    if (STATIC_EXEMPT[f]) {
      // not skipped: an exempt file is still held to its own final summary, which is readable for the two guards.
      // What this does NOT give them is the "exactly one" rule above -- their bodies hold probe suites that print
      // summaries on purpose, so a truncation of one of these files could still end on a probe body's line and pass
      // here. Both are guard suites whose contents are exercised by their own checks and by the gate's own run on
      // every commit, so that is the cover they have; it is not the same guarantee as the rule above, and the
      // comment says so rather than implying it.
      if (f === 'regress.test.js') continue;         // its own line is unreadable here (see the exemption)
      // its LAST printed call: the literals of the last line that prints anything, read the same way
      const printer = printerLines(src).pop() || '';
      if (!printsOf(printer).some(isSummary)) exemptBad.push(`${f}: its last printed text is not a summary`);
      continue;
    }
    if (shaped.length === 0) missing.push(`${f}: no summary-shaped output`);
    else if (shaped.length > 1) ambiguous.push(`${f}: ${shaped.length} summary-shaped outputs`);
  }
  check('every suite has exactly one summary-shaped output', ambiguous.length === 0, ambiguous.join(' | '));
  check('every suite prints a line the runner accepts as its summary', missing.length === 0, missing.join(' | '));
  check('every exempt suite still ends with a summary line', exemptBad.length === 0, exemptBad.join(' | '));

  // 7b. The reader's own blind spots, each the shape that once made a real summary invisible. Read through the
  // SAME shapedOf/isSummary the loop above uses, so a reader that regresses fails here rather than only on the
  // first suite that happens to print that way. Every case is a summary a passing suite really could print.
  {
    const forms = [
      ['a double-quoted summary', 'console.log("all passed");', 1],
      ['a single-quoted summary', "console.log('all passed');", 1],
      ['console.info', "console.info('all passed');", 1],
      ['console.debug', "console.debug('all passed');", 1],
      ['process.stdout.write', "process.stdout.write('all passed\\n');", 1],
      // a join that MATTERS: three literals, and the space-join spelling of them ("ok  512  checks") is not a
      // summary, so a reader that joined a concatenation with spaces instead of none is caught here (the review
      // found the first version of this table could not tell the two apart)
      ['a three-literal concatenated summary', "console.log('ok ' + '512' + ' checks');", 1],
      ['a concatenated summary', "console.log('7/7' + ' checks passed');", 1],
      ['a summary split across arguments', "console.log('all', 'passed');", 1],
      ['a summary after an earlier call on the same line', "if (ok) console.log('all passed');", 1],
      ['a printf-tally summary', "console.log('%d/%d checks passed', 7, 7);", 1],
      ['a printf summary with a label', "console.log('ok %d checks', 512);", 1],
      ['a double-quoted template tally', 'console.log(`${n}/${n} checks passed`);', 1],
      ['a summary written to stderr is not read', "console.error('all passed');", 0],
      ['a non-summary line', "console.log('working...');", 0],
      ['a commented-out summary', "// console.log('all passed');", 0],
    ];
    const blind = [];
    for (const [what, src, want] of forms) {
      const got = shapedOf(src).length;
      if (got !== want) blind.push(`${what}: read ${got}, want ${want}`);
    }
    check('the summary reader sees every way a suite here prints one, and nothing else', blind.length === 0, blind.join(' | '));
    // What the reader cannot see, stated rather than left as a surprise: a summary assembled at run time from
    // pieces it does not evaluate (a variable filled elsewhere). It does not report one, which is the safe
    // direction -- a suite with such a summary is reported as having none until it is exempted by name, as
    // regress.test.js is.
    check('a summary a reader cannot evaluate is reported as none, not guessed', shapedOf(
      "const t = '7/7' + ' checks passed';\nconsole.log(t);").length === 0);
    // and a real suite with a double-quoted summary is counted, not read as having none: the exact hole, on a
    // whole file rather than a snippet
    check('a suite whose only summary is double-quoted reads as one summary', shapedOf(
      'let fail = 0;\nconst check = (c) => { if (!c) fail++; };\ncheck(true);\nconsole.log(fail ? `${fail} FAILED` : "all passed");\n').length === 1);
  }
}

// 7c. No real suite prints a line starting "FAIL " on a passing run. The gate now fails any suite that does
// (section 2d), so this is what keeps that rule from failing a healthy run: a suite that prints FAIL as DATA would
// be failed by its own successful output. The answer was MEASURED, not guessed: every suite here was run to
// completion and its stdout scanned for a line matching /^FAIL /; none printed one. That measurement, plus the
// shape below, is why the runtime rule needs no exemption list.
//
// The static shape here is the only one a lexical reader can decide: a writer call whose sole argument is a string
// literal starting "FAIL ". Every real suite prints its failures from inside a failure branch (`fail++;` or a
// `check()` helper's arm, or a ternary's failure arm), which this skips -- and that is stated as the limit rather
// than papered over: a FAIL printed from a branch this reader cannot see is caught by the gate's own run on every
// commit, which is what executes the suites for real.
{
  // The two guard suites hold whole suite bodies in strings, some of which print FAIL on purpose; they are held by
  // their own checks and by the gate's run, as the summary exemption above says.
  const GUARD = new Set(['allsummary.test.js', 'exitguard.test.js']);
  const PRINT = /\b(?:console\.(?:log|info|debug)|process\.stdout\.write)\s*\(/;
  // a line that is inside a failure branch, or a ternary's arm, or an else: the FAIL there prints only when
  // something failed. A template with ${...} is filled at run time and is not decided here either.
  const BRANCHED = /fail\+\+|\bfail\s*\+=|\?\s*[^:]*:|\bif\s*\(|^\s*\}|\belse\b|\$\{/;
  const offenders = [];
  for (const f of fs.readdirSync(TESTS).filter((n) => n.endsWith('.test.js') && !n.startsWith('fixture-') && !GUARD.has(n))) {
    for (const line of fs.readFileSync(path.join(TESTS, f), 'utf8').split('\n')) {
      if (!PRINT.test(line) || /^\s*\/\//.test(line) || BRANCHED.test(line)) continue;
      const m = /\(([^)]*)\)/.exec(line);
      const first = m && /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*$/.exec(m[1]);
      if (first && /^FAIL /.test(first[2])) offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
    }
  }
  check('no suite prints a literal "FAIL " line unconditionally', offenders.length === 0, offenders.join(' | '));
  // not vacuous: the reader flags the plain shape and leaves every shape a real suite uses alone
  const probe = (src) => {
    const line = src.split('\n').find((l) => PRINT.test(l) && !/^\s*\/\//.test(l)) || '';
    if (BRANCHED.test(line)) return false;
    const m = /\(([^)]*)\)/.exec(line);
    const first = m && /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*$/.exec(m[1]);
    return !!(first && /^FAIL /.test(first[2]));
  };
  check('the FAIL-line reader flags a plain FAIL print, and only that',
    probe("console.log('FAIL a check');") === true
    && probe('console.log("FAIL a check");') === true
    && probe("console.log(`FAIL ${name}`);") === false          // a template, filled at run time -- not decidable here
    && probe("console.log(fail ? `${fail} FAILED` : 'all passed');") === false
    && probe("if (!ok) console.log('FAIL x');") === false
    && probe("} else console.log('FAIL x');") === false
    && probe("// console.log('FAIL out');") === false);
}

// 8. The run's last line names every failing suite: "FAILED: a.test.js, b.test.js". A long log's tail, which is
// what a reader (or a coding agent) sees first, must say what to rerun, not only how many failed.
{
  const pass = "console.log('all passed');\n", failing = "console.log('FAIL a real check');\nconsole.log('1 FAILED');\nprocess.exitCode = 1;\n";
  const lastLine = (out) => out.trim().split('\n').pop();
  const two = gate(failing, { extra: { 'zz-alsofails.test.js': failing, 'zz-fine.test.js': pass } });
  check('the last line of a failing run names every failing suite, and only those',
    two.status !== 0 && lastLine(two.out) === 'FAILED: zz-alsofails.test.js, zz-probe.test.js' && /2 of 4 suites FAILED/.test(two.out),
    lastLine(two.out));
  const inc = gate(pass, { regress: null });
  check('...and an incomplete regression gate is named there too',
    inc.status !== 0 && lastLine(inc.out) === 'FAILED: regress.test.js (regression gate incomplete)', lastLine(inc.out));
  const ok = gate(pass);
  check('...and a passing run prints no FAILED line', ok.status === 0 && !/^FAILED:/m.test(ok.out) && /all 2 suites passed$/.test(ok.out.trim()), lastLine(ok.out));
}

// 9. --only <pattern>: a quick subset run. It runs only the suites whose name contains a pattern, it can never read
// as the full gate (its summary says SUBSET RUN and never "all N suites passed"), it still fails on a failing suite
// and names it, a pattern that selects nothing is an error (exit 2), and the regression gate is held to completeness
// whenever it is selected.
{
  const pass = "console.log('all passed');\n", failing = "console.log('FAIL a real check');\nconsole.log('1 FAILED');\nprocess.exitCode = 1;\n";
  const lastLine = (out) => out.trim().split('\n').pop();
  // a failing suite left out of the selection does not run: the subset passes, and says it is a subset
  const sub = gate(failing, { args: ['--only', 'zz-fine'], extra: { 'zz-fine.test.js': pass } });
  check('--only runs just the matching suites, and the summary says it is not the full gate',
    sub.status === 0 && /^pass  zz-fine\.test\.js/m.test(sub.out) && !/zz-probe|regress/.test(sub.out)
      && lastLine(sub.out) === 'SUBSET RUN (--only zz-fine), not the full gate: 1 of 3 suites run, all passed'
      && !/all \d+ suites passed/.test(sub.out), lastLine(sub.out));
  // several patterns, one failing: the run fails and the FAILED line names it
  const bad = gate(failing, { args: ['--only', 'zz-fine,zz-probe'], extra: { 'zz-fine.test.js': pass } });
  check('--only with a failing suite fails, and names it on the last line',
    bad.status === 1 && /SUBSET RUN \(--only zz-fine,zz-probe\), not the full gate: 1 of 2 selected suites FAILED/.test(bad.out)
      && lastLine(bad.out) === 'FAILED: zz-probe.test.js', lastLine(bad.out));
  // a pattern that matches nothing is an error, not a green run of zero suites; so is a missing pattern
  const none = gate(pass, { args: ['--only', 'nosuchsuite'] });
  check('--only that selects nothing exits 2 and says so', none.status === 2 && /no suite name contains this/.test(none.out) && !/passed/.test(none.out),
    `exit ${none.status}: ${lastLine(none.out)}`);
  const empty = gate(pass, { args: ['--only'] });
  check('--only with no pattern exits 2', empty.status === 2 && /--only needs a pattern/.test(empty.out), `exit ${empty.status}`);
  // the regression gate, when selected, is still checked for completeness: shards short of --count fail the subset
  const fewer = STAND_IN_REGRESS.replace("k = T / (s ? Number(s.split('/')[1]) : 1);", "k = T / (s ? Number(s.split('/')[1]) : 1) - 1;");
  const reg = gate(pass, { args: ['--only', 'regress'], regress: fewer });
  check('--only regress still fails an incomplete regression gate', reg.status === 1 && /-- INCOMPLETE/.test(reg.out)
    && lastLine(reg.out) === 'FAILED: regress.test.js (regression gate incomplete)', lastLine(reg.out));
  const regOk = gate(pass, { args: ['--only', 'regress'] });
  check('...and passes a complete one, as a subset', regOk.status === 0 && /regress 12\/12 included/.test(regOk.out)
    && /^SUBSET RUN \(--only regress\), not the full gate: 1 of 2 suites run, all passed$/m.test(regOk.out), lastLine(regOk.out));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
