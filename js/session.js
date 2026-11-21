/*
 * Session: one running emulated computer and everything a front end does with it, without a DOM.
 * The page (js/ui/) and embedders drive a Session; it owns the machine, its ROMs and options
 * (remembered in a key-value store), program/tape/cartridge loading and real-time pacing.
 *
 *   const s = new Session({ store });          // store: { get(key), set(key, value), remove(key) } of strings
 *   s.switchMachine('coco2b', { ram: 64 });
 *   s.addRoms([{ name, bytes }]);               // identified across all models; see addRoms
 *   s.load(name, bytes)                         // binary / cassette / cartridge / BASIC text -> message
 *   s.advance(ms)                               // run the frames that are due; s.machine.render() is the picture
 *   s.runFrames(n)                              // n frames of emulated time, no clock (scripts, tests, cli/cloadm.js)
 *   s.startWelcome(bytes)                       // examples/welcome.bin; then events 'welcome:liza' and so on
 *   await s.snapshotFile() / s.readSnapshot(bytes) / s.openSnapshot(snap)   // snapshots; see 'snapshots' below
 *   await s.importDisk(name, bytes, drive) / s.mountDisk(drive, name) / s.downloadDisk(drive)   // floppy disks
 */
import { cartridgeFor, MultiPak, CART_BOARDS } from './machines/carts.js';
import { devices } from './machines/bus.js';
import { DiskController, FDC_BOARDS } from './machines/fdc.js';
import { DRIVE_TYPES } from './chips/floppy.js';
import { detectDiskFormat, diskGeometry, blankDisk, DiskFormatError } from './media/disk.js';
import { MediaStoreError, detectCaseSync, flipCase, measureOnce } from './host/media-store.js';
import { KeyQueue } from './machines/keyqueue.js';
import { charToKeys } from './machines/keyboards.js';
import { cartridgeRoms, createMachine, profiles, resolveConfig, restoreSnapshot } from './machines/profiles.js';
import { cpuFamily } from './cpu/cpus.js';
import { SpeechSoundPak, SSC_ROM_PROFILE } from './machines/ssc.js';
import { Debugger, codeDisassembly } from './debugger.js';
import { disassembleBlock } from './asm/disassembler.js';
import { formats } from './media/formats.js';
import { Tape } from './media/tape.js';
import { casBlocks, casToWav, recordingToSamples, samplesToCas, writeWav } from './media/cassette.js';
import { FAMILY_NAMES, detectMedia, machineFamily } from './media/detect.js';
import { MediaIndex, LIBRARY_PREFIX, INDEX_PREFIXES, INDEX_LISTS, romImage, RECENT_LENGTH, isLibraryName, migrateLocalStorage } from './media/library.js';
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

// the status of a turn paused by the person's key, in every view that shows it with Resume and Stop (Esc is Stop then)
// (one text for every paused state, UX R11b: whether a call waits, typing is held, or Claude only writes its reply,
// its next action waits; "Esc stops Claude" is never dropped)
export const CLAUDE_PAUSED_TEXT = 'Paused: you pressed a key · Claude\'s next action waits · Esc stops Claude';
// the same where it must fit one line (the browser Fullscreen's pill)
export const CLAUDE_PAUSED_SHORT = 'Paused: you pressed a key · Esc stops Claude';
// a message's text: a string, or the text blocks of a content array
import { RomLibrary, identifyRoms, isBootable, isRomPack, looksLikeRom, makeRomPack, restoreRomPack, socketStatus } from './roms.js';
import { writeZip } from './media/zip.js';
import { SNAPSHOT_EXT, SnapshotError, decodeSnapshot, encodeSnapshot } from './media/snapshot.js';
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
const romOwners = () => Object.assign({}, profiles, cartridgeRoms, { ssc: SSC_ROM_PROFILE });

// The welcome program: its fixed addresses, one entry per CPU family. Its choices (1-7) are posted in the `event`
// mailbox, which the Session reads and clears after every frame (a mailbox rather than PC hooks: the
// CoCo 3 runs hooks only in its ROM area); `soundOk` is set once the page has unlocked audio. The 6809
// build sits at $6000 and covers eleven models (the HD6309 included: it runs the 6809 build in emulation
// mode, like any 6809 program); the 6803 build (the MC-10 and the Matra Alice) sits at
// $5000 and is built once per machine, so its subtitle names the one it runs on.
export const WELCOME = Object.freeze({
  // carryMax: the carry-on line's text, 0-terminated (none when the first byte is 0), this long at most (the 6809
  // build's line has the room for "CARRY ON WITH MINESWEEPER")
  '6809': Object.freeze({ file: 'welcome.bin', start: 0x6000, event: 0x6003, soundOk: 0x6004, greet: 0x6006, carry: 0x6007, carryMax: 26 }),
  '6803': Object.freeze({ file: null, start: 0x5000, event: 0x5003, soundOk: 0x5004, greet: 0x5006, carry: 0x5007, carryMax: 24 }),
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
  list: Object.freeze({ 2048: Object.freeze({ file: '2048.bin', name: '2048' }), minesweeper: Object.freeze({ file: 'minesweeper.bin', name: 'Minesweeper' }) }),
  start: 0x3000, seed: 0x3003, done: 0x3005, samExit: 0x3007, ram: 32,
});
// Color BASIC's and Dragon BASIC's warm-start flag: $55 there at reset means a warm start (the program kept)
const BASIC_RSTFLG = 0x71;
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

// where DriveWire images live in the media store
export const DW_PREFIX = 'drivewire/';

