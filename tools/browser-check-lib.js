// The browser check's bookkeeping, without Playwright: which groups run, each group run in isolation, every
// check, wait timeout, skip and group error counted, and the summary and exit code that follow from them.
// tools/browser-check.js uses it; tests/browser-check-lib.test.js tests it with fake groups and fake pages.
//
// The rules (docs/development.md, "Browser check"):
// * --only g1,g2 names groups; a name that is not a group, or an empty list, is a usage error (exit 2) that lists
//   the valid groups. Nothing runs.
// * Each group runs on its own: an error thrown in one is that group's FAIL (with the stack), and the next group
//   still runs.
// * A wait that times out is a FAIL where it happened, unless the call says it is optional and why.
// * A check that cannot run here (the NitrOS-9 release images when they are not cached) is a SKIP, counted in the
//   summary, never silent.
// * Exit code: 0 only if every selected group ran and passed, 1 if any check, wait or group failed, 2 on a usage
//   error.
const path = require('path');

// argv -> { only: [names] | null, error: string | null }
function parseOnly(argv, groupNames) {
  const valid = `valid groups: ${groupNames.join(', ')}`;
  const at = argv.map((a, k) => (a === '--only' || a.startsWith('--only=') ? k : -1)).filter((k) => k >= 0);
  if (!at.length) return { only: null, error: null };
  if (at.length > 1) return { only: null, error: `--only given more than once; ${valid}` };
  const i = at[0];
  const raw = argv[i].startsWith('--only=') ? argv[i].slice(7) : argv[i + 1];
  const list = raw === undefined || raw.startsWith('--') ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { only: null, error: `--only needs a comma-separated list of groups; ${valid}` };
  const unknown = list.filter((n) => !groupNames.includes(n));
  if (unknown.length) return { only: null, error: `--only: no such group${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}; ${valid}` };
  return { only: list, error: null };
}

