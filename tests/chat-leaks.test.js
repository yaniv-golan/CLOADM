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
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
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
function chatSession(setup = () => {}, id = 'dragon64', panel = false) {
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  s.switchMachine(id);
  const r = setup(s);
  if (r && typeof r.then === 'function') s.setupPromise = r;
  frames(s, 5);
  // panel: the side-panel chat (Ask Claude), which has no chat machine - its target is the machine in use. Rows that
  // need Claude to be pausable use it, because pausing is only possible when Claude acts on the keyed machine.
  if (panel) s.startAsk({ backend: backend() });
  else s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: '', tools: false });
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
  // (the Pak needs the user's PIC ROM, so it cannot be put IN here: this row is what eject does when it is out, and
  // asserts that answer - it returns a sentence, it does not throw)
  ['eject the Speech/Sound Pak (not in)', () => {}, (s) => { if (!/not in/.test(s.ejectSsc())) throw new Error('eject did not say the Pak is not in'); }],
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
  // personInput pauses Claude only when Claude is acting on the machine the key went to. That is a side-panel chat
  // (its target IS the person's machine); its two real fields are claudeActing and chat.busy, both plain state the
  // gate sets - so the row sets them and asserts the pause, rather than calling with nothing acting and "passing".
  ['send a key (personInput): Claude is acting on that machine, and pauses', () => {
    // (a side-panel chat: no chat machine, so chatTarget is the person's machine)
  }, (s) => {
    s.claudeActing = true; s.chat.busy = true;   // (the state the gate leaves while Claude acts)
    const r = s.personInput(s.personMachine);
    if (r !== true || !s.claudePaused) throw new Error('personInput did not pause Claude');
  }, 'panel'],
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
  // keepSnapshotDisk is for a disk that came WITH a snapshot (not linked to the Library): unlink the imported one so
  // the row reaches the save, then assert the drive is linked to the Library afterwards.
  // a disk that came WITH a snapshot is not in the Library at all (no stored image, no link): remove the import from
  // the store first, so the row reaches the save body instead of the "already in your Library" guard.
  ['keep a snapshot\'s disk in the library', withDos, async (s) => {
    await s.importDisk('kept.vdk', Emu.blankDisk('vdk', 40, 1), 0);
    const fdc = s.diskControllerOf(s.chatMachines.basic), d = fdc.drives[0];
    d.media.onWrite = null;
    await s.media.remove('disks/kept.vdk');
    const msg = await s.keepSnapshotDisk(0);
    if (!d.media.onWrite) throw new Error('the disk was not saved and linked');
    return msg;
  }],
  // leaveNitros9 must actually TAKE NitrOS-9 OFF the person's machine after a floppy boot: it used to return at once
  // (it asked the chat machine, which never has the loader ROM). The row boots, leaves, and asserts the loader is gone.
  ['leave NitrOS-9 (after a floppy boot)', 'coco3', (s) => s.media.write('disks/n9.dsk', NITROS9), async (s) => {
    await s.bootNitros9('n9.dsk');
    const basic = s.chatMachines.basic;
    if (!s.nitros9On(basic)) throw new Error('the boot did not put the loader on the person\'s machine');
    s.leaveNitros9();
    if (s.nitros9On(basic)) throw new Error('leaveNitros9 left the loader on the person\'s machine (it did nothing)');
  }],
  ['resume the debugger (stopped, then resumed)', () => {}, (s) => { const d = s.debug; d.halt(); if (!d.stopped) throw new Error('the debugger did not stop'); s.resume(); if (d.stopped) throw new Error('resume left the debugger stopped'); }],
  // 'none' is the first device offered and attaching it changes nothing: the row must plug in one that does
  // DriveWire: the server and its drives are the SESSION's, not a machine's (session.js:716-760 mountDriveWire and
  // 740 connectDriveWireChannel read no machine at all). Rows anyway, because that is the claim being made.
  ['mount a DriveWire image', () => {}, async (s) => { await s.media.write('drivewire/w.vdk', Emu.blankDisk('vdk', 40, 1)); return s.mountDriveWire(1, 'w.vdk'); }],
  ['disconnect a DriveWire channel', () => {}, (s) => { s.connectDriveWireChannel(0, null); return s.connectDriveWireChannel(0, null); }],
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
  ['flush the disks (the page does this on a hide)', () => {}, (s) => s.flushDisks()],
  ['read the POKE book (and type one)', () => {}, (s) => { const b = s.pokeBook(); if (!b.length) throw new Error('no POKE book'); return s.typePoke(0); }],
  ['restore a quick-save slot', () => {}, async (s) => { await s.saveSlot(1); return s.restoreSlot(1); }],
  // after a floppy boot on the person's machine, with the chat on screen, the NitrOS-9 state that the PANEL reads
  // must say it is running - otherwise the panel hides Leave and the fix is unreachable from the page
  ['add and boot a NitrOS-9 image (and the panel-side state says it runs)', 'coco3', () => {}, async (s) => {
    await s.addAndBootNitros9('n9.dsk', NITROS9);
    if (!s.nitros9Running) throw new Error('nitros9Running is false with the chat open: the panel would hide Leave');
    s.leaveNitros9();
    if (s.nitros9Running) throw new Error('still running after leave');
  }],
  // Share pairs a picture of the machine ON SCREEN with a link to that machine (shareUrl). With the chat open after a
  // floppy boot, the person's nitros9Running is true but the SHOWN machine's is not: the link must describe the chat
  // machine, as its picture does. This row asserts the shown-machine getter both ways.
  ['Share: the shown machine\'s NitrOS-9, not the person\'s', 'coco3', (s) => s.media.write('disks/n9.dsk', NITROS9), async (s) => {
    await s.bootNitros9('n9.dsk');
    if (!s.nitros9Running) throw new Error('the person\'s NitrOS-9 is not reported');
    if (s.chatMachines && s.nitros9OnScreen) throw new Error('the SHOWN machine claims NitrOS-9 it does not run');
  }],
  // the welcome getters: the person's machine and the shown one, which differ while the chat is open
  ['the welcome state speaks for the person\'s machine and the shown one separately', () => {}, (s) => {
    const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));
    s.startWelcome(welcome, { greeting: 'back' });
    if (!s.welcomeRunning) throw new Error('welcomeRunning is false on the person\'s machine');
    if (s.welcomeRunningOn) throw new Error('welcomeRunningOn claims the CHAT machine runs the menu');
  }],
  // The welcome program's own two actions, with audio already unlocked and the chat on screen (the page reaches this
  // through welcome.js after an audio unlock). Both poked this.machine - the CHAT - while the gate was the person's
  // machine, so the sweep missed it: no row had set welcomeSoundOn. The bytes are asserted DIRECTLY, on both machines,
  // because the chat's own frames redraw its screen: a RAM fingerprint would show noise either way.
  ['the welcome program\'s sound goes to the person\'s machine', () => {}, (s) => {
    const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));
    s.startWelcome(welcome, { greeting: 'back' });
    s.welcomeSoundOn = true;
    const chat = s.chatMachines.chat, at = s.welcomeBuild.soundOk;
    // the two are different objects (a row that wrote through `s.welcome` while asserting on `chat` would pass on
    // anything); the chat-side half catches a write to the SAME offset on the chat machine, which is the shape the
    // fix is about. (It runs no frame, like every row: the sweep's control run has the chat's own running, so a
    // frame here would show up in the fingerprint as noise.)
    if (chat === s.welcome) throw new Error('the chat machine and the person\'s machine are one object: the row proves nothing');
    const was = chat.ram[at];
    s.welcomeSound();
    if (chat.ram[at] !== was) throw new Error('the sound byte was written into the CHAT machine');
    if (s.welcome.ram[at] !== 1) throw new Error('the sound byte was not written into the person\'s machine');
  }],
  ['the welcome program\'s key mailbox is the person\'s machine', () => {}, (s) => {
    const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));
    s.startWelcome(welcome, { greeting: 'back' });
    // the person's machine posts a key the way the program does; flushWelcome must read and clear THAT one
    const chat = s.chatMachines.chat, at = s.welcomeBuild.event;
    if (chat === s.welcome) throw new Error('the chat machine and the person\'s machine are one object');
    s.welcome.poke(at, 2);
    const chatWas = chat.ram[at];
    s.flushWelcome();
    if (s.welcome.peek(at) !== 0) throw new Error('the key was not cleared on the person\'s machine');
    if (chat.ram[at] !== chatWas) throw new Error('the key was written to the CHAT machine');
  }],
  ['switch display (composite, then back)', () => {}, (s) => { const was = s.display.view; const other = was === 'crt' ? 'sharp' : 'crt'; s.setDisplay({ view: other }); if (s.display.view === was) throw new Error('the display did not change'); s.setDisplay({ view: was }); }],
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
//   serveRealCoco     needs Web Serial; in a Node test it refuses when the link is opened (session.js:901,
//                     `await link.open(baud)`), before any machine is touched. Its row is the refusal, named.
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
async function observed(setup, act, id = 'dragon64', panel = false) {
  // a setup that throws is a failure of the ROW (it did not get the state it asked for): collected and failed below
  const setupErrorBox = { error: null };
  // the wrapper RETURNS the setup's value (a promise for an async setup) so chatSession can hand it back;
  // chatSession is what knows it, so it is read from there
  const s = chatSession((x) => { try { return setup(x); } catch (e) { setupErrorBox.error = e.message; } }, id, panel);
  // (a setup may be async - mounting, importing: its work and its throw would land after the row was observed)
  if (s.setupPromise) { try { await s.setupPromise; } catch (e) { setupErrorBox.error = e.message; } }
  const setupError = setupErrorBox.error;
  const chatM = s.chatMachines ? s.chatMachines.chat : s.shownMachine;   // (a panel session has no chat machine)
  const recordBefore = s.stubRuns.get(chatM);
  let threw = null, result = null;
  try { result = await act(s); } catch (e) { threw = e.message; }
  frames(s, 3);
  // three separate facts, so a panel session and a closed chat are not confused: was there a chat, is the same
  // machine still behind it, and did the action throw
  const out = { setupError, final: fingerprint(chatM), recordKept: s.stubRuns.get(chatM) === recordBefore,
    same: s.chatMachines ? s.chatMachines.chat === chatM : false, threw, result,
    screen: s.screenText(chatM).slice(0, 2).join('|'), panel };
  s.endChat();
  return out;
}

