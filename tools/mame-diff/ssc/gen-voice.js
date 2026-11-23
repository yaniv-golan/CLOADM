// The Speech/Sound Pak's SP0256 SOUND case: our own speech image (sp0256-asm.js) whose output the audio comparison
// (speech-audio.js) records on both emulators. Never a real SP0256-AL2 (copyrighted; AGENTS.md hard rule 1): the
// image is installed in MAME under the AL2's file name, sp0256-al2.bin, and is always this one.
//
// THE IMAGE plays one allophone per test, 1 to N, as the PIC loads them (gen-speak.js's PIC program, with holds):
//   - every load instruction that sets filter coefficients, in all four modes (the six stages' B and F through the
//     coefficient table, both signs; stage 5 where the mode has it), voiced at several pitches and amplitude
//     exponents;
//   - interpolation (amplitude and pitch ramps), SETMSB and delta updates of a playing sound, unvoiced (noise)
//     sounds, PAUSE;
//   - the chip halting: after a voiced allophone (the filter rings down to 0) and after an unvoiced one (MAME's chip
//     keeps its last amplitude and coefficients while halted, so the noise goes on until the next load); the PIC
//     holds before those loads (gen-speak.js `holds`).
// Field values come from a fixed pseudo-random sequence, and a set is kept only if the image's output stays inside
// what the recording can hold: MAME writes (speech x 1.75 + the AY's idle level) clamped to +-1, so speech above
// 12,798 or below -24,654 of 32,768 is clipped there and would compare nothing. The search runs this project's own
// chip (js/chips/sp0256.js) to choose the INPUTS; the expected OUTPUT is MAME's recording, never this code's.
const { assemble } = require('./sp0256-asm.js');
const { FIELDS, OP, SP0256 } = require('../../../js/chips/sp0256.js');
const { picSource, assembleOrThrow } = require('./gen-speak.js');
const { romImage } = require('../lib/firmware.js');

const HIGH = 11000, LOW = -20000;   // the output range kept, with margin inside the recording's
const MIN_PEAK = 1500;              // ... and a test must make a sound

// a fixed pseudo-random sequence (no Math.random: the image is the same every run)
function prng(seed) {
  let x = seed >>> 0;
  return (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % n; };
}

// field values for a load: amplitude (register 0) from `amp` (a 6-bit field's value, or 8 bits as AM itself),
// pitch (register 1) from `pitch`, interpolation from `interp`. Each B coefficient is pseudo-random over its width;
// each F is drawn as a code of magnitude under 32, of either sign (a field's top bits, `shift` below), since a
// stage y = x + F/256 y1 + B/512 y2 is stable only while |F/256| < 1 - B/512, and six random stages almost never are.
// Deltas are small, of either sign.
function fieldValues(op, mode, rnd, { amp, pitch, interp = null }) {
  return FIELDS[op][mode].filter((x) => x.length === 4).map(([reg, bits, shift, kind]) => {
    const mask = (1 << bits) - 1;
    if (reg === 0) return bits === 8 ? amp << 2 : amp & mask;
    if (reg === 1) return pitch & mask;
    if (reg === 14 || reg === 15) return interp ? interp[reg - 14] & mask : 0;
    if (kind === 'delta') return (rnd(2) ? rnd(3) : -1 - rnd(2)) & mask;
    if (reg & 1) {                                        // F0-F5: registers 3, 5, ... 13
      const code = rnd(2) ? rnd(32) : 0x100 - 1 - rnd(31);
      return (code >> shift) & mask;
    }
    return rnd(1 << bits);
  });
}

// The tests, before value selection: each a function of a pseudo-random source returning the allophone's body.
const PLAN = [];
const loadOps = ['LOADALL', 'LOAD_C', 'LOAD_2', 'LOAD_4'];
loadOps.forEach((name, i) => {
  for (let mode = 0; mode < 4; mode++) {
    PLAN.push({ name: `${name} mode ${mode}, voiced`, body: (rnd) => [{ op: 'SETMODE', mode },
      { op: name, repeat: 3 + ((i + mode) % 4), fields: fieldValues(OP[name], mode, rnd,
        { amp: 8 + rnd(16), pitch: 40 + rnd(80), interp: name === 'LOAD_2' || (name === 'LOADALL' && mode & 1) ? [rnd(4), rnd(4)] : null }) },
      { op: 'RTS' }] });
  }
});
PLAN.push({ name: 'unvoiced (pitch 0)', body: (rnd) => [{ op: 'SETMODE', mode: 0 },
  { op: 'LOAD_C', repeat: 4, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 6 + rnd(10), pitch: 0 }) }, { op: 'RTS' }] });
PLAN.push({ name: 'SETMSB_6 and SETMSB_A on a playing sound', body: (rnd) => [{ op: 'SETMODE', mode: 1 },
  { op: 'LOAD_4', repeat: 2, fields: fieldValues(OP.LOAD_4, 1, rnd, { amp: 10 + rnd(10), pitch: 60 + rnd(40) }) },
  { op: 'SETMSB_6', repeat: 2, fields: fieldValues(OP.SETMSB_6, 1, rnd, { amp: 10 + rnd(10) }) },
  { op: 'SETMODE', mode: 0 },
  { op: 'SETMSB_A', repeat: 2, fields: fieldValues(OP.SETMSB_A, 0, rnd, { amp: 10 + rnd(10) }) }, { op: 'RTS' }] });
