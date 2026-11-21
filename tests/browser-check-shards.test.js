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
const groups = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'browser-check.js'), '--list-groups'], { encoding: 'utf8' }).trim().split('\n');

// A copy of the browser check runs from tmp/tools, beside links to what it requires (its lib, and tests/ for the emulator).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-'));
fs.mkdirSync(path.join(dir, 'tools'));
fs.symlinkSync(path.join(ROOT, 'tools', 'browser-check-lib.js'), path.join(dir, 'tools', 'browser-check-lib.js'));
fs.symlinkSync(path.join(ROOT, 'tests'), path.join(dir, 'tests'));
// the check also reads js/host/audio.js for SETTLE_MS (the tone check's settle bound), so the copy needs js/ too
fs.symlinkSync(path.join(ROOT, 'js'), path.join(dir, 'js'));
let n = 0;
function run({ check = realCheck, shards = realShards, args = [] } = {}) {
  const c = path.join(dir, 'tools', `browser-check-${++n}.js`), s = path.join(dir, `shards-${n}.json`);
  fs.writeFileSync(c, check);
  fs.writeFileSync(s, JSON.stringify(shards));
  return cp.spawnSync(process.execPath, [script, ...args], { env: { ...process.env, BROWSER_CHECK: c, BROWSER_CHECK_SHARDS: s }, encoding: 'utf8' });
}
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

  // --shard N 'list': the --only argument a shard job is about to pass must be exactly its shard's list.
  const first = realShards.shards[0].join(',');
  assert.strictEqual(run({ args: ['--shard', '1', first] }).status, 0, 'shard 1 with its own list passes');
  fails(run({ args: ['--shard', '1', ''] }), /shard 1 would run --only ""/, 'a shard given an empty --only');
  fails(run({ args: ['--shard', '1', realShards.shards[1].join(',')] }), /shard 1 would run --only/, 'a shard given another shard\'s list');
  fails(run({ args: ['--shard', '9', first] }), /no shard 9/, 'a shard number that does not exist');
  console.log('all browser-check-shards self-test checks passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
