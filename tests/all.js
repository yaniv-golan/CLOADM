// Runs every test suite (tests/*.test.js) in a worker pool and reports one line each, in file order -- the same
// lines, in the same order, as a serial run -- while still printing a suite as soon as it is the next one due.
// Exit code 0 only if all pass.
//
// A suite passes only if it exits 0 AND its last printed line is its summary ("all passed", "127/127 checks
// passed", ...): a suite that stops halfway -- the usual cause is a promise that never settles, which does not
// hang but lets Node drain the event loop and exit 0 -- prints no summary and is failed by name.
//
//   node tests/all.js [--jobs N] [--only <pattern>[,<pattern>...]]
//
// --only runs just the suites whose file name contains one of the patterns (a quick loop while developing; see
// docs/development.md, "The fast loop"). Such a run is NOT the gate: its summary says so, and the regression gate's
// completeness is checked only if regress.test.js is among the selected suites. A pattern that selects nothing is
// an error (exit 2), so a typo cannot read as a green run.
//
// The last line of every run that has a failure is "FAILED: <suite>, <suite>, ...", naming each one.
//
// Each suite is its own Node process, as before: the suites share no state, write no files, and a crash in one
// cannot affect another. Running several at once only changes wall time. Output and exit codes are identical
// to a serial run: one line per suite in the same order, and the failing suite's tail printed under it.
//
// The pool size defaults to the machine's usable parallelism (capped at 8: more suites than that are dominated
// by the two long ones, and oversubscribing a loaded machine makes every suite slower).
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const { verdict, tail } = require('./suite-verdict.js');

const argJobs = (() => { const i = process.argv.indexOf('--jobs'); return i > 0 ? Number(process.argv[i + 1]) : 0; })();
const usable = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const jobs = Math.max(1, Math.min(8, argJobs || usable));

// A fixture suite is a deliberately broken or deliberately silent suite that a guard test runs (tests/
// fixture-stops-early.test.js and friends). It lives under tests/ so the static scans reach it, and this keeps it
// out of the gate: a fixture that always fails must not make every run fail.
function isFixture(name) { return name.startsWith('fixture-'); }

const allFiles = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && !isFixture(f)).sort();
// --only: a comma-separated list of substrings of suite file names. Kept as given for the summary line.
const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
})();
const onlyPats = onlyArg === null ? null : onlyArg.split(',').map((p) => p.trim()).filter(Boolean);
const files = onlyPats ? allFiles.filter((f) => onlyPats.some((p) => f.includes(p))) : allFiles;
if (onlyPats && !files.length) {
  console.error(onlyPats.length ? `--only ${onlyArg}: no suite name contains ${onlyPats.length > 1 ? 'any of these' : 'this'}; suites are tests/*.test.js`
    : '--only needs a pattern: node tests/all.js --only <part of a suite name>[,<another>]');
  process.exitCode = 2;
}
const results = new Map();   // file -> { ok, seconds, output }

// The summary rule itself (what a suite's last line must be, and whether a finished suite passed) lives in
// tests/suite-verdict.js: a pure function, so every case -- including a timeout that fires in the race between a
// suite exiting 0 and its 'close' arriving -- is tested without spawning anything. tests/allsummary.test.js holds
// every suite's real output to those patterns.

// Every suite runs with tests/no-exit.js preloaded, so a suite that reaches process.exit() by any spelling is
// failed by name instead of bringing back the Node 25 deadlock (see that file, and tests/exitcode.test.js for
// the static scan). NODE_OPTIONS is inherited, so a suite that spawns another node process covers it too; a
// suite that clears NODE_OPTIONS for its child is not covered, which the guard cannot see.
const GUARD = path.join(__dirname, 'no-exit.js');
const guardEnv = Object.assign({}, process.env, {
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(GUARD)}`].filter(Boolean).join(' '),
});
let next = 0, failed = 0;

// Print the run in file order: hold a finished suite's line until every suite before it has printed, so the
// output is the serial run's, but print each as soon as it is next in line (a slow early suite delays the
// lines behind it rather than reordering them).
let printed = 0;
function flush() {
  while (printed < files.length && results.has(files[printed])) report(files[printed++]);
}

// Print a suite's line now, so a slow run still shows progress; the summary waits for all of them.
function report(f) {
  const r = results.get(f);
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${f.padEnd(22)} ${r.seconds.toFixed(1)} s`);
  if (!r.ok) console.log(tail(r.output).split('\n').filter((l) => !l.startsWith('ok ')).slice(-25).join('\n'));
}

