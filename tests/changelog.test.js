// A released section of CHANGELOG.md stays as released. Three branches in one day put new entries into released
// sections ("### 0.1.3-pre" sits directly under "## [Unreleased]" in this file, which makes it look open), so this
// suite compares every released section with the same section in its git tag, byte for byte, except for the named
// corrections in tests/changelog-guard.js, and checks the rule itself on fixtures. See that file for the rule.
//
// On CI the tags must be there (the workflow checks out with fetch-depth: 0) and a missing one is a failure. On a
// checkout without them this prints one SKIP line per tag naming it and does not pretend to have compared.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const { check: guard, parse, tagOf, ALLOWED_CORRECTIONS } = require('./changelog-guard.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const root = path.join(__dirname, '..');
const CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });

// ---------------- this repository ----------------
{
  let haveGit = true, tags = [];
  try { git('rev-parse', '--git-dir'); tags = git('tag', '-l', 'v*', '--sort=-v:refname').split('\n').filter(Boolean); } catch (e) { haveGit = false; }
  const tagText = (tag) => { if (!haveGit) return null; try { return git('show', `refs/tags/${tag}:CHANGELOG.md`); } catch (e) { return null; } };
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const r = guard({ text, tagText, tags, ci: CI });
  for (const s of r.skips) console.log(s);
  check('CHANGELOG.md: every released section is as its tag has it (the named corrections aside)', r.failures.length === 0, r.failures.join(' | '));
  if (CI) {
    // in CI the comparison must really have happened: every version heading but a release in preparation is compared
    const versions = parse(text).versions;
    check('CHANGELOG.md in CI: the tags were fetched and every older release was compared', r.compared.length >= versions.length - 1 && r.compared.length > 0,
      `compared ${r.compared.join(', ') || '(none)'} of ${versions.join(', ')}`);
  } else if (!r.compared.length) {
    console.log('SKIP CHANGELOG.md: no release tag was found here, so nothing was compared (git fetch --tags)');
  }
  // the named corrections are real: each is a difference between a tag and this file that the list explains
  check('CHANGELOG.md: every "### " release heading looks like a version (no "### Added" counted as one)', parse(text).versions.length >= 4 && parse(text).versions.every((v) => /^\d+\.\d+/.test(v)), parse(text).versions.join(', '));
  check('the allowed corrections each name a version heading in CHANGELOG.md and give a reason',
    ALLOWED_CORRECTIONS.every((a) => a.reason && parse(text).versions.includes(a.version)), '');
}

// ---------------- the rule, on fixtures ----------------
// A tagged CHANGELOG with two releases, and a helper that serves it (and v0.2.0's) as git would.
const TAGGED = [
  '# Changelog', '', '## [Unreleased]', '', '### 0.2.0', '', '#### Fixed', '', '- the newest fix', '',
  '### 0.1.0', '', '#### Added', '', '- the first feature', '',
].join('\n');
const serve = (map) => (tag) => (tag in map ? map[tag] : null);
const TAGS = { 'v0.2.0': TAGGED, 'v0.1.0': TAGGED };
const run = (text, opts = {}) => guard({ text, tagText: serve(TAGS), tags: ['v0.2.0', 'v0.1.0'], ci: false, allowed: [], aliases: {}, ...opts });
const names = (r) => r.failures.join(' | ');

