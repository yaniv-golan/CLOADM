// Run: node tests/basic-ram-cloadm.test.js
//
// The clean-room BASIC's speed by bb8 cas-cloadm2's two PEEK loops [BB 2026-11-26]: the case as typed, loops A and B
// never faster than the original's record and at most 1% slower, and mutants of FIN's wait for a digit (fpconv.inc)
// that must each take a loop out of that (tests/basic-ram.test.js says more).
const { check, tally, built, real, caseText, mutant, runCase } = require('./basic/basic-ram-lib.js');

// ---- bb8 cas-cloadm2's two PEEK loops: never faster than the original, and at most 1% slower [BB 2026-11-26] ----
// The case as typed, against the original's record. Loop A (`FOR I=0 TO 1022:P=PEEK(I AND 32767):IF P=112 OR
// P=114 ...`, RUN after each CLOADM "MCX"): from the S a CLOADM shows on the top row (its search) to the screen the
// next CLOADM clears, which holds the load, loop A's 1023 passes, a six-pass PEEK loop and lines typed. Loop B (`S=0:FOR
// I=0 TO 599:S=S+PEEK(28928+I AND 32767):NEXT`): from BIGMC's last block (its last top-row flag) to the case's end,
// which holds loop B's 600 passes, NEW, three lines and RUN (a CLOADM and a SKIPF whose motor runs match the
// original's). The typist is paced alike on both, so these spans differ by what the machine runs; without FIN's
// wait for each digit (FPNX10: the original's time for a digit, by the number so far and the digit's bits, bb10
// time-literals) ours took 326 fields less in each of A's spans and 186 less in B's.
{
  const want = real('bb8-real.jsonl', 'cas-cloadm2'), text = caseText('cas-cloadm2');
  const spans = (r) => {
    const s = r.flags.filter((f) => f.row === 's').map((f) => f.frame), c = r.clears.map((x) => x.frame);
    return { A1: c[1] - s[0], A2: c[2] - s[1], B: r.frames - r.flags[r.flags.length - 1].frame };
  };
  const w = spans(want);
  const judge = (rom) => { const r = runCase(rom, text); return r.status === 'ok' && r.clears && r.clears.length === 3 ? spans(r) : null; };
  const within = (g) => g && Object.keys(w).every((k) => g[k] >= w[k] && g[k] <= w[k] * 1.01);
  const g = judge(built.rom);
  check('cas-cloadm2: loops A and B take the original\'s time or up to 1% more (fields)', within(g), JSON.stringify({ ours: g, original: w }));
  for (const [what, ...ft] of [
    ['a digit waits a tenth less', '        LDB     #FIDLY\nFPW1', '        LDB     #FIDLY*9/10\nFPW1'],
    ['a digit waits a tenth more', '        LDB     #FIDLY\nFPW1', '        LDB     #FIDLY*11/10\nFPW1'],
    // (the conversion's wait as it was before bb12 is not among these: it moves cas-cloadm2's B by two fields, which the
    // layout alone moves by as much (2419 or 2420 against at most 2419.96), so it is pinned where it shows by more:
    // tests/basic-timing-loopb.test.js, bb12 time-loopb's loop B 578 against at most 577)
  ]) {
    const m = judge(mutant(...ft));
    check(`cas-cloadm2 mutant "${what}": outside the original's time .. +1%`, !within(m), JSON.stringify(m));
  }
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
