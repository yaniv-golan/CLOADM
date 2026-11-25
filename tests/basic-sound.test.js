// Run: node tests/basic-sound.test.js
//
// The clean-room BASIC's sound and joysticks (docs/clean-room-basic-p2.md sections 6 and 7; decisions 3 and 4): SOUND,
// PLAY (every command), AUDIO and JOYSTK. BASIC is typed into a Dragon 64 running the image assembled from basic/ at
// test time (no other ROM). The sound is measured from a write tap on the PIAs (the harness's #wav: every DAC write
// and every change to whether the DAC is heard, with its CPU cycle) and checked against what the document specifies,
// computed here from its formulas and the ROM's equates, not from the 6809 code: every note's period against equal
// temperament from the anchor NOTEA (within 0.5%, and to the cycle against the rounded top octave doubled), note and
// pause lengths against PLAYW / (L x T) with dots, the volume as the levels 32 - V and 32 + V, SOUND's period and
// unit, TIMER during a note (SNDMSK), the multiplexer and sound switch after AUDIO, SOUND and JOYSTK, JOYSTK against
// the joystick values set in the machine, =var; and X var$; (nested), and the ?FC, ?SN and ?TM errors.
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const { rom, symbols } = buildBasic();
const EQ = (k) => { if (!symbols.has(k)) throw new Error(`no equate ${k}`); return symbols.get(k); };
const CLOCK = 14218000 / 16;                    // the Dragon 64's CPU clock [HW: sam.js, PAL]
const FIELD = CLOCK / 50;
const NOTEA = EQ('NOTEA') / 100, PLAYW = EQ('PLAYW'), VMID = EQ('VMID'), VSND = EQ('VSND');
const SNDU = EQ('SNDU'), SNDP0 = EQ('SNDP0'), SNDPK = EQ('SNDPK'), SNDMSK = EQ('SNDMSK');

function boot() {
  const b = new Basic(rom);
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no OK at boot');
  return b;
}
function typeAll(b, lines) {
  for (const l of lines) {
    if (b.type(l + '\n', 40000) !== 'done') throw new Error(`not typed: ${l}`);
    if (/^\d/.test(l)) b.run(3); else if (!b.waitOk({ limit: 20000 })) throw new Error(`no OK after: ${l}`);
  }
}
const last = (b) => b.screen().slice(-2)[0];
// type a line with the sound recorded: its measures
function wav(b, line) { b.wavStart(); typeAll(b, [line]); return b.wavStop(); }

// equal temperament [OWN, from the document]: semitone s from octave 1's C (0) to octave 5's B (59); octave 2's A
// (s = 21) is NOTEA. ours: the period of octave 5's note, rounded to the cycle, doubled for each octave down.
const etPeriod = (s) => CLOCK / (NOTEA * 2 ** ((s - 21) / 12));
const ourPeriod = (s) => Math.round(etPeriod(48 + (s % 12))) * 2 ** (4 - Math.floor(s / 12));
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---- pitch: every note of every octave, by letter with # and by number ----
{
  const b = boot();
  for (let o = 1; o <= 5; o++) {
    const m = wav(b, `PLAY "T16O${o}${NOTES.join('')}"`);
    const per = m.tones.map((t) => t.period), want = NOTES.map((_, k) => ourPeriod((o - 1) * 12 + k));
    const off = per.map((p, k) => Math.abs(p / etPeriod((o - 1) * 12 + k) - 1));
    check(`O${o}: 12 tones, each period exact (${want.join(' ')})`, per.length === 12 && per.every((p, k) => p === want[k]), per.join(' '));
    check(`O${o}: every period within 0.5% of equal temperament from A = ${NOTEA} Hz in O2`, off.length === 12 && Math.max(...off) < 0.005, `worst ${(Math.max(...off) * 100).toFixed(3)}%`);
  }
  let m = wav(b, 'PLAY "T16O3D-DE-EG-GA-AB-BC+"');
  check('flats and +: D- D E- E G- G A- A B- B C+ in O3', m.tones.map((t) => t.period).join() === [25, 26, 27, 28, 30, 31, 32, 33, 34, 35, 25].map((s) => ourPeriod(s)).join(), m.tones.map((t) => t.period).join(' '));
  m = wav(b, 'PLAY "T16O2N1N2N3N4N5N6N7N8N9N10N11N12"');
  check('N1-N12 are C to B', m.tones.map((t) => t.period).join() === NOTES.map((_, k) => ourPeriod(12 + k)).join());
  m = wav(b, 'PLAY "T16O2;1;3;5;12;10"');
  check('a number alone is a note: 1 3 5 12 10', m.tones.map((t) => t.period).join() === [12, 14, 16, 23, 21].map((s) => ourPeriod(s)).join(), m.tones.map((t) => t.period).join(' '));
  m = wav(b, 'PLAY "T16O2C-O3B+O2A O+A >A O-A <A"');
  check('C- in O2 is O1\'s B, B+ in O3 is O4\'s C; O+, >, O-, < move the octave', m.tones.map((t) => t.period).join() === [11, 36, 21, 33, 45, 33, 21].map((s) => ourPeriod(s)).join(), m.tones.map((t) => t.period).join(' '));
  m = wav(b, 'PLAY "A"');
  check('the first PLAY: octave 2, its A', m.tones.length === 1 && m.tones[0].period === ourPeriod(21));
}

