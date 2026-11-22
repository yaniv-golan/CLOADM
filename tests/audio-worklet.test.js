// The sound's way to the audio thread (js/host/audio-worklet.js SampleQueue and its processor, js/host/audio.js
// PortSink), browser-free. Every expected value below is worked out by hand from the rules in audio-worklet.js:
// samples come out in the order written; on underrun the last sample fades to 0 over FADE_MS (a gain step of
// 1 / (rate * FADE_MS / 1000) a sample) and then the output is exactly 0, never an old sample again; a full queue
// drops its OLDEST samples; at full gain the output is the samples themselves. The queues of the first four blocks
// are made with primeMs 0 (no re-prime after a gap), so they test those rules alone; the re-prime has its own block.
const { pathToFileURL } = require('url');
const path = require('path');
const { SampleQueue, CAPACITY_MS } = require('../js/host/audio-worklet.js');
const { PortSink, AudioOutput, SKIP_MS } = require('../js/host/audio.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const pull = (q, n) => { const b = new Float32Array(n); q.pull(b); return [...b]; };
const f32 = (a) => a.map(Math.fround);
const same = (a, b, tol = 0) => a.length === b.length && a.every((v, i) => (tol ? Math.abs(v - b[i]) <= tol : Object.is(v, b[i])));

// rate 200: FADE_MS = 5 is one sample, so the gain goes 0 -> 1 on the first sample and 1 -> 0 on the first missing one
{
  const q = new SampleQueue(200, { primeMs: 0 });
  q.write(new Float32Array([0.1, 0.2, 0.3])); q.write(new Float32Array([0.4, 0.5]));
  const out = pull(q, 7);
  check('in order, then silence on underrun (no repeat of the last sample)', same(out, f32([0.1, 0.2, 0.3, 0.4, 0.5, 0, 0])), JSON.stringify(out));
  check('the counters: 5 taken, none dropped, none queued', q.taken === 5 && q.dropped === 0 && q.buffered() === 0);
  check('still silent with nothing written', same(pull(q, 3), [0, 0, 0]));
}
// rate 1000: the fade is 5 samples, a step of 0.2
{
  const q = new SampleQueue(1000, { primeMs: 0 });
  q.write(new Float32Array(8).fill(1));
  const out = pull(q, 15);
  check('fades in over 5 samples, plays, fades out over 4 more to exact 0', same(out, [0.2, 0.4, 0.6, 0.8, 1, 1, 1, 1, 0.8, 0.6, 0.4, 0.2, 0, 0, 0], 1e-6), JSON.stringify(out));
  check('...ending at exact 0', out.slice(12).every((v) => v === 0));
  q.write(new Float32Array([0.5, 0.5]));
  const back = pull(q, 5);
  check('samples coming back fade in from 0; running dry again fades from where the gain got to', same(back, [0.1, 0.2, 0.1, 0, 0], 1e-6), JSON.stringify(back));
}
// a bounded queue: capacity 4, writes past it drop the oldest
{
  const q = new SampleQueue(200, { capacity: 4, primeMs: 0 });
  q.write(new Float32Array([1, 2, 3])); q.write(new Float32Array([4, 5, 6]));
  check('overrun drops the oldest: 1 and 2 go, 3..6 stay', q.dropped === 2 && q.buffered() === 4 && same(pull(q, 4), [3, 4, 5, 6]), `dropped ${q.dropped}`);
  check('taken + dropped is the index of the next sample (6)', q.taken + q.dropped === 6);
  const r = new SampleQueue(200, { capacity: 4, primeMs: 0 });
  r.write(new Float32Array([1, 2])); r.write(new Float32Array([3, 4, 5, 6, 7]));
  check('a chunk bigger than the queue: everything older and its own oldest sample go', r.dropped === 3 && same(pull(r, 4), [4, 5, 6, 7]), `dropped ${r.dropped}`);
  const w = new SampleQueue(200, { capacity: 4, primeMs: 0 });
  w.write(new Float32Array([1, 2, 3]));
  const a = pull(w, 2);
  w.write(new Float32Array([4, 5, 6]));                  // wraps around the end of the buffer
  check('order is kept across the wrap of the buffer', same(a, [1, 2]) && same(pull(w, 4), [3, 4, 5, 6]) && w.dropped === 0);
  // the deepest the page makes it is SKIP_MS plus the 4 frames one page tick can push at 30 fps (133 ms)
  check(`the default capacity is CAPACITY_MS (${CAPACITY_MS} ms, more than SKIP_MS ${SKIP_MS} + 4 frames at 30 fps)`, new SampleQueue(44100).capacity === 13230 && new SampleQueue(48000).capacity === 14400 && CAPACITY_MS > SKIP_MS + 4000 / 30);
}
// at full gain, the output is the samples, value for value, whatever the chunk and block sizes
{
  const q = new SampleQueue(48000, { primeMs: 0 });
  let x = 12345;
  const rnd = () => { x = (x * 1103515245 + 12345) >>> 0; return x / 2 ** 32; };
  const written = [], played = [];
  q.write(new Float32Array(400).fill(0)); written.push(...new Float32Array(400));
  pull(q, 300).forEach((v) => played.push(v));          // past the 240-sample fade-in
  for (let i = 0; i < 200; i++) {
    const c = new Float32Array(1 + Math.floor(rnd() * 900)).map(() => rnd() * 2 - 1);
    q.write(c); written.push(...c);
    while (q.buffered() > 128) played.push(...pull(q, 128));
  }
  const tail = played.slice(300);
  check('at full gain the output equals the samples written, in order (tolerance 0)', tail.length > 50000 && same(tail, written.slice(300, 300 + tail.length)), `${tail.length} samples`);
}

// the re-prime (the shallow half of the bounded catch-up): rate 1000 and primeMs 10, so the queue waits for 10
// samples; the fade is 5 samples, a step of 0.2
{
  const q = new SampleQueue(1000, { primeMs: 10 });
  check('re-prime: a new queue is priming', q.priming === true);
  q.write(new Float32Array(6).fill(1));
  const a = pull(q, 4);
  check('re-prime: 6 queued of 10 is not enough: silence, nothing taken', same(a, [0, 0, 0, 0]) && q.taken === 0 && q.buffered() === 6, JSON.stringify(a));
  q.write(new Float32Array(4).fill(1));
  const b = pull(q, 12);
  check('re-prime: at 10 queued it plays at once, fading in, then fades out on running dry',
    same(b, [0.2, 0.4, 0.6, 0.8, 1, 1, 1, 1, 1, 1, 0.8, 0.6], 1e-6) && q.taken === 10, JSON.stringify(b));
  // the fade not yet at 0 (0.6): samples back now are a dip, not a gap: they play at once, fading back in
  q.write(new Float32Array([1, 1]));
  const c = pull(q, 2);
  check('re-prime: a dip that refills before the fade reaches 0 resumes with no wait', same(c, [0.8, 1], 1e-6) && q.primes === 0, JSON.stringify(c));
  pull(q, 6);
  check('re-prime: running dry until the fade reaches 0 is a gap: priming again, counted', q.priming === true && q.primes === 1);
  // a lone 3-sample chunk: never reaches 10, so it plays after waiting twice primeMs (20 samples) with it queued
  q.write(new Float32Array([1, 1, 1]));
  const d = pull(q, 23);
  check('re-prime: a lone short chunk is not held forever: it plays on the 20th sample waited (2 x primeMs) with it queued',
    same(d, [...new Array(19).fill(0), 0.2, 0.4, 0.6, 0.4], 1e-6) && q.taken === 15, JSON.stringify(d));
  const z = new SampleQueue(1000, { primeMs: 0 });
  z.write(new Float32Array([1])); 
  check('re-prime: primeMs 0 never waits', same(pull(z, 1), [0.2], 1e-6) && z.priming === false);
}

(async () => {
  // PortSink: a chunk goes through a real MessagePort, transferred (the sender's copy is detached), values intact;
  // buffered() is what was written less the last report's removed, less the frames the clock moved on since it
  {
    const { port1, port2 } = new MessageChannel();
    let frame = 0;
    const sink = new PortSink(port1, () => frame);
    const got = [];
    port2.onmessage = (e) => got.push(e.data.samples);
    const c = new Float32Array([0.25, -0.5, 0.75]);
    sink.write(c);
    sink.write(new Float32Array([1, 2]));
    await new Promise((r) => setTimeout(r, 20));
    check('PortSink: chunks arrive in order with their values; the sender\'s copy is transferred, not copied',
      got.length === 2 && same([...got[0]], [0.25, -0.5, 0.75]) && same([...got[1]], [1, 2]) && c.length === 0 && c.buffer.byteLength === 0);
    check('PortSink: buffered() counts everything written until the processor reports', sink.buffered() === 5);
    port2.postMessage({ removed: 4, frame: 0 });
    await new Promise((r) => setTimeout(r, 20));
    check('PortSink: buffered() drops by what the processor took or dropped', sink.buffered() === 1);
    for (let i = 0; i < 6; i++) sink.write(new Float32Array(10));                  // 65 written, 4 removed at frame 0
    frame = 20;
    check('PortSink: the frames played since the report count as gone (65 - 4 - 20)', sink.buffered() === 41, `${sink.buffered()}`);
    port2.postMessage({ removed: 30, frame: 25 });
    await new Promise((r) => setTimeout(r, 20));
    check('PortSink: a new report replaces the old one (65 - 30 - 0, the clock behind its frame counts as 0)', sink.buffered() === 35, `${sink.buffered()}`);
    frame = 100;
    check('PortSink: never below 0 by the clock', sink.buffered() === 0);
    port2.postMessage({ removed: 99, frame: 100 });
    await new Promise((r) => setTimeout(r, 20));
    check('PortSink: never below 0', sink.buffered() === 0);
    // AudioOutput writes each frame as one chunk to its sink, and steers by the sink's count
    const out = new AudioOutput(44100, sink);
    out.push([0, 0.5], 17784, 49.96766756635178);
    await new Promise((r) => setTimeout(r, 20));
    check('AudioOutput: a frame goes to its sink as one chunk of rate / fps samples', got.length === 9 && got[8].length === 882 && sink.written === 947, `${got[8] && got[8].length}`);
    port1.close(); port2.close();
    // before the processor's first report the count starts from the clock when the sink was made (the context has
    // been running a while: its age is not samples played): made at frame 5000, 30 written, at 5010 there are 20
    const c2 = new MessageChannel();
    let f2 = 5000;
    const early = new PortSink(c2.port1, () => f2);
    early.write(new Float32Array(30)); f2 = 5010;
    check('PortSink: before the first report it counts from the clock when it was made (30 - 10)', early.buffered() === 20, `${early.buffered()}`);
    c2.port1.close(); c2.port2.close();
  }
  // the processor, with the worklet's globals stood in: it plays its queue into every channel of its output, reports
  // taken + dropped every 4 blocks, and with the tap on posts each block with its index, count, full flag, depth and
  // re-prime counts. sampleRate 8000: the fade is 40 samples, the re-prime TARGET_MS (40 ms) 320, the queue 2400.
  {
    const posted = [];
    let proc = null;
    globalThis.sampleRate = 8000;
    globalThis.currentTime = 1.5;
    globalThis.currentFrame = 1500;
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } };
    globalThis.registerProcessor = (name, P) => { proc = { name, P }; };
    await import(pathToFileURL(path.join(__dirname, '../js/host/audio-worklet.js')).href + '?processor');
    check('the module registers the processor as cloadm-output', proc && proc.name === 'cloadm-output');
    const p = new proc.P();
    const block = () => { const o = [new Float32Array(128), new Float32Array(128)]; const keep = p.process([], [o]); return { o, keep }; };
    const v = (i) => Math.fround(i / 512);
    p.port.onmessage({ data: { tap: true } });
    // 400 samples at once into a new (priming) queue: more than the 320 it waits for, so it plays at once, fading in
    p.port.onmessage({ data: { samples: new Float32Array(400).map((_, i) => i / 512) } });
    const b1 = block();
    const fadeIn = Array.from({ length: 128 }, (_, i) => (i < 39 ? Math.fround(v(i) * (i + 1) / 40) : v(i)));
    check('a block: 400 queued at once (more than the 320 it waits for) play at once, fading in over 40, in both channels; the processor stays alive',
      b1.keep === true && same([...b1.o[0]], fadeIn) && same([...b1.o[1]], [...b1.o[0]]), JSON.stringify([...b1.o[0]].slice(0, 3)));
    const t1 = posted.shift().tap;
    check('tap: index 0, 128 taken, not full (priming as it began), its currentTime, 400 queued, no re-prime yet',
      t1.start === 0 && t1.n === 128 && t1.full === false && t1.time === 1.5 && t1.queued === 400 && t1.primes === 0 && same([...t1.out], [...b1.o[0]]), JSON.stringify({ ...t1, out: undefined }));
    const b2 = block(), t2 = posted.shift().tap;
    check('tap: the next block is full and is the samples 128..255',
      t2.start === 128 && t2.n === 128 && t2.full === true && t2.queued === 272 && same([...b2.o[0]], Array.from({ length: 128 }, (_, i) => v(128 + i))), JSON.stringify({ ...t2, out: undefined }));
    block(); posted.shift();                             // 256..383, full
    const b4 = block(), msgs = posted.splice(0);
    const t4 = msgs.find((m) => m.tap).tap, rep = msgs.find((m) => m.removed !== undefined);
    const tail = [...Array.from({ length: 16 }, (_, i) => v(384 + i)), ...Array.from({ length: 40 }, (_, j) => Math.fround(v(399) * (39 - j) / 40)), ...new Array(72).fill(0)];
    check('tap: the last 16, then a 40-sample fade to exact 0, which is a gap: priming again (counted)',
      t4.start === 384 && t4.n === 16 && t4.full === false && same([...b4.o[0]], tail) && p.q.priming === true && p.q.primes === 1, JSON.stringify([...b4.o[0]].slice(14, 18)));
    check('after 4 blocks it reports taken + dropped (400), as of the end of the block', rep && rep.removed === 400 && rep.frame === 1628, JSON.stringify(rep));
    // priming: 100 queued (< 320) is held, silent, until it has waited 640 samples (2 x 320) with something queued
    p.port.onmessage({ data: { samples: new Float32Array(100).fill(0.5) } });
    const held = [block(), block(), block(), block()].flatMap((b) => [...b.o[0]]);
    const t56 = posted.splice(0).filter((m) => m.tap).map((m) => m.tap);
    check('re-prime: a short chunk after a gap is held in silence (nothing taken) while it waits', held.every((x) => x === 0) && t56.every((t) => t.n === 0 && t.queued === 100), JSON.stringify(t56.map((t) => [t.n, t.queued])));
    const b7 = block(), t7 = posted.splice(0).find((m) => m.tap).tap;
    // waited 512 in the four blocks; this one's index 127 is the 640th waited: it plays from there (1 taken)
    check('re-prime: ... and plays once it has waited 640 samples (at the last index of the fifth block), fading in',
      b7.o[0][126] === 0 && b7.o[0][127] === Math.fround(0.5 / 40) && t7.n === 1, JSON.stringify({ at: [...b7.o[0]].slice(125), n: t7.n }));
    p.port.onmessage({ data: { tap: false } });
    block();
    check('tap off: nothing posted but the reports', posted.every((m) => m.removed !== undefined));
    posted.length = 0;
    // overrun in the processor: 2500 samples into a 2400-sample queue drop the 100 oldest; the report counts them
    // (taken 512 + dropped 100), so the page's count of what is queued (written less removed) stays right
    const p2 = new proc.P();
    p2.port.onmessage({ data: { samples: new Float32Array(2500).map((_, i) => i) } });
    const first = [];
    for (let i = 0; i < 4; i++) { const o = [new Float32Array(128)]; p2.process([], [o]); if (!i) first.push(...o[0].slice(45, 48)); }
    const r2 = posted.splice(0).find((m) => m.removed !== undefined);
    check('processor overrun: the oldest go (it starts at sample 100), and the report counts taken + dropped (512 + 100)',
      same(first, [145, 146, 147]) && r2 && r2.removed === 612 && p2.q.dropped === 100, JSON.stringify({ first, r2 }));
  }
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
