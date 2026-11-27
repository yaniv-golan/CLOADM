#!/usr/bin/env node
// cloadm: the emulator on the command line, for CI and coding agents. Plain Node (built-ins only), no build step:
// it drives the same Session the page does (js/session.js), headless, in emulated time only.
//
//   node cli/cloadm.js --machine coco --program liza --type 'I need a holiday\n' --wait-for 'text:WHY DO YOU NEED' --screen
//
// Every option after the machine setup is a STEP, run in the order given; --script FILE reads the same steps from a
// file, one per line (`type I need a holiday\n`). --describe prints the whole interface as JSON (steps, exit and
// error codes). --mcp runs a Model Context Protocol server on stdio for coding agents, and --serve the same tools over
// JSON lines (cli/mcp.js, js/mcp/tools.js; docs/mcp.md). The
// guide is docs/automation.md. Exit codes: 0 success, 1 a condition failed (wait-for timed out, expect-* did not
// match), 2 usage error, 3 media or ROM error, 4 internal error; every error also has a stable `code`.
//
// Determinism: the machine runs whole emulated frames (Session.runFrames) with no wall clock anywhere (no turbo
// budget, no fast-tape pacing), as fast as the host can run them, so the same inputs give the same frames and sound.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Emu = require('../js/emu.js');

const ROOT = path.join(__dirname, '..');
// The interface's version: it goes up when a step, a parameter, a result field or a code changes incompatibly.
const SCHEMA_VERSION = 1;
const EXIT = Object.freeze({ ok: 0, condition: 1, usage: 2, media: 3, internal: 4 });
const EXIT_TEXT = Object.freeze({ 0: 'success', 1: 'a condition failed', 2: 'usage error', 3: 'media or ROM error', 4: 'internal error' });
// error.code -> [kind (its exit code), what it means]. Stable: callers may branch on them.
const ERROR_CODES = Object.freeze({
  'bad-argument': ['usage', 'a step\'s argument is malformed or out of range'],
  'unknown-step': ['usage', 'no step or option of that name'],
  'setup-order': ['usage', 'a machine setup step after other steps'],
  'no-steps': ['usage', 'nothing to do'],
  'bad-option': ['usage', 'the model has no such option, or not that value'],
  untypable: ['usage', 'the machine\'s keyboard cannot type a character or key'],
  'cannot-read': ['media', 'a file could not be read'],
  'cannot-write': ['media', 'a file could not be written'],
  'bad-media': ['media', 'a file is not what the step needs (format, kind, assembly errors)'],
  'missing-roms': ['media', 'the ROMs given do not include what the model needs to boot'],
  'record-too-big': ['media', 'a record (AVI) recording reached the AVI 1.0 limit of 1 GiB (record-dir has none)'],
  'record-size-changed': ['media', 'the frame changed size during a recording (a CoCo 3 mode or monitor change)'],
  rejected: ['media', 'the machine refused the media or request (e.g. a BASIC program without BASIC, a disk on a machine with no drives)'],
  timeout: ['condition', 'a wait-for did not hold within its timeout'],
  'expect-failed': ['condition', 'an expect-* did not hold'],
  'keys-not-taken': ['condition', 'the machine did not read the typed keys within the timeout'],
  internal: ['internal', 'a bug in CLOADM: please report it'],
});
// the 8-bit registers, as the debugger names them (js/debugger.js REGS); q is the 6309's 32, the rest are 16
const REG_BYTES = ['a', 'b', 'e', 'f', 'dp', 'cc', 'md'];
const DEFAULT_TIMEOUT = 10;   // emulated seconds a wait-for (or the keys a type step queues) may take
const STEP_LIMIT = 100000;    // most instructions one `step` runs
const HOLD_LIMIT = 100000;    // most frames one `hold` runs
// --wav: 16-bit mono PCM at WAV_RATE. A sample is the machine's sound level averaged over the sample's time window
// (the page's own output stage, js/host/audio.js AudioOutput, without its DC-blocking filter), times WAV_SCALE: the
// 6-bit DAC's step is 320 (DAC value d is 320 x d, at most 20160) and the single-bit output adds 10240 (32 DAC steps).
const WAV_RATE = 44100;
const SERIAL_TRACE_LIMIT = 65536;   // --serial-trace: the events kept (the newest)
const DISK_TRACE_LIMIT = 65536;     // --disk-trace: the events kept (the newest)
const WAV_SCALE = 20160;
// --record: an AVI 1.0 file (js/media/avi.js) of every frame and its sound (the --wav samples); --record-dir: the
// same as PNGs, a WAV and an ffconcat list
const RECORD_LIMIT = Emu.AVI_LIMIT;

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.kind = ERROR_CODES[code][0];
    Object.assign(this, extra);
  }
}
const usage = (msg, code = 'bad-argument') => new CliError(code, msg);
const media = (msg, code = 'bad-media') => new CliError(code, msg);

// ---------------- argument values ----------------
// An address or byte: $hex, 0xhex or decimal (a number is taken as it is).
function number(text, what, max) {
  if (typeof text === 'number') {
    if (!Number.isInteger(text) || text < 0 || text > max) throw usage(`${what} ${text} is not a whole number from 0 to ${max}`);
    return text;
  }
  const t = String(text).trim();
  const m = /^(?:\$|0x)([0-9a-f]+)$/i.exec(t) || /^(\d+)$/.exec(t);
  const v = m ? parseInt(m[1], m[0] === m[1] ? 10 : 16) : NaN;
  if (!Number.isInteger(v) || v < 0 || v > max) throw usage(`${what} "${text}" is not a number from 0 to ${max} ($hex, 0xhex or decimal)`);
  return v;
}
const address = (t) => number(t, 'address', 0xFFFF);
const byte = (t) => number(t, 'value', 0xFF);
function positive(text, what, { integer = false } = {}) {
  const v = Number(text);
  if (!(v > 0) || !Number.isFinite(v) || (integer && !Number.isInteger(v))) throw usage(`${what} must be a positive ${integer ? 'whole ' : ''}number, not "${text}"`);
  return v;
}
// /source/flags, or a plain regular expression source
function regex(text) {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(text);
  try { return m ? new RegExp(m[1], m[2]) : new RegExp(text); } catch (e) { throw usage(`not a regular expression: ${text} (${e.message})`); }
}
// ADDR=VALUE
function memTest(text) {
  const m = /^([^=]+)=(.+)$/.exec(text);
  if (!m) throw usage(`expected ADDRESS=VALUE, not "${text}"`);
  return { address: address(m[1]), value: byte(m[2]) };
}
// a wait-for condition: text:REGEX | mem:ADDR=VALUE | pc:ADDR
function condition(text) {
  const m = /^(text|mem|pc):([\s\S]+)$/.exec(text);
  if (!m) throw usage(`a wait-for condition is text:REGEX, mem:ADDRESS=VALUE or pc:ADDRESS, not "${text}"`);
  if (m[1] === 'text') return { kind: 'text', source: m[2], re: regex(m[2]) };
  if (m[1] === 'mem') return Object.assign({ kind: 'mem' }, memTest(m[2]));
  // a label (given by --asm or --symbols) is looked up when the wait runs; anything else is an address
  if (/^[A-Za-z_.@]/.test(m[2].trim())) return { kind: 'pc', label: m[2].trim() };
  return { kind: 'pc', address: address(m[2]) };
}
// Text to type. \n (or \r) is ENTER, \\ a backslash, {NAME} a key that is no character: ENTER, BREAK, CLEAR, UP,
// DOWN, LEFT, RIGHT, SPACE. A real newline is ENTER too. Returns a list of characters and { key } items.
// the bundled programs --program runs
const PROGRAMS = ['welcome', 'liza', 'demo', ...Object.keys(Emu.GAMES.list)];
const KEY_NAMES = ['ENTER', 'BREAK', 'CLEAR', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE'];
function typed(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const n = text[++i];
      if (n === 'n' || n === 'r') out.push('\n');
      else if (n === '\\' || n === '{') out.push(n);
      else throw usage(`unknown escape \\${n} in typed text (\\n is ENTER, \\\\ a backslash, \\{ a brace)`);
      continue;
    }
    if (ch === '{') {
      const end = text.indexOf('}', i);
      const name = end > i ? text.slice(i + 1, end).toUpperCase() : '';
      if (!KEY_NAMES.includes(name)) throw usage(`unknown key {${text.slice(i + 1, end > i ? end : i + 12)}} in typed text (keys: ${KEY_NAMES.map((k) => `{${k}}`).join(' ')})`);
      out.push(name === 'ENTER' ? '\n' : name === 'SPACE' ? ' ' : { key: name });
      i = end;
      continue;
    }
    out.push(ch === '\r' ? '\n' : ch);
  }
  return out;
}

