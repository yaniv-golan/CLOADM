// The HD6309 runs the 6809 builds: with `cpu=6309` a machine must still get the welcome menu, LIZA, the
// colour demo and the Claude chat, because the 6309 executes every 6809 instruction (in emulation mode, which
// is where a reset leaves it) and each of those programs is a 6809 program.
//
// The regression this pins: Session's lookups were keyed by `config.cpu`, and only '6809' and '6803' had
// entries, so a 6309 machine asked for WELCOME['6309'], LIZA['6309'] and DONE['6309'], found nothing, and the
// page showed "examples/undefined: HTTP 404". The stored choice is legal (Machine tab, ?cpu=6309); it is the
// lookups that must know the 6309 runs the 6809 code.
//
// What is proved here, with no ROMs and no page:
//  * the CPU family helper maps 6309 to the 6809 family and leaves 6803 alone;
//  * on every 6309 model, Session.welcomeFile / lizaFile / carryOn and startWelcome / startLiza / startChat
//    all behave as they do on the 6809;
//  * the welcome build really runs on the 6309 core and shows the same menu (it reaches the same screen);
//  * the 6803-only rules still apply to the 6803 models and nothing else (no demo where there is no build);
//  * the session on a 6309 still records the 6309 in its config, so a reload keeps the choice.
// Run: node tests/cpu6309-session.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const welcome = read('welcome.bin'), liza = read('liza.bin'), demo = read('demo.bin');
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const store = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
// what a machine looks like after running a program: the CPU's whole state and the screen. Running the same
// 6809 build on a 6309 and on a 6809 must give the same answer here - that is the claim the family model rests
// on, and it is falsifiable (a 6309 that trapped on an opcode, or ran it wrongly, would differ).
const snapshotOf = (s) => ({ pc: s.shownMachine.cpu.pc, cc: s.shownMachine.cpu.cc, a: s.shownMachine.cpu.a, b: s.shownMachine.cpu.b, x: s.shownMachine.cpu.x,
  y: s.shownMachine.cpu.y, u: s.shownMachine.cpu.u, s: s.shownMachine.cpu.s, screen: s.screenText().join('\n') });
// run `file` from the assembly on a fresh machine of model `id` with `cpu`, for `n` frames
const runOn = (id, cpu, bytes, name, n) => {
  const s = new Emu.Session({ store: store() });
  s.switchMachine(id, { cpu }, { menu: false });
  const msg = s.load(name, bytes, { remember: false });
  frames(s, n);
  return { s, msg, state: snapshotOf(s) };
};

// ---- the models with a 6309 option, read from the profile (not hard-coded) ----
const two = Object.values(Emu.profiles).filter((p) => p.options && p.options.cpu && p.options.cpu.values.includes('6309')).map((p) => p.id);
const only6809 = Object.values(Emu.profiles).filter((p) => p.options && p.options.cpu && p.options.cpu.values.length === 1
  && p.options.cpu.values[0] === '6809').map((p) => p.id);
const only6803 = Object.values(Emu.profiles).filter((p) => p.options && p.options.cpu && p.options.cpu.values[0] === '6803').map((p) => p.id);
check('there are models with a 6309 option', two.length >= 4, two.join(' '));
check('the CoCo 2B is 6809-only: cpu=6309 there resolves to 6809, so a 6309 test on it would be vacuous', only6809.includes('coco2b') && !two.includes('coco2b'), only6809.includes('coco2b').toString());

// ---- 1. the family helper ----
// (Emu.cpuFamily may be absent on an older tree: that is a failing check, not a crash, so the run continues
// and the behavioural checks below show the bug the helper exists to prevent)
const fam = typeof Emu.cpuFamily === 'function' ? Emu.cpuFamily : () => undefined;
{
  check('cpuFamily: 6309 is in the 6809 family', fam('6309') === '6809', String(fam('6309')));
  check('cpuFamily: 6809 is the 6809 family', fam('6809') === '6809', String(fam('6809')));
  check('cpuFamily: 6803 is its own family', fam('6803') === '6803', String(fam('6803')));
  check('cpuFamily: an unknown CPU has none', fam('9999') === null && fam(undefined) === null, `${fam('9999')} ${fam(undefined)}`);
}

