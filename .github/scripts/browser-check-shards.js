// The browser check's CI shards (.github/browser-check-shards.json) must cover every group the check knows,
// each exactly once, and name no group it doesn't know. Otherwise a new group would silently go unrun in CI, or
// a misspelt one would make a shard run nothing and pass.
//
//   node .github/scripts/browser-check-shards.js            # check; exit 1 with the difference if incomplete
//   node .github/scripts/browser-check-shards.js --matrix   # check, then print the GitHub Actions matrix JSON
//   node .github/scripts/browser-check-shards.js --shard N 'a,b'   # check, and that 'a,b' is exactly shard N's groups
//                                                                   (what a CI shard passes to --only, as it arrives)
//
// The group list is the browser check's own: `node tools/browser-check.js --list-groups` prints the names in its
// GROUPS table, the same list `--only` is validated against and the run iterates. Nothing is maintained by hand on
// that side, and nothing is parsed out of the source.
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// For the self-test (tests/browser-check-shards.test.js): BROWSER_CHECK runs another copy of the browser check, and
// BROWSER_CHECK_SHARDS reads another shard file.
const CHECK = process.env.BROWSER_CHECK || path.join(ROOT, 'tools', 'browser-check.js');
const SHARDS = process.env.BROWSER_CHECK_SHARDS || path.join(__dirname, '..', 'browser-check-shards.json');

const errors = [];
const listed = cp.spawnSync(process.execPath, [CHECK, '--list-groups'], { encoding: 'utf8' });
const known = listed.status === 0 ? listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
if (listed.status !== 0) errors.push(`node ${path.relative(ROOT, CHECK)} --list-groups failed (exit ${listed.status}): ${(listed.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
else if (!known.length) errors.push(`node ${path.relative(ROOT, CHECK)} --list-groups printed no groups`);
else if (known.some((g) => !/^[A-Za-z][A-Za-z0-9]*$/.test(g)) || new Set(known).size !== known.length) errors.push(`--list-groups printed something that is not a list of distinct group names: ${JSON.stringify(known)}`);
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
  console.log(`browser-check shards complete: ${known.length} groups in ${shards.length} shards, each exactly once`);
}
