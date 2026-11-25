#!/usr/bin/env node
// Compare two black-box result files (tools/basic-bb/run.js): the real ROM's and ours. Case by case, the status and
// the transcript line by line; the first differing line of each case is shown with its neighbours.
//   node tools/basic-bb/compare.js real.jsonl ours.jsonl      exit 1 if any case differs or is missing
const fs = require('fs');

const read = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.case, r]));

function compare(a, b) {
  const out = [];
  let same = 0;
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) { out.push(`${name}: missing from the second file`); continue; }
    if (x.status !== y.status) { out.push(`${name}: status ${x.status} vs ${y.status}`); continue; }
    const n = Math.max(x.transcript.length, y.transcript.length);
    let at = -1;
    for (let i = 0; i < n; i++) if (x.transcript[i] !== y.transcript[i]) { at = i; break; }
    if (at < 0) { same++; continue; }
    const show = (t, i) => (i < t.length ? JSON.stringify(t[i]) : '(none)');
    out.push(`${name}: line ${at + 1} differs`);
    for (let i = Math.max(0, at - 2); i <= Math.min(n - 1, at + 2); i++) out.push(`  ${i === at ? '>' : ' '} ${show(x.transcript, i).padEnd(36)} ${show(y.transcript, i)}`);
  }
  for (const name of b.keys()) if (!a.has(name)) out.push(`${name}: missing from the first file`);
  return { same, report: out };
}
module.exports = { compare };

if (require.main === module) {
  const [f1, f2] = process.argv.slice(2);
  if (!f1 || !f2) {
    console.error('usage: node tools/basic-bb/compare.js real.jsonl ours.jsonl');
    process.exitCode = 2;
  } else {
    const { same, report } = compare(read(f1), read(f2));
    for (const l of report) console.log(l);
    console.log(`${same} cases identical`);
    process.exitCode = report.length ? 1 : 0;
  }
}
