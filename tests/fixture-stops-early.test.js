// A suite that stops part-way and exits 0. This is the shape tests/all.js must NOT take for a pass, and it is
// deliberately not part of the gate: all.js leaves every fixture-*.test.js out of its file list, and
// tests/allsummary.test.js copies this file in under an ordinary name to prove the runner fails it.
//
// Why it exits 0: a promise that never settles keeps nothing alive, so once the first check has run Node finds the
// event loop empty and exits -- with the rest of the suite never having run and no summary printed. That is how a
// suite that leaves a promise pending "passes" on exit code alone.
// Run: node tests/fixture-stops-early.test.js   (exits 0, prints one check line and no summary)
console.log('ok   the first check ran');
(async () => {
  await new Promise(() => {});          // never settles: nothing after this line ever runs
  console.log('all passed');
})();
