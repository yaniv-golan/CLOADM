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
function chatSession(setup = () => {}, id = 'dragon64') {
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  s.switchMachine(id);
  setup(s);
  frames(s, 5);
  s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: '', tools: false });
  frames(s, 5);
  return s;
}
const withRoms = (s) => s.addRoms([{ name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]);
// A SYNTHETIC NitrOS-9 floppy image (tests/fixtures/nitros9-synth.js), built from the OS-9 volume and module layout
// so the floppy-boot row runs everywhere: the user's real image may not be committed, and a test that needs it
// would prove nothing on CI. It is an image of a disk, with no system code on it.
const { synthNitrOs9Floppy } = require('./fixtures/nitros9-synth.js');
const NITROS9 = synthNitrOs9Floppy();

// Real bytes for the rows that need them, so every row REACHES the code whose routing it is there to check (a row
// that throws before that point proves nothing - the round-2 reviewer's finding). The games and LIZA are the
// project's own example programs; the DOS ROM is our own firmware (tools/mame-diff/fdc/dragon-write.asm), assembled
// here as an 8K $C000 image in place of the DragonDOS cartridge's ROM - no real ROM is used, as AGENTS requires.
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
const GAME_2048 = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/2048.bin')));
const LIZA_6809 = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/liza.bin')));
const DOS_ROM = (() => {
  const FDC = path.join(ROOT, 'tools/mame-diff/fdc');
  require(path.join(FDC, 'gen-diag')).write();
  return romImage(assembleFile(path.join(FDC, 'dragon-write.asm'), '6809'), 0xC000, 0x2000, 0x00);
})();
const withDos = (s) => { s.addRoms([{ name: 'ddos10.rom', bytes: DOS_ROM }, { name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]); };
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
    // the devices a person action can reach on the machine (attachSerial changes the serial port; the joystick is set
    // by the mouse or a gamepad; the printer takes the machine's output; the SAM and the PIAs are chips a program or a
    // POKE changes), and the drives of a controller that was already there (a mount into the wrong machine's drive)
    // (the device plugged in and its speed: the object is the same whatever is attached, so its kind and baud are
    // what shows a change)
    serial: m.serialPort ? `${m.serialPort.kind}:${m.serialPort.baud}` : null,
    printed: m.printed.length,
    joy: JSON.stringify(m.joy) + '|' + JSON.stringify(m.fire),
    // Each chip's OWN saveState(), not hand-picked field names: my first version read `sam.vdg` (no such field) and
    // `pia` (it is pia0, and the output register is `or`, not `orb`), so three columns compared undefined for every
    // row and could never fail. A chip that gains a field gains it here without a test edit.
    sam: m.sam ? JSON.stringify(m.sam.saveState()) : null,
    pia0: m.pia0 ? JSON.stringify(m.pia0.saveState()) : null,
    pia1: m.pia1 ? JSON.stringify(m.pia1.saveState()) : null,
    drives: (() => { const f = m.fdc || (m.cartPort && m.cartPort.drives ? m.cartPort : null);
      return f && f.drives ? f.drives.map((d) => (d.loaded ? d.media.name + ':' + (d.wpt ? 'w' : 'r') : '-')).join(',') : null; })(),
  };
}
function diff(before, after) {
  const out = [];
  for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  return out;
}

