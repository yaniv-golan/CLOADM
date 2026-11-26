// Run: node tests/basic-cassette-bb8.test.js
//
// The clean-room BASIC's cassette (basic/cassette.inc; docs/clean-room-basic.md section 12) against the original's
// black-box records of batch bb8 (tests/basic/bb/bb8-real.jsonl), replayed on ours (assembled at test time) through
// the black-box harness and compared as tools/basic-bb/compare.js compares them:
//  * cas-multi, cas-left-open and cas-in-program: identical (the transcripts and clears, the motor's runs within a
//    field), and CLOAD "LONG"'s blocks never earlier than on the original;
//  * cas-data2 and cas-data-errors: identical but the leader counts the tape decoder reads;
//  * cas-cloadm2: the exec address at 157 and 485, the offset added, the motor stopped after the namefile;
//  * mutants of the motor's stops and of a text line's pace, each of which turns cas-multi's replay red.
const { buildBasic } = require('../tools/build-basic.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const { rom } = buildBasic();

// ---------------- (6) the original's bb8 records, replayed on ours ----------------
// Each case run on ours as tools/basic-bb/run.js runs it and compared as tools/basic-bb/compare.js compares it with
// the original's record (tests/basic/bb/bb8-real.jsonl): the transcripts and clears line for line, the motor's runs
// (each run's start and length within a field), the blocks written. The data-file cases' blocks differ only in the
// leader the tape decoder counts before them (the original's 1 or 2, ours 256: section 12); cas-cloadm2 is checked
// for its exec address and its first motor runs (the rest of it waits on BASIC loops ours runs quicker).
{
  const fs = require('fs'), path = require('path');
  const { runCase } = require('./basic/harness.js');
  const { compare } = require('../tools/basic-bb/compare.js');
  const real = fs.readFileSync(path.join(__dirname, 'basic/bb/bb8-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const caseText = (name) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${name}.bas`), 'utf8');
  const replay = (r, name) => { const o = runCase(r, caseText(name)); return { ...compare(new Map([[name, real.find((x) => x.case === name)]]), new Map([[name, { ...o, case: name }]])), o }; };
  // a text program's blocks: no run starts earlier than on the original (the lines never go in faster)
  const neverEarlier = (o) => { const w = real.find((x) => x.case === 'cas-multi').tapes[0].motor, g = o.tapes[0].motor; return w.length === g.length && w.every((m, i) => g[i].start >= m.start); };
  const leaderOnly = (l) => { const m = /block \d+: (\{.*\}) vs (\{.*\})$/.exec(l); if (!m) return false; const [x, y] = [JSON.parse(m[1]), JSON.parse(m[2])]; delete x.leader; delete y.leader; return JSON.stringify(x) === JSON.stringify(y); };
  for (const name of ['cas-multi', 'cas-left-open', 'cas-in-program']) {
    const c = replay(rom, name);
    check(`bb8 ${name}: ours identical to the original's record`, c.same === 1, c.report.slice(0, 3).join(' | '));
    if (name === 'cas-multi') check('bb8 cas-multi: CLOAD "LONG"\'s blocks start no earlier than on the original\'s', neverEarlier(c.o), JSON.stringify(c.o.tapes[0].motor.map((m) => m.start)));
  }
  for (const name of ['cas-data2', 'cas-data-errors']) {
    const c = replay(rom, name), other = c.report.filter((l) => !leaderOnly(l) && !/cases identical/.test(l));
    check(`bb8 ${name}: ours as the original's record but the leader counts`, other.length === 0, other.slice(0, 3).join(' | '));
  }
  const cl = runCase(rom, caseText('cas-cloadm2')), want = real.find((x) => x.case === 'cas-cloadm2');
  const seen = (r) => [...(r.clears || []).flatMap((c) => c.screen), ...r.transcript];   // (the screens CLOADM cleared too)
  check('bb8 cas-cloadm2: CLOADM\'s exec address found at 157 and in the buffer at 485, the offset added at 157 as on the original',
    seen(cl).includes(' 157  112  485  112 DONE') && seen(cl).includes(' 157  114  485  112 DONE') && seen(want).includes(' 157  114  485  112 DONE'), JSON.stringify(seen(cl).filter((l) => /DONE/.test(l))));
  const runsOf = (r) => r.tapes[0].motor.slice(0, 2), ok2 = runsOf(want).every((m, i) => Math.abs(m.length - runsOf(cl)[i].length) <= 1 && Math.abs(m.start - runsOf(cl)[i].start) <= 1);
  check('bb8 cas-cloadm2: CLOADM "MCX",512 then BIGMC: the motor stopped after the namefile, the data and end of file in one run, within a field of the original', ok2, JSON.stringify([runsOf(want), runsOf(cl)]));
  // mutants of the motor's stops: each turns cas-multi's replay red
  for (const [what, from, to] of [
    ['no stop after a namefile', '        STA     CFGAP\n        BSR     CASOFF', '        STA     CFGAP\n        NOP\n        NOP'],
    ['no stop between a gapped file\'s blocks', '        TST     CFGAP\n        BEQ     CRK2', '        TST     CFGAP\n        BRA     CRK2'],
    ['a line of text loaded with no wait', '        LDX     #CLNDLY\n        JSR     DELAYX', '        LDX     #1\n        JSR     DELAYX'],
  ]) {
    const mrom = buildBasic({ edit: (f, t) => { if (f !== 'cassette.inc') return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${what}`); return t.replace(from, to); } }).rom;
    const c = replay(mrom, 'cas-multi');
    check(`bb8 cas-multi mutant "${what}": no longer identical, or a block early`, c.same === 0 || !neverEarlier(c.o));
  }
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
