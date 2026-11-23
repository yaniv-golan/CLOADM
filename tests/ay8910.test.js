// AY-3-8910 / 8912 sound generator (js/chips/ay8910.js). Expected values come from the General Instrument
// AY-3-8910/8912 Programmable Sound Generator Data Manual (1979), section 3 ("Architecture", registers 0 to 17, numbered in octal as the manual does):
//   tone frequency    fT = fCLOCK / (16 TP), TP the 12-bit period (R1 bits 0-3, R0)            (3.2, eq. 1)
//   noise frequency   fN = fCLOCK / (16 NP), NP 5 bits                                         (3.3, eq. 2)
//   envelope          one cycle of 16 steps takes 256 EP clocks (fE = fCLOCK / (256 EP))       (3.6, eq. 4)
//   mixer             R7 bits 0-2 tone off, 3-5 noise off (active low enables); bit 6 port A output (3.4, 3.7)
//   amplitude         regs 010-012 bits 0-3 level, bit 4 M: the envelope instead (3.5)
//   envelope shapes   reg 015 bits CONT, ATT, ALT, HOLD; the 10 distinct waveforms of figure 7      (3.6)
// The chip runs as MAME's stream does, one step per 8 clocks; the noise register and output levels follow
// MAME 0.264 (ay8910.cpp), which the Dragon Alpha comparison checks against MAME's own recording
// (tools/mame-diff/alpha/sound-compare.js).
const Emu = require('./load')();
const { AY8910, AY_VOLUME } = require('../js/chips/ay8910.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
void Emu;

const CLOCK = 1e6, STEP = 8;   // samples per second = CLOCK / STEP
const reg = (ay, r, v) => { ay.addressW(r); ay.dataW(v); };
const read = (ay, r) => { ay.addressW(r); return ay.dataR(); };
const out = new Float32Array(3);

// ---- registers
{
  const writes = [];
  const ay = new AY8910({ portAWrite: (v) => writes.push(v), portARead: () => 0x5A });
  check('reset puts $FF on port A (register 7 written for the first time, port A an input)', writes.join() === '255');
  for (let r = 0; r < 16; r++) reg(ay, r, (r * 37 + 11) & 0xff);
  const back = [];
  for (let r = 0; r < 16; r++) back.push(read(ay, r));
  check('registers 0-13 and 15 read back the byte written (the AY-3-8912 as MAME has it)', back.every((v, r) => r === 14 || v === ((r * 37 + 11) & 0xff)), back.join(','));
  check('register 14 reads the port A input', back[14] === 0x5A);
  ay.addressW(0x13);
  check('an address with a non-zero upper nibble deselects the chip: reads $FF', ay.dataR() === 0xff);
  ay.dataW(0x00);
  check('... and data writes are ignored', read(ay, 3) === ((3 * 37 + 11) & 0xff));
  writes.length = 0;
  reg(ay, 7, 0x3F); reg(ay, 14, 0x21);
  check('register 14 written while port A is an input: nothing on the port', writes.length === 0);
  reg(ay, 7, 0x7F);
  check('register 7 bit 6 set: port A drives register 14', writes.join() === '33');
  reg(ay, 14, 0x02);
  check('register 14 written while port A is an output: on the port', writes.join() === '33,2');
  reg(ay, 7, 0x3F);
  check('port A back to input: the port sees $FF', writes.join() === '33,2,255');
}

// ---- tone: fT = fCLOCK / (16 TP)
function toneFreq(tp) {
  const ay = new AY8910();
  reg(ay, 0, tp & 0xff); reg(ay, 1, tp >> 8); reg(ay, 7, 0x3E); reg(ay, 8, 15);
  let prev = null, edges = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) { const v = ay.step(out)[0]; if (prev !== null && v > prev) edges++; prev = v; }
  return edges / (n / (CLOCK / STEP));
}
for (const tp of [1, 100, 0x100, 0xFFF]) {
  const want = CLOCK / (16 * tp), got = toneFreq(tp);
  check(`tone period ${tp}: ${want.toFixed(2)} Hz`, Math.abs(got - want) <= want * 0.002 + 1 / 1.6, got.toFixed(2));
}
check('tone period 0 plays as period 1 (MAME: max(1, period))', Math.abs(toneFreq(0) - CLOCK / 16) < 50);
check('the coarse period has 4 bits: $1F00 plays as $F00', Math.abs(toneFreq(0x1F00) - CLOCK / (16 * 0xF00)) < 0.1);