// ---------------- the steps ----------------
// name -> { arg: the argument's syntax (null: none), parse(text) -> value, setup: a machine setup step (before the
//   machine is built), help, example }
const STEPS = {
  machine: {
    arg: 'ID', setup: true, help: 'the model (default dragon64); list-machines lists them', example: '--machine coco3',
    parse: (t) => { if (!Emu.profiles[t]) throw usage(`no machine "${t}" (--list-machines lists them)`, 'bad-option'); return t; },
  },
  option: {
    arg: 'KEY=VALUE', setup: true, help: 'a machine option, e.g. ram=16, cpu=6309, becker=true (repeatable)', example: '--option ram=16',
    parse: (t) => { const m = /^([a-zA-Z0-9]+)=(.+)$/.exec(t); if (!m) throw usage(`an option is KEY=VALUE, not "${t}"`); return { key: m[1], value: m[2] }; },
  },
  roms: {
    arg: 'PATH', setup: true, help: 'your ROM dumps: a file, a ROM pack .zip or a directory of them (repeatable); never bundled', example: '--roms ~/roms',
    parse: (t) => t,
  },
  'no-roms': { arg: null, setup: true, help: 'run the built-in firmware (machine code only) even with ROMs given', example: '--no-roms' },
  'fast-cas': { arg: null, setup: true, help: 'load .cas programs straight into memory instead of through BASIC\'s CLOAD', example: '--fast-cas' },
  timeout: {
    arg: 'SECONDS', help: `emulated seconds the following wait-for and type steps may take (default ${DEFAULT_TIMEOUT})`, example: '--timeout 30',
    parse: (t) => positive(t, 'timeout'),
  },
  'load-snapshot': {
    arg: 'FILE', help: 'open a snapshot (.cloadm-state), switching machine if it was taken on another', example: '--load-snapshot mid.cloadm-state',
    parse: (t) => t,
  },
  program: {
    arg: 'NAME', help: 'run a bundled program: welcome, liza, demo, 2048 or minesweeper (no ROMs needed)', example: '--program liza',
    parse: (t) => { if (!PROGRAMS.includes(t)) throw usage(`program is ${PROGRAMS.slice(0, -1).join(', ')} or ${PROGRAMS.at(-1)}, not "${t}"`); return t; },
  },
  load: {
    arg: 'FILE', help: 'load and run a binary, .cas, .wav, cartridge or BASIC listing, as dropping it on the page; a disk image goes in drive 0', example: '--load game.bin',
    parse: (t) => t,
  },
  asm: {
    arg: 'FILE', help: 'assemble a source file with the bundled assembler (for this machine\'s CPU) and run it', example: '--asm hello.asm',
    parse: (t) => ({ file: t }),
  },
  symbols: {
    arg: 'FILE', help: 'read a symbol map (--assemble --map\'s "NAME $ADDR" lines, or an LWLINK or CMOC map) into the labels --disasm shows and --wait-for pc:LABEL reaches, replacing the ones --asm gave', example: '--symbols game.map',
    parse: (t) => t,
  },
  cart: { arg: 'FILE', help: 'plug in a cartridge ROM image (an error if the file is not one)', example: '--cart pak.rom', parse: (t) => t },
  tape: { arg: 'FILE', help: 'put a .cas or .wav in the cassette deck without loading it (then type CLOAD)', example: '--tape game.cas', parse: (t) => t },
  disk: {
    arg: '[N=]FILE', help: 'mount a disk image (VDK, JVC/DSK, DMK) in drive N (default 0); without your disk ROM, on the disk controller alone (for programs that read the disk directly)', example: '--disk 1=data.dsk',
    parse: (t) => { const m = /^([0-3])=(.+)$/.exec(t); return m ? { drive: +m[1], file: m[2] } : { drive: 0, file: t }; },
  },
  type: {
    arg: 'TEXT', help: 'type at the keyboard and run until the machine has taken the keys (with ROMs, paced by what the machine reads); \\n or {ENTER} is ENTER, also {BREAK} {CLEAR} {UP} {DOWN} {LEFT} {RIGHT} {SPACE}', example: '--type \'RUN\\n\'',
    parse: (t) => ({ text: t, items: typed(t) }),
  },
  frames: { arg: 'N', help: 'run N frames', example: '--frames 50', parse: (t) => positive(t, 'frames', { integer: true }) },
  seconds: { arg: 'S', help: 'run S seconds of emulated time', example: '--seconds 2', parse: (t) => positive(t, 'seconds') },
  'wait-for': {
    arg: 'COND', help: 'run until text:REGEX is on the screen, mem:ADDR=VALUE holds or pc:ADDR is reached (stops at that instruction); a timeout is exit 1', example: '--wait-for \'text:READY\'',
    parse: condition,
  },
  'expect-screen': { arg: 'REGEX', help: 'the screen text must match now, or exit 1', example: '--expect-screen \'OK\'', parse: regex },
  'expect-mem': { arg: 'ADDR=VALUE', help: 'the byte must hold the value now, or exit 1', example: '--expect-mem \'$3100=5\'', parse: memTest },
  'expect-screenshot': {
    arg: 'FILE', help: 'the frame must match a reference PNG pixel for pixel (up to the tolerance), or exit 1; the result counts the differing pixels and gives the first', example: '--expect-screenshot ref.png',
    parse: (t) => ({ file: t }),
  },
  tolerance: {
    arg: 'N', help: 'how many pixels each later expect-screenshot may find different (default 0)', example: '--tolerance 4',
    parse: (t) => number(t, 'tolerance', 0xFFFFFFF),
  },
  diff: {
    arg: 'FILE', help: 'each later expect-screenshot writes a picture of the differences here: differing pixels red, the rest the frame dimmed', example: '--diff diff.png',
    parse: (t) => t,
  },
  hold: {
    arg: 'KEYS[:N]', help: `hold keys down in the keyboard matrix for N frames (default 1, at most ${HOLD_LIMIT}), then let go: a key name (LEFT, RIGHT, UP, DOWN, SPACE, ENTER, SHIFT, ...) or character, several joined with +`, example: '--hold RIGHT:10',
    parse: holdKeys,
  },
  wav: {
    arg: 'FILE', help: `record the machine's sound from here to the end of the run (or a wav-stop) as a 16-bit ${WAV_RATE} Hz mono WAV (emulated time; DAC value d is ${WAV_SCALE / 63} x d)`, example: '--wav sound.wav',
    parse: (t) => ({ file: t }),
  },
  'wav-stop': { arg: null, help: 'end the sound recording here and write its file', example: '--wav-stop' },
  record: {
    arg: 'FILE', help: `record the picture and sound from here to the end of the run (or a record-stop) as an AVI: 8-bit palettized video at the machine's exact frame rate, ${WAV_RATE} Hz 16-bit mono PCM (the wav step's samples); at most 1 GiB (AVI 1.0), written even if the run fails`, example: '--record clip.avi',
    parse: (t) => ({ file: t }),
  },
  'record-dir': {
    arg: 'DIR', help: 'record as record does, into DIR: a PNG per frame (frame00000.png, ...), sound.wav and frames.ffconcat (each frame\'s duration, to the microsecond); no size limit', example: '--record-dir clip',
    parse: (t) => ({ dir: t }),
  },
  'record-stop': { arg: null, help: 'end the recording (record or record-dir) here and write it', example: '--record-stop' },
  'serial-trace': {
    arg: 'FILE', help: `trace the serial port from here to the end of the run, written as JSON Lines (one event a line: at, frame, pc, kind, ...) also when the run fails; the last ${SERIAL_TRACE_LIMIT} events are kept`, example: '--serial-trace serial.jsonl',
    parse: (t) => ({ file: t }),
  },
  'disk-trace': {
    arg: 'FILE', help: `trace the disk controller from here to the end of the run, written as JSON Lines (one event a line: at, frame, pc, kind, ...: command, done, reg-write) also when the run fails; the last ${DISK_TRACE_LIMIT} events are kept`, example: '--disk-trace disk.jsonl',
    parse: (t) => ({ file: t }),
  },
  profile: {
    arg: 'FILE[:cycles|samples]', help: 'profile where the CPU spends its time from here to a profile-stop or the end of the run, by symbol (from asm or symbols; 256-byte pages where none covers), with each range\'s share spent spinning on a poll; cycles (default) counts every cycle exactly, samples one PC every 1000 cycles; FILE gets a text table, or JSON with --json', example: '--profile prof.txt',
    parse: (t) => {
      const m = /^(.*?)(?::(cycles|samples))?$/.exec(t);
      if (!m[1]) throw usage(`profile is FILE[:cycles|samples], not "${t}"`);
      return { file: m[1], mode: m[2] || 'cycles' };
    },
  },
  'profile-stop': { arg: null, help: 'end the profile here and write its file', example: '--profile-stop' },
  screen: { arg: null, help: 'the text on the screen (the readers Claude\'s screen_text uses); a graphics screen has no text, and says so', example: '--screen' },
  screenshot: {
    arg: 'FILE', help: 'save the frame as a PNG (the frame\'s own pixels, unscaled)', example: '--screenshot out.png',
    parse: (t) => ({ file: t }),
  },
  peek: {
    arg: 'ADDR[:LEN]', help: 'LEN bytes (default 1) of memory as the CPU sees it, without side effects', example: '--peek \'$0400:32\'',
    parse: (t) => { const m = /^([^:]+)(?::(.+))?$/.exec(t); if (!m) throw usage(`peek is ADDRESS[:LENGTH], not "${t}"`); return peekRange(address(m[1]), m[2] ? number(m[2], 'length', 0x10000) : 1, t); },
  },
  poke: {
    arg: 'ADDR=V[,V...]', help: 'write bytes through the memory map (ROM and I/O take nothing; the result says how many landed)', example: '--poke \'$3100=1,2,3\'',
    parse: (t) => { const m = /^([^=]+)=(.+)$/.exec(t); if (!m) throw usage(`poke is ADDRESS=VALUE[,VALUE...], not "${t}"`); return pokeRange(address(m[1]), m[2].split(',').map(byte)); },
  },
  registers: { arg: null, help: 'the CPU\'s registers (pc, the accumulators, index and stack registers, cc, dp; the 6309\'s too)', example: '--registers' },
  'set-register': {
    arg: 'NAME=VALUE', help: 'set a CPU register, e.g. pc=$3000 (lower-case names as registers gives them)', example: '--set-register \'pc=$3000\'',
    parse: (t) => {
      const m = /^([a-z]+)=(.+)$/i.exec(t);
      if (!m) throw usage(`set-register is NAME=VALUE, not "${t}"`);
      const name = m[1].toLowerCase();
      // the register's own width: a value that does not fit is refused, never cut down
      const max = REG_BYTES.includes(name) ? 0xFF : name === 'q' ? 0xFFFFFFFF : 0xFFFF;
      return { name, value: number(m[2], `${name}'s value`, max) };
    },
  },
  disasm: {
    arg: '[ADDR][:COUNT]', help: 'disassemble COUNT instructions (default 8, at most 64) at ADDR (default: the PC), in the machine\'s own instruction set', example: '--disasm \'$3000:16\'',
    parse: (t) => {
      const m = /^([^:]*)(?::(.+))?$/.exec(t);
      if (!m) throw usage(`disasm is [ADDRESS][:COUNT], not "${t}"`);
      const count = m[2] ? number(m[2], 'count', 0xFFFF) : 8;
      if (count < 1 || count > 64) throw usage(`disasm's count is 1 to 64, not ${m[2]}`);
      return { address: m[1] ? address(m[1]) : null, count };
    },
  },
  step: {
    arg: 'N', help: `run exactly N instructions (at most ${STEP_LIMIT}), then report the registers`, example: '--step 1',
    parse: (t) => { const n = positive(t, 'instructions', { integer: true }); if (n > STEP_LIMIT) throw usage(`step runs at most ${STEP_LIMIT} instructions`); return n; },
  },
  reset: { arg: null, help: 'press the reset button: with ROMs a warm reset (RAM kept); on the built-in firmware the program it ran starts again, as on the page', example: '--reset' },
  'power-cycle': { arg: null, help: 'switch the machine off and on (RAM cleared; what is inserted stays)', example: '--power-cycle' },
  view: {
    arg: 'main|plus', help: 'which of the Dragon 64 Plus\'s two screens is shown, and so read by screen and screenshot: main (the VDG) or plus (the 80-column HD6845S); the page\'s Display tab setting', example: '--view plus',
    parse: (t) => { if (t !== 'main' && t !== 'plus') throw usage(`view is main or plus, not "${t}"`); return t; },
  },
  'save-snapshot': { arg: 'FILE', help: 'save the machine as a snapshot file (the page opens it too)', example: '--save-snapshot mid.cloadm-state', parse: (t) => t },
  info: { arg: null, help: 'the machine, its options, whether it runs your ROMs, the frame count and the PC', example: '--info' },
};
// --disasm with nothing after it: the PC
STEPS.disasm.optionalArg = true;
// what the script and the command line also accept for these names
const ALIASES = { m: 'machine', o: 'option' };

