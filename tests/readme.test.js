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

// pictures: PNGs and GIFs captured from the emulator (tools/capture-images.js, tools/capture-gif.js), 4:3, with alt
// text. Badges are the only pictures from elsewhere: remote https images with alt text.
const imgs = [...md.matchAll(/<img src="([^"]+)"[^>]*alt="([^"]+)"/g)];
check('every picture has alt text', imgs.length === (md.match(/<img /g) || []).length && imgs.length >= 2);
const tools = ['capture-images.js', 'capture-gif.js'].map((f) => fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8'));
for (const [, src] of imgs) {
  if (/^https:\/\//.test(src)) { check(`${src}: a badge from GitHub or shields.io`, /^https:\/\/(github\.com\/yaniv-golan\/CLOADM\/actions\/|img\.shields\.io\/)/.test(src)); continue; }
  const b = fs.readFileSync(path.join(ROOT, src)), gif = b.slice(0, 6).toString() === 'GIF89a';
  const w = gif ? b.readUInt16LE(6) : b.readUInt32BE(16), h = gif ? b.readUInt16LE(8) : b.readUInt32BE(20);
  check(`${src}: a PNG or GIF captured by a tool in tools/, 4:3`, (gif || b.slice(1, 4).toString() === 'PNG') && w * 3 === h * 4
    && tools.some((t) => t.includes(path.basename(src))), `${w}x${h}`);
  if (gif) check(`${src}: animated (more than one frame), looping, under 1.5 MB`, b.includes(Buffer.from('NETSCAPE2.0')) && b.filter((x) => x === 0x2c).length > 1 && b.length < 1.5 * 1024 * 1024, `${b.length} bytes`);
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

// The install story (README.md and docs/mcp.md, "Use with Claude"): one plugin, then Connect for the side panel; a table
// by where you use Claude; "Without the plugin"; none of the old two-route wording (connector first, plugin for
// developers, a "You want to…" table, "Both on?").
// PHONE_VIEW_WORKS: false while the side panel cannot be used on phones. Each doc then carries the phone line twice (in
// the table and under step 2), each marked with a "phones-not-yet" comment so it is easy to find. The branch that makes
// the phone view work sets this to true, and this check then fails until both lines and their markers are gone.
const PHONE_VIEW_WORKS = false;
{
  const PHONE = "On phones the plugin and connector install, but the side panel can't be used yet. Use claude.ai on a computer or the desktop app.";
  const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  for (const f of ['README.md', 'docs/mcp.md']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const h = f === 'README.md' ? '### With Claude' : '## Use with Claude', sub = f === 'README.md' ? '#### Without the plugin' : '### Without the plugin';
    const at = t.indexOf(`\n${h}\n`), end = t.indexOf(`\n${sub}\n`), sec = at >= 0 && end > at ? t.slice(at, end) : '';
    check(`${f}: "${h}" leads with the plugin, then step 1 (the marketplace) and step 2 (Connect cloadm-panel, then Continue)`,
      /^\n#+ [^\n]+\n\n\*\*Install the CLOADM plugin\.\*\* One plugin works everywhere Claude does\.\n/.test(sec)
      && sec.includes('1. Customize → Plugins → Add marketplace → `yaniv-golan/CLOADM` → Add **CLOADM**.') && sec.includes('`/plugin install cloadm@cloadm-marketplace`')
      && /2\. On the web and in desktop chat: open the plugin's Connectors tab and click \*\*Connect\*\* next to \*cloadm-panel\*, then\s+\*\*Continue\*\*\. The emulator then opens in Claude's side panel\./.test(sec)
      && sec.includes('In Cowork and Claude Code it runs on your computer instead, with your ROM files and the ~/CLOADM folder; nothing to connect.'), `${sec.length} characters`);
    check(`${f}: the badge note (not reviewed, mcp.cloadm.dev, no sign-in, only the emulator, open source)`,
      sec.includes("Claude shows this for any connector Anthropic hasn't reviewed. CLOADM's runs at mcp.cloadm.dev, needs no sign-in, and sees only the emulator in that panel. Nothing else of yours. It's open source: [source](https://github.com/yaniv-golan/CLOADM/tree/main/connector)."));
    const tab = sec.indexOf('| Where you use Claude | What you get |');
    const rows = tab < 0 ? [] : sec.slice(tab).split('\n').slice(2).filter((l) => /^\|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
    check(`${f}: the table by where: web and desktop chat → the side panel; Cowork and Claude Code → your computer; phone → not yet; other agents → the MCP entry`,
      rows.length === 4 && rows[0][0] === 'claude.ai on the web, desktop chat' && rows[0][1] === 'the live side panel (after Connect)'
      && rows[1][0] === 'Desktop Cowork, Claude Code' && rows[1][1] === 'on your computer, with your ROMs and files'
      && rows[2][0] === 'Phone' && /^not yet\b/.test(rows[2][1]) && /^Other agents\b/.test(rows[3][0]) && rows[3][1].includes('`node cli/cloadm.js --mcp`'), JSON.stringify(rows));
    const after = end >= 0 ? t.slice(end, end + 900) : '';
    check(`${f}: "Without the plugin": the connector URL, no sign-in, the side panel but not the skill`,
      after.includes('Add `https://mcp.cloadm.dev/mcp` as a custom connector (no sign-in). You get the side panel but not the skill that teaches Claude to play it well.'));
    const ALREADY = "Already added https://mcp.cloadm.dev/mcp as a custom connector? The plugin's cloadm-panel uses that same connector, so you won't have two; you can keep it.";
    const steps = sec.slice(sec.indexOf('2. On the web and in desktop chat'), sec.indexOf('In Cowork and Claude Code'));
    check(`${f}: the note for a connector already added by hand, under step 2 and under "Without the plugin"`,
      t.split(ALREADY).length - 1 === 2 && steps.includes(ALREADY) && after.includes(ALREADY));
    const zips = [...new Set([...t.matchAll(/`([\w.-]+\.zip)`/g)].map((m) => m[1]))];
    check(`${f}: names the skill zip, and release.yml publishes that exact file`, zips.length === 1 && rel.includes(`dist/${zips[0]}`), zips.join(','));
    const stale = ['**Use the connector.**', '**For developers and your own files: the plugin.**', '| You want to… | Use |', '**Both on?**', '**Which one?**', 'phones not yet tested', 'The four routes'].filter((w) => t.includes(w));
    check(`${f}: none of the old two-route wording`, !stale.length, stale.join(' | '));
    const phone = t.split(PHONE).length - 1, marked = (t.match(new RegExp(`${PHONE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} <!-- phones-not-yet[^>]*-->`, 'g')) || []).length;
    const markers = (t.match(/phones-not-yet/g) || []).length;
    if (PHONE_VIEW_WORKS) check(`${f}: the phone view works (PHONE_VIEW_WORKS), so the phone line and its markers are gone`, phone === 0 && markers === 0, `${phone} lines, ${markers} markers`);
    else check(`${f}: the phone line, twice (the table and step 2), each marked phones-not-yet`, phone === 2 && marked === 2 && markers === 2
      && rows.length > 2 && rows[2][1].includes(PHONE) && sec.slice(0, tab).includes(PHONE), `${phone} lines, ${marked} marked, ${markers} markers`);
  }
}

console.log(fail ? `${fail} FAILED` : 'all README checks passed');
process.exitCode = fail ? 1 : 0;
