// Run: node tests/basic-timing-motor.test.js
//
// The clean-room BASIC's speed against the original's (docs/clean-room-basic.md section 2): bb10 time-motor (TIMER
// through MOTOR ON's wait, a second ON, OFF when off), every loop's count of fields the original's or up to a few per
// cent more, and mutants of MOTOR that must each put some loop outside that range (tests/basic-timing.test.js says
// more).
const { cases, mutants, tally } = require('./basic/basic-timing-lib.js');

cases(['time-motor']);
mutants([
  ['MOTOR ON with interrupts off (TIMER stops)', 'time-motor', 'cassette.inc', 'MOT1    LDA     #MOTONV', 'MOT1    ORCC    #$50\n        LDA     #MOTONV'],
  ['a motor already running does not wait', 'time-motor', 'cassette.inc', '        LDX     #MOTDLY\n        BSR     CW0', '        LDX     #MOTDLY\n        BSR     CMSTX\n        ANDCC   #$AF'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
