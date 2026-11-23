// CI runs the gate as n parts (`node tests/all.js --shard i/n`), and the `gates` job holds the parts to being the
// whole gate with .github/scripts/suite-shards.js. This runs the real tests/all.js in a scratch tests/ directory with
// a handful of stand-in suites and a stand-in regress.test.js, and checks:
//   - the parts are disjoint and together are every suite `--list` prints; each part says "shard i/n: k of N";
//     exactly one part checks the regression gate's completeness; a failing suite fails its part by name;
//   - bad --shard values, and --shard with --only, are usage errors (exit 2), never a run;
//   - the completeness check passes on the parts' real logs, and fails on each way a part can go missing: a part
//     that did not report, a suite dropped from the parts, a suite in two parts, an incomplete regression gate, parts
//     that disagree on n, and a part that stopped before its count line.
// Run: node tests/suite-shards.test.js
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const TESTS = __dirname, ROOT = path.join(__dirname, '..');
const CHECKER = path.join(ROOT, '.github', 'scripts', 'suite-shards.js');

// The stand-in suites' bodies print through LOG, so the static readers in tests/allsummary.test.js (one summary per
// suite, no unconditional FAIL line) read this file's own output, not what its stand-ins print when the runner runs them.
const LOG = ['console', 'log'].join('.');
const REGRESS = `const a = process.argv, T = 12;
if (a.includes('--count')) ${LOG}(T + ' regression cases');
else {
  const s = a.includes('--shard') ? a[a.indexOf('--shard') + 1] : null, k = T / (s ? Number(s.split('/')[1]) : 1);
  ${LOG}(k + '/' + k + ' regression hashes' + (s ? ', shard ' + s : '') + ' match (0.0 s)');
}
`;
const OK = `${LOG}('all passed');\n`;
const BAD = `${LOG}('FAIL something'); process.exitCode = 1;\n`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-shards-'));
const tests = path.join(dir, 'tests');
fs.mkdirSync(tests);
for (const f of ['all.js', 'no-exit.js', 'suite-verdict.js']) fs.copyFileSync(path.join(TESTS, f), path.join(tests, f));
fs.writeFileSync(path.join(tests, 'regress.test.js'), REGRESS);
const names = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'].map((n) => `${n}.test.js`);
for (const n of names) fs.writeFileSync(path.join(tests, n), OK);
// times: regress the longest, then the rest, so the plan is not just the file order
fs.writeFileSync(path.join(tests, 'suite-times.json'), JSON.stringify({ suites: { 'regress.test.js': 50, 'aa.test.js': 20, 'gg.test.js': 19, 'cc.test.js': 5 } }));

