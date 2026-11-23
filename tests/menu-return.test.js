// Run: node tests/menu-return.test.js
//
// A program that returns to the welcome menu (LIZA's BYE, a game's BREAK) is watched on the machine it runs on,
// and the chat beside it must not take that away. The full-screen chat runs on a second machine of its own
// (Session.startChat); the machine the person was on stays beside it, running. Opening and closing the chat
// leaves that machine and its program as they were:
//  * LIZA's BYE still asks for the menu, and the page's start of the menu still works;
//  * Reset still restarts what ran there (LIZA), as it did before the chat;
//  * while the chat is on screen the watch waits: the menu is a start on the machine in use, so it comes when
//    the person is back on the BASIC session;
//  * a machine that is really replaced (a switch, a snapshot) still ends the watch.
// The chat's backend is mocked; no request is made.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const liza = read('liza.bin'), demo = read('demo.bin'), welcome = read('welcome.bin'), chatFirmware = read('chat.bin');
const store = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
// the full-screen chat as the page opens it (js/ui/claude.js openFull -> Session.startChat): a chat machine of
// its own model, on the stub, with the chat firmware loaded
const openChat = (s) => s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
// LIZA has greeted and is reading keys (its greeting is on the screen; until then a key is lost)
// LIZA's own rows (measured): 0 its title, 2-4 its greeting, 6 the prompt line and what was typed after '> ',
// 11 the goodbye. Row-pinned rather than searched, so a line drawn somewhere else fails.
const greeted = (s) => s.screenText()[2].startsWith('HELLO, I AM LIZA.');
const typedLine = (s) => s.screenText()[6].trim() === '> HELLO THERE';
// the goodbye is drawn under the BYE line: row 7 after a short conversation, 11 after a longer one (measured), so
// it is checked on those two rows and not searched for elsewhere
const saidGoodbye = (s) => [7, 11].some((r) => s.screenText()[r].startsWith('GOODBYE.'));
// type BYE and run to LIZA's DONE loop; returns the frame index it was reached at, or null
const bye = (s) => {
  for (let i = 0; i < 400 && !greeted(s); i++) frames(s, 1);
  if (!greeted(s)) return null;
  s.typeText('BYE\n');
  for (let i = 0; i < 400; i++) { if (s.shownMachine.cpu.pc === Emu.Session.LIZA.done['6809']) return i; frames(s, 1); }
  return null;
};

