// The shared part of tests/basic-ram*.test.js: the clean-room BASIC's RAM layout where programs can see it, and the
// speed its loops are pinned to (docs/clean-room-basic.md, "The direct page"; tests/basic-ram.test.js says more): our
// ROM assembled once, a case typed into it, the original's black-box records (tests/basic/bb/) and case texts
// (tests/basic/cases/), ram-pointers2's eight timing loops against the original's counts, and the mutants of FIN's
// wait for each digit (fpconv.inc) that the timing checks must catch.
const fs = require('fs'), path = require('path');
const { runCase } = require('./harness.js');
const { buildBasic } = require('../../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });
const built = buildBasic(), sym = (s) => built.symbols.get(s);

const run = (text) => runCase(built.rom, text);
const lines = (r) => r.transcript;
const real = (file, name) => fs.readFileSync(path.join(__dirname, 'bb', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.case === name);
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'cases', `${name}.bas`), 'utf8');

// ram-pointers2's eight loops on the original [BB 2026-11-26]: fields each
const REAL8 = { FOR: 113, ADD: 205, MUL: 224, DIV: 177, STR: 174, GOSUB: 83, IF: 516, MID: 137 };

// (a mutant: one or more replacements in fpconv.inc, from, to, ...)
const mutant = (...ft) => buildBasic({ edit: (f, t) => {
  if (f !== 'fpconv.inc') return t;
  for (let i = 0; i < ft.length; i += 2) { if (!t.includes(ft[i])) throw new Error(`mutant source not found: ${ft[i]}`); t = t.replace(ft[i], ft[i + 1]); }
  return t;
} }).rom;

// how long a 0 and a digit after the point wait is pinned by ram-pointers2's loops too: 1000 (IF), 2.5 (ADD, MUL).
// Each [what, from, to] in fpconv.inc must put a loop outside the original's count .. +2.
function loopMutants(list) {
  for (const [what, from, to] of list) {
    const t = lines(runCase(mutant(from, to), caseText('ram-pointers2'))).join(' ');
    const out = Object.entries(REAL8).filter(([k, v]) => { const all = [...t.matchAll(new RegExp(`\\b${k} (\\d+)`, 'g'))]; return !(all.length && +all[all.length - 1][1] >= v && +all[all.length - 1][1] <= v + 2); }).map(([k]) => k);
    check(`ram-pointers2 mutant "${what}": a loop outside the original's count .. +2`, out.length > 0, out.join(','));
  }
}

module.exports = { check, tally, built, sym, run, lines, real, caseText, REAL8, mutant, loopMutants, runCase };
