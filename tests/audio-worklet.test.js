// The sound's way to the audio thread (js/host/audio-worklet.js SampleQueue and its processor, js/host/audio.js
// PortSink), browser-free. Every expected value below is worked out by hand from the rules in audio-worklet.js:
// samples come out in the order written; on underrun the last sample fades to 0 over FADE_MS (a gain step of
// 1 / (rate * FADE_MS / 1000) a sample) and then the output is exactly 0, never an old sample again; a full queue
// drops its OLDEST samples; at full gain the output is the samples themselves.
const { pathToFileURL } = require('url');
const path = require('path');
const { SampleQueue, CAPACITY_MS } = require('../js/host/audio-worklet.js');
const { PortSink, AudioOutput, MAX_MS } = require('../js/host/audio.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const pull = (q, n) => { const b = new Float32Array(n); q.pull(b); return [...b]; };
const f32 = (a) => a.map(Math.fround);
const same = (a, b, tol = 0) => a.length === b.length && a.every((v, i) => (tol ? Math.abs(v - b[i]) <= tol : Object.is(v, b[i])));

// rate 200: FADE_MS = 5 is one sample, so the gain goes 0 -> 1 on the first sample and 1 -> 0 on the first missing one
{
  const q = new SampleQueue(200);
  q.write(new Float32Array([0.1, 0.2, 0.3])); q.write(new Float32Array([0.4, 0.5]));
  const out = pull(q, 7);
  check('in order, then silence on underrun (no repeat of the last sample)', same(out, f32([0.1, 0.2, 0.3, 0.4, 0.5, 0, 0])), JSON.stringify(out));
  check('the counters: 5 taken, none dropped, none queued', q.taken === 5 && q.dropped === 0 && q.buffered() === 0);
  check('still silent with nothing written', same(pull(q, 3), [0, 0, 0]));
}
// rate 1000: the fade is 5 samples, a step of 0.2
{
  const q = new SampleQueue(1000);
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
  const q = new SampleQueue(200, 4);
  q.write(new Float32Array([1, 2, 3])); q.write(new Float32Array([4, 5, 6]));
  check('overrun drops the oldest: 1 and 2 go, 3..6 stay', q.dropped === 2 && q.buffered() === 4 && same(pull(q, 4), [3, 4, 5, 6]), `dropped ${q.dropped}`);
  check('taken + dropped is the index of the next sample (6)', q.taken + q.dropped === 6);
  const r = new SampleQueue(200, 4);
  r.write(new Float32Array([1, 2])); r.write(new Float32Array([3, 4, 5, 6, 7]));
  check('a chunk bigger than the queue: everything older and its own oldest sample go', r.dropped === 3 && same(pull(r, 4), [4, 5, 6, 7]), `dropped ${r.dropped}`);
  const w = new SampleQueue(200, 4);
  w.write(new Float32Array([1, 2, 3]));
  const a = pull(w, 2);
  w.write(new Float32Array([4, 5, 6]));                  // wraps around the end of the buffer
  check('order is kept across the wrap of the buffer', same(a, [1, 2]) && same(pull(w, 4), [3, 4, 5, 6]) && w.dropped === 0);
  check(`the default capacity is CAPACITY_MS (${CAPACITY_MS} ms, twice MAX_MS ${MAX_MS})`, new SampleQueue(44100).capacity === 13230 && new SampleQueue(48000).capacity === 14400 && CAPACITY_MS === 2 * MAX_MS);
}
// at full gain, the output is the samples, value for value, whatever the chunk and block sizes
{
  const q = new SampleQueue(48000);
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
  // taken + dropped every 4 blocks, and with the tap on posts each block with its index, count and full flag
  {
    const posted = [];
    let proc = null;
    globalThis.sampleRate = 1000;                        // a 5-sample fade, as above; the queue holds 300
    globalThis.currentTime = 1.5;
    globalThis.currentFrame = 1500;
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } };
    globalThis.registerProcessor = (name, P) => { proc = { name, P }; };
    await import(pathToFileURL(path.join(__dirname, '../js/host/audio-worklet.js')).href + '?processor');
    check('the module registers the processor as cloadm-output', proc && proc.name === 'cloadm-output');
    const p = new proc.P();
    const block = () => { const o = [new Float32Array(128), new Float32Array(128)]; const keep = p.process([], [o]); return { o, keep }; };
    p.port.onmessage({ data: { tap: true } });
    p.port.onmessage({ data: { samples: new Float32Array(200).map((_, i) => i / 256) } });
    const b1 = block();
    const v = (i) => Math.fround(i / 256);
    const fadeIn = Array.from({ length: 128 }, (_, i) => (i < 4 ? Math.fround(v(i) * (i + 1) / 5) : v(i)));
    check('a block: the first 128 samples (the first 4 fading in), in both channels; the processor stays alive',
      b1.keep === true && same([...b1.o[0]], fadeIn) && same([...b1.o[1]], [...b1.o[0]]), JSON.stringify([...b1.o[0]].slice(0, 6)));
    const t1 = posted.shift().tap;
    check('tap: index 0, 128 taken, not full (it faded in), its currentTime', t1.start === 0 && t1.n === 128 && t1.full === false && t1.time === 1.5 && same([...t1.out], [...b1.o[0]]));
    const b2 = block(), t2 = posted.shift().tap;
    const left = [...Array.from({ length: 72 }, (_, i) => v(128 + i)), ...[4, 3, 2, 1].map((k) => Math.fround(v(199) * k / 5)), ...new Array(52).fill(0)];
    check('tap: the next block takes the 72 left from index 128 at full gain, fades the last out over 5 samples, then exact 0; not full',
      t2.start === 128 && t2.n === 72 && t2.full === false && same([...b2.o[0]], left), JSON.stringify([...b2.o[0]].slice(70, 78)));
    p.port.onmessage({ data: { samples: new Float32Array(300).fill(0.5) } });
    block(); posted.shift();                             // (fade-in block)
    const b4 = block(), msgs = posted.splice(0);
    const t4 = msgs.find((m) => m.tap).tap, rep = msgs.find((m) => m.removed !== undefined);
    check('tap: a block of queued samples at full gain is full, and is the samples', t4.full === true && t4.start === 328 && t4.n === 128 && [...b4.o[0]].every((v) => v === 0.5));
    check('after 4 blocks it reports taken + dropped, as of the end of the block', rep && rep.removed === 456 && rep.frame === 1628, JSON.stringify(rep));
    p.port.onmessage({ data: { tap: false } });
    block();
    check('tap off: nothing posted but the reports', posted.length === 0);
    // overrun in the processor: 350 samples into a 300-sample queue drop the 50 oldest; the report counts them, so
    // the page's count of what is queued (written less removed) comes back to 0 once it has all played
    const p2 = new proc.P();
    p2.port.onmessage({ data: { samples: new Float32Array(350).map((_, i) => i) } });
    const first = [];
    for (let i = 0; i < 4; i++) { const o = [new Float32Array(128)]; p2.process([], [o]); if (!i) first.push(...o[0].slice(5, 8)); }
    const r2 = posted.splice(0).find((m) => m.removed !== undefined);
    check('processor overrun: the oldest go (it starts at sample 50), and the report counts taken + dropped (300 + 50)',
      same(first, [55, 56, 57]) && r2 && r2.removed === 350, JSON.stringify({ first, r2 }));
  }
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
