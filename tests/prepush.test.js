// tools/prepush.js, the author's checklist, on fixture repositories: a clean change passes; each rule broken on its
// own (a released CHANGELOG section edited, the skill copies apart, a non-noreply email, a stale sw.js) fails by
// name; missing tags only warn; and the report skeleton marks the levels a change does not need as not applicable.
// The suites themselves are not run here (--no-tests): that part only chains tests/all.js.
// Run: node tests/prepush.test.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { withoutUnreleased, changelogOutsideUnreleased } = require('../tools/prepush.js');
const { pwaFiles, withList, BEGIN, END } = require('../tools/pwa-files.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const PREPUSH = path.join(__dirname, '..', 'tools', 'prepush.js');

const CHANGELOG = [
  '# Changelog', '', 'Preamble.', '', '## [Unreleased]', '', 'Next version: 0.2.1', '', '### Added', '', '- new thing', '',
  '### 0.2.0', '', '#### Added', '', '- shipped thing', '', '### 0.1.0', '', '#### Fixed', '', '- old fix', '',
].join('\n');

// the rule on its own, on text
check('withoutUnreleased drops the [Unreleased] block and keeps the released sections',
  withoutUnreleased(CHANGELOG) === ['# Changelog', '', 'Preamble.', '', '### 0.2.0', '', '#### Added', '', '- shipped thing', '', '### 0.1.0', '', '#### Fixed', '', '- old fix', ''].join('\n'));
check('an entry added under [Unreleased] is allowed', changelogOutsideUnreleased(CHANGELOG, CHANGELOG.replace('- new thing', '- new thing\n- another')) === null);
check('an entry added to a released section is not', !!changelogOutsideUnreleased(CHANGELOG, CHANGELOG.replace('- shipped thing', '- shipped thing\n- sneaked in')));
check('...nor an [Unreleased] subsection that lands under a release heading',
  !!changelogOutsideUnreleased(CHANGELOG, CHANGELOG.replace('- old fix', '- old fix\n\n### Fixed\n\n- stray')));

const dirs = [];
// A fixture repository: the served folders sw.js lists, sw.js in step with them, a CHANGELOG, the two skill copies,
// one commit, a noreply email and (by default) a release tag.
function fixture({ tag = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-'));
  dirs.push(dir);
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const d of ['css', 'fonts', 'img', 'icons', 'js', 'examples', 'embed', 'play', 'roms', 'help', 'credits', 'faq', 'about']) w(`${d}/x.txt`, d);
  w('sw.js', withList(`${BEGIN}\n${END}\n`, pwaFiles(dir)));
  w('CHANGELOG.md', CHANGELOG);
  w('skills/cloadm/SKILL.md', 'skill\n'); w('.agents/skills/cloadm/SKILL.md', 'skill\n');
  w('docs/a.md', 'doc\n');
  const git = (...a) => cp.execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'someone'); git('config', 'user.email', '12345+someone@users.noreply.github.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  if (tag) git('tag', 'v0.2.0');
  return { dir, w, git };
}
const prepush = (dir) => {
  const r = cp.spawnSync(process.execPath, [PREPUSH, '--repo', dir, '--base', 'HEAD', '--no-tests'], { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: r.stdout + r.stderr };
};
const line = (out, re) => out.split('\n').find((l) => re.test(l)) || '';

try {
  {
    const f = fixture();
    f.w('CHANGELOG.md', CHANGELOG.replace('- new thing', '- new thing\n- another'));
    f.w('docs/a.md', 'doc, edited\n');
    const r = prepush(f.dir);
    check('a clean change: every check passes, exit 0', r.status === 0 && /prepush: every check passed/.test(r.out), r.out.slice(-400));
    check('...each check printed as ok', [/^ok\s+sw\.js lists/, /^ok\s+CHANGELOG\.md: changed only under \[Unreleased\]/, /^ok\s+the two skill copies/,
      /^ok\s+git user\.email is a noreply/, /^ok\s+the release tags are here \(1\)/].every((re) => line(r.out, re)), r.out.slice(-300));
    check('...and the report: a docs-only change marks 4.4 to 4.7 not applicable, with the reason',
      /4\.4 MAME lockstep: not applicable: no hardware/.test(r.out) && /4\.5 snapshots: not applicable/.test(r.out)
      && /4\.6 other oracle: not applicable/.test(r.out) && /4\.7 browser check: not applicable: nothing the page runs/.test(r.out)
      && /Deviations from MAME:\*\* none/.test(r.out), r.out.slice(-300));
  }
  {
    const f = fixture();
    f.w('CHANGELOG.md', CHANGELOG.replace('- shipped thing', '- shipped thing\n- sneaked in'));
    const r = prepush(f.dir);
    check('an entry in a released section: FAIL naming CHANGELOG, exit 1', r.status === 1 && /^FAIL CHANGELOG\.md: changed outside \[Unreleased\].*sneaked in/m.test(r.out), line(r.out, /CHANGELOG/));
  }
  {
    const f = fixture();
    f.w('.agents/skills/cloadm/SKILL.md', 'skill, edited in one copy only\n');
    const r = prepush(f.dir);
    check('the skill copies apart: FAIL naming the file, exit 1', r.status === 1 && /^FAIL skills\/cloadm\/ and \.agents\/skills\/cloadm\/ differ -- SKILL\.md differs/m.test(r.out), line(r.out, /skill/));
    f.w('.agents/skills/cloadm/SKILL.md', 'skill\n'); f.w('.agents/skills/cloadm/references/extra.md', 'x');
    const r2 = prepush(f.dir);
    check('...and a file in one copy only', r2.status === 1 && /references\/extra\.md is in one copy only/.test(r2.out), line(r2.out, /skill/));
  }
  {
    const f = fixture();
    f.git('config', 'user.email', 'someone@example.com');
    const r = prepush(f.dir);
    check('a non-noreply email: FAIL, exit 1', r.status === 1 && /^FAIL git user\.email is not a GitHub noreply address -- someone@example\.com/m.test(r.out), line(r.out, /email/));
  }
  {
    const f = fixture();
    f.w('css/new.css', 'a {}');
    const r = prepush(f.dir);
    check('a served file sw.js does not list: FAIL with the fix, exit 1', r.status === 1 && /^FAIL sw\.js is out of step .*pwa-files\.js --write/m.test(r.out), line(r.out, /sw\.js/));
    check('...and the report: a page file changed, so 4.7 applies: the CI run, and locally the groups it touches (not a whole local check)',
      /4\.7 browser check: the CI run above \(attempt 1 runs every group\); locally node tools\/browser-check\.js --only models,semantics,pwa,uiQa,layout$/m.test(r.out)
      && !/whole (browser )?check/.test(r.out), line(r.out, /4\.7/));
  }
  {
    const f = fixture({ tag: false });
    f.w('js/chips/new.js', '');
    f.w('sw.js', withList(`${BEGIN}\n${END}\n`, pwaFiles(f.dir)));
    const r = prepush(f.dir);
    check('no tags and none to fetch: a WARN that changelog.test will skip, not a failure (exit 0)',
      r.status === 0 && /^WARN no release tags here.*changelog\.test\.js will SKIP/m.test(r.out), line(r.out, /tags/));
    check('...and the report: a chip changed, so 4.4 is a TODO naming the MAME comparison', /4\.4 MAME lockstep: TODO: node tools\/mame-diff\/run\.js .*js\/chips\/new\.js/.test(r.out), line(r.out, /4\.4/));
  }
  {
    const r = cp.spawnSync(process.execPath, [PREPUSH, '--repo', dirs[0], '--base', 'no-such-ref', '--no-tests'], { encoding: 'utf8' });
    check('a base git does not know: FAIL, exit 1', r.status === 1 && /^FAIL the changed files/m.test(r.stdout), r.stdout);
  }
} finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
