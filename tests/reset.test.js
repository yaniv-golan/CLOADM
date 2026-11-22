// The Reset button through the Session: it never changes the machine, it keeps RAM so a program that holds BASIC's
// warm-start vector gets it back, and the boot watchdog arms only on a power-on (a Reset that comes back without
// BASIC's OK is 'reset', with `takeover` when a program holds the vector, never 'failed'). Also the ROM-drop offers
// (no offer of a machine whose sockets hold the same ROMs) and the 6809's flags over a reset.
// MAME's side of a Reset is tools/mame-diff/sam/reset.asm (run.js <profile> --reset, and the regression gate).
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const K = 1024;

const { BASIC, GAME, build } = require('./fixtures/reset-firmware');
const { basic, basic64, game } = build(Emu);
const frames = (s, n) => { for (let i = 0; i < n; i++) s.shownMachine.runFrame(); };
const top = (s) => s.screenText()[0].slice(0, 4);
const dragonRoms = (s) => s.addRoms([{ name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]);

// ---- Reset never changes the machine: every model, with and without ROMs ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const bad = [];
  for (const id of Object.keys(Emu.profiles)) {
    s.switchMachine(id);
    frames(s, 3);
    const before = { id: s.shownMachine.id, name: s.shownMachine.profile.name, config: JSON.stringify(s.shownMachine.config), stored: s.store.get('machine') };
    const m = s.shownMachine;
    s.reset();
    frames(s, 3);
    const after = { id: s.shownMachine.id, name: s.shownMachine.profile.name, config: JSON.stringify(s.shownMachine.config), stored: s.store.get('machine') };
    if (s.shownMachine !== m || JSON.stringify(after) !== JSON.stringify(before)) bad.push(`${id}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  check(`Reset keeps the machine, its model and options, on all ${Object.keys(Emu.profiles).length} models (no ROMs)`, !bad.length, bad.join('; '));
}
{
  // one drop makes the Dragon 64 and the Tano Dragon 64 both ready (they take the same ROMs); Reset on either keeps it
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  dragonRoms(s);
  check('one ROM drop: the Dragon 64 and the Tano Dragon 64 are both ready', s.machineRoms('dragon64').bootable && s.machineRoms('tanodr64').bootable);
  for (const id of ['dragon64', 'tanodr64']) {
    s.switchMachine(id);
    frames(s, 10);
    s.fastCas = true;
    s.inject(game, 0x4022);
    frames(s, 5);
    const m = s.shownMachine;
    s.reset();
    frames(s, 10);
    check(`${id} with ROMs and a game: Reset keeps the machine (${s.shownMachine.profile.name}, ${s.shownMachine.fps} Hz)`,
      s.shownMachine === m && s.shownMachine.id === id && s.store.get('machine') === id && s.statusLine(m.fps).startsWith(`${Emu.profiles[id].name} ·`));
  }
}

// ---- RAM kept, the warm-start vector honoured, and the watchdog ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  dragonRoms(s);
  frames(s, 10);
  check('power-on: our BASIC stand-in prints OK', top(s) === 'OK  ' && s.bootStatus().state === 'ok', top(s));
  s.inject(game, 0x4022);
  frames(s, 5);
  check('the game runs (G) and holds the warm-start vector', top(s) === 'GGGG' && s.shownMachine.ram[0x71] === 0x55);
  s.reset();
  frames(s, 5);
  check('Reset: RAM kept and BASIC\'s reset routine jumps through the vector into the game (W)', top(s) === 'WWWW' && s.shownMachine.ram[0x4022] === 0x1A, top(s));
  check('Reset: booting at first', s.bootStatus(5).state === 'booting');
  frames(s, 5 * 50 + 2);
  const st = s.bootStatus(5);
  check('Reset into the game: no OK is not a boot failure but a takeover', st.state === 'reset' && st.takeover === true, JSON.stringify(st));
  s.powerCycle();
  frames(s, 10);
  check('Switch off and on: RAM cleared, BASIC cold-starts (OK)', top(s) === 'OK  ' && s.shownMachine.ram[0x71] === 0 && s.bootStatus().state === 'ok');
  // a Reset that BASIC answers with OK (the flag cleared by the cold start): ok, as before
  s.reset();
  frames(s, 10);
  check('Reset with no program holding the vector: BASIC\'s OK', top(s) === 'OK  ' && s.bootStatus(5).state === 'ok');
}
{
  // a ROM that never prints OK: failed after a power-on, as before; after a Reset (no takeover) it is 'reset', not a
  // second report of a failure the power-on already made
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  check('watchdog: power-on with no OK -> failed', s.bootStatus(5).state === 'failed');
  s.reset();
  frames(s, 5 * 50 + 2);
  const st = s.bootStatus(5);
  check('watchdog: never failed after a Reset; no program holds the vector -> no takeover', st.state === 'reset' && st.takeover === false, JSON.stringify(st));
  s.powerCycle();
  check('watchdog: armed again by a power-on', s.bootStatus(5).state === 'booting');
  frames(s, 5 * 50 + 2);
  check('watchdog: and fails again after it', s.bootStatus(5).state === 'failed');
}
{
  // a Reset and then a power-on before any frame has run (same frameCount): the power-on arms the watchdog again
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
  frames(s, 2);
  s.reset();
  s.powerCycle();
  frames(s, 5 * 50 + 2);
  check('watchdog: a power-on right after a Reset (no frame between) is a power-on: failed', s.bootStatus(5).state === 'failed', JSON.stringify(s.bootStatus(5)));
  // the same with a machine switch to the same model in between (a new machine, the RAM option changed)
  s.reset();
  s.switchMachine('dragon32');
  frames(s, 5 * 50 + 2);
  check('watchdog: a new machine right after a Reset is a power-on: failed', s.bootStatus(5).state === 'failed', JSON.stringify(s.bootStatus(5)));
}
{
  // the vector set but not pointing at a NOP is what BASIC refuses: no takeover
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
  frames(s, 2);
  s.reset();
  s.shownMachine.ram[0x71] = 0x55; s.shownMachine.ram[0x72] = 0x30; s.shownMachine.ram[0x73] = 0x00; s.shownMachine.ram[0x3000] = 0x39;
  frames(s, 5 * 50 + 2);
  check('takeover needs a NOP at the vector, as BASIC does', s.bootStatus(5).takeover === false);
  s.shownMachine.ram[0x3000] = 0x12;
  check('... and is reported once there is one', s.bootStatus(5).takeover === true);
}

// ---- ROM-drop offers ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const r = dragonRoms(s);
  check('a drop on the Dragon 64 does not offer the Tano Dragon 64 (same ROMs in every socket)', !r.offers.some((o) => o.machine === 'tanodr64'), JSON.stringify(r.offers));
  const t = new Emu.Session({ store: Emu.memoryStore() });
  t.switchMachine('coco');
  const r2 = dragonRoms(t);
  check('a drop on a CoCo offers both Dragons it made ready', ['dragon64', 'tanodr64'].every((id) => r2.offers.some((o) => o.machine === id)), JSON.stringify(r2.offers));
}

// ---- the 6809 (and 6309) over a reset: I and F set, the other flags kept; DP 0; at power-on CC is I|F ----
for (const cpu of ['6809', '6309']) {
  const m = Emu.createMachine('dragon64', { cpu });
  m.setRoms({ basic, basic64 });
  m.reset(true);
  check(`${cpu}: power-on CC = I|F`, m.cpu.cc === 0x50 && m.cpu.dp === 0);
  m.cpu.cc = 0x0F; m.cpu.dp = 0x12;
  m.reset(false);
  check(`${cpu}: Reset sets I and F and keeps the rest (MAME's soft reset)`, m.cpu.cc === 0x5F && m.cpu.dp === 0, m.cpu.cc.toString(16));
  m.cpu.cc = 0x0F;
  m.reset(true);
  check(`${cpu}: a power-on starts the flags clear`, m.cpu.cc === 0x50);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
