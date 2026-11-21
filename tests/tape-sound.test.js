// Tape sound (js/host/tape-sound.js and its mix in js/host/audio.js): the page's "Tape sound", the tape heard as a
// recorder's speaker plays it, on the host side.
//   - TapeListener gives exactly the tape's signal over each frame (checked tick by tick against a second copy of
//     the tape stepped one tick at a time), and nothing when the tape doesn't move (motor off, end of tape, another
//     tape, a rewind, a seek); a motor switched on mid-frame puts the signal at the frame's end; slice() reads ahead
//     without moving the tape
//   - TapeVoice: a playing tape is heard, a stopped one fades to silence with no click, and the edges are rounded off
//     (not the raw square); AudioOutput with tapeVolume 0 is the machine's output exactly
//   - none of it is machine state: a machine run with the tape heard saves the same snapshot as one without
//   - the machine's own routing (MAME-verified, tools/mame-diff/sam/cass-sound.js): the sound mux on the cassette
//     input with sound enabled sits at the bias, 32 DAC steps, and carries no tape signal
const Emu = require('./load')();
const { TapeListener, TapeVoice, boxAverage } = require('../js/host/tape-sound.js');
const { AudioOutput } = require('../js/host/audio.js');
const { assemble } = require('../js/asm/assembler.js');
// a Dragon 64 that sits in a loop (our firmware, in place of BASIC: BRA * at the reset vector), so nothing but the
// test touches its PIAs
function idleDragon() {
  const m = Emu.createMachine('dragon64'), img = new Uint8Array(0x4000).fill(0x12);
  for (const sg of assemble('        ORG $8000\nL       BRA L\n        ORG $BFFE\n        FDB $8000\n', '6809').segments) img.set(sg.data, sg.addr - 0x8000);
  const slots = {};
  for (const sl of m.profile.roms) slots[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  m.setRoms(slots); m.reset(true);
  return m;
}

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const TICK_HZ = 894886, FRAME = 14916, RATE = 48000;
// a tape we build: a leader, then bytes with every bit pattern
const bytes = new Uint8Array([...Array(64).fill(0x55), 0x3C, ...Array.from({ length: 200 }, (_, i) => i)]);
// (unpadded: the signal starts at once, with no silence in front of the leader)
const OPTS = { zeroHz: 1200, oneHz: 2400, pad: false };
const tapeOf = () => new Emu.Tape(bytes, TICK_HZ, 't.cas', OPTS);
// a deck on a clock we move by hand
function rig() {
  const clock = { t: 0 };
  const deck = new Emu.CassetteDeck(() => clock.t);
  deck.insert(tapeOf());
  return { clock, deck, frame: () => { clock.t += FRAME; deck.sync(); } };
}
// the level the events give at cycle c (the last event at or before it)
const levelAt = (ev, c) => { let l = null; for (let i = 0; i < ev.length && ev[i] <= c; i += 2) l = ev[i + 1]; return l; };

// ---- TapeListener: the signal, tick by tick
{
  const { deck, frame } = rig(), ref = tapeOf(), L = new TapeListener();
  deck.setMotor(true);
  L.mark(deck);
  let bad = 0, checked = 0;
  for (let f = 0; f < 6; f++) {
    frame();
    const ev = L.frame(deck, FRAME);
    if (!ev) { bad++; continue; }
    for (let c = 0; c < FRAME; c += 7) {
      // the reference tape stepped to tick c of this frame
      const r = new Emu.Tape(bytes, TICK_HZ, 'r', OPTS);
      r.idx = ref.idx; r.left = ref.left; r.advance(c);
      if ((levelAt(ev, c) === 1) !== r.level()) bad++;
      checked++;
    }
    ref.advance(FRAME);
  }
  check('listener: the signal over each frame is the tape\'s, tick for tick', !bad && checked > 10000, `${checked} ticks checked, ${bad} wrong`);
}
{
  const { deck, frame } = rig(), L = new TapeListener();
  L.mark(deck);
  frame();
  const off = L.frame(deck, FRAME);
  deck.setMotor(true); frame(); L.frame(deck, FRAME);
  deck.tape.seekByte(0); frame();
  const rewound = L.frame(deck, FRAME);
  frame(); L.frame(deck, FRAME);
  deck.tape.seekByte(200); frame();
  const sought = L.frame(deck, FRAME);
  deck.insert(tapeOf()); frame();
  const other = L.frame(deck, FRAME);
  deck.tape.seekByte(bytes.length); frame();
  L.frame(deck, FRAME); frame();
  const atEnd = L.frame(deck, FRAME);
  deck.eject(); frame();
  const none = L.frame(deck, FRAME);
  check('listener: nothing when the tape does not move: motor off, a rewind, a seek, another tape, the end, no tape',
    [off, rewound, sought, other, atEnd, none].every((x) => x === null), JSON.stringify([off, rewound, sought, other, atEnd, none].map((x) => x === null)));
}
{
  // the motor switched on part way through a frame: the tape moved over the frame's last part
  const { clock, deck } = rig(), L = new TapeListener();
  L.mark(deck);
  clock.t += 10000; deck.setMotor(true); clock.t += FRAME - 10000; deck.sync();
  const ev = L.frame(deck, FRAME);
  check('listener: a motor switched on mid-frame: the signal fills the frame\'s end', ev && ev[0] === 10000 && levelAt(ev, 9999) === null, ev && `first event at ${ev[0]}`);
  const ahead = L.slice(deck, FRAME);
  clock.t += FRAME; deck.sync();
  const next = L.frame(deck, FRAME);
  check('listener: slice() reads ahead without moving the tape, the same signal as the frame that follows',
    !!(ahead && next && ahead.length > 10 && JSON.stringify(ahead) === JSON.stringify(next)),
    `${ahead && ahead.length} / ${next && next.length} events`);
  check('listener: slice() leaves the tape where it was', (() => { const d = rig(); d.deck.setMotor(true); d.frame(); const t = d.deck.tape, i = t.idx, l = t.left; L.slice(d.deck, FRAME * 3); return t.idx === i && t.left === l; })());
}

// ---- TapeVoice
const frames = (fn, n) => { const out = []; for (let f = 0; f < n; f++) out.push(...fn(f)); return out; };
{
  const { deck, frame } = rig(), L = new TapeListener(), v = new TapeVoice(RATE), n = Math.round(RATE * FRAME / TICK_HZ);
  deck.setMotor(true); L.mark(deck);
  const play = frames(() => { frame(); const o = new Float64Array(n); v.mix(L.frame(deck, FRAME), FRAME, n, o, 1); return o; }, 30);
  const playingRms = v.rms;
  deck.setMotor(false);
  const stop = frames(() => { frame(); const o = new Float64Array(n); v.mix(L.frame(deck, FRAME), FRAME, n, o, 1); return o; }, 6);
  const tailRms = v.rms;
  let maxStepPlay = 0, maxStepStop = 0;
  for (let i = 1; i < play.length; i++) maxStepPlay = Math.max(maxStepPlay, Math.abs(play[i] - play[i - 1]));
  for (let i = 1; i < stop.length; i++) maxStepStop = Math.max(maxStepStop, Math.abs(stop[i] - stop[i - 1]));
  const junction = Math.abs(stop[0] - play[play.length - 1]);
  check('voice: a playing tape is heard', playingRms > 0.2, `RMS ${playingRms.toFixed(3)}`);
  check('voice: a stopped tape fades to silence within 6 frames', tailRms < 1e-3, `RMS ${tailRms.toExponential(2)}`);
  check('voice: no click as it stops (no step larger than while it played)', junction <= maxStepPlay && maxStepStop <= maxStepPlay, `stop step ${junction.toFixed(3)}, largest while playing ${maxStepPlay.toFixed(3)}`);
  // not the raw square: the box-filtered square jumps by up to 2 between samples; the voice's low-pass rounds it
  const raw = [];
  { const d = rig(); d.deck.setMotor(true); const l2 = new TapeListener(); l2.mark(d.deck); for (let f = 0; f < 10; f++) { d.frame(); raw.push(...boxAverage(l2.frame(d.deck, FRAME), FRAME, n, new Float64Array(n))); } }
  let rawStep = 0;
  for (let i = 1; i < raw.length; i++) rawStep = Math.max(rawStep, Math.abs(raw[i] - raw[i - 1]));
  check('voice: the edges are rounded off (largest step under a third of the raw square\'s)', maxStepPlay < rawStep / 3, `voice ${maxStepPlay.toFixed(3)}, raw ${rawStep.toFixed(3)}`);
}
{
  // AudioOutput: the voice at volume 0 changes nothing; at its volume it adds the tape; pushTape plays real time
  const square = () => { const e = [0, 0]; for (let c = 300; c < FRAME; c += 300) e.push(c, (c / 300) & 1); return e; };
  const run = (withVoice, vol, tapeOn) => {
    const chunks = [], out = new AudioOutput(RATE, { buffered: () => 0, write: (c) => chunks.push(...c) });
    if (withVoice) { out.tapeVoice = new TapeVoice(RATE); out.tapeVolume = vol; }
    const { deck, frame } = rig(), L = new TapeListener();
    deck.setMotor(true); L.mark(deck);
    for (let f = 0; f < 20; f++) { frame(); const ev = L.frame(deck, FRAME); out.push(square(), FRAME, TICK_HZ / FRAME, tapeOn && ev ? { events: ev, cycles: FRAME } : null); }
    return chunks;
  };
  const plain = run(false), silentVoice = run(true, 0, true), heard = run(true, 0.15, true);
  check('output: with the tape voice at volume 0, the machine\'s output exactly', plain.length === silentVoice.length && plain.every((x, i) => x === silentVoice[i]));
  let diff = 0;
  for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(heard[i] - plain[i]));
  check('output: at its volume the tape is mixed in, and no louder than the volume', diff > 0.02 && diff < 0.15 * 1.6, `largest difference ${diff.toFixed(3)}`);
  {
    // the tape stopping in the output stage: its voice carries on decaying (no cut), the machine silent here
    const got = [], o = new AudioOutput(RATE, { buffered: () => 0, write: (c) => got.push(...c) });
    o.tapeVoice = new TapeVoice(RATE);
    const { deck, frame } = rig(), L = new TapeListener();
    deck.setMotor(true); L.mark(deck);
    for (let f = 0; f < 20; f++) { frame(); const ev = L.frame(deck, FRAME); o.push([0, 0], FRAME, TICK_HZ / FRAME, ev ? { events: ev, cycles: FRAME } : null); }
    const playEnd = got.length;
    for (let f = 0; f < 6; f++) o.push([0, 0], FRAME, TICK_HZ / FRAME, null);
    let stepPlay = 0, stepStop = 0;
    for (let i = 1; i < playEnd; i++) stepPlay = Math.max(stepPlay, Math.abs(got[i] - got[i - 1]));
    for (let i = playEnd; i < got.length; i++) stepStop = Math.max(stepStop, Math.abs(got[i] - got[i - 1]));
    const tail = Math.max(...got.slice(-100).map(Math.abs));
    check('output: the tape stopping fades out in the output (no step larger than while it played), to silence', stepStop <= stepPlay && tail < 1e-3,
      `stop ${stepStop.toFixed(4)}, playing ${stepPlay.toFixed(4)}, tail ${tail.toExponential(2)}`);
  }
  const chunks = [], out = new AudioOutput(RATE, { buffered: () => 0, write: (c) => chunks.push(c.length) });
  out.tapeVoice = new TapeVoice(RATE);
  const { deck } = rig(); deck.setMotor(true);
  const L = new TapeListener();
  for (let k = 0; k < 10; k++) out.pushTape(16, { events: L.slice(deck, 0.016 * TICK_HZ), cycles: 0.016 * TICK_HZ });
  const total = chunks.reduce((a, b) => a + b, 0);
  check('output: pushTape plays the real time that went by (10 x 16 ms)', Math.abs(total - RATE * 0.16) <= 1, `${total} samples`);
}