// ---- lengths: L, T, dots, pauses; cycle-counted ----
// A note of length 1/L at tempo T with d dots lasts PLAYW x 256 / (L x T) x (2 - 2^-d) cycles, rounded down to whole
// periods (the count is in 256-cycle units, so up to 256 cycles a part less)
{
  const b = boot();
  typeAll(b, ['AUDIO OFF']);           // sound on before the first note, so no run starts at the switch
  const want = (L, T, d = 0) => PLAYW * 256 / (L * T) * (2 - 2 ** -d);
  const near = (t, D) => t && t.length < D + 1000 && t.length > D - t.period - 3 * 256 - 100;
  const cases = [['A', 4, 2, 0], ['L1A', 1, 2, 0], ['L2A', 2, 2, 0], ['L8A', 8, 2, 0], ['L64A', 64, 2, 0], ['T1L4A', 4, 1, 0], ['T5L4A', 4, 5, 0],
    ['T2L4A.', 4, 2, 1], ['L4A..', 4, 2, 2], ['L4.A', 4, 2, 1], ['L4.A.', 4, 2, 2], ['L4A', 4, 2, 0], ['L13T3A', 13, 3, 0]];
  for (const [s, L, T, d] of cases) {
    const m = wav(b, `PLAY "${s}"`), t = m.tones[0], D = want(L, T, d);
    check(`PLAY "${s}": one tone of ${Math.round(D)} cycles less under a period`, m.tones.length === 1 && near(t, D), t ? `${t.length} (period ${t.period})` : 'no tone');
  }
  // a pause: the gap between two notes grows by the pause's length
  typeAll(b, ['PLAY "T4L4"']);
  const gap = (s) => { const m = wav(b, `PLAY "${s}"`); return m.tones.length === 2 ? m.tones[1].start - (m.tones[0].start + m.tones[0].length) : NaN; };
  const g0 = gap('AC');
  for (const [s, L, d] of [['AP4C', 4, 0], ['AP8C', 8, 0], ['AP2.C', 2, 1], ['AP16..C', 16, 2]]) {
    const extra = gap(s) - g0, D = want(L, 4, d);
    check(`PLAY "${s}" at T4: the gap ${Math.round(D)} cycles longer (to the pause's period, ${EQ('PPER')}, and its reading)`, Math.abs(extra - D) < EQ('PPER') + 3 * 256 + 3000, `${extra}`);
  }
  // notes straight after each other are one run: a tone then starts at the rising edge before the change (the
  // harness's segmentation), so each note's length is the distance between the tones' starts, to a period or two
  const m = wav(b, 'PLAY "T2L4AL8CL16E"'), t3 = m.tones;
  check('lengths change within a string: L4, L8, then L16', t3.length === 3 && Math.abs(t3[1].start - t3[0].start - want(4, 2)) < t3[0].period + t3[1].period + 3000 &&
    Math.abs(t3[2].start - t3[1].start - want(8, 2)) < t3[1].period + t3[2].period + 3000 &&
    Math.abs(t3[2].length - want(16, 2) - t3[1].period) < t3[2].period + 3000, t3.map((t) => `${t.start}+${t.length}`).join(' '));
  typeAll(b, ['PLAY "L4.T2"']);
  const m2 = wav(b, 'PLAY "AL8A"');
  const both = want(4, 2, 1) + want(8, 2);       // (one tone: the same pitch; the second note read between them)
  check('a length\'s dot lasts until the next L', m2.tones.length === 1 && Math.abs(m2.tones[0].length - both) < 2 * m2.tones[0].period + 3000, `${m2.tones.map((t) => t.length)}`);
}

// ---- volume ----
{
  const b = boot();
  let m = wav(b, 'PLAY "T16A"');
  check(`the default volume 15: levels ${VMID - 15} and ${VMID + 15}`, m.tones[0].low === VMID - 15 && m.tones[0].high === VMID + 15);
  for (const v of [0, 1, 5, 20, 31]) {
    m = wav(b, `PLAY "V${v}A"`);
    const t = m.tones[0];
    check(`V${v}: levels ${VMID - v} and ${VMID + v}`, m.tones.length === 1 && t.low === VMID - v && t.high === VMID + v, `${t.low}-${t.high}`);
  }
  m = wav(b, 'PLAY "T2L16V31AP4V15CP4V5E"');
  check('volume changes within a string (pauses between, so each note is its own run)', m.tones.map((t) => `${t.low}-${t.high}`).join() === '1-63,17-47,27-37', m.tones.map((t) => `${t.low}-${t.high}`).join(' '));
  check('after PLAY: the DAC at its middle, sound on, the multiplexer on the DAC', b.m.pia1.a.outValue() >> 2 === VMID && m.end.enabled && m.end.mux === 0);
}

