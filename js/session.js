/*
 * Session: one running emulated computer and everything a front end does with it, without a DOM.
 * The page (js/ui/) and embedders drive a Session; it owns the machine, its ROMs and options
 * (remembered in a key-value store), program/tape/cartridge loading and real-time pacing.
 *
 *   const s = new Session({ store });          // store: { get(key), set(key, value), remove(key) } of strings
 *   s.switchMachine('coco2b', { ram: 64 });
 *   s.addRoms([{ name, bytes }]);               // identified across all models; see addRoms
 *   s.load(name, bytes)                         // binary / cassette / cartridge / BASIC text -> message
 *   s.advance(ms)                               // run the frames that are due; s.shownMachine.render() is the picture
 *   s.runFrames(n)                              // n frames of emulated time, no clock (scripts, tests, cli/cloadm.js)
 *   s.startWelcome(bytes)                       // examples/welcome.bin; then events 'welcome:liza' and so on
 *   await s.snapshotFile() / s.readSnapshot(bytes) / s.openSnapshot(snap)   // snapshots; see 'snapshots' below
 *   await s.drives.importImage(name, bytes, drive) / s.drives.mount(drive, name) / s.drives.download(drive)   // floppy disks
 *   s.serial.attach('terminal', { baud }) / s.serial.send(bytes) / s.serial.subscribe({ tx, rx })   // the serial port
 */
import { cartridgeFor, MultiPak, CART_BOARDS } from './machines/carts.js';
import { devices } from './machines/bus.js';
import { DiskController } from './machines/fdc.js';
import { KeyQueue } from './machines/keyqueue.js';
import { charToKeys } from './machines/keyboards.js';
import { cartridgeRoms, createMachine, profiles, resolveConfig, restoreSnapshot } from './machines/profiles.js';
import { cpuFamily } from './cpu/cpus.js';
import { SpeechSoundPak, SSC_ROM_PROFILE } from './machines/ssc.js';
import { Debugger, codeDisassembly } from './debugger.js';
import { HostHooks } from './hooks.js';
import { WriteWatch } from './writewatch.js';
import { Profiler } from './profiler.js';
import { disassembleBlock } from './asm/disassembler.js';
import { formats } from './media/formats.js';
import { Tape } from './media/tape.js';
import { casBlocks, casToWav, recordingToSamples, samplesToCas, writeWav } from './media/cassette.js';
import { FAMILY_NAMES, detectMedia } from './media/detect.js';
import { MediaIndex, LIBRARY_PREFIX, migrateLocalStorage } from './media/library.js';
import { MediaLibrary, DISK_PREFIX, DW_PREFIX, MEDIA_MOVE_WAIT_MS } from './library.js';
import { DiskDrives } from './drives.js';
import { DriveWireServer, CHANNELS as DW_CHANNELS, WINDOW_BASE as DW_WINDOW_BASE, WINDOW_COUNT as DW_WINDOW_COUNT } from './drivewire/server.js';
import { DriveWireSocket } from './host/drivewire-ws.js';
import { SerialDriveWireLink, webSerialAvailable } from './host/web-serial.js';
import { MemoryMediaStore } from './host/media-store-memory.js';
import { MemoryKeyStore } from './host/key-store.js';
import { ChatSession, CHAT_STATE } from './claude/chat.js';
import { TOOL_CODES, ToolError } from './claude/toolerrors.js';
import { DriveWireChatChannel, CHAT_DW_CHANNEL } from './claude/channel.js';
import { nitros9LoaderRom, nitros9LoaderKind, nitros9LoaderByCrc } from './machines/nitros9.js';
import { inspectOs9Disk, NITROS9_IMAGES_URL } from './media/os9.js';
import { END_OF_REPLY } from './claude/chat.js';
import { loadBasic as loadBasicInto, planBasic } from './claude/basicload.js';
import { transcript } from './claude/history.js';
import { Consent, STOPPED } from './claude/consent.js';
import { screenRows, screenTextTool } from './claude/readtools.js';

// the status of a turn paused by the person's key, in every view that shows it with Resume and Stop (Esc is Stop then)
// (one text for every paused state: whether a call waits, typing is held, or Claude only writes its reply,
// its next action waits; "Esc stops Claude" is never dropped)
export const CLAUDE_PAUSED_TEXT = 'Paused: you pressed a key · Claude\'s next action waits · Esc stops Claude';
// the same where it must fit one line (the browser Fullscreen's pill)
// The Speech/Sound Pak's words for its speech ROM (the SP0256-AL2's allophone data, the user's own and optional):
// the board menu's label without it and with it, the ROM panel's line for its socket, and the one notice a session
// gives when a program speaks with no speech ROM (checkSpeechRom; the page adds an "Add ROMs" button).
export const SSC_TEXT = Object.freeze({
  boardNoSpeech: 'Speech/Sound Pak (music; speech needs your SP0256-AL2 ROM)',
  board: 'Speech/Sound Pak',
  romMissing: 'Optional: the SP0256-AL2 speech ROM. Without it the Pak plays music and stays silent for speech. CLOADM never includes it; add your own copy.',
  romLoaded: 'SP0256-AL2 speech ROM ✓ · the Pak speaks.',
  speechNoRom: 'This program is speaking, but there\'s no speech ROM: add your own SP0256-AL2 ROM in Your ROMs.',
});
// What CLOADM opens, said when a file is none of them (Session.unopenable): every kind the drop, Open… and the Library
// take. Tapes: identify (js/media/formats.js) and detectMedia (.c10/.k7); disks: detectMedia's extensions; programs:
// DragonDOS/DECB binaries and BASIC (tokenised in a binary, or a listing as text); cartridges: identify's .rom/.ccc/.dgn;
// snapshots: js/ui/snapshot-panel.js; ROM images: js/roms.js; ZIPs: js/ui/files.js opens them.
export const OPENS_TEXT = 'It opens tapes (.cas, .wav, .c10, .k7), disks (.vdk, .dsk, .jvc, .dmk, .os9), programs (.bin, .bas, .txt), cartridges (.rom, .ccc, .dgn), snapshots (.cloadm), ROM images and ZIPs of these.';
// the extensions OPENS_TEXT names: a file with one of them that isn't what it says (a damaged tape) is not called a
// file CLOADM doesn't open
const OPENS_EXTENSIONS = [...OPENS_TEXT.matchAll(/\.([a-z0-9]+)/g)].map((x) => x[1]).concat('zip');
// a raw file of unknown format still loads at an address the person gives, when it may be a memory dump: a .bin, a
// memory dump's usual names (.raw, .ram, .dmp, .mem), or a file with no extension. Any other unopenable file can still be
// loaded that way from the message's "Load as raw data at an address…" (js/ui/media-panel.js)
const RAW_EXTENSIONS = ['bin', 'raw', 'ram', 'dmp', 'mem', ''];
export const CLAUDE_PAUSED_SHORT = 'Paused: you pressed a key · Esc stops Claude';
// a message's text: a string, or the text blocks of a content array
import { RomLibrary, identifyRoms, isBootable, isRomPack, looksLikeRom, makeRomPack, restoreRomPack, socketStatus } from './roms.js';
import { writeZip } from './media/zip.js';
import { programPage } from './program-pages.js';
import { sealMoment, openMoment } from './media/link-crypto.js';
import { encodeIndexedPng } from './media/png.js';
import { shareCardPicture } from './video/bezel.js';
import { SNAPSHOT_EXT, SnapshotError, decodeSnapshot, decodeLongLink, encodeSnapshot, encodeLongLink } from './media/snapshot.js';
import { missingImages, restoreRoms, stripRoms } from './media/romrefs.js';
import { crc32, hex, registry, toBase64Url, fromBase64Url } from './util.js';
import { buildUrl, NITROS9_MACHINES } from './config.js';
// an error meant for the user (bad file, missing ROM, ...); shared with the parts the Session drives
import { SessionError } from './errors.js';
export { SessionError };

// store: { get(key) -> string | null, set(key, value), remove(key), keys() -> [key] } — small settings only
export const memoryStore = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };


const describeSegments = (segs, exec) =>
  segs.map((s) => `${hex(s.addr)}-${hex((s.addr + s.data.length - 1) & 0xFFFF)}`).join(', ') + (exec != null ? `, exec ${hex(exec)}` : '');

// everything that holds ROMs: the models, the disk-controller cartridges and the Speech/Sound Pak (looked up when
// used, so profiles added at run time count)
export const romOwners = () => Object.assign({}, profiles, cartridgeRoms, { ssc: SSC_ROM_PROFILE });

// The welcome program: its fixed addresses, one entry per CPU family. Its choices (1-7) are posted in the `event`
// mailbox, which the Session reads and clears after every frame (a mailbox rather than PC hooks: the
// CoCo 3 runs hooks only in its ROM area); `soundOk` is set once the page has unlocked audio. The 6809
// build sits at $6000 and covers eleven models (the HD6309 included: it runs the 6809 build in emulation
// mode, like any 6809 program); the 6803 build (the MC-10 and the Matra Alice) sits at
// $5000 and is built once per machine, so its subtitle names the one it runs on.
// Why a welcome menu starts (its tune plays only when the person asked for the menu). 'visit': the visit's own
// start; 'shelf': chosen from Programs (the Welcome menu item, a link, Claude's load); both play it once the sound is
// unlocked. The rest are silent: 'switch' (a machine switch, a RAM or CPU change, an opened snapshot), 'reset' (Reset,
// a power cycle, ROMs removed) and 'return' (back from LIZA, a game or the demo). A silent start sets the firmware's
// PLAYED flag itself (`played`, below), so the tune is spent before anything can unlock it.
export const WELCOME_REASONS = Object.freeze(['visit', 'shelf', 'switch', 'reset', 'return']);
const WELCOME_QUIET = Object.freeze(new Set(['switch', 'reset', 'return']));
// the menu's prompt line, drawn once its program has set the screen up: the sign that the menu is on screen
const WELCOME_PROMPT = 'PRESS 1 TO';
export const WELCOME = Object.freeze({
  // carryMax: the carry-on line's text, 0-terminated (none when the first byte is 0), this long at most (the 6809
  // build's line has the room for "CARRY ON WITH MINESWEEPER")
  '6809': Object.freeze({ file: 'welcome.bin', start: 0x6000, event: 0x6003, soundOk: 0x6004, played: 0x6005, greet: 0x6006, carry: 0x6007, romsw: 0x6022, carryMax: 26 }),
  '6803': Object.freeze({ file: null, start: 0x5000, event: 0x5003, soundOk: 0x5004, played: 0x5005, greet: 0x5006, carry: 0x5007, romsw: 0x5020, carryMax: 24 }),
  // the choices 1-7: keys 1-4 of the menu, its carry-on line (key 5 on the 6803 build, 6 on the 6809 one), and the
  // 6809 build's games menu (key 5, then 1 or 2)
  events: Object.freeze(['liza', 'demo', 'roms', 'claude', 'carryon', '2048', 'minesweeper']),
  greetings: Object.freeze(['first', 'back', 'bye']),   // greet: 0 the first visit, 1 "WELCOME BACK", 2 "BYE FOR NOW. PICK ANOTHER?"
});
// The games (examples/2048.asm, examples/minesweeper.asm): 6809 programs at $3000 that share a fixed header
// (examples/games.inc): `seed`, a word that, when nonzero, starts their random numbers instead of the key-press
// timing (the tests set it), `done`, the loop where a game stops after BREAK, back in text mode, and `samExit`, the
// SAM memory size (M, 0-3) the game puts back on leaving (the Session sets the machine's; the SAM can't be read).
// They need `ram` K: they set the SAM for 64K chips, which a 4K or 16K machine's chips are not.
export const GAMES = Object.freeze({
  list: Object.freeze({ 2048: Object.freeze({ file: '2048.bin', name: '2048', controls: Object.freeze({ input: 'arrows', extra: Object.freeze([]), joystick: false }) }),
    minesweeper: Object.freeze({ file: 'minesweeper.bin', name: 'Minesweeper', controls: Object.freeze({ input: 'arrows', extra: Object.freeze(['F']), joystick: true }) }) }),
  start: 0x3000, seed: 0x3003, done: 0x3005, samExit: 0x3007, ram: 32,
});
// Color BASIC's and Dragon BASIC's warm-start flag: $55 there at reset means a warm start (the program kept)
const BASIC_RSTFLG = 0x71;
// What a bundled program is played with: `input` is 'keyboard', 'arrows' or 'joystick'; `extra`, the keys
// beside the arrows it reads (Minesweeper's F flags a mine); `joystick`, whether it reads a joystick too. The page's
// touch panel opens on what it says (arrows: the pad) and offers the stick only where the machine has the port.
// The games' own entries are in GAMES.list; a program not listed is played on the keyboard.
export const PROGRAM_CONTROLS = Object.freeze({ liza: Object.freeze({ input: 'keyboard', extra: Object.freeze([]), joystick: false }) });
// a game's GAMES.list key from its name ('Minesweeper' -> 'minesweeper'), or undefined
export const gameKey = (name) => Object.keys(GAMES.list).find((k) => GAMES.list[k].name === name);
// the 6803 welcome's files, per profile: the build's subtitle names the machine it runs on
export const WELCOME6803 = Object.freeze({ mc10: 'welcome6803-mc10.bin', alice: 'welcome6803-alice.bin' });

// The POKE book: what people typed into Dragon and CoCo BASIC, and the chip each one touches.
// basic: needs BASIC itself (the stub firmware only carries out POKE lines); bank: Dragon 64 style ROM banks;
// bit / set: the SAM rate bit (R0 = 0, R1 = 1) the entry sets or clears, so the page can light the entry when that bit changes
const POKES = [
  { text: 'POKE 65495,0', about: 'Double speed. Not every machine took it; load tapes at normal speed.', chip: 'SAM · rate bit R0 set', bit: 0, set: true },
  { text: 'POKE 65494,0', about: 'Back to normal speed.', chip: 'SAM · rate bit R0 cleared', bit: 0, set: false },
  { text: 'POKE 65497,0', about: 'The scary one: full speed everywhere. The video chip can\'t keep up and the screen fills with garbage; on a real machine you reached for the power switch. Safe to try here.', chip: 'SAM · rate bit R1 set', bit: 1, set: true },
  { text: 'POKE 65496,0', about: 'Back from full speed: the picture returns.', chip: 'SAM · rate bit R1 cleared', bit: 1, set: false },
  { text: 'EXEC', about: 'Dragon 64: start 64K-mode BASIC.', chip: 'SAM map type 1 · ROM bank switch', basic: true, bank: true },
  { text: '?PEEK(25)*256+PEEK(26)', about: 'Where your BASIC program starts in memory.', chip: 'BASIC pointer at $19', basic: true },
];

// the baud rates the serial terminal offers (the CoCo's BASIC and OS-9 drivers go up to 9600 on the bit-banger)
export const SERIAL_BAUDS = [300, 600, 1200, 2400, 4800, 9600];
// a snapshot that needs ROMs this browser doesn't have (or has in another version): machine and its name
export class SnapshotRomsError extends SessionError {
  constructor(message, machine) { super(message); this.machine = machine; this.machineName = profiles[machine].name; }
}
// The key bootNitros9 sets on a mount's options when the mount runs inside its own Library operation (see
// mountDriveWire). Module-private, handed only to the Session's own DiskDrives: an embedder calling drives.mount or
// mountDriveWire cannot skip their move checks.
const HELD = Symbol('held');
// quick-save slots: how many, and where they live in the media store (in the library, so the Library lists them
// with the other snapshots)
export const SNAPSHOT_SLOTS = 3;
// slot n's blob name; a number that is not a slot is refused before any name is made from it
const slotName = (n) => {
  if (!(Number.isInteger(n) && n >= 1 && n <= SNAPSHOT_SLOTS)) throw new SessionError(`There is no snapshot ${n}.`);
  return `${LIBRARY_PREFIX}snapshots/slot-${n}${SNAPSHOT_EXT}`;
};
const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

// ---- type-in listings (the Library's type-in card) ----
// problems a BASIC listing has before it is typed: lines without a number, and numbers out of order or past
// 63999 (the largest line number Color BASIC and Dragon BASIC accept) -> [message]
export function checkListing(text) {
  const out = [];
  let last = -1;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    const m = /^\s*(\d+)/.exec(line);
    if (!m) { out.push(`line ${i + 1} has no line number`); return; }
    const n = Number(m[1]);
    if (n > 63999) out.push(`${n} is past the last line number BASIC takes (63999)`);
    if (n <= last) out.push(`${n} comes after ${last}`);
    last = n;
  });
  return out;
}

// The Display tab's settings, remembered. view: 'crt' (composite colour and the CRT look) or 'sharp' (RGB, the
// pixels as they are); phase: the NTSC artifact phase (1 or 2, MAME's Standard and Reverse); curvature and glow:
// the CRT look, 0-100; integer: scale the picture by whole multiples of its lines; aspect: '4:3' (the TV's
// shape) or 'fill' (the whole screen area).
export const DISPLAY_DEFAULTS = Object.freeze({ view: 'crt', phase: 1, curvature: 35, glow: 55, integer: false, aspect: '4:3', screen: 'main' });
const DISPLAY_VALID = registry({
  view: (v) => v === 'crt' || v === 'sharp',
  phase: (v) => v === 1 || v === 2,
  curvature: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  glow: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  integer: (v) => v === true || v === false,
  aspect: (v) => v === '4:3' || v === 'fill',
  // which of a machine's two screens is shown (the Dragon 64 Plus has the Dragon's own and the 80-column
  // one); a machine with a single screen ignores it
  screen: (v) => v === 'main' || v === 'plus',
});

// The settings a settings file carries, and only those (never ROMs, stored media, the library's bookkeeping or
// a key for an API): each with the values it may hold. config.<id> for real models only, its options checked by
// resolveConfig; display.settings against DISPLAY_VALID.
const FLAG = (v) => v === '1';
// how long LIZA's goodbye stays on screen before the welcome menu comes back
const LIZA_BYE_SECONDS = 3;
// A program holds BASIC's warm-start vector: RSTFLG ($71) is $55 and RSTVEC ($72-$73) points at a NOP ($12), which
// is what Color BASIC's and Dragon BASIC's reset routine checks before jumping there instead of a cold start (as their
// published disassemblies are commonly described; not checked against a primary source). What the machine does on a
// Reset is compared with MAME on the SAM machines (tools/mame-diff/sam/reset.asm); on the CoCo 3 it is not.
// 6809-family BASICs only; the MC-10's is not modelled.
function warmStartTakeover(m) {
  if (cpuFamily(m.config.cpu) !== '6809') return false;
  const rd = (a) => (m.peek ? m.peek(a) : m.ram[a]);
  return rd(0x71) === 0x55 && rd((rd(0x72) << 8) | rd(0x73)) === 0x12;
}
// what Stop answers a question on screen with: load_basic's card then fails with stopped, not load-declined
const parseObject = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } };
const SETTINGS = {
  machine: (v) => Object.hasOwn(profiles, v),
  machineChosen: FLAG, visited: FLAG, keyHintDone: FLAG,
  keyboardMode: (v) => v === 'translated' || v === 'positional',
  keyboardJoystick: (v) => v === '1' || v === '0',
  tapeSound: (v) => v === '1' || v === '0',
  'display.settings': (v) => { const o = parseObject(v); return !!o && Object.entries(o).every(([k, x]) => Object.hasOwn(DISPLAY_VALID, k) && DISPLAY_VALID[k](x)); },
};
function validSetting(k, v) {
  if (typeof v !== 'string') return false;
  if (Object.hasOwn(SETTINGS, k)) return SETTINGS[k](v);
  const m = /^config\.(.+)$/.exec(k);
  if (!m || !Object.hasOwn(profiles, m[1])) return false;
  const o = parseObject(v);
  if (!o) return false;
  try { resolveConfig(m[1], o); return true; } catch (e) { return false; }
}

// After CLOADM, whether to type EXEC (Typist.typeWhen): decided once a frame from what the machine does, never
// from the screen (the load may have overwritten it, and BASIC's buffers). A tape that starts itself must get no
// keys, and on one that loads over BASIC's line buffer an EXEC typed on the CLOADM line would be lost: so EXEC goes
// on a line of its own, typed once the tape has stopped and the CPU has stayed in the ROM space ($8000 up: BASIC,
// a cartridge, or BASIC copied to RAM there in 64K mode) for EXEC_IDLE frames, and never once the CPU has fetched an
// instruction from the loaded program (a probe, Machine.addProbe: every instruction; pages 0 and 1, where BASIC keeps routines
// and hooks it runs itself, do not count). It gives up (types nothing) if the tape never starts or BASIC never
// settles.
const EXEC_IDLE = 25, EXEC_START_FRAMES = 600, EXEC_SETTLE_FRAMES = 500;
// -> { decide, cancel } for Typist.typeWhen: the probe goes when decide() settles, or when the typist drops the EXEC
// (a reset, a later load: Typist.clear / dropTyped call cancel).
function execWhenReady(m, file) {
  const from = Math.max(file.load, 0x0200), to = file.load + file.data.length;
  let frames = 0, ran = false, settle = 0, idle = 0, tookOver = false;
  const cancel = m.addProbe((pc) => { if (pc >= from && pc < to) tookOver = true; });
  const done = (verdict) => { cancel(); return verdict; };
  const decide = () => {
    frames++;
    if (tookOver) return done('drop');
    if (m.deck.motor) { ran = true; settle = 0; idle = 0; return 'wait'; }
    if (!ran) return frames > EXEC_START_FRAMES ? done('drop') : 'wait';
    idle = m.cpu.pc >= 0x8000 ? idle + 1 : 0;
    if (idle >= EXEC_IDLE) return done('type');
    return ++settle > EXEC_SETTLE_FRAMES ? done('drop') : 'wait';
  };
  return { decide, cancel };
}

// The serial port of the person's machine (session.serial): the device plugged in, the bytes both ways, and a
// trace of what the port did. Subscriptions and traces belong to the Session: its hooks registry (session.hooks)
// puts the port listener and each trace on the person's machine (switchMachine, openSnapshot, a power cycle; the
// BASIC session beside a full-screen chat), and no snapshot holds them.
//
//   tx(bytes, info): bytes the machine sent, as the device decoded them; rx(bytes, info): bytes the terminal sent,
//   once each has crossed the wire into the machine (its stop bit ended). bytes is a Uint8Array; info is
//   { at: [tick of each byte], frame, device }. They come at the end of each frame and on flush(); with
//   { flush: 'instant' } also before each instruction the CPU starts (a probe, there only while such a
//   subscriber is), when runFrames returns and when a debugger stops the machine.
export class SerialApi {
  constructor(session) {
    this.session = session;
    this.subs = [];                 // in the order subscribed
    this.instantProbe = null;       // remove() of the probe 'instant' subscribers need, while there is one
    const listener = {
      tx: (b, at) => { for (const s of this.subs) { s.tx.push(b); s.txAt.push(at); } },
      rx: (b, at) => { for (const s of this.subs) { s.rx.push(b); s.rxAt.push(at); } },
    };
    session.hooks.add((m) => {
      const p = m.serialPort;
      if (!p) return () => {};
      p.listeners.add(listener);
      return () => p.listeners.delete(listener);
    });
  }
  // the device on the port: { chip: '6551' | 'bit-banger', kind: 'none' | 'printer' | 'terminal' | 'loopback', baud,
  // kinds (what can be plugged in) }, or null on machines without one
  get device() {
    const m = this.session.personMachine, p = m.serialPort;
    return p ? { chip: m.acia ? '6551' : 'bit-banger', kind: p.kind, baud: p.baud, kinds: m.serialDevices } : null;
  }
  // plug in a device; what is still to be delivered from the one before goes out first
  attach(kind, { baud = 600 } = {}) {
    const s = this.session, m = s.personMachine;
    if (!m.serialPort) throw new SessionError(`The ${m.profile.name} has no serial port here.`);
    if (!m.serialDevices.includes(kind)) throw new SessionError(`No serial device "${kind}" on the ${m.profile.name} (${m.serialDevices.join(', ')}).`);
    if (!SERIAL_BAUDS.includes(baud)) throw new SessionError(`${baud} baud is not offered (${SERIAL_BAUDS.join(', ')}).`);
    this.flush();
    m.attachSerial(kind, { baud });
    s.emit('serial');
  }
  // bytes (a Uint8Array or an array of 0..255) from the terminal to the machine, sent one after another from now ->
  // how many. send(text, { text: true }) sends text, newlines as CR; each character must be one byte (0..255).
  send(data, { text = false } = {}) {
    const m = this.session.personMachine, p = m.serialPort;
    if (!p || p.kind !== 'terminal') throw new SessionError('Plug in the terminal first (Machine settings, Serial port).');
    let bytes;
    if (text) {
      if (typeof data !== 'string') throw new SessionError('send(text, { text: true }) takes a string.');
      bytes = [...data.replace(/\r?\n/g, '\r')].map((c) => c.codePointAt(0));
    } else {
      if (typeof data === 'string') throw new SessionError('A string goes as send(text, { text: true }); bytes go as a Uint8Array or an array of numbers.');
      if (!data || typeof data.length !== 'number') throw new SessionError('send takes a Uint8Array or an array of byte values.');
      bytes = Array.from(data);
    }
    const bad = bytes.findIndex((b) => !Number.isInteger(b) || b < 0 || b > 255);
    if (bad >= 0) throw new SessionError(`Byte ${bad} is ${text ? JSON.stringify(String.fromCodePoint(bytes[bad])) : String(bytes[bad])}: a serial byte is 0..255.`);
    p.send(bytes, m.now());
    return bytes.length;
  }
  // hear the bytes both ways: handlers { tx(bytes, info), rx(bytes, info) } (either optional), in the order
  // subscribed. A handler that throws is unsubscribed, and its error is thrown once the others have had theirs.
  // -> { unsubscribe() } (idempotent)
  subscribe(handlers, { flush = 'frame' } = {}) {
    if (!handlers || (typeof handlers.tx !== 'function' && typeof handlers.rx !== 'function')) throw new SessionError('subscribe takes { tx(bytes, info), rx(bytes, info) }.');
    if (flush !== 'frame' && flush !== 'instant') throw new SessionError(`flush is 'frame' or 'instant', not ${JSON.stringify(flush)}.`);
    const sub = { handlers, instant: flush === 'instant', tx: [], txAt: [], rx: [], rxAt: [], live: true };
    this.subs.push(sub);
    this.probeIfInstant();
    return { unsubscribe: () => this.drop(sub) };
  }
  drop(sub) {
    if (!sub.live) return;
    sub.live = false;
    this.subs.splice(this.subs.indexOf(sub), 1);
    this.probeIfInstant();
  }
  // the probe is on while an 'instant' subscriber is, and only then
  probeIfInstant() {
    const want = this.subs.some((s) => s.instant);
    if (want && !this.instantProbe) this.instantProbe = this.session.hooks.addProbe(() => this.ran());
    else if (!want && this.instantProbe) { this.instantProbe(); this.instantProbe = null; }
  }
  // deliver every byte completely sent by now, both ways, to every subscriber
  flush() {
    const m = this.session.personMachine, p = m && m.serialPort;
    if (p) p.flush(m.now());
    this.deliver();
  }
  // before an instruction, after runFrames or at a debugger stop: 'instant' subscribers hear what has crossed by now
  ran() {
    if (!this.subs.some((s) => s.instant)) return;
    const m = this.session.personMachine, p = m && m.serialPort;
    if (p) p.flush(m.now());
    this.deliver(true);
  }
  // hand each subscriber (only the 'instant' ones: instantOnly) what it has waiting
  deliver(instantOnly = false) {
    const m = this.session.hooks.machine;   // the machine whose port collected the bytes
    let error = null;
    for (const sub of this.subs.slice()) {
      if (!sub.live || (instantOnly && !sub.instant) || !(sub.tx.length || sub.rx.length)) continue;
      const info = (at) => ({ at, frame: m ? m.frameCount : 0, device: m && m.serialPort ? m.serialPort.kind : null });
      const tx = sub.tx, txAt = sub.txAt, rx = sub.rx, rxAt = sub.rxAt;
      sub.tx = []; sub.txAt = []; sub.rx = []; sub.rxAt = [];
      try {
        if (tx.length && sub.handlers.tx) sub.handlers.tx(Uint8Array.from(tx), info(txAt));
        if (rx.length && sub.live && sub.handlers.rx) sub.handlers.rx(Uint8Array.from(rx), info(rxAt));
      } catch (e) {
        this.drop(sub);
        if (!error) error = e;
      }
    }
    if (error) throw error;
  }
  // record what the port does, in a ring of the last `limit` events, oldest first: { at, frame, pc, kind, ... }.
  // kinds: 'tx-load' (6551: a byte moves to the transmit shift register), 'tx' (a byte sent: the 6551's stop bit
  // ended; the bit-banger's, decoded by the device), 'rx' (a byte received: in the 6551's receive register; across
  // the bit-banger's wire), 'overrun', 'framing', 'parity' (6551 errors, with the byte), 'reg-write' and, with
  // { registers: 'all' }, 'reg-read' ({ reg, value, count }: the value the read returned; a run of the same read
  // is one event with its count). 6551 events also carry status: the status register as a read would give it
  // (peeked, never read). -> { events, dropped, stop() }
  trace({ limit = 4096, registers = 'writes' } = {}) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new SessionError(`limit is a whole number of events above 0, not ${limit}.`);
    if (registers !== 'writes' && registers !== 'all') throw new SessionError(`registers is 'writes' or 'all', not ${JSON.stringify(registers)}.`);
    const t = new SerialTrace(limit, registers === 'all');
    const stop = this.session.hooks.add((m) => t.attach(m));
    return {
      get events() { return t.events(); },
      get dropped() { return t.dropped; },
      stop,
    };
  }
  // the 6551's status register as a read would give it (without the read's side effects), decoded; null on a
  // bit-banger or without a serial port. Bits 6 and 5 (dsr, dcd) set mean NOT asserted, as on the chip.
  status() {
    const a = this.session.personMachine.acia;
    if (!a || !this.session.personMachine.serialPort) return null;
    const v = a.chip.peek(1);
    return { value: v, irq: !!(v & 0x80), dsr: !!(v & 0x40), dcd: !!(v & 0x20), tdre: !!(v & 0x10), rdrf: !!(v & 0x08), overrun: !!(v & 0x04), framing: !!(v & 0x02), parity: !!(v & 0x01) };
  }
}