// ---- 2. per 6309 model: the same lookups the 6809 gets, and the same run ----
for (const id of two) {
  const s = new Emu.Session({ store: store() });
  const m = s.switchMachine(id, { cpu: '6309' }, { menu: false });
  check(`${id} 6309: the config keeps the 6309`, m.config.cpu === '6309');
  check(`${id} 6309: welcomeFile is the 6809 build`, s.welcomeFile === 'welcome.bin', s.welcomeFile);
  check(`${id} 6309: lizaFile is the 6809 build`, s.lizaFile === 'liza.bin', s.lizaFile);
  check(`${id} 6309: lizaNeeds is null (the 6803 RAM rule does not apply)`, s.lizaNeeds() === null);

  // the welcome menu starts (it threw "There is no Welcome menu for the ...'s 6309" before the fix) and runs
  let err = null;
  const events = [];
  s.on((e) => { if (e.startsWith('welcome:')) events.push(e); });
  try { s.startWelcome(welcome); } catch (e) { err = e; }
  check(`${id} 6309: startWelcome loads the welcome program`, !err && s.welcomeRunning, err && err.message);
  frames(s, 50);
  const t = s.screenText();
  check(`${id} 6309: the menu shows, keys 1 to 5`, /1 TALK TO LIZA/.test(t[8]) && /5 PLAY A GAME/.test(t[12]) && /PRESS 1 TO 5/.test(t[14]), JSON.stringify(t.slice(8, 15)));
  // the welcome build draws the same screen on the 6309 as on the 6809 (same CPU state, same cells)
  const welcome6309 = runOn(id, '6309', welcome, 'welcome.bin', 50), welcome6809 = runOn(id, '6809', welcome, 'welcome.bin', 50);
  check(`${id} 6309: the welcome menu ends where the 6809's does (same CPU state and screen)`,
    JSON.stringify(welcome6309.state) === JSON.stringify(welcome6809.state), `${welcome6309.state.pc.toString(16)} vs ${welcome6809.state.pc.toString(16)}`);
  // the welcome program's mailbox is the 6809 build's address, so its keys are the menu's keys
  s.shownMachine.stubKeys.push(0x31); frames(s, 2);   // '1'
  check(`${id} 6309: key 1 emits welcome:liza`, events.join() === 'welcome:liza', events.join());

  // the demo is offered (a 6809-family program), and so is LIZA
  s.setLastRun('demo', 'Colour demo');
  check(`${id} 6309: the colour demo is offered as option 5`, s.carryOn && s.carryOn.kind === 'demo', JSON.stringify(s.carryOn));
  s.setLastRun('liza', 'LIZA');
  check(`${id} 6309: LIZA is offered as option 5`, s.carryOn && s.carryOn.kind === 'liza', JSON.stringify(s.carryOn));

  // the demo loads and runs on the 6309, and ends in exactly the state it ends in on the 6809
  const demo6309 = runOn(id, '6309', demo, 'demo.bin', 40), demo6809 = runOn(id, '6809', demo, 'demo.bin', 40);
  check(`${id} 6309: the colour demo loads and runs`, /demo\.bin/.test(demo6309.msg), demo6309.msg);
  check(`${id} 6309: the colour demo ends where the 6809's does (same CPU state and screen)`,
    JSON.stringify(demo6309.state) === JSON.stringify(demo6809.state), `${demo6309.state.pc.toString(16)} vs ${demo6809.state.pc.toString(16)}`);
}

