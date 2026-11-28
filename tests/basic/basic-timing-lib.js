// The shared part of tests/basic-timing*.test.js: the clean-room BASIC's speed against the original's, by the
// black-box timing probes (docs/clean-room-basic.md section 2, "The original's cost model"). Each case is run on ours
// as the original ran it, and every loop's count of fields must be the original's or more (ours is never to be
// faster: loops time games), and at most a few per cent more (TOL); mutants of the cost model must each put some loop
// outside that range.
const fs = require('fs'), path = require('path');
const { runCase } = require('./harness.js');
const { buildBasic } = require('../../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });

// at most 8% more, or one field for the shortest counts (MOTOR's 25): the slowest loop is RND(.5), 7.4% (section 2)
const TOL = 0.08;
const within = (got, real) => got >= real && got <= Math.max(real * (1 + TOL), real + 1);

const real = new Map();
for (const f of ['bb9-real.jsonl', 'bb10-real.jsonl', 'bb12-real.jsonl', 'bb13c-real.jsonl']) {
  for (const l of fs.readFileSync(path.join(__dirname, 'bb', f), 'utf8').trim().split('\n')) { const r = JSON.parse(l); real.set(r.case, r); }
}
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'cases', `${name}.bas`), 'utf8');

// the counts a case printed, in order (its loops' fields)
function counts(name, transcript) {
  const t = transcript, runs = t.map((l, i) => (l === 'RUN' ? i : -1)).filter((i) => i >= 0);
  const after = (i) => t.slice(i + 1, t.indexOf('OK', i)).join('');
  const nums = (s) => s.replace(/[A-Z]/g, ' ').split(/\s+/).filter(Boolean).map(Number);
  if (name === 'time-ops') return [...nums(after(runs[0])), ...t.map((l) => /^DATA \d+ (\d+)$/.exec(l)).filter(Boolean).map((m) => +m[1])];
  if (name === 'time-motor') return [...t.slice(0, runs[0]).filter((l, i) => i > 0 && /^ ?\d+$/.test(l)).map(Number), ...nums(after(runs[0]))];
  if (name === 'time-screen') return nums(t[t.lastIndexOf('OK') - 1] || '');   // (its counts on the last row, after a CLS)
  return nums(after(runs[runs.length - 1]));
}
const LABELS = {
  'time-literals': ['empty', 'X=1', 'X=11', 'X=10', 'X=111', 'X=11111', 'X=105', 'X=1005', 'X=655361', 'X=1.1', 'X=11.1'],
  'time-ops': ['empty', 'X=I', 'X=PEEK(I AND 32767)', 'X=(I AND 32767)', 'X=I AND 1', 'X=I+1', 'A$=STR$(I)', 'L=LEN(STR$(I))', 'X=VAL("32767")', 'X=VAL("1")', 'READ 32767', 'READ 1'],
  'time-mul': ['X=Y', ...[['2', '2'], ['255', '255'], ['F', 'F'], ['.3', '.3'], ['M', 'M'], ['2', 'F'], ['F', '2'], ['255', 'F'], ['F', '255'], ['2', '.3'], ['.3', '2'], ['255', '.3'], ['.3', '255'], ['2', 'M'], ['M', '2'], ['F', 'M'], ['M', 'F']].map(([y, z]) => `${y}*${z}`)],
  'time-int': ['X=Y', 'INT(.5)', 'INT(3.5)', 'INT(1000.5)', 'INT(1E6+.5)', 'INT(1E9+.5)', 'INT(-1000.5)'],
  'time-motor': ['typed MOTOR ON:PRINT TIMER', 'typed MOTOR ON:MOTOR ON', 'typed MOTOR ON:T=TIMER:MOTOR OFF', 'MOTOR ON:A=TIMER', 'MOTOR ON:MOTOR ON:B=TIMER', 'MOTOR OFF (off):C=TIMER', '10 x MOTOR ON:MOTOR OFF', '10 empty passes'],
  'time-loopb': ['S=S+PEEK(28928+I AND 32767)', 'S=S+PEEK(I AND 32767)', 'S=S+1', 'X=28928+I AND 32767', 'empty', 'FOR D=1 TO 300'],
  'time-screen': ['empty', 'CLS', 'CLS and 32 letters', 'CLS and PRINT I;', 'CLS and PRINT', 'PRINT on the bottom row'],
  'rnd-timing': ['RND(0)', 'RND(6)', 'RND(1E9)', 'RND(.5)', 'RND(-1)', 'RND(-3)', 'RND(-1.99999999)'],
};
// the loops of a case outside the range on `rom` (names), and their counts
function judge(rom, name) {
  const want = counts(name, real.get(name).transcript), r = runCase(rom, caseText(name));
  const got = r.status === 'ok' ? counts(name, r.transcript) : [];
  const bad = LABELS[name].filter((_, i) => !(got[i] != null && within(got[i], want[i])));
  return { want, got, bad };
}

const built = buildBasic();
// every loop of each case within the range on ours
function cases(names) {
  for (const name of names) {
    const { want, got } = judge(built.rom, name);
    check(`${name}: the record has its ${LABELS[name].length} counts`, want.length === LABELS[name].length, JSON.stringify(want));
    LABELS[name].forEach((label, i) => check(`${name} ${label}: the original's ${want[i]} fields or up to ${Math.round(TOL * 100)}% more`, got[i] != null && within(got[i], want[i]), `${got[i]}`));
  }
}

// ---- mutants of the model ([what, case, file, from, to]): each must take some loop out of range ----
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => { if (f !== file) return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`); return t.replace(from, to); } }).rom;
function mutants(list) {
  for (const [what, name, file, from, to] of list) {
    const { bad, got } = judge(mutant(file, from, to), name);
    check(`mutant "${what}": a ${name} loop outside the original's count .. +${Math.round(TOL * 100)}%`, bad.length > 0, `${bad.slice(0, 4).join(', ')} ${JSON.stringify(got)}`);
  }
}

module.exports = { check, tally, judge, built, cases, mutants, within, mutant, LABELS };
