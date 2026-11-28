// Run: node tests/basic-timing-screen.test.js
//
// The screen's output against the original's speed (docs/clean-room-basic.md section 2): bb13c time-screen, 300
// passes each of the empty loop, CLS, CLS and 32 letters, CLS and PRINT I;, CLS and PRINT, and a PRINT on the bottom
// row (the screen moved up). Every loop the original's count of fields or more, never fewer; and up to 8% more but for
// the 32 letters, which ours prints about 30% slower (a character's own cost, open: section 2). CLS waits 2,760
// cycles (the statement only) and the move up 57 more, so that neither is faster than the original's; mutants without
// each wait must make a loop faster than the original's.
const { check, tally, judge, built, within, mutant, LABELS } = require('./basic/basic-timing-lib.js');

const SLOW = new Set([2]);       // the 32 letters: slower than 8% over, open
const atLeast = (r) => r.got.length === r.want.length && r.got.every((g, i) => g >= r.want[i]);
{
  const r = judge(built.rom, 'time-screen');
  check(`time-screen: the record has its ${LABELS['time-screen'].length} counts`, r.want.length === LABELS['time-screen'].length, JSON.stringify(r.want));
  LABELS['time-screen'].forEach((label, i) => check(SLOW.has(i) ? `time-screen ${label}: the original's ${r.want[i]} fields or more (open: about 30% more)` : `time-screen ${label}: the original's ${r.want[i]} fields or up to 8% more`,
    r.got[i] != null && (SLOW.has(i) ? r.got[i] >= r.want[i] : within(r.got[i], r.want[i])), `${r.got[i]}`));
}
for (const [what, file, from, to] of [
  ['CLS without its wait', 'interp.inc', '        LDX     #345            ;', '        LDX     #1              ;'],
  ['the move up without its wait', 'screen.inc', '        LDB     #11             ;', '        LDB     #1              ;'],
]) {
  const r = judge(mutant(file, from, to), 'time-screen');
  check(`mutant "${what}": a time-screen loop faster than the original's`, !atLeast(r), JSON.stringify(r.got));
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