// KEY[+KEY...][:FRAMES]: key names as the keyboard matrix has them (js/machines/keyboards.js), {NAME} too
function holdKeys(t) {
  const m = /^(.+?)(?::(\d+))?$/.exec(t);
  const keys = m ? m[1].split(/\+(?=.)/).map((k) => k.replace(/^\{(.+)\}$/, '$1')) : [];
  if (!keys.length || keys.some((k) => !k)) throw usage(`hold is KEY[+KEY...][:FRAMES], not "${t}"`);
  const frames = m[2] != null ? positive(m[2], 'frames', { integer: true }) : 1;
  if (frames > HOLD_LIMIT) throw usage(`hold runs at most ${HOLD_LIMIT} frames`);
  return { keys: keys.map((k) => k.toUpperCase()), frames };
}
function peekRange(a, n, t) { if (!n || a + n > 0x10000) throw usage(`peek ${t} runs past $FFFF or is empty`); return { address: a, length: n }; }
function pokeRange(a, bytes) { if (a + bytes.length > 0x10000) throw usage('the bytes run past $FFFF'); return { address: a, bytes }; }

// one step from its name and the text after it; `where` says where it came from, for errors
function makeStep(name, text, where) {
  const real = ALIASES[name] || name, def = STEPS[real];
  if (!def) throw usage(`${where}: unknown step "${name}" (--help lists them)`, 'unknown-step');
  if (def.arg && !def.optionalArg && (text == null || text === '')) throw usage(`${where}: ${real} needs ${def.arg}`);
  if (!def.arg && text != null && text !== '') throw usage(`${where}: ${real} takes nothing, got "${text}"`);
  try { return { name: real, value: def.arg ? def.parse(text == null ? '' : text) : null, where }; } catch (e) { if (e instanceof CliError) e.message = `${where}: ${e.message}`; throw e; }
}
// A script: one step per line, `name argument` (the rest of the line), # comments and blank lines skipped. A step
// whose argument starts and ends with a double quote has the quotes taken off (to keep leading or trailing spaces).
function readScript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw media(`cannot read the script ${file}: ${e.code || e.message}`, 'cannot-read'); }
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
    let arg = m[2] == null ? null : m[2];
    if (arg && arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1);
    if (m[1] === 'script') throw usage(`${file}:${i + 1}: a script cannot include another script`);
    out.push(makeStep(m[1], arg, `${file}:${i + 1}`));
  });
  return out;
}
// the command line -> { json, help, listMachines, describe, steps }
const MODES = ['json', 'help', 'h', 'list-machines', 'describe'];
function parseArgs(argv) {
  const opts = { json: false, help: false, listMachines: false, describe: false, steps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--?([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(a);
    if (!m) throw usage(`unexpected argument "${a}" (every step is an option: --load FILE, --type TEXT, ...)`, 'unknown-step');
    const name = ALIASES[m[1]] || m[1];
    if (MODES.includes(name)) {
      if (m[2] != null) throw usage(`--${name} takes nothing`);
      if (name === 'h' || name === 'help') opts.help = true;
      else if (name === 'list-machines') opts.listMachines = true;
      else opts[name] = true;
      continue;
    }
    if (name === 'script') {
      const file = m[2] != null ? m[2] : argv[++i];
      if (file == null) throw usage('--script needs FILE');
      opts.steps.push(...readScript(file));
      continue;
    }
    const def = STEPS[name];
    if (!def) throw usage(`unknown option ${a} (--help lists them)`, 'unknown-step');
    let arg = m[2];
    const next = argv[i + 1];
    if (def.arg && arg == null) {
      if (def.optionalArg && (next == null || /^--?[a-z]/.test(next))) arg = '';
      else { if (next == null) throw usage(`--${name} needs ${def.arg}`); arg = argv[++i]; }
    }
    opts.steps.push(makeStep(name, arg, `--${name}`));
  }
  return opts;
}

// ---------------- files ----------------
function readFile(file, what) {
  try { return new Uint8Array(fs.readFileSync(file)); } catch (e) { throw media(`cannot read the ${what} ${file}: ${e.code || e.message}`, 'cannot-read'); }
}
// ROM files from a file or a directory (recursively); a ROM pack .zip gives its entries
function romFiles(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { throw media(`cannot read the ROMs ${p}: ${e.code || e.message}`, 'cannot-read'); }
  const files = st.isDirectory()
    ? fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() || e.isFile() ? romFiles(path.join(p, e.name)) : []))
    : [{ name: path.basename(p), bytes: readFile(p, 'ROM') }];
  return files.flatMap((f) => {
    if (!Emu.isZip(f.bytes)) return [f];
    try { return Emu.readZip(f.bytes).filter((e) => e.bytes && e.bytes.length).map((e) => ({ name: path.basename(e.name), bytes: e.bytes })); } catch (e) { throw media(`${f.name}: not a ZIP CLOADM can read (${e.message})`); }
  });
}
function writeFile(file, bytes) {
  try { fs.writeFileSync(file, bytes); } catch (e) { throw media(`cannot write ${file}: ${e.code || e.message}`, 'cannot-write'); }
}

// ---------------- PNG ----------------
const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function chunk(type, data) {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
// a Frame (colour codes + table) as an RGBA PNG of the frame's own size
const frameRgba = (frame) => { const p = Emu.frameToRGBA(frame); return Buffer.from(p.buffer, p.byteOffset, p.byteLength); };
// scale: each pixel repeated that many times across and down (nearest neighbour)
function framePng(frame, scale = 1) {
  if (scale === 1) return rgbaPng(frame.width, frame.height, frameRgba(frame));
  const fw = frame.width, w = fw * scale, h = frame.height * scale, px = Emu.frameToRGBA(frame), out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y / scale) | 0) * fw;
    for (let x = 0; x < w; x++) out.writeUInt32LE(px[src + ((x / scale) | 0)], (y * w + x) * 4);
  }
  return rgbaPng(w, h, out);
}

// a PNG file -> { width, height, rgba: Buffer of R,G,B,A }: grey or palette at 1, 2, 4 or 8 bits, RGB, grey+alpha or
// RGBA at 8, not interlaced (what screenshot writes, and what image editors save); anything else is bad-media
function decodePng(bytes, file) {
  const b = Buffer.from(bytes), bad = (why) => media(`${file}: ${why}`);
  if (b.length < 8 || !PNG_SIG.every((x, i) => b[i] === x)) throw bad('not a PNG file');
  let at = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    if (at + 12 + len > b.length) throw bad('the PNG is cut short');
    const data = b.subarray(at + 8, at + 8 + len);
    if ((zlib.crc32(b.subarray(at + 4, at + 8 + len)) >>> 0) !== b.readUInt32BE(at + 8 + len)) throw bad(`the PNG's ${type} chunk is damaged (CRC)`);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!ihdr || !idat.length) throw bad('the PNG has no image');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colour], depth = ihdr.depth;
  const depthOk = depth === 8 || ((ihdr.colour === 0 || ihdr.colour === 3) && [1, 2, 4].includes(depth));
  if (!channels || !depthOk || ihdr.interlace) throw bad(`only non-interlaced PNGs can be compared, grey or palette at 1, 2, 4 or 8 bits and the other colour types at 8 (this one: colour type ${ihdr.colour}, ${depth}-bit${ihdr.interlace ? ', interlaced' : ''})`);
  if (ihdr.colour === 3 && !plte) throw bad('a palette PNG without its palette');
  // filters work on bytes: `unit` bytes a pixel (at least 1); a row of samples under 8 bits is packed, high bits first
  const w = ihdr.w, h = ihdr.h, unit = Math.max(1, channels * depth / 8), stride = Math.ceil(w * channels * depth / 8);
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { throw bad(`the PNG's image data cannot be read (${e.message})`); }
  if (raw.length < (stride + 1) * h) throw bad('the PNG\'s image data is short');
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = y * (stride + 1) + 1, row = y * stride;
    if (f > 4) throw bad(`unknown PNG filter ${f}`);
    for (let x = 0; x < stride; x++) {
      const a = x >= unit ? px[row + x - unit] : 0, up = y ? px[row - stride + x] : 0, c = x >= unit && y ? px[row - stride + x - unit] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = up; else if (f === 3) pred = (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[row + x] = (raw[line + x] + pred) & 0xFF;
    }
  }
  // samples under 8 bits: each one unpacked to a byte (grey scaled to 0-255, a palette index kept as it is)
  let samples = px;
  if (depth < 8) {
    samples = Buffer.alloc(w * h);
    const max = (1 << depth) - 1, scale = ihdr.colour === 0 ? 255 / max : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = x * depth, v = (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
        samples[y * w + x] = v * scale;
      }
    }
  }
  // a grey PNG's tRNS is one 16-bit grey value (in the PNG's own bit depth) that is transparent
  const clear = ihdr.colour === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = samples.subarray(i * channels, (i + 1) * channels), o = i * 4;
    if (ihdr.colour === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = p[0];
      rgba[o + 3] = clear >= 0 && Math.round(p[0] * ((1 << depth) - 1) / 255) === clear ? 0 : 255;
    }
    else if (ihdr.colour === 2) { rgba[o] = p[0]; rgba[o + 1] = p[1]; rgba[o + 2] = p[2]; rgba[o + 3] = 255; }
    else if (ihdr.colour === 3) {
      if (p[0] * 3 + 2 >= plte.length) throw bad(`palette index ${p[0]} past the PNG's palette`);
      rgba[o] = plte[p[0] * 3]; rgba[o + 1] = plte[p[0] * 3 + 1]; rgba[o + 2] = plte[p[0] * 3 + 2]; rgba[o + 3] = trns && p[0] < trns.length ? trns[p[0]] : 255;
    } else if (ihdr.colour === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = p[0]; rgba[o + 3] = p[1]; }
    else p.copy(rgba, o);
  }
  return { width: w, height: h, rgba };
}
// RGBA bytes as a PNG
function rgbaPng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);   // filter 0 per row
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8 bits, RGBA
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const colourHex = (b, o) => `#${[b[o], b[o + 1], b[o + 2], b[o + 3]].map(hex2).join('')}`;

