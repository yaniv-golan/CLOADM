// Run: node tests/basic-bb10-num-trig.test.js
//
// bb10 records of the real Dragon 64 BASIC (tests/basic/bb/bb10-real.jsonl) replayed whole on the clean-room BASIC
// (docs/clean-room-basic.md section 5): SIN, COS and TAN in turns (fn-trig-big, fn-last-bit). Each case is identical
// to its record, or differs in exactly the lines named in tests/basic/basic-bb10-num-lib.js, which are open (section
// 10, question 12); mutants of each rule must change the replay.
const { run, tally } = require('./basic/basic-bb10-num-lib.js');

run(['fn-trig-big', 'fn-last-bit'], [
  [['fn-trig-big', 'fn-last-bit'], 'TAN is SIN(x) / COS(x)', 'mathfn.inc', 'FTAN    BSR     SINRED\n        BSR     SINF\n', 'FTAN    JSR     <ZFPRUN\n        FCB     F_STO+5,0\n        JSR     FSIN\n        JSR     <ZFPRUN\n        FCB     F_STO+6,F_LD+5,0\n        JSR     FCOS\n        JSR     <ZFPRUN\n        FCB     F_DIVX+6,0\n        RTS\nMUT3    BSR     SINRED\n        BSR     SINF\n'],
  [['fn-last-bit'], 'TAN\'s quarter turn not brought back from below 0', 'mathfn.inc', '        BPL     FTN1', '        BRA     FTN1'],
  [['fn-last-bit'], 'the fold without its |1/2 - g|', 'mathfn.inc', '        CLR     <FACSGN\n        JSR     <ZFPRUN\n        FCB     F_SUBX+K_HALF,0\n        LDX     #SINSER', '        NOP\n        NOP\n        JSR     <ZFPRUN\n        FCB     F_SUBX+K_HALF,0\n        LDX     #SINSER'],
  [['fn-last-bit'], 'the series one term short', 'mathfn.inc', '        LDD     #$0506', '        LDD     #$0505'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
