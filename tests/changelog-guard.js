// The rule that keeps a RELEASED section of CHANGELOG.md as it was released, pure and separate from git so every case
// can be tested on fixtures (tests/changelog.test.js runs it on this repository's real tags and on fixtures).
//
// The layout of CHANGELOG.md: new work goes under "## [Unreleased]"; every "### <version>" heading below it is a
// release (the heading of the newest one sits directly under [Unreleased] in this file, which is why it looks
// unreleased and is not). A released section is the text from its "### <version>" line to the next heading of
// level 1 to 3. Three branches in one day put new entries into released sections; this is the check that catches it.
//
// For each released version with a git tag, the section must be byte-identical to the same section in the tagged
// CHANGELOG, except for two things. The maintainers' internal process labels (the patterns tests/private-refs.test.js keeps out of
// the tree, required from it) are removed from both sides before they are compared, so a
// released section may lose a label and nothing else. And corrections listed by name in the allowlist (each is "this
// text in the tagged section became that text", with a one-line reason; the tagged text, labels removed, must still
// contain it, so a list entry cannot go stale).
// A release heading: "### 0.1.3-pre", "### 0.1.0 (first public release ...)". Not "### Added" or "### Fixed", which are the
// subsections of [Unreleased] and are not releases.
const { stripLabels } = require('./private-refs.test.js');
const HEADING = /^### (\d+\.\d+\S*)/;
// A version's section ends at the NEXT VERSION heading or at a level-2/level-1 heading, never at a "### Fixed".
// It used to end at any level 1-3 heading, so a "### Fixed" block appended inside a released section (before the next
// version heading) fell outside the section: the guard compared the text before it, found no difference, and stayed
// green. A merge resolution did exactly that. Now the whole section is compared, so an inserted block is a
// difference like any other line.
const SECTION_BOUNDARY = /^(?:#{1,2} |### \d)/;

// The headings a section carries, in order: what a reader sees as its structure. A section whose headings differ from
// its tag's is reported by name, so a moved or renamed subsection is caught even if the text around it happened to
// match (and so the failure says why rather than quoting a line).
function headingsOf(section) {
  return section.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.trim());
}

