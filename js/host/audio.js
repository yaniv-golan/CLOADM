/* Audio output: resamples per-frame level events into samples played by the Web Audio API.
 *
 * AudioOutput is the output stage, browser-free (tests/audio.test.js runs it in Node):
 *   push(events, frameCycles, fps, tape)  one frame of the machine's sound levels -> DC-blocked samples, written as
 *                                    one chunk to its sink (a SampleQueue, or the page's PortSink to the worklet);
 *                                    with a tape voice (the page's "Tape sound", js/host/tape-sound.js), the tape's
 *                                    signal over the frame mixed in at tapeVolume
 *   pushTape(ms, tape)               real time with no machine frame (fast tape loading): the tape's voice alone
 *   discontinuity()                  the machine's sound level is about to jump for a reason that isn't sound
 *                                    (reset, power cycle, machine switch, program load, sound switched on)
 * The sink plays the samples (SampleQueue.pull, js/host/audio-worklet.js): on the audio thread in an
 * AudioWorkletNode, or, where AudioWorklet is missing, in a ScriptProcessorNode (see Audio.start).
 * It never makes a step the machine didn't play:
 *   - through the first frame after a discontinuity (and the first frame once sound is unlocked) the DC-blocking
 *     high-pass follows the level instead of passing its changes on, so the jump from the old level to the new
 *     one, and the settling of a reset (the PIA outputs change a few cycles into the frame), are not heard: the
 *     output carries on from where it was, decaying as the filter does;
 *   - when the queue runs dry (pause, turbo or fast tape, which push no sound, a slow tab) the last sample is held
 *     and faded out over FADE_MS, and faded in again over FADE_MS when samples come back, instead of dropping to
 *     0 and jumping back (SampleQueue.pull);
 *   - a frame dropped to keep latency bounded (the page fell behind) still moves the filter's input to the level
 *     it ended on, so the next frame doesn't step from the level before it.
 * While samples flow and nothing is re-seeded, the output is the high-pass of the machine's level averaged over each
 * sample's time window (a box filter).
 * Latency: a frame gives rate / fps samples with the fraction carried, and the ratio is nudged by at most STEER
 * when the sink holds less than LOW_MS or more than HIGH_MS (the card's clock drifting from the machine's), so
 * the latency stays in that band and no frame is dropped (`dropped` counts the frames that are, past MAX_MS).
 */
import { SampleQueue, FADE_MS } from './audio-worklet.js';
import { TapeVoice, boxAverage, DEFAULT_VOLUME } from './tape-sound.js';

const SUSPEND_AFTER_MS = 250;   // inactive this long (the queue drained, the fade done): suspend the context
const LOW_MS = 10, HIGH_MS = 80, MAX_MS = 150, STEER = 0.005;

class AudioOutput {
  // sink: where the samples go (write(chunk), buffered()); a SampleQueue unless the page plays them elsewhere.
  // highPass false: no DC-blocking filter, so a sample is the machine's level averaged over its window, times the
  // volume (the command line's --wav recording, cli/cloadm.js, whose levels a test can check exactly)
  constructor(rate, sink = new SampleQueue(rate), { highPass = true } = {}) {
    this.rate = rate;
    this.sink = sink;
    this.highPass = highPass;
    this.prevIn = 0; this.prevOut = 0;
    this.seed = true;            // the next frame settles the high-pass instead of playing level changes
    this.volume = 0.5;
    this.frac = 0;               // samples owed from earlier frames (rate / fps is not whole)
    this.dropped = 0;            // frames thrown away because MAX_MS was already buffered
    this.tapeVoice = null;       // the page's "Tape sound" (a TapeVoice), mixed in at tapeVolume; none on the command line
    this.tapeVolume = DEFAULT_VOLUME;
  }
  buffered() { return this.sink.buffered(); }
  discontinuity() { this.seed = true; }