// A suite may declare shards: regress.test.js accepts --shard i/n and its cases share no state, so running
// its shards in parallel shortens the gate without changing what it checks. The shards' output is joined
// under the one suite line, and the suite passes only if every shard does.
// The gate's two long suites (regress, then state) otherwise leave most of the pool idle at the end, and each
// regress shard is held to the long suites' timeout (below). Regress is about 194 s of work (146 cases on 4 cores,
// 2026-11), so from 4 usable cores it gets 4 shards, split by cost (tests/regress-shards.js), each about 50 s of
// work. Below 4 cores it runs unsharded, as sharding there only competes for the same cores.
const SHARDS = { 'regress.test.js': jobs >= 4 ? 4 : 1 };

function runOne(f) {
  const n = SHARDS[f] || 1;
  if (n > 1) return runSharded(f, n);
  return new Promise((resolve) => {
    const t0 = Date.now();
    // an unsharded suite records its own result, exactly as a sharded one does; forgetting this is how a
    // suite line (and so a failure) can go missing from the run
    spawnSuite(f, [], (ok, out) => {
      results.set(f, { ok, seconds: (Date.now() - t0) / 1000, output: out });
      if (!ok) failed++;
      flush();
      resolve();
    });
  });
}

// Run a suite's shards at once. Each is a separate process; their exits decide the suite's result, and their
// combined output is what the failing-suite tail shows.
function runSharded(f, n) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const parts = new Array(n).fill(null);
    let done = 0;
    for (let i = 0; i < n; i++) {
      spawnSuite(f, ['--shard', `${i}/${n}`], (ok, out) => {
        parts[i] = { ok, out };
        if (++done < n) return;
        const allOk = parts.every((p) => p && p.ok);
        const output = parts.map((p) => p.out).join('\n');
        results.set(f, { ok: allOk, seconds: (Date.now() - t0) / 1000, output });
        if (!allOk) failed++;
        flush();
        resolve();
      });
    }
  });
}