(async () => {
  // LIZA, then the chat from the menu, then closed: BYE still brings the menu back
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e, arg) => {
      if (e !== 'menu') return;
      menus.push(arg || 'bye');
      // the page's handler (js/ui/welcome.js): the 'menu' event starts the menu on the machine in use
      s.startWelcome(welcome, { greeting: 'bye' });
    });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    check('LIZA on the BASIC session is watched for BYE', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);

    const chat = openChat(s);
    check('the chat runs on its own machine, the BASIC session beside it', !!chat && s.shownMachine === s.chatMachines.chat && basic !== s.shownMachine);
    check('opening the chat leaves LIZA\'s watch on the BASIC session', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic,
      JSON.stringify(s.menuWatch && { kind: s.menuWatch.kind, mine: s.menuWatch.m === basic }));
    frames(s, 40);
    check('the chat\'s frames ask for no menu by themselves', !menus.length, menus.join());

    s.endChat();
    check('closing the chat leaves the BASIC session on screen, still watched', s.shownMachine === basic && s.menuWatch && s.menuWatch.m === basic,
      JSON.stringify({ back: s.shownMachine === basic, watch: !!s.menuWatch }));
    const at = bye(s);
    // (the goodbye is on the screen when DONE is reached and the menu replaces it after its 3 s, so the two are
    // not up together: the goodbye is checked by the frames at DONE, the menu by what the page started from it)
    const goodbye = saidGoodbye(s);
    frames(s, Math.floor(basic.fps * 3) + 10);
    check('BYE in LIZA after a chat: the goodbye, then the menu comes back', at !== null && goodbye && menus.length === 1,
      `at ${at}, goodbye ${goodbye}, menus ${menus.join()}`);
    frames(s, basic.fps * 4);
    check('... and only once', menus.length === 1 && s.menuWatch === null, menus.join());
    const t = s.screenText();
    check('the menu the page started is the bye menu, on the BASIC session', s.welcomeRunning && t[6].trim() === 'BYE FOR NOW. PICK ANOTHER?' && t[8].trim() === '1 TALK TO LIZA',
      JSON.stringify(t.slice(6, 9)));
  }

  // the chat stays open ACROSS the goodbye: BYE goes into the BASIC session while the chat is on screen, LIZA reaches
  // DONE there, and the chat is closed part way through the goodbye. The menu then comes when the goodbye's own time
  // (3 s of the BASIC machine's frames) is spent - neither at the closing nor before it.
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    for (let i = 0; i < 400 && !greeted(s); i++) frames(s, 1);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('chat open across the goodbye: LIZA is kept beside it', s.menuWatch && s.menuWatch.m === basic);
    s.typeText('BYE\n', basic);            // typed into LIZA on the BASIC session, though the chat is on screen
    for (let i = 0; i < 400 && basic.cpu.pc !== Emu.Session.LIZA.done['6809']; i++) frames(s, 1);
    check('chat open across the goodbye: LIZA reaches DONE on the BASIC session', basic.cpu.pc === Emu.Session.LIZA.done['6809'] && !!s.menuWatch);
    frames(s, Math.floor(basic.fps * 1.5));  // half the goodbye, on the chat screen: no menu yet
    const early = menus.length;
    s.endChat();
    frames(s, 4);
    // (the 3 s are the time the goodbye is READABLE, and it is not while the chat covers it: they start when the person
    // is back on the BASIC session. That is the rule, and it is what this measures - not "after N ticks".)
    check('closing the chat part way through the goodbye: no menu yet (the goodbye was not readable behind the chat)', early === 0 && menus.length === 0, `${early} then ${menus.length}`);
    frames(s, Math.floor(basic.fps * 2));
    check('... still no menu before the 3 s of BASIC screen time are spent', menus.length === 0, `${menus.length}`);
    frames(s, Math.floor(basic.fps * 1) + 20);
    check('... and the menu comes when those 3 s are spent, once', menus.length === 1, `${menus.length}`);
  }

  // while the chat is on screen, the goodbye does not start the menu on the chat machine: it waits
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.typeText('BYE\n');
    for (let i = 0; i < 400 && basic.cpu.pc !== Emu.Session.LIZA.done['6809']; i++) frames(s, 1);
    check('LIZA is at its DONE loop with the goodbye up, and still watched', basic.cpu.pc === Emu.Session.LIZA.done['6809'] && !!s.menuWatch);
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    frames(s, Math.floor(basic.fps * 3) + 10);
    check('the chat on screen over the goodbye: no menu asked for (it would start on the chat machine)', !menus.length && s.shownMachine === s.chatMachines.chat, menus.join());
    check('... and the chat still runs its own firmware', s.shownMachine.cpu.pc >= 0x5000, s.shownMachine.cpu.pc.toString(16));
    s.endChat();
    frames(s, 4);
    check('back on the BASIC session, the menu comes, once', menus.length === 1, `${menus.length}`);
  }

  // by design: LIZA loaded as a FILE (the person's own copy, by name) gets no watch - the Session cannot know what
  // it is. Only the Shelf's LIZA (Session.runLiza) is watched, so a file LIZA's BYE leaves no menu to come back to.
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    s.load('liza.bin', liza, { remember: false });
    frames(s, 60);
    check('a LIZA loaded as a file is not watched (only the Shelf\'s is)', s.menuWatch === null && !!s.stubRun,
      JSON.stringify({ watch: !!s.menuWatch, run: !!s.stubRun }));
  }

  // startLiza is the Session's own path (the MCP server and the CLI call it), and it watches the PERSON's machine:
  // with the chat full screen, the watch must name the BASIC session, and BYE on it must bring exactly one menu
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });   // (counted, never started: starting a menu is not what this case is about)
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    const basic = s.chatMachines.basic;
    await s.startLiza(() => liza);
    check('startLiza under the chat: the watch names the PERSON\'s machine, not the one on screen', s.menuWatch && s.menuWatch.kind === 'liza'
      && s.menuWatch.m === basic && s.shownMachine === s.chatMachines.chat, JSON.stringify(s.menuWatch && { onBasic: s.menuWatch.m === basic }));
    // ('menu' is counted, not started: starting the menu emits 'welcome', and the count is what this case is about)
    s.endChat();
    frames(s, 30);
    const at = bye(s);
    frames(s, Math.floor(basic.fps * 3) + 10);
    check('startLiza under the chat: BYE after the chat brings exactly ONE menu', at !== null && menus.length === 1, `at ${at}, menus ${menus.join()}`);
  }

  // the same order through the menu's runLiza (the page's Shelf, js/ui/welcome.js -> Session.runLiza), which loads
  // through loadTarget: it goes to the person's machine, and its watch does too
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    const basic = s.chatMachines.basic;
    s.runLiza(liza);
    check('the Shelf\'s runLiza under the chat: it loads into the person\'s machine and watches it', s.menuWatch && s.menuWatch.m === basic
      && basic.cpu.pc >= 0x3000 && basic.cpu.pc < 0x6000, JSON.stringify(s.menuWatch && { onBasic: s.menuWatch.m === basic }));
  }

  // a game's watch is the person's machine too (runGame takes m = personMachine): with the chat full screen it names
  // the BASIC session, and a switch of the shown machine must not change that
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    const basic = s.chatMachines.basic;
    s.runGame('2048', read('2048.bin'));
    check('runGame under the chat: the watch names the PERSON\'s machine', s.menuWatch && s.menuWatch.kind === 'game'
      && s.menuWatch.m === basic && s.shownMachine === s.chatMachines.chat, JSON.stringify(s.menuWatch && { onBasic: s.menuWatch.m === basic }));
  }

  // Booting NitrOS-9 from the floppy while the chat is full screen ends the watch on the machine it boots. A
  // floppy boot on a CoCo 3 that is already 6809 with the Becker port off needs NO machine switch, so it does not go
  // through adopt: only the boot's own endWelcome can end LIZA's watch, and it must name the machine it boots (mm,
  // the person's), not the one on screen. The image is a stand-in built by tools/nitros9/os9-image.js (no NitrOS-9
  // bytes, ever), as tests/nitros9-session.test.js builds one.
  {
    const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
    const s = new Emu.Session({ store: store(), media: new Emu.MemoryMediaStore() });
    s.switchMachine('coco3', { cpu: '6809', ram: 128, becker: false }, { menu: false });
    // (count adopt: the case must not pass by taking the switch path, which ends the watch another way)
    let adopts = 0;
    const adopt = s.adopt.bind(s);
    s.adopt = (...a) => { adopts++; return adopt(...a); };
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('NitrOS-9 under the chat: LIZA is watched on the person\'s machine', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);
    const before = adopts;
    await s.addAndBootNitros9('floppy9.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6809' }));
    check('NitrOS-9 under the chat: the boot needs no switch (adopt not called), so only endWelcome can end the watch',
      adopts === before, `adopt called ${adopts - before} time(s)`);
    check('NitrOS-9 under the chat: the boot went into the person\'s machine, and the chat is still on screen',
      s.shownMachine === s.chatMachines.chat && s.drives.targetMachine === basic && s.nitros9Running, JSON.stringify({ running: s.nitros9Running }));
    check('NitrOS-9 under the chat: booting it ends LIZA\'s watch on that machine', s.menuWatch === null,
      JSON.stringify(s.menuWatch && { kind: s.menuWatch.kind, onBasic: s.menuWatch.m === basic }));
  }

  // Reset after a chat restarts LIZA, as it did before the chat
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e, arg) => { if (e === 'menu') menus.push(arg || 'bye'); });
    await s.startLiza(() => liza);
    frames(s, 60);
    for (let i = 0; i < 400 && !greeted(s); i++) frames(s, 1);
    s.typeText('HELLO THERE\r');
    for (let i = 0; i < 30; i++) { frames(s, 1); if (typedLine(s)) break; }
    check('LIZA: what was typed is on the screen, on its own prompt row', typedLine(s), JSON.stringify(s.screenText().slice(6, 8)));
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    s.endChat();
    s.reset();
    frames(s, 60);
    const t = s.screenText();
    check('Reset after a chat: LIZA restarts, its greeting again on its row, the typed line gone', greeted(s) && t[6].trim() === '>',
      JSON.stringify(t.slice(2, 7)));
    check('Reset after a chat: LIZA is watched for BYE again, no menu asked for', s.menuWatch && s.menuWatch.kind === 'liza' && !menus.length, menus.join());
  }

  // each machine keeps its own Reset program: after the chat, Reset on the BASIC session restarts LIZA, and Reset
  // on the chat's own machine restarts the chat firmware (not LIZA's bytes on the chat machine, nor the reverse)
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine, basicRun = s.stubRun;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    const chatMachine = s.chatMachines.chat, chatRun = s.stubRun;
    check('the chat machine has its own Reset program (the chat firmware), not LIZA\'s', !!chatRun && chatRun !== basicRun && chatRun.m === chatMachine
      && chatMachine.cpu.pc >= 0x5000 && basicRun.m === basic, JSON.stringify({ same: chatRun === basicRun, m: chatRun && chatRun.m === chatMachine }));
    s.reset();
    check('Reset on the chat machine restarts the chat firmware on it', s.shownMachine === chatMachine && s.stubRun === chatRun && chatMachine.cpu.pc >= 0x5000,
      `pc ${chatMachine.cpu.pc.toString(16)}`);
    s.showChat('basic');
    check('the BASIC session kept its own Reset program across the chat', s.shownMachine === basic && s.stubRun === basicRun && s.stubRun.m === basic);
    s.reset();
    frames(s, 80);
    check('Reset on the BASIC session restarts LIZA there, never the chat firmware', s.shownMachine === basic && s.stubRun === basicRun
      && greeted(s), `pc ${basic.cpu.pc.toString(16)} ${s.screenText().slice(0, 5).join(' | ')}`);
  }

  // opening the chat loads its firmware on ITS machine: that load must not end a watch on the BASIC session,
  // which is still running beside it (the colour demo leaves on any key once it draws)
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    s.load('demo.bin', demo, { remember: false });
    s.watchForMenu('demo', s.personMachine);
    frames(s, 20);
    s.shownMachine.stubKeys.push(0x20); frames(s, 20);      // its "press any key": it draws
    const basic = s.shownMachine;
    check('the colour demo draws on the BASIC session, watched', s.menuWatch && s.menuWatch.kind === 'demo' && s.menuWatch.drawing && !menus.length);
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    s.endChat();
    check('the chat\'s firmware load left the demo\'s watch on the BASIC session', s.shownMachine === basic && s.menuWatch && s.menuWatch.m === basic && s.menuWatch.kind === 'demo');
    frames(s, 20);
    s.shownMachine.stubKeys.push(0x20); frames(s, 4);       // a key while it draws: back to the menu
    check('... and a key while it draws still asks for the menu, once', menus.length === 1 && s.menuWatch === null, menus.join());
  }

  // the side panel's conversation opened full screen: the BASIC session is ON SCREEN when the chat's firmware loads,
  // so a load that ends "whatever machine is on screen" ends the demo's watch. Same rule, the other order.
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    s.load('demo.bin', demo, { remember: false });
    s.watchForMenu('demo', s.personMachine);
    frames(s, 20);
    s.shownMachine.stubKeys.push(0x20); frames(s, 20);      // it draws
    const basic = s.shownMachine;
    check('the demo draws, watched, with the person on its machine', s.menuWatch && s.menuWatch.m === basic && s.menuWatch.drawing);
    s.startAsk({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) } });   // the side panel
    check('the side panel leaves the machine on screen and the demo watched', s.shownMachine === basic && s.menuWatch && s.menuWatch.m === basic && !s.chatMachines);
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('the panel moving to full screen leaves the demo\'s watch on the BASIC session', s.menuWatch && s.menuWatch.m === basic && s.menuWatch.kind === 'demo');
    s.endChat();
    frames(s, 20);
    s.shownMachine.stubKeys.push(0x20); frames(s, 4);
    check('... and its key still asks for the menu, once', menus.length === 1 && s.menuWatch === null, menus.join());
  }

  // a load on the BASIC session while the chat is on screen replaces what ran there: a demo loaded over LIZA ends
  // LIZA's watch. The load goes to the person's machine (Session.loadTarget: the machine behind the chat), so the
  // session must end THAT machine's watch - ending "whichever machine is on screen" (the chat's) leaves LIZA's watch
  // pointing at the BASIC session now running the demo.
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('LIZA is watched on the BASIC session, with the chat on screen', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);
    s.load('demo.bin', demo, { remember: false });
    check('a demo loaded into the BASIC session over LIZA ends LIZA\'s watch', s.menuWatch === null,
      JSON.stringify(s.menuWatch && { kind: s.menuWatch.kind, onBasic: s.menuWatch.m === basic }));
    s.endChat();
    frames(s, 120);
    check('... and the demo, now running there with no watch, asks for no menu by itself', !menus.length, menus.join());
  }

  // a watch must NAME its machine (no default to the one on screen: that is how the page came to watch a demo on the
  // chat's machine), and a watch made on the machine the chat drops must not outlive the chat - it would name a
  // machine nothing runs, which, with the wait for another machine on screen, could never end
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    const chatM = s.shownMachine;
    // (watchForMenu takes the machine: with no argument it refuses rather than defaulting to the one on screen)
    let threw = null;
    try { s.watchForMenu('demo'); } catch (e) { threw = e; }
    check('a watch must name its machine: no default to the machine on screen', threw instanceof Emu.SessionError && /needs the machine/.test(threw.message),
      threw && threw.message);
    s.watchForMenu('demo', chatM);        // (a caller could still name the chat's machine explicitly)
    check('a watch made on the chat machine names it', s.menuWatch && s.menuWatch.m === chatM && chatM === s.chatMachines.chat);
    s.endChat();
    check('closing the chat ends a watch held on the chat machine', s.menuWatch === null, JSON.stringify(s.menuWatch && s.menuWatch.m === chatM));
    frames(s, 60);
    check('... and the BASIC session left behind asks for no menu', !menus.length, menus.join());
  }
  {
    // the same through Side panel (toSidePanel), which drops the chat's machine on its own path
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    s.watchForMenu('demo', s.shownMachine);
    check('side panel: a watch made on the chat machine names it', s.menuWatch && s.menuWatch.m === s.chatMachines.chat);
    s.toSidePanel();
    check('side panel: moving to the side panel ends a watch held on the chat machine', s.menuWatch === null);
  }

  // a disk controller plugged in for the person's machine, with the chat on screen, powers THAT machine up afresh -
  // and must end THAT machine's watch. js/drives.js reset the machine it acts on (loadTarget: the person's) but ended
  // "whatever machine is on screen" (the chat's), so LIZA's watch survived a reset of the machine it named.
  {
    const s = new Emu.Session({ store: store(), media: new Emu.MemoryMediaStore() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('dos under the chat: LIZA is watched on the BASIC session', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);
    const choice = s.drives.bareChoice();
    check('dos under the chat: the Dragon offers a disk controller to plug in bare', !!choice, JSON.stringify(choice && choice.id));
    s.drives.plugBareController(choice);            // into the person's empty port: no reset (nothing was running from it)
    check('dos under the chat: the first plug leaves LIZA\'s watch (it replaced nothing)', s.menuWatch && s.menuWatch.m === basic);
    s.drives.plugBareController(choice);            // the cartridge comes out and the machine powers up afresh: that reset
    check('dos under the chat: plugging it in again powers the person\'s machine up, ending LIZA\'s watch there', s.menuWatch === null,
      JSON.stringify(s.menuWatch && { kind: s.menuWatch.kind, onBasic: s.menuWatch.m === basic, onChat: s.menuWatch.m === s.chatMachines.chat }));
    s.endChat();
    frames(s, 30);
    check('dos under the chat: the BASIC session, reset with no program, asks for no menu by itself', !menus.length, menus.join());
  }

  // the DOS controller's own door (insertDos): with a DOS ROM stored, it goes into the PERSON's machine and resets
  // it, and must end THAT machine's watch. The ROM is our own disk firmware (the writer the disk tests use, as the
  // DragonDOS cartridge's ROM: no real ROM is used anywhere here).
  {
    const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
    const w = assembleFile(path.join(ROOT, 'tools/mame-diff/fdc', 'dragon-write.asm'), '6809');
    const rom = romImage(w, 0xC000, 0x2000, 0x00);
    const s = new Emu.Session({ store: store(), media: new Emu.MemoryMediaStore() });
    s.switchMachine('dragon64');
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.roms.put('dragondos', 'rom', rom, 'firmware.rom');       // as a stored disk ROM: the choice is ready
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('insertDos under the chat: LIZA is watched on the BASIC session', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);
    const dos = s.drives.dosChoices().find((c) => !c.builtin && c.ready);
    check('insertDos under the chat: the Dragon offers a ready DOS controller (our own firmware)', !!dos, JSON.stringify(dos && { id: dos.id, ready: dos.ready }));
    s.drives.insertDos(dos.id);                                // into the PERSON's machine, and it resets it
    check('insertDos under the chat: it powers the person\'s machine up, ending LIZA\'s watch there', s.menuWatch === null,
      JSON.stringify(s.menuWatch && { kind: s.menuWatch.kind, onBasic: s.menuWatch.m === basic }));
    check('insertDos under the chat: it went into the person\'s machine, not the chat\'s', s.drives.targetMachine === basic && s.shownMachine === s.chatMachines.chat);
  }

  // a power cycle (the screen's Power button, with the chat on screen) restarts the person's machine: LIZA's watch
  // ends there
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('power cycle under the chat: LIZA is watched on the BASIC session', s.menuWatch && s.menuWatch.m === basic);
    s.powerCycle();                                  // the person's machine, the one behind the chat
    check('power cycle under the chat: ends LIZA\'s watch on the machine it restarted', s.menuWatch === null, JSON.stringify(s.menuWatch && s.menuWatch.m === basic));
    check('power cycle under the chat: the chat is still open, and the restart was the BASIC session\'s', !!s.chatMachines && s.chatMachines.basic === basic);
  }

  // Ctrl+B (showChat('basic')) puts the BASIC session on screen with the chat open; BYE typed there brings the menu
  // back, and the menu is started on the machine the person is looking at
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e, arg) => {
      if (e !== 'menu') return;
      menus.push(arg || 'bye');
      s.startWelcome(welcome, { greeting: 'bye' });
    });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    s.showChat('basic');                             // Ctrl+B
    check('Ctrl+B: the BASIC session is on screen, the chat still open', s.shownMachine === basic && !!s.chatMachines && s.chatView === 'basic');
    const at = bye(s);
    frames(s, Math.floor(basic.fps * 3) + 10);
    check('Ctrl+B: BYE in LIZA with the chat open brings the menu back, on the BASIC session', at !== null && menus.length === 1 && s.welcomeRunning,
      `at ${at}, menus ${menus.join()}, running ${s.welcomeRunning}`);
  }

  // a snapshot opened while a program is watched replaces that machine: the watch goes with it (no menu from a
  // machine that is gone), as with a switch - here with the chat on screen, so the replaced machine is the person's
  // and the chat's machine is the one shown
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    check('snapshot: LIZA is watched on the BASIC session', s.menuWatch && s.menuWatch.kind === 'liza' && s.menuWatch.m === basic);
    const snap = basic.snapshot();
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    check('snapshot: opening the chat keeps LIZA\'s watch', s.menuWatch && s.menuWatch.m === basic);
    s.openSnapshot(snap);
    check('snapshot: opening one closes the chat and ends LIZA\'s watch with the machine it replaced', s.menuWatch === null && s.chat === null && s.shownMachine !== basic);
    frames(s, 60);
    check('snapshot: the machine that came back asks for no menu of its own', !menus.filter((x) => x === 'menu').length, menus.join());
  }

  // a machine actually replaced under the chat still ends the watch: no menu from a machine that is gone
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('dragon64');
    const menus = [];
    s.on((e) => { if (e === 'menu') menus.push(e); });
    await s.startLiza(() => liza);
    frames(s, 30);
    const basic = s.shownMachine;
    s.startChat({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) }, channel: new Emu.MemoryChannel(), firmware: chatFirmware });
    s.switchMachine('coco3');            // the chat belongs to the machine it was opened on: both go
    // (a switch offers the menu for the new machine: 'back', which is the switch's and not LIZA's -- the same
    // event as LIZA's BYE with no greeting chosen, so the count is taken before the switch and the watch is
    // what proves LIZA's ask did not survive)
    check('a switch under the chat ends LIZA\'s watch and the chat', s.menuWatch === null && s.chat === null && s.shownMachine !== basic);
    const after = menus.length;
    frames(s, 60);
    check('the machine left behind asks for no menu of its own (the one switch offer stays one)', menus.length === after && after <= 1, menus.join());
  }
})().then(() => {
  console.log(`${n - fail}/${n} menu-return checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL menu-return ${e.stack}`); process.exitCode = 1; });
