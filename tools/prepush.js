#!/usr/bin/env node
// The author's checklist before a push (AGENTS.md sections 1, 3 and 6), run in one go:
//
//   1. the suites and browser-check groups the change touches (tools/affected.js), then the full `node tests/all.js`;
//   2. sw.js's offline file list is in step with the served files (tools/pwa-files.js);
//   3. CHANGELOG.md changed only under "## [Unreleased]" (a released section is history);
//   4. the two copies of the agent skill (skills/cloadm/ and .agents/skills/cloadm/) are byte for byte the same;
//   5. `git config user.email` is a GitHub noreply address;
//   6. the release tags are here (fetched if not), or tests/changelog.test.js will skip its comparison;
//   7. a skeleton of the report (AGENTS.md section 6), with the proof levels this change does not need marked
//      "not applicable" and why.
//
//   node tools/prepush.js [--base <ref>] [--no-tests] [--no-browser] [--repo DIR]
//
// --base is what the change is measured against (default origin/main). --no-tests skips step 1 (the checks that
// read the tree still run); --no-browser runs the suites but only prints the browser-check command. --repo runs the
// checks on another checkout (tests/prepush.test.js uses it on fixtures). Exit code 1 if any check FAILs; a WARN
// does not fail. It is not the gate: a green CI run, attempt 1, on the pushed commit is (AGENTS.md section 4).
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { affected, changedFiles } = require('./affected.js');
const { pwaFiles, withList } = require('./pwa-files.js');

const results = [];
const say = (level, name, detail = '') => { results.push({ level, name, detail }); console.log(`${level.padEnd(4)} ${name}${detail ? ` -- ${detail}` : ''}`); };

const gitIn = (repo) => (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// CHANGELOG.md without its "## [Unreleased]" block (that heading up to the first release heading, "### <version>").
// Everything left -- the preamble and every released section -- must be as the base has it.
function withoutUnreleased(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  if (i < 0) return text;
  let j = i + 1;
  while (j < lines.length && !/^### \d/.test(lines[j]) && !/^#{1,2} /.test(lines[j])) j++;
  return [...lines.slice(0, i), ...lines.slice(j)].join('\n');
}
// -> null if only [Unreleased] changed, else the first line that differs outside it
function changelogOutsideUnreleased(baseText, text) {
  const a = withoutUnreleased(baseText).split('\n'), b = withoutUnreleased(text).split('\n');
  for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) return { line: k, was: a[k], now: b[k] };
  return null;
}

// Files under `dir`, relative, sorted.
function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) { const r = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else out.push(r); } };
  walk('');
  return out.sort();
}
// -> [] if the two skill copies are byte-identical, else what differs
function skillDiff(repo) {
  const a = path.join(repo, 'skills', 'cloadm'), b = path.join(repo, '.agents', 'skills', 'cloadm');
  const ta = tree(a), tb = tree(b);
  if (!ta || !tb) return [`${!ta ? 'skills/cloadm' : '.agents/skills/cloadm'} is missing`];
  const diff = [];
  for (const f of new Set([...ta, ...tb])) {
    if (!ta.includes(f) || !tb.includes(f)) diff.push(`${f} is in one copy only`);
    else if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) diff.push(`${f} differs`);
  }
  return diff;
}

const NOREPLY = /^[^@\s]+@users\.noreply\.github\.com$/;

// The proof levels (AGENTS.md section 4, "Which levels apply") from the changed files: which apply, and for the
// rest the reason that goes in the report.
const HW = /^js\/(cpu|chips|machines|video|media|drivewire)\//;
const PAGE = /^(js\/|play\/|css\/|embed\/|index\.html$|sw\.js$|tools\/browser-check)/;
function levels(files, r) {
  const hw = files.filter((f) => HW.test(f)), page = files.filter((f) => PAGE.test(f));
  const na = (why) => `not applicable: ${why}`;
  return [
    ['4.1 all suites', 'the CI run above (node tests/all.js, exit 0)'],
    ['4.2 regression hashes', 'unchanged (regress.test.js in the CI run)'],
    ['4.3 new tests', 'TODO: each new test, and the mutations that turned it red'],
    ['4.4 MAME lockstep', hw.length ? `TODO: node tools/mame-diff/run.js <profile> for each affected profile (${hw.join(', ')})` : na('no hardware behaviour changed')],
    ['4.5 snapshots', hw.length ? 'TODO if this adds machine state (tests/state*.test.js); otherwise not applicable, and why' : na('no machine state changed')],
    ['4.6 other oracle', hw.length ? 'TODO if MAME cannot be the oracle; otherwise not applicable' : na('nothing MAME cannot check')],
    ['4.7 browser check', page.length ? `the CI run above${r.groups.length ? `; locally node tools/browser-check.js --only ${r.groups.join(',')}, then the whole check` : ''}` : na('nothing the page runs changed')],
  ];
}
function reportSkeleton(files, r) {
  return [
    '## Report',
    '',
    `1. **What changed:** ${files.length} file(s): ${files.join(', ')}. TODO: the design in one paragraph.`,
    '2. **Gate and commands run:**',
    '   * CI: TODO run URL, commit SHA, tree hash (git rev-parse HEAD^{tree}), attempt 1',
    ...levels(files, r).map(([k, v]) => `   * ${k}: ${v}`),
    '3. **New tests and firmware:** TODO, with the mutations that turned each red.',
    '4. **Deviations from MAME:** none',
    '5. **Not verified:** TODO (or "none" only if that is true)',
  ].join('\n');
}

