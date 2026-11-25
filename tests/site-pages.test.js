// Run: node tests/site-pages.test.js
//
// The FAQ and About pages, and the line every served page carries:
//  - every HTML page the site serves (tools/pwa-files.js's list) says, as text a reader sees, "Not affiliated with
//    Tandy, Dragon Data, Microsoft, id Software or the Freedoom project." (the play page in its settings drawer, not
//    over the screen), and the landing page's old shorter line is gone;
//  - /faq/: each question on the list, each answer under 80 words, the decided wording where it was given,
//    the accuracy answer linking the known differences from MAME;
//  - /about/: the maker's line, the credits and a link to all of them;
//  - Help and the settings drawer's credits line link both pages, and both are kept for offline use.
// (tools/browser-check.js's reading, nav and settings groups load them in Chromium.)
const fs = require('fs'), path = require('path');
const { pwaFiles } = require('../tools/pwa-files.js');
const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// the text a reader sees: no comments, scripts or styles, tags dropped, entities for the few used, spaces collapsed
const textOf = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;

const FOOT = 'Not affiliated with Tandy, Dragon Data, Microsoft, id Software or the Freedoom project.';
const pages = pwaFiles().filter((f) => /\.html$/.test(f));
check('the site serves the FAQ and About pages (offline too)', pages.includes('faq/index.html') && pages.includes('about/index.html') && pwaFiles().includes('faq/') && pwaFiles().includes('about/'));
for (const p of pages) check(`${p}: carries the affiliation line as visible text`, textOf(read(p)).includes(FOOT));
check('the landing page\'s old, shorter line is gone', !/Not affiliated with Tandy, Dragon Data or Microsoft/.test(read('index.html')));
// the play page: in the settings drawer (the Machine tab's credits), never over the screen
{
  const play = read('play/index.html');
  const at = play.indexOf(FOOT), monitor = /<div class="monitor[\s\S]*?<div class="plate">/.exec(play);
  check('/play/: the line is in the settings drawer\'s credits (#drawerAffiliation), next to the credits line', /<p class="muted note" id="drawerAffiliation">Not affiliated/.test(play)
    && at > play.indexOf('<a href="credits/">credits</a> · <a href="faq/">FAQ</a>') && !(monitor && monitor[0].includes(FOOT)));
}

