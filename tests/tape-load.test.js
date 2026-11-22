// A machine-code tape loaded through BASIC, as a dropped file is (Session.load): the machine is restarted first,
// CLOADM is typed, and EXEC is typed on a line of its own only if the program has not taken over. BASIC is our
// stand-in (tools/mame-diff/tape/standin.asm: CLOADM's half-second wait, its block loop and stack, the console-out
// hook, a line per ENTER); the tapes are built here, shaped like a commercial one that loads over BASIC's own RAM
// ($0150-$7FFF) and starts itself by replacing a return address on BASIC's stack.
const path = require('path');
const Emu = require('./load')();
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

const asm = assembleFile(path.join(__dirname, '../tools/mame-diff/tape/standin.asm'), '6809');
const slotsFor = (id) => {
  const p = Emu.profiles[id], base = Math.min(...p.roms.map((s) => s.at)), end = Math.max(...p.roms.map((s) => s.at + s.size));
  const img = romImage(asm, base, end - base, 0x12), slots = {};
  for (const sl of p.roms) slots[sl.id] = img.slice(sl.at - base, sl.at - base + sl.size);
  return slots;
};

// the tapes' start-up code at $4040: PMODE 4 (VDG A/G and GM 111, SAM V 110), "ST" at $4000, then stays there
const START = 0x4040;
const startCode = [0x1A, 0x50, 0x86, 0xF8, 0xB7, 0xFF, 0x22, 0xB7, 0xFF, 0xC0, 0xB7, 0xFF, 0xC3, 0xB7, 0xFF, 0xC5,
  0xCC, 0x53, 0x54, 0xFD, 0x40, 0x00, 0x20, 0xFE];
const block = (type, data) => { let s = (type + data.length) & 255; for (const d of data) s = (s + d) & 255; return [0x3C, type, data.length, ...data, s, 0x55]; };
function tape({ load, exec, data, gap = 128 }) {
  const nf = [...Buffer.from('TEST    '), 2, 0, 0, exec >> 8, exec & 255, load >> 8, load & 255];
  const out = [...new Array(128).fill(0x55), ...block(0, nf), ...new Array(gap).fill(0x55)];
  for (let i = 0; i < data.length; i += 255) out.push(...block(1, data.slice(i, i + 255)));
  out.push(...block(0xFF, []));
  return Uint8Array.from(out);
}
// $0150-$7FFF; every byte not given is $01 (an illegal opcode: a jump into it is a crash, not a start)
function image(load, end, set) {
  const data = new Array(end - load).fill(0x01);
  for (const [addr, bytes] of set) data.splice(addr - load, bytes.length, ...bytes);
  return data;
}
// starts itself: the top 512 bytes (BASIC's stack) are $40, so a return address taken from there is $4040. The
// first block holds a pattern of its own, so a load that missed it shows (every later block would put $01 there)
const pattern = Array.from({ length: 255 }, (_, i) => 0x80 | ((i * 13) & 0x7F));
const selfStarting = (gap, code = startCode) => tape({ load: 0x0150, exec: START, gap,
  data: image(0x0150, 0x8000, [[0x0150, pattern], [START, code], [0x7E00, new Array(0x200).fill(0x40)], [0x0167, [0x39]]]) });
// the same, but once started the program switches the cassette motor off and waits for a key in a ROM routine
// (the stand-in's ENTER), as a title screen's "press any key" may: the tape has stopped and the CPU sits in the
// ROM space, as BASIC at its prompt does
const ENTER = asm.symbols.get('ENTER');
const waitsInRom = [...startCode.slice(0, -2), 0x86, 0x34, 0xB7, 0xFF, 0x21, 0xBD, ENTER >> 8, ENTER & 255, 0x20, 0xFE];
// does not start itself and keeps BASIC working (the console-out hook is still RTS), but loads over its line
// buffer ($02DC): a person types EXEC afterwards, on a line of its own
const notSelfStarting = tape({ load: 0x0150, exec: START, data: image(0x0150, 0x7E00, [[START, startCode], [0x0167, [0x39]]]) });
const plain = tape({ load: 0x0E00, exec: 0x0E00, data: startCode });

