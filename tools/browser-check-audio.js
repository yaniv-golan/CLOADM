// The bounded catch-up check's classification of the records after a resume: which short blocks are the click
// the check exists to catch, and which are the worklet's specified, inaudible dip. Shared between the check
// (tools/browser-check.js, on the tap records the worklet posts, compacted to { n, primes, step }) and its
// tests (tests/audio-short.test.js, on the SAME shape built from a real SampleQueue in Node), so the two can
// never drift: every verdict below comes from this one function.
//
// The contract it implements (js/host/audio-worklet.js, SampleQueue's header):
//   "A dip that refills before the fade reaches 0 is not a gap: it fades back in as before, with no wait."
// A short block (fewer than 128 samples taken) is the worklet starting its underrun fade on a queue that ran
// dry mid-block. What makes it a click is the gap COMPLETING: the fade reaching 0, silence, a re-prime - and
// whether the samples stepped is the product's own no-pop bound. So the window after the restart FAILS on:
//   - a restart shallower than TARGET_MS (the re-prime did not hold);
//   - a short whose gap completes: a later record carries a higher `primes` count, the worklet's own record
//     of a fade that reached 0 and re-primed (a real gap, whatever the short count) - and the fade can
//     complete AFTER the window's last record, so `primes` is read to the end of ALL the records handed in,
//     not just the window: the caller passes the window plus the blocks up to the next mark, and a short at
//     the window's edge whose silence lands outside the slice is still a gap;
//   - a train: 2 or more short records in the window (the shallow restart hovers, short after short, while a
//     2% correction refills - the pathology this check was written for);
//   - and a single short record is accepted only when the samples played over the window step by LESS than
//     the no-pop bound (strictly less: the no-pop check fails a step AT the bound too, and this uses the
//     same comparison) - a dip is passed only when provably click-free by the product's own measure.
//
// The records are one shape in both places: { n: samples taken, primes: the queue's re-prime count after
// the block, step: the largest sample-to-sample step over the block's played samples }. The last record of
// the WINDOW carries endOfWindow: true (the caller marks it) so the window's shorts can be counted inside
// the larger array. `need` is the TARGET_MS depth less one quantum's rounding, `queued` the restart block's
// queue depth against it, `primes0` the restart block's primes count.

const TRAIN = 2;          // a train is 2 or more shorts in the window (the shallow restart never makes just one)
const POP_BOUND = 0.01;  // js/host/audio.js's no-pop bound: the largest step the whole stream may make anywhere

// classifyShort(records, { need, queued, primes0 }): records = the window's blocks (the last marked
// endOfWindow) FOLLOWED by the blocks up to the next mark, so the gap detection can see a fade completing
// past the window's edge. Returns { ok, verdict, short, primes0, primesLast, maxStep }:
//   ok       - the window passes (false = the check FAILs)
//   verdict  - 'clean' | 'dip' | 'train' | 'gap' | 'shallow' | 'pop' | 'empty' (the named reason)
//   short    - the number of short records in the window (evidence, printed either way)
//   maxStep  - the largest step over the window's played samples (the product's own click measure)
function classifyShort(records, { need, queued, primes0 } = {}) {
  if (!records.length) return { ok: false, verdict: 'empty', short: 0, primes0, primesLast: primes0, maxStep: 0 };
  const end = records.findIndex((b) => b.endOfWindow);
  const window = end >= 0 ? records.slice(0, end + 1) : records;
  const shorts = [];
  let maxStep = 0;
  for (const b of window) {
    if (b.n > 0 && b.n < 128) shorts.push(b);
    if (b.step !== undefined) maxStep = Math.max(maxStep, b.step);
  }
  // the gap: primes read to the END of all the records (past the window), so a fade completing after the
  // window's last block still counts - a short at the edge whose silence lands outside the slice is a gap
  const primesLast = records[records.length - 1].primes;
  const gapCompleted = primesLast > primes0;                    // the fade reached 0 somewhere: a real gap
  if (queued < need) return { ok: false, verdict: 'shallow', short: shorts.length, primes0, primesLast, maxStep };   // the restart did not hold
  if (gapCompleted) return { ok: false, verdict: 'gap', short: shorts.length, primes0, primesLast, maxStep };         // silence happened: the click risk
  if (shorts.length >= TRAIN) return { ok: false, verdict: 'train', short: shorts.length, primes0, primesLast, maxStep };
  if (!shorts.length) return { ok: true, verdict: 'clean', short: 0, primes0, primesLast, maxStep };
  // a single short, no gap: accepted only when the window's samples stepped less than the no-pop bound
  // (strictly less, the no-pop check's own comparison: a step AT the bound fails there and fails here)
  if (maxStep >= POP_BOUND) return { ok: false, verdict: 'pop', short: 1, primes0, primesLast, maxStep };
  return { ok: true, verdict: 'dip', short: 1, primes0, primesLast, maxStep };
}

module.exports = { classifyShort, TRAIN, POP_BOUND };