// ---------------- running ----------------
const DEFAULT_SETUP = () => ({ machine: 'dragon64', options: [], roms: [], noRoms: false, fastCas: false });
class Runner {
  constructor() {
    this.setup = DEFAULT_SETUP();
    this.s = null;
    this.timeout = DEFAULT_TIMEOUT;
    this.tolerance = 0;          // pixels an expect-screenshot may find different
    this.diffFile = null;        // where an expect-screenshot writes its difference picture
    this.wav = null;             // the sound recording under way: { file, out (AudioOutput), clock, chunks, result }
    this.rec = null;             // the picture and sound recording under way (recordStep)
    this.recordLimit = RECORD_LIMIT;
    this.serialTrace = null;     // the serial trace under way: { file, trace, result }
    this.diskTrace = null;       // the disk trace under way: { file, trace, result }
    this.prof = null;            // the profile under way: { file, p (Profiler), result }
    this.json = false;           // --json: a profile's file is JSON, else a text table
    this.results = [];
    this.romReport = null;
  }
  get m() { return this.s.shownMachine; }
  // the machine, built from the setup steps at the first step that needs it
  start() {
    if (this.s) return;
    const { machine: id, options, roms, noRoms, fastCas } = this.setup, p = Emu.profiles[id];
    const config = {};
    for (const { key, value } of options) {
      const o = p.options[key];
      if (!o) throw usage(`the ${p.name} has no option "${key}" (it has ${Object.keys(p.options).join(', ')})`, 'bad-option');
      const v = o.values.find((x) => String(x) === value);
      if (v === undefined) throw usage(`${key} on the ${p.name} is ${o.values.join(' or ')}, not ${value}`, 'bad-option');
      config[key] = v;
    }
    const files = roms.flatMap(romFiles);   // read before anything is built: a missing file changes nothing
    const s = new Emu.Session({ welcomeMenu: false });
    s.fastTape = false;   // tape time is emulated time: no wall-clock pacing (see the header)
    s.turbo = false;
    s.fastCas = fastCas;
    s.switchMachine(id, config, { menu: false });
    this.romReport = null;
    if (files.length || roms.length) {
      const r = s.addRoms(files);
      this.romReport = r.files.map((f) => ({ name: f.name, result: f.result, machines: f.targets.map((t) => t.machine) }));
      if (!noRoms) {
        const mine = s.machineRoms();
        if (!mine.bootable) {
          this.s = s;
          throw media(`missing ROMs: the ${p.name} needs ${mine.sockets.filter((x) => x.status === 'missing-required').map((x) => x.label).join(' and ')}; none of the ${files.length} file(s) given fit (${r.files.map((f) => `${f.name}: ${f.result}`).join(', ')})`, 'missing-roms');
        }
      }
    }
    if (noRoms && s.shownMachine.hasRom) s.runWithoutRoms({ menu: false });
    this.s = s;
  }
  // `count` emulated frames through the Session's own frame path (Session.runFrames: keys, typing, printer, welcome
  // hooks; no clock) -> the frames run: fewer only when a debugger breakpoint stopped the machine part way. A machine
  // waiting for the store (m.stall: a DriveWire sector being read) is waited for, so the frames always run: the store
  // answers through the event loop, which is why this is async.
  // While a --wav or --record recording runs, the frames run one at a time, and each finished frame's sound goes
  // through the recording's output stage, as the page's screen loop pushes it (js/ui/screen.js): sampleRate / fps
  // samples a frame, the fraction carried exactly (Emu.sampleClock), so the sound never drifts from the frames.
  async runFrames(count) {
    let ran = 0;
    const one = () => this.wav || this.rec;
    while (ran < count) {
      const n = this.s.runFrames(one() ? 1 : count - ran);
      if (n && this.wav) this.wav.out.render(this.m.audioEvents, this.m.frameCycles, this.wav.clock.next(), null);
      if (n && this.rec) this.recordFrame();
      ran += n;
      if (ran >= count) break;
      if (one() && n) continue;
      if (this.s.paused || !this.m.stall) break;
      await this.storeAnswer();
    }
    return ran;
  }
  async storeAnswer() {
    for (let i = 0; this.m.stall; i++) {
      if (i > 1e6) throw new CliError('internal', 'the media store never answered the machine\'s DriveWire request');
      await new Promise(setImmediate);
    }
  }
  // one frame -> false when a debugger breakpoint stopped it part way
  async frame() { return (await this.runFrames(1)) === 1; }
  framesFor(seconds) { return Math.max(1, Math.round(seconds * this.m.fps)); }
  // screenTextTool takes a TOOL TARGET (a machine and the reads on it), not a Session: the chat's tools get one from
  // Session.chatTarget(), and the CLI reads the machine on screen - the only one it has - the same way.
  screen() { return Emu.screenTextTool(this.s.chatTarget()); }
  // the failure of a condition: exit 1, with the screen for context
  failed(code, message, extra = {}) { return new CliError(code, message, Object.assign({ screen: this.screen() }, extra)); }
  // a wait that ran out: where the machine is, its serial port and its disk controller (session.diagnostics), for
  // finding out why
  stalled(code, message) {
    const d = this.s.diagnostics();
    return this.failed(code, message, { machine: { pc: d.pc, frame: d.frame, cycles: d.cycles }, serial: d.serial, disk: d.disk });
  }
  record(step, extra = {}) { const r = Object.assign({ step: step.name }, extra); this.results.push(r); return r; }

