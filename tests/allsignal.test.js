// The suite runner's signal handling: a signal must stop every running suite, leaving no process behind, and
// exit with 128+n as the signal would have. A suite is spawned detached (its own process group) so a timeout can
// kill it and anything it spawned -- which also means a signal to the runner does NOT reach it, so the runner has
// to kill them itself.
//
// Uses a scratch copy of the runner beside a suite that hangs and spawns a child. The real tree is only read.
// Run: node tests/allsignal.test.js
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsignal-'));
// A token unique to this run, in the hanging suite's name and its child's argv. Five agents run suites on this
// machine at once, so counting survivors by a shared name would count theirs and make this a flake.
const TOKEN = `allsignal-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// A copy of the repo's runner plus a suite that never finishes and spawns a child. It sorts first so it is
// running by the time the signal arrives (the runner starts suites in file order).
// no-exit.js must be copied beside it: the runner preloads it into every suite with NODE_OPTIONS (tests/all.js),
// and a missing preload module makes Node exit 1 before the suite runs a line -- the runner then exits before the
// signal is sent and nothing here would be tested.
const tests = path.join(dir, 'tests');
fs.mkdirSync(tests, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'all.js'), path.join(tests, 'all.js'));
fs.copyFileSync(path.join(__dirname, 'no-exit.js'), path.join(tests, 'no-exit.js'));
// all.js requires tests/suite-verdict.js for the summary rule; without it beside the copy the runner fails to load
fs.copyFileSync(path.join(__dirname, 'suite-verdict.js'), path.join(tests, 'suite-verdict.js'));
fs.writeFileSync(path.join(tests, `AA-${TOKEN}.test.js`), [
  "const cp = require('child_process');",
  `cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '${TOKEN}'], { stdio: 'ignore' });`,
  'setInterval(() => {}, 1000);',
].join('\n'));

const survivors = () => {
  const r = cp.spawnSync('pgrep', ['-f', TOKEN], { encoding: 'utf8' });
  return (r.stdout || '') .split('\n').filter(Boolean).filter((pid) => pid !== String(process.pid));
};
const sweep = () => { try { cp.spawnSync('pkill', ['-f', TOKEN]); } catch (e) {} };

// Start the runner, wait until the hang suite is up, send `sig`, and report the exit code and any survivors.
// Run the runner directly and send it the signal. Node reports a signal death as { code: null, signal }, which is
// the same event a shell turns into 128+n; the check below converts it the way a shell does, so the assertion is
// the exit status a person or the gate would actually see.
const SIG_NO = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
// The runner runs as it does at the top of the gate: without the exit guard. Under tests/all.js this file inherits
// NODE_OPTIONS=--require .../no-exit.js, and the guard would block the runner's own re-raise of the signal
// (process.kill(process.pid, sig)), so the runner would exit 1 here and never in real use. Only that one --require
// is dropped; the copied runner puts the guard back for the suites it starts, as the real one does.
const runnerEnv = Object.assign({}, process.env, {
  NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require\s+("[^"]*no-exit\.js"|\S*no-exit\.js)/g, '').trim(),
});
// runnerPath defaults to the scratch runner built from the real tests/all.js above; the early-death check below
// passes its own, so the same run() -- the exit listener, the timer, the early flag -- is what is exercised.
function run(sig, waitMs = 6000, runnerPath = path.join(tests, 'all.js')) {
  return new Promise((done) => {
    const p = cp.spawn(process.execPath, [runnerPath, '--jobs', '2'], { stdio: 'ignore', env: runnerEnv });
    let sent = false, giveUp = null;
    // listen from the start: a runner that exits before the signal is a failure reported as such (early: true),
    // not an exit nobody hears, which would end this file silently with status 0
    p.on('exit', (code, signal) => {
      clearTimeout(wait); clearTimeout(giveUp);
      const left = survivors();
      sweep();
      done({ code: code === null && signal ? 128 + SIG_NO[signal] : code, signal, left, early: !sent });
    });
    const wait = setTimeout(() => {
      sent = true;
      p.kill(sig);
      giveUp = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 15000);
    }, waitMs);
    p.on('error', () => { clearTimeout(wait); done({ code: null, signal: null, left: [], early: true }); });
  });
}
// the file always ends with its summary: if the checks never finish, that is a failure, not a silent 0
let finished = false;
process.on('beforeExit', () => { if (!finished) { finished = true; console.log('FAIL the checks did not finish'); process.exitCode = 1; } });

(async () => {
  const r = await run('SIGINT');
  check('SIGINT: the runner is still running its suites when the signal is sent', !r.early, `code ${r.code}`);
  check('SIGINT: the runner exits 130 (128 + 2)', r.code === 130, `code ${r.code}`);
  check('SIGINT: no suite or child survives', r.left.length === 0, r.left.join(' '));

  const t = await run('SIGTERM');
  check('SIGTERM: the runner is still running its suites when the signal is sent', !t.early, `code ${t.code}`);
  check('SIGTERM: the runner exits 143 (128 + 15)', t.code === 143, `code ${t.code}`);
  check('SIGTERM: no suite or child survives', t.left.length === 0, t.left.join(' '));

  // The checks above are only worth something if run() settles for a runner that dies early and never skips a
  // signal: a runner that exits before the 6 s timer would otherwise leave the promise unsettled, and Node would
  // exit 0 with the checks never run -- the silent pass that hid this suite's problems. This drives the SAME run()
  // against a runner that exits at once: it must reach run()'s exit handler and report the wrong code, which
  // the checks above turn into a FAIL. Swallowing it into a hang or a silent 0 is what this rules out.
  //
  // The signal timer is set far out (60 s) on purpose: the point is what happens when the child dies BEFORE any
  // signal, so the signal must not fire first. A short wait was a flake under load -- Node had not finished
  // starting the broken runner by the time the signal arrived, so it died with 130 (SIGINT) instead of 1, and the
  // check failed for the wrong reason. The child is one line that exits at once, so the exit handler settles the
  // promise in well under a second and clears this timer; if it ever hung, run() would signal at 60 s and report
  // 130, still a loud failure rather than a silent pass.
  {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsignal-broken-'));
    const brokenRunner = path.join(brokenDir, 'all.js');
    fs.writeFileSync(brokenRunner, 'process.exitCode = 1;\n');   // dies before the timer fires
    const early = await run('SIGINT', 60000, brokenRunner);
    fs.rmSync(brokenDir, { recursive: true, force: true });
    check('a runner that exits before the timer still settles run(), reported as early (not a silent hang)',
      early && early.code === 1 && early.signal === null && early.early === true, JSON.stringify(early));
  }

  fs.rmSync(dir, { recursive: true, force: true });
  sweep();
  finished = true;
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
