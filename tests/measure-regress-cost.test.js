// Run: node tests/measure-regress-cost.test.js
//
// tools/measure-regress-cost.js is the tool tests/regress-shards.js cites for its constants. It lives in tools/ and
// reads tests/regress-hashes.json, so a wrong ROOT makes it die at once with ENOENT - which is exactly what happened
// when it moved and the constant still said __dirname. This runs it and requires it to produce a USEABLE fit, so a
// moved path cannot silently break it again.
//
// A fit is useable only if it HAS points and a positive slope. That is not a detail: with `--limit 2` every trace case
// is the same size, and the fit printed `trace: NaN (n=2)` and `video: NaN (n=0)` - the old check passed on those,
// because it only looked for the words "per instruction" and "per frame". So the cases are CHOSEN here from the
// recorded workloads, SPREAD in cost (six per kind, the heaviest to the lightest), which gives the fit signal at many
// scales. The fit itself is now the median of pairwise slopes (Theil-Sen): one noisy case can no longer drag the
// slope negative, the way least squares let it on a loaded machine (the old check went red on exactly that, on a
// run that raced another worker's browser check). The tool prints each fit's NOISE share and names a machine too
// noisy to trust in its own words - a measurement that cannot trust its machine says so, it never passes silently.
// It is still not a test of the CONSTANTS (those are per-machine); it is a test that the tool reports a real
// measurement rather than an undefined one.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cloadm-regress-cost-'));
const before = leftovers().length;

