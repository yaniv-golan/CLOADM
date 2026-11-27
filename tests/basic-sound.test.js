// Run: node tests/basic-sound.test.js
//
// The clean-room BASIC's sound and joysticks (docs/clean-room-basic-p2.md sections 6 and 7; decisions 3 and 4): SOUND,
// PLAY (every command), AUDIO and JOYSTK. BASIC is typed into a Dragon 64 running the image assembled from basic/ at
// test time (no other ROM). The sound is measured from a write tap on the PIAs (the harness's #wav: every DAC write
// and every change to whether the DAC is heard, with its CPU cycle) and checked against what the document specifies,
// computed here from its formulas and the ROM's equates (the constants fitted to the black-box measures, section 7),
// not from the 6809 code: every note's period to the cycle (the note table rounded on its octave's grid) and within
// a step of that grid of equal temperament, lengths in fields (PLAYW / (L x T), dots, at most 255; SOUND 4 fields a unit) and TIMER
// counting through them, a note of 0 fields still three periods, the levels 31 - V and 31 + V and the default's,
// where the next sound starts from (the DAC left where the last one ended, sound off), SOUND's period and levels, the
// multiplexer and sound switch after AUDIO, SOUND, PLAY, an error and JOYSTK, BREAK not stopping PLAY, JOYSTK against
// the joystick values set in the machine, =var; and X var$; (nested), and the ?FC, ?SN and ?TM errors.
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const { rom, symbols } = buildBasic();
const EQ = (k) => { if (!symbols.has(k)) throw new Error(`no equate ${k}`); return symbols.get(k); };
const CLOCK = 14218000 / 16;                    // the Dragon 64's CPU clock [HW: sam.js, PAL]
const FIELD = 312 * 57;                         // cycles a field (312 lines of 57 cycles) [HW]
const NOTEA = EQ('NOTEA') / 100, NOTEP = EQ('NOTEP'), PRND = EQ('PRND'), PLAYW = EQ('PLAYW');
const GRID = (o) => (o <= 2 ? [EQ('NGR1'), EQ('NAD1')] : [EQ('NGR3'), EQ('NAD3')]);
const VMID = EQ('VMID') >> 2, PVDEF = EQ('PVDEF'), SNDH = EQ('SNDH') >> 2, SNDL = EQ('SNDL') >> 2;
const SNDU = EQ('SNDU'), SNDP0 = EQ('SNDP0'), SNDPK = EQ('SNDPK');
// the field interrupt, entry to RTI, in cycles: what it lengthens the period it falls in by. The original's octave 1
// C to G medians are 104 cycles longer than their periods [BB bb2 snd-play-pitch o1]; ours pads its handler to match
const IRQC = 104;

function boot() {
  const b = new Basic(rom);
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no OK at boot');
  return b;
}
function typeAll(b, lines) {
  for (const l of lines) {
    if (b.type(l + '\n', 40000) !== 'done') throw new Error(`not typed: ${l}`);
    if (/^\d/.test(l)) b.run(3); else if (!b.waitOk({ limit: 40000 })) throw new Error(`no OK after: ${l}`);
  }
}
const last = (b) => b.screen().slice(-2)[0];
// type a line with the sound recorded: its measures, and the events (for the shortest period within a tone)
function wav(b, line) { b.wavStart(); const ev = b.wav.events; typeAll(b, [line]); const m = b.wavStop(); m.events = ev; return m; }
// the shortest time between rising crossings within each tone: the period itself, with no field interrupt in it
function cleanPeriods(m) {
  return m.tones.map((t) => {
    const ev = m.events.filter((e) => e.on && e.dac && e.t >= t.start && e.t <= t.start + t.length);
    const mid = (t.low + t.high) / 2, up = [];
    for (let i = 1; i < ev.length; i++) if (ev[i - 1].v < mid && ev[i].v >= mid) up.push(ev[i].t);
    return Math.min(...up.slice(1).map((x, i) => x - up[i]));
  });
}
const st = (b) => ({ on: b.m.pia1.b.c2(), mux: (b.m.pia0.b.c2() ? 2 : 0) | (b.m.pia0.a.c2() ? 1 : 0), dac: b.m.pia1.a.outValue() >> 2 });

