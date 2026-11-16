// Session (DOM-free front end): machine switching with remembered options, ROMs on the machine in use,
// program loading of each kind, ROM-less errors and real-time pacing.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, cls = Error) => { try { fn(); return false; } catch (e) { return e instanceof cls; } };

const store = new Map();
const kv = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), keys: () => [...store.keys()] };
const s = new Emu.Session({ store: kv });
let events = 0;
s.on((e) => { if (e === 'machine') events++; });

s.switchMachine('coco3', { ram: 128 });
check('switchMachine builds the model with the given options', s.machine.id === 'coco3' && s.machine.config.ram === 128 && events === 1);
s.switchMachine('dragon64');
s.switchMachine('coco3');
check('options are remembered per model', s.machine.config.ram === 128);
check('last machine is remembered', new Emu.Session({ store: kv }).startMachine === 'coco3');
check('unknown model falls back to the Dragon 64', s.switchMachine('nope').id === 'dragon64');

// ROMs (identification across machines is covered in tests/roms.test.js): an unknown 16K file fits the
// machine in use by size; a file that fits nowhere is reported, not thrown; clearRoms forgets them
const fake = new Uint8Array(0x4000).fill(0x12);
const added = s.addRoms([{ name: 'x.rom', bytes: fake }]);
check('ROM by size goes to a socket of the machine in use', added.files[0].result === 'loaded-unrecognised' && !!s.machine.roms.basic, added.files[0].message);
check('ROM of no socket size is reported', s.addRoms([{ name: 'y.rom', bytes: new Uint8Array(4096) }]).files[0].result === 'rejected');
s.clearRoms();
check('clearRoms empties the sockets and the store', !s.machine.hasRom && ![...store.keys()].some((k) => k.startsWith('rom')));

// loading without ROMs
const prog = Emu.assemble(' ORG $3000\n LDA #$41\n STA $0400\nL BRA L\n END', '6809');
const bin = Emu.toBinary(prog);
check('binary loads and runs on the stub', /DragonDOS|binary/i.test(s.load('t.bin', bin)) && (() => { s.machine.runFrame(); return s.machine.ram[0x400] === 0x41; })());
check('BASIC listing needs a ROM', throws(() => s.load('p.bas', new TextEncoder().encode('10 PRINT "HI"\n')), Emu.SessionError));
check('raw data needs addresses', throws(() => s.load('raw.dat', new Uint8Array([1, 2, 3])), Emu.SessionError));
check('raw data with addresses loads', /raw/.test(s.load('raw.dat', new Uint8Array([7, 8, 9]), { askAddresses: () => ({ load: 0x2000, exec: null }) })) && s.machine.ram[0x2001] === 8);
s.switchMachine('mc10');
check('cartridge refused on the MC-10 (no port)', throws(() => s.load('c.ccc', new Uint8Array(0x2000).fill(0x39)), Emu.SessionError));
s.switchMachine('dragon64');
check('cartridge autostarts on the stub at $C000', /\$C000/.test(s.load('game.ccc', new Uint8Array(0x2000).fill(0x12))));
check('tape insert', /inserted/.test(s.insertTape('t.cas', new Uint8Array(64).fill(0x55))) && s.rewindTape());
// inserting a tape must announce itself: the drawer used to refresh on a 500 ms poll, and now refreshes on
// this event, so without it a freshly inserted tape would not appear until something else fired
{
  const events = [];
  s.on((ev) => events.push(ev));
  s.insertTape('announce.cas', new Uint8Array(64).fill(0x55));
  check('inserting a tape emits the tape event', events.includes('tape'), `(${events.join(',')})`);
  check('and it is what makes the deck show the tape', !!s.machine.deck.tape && s.machine.deck.tape.name === 'announce.cas');
}

