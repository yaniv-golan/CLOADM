// tools/browser-check-lib.js: the browser check's bookkeeping, tested with fake groups and fake pages (no browser).
// Each hole it closes is shown failing the way it used to pass: an unknown --only group, a group that throws, a
// wait that times out, a skipped check.
const { parseOnly, makeRun, makeWaits, callSite, bounded, reportClose } = require('../tools/browser-check-lib.js');

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
  // ---- bounded: the race every group's closes and the tone measurement wait on. What is OBSERVED here is what a
  // caller can actually see: the four outcomes, and that the timer is UNREF'd - the property the base comment
  // measures with (a run idled 14.9 s after its summary before it), observed as a child process holding only the
  // race exiting at once instead of idling out the bound. Two of the helper's other internals are deliberately
  // NOT asserted because no caller can observe them: the cleared timer (an uncleared timer that is unref'd holds
  // nothing open - probes: Node 25.2.1 does not even list an unref'd pending timer in getActiveResourcesInfo, and
  // the clearTimeout-mutant alone changes nothing observable), and the settled flag (a late settle's second
  // outcome goes into a lost Promise.race branch; every caller awaits the race once, so nothing can see it).
  // Both are defense-in-depth behind the observable property, and the unref test kills their combination
  // (unref removed - with or without the clear - by name below).
  {
    // bounded()'s timer is unref'd by design, so a test whose only pending work is the race would let Node exit
    // before the bound fires: hold a REF'd timer for the test's duration, which is exactly what a real run has
    // (its server, its browser pipes) and keeps the check honest.
    const hold = setTimeout(() => {}, 2000);
    const settled = await bounded(Promise.resolve(42), 100);
    check('bounded: a settled promise carries its value', settled.outcome === 'settled' && settled.value === 42, JSON.stringify(settled));
    const rejected = await bounded(Promise.reject(new Error('no')), 100);
    check('bounded: a rejection is an outcome with the error, never a truthy "won"', rejected.outcome === 'rejected' && rejected.error.message === 'no', JSON.stringify(rejected));
    const hung = await bounded(new Promise(() => {}), 20);
    check('bounded: a promise that never settles is a timeout after ms, not a hang', hung.outcome === 'timeout', JSON.stringify(hung));
    // THE TIMER IS UNREF'D: a child process whose ONLY pending work is a bounded never-settling promise exits
    // AT ONCE with nothing printed - the empty loop does not wait for the bound. With the unref removed the child
    // idles out the 5 s bound and then prints the timeout (exactly what held real runs open 14.9 s; the parent
    // test process holds its own ref'd timer, so this needs the child to see the difference).
    {
      const child = await new Promise((res) => {
        const code = 'const { bounded } = require(' + JSON.stringify(require.resolve('../tools/browser-check-lib.js')) + ');'
          + ' bounded(new Promise(() => {}), 5000).then((b) => { console.log(b.outcome); });';
        const c = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        const t0 = Date.now();
        c.on('exit', (code2, signal) => res({ ms: Date.now() - t0, code: code2, signal, out }));
        setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} res({ ms: Date.now() - t0, code: 'still-running-at-2s', out }); }, 2000);
      });
      check('bounded: the timer is unref\'d (a process holding only the race exits at once, before the bound)',
        child.out === '' && child.ms < 2000 && child.code === 0, `code=${child.code} ms=${child.ms} out=${JSON.stringify(child.out.trim())}`);
    }
    // THE OUTCOME THE CALLER SAW CANNOT CHANGE: a settle arriving long after the bound fired is invisible to the
    // caller - the same race promise, awaited again, is the same timeout with no value. That immutability is the
    // contract every caller relies on (a late settle must never turn into a second outcome or a value).
    {
      const raced = bounded(new Promise((r2) => setTimeout(() => r2('early'), 120)), 20);
      const first = await raced;
      await new Promise((r) => setTimeout(r, 250));   // (the late settle has landed by now)
      const again = await raced;
      check('bounded: a settle after the bound fired cannot change the outcome the caller saw',
        first.outcome === 'timeout' && again.outcome === 'timeout' && first.value === undefined && again.value === undefined,
        `first=${JSON.stringify(first)} again=${JSON.stringify(again)}`);
    }
    clearTimeout(hold);
  }
  // ---- reportClose: the outcome of bounded() on a close, reported into the group that owns the close.
  // A close that settles is silent; a close that rejected or timed out is that group's FAIL, by name.
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('disk', async () => {
      run.check('a passing check, to see the quiet close add nothing', true);
      reportClose(run.check, 'disk: a context it opened closes', { outcome: 'settled' }, 10000);
      reportClose(run.check, 'disk: a context it opened closes', { outcome: 'timeout' }, 10000);
      reportClose(run.check, 'disk: a context it opened closes', { outcome: 'rejected', error: new Error('Target crashed') }, 10000);
      reportClose(run.check, 'disk: a context it opened closes', { outcome: 'rejected', error: 'a plain string' }, 10000);
      reportClose(run.check, 'disk: a context it opened closes', { outcome: 'rejected', error: null }, 10000);
    });
    const code = run.summary(), out = lines.join('\n');
    check('reportClose: a settled close reports nothing (exactly the one ok line before the FAILs)',
      run.ok === 1 && !/settled/.test(out) && /^ok {2,4}a passing check/.test(out.split('\n')[1]), out.split('\n').slice(0, 2).join(' | '));
    check('reportClose: a timeout is a FAIL that names the close and the bound',
      /FAIL disk: a context it opened closes still open after 10000 ms/.test(out), out);
    check('reportClose: a rejection is a FAIL carrying the error message', /FAIL disk: a context it opened closes Target crashed/.test(out), out);
    check('reportClose: a non-Error rejection and a null one are FAILs too, never crashes',
      /a plain string/.test(out) && /String\(null\)|null/.test(out), out);
    check('reportClose: every non-settled outcome failed the run (exit 1)', code === 1 && run.fail === 4, `fail=${run.fail} code=${code}`);
  }
  // the FAIL lands in the group that owns the close even when the outcome came from elsewhere
  {
    const lines = [], run = makeRun((l) => lines.push(l));
    await run.group('owner', async () => { run.ownsClose = true; });
    await run.group('sound', async () => {
      reportClose(run.check, 'sound: a context it opened closes', { outcome: 'timeout' }, 10000);
    });
    const out = lines.join('\n');
    const owner = run.groups.find((g) => g.name === 'owner'), sound = run.groups.find((g) => g.name === 'sound');
    check('reportClose: the FAIL is counted against the group that ran it',
      sound.fail === 1 && owner.fail === 0 && /FAIL sound: a context it opened closes/.test(out), `owner=${owner.fail} sound=${sound.fail}`);
  }
  // guardRejections: a rejection nobody handles (a route.fetch the OS reset) is that group's FAIL with its reason, the next
  // group still runs, and the exit code is 1; without the guard Node ends the process in the middle of the group.
  {
    const lib = JSON.stringify(require.resolve('../tools/browser-check-lib.js'));
    const child = (guard) => new Promise((res) => {
      const code = `const { makeRun } = require(${lib}); const run = makeRun(); ${guard ? 'run.guardRejections();' : ''}
        (async () => {
          await run.group('one', async () => { Promise.reject(new Error('route.fetch: connect ECONNRESET 127.0.0.1:1')); await new Promise((r) => setTimeout(r, 100)); });
          await run.group('two', async () => run.check('the second group runs', true));
          process.exitCode = run.summary();
        })();`;
      const c = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (exit) => res({ exit, out, err }));
    });
    const guarded = await child(true), bare = await child(false);
    check('guardRejections: the rejection is a FAIL in its group, with its reason', /FAIL unhandled rejection in one: Error: route\.fetch: connect ECONNRESET/.test(guarded.out) && /FAILED group one: 1 failure/.test(guarded.out), guarded.out);
    check('guardRejections: the next group still runs and the run still exits 1', /ok   the second group runs/.test(guarded.out) && /groups: 2 run, 1 passed, 1 failed/.test(guarded.out) && guarded.exit === 1, `exit=${guarded.exit} ${guarded.out}`);
    check('guardRejections: without it the process dies in the group (the second never runs, no summary)', bare.exit !== 0 && !/second group runs|groups:/.test(bare.out) && /ECONNRESET/.test(bare.err), `exit=${bare.exit} ${bare.out}`);
    // a rejection that surfaces after the summary was printed ("passed") still ends the process with exit 1
    const lateOut = await new Promise((res) => {
      const code = `const { makeRun } = require(${lib}); const run = makeRun(); run.guardRejections();
        (async () => {
          await run.group('one', async () => run.check('fine', true));
          process.exitCode = run.summary();
          Promise.reject(new Error('late: connect ECONNRESET'));
        })();`;
      const c = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('exit', (exit) => res({ exit, out }));
    });
    check('guardRejections: a rejection after the summary says "passed" still exits 1, with its FAIL line',
      /browser check passed/.test(lateOut.out) && /FAIL unhandled rejection: Error: late: connect ECONNRESET/.test(lateOut.out) && lateOut.exit === 1, `exit=${lateOut.exit} ${lateOut.out}`);
    // run.top: the run's own body throwing (a browser that will not launch) is a FAIL, the closing code still runs, exit 1
    const topOut = await new Promise((res) => {
      const code = `const { makeRun } = require(${lib}); const run = makeRun(); run.guardRejections();
        (async () => {
          await run.top(async () => { try { throw new Error('browserType.launch: Executable does not exist'); } finally { console.log('cleanup ran'); } });
          process.exitCode = run.summary();
        })();`;
      const c = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('exit', (exit) => res({ exit, out }));
    });
    check('top: a throw before the summary is a FAIL naming it, the cleanup ran, the summary printed and the exit code is 1',
      /cleanup ran/.test(topOut.out) && /FAIL the browser check itself threw[^]*Executable does not exist/.test(topOut.out) && /browser check FAILED \(1 failure\)/.test(topOut.out) && topOut.exit === 1, `exit=${topOut.exit} ${topOut.out}`);
    // the real tool with a browser that cannot launch: it ends by itself with exit 1 (it used to hang, the server open)
    const launch = await new Promise((res) => {
      const c = require('child_process').spawn(process.execPath, [require('path').join(__dirname, '../tools/browser-check.js'), '--only', 'audio'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-browsers' }) });
      let out = '', killed = false;
      c.stdout.on('data', (d) => { out += d; });
      const t = setTimeout(() => { killed = true; c.kill('SIGKILL'); }, 60000);
      c.on('exit', (exit) => { clearTimeout(t); res({ exit, out, killed }); });
    });
    check('a browser that cannot launch ends the run by itself (no hang), with a FAIL line and exit 1',
      !launch.killed && launch.exit === 1 && /FAIL the browser check itself threw/.test(launch.out) && /browser check FAILED/.test(launch.out), `exit=${launch.exit} killed=${launch.killed} ${launch.out.slice(-300)}`);
    // stopping the guard puts Node's default back
    const { EventEmitter } = require('events');
    const fake = new EventEmitter(), r2 = makeRun(() => {}), stop = r2.guardRejections(fake);
    const on = fake.listenerCount('unhandledRejection'); stop();
    check('guardRejections: listens on the process it is given, and stops when told', on === 1 && fake.listenerCount('unhandledRejection') === 0, `${on}`);
  }
  // No routed request is answered by route.fetch: it goes over a pooled socket to the check's own server, which drops idle
  // ones, and a request that reused one at that moment failed with "route.fetch: read ECONNRESET" (3 runs in 12 under CPU load).
  // A route answers from the files (staticAnswer) with route.fulfill.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../tools/browser-check.js'), 'utf8');
    const calls = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\broute\.fetch\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    check('browser-check.js answers no routed request with route.fetch (a pooled socket the server may reset)', calls.length === 0, calls.map(([n]) => `line ${n}`).join(', '));
  }
  // callSite skips the helpers and names the caller's lines
  const stack = ['Error', '    at poll (/x/tools/b.js:10:5)', '    at waitFor (/x/tools/b.js:20:5)', '    at async ready (/x/tools/b.js:30:5)', '    at async romChecks (/x/tools/b.js:400:7)', '    at async main (/x/tools/b.js:900:3)'].join('\n');
  check('callSite: the first frames outside the wait helpers', callSite(stack, '/x/tools/b.js', ['poll', 'waitFor']) === 'b.js:30 < b.js:400', callSite(stack, '/x/tools/b.js', ['poll', 'waitFor']));

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