function session(id) {
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  s.switchMachine(id, undefined, { menu: false });
  s.machine.setRoms(slotsFor(id)); s.machine.reset(true);
  return s;
}
// load as a drop does, recording every key the typist presses; run until the program's "ST" (or `seconds`)
function drop(s, bytes, seconds = 260) {
  const m = s.machine, keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  const msg = s.load('test.cas', bytes, { remember: false });
  let f = 0;
  for (; f < seconds * m.fps && !(m.ram[0x4000] === 0x53 && m.ram[0x4001] === 0x54); f++) m.runFrame();
  for (let i = 0; i < 2 * m.fps; i++) m.runFrame();     // and a while after: no key may follow
  return { msg, keys: keys.join(' '), started: m.ram[0x4000] === 0x53 && m.ram[0x4001] === 0x54, stage: String.fromCharCode(m.ram[0x80] || 0x2D), m };
}
const CLOADM = 'C L O A D M ENTER', EXEC = 'E X E C ENTER';

// ---------------- a plain machine-code tape ----------------
for (const id of ['dragon64', 'coco']) {
  const r = drop(session(id), plain, 30);
  check(`${id}: a plain tape ($0E00) starts: CLOADM, then EXEC on a line of its own`, r.started && r.stage === 'E' && r.keys === `${CLOADM} ${EXEC}`, `stage ${r.stage}; keys ${r.keys}`);
  check(`${id}: ...and the page says the machine was restarted`, /^Restarted for a clean load\. test\.cas: tape inserted \[TEST \(BINARY\)\] – loading via BASIC$/.test(r.msg), r.msg);
}

// ---------------- the load detector is one probe among others (Machine.addProbe) ----------------
// Two other probes on the machine - one the Session's own (s.hooks), one put on the machine directly - while the
// EXEC waits: the detector neither replaces them nor is replaced (EXEC still typed for a plain tape, still held back
// for one that starts itself), they see every step the machine makes, and the detector's probe goes once it decides.
for (const [what, bytes, keys] of [['a plain tape', plain, `${CLOADM} ${EXEC}`], ['a self-starting tape', selfStarting(128), CLOADM]]) {
  const s = session('dragon64'), m = s.machine;
  let a = 0, b = 0, most = 0;
  const ra = s.hooks.addProbe(() => a++), rb = m.addProbe(() => { b++; most = Math.max(most, m.probes.length); });
  const r = drop(s, bytes);
  check(`${what} with two other probes on the machine: ${keys === CLOADM ? 'no EXEC' : 'EXEC on its own line'}, the program starts`, r.started && r.keys === keys, `keys ${r.keys}`);
  check(`...the other probes ran all along, side by side with the detector (3 probes while it waited), which is gone now`,
    a > 100000 && a === b && most === 3 && m.probes.length === 2, `${a} ${b} most ${most} now ${m.probes.length}`);
  ra(); rb();
  check('...and with them off the slot is empty', m.pcWatch === null);
}

