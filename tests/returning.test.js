// Returning visits, the Session's part: the welcome menu
// greets a returning visitor ("WELCOME BACK") or one back from a program ("BYE FOR NOW. PICK ANOTHER?") and can
// offer a last option, "CARRY ON WITH <what ran last>" (6 on the 6809 build, after 5 PLAY A GAME; 5 on the 6803 one),
// whose key emits 'welcome:carryon'; what ran last is remembered across visits (LIZA, the colour demo, a game, or a
// file); leaving LIZA (BYE), a game (BREAK) or the demo (any key once it is drawing) emits 'menu' so the page brings
// the menu back. Expected screen text comes from the design.
// Run: node tests/returning.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const welcome = read('welcome.bin'), liza = read('liza.bin'), demo = read('demo.bin');
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const store = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };

// LIZA's DONE loops, where the watch looks: the Session's constants are the assembled sources' symbols
{
  const inc = (f) => { const p = path.join(ROOT, 'examples', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const a = Emu.assemble(fs.readFileSync(path.join(ROOT, 'examples/liza.asm'), 'utf8'), '6809', { include: inc });
  // the 6803 source builds once per machine (MC10 / ALICE, as tools/build-examples.js): both stop at the same DONE
  const b = [{ MC10: 1, ALICE: 0, SIX09: 0 }, { MC10: 0, ALICE: 1, SIX09: 0 }].map((defines) =>
    Emu.assemble(fs.readFileSync(path.join(ROOT, 'examples/liza6803.asm'), 'utf8'), '6803', { include: inc, defines }));
  check('Session.LIZA.done is where each build stops after BYE', a.symbols.get('DONE') === Emu.Session.LIZA.done['6809']
    && b.every((x) => x.ok && x.symbols.get('DONE') === Emu.Session.LIZA.done['6803']));
}

// the greetings and the carry-on option (6 on the 6809 build)
{
  const s = new Emu.Session({ store: store() });
  s.switchMachine('dragon64');
  const events = [];
  s.on((e) => { if (e.startsWith('welcome:')) events.push(e); });
  s.startWelcome(welcome, { greeting: 'back', carryOn: 'LIZA' });
  frames(s, 50);
  let t = s.screenText();
  check('back: "WELCOME BACK" under the title, centred', t[6] === '          WELCOME BACK          ', JSON.stringify(t[6]));
  check('back: option 6 "CARRY ON WITH LIZA" (its number in inverse video) under 5 PLAY A GAME (the options moved up a row), a blank row, then "PRESS 1 TO 6" (not against the colour bar)', t[12].trim() === '6 CARRY ON WITH LIZA'
    && s.shownMachine.ram[0x400 + 12 * 32 + 4] === 0x36 && t[13].trim() === '' && t[14].trim() === 'PRESS 1 TO 6' && t[11].trim() === '5 PLAY A GAME' && t[10].trim() === '4 CHAT WITH CLAUDE'
    && t[7].trim() === '1 TALK TO LIZA' && t[8].trim() === '2 COLOUR AND SOUND', JSON.stringify(t.slice(6, 15)));
  s.shownMachine.stubKeys.push(0x36); frames(s, 2);
  check('back: key 6 emits welcome:carryon', events.join() === 'welcome:carryon', events.join());
  s.startWelcome(welcome, { greeting: 'bye' });
  frames(s, 50);
  t = s.screenText();
  check('bye: "BYE FOR NOW. PICK ANOTHER?" and no option 6', t[6].trim() === 'BYE FOR NOW. PICK ANOTHER?' && t[13].trim() === '' && t[14].trim() === 'PRESS 1 TO 5', JSON.stringify(t.slice(6, 15)));
  events.length = 0;
  s.shownMachine.stubKeys.push(0x36); frames(s, 2);
  check('without option 6, key 6 does nothing', !events.length, events.join());
  s.startWelcome(welcome, { carryOn: 'a very long file name.cas' });
  frames(s, 50);
  t = s.screenText();
  check('first: the first visit\'s subtitle; option 6 cut at a word to fit (26 characters at most)', t[6].trim() === 'DRAGON AND COLOR COMPUTER'
    && t[12].trim() === '6 CARRY ON WITH A VERY LONG', JSON.stringify(t[12]));
  s.startWelcome(welcome, { carryOn: 'SUPERCALIFRAGILISTIC.CAS' });
  frames(s, 50);
  check('a name with no space to cut at is cut at the edge', s.screenText()[12].trim() === '6 CARRY ON WITH SUPERCALIFRA', JSON.stringify(s.screenText()[12]));
  let err = null;
  try { s.startWelcome(welcome, { greeting: 'hello' }); } catch (e) { err = e; }
  check('an unknown greeting is a SessionError', err instanceof Emu.SessionError, err && err.message);
}

// what ran last, across visits
{
  const st = store();
  const s = new Emu.Session({ store: st });
  s.switchMachine('dragon64');
  check('nothing ran yet: no last run, no option 5', s.lastRun === null && s.carryOn === null);
  s.load('hello.bin', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]));
  check('a file loaded is the last run, with its name and the hash of its bytes', JSON.stringify(s.lastRun) === `{"kind":"recent","name":"hello.bin","crc":"${s.library.recentMedia()[0].crc}"}`, JSON.stringify(s.lastRun));
  s.load('demo.bin', demo, { remember: false });
  check('a program that isn\'t remembered (the demo, loaded so) leaves it as it was', s.lastRun.kind === 'recent');
  s.setLastRun('demo', 'Colour demo');
  check('the page records the demo, and the next visit reads it', JSON.stringify(new Emu.Session({ store: st }).lastRun) === '{"kind":"demo","name":"Colour demo"}');
  st.set('lastRun', '{not json');
  check('a damaged entry reads as none', s.lastRun === null);
}

