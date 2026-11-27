// Run: node tests/basic-bb10-num.test.js
//
// bb10 records of the real Dragon 64 BASIC (tests/basic/bb/bb10-real.jsonl) and bb9's rnd-args replayed whole on the
// clean-room BASIC (docs/clean-room-basic.md section 5): printing numbers of 1E9 and up by single quotients of 10
// (num-print-big, rnd-args), PRINT USING of 1E9 and up and an exponent field's carry with a sign of its own
// (using-exp-edge, num-print-big). Each case is identical to its record, or differs in exactly the lines named in
// tests/basic/basic-bb10-num-lib.js, which are open (section 10, question 12); mutants of each rule must change the
// replay. The other bb10 number cases: tests/basic-bb10-num-literals.test.js and basic-bb10-num-trig.test.js.
const { run, tally } = require('./basic/basic-bb10-num-lib.js');

run(['num-print-big', 'rnd-args', 'using-exp-edge'], [
  [['num-print-big', 'rnd-args'], 'FOUT takes steps of 1E9 from 1E17 down, as before bb10', 'fpconv.inc',
    '        LDB     #9\n        JSR     FCMPP\n        BLE     FOFIX           ; 1E9 and up',
    'MUT1    LDB     #17\n        JSR     FCMPP\n        BGT     MUT2\n        LDB     #9\n        JSR     FDIVP\n        LDB     #9\n        JSR     E10ADJ\n        BRA     MUT1\nMUT2    LDB     #9\n        JSR     FCMPP\n        BLE     FOFIX'],
  [['using-exp-edge', 'num-print-big'], 'PRINT USING of 1E9 and up as any number', 'using.inc', '        LBLE    UMOV2', '        LBRN    UMOV2'],
  [['using-exp-edge'], 'a carry out with a sign of the field\'s own renormalises', 'using.inc', '        DEC     ,S              ;', '        BRA     UME5            ;'],
  [['using-exp-edge'], 'a carry out with a sign of the field\'s own fits the field', 'using.inc', '        DEC     ,S              ;', '        TST     ,S              ;'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