// ---- 3. startLiza on the 6309 runs the 6809 build, reaches LIZA, and BYE brings the menu back ----
(async () => {
  for (const id of two) {
    const s = new Emu.Session({ store: store() });
    s.switchMachine(id, { cpu: '6309' }, { menu: false });
    let menus = 0;
    s.on((e) => { if (e === 'menu') menus++; });
    let err = null, msg = null;
    try { msg = await s.startLiza(() => liza); } catch (e) { err = e; }
    check(`${id} 6309: startLiza loads the 6809 build`, !err && /liza\.bin/.test(msg), err ? err.message : msg);
    frames(s, 80);
    check(`${id} 6309: LIZA runs (I AM LIZA on the screen)`, /I AM LIZA/.test(s.screenText().join(' ')));
    // and it runs identically: 80 frames of the same liza.bin on the 6309 and on the 6809 end in the same state
    {
      const a = runOn(id, '6309', liza, 'liza.bin', 80), b = runOn(id, '6809', liza, 'liza.bin', 80);
      check(`${id} 6309: LIZA ends where the 6809's does (same CPU state and screen)`, JSON.stringify(a.state) === JSON.stringify(b.state),
        `${a.state.pc.toString(16)} vs ${b.state.pc.toString(16)}`);
    }
    // BYE stops at the 6809 build's DONE loop; the watch is the 6809 one, so the menu comes back
    s.typeText('BYE\n');
    let atDone = null;
    for (let i = 0; i < 400 && atDone === null; i++) { frames(s, 1); if (s.shownMachine.cpu.pc === Emu.Session.LIZA.done['6809']) atDone = i; }
    check(`${id} 6309: BYE reaches the 6809 build's DONE loop`, atDone !== null, `at ${atDone}`);
    frames(s, Math.ceil(s.shownMachine.fps * 3) + 10);
    check(`${id} 6309: the menu comes back after the goodbye`, menus === 1, `menus ${menus}`);
  }

  // ---- 4. startChat accepts the 6309 and runs the chat firmware on it, exactly as on the 6809 ----
  const firmware = read('chat.bin');
  // the chat machine's screen and CPU state after the firmware has drawn, on `cpu`
  const chatOn = (id, cpu) => {
    const s = new Emu.Session({ store: store() });
    s.switchMachine(id, { cpu }, { menu: false });
    const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' });
    try { s.startChat({ backend, channel: new Emu.MemoryChannel(), firmware }); }
    catch (e) { return { err: e.message }; }   // refused (e.g. on a CPU with no 6809 family): a failing check, not a crash
    frames(s, 40);
    const m = s.shownMachine;   // the chat machine, on screen
    return { cfg: m.config.cpu, pc: m.cpu.pc, md: m.cpu.md, state: { pc: m.cpu.pc, cc: m.cpu.cc, a: m.cpu.a, b: m.cpu.b, x: m.cpu.x, y: m.cpu.y, s: m.cpu.s }, screen: s.screenText().join('\n') };
  };
  for (const id of two) {
    const s = new Emu.Session({ store: store() });
    s.switchMachine(id, { cpu: '6309' }, { menu: false });
    const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' });
    let err = null, chat = null;
    try { chat = s.startChat({ backend, channel: new Emu.MemoryChannel(), firmware }); } catch (e) { err = e; }
    check(`${id} 6309: startChat opens the chat`, !err && !!chat, err && err.message);
    check(`${id} 6309: the chat machine is a 6309 of the same model`, s.chatMachines && s.chatMachines.chat.config.cpu === '6309' && s.chatMachines.chat.id === id,
      s.chatMachines ? `${s.chatMachines.chat.id} ${s.chatMachines.chat.config.cpu}` : 'no chat machine');
    // the firmware draws its 256x192 screen: the 6309 chat machine must match the 6809 one frame for frame,
    // which fails if the firmware traps, mis-decodes an opcode or draws differently on the 6309. The screen must
    // NOT be the stub's "NO ROM LOADED" banner: that is what a firmware which never ran leaves behind.
    const on6309 = chatOn(id, '6309'), on6809 = chatOn(id, '6809');
    check(`${id} 6309: the chat firmware is running on the 6309 (emulation mode, its own screen, not the stub)`,
      !on6309.err && on6309.cfg === '6309' && on6309.md === 0 && !/NO ROM LOADED|BUILT-IN STUB/.test(on6309.screen),
      on6309.err || `pc=${on6309.pc.toString(16)} md=${on6309.md}`);
    check(`${id} 6309: the chat screen and CPU state match the 6809's exactly`, !on6309.err && !on6809.err && JSON.stringify(on6309.state) === JSON.stringify(on6809.state) && on6309.screen === on6809.screen,
      on6309.err || on6809.err || `pc ${on6309.pc.toString(16)} vs ${on6809.pc.toString(16)}`);
  }

  // ---- 5. a 6809-only model still gets the 6809 rules, and a 6803 model the 6803 ones ----
  {
    const s = new Emu.Session({ store: store() });
    s.switchMachine('mc10');
    check('MC-10: lizaFile is its 6803 build', s.lizaFile === 'liza6803-mc10.bin', s.lizaFile);
    check('MC-10: welcomeFile is its 6803 build', s.welcomeFile === 'welcome6803-mc10.bin', s.welcomeFile);
    check('MC-10: the chat is refused (no 6809)', throws(() => s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware }), /needs a 6809/));
    s.setLastRun('demo', 'Colour demo');
    check('MC-10: the colour demo is not offered (no 6803 build)', s.carryOn === null, JSON.stringify(s.carryOn));
    // 4K MC-10: LIZA needs the 20K option, as before
    s.switchMachine('mc10', { ram: 4 }, { menu: false });
    check('MC-10 4K: LIZA needs the 20K option', JSON.stringify(s.lizaNeeds()) === '{"ram":20,"have":4}', JSON.stringify(s.lizaNeeds()));
  }
  // every 6809-only model keeps the 6809 lookups: each one named in the detail, so a regression says which
  {
    const wrong = only6809.filter((id) => {
      const s = new Emu.Session(); s.switchMachine(id);
      return s.welcomeFile !== 'welcome.bin' || s.lizaFile !== 'liza.bin';
    });
    check('every 6809-only model still gets the 6809 builds', wrong.length === 0, wrong.length ? wrong.join(' ') : `${only6809.length} models`);
  }
  check('the 6803 models are the MC-10 and the Alice', only6803.join() === 'mc10,alice', only6803.join());

  // ---- 6. the 6309 stays sticky across visits ----
  {
    const st = store();
    const s = new Emu.Session({ store: st });
    s.switchMachine('dragon64', { cpu: '6309' });
    check('switching with cpu=6309 records it for the model', JSON.parse(st.get('config.dragon64')).cpu === '6309', st.get('config.dragon64'));
    // a later visit (a new Session on the same store) gets the 6309 back and the welcome menu still works
    const t = new Emu.Session({ store: st });
    const m = t.switchMachine('dragon64');
    check('a later visit keeps the 6309', m.config.cpu === '6309' && t.welcomeFile === 'welcome.bin' && t.lizaFile === 'liza.bin');
    let e2 = null;
    try { t.startWelcome(welcome); } catch (e) { e2 = e; }
    check('a later visit\'s welcome menu starts', !e2 && t.welcomeRunning, e2 && e2.message);
  }

  console.log(fail ? `${fail} FAILED` : `all ${n} 6309 session checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
