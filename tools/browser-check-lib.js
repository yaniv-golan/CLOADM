// The browser check's bookkeeping, without Playwright: which groups run, each group run in isolation, every
// check, wait timeout, skip and group error counted, and the summary and exit code that follow from them.
// tools/browser-check.js uses it; tests/browser-check-lib.test.js tests it with fake groups and fake pages.
//
// The rules (docs/development.md, "Browser check"):
// * --only g1,g2 names groups; a name that is not a group, or an empty list, is a usage error (exit 2) that lists
//   the valid groups. Nothing runs.
// * Each group runs on its own: an error thrown in one is that group's FAIL (with the stack), and the next group
//   still runs.
// * A wait that times out is a FAIL where it happened, unless the call says it is optional and why. A wait on a page
//   that crashed, closed or navigated away is a FAIL in every wait, optional or not.
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
  // a wait that could not go on: the page crashed, closed or navigated away (or, in an optional wait, any evaluate
  // that threw)
  run.waitFailed = (what, reason, where) => {
    failed(run.current);
    log(`FAIL wait: the page is gone or could not be read (${reason})${where ? ` at ${where}` : ''}: ${what}`);
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
  // A promise nobody handled (a route handler's route.fetch that the OS reset, a page call that outlived its page)
  // kills the Node process by default (Node 15 and later), and with it every group after the one that was running. A
  // rejection is a FAIL in the group that was running, with its reason, and the run goes on; the exit code stays 1,
  // so nothing is hidden. proc: the process (an EventEmitter) to listen on; returns the function that stops listening.
  run.guardRejections = (proc = process) => {
    const onRejection = (reason) => {
      failed(run.current);
      log(`FAIL unhandled rejection${run.current ? ` in ${run.current.name}` : ''}: ${reason && reason.stack ? reason.stack : reason}`);
    };
    proc.on('unhandledRejection', onRejection);
    return () => proc.off('unhandledRejection', onRejection);
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
// maybeWaitFor(why, ...): the same wait whose timeout is an expected outcome; why says when and why, and its timeout
// never fails the run. waitForFrames: a bound in the machine's frames rather than wall time.
// A page that is gone is a FAIL in every wait, optional or not: an evaluate that fails because the page crashed or
// closed, or its document was replaced under it (a navigation: "Execution context was destroyed"), is reported where
// the wait was called (run.waitFailed) and the wait returns false. Otherwise, in waitFor and waitForFrames an evaluate
// that throws inside the page (window.emu not there yet while the page starts) is "not ready yet". maybeWaitFor is
// stricter, since its timeout is the pass: any evaluate that throws is a FAIL (a condition that could not be read
// observed nothing), and the page must still be the same live document when the time is up. It returns true (the
// condition held), false (the time ran out on a live page) or null (the page went away: already a FAIL), so a
// negative check passes only on === false.
// The default limit is 30 s: a limit, not a delay (a wait returns as soon as its condition holds), set well above what
// a loaded machine needs so that load slows a run down rather than failing it.
const DEFAULT_MS = 30000;
// Playwright's messages for a page that can no longer be evaluated in (crashed, closed, navigated away, frame gone).
const GONE = /Target crashed|Target page, context or browser has been closed|has been closed|Execution context was destroyed|[Ff]rame (was|has been) detached|Navigation/;
const firstLine = (e) => String(e && e.message !== undefined ? e.message : e).split('\n')[0];
function pageGone(page, e) {
  return (typeof page.isClosed === 'function' && page.isClosed()) || GONE.test(firstLine(e));
}
function makeWaits(run, file) {
  const HELPERS = ['poll', 'waitFor', 'maybeWaitFor', 'waitForFrames', 'framesPoll', 'alive'];
  const where = () => callSite(new Error().stack, file, HELPERS);
  const describe = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 160);
  // { ok } on success; { ok: false, gone } when an evaluate failed for a reason that ends the wait (strict: any
  // evaluate error does); { ok: false } on timeout
  const poll = async (page, fn, arg, ms, strict = false) => {
    // the condition is read at least once, however short ms is
    for (const t = Date.now(); ;) {
      try { if (await page.evaluate(fn, arg)) return { ok: true }; } catch (e) {
        if (strict || pageGone(page, e)) return { ok: false, gone: firstLine(e) };
        /* thrown inside the page: not ready yet */
      }
      if (Date.now() - t >= ms) return { ok: false };
      try { await page.waitForTimeout(50); } catch (e) { return { ok: false, gone: firstLine(e) }; }
    }
  };
  const waitFor = async (page, fn, arg, ms = DEFAULT_MS) => {
    const r = await poll(page, fn, arg, ms);
    if (r.ok) return true;
    if (r.gone) run.waitFailed(describe(fn), r.gone, where());
    else run.waitTimedOut(describe(fn), `${ms} ms`, where());
    return false;
  };
  // a mark left in the page's window before an optional wait and looked for after it: gone if the page crashed,
  // closed or navigated meanwhile
  const alive = async (page, mark, op) => {
    try {
      return await page.evaluate(([m, o]) => {
        const marks = window.__browserCheckWaitMarks || (window.__browserCheckWaitMarks = new Set());
        if (o === 'set') { marks.add(m); return true; }
        return marks.delete(m);
      }, [mark, op]) === true ? null : 'the page is no longer the document the wait started on (it navigated or reloaded)';
    } catch (e) { return firstLine(e); }
  };
  let marks = 0;
  const maybeWaitFor = async (why, page, fn, arg, ms = DEFAULT_MS) => {
    if (typeof why !== 'string' || !why) throw new Error('maybeWaitFor needs the reason its timeout is expected');
    const mark = `${process.pid}.${++marks}`;
    let gone = await alive(page, mark, 'set');
    let r = { ok: false };
    if (!gone) { r = await poll(page, fn, arg, ms, true); gone = r.gone || null; }
    if (!gone && !r.ok) gone = await alive(page, mark, 'check');
    if (gone) { run.waitFailed(`${describe(fn)} (optional: ${why})`, gone, where()); return null; }
    return r.ok;
  };
  // frames: machine frames from now; wallMs only stops a page that has hung
  const framesPoll = async (page, fn, arg, frames, wallMs) => {
    const at = () => page.evaluate(() => window.emu.machine.frameCount);
    try {
      const start = await at(), t = Date.now();
      while (Date.now() - t < wallMs) {
        const r = await poll(page, fn, arg, 1);
        if (r.ok || r.gone) return r;
        if ((await at()) - start > frames) {
          const last = await poll(page, fn, arg, 1);
          return last.gone ? last : { ok: last.ok, why: `${frames} machine frames` };
        }
        await page.waitForTimeout(50);
      }
      return { ok: false, why: `${wallMs} ms (wall clock) before ${frames} frames ran` };
    } catch (e) { return { ok: false, gone: firstLine(e) }; }
  };
  const waitForFrames = async (page, fn, arg, frames, wallMs = 180000) => {
    const r = await framesPoll(page, fn, arg, frames, wallMs);
    if (r.gone) run.waitFailed(describe(fn), r.gone, where());
    else if (!r.ok) run.waitTimedOut(describe(fn), r.why, where());
    return r.ok;
  };
  return { waitFor, maybeWaitFor, waitForFrames };
}

// bounded(promise, ms): { outcome, value, error }, outcome being 'settled', 'rejected' or 'timeout'.
//
// The TIMER IS CLEARED when the promise settles and UNREF'd as a belt, because an uncleared setTimeout keeps Node's
// event loop alive: a run would idle up to `ms` AFTER printing its summary (measured: 14.9 s on every --only run
// before this helper existed). The settled flag makes the losing side a no-op, so an abandoned promise cannot report
// into a check that belongs to a later group.
//
// IT DOES NOT RETURN A BOOLEAN, deliberately. An earlier version returned true for both "settled" and "rejected",
// so a caller testing `!won` treated a failed evaluate as a success and went on to read a value that was never set.
//
// NODE SIDE ONLY: it uses unref(), which the browser page does not have. Code inside page.evaluate() must not call
// it (a setTimeout there is the browser's event loop, which nothing here can hold open). It lived in
// tools/browser-check.js before every group's closes were routed through it; the connector module needs it too, and
// a second copy is how two copies drift, so it lives here with the rest of the shared bookkeeping.
async function bounded(promise, ms) {
  let settled = false;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { if (!settled) { settled = true; resolve({ outcome: 'timeout' }); } }, ms);
    timer.unref();          // belt: even a throw before clearTimeout cannot hold the loop open
  });
  return Promise.race([
    // (a late settle cannot win the race - `timeout` has resolved by then - so there is no 'late' outcome to report;
    // the settled flag's job here is only to stop the loser from touching a check)
    promise.then((value) => { if (settled) return; settled = true; clearTimeout(timer); return { outcome: 'settled', value }; },
      (error) => { if (settled) return; settled = true; clearTimeout(timer); return { outcome: 'rejected', error }; }),
    timeout,
  ]);
}

// The outcome of a bounded() close (tools/browser-check.js), reported into the group that owns the close: a close
// that settled is silent; a rejected or timed-out close is a FAIL naming the close and carrying the reason (an Error's
// message, a non-Error's String), so an unclosable context is a defect in the run rather than a silent hang. The
// `label` is the whole check name ("<group>: a context it opened closes", or the run's own for the final browser);
// the ms is echoed in the timeout's detail so the bound is the one that fired, not a guess, and `after` (optional)
// says what still tears the object down when the bound fires ("left to browser.close()", "killed when this process
// exits") - a FAIL that hides the backstop would read as a leak with no way out.
function reportClose(check, label, b, ms, after = '') {
  if (b.outcome === 'settled') return;
  if (b.outcome === 'rejected') check(label, false, String((b.error && b.error.message !== undefined && b.error.message !== null) ? b.error.message : b.error));
  else check(label, false, `still open after ${ms} ms${after ? ` (${after})` : ''}`);
}

module.exports = { parseOnly, makeRun, makeWaits, callSite, pageGone, bounded, reportClose };