// A trace of a machine's serial port (SerialApi.trace): a ring of events. attach(m) hears the 6551 through its
// device's addTrace (beside any other trace), or a bit-banger through a port listener, and returns remove(), which
// leaves nothing behind. The ring outlives a machine: the Session's hooks move the trace to the next one.
export class SerialTrace {
  constructor(limit, reads = false) {
    this.limit = limit; this.reads = reads;
    this.ring = []; this.head = 0; this.dropped = 0;
  }
  // everything it records on m names m itself: no machine is shared between attachments, so a hook registry that
  // takes this off a machine it could not finish moving to leaves the one it stays on recording
  attach(m) {
    if (m.acia && m.serialPort === m.acia.port) return m.acia.addTrace((kind, data, at) => this.chip(m, kind, data, at));
    if (!m.serialPort) return () => {};
    const p = m.serialPort, l = { tx: (byte, at) => this.add(m, { at, kind: 'tx', byte }), rx: (byte, at) => this.add(m, { at, kind: 'rx', byte }) };
    p.listeners.add(l);
    return () => p.listeners.delete(l);
  }
  chip(m, kind, data, at) {
    if (kind === 'reg-read') {
      if (!this.reads) return;
      const last = this.last();
      if (last && last.kind === 'reg-read' && last.reg === data.reg && last.value === data.value) { last.count++; return; }
      this.add(m, { at, kind, reg: data.reg, value: data.value, count: 1 });
      return;
    }
    const e = Object.assign({ at, kind }, data);
    if (kind !== 'reg-write') e.status = m.acia.chip.peek(1);   // never read(1): that clears the IRQ
    this.add(m, e);
  }
  last() { return this.ring.length ? this.ring[(this.head + this.ring.length - 1) % this.ring.length] : null; }
  add(m, e) {
    const ev = Object.assign({ at: e.at, frame: m.frameCount, pc: m.cpu.pc }, e);
    if (this.ring.length < this.limit) { this.ring.push(ev); return; }
    this.ring[this.head] = ev;
    this.head = (this.head + 1) % this.limit;
    this.dropped++;
  }
  // oldest first
  events() { return this.ring.slice(this.head).concat(this.ring.slice(0, this.head)).map((e) => Object.assign({}, e)); }
}

// The disk controller of the Session's machine (session.disk): its status decoded and traces of its commands, any
// number at once. A trace belongs to the Session: its hooks (js/hooks.js) move it to a new machine (switchMachine,
// openSnapshot, a power cycle), a disk cartridge plugged in later is heard too (Machine.addDiskTrace), and no
// snapshot holds it.
const WD_COMMANDS = ['restore', 'seek', 'step', 'step', 'step-in', 'step-in', 'step-out', 'step-out',
  'read-sector', 'read-sector', 'write-sector', 'write-sector', 'read-address', 'force-interrupt', 'read-track', 'write-track'];
export class DiskApi {
  constructor(session) {
    this.session = session;
  }
  // record what the disk controller does, in a ring of the last `limit` events, oldest first: { at, frame, pc,
  // kind, ... }. kinds: 'command' ({ cmd, name, drive, side, track, sector, density }: a command takes effect),
  // 'done' ({ cmd, name, status, bytes, requested, lostData, crc, rnf, writeProtect }: it ended; with interrupted
  // when a force interrupt ended it), 'reg-write' ({ reg, addr, value }: the CPU wrote a WD register or the drive
  // latch). -> { events, dropped, stop() }
  trace({ limit = 4096 } = {}) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new SessionError(`limit is a whole number of events above 0, not ${limit}.`);
    const t = new DiskTrace(limit);
    const stop = this.session.hooks.add((m) => t.attach(m));
    return {
      get events() { return t.events(); },
      get dropped() { return t.dropped; },
      stop,
    };
  }
  // the controller's registers as the CPU would read them (peeked: INTRQ and DRQ stay as they are), the status
  // decoded as the command type in force gives it; null without a disk controller. status is the chip's own value
  // (the WD2791's bus shows its complement).
  status() {
    const fdc = this.session.drives.controller;
    if (!fdc) return null;
    const wd = fdc.wd, inv = wd.v.busInvert, v = wd.peek(0) ^ inv;
    const drive = wd.floppy ? fdc.drives.indexOf(wd.floppy) : null;
    const common = { controller: fdc.type, chip: wd.variant, value: v, busy: !!(v & 0x01), crc: !!(v & 0x08), writeProtect: !!(v & 0x40), notReady: !!(v & 0x80) };
    const bits = wd.statusType1
      ? { type: 1, index: !!(v & 0x02), track0: !!(v & 0x04), seekError: !!(v & 0x10), headLoaded: !!(v & 0x20) }
      : { type: 2, drq: !!(v & 0x02), lostData: !!(v & 0x04), rnf: !!(v & 0x10), deletedMark: !!(v & 0x20) };
    return Object.assign(common, bits, {
      command: wd.command, name: WD_COMMANDS[wd.command >> 4], track: wd.peek(1) ^ inv, sector: wd.peek(2) ^ inv, data: wd.peek(3) ^ inv,
      intrq: wd.intrq, drqLine: wd.drq, drive, density: wd.dden ? 'single' : 'double',
    });
  }
}

// A trace of a machine's disk controller (DiskApi.trace): a ring of events. attach(m) hears m's controller through
// Machine.addDiskTrace (beside any other trace) and returns remove(), which leaves nothing behind. The ring outlives
// a machine: the Session's hooks move the trace to the next one.
export class DiskTrace {
  constructor(limit) {
    this.limit = limit;
    this.ring = []; this.head = 0; this.dropped = 0;
    this.pending = null;            // the command under way: { cmd, bytes }
  }
  // everything it records on m names m itself: no machine is shared between attachments, so a hook registry that
  // takes this off a machine it could not finish moving to leaves the one it stays on recording
  attach(m) { return m.addDiskTrace((kind, data, at, fdc) => this.hear(m, kind, data, at, fdc)); }
  hear(m, kind, data, at, fdc) {
    const wd = fdc.wd;
    if (kind === 'reg-write') { this.add(m, Object.assign({ at, kind }, data)); return; }
    if (kind === 'taken') { if (this.pending) this.pending.bytes++; return; }
    if (kind === 'command') {
      // a force interrupt ends the command under way (wd17xx.js interruptStart)
      if ((wd.command & 0xf0) === 0xd0 && wd.busy && this.pending) this.done(m, at, fdc, this.pending.cmd, true);
      const cmd = wd.command, type2 = !!(cmd & 0x80);
      const drive = wd.floppy ? fdc.drives.indexOf(wd.floppy) : null;
      // the WD2797 selects the side with a type II/III command's S flag; elsewhere the drive's side line holds it
      const side = type2 && wd.v.sideControl ? (cmd & 0x02 ? 1 : 0) : wd.floppy ? wd.floppy.ss : null;
      this.pending = (cmd & 0xf0) === 0xd0 ? null : { cmd, bytes: 0 };
      this.add(m, { at, kind, cmd, name: WD_COMMANDS[cmd >> 4], drive, side, track: wd.track, sector: wd.sector, density: wd.dden ? 'single' : 'double' });
      return;
    }
    if (kind === 'done') this.done(m, at, fdc, wd.command, false);
  }
  // the command ends: its result from the status register (computed, never read) and the bytes the CPU took
  done(m, at, fdc, cmd, interrupted) {
    const wd = fdc.wd, p = this.pending, st = wd.statusValue();
    const type1 = !(cmd & 0x80), op = cmd & 0xf0;
    this.pending = null;
    // no sector length when no sector was found: record not found, not ready, write protected, cut short (a type I
    // command reports 0 either way: it moves no data)
    const failed = interrupted || !!(st & 0xd0);
    let requested = null;
    if (type1) requested = 0;
    else if (op === 0xc0) requested = failed ? null : 6;
    else if (op < 0xc0) requested = failed ? null : wd.sectorSize;
    const e = { at, kind: 'done', cmd, name: WD_COMMANDS[cmd >> 4], status: st, bytes: p && p.cmd === cmd ? p.bytes : null, requested,
      lostData: !type1 && !!(st & 0x04), crc: !!(st & 0x08), rnf: !!(st & 0x10), writeProtect: !!(st & 0x40) };
    if (interrupted) e.interrupted = true;
    this.add(m, e);
  }
  add(m, e) {
    const ev = Object.assign({ at: e.at, frame: m.frameCount, pc: m.cpu.pc }, e);
    if (this.ring.length < this.limit) { this.ring.push(ev); return; }
    this.ring[this.head] = ev;
    this.head = (this.head + 1) % this.limit;
    this.dropped++;
  }
  // oldest first
  events() { return this.ring.slice(this.head).concat(this.ring.slice(0, this.head)).map((e) => Object.assign({}, e)); }
}

export class Session {
  // store: small settings (localStorage in the page). media: a MediaStore (js/host/media-store.js) for
  // ROMs, recent programs, the library and the quick-save slots; default an in-memory one, so Node tests and
  // embedders need no setup. keyStore: where the Claude API key lives (js/host/key-store.js), never `store`.
  // welcomeMenu: false for a page embedded in someone else's (?embed=1): the host drives a plain machine, so the
  // Session never asks for the welcome menu (power-on, reset, a switch, leaving LIZA); the bare stub stays
  // mediaMoveWaitMs: how long the library's moveMedia waits for the Library operations under way
  // (MEDIA_MOVE_WAIT_MS, js/library.js); a test sets it short to prove the wait is bounded
  constructor({ store = memoryStore(), media = new MemoryMediaStore(), keyStore = null, welcomeMenu = true, mediaMoveWaitMs = MEDIA_MOVE_WAIT_MS, mediaShare = null } = {}) {
    this.welcomeMenu = welcomeMenu;
    // Other pages of this origin on the same store (the page passes { locks: navigator.locks, channel: a
    // BroadcastChannel }): the index takes the lock to change its lists and says what it changed on the channel, and
    // what another page says there is read back in (mediaElsewhere). None in Node or for an embedder.
    this.mediaShare = mediaShare;
    if (mediaShare && mediaShare.channel) mediaShare.channel.onmessage = (e) => { this.mediaElsewhere(e.data).catch(() => {}); };
    this.store = store;
    this.media = media;
    // the media library on that store (js/library.js): listing, import, rename and delete, the recent list, the
    // names being made and the store's case rule, and moving it all to another store. Made before anything below
    // that compares names or asks whether the library is moving (the DriveWire server's hooks).
    this.library = new MediaLibrary(this, { mediaMoveWaitMs });
    // where the Claude API key lives: host-side only (js/host/key-store.js), never in `store`, the machine or a
    // snapshot. Default is memory-only, so Node tests and an embedder never need browser storage.
    this.keyStore = keyStore || new MemoryKeyStore();
    this.chat = null;               // the Claude chat, once started (js/claude/chat.js): one conversation for both views
    this.claudeView = null;         // where it is shown: 'panel' (Ask Claude, beside the machine) | 'full' (the chat machine)
    // Claude's consent for the visit: the switch, the cards, the pause (js/claude/consent.js); never saved
    this.consent = new Consent({ onChange: () => this.emit('chat'), onResume: () => this.resumeClaude() });
    this.claudeActing = null;       // the acting tool call in progress or last made this turn (cleared when it ends): { name, input }
    this.claudeTool = null;         // the tool running now (claudeStatus)
    this.claudeCall = null;         // the acting tool call between its gate and its act (a card or a check may wait): { name }
    // restore point -> { at (ms), disks: the drives linked to the store then (drives.stored), turn: the turn it was
    // taken in (its line's number, ChatSession.line.turn), fromAction: the first action record it covers }
    this.claudePointInfo = new WeakMap();
    this.machineDriven = null;      // asMachine: the ticket of what the program on the machine asked for, while it starts
    this.menuTicket = null;         // the ticket of the menu LIZA's BYE asked for (checkMenuReturn)
    this.chatMachines = null;       // while a chat is open: { chat, basic } (startChat)
    this.chatServer = null;         // the chat machine's own DriveWire server (startChat with drivewire)
    this.chatView = null;           // which of them is on screen: 'chat' | 'basic'
    this.index = new MediaIndex(media, this.indexShare(media));
    this.index.foreign = (kind, detail) => this.mediaForeign(kind, detail);
    this._shown = null;
    this.turbo = false;
    this.fastTape = true;       // run flat out while the tape is playing
    this.fastCas = false;       // load .cas files straight into memory instead of through BASIC
    this.cartFiles = new WeakMap();   // a cartridge image's device -> the file it came from (takenOut names it)
    this._cartBoard = 'auto';   // the board a loaded cartridge image goes on (js/machines/carts.js CART_BOARDS)
    this.loadStarted = true;        // the load in progress started a program (load() reads it for the last run)
    this.lastRunOn = null;          // the machine the last-run program started on, until something takes it over (lastRunOnScreen)
    this.listeners = new Set(); // (event) => void: 'machine' after a switch, 'loaded' after a program, tape or
                                // cartridge is loaded or assembled, 'roms' when stored ROMs or the stub choice change,
                                // 'firmware' after a power cycle, 'reset' after a reset, 'rate' (SAM rate), 'welcome:<choice>' (startWelcome),
                                // 'disks' when a disk cartridge or disk goes in or out, 'diskerror' when the store refused a disk write
    this.acc = 0;
    this.keys = new KeyQueue();     // host key presses for the matrix, applied at frame starts (keyqueue.js)
    this.roms = new RomLibrary(this.index, romOwners);
    this.romsLeft = new WeakMap();   // machine -> CRCs removed from storage that it still runs (removeRom)
    this.stubChosen = new Set();    // machines the user chose to run without ROMs this session
    this.sharedMoment = false;      // arrived on a shared moment that runs without ROMs, not left yet (openSnapshot)
    // Just arrived from a link: the moment a long link (#z=) or a short link (#l=) carried was opened, and the person
    // has not acted yet -> { kind: 'long' | 'short', id (the short link's, else null), machine (the profile's name),
    // program (the bundled program the moment is of, else null) }, or null. Set by openSnapshot({ link }); cleared
    // (with an 'arrival' event) by the person's first input to the machine (a key, typed or pasted text, a POKE, a
    // load: touch), another snapshot, a switch, a Reset or a power cycle (leaveSharedMoment). The page's arrival card
    // shows while it is set, and screen-aware prompts can read it.
    this.arrivedFromLink = null;
    // The stored-ROM CRCs that did not start BASIC, per machine (Map<Machine, Set<crcs>>): a fresh try is a power-on
    // or a switch, which forgets them (poweredOn clears every machine's; adopt forgets the machine left behind), and
    // another set of ROMs is another key (storedRomsWaiting).
    this.bootFailed = new Map();
    this.bootOk = null;             // the reset after which BASIC's OK was seen
    this.warmReset = null;          // { m, resetAt }: the run that began with the Reset button, not a power-on (bootStatus)
    this.welcome = null;            // the machine running the welcome program
    this.typingRefusedFor = null;   // the Debugger stop the person was last told typing is refused for (refuseTyping)
    this.welcomeFrom = 0;           // its frameCount when the welcome program was loaded (welcomeOnScreen)
    this.welcomeDrawn = false;      // its menu has been seen on the screen since (welcomeOnScreen)
    this.firstVisit = false;        // this page visit began as the browser's first (visit())
    this.welcomeGen = 0;            // bumped by every start: the FIRST start to land wins (a later one is dropped)
    this.menuWatch = null;          // a program that goes back to the welcome menu when left (watchForMenu)
    this.programStart = null;       // { id, m, at }: the bundled program started on m, and the touch count it began at (untouchedBundledProgram)
    // What runs on the stub firmware and how to restart it, per machine (Reset; see `reset`). Per machine because
    // two can exist at once - the chat machine and the BASIC session beside it - and a load on one must not take
    // away the other's restart record (review probe B: the chat's died with a load on the BASIC session).
    this.stubRuns = new Map();
    this.stubRun = null;            // the record for the machine in use, set by `install`; '' until there is one
    this.welcomeBuild = null;       // its build's fixed addresses (WELCOME[profile cpu])
    this.welcomeSoundOn = false;    // audio unlocked: the welcome program may play its tune
    this.menuReason = null;         // why the menu was last offered (offerMenu): the next startWelcome without a reason of its own takes it
    this.welcomeQuiet = null;       // { m, at }: a silent start waiting for its first frame, then PLAYED is set (flushWelcome)
    this.tapeInfo = null;           // the tape in the deck: its block starts and length (tapeStatus)
    this.tapeWatch = null;          // the current or last run of the cassette motor: { done, error } (tapeStatus)
    this.tapeStarted = null;        // a machine-code tape fast-loaded and started: { tape, exec } (tapeStatus started)
    // each machine's printout length when it was last reported by a 'printer' event (checkPrinter): the printout
    // belongs to the machine, so the change is tracked per machine, not per session
    this.printedSeen = new WeakMap();
    this.speechRomNoted = false;    // 'speech-rom' has been emitted (once a session: checkSpeechRom)
    // DriveWire: one server for the session, on its media store (images under DW_PREFIX); attached to the
    // machine's Becker port when it has one. Channels: WebSockets (DriveWireSocket) by channel number.
    this.drivewire = this.newDriveWireServer({ store: media });
    this.dwSockets = new Map();
    this.WebSocket = globalThis.WebSocket;
    this.webSerial = globalThis.navigator && globalThis.navigator.serial;   // Web Serial (a mock in tests)
    this.serialLink = null;
    // a machine's DriveWire prints go to ITS printout, whichever machine is on screen (the shown machine is
    // swapped by install and showChat while both machines run); the chat machine's server (startChat) gets its
    // own handler, so its prints are kept too instead of being dropped. install sets the Session server's
    // handler to the machine that takes it, and clears it when that machine leaves.
    this.drivewire.onPrint = null;
    this.dwPrint = (m) => (bytes) => { for (const b of bytes) m.printed.push(b); this.checkPrinter(); };
    this.drivewire.onChannelData = (ch, bytes) => { const s = this.dwSockets.get(ch); if (s) s.send(bytes); };
    this.drivewire.onChannelOpen = (ch) => { const s = this.dwSockets.get(ch); if (s) s.deliver(); };
    this.drivewire.onChannelRead = (ch) => { const s = this.dwSockets.get(ch); if (s) s.deliver(); };
    // the floppy drives (js/drives.js): the disk controller, the disk cartridge, mounts from the media store and the
    // writes back to it, and the links restore points keep
    this.drives = new DiskDrives(this, { held: HELD });
    this.pendingStop = null;        // a watchWrites 'stop' on the BASIC session beside a full-screen chat: { machine, reason } (writeStopped)
    // the Session's own probes and bus taps (js/hooks.js), put on the person's machine (install, followPerson): the
    // machine in use, or the BASIC session beside a full-screen chat. Host state, never in a snapshot. The developer
    // API is built on them: serial, disk, watchWrites (js/writewatch.js) and profile (js/profiler.js).
    this.hooks = new HostHooks();
    // the serial port's byte streams and diagnostics (SerialApi), its listeners and traces kept on the machine through hooks
    this.serial = new SerialApi(this);
    this.writeWatch = new WriteWatch(this);
    // the disk controller's status and traces (DiskApi), its traces kept on the machine through hooks
    this.disk = new DiskApi(this);
    this.labels = null;             // symbols of the program in use (the assembler's Map name -> address)
    this.profiles = new Set();      // the profiles running (profile): an opened snapshot starts them empty
    this.displayCache = null;       // Session.display, once read from the store
    this.unsavedRecording = null;   // a tape recording kept when its machine went (keepRecording), until the page takes it
  }
  // One awaited call at startup for an asynchronous store (the page's OPFS): load the library from the
  // store, migrate what main kept in localStorage, and flush the migration's writes. A store already in
  // memory is loaded in the constructor, and this resolves at once.
  async ready() {
    if (!this.index.ready) await this.index.load();
    // TODO: remove after the 1.0 release (kept until the first tagged release, for pages that saved in the old layout) (the localStorage migration, js/media/library.js)
    const migrated = await migrateLocalStorage(this.store, this.media);
    if (migrated.migrated) await this.index.load();   // what the migration wrote, now in memory
    await this.index.flush();
    await this.library.measureCase();
    return this;
  }
  // Every DriveWire server this Session built and still holds: the Becker port's, the one a real CoCo is served
  // from (while it is open), and the chat's (while it is up). One list, so a change to where the library is kept
  // reaches them all (moveMedia).
  // A DriveWire server on the Session's drives' store, with the Library's guard on a guest's writes. Every server the
  // Session builds comes from here (the Becker port's, serveRealCoco's and the chat's), because each one lets a guest
  // write the store: a named-object call reaches it (a create writes it, and a mount hands the guest a drive it then
  // writes through), refused while the library is being copied, so neither can be lost to the move (the reply is the
  // protocol's "no such object"); and a create's write runs as a Library operation, so a move waits for it and it
  // cannot begin mid-copy. A server built without them (serveRealCoco's, before this) let a real CoCo's CREATE write
  // into the store a move was copying, out of the move's sight.
  newDriveWireServer(opts = {}) {
    const server = new DriveWireServer(Object.assign({ store: this.media, namePrefix: DW_PREFIX, sameName: (a, b) => this.library.sameName(a, b) }, opts));
    server.mayWrite = () => !this.library.movingMedia;
    server.openLibraryOp = (run) => this.library.libraryOp(run);
    return server;
  }
  dwServers() {
    const out = [this.drivewire];
    if (this.serialLink && this.serialLink.server) out.push(this.serialLink.server);
    if (this.chatServer) out.push(this.chatServer);
    return out.filter((s) => s);
  }
  // ---------------- other pages on the same store ----------------
  // What a MediaIndex on `store` shares with other pages: only a store they can open too (OPFS, a picked folder). An
  // in-memory store (the fallback, Node) is this page's own, and there is nothing to tell anyone.
  indexShare(store) {
    const share = this.mediaShare;
    if (!share || store.synchronous || (store.kind !== 'opfs' && store.kind !== 'fsa')) return {};
    return { locks: share.locks || null, post: (what) => this.mediaPost(what, store) };
  }
  // tell the other pages that `what` changed in the store: 'roms' | 'recent' (the index), 'library' (its files)
  mediaPost(what, store = this.media) {
    const ch = this.mediaShare && this.mediaShare.channel;
    if (!ch || store.synchronous || (store.kind !== 'opfs' && store.kind !== 'fsa')) return;
    try { ch.postMessage({ store: store.kind, what }); } catch (e) { /* a closed channel: nothing to tell */ }
  }
  // Another page changed the store this one uses: the index reads its lists again, and the panels hear what changed
  // ('roms', 'recent', 'library': the Library's files). Nothing is said on screen; the panels show the new state.
  async mediaElsewhere(msg) {
    if (!msg || msg.store !== this.media.kind || this.media.synchronous) return;
    if (msg.what === 'library') { this.emit('library'); return; }
    await this.index.refresh();   // what it brings in is reported through mediaForeign
  }
  // the index took in another page's change: the panels redraw. 'roms' carries { elsewhere: [{ machine, socket }] }
  // for sockets, which the ROM screen marks.
  mediaForeign(kind, detail) {
    if (kind === 'recent') this.emit('recent');
    else this.emit('roms', kind === 'sockets' ? { elsewhere: detail } : undefined);
  }
  // A socket of the person's machine another page changed while this machine runs the ROM it had: 'removed' (the
  // store has none now) or 'replaced' (it holds another); null otherwise. The machine keeps what it runs until it is
  // switched off and on (or switched), which reads the stored ROMs again.
  romElsewhere(machine, socket) {
    const m = this.personMachine;
    if (!m || m.id !== machine || !this.index.changedElsewhere.has(`${machine}:${socket}`)) return null;
    const running = m.romCrcs()[socket] || null, stored = this.index.socketCrc(machine, socket);
    if (!running || running === stored) return null;
    return stored ? 'replaced' : 'removed';
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event, arg) {
    if (event === 'launch') this.lastRunOn = null;   // (every load, reset, switch, menu start and snapshot is a launch: lastRunOnScreen)
    for (const fn of this.listeners) fn(event, arg);
  }

  // ---------------- the debugger ----------------
  // One debugger per machine, made on first use and thrown away with the machine. A front end talks to
  // `session.debug`, so the page and an embedder take the same path and none has to know where the debugger
  // lives. Its methods throw SessionError with a message for the user. It shows the symbols of the last assembled
  // program by itself; `setLabels` replaces them.
  get debug() {
    const m = this.shownMachine;
    if (!m.debugger) new Debugger(m, { symbols: () => this.labels });
    // (one a restored snapshot made, or one made on the machine directly, shows the Session's symbols too, unless it has its own)
    if (m.debugger._symbols === null) m.debugger.setSymbols(() => this.labels);
    // (its stops are reported as the Session's: a debugger made on the machine directly gets that here)
    if (!m.debugger.onStop) this.watchStops(m.debugger);
    return m.debugger;
  }
  // The debugger of the machine in use, or null. A machine has one debugger (js/debugger.js: a new one takes the
  // place of the one it has), and it is the machine's, so this reads it from there: one made on the machine
  // directly is the Session's from then on, and none is ever the Session's but not the machine's.
  get debugger() { const m = this.shownMachine; return (m && m.debugger) || null; }
  // a Map name -> address, or a function returning one, for the disassembly; null for plain addresses
  setLabels(symbols) {
    this.labels = symbols;
    if (this.debugger) this.debugger.setSymbols(() => this.labels);
  }
  // A hot-spot profile of the machine in use from now on (js/profiler.js): { mode: 'cycles' | 'samples', every,
  // symbols, buckets } -> a Profiler; p.report({ top }) at any time, p.stop() ends it (with its last report). Its
  // probe and bus taps are the Session's own (hooks), so it follows a machine switch; an opened snapshot starts it
  // empty. symbols: a Map or object name -> address, or a function returning one; by default the Session's labels
  // (the assembled program's, or setLabels) as they are when it reports.
  profile({ mode = 'cycles', every = 1000, symbols = () => this.labels, buckets = 4096 } = {}) {
    let p;
    try { p = new Profiler(this.hooks, { mode, every, symbols, buckets }); } catch (e) { throw new SessionError(e.message); }
    this.profiles.add(p);
    const stop = p.stop.bind(p);
    p.stop = () => { this.profiles.delete(p); return stop(); };
    return p;
  }
  // a debugger has stopped the machine: the frame loop must not run it on (advance runs nothing then)
  get paused() { return !!(this.debugger && this.debugger.stopped); }
  // continue the machine from where the debugger stopped it
  resume() { if (this.debugger) this.debugger.resume(); }
  // A launch - Reset, a power cycle, a load (a program, a tape, the welcome menu, LIZA, a game,
  // Run again), a disk put in from a drop or Open, a machine switch - runs what it starts, for the page, the MCP server
  // and Claude alike. It emits 'launch' (the page lets go of its own Pause on it) and releases a Debugger stop on the
  // machine it starts (a stop on another machine stays); the breakpoints stay set. -> the PC the released stop was
  // at, or null; a release also emits ('released', pc), for the page's "The Debugger's stop at $C0F3 was released."
  launch(m = this.shownMachine) {
    this.emit('launch');
    const d = this.debugger;
    if (!d || !d.stopped || d.machine !== m) return null;
    const pc = d.pc;
    d.resume();
    this.emit('released', pc);
    return pc;
  }
  // Every stop the Debugger makes (its Pause, a step, a breakpoint or watchpoint, a run limit, MCP's step) is a
  // ('debugger-stopped', machine) event: what is in flight on that machine when it stops - Claude's keys - ends then
  // (ChatSession.keys, through the chat target's onStopped) rather than waiting behind the stop.
  watchStops(d) { d.onStop = () => this.emit('debugger-stopped', d.machine); }
  // Is machine m stopped by the Debugger (the stop that keeps it stopped)? -> { pc, kind } (where, and Debugger.stopReason's kind), or
  // null. The one test both sides use: the person's typing (refuseTyping) and Claude's and the MCP tools that need the
  // machine to run or read keys (the chat target's stopped(): ChatSession.callTool, and js/mcp/tools.js).
  stoppedOn(m = this.shownMachine) {
    const d = this.debugger;
    if (!d || !d.stopped || d.machine !== m) return null;
    return { pc: d.pc, kind: (d.stopReason && d.stopReason.kind) || 'halt' };
  }
  // The person's typing while the Debugger has the machine stopped is refused, not queued (keys, a tap on
  // the welcome menu, its carry-on line, a paste, typed text): the machine reads nothing while stopped, so typing
  // would only pile up behind the stop. -> true when refused; emits 'typing-refused' once per stop (the stop's reason
  // object is new for every stop) for the page's one toast.
  refuseTyping(m = this.shownMachine) {
    const d = this.debugger;
    if (!this.stoppedOn(m)) return false;
    if (this.typingRefusedFor !== d.stopReason) { this.typingRefusedFor = d.stopReason; this.emit('typing-refused'); }
    return true;
  }