  // run one step -> its result (also recorded in this.results), or null for a setup step
  async run(step) {
    const v = step.value, def = STEPS[step.name];
    if (def.setup) {
      if (this.s) throw usage(`${step.where}: ${step.name} sets up the machine, so it must come before every other step`, 'setup-order');
      if (step.name === 'machine') this.setup.machine = v;
      else if (step.name === 'option') this.setup.options.push(v);
      else if (step.name === 'roms') this.setup.roms.push(v);
      else if (step.name === 'no-roms') this.setup.noRoms = true;
      else if (step.name === 'fast-cas') this.setup.fastCas = true;
      return null;
    }
    if (step.name === 'timeout') { this.timeout = v; return this.record(step, { seconds: v }); }
    if (step.name === 'tolerance') { this.tolerance = v; return this.record(step, { pixels: v }); }
    if (step.name === 'diff') { this.diffFile = v; return this.record(step, { file: v }); }
    this.start();
    try {
      return await this[STEP_METHODS[step.name]](step, v, this.s);
    } catch (e) {
      if (e instanceof Emu.SessionError) throw media(`${step.where}: ${e.message}`, 'rejected');
      throw e;
    }
  }
  async loadSnapshot(step, file, s) {
    const snap = await s.readSnapshot(readFile(file, 'snapshot'));
    if (!Emu.profiles[snap.machine]) throw media(`${file}: a snapshot of a machine this CLOADM does not have (${snap.machine})`);
    return this.record(step, { file, message: s.openSnapshot(snap) });
  }
  async program(step, name, s) {
    const example = (f) => readFile(path.join(ROOT, 'examples', f), 'program');
    let message;
    if (name === 'welcome') { s.startWelcome(example(s.welcomeFile), { reason: 'shelf' }); message = 'welcome program running'; }
    else if (name === 'liza') message = await s.startLiza(example);
    else if (Emu.GAMES.list[name]) {
      try { message = s.runGame(name, example(s.gameFile(name))); } catch (e) { if (e instanceof Emu.SessionError) throw media(e.message, 'rejected'); throw e; }
    } else {
      if (Emu.cpuFamily(this.m.config.cpu) !== '6809') throw media(`the demo is 6809 code; the ${this.m.profile.name} has a ${this.m.config.cpu}`, 'rejected');
      message = s.load('demo.bin', example('demo.bin'), { remember: false, ours: true });
    }
    return this.record(step, { program: name, message });
  }
  async load(step, file, s) {
    const bytes = readFile(file, 'file'), name = path.basename(file);
    const kind = Emu.detectMedia(name, bytes).kind;
    const message = kind === 'disk' ? await s.drives.importImage(name, bytes, 0) : s.load(name, bytes, { remember: false });
    return this.record(step, Object.assign({ file, message }, diskNote(message)));
  }
  async asm(step, { file }, s) {
    const cpu = this.m.config.cpu === '6309' ? '6809' : this.m.config.cpu;
    const res = assembleFile(file, cpu);
    const message = s.runAssembled(res);
    const symbols = Object.fromEntries([...res.symbols].filter(([, a]) => Number.isInteger(a)));
    return this.record(step, { file, exec: res.exec, message, symbols, segments: res.segments.map((g) => ({ address: g.addr, length: g.data.length })) });
  }
  // a symbol map (--assemble's --map, or a linker's) replaces the labels --disasm and --wait-for pc:LABEL use
  async symbols(step, file, s) {
    let map;
    try { map = Emu.parseSymbols(Buffer.from(readFile(file, 'symbol map')).toString('utf8')); } catch (e) { if (e instanceof Emu.SymbolsError) throw media(`${file}: ${e.message}`); throw e; }
    s.setLabels(map);
    return this.record(step, { file, count: map.size });
  }
  async cart(step, file, s) {
    const bytes = readFile(file, 'cartridge'), name = path.basename(file);
    const d = Emu.formats.identify(name, bytes);
    if (d.kind !== 'cart') throw media(`${file}: not a cartridge ROM image (it reads as ${d.kind})`);
    return this.record(step, { file, message: s.load(name, bytes, { remember: false }) });
  }
  async tape(step, file, s) {
    const bytes = readFile(file, 'tape'), name = path.basename(file), kind = Emu.formats.identify(name, bytes).kind;
    if (kind !== 'cas' && kind !== 'wav') throw media(`${file}: not a tape (.cas or a .wav recording); it reads as ${kind}`);
    return this.record(step, { file, message: s.insertTape(name, bytes) });
  }
  async disk(step, { drive, file }, s) {
    const message = await s.drives.importImage(path.basename(file), readFile(file, 'disk image'), drive);
    return this.record(step, Object.assign({ file, drive, message }, diskNote(message)));
  }
  async type(step, { text, items }, s) {
    const m = this.m;
    for (const it of items) {
      if (typeof it === 'string') {
        const bad = s.untypable(it);
        if (bad.length) throw usage(`${step.where}: the ${m.profile.name} has no key for "${bad.join('')}"${m.useStub ? '' : ' (BASIC reads the keyboard matrix)'}`, 'untypable');
        continue;
      }
      if (!m.useStub && !m.keyPos[it.key]) throw usage(`${step.where}: the ${m.profile.name}'s keyboard has no ${it.key} key`, 'untypable');
    }
    // the stub firmware takes key codes (its POLCAT), BASIC reads the matrix: keys that are no character are pressed
    const STUB = { BREAK: 3, CLEAR: 12, LEFT: 8, RIGHT: 9, DOWN: 10, UP: 94 };
    // With a ROM the text is typed paced by what the machine consumes (the typing Claude's type_text does): a key is held until the
    // machine has read it, and nothing is pressed after an ENTER until it reads the keyboard again, so a line editor busy storing a
    // line drops no key of the next. (Unpaced, back-to-back numbered lines lost the first digit of the next line's number.) The
    // built-in firmware takes key codes from its own queue at its own pace, so those go in as they were.
    // (the characters between two keys that are no character go in as one job: a job ends without waiting for its last key to come up,
    // so two jobs back to back would press a repeated key, the second 0 of 200, before the machine has seen the first one go)
    const jobs = [];
    let run = '';
    const flush = () => {
      if (!run) return;
      if (m.useStub || s.refuseTyping(m)) s.typeText(run);
      else { s.personInput(m); jobs.push(s.typeTextPaced(run, m)); }
      run = '';
    };
    for (const it of items) {
      if (typeof it === 'string') { run += it; continue; }
      flush();
      if (m.useStub) m.stubKeys.push(STUB[it.key]);
      else m.typist.press(it.key);
    }
    flush();
    const secs = this.timeout, limit = this.framesFor(secs);
    let n = 0;
    while (m.typist.busy || m.stubKeys.length) {
      if (n >= limit) {
        const left = m.stubKeys.length + m.typist.queue.length;
        m.typist.clear(); m.stubKeys.length = 0;   // what was not taken is dropped, so a later step starts clean
        throw this.stalled('keys-not-taken', `${step.where}: the machine did not take the typed keys within ${secs} s (${left} left)`);
      }
      await this.frame(); n++;
    }
    // a paced job that ended without every key read (the machine stopped reading the keyboard, or was reset) is a step that failed
    const short = jobs.find((j) => j.status !== 'done');
    if (short) throw this.stalled('keys-not-taken', `${step.where}: the machine took ${short.consumed} of the ${short.requested} typed keys (${short.status})`);
    return this.record(step, { text, frames: n });
  }
  async frames(step, n) { return this.record(step, { frames: await this.runFrames(n) }); }
  async seconds(step, sec) { return this.record(step, { seconds: sec, frames: await this.runFrames(this.framesFor(sec)) }); }
  holds(c) {
    if (c.kind === 'text') { const t = this.screen(); return t.text && c.re.test(t.lines.join('\n')); }
    if (c.kind === 'mem') return this.s.readByte(c.address) === c.value;
    return this.m.cpu.pc === c.address;
  }
  async waitFor(step, c, s) {
    const secs = this.timeout, limit = this.framesFor(secs);
    const what = step.where.startsWith('--') ? `wait-for ${condText(c)}` : `${step.where}: wait-for ${condText(c)}`;
    let n = 0;
    if (c.kind === 'pc' && c.label) {
      const at = Emu.lookupSymbol(s.labels, c.label);
      if (at === undefined) throw usage(`${what}: no label ${c.label} (--asm and --symbols give the labels; ${s.labels ? `there are ${s.labels.size}` : 'none are loaded'})`);
      c = Object.assign({}, c, { address: at });
    }
    if (c.kind === 'pc') {
      // a breakpoint stops the machine at the instruction, not at the end of a frame
      const d = s.debug, had = d.breakpoints().includes(c.address);
      if (!had) d.addBreakpoint(c.address);
      try {
        while (this.m.cpu.pc !== c.address) {
          if (n >= limit) throw this.stalled('timeout', `${what} timed out after ${secs} s (the PC is ${Emu.hex(this.m.cpu.pc)})`);
          if (await this.frame()) { n++; continue; }
          if (d.stopReason && d.stopReason.kind === 'breakpoint' && this.m.cpu.pc === c.address) break;
          d.resume();
        }
      } finally {
        if (!had) d.removeBreakpoint(c.address);
        d.resume();
      }
    } else {
      while (!this.holds(c)) {
        if (n >= limit) throw this.stalled('timeout', `${what} timed out after ${secs} s`);
        await this.frame(); n++;
      }
    }
    return this.record(step, Object.assign({ condition: condText(c), frames: n, met: true }, c.label ? { address: c.address } : {}));
  }
  async expectScreen(step, re) {
    const t = this.screen();
    if (!t.text) throw this.failed('expect-failed', `${step.where}: no text on the screen to match ${re} (${t.reason})`);
    if (!re.test(t.lines.join('\n'))) throw this.failed('expect-failed', `${step.where}: the screen does not match ${re}`);
    return this.record(step, { pattern: String(re), met: true });
  }
  async expectMem(step, { address: a, value }, s) {
    const got = s.readByte(a);
    if (got !== value) throw this.failed('expect-failed', `${step.where}: ${Emu.hex(a)} holds ${Emu.hex(got, 2)}, not ${Emu.hex(value, 2)}`);
    return this.record(step, { address: a, value, met: true });
  }
  // the frame against a reference PNG, pixel for pixel (all four bytes of each)
  async expectScreenshot(step, { file }) {
    const ref = decodePng(readFile(file, 'reference PNG'), file);
    const frame = this.m.render(), w = frame.width, h = frame.height, got = frameRgba(frame);
    const r = { file, width: w, height: h, tolerance: this.tolerance };
    if (ref.width !== w || ref.height !== h) {
      throw this.failed('expect-failed', `${step.where}: the frame is ${w}x${h}, ${file} is ${ref.width}x${ref.height}`, { screenshot: Object.assign(r, { referenceWidth: ref.width, referenceHeight: ref.height }) });
    }
    const diff = this.diffFile ? Buffer.alloc(w * h * 4) : null;
    let differing = 0, first = null;
    for (let i = 0, o = 0; i < w * h; i++, o += 4) {
      const same = got[o] === ref.rgba[o] && got[o + 1] === ref.rgba[o + 1] && got[o + 2] === ref.rgba[o + 2] && got[o + 3] === ref.rgba[o + 3];
      if (!same) {
        differing++;
        if (!first) first = { x: i % w, y: Math.floor(i / w), expected: colourHex(ref.rgba, o), actual: colourHex(got, o) };
      }
      if (diff) {
        if (same) { diff[o] = got[o] / 3; diff[o + 1] = got[o + 1] / 3; diff[o + 2] = got[o + 2] / 3; } else diff[o] = 255;
        diff[o + 3] = 255;
      }
    }
    if (diff) { writeFile(this.diffFile, rgbaPng(w, h, diff)); r.diff = this.diffFile; }
    r.differing = differing;
    if (first) r.first = first;
    if (differing > this.tolerance) {
      const at = `first at (${first.x},${first.y}): expected ${first.expected}, got ${first.actual}`;
      throw this.failed('expect-failed', `${step.where}: ${differing} ${differing === 1 ? 'pixel differs' : 'pixels differ'} from ${file} (tolerance ${this.tolerance}); ${at}`, { screenshot: r });
    }
    return this.record(step, Object.assign(r, { met: true }));
  }
  // keys held down in the matrix (as a finger would) for some frames, then let go
  async hold(step, { keys, frames }) {
    const m = this.m, missing = keys.filter((k) => !m.keyPos[k]);
    if (missing.length) throw usage(`${step.where}: the ${m.profile.name}'s keyboard has no ${missing.join(', ')} key (names: ${Object.keys(m.keyPos).join(' ')})`, 'untypable');
    for (const k of keys) m.setKey(k, true);
    let ran;
    try { ran = await this.runFrames(frames); } finally { for (const k of keys) m.setKey(k, false); }
    return this.record(step, { keys, frames: ran });
  }
  // the --wav output stage: the page's AudioOutput without its DC-blocking filter, at WAV_SCALE; write(chunk) takes
  // each frame's samples. Its frames' sample counts come from a sampleClock at the machine's exact frame rate.
  soundOut(write) {
    const out = new Emu.AudioOutput(WAV_RATE, { buffered: () => 0, write }, { highPass: false });
    out.volume = WAV_SCALE / 32767;
    return { out, clock: Emu.sampleClock(WAV_RATE, Emu.frameRate(this.m.tickHz, this.m.frameCycles)) };
  }
  // start recording the sound (ending one under way): written by endWav, when the run ends
  async wavStep(step, { file }) {
    this.endWav();
    const chunks = [];
    const { out, clock } = this.soundOut((c) => chunks.push(c));
    const result = this.record(step, { file, rate: WAV_RATE, bits: 16, dacStep: WAV_SCALE / 63 });
    this.wav = { file, out, clock, chunks, result };
    return result;
  }
  async wavStop(step) {
    const w = this.wav;
    if (!w) throw usage(`${step.where}: no sound recording to stop (wav starts one)`);
    this.endWav();
    return this.record(step, { file: w.file, samples: w.result.samples });
  }
  endWav() {
    const w = this.wav;
    if (!w) return;
    this.wav = null;
    const n = w.chunks.reduce((a, c) => a + c.length, 0), samples = new Float32Array(n);
    let at = 0;
    for (const c of w.chunks) { samples.set(c, at); at += c.length; }
    writeFile(w.file, Emu.writeWav(samples, WAV_RATE));
    Object.assign(w.result, { samples: n, seconds: n / WAV_RATE });
  }
  // start recording the picture and sound (ending a recording under way): an AVI (record) or a directory of PNGs, a
  // WAV and an ffconcat list (record-dir), written by endRecord when the run ends, even when it fails
  async recordStep(step, { file, dir }) {
    this.endRecord();
    const m = this.m, rate = Emu.frameRate(m.tickHz, m.frameCycles);
    let pending = null;
    const { out, clock } = this.soundOut((c) => { pending = c; });
    const rec = { file, dir, out, clock, rate, take: () => { const c = pending; pending = null; return c; }, frames: 0, width: 0, height: 0, startFrame: m.frameCount };
    if (file) rec.avi = Emu.aviWriter({ rate, sampleRate: WAV_RATE, maxBytes: this.recordLimit });
    else {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { throw media(`${step.where}: cannot make ${dir}: ${e.code || e.message}`, 'cannot-write'); }
      rec.chunks = [];
    }
    rec.result = this.record(step, Object.assign(file ? { file } : { dir }, { fps: `${rate.num}/${rate.den}`, rate: WAV_RATE, bits: 16 }));
    this.rec = rec;
    return rec.result;
  }
  async recordStop(step) {
    const r = this.rec;
    if (!r) throw usage(`${step.where}: no recording to stop (record or record-dir starts one)`);
    this.endRecord();
    return this.record(step, Object.assign(r.file ? { file: r.file } : { dir: r.dir }, { frames: r.result.frames }));
  }
  // the frame just run, and its sound, into the recording
  recordFrame() {
    const r = this.rec, m = this.m;
    r.out.render(m.audioEvents, m.frameCycles, r.clock.next(), null);
    const samples = r.take() || new Float32Array(0), frame = m.render();
    if (!r.frames) { r.width = frame.width; r.height = frame.height; }
    else if (frame.width !== r.width || frame.height !== r.height) {
      throw media(`recording ${r.file || r.dir}: frame ${r.frames} of the recording (machine frame ${m.frameCount}) is ${frame.width}x${frame.height}, the frames before it ${r.width}x${r.height} (a mode or monitor change); record each part separately, with record-stop and a new record`, 'record-size-changed');
    }
    if (r.avi) {
      try { r.avi.addFrame(frame, Emu.pcm16(samples)); } catch (e) {
        if (e.code !== 'too-big') throw e;
        throw media(`recording ${r.file}: frame ${r.frames} would take it past the AVI 1.0 limit of 1 GiB (${this.recordLimit} bytes); record a long run with --record-dir DIR (PNGs, a WAV and an ffconcat list), or end this one sooner with --record-stop`, 'record-too-big');
      }
    } else {
      writeFile(path.join(r.dir, recordPng(r.frames)), framePng(frame));
      r.chunks.push(samples);
    }
    r.frames++;
  }
  // write the recording under way (if any): what it holds so far, even when the run failed part way
  endRecord() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    Object.assign(r.result, { frames: r.frames, width: r.width, height: r.height });
    if (r.avi) {
      if (!r.frames) throw usage(`recording ${r.file}: no frames ran while it recorded`);
      const bytes = r.avi.finish();
      writeFile(r.file, bytes);
      Object.assign(r.result, { size: bytes.length, samples: r.avi.samples });
      return;
    }
    const n = r.chunks.reduce((a, c) => a + c.length, 0), samples = new Float32Array(n);
    let at = 0;
    for (const c of r.chunks) { samples.set(c, at); at += c.length; }
    writeFile(path.join(r.dir, 'sound.wav'), Emu.writeWav(samples, WAV_RATE));
    writeFile(path.join(r.dir, 'frames.ffconcat'), ffconcat(r.frames, r.rate));
    Object.assign(r.result, { samples: n });
  }
  // trace the serial port (ending a trace under way): written by endSerialTrace, when the run ends
  async serialTraceStep(step, { file }) {
    this.start();
    this.endSerialTrace();
    const result = this.record(step, { file, limit: SERIAL_TRACE_LIMIT });
    this.serialTrace = { file, trace: this.s.serial.trace({ limit: SERIAL_TRACE_LIMIT }), result };
    return result;
  }
  endSerialTrace() {
    const t = this.serialTrace;
    if (!t) return;
    this.serialTrace = null;
    this.s.serial.flush();
    const events = t.trace.events;
    t.trace.stop();
    writeFile(t.file, Buffer.from(events.map((e) => JSON.stringify(e) + '\n').join('')));
    Object.assign(t.result, { events: events.length, dropped: t.trace.dropped });
  }
  // trace the disk controller (ending a trace under way): written by endDiskTrace, when the run ends
  async diskTraceStep(step, { file }) {
    this.start();
    this.endDiskTrace();
    const result = this.record(step, { file, limit: DISK_TRACE_LIMIT });
    this.diskTrace = { file, trace: this.s.disk.trace({ limit: DISK_TRACE_LIMIT }), result };
    return result;
  }
  endDiskTrace() {
    const t = this.diskTrace;
    if (!t) return;
    this.diskTrace = null;
    const events = t.trace.events;
    t.trace.stop();
    writeFile(t.file, Buffer.from(events.map((e) => JSON.stringify(e) + '\n').join('')));
    Object.assign(t.result, { events: events.length, dropped: t.trace.dropped });
  }
  // start a hot-spot profile (ending one under way): written by endProfile, at profile-stop or when the run ends
  async profileStep(step, { file, mode }, s) {
    this.endProfile();
    const p = s.profile({ mode });
    const result = this.record(step, { file, mode });
    this.prof = { file, p, result };
    return result;
  }
  async profileStop(step) {
    const pr = this.prof;
    if (!pr) throw usage(`${step.where}: no profile to stop (profile starts one)`);
    this.endProfile();
    const { total, halted, unattributed, rows } = pr.result;
    return this.record(step, { file: pr.file, mode: pr.result.mode, total, halted, unattributed, rows });
  }
  endProfile() {
    const pr = this.prof;
    if (!pr) return;
    this.prof = null;
    const r = pr.p.stop();
    writeFile(pr.file, this.json ? JSON.stringify(r, null, 2) : `${Emu.profileText(r)}\n`);
    Object.assign(pr.result, { total: r.total, halted: r.halted, unattributed: r.unattributed, rows: r.rows.length });
  }
  async screenStep(step) { return this.record(step, this.screen()); }
  async screenshot(step, { file }) {
    const frame = this.m.render();
    writeFile(file, framePng(frame));
    return this.record(step, { file, width: frame.width, height: frame.height });
  }
  async peek(step, { address: a, length }, s) {
    return this.record(step, { address: a, length, bytes: Array.from({ length }, (_, i) => s.readByte(a + i)) });
  }
  async poke(step, { address: a, bytes }, s) { return this.record(step, { address: a, bytes, landed: s.pokeBytes(a, bytes) }); }
  async registers(step, v, s) { return this.record(step, { cpu: this.m.config.cpu, registers: s.debug.registers() }); }
  async setRegister(step, { name, value }, s) {
    s.debug.setRegister(name, value);
    return this.record(step, { name, value: s.debug.registers()[name] });
  }
  async disasm(step, { address: a, count }, s) {
    const r = Emu.disassembleTool(s.chatTarget(), { address: a == null ? this.m.cpu.pc : a, count });
    // the session's labels (from --asm or --symbols): `label` on an instruction that has one, `targetLabel` where its operand points at one
    if (s.labels && s.labels.size) {
      const names = new Map();
      for (const [name, at] of s.labels) if (!names.has(at)) names.set(at, name);
      for (const i of r.instructions) {
        if (names.has(i.address)) i.label = names.get(i.address);
        if (i.target != null && names.has(i.target)) i.targetLabel = names.get(i.target);
      }
    }
    return this.record(step, r);
  }
  async stepInstructions(step, n, s) {
    const d = s.debug;
    let ran = 0, cycles = 0, stop = null;
    for (; ran < n; ran++) {
      const c = d.step();
      if (d.stopped && d.stopReason && d.stopReason.kind === 'halted') { stop = 'halted'; break; }
      cycles += c;
    }
    d.resume();
    return this.record(step, Object.assign({ instructions: ran, cycles, registers: d.registers() }, stop ? { stopped: stop } : {}));
  }
  async view(step, screen, s) {
    if (!s.hasTwoScreens) throw media(`${step.where}: the ${this.m.profile.name} has one screen; only the Dragon 64 Plus has a second (plus)`, 'rejected');
    s.setDisplay({ screen }, { remember: false });
    return this.record(step, { screen });
  }
  async resetStep(step, v, s) { s.reset(); return this.record(step, { machine: this.machineInfo() }); }
  async powerCycle(step, v, s) { s.powerCycle({ menu: false }); return this.record(step, { machine: this.machineInfo() }); }
  async saveSnapshot(step, file, s) {
    // SOURCE_DATE_EPOCH (seconds), the reproducible-builds convention, fixes the time the file records
    const epoch = process.env.SOURCE_DATE_EPOCH;
    const when = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
    const { bytes } = await s.snapshotFile(when);
    writeFile(file, bytes);
    return this.record(step, { file, size: bytes.length });
  }
  async info(step) { return this.record(step, this.machineInfo()); }
  machineInfo() {
    if (!this.s) return null;
    const m = this.m, config = {};
    for (const [k, v] of Object.entries(m.config)) if (m.profile.options[k]) config[k] = v;
    return { machine: m.id, name: m.profile.name, config, roms: m.hasRom, frame: m.frameCount, pc: m.cpu.pc };
  }
}
const STEP_METHODS = {
  'load-snapshot': 'loadSnapshot', program: 'program', load: 'load', asm: 'asm', symbols: 'symbols', cart: 'cart', tape: 'tape', disk: 'disk',
  type: 'type', frames: 'frames', seconds: 'seconds', 'wait-for': 'waitFor', 'expect-screen': 'expectScreen',
  'expect-mem': 'expectMem', 'expect-screenshot': 'expectScreenshot', hold: 'hold', wav: 'wavStep', 'wav-stop': 'wavStop', 'serial-trace': 'serialTraceStep', 'disk-trace': 'diskTraceStep', profile: 'profileStep', 'profile-stop': 'profileStop',
  record: 'recordStep', 'record-dir': 'recordStep', 'record-stop': 'recordStop', screen: 'screenStep', screenshot: 'screenshot', peek: 'peek', poke: 'poke',
  registers: 'registers', 'set-register': 'setRegister', disasm: 'disasm', step: 'stepInstructions', reset: 'resetStep',
  'power-cycle': 'powerCycle', view: 'view', 'save-snapshot': 'saveSnapshot', info: 'info',
};
// record-dir's files: frame k's PNG, and the ffconcat list that plays them at the exact frame rate. Frame k starts at
// k x den / num seconds; each duration is the difference of those starts rounded to the microsecond, so the list
// adds up to the run's length without drifting. The last file is listed twice (ffmpeg's concat demuxer ignores the
// last entry's duration otherwise).
const recordPng = (k) => `frame${String(k).padStart(5, '0')}.png`;
function ffconcat(frames, { num, den }) {
  const at = (k) => (BigInt(k) * BigInt(den) * 1000000n + BigInt(num) / 2n) / BigInt(num);   // microseconds, rounded
  const us = (d) => `${d / 1000000n}.${String(d % 1000000n).padStart(6, '0')}`;
  const lines = ['ffconcat version 1.0'];
  for (let k = 0; k < frames; k++) lines.push(`file ${recordPng(k)}`, `duration ${us(at(k + 1) - at(k))}`);
  if (frames) lines.push(`file ${recordPng(frames - 1)}`);
  return Buffer.from(lines.join('\n') + '\n');
}
const condText = (c) => (c.kind === 'text' ? `text:${c.source}` : c.kind === 'mem' ? `mem:${Emu.hex(c.address)}=${Emu.hex(c.value, 2)}` : c.label ? `pc:${c.label}` : `pc:${Emu.hex(c.address)}`);
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

