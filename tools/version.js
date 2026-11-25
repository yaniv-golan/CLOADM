#!/usr/bin/env node
// js/version.js: the version CLOADM shows (Help, About, the settings drawer, bug reports) and the commit it was
// published from.
//
//   node tools/version.js --write             copy CHANGELOG.md's "Next version" into js/version.js
//   node tools/version.js --check             exit 1 if js/version.js is out of step (tests/version.test.js runs it too)
//   node tools/version.js --stamp FILE SHA    write the commit into a STAGED copy of js/version.js (the Pages deploy:
//                                             .github/workflows/pages.yml). Never run on the repository's own file.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'js', 'version.js');
const VERSION_RE = /^export const VERSION = '([^']*)';$/m, COMMIT_RE = /^export const COMMIT = '([^']*)';$/m;

// CHANGELOG.md's "Next version: X" under [Unreleased] (the same reading as tests/plugin.test.js)
function nextVersion(changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')) {
  const unreleased = changelog.split(/^### \d/m)[0];
  const m = /^Next version: (\S+?)\.? /m.exec(unreleased) || /^Next version: (\S+)$/m.exec(unreleased);
  if (!m) throw new Error('CHANGELOG.md: no "Next version:" line under [Unreleased]');
  return m[1];
}
const read = (text) => ({ version: (VERSION_RE.exec(text) || [])[1], commit: (COMMIT_RE.exec(text) || [])[1] });
function withVersion(text, version) {
  if (!VERSION_RE.test(text)) throw new Error('js/version.js: no VERSION line');
  return text.replace(VERSION_RE, `export const VERSION = '${version}';`);
}
function withCommit(text, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit hash: ${sha}`);
  if (!COMMIT_RE.test(text)) throw new Error('js/version.js: no COMMIT line');
  return text.replace(COMMIT_RE, `export const COMMIT = '${sha}';`);
}
module.exports = { nextVersion, read, withVersion, withCommit, FILE };

if (require.main === module) {
  const a = process.argv.slice(2);
  const cur = fs.readFileSync(FILE, 'utf8');
  if (a[0] === '--write') {
    const next = withVersion(cur, nextVersion());
    if (next !== cur) fs.writeFileSync(FILE, next);
    console.log(`js/version.js: ${read(next).version}`);
  } else if (a[0] === '--check') {
    const ok = read(cur).version === nextVersion() && read(cur).commit === '';
    if (!ok) { console.error('js/version.js is out of step with CHANGELOG.md (run: node tools/version.js --write), or holds a commit'); process.exitCode = 1; }
  } else if (a[0] === '--stamp' && a[1] && a[2]) {
    const f = path.resolve(a[1]);
    if (f === FILE) { console.error('--stamp writes a staged copy, never the repository\'s js/version.js'); process.exitCode = 1; }
    else { fs.writeFileSync(f, withCommit(fs.readFileSync(f, 'utf8'), a[2])); console.log(`${a[1]}: ${read(fs.readFileSync(f, 'utf8')).commit}`); }
  } else { console.error('usage: node tools/version.js --write | --check | --stamp FILE SHA'); process.exitCode = 2; }
}
