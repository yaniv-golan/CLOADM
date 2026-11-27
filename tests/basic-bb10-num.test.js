// Run: node tests/basic-bb10-num.test.js
//
// bb10 records of the real Dragon 64 BASIC (tests/basic/bb/bb10-real.jsonl) and bb9's rnd-args replayed whole on the
// clean-room BASIC (docs/clean-room-basic.md section 5): printing numbers of 1E9 and up by single quotients of 10
// (num-print-big, rnd-args), a 0 below the smallest number stored with a mantissa (num-literal-bytes), VAL of &H and
// &O (num-val-hex), PRINT USING of 1E9 and up and an exponent field's carry with a sign of its own (using-exp-edge,
// num-print-big), SIN, COS and TAN in turns (fn-trig-big, fn-last-bit). Each case is identical to its record, or
// differs in exactly the lines named below, which are open (section 10, question 12); mutants of each rule must
// change the replay.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const load = (f) => new Map(fs.readFileSync(path.join(__dirname, 'basic/bb', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.case, r]));
const records = new Map([...load('bb9-real.jsonl'), ...load('bb10-real.jsonl')]);
const caseText = (c) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${c}.bas`), 'utf8');
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

const CASES = ['num-print-big', 'rnd-args', 'num-literal-bytes', 'num-val-hex', 'using-exp-edge', 'fn-trig-big', 'fn-last-bit'];
const { rom } = buildBasic();
for (const c of CASES) {
  const r = replay(rom, c);
  const open = Object.keys(OPEN[c] || {}).length + (OPENWRAP[c] ? 1 : 0);
  check(`${c}: ours identical to the original's record${open ? ` but for its ${open} open line(s)` : ''} [BB]`, r.same, r.detail);
}

for (const [cases, what, file, from, to] of [
  [['num-print-big', 'rnd-args'], 'FOUT takes steps of 1E9 from 1E17 down, as before bb10', 'fpconv.inc',
    '        LDB     #9\n        JSR     FCMPP\n        BLE     FOFIX           ; 1E9 and up',
    'MUT1    LDB     #17\n        JSR     FCMPP\n        BGT     MUT2\n        LDB     #9\n        JSR     FDIVP\n        LDB     #9\n        JSR     E10ADJ\n        BRA     MUT1\nMUT2    LDB     #9\n        JSR     FCMPP\n        BLE     FOFIX'],
  [['num-literal-bytes'], 'a 0 is stored with a mantissa of 0', 'fp.inc', '        STA     ,X\n        LDA     <FACM\n', '        STA     ,X\n        CLRA\n'],
  [['num-literal-bytes'], 'a quotient known to be too small is still worked out', 'fp.inc', '        BMI     FMZ             ; below 0', '        BRN     FMZ             ; below 0'],
  [['num-val-hex'], 'VAL does not read &', 'strfunc.inc', "        CMPA    #'&'\n        BNE     VAL1", "        CMPA    #'&'\n        BRA     VAL1"],
  [['num-val-hex'], 'an octal number stops at 8', 'expr.inc', '#$0309', '#$0307'],
  [['using-exp-edge', 'num-print-big'], 'PRINT USING of 1E9 and up as any number', 'using.inc', '        LBLE    UMOV2', '        LBRN    UMOV2'],
  [['using-exp-edge'], 'a carry out with a sign of the field\'s own renormalises', 'using.inc', '        DEC     ,S              ;', '        BRA     UME5            ;'],
  [['using-exp-edge'], 'a carry out with a sign of the field\'s own fits the field', 'using.inc', '        DEC     ,S              ;', '        TST     ,S              ;'],
  [['fn-trig-big', 'fn-last-bit'], 'TAN is SIN(x) / COS(x)', 'mathfn.inc', 'FTAN    BSR     SINRED\n        BSR     SINF\n', 'FTAN    JSR     <ZFPRUN\n        FCB     F_STO+5,0\n        JSR     FSIN\n        JSR     <ZFPRUN\n        FCB     F_STO+6,F_LD+5,0\n        JSR     FCOS\n        JSR     <ZFPRUN\n        FCB     F_DIVX+6,0\n        RTS\nMUT3    BSR     SINRED\n        BSR     SINF\n'],
  [['fn-last-bit'], 'TAN\'s quarter turn not brought back from below 0', 'mathfn.inc', '        BPL     FTN1', '        BRA     FTN1'],
  [['fn-last-bit'], 'the fold without its |1/2 - g|', 'mathfn.inc', '        CLR     <FACSGN\n        JSR     <ZFPRUN\n        FCB     F_SUBX+K_HALF,0\n        LDX     #SINSER', '        NOP\n        NOP\n        JSR     <ZFPRUN\n        FCB     F_SUBX+K_HALF,0\n        LDX     #SINSER'],
  [['fn-last-bit'], 'the series one term short', 'mathfn.inc', '        LDD     #$0506', '        LDD     #$0505'],
]) {
  const r = mutant(file, from, to);
  for (const c of cases) check(`${c} mutant "${what}": no longer as recorded`, !replay(r, c).same);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
