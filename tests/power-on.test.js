// Reset and power without ROMs (behave like a real computer, never a dead
// end). With no ROMs the machine runs the stub firmware, whose bare "NO ROM LOADED" screen must not be where a
// button leaves you:
//  - Switch off and on (powerCycle), "Run without ROMs", "Remove ROMs" and switching to a machine turn the
//    machine on: the Session emits ('menu', 'back') and the page starts the welcome menu, as a visit does (every
//    model: the 6809 build, or the MC-10's and Alice's own 6803 build);
//  - Reset restarts the program that runs from its own entry point: the welcome menu stays the welcome menu, LIZA
//    restarts LIZA, a binary with an exec address restarts. With nothing to restart it emits ('menu', 'back');
//  - a snapshot taken on the stub's bare prompt opens on the welcome menu (Machine.atStubPrompt); one taken in a
//    program opens in that program.
// With ROMs nothing changes: reset and power-on are BASIC's. The POKE book, on the stub with a program running,
// does the POKE itself rather than typing it into that program (its digits would be menu keys).
// Run: node tests/power-on.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const welcome = read('welcome.bin'), liza = read('liza.bin'), liza6803 = read('liza6803-mc10.bin');
const welcome6803 = { mc10: read('welcome6803-mc10.bin'), alice: read('welcome6803-alice.bin') };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const store = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const type = (s, text) => { for (const c of text) { s.shownMachine.stubKeys.push(c.charCodeAt(0)); frames(s, 3); } };
const screen = (s) => s.screenText().join('\n');
// a DragonDOS binary at $3000: INC $0400 ; BRA $3000 (it counts in the screen's first cell, forever)
const LOOP = new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x05, 0x30, 0x00, 0xAA, 0x7C, 0x04, 0x00, 0x20, 0xFB]);
const newSession = (id) => {
  const s = new Emu.Session({ store: store() });
  s.switchMachine(id);
  const menus = [];
  s.on((e, arg) => { if (e === 'menu') menus.push(arg || 'bye'); });
  return { s, menus };
};

