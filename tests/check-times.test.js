// Run: node tests/check-times.test.js
//
// tools/check-times.js times each check of a suite. Two things must hold: it works when the suite DEFINES `check`
// and when it IMPORTS it (the state suites import it from state-common.js), and it leaves no copy behind.
//
// It is exercised on tiny fixture suites under tests/fixture-check-times (a few milliseconds each), never on a real suite:
// a test that spent 20 s proving a timing tool reports timings would be its own problem.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cloadm-check-times-'));
const before = leftovers().length;

const run = (suite) => {
  const r = cp.spawnSync(process.execPath, [path.join('tools', 'check-times.js'), '--times', suite], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch (e) { /* not JSON */ }
  return { code: r.status, json, err: (r.stderr || '').trim() };
};

// a suite that defines its own check
{
  const r = run('tests/fixture-check-times-defines.test.js');
  check('a suite that DEFINES check is timed', r.code === 0 && r.json && r.json.checks.length === 3, r.code === 0 ? JSON.stringify(r.json && r.json.checks.map((c) => c.name)) : r.err);
  check('its checks are named, with a ms and a share each', !!(r.json && r.json.checks.every((c) => typeof c.name === 'string' && c.ms >= 0 && c.share >= 0 && c.share <= 1)));
  check('the shares add up to 1 (every millisecond is charged to a check)', !!(r.json && Math.abs(r.json.checks.reduce((a, c) => a + c.share, 0) - 1) < 1e-9),
    r.json && String(r.json.checks.reduce((a, c) => a + c.share, 0)));
}
// a suite that IMPORTS check from a shared module: the shape the state suites use
{
  const r = run('tests/fixture-check-times-imports.test.js');
  check('a suite that IMPORTS check is timed too (the state suites import it)', r.code === 0 && r.json && r.json.checks.length === 2,
    r.code === 0 ? JSON.stringify(r.json && r.json.checks.map((c) => c.name)) : r.err);
}
// a suite with neither shape is refused rather than silently reported as 0 checks
{
  const r = run('tests/fixture-check-times-nocheck.test.js');
  check('a suite with no check() shape is refused (exit 2), not reported as 0 checks', r.code === 2 && /not found/.test(r.err), `exit ${r.code} ${r.err.split('\n')[0]}`);
}
// no copy left behind
check('no copy is left in the temp directory after any of those runs', leftovers().length === before, `${leftovers().length - before} left`);

console.log(fail ? `\n${fail} FAILED` : '\nall check-times checks passed');
process.exitCode = fail ? 1 : 0;
