#!/usr/bin/env node
// The release notes for a version: its own section of CHANGELOG.md, and nothing else.
//
//   node .github/scripts/release-notes.js 0.1.8-pre          -> the notes on stdout
//   node .github/scripts/release-notes.js 0.1.8-pre out.md   -> the notes into out.md
//
// The section is the text from the "### <version>" heading to the next version heading (a level-2 heading, or a
// "### <digit>" one), with the heading
// itself and the blank lines around it taken off: what a reader of the Release page needs, and what the tagged
// CHANGELOG says word for word (tests/changelog.test.js holds the repository's copy to the tag). The subsection
// headings are "#### Added" and so on inside the file; in release notes there is no enclosing version heading, so
// they are demoted one level ("### Added") to sit under the release title rather than inside it.
//
// A version with no section is an ERROR, not empty notes: a release whose notes say nothing is worse than a release
// that does not happen. The tag has already been checked against the manifests by the time this runs (release.yml),
// so a missing section means CHANGELOG.md and the tag disagree, and that is worth failing on.
'use strict';
const fs = require('fs');
const path = require('path');

// The same boundary as tests/changelog-guard.js's parse(): a section runs to the next VERSION heading or to a level 1-2
// heading, NOT to any "### " line. A "### Fixed" written inside a released section is part of its notes (and would
// otherwise truncate them, silently dropping everything after it from the Release page).
const VERSION_HEADING = /^### (\d+\.\d+\S*)/;
const SECTION_BOUNDARY = /^(?:#{1,2} |### \d)/;
const SUBHEADING = /^#### /;

// The section for `version` in `text`, as the notes: no version heading, subheadings demoted to ###, trimmed.
// Throws when the section is absent or empty.
function notesFor(text, version) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = VERSION_HEADING.exec(lines[i]);
    if (m && m[1] === version) { start = i + 1; break; }
  }
  if (start < 0) throw new Error(`CHANGELOG.md has no "### ${version}" section`);
  let end = lines.length;
  for (let i = start; i < lines.length; i++) if (SECTION_BOUNDARY.test(lines[i])) { end = i; break; }
  const body = lines.slice(start, end).map((l) => (SUBHEADING.test(l) ? l.slice(1) : l));   // "#### Added" -> "### Added"
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (!body.length) throw new Error(`CHANGELOG.md's "### ${version}" section is empty`);
  return body.join('\n') + '\n';
}

// CHANGELOG.md's "Next version: X" line under [Unreleased]: the version a dry run is preparing, when there is no tag.
// The same line tests/plugin.test.js reads, so a dry run checks the version the manifests are meant to carry.
function nextVersion(text) {
  const head = text.split(/^### \d/m)[0];                 // the [Unreleased] section, up to the first version heading
  const m = /^Next version: (\S+?)\.?(?:\s|$)/m.exec(head);
  return m ? m[1] : null;
}

module.exports = { notesFor, nextVersion };

if (require.main === module) {
  const [version, out] = process.argv.slice(2);
  if (!version) { console.error('usage: release-notes.js <version> [outfile]'); process.exit(2); }
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  let notes;
  try { notes = notesFor(text, version); } catch (e) { console.error(e.message); process.exit(1); }
  if (out) fs.writeFileSync(out, notes); else process.stdout.write(notes);
}