  // events: flat [cycle, level, cycle, level, ...] (the first at cycle 0); frameCycles: cycles in this frame.
  // A frame gives rate / fps samples, the fraction carried to the next (882.571 at 44.1 kHz for a PAL Dragon
  // makes 882 or 883), so the sink holds what the card plays. The card's clock is not the machine's: outside
  // LOW_MS..HIGH_MS buffered the frame is resampled to up to STEER more or fewer samples, which brings the latency
  // back without a gap or a dropped frame. Over MAX_MS (frames pushed faster than real time) a frame is dropped.
  push(events, frameCycles, fps, tape = null) {
    const buf = this.buffered(), rate = this.rate;
    // keep latency bounded: a frame that comes too far ahead is dropped, and the filter's input moves to the level
    // the frame ended on, so the next frame carries on from there instead of stepping (the page fell behind)
    if (buf > rate * MAX_MS / 1000) { this.dropped++; if (events && events.length) this.prevIn = events[events.length - 1]; return; }
    const n = this.count(rate / fps);
    if (n) this.render(events, frameCycles, n, tape);
  }
  // `ms` of real time with no machine frame (fast tape loading runs the machine flat out and pushes none): the
  // tape alone (tape: { events, cycles }, js/host/tape-sound.js), the machine's own output carrying on from where
  // it was, decaying as its filter does
  pushTape(ms, tape) {
    if (this.buffered() > this.rate * MAX_MS / 1000) { this.dropped++; return; }
    const n = this.count(this.rate * ms / 1000);
    if (n) this.render(null, 0, n, tape);
  }
  // samples owed for `want` more (the fraction carried), steered: outside LOW_MS..HIGH_MS buffered, up to STEER
  // more or fewer
  count(want) {
    const buf = this.buffered(), rate = this.rate;
    let ratio = 1;
    if (buf > rate * HIGH_MS / 1000) ratio = 1 - STEER;
    else if (buf > 0 && buf < rate * LOW_MS / 1000) ratio = 1 + STEER;   // (0: not playing, nothing to keep up)
    this.frac += want * ratio;
    const n = Math.floor(this.frac);
    this.frac -= n;
    return n;
  }
  // n samples: the machine's events (null: none, its output decays) and, with a tape voice, the tape mixed in
  render(events, frameCycles, n, tape) {
    const chunk = new Float32Array(n);
    if (events) {
      // the level averaged over each sample's window (a box filter: js/host/tape-sound.js boxAverage)
      const avg = boxAverage(events, frameCycles, n, new Float64Array(n));
      const settle = this.seed;
      this.seed = false;
      for (let i = 0; i < n; i++) {
        if (!this.highPass) { chunk[i] = avg[i] * this.volume; continue; }
        if (settle) this.prevIn = avg[i];
        // DC-blocking high-pass filter
        const y = avg[i] - this.prevIn + 0.995 * this.prevOut;
        this.prevIn = avg[i]; this.prevOut = y;
        chunk[i] = y * this.volume;
      }
    } else if (this.highPass) {
      for (let i = 0; i < n; i++) { this.prevOut *= 0.995; chunk[i] = this.prevOut * this.volume; }
    }
    // the recorder's speaker (the page's "Tape sound"): host-side, never the machine's own output
    if (this.tapeVoice) this.tapeVoice.mix(tape && tape.events, tape && tape.cycles, n, chunk, this.tapeVolume);
    this.sink.write(chunk);
  }
}

// The sink for the AudioWorkletNode: each chunk goes to the processor through its MessagePort, transferred (no
// copy, no SharedArrayBuffer). The processor reports how many samples it has taken or dropped (`removed`) and the
// context frame that count is as of (`frame`), every REPORT_BLOCKS render blocks. Since then it has played on, up
// to one sample a frame, so buffered() is what was written, less what was reported removed, less the frames the
// context's clock (clock(): its current frame) has moved on since: what is really queued, not up to ~12 ms more
// (an overestimate would hold the steering back from refilling, and the audio thread, unlike the old
// ScriptProcessorNode, plays on through a busy page, so headroom matters). Never below 0.
class PortSink {
  constructor(port, clock) {
    this.port = port;
    this.clock = clock;
    this.written = 0;            // samples ever written
    this.removed = 0;            // samples the processor has taken or dropped, as last reported
    this.frame = clock();        // the context frame that report is as of (until the first: now, nothing taken yet)
    port.addEventListener('message', (e) => { const d = e.data; if (d.removed !== undefined) { this.removed = d.removed; this.frame = d.frame; } });
    port.start();
  }
  buffered() { return Math.max(0, this.written - this.removed - Math.max(0, this.clock() - this.frame)); }
  write(chunk) {
    this.written += chunk.length;
    this.port.postMessage({ samples: chunk }, [chunk.buffer]);
  }
}

