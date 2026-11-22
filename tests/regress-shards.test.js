// tests/regress-shards.js: how regress.test.js splits its cases. Every recorded case is in exactly one shard for
// any shard count, the split is the same every time it is computed (each shard process computes it on its own),
// and it is balanced: no shard is over the average by more than its largest case (the greedy bound).
const { caseCost, assignShards } = require('./regress-shards.js');
const recorded = require('./regress-hashes.json');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const names = Object.keys(recorded);
check('there are recorded cases to split', names.length > 100, `${names.length}`);
for (const n of [1, 2, 3, 4, 5, 8]) {
  const split = assignShards(names, recorded, n);
  // a case the split leaves out (or puts in no valid shard) is named, not tripped over
  const per = Array.from({ length: n }, () => []);
  const missing = names.filter((k) => !(Number.isInteger(split.get(k)) && split.get(k) >= 0 && split.get(k) < n));
  for (const name of names) if (!missing.includes(name)) per[split.get(name)].push(name);
  const covered = per.reduce((s, p) => s + p.length, 0);
  check(`${n} shard(s): every case in exactly one shard`, !missing.length && split.size === names.length && covered === names.length,
    missing.length ? `not in a shard: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}` : '');
  check(`${n} shard(s): the same split when computed again`, names.every((k) => assignShards(names, recorded, n).get(k) === split.get(k)));
  const cost = per.map((p) => p.reduce((s, k) => s + caseCost(recorded[k]), 0));
  const avg = cost.reduce((a, b) => a + b, 0) / n, top = Math.max(...names.map((k) => caseCost(recorded[k])));
  check(`${n} shard(s): balanced (each within the largest case of the average)`, cost.every((c) => c <= avg + top + 1e-9), cost.map((c) => c.toFixed(0)).join(' '));
}
// a case with no recorded value yet (a new one) still gets a shard
const withNew = [...names, 'a new case'];
const s4 = assignShards(withNew, recorded, 4);
check('a new case (no recorded value) is in a shard too', Number.isInteger(s4.get('a new case')) && s4.size === withNew.length);
// the constants are measured (tools/measure-regress-cost.js); this pins the SHAPE and that they match the ones the
// tool measured, so a change to them is deliberate and shows here
check('cost: a trace by its instructions, a video run by its frames, else 1',
  Math.abs(caseCost({ instructions: 4e6 }) - 4e6 * 0.59e-6) < 1e-9
  && Math.abs(caseCost({ frames: 1000 }) - 1000 * 0.58e-3) < 1e-9
  && caseCost({ hash: 'x' }) === 1 && caseCost(undefined) === 1,
  `${caseCost({ instructions: 4e6 })} ${caseCost({ frames: 1000 })}`);
// and a 4-million-instruction trace must still outweigh a 1000-frame video run, as it did before: a big floppy
// trace is seconds, a short video run is under a second
check('cost: the order between a big trace and a short video run is unchanged',
  caseCost({ instructions: 4e6 }) > caseCost({ frames: 1000 }) * 3, `${caseCost({ instructions: 4e6 })} vs ${caseCost({ frames: 1000 })}`);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
