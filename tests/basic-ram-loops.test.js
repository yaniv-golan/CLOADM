// Run: node tests/basic-ram-loops.test.js
//
// The clean-room BASIC's speed by ram-pointers2's eight timing loops [BB 2026-11-26]: the whole case as the
// original ran it, each loop's count of fields the original's or up to two more, never fewer; and the mutant of
// FIN's wait for a digit after the point that must take a loop out of that (the mutants of its wait for a 0 are in
// tests/basic-ram-zero.test.js; tests/basic-ram.test.js says more).
const { check, tally, run, lines, caseText, REAL8, loopMutants } = require('./basic/basic-ram-lib.js');

// ---- as fast as the original and never faster (loops time games): ram-pointers2 itself, the whole case as the
// original ran it (what comes before its timing program counts: CLEAR 300 leaves the string loops more room, and a
// GOSUB's time depends on how many lines come before its target), against the original's counts
// (2026-11-26, docs/clean-room-basic.md section 2; each loop started just after a field begins): each of ours is
// the original's count or up to two fields more ----
{
  const REAL = REAL8;
  const r = run(caseText('ram-pointers2'));
  const t = lines(r).join(' ');
  check('ram-pointers2 runs to its end', r.status === 'ok', r.status);
  for (const [name, real] of Object.entries(REAL)) {
    const all = [...t.matchAll(new RegExp(`\\b${name} (\\d+)`, 'g'))], got = all.length ? +all[all.length - 1][1] : NaN; // (the last: the result lines, after the program's own text)
    check(`${name}: the original's ${real} fields, or up to 2 more, never fewer (ram-pointers2)`, got >= real && got <= real + 2, `${got}`);
  }
}
loopMutants([
  ['a digit after the point waits as one before it', 'SUBB    #FIDP', 'SUBB    #0'],
]);

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
