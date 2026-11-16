// README.md: built only from what GitHub Markdown renders, every
// local link and picture exists (in docs/*.md too), every in-page link has its heading, the links it must have are there, and
// nothing public points at the archive's ROM folder. Pictures are the emulator's own captures.
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
// code blocks and inline code don't count as markup
const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

// HTML: only tags GitHub keeps (it strips style and script; layout comes from tables, alignment and details)
const ALLOWED = new Set(['p', 'a', 'img', 'b', 'h1', 'table', 'tr', 'td', 'details', 'summary', 'br']);
const tags = [...text.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)].map((m) => m[1].toLowerCase());
const odd = [...new Set(tags.filter((t) => !ALLOWED.has(t)))];
check('only HTML that GitHub renders', !odd.length, odd.join(', '));
check('no style attributes or scripts', !/\sstyle=|<script/i.test(text));
check('every <details> is closed', (text.match(/<details>/g) || []).length === (text.match(/<\/details>/g) || []).length);

// links and pictures, in README.md and every docs/*.md: local files exist, and every #anchor names a heading (or an
// <a id>) in the file it points at
// GitHub heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered -1, -2, ...
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const strip = (src) => src.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
const anchorsOf = (file) => {
  const src = strip(fs.readFileSync(file, 'utf8')), seen = new Map(), out = new Set();
  for (const [, h] of src.matchAll(/^#{1,6} (.+)$/gm)) {
    const base = slug(h), n = seen.get(base) || 0;
    seen.set(base, n + 1); out.add(n ? `${base}-${n}` : base);
  }
  for (const [, id] of src.matchAll(/<a id="([^"]+)"/g)) out.add(id);
  return out;
};
const linksOf = (src) => [...src.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).concat([...src.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]));
// every broken local link or anchor in one Markdown file, as "file: link"
const brokenLinks = (file) => {
  const dir = path.dirname(file), bad = [];
  for (const l of linksOf(strip(fs.readFileSync(file, 'utf8')))) {
    if (/^[a-z]+:/i.test(l)) continue;
    const [p, frag] = l.split('#');
    const target = p ? path.join(dir, decodeURIComponent(p)) : file;
    if (!fs.existsSync(target)) { bad.push(`${path.relative(ROOT, file)}: ${l}`); continue; }
    if (frag !== undefined && /\.md$/.test(target) && !anchorsOf(target).has(frag)) bad.push(`${path.relative(ROOT, file)}: ${l}`);
  }
  return bad;
};
const links = linksOf(text);
const local = links.filter((l) => !/^[a-z]+:/i.test(l) && !l.startsWith('#'));
check('README has its local links', local.length >= 8, `${local.length}`);
const DOCS = path.join(ROOT, 'docs');
const mdFiles = [path.join(ROOT, 'README.md'), ...fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')).map((f) => path.join(DOCS, f))];
for (const f of mdFiles) {
  const bad = brokenLinks(f);
  check(`${path.relative(ROOT, f)}: every local link, picture and anchor resolves`, !bad.length, bad.join(', '));
}
// the check itself: a broken file link and a broken anchor are both caught
const probe = path.join(DOCS, '.readme-test-probe.md');
fs.writeFileSync(probe, '# Probe\n\n[gone](no-such-file.md) [bad](roms.md#no-such-heading) [ok](#probe)\n');
try {
  const bad = brokenLinks(probe);
  check('the link check catches a missing file and a missing anchor, and passes a good one', bad.length === 2, bad.join(', '));
} finally { fs.unlinkSync(probe); }
for (const [what, re] of [['the site', /https:\/\/cloadm\.dev\/play\//], ['/roms', /https:\/\/cloadm\.dev\/roms\//], ['AGENTS.md', /\(AGENTS\.md\)/],
  ['CREDITS.md', /\(CREDITS\.md\)/], ['CONTRIBUTING.md', /CONTRIBUTING\.md/], ['issues', /github\.com\/yaniv-golan\/cloadm\/issues/], ['LICENSE', /\(LICENSE\)/]]) {
  check(`links ${what}`, re.test(md));
}
check('never links the archive\'s ROM folder', !/colorcomputerarchive\.com\/repo\/ROMs/i.test(md));

// pictures: PNGs captured from the emulator (tools/capture-images.js), 4:3, with alt text
const imgs = [...md.matchAll(/<img src="([^"]+)"[^>]*alt="([^"]+)"/g)];
check('every picture has alt text', imgs.length === (md.match(/<img /g) || []).length && imgs.length >= 2);
for (const [, src] of imgs) {
  const b = fs.readFileSync(path.join(ROOT, src));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  check(`${src}: a PNG captured by tools/capture-images.js, 4:3`, b.slice(1, 4).toString() === 'PNG' && w * 3 === h * 4
    && fs.readFileSync(path.join(ROOT, 'tools/capture-images.js'), 'utf8').includes(path.basename(src)), `${w}x${h}`);
}
// the ROM table is still the generated one (tests/romdocs.test.js compares its rows)
check('the generated ROM table is kept', /<!-- rom-table:start[\s\S]*<!-- rom-table:end -->/.test(md));

// docs/architecture.md states the range of snapshot versions a page reads. Nothing used to tie that sentence to
// the code, so it could drift silently on the next bump; compare it with the constants themselves, never with a literal.
{
  const Emu = require('./load')();
  const arch = fs.readFileSync(path.join(DOCS, 'architecture.md'), 'utf8');
  const m = /`SNAPSHOT_OLDEST`\s+to\s+`SNAPSHOT_VERSION`\s+\(now\s+(\d+)\s+to\s+(\d+)\)/.exec(arch);
  check('docs/architecture.md names the snapshot range the code has', !!m && Number(m[1]) === Emu.SNAPSHOT_OLDEST && Number(m[2]) === Emu.SNAPSHOT_VERSION,
    m ? `the doc says ${m[1]} to ${m[2]}, code has ${Emu.SNAPSHOT_OLDEST} to ${Emu.SNAPSHOT_VERSION}` : 'the sentence is not in docs/architecture.md');
  // and the two format identifiers it names: the one written, and the pre-release one that is refused
  const f = /`format` \(`"([^"]+)"`\)/.exec(arch), pre = /pre-release builds carry the identifier `"([^"]+)"`/.exec(arch);
  check('docs/architecture.md names the format identifiers the code has', !!f && !!pre && f[1] === Emu.SNAPSHOT_FORMAT && pre[1] === Emu.PRERELEASE_SNAPSHOT_FORMAT,
    `${f && f[1]} / ${pre && pre[1]}`);
}

console.log(fail ? `${fail} FAILED` : 'all README checks passed');
process.exitCode = fail ? 1 : 0;
