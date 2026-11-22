// Run: node tests/session-robustness.test.js
//
// Four small robustness holes in the Session, each one found on main first and pinned here:
//  1. A program, tape, cartridge or disk dropped while the Claude chat is full screen goes to the BASIC session,
//     never to the chat machine: the chat machine runs the chat firmware, and a load there overwrote its RAM (the
//     chat screen went away, and the message said the load had worked). Session.loadMedia takes `this.machine`,
//     which is the chat machine while the chat is on screen; loadTarget() is the fix.
//  2. Stored ROMs that do not start BASIC are not retried on every tape drop: the machine remembers the failure for
//     the visit (keyed by the machine and the CRCs of its ROMs), and a power cycle or a ROM change clears it, so a
//     drop after either of those tries them again.
//  3. A snapshot opened over the screen leaves boot-help's box stale. A restore (an undo through restorePoint, an
//     opened snapshot through Machine.restore) emits 'restored', which boot-help listens to, and which is NOT
//     'reset' (an undo is not a Reset, and the listeners that see 'reset' must not act on one that never happened).
//  4. An undo inside a Reset-takeover run answers 'restored' and so offers no "A program took over Reset" box.
//     That is a decision, not an accident: an undo puts back the moment Claude was asked to restore, and the advice
//     from the run it took away it should not bring back.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const ROOT = path.join(__dirname, '..');
const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/chat.bin')));
const { build } = require('./fixtures/reset-firmware');
const { basic, basic64, game } = build(Emu);
const KEY = 'sk-ant-SESSION-ROBUSTNESS-0123456789';
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const top = (s) => s.screenText()[0].slice(0, 4);
const dragonRoms = (s) => s.addRoms([{ name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]);

// a scripted Messages API, so ChatSession's replies never leave this process
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const startMsg = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
const textReply = (text) => sse([startMsg, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
const backend = (text = 'ok') => new Emu.ClaudeBackend({ fetch: async () => new Response(textReply(text), { status: 200, headers: { 'content-type': 'text/event-stream' } }), apiKey: KEY });

// ---- media the four kinds of drop carry ----
// a machine-code tape (type 2), built the way tools/mame-diff/tape/standin.asm's CLOADM expects: 128 bytes of
// leader, a header block (type 0) naming the file, data blocks (type 1), then the end block. This is the shape
// tests/tape-load.test.js builds; it is not taken from any commercial tape.
const block = (type, data) => { let s = (type + data.length) & 255; for (const d of data) s = (s + d) & 255; return [0x3C, type, data.length, ...data, s, 0x55]; };
function casTape({ name = 'TEST', load = 0x0300, exec = 0x0300, data = [0x20, 0xFE], gap = 128, fileType = 2, ascii = false } = {}) {
  const nf = [...Buffer.from((name + '        ').slice(0, 8)), fileType, ascii ? 0xFF : 0, 0, exec >> 8, exec & 255, load >> 8, load & 255];
  const out = [...new Array(128).fill(0x55), ...block(0, nf), ...new Array(gap).fill(0x55)];
  for (let i = 0; i < data.length; i += 255) out.push(...block(1, data.slice(i, i + 255)));
  out.push(...block(0xFF, []));
  return Uint8Array.from(out);
}
// a DragonDOS binary (header $55, type 2, load, length, exec, $AA) at $0800: BRA to itself ($20 $FE)
const BINARY = Uint8Array.from([0x55, 0x02, 0x08, 0x00, 0x00, 0x02, 0x08, 0x00, 0xAA, 0x20, 0xFE]);

// a chat on the Session, full screen, on the machine given (with its ROMs already set, or on the stub)
function chatOn(s) {
  const chat = s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: '', tools: false });
  frames(s, 2);
  return chat;
}
const newSession = (id = 'dragon64') => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine(id); return s; };