// ---------------- tapes that load over BASIC's RAM ----------------
{
  const r = drop(session('dragon64'), notSelfStarting);
  check('a tape over BASIC\'s line buffer that does not start itself: EXEC typed on its own line starts it', r.started && r.stage === 'E' && r.keys === `${CLOADM} ${EXEC}`, `stage ${r.stage}; keys ${r.keys}`);
}
{
  const r = drop(session('dragon64'), selfStarting(128));
  check('a self-starting tape starts (BLKIN returns into it), with no key typed after CLOADM', r.started && r.stage === 'C' && r.keys === CLOADM, `stage ${r.stage}; keys ${r.keys}; pc ${hex(r.m.cpu.pc)}`);
}
{
  // two leader bytes after the namefile: far shorter than CLOADM's wait after it starts the motor again, so the
  // first data block is found only because the tape is played as a recording sounds (js/media/tape.js): a second
  // of silence after the namefile and a full leader before the block (either alone would cover this wait)
  const bytes = selfStarting(2), r = drop(session('dragon64'), bytes);
  const first = Emu.formats.parseCas(bytes)[0].data.slice(0, 255);
  check('a tape with a short leader after its namefile: the first block lands at the load address', first.every((v, i) => r.m.ram[0x0150 + i] === v));
  check('...and the tape starts itself', r.started && r.keys === CLOADM, `stage ${r.stage}; keys ${r.keys}`);
}

{
  const r = drop(session('dragon64'), selfStarting(128, waitsInRom));
  check('a self-starting tape whose program stops the motor and waits for a key in ROM gets no keys either', r.started && r.keys === CLOADM && r.m.cpu.pc >= 0x8000 && !r.m.deck.motor, `keys ${r.keys}; pc ${hex(r.m.cpu.pc)}`);
}

// ---------------- the restart: the load starts from a machine just switched on ----------------
{
  // a program that crashed into a loop, with the stack somewhere else: without the restart nothing reads the keys
  const s = session('dragon64'), m = s.machine;
  for (let i = 0; i < 200; i++) m.runFrame();
  m.injectAndRun([{ addr: 0x3000, data: [0x10, 0xCE, 0x30, 0x00, 0x20, 0xFE] }], 0x3000);   // LDS #$3000; BRA *
  for (let i = 0; i < 10; i++) m.runFrame();
  check('(set-up: the machine is stuck in a program at $3000)', m.cpu.pc >= 0x3000 && m.cpu.pc < 0x3006 && m.cpu.s === 0x3000, hex(m.cpu.pc));
  const r = drop(s, selfStarting(128));
  const clean = drop(session('dragon64'), selfStarting(128));
  check('after a crashed program, the dropped tape still starts itself', r.started && r.keys === CLOADM, `stage ${r.stage}; keys ${r.keys}`);
  check('...from the state after a reset: the same stack as on a machine just switched on', r.m.cpu.s === clean.m.cpu.s, `${hex(r.m.cpu.s)} vs ${hex(clean.m.cpu.s)}`);
  check('...with the deck holding the tape, played to its end', r.m.deck.tape && r.m.deck.tape.atEnd());
}

