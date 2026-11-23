// The bounded catch-up check's short-block contract, tested on a real SampleQueue (js/host/audio-worklet.js) and
// classified by the check's OWN function (tools/browser-check-audio.js): the records below are built in the
// PAGE's own shape ({ n, primes, step } - what the check's evaluate posts per block), and every verdict comes
// from classifyShort - the same code the browser check runs, not a copy. Run: node tests/audio-short.test.js
const { SampleQueue, TARGET_MS } = require('../js/host/audio-worklet.js');
const { classifyShort, POP_BOUND } = require('../tools/browser-check-audio.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const QUANTUM = 128;
// the tap's record for one pull of a quantum, IN THE PAGE'S SHAPE: n, primes, and step (the largest
// sample-to-sample step over the block's played samples - computed here exactly as the check's evaluate
// computes it in the page, from the same samples the worklet played)
const tapOf = (q, time) => {
  const start = q.taken + q.dropped, primes = q.primes, queued = q.n, full = !q.priming && q.fade === q.fadeLen && q.n >= QUANTUM;
  const out = new Float32Array(QUANTUM);
  q.pull(out);
  let step = 0;
  for (let i = 1; i < QUANTUM; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
  return { n: q.taken - (start - q.dropped), step, primes, queued, full, time };
};
// run the page's schedule over the queue, clock-driven: the worklet pulls one quantum per 128/rate seconds,
// and a frame of rate/fps samples lands at the first quantum of each 20 ms beat (rAF). `stallFrom`..`+stallBeats-1`
// are the beats whose frames are held back (a stalled rAF); `landQuantum` is the quantum at which the held frames
// land - one quantum after the queue empties = mid-fade (the dip), four quanta later = the fade completed (the gap).
const run = (rate, { quanta = Math.round(2 * rate / QUANTUM), stallFrom = -1, stallBeats = 0, landQuantum = -1, primeMs, beatMs = 20, level = 0.5 } = {}) => {
  const q = new SampleQueue(rate, { primeMs });
  const frame = Math.round(rate * beatMs / 1000);
  // the restart depth: TARGET_MS queued before the schedule starts
  for (let t = 0; t < rate * TARGET_MS / 1000; t += frame) q.write(new Float32Array(frame).fill(level));
  const taps = [];
  const beatOf = (k) => Math.floor(k * QUANTUM / rate * 1000 / beatMs);
  for (let k = 0; k < quanta; k++) {
    const b = beatOf(k), prevB = k ? beatOf(k - 1) : -1;
    const crossed = b !== prevB && b > 0;                     // the clock entered beat b: its frame is due
    const held = b >= stallFrom && b < stallFrom + stallBeats;
    if (crossed && !held) q.write(new Float32Array(frame).fill(level));
    if (k === landQuantum) for (let f = 0; f < stallBeats; f++) q.write(new Float32Array(frame).fill(level));
    taps.push(tapOf(q, k * QUANTUM / rate));
  }
  return { taps, q };
};
// the check's caller half, in the check's own terms: the window is the second after the first playing block,
// the records run on to the NEXT MARK (the turbo mark on the page; the last tap here), and the window's last
// record is marked so the classifier can count the window's shorts inside the longer array - exactly the
// shape the check passes (the gap detection reads primes to the end, so a short at the window's edge whose
// fade completes after the slice is still a gap)
const classify = (taps, rate, windowEnd = null) => {
  const r = taps.findIndex((b) => b.n > 0);
  const last = taps.findIndex((b) => b.time >= taps[r].time + 1);
  const end = last < 0 ? taps.length : last;
  const records = taps.slice(r + 1).map((b, i, a) => ({ ...b, endOfWindow: i === Math.min(end, a.length) - 1 }));
  return classifyShort(records, { need: Math.floor(TARGET_MS / 1000 * rate) - QUANTUM, queued: taps[r].queued, primes0: taps[r].primes });
};

// ---- the ruled cases, each verdict FROM classifyShort (not re-derived here) ----
{
  const rate = 44100;

  // (1) a two-beat delivery stall with the held frames landing one quantum after the queue empties: ONE short
  // block, the backlog lands mid-fade (the next block's queued jumps to the held frames - the CI failure's own
  // queued:1765), no primes increase - the worklet's specified dip. The played fade steps 0.00226, inside the
  // no-pop bound. This is the exact shape of the CI failure the PM ruled on.
  {
    const { taps } = run(rate, { stallFrom: 20, stallBeats: 2, landQuantum: 145, primeMs: TARGET_MS });
    const v = classify(taps, rate);
    check('a two-beat stall, a single short, the backlog landing mid-fade: PASS (the specified dip)',
      v.ok === true && v.verdict === 'dip' && v.short === 1 && v.maxStep < POP_BOUND, JSON.stringify(v));
  }

  // (2) the same stall with the frames landing four quanta later: the fade completes, the gap is real (primes
  // increments, silence, a re-prime) - FAIL, whatever the short count
  {
    const { taps } = run(rate, { stallFrom: 20, stallBeats: 2, landQuantum: 148, primeMs: TARGET_MS });
    const v = classify(taps, rate);
    check('the same stall with the fade completed (a real gap, primes up): FAIL',
      v.ok === false && v.verdict === 'gap' && v.primesLast > v.primes0, JSON.stringify(v));
  }

  // (3) a shallow prime (primeMs 0): the restart hovers, short after short - the train the check was written
  // for. To see it, the queue must first drain (a pause), then resume one frame at a time with nothing priming.
  // The count, from the case's own numbers: the window is the SECOND AFTER THE FIRST PLAYING BLOCK, and
  // the first playing block is in the PAUSED drain phase (the queue still plays its 0.1 s backlog out),
  // so the window's first ~69 quanta are drain-phase quanta and only ~275 of its ~344 are resume quanta -
  // 39.3 of the resume's 50 20 ms beats. The hover makes ONE short per beat (the 882-sample frame feeds 6
  // full quanta, its 7th takes 114 = 882 - 768), so the window holds 40 shorts: 39 beats' worth plus the
  // drain's tail partial. The other ~10 of the 50 beats fall before the window's span, consumed by the
  // drain phase the window starts inside. (My first model of the same pathology showed 344 because it
  // pulled quanta on the audio clock alone - every quantum after a consumed frame ran short; the
  // verdict is the same either way, and the classifier's TRAIN rule, 2 or more, is what both trip.)
  {
    const q = new SampleQueue(rate, { primeMs: 0 });
    const frame = Math.round(rate * 20 / 1000);
    for (let t = 0; t < rate * 0.1; t += frame) q.write(new Float32Array(frame).fill(0.5));
    const taps = [];
    for (let k = 0; k < Math.round(rate * 0.2 / 128); k++) taps.push(tapOf(q, k * 128 / rate));   // the drain (paused)
    for (let b = 0; b < Math.round(rate); b += frame) {                                          // resume, one frame at a time
      q.write(new Float32Array(frame).fill(0.5));
      for (let k = 0; k < Math.round(rate / 128 * 20 / 1000); k++) taps.push(tapOf(q, taps.length * 128 / rate));
    }
    const v = classify(taps, rate);
    check('a shallow prime: the train of shorts: FAIL',
      v.ok === false && v.verdict === 'train' && v.short >= 2, JSON.stringify({ verdict: v.verdict, short: v.short }));
  }

  // (4) a single dip whose fade steps over the no-pop bound: accepted only when click-free, so FAIL.
  // The fade's own step is level / fadeLen a sample (the worklet's documented rule), so a LOUD level's
  // underrun fade steps over the 0.01 bound by itself: at 5.0 the step is 5/221 = 0.0226. NOTE: 5.0 is
  // a synthetic level, beyond what the page can deliver (the DAC's full scale is +-1, and the output
  // stage multiplies by volume 0.5, so a real underrun fade steps at most 0.5/221 = 0.00226 - inside
  // the bound, exactly what case (1) measures); the classifier's pop rule is tested here with a level
  // the page cannot reach because no page-reachable sample can build this shape - the rule's guard is
  // still real: anything that DOES step over the bound through a lone short fails, whatever made it.
  // A three-beat
  // stall with the held frames landing right after the short block (mid-fade, no gap - the same shape as
  // case 1) but at the loud level: the classifier must measure the played samples and catch it, not
  // accept the dip on its shape alone.
  {
    const q = new SampleQueue(rate, { primeMs: TARGET_MS });
    const frame = Math.round(rate * 20 / 1000);
    for (let t = 0; t < rate * TARGET_MS / 1000; t += frame) q.write(new Float32Array(frame).fill(5));   // loud
    const taps = [];
    for (let k = 0; k < 400; k++) {
      const b = Math.floor(k * QUANTUM / rate * 50), prevB = k ? Math.floor((k - 1) * QUANTUM / rate * 50) : -1;
      if (b !== prevB && b > 0 && !(b >= 10 && b <= 12)) q.write(new Float32Array(frame).fill(5));
      if (k === 77) for (let f = 0; f < 3; f++) q.write(new Float32Array(frame).fill(5));   // the rAF wakes mid-fade
      taps.push(tapOf(q, k * QUANTUM / rate));
    }
    const v = classify(taps, rate);
    check('a dip whose fade step exceeds the no-pop bound: FAIL',
      v.ok === false && v.verdict === 'pop' && v.maxStep >= POP_BOUND, JSON.stringify({ verdict: v.verdict, maxStep: v.maxStep }));
  }

  // (4b) THE PAGE'S OWN RECORD SHAPE, directly: the pop rule must fire on { n, primes, step } records with
  // no `out` anywhere - a lone short whose per-block step is 0.5 fails 'pop'. Built by hand, as the page
  // posts it (the check's evaluate computes exactly this step per block), with the short as the window's
  // LAST record (the marked one) and no gap after it. The classifier can never again be blind to a field
  // the page sends and the model does not.
  {
    const records = [];
    for (let i = 0; i < 342; i++) records.push({ n: 128, primes: 1, step: 0.0001 });
    records.push({ n: 100, primes: 1, step: 0.5, endOfWindow: true });   // the lone short, the window's last record
    records.push({ n: 128, primes: 1, step: 0.0001 });                  // past the window: no gap
    const v = classifyShort(records, { need: 1636, queued: 1921, primes0: 1 });
    check('the page\'s own record shape: a lone short with step 0.5 and no `out`: FAIL (pop)',
      v.ok === false && v.verdict === 'pop' && v.short === 1, JSON.stringify(v));
  }

  // (4c) the boundary: a step exactly AT the no-pop bound fails, as it fails in the no-pop check itself
  // (which rejects jump >= 0.01). The pop rule uses the same comparison, so 0.01 exactly is a pop.
  {
    const records = [];
    for (let i = 0; i < 342; i++) records.push({ n: 128, primes: 1, step: 0.0001 });
    records.push({ n: 100, primes: 1, step: POP_BOUND, endOfWindow: true });   // exactly at the bound, the window's last record
    records.push({ n: 128, primes: 1, step: 0.0001 });
    const v = classifyShort(records, { need: 1636, queued: 1921, primes0: 1 });
    check('a step exactly at the no-pop bound: FAIL (the no-pop check\'s own comparison)',
      v.ok === false && v.verdict === 'pop' && v.maxStep === POP_BOUND, JSON.stringify(v));
  }

  // (5) a restart shallower than TARGET_MS, with no train: the re-prime released early (the wait
  // timeout - a lone frame queued - instead of the depth), so the first playing block starts at 882
  // samples, below need (1636). The delivery after it is healthy (at most one short in the window),
  // so the train rule cannot be what catches it: only the depth requirement does, and the classifier
  // must say 'shallow'. (The real worklet reaches its wait timeout only with something queued for
  // twice TARGET_MS of played silence; a queue that released there - or on a depth a broken prime
  // miscalculated - restarts shallow, and the shallow start's own drain-out is a later gap: the
  // shallow verdict fires first, naming the restart itself.)
  {
    const q = new SampleQueue(rate);                  // the default prime: the depth the check requires
    const frame = Math.round(rate * 20 / 1000);
    q.write(new Float32Array(frame).fill(0.5));       // one frame: 882 queued, below the prime depth
    const taps = [];
    for (let k = 0; k < 40; k++) taps.push(tapOf(q, k * QUANTUM / rate));   // the wait: silence, then the timeout release
    for (let b = 0; b < Math.round(rate); b += frame) {                     // healthy delivery after the shallow start
      if (b > 0) q.write(new Float32Array(frame).fill(0.5));
      for (let k = 0; k < Math.round(rate / QUANTUM * 20 / 1000); k++) taps.push(tapOf(q, taps.length * QUANTUM / rate));
    }
    const v = classify(taps, rate);
    check('a restart shallower than TARGET_MS, no train: FAIL (the re-prime did not hold)',
      v.ok === false && v.verdict === 'shallow' && v.short <= 1, JSON.stringify(v));
  }

  // (5b) the window's edge: a lone short among the LAST records of the window, whose fade completes AFTER
  // the window ends (the primes++ lands outside the slice, three blocks past its last). The classifier
  // reads primes to the end of the records the caller hands it - the page hands the blocks up to the
  // turbo mark - so this is a gap, not a dip. Built on a real queue: the page's frames stop ~14 quanta
  // (60 ms of queue) before the window's end, so the queue empties at its very last block (the short at
  // k=344, the window's final record) and the fade runs out at k=347 - outside the window, inside the
  // records. Under the old window-only primes read this was 'dip'; it must be 'gap'.
  {
    const q = new SampleQueue(rate, { primeMs: TARGET_MS });
    const frame = Math.round(rate * 20 / 1000);
    for (let t = 0; t < rate * TARGET_MS / 1000; t += frame) q.write(new Float32Array(frame).fill(0.5));
    const taps = [];
    for (let k = 0; k < 362; k++) {
      const b = Math.floor(k * QUANTUM / rate * 50), prevB = k ? Math.floor((k - 1) * QUANTUM / rate * 50) : -1;
      if (b !== prevB && k < 330) q.write(new Float32Array(frame).fill(0.5));   // the frames stop: the queue drains to the window's edge
      taps.push(tapOf(q, k * QUANTUM / rate));
    }
    const v = classify(taps, rate);
    check('a short at the window\'s edge whose gap completes after it: FAIL (gap), not a dip',
      v.ok === false && v.verdict === 'gap' && v.short === 1 && v.primesLast > v.primes0, JSON.stringify({ verdict: v.verdict, short: v.short, primes0: v.primes0, primesLast: v.primesLast }));
  }

  // the clean baseline: no stall at all
  {
    const { taps } = run(rate, { primeMs: TARGET_MS });
    const v = classify(taps, rate);
    check('no stall: clean (no short blocks)', v.ok === true && v.verdict === 'clean' && v.short === 0, JSON.stringify(v));
  }
}

console.log(fail ? `${fail} FAILED` : 'all audio-short checks passed');
process.exitCode = fail ? 1 : 0;
