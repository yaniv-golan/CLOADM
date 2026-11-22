/* The audio output's queue and the AudioWorklet processor that plays it.
 *
 * This file is loaded twice: as a module of the page (js/host/audio.js imports SampleQueue; tests/audio.test.js
 * runs it in Node) and, through audioContext.audioWorklet.addModule(), as the processor on the audio thread.
 * It imports nothing, so it loads the same way in every browser's worklet scope, and it registers the processor
 * only where registerProcessor exists.
 *
 * SampleQueue (browser-free): the samples AudioOutput made, waiting to be played.
 *   write(chunk)   append a Float32Array; when the queue is full the OLDEST samples are dropped (counted in
 *                  `dropped`), so it never holds more than `capacity` (CAPACITY_MS of sound)
 *   pull(out)      fill an output block, in order. When it runs dry (pause, turbo or fast tape, which push no
 *                  sound, a busy main thread, sound off) the last sample is held and faded to silence over FADE_MS,
 *                  then the output is 0 until samples come back, when it fades in again over FADE_MS: silence,
 *                  never a repeat of old samples, and no click either way. While samples flow at full gain the
 *                  output IS the samples, value for value.
 *   taken, dropped running totals of the samples played and dropped: taken + dropped is the index, in everything
 *                  ever written, of the next sample to play
 *   Re-prime (the bounded catch-up after a stall; the other half is AudioOutput.push dropping whole frames when the
 *   queue is too deep): once the queue has run dry AND the fade-out has reached 0 (a real gap: a stalled or
 *   background tab, a debugger stop, a pause), the queue does not resume on the first sample that comes back. It
 *   waits, playing silence, until TARGET_MS is queued, or until it has waited twice TARGET_MS with something queued
 *   (a lone frame, a debugger step, still plays, at most 2 x TARGET_MS late; twice, so that frames coming one at a
 *   time, which reach TARGET_MS after about TARGET_MS, always restart on the depth, never on the timeout). So after a gap of any length (a resume
 *   after Pause or a debugger stop restarts frames one at a time) playback restarts at least TARGET_MS deep, instead of restarting on one frame and running dry again and
 *   again while the page's 2% correction slowly refills it (measured before: 1.5 s and more of short blocks).
 *   A dip that refills before the fade reaches 0 is not a gap: it fades back in as before, with no wait.
 *   `primes` counts the waits.
 *
 * The processor ('cloadm-output'): one mono output, fed through its MessagePort with
 *   { samples: Float32Array }   (transferred) appended to its queue
 *   { tap: true | false }       test hook: post a copy of every output block back
 * and posting back
 *   { removed: taken + dropped, frame }                after every REPORT_BLOCKS blocks (frame: the context frame the
 *                                                      count is as of, the end of this block), so the page knows how much
 *                                                      is queued (its latency steering, AudioOutput.push)
 *   { tap: { out, start, n, full, time, queued, primes } }  with the tap on, every block: its output samples, the
 *                                                      index of the first queued sample it took, how many it took,
 *                                                      whether all of it was queued samples at full gain, its
 *                                                      currentTime, and as the block began: the samples queued and
 *                                                      the queue's count of re-primes
 * No SharedArrayBuffer: the site is served without cross-origin isolation (GitHub Pages can't set COOP/COEP).
 */
const FADE_MS = 5;
// TARGET_MS: the latency everything steers to - where the queue re-primes to after a gap (here) and where
// AudioOutput's catch-up and correction bring it (js/host/audio.js)
const TARGET_MS = 40;
// CAPACITY_MS: the page drops frames once SKIP_MS (120 ms, js/host/audio.js) is queued, so the deepest the queue
// gets is SKIP_MS plus the frames one page tick can push at once (session.advance runs at most 4: 133 ms at 30 fps);
// 300 ms holds that with room, so the queue's own drop-oldest is a last resort that never fires in normal running
const CAPACITY_MS = 300;
const REPORT_BLOCKS = 4;       // 4 x 128 samples: the page's view of the queue is at most ~12 ms old

