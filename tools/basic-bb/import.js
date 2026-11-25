#!/usr/bin/env node
// Transcripts written down from a real Dragon 64 (tools/basic-bb/sheet.js) into the JSONL tools/basic-bb/run.js
// writes, so tools/basic-bb/compare.js compares them with ours. The input is plain text: a line "=== case-name",
// then the screen's lines in order, starting with the OK after CLS; then the next case. Trailing spaces are dropped,
// and so are blank lines at the end of each case (as run.js drops them).
//   node tools/basic-bb/import.js written.txt --out real-hardware.jsonl
const fs = require('fs');

function importText(text) {
  const cases = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^=== (\S+)\s*$/.exec(raw);
    if (m) { cur = { case: m[1], machine: 'dragon64', rom: 'hardware', status: 'ok', transcript: [], flags: [] }; cases.push(cur); continue; }
    if (cur) cur.transcript.push(raw.replace(/\s+$/, ''));
  }
  for (const c of cases) while (c.transcript.length && !c.transcript[c.transcript.length - 1]) c.transcript.pop();
  return cases;
}
module.exports = { importText };

if (require.main === module) {
  const args = process.argv.slice(2), o = args.indexOf('--out');
  if (!args[0] || o < 0) {
    console.error('usage: node tools/basic-bb/import.js written.txt --out FILE.jsonl');
    process.exitCode = 2;
  } else {
    const cases = importText(fs.readFileSync(args[0], 'utf8'));
    fs.writeFileSync(args[o + 1], cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : ''));
    console.log(`${cases.length} cases written to ${args[o + 1]}`);
  }
}