// a power cycle keeps what is inserted (as on real hardware, only RAM and the CPU
// start over): the cartridge stays in its port, the tape in the deck where it was, the machine starts again
{
  const t = s.machine.deck.tape;
  t.seekByte(20);
  const at = [t.idx, t.left];                      // (the motor is off, so the frames below don't move it)
  const cart = s.machine.cartPort;
  for (let f = 0; f < 30; f++) s.machine.runFrame();
  s.powerCycle();
  check('power cycle: the cartridge stays in its port', !!cart && s.machine.cartPort === cart);
  check('power cycle: the tape stays in the deck, where it was', s.machine.deck.tape === t && t.idx === at[0] && t.left === at[1] && t.idx > 0, `at ${t.idx}`);
  check('power cycle: the machine starts again', s.machine.framesSinceReset === 0);
}
// adding ROMs power cycles the machine in use: an inserted tape stays (it used to be ejected)
{
  const r = new Emu.Session();
  r.switchMachine('dragon32');
  r.insertTape('t.cas', new Uint8Array(64).fill(0x55));
  r.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
  check('adding a ROM keeps the tape in the deck', r.machine.hasRom && !!r.machine.deck.tape && r.machine.deck.tape.name === 't.cas');
}

// pacing: 100 ms of real time runs 5 PAL frames (20 ms each); turbo runs flat out
s.powerCycle();
const n1 = s.advance(100);
check('advance paces frames to real time', n1 === 4 || n1 === 5, `(${n1} frames)`);
s.turbo = true;
let t = 0;
const n2 = s.advance(16, { now: () => (t += 1) });
check('turbo runs frames flat out within the time budget', n2 > 5, `(${n2} frames)`);
check('status line', /^Dragon 64 · \d+ fps/.test(s.statusLine(50)), s.statusLine(50));
s.turbo = false;
// a reset or power cycle drops the frames still owed to real time: no burst of catch-up frames (and sound) after it
{
  const fms = 1000 / s.machine.fps, seen = [];
  s.on((e) => seen.push(e));
  for (const [what, act] of [['reset', () => s.reset()], ['power cycle', () => s.powerCycle()]]) {
    s.advance(fms * 6.5);                 // a slow tick: 4 frames run, 2.5 or more still owed
    act();
    const n = s.advance(fms + 0.01);
    check(`after a ${what} the next frame time runs one frame`, n === 1, `(${n} frames)`);
  }
  check("reset emits 'reset', a power cycle 'firmware'", seen.includes('reset') && seen.includes('firmware'), seen.join());
}