// option 5 offers what ran last only where it runs: a file on the machine it was loaded on, the demo on a 6809,
// LIZA everywhere ("CARRY ON WITH LOOP.BIN" was offered on an MC-10 for a Dragon 64 file)
{
  const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
  const s = new Emu.Session({ store: store(), media: new MemoryMediaStore({ caseInsensitive: true }) });
  s.switchMachine('dragon64');
  s.load('loop.bin', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]));
  check('carry on: a file, on the machine it was loaded on', JSON.stringify(s.carryOn) === `{"kind":"recent","name":"loop.bin","crc":"${s.library.recentMedia()[0].crc}"}`, JSON.stringify(s.carryOn));
  s.switchMachine('mc10');
  check('carry on: not on another machine', s.carryOn === null && s.lastRun.name === 'loop.bin', JSON.stringify(s.carryOn));
  s.switchMachine('coco');
  check('carry on: not on another 6809 machine either', s.carryOn === null);
  s.switchMachine('dragon64');
  check('carry on: back on its machine, offered again', s.carryOn && s.carryOn.name === 'loop.bin');
  // the name the last run was recorded under and the recent list's row are compared by the store's case rule, not with ===: on a
  // store that does not tell cases apart (a Mac's or Windows' folder) a name that differs only in case is the same file
  for (const [what, name] of [['a name that differs only in case', 'LOOP.bin'], ['an extension that differs only in case', 'loop.BIN'], ['both', 'Loop.Bin']]) {
    s.setLastRun('recent', name, { crc: s.library.recentMedia()[0].crc });
    check(`carry on: ${what} (${name} for loop.bin) still carries on`, s.carryOn && s.carryOn.name === name && s.carryOn.kind === 'recent', JSON.stringify(s.carryOn));
  }
  s.setLastRun('recent', 'other.bin', { crc: s.library.recentMedia()[0].crc });
  check('carry on: another name does not', s.carryOn === null);
  s.setLastRun('recent', 'loop.bin', { crc: 'DEADBEEF' });
  check('carry on: the same name with other bytes does not (a file of that name that is not the one that ran)', s.carryOn === null);
  for (const name of ['LOOP.CAS', 'loop.cas', 'loop']) {
    s.setLastRun('recent', name, { crc: s.library.recentMedia()[0].crc });
    check(`carry on: the same base name with another extension (${name} for loop.bin) does not`, s.carryOn === null, JSON.stringify(s.carryOn));
  }
  {
    const t = new Emu.Session({ store: store(), media: new MemoryMediaStore({ caseInsensitive: false }) });
    t.switchMachine('dragon64');
    t.load('loop.bin', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]));
    t.setLastRun('recent', 'LOOP.bin', { crc: t.library.recentMedia()[0].crc });
    check('carry on: on a store that tells cases apart, LOOP.bin is not loop.bin', t.carryOn === null);
  }
  s.setLastRun('recent', 'loop.bin', { crc: s.library.recentMedia()[0].crc });
  s.setLastRun('demo', 'Colour demo');
  s.switchMachine('mc10');
  check('carry on: the colour demo not on the MC-10 (no 6803 build)', s.carryOn === null);
  s.switchMachine('coco3');
  check('carry on: the colour demo on another 6809 machine', s.carryOn && s.carryOn.kind === 'demo');
  s.setLastRun('liza', 'LIZA');
  s.switchMachine('alice');
  check('carry on: LIZA on every machine', s.carryOn && s.carryOn.kind === 'liza');
}