// the period of semitone s (0, octave 1's C, to 59, octave 5's B) as section 6 gives it: octave 1's note as the
// assembler rounds it (4 x the period, NOTEP x 2^((9-k)/12) / 4), halved for each octave up, PRND added, over 4,
// rounded down to the octave's grid, plus its NAD
function period(s) {
  const o = Math.floor(s / 12) + 1, k = s % 12, R = Math.round(2 ** ((9 - k) / 12) * 65536);
  const x = Math.floor((Math.floor(NOTEP * 2 * R / 65536) + 1) / 2) >> (o - 1), y = (x + PRND) >> 2, [g, a] = GRID(o);
  return y - (y % g) + a;
}
// equal temperament from octave 3's A at NOTEA Hz for the 894,886 Hz clock the original's pitches are worked out for
const etPeriod = (s) => 894886 / (NOTEA * 2 ** ((s - 33) / 12));
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---- the fitted equates against the real ROM's black-box measures (tests/basic/bb/bb2-real.jsonl, measures only) ----
{
  const real = new Map(require('fs').readFileSync(require('path').join(__dirname, 'basic/bb/bb2-real.jsonl'), 'utf8').split('\n')
    .filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.case, c]));
  const snd = (c, name) => real.get(c).sounds.find((s) => s.name === name).tones;
  // octave 1's C-G: the median is an interrupted period there (section 6), the period and the field interrupt
  const pitch = [['o1', 0], ['o2', 12], ['o3', 24], ['o4', 36], ['o5', 48]];
  const NAT = [0, 2, 4, 5, 7, 9, 11];
  const want = [], got = [];
  for (const [name, base] of pitch) snd('snd-play-pitch', name).forEach((t, i) => { want.push(t.period); got.push(period(base + NAT[i]) + (base === 0 && NAT[i] <= 7 ? IRQC : 0)); });
  snd('snd-play-pitch', 'accidentals').forEach((t, i) => { want.push(t.period); got.push(period(12 + i)); });
  [25, 26, 27, 28, 30, 31, 32, 33, 34, 35].forEach((s, i) => { want.push(snd('snd-play-pitch', 'flats')[i].period); got.push(period(s)); });
  check(`NOTEA and the grids give the ${want.length} measured periods to the cycle`, want.join() === got.join(), got.filter((p, i) => p !== want[i]).join(' '));
  const sp = [1, 50, 100, 150, 255].map((t) => [snd('snd-sound', `t${t}`)[0].period, SNDP0 + SNDPK * (256 - t)]);
  check('SNDP0 and SNDPK give SOUND\'s measured periods', sp.every(([a, b]) => a === b), JSON.stringify(sp));
  const sl = [1, 2, 5, 10, 20].map((d) => snd('snd-sound', `d${d}`)[0].length / FIELD - d * SNDU);
  check('SNDU: each measured SOUND length between d x SNDU - 1 and d x SNDU fields', sl.every((x) => x > -1 && x <= 0), sl.map((x) => x.toFixed(2)).join(' '));
  const pl = [1, 2, 4, 8, 16, 32].map((L) => snd('snd-play-length', `l${L}`)[0].length / FIELD - Math.floor(PLAYW / (2 * L)));
  check('PLAYW: each measured L1-L32 length at T2 between n - 1 and n fields', pl.every((x) => x > -1 && x <= 0.1), pl.map((x) => x.toFixed(2)).join(' '));
  const v = snd('snd-play-volume', 'v20')[0], d = snd('snd-play-length', 'l4')[0];
  check('VMID and PVDEF give the measured levels (V20, the default)', v.low === VMID - 20 && v.high === VMID + 20 && d.low === ((EQ('VMID') + 2 - PVDEF) & 0xFC) >> 2 && d.high === ((EQ('VMID') + 2 + PVDEF) & 0xFC) >> 2);
  const s1 = snd('snd-sound', 't1')[0];
  check('SNDL and SNDH give SOUND\'s measured levels', s1.low === SNDL && s1.high === SNDH);
}

