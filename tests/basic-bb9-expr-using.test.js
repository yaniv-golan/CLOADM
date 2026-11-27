// Run: node tests/basic-bb9-expr-using.test.js
//
// Two bb9 records of the real Dragon 64 BASIC (tests/basic/bb/bb9-real.jsonl) replayed whole on the clean-room BASIC
// (docs/clean-room-basic.md): expr-not (NOT straight after a relation or another operator is an operand: NOT and a
// relation) and print-using-odd (a fixed field's number of more than 32 bits once scaled; an exponent field whose
// rounding carries out). Ours must be identical to each record, and mutants of each rule must not be.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
const { compare } = require('../tools/basic-bb/compare.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const records = new Map(fs.readFileSync(path.join(__dirname, 'basic/bb/bb9-real.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).map((r) => [r.case, r]));
const caseText = (c) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${c}.bas`), 'utf8');
const same = (rom, c) => {
  const r = runCase(rom, caseText(c));
  return compare(new Map([[c, records.get(c)]]), new Map([[c, { ...r, case: c }]]));
};
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
  if (f !== file) return t;
  if (!t.includes(from)) throw new Error(`mutant source not found in ${file}: ${from}`);
  return t.replace(from, to);
} }).rom;

const { rom } = buildBasic();
for (const c of ['expr-not', 'print-using-odd']) {
  const r = same(rom, c);
  check(`${c}: ours identical to the original's record [BB bb9]`, r.same === 1, r.report.slice(0, 2).join(' | '));
}

for (const [c, what, file, from, to] of [
  ['expr-not', 'NOT after an operator is ?SN ERROR', 'expr.inc',
    'BNE     EVASN           ;', 'BRA     EVASN           ;'],
  ['expr-not', 'NOT as an operand negates instead of complementing', 'expr.inc',
    '        JSR     CHKSP\n        JMP     EVNOT', '        JSR     <ZCHRGET\n        JSR     EVREL\n        JMP     FNEG'],
  ['print-using-odd', 'a number of more than 32 bits prints as PRINT has it, after a %', 'using.inc',
    'UMOV    CMPA    #128+66', 'UMOV    BRA     UMOV2'],
  ['print-using-odd', 'one digit fewer: the zeros counted from the exponent of the first digit, not one more', 'using.inc',
    '        LDB     <FPE10+1\n        INCB', '        LDB     <FPE10+1'],
  ['print-using-odd', 'a carry out renormalises even with a sign\'s place', 'using.inc',
    '        DEC     ,S              ;', '        BRA     UME5            ;'],
  ['print-using-odd', 'a carry out takes the sign\'s place but the exponent still moves', 'using.inc',
    '        INC     <USNB           ; below)', '        NOP                     ; below)'],
]) check(`${c} mutant "${what}": no longer identical`, same(mutant(file, from, to), c).same === 0);

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
