// Run: node tests/basic-sound-audio.test.js
//
// The clean-room BASIC's SOUND and AUDIO (docs/clean-room-basic-p2.md sections 6 and 7; decisions 3 and 4), typed into
// a Dragon 64 running the image assembled from basic/ at test time, the sound measured from a write tap on the PIAs
// and checked against the document's formulas and the ROM's equates: SOUND's period and length and levels, the
// multiplexer and sound switch after AUDIO, SOUND, PLAY, an error and JOYSTK, BREAK not stopping PLAY, the ?FC, ?SN
// and ?TM errors of SOUND and PLAY, and mutants of SOUND that the SOUND checks must catch (tests/basic-sound.test.js
// has PLAY; the shared code is tests/basic/basic-sound-lib.js).
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');
const { check, tally, FIELD, SNDH, SNDL, SNDU, boot, typeAll, last, wav, st, soundRuns } = require('./basic/basic-sound-lib.js');

// ---- SOUND ----
{
  const b = boot();
  for (const r of soundRuns(b)) {
    check(`SOUND ${r.t},3: period ${r.P} cycles, ${r.c} fields`, r.ok, r.detail);
    check(`SOUND ${r.t},3: full scale (${SNDL}-${SNDH})`, r.full && SNDL === 0 && SNDH === 63);
  }
  check('after SOUND: the DAC low, sound off', st(b).dac === SNDL && !st(b).on, JSON.stringify(st(b)));
  for (const d of [1, 7, 20]) {
    const m = wav(b, `SOUND 150,${d}`), c = d * SNDU;
    check(`SOUND 150,${d}: ${c} fields`, m.tones.length === 1 && m.tones[0].length > (c - 1) * FIELD - 2220 && m.tones[0].length < c * FIELD + 4440, `${m.tones[0] && (m.tones[0].length / FIELD).toFixed(2)}`);
  }
}

// ---- AUDIO, the sound switch, BREAK ----
{
  const b = boot();
  let s = st(b);
  check('cold start: sound off, the multiplexer on the DAC, the DAC at 0', !s.on && s.mux === 0 && s.dac === 0);
  typeAll(b, ['AUDIO ON']); s = st(b);
  check('AUDIO ON: sound on, the multiplexer on the cassette (CA2 high, CB2 low)', s.on && s.mux === 1);
  typeAll(b, ['AUDIO OFF']); s = st(b);
  check('AUDIO OFF: sound off, the multiplexer left on the cassette', !s.on && s.mux === 1);
  typeAll(b, ['AUDIO ON']);
  const m = wav(b, 'SOUND 100,1');
  s = st(b);
  check('SOUND after AUDIO ON: the DAC heard, then sound off and the multiplexer on the DAC', m.tones.length === 1 && !s.on && s.mux === 0);
  typeAll(b, ['AUDIO ON:X=JOYSTK(0)']); s = st(b);
  check('JOYSTK(0): the multiplexer back to the DAC, the sound switch as it was', s.on && s.mux === 0);
  typeAll(b, ['PLAY "Z"']); s = st(b);
  check('an error in PLAY: ?FC ERROR, sound off', last(b) === '?FC ERROR' && !s.on && s.mux === 0, `${last(b)} ${JSON.stringify(s)}`);
  check('the field interrupt still on (PIA 0 CB1 enabled)', (b.m.pia0.b.cr & 1) === 1);
  for (const [line, err] of [['AUDIO', 'SN'], ['AUDIO 1', 'SN']]) { typeAll(b, [line]); check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b)); }
  // BREAK held during a PLAY does not stop it
  b.wavStart();
  b.type('PLAY "T8L4CDE"\n');
  b.run(20);
  b.m.setKey('BREAK', true); b.run(60); b.m.setKey('BREAK', false);
  b.waitOk({ limit: 3000 });
  const w = b.wavStop();
  check('BREAK held during PLAY: every note plays', w.tones.length === 3 && !b.screen().includes('BREAK'), `${w.tones.length} tones, ${b.screen().slice(-3).join('|')}`);
}

// ---- errors ----
{
  const b = boot();
  const cases = [['SOUND 0,1', 'FC'], ['SOUND 1,0', 'FC'], ['SOUND 256,1', 'FC'], ['SOUND 1', 'SN'], ['PLAY "O0"', 'FC'], ['PLAY "O6"', 'FC'], ['PLAY "O5O+"', 'FC'],
    ['PLAY "O1O-"', 'FC'], ['PLAY "L0"', 'FC'], ['PLAY "L256"', 'FC'], ['PLAY "T0"', 'FC'], ['PLAY "V32"', 'FC'], ['PLAY "N0"', 'FC'], ['PLAY "N13"', 'FC'],
    ['PLAY "P0"', 'FC'], ['PLAY "Z"', 'FC'], ['PLAY "L"', 'FC'], ['PLAY "XA"', 'FC'], ['PLAY "O=Q"', 'FC'],
    ['PLAY "O=Q;"', 'FC'], ['PLAY 5', 'TM'], ['PLAY "XN;"', 'TM'], ['PLAY "O=A$;"', 'TM']];
  for (const [line, err] of cases) { typeAll(b, [line]); check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b)); }
  typeAll(b, ['10 PLAY "CDE":PLAY "V40"', '20 PRINT "NOT"']);
  typeAll(b, ['RUN']);
  check('an error in a program: ?FC ERROR IN 10', last(b) === '?FC ERROR IN 10', last(b));
}

// ---- mutants of SOUND (built from edited source): the check above must catch a period 4 cycles long and a sound a
// unit long, each turning at least one SOUND check red ----
for (const [name, from, to] of [['a period 4 cycles long', 'ADDD    #SNDP0', 'ADDD    #SNDP0+4'], ['a sound a unit long', 'LDA     #SNDU', 'LDA     #SNDU+1']]) {
  let used = false;
  const mrom = buildBasic({ edit: (f, text) => { if (f !== 'sound.inc') return text; if (!text.includes(from)) throw new Error(`mutant ${name}: no ${from}`); used = true; return text.replace(from, to); } }).rom;
  const mb = new Basic(mrom);
  if (!mb.waitOk({ limit: 600, stable: 3 })) throw new Error('mutant: no OK at boot');
  const bad = soundRuns(mb).filter((r) => !r.ok);
  check(`mutant "${name}" fails the SOUND checks`, used && bad.length > 0, bad.map((r) => `${r.t}: ${r.detail}`).join('; '));
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