// ---- pitch: every note of every octave, by letter with # and by number ----
{
  const b = boot();
  for (let o = 1; o <= 5; o++) {
    const m = wav(b, `PLAY "T4O${o}${NOTES.join('')}"`);
    const per = cleanPeriods(m), want = NOTES.map((_, k) => period((o - 1) * 12 + k));
    const off = per.map((p, k) => Math.abs(p / etPeriod((o - 1) * 12 + k) - 1));
    check(`O${o}: 12 tones, each period exact (${want.join(' ')})`, per.length === 12 && per.every((p, k) => p === want[k]), per.join(' '));
    check(`O${o}: every period within one step of its grid (${GRID(o)[0]} cycles) of equal temperament`, off.length === 12 && off.every((d, k) => d * etPeriod((o - 1) * 12 + k) <= GRID(o)[0]), `worst ${(Math.max(...off) * 100).toFixed(3)}%`);
    if (o === 1) {
      // C to G (periods over half a field): the median holds the field interrupt, which takes IRQC cycles as the
      // original's. G's period is only 51% of a field, so about half its periods hold the interrupt and its median is
      // the interrupted one or, with exactly half, the mean of the two (the field's phase decides; the real's was 9235)
      const med = want.map((p, k) => p + (k <= 7 ? IRQC : 0)), got = m.tones.map((t) => t.period);
      const okG = got[7] === med[7] || got[7] === want[7] + IRQC / 2;
      check(`O1: the tones' median periods, C to F# holding the field interrupt's ${IRQC} cycles, G it or half of it (${med.join(' ')})`, got.length === 12 && got.every((p, k) => k === 7 ? okG : p === med[k]), got.join(' '));
    }
    if (o <= 2) continue;
    check(`O${o}: the tones' median periods are the periods (none holds a field interrupt in most periods)`, m.tones.map((t) => t.period).join() === want.join());
  }
  let m = wav(b, 'PLAY "T4O3D-DE-EG-GA-AB-BC+"');
  check('flats and +: D- D E- E G- G A- A B- B C+ in O3', cleanPeriods(m).join() === [25, 26, 27, 28, 30, 31, 32, 33, 34, 35, 25].map(period).join(), cleanPeriods(m).join(' '));
  m = wav(b, 'PLAY "T8O2N1N2N3N4N5N6N7N8N9N10N11N12"');
  check('N1-N12 are C to B', cleanPeriods(m).join() === NOTES.map((_, k) => period(12 + k)).join());
  m = wav(b, 'PLAY "T8O2;1;3;5;12;10"');
  check('a number alone is a note: 1 3 5 12 10', cleanPeriods(m).join() === [12, 14, 16, 23, 21].map(period).join(), cleanPeriods(m).join(' '));
  m = wav(b, 'PLAY "T8O2C-O3B+O2A O+A O-A"');
  check('C- in O2 is O1\'s B, B+ in O3 is O4\'s C; O+ and O- move the octave', cleanPeriods(m).join() === [11, 36, 21, 33, 21].map(period).join(), cleanPeriods(m).join(' '));
  for (const s of ['O3>A', 'O3<A', 'O1C-', 'O5B+']) { typeAll(b, [`PLAY "${s}"`]); check(`PLAY "${s}": ?FC ERROR`, last(b) === '?FC ERROR', last(b)); }
  const c = boot();
  m = wav(c, 'PLAY "A"');
  check('the first PLAY: octave 3, its A', m.tones.length === 1 && cleanPeriods(m)[0] === period(33), `${cleanPeriods(m)}`);
}

