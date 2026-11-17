// The browser check's CI shards (.github/browser-check-shards.json) must cover every group the check knows,
// each exactly once, and name no group it doesn't know. Otherwise a new group would silently go unrun in CI, or
// a misspelt one would make a shard run nothing and pass.
//
//   node .github/scripts/browser-check-shards.js            # check; exit 1 with the difference if incomplete
//   node .github/scripts/browser-check-shards.js --matrix   # check, then print the GitHub Actions matrix JSON
//   node .github/scripts/browser-check-shards.js --shard N 'a,b'   # check, and that 'a,b' is exactly shard N's groups
//                                                                   (what a CI shard passes to --only, as it arrives)
//
// The group list is read from tools/browser-check.js itself: every `want('<group>')` in it is a group that
// `--only <group>` selects (want() is the only thing --only feeds). Nothing is maintained by hand on that side.
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'tools', 'browser-check.js'), 'utf8');
const known = [...new Set([...source.matchAll(/\bwant\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
const { shards } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'browser-check-shards.json'), 'utf8'));

const errors = [];
// A browser-check that no longer selects groups through want('...') can't be checked this way: fail loudly
// rather than pass on an empty list.
const calls = (source.match(/\bwant\(/g) || []).length, literal = [...source.matchAll(/\bwant\(\s*'([^']+)'\s*\)/g)].length;
if (calls !== literal) errors.push(`tools/browser-check.js has ${calls - literal} want(...) call(s) whose group isn't a single-quoted literal; this check can't see them`);
if (known.length < 10) errors.push(`found only ${known.length} groups in tools/browser-check.js (want('...') calls); has --only changed?`);
if (!Array.isArray(shards) || !shards.length || shards.some((s) => !Array.isArray(s) || !s.length)) errors.push('shards must be a non-empty list of non-empty group lists');
else {
  const listed = shards.flat();
  const count = new Map();
  for (const g of listed) count.set(g, (count.get(g) || 0) + 1);
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