// ---------------- a load's EXEC is for that load only ----------------
// Something else started while the EXEC still waits (a second file dropped, a reset, a restore point) cancels it:
// otherwise "EXEC" would be typed into whatever runs next.
const pending = (m) => m.typist.queue.some((it) => it && it.decide) || m.pcWatch !== null;
{
  // (a) a raw program dropped while the tape (the long one, $0150-$7DFF) loads, put above what the tape loads; it
  // switches the motor off and waits for a key in ROM, as BASIC at its prompt would
  const s = session('dragon64'), m = s.machine;
  drop(s, notSelfStarting, 0);                                   // the tape is in, CLOADM typed, EXEC waiting
  for (let i = 0; i < 100; i++) m.runFrame();
  const waiting = pending(m) && m.deck.motor;
  const keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  const raw = [0x86, 0x34, 0xB7, 0xFF, 0x21, 0xBD, ENTER >> 8, ENTER & 255, 0x20, 0xFE];   // motor off; JSR ENTER; BRA *
  s.load('prog.bin', Uint8Array.from(raw), { remember: false, askAddresses: () => ({ load: 0x7E80, exec: 0x7E80 }) });
  for (let i = 0; i < 10 * m.fps; i++) m.runFrame();
  check('a program dropped while a tape loads: the tape\'s EXEC is dropped, nothing is typed into the program',
    waiting && !pending(m) && keys.length === 0 && m.cpu.pc >= 0x8000 && !m.deck.motor, `keys ${keys.join(' ')}; pc ${hex(m.cpu.pc)}`);
}
{
  // (b) a BASIC listing dropped while the tape loads: only the listing's own keys are typed
  const s = session('dragon64'), m = s.machine;
  drop(s, notSelfStarting, 0);
  for (let i = 0; i < 100; i++) m.runFrame();
  const keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  s.load('hello.bas', Uint8Array.from(Buffer.from('10 PRINT 1\r')), { remember: false });
  for (let i = 0; i < 200 * m.fps && !m.deck.tape.atEnd(); i++) m.runFrame();
  for (let i = 0; i < 10 * m.fps; i++) m.runFrame();
  const typed = keys.join(' ');
  check('a listing dropped while a tape loads: the listing is typed, and no EXEC after it or before it',
    !pending(m) && /^N E W ENTER 1 0 SPACE P R I N T SPACE 1 ENTER R U N ENTER$/.test(typed), typed);
}
{
  // a reset while the EXEC waits
  const s = session('dragon64'), m = s.machine;
  drop(s, notSelfStarting, 0);
  const before = pending(m);
  m.reset(true);
  check('a reset while the EXEC waits drops it and its watch on the program', before && m.pcWatch === null && !pending(m));
}
{
  // a Claude restore point put back while the EXEC waits
  const s = session('dragon64'), m = s.machine;
  for (let i = 0; i < 3 * m.fps; i++) m.runFrame();
  const point = m.snapshot();
  drop(s, notSelfStarting, 0);
  for (let i = 0; i < 100; i++) m.runFrame();
  const before = pending(m);
  const keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  s.restorePoint(m, point);
  for (let i = 0; i < 10 * m.fps; i++) m.runFrame();
  check('a restore point put back while the EXEC waits drops it: nothing is typed into the restored machine', before && !pending(m) && keys.length === 0, keys.join(' '));
}