// a step's result as the human output prints it (null: the step prints nothing)
// a disk mounted without a disk ROM (on the disk controller alone): the step's result carries the page's note, which
// the command line also prints to stderr (an added field: the JSON's schemaVersion is unchanged)
const diskNote = (message) => (typeof message === 'string' && message.endsWith(Emu.BARE_NOTE) ? { note: message } : {});
function humanText(r) {
  switch (r.step) {
    case 'screen': return r.text ? r.lines.join('\n') : `(no text on the screen: ${r.mode}: ${r.reason})`;
    case 'peek': {
      const lines = [];
      for (let i = 0; i < r.length; i += 16) lines.push(`${Emu.hex(r.address + i)}: ${r.bytes.slice(i, i + 16).map(hex2).join(' ')}`);
      return lines.join('\n');
    }
    case 'info': return `${r.name} (${r.machine}) ${Object.entries(r.config).map(([k, v]) => `${k}=${v}`).join(' ')} · ${r.roms ? 'your ROMs' : 'built-in firmware'} · frame ${r.frame} · PC ${Emu.hex(r.pc)}`;
    case 'registers': return regsText(r.registers);
    case 'step': return regsText(r.registers);
    case 'disasm': return r.instructions.map((i) => `${i.label ? `${i.label}:\n` : ''}${Emu.hex(i.address)}  ${i.bytes.padEnd(15)} ${i.text}${i.targetLabel ? `  ; ${i.targetLabel}` : ''}`).join('\n');
    default: return null;
  }
}
const regsText = (regs) => Object.entries(regs).map(([k, v]) => `${k.toUpperCase()}=${Emu.hex(v, REG_BYTES.includes(k) ? 2 : k === 'q' ? 8 : 4)}`).join(' ');

