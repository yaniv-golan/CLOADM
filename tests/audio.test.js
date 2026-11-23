// The audio output stage (js/host/audio.js AudioOutput and its SampleQueue, browser-free): no pop the machine didn't play.
// A pop is a large jump between two consecutive output samples. Where the machine's level is constant, the
// output may only move by the high-pass filter's own decay (at most 0.5% of its value a sample) or by the fade
// (1/(FADE_MS of samples) of the held value a sample), so the bound used is BOUND = 0.01 (1% of full scale) for
// every sample-to-sample step around: sound unlock, a reset or machine switch that changes the level, the ring
// running dry (pause, turbo, sound off) and samples coming back. Each case is also run without the protection
// (the old stage: no re-seed, 0 on underrun) to show the case does pop there. While samples flow, the output
// is exactly the high-pass of the machine's levels, as before.
const { AudioOutput, FADE_MS, SKIP_MS, TARGET_MS, LOW_MS, HIGH_MS, CATCHUP_MS } = require('../js/host/audio.js');
const { SampleQueue } = require('../js/host/audio-worklet.js');
// the stage as the page plays it: AudioOutput writing into a SampleQueue (its default sink), which the audio
// thread pulls (js/host/audio-worklet.js)
class Stage extends AudioOutput { pull(b) { this.sink.pull(b); } }
// the same without the queue's re-prime after a gap (js/host/audio-worklet.js), for the checks that line its output
// up sample by sample with a reference; the re-prime has its own checks (no pop through it, and the catch-up below)
const plain = (rate) => new Stage(rate, new SampleQueue(rate, { primeMs: 0 }));

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
    const a = play(plain(rate), script), b = play(new BoxReference(rate), script);
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
    const a = play(plain(rate), script), b = play(new OldOutput(rate), script);
    const k = 1 + 11 * n;     // the first sample after the ring ran dry
    check(`${rate} Hz: the output is high when the ring runs dry`, Math.abs(a[k - 1]) > 0.3, a[k - 1].toFixed(3));
    check(`${rate} Hz: running dry and resuming make no pop`, maxJump(a, k) < BOUND && maxJump(b, k) > 0.3,
      `max step ${maxJump(a, k).toFixed(4)} (old ${maxJump(b, k).toFixed(3)})`);
    check(`${rate} Hz: silent while paused`, a[1 + 9 * n + 4096 - 1] === 0);
    // the page's queue re-primes after the gap (silence until TARGET_MS is queued, then the fade-in): no pop either
    const p = play(new Stage(rate), script);
    check(`${rate} Hz: with the re-prime, running dry and resuming make no pop, and it does wait`, maxJump(p, k) < BOUND && p.slice(k).some((v) => Math.abs(v) > 0.3),
      `max step ${maxJump(p, k).toFixed(4)}`);
  }

  // a tone cut by a pause and resumed: only the tone's own steps, faded
  {
    const tone = (i) => square(300, i);
    const script = [...steady(rate, (i) => (i < 10 ? tone(i) : null)), ['pull', 4096], ...steady(rate, (i) => (i < 10 ? tone(i) : null), 0)];
    const a = play(new Stage(rate), script);
    const toneStep = maxJump(play(new Stage(rate), steady(rate, (i) => (i < 30 ? tone(i) : null))), fade + 2);
    check(`${rate} Hz: pausing a tone never steps more than the tone itself`, maxJump(a, fade + 2) <= toneStep + 1e-6, `${maxJump(a, fade + 2).toFixed(3)} <= ${toneStep.toFixed(3)}`);
  }

  // a frame dropped by the catch-up while the level ramps: the next frame carries on from where the dropped one
  // ended, without a step (the level moved by 0.15 in the frame that was dropped). The catch-up has hysteresis: once
  // more than SKIP_MS is queued it drops every push until the queue is back to TARGET_MS, so the test drains the
  // queue to just under TARGET_MS (samples still queued: no fade hides a step) before frame 7, and asserts that
  // frame 6 was dropped and frame 7 rendered. Without that, frame 7 would be dropped too and the carry never tested.
  {
    // the level rises 0.15 a frame in 20 small steps (each 0.0075, an output step of 0.00375: below the bound)
    const ramp = (i) => Array.from({ length: 20 }, (_, k) => [Math.round(k * CYCLES / 20), 0.15 * i + 0.0075 * k]).flat();
    const script = [];
    for (let i = 0; i < 4; i++) script.push(['push', ramp(i)], ['pull', n]);
    for (let i = 4; i < 6; i++) script.push(['push', ramp(i)]);            // two frames ahead
    script.push(['fill']);                                                   // past SKIP_MS: the next push is dropped
    script.push(['push', ramp(6)], ['dropped6'], ['drain'], ['push', ramp(7)], ['rendered7'], ['pull', 20000]);
    const run = (out) => {
      const all = [0], seen = {};
      for (const [op, arg] of script) {
        if (op === 'push') out.push(arg, CYCLES, FPS);
        else if (op === 'fill') { while (out.buffered() <= rate * SKIP_MS / 1000) out.push(flat(out.prevIn), CYCLES, FPS); seen.before6 = out.dropped; }
        else if (op === 'dropped6') { seen.dropped6 = out.dropped === seen.before6 + 1 && out.catchingUp; seen.before7 = out.dropped; }
        else if (op === 'drain') {                                           // to 5 ms under TARGET_MS, still queued
          const b = new Float32Array(out.buffered() - Math.round(rate * (TARGET_MS - 5) / 1000)); out.pull(b); all.push(...b);
          seen.drained = out.buffered() > 0 && out.buffered() < rate * TARGET_MS / 1000;
        } else if (op === 'rendered7') seen.rendered7 = out.dropped === seen.before7 && !out.catchingUp;
        else { const b = new Float32Array(arg); out.pull(b); all.push(...b); }
      }
      return { all, seen };
    };
    const { all: a, seen } = run(new Stage(rate)), k = 1 + 4 * n;   // from the pulls after the fill
    check(`${rate} Hz: the catch-up drops frame 6, and frame 7, pushed once the queue is under TARGET_MS, is rendered`,
      seen.dropped6 && seen.drained && seen.rendered7, JSON.stringify(seen));
    check(`${rate} Hz: a dropped frame leaves no step`, a.length > k + 10000 && maxJump(a, k) < BOUND, `max step ${maxJump(a, k).toFixed(4)}`);
  }

  // latency stays bounded when frames come faster than they are played
  {
    const out = new Stage(rate);
    for (let i = 0; i < 100; i++) out.push(flat(0.5), CYCLES, FPS);
    check(`${rate} Hz: at most SKIP_MS (${SKIP_MS} ms) and a frame buffered`, out.buffered() <= rate * SKIP_MS / 1000 + n, `${out.buffered()} samples`);
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

// ---- the bounded catch-up after a stall (mocked clock) ----
// The page as js/ui/screen.js and Session.advance drive it, on a simulated clock: a requestAnimationFrame tick every
// 1/60 s adds the elapsed time (at most 200 ms) and runs the frames due (at most 4 a tick, the rest forgotten); the
// audio thread pulls 128-sample render quanta at the card's rate, and does not stop when the page does. Two stalls:
//   'freeze'  no tick comes (a GC pause or a busy page, a background tab): the first tick after runs 4 frames at once;
//   'pause'   ticks come but run no frame, and the Session's accumulator is cleared (a debugger stop, Pause): frames
//             restart one at a time, as the clock makes them due.
// Measured for each:
//   - steady state: the latency inside LOW_MS..HIGH_MS for every quantum, no quantum short, no frame dropped;
//   - after the stall: the callbacks until sound plays again, bounded by the re-prime's wait: TARGET_MS, plus the
//     frame and the tick in flight, N = ceil((TARGET_MS + 1000/fps + 1000/60) / quantum); playback restarts exactly
//     at least TARGET_MS deep; from then on no quantum is short and the queue stays between LOW_MS and SKIP_MS (a
//     freeze's 4-frame burst can sit a little above HIGH_MS, where the correction, not the catch-up, brings it in).
// `prime` false runs the same page without the re-prime: after a pause it restarts on one frame and hovers under
// LOW_MS, between 0 and a frame, for seconds while the 2% correction refills it (the slow refill this replaces);
// that check is what shows the scenario needs it. A freeze restarts deep enough without it (4 frames at once).
function simulate({ rate, fps, cycles = 17784, stall = null, stallAt = 2, stallS = 0, seconds = 6, prime = true, deep = 0 }) {
  const out = new Stage(rate, new SampleQueue(rate, prime ? {} : { primeMs: 0 }));
  const q = out.sink, Q = 128, quantum = new Float32Array(Q), frameMs = 1000 / fps, ev = [0, 0.3, cycles >> 1, 0.6];
  let tTick = 0, tQ = 0, acc = 0, last = 0, firstTick = true, deepDone = false;
  const quanta = [];                         // [time, queued before the pull, samples taken]
  while (tTick < seconds || tQ < seconds) {
    if (tTick <= tQ) {
      const inStall = stallS && tTick >= stallAt && tTick < stallAt + stallS;
      if (!(inStall && stall === 'freeze')) {
        const dt = firstTick ? 0 : (tTick - last) * 1000; last = tTick; firstTick = false;
        if (inStall) acc = 0;                // paused: Session.advance clears its accumulator and runs nothing
        else {
          acc += Math.min(dt, 200);
          let n = 0;
          while (acc >= frameMs && n < 4) { out.push(ev, cycles, fps); acc -= frameMs; n++; }
          if (acc > frameMs * 4) acc = 0;
        }
      }
      // deep: frames pushed past the queue's depth at once (the audio thread held as well as the page)
      if (deep && !deepDone && tTick >= stallAt) { deepDone = true; while (q.buffered() < deep / 1000 * rate) q.write(new Float32Array(Math.round(rate / fps))); }
      tTick += 1 / 60;
    } else {
      const before = q.buffered(), t0 = q.taken;
      q.pull(quantum);
      quanta.push([tQ, before, q.taken - t0]);
      tQ += Q / rate;
    }
  }
  return { out, q, quanta };
}
for (const rate of [44100, 48000]) {
  for (const fps of [49.96766756635178, 59.92274340431231]) {
    const tag = `${rate} Hz, ${fps.toFixed(2)} fps`, msOf = (n) => n / rate * 1000;
    // steady state (after the first second): every quantum full, the latency in the band, nothing dropped
    {
      const { out, quanta } = simulate({ rate, fps, seconds: 20 });
      const after = quanta.filter(([t]) => t > 1);
      const short = after.filter(([, , n]) => n < 128).length, lo = Math.min(...after.map(([, b]) => msOf(b))), hi = Math.max(...after.map(([, b]) => msOf(b)));
      check(`catch-up, ${tag}: steady state: no quantum short, the queue inside ${LOW_MS}-${HIGH_MS} ms, nothing dropped`,
        short === 0 && lo >= LOW_MS && hi <= HIGH_MS && out.dropped === 0, `short ${short}, queue ${lo.toFixed(1)}..${hi.toFixed(1)} ms, dropped ${out.dropped}`);
    }
    const N = Math.ceil((TARGET_MS + 1000 / fps + 1000 / 60) / 1000 * rate / 128);
    for (const stall of ['freeze', 'pause']) {
      for (const stallS of [0.3, 2]) {
        const measure = (prime) => {
          const { quanta } = simulate({ rate, fps, stall, stallS, seconds: 2 + stallS + 4, prime });
          const end = 2 + stallS;
          const after = quanta.filter(([t]) => t >= end);
          const restart = after.findIndex(([, , n]) => n > 0);          // the first quantum that plays again
          const played = restart < 0 ? [] : after.slice(restart + 1);
          return {
            restart, depth: restart < 0 ? 0 : +msOf(after[restart][1]).toFixed(1),
            short: played.filter(([, , n]) => n < 128).length,
            outOfBand: played.filter(([, b]) => msOf(b) < LOW_MS || msOf(b) > SKIP_MS).length,
            dry: quanta.some(([t, b]) => t > 2 && t < end && b === 0),
          };
        };
        const m = measure(true), old = measure(false), name = `catch-up, ${tag}, ${stallS} s ${stall}`;
        check(`${name}: the queue really ran dry during it`, m.dry);
        check(`${name}: sound again within N = ${N} callbacks, never short after, the queue between ${LOW_MS} and SKIP_MS (${SKIP_MS} ms)`,
          m.restart >= 0 && m.restart <= N && m.short === 0 && m.outOfBand === 0, JSON.stringify(m));
        // (a freeze needs no re-prime: its first tick runs 4 frames at once, so it restarts deep enough by itself)
        if (stall === 'pause') {
          check(`${name}: without the re-prime the same stall refills slowly (the queue under ${LOW_MS} ms for many callbacks)`,
            old.outOfBand > 10, JSON.stringify(old));
        }
      }
    }
    // deep: more than SKIP_MS queued (the audio thread held as well as the page, then a burst): whole frames are
    // dropped until it is back to TARGET_MS, within CATCHUP_MS of real time, and it stays in the band after
    {
      const deep = SKIP_MS + 4 * 1000 / 30;
      const { out, quanta } = simulate({ rate, fps, deep, seconds: 2 + 3 });
      const from = quanta.findIndex(([, b]) => msOf(b) > SKIP_MS);
      const after = from < 0 ? [] : quanta.slice(from);
      const peak = from < 0 ? 0 : msOf(after[0][1]);
      const back = after.findIndex(([, b]) => msOf(b) <= HIGH_MS);
      const backMs = back < 0 ? Infinity : (after[back][0] - after[0][0]) * 1000;
      const stays = back >= 0 && after.slice(back).every(([, b, n]) => msOf(b) <= HIGH_MS && msOf(b) >= LOW_MS && n === 128);
      check(`catch-up, ${tag}: a queue ${peak.toFixed(0)} ms deep is back inside the band within CATCHUP_MS (${CATCHUP_MS.toFixed(0)} ms) and stays, by dropping frames`,
        peak > SKIP_MS && backMs <= CATCHUP_MS && stays && out.dropped > 0, JSON.stringify({ backMs: +backMs.toFixed(1), dropped: out.dropped, stays }));
    }
  }
}

// ---- the correction does not warble a queue that keeps crossing into the band ----
// The queue jumps by a 1024-sample block every frame (21-23 ms), so a correction whose SIZE follows the depth
// flips on and off every time the queue crosses an edge. Measured with a card clock 1% slow - which parks the
// queue around 58 ms with the correction on half the frames - a proportional ratio reversed 13 times a second
// (34.6 cents of 50 Hz warble). Held CONSTANT from the moment the queue leaves the band until it reaches
// TARGET_MS, the ratio is one of three exact values and changes rarely: this pins both, and 0.5 reversals a
// second is well under the 13 a depth-following ratio gives.
{
  const rate = 44100, skew = 0.99, fps = 49.96766756635178, cycles = 17784;
  const out = new Stage(rate), block = new Float32Array(1024), frameDt = 1 / fps, blockDt = 1024 / (rate * skew);
  while (out.buffered() < 0.04 * rate) out.push([0, 0.5], cycles, fps);
  let tf = 0, tb = 0; const ratios = [], depth = [];
  while (tf < 120) {
    if (tf <= tb) { out.push([0, 0.5], cycles, fps); tf += frameDt; }
    else { out.sink.pull(block); tb += blockDt; if (tf > 40) { ratios.push(out.ratioAt(out.buffered() / rate * 1000)); depth.push(out.buffered() / rate * 1000); } }
  }
  const values = [...new Set(ratios.map((r) => r.toFixed(6)))];
  let reversals = 0, prev = 0;
  for (let i = 1; i < ratios.length; i++) { const s = Math.sign(ratios[i] - ratios[i - 1]); if (s && prev && s !== prev) reversals++; if (s) prev = s; }
  const active = ratios.filter((r) => r !== 1).length / ratios.length;
  check(`${rate} Hz, card clock x${skew}: the ratio takes 3 values, corrects and does not hunt`,
    [...values].every((v) => ['1.000000', '1.020000', '0.980000'].includes(v)) && active > 0.2 && active < 0.8 && reversals / 80 <= 1,
    `${[...values].join(',')} over ${ratios.length} frames (queue ${Math.min(...depth).toFixed(0)}..${Math.max(...depth).toFixed(0)} ms), correcting ${(active * 100).toFixed(0)}% of them, ${(reversals / 80).toFixed(2)} reversals/s (a depth-following ratio gives 13/s)`);
}

// The steady-state property the browser's tone check depends on: once the queue is back at TARGET_MS the ratio is
// EXACTLY 1 (so a tone is played at the machine's frequency), and while the resampler is recovering the ratio is
// held within +-2% of 1 (the deliberate, transient detune). A check that sampled during recovery would measure
// that detune instead of the machine's tone -- CI did: 451.39 Hz played for a 456.64 Hz square wave.
{
  const rate = 44100, fps = 49.96766756635178, cycles = 17784, block = new Float32Array(1024);
  const out = new Stage(rate);
  // start deep (just under SKIP_MS: the deepest the catch-up leaves to the correction), then let it recover by
  // pulling the card as fast as the machine fills it, sampling the ratio at every frame
  while (out.buffered() < (SKIP_MS - 1) / 1000 * rate) out.push([0, 0.5], cycles, fps);
  const ratios = []; let tf = 0, tb = 0;
  const frameDt = 1 / fps, blockDt = 1024 / rate;
  while (tf < 60) {
    if (tf <= tb) { out.push([0, 0.5], cycles, fps); tf += frameDt; } else { out.sink.pull(block); tb += blockDt; }
    ratios.push(out.ratioAt(out.buffered() / rate * 1000));
  }
  const ratioOut = out.ratioAt(out.buffered() / rate * 1000);
  check('audio: while the resampler recovers the ratio stays within +-2% of 1', ratios.every((r) => r >= 0.98 - 1e-9 && r <= 1.02 + 1e-9), `${[...new Set(ratios.map((r) => r.toFixed(3)))].join(',')}`);
  check('audio: and once it has settled the ratio is exactly 1 (a steady tone keeps the machine\'s frequency)',
    ratioOut === 1 && out.mode === 0, `ratio ${ratioOut}, mode ${out.mode}, queue ${(out.buffered() / rate * 1000).toFixed(1)} ms`);
}

// The bound the browser's tone check waits under must be at least the TRUE worst case, or the check flakes on the
// slowest start it can see. The worst case for the correction is a queue just under SKIP_MS: deeper, the catch-up
// drops frames down to TARGET_MS at once. How long the correction then takes depends on the frame and
// block schedule, over card rates 44.1/48 kHz, 30/49.97/59.94/60 fps and 512/1024/2048-sample blocks,
// so this drives those schedules in simulated real time
// (frames at 1/fps of audio time, the card pulling blocks) and requires NONE within SETTLE_MS. RED if the bound
// is set below the measurement: it is the guard on the number.
{
  const { SETTLE_MS } = require('../js/host/audio.js');
  const cycles = 17784;
  let slowest = 0, worstAt = '';
  for (const rate of [44100, 48000]) {
    for (const fps of [30, 49.96766756635178, 59.94, 60]) {
      for (const bs of [512, 1024, 2048]) {
        const out = new Stage(rate);
        // fill to just under SKIP_MS -- the deepest queue the correction (not the catch-up) brings back
        let guard = 0;
        while ((out.buffered() / rate + 1 / fps) * 1000 < SKIP_MS && guard++ < 4000) out.push([0, 0.5], cycles, fps);
        const startMs = out.buffered() / rate * 1000;
        const frameDt = 1 / fps, block = new Float32Array(bs), blockDt = bs / rate;
        let tf = 0, tb = 0, settled = null;
        while (tf < 30 && settled === null) {
          if (tf <= tb) { out.push([0, 0.5], cycles, fps); tf += frameDt; }
          else { out.pull(block); tb += blockDt; if (out.mode === 0 && tb > 0.1) settled = tb; }
        }
        const ms = settled === null ? Infinity : settled * 1000;
        if (ms > slowest) { slowest = ms; worstAt = `${rate} Hz, ${fps} fps, ${bs}-sample blocks, from ${startMs.toFixed(0)} ms`; }
        check(`${rate} Hz, ${fps} fps, ${bs}-sample blocks: a queue just under SKIP_MS (${SKIP_MS} ms) settles within SETTLE_MS (${SETTLE_MS} ms)`,
          settled !== null && ms <= SETTLE_MS, settled === null ? 'never settled' : `${ms.toFixed(0)} ms`);
      }
    }
  }
  // AND the bound must have real HEADROOM over the measured worst case, not merely exceed it. A bound equal to the
  // measurement passes "settles within" and still flakes: the browser's real schedule is not this model's, and a
  // post-stall queue is exactly where it runs. The problem was that 5 s was "about 2% margin in exactly
  // the post-stall case"; requiring headroom is what makes such a bound fail here.
  const headroom = SETTLE_MS / slowest;
  check('audio: the settle bound has real headroom over the measured worst case (not merely above it)',
    headroom >= 1.5 && headroom <= 3,
    `SETTLE_MS ${SETTLE_MS} ms / worst ${slowest.toFixed(0)} ms = ${headroom.toFixed(2)}x (${worstAt})`);
}

// pushTape from a deep queue (fast tape loading pushes real time with no machine frame): the same steering as push().
// A queue filled 10 ms at a time passes HIGH_MS and enters DRAINING (mode 2); past SKIP_MS the catch-up drops the
// push (`dropped`) instead of queueing it, and keeps dropping until the queue is back to TARGET_MS, where the mode
// is NONE (0) and the ratio exactly 1 again. RED without the catch-up in pushTape (nothing dropped, the queue runs
// past SKIP_MS) and with pushTape bypassing ratioAt (the mode never leaves NONE).
{
  const { SETTLE_MS } = require('../js/host/audio.js');
  const rate = 48000, STEP = 10, per = rate * STEP / 1000;
  const out = new Stage(rate), ms = () => out.buffered() / rate * 1000;
  let peak = 0, sawDraining = false, guard = 0;
  while (out.dropped === 0 && guard++ < 100) {
    out.pushTape(STEP, null);
    peak = Math.max(peak, ms());
    if (out.mode === 2) sawDraining = true;
  }
  check('audio: pushTape from a deep queue enters DRAINING (mode 2) once the queue passes the band', sawDraining, `mode ${out.mode}, queue ${ms().toFixed(1)} ms`);
  check(`audio: pushTape drops a push past SKIP_MS (${SKIP_MS} ms) instead of queueing it`, out.dropped === 1 && peak > SKIP_MS - STEP && peak <= SKIP_MS + STEP, `dropped ${out.dropped}, peak ${peak.toFixed(1)} ms`);
  // real time: the card pulls STEP ms for every STEP ms pushed
  const block = new Float32Array(per);
  let t = 0, back = null;
  while (t < SETTLE_MS && back === null) {
    out.pushTape(STEP, null); out.pull(block); t += STEP;
    if (out.mode === 0) back = t;
  }
  check('audio: pushTape DRAINING goes back to NONE (2 to 0) once the queue reaches TARGET_MS', back !== null && back <= SETTLE_MS, back === null ? `still mode ${out.mode} at ${ms().toFixed(1)} ms` : `after ${back} ms`);
  // (pushes are still dropped while the catch-up brings the queue to TARGET_MS; once settled, none are)
  const droppedAtNone = out.dropped;
  for (let i = 0; i < 100; i++) { out.pushTape(STEP, null); out.pull(block); }
  check(`audio: and the queue settles near TARGET_MS (${TARGET_MS} ms), with nothing more dropped`, Math.abs(ms() - TARGET_MS) <= STEP && out.dropped === droppedAtNone && out.mode === 0, `${ms().toFixed(1)} ms, dropped ${out.dropped}`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
