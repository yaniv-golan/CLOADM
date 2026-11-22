// How regress.test.js splits its cases into shards (--shard i/n): each case goes to exactly one shard, and the
// shards are about equal in cost, so the longest one, which decides how long the suite takes, is as short as it
// can be.
//
// A case's cost is estimated from its recorded value, which already says how much it runs: a trace records the
// instructions it executed, a video run the frames it drew. RECALIBRATED by measuring, not by guessing
// (tools/measure-regress-cost.js runs every case on its own and fits the times): on this machine a trace costs about
// 0.59 us per instruction and a video run about 0.58 ms per frame, with node startup (about 0.1 s) taken out. The
// constants before this were 2.5 us and 1.6 ms, roughly four and three times too high, so the balance put far too
// much weight on instruction count. The estimate only decides the balance; which cases run does not depend on it,
// and a case without a recorded value (a new one) counts as 1.
//
// Measured on this machine the balance barely moves: shard spreads came out 1.21x before and 1.19x after at 4
// shards (and slightly wider at 8), because the split is dominated by two floppy traces of 6.4 s and 5.2 s rather
// than by the slope. The constants are still the measured ones - the old ones over-weighted instruction count by
// ~4x - but do not expect this to shorten a shard on its own.
// Re-measure on a machine that differs a lot (the fit is per-machine): node tools/measure-regress-cost.js
// Re-measured 2026-11-22 with the tool (177 cases, one process each, startup 0.09 s taken out): trace 0.59 us per
// instruction (n=126), video 0.584 ms per frame (n=47) - within 0.7% of the constants below, so they did not move.
const TRACE_S = 0.59e-6;     // seconds per instruction of a trace case
const FRAME_S = 0.58e-3;     // seconds per frame of a video case
function caseCost(rec) {
  if (!rec) return 1;
  if (rec.instructions != null) return rec.instructions * TRACE_S;
  if (rec.frames != null) return rec.frames * FRAME_S;
  return 1;
}

// names: the cases in their order; recorded: name -> recorded value; n: the shard count. -> Map name -> shard.
// Largest first, each to the shard with the least so far (ties: the lower shard, the earlier case), so every
// shard process computes the same split.
function assignShards(names, recorded, n) {
  const order = names.map((name, i) => ({ name, i, cost: caseCost(recorded[name]) })).sort((a, b) => b.cost - a.cost || a.i - b.i);
  const load = new Array(n).fill(0), out = new Map();
  for (const c of order) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j;
    load[k] += c.cost;
    out.set(c.name, k);
  }
  return out;
}

module.exports = { caseCost, assignShards };
