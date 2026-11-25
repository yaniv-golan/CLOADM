// Run: node tests/state-split.test.js
//
// The state suite was split into state / state-fdc / state-carts / state-tape. This guard proves the split LOST
// nothing, and it does so WITHOUT running any of them: each of the four asserts, at its own end, that the checks it
// ran are exactly its slice of tests/state-check-names.json (the 234 names the unsplit suite ran), so this file only
// has to show that the four slices are a partition of that manifest.
//
// Why static: running the four here doubled the state work in every gate (about 49 s) on top of the four suites
// themselves, which is what made this suite the slowest thing in all.js. The per-suite assertion is the real proof;
// this is its bookkeeping half.
//
// Why names and not a count: a count lets a dropped check and a duplicated one cancel out and pass. The manifest has
// no duplicates, so a drop and a duplicate show up here as two wrong slices and in the suite that has them.
const fs = require('fs'), path = require('path');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const PARTS = ['state', 'state-fdc', 'state-carts', 'state-tape'];
// the checks the unsplit tests/state.test.js ran (its ok lines) when it was split, 224, plus every check added to a
// slice since, each also named in the manifest: the 6803's two port-2 checks, the Speech/Sound Pak's three
// mid-speech checks, the five printout checks and the six share-link moment checks (state.test.js)
const BEFORE = 224 + 2 + 3 + 5 + 6;

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-check-names.json'), 'utf8'));

check('the manifest names the four suites the split made', PARTS.every((p) => Array.isArray(manifest[p])), Object.keys(manifest).join(','));

const all = PARTS.flatMap((p) => manifest[p] || []);
const counts = Object.fromEntries(PARTS.map((p) => [p, (manifest[p] || []).length]));

check('the four slices add up to the unsplit suite exactly', all.length === BEFORE,
  `${PARTS.map((p) => `${p}=${counts[p]}`).join(' + ')} = ${all.length}, expected ${BEFORE}`);
// ONE uniqueness invariant, checked once: every name distinct across the whole manifest. It covers both faults the
// split could hide - the same check claimed by two suites (a name in two slices) and a duplicate inside one slice,
// which is the cancellation this manifest exists to catch (drop one, duplicate another, the total still reads 234).
// The detail names the slice, because that is what a reader needs to fix it.
const seen = new Set(), dupInSlice = [];
for (const p of PARTS) {
  const once = new Set();
  for (const n of manifest[p] || []) { if (once.has(n)) dupInSlice.push(`${p}: ${n}`); once.add(n); }
  for (const n of once) seen.add(n);
}
check('every name is distinct, across the four slices and within each (a drop plus a duplicate cannot cancel out)',
  seen.size === BEFORE,
  dupInSlice.length ? `repeated within a slice: ${dupInSlice.slice(0, 3).join(', ')}`
    : `${all.length} names, ${seen.size} distinct${all.length !== seen.size ? ' (a name is in two slices)' : ''}`);
check('every slice is non-empty (a slice emptied by accident is not a split)', PARTS.every((p) => counts[p] > 0), JSON.stringify(counts));

console.log(fail ? `\n${fail} FAILED` : '\nall state-split checks passed');
process.exitCode = fail ? 1 : 0;