class SampleQueue {
  // primeMs: how much the queue waits for after a gap (0: none, it resumes on the first sample back); waitMs: how
  // long at most, with something queued
  constructor(rate, { capacity = Math.ceil(rate * CAPACITY_MS / 1000), primeMs = TARGET_MS, waitMs = 2 * primeMs } = {}) {
    this.buf = new Float32Array(capacity);
    this.rd = 0;                 // index of the oldest queued sample
    this.n = 0;                  // samples queued
    this.fadeLen = Math.max(1, Math.round(rate * FADE_MS / 1000));
    this.fade = 0;               // fade envelope in steps, 0..fadeLen (whole steps: it gets back to exactly 0 and 1)
    this.last = 0;               // last sample taken
    this.taken = 0;
    this.dropped = 0;
    this.primeLen = Math.round(rate * primeMs / 1000);
    this.priming = this.primeLen > 0;   // waiting for primeLen queued (it starts that way: nothing has played yet)
    this.waitLen = Math.round(rate * waitMs / 1000);
    this.waited = 0;             // samples of silence played while priming with something queued
    this.primes = 0;             // gaps re-primed after
  }
  get capacity() { return this.buf.length; }
  buffered() { return this.n; }
  write(chunk) {
    const buf = this.buf, cap = buf.length;
    let from = 0;
    if (chunk.length >= cap) {   // the chunk alone fills the queue: everything older goes, and its own oldest part
      this.dropped += this.n + chunk.length - cap;
      this.rd = 0; this.n = 0; from = chunk.length - cap;
    } else if (this.n + chunk.length > cap) {
      const k = this.n + chunk.length - cap;
      this.rd = (this.rd + k) % cap; this.n -= k; this.dropped += k;
    }
    let wr = (this.rd + this.n) % cap;
    for (let i = from; i < chunk.length; i++) { buf[wr] = chunk[i]; wr = wr + 1 === cap ? 0 : wr + 1; }
    this.n += chunk.length - from;
  }
  pull(out) {
    const buf = this.buf, cap = buf.length, len = this.fadeLen;
    for (let i = 0; i < out.length; i++) {
      if (this.priming) {
        if (this.n >= this.primeLen || (this.n && ++this.waited >= this.waitLen)) this.priming = false;
        else { out[i] = 0; continue; }
      }
      if (this.n) {
        this.last = buf[this.rd]; this.rd = this.rd + 1 === cap ? 0 : this.rd + 1; this.n--; this.taken++;
        if (this.fade < len) this.fade++;
      } else if (this.fade > 0 && --this.fade === 0 && this.primeLen) { this.priming = true; this.waited = 0; this.primes++; }
      out[i] = this.fade === len ? this.last : this.last * this.fade / len;
    }
  }
}

if (typeof registerProcessor === 'function') {
  class OutputProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.q = new SampleQueue(sampleRate);
      this.tap = false;
      this.blocks = 0;
      this.port.onmessage = (e) => {
        const d = e.data;
        if (d.samples) this.q.write(d.samples);
        else if ('tap' in d) this.tap = !!d.tap;
      };
    }
    process(inputs, outputs) {
      const chans = outputs[0], out = chans[0], q = this.q;
      const start = q.taken + q.dropped, full = !q.priming && q.fade === q.fadeLen && q.n >= out.length, taken0 = q.taken, queued = q.n, primes = q.primes;
      q.pull(out);
      for (let c = 1; c < chans.length; c++) chans[c].set(out);
      if (this.tap) this.port.postMessage({ tap: { out: out.slice(), start, n: q.taken - taken0, full, time: currentTime, queued, primes } });
      if (++this.blocks >= REPORT_BLOCKS) { this.blocks = 0; this.port.postMessage({ removed: q.taken + q.dropped, frame: currentFrame + out.length }); }
      return true;
    }
  }
  registerProcessor('cloadm-output', OutputProcessor);
}

export { SampleQueue, FADE_MS, CAPACITY_MS, TARGET_MS };
