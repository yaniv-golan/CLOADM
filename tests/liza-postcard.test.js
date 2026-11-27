// Run: node tests/liza-postcard.test.js
//
// LIZA postcards (js/postcard.js; the link: js/media/snapshot.js, byte 0 = 3; sealed kind 3, js/media/link-crypto.js):
//  * LIZA's addresses the Session listens at are the assembled sources' symbols, in both builds;
//  * hearing a chat: each line LIZA answers, as READLN kept it (upper case); BYE is not a line; a Reset that runs LIZA
//    again, a LIZA opened from a moment, the Claude chat and another program give no postcard; after BYE the chat can
//    still be sent from the goodbye and the welcome menu;
//  * the link: round trip (long and short), what a reader refuses (damaged, lines LIZA can't have typed, too many, a
//    machine CLOADM lacks or one without LIZA), and a newer CLOADM's (a newer JSON version, a newer byte 0, a newer kind);
//  * the replay: the picture (replayed off-screen from the link) and the recipient's replay are the live screen, pixel
//    for pixel, at 1 and 20 lines, on every model; at 23 lines the postcard keeps the last 20 (from line 4), and its
//    picture is what the recipient sees, not the sender's screen (which answered differently: the rotation);
//  * the recipient: LIZA waits; Replay types at about 25 characters a second, each line once LIZA asks for it; Skip
//    types the rest at once; then it is their turn, and their first key ends the arrival.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const PC = require('../js/postcard.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const ROOT = path.join(__dirname, '..');
const bin = (f) => fs.readFileSync(path.join(ROOT, 'examples', f));
const BASE = 'https://cloadm.dev/play/';

// a fresh Session with LIZA started on `id` (the 6803 build needs its 20K)
function liza(id = 'dragon64', opts = { welcomeMenu: false }) {
  const s = new Emu.Session(opts);
  s.switchMachine(id, id === 'mc10' || id === 'alice' ? { ram: 20 } : {}, { menu: false });
  s.runLiza(bin(s.lizaFile));
  s.runFrames(60);
  return s;
}
const say = (s, lines) => { for (const l of lines) { s.typeText(`${l}\n`); s.runFrames(200); } };
const sameFrame = (a, b) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);
// the recipient's replay, skipped to the end and settled
function received(card, kind = 'skip') {
  const r = new Emu.Session({ welcomeMenu: false });
  r.switchMachine('coco3', {}, { menu: false });
  r.postcards.open(card, { kind: 'long' }, bin(r.postcards.fileFor(card.machine)));
  r.runFrames(30);
  if (kind === 'skip') r.postcards.skip(); else r.postcards.play();
  for (let i = 0; i < 20000 && r.arrivedFromLink && r.arrivedFromLink.postcard.state !== 'done'; i++) r.runFrames(1);
  r.runFrames(2);
  return r;
}
// lines that make the rotation matter: the same keyword again and again gets the next reply each time
const MISS = ['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC', 'I MISS MY DRAGON', 'YOU ARE A COMPUTER', 'I MISS MY DRAGON', 'MY MOTHER LIKED IT',
  'I AM SAD', 'I MISS MY DRAGON', 'YOU ARE A COMPUTER', 'I AM SAD', 'MY FATHER TOO', 'I MISS MY DRAGON', 'HELLO', 'BECAUSE', 'I AM SAD', 'YOU ARE NICE',
  'I MISS MY DRAGON', 'MY DOG', 'I AM SAD', 'YOU ARE A COMPUTER', 'I MISS MY DRAGON', 'BECAUSE', 'I AM SAD'];

