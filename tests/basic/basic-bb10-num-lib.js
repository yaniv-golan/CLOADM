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
  // 2^66 and 2^126: the original's ^ is EXP(y LOG x) with its LOG(2) one unit above ours, giving 195,0,0,0,44 and
  // 255,0,0,0,44; ours multiplies whole powers exactly
  'num-print-big': { 61: ' 7.37869763E+19 195,0,0,0,0,', 62: ' 8.50705918E+37 255,0,0,0,0,' },
  // LOG near 1 and of .1, .5, 2; EXP(2); SQR of .1, .5, 2, 3 and 1E30 (the original's LOG reduction, not yet found)
  'fn-last-bit': { 76: ' 4  .1 130,147,93,141,222,', 77: ' 4  .5 128,177,114,23,248,', 78: ' 4  .9 125,215,199,65,11,', 79: ' 4  1.1 125,67,49,251,203,',
    80: ' 4  2 128,49,114,23,248,', 96: ' 5  2 131,108,115,37,199,', 102: ' 6  .1 127,33,232,155,18,', 103: ' 6  .5 128,53,4,243,52,',
    104: ' 6  2 129,53,4,243,52,', 105: ' 6  3 129,93,179,215,68,', 112: ' 6  1E+30 178,99,95,169,47,' },
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
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
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
  for (const [cases, what, file, from, to] of MUTANTS) {
    const r = mutant(file, from, to);
    for (const c of cases) check(`${c} mutant "${what}": no longer as recorded`, !replay(r, c).same);
  }
}

const tally = () => ({ n, fail });

module.exports = { run, tally };