// THE TWO ACCESSORS, ENFORCED. Inside the Session and in every page module a bare `this.machine` or
// `session.machine` does not exist: the field is `_shown` on the Session, and the only names for a machine are
// shownMachine (the machine ON SCREEN: the picture, the keyboard, the frame loop, a debugger) and personMachine (the
// PERSON's own work: files, ROMs, the POKE book, the welcome program, LIZA, disks). This is the bug class of the whole
// branch: a person-framed gate paired with a shown-machine action (welcomeSound poked this.machine while its gate was
// welcomeRunning, which means the person's machine).
//
// The scan is textual on purpose: it catches the shape a person writes, not the shape a parser sees. Over the
// Session it reads the class's own body; over the page modules it reads every way a module can hold the Session or
// the Page (the destructured `{ session } = page`, an alias `const x = session`, and one handed in as a parameter
// named `session`/`s`/`page`). On those two objects the only machine name is one of the two accessors, so a bare
// `.machine` on one of them is the raw use. What it must NOT flag is a plain object's own field (a snapshot's
// { machine }, roms.js's target { machine }, a step's { machine }) or an element's dataset.machine; those names are
// listed in NOT_A_SESSION per file with the reason, so a new one cannot join the list without being seen here.
//
// THE BOUNDARY. This is a textual scan, and it has a written, measured edge. It sees a use only when the Session or
// the Page is reached through a NAME it learned (see `holders` below) and the machine is then named `.machine` or
// `._shown`. What it does NOT catch, each one measured to stay green on the tree this comment was written against
// (the probe planted the shape in a real file and the suite still reported 96/96; the two known-caught controls in
// that probe, `this._shown` and `page.session._shown`, do fail, so the probe itself works):
//   * `this?._shown` and `this['_shown']` - the bracket/optional forms are matched for `.machine`, not for `_shown`;
//   * `const { _shown } = this` - a destructure of the backing field inside the Session body;
//   * `const self = this; self._shown` - `this` itself is never learned as a holder;
//   * `const sess = page.session; sess._shown` (and `sess.machine`) - `page.session` does not make `sess` a holder:
//     the alias rule reads `= session` / `= page`, not a member of one;
//   * `const k = '_shown'; session[k]` - a computed key is only reported when it is not a plain identifier, so a
//     variable holding the name is skipped (a string literal, `session['_shown']`, IS caught);
//   * `const { _shown: mm } = this.session` and `const { machine } = this.session` in embed-api, and
//     `const { machine } = session` in cli - a destructure is only learned when the right side is the bare word
//     `session`/`page`, not `this.session`;
//   * a Session handed to a function through a PARAMETER of an arbitrary name (`const spill = (sess) => sess.machine`)
//     - a parameter's type is not in the text, and `function open(snap)` shows why guessing "any parameter" would
//     flag plain records;
//   * `Reflect.get(session, 'machine')` / `Object.getOwnPropertyDescriptor`, where the field name is a string
//     argument to a general helper.
// None of those shapes exists in the scanned set today (grep, and the suite green over it). What it DOES catch, all
// pinned by a case in this file: `.machine`, `?.machine`, `['machine']`, `` [`machine`] ``, a computed key whose key
// is not a plain identifier, an alias of the Session or the Page (layered, renamed, comma-only), a renamed
// destructure from a bare `session`/`page`, `._shown` on a learned holder, and a bare `this.machine` or
// `this._shown` in the Session body. Widening it to the rest is a follow-up branch, not this one.
const SESSION_BODY = 'js/session.js';
const PAGE_MODULES = [SESSION_BODY];
for (const f of fs.readdirSync(path.join(ROOT, 'js/ui')).filter((n) => n.endsWith('.js')).sort()) PAGE_MODULES.push(`js/ui/${f}`);
for (const f of ['js/embed-api.js', 'js/mcp/tools.js', 'cli/cloadm.js', 'tools/browser-check.js']) PAGE_MODULES.push(f);
// the claude.ai side panel's own page: it holds one Session and no chat, but it reads the machine the same way, and
// it was outside this scan when main brought it in (it kept a raw session.machine and threw once the field went).
for (const f of fs.readdirSync(path.join(ROOT, 'connector/view')).filter((n) => n.endsWith('.js'))) PAGE_MODULES.push(`connector/view/${f}`);
PAGE_MODULES.push('tools/connector-check.js');
// names whose `.machine` is NOT the Session's or the Page's, per file, with the reason
const NOT_A_SESSION = new Map([
  // a tape recording's record: `r` is a plain { machine: the machine's profile name, blocks }, not a Session
  ['js/ui/media-panel.js', new Set(['r'])],
  // a switch offer: `sw` is a plain { machine: the snapshot's machine id, config, text } (Session.snapshotSwitch)
  ['js/ui/snapshot-panel.js', new Set(['sw'])],
  // the recent-media row and the welcome shelf's record: `r.machine` is a stored entry's machine id, not a Session
  ['js/ui/drawer.js', new Set(['r'])],
]);
function sessionMachineUses() {
  const out = [];
  const src = fs.readFileSync(path.join(ROOT, SESSION_BODY), 'utf8').split('\n');
  const cls = src.findIndex((l) => /^export class Session\b/.test(l));
  src.forEach((line, i) => {
    if (i < cls) return;                                  // SnapshotRomsError is above the class: its field is its own
    const code = line.replace(/\/\/.*$/, '');             // (a use named in a comment is not a use)
    for (const m of code.matchAll(/\bthis\.machine\b/g)) out.push(`${SESSION_BODY}:${i + 1}`);
    // the backing field is the accessors' own: any other `this._shown` in the class is a use that skipped them
    for (const m of code.matchAll(/\bthis\._shown\b/g)) {
      const ok = /^\s*(get|set) shownMachine\b/.test(line) || /^\s*this\._shown = null;/.test(line);
      if (!ok) out.push(`${SESSION_BODY}:${i + 1} (this._shown)`);
    }
  });
  return out;
}
function pageMachineUses() {
  const out = [];
  for (const f of PAGE_MODULES) {
    if (f === SESSION_BODY) continue;
    // block comments removed (line numbers kept): a shape named in a comment is not a use. `//` comments are
    // stripped per line below.
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const src = raw.split('\n');
    // Every name a Session or the Page can be held under, learned from the source to a FIXPOINT (an alias of an
    // alias counts, whichever order the lines are in). The shapes the adversarial review of 4018753 named, each one
    // it showed green: a RENAMED destructure (`const { session: sess2 } = page`), `s = window.emu.session`, and a
    // layered alias. `s` is NOT assumed to be a Session (page.js's onStep uses `s` for a history state): it is a
    // holder only where the source says so.
    // The limit of this learning, measured and listed under THE BOUNDARY above: an alias must be a BARE name on the
    // right (`= session`, `= page`, `= anAlias`), or a destructure from a bare `session`/`page`. `page.session` and
    // `this.session` do NOT make the left side a holder, so `sess = page.session; sess.machine` is missed.
    const holders = new Set(['session', 'page']);
    for (let pass = 0, grew = true; grew; pass++) {
      grew = false;
      const add = (n) => { if (n && !holders.has(n)) { holders.add(n); grew = true; } };
      for (const line of src) {
        // const x = session | page | page.session | window.emu.session  (whitespace or a line end after it, so
        // `session.media` is not read as a bare `session`)
        // (anywhere in a declaration list: `const s = window.emu.session, d = s.display` - the comma after is legal)
        for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?(?:emu\.)?(?:session|page)\b/g)) {
          // the word after it must END the expression: `,` `;` `)` end of line, or a newline; `session.media` does not
          const after = line.slice(m.index + m[0].length, m.index + m[0].length + 1);
          if (after === '' || /[,;)\n]/.test(after)) add(m[1]);
        }
        for (const m of line.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?(?:emu\.)?(?:session|page)\b/g)) {
          const after = line.slice(m.index + m[0].length, m.index + m[0].length + 1);
          if (after === '' || /[,;)\n]/.test(after)) add(m[1]);
        }
        // an alias of an alias: const x = y, or const x = y, z = ...  (the right side is a BARE name: a call or a
        // member expression there is not an alias of the Session)
        for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[,;)]/g)) if (holders.has(m[2])) add(m[1]);
        // const { session } = page, const { session: sess2 } = page
        for (const m of line.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:page|session)\b/g)) {
          for (const part of m[1].split(',')) {
            const bits = part.trim().split(/[:=]/).map((x) => x.trim());
            add(bits.length > 1 && bits[1] ? bits[1] : bits[0]);     // (the RENAME when there is one)
          }
        }
      }
    }
    const allow = NOT_A_SESSION.get(f) || new Set();
    src.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      // the reach forms: x.machine, x?.machine, and x['machine'] / x[`machine`] / x["machine"]
      const forms = [
        ...code.matchAll(/\b([A-Za-z_$][\w$]*)\??\.machine\b/g),
        ...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[\s*['"`]machine['"`]\s*\]/g),
      ];
      for (const m of forms) {
        if (!holders.has(m[1]) || allow.has(m[1])) continue;
        out.push(`${f}:${i + 1} (${m[0]})`);
      }
      // a COMPUTED key on a Session/Page (`session['ma' + 'chine']`) cannot be read textually as the name it makes:
      // any bracket access on one whose key is not a plain identifier is reported instead, since the scan cannot say
      // what it reaches. (`session[x]` and `session['a' + 'b']` both land here; `session['machine']` is caught above.)
      // The `continue` below SKIPS a plain identifier key, on the assumption that `session[x]` is an array. When `x`
      // holds a machine's field name (`const k = '_shown'; session[k]`) that assumption is wrong, and the use is
      // missed - measured, see THE BOUNDARY above. A string literal in the brackets is still caught by the form above.
      for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[\s*([^\]]+?)\s*\]/g)) {
        if (!holders.has(m[1]) || allow.has(m[1])) continue;
        if (/^[A-Za-z_$][\w$]*$/.test(m[2])) continue;     // session[length]: an array, not this object
        out.push(`${f}:${i + 1} (${m[1]}[computed])`);
      }
    });
    // a Session/Page read as `_shown` (the backing field) in a page module is the same raw reach as `.machine`
    src.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\??\._shown\b/g)) {
        if (holders.has(m[1]) && !allow.has(m[1])) out.push(`${f}:${i + 1} (${m[1]}._shown)`);
      }
    });
  }
  return out;
}
function rawMachineUses() { return [...sessionMachineUses(), ...pageMachineUses()]; }

