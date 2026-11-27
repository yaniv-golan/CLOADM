// The shared part of tests/basic-bb10*.test.js: the clean-room BASIC (assembled at test time) against the original's
// black-box records of batch bb10 (tests/basic/bb/bb10-real.jsonl), replayed on ours through the black-box harness
// and compared as tools/basic-bb/compare.js compares them (docs/clean-room-basic.md sections 7, 12 and 14), and the
// mutants of our own source, each of which must turn its case's replay red.
const fs = require('fs'), path = require('path');
const { buildBasic } = require('../../tools/build-basic.js');
const { runCase } = require('./harness.js');
const { compare, compareSounds } = require('../../tools/basic-bb/compare.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });
const { rom } = buildBasic();
const real = fs.readFileSync(path.join(__dirname, 'bb/bb10-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rec = (name) => real.find((x) => x.case === name);
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'cases', `${name}.bas`), 'utf8');
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

// a pause writes the middle level about every 865 cycles, as the original's (bb2 snd-play-length pause4, pause8,
// pause16: the pause and the note after it one tone, its writes those of the note's 164 periods and the pause's): the
// writes of each such tone within the bound compare.js allows a record that has them (a field's worth)
const bb2 = fs.readFileSync(path.join(__dirname, 'bb/bb2-real.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.case === 'snd-play-length');
function pauseWrites(r) {
  const o = runCase(r, caseText('snd-play-length')), out = [];
  for (const name of ['pause4', 'pause8', 'pause16']) {
    const p = bb2.sounds.find((x) => x.name === name).tones[1], q = o.sounds.find((x) => x.name === name).tones[1];
    const bound = Math.ceil(p.writes / p.length * 17784) + 1;
    if (!q || Math.abs(p.writes - q.writes) > bound) out.push(`${name}: ${p.writes} vs ${q && q.writes} writes`);
  }
  return out;
}

// the cases replayed whole: each identical to the original's record (and the blocks of cas-close-* and cas-timing
// written no faster)
function identical(names) {
  for (const name of names) {
    const c = replay(rom, name);
    check(`bb10 ${name}: ours identical to the original's record`, c.same === 1, c.report.slice(0, 3).join(' | '));
    if (name.startsWith('cas-close') || name === 'cas-timing') check(`bb10 ${name}: no block written faster than on the original's (0.1 field)`, notShorter(name, c.o));
  }
}

// mutants: our own source broken on purpose ([what, file, from, to, case]); each must turn its case's replay red
function mutants(list) {
  for (const [what, file, from, to, name] of list) {
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
}

module.exports = { check, tally, rom, rec, caseText, replay, asciiKnown, neverEarlier, soundDiffs, pauseWrites, identical, mutants };