// the cases are CHOSEN from tests/regress-hashes.json by their recorded workloads, SPREAD in cost: six
// traces (9.4M instructions down to a few hundred) and six videos (2200 frames down to 80), so the fit has
// signal at many scales - a handful of near-identical costs carries none, and that is how the old fit went
// negative under load. The names are not typed by hand: the suite picks them from the hashes file the tool
// reads, so a renamed case can never silently drop out of the sample (a chosen name that is gone fails the
// run, and the run's own 'measuring N cases' line is asserted to name every one of them).
const hashes = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'regress-hashes.json'), 'utf8'));
const byCost = (kind, ranks) => {
  const all = Object.entries(hashes).filter(([, v]) => v[kind] != null).sort((a, b) => b[1][kind] - a[1][kind]);
  return ranks.map((r) => { const e = all[r < 0 ? all.length + r : r]; if (!e) throw new Error(`no case at rank ${r} of ${all.length}`); return e[0]; });
};
const chosen = [...byCost('instructions', [0, 3, 8, 20, 60, -1]), ...byCost('frames', [0, 1, 3, 10, 20, -1])];
const only = `/${chosen.map((n) => '^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').join('|')}/`;   // anchored: 'video coco3' must not also match 'video coco3 ...'
const r = cp.spawnSync(process.execPath, [path.join('tools', 'measure-regress-cost.js'), '--only', only], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const out = (r.stdout || '') + (r.stderr || '');
check('a moved ROOT would crash it at once (this is the regression that happened)', r.status === 0 && !/ENOENT/.test(out),
  (out.split('\n').find((l) => /ENOENT|Error/.test(l)) || out.split('\n')[0] || '').slice(0, 160));

// BOTH fits, parsed rather than pattern-matched: a number, a count, a noise share, and a slope in the
// shape the tool prints
const fitOf = (label, text = out) => {
  const m = new RegExp(`${label}:\\s*(-?[\\d.]+(?:e[-+]?\\d+)?|NaN)\\s*(?:us per instruction|ms per frame)\\s*\\(n=(\\d+), noise (\\d+)%\\)`).exec(text);
  return m ? { slope: Number(m[1]), n: Number(m[2]), noise: Number(m[3]) / 100 } : null;
};
// THE requirement, in ONE place: a fit is useable only if it has at least two points and a finite, positive slope.
// The real run and the mutant below are both judged by this function, deliberately - if the mutant were judged by its
// own copy of the rule, disabling this one would leave that copy passing and the guard's removal would go unnoticed.
const useable = (f) => f !== null && f.n >= 2 && Number.isFinite(f.slope) && f.slope > 0;
const tf = fitOf('trace'), vf = fitOf('video');
check('it reaches a trace fit (it read tests/regress-hashes.json and ran the cases)', tf !== null, (out.match(/trace:.*/) || [''])[0].slice(0, 120));
check('it reaches a video fit', vf !== null, (out.match(/video:.*/) || [''])[0].slice(0, 120));
for (const [label, f, count] of [['trace', tf, 6], ['video', vf, 6]]) {
  if (!f) continue;
  check(`the ${label} fit measured every chosen case (the sample cannot shrink silently)`, f.n === count, `n=${f.n} of ${count}`);
  check(`the ${label} fit is a finite, positive slope (not NaN, not a negative from noise)`,
    Number.isFinite(f.slope) && f.slope > 0, `${label} slope ${f.slope}`);
}
check('both fits are useable (the requirement the mutant below leans on)', useable(tf) && useable(vf),
  `trace ${JSON.stringify(tf)} video ${JSON.stringify(vf)}`);
// the fit itself, on HAND-BUILT points (the exported fit, the same code the run uses): a clean line
// has noise 0, and a scattered set - half its pairwise slopes pulled every which way by a machine
// that lies - is past half, which is exactly what makes the tool print its noisy-machine line. A
// fit whose noise was a constant 0 would make that line unreachable and this whole guarantee dead.
{
  const { fit } = require(path.join('..', 'tools', 'measure-regress-cost.js'));
  const line = fit([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 4, y: 8 }, { x: 8, y: 16 }]);
  check('the fit on a clean line: the exact slope, noise 0 (nothing disagrees with the median)',
    line.slope === 2 && line.noise === 0, JSON.stringify(line));
  const wild = fit([{ x: 1, y: 10 }, { x: 2, y: 1 }, { x: 4, y: 40 }, { x: 8, y: 2 }, { x: 16, y: 80 }, { x: 32, y: 3 }]);
  check('the fit on a scattered set: noise past half (the machine that cannot be trusted, named)',
    wild.noise > 0.5, JSON.stringify(wild));
  const odd = fit([{ x: 1, y: 1 }]);
  check('the fit with no pair: NaN, not a made-up slope', Number.isNaN(odd.slope) && Number.isNaN(odd.noise), JSON.stringify(odd));
  // the PRINT path: the report of a noisy fit names the machine in its own words, and a clean fit's
  // report says nothing of the kind. (The noise share is tested above; this is the LINE the person
  // reads - deleting it must go red, not silently lose the guarantee.) The reports are captured with
  // the log replaced, then asserted with it restored - a check() must never run inside the capture,
  // or its own FAIL would be swallowed by it.
  const { reportFits } = require(path.join('..', 'tools', 'measure-regress-cost.js'));
  const said = [];
  const log = console.log; console.log = (...a) => said.push(a.join(' '));
  let noisySaid = '', cleanSaid = '';
  try {
    reportFits(wild, 6, wild, 6);
    noisySaid = said.join('\n');
    said.length = 0;
    reportFits(line, 3, line, 3);
    cleanSaid = said.join('\n');
  } finally { console.log = log; }
  check('the report of a noisy fit names the machine in its own words ("the machine looks noisy")',
    /the machine looks noisy/.test(noisySaid), noisySaid.split('\n')[2] || '');
  check('the report of a clean fit says no such thing (the line is the noisy machine\'s alone)',
    !/the machine looks noisy/.test(cleanSaid), (cleanSaid.match(/noise \d+%/g) || []).join(' '));
}
// the noise is REPORTED, never hidden: whatever the fits measured, the tool said its noise share. A
// machine too noisy to trust is the tool's own warning line (below), not a silently-passing green:
// the check requires the print, so a quiet machine and a loud one both pass - the loud one by saying so.
check('every fit reports its noise share (the measurement says how much to trust it)',
  !!tf && !!vf && Number.isFinite(tf.noise) && Number.isFinite(vf.noise), `trace noise ${tf && tf.noise} video noise ${vf && vf.noise}`);