// ---------------- running without ROMs while ROMs are stored ----------------
// The welcome menu, LIZA, the demo and "Run without ROMs" take the machine's ROMs out for the rest of the page's
// session. A tape dropped then goes through BASIC with the ROMs stored for the machine (here the stand-in, stored
// as the Dragon 64's ROM files), not into memory on the stub, which has no BASIC for a program to call.
const fs = require('fs');
function storedSession(id) {
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  s.switchMachine(id, undefined, { menu: false });
  const slots = slotsFor(id);
  s.addRoms(Emu.profiles[id].roms.map((sl) => ({ name: sl.files[0], bytes: slots[sl.id] })));
  return s;
}
for (const [how, toStub] of [
  ['"Run without ROMs"', (s) => s.runWithoutRoms({ menu: false })],
  ['the welcome menu', (s) => s.startWelcome(new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples', s.welcomeFile))), { greeting: 'back' })],
]) {
  const s = storedSession('dragon64');
  const bootable = s.machine.hasRom;
  toStub(s);
  const stub = s.machine.useStub && s.stubChosen.has('dragon64');
  const r = drop(s, plain, 30);
  check(`after ${how}, a dropped tape uses the stored ROMs again and loads through BASIC, and the page says so`,
    bootable && stub && r.m.hasRom && !s.stubChosen.has('dragon64') && r.started && r.stage === 'E' && r.keys === `${CLOADM} ${EXEC}`
    && /^Using your ROMs again to load test\.cas through BASIC\. Restarted for a clean load\. test\.cas: tape inserted/.test(r.msg), `${r.msg} | stage ${r.stage}; keys ${r.keys}`);
}
{
  // "Load .CAS straight into memory" is still that: into memory, on the stub
  const s = storedSession('dragon64');
  s.runWithoutRoms({ menu: false });
  s.fastCas = true;
  const r = drop(s, plain, 5);
  check('...but with "Load .CAS straight into memory" ticked it still goes straight into memory', r.m.useStub && /fast-loaded/.test(r.msg) && r.started, r.msg);
}
{
  // no ROMs stored: as before, into memory on the stub
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  const r = drop(s, plain, 5);
  check('no ROMs stored: a dropped tape goes into memory on the stub, as before', r.m.useStub && /test\.cas: TEST fast-loaded \$0E00-\$0E17, exec \$0E00/.test(r.msg) && r.started, r.msg);
}

{
  // stored ROMs that do not start BASIC (here every byte $12): nothing is typed into a dead machine; it goes back to
  // running without ROMs and the tape goes into memory there, as before, saying so
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  s.addRoms(Emu.profiles.dragon64.roms.map((sl) => ({ name: sl.files[0], bytes: new Uint8Array(sl.size).fill(0x12) })));
  s.runWithoutRoms({ menu: false });
  const r = drop(s, plain, 5);
  check('stored ROMs that do not start BASIC: back to no ROMs, the tape straight into memory, and the page says why',
    r.m.useStub && s.stubChosen.has('dragon64') && r.started && r.keys === ''
    && /^Your stored ROMs did not start BASIC, so test\.cas went straight into memory\. test\.cas: TEST fast-loaded/.test(r.msg), `${r.msg} | keys ${r.keys}`);
}
{
  // the Claude chat machine (the same model, on the chat firmware, no ROMs): a tape dropped on it does not take the
  // stored ROMs, and the BASIC session's own no-ROM choice is left as it was
  const s = storedSession('dragon64');
  s.runWithoutRoms({ menu: false });
  const basic = s.machine;
  s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'k' }), channel: new Emu.MemoryChannel(),
    firmware: new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin'))), tools: false });
  const chat = s.machine;
  const msg = s.load('test.cas', plain, { remember: false });
  check('a tape dropped on the chat machine does not use the stored ROMs, and the BASIC session stays without them',
    chat !== basic && chat.useStub && basic.useStub && s.stubChosen.has('dragon64') && !/Using your ROMs again/.test(msg), msg);
}
{
  // what cancels a load's typing keeps Claude's: a paced job queued before it is still typed
  const s = session('dragon64'), m = s.machine;
  for (let i = 0; i < 3 * m.fps; i++) m.runFrame();     // the stand-in waits for ENTER, reading column 0
  const keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  const job = m.typist.typePaced('X');                 // X is in column 0, which the stand-in reads
  m.typist.type('Q');
  m.typist.typeWhen(() => 'wait', 'EXEC\r');
  s.cancelLoadTyping(m);
  for (let i = 0; i < 2 * m.fps; i++) m.runFrame();
  check('a load\'s typing cancelled: a paced (Claude) job queued before it is still typed; the rest is not', job.status === 'done' && keys.join(' ') === 'X', `${job.status}; keys ${keys.join(' ')}`);
}

// ---------------- typeWhen: typed when the machine says so, or never ----------------
{
  const m = Emu.createMachine('dragon64'); m.reset(true);
  const keys = [], set = m.setKey.bind(m);
  m.setKey = (k, down) => { if (down) keys.push(k); return set(k, down); };
  let asked = 0;
  m.typist.typeWhen(() => (++asked < 5 ? 'wait' : 'type'), 'AB');
  for (let i = 0; i < 40; i++) m.runFrame();
  check('typeWhen: nothing typed while it waits, the text once it says type', asked === 5 && keys.join('') === 'AB', `asked ${asked}, keys ${keys.join('')}`);
  keys.length = 0; asked = 0;
  m.typist.typeWhen(() => (++asked < 3 ? 'wait' : 'drop'), 'CD');
  m.typist.type('E');
  for (let i = 0; i < 40; i++) m.runFrame();
  check('typeWhen: dropped, its text is never typed and what follows is', asked === 3 && keys.join('') === 'E', `keys ${keys.join('')}`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
