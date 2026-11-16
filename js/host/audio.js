/* Audio output: resamples per-frame level events into a ring buffer played by the Web Audio API.
 *
 * AudioOutput is the output stage, browser-free (tests/audio.test.js runs it in Node):
 *   push(events, frameCycles, fps)  one frame of the machine's sound levels -> DC-blocked samples in the ring
 *   pull(out)                        fill an output block from the ring
 *   discontinuity()                  the machine's sound level is about to jump for a reason that isn't sound
 *                                    (reset, power cycle, machine switch, program load, sound switched on)
 * It never makes a step the machine didn't play:
 *   - through the first frame after a discontinuity (and the first frame once sound is unlocked) the DC-blocking
 *     high-pass follows the level instead of passing its changes on, so the jump from the old level to the new
 *     one, and the settling of a reset (the PIA outputs change a few cycles into the frame), are not heard: the
 *     output carries on from where it was, decaying as the filter does;
 *   - when the ring runs dry (pause, turbo or fast tape, which push no sound, a slow tab) the last sample is held
 *     and faded out over FADE_MS, and faded in again over FADE_MS when samples come back, instead of dropping to
 *     0 and jumping back;
 *   - a frame dropped to keep latency bounded (the page fell behind) still moves the filter's input to the level
 *     it ended on, so the next frame doesn't step from the level before it.
 * While samples flow and nothing is re-seeded, the output is the high-pass of the machine's level averaged over each
 * sample's time window (a box filter).
 * Latency: a frame gives rate / fps samples with the fraction carried, and the ratio is nudged by at most STEER
 * when the ring holds less than LOW_MS or more than HIGH_MS (the card's clock drifting from the machine's), so
 * the latency stays in that band and no frame is dropped (`dropped` counts the frames that are, past MAX_MS).
 */
const FADE_MS = 5;
const SUSPEND_AFTER_MS = 250;   // inactive this long (the ring drained, the fade done): suspend the context
const LOW_MS = 10, HIGH_MS = 80, MAX_MS = 150, STEER = 0.005;

class AudioOutput {
  constructor(rate, size = 16384) {
    this.rate = rate;
    this.ring = new Float32Array(size);
    this.rd = 0; this.wr = 0;
    this.prevIn = 0; this.prevOut = 0;
    this.seed = true;            // the next frame settles the high-pass instead of playing level changes
    this.volume = 0.5;
    this.gain = 0;               // fade envelope, 0..1
    this.fadeStep = 1 / Math.max(1, Math.round(rate * FADE_MS / 1000));
    this.last = 0;               // last sample taken from the ring
    this.frac = 0;               // samples owed from earlier frames (rate / fps is not whole)
    this.dropped = 0;            // frames thrown away because MAX_MS was already buffered
  }
  buffered() { return (this.wr - this.rd + this.ring.length) % this.ring.length; }
  discontinuity() { this.seed = true; }

  // events: flat [cycle, level, cycle, level, ...] (the first at cycle 0); frameCycles: cycles in this frame.
  // A frame gives rate / fps samples, the fraction carried to the next (882.571 at 44.1 kHz for a PAL Dragon
  // makes 882 or 883), so the ring holds what the card plays. The card's clock is not the machine's: outside
  // LOW_MS..HIGH_MS buffered the frame is resampled to up to STEER more or fewer samples, which brings the latency
  // back without a gap or a dropped frame. Over MAX_MS (frames pushed faster than real time) a frame is dropped.
  push(events, frameCycles, fps) {
    const buf = this.buffered(), rate = this.rate;
    // keep latency bounded: a frame that comes too far ahead is dropped, and the filter's input moves to the level
    // the frame ended on, so the next frame carries on from there instead of stepping (the page fell behind)
    if (buf > rate * MAX_MS / 1000) { this.dropped++; if (events.length) this.prevIn = events[events.length - 1]; return; }
    let ratio = 1;
    if (buf > rate * HIGH_MS / 1000) ratio = 1 - STEER;
    else if (buf > 0 && buf < rate * LOW_MS / 1000) ratio = 1 + STEER;   // (0: not playing, nothing to keep up)
    this.frac += rate / fps * ratio;
    const n = Math.floor(this.frac);
    this.frac -= n;
    if (!n) return;
    const ring = this.ring, size = ring.length;
    let ei = 0, level = events.length ? events[1] : 0;
    const settle = this.seed;
    this.seed = false;
    const step = frameCycles / n;
    for (let i = 0; i < n; i++) {
      // the level averaged over this sample's window [t0, t1) (a box filter: a 1-bit signal faster than the
      // sample rate comes out as its average instead of aliasing)
      const t0 = i * step, t1 = t0 + step;
      let acc = 0, t = t0;
      while (ei + 2 < events.length && events[ei + 2] < t1) {
        const c = Math.max(events[ei + 2], t0);
        acc += level * (c - t); t = c;
        ei += 2; level = events[ei + 1];
      }
      acc += level * (t1 - t);
      const avg = acc / step;
      if (settle) this.prevIn = avg;
      // DC-blocking high-pass filter
      const y = avg - this.prevIn + 0.995 * this.prevOut;
      this.prevIn = avg; this.prevOut = y;
      ring[this.wr] = y * this.volume;
      this.wr = (this.wr + 1) % size;
      if (this.wr === this.rd) this.rd = (this.rd + 1) % size;
    }
  }
  pull(out) {
    const ring = this.ring, size = ring.length, d = this.fadeStep;
    for (let i = 0; i < out.length; i++) {
      if (this.rd !== this.wr) {
        this.last = ring[this.rd]; this.rd = (this.rd + 1) % size;
        if (this.gain < 1) this.gain = Math.min(1, this.gain + d);
      } else if (this.gain > 0) this.gain = Math.max(0, this.gain - d);
      out[i] = this.last * this.gain;
    }
  }
}

class Audio {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.volume = 0.5;
    this._enabled = true;
    this.active = true;          // the page wants sound (not paused, tab visible); see setActive
    this.idleTimer = null;
  }
  get enabled() { return this._enabled; }
  set enabled(on) { if (on && !this._enabled) this.discontinuity(); this._enabled = on; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && this.active) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.out = new AudioOutput(this.ctx.sampleRate);
    this.out.volume = this.volume;
    const node = this.ctx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => this.out.pull(e.outputBuffer.getChannelData(0));
    node.connect(this.ctx.destination);
    this.node = node;
  }
  // The page paused or hidden (false) or back (true). Inactive, no frames are pushed, so the ring runs dry and the
  // output fades out (AudioOutput.pull); then the context is suspended, so the sound card is not fed silence
  // 43 times a second. Suspending at once would cut the output wherever it was: a click.
  setActive(on) {
    this.active = on;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.ctx) return;
    if (on) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    this.idleTimer = setTimeout(() => { if (!this.active && this.ctx.state === 'running') this.ctx.suspend(); }, SUSPEND_AFTER_MS);
  }
  // sound is actually playing (browsers only allow it after a click or key press)
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  buffered() { return this.out ? this.out.buffered() : 0; }
  discontinuity() { if (this.out) this.out.discontinuity(); }
  pushFrame(events, frameCycles, fps) {
    if (!this.out || !this._enabled) return;
    this.out.push(events, frameCycles, fps);
  }
}

export { Audio, AudioOutput, FADE_MS };