// ---- lengths in fields: L, T, dots, pauses ----
// A note of 1/L at tempo T with d dots lasts c = PLAYW / (L x T) fields rounded down, each dot adding half the last
// part, at most 255; it stops at the end of the period in which the c-th field since its start begins, so it lasts
// from c - 1 fields to c fields and a period
{
  const b = boot();
  const fields = (L, T, d = 0) => { let q = Math.floor(PLAYW / (L * T)), c = q; for (let i = 0; i < d; i++) { q >>= 1; c += q; } return Math.min(c, 255); };
  const near = (t, c) => t && t.length > (c - 1) * FIELD - 2 * t.period && t.length < c * FIELD + 2 * t.period;
  const cases = [['A', 4, 2, 0], ['L1A', 1, 2, 0], ['L2A', 2, 2, 0], ['L8A', 8, 2, 0], ['L64A', 64, 2, 0], ['T1L4A', 4, 1, 0], ['T5L4A', 4, 5, 0],
    ['T2L4.A', 4, 2, 1], ['T2L4..A', 4, 2, 2], ['L13T3A', 13, 3, 0], ['T1L1A', 1, 1, 0], ['T1L1.A', 1, 1, 1]];
  for (const [s, L, T, d] of cases) {
    const m = wav(b, `PLAY "${s}"`), t = m.tones[0], c = fields(L, T, d);
    check(`PLAY "${s}": one tone of ${c} fields`, m.tones.length === 1 && near(t, c), t ? `${(t.length / FIELD).toFixed(2)} fields (period ${t.period})` : 'no tone');
  }
  // a note of 0 fields: three periods, every one exact, four writes each (the middle, the high, the middle, the low
  // [BB bb10 snd-play-dac: four writes a period])
  let m = wav(b, 'PLAY "T255L4A"');
  check('PLAY "T255L4A": 0 fields, three periods, each exact, 12 writes', m.tones.length === 1 && m.tones[0].period === period(33) && m.events.filter((e) => e.dac && e.on).length === 12,
    `${m.tones[0] && m.tones[0].period}, ${m.events.filter((e) => e.dac && e.on).length} writes`);
  // a dot after a note or a pause: ?FC ERROR, after the note has played
  for (const [s, k] of [['L4A.', 1], ['L4.A.', 1], ['AP8.C', 1]]) {
    m = wav(b, `PLAY "${s}"`);
    check(`PLAY "${s}": ${k} tone, then ?FC ERROR`, m.tones.length === k && last(b) === '?FC ERROR', `${m.tones.length} ${last(b)}`);
  }
  // a pause is heard as nothing but keeps the sound on: it and the note after it are one tone
  typeAll(b, ['PLAY "T4L4"']);
  for (const [s, L] of [['AP4C', 4], ['AP8C', 8], ['AP2C', 2]]) {
    m = wav(b, `PLAY "${s}"`);
    const t = m.tones[1], c = fields(4, 4) + fields(L, 4);
    check(`PLAY "${s}" at T4: the pause and C one tone of ${c} fields, at C's period`, m.tones.length === 2 && near(t, c) && t.period === period(24) && t.low === m.tones[0].low,
      t ? `${(t.length / FIELD).toFixed(2)} fields, period ${t.period}` : `${m.tones.length} tones`);
  }
  // TIMER counts through notes and SOUND
  typeAll(b, ['TIMER=0:PLAY "T2L4CDEF":PRINT TIMER']);
  check('TIMER through PLAY "L4CDEF" at T2: 4 x 32 fields', Math.abs(Number(last(b)) - 4 * fields(4, 2)) <= 1, last(b));
  typeAll(b, ['TIMER=0:SOUND 100,20:PRINT TIMER']);
  check(`TIMER through SOUND 100,20: ${20 * SNDU} fields`, Math.abs(Number(last(b)) - 20 * SNDU) <= 1, last(b));
  // notes straight after each other: L4, L8, L16 in one string
  m = wav(b, 'PLAY "T2L4AL8CL16E"');
  const t3 = m.tones, gap = (j) => t3[j].start - t3[j - 1].start;
  check('lengths change within a string: L4, L8, then L16', t3.length === 3 && Math.abs(gap(1) - 31.5 * FIELD) < FIELD && Math.abs(gap(2) - 15.5 * FIELD) < FIELD && near(t3[2], 8),
    t3.map((t) => `${t.start}+${t.length}`).join(' '));
}

