#!/usr/bin/env node
// The program pages (js/program-pages.js lists them: one entry is one page): cloadm.dev/<id>/, a small page with its
// own link preview (og:title, og:description, og:image), a Play button for its start link /play/?start=<id>, where it
// also sends the visitor at once. Their pictures, img/card-<id>.png, are 1200 x 630 cards (js/video/card.js) of the
// program running on the built-in firmware: no ROM is loaded, so no ROM pixel is in them. Everything here is made by this script, the same every time (fixed keys, fixed frames, the
// games' random numbers seeded); tests/program-pages.test.js checks the committed files are what it makes.
//   node tools/program-cards.js            write the pages and the cards, and bring sw.js's file list up to date
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SITE = 'https://cloadm.dev/';
const KEY = { up: 94, down: 10, left: 8, right: 9, space: 32, enter: 13 };

const { PROGRAM_PAGES } = require('../js/program-pages.js');
const NAMES = PROGRAM_PAGES.map((p) => p.id);
const PROGRAMS = Object.fromEntries(PROGRAM_PAGES.map((p) => [p.id, p]));

// the program running on its card's machine with the built-in firmware, after its keys or lines -> its frame
function frameOf(Emu, name) {
  const p = PROGRAMS[name].card;
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(p.machine, {}, { menu: false });
  const m = s.shownMachine;
  if (Object.keys(m.romCrcs()).length || m.cartPort) throw new Error('ROMs or a cartridge loaded: refusing to make a card');
  const bin = (file) => fs.readFileSync(path.join(ROOT, 'examples', file));
  if (name === 'liza') {
    s.runLiza(bin(s.lizaFile));
    s.runFrames(120);
    for (const line of p.lines) { s.typeText(line + '\n'); s.runFrames(p.frames); }
  } else {
    s.runGame(name, bin(s.gameFile(name)));
    s.runFrames(40);
    m.poke(Emu.GAMES.seed, p.seed >> 8); m.poke(Emu.GAMES.seed + 1, p.seed & 0xFF);
    for (const k of p.keys) { m.stubKeys.push(KEY[k]); s.runFrames(p.frames); }
  }
  s.runFrames(5);
  if (s.romCodeIn(m) !== null) throw new Error('ROM code in the machine: refusing to make a card');
  return m.render();
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// the page: its preview, and the visitor sent on at once (a fragment kept, so a moment link still works)
function page(name) {
  const p = PROGRAMS[name], to = `../play/?start=${name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- made by tools/program-cards.js: edit it there -->
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${SITE}${name}/">
<link rel="stylesheet" href="../css/tokens.css">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CLOADM">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${SITE}${name}/">
<meta property="og:image" content="${SITE}img/card-${name}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(p.name)} running in CLOADM: the emulated screen">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${to}">
<script>location.replace('${to}' + location.hash);</script>
</head>
<body>
<main>
<h1>${esc(p.title.replace(/, CLOADM$/, ''))}</h1>
<p>${esc(p.description)}</p>
<p><a href="${to}">Play ${esc(p.name)}</a></p>
</main>
</body>
</html>
`;
}

// every file, made in memory -> { 'liza/index.html': text, 'img/card-liza.png': bytes, ... }
async function build() {
  const Emu = await import(path.join(ROOT, 'js/emu.js'));
  const out = {};
  for (const name of NAMES) {
    out[`${name}/index.html`] = page(name);
    out[`img/card-${name}.png`] = Buffer.from(await Emu.encodeIndexedPng(Emu.cardPicture(frameOf(Emu, name))));
  }
  return out;
}
module.exports = { PROGRAMS, NAMES, build, page };

if (require.main === module) {
  build().then((files) => {
    for (const [rel, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, rel), data);
      console.log(`${rel} (${data.length} bytes)`);
    }
    const { syncSw } = require('./pwa-files.js');
    console.log(`sw.js: ${syncSw().count} files`);
  });
}
