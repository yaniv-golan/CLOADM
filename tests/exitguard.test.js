// The runtime exit guard (tests/no-exit.js) against every spelling the static scan cannot see.
// The static scan (tests/exitcode.test.js) matches one pattern; these all reach the same API. Run through the
// guard, each must FAIL the suite by name rather than exiting cleanly.
// Run: node tests/exitguard.test.js
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const GUARD = path.join(__dirname, 'no-exit.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitguard-'));

// Run `body` as a suite with the guard preloaded, or without it at all (guard: false).
function suite(body, { guard = true } = {}) {
  const f = path.join(dir, 's.test.js');
  fs.writeFileSync(f, body + '\n');
  const env = Object.assign({}, process.env);
  env.NODE_OPTIONS = guard ? `--require ${JSON.stringify(GUARD)}` : '';
  const r = cp.spawnSync(process.execPath, [f], { encoding: 'utf8', env, timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Each of these is the same escape the static scan misses, and each must fail.
const SPELLINGS = [
  ['a bracket property', `console.log('all passed'); process['exit'](0);`],
  ['globalThis.process.exit', `console.log('all passed'); globalThis.process.exit(0);`],
  ['a destructured exit', `const { exit } = process; console.log('all passed'); exit(0);`],
  ['an aliased exit', `const q = process.exit; console.log('all passed'); q(0);`],
  ['a template literal', `const n = 'ex' + 'it'; console.log('all passed'); process[n](0);`],
  ['a regex containing a quote', `const re = /['"]/; console.log('all passed'); process.exit(0);`],
  ['reallyExit', `console.log('all passed'); process.reallyExit(0);`],
  ['kill of its own group', `console.log('all passed'); process.kill(-process.pid, 'SIGKILL');`],
];
for (const [what, body] of SPELLINGS) {
  const r = suite(body);
  check(`${what}: the gate fails it`, r.code !== 0, `exit ${r.code}`);
  check(`${what}: and says which spelling`, /FAIL [^\s]+: process\.exit\(\) called at \d+: /.test(r.out), r.out.split('\n').filter((l) => /FAIL/.test(l))[0] || '(no FAIL line)');
}

// A suite that calls exit(0) after passing must NOT be reported as passed.
{
  const r = suite(`console.log('all passed'); process.exit(0);`);
  check('exit(0) from a passing suite still fails the run (not mistaken for success)', r.code !== 0);
  check('the guard names the caller file, in the shared shape', /FAIL [^\s]*s\.test\.js: process\.exit\(\) called at \d+: process\.exit\(\) \(code 0\)/.test(r.out),
    (r.out.match(/FAIL .*/) || [''])[0].trim());
}

// Not vacuous: the same body WITHOUT the guard exits 0 and passes, so the failures above are the guard.
{
  const r = suite(`console.log('all passed'); process.exit(0);`, { guard: false });
  check('without the guard the same suite exits 0 (so the guard is what fails it)', r.code === 0, `exit ${r.code}`);
}

// A suite that never calls it is untouched.
{
  const r = suite(`let n = 0; for (let i = 0; i < 10; i++) n++; console.log(n === 10 ? 'all passed' : 'bad'); process.exitCode = n === 10 ? 0 : 1;`);
  check('a suite that sets exitCode and returns passes through untouched', r.code === 0, `exit ${r.code}`);
  check('and it prints no guard line', !/FAIL .*: process\.exit\(\) called at/.test(r.out));
}

// A child node process inherits the guard through NODE_OPTIONS -- the coordinator's requirement.
{
  // The child inherits NODE_OPTIONS and is guarded, so IT fails; a parent that ignores the child's status
  // still passes, which is right -- the guard marks the process that called exit, and a suite is free to spawn
  // a deliberately failing child. What matters is that the guard reached the child at all.
  const r = suite(`const cp = require('child_process');
const c = cp.spawnSync(process.execPath, ['-e', "console.log('child ran'); process.exit(0);"], { encoding: 'utf8' });
console.log('CHILDSTATUS ' + c.status + ' ' + (c.stdout || '').trim());
console.log('all passed');`);
  check('a spawned child node process is guarded too (NODE_OPTIONS reaches it)', /CHILDSTATUS 1 child ran/.test(r.out),
    (r.out.match(/CHILDSTATUS.*/) || [''])[0].trim());
  check('the guard\'s FAIL line is in the child output the parent captured', /FAIL [^\s]+: process\.exit\(\) called at \d+:/.test(r.out));
}

// A swallowed throw must still fail the gate: the FAIL line and exitCode = 1 are set BEFORE the throw, so a
// suite that catches it and carries on cannot pass.
{
  const r = suite(`try { process.exit(0); } catch (e) { console.log('swallowed'); }
console.log('all passed');`);
  check('a suite that catches the blocked exit still fails', r.code !== 0, `exit ${r.code}`);
  check('and the FAIL line was printed before the throw', /FAIL [^\s]+: process\.exit\(\)/.test(r.out));
  const r2 = suite(`process.on('uncaughtException', (e) => console.log('caught async'));
Promise.resolve().then(() => process.exit(0)).catch(() => {});
setTimeout(() => { console.log('all passed'); }, 50);`);
  check('a promise .catch cannot swallow it into a pass either', r2.code !== 0, `exit ${r2.code}`);
}

// EVERY call throws, not just the first. A suite that catches the first throw and calls exit() again must not
// get a silent return from the second call and then carry on to the end.
{
  const r = suite(`try { process.exit(0); } catch (e) { console.log('first swallowed'); }
process.exit(0);
console.log('MUST NOT REACH');`);
  // Node's uncaught-error trace echoes the source line that threw, so "MUST NOT REACH" can appear there even
  // though it never ran. Look for the marker printed on its own line by console.log, which is what "ran" means.
  const ran = (out) => out.split('\n').some((l) => l.trim() === 'MUST NOT REACH');
  check('a second process.exit() also stops the suite', !ran(r.out), r.out.split('\n').filter((l) => l.includes('MUST NOT')).join(' | '));
  check('...and the run still fails', r.code !== 0, `exit ${r.code}`);
  // A suite that catches every throw CAN still reach its own end -- the guard cannot stop code that swallows
  // it. What it must guarantee is that such a suite fails rather than passes, which exitCode = 1 does, set
  // before the first throw.
  const many = suite(`for (let i = 0; i < 5; i++) { try { process.exit(0); } catch (e) {} }
console.log('all passed');`);
  check('a suite that swallows every throw still fails the gate', many.code !== 0, `exit ${many.code}`);
  const lines = (many.out.match(/FAIL [^\n]*process\.exit/g) || []).length;
  check('...and the FAIL line is printed once, not five times', lines === 1, `${lines} line(s)`);
}

// The gate, not just the process: a suite that swallows the guard's throw AND undoes exitCode must still fail.
// This is why tests/all.js checks the guard's stdout line rather than trusting the exit status -- an 'exit'
// listener the suite registers runs after the guard's and can set exitCode back to 0, so the status alone lies.
// The suite cannot take back what it printed.
{
  const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitgate-'));
  const gateTests = path.join(gateDir, 'tests');
  fs.mkdirSync(gateTests, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'all.js'), path.join(gateTests, 'all.js'));
  fs.copyFileSync(path.join(__dirname, 'no-exit.js'), path.join(gateTests, 'no-exit.js'));

  const probes = [
    ['an aliased exit swallowed by try/catch', "const { exit } = process;\ntry { exit(0); } catch (e) {}\nconsole.log('all passed');"],
    ['an exit handler that resets exitCode to 0', "process.on('exit', () => { process.exitCode = 0; });\ntry { process.exit(0); } catch (e) {}\nconsole.log('all passed');"],
  ];
  for (const [name, body] of probes) {
    fs.writeFileSync(path.join(gateTests, 'zz-probe.test.js'), body + '\n');
    const r = cp.spawnSync(process.execPath, [path.join(gateTests, 'all.js')],
      { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { CLOADM_EXIT_GUARD_QUIET: '' }) });
    const out = (r.stdout || '') + (r.stderr || '');
    const named = new RegExp(`FAIL  zz-probe\\.test\\.js`).test(out);
    check(`the gate fails a suite with ${name}`, r.status !== 0 && named,
      r.status !== 0 ? (named ? '' : 'suite not named as failing') : 'gate exited 0');
  }
  fs.rmSync(gateDir, { recursive: true, force: true });
}

// A sharded suite is a child process too, and it goes through the same spawnSuite. Before guardEnv was installed
// there, a shard ran unguarded: a live exit reached only inside `if (process.argv.includes('--shard'))` was never
// seen, and runSharded reported the suite as passing. This drives the real runner: a copy of all.js whose SHARDS
// map includes the probe suite, so the ordinary shard machinery spawns it.
{
  const shardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-shard-'));
  const shardTests = path.join(shardDir, 'tests');
  fs.mkdirSync(shardTests, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'no-exit.js'), path.join(shardTests, 'no-exit.js'));
  // the runner, with SHARDS extended so the probe suite really is spawned as two shards
  let runner = fs.readFileSync(path.join(__dirname, 'all.js'), 'utf8');
  runner = runner.replace("const SHARDS = { 'regress.test.js':",
    "const SHARDS = { 'zz-shardprobe.test.js': 2, 'regress.test.js':");
  fs.writeFileSync(path.join(shardTests, 'all.js'), runner);
  // a suite whose live exit is reachable ONLY in a shard, and which undoes its own exitCode
  fs.writeFileSync(path.join(shardTests, 'zz-shardprobe.test.js'), [
    "if (process.argv.includes('--shard')) {",
    "  process.on('exit', () => { process.exitCode = 0; });",
    "  try { process.exit(0); } catch (e) {}",
    '}',
    "console.log('all passed');",
  ].join('\n') + '\n');

  const r = cp.spawnSync(process.execPath, [path.join(shardTests, 'all.js'), '--jobs', '2'],
    { encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  check('a live exit reached only inside a regress-style shard fails the gate', r.status !== 0,
    r.status !== 0 ? '' : 'the gate exited 0');
  check('...and the sharded suite is reported failed, not passed', /FAIL  zz-shardprobe\.test\.js/.test(out),
    out.split('\n').filter((l) => /zz-shardprobe/.test(l)).slice(0, 2).join(' | ') || '(no line)');
  check('...with the guard naming it from inside the shard', /FAIL .*zz-shardprobe.*process\.exit\(\) called at/.test(out));
  fs.rmSync(shardDir, { recursive: true, force: true });
}

// The tools exemption, tested where it actually decides: in a process whose entry script is each of these.
{
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `--require ${JSON.stringify(GUARD)}` });
  const runWith = (file) => cp.spawnSync(process.execPath, [file], { encoding: 'utf8', env, timeout: 20000 });
  // 1a. a TOP-LEVEL tools entry script: NOT guarded (gen-rom-docs.js ends with exit(0), which is how it says
  // "the list is already right"). Written into this repo's own tools/ so the rule resolves against the real
  // directory, then removed.
  const probe = (rel) => {
    const f = path.join(__dirname, '..', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "console.log('tool ok'); process.exit(0);\n");
    const r = runWith(f);
    fs.rmSync(f, { force: true });
    return r;
  };
  const t = probe('tools/zz-exitguard-probe.js');
  check('a top-level tools entry script is NOT guarded', t.status === 0 && /tool ok/.test(t.stdout), `exit ${t.status}`);
  // 1b. a NESTED tools entry script: also not guarded. A nested tool uses exit(0) as a success signal just as a
  // top-level one does (the rule is the tools/ directory, not its depth), so exempting one and not the other
  // would be arbitrary.
  const n = probe('tools/zz-nested/run.js');
  check('a nested tools entry script is NOT guarded', n.status === 0 && /tool ok/.test(n.stdout), `exit ${n.status}`);
  // 2. a helper under tests/tools/: guarded, so the rule cannot be fooled by a directory name
  const fake = path.join(dir, 'tests', 'tools'); fs.mkdirSync(fake, { recursive: true });
  const helper = path.join(fake, 'helper.js');
  fs.writeFileSync(helper, "console.log('helper ran'); process.exit(0);\n");
  const h = runWith(helper);
  check('a helper at tests/tools/ IS guarded (the rule is a resolved path, not a name match)', h.status !== 0, `exit ${h.status}`);
  // 3. an -e child has no entry script, so it must stay guarded
  const e = cp.spawnSync(process.execPath, ['-e', "console.log('e ran'); process.exit(0);"], { encoding: 'utf8', env, timeout: 20000 });
  check('an -e child (no entry script) IS guarded', e.status !== 0, `exit ${e.status}`);
  // 4. a suite itself: guarded
  const st = suite("console.log('all passed'); process.exit(0);");
  check('a suite IS guarded', st.code !== 0, `exit ${st.code}`);
}

// The guard must not silence a suite's own failure output.
{
  const r = suite(`console.log('3 FAILED'); process.exitCode = 1;`);
  check('a failing suite keeps its own exit code and output', r.code === 1 && /3 FAILED/.test(r.out));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