// ---- what lasts: from one PLAY to the next, until RUN ----
{
  const b = boot();
  typeAll(b, ['PLAY "O4L8T4V5"']);
  let m = wav(b, 'PLAY "A"');
  const t = m.tones[0];
  check('O4 L8 T4 V5 last into the next PLAY', m.tones.length === 1 && t.period === ourPeriod(45) && t.low === VMID - 5 && Math.abs(t.length - PLAYW * 256 / 32) < 2000, `${t.period} ${t.low} ${t.length}`);
  typeAll(b, ['10 PLAY "A"']);
  m = wav(b, 'RUN');
  check('RUN gives the defaults back (O2 L4 T2 V15)', m.tones.length === 1 && m.tones[0].period === ourPeriod(21) && m.tones[0].low === VMID - 15 && m.tones[0].length > PLAYW * 256 / 8 - 3000);
}

// ---- =var; and X var$; ----
{
  const b = boot();
  typeAll(b, ['A$="CDE":B$="GXA$;F":N=3:L=16:T=4']);
  let m = wav(b, 'PLAY "T16O2XA$;G"');
  check('X A$; plays the substring, then the rest', m.tones.map((t) => t.period).join() === [12, 14, 16, 19].map(ourPeriod).join());
  m = wav(b, 'PLAY "T16O2XB$;C"');
  check('X nested: B$ runs A$ inside it', m.tones.map((t) => t.period).join() === [19, 12, 14, 16, 17, 12].map(ourPeriod).join(), m.tones.map((t) => t.period).join(' '));
  m = wav(b, 'PLAY "O=N;L=L;T=T;A"');
  check('=var; for O, L and T', m.tones.length === 1 && m.tones[0].period === ourPeriod(33) && Math.abs(m.tones[0].length - PLAYW * 256 / 64) < m.tones[0].period + 1000, `${m.tones[0] && m.tones[0].period} ${m.tones[0] && m.tones[0].length}`);
  m = wav(b, 'PLAY "O2N=N;"');
  check('=var; for N', m.tones.length === 1 && m.tones[0].period === ourPeriod(14));
  typeAll(b, ['C$="XC$;"']);
  b.type('PLAY "XC$;"\n'); b.waitOk({ limit: 20000 });
  check('X recursing without end: ?OM ERROR', last(b) === '?OM ERROR', last(b));
}

// ---- SOUND ----
{
  const b = boot();
  for (const t of [1, 50, 100, 200, 255]) {
    const m = wav(b, `SOUND ${t},3`), P = SNDP0 + SNDPK * (256 - t), D = 3 * SNDU * 256;
    check(`SOUND ${t},3: period ${P} cycles, ${D} cycles long (less under a period)`, m.tones.length === 1 && m.tones[0].period === P && m.tones[0].length < D + 1000 && m.tones[0].length > D - P - 100,
      m.tones[0] ? `${m.tones[0].period} ${m.tones[0].length}` : '');
    check(`SOUND ${t},3: full volume (${VMID - VSND}-${VMID + VSND})`, m.tones[0] && m.tones[0].low === VMID - VSND && m.tones[0].high === VMID + VSND);
  }
  for (const d of [1, 7, 20]) {
    const m = wav(b, `SOUND 150,${d}`), D = d * SNDU * 256;
    check(`SOUND 150,${d}: ${D} cycles`, m.tones.length === 1 && m.tones[0].length < D + 1000 && m.tones[0].length > D - 2400, `${m.tones[0] && m.tones[0].length}`);
  }
  check('SOUND\'s unit is about 0.06 s', Math.abs(SNDU * 256 / CLOCK - 0.06) < 0.002);
  // TIMER during a note: counts (SNDMSK 0) or stops ($10)
  typeAll(b, ['TIMER=0:SOUND 100,20:PRINT TIMER']);
  const fields = 20 * SNDU * 256 / FIELD;
  check(`TIMER during SOUND 100,20 (${fields.toFixed(1)} fields): ${SNDMSK ? 'stopped' : 'counts'}`, SNDMSK ? Number(last(b)) <= 2 : Math.abs(Number(last(b)) - fields) <= 2, last(b));
}

