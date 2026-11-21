// The audio output stage (js/host/audio.js AudioOutput and its SampleQueue, browser-free): no pop the machine didn't play.
// A pop is a large jump between two consecutive output samples. Where the machine's level is constant, the
// output may only move by the high-pass filter's own decay (at most 0.5% of its value a sample) or by the fade
// (1/(FADE_MS of samples) of the held value a sample), so the bound used is BOUND = 0.01 (1% of full scale) for
// every sample-to-sample step around: sound unlock, a reset or machine switch that changes the level, the ring
// running dry (pause, turbo, sound off) and samples coming back. Each case is also run without the protection
// (the old stage: no re-seed, 0 on underrun) to show the case does pop there. While samples flow, the output
// is exactly the high-pass of the machine's levels, as before.
const { AudioOutput, FADE_MS } = require('../js/host/audio.js');
// the stage as the page plays it: AudioOutput writing into a SampleQueue (its default sink), which the audio
// thread pulls (js/host/audio-worklet.js)
class Stage extends AudioOutput { pull(b) { this.sink.pull(b); } }

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const BOUND = 0.01;
const FPS = 60, CYCLES = 14914;

// one frame of events at a constant level, or a square wave of `period` cycles
const flat = (level) => [0, level];
const square = (period, phase = 0) => {
  const ev = [0, phase & 1 ? 1 : 0];
  for (let c = period / 2, k = phase + 1; c < CYCLES; c += period / 2, k++) ev.push(Math.round(c), k & 1 ? 1 : 0);
  return ev;
};
// the old stage, as reference: high-pass from 0 with no re-seed, zeros on underrun
class OldOutput {
  // settleFirst: the reference for the new stage, whose first frame follows the level (no output change)
  constructor(rate, settleFirst = false) { this.rate = rate; this.q = []; this.prevIn = 0; this.prevOut = 0; this.volume = 0.5; this.settle = settleFirst; }
  discontinuity() {}
  push(events, frameCycles, fps) {
    const n = Math.round(this.rate / fps), step = frameCycles / n;
    let ei = 0, level = events.length ? events[1] : 0;
    for (let i = 0; i < n; i++) {
      const t = i * step;
      while (ei + 2 < events.length && events[ei + 2] <= t) { ei += 2; level = events[ei + 1]; }
      if (this.settle) this.prevIn = level;
      const y = level - this.prevIn + 0.995 * this.prevOut;
      this.prevIn = level; this.prevOut = y;
      this.q.push(Math.fround(y * this.volume));
    }
    this.settle = false;
  }
  pull(out) { for (let i = 0; i < out.length; i++) out[i] = this.q.length ? this.q.shift() : 0; }
}

// The reference for the stage's sound: each output sample is the machine's level averaged over the sample's own
// time window (a box filter, so a 1-bit signal faster than the sample rate does not alias), then DC-blocked.
// Computed here independently: for every sample, the overlap of every level segment with its window.
class BoxReference {
  constructor(rate) { this.rate = rate; this.q = []; this.prevIn = 0; this.prevOut = 0; this.volume = 0.5; this.settle = true; }
  discontinuity() {}
  push(events, frameCycles, fps) {
    const n = Math.round(this.rate / fps), step = frameCycles / n;
    const segs = [];
    for (let k = 0; k < events.length; k += 2) segs.push([events[k], k + 2 < events.length ? events[k + 2] : Infinity, events[k + 1]]);
    for (let i = 0; i < n; i++) {
      const t0 = i * step, t1 = t0 + step;
      let acc = 0;
      for (const [a, b, v] of segs) acc += v * Math.max(0, Math.min(b, t1) - Math.max(a, t0));
      const level = acc / step;
      if (this.settle) this.prevIn = level;
      const y = level - this.prevIn + 0.995 * this.prevOut;
      this.prevIn = level; this.prevOut = y;
      this.q.push(y * this.volume);
    }
    this.settle = false;
  }
  pull(out) { for (let i = 0; i < out.length; i++) out[i] = this.q.length ? this.q.shift() : 0; }
}

