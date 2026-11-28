// The shared part of tests/basic-bb10-num*.test.js: bb10 records of the real Dragon 64 BASIC
// (tests/basic/bb/bb10-real.jsonl) and bb9's rnd-args replayed whole on the clean-room BASIC (docs/clean-room-basic.md
// section 5). Each case is identical to its record, or differs in exactly the lines named below, which are open
// (section 10, question 12); mutants of each rule must change the replay.
const fs = require('fs'), path = require('path');
const { runCase } = require('./harness.js');
const { buildBasic } = require('../../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const load = (f) => new Map(fs.readFileSync(path.join(__dirname, 'bb', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.case, r]));
const records = new Map([...load('bb9-real.jsonl'), ...load('bb10-real.jsonl')]);
const caseText = (c) => fs.readFileSync(path.join(__dirname, 'cases', `${c}.bas`), 'utf8');
// the open differences, as line numbers of the record's transcript (0-based) with ours' text there
const OPEN = {
  // 2^66 and 2^126: the original's ^ is EXP(y LOG x) for these, giving 195,0,0,0,44 and
  // 255,0,0,0,44; ours multiplies whole powers exactly
  'num-print-big': { 61: ' 7.37869763E+19 195,0,0,0,0,', 62: ' 8.50705918E+37 255,0,0,0,0,' },
  // EXP(2); SQR of 3 and 1E30, a unit off through EXP (LOG's values are the original's since its reduction was found)
  'fn-last-bit': { 96: ' 5  2 131,108,115,37,199,', 105: ' 6  3 129,93,179,215,68,', 112: ' 6  1E+30 178,99,95,169,47,' },
};
// 5E-39's bytes (1,89,199,220,238) print as 5.00000001E-39 on the original, 5E-39 on ours (open): its two record
// lines are one of ours, and the rest is ours one line earlier
const OPENWRAP = { 'num-literal-bytes': { at: 69, real: 2, ours: [' 29  5E-39 1,89,199,220,238,'] } };
function replay(rom, c) {
  const want = records.get(c).transcript.slice(), got = runCase(rom, caseText(c)).transcript;
  const w = OPENWRAP[c];
  if (w) want.splice(w.at, w.real, ...w.ours);
  for (const [i, t] of Object.entries(OPEN[c] || {})) want[i] = t;
  let at = -1;
  for (let i = 0; i < Math.max(want.length, got.length); i++) if (want[i] !== got[i]) { at = i; break; }
  return { same: at < 0, detail: at < 0 ? `${got.length} lines` : `line ${at}: ${JSON.stringify(want[at])} vs ${JSON.stringify(got[at])}` };
}
// A mutant is built without EDIT (the cases here type no EDIT): some add code (TAN as SIN/COS, 41 bytes; FOUT's old
// steps, 19), more than the ROM as built has free, and EDIT's room lets them assemble with the rest of the ROM as is.
const noEdit = (f, t) => (f === 'd64basic.asm' ? t.replace('        INCLUDE "edit.inc"\n', 'EDIT    EQU     UNIMPL\n') : t);
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
  t = noEdit(f, t);
  if (f !== file) return t;
  if (!t.includes(from)) throw new Error(`mutant source not found in ${file}: ${from}`);
  return t.replace(from, to);
} }).rom;

// the cases on ours, then the mutants ([cases, what, file, from, to]), each of which must change the replay of every
// case it names
function run(CASES, MUTANTS) {
  const { rom } = buildBasic();
  for (const c of CASES) {
    const r = replay(rom, c);
    const open = Object.keys(OPEN[c] || {}).length + (OPENWRAP[c] ? 1 : 0);
    check(`${c}: ours identical to the original's record${open ? ` but for its ${open} open line(s)` : ''} [BB]`, r.same, r.detail);
  }
  // the control: each case as recorded on the ROM the mutants are built from (EDIT left out, nothing else changed), so
  // a mutant's difference is its own change's
  const base = buildBasic({ edit: noEdit }).rom;
  for (const c of CASES) check(`${c}: as recorded on the ROM the mutants start from (without EDIT)`, replay(base, c).same, replay(base, c).detail);
  for (const [cases, what, file, from, to] of MUTANTS) {
    const r = mutant(file, from, to);
    for (const c of cases) check(`${c} mutant "${what}": no longer as recorded`, !replay(r, c).same);
  }
}

const tally = () => ({ n, fail });

module.exports = { run, tally };
