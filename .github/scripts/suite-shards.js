// The CI gate runs `node tests/all.js` as n parts on n runners (`--shard i/n`). This checks, from the parts' own
// logs, that together they were the whole gate: every part 1..n reported, all for the same n; the suite lines
// ("pass  x.test.js ..." or "FAIL  x.test.js ...") across the parts are every suite `node tests/all.js --list` names,
// each exactly once; each part's count line ("shard i/n: k of total suites run, ...") matches its suite lines, the
// counts sum to the total and the total is the list's length; and exactly one part checked the regression gate
// ("regress N/N included", not INCOMPLETE). Whether each part PASSED is its own job's result; this only proves that
// nothing went unrun.
//
//   node .github/scripts/suite-shards.js all-1.log all-2.log ...
//
// Exit 0 with one summary line, or 1 naming every problem. The suite list comes from the checkout's tests/all.js
// (SUITE_LIST_FROM=<file> reads it from a file instead, for the self-test, tests/suite-shards.test.js).
const fs = require('fs'), path = require('path'), cp = require('child_process');

const logs = process.argv.slice(2);
const errors = [];
const list = (process.env.SUITE_LIST_FROM
  ? fs.readFileSync(process.env.SUITE_LIST_FROM, 'utf8')
  : cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'tests', 'all.js'), '--list'], { encoding: 'utf8' }))
  .split('\n').map((l) => l.trim()).filter(Boolean);
if (!list.length) errors.push('node tests/all.js --list printed no suites');
if (!logs.length) errors.push('no shard logs given: no part of the gate reported');

const seen = new Map();   // suite -> [part, ...]
const parts = new Map();  // k -> { n, count, total, file }
let regressChecks = 0;
for (const file of logs) {
  const text = fs.readFileSync(file, 'utf8');
  const head = [...text.matchAll(/^shard (\d+)\/(\d+): (\d+) of (\d+) suites run,/gm)];
  if (head.length !== 1) { errors.push(`${file}: ${head.length ? 'more than one' : 'no'} "shard i/n: k of total suites run" line (the part did not finish)`); continue; }
  const [, k, n, count, total] = head[0].map(Number);
  if (parts.has(k)) errors.push(`${file}: shard ${k} reported twice (also ${parts.get(k).file})`);
  parts.set(k, { n, count, total, file });
  const suites = [...text.matchAll(/^(?:pass|FAIL) {2}(\S+\.test\.js) /gm)].map((m) => m[1]);
  if (suites.length !== count) errors.push(`${file}: shard ${k}/${n} says ${count} suites but printed ${suites.length} suite lines`);
  for (const s of suites) seen.set(s, [...(seen.get(s) || []), k]);
  for (const m of text.matchAll(/^regress (\d+)\/(\d+) included .*$/gm)) {
    regressChecks++;
    if (/INCOMPLETE/.test(m[0]) || m[1] !== m[2]) errors.push(`${file}: ${m[0]}`);
  }
}

if (parts.size) {
  const ns = new Set([...parts.values()].map((p) => p.n));
  if (ns.size !== 1) errors.push(`the parts disagree on how many there are: ${[...ns].join(', ')}`);
  const n = Math.max(...ns);
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((k) => !parts.has(k));
  if (missing.length) errors.push(`shard${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of ${n} did not report`);
  const totals = new Set([...parts.values()].map((p) => p.total));
  if (totals.size !== 1 || !totals.has(list.length)) errors.push(`the parts' totals (${[...totals].join(', ')}) are not the ${list.length} suites --list names`);
  const sum = [...parts.values()].reduce((a, p) => a + p.count, 0);
  if (sum !== list.length) errors.push(`the parts ran ${sum} suites between them, not the ${list.length} of the gate`);
}
const unrun = list.filter((s) => !seen.has(s));
const twice = [...seen].filter(([, ks]) => ks.length > 1).map(([s, ks]) => `${s} (shards ${ks.join(', ')})`);
const stranger = [...seen.keys()].filter((s) => !list.includes(s));
if (unrun.length) errors.push(`in no part (never ran): ${unrun.join(', ')}`);
if (twice.length) errors.push(`in more than one part: ${twice.join(', ')}`);
if (stranger.length) errors.push(`ran but not in the gate's list: ${stranger.join(', ')}`);
if (regressChecks !== 1) errors.push(`the regression gate's completeness was checked ${regressChecks} times, not once`);

if (errors.length) {
  console.error('all.js shards: FAILED\n  ' + errors.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(`all.js shards complete: ${list.length} suites in ${parts.size} parts (${[...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k).count).join('+')}), each exactly once; regression gate checked`);
}
