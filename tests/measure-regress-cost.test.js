// Run: node tests/measure-regress-cost.test.js
//
// tools/measure-regress-cost.js is the tool tests/regress-shards.js cites for its constants. It lives in tools/ and
// reads tests/regress-hashes.json, so a wrong ROOT makes it die at once with ENOENT - which is exactly what happened
// when it moved and the constant still said __dirname. This runs it and requires it to produce a USEABLE fit, so a
// moved path cannot silently break it again.
//
// A fit is useable only if it HAS points and a positive slope. That is not a detail: with `--limit 2` every trace case
// is the same size, and the fit printed `trace: NaN (n=2)` and `video: NaN (n=0)` - the old check passed on those,
// because it only looked for the words "per instruction" and "per frame". So the cases are CHOSEN here: a few from
// each kind, spread in cost (the two heaviest traces, a light one, and the heaviest video runs), which makes the
// slope an order of magnitude bigger than the run-to-run noise. It is still not a test of the CONSTANTS (those are
// per-machine); it is a test that the tool reports a real measurement rather than an undefined one.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cloadm-regress-cost-'));
const before = leftovers().length;

// the names are in tests/regress-hashes.json, heavy and light: two floppy traces (9.4 M and 8.3 M instructions),
// a light trace, three 2200-frame video runs and one 1500-frame
const only = '/(blank vdk|blank jvc|^trace dragon32$|composite artifact 0|composite artifact 1|composite artifact 2|^video coco3$)/';
const r = cp.spawnSync(process.execPath, [path.join('tools', 'measure-regress-cost.js'), '--only', only], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const out = (r.stdout || '') + (r.stderr || '');
check('a moved ROOT would crash it at once (this is the regression that happened)', r.status === 0 && !/ENOENT/.test(out),
  (out.split('\n').find((l) => /ENOENT|Error/.test(l)) || out.split('\n')[0] || '').slice(0, 160));

// BOTH fits, parsed rather than pattern-matched: a number, a count, and a slope in the shape the tool prints
const fitOf = (label, text = out) => {
  const m = new RegExp(`${label}:\\s*(-?[\\d.]+(?:e[-+]?\\d+)?|NaN)\\s*(?:us per instruction|ms per frame)\\s*\\(n=(\\d+)\\)`).exec(text);
  return m ? { slope: Number(m[1]), n: Number(m[2]) } : null;
};
// THE requirement, in ONE place: a fit is useable only if it has at least two points and a finite, positive slope.
// The real run and the mutant below are both judged by this function, deliberately - if the mutant were judged by its
// own copy of the rule, disabling this one would leave that copy passing and the guard's removal would go unnoticed.
const useable = (f) => f !== null && f.n >= 2 && Number.isFinite(f.slope) && f.slope > 0;
const tf = fitOf('trace'), vf = fitOf('video');
check('it reaches a trace fit (it read tests/regress-hashes.json and ran the cases)', tf !== null, (out.match(/trace:.*/) || [''])[0].slice(0, 120));
check('it reaches a video fit', vf !== null, (out.match(/video:.*/) || [''])[0].slice(0, 120));
for (const [label, f] of [['trace', tf], ['video', vf]]) {
  if (!f) continue;
  check(`the ${label} fit has enough points to be a slope (not a single case, not none)`, f.n >= 2, `n=${f.n}`);
  check(`the ${label} fit is a finite, positive slope (not NaN, not a negative from noise)`,
    Number.isFinite(f.slope) && f.slope > 0, `${label} slope ${f.slope}`);
}
check('both fits are useable (the requirement the mutant below leans on)', useable(tf) && useable(vf),
  `trace ${JSON.stringify(tf)} video ${JSON.stringify(vf)}`);
check('it names how many cases it measured', /measuring \d+ cases/.test(out), (out.split('\n')[0] || '').slice(0, 80));
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

console.log(fail ? `\n${fail} FAILED` : '\nall measure-regress-cost checks passed');
process.exitCode = fail ? 1 : 0;
