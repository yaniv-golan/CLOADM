// Run: node tests/basic-lang.test.js [case ...]
//
// The clean-room BASIC (docs/clean-room-basic.md), assembled from basic/ at test time (no ROM is used): every case in
// tests/basic/cases is typed into a Dragon 64 running it, through the keyboard matrix, and the transcript (every
// line that reached the screen, tests/basic/harness.js) must be exactly tests/basic/expected/<case>.txt, with the
// case ending normally and nothing flagged. Each expected file's first lines (#) give where its output comes from:
// [UM] the user manuals, [BB] a black-box run on the real ROM, [OWN] our own decision. Cases marked "# bb-only"
// are for the black-box run alone (the probes) and are only linted here. Every case passes the lint
// (tools/basic-bb/lint.js), so the same files can be run on the real ROM.
const fs = require('fs'), path = require('path');
const { buildBasic } = require('../tools/build-basic.js');
const { runCase } = require('./basic/harness.js');
const { lintCase } = require('../tools/basic-bb/lint.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// tests/basic/own: cases for our suite alone, never run on the real ROM (EXEC and USR, which the lint refuses)
const CASES = path.join(__dirname, 'basic/cases'), OWN = path.join(__dirname, 'basic/own'), EXPECTED = path.join(__dirname, 'basic/expected');
const only = process.argv.slice(2);
const { rom } = buildBasic();
let bbOnly = 0;
const files = [...fs.readdirSync(CASES).map((f) => [CASES, f]), ...fs.readdirSync(OWN).map((f) => [OWN, f])].filter(([, f]) => f.endsWith('.bas'));
for (const [dir, f] of files.sort((a, b) => a[1].localeCompare(b[1]))) {
  const name = f.replace(/\.bas$/, '');
  if (only.length && !only.includes(name)) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (dir === CASES) {
    const problems = lintCase(text);
    check(`${name}: passes the black-box lint`, !problems.length, problems.join('; '));
  }
  if (/^# bb-only\b/m.test(text)) { bbOnly++; continue; }
  const expFile = path.join(EXPECTED, `${name}.txt`);
  if (!fs.existsSync(expFile)) { check(`${name}: has an expected transcript`, false, expFile); continue; }
  const raw = fs.readFileSync(expFile, 'utf8').replace(/\n$/, '').split('\n');
  const source = raw.filter((l) => l.startsWith('#'));
  const expected = raw.filter((l) => !l.startsWith('#'));
  check(`${name}: the expected transcript says where it comes from`, source.some((l) => /\[(UM|BB|OWN|HW|MBF)/.test(l)));
  const r = runCase(rom, text);
  check(`${name}: runs to the end`, r.status === 'ok', `${r.status}${r.at ? ` at ${r.at}` : ''}`);
  check(`${name}: nothing flagged`, !r.flags.length, JSON.stringify(r.flags));
  let at = -1;
  for (let i = 0; i < Math.max(expected.length, r.transcript.length); i++) if (expected[i] !== r.transcript[i]) { at = i; break; }
  check(`${name}: transcript as expected (${expected.length} lines)`, at < 0,
    at < 0 ? '' : `line ${at + 1}: expected ${JSON.stringify(expected[at])}, got ${JSON.stringify(r.transcript[at])}`);
}
console.log(`(${bbOnly} black-box-only cases linted)`);
console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
