// The rule that keeps a RELEASED section of CHANGELOG.md as it was released, pure and separate from git so every case
// can be tested on fixtures (tests/changelog.test.js runs it on this repository's real tags and on fixtures).
//
// The layout of CHANGELOG.md: new work goes under "## [Unreleased]"; every "### <version>" heading below it is a
// release (the heading of the newest one sits directly under [Unreleased] in this file, which is why it looks
// unreleased and is not). A released section is the text from its "### <version>" line to the next heading of
// level 1 to 3. Three branches in one day put new entries into released sections; this is the check that catches it.
//
// For each released version with a git tag, the section must be byte-identical to the same section in the tagged
// CHANGELOG, except for two things. The maintainers' internal process labels (the patterns tests/internal-labels.test.js keeps out of
// the tree, required from it) are removed from both sides before they are compared, so a
// released section may lose a label and nothing else. And corrections listed by name in the allowlist (each is "this
// text in the tagged section became that text", with a one-line reason; the tagged text, labels removed, must still
// contain it, so a list entry cannot go stale).
// A release heading: "### 0.1.3-pre", "### 0.1.0 (first public release ...)". Not "#### Added" or "#### Fixed", which are
// the subsections of [Unreleased] and are not releases.
const { stripLabels } = require('./internal-labels.test.js');
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
    const k = kindOfHeading(line);
    if (k) out.push(k);                         // '' (a heading with no name) is not a kind this section uses
  }
  return [...new Set(out)];
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
    // a "####" heading a later reader sees with no name files nothing under any kind: reported by line here, where
    // no list of kind names can reach it (a section released before this rule carries the tag's copy, which has it too)
    now.sections[v].split('\n').forEach((line, i) => {
      if (kindOfHeading(line) === '') bad.push(`${v}: line ${i + 1} of the section, ${JSON.stringify(line)}, has no section name`);
    });
  }
  return bad;
}

// [Unreleased]'s own subsections: the section keeps "Next version: X" and then the headings of the release being
// prepared, all of which must be Keep a Changelog names. A release is not prepared in a heading of its own kind.
const UNRELEASED_BOUNDARY = /^### \d/;

// The lines of the [Unreleased] region: from its "## [Unreleased]" heading to the first release heading after it.
// Nothing else ends it. A level-3 name ("### Fixed") is a .md mistake its own scan reports, not a boundary: treating
// it as one once ended the scan before the entries, so a stray "D" and an invented subsection both went unreported
// while the check stayed green. A duplicated "## [Unreleased]" heading is merge debris, not a release heading: the
// region runs on through it, so the entries below it are still scanned. And a genuine level-1/2 heading below
// [Unreleased] with no release heading between (a "## Links") cannot occur in a file this guard passes: check()
// fails a CHANGELOG with no "### <version>" heading at all. This is deliberately not SECTION_BOUNDARY (a released
// section also ends at a level 1-2 heading): a released section is compared against its tag, whose text says where
// it ends, while [Unreleased] is the one region every scan below reads the same way.
function unreleasedRegion(lines) {
  let from = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \[Unreleased\]/i.test(lines[i])) { from = i; break; }
  }
  if (from < 0) return { from, to: from };
  for (let i = from + 1; i < lines.length; i++) {
    if (UNRELEASED_BOUNDARY.test(lines[i])) return { from, to: i };
  }
  return { from, to: lines.length };
}

