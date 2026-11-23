// The browser check's CI shards (.github/browser-check-shards.json) must cover every group the check knows,
// each exactly once, and name no group it doesn't know. Otherwise a new group would silently go unrun in CI, or
// a misspelt one would make a shard run nothing and pass.
//
// The shard file is generated, not edited: it is the plan this script makes from the measured group times in
// .github/browser-check-timings.json (longest group first, each onto the shard with the least time so far, the
// groups of a shard then kept in the check's own run order). The check fails when the file is not that plan, so a
// timings change that is not written out, or a hand edit, cannot reach CI.
//
//   node .github/scripts/browser-check-shards.js            # check; exit 1 with the difference if incomplete or stale
//   node .github/scripts/browser-check-shards.js --matrix   # check, then print the GitHub Actions matrix JSON
//   node .github/scripts/browser-check-shards.js --shard N 'a,b'   # check, and that 'a,b' is exactly shard N's groups
//                                                                   (what a CI shard passes to --only, as it arrives)
//   node .github/scripts/browser-check-shards.js --write    # rewrite the shard file from the timings
//   node .github/scripts/browser-check-shards.js --merge t1.json [t2.json ...]
//        # take the group times from `node tools/browser-check.js --timings tN.json` runs into the timings file
//        # (those groups only), drop groups the check no longer has, then --write. A group already timed keeps a
//        # smoothed time, an exponential moving average: new = s * measured + (1 - s) * old, with s the file's
//        # "smoothing" (0 < s <= 1). One noisy run then moves a group by only s of its error (a group's time on CI varies
//        # 20-30% between runs, measured 2026-11-23), so it cannot swing the plan. A group with no time yet takes its
//        # measured time as it is. The files are applied in the order given (oldest run first); a group measured in
//        # two of them is averaged twice.
//   node .github/scripts/browser-check-shards.js --merge-out OUT t1.json ...   # the same merge into OUT, nothing else
//        # written (the CI `gates` job uses it to publish the run's own times)
//
// The group list is the browser check's own: `node tools/browser-check.js --list-groups` prints the names in its
// GROUPS table, the same list `--only` is validated against and the run iterates. Nothing is maintained by hand on
// that side, and nothing is parsed out of the source.
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// For the self-test (tests/browser-check-shards.test.js): BROWSER_CHECK runs another copy of the browser check,
// BROWSER_CHECK_SHARDS reads another shard file and BROWSER_CHECK_TIMINGS another timings file.
const CHECK = process.env.BROWSER_CHECK || path.join(ROOT, 'tools', 'browser-check.js');
const SHARDS = process.env.BROWSER_CHECK_SHARDS || path.join(__dirname, '..', 'browser-check-shards.json');
const TIMINGS = process.env.BROWSER_CHECK_TIMINGS || path.join(__dirname, '..', 'browser-check-timings.json');
const rel = (f) => path.relative(ROOT, f);

// The plan: { shards: [[group, ...], ...], seconds: [total, ...] }. Deterministic: ties go to the lower shard and,
// among groups, to the earlier one in run order.
function plan(known, timings) {
  const n = timings.shards;
  const order = new Map(known.map((g, i) => [g, i]));
  const byCost = [...known].sort((a, b) => timings.groups[b] - timings.groups[a] || order.get(a) - order.get(b));
  const shards = Array.from({ length: n }, () => []), seconds = new Array(n).fill(0);
  for (const g of byCost) {
    let k = 0;
    for (let i = 1; i < n; i++) if (seconds[i] < seconds[k] - 1e-9) k = i;
    shards[k].push(g);
    seconds[k] += timings.groups[g];
  }
  for (const s of shards) s.sort((a, b) => order.get(a) - order.get(b));
  return { shards, seconds: seconds.map((s) => Math.round(s)) };
}

