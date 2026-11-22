// Run: node tests/regress-cli.test.js
//
// The regression gate's command line behaves: --only runs a subset, and refuses what would make a partial run look
// like a full one. tests/all.js has the same --only rule; this pins the one here.
//
// Every row runs the gate in a child process and reads its EXIT CODE, not its text: a refusal that printed the right
// message and exited 0 would still be a broken refusal. The child is `node tests/regress.test.js`, so a row costs a
// process start plus (for the runs) the cases it matched.
//
// The child runs in a THROWAWAY COPY OF THE REPOSITORY (in the system temp directory), never in this checkout. The
// rows include `--update`, and the whole point of a refusal test is that the refusal could one day stop working: if
// it did, the gate would not merely print the wrong thing, it would REWRITE tests/regress-hashes.json - the baseline
// every gate compares against. A copy cannot. The copy's hashes are read back where a row could have written them.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-regress-cli-'));
const cleanup = () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
process.on('exit', cleanup);
// A signal is not 'exit'. Under all.js this file may be interrupted (a timeout, a cancelled run), and a SIGINT or
// SIGTERM would otherwise leave a `cloadm-regress-cli-*` copy in the temp directory for good. NOT process.exit():
// tests/exitcode.test.js forbids it in every suite and tool (Node 25.2.1 deadlocks in it under load), so the handler
// removes the copy, takes ITSELF OFF, and re-sends the same signal - the default disposition then runs and the
// process dies the way the signal asks, with no exit() anywhere. The `once` is what keeps the re-send from looping.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { cleanup(); process.kill(process.pid, sig); });
}
// TRACKED FILES ONLY. This used to tar the whole repository root, which in the main checkout is 592 MB taking
// about 26 s - .git is 140 MB of that, and .claude/worktrees holds every other worktree - copied twice whenever
// all.js ran two of these at once. `git ls-files` is the tracked tree exactly: the same 464 files, 7.7 MB, 0.28 s,
// and it cannot pick up .git, .claude, node_modules or anything else untracked. -z keeps a path containing a space
// or newline intact; --null makes tar read the list as NUL-separated.
//
// `git ls-files` needs a git checkout, and the tests run in a checkout but must not ASSUME one: a tree unpacked from
// a zip has no .git, and there `git ls-files` exits 128 with an empty list - a silent empty copy if the exit code is
// ignored. So the checkout is asked first and a failure falls back to tarring the tree with .git, .claude and
// node_modules excluded, which is the same 464 files and takes the same time (measured: 7.7 MB, 0.27 s). The result is
// checked either way, below, so a broken copy cannot pass quietly.
//
// The whole tree, not just tests/: regress.test.js loads firmware and other files by relative path, so a copy of
// tests/ alone cannot start. It is one tree, copied once (measured in the main checkout, 2026-11-22).
{
  const inGit = fs.existsSync(path.join(ROOT, '.git'));
  const cmd = inGit
    ? `cd ${JSON.stringify(ROOT)} && git ls-files -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C ${JSON.stringify(WORK)}`
    : `cd ${JSON.stringify(ROOT)} && tar -cf - --exclude=./.git --exclude=./.claude --exclude=./node_modules . 2>/dev/null | tar -xf - -C ${JSON.stringify(WORK)}`;
  cp.execFileSync('bash', ['-c', cmd]);
}

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

// The copy must be the tracked tree and nothing else: a copy that brought .git would carry the repository's history
// (and a write into it would be a write into a git object store), and one that brought .claude would carry every
// other worktree. Checked, not assumed, so a return to `tar .` is caught here instead of by a size regression.
{
  const inside = fs.readdirSync(WORK);
  const leaked = inside.filter((x) => x === '.git' || x === '.claude');
  check('the copy is the tracked tree only: no .git and no .claude in it', leaked.length === 0,
    leaked.length ? `copied: ${leaked.join(', ')}` : `${inside.length} top-level entries`);
}

const run = (args) => {
  const r = cp.spawnSync(process.execPath, [path.join(WORK, 'tests', 'regress.test.js'), ...args], { cwd: WORK, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, err: (r.stderr || '').trim(), out: (r.stdout || '').trim() };
};
// what each baseline says before any row runs: a row must change neither
const realHashes = fs.readFileSync(path.join(ROOT, 'tests', 'regress-hashes.json'), 'utf8');
const copyHashes = () => fs.readFileSync(path.join(WORK, 'tests', 'regress-hashes.json'), 'utf8');
const copyBefore = copyHashes();

// --only that matches nothing: 0/0 would say "everything matched", so it must be a usage error (2) and run nothing
{
  const r = run(['--only', 'zzz_no_case_has_this_name']);
  check('--only with no matching case exits 2, not 0', r.code === 2, `exit ${r.code}`);
  check('--only with no matching case says so', /no case name matches/.test(r.err), r.err.split('\n')[0]);
  check('--only with no matching case does not print a "0/0 ... match" summary', !/hashes match/.test(r.out), r.out.slice(0, 120));
}
// --update with --only would record a baseline holding only those cases
{
  const r = run(['--only', 'dragon64', '--update']);
  check('--update with --only is refused (exit 2)', r.code === 2 && /cannot be used with --only/.test(r.err), `exit ${r.code} ${r.err.split('\n')[0]}`);
}
// --shard with --only is one selection too many
{
  const r = run(['--only', 'dragon64', '--shard', '0/4']);
  check('--only with --shard is refused (exit 2)', r.code === 2 && /cannot be used with --shard/.test(r.err), `exit ${r.code} ${r.err.split('\n')[0]}`);
}
// a malformed regex is reported, not crashed on
{
  const r = run(['--only', '/[/']);
  check('a malformed --only regex exits 2 with the parser message', r.code === 2 && /Invalid regular expression/.test(r.err), `exit ${r.code} ${r.err.split('\n')[0]}`);
}
// and a real subset actually runs: one case, matched by name, reported as one
{
  const r = run(['--only', '/^trace dragon32$/']);   // an exact name: the substring form matches more (4 cases)
  const m = /(\d+)\/(\d+) regression hashes match/.exec(r.out);
  check('--only with one matching case runs exactly that case and passes', r.code === 0 && m && m[1] === '1' && m[2] === '1', r.out.split('\n').pop());
}

// the rows that run a real case must not have rewritten a baseline: neither the copy's (where they run) nor the real
// one (which the copy cannot reach, but this is the check that would say so if the copy ever stopped being a copy)
check('no row rewrote the baseline, in the copy or in the checkout', copyHashes() === copyBefore && fs.readFileSync(path.join(ROOT, 'tests', 'regress-hashes.json'), 'utf8') === realHashes);

console.log(fail ? `\n${fail} FAILED` : '\nall regress-cli checks passed');
process.exitCode = fail ? 1 : 0;
