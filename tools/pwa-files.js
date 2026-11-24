#!/usr/bin/env node
// The files the service worker (sw.js) keeps for offline use: every file the site serves, apart from what only
// the README or the repository needs. `node tools/pwa-files.js` prints the list; `--write` puts it in sw.js.
// tests/pwa.test.js fails when sw.js and this list differ. tools/build-examples.js calls syncSw() after a build, so
// a new example file is in the list without a separate step.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DIRS = ['css', 'fonts', 'img', 'icons', 'js', 'examples', 'embed', 'play', 'roms', 'help', 'credits', 'faq', 'about'];
const ROOT_FILES = ['index.html', 'favicon.svg', 'favicon.ico', 'manifest.webmanifest'];
const SKIP = (rel) => /^img\/readme-/.test(rel) || /\.md$/.test(rel) || /(^|\/)\./.test(rel);

function walk(root, dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(root, rel)); else if (!SKIP(rel)) out.push(rel);
  }
  return out;
}
// './' is the landing page (/; '' would be sw.js itself), and each folder's index.html is also kept under the folder's own address
function pwaFiles(root = ROOT) {
  const files = [...ROOT_FILES, ...DIRS.flatMap((d) => walk(root, d))].sort();
  const folders = files.filter((f) => /\/index\.html$/.test(f)).map((f) => f.replace(/index\.html$/, ''));
  return ['./', ...folders, ...files];
}
const BEGIN = '// BEGIN FILES (tools/pwa-files.js --write)', END = '// END FILES';
function withList(sw, files) {
  const i = sw.indexOf(BEGIN), j = sw.indexOf(END);
  if (i < 0 || j < 0) throw new Error('sw.js: file list markers missing');
  return sw.slice(0, i + BEGIN.length) + '\nconst FILES = ' + JSON.stringify(files, null, 2).replace(/"/g, "'") + ';\n' + sw.slice(j);
}
// Rewrite sw.js's list from the files under `root`, only if it differs. Returns { changed, count }.
function syncSw(root = ROOT) {
  const p = path.join(root, 'sw.js'), files = pwaFiles(root), cur = fs.readFileSync(p, 'utf8'), next = withList(cur, files);
  if (next !== cur) fs.writeFileSync(p, next);
  return { changed: next !== cur, count: files.length };
}
module.exports = { pwaFiles, withList, syncSw, BEGIN, END };

if (require.main === module) {
  if (process.argv.includes('--write')) {
    const { count } = syncSw();
    console.log(`sw.js: ${count} files`);
  } else console.log(pwaFiles().join('\n'));
}