// The run's counters. log: where lines go (console.log by default).
function makeRun(log = console.log) {
  const run = { groups: [], current: null, ok: 0, fail: 0, skipped: 0, log };
  const failed = (g) => { run.fail++; if (g) g.fail++; };
  run.check = (name, ok, detail = '') => {
    // a Promise is not a result: a check given one (a forgotten await) would otherwise always pass
    if (ok && typeof ok.then === 'function') { ok = false; detail = `(given a Promise: a missing await) ${detail}`; }
    if (ok) run.ok++; else failed(run.current);
    log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`);
  };
  run.skip = (name, reason) => {
    run.skipped++;
    if (run.current) run.current.skip++;
    log(`SKIP ${name}: ${reason}`);
  };
  // a wait that ran out of time without being marked optional
  run.waitTimedOut = (what, limit, where) => {
    failed(run.current);
    log(`FAIL wait timed out (${limit})${where ? ` at ${where}` : ''}: ${what}`);
  };
  // fn(): one group's body. after(): cleanup that runs whatever the group did (closing what it left open).
  run.group = async (name, fn, after) => {
    const g = { name, fail: 0, skip: 0, error: null, seconds: 0 };
    run.groups.push(g);
    run.current = g;
    const t0 = Date.now();
    log(`---- ${name}`);
    try { await fn(); } catch (e) {
      g.error = e;
      failed(g);
      log(`FAIL ${name}: the group threw, its remaining checks did not run\n${e && e.stack ? e.stack : e}`);
    }
    if (after) {
      try { await after(); } catch (e) { failed(g); log(`FAIL ${name}: cleanup after the group threw\n${e && e.stack ? e.stack : e}`); }
    }
    g.seconds = (Date.now() - t0) / 1000;
    run.current = null;
    return g;
  };
  // the closing lines; returns the exit code
  run.summary = () => {
    const bad = run.groups.filter((g) => g.fail);
    const errored = bad.filter((g) => g.error);
    for (const g of bad) log(`FAILED group ${g.name}: ${g.error ? 'threw' : `${g.fail} failure${g.fail > 1 ? 's' : ''}`}`);
    log(`groups: ${run.groups.length} run, ${run.groups.length - bad.length} passed, ${bad.length} failed`
      + `${errored.length ? ` (${errored.length} threw)` : ''} · checks: ${run.ok} ok, ${run.fail} FAIL, ${run.skipped} SKIP`);
    log(run.fail ? `browser check FAILED (${run.fail} failure${run.fail > 1 ? 's' : ''})` : `browser check passed${run.skipped ? ` with ${run.skipped} SKIP` : ''}`);
    return run.fail ? 1 : 0;
  };
  return run;
}

// Where in the browser check a wait was called from: the first stack frames in the calling file that are not
// the wait helpers themselves (file:line, outermost last).
function callSite(stack, file, skipNames) {
  const base = path.basename(file);
  const frames = String(stack).split('\n').slice(1)
    .filter((l) => l.includes(file) && !skipNames.some((n) => new RegExp(`at (async )?${n} `).test(l.trim())))
    .map((l) => { const m = /:(\d+):\d+\)?$/.exec(l); return m ? `${base}:${m[1]}` : null; })
    .filter(Boolean);
  return frames.slice(0, 2).join(' < ');
}

// The condition waits. page: anything with evaluate(fn, arg) and waitForTimeout(ms) (a Playwright page).
// waitFor: true as soon as fn holds in the page; on timeout a FAIL (run.waitTimedOut) and false.
// maybeWaitFor(why, ...): the same wait whose timeout is an expected outcome; why says when and why, and it
// never fails the run. waitForFrames: a bound in the machine's frames rather than wall time.
// An evaluate that throws is "not ready yet" (the page may still be starting), not a failure.
// The default limit is 30 s: a limit, not a delay (a wait returns as soon as its condition holds), set well above what
// a loaded machine needs so that load slows a run down rather than failing it.
const DEFAULT_MS = 30000;
function makeWaits(run, file) {
  const HELPERS = ['poll', 'waitFor', 'maybeWaitFor', 'waitForFrames', 'maybeWaitForFrames'];
  const where = () => callSite(new Error().stack, file, HELPERS);
  const describe = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 160);
  const poll = async (page, fn, arg, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (await page.evaluate(fn, arg)) return true; } catch (e) { /* not ready yet */ }
      await page.waitForTimeout(50);
    }
    return false;
  };
  const waitFor = async (page, fn, arg, ms = DEFAULT_MS) => {
    if (await poll(page, fn, arg, ms)) return true;
    run.waitTimedOut(describe(fn), `${ms} ms`, where());
    return false;
  };
  const maybeWaitFor = async (why, page, fn, arg, ms = DEFAULT_MS) => {
    if (typeof why !== 'string' || !why) throw new Error('maybeWaitFor needs the reason its timeout is expected');
    return poll(page, fn, arg, ms);
  };
  // frames: machine frames from now; wallMs only stops a page that has hung
  const framesPoll = async (page, fn, arg, frames, wallMs) => {
    const at = () => page.evaluate(() => window.emu.machine.frameCount);
    const start = await at(), t = Date.now();
    while (Date.now() - t < wallMs) {
      try { if (await page.evaluate(fn, arg)) return { ok: true }; } catch (e) { /* not ready yet */ }
      if ((await at()) - start > frames) return { ok: !!(await page.evaluate(fn, arg).catch(() => false)), why: `${frames} machine frames` };
      await page.waitForTimeout(50);
    }
    return { ok: false, why: `${wallMs} ms (wall clock) before ${frames} frames ran` };
  };
  const waitForFrames = async (page, fn, arg, frames, wallMs = 180000) => {
    const r = await framesPoll(page, fn, arg, frames, wallMs);
    if (!r.ok) run.waitTimedOut(describe(fn), r.why, where());
    return r.ok;
  };
  return { waitFor, maybeWaitFor, waitForFrames, poll };
}

module.exports = { parseOnly, makeRun, makeWaits, callSite };