// A fenced code block ("```" or "~~~") anywhere under [Unreleased] is an error: a fence shows an example, and every
// rule that keeps this section honest reads structure line by line -- an example quoting a "#### Fixed" twice, a
// "### 0.4.0" heading or a "## [Unreleased]" line would be read as real structure, and the fence skip this replaces
// kept needing fixes that each left a new way for one to hide a real duplicate or end the region early. So the section carries
// no fences at all: describe the shape in prose, or link to the docs that show it. Every line that opens or closes
// a fence is reported by its line number, so a fence of two lines names both. The rule reads a fence line however
// CommonMark would (the up-to-three spaces of indent, the closing "\r" of a Windows-saved file), so a fence that
// renders as a fence is a fence that is reported. Released sections are not touched: whatever they hold is compared
// with their tag byte for byte, which no fence can hide.
//
// The one shape the flat rule trades away (deliberately, for simplicity): an example ABOVE the real heading that
// quotes a "## [Unreleased]" line steals the region's start, and the real section below it is not scanned -- the
// old fence parser caught that, and no fence-free rule can. It needs an example quoting this file's own layout
// above the section that copies it; the release-heading comparison still holds every released section to its tag.
// -> [{ line: 7, text: '```md' }, ...], one entry per fence line.
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
function unreleasedFences(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const out = [];
  for (let i = from + 1; i < to; i++) {
    if (FENCE_LINE.test(lines[i].replace(CR, ''))) out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
}

const CR = /\r$/;

// A "#### Kind" heading's kind: the text after the four hashes, without the padding around it. null when the line is
// not a "####" heading ("####Added" is prose: Markdown wants a space), '' when it is one with no name after it
// ("####", "#### ", "####   "). A heading with no name is not a kind, so every scan that reads headings by name
// leaves it out -- otherwise "####   " is counted as a kind called " ", which fits no heading list, named nothing a
// reader could act on, and reads as a subsection that files nothing. A nameless heading is reported by line instead:
// under [Unreleased] by unreleasedNamelessHeadings, and in a released section by oddSubsections (the byte comparison
// against the tag would also catch a newly inserted one, but a section whose bytes match its tag may still carry one).
const KIND_HEADING = /^####(?:\s|$)/;
const kindOfHeading = (line) => (KIND_HEADING.test(line) ? line.slice(4).trim() : null);

function unreleasedKinds(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const kinds = [];
  for (let i = from + 1; i < to; i++) {
    const k = kindOfHeading(lines[i]); if (k && !kinds.includes(k)) kinds.push(k);
    // a level-3 name here is a mistake its own check reports (it is not a Keep a Changelog subsection), so it is
    // read as a heading that the scanner must not stop at, rather than silently ending the region
  }
  return kinds;
}

// A heading a reader sees in [Unreleased] with no name: "####", "####   ", "###  ". No rule that reads headings by
// name can report one (there is no name to report), so the scans above drop it and the section looks correct, while
// what a reader sees is an empty subsection -- what a keystroke or a merge leaves. Named by line, both levels that
// [Unreleased] may carry (its subsections are "###" and "####"; a level 1-2 heading ends it):
// -> ['line 7: "####   " has no name', ...], one entry per heading.
const NAMELESS_HEADING = /^(#{3,4})(?:\s|$)/;
const namelessNameOf = (line) => { const m = NAMELESS_HEADING.exec(line); return m ? line.slice(m[1].length).trim() : null; };
function unreleasedNamelessHeadings(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const out = [];
  for (let i = from + 1; i < to; i++) {
    if (namelessNameOf(lines[i]) === '') out.push(`line ${i + 1}: ${JSON.stringify(lines[i])} has no name`);
  }
  return out;
}

// A level-3 heading under [Unreleased] ("### Fixed"): a .md mistake, since [Unreleased]'s subsections are "####" and
// "###" belongs to release headings. Reported by name rather than letting the boundary rule tolerate it silently:
// unreleasedKinds cannot see it (it matches "####" only), so without this it would pass as prose. A level-3 heading
// with no name after it ("###", "###   ") has no name to report, and is unreleasedNamelessHeadings's.
const LEVEL3_HEADING = /^###(?:\s|$)/;
function unreleasedLevel3(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const out = [];
  for (let i = from + 1; i < to; i++) {
    if (LEVEL3_HEADING.test(lines[i])) { const name = lines[i].slice(3).trim(); if (name) out.push(name); }
  }
  return out;
}

// A "#### Kind" heading written twice under [Unreleased]. A new entry goes in the subsection of its kind, and two of
// one kind (two "#### Fixed" blocks, with the entries for one kind split between them or, worse, the same heading left
// by a merge) reads as two releases' worth of one kind in a section that has not been released at all. The check is
// kept to [Unreleased], up to the first release heading: a released section is frozen against its tag, so a duplicate
// there is already a difference the tag comparison reports, and its history is not rewritten by this rule.
// Reported by kind and EVERY line it is a heading on, so a reader with three or more goes straight to each of them.
// -> ['Fixed: line 9 and line 14', ...], one entry per kind written more than once.
function duplicateUnreleasedKinds(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const at = new Map();                          // kind -> every line number it is a heading on
  for (let i = from + 1; i < to; i++) {
    const k = kindOfHeading(lines[i]);
    if (k) at.set(k, [...(at.get(k) || []), i + 1]);   // '' (a heading with no name) is that scan's, not this one's
  }
  const out = [];
  for (const [kind, ns] of at) {
    if (ns.length > 1) out.push(`${kind}: ${ns.map((n) => `line ${n}`).join(' and ')}`);
  }
  return out;
}

// ---- what a merge can leave in the file: conflict markers and a stray one-letter line ----
// A conflict marker left unresolved is never intended: "<<" "==" ">>" at the start of a line, the shape git writes
// (the seven-character forms, with or without a label). It is checked ANYWHERE in the file, because a marker can
// land in any section and, unlike prose, no line of this file should ever begin with one.
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/;   // (<, =, >, and diff3's | base marker)
function conflictMarkers(text) {
  const out = [];
  text.split('\n').forEach((line, i) => { if (CONFLICT_MARKER.test(line)) out.push(`line ${i + 1}: ${line.slice(0, 40)}`); });
  return out;
}

// A bare one- to three-letter line inside [Unreleased] ("D", "AB", "xyz"). It is what a merge script or a stray
// keystroke leaves, and it is never a changelog entry: an entry is a "- " bullet or a "#### " heading, and a line
// with a letter or two on it alone is nothing a reader should see. Kept to [Unreleased] because a released section
// is frozen against its tag (changing it fails elsewhere), so a stray line there is already caught; this catches the
// one a merge is most likely to leave where new work goes, before it reaches a release.
const BARE_LETTERS = /^[A-Za-z]{1,3}$/;
function bareLetterLines(text) {
  const lines = text.split('\n');
  const { from, to } = unreleasedRegion(lines);
  const out = [];
  for (let i = from + 1; i < to; i++) {
    if (BARE_LETTERS.test(lines[i].trim())) out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
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
    // A stray heading appended inside a released section fails even where the surrounding text still matches.
    const wasHeads = headingsOf(want), nowHeads = headingsOf(have);
    if (wasHeads.join('\n') !== nowHeads.join('\n')) {
      failures.push(`${version} is a released section (tag ${tag}) and its headings changed: released ${JSON.stringify(wasHeads)}, now ${JSON.stringify(nowHeads)}. `
        + 'New entries go under "## [Unreleased]", in a new "#### Fixed"/"#### Added" above the newest released section.');
    } else if (have !== want) {
      failures.push(`${version} is a released section (tag ${tag}) and was changed: ${firstDifference(want, have)}. `
        + 'New entries go under "## [Unreleased]", in a new "#### Fixed"/"#### Added" above the newest released section.');
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

module.exports = { parse, check, tagOf, TAG_ALIASES, ALLOWED_CORRECTIONS, subsectionKinds, oddSubsections, unreleasedKinds, unreleasedLevel3, unreleasedNamelessHeadings, unreleasedFences, duplicateUnreleasedKinds, KEEP_A_CHANGELOG, conflictMarkers, bareLetterLines };