{
  const same = run(TAGGED);
  check('fixture: an unchanged CHANGELOG passes and both releases are compared', same.failures.length === 0 && same.compared.join() === '0.2.0,0.1.0', names(same));

  const addUnreleased = TAGGED.replace('### 0.2.0', '### Fixed\n\n- a new fix, not released yet\n\n### 0.2.0');
  const a = run(addUnreleased);
  check('fixture: an addition above the newest release ([Unreleased] only) passes', a.failures.length === 0, names(a));

  const editOld = run(TAGGED.replace('- the first feature', '- the first feature, reworded'));
  check('fixture: an edit inside an older released section fails and names it', editOld.failures.length === 1 && /^0\.1\.0 is a released section/.test(editOld.failures[0]) && /reworded/.test(editOld.failures[0]), names(editOld));

  const editNewest = run(TAGGED.replace('- the newest fix', '- the newest fix\n- a late entry'));
  check('fixture: an entry added inside the newest released section fails (the 0.1.3-pre case)', editNewest.failures.length === 1 && /^0\.2\.0 is a released section/.test(editNewest.failures[0]), names(editNewest));

  const removed = run(TAGGED.replace('\n### 0.1.0\n\n#### Added\n\n- the first feature\n', ''));
  check('fixture: deleting a released section fails', removed.failures.some((f) => /0\.1\.0: released in v0\.2\.0 but its section is gone/.test(f)), names(removed));

  const deletedLine = run(TAGGED.replace('- the newest fix\n', ''));
  check('fixture: removing a line from a released section fails', deletedLine.failures.length === 1 && /^0\.2\.0 is a released section/.test(deletedLine.failures[0]), names(deletedLine));

  // the allowlist: a correction that is listed passes, anything beside it does not, a stale entry fails
  const fix = { version: '0.1.0', reason: 'typo', from: 'the first feature', to: 'the first feature (fixed typo)' };
  const corrected = TAGGED.replace('the first feature', 'the first feature (fixed typo)');
  check('fixture: a listed correction passes', run(corrected, { allowed: [fix] }).failures.length === 0, names(run(corrected, { allowed: [fix] })));
  const extra = corrected.replace('- the newest fix', '- the newest fix, and more');
  check('fixture: a listed correction does not excuse another edit', run(extra, { allowed: [fix] }).failures.length === 1, names(run(extra, { allowed: [fix] })));
  const stale = run(TAGGED, { allowed: [{ ...fix, from: 'text the tag never had' }] });
  check('fixture: a listed correction that no longer matches the tag fails (the list cannot rot)', stale.failures.some((f) => /no longer applies/.test(f)), names(stale));

  // tags missing: locally one SKIP line per tag, never a silent pass; on CI a failure
  const none = run(TAGGED, { tagText: serve({}), tags: [] });
  check('fixture: no tags locally: SKIP lines name the tags, nothing is compared, no failure',
    none.failures.length === 0 && none.compared.length === 0 && none.skips.length === 2 && /SKIP 0\.2\.0: no tag v0\.2\.0/.test(none.skips[0]) && /v0\.1\.0/.test(none.skips[1]), none.skips.join(' | '));
  const noneCi = run(TAGGED, { tagText: serve({}), tags: [], ci: true });
  check('fixture: no tags on CI fails', noneCi.failures.some((f) => /no v\* tag in this checkout/.test(f)) && noneCi.failures.some((f) => /tag v0\.1\.0 is missing/.test(f)), names(noneCi));
  const preparing = run(TAGGED.replace('### 0.2.0', '### 0.3.0\n\n- being prepared\n\n### 0.2.0'), { tagText: serve({ 'v0.2.0': TAGGED, 'v0.1.0': TAGGED }), tags: ['v0.2.0', 'v0.1.0'], ci: true });
  check('fixture: a newest heading with no tag yet (a release in preparation) is skipped by name, not failed, on CI',
    preparing.failures.length === 0 && preparing.skips.length === 1 && /SKIP 0\.3\.0: no tag v0\.3\.0/.test(preparing.skips[0]), `${names(preparing)} ${preparing.skips.join(' | ')}`);

  // the newest heading tagged needs its [Unreleased] heading
  const noUnreleased = run(TAGGED.replace('## [Unreleased]\n\n', ''));
  check('fixture: the newest heading is tagged and "## [Unreleased]" is gone: fails', noUnreleased.failures.some((f) => /no "## \[Unreleased\]" heading above it/.test(f)), names(noUnreleased));
  const noTagNoUnreleased = run(TAGGED.replace('## [Unreleased]\n\n', ''), { tagText: serve({ 'v0.1.0': TAGGED }), tags: ['v0.1.0'] });
  check('fixture: the newest heading untagged (in preparation) does not need it', !noTagNoUnreleased.failures.some((f) => /Unreleased/.test(f)), names(noTagNoUnreleased));

  // headings whose tag has another name, as 0.1.0 -> v0.1.0-pre in this repository
  check('tagOf: a version is v<version> unless the table names another tag', tagOf('0.1.3-pre') === 'v0.1.3-pre' && tagOf('0.1.0') === 'v0.1.0-pre');
  const aliased = guard({ text: TAGGED, tagText: serve({ 'v0.2.0-pre': TAGGED, 'v0.1.0-pre': TAGGED }), tags: ['v0.2.0-pre', 'v0.1.0-pre'], aliases: { '0.2.0': 'v0.2.0-pre', '0.1.0': 'v0.1.0-pre' }, allowed: [] });
  check('fixture: a heading mapped to another tag is compared with that tag', aliased.failures.length === 0 && aliased.compared.length === 2, names(aliased));

  // [Unreleased] has subsections of its own ("### Added", "### Fixed", "### Changed"): they are not releases
  const withSub = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new\n\n### Fixed\n\n- a fix\n\n### 0.2.0\n\n#### Fixed\n\n- the newest fix\n\n### 0.1.0\n\n#### Added\n\n- the first feature\n';
  const ps = parse(withSub);
  check('parse: "### Added" and "### Fixed" under [Unreleased] are not versions', ps.versions.join() === '0.2.0,0.1.0' && ps.unreleased, JSON.stringify(ps.versions));
  const subTagged = { 'v0.2.0': withSub.replace('### Added\n\n- new\n\n### Fixed\n\n- a fix\n\n', ''), 'v0.1.0': withSub };
  const populated = guard({ text: withSub, tagText: serve(subTagged), tags: ['v0.2.0', 'v0.1.0'], ci: true, allowed: [], aliases: {} });
  check('fixture: [Unreleased] with subsections above tagged releases passes on CI, both releases compared', populated.failures.length === 0 && populated.compared.join() === '0.2.0,0.1.0', names(populated));
  const preparing2 = withSub.replace('### 0.2.0', '### 0.3.0\n\n- being prepared\n\n### 0.2.0');
  const prep = guard({ text: preparing2, tagText: serve(subTagged), tags: ['v0.2.0', 'v0.1.0'], ci: true, allowed: [], aliases: {} });
  check('fixture: an untagged newest version under a populated [Unreleased] passes on CI (skipped by name)',
    prep.failures.length === 0 && prep.skips.length === 1 && /SKIP 0\.3\.0:/.test(prep.skips[0]) && prep.compared.join() === '0.2.0,0.1.0', `${names(prep)} ${prep.skips.join(' | ')}`);
  const renamed = guard({ text: withSub.replace('## [Unreleased]', '## [Next]'), tagText: serve(subTagged), tags: ['v0.2.0', 'v0.1.0'], ci: true, allowed: [], aliases: {} });
  check('fixture: a renamed [Unreleased] heading fails (with subsections under it, as in this repository)', renamed.failures.some((f) => /no "## \[Unreleased\]" heading above it/.test(f)), names(renamed));

  // parse: a "####" heading does not end a section, a "###" or "##" one does
  const p = parse('## [Unreleased]\n\n### 2.0\n\n#### Added\n\n- x\n\n## Links\n\n### 1.0\n- y\n');
  check('parse: #### stays inside a section, a ## heading ends it, [Unreleased] is seen', p.unreleased && p.versions.join() === '2.0,1.0' && /- x/.test(p.sections['2.0']) && !/Links/.test(p.sections['2.0']), JSON.stringify(p.versions));
}

console.log(fail ? `${fail} FAILED` : 'all changelog checks passed');
process.exitCode = fail ? 1 : 0;
