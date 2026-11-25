// .github/scripts/install-browser-deps.sh decides how the CI browser jobs get chromium's OS packages: nothing to do,
// the cached .deb files, or the mirror. Every decision rests on Playwright's own check (`install-deps --dry-run`), and
// the step must never succeed unless that check passes at the end. This runs the real script with stub commands on
// PATH (npx, sudo, apt-get, dpkg), in a scratch directory, and checks each path and its limits:
//   - all present: nothing installed, apt never run;
//   - a cache hit: dpkg -i of the missing packages' files only (never a cached file of a package the image has, which
//     dpkg would downgrade), no apt-get update;
//   - no cache: the mirror; apt-get install of exactly the missing packages (--no-install-recommends, never a package
//     the image has), without translation lists; only the missing packages' .deb files are kept for the cache, not
//     whatever else apt fetched; apt's time limits are written before any apt command runs;
//   - a cache that does not satisfy the check: falls through to the mirror, repairing with apt-get install -f first;
//   - a mirror that keeps failing: three tries, each on a different mirror (azure.archive, then the image's own, then
//     archive.ubuntu.com, a named one through its own signed sources list), then a loud failure;
//   - a mirror that stalls mid-install (CI 45333139695, 45337281354): stopped at its limit, and the next try asks the
//     next mirror;
//   - an apt-get update that hangs past its limit while a child of it holds the dpkg lock (CI 45180359317): the whole
//     process group is stopped, so the lock is free and try 2 succeeds, and no stub process survives;
//   - a lock held by a process in a session of its own (as sudo starts apt-get: CI 45181201761), for a while: try 2
//     waits for it and succeeds;
//   - ...and for good: after the wait the holder is stopped (named in the output), and try 2 succeeds;
//   - the workflows restore the cache with a fallback to an earlier image's, and save it right after a good install;
//   - apt is told to wait for a lock at most LOCK_WAIT s (DPkg::Lock::Timeout);
//   - a killed holder leaves dpkg "interrupted" (the stub install-deps then fails, as apt does): the repair after the
//     kill, and the lock wait before every `dpkg --configure -a` (dpkg fails on a held lock), let the next try work;
//   - run as a user, the script re-runs itself under sudo once, with INSTALL_DEPS_AS_ROOT=1.
// Retrying the same mirror (MIRRORS reduced to one entry) turns cases 5 and 5b red; installing every package
// (dropping $need) turns case 3 red; removing the check after dpkg (the review's mutant) turns case 4 red; running commands without setsid turns case 6
// red; dropping the lock wait turns case 7 red; no lock wait before the repair turns case 8 red; no repair after a kill
// turns case 9 red; no re-run under sudo turns case 10 red.
// Run: node tests/install-browser-deps.test.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
// the one place a summary is printed (a suite has exactly one summary-shaped output: tests/allsummary.test.js), for the run
// that skips and the run that does not
function done(what) { console.log(fail ? `${fail} FAILED` : `all ${what} passed`); process.exitCode = fail ? 1 : 0; }
// The script runs only on Linux runners and the test drives it with setsid and /proc (the lock holders and the process
// groups it checks are Linux's): on a machine without them (macOS) the test says SKIP with that reason instead of failing
// with "setsid: command not found". On CI (CI set, on Linux) it never takes that path: a missing setsid there is a failure.
// -> the reason to skip, or null to run; throws when CI on Linux lacks what the test needs
const NEEDS = 'needs Linux: setsid and /proc';
function skipReason({ platform, env, haveSetsid, haveProc }) {
  if (haveSetsid && haveProc) return null;
  if (platform === 'linux' && env.CI) throw new Error(`CI on Linux must run this test, but ${haveSetsid ? '' : 'setsid '}${haveProc ? '' : '/proc '}is missing`);
  return NEEDS;
}
{
  const probe = { platform: 'linux', env: {}, haveSetsid: true, haveProc: true };
  const throws = (o) => { try { skipReason(Object.assign({}, probe, o)); return false; } catch (e) { return /CI on Linux must run/.test(e.message); } };
  check('skip rule: setsid and /proc present: run', skipReason(probe) === null);
  check('skip rule: no setsid on a Mac (no CI): skip, with the reason', skipReason(Object.assign({}, probe, { platform: 'darwin', haveSetsid: false, haveProc: false })) === NEEDS);
  check('skip rule: no setsid on Linux outside CI: skip, with the reason', skipReason(Object.assign({}, probe, { haveSetsid: false })) === NEEDS);
  check('skip rule: CI on Linux without setsid is a failure, never a skip', throws({ env: { CI: '1' }, haveSetsid: false }));
  check('skip rule: CI on Linux without /proc is a failure, never a skip', throws({ env: { CI: '1' }, haveProc: false }));
  check('skip rule: CI on a Mac is not Linux: skip', skipReason(Object.assign({}, probe, { platform: 'darwin', env: { CI: '1' }, haveSetsid: false })) === NEEDS);
}
{
  let reason;
  try {
    reason = skipReason({ platform: process.platform, env: process.env,
      haveSetsid: cp.spawnSync('sh', ['-c', 'command -v setsid >/dev/null']).status === 0, haveProc: fs.existsSync('/proc/self/fd') });
  } catch (e) { check('this machine can run the test (CI never skips it)', false, e.message); process.exitCode = 1; return; }
  if (reason) {
    console.log(`SKIP ${reason}`);
    // (the suites' verdict wants a summary line last: the skip rule's own cases are what ran)
    done('skip-rule checks');
    return;   // (module scope: nothing below runs)
  }
}
// the skip path end to end, as a machine without setsid takes it (an empty PATH here: no setsid, no sh to find it with): the
// SKIP line, a summary last as the suites' verdict wants it (tests/suite-verdict.js), exit 0; and on CI (CI set, on Linux)
// a failure, never that path
if (process.platform === 'linux') {
  const suiteVerdict = require('./suite-verdict');
  const run = (env) => cp.spawnSync(process.execPath, [__filename], { encoding: 'utf8', env: Object.assign({ PATH: '/nonexistent' }, env) });
  const noCi = run({}), ci = run({ CI: '1' });
  check('a machine without setsid: the run prints SKIP with the reason, a summary last, and exits 0',
    noCi.status === 0 && /^SKIP needs Linux: setsid and \/proc$/m.test(noCi.stdout) && suiteVerdict.hasSummary(noCi.stdout), `${noCi.status} ${noCi.stdout.split('\n').slice(-3).join(' | ')}`);
  check('CI on Linux without setsid: the run fails (a FAIL line, exit 1) and never prints SKIP', ci.status === 1 && /^FAIL /m.test(ci.stdout) && !/^SKIP /m.test(ci.stdout), `${ci.status} ${ci.stdout.split('\n').slice(-2).join(' | ')}`);
}
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
exit 99
`,
  // sudo: its options dropped, the command run as it is (the script re-runs itself under sudo when not root)
  sudo: '#!/usr/bin/env bash\necho "sudo $*" >> "$STATE/calls"\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n',
  // id -u: the uid the run pretends to have ($STATE/uid); anything else is the real id
  id: '#!/usr/bin/env bash\n[ "$1" = -u ] && { cat "$STATE/uid"; exit 0; }\nexec /usr/bin/id "$@"\n',
  // apt-get: fails as apt does when another process holds the lock; on its FIRST update, $STATE/hang makes it hang
  // with the lock held by a child in its group ("group") or by a process outside it ("escape", for $HOLD s). The mirror
  // is the one its -o Dir::Etc::SourceList file names, or "default"; an install from a mirror listed in
  // $STATE/stall hangs, and one from any mirror fails while dpkg is interrupted.
  'apt-get': `#!/usr/bin/env bash