  // ---------------- machine ----------------
  get startMachine() { return this.store.get('machine') || 'dragon64'; }
  savedConfig(id) { try { return JSON.parse(this.store.get(`config.${id}`) || '{}'); } catch (e) { return {}; } }
  // switch to a model; config (e.g. { ram: 64 }) is remembered for that model once it has made a machine (a
  // config the model can't take falls back to the model's defaults and is not remembered)
  // menu: false when the caller decides what runs next (the page's start: the visit, the link's program)
  // offer: what the welcome menu is offered as, when it is offered (see offerMenu). The machine question's switch
  // passes 'none': the person chose the MACHINE, not what ran on the old one, so the menu is started once, here,
  // without a carry-on line -- the page then starts nothing of its own (it used to, and which of the two starts
  // won was an accident).
  switchMachine(id, config, { menu = true, offer = null } = {}) {
    this.writeWatch.guard('switchMachine');
    this.leaveSharedMoment();
    if (!Object.hasOwn(profiles, id)) id = 'dragon64';
    let m;
    try {
      m = createMachine(id, config || this.savedConfig(id));
      if (config) this.store.set(`config.${id}`, JSON.stringify(config));
    } catch (e) { m = createMachine(id); }
    this.emit('launch');   // (a machine switch is a launch: the page's Pause ends, and adopt releases a stop)
    this.adopt(m);
    if (!this.stubChosen.has(id)) this.loadSavedRoms();
    // the Pak a machine starts with, from its `ssc` option (the ROMs are in place by now)
    this.applySscOption(m);
    m.reset(true);
    this.lastRate = this.cpuRate() && this.cpuRate().rate;
    this.emit('machine');
    if (menu) this.offerMenu(offer, 'switch');   // switched on without ROMs: the welcome menu
    return m;
  }
  // What a switch to model `id` with `config` (a RAM change: the same id) takes out of the machine in use, for the
  // page to name before and after it: [{ kind: 'tape' | 'cartridge' | 'disk', name (the file, or null
  // for a cartridge whose file is not known), drive (a disk's), stored (a disk linked to the Library: false for the
  // disk that came with a snapshot) }]. Not listed: the DriveWire server's disks (the Session's, not the machine's: they
  // stay mounted) and a Speech/Sound Pak that the new machine's `ssc` option puts back (applySscOption).
  takenOut(id, config = this.savedConfig(id)) {
    const m = this.shownMachine, out = [];
    if (!m) return out;
    if (m.deck.tape) out.push({ kind: 'tape', name: m.deck.tape.name });
    const c = m.cartPort;
    const sscBack = c instanceof SpeechSoundPak && profiles[id] && profiles[id].options.ssc && config && config.ssc === 'music' && !!this.roms.get('ssc').tms7040;
    // a disk controller on its own is not named: its disks are, and a mount plugs one in again
    if (c && !(c instanceof DiskController) && !sscBack) out.push({ kind: 'cartridge', name: this.cartFiles.get(c) || null });
    for (const d of this.drives.status().drives) out.push({ kind: 'disk', name: d.file, drive: d.drive, stored: d.stored });
    return out;
  }
  // Set (or clear) the stub-restart record of machine m (default: the machine in use). Kept per machine: the
  // chat machine and the BASIC session beside it each have their own, and the one on screen reads this.stubRun.
  setStubRun(m, rec = null) {
    if (rec) this.stubRuns.set(m, rec); else this.stubRuns.delete(m);
    this.stubRun = this.stubRuns.get(this.shownMachine) || null;
  }
  // take away the records of the machines named (adopt: the machines a switch or a snapshot leaves behind).
  // Closing the chat is not that: its machine goes, but the BASIC session comes back unchanged and keeps its record
  clearStubRuns(machines) { for (const m of machines) if (m) this.stubRuns.delete(m); this.stubRun = this.stubRuns.get(this.shownMachine) || null; }
  // make m the machine in use (the caller has its ROMs set or sets them next, and emits 'machine'). The old
  // machine's disks keep what was written to them, a tape recording still running is kept (keepRecording), its chat
  // closes and its debugger goes with it; a debugger m already has (a restored snapshot's breakpoints) becomes the
  // Session's, with the Session's symbols.
  adopt(m) {
    this.writeWatch.guard('A machine change');
    if (this.shownMachine) { this.drives.flush(); this.keepRecording(); }   // its disks and a recording still running are kept
    const chat = this.chatMachines;
    // the welcome is the PERSON's, and with the chat on screen it runs on the machine beside the chat (personMachine),
    // so a switch, a snapshot or a power cycle ends it there; the chat's machine on screen is not its machine
    if (this.shownMachine) this.endWelcome(this.personMachine);   // the person's machine, if there is one yet
    this.dropChat();                      // a chat belongs to the machine it was opened on
    if (chat) this.clearStubRuns([chat.chat, chat.basic]);
    this.warmReset = null;                // a new machine is a power-on: the boot watchdog arms
    // (a Debugger stop goes with the machine it was on, and that is said as a release. A switch is a launch, and says so
    // itself (switchMachine); an opened snapshot is a restore, not a launch, and keeps the page's Pause. Adopting the
    // machine already shown keeps its debugger, and its stop.)
    const left = this.debugger && this.debugger.machine !== m ? this.debugger : null;
    const stoppedAt = left && left.stopped ? left.pc : null;
    if (left) left.detach();
    if (stoppedAt != null) this.emit('released', stoppedAt);
    if (m.debugger) { m.debugger.setSymbols(() => this.labels); this.watchStops(m.debugger); }
    // the machines left behind keep no state in the Session: their ROM-failure sets go (a switch back is a fresh
    // try) and their stub-restart records with them (the record of a Machine that is gone cannot come back)
    for (const [mm] of this.bootFailed) if (mm !== this.shownMachine && mm !== m) this.bootFailed.delete(mm);
    for (const [mm] of this.stubRuns) if (mm !== this.shownMachine && mm !== m) this.stubRuns.delete(mm);
    this.store.set('machine', m.id);
    this.install(m);
  }
  // put m on screen (adopt, and the chat's two machines: showChat), with the keyboard and display; the printout
  // starts over on m (and the page's serial terminal log, its own subscriber, on the 'machine' event). A machine
  // with the Becker port and no server yet gets the Session's DriveWire server and a fresh link; one that has a server (the chat machine's own, or a machine coming back on
  // screen) keeps it and its link. The caller emits 'machine'.
  install(m) {
    // a restart of the machine Claude acts on, by any path (Reset, a power cycle, a program or cartridge that
    // starts, the welcome menu, LIZA, ROMs cleared), stops Claude: nothing it held or still had to type goes into
    // the machine that starts over, and its next action does not run there
    m.onReset = () => this.stopClaudeFor('the machine restarted', m);
    this.keys.clear();
    if (this.debugger && this.debugger.machine !== m) this.debugger.detach();
    let undelivered = null;
    try { this.serial.deliver(); } catch (e) { undelivered = e; }   // what the old machine sent goes out first
    this.followPerson(this.personFor(m)); // the Session's hooks move to the person's machine (adopt: a switch, a snapshot)
    this.shownMachine = m;
    this.presentPendingStop();
    this.stubRun = this.stubRuns.get(m) || null;   // the record is the machine's, not the Session's (see stubRuns)
    this.applyDisplay();
    this.acc = 0;
    this.lastRate = this.cpuRate() && this.cpuRate().rate;
    this.printedSeen.set(m, m.printed.length);   // its printout is its own: report only what changes from here
    if (m.becker && !m.becker.server) { this.drivewire.resetLink(); m.becker.attach(this.drivewire); }
    // the Session's server prints to the machine that holds it, or to no machine: a machine the Session has
    // let go of (a switch ended the chat and its machines) must not be kept alive by the handler. The chat's
    // two machines are the exception: dropChat is what lets them go, and between a showChat swap they both
    // stay with the Session - the one going off screen keeps the server and its prints.
    const holder = m.becker && m.becker.server === this.drivewire ? m
      : this.chatMachines ? [this.chatMachines.basic, this.chatMachines.chat].find((c) => c.becker && c.becker.server === this.drivewire) : null;
    this.drivewire.onPrint = holder ? this.dwPrint(holder) : null;
    if (undelivered) throw undelivered;
  }