// ---- the page's Sound switch is the master (js/host/audio.js Audio): off, nothing is sent, the tape included
{
  const { Audio } = require('../js/host/audio.js');
  const a = new Audio(), sent = [];
  a.out = { push: (...x) => sent.push(['frame', x[3]]), pushTape: (...x) => sent.push(['tape', x[1]]), discontinuity: () => {} };
  const tape = { events: [0, 1], cycles: FRAME };
  a.enabled = false;
  a.pushFrame([0, 0], FRAME, 60, tape); a.pushTape(16, tape);
  const whileOff = sent.length;
  a.enabled = true; a.tapeSound = false;
  a.pushFrame([0, 0], FRAME, 60, tape); a.pushTape(16, tape);
  const noTape = sent.slice();
  a.tapeSound = true;
  a.pushFrame([0, 0], FRAME, 60, tape); a.pushTape(16, tape);
  check('audio: Sound off sends nothing (the tape included); Tape sound off sends the frame without the tape; both on send both',
    whileOff === 0 && noTape.length === 1 && noTape[0][1] === null && sent.length === 3 && sent[1][1] === tape && sent[2][1] === tape, JSON.stringify(sent));
}
// ---- a settled voice with nothing to play is skipped: silence, its output untouched
{
  const v = new TapeVoice(RATE), n = 800, o = new Float64Array(n).fill(0.25);
  v.mix(null, FRAME, n, o, 1);
  check('voice: nothing to play and settled: the output untouched, silent', o.every((x) => x === 0.25) && v.rms === 0);
}