const errors = [];
const listed = cp.spawnSync(process.execPath, [CHECK, '--list-groups'], { encoding: 'utf8' });
const known = listed.status === 0 ? listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
if (listed.status !== 0) errors.push(`node ${rel(CHECK)} --list-groups failed (exit ${listed.status}): ${(listed.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
else if (!known.length) errors.push(`node ${rel(CHECK)} --list-groups printed no groups`);
else if (known.some((g) => !/^[A-Za-z][A-Za-z0-9]*$/.test(g)) || new Set(known).size !== known.length) errors.push(`--list-groups printed something that is not a list of distinct group names: ${JSON.stringify(known)}`);

const timings = JSON.parse(fs.readFileSync(TIMINGS, 'utf8'));

// --merge / --merge-out: measured times in, the timings file (or OUT) out
const mi = process.argv.indexOf('--merge'), mo = process.argv.indexOf('--merge-out');
if ((mi > 0 || mo > 0) && !errors.length) {
  const out = mo > 0 ? process.argv[mo + 1] : TIMINGS;
  const inputs = process.argv.slice((mo > 0 ? mo : mi) + (mo > 0 ? 2 : 1)).filter((a) => !a.startsWith('--'));
  if (!inputs.length) { console.error('--merge needs one or more files written by node tools/browser-check.js --timings FILE'); process.exitCode = 2; return; }
  const alpha = timings.smoothing;
  if (!(Number.isFinite(alpha) && alpha > 0 && alpha <= 1)) { console.error(`${rel(TIMINGS)}: "smoothing" must be a number in (0, 1], not ${JSON.stringify(alpha)}`); process.exitCode = 2; return; }
  const groups = {};
  for (const g of known) if (g in timings.groups) groups[g] = timings.groups[g];
  for (const f of inputs) {
    for (const [g, s] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).groups || {})) {
      if (!known.includes(g) || !Number.isFinite(s) || s < 0) continue;
      groups[g] = g in groups ? Math.round((alpha * s + (1 - alpha) * groups[g]) * 10) / 10 : s;
    }
  }
  const sorted = Object.fromEntries(known.filter((g) => g in groups).map((g) => [g, groups[g]]));
  fs.writeFileSync(out, JSON.stringify({ ...timings, groups: sorted }, null, 2) + '\n');
  console.log(`${rel(path.resolve(out))}: ${Object.keys(sorted).length} groups timed, from ${inputs.length} file(s)`);
  if (mo > 0) return;
  timings.groups = sorted;
  process.argv.push('--write');
}

// The timings must time every group the check has, and only those, with a whole number of shards to spread them over.
if (!errors.length) {
  if (!(Number.isFinite(timings.smoothing) && timings.smoothing > 0 && timings.smoothing <= 1)) errors.push(`${rel(TIMINGS)}: "smoothing" must be a number in (0, 1], not ${JSON.stringify(timings.smoothing)}`);
  if (!Number.isInteger(timings.shards) || timings.shards < 1) errors.push(`${rel(TIMINGS)}: "shards" must be a whole number of CI shards, not ${JSON.stringify(timings.shards)}`);
  const g = timings.groups || {};
  const untimed = known.filter((n) => !Number.isFinite(g[n]) || g[n] < 0);
  const extra = Object.keys(g).filter((n) => !known.includes(n));
  if (untimed.length) errors.push(`no time in ${rel(TIMINGS)} for: ${untimed.join(', ')} (time it: node tools/browser-check.js --only ${untimed.join(',')} --timings t.json, then node .github/scripts/browser-check-shards.js --merge t.json)`);
  if (extra.length) errors.push(`${rel(TIMINGS)} times groups the check does not have: ${extra.join(', ')} (node .github/scripts/browser-check-shards.js --merge drops them)`);
}

if (process.argv.includes('--write') && !errors.length) {
  const p = plan(known, timings);
  const total = p.seconds.reduce((a, b) => a + b, 0);
  fs.writeFileSync(SHARDS, JSON.stringify({
    '//': `GENERATED by node .github/scripts/browser-check-shards.js --write from ${path.basename(TIMINGS)} (serial total ${total} s: `
      + `shards ${p.seconds.join('/')} s). Do not edit; change the timings and write it again.`,
    shards: p.shards,
  }, null, 2) + '\n');
  console.log(`${rel(SHARDS)}: ${known.length} groups in ${p.shards.length} shards of ${p.seconds.join('/')} s`);
  return;
}

const { shards } = JSON.parse(fs.readFileSync(SHARDS, 'utf8'));

if (!known.length) { /* reported above; every shard name would be "unknown" */ }
else if (!Array.isArray(shards) || !shards.length || shards.some((s) => !Array.isArray(s) || !s.length)) errors.push('shards must be a non-empty list of non-empty group lists');
else {
  const count = new Map();
  for (const g of shards.flat()) count.set(g, (count.get(g) || 0) + 1);
  const missing = known.filter((g) => !count.has(g));
  const unknown = [...count.keys()].filter((g) => !known.includes(g));
  const twice = [...count].filter(([, n]) => n > 1).map(([g]) => g);
  if (missing.length) errors.push(`in no shard (would never run in CI): ${missing.join(', ')}`);
  if (unknown.length) errors.push(`not a browser-check group: ${unknown.join(', ')}`);
  if (twice.length) errors.push(`in more than one shard: ${twice.join(', ')}`);
  // ...and the shards are the plan the timings give (only when the timings themselves are sound, reported above)
  if (!errors.length && JSON.stringify(plan(known, timings).shards) !== JSON.stringify(shards)) {
    errors.push(`${rel(SHARDS)} is not the plan ${rel(TIMINGS)} gives (stale or edited by hand): run node .github/scripts/browser-check-shards.js --write`);
  }
}

// The argument a shard job is about to pass to --only must be exactly that shard's list: an --only naming no
// group runs no group and passes, so a value lost or mangled on its way (a shell variable, a matrix expression)
// must fail here rather than turn a shard green.
const si = process.argv.indexOf('--shard');
if (si > 0 && !errors.length) {
  const n = Number(process.argv[si + 1]), arg = process.argv[si + 2];
  const expect = Number.isInteger(n) && shards[n - 1] ? shards[n - 1].join(',') : null;
  if (expect === null) errors.push(`no shard ${process.argv[si + 1]}`);
  else if (arg !== expect) errors.push(`shard ${n} would run --only ${JSON.stringify(arg)}, not its groups ${JSON.stringify(expect)}`);
}

if (errors.length) {
  console.error('browser-check shards: FAILED\n  ' + errors.join('\n  '));
  process.exitCode = 1;
} else if (process.argv.includes('--matrix')) {
  console.log(JSON.stringify({ include: shards.map((groups, i) => ({ shard: i + 1, groups: groups.join(',') })) }));
} else if (si > 0) {
  console.log(`shard ${process.argv[si + 1]}: --only ${process.argv[si + 2]}`);
} else {
  const secs = plan(known, timings).seconds;
  console.log(`browser-check shards complete: ${known.length} groups in ${shards.length} shards, each exactly once (planned ${secs.join('/')} s)`);
}