PLAN.push({ name: 'SETMSB_3 (interpolating) and SETMSB_5', body: (rnd) => [{ op: 'SETMODE', mode: 2 },
  { op: 'LOAD_C', repeat: 2, fields: fieldValues(OP.LOAD_C, 2, rnd, { amp: 10 + rnd(10), pitch: 50 + rnd(50) }) },
  { op: 'SETMSB_3', repeat: 3, fields: fieldValues(OP.SETMSB_3, 2, rnd, { amp: 10 + rnd(10), pitch: 50 + rnd(50), interp: [1 + rnd(3), rnd(3)] }) },
  { op: 'SETMODE', mode: 3 },
  { op: 'SETMSB_5', repeat: 2, fields: fieldValues(OP.SETMSB_5, 3, rnd, { amp: 10 + rnd(10), pitch: 50 + rnd(50) }) }, { op: 'RTS' }] });
PLAN.push({ name: 'DELTA_9 and DELTA_D on a playing sound', body: (rnd) => [{ op: 'SETMODE', mode: 0 },
  { op: 'LOAD_C', repeat: 2, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 12 + rnd(8), pitch: 60 + rnd(40) }) },
  { op: 'DELTA_9', repeat: 2, fields: fieldValues(OP.DELTA_9, 0, rnd, { amp: rnd(4), pitch: rnd(8) }) },
  { op: 'SETMODE', mode: 3 },
  { op: 'DELTA_D', repeat: 2, fields: fieldValues(OP.DELTA_D, 3, rnd, { amp: rnd(4), pitch: rnd(8) }) }, { op: 'RTS' }] });
PLAN.push({ name: 'PAUSE between two sounds', body: (rnd) => [{ op: 'SETMODE', mode: 0 },
  { op: 'LOAD_C', repeat: 2, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 12 + rnd(8), pitch: 60 + rnd(40) }) },
  { op: 'PAUSE', repeat: 2 },
  { op: 'LOAD_C', repeat: 2, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 12 + rnd(8), pitch: 60 + rnd(40) }) }, { op: 'RTS' }] });
PLAN.push({ name: 'voiced, then the chip halts and the filter rings down', hold: 100, body: (rnd) => [{ op: 'SETMODE', mode: 1 },
  { op: 'LOAD_C', repeat: 3, fields: fieldValues(OP.LOAD_C, 1, rnd, { amp: 12 + rnd(8), pitch: 70 + rnd(40) }) }, { op: 'RTS' }] });
PLAN.push({ name: 'unvoiced, then the chip halts and the noise goes on', hold: 100, body: (rnd) => [{ op: 'SETMODE', mode: 0 },
  { op: 'LOAD_C', repeat: 2, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 6 + rnd(8), pitch: 0 }) }, { op: 'RTS' }] });
PLAN.push({ name: 'a last voiced sound: the end rings down to 0', body: (rnd) => [{ op: 'SETMODE', mode: 0 },
  { op: 'LOAD_C', repeat: 3, fields: fieldValues(OP.LOAD_C, 0, rnd, { amp: 12 + rnd(8), pitch: 70 + rnd(40) }) }, { op: 'RTS' }] });

function program(bodies) {
  const prog = [];
  bodies.forEach((b, i) => prog.push({ entry: i + 1, to: `t${i + 1}` }));
  bodies.forEach((b, i) => prog.push({ align: true }, { label: `t${i + 1}` }, ...b));
  return prog;
}

// The bare chip playing allophones 1..n as LRQ asks for them, `idle` samples of halt where a test holds: the
// output's range (to choose the inputs; the Pak's own timing is not modelled here).
function playRange(bodies, holds) {
  const chip = new SP0256({ rom: assemble(program(bodies)).image });
  const n = bodies.length, SAMPLES_PER_UNIT = 19;          // a hold unit: 256 x 7 PIC cycles, about 19 samples
  let next = 1, lo = 0, hi = 0, wait = 0, tail = -1;
  for (let k = 0; k < 400000; k++) {
    if (chip.lrq && next <= n) {
      if (holds[next] && wait < holds[next] * SAMPLES_PER_UNIT) wait++;
      else { chip.loadAddress(next++); wait = 0; }
    }
    const v = chip.sample();
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    // after the last test: the hold that follows it (the chip halted), then stop
    if (next > n && chip.sby && tail < 0) tail = (holds[n + 1] || 0) * SAMPLES_PER_UNIT;
    if (tail >= 0 && tail-- === 0) break;
  }
  return { lo, hi };
}

// choose each test's values in turn: the first seed whose test keeps the whole image in range and sounds
let built = null;
function build() {
  if (built) return built;
  const bodies = [], holds = {};
  PLAN.forEach((t, i) => {
    if (t.hold) holds[i + 2] = t.hold;   // the PIC waits before loading the NEXT test, so the chip halts after this one
    for (let seed = 1; ; seed++) {
      if (seed > 2000) throw new Error(`gen-voice: no values keep "${t.name}" in range`);
      const body = t.body(prng(seed * 7919 + i));
      const solo = playRange([body], {});
      const all = playRange([...bodies, body], holds);
      if (Math.max(solo.hi, -solo.lo) >= MIN_PEAK && all.hi <= HIGH && all.lo >= LOW) { bodies.push(body); break; }
    }
  });
  built = { bodies, holds, image: assemble(program(bodies)).image };
  return built;
}

const voiceImage = () => build().image;
const voicePic = () => romImage(assembleOrThrow(picSource(PLAN.length, build().holds), '7000', 'gen-voice PIC'), 0xF000, 0x1000, 0xFF);
const tests = () => PLAN.map((t) => t.name);

module.exports = { voiceImage, voicePic, tests, build, PLAN, playRange, prng };