// visits and recent media: the settings store and the media store are both shared, as one browser's
// would be between visits
{
  const st = Emu.memoryStore();
  const media = new Emu.MemoryMediaStore();
  const v = new Emu.Session({ store: st, media });
  const first = v.visit();
  check('first visit, nothing chosen or recent', first.first && !first.machineChosen && first.recent.length === 0);
  v.switchMachine('dragon64');
  const prog = Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809'));
  v.load('loop.bin', prog);
  v.load('loop.bin', prog);   // loading again moves it to the front, no duplicate
  v.load('quiet.bin', prog.slice(), { remember: false });
  v.chooseMachine('coco');
  const again = new Emu.Session({ store: st, media }).visit();
  check('return visit: not first, machine chosen, recent list kept', !again.first && again.machineChosen && again.recent.length === 1 && again.recent[0].name === 'loop.bin' && again.recent[0].machine === 'dragon64');
  const w = new Emu.Session({ store: st, media });
  w.switchMachine(w.startMachine);
  check('return visit: the last machine is restored', w.machine.id === 'coco');
  check('loadRecent loads the item on the machine it was loaded on', /loop\.bin/.test(w.loadRecent(0)) && w.machine.id === 'dragon64' && w.machine.cpu.pc === 0x3000);
  for (let i = 0; i < 7; i++) w.load(`p${i}.bin`, Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${i}\n END`, '6809')));
  check('recent list keeps the last 5, and only their files', w.recentMedia().length === 5 && media.snapshot().filter((f) => f.name.startsWith('recent/') && f.name.endsWith('.bin')).length === 5);
  const exp = JSON.stringify(w.exportSettings());
  check('settings export holds no stored media files', !/"media\./.test(exp) && !/recent\/|roms\//.test(exp));
}

// SAM CPU rate and the POKE book: on the stub firmware (no ROMs) the POKE lines are carried out, entries that
// need BASIC are not ready; typing a POKE changes the SAM rate and the session reports it with a 'rate' event
{
  const p = new Emu.Session({ store: { get: () => null, set() {}, remove() {}, keys: () => [] } });
  let rates = 0;
  p.on((e) => { if (e === 'rate') rates++; });
  p.switchMachine('dragon64');
  p.runWithoutRoms();
  const book = p.pokeBook();
  check('POKE book on the Dragon 64: six entries, EXEC and PEEK need BASIC', book.length === 6 &&
    book.filter((b) => !b.ready).map((b) => b.text).join() === 'EXEC,?PEEK(25)*256+PEEK(26)', book.map((b) => b.text).join(' | '));
  check('rate entries name the SAM bit they set or clear; the others none',
    book.map((b) => ('bit' in b ? `R${b.bit}${b.set ? '+' : '-'}` : '.')).join(' ') === 'R0+ R0- R1+ R1- . .', JSON.stringify(book));
  check('typing an entry that needs BASIC on the stub is refused', throws(() => p.typePoke(4), Emu.SessionError));
  check('CPU rate label at power-on', p.cpuRate().label === '0.89 MHz', p.cpuRate().label);
  const run = (frames) => { for (let i = 0; i < frames; i++) p.advance(20); };
  run(10);
  const steps = () => { const m = p.machine; let n = 0; m.cpu.trace = () => n++; m.runFrame(); m.cpu.trace = null; return n; };
  const slowSteps = steps();
  const expect = [[0, 1, 'address-dependent (0.89 / 1.78 MHz)'], [1, 0, '0.89 MHz'], [2, 2, '1.78 MHz'], [3, 0, '0.89 MHz']];
  for (const [i, rate, label] of expect) {
    const before = rates;
    p.typePoke(i);
    run(40);
    check(`${p.pokeBook()[i].text}: rate ${rate}, '${label}', one 'rate' event`, p.cpuRate().rate === rate && p.cpuRate().label === label && rates === before + 1, p.cpuRate().label);
    if (rate === 1) check('rate 01: the stub idle loop (in ROM) runs more instructions per frame', steps() > slowSteps * 1.4, `${slowSteps} -> ${steps()}`);
  }
  check('back at rate 00: the same instructions per frame', Math.abs(steps() - slowSteps) <= 1);
  check('the stub answered each POKE with OK', p.screenText().filter((l) => l.trim() === 'OK').length === 4);
  p.switchMachine('coco3');
  check('no POKE book or SAM rate on the CoCo 3', p.pokeBook().length === 0 && p.cpuRate() === null);
  p.switchMachine('coco');
  check('CoCo 1/2: no EXEC entry (no ROM banks); 0.89 MHz', p.pokeBook().length === 5 && p.cpuRate().label === '0.89 MHz');
}

// the user's media: the library (library/) and the floppy disk images (disks/, where the drives find them)
const userMedia = (async () => {
  const fsx = require('fs'), pathx = require('path');
  const u = new Emu.Session({ store: Emu.memoryStore() });
  const dsk = new Uint8Array(fsx.readFileSync(pathx.join(__dirname, 'fixtures/disks/rsdos.dsk')));
  const bin = new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]);
  await u.importMedia('UTILS.DSK', dsk);
  await u.importMedia('HELLO.BIN', bin);
  const names = (await u.listMedia()).map((x) => x.name).join();
  check('media: a disk image is stored under disks/, a program under library/; both listed, sorted', names === 'disks/UTILS.DSK,library/HELLO.BIN', names);
  check('media: a disk image opens by its name', (await u.openMedia('disks/UTILS.DSK')).length === dsk.length);
  await u.renameMedia('disks/UTILS.DSK', 'TOOLS.DSK');
  const renamed = (await u.listMedia()).map((x) => x.name).join();
  const across = await u.renameMedia('disks/TOOLS.DSK', 'library/TOOLS.DSK').then(() => null, (e) => e);
  const climb = await u.openMedia('disks/../roms/x.rom').then(() => null, (e) => e);
  check('media: a rename keeps a disk under disks/; moving it to library/ or climbing out is refused', renamed === 'disks/TOOLS.DSK,library/HELLO.BIN'
    && across instanceof Emu.SessionError && climb instanceof Emu.SessionError, renamed);
  await u.deleteMedia('disks/TOOLS.DSK');
  check('media: a disk image can be deleted', (await u.listMedia()).map((x) => x.name).join() === 'library/HELLO.BIN');
  // a disk in a drive is the drive's: no rename, delete or replace while it is in (a synthetic RS-DOS cartridge ROM:
  // a mount only needs one stored)
  u.switchMachine('coco');
  u.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
  await u.importMedia('WORK.DSK', dsk);
  await u.mountDisk(1, 'disks/WORK.DSK');
  const refuse = async (p) => p.then(() => null, (e) => e);
  const ren = await refuse(u.renameMedia('disks/WORK.DSK', 'OTHER.DSK'));
  const del = await refuse(u.deleteMedia('disks/WORK.DSK'));
  const rep = await refuse(u.importMedia('WORK.DSK', dsk));
  check('media: a disk in a drive is not renamed, deleted or replaced, and says which drive holds it',
    [ren, del, rep].every((e) => e instanceof Emu.SessionError) && /WORK\.DSK is in drive 1; eject it before you rename it/.test(ren.message)
    && /before you delete it/.test(del.message) && /before you replace it/.test(rep.message)
    && (await u.listMedia()).map((x) => x.name).join() === 'disks/WORK.DSK,library/HELLO.BIN', `${ren && ren.message} | ${del && del.message}`);
  await u.ejectDisk(1);
  await u.renameMedia('disks/WORK.DSK', 'WORK2.DSK');
  check('media: once ejected it can be renamed', (await u.listMedia()).map((x) => x.name).join() === 'disks/WORK2.DSK,library/HELLO.BIN');
})();

// type-in listings: what the Library's line check reports before typing
{
  const c = Emu.checkListing;
  check('listing check: a clean listing (blank lines and CRLF allowed) has no problems', c('100 CLS\r\n\r\n110 PRINT "HI"\n 120 GOTO 110\n').length === 0);
  check('listing check: a line without a number', c('10 CLS\nPRINT "X"').join() === 'line 2 has no line number');
  check('listing check: numbers out of order and repeated', c('20 A=1\n10 B=2\n10 C=3').join('; ') === '10 comes after 20; 10 comes after 10');
  check('listing check: past 63999', c('64000 END').join() === '64000 is past the last line number BASIC takes (63999)');
}

// the cassette panel: tapeStatus counts blocks, times the tape, watches the motor for ?IO ERROR;
// skipTape loads what is on the tape instantly. The .CAS is built here from the block format, and the expected
// length is worked out from the bit timing (one cycle per bit, 1200 Hz for 0 and 2400 Hz for 1), not read back.
{
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const name = [...Buffer.from('PANEL   '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00];       // machine code, load and exec $3000
  const code = Array.from({ length: 200 }, (_, i) => (i * 7) & 0xFF);
  const cas = new Uint8Array([...Array(128).fill(0x55), ...block(0, name), ...Array(128).fill(0x55),
    ...block(1, code.slice(0, 100)), ...block(1, code.slice(100)), ...block(0xFF, [])]);
  const t = new Emu.Session({ store: Emu.memoryStore() });
  t.switchMachine('dragon64');
  check('tape panel: no tape, no status', t.tapeStatus() === null);
  t.insertTape('panel.cas', cas);
  const m = t.machine, st0 = t.tapeStatus();
  const tick = m.tickHz, half = (f) => Math.round(tick / f / 2);
  let ticks = 0;
  for (const byte of [...Array(128).fill(0x55), ...cas]) for (let bit = 0; bit < 8; bit++) ticks += 2 * half((byte >> bit) & 1 ? 2400 : 1200);
  check('tape panel: a new tape: block 0 of 4, at the start, its length from the bit timing, motor off, no error',
    st0.name === 'panel.cas' && st0.blocks === 4 && st0.block === 0 && st0.progress === 0 && Math.abs(st0.duration - ticks / tick) < 1e-9
    && !st0.motor && st0.error === null && st0.realSpeed === false, JSON.stringify(st0));
  m.deck.setMotor(true);
  const seen = new Set();
  for (let f = 0; f < 400 && !m.deck.tape.atEnd(); f++) { m.runFrame(); m.deck.setMotor(true); seen.add(t.tapeStatus().block); }
  const end = t.tapeStatus();
  check('tape panel: played through, the block count passes 1, 2, 3, 4 and the counter reaches the length',
    [1, 2, 3, 4].every((b) => seen.has(b)) && end.block === 4 && end.progress === 1 && Math.abs(end.seconds - end.duration) < 1e-9 && end.motor,
    `${[...seen].join(',')} ${end.seconds.toFixed(2)}/${end.duration.toFixed(2)} s`);
  m.deck.setMotor(false);
  check('tape panel: a run that ends without an error report has none', t.tapeStatus().error === null);
  // a tape cut inside its second data block: three blocks start on it (the namefile, two data blocks), counted by the
  // one block scanner the file parser and the tape decoder use too (js/media/cassette.js casBlocks)
  const cut = new Emu.Session({ store: Emu.memoryStore() });
  cut.switchMachine('dragon64');
  cut.insertTape('cut.cas', cas.subarray(0, cas.length - 10));
  check('tape panel: a tape cut short counts the block it was cut in', cut.tapeStatus().blocks === 3, JSON.stringify(cut.tapeStatus()));
  // BASIC's report on the screen as the motor stops: ?IO ERROR then OK (VDG codes: @-_ are 0-31, space to ? are 32-63)
  t.rewindTape();
  m.deck.setMotor(true); for (let f = 0; f < 70; f++) { m.runFrame(); m.deck.setMotor(true); }
  const at = t.tapeStatus().block;
  const put = (row, text) => { for (let i = 0; i < 32; i++) { const c = (text[i] || ' ').charCodeAt(0); m.ram[0x400 + row * 32 + i] = c >= 64 ? c - 64 : c; } };
  put(14, '?IO ERROR'); put(15, 'OK');
  m.deck.setMotor(false);
  const err = t.tapeStatus();
  check('tape panel: ?IO ERROR on screen when the motor stops is a read error at that block', at >= 1 && err.error === at, JSON.stringify(err));
  t.rewindTape();
  check('tape panel: rewinding clears the error', t.tapeStatus().error === null && t.tapeStatus().block === 0);
  m.deck.setMotor(true); t.tapeStatus();
  check('tape panel: a new run of the motor clears it too', t.tapeStatus().error === null);
  m.deck.setMotor(false);
  // skip the tape: the program on it, in memory at once
  const msg = t.skipTape();
  check('skipTape: the program is loaded instantly (in memory, running), the rest of the tape stays in the deck',
    /panel\.cas: PANEL fast-loaded \$3000-\$30C7, exec \$3000/.test(msg) && code.every((v, i) => m.ram[0x3000 + i] === v) && m.cpu.pc >= 0x3000 && m.cpu.pc < 0x30C8
    && t.machine.deck.tape && t.machine.deck.tape.name === 'panel.cas' && t.fastCas === false, msg);
  t.machine.deck.eject();
  check('skipTape without a tape: refused', (() => { try { t.skipTape(); return false; } catch (e) { return e instanceof Emu.SessionError; } })());
  // a tape that went in as a WAV recording: its bytes are the decoded .CAS, so it loads under a .CAS name
  {
    const { casToWav } = require('../js/media/cassette.js');
    const w = new Emu.Session({ store: Emu.memoryStore() });
    w.switchMachine('dragon64');
    w.insertTape('panel.wav', casToWav(cas));
    const inDeck = w.machine.deck.tape && w.machine.deck.tape.name;
    let msg;                                    // a failure is a FAIL line, not a crash of the whole suite
    try { msg = w.skipTape(); } catch (e) { msg = `threw: ${e.message}`; }
    check('skipTape on a tape from a WAV recording: loads the decoded blocks (under panel.cas)', inDeck === 'panel.wav'
      && /panel\.cas: PANEL fast-loaded \$3000-\$30C7, exec \$3000/.test(msg) && code.every((v, i) => w.machine.ram[0x3000 + i] === v), msg);
  }
  // a BASIC tape with no BASIC ROM: refused before the power cycle, so the tape and the machine are as they were
  {
    const basic = new Uint8Array([...Array(128).fill(0x55), ...block(0, [...Buffer.from('PROG    '), 0, 0, 0, 0, 0, 0, 0]), ...Array(16).fill(0x55),
      ...block(1, [0x1E, 0x0A, 0x00, 0x0A, 0x87, 0x00, 0x00, 0x00]), ...block(0xFF, [])]);
    const b2 = new Emu.Session({ store: Emu.memoryStore() });
    b2.switchMachine('dragon64');
    b2.insertTape('prog.cas', basic);
    b2.machine.ram[0x3000] = 0x77;
    let err = null; try { b2.skipTape(); } catch (e) { err = e; }
    check('skipTape on a BASIC tape without the BASIC ROM: refused, and nothing changed (tape still in, memory kept)',
      err instanceof Emu.SessionError && /needs the Dragon 64 BASIC ROM/.test(err.message) && b2.machine.deck.tape && b2.machine.deck.tape.name === 'prog.cas'
      && b2.machine.ram[0x3000] === 0x77, err && err.message);
  }
  t.fastTape = false;
  t.insertTape('panel.cas', cas);
  check('tape panel: real speed shows as such', t.tapeStatus().realSpeed === true);
}

// LIZA on every machine: one way in, picking the build by CPU; the 6803 build needs
// the MC-10's 20K option, which a 4K machine is offered and can switch to in one step
(async () => {
  const st = Emu.memoryStore();
  const s2 = new Emu.Session({ store: st });
  const files = { 'liza.bin': fs.readFileSync(path.join(__dirname, '../examples/liza.bin')),
    'liza6803-mc10.bin': fs.readFileSync(path.join(__dirname, '../examples/liza6803-mc10.bin')),
    'liza6803-alice.bin': fs.readFileSync(path.join(__dirname, '../examples/liza6803-alice.bin')) };
  s2.load = (name) => `loaded ${name}`;                       // the page fetches the bytes; the test names the file
  const fetch = (name) => files[name];
  s2.switchMachine('dragon64');
  check('LIZA on the Dragon 64 uses the 6809 build', await s2.startLiza(fetch) === 'loaded liza.bin');
  s2.switchMachine('coco');
  check('LIZA on the Color Computer uses the 6809 build', await s2.startLiza(fetch) === 'loaded liza.bin');
  s2.switchMachine('mc10');
  check('LIZA on the MC-10 uses the 6803 build', await s2.startLiza(fetch) === 'loaded liza6803-mc10.bin');
  // the 20K question: the 6803 build sits at $5000, above a 4K machine's RAM
  s2.switchMachine('mc10', { ram: 4 });
  check('a 4K MC-10 is told LIZA needs 20K', s2.lizaNeeds() && s2.lizaNeeds().ram === 20 && s2.lizaNeeds().have === 4,
    JSON.stringify(s2.lizaNeeds()));
  const refused = await s2.startLiza(fetch).then(() => null, (e) => e);
  check('LIZA refuses to start on a 4K MC-10, saying what it needs', refused instanceof Emu.SessionError, refused && refused.message);
  check('the one-step switch fits the 20K option', s2.switchLiza() === 20 && s2.machine.config.ram === 20, `${s2.machine.config.ram}K`);
  check('after the switch LIZA starts', await s2.startLiza(fetch) === 'loaded liza6803-mc10.bin');
  s2.switchMachine('alice', { ram: 20 });
  check('a 20K Alice runs LIZA directly, nothing to ask', s2.lizaNeeds() === null && await s2.startLiza(fetch) === 'loaded liza6803-alice.bin');
  s2.switchMachine('coco3');
  check('a 6809 machine with enough RAM is never asked about 20K', s2.lizaNeeds() === null && await s2.startLiza(fetch) === 'loaded liza.bin');

  // and it really runs: through the Session's own loader, the MC-10 asks and answers a question
  const s3 = new Emu.Session({ store: Emu.memoryStore() });
  s3.switchMachine('mc10', { ram: 20 });
  const msg3 = await s3.startLiza(fetch);
  check('Session loads LIZA for real on a 20K MC-10', /liza6803-mc10\.bin: DragonDOS binary/.test(msg3), msg3);
  for (let i = 0; i < 20; i++) s3.machine.runFrame();
  check('the MC-10 screen shows the LIZA title', s3.screenText().join(' ').includes('I AM LIZA'), s3.screenText()[2]);
  s3.typeText('I need a holiday\n');
  for (let i = 0; i < 90; i++) s3.machine.runFrame();
  check('typing through the Session gets the reply on screen', s3.screenText().join(' ').includes('WHY DO YOU NEED A HOLIDAY?'),
    s3.screenText().filter((l) => l.trim()).slice(-2).join(' | '));
  // the 4K question through the page's own path: the answer is reported before anything is loaded
  const s4 = new Emu.Session({ store: Emu.memoryStore() });
  s4.switchMachine('alice', { ram: 4 });
  let started = false;
  try { await s4.startLiza(() => { started = true; return new Uint8Array(0); }); } catch (e) { /* refused, as it must be */ }
  check('a refused 4K start fetches nothing', !started);
})().then(() => userMedia).then(() => {
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log('FAIL async LIZA block', e.message); process.exitCode = 1; });