// Every Session method the UI CALLS must have a row or a written reason, DERIVED from js/ui/*.js rather than listed
// here by hand: a method added to a panel and called there is caught the moment it appears, which a hand-written
// claim of "full coverage" cannot do (it was wrong twice).
//
// The reasons are by KIND of method, not per method, so a new one falls into one:
//   READ      a getter or a pure query: it returns a value and changes nothing, so it cannot leak.
//   LIBRARY   it writes the media store or the settings store only (no machine).
//   SESSION   it changes Session state that belongs to no machine (the chat, the display, a channel).
//   UI        it is a page concern (visit, error text), not an action on a machine.
//   ROW       it has a row in ROWS.
const UI_DIR = path.join(ROOT, 'js/ui');
function uiCalledMethods() {
  const out = new Map();   // name -> file:line of the first mention
  for (const f of fs.readdirSync(UI_DIR).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(UI_DIR, f), 'utf8').split('\n');
    src.forEach((line, i) => {
      // CALLS and READS alike: a getter that means the wrong machine is the nitros9Running class of bug, and reading
      // `session.x` is how a panel uses one. The shapes the reviewer named must not slip past silently:
      // session?.x(), session['x'], and a destructured `{ x } = session`: each is an ERROR below, not a silent miss.
      for (const m of line.matchAll(/\bsession\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) if (!out.has(m[1])) out.set(m[1], `${f}:${i + 1}`);
      for (const m of line.matchAll(/\bsession\s*\[\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\]/g)) out.set(`[${m[1]}]`, `${f}:${i + 1}`);
      for (const m of line.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*session\b/g)) out.set(`{${m[1].trim()}}`, `${f}:${i + 1}`);
    });
  }
  return out;
}
// the methods with a row: the act of every row, by the Session member it calls
function rowMethods() {
  const out = new Set();
  // every function in the row (setup and act alike): the point is which Session methods a row exercises, and both
  // do - a setup that calls a method is also coverage of it
  for (const row of ROWS) {
    for (const fn of row.filter((x) => typeof x === 'function')) {
      for (const m of String(fn).matchAll(/\bs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) out.add(m[1]);
    }
  }
  return out;
}

(async () => {
  check('the table has a row for every person-facing action', ROWS.length >= 40, `${ROWS.length} rows`);
  // ---- the two accessors: no raw machine reach in the Session or a page module ----
  const raw = rawMachineUses();
  check('no raw this.machine / session.machine (shownMachine or personMachine, each saying which)', raw.length === 0, raw.join(', '));
  // ---- coverage: every Session method the UI calls is a row, or classified ----
  // (names verified to be reads/pure by reading their bodies; a name that is wrong here shows as an unknown method)
  const READ = new Set(['advance', 'besideMachine', 'blankDiskChoices', 'bootStatus', 'checkGame', 'checkLiza',
    'checkNotInDrive', 'codeAt', 'cpuRate', 'diskActivity', 'diskDosChoices', 'diskStatus', 'driveWireFile',
    'driveWireImages', 'gameFile', 'inspect', 'listDisks', 'listMedia', 'listSlots', 'lizaNeeds', 'machineRoms',
    'machineTicket', 'machinesWithRoms', 'nitros9Images', 'nitros9Loader', 'nitros9On', 'printoutFile', 'printoutText',
    'readSlot', 'readSnapshot', 'readSnapshotLink', 'recentMedia', 'sameName', 'savedConfig', 'screenText',
    'shareFile', 'shareUrl', 'slotBytes', 'snapshotLink', 'snapshotRoms', 'snapshotSwitch', 'sscRoms', 'statusLine',
    'takenOut', 'tapeStatus', 'terminalText', 'welcomeFile', 'welcomeRunning', 'preferredDiskDos', 'storedRoms',
    // (main 1dd66fa: all four are reads/pure. indexWriteError formats a stored-write error; tapeRunning reads the
    // PERSON's deck motor flag; screenAlternative describes the SHOWN screen's text; welcomeGenNow reads the ticket)
    'indexWriteError', 'tapeRunning', 'screenAlternative', 'welcomeGenNow',
    'pickNitros9Image', 'openMedia', 'downloadMedia', 'downloadDisk', 'diskWritesDone', 'printoutFile',
    // programControls reads the menu watch of the SHOWN machine: the touch panel it answers drives what is on screen
    'programControls',
    // claudeLink builds the "Ask Claude ↗" link from shareFile and shareUrl (both reads of the shown machine)
    'claudeLink']);
  // writes the library or settings only
  const LIBRARY = new Set(['addRoms', 'clearRoms', 'deleteMedia', 'importDriveWireImage', 'importMedia',
    'importSettings', 'listMedia', 'moveMedia', 'newDriveWireImage', 'renameMedia', 'exportRomPack', 'exportSettings',
    'setClaudeKey', 'clearClaudeKey', 'setClaudeAllowed', 'setLastRun', 'useMediaStore']);
  // Session state that belongs to no machine
  const SESSION = new Set(['answerClaude', 'clearTerminal', 'welcomeSound', 'asMachine', 'connectDriveWireChannel', 'ejectDriveWire', 'endChat', 'emit',
    'on', 'personInput', 'ready', 'reset', 'resume', 'resumeClaude', 'setDisplay', 'startAsk', 'startChat', 'stopClaude',
    'stopRealCoco', 'toSidePanel', 'showChat', 'watchForMenu',
    // chatNote writes a line to the chat channel (the chat firmware's screen), never to the person's machine
    'chatNote']);
  // page concerns, not machine actions
  const UI = new Set(['mediaError', 'visit']);
  const rows = rowMethods();
  const called = uiCalledMethods();
  // a shape the scan does not understand must FAIL, not vanish: an unclassified reading is exactly what this catches
  const oddShapes = [...called].filter(([n]) => n.startsWith('[') || n.startsWith('{'));
  check('the coverage scan understands every way the UI reaches the Session', oddShapes.length === 0,
    oddShapes.map(([n, at]) => `${n} (${at}): use session.x, not a computed key or a destructured alias`).join(', '));
  // Session members whose puppets the UI drives: the MEMBER is classified, and the puppet is covered by that (the
  // reason is written where its reachability is decided). debug: opening the Debugger view closes the chat BEFORE
  // the view's handler builds anything (page.onView's beforeView, js/ui/claude.js), so the debugger is never built on
  // the chat machine - and tests/view-order.test.js pins that order.
  // Setters/plain Session fields and page-facing state: they hold no machine of their own (or hold both machines
  // explicitly, like chatMachines), so reading them cannot reach the wrong one.
  for (const n of ['js', 'constructor', 'claudeView', 'chatView', 'claudePaused', 'claudeAllowed', 'claudePending',
    'claudeActing', 'claudeStatus', 'claudePoints', 'claudeGate', 'keyStore', 'chatMachines', 'hasClaudeKey',
    'chatPromptEmpty', 'labels', 'turbo', 'fastCas', 'fastTape', 'unsavedRecording', 'menuTicket', 'carryOn',
    'lastRun', 'welcomeMenu', 'startMachine', 'caseInsensitive', 'webSerialAvailable', 'realCoco', 'driveWireMounts',
    'driveWireChannels', 'hasAnyRoms', 'hasMultiPak', 'claudeBusyActing', 'lizaFile', 'cartBoard', 'paused', 'display', 'debugger', 'stubRun',
    'stubChosen', 'serialDevice', 'offersSsc', 'tapeRecording', 'personMachine', 'shownMachine', 'nitros9Running', 'nitros9OnScreen',
    'hasArtifactPhase', 'hasTwoScreens', 'welcomeRunning', 'welcomeRunningOn']) SESSION.add(n);
  // Puppets whose reachability is decided where they live (see the note above): debug (the Debugger view closes the
  // chat, claude.js:283-286), chat (the ChatSession, not a machine), store/roms/index/media/keys/machine (the
  // Session's own services).
  const OPAQUE = new Set(['debug', 'chat', 'store', 'roms', 'index', 'media', 'keys']);
  const missing = [...called].filter(([name]) => !rows.has(name) && !READ.has(name) && !LIBRARY.has(name)
    && !SESSION.has(name) && !UI.has(name) && !OPAQUE.has(name));
  check('every Session member the UI calls or reads has a row or a written reason', missing.length === 0,
    missing.map(([n, at]) => `${n} (${at})`).join(', '));

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
    check(`the fingerprint can see a change to "${field}"`, (!present || covered) && !probe.threw,
      `${present ? (seen.join(',') || 'nothing changed') : 'not present on this machine'}${probe.threw ? ` (probe threw: ${probe.threw})` : ''}`);
  }
  // A row is [name, setup, act] or [name, model, setup, act, kind]: the model is for rows whose machine matters
  // (NitrOS-9 is a CoCo 3 program). No row skips: the floppy row builds its own image (tests/fixtures/nitros9-synth.js),
  // so a machine without the user's file still proves the routing.
  for (const row of ROWS) {
    const [name, a1, a2, a3, a4] = row;
    const id = typeof a1 === 'string' ? a1 : 'dragon64';
    const setup = typeof a1 === 'string' ? a2 : a1, act = typeof a1 === 'string' ? a3 : a2, kind = typeof a1 === 'string' ? a4 : a3;
    const panel = kind === 'panel';
    const control = await observed(setup, async () => {}, id, panel);
    const real = await observed(setup, act, id, panel);
    // like for like, final state against final state (see observed)
    real.changed = diff(control.final, real.final);
    // ---- ONE GATE FOR EVERY KIND, before any kind's own assertion ----
    // A row's proof is worthless without these, and every kind used to repeat them (or forget them: an injected
    // "endChat(); throw" passed under closes-chat, and a throwing setup passed under all seven named kinds).
    //   * the setup must not have thrown (the row never got the state it asked for; async setups are awaited by
    //     observed());
    //   * a throw is a failure, unless the kind is may-throw:<regex> and the message matches that NON-EMPTY regex.
    const setupThrew = real.setupError || control.setupError;
    const mayThrow = kind && kind.startsWith('may-throw') ? kind.slice('may-throw:'.length) : null;
    const throwOk = mayThrow ? (mayThrow.length > 0 && !!real.threw && new RegExp(mayThrow).test(real.threw)) : !real.threw;
    const gate = [];
    if (setupThrew) gate.push(`the setup threw: ${setupThrew}`);
    if (!throwOk) gate.push(real.threw ? `an unnamed throw: ${real.threw}` : mayThrow ? `expected a throw matching /${mayThrow}/, none` : '');
    const gateFail = gate.filter(Boolean);

    if (kind === 'restarts-chat') {
      // deliberate: the chat machine is reset, so its reset count moves and the chat FIRMWARE STARTS AGAIN - its RAM
      // is the program's, from a fresh start. What must not change is everything of the machine that is not the
      // firmware's own state, and the screen must be the chat's after it, not the stub's.
      const notFirmware = real.changed.filter((k) => !['ram', 'resetAt', 'frames', 'printed'].includes(k));
      check(`no leak: ${name}`, notFirmware.length === 0 && real.changed.includes('resetAt') && real.recordKept && real.same
        && real.screen === control.screen && gateFail.length === 0,
        `${real.changed.join(', ')}${notFirmware.length ? ` (beyond the firmware's own state: ${notFirmware.join(',')})` : ''}${gateFail.join('; ')}`);
      continue;
    }
    if (kind === 'closes-chat-or-throws') {
      check(`no leak: ${name}`, real.changed.length === 0 && real.recordKept && gateFail.length === 0,
        `${real.changed.join(', ')}${gateFail.join('; ')}`);
      continue;
    }
    if (kind === 'firmware-keys') {
      // the keyboard types into the chat firmware by design; what must not change is anything of the machine that is
      // not the firmware's own memory
      const notFirmware = real.changed.filter((k) => !['ram', 'frames', 'printed'].includes(k));
      check(`no leak: ${name}`, notFirmware.length === 0 && gateFail.length === 0, `${real.changed.join(', ')}${gateFail.join('; ')}`);
      continue;
    }
    if (kind === 'shown-machine') {
      // by design it acts on the machine on screen: assert exactly that, and that the person's session is untouched
      check(`no leak: ${name}`, (real.changed.length === 0 || real.changed.every((k) => k === 'printed')) && gateFail.length === 0,
        `${real.changed.join(', ')}${gateFail.join('; ')}`);
      continue;
    }
    if (kind === 'shown-nitros9') {
      // the SHOWN machine's NitrOS-9 state (Share): the row asserts, as it runs, that the shown machine's answer is
      // right; nothing must be written to it
      check(`no leak: ${name}`, gateFail.length === 0, gateFail.join('; '));
      continue;
    }
    if (kind === 'panel') {
      // no chat machine exists in this session: the row's own assertions (in the action) are the whole check
      check(`no leak: ${name}`, gateFail.length === 0, gateFail.join('; '));
      continue;
    }
    if (kind === 'closes-chat') {
      // the chat's own closing: the machine going is the point
      check(`no leak: ${name} (the chat closes)`, !real.same && gateFail.length === 0,
        `chat machine ${real.same ? 'kept' : 'replaced'}${gateFail.join('; ')}`);
      continue;
    }
    if (kind === 'keeps-chat') {
      // the chat STAYS: the machine is there AND unchanged
      check(`no leak: ${name} (the chat stays)`, real.same && real.changed.length === 0 && real.recordKept
        && gateFail.length === 0, `chat machine ${real.same ? 'kept' : 'replaced'}; changed: ${real.changed.join(', ') || 'nothing'}${gateFail.join('; ')}`);
      continue;
    }
    // the default kind: the chat machine must be unchanged beyond the control
    const changed = real.changed;
    if (!real.recordKept && control.recordKept) changed.push('stub record');
    if (!real.same) changed.push('chat machine replaced');
    check(`no leak: ${name}`, changed.length === 0 && gateFail.length === 0, `${changed.join(', ')}${gateFail.join('; ')}`);
  }
  console.log(`${n - fail}/${n} chat-leak checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL chat-leaks ${e.stack}`); process.exitCode = 1; });