(async () => {
  // Reset: the welcome menu stays the welcome menu, with its greeting and option 5
  {
    const { s, menus } = newSession('dragon64');
    s.startWelcome(welcome, { greeting: 'back', carryOn: 'LIZA' });
    frames(s, 50);
    s.shownMachine.poke(0x400 + 7 * 32, 0x20);   // something on the screen the menu didn't draw
    s.reset();
    frames(s, 50);
    const t = s.screenText();
    check('reset: the welcome menu restarts, WELCOME BACK and 6 CARRY ON WITH LIZA', s.welcomeRunning && t[6].trim() === 'WELCOME BACK' && t[13].trim() === '6 CARRY ON WITH LIZA',
      JSON.stringify(t.slice(6, 15)));
    check('reset: the welcome menu asks for no other menu', !menus.length, menus.join());
  }
  // Reset: LIZA restarts LIZA (from its entry point: what was typed is gone), still watched for BYE
  {
    const { s, menus } = newSession('dragon64');
    await s.startLiza(() => liza);
    frames(s, 60);
    type(s, 'HELLO THERE\r');
    frames(s, 30);
    check('LIZA: what was typed is on the screen', screen(s).includes('HELLO THERE'));
    s.reset();
    frames(s, 60);
    check('reset: LIZA restarts, greeting again, what was typed gone', screen(s).includes('I AM LIZA') && !screen(s).includes('HELLO THERE'), screen(s));
    check('reset: LIZA is watched for BYE again; no menu asked for', s.menuWatch && s.menuWatch.kind === 'liza' && !menus.length, menus.join());
  }
  // Reset: a binary with an exec address restarts from it, with its own bytes (what it changed is undone)
  {
    const { s, menus } = newSession('dragon64');
    s.load('loop.bin', LOOP);
    frames(s, 5);
    s.shownMachine.poke(0x3001, 0x05);           // INC $0500 now: the program changed in memory
    frames(s, 2);
    s.reset();
    frames(s, 2);
    const pc = s.shownMachine.cpu.pc;
    check('reset: a binary restarts at its exec address with its own bytes', s.shownMachine.ram[0x3001] === 0x04 && pc >= 0x3000 && pc <= 0x3004 && !menus.length,
      `pc ${pc.toString(16)} $3001=${s.shownMachine.ram[0x3001]} ${menus.join()}`);
    // a binary loaded into a machine with ROMs isn't the stub's to restart: there, reset is BASIC's
  }
  // Reset with nothing to restart: the welcome menu
  {
    const { s, menus } = newSession('coco');
    frames(s, 10);
    s.reset();
    check('reset with nothing running: asks for the welcome menu (back)', menus.join() === 'back', menus.join());
  }
  // a program on one machine is not restarted on another
  {
    const { s, menus } = newSession('dragon64');
    s.load('loop.bin', LOOP);
    s.switchMachine('coco');
    check('switching to a machine without ROMs: the welcome menu', menus.join() === 'back', menus.join());
    s.reset();
    check('reset after switching machine: not the old machine\'s program; the welcome menu', menus.join() === 'back,back' && s.shownMachine.ram[0x3000] !== 0x7C, menus.join());
    s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
    menus.length = 0;
    s.switchMachine('dragon32');
    check('switching to a machine with its ROMs: BASIC, no menu', !menus.length && s.shownMachine.hasRom, menus.join());
  }
  // Switch off and on: the welcome menu, whatever ran
  {
    const { s, menus } = newSession('dragon64');
    await s.startLiza(() => liza);
    frames(s, 30);
    s.powerCycle();
    check('switch off and on, no ROMs: asks for the welcome menu (back); LIZA not restarted', menus.join() === 'back' && !s.menuWatch && !s.welcomeRunning, menus.join());
    s.reset();
    check('…and a reset after it restarts nothing of before: the welcome menu again', menus.join() === 'back,back', menus.join());
  }
  // "Run without ROMs" and "Remove ROMs" turn the machine on without them: the welcome menu
  {
    const { s, menus } = newSession('dragon32');
    s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
    check('with ROMs: no menu on adding them', !menus.length, menus.join());
    s.powerCycle();
    s.reset();
    check('with ROMs: switch off and on and reset are BASIC\'s (no menu)', !menus.length && s.shownMachine.hasRom, menus.join());
    s.runWithoutRoms();
    check('"Run without ROMs": the welcome menu', menus.join() === 'back' && s.shownMachine.useStub, menus.join());
    s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
    menus.length = 0;
    s.clearRoms();
    check('"Remove ROMs": the welcome menu', menus.join() === 'back' && s.shownMachine.useStub, menus.join());
  }
  // starting the welcome menu itself (on a machine with ROMs it goes to the stub first) asks for no other menu
  {
    const { s, menus } = newSession('dragon32');
    s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
    s.startWelcome(welcome);
    check('startWelcome on a machine with ROMs: no second menu', !menus.length && s.welcomeRunning, menus.join());
  }
  // the MC-10 and Alice (6803): their own welcome menu, with the greetings and option 5; LIZA restarts on reset
  for (const id of ['mc10', 'alice']) {
    const { s, menus } = newSession(id);
    s.powerCycle();
    check(`${id}: switch off and on, no ROMs: asks for the welcome menu (back)`, menus.join() === 'back', menus.join());
    s.startWelcome(welcome6803[id], { greeting: 'back', carryOn: 'LIZA' });
    frames(s, 50);
    let t = s.screenText();
    check(`${id}: the 6803 menu greets WELCOME BACK and offers 5 CARRY ON WITH LIZA (its digit inverse), PRESS 1 TO 5`, t[6] === '          WELCOME BACK          '
      && t[12].trim() === '5 CARRY ON WITH LIZA' && s.shownMachine.ram[0x4000 + 12 * 32 + 4] === 0x35 && t[13].trim() === '' && t[14].trim() === 'PRESS 1 TO 5', JSON.stringify(t.slice(6, 15)));
    const keys = [];
    s.on((e) => { if (e.startsWith('welcome:')) keys.push(e); });
    s.shownMachine.stubKeys.push(0x35); frames(s, 2);
    check(`${id}: key 5 emits welcome:carryon`, keys.join() === 'welcome:carryon', keys.join());
    s.reset();
    frames(s, 50);
    t = s.screenText();
    check(`${id}: reset keeps the menu as it was`, s.welcomeRunning && t[6].trim() === 'WELCOME BACK' && t[12].trim() === '5 CARRY ON WITH LIZA', JSON.stringify(t.slice(7, 15)));
    s.startWelcome(welcome6803[id], { greeting: 'bye' });
    frames(s, 50);
    t = s.screenText();
    check(`${id}: BYE FOR NOW. PICK ANOTHER? and no option 5; key 5 does nothing`, t[7].trim() === 'BYE FOR NOW. PICK ANOTHER?' && t[13].trim() === '' && t[14].trim() === 'PRESS 1 TO 4',
      JSON.stringify(t.slice(7, 15)));
    keys.length = 0;
    s.shownMachine.stubKeys.push(0x35); frames(s, 2);
    check(`${id}: without option 5, key 5 does nothing`, !keys.length, keys.join());
  }
  {
    const { s, menus } = newSession('mc10');
    s.switchLiza();
    menus.length = 0;
    await s.startLiza(() => liza6803);
    frames(s, 60);
    type(s, 'HELLO THERE\r');
    frames(s, 30);
    s.reset();
    frames(s, 60);
    check('MC-10: reset restarts LIZA (the 6803 build)', screen(s).includes('I AM LIZA') && !screen(s).includes('HELLO THERE'), screen(s));
    check('MC-10: LIZA is watched for BYE', s.menuWatch && s.menuWatch.kind === 'liza' && !menus.length, menus.join());
    type(s, 'BYE\r');
    frames(s, 4 * 60);
    check('MC-10: BYE in LIZA asks for the menu back (bye)', menus.join() === 'bye', menus.join());
  }
  // a snapshot taken on the stub's bare prompt opens on the welcome menu; one taken in a program, in it
  {
    const { s, menus } = newSession('dragon64');
    frames(s, 10);
    type(s, 'POKE 1030,42\r');
    check('the stub\'s prompt is what runs', s.shownMachine.atStubPrompt() && s.shownMachine.ram[1030] === 42);
    const a = await s.readSnapshot((await s.snapshotFile()).bytes);
    s.load('loop.bin', LOOP);
    frames(s, 3);
    check('a program is not the stub\'s prompt', !s.shownMachine.atStubPrompt());
    const b = await s.readSnapshot((await s.snapshotFile()).bytes);
    menus.length = 0;
    s.openSnapshot(a);
    check('opening a snapshot of the stub\'s prompt: the welcome menu (back)', menus.join() === 'back', menus.join());
    menus.length = 0;
    s.openSnapshot(b);
    frames(s, 2);
    check('opening a snapshot of a program: the program, no menu', !menus.length && s.shownMachine.cpu.pc >= 0x3000 && s.shownMachine.cpu.pc <= 0x3004, menus.join());
  }
  // the 6803 stub's prompt and a console call from it
  {
    const { s } = newSession('mc10');
    frames(s, 10);
    check('MC-10: the stub\'s prompt is what runs', s.shownMachine.atStubPrompt());
  }
  // the POKE book on the welcome menu: done at once, not typed into the menu
  {
    const { s } = newSession('dragon64');
    s.startWelcome(welcome);
    frames(s, 50);
    const keys = [];
    s.on((e) => { if (e.startsWith('welcome:')) keys.push(e); });
    const i = s.pokeBook().findIndex((p) => p.text === 'POKE 65495,0');
    const msg = s.typePoke(i);
    frames(s, 30);
    check('POKE book on the welcome menu: the SAM rate is set, no menu key pressed, the menu still runs', s.shownMachine.sam.rate === 1 && !keys.length && s.welcomeRunning
      && msg === 'Done: POKE 65495,0', `${msg} rate ${s.shownMachine.sam.rate} ${keys.join()}`);
    s.typePoke(s.pokeBook().findIndex((p) => p.text === 'POKE 65494,0'));
    check('…and back to normal speed', s.shownMachine.sam.rate === 0);
  }
  // embedded (?embed=1: Session({ welcomeMenu: false })): the host drives a plain machine, so no menu is asked for on a
  // power-on, a reset, a switch, Remove ROMs or leaving LIZA; Reset still restarts what runs
  {
    const s = new Emu.Session({ store: store(), welcomeMenu: false });
    const menus = [];
    s.on((e, arg) => { if (e === 'menu') menus.push(arg || 'bye'); });
    s.switchMachine('dragon64');
    s.powerCycle();
    s.reset();
    s.switchMachine('coco');
    s.clearRoms();
    s.runWithoutRoms();
    await s.startLiza(() => liza);
    check('embedded: no welcome menu asked for (switch, power-on, reset, Remove ROMs, Run without ROMs); LIZA not watched', !menus.length && s.menuWatch === null, menus.join());
    frames(s, 60);
    type(s, 'HELLO THERE\r');
    s.reset();
    frames(s, 60);
    check('embedded: Reset still restarts LIZA', screen(s).includes('I AM LIZA') && !screen(s).includes('HELLO THERE') && !menus.length);
  }
})().then(() => {
  console.log(`${n - fail}/${n} power-on checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL power-on ${e.stack}`); process.exitCode = 1; });
