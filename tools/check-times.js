// Time each check of a suite individually. Works on a COPY in the system temp directory: it wraps the suite's `check`
// so that the time since the previous check is charged to the check that just ran (the work that produced it), which
// is what a per-check timing means for a suite whose checks sit at the end of the work they verify.
//
//   node tools/check-times.js --times tests/tape-load.test.js
//   node tools/check-times.js --times tests/restore-points.test.js --repo /path/to/worktree
//
// Prints JSON: { suite, wall, okCount, sumMs, checks: [{ name, ms, share }] }, in the order the checks ran. The suite
// itself is not modified.
//
// No process.exit() anywhere in this file: Node 25.2.1 deadlocks in it under load (tests/exitcode.test.js has the
// long version). Every way out sets process.exitCode and returns; the copy is removed in the `finally` and by an
// 'exit' handler, and NOT by a signal handler (see the comment on the cleanup below for why one could not run).
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');

const usage = (msg) => { console.error(msg); process.exitCode = 2; };

function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--times');
  if (ti < 0) return usage('usage: node tools/check-times.js --times <tests/x.test.js> [--repo DIR]');
  const suite = path.basename(args[ti + 1] || '');
  if (!suite) return usage('--times needs a suite file, e.g. --times tests/tape-load.test.js');
  const ri = args.indexOf('--repo');
  const REPO = ri > 0 ? args[ri + 1] : process.cwd();

  // The copy lives in the system temp directory, never inside the repository. It is removed on the two ways out that
  // can run cleanup: the normal end and a throw. Only SIGKILL cannot be caught; the prefix is this tool's name so
  // such a leftover can be found and swept.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-check-times-'));
  const dir = path.join(work, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  // Cleanup runs where it can: in the `finally`, which covers the normal path and a throw. The 'exit' handler covers a
  // top-level throw that skips the finally. A SIGNAL is a different matter and is not handled here: the suite runs
  // through spawnSync, which blocks this process's event loop, so a handler could not run until the child had already
  // finished - by which point nothing needs cleaning. SIGKILL could never be handled anyway. The prefix is this
  // tool's name so a killed run's leftover is findable: rm -rf $TMPDIR/cloadm-check-times-*.
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
  process.on('exit', cleanup);

  try {
    // a full copy (the suites resolve lots of relative paths)
    cp.execFileSync('bash', ['-c', `cd ${JSON.stringify(REPO)} && tar -cf - . | tar -xf - -C ${JSON.stringify(dir)}`]);

    // The suite may define `check` itself or import it from a shared module (the state suites use state-common.js),
    // so the wrapper is installed wherever the name is DEFINED, not in the suite file. Both shapes are known here.
    const WRAP = `const __t = []; let __last = process.hrtime.bigint();
const __wrap = (name, cond, detail) => { const now = process.hrtime.bigint(); __t.push([name, Number(now - __last) / 1e6]); __last = now; };
process.on('exit', () => { try { require('fs').writeFileSync(${JSON.stringify(path.join(work, 'times.json'))}, JSON.stringify(__t)); } catch (e) {} });
const check = (name, cond, detail = '') => { __wrap(name, cond, detail);`;
    // Where `check` is DEFINED: in the suite itself, or in a `./x.js` it requires and imports `check` from. The state
    // suites use state-common.js; another suite could use any helper, so the file is found from the suite's own
    // require lines rather than by naming one module.
    const suitePath = path.join(dir, 'tests', suite);
    const suiteSrc = fs.readFileSync(suitePath, 'utf8');
    const candidates = [suitePath];
    for (const m of suiteSrc.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const mod = path.join(dir, 'tests', m[1]);
      const withJs = mod.endsWith('.js') ? mod : `${mod}.js`;
      if (fs.existsSync(withJs) && /\bcheck\b/.test(suiteSrc.slice(0, suiteSrc.indexOf(m[0]) + 400))) candidates.push(withJs);
    }
    const marker = "const check = (name, cond, detail = '') => {";
    let installed = false;
    for (const file of candidates) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes(marker)) continue;
      fs.writeFileSync(file, src.replace(marker, WRAP));
      installed = true;
      break;
    }
    if (!installed) return usage(`check() not found in ${suite} or a module it requires: the tool looks for the shape \"const check = (name, cond, detail = '') => {\"`);

    const t0 = Date.now();
    const r = cp.spawnSync(process.execPath, [path.join('tests', suite)], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    const wall = (Date.now() - t0) / 1000;
    let times = [];
    try { times = JSON.parse(fs.readFileSync(path.join(work, 'times.json'), 'utf8')); } catch (e) { /* none */ }
    cleanup();
    if (!times.length) { console.error('no times recorded; suite output:\n', (r.stdout || '').slice(-600)); return usage(''); }
    const sum = times.reduce((a, [, ms]) => a + ms, 0);
    const okCount = (r.stdout || '').split('\n').filter((l) => l.startsWith('ok ')).length;
    console.log(JSON.stringify({ suite, wall, okCount, sumMs: sum, checks: times.map(([name, ms]) => ({ name, ms, share: sum ? ms / sum : 0 })) }));
  } finally {
    cleanup();
  }
}

main();
