#!/usr/bin/env node
// Compare two black-box result files (tools/basic-bb/run.js): the real ROM's and ours. Case by case, the status and
// the transcript line by line; the first differing line of each case is shown with its neighbours.
// Pictures (#screenshot) are compared by the SHA-256 of their pixels; --shots DIR writes both PNGs of each one that
// differs.
//   node tools/basic-bb/compare.js real.jsonl ours.jsonl [--shots DIR]     exit 1 if any case differs or is missing
const fs = require('fs');

const read = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.case, r]));

function compare(a, b, shotDir = null) {
  const out = [];
  let same = 0;
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) { out.push(`${name}: missing from the second file`); continue; }
    if (x.status !== y.status) { out.push(`${name}: status ${x.status} vs ${y.status}`); continue; }
    const n = Math.max(x.transcript.length, y.transcript.length);
    let at = -1;
    for (let i = 0; i < n; i++) if (x.transcript[i] !== y.transcript[i]) { at = i; break; }
    // the pictures: the same names, the same pixels (with --shots DIR, both PNGs of a differing one are written there)
    const sx = x.shots || [], sy = y.shots || [];
    const badShot = sx.length !== sy.length ? `${sx.length} vs ${sy.length} pictures` : sx.map((p, i) => (p.name !== sy[i].name || p.sha256 !== sy[i].sha256 ? p.name : null)).filter(Boolean).join(', ');
    if (badShot) {
      out.push(`${name}: pictures differ: ${badShot}`);
      if (shotDir) sx.forEach((p, i) => { if (sy[i] && p.sha256 !== sy[i].sha256) for (const [tag, q] of [['first', p], ['second', sy[i]]]) fs.writeFileSync(require('path').join(shotDir, `${name}-${q.name}-${tag}.png`), Buffer.from(q.png, 'base64')); });
    }
    if (at < 0 && !badShot) { same++; continue; }
    if (at < 0) continue;
    const show = (t, i) => (i < t.length ? JSON.stringify(t[i]) : '(none)');
    out.push(`${name}: line ${at + 1} differs`);
    for (let i = Math.max(0, at - 2); i <= Math.min(n - 1, at + 2); i++) out.push(`  ${i === at ? '>' : ' '} ${show(x.transcript, i).padEnd(36)} ${show(y.transcript, i)}`);
  }
  for (const name of b.keys()) if (!a.has(name)) out.push(`${name}: missing from the first file`);
  return { same, report: out };
}
module.exports = { compare };

if (require.main === module) {
  const args = process.argv.slice(2), si = args.indexOf('--shots');
  const shotDir = si >= 0 ? args[si + 1] : null;
  const [f1, f2] = args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1));
  if (!f1 || !f2) {
    console.error('usage: node tools/basic-bb/compare.js real.jsonl ours.jsonl');
    process.exitCode = 2;
  } else {
    const { same, report } = compare(read(f1), read(f2), shotDir);
    for (const l of report) console.log(l);
    console.log(`${same} cases identical`);
    process.exitCode = report.length ? 1 : 0;
  }
}
