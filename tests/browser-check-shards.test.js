// The shard completeness check (.github/scripts/browser-check-shards.js) reads the group list from the browser check
// itself (`--list-groups`, its GROUPS table) and must fail when the shards and that list differ in any way: a group in
// no shard, a shard naming a group the check doesn't have (a typo, or a group taken out of GROUPS), a group in two
// shards, a browser check that can't list its groups, and a shard job about to run anything but its own list.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const script = path.join(ROOT, '.github', 'scripts', 'browser-check-shards.js');
const realCheck = fs.readFileSync(path.join(ROOT, 'tools', 'browser-check.js'), 'utf8');
const realShards = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'browser-check-shards.json'), 'utf8'));
const realTimings = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'browser-check-timings.json'), 'utf8'));
const groups = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'browser-check.js'), '--list-groups'], { encoding: 'utf8' }).trim().split('\n');

// A copy of the browser check runs from tmp/tools, beside links to what it requires (its lib, and tests/ for the emulator).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-'));
fs.mkdirSync(path.join(dir, 'tools'));
fs.symlinkSync(path.join(ROOT, 'tools', 'browser-check-lib.js'), path.join(dir, 'tools', 'browser-check-lib.js'));
fs.symlinkSync(path.join(ROOT, 'tests'), path.join(dir, 'tests'));
// the check also reads js/host/audio.js for SETTLE_MS (the tone check's settle bound), so the copy needs js/ too
fs.symlinkSync(path.join(ROOT, 'js'), path.join(dir, 'js'));
let n = 0;
let last = null;   // the files of the latest run(), to read back what --write and --merge wrote
function run({ check = realCheck, shards = realShards, timings = realTimings, args = [] } = {}) {
  const c = path.join(dir, 'tools', `browser-check-${++n}.js`), s = path.join(dir, `shards-${n}.json`), t = path.join(dir, `timings-${n}.json`);
  fs.writeFileSync(c, check);
  fs.writeFileSync(s, JSON.stringify(shards));
  fs.writeFileSync(t, JSON.stringify(timings));
  last = { shards: s, timings: t };
  return cp.spawnSync(process.execPath, [script, ...args], { env: { ...process.env, BROWSER_CHECK: c, BROWSER_CHECK_SHARDS: s, BROWSER_CHECK_TIMINGS: t }, encoding: 'utf8' });
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const fails = (r, re, what) => {
  assert.notStrictEqual(r.status, 0, `${what}: passed\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, re, `${what}: the failure should say ${re}`);
  console.log(`ok   ${what}: fails (${r.stderr.trim().split('\n').slice(1).join(' | ').trim()})`);
};
const guard = (g) => new RegExp(`^  \\['${g}', .*\\],$`, 'm');
try {
  assert.ok(groups.length >= 50 && groups.includes('feedback') && groups.includes('favicon'), `--list-groups: ${groups.join(',')}`);
  // The real files pass, and a copy of them through the fixture does too (so the fixture changes only what each case changes).
  const ok = cp.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`complete: ${groups.length} groups in ${realShards.shards.length} shards`));
  assert.strictEqual(run().status, 0, 'the fixture copy of the real files must pass');
  const matrix = JSON.parse(cp.execFileSync(process.execPath, [script, '--matrix'], { encoding: 'utf8' }));
  assert.deepStrictEqual(matrix.include.flatMap((m) => m.groups.split(',')).sort(), [...groups].sort(), 'the matrix runs every group');
  console.log(`ok   real shards: ${groups.length} groups in ${matrix.include.length} shards, each exactly once`);

  const without = (g) => ({ shards: realShards.shards.map((s) => s.filter((x) => x !== g)) });
  fails(run({ shards: without('nav') }), /in no shard \(would never run in CI\): nav$/m, 'a group in no shard');
  fails(run({ shards: { shards: realShards.shards.map((s, i) => (i === 1 ? [...s, 'navv'] : s)) } }), /not a browser-check group: navv$/m, 'a shard naming an unknown group');
  fails(run({ shards: { shards: realShards.shards.map((s, i) => (i === 2 ? [...s, 'feedback'] : s)) } }), /in more than one shard: feedback$/m, 'a group in two shards');
  fails(run({ shards: { shards: [] } }), /non-empty list/, 'no shards');
  fails(run({ shards: { shards: [...realShards.shards, []] } }), /non-empty list/, 'an empty shard');

  // The browser check's side: a group added to GROUPS and to no shard; a group taken out of GROUPS (commented out, or
  // deleted) that a shard still names. Both mutate the real table.
  assert.match(realCheck, guard('nav'), 'the GROUPS table has no nav entry to mutate');
  fails(run({ check: realCheck.replace(guard('favicon'), (l) => `${l}\n  ['zzNewGroup', (b) => faviconChecks(b, site, check)],`) }), /in no shard \(would never run in CI\): zzNewGroup$/m, 'a new group in GROUPS that no shard runs');
  fails(run({ check: realCheck.replace(guard('nav'), (l) => `  // ${l.trim()}`) }), /not a browser-check group: nav$/m, 'a group commented out of GROUPS that a shard still names');
  fails(run({ check: realCheck.replace(guard('nav'), '') }), /not a browser-check group: nav$/m, 'a group deleted from GROUPS that a shard still names');
  // A browser check that can't list its groups fails the check rather than passing on an empty list.
  fails(run({ check: realCheck.replace("if (process.argv.includes('--list-groups'))", "throw new Error('broken'); if (0)") }), /--list-groups failed/, 'a browser check whose --list-groups fails');
  fails(run({ check: realCheck.replace("console.log(names.join('\\n')); return;", 'return;') }), /printed no groups/, 'a browser check whose --list-groups prints nothing');

  // The shard file is the plan the timings give: --write reproduces the committed file exactly, and a file that is not
  // the plan (a hand edit, or timings changed and not written out) fails; so does a group with no time, or a time for
  // a group the check does not have.
  {
    const w = run({ shards: { shards: [['nav']] }, args: ['--write'] });
    assert.strictEqual(w.status, 0, w.stdout + w.stderr);
    assert.deepStrictEqual(readJson(last.shards).shards, realShards.shards, '--write must reproduce the committed shard file');
    console.log('ok   --write reproduces .github/browser-check-shards.json from the timings');
    const sec = realShards.shards.map((sh) => sh.reduce((a, g) => a + realTimings.groups[g], 0));
    const total = sec.reduce((a, b) => a + b, 0), biggest = Math.max(...Object.values(realTimings.groups));
    const bound = Math.max(biggest, total / sec.length) * 1.15;
    assert.ok(Math.max(...sec) <= bound, `shards ${sec.map(Math.round).join('/')} s: the longest is more than 15% over ${Math.round(bound / 1.15)} s`);
    console.log(`ok   the plan is balanced: ${sec.map(Math.round).join('/')} s (ideal ${Math.round(Math.max(biggest, total / sec.length))} s)`);
  }
  const swapped = realShards.shards.map((sh) => [...sh]);
  { const a = swapped[0].pop(), b = swapped[1].pop(); swapped[0].push(b); swapped[1].push(a); }
  fails(run({ shards: { shards: swapped } }), /is not the plan .* \(stale or edited by hand\)/, 'a shard file that is not the plan (two groups swapped)');
  fails(run({ timings: { ...realTimings, groups: { ...realTimings.groups, nav: realTimings.groups.nav + 500 } } }), /is not the plan/, 'timings changed and the shards not written out');
  { const g = { ...realTimings.groups }; delete g.nav; fails(run({ timings: { ...realTimings, groups: g } }), /no time in .* for: nav /, 'a group with no time'); }
  fails(run({ timings: { ...realTimings, groups: { ...realTimings.groups, zzGone: 3 } } }), /times groups the check does not have: zzGone/, 'a time for a group the check does not have');
  fails(run({ timings: { ...realTimings, shards: 0 } }), /"shards" must be a whole number/, 'no shard count');
  // --merge takes measured times in (only the groups measured), drops groups the check no longer has, and writes the plan.
  {
    const t = path.join(dir, 'measured.json');
    fs.writeFileSync(t, JSON.stringify({ groups: { nav: 777, zzGone: 5 } }));
    const m = run({ timings: { ...realTimings, groups: { ...realTimings.groups, zzOld: 9 } }, args: ['--merge', t] });
    assert.strictEqual(m.status, 0, m.stdout + m.stderr);
    const merged = readJson(last.timings).groups;
    // the smoothed average, computed here from the definition rather than by the script: s * measured + (1 - s) * old
    const a = realTimings.smoothing, ema = Math.round((a * 777 + (1 - a) * realTimings.groups.nav) * 10) / 10;
    assert.ok(a > 0 && a < 1, `the committed smoothing is a real average, not a replacement: ${a}`);
    assert.strictEqual(merged.nav, ema, `a timed group moves by the smoothing weight toward the measured time (${realTimings.groups.nav} -> ${ema}), not to it`);
    assert.ok(merged.nav < 777, 'one noisy run does not set the time');
    assert.strictEqual(merged.favicon, realTimings.groups.favicon, 'an unmeasured group keeps its time');
    assert.ok(!('zzGone' in merged) && !('zzOld' in merged), 'groups the check does not have are dropped');
    assert.ok(readJson(last.shards).shards.flat().includes('nav') && readJson(last.shards).shards.flat().length === groups.length, 'the written plan holds every group');
    const env = { ...process.env, BROWSER_CHECK: path.join(dir, 'tools', `browser-check-${n}.js`), BROWSER_CHECK_SHARDS: last.shards, BROWSER_CHECK_TIMINGS: last.timings };
    const after = cp.spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.strictEqual(after.status, 0, `after --merge the shards are the plan: ${after.stderr}`);
    console.log(`ok   --merge averages the measured groups (nav ${realTimings.groups.nav} + 777 -> ${ema}), keeps the rest, drops unknown ones and writes the plan`);
  }
  // A group new to the check (in GROUPS, not yet timed) takes its first measured time as it is, and the plan written
  // from it passes the shards check; two runs then average in order.
  {
    const withNew = realCheck.replace(guard('favicon'), (l) => `${l}\n  ['zzNewGroup', (b) => faviconChecks(b, site, check)],`);
    const t1 = path.join(dir, 'new1.json'), t2 = path.join(dir, 'new2.json');
    fs.writeFileSync(t1, JSON.stringify({ groups: { zzNewGroup: 40 } }));
    fs.writeFileSync(t2, JSON.stringify({ groups: { zzNewGroup: 60 } }));
    const m = run({ check: withNew, args: ['--merge', t1] });
    assert.strictEqual(m.status, 0, m.stdout + m.stderr);
    assert.strictEqual(readJson(last.timings).groups.zzNewGroup, 40, 'an untimed group takes its measured time');
    const env = { ...process.env, BROWSER_CHECK: path.join(dir, 'tools', `browser-check-${n}.js`), BROWSER_CHECK_SHARDS: last.shards, BROWSER_CHECK_TIMINGS: last.timings };
    const plan = cp.spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.strictEqual(plan.status, 0, `the plan with the new group passes the shards check: ${plan.stderr}`);
    const again = cp.spawnSync(process.execPath, [script, '--merge', t2], { env, encoding: 'utf8' });
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);
    const a = realTimings.smoothing;
    assert.strictEqual(readJson(last.timings).groups.zzNewGroup, Math.round((a * 60 + (1 - a) * 40) * 10) / 10, 'a second run averages with the first');
    console.log('ok   an untimed new group takes its first time, the plan passes, and the next run averages with it');
  }
  fails(run({ timings: { ...realTimings, smoothing: 0 } }), /"smoothing" must be a number in \(0, 1\]/, 'no smoothing weight');
  fails(run({ timings: { ...realTimings, smoothing: 1.5 } }), /"smoothing" must be a number in \(0, 1\]/, 'a smoothing weight above 1');

  // --shard N 'list': the --only argument a shard job is about to pass must be exactly its shard's list.
  const first = realShards.shards[0].join(',');
  assert.strictEqual(run({ args: ['--shard', '1', first] }).status, 0, 'shard 1 with its own list passes');
  fails(run({ args: ['--shard', '1', ''] }), /shard 1 would run --only ""/, 'a shard given an empty --only');
  fails(run({ args: ['--shard', '1', realShards.shards[1].join(',')] }), /shard 1 would run --only/, 'a shard given another shard\'s list');
  fails(run({ args: ['--shard', '9', first] }), /no shard 9/, 'a shard number that does not exist');
  console.log('all browser-check-shards self-test checks passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
