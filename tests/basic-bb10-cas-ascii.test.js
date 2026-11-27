// Run: node tests/basic-bb10-cas-ascii.test.js
//
// bb10 cas-ascii-save (tests/basic/bb/bb10-real.jsonl) replayed on the clean-room BASIC (docs/clean-room-basic.md
// sections 7, 12 and 14): identical to the original's record but for one screen a clear wiped (the original shows a
// typed line twice: open), CSAVE ,A's text blocks starting no earlier than the original's, and mutants of CSAVE ,A,
// each of which turns it red. The rest of bb10: tests/basic-bb10.test.js.
const { check, rom, replay, asciiKnown, neverEarlier, mutants, tally } = require('./basic/basic-bb10-lib.js');

{
  const c = replay(rom, 'cas-ascii-save');
  const other = c.report.filter((l) => !asciiKnown(l));
  check('bb10 cas-ascii-save: ours as the original\'s record but the one clear', other.length === 0, other.slice(0, 3).join(' | '));
  check('bb10 cas-ascii-save: CSAVE ,A\'s text blocks start no earlier than on the original\'s', neverEarlier(c.o));
}
mutants([
  ['CSAVE ,A with no carriage return first', 'cassette.inc', '        JSR     CRLF            ; is one CR, in a data block of its own]', '        NOP\n        NOP\n        NOP', 'cas-ascii-save'],
  ['CSAVE\'s namefile with the addresses of CNAME\'s block', 'cassette.inc', 'CWHEAD  LDB     #11', 'CWHEAD  LDB     #15', 'cas-ascii-save'],
  ['a line of CSAVE ,A with no wait', 'program.inc', '        LDX     #LSDLY', '        LDX     #1', 'cas-ascii-save'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