  // ---------------- printer ----------------
  // What the machine's printer has received: the Dragons' parallel printer, or the serial printer on the
  // bit-banger of the others (600 baud, as MAME fits by default). It belongs to the machine, so a machine switch
  // starts a new printout.
  get printout() { return Uint8Array.from(this.shownMachine.printed); }
  // the printout as text: printable ASCII; CR, LF and CR LF end lines. Control characters and bytes from $80 up
  // (printer-specific codes and graphics; a Dragon's reset sends $FF, see sam.js) are left out; the file has them
  printoutText() {
    let out = '';
    const b = this.shownMachine.printed;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === 13) { out += '\n'; if (b[i + 1] === 10) i++; }
      else if (c === 10) out += '\n';
      else if (c === 9 || (c >= 32 && c < 127)) out += String.fromCharCode(c);
    }
    return out;
  }
  clearPrintout() { this.shownMachine.printed.length = 0; this.checkPrinter(); }
  // the printout as a file: the bytes exactly as received
  printoutFile() {
    if (!this.shownMachine.printed.length) throw new SessionError('Nothing has been printed yet.');
    return { name: `${this.shownMachine.id}-printout.prn`, bytes: this.printout };
  }
  // after frames run: a 'printer' event when any running machine's printout changed - the shown machine, and the
  // chat's BASIC session and chat machine (startChat), which run beside each other whichever is on screen. The
  // printout belongs to the machine that printed, so the length is tracked per machine (printedSeen): a machine
  // that is not running now (switched away from) keeps what it printed for when it comes back.
  checkPrinter() {
    const seen = (m) => { const n = m.printed.length; if (n !== (this.printedSeen.get(m) ?? n)) { this.printedSeen.set(m, n); this.emit('printer'); } };
    if (this.shownMachine) seen(this.shownMachine);
    if (this.chatMachines) { seen(this.chatMachines.basic); seen(this.chatMachines.chat); }
  }
  // A program on the shown machine has asked the Speech/Sound Pak to speak, and the Pak has no allophone ROM: emit
  // 'speech-rom' once in this Session's life (SPEECH_ROM_NOTE is what the page says). Checked after every frame,
  // however the frames were run (the page's clock, Claude's tools, MCP, scripts), so it is raised once whoever ran
  // the program. The Pak may be in the port or in a Multi-Pak slot.
  checkSpeechRom() {
    if (this.speechRomNoted) return;
    const port = this.shownMachine.cartPort;
    const paks = port instanceof SpeechSoundPak ? [port] : port && Array.isArray(port.slots) ? port.slots.filter((c) => c instanceof SpeechSoundPak) : [];
    if (!paks.some((p) => p.spokeWithoutRom)) return;
    this.speechRomNoted = true;
    this.emit('speech-rom');
  }

  // ---------------- serial port (the CoCo's and the MC-10's bit-banger, the Dragon 64's 6551) ----------------
  // The port itself is `serial` (SerialApi): device, attach, send, subscribe, flush, trace, status.
  // where the machine is, for a report of why something stalled: { pc, frame, now (ticks), cycles (the CPU's
  // total), serial: { device, status (the 6551's, decoded; null on a bit-banger), queued (bytes handed to the
  // terminal that the machine has not finished receiving) }, disk: the disk controller's status (DiskApi.status;
  // null without one) }. It changes nothing.
  diagnostics() {
    const m = this.personMachine, p = m.serialPort;
    return {
      pc: m.cpu.pc, frame: m.frameCount, now: m.now(), cycles: m.cpu.totalCycles,
      serial: p ? { device: this.serial.device, status: this.serial.status(), queued: p.kind === 'terminal' ? p.queue.length : 0 } : null,
      disk: this.disk.status(),
    };
  }

  // ---------------- DriveWire (the CoCo's Becker port) ----------------
  // the images in the store a drive can take: [{ name (without the prefix), size }]
  async driveWireImages() {
    this.drivewire.store = this.media;
    return (await this.media.list(DW_PREFIX)).map((e) => ({ name: e.name.slice(DW_PREFIX.length), size: e.size }));
  }
  // put an image (a .dsk of 256-byte sectors) into the store
  async importDriveWireImage(name, bytes) {
    const clean = String(name).replace(/[\\/\x00-\x1F]/g, '_');
    if (!clean) throw new SessionError('The image needs a name.');
    if (bytes.length % 256) throw new SessionError(`${name}: ${bytes.length} bytes is not a whole number of 256-byte sectors.`);
    this.library.checkNotMoving();
    try { await this.library.libraryOp(() => this.media.write(DW_PREFIX + clean, bytes)); } catch (e) { throw this.library.mediaError(e, clean, DW_PREFIX + clean); }
    this.emit('drivewire');
    return clean;
  }
  // a blank image of `sectors` sectors (zeroes)
  newDriveWireImage(name, sectors = 630) { return this.importDriveWireImage(name, new Uint8Array(sectors * 256)); }
  // opts[HELD] (module-private, bootNitros9 only): the caller runs this mount inside its own Library operation,
  // which the move waits for: a move that begins in the mount's await then finds the drive mounted after its wait
  // and is refused itself, so the mount goes on rather than being refused halfway through the caller's work
  async mountDriveWire(drive, name, opts = {}) {
    const { writeProtected = false } = opts, held = opts[HELD] === true;
    // the mount hands the drive the store it reads and writes in: not while the library moves, or the guest's
    // writes would land in the old place mid-copy
    if (!held) this.library.checkNotMoving();
    this.drivewire.store = this.media;
    // One stored image, one drive (see DriveWireServer.mount). Only DriveWire drives can collide with each other:
    // an image here is always drivewire/... and a floppy is always disks/..., so a stored file is never both and no
    // floppy drive can be holding this one. Names are compared by this.library.sameName (the store's case rule), which
    // the server was given at construction (DriveWireServer.sameStoredName).
    try { await this.drivewire.mount(drive, DW_PREFIX + name, { writeProtected }); } catch (e) { throw new SessionError(e.message.replace(DW_PREFIX, '')); }
    // The mount awaits a stat of the image, and a move can begin in that gap: its busy check found no mounts yet, so
    // it is not refused there. Checked again with nothing left to await, as drives.mount does: a drive must not come
    // out of the mount onto a store the move has just left.
    if (this.library.movingMedia && !held) { this.drivewire.eject(drive); throw new SessionError('The library is being moved: try again once it is done.'); }
    this.emit('drivewire');
  }
  ejectDriveWire(drive) { this.drivewire.eject(drive); this.emit('drivewire'); }
  get driveWireMounts() { return this.drivewire.mounts.map((d) => Object.assign(d, { name: d.name.startsWith(DW_PREFIX) ? d.name.slice(DW_PREFIX.length) : d.name })); }
  // an image as a file to keep (it has what the machine wrote)
  async driveWireFile(name) {
    try { return { name, bytes: await this.media.read(DW_PREFIX + name) }; } catch (e) { throw this.library.mediaError(e, name, DW_PREFIX + name); }
  }
  // connect virtual serial channel `ch` (0-14) or window channel (128-142) to a WebSocket; null url disconnects it
  connectDriveWireChannel(ch, url) {
    const serial = Number.isInteger(ch) && ch >= 0 && ch < DW_CHANNELS;
    const window = Number.isInteger(ch) && ch >= DW_WINDOW_BASE && ch < DW_WINDOW_BASE + DW_WINDOW_COUNT;
    if (!(serial || window)) throw new SessionError(`DriveWire channels are 0-${DW_CHANNELS - 1} or ${DW_WINDOW_BASE}-${DW_WINDOW_BASE + DW_WINDOW_COUNT - 1}.`);
    const old = this.dwSockets.get(ch);
    if (old) { old.close(); this.dwSockets.delete(ch); }
    if (!url) { this.emit('drivewire'); return null; }
    if (!/^wss?:\/\//.test(url)) throw new SessionError('A channel connects to a ws:// or wss:// address.');
    const s = new DriveWireSocket(this.drivewire, ch, url, { WebSocket: this.WebSocket, onState: () => this.emit('drivewire') });
    this.dwSockets.set(ch, s);
    this.emit('drivewire');
    return s;
  }
  // ---------------- NitrOS-9 without a ROM (DriveWire or floppy) ----------------
  // The CoCo 3 boots NitrOS-9 from the user's own image with one of our loaders (js/machines/nitros9.js) in place
  // of its internal ROM: a DriveWire image (the release's _becker.dsk) goes in DriveWire drive 0 with the Becker
  // port on; a floppy image (_40d_1.dsk) goes in floppy drive 0 of the CoCo disk controller, plugged in without a
  // ROM if none is in the port. The loader reads the boot track and jumps into it. Reset and power cycle boot it
  // again (the loader stays in the socket); leaveNitros9, a ROM change or another machine puts the ROMs back.
  // Images are kept where their kind lives: DriveWire images under DW_PREFIX, floppies under DISK_PREFIX
  // (store 'drivewire' or 'disk').
  // the machines it boots on (the NTSC CoCo 3: the release's images are 60 Hz builds, but for the _50hz floppies)
  static NITROS9_MACHINES = NITROS9_MACHINES;
  // what the short-link server takes (shortlink/worker.js MAX_SEALED, PNG_COLOURS and MAX_PNG; a test keeps them equal)
  static SHORT_SEALED_MAX = 64 * 1024;
  // a snapshot's `program` (the bundled program it is a moment of: momentProgram) -> that id if it is one this page
  // has (a GAMES.list key or 'liza'), else null: whatever a file or a link says, only a known program is started
  static momentProgramId(id) { return typeof id === 'string' && (id === 'liza' || Object.hasOwn(GAMES.list, id)) ? id : null; }
  static SHORT_PNG = Object.freeze({ colours: 16, bytes: 32 * 1024 });
  // which of our loaders is the ROM of machine m: 'drivewire', 'floppy' or null
  nitros9Loader(m = this.shownMachine) { return m && m.roms ? nitros9LoaderKind(m.roms.basic) : null; }
  nitros9On(m = this.shownMachine) { return !!this.nitros9Loader(m); }
  // Is NitrOS-9 running on the machine the PERSON is working on? personMachine, not this.shownMachine: with the chat full
  // screen this.shownMachine is the chat machine, which never has the loader, so this answered false and the NitrOS-9 panel
  // hid **Leave** - the fixed leaveNitros9 could not be reached. The readers that mean the
  // person's machine are the ROMs row and pill, the nitros9 panel and install's "a program is running".
  // Share is NOT one of them: it pairs a picture of the machine ON SCREEN with a link to that same machine
  // (js/ui/share.js capture, and shareUrl below), so it asks nitros9OnScreen.
  get nitros9Running() { return this.nitros9On(this.personMachine); }
  // Is NitrOS-9 running on the machine on screen? For what pairs with the shown picture (Share) and nothing else.
  get nitros9OnScreen() { return this.nitros9On(this.shownMachine); }
  // the stored images with what they are: [{ name, size, store, os9, label, cpu, boot, reason }] (reason null: it
  // boots); the DriveWire images, then the floppy images that are OS-9 disks
  async nitros9Images() {
    const out = [];
    for (const [store, prefix] of [['drivewire', DW_PREFIX], ['disk', DISK_PREFIX]]) {
      for (const e of await this.media.list(prefix)) {
        let bytes;
        try { bytes = await this.media.read(e.name); } catch (err) { continue; }
        const r = inspectOs9Disk(bytes);
        if (store === 'disk' && !r.os9) continue;     // (the library's other disks are no concern of NitrOS-9's)
        out.push(Object.assign({ name: e.name.slice(prefix.length), size: e.size, store }, r));
      }
    }
    return out;
  }
  // which image a link's nitros9=1 boots: the one in DriveWire drive 0 if it boots, else the one in floppy drive 0,
  // else the bootable one for the link's CPU, else any bootable one; null when there is none
  async pickNitros9Image(cpu = null) {
    const ok = (await this.nitros9Images()).filter((x) => !x.reason);
    const dw0 = this.driveWireMounts.find((d) => d.drive === 0);
    const fd0 = this.drives.targetMachine && this.drives.controller ? this.drives.status().drives.find((d) => d.drive === 0 && d.name) : null;
    return (dw0 && ok.find((x) => x.store === 'drivewire' && x.name === dw0.name)) ||
      (fd0 && ok.find((x) => x.store === 'disk' && DISK_PREFIX + x.name === fd0.name)) ||
      ok.find((x) => cpu && x.cpu === cpu) || ok[0] || null;
  }
  // put a NitrOS-9 image (a file the user picked or dropped) in the library and boot it -> message
  async addAndBootNitros9(name, bytes) {
    const r = inspectOs9Disk(bytes);
    if (r.reason) throw new SessionError(`${name}: ${r.reason}`);
    if (r.boot === 'floppy') {
      const full = this.drives.storeName(name);
      // one creation of a disks/ name, like an import (library.createDisk: the name claimed, its turn, the landing),
      // written through the disk queue like every other write to a stored image: a mount reading this name
      // meanwhile re-reads for it, and the drives' writes are ordered against it
      this.library.checkNotMoving();
      const base = full.slice(DISK_PREFIX.length);
      try { await this.library.createDisk(full, () => this.drives.storeChange(() => this.media.write(full, bytes), full)); } catch (e) { throw this.library.mediaError(e, base, full); }
      return this.bootSaved(base, 'disk');
    }
    return this.bootSaved(await this.importDriveWireImage(name, bytes), 'drivewire');
  }
  // the boot of an image addAndBootNitros9 has just stored: a refusal from here on (a move begun since the save,
  // a drive in use) leaves the image in the Library, and says so, as drives.importImage does for its mount
  async bootSaved(name, store) {
    try { return await this.bootNitros9(name, store); } catch (e) { throw new SessionError(`${name} was saved to your Library but not booted: ${e.message}`); }
  }
  // Boot NitrOS-9 from the stored image `name` in `store` ('drivewire' or 'disk'; null: whichever has it,
  // DriveWire first) -> message. The machine in use must be a CoCo 3; it is remade with the HD6309 for a 6309
  // build (a 6809 build runs on either CPU), and with the Becker port on for a DriveWire image.
  async bootNitros9(name, store = null) {
    // it reads the image from the store and mounts it: not while the library moves (nor does it then)
    this.library.checkNotMoving();
    // the person's machine (personMachine): with the chat on screen, this.shownMachine is the chat machine, and mm below
    // starts as m - so a boot that needs no switch (the same CPU, a floppy image) put the disk controller into the
    // CHAT's port and mounted there (confirmed with a real image)
    const m = this.personMachine;
    if (!Session.NITROS9_MACHINES.includes(m.id)) throw new SessionError(`NitrOS-9 boots here on the CoCo 3, not the ${m.profile.name}. Switch to the CoCo 3 first.`);
    if (!name) throw new SessionError(`No NitrOS-9 image: add your NitrOS-9 disk image (download nos96809l2v030300coco3.zip, or nos96309l2v030300coco3.zip for the HD6309, from ${NITROS9_IMAGES_URL}, unzip it, and use the file ending in _becker.dsk for DriveWire, or _40d_1.dsk for the floppy drive).`);
    const where = store ? [store] : ['drivewire', 'disk'];
    let bytes = null, found = null, failure = null;
    for (const st of where) {
      try { bytes = await this.media.read((st === 'disk' ? DISK_PREFIX : DW_PREFIX) + name); found = st; break; } catch (e) {
        if (!e || e.code !== 'not-found') failure = failure || e;   // a real storage error, not an absent image: say so
      }
    }
    if (!found) throw failure ? this.library.mediaError(failure, name) : new SessionError(`There is no image called ${name} in your library.`);
    const r = inspectOs9Disk(bytes);
    if (r.reason) throw new SessionError(`${name}: ${r.reason}`);
    const floppy = r.boot === 'floppy';
    if (floppy !== (found === 'disk')) throw new SessionError(`${name}: ${floppy ? 'a floppy image kept with the DriveWire images' : 'a DriveWire image kept with the floppy disks'}; add it again (NitrOS-9 · Add image…).`);
    // Everything above only read. From here the boot changes the machine (a switch, a cartridge, the drives, the
    // ROMs) and awaits again in its mount, so the rest of it is ONE Library operation: refused now, with nothing
    // left to await and nothing changed, if a move began during the reads; and once it has begun, a move that
    // starts during the mount waits for the boot to finish, then finds drive 0 mounted (its re-check after the
    // wait) and is refused itself. The boot is never refused halfway, so there is no half-rebuilt machine to put
    // back (the mounts run with HELD: their own move checks would refuse what the move is waiting for).
    const cpu = r.cpu === '6309' ? '6309' : m.config.cpu;
    // Drive 0 must be free before anything is switched: this mount goes into DriveWire drive 0, so an image another
    // drive already holds is refused, and the machine must be left as it was. Checked here, with the other refusals,
    // because switchMachine below has already changed the machine by the time the mount would fail.
    if (!floppy) {
      const held = this.drivewire.holderOf(DW_PREFIX + name, 0);
      if (held !== null) throw new SessionError(`${name} is already in DriveWire drive ${held}: eject it there first.`);
    }
    await this.library.libraryOp(async () => {
      let mm = m;
      if (m.config.cpu !== cpu || (!floppy && !m.config.becker)) mm = this.switchMachine(m.id, Object.assign({}, m.config, { cpu }, floppy ? {} : { becker: true }), { menu: false });
      if (floppy) {
        // the CoCo disk controller: the one in the port, else one without a ROM (our loader drives it)
        const fdc = this.drives.controller;
        if (mm.cartPort instanceof MultiPak) throw new SessionError('NitrOS-9 boots from a floppy with the disk controller in the cartridge port: take the Multi-Pak out first.');
        if (!fdc) mm.insertCartridge(new devices.cocofdc({}));
        else if (fdc.type !== 'cocofdc') throw new SessionError(`NitrOS-9 boots from the CoCo disk controller, not the ${fdc.name}.`);
        await this.drives.mount(0, DISK_PREFIX + name, { [HELD]: true });
      } else await this.mountDriveWire(0, name, { [HELD]: true });
      // accepted (the last refusal is above): booting NitrOS-9 is a launch, so a Debugger stop on the machine is
      // released and NitrOS-9 runs. The mount itself is held and launches nothing; a refused boot keeps the stop.
      this.launch(mm);
      this.endWelcome(mm);          // the machine being booted (the person's): its welcome goes, not the chat's
      this.setStubRun(mm);          // the NitrOS-9 load starts on mm (its own record, not another machine's)
      this.keys.clear();
      const kind = floppy ? 'floppy' : 'drivewire';
      mm.setRoms(Object.fromEntries(mm.profile.roms.map((x) => [x.id, x.id === 'basic' ? nitros9LoaderRom(kind) : null])));
      mm.reset(true);
      this.acc = 0;
      this.poweredOn();
    });
    this.emit('roms');
    this.emit('nitros9');
    this.emit('disks');
    const switched = cpu !== m.config.cpu ? ' (switched to the HD6309: this is the 6309 build)' : '';
    return `Booting NitrOS-9${r.cpu ? '/' + r.cpu : ''} from ${name} ${floppy ? 'in floppy drive 0' : 'over DriveWire'}${switched}`;
  }
  // back to the machine's own ROMs (BASIC), from the start; a disk controller plugged in without a ROM for the
  // floppy boot comes out (its disks are kept in the library)
  leaveNitros9() {
    // The person's machine (personMachine): bootNitros9 runs on it, and with the chat full screen this.shownMachine is the
    // chat - which never has the loader ROM, so asking this.shownMachine returned at once and did nothing (review 0.1.9).
    // The question is about m, so it is asked of m.
    const m = this.personMachine;
    if (!this.nitros9On(m)) return;
    if (m.cartPort instanceof DiskController && !m.cartPort.romBytes) { this.drives.flush(); m.ejectCartridge(); this.emit('disks'); }
    if (this.stubChosen.has(m.id)) m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, null])));
    else this.loadSavedRoms(m);
    this.powerCycle({ on: m });
    this.emit('roms');
    this.emit('nitros9');
  }
  // DriveWire to a real CoCo over a serial cable (Web Serial): a second server on the same drives, so the
  // emulated machine's Becker port and the real machine can both use them
  get webSerialAvailable() { return webSerialAvailable(this.webSerial); }
  async serveRealCoco(baud) {
    if (this.serialLink && this.serialLink.state === 'open') throw new SessionError('A real CoCo is already being served.');
    const server = this.newDriveWireServer({ clock: this.drivewire.clock });
    server.drives = this.drivewire.drives;
    const link = new SerialDriveWireLink(server, { serial: this.webSerial, onState: () => this.emit('drivewire') });
    try { await link.open(baud); } catch (e) { throw new SessionError(e.name === 'NotFoundError' ? 'No serial port chosen.' : e.message); }
    this.serialLink = link;
    this.emit('drivewire');
    return link;
  }
  async stopRealCoco() { if (this.serialLink) { await this.serialLink.close(); this.serialLink = null; } this.emit('drivewire'); }
  get realCoco() { const l = this.serialLink; return l ? { state: l.state, bytesIn: l.bytesIn, bytesOut: l.bytesOut } : null; }
  get driveWireChannels() { return [...this.dwSockets.entries()].map(([channel, s]) => ({ channel, url: s.url, state: s.state, open: this.drivewire.channelAt(channel).open })); }
  // ---------------- display (the Display tab) ----------------
  // the settings in force (a frozen object, read every frame): the stored ones, each falling back to its default
  // if missing or not valid
  get display() {
    if (!this.displayCache) {
      // the page before the Display tab kept only 'crt' or 'sharp' under 'display': carried over once, then removed
      // TODO: remove after the 1.0 release (kept until the first tagged release, for pages that saved in the old layout)
      const old = this.store.get('display');
      if (old !== null) {
        if ((old === 'crt' || old === 'sharp') && this.store.get('display.settings') === null) this.store.set('display.settings', JSON.stringify({ view: old }));
        this.store.remove('display');
      }
      let saved = {};
      try { saved = JSON.parse(this.store.get('display.settings') || '{}'); } catch (e) { /* unreadable: defaults */ }
      const d = {};
      for (const k of Object.keys(DISPLAY_DEFAULTS)) d[k] = saved && DISPLAY_VALID[k](saved[k]) ? saved[k] : DISPLAY_DEFAULTS[k];
      this.displayCache = Object.freeze(d);
    }
    return this.displayCache;
  }
  // change some settings ({ view: 'sharp' }, ...); applied to the machine, then a 'display' event. Remembered,
  // unless remember is false (a link's display settings hold for that visit only)
  setDisplay(changes, { remember = true } = {}) {
    for (const [k, v] of Object.entries(changes)) {
      if (!DISPLAY_VALID[k]) throw new SessionError(`No display setting "${k}".`);
      if (!DISPLAY_VALID[k](v)) throw new SessionError(`${JSON.stringify(v)} is not a valid value for the display setting "${k}".`);
    }
    const d = Object.assign({}, this.display, changes);
    if (remember) this.store.set('display.settings', JSON.stringify(d));
    this.displayCache = Object.freeze(d);
    this.applyDisplay();
    this.emit('display');
    return this.display;
  }
  // composite colour follows the view: on with the chosen phase for CRT, off for Sharp
  applyDisplay() {
    const d = this.display;
    this.shownMachine.setComposite(d.view === 'crt' ? d.phase : 0);
    this.applyScreen();
  }
  // Which of the machine's screens render() returns. Only the Dragon 64 Plus has two; a machine with one
  // screen has no `view` to set, so the setting is simply not applied to it. The chat machine (startChat) always
  // shows its VDG screen, whatever is chosen for BASIC: its firmware draws there, and it has no character
  // generator for the 80-column board, which would draw nothing.
  applyScreen() {
    const m = this.shownMachine, d = this.display;
    if (!('view' in m)) return;
    const chat = !!this.chatMachines && m === this.chatMachines.chat;
    m.view = d.screen === 'plus' && !chat ? 'plus' : 'vdg';
  }
  // does this machine offer a second screen to choose between?
  get hasTwoScreens() { return !!this.shownMachine && 'view' in this.shownMachine; }
  // whether the artifact phase means anything on this machine: NTSC machines (the MC6847's 256x192 mode, the
  // CoCo 3's compatibility modes)
  get hasArtifactPhase() { return this.shownMachine.profile.video === 'ntsc'; }
  // whether this machine takes a Multi-Pak: the profiles marked `multiPak` (js/machines/profiles.js), the machines
  // it was compared with MAME on: the Color Computer 1/2 and its clones coco2b, mx1600, lzcolor64 and cd6809
  // (`run.js coco --cart multi`), the Dragon 32 and 64 and the CoCo 3 (`run.js <dragon32|dragon64|coco3> --cart
  // multi`).
  //
  // The others are left out because they are NOT YET VERIFIED here, not because MAME lacks the device: the Dragon
  // 200, 200-E and Tano, the Dragon Alpha, the PAL CoCo 3 and the Prologica CP 400 wait for their own comparison.
  // The MC-10 and Alice have no cartridge port at all;
  // their `ext multi` is a different device ("Fred_72 and 6502man's Multiports Extension"), not a Multi-Pak.
  get hasMultiPak() {
    const p = this.shownMachine && this.shownMachine.profile;
    return !!(p && p.multiPak);
  }

  // ---------------- SAM CPU rate and the POKE book (Dragon, CoCo 1/2) ----------------
  // the CPU rate the SAM is set to: { rate (R1..R0), label }, or null on machines without an MC6883
  cpuRate() {
    const m = this.shownMachine;
    if (!m.sam) return null;
    const r = m.sam.rate, slow = (m.tickHz / 1e6).toFixed(2), fast = (2 * m.tickHz / 1e6).toFixed(2);
    return { rate: r, label: r === 0 ? `${slow} MHz` : r === 1 ? `address-dependent (${slow} / ${fast} MHz)` : `${fast} MHz` };
  }
  // the POKE book for this machine: [{ text, about, chip, ready, bit?, set? }] (ready: can be typed now; bit/set:
  // the SAM rate bit it sets or clears), [] without a SAM
  // The POKE book is the person's: its entries and the POKE itself act on personMachine (the BASIC session while the
  // chat is full screen). With this.shownMachine a POKE picked from the book while the chat was on screen was typed into
  // the CHAT machine - into the chat firmware, whose keys are a conversation line.
  pokeBook() {
    const m = this.personMachine;
    if (!m.sam) return [];
    return POKES.filter((p) => !p.bank || m.profile.bankSelect)
      .map((p) => Object.assign({ text: p.text, about: p.about, chip: p.chip, ready: !p.basic || !m.useStub }, 'bit' in p ? { bit: p.bit, set: p.set } : {}));
  }
  typePoke(i) {
    const p = this.pokeBook()[i];
    if (!p) throw new SessionError('No such POKE book entry.');
    if (!p.ready) throw this.needsRom(p.text);
    // On the stub with a program running (the welcome menu, LIZA), the typed line would be that program's keys
    // (a digit is a menu choice): do what the stub's prompt does with the line, the store, at once.
    const m = this.personMachine, poke = m.useStub && !m.atStubPrompt() && /^POKE (\d+),(\d+)$/.exec(p.text);
    if (poke) { this.personInput(m); m.write(+poke[1] & 0xFFFF, +poke[2] & 0xFF); this.checkRate(); return `Done: ${p.text}`; }
    this.typeText(p.text + '\n', m);
    return `Typed ${p.text}`;
  }
  // called after frames run: a 'rate' event when the SAM rate changed
  checkRate() {
    const r = this.cpuRate();
    if (r && r.rate !== this.lastRate) { this.lastRate = r.rate; this.emit('rate'); }
  }
  // Reset and power without ROMs behave like a real computer, never a dead end:
  // the stub firmware's bare "NO ROM LOADED" screen is not where a button leaves you. Reset restarts what runs
  // on the stub from its own entry point (the welcome menu, LIZA, a binary with an exec address: `stubRun`, the
  // machine's own record in `stubRuns`); with
  // nothing to restart, and on every power-on without ROMs, the Session emits ('menu', 'back') and the page starts
  // the welcome menu, as a visit does. With ROMs,
  // reset and power-on are BASIC's.
  // Reset and power cycle drop any frames owed to real time (no catch-up burst after them); 'reset' event
  // With the chat full screen, Reset is the SHOWN machine's, deliberately: the screen's Reset restarts what is
  // running on screen, which is the chat firmware, and it comes back running (tests/chat-leaks.test.js pins it: its
  // reset count moves, nothing else of it does, and the person's session is untouched). A POWER CYCLE is different:
  // the physical switch is the person's machine's (powerCycle defaults to personMachine), because switching off would
  // wipe the chat firmware rather than restart it.
  reset() {
    this.leaveSharedMoment();
    this.stopClaudeFor('you reset the machine');
    this.launch();
    const m = this.shownMachine, again = this.stubRun && this.stubRun.m === m && m.useStub ? this.stubRun : null;
    this.forgetOpenedProgram(m);
    this.endWelcome(m);
    this.keys.clear();
    this.drives.fitRom(m);
    if (again) this.restart(again);
    else { this.setStubRun(m); m.reset(false); this.warmReset = { m, resetAt: m.frameCount }; }
    this.acc = 0;
    this.emit('reset');
    if (!again) this.offerMenu(null, 'reset');
  }
  // A power cycle keeps what is inserted, as on real hardware: the cartridge (and so a disk controller's disks)
  // and the tape where it was; only RAM, the chips and the CPU start over. menu: false when the caller starts a
  // program next (startWelcome).
  // reason: the note when this stops Claude (the Power cycle button says the person did it; ROMs added, Run without
  // ROMs and the like restart the machine without being asked to power cycle it)
  // on: the machine to power cycle. THE DEFAULT IS THE PERSON'S MACHINE (personMachine), not the one on screen: while
  // the chat is full screen the machine on screen runs the chat firmware, and a person-facing power cycle - the
  // screen's Power button, the boot box's Switch off and on - wiped it. The chat's own power comes from its own code
  // (it always passes the chat machine), never from this default.
  powerCycle({ menu = true, reason = 'the machine restarted', on = null } = {}) {
    const m = on || this.personMachine;
    if (m === this.personMachine) this.leaveSharedMoment();
    this.forgetOpenedProgram(m);
    // A load on the BASIC session while the chat is open passes that session, and this stops Claude only when it is
    // the machine Claude acts on (stopClaudeFor's own rule: chatTarget()). In the full-screen chat that IS the BASIC
    // session, so a load there stops Claude (as before); in the side panel the conversation acts on the machine it
    // runs beside, so its reply goes on - the decision this makes deliberate rather than incidental.
    this.stopClaudeFor(reason, m);
    this.launch(m);
    this.endWelcome(m);     // the machine being powered (the person's), not whichever one is on screen
    this.dropRemovedRoms(m);
    this.setStubRun(m);
    this.keys.clear();
    this.drives.flush();
    // a power cycle keeps what is inserted, as on real hardware, so the Pak's option decides it again from the
    // ROMs that are stored (it is already in the port when nothing has changed)
    // A socket another tab changed while this machine ran the old ROM (romElsewhere): switching off and on is when
    // it takes what is stored now, as the ROM screen says. Only then: otherwise the ROMs in place are the stored ones.
    if (!this.stubChosen.has(m.id) && m.profile.roms.some((x) => this.romElsewhere(m.id, x.id))) this.loadSavedRoms(m);
    this.applySscOption(m);
    this.drives.fitRom(m);
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    if (menu) this.offerMenu(null, 'reset');
  }
  // ROMs removed from storage while m ran them come out now, at a switch off and on: its sockets are filled again
  // from what is stored, and a disk cartridge whose ROM was removed is left without one
  dropRemovedRoms(m) {
    const left = this.romsLeft.get(m);
    if (!left || !left.size) return;
    this.romsLeft.delete(m);
    if (Object.values(m.romCrcs()).some((c) => left.has(c))) this.loadSavedRoms(m);
    const cart = m.cartPort;
    if (cart && cart.romBytes && cart.romBytes.length && left.has(crc32(cart.romBytes)) && cart.fitRom) { cart.fitRom(null); m.cartridgeChanged(); }
  }
  // no ROMs, nothing running: the welcome menu, greeting the visitor back (the page has its bytes)
  // The event's argument is how the menu is offered: 'back' (a returning visit) or 'bye' (back from a program) as
  // before, or 'none' from the machine question's switch, which starts the menu without a carry-on line.
  // reason: why (WELCOME_REASONS): the start that follows takes it unless it names its own, and the tune is silent
  // for a switch, a reset and a return (the welcome tune plays only when the menu was asked for)
  offerMenu(offer = null, reason = 'switch') {
    // the person's machine (personMachine): a Reset after a load on the chat screen used to offer the welcome menu
    // to the CHAT machine, which never runs it, and the page acted on that (review probe B)
    const m = this.personMachine;
    if (this.welcomeMenu && m.useStub && WELCOME[cpuFamily(m.config.cpu)]) { this.menuReason = reason; this.emit('menu', offer || 'back'); }
  }
  // run segments at exec (Machine.injectAndRun), remembering them as the stub's program to restart on Reset.
  // on: the machine to run them on (loadMedia's target: the BASIC session while the chat is full screen), else the
  // machine in use. The restart-on-Reset record follows that machine, so Reset restarts the program on the machine
  // the person sees it on.
  inject(segments, exec, on = null) {
    const m = on || this.shownMachine;
    this.cancelLoadTyping(m);
    this.forgetOpenedProgram(m);
    this.stopClaudeFor('you started a program', m);   // (as loadMedia: a program run with ROMs is not a reset)
    m.injectAndRun(segments, exec);
    // (keyed by the machine it ran on, so Reset restarts it only on that machine: Session.reset checks stubRun.m)
    this.setStubRun(m, m.useStub && exec != null
      ? { m, segments: segments.map((s) => ({ addr: s.addr, data: s.data.slice() })), exec, watch: null, welcome: null } : null);
  }
  // start a stub program again from its entry point: the welcome menu as it was, or the bytes and exec address
  restart(r) {
    if (r.welcome) { this.startWelcome(r.welcome.bytes, Object.assign({}, r.welcome, { reason: 'reset' })); return; }
    this.shownMachine.injectAndRun(r.segments, r.exec);
    this.setStubRun(this.shownMachine, r);
    if (r.watch) this.watchForMenu(r.watch, r.m);
  }
  // The person leaves a shared moment they arrived on (openSnapshot's sharedMoment, and arrivedFromLink): a Reset, a
  // power cycle (Start over) or a machine switch. 'arrival' tells the page to show its no-ROM card and pill again, and
  // to take its arrival card down.
  leaveSharedMoment() {
    if (!this.sharedMoment && !this.arrivedFromLink) return;
    this.sharedMoment = false;
    this.arrivedFromLink = null;
    this.emit('arrival');
  }
  // the person acted on the machine they arrived on (touch): no longer "just arrived" (the shared moment itself, which
  // only a Reset, power cycle or switch leaves, stays)
  settleArrival(m) {
    if (!this.arrivedFromLink || m !== this.personMachine) return;
    this.arrivedFromLink = null;
    this.emit('arrival');
  }
  // after a hard reset: the firmware may have changed (ROMs or the stub) and the SAM rate is back to slow
  poweredOn() {
    this.warmReset = null;   // a power-on arms the boot watchdog again, even in the frame of a Reset (same resetAt)
    // a power-on is a fresh try at the ROMs: a machine whose ROMs did not start BASIC is tried again after one
    // (the 'Switch off and on' the boot box offers is exactly that, and so is a ROM added or the machine switched)
    this.bootFailed.clear();      // a power-on is a fresh try at the ROMs, for every machine
    this.lastRate = this.cpuRate() && this.cpuRate().rate;
    this.emit('firmware');
  }

  // ---------------- ROMs ----------------
  // Dropped ROM images are identified against every model (js/roms.js) and stored per machine, so one
  // drop sets up every machine it fits. Returns
  //   { files: [{ name, size, crc, result, targets, message }], machines: [{ id, name, bootable, sockets }],
  //     cartridges: [{ id, name, sockets }], bootable: [machine ids that can now boot BASIC],
  //     offers: [{ machine, name, files }] }
  // result: 'verified' | 'loaded-unrecognised' | 'rejected' | 'ignored'. offers name the other machines this
  // drop made ready (a ROM for another machine is an offer to switch, not an error), except one whose sockets
  // hold the same ROMs as the machine in use. The machine in use is
  // power cycled if its ROMs changed.
  addRoms(files) {
    // the index's writes go to the store, which the move is copying: a drop may not land in the old one after it
    this.library.checkNotMoving();
    const m = this.personMachine, owners = romOwners();
    const { files: results } = identifyRoms(files, owners, m.id);
    const touched = new Map();   // owner id -> file names
    for (const r of results) for (const t of r.targets) {
      this.roms.put(t.machine, t.socket, t.bytes, r.name);
      if (!touched.has(t.machine)) touched.set(t.machine, []);
      if (!touched.get(t.machine).includes(r.name)) touched.get(t.machine).push(r.name);
    }
    for (const id of touched.keys()) this.stubChosen.delete(id);
    if (touched.has(m.id)) { this.loadSavedRoms(m); this.powerCycle({ on: m }); }
    const ids = [...touched.keys()];
    const machines = ids.filter((id) => profiles[id]).map((id) => this.machineRoms(id));
    const cartridges = ids.filter((id) => cartridgeRoms[id]).map((id) => ({ id, name: cartridgeRoms[id].name, sockets: socketStatus(cartridgeRoms[id], this.roms.get(id)) }));
    // (not a machine whose sockets now hold exactly the ROMs of the machine in use, as the Dragon 64 and the Tano
    // Dragon 64 do: switching to it would change nothing the drop is about)
    const crcs = (id) => this.machineRoms(id).sockets.map((s) => s.crc || '').join(',');
    const offers = machines.filter((x) => x.bootable && x.id !== m.id && crcs(x.id) !== crcs(m.id)).map((x) => ({ machine: x.id, name: x.name, files: touched.get(x.id) }));
    this.emit('roms');
    return { files: results, machines, cartridges, bootable: machines.filter((x) => x.bootable).map((x) => x.id), offers };
  }
  // socket status of a machine's stored ROMs (default: the one in use; also while it runs the stub)
  machineRoms(id = this.shownMachine.id) {
    const p = profiles[id], roms = this.roms.get(id);
    const sockets = socketStatus(p, roms).map((s) => Object.assign(s, { file: this.roms.fileName(s.crc) }));
    return { id, name: p.name, bootable: isBootable(p, roms), sockets };
  }
  // every machine with at least one ROM stored
  // The ROMs stored in this browser, for the Library's ROMs card: { count: the images stored (one dump in the
  // sockets of several models counts once), users: the names of the machines and cartridges whose sockets hold them,
  // in profile order }
  storedRoms() {
    const sockets = this.roms.sockets(), owners = romOwners();
    return { count: new Set(sockets.map((x) => x.crc)).size, users: [...new Set(sockets.map((x) => x.owner))].map((id) => owners[id].name) };
  }
  // The Library's ROM tiles: each image stored, once -> [{ crc, name, size, owners: [id], users: [name] }], in the
  // order of the first owner (profile order: the machines, then the cartridges). name: the file it came from, or
  // "ROM <CRC>" when none was kept.
  romFiles() {
    const owners = romOwners();
    return [...new Set(this.roms.sockets().map((s) => s.crc))].map((crc) => {
      const ids = this.roms.usedBy(crc);
      return { crc, name: this.roms.fileName(crc) || `ROM ${crc}`, size: this.roms.image(crc).length, owners: ids, users: ids.map((id) => owners[id].name) };
    });
  }
  // Remove one ROM image from every socket that holds it, at once (the index writes it to the store). A machine
  // running it keeps it, as a chip already in its socket, until it is next switched off and on (powerCycle drops it
  // then): the machine is not reset. -> { crc, name, bytes, sockets, running: the name of the person's machine when
  // it runs this image (in its own sockets or its cartridge's), else null }: what restoreRom needs for Undo.
  removeRom(crc) {
    this.library.checkNotMoving();
    const removed = this.roms.remove(crc);
    if (!removed) throw new SessionError('That ROM is not stored.');
    const m = this.personMachine;
    let running = null;
    if (this.runningRomCrcs(m).has(crc)) {
      if (!this.romsLeft.has(m)) this.romsLeft.set(m, new Set());
      this.romsLeft.get(m).add(crc);
      running = m.profile.name;
    }
    this.emit('roms');
    return Object.assign(removed, { running });
  }
  // Undo a removeRom: the image goes back, byte for byte, into every socket it was in that is still empty; a socket
  // given another ROM since keeps that one (skipped). A machine that still runs the image forgets it was removed; one
  // switched off and on since without it (in its own sockets, or a disk cartridge left without its ROM) takes it back
  // and restarts, as a drop of that ROM would.
  // -> { restored, skipped: [{ owner, socket, name: "Dragon 64 BASIC" }] }
  restoreRom(removed) {
    this.library.checkNotMoving();
    const { restored, skipped } = this.roms.restore(removed);
    const owners = romOwners(), named = (s) => Object.assign({ name: `${owners[s.owner].name} ${owners[s.owner].roms.find((x) => x.id === s.socket).label}` }, s);
    const m = this.personMachine, left = this.romsLeft.get(m);
    const mine = restored.some((s) => s.owner === m.id), cartridge = restored.some((s) => cartridgeRoms[s.owner]) && !!this.drives.bareController;
    if (left && left.has(removed.crc)) {
      // still running it: forgotten as removed, unless one of its own sockets kept another ROM (that one goes in at the
      // next switch off and on)
      if (!skipped.some((s) => s.owner === m.id)) left.delete(removed.crc);
    } else if ((mine && !this.stubChosen.has(m.id)) || cartridge) {
      if (mine) this.loadSavedRoms(m);
      this.powerCycle({ on: m });
    }
    this.emit('roms');
    return { restored: restored.map(named), skipped: skipped.map(named) };
  }
  // the CRCs of the ROMs m runs now: its own sockets and its cartridge's ROM
  runningRomCrcs(m) {
    const out = new Set(Object.values(m.romCrcs()));
    const cart = m.cartPort && m.cartPort.romBytes;
    if (cart && cart.length) out.add(crc32(cart));
    return out;
  }
  // the ROMs removed from storage that m still runs (Your ROMs: "Removed · still in the running machine")
  romsStillRunning(m = this.personMachine) { return new Set(this.romsLeft.get(m) || []); }
  machinesWithRoms() {
    return Object.keys(profiles).map((id) => this.machineRoms(id)).filter((x) => x.sockets.some((s) => s.status !== 'missing-required' && s.status !== 'missing-optional'));
  }
  // on: the machine to load them onto (the default is the machine in use; a load on the BASIC session while the chat
  // is full screen loads them onto that session, not onto the chat machine, whose firmware must stay in place)
  loadSavedRoms(on = null) {
    const m = on || this.shownMachine, stored = this.roms.get(m.id);
    m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, stored[x.id] || null])));
  }
  romDescription() {
    const r = this.machineRoms();
    if (!r.bootable) return `No BASIC ROM: running without ROMs, machine code only. Needs ${r.sockets.filter((s) => s.status === 'missing-required').map((s) => s.label).join(', ')}.`;
    return r.sockets.map((s) => `${s.label}: ${s.status.replace('-', ' ')}`).join(' · ');
  }
  // forget the ROMs of the machine in use (the index's writes: not while the library moves, as addRoms)
  clearRoms() {
    this.library.checkNotMoving();
    // the person's machine (personMachine): with the chat full screen this used to clear and reset the CHAT machine
    // and leave the person's own session on "NO ROM LOADED"
    const m = this.personMachine;
    this.roms.clear(m.id);
    this.loadSavedRoms(m);
    this.setStubRun(m);
    m.reset(true);
    this.emit('roms');
    this.poweredOn();
    this.offerMenu(null, 'reset');
  }
  // Run the built-in stub firmware on the machine the person is working on (personMachine: the BASIC session while
  // the chat is full screen), also when ROMs are loaded. The load's fall-back for stored ROMs that do not start
  // BASIC calls this; on the machine in use it stripped the CHAT machine's ROMs and power cycled the chat, which left
  // its screen on "NO ROM LOADED" (review probe A).
  runWithoutRoms({ menu = true } = {}) {
    const m = this.personMachine;
    m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, null])));
    this.stubChosen.add(m.id);
    this.powerCycle({ menu, on: m });
    this.emit('roms');
  }
  // ROM pack: all stored ROMs as one local ZIP file -> { name, bytes }
  exportRomPack() {
    const { entries } = makeRomPack(this.roms);
    return { name: 'cloadm-roms.zip', bytes: writeZip(entries) };
  }
  static isRomPack(zipEntries) { return isRomPack(zipEntries); }
  // restore a ROM pack (its ZIP entries) -> { machines, skipped }; the machine in use reloads its ROMs
  // ROM pack: restored into the index, which writes to the store (not while the library moves, as addRoms)
  importRomPack(zipEntries) {
    this.library.checkNotMoving();
    const { restored, skipped } = restoreRomPack(zipEntries, this.roms, romOwners());
    const ids = [...new Set(restored.map((r) => r.machine))];
    for (const id of ids) this.stubChosen.delete(id);
    const pm = this.personMachine;
    if (ids.includes(pm.id)) { this.loadSavedRoms(pm); this.powerCycle({ on: pm }); }
    this.emit('roms');
    return { machines: ids.filter((id) => profiles[id]).map((id) => this.machineRoms(id)), skipped };
  }

  // ---------------- screen and boot watchdog ----------------
  // The text screen as strings, one per row at its full width, from the one screen reader Claude's screen_text uses
  // (js/claude/readtools.js screenRows): the VDG's 32x16 page, every CoCo 3 GIME text mode, the CoCo 3's page where
  // the display reads it whatever the MMU shows the CPU, and the Dragon 64 Plus's 80 columns while shown; a screen it
  // cannot read as text gives the VDG page, as before. `main: true` reads the main (VDG) screen even while the Plus
  // board is shown.
  screenText(m = this.shownMachine, { main = false } = {}) {
    return screenRows(m, (a) => this.readByte(a, m), { main });
  }
  // The screen as text, for the page's text alternative of the screen canvas (what a screen reader or a reader view
  // gets instead of the picture): the machine on screen read as Claude's screen_text reads it (one reader: every
  // text mode it can walk, the CoCo 3's GIME and the Dragon 64 Plus's 80 columns included), its rows from the first
  // with text joined by "\n".
  // A screen it cannot read as text says so in a sentence, as does one of semigraphics blocks only or an empty one.
  screenAlternative(m = this.shownMachine) {
    const r = screenTextTool({ machine: m, readByte: (a) => this.readByte(a, m) });
    if (!r.text) return `The screen shows a picture, not text (${r.mode}).`;
    // (blank rows above the first line of text are where it sits on the screen, not text: left out)
    const from = r.lines.findIndex((l) => l.trim());
    if (from >= 0) return r.lines.slice(from).join('\n');
    return r.semigraphics ? 'The screen shows block graphics, no text.' : 'The screen is blank.';
  }
  // Did BASIC start? 'stub' (no ROMs in use), 'nitros9' (our NitrOS-9 loader instead of BASIC: bootNitros9),
  // 'ok' (BASIC printed OK), 'booting', 'restored' (a snapshot was opened: not a power-on, so not a boot), or
  // 'failed' when no OK appeared within `seconds` of emulated time after a power-on; then `cause` explains it from
  // the sockets. The latch (bootOk) records the power-on whose OK was seen, so a screen that scrolls OK away does
  // not go back to 'booting'. It is keyed by MACHINE as well as by reset, because frameCount and framesSinceReset
  // are per-machine and two machines can share the same arithmetic (a freshly made chat machine and a BASIC machine
  // at power-on are both 0): unkeyed, one machine's 'ok' would satisfy the other's check. bootStatus() and
  // chatTarget().bootStatus() both come here, so the two views of one machine cannot disagree.
  bootStatus(seconds = 5) { return this._bootStatusOf(this.shownMachine, seconds); }
  _bootStatusOf(m, seconds = 5) {
    if (!m.hasRom) return { state: 'stub' };
    if (this.nitros9On(m)) return { state: 'nitros9' };   // our NitrOS-9 loader, not BASIC: no OK to wait for
    const resetAt = m.resetAt;                            // identifies the current power-on or reset
    if (this.bootOk && this.bootOk.m === m && this.bootOk.resetAt === resetAt) return { state: 'ok' };
    if (this.screenText(m, { main: true }).some((l) => l.trim() === 'OK')) { this.bootOk = { m, resetAt }; return { state: 'ok' }; }
    if (m.framesSinceReset < seconds * m.fps) return { state: 'booting' };
    // The watchdog is for a power-on. A moment opened from a snapshot was not one: the program it holds may have
    // taken the screen from BASIC (a game, a program that took over Reset) or never printed OK at all, and coming
    // back to it is not a boot that failed (m.restored: set by Machine.restore, cleared by every reset).
    if (m.restored) return { state: 'restored' };
    // After the Reset button RAM is kept and BASIC's reset routine may jump through the warm-start vector a
    // program set, so no OK is not a boot failure either: 'reset', with `takeover` when a program holds that
    // vector (warmStartTakeover).
    if (this.warmReset && this.warmReset.m === m && this.warmReset.resetAt === resetAt) return { state: 'reset', takeover: warmStartTakeover(m) };
    // the sockets are the Session's, keyed by machine; ask about THIS machine rather than the one on screen
    const sockets = (m === this.shownMachine ? this.machineRoms() : this.machineRoms(m.id)).sockets;
    const odd = sockets.filter((s) => s.status === 'loaded-unrecognised');
    const cause = odd.length
      ? odd.map((s) => `The ${s.label} is ${s.file || 'a file'}, which isn't recognised.`).join(' ') + ' It may be a different revision, a damaged copy, or for another machine.'
      : 'The ROMs are recognised, so this looks like a problem in CLOADM. Please report it.';
    return { state: 'failed', seconds, cause, sockets };
  }

  // ---------------- settings and sharing (never ROMs) ----------------
  // settings export: every stored setting except ROMs and stored media files
  exportSettings() {
    const keys = (this.store.keys ? this.store.keys() : []).filter((k) => validSetting(k, this.store.get(k))).sort();
    return { format: 'cloadm-settings', version: 1, settings: Object.fromEntries(keys.map((k) => [k, this.store.get(k)])) };
  }
  // settings import: an exportSettings() object (or its JSON text) -> { applied: [keys], ignored: [keys] }.
  // Only the allowed settings with valid values come in (SETTINGS, validSetting): ROMs, media, unknown keys and
  // bad values are ignored; a file that isn't CLOADM settings is refused. The page reloads to take them up; the Session already uses the display settings.
  importSettings(data) {
    let d = data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { throw new SessionError('This is not a CLOADM settings file (not JSON).'); } }
    if (!d || d.format !== 'cloadm-settings') throw new SessionError('This is not a CLOADM settings file.');
    if (d.version !== 1) throw new SessionError(`These settings are from a newer CLOADM (version ${d.version}); this one reads version 1.`);
    if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) throw new SessionError('This settings file has no settings in it.');
    const applied = [], ignored = [];
    for (const [k, v] of Object.entries(d.settings)) {
      if (validSetting(k, v)) { this.store.set(k, v); applied.push(k); } else ignored.push(k);
    }
    this.displayCache = null;
    return { applied, ignored };
  }
  // share link: the machine and its options as URL parameters (js/config.js), nothing else
  // extra: more of the link's settings (claudeLink's app=claude), which override the machine's own
  shareUrl(base, extra = {}) {
    const m = this.shownMachine, config = {};
    // the machine's options, except the ones that describe the comparison or a device in a port rather than
    // the machine: a link opens the model, not the contents of its cartridge slot
    const LOCAL = new Set(['mameCompat', 'hires']);
    for (const [k, v] of Object.entries(m.config)) if (!LOCAL.has(k) && m.profile.options[k]) config[k] = v;
    // NitrOS-9 running: the link boots it from the recipient's own image (never ours, never its name)
    return buildUrl(base, { machine: m.id, config, nitros9: this.nitros9On(m), ...extra });
  }
  // A program's page (js/program-pages.js: cloadm.dev/<id>/, with its own link preview and a Play button for its start
  // link) -> its address, from `base` (the page's own address: the site's root, or /play/ under it); null when the
  // program has no page
  programPageUrl(id, base) {
    if (!programPage(id)) return null;
    const here = new URL('./', base);
    return new URL(`${/\/play\/$/.test(here.pathname) ? '../' : ''}${id}/`, here).href;
  }
  // The link a page shown inside another site offers in place of the chat ("Ask Claude ↗", js/ui/ask-popout.js): this
  // moment, as the Share screen's link carries it (snapshotLink), with app=claude, so it opens top-level in a new tab
  // with the chat. Never embed=1 (buildUrl writes only what it is given). A moment that cannot be carried (NitrOS-9
  // runs: its memory is the person's own NitrOS-9; or a snapshot that can't be shared) gives a fresh CLOADM on the same
  // machine with app=claude instead. -> { href, carried }
  async claudeLink(base) {
    let file = null;
    if (!this.nitros9OnScreen) {
      try { file = await this.shareFile(); } catch (e) { if (!(e instanceof SessionError)) throw e; }
    }
    if (!file) return { href: this.shareUrl(base, { app: 'claude', nitros9: null }), carried: false };
    return { href: `${this.shareUrl(base, { app: 'claude' }).split('#')[0]}#z=${toBase64Url(await encodeLongLink(file.moment.snap, file.moment.meta))}`, carried: true };
  }

  // ---------------- snapshots ----------------
  // A snapshot holds the machine, its config, its state and the CRCs of the ROMs it ran with (never the ROMs).
  // Opening one: readSnapshot (the file), snapshotSwitch (does the machine in use have to change? ask first),
  // openSnapshot (switches if needed, sets the same ROMs from this browser's or the stub, restores).

  // the long link (Share): this machine's link with the moment in the fragment (#z=, base64url of
  // js/media/snapshot.js encodeLongLink, so it never reaches a server). Opening it: readSnapshotLink,
  // then the usual snapshot flow. The snapshot is the shared one (shareFile): no byte of a ROM or cartridge image, only
  // references to them. file: a shareFile already made for this moment (the Share screen offers both), or made here
  async snapshotLink(base, file = null) {
    const f = file || await this.shareFile();
    return `${this.shareUrl(base).split('#')[0]}#z=${toBase64Url(await encodeLongLink(f.moment.snap, f.moment.meta))}`;
  }
  // ---------------- short links ----------------
  // Why the moment on screen can't be put in a long link, or null when it can (the Share screen shows the reason beside
  // the switched-off choice): NitrOS-9's memory is the person's own NitrOS-9 (shareFile).
  longLinkRefusal(m = this.shownMachine) {
    return this.nitros9On(m) ? 'Not for a NitrOS-9 moment: its memory holds your own NitrOS-9. The link below boots NitrOS-9 from their image instead.' : null;
  }
  // Why the moment on screen can't have a short link, or null when it can. A short link is stored on a server, so it is
  // only for moments with no code from anyone's ROM or cartridge in them at all (romCodeIn null): a long link of such a
  // moment carries references, not the code, but a short link is offered only where there is nothing to refer to.
  shortLinkRefusal(m = this.shownMachine) {
    const n9 = this.longLinkRefusal(m);
    if (n9) return n9;
    const why = this.romCodeIn(m);
    if (why === 'roms') return 'Not for a moment on your own ROMs: short links are only for machines running without ROMs. The long link works (whoever opens it adds their own ROMs).';
    if (why === 'cartridge') return 'Not with a cartridge plugged in: short links are only for machines running without ROMs or cartridges. The long link works.';
    return null;
  }
  // The share card (js/video/bezel.js shareCardPicture): the machine's picture at true pixels in the CRT frame, the
  // program's or machine's name beside it and "cloadm.dev" on its lip, 1200 x 630. One renderer for both of its uses:
  //  - sharePicture: the Share screen's "Save picture", every colour the frame's own -> PNG bytes;
  //  - previewPicture: the preview a short link may carry, an indexed PNG of at most SHORT_PNG.colours colours and
  //    SHORT_PNG.bytes -> bytes, or null when this picture can't be one (its colours don't all fit, or it is too large).
  // name: what the card says beside the monitor (shareCardName)
  shareCardName(base, m = this.shownMachine) {
    const p = base ? this.bundledProgram(base, m) : null;
    return p ? p.name : m.profile.name.replace(/^Tandy /, '');
  }
  async sharePicture(name, m = this.shownMachine) {
    return encodeIndexedPng(shareCardPicture(m.render(), { name: name || this.shareCardName(null, m) }));
  }
  async previewPicture(m = this.shownMachine, name = null) {
    const card = shareCardPicture(m.render(), { name: name || this.shareCardName(null, m), colours: Session.SHORT_PNG.colours });
    if (!card.exact) return null;
    const png = await encodeIndexedPng(card);
    return png.length <= Session.SHORT_PNG.bytes ? png : null;
  }
  // The moment on screen as a short link (Share): sealed in this browser (js/media/link-crypto.js), stored by `store`
  // (js/host/link-store.js), its key only in the link's fragment; name: the share card's (shareCardName) -> { url, id, deleteToken, picture: whether the
  // preview went with it, pictureNote: why not when it was asked for and couldn't }. SessionError when this moment
  // can't have one (shortLinkRefusal), is too large, or the store refused (its message).
  async shortLink(store, { preview = true, now = new Date(), file = null, name = null } = {}) {
    const m = this.shownMachine, why = this.shortLinkRefusal(m);
    if (why) throw new SessionError(why);
    const f = file || await this.shareFile(now);
    const { key, sealed } = await sealMoment(f.bytes);
    if (sealed.length > Session.SHORT_SEALED_MAX) throw new SessionError(`This moment is too large for a short link (${Math.ceil(sealed.length / 1024)} KB; the most is ${Session.SHORT_SEALED_MAX / 1024} KB). The long link works.`);
    const png = preview ? await this.previewPicture(m, name) : null;
    let r;
    try { r = await store.create({ machine: m.id, sealed, png }); }
    catch (e) { throw new SessionError(e.message); }
    return { url: store.url(r.id, key), id: r.id, deleteToken: r.deleteToken, picture: !!png,
      pictureNote: preview && !png ? 'This screen has too many colours for a preview picture, so the link has none.' : null };
  }
  // a URL's fragment ('#l=<id>.<key>', where a short link's arrival page sends it) -> { snap, id }, null when it has
  // none; SessionError saying why it can't open (removed, damaged, not reachable)
  async readShortLink(hash, store) {
    const m = /^#?l=([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]+)$/.exec(hash || '');
    if (!m) {
      if (/^#?l=/.test(hash || '')) throw new SessionError('This short link is damaged: copy the whole link, with the part after #.');
      return null;
    }
    let sealed, bytes;
    try { sealed = await store.load(m[1]); } catch (e) { throw new SessionError(e.message); }
    try { bytes = await openMoment(sealed, m[2]); } catch (e) { throw new SessionError(`This short link can't be opened: ${e.message}`); }
    return { snap: await this.readSnapshot(bytes), id: m[1] };
  }

  // The moment as a file to give to someone (the Share screen's link and snapshot file): the snapshot with its ROM
  // code taken out (js/media/romrefs.js). The machine's ROMs, a cartridge's image and a disk controller's DOS ROM
  // are named by CRC, and every copy of their code in memory becomes a reference; whoever opens it needs the same
  // images and rebuilds the moment from their own (snapshotRoms, openSnapshot). AGENTS rule 1: no ROM byte leaves.
  async shareFile(now = new Date()) {
    const m = this.shownMachine;
    // NitrOS-9's memory is the user's own NitrOS-9 image: a moment of it is never put in a link. shareUrl's link
    // (nitros9=1) boots NitrOS-9 from the recipient's own image instead.
    if (this.nitros9On(m)) throw new SessionError('A NitrOS-9 moment isn\'t shared as a snapshot: its memory holds your NitrOS-9. The link boots NitrOS-9 from their own DriveWire image instead.');
    const own = m.profile.roms.filter((r) => m.roms[r.id]).map((r) => ({ crc: crc32(m.roms[r.id]), bytes: m.roms[r.id], kind: 'rom', label: r.label }));
    let snap;
    try { snap = stripRoms(m.snapshot(), own); }
    catch (e) { throw new SessionError(`This snapshot can't be shared: ${e.message}. Share the picture or a clip instead.`); }
    const meta = { name: m.profile.name, taken: now.toISOString(), program: this.momentProgram(m) };
    const bytes = await encodeSnapshot(snap, meta);
    // moment: what the file holds, for snapshotLink to write the same moment in the link's form
    return { name: `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${stamp(now)}${SNAPSHOT_EXT}`, bytes, needs: snap.share.images, dropped: snap.share.dropped, moment: { snap, meta } };
  }
  // Can ROM code be in the machine's memory? 'roms' (the user's own ROMs are loaded), 'cartridge' (a cartridge is
  // plugged in), 'nitros9' (NitrOS-9 from the user's own image runs: bootNitros9) or null (the built-in stub, no
  // cartridge). Memory can hold copies of ROM code: BASIC copies itself
  // into RAM (the Dragon 64 in its all-RAM mode, the CoCo 3 always), a program can copy any ROM, and a cartridge's
  // image is someone's ROM too. The embed API's peek asks first (js/embed-api.js): it hands memory to another
  // page as it is. (Shared snapshots take the ROM code out instead: shareFile.)
  // `m` is the machine the caller is about to read: the ROM guard must ask the SAME machine as the read, or it passes
  // for the wrong one (the embed API asks it about the person's machine and reads that one). The default stays the
  // machine on screen, which is what every existing caller means.
  romCodeIn(m = this.shownMachine) {
    if (this.nitros9On(m)) return 'nitros9';   // our loader, and the user's NitrOS-9 in RAM (shareFile)
    if (Object.keys(m.romCrcs()).length) return 'roms';
    if (m.cartPort) return 'cartridge';
    return null;
  }
  // a URL's fragment -> the snapshot, null when it has none; SessionError when it is damaged. '#z=' is the link form
  // snapshotLink writes (js/media/snapshot.js decodeLongLink; its picture is drawn again on the next frame).
  async readSnapshotLink(hash) {
    const m = /^#?z=(.*)$/.exec(hash || '');
    if (!m) return null;
    const damaged = new SessionError('This link\'s snapshot is damaged: it was cut short or changed on the way.');
    let bytes;
    try { bytes = fromBase64Url(m[1]); } catch (e) { throw damaged; }
    try { return await decodeLongLink(bytes); }
    catch (e) { throw e instanceof SnapshotError && /newer CLOADM/.test(e.message) ? new SessionError(e.message) : damaged; }
  }
  // the moment as a file -> { name, bytes }
  // The moment as a file the person keeps: their machine (personMachine), so with the chat full screen it is the
  // BASIC session they were working on, never the chat firmware. `saved` names which machine it is, for the page's
  // message when that is not the one on screen. (shareFile stays the machine on screen: a share link pairs the
  // snapshot with the picture rendered from that same machine - see share.js.)
  async snapshotFile(now = new Date()) {
    this.writeWatch.guard('snapshotFile');
    const m = this.personMachine;
    const bytes = await encodeSnapshot(m.snapshot(), { name: m.profile.name, taken: now.toISOString(), program: this.momentProgram(m) });
    const saved = m !== this.shownMachine ? 'your BASIC session' : null;
    return { name: `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${stamp(now)}${SNAPSHOT_EXT}`, bytes, saved };
  }
  // file bytes -> the snapshot; SessionError when it isn't one this version reads
  async readSnapshot(bytes) {
    try { return await decodeSnapshot(bytes); }
    catch (e) { throw e instanceof SnapshotError ? new SessionError(e.message) : e; }
  }
  // what must change before it opens: null (it fits the machine in use) or { machine, name, config, text }
  snapshotSwitch(snap) {
    const m = this.shownMachine, p = profiles[snap.machine];
    const same = !!m && snap.machine === m.id && Object.keys(Object.assign({}, snap.config, m.config)).every((k) => snap.config[k] === m.config[k]);
    if (same) return null;
    const ram = snap.config.ram && p.options.ram && p.options.ram.values.length > 1 ? ` (${snap.config.ram}K)` : '';
    return { machine: snap.machine, name: p.name, config: snap.config, text: p.name + ram };
  }
  // the ROMs it ran with, from this browser's: { socket: bytes }, {} if it ran on the stub. Throws
  // SnapshotRomsError when one is missing or is another version.
  snapshotRoms(snap) {
    const p = profiles[snap.machine], stored = this.roms.get(snap.machine), out = {}, missing = [], other = [];
    for (const [socket, crc] of Object.entries(snap.roms)) {
      const slot = p.roms.find((r) => r.id === socket);
      if (!slot) throw new SessionError(`This snapshot names a ROM the ${p.name} doesn't take (${socket}).`);
      // our NitrOS-9 loader (bootNitros9) is built in: every browser has it
      const loader = socket === 'basic' && Session.NITROS9_MACHINES.includes(snap.machine) ? nitros9LoaderByCrc(crc) : null;
      if (loader) { out[socket] = nitros9LoaderRom(loader); continue; }
      if (!stored[socket]) missing.push(slot.label);
      else if (crc32(stored[socket]) !== crc) other.push(`${slot.label} (it ran with CRC ${crc.toString(16).toUpperCase().padStart(8, '0')}, yours is ${crc32(stored[socket]).toString(16).toUpperCase().padStart(8, '0')})`);
      else out[socket] = stored[socket];
    }
    if (missing.length) throw new SnapshotRomsError(`This snapshot needs ${missing.join(' and ')}. Add ROMs once and it opens right here.`, snap.machine);
    if (other.length) throw new SnapshotRomsError(`This snapshot was taken with another version of ${other.join(' and ')}. Add that ROM and it opens right here.`, snap.machine);
    // a shared snapshot also needs the cartridge and DOS images it names (shareFile), found by CRC
    const gone = missingImages(snap, (crc) => this.imageByCrc(crc, out));
    if (gone.length) {
      const what = gone.map((x) => `${x.label} (${Math.round(x.size / 1024)}K, CRC ${x.crc})`).join(' and ');
      throw new SnapshotRomsError(`This snapshot needs ${what}. Add it once (drop the file here) and it opens right here.`, snap.machine);
    }
    return out;
  }
  // an image this browser has, by CRC: the snapshot's own ROMs (socket -> bytes), any stored ROM, or a stored
  // program or cartridge
  imageByCrc(crc, roms = {}) {
    for (const b of Object.values(roms)) if (crc32(b) === crc) return b;
    return this.index.image(crc) || this.index.recentData(crc) || null;
  }
  // open it on the machine it was taken on (switching if needed: ask first with snapshotSwitch) -> message.
  // The machine is built and restored aside and replaces the one in use only when that worked: a snapshot that
  // can't be restored throws a SessionError and changes nothing (machine, remembered model and config, stub
  // choice). A switch remembers the snapshot's config for its model, as choosing that machine would.
  // The moment was not a power-on: bootStatus answers 'restored' rather than 'failed' for it (m.restored, which
  // Machine.restore sets), so a program that took the screen -- a game, anything that never printed OK -- is not
  // reported as a boot failure 5 s after it comes back. A later Reset or power-on clears the flag, so the
  // watchdog is armed again for it.
  // shared: the moment came from a share link (#z=, js/ui/snapshot-panel.js). One that runs without ROMs is the
  // person's arrival on someone else's moment (sharedMoment): the page holds back its no-ROM card and "No BASIC" pill
  // until they leave it (leaveSharedMoment).
  // link: { kind: 'long' | 'short', id } when the moment came from a link (#z= or #l=): arrivedFromLink, the page's
  // arrival card, until the person acts. Any other snapshot opened ends an earlier arrival.
  openSnapshot(snap, { shared = false, link = null } = {}) {
    this.writeWatch.guard('openSnapshot');
    const roms = this.snapshotRoms(snap), p = profiles[snap.machine], program = Session.momentProgramId(snap.program);
    // a shared one: its ROM code rebuilt from this browser's own images (snapshotRoms checked they are all here)
    snap = restoreRoms(snap, (crc) => this.imageByCrc(crc, roms));
    const switching = !!this.snapshotSwitch(snap);
    let m;
    try { m = restoreSnapshot(snap, Object.fromEntries(p.roms.map((x) => [x.id, roms[x.id] || null]))); }
    catch (e) { throw new SessionError(`This snapshot can't be opened: ${e.message}.`); }
    this.adopt(m);
    // (set before the events below, so the page's first look at this machine already knows)
    this.sharedMoment = shared && !Object.keys(roms).length;
    if (program) this.#openedProgram.set(m, program);
    const was = this.arrivedFromLink;
    this.arrivedFromLink = link ? { kind: link.kind === 'short' ? 'short' : 'long', id: link.kind === 'short' ? link.id || null : null,
      machine: m.profile.name, program } : null;
    if (was || this.arrivedFromLink) this.emit('arrival');
    for (const p of this.profiles) p.clear();      // a profile counts what ran from the moment opened
    if (switching) this.store.set(`config.${m.id}`, JSON.stringify(snap.config));
    if (Object.keys(roms).length) { if (!this.nitros9On(m)) this.stubChosen.delete(m.id); } else this.stubChosen.add(m.id);
    this.emit('machine');
    this.poweredOn();
    this.emit('roms');
    this.emit('loaded');
    // a moment taken on the stub's bare prompt has nothing running to come back to: the welcome menu, as a power-on
    if (m.atStubPrompt()) this.offerMenu(null, 'switch');
    this.emit('disks');
    this.emit('nitros9');
    // an opened moment is a restore, not a power-on: announced as 'restored' (never 'reset'), the same event an
    // undo emits, so boot-help re-checks here too and its box never outlives the run the moment replaced
    this.emit('restored');
    const n9 = this.nitros9Loader(m);
    return `Snapshot opened: ${m.profile.name}${n9 === 'drivewire' ? ', NitrOS-9 (on the image in DriveWire drive 0 now)' : n9 ? ', NitrOS-9' : Object.keys(roms).length ? '' : ', without ROMs'}`;
  }
  // quick-save slots 1..SNAPSHOT_SLOTS in the media store: [{ n, empty } | { n, machine, name, taken, size } | { n, error, size }]
  async listSlots() {
    const out = [];
    for (let n = 1; n <= SNAPSHOT_SLOTS; n++) {
      const st = await this.media.stat(slotName(n));
      if (!st) { out.push({ n, empty: true }); continue; }
      try {
        const snap = await decodeSnapshot(await this.media.read(slotName(n)));
        out.push({ n, machine: snap.machine, name: snap.name || profiles[snap.machine].name, taken: snap.taken, size: st.size });
      } catch (e) { out.push({ n, error: e.message, size: st.size }); }
    }
    return out;
  }
  async saveSlot(n) {
    slotName(n);
    // the snapshot is made from the machine and the slot written in one operation: a move waits for both, and the
    // write can never go to a store the session has left behind
    try {
      return await this.library.libraryOp(async () => {
        const { bytes, saved } = await this.snapshotFile();
        await this.media.write(slotName(n), bytes);
        return `Took snapshot ${n}${saved ? ` of ${saved}` : ''}`;
      });
    } catch (e) { throw this.library.mediaError(e, `snapshot ${n}`); }
  }
  // a slot's snapshot (then snapshotSwitch / openSnapshot as for a file)
  async readSlot(n) {
    if (!(await this.media.stat(slotName(n)))) throw new SessionError(`Snapshot ${n} is empty.`);
    return this.readSnapshot(await this.media.read(slotName(n)));
  }
  async clearSlot(n) {
    this.library.checkNotMoving();
    return this.library.libraryOp(() => this.media.remove(slotName(n)));
  }
  // what a slot holds, as stored (null when empty), and putting that back: the Undo of a save
  async slotBytes(n) {
    slotName(n);
    try { return (await this.media.stat(slotName(n))) ? await this.media.read(slotName(n)) : null; } catch (e) { throw this.library.mediaError(e, `slot ${n}`); }
  }
  async restoreSlot(n, bytes) {
    slotName(n);
    this.library.checkNotMoving();
    try {
      return await this.library.libraryOp(async () => {
        if (bytes) await this.media.write(slotName(n), bytes);
        else if (await this.media.stat(slotName(n))) await this.media.remove(slotName(n));
      });
    } catch (e) { throw this.library.mediaError(e, `slot ${n}`); }
  }

  // a file that is a ROM image rather than a program, tape or cartridge (known contents or usual name)
  static isRom(name, bytes) { return looksLikeRom(name, bytes, romOwners()); }

  // ---------------- visits and recent media ----------------
  // { first: true on the first visit in this browser, machineChosen, recent: [{ name, size, stored }] }
  visit() {
    const first = this.store.get('visited') === null;
    this.store.set('visited', '1');
    this.firstVisit = first;
    return { first, machineChosen: this.store.get('machineChosen') !== null, recent: this.library.recentMedia() };
  }
  // What ran last (the returning visit's "Last time" and the menu's "CARRY ON WITH"), kept across visits:
  // { kind: 'liza' | 'demo' | 'game' | 'recent', name } or null (a game's name is its GAMES.list name; a file also
  // has `crc`, the hash of its bytes, which with the name tells it from another file of the same name). LIZA, the
  // demo and the games aren't in the recent list (they are ours, not the user's files), so they are remembered
  // here; a file is the recent list's first item.
  get lastRun() {
    try { const v = JSON.parse(this.store.get('lastRun') || 'null'); return v && typeof v.kind === 'string' && typeof v.name === 'string' ? v : null; }
    catch (e) { return null; }
  }
  // emits 'lastrun': a program records itself AFTER its load has emitted 'loaded', so a view of lastRun (the Media
  // tab's "Last time") follows this event, not 'loaded', and names what Run again runs
  // running: false for a load that started nothing (data with no execution address): it is what ran last, but nothing
  // on screen runs it, so it is not "on screen now" (lastRunOnScreen)
  // crc: a file's content hash (the recent list's own), the identity a row of the list is told by besides its name
  setLastRun(kind, name, { running = true, crc = null } = {}) {
    this.store.set('lastRun', JSON.stringify(crc ? { kind, name, crc } : { kind, name }));
    this.lastRunOn = running ? this.personMachine : null;
    this.emit('lastrun');
  }
  // Is this recent-list entry the file lastRun names: the same name (the store's own case rule) and the same bytes.
  // Two files of one name and different content are two entries, and only the one that ran is it.
  isLastRun(entry) {
    const last = this.lastRun;
    return !!last && last.kind === 'recent' && this.library.sameName(entry.name, last.name) && String(entry.crc).toUpperCase() === last.crc;
  }
  // Is what lastRun names the program on screen now: recorded as it started on the machine in use, and nothing since
  // took the machine from it (a load, a launch, a reset, a switch, the welcome menu, a snapshot), not stopped by the
  // Debugger. The page adds its own Pause. Its panels then show it as running, not as something to Run again.
  get lastRunOnScreen() {
    const m = this.lastRunOn;
    return !!m && m === this.personMachine && m === this.shownMachine && !this.paused;
  }
  // What the welcome menu's carry-on line offers on the machine in use: what ran last, if it runs here. A file only
  // on the machine it was loaded on (and only while its bytes are kept), the colour demo and the games only on a
  // 6809-family CPU, LIZA on every machine (its 6809 or 6803 build). null: no carry-on line.
  get carryOn() {
    const last = this.lastRun, m = this.shownMachine;
    if (!last || !m) return null;
    if (last.kind === 'recent') { const r = this.library.recentMedia()[0]; return r && r.stored && this.isLastRun(r) && r.machine === m.id ? last : null; }
    if (last.kind === 'demo') return cpuFamily(m.config.cpu) === '6809' ? last : null;
    if (last.kind === 'game') return cpuFamily(m.config.cpu) === '6809' && gameKey(last.name) ? last : null;
    return last;
  }
  // the machine picker is asked once, then remembered
  // The machine picker is asked once, then remembered. offer: how the menu is offered afterwards; the machine
  // QUESTION (js/ui/welcome.js) passes 'none' -- the person chose the machine, not what ran on the old one -- while
  // the header menu and the ROM screen keep the usual carry-on, which is what a returning visitor expects there.
  chooseMachine(id, { offer = null } = {}) { this.store.set('machineChosen', '1'); return this.switchMachine(id, undefined, { offer }); }
  // The greeting the menu takes when it is offered by a switch: a machine question ('none') is asked on a FIRST
  // visit only, so it greets a first-time visitor ('first', the title screen); every other offer is a returning
  // visitor's ('back') -- the page used to decide this itself, and once got it wrong. One place decides it now.
  // A visit that began as the browser's first stays "first" until something has run in it: with nothing to come back
  // to, "WELCOME BACK" would greet a visitor who has only just arrived (a machine picked in the header menu).
  greetingFor(offer) { return offer === 'none' || (this.firstVisit && !this.lastRun) ? 'first' : 'back'; }
  get hasAnyRoms() { return this.roms.sockets().some((s) => profiles[s.owner]); }

  // This machine has every ROM its BASIC needs, in its sockets, and yet runs the stub by choice (the page's "Run
  // without ROMs", or a start on the stub): nothing is missing, so nothing is "added". The one state where the page
  // must offer the way BACK rather than ask again (the welcome menu's option 3, the "no ROMs" card, the ROM page).
  romsReadyButOff(m = this.personMachine) { return !!m && m.useStub && this.machineRoms(m.id).bootable; }
  // The machines a ROM drop has really set up: every required socket holds a VERIFIED dump, not merely a filled one.
  // isBootable() answers "it could try to boot this" (a named, wrong-sized-for-its-CRC file is still a file), which
  // is right for the machine's own attempt but wrong for telling a person a machine is "ready to run BASIC".
  machinesVerified() {
    return Object.keys(profiles).filter((id) => {
      const { sockets } = this.machineRoms(id);
      return profiles[id].kind !== 'cartridge' && sockets.every((s) => !s.required || s.status === 'verified');
    });
  }

  // ---------------- programs and media ----------------
  // ---------------- the Speech/Sound Pak ----------------
  // The Pak is a cartridge-port board, offered where the machine's profile has the `ssc` option: the CoCo 1/2,
  // CoCo 2B, CoCo 3 and the Dragon 64 (each with its own `--ssc` lockstep against MAME). The PIC (TMS7040) ROM is
  // the user's, like BASIC and DOS, and so is the SP0256's allophone ROM, which is optional: the Pak speaks with it,
  // and plays music only without it (the insert message and the ROM panel say which).
  get offersSsc() { return !!(this.personMachine && this.personMachine.profile.options && this.personMachine.profile.options.ssc); }
  // is the Pak in the cartridge port? (also when it arrived through a restored snapshot)
  get sscInserted() { return !!this.personMachine && this.personMachine.cartPort instanceof SpeechSoundPak; }
  // the board menu's name for the Pak: whether its speech ROM is stored (SSC_TEXT)
  get sscBoardLabel() { return this.roms.get('ssc').sp0256 ? SSC_TEXT.board : SSC_TEXT.boardNoSpeech; }
  // what is needed to put the Pak in: [{ id, label, size, files, status }] from the stored ROMs
  sscRoms() {
    const stored = this.roms.get('ssc');
    return SSC_ROM_PROFILE.roms.map((s) => ({ id: s.id, label: s.label, size: s.size, files: s.files, required: s.required, status: stored[s.id] ? 'loaded' : 'missing' }));
  }
  // plug the Pak in (whatever was in the port comes out) and power the machine up with it. The `ssc` option is set
  // too, so the choice is remembered with the machine's configuration and the Pak comes back on the next start.
  // Only the PIC's ROM is required: the SP0256's allophone data is optional, and without it the card plays its music
  // and stays silent where it would speak (js/machines/ssc.js).
  insertSsc() {
    const m = this.personMachine;
    if (!m) throw new SessionError('There is no machine to put the Speech/Sound Pak in.');
    if (!this.offersSsc) throw new SessionError(`The ${m.profile.name} can't take the Speech/Sound Pak: CLOADM offers it only on the models its Pak is verified on.`);
    const missing = this.sscRoms().filter((s) => s.required && s.status !== 'loaded');
    if (missing.length) {
      throw new SessionError(`The Speech/Sound Pak needs its PIC ROM: ${missing.map((s) => `${s.label} (${s.files[0]}, ${Math.round(s.size / 1024)}K)`).join(' and ')}. Load the ROM file first.`);
    }
    const stored = this.roms.get('ssc');
    this.drives.flush();
    this.endWelcome(m);
    this.keys.clear();
    m.insertCartridge(new SpeechSoundPak({ tms7040Rom: stored.tms7040, sp0256Rom: stored.sp0256 || null }));
    this.setOption('ssc', 'music');
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    this.emit('loaded');
    return stored.sp0256 ? 'Speech/Sound Pak inserted (music and speech)'
      : 'Speech/Sound Pak inserted (music only: add your own SP0256-AL2 ROM in Your ROMs for speech)';
  }
  // take it out and leave the machine on its own ROMs
  ejectSsc() {
    const m = this.personMachine;
    if (!this.sscInserted) return 'The Speech/Sound Pak is not in.';
    m.ejectCartridge();
    this.setOption('ssc', 'none');
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    this.emit('loaded');
    return 'Speech/Sound Pak taken out';
  }
  // Whatever is in the cartridge port, taken out (the board menu's "Take out") -> message. The disk controller without
  // a ROM comes out with the machine running on (it was never part of what runs; its disks stay in the Library); any
  // other board takes what runs with it, so the machine starts afresh, as on real hardware.
  takeOutCartridge() {
    const m = this.personMachine, c = m && m.cartPort;
    if (!c) throw new SessionError('The cartridge port is empty.');
    if (c instanceof SpeechSoundPak) return this.ejectSsc();
    const bare = c === this.drives.bareController, name = bare ? c.plainName : c.name || 'The cartridge';
    this.drives.flush();
    m.ejectCartridge();
    if (!bare) {
      this.endWelcome(m);
      this.keys.clear();
      m.reset(true);
      this.acc = 0;
      this.poweredOn();
    }
    this.emit('loaded');
    this.emit('disks');
    return `${name} taken out`;
  }
  // set one of the machine's options (through resolveConfig, so an option the model lacks is refused) and
  // remember it with the model's configuration
  setOption(key, value) {
    const m = this.shownMachine, id = m.id;
    const config = Object.assign({}, (m.config || {}), { [key]: value });
    const resolved = resolveConfig(id, config);
    m.config = resolved;
    this.store.set(`config.${id}`, JSON.stringify(resolved));
    return resolved;
  }
  // The Pak a machine starts with, from its `ssc` option: called after the machine's ROMs are in place and before
  // it is reset, by switchMachine and by a power cycle. A machine whose option says 'music' but whose ROM is no
  // longer stored keeps its port empty (the option stays, so the panel says what is missing).
  applySscOption(m = this.shownMachine) {
    if (!m || !m.profile.options || !m.profile.options.ssc) return;
    const want = m.config && m.config.ssc === 'music';
    const stored = this.roms.get('ssc');
    const have = m.cartPort instanceof SpeechSoundPak;
    if (want && !have && stored.tms7040) {
      m.insertCartridge(new SpeechSoundPak({ tms7040Rom: stored.tms7040, sp0256Rom: stored.sp0256 || null }));
    } else if (!want && have) m.ejectCartridge();
  }
  // a listener that throws is reported on its own (as an uncaught error), apart from the disk write chain
  emitApart(event) { try { this.emit(event); } catch (e) { queueMicrotask(() => { throw e; }); } }

  // The machine EVERY person-facing media, tape, cartridge, poke and welcome action acts on. The machine in use,
  // except while the Claude chat is full screen: then the chat machine is on screen (the chat firmware), and the
  // person's own machine is the BASIC session kept beside it (chatTarget()). Anything the person does with a file,
  // a tape, the deck's controls, a cartridge, the POKE book or the welcome program goes to this machine, never to
  // the chat machine: a load or a power cycle there overwrote the chat firmware and took the chat screen away. The
  // machine-internal paths (the frame loop, the shown screen, the keyboard, the display, the chat itself) keep using
  // this.shownMachine, and say so where they do. One target, read here, rather than an `on:` argument threaded through
  // each caller - which is what made the first cut of this fix patchy.
  // THE TWO ACCESSORS (0.1.9). Every use of a machine in this file and in js/ui says which of the two it
  // means, and there is no third way to reach one: the field itself is `_shown`, which nothing outside these two
  // getters touches, and a test (tests/chat-leaks.test.js, rawMachineUses) fails on a bare `this.machine` or a bare
  // `session.machine`.
  //   shownMachine  - the machine ON SCREEN: the chat machine while the chat is full screen, else the person's. It is
  //                   what the picture, the keyboard, the frame loop, the debugger and the display are about.
  //   personMachine - the machine the PERSON works on: the BASIC session kept beside a full-screen chat. Files, tapes,
  //                   cartridges, ROMs, the POKE book, the welcome program, LIZA, disks.
  // The two are the same machine whenever no full-screen chat is open.
  get shownMachine() { return this._shown; }
  set shownMachine(m) { this._shown = m; }
  get personMachine() {
    return this.personFor(this.shownMachine);
  }
  // the person's machine when `shown` is on screen: the BASIC session beside a full-screen chat, else `shown`
  personFor(shown) {
    const c = this.chatMachines;
    return c && shown === c.chat && c.basic !== shown ? c.basic : shown;
  }
  // a write stop kept for the machine now on screen becomes its debugger stop (paused at the instruction after the
  // write, with the stop's reason); one whose machine is no longer the person's is dropped
  presentPendingStop() {
    const ps = this.pendingStop;
    if (!ps) return;
    if (ps.machine === this.shownMachine) { this.pendingStop = null; this.debug._stop('write', ps.reason); }
    else if (ps.machine !== this.personMachine) this.pendingStop = null;
  }
  // put the Session's hooks (session.hooks: the developer API's probes, taps, serial listeners and traces) on m, the
  // person's machine; what a machine they leave wrote and had not yet delivered to watchWrites is dropped
  followPerson(m = this.personMachine) {
    if (m === this.hooks.machine) return;
    this.hooks.attach(m);
    this.writeWatch.reset();
  }
  // where a file the person loads goes: the same machine, and what the load's message says when that is not the
  // machine in use ('' when it is).
  loadTarget() {
    const m = this.personMachine;
    if (m !== this.shownMachine) return { m, why: 'Loaded into your BASIC session, which is what runs behind the chat. ' };
    return { m, why: '' };
  }
  needsRom(what) { return new SessionError(`${what} needs the ${this.shownMachine.profile.name} BASIC ROM. Load the ROM files first.`); }
  // load a file of any supported kind -> message. askAddresses(name, size) -> { load, exec } | null for raw
  // data; remember: false keeps it off the recent list.
  // run: false types a BASIC listing without the RUN after it (the MCP server's load; the page always runs it)
  load(name, bytes, { askAddresses = null, remember = true, run = true } = {}) {
    this.loadStarted = true;
    this.touch(this.shownMachine);   // a load makes a bundled program a moment (untouchedBundledProgram)
    const msg = this.loadMedia(name, bytes, askAddresses, { run });
    if (remember) { this.library.rememberMedia(name, bytes); this.setLastRun('recent', name, { running: this.loadStarted, crc: crc32(bytes) }); }
    this.emit('loaded');
    return msg;
  }
  // A tape loads through BASIC as on a machine just switched on: power cycled (the deck and the cartridge stay,
  // as with any power cycle), then nothing is typed until BASIC is at its prompt. Whatever ran before - a CLEAR
  // that moved the top of memory, 64K mode, a program that crashed - would otherwise decide where BASIC's stack and
  // variables are while the tape loads, which is where a self-starting tape puts its start-up code.
  // m runs without ROMs only because that was chosen (stubChosen), the ROMs stored for it boot BASIC, and they
  // have not already been tried and found not to (bootFailed): a drop that found that out would otherwise repeat
  // the whole 5 s restart-for-a-clean-load and fall back on every later drop, for ROM images that never will.
  // (never the chat machine: it shares the model's id, but runs the chat firmware, not the model's BASIC)
  storedRomsWaiting(m) {
    if (this.chatMachines && m === this.chatMachines.chat) return false;
    return !m.hasRom && this.stubChosen.has(m.id) && !this.nitros9On(m) && this.machineRoms(m.id).bootable
      && !this.romsFailed(m).has(this.bootKey(m));
  }
  // the ROMs a machine runs with, as the key a boot failure is remembered under: the same machine with other ROMs
  // is a different try (a ROM change clears it), and so is a power-on (Session.poweredOn clears the whole set)
  bootKey(m) {
    const roms = this.roms.get(m.id);
    return `${m.id}@${m.profile.roms.map((s) => (roms[s.id] ? crc32(roms[s.id]) : '-')).join(',')}`;
  }
  // remember that m's stored ROMs did not start BASIC, and keep them off later loads' retries until a power-on or
  // a ROM change clears it (forgetBootFailure). -> the note the load's message adds.
  // the CRCs that did not start BASIC on m (a Set; empty until one does)
  romsFailed(m) { let f = this.bootFailed.get(m); if (!f) { f = new Set(); this.bootFailed.set(m, f); } return f; }
  bootFailedThis(m, name) {
    this.romsFailed(m).add(this.bootKey(m));
    return `Your stored ROMs did not start BASIC, so ${name} went straight into memory. `;
  }
  // put m's stored ROMs back in (as the ROM screen's "Switch on" does, on this same machine; the load power cycles it)
  useStoredRoms(m) {
    this.stubChosen.delete(m.id);
    this.loadSavedRoms(m);
    this.emit('roms');
  }
  // What a load typed into m, or is still waiting to type (the EXEC after CLOADM, and its probe on the loaded
  // program, which the typist drops with it), is dropped when something else starts on m: a later load, a program
  // injected, a restore point. Otherwise that EXEC would be typed into whatever runs next.
  cancelLoadTyping(m) {
    m.typist.dropTyped();
  }
  // on: the machine to restart (loadMedia's target, which is the BASIC session while the chat is full screen); the
  // default is the machine in use. A power cycle of another machine must not reach into the chat: the chat machine
  // is reset through this same path only for itself, never for the person's load.
  restartForLoad(m) {
    this.powerCycle({ menu: false, reason: 'you loaded a program', on: m });
    m.ensureBooted();
    for (let i = 0; i < 5 * m.fps && this._bootStatusOf(m).state !== 'ok' && m.runFrame(); i++);
  }
  // on: the machine to load on, for a caller that already knows (the chat's own firmware load names its chat
  // machine); otherwise the person's load target (loadTarget), which is the machine in use unless the chat is full
  // screen, where it is the BASIC session behind it. The message says where it went when that is not the machine
  // in use.
  loadMedia(name, bytes, askAddresses, { run = true, on = null } = {}) {
    const target = on ? { m: on, why: '' } : this.loadTarget();
    const m = target.m;
    const where = (msg) => target.why + msg;
    // a program the person loads takes over the machine Claude acts on (with ROMs it starts without a reset, so
    // the machine's onReset does not say so): Claude stops just before it does (inject does too), and nothing it
    // held is typed into the program; a load that is refused or cancelled leaves Claude alone
    const takeOver = () => { this.cancelLoadTyping(m); this.stopClaudeFor('you loaded a program', m); };
    this.endWelcome(m);     // this machine's welcome and watch: the chat's start of its own firmware ends neither
    this.setStubRun(m);     // the load starts something on THIS machine; the other machine's record is untouched
    this.forgetOpenedProgram(m);   // (an opened moment's program: something else runs now)
    const media = detectMedia(name, bytes);
    if (media.kind === 'disk') {
      throw new SessionError(`${name}: ${media.format}${media.family ? ` for a ${FAMILY_NAMES[media.family]}` : ''}. Disk images go in a disk drive, not into memory.`);
    }
    // (What is loaded runs. A load is a launch only once it is accepted: each branch below calls go() after its
    // own refusals, so a refused file - a .wav with no tape in it, BASIC with no ROM - leaves a Debugger stop and the
    // page's Pause as they were. A restart through BASIC is a power cycle, which launches by itself.)
    const go = () => this.launch(m);
    const d = formats.identify(name, bytes);
    switch (d.kind) {
      case 'binary':
        if (d.basic) {
          if (!m.hasRom) throw this.needsRom('A BASIC program');
          go();
          takeOver();
          m.loadBasicProgram(d.segments[0].data, d.segments[0].addr);
          return where(`${name}: ${d.format}, ${d.segments[0].data.length} bytes – RUN`);
        }
        go();
        this.inject(d.segments, d.exec, m);
        if (d.exec == null) this.loadStarted = false;   // (data only: nothing runs)
        // what happened first, the format and the addresses after it (the page shows the rest under Details)
        return where(`${name} loaded${d.exec != null ? ' and started' : ''}. ${d.format} ${describeSegments(d.segments, d.exec)}`);

      case 'wav':
        throw new SessionError(d.error ? `${name}: ${d.error}` : `${name}: no tape blocks found in this recording${d.wav && d.wav.badBlocks ? ` (${d.wav.badBlocks} damaged)` : ''}`);

      case 'cas': {
        const first = d.files[0];
        const list = d.files.map((f) => `${f.name} (${f.typeName})`).join(', ');
        const tape = new Tape(d.bytes, m.tickHz, name, m.profile.tape);
        // Only a machine-code file (type 2) or a BASIC program (type 0) is loaded. A DATA file (type 1, or any
        // other type) is read by a program (OPEN "I",#-1 and INPUT #-1): it goes in the deck, nothing is typed
        // or run (CLOAD would stop with ?FM ERROR, and poking it into memory would run data as code).
        if (first.fileType !== 0 && first.fileType !== 2) {
          go();
          this.cancelLoadTyping(m);
          m.deck.insert(tape);
          return where(`${name}: ${first.name} is a ${first.typeName} file, which a program reads (OPEN "I",#-1); it is in the deck`);
        }
        // an ASCII BASIC listing must be tokenised by BASIC's CLOAD, so it always loads through BASIC
        const ascii = first.fileType === 0 && first.ascii;
        // running without ROMs by choice (the welcome menu, LIZA, the demo, "Run without ROMs") while this machine's
        // ROMs are stored: a tape that loads through BASIC uses them again rather than going into memory on the stub,
        // which has no BASIC for a program to call
        const again = (!this.fastCas || ascii) && this.storedRomsWaiting(m);
        if (again) this.useStoredRoms(m);
        if (ascii && !m.hasRom) throw this.needsRom('An ASCII BASIC tape');
        let note = '';
        if (m.hasRom && (!this.fastCas || ascii)) {
          this.restartForLoad(m);
          // stored ROMs that do not start BASIC (no OK after the restart) get nothing typed into them: the machine
          // goes back to running without ROMs and the tape goes into memory there, as it did before
          if (again && this._bootStatusOf(m).state !== 'ok') {
            this.runWithoutRoms({ menu: false });
            // remembered BEFORE the ASCII refusal throws: otherwise every ASCII drop re-tried the ROMs (a full
            // restart and 5 s of emulated time each) for ROMs already known not to start BASIC (review probe C)
            const refused = this.bootFailedThis(m, name);
            if (ascii) throw new SessionError(`${name}: your stored ${m.profile.name} ROMs did not start BASIC, and an ASCII BASIC tape needs it.`);
            note = refused;
          } else {
            m.deck.insert(tape);
            if (first.fileType === 2) {
              m.typist.type('CLOADM\r');
              const exec = execWhenReady(m, first);
              m.typist.typeWhen(exec.decide, 'EXEC\r', exec.cancel);
            } else { m.typist.type('CLOAD\r'); m.typist.waitTape(); m.typist.type('RUN\r'); }
            return where(`${again ? `Using your ROMs again to load ${name} through BASIC. ` : ''}Restarted for a clean load. ${name}: tape inserted [${list}] – loading via BASIC`);
          }
        }
        let msg;
        if (first.fileType === 0) {
          if (!m.hasRom) throw this.needsRom('A BASIC tape');
          go();
          takeOver();
          m.loadBasicProgram(first.data);
          msg = `${name}: ${first.name} (BASIC) fast-loaded – RUN`;
        } else {
          const seg = { addr: first.load, data: first.data };
          go();
          this.inject([seg], first.exec, m);
          if (first.exec == null) this.loadStarted = false;
          const range = `${hex(first.load)}–${hex((first.load + first.data.length - 1) & 0xFFFF)}`;
          msg = first.exec != null ? `${name} loaded (${range}) and started at ${hex(first.exec)}.` : `${name} loaded (${range}).`;
        }
        tape.seekByte(first.end);       // the rest stays in the deck for multi-part loaders
        m.deck.insert(tape);
        // the deck says so too (tapeStatus started), until the tape moves on or another goes in
        if (first.fileType === 2 && first.exec != null) this.tapeStarted = { tape, exec: first.exec };
        return where(note + msg);
      }

      case 'cart': {
        if (!m.hasCartridgePort) throw new SessionError(`${name}: the ${m.profile.name} has no cartridge port`);
        this.drives.flush();
        let dev;
        try { dev = cartridgeFor(bytes, this.cartBoard); } catch (e) { throw new SessionError(`${name}: ${e.message}`); }
        go();
        this.cartFiles.set(dev, name);
        return where(this.startCartridge(dev, `${name}: ${dev.name}`, m));
      }

      case 'basictext':
        if (!m.hasRom) throw this.needsRom('A BASIC listing');
        go();
        takeOver();
        m.ensureBooted();
        m.typist.type('NEW\r' + d.text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).join('\r') + (run ? '\rRUN\r' : '\r'));
        return where(`${name}: typing BASIC listing…`);

      default: {
        const a = askAddresses && askAddresses(name, bytes.length);
        if (!a) throw new SessionError(`${name}: unknown format (${bytes.length} bytes)`);
        go();
        const seg = { addr: a.load, data: bytes };
        this.inject([seg], a.exec, m);
        if (a.exec == null) this.loadStarted = false;
        return where(`${name}: raw ${describeSegments([seg], a.exec)}`);
      }
    }
  }
  get cartBoard() { return this._cartBoard; }
  set cartBoard(v) {
    if (!CART_BOARDS[v]) throw new SessionError(`unknown cartridge board "${v}" (have: ${Object.keys(CART_BOARDS).join(', ')})`);
    this._cartBoard = v;
  }
  // the cartridge goes in and runs: autostart through BASIC after a reset, or straight at $C000 without a ROM
  // on: the machine the cartridge goes into (loadMedia's target: the BASIC session while the chat is full screen),
  // else the machine in use. The cartridge belongs to that machine either way, so the chat machine's port is never
  // filled behind the chat firmware's back.
  startCartridge(dev, what, on = null) {
    const m = on || this.shownMachine;
    m.insertCartridge(dev);
    if (m.hasRom) { m.reset(false); return `${what} inserted, autostarting`; }
    this.inject([], 0xC000, m);
    return `${what} inserted, running at $C000`;
  }
  // A Multi-Pak with up to four cartridges: items[i] = { name, bytes, board }, { dos } (a disk controller: an id
  // from drives.dosChoices(), with the user's ROM; one per Multi-Pak) or null for an empty slot (slot 1 first);
  // switchSlot is the front-panel switch (1-4), the slot whose ROM shows at reset. MAME fits a disk controller in
  // slot 4 only (the one compared with it); the Multi-Pak routes every slot alike, so any slot takes one here.
  insertMultiPak(items, { switchSlot = 4 } = {}) {
    const m = this.personMachine;
    this.endWelcome(m);
    if (!m.hasCartridgePort) throw new SessionError(`A Multi-Pak needs a cartridge port; the ${m.profile.name} has none`);
    if (!this.hasMultiPak) throw new SessionError(`The Multi-Pak is not verified on the ${m.profile.name} yet; it is offered on the machines it was compared with MAME on`);
    if (!Array.isArray(items) || items.length > 4) throw new SessionError('A Multi-Pak has four slots');
    const dos = items.filter((it) => it && it.dos);
    if (dos.length > 1) throw new SessionError('A Multi-Pak takes one disk controller (their registers would clash).');
    const choices = this.drives.dosChoices();
    const names = items.map((it) => (it && it.dos ? (choices.find((c) => c.id === it.dos) || { name: it.dos }).name : it ? it.name : 'empty'));
    let mp;
    try {
      mp = new MultiPak(items.map((it, i) => {
        if (!it) return null;
        if (!it.dos) return cartridgeFor(it.bytes, it.board || 'auto');
        const c = choices.find((x) => x.id === it.dos && !x.builtin);
        if (!c) throw new SessionError(`slot ${i + 1}: the ${m.profile.name} can't take ${cartridgeRoms[it.dos] ? `the ${cartridgeRoms[it.dos].name}` : `"${it.dos}"`}`);
        if (!c.ready) throw new SessionError(`slot ${i + 1}: the ${c.name} needs its ROM (${cartridgeRoms[c.id].roms[0].files.join(', ')}). Load the ROM file first`);
        return new devices[c.controller]({ rom: this.roms.get(c.id).rom });
      }), { switchSlot });
    } catch (e) { throw new SessionError(`Multi-Pak: ${e.message}`); }
    this.drives.flush();
    const msg = this.startCartridge(mp, `Multi-Pak (${names.map((n, i) => `${i + 1}: ${n}`).join(', ')})`, m);
    if (dos.length) this.store.set(`diskDos.${m.profile.lineage}`, dos[0].dos);
    this.emit('loaded');
    this.emit('disks');
    return msg;
  }
  // What is this media, and is it for the machine in use? -> detectMedia's result plus `mismatch`:
  // { family, suggest: machine id to open it on, suggestName } when it is for another family (or needs a
  // cartridge port this machine doesn't have).
  // A file that is none of the kinds CLOADM opens (OPENS_TEXT): { text, details } for the page to say, or null when it
  // opens (or may be a raw memory dump: loadMedia asks where it goes)
  unopenable(name, bytes) {
    if (detectMedia(name, bytes).kind !== 'raw') return null;
    const ext = (name.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '';
    if (RAW_EXTENSIONS.includes(ext) || OPENS_EXTENSIONS.includes(ext)) return null;
    return { text: `${name} isn't a file CLOADM opens.`, details: OPENS_TEXT };
  }
  inspect(name, bytes) {
    const media = detectMedia(name, bytes), m = this.shownMachine;
    let family = media.family;
    if (media.kind === 'cart' && !m.hasCartridgePort && !family) family = 'coco';
    if (!family || family === m.profile.lineage) return Object.assign(media, { mismatch: null });
    // open it on a machine of that family that can boot BASIC here, else the family's usual model
    const ready = Object.values(profiles).find((p) => p.lineage === family && isBootable(p, this.roms.get(p.id)));
    const suggest = (ready || profiles[{ dragon: 'dragon64', coco: 'coco', mc10: 'mc10' }[family]]).id;
    return Object.assign(media, { mismatch: { family, familyName: FAMILY_NAMES[family], suggest, suggestName: profiles[suggest].name } });
  }
  // the person types text in (a paste, the type-in panel, a POKE from the book, a tap on the welcome menu, the embed
  // API): it is the person's input, so Claude acting on that machine pauses first (personInput), and the text goes in
  // What is typed at the keyboard goes to the machine ON SCREEN: with the chat full screen that is the chat, and a
  // line typed there is a line of the conversation - by design. (A caller that means the person's BASIC session
  // while the chat is open names it: typeText(text, session.personMachine).)
  typeText(text, m = this.shownMachine) {
    if (this.refuseTyping(m)) return 0;   // (nothing is queued behind a Debugger stop)
    this.personInput(m);
    return this.queueText(text, m);
  }
  // A key or text the person sends to machine m (a key on the screen or the page, an on-screen key, typed text):
  // when Claude is acting on m, Claude pauses before the person's input is queued (pauseClaude), so what Claude still
  // had to type is held back and the person's input goes in. Every way the person's input reaches the machine comes
  // here, so the ticket (machineTicket) only ever counts Claude's own typing. true when it paused Claude now.
  // (also while an acting call waits at its gate - a card, an INCLUDE read - before it acts: runTool's re-check then
  // holds the call until Resume)
  personInput(m = this.shownMachine) {
    this.touch(m);
    if (!this.chat || !(this.claudeBusyActing || this.claudeCall) || this.consent.paused || m !== this.chatTarget().machine) return false;
    return this.pauseClaude();
  }
  // text into the machine with nothing else: through the keyboard with ROMs, as key codes for the stub (the person's
  // text goes through typeText, which pauses Claude first)
  queueText(text, m = this.shownMachine) {
    const t = text.replace(/\r\n?/g, '\n');
    if (m.useStub) { for (const ch of t) m.stubKeys.push(m.stubCode(ch)); }
    else m.typist.type(t.replace(/\n/g, '\r'));
    return t.length;
  }
  // Press BREAK for Claude's press_break. It has to be held for a few frames: the CPU reads the keyboard matrix
  // through the PIA, and the machine does not sample it, so a key set down and up inside one call is never seen (the
  // matrix is only read when the CPU reads the port). It is held the paced way (Typist.holdPaced), until the machine
  // has read it down, so the result says whether it was read. Returns the job.
  // On a ROM-less machine nothing reads it: the stub does not scan the matrix at all - it takes key codes from its
  // own queue (Machine.stubKeys) through POLCAT, and its line editor ignores every control key. The job fails
  // not-consumed at once, so the tool says so instead of claiming a press.
  pressBreak(m = this.shownMachine) { this.touch(m); return m.typist.holdPaced('BREAK'); }
  // Claude's typing: paced by what the machine consumes (Typist.typePaced), so a busy BASIC drops nothing.
  // Returns the job (job.promise settles when it ends); the caller checks typableText first.
  typeTextPaced(text, m = this.shownMachine) { this.touch(m); return m.typist.typePaced(String(text).replace(/\r\n?/g, '\n')); }
  // the characters of text this machine cannot type: no key for it on this keyboard (with BASIC), or not 7-bit
  // ASCII (the stub's key codes). [] when all of it can be typed.
  untypable(text, m = this.shownMachine) {
    const bad = new Set();
    for (const ch of String(text).replace(/\r\n?/g, '\n')) {
      if (m.useStub) { if (ch.charCodeAt(0) > 0x7E && ch !== '\n') bad.add(ch); continue; }
      const k = charToKeys(ch);
      if (!k || !m.keyPos[k.key] || (k.shift && !m.keyPos.SHIFT)) bad.add(ch);
    }
    return [...bad];
  }

  // ---------------- the memory-write observer ----------------
  // Observe the CPU's writes to start..end (inclusive): fn({ address, value, old, pc, at, frame }) after the writing
  // instruction, before the next one (js/writewatch.js) -> { remove() }. The callback may press keys
  // (machine.setKey), move the joystick (machine.joy) or mouse (machine.mouse), send serial bytes (serial.send) and
  // poke memory (pokeBytes): each takes effect from the next instruction. Returning 'stop' stops the run there, as a
  // debugger stop (kind 'write'; debug.resume() or debug.run() goes on). Pokes, the debugger's writes and loads are
  // not the CPU's bus writes and are not reported. Host state: not in snapshots, kept across machine switches.
  watchWrites(range, fn) { return this.writeWatch.add(range, fn); }

  // ---------------- the Claude chat's machine tools ----------------
  // a side-effect-free byte read for the peek tool: RAM and ROM as the debugger's disassembly sees them
  readByte(addr, m = this.shownMachine) {
    return typeof m.peek === 'function' ? m.peek(addr & 0xFFFF) : m.ram[addr & 0xFFFF];
  }
  // write bytes for the poke tool, through the machine's memory map (machine.poke, not a raw RAM poke)
  // Returns how many bytes landed (Machine.poke says whether each did): ROM, I/O and RAM the machine does not have
  // take nothing, and a caller that reports the write must report this number, not bytes.length.
  // An address the map says would not land (writeKind: ROM, I/O, absent RAM, an undecoded range) is not written at
  // all. Machine.poke itself may write the cell beneath (the CoCo 3's loaders patch vectors under the ROM), but a
  // tool that says "not-ram" must not also have changed memory the CPU cannot see and a later map switch would reveal.
  pokeBytes(addr, bytes, m = this.shownMachine) {
    if (bytes.length) this.touch(m);
    let landed = 0;
    [...bytes].forEach((b, i) => {
      const a = (addr + i) & 0xFFFF;
      if (!m.writeKind(a) && m.poke(a, b & 0xFF)) landed++;
    });
    return landed;
  }

  // Write an assembled program into m's memory without starting it (assemble_and_load): no reset and no frames
  // run, so RAM the caller did not target is untouched. (Machine.injectAndRun resets a ROM-less machine, which
  // boots the stub and wipes RAM; that is "run", not "load".) The symbols reach the debugger of the machine in use.
  injectAssembled(res, m = this.shownMachine) {
    // pokeBytes leaves a byte the map says would not land (ROM, I/O, absent RAM) unwritten, and counts the rest
    let landed = 0;
    for (const seg of res.segments) landed += this.pokeBytes(seg.addr, seg.data, m);
    if (m === this.shownMachine) {
      this.labels = res.symbols;
      if (this.debugger) this.debugger.setSymbols(() => this.labels);
    }
    return landed;
  }
  // What `run` would start: null for the machine's own RUN, else the address. Throws what runAt throws, so a caller
  // can validate before it takes a restore point. An address may be a number or text ("$3000", "0x3000", "3000").
  checkRunTarget(target, m = this.shownMachine) {
    if (target == null || (typeof target === 'string' && target.trim().toUpperCase() === 'RUN')) {
      if (!m.hasRom) throw new ToolError(TOOL_CODES.NO_BASIC);
      return null;
    }
    const addr = typeof target === 'string' ? /^(?:\$|0x)?([0-9A-F]+)$/i.exec(target.trim()) : null;
    const value = typeof target === 'string' ? (addr ? parseInt(addr[1], 16) : NaN) : target;
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) throw new ToolError(TOOL_CODES.BAD_TARGET, typeof target === 'string' ? target : JSON.stringify(target));
    return value;
  }
  // start what is in m's memory for Claude's run tool: an address jumps there (-> null); "RUN" (or nothing) is typed
  // at the keyboard the paced way, as type_text types (-> the job, which says whether the machine read the keys)
  runAt(target, m = this.shownMachine) {
    const value = this.checkRunTarget(target, m);
    if (value == null) return this.typeTextPaced('RUN\n', m);
    m.jump(value);
    return null;
  }

  // ---------------- the Claude chat ----------------
  // The API key lives in the host key store, never in a Session setting, so it cannot reach a snapshot, a
  // share link or a settings export (js/host/key-store.js).
  setClaudeKey(key) {
    const k = String(key == null ? '' : key).trim();
    if (k && !/^sk-ant-/.test(k)) throw new SessionError('That does not look like an Anthropic API key (they start sk-ant-).');
    this.keyStore.set(k || null);
    if (this.chat) this.chat.backend.setKey(k);
    return !!k;
  }
  clearClaudeKey() { this.keyStore.clear(); if (this.chat) this.chat.backend.setKey(''); }
  // Whether the full-screen chat's prompt is idle and empty: nothing typed (the firmware's BLEN), no line waiting for
  // its reply (WAIT) and no reply streaming. Then BREAK has nothing to do, and Esc on the screen leaves the chat.
  get chatPromptEmpty() {
    const cm = this.chatMachines && this.chatView === 'chat' && this.chatMachines.chat;
    if (!cm || !this.chat || this.chat.busy) return false;
    return this.readByte(CHAT_STATE.blen, cm) === 0 && this.readByte(CHAT_STATE.blen + 1, cm) === 0 && this.readByte(CHAT_STATE.wait, cm) === 0;
  }
  get hasClaudeKey() { return !!this.keyStore.get(); }
  // Ask Claude: the conversation without the chat machine, shown in the side
  // panel beside the machine in use, which is the BASIC session Claude's tools act on. The same ChatSession moves
  // to full screen (startChat) and back (toSidePanel) without losing anything. Reading (the screen, memory, the
  // machine) always works; acting (poke, type_text, press_break, assemble_and_load, run) waits for consent.asker (the card) the first time, and once
  // allowed stays allowed for the visit.
  startAsk({ backend, brief = '', include = null } = {}) {
    if (this.chat) return this.chat;
    if (!backend) throw new SessionError('Ask Claude needs a backend.');
    this.chat = new ChatSession({ backend, channel: null, brief, tools: true, target: this.chatTarget(), include });
    this.gateTools(this.chat);
    this.claudeView = 'panel';
    this.emit('chat');
    return this.chat;
  }
  // Claude's acting tools ask first (the consent card), record what is being done (the activity pill and log),
  // and stamp the restore point the turn makes before its first change. ChatSession.runTool calls this gate for
  // every acting tool (ACTING_TOOL_NAMES) and for nothing else; a refusal is a ToolError and changes nothing.
  gateTools(chat) {
    // the point's disks were recorded when it was taken (chatTarget's snapshot); it is stamped when it is kept
    // (with the turn it belongs to and the first action it covers: the views put the restore line under that turn,
    // and a restore marks the actions it took back)
    chat.onRestorePoint = (snap) => {
      const info = this.claudePointInfo.get(snap);
      if (info) Object.assign(info, { at: Date.now(), turn: chat.line ? chat.line.turn : null, fromAction: chat.actionSeq });
    };
    // a pause belongs to the turn it was made in: when the turn ends (finished, failed, stalled or stopped) it ends
    // too, so the next turn never starts paused; so does what the turn was doing on the machine, so a later turn
    // that only answers in text is not taken for acting (a key the person presses then is just their key)
    // and any abort of the turn (Stop, BREAK on the chat screen) ends a pause first: the action waiting on it
    // (Consent.wait, in the gate or the re-check) is refused and the held typing dropped, so a later Resume cannot run
    // what was aborted
    chat.onAbort = () => { if (this.chat === chat) this.endClaudePause(); };
    chat.onTurnEnd = () => {
      if (this.chat !== chat) return;
      this.endClaudePause();
      this.claudeCall = null;
      if (this.claudeActing) { this.claudeActing = null; this.emit('chat'); }
    };
    // the tool running now, for the turn's status ("Using type_text…"), and the acting call between its gate and its
    // act (claudeCall), which the person's input pauses (personInput) as it pauses Claude's acting
    chat.onToolStart = (name) => { this.claudeTool = name; this.emit('chat'); };
    chat.onToolEnd = (name) => {
      // (a call of a conversation that has since ended does not clear the new one's)
      if (this.chat !== chat) return;
      this.claudeCall = null;
      if (this.claudeTool === name) this.claudeTool = null;
      this.emit('chat');
    };
    // It answers synchronously when nobody has to be asked, so the restore point is the machine at the call itself
    // (no frame runs in between); a question or a pause makes it a promise. The consent itself is decided in
    // this.consent (js/claude/consent.js): the switch, the cards, the pause.
    const consent = this.consent;
    const decide = (name, input, call) => consent.decide(name, input, call, {
      // load_basic's card describes the load: the same planBasic the tool runs (a load that cannot happen throws here)
      load: () => {
        const plan = planBasic(this.chatTarget(), input && input.program);
        const nums = plan.lines.map((l) => l.number);
        return { lines: nums.length, first: nums[0], last: nums[nums.length - 1], bytes: plan.bytes.length };
      },
      acting: () => { this.claudeActing = { name, input: input || {} }; this.emit('chat'); },
      signal: chat.controller && chat.controller.signal,
    });
    chat.gate = (name, input, call = {}) => {
      this.claudeCall = { name };
      // paused by the person's key: the next action waits for Resume (Stop refuses it)
      if (consent.paused) return consent.wait().then(() => decide(name, input, call));
      return decide(name, input, call);
    };
    // the pre-act re-check, synchronous with the change (ChatSession.runTool): Consent.recheck
    chat.recheck = (name, input, call = {}) => consent.recheck(name, call);
  }
  // What the turn in progress is doing, for the status every view shows with Stop: null when no turn is in
  // progress, else { phase, text, tool }. A card waiting for the person comes first, then a pause by the person's
  // key, then a tool running; otherwise the reply is on its way (the model thinking or streaming).
  get claudeStatus() {
    if (!this.chat || !this.chat.busy) return null;
    // (paused while a card waits: the pause is what the person must know; the card says "Allow and resume")
    if (this.consent.paused) return { phase: 'paused', text: CLAUDE_PAUSED_TEXT, tool: this.claudeTool };
    if (this.consent.pending) return { phase: 'consent', text: 'Waiting for your OK', tool: this.consent.pending.name };
    if (this.claudeTool) return { phase: 'tool', text: `Using ${this.claudeTool}…`, tool: this.claudeTool };
    return { phase: 'thinking', text: 'Thinking…', tool: null };
  }
  // A BASIC program straight into the BASIC session's program memory, as a tape or disk load would: for
  // automation and the embed API, so no card and no restore point. The same implementation as Claude's load_basic
  // (js/claude/basicload.js); failures are ToolErrors with the same codes. -> { lines, bytes, start, end }
  // (the person's input: Claude acting on that machine pauses first, personInput)
  loadBasic(program) { const t = this.chatTarget(); this.personInput(t.machine); return loadBasicInto(t, program); }
  // A key the person presses on the machine pauses Claude: what Claude still had to type is held
  // back, and its next action waits; resumeClaude types the rest and lets it go on, stopClaude drops it.
  // Only during a turn: a pause outside one would have no turn to resume and would carry into the next.
  // Also while an acting call waits at its gate (a card for the person, or its check): the card stays theirs to
  // answer, and Allow does not let the call act past the pause - runTool's re-check (gateTools: chat.recheck) holds
  // it until Resume, and Stop or the turn's end refuses it (stopped) with no restore point taken.
  pauseClaude() {
    if (!this.chat || !this.chat.busy || !(this.claudeBusyActing || this.claudeCall) || this.consent.paused) return false;
    const m = this.chatTarget().machine;
    // what is not yet typed: the typist's queue (paced keys wait there on every machine), and the stub's queued
    // codes unless the one there is the paced key in flight (it finishes; the rest waits)
    const pacedStub = !!(m.typist.state && m.typist.state.stub);
    const held = { queue: m.typist.queue.splice(0), stub: pacedStub || !m.useStub ? [] : m.stubKeys.splice(0) };
    this.consent.pause(held);
    this.emit('chat');
    return true;
  }
  resumeClaude() {
    const p = this.consent.resume();      // (wakes the call waiting on the pause; it goes on once this returns)
    if (!p) return false;
    const m = this.chatTarget().machine;
    // the switch turned off during the pause withdrew consent: nothing held goes in (its typing ends no-consent, as
    // stopClaude drops it), and the call waiting on the pause is refused no-consent (Consent.wait)
    // (held.stub is dropped with no job to end: it holds raw stub codes, and all of Claude's typing - type_text, run's
    // RUN (typeTextPaced) and press_break's BREAK (holdPaced) - is paced through the typist queue (held.queue, whose
    // jobs end above), never left in stubKeys. Only the person's text goes there through queueText, so a Claude job in
    // held.stub is unreachable; were one added, it would need ending here too.)
    if (p.revoked) { for (const it of p.held.queue) if (it && it.job) it.job.end('no-consent'); }
    else { m.stubKeys.push(...p.held.stub); m.typist.queue.push(...p.held.queue); }
    this.emit('chat');
    return true;
  }
  // Stop: the turn ends, a waiting question is answered STOPPED (either card: the tool fails stopped), and what Claude was typing stops being typed.
  // reason: why the page stopped Claude (a Reset, a power cycle), for the note in the conversation; 'claude-stopped' event
  stopClaude(reason = null) {
    if (!this.chat) return;
    this.endClaudePause();
    if (this.consent.pending) this.consent.pending.resolve(STOPPED);   // the question ends as Stop, not as a no
    this.chat.abort(reason);
    const m = this.chatTarget().machine;
    if (m.typist) m.typist.clear();
    if (m.stubKeys) m.stubKeys.length = 0;
    this.claudeActing = null;
    this.emit('chat');
    if (reason) this.emit('claude-stopped', reason);
  }
  // Every restart of a machine and every program started on it comes here (Reset, a power cycle, a load or
  // restartForLoad, inject and runAssembled, and any other reset through the machine's onReset).
  // A restart of the machine Claude acts on while Claude acts on it (or is paused) stops Claude first: what it held
  // back or still had to type must never go into the machine that starts over, and the action it was on is
  // refused. Reset and power cycle say so in their own words; every other restart reaches here through the
  // machine's onReset (install). A restart of the chat machine (the full-screen chat's own screen) leaves Claude
  // alone. (A machine switch or a snapshot load replaces the machine and closes the conversation: adopt -> dropChat.)
  stopClaudeFor(reason, m = this.shownMachine) {
    // a restart or a new program on a machine a write stop froze (pendingStop) releases it: the stop was about the
    // program that is gone, so the machine runs again and no stale stop comes back with it
    if (this.pendingStop && this.pendingStop.machine === m) this.pendingStop = null;
    // (what the program on the machine asks for itself, asMachine: when the keys that asked were Claude's, Claude
    // goes on; when they may have been the person's, it stops)
    if (this.machineTicketHolds(this.machineDriven)) return;
    if (this.chat && m === this.chatTarget().machine && (this.claudeBusyActing || this.consent.paused)) this.stopClaude(reason);
  }
  // What the program on the machine asks for itself (the welcome menu's choices: LIZA, the colour demo, carry on;
  // the menu coming back after LIZA's BYE or the demo: the 'welcome:*' and 'menu' events) was asked by keys typed
  // into the machine. The page takes a ticket when the event comes (machineTicket), fetches what it needs, then
  // starts it in asMachine(fn, ticket). The start does not stop Claude only if the keys were Claude's: Claude was
  // acting and not paused when the event came, and since then the same turn goes on with no pause (a pause, even
  // one resumed, means the person pressed a key; a key pressed while Claude only thought is the person's too).
  machineTicket() {
    // (not while a card waits: nothing of Claude's is typed then, so the key is the person's)
    return { claude: !!this.chat && this.claudeBusyActing && !this.consent.paused && !this.consent.pending, chat: this.chat, controller: this.chat && this.chat.controller, pauses: this.consent.pauses };
  }
  // The ticket the page starts a menu in, by what ASKED for the menu (the 'menu' event's offer). One place decides:
  //   'none'  the machine question's switch: the person chose a machine, so the menu is the person's and takes no
  //           ticket -- session.menuTicket is whatever an earlier LIZA BYE left there, and using it for a person's
  //           own click could start the menu as if Claude had asked (and so keep Claude running when it should stop);
  //   'back'  a returning visit or a reset, nothing of a program asking: no ticket (the page passed null before);
  //   null    a program asked (the demo's key, or a LIZA BYE: checkMenuReturn emits 'menu' with no argument): the
  //           ticket the Session gave when the program asked (this.menuTicket, else the one taken at the event).
  // The page passes only 'none', 'back' and null.
  menuTicketFor(offer, asked) {
    if (offer === 'none' || offer === 'back') return null;
    return this.menuTicket || asked;
  }
  machineTicketHolds(t) {
    return !!t && t.claude && !this.consent.paused && t.pauses === this.consent.pauses && t.chat === this.chat && t.controller === (this.chat && this.chat.controller);
  }
  // fn: synchronous only, so the exemption covers exactly that start and nothing the person does meanwhile (the
  // page fetches the bytes first): a function that returns a promise is refused
  asMachine(fn, ticket) {
    const was = this.machineDriven;
    this.machineDriven = ticket || null;
    try {
      const out = fn();
      if (out && typeof out.then === 'function') throw new SessionError('asMachine runs synchronous work only.');
      return out;
    } finally { this.machineDriven = was; }
  }
  // does the pause hold something of Claude's: an acting call waiting (at its gate, its card or its re-check, or its
  // typing in flight), or typing held back
  get claudeHeld() {
    const p = this.consent.paused;
    return !!p && !!(this.claudeCall || p.held.queue.length || p.held.stub.length);
  }
  // the pause ends with its turn: nothing held is typed later, and an action waiting on it is refused (stopped)
  endClaudePause() {
    const p = this.consent.endPause();    // (the call waiting on the pause is refused stopped)
    if (!p) return false;
    for (const it of p.held.queue) if (it && it.job) it.job.end('stopped');   // held-back typing ends with the turn
    this.emit('chat');
    return true;
  }
  // is Claude acting on the BASIC session now: an acting tool this turn (claudeActing ends with the turn), paused,
  // or its typing still going in
  // (paused: only while something of Claude's is held by the pause, claudeHeld; a pause after a declined card while
  // Claude only writes text is not acting)
  get claudeBusyActing() {
    if (!this.chat || !this.claudeActing) return false;
    if (this.consent.paused) return this.claudeHeld;
    const m = this.chatTarget().machine;
    return this.chat.busy || (m.typist && m.typist.busy) || (m.stubKeys && m.stubKeys.length > 0);
  }
  // the code at addr (the program counter by default), as the Debugger would show it, for "What is this code
  // doing?": { from, to, text } with one "ADDR  BYTES  INSTRUCTION" line per instruction and the registers
  // It reads the BASIC session, the machine the read tools use: in the full screen chat the shown machine is the chat firmware.
  codeAt(addr, count = 8) {
    const m = this.chatMachines ? this.chatMachines.basic : this.shownMachine, { cpu, dp } = codeDisassembly(m);
    if (addr === undefined) addr = m.cpu.pc;
    const peek = (a) => this.readByte(a & 0xFFFF, m);
    const labels = new Map();
    if (this.labels) for (const [name, at] of this.labels) if (!labels.has(at)) labels.set(at, name);
    const list = disassembleBlock(cpu, addr & 0xFFFF, count, { peek, dp, labelOf: (a) => labels.get(a) || null });
    const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
    let at = addr & 0xFFFF;
    const lines = list.map((ins) => {
      const bytes = Array.from({ length: ins.size }, (_, i) => hex(peek(at + i), 2)).join(' ');
      const line = `${hex(at, 4)}  ${bytes.padEnd(12)} ${labels.get(at) ? `${labels.get(at)}  ` : ''}${ins.text}`;
      at = (at + ins.size) & 0xFFFF;
      return line;
    });
    const c = m.cpu;
    // the same register set the Debugger shows: the 6309's E F W Q V MD are part of what the code did
    const regs = cpu === '6803'
      ? `PC=${hex(c.pc, 4)} A=${hex(c.a, 2)} B=${hex(c.b, 2)} X=${hex(c.x, 4)} S=${hex(c.s, 4)} CC=${hex(c.cc, 2)}`
      : cpu === '6309'
        ? `PC=${hex(c.pc, 4)} A=${hex(c.a, 2)} B=${hex(c.b, 2)} E=${hex(c.e, 2)} F=${hex(c.f, 2)} D=${hex(c.d, 4)} W=${hex(c.w, 4)} Q=${hex(c.q, 8)} V=${hex(c.v, 4)} MD=${hex(c.md, 2)} X=${hex(c.x, 4)} Y=${hex(c.y, 4)} U=${hex(c.u, 4)} S=${hex(c.s, 4)} DP=${hex(c.dp, 2)} CC=${hex(c.cc, 2)}`
        : `PC=${hex(c.pc, 4)} A=${hex(c.a, 2)} B=${hex(c.b, 2)} X=${hex(c.x, 4)} Y=${hex(c.y, 4)} U=${hex(c.u, 4)} S=${hex(c.s, 4)} DP=${hex(c.dp, 2)} CC=${hex(c.cc, 2)}`;
    return { from: addr & 0xFFFF, to: (at - 1) & 0xFFFF, text: lines.join('\n'), registers: regs };
  }
  // the restore points, newest first: [{ at (ms), index, turn }]; restoreClaude(i) puts the BASIC session back to point
  // i (undo[i]) and drops the newer ones. `turn` is the number of the turn the point was taken in (null if unknown).
  get claudePoints() {
    if (!this.chat) return [];
    return this.chat.undo.map((snap, index) => { const info = this.claudePointInfo.get(snap) || {}; return { index, at: info.at || null, turn: info.turn == null ? null : info.turn }; }).reverse();
  }
  // The point is checked first; only once it can be restored does Claude stop, and the newer points go only once it
  // has been. A point that can't be restored (the ROMs changed since it was taken: Forget ROMs, Run without ROMs)
  // throws a SessionError and changes nothing: the machine, Claude and every point stay as they were (a load that
  // fails part way is rolled back). The disks go back to the store only as restorePoint says.
  // -> false (no such point) or { notices }: restorePoint's notices, for the person
  restoreClaude(index = this.chat ? this.chat.undo.length - 1 : -1) {
    const chat = this.chat;
    if (!chat || index < 0 || index >= chat.undo.length) return false;
    const snap = chat.undo[index], m = this.chatTarget().machine;
    // one sentence: the page's toast shows the first one and keeps the rest under Details
    try { m.checkSnapshot(snap); } catch (e) { throw new SessionError(`Can't restore that point (${e.message}): nothing was changed, and your restore points are kept.`); }
    // Claude stops first, so what it was typing is let go on the machine as it is now, not on the restored one
    this.stopClaude();
    const notices = this.drives.restorePoint(m, snap);
    chat.undo.length = index;
    // the actions the point took back are marked undone, with the restore's time
    const info = this.claudePointInfo.get(snap);
    if (info && info.fromAction != null) chat.markUndone(info.fromAction);
    chat.changed();
    this.emit('chat');
    return { notices };
  }
  // full screen -> the side panel: the BASIC session back on screen, the chat machine gone, the conversation kept
  toSidePanel() {
    if (!this.chat) return false;
    if (this.chatMachines) {
      const basic = this.chatMachines.basic, ch = this.chat.channel;
      this.chat.channel = null;
      if (ch && typeof ch.close === 'function') ch.close();
      this.clearStubRuns([this.chatMachines.chat]);   // (the BASIC session keeps its own: it comes back unchanged)
      if (this.menuWatch && this.chatMachines && this.menuWatch.m === this.chatMachines.chat) this.menuWatch = null;   // as dropChat
      this.chatMachines = null; this.chatView = null; this.chatServer = null;
      if (this.shownMachine !== basic) { this.install(basic); this.emit('machine'); }
    }
    this.claudeView = 'panel';
    this.emit('chat');
    return true;
  }
  // Start a chat. The machine in use stays as the BASIC session, kept alongside the chat: Claude's
  // tools act on it. The chat runs on a second machine of the same model and options, on the stub firmware
  // (no ROM needed), with the chat firmware loaded; that machine is shown and gets the keyboard. The channel
  // carries bytes between the chat firmware and the backend, moved after every frame of the chat machine.
  // A conversation already open in the side panel (startAsk) moves here: the firmware is given what was said so
  // far, and the same ChatSession goes on with this channel.
  //   deps: { backend, channel, firmware (examples/chat.bin), brief, tools, drivewire, include (the INCLUDE reader) }
  // drivewire: the chat machine gets the Becker port and its own DriveWire server on the Session's drives
  // (chatServer, so its link never mixes with the BASIC session's), and the firmware talks to the backend on
  // virtual serial channel CHAT_DW_CHANNEL, as it would on a real machine with a Becker port; the channel
  // defaults to that DriveWire channel. Otherwise the firmware's mailbox and the channel given (MemoryChannel).
  // showChat('basic') puts the BASIC session on screen (the person: Show my BASIC session, Ctrl+B), showChat('chat')
  // brings the chat back. Both machines run (the one off screen is the live picture-in-picture), so Claude's
  // typing goes in while the chat is on screen, and a reply reaches the firmware while BASIC is.
  // Only 6809-family machines (the 6809 and the 6309, which runs the 6809 firmware in emulation mode) run the
  // chat firmware for now.
  startChat({ backend, channel, firmware, brief = '', tools = true, drivewire = false, include = null } = {}) {
    const basic = this.shownMachine;
    if (!backend) throw new SessionError('The chat needs a backend.');
    if (!firmware) throw new SessionError('The chat needs its firmware (examples/chat.bin).');
    if (cpuFamily(basic.config.cpu) !== '6809') throw new SessionError(`The chat firmware needs a 6809; the ${basic.profile.name} has a ${basic.config.cpu}.`);
    if (drivewire && !basic.profile.options.becker) throw new SessionError(`The ${basic.profile.name} has no Becker port, so the chat cannot use DriveWire there.`);
    // the firmware lives at $6000-$7FFF and draws at $0400: with 4K or 16K it would load into memory that is not there
    // (a dead screen), so it is refused, saying how to get the memory
    if (basic.config.ram < 32) {
      throw new SessionError(`The chat needs 32K of memory or more; this ${basic.profile.name} has ${basic.config.ram}K. Give it 32K or more in its settings, or use a Dragon 32 or 64.`);
    }
    const kept = this.chat && !this.chatMachines ? this.chat : null;   // the side panel's conversation moves here
    if (!kept) this.dropChat();
    // the welcome program, if it runs, stays on the BASIC session: closing the chat comes back to its menu
    // the chat machine carries the Becker port only when the chat talks on it: with the mailbox there is
    // nothing for the port to do, and a becker on it would take the Session's server and the BASIC
    // session's prints with it (a machine without the option keeps a config without the key)
    const chatConfig = Object.assign({}, basic.config);
    if (drivewire) chatConfig.becker = true; else delete chatConfig.becker;
    const chatMachine = createMachine(basic.id, chatConfig);
    if (drivewire) {
      this.chatServer = this.newDriveWireServer({ clock: this.drivewire.clock });
      this.chatServer.drives = this.drivewire.drives;
      this.chatServer.onPrint = this.dwPrint(chatMachine);   // the chat machine's prints are its own, too
      chatMachine.becker.attach(this.chatServer);
      if (!channel) channel = new DriveWireChatChannel(this.chatServer, CHAT_DW_CHANNEL);
    }
    if (!channel) throw new SessionError('The chat needs a channel.');
    chatMachine.stubKeepCase = true;      // the firmware draws lower case: typed text reaches it as typed
    chatMachine.reset(true);
    this.chatMachines = { chat: chatMachine, basic };
    this.chatView = 'chat';
    this.install(chatMachine);
    this.emit('machine');
    // on the chat machine itself (not loadTarget: the chat's own firmware is the one thing that loads there)
    this.loadMedia('chat.bin', firmware, null, { on: chatMachine });
    // (the load is the chat machine's own: the welcome and the menu watch it would end belong to the BASIC session
    // beside it, and endWelcome(m) leaves them, as it leaves the person's welcome running on the stub)
    if (kept) {
      kept.channel = channel;
      kept.brief = brief;              // its replies are now read on the chat screen
      channel.onReceive = (bytes) => { if (bytes) kept.receive(bytes); };
      // what was said so far, as the firmware would have shown it; a reply still streaming goes on after it
      const said = transcript(kept.messages).map((m) => (m.role === 'user' ? `> ${m.content}\r\n` : `${m.content}\r\n`)).join('');
      if (said) channel.send(new TextEncoder().encode(said.replace(/\r?\n/g, '\r\n').replace(/\r\r\n/g, '\r\n')));
      if (!kept.busy) channel.send(Uint8Array.of(END_OF_REPLY));
    } else {
      this.chat = new ChatSession({ backend, channel, brief, tools, target: this.chatTarget(), include });
      this.gateTools(this.chat);
    }
    this.claudeView = 'full';
    this.emit('chat');
    return this.chat;
  }
  // A line of ours on the chat screen, as the firmware shows a reply (the page's "No API key yet" hint, so it is on the
  // screen and not only beside it). Not said by anyone: the conversation, its history and Claude never see it.
  chatNote(text) {
    const chat = this.chat;
    // (not while a reply streams: the note would land in the middle of it)
    if (!chat || !chat.channel || !this.chatMachines || chat.busy) return false;
    chat.channel.send(new TextEncoder().encode(`${String(text).replace(/[\r\n]+/g, ' ')}\r\n`));
    chat.channel.send(Uint8Array.of(END_OF_REPLY));
    return true;
  }
  // what the chat's tools act on: the BASIC session: beside the chat machine in full screen, else the
  // machine in use. It runs whether or not it is on screen, so acting never swaps the screen (show does nothing):
  // the person watches it live in the picture-in-picture
  chatTarget() {
    const basic = () => (this.chatMachines ? this.chatMachines.basic : this.shownMachine);
    return {
      get machine() { return basic(); },
      show: () => {},
      screenText: () => this.screenText(basic()),
      readByte: (addr) => this.readByte(addr, basic()),
      // What the read-only tools ask about the machine they act on: whether BASIC has printed OK. bootStatus()
      // answers about the shown machine, which is the chat while a chat is open, so this asks the SAME
      // question of the BASIC session - and answers it the same way, through the one implementation below, so the
      // latch and the 'failed' state cannot differ between the two views of the same machine.
      bootStatus: () => this._bootStatusOf(basic()),
      pokeBytes: (addr, bytes) => this.pokeBytes(addr, bytes, basic()),
      typeText: (text) => this.typeTextPaced(text, basic()),
      untypable: (text) => this.untypable(text, basic()),
      pressBreak: () => this.pressBreak(basic()),
      writeKind: (addr) => basic().writeKind(addr),
      writeSegments: (res) => this.injectAssembled(res, basic()),
      checkRun: (t) => this.checkRunTarget(t, basic()),
      run: (t) => this.runAt(t, basic()),
      // stopped by the Debugger -> { pc, kind }, else null (Session.stoppedOn): the tools that must run it refuse
      stopped: () => this.stoppedOn(basic()),
      // fn() at every Debugger stop of this machine -> a function that stops listening
      onStopped: (fn) => this.on((ev, m) => { if (ev === 'debugger-stopped' && m === basic()) fn(); }),
      // a restore point: when it was taken and the drives linked to the media store at that moment (their links)
      snapshot: () => { const snap = basic().snapshot(); this.claudePointInfo.set(snap, { at: Date.now(), disks: this.drives.stored(basic()) }); return snap; },
      // the same guarded path as restoreClaude -> restorePoint's notices
      restore: (snap) => this.drives.restorePoint(basic(), snap),
    };
  }
  // 'chat' or 'basic' on screen; 'chat' event
  showChat(which) {
    if (!this.chatMachines || !this.chatMachines[which]) return false;
    if (this.chatView !== which) { this.chatView = which; this.install(this.chatMachines[which]); this.emit('machine'); }
    this.emit('chat');
    return true;
  }
  // close the chat: the BASIC session comes back on screen
  endChat() {
    if (!this.chat) return;
    const basic = this.chatMachines ? this.chatMachines.basic : this.shownMachine;
    this.dropChat();
    if (this.shownMachine !== basic) { this.install(basic); this.emit('machine'); }
    this.emit('chat');
  }
  dropChat() {
    if (!this.chat) return;
    if (this.consent.pending) this.consent.pending.resolve(false);
    this.chat.abort();
    // the chat's own machine goes with it; the BASIC session beside it comes back unchanged, and keeps what it
    // ran (its Reset restarts LIZA, its menu watch stands), as if the chat had never opened
    if (this.chatMachines) this.clearStubRuns([this.chatMachines.chat]);
    if (this.menuWatch && this.chatMachines && this.menuWatch.m === this.chatMachines.chat) this.menuWatch = null;   // a watch on the machine being dropped
    this.chat = null; this.chatMachines = null; this.chatView = null; this.chatServer = null;
    this.endClaudePause();
    this.claudeView = null; this.claudeActing = null; this.consent.pending = null; this.consent.paused = null; this.claudeTool = null; this.claudeCall = null;
  }

  // assembled program (Emu.assemble result) -> message
  runAssembled(res) {
    // the assembler panel is the person's: the program runs on personMachine (inject's default is the machine in
    // use, which with the chat full screen is the chat machine - the sweep's runAssembled row was red on that)
    this.endWelcome(this.personMachine);
    this.inject(res.segments, res.exec, this.personMachine);
    this.labels = res.symbols;                    // the debugger's disassembly shows them (see `debug`)
    if (this.debugger) this.debugger.setSymbols(() => this.labels);
    this.emit('loaded');
    return `Assembled program running at ${hex(res.exec)}`;
  }

  // ---------------- LIZA on every machine ----------------
  // One way to start the conversation program. The 6803 build is for the MC-10 family (it uses that
  // machine's ROM entry points and its $4000 text screen) and sits at $5000, so it needs the 20K RAM
  // option; every 6809-family machine (the 6809 and the 6309) runs the 6809 build. The 6803 build's title
  // names the machine, so it is built once per machine (its two images differ only in the title). The page
  // fetches the file; startLiza is given the bytes because the emulator library has no file access of its own.
  // done: each build's DONE loop, where it stops after BYE (tests/returning.test.js assembles the sources and
  // checks these)
  static LIZA = { '6809': 'liza.bin', ram: 20, '6803': Object.freeze({ mc10: 'liza6803-mc10.bin', alice: 'liza6803-alice.bin' }),
    done: Object.freeze({ '6809': 0x3033, '6803': 0x503C }) };
  // the person's machine (personMachine): LIZA is theirs, so it is theirs to name. NOT proven by a red revert, and
  // not claimed as a leak fix: the chat machine is built from the BASIC session (startChat: same model, same config,
  // so same id and CPU), and both answer this getter the same - the id keys the 6803 table and the CPU picks the
  // build. It is routed here because it is the person's program, which is what the classification asks; the sweep
  // cannot show it (there is no state in which the two machines disagree).
  get lizaFile() { const m = this.personMachine; return cpuFamily(m.config.cpu) === '6809' ? Session.LIZA['6809'] : Session.LIZA['6803'][m.id]; }
  // what a machine needs before it can run LIZA -> { ram, have } when the RAM option is too small, else null
  lizaNeeds() {
    const m = this.personMachine, need = Session.LIZA.ram;
    if (cpuFamily(m.config.cpu) !== '6803' || m.config.ram >= need) return null;
    return { ram: need, have: m.config.ram };
  }
  // startLiza(fetch) -> the load message. fetch(name) gives the file's bytes, or a promise of them
  // (the page fetches it). On a machine with too little RAM it refuses and says what to do; switchLiza
  // switches.
  async startLiza(fetch) {
    this.checkLiza();
    return this.runLiza(await fetch(this.lizaFile));
  }
  checkLiza() {
    const need = this.lizaNeeds();
    if (need) throw new SessionError(`LIZA needs ${need.ram}K RAM on this machine, which has ${need.have}K. Switch the RAM option to ${need.ram}K to run it.`);
  }
  // LIZA from its bytes (this.lizaFile's), at once -> the load message
  runLiza(bytes) {
    this.checkLiza();
    const msg = this.load(this.lizaFile, bytes, { remember: false });
    this.setLastRun('liza', 'LIZA');
    this.watchForMenu('liza', this.personMachine);
    this.markProgramStart('liza', this.personMachine);
    this.emit('program', 'liza');
    return msg;
  }
  // A game (GAMES.list key) from its bytes, at once -> the load message. The games are 6809 programs: on another CPU
  // the Session refuses, saying so.
  gameFile(name) {
    const g = GAMES.list[name];
    if (!g) throw new SessionError(`There is no game called "${name}" (there are ${Object.keys(GAMES.list).join(' and ')}).`);
    return g.file;
  }
  // what the machine in use lacks for the games -> { ram, have } when its RAM option is under GAMES.ram, else null
  gameNeeds() {
    const m = this.personMachine;
    return m.config.ram < GAMES.ram ? { ram: GAMES.ram, have: m.config.ram } : null;
  }
  // can game `name` run here? Throws a SessionError that says why not (another CPU, too little RAM)
  checkGame(name) {
    const g = GAMES.list[name], m = this.personMachine;
    this.gameFile(name);
    if (cpuFamily(m.config.cpu) !== '6809') throw new SessionError(`${g.name} is 6809 code; the ${m.profile.name} has a ${m.config.cpu}.`);
    const need = this.gameNeeds();
    if (need) throw new SessionError(`${g.name} needs ${need.ram}K RAM or more; this ${m.profile.name} has ${need.have}K. Switch the RAM option to ${need.ram}K or 64K to play it.`);
  }
  runGame(name, bytes) {
    this.checkGame(name);
    const file = this.gameFile(name), m = this.personMachine;
    const msg = this.load(file, bytes, { remember: false });
    // the SAM's memory size as the firmware or BASIC left it, for the game to put back on leaving (the CoCo 3's
    // GIME has no M bits: the header's default stays)
    if (m.sam) m.poke(GAMES.samExit, m.sam.memSize);
    this.setLastRun('game', GAMES.list[name].name);
    this.watchForMenu('game', m);
    if (this.menuWatch) this.menuWatch.game = name;
    this.markProgramStart(name, m);
    this.emit('program', name);   // (after the watch: gameRunning and programControls hold for the listeners)
    return msg;
  }
  // Leaving a program goes back to the welcome menu: BYE in LIZA (it stops at its DONE
  // loop; the goodbye stays readable for LIZA_BYE_SECONDS), BREAK in a game (it stops at GAMES.done), any key once the colour demo is drawing (it has taken
  // its "press any key" from the stub and reads no keys after that, so one waiting in the stub's queue is the
  // visitor's asking to leave). Only on a 6809-family machine on the stub firmware,
  // where the welcome menu runs; the Session emits 'menu' and the page starts the menu again (it has its bytes).
  // A load, a switch, a reset or a power cycle ends the watch.
  // A game is watched with BASIC ROMs too: there BREAK hands the machine back to BASIC with a warm reset (BASIC
  // sets up the SAM, the PIAs and its interrupts again), as there is no menu to go back to.
  // The watch belongs to ONE machine, and the caller names it: the chat (startChat) puts a second machine of its
  // own on screen while the one LIZA runs on keeps running beside it, and that is not a replacement. DEFAULTING to
  // the machine on screen is what let the page watch a demo on the chat's machine, which closing the chat then
  // dropped with the watch still set. Only a machine that is really replaced - a switch, a snapshot, a power
  // cycle, a load over it - ends the watch.
  watchForMenu(kind, on) {
    const m = on;
    if (!m) throw new SessionError('watchForMenu needs the machine the program runs on.');
    const watch = kind === 'game' && !m.useStub ? true : this.welcomeMenu && WELCOME[cpuFamily(m.config.cpu)] && m.useStub;
    this.menuWatch = watch ? { kind, m, since: null, taken: m.stubKeysTaken, drawing: false } : null;
    const r = this.stubRuns.get(m);
    if (r) r.watch = kind;   // a Reset restarts the watch too
  }
  checkMenuReturn() {
    const w = this.menuWatch;
    if (!w) return;
    // another machine is on screen (the chat's own): its frames run beside the watched one and say nothing about
    // it. The menu is a start on the machine in use, so a return that comes now waits, unchanged.
    if (w.m !== this.shownMachine) return;
    const m = w.m;
    if (!m.useStub && w.kind !== 'game') { this.menuWatch = null; return; }
    if (w.kind === 'game') {
      if (m.cpu.pc !== GAMES.done) return;
      if (!m.useStub) {   // with BASIC: back to it (the machine asked, as a menu return is asked)
        // A cold start, not a warm one: the game has drawn over $0400-$1BFF (BASIC's program, the graphics pages,
        // a disk DOS's workspace and FAT copy) and run from $3000, so nothing BASIC had there can be trusted. The
        // reset button keeps the cartridge and disks; clearing BASIC's warm-start flag (RSTFLG, $0071, on the
        // Dragon and the CoCo alike; $55 means warm) makes BASIC start afresh, as at power-on.
        this.menuWatch = null;
        m.poke(BASIC_RSTFLG, 0);
        this.asMachine(() => this.reset(), this.machineTicket());
        return;
      }
    } else if (w.kind === 'liza') {
      // the goodbye's time is the machine's: its frames since LIZA reached DONE (this runs once per advance(),
      // which can run several frames, or none)
      if (m.cpu.pc !== Session.LIZA.done[cpuFamily(m.config.cpu)]) { w.since = null; return; }
      // (whose keys asked for the menu is decided now, when LIZA has its BYE, not when the goodbye ends)
      if (w.since === null) { w.since = m.frameCount; w.ticket = this.machineTicket(); }
      if (m.frameCount - w.since < LIZA_BYE_SECONDS * m.fps) return;
    } else {
      if (!w.drawing) { w.drawing = m.stubKeysTaken > w.taken; return; }   // its "press any key" taken
      if (!m.stubKeys.length) return;
      m.stubKeys.length = 0;
    }
    this.menuWatch = null;
    // the page starts the menu in asMachine with this ticket (machineTicket): the keys that asked for it
    this.menuTicket = w.ticket || this.machineTicket();
    this.menuReason = 'return';
    this.emit('menu');
  }
  // the one-step switch: fit the RAM option LIZA needs, keeping the other options
  switchLiza() {
    const m = this.shownMachine, need = Session.LIZA.ram;
    this.switchMachine(m.id, Object.assign({}, this.savedConfig(m.id), { ram: need }));
    return need;
  }
  // insert a tape for a manual CLOAD / CLOADM: .CAS bytes, or a WAV recording (decoded to .CAS)
  insertTape(name, bytes) {
    const m = this.personMachine, d = formats.identify(name, bytes);
    if (d.kind === 'wav') throw new SessionError(d.error ? `${name}: ${d.error}` : `${name}: no tape blocks found in this recording`);
    this.touch(m);
    m.deck.insert(new Tape(d.kind === 'cas' ? d.bytes : bytes, m.tickHz, name, m.profile.tape));
    this.emit('tape');
    // with no BASIC running (the stub, or BASIC has not printed OK yet) there is nothing to type CLOAD into: the tape
    // says so, and Skip the tape (skipTape) is the way to load it
    const decoded = d.wav ? ` (decoded from the recording: ${d.wav.blocks} blocks)` : '';
    if (!this.basicRunning) return `${name} is in the deck${decoded}. There's no BASIC to type CLOAD into.`;
    return `Tape ${name} inserted${decoded}. Type CLOAD or CLOADM.`;
  }
  // Is BASIC running on the person's machine: ROMs in use and its OK seen since the last power-on (bootStatus 'ok'), or
  // a moment opened from a snapshot (Machine.restored, cleared by every reset): not a power-on, so no OK to wait for,
  // and it has BASIC's ROMs. Only the stub (no ROMs in use), a power-on still short of OK and NitrOS-9's loader are
  // "no BASIC".
  get basicRunning() {
    const m = this.personMachine;
    if (!m.hasRom || this.nitros9On(m)) return false;
    return m.restored || this._bootStatusOf(m).state === 'ok';
  }
  // the tape in the deck as a WAV file (its signal: one sine cycle per bit) -> { name, bytes }
  tapeWav() {
    const t = this.personMachine.deck.tape;
    if (!t) throw new SessionError('There is no tape in the deck.');
    const p = this.personMachine.profile.tape || {};
    return { name: t.name.replace(/\.[^.]*$/, '') + '.wav', bytes: casToWav(t.bytes, { zeroHz: p.zeroHz, oneHz: p.oneHz, pad: p.pad, gaps: 'player' }) };
  }

  // ---------------- recording what the machine writes to tape (CSAVE, CSAVEM, your own writer) ----------------
  get tapeRecording() { return !!this.personMachine.deck.recording; }
  startTapeRecording() {
    this.personMachine.deck.startRecording();
    return 'Recording the cassette output: CSAVE or CSAVEM now.';
  }
  // -> { cas, wav, blocks, badBlocks, seconds }: .CAS bytes decoded from what was written, and the signal itself
  stopTapeRecording(sampleRate = 44100) {
    const m = this.personMachine, events = m.deck.stopRecording(), p = m.profile.tape || {};
    const samples = recordingToSamples(events, m.tickHz, sampleRate);
    const r = samplesToCas(samples, sampleRate, { zeroHz: p.zeroHz, oneHz: p.oneHz });
    return { cas: r.bytes, wav: writeWav(samples, sampleRate), blocks: r.blocks, badBlocks: r.badBlocks, seconds: samples.length / sampleRate };
  }
  // A recording still running when its machine goes (a machine switch, a snapshot opened) is finished and kept as
  // unsavedRecording ({ cas, wav, blocks, badBlocks, seconds, machine: its name }), then 'recording' is emitted while
  // that machine is still the one in use, so the page can offer to save it before it changes. A recording with no
  // block in it holds nothing to save and is dropped.
  keepRecording() {
    if (!this.shownMachine || !this.tapeRecording) return;
    const r = this.stopTapeRecording();
    if (!r.blocks) return;
    this.unsavedRecording = Object.assign(r, { machine: this.shownMachine.profile.name });
    this.emit('recording');
  }
  rewindTape() { const t = this.personMachine.deck.tape; if (t) t.seekByte(0); this.tapeWatch = null; this.tapeStarted = null; return !!t; }
  // Take the tape out of the deck. A program waiting on the tape (BASIC's CLOAD) is left waiting, as on a real
  // machine with the cassette taken out; nothing is reset. -> whether there was a tape
  ejectTape() {
    const deck = this.personMachine.deck, had = !!deck.tape;
    deck.eject();
    this.tapeWatch = null; this.tapeStarted = null;
    this.emit('tape');
    return had;
  }
  // The file a tape recording is saved as -> { name, files: the number of files written to it }. It is named after
  // the first file's name in its header (as CSAVE "HELLO" wrote it): trimmed, with the characters a file name can't
  // take replaced by "_", as NAME.CAS; with no header or a blank name, "Recording HH-MM.cas" (the time now). Several
  // files recorded in one go make one tape, named after the first. (The library may already hold the name:
  // library.uniqueName gives the one to use.)
  static recordingName(cas, now = new Date()) {
    const files = formats.identify('recording.cas', cas).files || [];
    const first = files.length ? files[0].name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim() : '';
    const pad = (n) => String(n).padStart(2, '0');
    return { name: first ? `${first}.CAS` : `Recording ${pad(now.getHours())}-${pad(now.getMinutes())}.cas`, files: files.length };
  }

  // ---------------- the cassette panel ----------------
  // What the deck is doing -> null without a tape, else { name, block, blocks, file, files, progress, seconds, duration,
  // position, length, atEnd, motor, playing, realSpeed, error, started }. started is the exec address of a machine-code
  // file the drop fast-loaded and started, until the tape moves on; block counts the tape's blocks (js/media/cassette.js
  // casBlocks) the play position has reached, file the files (namefile blocks) it has reached, of files; position is that place as a byte of the image (0 to length, the leader
  // the deck adds before it counting as 0); seconds is how far into the tape that is at real speed. error is the block
  // number where BASIC stopped with ?IO ERROR: a run of the motor that ends with that on the last lines of
  // the screen (the ROM's own report, so it needs the text screen of a Dragon, CoCo 1/2 or MC-10).
  tapeStatus() {
    const m = this.personMachine, deck = m.deck, t = deck.tape;
    if (!t) { this.tapeWatch = null; return null; }
    deck.sync();
    if (!this.tapeInfo || this.tapeInfo.tape !== t) {
      const all = Array.from(casBlocks(t.bytes));
      // files: where each file's namefile block starts (a tape of several files says which one is playing)
      this.tapeInfo = { tape: t, blocks: all.map((b) => b.start), files: all.filter((b) => b.ok && b.type === 0x00).map((b) => b.start), duration: t.seconds() };
      this.tapeWatch = null;
    }
    const info = this.tapeInfo, at = t.bytePosition();
    const block = info.blocks.filter((start) => start <= at).length;
    const file = info.files.filter((start) => start <= at).length;
    // fast-loaded and started: true until the tape moves on (the motor runs: the program reads the rest) or is taken out
    if (this.tapeStarted && (this.tapeStarted.tape !== t || deck.motor)) this.tapeStarted = null;
    // read errors: watch each run of the motor
    if (deck.motor) { if (!this.tapeWatch || this.tapeWatch.done) this.tapeWatch = { done: false, error: null }; }
    else if (this.tapeWatch && !this.tapeWatch.done) {
      const last = this.screenText().filter((l) => l.trim()).slice(-2).join(' ');
      this.tapeWatch = { done: true, error: /\?IO ERROR/.test(last) ? Math.max(1, block) : null };
    }
    return {
      name: t.name, block, blocks: info.blocks.length, file, files: info.files.length, progress: t.progress(), seconds: t.progress() * info.duration, duration: info.duration,
      position: Math.max(0, Math.min(t.bytes.length, at)), length: t.bytes.length, atEnd: t.atEnd(),
      motor: deck.motor, playing: deck.playing, realSpeed: !this.fastTape, error: this.tapeWatch ? this.tapeWatch.error : null,
      started: this.tapeStarted ? this.tapeStarted.exec : null,
    };
  }
  // Skip the tape: load what is on it instantly instead (the machine is power cycled first, so whatever BASIC
  // was doing with the tape stops; the cartridge comes out with it, as on any power cycle) -> message
  // A tape's bytes are always .CAS blocks (a WAV recording is decoded when it goes in), so they are loaded under a
  // .CAS name (.C10 / .K7 kept: the same block format); what would make the load fail is checked before the power
  // cycle, which takes the tape out, so a refused skip leaves the tape where it was.
  skipTape() {
    const m = this.personMachine, t = m.deck.tape;
    if (!t) throw new SessionError('There is no tape in the deck.');
    const ext = (t.name.split('.').pop() || '').toLowerCase();
    const name = /^(cas|c10|k7)$/.test(ext) ? t.name : `${t.name.replace(/\.[^.]*$/, '')}.cas`;
    const d = formats.identify(name, t.bytes);
    if (d.kind !== 'cas' || !d.files.length) throw new SessionError(`${t.name}: no complete file on this tape to load instantly.`);
    if (d.files[0].fileType === 0 && !m.hasRom) throw this.needsRom('A BASIC tape');
    const { bytes } = t, fast = this.fastCas;
    this.powerCycle({ on: m });      // the person's machine (it was this.shownMachine: with the chat on screen, the chat's)
    this.fastCas = true;
    // remembered: this is the person's own tape, loaded at their click (Load it now / Skip the tape), so it belongs in
    // "Recent on this machine" like any file they opened. It was remember: false -- the flag LIZA and the games use,
    // which is for the programs that are OURS, not theirs -- so a tape the person supplied never reached the list.
    try { return this.load(name, bytes); } finally { this.fastCas = fast; }
  }

  // ---------------- the welcome program ----------------
  // Run the welcome program on the built-in stub of the machine in use (also when it has ROMs: "Use the
  // ROMs again" brings BASIC back). `bytes` is that machine's build: the 6809 build for the 6809 models,
  // the 6803 build for the MC-10 and Alice (see welcomeFile). Keys 1-4 then emit 'welcome:liza',
  // 'welcome:demo', 'welcome:roms' and 'welcome:claude' after the frame they were pressed in; on the 6809 build key 5
  // opens the games menu, whose 1 and 2 emit 'welcome:2048' and 'welcome:minesweeper'.
  // greeting: 'first', 'back' (a returning visitor) or 'bye' (back from a program); carryOn: a name for the carry-on
  // option, "CARRY ON WITH <name>" (option 6 on the 6809 build, 5 on the 6803 build; its key emits 'welcome:carryon'), or null
  // gen: the welcomeGen a page took (welcomeGenNow) before fetching these bytes. When it is given and something
  // took the machine since, the start does nothing and this returns null: the menu must not take the screen back
  // from what the person started while its bytes were on the way.
  // reason: why it starts (WELCOME_REASONS); without one, the reason the menu was offered with (offerMenu), else 'visit'.
  // A silent reason ('switch', 'reset', 'return') keeps the tune from playing: PLAYED is set once the firmware has
  // cleared it in its first frame (flushWelcome), whether or not the audio is unlocked, now or later.
  startWelcome(bytes, { greeting = 'first', carryOn = null, gen = null, reason = null } = {}) {
    const why = reason || this.menuReason || 'visit';
    this.menuReason = null;
    if (!WELCOME_REASONS.includes(why)) throw new SessionError(`unknown welcome reason "${why}"`);
    // The ticket catches "the machine was taken by something else while the bytes were in flight" -- a program
    // loaded, a snapshot opened, a Reset, a switch the person did not ask for. It is compared BEFORE the start's own
    // machine work (which bumps it through endWelcome), and there is only ever ONE start per turn now
    // (Session.chooseMachine starts the menu once; the page no longer races it with a second one).
    if (gen !== null && gen !== this.welcomeGen) return null;
    // the person's machine (personMachine): the welcome program is for them, and with the chat full screen the
    // machine on screen runs the chat firmware
    const m = this.personMachine, w = WELCOME[cpuFamily(m.config.cpu)];
    if (!w) throw new SessionError(`There is no Welcome menu for the ${m.profile.name}'s ${m.config.cpu}.`);
    const g = WELCOME.greetings.indexOf(greeting);
    if (g < 0) throw new SessionError(`unknown welcome greeting "${greeting}"`);
    // without its ROMs (also when it has them): "Use the ROMs again" brings BASIC back; the choice is the machine's
    if (!m.useStub) {
      if (m !== this.shownMachine) { m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, null]))); this.stubChosen.add(m.id); this.emit('roms'); }
      else this.runWithoutRoms({ menu: false });
    }
    this.loadMedia(this.welcomeFile, bytes, null, { on: m });
    // Reset: the menu as it is now. loadMedia above cleared this machine's record and made the program's (segments,
    // exec), which this machine's record must keep: only its `welcome` field is set.
    const rec = this.stubRuns.get(m);
    if (rec) rec.welcome = { bytes, greeting, carryOn };
    this.menuWatch = null;
    m.poke(w.greet, g);
    // Option 3 says "USE YOUR ROMS FOR BASIC" when this machine HAS its required ROMs in the sockets and runs the stub
    // by choice, because then there is nothing to add: the page's "Run without ROMs" made that state, and the person
    // needs the way back, not the same request again.
    m.poke(w.romsw, this.romsReadyButOff(m) ? 1 : 0);
    let carry = carryOn ? `CARRY ON WITH ${carryOn}`.toUpperCase().replace(/[^ -_]/g, '?') : '';
    if (carry.length > w.carryMax) {   // cut at a word if there is one past "CARRY ON WITH", else at the edge
      const cut = carry.lastIndexOf(' ', w.carryMax);
      carry = carry.slice(0, cut > 'CARRY ON WITH'.length ? cut : w.carryMax);
    }
    for (let i = 0; i <= carry.length; i++) m.poke(w.carry + i, i < carry.length ? carry.charCodeAt(i) : 0);
    this.welcome = m;
    this.welcomeBuild = w;
    this.welcomeFrom = m.frameCount;   // (welcomeOnScreen: the menu is drawn once a frame has run after this one)
    this.welcomeDrawn = false;

    this.emit('welcome');   // (the page's parts that depend on whether the welcome program runs: the quick-save slots)
    this.welcomeQuiet = WELCOME_QUIET.has(why) ? { m, at: m.frameCount } : null;
    if (this.welcomeSoundOn) this.welcomeSound();
    const last = (carry ? 1 : 0) + (w === WELCOME['6809'] ? 5 : 4);   // the 6809 build has the games too
    return `Welcome: press 1 to ${last}`;
  }
  // Is the welcome program running on the PERSON's machine? personMachine: with the chat full screen this.shownMachine is
  // the chat machine, so this answered false while the person's menu was on screen, and the readers that ask (the
  // Ask box opening full screen, the quick-save slots, install's "a program is running", command-box) all mean the
  // person's. The one reader that means the SHOWN screen - a tap on the menu lines (js/ui/screen.js:206, which taps
  // and types on the shown machine) - asks welcomeRunningOn.
  get welcomeRunning() { return this.welcome === this.personMachine; }
  // on the machine on screen (a tap on the menu): what the canvas shows and types into
  get welcomeRunningOn() { return !!this.welcome && this.welcome === this.shownMachine; }
  // What the page may call "on screen now" (the shelf's tag): the welcome program is not only loaded (welcomeRunning)
  // but executing and drawn on the screen in use. All of: it is loaded on the person's machine; that machine is the
  // one shown; the Debugger has not stopped it (paused); and at least one frame has run since it was loaded, so the
  // picture is the menu's and not what was on screen before (a load runs no frame by itself). A caller with a pause
  // of its own (the page's Pause button) adds it. Cheap: three comparisons, read once per animation frame.
  get welcomeOnScreen() {
    const m = this.welcome;
    if (!m || m !== this.personMachine || m !== this.shownMachine || this.paused || m.frameCount <= this.welcomeFrom) return false;
    // a frame having run is not the menu being there: the program sets the screen up first (the CoCo 3 takes a few
    // dozen frames, and until then the screen shows what was there before): "on screen" once its prompt is drawn;
    // read until then, a latch after
    return this.welcomeDrawn || (this.welcomeDrawn = this.screenText(m).some((row) => row.includes(WELCOME_PROMPT)));
  }
  // one of the bundled games (2048, Minesweeper) is what runs on this machine now: from runGame until it is left
  // (BREAK), or a load, a reset or a switch ends the watch.
  get gameRunning() { const w = this.menuWatch; return !!w && w.kind === 'game' && w.m === this.shownMachine; }
  // ---------------- an untouched bundled program (the Share screen's "one link") ----------------
  // A person's input to a machine, counted: every way their hand or a tool reaches it (a key, an on-screen key, a
  // joystick, a paste, a typed line, a POKE, a load, a disk or a tape going in). A program's OWN running - frames,
  // its timers, LIZA's prompt drawing itself - goes nowhere near it. `touches`, and `touchedAt` when each machine's
  // current program started; untouchedBundledProgram compares the two.
  #touches = new WeakMap();
  touches(m = this.shownMachine) { return (m && this.#touches.get(m)) || 0; }
  // count one touch on m's program (called from the Session's own ways in; the page's keyboard and pads go through
  // personInput, which calls this)
  touch(m = this.shownMachine) { if (m) { this.#touches.set(m, this.touches(m) + 1); this.settleArrival(m); } return this.touches(m); }
  // A bundled program started on m: remember the count it started at. Called by runGame and runLiza BEFORE their
  // own setup pokes and emits ('program'), so those are not touches.
  markProgramStart(id, m) { if (m) this.#touches.set(m, this.touches(m)); this.programStart = { id, m, at: m ? this.touches(m) : 0 }; return this.programStart; }
  // The bundled program on screen now and its own page, whoever played it: { id, name, page }, or null (BASIC, a file,
  // the welcome menu, the colour demo: it has no page). untouchedBundledProgram is this plus "and nobody touched it".
  bundledProgram(base, m = this.shownMachine) {
    const c = this.programControls;
    if (!c || !m || m !== this.personMachine || m !== this.shownMachine) return null;
    const name = (GAMES.list[c.id] || {}).name || (c.id === 'liza' ? 'LIZA' : null);
    const page = name && this.programPageUrl(c.id, base);
    return page ? { id: c.id, name, page } : null;
  }
  // The bundled program on screen now, untouched since it started, as the Share screen's primary link would offer it:
  // bundledProgram, plus the touch count it began at (marks its own start, markProgramStart), or null. "Untouched" is
  // The rule: any key or joystick input, a load, a typed line, or a memory change by a tool makes it a
  // moment, and the primary shares the moment as played.
  untouchedBundledProgram(base, m = this.shownMachine) {
    const p = this.bundledProgram(base, m);
    const start = this.programStart;
    if (!p || !start || start.m !== m || start.id !== p.id || this.touches(m) !== start.at) return null;
    return p;
  }

  // The bundled program machine m's moment is of (a GAMES.list key or 'liza'), or null: what a snapshot of m records
  // as its `program` (shareFile, snapshotFile), so whoever opens it can start that program from the beginning
  // (arrivedFromLink.program, the page's Start over). Touched or not: a played game is still that game.
  // A moment opened from a snapshot (openSnapshot) has no watch of its own: the program its snapshot named is kept for
  // that machine (#openedProgram) and answered until something else runs there (a load or a program started, a Reset,
  // a power cycle), so a moment shared on again, Send it back, a slot or a file taken after arriving keeps it.
  momentProgram(m = this.shownMachine) {
    const w = this.menuWatch;
    if (w && w.m === m) return w.kind === 'game' ? Session.momentProgramId(w.game) : w.kind === 'liza' ? 'liza' : null;
    return (m && this.#openedProgram.get(m)) || null;
  }
  #openedProgram = new WeakMap();   // machine -> the program of the snapshot opened on it, until something else runs
  forgetOpenedProgram(m) { if (m) this.#openedProgram.delete(m); }
  // the bundled program running now and what it is played with -> { id, input, extra, joystick }, or null (BASIC, a
  // file, the welcome menu: the keyboard). id: a GAMES.list key or 'liza' (the touch panel remembers its mode per
  // program and machine under it)
  get programControls() {
    const w = this.menuWatch;
    if (!w || w.m !== this.shownMachine) return null;
    if (w.kind === 'game' && GAMES.list[w.game]) return { id: w.game, ...GAMES.list[w.game].controls };
    if (w.kind === 'liza') return { id: 'liza', ...PROGRAM_CONTROLS.liza };
    return null;
  }
  // the welcome build this machine runs: the 6809 file for every 6809-family model (the 6309 included), the
  // machine's own 6803 build on the MC-10 and the Alice (their subtitles differ). The page fetches it by this name.
  get welcomeFile() {
    const m = this.shownMachine, w = WELCOME[cpuFamily(m.config.cpu)];
    return (w && w.file) || WELCOME6803[m.id];
  }
  // the page unlocked audio: the welcome program plays its tune (once per start)
  welcomeSound() {
    this.welcomeSoundOn = true;
    // the PERSON's machine, the same machine welcomeRunning now means: it poked this.shownMachine, so with the chat open
    // the 1 went into the CHAT firmware's $6004 (inside chat.bin's $6000 load range) and the person's menu never got
    // its sound. The welcome build is the person's machine's build, as startWelcome sets it.
    // (a silent start sets it after its first frame instead, once PLAYED is set: flushWelcome)
    if (this.welcomeRunning && !this.welcomeQuiet) this.welcome.poke(this.welcomeBuild.soundOk, 1);
  }
  // endWelcome(on): the machine leaving the welcome. REQUIRED: a default of the machine on screen is how a disk
  // controller plugged in for the person's machine ended the CHAT machine's welcome instead. Its welcome and its
  // watch go; the chat's machine on
  // screen is not the one they belong to (startChat's load of its firmware must not end the BASIC session's return
  // to the menu), so what belongs to another machine is left alone. menuReason is the reason the Session OFFERED
  // with the 'menu' event: a start spends it (startWelcome), and a machine change ends it (adopt), whichever
  // machine's welcome it was offered with. welcomeGen is the Session's: every start is cancelled, whichever
  // machine's.
  endWelcome(on) {
    if (!on) throw new SessionError('endWelcome needs the machine leaving the welcome.');
    if (this.welcome === on) { this.welcome = null; this.welcomeBuild = null; this.welcomeQuiet = null; }
    if (this.menuWatch && this.menuWatch.m === on) this.menuWatch = null;
    // the offered reason is superseded by any start at all, on any machine: the page will not start the menu from
    // that offer (the start that takes it reads it before its own load, startWelcome), so it must not reach a later
    // plain start - which would then be quiet when it should be a visit's tune
    this.menuReason = null;
    this.welcomeGen++;   // anything that takes the machine cancels a welcome start still waiting on its bytes
  }
  // The generation a page takes before it fetches the welcome bytes and hands it back to startWelcome. Every way
  // something else can take the machine goes through endWelcome (a program loaded, a machine switch, a Reset, a
  // snapshot, the browser check's stubPrompt), so a start whose fetch was overtaken is refused instead of taking
  // the screen back from what the person started meanwhile.
  welcomeGenNow() { return this.welcomeGen; }
  // after the frames just run: emit the key posted in the mailbox, if any, and clear it
  flushWelcome() {
    if (!this.welcomeRunning) return;
    // a silent start: its first frame has run, so the firmware has cleared PLAYED (its START) and has not yet
    // reached the tune (SOUNDOK is held back until now): set PLAYED, then let SOUNDOK through
    const q = this.welcomeQuiet;
    if (q && q.m === this.welcome && this.welcome.frameCount > q.at) {
      this.welcomeQuiet = null;
      this.welcome.poke(this.welcomeBuild.played, 1);
      if (this.welcomeSoundOn) this.welcome.poke(this.welcomeBuild.soundOk, 1);
    }
    // the same pair as welcomeSound: the gate is the person's machine (welcomeRunning) and this is what it reads and
    // clears - this.shownMachine's $6003 is chat firmware code with the chat open
    const m = this.welcome, at = this.welcomeBuild.event, key = m.peek ? m.peek(at) : m.ram[at];
    if (!key) return;
    m.poke(at, 0);
    const name = WELCOME.events[key - 1];
    if (name) this.emit(`welcome:${name}`);
  }

  // ---------------- real time ----------------
  get tapeRunning() { return this.fastTape && this.personMachine.deck.playing; }
  // run the frames due after `ms` of real time; onFrame(machine) after each paced frame (audio).
  // Flat out (turbo, fast tape) runs for at most `budgetMs`. Returns the number of frames run.
  advance(ms, { onFrame = null, budgetMs = 14, now = () => Date.now() } = {}) {
    const m = this.shownMachine;
    // waiting for a DriveWire sector from the store: no time passes for the machine
    if (m.stall) return 0;
    // a debugger has stopped the machine: it stays exactly where it is until resumed or stepped
    if (this.paused) { this.acc = 0; return 0; }
    // with a breakpoint or watchpoint set, frames run through the debugger, which can stop part way; a stop
    // emits 'debug' and leaves the machine where it stopped
    const d = this.debugger && this.debugger.armed ? this.debugger : null;
    if (this.turbo || this.tapeRunning) {
      const t0 = now();
      let n = 0;
      while (now() - t0 < budgetMs && n < 60) { n++; if (!this.oneFrame(m, d)) break; }
      this.acc = 0;
      this.checkRate();
      this.checkPrinter();
      this.checkSpeechRom();
      this.flushWelcome();
      this.checkMenuReturn();
      return n;
    }
    const frameMs = 1000 / m.fps;
    this.acc += Math.min(ms, 200);
    let n = 0;
    while (this.acc >= frameMs && n < 4) {
      if (!this.oneFrame(m, d)) break;   // a debugger stop, or a frame that finishes when the store answers
      if (onFrame) onFrame(m);
      this.acc -= frameMs; n++;
    }
    if (this.acc > frameMs * 4) this.acc = 0;
    if (n) { this.checkRate(); this.checkPrinter(); this.checkSpeechRom(); }
    this.flushWelcome();
    this.checkMenuReturn();
    return n;
  }
  // One frame of machine m (d: the armed debugger, or null) with what every frame brings: the host's keys first, the
  // chat machine's bytes and the machine beside it after -> false when it stopped part way: a debugger stop (emits
  // 'debug'), or the machine waiting for the store (m.stall: the same frame finishes on a later call).
  oneFrame(m, d) {
    this.keys.step(m);
    const ww = this.watchedRun(m);
    if (!(d ? d.runFrame() !== false : m.runFrame(ww))) {
      this.acc = 0;
      if (!m.stall) this.emit('debug');
      if (m === this.personMachine) this.serial.ran();   // a debugger stop: 'instant' subscribers hear what has crossed
      return false;
    }
    this.pumpChat(m);
    this.runBeside(m);
    this.serial.deliver();   // the frame's serial bytes from the person's machine (shown, or beside a full-screen chat)
    return true;
  }
  // Run `count` frames of emulated time, with no clock: for Node scripts, tests and the command line
  // (cli/cloadm.js), where the same calls must give the same frames on every run. Turbo and fast tape, which are
  // about wall-clock time, play no part. Each frame is followed by the checks advance() makes. Returns the frames
  // run: fewer when a debugger breakpoint or watchpoint stopped the machine (s.paused), or the machine waits for
  // the store (s.shownMachine.stall, a DriveWire read: let the event loop run, then call again).
  runFrames(count) {
    const m = this.shownMachine;
    let n = 0;
    while (n < count && !m.stall && !this.paused) {
      if (!this.oneFrame(m, this.debugger && this.debugger.armed ? this.debugger : null)) break;
      n++;
      this.checkRate();
      this.checkPrinter();
      this.checkSpeechRom();
      this.flushWelcome();
      this.checkMenuReturn();
    }
    this.serial.ran();
    return n;
  }
  // after a frame of the chat machine: bytes cross between its firmware and the chat
  pumpChat(m) { if (this.chat && this.chatMachines && this.chatMachines.chat === m) this.chat.pump(m); }
  // the chat's other machine (off screen, in the picture-in-picture) runs a frame for each frame of the one shown
  besideMachine() {
    const c = this.chatMachines;
    return c ? (this.shownMachine === c.chat ? c.basic : c.chat) : null;
  }
  // A machine stopped by a watchWrites 'stop' while beside a full-screen chat (pendingStop) is frozen: it does not
  // run until the person comes back to it, while the chat machine goes on. A frame a 'stop' ends part way stays open.
  runBeside() {
    const o = this.besideMachine();
    if (!o || o.stall || (this.pendingStop && this.pendingStop.machine === o)) return;
    if (o.runFrame(this.watchedRun(o))) this.pumpChat(o);
  }
  // A watchWrites callback returned 'stop' on m, the person's machine, right after the writing instruction (info:
  // { address, value, pc, writer }). A write stop belongs to the machine that wrote: on the machine on screen it is a
  // debugger stop ('write'); on the BASIC session beside a full-screen chat it freezes that machine and is kept
  // (pendingStop) until install puts the machine back on screen, where it becomes that machine's debugger stop. The
  // chat machine keeps running; 'writeStop' tells the page, which says so.
  writeStopped(m, info) {
    if (m === this.shownMachine) { this.debug._stop('write', info); return; }
    this.pendingStop = { machine: m, reason: info };
    this.emit('writeStop', info);
  }
  // the run Machine.runFrame takes for m while a watchWrites observer is registered on it (the person's machine): an
  // instruction at a time, so a callback may stop it; null otherwise (the machine runs its frame as it always does)
  watchedRun(m) {
    const ww = this.writeWatch;
    return ww.active && m === this.hooks.machine ? (end) => ww.runTo(m, end) : null;
  }
  // (the machine's name is not in it: the app bar shows it on the machine button beside the status)
  // held: the page's own Pause. Stopped or paused, the line says so in place of the speed, which would be
  // stale (no frames run); fps null: running again, the speed not measured yet ("Running")
  statusLine(fps, held = false) {
    const m = this.shownMachine;
    let s = this.paused ? 'Stopped in the Debugger' : held ? 'Paused' : fps == null ? 'Running' : `${fps.toFixed(0)} fps · ${(fps / m.fps * 100).toFixed(0)}%`;
    const t = m.deck.tape;
    if (t) s += ` · tape ${t.name} ${(t.progress() * 100).toFixed(0)}%${m.deck.motor ? ' ▶' : ''}`;
    return s;
  }
}
