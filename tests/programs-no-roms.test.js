// Run: node tests/programs-no-roms.test.js
//
// The project's own programs (LIZA, the colour demo, 2048, Minesweeper; the welcome menu has always) start on the
// built-in firmware, WITHOUT the person's ROMs, even when ROMs are stored for the model:
//  - the machine runs the stub (no ROM in it), so the moment holds no code of anyone's ROM (romCodeIn null),
//    shareFile needs nothing and a short link is allowed;
//  - the stored ROMs are untouched (still in the store, not hidden), and nothing is left behind for later boots: BASIC
//    starts on them when asked ("Use my ROMs"), a new Session on the same store boots them at once;
//  - a file the PERSON loads is not "ours": it runs as before, on their ROMs.
// The "ROMs" are stand-ins built from this project's own firmware (examples/*.bin), never real ROMs.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const bin = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const OURS = bin('liza.bin');
const standIn = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = OURS[(i * 5 + seed) % OURS.length] ^ (i >> 8) & 0xFF; return b; };
const memoryStore = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };

// a Session on the Dragon 64 with its two BASIC ROMs stored (stand-ins) and running on them
const withRoms = (store = Emu.memoryStore(), media = new Emu.MemoryMediaStore()) => {
  const s = new Emu.Session({ store, media, welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  Emu.profiles.dragon64.roms.forEach((r, k) => s.roms.put('dragon64', r.id, standIn(r.size || 0x4000, 11 + k * 31), `${r.id}.rom`));
  s.switchMachine('dragon64', {}, { menu: false });
  return s;
};
const stored = (s) => Object.values(s.roms.get('dragon64')).filter(Boolean).length;

(async () => {
  const programs = [
    ['LIZA', (s) => s.runLiza(bin('liza.bin'), { noRoms: true })],
    ['the colour demo', (s) => s.load('demo.bin', bin('demo.bin'), { remember: false, ours: true, noRoms: true })],
    ['2048', (s) => s.runGame('2048', bin('2048.bin'), { noRoms: true })],
    ['Minesweeper', (s) => s.runGame('minesweeper', bin('minesweeper.bin'), { noRoms: true })],
  ];
  for (const [name, start] of programs) {
    const s = withRoms();
    check(`${name}: the Session starts on the stored ROMs (the control: they are in the machine)`, s.shownMachine.hasRom && Emu.profiles.dragon64.roms.length === stored(s) && s.romCodeIn() === 'roms');
    start(s);
    s.runFrames(20);
    const m = s.shownMachine;
    const file = await s.shareFile();
    check(`${name}: with ROMs stored it runs on the built-in firmware: no ROM in the machine, no ROM code in the moment`, m.useStub && !m.hasRom && s.romCodeIn() === null, `${m.useStub} ${s.romCodeIn()}`);
    check(`${name}: so the moment needs no ROMs (needs is empty), and a short link is allowed`, file.needs.length === 0 && s.shortLinkRefusal() === null, JSON.stringify(file.needs));
    check(`${name}: the stored ROMs are untouched`, stored(s) === Emu.profiles.dragon64.roms.length && s.machineRoms('dragon64').bootable);
  }

  // what is left behind: nothing that changes a later boot. The same store, a new Session: BASIC starts on the ROMs.
  {
    const store = memoryStore(), media = new Emu.MemoryMediaStore();
    const s = withRoms(store, media);
    s.runLiza(bin('liza.bin'), { noRoms: true }); s.runFrames(10);
    const s2 = new Emu.Session({ store, media, welcomeMenu: false });
    s2.switchMachine('dragon64', {}, { menu: false });
    check('a new Session on the same store boots the stored ROMs: nothing about the program was left behind', s2.shownMachine.hasRom && s2.romCodeIn() === 'roms', `${s2.shownMachine.hasRom} ${s2.romCodeIn()}`);
    // and in this Session, "Use my ROMs" (js/ui/welcome.js switchOnButton) brings them back
    s.stubChosen.delete('dragon64');
    s.switchMachine('dragon64', {}, { menu: false });
    check('"Use my ROMs" puts the stored ROMs back in the machine', s.shownMachine.hasRom && s.romCodeIn() === 'roms');
  }

  // a file the person loads is not ours: it keeps their ROMs
  {
    const s = withRoms();
    const before = s.shownMachine;
    let kept = null;
    try { s.load('mine.bin', bin('demo.bin'), { remember: false }); kept = s.shownMachine.hasRom; } catch (e) { kept = `threw ${e.message}`; }
    check('a program the person loads (not "ours") does not take their ROMs off', kept === true && stored(s) === Emu.profiles.dragon64.roms.length, String(kept));
    void before;
  }

  // The MCP load {program} tool and the CLI's --program are not the page: they start on the machine as it is, so a boot
  // with roms:true after them still gives BASIC on the stored (stand-in) ROMs, as on main. Only the page asks for the
  // built-in firmware (noRoms, js/ui/welcome.js).
  {
    const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js', 'mcp', 'tools.js')).href);
    const host = { roms: () => [], png: () => new Uint8Array([1]), program: (f) => bin(f), now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate) };
    for (const program of ['liza', 'demo', '2048']) {
      const s = withRoms();
      const tb = T.createToolbox(host, { session: s, route: 'panel' });
      const loaded = await tb.call('load', { machine_id: 'm1', program });
      s.runFrames(20);
      check(`MCP load {program: ${program}} keeps the machine as it is: still on the stored ROMs, no stub chosen`, loaded.ok && s.shownMachine.hasRom && !s.shownMachine.useStub && !s.stubChosen.has('dragon64') && s.romCodeIn() === 'roms', JSON.stringify(loaded).slice(0, 200));
      const boot = await tb.call('boot', { model: 'dragon64', roms: true });
      check(`MCP load {program: ${program}} then boot {roms: true}: roms is true, with the stored (stand-in) ROMs`, boot.ok && boot.data.machine.roms === true && s.shownMachine.hasRom && s.romCodeIn() === 'roms', JSON.stringify(boot).slice(0, 240));
    }
  }

  // a machine with no ROMs of its own (the stub) is as it was: the same machine, no power cycle
  {
    const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
    s.switchMachine('dragon64', {}, { menu: false });
    const m = s.shownMachine;
    s.runLiza(bin('liza.bin'), { noRoms: true }); s.runFrames(10);
    check('without ROMs stored LIZA runs as before, on the same machine', s.shownMachine === m && m.useStub && s.romCodeIn() === null);
  }

  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
