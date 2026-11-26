// Runs every test suite (tests/*.test.js) in a worker pool and reports one line each, in file order -- the same
// lines, in the same order, as a serial run -- while still printing a suite as soon as it is the next one due.
// Exit code 0 only if all pass.
//
// A suite passes only if it exits 0 AND its last printed line is its summary ("all passed", "127/127 checks
// passed", ...): a suite that stops halfway -- the usual cause is a promise that never settles, which does not
// hang but lets Node drain the event loop and exit 0 -- prints no summary and is failed by name.
//
//   node tests/all.js [--jobs N] [--only <pattern>[,<pattern>...] | --shard i/n] [--timings FILE] [--record-times]
//   node tests/all.js --list
//
// --shard i/n (1 <= i <= n) runs the i-th of n disjoint parts of the gate, for CI, which runs the n parts on n
// runners at once. The parts are planned from tests/suite-times.json (each suite's measured seconds; a suite not in
// it counts 1 s), longest suite first onto the part with the least time so far, so every suite is in exactly one
// part whatever the times say: stale times only unbalance the parts. The part holding regress.test.js checks the
// regression gate's completeness as the whole run does. The last line is "shard i/n: <k> of <total> suites run, ..."
// and the CI `gates` job (.github/scripts/suite-shards.js) checks that the parts' suite lines are, together, every
// suite `--list` prints, each once, and that the parts' counts sum to the total. A part alone is NOT the gate.
//
// --list prints the gate's suites, one per line, and runs nothing. --timings FILE writes each suite's seconds there
// as JSON ({ "suites": { name: seconds } }). --record-times rewrites tests/suite-times.json itself from a whole run
// (not --only, not --shard), only if it passed, keeping its "//" note: that one file plans the CI parts (--shard) and
// the order every run starts its suites in (longest first, below).
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
// tests/suite-times.json: { "//": a note, "suites": { name: seconds } }, from a whole run. It plans the CI parts
// (shardOf) and the order the units start in (below); --record-times rewrites it. Missing or unreadable: no times.
const TIMES_FILE = path.join(__dirname, 'suite-times.json');
function recordedTimes() {
  try {
    const j = JSON.parse(fs.readFileSync(TIMES_FILE, 'utf8'));
    return { note: typeof j['//'] === 'string' ? j['//'] : null, suites: j && typeof j.suites === 'object' && j.suites ? j.suites : {} };
  } catch (e) { return { note: null, suites: {} }; }
}
const RECORD = process.argv.includes('--record-times');
// --shard i/n: the i-th of n parts (see the top of this file)
const shardArg = (() => {
  const i = process.argv.indexOf('--shard');
  if (i < 0) return null;
  const m = /^(\d+)\/(\d+)$/.exec(process.argv[i + 1] || '');
  const k = m ? Number(m[1]) : 0, n = m ? Number(m[2]) : 0;
  return m && n >= 1 && k >= 1 && k <= n ? { k, n } : { error: `--shard needs i/n with 1 <= i <= n, not ${JSON.stringify(process.argv[i + 1] || '')}` };
})();
// The parts: longest suite first, onto the part with the least time so far (ties: the lower part); deterministic,
// and every suite lands in exactly one part.
function shardOf(names, n) {
  const times = recordedTimes().suites;   // none: 1 s each
  const cost = (f) => (Number.isFinite(times[f]) && times[f] > 0 ? times[f] : 1);
  const load = new Array(n).fill(0), part = new Map();
  for (const f of [...names].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k] - 1e-9) k = j;
    part.set(f, k + 1);
    load[k] += cost(f);
  }
  return part;
}
const files = onlyPats ? allFiles.filter((f) => onlyPats.some((p) => f.includes(p)))
  : shardArg && !shardArg.error ? (() => { const part = shardOf(allFiles, shardArg.n); return allFiles.filter((f) => part.get(f) === shardArg.k); })()
    : allFiles;
const timingsFile = (() => { const i = process.argv.indexOf('--timings'); return i > 0 ? process.argv[i + 1] : null; })();
const usage = shardArg && shardArg.error ? shardArg.error : shardArg && onlyPats ? '--shard and --only cannot be combined'
  : RECORD && (onlyPats || shardArg) ? '--record-times needs a full run: the times of a subset run or of one part are not the gate\'s' : null;