check('it names its noisy machine in its own words when the fit cannot be trusted (never a silent pass)',
  (tf.noise <= 0.5 && vf.noise <= 0.5) || /the machine looks noisy/.test(out), `trace ${tf.noise} video ${vf.noise}`);
check(`it names how many cases it measured (every chosen one: ${chosen.length})`, new RegExp(`^measuring ${chosen.length} cases, one process each\\.\\.\\.`).test(out), (out.split('\n')[0] || '').slice(0, 80));
check('no copy is left in the temp directory', leftovers().length === before, `${leftovers().length - before} left`);

// F2's mutant, as a DELTA rather than an assertion about this file: the tool is run again from a copy in which the
// workload numbers it fits against are gone (every recorded value dropped before the names are chosen), which is the
// shape of the original `--limit 2` bug - points that do not exist. THE REAL REQUIREMENTS ARE APPLIED TO THAT RUN too:
// the mutant is red exactly when the same predicate that guards the real run rejects it, which is what makes this a
// measurement of the guard rather than a restatement of the bug. (NaN === 0 is false, so a looser test here would pass
// whether or not the guard works.)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-regress-cost-mutant-'));
  try {
    const cmd = fs.existsSync(path.join(ROOT, '.git'))
      ? `cd ${JSON.stringify(ROOT)} && git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`
      : `cd ${JSON.stringify(ROOT)} && tar -cf - --exclude=./.git --exclude=./.claude --exclude=./node_modules . 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`;
    cp.execFileSync('bash', ['-c', cmd]);
    const hpath = path.join(dir, 'tests', 'regress-hashes.json');
    const h = JSON.parse(fs.readFileSync(hpath, 'utf8'));
    for (const k of Object.keys(h)) { delete h[k].instructions; delete h[k].frames; }
    fs.writeFileSync(hpath, JSON.stringify(h));
    const m = cp.spawnSync(process.execPath, [path.join('tools', 'measure-regress-cost.js'), '--only', only], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    const mo = (m.stdout || '') + (m.stderr || '');
    // the SAME predicate the real run is held to, on the mutant's own numbers
    const mt = useable(fitOf('trace', mo)), mv = useable(fitOf('video', mo));
    check('MUTANT (no recorded workload): the real requirement rejects it, so it is not vacuous',
      !mt && !mv, `trace useable=${mt} video useable=${mv}; ${(mo.match(/trace:.*/) || [''])[0].slice(0, 80)}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

// The cost-regression mutant: the tool is run again from a copy whose regress.test.js carries an
// injected per-frame delay in videoHash - the shape of a real regression in the measured path (a
// slower build, a bad hot loop). The delayed run's video slope must be far above the clean run's
// (the delay is a constant per frame, so it lands exactly where the fit looks), and the SAME
// judgement is applied from BOTH sides: the delayed slope must exceed the clean one by at least the
// delay itself (2 ms a frame on a ~0.6 ms clean slope is a multiple), and the noise shares must stay
// honest (the delay makes the fit MORE consistent, not less - a mutant that only made noise would
// not be a cost regression). This is the guard the whole suite exists for: a measurement that cannot
// detect a slower machine is decoration.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-regress-cost-mutant-'));
  try {
    const cmd = fs.existsSync(path.join(ROOT, '.git'))
      ? `cd ${JSON.stringify(ROOT)} && git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`
      : `cd ${JSON.stringify(ROOT)} && tar -cf - --exclude=./.git --exclude=./.claude --exclude=./node_modules . 2>/dev/null | tar -xf - -C ${JSON.stringify(dir)}`;
    cp.execFileSync('bash', ['-c', cmd]);
    const rpath = path.join(dir, 'tests', 'regress.test.js');
    const r = fs.readFileSync(rpath, 'utf8');
    const needle = '    const px = Emu.frameToRGBA(m.render());\n    for (let i = 0; i < px.length; i++) h = fnv(h, px[i]);';
    // the delay itself is a page so the 0-ms mutant (below) is the same code path with the delay off
    const patched = needle + '\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.DELAY_MS || 0));   // MUTANT: DELAY_MS ms a frame, from the env';
    if (!r.includes(needle)) throw new Error('the injection point moved: videoHash no longer matches');
    fs.writeFileSync(rpath, r.replace(needle, patched));
    // the two runs measure under the SAME load (interleaved, back to back in the copy): the clean
    // baseline is re-measured right before the delayed one, so a machine that got busier between
    // the suite's own first run and this one cannot eat the margin. The bar is half the injected
    // delay: the delayed slope must clear the interleaved clean slope by at least 1 ms (of the 2
    // injected) - far past noise (the median fit's noise share is asserted elsewhere), thin enough
    // that a real 1 ms/frame regression cannot hide under it.
    // These legs measure the VIDEO fit alone (the delay is in the video path, and the trace fit is
    // asserted on the main run's numbers): each leg runs only the three heaviest video cases, so
    // the three extra measurements stay a fraction of the main run - the suite must fit CI's
    // 4-minute suite timeout with room, which the full 12-case legs blew (killed at 240 s in the
    // red gate run).
    const videoOnly = `/${byCost('frames', [0, 3, 10]).map((n) => '^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').join('|')}/`;   // spread in cost (2200, 1500, 680 frames): the heaviest three are all 2200 - same x, no slope
    const run = (env, sel) => {
      const m = cp.spawnSync(process.execPath, [path.join('tools', 'measure-regress-cost.js'), '--only', sel || only], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...env } });
      return (m.stdout || '') + (m.stderr || '');
    };
    const co = run({ DELAY_MS: '0' }, videoOnly);
    const cf2 = fitOf('video', co);
    const mo = run({ DELAY_MS: '2' }, videoOnly);
    const dv = fitOf('video', mo);
    const detected = dv !== null && Number.isFinite(dv.slope) && cf2 !== null && Number.isFinite(cf2.slope) && dv.slope > cf2.slope + 1.0;
    check('MUTANT (a per-frame delay injected into the measured path): the measurement detects the slower machine',
      detected, `clean video slope ${cf2 && cf2.slope.toFixed(3)} ms/frame (interleaved), delayed ${dv && Number.isFinite(dv.slope) ? dv.slope.toFixed(3) : dv}; ${(mo.match(/video:.*/) || [''])[0].slice(0, 100)}`);
    // the 0-ms mutant: the same injection with the delay off must NOT be reported as a regression -
    // the two interleaved runs of the same tree agree within the noise the median fit itself reports.
    // (This is the false-positive guard: the detection must see the delay, not the load.)
    const zero = run({ DELAY_MS: '0' }, videoOnly);
    const zv = fitOf('video', zero);
    const falseAlarm = zv !== null && Number.isFinite(zv.slope) && cf2 !== null && Number.isFinite(cf2.slope) && zv.slope > cf2.slope + 1.0;
    check('MUTANT (the injection present but the delay 0 ms): NOT reported as a regression (the two clean interleaved runs agree)',
      !falseAlarm, `clean ${cf2 && cf2.slope.toFixed(3)} vs clean again ${zv && zv.slope.toFixed(3)}`);
    // and the legs measured video alone - three video cases, none of the trace ones (the delay is
    // inside videoHash, so the trace fit is untouched BY CONSTRUCTION; the tool still prints a
    // trace line, the NaN of an empty fit)
    check('MUTANT (a per-frame delay injected into the measured path): the legs measured video alone (the delay is in the video path, nothing else)',
      /^measuring 3 cases, one process each\.\.\./.test(mo), `${(mo.split('\n')[0] || '').slice(0, 80)}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall measure-regress-cost checks passed');
process.exitCode = fail ? 1 : 0;