// the baud rates the serial terminal offers (the CoCo's BASIC and OS-9 drivers go up to 9600 on the bit-banger)
export const SERIAL_BAUDS = [300, 600, 1200, 2400, 4800, 9600];
// a snapshot that needs ROMs this browser doesn't have (or has in another version): machine and its name
export class SnapshotRomsError extends SessionError {
  constructor(message, machine) { super(message); this.machine = machine; this.machineName = profiles[machine].name; }
}
// floppy disk images live in the media store under this prefix (never in the media index)
export const DISK_PREFIX = 'disks/';
// how many times mountDisk reads an image again when the image moved under its read (its own stored name, or
// another spelling of the same file on a store that folds case): the image is read four times at most before the
// mount gives up. A write to a DIFFERENT stored file never spends this.
const MOUNT_READ_RETRIES = 3;
// everything CLOADM keeps in a media store (what moving the library copies)
const STORE_PREFIXES = [LIBRARY_PREFIX, DISK_PREFIX, DW_PREFIX, ...INDEX_PREFIXES];
// how long moveMedia waits for the Library operations under way before it gives up on them. A move never copies
// the library out from under an import, a rename, a delete or a save it could not settle (see libraryOp); a store
// that stopped answering would otherwise hang the move for good, so the wait ends with an error and the session
// stays on the old store, with its library as it was.
export const MEDIA_MOVE_WAIT_MS = 30000;
// The key bootNitros9 sets on a mount's options when the mount runs inside its own Library operation (see
// mountDriveWire). Module-private, so only this module can pass it: an embedder calling mountDisk or
// mountDriveWire cannot skip their move checks.
const HELD = Symbol('held');
// the disk cartridges each family can take (js/machines/profiles.js cartridgeRoms), the usual one first
const DISK_DOS = { dragon: ['dragondos', 'deltados'], coco: ['rsdos'] };
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
const STOPPED = Symbol('stopped');
const parseObject = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } };
const SETTINGS = {
  machine: (v) => Object.hasOwn(profiles, v),
  machineChosen: FLAG, visited: FLAG, keyHintDone: FLAG,
  keyboardMode: (v) => v === 'translated' || v === 'positional',
  keyboardJoystick: (v) => v === '1' || v === '0',
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
// instruction from the loaded program (Machine.pcWatch, every instruction; pages 0 and 1, where BASIC keeps routines
// and hooks it runs itself, do not count). It gives up (types nothing) if the tape never starts or BASIC never
// settles.
const EXEC_IDLE = 25, EXEC_START_FRAMES = 600, EXEC_SETTLE_FRAMES = 500;
function execWhenReady(m, file) {
  const from = Math.max(file.load, 0x0200), to = file.load + file.data.length;
  let frames = 0, ran = false, settle = 0, idle = 0, tookOver = false;
  m.pcWatch = (pc) => { if (pc >= from && pc < to) tookOver = true; };
  const done = (verdict) => { m.pcWatch = null; return verdict; };
  return () => {
    frames++;
    if (tookOver) return done('drop');
    if (m.deck.motor) { ran = true; settle = 0; idle = 0; return 'wait'; }
    if (!ran) return frames > EXEC_START_FRAMES ? done('drop') : 'wait';
    idle = m.cpu.pc >= 0x8000 ? idle + 1 : 0;
    if (idle >= EXEC_IDLE) return done('type');
    return ++settle > EXEC_SETTLE_FRAMES ? done('drop') : 'wait';
  };
}

export class Session {
  // store: small settings (localStorage in the page). media: a MediaStore (js/host/media-store.js) for
  // ROMs, recent programs, the library and the quick-save slots; default an in-memory one, so Node tests and
  // embedders need no setup. keyStore: where the Claude API key lives (js/host/key-store.js), never `store`.
  // welcomeMenu: false for a page embedded in someone else's (?embed=1): the host drives a plain machine, so the
  // Session never asks for the welcome menu (power-on, reset, a switch, leaving LIZA); the bare stub stays
  // mediaMoveWaitMs: how long moveMedia waits for the Library operations under way (MEDIA_MOVE_WAIT_MS); a test
  // sets it short to prove the wait is bounded
  constructor({ store = memoryStore(), media = new MemoryMediaStore(), keyStore = null, welcomeMenu = true, mediaMoveWaitMs = MEDIA_MOVE_WAIT_MS } = {}) {
    this.welcomeMenu = welcomeMenu;
    this.mediaMoveWaitMs = mediaMoveWaitMs;
    this.store = store;
    this.media = media;
    // Does the store tell GAME.DSK from game.dsk? A store whose bytes are already in memory answers now (its
    // class declares the fact, or a listing settles it); an asynchronous one is measured by ready(), so this
    // starts at the safe answer (see CASE in js/host/media-store.js) and the guards below never compare names
    // with === without it.
    this._caseInsensitive = media.synchronous ? detectCaseSync(media) : (typeof media.caseInsensitive === 'boolean' ? media.caseInsensitive : true);
    this.mediaSince = Date.now();   // when this visit started using the store: reconnecting copies what it wrote since
    // where the Claude API key lives: host-side only (js/host/key-store.js), never in `store`, the machine or a
    // snapshot. Default is memory-only, so Node tests and an embedder never need browser storage.
    this.keyStore = keyStore || new MemoryKeyStore();
    this.chat = null;               // the Claude chat, once started (js/claude/chat.js): one conversation for both views
    this.claudeView = null;         // where it is shown: 'panel' (Ask Claude, beside the machine) | 'full' (the chat machine)
    this.claudeAllowed = false;     // "Let Claude use the emulator" (off until the person allows it)
    this.claudeGate = null;         // (name, input) => void: the page asks the person (answerClaude gives the answer)
    this.claudeLoadNoAsk = false;   // "Don't ask again this session" on load_basic's card (for the visit only)
    this.claudeActing = null;       // the acting tool call in progress or last made this turn (cleared when it ends): { name, input }
    this.claudePending = null;      // the consent question waiting for an answer: { resolve }
    this.claudeTool = null;         // the tool running now (claudeStatus)
    this.claudeCall = null;         // the acting tool call between its gate and its act (a card or a check may wait): { name }
    // restore point -> { at (ms), disks: the drives linked to the store then (storedDisks), turn: the turn it was
    // taken in (its line's number, ChatSession.line.turn), fromAction: the first action record it covers }
    this.claudePointInfo = new WeakMap();
    this.machineDriven = null;      // asMachine: the ticket of what the program on the machine asked for, while it starts
    this.menuTicket = null;         // the ticket of the menu LIZA's BYE asked for (checkMenuReturn)
    this.claudePauses = 0;          // pauses made so far (a ticket taken before a pause no longer holds)
    this.claudePaused = null;       // a key the person pressed paused Claude: { held (keys not yet typed), wake }
    this.chatMachines = null;       // while a chat is open: { chat, basic } (startChat)
    this.chatServer = null;         // the chat machine's own DriveWire server (startChat with drivewire)
    this.chatView = null;           // which of them is on screen: 'chat' | 'basic'
    this.index = new MediaIndex(media);
    this.machine = null;
    this.turbo = false;
    this.fastTape = true;       // run flat out while the tape is playing
    this.fastCas = false;       // load .cas files straight into memory instead of through BASIC
    this.cartFiles = new WeakMap();   // a cartridge image's device -> the file it came from (takenOut names it)
    this._cartBoard = 'auto';   // the board a loaded cartridge image goes on (js/machines/carts.js CART_BOARDS)
    this.listeners = new Set(); // (event) => void: 'machine' after a switch, 'loaded' after a program, tape or
                                // cartridge is loaded or assembled, 'roms' when stored ROMs or the stub choice change,
                                // 'firmware' after a power cycle, 'reset' after a reset, 'rate' (SAM rate), 'welcome:<choice>' (startWelcome),
                                // 'disks' when a disk cartridge or disk goes in or out, 'diskerror' when the store refused a disk write
    this.acc = 0;
    this.keys = new KeyQueue();     // host key presses for the matrix, applied at frame starts (keyqueue.js)
    this.roms = new RomLibrary(this.index, romOwners);
    this.stubChosen = new Set();    // machines the user chose to run without ROMs this session
    this.bootOk = null;             // the reset after which BASIC's OK was seen
    this.warmReset = null;          // { m, resetAt }: the run that began with the Reset button, not a power-on (bootStatus)
    this.welcome = null;            // the machine running the welcome program
    this.welcomeGen = 0;            // bumped by every start (a later start wins over an earlier one)
    this.menuWatch = null;          // a program that goes back to the welcome menu when left (watchForMenu)
    this.stubRun = null;            // what runs on the stub firmware and how to restart it (Reset; see `reset`)
    this.welcomeBuild = null;       // its build's fixed addresses (WELCOME[profile cpu])
    this.welcomeSoundOn = false;    // audio unlocked: the welcome program may play its tune
    this.tapeInfo = null;           // the tape in the deck: its block starts and length (tapeStatus)
    this.tapeWatch = null;          // the current or last run of the cassette motor: { done, error } (tapeStatus)
    this.lastPrinted = 0;           // printout length at the last 'printer' event
    this.terminalBytes = [];        // what the machine has sent to the serial terminal
    // DriveWire: one server for the session, on its media store (images under DW_PREFIX); attached to the
    // machine's Becker port when it has one. Channels: WebSockets (DriveWireSocket) by channel number.
    this.drivewire = new DriveWireServer({ store: media, namePrefix: DW_PREFIX, sameName: (a, b) => this.sameName(a, b) });
    // a guest's named-object call reaches the store: a create writes it, and a mount hands the guest a drive it
    // then writes through - refused while the library is being copied, so neither can be lost to the move (the
    // reply is the protocol's "no such object")
    this.drivewire.mayWrite = () => !this.movingMedia;
    // ...and a create's write runs as a Library operation, so the move waits for it and it cannot begin mid-copy
    this.drivewire.openLibraryOp = (run) => this.libraryOp(run);
    this.dwSockets = new Map();
    this.WebSocket = globalThis.WebSocket;
    this.serial = globalThis.navigator && globalThis.navigator.serial;   // Web Serial (a mock in tests)
    this.serialLink = null;
    this.drivewire.onPrint = (bytes) => { if (this.machine) { for (const b of bytes) this.machine.printed.push(b); this.checkPrinter(); } };
    this.drivewire.onChannelData = (ch, bytes) => { const s = this.dwSockets.get(ch); if (s) s.send(bytes); };
    this.drivewire.onChannelOpen = (ch) => { const s = this.dwSockets.get(ch); if (s) s.deliver(); };
    this.drivewire.onChannelRead = (ch) => { const s = this.dwSockets.get(ch); if (s) s.deliver(); };
    this.diskWriting = Promise.resolve();   // the chain of disk image writes to the media store
    this.movingMedia = false;       // moveMedia is copying the library to another place
    this.movingOps = new Set();     // Library operations under way that the move waits for (libraryOp)
    this.moveDone = null;           // a promise resolved when the move under way ends (afterMove)
    this.diskMounts = 0;            // mounts made so far: each mount's link carries the next number (diskLink)
    this.diskQueued = 0;            // changes to stored disk images queued so far (queueDiskWrite, diskStoreChange)
    this.diskLanded = 0;            // of those, the ones finished (done or refused)
    this.diskChanges = new Map();   // stored image name (exact spelling) -> how many of those changes were to it
    this.diskError = null;          // a disk write the store refused, reported by diskWritesDone()
    this.diskUnsaved = new Map();   // stored image name -> why its last write was refused (until one succeeds)
    this.creating = Promise.resolve();   // the creation of a library name in flight (createExclusive: newDisk, imports)
    this.creationsAsked = [];       // askedAt of each creation asked and not yet finished, oldest first (createExclusive)
    this.landing = 0;               // names creations have landed so far (each creation notes it when asked: createExclusive)
    this.pendingLands = [];         // { name, at }: names landed that a creation still queued may have to refuse
    this.debugger = null;           // created on first use by `debug` (js/debugger.js)
    this.labels = null;             // symbols of the program in use (the assembler's Map name -> address)
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
    await this.measureCase();
    return this;
  }
  // Keep media in another store from now on, starting with an empty library there (the page does this with an
  // in-memory store when browser storage can't be opened or read). The media index's write-error listener stays.
  useMediaStore(media) {
    const writeError = this.index.writeError;
    this.media = media;
    this._caseInsensitive = media.synchronous ? detectCaseSync(media) : (typeof media.caseInsensitive === 'boolean' ? media.caseInsensitive : true);
    this.mediaSince = Date.now();   // when this visit started using the store: reconnecting copies what it wrote since
    this.index = new MediaIndex(media);
    this.index.writeError = writeError;
    this.roms.index = this.index;
  }
  // Keep the library somewhere else from now on: the Library's "Where your library is kept". Every file CLOADM
  // keeps in the current store (the library and its quick-save slots, disk images, DriveWire images, ROMs, recent
  // programs: STORE_PREFIXES; nothing else in a folder of the user's) is copied there first; a file the new place
  // already has is left as it is, and the old place keeps its copies, so nothing is lost either way. The index's
  // lists (ROM sockets and names, the recent list) change in place, so they are merged (MediaIndex.mergeInto):
  // this library's entries win, and with `reconnecting` (a folder that holds the library, reconnected after this
  // visit kept it in the browser) the folder's win except what changed in this visit. Refused while a stored
  // disk is in a drive, since the drives read and write it where it is kept now (checked at the start, and again
  // after the waits below, right before the copy: checkNoStoredMounts).
  // A copy that fails leaves the session on the old store.
  // The library must not change while it is copied, and it must not be copied out from under what is already
  // writing to it: the move waits for the Library operations under way (libraryOp: imports, renames, deletes,
  // saves) to settle first - whichever way each one ends (a failure is its caller's to report) - and while it
  // copies every new one is refused (checkNotMoving: "try again once it is done"). The wait is bounded
  // (MEDIA_MOVE_WAIT_MS): a store that stops answering ends it with an error, and nothing is moved.
  // -> { copied, kept }: how many files were copied, and how many the new place already had
  async moveMedia(store, { reconnecting = false } = {}) {
    this.checkNoStoredMounts();
    let copied = 0, kept = 0;
    if (store === this.media) return { copied, kept };
    if (this.movingMedia) throw new SessionError('The library is being moved already.');
    // The operations under way are taken now, in the same step as both checks, so nothing starts between them; the
    // marker is set now too, so nothing that starts from here on can slip past either (its own guard refuses it).
    const waiting = [...this.movingOps];
    this.movingMedia = true;
    let done;
    this.moveDone = new Promise((resolve) => { done = resolve; });
    this.moveDone.then(() => {}, () => {});
    try {
      // the disks' last writes, and the Library operations, under the one bound: either can be stuck on a store
      // that stopped answering (a disks/ rename or import runs in the disks' chain too), and neither may hang the
      // move for good. One deadline for both: the whole wait is bounded by mediaMoveWaitMs, not twice it
      const deadline = Date.now() + this.mediaMoveWaitMs;
      await this.boundedWait(this.diskWritesSettled(), 'The drives are still writing to the library', deadline);
      await this.libraryWritesSettled(waiting, deadline);
      // ...and checked again now that they have: an operation the move waited for can have left a drive mounted
      // on the old store (the guest's DriveWire create hands out its drive inside its Library operation). Copying
      // now would leave that drive writing to the store the session is about to leave, so the move is refused
      // instead, with nothing copied and the session where it was.
      this.checkNoStoredMounts();
      return await this.copyMedia(store, reconnecting);
    } finally { this.movingMedia = false; this.moveDone = null; done(); }
  }
  // a move is refused while a drive reads and writes a stored image where the library is kept now: a disk in a
  // floppy drive, or a DriveWire drive (the user's mount, or the guest's named object)
  checkNoStoredMounts() {
    const busy = this.diskMachines().flatMap(({ machine, where }) => this.storedDisks(machine).map((d) => `drive ${d.drive}${where}: ${d.name.split('/').pop()}`))
      .concat(this.driveWireMounts.map((d) => `DriveWire drive ${d.drive}: ${d.name}`));
    if (busy.length) throw new SessionError(`Eject the disks first (${busy.join(', ')}): they are read and written where the library is kept now.`);
  }
  // `work` done, or `deadline` (a Date.now() value) reached: what it waits on never ended (a store that stopped
  // answering). The first wait is given the deadline itself, so the two together stay within the one bound.
  // A deadline already reached (the first wait used it all) is not a failure on its own: work that is settled when
  // the race is set up wins over the 0 ms expiry, so a second wait with nothing outstanding does not fail a move
  // that was in time; a wait still pending then is expired. It returns nothing: the work's value is the caller's.
  async boundedWait(work, what, deadline) {
    let timer = null;
    const left = Math.max(0, deadline - Date.now());
    const tooLong = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SessionError(`${what} and did not finish: the move was stopped and your library is where it was. Try again once it is done.`)), left);
      // (not unref'd: while it waits this timer is what ends the wait, so it must keep the process alive)
    });
    try { await Promise.race([work, tooLong]); } finally { clearTimeout(timer); }
  }
  // the Library operations in `waiting` have settled (finished or failed; their entry is gone from movingOps),
  // or the move's deadline has passed and the move gives up: an operation that never ends (a store that stopped
  // answering) fails the move with a message and leaves the session on its old store
  async libraryWritesSettled(waiting, deadline) {
    if (!waiting.length) return;
    await this.boundedWait(Promise.all(waiting), `The library is still being written to (${waiting.length} operation${waiting.length === 1 ? '' : 's'})`, deadline);
  }
  // A Library operation that writes, renames or deletes in the store, run so that the move waits for it and it
  // does not start while the move is copying. -> run()'s value; run's failure is the caller's (a move that waited
  // for it keeps going: the operation says what went wrong to its own caller, and the move copies what is there).
  // The caller has checked the move is not on (checkNotMoving) and taken whatever else it needs to read from the
  // store BEFORE this call: once it is async, a move may begin before its first await, and then its store is the
  // old one while the session uses the new one. Between the check and this call nothing awaits, so neither can a
  // move begin.
  async libraryOp(run) {
    if (this.movingMedia) throw new SessionError('The library is being moved: try again once it is done.');
    // registered synchronously, and only then started: a move that begins now (it cannot, this step runs to its
    // first await) or already began (checked above) sees this, and its guard is the one that refuses.
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    this.movingOps.add(settled);
    try {
      const p = (async () => run())();
      p.then(() => {}, () => {});   // its failure is the caller's (below), not a rejection nothing listens to
      return await p;
    } finally { this.movingOps.delete(settled); settle(); }
  }
  async copyMedia(store, reconnecting) {
    let copied = 0, kept = 0;
    await this.index.flush();
    const files = [];
    for (const prefix of STORE_PREFIXES) files.push(...await this.media.list(prefix));
    // Reconnecting, the folder is the library and the browser held it only for this visit: what the browser had
    // from before is stale (copying it would bring back what was deleted from the folder), so only the files
    // written in this visit go across, with the ROM images the sockets set in this visit use.
    const images = reconnecting ? new Set([...this.index.changedImages()].map(romImage)) : null;
    const wanted = (f) => !reconnecting || f.mtime >= this.mediaSince || images.has(f.name);
    for (const f of files) {
      if (INDEX_LISTS.includes(f.name) || !wanted(f)) continue;   // the lists are merged below, not kept or replaced whole
      if (await store.stat(f.name)) { kept++; continue; }
      try { await store.write(f.name, await this.media.read(f.name)); } catch (e) { throw this.mediaError(e, f.name); }
      copied++;
    }
    // the index's lists, merged: a move takes this library's entries, reconnecting the folder's except what
    // changed in this visit
    try { copied += await this.index.mergeInto(store, { ours: reconnecting ? 'changed' : 'all' }); } catch (e) { throw this.mediaError(e, 'the ROM and recent lists'); }
    this.useMediaStore(store);
    await this.index.load();
    await this.measureCase();   // the new store's own answer: another file system can tell cases apart where this one did not
    this.drivewire.store = store;
    this.emit('roms');
    this.emit('storage');
    return { copied, kept };
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event, arg) { for (const fn of this.listeners) fn(event, arg); }

  // ---------------- the debugger ----------------
  // One debugger per machine, made on first use and thrown away with the machine. A front end talks to
  // `session.debug`, so the page and an embedder take the same path and none has to know where the debugger
  // lives. Its methods throw SessionError with a message for the user. It shows the symbols of the last assembled
  // program by itself; `setLabels` replaces them.
  get debug() {
    if (!this.debugger) this.debugger = new Debugger(this.machine, { symbols: () => this.labels });
    return this.debugger;
  }
  // a Map name -> address, or a function returning one, for the disassembly; null for plain addresses
  setLabels(symbols) {
    this.labels = symbols;
    if (this.debugger) this.debugger.setSymbols(() => this.labels);
  }
  // a debugger has stopped the machine: the frame loop must not run it on (advance runs nothing then)
  get paused() { return !!(this.debugger && this.debugger.stopped); }
  // continue the machine from where the debugger stopped it
  resume() { if (this.debugger) this.debugger.resume(); }

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
    if (!Object.hasOwn(profiles, id)) id = 'dragon64';
    let m;
    try {
      m = createMachine(id, config || this.savedConfig(id));
      if (config) this.store.set(`config.${id}`, JSON.stringify(config));
    } catch (e) { m = createMachine(id); }
    this.adopt(m);
    if (!this.stubChosen.has(id)) this.loadSavedRoms();
    // the Pak a machine starts with, from its `ssc` option (the ROMs are in place by now)
    this.applySscOption(m);
    m.reset(true);
    this.lastRate = this.cpuRate() && this.cpuRate().rate;
    this.emit('machine');
    if (menu) this.offerMenu(offer);   // switched on without ROMs: the welcome menu
    return m;
  }
  // What a switch to model `id` with `config` (a RAM change: the same id) takes out of the machine in use, for the
  // page to name before and after it (UX ruling R25): [{ kind: 'tape' | 'cartridge' | 'disk', name (the file, or null
  // for a cartridge whose file is not known), drive (a disk's), stored (a disk linked to the Library: false for the
  // disk that came with a snapshot) }]. Not listed: the DriveWire server's disks (the Session's, not the machine's: they
  // stay mounted) and a Speech/Sound Pak that the new machine's `ssc` option puts back (applySscOption).
  takenOut(id, config = this.savedConfig(id)) {
    const m = this.machine, out = [];
    if (!m) return out;
    if (m.deck.tape) out.push({ kind: 'tape', name: m.deck.tape.name });
    const c = m.cartPort;
    const sscBack = c instanceof SpeechSoundPak && profiles[id] && profiles[id].options.ssc && config && config.ssc === 'music' && !!this.roms.get('ssc').tms7040;
    // a disk controller on its own is not named: its disks are, and a mount plugs one in again
    if (c && !(c instanceof DiskController) && !sscBack) out.push({ kind: 'cartridge', name: this.cartFiles.get(c) || null });
    for (const d of this.diskStatus().drives) out.push({ kind: 'disk', name: d.file, drive: d.drive, stored: d.stored });
    return out;
  }
  // make m the machine in use (the caller has its ROMs set or sets them next, and emits 'machine'). The old
  // machine's disks keep what was written to them, a tape recording still running is kept (keepRecording), its chat
  // closes and its debugger goes with it; a debugger m already has (a restored snapshot's breakpoints) becomes the
  // Session's, with the Session's symbols.
  adopt(m) {
    if (this.machine) { this.flushDisks(); this.keepRecording(); }   // its disks and a recording still running are kept
    this.endWelcome();
    this.dropChat();                      // a chat belongs to the machine it was opened on
    this.stubRun = null;
    this.warmReset = null;                // a new machine is a power-on: the boot watchdog arms
    if (this.debugger) { this.debugger.detach(); this.debugger = null; }
    if (m.debugger) { this.debugger = m.debugger; this.debugger.setSymbols(() => this.labels); }
    this.store.set('machine', m.id);
    this.install(m);
  }
  // put m on screen (adopt, and the chat's two machines: showChat), with the keyboard and display; the printout
  // and the serial terminal start over on m. A machine with the Becker port and no server yet gets the Session's
  // DriveWire server and a fresh link; one that has a server (the chat machine's own, or a machine coming back on
  // screen) keeps it and its link. The caller emits 'machine'.
  install(m) {
    // a restart of the machine Claude acts on, by any path (Reset, a power cycle, a program or cartridge that
    // starts, the welcome menu, LIZA, ROMs cleared), stops Claude: nothing it held or still had to type goes into
    // the machine that starts over, and its next action does not run there
    m.onReset = () => this.stopClaudeFor('the machine restarted', m);
    this.keys.clear();
    if (this.debugger && this.debugger.machine !== m) { this.debugger.detach(); this.debugger = null; }
    this.machine = m;
    this.applyDisplay();
    this.acc = 0;
    this.lastRate = this.cpuRate() && this.cpuRate().rate;
    this.lastPrinted = m.printed.length;
    this.terminalBytes = [];
    this.wireTerminal();
    if (m.becker && !m.becker.server) { this.drivewire.resetLink(); m.becker.attach(this.drivewire); }
  }

  // ---------------- printer ----------------
  // What the machine's printer has received: the Dragons' parallel printer, or the serial printer on the
  // bit-banger of the others (600 baud, as MAME fits by default). It belongs to the machine, so a machine switch
  // starts a new printout.
  get printout() { return Uint8Array.from(this.machine.printed); }
  // the printout as text: printable ASCII; CR, LF and CR LF end lines. Control characters and bytes from $80 up
  // (printer-specific codes and graphics; a Dragon's reset sends $FF, see sam.js) are left out; the file has them
  printoutText() {
    let out = '';
    const b = this.machine.printed;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === 13) { out += '\n'; if (b[i + 1] === 10) i++; }
      else if (c === 10) out += '\n';
      else if (c === 9 || (c >= 32 && c < 127)) out += String.fromCharCode(c);
    }
    return out;
  }
  clearPrintout() { this.machine.printed.length = 0; this.checkPrinter(); }
  // the printout as a file: the bytes exactly as received
  printoutFile() {
    if (!this.machine.printed.length) throw new SessionError('Nothing has been printed yet.');
    return { name: `${this.machine.id}-printout.prn`, bytes: this.printout };
  }
  // after frames run: a 'printer' event when the printout changed
  checkPrinter() {
    const n = this.machine.printed.length;
    if (n !== this.lastPrinted) { this.lastPrinted = n; this.emit('printer'); }
  }

  // ---------------- serial port (the CoCo's and the MC-10's bit-banger, the Dragon 64's 6551) ----------------
  // the device on it: { kind: 'none' | 'printer' | 'terminal' | 'loopback', baud, kinds (what can be plugged in),
  // chip: 'bit-banger' | '6551' }, or null on machines without one
  get serialDevice() {
    const m = this.machine, p = m.serialPort;
    return p ? { kind: p.kind, baud: p.baud, kinds: m.serialDevices, chip: m.acia ? '6551' : 'bit-banger' } : null;
  }
  // plug in a device; a terminal shows what the machine sends (terminalText) and sends what is typed (serialSend)
  attachSerial(kind, { baud = 600 } = {}) {
    const m = this.machine;
    if (!m.serialPort) throw new SessionError(`The ${m.profile.name} has no serial port here.`);
    if (!m.serialDevices.includes(kind)) throw new SessionError(`No serial device "${kind}" on the ${m.profile.name} (${m.serialDevices.join(', ')}).`);
    if (!SERIAL_BAUDS.includes(baud)) throw new SessionError(`${baud} baud is not offered (${SERIAL_BAUDS.join(', ')}).`);
    m.attachSerial(kind, { baud });
    this.wireTerminal();
    this.emit('serial');
  }
  wireTerminal() {
    const p = this.machine.serialPort;
    if (p) p.onReceive = (b) => { this.terminalBytes.push(b); this.emit('serial'); };
  }
  // what the machine has sent to the terminal, as text (CR, LF and CR LF end lines)
  terminalText() {
    let out = '';
    const b = this.terminalBytes;
    for (let i = 0; i < b.length; i++) {
      const c = b[i] & 0x7F;
      if (c === 13) { out += '\n'; if ((b[i + 1] & 0x7F) === 10) i++; }
      else if (c === 10) out += '\n';
      else if (c === 8) out = out.slice(0, -1);
      else if (c === 9 || c >= 32) out += String.fromCharCode(c);
    }
    return out;
  }
  clearTerminal() { this.terminalBytes.length = 0; this.emit('serial'); }
  // send text (or bytes) from the terminal to the machine; newlines become CR
  serialSend(data) {
    const p = this.machine.serialPort;
    if (!p || p.kind !== 'terminal') throw new SessionError('Plug in the terminal first (Machine settings, Serial port).');
    const bytes = typeof data === 'string' ? [...data.replace(/\r?\n/g, '\r')].map((c) => c.charCodeAt(0) & 0xFF) : [...data];
    p.send(bytes, this.machine.now());
    return bytes.length;
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
    this.checkNotMoving();
    try { await this.libraryOp(() => this.media.write(DW_PREFIX + clean, bytes)); } catch (e) { throw this.mediaError(e, clean); }
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
    if (!held) this.checkNotMoving();
    this.drivewire.store = this.media;
    // One stored image, one drive (see DriveWireServer.mount). Only DriveWire drives can collide with each other:
    // an image here is always drivewire/... and a floppy is always disks/..., so a stored file is never both and no
    // floppy drive can be holding this one. Names are compared by this.sameName (the store's case rule), which
    // the server was given at construction (DriveWireServer.sameStoredName).
    try { await this.drivewire.mount(drive, DW_PREFIX + name, { writeProtected }); } catch (e) { throw new SessionError(e.message.replace(DW_PREFIX, '')); }
    // The mount awaits a stat of the image, and a move can begin in that gap: its busy check found no mounts yet, so
    // it is not refused there. Checked again with nothing left to await, as mountDisk does: a drive must not come
    // out of the mount onto a store the move has just left.
    if (this.movingMedia && !held) { this.drivewire.eject(drive); throw new SessionError('The library is being moved: try again once it is done.'); }
    this.emit('drivewire');
  }
  ejectDriveWire(drive) { this.drivewire.eject(drive); this.emit('drivewire'); }
  get driveWireMounts() { return this.drivewire.mounts.map((d) => Object.assign(d, { name: d.name.startsWith(DW_PREFIX) ? d.name.slice(DW_PREFIX.length) : d.name })); }
  // an image as a file to keep (it has what the machine wrote)
  async driveWireFile(name) {
    try { return { name, bytes: await this.media.read(DW_PREFIX + name) }; } catch (e) { throw this.mediaError(e, name); }
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
  // which of our loaders is the ROM of machine m: 'drivewire', 'floppy' or null
  nitros9Loader(m = this.machine) { return m && m.roms ? nitros9LoaderKind(m.roms.basic) : null; }
  nitros9On(m = this.machine) { return !!this.nitros9Loader(m); }
  get nitros9Running() { return this.nitros9On(); }
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
    const fd0 = this.machine && this.diskController ? this.diskStatus().drives.find((d) => d.drive === 0 && d.name) : null;
    return (dw0 && ok.find((x) => x.store === 'drivewire' && x.name === dw0.name)) ||
      (fd0 && ok.find((x) => x.store === 'disk' && DISK_PREFIX + x.name === fd0.name)) ||
      ok.find((x) => cpu && x.cpu === cpu) || ok[0] || null;
  }
  // put a NitrOS-9 image (a file the user picked or dropped) in the library and boot it -> message
  async addAndBootNitros9(name, bytes) {
    const r = inspectOs9Disk(bytes);
    if (r.reason) throw new SessionError(`${name}: ${r.reason}`);
    if (r.boot === 'floppy') {
      const full = this.diskStoreName(name);
      // through the disk queue, like every other write to a stored image: a mount reading this name meanwhile
      // re-reads for it, and the drives' writes are ordered against it
      this.checkNotMoving();
      const base = full.slice(DISK_PREFIX.length);
      try { await this.libraryOp(() => this.diskStoreChange(() => this.media.write(full, bytes), full)); } catch (e) { throw this.mediaError(e, base); }
      return this.bootSaved(base, 'disk');
    }
    return this.bootSaved(await this.importDriveWireImage(name, bytes), 'drivewire');
  }
  // the boot of an image addAndBootNitros9 has just stored: a refusal from here on (a move begun since the save,
  // a drive in use) leaves the image in the Library, and says so, as importDisk does for its mount
  async bootSaved(name, store) {
    try { return await this.bootNitros9(name, store); } catch (e) { throw new SessionError(`${name} was saved to your Library but not booted: ${e.message}`); }
  }
  // Boot NitrOS-9 from the stored image `name` in `store` ('drivewire' or 'disk'; null: whichever has it,
  // DriveWire first) -> message. The machine in use must be a CoCo 3; it is remade with the HD6309 for a 6309
  // build (a 6809 build runs on either CPU), and with the Becker port on for a DriveWire image.
  async bootNitros9(name, store = null) {
    // it reads the image from the store and mounts it: not while the library moves (nor does it then)
    this.checkNotMoving();
    const m = this.machine;
    if (!Session.NITROS9_MACHINES.includes(m.id)) throw new SessionError(`NitrOS-9 boots here on the CoCo 3, not the ${m.profile.name}. Switch to the CoCo 3 first.`);
    if (!name) throw new SessionError(`No NitrOS-9 image: add your NitrOS-9 disk image (download nos96809l2v030300coco3.zip, or nos96309l2v030300coco3.zip for the HD6309, from ${NITROS9_IMAGES_URL}, unzip it, and use the file ending in _becker.dsk for DriveWire, or _40d_1.dsk for the floppy drive).`);
    const where = store ? [store] : ['drivewire', 'disk'];
    let bytes = null, found = null;
    for (const st of where) {
      try { bytes = await this.media.read((st === 'disk' ? DISK_PREFIX : DW_PREFIX) + name); found = st; break; } catch (e) { /* not there */ }
    }
    if (!found) throw new SessionError(`There is no image called ${name} in your library.`);
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
    await this.libraryOp(async () => {
      let mm = m;
      if (m.config.cpu !== cpu || (!floppy && !m.config.becker)) mm = this.switchMachine(m.id, Object.assign({}, m.config, { cpu }, floppy ? {} : { becker: true }), { menu: false });
      if (floppy) {
        // the CoCo disk controller: the one in the port, else one without a ROM (our loader drives it)
        const fdc = this.diskController;
        if (mm.cartPort instanceof MultiPak) throw new SessionError('NitrOS-9 boots from a floppy with the disk controller in the cartridge port: take the Multi-Pak out first.');
        if (!fdc) mm.insertCartridge(new devices.cocofdc({}));
        else if (fdc.type !== 'cocofdc') throw new SessionError(`NitrOS-9 boots from the CoCo disk controller, not the ${fdc.name}.`);
        await this.mountDisk(0, DISK_PREFIX + name, { [HELD]: true });
      } else await this.mountDriveWire(0, name, { [HELD]: true });
      this.endWelcome();
      this.stubRun = null;
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
    const m = this.machine;
    if (!this.nitros9Running) return;
    if (m.cartPort instanceof DiskController && !m.cartPort.romBytes) { this.flushDisks(); m.ejectCartridge(); this.emit('disks'); }
    if (this.stubChosen.has(m.id)) m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, null])));
    else this.loadSavedRoms();
    this.powerCycle();
    this.emit('roms');
    this.emit('nitros9');
  }
  // DriveWire to a real CoCo over a serial cable (Web Serial): a second server on the same drives, so the
  // emulated machine's Becker port and the real machine can both use them
  get webSerialAvailable() { return webSerialAvailable(this.serial); }
  async serveRealCoco(baud) {
    if (this.serialLink && this.serialLink.state === 'open') throw new SessionError('A real CoCo is already being served.');
    const server = new DriveWireServer({ store: this.media, namePrefix: DW_PREFIX, clock: this.drivewire.clock, sameName: (a, b) => this.sameName(a, b) });
    server.drives = this.drivewire.drives;
    const link = new SerialDriveWireLink(server, { serial: this.serial, onState: () => this.emit('drivewire') });
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
    this.machine.setComposite(d.view === 'crt' ? d.phase : 0);
    this.applyScreen();
  }
  // Which of the machine's screens render() returns. Only the Dragon 64 Plus has two; a machine with one
  // screen has no `view` to set, so the setting is simply not applied to it. The chat machine (startChat) always
  // shows its VDG screen, whatever is chosen for BASIC: its firmware draws there, and it has no character
  // generator for the 80-column board, which would draw nothing.
  applyScreen() {
    const m = this.machine, d = this.display;
    if (!('view' in m)) return;
    const chat = !!this.chatMachines && m === this.chatMachines.chat;
    m.view = d.screen === 'plus' && !chat ? 'plus' : 'vdg';
  }
  // does this machine offer a second screen to choose between?
  get hasTwoScreens() { return !!this.machine && 'view' in this.machine; }
  // whether the artifact phase means anything on this machine: NTSC machines (the MC6847's 256x192 mode, the
  // CoCo 3's compatibility modes)
  get hasArtifactPhase() { return this.machine.profile.video === 'ntsc'; }
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
    const p = this.machine && this.machine.profile;
    return !!(p && p.multiPak);
  }

  // ---------------- SAM CPU rate and the POKE book (Dragon, CoCo 1/2) ----------------
  // the CPU rate the SAM is set to: { rate (R1..R0), label }, or null on machines without an MC6883
  cpuRate() {
    const m = this.machine;
    if (!m.sam) return null;
    const r = m.sam.rate, slow = (m.tickHz / 1e6).toFixed(2), fast = (2 * m.tickHz / 1e6).toFixed(2);
    return { rate: r, label: r === 0 ? `${slow} MHz` : r === 1 ? `address-dependent (${slow} / ${fast} MHz)` : `${fast} MHz` };
  }
  // the POKE book for this machine: [{ text, about, chip, ready, bit?, set? }] (ready: can be typed now; bit/set:
  // the SAM rate bit it sets or clears), [] without a SAM
  pokeBook() {
    const m = this.machine;
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
    const m = this.machine, poke = m.useStub && !m.atStubPrompt() && /^POKE (\d+),(\d+)$/.exec(p.text);
    if (poke) { this.personInput(m); m.write(+poke[1] & 0xFFFF, +poke[2] & 0xFF); this.checkRate(); return `Done: ${p.text}`; }
    this.typeText(p.text + '\n');
    return `Typed ${p.text}`;
  }
  // called after frames run: a 'rate' event when the SAM rate changed
  checkRate() {
    const r = this.cpuRate();
    if (r && r.rate !== this.lastRate) { this.lastRate = r.rate; this.emit('rate'); }
  }
  // Reset and power without ROMs behave like a real computer, never a dead end:
  // the stub firmware's bare "NO ROM LOADED" screen is not where a button leaves you. Reset restarts what runs
  // on the stub from its own entry point (the welcome menu, LIZA, a binary with an exec address: `stubRun`); with
  // nothing to restart, and on every power-on without ROMs, the Session emits ('menu', 'back') and the page starts
  // the welcome menu, as a visit does. With ROMs,
  // reset and power-on are BASIC's.
  // Reset and power cycle drop any frames owed to real time (no catch-up burst after them); 'reset' event
  reset() {
    this.stopClaudeFor('you reset the machine');
    const m = this.machine, again = this.stubRun && this.stubRun.m === m && m.useStub ? this.stubRun : null;
    this.endWelcome();
    this.keys.clear();
    if (again) this.restart(again);
    else { this.stubRun = null; m.reset(false); this.warmReset = { m, resetAt: m.frameCount }; }
    this.acc = 0;
    this.emit('reset');
    if (!again) this.offerMenu();
  }
  // A power cycle keeps what is inserted, as on real hardware: the cartridge (and so a disk controller's disks)
  // and the tape where it was; only RAM, the chips and the CPU start over. menu: false when the caller starts a
  // program next (startWelcome).
  // reason: the note when this stops Claude (the Power cycle button says the person did it; ROMs added, Run without
  // ROMs and the like restart the machine without being asked to power cycle it)
  powerCycle({ menu = true, reason = 'the machine restarted' } = {}) {
    this.stopClaudeFor(reason);
    const m = this.machine;
    this.endWelcome();
    this.stubRun = null;
    this.keys.clear();
    this.flushDisks();
    // a power cycle keeps what is inserted, as on real hardware, so the Pak's option decides it again from the
    // ROMs that are stored (it is already in the port when nothing has changed)
    this.applySscOption(m);
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    if (menu) this.offerMenu();
  }
  // no ROMs, nothing running: the welcome menu, greeting the visitor back (the page has its bytes)
  // The event's argument is how the menu is offered: 'back' (a returning visit) or 'bye' (back from a program) as
  // before, or 'none' from the machine question's switch, which starts the menu without a carry-on line.
  offerMenu(offer = null) {
    const m = this.machine;
    if (this.welcomeMenu && m.useStub && WELCOME[cpuFamily(m.config.cpu)]) this.emit('menu', offer || 'back');
  }
  // run segments at exec (Machine.injectAndRun), remembering them as the stub's program to restart on Reset
  inject(segments, exec) {
    const m = this.machine;
    this.cancelLoadTyping(m);
    this.stopClaudeFor('you started a program', m);   // (as loadMedia: a program run with ROMs is not a reset)
    m.injectAndRun(segments, exec);
    this.stubRun = m.useStub && exec != null
      ? { m, segments: segments.map((s) => ({ addr: s.addr, data: s.data.slice() })), exec, watch: null, welcome: null } : null;
  }
  // start a stub program again from its entry point: the welcome menu as it was, or the bytes and exec address
  restart(r) {
    if (r.welcome) { this.startWelcome(r.welcome.bytes, r.welcome); return; }
    this.machine.injectAndRun(r.segments, r.exec);
    this.stubRun = r;
    if (r.watch) this.watchForMenu(r.watch);
  }
  // after a hard reset: the firmware may have changed (ROMs or the stub) and the SAM rate is back to slow
  poweredOn() {
    this.warmReset = null;   // a power-on arms the boot watchdog again, even in the frame of a Reset (same resetAt)
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
    this.checkNotMoving();
    const m = this.machine, owners = romOwners();
    const { files: results } = identifyRoms(files, owners, m.id);
    const touched = new Map();   // owner id -> file names
    for (const r of results) for (const t of r.targets) {
      this.roms.put(t.machine, t.socket, t.bytes, r.name);
      if (!touched.has(t.machine)) touched.set(t.machine, []);
      if (!touched.get(t.machine).includes(r.name)) touched.get(t.machine).push(r.name);
    }
    for (const id of touched.keys()) this.stubChosen.delete(id);
    if (touched.has(m.id)) { this.loadSavedRoms(); this.powerCycle(); }
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
  machineRoms(id = this.machine.id) {
    const p = profiles[id], roms = this.roms.get(id);
    const sockets = socketStatus(p, roms).map((s) => Object.assign(s, { file: this.roms.fileName(s.crc) }));
    return { id, name: p.name, bootable: isBootable(p, roms), sockets };
  }
  // every machine with at least one ROM stored
  // The ROMs stored in this browser, for the Library's ROMs card (R19 A+): { count: the images stored (one dump in the
  // sockets of several models counts once), users: the names of the machines and cartridges whose sockets hold them,
  // in profile order }
  storedRoms() {
    const sockets = this.roms.sockets(), owners = romOwners();
    return { count: new Set(sockets.map((x) => x.crc)).size, users: [...new Set(sockets.map((x) => x.owner))].map((id) => owners[id].name) };
  }
  machinesWithRoms() {
    return Object.keys(profiles).map((id) => this.machineRoms(id)).filter((x) => x.sockets.some((s) => s.status !== 'missing-required' && s.status !== 'missing-optional'));
  }
  loadSavedRoms() {
    const m = this.machine, stored = this.roms.get(m.id);
    m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, stored[x.id] || null])));
  }
  romDescription() {
    const r = this.machineRoms();
    if (!r.bootable) return `No BASIC ROM: running without ROMs, machine code only. Needs ${r.sockets.filter((s) => s.status === 'missing-required').map((s) => s.label).join(', ')}.`;
    return r.sockets.map((s) => `${s.label}: ${s.status.replace('-', ' ')}`).join(' · ');
  }
  // forget the ROMs of the machine in use (the index's writes: not while the library moves, as addRoms)
  clearRoms() {
    this.checkNotMoving();
    this.roms.clear(this.machine.id);
    this.loadSavedRoms();
    this.stubRun = null;
    this.machine.reset(true);
    this.emit('roms');
    this.poweredOn();
    this.offerMenu();
  }
  // run the built-in stub firmware on the machine in use (also when ROMs are loaded)
  runWithoutRoms({ menu = true } = {}) {
    const m = this.machine;
    m.setRoms(Object.fromEntries(m.profile.roms.map((x) => [x.id, null])));
    this.stubChosen.add(m.id);
    this.powerCycle({ menu });
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
    this.checkNotMoving();
    const { restored, skipped } = restoreRomPack(zipEntries, this.roms, romOwners());
    const ids = [...new Set(restored.map((r) => r.machine))];
    for (const id of ids) this.stubChosen.delete(id);
    if (ids.includes(this.machine.id)) { this.loadSavedRoms(); this.powerCycle(); }
    this.emit('roms');
    return { machines: ids.filter((id) => profiles[id]).map((id) => this.machineRoms(id)), skipped };
  }

  // ---------------- screen and boot watchdog ----------------
  // the 32x16 text screen as 16 strings (VDG codes to ASCII; semigraphics as spaces)
  screenText(m = this.machine) {
    const base = m.profile.textScreen || 0x400, out = [];
    for (let row = 0; row < 16; row++) {
      let line = '';
      for (let col = 0; col < 32; col++) {
        const v = m.ram[(base + row * 32 + col) & 0xFFFF];
        if (v & 0x80) { line += ' '; continue; }
        const c = v & 0x3F;
        line += String.fromCharCode(c < 32 ? c + 64 : c);
      }
      out.push(line);
    }
    return out;
  }
  // Did BASIC start? 'stub' (no ROMs in use), 'nitros9' (our NitrOS-9 loader instead of BASIC: bootNitros9),
  // 'ok' (BASIC printed OK), 'booting', 'restored' (a snapshot was opened: not a power-on, so not a boot), or
  // 'failed' when no OK appeared within `seconds` of emulated time after a power-on; then `cause` explains it from
  // the sockets. The latch (bootOk) records the power-on whose OK was seen, so a screen that scrolls OK away does
  // not go back to 'booting'. It is keyed by MACHINE as well as by reset, because frameCount and framesSinceReset
  // are per-machine and two machines can share the same arithmetic (a freshly made chat machine and a BASIC machine
  // at power-on are both 0): unkeyed, one machine's 'ok' would satisfy the other's check. bootStatus() and
  // chatTarget().bootStatus() both come here, so the two views of one machine cannot disagree.
  bootStatus(seconds = 5) { return this._bootStatusOf(this.machine, seconds); }
  _bootStatusOf(m, seconds = 5) {
    if (!m.hasRom) return { state: 'stub' };
    if (this.nitros9On(m)) return { state: 'nitros9' };   // our NitrOS-9 loader, not BASIC: no OK to wait for
    const resetAt = m.resetAt;                            // identifies the current power-on or reset
    if (this.bootOk && this.bootOk.m === m && this.bootOk.resetAt === resetAt) return { state: 'ok' };
    if (this.screenText(m).some((l) => l.trim() === 'OK')) { this.bootOk = { m, resetAt }; return { state: 'ok' }; }
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
    const sockets = (m === this.machine ? this.machineRoms() : this.machineRoms(m.id)).sockets;
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
  shareUrl(base) {
    const m = this.machine, config = {};
    // the machine's options, except the ones that describe the comparison or a device in a port rather than
    // the machine: a link opens the model, not the contents of its cartridge slot
    const LOCAL = new Set(['mameCompat', 'hires']);
    for (const [k, v] of Object.entries(m.config)) if (!LOCAL.has(k) && m.profile.options[k]) config[k] = v;
    // NitrOS-9 running: the link boots it from the recipient's own image (never ours, never its name)
    return buildUrl(base, { machine: m.id, config, nitros9: this.nitros9On(m) });
  }

  // ---------------- snapshots ----------------
  // A snapshot holds the machine, its config, its state and the CRCs of the ROMs it ran with (never the ROMs).
  // Opening one: readSnapshot (the file), snapshotSwitch (does the machine in use have to change? ask first),
  // openSnapshot (switches if needed, sets the same ROMs from this browser's or the stub, restores).

  // the moment as a link (Share): this machine's link with the snapshot in the fragment (#s=, base64url of the
  // .cloadm file, so it never reaches a server). Opening it: readSnapshotLink, then the usual snapshot flow.
  // The snapshot is the shared one (shareFile): no byte of a ROM or cartridge image, only references to them.
  // file: a shareFile already made for this moment (the Share screen offers both), or made here
  async snapshotLink(base, file = null) {
    const f = file || await this.shareFile();
    return `${this.shareUrl(base).split('#')[0]}#s=${toBase64Url(f.bytes)}`;
  }
  // The moment as a file to give to someone (the Share screen's link and snapshot file): the snapshot with its ROM
  // code taken out (js/media/romrefs.js). The machine's ROMs, a cartridge's image and a disk controller's DOS ROM
  // are named by CRC, and every copy of their code in memory becomes a reference; whoever opens it needs the same
  // images and rebuilds the moment from their own (snapshotRoms, openSnapshot). AGENTS rule 1: no ROM byte leaves.
  async shareFile(now = new Date()) {
    const m = this.machine;
    // NitrOS-9's memory is the user's own NitrOS-9 image: a moment of it is never put in a link. shareUrl's link
    // (nitros9=1) boots NitrOS-9 from the recipient's own image instead.
    if (this.nitros9On(m)) throw new SessionError('A NitrOS-9 moment isn\'t shared as a snapshot: its memory holds your NitrOS-9. The link boots NitrOS-9 from their own DriveWire image instead.');
    const own = m.profile.roms.filter((r) => m.roms[r.id]).map((r) => ({ crc: crc32(m.roms[r.id]), bytes: m.roms[r.id], kind: 'rom', label: r.label }));
    let snap;
    try { snap = stripRoms(m.snapshot(), own); }
    catch (e) { throw new SessionError(`This snapshot can't be shared: ${e.message}. Share the picture or a clip instead.`); }
    const bytes = await encodeSnapshot(snap, { name: m.profile.name, taken: now.toISOString() });
    return { name: `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${stamp(now)}${SNAPSHOT_EXT}`, bytes, needs: snap.share.images, dropped: snap.share.dropped };
  }
  // Can ROM code be in the machine's memory? 'roms' (the user's own ROMs are loaded), 'cartridge' (a cartridge is
  // plugged in), 'nitros9' (NitrOS-9 from the user's own image runs: bootNitros9) or null (the built-in stub, no
  // cartridge). Memory can hold copies of ROM code: BASIC copies itself
  // into RAM (the Dragon 64 in its all-RAM mode, the CoCo 3 always), a program can copy any ROM, and a cartridge's
  // image is someone's ROM too. The embed API's peek asks first (js/embed-api.js): it hands memory to another
  // page as it is. (Shared snapshots take the ROM code out instead: shareFile.)
  romCodeIn() {
    const m = this.machine;
    if (this.nitros9On(m)) return 'nitros9';   // our loader, and the user's NitrOS-9 in RAM (shareFile)
    if (Object.keys(m.romCrcs()).length) return 'roms';
    if (m.cartPort) return 'cartridge';
    return null;
  }
  // a URL's fragment ('#s=...') -> the snapshot, null when it has none; SessionError when it is damaged
  async readSnapshotLink(hash) {
    const m = /^#?s=(.*)$/.exec(hash || '');
    if (!m) return null;
    const damaged = new SessionError('This link\'s snapshot is damaged: it was cut short or changed on the way.');
    let bytes;
    try { bytes = fromBase64Url(m[1]); } catch (e) { throw damaged; }
    try { return await this.readSnapshot(bytes); } catch (e) { throw e instanceof SessionError && /newer CLOADM/.test(e.message) ? e : damaged; }
  }
  // the moment as a file -> { name, bytes }
  async snapshotFile(now = new Date()) {
    const m = this.machine;
    const bytes = await encodeSnapshot(m.snapshot(), { name: m.profile.name, taken: now.toISOString() });
    return { name: `${m.profile.name.replace(/[^A-Za-z0-9]+/g, '')}-${stamp(now)}${SNAPSHOT_EXT}`, bytes };
  }
  // file bytes -> the snapshot; SessionError when it isn't one this version reads
  async readSnapshot(bytes) {
    try { return await decodeSnapshot(bytes); }
    catch (e) { throw e instanceof SnapshotError ? new SessionError(e.message) : e; }
  }
  // what must change before it opens: null (it fits the machine in use) or { machine, name, config, text }
  snapshotSwitch(snap) {
    const m = this.machine, p = profiles[snap.machine];
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
  openSnapshot(snap) {
    const roms = this.snapshotRoms(snap), p = profiles[snap.machine];
    // a shared one: its ROM code rebuilt from this browser's own images (snapshotRoms checked they are all here)
    snap = restoreRoms(snap, (crc) => this.imageByCrc(crc, roms));
    const switching = !!this.snapshotSwitch(snap);
    let m;
    try { m = restoreSnapshot(snap, Object.fromEntries(p.roms.map((x) => [x.id, roms[x.id] || null]))); }
    catch (e) { throw new SessionError(`This snapshot can't be opened: ${e.message}.`); }
    this.adopt(m);
    if (switching) this.store.set(`config.${m.id}`, JSON.stringify(snap.config));
    if (Object.keys(roms).length) { if (!this.nitros9On(m)) this.stubChosen.delete(m.id); } else this.stubChosen.add(m.id);
    this.emit('machine');
    this.poweredOn();
    this.emit('roms');
    this.emit('loaded');
    // a moment taken on the stub's bare prompt has nothing running to come back to: the welcome menu, as a power-on
    if (m.atStubPrompt()) this.offerMenu();
    this.emit('disks');
    this.emit('nitros9');
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
      return await this.libraryOp(async () => {
        const { bytes } = await this.snapshotFile();
        await this.media.write(slotName(n), bytes);
        return `Took snapshot ${n}`;
      });
    } catch (e) { throw this.mediaError(e, `snapshot ${n}`); }
  }
  // a slot's snapshot (then snapshotSwitch / openSnapshot as for a file)
  async readSlot(n) {
    if (!(await this.media.stat(slotName(n)))) throw new SessionError(`Snapshot ${n} is empty.`);
    return this.readSnapshot(await this.media.read(slotName(n)));
  }
  async clearSlot(n) {
    this.checkNotMoving();
    return this.libraryOp(() => this.media.remove(slotName(n)));
  }
  // what a slot holds, as stored (null when empty), and putting that back: the Undo of a save
  async slotBytes(n) {
    slotName(n);
    try { return (await this.media.stat(slotName(n))) ? await this.media.read(slotName(n)) : null; } catch (e) { throw this.mediaError(e, `slot ${n}`); }
  }
  async restoreSlot(n, bytes) {
    slotName(n);
    this.checkNotMoving();
    try {
      return await this.libraryOp(async () => {
        if (bytes) await this.media.write(slotName(n), bytes);
        else if (await this.media.stat(slotName(n))) await this.media.remove(slotName(n));
      });
    } catch (e) { throw this.mediaError(e, `slot ${n}`); }
  }

  // a file that is a ROM image rather than a program, tape or cartridge (known contents or usual name)
  static isRom(name, bytes) { return looksLikeRom(name, bytes, romOwners()); }

  // ---------------- visits and recent media ----------------
  // { first: true on the first visit in this browser, machineChosen, recent: [{ name, size, stored }] }
  visit() {
    const first = this.store.get('visited') === null;
    this.store.set('visited', '1');
    return { first, machineChosen: this.store.get('machineChosen') !== null, recent: this.recentMedia() };
  }
  // What ran last (the returning visit's "Last time" and the menu's "CARRY ON WITH"), kept across visits:
  // { kind: 'liza' | 'demo' | 'game' | 'recent', name } or null (a game's name is its GAMES.list name). LIZA, the
  // demo and the games aren't in the recent list (they are ours, not the user's files), so they are remembered
  // here; a file is the recent list's first item.
  get lastRun() {
    try { const v = JSON.parse(this.store.get('lastRun') || 'null'); return v && typeof v.kind === 'string' && typeof v.name === 'string' ? v : null; }
    catch (e) { return null; }
  }
  setLastRun(kind, name) { this.store.set('lastRun', JSON.stringify({ kind, name })); }
  // What the welcome menu's carry-on line offers on the machine in use: what ran last, if it runs here. A file only
  // on the machine it was loaded on (and only while its bytes are kept), the colour demo and the games only on a
  // 6809-family CPU, LIZA on every machine (its 6809 or 6803 build). null: no carry-on line.
  get carryOn() {
    const last = this.lastRun, m = this.machine;
    if (!last || !m) return null;
    if (last.kind === 'recent') { const r = this.recentMedia()[0]; return r && r.stored && r.name === last.name && r.machine === m.id ? last : null; }
    if (last.kind === 'demo') return cpuFamily(m.config.cpu) === '6809' ? last : null;
    if (last.kind === 'game') return cpuFamily(m.config.cpu) === '6809' && gameKey(last.name) ? last : null;
    return last;
  }
  // the machine picker is asked once, then remembered
  // The machine picker is asked once, then remembered. offer: how the menu is offered afterwards; the machine
  // QUESTION (js/ui/welcome.js) passes 'none' -- the person chose the machine, not what ran on the old one -- while
  // the header menu and the ROM screen keep the usual carry-on, which is what a returning visitor expects there.
  chooseMachine(id, { offer = null } = {}) { this.store.set('machineChosen', '1'); return this.switchMachine(id, undefined, { offer }); }
  get hasAnyRoms() { return this.roms.sockets().some((s) => profiles[s.owner]); }
  // The last few programs, tapes and cartridges loaded (bytes kept for items up to 1 MB).
  // `copy` labels the rows that need telling apart, for two entries of ONE name — grouped with this.sameName,
  // the store's own rule, so a store that tells cases apart does not group "GAME.BIN" with "game.bin" — that
  // have different bytes: the newest is copy === false, the rest are later copies and get an ordinal (the
  // SECOND '2nd', the THIRD '3rd', or 'older copy' past that). A name with a single entry is never labelled,
  // and `copy` is null for it: there is nothing to tell it from.
  recentMedia() {
    const list = this.index.recentMedia();
    // sameName is a folding rule, not an equivalence-key function (on a case-sensitive store it is ===), so
    // entries are grouped by comparing against the names already seen rather than by a lower-cased key.
    const groups = [];   // [{ name, members: [] }]
    for (const r of list) {
      let g = groups.find((x) => this.sameName(x.name, r.name));
      if (!g) { g = { name: r.name, members: [] }; groups.push(g); }
      g.members.push(r);
    }
    const label = new Map();
    for (const g of groups) {
      if (g.members.length < 2) continue;
      g.members.forEach((r, n) => label.set(r, n === 0 ? false : n === 1 ? '2nd' : n === 2 ? '3rd' : 'older copy'));
    }
    return list.map((r) => Object.assign({}, r, { copy: label.has(r) ? label.get(r) : null }));
  }
  // A full store is not an error here: the program is loaded already, and the entry says its bytes were not kept.
  // While the library moves, the index's two writes wait for it (afterMove): made against the old place now they
  // would be the ones the move leaves behind, and they go to the index's store, which is the new place by then.
  // The list is this visit's at once (the program ran), so the Media tab and "Last time" see it.
  rememberMedia(name, bytes) {
    const crc = crc32(bytes);
    // Identity is the NAME (by this.sameName, the store's own case rule) plus the CONTENT HASH: this load
    // replaces the entry with the same name and the same bytes. Two things follow, and both are deliberate:
    //  - the SAME NAME with DIFFERENT bytes stays as its own entry. Each entry has its own blob (a blob is
    //    named by its CRC) and loadRecent gives each row its own bytes (measured), so the older row is not a
    //    lie about the newer one; the list labels it (see recentMedia).
    //  - a RE-NAMED copy of the same bytes keeps its own entry too: a hash-only key would swallow it.
    // A stored CRC may be in either case (an older build wrote it lower case); the index normalises the
    // entries it reads, and compared here case-insensitively they are the same blob.
    const list = this.index.recentMedia().filter((r) => !(this.sameName(r.name, name) && String(r.crc).toUpperCase() === crc));
    const dropped = list.splice(RECENT_LENGTH - 1);
    list.unshift({ name, crc, size: bytes.length, machine: this.machine.id, stored: bytes.length <= 1 << 20 });
    const entry = list[0];
    // the two writes that go to the store. Made now, against the old place, while the library is moving, they are
    // the ones the move leaves behind: then they are made once it is done, and if the new place is full the entry
    // says so (the bytes are not kept), as the immediate path does.
    const write = (entry) => {
      // A blob is named by its CRC and can back MORE than one row: a renamed copy of the same bytes keeps its own
      // entry with the same CRC. So an evicted entry's file may still be the only copy for a survivor, and dropping
      // it would leave that row stored:true with nothing behind it (measured: the row then fails to load, even
      // after a reload). Only a CRC no surviving entry references is deleted.
      const kept = new Set(list.map((r) => String(r.crc).toUpperCase()));
      for (const old of dropped) if (!kept.has(String(old.crc).toUpperCase())) this.index.dropRecent(old.crc);
      try { if (entry.stored) this.index.putRecent(crc, bytes); }
      catch (e) { if (!(e && e.code === 'quota')) throw e; entry.stored = false; this.index.recentBytes.delete(crc); }
      this.index.setRecent(list);
    };
    if (this.movingMedia) {
      this.index.recentBytes.set(crc, bytes); this.index.recent = list;   // this visit's list at once
      this.afterMove(() => write(entry)).catch(() => {});
    } else try { write(entry); } catch (e) { if (!(e && e.code === 'quota')) throw e; }
  }
  // run() once the move in progress, if any, is done: for an index write that can wait (the in-memory list already
  // changed), so it reaches the store the session uses then, never the old one after the move began. A failed move
  // changes nothing, so the write is still the right one.
  async afterMove(run) {
    while (this.movingMedia) await this.moveDone;
    return run();
  }
  // load a recent item again (on the machine it was loaded on) -> message
  loadRecent(i = 0) {
    const r = this.recentMedia()[i];
    const data = r && r.stored && this.index.recentData(r.crc);
    if (!data) throw new SessionError('That file is no longer stored in this browser; load it again.');
    if (r.machine !== this.machine.id && profiles[r.machine]) this.switchMachine(r.machine);
    return this.load(r.name, data);
  }

  // ---------------- the media library (what the Library screen will call) ----------------
  // User media lives under LIBRARY_PREFIX ('library/'), apart from the index's own names (roms/, recent/,
  // meta/). Every method here touches only that prefix: the ROM and recent blobs belong to the index and
  // changing them behind its back would leave it stale (or corrupt it), so a name outside the prefix is
  // refused rather than accepted.
  // The user's media is under two prefixes: LIBRARY_PREFIX for everything loaded or added, and DISK_PREFIX for
  // floppy disk images, which drives read and write in place. A name with either prefix is
  // taken as it is; a bare name goes under LIBRARY_PREFIX.
  libName(name) {
    const disk = typeof name === 'string' && name.startsWith(DISK_PREFIX) && name.length > DISK_PREFIX.length;
    const root = disk || (name && name.startsWith(LIBRARY_PREFIX)) ? name : LIBRARY_PREFIX + name;
    // no ".." segment: a name must not be able to climb out of its prefix
    if ((!disk && !isLibraryName(root)) || /(^|\/)\.\.(\/|$)/.test(root)) throw new SessionError(`${name}: not a media library name`);
    return root;
  }
  // Everything the user's media holds (the library and the disk images), with sizes and modification times ->
  // [{ name, size, mtime }] sorted by name (the index's own blobs are not listed: they are not the user's media)
  async listMedia() {
    const all = [...await this.media.list(LIBRARY_PREFIX), ...await this.media.list(DISK_PREFIX)];
    return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  // read a stored blob by name -> Uint8Array (throws SessionError when it is gone)
  async openMedia(name) {
    try { return await this.media.read(this.libName(name)); } catch (e) { throw this.mediaError(e, name); }
  }
  // { name, bytes } to save the user's file with (the Library's download, and the fallback's "keep")
  async downloadMedia(name) { return { name: name.split('/').pop(), bytes: await this.openMedia(name) }; }
  // a rename keeps the item under its prefix: `to` is a bare name or a name under the same prefix
  // A disk image in a drive is the drive's: the drive reads it and writes back to it under that name, so it is not
  // renamed, deleted or replaced while it is there -> refuses with the drive it is in
  // Name comparisons here follow the store: on a store that does not tell upper from lower case (see CASE in
  // js/host/media-store.js) GAME.DSK and game.dsk are one file, so they are one name to every guard below.
  // ci: the rule to compare by (default: the store's rule now); a caller that must compare twice by one rule passes it
  sameName(a, b, ci = this.caseInsensitive) { return ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; }
  // A new disk (newDisk) and an import (importDisk, importMedia) make a name that did not exist, and each checks
  // the library before it writes. The check and the write are apart by awaits -- the listing of what is stored,
  // the wait for the drives' writes -- so two creations can both pass the check, and the later write replaces the
  // earlier one's bytes under the same name: a blank disk held at its read-back was replaced by an import of its
  // name, and the mount that then read it back had nothing to mount. (Choosing the first free name can await a
  // listing of its own, so even a name reserved straight after the check could be taken before it was written.)
  // Creations therefore run one at a time (createExclusive): the second waits for the first to have written -- or
  // failed -- and then checks again, so it is refused with the library's "already exists" as it would have been
  // had it come second, and never takes the name or its bytes. Files, slots and DriveWire images are made by
  // writes that replace (a file is imported again as a newer version of itself), so only these creations are
  // serialised.
  // -> what op returns
  // The creation in flight runs op, then the next one runs. newDisk does not come back through here: it holds the
  // turn already and calls the stored half (importDiskStored) directly, because re-entering would wait on its own
  // turn and never finish.
  //
  // Two creations of one name must not both pass their check: the later write replaces the earlier one's bytes
  // under the same name. Serialising them is not enough -- the second must know it is a SECOND creation and not a
  // deliberate replace -- and the fact that tells them apart is the order of asking:
  //   * a creation asked while a creation of that name was in flight is a second creation of it: if that one lands
  //     the name, this one refuses;
  //   * an import asked after the name is already in the library is a replace (a disk in a drive taking a newer
  //     copy of itself), which is what importDisk has always done, and stays allowed.
  // Names are compared with this.sameName -- the store's own rule (CASE in js/host/media-store.js) -- never with a
  // key computed once: the store's rule can be learned (refreshCase) between asking and landing, and a key made
  // under one rule then compared under another reopens the hole. The names in flight are kept as the raw strings
  // they were asked with; a creation waiting for a name is tested against them with sameName at the moment it is
  // asked, and again when its turn comes (so a name a new disk picks inside its turn is seen too).
  // `askedAt`: how many names creations had LANDED when this one was asked for. A name landed after that is one
  // this creation was waiting behind.
  // There is no deadline on a turn. A creation whose store write never answers holds every later creation, as a
  // hung store write already holds a mount or a library move: giving up on the wait would not stop the write, which
  // could then land, mount and claim the name alongside the creations let in after it. An honest wait keeps the
  // one-at-a-time guarantee; a store that never answers is the store backend's to fix.
  createExclusive(op) {
    const askedAt = this.landing;
    this.creationsAsked.push(askedAt);
    const run = this.creating.then(() => op(askedAt), () => op(askedAt));   // after the one in flight, however it ended
    this.creating = run.then(() => this.creationFinished(), () => this.creationFinished());
    return run;
  }
  // the oldest creation (they run in the order asked) is done: drop the landings no creation still queued can be
  // behind -- one only refuses a landing after its own askedAt, and the oldest queued one has the smallest askedAt
  // (landing only grows) -- so pendingLands holds at most the landings made while some creation was queued
  creationFinished() {
    this.creationsAsked.shift();
    const oldest = this.creationsAsked[0];
    this.pendingLands = oldest === undefined ? [] : this.pendingLands.filter((p) => p.at > oldest);
  }
  // has a creation in flight that this one was waiting behind already landed this name? -> the spelling it was
  // stored with by the latest such landing (for the refusal's message), or null
  landedRace(full, askedAt) {
    for (let i = this.pendingLands.length - 1; i >= 0; i--) {
      const p = this.pendingLands[i];
      if (p.at <= askedAt) break;
      if (this.sameName(p.name, full)) return p.name;
    }
    return null;
  }
  // a creation has stored `full` and finished: count it, so a creation waiting behind it refuses (createExclusive)
  creationLanded(full) {
    this.landing++;
    this.pendingLands.push({ name: full, at: this.landing });
  }
  // Does this library treat GAME.DSK and game.dsk as one name? The store's own settled answer wins: a real
  // backend measures itself inside every list() (js/host/media-store-fsa.js _case), so the store can be settled by
  // a route this Session did not take. Answering from the store whenever it has been measured is what keeps the
  // two from drifting; the Session's own value is only the fallback while the store has no answer yet.
  get caseInsensitive() {
    const store = this.media;
    if (typeof store.caseInsensitive === 'boolean' && store.caseMeasured) return store.caseInsensitive;
    return this._caseInsensitive;
  }
  set caseInsensitive(v) { this._caseInsensitive = v; }
  // Measure the store's rule now. Read-only (nothing is written to the user's folder). An empty store has nothing
  // to put the question with: the measurement leaves it unmeasured (safe answer), and the question is put again when
  // the store first gains a name (refreshCase).
  async measureCase(store = this.media) {
    // one path: measureOnce shares a measurement already in flight, so the Session and a listing that is measuring
    // the same store wait on the same answer rather than starting a second one
    if (store.synchronous) detectCaseSync(store); else await measureOnce(store);
    return this.caseInsensitive;
  }
  // The same, when the store has just gained a name: an empty store's safe answer (case-insensitive) can be
  // measured properly now there is a name to put the question with. Once measured it is not measured again (a
  // store's answer is a property of the file system, not of what is in it).
  async refreshCase() {
    // one question, asked the one way it is asked anywhere (js/host/media-store.js detectCase): an empty store
    // comes out unmeasured, and the next write asks again. Nothing here resolves a name through a path, so a
    // folder whose directory spelling differs from what was asked for cannot decide it.
    const store = this.media;
    await (store.synchronous ? detectCaseSync(store) : measureOnce(store));
    return this.caseInsensitive;
  }
  checkNotInDrive(name, what) {
    const held = this.diskHolder(name);
    if (held) throw new SessionError(`${name.slice(DISK_PREFIX.length)}${held.name !== name ? ` (stored as ${held.name.slice(DISK_PREFIX.length)})` : ''} is in drive ${held.drive}${held.where}; eject it before you ${what} it.`);
  }
  // The machines whose drives can hold a stored disk now: the one in use and, in a full-screen chat, the BASIC
  // session beside the chat machine (it keeps its drives, and the Library's guards must see them while the chat is
  // on screen) -> [{ machine, where }], where: '' for the machine on screen, else how a message names it
  diskMachines() {
    const out = this.machine ? [{ machine: this.machine, where: '' }] : [];
    const c = this.chatMachines;
    if (c) for (const m of [c.basic, c.chat]) if (m && m !== this.machine) out.push({ machine: m, where: m === c.basic ? ' of your BASIC session' : ' of the chat machine' });
    return out;
  }
  // the drive that holds the disk image `name`, on any of those machines -> { drive, where, machine, name } | null;
  // skip: { machine, drive } not to count (the drive a mount is about to replace). On a store that does not tell
  // upper from lower case, `name` and what a drive holds are compared that way (see CASE, js/host/media-store.js).
  diskHolder(name, skip = null) {
    for (const { machine, where } of this.diskMachines()) {
      const fdc = this.diskControllerOf(machine);
      if (!fdc) continue;
      const drive = fdc.drives.findIndex((d, i) => d.loaded && this.sameName(d.media.name, name) && !(skip && skip.machine === machine && skip.drive === i));
      if (drive >= 0) return { drive, where, machine, name: fdc.drives[drive].media.name };
    }
    return null;
  }
  async renameMedia(from, to) {
    const src = this.libName(from), prefix = src.startsWith(DISK_PREFIX) ? DISK_PREFIX : LIBRARY_PREFIX;
    this.checkNotMoving();
    this.checkNotInDrive(src, 'rename');
    const dst = this.libName(to.startsWith(DISK_PREFIX) || to.startsWith(LIBRARY_PREFIX) ? to : prefix + to);
    if (!dst.startsWith(prefix)) throw new SessionError(`${to}: a ${prefix === DISK_PREFIX ? 'disk image' : 'library item'} stays where it is`);
    // A case-only rename on a store that does not tell cases apart cannot be done: it is one file, and the
    // store's write-then-remove would replace it and then delete it. (The name is the name it already has.)
    if (this.caseInsensitive && dst !== src && dst.toLowerCase() === src.toLowerCase()) {
      throw new SessionError(`${to}: this ${this.media.kind === 'fsa' ? 'folder' : 'storage'} does not tell upper from lower case, so ${src.slice(prefix.length)} and ${to} are the same name.`);
    }
    const op = () => this.media.rename(src, dst);
    try {
      return await this.libraryOp(() => (src.startsWith(DISK_PREFIX) ? this.diskStoreChange(op, [src, dst]) : op()));
    } catch (e) { throw this.mediaError(e, from); }
  }
  async deleteMedia(name) {
    const full = this.libName(name);
    this.checkNotMoving();
    this.checkNotInDrive(full, 'delete');
    const op = () => this.media.remove(full);
    try {
      return await this.libraryOp(() => (full.startsWith(DISK_PREFIX) ? this.diskStoreChange(op, full) : op()));
    } catch (e) { throw this.mediaError(e, name); }
  }
  // take a file the user picked into the library under `name`; ROM images go through identification, so
  // they land in the index's own sockets rather than being written as an opaque blob; disk images go under
  // DISK_PREFIX, where the drives find them
  async importMedia(name, bytes) {
    this.checkNotMoving();
    if (Session.isRom(name, bytes)) return { roms: this.addRoms([{ name, bytes }]) };
    const base = name.split(/[\\/]/).pop();
    const target = detectMedia(base, bytes).kind === 'disk' ? DISK_PREFIX + base : this.libName(name);
    this.checkNotInDrive(target, 'replace');   // synchronous, so it needs no creation's turn: a disk in a drive is not replaced
    // non-disk media (programs, ROMs) are made by writes that replace, so they take no creation's turn; a disk
    // image may replace one of its name, but not take a name a new disk (or another import) is making: it runs as
    // one creation, ordered behind that one, and checks again (createExclusive)
    const disk = target.startsWith(DISK_PREFIX);
    // this runs when the creation's turn comes, which may be long after the caller was let in: a library move may
    // have started meanwhile, and writing now would put the image in the folder it is moving away from. It runs as a
    // Library operation, whose own check refuses it then (and which the move waits for once it has started).
    const write = (askedAt) => this.libraryOp(async () => {
      // a creation of this name landed after this one was asked for: a second creation of one name, refused rather
      // than replacing it
      const raced = this.landedRace(target, askedAt);
      if (raced) throw new SessionError(`There is already a disk named ${raced.slice(DISK_PREFIX.length)} in your library: choose another name.`);
      this.checkNotInDrive(target, 'replace');   // again, now no creation of the name is in flight
      const r = await (disk ? this.diskStoreChange(() => this.media.write(target, bytes), target) : this.media.write(target, bytes));
      // stored: landed however the rest ends, and only at the end (as importDiskStored)
      // the store has a name now: on an empty store that is the first chance to put its case rule to the test (a
      // read of the store it was written to, so inside the same Library operation)
      try { await this.refreshCase(); } finally { if (disk) this.creationLanded(target); }
      return { stored: r };
    });
    try { return disk ? await this.createExclusive(write) : await write(0); } catch (e) { throw this.mediaError(e, name); }
  }
  mediaError(e, name) {
    if (e instanceof SessionError) return e;
    if (e && e.code === 'not-found') return new SessionError(`${name} is no longer stored in this browser; load it again.`);
    if (e && e.code === 'quota') return new SessionError(`No space left in this browser's storage for ${name}. Delete something, or save your media as files.`);
    return new SessionError(`${name}: ${e && e.message ? e.message : 'storage error'}`);
  }

  // ---------------- programs and media ----------------
  // ---------------- floppy disks ----------------
  // Disk images live in the media store under DISK_PREFIX and are used through its random access: a mount
  // reads the image with readRange, and what the machine writes goes back with writeRange, only the bytes
  // that changed (the drive commits them when its motor stops, on eject and before the machine goes away).
  // They never go through the media index, which keeps everything it owns in memory. Writes to the store are
  // chained, so they land in order; diskWritesDone() waits for them.
  // The disk cartridge (DragonDOS, Delta DOS or Disk BASIC) needs its ROM: the user's, like every other.

  // the disk cartridges this machine can take: [{ id, name, controller, ready (ROM stored), inserted }]
  // A machine with its own disk interface (the Dragon Alpha) offers only that: { id: 'builtin', builtin: true }.
  diskDosChoices() {
    const m = this.machine;
    if (m && m.fdc instanceof DiskController) return [{ id: 'builtin', name: m.fdc.name, controller: m.fdc.type, ready: true, inserted: true, builtin: true }];
    if (!m || !m.hasCartridgePort) return [];
    const ids = DISK_DOS[machineFamily(m.profile)] || [];
    const fdc = this.diskController;
    return ids.map((id) => ({ id, name: cartridgeRoms[id].name, controller: cartridgeRoms[id].controller, rom: cartridgeRoms[id].roms[0].files[0], ready: !!this.roms.get(id).rom, inserted: !!fdc && fdc.type === cartridgeRoms[id].controller }));
  }
  // the disk controller: the machine's own (the Dragon Alpha's), else the one in the cartridge port or in one of
  // its Multi-Pak's slots, or null
  get diskController() { return this.diskControllerOf(this.machine); }
  diskControllerOf(m) {
    if (m.fdc instanceof DiskController) return m.fdc;
    if (m.cartPort instanceof MultiPak) return m.cartPort.slots.find((c) => c instanceof DiskController) || null;
    return m.cartPort instanceof DiskController ? m.cartPort : null;
  }
  // plug a disk cartridge in (whatever was in the port comes out) and power the machine up with it
  // ---------------- blank disks (Session.newDisk) ----------------
  // The sizes offered for a new disk: the usual ones of the disk system in use (or the one a mount would plug in),
  // in the format its images usually come in. [{ format, tracks, heads, size, label }]
  blankDiskChoices() {
    const type = this.blankDiskController();
    if (!type) return [];
    const kb = (t, h) => `${Math.round(t * h * 18 * 256 / 1024)}K`;
    const list = { dragonfdc: [['vdk', 40, 1], ['vdk', 40, 2], ['vdk', 80, 2]], premierfdc: [['vdk', 40, 1], ['vdk', 40, 2], ['vdk', 80, 2]],
      cocofdc: [['jvc', 35, 1], ['jvc', 40, 1], ['jvc', 40, 2]], alphafdc: [['vdk', 80, 2], ['vdk', 40, 2]] }[type] || [];
    return list.map(([format, tracks, heads]) => ({ format, tracks, heads, size: kb(tracks, heads),
      label: `${tracks} tracks, ${heads === 1 ? 'single' : 'double'}-sided (${kb(tracks, heads)})${type === 'cocofdc' && tracks === 35 ? ', as Disk BASIC formats' : ''}` }));
  }
  // the controller type a new disk is for: the one in use, else the preferred disk system's (null: no drives)
  blankDiskController() {
    const fdc = this.machine && this.diskController;
    if (fdc) return fdc.type;
    const dos = this.diskDosChoices().find((c) => c.id === (this.preferredDiskDos() || {}).id) || this.diskDosChoices()[0];
    return dos ? dos.controller : null;
  }
  // A new, empty disk (js/media/disk.js blankDisk) stored in the library and put in `drive`: `format` 'vdk', 'jvc'
  // or 'dmk'; tracks and sides the drive must take. name: the image's name (default disk-<n>.<format>, the first
  // free); a name already in the library is refused (a new disk never replaces one). -> the mount's message
  async newDisk(drive, { format, tracks, heads }, { name = null, writeProtected = false } = {}) {
    this.checkDrive(drive);
    const type = this.blankDiskController();
    if (!type) throw new SessionError(`The ${this.machine.profile.name} has no disk drives in CLOADM.`);
    if (!['vdk', 'jvc', 'dmk'].includes(format)) throw new SessionError(`A new disk is a VDK, JVC or DMK image, not "${format}".`);
    const kind = DRIVE_TYPES[FDC_BOARDS[type].drive];
    if (!Number.isInteger(tracks) || tracks < 1 || tracks > Math.min(kind.tracks, 82)) throw new SessionError(`Drive ${drive} takes disks of 1 to ${Math.min(kind.tracks, 82)} tracks, not ${tracks}.`);
    if (heads !== 1 && heads !== 2) throw new SessionError(`A disk has 1 or 2 sides, not ${heads}.`);
    let bytes;
    try { bytes = blankDisk(format, tracks, heads); } catch (e) { throw new SessionError(e instanceof DiskFormatError ? e.message : String(e)); }
    // one creation at a time (createExclusive): the name is chosen and checked, written and mounted before another
    // creation looks, so a second one sees this disk and is refused rather than replacing its bytes
    return this.createExclusive(async (askedAt) => {
      // What this creation's errors are reported under. The listing below is the only throw here that is not
      // already a SessionError naming the disk (the name checks here and importDiskStored itself throw
      // SessionErrors, which mediaError hands on unchanged), so it is the one that needs a name. That name is the
      // one asked for, but it cannot always be one: with no name asked the name is CHOSEN FROM THIS LISTING
      // (disk-1.vdk and on), so a failing listing fails before a name exists, and a name that leaves nothing after
      // the prefix ("disks/") would make the message start with ": ". Both report as the creation itself: "A new
      // disk". The derivation happens before the listing so that a name mediaError refuses ("A disk image needs a
      // name.") is still raised first, as it was when the derivation moved inside the turn.
      const label = (name ? this.diskStoreName(name).slice(DISK_PREFIX.length) : '') || 'A new disk';
      let listed;
      try { listed = await this.listDisks(); } catch (e) { throw this.mediaError(e, label); }
      const stored = new Set(listed.map((d) => d.name));
      // on a store that does not tell cases apart, a name already there in another case is that same disk
      const taken = (n) => stored.has(n) || [...stored].some((s) => this.sameName(s, n));
      let full;
      if (name) {
        full = this.diskStoreName(name);
        const base = full.slice(DISK_PREFIX.length);
        if (detectDiskFormat(bytes, base) !== format) throw new SessionError(`${base}: a ${format.toUpperCase()} image needs a name ending .${format === 'jvc' ? 'dsk' : format}.`);
        if (taken(full)) {
          const same = [...stored].find((s) => this.sameName(s, full));
          throw new SessionError(`There is already a disk named ${same.slice(DISK_PREFIX.length)} in your library: choose another name.`);
        }
      } else {
        const ext = format === 'jvc' ? 'dsk' : format;
        for (let n = 1; !full || taken(full); n++) full = `${DISK_PREFIX}disk-${n}.${ext}`;
      }
      const msg = await this.importDiskStored(full, full.slice(DISK_PREFIX.length), bytes, drive, writeProtected, askedAt);
      return `New blank disk: ${msg}`;
    });
  }
  insertDiskDos(id) {
    const m = this.machine, choice = this.diskDosChoices().find((c) => c.id === id);
    if (choice && choice.builtin) throw new SessionError(`The ${m.profile.name}'s disk interface is built in: no cartridge needed.`);
    if (!choice) throw new SessionError(`The ${m.profile.name} can't take ${cartridgeRoms[id] ? `the ${cartridgeRoms[id].name}` : `"${id}"`}.`);
    if (!choice.ready) throw new SessionError(`The ${choice.name} needs its ROM (${cartridgeRoms[id].roms[0].files.join(', ')}). Load the ROM file first.`);
    this.flushDisks();
    this.endWelcome();
    this.keys.clear();
    m.insertCartridge(new devices[choice.controller]({ rom: this.roms.get(id).rom }));
    m.reset(true);
    this.acc = 0;
    this.store.set(`diskDos.${machineFamily(m.profile)}`, id);
    this.poweredOn();
    this.emit('disks');
    return `${choice.name} inserted`;
  }
  // ---------------- the Speech/Sound Pak ----------------
  // The Pak is a cartridge-port board, offered where the machine's profile has the `ssc` option: the CoCo 1/2,
  // CoCo 2B, CoCo 3 and the Dragon 64 (each with its own `--ssc` lockstep against MAME). The PIC (TMS7040) ROM is
  // the user's, like BASIC and DOS; the board's speech half is not implemented yet, so it is described as music
  // only everywhere it is offered.
  get offersSsc() { return !!(this.machine && this.machine.profile.options && this.machine.profile.options.ssc); }
  // is the Pak in the cartridge port? (also when it arrived through a restored snapshot)
  get sscInserted() { return !!this.machine && this.machine.cartPort instanceof SpeechSoundPak; }
  // what is needed to put the Pak in: [{ id, label, size, files, status }] from the stored ROMs
  sscRoms() {
    const stored = this.roms.get('ssc');
    return SSC_ROM_PROFILE.roms.map((s) => ({ id: s.id, label: s.label, size: s.size, files: s.files, required: s.required, status: stored[s.id] ? 'loaded' : 'missing' }));
  }
  // plug the Pak in (whatever was in the port comes out) and power the machine up with it. The `ssc` option is set
  // too, so the choice is remembered with the machine's configuration and the Pak comes back on the next start.
  // Only the PIC's ROM is required: speech is not implemented, so the SP0256's allophone data is optional and the
  // card runs its music side without it (js/machines/ssc.js).
  insertSsc() {
    const m = this.machine;
    if (!m) throw new SessionError('There is no machine to put the Speech/Sound Pak in.');
    if (!this.offersSsc) throw new SessionError(`The ${m.profile.name} can't take the Speech/Sound Pak: CLOADM offers it only on the models its Pak is verified on.`);
    const missing = this.sscRoms().filter((s) => s.required && s.status !== 'loaded');
    if (missing.length) {
      throw new SessionError(`The Speech/Sound Pak needs its PIC ROM: ${missing.map((s) => `${s.label} (${s.files[0]}, ${Math.round(s.size / 1024)}K)`).join(' and ')}. Load the ROM file first.`);
    }
    const stored = this.roms.get('ssc');
    this.flushDisks();
    this.endWelcome();
    this.keys.clear();
    m.insertCartridge(new SpeechSoundPak({ tms7040Rom: stored.tms7040, sp0256Rom: stored.sp0256 || null }));
    this.setOption('ssc', 'music');
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    this.emit('loaded');
    return 'Speech/Sound Pak inserted (music only; speech is not implemented yet)';
  }
  // take it out and leave the machine on its own ROMs
  ejectSsc() {
    const m = this.machine;
    if (!this.sscInserted) return 'The Speech/Sound Pak is not in.';
    m.ejectCartridge();
    this.setOption('ssc', 'none');
    m.reset(true);
    this.acc = 0;
    this.poweredOn();
    this.emit('loaded');
    return 'Speech/Sound Pak taken out';
  }
  // set one of the machine's options (through resolveConfig, so an option the model lacks is refused) and
  // remember it with the model's configuration
  setOption(key, value) {
    const m = this.machine, id = m.id;
    const config = Object.assign({}, (m.config || {}), { [key]: value });
    const resolved = resolveConfig(id, config);
    m.config = resolved;
    this.store.set(`config.${id}`, JSON.stringify(resolved));
    return resolved;
  }
  // The Pak a machine starts with, from its `ssc` option: called after the machine's ROMs are in place and before
  // it is reset, by switchMachine and by a power cycle. A machine whose option says 'music' but whose ROM is no
  // longer stored keeps its port empty (the option stays, so the panel says what is missing).
  applySscOption(m = this.machine) {
    if (!m || !m.profile.options || !m.profile.options.ssc) return;
    const want = m.config && m.config.ssc === 'music';
    const stored = this.roms.get('ssc');
    const have = m.cartPort instanceof SpeechSoundPak;
    if (want && !have && stored.tms7040) {
      m.insertCartridge(new SpeechSoundPak({ tms7040Rom: stored.tms7040, sp0256Rom: stored.sp0256 || null }));
    } else if (!want && have) m.ejectCartridge();
  }
  // the cartridge a mount plugs in when none is: the last one chosen for this family, else the first with its ROM
  preferredDiskDos() {
    const choices = this.diskDosChoices(), saved = this.store.get(`diskDos.${machineFamily(this.machine.profile)}`);
    return choices.find((c) => c.id === saved && c.ready) || choices.find((c) => c.ready) || null;
  }
  diskStoreName(name) {
    if (typeof name !== 'string' || !name) throw new SessionError('A disk image needs a name.');
    return name.startsWith(DISK_PREFIX) ? name : DISK_PREFIX + name.split(/[\\/]/).pop();
  }
  // drives this machine's controller has (the Alpha fits 2; a disk cartridge 4)
  get driveCount() { const fdc = this.machine && this.diskController; return fdc ? fdc.fitted : 4; }
  checkDrive(drive) {
    const n = this.driveCount;
    if (!Number.isInteger(drive) || drive < 0 || drive >= n) throw new SessionError(`There is no drive ${drive} (drives 0 to ${n - 1}).`);
  }
  // disk images in the store: [{ name, size, mtime }] (names with DISK_PREFIX)
  async listDisks() { return this.media.list(DISK_PREFIX); }
  // a disk image from the user: checked, stored (replacing a stored image of that name that no drive holds)
  // and mounted -> message
  // The whole check-and-mount is one creation, so an import of a name a new disk is making waits for that disk and
  // then meets it in its drive instead of replacing its bytes.
  async importDisk(name, bytes, drive = 0, { writeProtected = false } = {}) {
    this.checkDrive(drive);
    this.checkNotMoving();
    const full = this.diskStoreName(name), base = full.slice(DISK_PREFIX.length);
    const format = detectDiskFormat(bytes, base);
    if (!format) throw new SessionError(`${base}: not a disk image CLOADM can read (VDK, JVC/DSK or DMK).`);
    try { diskGeometry(bytes, format); } catch (e) { throw new SessionError(`${base}: ${e.message}`); }
    return this.createExclusive((askedAt) => this.importDiskStored(full, base, bytes, drive, writeProtected, askedAt));
  }
  // the stored part of importDisk, run as one creation. askedAt: the landing count when this creation was asked
  // for (see createExclusive), which tells a second creation of one name from a deliberate replace.
  async importDiskStored(full, base, bytes, drive, writeProtected, askedAt = 0) {
    this.checkNotMoving();
    // a creation of this name landed after this one was asked for: it is a second creation of one name, and must
    // refuse rather than replace. This is also the same-drive case the diskHolder checks below cannot see -- they
    // look for the image in a drive, and a creation's image may have been put in this very drive (the eject below
    // would remove it) or be about to be mounted after this operation read the drive as empty.
    const raced = this.landedRace(full, askedAt);
    if (raced) throw new SessionError(`There is already a disk named ${raced.slice(DISK_PREFIX.length)} in your library: choose another name.`);
    const holder = this.diskHolder(full, { machine: this.machine, drive });
    if (holder) throw new SessionError(`${holder.name} is in drive ${holder.drive}${holder.where}; eject it there first.`);
    if (this.diskStatus().drives.some((d) => this.sameName(d.name, full))) await this.ejectDisk(drive);
    await this.diskWritesDone();
    // checked again with nothing left to wait for: a mount of this name that went in meanwhile keeps its file
    const again = this.diskHolder(full);
    if (again) throw new SessionError(`${again.name} is in drive ${again.drive}${again.where}; eject it there first.`);
    this.checkNotMoving();
    try { await this.diskStoreChange(() => this.media.write(full, bytes), full); } catch (e) { throw this.mediaError(e, base); }
    // The name is stored, so from here on this creation lands it however it ends -- mounted, a mount that fails, or a
    // case probe that throws -- and it lands it only at the end: a creation asked at any point while this one runs
    // (askedAt below this landing) is waiting behind it and refuses, while one asked after it finished is a
    // deliberate replace. Landing straight after the write would let an import asked between the write and the end
    // count as a replace and take the name.
    try {
      await this.refreshCase();   // the store has a name now: it can put its case rule to the test
      // stored by now: a mount that fails says so, rather than that the import did not happen
      try { return await this.mountDisk(drive, full, { writeProtected }); }
      catch (e) { throw new SessionError(`${base} was saved to your Library but not put in drive ${drive}: ${e.message}`); }
    } catch (e) {
      // What is left here (the case probe, above all) is reported as this creation's own error, named the way
      // importMedia names it (`base`, the stored name without its prefix), so both callers of this creation --
      // importDisk and newDisk -- get the same form. A SessionError is handed on unchanged, which keeps the
      // creation's own messages exact: the "in drive N" refusals, and the mount failure just above, which already
      // names the disk. (A backend message that itself embeds the path therefore repeats it, exactly as
      // importMedia's has always done: mediaError adds the name to whatever the store said.)
      throw this.mediaError(e, base);
    } finally { this.creationLanded(full); }
  }
  // a stored disk image into a drive (plugging in the disk cartridge if none is) -> message
  // opts[HELD]: as for mountDriveWire (the caller's Library operation is what the move waits for)
  async mountDisk(drive, name, opts = {}) {
    const { writeProtected = false } = opts, held = opts[HELD] === true;
    this.checkDrive(drive);
    if (!held) this.checkNotMoving();
    const full = this.diskStoreName(name), base = full.slice(DISK_PREFIX.length);
    const holder = this.diskHolder(full, { machine: this.machine, drive });
    if (holder) throw new SessionError(`${holder.name} is already in drive ${holder.drive}${holder.where}.`);
    let fdc = this.diskController;
    if (!fdc && this.machine.cartPort instanceof MultiPak) throw new SessionError('The Multi-Pak has no disk controller: put one in one of its slots first (Multi-Pak…).');
    const dos = fdc ? null : this.preferredDiskDos();
    if (!fdc && !dos) {
      const c = this.diskDosChoices();
      if (!c.length) throw new SessionError(`The ${this.machine.profile.name} has no disk drives in CLOADM.`);
      throw new SessionError(`Disks need a disk ROM: ${c.map((x) => `${x.name} (${cartridgeRoms[x.id].roms[0].files[0]})`).join(' or ')}. Load the ROM file first.`);
    }
    // The image is read once every write is in the store: the drive's own (a disk mounted again in the drive it is
    // in must be the image that drive wrote) and every one queued, a restore's put-back included. The machine runs
    // while the store is read, so the read is taken only if nothing has been queued for THIS image since before the
    // wait (a write, an import, a rename or a delete of it, with the drive flushed again); otherwise it is read
    // again. "This image" follows the store's own case rule (sameName): on a store that holds 'disks/A.vdk' and
    // 'disks/a.vdk' as one file a change under either spelling is a change to it, and on one that keeps them apart
    // only its exact name is. A store whose rule is not measured yet is taken as case-insensitive, so the mount
    // reads again rather than keep bytes that may be stale. Nothing here waits between the count and the check, so
    // a change queued while the store is read cannot slip past it. Every change to this image, under any spelling
    // it shares, spends the four-read budget; another file's changes never do. The rule is taken once per pass, so
    // the count before and after a read are summed over the same names even if the store is measured meanwhile.
    const changesTo = (ci) => { let c = 0; for (const [n, k] of this.diskChanges) if (this.sameName(n, full, ci)) c += k; return c; };
    let bytes, reads = 0;
    for (;;) {
      const flush = () => { const f = this.diskController; if (f && f.drives[drive].loaded) f.drives[drive].flush(); };
      flush();
      // counted before the wait: a change to this image queued from here on (even in the step after the wait)
      // means read again
      const ci = this.caseInsensitive, before = changesTo(ci);
      await this.diskWritesDone();
      try {
        const st = await this.media.stat(full);
        if (!st) throw new MediaStoreError('not-found', full);
        bytes = await this.media.readRange(full, 0, st.size);
      } catch (e) { throw this.mediaError(e, base); }
      flush();
      const moved = changesTo(ci) !== before;
      if (!moved) break;
      if (++reads > MOUNT_READ_RETRIES) throw new SessionError(`${base}: the drives kept writing while it was read; try again.`);
    }
    // from here on nothing waits, so what is checked is what the mount finds: another mount that went in meanwhile
    // (into another drive, or into this one) is seen
    const again = this.diskHolder(full, { machine: this.machine, drive });
    if (again) throw new SessionError(`${base} is already in drive ${again.drive}${again.where}.`);
    if (!held) this.checkNotMoving();
    const format = detectDiskFormat(bytes, base);
    if (!format) throw new SessionError(`${base}: not a disk image CLOADM can read (VDK, JVC/DSK or DMK).`);
    fdc = this.diskController;
    if (!fdc) {
      if (!dos) throw new SessionError(`${base}: the disk cartridge was taken out; mount it again.`);
      this.insertDiskDos(dos.id); fdc = this.diskController;
    }
    if (fdc.drives[drive].loaded) fdc.eject(drive);   // flushed above: nothing more to write
    try {
      this.diskUnsaved.delete(full);        // read afresh from the store: nothing is outstanding
      fdc.mount(drive, { bytes, format, name: full, writeProtected, onWrite: this.diskLink(full) });
    } catch (e) { throw new SessionError(`${base}: ${e.message}`); }
    this.emit('disks');
    return `${base} in drive ${drive}${writeProtected ? ' (write-protected)' : ''}`;
  }
  // no disk goes in while the library is being moved (moveMedia): it would be read from one place and written to the other
  // (nor does the Library change anything: the copy would miss it, and the library moved to would not have it)
  checkNotMoving() { if (this.movingMedia) throw new SessionError('The library is being moved: try again once it is done.'); }
  // A mounted disk's link to its stored image (media.onWrite). Each mount gets a link of its own, and the link is
  // the identity of that continuous mount of that stored image: link.mount = { id, name, writes (how many changes
  // the drive has handed to the store through it), failed (a write through it was refused and no whole image has
  // been written since: the stored image may lack it), readOnly (the store refused a write as not allowed), broken (the
  // stored image could not be put back after a restore: nothing more is written through it) }. A link is not part
  // of a snapshot: a restore point records the links (storedDisks) and the restore relinks only the same mount.
  diskLink(name) {
    const mount = { id: ++this.diskMounts, name, writes: 0, failed: false, readOnly: false, broken: false };
    const link = (offset, data, size) => { mount.writes++; this.queueDiskWrite(name, offset, data, size, mount); };
    link.mount = mount;
    return link;
  }
  // the drives of machine m linked to the media store: [{ drive, name, link, writes (link.mount.writes now), wpt }]
  storedDisks(m) {
    const fdc = this.diskControllerOf(m);
    return fdc ? fdc.drives.flatMap((d, i) => (d.loaded && d.media.onWrite && d.media.onWrite.mount
      ? [{ drive: i, name: d.media.name, link: d.media.onWrite, writes: d.media.onWrite.mount.writes, wpt: !!d.wpt }] : [])) : [];
  }
  // A restore point put back on machine m (Session.restoreClaude and the chat's undoLast both come here) -> the
  // notices for the person: [string], one per drive whose restored disk is not linked to the Library.
  // The point is checked first (a SessionError, nothing changed); the drives' changes go to the store first (the
  // restore replaces the drives, dirty tracks and all); a load that fails part way is rolled back to the machine as
  // it was, with its links. Then each drive the point holds linked to the store (pointDisks) is linked again ONLY if
  // the same mount (the same link) is still in that drive, i.e. the same continuous mount since the point: anything
  // else (ejected, replaced or changed in the Library, mounted again, in another drive) leaves the store alone and the
  // drive unlinked, with a notice. The same mount keeps the write protection the person has set now. A linked disk the machine wrote to since the point has the store image put back to
  // the image the drive holds now (whole, so the undone writes are not left mixed in), unless it is write-protected
  // or its stored file refused writes: then it is not written and comes back unlinked, with a notice. A disk not
  // written to since the point is not written at all.
  restorePoint(m, snap) {
    try { m.checkSnapshot(snap); } catch (e) { throw new SessionError(`Can't restore that point (${e.message}): nothing was changed, and your restore points are kept.`); }
    const fdc = this.diskControllerOf(m);
    if (fdc) fdc.flush();
    const before = m.snapshot(), linked = this.storedDisks(m);
    try { m.loadSnapshotState(snap); } catch (e) {
      m.loadSnapshotState(before);
      const back = this.diskControllerOf(m);
      for (const x of linked) back.drives[x.drive].media.onWrite = x.link;
      throw new SessionError(`Can't restore that point (${e.message}): the machine was put back as it was, and your restore points are kept.`);
    }
    this.cancelLoadTyping(m);          // a load's EXEC still waiting was for the machine as it was
    const notices = this.relinkPoint(m, (this.claudePointInfo.get(snap) || {}).disks || [], linked);
    // A restore point is a loaded moment too, and goes back onto the same machine (no new Machine, no Reset): the
    // boot watchdog must not count 5 s from it either, or a point taken on a game would answer 'failed' with the
    // socket cause after Claude's undo. Machine.loadSnapshotState deliberately does not mark it (a boot-failure
    // moment carries its diagnosis in the snapshot), so the Session does, here, where the point's state is put
    // back. The latch is re-armed by the same frame rule every reset uses: the point's own frame is a new run.
    m.restored = true;
    this.emit('disks');
    return notices;
  }
  relinkPoint(m, pointDisks, linked) {
    const fdc = this.diskControllerOf(m), notices = [];
    const unsaved = (drive, why) => notices.push(`Drive ${drive} ${why}; the restored disk isn't saved to the Library. Download it to keep it.`);
    for (const was of pointDisks) {
      const d = fdc && fdc.drives[was.drive];
      if (!(d && d.loaded && d.media.name === was.name)) continue;
      const now = linked.find((x) => x.drive === was.drive), mount = was.link.mount;
      if (!now || now.link !== was.link || mount.broken) { unsaved(was.drive, 'was changed since this point'); continue; }
      // the same mount: write protection is the person's setting for it, not the machine's, so it stays as it is now
      d.setWriteProtect(now.wpt);
      if (mount.writes === was.writes && !mount.failed) { d.media.onWrite = was.link; continue; }
      if (now.wpt) { unsaved(was.drive, 'is write-protected'); continue; }
      if (mount.readOnly) { unsaved(was.drive, 'is a read-only file'); continue; }
      d.media.onWrite = was.link;
      this.queueDiskWrite(was.name, 0, d.media.bytes.slice(), d.media.bytes.length, mount, { drive: was.drive, machine: m });
    }
    return notices;
  }
  // The drive's changes, in order, to the stored image: in place, or the whole file when its size changed. mount: the
  // link's mount (a refused write marks it failed until a whole image is written; writes through a broken one are dropped: the stored image is no longer the drive's). rollback:
  // { drive, machine } for the whole image a restore puts back; if the store refuses it, the stored image is a mix
  // of two versions, so the mount is broken and the drive unlinked, and the error says the disk isn't saved.
  queueDiskWrite(name, offset, data, size, mount = null, rollback = null) {
    this.noteDiskChange(name);
    // the write's own outcome only: a listener's error is not the write's, and every write is counted as landed
    this.diskWriting = this.diskWriting.then(async () => {
      let cleared = false;
      try {
        if (!(mount && mount.broken)) {
          if (offset === 0 && data.length === size) await this.media.write(name, data);
          else await this.media.writeRange(name, offset, data);
          if (mount && offset === 0 && data.length === size) mount.failed = false;
          cleared = this.diskUnsaved.delete(name);
        }
      } catch (e) { this.diskWriteFailed(e, name, mount, rollback); } finally { this.diskLanded++; }
      if (cleared) this.emitApart('disks');
    }).catch(() => {});
  }
  // a listener that throws is reported on its own (as an uncaught error), apart from the disk write chain
  emitApart(event) { try { this.emit(event); } catch (e) { queueMicrotask(() => { throw e; }); } }
  // what a refused disk write leaves: the mount marked, the error to report, the drive unlinked for a put-back
  diskWriteFailed(e, name, mount, rollback) {
    if (mount) mount.failed = true;
    if (mount && e && e.code === 'unsupported') mount.readOnly = true;
    const base = name.slice(DISK_PREFIX.length);
    if (rollback) {
      mount.broken = true;
      const fdc = this.diskControllerOf(rollback.machine), d = fdc && fdc.drives[rollback.drive];
      if (d && d.loaded && d.media.onWrite && d.media.onWrite.mount === mount) d.media.onWrite = null;
      this.diskUnsaved.delete(name);
      const why = this.mediaError(e, base).message.replace(/[.\s]+$/, '');
      this.addDiskError(new SessionError(`Drive ${rollback.drive}: the Library's ${base} couldn't be put back to the restored disk (${why}); the restored disk isn't saved to the Library. Download it to keep it.`));
    } else {
      const err = this.mediaError(e, base);
      this.addDiskError(err);
      this.diskUnsaved.set(name, err.message);
    }
    this.emitApart('diskerror');
    this.emitApart('disks');
  }
  // A change the Library makes to the stored disk images (op: an import's write, a rename, a delete), run in the
  // same chain as the drives' writes, so a mount waiting for the chain reads after it lands, and one reading
  // meanwhile reads again (diskChanges, for the names the change is to). Its failure goes to the caller only.
  // name: the stored name the change is to (for a rename, both the old and the new one). -> what op returns
  diskStoreChange(op, name = null) {
    this.noteDiskChange(name);
    const p = this.diskWriting.then(op);
    this.diskWriting = p.then(() => {}, () => {}).then(() => { this.diskLanded++; });
    return p;
  }
  // A change to a stored disk image is queued: count it everywhere (diskWritesSettled waits on that), and under
  // the exact names it is to, which a mount sums by the store's case rule to see whether its own image moved under
  // its read. (The map grows by distinct spelling, not by change; a session writes to finitely many names.)
  noteDiskChange(name) {
    this.diskQueued++;
    for (const n of [].concat(name || [])) if (n) this.diskChanges.set(n, (this.diskChanges.get(n) || 0) + 1);
  }
  // the disk changes queued now have landed (written or refused), without reporting a refusal
  async diskWritesSettled() {
    const upTo = this.diskQueued;
    while (this.diskLanded < upTo) await this.diskWriting;
  }
  // a refused disk write, reported once by diskWritesDone: several pending are reported together, none dropped
  addDiskError(err) { this.diskError = this.diskError ? new SessionError(`${this.diskError.message} ${err.message}`) : err; }
  // every drive's changes handed to the store now (they are written in the background)
  // (every machine with drives: in a full-screen chat the BASIC session beside the chat machine too)
  flushDisks() { for (const { machine } of this.diskMachines()) { const fdc = this.diskControllerOf(machine); if (fdc) fdc.flush(); } }
  // wait until the store has every change handed to it; a failed write is reported once, here
  // (the writes queued when it is called: one queued later is not waited for, so it always ends)
  async diskWritesDone() {
    await this.diskWritesSettled();
    const e = this.diskError;
    this.diskError = null;
    if (e) throw e;
  }
  async ejectDisk(drive) {
    this.checkDrive(drive);
    const fdc = this.diskController;
    if (fdc) fdc.eject(drive);
    this.emit('disks');
    await this.diskWritesDone();
  }
  setDiskWriteProtect(drive, on) {
    this.checkDrive(drive);
    const fdc = this.diskController;
    if (!fdc || !fdc.drives[drive].loaded) throw new SessionError(`Drive ${drive} is empty.`);
    fdc.setWriteProtect(drive, on);
    this.emit('disks');
  }
  // { dos: { id, name } | null, drives: [{ drive, name, file, writeProtected, size, stored, unsaved }] } for the
  // drives with a disk; stored: false for a disk that came with a snapshot (not linked to the store); unsaved:
  // why the store refused this image's last write (its changes are only in the drive until a write succeeds)
  // count: the drives there are (or will be once a cartridge goes in)
  diskStatus() {
    const fdc = this.machine && this.diskController;
    if (!fdc) return { dos: null, count: 4, drives: [] };
    const id = this.machine.fdc === fdc ? 'builtin' : Object.keys(cartridgeRoms).find((k) => cartridgeRoms[k].controller === fdc.type);
    return {
      dos: { id, name: id === 'builtin' ? fdc.name : cartridgeRoms[id].name },
      count: fdc.fitted,
      drives: fdc.drives.map((d, i) => (d.loaded ? { drive: i, name: d.media.name, file: d.media.name.split('/').pop(), writeProtected: !!d.wpt, size: d.media.bytes.length, stored: !!d.media.onWrite, unsaved: (d.media.onWrite && this.diskUnsaved.get(d.media.name)) || null } : null)).filter(Boolean),
    };
  }
  // the drive lights: [lit, ...] per drive. A drive's light is on while it is selected, its motor runs and the
  // controller is busy with a command (it is reading, writing or stepping)
  diskActivity() {
    const fdc = this.machine && this.diskController;
    if (!fdc) return [false, false, false, false];
    const busy = !!(fdc.wd.status & 1);
    return fdc.drives.slice(0, fdc.fitted).map((d) => busy && fdc.wd.floppy === d && d.mon === 0);
  }
  // The disk that came with a snapshot (not linked to the Library: diskStatus stored: false) saved to the Library under
  // its name, and the drive linked to it from then on, so what the machine writes goes there (R25: a switch takes it
  // out, and only the Library keeps it) -> message. A name the Library already has is refused: that is another disk.
  async keepSnapshotDisk(drive) {
    this.checkDrive(drive);
    const fdc = this.diskController, d = fdc && fdc.drives[drive];
    if (!d || !d.loaded) throw new SessionError(`Drive ${drive} is empty.`);
    const full = this.diskStoreName(d.media.name), base = full.slice(DISK_PREFIX.length);
    if (d.media.onWrite) throw new SessionError(`${base} is already in your Library.`);
    const media = d.media;
    // A Library operation (libraryOp): a move that starts meanwhile waits for it, so it looks in and writes to the one
    // store, which the move then copies. The look and the write are one queued disk change (diskStoreChange): when it
    // runs, the image is copied and the drive linked in one synchronous step, so a write the machine makes after it
    // goes to the store behind this one, never into the gap between them. It is queued under no name: no mount of this
    // image can be reading it meanwhile (one that waits for the queue finds the drive linked under the name and is
    // refused; one that read before finds no file), so a per-name count would change nothing.
    // (diskStoreChange counts it in diskQueued all the same, so diskWritesSettled waits for it.)
    try {
      await this.libraryOp(() => this.diskStoreChange(async () => {
        if (await this.media.stat(full)) throw new SessionError(`Your Library already has a disk named ${base}; download this one instead.`);
        if (fdc.drives[drive].media !== media || media.onWrite) throw new SessionError(`Drive ${drive} no longer holds that disk.`);
        d.flush();
        const bytes = media.bytes.slice(), oldName = media.name;
        media.name = full; media.onWrite = this.diskLink(full);
        try { await this.media.write(full, bytes); } catch (e) { if (media.onWrite) { media.onWrite = null; media.name = oldName; } throw e; }
      }));
    } catch (e) { throw this.mediaError(e, base); }
    await this.refreshCase();
    this.emit('disks');
    return `Saved ${base} to your Library`;
  }
  // the image in a drive as it is now, written changes included -> { name, bytes }
  async downloadDisk(drive) {
    this.checkDrive(drive);
    const fdc = this.diskController;
    if (!fdc || !fdc.drives[drive].loaded) throw new SessionError(`Drive ${drive} is empty.`);
    fdc.drives[drive].flush();
    await this.diskWritesDone();
    const m = fdc.drives[drive].media;
    return { name: m.name.split('/').pop(), bytes: m.bytes.slice() };
  }

  needsRom(what) { return new SessionError(`${what} needs the ${this.machine.profile.name} BASIC ROM. Load the ROM files first.`); }
  // load a file of any supported kind -> message. askAddresses(name, size) -> { load, exec } | null for raw
  // data; remember: false keeps it off the recent list.
  // run: false types a BASIC listing without the RUN after it (the MCP server's load; the page always runs it)
  load(name, bytes, { askAddresses = null, remember = true, run = true } = {}) {
    const msg = this.loadMedia(name, bytes, askAddresses, { run });
    if (remember) { this.rememberMedia(name, bytes); this.setLastRun('recent', name); }
    this.emit('loaded');
    return msg;
  }
  // A tape loads through BASIC as on a machine just switched on: power cycled (the deck and the cartridge stay,
  // as with any power cycle), then nothing is typed until BASIC is at its prompt. Whatever ran before - a CLEAR
  // that moved the top of memory, 64K mode, a program that crashed - would otherwise decide where BASIC's stack and
  // variables are while the tape loads, which is where a self-starting tape puts its start-up code.
  // m runs without ROMs only because that was chosen (stubChosen), and the ROMs stored for it boot BASIC
  // (never the chat machine: it shares the model's id, but runs the chat firmware, not the model's BASIC)
  storedRomsWaiting(m) {
    if (this.chatMachines && m === this.chatMachines.chat) return false;
    return !m.hasRom && this.stubChosen.has(m.id) && !this.nitros9On(m) && this.machineRoms(m.id).bootable;
  }
  // put m's stored ROMs back in (as the ROM screen's "Switch on" does, on this same machine; the load power cycles it)
  useStoredRoms(m) {
    this.stubChosen.delete(m.id);
    this.loadSavedRoms();
    this.emit('roms');
  }
  // What a load typed into m, or is still waiting to type (the EXEC after CLOADM, and its watch on the loaded
  // program), is dropped when something else starts on m: a later load, a program injected, a restore point.
  // Otherwise that EXEC would be typed into whatever runs next.
  cancelLoadTyping(m) {
    m.typist.dropTyped();
    m.pcWatch = null;
  }
  restartForLoad(m) {
    this.powerCycle({ menu: false, reason: 'you loaded a program' });
    m.ensureBooted();
    for (let i = 0; i < 5 * m.fps && this._bootStatusOf(m).state !== 'ok' && m.runFrame(); i++);
  }
  loadMedia(name, bytes, askAddresses, { run = true } = {}) {
    const m = this.machine;
    // a program the person loads takes over the machine Claude acts on (with ROMs it starts without a reset, so
    // the machine's onReset does not say so): Claude stops just before it does (inject does too), and nothing it
    // held is typed into the program; a load that is refused or cancelled leaves Claude alone
    const takeOver = () => { this.cancelLoadTyping(m); this.stopClaudeFor('you loaded a program', m); };
    this.endWelcome();
    this.stubRun = null;
    const media = detectMedia(name, bytes);
    if (media.kind === 'disk') {
      throw new SessionError(`${name}: ${media.format}${media.family ? ` for a ${FAMILY_NAMES[media.family]}` : ''}. Disk images go in a disk drive, not into memory.`);
    }
    const d = formats.identify(name, bytes);
    switch (d.kind) {
      case 'binary':
        if (d.basic) {
          if (!m.hasRom) throw this.needsRom('A BASIC program');
          takeOver();
          m.loadBasicProgram(d.segments[0].data, d.segments[0].addr);
          return `${name}: ${d.format}, ${d.segments[0].data.length} bytes – RUN`;
        }
        this.inject(d.segments, d.exec);
        return `${name}: ${d.format} ${describeSegments(d.segments, d.exec)}`;

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
          this.cancelLoadTyping(m);
          m.deck.insert(tape);
          return `${name}: ${first.name} is a ${first.typeName} file, which a program reads (OPEN "I",#-1); it is in the deck`;
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
            if (ascii) throw new SessionError(`${name}: your stored ${m.profile.name} ROMs did not start BASIC, and an ASCII BASIC tape needs it.`);
            note = `Your stored ROMs did not start BASIC, so ${name} went straight into memory. `;
          } else {
            m.deck.insert(tape);
            if (first.fileType === 2) {
              m.typist.type('CLOADM\r');
              m.typist.typeWhen(execWhenReady(m, first), 'EXEC\r');
            } else { m.typist.type('CLOAD\r'); m.typist.waitTape(); m.typist.type('RUN\r'); }
            return `${again ? `Using your ROMs again to load ${name} through BASIC. ` : ''}Restarted for a clean load. ${name}: tape inserted [${list}] – loading via BASIC`;
          }
        }
        let msg;
        if (first.fileType === 0) {
          if (!m.hasRom) throw this.needsRom('A BASIC tape');
          takeOver();
          m.loadBasicProgram(first.data);
          msg = `${name}: ${first.name} (BASIC) fast-loaded – RUN`;
        } else {
          const seg = { addr: first.load, data: first.data };
          this.inject([seg], first.exec);
          msg = `${name}: ${first.name} fast-loaded ${describeSegments([seg], first.exec)}`;
        }
        tape.seekByte(first.end);       // the rest stays in the deck for multi-part loaders
        m.deck.insert(tape);
        return note + msg;
      }

      case 'cart': {
        if (!m.hasCartridgePort) throw new SessionError(`${name}: the ${m.profile.name} has no cartridge port`);
        this.flushDisks();
        let dev;
        try { dev = cartridgeFor(bytes, this.cartBoard); } catch (e) { throw new SessionError(`${name}: ${e.message}`); }
        this.cartFiles.set(dev, name);
        return this.startCartridge(dev, `${name}: ${dev.name}`);
      }

      case 'basictext':
        if (!m.hasRom) throw this.needsRom('A BASIC listing');
        takeOver();
        m.ensureBooted();
        m.typist.type('NEW\r' + d.text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).join('\r') + (run ? '\rRUN\r' : '\r'));
        return `${name}: typing BASIC listing…`;

      default: {
        const a = askAddresses && askAddresses(name, bytes.length);
        if (!a) throw new SessionError(`${name}: unknown format (${bytes.length} bytes)`);
        const seg = { addr: a.load, data: bytes };
        this.inject([seg], a.exec);
        return `${name}: raw ${describeSegments([seg], a.exec)}`;
      }
    }
  }
  get cartBoard() { return this._cartBoard; }
  set cartBoard(v) {
    if (!CART_BOARDS[v]) throw new SessionError(`unknown cartridge board "${v}" (have: ${Object.keys(CART_BOARDS).join(', ')})`);
    this._cartBoard = v;
  }
  // the cartridge goes in and runs: autostart through BASIC after a reset, or straight at $C000 without a ROM
  startCartridge(dev, what) {
    const m = this.machine;
    m.insertCartridge(dev);
    if (m.hasRom) { m.reset(false); return `${what} inserted, autostarting`; }
    this.inject([], 0xC000);
    return `${what} inserted, running at $C000`;
  }
  // A Multi-Pak with up to four cartridges: items[i] = { name, bytes, board }, { dos } (a disk controller: an id
  // from diskDosChoices(), with the user's ROM; one per Multi-Pak) or null for an empty slot (slot 1 first);
  // switchSlot is the front-panel switch (1-4), the slot whose ROM shows at reset. MAME fits a disk controller in
  // slot 4 only (the one compared with it); the Multi-Pak routes every slot alike, so any slot takes one here.
  insertMultiPak(items, { switchSlot = 4 } = {}) {
    const m = this.machine;
    this.endWelcome();
    if (!m.hasCartridgePort) throw new SessionError(`A Multi-Pak needs a cartridge port; the ${m.profile.name} has none`);
    if (!this.hasMultiPak) throw new SessionError(`The Multi-Pak is not verified on the ${m.profile.name} yet; it is offered on the machines it was compared with MAME on`);
    if (!Array.isArray(items) || items.length > 4) throw new SessionError('A Multi-Pak has four slots');
    const dos = items.filter((it) => it && it.dos);
    if (dos.length > 1) throw new SessionError('A Multi-Pak takes one disk controller (their registers would clash).');
    const choices = this.diskDosChoices();
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
    this.flushDisks();
    const msg = this.startCartridge(mp, `Multi-Pak (${names.map((n, i) => `${i + 1}: ${n}`).join(', ')})`);
    if (dos.length) this.store.set(`diskDos.${machineFamily(m.profile)}`, dos[0].dos);
    this.emit('loaded');
    this.emit('disks');
    return msg;
  }
  // What is this media, and is it for the machine in use? -> detectMedia's result plus `mismatch`:
  // { family, suggest: machine id to open it on, suggestName } when it is for another family (or needs a
  // cartridge port this machine doesn't have).
  inspect(name, bytes) {
    const media = detectMedia(name, bytes), m = this.machine;
    let family = media.family;
    if (media.kind === 'cart' && !m.hasCartridgePort && !family) family = 'coco';
    if (!family || family === machineFamily(m.profile)) return Object.assign(media, { mismatch: null });
    // open it on a machine of that family that can boot BASIC here, else the family's usual model
    const ready = Object.values(profiles).find((p) => machineFamily(p) === family && isBootable(p, this.roms.get(p.id)));
    const suggest = (ready || profiles[{ dragon: 'dragon64', coco: 'coco', mc10: 'mc10' }[family]]).id;
    return Object.assign(media, { mismatch: { family, familyName: FAMILY_NAMES[family], suggest, suggestName: profiles[suggest].name } });
  }
  // the person types text in (a paste, the type-in panel, a POKE from the book, a tap on the welcome menu, the embed
  // API): it is the person's input, so Claude acting on that machine pauses first (personInput), and the text goes in
  typeText(text, m = this.machine) {
    this.personInput(m);
    return this.queueText(text, m);
  }
  // A key or text the person sends to machine m (a key on the screen or the page, an on-screen key, typed text):
  // when Claude is acting on m, Claude pauses before the person's input is queued (pauseClaude), so what Claude still
  // had to type is held back and the person's input goes in. Every way the person's input reaches the machine comes
  // here, so the ticket (machineTicket) only ever counts Claude's own typing. true when it paused Claude now.
  // (also while an acting call waits at its gate - a card, an INCLUDE read - before it acts: runTool's re-check then
  // holds the call until Resume)
  personInput(m = this.machine) {
    if (!this.chat || !(this.claudeBusyActing || this.claudeCall) || this.claudePaused || m !== this.chatTarget().machine) return false;
    return this.pauseClaude();
  }
  // text into the machine with nothing else: through the keyboard with ROMs, as key codes for the stub (the person's
  // text goes through typeText, which pauses Claude first)
  queueText(text, m = this.machine) {
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
  pressBreak(m = this.machine) { return m.typist.holdPaced('BREAK'); }
  // Claude's typing: paced by what the machine consumes (Typist.typePaced), so a busy BASIC drops nothing.
  // Returns the job (job.promise settles when it ends); the caller checks typableText first.
  typeTextPaced(text, m = this.machine) { return m.typist.typePaced(String(text).replace(/\r\n?/g, '\n')); }
  // the characters of text this machine cannot type: no key for it on this keyboard (with BASIC), or not 7-bit
  // ASCII (the stub's key codes). [] when all of it can be typed.
  untypable(text, m = this.machine) {
    const bad = new Set();
    for (const ch of String(text).replace(/\r\n?/g, '\n')) {
      if (m.useStub) { if (ch.charCodeAt(0) > 0x7E && ch !== '\n') bad.add(ch); continue; }
      const k = charToKeys(ch);
      if (!k || !m.keyPos[k.key] || (k.shift && !m.keyPos.SHIFT)) bad.add(ch);
    }
    return [...bad];
  }

  // ---------------- the Claude chat's machine tools ----------------
  // a side-effect-free byte read for the peek tool: RAM and ROM as the debugger's disassembly sees them
  readByte(addr, m = this.machine) {
    return typeof m.peek === 'function' ? m.peek(addr & 0xFFFF) : m.ram[addr & 0xFFFF];
  }
  // write bytes for the poke tool, through the machine's memory map (machine.poke, not a raw RAM poke)
  // Returns how many bytes landed (Machine.poke says whether each did): ROM, I/O and RAM the machine does not have
  // take nothing, and a caller that reports the write must report this number, not bytes.length.
  // An address the map says would not land (writeKind: ROM, I/O, absent RAM, an undecoded range) is not written at
  // all. Machine.poke itself may write the cell beneath (the CoCo 3's loaders patch vectors under the ROM), but a
  // tool that says "not-ram" must not also have changed memory the CPU cannot see and a later map switch would reveal.
  pokeBytes(addr, bytes, m = this.machine) {
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
  injectAssembled(res, m = this.machine) {
    // pokeBytes leaves a byte the map says would not land (ROM, I/O, absent RAM) unwritten, and counts the rest
    let landed = 0;
    for (const seg of res.segments) landed += this.pokeBytes(seg.addr, seg.data, m);
    if (m === this.machine) {
      this.labels = res.symbols;
      if (this.debugger) this.debugger.setSymbols(() => this.labels);
    }
    return landed;
  }
  // What `run` would start: null for the machine's own RUN, else the address. Throws what runAt throws, so a caller
  // can validate before it takes a restore point. An address may be a number or text ("$3000", "0x3000", "3000").
  checkRunTarget(target, m = this.machine) {
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
  runAt(target, m = this.machine) {
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
    return this.readByte(CHAT_STATE.blen, cm) === 0 && this.readByte(CHAT_STATE.wait, cm) === 0;
  }
  get hasClaudeKey() { return !!this.keyStore.get(); }
  // Ask Claude: the conversation without the chat machine, shown in the side
  // panel beside the machine in use, which is the BASIC session Claude's tools act on. The same ChatSession moves
  // to full screen (startChat) and back (toSidePanel) without losing anything. Reading (the screen, memory, the
  // machine) always works; acting (poke, type_text, press_break, assemble_and_load, run) waits for claudeGate the first time, and once
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
    // and a restore marks the actions it took back, UX rulings R12 and R13)
    chat.onRestorePoint = (snap) => {
      const info = this.claudePointInfo.get(snap);
      if (info) Object.assign(info, { at: Date.now(), turn: chat.line ? chat.line.turn : null, fromAction: chat.actionSeq });
    };
    // a pause belongs to the turn it was made in: when the turn ends (finished, failed, stalled or stopped) it ends
    // too, so the next turn never starts paused; so does what the turn was doing on the machine, so a later turn
    // that only answers in text is not taken for acting (a key the person presses then is just their key)
    // and any abort of the turn (Stop, BREAK on the chat screen) ends a pause first: the action waiting on it
    // (pauseWait, in the gate or the re-check) is refused and the held typing dropped, so a later Resume cannot run
    // what was aborted
    const abort = chat.abort.bind(chat);
    chat.abort = (reason) => { if (this.chat === chat) this.endClaudePause(); abort(reason); };
    chat.onTurnEnd = () => {
      if (this.chat !== chat) return;
      this.endClaudePause();
      this.claudeCall = null;
      if (this.claudeActing) { this.claudeActing = null; this.emit('chat'); }
    };
    // the tool running now, for the turn's status ("Using type_text…"), and the acting call between its gate and its
    // act (claudeCall), which the person's input pauses (personInput) as it pauses Claude's acting
    const run = chat.backend.runTool;
    chat.backend.runTool = async (name, input) => {
      this.claudeTool = name;
      this.emit('chat');
      try { return await run(name, input); } finally {
        // (a call of a conversation that has since ended does not clear the new one's)
        if (this.chat === chat) {
          this.claudeCall = null;
          if (this.claudeTool === name) this.claudeTool = null;
          this.emit('chat');
        }
      }
    };
    // It answers synchronously when nobody has to be asked, so the restore point is the machine at the call itself
    // (no frame runs in between); a question or a pause makes it a promise.
    chat.gate = (name, input, call = {}) => {
      this.claudeCall = { name };
      // paused by the person's key: the next action waits for Resume (Stop refuses it)
      if (this.claudePaused) return pauseWait().then(() => consent(name, input, call));
      return consent(name, input, call);
    };
    // The pre-act re-check, synchronous with the change (ChatSession.runTool): the person may have paused Claude
    // (their input while the card waited or the tool's check ran, an INCLUDE read: personInput) or turned the switch
    // off. Paused: wait for Resume as the gate does, then this runs again; the turn's end or abort ends the pause and
    // the call is stopped, with no restore point. A call that relied on the switch (call.consent 'switch') is
    // refused no-consent once it is off; a card answered for this very call ('card') still holds for it.
    chat.recheck = (name, input, call = {}) => {
      if (this.claudePaused) return pauseWait();
      if (call.consent === 'switch' && !(this.claudeAllowed && (name !== 'load_basic' || this.claudeLoadNoAsk))) throw new ToolError(TOOL_CODES.NO_CONSENT);
      return null;
    };
    // the pause's own wait: resumeClaude wakes it to go on; endClaudePause (Stop, the turn's abort or end) wakes it
    // refused, and the call fails stopped. The switch turned off during the pause (setClaudeAllowed marks the pause
    // revoked) refuses the waiting call no-consent on Resume, whatever consent it relied on (a card answered for it
    // included): the person withdrew it while the call could not act.
    const pauseWait = () => {
      const p = this.claudePaused;
      return new Promise((resolve) => { p.wake.push(resolve); }).then((go) => {
        if (!go) throw new ToolError(TOOL_CODES.STOPPED);
        if (p.revoked) throw new ToolError(TOOL_CODES.NO_CONSENT);
      });
    };
    // the turn's abort (Stop, or Esc/BREAK, which abort the request without stopClaude) also ends a waiting card:
    // left waiting it would hold the turn until someone answered it
    const onAbort = (f) => {
      const sig = chat.controller && chat.controller.signal;
      if (sig) { if (sig.aborted) f(); else sig.addEventListener('abort', f, { once: true }); }
    };
    // the page shows the question (claudeGate tells it); without a page nobody can say yes
    const ask = (name, input, extra) => (!this.claudeGate ? Promise.resolve(false) : new Promise((resolve) => {
      onAbort(() => resolve(STOPPED));
      this.claudePending = { name, input, resolve, ...extra };
      this.claudeGate(name, input);
      this.emit('chat');
    })).then((ok) => { this.claudePending = null; this.emit('chat'); return ok; });
    // the answer as the code the tool fails with: Stop is stopped; no (or nobody to ask) is the card's own code
    const refuse = (ok, declined) => {
      if (ok === STOPPED) throw new ToolError(TOOL_CODES.STOPPED);
      if (ok !== true) throw new ToolError(this.claudeGate ? declined : TOOL_CODES.NO_CONSENT);
    };
    const acting = (name, input) => { this.claudeActing = { name, input: input || {} }; this.emit('chat'); };
    // call.consent records what this call relied on: 'card' (the person answered a card for it) or 'switch'
    const consent = (name, input, call) => {
      if (name === 'load_basic') {
        // load_basic replaces the program in memory, so every call has its own card, whatever the switch says,
        // until the person ticks "Don't ask again this session" (claudeLoadNoAsk, offered only while the switch is on). The program is checked
        // first (the same planBasic the tool runs), so the card describes a load that can happen and a load
        // that cannot is refused with its own code without asking anyone.
        const plan = planBasic(this.chatTarget(), input && input.program);
        // ("Don't ask again" holds only while the switch is on: with it off every load asks)
        if (!(this.claudeLoadNoAsk && this.claudeAllowed)) {
          const nums = plan.lines.map((l) => l.number);
          return ask(name, input, { kind: 'load', load: { lines: nums.length, first: nums[0], last: nums[nums.length - 1], bytes: plan.bytes.length } })
            .then((ok) => { refuse(ok, TOOL_CODES.LOAD_DECLINED); call.consent = 'card'; acting(name, input); });
        }
      } else if (!this.claudeAllowed) {
        return ask(name, input, { kind: 'consent' }).then((ok) => { refuse(ok, TOOL_CODES.CONSENT_DECLINED); this.claudeAllowed = true; call.consent = 'card'; acting(name, input); });
      }
      call.consent = 'switch';
      acting(name, input);
      return null;
    };
  }
  // What the turn in progress is doing, for the status every view shows with Stop: null when no turn is in
  // progress, else { phase, text, tool }. A card waiting for the person comes first, then a pause by the person's
  // key, then a tool running; otherwise the reply is on its way (the model thinking or streaming).
  get claudeStatus() {
    if (!this.chat || !this.chat.busy) return null;
    // (paused while a card waits: the pause is what the person must know; the card says "Allow and resume")
    if (this.claudePaused) return { phase: 'paused', text: CLAUDE_PAUSED_TEXT, tool: this.claudeTool };
    if (this.claudePending) return { phase: 'consent', text: 'Waiting for your OK', tool: this.claudePending.name };
    if (this.claudeTool) return { phase: 'tool', text: `Using ${this.claudeTool}…`, tool: this.claudeTool };
    return { phase: 'thinking', text: 'Thinking…', tool: null };
  }
  // answer the question on screen: the consent card (Allow / Just tell me the fix; the switch below the message box
  // sets it too) or load_basic's card (Load it / Don't load), whose "Don't ask again this session" is dontAsk.
  // resume: the card's accept button read "Allow and resume" / "Load and resume" (Claude paused when the card was
  // drawn; the page passes what it drew, never claudePaused at click time, so a key pressed just before a click on
  // plain Allow is not resumed unseen): yes and Resume in one synchronous step. A no never resumes: the pause stays
  // until Resume, Stop or the turn's end.
  answerClaude(allow, { dontAsk = false, resume = false } = {}) {
    const p = this.claudePending;
    if (!p) return;
    // "Don't ask again" is offered only while the switch is on; with it off the page hides the box and it counts for nothing
    if (p.kind === 'load' && allow && dontAsk && this.claudeAllowed) this.claudeLoadNoAsk = true;
    p.resolve(!!allow);
    if (allow && resume) this.resumeClaude();
  }
  // turning the switch off also brings load_basic's card back
  // (on never resumes a pause: it gives consent only. Off during a pause refuses the call waiting on it: pauseWait)
  setClaudeAllowed(on) {
    this.claudeAllowed = !!on;
    if (!on && this.claudePaused) this.claudePaused.revoked = true;
    if (!on) { this.claudeLoadNoAsk = false; if (this.claudePending) this.claudePending.resolve(false); }
    this.emit('chat');
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
    if (!this.chat || !this.chat.busy || !(this.claudeBusyActing || this.claudeCall) || this.claudePaused) return false;
    const m = this.chatTarget().machine;
    // what is not yet typed: the typist's queue (paced keys wait there on every machine), and the stub's queued
    // codes unless the one there is the paced key in flight (it finishes; the rest waits)
    const pacedStub = !!(m.typist.state && m.typist.state.stub);
    const held = { queue: m.typist.queue.splice(0), stub: pacedStub || !m.useStub ? [] : m.stubKeys.splice(0) };
    this.claudePaused = { held, wake: [] };
    this.claudePauses++;
    this.emit('chat');
    return true;
  }
  resumeClaude() {
    const p = this.claudePaused;
    if (!p) return false;
    this.claudePaused = null;
    const m = this.chatTarget().machine;
    // the switch turned off during the pause withdrew consent: nothing held goes in (its typing ends no-consent, as
    // stopClaude drops it), and the call waiting on the pause is refused no-consent (pauseWait)
    // (held.stub is dropped with no job to end: it holds raw stub codes, and all of Claude's typing - type_text, run's
    // RUN (typeTextPaced) and press_break's BREAK (holdPaced) - is paced through the typist queue (held.queue, whose
    // jobs end above), never left in stubKeys. Only the person's text goes there through queueText, so a Claude job in
    // held.stub is unreachable; were one added, it would need ending here too.)
    if (p.revoked) { for (const it of p.held.queue) if (it && it.job) it.job.end('no-consent'); }
    else { m.stubKeys.push(...p.held.stub); m.typist.queue.push(...p.held.queue); }
    for (const w of p.wake) w(true);
    this.emit('chat');
    return true;
  }
  // Stop: the turn ends, a waiting question is answered STOPPED (either card: the tool fails stopped), and what Claude was typing stops being typed.
  // reason: why the page stopped Claude (a Reset, a power cycle), for the note in the conversation; 'claude-stopped' event
  stopClaude(reason = null) {
    if (!this.chat) return;
    this.endClaudePause();
    if (this.claudePending) this.claudePending.resolve(STOPPED);   // the question ends as Stop, not as a no
    this.chat.abort(reason);
    const m = this.chatTarget().machine;
    if (m.typist) m.typist.clear();
    if (m.stubKeys) m.stubKeys.length = 0;
    this.claudeActing = null;
    this.emit('chat');
    if (reason) this.emit('claude-stopped', reason);
  }
  // A restart of the machine Claude acts on while Claude acts on it (or is paused) stops Claude first: what it held
  // back or still had to type must never go into the machine that starts over, and the action it was on is
  // refused. Reset and power cycle say so in their own words; every other restart reaches here through the
  // machine's onReset (install). A restart of the chat machine (the full-screen chat's own screen) leaves Claude
  // alone. (A machine switch or a snapshot load replaces the machine and closes the conversation: adopt -> dropChat.)
  stopClaudeFor(reason, m = this.machine) {
    // (what the program on the machine asks for itself, asMachine: when the keys that asked were Claude's, Claude
    // goes on; when they may have been the person's, it stops)
    if (this.machineTicketHolds(this.machineDriven)) return;
    if (this.chat && m === this.chatTarget().machine && (this.claudeBusyActing || this.claudePaused)) this.stopClaude(reason);
  }
  // What the program on the machine asks for itself (the welcome menu's choices: LIZA, the colour demo, carry on;
  // the menu coming back after LIZA's BYE or the demo: the 'welcome:*' and 'menu' events) was asked by keys typed
  // into the machine. The page takes a ticket when the event comes (machineTicket), fetches what it needs, then
  // starts it in asMachine(fn, ticket). The start does not stop Claude only if the keys were Claude's: Claude was
  // acting and not paused when the event came, and since then the same turn goes on with no pause (a pause, even
  // one resumed, means the person pressed a key; a key pressed while Claude only thought is the person's too).
  machineTicket() {
    // (not while a card waits: nothing of Claude's is typed then, so the key is the person's)
    return { claude: !!this.chat && this.claudeBusyActing && !this.claudePaused && !this.claudePending, chat: this.chat, controller: this.chat && this.chat.controller, pauses: this.claudePauses };
  }
  machineTicketHolds(t) {
    return !!t && t.claude && !this.claudePaused && t.pauses === this.claudePauses && t.chat === this.chat && t.controller === (this.chat && this.chat.controller);
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
    const p = this.claudePaused;
    return !!p && !!(this.claudeCall || p.held.queue.length || p.held.stub.length);
  }
  // the pause ends with its turn: nothing held is typed later, and an action waiting on it is refused (stopped)
  endClaudePause() {
    const p = this.claudePaused;
    if (!p) return false;
    this.claudePaused = null;
    for (const it of p.held.queue) if (it && it.job) it.job.end('stopped');   // held-back typing ends with the turn
    for (const f of p.wake) f(false);
    this.emit('chat');
    return true;
  }
  // is Claude acting on the BASIC session now: an acting tool this turn (claudeActing ends with the turn), paused,
  // or its typing still going in
  // (paused: only while something of Claude's is held by the pause, claudeHeld; a pause after a declined card while
  // Claude only writes text is not acting)
  get claudeBusyActing() {
    if (!this.chat || !this.claudeActing) return false;
    if (this.claudePaused) return this.claudeHeld;
    const m = this.chatTarget().machine;
    return this.chat.busy || (m.typist && m.typist.busy) || (m.stubKeys && m.stubKeys.length > 0);
  }
  // the code at addr (the program counter by default), as the Debugger would show it, for "What is this code
  // doing?": { from, to, text } with one "ADDR  BYTES  INSTRUCTION" line per instruction and the registers
  // It reads the BASIC session, the machine the read tools use: in the full screen chat this.machine is the chat firmware.
  codeAt(addr, count = 8) {
    const m = this.chatMachines ? this.chatMachines.basic : this.machine, { cpu, dp } = codeDisassembly(m);
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
    const notices = this.restorePoint(m, snap);
    chat.undo.length = index;
    // the actions the point took back are marked undone, with the restore's time (R13)
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
      this.chatMachines = null; this.chatView = null; this.chatServer = null;
      if (this.machine !== basic) { this.install(basic); this.emit('machine'); }
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
    const basic = this.machine;
    if (!backend) throw new SessionError('The chat needs a backend.');
    if (!firmware) throw new SessionError('The chat needs its firmware (examples/chat.bin).');
    if (cpuFamily(basic.config.cpu) !== '6809') throw new SessionError(`The chat firmware needs a 6809; the ${basic.profile.name} has a ${basic.config.cpu}.`);
    if (drivewire && !basic.profile.options.becker) throw new SessionError(`The ${basic.profile.name} has no Becker port, so the chat cannot use DriveWire there.`);
    const kept = this.chat && !this.chatMachines ? this.chat : null;   // the side panel's conversation moves here
    if (!kept) this.dropChat();
    // the welcome program, if it runs, stays on the BASIC session: closing the chat comes back to its menu
    const chatMachine = createMachine(basic.id, drivewire ? Object.assign({}, basic.config, { becker: true }) : basic.config);
    if (drivewire) {
      this.chatServer = new DriveWireServer({ store: this.media, namePrefix: DW_PREFIX, clock: this.drivewire.clock, sameName: (a, b) => this.sameName(a, b) });
      this.chatServer.drives = this.drivewire.drives;
      chatMachine.becker.attach(this.chatServer);
      if (!channel) channel = new DriveWireChatChannel(this.chatServer, CHAT_DW_CHANNEL);
    }
    if (!channel) throw new SessionError('The chat needs a channel.');
    chatMachine.stubKeepCase = true;      // the firmware draws lower case: typed text reaches it as typed
    chatMachine.reset(true);
    this.chatMachines = { chat: chatMachine, basic };
    this.chatView = 'chat';
    const { welcome, welcomeBuild } = this;
    this.install(chatMachine);
    this.emit('machine');
    this.loadMedia('chat.bin', firmware, null);
    // (loading ends the welcome; it ran on the BASIC session, not this one)
    Object.assign(this, { welcome, welcomeBuild });
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
  // what the chat's tools act on: the BASIC session: beside the chat machine in full screen, else the
  // machine in use. It runs whether or not it is on screen, so acting never swaps the screen (show does nothing):
  // the person watches it live in the picture-in-picture
  chatTarget() {
    const basic = () => (this.chatMachines ? this.chatMachines.basic : this.machine);
    return {
      get machine() { return basic(); },
      show: () => {},
      screenText: () => this.screenText(basic()),
      readByte: (addr) => this.readByte(addr, basic()),
      // What the read-only tools ask about the machine they act on: whether BASIC has printed OK. bootStatus()
      // answers about this.machine, which is the chat machine while a chat is open, so this asks the SAME
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
      // a restore point: when it was taken and the drives linked to the media store at that moment (their links)
      snapshot: () => { const snap = basic().snapshot(); this.claudePointInfo.set(snap, { at: Date.now(), disks: this.storedDisks(basic()) }); return snap; },
      // the same guarded path as restoreClaude -> restorePoint's notices
      restore: (snap) => this.restorePoint(basic(), snap),
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
    const basic = this.chatMachines ? this.chatMachines.basic : this.machine;
    this.dropChat();
    if (this.machine !== basic) { this.install(basic); this.emit('machine'); }
    this.emit('chat');
  }
  dropChat() {
    if (!this.chat) return;
    if (this.claudePending) this.claudePending.resolve(false);
    this.chat.abort();
    this.chat = null; this.chatMachines = null; this.chatView = null; this.chatServer = null;
    this.endClaudePause();
    this.claudeView = null; this.claudeActing = null; this.claudePending = null; this.claudePaused = null; this.claudeTool = null; this.claudeCall = null;
  }

  // assembled program (Emu.assemble result) -> message
  runAssembled(res) {
    this.endWelcome();
    this.inject(res.segments, res.exec);
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
  get lizaFile() { return cpuFamily(this.machine.config.cpu) === '6809' ? Session.LIZA['6809'] : Session.LIZA['6803'][this.machine.id]; }
  // what a machine needs before it can run LIZA -> { ram, have } when the RAM option is too small, else null
  lizaNeeds() {
    const m = this.machine, need = Session.LIZA.ram;
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
    this.watchForMenu('liza');
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
    const m = this.machine;
    return m.config.ram < GAMES.ram ? { ram: GAMES.ram, have: m.config.ram } : null;
  }
  // can game `name` run here? Throws a SessionError that says why not (another CPU, too little RAM)
  checkGame(name) {
    const g = GAMES.list[name], m = this.machine;
    this.gameFile(name);
    if (cpuFamily(m.config.cpu) !== '6809') throw new SessionError(`${g.name} is 6809 code; the ${m.profile.name} has a ${m.config.cpu}.`);
    const need = this.gameNeeds();
    if (need) throw new SessionError(`${g.name} needs ${need.ram}K RAM or more; this ${m.profile.name} has ${need.have}K. Switch the RAM option to ${need.ram}K or 64K to play it.`);
  }
  runGame(name, bytes) {
    this.checkGame(name);
    const file = this.gameFile(name), m = this.machine;
    const msg = this.load(file, bytes, { remember: false });
    // the SAM's memory size as the firmware or BASIC left it, for the game to put back on leaving (the CoCo 3's
    // GIME has no M bits: the header's default stays)
    if (m.sam) m.poke(GAMES.samExit, m.sam.memSize);
    this.setLastRun('game', GAMES.list[name].name);
    this.watchForMenu('game');
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
  watchForMenu(kind) {
    const m = this.machine;
    const watch = kind === 'game' && !m.useStub ? true : this.welcomeMenu && WELCOME[cpuFamily(m.config.cpu)] && m.useStub;
    this.menuWatch = watch ? { kind, m, since: null, taken: m.stubKeysTaken, drawing: false } : null;
    if (this.stubRun && this.stubRun.m === m) this.stubRun.watch = kind;   // a Reset restarts the watch too
  }
  checkMenuReturn() {
    const w = this.menuWatch;
    if (!w) return;
    const m = this.machine;
    if (w.m !== m || (!m.useStub && w.kind !== 'game')) { this.menuWatch = null; return; }
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
    this.emit('menu');
  }
  // the one-step switch: fit the RAM option LIZA needs, keeping the other options
  switchLiza() {
    const m = this.machine, need = Session.LIZA.ram;
    this.switchMachine(m.id, Object.assign({}, this.savedConfig(m.id), { ram: need }));
    return need;
  }
  // insert a tape for a manual CLOAD / CLOADM: .CAS bytes, or a WAV recording (decoded to .CAS)
  insertTape(name, bytes) {
    const m = this.machine, d = formats.identify(name, bytes);
    if (d.kind === 'wav') throw new SessionError(d.error ? `${name}: ${d.error}` : `${name}: no tape blocks found in this recording`);
    m.deck.insert(new Tape(d.kind === 'cas' ? d.bytes : bytes, m.tickHz, name, m.profile.tape));
    this.emit('tape');
    return `Tape ${name} inserted${d.wav ? ` (decoded from the recording: ${d.wav.blocks} blocks)` : ''}. Type CLOAD or CLOADM.`;
  }
  // the tape in the deck as a WAV file (its signal: one sine cycle per bit) -> { name, bytes }
  tapeWav() {
    const t = this.machine.deck.tape;
    if (!t) throw new SessionError('There is no tape in the deck.');
    const p = this.machine.profile.tape || {};
    return { name: t.name.replace(/\.[^.]*$/, '') + '.wav', bytes: casToWav(t.bytes, { zeroHz: p.zeroHz, oneHz: p.oneHz }) };
  }

  // ---------------- recording what the machine writes to tape (CSAVE, CSAVEM, your own writer) ----------------
  get tapeRecording() { return !!this.machine.deck.recording; }
  startTapeRecording() {
    this.machine.deck.startRecording();
    return 'Recording the cassette output: CSAVE or CSAVEM now.';
  }
  // -> { cas, wav, blocks, badBlocks, seconds }: .CAS bytes decoded from what was written, and the signal itself
  stopTapeRecording(sampleRate = 44100) {
    const m = this.machine, events = m.deck.stopRecording(), p = m.profile.tape || {};
    const samples = recordingToSamples(events, m.tickHz, sampleRate);
    const r = samplesToCas(samples, sampleRate, { zeroHz: p.zeroHz, oneHz: p.oneHz });
    return { cas: r.bytes, wav: writeWav(samples, sampleRate), blocks: r.blocks, badBlocks: r.badBlocks, seconds: samples.length / sampleRate };
  }
  // A recording still running when its machine goes (a machine switch, a snapshot opened) is finished and kept as
  // unsavedRecording ({ cas, wav, blocks, badBlocks, seconds, machine: its name }), then 'recording' is emitted while
  // that machine is still the one in use, so the page can offer to save it before it changes. A recording with no
  // block in it holds nothing to save and is dropped.
  keepRecording() {
    if (!this.machine || !this.tapeRecording) return;
    const r = this.stopTapeRecording();
    if (!r.blocks) return;
    this.unsavedRecording = Object.assign(r, { machine: this.machine.profile.name });
    this.emit('recording');
  }
  rewindTape() { const t = this.machine.deck.tape; if (t) t.seekByte(0); this.tapeWatch = null; return !!t; }

  // ---------------- the cassette panel ----------------
  // What the deck is doing -> null without a tape, else { name, block, blocks, progress, seconds, duration,
  // position, length, atEnd, motor, playing, realSpeed, error }. block counts the tape's blocks (js/media/cassette.js
  // casBlocks) the play position has reached; position is that place as a byte of the image (0 to length, the leader
  // the deck adds before it counting as 0); seconds is how far into the tape that is at real speed. error is the block
  // number where BASIC stopped with ?IO ERROR: a run of the motor that ends with that on the last lines of
  // the screen (the ROM's own report, so it needs the text screen of a Dragon, CoCo 1/2 or MC-10).
  tapeStatus() {
    const m = this.machine, deck = m.deck, t = deck.tape;
    if (!t) { this.tapeWatch = null; return null; }
    deck.sync();
    if (!this.tapeInfo || this.tapeInfo.tape !== t) {
      this.tapeInfo = { tape: t, blocks: Array.from(casBlocks(t.bytes), (b) => b.start), duration: t.seconds() };
      this.tapeWatch = null;
    }
    const info = this.tapeInfo, at = t.bytePosition();
    const block = info.blocks.filter((start) => start <= at).length;
    // read errors: watch each run of the motor
    if (deck.motor) { if (!this.tapeWatch || this.tapeWatch.done) this.tapeWatch = { done: false, error: null }; }
    else if (this.tapeWatch && !this.tapeWatch.done) {
      const last = this.screenText().filter((l) => l.trim()).slice(-2).join(' ');
      this.tapeWatch = { done: true, error: /\?IO ERROR/.test(last) ? Math.max(1, block) : null };
    }
    return {
      name: t.name, block, blocks: info.blocks.length, progress: t.progress(), seconds: t.progress() * info.duration, duration: info.duration,
      position: Math.max(0, Math.min(t.bytes.length, at)), length: t.bytes.length, atEnd: t.atEnd(),
      motor: deck.motor, playing: deck.playing, realSpeed: !this.fastTape, error: this.tapeWatch ? this.tapeWatch.error : null,
    };
  }
  // Skip the tape: load what is on it instantly instead (the machine is power cycled first, so whatever BASIC
  // was doing with the tape stops; the cartridge comes out with it, as on any power cycle) -> message
  // A tape's bytes are always .CAS blocks (a WAV recording is decoded when it goes in), so they are loaded under a
  // .CAS name (.C10 / .K7 kept: the same block format); what would make the load fail is checked before the power
  // cycle, which takes the tape out, so a refused skip leaves the tape where it was.
  skipTape() {
    const m = this.machine, t = m.deck.tape;
    if (!t) throw new SessionError('There is no tape in the deck.');
    const ext = (t.name.split('.').pop() || '').toLowerCase();
    const name = /^(cas|c10|k7)$/.test(ext) ? t.name : `${t.name.replace(/\.[^.]*$/, '')}.cas`;
    const d = formats.identify(name, t.bytes);
    if (d.kind !== 'cas' || !d.files.length) throw new SessionError(`${t.name}: no complete file on this tape to load instantly.`);
    if (d.files[0].fileType === 0 && !m.hasRom) throw this.needsRom('A BASIC tape');
    const { bytes } = t, fast = this.fastCas;
    this.powerCycle();
    this.fastCas = true;
    try { return this.load(name, bytes, { remember: false }); } finally { this.fastCas = fast; }
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
  startWelcome(bytes, { greeting = 'first', carryOn = null, gen = null } = {}) {
    // The ticket catches "the machine was taken by something else while the bytes were in flight" -- a program
    // loaded, a snapshot opened, a Reset, a switch the person did not ask for. It is compared BEFORE the start's own
    // machine work (which bumps it through endWelcome), and there is only ever ONE start per turn now
    // (Session.chooseMachine starts the menu once; the page no longer races it with a second one).
    if (gen !== null && gen !== this.welcomeGen) return null;
    const m = this.machine, w = WELCOME[cpuFamily(m.config.cpu)];
    if (!w) throw new SessionError(`There is no Welcome menu for the ${m.profile.name}'s ${m.config.cpu}.`);
    const g = WELCOME.greetings.indexOf(greeting);
    if (g < 0) throw new SessionError(`unknown welcome greeting "${greeting}"`);
    if (!m.useStub) this.runWithoutRoms({ menu: false });   // also adds the machine to stubChosen ("Use the ROMs again" undoes it)
    this.loadMedia(this.welcomeFile, bytes, null);
    if (this.stubRun) this.stubRun.welcome = { bytes, greeting, carryOn };   // Reset: the menu as it is now
    this.menuWatch = null;
    m.poke(w.greet, g);
    let carry = carryOn ? `CARRY ON WITH ${carryOn}`.toUpperCase().replace(/[^ -_]/g, '?') : '';
    if (carry.length > w.carryMax) {   // cut at a word if there is one past "CARRY ON WITH", else at the edge
      const cut = carry.lastIndexOf(' ', w.carryMax);
      carry = carry.slice(0, cut > 'CARRY ON WITH'.length ? cut : w.carryMax);
    }
    for (let i = 0; i <= carry.length; i++) m.poke(w.carry + i, i < carry.length ? carry.charCodeAt(i) : 0);
    this.welcome = m;
    this.welcomeBuild = w;
    this.emit('welcome');   // (the page's parts that depend on whether the welcome program runs: the quick-save slots)
    if (this.welcomeSoundOn) this.welcomeSound();
    const last = (carry ? 1 : 0) + (w === WELCOME['6809'] ? 5 : 4);   // the 6809 build has the games too
    return `Welcome: press 1 to ${last}`;
  }
  get welcomeRunning() { return this.welcome === this.machine; }
  // the welcome build this machine runs: the 6809 file for every 6809-family model (the 6309 included), the
  // machine's own 6803 build on the MC-10 and the Alice (their subtitles differ). The page fetches it by this name.
  get welcomeFile() {
    const m = this.machine, w = WELCOME[cpuFamily(m.config.cpu)];
    return (w && w.file) || WELCOME6803[m.id];
  }
  // the page unlocked audio: the welcome program plays its tune (once per start)
  welcomeSound() {
    this.welcomeSoundOn = true;
    if (this.welcomeRunning) this.machine.poke(this.welcomeBuild.soundOk, 1);
  }
  endWelcome() {
    this.welcome = null; this.welcomeBuild = null; this.menuWatch = null;
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
    const m = this.machine, at = this.welcomeBuild.event, key = m.peek ? m.peek(at) : m.ram[at];
    if (!key) return;
    m.poke(at, 0);
    const name = WELCOME.events[key - 1];
    if (name) this.emit(`welcome:${name}`);
  }

  // ---------------- real time ----------------
  get tapeRunning() { return this.fastTape && this.machine.deck.playing; }
  // run the frames due after `ms` of real time; onFrame(machine) after each paced frame (audio).
  // Flat out (turbo, fast tape) runs for at most `budgetMs`. Returns the number of frames run.
  advance(ms, { onFrame = null, budgetMs = 14, now = () => Date.now() } = {}) {
    const m = this.machine;
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
    if (n) { this.checkRate(); this.checkPrinter(); }
    this.flushWelcome();
    this.checkMenuReturn();
    return n;
  }
  // One frame of machine m (d: the armed debugger, or null) with what every frame brings: the host's keys first, the
  // chat machine's bytes and the machine beside it after -> false when it stopped part way: a debugger stop (emits
  // 'debug'), or the machine waiting for the store (m.stall: the same frame finishes on a later call).
  oneFrame(m, d) {
    this.keys.step(m);
    if (!(d ? d.runFrame() !== false : m.runFrame())) {
      this.acc = 0;
      if (!m.stall) this.emit('debug');
      return false;
    }
    this.pumpChat(m);
    this.runBeside(m);
    return true;
  }
  // Run `count` frames of emulated time, with no clock: for Node scripts, tests and the command line
  // (cli/cloadm.js), where the same calls must give the same frames on every run. Turbo and fast tape, which are
  // about wall-clock time, play no part. Each frame is followed by the checks advance() makes. Returns the frames
  // run: fewer when a debugger breakpoint or watchpoint stopped the machine (s.paused), or the machine waits for
  // the store (s.machine.stall, a DriveWire read: let the event loop run, then call again).
  runFrames(count) {
    const m = this.machine;
    let n = 0;
    while (n < count && !m.stall && !this.paused) {
      if (!this.oneFrame(m, this.debugger && this.debugger.armed ? this.debugger : null)) break;
      n++;
      this.checkRate();
      this.checkPrinter();
      this.flushWelcome();
      this.checkMenuReturn();
    }
    return n;
  }
  // after a frame of the chat machine: bytes cross between its firmware and the chat
  pumpChat(m) { if (this.chat && this.chatMachines && this.chatMachines.chat === m) this.chat.pump(m); }
  // the chat's other machine (off screen, in the picture-in-picture) runs a frame for each frame of the one shown
  besideMachine() {
    const c = this.chatMachines;
    return c ? (this.machine === c.chat ? c.basic : c.chat) : null;
  }
  runBeside() {
    const o = this.besideMachine();
    if (!o || o.stall) return;
    o.runFrame();
    this.pumpChat(o);
  }
  statusLine(fps) {
    const m = this.machine;
    let s = `${m.profile.name} · ${fps.toFixed(0)} fps · ${(fps / m.fps * 100).toFixed(0)}%`;
    const t = m.deck.tape;
    if (t) s += ` · tape ${t.name} ${(t.progress() * 100).toFixed(0)}%${m.deck.motor ? ' ▶' : ''}`;
    return s;
  }
}