// A suite that never exits must not hang the gate. Each process is killed after its timeout and the suite
// reported as a failure that says so.
//
// How the limits were chosen: measured on a machine under load (load average ~30, a full run taking 90 s
// rather than the ~45 s it takes idle), the slowest suite was state.test.js at 33.9 s and the next was
// regress.test.js at 16.5 s split into four shards, so about 12 s per shard. Those are the two long ones and
// everything else is under 10 s. The limits are therefore a large multiple of the observed worst case, not a
// tight bound: a healthily slow machine stays well inside them, while a hung suite (one run sat in
// composite.test.js, normally 0.1 s, for over 5 minutes) is caught.
// CLOADM_SUITE_TIMEOUT_MS exists so the timeout itself can be exercised quickly in a scratch copy; it is not
// meant to be set in normal use.
const envT = Number(process.env.CLOADM_SUITE_TIMEOUT_MS) || 0;
const SUITE_TIMEOUT_MS = envT || 240000;   // 4 min: ~7x state.test.js's 33.9 s under load
// The two long suites get their own cap. On GitHub's ubuntu-24.04 runner (fewer than 4 usable cores, so regress
// runs unsharded) regress was killed at 240 s and state.test.js took 210 s in the same run (CI run 43812014303,
// main ebe0df1f, 2026-11-16): both are ~3 minutes of real work there, not hung. 600 s is ~2.5x that observed
// run, still well inside the job's 20-minute limit, so a real hang in either is still caught and reported.
// A regress shard is a slice of one of those long suites and gets the same cap. Its own 120 s cap failed the gate
// on a loaded machine: with a second whole gate running on the same 4 cores (main 753ca102, 2026-11-16), all four
// shards were killed at 120 s, while the same run with the cap out of the way took 143.7 s for the longest shard
// and 177.5 s for state.test.js. More shards do not fix that: the shards run at once on the same cores, so a
// shard's wall time follows the machine's load, not its share of the work (6 shards: the longest 121.3 s in the
// same setup). The cap is only there to catch a hang, as for the suites.
const LONG_SUITE_TIMEOUT_MS = envT || 600000;
// The suites long enough to need the longer timeout. state.test.js was one file of about 210 s on CI; the split
// made it four (state 10 s, state-fdc 23, state-carts 15, state-tape 2 locally), and state-fdc is still long enough
// on CI to be worth the extra headroom. state-split is static (reads a manifest, 0.1 s) and is NOT long.
const LONG_SUITES = new Set(['regress.test.js', 'state-fdc.test.js', 'state-carts.test.js']);
const TIMEOUT_MS = (f) => (LONG_SUITES.has(f) ? LONG_SUITE_TIMEOUT_MS : SUITE_TIMEOUT_MS);

// Every suite process still running, so a signal can take the whole set down. A suite is spawned detached (its
// own process group), which also means a signal to this process does not reach it: Ctrl-C kills this runner and
// leaves the suites running. They are killed explicitly below.
const live = new Set();
const killAll = () => {
  for (const p of live) {
    try { process.kill(-p.pid, 'SIGKILL'); }       // the suite and anything it spawned
    catch (e) { try { p.kill('SIGKILL'); } catch (e2) {} }
  }
  live.clear();
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const onSignal = () => {
    console.error(`\n${sig}: stopping ${live.size} running suite(s)`);
    killAll();
    // End the process the way the signal would have, now that the suites' groups are dead: drop this handler and
    // re-raise, so the default action runs and the exit code is 128+n (130 for SIGINT). A plain process.exit
    // would work too, but the project keeps exit() out of the test run entirely (tests/exitcode.test.js).
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.on(sig, onSignal);
}

// Spawn one process and hand back (ok, output). A process still alive after its timeout is SIGKILLed and
// reported as a failure naming the suite, so a hang shows up in the run instead of stopping it.
function spawnSuite(f, argv, done) {
  // detached puts the suite in its own process group, so a timeout kills it AND anything it spawned
  // (tests/romdocs.test.js runs tools/gen-rom-docs.js), rather than orphaning a child that keeps running
  // after the gate has finished.
  // env: guardEnv puts tests/no-exit.js in NODE_OPTIONS for EVERY child this runner starts -- an ordinary suite
  // and each regress shard alike, since both come through here. Installing it at the call sites instead is how a
  // shard went unguarded: runSharded spawns with ['--shard', i/n] and the plain path spawned its own way.
  const p = cp.spawn(process.execPath, [path.join(__dirname, f), ...argv], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: guardEnv });
  let out = '', sout = '', timedOut = false;
  live.add(p);
  const killer = setTimeout(() => {
    timedOut = true;
    out += `\n${f}${argv.length ? ' ' + argv.join(' ') : ''}: killed after ${TIMEOUT_MS(f) / 1000} s without exiting`;
    try { process.kill(-p.pid, 'SIGKILL'); }      // the whole group
    catch (e) { p.kill('SIGKILL'); }              // ...or at least the suite itself
  }, TIMEOUT_MS(f));
  // stdout is kept apart from stderr because the summary is read from it: a suite prints its summary with
  // console.log, and a warning Node emits on stderr around the same moment must not hide it. The combined `out` is
  // what the failure tail shows, so nothing a suite wrote is lost from the run's output.
  p.stdout.on('data', (d) => { out += d; sout += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', (e) => { out += `\n${e.message}`; });
  p.on('close', (code) => {
    clearTimeout(killer); live.delete(p);
    // The guard's own verdict beats the exit code, for every child this runner starts: an ordinary suite and
    // each regress shard. A suite that reaches process.exit() is failed by tests/no-exit.js, which prints a FAIL
    // line and sets exitCode = 1 -- but the suite can still exit 0, because an 'exit' listener it registered runs
    // after the guard's and can reassign exitCode. It cannot take back what it wrote to stdout.
    //
    // Read from `tail`, not the live output: the guard can raise its FAIL from a shutdown event (a suite that calls
    // process.exit() from a beforeExit handler), and that line is written after the marker. Reading the live output
    // hid exactly that failure and reported it as a printed FAIL instead. The guard's line is
    // distinctive enough that a suite's own lookalike is not a concern: if one prints it at shutdown, hasFailureLine
    // fails the suite anyway, which is the right verdict for a printed "FAIL " line.
    const guardFailed = /^FAIL .*: process\.exit\(\) called at /m.test(tail(out));
    // The rule itself is in tests/suite-verdict.js. A suite that exited 0 without printing its summary (while it
    // was still running) must not count as a pass. Only a missing summary gets this explanation, so an ordinary
    // failure is not misdescribed as one that stopped early. What CAUSED it is not asserted: a pending promise is
    // the common case, but so is a summary printed from an exit handler, or work it scheduled from beforeExit.
    const v = verdict({ code, timedOut, guardFailed, stdout: sout });
    if (v === 'no-summary') out += `\n${f}: exited 0 without printing its summary line while it was running: the`
      + ' suite either stopped early or reached its summary only after it had begun shutting down, so exit code alone'
      + ' is not enough';
    else if (v === 'failed') out += `\n${f}: printed a FAIL line and exited ${code}: a suite fails by what it`
      + ' printed, not only by its exit code (an exit handler that resets exitCode cannot take back the line it'
      + ' wrote)';
    done(v === 'passed', out);
  });
}

// A fixed set of workers, each taking the next unclaimed file: no more than `jobs` suites run at once, and no
// file is started twice.
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= files.length) return;
    await runOne(files[i]);
  }
}

