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
const tests = path.join(dir, 'tests');
fs.mkdirSync(tests, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'all.js'), path.join(tests, 'all.js'));
// the runner preloads tests/no-exit.js into every suite it starts; without it beside the copy every suite dies at
// once, the runner exits before the signal is sent, and nothing here would be tested
fs.copyFileSync(path.join(__dirname, 'no-exit.js'), path.join(tests, 'no-exit.js'));
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
function run(sig, waitMs = 6000) {
  return new Promise((done) => {
    const p = cp.spawn(process.execPath, [path.join(tests, 'all.js'), '--jobs', '2'], { stdio: 'ignore', env: runnerEnv });
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

  fs.rmSync(dir, { recursive: true, force: true });
  sweep();
  finished = true;
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