mirror=default; args=()
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then case "$2" in Dir::Etc::SourceList=*) mirror=$(awk '{print $3; exit}' "\${2#*=}");; esac; shift 2; else args+=("$1"); shift; fi
done
set -- "\${args[@]}"
echo "apt-get $* mirror=$mirror conf=$([ -s "$APT_CONF" ] && echo yes || echo no)" >> "$STATE/calls"
for fd in /proc/[0-9]*/fd/*; do
  if [ "$(readlink "$fd" 2>/dev/null)" = "$LOCKS" ]; then echo "E: Could not get lock $LOCKS"; echo "apt-get: lock held" >> "$STATE/calls"; exit 100; fi
done
if [ "$1" = update ] && [ -e "$STATE/hang" ] && [ ! -e "$STATE/hung" ]; then
  : > "$STATE/hung"
  case "$(cat "$STATE/hang")" in
    group) ( exec 9>"$LOCKS"; exec sleep "$TOK" ) & ;;
    escape) : > "$STATE/interrupted"; setsid bash -c 'exec 9>"$LOCKS"; sleep "$HOLD"; rm -f "$STATE/interrupted"' & ;;
  esac
  sleep 0.3; exec sleep "$TOK"
fi
[ "$1" = update ] && [ -e "$STATE/mirror-fails" ] && exit 100
if [ "$1 $2" = "install -y" ]; then
  [ -e "$STATE/interrupted" ] && { echo "E: dpkg was interrupted, you must manually run 'dpkg --configure -a'"; echo "apt-get: interrupted" >> "$STATE/calls"; exit 100; }
  grep -qx "$mirror" "$STATE/stall" 2>/dev/null && exec sleep "$TOK"
  shift 2; [ "$1" = --no-install-recommends ] && shift
  mkdir -p "$APT_ARCHIVES"
  # the named packages, and a dependency's file apt also fetched (libgbm1), which the cache must not keep
  for p in "$@" libgbm1; do echo "$p" >> "$STATE/installed"; : > "$APT_ARCHIVES/\${p}_1.0_amd64.deb"; done
fi
exit 0
`,
  // dpkg: like the real one, ignores apt's lock timeout and fails at once on a held lock; --configure -a repairs an
  // interrupted dpkg
  dpkg: `#!/usr/bin/env bash
echo "dpkg $*" >> "$STATE/calls"
for fd in /proc/[0-9]*/fd/*; do
  if [ "$(readlink "$fd" 2>/dev/null)" = "$LOCKS" ]; then echo "dpkg: error: dpkg frontend lock was locked by another process"; echo "dpkg: lock held" >> "$STATE/calls"; exit 2; fi
done
[ "$1 $2" = "--configure -a" ] && { rm -f "$STATE/interrupted"; exit 0; }
[ "$1" = -i ] || exit 0
shift
[ -e "$STATE/dpkg-noop" ] && exit 0      # "succeeds" without installing anything the check sees
for f in "$@"; do b=$(basename "$f"); echo "\${b%%_*}" >> "$STATE/installed"; done
exit 0
`,
};

function run({ installed = [], cached = [], mirrorFails = false, stall = [], dpkgNoop = false, hang = null, hold = 2, preHold = false, uid = 0, script = REAL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibd-'));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'state'), debs = path.join(dir, 'debs'), arch = path.join(dir, 'archives');
  for (const d of [bin, state, debs]) fs.mkdirSync(d);
  for (const [n, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, n), body, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'installed'), installed.map((p) => p + '\n').join(''));
  fs.writeFileSync(path.join(state, 'calls'), '');
  if (mirrorFails) fs.writeFileSync(path.join(state, 'mirror-fails'), '');
  if (dpkgNoop) fs.writeFileSync(path.join(state, 'dpkg-noop'), '');
  fs.writeFileSync(path.join(state, 'stall'), stall.map((m) => m + '\n').join(''));
  if (hang) fs.writeFileSync(path.join(state, 'hang'), hang);
  // a sleep length no other process has, so the survivors of this run can be found (and cleaned up) by it
  const tok = `1777.${process.pid}${Math.floor(Math.random() * 1e6)}`, holdTok = `${hold}.${process.pid}${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(path.join(state, 'uid'), `${uid}\n`);
  // a holder already there when the script starts (a killed apt from before), in a session of its own, with dpkg
  // left interrupted
  if (preHold) {
    fs.writeFileSync(path.join(state, 'interrupted'), '');
    cp.spawn('setsid', ['bash', '-c', `exec 9>"${path.join(state, 'lock')}"; exec sleep ${holdTok}`], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 50 && !cp.spawnSync('pgrep', ['-f', `sleep ${holdTok}`]).stdout.length; i++) cp.spawnSync('sleep', ['0.1']);
  }
  for (const p of cached) fs.writeFileSync(path.join(debs, `${p}_0.9_amd64.deb`), '');
  const sh = path.join(dir, 'install.sh');
  fs.writeFileSync(sh, script, { mode: 0o755 });
  const r = cp.spawnSync('bash', [sh], {
    encoding: 'utf8', timeout: 120000,   // the runs here take 1-15 s; this only stops a hung one
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state, NEEDED: NEEDED.join(' '), DEBS_DIR: debs,
      APT_CONF: path.join(dir, 'apt.conf'), APT_ARCHIVES: arch, SOURCES: path.join(dir, 'mirror.list'), T_INSTALL: '4', PAUSE: '0', LOCKS: path.join(state, 'lock'), TOK: tok, HOLD: holdTok,
      T_UPDATE: '4', KILL_AFTER: '1', LOCK_WAIT: '5' },   // 4 s: a stub apt-get that does not hang must finish well inside it under a loaded gate (1 s did not on CI)
  });
  const alive = (t) => cp.spawnSync('pgrep', ['-f', `sleep ${t}`], { encoding: 'utf8' }).stdout.trim();
  const survivors = [alive(tok), alive(holdTok)].filter(Boolean).join(' ');
  for (const t of [tok, holdTok]) cp.spawnSync('pkill', ['-f', `sleep ${t}`]);
  const res = {
    status: r.status, out: (r.stdout || '') + (r.stderr || ''),
    calls: fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n').filter(Boolean),
    kept: fs.readdirSync(debs).sort(),
    survivors,
    sources: fs.existsSync(path.join(dir, 'mirror.list')) ? fs.readFileSync(path.join(dir, 'mirror.list'), 'utf8') : '',
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
  check('no cache: exits 0, installed from the first mirror', r.status === 0 && says(r, /installed from the mirror \(http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\); 2 \.deb files kept/), r.out.trim().split('\n').pop());
  const inst = r.calls.filter((c) => /^apt-get install -y/.test(c));
  check('...one apt-get install, of exactly the missing packages, without recommends',
    inst.length === 1 && inst[0] === `apt-get install -y --no-install-recommends ${NEEDED.join(' ')} mirror=http://azure.archive.ubuntu.com/ubuntu conf=yes`, inst.join(' | '));
  check('...no translation lists, on every apt-get of the try', /"\$\{opts\[@\]\}" update/.test(REAL) && /"\$\{opts\[@\]\}" install -y --no-install-recommends \$need/.test(REAL)
    && /opts=\(-o Acquire::Languages=none\)/.test(REAL));
  check('...the cache keeps only the missing packages, not what else apt fetched', JSON.stringify(r.kept) === JSON.stringify(NEEDED.map((p) => `${p}_1.0_amd64.deb`)), r.kept.join(' '));
  check('...apt\'s time limits are in place before apt-get update runs', has(r, /^apt-get update mirror=http:\/\/azure\.archive\.ubuntu\.com\/ubuntu conf=yes$/) && !has(r, /conf=no/), r.calls.filter((c) => /^apt-get/.test(c)).join(' | '));
  check('...and the check ran again after the install', r.calls.filter((c) => /--dry-run/.test(c)).length === 2, `${r.calls.filter((c) => /--dry-run/.test(c)).length} checks`);
}
// 4. a cache whose files do not satisfy the check: the mirror, after apt-get install -f
{
  const r = run({ cached: NEEDED, dpkgNoop: true });
  check('cache that does not satisfy the check: not reported as installed from the cache', !says(r, /installed from the cache/), r.out.trim().split('\n').slice(-2).join(' | '));
  check('...repairs with apt-get install -f, then installs from the mirror', has(r, /^apt-get install -f -y/) && has(r, /^apt-get update/) && r.status === 0 && says(r, /installed from the mirror/),
    r.calls.join(' | '));
}
// 5. mirrors that keep failing: three tries, each on the next mirror, then a loud failure
{
  const r = run({ mirrorFails: true });
  const ups = r.calls.filter((c) => /^apt-get update/.test(c)).map((c) => c.replace(/^.*mirror=(\S+).*$/, '$1'));
  check('failing mirrors: exits 1, saying the browser check did not run', r.status === 1 && says(r, /could not be installed in 3 tries, from 3 mirrors.*the browser check did not run/), r.out.trim().split('\n').pop());
  check('...after exactly three tries, each on a different mirror: azure.archive, the image\'s, archive.ubuntu.com',
    JSON.stringify(ups) === JSON.stringify(['http://azure.archive.ubuntu.com/ubuntu', 'default', 'http://archive.ubuntu.com/ubuntu']), ups.join(' '));
  check('...a named mirror gets its own sources list: the release, -updates and -security, main and universe, signed by the Ubuntu archive key',
    r.sources === ['', '-updates', '-security'].map((x) => `deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble${x} main universe\n`).join(''), JSON.stringify(r.sources));
}
// 5b. the first mirror stalls mid-install (CI 45333139695): stopped at its limit, then the next mirror installs
{
  const r = run({ stall: ['http://azure.archive.ubuntu.com/ubuntu'] });
  check('a mirror that stalls mid-install: stopped at its limit', says(r, /'apt-get -o Acquire::Languages=none .*install -y --no-install-recommends .*' passed its 4 s limit/), r.out.split('\n').filter((l) => /limit/.test(l)).join(' | '));
  check('...and try 2 asks the next mirror, which installs', r.status === 0 && says(r, /try 1 \(http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\) failed/) && says(r, /installed from the mirror \(default\)/),
    r.out.split('\n').filter((l) => /OS packages/.test(l)).join(' | '));
  check('...with no process of the stalled install left', r.survivors === '', `survivors: ${r.survivors}`);
}
// 6. try 1's apt-get update hangs past its limit with a child of it holding the dpkg lock (CI 45180359317)
{
  const r = run({ hang: 'group' });
  check('a hung update with a child holding the lock: stopped at its limit', says(r, /'apt-get -o Acquire::Languages=none [^']*update' passed its 4 s limit: stopping its whole process group/), r.out.trim().split('\n').slice(0, 3).join(' | '));
  check('...try 2 gets the lock and the install succeeds', r.status === 0 && says(r, /installed from the mirror/) && !has(r, /lock held/), r.calls.join(' | '));
  check('...and no process of the stub survives', r.survivors === '', `survivors: ${r.survivors}`);
}
// 7. a process outside that group holds the lock for 2 s after the hang: try 2 waits for it
{
  const r = run({ hang: 'escape', hold: 2 });
  check('a lock held for a while by a process outside the group: try 2 waits for it and succeeds', r.status === 0 && says(r, /installed from the mirror/) && !has(r, /lock held/),
    r.out.trim().split('\n').slice(-2).join(' | '));
}
// 8. ...and for good: after the wait the holder is stopped, by name, and try 2 succeeds; apt never meets the held lock
{
  const r = run({ hang: 'escape', hold: 1000 });
  check('a lock held for good by a process in its own session: stopped after the wait, named', says(r, /locks are still held after 5 s, by: .*\d+ \(sleep [\d.]+ \);.*- stopping them/),
    r.out.split('\n').filter((l) => /locks/.test(l)).join(' | '));
  check('...then try 2 succeeds, without running apt against the held lock', r.status === 0 && says(r, /installed from the mirror/) && !has(r, /lock held/), r.calls.join(' | '));
  check('...and the holder is gone', r.survivors === '', `survivors: ${r.survivors}`);
}
// apt's own lock wait is bounded too
{
  const conf = REAL.match(/printf '%s\\n' [\s\S]*?> "\$APT_CONF"/);
  check('apt waits for a dpkg lock at most LOCK_WAIT s (DPkg::Lock::Timeout in its config)', !!conf && /DPkg::Lock::Timeout \\"\$LOCK_WAIT\\"/.test(conf[0]), conf ? '' : 'no APT_CONF write found');
}

// 8b. in case 8 the stopped holder left dpkg interrupted, and the repair ran with the lock free
{
  const r = run({ hang: 'escape', hold: 1000 });
  check('a stopped holder leaves dpkg interrupted: the repair runs with the lock free, and try 2 installs', r.status === 0 && !has(r, /dpkg: lock held/) && !has(r, /apt-get: interrupted/),
    r.calls.filter((c) => /dpkg|install|lock/.test(c)).join(' | '));
}
// 9. a holder already there at the start (dpkg interrupted): stopped before try 1, repaired, and try 1 installs
{
  const r = run({ preHold: true, hold: 1000 });
  check('a lock held from before: stopped, dpkg repaired, try 1 installs', r.status === 0 && says(r, /repairing after the stopped holders/) && !says(r, /try 1 .*failed/) && !has(r, /apt-get: interrupted/),
    r.out.split('\n').filter((l) => /OS packages/.test(l)).join(' | '));
  check('...and the holder is gone', r.survivors === '', `survivors: ${r.survivors}`);
}
// 10. run as a user: the part after the download re-runs itself under sudo, once, as root
{
  const r = run({ uid: 1000, installed: NEEDED });
  const sudos = r.calls.filter((c) => /^sudo /.test(c));
  check('as a user: one re-run under sudo with INSTALL_DEPS_AS_ROOT=1', sudos.length === 1 && /INSTALL_DEPS_AS_ROOT=1 bash /.test(sudos[0]), sudos.join(' | '));
  check('...the download ran once (as the user) and the root part once', r.status === 0 && r.calls.filter((c) => /^npx playwright install chromium$/.test(c)).length === 1
    && r.calls.filter((c) => /--dry-run/.test(c)).length === 1 && says(r, /all present/), r.calls.join(' | '));
}
{
  const r = run({ uid: 0, installed: NEEDED });
  check('as root: no sudo at all', r.status === 0 && !has(r, /^sudo /), r.calls.join(' | '));
}

// Both workflows run this one script, under a step time limit no shorter than the script's worst case, and keep its
// cache: restored by the runner image, else the newest cache of an earlier image of the same OS; saved right after a
// good install (not at the job's end, which a failing browser check would skip), unless the exact key was restored.
const worst = Number(REAL.match(/= (\d+) s, [\d.]+ minutes: under the step's (\d+)-minute limit/)[1]);
for (const wf of ['tests.yml', 'browser-daily.yml']) {
  const t = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', wf), 'utf8');
  const step = t.match(/timeout-minutes: (\d+)\n\s+run: \.github\/scripts\/install-browser-deps\.sh\n/);
  check(`${wf} installs through the script, with a step time limit over its worst case (${worst} s)`, !!step && Number(step[1]) * 60 > worst, step ? `${step[1]} min` : 'no install step');
  const restore = t.match(/- name: Restore the browser's OS packages\n\s+id: debs\n\s+uses: actions\/cache\/restore@[0-9a-f]{40}  # v[\d.]+\n\s+with:\n\s+path: ~\/playwright-debs\n\s+key: playwright-debs-([\d.]+)-\$\{\{ steps\.image\.outputs\.image \}\}\n\s+restore-keys: playwright-debs-([\d.]+)-\$\{\{ steps\.image\.outputs\.os \}\}-\n/);
  check(`${wf} restores the .deb cache by runner image, falling back to an earlier image of the same OS and Playwright`, !!restore && restore[1] === restore[2]);
  // the fallback's OS comes from the image step: ImageOS is a runner variable, not in the env context, and
  // `${{ env.ImageOS }}` read as empty (CI 45337281354 looked up "playwright-debs-1.63.0--")
  check(`${wf} names the OS for that fallback from the runner's ImageOS`, /echo "os=\$ImageOS" >> "\$GITHUB_OUTPUT"/.test(t) && !/env\.ImageOS/.test(t));
  const save = t.match(/run: \.github\/scripts\/install-browser-deps\.sh\n\s+- name: Save the browser's OS packages\n\s+if: steps\.debs\.outputs\.cache-hit != 'true'\n\s+uses: actions\/cache\/save@[0-9a-f]{40}  # v[\d.]+\n\s+with:\n\s+path: ~\/playwright-debs\n\s+key: playwright-debs-([\d.]+)-\$\{\{ steps\.image\.outputs\.image \}\}\n/);
  check(`${wf} saves the .deb cache right after the install, unless the exact key was restored`, !!save && !!restore && save[1] === restore[1]);
}

done('install-browser-deps checks');