// ---- AUDIO and the sound switch ----
{
  const b = boot();
  const st = () => ({ on: b.m.pia1.b.c2(), mux: (b.m.pia0.b.c2() ? 2 : 0) | (b.m.pia0.a.c2() ? 1 : 0) });
  let s = st();
  check('cold start: sound off, the multiplexer on the DAC', !s.on && s.mux === 0);
  typeAll(b, ['AUDIO ON']); s = st();
  check('AUDIO ON: sound on, the multiplexer on the cassette (CA2 high, CB2 low)', s.on && s.mux === 1);
  typeAll(b, ['AUDIO OFF']); s = st();
  check('AUDIO OFF: the multiplexer back to the DAC', s.on && s.mux === 0);
  typeAll(b, ['AUDIO ON:SOUND 100,1']); s = st();
  check('SOUND after AUDIO ON: the DAC heard', s.on && s.mux === 0);
  typeAll(b, ['AUDIO ON:X=JOYSTK(0)']); s = st();
  check('JOYSTK(0): the multiplexer back to the DAC, the sound switch as it was', s.on && s.mux === 0);
  check('the field interrupt still on (PIA 0 CB1 enabled)', (b.m.pia0.b.cr & 1) === 1);
  for (const [line, err] of [['AUDIO', 'SN'], ['AUDIO 1', 'SN']]) { typeAll(b, [line]); check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b)); }
}

// ---- JOYSTK ----
{
  const b = boot();
  let bad = null;
  for (let v = 0; v < 64 && !bad; v++) {
    const want = [0, 1, 2, 3].map((a) => (v + 16 * a) & 63);
    b.m.joy[0][0] = want[0]; b.m.joy[0][1] = want[1]; b.m.joy[1][0] = want[2]; b.m.joy[1][1] = want[3];
    typeAll(b, ['PRINT JOYSTK(0);JOYSTK(1);JOYSTK(2);JOYSTK(3)']);
    const got = last(b).trim().split(/\s+/).map(Number);
    if (got.join() !== want.join()) bad = `set ${want.join()}, read ${got.join()}`;
  }
  check('JOYSTK(0)-(3): every axis at every value 0-63, read back exactly', !bad, bad || '');
  b.m.joy[0][1] = 7; b.m.joy[1][1] = 9;
  typeAll(b, ['PRINT JOYSTK(1);JOYSTK(3)']);
  check('JOYSTK(1) and (3) without JOYSTK(0): what JOYSTK(0) last read', last(b).trim().split(/\s+/).join() === [(63 + 16) & 63, (63 + 48) & 63].join(), last(b));
  typeAll(b, ['PRINT JOYSTK(0);JOYSTK(1);JOYSTK(3)']);
  check('after JOYSTK(0): the new values', last(b).trim().split(/\s+/).slice(1).join() === '7,9', last(b));
  typeAll(b, ['SOUND 100,1']);
  const m = wav(b, 'X=JOYSTK(0)');
  check('JOYSTK(0) after SOUND is not heard: sound off while the DAC is stepped (6 steps an axis), on again after', m.heard === 0 && m.writes === 24 && m.end.enabled, `${m.writes} writes, ${m.heard} heard`);
  for (const line of ['PRINT JOYSTK(4)', 'PRINT JOYSTK(-1)']) { typeAll(b, [line]); check(`${line}: ?FC ERROR`, last(b) === '?FC ERROR', last(b)); }
}

// ---- errors ----
{
  const b = boot();
  const cases = [['SOUND 0,1', 'FC'], ['SOUND 1,0', 'FC'], ['SOUND 256,1', 'FC'], ['SOUND 1', 'SN'], ['PLAY "O0"', 'FC'], ['PLAY "O6"', 'FC'], ['PLAY "O5O+"', 'FC'],
    ['PLAY "O1O-"', 'FC'], ['PLAY "L0"', 'FC'], ['PLAY "L256"', 'FC'], ['PLAY "T0"', 'FC'], ['PLAY "V32"', 'FC'], ['PLAY "N0"', 'FC'], ['PLAY "N13"', 'FC'],
    ['PLAY "P0"', 'FC'], ['PLAY "O1C-"', 'FC'], ['PLAY "O5B+"', 'FC'], ['PLAY "Z"', 'FC'], ['PLAY "L"', 'FC'], ['PLAY "XA"', 'FC'], ['PLAY "O=Q"', 'FC'],
    ['PLAY "O=Q;"', 'FC'], ['PLAY 5', 'TM'], ['PLAY "XN;"', 'TM'], ['PLAY "O=A$;"', 'TM']];
  for (const [line, err] of cases) { typeAll(b, [line]); check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b)); }
  typeAll(b, ['10 PLAY "CDE":PLAY "V40"', '20 PRINT "NOT"']);
  typeAll(b, ['RUN']);
  check('an error in a program: ?FC ERROR IN 10', last(b) === '?FC ERROR IN 10', last(b));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