const all = (...args) => {
  const r = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '1', ...args], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const checker = (logs, env = {}) => {
  const r = cp.spawnSync(process.execPath, [CHECKER, ...logs], { encoding: 'utf8', env: { ...process.env, SUITE_LIST_FROM: listFile, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const suiteLines = (out) => [...out.matchAll(/^(?:pass|FAIL) {2}(\S+\.test\.js) /gm)].map((m) => m[1]);
const logFile = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

let listFile;
try {
  // --list: the gate's suites, nothing run
  const list = all('--list');
  const listed = list.out.trim().split('\n');
  check('--list prints every suite and runs nothing', list.status === 0 && listed.length === names.length + 1 && !/pass {2}/.test(list.out), list.out.replace(/\n/g, ' '));
  listFile = logFile('list.txt', list.out);

  // the three parts
  const parts = [1, 2, 3].map((k) => all('--shard', `${k}/3`));
  const ran = parts.map((p) => suiteLines(p.out));
  check('every part exits 0', parts.every((p) => p.status === 0), parts.map((p) => p.status).join(','));
  check('the parts are disjoint and together every suite', JSON.stringify(ran.flat().sort()) === JSON.stringify([...listed].sort())
    && new Set(ran.flat()).size === ran.flat().length, JSON.stringify(ran));
  check('no part is empty, and the plan follows the times (regress alone with the 1 s suites elsewhere)', ran.every((r) => r.length > 0) && ran.some((r) => r.length === 1 && r[0] === 'regress.test.js'), JSON.stringify(ran));
  check('each part says "shard i/n: k of N suites run, all passed"', parts.every((p, i) => new RegExp(`^shard ${i + 1}/3: ${ran[i].length} of ${listed.length} suites run, all passed$`, 'm').test(p.out)));
  check('exactly one part checks the regression gate', parts.filter((p) => /^regress 12\/12 included/m.test(p.out)).length === 1);
  check('a part never claims to be the whole gate', parts.every((p) => !/all \d+ suites passed/.test(p.out)));
  const logs = parts.map((p, i) => logFile(`all-${i + 1}.log`, p.out));

  // --timings writes the part's suite times
  const tf = path.join(dir, 't.json');
  all('--shard', '1/3', '--timings', tf);
  const timed = JSON.parse(fs.readFileSync(tf, 'utf8')).suites;
  check('--timings writes the seconds of the suites that ran', Object.keys(timed).sort().join() === [...ran[0]].sort().join() && Object.values(timed).every((s) => s >= 0), JSON.stringify(timed));

  // usage errors
  for (const bad of [['--shard', '0/3'], ['--shard', '4/3'], ['--shard', 'x'], ['--shard'], ['--shard', '1/3', '--only', 'aa']]) {
    const r = all(...bad);
    check(`${bad.join(' ')} is a usage error (exit 2), not a run`, r.status === 2 && !suiteLines(r.out).length, `${r.status}: ${r.out.trim()}`);
  }

  // a failing suite fails its part, by name
  fs.writeFileSync(path.join(tests, 'dd.test.js'), BAD);
  const k = ran.findIndex((r) => r.includes('dd.test.js')) + 1;
  const red = all('--shard', `${k}/3`);
  check('a failing suite fails its part and is named', red.status === 1 && /^FAILED: dd\.test\.js$/m.test(red.out) && new RegExp(`^shard ${k}/3: .* 1 FAILED$`, 'm').test(red.out),
    red.out.split('\n').slice(-3).join(' | '));
  fs.writeFileSync(path.join(tests, 'dd.test.js'), OK);

  // the completeness check
  const good = checker(logs);
  check('the completeness check passes on the three parts', good.status === 0 && /all\.js shards complete: 8 suites in 3 parts/.test(good.out), good.out.trim());
  const fails = (what, r, re) => check(`completeness check fails: ${what}`, r.status === 1 && re.test(r.out), r.out.trim().split('\n').slice(1).join(' | '));
  fails('a part that did not report', checker(logs.slice(0, 2)), /shard 3 of 3 did not report/);
  fails('no part at all', checker([]), /no shard logs given/);
  const text = logs.map((f) => fs.readFileSync(f, 'utf8'));
  const victim = ran.findIndex((r) => r.includes('bb.test.js'));
  const dropped = text.map((t, i) => (i === victim ? t.replace(/^pass {2}bb\.test\.js .*\n/m, '') : t));
  fails('a suite dropped from the parts', checker(dropped.map((t, i) => logFile(`drop-${i}.log`, t))), /in no part \(never ran\): bb\.test\.js/);
  const other = (victim + 1) % 3;
  const twice = text.map((t, i) => (i === other ? t + 'pass  bb.test.js             0.1 s\n' : t));
  fails('a suite in two parts', checker(twice.map((t, i) => logFile(`twice-${i}.log`, t))), /in more than one part: bb\.test\.js/);
  const rk = parts.findIndex((p) => /^regress /m.test(p.out));
  const incomplete = text.map((t, i) => (i === rk ? t.replace(/^regress 12\/12 included.*$/m, 'regress 9/12 included (1 of 1 shard reported, 9 cases run) -- INCOMPLETE') : t));
  fails('an incomplete regression gate', checker(incomplete.map((t, i) => logFile(`inc-${i}.log`, t))), /INCOMPLETE/);
  const noRegress = text.map((t, i) => (i === rk ? t.replace(/^regress .*\n/m, '') : t));
  fails('a regression gate nobody checked', checker(noRegress.map((t, i) => logFile(`noreg-${i}.log`, t))), /checked 0 times/);
  const otherN = text.map((t, i) => (i === 0 ? t.replace(/^shard 1\/3:/m, 'shard 1/4:') : t));
  fails('parts that disagree on n', checker(otherN.map((t, i) => logFile(`n-${i}.log`, t))), /disagree on how many/);
  const stopped = text.map((t, i) => (i === 1 ? t.replace(/^shard 2\/3:.*$/m, '') : t));
  fails('a part that stopped before its count line', checker(stopped.map((t, i) => logFile(`stop-${i}.log`, t))), /no "shard i\/n: k of total suites run" line/);
  const miscount = text.map((t, i) => (i === 0 ? t.replace(/^shard 1\/3: \d+ of/m, 'shard 1/3: 99 of') : t));
  fails('a count that does not match the part\'s suite lines', checker(miscount.map((t, i) => logFile(`mis-${i}.log`, t))), /says 99 suites but printed/);
  fails('a suite list the parts do not match (a suite added to the gate)', checker(logs, { SUITE_LIST_FROM: logFile('list2.txt', list.out + 'zz.test.js\n') }), /in no part \(never ran\): zz\.test\.js/);

  // the real tree: --list is the suites all.js runs, and every name in suite-times.json is a suite (a stale name only
  // unbalances the parts, but it is a sign the file needs refreshing)
  const real = cp.execFileSync(process.execPath, [path.join(TESTS, 'all.js'), '--list'], { encoding: 'utf8' }).trim().split('\n');
  const onDisk = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js') && !f.startsWith('fixture-')).sort();
  check('the real --list is every tests/*.test.js but the fixtures', JSON.stringify(real) === JSON.stringify(onDisk), `${real.length} vs ${onDisk.length}`);
  const times = JSON.parse(fs.readFileSync(path.join(TESTS, 'suite-times.json'), 'utf8')).suites;
  const stale = Object.keys(times).filter((f) => !onDisk.includes(f));
  check('tests/suite-times.json names only real suites, and most of them', stale.length === 0 && Object.keys(times).length >= onDisk.length * 0.9,
    stale.length ? `not suites: ${stale.join(', ')} (refresh: node tests/all.js --timings tests/suite-times.json)` : `${Object.keys(times).length} of ${onDisk.length} timed`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(fail ? `${fail} suite-shards check(s) FAILED` : 'all suite-shards checks passed');
process.exitCode = fail ? 1 : 0;
