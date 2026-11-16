// How regress.test.js splits its cases into shards (--shard i/n): each case goes to exactly one shard, and the
// shards are about equal in cost, so the longest one, which decides how long the suite takes, is as short as it
// can be.
//
// A case's cost is estimated from its recorded value, which already says how much it runs: a trace records the
// instructions it executed, a video run the frames it drew. Measured on a 4-core machine (regress unsharded,
// 134 cases, 178 s): a trace costs about 2 s plus 2.5 us per instruction (the floppy blank-disk traces, 8-9
// million instructions, take 17-20 s), a video run about 1.6 ms per frame, anything else about 1 s. The estimate
// only decides the balance; which cases run does not depend on it, and a case without a recorded value (a new
// one) counts as 1.
function caseCost(rec) {
  if (!rec) return 1;
  if (rec.instructions != null) return 2 + rec.instructions * 2.5e-6;
  if (rec.frames != null) return 0.3 + rec.frames * 1.6e-3;
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