function run(cmd, args, repo) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = cp.spawnSync(cmd, args, { cwd: repo, stdio: 'inherit' });
  return r.status === 0;
}

function main(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const repo = path.resolve(opt('--repo', path.join(__dirname, '..')));
  const base = opt('--base', 'origin/main');
  const git = gitIn(repo);

  let files;
  try { files = changedFiles(base, repo); } catch (e) {
    say('FAIL', `the changed files (git diff --name-only ${base})`, (e.stderr || e.message).toString().trim());
    process.exitCode = 1; return;
  }
  const r = affected(files);
  console.log(`${files.length} changed file(s) against ${base}`);

  // 1. tests
  if (argv.includes('--no-tests')) say('SKIP', 'the suites (--no-tests)');
  else {
    if (r.suites.length) {
      if (run(process.execPath, ['tests/all.js', '--only', r.suites.join(',')], repo)) say('ok', `the affected suites (${r.suites.length} patterns)`);
      else say('FAIL', 'the affected suites', `node tests/all.js --only ${r.suites.join(',')}`);
    }
    if (r.groups.length) {
      const cmd = `node tools/browser-check.js --only ${r.groups.join(',')}`;
      if (argv.includes('--no-browser')) say('SKIP', 'the affected browser-check groups (--no-browser)', cmd);
      else if (run(process.execPath, ['tools/browser-check.js', '--only', r.groups.join(',')], repo)) say('ok', 'the affected browser-check groups', r.groups.join(','));
      else say('FAIL', 'the affected browser-check groups', cmd);
    }
    if (results.some((x) => x.level === 'FAIL')) say('SKIP', 'the full node tests/all.js', 'fix the affected suites first');
    else if (run(process.execPath, ['tests/all.js'], repo)) say('ok', 'the full node tests/all.js');
    else say('FAIL', 'the full node tests/all.js');
    if (files.some((f) => PAGE.test(f))) say('NOTE', 'the page changed: run the whole browser check, alone on the machine, before you push');
  }

  // 2. sw.js's file list
  try {
    const sw = fs.readFileSync(path.join(repo, 'sw.js'), 'utf8');
    if (withList(sw, pwaFiles(repo)) === sw) say('ok', 'sw.js lists every served file');
    else say('FAIL', 'sw.js is out of step with the served files', 'node tools/pwa-files.js --write');
  } catch (e) { say('FAIL', 'sw.js could not be checked', e.message); }

  // 3. CHANGELOG.md
  if (!files.includes('CHANGELOG.md')) say('ok', 'CHANGELOG.md: unchanged');
  else {
    let was = '';
    try { was = git('show', `${base}:CHANGELOG.md`); } catch (e) { /* new file: everything in it is new */ }
    const now = fs.existsSync(path.join(repo, 'CHANGELOG.md')) ? fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8') : '';
    const d = was ? changelogOutsideUnreleased(was, now) : null;
    if (!d) say('ok', 'CHANGELOG.md: changed only under [Unreleased]');
    else say('FAIL', 'CHANGELOG.md: changed outside [Unreleased] (a released section is history)',
      `line ${d.line + 1} outside [Unreleased]: was ${JSON.stringify(d.was)}, now ${JSON.stringify(d.now)}`);
  }

  // 4. the skill copies
  const sd = skillDiff(repo);
  if (!sd.length) say('ok', 'the two skill copies are byte-identical');
  else say('FAIL', 'skills/cloadm/ and .agents/skills/cloadm/ differ', sd.join('; '));

  // 5. the committer
  let email = '';
  try { email = git('config', 'user.email').trim(); } catch (e) { /* unset */ }
  if (NOREPLY.test(email)) say('ok', 'git user.email is a noreply address', email);
  else say('FAIL', 'git user.email is not a GitHub noreply address', `${email || '(unset)'}: git config user.email "<id>+<login>@users.noreply.github.com"`);

  // 6. the tags
  const tags = () => { try { return git('tag', '-l', 'v*').split('\n').filter(Boolean); } catch (e) { return []; } };
  if (!tags().length) { try { git('fetch', '--tags', '--quiet', 'origin'); } catch (e) { /* offline or no origin: reported below */ } }
  const t = tags();
  if (t.length) say('ok', `the release tags are here (${t.length})`);
  else say('WARN', 'no release tags here, and git fetch --tags found none: tests/changelog.test.js will SKIP its comparison with them');

  // 7. the report
  console.log(`\n${reportSkeleton(files, r)}\n`);

  const bad = results.filter((x) => x.level === 'FAIL');
  console.log(bad.length ? `prepush: ${bad.length} check(s) FAILED: ${bad.map((x) => x.name).join('; ')}` : 'prepush: every check passed');
  process.exitCode = bad.length ? 1 : 0;
}

module.exports = { withoutUnreleased, changelogOutsideUnreleased, skillDiff, levels, reportSkeleton, NOREPLY };
if (require.main === module) main(process.argv.slice(2));