// ---- volume, and where the next sound starts from ----
{
  const b = boot();
  const lev = (v) => [((EQ('VMID') + 2 - v) & 0xFC) >> 2, ((EQ('VMID') + 2 + v) & 0xFC) >> 2];
  let m = wav(b, 'PLAY "T16A"');
  check('the first PLAY after a cold start starts from level 0 (the DAC as reset left it)', m.tones[0].low === 0 && m.tones[0].high === lev(PVDEF)[1], `${m.tones[0].low}-${m.tones[0].high}`);
  check(`after PLAY: sound off, the multiplexer on the DAC, the DAC at the volume's high level ${lev(PVDEF)[1]}`, !st(b).on && st(b).mux === 0 && st(b).dac === lev(PVDEF)[1], JSON.stringify(st(b)));
  m = wav(b, 'PLAY "T16A"');
  check(`the default volume: levels ${lev(PVDEF).join('-')} (17-46)`, m.tones[0].low === 17 && m.tones[0].high === 46 && lev(PVDEF).join() === '17,46', `${m.tones[0].low}-${m.tones[0].high}`);
  for (const v of [5, 15, 20, 31]) {
    const from = st(b).dac;
    m = wav(b, `PLAY "V${v}T16A"`);
    const t = m.tones[0];
    check(`V${v}: levels ${VMID - v} and ${VMID + v} (from ${from})`, m.tones.length === 1 && t.low === Math.min(VMID - v, from) && t.high === Math.max(VMID + v, from), `${t.low}-${t.high}`);
  }
  m = wav(b, 'PLAY "V0T16A"');
  check('V0 after V31: no wave, only the level the DAC was left at (62) and the middle', m.tones.length === 1 && m.tones[0].period === null && m.tones[0].low === VMID && m.tones[0].high === VMID + 31, `${m.tones[0].low}-${m.tones[0].high}`);
  m = wav(b, 'PLAY "V1T16A"');
  check('V1 after V0: levels 30-32', m.tones[0].low === VMID - 1 && m.tones[0].high === VMID + 1, `${m.tones[0].low}-${m.tones[0].high}`);
  m = wav(b, 'PLAY "T2L16V31AP4V15CP4V5E"');
  const lv = [...new Set(m.events.filter((e) => e.dac && e.on).map((e) => e.v))].sort((x, y) => x - y);
  // (and the middle, 31, which every period writes twice, and a pause holds [BB bb10 snd-play-dac: 3 levels a note];
  // a pause after a note that ended on 0 rises to the middle, which the measures take as a crossing: the three notes
  // are the tones of more than two periods)
  const notes = m.tones.filter((t) => t.periods > 2).map((t) => t.period);
  check('volume changes within a string: only V31\'s, V15\'s and V5\'s levels written and the middle, a pause at the middle', notes.join() === [period(33), period(24), period(28)].join() && lv.join() === '0,16,26,31,36,46,62', `${notes.join(' ')}; ${lv.join(' ')}`);
}