// The regression gate is one of the suites (regress.test.js, sharded above), so a separate
// `node tests/regress.test.js` run adds nothing. This makes that visible: each shard prints "<ok>/<n> regression
// hashes ...", and the shards together must have run every case the gate has (regress.test.js --count), all
// matching; anything else fails the run, even if every shard exited 0.
const REGRESS = 'regress.test.js';
// `--count` is one number printed in about 55 ms (measured); this cap only catches a child that hangs, and it must
// not be mistaken for a slow one. 10 s is ~180x the measured time, and the env var exists so the timeout itself can
// be exercised in a test without waiting for it. A child that does not exit is KILLED and the gate FAILS naming it --
// it never passes silently.
//
// Why spawn and not execFileSync: execFileSync's own `timeout` kills the child it started and nothing else, so a
// `--count` that had spawned its own child left that grandchild spinning after the gate moved on (measured: three
// such orphans from one mutation run). The child is spawned DETACHED, so it is a process-group leader, and the kill
// goes to `-pid` -- the whole group, so anything it spawned in that group dies with it. The output is collected by
// hand because spawn is async.
// What a group kill cannot reach, stated: a descendant that itself called setsid or spawned `detached: true` is in a
// DIFFERENT process group, and no signal to the leader's group touches it. `--count` has no reason to do that, and
// the test's grandchild deliberately stays in the group; a `--count` that detaches its own children is out of reach
// of any in-process cleanup, which is why the test also asserts that nothing the probe started survives.
const REGRESS_COUNT_TIMEOUT_MS = Number(process.env.CLOADM_REGRESS_COUNT_TIMEOUT_MS) || 10000;
function countCases() {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [path.join(__dirname, REGRESS), '--count'], {
      env: guardEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // In `live`, so a signal to the gate kills the count child and its descendants like every suite: without this a
    // SIGINT while it counts reported "stopping 0 running suite(s)" and left the child running (a SIGINT while counting must stop the children).
    live.add(child);
    let out = '', done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.delete(child);
      resolve({ err, out });
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }            // the whole group
      catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
      finish({ timedOut: true });
    }, REGRESS_COUNT_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ message: e.message }));
    child.on('close', (code, signal) => finish(code === 0 ? null : { message: `exited ${code}${signal ? ` (${signal})` : ''}` }));
  });
}
async function regressIncluded() {
  if (!files.includes(REGRESS)) return { ok: false, line: `regress: ${REGRESS} not found, the regression gate did not run` };
  let total;
  const { err, out } = await countCases();
  if (err) {
    // A child that did not answer is reported as such, by name: the failure must say the count did not answer, not
    // read as "no regression cases".
    const why = err.timedOut ? `did not answer within ${REGRESS_COUNT_TIMEOUT_MS} ms and was killed with its process group` : `failed: ${err.message}`;
    return { ok: false, line: `regress: ${REGRESS} --count ${why}; the regression gate cannot be checked, so this run FAILS` };
  }
  total = Number((/^(\d+) regression cases$/m.exec(out) || [])[1]);
  const r = results.get(REGRESS), parts = [...r.output.matchAll(/^(\d+)\/(\d+) regression hashes/gm)];
  const ok = parts.reduce((a, m) => a + Number(m[1]), 0), ran = parts.reduce((a, m) => a + Number(m[2]), 0);
  const shards = SHARDS[REGRESS] || 1, whole = total > 0 && parts.length === shards && ran === total && ok === total;
  return { ok: whole, line: `regress ${ok}/${total} included (${parts.length} of ${shards} shard${shards > 1 ? 's' : ''} reported, ${ran} cases run)${whole ? '' : ' -- INCOMPLETE'}` };
}

