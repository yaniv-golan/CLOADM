// Run: node tests/basic-bb10-sound.test.js
//
// The clean-room BASIC's PLAY against the original's black-box records (docs/clean-room-basic.md sections 7, 12 and
// 14), replayed on ours through the black-box harness:
//  * bb10 snd-play-dac: the transcript (?FC ERROR for O1C- and O5B+) and every tone's period, writes and levels, but the
//    first level of a tone that starts from where the sound before it stopped (timing luck: open);
//  * bb2 snd-play-length: a pause's writes as many as the original's;
//  * mutants, each of which turns one of these red.
// The rest of bb10: tests/basic-bb10.test.js.
const { check, rom, rec, caseText, soundDiffs, pauseWrites, mutants, tally } = require('./basic/basic-bb10-lib.js');
const { runCase } = require('./basic/harness.js');

{
  const o = runCase(rom, caseText('snd-play-dac'));
  check('bb10 snd-play-dac: the transcript as the original\'s (?FC ERROR for O1C- and O5B+)', JSON.stringify(o.transcript) === JSON.stringify(rec('snd-play-dac').transcript));
  const d = soundDiffs(o);
  check('bb10 snd-play-dac: every tone as the original\'s but where its first level, the last sound\'s, differs', d.length === 0, d.slice(0, 3).join(' | '));
  // four writes a period, three levels (the middle, the high, the low) for a note heard after one at its own volume
  const a = o.sounds.find((s) => s.name === 'o5b').tones[0];
  check('bb10 snd-play-dac: O5B four writes a period, 3 levels 16-46', Math.abs(a.writes / a.periods - 4) < 0.05 && a.levels === 3 && a.low === 16 && a.high === 46, `${a.writes} writes, ${a.periods} periods, ${a.levels} levels`);
}
{
  const d = pauseWrites(rom);
  check('bb2 snd-play-length: a pause and the note after it make as many writes as on the original', d.length === 0, d.join(' | '));
}
mutants([
  ['a pause written four times as often', 'play.inc', 'PPER    EQU     3460 ', 'PPER    EQU     865 ', 'snd-play-length'],
  ['a tone written twice a period (no middle level)', 'sound.inc', 'TN1     LDA     #VMID           ; 2  the middle\n        STA     ,Y              ; 4', 'TN1     LDA     #VMID           ; 2  the middle\n        NOP\n        NOP', 'snd-play-dac'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
