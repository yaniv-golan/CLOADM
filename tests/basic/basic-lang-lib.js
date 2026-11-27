// The shared part of tests/basic-lang*.test.js: the clean-room BASIC (docs/clean-room-basic.md), assembled from basic/
// at test time (no ROM is used), and the cases of tests/basic/cases and tests/basic/own typed into a Dragon 64 running
// it, each transcript compared with tests/basic/expected/<case>.txt (the header of tests/basic-lang.test.js says how).
// The cases are split between the parts by name: NUM below.
const fs = require('fs'), path = require('path');
const { buildBasic } = require('../../tools/build-basic.js');
const { runCase } = require('./harness.js');
const { lintCase } = require('../../tools/basic-bb/lint.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });

// tests/basic/own: cases for our suite alone, never run on the real ROM (EXEC and USR, which the lint refuses)
const CASES = path.join(__dirname, 'cases'), OWN = path.join(__dirname, 'own'), EXPECTED = path.join(__dirname, 'expected');
const { rom } = buildBasic();
// the cases of the numbers-and-strings part, tests/basic-lang-num.test.js; every other case is tests/basic-lang.test.js's
const NUM = /^(fn|num|print|str|using)-/;
const inNum = (name) => NUM.test(name);

// run the cases whose name passes keep(name) (with names given on the command line, only those of them)
function runCases(keep) {
  const only = process.argv.slice(2);
  let bbOnly = 0;
  const all = [...fs.readdirSync(CASES).map((f) => [CASES, f]), ...fs.readdirSync(OWN).map((f) => [OWN, f])].filter(([, f]) => f.endsWith('.bas'));
  const files = all.filter(([, f]) => keep(f.replace(/\.bas$/, '')));
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
    const r = runCase(rom, text, { guard: dir === CASES });
    check(`${name}: runs to the end`, r.status === 'ok', `${r.status}${r.at ? ` at ${r.at}` : ''}`);
    check(`${name}: nothing flagged`, !r.flags.length, JSON.stringify(r.flags));
    let at = -1;
    for (let i = 0; i < Math.max(expected.length, r.transcript.length); i++) if (expected[i] !== r.transcript[i]) { at = i; break; }
    check(`${name}: transcript as expected (${expected.length} lines)`, at < 0,
      at < 0 ? '' : `line ${at + 1}: expected ${JSON.stringify(expected[at])}, got ${JSON.stringify(r.transcript[at])}`);
  }
  for (const name of only) check(`case ${name} exists`, files.some(([, f]) => f === `${name}.bas`),
    all.some(([, f]) => f === `${name}.bas`) && !keep(name) ? `(its part is ${inNum(name) ? 'tests/basic-lang-num.test.js' : 'tests/basic-lang.test.js'})` : '');
  console.log(`(${bbOnly} black-box-only cases linted)`);
}

module.exports = { runCases, inNum, tally };
