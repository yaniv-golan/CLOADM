// Run: node tests/basic-cursor.test.js
//
// The clean-room BASIC's cursor in the 32K configuration (docs/clean-room-basic.md, "The cursor"): the black-box
// observations of the real ROMs [BB 2026-11-25] and, where they say nothing, the [OWNER-SPEC] functional
// specification's acceptance tests, on our ROM in a Dragon 64 and in a Dragon 32 (tests/basic/harness.js). Nothing
// hooks the ROM: the machine is stepped one instruction at a time from outside while BASIC waits for a key, and an
// update is seen as what it does to RAM: a write tap on $008F (the countdown) sees each decrement (a write of the old
// value - 1, modulo 256) and each reload (a write of 50 just after a write of 0). The test sets RAM from outside
// between instructions (as a program's POKE would), and a few checks do it with POKE typed into BASIC.
//  * Countdown: 2 -> the first decrement changes nothing, the second toggles; a transition reloads 50; 0 -> 255, no
//    change; 51 writes per transition (the reload and 50 decrements) [BB].
//  * Transformations: $60/$20, $41/$01, $FF/$BF both ways [BB]; for every byte 0-255 (on the Dragon 64) one
//    transition toggles bit 6 only and two give the byte back.
//  * Memory: a new address in $0088-$0089 redirects the next transition [BB]; the countdown's value sets when it
//    comes; a byte written under the cursor is the one transformed; screen memory (and the display) holds the cursor
//    byte; PEEK(&H88), PEEK(&H89) is the cursor's address; KEYDLY ($0097-$0098) is the cursor's delay.
//  * Keyboard: it blinks while BASIC waits; accepting a key writes $60 to the cursor's cell first and leaves $008F
//    alone [BB]; moving keeps the countdown.
//  * Running programs: one that prints nothing (GOTO, PEEK, INKEY$, an empty FOR) never writes the countdown; one
//    that prints counts it down [BB] (ours: one decrement a character [OWN]).
//  * Timing: cycles per decrement and per transition within 1% of the real ROM's [BB]; our delay is PASSES passes
//    of an 8-cycle countdown (LEAX -1,X; BNE) after each update, timed in CPU cycles.
//  * Configurations: the same results on the Dragon 32 and the Dragon 64 in 32K mode. Native 64K mode is not
//    applicable: our ROM is the 32K-mode BASIC only (the 64K-mode BASIC is out of scope, open question 7).
// The mutants (built from edited source by buildBasic({ edit })) that must each fail the quick checks are in
// tests/basic-cursor-mutants.test.js; the rig and the checks are in tests/basic/basic-cursor-lib.js.
const { Basic } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
const { check, tally, suite, BLINK, KEYDLY } = require('./basic/basic-cursor-lib.js');

const { rom } = buildBasic();
suite(rom);
{
  // a cold start [OWN]: the countdown set to 1, so the first update shows the cursor; the cursor's delay 1,118 [BB bb10
  // scr-prompt-idle: PEEK(151);PEEK(152) gives 4 94]
  const b = new Basic(rom), w = [];
  b.m.busTaps.addWriteTap({ start: BLINK, end: BLINK }, (a, v) => w.push(v));
  b.waitOk({ limit: 600, stable: 3 });
  // (cleared, set to 1, then the first update at the prompt takes it to 0 and reloads it)
  check('cold start: the countdown is cleared, set to 1, and reloaded at the first update (writes 0, 1, 0, 50)', w.slice(0, 4).join() === '0,1,0,50', w.slice(0, 4).join());
  check('cold start: the cursor\'s delay at $0097-$0098 is 1,118 ($04 $5E)', ((b.m.ram[KEYDLY] << 8) | b.m.ram[KEYDLY + 1]) === 1118);
}
suite(rom, { machine: 'dragon32', tag: 'Dragon 32: ' });   // (every byte 0-255 on the Dragon 64 only: the same code)
console.log('not applicable: native 64K mode ($AF/$8F blocks): our ROM is the 32K-mode BASIC only');

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
