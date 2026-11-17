// The shard completeness check (.github/scripts/browser-check-shards.js) must count only live group guards:
// a commented-out `want('x')` is a group that never runs, so it must not satisfy the check.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const assert = require('assert');
const script = path.join(__dirname, '..', '.github', 'scripts', 'browser-check-shards.js');
const real = fs.readFileSync(path.join(__dirname, '..', 'tools', 'browser-check.js'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-'));

function run(src) {
  const f = path.join(dir, 'browser-check.js');
  fs.writeFileSync(f, src);
  return cp.spawnSync(process.execPath, [script], { env: { ...process.env, BROWSER_CHECK_SOURCE: f }, encoding: 'utf8' });
}
try {
  // The real file passes.
  const ok = cp.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.strictEqual(run(real).status, 0, 'copy of the real file must pass');

  // Pick a group the real file guards and comment its guard out, in each comment style.
  const m = real.match(/^.*\bif \(want\('([^']+)'\)\).*$/m);
  assert.ok(m, 'no `if (want(...))` line found to mutate');
  const [line, group] = m;
  assert.ok(real.split(`want('${group}')`).length === 2, `group ${group} guarded more than once; pick another`);
  for (const [name, replaced] of [['line comment', '// ' + line], ['block comment', '/* ' + line.replace(/\*\//g, '* /') + ' */']]) {
    const r = run(real.replace(line, replaced));
    assert.notStrictEqual(r.status, 0, `${name}: commented-out group '${group}' still passed`);
    assert.ok(r.stderr.includes(group), `${name}: failure should name '${group}': ${r.stderr}`);
  }
  // A '//' inside a string is not a comment.
  const r = run(real + `\nconst u = 'http://x'; if (want('zz-string-guard')) {}\n`);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes('zz-string-guard'), r.stderr);
  // A quote inside a regex literal must not hide a later commented-out guard; text in comments isn't a guard.
  const r2 = run(real + `\nconst re = /it's/.test(x);\n// if (want('zz-after-regex')) {}\n/* want('zz-in-block') */ x(); // want('zz-trailing')\n`);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  console.log('browser-check-shards self-test: ok');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
