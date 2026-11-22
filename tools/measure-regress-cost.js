// Measure what each regress case really costs, so tests/regress-shards.js's constants come from a measurement and can
// be re-measured when a machine differs a lot. Not a test: a tool, run by hand.
//
//   node tools/measure-regress-cost.js
//
// It runs every case on its own (regress.test.js --only) and fits time against the recorded workload (instructions for
// a trace, frames for a video run), with node startup taken out. Prints the fit the shard constants use, and the
// slowest cases.
//
// The suite is copied ONCE to the system temp directory (every case then runs against that copy) and removed
// afterwards: in a `finally`, so a throw or an early return still removes it, and again from the 'exit' listener. A
// SIGKILL cannot be handled by any process and will leave the copy behind; SIGINT, SIGTERM and SIGHUP are handled and
// remove it. No process.exit() anywhere in this file (tests/exitcode.test.js has the reason: Node 25.2.1 deadlocks in
// it under load); a signal handler re-sends its signal instead.
//
// The copy is the TRACKED tree only (`git ls-files`): tarring the repository root would take .git and every other
// worktree with it, which in the main checkout is 592 MB and about 26 s for the 7.7 MB of files this needs. A tree
// with no .git - one unpacked from a zip - has no tracked list to ask for, so there the copy is a tar of the tree with
// .git, .claude and node_modules excluded: the same files, the same 7.7 MB.
//
//   --limit N   measure only the first N cases (a quick check that the tool still runs; the full run is minutes)
//   --only RE   measure only the cases whose name matches RE (as regress.test.js's own --only does; a /.../ form is a
//               regex, plain words are a substring). The fit needs cases whose cost differs a lot: a handful of the
//               FIRST cases are nearly identical in cost, and on a loaded machine the slope then comes out negative
//               because the difference is smaller than the noise. Pick heavy cases from both kinds instead.
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');

function main() {
  // this file lives in tools/, so the repository is one level up: the hashes are tests/regress-hashes.json
  const REPO = path.join(__dirname, '..');
  const li = process.argv.indexOf('--limit');
  const limit = li > 0 ? Number(process.argv[li + 1]) : 0;
  if (li > 0 && !Number.isInteger(limit)) { console.error('--limit needs a whole number of cases'); process.exitCode = 2; return; }
  const hashes = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'regress-hashes.json'), 'utf8'));
  const oi = process.argv.indexOf('--only');
  let names = Object.keys(hashes);
  if (oi > 0) {
    const arg = process.argv[oi + 1];
    if (!arg) { console.error('--only needs a pattern'); process.exitCode = 2; return; }
    let re;
    try { re = /^\/.*\/$/.test(arg) ? new RegExp(arg.slice(1, -1)) : new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
    catch (e) { console.error(`--only: ${e.message}`); process.exitCode = 2; return; }
    names = names.filter((n) => re.test(n));
    if (!names.length) { console.error(`--only: no case name matches ${arg}`); process.exitCode = 2; return; }
  }
  names = names.slice(0, limit > 0 ? limit : undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-regress-cost-'));
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
  process.on('exit', cleanup);
  // a signal removes the copy, takes ITSELF OFF, and re-sends the same signal so the default disposition ends the
  // process - NOT process.exit(), which tests/exitcode.test.js forbids here and in every suite (Node 25.2.1 deadlocks
  // in it under load). SIGKILL cannot be handled at all; the prefix names such a leftover so it can be swept.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { cleanup(); process.kill(process.pid, sig); });
  }
  try {
    const cmd = fs.existsSync(path.join(REPO, '.git'))
      ? `cd ${JSON.stringify(REPO)} && git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`
      : `cd ${JSON.stringify(REPO)} && tar -cf - --exclude=./.git --exclude=./.claude --exclude=./node_modules . 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`;
    cp.execFileSync('bash', ['-c', cmd]);
    const time = (args) => {
      const t0 = process.hrtime.bigint();
      try { cp.execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', maxBuffer: 8 << 20 }); } catch (e) { /* a case that fails still took its time */ }
      return Number(process.hrtime.bigint() - t0) / 1e9;
    };
    console.log(`measuring ${names.length} cases, one process each...`);
    const out = {};
    for (const n of names) {
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out[n] = { s: time([path.join('tests', 'regress.test.js'), '--only', `/${escaped}$/`]), instructions: hashes[n].instructions, frames: hashes[n].frames };
    }
    // the cost of an empty run, subtracted from each: the process start and the suite's own set-up
    const startup = time([path.join('tests', 'regress.test.js'), '--only', '/^__none_matches_this__$/']);

    const fit = (pts) => {
      const k = pts.length, sx = pts.reduce((a, p) => a + p.x, 0), sy = pts.reduce((a, p) => a + p.y, 0);
      const sxx = pts.reduce((a, p) => a + p.x * p.x, 0), sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
      const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
      return { slope, intercept: (sy - slope * sx) / k };
    };
    const tr = Object.entries(out).filter(([, v]) => v.instructions != null).map(([, v]) => ({ x: v.instructions, y: v.s - startup }));
    const fr = Object.entries(out).filter(([, v]) => v.frames != null).map(([, v]) => ({ x: v.frames, y: v.s - startup }));
    const ft = fit(tr), ff = fit(fr);
    console.log(`\nstartup (s), subtracted: ${startup.toFixed(2)}`);
    console.log(`trace: ${(ft.slope * 1e6).toFixed(2)} us per instruction   (n=${tr.length})  -> TRACE_S = ${ft.slope.toExponential(2)}`);
    console.log(`video: ${(ff.slope * 1e3).toFixed(3)} ms per frame        (n=${fr.length})  -> FRAME_S = ${ff.slope.toExponential(2)}`);
    console.log('\nslowest cases:');
    for (const [n, v] of Object.entries(out).sort((a, b) => b[1].s - a[1].s).slice(0, 12)) console.log(`  ${v.s.toFixed(1).padStart(6)} s  ${n}`);
  } finally {
    cleanup();
  }
}

main();