// The run's last line, when anything failed: every failing suite by name (and the regression gate, when it is the
// incomplete part), so a reader of a long log, or a coding agent reading only its tail, sees what to rerun.
function failedLine(regOk) {
  const names = files.filter((f) => results.has(f) && !results.get(f).ok);
  if (!regOk) names.push(`${REGRESS} (regression gate incomplete)`);
  return names.length ? `FAILED: ${names.join(', ')}` : null;
}

(async () => {
  if (!files.length) return;           // --only selected nothing: reported above, exit 2
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  if (onlyPats) {
    // A subset run: the regression gate's completeness is checked only when its suite was selected, and the summary
    // can never be mistaken for the full gate's ("all N suites passed").
    const reg = files.includes(REGRESS) ? await regressIncluded() : { ok: true, line: null };
    if (reg.line) console.log(reg.line);
    const what = `SUBSET RUN (--only ${onlyArg}), not the full gate:`;
    console.log(failed ? `${what} ${failed} of ${files.length} selected suites FAILED`
      : reg.ok ? `${what} ${files.length} of ${allFiles.length} suites run, all passed`
        : `${what} the selected suites exited 0, but the regression gate is incomplete: FAILED`);
    const fl = failedLine(reg.ok);
    if (fl) console.log(fl);
    process.exitCode = failed || !reg.ok ? 1 : 0;
    return;
  }
  const reg = await regressIncluded();
  console.log(reg.line);
  const bad = failed + (reg.ok ? 0 : 1);
  console.log(failed ? `${failed} of ${files.length} suites FAILED` : reg.ok ? `all ${files.length} suites passed` : `all ${files.length} suites exited 0, but the regression gate is incomplete: FAILED`);
  const fl = failedLine(reg.ok);
  if (fl) console.log(fl);
  process.exitCode = bad ? 1 : 0;
})();