// ---------------- the interface, described ----------------
function describe() {
  return {
    name: 'cloadm',
    schemaVersion: SCHEMA_VERSION,
    description: 'Dragon 32/64/200, Tandy Color Computer 1/2/3 and MC-10 emulator, headless: run programs, type, wait for the screen, memory or PC, hold keys, read the screen as text, inspect and change memory and registers, save pictures and snapshots, compare the picture with a reference PNG, record the sound as a WAV, record picture and sound as an AVI. Emulated time only: the same inputs give the same results.',
    usage: ['node cli/cloadm.js [--json] [steps...]', 'node cli/cloadm.js [--json] --script FILE', 'node cli/cloadm.js --assemble FILE --out FILE [--cpu C] [--machine ID] [--format dragondos|decb|raw] [--map FILE] [--json]', 'node cli/cloadm.js --describe', 'node cli/cloadm.js --mcp | --serve [--roms PATH] [--media-root DIR] [--read-only] [--no-skills]'],
    modes: {
      'command line': 'steps as options, run in order; --json prints one object { ok, exit, machine, steps, roms?, error? }',
      assemble: '--assemble FILE --out FILE: assemble to a file and stop; no machine is built (--asm assembles and runs). --cpu or --machine gives the CPU; --format dragondos, decb or raw (default from --machine: Dragons dragondos, CoCos decb); --map FILE writes "NAME $ADDR" lines; --json prints { ok, exit, assemble: { source, cpu, machine, format, out, size, load, exec, segments, map } }',
      script: '--script FILE: one step per line, "name argument" (the rest of the line; one surrounding pair of double quotes is taken off), # comments',
      mcp: '--mcp: a Model Context Protocol server on stdio; its tools and their schemas come from tools/list (docs/mcp.md)',
      serve: '--serve: the MCP tools over JSON lines: { id, tool, arguments } in, { id, ok, result | error } out (docs/mcp.md)',
    },
    exitCodes: EXIT_TEXT,
    errorCodes: Object.fromEntries(Object.entries(ERROR_CODES).map(([c, [kind, text]]) => [c, { kind, exit: EXIT[kind], description: text }])),
    keys: KEY_NAMES,
    defaults: { machine: 'dragon64', timeoutSeconds: DEFAULT_TIMEOUT },
    steps: Object.entries(STEPS).map(([name, def]) => ({
      name, help: def.help,
      cli: `--${name}${def.arg ? ` ${def.optionalArg ? `[${def.arg}]` : def.arg}` : ''}`,
      arg: def.arg, argOptional: !!def.optionalArg, setup: !!def.setup, example: def.example,
    })),
  };
}
function helpText() {
  const rows = Object.entries(STEPS).map(([n, d]) => `  --${n}${d.arg ? ` ${d.optionalArg ? `[${d.arg}]` : d.arg}` : ''}`.padEnd(30) + d.help);
  return `cloadm: run a Dragon, Tandy CoCo or MC-10 headless, for CI and coding agents

Usage: node cli/cloadm.js [--json] [steps...]
       node cli/cloadm.js [--json] --script FILE
       node cli/cloadm.js --assemble FILE --out FILE [--cpu C] [--machine ID] [--format dragondos|decb|raw] [--map FILE] [--json]
       node cli/cloadm.js --describe
       node cli/cloadm.js --mcp | --serve [--roms PATH] [--media-root DIR] [--read-only] [--no-skills]

Steps run in the order given; machine, option, roms, no-roms and fast-cas come first.
${rows.join('\n')}
  --assemble FILE               assemble FILE to a binary and stop (builds no machine; --asm assembles and RUNS): needs --out FILE and
                                --cpu 6809|6309|6803|7000 or --machine ID; --format dragondos|decb|raw (default: Dragon dragondos,
                                CoCo decb; required without --machine); --map FILE writes "NAME $ADDR" lines for --symbols
  --script FILE                 read steps from FILE, one per line: "name argument" (# comments)
  --json                        print one JSON object with every step's result instead of text
  --describe                    the whole interface as JSON: steps, exit and error codes
  --mcp                         a Model Context Protocol server on stdio for coding agents (docs/mcp.md)
  --serve                       the same tools over JSON lines on stdin and stdout
  --list-machines               list the models and their options (with --json: as JSON)
  --help                        this text

Addresses and values are $hex, 0xhex or decimal. Time is emulated time; nothing depends on the wall clock.
Exit codes: 0 success, 1 a condition failed, 2 usage error, 3 media or ROM error, 4 internal error.
Guide: docs/automation.md`;
}
function machineList() {
  return Object.values(Emu.profiles).map((p) => ({
    id: p.id, name: p.name, cpu: p.options.cpu.values,
    options: Object.fromEntries(Object.entries(p.options).map(([k, o]) => [k, { values: o.values, default: o.default }])),
    roms: p.roms.map((r) => ({ id: r.id, label: r.label, required: r.required, files: r.files })),
  }));
}
const errorJson = (e) => Object.assign({ kind: e.kind, code: e.code, message: e.message }, e.errors ? { errors: e.errors } : {}, e.screenshot ? { screenshot: e.screenshot } : {}, e.machine ? { machine: e.machine, serial: e.serial, disk: e.disk } : {}, e.screen ? { screen: e.screen } : {});
// anything thrown -> a CliError (a bug becomes 'internal' with its stack)
const asCliError = (e) => (e instanceof CliError ? e : new CliError('internal', `internal error: ${e && e.stack || e}`));

// ---------------- --mcp and --serve ----------------
// node cli/cloadm.js --mcp|--serve [--roms PATH]... [--media-root DIR] [--read-only] [--no-skills]
// --no-skills: --mcp serves no agent skill (the plugin's own server: the plugin ships the skill itself)
// A value that says nothing: empty, or a placeholder a launcher did not fill in ("${user_config.roms}": plugin hosts
// pass unset settings through as written, or as "")
const unset = (v) => v === '' || /\$\{[^}]*\}/.test(v);
function parseServerArgs(argv) {
  const o = { mode: null, roms: [], mediaRoot: null, readOnly: false, skills: true };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    // --roms=VALUE or --roms VALUE; a value that says nothing counts as not given; --roms with nothing after it is an error
    const name = m && m[1], value = () => { const v = m[2] != null ? m[2] : argv[++i]; if (v == null) throw usage(`--${name} needs a path`); return unset(v) ? null : v; };
    if (name === 'mcp' || name === 'serve') { if (o.mode) throw usage('--mcp or --serve, not both'); o.mode = name; }
    else if (name === 'roms') { const v = value(); if (v) o.roms.push(v); }
    else if (name === 'media-root') { const v = value(); if (v) { if (o.mediaRoot) throw usage('one --media-root'); o.mediaRoot = v; } }
    else if (name === 'read-only') o.readOnly = true;
    else if (name === 'no-skills' && m[2] == null) o.skills = false;
    else throw usage(`--${o.mode || 'mcp'} takes --roms PATH, --media-root DIR, --read-only and --no-skills, not ${argv[i]}`, 'unknown-step');
  }
  return o;
}
// The server's settings file: %APPDATA%\cloadm\config.json on Windows, ~/.config/cloadm/config.json elsewhere
function configPath() {
  return process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'cloadm', 'config.json') : path.join(os.homedir(), '.config', 'cloadm', 'config.json');
}
// { roms: [path], mediaRoot: path | null } from the settings file (none: both unset). A path may be ~ or start with ~/ and is
// otherwise taken relative to the file's directory; empty values and unfilled placeholders count as unset.
function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { roms: [], mediaRoot: null };
    throw usage(`cannot read the config file ${file}: ${e.code || e.message}`, 'cannot-read');
  }
  let c;
  try { c = JSON.parse(text); } catch (e) { throw usage(`the config file ${file} is not valid JSON (${e.message})`); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw usage(`the config file ${file} must hold an object: { "roms": ["/path/to/roms"], "mediaRoot": "/path/to/project" }`);
  const extra = Object.keys(c).filter((k) => k !== 'roms' && k !== 'mediaRoot');
  if (extra.length) throw usage(`the config file ${file} has ${extra.map((k) => `"${k}"`).join(', ')}: it takes "roms" and "mediaRoot"`);
  const where = (v) => (v === '~' ? os.homedir() : v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : path.resolve(path.dirname(file), v));
  const roms = c.roms == null ? [] : typeof c.roms === 'string' ? [c.roms] : c.roms;
  if (!Array.isArray(roms) || roms.some((r) => typeof r !== 'string')) throw usage(`the config file ${file}: "roms" is a path or a list of paths`);
  if (c.mediaRoot != null && typeof c.mediaRoot !== 'string') throw usage(`the config file ${file}: "mediaRoot" is a path`);
  return { roms: roms.filter((r) => !unset(r)).map(where), mediaRoot: c.mediaRoot == null || unset(c.mediaRoot) ? null : where(c.mediaRoot) };
}
async function server(argv, { input, out, err }) {
  const o = parseServerArgs(argv);
  // each setting from the command line, else from the config file, else unset
  const file = configPath(), c = readConfig(file);
  const from = { roms: o.roms.length ? 'command line' : c.roms.length ? 'config file' : null, mediaRoot: o.mediaRoot ? 'command line' : c.mediaRoot ? 'config file' : 'default' };
  if (!o.roms.length) o.roms = c.roms;
  if (!o.mediaRoot) o.mediaRoot = c.mediaRoot;
  // neither: a folder the person can find, ~/CLOADM (%USERPROFILE%\CLOADM on Windows), made on the first write
  const createRoot = !o.mediaRoot;
  if (createRoot) o.mediaRoot = path.join(os.homedir(), 'CLOADM');
  // read once: the user's own files, never sent to a client; list_models says where each came from
  const roms = o.roms.flatMap(romFiles).map((f) => Object.assign(f, { source: from.roms === 'command line' ? 'cli' : 'config' }));
  // add_roms' store, next to the config file: merged with those at start-up (they win a socket both fill)
  const store = require('./rom-store.js').romStore(path.join(path.dirname(file), 'roms'), { warn: (t) => err(`cloadm ${o.mode}: ${t}`) });
  if (!createRoot) {
    let st;
    try { st = fs.statSync(o.mediaRoot); } catch (e) { throw media(`cannot read the media root ${o.mediaRoot}: ${e.code || e.message}`, 'cannot-read'); }
    if (!st.isDirectory()) throw media(`the media root ${o.mediaRoot} is not a directory`, 'cannot-read');
  }
  const M = require('./mcp.js');
  const T = require('../js/mcp/tools.js');
  const host = M.nodeHost({ mediaRoot: o.mediaRoot, createRoot, roms, png: framePng, configPath: file, romStore: store });
  const toolbox = T.createToolbox(host, { readOnly: o.readOnly });
  const kept = host.roms().length - roms.length;
  err(`cloadm ${o.mode}: ${toolbox.tools().length} tools${o.readOnly ? ' (read-only)' : ''}, ${roms.length} ROM file(s)${from.roms ? ` (${from.roms})` : ''}${kept ? `, ${kept} stored (${store.dir})` : ''}, media root ${createRoot ? o.mediaRoot : fs.realpathSync(o.mediaRoot)} (${from.mediaRoot}); config file ${file}`);
  if (o.mode !== 'mcp') return M.serve({ toolbox, input, out });
  // the agent skill, skills/cloadm/, served over MCP (js/mcp/skills.js) unless --no-skills
  const skills = o.skills ? require('../js/mcp/skills.js').createSkillServer(require('./skill-files.js').servedSkills()) : null;
  return M.mcp({ toolbox, input, out, skills });
}

