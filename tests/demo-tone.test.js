// The "2 COLOUR AND SOUND" welcome demo (examples/demo.bin, built by tools/build-demo.js): one short clean tone when the
// colour bars are about to start, then silence, and the same picture as before.
//
// It used to write one DAC value per frame (a staircase that stepped every field and jumped from full scale to zero about
// once a second: a buzz and a pop). Now: a square wave on the DAC around the centre $80, then no DAC write at all.
//
// The demo runs headless on the SAM models (Dragon 64, CoCo 1/2) and the CoCo 3, started the way the page starts it (the
// welcome program first, then the demo, then a key), with every write to $FF20 recorded with the tick it takes effect at.
// Expected values come from the specification of the change, not from the program: a tone of 0.3-0.5 s at 440-880 Hz,
// a square wave $80 +/- amp with moderate amplitude (not full scale; the 6-bit DAC's full scale is $00-$FC), the first
// and last value the centre $80, no step larger than 2 x amp, and nothing at all on the DAC afterwards (200+ frames).
// The picture is checked against the bars' definition (the byte of 8-byte group g on row r is
// table[(2 g + r/8 + frame) mod 4], the colour set flipping every 64 frames), not against a recording.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const ROOT = path.join(__dirname, '..');
// (a different binary can be tried with DEMO_BIN=path, to show the checks red on the old demo)
const demo = new Uint8Array(fs.readFileSync(process.env.DEMO_BIN || path.join(ROOT, 'examples/demo.bin')));
const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));

// the committed binary is the generator's build (the documented command, node tools/build-demo.js)
if (!process.env.DEMO_BIN) check('examples/demo.bin is what tools/build-demo.js builds', Buffer.from(demo).equals(require('../tools/build-demo.js').build().bytes));

const FRAME_ADDR = 0x7000, ROW_ADDR = 0x7001;   // the demo's frame counter and row counter (tools/build-demo.js)
const CENTRE = 0x80, FULL_SCALE_LOW = 0x00, FULL_SCALE_HIGH = 0xFC;

// Run the demo as the page does and return what the DAC saw and what the screen held.
function runDemo(id, bin) {
  const s = new Emu.Session();
  s.switchMachine(id, undefined, { menu: false });
  s.startWelcome(welcome);
  const m = s.machine;
  for (let i = 0; i < 50; i++) m.runFrame();                         // the welcome menu, as before key 2
  s.load('demo.bin', bin, { remember: false });                       // key 2: the demo starts and prints its text
  const writes = [];                                                  // every CPU write to $FF20: { t (ticks), v }
  const write = m.write.bind(m);
  m.write = (a, v) => { if (a === 0xFF20) writes.push({ t: m.ioTime(), v: v & 0xFF }); return write(a, v); };
  for (let i = 0; i < 10; i++) m.runFrame();
  const levels = new Set();                                           // what reaches the speaker: the analogue level steps
  const shots = [];                                                   // per frame of the bars: counters and screen memory
  m.stubKeys.push(0x20);                                              // "PRESS ANY KEY..."
  let graphics = false;
  for (let f = 0; f < 440; f++) {
    m.runFrame();
    for (let k = 2; k < m.audioEvents.length; k += 2) levels.add(m.audioEvents[k + 1]);
    graphics = graphics || !!(m.pia1.b.outValue() & 0x80);
    if (graphics && shots.length < 420) {
      const mem = new Uint8Array(6144);
      for (let i = 0; i < 6144; i++) mem[i] = m.peek(0x0E00 + i);
      shots.push({ k: m.peek(FRAME_ADDR), row: m.peek(ROW_ADDR), css: (m.pia1.b.outValue() >> 3) & 1, mem });
    }
  }
  return { m, writes, levels, shots, tickHz: m.tickHz, fps: m.fps };
}

