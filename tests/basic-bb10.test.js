// Run: node tests/basic-bb10.test.js
//
// The clean-room BASIC (assembled at test time) against the original's black-box records of batch bb10
// (tests/basic/bb/bb10-real.jsonl), replayed on ours through the black-box harness and compared as
// tools/basic-bb/compare.js compares them (docs/clean-room-basic.md sections 7, 12 and 14):
//  * cas-close-pending, cas-timing, cas-left-open2, cas-prog-display: identical: the blocks written (the leader counts
//    the tape decoder reads, the namefiles' fields, the data's hashes), the motor's runs within a field, the
//    transcripts and the screens the clears wiped;
//  * cas-ascii-save: identical but for one screen a clear wiped (the original shows a typed line twice: open);
//  * scr-prompt-idle: identical ($97-$98 = 4, 94; the blink, pictures that differ only in the cursor counted alike);
//  * snd-play-dac: the transcript (?FC ERROR for O1C- and O5B+) and every tone's period, writes and levels, but the
//    first level of a tone that starts from where the sound before it stopped (timing luck: open);
//  * bb2 snd-play-length: a pause's writes as many as the original's;
//  * mutants, each of which turns one of these red.
const fs = require('fs'), path = require('path');
const { buildBasic } = require('../tools/build-basic.js');
const { runCase } = require('./basic/harness.js');
const { compare, compareSounds } = require('../tools/basic-bb/compare.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const { rom } = buildBasic();
const real = fs.readFileSync(path.join(__dirname, 'basic/bb/bb10-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rec = (name) => real.find((x) => x.case === name);
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${name}.bas`), 'utf8');
const replay = (r, name) => { const o = runCase(r, caseText(name)); return { ...compare(new Map([[name, rec(name)]]), new Map([[name, { ...o, case: name }]])), o }; };

// cas-ascii-save's one known difference: the screen CLOAD "X" wiped, where the original shows A$="Z":GOTO 10 twice
const asciiKnown = (l) => /^cas-ascii-save: clear 1: the screen before it differs/.test(l);
// CSAVE ,A's text blocks: no run starts earlier than on the original's (a line never goes to the tape faster)
const neverEarlier = (o) => ['two-lines', 'one-line', 'empty'].every((t) => {
  const w = rec('cas-ascii-save').tapes.find((x) => x.name === t).motor, g = o.tapes.find((x) => x.name === t).motor;
  return w.length === g.length && w.every((m, i) => g[i].start >= m.start - 0.02);
});
// the runs of the blocks written (the summaries with blocks): none more than 0.1 field shorter than the original's (a
// block is never written faster; compare.js allows a field either way)
const notShorter = (name, o) => rec(name).tapes.every((t, i) => !t.blocks || t.motor.every((m, j) => {
  const g = o.tapes[i].motor[j];
  return g && (m.length == null || g.length >= m.length - 0.1);
}));
// snd-play-dac: what compareSounds reports, less what the first level of a tone decides (its first level, and the
// levels, the lowest and highest and so the period, which take the first level in): the tones whose first level is the
// original's must be identical
function soundDiffs(o) {
  const x = rec('snd-play-dac').sounds, y = o.sounds || [];
  if (x.length !== y.length) return [`${x.length} vs ${y.length} sounds`];
  const out = [];
  x.forEach((s, i) => {
    const t = y[i];
    if (s.tones.length !== t.tones.length) { out.push(`${s.name}: ${s.tones.length} vs ${t.tones.length} tones`); return; }
    s.tones.forEach((p, j) => {
      const q = t.tones[j];
      const one = compareSounds([{ ...s, tones: [p] }], [{ ...t, tones: [q] }]);
      const left = p.first === q.first ? one : one.filter((l) => /writes|length/.test(l));
      out.push(...left);
    });
  });
  return out;
}

const runs = {};
for (const name of ['cas-close-pending', 'cas-timing', 'cas-left-open2', 'cas-prog-display', 'scr-prompt-idle']) {
  const c = replay(rom, name);
  runs[name] = c;
  check(`bb10 ${name}: ours identical to the original's record`, c.same === 1, c.report.slice(0, 3).join(' | '));
  if (name.startsWith('cas-close') || name === 'cas-timing') check(`bb10 ${name}: no block written faster than on the original's (0.1 field)`, notShorter(name, c.o));
}
{
  const c = replay(rom, 'cas-ascii-save');
  runs['cas-ascii-save'] = c;
  const other = c.report.filter((l) => !asciiKnown(l));
  check('bb10 cas-ascii-save: ours as the original\'s record but the one clear', other.length === 0, other.slice(0, 3).join(' | '));
  check('bb10 cas-ascii-save: CSAVE ,A\'s text blocks start no earlier than on the original\'s', neverEarlier(c.o));
}
{
  const o = runCase(rom, caseText('snd-play-dac'));
  runs['snd-play-dac'] = { o };
  check('bb10 snd-play-dac: the transcript as the original\'s (?FC ERROR for O1C- and O5B+)', JSON.stringify(o.transcript) === JSON.stringify(rec('snd-play-dac').transcript));
  const d = soundDiffs(o);
  check('bb10 snd-play-dac: every tone as the original\'s but where its first level, the last sound\'s, differs', d.length === 0, d.slice(0, 3).join(' | '));
  // four writes a period, three levels (the middle, the high, the low) for a note heard after one at its own volume
  const a = o.sounds.find((s) => s.name === 'o5b').tones[0];
  check('bb10 snd-play-dac: O5B four writes a period, 3 levels 16-46', Math.abs(a.writes / a.periods - 4) < 0.05 && a.levels === 3 && a.low === 16 && a.high === 46, `${a.writes} writes, ${a.periods} periods, ${a.levels} levels`);
}

// a pause writes the middle level about every 865 cycles, as the original's (bb2 snd-play-length pause4, pause8,
// pause16: the pause and the note after it one tone, its writes those of the note's 164 periods and the pause's): the
// writes of each such tone within the bound compare.js allows a record that has them (a field's worth)
const bb2 = fs.readFileSync(path.join(__dirname, 'basic/bb/bb2-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.case === 'snd-play-length');
function pauseWrites(r) {
  const o = runCase(r, caseText('snd-play-length')), out = [];
  for (const name of ['pause4', 'pause8', 'pause16']) {
    const p = bb2.sounds.find((x) => x.name === name).tones[1], q = o.sounds.find((x) => x.name === name).tones[1];
    const bound = Math.ceil(p.writes / p.length * 17784) + 1;
    if (!q || Math.abs(p.writes - q.writes) > bound) out.push(`${name}: ${p.writes} vs ${q && q.writes} writes`);
  }
  return out;
}
{
  const d = pauseWrites(rom);
  check('bb2 snd-play-length: a pause and the note after it make as many writes as on the original', d.length === 0, d.join(' | '));
}

// mutants: our own source broken on purpose; each must turn its case's replay red
const MUTANTS = [
  ['no pause before a block (the decoder keeps every leader)', 'cassette.inc', '        EXG     A,A             ; 8', '        NOP', 'cas-close-pending'],
  ['a leader of 255 $55 before the block\'s own', 'cassette.inc', '        CLRB                    ; the leader: 256 $55 bytes', '        LDB     #255', 'cas-close-pending'],
  ['a data byte written no slower than the leader\'s', 'cassette.inc', 'CW3     PSHS    B               ; a data byte: 36 cycles more than the type\'s and the length\'s\n        NOP\n        MUL\n        MUL\n        PULS    B', 'CW3     NOP', 'cas-close-pending'],
  ['no wait after the motor starts to read', 'cassette.inc', 'CRBLK   JSR     CMSTD', 'CRBLK   JSR     CASON', 'cas-timing'],
  ['a character to the tape at the old pace', 'cassette.inc', 'CTDLY   EQU     11 ', 'CTDLY   EQU     36 ', 'cas-timing'],
  ['a record read with no wait', 'cassette.inc', 'CRDDLY  EQU     245 ', 'CRDDLY  EQU     1 ', 'cas-timing'],
  ['CSAVE ,A with no carriage return first', 'cassette.inc', '        JSR     CRLF            ; is one CR, in a data block of its own]', '        NOP\n        NOP\n        NOP', 'cas-ascii-save'],
  ['CSAVE\'s namefile with the addresses of CNAME\'s block', 'cassette.inc', 'CWHEAD  LDB     #11', 'CWHEAD  LDB     #15', 'cas-ascii-save'],
  ['a line of CSAVE ,A with no wait', 'program.inc', '        LDX     #LSDLY', '        LDX     #1', 'cas-ascii-save'],
  ['OPEN "I" typed without the search\'s clear and S', 'cassette.inc', '        JSR     CFIND           ; (shown as CLOAD shows it, unless in a program: CQUIET)', '        JSR     CF1', 'cas-left-open2'],
  ['OPEN "I" reads no data block', 'cassette.inc', '        BSR     CFILL           ; data block is read now [BB bb10 cas-left-open2: OPEN "I" typed, F GOOD, then f]', '        NOP\n        NOP', 'cas-left-open2'],
  ['the debounce delay at its old value', 'boot.inc', '        LDD     #1118 ', '        LDD     #300 ', 'scr-prompt-idle'],
  ['a pause written four times as often', 'play.inc', 'PPER    EQU     3460 ', 'PPER    EQU     865 ', 'snd-play-length'],
  ['a tone written twice a period (no middle level)', 'sound.inc', 'TN1     LDA     #VMID           ; 2  the middle\n        STA     ,Y              ; 4', 'TN1     LDA     #VMID           ; 2  the middle\n        NOP\n        NOP', 'snd-play-dac'],
];
for (const [what, file, from, to, name] of MUTANTS) {
  let mrom, err = null;
  try {
    mrom = buildBasic({ edit: (f, t) => { if (f !== file) return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${what}`); return t.replace(from, to); } }).rom;
  } catch (e) { err = e.message; }
  let red = false;
  if (!err) {
    if (name === 'snd-play-dac') { const o = runCase(mrom, caseText(name)); red = soundDiffs(o).length > 0; }
    else if (name === 'snd-play-length') red = pauseWrites(mrom).length > 0;
    else { const c = replay(mrom, name); red = name === 'cas-ascii-save' ? c.report.some((l) => !asciiKnown(l)) || !neverEarlier(c.o) : c.same === 0 || (name === 'cas-close-pending' && !notShorter(name, c.o)); }
  }
  check(`bb10 mutant "${what}": ${name} no longer as the original's`, !err && red, err || '');
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
