// .github/scripts/install-browser-deps.sh decides how the CI browser jobs get chromium's OS packages: nothing to do,
// the cached .deb files, or the mirror. Every decision rests on Playwright's own check (`install-deps --dry-run`), and
// the step must never succeed unless that check passes at the end. This runs the real script with stub commands on
// PATH (npx, sudo, timeout, apt-get, dpkg), in a scratch directory, and checks each path and its limits:
//   - all present: nothing installed, apt never run;
//   - a cache hit: dpkg -i of the missing packages' files only (never a cached file of a package the image has, which
//     dpkg would downgrade), no apt-get update;
//   - no cache: the mirror; only the missing packages' .deb files are kept for the cache, not whatever else apt fetched;
//     apt's time limits are written before any apt command runs;
//   - a cache that does not satisfy the check: falls through to the mirror, repairing with apt-get install -f first;
//   - a mirror that keeps failing: two tries, then a loud failure;
// and that removing the check after dpkg (the reviewer's mutant) turns this suite red.
// Run: node tests/install-browser-deps.test.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const SCRIPT = path.join(__dirname, '..', '.github', 'scripts', 'install-browser-deps.sh');
const REAL = fs.readFileSync(SCRIPT, 'utf8');
const NEEDED = ['fonts-unifont', 'xfonts-utils'];   // what Playwright's list needs that the "image" lacks

// The stubs keep their state in $STATE: installed (one package per line), calls (a log), and switches.
const STUBS = {
  npx: `#!/usr/bin/env bash
echo "npx $*" >> "$STATE/calls"
[ "$1 $2 $3" = "playwright install chromium" ] && exit 0
if [ "$*" = "playwright install-deps --dry-run chromium" ]; then
  miss=(); for p in $NEEDED; do grep -qx "$p" "$STATE/installed" || miss+=("$p"); done
  if [ \${#miss[@]} -eq 0 ]; then echo "All system dependencies are installed."; exit 0; fi
  echo "Missing system dependencies (\${#miss[@]}):"; for p in "\${miss[@]}"; do echo "  $p"; done; exit 1
fi
if [ "$*" = "playwright install-deps chromium" ]; then
  [ -e "$STATE/mirror-fails" ] && { echo "E: mirror unreachable"; exit 100; }
  mkdir -p "$APT_ARCHIVES"
  for p in $NEEDED libgbm1; do echo "$p" >> "$STATE/installed"; : > "$APT_ARCHIVES/\${p}_1.0_amd64.deb"; done
  exit 0
fi
exit 99
`,
  sudo: '#!/usr/bin/env bash\nexec "$@"\n',
  timeout: '#!/usr/bin/env bash\nshift\nexec "$@"\n',
  'apt-get': `#!/usr/bin/env bash
echo "apt-get $* conf=$([ -s "$APT_CONF" ] && echo yes || echo no)" >> "$STATE/calls"
[ "$1" = update ] && [ -e "$STATE/mirror-fails" ] && exit 100
exit 0
`,
  dpkg: `#!/usr/bin/env bash
echo "dpkg $*" >> "$STATE/calls"
[ "$1" = -i ] || exit 0
shift
[ -e "$STATE/dpkg-noop" ] && exit 0      # "succeeds" without installing anything the check sees
for f in "$@"; do b=$(basename "$f"); echo "\${b%%_*}" >> "$STATE/installed"; done
exit 0
`,
};

function run({ installed = [], cached = [], mirrorFails = false, dpkgNoop = false, script = REAL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibd-'));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'state'), debs = path.join(dir, 'debs'), arch = path.join(dir, 'archives');
  for (const d of [bin, state, debs]) fs.mkdirSync(d);
  for (const [n, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, n), body, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'installed'), installed.map((p) => p + '\n').join(''));
  fs.writeFileSync(path.join(state, 'calls'), '');
  if (mirrorFails) fs.writeFileSync(path.join(state, 'mirror-fails'), '');
  if (dpkgNoop) fs.writeFileSync(path.join(state, 'dpkg-noop'), '');
  for (const p of cached) fs.writeFileSync(path.join(debs, `${p}_0.9_amd64.deb`), '');
  const sh = path.join(dir, 'install.sh');
  fs.writeFileSync(sh, script, { mode: 0o755 });
  const r = cp.spawnSync('bash', [sh], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state, NEEDED: NEEDED.join(' '), DEBS_DIR: debs,
      APT_CONF: path.join(dir, 'apt.conf'), APT_ARCHIVES: arch, PAUSE: '0' },
  });
  const res = {
    status: r.status, out: (r.stdout || '') + (r.stderr || ''),
    calls: fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n').filter(Boolean),
    kept: fs.readdirSync(debs).sort(),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}
