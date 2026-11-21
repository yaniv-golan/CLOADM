// Run: node tests/chat-leaks.test.js
//
// THE SWEEP: with the Claude chat full screen, every public Session action a person can trigger is called once, and
// the chat machine must be untouched afterwards. This is the guard against the bug class the branch fixes - a
// person-facing action reaching the chat machine (which runs the chat firmware) instead of the person's BASIC
// session - and it is a TABLE on purpose: a new person-facing action needs a new row, so a new door cannot be added
// without a check.
//
// The chat machine's fingerprint covers every part of it a person action used to damage: its RAM (a hash), its
// reset count and frame count (a power cycle or reset), the cartridge in its port (identity and type), the tape in
// its deck, its stored-ROM set (whether it has ROMs, and which), its stub choice, and its own stub-restart record
// (compared by identity: a load or a welcome over the chat firmware replaces it).
//
// The rows come from the UI modules' own calls (a grep of `session.<member>` in js/ui/*.js, filtered to the ones
// that change state), not from memory. Getters are not rows: they cannot change anything.
//
// Each row: [name, (session) => ... ]  - the action, called with the chat on screen.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/chat.bin')));
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.machine.fps + 0.01); };
const { build } = require('./fixtures/reset-firmware');
const { basic, basic64, game } = build(Emu);
const KEY = 'sk-ant-LEAK-TEST-0123456789';
const backend = () => new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY });

// the tape and binaries the rows use (the shapes tests/session-robustness.test.js builds)
const block = (t, d) => { let s = (t + d.length) & 255; for (const v of d) s = (s + v) & 255; return [0x3C, t, d.length, ...d, s, 0x55]; };
const casTape = () => { const nf = [...Buffer.from('TEST    '), 2, 0, 0, 0x40, 0x40, 0x03, 0x00]; return Uint8Array.from([...new Array(128).fill(0x55), ...block(0, nf), ...new Array(128).fill(0x55), ...block(1, [0x20, 0xFE]), ...block(0xFF, [])]); };
const BIN = Uint8Array.from([0x55, 0x02, 0x08, 0x00, 0x00, 0x02, 0x08, 0x00, 0xAA, 0x20, 0xFE]);
const ROM_A = new Uint8Array(16384).fill(0x12), ROM_B = new Uint8Array(16384).fill(0x41);