(async () => {
// =====================================================================================
// 1. a drop while the chat is full screen goes to the BASIC session
// =====================================================================================
{
  const s = newSession(); dragonRoms(s); frames(s, 10);
  const basicM = s.shownMachine;
  chatOn(s);
  const chatM = s.chatMachines.chat;
  check('1 the chat is full screen and its machine is the one in use', s.claudeView === 'full' && s.shownMachine === chatM && chatM !== basicM,
    `${s.claudeView} ${s.shownMachine.id}/${chatM.id}/${basicM.id}`);
  const chatRamBefore = chatM.ram.slice();

  // a program (a DragonDOS binary with an executor): into the BASIC session's memory
  const msg = s.load('prog.bin', BINARY);
  check('1 a program dropped on the chat screen says where it went', /BASIC session/i.test(msg), msg);
  check('1 ...and it is in the BASIC session, not the chat machine',
    basicM.ram[0x0800] === 0x20 && basicM.ram[0x0801] === 0xFE && chatM.ram[0x0800] !== 0x20,
    `basic $0800=${basicM.ram[0x0800].toString(16)} chat $0800=${chatM.ram[0x0800].toString(16)}`);
  check('1 ...and the chat firmware is untouched by it', chatRamBefore.every((v, i) => v === chatM.ram[i]));
  // the chat is still the chat: the machine in use did not change under the person
  check('1 the chat machine is still the one on screen', s.shownMachine === chatM && s.chatMachines.chat === chatM && s.claudeView === 'full');

  // a POKE from the book is the person's: it acts on their machine and never types into the chat firmware, whose
  // keys are a conversation line (PM ruling)
  {
    // its own session, on the stub by choice: a POKE's line is queued on the stub the way the page's POKE book does it
    const ps = newSession('dragon64'); frames(ps, 5);
    ps.runWithoutRoms({ menu: false });
    chatOn(ps);
    const basicM = ps.chatMachines.basic, chatBefore = ps.chatMachines.chat.ram.slice();
    const book = ps.pokeBook();
    check('1 a POKE from the book while the chat is on screen has entries from the BASIC session\'s machine', book.length > 0, `${book.length} entries`);
    basicM.stubKeys.length = 0; ps.chatMachines.chat.stubKeys.length = 0;
    const msg = ps.typePoke(0);
    // on a stub machine the line is queued as the program's keys, on the machine the POKE is for: the BASIC session
    const basicKeys = basicM.stubKeys.slice(), chatKeys = ps.chatMachines.chat.stubKeys.slice();
    check('1 ...and the POKE is typed into the BASIC session, not the chat',
      /^Typed |^Done: /.test(msg) && basicKeys.length > 0 && chatKeys.length === 0,
      `${msg}; basic keys ${basicKeys.length} chat keys ${chatKeys.length}`);
    check('1 ...and the chat firmware is untouched by it', chatBefore.every((v, i) => v === ps.chatMachines.chat.ram[i]));
  }
  // a saved snapshot is the person's machine, never the chat firmware (PM ruling)
  {
    const f = await s.snapshotFile();
    const snap = await s.readSnapshot(f.bytes);
    check('1 a snapshot saved on the chat screen is the BASIC session\'s', snap.machine === s.chatMachines.basic.id && f.saved === 'your BASIC session',
      `${snap.machine} saved=${f.saved}`);
    // and it does not carry the chat firmware's memory: a marker byte poked in BASIC is in the file, one in the chat
    // machine is not
    s.chatMachines.basic.poke(0x1234, 0x5A); s.chatMachines.chat.poke(0x1234, 0xA5);
    const f2 = await s.snapshotFile();
    const snap2 = await s.readSnapshot(f2.bytes);
    const mem = snap2.state.memory;
    check('1 ...it holds the BASIC session\'s memory and not the chat machine\'s', mem[0x1234] === 0x5A, `$1234=${mem[0x1234]}`);
  }

  // a tape (type 2): into the BASIC session's deck, never the chat machine
  const chatBeforeTape = chatM.ram.slice();   // (its own baseline: the blocks above may have touched the chat machine)
  const tapeMsg = s.load('tape.cas', casTape());
  check('1 a tape dropped on the chat screen goes to the BASIC session', s.chatMachines.basic.deck.tape !== null && chatM.deck.tape === null
    && /BASIC session/i.test(tapeMsg), `${tapeMsg}; basic deck=${!!s.chatMachines.basic.deck.tape} chat deck=${!!chatM.deck.tape}`);
  // (the chat firmware's own RAM is untouched: the BASIC session's deck went in, and the chat machine is a
  // different Machine. The BASIC session is restarted for the clean load, which is its own RAM, not the chat's)
  check('1 ...and the chat firmware is still untouched', chatBeforeTape.every((v, i) => v === chatM.ram[i]));

  // a cartridge: into the BASIC session's port (it has one), which starts it there
  s.switchMachine('dragon64');
  const s2 = new Emu.Session({ store: Emu.memoryStore() }); s2.switchMachine('dragon64'); dragonRoms(s2); frames(s2, 10);
  const basic2 = s2.shownMachine; chatOn(s2);
  const cart = Uint8Array.from([...new Array(0x2000).fill(0x39)]);   // 8K of RTS: a valid Program Pak image
  const cartMsg = s2.load('prog.rom', cart);
  check('1 a cartridge dropped on the chat screen goes into the BASIC session',
    basic2.cartPort !== null && s2.chatMachines.chat.cartPort === null && /BASIC session/i.test(cartMsg),
    `${cartMsg}; basic cart=${!!basic2.cartPort} chat cart=${!!s2.chatMachines.chat.cartPort}`);
}

// the same for a disk image, which goes into a drive: the refusal must name the PERSON's machine, and the chat's RAM
// is untouched. The disk has to be a real image to reach the routing at all - a garbage file is refused by
// detectMedia before any machine is looked at, which is why the old version of this check passed on main.
{
  const s = newSession('dgnalpha'); frames(s, 5);
  chatOn(s);
  const chatM = s.chatMachines.chat, before = chatM.ram.slice();
  // a real VDK image; the Dragon Alpha has its disk interface built in, so the mount can go either machine's way
  await s.importDisk('real.vdk', Emu.blankDisk('vdk', 40, 1), 0);
  check('1 a disk dropped on the chat screen is mounted in the person\'s drives', s.diskStatus().drives.length === 1
    && s.diskControllerOf(s.chatMachines.basic).drives[0].loaded && !s.diskControllerOf(chatM).drives[0].loaded,
    JSON.stringify(s.diskStatus().drives));
  check('1 ...and the chat firmware is untouched by it', before.every((v, i) => v === chatM.ram[i]));
  // a garbage file is still refused as a disk, before any machine
  const why = (() => { try { s.load('disk.vdk', new Uint8Array(0x1000)); return 'loaded'; } catch (e) { return e.message; } })();
  check('1 a file that only looks like a disk is refused before any machine is touched', /Disk images go in a disk drive/.test(why), why);
}
{
  // the Dragon Alpha has a built-in disk interface, so with the chat full screen both machines have a controller:
  // a disk dropped there must go into the PERSON's drives, and the drives card must show those, not the chat's empty
  // ones. (Before the fix this was the widest version of the bug: the disk landed in the chat machine's drives.)
  const media = new Emu.MemoryMediaStore();
  const s = new Emu.Session({ store: Emu.memoryStore(), media });
  s.switchMachine('dgnalpha'); frames(s, 5);
  chatOn(s);
  const chatM = s.chatMachines.chat;
  check('1 (Alpha) the chat machine has a disk controller of its own', !!s.diskControllerOf(chatM));
  check('1 (Alpha) diskStatus is the person\'s: the BASIC session\'s drives', s.diskMachine === s.chatMachines.basic && s.diskStatus().drives.length === 0);
  const vdk = Emu.blankDisk('vdk', 40, 1);
  const msg = await s.importDisk('game.vdk', vdk, 0);
  check('1 (Alpha) a disk dropped on the chat screen mounts in the BASIC session', /in drive 0/.test(msg), msg);
  const basicDrives = s.diskControllerOf(s.chatMachines.basic).drives.filter((d) => d.loaded);
  const chatDrives = s.diskControllerOf(chatM).drives.filter((d) => d.loaded);
  check('1 (Alpha) ...the BASIC session holds it and the chat machine does not', basicDrives.length === 1 && chatDrives.length === 0,
    `basic=${basicDrives.length} chat=${chatDrives.length}`);
  check('1 (Alpha) ...and the drives card (diskStatus) shows it', s.diskStatus().drives.length === 1 && s.diskStatus().drives[0].file === 'game.vdk',
    JSON.stringify(s.diskStatus().drives));
}

// =====================================================================================
// 1b. the rest of the person's machine (review round 2): ROMs, tapes by skip, the SSC, the welcome program
// =====================================================================================
{
  // a ROM dropped while the chat is full screen is the PERSON's: it boots their BASIC session, and never puts ROMs
  // in the chat machine (which runs the chat firmware)
  const s = newSession('dragon64'); frames(s, 5);
  chatOn(s);
  const chatM = s.chatMachines.chat, basic = s.chatMachines.basic;
  const chatBefore = chatM.ram.slice();
  s.addRoms([{ name: 'd64_1.rom', bytes: basic64 /* a real 16K image */ }]);
  check('1b (ROMs) a ROM dropped on the chat screen is loaded onto the BASIC session', basic.hasRom === true && chatM.hasRom === false,
    `basic ${basic.hasRom} chat ${chatM.hasRom}`);
  const chatChanged = chatBefore.reduce((n, v, i) => n + (v === chatM.ram[i] ? 0 : 1), 0);
  check('1b (ROMs) ...and the chat machine is not power cycled into it (its RAM is untouched)', chatChanged === 0
    && chatM.useStub === true, `chat RAM bytes changed: ${chatChanged}; chat useStub ${chatM.useStub}`);
}
{
  // Remove ROMs (Ctrl+K → Your ROMs → Remove ROMs) is the person's machine too
  const s = newSession('dragon64'); dragonRoms(s); frames(s, 10);
  chatOn(s);
  const chatM = s.chatMachines.chat;
  s.clearRoms();
  check('1b (Remove ROMs) it clears the BASIC session, not the chat machine', s.chatMachines.basic.hasRom === false && chatM.hasRom === false
    && chatM.useStub === true, `basic ${s.chatMachines.basic.hasRom} chat ${chatM.hasRom}`);
}
{
  // skipTape is the person's machine end to end: its power cycle was this.machine
  const s = newSession('dragon32'); frames(s, 5);
  chatOn(s);
  const chatM = s.chatMachines.chat, chatBefore = chatM.ram.slice();
  s.insertTape('x.cas', casTape());
  const msg = s.skipTape();
  check('1b (skipTape) it loads the tape on the BASIC session and power cycles that one', /loaded \(.*\) and started at/.test(msg)
    && chatBefore.every((v, i) => v === chatM.ram[i]), `${msg}`);
}
{
  // the welcome program, which offerMenu now offers for the person's machine, must be set up on that machine and
  // must not touch the chat machine's state at all (it used to be written over the chat firmware). The chat machine
  // keeps its own RAM and its own restart record.
  const s = newSession('dragon32'); frames(s, 5);
  chatOn(s);
  const chatM = s.chatMachines.chat, basic = s.chatMachines.basic;
  const chatRun = s.stubRuns.get(chatM);
  const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));
  s.startWelcome(welcome, { greeting: 'back' });
  // the program's own bytes went to the BASIC session, not the chat machine: its record holds the program and the
  // chat machine's is the one it had
  const basicRec = s.stubRuns.get(basic);
  // the program's own bytes are in the BASIC session's memory at its entry, and not in the chat machine's
  const sg = basicRec && basicRec.segments && basicRec.segments[0];
  const at = sg && sg.addr;
  // the program's bytes are in the BASIC session's memory where it starts, and the chat machine's memory there is
  // not the program (byte by byte on the ones that tell them apart: a byte both hold by coincidence proves nothing)
  const same = !!sg && [0, 1, 2, 3].every((k) => basic.ram[(at + k) & 0xFFFF] === sg.data[k])
    && [0, 1, 2, 3].some((k) => chatM.ram[(at + k) & 0xFFFF] !== sg.data[k]);
  check('1b (welcome) the welcome program is set up in the BASIC session\'s memory, not the chat machine\'s',
    s.welcome === basic && s.welcomeBuild !== null && basicRec && basicRec.m === basic && same,
    `welcome on ${s.welcome === basic ? 'basic' : 'other'}; program bytes in basic: ${same}`);
  check('1b (welcome) ...and the chat machine keeps its own restart record, untouched', s.stubRuns.get(chatM) === chatRun);
  check('1b (welcome) ...and its ROM choice is untouched', chatM.useStub === true);
}

