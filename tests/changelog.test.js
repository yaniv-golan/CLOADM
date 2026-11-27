// A released section of CHANGELOG.md stays as released. Three branches in one day put new entries into released
// sections ("### 0.1.3-pre" sits directly under "## [Unreleased]" in this file, which makes it look open), so this
// suite compares every released section with the same section in its git tag, byte for byte, except for the named
// corrections in tests/changelog-guard.js, and checks the rule itself on fixtures. See that file for the rule.
//
// On CI the tags must be there (the workflow checks out with fetch-depth: 0) and a missing one is a failure. On a
// checkout without them this prints one SKIP line per tag naming it and does not pretend to have compared.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const { check: guard, parse, tagOf, ALLOWED_CORRECTIONS, subsectionKinds, oddSubsections, unreleasedKinds, unreleasedLevel3, unreleasedNamelessHeadings, unreleasedFences, duplicateUnreleasedKinds, KEEP_A_CHANGELOG, conflictMarkers, bareLetterLines } = require('./changelog-guard.js');

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

  // Keep a Changelog's headings: every release is made of Added/Changed/Fixed (Security/Deprecated/Removed are
  // allowed too), and a new entry is written under one of them -- never under a "#### Upgrading" or a "#### Notes"
  // of its own, so a release page reads the same way wherever it is shown.
  check('CHANGELOG.md: every release uses Keep a Changelog headings (Added/Changed/Fixed, plus the optional ones)',
    oddSubsections(text).length === 0, oddSubsections(text).join(' | '));
  // and the rule bites: a section with an invented heading is reported, and an allowlist entry is the only way past it
  const INVENTED = '### 2.0\n\n#### Upgrading\n\n- x\n\n#### Added\n\n- y\n';
  check('...and an invented subsection heading in a release is reported (the rule is not vacuous)',
    oddSubsections(INVENTED).join() === '2.0: Upgrading', oddSubsections(INVENTED).join());
  check('...and a listed exception is what lets one through (for a section released before the rule)',
    oddSubsections(INVENTED, [{ version: '2.0', kinds: ['Upgrading'] }]).length === 0 &&
    oddSubsections(INVENTED, [{ version: '2.1', kinds: ['Upgrading'] }]).length === 1,
    oddSubsections(INVENTED, [{ version: '2.1', kinds: ['Upgrading'] }]).join());
  // a "####" heading with no name files nothing under any kind, so no list of names can reach it: reported by line,
  // and it is no longer counted as a subsection called " " (which the name check could only ever reject as an odd name)
  check('...and a "####" heading with no name in a release is reported by line (it is not a kind called " ")',
    oddSubsections('### 2.0\n\n####\n\n- x\n\n#### Added\n\n- y\n').join() === '2.0: line 3 of the section, "####", has no section name' &&
    subsectionKinds('### 2.0\n\n####   \n\n- x\n').length === 0,
    JSON.stringify(oddSubsections('### 2.0\n\n####\n\n- x\n\n#### Added\n\n- y\n')));
  // [Unreleased] carries the headings of the release being prepared. It may be empty (nothing written yet), but a
  // heading there must be one of the same names -- "Next version:" above a "#### Upgrading" would hide new work in a
  // section no release reads.
  check('CHANGELOG.md: [Unreleased]\'s own subsection headings are Keep a Changelog names',
    unreleasedKinds(text).every((k) => KEEP_A_CHANGELOG.includes(k)), unreleasedKinds(text).join(', '));
  check('CHANGELOG.md: [Unreleased] carries no level-3 heading (its subsections are "####")',
    unreleasedLevel3(text).length === 0, unreleasedLevel3(text).join(', '));
  check('...and an invented [Unreleased] heading is reported',
    unreleasedKinds('## [Unreleased]\n\nNext version: 1.0.0\n\n#### Upgrading\n\n- x\n\n### 0.9.0\n').join() === 'Upgrading',
    unreleasedKinds('## [Unreleased]\n\n#### Upgrading\n\n- x\n\n### 0.9.0\n').join());
  // An H3 name under [Unreleased] is a .md mistake ("### Fixed" instead of "#### Fixed"). It must be reported, and it
  // must not end the region: when it did, both this scan and bareLetterLines saw nothing past it and stayed green
  // (that is how an H3 entry shipped once with a stray "D" and an invented subsection both invisible).
  const H3 = '## [Unreleased]\n\nNext version: 1.0.0\n\n### Fixed\n\n- a real entry\n\nD\n\n#### Upgrading\n\n- x\n\n### 0.9.0\n';
  check('...and a level-3 heading under [Unreleased] is reported by name',
    unreleasedLevel3(H3).join() === 'Fixed', unreleasedLevel3(H3).join());
  check('...and it does not end the scan: the entries after it are still read',
    unreleasedKinds(H3).join() === 'Upgrading' && bareLetterLines(H3).map((x) => x.text).join() === 'D',
    `kinds ${unreleasedKinds(H3).join(', ')} / letters ${JSON.stringify(bareLetterLines(H3))}`);
  check('...while a release heading does end it, and an H3 name above one is not that release\'s',
    unreleasedLevel3('## [Unreleased]\n\n### 0.9.0\n\n### Fixed\n').length === 0,
    unreleasedLevel3('## [Unreleased]\n\n### 0.9.0\n\n### Fixed\n').join());

  // A merge can leave an unresolved conflict marker, or a stray one- to three-letter line, and a changelog with
  // either reads as broken to everyone after. Both are checked on the real file, and each rule is proven to bite on a
  // fixture built here (so neither check can pass by its pattern never matching anything).
  check('CHANGELOG.md: no conflict marker ("<<<<<<<", "=======", ">>>>>>>") anywhere in the file',
    conflictMarkers(text).length === 0, conflictMarkers(text).slice(0, 3).join(' | '));
  check('...and a marker in any section and any of the four shapes is reported (diff3 adds "|||||||")',
    conflictMarkers('## [Unreleased]\n<<<<<<< HEAD\n- a\n||||||| base\n- old\n=======\n- b\n>>>>>>> branch\n\n### 0.9.0\n#### Added\n- c\n').length === 4,
    JSON.stringify(conflictMarkers('## [Unreleased]\n<<<<<<< HEAD\n- a\n||||||| base\n- old\n=======\n- b\n>>>>>>> branch\n'))); 
  check('...and a line that merely starts with "=" as prose is not a marker (seven of them, then a space or the end)',
    conflictMarkers('## [Unreleased]\n===== a five-sign rule\n= a one-sign line\n- an = sign inside a bullet\n').length === 0);
  check('CHANGELOG.md: [Unreleased] carries no bare one- to three-letter line (what a merge script leaves: "D")',
    bareLetterLines(text).length === 0, bareLetterLines(text).slice(0, 3).map((x) => JSON.stringify(x)).join(' | '));
  {
    const found = bareLetterLines('## [Unreleased]\n\n#### Fixed\n\n- a real entry\n\nD\nAB\nxyz\n\nadded\n\n### 0.9.0\n\nD\n');
    check('...and a bare letter in [Unreleased] is reported, two and three letters too, and a word is not',
      found.map((x) => x.text).join() === 'D,AB,xyz', JSON.stringify(found));
  }
  check('...and a bare letter in a RELEASED section is not this rule\'s (frozen against its tag, caught there)',
    bareLetterLines('## [Unreleased]\n\n#### Fixed\n\n- x\n\n### 0.9.0\n\nD\n').length === 0);

  // A kind written twice under [Unreleased]: a new entry goes in the subsection of its kind, and two "#### Fixed"
  // blocks read as two releases' worth of one kind in a section not released at all. The message names the kind and
  // every line it is a heading on, so a reader with three or more goes straight to each of them.
  check('CHANGELOG.md: [Unreleased] carries each "#### Kind" heading once',
    duplicateUnreleasedKinds(text).length === 0, duplicateUnreleasedKinds(text).join(' | '));
  {
    // the line numbers below were counted by hand: "#### Fixed" is on lines 9 and 13 of this fixture
    const DUP = ['# Changelog', '', '## [Unreleased]', '', '#### Added', '', '- a', '',
      '#### Fixed', '', '- b', '', '#### Fixed', '', '- c', '', '### 0.4.0', '', '#### Fixed', ''].join('\n');
    const found = duplicateUnreleasedKinds(DUP);
    check('...and two "#### Fixed" under [Unreleased] are reported by kind, with EVERY line it is a heading on',
      found.length === 1 && found[0] === 'Fixed: line 9 and line 13', JSON.stringify(found));
    // each kind once is what the section wants, in whatever order
    check('...and each kind once, in any order, is not reported',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n- b\n\n#### Added\n\n- a\n\n### 0.4.0\n').length === 0);
    // a repeat INSIDE a released section is that section's history, which this rule does not touch (it is frozen
    // against its tag; a duplicate there is the tag comparison's, not this one's)
    check('...and a repeated kind inside a RELEASED section is not this rule\'s',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n- a\n\n### 0.4.0\n\n#### Fixed\n\n- x\n\n#### Fixed\n\n- y\n').length === 0);
    // more than two: every heading is named, not just the first pair
    check('...and three "#### Changed" name all three lines',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Changed\n\n#### Changed\n\n#### Changed\n\n### 0.4.0\n').join() === 'Changed: line 3 and line 5 and line 7',
      JSON.stringify(duplicateUnreleasedKinds('## [Unreleased]\n\n#### Changed\n\n#### Changed\n\n#### Changed\n\n### 0.4.0\n')));
    // the section ends where the other [Unreleased] scans end: a "### Fixed" name is not a boundary, so the headings
    // after it are still [Unreleased]'s and the repeats among them are counted (lines 3, 7 and 9 by hand)
    check('...and the region is read as the other [Unreleased] scans read it (a "### " name does not end it)',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n### Fixed\n\n#### Fixed\n\n#### Fixed\n\n### 0.4.0\n').join() === 'Fixed: line 3 and line 7 and line 9',
      JSON.stringify(duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n### Fixed\n\n#### Fixed\n\n#### Fixed\n\n### 0.4.0\n')));
    // a "#### " heading with trailing spaces is the same heading as without (as subsectionKinds reads it)
    check('...and "#### Fixed " with trailing spaces is counted as "Fixed"',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n#### Fixed \n\n### 0.4.0\n').length === 1);
  }

  // A fenced code block ("```" or "~~~") under [Unreleased] is an error, not an example to skip: every rule that
  // keeps this section honest reads structure line by line, and the fence skip this replaces kept needing fixes that
  // each left a way for a quoted heading to hide a real duplicate or end the region early. So the guard
  // reads no fences at all -- the section may not carry one, and the docs or prose describe the shape instead.
  {
    const un = (lines) => ['# Changelog', '', '## [Unreleased]', '', ...lines, '', '### 0.4.0', '', '#### Fixed', ''].join('\n');
    check('CHANGELOG.md: [Unreleased] carries no fenced code block (```) or tilde fence (~~~)',
      unreleasedFences(text).length === 0, unreleasedFences(text).map((x) => `line ${x.line}: ${x.text}`).join(' | '));
    // both fence characters, both reported by line; an info string ("```md") is a fence line too
    const FENCED = un(['- an entry', '', '```md', '#### Fixed twice inside is a fence the guard reports', '```', '', '~~~', '~~~']);
    const found = unreleasedFences(FENCED);
    check('...and a fenced code block under [Unreleased] is reported naming every fence line (``` and ~~~)',
      found.length === 4 && found.map((x) => x.line).join() === '7,9,11,12' && found[0].text === '```md',
      JSON.stringify(found));
    // the closing line of a fence is a fence line too: one fence, two reports, so a reader sees where it ends
    check('...and a fence written with an indent of up to three spaces, or on a CRLF file, is a fence',
      unreleasedFences('## [Unreleased]\r\n\r\n   ```\r\n- x\r\n   ```\r\n\r\n### 0.4.0\r\n').map((x) => x.line).join() === '3,5',
      JSON.stringify(unreleasedFences('## [Unreleased]\r\n\r\n   ```\r\n- x\r\n   ```\r\n\r\n### 0.4.0\r\n')));
    // a fence in a RELEASED section is that section's history, frozen against its tag: not this rule's
    const releasedFence = '## [Unreleased]\n\n#### Changed\n\n- a\n\n### 0.4.0\n\n```\n#### Fixed twice\n```\n';
    check('...and a fence inside a RELEASED section is not this rule\'s (the tag comparison holds it)',
      unreleasedFences(releasedFence).length === 0, JSON.stringify(unreleasedFences(releasedFence)));
    // with no fence skip, the shape the old rule failed open on is now caught twice over: the fence is an error,
    // AND what it quotes is read as the structure it was going to be mistaken for -- so neither can hide it
    check('...and a duplicate "#### Fixed" around a fence is still caught (the skip that hid it is gone)',
      duplicateUnreleasedKinds(un(['#### Fixed', '', '- one', '', '```', '', '#### Fixed', '', '- a real one', '', '```'])).join() === 'Fixed: line 5 and line 11',
      JSON.stringify(duplicateUnreleasedKinds(un(['#### Fixed', '', '- one', '', '```', '', '#### Fixed', '', '- a real one', '', '```']))));
    // a fence under the real [Unreleased] that quotes a release heading is itself reported (the section may not
    // carry one), and the quoted heading is structure to the region rule, which ends only at a version heading --
    // so the file is red on the fence line, never silent
    check('...and a fenced "### 0.4.0" under the real heading is a fence line the guard reports (never silent)',
      unreleasedFences('## [Unreleased]\n\n```md\n### 0.4.0\n#### Fixed\n```\n\n#### Added\n\n- real\n\n#### Added\n\n- a real duplicate\n').map((x) => x.line).join() === '3',
      JSON.stringify(unreleasedFences('## [Unreleased]\n\n```md\n### 0.4.0\n#### Fixed\n```\n\n#### Added\n\n- real\n\n#### Added\n\n- a real duplicate\n')));
    // a duplicated "## [Unreleased]" heading (merge debris) is not a release heading: the region runs on through
    // it, so a real duplicate and a stray letter below it are still reported
    check('...and a duplicated "## [Unreleased]" heading does not hide what is below it',
      duplicateUnreleasedKinds('## [Unreleased]\n\n#### Fixed\n\n- a\n\n## [Unreleased]\n\n#### Fixed\n\n- b\n\nD\n').join() === 'Fixed: line 3 and line 9' &&
      bareLetterLines('## [Unreleased]\n\n#### Fixed\n\n- a\n\n## [Unreleased]\n\n#### Fixed\n\n- b\n\nD\n').map((x) => x.text).join() === 'D');
    // an ordinary line that merely starts with backticks is prose, not a fence (CommonMark wants three or more)
    check('...while a line of two backticks, or a bullet quoting a fence, is prose, not a fence',
      unreleasedFences(un(['- the `` inline code `` shape', '', '- the ` ``` ` quoted in a bullet'])).length === 0,
      JSON.stringify(unreleasedFences(un(['- the `` inline code `` shape', '', '- the ` ``` ` quoted in a bullet']))));
  }

  // A "####" heading with no name: no rule that reads headings by name can report it (there is no name to report), so
  // it used to pass unmentioned, and with spaces after it ("####   ") it counted as a kind called " " -- which fits no
  // heading list and tells a reader nothing. It is now reported by line, by its own check.
  {
    const un = (h) => `## [Unreleased]\n\n${h}\n\n- a\n\n### 0.4.0\n`;
    check('...and a "#### " heading with no name is reported by line, not read as a kind',
      unreleasedNamelessHeadings(un('#### ')).join() === 'line 3: "#### " has no name' &&
      unreleasedKinds(un('#### ')).length === 0,
      JSON.stringify(unreleasedNamelessHeadings(un('#### '))));
    check('...and "####" alone, and "####   " (which used to read as the kind " "), are reported the same way',
      unreleasedNamelessHeadings(un('####')).join() === 'line 3: "####" has no name' &&
      unreleasedNamelessHeadings(un('####   ')).join() === 'line 3: "####   " has no name' &&
      unreleasedKinds(un('####   ')).length === 0,
      `${JSON.stringify(unreleasedNamelessHeadings(un('####')))} / ${JSON.stringify(unreleasedNamelessHeadings(un('####   ')))} / kinds ${JSON.stringify(unreleasedKinds(un('####   ')))}`);
    check('...and a nameless LEVEL-3 heading is reported the same way (and is not a level-3 name)',
      unreleasedNamelessHeadings(un('###  ')).join() === 'line 3: "###  " has no name' && unreleasedLevel3(un('###  ')).length === 0,
      `${JSON.stringify(unreleasedNamelessHeadings(un('###  ')))} / H3 ${JSON.stringify(unreleasedLevel3(un('###  ')))}`);
    check('...and a named heading is not reported (the check is not vacuous), and "####X" is prose, not a heading',
      unreleasedNamelessHeadings(un('#### Fixed')).length === 0 && unreleasedKinds(un('#### Fixed')).join() === 'Fixed' &&
      unreleasedKinds(un('####X')).length === 0 && unreleasedNamelessHeadings(un('####X')).length === 0,
      `kinds ${JSON.stringify(unreleasedKinds(un('####X')))} / nameless ${JSON.stringify(unreleasedNamelessHeadings(un('####X')))}`);
    check('CHANGELOG.md: [Unreleased] carries no "####" heading with no name',
      unreleasedNamelessHeadings(text).length === 0, unreleasedNamelessHeadings(text).join(' | '));
  }
}

// ---------------- the fixtures for the tail-of-section gap ----------------
// Seven candidate/tagged pairs in tests/fixtures/changelog-guard/, each with the verdict measured on the guard BEFORE
// the section-boundary fix ("now") and the one the fixed guard must give ("afterFix"). f2 is the real gap: a
// "### Fixed" block appended after the last entry of a released section (what a merge produced). It parsed as outside
// the section on both sides, so the section compared equal and the inserted entries were never looked at. f3-f6 are
// positive controls the guard already caught; f1 and f7 must stay green (an [Unreleased] addition is legitimate).
// Both columns are kept, so a future change to the boundary says whether it did only what it meant to.
{
  const dir = path.join(root, 'tests', 'fixtures', 'changelog-guard');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  check('changelog fixtures: all seven are present', files.length === 7, files.join(', '));
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = guard({ text: c.candidate, tagText: (tag) => (c.tags.includes(tag) ? c.tagged : null), tags: c.tags, ci: true, allowed: [], aliases: {} });
    const verdict = r.failures.length ? 'FAIL' : 'PASS';
    check(`changelog fixture ${f.replace(/\.json$/, '')}: ${verdict === c.expect.afterFix ? c.expect.afterFix : 'the fixed guard gives ' + verdict}`,
      verdict === c.expect.afterFix, r.failures[0] || '');
    // and the "now" column is the historical record: it must still name the pre-fix verdict
    check(`changelog fixture ${f.replace(/\.json$/, '')}: its "now" verdict is recorded`, !!c.expect.now && ['PASS', 'FAIL'].includes(c.expect.now), c.expect.now);
  }
  // the fix itself, on the case that matters: with the OLD boundary back, f2 is PASS (the gap returns)
  const f2 = JSON.parse(fs.readFileSync(path.join(dir, 'f2-tail-three-hash.json'), 'utf8'));
  // the shape, read as the parser reads it: the stray block is inside 9.9-pre's section and not in the tagged one
  check('changelog fixtures: f2 is the tail case (a "### Fixed" block after the last entry, still inside the section)',
    /^### Fixed$/m.test(f2.candidate) && !/^### Fixed$/m.test(f2.tagged) && /stray one/.test(parse(f2.candidate).sections['9.9-pre'])
    && !/stray one/.test(parse(f2.tagged).sections['9.9-pre']),
    JSON.stringify(parse(f2.candidate).sections['9.9-pre'].split('\n').slice(-4)));
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

  // A section runs to the next VERSION heading, not to the next "### <anything>": a "### Fixed" block appended inside
  // a released section is part of that section and must be compared. It used to end the section, so the block was
  // never seen -- a merge resolution did exactly that and this suite stayed green. Each case is a fixture whose
  // verdict was measured on the version before the fix (missed) and after it (caught).
  {
    const BASE = ['# Changelog', '', '## [Unreleased]', '',
      '### 0.2.0', '', '#### Added', '', '- new added', '', '#### Changed', '', '- new changed', '', '#### Fixed', '', '- new fixed', '',
      '### 0.1.8-pre', '', '#### Added', '', '- older added', '',
      '### 0.1.7-pre', '', '#### Added', '', '- 017 added', ''].join('\n');
    const inside = (ins) => BASE.replace('- new fixed\n', '- new fixed\n' + (ins.length ? ins.join('\n') + '\n' : ''));
    const repo = (text) => guard({ text, tagText: (t) => (t === 'v0.2.0' || t === 'v0.1.8-pre' || t === 'v0.1.7-pre' ? BASE : null),
      tags: ['v0.2.0', 'v0.1.8-pre', 'v0.1.7-pre'], ci: true, allowed: [], aliases: {} });
    const changed = (text) => repo(text).failures.some((f) => /0\.2\.0 is a released section/.test(f));

    check('section boundary: an unchanged file passes (the fixture baseline is coherent)', repo(BASE).failures.length === 0, names(repo(BASE)));
    check('section boundary: "### Fixed" + a bullet at the TAIL of a released section is caught (was missed)',
      changed(inside(['', '### Fixed', '', '- a merged-in fix'])), names(repo(inside(['', '### Fixed', '', '- a merged-in fix']))));
    check('section boundary: "### Fixed" mid-section, with text after it, is caught too (the rest was shadowed)',
      changed(inside(['', '### Fixed', '', '- a late fix', '', '#### Changed', '', '- new changed'])),
      names(repo(inside(['', '### Fixed', '', '- a late fix', '', '#### Changed', '', '- new changed']))));
    check('section boundary: "#### Fixed" + a bullet inside a section is still caught', changed(inside(['', '#### Fixed2', '', '- x'])));
    check('section boundary: a bare bullet inside a section is still caught', changed(inside(['- a stray bullet'])));
    // "### Fixed" where it belongs -- under [Unreleased] -- is NOT a change to a released section
    const good = BASE.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n### Fixed\n\n- a fix waiting for release\n\n');
    check('section boundary: "### Fixed" under [Unreleased] is not a released section and passes',
      !changed(good) && repo(good).failures.length === 0, names(repo(good)));
    // and the sections parse as they are read: 0.2.0's section includes a trailing "### Fixed" block, not just the text before it
    const withTail = inside(['', '### Fixed', '', '- a merged-in fix']);
    check('section boundary: the "### Fixed" block is IN the released section when it is parsed',
      /a merged-in fix/.test(parse(withTail).sections['0.2.0']) && !/0\.1\.8-pre/.test(parse(withTail).sections['0.2.0']),
      JSON.stringify(parse(withTail).sections['0.2.0'].split('\n').slice(-3)));
  }
  // parse: a "####" heading does not end a section, a "###" or "##" one does
  const p = parse('## [Unreleased]\n\n### 2.0\n\n#### Added\n\n- x\n\n## Links\n\n### 1.0\n- y\n');
  check('parse: #### stays inside a section, a ## heading ends it, [Unreleased] is seen', p.unreleased && p.versions.join() === '2.0,1.0' && /- x/.test(p.sections['2.0']) && !/Links/.test(p.sections['2.0']), JSON.stringify(p.versions));
}

console.log(fail ? `${fail} FAILED` : 'all changelog checks passed');
process.exitCode = fail ? 1 : 0;