// The sections of a CHANGELOG text: versions in file order, each version's section text, and whether a
// "## [Unreleased]" heading is present above the first version heading.
function parse(text) {
  const versions = [], sections = {};
  let cur = null, unreleased = false, seenVersion = false;
  for (const line of text.split('\n')) {
    const m = HEADING.exec(line);
    if (m) { cur = m[1]; if (!(cur in sections)) { versions.push(cur); sections[cur] = []; } seenVersion = true; }
    else if (SECTION_BOUNDARY.test(line)) {
      cur = null;
      if (!seenVersion && /^## \[Unreleased\]/i.test(line)) unreleased = true;
    }
    if (cur !== null) sections[cur].push(line);
  }
  const out = {};
  for (const v of versions) out[v] = sections[v].join('\n');
  return { versions, sections: out, unreleased };
}

// The subsections a release may use: the three headings of Keep a Changelog that this project writes (its "Security"
// is not used here). A released section is made of these and nothing else, so a release page reads the same way
// wherever it is shown (GitHub's Release page, a changelog viewer) instead of carrying this file's private shapes.
const KEEP_A_CHANGELOG = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const REQUIRED_KINDS = ['Added', 'Changed', 'Fixed'];

// What a section's subsections are: the distinct "#### X" headings it carries, in file order. A released section must
// use only KEEP_A_CHANGELOG names (this repository used "#### Upgrading" in its first release, named as an exception
// below, because a released section cannot be corrected retroactively without a new tag).
function subsectionKinds(section) {
  const out = [];
  for (const line of section.split('\n')) {
    const m = /^#### (.+?)\s*$/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// A released section's subsections that are not Keep a Changelog names. `allow` is the list of { version, kinds }
// exceptions (a section shipped before this rule; its tag has it and it cannot be corrected).
function oddSubsections(text, allow = []) {
  const now = parse(text);
  const bad = [];
  for (const v of now.versions) {
    const kinds = subsectionKinds(now.sections[v]);
    const allowed = new Set([...KEEP_A_CHANGELOG, ...(allow.filter((a) => a.version === v).flatMap((a) => a.kinds))]);
    const odd = kinds.filter((k) => !allowed.has(k));
    if (odd.length) bad.push(`${v}: ${odd.join(', ')}`);
  }
  return bad;
}

// [Unreleased]'s own subsections: the section keeps "Next version: X" and then the headings of the release being
// prepared, all of which must be Keep a Changelog names. A release is not prepared in a heading of its own kind.
function unreleasedKinds(text) {
  const lines = text.split('\n');
  let inUn = false;
  const kinds = [];
  for (const line of lines) {
    if (/^## \[Unreleased\]/i.test(line)) { inUn = true; continue; }
    if (inUn && /^#{1,3} /.test(line)) break;      // a version heading (or another ## heading) ends it
    if (inUn) { const m = /^#### (.+?)\s*$/.exec(line); if (m && !kinds.includes(m[1])) kinds.push(m[1]); }
  }
  return kinds;
}


// A heading's git tag: "v<version>", unless the table names another. The first release's heading is "0.1.0" and
// its tag is v0.1.0-pre (the "-pre" came with the tag, the heading kept its name).
const TAG_ALIASES = { '0.1.0': 'v0.1.0-pre' };
const tagOf = (version, aliases = TAG_ALIASES) => aliases[version] || `v${version}`;

// Corrections made to a released section after its tag. Each: the tagged section text `from` became `to`, in the
// named version's section. Nothing else may change.
const ALLOWED_CORRECTIONS = [
  { version: '0.1.1-pre',
    reason: 'copy fix, landed in v0.1.2: the switch is "Let Claude use the emulator", not "the machine"',
    from: '"Don\'t ask again this session" is offered only while "Let Claude use the machine" is on',
    to: '"Don\'t ask again this session" is offered only while "Let Claude use the emulator" is on' },
  { version: '0.1.2-pre',
    reason: 'copy fix, landed in v0.1.3: the same switch name in the consent paragraph',
    from: 'relied on the "Let Claude use the machine" switch is `no-consent`',
    to: 'relied on the "Let Claude use the emulator" switch is `no-consent`' },
  { version: '0.1.2-pre',
    reason: 'landed in v0.1.3: the tests/all.js summary-line gate paragraph moved here from 0.1.0, which is where it was released',
    from: 'Claude use the emulator" everywhere (page, docs, README).\n',
    to: 'Claude use the emulator" everywhere (page, docs, README).\n'
      + '- The test gate (`tests/all.js`) fails a suite that exits 0 without printing its summary, so a suite that stops\n'
      + '  part-way on a promise that never settles can no longer count as a pass (found by this: `tests/allsignal.test.js`\n'
      + '  had been exiting silently), and `tests/machine.test.js` now ends with the summary line every suite prints.\n' },
  { version: '0.1.1-pre',
    reason: 'labels removed: the clause about a privately tracked list loses its last word with the label, so the clause goes too',
    from: "brief or issue; contributors don't edit a.",
    to: 'brief or issue.' },
];

const firstDifference = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return `line ${i + 1} of the section: released "${(x[i] ?? '(end)').slice(0, 90)}", now "${(y[i] ?? '(end)').slice(0, 90)}"`;
};

// check({ text, tagText, tags, ci, allowed, aliases }) -> { failures: [string], skips: [string], compared: [version] }
//   text      the CHANGELOG.md to check
//   tagText   (tag) -> the CHANGELOG.md at that tag, or null when there is no such tag
//   tags      the version tags that exist, newest first ([] when none were fetched)
//   ci        true on a CI checkout: tags must be there (a missing one fails instead of skipping)
function check({ text, tagText, tags, ci = false, allowed = ALLOWED_CORRECTIONS, aliases = TAG_ALIASES }) {
  const failures = [], skips = [], compared = [];
  const now = parse(text);
  if (!now.versions.length) failures.push('CHANGELOG.md has no "### <version>" heading');
  if (ci && !tags.length) failures.push('no v* tag in this checkout: fetch the tags (actions/checkout with fetch-depth: 0, or git fetch --tags)');

  now.versions.forEach((version, i) => {
    const tag = tagOf(version, aliases), old = tagText(tag);
    if (old === null) {
      // the newest heading may be a release in preparation and have no tag yet; an older one is released
      if (ci && i > 0) failures.push(`${version}: tag ${tag} is missing in this CI checkout, so its section cannot be compared (fetch the tags)`);
      else skips.push(`SKIP ${version}: no tag ${tag} here (${i === 0 ? 'not tagged yet, or the tags are not fetched' : 'run git fetch --tags'}), section not compared`);
      return;
    }
    const was = parse(old);
    if (!(version in was.sections)) { failures.push(`${version}: tag ${tag}'s CHANGELOG.md has no "### ${version}" section`); return; }
    // labels removed from both sides (a section written without them is unchanged by this)
    let want = stripLabels(was.sections[version]);
    const have = stripLabels(now.sections[version]);
    for (const c of allowed.filter((a) => a.version === version)) {
      if (want.split(c.from).length !== 2) { failures.push(`${version}: the allowed correction "${c.reason}" no longer applies to tag ${tag}'s text (remove it from the list)`); continue; }
      want = want.replace(c.from, () => c.to);
    }
    compared.push(version);
    // The section's structure first, by name: a heading moved, renamed, added or removed is reported as that, so a
    // "### Fixed" appended inside a released section fails even where the surrounding text still matches.
    const wasHeads = headingsOf(want), nowHeads = headingsOf(have);
    if (wasHeads.join('\n') !== nowHeads.join('\n')) {
      failures.push(`${version} is a released section (tag ${tag}) and its headings changed: released ${JSON.stringify(wasHeads)}, now ${JSON.stringify(nowHeads)}. `
        + 'New entries go under "## [Unreleased]", in a new "### Fixed"/"### Added" above the newest released section.');
    } else if (have !== want) {
      failures.push(`${version} is a released section (tag ${tag}) and was changed: ${firstDifference(want, have)}. `
        + 'New entries go under "## [Unreleased]", in a new "### Fixed"/"### Added" above the newest released section.');
    }
  });

  // a released section must not be deleted: every section of the newest tag's CHANGELOG is still here
  if (tags.length) {
    const newest = tagText(tags[0]);
    if (newest !== null) {
      for (const v of parse(newest).versions) if (!(v in now.sections)) failures.push(`${v}: released in ${tags[0]} but its section is gone from CHANGELOG.md`);
    }
  }

  // the newest heading is already tagged, so it is released, and then the file needs its [Unreleased] heading for new work
  if (now.versions.length && tagText(tagOf(now.versions[0], aliases)) !== null && !now.unreleased) {
    failures.push(`${now.versions[0]} (the first version heading) is already tagged but there is no "## [Unreleased]" heading above it`);
  }
  return { failures, skips, compared };
}

module.exports = { parse, check, tagOf, TAG_ALIASES, ALLOWED_CORRECTIONS, subsectionKinds, oddSubsections, unreleasedKinds, KEEP_A_CHANGELOG };