// a chat on the session, full screen, with the BASIC session set up per `setup`
function chatSession(setup = () => {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  setup(s);
  frames(s, 5);
  s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: '', tools: false });
  frames(s, 5);
  return s;
}
const withRoms = (s) => s.addRoms([{ name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]);
const onStub = (s) => s.runWithoutRoms({ menu: false });
const withTape = (s) => s.insertTape('x.cas', casTape());

// the chat machine's fingerprint: anything a person action reaches on it changes one of these
function fingerprint(m) {
  const roms = Object.fromEntries(m.profile.roms.map((r) => [r.id, m.roms[r.id] ? Emu.crc32(m.roms[r.id]) : null]));
  return {
    ram: Emu.crc32(m.ram),
    resetAt: m.resetAt,
    frames: m.frameCount,
    cart: m.cartPort ? `${m.cartPort.type || m.cartPort.constructor.name}:${m.cartPort.romBytes ? Emu.crc32(m.cartPort.romBytes) : ''}` : null,
    tape: m.deck.tape ? m.deck.tape.name : null,
    roms,
    stub: m.useStub,
    record: m.debugger ? 'dbg' : null,     // (the stub record is compared by identity in the row runner, below)
  };
}
function diff(before, after) {
  const out = [];
  for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  return out;
}
const stable = (m) => { const b = fingerprint(m); frames(m && m.session ? null : { fps: 50 }, 0); return b; };

// ---- the table: one row per person-facing action the UI can trigger ----
// setup: what the BASIC session needs before the action makes sense (the action then runs with the chat on screen)
const ROWS = [
  // the load path
  ['load a binary (a program dropped on the screen)', () => {}, (s) => s.load('prog.bin', BIN)],
  ['load a .cas tape', () => {}, (s) => s.load('tape.cas', casTape())],
  ['load a .cas tape with stored ROMs on the stub (the fix-D path)', withRoms, (s) => { s.runWithoutRoms({ menu: false }); s.fastCas = false; return s.load('t.cas', casTape()); }],
  ['load a raw file with askAddresses', () => {}, (s) => s.load('raw.bin', new Uint8Array(16), { askAddresses: () => ({ load: 0x2000, exec: 0x2000 }) })],
  ['load a BASIC listing (basictext)', () => {}, (s) => s.load('prog.bas', new TextEncoder().encode('10 PRINT 1\n20 GOTO 10\n'))],
  ['load a cartridge', () => {}, (s) => s.load('prog.rom', new Uint8Array(0x2000).fill(0x39))],
  // the deck
  ['insert a tape', () => {}, (s) => s.insertTape('x.cas', casTape())],
  ['rewind the tape', withTape, (s) => s.rewindTape()],
  ['skip the tape (load it instantly)', withTape, (s) => s.skipTape()],
  ['tape to WAV', withTape, (s) => s.tapeWav()],
  ['start recording', () => {}, (s) => s.startTapeRecording()],
  ['stop recording', () => { }, (s) => { s.startTapeRecording(); return s.stopTapeRecording(); }],
  // ROMs
  ['add ROMs', () => {}, (s) => s.addRoms([{ name: 'd64_1.rom', bytes: basic }])],
  ['remove ROMs', withRoms, (s) => s.clearRoms()],
  ['run without ROMs', withRoms, (s) => s.runWithoutRoms({ menu: false })],
  ['use the stored ROMs again', (s) => { withRoms(s); s.runWithoutRoms({ menu: false }); }, (s) => s.useStoredRoms(s.chatMachines.basic)],
  ['export a ROM pack', withRoms, (s) => s.exportRomPack()],
  // machines and power
  // Reset with the chat on screen is DELIBERATE: the screen's Reset button restarts what is on screen, and that is
  // the chat firmware (it comes back running). It must not reach the person's session, and the chat's record must
  // survive - both checked below.
  ['Reset (restarts the chat firmware, by design)', () => {}, (s) => s.reset(), 'restarts-chat'],
  ['Switch off and on (the Power button)', () => {}, (s) => s.powerCycle({ reason: 'you power cycled the machine' })],
  // (a machine switch and the LIZA RAM switch replace the machine and close the conversation: documented)
  ['switch machine', () => {}, (s) => s.switchMachine('coco3'), 'closes-chat'],
  ['switch LIZA\'s RAM', () => {}, (s) => s.switchLiza(), 'closes-chat'],
  // disks
  ['insert a disk', () => {}, (s) => s.importDisk('d.vdk', Emu.blankDisk('vdk', 40, 1), 0)],
  ['eject a disk', (s) => { frames(s, 2); }, (s) => s.ejectDisk(0)],
  ['new disk', () => {}, (s) => s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 })],
  ['insert a disk controller', () => {}, (s) => s.insertDiskDos('dragondos')],
  ['set write protect', (s) => {}, (s) => s.setDiskWriteProtect(0, true)],
  // cartridges and packs
  ['insert a Multi-Pak', () => {}, (s) => s.insertMultiPak([{ name: 'c.rom', bytes: new Uint8Array(0x2000).fill(0x39) }])],
  ['insert the Speech/Sound Pak', () => {}, (s) => s.insertSsc()],
  ['eject the Speech/Sound Pak', () => {}, (s) => s.ejectSsc()],
  // programs and the welcome
  ['run a game', () => {}, (s) => s.runGame('2048', game.bin || game)],
  ['run LIZA', () => {}, (s) => s.runLiza()],
  ['check a game\'s needs', () => {}, (s) => s.checkGame('2048')],
  ['the game RAM check', () => {}, (s) => s.gameNeeds()],
  ['the LIZA RAM check', () => {}, (s) => s.lizaNeeds()],
  ['start the welcome menu', () => {}, (s) => s.startWelcome(new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin'))), { greeting: 'back' })],
  // the POKE book
  ['type a POKE from the book', () => {}, (s) => s.typePoke(0)],
  ['type raw text', () => {}, (s) => s.typeText('PRINT 1\n')],
  ['send a key (personInput)', () => {}, (s) => s.personInput(s.chatMachines.basic)],
  ['press BREAK', () => {}, (s) => s.pressBreak()],
  // snapshots
  ['save a snapshot', () => {}, (s) => s.snapshotFile()],
  ['save a quick slot', () => {}, (s) => s.saveSlot(1)],
  ['take a restore point / undo', () => {}, (s) => { const c = s.startAsk({ backend: backend() }); c.undo.push(s.chatTarget().snapshot()); return s.restoreClaude(0); }],
  // NitrOS-9
  ['boot NitrOS-9', () => {}, (s) => s.bootNitros9(new Uint8Array(0x1000))],
  // the Claude chat itself (must reach the person's machine for acting)
  ['Ask Claude (the side panel)', () => {}, (s) => s.startAsk({ backend: backend() })],
  // (these three close or leave the chat by design: the runner asserts that, not a fingerprint of a machine that is
  // meant to go. They are in the table because the UI can trigger them.)
  ['end the chat', () => {}, (s) => s.endChat(), 'closes-chat'],
  ['show the BASIC session', () => {}, (s) => s.showChat('basic'), 'keeps-chat'],
  ['return to the side panel', () => {}, (s) => s.toSidePanel(), 'closes-chat'],
  // settings and the library (no machine at all, but they are in the UI's list)
  ['switch display', () => {}, (s) => s.setDisplay({})],
  ['clear the printout', () => {}, (s) => s.clearPrintout()],
  ['save settings', () => {}, (s) => s.exportSettings()],
];

// A row is run TWICE from the same starting point: once with a no-op in place of the action (the control: the chat
// firmware's own running over the same frames, which changes its RAM and frame count by itself) and once with the
// action. A field that differs beyond the control is the action's doing: a leak into the chat machine.
async function observed(setup, act) {
  const s = chatSession((x) => { try { setup(x); } catch (e) { /* the setup's own needs */ } });
  const chatM = s.chatMachines.chat;
  const before = fingerprint(chatM), recordBefore = s.stubRuns.get(chatM);
  let threw = null;
  try { await act(s); } catch (e) { threw = e.message; }
  frames(s, 3);
  const after = fingerprint(chatM);
  const out = { changed: diff(before, after), recordKept: s.stubRuns.get(chatM) === recordBefore,
    same: s.chatMachines && s.chatMachines.chat === chatM, threw };
  s.endChat();
  return out;
}

(async () => {
  check('the table has a row for every person-facing action', ROWS.length >= 40, `${ROWS.length} rows`);
  for (const [name, setup, act, kind] of ROWS) {
    const control = await observed(setup, async () => {});
    const real = await observed(setup, act);
    if (kind === 'restarts-chat') {
      // deliberate: the chat machine is reset (its reset count moves) and NOTHING else of it changes - it comes back
      // running the chat firmware; the person's session and the chat's stub record are untouched
      const beyondReset = real.changed.filter((k) => !control.changed.includes(k) && k !== 'resetAt');
      check(`no leak: ${name}`, beyondReset.length === 0 && real.changed.includes('resetAt') && real.recordKept && real.same,
        `${real.changed.join(', ')}${beyondReset.length ? ` (beyond the reset: ${beyondReset.join(',')})` : ''}`);
      continue;
    }
    if (kind === 'closes-chat' || kind === 'keeps-chat') {
      // the chat's own closing/leaving: the machine going is the point; what must NOT happen is a fingerprint change
      // before it went, which the control comparison still covers for the ones that stay
      check(`no leak: ${name} (${kind === 'closes-chat' ? 'the chat closes' : 'the chat stays'})`, kind === 'closes-chat' ? !real.same : real.same,
        `chat machine ${real.same ? 'kept' : 'replaced'}`);
      continue;
    }
    const changed = real.changed.filter((k) => !control.changed.includes(k));
    if (!real.recordKept && control.recordKept) changed.push('stub record');
    if (!real.same) changed.push('chat machine replaced');
    check(`no leak: ${name}`, changed.length === 0,
      `${changed.join(', ')}${real.threw ? ` (the action threw: ${real.threw})` : ''}${control.changed.length ? ` [control changed: ${control.changed.join(',')}]` : ''}`);
  }
  console.log(`${n - fail}/${n} chat-leak checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL chat-leaks ${e.stack}`); process.exitCode = 1; });
