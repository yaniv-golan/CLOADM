// Run: node tests/share-text.test.js
//
// The Share screen's words (js/share-text.js), on real moments from Session.shareFile:
//  - the ROM line "This link holds no part of your ROMs. Whoever opens it needs their own: <needs>." appears exactly
//    when the moment uses ROMs (or a cartridge's image) and never when it runs without (that it is TRUE is
//    tests/share-roms.test.js's proof: no 16-byte window of a ROM is in the link);
//  - "Copy for a forum": BBCode and Markdown, each the link and one line saying what it opens, and no image tag.
// The "ROMs" are stand-ins built from this project's own firmware (examples/*.bin), never real ROMs.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const OURS = fs.readFileSync(path.join(__dirname, '../examples/liza.bin'));
const standIn = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = OURS[(i * 5 + seed) % OURS.length] ^ (i >> 8) & 0xFF; return b; };

(async () => {
  const { romFreeLine, forumText, forumDescription } = await import('../js/share-text.js');
  const { needsLine } = await import('../js/media/romrefs.js');
  const SENTENCE = (needs) => `This link holds no part of your ROMs. Whoever opens it needs their own: ${needs}.`;

  // without ROMs: the built-in firmware, nothing needed, no line
  const bare = new Emu.Session({ store: Emu.memoryStore() });
  bare.switchMachine('dragon64');
  for (let i = 0; i < 5; i++) bare.shownMachine.runFrame();
  const bareFile = await bare.shareFile();
  check('no ROMs in use: the moment needs nothing, and there is no ROM line', bareFile.needs.length === 0 && romFreeLine(bareFile.needs) === '', JSON.stringify(bareFile.needs));

  // with ROMs (the Dragon 64's two BASIC sockets): the line names each, in the needs line's words
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const p = Emu.profiles.dragon64;
  p.roms.forEach((r, k) => s.roms.put('dragon64', r.id, standIn(r.size || 0x4000, 11 + k * 31), `${r.id}.rom`));
  s.switchMachine('dragon64');
  for (let i = 0; i < 5; i++) s.shownMachine.runFrame();
  const file = await s.shareFile();
  const labels = p.roms.map((r) => r.label).join(' and ');
  check('ROMs in use: the moment needs them', file.needs.length === p.roms.length, JSON.stringify(file.needs.map((x) => x.label)));
  check('ROMs in use: the line is the exact sentence, naming what is needed', romFreeLine(file.needs) === SENTENCE(labels), romFreeLine(file.needs));
  check('...and the needs line it sits above is still there', needsLine(file.needs) === `Needs ${labels}: the person opening it adds their own.`);

  // a cartridge alone (no BASIC ROMs): its image is the person's too
  const c = new Emu.Session({ store: Emu.memoryStore() });
  c.switchMachine('coco');
  const pak = standIn(0x2000, 3); pak[0] = 0x20; pak[1] = 0xFE;
  c.load('game.ccc', pak);
  for (let i = 0; i < 5; i++) c.shownMachine.runFrame();
  const cf = await c.shareFile();
  check('a cartridge in use: the line names it', romFreeLine(cf.needs) === SENTENCE('the cartridge'), romFreeLine(cf.needs));

  // Copy for a forum
  const link = 'https://cloadm.dev/play/?machine=dragon64#s=H4sIAAAA_-x';
  const f = forumText(link, 'Dragon 64');
  const d = forumDescription('Dragon 64');
  check('forum: the description is one line naming the machine', d === 'The Dragon 64 in CLOADM, exactly as I left it. Opens in the browser.' && !/\n/.test(d));
  check('forum: BBCode is the link with the description', f.bbcode === `[url=${link}]${d}[/url]`, f.bbcode);
  check('forum: Markdown is the link with the description', f.markdown === `[${d}](${link})`, f.markdown);
  check('forum: text only, no image tag in either', !/\[img\]|!\[/i.test(f.bbcode + f.markdown));
  const odd = forumText('https://x.test/a b)c', 'X [1]');
  check('forum: brackets in the name and ) or spaces in the link cannot break the markup', odd.markdown === '[The X 1 in CLOADM, exactly as I left it. Opens in the browser.](https://x.test/a%20b%29c)'
    && odd.bbcode.startsWith('[url=https://x.test/a b)c]The X 1 in'), JSON.stringify(odd));

  // the clip and the GIF: refused while a WAD of the person's own is loaded; Freedoom records with its credit
  const { recordingGuard, FREEDOOM_CREDIT } = await import('../js/share-text.js');
  const wadBytes = Uint8Array.from([0x50, 0x57, 0x41, 0x44, 1, 2, 3, 4]);   // "PWAD"
  const none = recordingGuard(null), prog = recordingGuard({ name: 'GAME.BIN', bytes: Uint8Array.from([1, 2, 3, 4]) });
  check('recording: nothing or a program loaded: allowed, no suffix', !none.refuse && !prog.refuse && none.suffix === '' && prog.suffix === '' && /CLOADM/.test(prog.comment));
  const own = recordingGuard({ name: 'MYLEVELS.WAD', bytes: wadBytes }), magic = recordingGuard({ name: 'levels.dat', bytes: wadBytes });
  check('recording: a WAD of your own (by name or by its magic) is refused, with the reason', own.refuse === 'A WAD of your own is loaded: CLOADM doesn\'t record it' && magic.refuse === own.refuse);
  const free = recordingGuard({ name: 'freedoom2.wad', bytes: Uint8Array.from([0x49, 0x57, 0x41, 0x44]) });
  check('recording: Freedoom records, its credit in the file name and the comment', !free.refuse && free.suffix === '-Freedoom' && free.comment.includes(FREEDOOM_CREDIT) && /freedoom\.github\.io/.test(FREEDOOM_CREDIT));
  check('recording: a WAD only named like Freedoom elsewhere in its name is still the person\'s own', !!recordingGuard({ name: 'not-freedoom-mine.wad', bytes: wadBytes }).refuse);

  // the Share screen uses these, not copies of them
  const share = fs.readFileSync(path.join(__dirname, '../js/ui/share.js'), 'utf8');
  check('js/ui/share.js writes the ROM line and the forum text from js/share-text.js', /from '\.\.\/share-text\.js'/.test(share) && /romFreeLine\(file\.needs\)/.test(share) && /forumText\(/.test(share)
    && /recordingGuard\(session\.lastLoaded\)/.test(share) && /gifFromFrames\(/.test(share));
  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