// ---- what lasts: from one PLAY to the next, until RUN ----
{
  const b = boot();
  typeAll(b, ['PLAY "O4L8T4V5"']);
  let m = wav(b, 'PLAY "A"');
  const t = m.tones[0];
  check('O4 L8 T4 V5 last into the next PLAY', m.tones.length === 1 && cleanPeriods(m)[0] === period(45) && t.low === VMID - 5 && t.length < 8 * FIELD + 2000 && t.length > 7 * FIELD - 2000, `${t.period} ${t.low} ${t.length}`);
  typeAll(b, ['10 PLAY "A"']);
  m = wav(b, 'RUN');
  check('RUN gives the defaults back (O3 L4 T2, the default volume)', m.tones.length === 1 && cleanPeriods(m)[0] === period(33) && m.tones[0].low === 17 && m.tones[0].length > 31 * FIELD - 3000);
}

// ---- =var; and X var$; ----
{
  const b = boot();
  typeAll(b, ['A$="CDE":B$="GXA$;F":N=3:L=16:T=4']);
  let m = wav(b, 'PLAY "T8O2XA$;G"');
  check('X A$; plays the substring, then the rest', cleanPeriods(m).join() === [12, 14, 16, 19].map(period).join());
  m = wav(b, 'PLAY "T8O2XB$;C"');
  check('X nested: B$ runs A$ inside it', cleanPeriods(m).join() === [19, 12, 14, 16, 17, 12].map(period).join(), cleanPeriods(m).join(' '));
  m = wav(b, 'PLAY "O=N;L=L;T=T;A"');
  check('=var; for O, L and T', m.tones.length === 1 && cleanPeriods(m)[0] === period(33) && m.tones[0].length < 4 * FIELD + 2000 && m.tones[0].length > 3 * FIELD - 2000, `${m.tones[0] && m.tones[0].period} ${m.tones[0] && m.tones[0].length}`);
  m = wav(b, 'PLAY "T8O2N=N;"');
  check('=var; for N', m.tones.length === 1 && cleanPeriods(m)[0] === period(14));
  typeAll(b, ['C$="XC$;"']);
  b.type('PLAY "XC$;"\n'); b.waitOk({ limit: 20000 });
  check('X recursing without end: ?OM ERROR', last(b) === '?OM ERROR', last(b));
}

// ---- SOUND ----
// The sound as a whole: the measures split a tone where two periods in a row differ, which a field interrupt can do
// to the first periods of a tone by where in the field it starts (an odd period counted into the median); so tones
// that follow each other with no gap are one sound here, its period the shortest clean one in it. -> for each t,
// [period ok and length ok, detail, full scale] (the expected period and length from this build's equates)
function soundRuns(b) {
  return [1, 50, 100, 200, 254, 255].map((t) => {
    const m = wav(b, `SOUND ${t},3`), P = SNDP0 + SNDPK * (256 - t), c = 3 * SNDU, ts = m.tones;
    const joined = ts.length > 0 && ts.every((x, i) => i === 0 || x.start - (ts[i - 1].start + ts[i - 1].length) < 2 * P);
    const len = ts.length ? ts[ts.length - 1].start + ts[ts.length - 1].length - ts[0].start : 0;
    const per = Math.min(...cleanPeriods(m).filter((x) => Number.isFinite(x)));
    const full = ts.length > 0 && Math.min(...ts.map((x) => x.low)) === SNDL && Math.max(...ts.map((x) => x.high)) === SNDH;
    return { t, P, c, ok: joined && per === P && len > (c - 1) * FIELD - P && len < c * FIELD + 2 * P,
      detail: `${per} ${(len / FIELD).toFixed(2)} (${ts.length} tone${ts.length === 1 ? '' : 's'})`, full };
  });
}
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
  check('JOYSTK(0) after SOUND is not heard (sound off after SOUND), 6 DAC steps an axis, sound still off after', m.heard === 0 && m.writes === 24 && !m.end.enabled && m.end.mux === 0, `${m.writes} writes, ${m.heard} heard`);
  for (const line of ['PRINT JOYSTK(4)', 'PRINT JOYSTK(-1)']) { typeAll(b, [line]); check(`${line}: ?FC ERROR`, last(b) === '?FC ERROR', last(b)); }
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

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
