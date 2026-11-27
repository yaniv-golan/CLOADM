// Run: node tests/basic-timing-loopb.test.js
//
// The clean-room BASIC's speed against the original's (docs/clean-room-basic.md section 2): bb12 time-loopb (PEEK of
// an address ANDed, by the loop's parts), every loop's count of fields the original's or up to a few per cent more, and
// its loop B within 4 fields of the original's, with the conversion's wait as it was before bb12 as the mutant that
// must take it out (tests/basic-timing.test.js says more).
const { check, tally, judge, built, cases } = require('./basic/basic-timing-lib.js');
const { buildBasic } = require('../tools/build-basic.js');

cases(['time-loopb']);

// ---- bb12 time-loopb: loop B (S=S+PEEK(28928+I AND 32767)) within 4 fields of the original's 573. Ours took 578
// when the conversion to an integer waited for each place under 16 bits, 17 cycles each (a 15-bit number one place),
// and takes 576 with places under 15 bits (fpconv.inc QINT). The margin is a field either way: the change is worth
// two fields of the loop ----
{
  const inRange = (r) => r.got[0] != null && r.got[0] >= r.want[0] && r.got[0] <= r.want[0] + 4;
  const now = judge(built.rom, 'time-loopb');
  check(`time-loopb loop B: the original's ${now.want[0]} fields, at most 4 more`, inRange(now), `${now.got[0]}`);
  // the wait as it was before bb12: places under 16 bits, 17 cycles each
  const old = buildBasic({ edit: (f, t) => {
    if (f !== 'fpconv.inc') return t;
    for (const [from, to] of [['CMPB    #17 ', 'CMPB    #16 '], ['SUBA    #17 ', 'SUBA    #16 '], ['QIW     PSHS    D\n        PULS    D', 'QIW     PSHS    B\n        PULS    B']]) {
      if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`);
      t = t.replace(from, to);
    }
    return t;
  } }).rom;
  const was = judge(old, 'time-loopb');
  check('mutant "the conversion waits for places under 16 bits, 17 cycles each (before bb12)": loop B more than 4 fields over', !inRange(was), `${was.got[0]}`);
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