// the FAQ
const faq = read('faq/index.html');
const qa = [...faq.matchAll(/<h2 id="(q-[a-z]+)">([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => ({ id: m[1], q: textOf(m[2]).trim(), a: textOf(m[3]).trim(), html: m[3] }));
const byId = Object.fromEntries(qa.map((x) => [x.id, x]));
const WANT = ['q-roms', 'q-legal', 'q-accuracy', 'q-privacy', 'q-business', 'q-ai', 'q-doom'];
check('/faq/: the seven questions, in order', JSON.stringify(qa.map((x) => x.id)) === JSON.stringify(WANT), qa.map((x) => x.id).join(' '));
for (const x of qa) check(`/faq/ "${x.q}": under 80 words (${words(x.a)})`, words(x.a) < 80);
check('/faq/: answers in the first person', ['q-roms', 'q-legal', 'q-accuracy', 'q-privacy', 'q-business', 'q-ai'].every((id) => byId[id] && /\bI\b/.test(byId[id].a)));
check('/faq/ business: the decided wording, with no token provider (that returns when the integration ships)', byId['q-business'] && byId['q-business'].a === 'CLOADM is free: the emulator, the games, WYRMFIRE and sharing, with no account. The optional Claude chat costs tokens: use your own Anthropic key, or use CLOADM inside Claude with your Claude account. I keep nothing.'
  && !/token provider|buy credit/i.test(faq), byId['q-business'] && byId['q-business'].a);
check('/faq/ Doom: the decided wording', byId['q-doom'] && byId['q-doom'].a === 'No. WYRMFIRE is a new engine that reads Doom-format levels; it ships with a Freedoom level.');
check('/faq/ AI: says plainly it was built with Claude, checked independently against MAME with the project\'s own firmware, and links docs/verification.md',
  byId['q-ai'] && /built with Claude/.test(byId['q-ai'].a) && /MAME/.test(byId['q-ai'].a) && /instruction by instruction/.test(byId['q-ai'].a) && /every pixel/.test(byId['q-ai'].a)
  && /own firmware/.test(byId['q-ai'].a) && /href="https:\/\/github\.com\/yaniv-golan\/cloadm\/blob\/main\/docs\/verification\.md"/.test(byId['q-ai'].html));
check('/faq/ accuracy: names the MAME comparison and links the known differences', byId['q-accuracy'] && /MAME 0\.264/.test(byId['q-accuracy'].a) && /every instruction/.test(byId['q-accuracy'].a)
  && /id="faqDeviations"\s+href="deviations\/"/.test(byId['q-accuracy'].html));
check('the page it links is served (the known differences, generated from docs/verification.md)', pages.includes('deviations/index.html'));
check('/faq/ privacy: the browser, share links and what goes to Anthropic', byId['q-privacy'] && /stay in your browser/.test(byId['q-privacy'].a) && /share link/.test(byId['q-privacy'].a)
  && /never your ROMs/.test(byId['q-privacy'].a) && /Anthropic/.test(byId['q-privacy'].a));
// what the code does (js/claude/brief.js TOOL_CONTRACT, js/claude/chat.js: the read tools run without a card; only acting asks)
check('/faq/ privacy: says plainly that Claude reads the screen and any memory, ROM areas included, without asking, and only changes ask',
  byId['q-privacy'] && /read the screen and any memory \(ROM areas included\) without asking/.test(byId['q-privacy'].a) && /machine's facts and the chat so far/.test(byId['q-privacy'].a)
  && /Only changes to the machine ask you first\./.test(byId['q-privacy'].a) && !/you allow/.test(byId['q-privacy'].a));
check('no press page', !fs.existsSync(path.join(ROOT, 'press')) && !pages.some((p) => /press/.test(p)));

// About
const about = read('about/index.html');
check('/about/: the maker\'s line', textOf(about).includes('Made by someone who had a Dragon as a kid. My day job is in venture capital; this has nothing to do with it.'));
check('/about/: thanks MAME, XRoar and Freedoom, and links Credits', ['MAME', 'XRoar', 'Freedoom', 'VCC', 'DriveWire'].every((n) => textOf(about).includes(n)) && /href="credits\/"/.test(about));
check('/about/: links the FAQ and the bug report', /href="faq\/"/.test(about) && /href="play\/#bug-report"/.test(about));

// the doors to them
const help = read('help/index.html'), play = read('play/index.html');
check('Help links the FAQ and About', /id="helpFaq" href="faq\/"/.test(help) && /id="helpAbout" href="about\/"/.test(help));
check('the settings drawer\'s credits line links the FAQ and About', /<a href="faq\/">FAQ<\/a> ·\s*<a href="about\/">About<\/a>/.test(play));
check('the reading pages share one stylesheet and the site header', ['faq/index.html', 'about/index.html'].every((f) => read(f).includes('css/reading.css') && /<header class="page-head">/.test(read(f))));

// The FAQ and About speak of WYRMFIRE and its Freedoom level as shipped: they may only say so while it is in the tree.
// (launch-wave1 was written before WYRMFIRE landed; this guard holds the pages to what is actually served.)
{
  const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');
  const says = ['faq/index.html', 'about/index.html'].filter((f) => /WYRMFIRE|Freedoom level/.test(textOf(read(f))));
  const shipped = [PIN.files.engine.path, PIN.files.level.path, PIN.files.freedoomCopying.path].every((f) => fs.existsSync(path.join(ROOT, f)))
    && /'wyrmfire'/.test(read('js/session.js'));
  check('the FAQ and About mention WYRMFIRE and its Freedoom level only while WYRMFIRE ships (its engine, level and Freedoom licence are served)',
    says.length === 2 && shipped, JSON.stringify({ says, shipped }));
}
process.exitCode = fail ? 1 : 0;
console.log(fail ? `${fail} FAILED` : 'all passed');