// ---- not machine state: the same snapshot with or without the tape heard
{
  const run = (listen) => {
    const m = idleDragon();
    m.deck.insert(new Emu.Tape(bytes, m.tickHz, 't.cas', Object.assign({}, m.profile.tape, { pad: false })));
    m.deck.setMotor(true);
    const L = new TapeListener(), v = new TapeVoice(RATE), n = Math.round(RATE / m.fps);
    L.mark(m.deck);
    let heard = 0;
    for (let f = 0; f < 40; f++) {
      m.runFrame();
      if (listen) { const ev = L.frame(m.deck, m.frameCycles); if (ev) heard++; v.mix(ev, m.frameCycles, n, new Float64Array(n), 1); L.slice(m.deck, m.frameCycles); }
    }
    return { state: JSON.stringify(m.saveState(), (k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x)), heard };
  };
  const a = run(false), b = run(true);
  check('not machine state: a machine whose tape is heard saves the same snapshot', a.state === b.state && b.heard > 30, `${b.heard} frames heard`);
}

// ---- the machine's own routing: the cassette selected with sound enabled is the bias, 32 DAC steps, and no tape
{
  const m = idleDragon();
  m.deck.insert(new Emu.Tape(bytes, m.tickHz, 't.cas', Object.assign({}, m.profile.tape, { pad: false })));
  const w = (a, v) => m.write(a, v);
  w(0xFF21, 0x00); w(0xFF20, 0xFC); w(0xFF21, 0x3C);   // DAC outputs; CA2 high: the motor on
  w(0xFF20, 0x00);                                     // DAC 0
  w(0xFF23, 0x3C);                                     // CB2 high: sound enabled
  w(0xFF03, 0x34);                                     // PIA0 CB2 low
  w(0xFF01, 0x3C);                                     // PIA0 CA2 high: the mux on the cassette input
  const levels = new Set();
  for (let f = 0; f < 5; f++) { m.runFrame(); for (let i = 1; i < m.audioEvents.length; i += 2) levels.add(m.audioEvents[i]); }
  check('machine: the cassette selected, sound on: the bias (32/63) and no tape signal, as MAME 0.264',
    levels.size === 1 && levels.has(32 / 63) && m.deck.tape.idx > 0, `levels ${[...levels].map((x) => (x * 63).toFixed(2)).join(',')} DAC steps; tape at entry ${m.deck.tape.idx}`);
  w(0xFF23, 0x34);   // sound disabled
  m.runFrame();
  check('machine: sound disabled: 0', m.audioEvents[m.audioEvents.length - 1] === 0);
}

console.log(fail ? `${fail} FAILED` : 'all tape sound checks passed');
process.exitCode = fail ? 1 : 0;