if (process.argv.includes('--list')) console.log(allFiles.join('\n'));
else if (usage) { console.error(usage); process.exitCode = 2; }
else if (onlyPats && !files.length) {
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

// The work, as pool slots: one per process. A sharded suite is n units, one per shard, so each regress shard takes a
// slot of the pool like any other suite instead of four processes riding on one worker's slot (which ran up to
// jobs + 3 processes at once on `jobs` cores). A suite's result is recorded when its last unit finishes.
function unitsOf(f) {
  const n = SHARDS[f] || 1;
  return n > 1 ? Array.from({ length: n }, (_, i) => ({ f, argv: ['--shard', `${i}/${n}`], i, n })) : [{ f, argv: [], i: 0, n: 1 }];
}
const pending = new Map();   // file -> { t0, parts }
function runUnit(u) {
  return new Promise((resolve) => {
    if (!pending.has(u.f)) pending.set(u.f, { t0: Date.now(), parts: new Array(u.n).fill(null) });
    const st = pending.get(u.f);
    // an unsharded suite records its own result, exactly as a sharded one does; forgetting this is how a suite line
    // (and so a failure) can go missing from the run
    spawnSuite(u.f, u.argv, (ok, out) => {
      st.parts[u.i] = { ok, out };
      if (st.parts.every(Boolean)) {
        // the shards' exits decide the suite's result, and their combined output is what the failing-suite tail shows
        const allOk = st.parts.every((p) => p.ok);
        results.set(u.f, { ok: allOk, seconds: (Date.now() - st.t0) / 1000, output: st.parts.map((p) => p.out).join('\n') });
        if (!allOk) failed++;
        flush();
      }
      resolve();
    });
  });
}

// Longest first: the units start in order of their recorded time (tests/suite-times.json's seconds per suite from a
// whole run; a shard is its suite's time over the shard count), so the long suites are not the last ones started and
// the pool does not end with one core busy and the rest idle. The order only changes when each suite starts: the
// output is still printed in file order (flush), and what each suite checks is the same. A suite the file does not
// list (a new one) is taken as one of the long ones, so it starts early rather than late. A missing or unreadable
// file leaves file order.
// `node tests/all.js --record-times` rewrites the file from the run it just made (a full run only, and only if it
// passed); the times are a scheduling hint, so a stale file costs wall time, never correctness.
const times = recordedTimes().suites;
const known = Object.values(times).filter((t) => typeof t === 'number');
const unknownTime = known.length ? Math.max(...known) : 0;
const timeOf = (f) => (typeof times[f] === 'number' ? times[f] : unknownTime);
const units = files.flatMap(unitsOf).map((u, k) => ({ ...u, k, cost: timeOf(u.f) / u.n }))
  .sort((a, b) => b.cost - a.cost || a.k - b.k);

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
// The long suites (LONG_SUITES, below) get their own cap. On GitHub's ubuntu-24.04 runner (fewer than 4 usable cores, so regress
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
// basic-drawing (98 s alone locally: lines, circles, PAINT, DRAW and GET/PUT compared byte for byte with the model,
// no replays to cut) was killed at 240 s once in CI part 1/3 (run 1008, 2026-11-26), beside basic-cassette (then
// 129 s alone). basic-cassette, its data-file mutants now run only through the section each breaks, is 77 s and keeps
// the normal cap.
const LONG_SUITES = new Set(['regress.test.js', 'state-fdc.test.js', 'state-carts.test.js', 'basic-drawing.test.js']);
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

// A fixed set of workers, each taking the next unclaimed unit: no more than `jobs` processes run at once, and no
// unit is started twice.
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= units.length) return;
    await runUnit(units[i]);
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
  // --list, a usage error or an --only that selected nothing (reported above, exit 2); a shard may be empty when
  // there are more parts than suites, and then reports 0 suites run
  if (process.argv.includes('--list') || usage || (!files.length && !shardArg)) return;
  await Promise.all(Array.from({ length: Math.min(jobs, units.length) }, worker));
  if (timingsFile) {
    const suites = {};
    for (const f of files) if (results.has(f)) suites[f] = Math.round(results.get(f).seconds * 10) / 10;
    fs.writeFileSync(timingsFile, JSON.stringify({ suites }, null, 2) + '\n');
  }
  if (shardArg) {
    // One part of the gate: the regression gate's completeness is checked in the part that runs it, and the last
    // line names the part and its count, which the CI gates job adds up across the parts.
    const reg = files.includes(REGRESS) ? await regressIncluded() : { ok: true, line: null };
    if (reg.line) console.log(reg.line);
    const what = `shard ${shardArg.k}/${shardArg.n}: ${files.length} of ${allFiles.length} suites run,`;
    console.log(failed ? `${what} ${failed} FAILED` : reg.ok ? `${what} all passed` : `${what} all exited 0, but the regression gate is incomplete: FAILED`);
    const fl = failedLine(reg.ok);
    if (fl) console.log(fl);
    process.exitCode = failed || !reg.ok ? 1 : 0;
    return;
  }
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
  if (RECORD) {
    if (bad) console.log(`--record-times: not written, the run failed (${path.basename(TIMES_FILE)} is unchanged)`);
    else {
      const suites = {};
      for (const f of files) suites[f] = Math.round(results.get(f).seconds * 10) / 10;
      const note = recordedTimes().note;
      fs.writeFileSync(TIMES_FILE, JSON.stringify(Object.assign(note ? { '//': note } : {}, { suites }), null, 2) + '\n');
      console.log(`--record-times: ${files.length} suite times written to tests/${path.basename(TIMES_FILE)}`);
    }
  }
})();