// leaving LIZA: BYE, the goodbye stays readable for 3 seconds, then 'menu', once
(async () => {
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    let menus = 0;
    s.on((e) => { if (e === 'menu') menus++; });
    await s.startLiza(() => liza);
    check('LIZA records itself as the last run', JSON.stringify(s.lastRun) === '{"kind":"liza","name":"LIZA"}');
    frames(s, 30);
    s.typeText('BYE\n');
    let at = null;
    for (let i = 0; i < 300 && at === null; i++) { frames(s, 1); if (s.shownMachine.cpu.pc === Emu.Session.LIZA.done['6809']) at = i; }
    const fps = s.shownMachine.fps;
    frames(s, Math.floor(fps * 3) - 5);
    const early = menus;
    frames(s, 10);
    check('BYE in LIZA: the goodbye shows, and the menu is asked for 3 seconds later, once', at !== null && /GOODBYE/.test(s.screenText().join(' '))
      && early === 0 && menus === 1, `at ${at} early ${early} menus ${menus}`);
    frames(s, fps * 4);
    check('... and only once', menus === 1);
  }
  // the 3 seconds are the machine's: counted in its frames, not in calls of advance(). A page that runs late takes
  // several frames a tick (up to 4), and a tick can run none; the goodbye lasts 3 s of machine time either way. (It
  // was counted per call: 4 frames a tick made it 12 s of machine time and a 79 s wait on a slow page, and ticks with
  // no frame ended it without any.)
  for (const [label, tick] of [['ticks of 4 frames (a slow page)', 4], ['ticks that run no frame', 0]]) {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    let menus = 0;
    s.on((e) => { if (e === 'menu') menus++; });
    await s.startLiza(() => liza);
    frames(s, 30);
    s.typeText('BYE\n');
    for (let i = 0; i < 300 && s.shownMachine.cpu.pc !== Emu.Session.LIZA.done['6809']; i++) frames(s, 1);
    const fps = s.shownMachine.fps, frameMs = 1000 / fps, f0 = s.shownMachine.frameCount;
    let calls = 0;
    // 3 s of machine time less a little, in ticks of `tick` frames (or 150 ticks running nothing)
    if (tick) while (s.shownMachine.frameCount - f0 < fps * 3 - 5) { s.advance(tick * frameMs + 0.01); calls++; }
    else for (; calls < 200; calls++) s.advance(0.001);
    const early = menus;
    frames(s, tick ? 10 : fps * 3 + 5);   // (ticks with no frame gave the goodbye no machine time at all)
    check(`BYE in LIZA, ${label}: the menu comes after 3 s of machine time, not after a number of ticks`,
      early === 0 && menus === 1, `${calls} ticks, ${s.shownMachine.frameCount - f0} frames; menus ${early} then ${menus}`);
  }
  // BREAK (POLCAT code 3) mid-line leaves exactly as BYE does: the goodbye, the same DONE loop, and the menu 3 s
  // later, once; on the 6809 build and the 6803 one (an MC-10 switched to the 20K LIZA needs)
  for (const [id, file] of [['dragon64', 'liza.bin'], ['mc10', 'liza6803-mc10.bin']]) {
    const s = new Emu.Session({ store: store() });
    s.switchMachine(id);
    if (s.lizaNeeds()) s.switchLiza();
    const fam = id === 'mc10' ? '6803' : '6809';
    let menus = 0;
    s.on((e) => { if (e === 'menu') menus++; });
    await s.startLiza(() => read(file));
    frames(s, 30);
    s.typeText('I FEEL');
    frames(s, 30);
    s.shownMachine.stubKeys.push(3);
    let at = null;
    for (let i = 0; i < 300 && at === null; i++) { frames(s, 1); if (s.shownMachine.cpu.pc === Emu.Session.LIZA.done[fam]) at = i; }
    const t = s.screenText().join(' ');
    frames(s, Math.floor(s.shownMachine.fps * 3) - 5);
    const early = menus;
    frames(s, 10);
    check(`${id}: BREAK in LIZA mid-line is BYE: the goodbye, DONE, and the menu 3 s later, once`,
      at !== null && /> I FEEL +GOODBYE\. IT WAS NICE/.test(t) && early === 0 && menus === 1, `at ${at} early ${early} menus ${menus} ${JSON.stringify(t.slice(-120))}`);
  }
  // with ROMs stored LIZA still runs on the built-in firmware (it never uses them), so it has the menu to go back to:
  // it is watched, and the stored ROMs are still there
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon32');
    s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
    await s.startLiza(() => liza);
    check('with the machine\'s ROMs stored, LIZA runs on the built-in firmware, watched (the menu to go back to), and the ROMs stay stored',
      s.shownMachine.useStub && !!s.menuWatch && Object.values(s.roms.get('dragon32')).some(Boolean), `${s.shownMachine.useStub} ${s.menuWatch && s.menuWatch.kind}`);
  }
  // the demo: its "press any key" is taken; once it draws, the next key asks for the menu
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    let menus = 0;
    s.on((e) => { if (e === 'menu') menus++; });
    s.load('demo.bin', demo, { remember: false });
    s.watchForMenu('demo', s.personMachine);
    frames(s, 20);
    s.shownMachine.stubKeys.push(0x20); frames(s, 20);
    check('demo: the key that starts it doesn\'t leave it', menus === 0 && s.menuWatch && s.menuWatch.drawing);
    s.shownMachine.stubKeys.push(0x20); frames(s, 2);
    check('demo: a key while it draws asks for the menu, and the key is dropped', menus === 1 && s.shownMachine.stubKeys.length === 0 && s.menuWatch === null);
    // another load ends a watch
    s.load('demo.bin', demo, { remember: false });
    s.watchForMenu('demo', s.personMachine);
    s.load('hello.bin', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]), { remember: false });
    check('loading something else ends the watch', s.menuWatch === null);
  }
})().then(() => {
  console.log(`${n - fail}/${n} returning-visit checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL returning ${e.stack}`); process.exitCode = 1; });
