// Run: node tests/basic-bb10-num-literals.test.js
//
// bb10 records of the real Dragon 64 BASIC (tests/basic/bb/bb10-real.jsonl) replayed whole on the clean-room BASIC
// (docs/clean-room-basic.md section 5): a 0 below the smallest number stored with a mantissa (num-literal-bytes) and
// VAL of &H and &O (num-val-hex). Each case is identical to its record but for its open lines
// (tests/basic/basic-bb10-num-lib.js); mutants of each rule must change the replay.
const { run, tally } = require('./basic/basic-bb10-num-lib.js');

run(['num-literal-bytes', 'num-val-hex'], [
  [['num-literal-bytes'], 'a 0 is stored with a mantissa of 0', 'fp.inc', '        STA     ,X\n        LDA     <FACM\n', '        STA     ,X\n        CLRA\n'],
  [['num-literal-bytes'], 'a quotient known to be too small is still worked out', 'fp.inc', '        BMI     FMZ             ; below 0', '        BRN     FMZ             ; below 0'],
  [['num-val-hex'], 'VAL does not read &', 'strfunc.inc', "        CMPA    #'&'\n        BNE     VAL1", "        CMPA    #'&'\n        BRA     VAL1"],
  [['num-val-hex'], 'an octal number stops at 8', 'expr.inc', '#$0309', '#$0307'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