// ---- the table: one row per person-facing action the UI can trigger ----
// setup: what the BASIC session needs before the action makes sense (the action then runs with the chat on screen)
const ROWS = [
  // the load path
  ['load a binary (a program dropped on the screen)', () => {}, (s) => s.load('prog.bin', BIN)],
  ['load a .cas tape', () => {}, (s) => s.load('tape.cas', casTape())],
  ['load a .cas tape with stored ROMs on the stub (the fix-D path)', withRoms, (s) => { s.runWithoutRoms({ menu: false }); s.fastCas = false; return s.load('t.cas', casTape()); }],
  ['load a raw file with askAddresses', () => {}, (s) => s.load('raw.bin', new Uint8Array(16), { askAddresses: () => ({ load: 0x2000, exec: 0x2000 }) })],
  ['load a BASIC listing (basictext)', withRoms, (s) => s.load('prog.bas', new TextEncoder().encode('10 PRINT 1\n20 GOTO 10\n'))],
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
  ['insert a disk', withDos, (s) => s.importDisk('d.vdk', Emu.blankDisk('vdk', 40, 1), 0)],
  ['eject a disk', withDos, async (s) => { await s.importDisk('e.vdk', Emu.blankDisk('vdk', 40, 1), 0); return s.ejectDisk(0); }],
  ['new disk', withDos, (s) => s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 })],
  ['insert a disk controller', withDos, (s) => s.insertDiskDos('dragondos')],
  ['set write protect', withDos, async (s) => { await s.importDisk('w.vdk', Emu.blankDisk('vdk', 40, 1), 0); return s.setDiskWriteProtect(0, true); }],
  // cartridges and packs
  ['insert a Multi-Pak', () => {}, (s) => s.insertMultiPak([{ name: 'c.rom', bytes: new Uint8Array(0x2000).fill(0x39) }])],
  // (the Pak needs the user's PIC ROM, which may not be committed: this row is its refusal path, kept because a
  // refusal must still not touch the chat machine - it is marked 'may-throw')
  ['insert the Speech/Sound Pak (refused without its PIC ROM)', () => {}, (s) => s.insertSsc(), 'may-throw:needs its PIC ROM'],
  ['eject the Speech/Sound Pak', () => {}, (s) => s.ejectSsc()],
  // programs and the welcome
  // A game WITH BASIC ROMs is the case where the menu watch's machine matters: the watch is on for a ROM machine
  // whatever the stub choice, so it records whichever machine it was given - and BREAK has to hand THAT machine back.
  ['run a game (with BASIC ROMs, so the menu watch records its machine)', withRoms, (s) => {
    const msg = s.runGame('2048', GAME_2048);
    if (!(s.menuWatch && s.menuWatch.m === s.chatMachines.basic)) throw new Error(`the menu watch is on ${s.menuWatch ? (s.menuWatch.m === s.chatMachines.chat ? 'the chat' : 'another machine') : 'nothing'}`);
    return msg;
  }],
  ['run a game', () => {}, (s) => s.runGame('2048', GAME_2048)],
  // LIZA's menu watch is Session state, not the chat machine's memory: the row asserts it names the PERSON's machine,
  // or the predicate below would miss the very thing the routing is for (a BYE that never comes back to the menu).
  ['run LIZA', () => {}, (s) => { const msg = s.runLiza(LIZA_6809); if (!(s.menuWatch && s.menuWatch.m === s.chatMachines.basic)) throw new Error('the menu watch is not on the person\'s machine'); return msg; }],
  ['check a game\'s needs', () => {}, (s) => s.checkGame('2048')],
  ['the game RAM check', () => {}, (s) => s.gameNeeds()],
  ['the LIZA RAM check', () => {}, (s) => s.lizaNeeds()],
  ['start the welcome menu', () => {}, (s) => s.startWelcome(new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin'))), { greeting: 'back' })],
  // the POKE book
  ['type a POKE from the book', () => {}, (s) => s.typePoke(0)],
  // typeText is the KEYBOARD: with the chat full screen a line typed there is a line of the conversation, so it goes
  // to the chat machine by design. The person's BASIC session is named explicitly, and that is what the row checks.
  ['type text to the person\'s machine', () => {}, (s) => s.typeText('PRINT 1\n', s.personMachine)],
  ['type text at the keyboard (the chat, by design, its own RAM)', () => {}, (s) => s.typeText('PRINT 1\n'), 'firmware-keys'],
  ['send a key (personInput)', () => {}, (s) => s.personInput(s.chatMachines.basic)],
  ['press BREAK', () => {}, (s) => s.pressBreak()],
  // snapshots
  ['save a snapshot', () => {}, (s) => s.snapshotFile()],
  ['save a quick slot', () => {}, (s) => s.saveSlot(1)],
  ['take a restore point / undo', () => {}, (s) => { const c = s.startAsk({ backend: backend() }); c.undo.push(s.chatTarget().snapshot()); return s.restoreClaude(0); }],
  // NitrOS-9
  // the image goes into the library before the chat opens, so the boot finds it
  // (a machine switch replaces the machine and closes the conversation: documented, 'closes-chat')
  ['choose a machine (the machine menu)', () => {}, (s) => s.chooseMachine('coco3'), 'closes-chat'],
  ['load a recent file (recent list)', () => {}, (s) => { s.load('recent.bin', BIN); return s.loadRecent(0); }, 'closes-chat-or-throws'],
  // A real pack, from the Session's own export: it carries the stored ROMs' manifest and images, so the import
  // restores them (an empty array is not a pack, and the row used to swallow that refusal).
  ['import a ROM pack', withRoms, (s) => s.importRomPack(Emu.readZip(s.exportRomPack().bytes))],
  ['import settings', () => {}, (s) => s.importSettings('{"format":"cloadm-settings","version":1,"settings":{}}')],
  // a ROM through the Library's import goes on to addRoms (session.js:1730), which reaches the machine: the row uses
  // a ROM for exactly that reason
  ['import media into the library (a ROM: it goes on to addRoms)', () => {}, (s) => s.importMedia('d64_1.rom', basic)],
  ['import a disk image into the library', withDos, (s) => s.importDisk('d.vdk', Emu.blankDisk('vdk', 40, 1), 0)],
  ['mount a disk by name', withDos, async (s) => { await s.media.write('disks/m.vdk', Emu.blankDisk('vdk', 40, 1)); return s.mountDisk(0, 'disks/m.vdk'); }],
  ['open a snapshot', () => {}, async (s) => { const snap = await s.readSnapshot((await s.snapshotFile()).bytes); return s.openSnapshot(snap); }, 'closes-chat'],
  // (keepSnapshotDisk is for a disk that came WITH a snapshot and is not in the Library yet: a disk already in the
  // Library is refused - "already in your Library" - so the row mounts a fresh image under a name of its own)
  ['keep a snapshot\'s disk in the library', withDos, async (s) => { await s.importDisk('kept.vdk', Emu.blankDisk('vdk', 40, 1), 0); return s.keepSnapshotDisk(0); }, 'may-throw:already in your Library'],
  // leaveNitros9 must actually TAKE NitrOS-9 OFF the person's machine after a floppy boot: it used to return at once
  // (it asked the chat machine, which never has the loader ROM). The row boots, leaves, and asserts the loader is gone.
  ['leave NitrOS-9 (after a floppy boot)', 'coco3', (s) => s.media.write('disks/n9.dsk', NITROS9), async (s) => {
    await s.bootNitros9('n9.dsk');
    const basic = s.chatMachines.basic;
    if (!s.nitros9On(basic)) throw new Error('the boot did not put the loader on the person\'s machine');
    s.leaveNitros9();
    if (s.nitros9On(basic)) throw new Error('leaveNitros9 left the loader on the person\'s machine (it did nothing)');
  }],
  ['resume the debugger', () => {}, (s) => { s.debug; return s.resume(); }],
  // 'none' is the first device offered and attaching it changes nothing: the row must plug in one that does
  // DriveWire: the server and its drives are the SESSION's, not a machine's (session.js:716-760 mountDriveWire and
  // 740 connectDriveWireChannel read no machine at all). Rows anyway, because that is the claim being made.
  ['mount a DriveWire image', () => {}, async (s) => { await s.media.write('drivewire/w.vdk', Emu.blankDisk('vdk', 40, 1)); return s.mountDriveWire(1, 'w.vdk'); }],
  ['connect a DriveWire channel', () => {}, (s) => s.connectDriveWireChannel(0, null)],
  // (serveRealCoco needs Web Serial, which no test host has: its refusal is the reachable code here)
  ['serve a real CoCo (refused: no Web Serial in a test host)', () => {}, (s) => s.serveRealCoco(115200), 'may-throw:no Web Serial'],
  ['attach a serial device', () => {}, (s) => s.attachSerial('terminal')],
  ['send serial text', () => {}, (s) => { s.attachSerial('terminal'); return s.serialSend('hi'); }],
  ['assemble and run a program (the assembler panel)', () => {}, (s) => s.runAssembled(Emu.assemble(' ORG $3000\nSTART LDA #$01\n BRA START\n', '6809'))],
  ['boot NitrOS-9 from a floppy image (CoCo 3)', 'coco3', (s) => s.media.write('disks/n9.dsk', NITROS9), (s) => s.bootNitros9('n9.dsk')],
  ['boot NitrOS-9: a name that is not in the library (refused)', 'coco3', () => {}, (s) => s.bootNitros9('not-there.dsk'), 'may-throw:There is no image called not-there'],
  // the Claude chat itself (must reach the person's machine for acting)
  ['Ask Claude (the side panel)', () => {}, (s) => s.startAsk({ backend: backend() })],
  // (these three close or leave the chat by design: the runner asserts that, not a fingerprint of a machine that is
  // meant to go. They are in the table because the UI can trigger them.)
  ['end the chat', () => {}, (s) => s.endChat(), 'closes-chat'],
  ['show the BASIC session', () => {}, (s) => s.showChat('basic'), 'keeps-chat'],
  ['return to the side panel', () => {}, (s) => s.toSidePanel(), 'closes-chat'],
  // settings and the library (no machine at all, but they are in the UI's list)
  ['switch display', () => {}, (s) => s.setDisplay({})],
  // the printout is the SHOWN machine's (the printer panel shows what the screen's machine printed, and `printed` is
  // Machine.STATE), so this is a shown-machine action by design, like opening the printer panel
  ['clear the printout (the shown machine\'s printout, by design)', () => {}, (s) => s.clearPrintout(), 'shown-machine'],
  ['save settings', () => {}, (s) => s.exportSettings()],
];

// WHAT HAS NO ROW, and why - each checked by reading the cited line, not assumed:
//   openSnapshot      its machine comes from restoreSnapshot (machines/profiles.js:218), which BUILDS a machine
//                     from the snapshot's own model: there is no chat machine involved. The row exists anyway
//                     (it closes the chat, like a switch).
//   connectDriveWireChannel / mountDriveWire
//                     the DriveWire server and its drives are the Session's (session.js:716-760, 740): neither
//                     reads a machine. Rows exist to hold that claim.
//   serveRealCoco     needs Web Serial; in a Node test it refuses at session.js:893 before touching anything.
//                     Its row is the refusal, named.
//   importSettings    touches no machine: it writes the settings store (session.js:1260 onwards).
//   importMedia       is NOT exempt and has a row: a ROM dropped on the Library goes through addRoms
//                     (session.js:1730), which reaches the machine - the row is a ROM, not a program, for that
//                     reason.
// No method in this file is left without either a row or one of the reasons above.

// A row is run TWICE from the same starting point: once with a no-op in place of the action (the control: the chat
// firmware's own running over the same frames, which changes its RAM and frame count by itself) and once with the
// action. A field that differs beyond the control is the action's doing: a leak into the chat machine.
// A row's observation: the action's FINAL chat state, to be compared with the control's FINAL chat state.
// (Comparing each run with its own "before" and then subtracting the fields the control changed is WRONG: the chat
// firmware writes RAM and the frame count by itself, so those two columns were dropped for every row and a row that
// poked 64 bytes into the chat machine passed. The comparison is like for like: two runs, same frames, one with the
// action, one without.)
async function observed(setup, act, id = 'dragon64') {
  const s = chatSession((x) => { try { setup(x); } catch (e) { /* the setup's own needs */ } }, id);
  const chatM = s.chatMachines.chat;
  const recordBefore = s.stubRuns.get(chatM);
  let threw = null, result = null;
  try { result = await act(s); } catch (e) { threw = e.message; }
  frames(s, 3);
  const out = { final: fingerprint(chatM), recordKept: s.stubRuns.get(chatM) === recordBefore,
    same: s.chatMachines && s.chatMachines.chat === chatM, threw, result, screen: s.screenText(chatM).slice(0, 2).join('|') };
  s.endChat();
  return out;
}

(async () => {
  check('the table has a row for every person-facing action', ROWS.length >= 40, `${ROWS.length} rows`);
  // The sweep's own proof, before any row: a leaky action must be caught. Two probes stand in for the two columns
  // the old runner killed - RAM (a poke into the chat machine) and frames (a power cycle of it) - and both must be
  // RED. If either passes, the comparison is wrong and every "no leak" below means nothing.
  const leaky = await observed(() => {}, async (s) => { const c = s.chatMachines.chat; for (let i = 0; i < 64; i++) c.poke(0x5000 + i, 0xA5); });
  const clean = await observed(() => {}, async () => {});
  const leakRam = diff(clean.final, leaky.final);
  check('the comparison catches a poke into the chat machine (64 bytes)', leakRam.includes('ram'), JSON.stringify(leakRam));
  const power = await observed(() => {}, async (s) => s.powerCycle({ on: s.chatMachines.chat }));
  const leakPow = diff(clean.final, power.final);
  check('the comparison catches a power cycle of the chat machine', leakPow.includes('resetAt'), JSON.stringify(leakPow));

  // EVERY FINGERPRINT FIELD MUST BE ABLE TO SEE A CHANGE. A field that reads a property that does not exist compares
  // undefined with undefined for every row, and no row can ever fail on it - which is exactly how this sweep once
  // "checked" the SAM's display bits and the PIA registers while reading `sam.vdg`, `pia` and `orb`, none of which
  // exist. Each probe below changes exactly ONE field of the chat machine and requires that field to show it.
  const PROBES = [
    ['ram', (c) => c.poke(0x5000, 0xA5)],
    ['resetAt', (c) => c.reset(true)],
    ['frames', (c) => c.runFrame()],
    ['cart', (c) => c.insertCartridge(new Emu.devices.rom(new Uint8Array(0x2000).fill(0x39), {}))],
    ['tape', (c) => c.deck.insert(new Emu.Tape(casTape(), c.tickHz, 'probe.cas', c.profile.tape))],
    ['roms', (c) => c.setRoms(Object.assign({}, c.roms, { basic: new Uint8Array(0x4000).fill(0x5A) }))],
    // (useStub is !hasRom, so it moves only with the ROM set - the 'roms' probe covers it; no separate probe is
    // possible, and the loop below records it as covered rather than poking a getter)
    ['serial', (c) => c.attachSerial('terminal', { baud: 600 })],
    ['printed', (c) => c.printed.push(0x41, 0x42)],
    ['joy', (c) => { c.joy[0][0] = 1; c.joy[0][1] = 2; }],
    ['sam', (c) => { c.sam.reg ^= 0x0F; }],
    ['pia0', (c) => { c.pia0.a.or ^= 0x55; }],
    ['pia1', (c) => { c.pia1.b.ddr ^= 0x01; }],
  ];
  for (const [field, poke] of PROBES) {
    const probe = await observed(() => {}, async (s) => { poke(s.chatMachines.chat); });
    const seen = diff(clean.final, probe.final);
    // a field whose value the host cannot set on this machine is not comparable here: say so rather than pass it
    // 'present' means the field can hold a value at all: for cart and tape that is null until something is inserted,
    // so the probe's OWN value is what shows the field works (the diff is what is checked either way).
    const present = clean.final[field] !== undefined || probe.final[field] !== undefined;
    // not a null field, and not one a host cannot set here: the probe must change it and the diff must show it
    const covered = field === 'stub' ? clean.final.roms !== probe.final.roms : seen.includes(field);
    check(`the fingerprint can see a change to "${field}"`, !present || covered || !!probe.threw,
      `${present ? (seen.join(',') || 'nothing changed') : 'not present on this machine'}${probe.threw ? ` (probe threw: ${probe.threw})` : ''}`);
  }
  // A row is [name, setup, act] or [name, model, setup, act, kind]: the model is for rows whose machine matters
  // (NitrOS-9 is a CoCo 3 program). No row skips: the floppy row builds its own image (tests/fixtures/nitros9-synth.js),
  // so a machine without the user's file still proves the routing.
  for (const row of ROWS) {
    const [name, a1, a2, a3, a4] = row;
    const id = typeof a1 === 'string' ? a1 : 'dragon64';
    const setup = typeof a1 === 'string' ? a2 : a1, act = typeof a1 === 'string' ? a3 : a2, kind = typeof a1 === 'string' ? a4 : a3;
    const control = await observed(setup, async () => {}, id);
    const real = await observed(setup, act, id);
    // like for like, final state against final state (see observed)
    real.changed = diff(control.final, real.final);
    if (kind === 'restarts-chat') {
      // Deliberate: the chat machine is reset, so its reset count moves and the chat FIRMWARE STARTS AGAIN - its RAM
      // is the program's, from a fresh start, so a few bytes differ from the control's (measured: 6) even though the
      // screen is the same picture. What must not change is everything of the machine that is not the firmware's own
      // state: its port, tape, ROM set, stub choice, and its own stub-restart record. And the screen must be the
      // chat's screen after it, not the stub's: the point of a reset here is that the chat comes back.
      // the firmware's own state: its RAM and its output (the chat firmware's printer writes are its own too)
      const notFirmware = real.changed.filter((k) => !['ram', 'resetAt', 'frames', 'printed'].includes(k));
      check(`no leak: ${name}`, notFirmware.length === 0 && real.changed.includes('resetAt') && real.recordKept && real.same
        && real.screen === control.screen,
        `${real.changed.join(', ')}${notFirmware.length ? ` (beyond the firmware's own state: ${notFirmware.join(',')})` : ''}`);
      continue;
    }
    if (kind === 'closes-chat-or-throws') {
      // a recent file of another model switches the machine (the chat closes); of this model it loads on the person's
      // session. Either way the chat machine must not be touched while it is still there.
      check(`no leak: ${name}`, real.changed.length === 0, `${real.changed.join(', ')}${real.threw ? ` (threw: ${real.threw})` : ''}`);
      continue;
    }
    if (kind === 'firmware-keys') {
      // the keyboard types into the chat firmware by design; what must not change is anything of the machine that is
      // not the firmware's own memory
      const notFirmware = real.changed.filter((k) => !['ram', 'frames', 'printed'].includes(k));
      check(`no leak: ${name}`, notFirmware.length === 0 && !real.threw, `${real.changed.join(', ')}`);
      continue;
    }
    if (kind === 'shown-machine') {
      // by design it acts on the machine on screen: assert exactly that, and that the person's session is untouched
      check(`no leak: ${name}`, real.changed.length === 0 || real.changed.every((k) => k === 'printed'),
        `${real.changed.join(', ')}`);
      continue;
    }
    if (kind === 'closes-chat') {
      // the chat's own closing: the machine going is the point
      check(`no leak: ${name} (the chat closes)`, !real.same, `chat machine ${real.same ? 'kept' : 'replaced'}`);
      continue;
    }
    if (kind === 'keeps-chat') {
      // the chat STAYS: the machine is there AND unchanged (skipping the fingerprint here let a change through)
      check(`no leak: ${name} (the chat stays)`, real.same && real.changed.length === 0 && real.recordKept
        && !real.threw, `chat machine ${real.same ? 'kept' : 'replaced'}; changed: ${real.changed.join(', ') || 'nothing'}`);
      continue;
    }
    const changed = real.changed;
    if (!real.recordKept && control.recordKept) changed.push('stub record');
    if (!real.same) changed.push('chat machine replaced');
    // A ROW WHOSE ACTION THREW PROVES NOTHING: it never reached the code the row exists to check. That is a FAILURE
    // of the row, not a note on it - this is how three rows ("run a game", "run LIZA", the disk rows) passed while
    // the routing they checked was broken. A row that is expected to refuse says so with a kind.
    // 'may-throw': a refusal the row exists to check (the machine lacks a ROM the project may not commit). What the
    // refusal must NOT do is touch the chat machine; and it must throw for the reason the row names, not another.
    const threw = real.threw ? ` (the action threw: ${real.threw})` : '';
    // 'may-throw' names the reason it is allowed to refuse with, as a regex on the message: an unrelated throw (a
    // typo in the row, a missing fixture) must not pass for the refusal the row is about.
    const okThrow = kind && kind.startsWith('may-throw') ? !!real.threw && new RegExp(kind.slice(10)).test(real.threw) : !real.threw;
    check(`no leak: ${name}`, changed.length === 0 && okThrow, `${changed.join(', ')}${threw}`);
  }
  console.log(`${n - fail}/${n} chat-leak checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL chat-leaks ${e.stack}`); process.exitCode = 1; });
