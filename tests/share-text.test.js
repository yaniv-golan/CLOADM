// Run: node tests/share-text.test.js
//
// The Share screen's words (js/share-text.js), on real moments from Session.shareFile:
//  - the ROM line "This link holds none of your ROMs. Whoever opens it needs their own <machine> ROMs." (and its
//    compact form) is what the screen writes exactly when the moment uses ROMs (or a cartridge's image), and the note
//    under Copy link is the neutral long-link sentence (that the line is TRUE is tests/share-roms.test.js's proof: no
//    16-byte window of a ROM is in the link; where each shows is tools/browser-check.js's);
//  - "Copy for a forum": BBCode and Markdown, each the link and one line saying what it opens, and no image tag.
// The "ROMs" are stand-ins built from this project's own firmware (examples/*.bin), never real ROMs.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const OURS = fs.readFileSync(path.join(__dirname, '../examples/liza.bin'));
const standIn = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = OURS[(i * 5 + seed) % OURS.length] ^ (i >> 8) & 0xFF; return b; };

(async () => {
  const { romLines, longLinkNote, forumText, forumDescription } = await import('../js/share-text.js');

  // without ROMs: the built-in firmware, nothing needed, no line
  const bare = new Emu.Session({ store: Emu.memoryStore() });
  bare.switchMachine('dragon64');
  for (let i = 0; i < 5; i++) bare.shownMachine.runFrame();
  const bareFile = await bare.shareFile();
  check('no ROMs in use: the moment needs nothing, so the screen writes no ROM sentence', bareFile.needs.length === 0, JSON.stringify(bareFile.needs));

  // with ROMs (the Dragon 64's two BASIC sockets): the line names each, in the needs line's words
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const p = Emu.profiles.dragon64;
  p.roms.forEach((r, k) => s.roms.put('dragon64', r.id, standIn(r.size || 0x4000, 11 + k * 31), `${r.id}.rom`));
  s.switchMachine('dragon64');
  for (let i = 0; i < 5; i++) s.shownMachine.runFrame();
  const file = await s.shareFile();
  check('ROMs in use: the moment needs them', file.needs.length === p.roms.length, JSON.stringify(file.needs.map((x) => x.label)));
  const mine = romLines('Dragon 64', file.needs);
  check('ROMs in use: the line is the one exact sentence, naming the machine and not the slots', mine.full === 'This link holds none of your ROMs. Whoever opens it needs their own Dragon 64 ROMs.'
    && !/32K|64K/.test(mine.full), mine.full);
  check('...and its compact form, for where space is short', mine.brief === 'Needs your Dragon 64 ROMs to open.' && romLines('CoCo 3', file.needs).brief === 'Needs your CoCo 3 ROMs to open.');
  check('no needs: no line', romLines('Dragon 64', []) === null && romLines('Dragon 64', bareFile.needs) === null);
  // a cartridge, alone and with ROMs, named the way the Library names it (never a checksum), or not named when it is not known
  const cart = [{ crc: 'aaaa', kind: 'cartridge', label: 'the cartridge' }], roms = [{ crc: 'bbbb', kind: 'rom', label: '32K-mode BASIC' }];
  check('a cartridge alone: its own sentence, with its name', romLines('Dragon 64', cart, 'my copy.ccc').full === 'This link holds none of your cartridge. Whoever opens it needs the same cartridge: my copy.ccc.');
  check('a cartridge alone, no name known: the sentence ends at "the same cartridge."', romLines('Dragon 64', cart).full === 'This link holds none of your cartridge. Whoever opens it needs the same cartridge.');
  check('ROMs and a cartridge: the combined sentence, with the name', romLines('Dragon 64', [...roms, ...cart], 'my copy.ccc').full === 'This link holds none of your ROMs or your cartridge. Whoever opens it needs their own Dragon 64 ROMs and the same cartridge: my copy.ccc.');
  check('ROMs and a cartridge, no name known: "...and the same cartridge."', romLines('Dragon 64', [...roms, ...cart]).full === 'This link holds none of your ROMs or your cartridge. Whoever opens it needs their own Dragon 64 ROMs and the same cartridge.');
  check('the disk ROM counts as a ROM', romLines('Dragon 64', [{ kind: 'dos', label: 'the disk ROM' }]).full === mine.full);
  check('...and compact forms for a cartridge and for both', romLines('Dragon 64', cart).brief === 'Needs the same cartridge to open.' && romLines('Dragon 64', [...roms, ...cart]).brief === 'Needs your Dragon 64 ROMs and the same cartridge to open.');
  check('the note under Copy link is the neutral sentence, naming what the moment is on: ROMs, a cartridge, or both',
    longLinkNote(file.needs, 'roms') === 'Copy link gives a long link: short links are only for moments that run without ROMs.'
    && longLinkNote(cart, 'cartridge') === 'Copy link gives a long link: short links are only for moments that run without a cartridge.'
    && longLinkNote([...roms, ...cart], 'roms') === 'Copy link gives a long link: short links are only for moments that run without ROMs or a cartridge.'
    && longLinkNote(null, 'roms') === 'Copy link gives a long link: short links are only for moments that run without ROMs.');

  // a cartridge alone (no BASIC ROMs): its image is the person's too
  const c = new Emu.Session({ store: Emu.memoryStore() });
  c.switchMachine('coco');
  const pak = standIn(0x2000, 3); pak[0] = 0x20; pak[1] = 0xFE;
  c.load('game.ccc', pak);
  for (let i = 0; i < 5; i++) c.shownMachine.runFrame();
  const cf = await c.shareFile();
  check('a cartridge in use: its image is the person\'s too, so the moment needs something', cf.needs.length === 1 && cf.needs[0].label === 'the cartridge' && cf.needs[0].kind === 'cartridge', JSON.stringify(cf.needs));
  check('the cartridge is named by the file it came from (Session.cartridgeName), not by a checksum', c.cartridgeName() === 'game.ccc' && !/^[0-9a-f]{8}$/.test(c.cartridgeName()) && bare.cartridgeName() === null, String(c.cartridgeName()));

  // Copy for a forum
  const link = 'https://cloadm.dev/play/?machine=dragon64#s=H4sIAAAA_-x';
  const f = forumText(link, 'Dragon 64');
  const d = forumDescription('Dragon 64');
  check('forum: the description is one line naming the machine', d === 'The Dragon 64 in CLOADM, exactly as I left it. Opens in the browser.' && !/\n/.test(d));
  check('forum: BBCode is the link with the description', f.bbcode === `[url=${link}]${d}[/url]`, f.bbcode);
  check('forum: Markdown is the link with the description', f.markdown === `[${d}](${link})`, f.markdown);
  check('forum: a bundled program\'s own page says it opens from the start', forumDescription('2048', { program: true }) === '2048 in CLOADM, from the start. Opens in the browser.'
    && forumText('https://cloadm.dev/2048/', '2048', { program: true }).markdown === '[2048 in CLOADM, from the start. Opens in the browser.](https://cloadm.dev/2048/)');
  check('forum: text only, no image tag in either', !/\[img\]|!\[/i.test(f.bbcode + f.markdown));
  const odd = forumText('https://x.test/a b)c', 'X [1]');
  check('forum: brackets in the name and ) or spaces in the link cannot break the markup', odd.markdown === '[The X 1 in CLOADM, exactly as I left it. Opens in the browser.](https://x.test/a%20b%29c)'
    && odd.bbcode.startsWith('[url=https://x.test/a b)c]The X 1 in'), JSON.stringify(odd));

  // the Share screen uses these, not copies of them
  const share = fs.readFileSync(path.join(__dirname, '../js/ui/share.js'), 'utf8');
  check('js/ui/share.js writes the ROM line and the forum text from js/share-text.js', /from '\.\.\/share-text\.js'/.test(share) && /romLines\(name, file\.needs, session\.cartridgeName\(\)\)/.test(share) && /longLinkNote/.test(share) && /forumText\(/.test(share) && /const forumUrl = \(\) => \(short \? short\.url : captured\.untouched \? captured\.untouched\.page : captured\.link\)/.test(share)
    && /gifFromFrames\(/.test(share));
  // Save GIF follows the stage's WYRMFIRE rules (no recordingGuard of its own): setShots turns it off with the picture and
  // the clip, its click refuses the person's own WAD's level, and the Freedoom level's GIF carries the level's credit
  check('js/ui/share.js: Save GIF is off with the picture and the clip (setShots), refuses \'userdata\', and credits the Freedoom level',
    /gifBtn\.disabled = off; why\('shareGifWhy', off \? reason : ''\)/.test(share)
    && /gifBtn\.onclick = \(\) => \{\n    if \(session\.romCodeIn\(session\.shownMachine\) === 'userdata'\)/.test(share)
    && /freedoom \? `Recorded in CLOADM\. WYRMFIRE \$\{WYRM_TEXT\.level\}`/.test(share) && !/recordingGuard/.test(share));
  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