// ---------------- assembling ----------------
// a source file -> the assembler's result (INCLUDEs are read from the source's own folder); an unreadable file or an assembly error is thrown
function assembleFile(file, cpu) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { throw media(`cannot read the source ${file}: ${e.code || e.message}`, 'cannot-read'); }
  const dir = path.dirname(file);
  const include = (n) => { const p = path.join(dir, n); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const res = Emu.assemble(src, cpu, { include });
  if (!res.ok) {
    const errors = res.errors.map((e) => ({ line: e.line || null, message: e.message || String(e) }));
    throw new CliError('bad-media', `${file}: ${errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('; ')}`, { errors });
  }
  return res;
}
// --assemble FILE --out FILE [--cpu C] [--machine ID] [--format F] [--map FILE] [--json]: assemble to a file and stop. No machine is built.
const ASSEMBLE_FORMATS = ['dragondos', 'decb', 'raw', 'cas', 'wav'];
const TAPE_FORMATS = ['cas', 'wav'];
function assembleOptions(argv) {
  const o = { json: false, square: false, source: null, cpu: null, machine: null, format: null, out: null, map: null, name: null };
  const names = ['assemble', 'cpu', 'machine', 'format', 'out', 'map', 'name'];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m) throw usage(`unexpected argument "${argv[i]}" (--assemble takes ${names.map((n) => `--${n}`).join(', ')}, --square and --json)`, 'unknown-step');
    if (m[1] === 'json' || m[1] === 'square') { if (m[2] != null) throw usage(`--${m[1]} takes nothing`); o[m[1]] = true; continue; }
    if (!names.includes(m[1])) throw usage(`--assemble builds no machine, so it takes ${names.map((n) => `--${n}`).join(', ')}, --square and --json, not --${m[1]}`, 'unknown-step');
    const value = m[2] != null ? m[2] : argv[++i];
    if (value == null || value === '') throw usage(`--${m[1]} needs ${m[1] === 'cpu' ? 'a CPU' : m[1] === 'machine' ? 'a model id' : m[1] === 'format' ? 'a format' : 'a file'}`);
    const key = m[1] === 'assemble' ? 'source' : m[1];
    if (o[key] != null) throw usage(`--${m[1]} given twice`);
    o[key] = value;
  }
  return o;
}
// the default name of a program on tape: the source's file name, up to 8 characters, upper case
const tapeName = (file) => path.basename(file).replace(/\.[^.]*$/, '').toUpperCase().replace(/[^ -~]/g, '').slice(0, 8) || 'PROGRAM';
function assembleRun(argv) {
  const o = assembleOptions(argv);
  if (!o.out) throw usage('--assemble needs --out FILE (where the binary goes)');
  let profile = null;
  if (o.machine != null) {
    profile = Emu.profiles[o.machine];
    if (!profile) throw usage(`no machine "${o.machine}" (--list-machines lists them)`, 'bad-option');
  }
  if (!profile && !o.cpu) throw usage('--assemble needs --cpu (6809, 6309, 6803 or 7000) or a --machine to take it from');
  if (!profile && !o.format) throw usage(`--assemble needs --format (${ASSEMBLE_FORMATS.join(', ')}) without a --machine to take it from`);
  if (o.format != null && !ASSEMBLE_FORMATS.includes(o.format)) throw usage(`--format is ${ASSEMBLE_FORMATS.join(', ')}, not "${o.format}"`);
  if (o.cpu != null && !Emu.cpuFamily(o.cpu)) throw usage(`--cpu is 6809, 6309, 6803 or 7000, not "${o.cpu}"`);
  if (profile && o.cpu != null && !profile.options.cpu.values.includes(o.cpu)) throw usage(`the ${profile.name} has a ${profile.options.cpu.values.join(' or ')}, not a ${o.cpu}`, 'bad-option');
  const cpu = o.cpu || profile.options.cpu.default;
  const format = o.format || Emu.binaryFormat(profile);
  // the MC-10 and Alice load .c10 tapes, not binary files: no binary format, with or without --format (a tape is another thing)
  const refusal = profile && Emu.binaryFormatRefusal(profile);
  if (refusal && !TAPE_FORMATS.includes(format)) throw usage(`${refusal} --format cas or wav writes a tape for it.`);
  const tape = TAPE_FORMATS.includes(format);
  if (!tape && o.name != null) throw usage('--name is the tape file\'s name: it goes with --format cas or wav');
  if (format !== 'wav' && o.square) throw usage('--square is the shape of a WAV\'s wave: it goes with --format wav');
  if (o.name != null && (o.name.length > 8 || ![...o.name].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7F))) throw usage(`--name is up to 8 printable ASCII characters, not "${o.name}"`);
  const res = assembleFile(o.source, cpu);
  if (!res.segments.some((g) => g.data.length)) throw media(`${o.source}: the program assembles to no bytes`);
  let bytes, tapeInfo = null;
  try {
    if (tape) {
      // a tape file is one contiguous range with its load and exec addresses (CLOADM and EXEC), as a DragonDOS file is
      const range = Emu.writeDragonDos(res.segments, res.exec), family = profile ? profile.lineage : cpu === '6803' ? 'mc10' : 'coco';
      const name = o.name != null ? o.name : tapeName(o.source), load = (range[2] << 8) | range[3];
      const cas = Emu.buildCas([{ name, type: 'binary', load, exec: res.exec, data: range.subarray(9) }], { family });
      const wave = o.square ? 'square' : 'sine';
      bytes = format === 'cas' ? cas : Emu.casToWav(cas, { family, wave, gaps: 'player' });
      tapeInfo = Object.assign({ name, family, cas: cas.length }, format === 'wav' ? { wave, sampleRate: 44100, seconds: Math.round((bytes.length - 44) / 2 / 44100 * 100) / 100 } : {});
    } else {
      bytes = format === 'decb' ? Emu.writeDecb(res.segments, res.exec)
        : format === 'dragondos' ? Emu.writeDragonDos(res.segments, res.exec)
          : Emu.writeDragonDos(res.segments, res.exec).subarray(9);
    }
  } catch (e) {
    if (!(e instanceof Emu.WriteError)) throw e;
    throw media(`${o.source}: ${e.message}${e.kind === 'gap' || e.kind === 'overlap' ? (tape ? '; a tape file holds one contiguous range' : '; use --format decb') : ''}`, 'bad-media');
  }
  writeFile(o.out, bytes);
  const symbols = [...res.symbols].filter(([, a]) => Number.isInteger(a) && a >= 0 && a <= 0xFFFF);
  if (o.map) writeFile(o.map, Emu.formatSymbols(res.symbols));
  const lo = Math.min(...res.segments.filter((g) => g.data.length).map((g) => g.addr));
  return {
    source: o.source, cpu, machine: o.machine, format, out: o.out, size: bytes.length, exec: res.exec, load: lo,
    segments: res.segments.map((g) => ({ address: g.addr, length: g.data.length })),
    map: o.map ? { file: o.map, symbols: symbols.length } : null,
    tape: tapeInfo,
    json: o.json,
  };
}

// ---------------- main ----------------
// recordLimit: the AVI size limit (tests set a small one to reach it quickly)
async function main(argv, { out = (t) => process.stdout.write(t + '\n'), err = (t) => process.stderr.write(t + '\n'), input = process.stdin, recordLimit = RECORD_LIMIT } = {}) {
  if (argv.includes('--mcp') || argv.includes('--serve')) {
    // stdout is the protocol's: an error starting the server goes to stderr only
    try { return await server(argv, { input, out, err }); } catch (e) { const error = asCliError(e); err(`cloadm: ${error.message}`); return EXIT[error.kind]; }
  }
  if (argv.some((a) => a === '--assemble' || a.startsWith('--assemble='))) {
    let json = argv.includes('--json');
    try {
      const r = assembleRun(argv);
      json = r.json;
      const result = { source: r.source, cpu: r.cpu, machine: r.machine, format: r.format, out: r.out, size: r.size, load: r.load, exec: r.exec, segments: r.segments, map: r.map, tape: r.tape };
      out(json ? JSON.stringify({ ok: true, exit: 0, assemble: result }, null, 2)
        : `${r.source}: ${r.cpu}, ${r.format}, ${r.size} bytes, load ${Emu.hex(r.load)}, exec ${Emu.hex(r.exec)}${r.tape ? `, tape ${r.tape.name} (${r.tape.family}${r.tape.seconds ? `, ${r.tape.seconds} s` : ''})` : ''} -> ${r.out}${r.map ? ` (${r.map.symbols} symbols -> ${r.map.file})` : ''}`);
      return 0;
    } catch (e) {
      const error = asCliError(e);
      if (json) out(JSON.stringify({ ok: false, exit: EXIT[error.kind], error: errorJson(error) }, null, 2));
      else err(`cloadm: ${error.message}`);
      return EXIT[error.kind];
    }
  }
  let opts = { json: argv.includes('--json') };
  const runner = new Runner();
  runner.recordLimit = recordLimit;
  const finish = (code, error = null) => {
    if (opts.json) {
      const o = { ok: code === 0, exit: code, machine: runner.machineInfo(), steps: runner.results };
      if (runner.romReport) o.roms = runner.romReport;
      if (error) o.error = errorJson(error);
      out(JSON.stringify(o, null, 2));
    } else if (error) {
      err(`cloadm: ${error.message}`);
      if (error.screen && error.screen.text) err(['screen:', ...error.screen.lines.map((l) => `  |${l}`)].join('\n'));
    }
    return code;
  };
  try {
    opts = parseArgs(argv);
    if (opts.help) { out(helpText()); return 0; }
    if (opts.describe) { out(JSON.stringify(describe(), null, 2)); return 0; }
    if (opts.listMachines) {
      const list = machineList();
      out(opts.json ? JSON.stringify(list, null, 2) : list.map((p) => `${p.id.padEnd(12)}${p.name.padEnd(28)}${Object.entries(p.options).map(([k, o]) => `${k}=${o.values.join('|')}`).join(' ')}`).join('\n'));
      return 0;
    }
    if (!opts.steps.length) throw usage('nothing to do: give steps (--help lists them)', 'no-steps');
    runner.json = opts.json;
    for (const step of opts.steps) {
      const r = await runner.run(step);
      const text = r && !opts.json ? humanText(r) : null;
      if (text != null) out(text);
      if (r && r.note && !opts.json) err(`cloadm: ${r.note}`);
    }
    runner.start();   // a command line of setup steps only still builds the machine (and checks the ROMs)
    runner.endWav();
    runner.endRecord();
    runner.endSerialTrace();
    runner.endDiskTrace();
    runner.endProfile();
    return finish(0);
  } catch (e) {
    try { runner.endWav(); } catch (e2) { /* the run already failed: its own error is the one reported */ }
    try { runner.endRecord(); } catch (e2) { /* likewise */ }
    try { runner.endSerialTrace(); } catch (e2) { /* likewise */ }
    try { runner.endDiskTrace(); } catch (e2) { /* likewise */ }
    try { runner.endProfile(); } catch (e2) { /* likewise */ }
    const error = asCliError(e);
    return finish(EXIT[error.kind], error);
  }
}

module.exports = { main, parseArgs, framePng, decodePng, describe, EXIT, ERROR_CODES, STEPS };
if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