// run a script of steps against an output: ['push', events] | ['pull', samples] | ['cut'] (discontinuity);
// returns every sample pulled, starting with the 0 the device played before
function play(out, script) {
  const all = [0];
  for (const [op, arg] of script) {
    if (op === 'push') out.push(arg, CYCLES, FPS);
    else if (op === 'cut') out.discontinuity();
    else { const b = new Float32Array(arg); out.pull(b); all.push(...b); }
  }
  return all;
}
const maxJump = (s, from = 1, to = s.length) => { let m = 0; for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(s[i] - s[i - 1])); return m; };
// steady play: a frame pushed, a frame's worth pulled, `frames` times, with `ahead` frames buffered first
function steady(rate, framesEv, ahead = 2) {
  const n = Math.round(rate / FPS), s = [];
  for (let i = 0; i < ahead; i++) s.push(['push', framesEv(i)]);
  for (let i = ahead; i < ahead + 200; i++) { const ev = framesEv(i); if (!ev) break; s.push(['push', ev], ['pull', n]); }
  return s;
}

for (const rate of [44100, 48000]) {
  const n = Math.round(rate / FPS), fade = Math.round(rate * FADE_MS / 1000);

  // the sound: after the first frame (the filter settles, the output fades in), a tone is the high-pass of the
  // machine's levels averaged over each sample (BoxReference), to 1e-6 (the two sum in different orders)
  {
    const script = steady(rate, (i) => (i < 60 ? square(400 + 7 * i, i) : null));
    const a = play(new Stage(rate), script), b = play(new BoxReference(rate), script);
    let worst = a.length === b.length ? 0 : Infinity;
    for (let i = n + 1; i < a.length && worst < Infinity; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    const loud = Math.max(...a.slice(n + 1).map(Math.abs));
    check(`${rate} Hz: a tone is the high-pass of each sample's average level after the first frame`, worst < 1e-6 && a.length > 50 * n && loud > 0.4,
      `${a.length} samples, largest difference ${worst.toExponential(1)}, peak ${loud.toFixed(3)}`);
  }
  // a 1-bit pulse train above the sample rate (30 kHz, 25% duty: what the single-bit sound or a DAC routine does for
  // a soft level): point sampling folds it into an audible tone at full strength. Averaging over each
  // sample (a one-sample box filter, response sinc(f / rate): 0.39 at 30 kHz / 44.1 kHz, 0.29 at 48 kHz) cuts that
  // alias to a third or less; it is not a brick-wall filter, so required: at most half the point-sampled level
  {
    const period = CYCLES * FPS / 30000;
    const pulses = () => { const ev = [0, 1]; for (let c = 0; c < CYCLES; c += period) { if (c) ev.push(c, 1); if (c + period / 4 < CYCLES) ev.push(c + period / 4, 0); } return ev; };
    const a = play(new Stage(rate), steady(rate, (i) => (i < 30 ? pulses(i) : null)));
    const b = play(new OldOutput(rate, true), steady(rate, (i) => (i < 30 ? pulses(i) : null)));
    const tail = (x) => x.slice(10 * n, 25 * n), rms = (x) => Math.sqrt(tail(x).reduce((t, v) => t + v * v, 0) / tail(x).length);
    check(`${rate} Hz: a 30 kHz pulse train aliases at most half as loud as point sampling`, rms(a) < rms(b) / 2 && rms(b) > 0.1, `rms ${rms(a).toFixed(4)} (point sampling ${rms(b).toFixed(3)})`);
  }

  // sound unlocked while the DAC sits at a high level: the first frame doesn't step from 0 to it
  {
    const script = steady(rate, (i) => (i < 20 ? flat(0.8) : null));
    const a = maxJump(play(new Stage(rate), script)), b = maxJump(play(new OldOutput(rate), script));
    check(`${rate} Hz: unlock at a DC level makes no pop`, a < BOUND && b > 0.3, `max step ${a.toFixed(4)} (old ${b.toFixed(3)})`);
  }

  // reset / machine switch moving the level from 0 to 1 (the Session events call discontinuity())
  {
    const script = [...steady(rate, (i) => (i < 20 ? flat(0) : null)), ['cut'], ...steady(rate, (i) => (i < 20 ? flat(1) : null), 0)];
    const a = maxJump(play(new Stage(rate), script)), b = maxJump(play(new OldOutput(rate), script));
    check(`${rate} Hz: a level jump at a reset makes no pop`, a < BOUND && b > 0.3, `max step ${a.toFixed(4)} (old ${b.toFixed(3)})`);
  }

  // a reset's own settling: the level drops and comes back a few cycles into the first frame after it
  {
    const script = [...steady(rate, (i) => (i < 20 ? flat(0.98) : null)), ['cut'], ...steady(rate, (i) => (i === 0 ? [0, 0, 4, 0.51] : i < 20 ? flat(0.51) : null), 0)];
    const a = maxJump(play(new Stage(rate), script)), b = maxJump(play(new OldOutput(rate), script));
    check(`${rate} Hz: a reset settling in its first frame makes no pop`, a < BOUND && b > 0.2, `max step ${a.toFixed(4)} (old ${b.toFixed(3)})`);
  }

  // pause (or turbo, or sound off) just after a level change, when the output is far from 0, then resume
  {
    // frames 0-9 at 0, frame 10 steps to 1 just before its end; frames 0-8 are played, then the pulls go on
    const before = steady(rate, (i) => (i < 10 ? flat(0) : i === 10 ? [0, 0, CYCLES - 40, 1] : null));
    const pause = [['pull', 1024], ['pull', 1024], ['pull', 1024], ['pull', 1024]];
    const resume = steady(rate, (i) => (i < 10 ? flat(1) : null), 0);
    const script = [...before, ...pause, ...resume];
    const a = play(new Stage(rate), script), b = play(new OldOutput(rate), script);
    const k = 1 + 11 * n;     // the first sample after the ring ran dry
    check(`${rate} Hz: the output is high when the ring runs dry`, Math.abs(a[k - 1]) > 0.3, a[k - 1].toFixed(3));
    check(`${rate} Hz: running dry and resuming make no pop`, maxJump(a, k) < BOUND && maxJump(b, k) > 0.3,
      `max step ${maxJump(a, k).toFixed(4)} (old ${maxJump(b, k).toFixed(3)})`);
    check(`${rate} Hz: silent while paused`, a[1 + 9 * n + 4096 - 1] === 0);
  }

  // a tone cut by a pause and resumed: only the tone's own steps, faded
  {
    const tone = (i) => square(300, i);
    const script = [...steady(rate, (i) => (i < 10 ? tone(i) : null)), ['pull', 4096], ...steady(rate, (i) => (i < 10 ? tone(i) : null), 0)];
    const a = play(new Stage(rate), script);
    const toneStep = maxJump(play(new Stage(rate), steady(rate, (i) => (i < 30 ? tone(i) : null))), fade + 2);
    check(`${rate} Hz: pausing a tone never steps more than the tone itself`, maxJump(a, fade + 2) <= toneStep + 1e-6, `${maxJump(a, fade + 2).toFixed(3)} <= ${toneStep.toFixed(3)}`);
  }

  // a frame dropped to keep latency bounded (the page fell behind) while the level ramps: the next frame carries on
  // from where the dropped one ended, without a step (the level moved by 0.15 in the frame that was dropped)
  {
    // the level rises 0.15 a frame in 20 small steps (each 0.0075, an output step of 0.00375: below the bound)
    const ramp = (i) => Array.from({ length: 20 }, (_, k) => [Math.round(k * CYCLES / 20), 0.15 * i + 0.0075 * k]).flat();
    const script = [];
    for (let i = 0; i < 4; i++) script.push(['push', ramp(i)], ['pull', n]);
    for (let i = 4; i < 6; i++) script.push(['push', ramp(i)]);            // two frames ahead
    script.push(['fill']);                                                   // the ring nearly full: the next push is dropped
    // frame 6 is dropped; frame 7 arrives while samples are still buffered (no fade hides it), then all plays
    script.push(['push', ramp(6)], ['pull', 2 * n], ['push', ramp(7)], ['pull', 20000]);
    const run = (out) => {
      const all = [0];
      for (const [op, arg] of script) {
        if (op === 'push') out.push(arg, CYCLES, FPS);
        else if (op === 'fill') { while (out.buffered() <= rate * 0.15) out.push(flat(out.prevIn), CYCLES, FPS); }
        else { const b = new Float32Array(arg); out.pull(b); all.push(...b); }
      }
      return all;
    };
    const a = run(new Stage(rate)), k = 1 + 4 * n + 2 * n;   // from the pulls after the fill
    check(`${rate} Hz: a dropped frame leaves no step`, a.length > k + 10000 && maxJump(a, k) < BOUND, `max step ${maxJump(a, k).toFixed(4)}`);
  }

  // latency stays bounded when frames come faster than they are played
  {
    const out = new Stage(rate);
    for (let i = 0; i < 100; i++) out.push(flat(0.5), CYCLES, FPS);
    check(`${rate} Hz: at most 0.15 s and a frame buffered`, out.buffered() <= rate * 0.15 + n, `${out.buffered()} samples`);
  }
}


// Real time: the machine's frames arrive at its own rate (49.968 Hz for a PAL Dragon, 59.923 Hz for an NTSC CoCo)
// and the sound card takes 1024-sample blocks at its own. Rounding the samples per frame (883 for 882.571 at
// 44.1 kHz) used to add samples the card never asked for: the latency crept up to the 0.15 s cap, after which a
// whole frame was thrown away every ~40 s. The stage carries the fraction and, outside a band of
// 10 to 80 ms buffered, nudges the resample ratio by at most 0.5% (8.6 cents, inaudible as pitch).
// Simulated 15 minutes, with the card's clock 100 ppm off the machine's either way.
for (const [label, fps, cycles] of [['PAL Dragon', 49.96766756635178, 17784], ['NTSC CoCo', 59.92274340431231, 14934]]) {
  for (const rate of [44100, 48000]) {
    for (const skew of [1, 1.0001, 0.9999]) {
      const out = new Stage(rate);             // the stage resamples for `rate`; the card plays at rate * skew
      const block = new Float32Array(1024), seconds = 900;
      let pushed = 0, maxLate = 0, underruns = 0;
      const frameDt = 1 / fps, blockDt = 1024 / (rate * skew);
      let tf = 0, tb = 0;
      while (tf < seconds) {
        if (tf <= tb) { out.push([0, (pushed++ & 1) ? 0.4 : 0.6], cycles, fps); maxLate = Math.max(maxLate, out.buffered()); tf += frameDt; }
        else { if (out.buffered() < 1024 && tb > 5) underruns++; out.pull(block); tb += blockDt; }
      }
      const tag = `${label} at ${rate} Hz, card clock x${skew}`;
      check(`${tag}: no frame dropped in 15 minutes`, out.dropped === 0, `dropped ${out.dropped}`);
      check(`${tag}: the latency stays under 80 ms and a block`, maxLate / rate * 1000 < 80 + 1024 / rate * 1000 + 1000 / fps, `max ${(maxLate / rate * 1000).toFixed(1)} ms`);
      check(`${tag}: the card never runs dry once playing`, underruns === 0, `${underruns} short blocks`);
    }
  }
}
// the fraction is carried: at 44.1 kHz a 49.968 Hz machine gives 882 or 883 samples a frame, 882.571 on average
{
  const out = new Stage(44100), fps = 49.96766756635178;
  const sizes = new Set();
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const b = out.buffered(); out.push([0, 0], 17784, fps); const n = out.buffered() - b; sizes.add(n); total += n;
    const drain = new Float32Array(out.buffered() - 900 > 0 ? out.buffered() - 900 : 0); out.pull(drain);   // keep it inside the band
  }
  check('PAL at 44.1 kHz: 882 or 883 samples a frame, 882.57 on average', [...sizes].every((n) => n === 882 || n === 883) && Math.abs(total / 1000 - 44100 / fps) < 0.01,
    `${[...sizes].join(',')} avg ${(total / 1000).toFixed(3)}`);
}

