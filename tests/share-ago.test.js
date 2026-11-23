// The Share screen's card says when the moment was captured relative to now (capturedAgo, js/ui/share.js): "captured
// just now" for the first minute, then minutes, hours and days ago, never a clock time. The page refreshes it while
// the screen is open (the browser check's share group reads it there).
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

(async () => {
  const { capturedAgo } = await import('../js/ui/share.js');
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0), s = 1000, min = 60 * s, h = 60 * min, d = 24 * h;
  for (const [after, want] of [
    [0, 'captured just now'], [59 * s, 'captured just now'],
    [60 * s, 'captured 1 minute ago'], [119 * s, 'captured 1 minute ago'], [2 * min, 'captured 2 minutes ago'], [59 * min + 59 * s, 'captured 59 minutes ago'],
    [h, 'captured 1 hour ago'], [3 * h + 5 * min, 'captured 3 hours ago'], [d - s, 'captured 23 hours ago'],
    [d, 'captured 1 day ago'], [10 * d, 'captured 10 days ago'],
    [-5 * s, 'captured just now'],   // a clock that moved back says "just now", never a negative time
  ]) check(`${after / 1000} s after: "${want}"`, capturedAgo(t0, t0 + after) === want, capturedAgo(t0, t0 + after));
  check('no clock time in any of them', ![0, min, h, d].some((a) => /\d:\d\d/.test(capturedAgo(t0, t0 + a))));
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