// =====================================================================================
// 2. stored ROMs that do not start BASIC are not retried on every drop
// =====================================================================================
{
  const s = newSession('dragon32');
  // a ROM image that is stored (so the sockets are all filled and the machine counts as bootable) but never
  // prints OK: the same shape tests/reset.test.js uses for "a ROM that never prints OK"
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  check('2 the stored ROM does not start BASIC', s.bootStatus(5).state === 'failed', JSON.stringify(s.bootStatus(5)));
  s.runWithoutRoms({ menu: false });
  const tape = casTape();
  let fw = 0; s.on((ev) => { if (ev === 'firmware') fw++; });
  const before = fw;
  // the first drop after the choice tries the stored ROMs (that is the existing behaviour), fails, and falls back
  const first = s.load('a.cas', tape);
  check('2 the first drop tries the stored ROMs and says so', /Your stored ROMs did not start BASIC/.test(first), first);
  const triedOnce = fw - before;
  check('2 ...which restarted the machine into them', triedOnce > 0, `firmware events ${triedOnce}`);
  // the next drops must NOT try them again: no restart into the ROMs, and no 5 s wait for an OK that never comes
  const before2 = fw;
  const second = s.load('b.cas', tape);
  check('2 the second drop does not try them again', !/Your stored ROMs did not start BASIC|Using your ROMs again/.test(second), second);
  check('2 ...and the machine is not restarted into them (no firmware event)', fw - before2 === 0, `${fw - before2} firmware events`);
  check('2 ...and the tape still loads, straight into memory on the stub', /loaded \(.*\) and started at/.test(second), second);
  // a power cycle clears the mark: the next drop tries them again
  s.powerCycle({ menu: false });
  const third = s.load('c.cas', tape);
  check('2 a power cycle clears it: the next drop tries the stored ROMs again', /Your stored ROMs did not start BASIC/.test(third), third);
}
{
  // a ROM change clears it: Forget ROMs + new, booting ROMs, then the mark from the old ones must not stop the new
  const s = newSession('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  s.runWithoutRoms({ menu: false });
  const bad = casTape();
  s.load('a.cas', bad);                         // tries them, fails, marks them
  s.clearRoms();                                // ROMs gone: the mark must not outlive them
  // the good ROMs for this model (the Dragon 32 has one socket; the reset fixture's BASIC image prints OK)
  s.switchMachine('dragon32');
  s.addRoms([{ name: 'd32.rom', bytes: basic }]);
  frames(s, 5 * 50 + 2);
  check('2 ...the new ROMs do start BASIC', s.bootStatus(5).state === 'ok', JSON.stringify(s.bootStatus(5).state));
  s.runWithoutRoms({ menu: false });             // by choice, as before a load that needs BASIC
  const msg = s.load('b.cas', bad);
  check('2 a ROM change (Forget ROMs, then new ROMs) clears the mark: the good ROMs are used again',
    /Using your ROMs again/.test(msg), msg);
}
{
  // the key is the ROM CRCs, and ONLY they: change the stored bytes without a power cycle or a machine switch (a
  // second drop of a different ROM image, replacing the first), and the mark from the old CRC must not apply. This is
  // the part the Forget-ROMs case above cannot reach, since clearRoms calls poweredOn() and empties the set anyway.
  const s = newSession('dragon32');
  s.addRoms([{ name: 'a.rom', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  s.runWithoutRoms({ menu: false });
  s.load('a.cas', casTape());                    // tries the first image, fails, marks its CRC
  const m = s.shownMachine, marked = [...s.romsFailed(m)];
  check('2 (CRC) the first image is marked, with its CRC in the key', marked.length === 1 && marked[0] === s.bootKey(m),
    `${marked.join()} vs ${s.bootKey(m)}`);
  // The key is the ROM CRCs, so another image for the same machine is another key: replace the library's image
  // directly (addRoms would power cycle, and a power-on empties the whole Map - the next case, not this one), and
  // the old mark must not match the new image. The stored failure itself is kept (only a power-on forgets it).
  s.roms.put(m.id, 'basic', new Uint8Array(16 * 1024).fill(0x41), 'b.rom');
  const key = s.bootKey(m);
  check('2 (CRC) the key follows the ROM bytes, not just the machine', key !== marked[0] && !s.romsFailed(m).has(key),
    `${key} vs ${marked.join()}`);
  check("2 (CRC) ...and the old CRC is still on the machine's record (the Set was not emptied)", s.romsFailed(m).size === 1, `${s.romsFailed(m).size}`);
}
{
  // review probe C: an ASCII BASIC tape with the failing ROMs. The refusal must still remember the failure - once,
  // not on every drop - or each ASCII drop pays the whole restart and 5 s again.
  const s = newSession('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  s.runWithoutRoms({ menu: false });
  let fw = 0; s.on((ev) => { if (ev === 'firmware') fw++; });
  const asc = casTape({ fileType: 0, ascii: true, data: [...Buffer.from('10 PRINT 1\r')] });
  const throws = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  const e1 = throws(() => s.load('a.cas', asc)), f1 = fw;
  check('2 (ASCII) the first ASCII drop is refused and its ROMs are tried', /did not start BASIC, and an ASCII BASIC tape needs it/.test(e1 || ''), e1);
  check('2 (ASCII) ...and the failure is remembered', s.bootFailed.size === 1, [...s.bootFailed].join());
  const f0 = fw;
  throws(() => s.load('b.cas', asc));
  check('2 (ASCII) the second ASCII drop does not restart into them again', fw - f0 === 0, `${fw - f0} firmware events (first drop: ${f1})`);
}
{
  // review probe A: the load's fall-back with the failing ROMs, on the chat screen, must not touch the chat machine
  const s = newSession('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  s.runWithoutRoms({ menu: false });
  chatOn(s);
  const chatM = s.chatMachines.chat, before = chatM.ram.slice();
  s.load('t.cas', casTape());
  check('1 (probe A) the failing-ROM fall-back leaves the chat machine untouched', before.every((v, i) => v === chatM.ram[i])
    && chatM.useStub === true && s.chatMachines.basic.useStub === true && !s.chatMachines.basic.hasRom,
    `chat useStub ${chatM.useStub} basic useStub ${s.chatMachines.basic.useStub}`);
}
{
  // review probe B: a drop on the chat screen, then Reset, must not take the chat's screen away (its own stub
  // program's restart record is the chat machine's, not the Session's single one)
  const s = newSession('dragon32'); frames(s, 5);
  chatOn(s); frames(s, 10);
  const chatM = s.chatMachines.chat, screenBefore = s.screenText(chatM).slice(0, 3).join('|');
  s.load('p.bin', BINARY);
  check('1 (probe B) the chat keeps its own restart record after a load on the BASIC session', s.stubRun && s.stubRun.m === chatM,
    s.stubRun ? (s.stubRun.m === chatM ? 'chat' : 'other') : 'null');
  let menus = 0; s.on((e) => { if (e === 'menu') menus++; });
  s.reset(); frames(s, 20);
  check('1 (probe B) Reset leaves the chat screen as it was, with no menu offered', s.screenText(chatM).slice(0, 3).join('|') === screenBefore && menus === 0,
    `${s.screenText(chatM).slice(0, 3).join('|')} menus=${menus}`);
}
{
  // review probe D: the deck controls and the Multi-Pak are the person's, not the chat machine's
  const s = newSession('dragon32'); frames(s, 5);
  chatOn(s);
  s.insertTape('x.cas', casTape());
  check('1 (probe D) insertTape goes into the BASIC session\'s deck', !!s.chatMachines.basic.deck.tape && !s.chatMachines.chat.deck.tape);
  const st = s.tapeStatus();
  check('1 (probe D) tapeStatus describes that tape (not null), and rewindTape reaches it', st && st.name === 'x.cas' && s.rewindTape() === true,
    JSON.stringify(st).slice(0, 80));
  s.insertMultiPak([{ name: 'c.rom', bytes: new Uint8Array(0x2000).fill(0x39) }]);
  check('1 (probe D) the Multi-Pak goes into the BASIC session\'s port', !!s.chatMachines.basic.cartPort && !s.chatMachines.chat.cartPort,
    `basic ${s.chatMachines.basic.cartPort && s.chatMachines.basic.cartPort.constructor.name} chat ${s.chatMachines.chat.cartPort && s.chatMachines.chat.cartPort.constructor.name}`);
}
{
  // offerMenu (review probe B's other half), where this.machine and the person's machine DISAGREE about the stub.
  // The chat machine is given ROMs (a switch or a restore can do that); the BASIC session is on the stub by choice.
  // Run without ROMs on the person's machine, then a person-side power cycle: the menu is for the BASIC session,
  // never for the chat machine, which does not run the welcome program (its screen is the chat firmware).
  const s = newSession('dragon32'); frames(s, 5);
  chatOn(s); frames(s, 5);
  const chatM = s.chatMachines.chat, basic = s.chatMachines.basic;
  chatM.setRoms({ basic: new Uint8Array(0x4000).fill(0x12) });   // the chat machine now has ROMs: no stub, no menu
  check('1 (offerMenu) the two machines disagree about the stub', chatM.useStub === false && basic.useStub === true,
    `chat ${chatM.useStub} basic ${basic.useStub}`);
  let menus = 0; s.on((e) => { if (e === 'menu') menus++; });
  s.powerCycle({ menu: true, on: basic });
  check('1 (offerMenu) the menu is offered for the person\'s machine, not the chat', menus === 1, `menus ${menus}`);
}

{
  // review round 2, finding 5: a machine SWITCH is a fresh try at the ROMs (the comment said so and the code did
  // not). Mark the failing ROMs, switch away and back, then a drop must try them again.
  const s = newSession('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  s.runWithoutRoms({ menu: false });
  s.load('a.cas', casTape());
  check('2 (switch) the failing ROMs are marked for this machine', s.bootFailed.size === 1 && s.romsFailed(s.shownMachine).size === 1,
    `${s.bootFailed.size} machine(s)`);
  s.switchMachine('coco'); s.switchMachine('dragon32'); frames(s, 2);
  check('2 (switch) switching away forgets them (and the discarded machine with them)', s.bootFailed.size === 0, `${s.bootFailed.size} machine(s)`);
  let fw = 0; s.on((e) => { if (e === 'firmware') fw++; });
  const f0 = fw;
  s.load('b.cas', casTape());
  check('2 (switch) so the next drop tries the ROMs again', fw - f0 > 0, `${fw - f0} firmware events`);
}

// =====================================================================================
// 3. a restore tells boot-help, with 'restored' (not 'reset')
// =====================================================================================
{
  // an undo through restorePoint: the box was up as 'failed' (a stored ROM that never starts BASIC), then Claude's
  // undo puts back a point taken before it, and the Session must announce it
  const s = newSession('dragon32');
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * 1024).fill(0x39) }]);
  frames(s, 5 * 50 + 2);
  check('3 the box is up: failed', s.bootStatus(5).state === 'failed');
  const chat = s.startAsk({ backend: backend() });
  chat.undo.push(s.chatTarget().snapshot());
  const events = []; s.on((ev) => events.push(ev));
  s.restoreClaude(0);
  check('3 an undo emits "restored"', events.includes('restored'), events.join(','));
  check('3 ...and never "reset": an undo is not a Reset', !events.includes('reset'), events.join(','));
  check('3 ...and the machine is no longer a failure (the box closes on the new answer)', s.bootStatus(5).state === 'restored',
    JSON.stringify(s.bootStatus(5)));
}
{
  // an opened snapshot goes through Machine.restore: it emits 'restored' too, and not 'reset'
  const s = newSession(); dragonRoms(s); frames(s, 10);
  check('3 a booted machine', s.bootStatus(5).state === 'ok');
  const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
  const events = []; s.on((ev) => events.push(ev));
  s.openSnapshot(snap);
  check('3 opening a snapshot emits "restored"', events.includes('restored'), events.join(','));
  check('3 ...and not "reset"', !events.includes('reset'), events.join(','));
}
{
  // nothing that hears 'reset' hears a restore, and nothing that hears 'restored' hears a Reset: the two are
  // separate events, which is the whole point of not reusing 'reset'. Both directions, through the Session.
  const s = newSession(); dragonRoms(s); frames(s, 10);
  const ev = []; s.on((e) => ev.push(e));
  s.reset(); frames(s, 2);
  check('3 a Reset emits "reset", never "restored"', ev.includes('reset') && !ev.includes('restored'), [...new Set(ev)].join(','));
  ev.length = 0;
  const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
  s.openSnapshot(snap);
  check('3 and an opened snapshot emits "restored", never "reset"', ev.includes('restored') && !ev.includes('reset'), [...new Set(ev)].join(','));
}

{
  // the boot box's own rule, held as a pure function so a DOM is not needed here: it re-checks on 'restored'
  // (an undo, an opened snapshot) and restarts its watcher on a machine/firmware/Reset. Without the 'restored'
  // line the box a run raised would outlive the restore that replaced it.
  const { bootHelpOn } = await import(path.join(ROOT, 'js/ui/boot-help.js'));
  check('3 boot-help re-checks on "restored"', bootHelpOn('restored') === 'recheck');  check('3 ...restarts (re-check and watch) on machine, firmware and reset',
    ['machine', 'firmware', 'reset'].every((e) => bootHelpOn(e) === 'restart'));
  check('3 ...and does nothing for an unrelated event', bootHelpOn('disks') === null && bootHelpOn('chat') === null);
}

// =====================================================================================
// 4. an undo inside a Reset-takeover run offers no takeover box (a decision, kept)
// =====================================================================================
{
  const s = newSession(); dragonRoms(s); frames(s, 10);
  s.inject(game, 0x4022); frames(s, 5);
  check('4 the game runs and holds the warm-start vector', top(s) === 'GGGG' && s.shownMachine.ram[0x71] === 0x55, top(s));
  s.reset(); frames(s, 5);
  frames(s, 5 * 50 + 2);
  const st = s.bootStatus(5);
  check('4 Reset into the game is a takeover', st.state === 'reset' && st.takeover === true, JSON.stringify(st));
  // Claude's undo during that run
  const chat = s.startAsk({ backend: backend() });
  chat.undo.push(s.chatTarget().snapshot());
  s.restoreClaude(0);
  const after = s.bootStatus(5);
  // the decision: no takeover offer after an undo. The reason is in Session.restorePoint (the point put back is
  // the moment Claude was asked to restore; the advice from the run the undo took away is not brought back).
  check('4 after an undo the answer is restored, never the takeover offer', after.state === 'restored' && !after.takeover,
    JSON.stringify(after));
}

// =====================================================================================
// 5. (skipped on the brief's terms) two debuggers on one machine
// =====================================================================================
// Not reproducible through any product path: every public sequence attaches exactly
// one debugger per machine and one bus read makes exactly one _access call. Nothing is pinned here for it.

})().then(() => {
  console.log(`${n - fail}/${n} session-robustness checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL session-robustness ${e.stack}`); process.exitCode = 1; });