// ---- mixer: a channel with tone and noise both off outputs its level (sampled sound)
{
  const ay = new AY8910();
  reg(ay, 7, 0x3F); reg(ay, 8, 9);
  const v = new Set();
  for (let i = 0; i < 1000; i++) v.add(ay.step(out)[0]);
  check('tone and noise off: a steady level, the volume\'s', v.size === 1 && v.has(AY_VOLUME[9]));
  reg(ay, 8, 0);
  check('volume 0 is the lowest level', ay.step(out)[0] === AY_VOLUME[0]);
}
check('levels rise with the volume, from -0.125 to 0.375 (MAME\'s normalised table)', AY_VOLUME.every((v, i) => i === 0 || v > AY_VOLUME[i - 1])
  && Math.abs(AY_VOLUME[0] + 0.125) < 1e-6 && Math.abs(AY_VOLUME[15] - 0.375) < 1e-6);

// ---- noise: fN = fCLOCK / (16 NP), a 17-bit shift register (period 2^17 - 1 shifts)
{
  const ay = new AY8910();
  reg(ay, 6, 1); reg(ay, 7, 0x37); reg(ay, 8, 15);
  // the shift register moves once every 2 NP steps; its sequence repeats after 2^17 - 1 moves
  const seen = [ay.rng];
  for (let i = 0; i < 4; i++) { ay.step(out); seen.push(ay.rng); }
  check('NP = 1: the register shifts every second step (fN = fCLOCK / 16)', seen[1] === seen[0] && seen[2] !== seen[1] && seen[3] === seen[2] && seen[4] !== seen[3], seen.join(','));
  const start = ay.rng;
  let moves = 0, prev = ay.rng;
  for (let i = 0; i < 2 * 131072 + 4; i++) { ay.step(out); if (ay.rng !== prev) { moves++; prev = ay.rng; if (ay.rng === start) break; } }
  check('the noise register repeats after 131071 shifts (17 bits, maximal length)', moves === 131071, String(moves));
}

// ---- envelope: 16 steps per ramp, a ramp every 256 EP clocks; the shapes of figure 7
const ENV_SHAPES = {   // per ramp: d down, u up, l stays low, h stays high
  0x0: 'dlll', 0x1: 'dlll', 0x2: 'dlll', 0x3: 'dlll', 0x4: 'ulll', 0x5: 'ulll', 0x6: 'ulll', 0x7: 'ulll',
  0x8: 'dddd', 0x9: 'dlll', 0xA: 'dudu', 0xB: 'dhhh', 0xC: 'uuuu', 0xD: 'uhhh', 0xE: 'udud', 0xF: 'ulll',
};
function envelope(shape, ep) {
  const ay = new AY8910();
  reg(ay, 11, ep & 0xff); reg(ay, 12, ep >> 8); reg(ay, 7, 0x3F); reg(ay, 8, 0x10); reg(ay, 13, shape);
  const vols = [];
  const perStep = 16 * ep / STEP;          // 16 EP clocks per step
  for (let i = 0; i < 64 * perStep; i++) { if (i % perStep === 0) vols.push(ay.envs[0].volume); ay.step(out); }
  return vols;
}
for (const [shape, want] of Object.entries(ENV_SHAPES)) {
  const v = envelope(+shape, 1), ramps = [0, 1, 2, 3].map((k) => v.slice(k * 16, k * 16 + 16));
  // a ramp: 16 steps from 15 down to 0 or 0 up to 15; or held low (0) or high (15)
  const kind = (r) => (r.every((x, i) => x === 15 - i) ? 'd' : r.every((x, i) => x === i) ? 'u' : r.every((x) => x === 0) ? 'l' : r.every((x) => x === 15) ? 'h' : '?');
  const got = ramps.map(kind).join('');
  check(`envelope shape ${(+shape).toString(16).toUpperCase()}: ${want}`, got === want, `${got} (${v.slice(0, 20).join(' ')})`);
}
{
  const v = envelope(0x0C, 3);
  check('envelope period 3: one 16-step ramp in 256 x 3 clocks (sawtooth repeats every 16 steps)', v[0] === v[16] && v[1] === v[17] && v[15] !== v[0]);
}

// ---- snapshots: a playing chip saved and restored continues identically
{
  const a = new AY8910();
  reg(a, 0, 77); reg(a, 2, 33); reg(a, 6, 5); reg(a, 7, 0x30); reg(a, 8, 0x10); reg(a, 9, 12); reg(a, 11, 3); reg(a, 13, 0x0E);
  for (let i = 0; i < 5000; i++) a.step(out);
  const b = new AY8910();
  b.loadState(JSON.parse(JSON.stringify(a.saveState())));
  let same = true;
  for (let i = 0; i < 20000; i++) { const x = Array.from(a.step(out)), y = Array.from(b.step(new Float32Array(3))); if (x.join() !== y.join()) { same = false; break; } }
  check('saveState / loadState (through JSON) continue sample for sample', same);
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
