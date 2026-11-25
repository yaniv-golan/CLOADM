#!/usr/bin/env node
// What a corpus run (tools/basic-bb/corpus.js) says about the programs as a whole, from its counts only: how many
// ended in each status, why runs were not made or were stopped (the lint's kinds, the guard), and for each keyword
// how many programs use it and how often. It reads no program text, so it works the same on hashed results.
//   node tools/basic-bb/corpus-stats.js results.jsonl [--json]
const fs = require('fs');

function stats(records) {
  const status = {}, lint = {}, kw = {};
  for (const r of records) {
    status[r.status] = (status[r.status] || 0) + 1;
    for (const k of new Set((r.lint || []).map((p) => p.kind))) lint[k] = (lint[k] || 0) + 1;
    for (const [w, n] of Object.entries(r.keywords || {})) {
      const e = kw[w] || (kw[w] = { programs: 0, uses: 0 });
      e.programs++; e.uses += n;
    }
  }
  return { programs: records.length, status, lint, keywords: kw };
}
module.exports = { stats };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/basic-bb/corpus-stats.js results.jsonl [--json]'); process.exitCode = 2; return; }
  const s = stats(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 1)); return; }
  console.log(`${s.programs} programs`);
  for (const [k, n] of Object.entries(s.status).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('not run, by what the lint found (a program can have both):');
  for (const [k, n] of Object.entries(s.lint)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('keywords: programs using it, uses');
  for (const [w, e] of Object.entries(s.keywords).sort((a, b) => b[1].programs - a[1].programs || a[0].localeCompare(b[0]))) console.log(`  ${String(e.programs).padStart(4)} ${String(e.uses).padStart(6)}  ${w}`);
}
