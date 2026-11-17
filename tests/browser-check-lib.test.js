// tools/browser-check-lib.js: the browser check's bookkeeping, tested with fake groups and fake pages (no browser).
// Each hole it closes is shown failing the way it used to pass: an unknown --only group, a group that throws, a
// wait that times out, a skipped check.
const { parseOnly, makeRun, makeWaits, callSite } = require('../tools/browser-check-lib.js');

let fail = 0;
const check = (name, cond, detail = '') => { detail = String(detail).replace(/\n/g, ' | '); if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const GROUPS = ['models', 'feedback', 'share', 'embed'];

// ---- --only
check('--only absent: every group', JSON.stringify(parseOnly(['node', 'x'], GROUPS)) === JSON.stringify({ only: null, error: null }));
check('--only a,b: those groups', JSON.stringify(parseOnly(['--only', 'share,embed'], GROUPS).only) === '["share","embed"]');
const bogus = parseOnly(['--only', 'nosuchgroup'], GROUPS);
check('--only with an unknown group: an error naming it and listing the valid groups', bogus.only === null
  && /no such group: nosuchgroup/.test(bogus.error) && /valid groups: models, feedback, share, embed/.test(bogus.error), bogus.error);
const mixed = parseOnly(['--only', 'share,bogus,nope'], GROUPS);
check('--only with known and unknown groups: an error naming every unknown one', /no such groups: bogus, nope/.test(mixed.error), mixed.error);
for (const argv of [['--only', ''], ['--only', ','], ['--only'], ['--only', '--screenshots', 'x']]) {
  const r = parseOnly(argv, GROUPS);
  check(`--only with an empty selection (${JSON.stringify(argv.slice(1))}): an error`, r.only === null && /needs a comma-separated list/.test(r.error) && /valid groups/.test(r.error), r.error);
}
check('--only=a,b: those groups', JSON.stringify(parseOnly(['--only=share,embed'], GROUPS).only) === '["share","embed"]');
check('--only=bogus: an error, not every group', /no such group: bogus/.test(parseOnly(['--only=bogus'], GROUPS).error || ''));
check('--only twice: an error', /more than once/.test(parseOnly(['--only', 'share', '--only', 'embed'], GROUPS).error || ''));
{
  const lines = [], run = makeRun((l) => lines.push(l));
  run.check('a forgotten await', Promise.resolve(true));
  check('check(): a Promise given as the result is a FAIL, not a pass', run.fail === 1 && run.ok === 0 && /FAIL a forgotten await \(given a Promise/.test(lines.join('\n')), lines.join(' | '));
}

(async () => {
  // ---- isolation: a group that throws is that group's FAIL, the next group still runs, the exit code is 1
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    const ran = [], cleaned = [];
    await run.group('first', async () => { ran.push('first'); run.check('a check', true); }, async () => cleaned.push('first'));
    await run.group('thrower', async () => { ran.push('thrower'); run.check('before the throw', true); throw new Error('boom in the group'); }, async () => cleaned.push('thrower'));
    await run.group('after', async () => { ran.push('after'); run.check('still runs', true); }, async () => cleaned.push('after'));
    const code = run.summary();
    const out = lines.join('\n');
    check('isolation: the groups after a throwing group still run', ran.join() === 'first,thrower,after', ran.join());
    check('isolation: each group\'s cleanup runs, including the one that threw', cleaned.join() === 'first,thrower,after', cleaned.join());
    check('isolation: the throw is reported as that group\'s FAIL, with the stack', /FAIL thrower: the group threw/.test(out) && /Error: boom in the group\n\s+at /.test(out), out);
    check('isolation: the summary names the failed group and counts groups run / passed / failed',
      /FAILED group thrower: threw/.test(out) && /groups: 3 run, 2 passed, 1 failed \(1 threw\)/.test(out), out.split('\n').slice(-3).join(' | '));
    check('isolation: the exit code is 1', code === 1);
    check('isolation: the last line says FAILED, not passed', /^browser check FAILED/.test(lines.at(-1)) && !/passed/.test(lines.at(-1)), lines.at(-1));
  }
  // a failing check in a group fails that group only
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('ok group', async () => run.check('fine', true));
    await run.group('bad group', async () => { run.check('wrong', false, 'detail'); run.check('right', true); });
    const code = run.summary(), out = lines.join('\n');
    check('a failed check: FAIL line, the group failed with its count, exit 1', code === 1 && /FAIL wrong detail/.test(out)
      && /FAILED group bad group: 1 failure/.test(out) && /groups: 2 run, 1 passed, 1 failed · checks: 2 ok, 1 FAIL, 0 SKIP/.test(out), out);
  }
  // a cleanup that throws fails its group
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('g', async () => run.check('fine', true), async () => { throw new Error('close failed'); });
    check('a cleanup that throws fails the group', run.summary() === 1 && /FAIL g: cleanup after the group threw/.test(lines.join('\n')));
  }
  // ---- SKIP: counted and shown, never silent; a skip alone does not fail the run
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('nitros9', async () => { run.check('hand-built image', true); run.skip('nitros9 6809: release image', 'not cached'); run.skip('nitros9 6309: release image', 'not cached'); });
    const code = run.summary(), out = lines.join('\n');
    check('SKIP: each skip is a SKIP line with its reason', (out.match(/^SKIP nitros9 \d{4}: release image: not cached$/gm) || []).length === 2, out);
    check('SKIP: counted in the summary line, and the run passes with exit 0', code === 0 && /checks: 1 ok, 0 FAIL, 2 SKIP/.test(out)
      && lines.at(-1) === 'browser check passed with 2 SKIP', lines.at(-1));
  }
  // a clean run
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('a', async () => run.check('x', true));
    check('a clean run: exit 0, "browser check passed"', run.summary() === 0 && lines.at(-1) === 'browser check passed' && /groups: 1 run, 1 passed, 0 failed/.test(lines.join('\n')));
  }

  // ---- waits: a timeout is a FAIL where it was called, unless marked optional
  // a fake page: each evaluate of the condition returns (or throws) the next result; the optional wait's liveness mark
  // lives in its window, which navigate() replaces
  const page = (results) => {
    let i = 0, win = {};
    return { evals: 0, navigate() { win = {}; },
      async evaluate(fn, arg) {
        if (String(fn).includes('__browserCheckWaitMarks')) { const g = globalThis.window; globalThis.window = win; try { return fn(arg); } finally { globalThis.window = g; } }
        this.evals++; const v = results[Math.min(i++, results.length - 1)]; if (v instanceof Error) throw v; return typeof v === 'function' ? v() : v; },
      async waitForTimeout() {} };
  };
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    const { waitFor, maybeWaitFor } = makeWaits(run, __filename);
    let r;
    await run.group('waits', async () => {
      r = await waitFor(page([false, new Error('emu not there yet'), true]), () => true, null, 1000);
      check('waitFor: true once the condition holds; an evaluate that throws is "not ready yet"', r === true);
      r = await waitFor(page([false]), function neverTrue() { return window.never; }, null, 60);
      check('waitFor: false on timeout', r === false);
    });
    const out = lines.join('\n');
    check('waitFor: a timeout is a FAIL line with the limit, the condition and where it was called', /^FAIL wait timed out \(60 ms\) at browser-check-lib\.test\.js:\d+( < browser-check-lib\.test\.js:\d+)?: function neverTrue\(\) \{ return window\.never; \}$/m.test(out), out);
    check('waitFor: the timeout fails its group and the run', run.summary() === 1 && /FAILED group waits: 1 failure/.test(lines.join('\n')));

    const lines2 = [], run2 = makeRun((l) => lines2.push(l));
    const w2 = makeWaits(run2, __filename);
    await run2.group('optional', async () => { r = await w2.maybeWaitFor('the toast may already be gone', page([false]), () => false, null, 60); });
    check('maybeWaitFor: a timeout is false and no FAIL', r === false && run2.summary() === 0 && !/^FAIL/m.test(lines2.join('\n')), lines2.join(' | '));

    // a page that is gone is a FAIL in every wait, optional or not (Playwright's messages for a crash, a closed page,
    // and a navigation that destroyed the context the condition ran in)
    for (const msg of ['page.evaluate: Target crashed', 'page.evaluate: Target page, context or browser has been closed',
      'page.evaluate: Execution context was destroyed, most likely because of a navigation']) {
      for (const optional of [false, true]) {
        const l = [], rn = makeRun((x) => l.push(x)), w = makeWaits(rn, __filename);
        let v;
        await rn.group('gone', async () => {
          v = optional ? await w.maybeWaitFor('a check that nothing shows', page([false, new Error(msg)]), () => false, null, 1000)
            : await w.waitFor(page([false, new Error(msg), true]), () => false, null, 1000);
        });
        check(`${optional ? 'maybeWaitFor' : 'waitFor'}: "${msg.slice(15)}" is a FAIL, not ${optional ? 'a pass' : '"not ready yet"'}`,
          (optional ? v === null : v === false) && rn.summary() === 1 && /^FAIL wait: the page is gone or could not be read \(page\.evaluate: /m.test(l.join('\n')), l.join(' | '));
      }
    }
    {
      // a closed page (isClosed) is gone whatever the message says
      const l = [], rn = makeRun((x) => l.push(x)), w = makeWaits(rn, __filename);
      const p = page([false, new Error('something')]); p.isClosed = () => true;
      await rn.group('closed', async () => { await w.waitFor(p, () => false, null, 1000); });
      check('waitFor: an evaluate error on a closed page is a FAIL', rn.summary() === 1, l.join(' | '));
    }
    {
      // an optional wait: any evaluate that throws is a FAIL (its condition was never read, so its timeout proves nothing)
      const l = [], rn = makeRun((x) => l.push(x)), w = makeWaits(rn, __filename);
      let v;
      await rn.group('opt-throws', async () => { v = await w.maybeWaitFor('a check that nothing shows', page([new Error('TypeError: x is null')]), () => false, null, 60); });
      check('maybeWaitFor: a condition that throws in the page is a FAIL, not a pass', v === null && rn.summary() === 1 && /could not be read \(TypeError: x is null\)/.test(l.join('\n')), l.join(' | '));
    }
    {
      // an optional wait over which the page navigated (no evaluate failed, but it is a new document): a FAIL
      const l = [], rn = makeRun((x) => l.push(x)), w = makeWaits(rn, __filename);
      const p = page([false]);
      const orig = p.evaluate; let n = 0;
      p.evaluate = async function (fn, arg) { const v = await orig.call(this, fn, arg); if (!String(fn).includes('__browserCheckWaitMarks') && ++n === 2) this.navigate(); return v; };
      let v;
      await rn.group('navigated', async () => { v = await w.maybeWaitFor('a check that nothing shows', p, () => false, null, 60); });
      check('maybeWaitFor: a page that navigated during the wait is a FAIL', v === null && rn.summary() === 1 && /navigated or reloaded/.test(l.join('\n')), l.join(' | '));
    }
    {
      // and a frames wait: a crash is a FAIL naming it, not a timeout
      const l = [], rn = makeRun((x) => l.push(x)), w = makeWaits(rn, __filename);
      let f = 0; const crashed = { async evaluate(fn) { if (String(fn).includes('frameCount')) return (f += 1); throw new Error('page.evaluate: Target crashed'); }, async waitForTimeout() {} };
      await rn.group('frames-crash', async () => { await w.waitForFrames(crashed, () => false, null, 1000, 1000); });
      check('waitForFrames: a crash is a FAIL saying so', rn.summary() === 1 && /could not be read \(page\.evaluate: Target crashed\)/.test(l.join('\n')), l.join(' | '));
    }
    let threw = false;
    try { await w2.maybeWaitFor(page([true]), () => true); } catch (e) { threw = /needs the reason/.test(e.message); }
    check('maybeWaitFor: refused without a reason', threw);
  }
  {
    // waitForFrames: the limit is machine frames; running out of frames, or the page hanging, is a FAIL
    const lines = [], run = makeRun((l) => lines.push(l));
    const { waitForFrames } = makeWaits(run, __filename);
    let frame = 0;
    const machine = { async evaluate(fn) { const src = String(fn); if (src.includes('frameCount')) return (frame += 10); return false; }, async waitForTimeout() {} };
    let r;
    await run.group('frames', async () => { r = await waitForFrames(machine, () => window.done, null, 30); });
    check('waitForFrames: out of frames is false and a FAIL naming the frame limit', r === false && /FAIL wait timed out \(30 machine frames\) at browser-check-lib\.test\.js:\d+/.test(lines.join('\n')), lines.join(' | '));
    const lines2 = [], run2 = makeRun((l) => lines2.push(l));
    const w2 = makeWaits(run2, __filename);
    const hung = { async evaluate(fn) { return String(fn).includes('frameCount') ? 0 : false; }, async waitForTimeout() { await new Promise((ok) => setTimeout(ok, 5)); } };
    await run2.group('hung', async () => { r = await w2.waitForFrames(hung, () => false, null, 30, 40); });
    check('waitForFrames: a page that stops running frames fails on the wall-clock limit', r === false && /FAIL wait timed out \(40 ms \(wall clock\) before 30 frames ran\)/.test(lines2.join('\n')), lines2.join(' | '));
  }
  // callSite skips the helpers and names the caller's lines
  const stack = ['Error', '    at poll (/x/tools/b.js:10:5)', '    at waitFor (/x/tools/b.js:20:5)', '    at async ready (/x/tools/b.js:30:5)', '    at async romChecks (/x/tools/b.js:400:7)', '    at async main (/x/tools/b.js:900:3)'].join('\n');
  check('callSite: the first frames outside the wait helpers', callSite(stack, '/x/tools/b.js', ['poll', 'waitFor']) === 'b.js:30 < b.js:400', callSite(stack, '/x/tools/b.js', ['poll', 'waitFor']));

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