(async () => {
  // ---- LIZA's addresses ----
  {
    const inc = (f) => { const p = path.join(ROOT, 'examples', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
    const a = Emu.assemble(fs.readFileSync(path.join(ROOT, 'examples/liza.asm'), 'utf8'), '6809', { include: inc });
    const b = [{ MC10: 1, ALICE: 0, SIX09: 0 }, { MC10: 0, ALICE: 1, SIX09: 0 }].map((defines) =>
      Emu.assemble(fs.readFileSync(path.join(ROOT, 'examples/liza6803.asm'), 'utf8'), '6803', { include: inc, defines }));
    const sym = { start: 'START', heard: 'NOTBYE', bye: 'BYENOW', readln: 'READLN', inbuf: 'INBUF' };
    const same = (r, at) => r.ok && Object.entries(sym).every(([k, n]) => r.symbols.get(n) === at[k]);
    check('LIZA_AT is the 6809 build\'s START, NOTBYE, BYENOW, READLN and INBUF', same(a, PC.LIZA_AT['6809']));
    check('... and both 6803 builds\' (MC-10, Alice)', b.every((r) => same(r, PC.LIZA_AT['6803'])));
  }

  // ---- hearing a chat ----
  {
    const s = liza();
    check('nothing typed yet: no postcard', s.postcards.current() === null);
    say(s, ['i miss my dragon', 'BECAUSE IT WAS MAGIC']);
    const c = s.postcards.current();
    check('each line LIZA answered, as READLN kept it (upper case)', !!c && JSON.stringify(c.lines) === '["I MISS MY DRAGON","BECAUSE IT WAS MAGIC"]' && c.all === 2 && c.from === 1 && !c.trimmed && !c.ended, JSON.stringify(c));
    const ev = [];
    s.on((e, a) => { if (e === 'postcard') ev.push(a || 'line'); });
    say(s, ['BYE']);
    const d = s.postcards.current();
    check('BYE ends the chat: it is not a line, and the chat can still be sent', !!d && d.lines.length === 2 && d.ended && ev.join() === 'ended', `${JSON.stringify(d)} ${ev}`);
    // the welcome menu after the goodbye (the page starts it on 'menu'): still offered there
    s.startWelcome(bin('welcome.bin'));
    s.runFrames(5);
    check('after BYE, from the welcome menu: still offered', !!s.postcards.current() && s.bundledRunning === 'welcome');
    s.runGame('2048', bin('2048.bin'));
    s.runFrames(5);
    check('... and gone once another program runs', s.postcards.current() === null);
  }
  {
    const s = liza();
    say(s, ['HELLO']);
    s.runFrames(5);
    // BREAK in READLN goes to the goodbye as BYE does
    s.shownMachine.stubKeys.push(3);
    s.runFrames(50);
    const c = s.postcards.current();
    check('BREAK ends the chat as BYE does: the chat can be sent', !!c && c.ended && c.lines.join() === 'HELLO', JSON.stringify(c));
  }
  {
    const s = liza();
    say(s, ['HELLO']);
    s.reset();
    s.runFrames(60);
    say(s, ['I AM SAD']);
    check('a Reset that runs LIZA again (its rotation where it was): no postcard', s.postcards.current() === null);
  }
  {
    // a LIZA opened from a moment: its lines were typed before, somewhere else
    const a = liza();
    say(a, ['HELLO']);
    const file = await a.shareFile();
    const b = new Emu.Session({ welcomeMenu: false });
    b.switchMachine('dragon64', {}, { menu: false });
    b.openSnapshot(await b.readSnapshot(file.bytes));
    say(b, ['I AM SAD']);
    check('a LIZA opened from a moment: no postcard', b.postcards.current() === null);
  }
  {
    // the Claude chat on screen is never LIZA's: no postcard of it (startChat puts its own machine on screen)
    const s = liza();
    say(s, ['HELLO']);
    const shown = s._shown;
    s.chatMachines = { chat: shown, basic: null };
    check('the Claude chat\'s machine on screen: no postcard', s.postcards.current() === null);
    s.chatMachines = null;
    check('... (and the same chat with LIZA on screen: one)', !!s.postcards.current());
  }

  // ---- the link ----
  const card = { machine: 'dragon64', lines: ['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC'] };
  {
    const bytes = await Emu.encodePostcardLink(card);
    check('the link\'s byte 0 is 3 (a postcard)', bytes[0] === 3 && Emu.POSTCARD_LINK_VERSION === 3);
    const back = await Emu.decodePostcardLink(bytes);
    check('round trip: the machine and the lines', JSON.stringify(back) === JSON.stringify(card), JSON.stringify(back));
    const raw = JSON.parse(require('zlib').inflateRawSync(Buffer.from(bytes.subarray(1))).toString());
    check('what it holds: format cloadm-liza, version 1, the machine and the lines, nothing else', JSON.stringify(Object.keys(raw)) === '["format","version","machine","lines"]'
      && raw.format === 'cloadm-liza' && raw.version === 1, JSON.stringify(raw));
    const s = liza();
    say(s, card.lines);
    const url = await s.postcards.link(BASE);
    check('the long link: the machine\'s address with the postcard in #z=', /^https:\/\/cloadm\.dev\/play\/\?machine=dragon64#z=[A-Za-z0-9_-]+$/.test(url), url);
    const r = new Emu.Session({ welcomeMenu: false });
    check('... read back as the postcard', JSON.stringify(await r.postcards.read(url.slice(url.indexOf('#')))) === JSON.stringify(card));
    check('... and a moment\'s reader says it is a postcard, not a moment', /postcard from LIZA, not a moment/.test((await rejects(Emu.decodeLongLink(bytes))).message));
    check('... a program\'s reader passes it on (null)', await r.readProgramLink(url.slice(url.indexOf('#'))) === null);
    const store = new Emu.MemoryShortLinkStore();
    const short = await s.postcards.shortLink(store);
    const id = short.url.split('/').pop().split('#')[0], key = short.url.split('#')[1];
    const kept = store.links.get(id);
    check('the short link: sealed (version 1, kind 3), no picture', !!kept && kept.sealed[0] === 1 && kept.sealed[1] === 3 && kept.png === null && kept.machine === 'dragon64', short.url);
    const got = await r.readShortLink(`#l=${id}.${key}`, store);
    check('... opened with its key: the postcard', !!got.postcard && !got.snap && !got.program && JSON.stringify(got.postcard) === JSON.stringify(card) && got.id === id);
  }
  {
    const r = new Emu.Session({ welcomeMenu: false });
    const z = async (v, byte0 = 3) => {
      const packed = require('zlib').deflateRawSync(Buffer.from(JSON.stringify(v)));
      return `#z=${Buffer.concat([Buffer.from([byte0]), packed]).toString('base64url')}`;
    };
    const good = { format: 'cloadm-liza', version: 1, machine: 'dragon64', lines: ['HELLO'] };
    const err = async (v, re, name) => { const e = await rejects(r.postcards.read(await z(v))); check(`refused: ${name}`, e instanceof Emu.SessionError && re.test(e.message), e && e.message); };
    check('a good one reads', JSON.stringify(await r.postcards.read(await z(good))) === '{"machine":"dragon64","lines":["HELLO"]}');
    await err(Object.assign({}, good, { version: 2 }), /newer CLOADM \(postcard format 2; this page reads 1\)/, 'a newer postcard format (version 2): "made by a newer CLOADM"');
    await err(Object.assign({}, good, { lines: ['hello'] }), /postcard is damaged/, 'a line in lower case (READLN keeps none)');
    await err(Object.assign({}, good, { lines: ['A'.repeat(61)] }), /postcard is damaged/, 'a line of 61 characters (READLN keeps 60)');
    await err(Object.assign({}, good, { lines: ['HI\u0007'] }), /postcard is damaged/, 'a control character');
    await err(Object.assign({}, good, { lines: Array(21).fill('HI') }), /postcard is damaged/, '21 lines (a postcard holds 20)');
    await err(Object.assign({}, good, { lines: [] }), /postcard is damaged/, 'no lines');
    await err(Object.assign({}, good, { lines: [3] }), /postcard is damaged/, 'a line that is not text');
    await err(Object.assign({}, good, { format: 'cloadm-basic' }), /postcard is damaged/, 'another format');
    await err(Object.assign({}, good, { machine: 'zx81' }), /machine this CLOADM doesn't have/, 'a machine CLOADM lacks');
    check('a line of 60 characters and 20 lines read', !!(await r.postcards.read(await z(Object.assign({}, good, { lines: Array(20).fill('B'.repeat(60)) })))));
    const cut = (await z(good)).slice(0, 22);
    check('refused: a link cut short', (await rejects(r.postcards.read(cut))) instanceof Emu.SessionError);
    check('a model without LIZA is refused (a LIZA table without the Alice\'s build)', PC.lizaFileFor({ '6809': 'liza.bin', '6803': {} }, 'alice') === null
      && PC.lizaFileFor(Emu.Session.LIZA, 'alice') === 'liza6803-alice.bin' && PC.lizaFileFor(Emu.Session.LIZA, 'zx81') === null);
    // a newer CLOADM's: a byte 0 past ours (the long link), a kind past ours (the sealed object)
    const newer = await rejects(Emu.decodeLongLink(Uint8Array.from([5, 1, 2, 3])));
    check('a long link of byte 0 = 5: "made by a newer CLOADM"', /newer CLOADM \(link format 5/.test(newer.message), newer.message);
    const sealed = (await Emu.sealMoment(Uint8Array.of(1, 2, 3), Emu.SEALED_KIND.postcard)).sealed;
    check('Emu.SEALED_KIND.postcard is 3', Emu.SEALED_KIND.postcard === 3 && sealed[1] === 3);
    sealed[1] = 5;
    const nk = (() => { try { Emu.sealedHead(sealed); return null; } catch (e) { return e; } })();
    check('a sealed object of kind 5: "made by a newer CLOADM"', nk && /newer CLOADM/.test(nk.message), nk && nk.message);
    check('the encoder refuses what a reader would', (await rejects(Emu.encodePostcardLink({ machine: 'dragon64', lines: ['lower'] }))) instanceof Emu.SnapshotError
      && (await rejects(Emu.encodePostcardLink({ machine: 'dragon64', lines: Array(21).fill('X') }))) instanceof Emu.SnapshotError);
  }

  // ---- the replay: the same screen ----
  for (const n of [1, 20]) {
    const s = liza();
    say(s, MISS.slice(0, n));
    s.runFrames(2);
    const c = s.postcards.current(), live = s.shownMachine.render();
    const pic = s.postcards.replayFrame(await s.postcards.fromBytes(await s.postcards.bytes(c)), bin(s.lizaFile));
    check(`${n} line${n === 1 ? '' : 's'}: the picture (replayed off-screen from the link) is the live screen, pixel for pixel`, sameFrame(pic, live));
    const r = received(c);
    check(`${n} line${n === 1 ? '' : 's'}: the recipient's replay ends on the same screen`, sameFrame(r.shownMachine.render(), live) && r.screenText().join('\n') === s.screenText().join('\n'));
  }
  {
    const s = liza();
    say(s, MISS);
    s.runFrames(2);
    const c = s.postcards.current(), live = s.shownMachine.render();
    check('23 lines: the postcard keeps the last 20, from line 4', c.all === 23 && c.lines.length === 20 && c.from === 4 && c.trimmed && JSON.stringify(c.lines) === JSON.stringify(MISS.slice(3)));
    check('... and says so: "Postcards hold 20 lines: this one starts at your line 4."', PC.POSTCARD_TEXT.trimmed(c.from) === 'Postcards hold 20 lines: this one starts at your line 4.');
    const pic = s.postcards.replayFrame(await s.postcards.fromBytes(await s.postcards.bytes(c)), bin(s.lizaFile));
    const r = received(c);
    check('23 lines: the picture is what the recipient sees', sameFrame(pic, r.shownMachine.render()));
    check('... which is not the sender\'s screen (a fresh LIZA answers the 20 lines differently: its rotation)', !sameFrame(pic, live) && r.screenText().join() !== s.screenText().join());
  }
  // every model with LIZA: one line, the picture is the live screen
  for (const id of Object.keys(Emu.profiles)) {
    const s = liza(id);
    say(s, ['I MISS MY DRAGON']);
    s.runFrames(2);
    const c = s.postcards.current();
    const pic = c && s.postcards.replayFrame(c, bin(s.lizaFile));
    check(`${id}: a chat heard, and its picture is the live screen`, !!c && c.machine === id && sameFrame(pic, s.shownMachine.render()));
  }

  // ---- the recipient ----
  {
    const r = new Emu.Session({ welcomeMenu: false });
    r.switchMachine('coco3', {}, { menu: false });
    const states = [];
    r.on((e) => { if (e === 'arrival') states.push(r.arrivedFromLink && r.arrivedFromLink.postcard ? r.arrivedFromLink.postcard.state : 'none'); });
    const mc = { machine: 'mc10', lines: ['I MISS MY DRAGON', 'HELLO'] };
    r.postcards.open(mc, { kind: 'short', id: 'abcdefgh' }, bin(r.postcards.fileFor('mc10')));
    const m = r.shownMachine;
    check('LIZA started afresh on the sender\'s model (the MC-10 with the 20K LIZA needs), on the built-in firmware', m.id === 'mc10' && m.config.ram >= 20 && r.bundledRunning === 'liza');
    check('the arrival: "A postcard from LIZA · 2 lines", ready, a short link\'s id kept', r.arrivedFromLink.postcard.state === 'ready' && r.arrivedFromLink.postcard.lines === 2 && r.arrivedFromLink.id === 'abcdefgh'
      && PC.POSTCARD_TEXT.arrival(2) === 'A postcard from LIZA · 2 lines', JSON.stringify(r.arrivedFromLink));
    r.runFrames(100);
    check('nothing is typed until Replay or Skip', !r.screenText().join('\n').includes('MISS') && r.postcards.pending);
    r.postcards.play();
    let frames = 0;
    for (; frames < 2000 && r.arrivedFromLink.postcard.state !== 'done'; frames++) r.runFrames(1);
    const chars = mc.lines.join('').length + mc.lines.length;
    // about 25 a second: the characters take chars / 25 seconds, plus LIZA's own answering time
    check('Replay types at about 25 characters a second', frames >= Math.floor(chars / 25 * m.fps) && frames < chars / 25 * m.fps + 2 * m.fps, `${frames} frames for ${chars} characters at ${m.fps} fps`);
    check('... then "Your turn: type to LIZA."; the card states went ready, replaying, done', states.join() === 'ready,replaying,done' && !r.postcards.pending && PC.POSTCARD_TEXT.yourTurn === 'Your turn: type to LIZA.', states.join());
    check('... with both lines answered on the screen', r.screenText().join('\n').includes('> I MISS MY DRAGON') && r.screenText().join('\n').includes('> HELLO'));
    r.typeText('X');
    check('their first key ends the arrival', r.arrivedFromLink === null);
  }
  {
    // a key (Skip) in the middle of the replay types the rest at once
    const r = new Emu.Session({ welcomeMenu: false });
    r.switchMachine('dragon64', {}, { menu: false });
    r.postcards.open({ machine: 'dragon64', lines: MISS.slice(0, 5) }, { kind: 'long' }, bin('liza.bin'));
    r.runFrames(20);
    r.postcards.play();
    r.runFrames(40);
    r.postcards.skip();
    let f = 0;
    for (; f < 2000 && r.arrivedFromLink.postcard.state !== 'done'; f++) r.runFrames(1);
    r.runFrames(2);
    const ref = received({ machine: 'dragon64', lines: MISS.slice(0, 5) });
    check('Skip during the replay: the rest at once, the same end', f < 100 && r.screenText().join() === ref.screenText().join(), `${f} frames`);
    // a machine switch ends the arrival and the replay
    const t = new Emu.Session({ welcomeMenu: false });
    t.switchMachine('dragon64', {}, { menu: false });
    t.postcards.open({ machine: 'dragon64', lines: ['HELLO'] }, { kind: 'long' }, bin('liza.bin'));
    t.switchMachine('coco', {}, { menu: false });
    t.runFrames(5);
    check('a switch ends the postcard\'s arrival and its replay', t.arrivedFromLink === null && !t.postcards.pending && t.postcards.replay === null);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
