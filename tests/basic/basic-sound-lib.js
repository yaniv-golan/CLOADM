// The shared part of tests/basic-sound*.test.js (the clean-room BASIC's sound and joysticks,
// docs/clean-room-basic-p2.md sections 6 and 7): a Dragon 64 booted with the image assembled from basic/ at test time
// (no other ROM), BASIC typed into it, the sound measured from a write tap on the PIAs (the harness's #wav), and what
// the document specifies, computed from its formulas and the ROM's equates (not from the 6809 code).
const { buildBasic } = require('../../tools/build-basic.js');
const { Basic } = require('./harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });

const { rom, symbols } = buildBasic();
const EQ = (k) => { if (!symbols.has(k)) throw new Error(`no equate ${k}`); return symbols.get(k); };
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

module.exports = { check, tally, rom, EQ, FIELD, PLAYW, GRID, VMID, PVDEF, SNDH, SNDL, SNDU, SNDP0, SNDPK, IRQC, boot, typeAll, last, wav,
  cleanPeriods, st, period, etPeriod, NOTES, soundRuns };
