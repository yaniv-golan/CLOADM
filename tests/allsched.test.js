// The runner's schedule (tests/all.js): suites start longest first from tests/suite-times.json while the output stays
// in file order, each shard of a sharded suite takes a slot of the pool (never more than --jobs processes at once),
// and --record-times writes the times only after a passing full run.
//
// Uses a scratch copy of the runner with probe suites that log when they start and end. The real tree is only read.
// Run: node tests/allsched.test.js
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allsched-'));
const tests = path.join(dir, 'tests'), LOG = path.join(dir, 'log.txt');
fs.mkdirSync(tests, { recursive: true });
for (const f of ['no-exit.js', 'suite-verdict.js']) fs.copyFileSync(path.join(__dirname, f), path.join(tests, f));
// the runner, with the probe zz-shard sharded in two, so the ordinary shard machinery spawns it
fs.writeFileSync(path.join(tests, 'all.js'), fs.readFileSync(path.join(__dirname, 'all.js'), 'utf8')
  .replace("const SHARDS = { 'regress.test.js':", "const SHARDS = { 'zz-shard.test.js': 2, 'regress.test.js':"));
// a stand-in regression gate, complete, so a full run can pass (as in tests/allsummary.test.js; its line joined at run
// time for the same reason as the probes' below)
fs.writeFileSync(path.join(tests, 'regress.test.js'), `const a = process.argv;
if (a.includes('--count')) console.log('2 regression cases');
else console.log(['2/2 regression', 'hashes match (0.0 s)'].join(' '));
`);
// A probe: logs its start, works for `ms`, logs its end, prints its summary (joined at run time, so the static
// summary scan in tests/allsummary.test.js does not read it as a second summary of this file). PROBE_FAIL=<name> makes that one fail.
const probe = (name, ms) => `const fs = require('fs'), id = ${JSON.stringify(name)} + (process.argv.includes('--shard') ? '#' + process.argv[process.argv.indexOf('--shard') + 1] : '');
fs.appendFileSync(process.env.ALLSCHED_LOG, 'start ' + id + ' ' + Date.now() + '\\n');
setTimeout(() => {
  fs.appendFileSync(process.env.ALLSCHED_LOG, 'end ' + id + ' ' + Date.now() + '\\n');
  if (process.env.PROBE_FAIL === ${JSON.stringify(name)}) { console.log('FAIL ' + 'on purpose'); process.exitCode = 1; }
  else console.log(['all', 'passed'].join(' '));
}, ${ms});
`;
// file order: pa, pb, pc, regress, zz-shard. pc is by far the longest; zz-shard is two shards of 5 s each.
fs.writeFileSync(path.join(tests, 'pa.test.js'), probe('pa', 400));
fs.writeFileSync(path.join(tests, 'pb.test.js'), probe('pb', 400));
fs.writeFileSync(path.join(tests, 'pc.test.js'), probe('pc', 1500));
fs.writeFileSync(path.join(tests, 'zz-shard.test.js'), probe('zz', 600));
const TIMES = path.join(tests, 'suite-times.json');
const times = { 'pa.test.js': 1, 'pb.test.js': 1, 'pc.test.js': 50, 'regress.test.js': 0.1, 'zz-shard.test.js': 10 };
fs.writeFileSync(TIMES, JSON.stringify({ '//': 'a note that --record-times keeps', suites: times }));

// the runner as the gate runs it: without the exit guard on itself (see tests/allsignal.test.js)
const env = Object.assign({}, process.env, { ALLSCHED_LOG: LOG,
  NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--require\s+("[^"]*no-exit\.js"|\S*no-exit\.js)/g, '').trim() });
const gate = (args, extra = {}) => {
  fs.writeFileSync(LOG, '');
  const r = cp.spawnSync(process.execPath, [path.join(tests, 'all.js'), '--jobs', '2', ...args], { encoding: 'utf8', timeout: 120000, env: Object.assign({}, env, extra) });
  const events = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [kind, id, t] = l.split(' '); return { kind, id, t: Number(t) }; });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), events };
};
// the most probes running at once: ends before starts at the same millisecond (a slot freed and taken in one tick)
const peak = (events) => {
  let n = 0, max = 0;
  for (const e of [...events].sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1))) { n += e.kind === 'start' ? 1 : -1; max = Math.max(max, n); }
  return max;
};

try {
  const r = gate([]);
  check('the scratch gate passes', r.status === 0 && new RegExp('all 5 suites ' + 'passed').test(r.out), r.status === 0 ? '' : r.out.slice(-300));
  const starts = r.events.filter((e) => e.kind === 'start').sort((a, b) => a.t - b.t).map((e) => e.id);
  // the first two are started together (two free slots), so which of them logs first is up to the OS: compared as a set
  check('the longest suites (by suite-times.json) start first: pc and a shard of zz, the short ones last',
    [starts[0], starts[1]].sort().join() === ['pc', starts.find((s) => /^zz#/.test(s))].sort().join() && starts.slice(3).sort().join() === 'pa,pb', starts.join(' '));
  check('every probe and both shards ran', starts.length === 5 && ['pa', 'pb', 'pc', 'zz#0/2', 'zz#1/2'].every((id) => starts.includes(id)), starts.join(' '));
  check('each shard takes a pool slot: never more than --jobs 2 processes at once', peak(r.events) <= 2, `peak ${peak(r.events)}`);
  const lines = r.out.split('\n').filter((l) => /^(pass|FAIL) /.test(l)).map((l) => l.split(/\s+/)[1]);
  check('the output is still in file order', JSON.stringify(lines) === JSON.stringify(['pa.test.js', 'pb.test.js', 'pc.test.js', 'regress.test.js', 'zz-shard.test.js']), lines.join(' '));

  // --record-times: only a full run, only a passing one
  const only = gate(['--only', 'pa', '--record-times']);
  check('--record-times with --only is refused (exit 2), times unchanged', only.status === 2 && /needs a full run/.test(only.out)
    && JSON.stringify(JSON.parse(fs.readFileSync(TIMES, 'utf8')).suites) === JSON.stringify(times));
  const part = gate(['--shard', '1/2', '--record-times']);
  check('--record-times with --shard is refused too (exit 2)', part.status === 2 && /needs a full run/.test(part.out), part.out.slice(-200));
  const bad = gate(['--record-times'], { PROBE_FAIL: 'pb' });
  check('--record-times after a failing run writes nothing', bad.status === 1 && /not written, the run failed/.test(bad.out)
    && JSON.stringify(JSON.parse(fs.readFileSync(TIMES, 'utf8')).suites) === JSON.stringify(times), bad.status === 1 ? '' : bad.out.slice(-200));
  const rec = gate(['--record-times']);
  const file = JSON.parse(fs.readFileSync(TIMES, 'utf8')), got = file.suites;
  check('--record-times after a passing full run writes every suite\'s time, in seconds, in the one format --shard reads (its note kept)', rec.status === 0
    && file['//'] === 'a note that --record-times keeps' && Object.keys(got).sort().join() === Object.keys(times).sort().join() && got['pc.test.js'] >= 1.4 && got['pc.test.js'] < 30, JSON.stringify(got));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