// ---- recovery after a stall ----
// A page stall leaves the queue deep: the worklet keeps playing while the page cannot push, so when the page comes
// back there is more queued than TARGET_MS. The steering brings it back by resampling a frame by a little more or
// fewer samples, and what matters is the RATE: a fixed 0.5% moves the queue by 0.005 x rate samples a second, which
// is 5 ms of sound a second at every rate, so 60 ms of excess needs 12 s at the very least and in practice much
// longer, because the correction is proportional and so decays as it approaches the target.
//
// The test runs the stage the way the page does: the machine pushes a frame each 1/fps, the card plays a
// 1024-sample block each 1024/rate, and whichever is due first runs. The queue is warmed to 140 ms (what the real
// page measured after a 0.8 s stall: 141 ms) and the time to be back inside [10, 80] ms - and to STAY there for
// 2 s - is the measurement. Main takes 15.7-18.5 s; the correction here takes 4-5 s.
//
// Only this one measurement is asserted, and deliberately: measured on both versions, the depth at 20-30 s and the
// behaviour of a queue that starts EMPTY do not differ between them (from empty both reach 13-16 ms within seconds
// and stay in the band; at 20-30 s both sit near 60 ms), so a check on either would pass whatever the steering did -
// a test that cannot fail. The empty-queue case has no defect to fix: what used to be reported as "17-29 ms for
// seconds after a stall" was the page-side PortSink.buffered() reading low, not the worklet's queue.
for (const rate of [44100, 48000]) {
  const fps = 49.96766756635178, cycles = 17784, block = new Float32Array(1024);
  const out = new Stage(rate);
  while (out.buffered() < 0.14 * rate) out.push([0, 0.5], cycles, fps);   // the queue a stall leaves
  const frameDt = 1 / fps, blockDt = 1024 / rate;
  let tf = 0, tb = 0; const depth = [];
  while (tf < 30) {
    if (tf <= tb) { out.push([0, 0.5], cycles, fps); tf += frameDt; }
    else { out.sink.pull(block); tb += blockDt; depth.push([tb, out.buffered() / rate * 1000]); }
  }
  const inBand = (m) => m >= 10 && m <= 80;
  let back = null;
  for (let i = 0; i < depth.length && back === null; i++) {
    if (!inBand(depth[i][1])) continue;
    const stay = depth.filter(([t]) => t >= depth[i][0] && t < depth[i][0] + 2);
    if (stay.every(([, m]) => inBand(m))) back = depth[i][0];
  }
  check(`${rate} Hz: a stall's 140 ms queue is back inside 10-80 ms, and stays, within 8 s`,
    depth[0][1] > 100 && back !== null && back <= 8,
    `started ${depth[0][1].toFixed(1)} ms, ${back === null ? 'never settled in the band for 2 s' : `back at ${back.toFixed(2)} s`}`);
  // 140 ms is already past MAX_MS (150) with a frame on top, so dropping exactly the first frame is the bound
  // working, not a fault; a second drop would be the recovery falling behind
  check(`${rate} Hz: at most the one frame the 150 ms bound takes`, out.dropped <= 1, `${out.dropped} dropped`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