for (const id of ['dragon64', 'coco', 'coco3']) {
  const r = runDemo(id, demo), w = r.writes, tag = id;
  check(`${tag}: the demo played its tone (writes to $FF20 were recorded)`, w.length >= 100, `${w.length} writes`);
  if (w.length < 100) continue;

  // the tone: the writes are the tone, from the first to the last
  const vals = w.map((x) => x.v);
  const amp = Math.max(...vals.map((v) => Math.abs(v - CENTRE)));
  check(`${tag}: the first and the last value are the centre $80`, vals[0] === CENTRE && vals[vals.length - 1] === CENTRE, `${vals[0].toString(16)} ... ${vals[vals.length - 1].toString(16)}`);
  check(`${tag}: every write is $80 or $80 +/- amp, with a moderate amplitude (>= $10, not full scale: <= $40)`,
    amp >= 0x10 && amp <= 0x40 && vals.every((v) => v === CENTRE || v === CENTRE + amp || v === CENTRE - amp), `amp $${amp.toString(16)}, values ${[...new Set(vals)].map((v) => v.toString(16)).join(' ')}`);
  check(`${tag}: it never reaches full scale ($00 or $FC)`, vals.every((v) => v !== FULL_SCALE_LOW && v !== FULL_SCALE_HIGH));
  let maxJump = 0;
  for (let i = 1; i < vals.length; i++) maxJump = Math.max(maxJump, Math.abs(vals[i] - vals[i - 1]));
  check(`${tag}: no step is larger than 2 x amp (no pop)`, maxJump <= 2 * amp, `largest step $${maxJump.toString(16)}, 2 x amp $${(2 * amp).toString(16)}`);
  // the square wave: the high writes' spacing is its period, the high and low halves are about equal
  const highs = w.filter((x) => x.v === CENTRE + amp), lows = w.filter((x) => x.v === CENTRE - amp);
  const periods = highs.slice(1).map((x, i) => x.t - highs[i].t);
  const period = periods.reduce((a, b) => a + b, 0) / periods.length;
  const freq = r.tickHz / period, seconds = (w[w.length - 1].t - w[0].t) / r.tickHz;
  check(`${tag}: the pitch is 440-880 Hz`, freq >= 440 && freq <= 880, `${freq.toFixed(1)} Hz`);
  check(`${tag}: it lasts 0.3-0.5 s`, seconds >= 0.3 && seconds <= 0.5, `${(seconds * 1000).toFixed(1)} ms`);
  check(`${tag}: the period is steady (every period within 1 % of the mean)`, periods.every((p) => Math.abs(p / period - 1) < 0.01), `${Math.min(...periods)}..${Math.max(...periods)} ticks`);
  const halves = highs.map((x, i) => (lows[i] ? lows[i].t - x.t : null)).filter((x) => x !== null);
  const duty = halves.reduce((a, b) => a + b, 0) / halves.length / period;
  check(`${tag}: it is a square wave with a duty cycle of 50 % +/- 2 %`, Math.abs(duty - 0.5) < 0.02, `${(duty * 100).toFixed(1)} %`);

  // afterwards: silence. Nothing more on the DAC for at least 200 frames after the last tone write
  const lastTick = w[w.length - 1].t;
  const framesAfter = Math.floor((r.m.cycle - lastTick) / (r.tickHz / r.fps));
  check(`${tag}: no further DAC write for at least 200 frames after the tone`, framesAfter >= 200, `${framesAfter} frames after the last write, ${w.length} writes in all`);
  check(`${tag}: the bars were running all that time (the frame counter advanced)`, r.shots.length > 0 && r.shots[r.shots.length - 1].k >= 40, `frame counter ${r.shots.length ? r.shots[r.shots.length - 1].k : 'none'}`);

  // it is audible after the welcome program (the demo never sets the sound enable or the multiplexer): the speaker level
  // moves between the high and the low level of the tone, and rests at the centre
  const hiLevel = (CENTRE + amp) >> 2, loLevel = (CENTRE - amp) >> 2, mid = CENTRE >> 2;
  const near = (a, b) => Math.abs(a - b / 63) < 1e-9;
  check(`${tag}: the tone reaches the speaker after the welcome program (the high and the low level, and the centre)`,
    [...r.levels].some((l) => near(l, hiLevel)) && [...r.levels].some((l) => near(l, loLevel)) && [...r.levels].some((l) => near(l, mid)), [...r.levels].map((l) => (l * 63).toFixed(0)).join(' '));
  check(`${tag}: the DAC rests at $80 (the speaker level is the centre)`, near(r.m.soundLevel, mid), `${(r.m.soundLevel * 63).toFixed(2)} of 63`);

  // the picture: bars as defined. The screen memory ($0E00, 32 bytes a row: 4 groups of 8 bytes) is checked every frame: a
  // row the redraw has passed (row < ROW) holds the colours of this iteration (counter k), a row it has not reached the
  // ones of the one before (k - 1): the byte of group g on row r is table[(2 g + r/8 + f) mod 4]. The colour set (the
  // VDG's CSS bit, $FF22 bit 3) follows bit 6 of the counter.
  const TABLE = [0x00, 0x55, 0xAA, 0xFF];
  let bad = 0, firstBad = '', checked = 0; const ks = new Set(), css = new Set();
  for (const shot of r.shots) {
    const { k, row, mem } = shot;
    if (row >= 192) continue;                       // (the instant between the last row and the counter's increment)
    ks.add(k); css.add(shot.css);
    for (let y = 0; y < 192; y++) {
      const f = y < row ? k : k - 1;
      if (y === row || f < 1) continue;                // (the row being drawn; and the picture before the first redraw)
      for (let g = 0; g < 4; g++) for (let b = 0; b < 8; b++) {
        const want = TABLE[(2 * g + (y >> 3) + f) & 3], got = mem[y * 32 + g * 8 + b];
        checked++;
        if (got !== want && bad < 5) { bad++; if (!firstBad) firstBad = `k=${k} row ${y} (redraw at ${row}) group ${g} byte ${b}: $${got.toString(16)}, wanted $${want.toString(16)}`; }
      }
    }
    if (bad === 0 && shot.css !== ((k >> 6) & 1) && shot.css !== (((k - 1) >> 6) & 1)) { bad++; firstBad = `k=${k}: CSS bit ${shot.css}`; }
  }
  check(`${tag}: the screen memory holds the bars as defined, frame after frame (${checked} bytes)`, bad === 0 && checked > 1000000, firstBad);
  check(`${tag}: they scroll (the frame counter takes many values, one step per redraw)`, ks.size >= 30, `${ks.size} values, ${Math.min(...ks)}..${Math.max(...ks)}`);
  check(`${tag}: the colour set flips when the counter crosses 64 (counter reaches ${Math.max(...ks)})`, Math.max(...ks) >= 66 && css.has(0) && css.has(1), [...css].join());
  const fr = r.m.render(), seen = new Set(Array.from(fr.data, (i) => fr.table[i]));
  check(`${tag}: the screen shows at least four colours (the bars)`, seen.size >= 4, `${seen.size}`);
}

console.log(fail ? `${fail} FAILED` : 'all demo tone checks passed');
process.exitCode = fail ? 1 : 0;