const WORKLET_URL = new URL('./audio-worklet.js', import.meta.url).href;
const WORKLET_WAIT_MS = 3000;   // the worklet's module not loaded by then: play through the fallback instead

class Audio {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.node = null;
    this.path = null;            // how the samples are played: 'loading', then 'worklet' or 'script' (see start)
    this.fallback = null;        // why the fallback plays, when it does
    this.volume = 0.5;
    this._enabled = true;
    this.tapeSound = true;       // the page's "Tape sound": the tape heard as a recorder's speaker plays it
    this.active = true;          // the page wants sound (not paused, tab visible); see setActive
    this.idleTimer = null;
  }
  get enabled() { return this._enabled; }
  set enabled(on) { if (on && !this._enabled) this.discontinuity(); this._enabled = on; }
  // Called from a click or key press (browsers only allow sound after one). The context is made here, at once,
  // so the gesture unlocks it; the samples are played by an AudioWorkletNode, on the audio thread, once its module
  // has loaded (a moment: until then there is no output stage and frames make no sound, as before the unlock).
  // Fallback: where AudioWorklet is missing (an insecure http:// address other than localhost, an old browser), its
  // module fails or hasn't loaded within WORKLET_WAIT_MS, or its processor fails once running, a ScriptProcessorNode
  // plays a SampleQueue on the page's thread, so sound keeps working (`fallback` says why). It is made only then:
  // with AudioWorklet working, no ScriptProcessorNode is ever created.
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && this.active) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') { this.playScript('no AudioWorklet'); return; }
    this.path = 'loading';
    const waited = setTimeout(() => { if (this.path === 'loading') this.playScript(`the AudioWorklet module did not load within ${WORKLET_WAIT_MS} ms`); }, WORKLET_WAIT_MS);
    ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      clearTimeout(waited);
      if (this.path !== 'loading') return;           // (too late: the fallback plays)
      const node = new AudioWorkletNode(ctx, 'cloadm-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.connect(ctx.destination);
      // a processor that fails once running (its constructor or process() throws) goes silent for good: play the
      // stage through the fallback instead
      node.addEventListener('processorerror', () => { node.disconnect(); this.playScript('the AudioWorklet processor failed'); });
      this.play(node, new PortSink(node.port, () => Math.round(ctx.currentTime * ctx.sampleRate)), 'worklet');
    }).catch((e) => { clearTimeout(waited); if (this.path === 'loading') this.playScript(`the AudioWorklet module failed to load (${e && e.message})`); });
  }
  playScript(why) {
    this.fallback = why;
    const queue = new SampleQueue(this.ctx.sampleRate);
    const node = this.ctx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => queue.pull(e.outputBuffer.getChannelData(0));
    node.connect(this.ctx.destination);
    this.play(node, queue, 'script');
  }
  play(node, sink, path) {
    this.node = node;
    this.out = new AudioOutput(this.ctx.sampleRate, sink);
    this.out.volume = this.volume;
    this.out.tapeVoice = new TapeVoice(this.ctx.sampleRate);
    this.path = path;
  }
  // The page paused or hidden (false) or back (true). Inactive, no frames are pushed, so the queue runs dry and the
  // output fades out (SampleQueue.pull); then the context is suspended, so the sound card is not fed silence
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
  // one machine frame; tape: the tape's signal over it ({ events, cycles }: js/host/tape-sound.js TapeListener), or
  // null. The page's Sound switch (enabled) is the master: off, nothing is sent, the tape's voice included; Tape sound
  // only says whether the tape is mixed in.
  pushFrame(events, frameCycles, fps, tape = null) {
    if (!this.out || !this._enabled) return;
    this.out.push(events, frameCycles, fps, this.tapeSound ? tape : null);
  }
  // fast tape loading: `ms` of real time of the tape's voice (see js/ui/screen.js); nothing with Sound off
  pushTape(ms, tape) {
    if (!this.out || !this._enabled || !this.tapeSound) return;
    this.out.pushTape(ms, tape);
  }
  // how loud the tape's voice was in the last block played (0: silent); the page's tests read it
  get tapeLevel() { return this.out && this.out.tapeVoice ? this.out.tapeVoice.rms : 0; }
}

export { Audio, AudioOutput, PortSink, FADE_MS, MAX_MS };