const has = (r, re) => r.calls.some((c) => re.test(c));
const says = (r, re) => re.test(r.out);

// 1. all present
{
  const r = run({ installed: NEEDED });
  check('all present: exits 0 and says so', r.status === 0 && says(r, /OS packages: all present, nothing to install/), r.out.trim().split('\n').pop());
  check('...and installs nothing (no dpkg, no apt-get)', !has(r, /^dpkg|^apt-get/), r.calls.join(' | '));
}
// 2. a cache hit, holding one file of a package the image already has (libgbm1): only the missing ones go to dpkg
{
  const r = run({ installed: ['libgbm1'], cached: [...NEEDED, 'libgbm1'] });
  check('cache hit: exits 0, installed from the cache', r.status === 0 && says(r, /installed from the cache \(2 \.deb files\)/), r.out.trim().split('\n').pop());
  const d = r.calls.find((c) => /^dpkg -i/.test(c)) || '';
  check('...dpkg -i gets exactly the missing packages\' files', NEEDED.every((p) => d.includes(`/${p}_`)) && !d.includes('libgbm1'), d);
  check('...and no apt-get at all (no mirror)', !has(r, /^apt-get/), r.calls.join(' | '));
}
// 3. no cache: the mirror; the kept files are the missing packages' only; apt's limits written before apt runs
{
  const r = run({});
  check('no cache: exits 0, installed from the mirror', r.status === 0 && says(r, /installed from the mirror; 2 \.deb files kept/), r.out.trim().split('\n').pop());
  check('...the cache keeps only the missing packages, not what else apt fetched', JSON.stringify(r.kept) === JSON.stringify(NEEDED.map((p) => `${p}_1.0_amd64.deb`)), r.kept.join(' '));
  check('...apt\'s time limits are in place before apt-get update runs', has(r, /^apt-get update conf=yes$/) && !has(r, /conf=no/), r.calls.filter((c) => /^apt-get/.test(c)).join(' | '));
  check('...and the check ran again after the install', r.calls.filter((c) => /--dry-run/.test(c)).length === 2, `${r.calls.filter((c) => /--dry-run/.test(c)).length} checks`);
}
// 4. a cache whose files do not satisfy the check: the mirror, after apt-get install -f
{
  const r = run({ cached: NEEDED, dpkgNoop: true });
  check('cache that does not satisfy the check: not reported as installed from the cache', !says(r, /installed from the cache/), r.out.trim().split('\n').slice(-2).join(' | '));
  check('...repairs with apt-get install -f, then installs from the mirror', has(r, /^apt-get install -f -y/) && has(r, /^apt-get update/) && r.status === 0 && says(r, /installed from the mirror/),
    r.calls.join(' | '));
}
// 5. a mirror that keeps failing: two tries, then a loud failure
{
  const r = run({ mirrorFails: true });
  check('a failing mirror: exits 1, saying the browser check did not run', r.status === 1 && says(r, /could not be installed in 2 tries.*the browser check did not run/), r.out.trim().split('\n').pop());
  check('...after exactly two tries', r.calls.filter((c) => /^apt-get update/.test(c)).length === 2, `${r.calls.filter((c) => /^apt-get update/.test(c)).length} updates`);
}
// 6. the mutant the review ran by hand: without the check after dpkg, case 4 reads as installed from the cache
{
  const mutant = REAL.replace('if timeout 60 sudo dpkg -i "${debs[@]}" && check "$out"; then', 'if timeout 60 sudo dpkg -i "${debs[@]}"; then');
  const r = run({ cached: NEEDED, dpkgNoop: true, script: mutant });
  check('the mutant (no check after dpkg) is a real change to the script', mutant !== REAL);
  check('...and case 4 catches it: it would report a cache install that left packages missing', says(r, /installed from the cache/) && r.status === 0,
    'the mutant must be the one that passes wrongly here; the real script is held by case 4 above');
}
// Both workflows run this one script, under a step time limit.
for (const wf of ['tests.yml', 'browser-daily.yml']) {
  const t = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', wf), 'utf8');
  check(`${wf} installs through the script, with a step time limit and a cache keyed on the runner image`,
    /timeout-minutes: \d+\n\s+run: \.github\/scripts\/install-browser-deps\.sh/.test(t) && /key: playwright-debs-[\d.]+-\$\{\{ steps\.image\.outputs\.image \}\}/.test(t));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
