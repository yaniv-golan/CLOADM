/*
 * The version stamp, "v<version> · <short commit>", shown in Help, About and the settings drawer's credits line
 * (never on the main chrome) and written into bug reports (js/bugreport.js).
 *
 * VERSION is CHANGELOG.md's "Next version" line, copied here by `node tools/version.js --write` (tests/version.test.js
 * fails when they differ). COMMIT is '' in the repository: a file cannot hold the hash of the commit that contains
 * it, and the site has no build step. The Pages deploy (.github/workflows/pages.yml) writes the published commit into
 * its staged copy of this file (`node tools/version.js --stamp`), so the site at cloadm.dev names the exact commit
 * it serves; a copy served straight from the repository says "unstamped" instead.
 */
export const VERSION = '0.4.2';
export const COMMIT = '';
export const versionStamp = (version = VERSION, commit = COMMIT) => `v${version} · ${commit ? commit.slice(0, 7) : 'unstamped'}`;
