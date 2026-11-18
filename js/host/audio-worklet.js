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
 *
 * The processor ('cloadm-output'): one mono output, fed through its MessagePort with
 *   { samples: Float32Array }   (transferred) appended to its queue
 *   { tap: true | false }       test hook: post a copy of every output block back
 * and posting back
 *   { removed: taken + dropped, frame }                after every REPORT_BLOCKS blocks (frame: the context frame the
 *                                                      count is as of, the end of this block), so the page knows how much
 *                                                      is queued (its latency steering, AudioOutput.push)
 *   { tap: { out, start, n, full, time } }             with the tap on, every block: its output samples, the index
 *                                                      of the first queued sample it took, how many it took, whether
 *                                                      all of it was queued samples at full gain, and its currentTime
 * No SharedArrayBuffer: the site is served without cross-origin isolation (GitHub Pages can't set COOP/COEP).
 */
const FADE_MS = 5;
const CAPACITY_MS = 300;       // twice AudioOutput's MAX_MS: the page drops frames long before this fills
const REPORT_BLOCKS = 4;       // 4 x 128 samples: the page's view of the queue is at most ~12 ms old

class SampleQueue {
  constructor(rate, capacity = Math.ceil(rate * CAPACITY_MS / 1000)) {
    this.buf = new Float32Array(capacity);
    this.rd = 0;                 // index of the oldest queued sample
    this.n = 0;                  // samples queued
    this.fadeLen = Math.max(1, Math.round(rate * FADE_MS / 1000));
    this.fade = 0;               // fade envelope in steps, 0..fadeLen (whole steps: it gets back to exactly 0 and 1)
    this.last = 0;               // last sample taken
    this.taken = 0;
    this.dropped = 0;
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
      if (this.n) {
        this.last = buf[this.rd]; this.rd = this.rd + 1 === cap ? 0 : this.rd + 1; this.n--; this.taken++;
        if (this.fade < len) this.fade++;
      } else if (this.fade > 0) this.fade--;
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
      const start = q.taken + q.dropped, full = q.fade === q.fadeLen && q.n >= out.length, taken0 = q.taken;
      q.pull(out);
      for (let c = 1; c < chans.length; c++) chans[c].set(out);
      if (this.tap) this.port.postMessage({ tap: { out: out.slice(), start, n: q.taken - taken0, full, time: currentTime } });
      if (++this.blocks >= REPORT_BLOCKS) { this.blocks = 0; this.port.postMessage({ removed: q.taken + q.dropped, frame: currentFrame + out.length }); }
      return true;
    }
  }
  registerProcessor('cloadm-output', OutputProcessor);
}

export { SampleQueue, FADE_MS, CAPACITY_MS };
