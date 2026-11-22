// Run: node tests/probes.test.js
//
// The host's observers of a machine (docs/architecture.md, "Probes and bus taps"): Machine.addProbe (called before
// each instruction, in registration order, through the one pcWatch slot) and m.busTaps (read and write taps over
// address ranges, which shadow the bus only while a tap is on), and the Session's HostHooks, which follow the
// machine in use. Oracles: the CPU's own trace hook (called once per instruction at its start) for the probes; the
// program's own operands and the disk controller's count of the reads it saw for the taps; the family's prototype
// methods for "the bus is intact"; a snapshot taken with nothing registered for "host state, never saved".
// (The Session's load detector sharing the slot with other probes: tests/tape-load.test.js.)
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

const asm = (text) => {
  const r = Emu.assemble(' ORG $3000\n' + text + '\n', '6809');
  if (!r.ok) throw new Error('test firmware does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
// each pass: X+1 written to $4000/$4001 (STX: high byte, then low), $4002 read (LDA)
const LOOP = asm(`
START   LDX     #$0000
LOOP    LEAX    1,X
        STX     $4000
        LDA     $4002
        BRA     LOOP`);
const AT_LOOP = LOOP.symbols.get('LOOP');
const running = (id = 'dragon64') => { const m = Emu.createMachine(id); m.injectAndRun(LOOP.segments, LOOP.exec); m.runFrame(); return m; };
const busIntact = (m) => { const p = Object.getPrototypeOf(m); return !Object.hasOwn(m, 'read') && !Object.hasOwn(m, 'write') && m.read === p.read && m.write === p.write; };
const permutations = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

// ---------------- 1. probes ----------------
for (const id of ['dragon64', 'coco3', 'mc10']) {
  const m = Emu.createMachine(id);
  m.reset(true); m.runFrame();
  check(`${id}: no probe: the pcWatch slot is null`, m.pcWatch === null && m.probes.length === 0);
  const traced = [];
  m.cpu.trace = (cpu) => traced.push(cpu.pc);
  const order = [], a = [], b = [];
  const ra = m.addProbe((pc) => { a.push(pc); order.push('a'); });
  check(`${id}: one probe: pcWatch is that probe (no dispatcher)`, m.pcWatch !== null && m.probes.length === 1 && m.probes[0].fn === m.pcWatch);
  const rb = m.addProbe((pc) => { b.push(pc); order.push('b'); });
  m.runFrame();
  // the probe runs before each step: the PC it is given is the one the CPU then traces at the instruction's start
  // (a probe called after the instruction would see the next PC). The one exception: an interrupt taken at that step,
  // whose handler's first instruction is what runs (and is traced) instead; the interrupted PC runs later.
  const follows = (calls) => {
    let i = 0, skipped = 0;
    for (const pc of traced) {
      if (calls[i] !== pc) { skipped++; i++; }          // (one step whose instruction an interrupt put off)
      if (calls[i] !== pc) return -1;
      i++;
    }
    return i === calls.length || i === calls.length - 1 ? skipped : -1;
  };
  const skips = follows(a);
  check(`${id}: two probes see every instruction, before it runs (the PCs the CPU traced, in order, but for interrupt entries)`,
    a.length > 1000 && b.join() === a.join() && skips >= 0 && skips < 10, `${a.length} probe calls, ${traced.length} traced, ${skips} interrupt steps`);
  check(`${id}: probes run in registration order`, order.length === 2 * a.length && order.every((x, i) => x === (i % 2 ? 'b' : 'a')));
  ra(); ra();
  const na = a.length, nb = b.length;
  m.runFrame();
  check(`${id}: removing one (twice) leaves the other running alone`, m.probes.length === 1 && a.length === na && b.length > nb);
  rb();
  check(`${id}: removing the last empties the slot`, m.pcWatch === null && m.probes.length === 0);
}
{
  const m = running();
  check('a probe must be a function', throws(() => m.addProbe(42)) && m.probes.length === 0);
  // a probe that adds or removes a probe while the probes run: the change takes effect from the next instruction
  const seen = [];
  let rc = null;
  const rx = m.addProbe((pc) => { seen.push('x'); if (!rc) rc = m.addProbe(() => seen.push('c')); });
  const ry = m.addProbe(() => seen.push('y'));
  m.runCycles(Infinity, 2);
  check('a probe added from a probe runs from the next instruction on', seen.join('') === 'xyxyc', seen.join(''));
  rx(); ry(); rc();
  // a probe that removes a later probe while the probes run: that one still runs for this instruction (the dispatch
  // goes over the list as it was when the instruction started), then no more
  const seen2 = [];
  let ryy = null;
  const rxx = m.addProbe(() => { seen2.push('x'); if (ryy) { ryy(); ryy = null; } });
  ryy = m.addProbe(() => seen2.push('y'));
  const rzz = m.addProbe(() => seen2.push('z'));
  m.runCycles(Infinity, 3);
  check('a probe removed by an earlier one during dispatch still runs for that instruction, then stops', seen2.join('') === 'xyzxzxz', seen2.join(''));
  rxx(); rzz();
  // a reset keeps the host's probes (only the Session's load detector goes, with its typist item: tape-load.test.js)
  const c = [];
  const r = m.addProbe((pc) => c.push(pc));
  m.reset(true); m.runFrame();
  check('a reset keeps a probe', c.length > 0 && m.probes.length === 1);
  r();
}

// ---------------- 2. bus taps ----------------
{
  const m = running();
  check('no tap: the bus is the family\'s own read and write', busIntact(m));
  const passes = [];
  const rp = m.addProbe((pc) => { if (pc === AT_LOOP) passes.push(m.cpu.x); });
  const writes = [], lows = [], reads = [];
  const rw = m.busTaps.addWriteTap({ start: 0x4000, end: 0x4001 }, (a, v) => writes.push([a, v]));
  const rl = m.busTaps.addWriteTap({ start: 0x4001, end: 0x4001 }, (a, v) => lows.push(v));
  const rr = m.busTaps.addReadTap({ start: 0x4002, end: 0x4002 }, (a, v) => reads.push([a, v]));
  m.ram[0x4002] = 0x5A;
  m.runFrame();
  // the oracle: the loop's own X at each pass: STX writes X+1, high byte then low, and LDA reads $4002 once
  const done = passes.length - 1;   // (the last pass may not have reached its STX)
  const expect = [];
  for (let i = 0; i < done; i++) { const x = (passes[i] + 1) & 0xFFFF; expect.push([0x4000, x >> 8], [0x4001, x & 0xFF]); }
  check('a write tap sees each write in its range, address and byte, in order', done > 500 && writes.slice(0, expect.length).join() === expect.join(), `${writes.length} writes for ${done} passes`);
  check('a tap on part of the range sees only that part', lows.length === writes.filter(([a]) => a === 0x4001).length && lows.every((v, i) => v === writes.filter(([a]) => a === 0x4001)[i][1]));
  check('a read tap sees each read in its range with the value read', reads.length >= done && reads.length <= done + 1 && reads.every(([a, v]) => a === 0x4002 && v === 0x5A));
  check('a tap leaves the other kind alone: reads are shadowed, writes are shadowed, each by itself', Object.hasOwn(m, 'read') && Object.hasOwn(m, 'write'));
  rw(); rl(); rr(); rp();
  check('all taps off: the bus is intact', busIntact(m));
  // only a write tap: reads stay the family's own
  const r1 = m.busTaps.addWriteTap({ start: 0, end: 0xFFFF }, () => {});
  check('a write tap alone shadows only write', !Object.hasOwn(m, 'read') && Object.hasOwn(m, 'write'));
  r1();
  {
    // something else already shadowing the bus: refused, and the other hook left in place
    const own = (a, v) => Object.getPrototypeOf(m).write.call(m, a, v);
    m.write = own;
    check('a tap refuses a bus someone else shadows, and leaves that hook alone', throws(() => m.busTaps.addWriteTap({ start: 0, end: 1 }, () => {})) && m.write === own && m.busTaps.writes.length === 0);
    delete m.write;
  }
  check('bad ranges and functions are refused', throws(() => m.busTaps.addReadTap({ start: 5, end: 4 }, () => {})) &&
    throws(() => m.busTaps.addWriteTap({ start: 0, end: 0x10000 }, () => {})) && throws(() => m.busTaps.addWriteTap({ start: 0, end: 1 }, null)) && busIntact(m));
}
{
  // removing taps in any order leaves the bus intact, and while one is on it still fires
  const order = ['read A', 'write B', 'read C', 'write D'];
  let ok = true, detail = '';
  for (const perm of permutations([0, 1, 2, 3])) {
    const m = running();
    const counts = [0, 0, 0, 0];
    const removes = order.map((name, i) => (name.startsWith('read')
      ? m.busTaps.addReadTap({ start: 0x4002, end: 0x4002 }, () => counts[i]++)
      : m.busTaps.addWriteTap({ start: 0x4000, end: 0x4001 }, () => counts[i]++)));
    for (let k = 0; k < perm.length; k++) {
      removes[perm[k]]();
      const left = perm.slice(k + 1);
      counts.fill(0);
      m.runCycles(m.cycle + 2000);
      // every tap still on fires; every tap taken off is silent
      if (!left.every((i) => counts[i] > 0) || !perm.slice(0, k + 1).every((i) => counts[i] === 0)) { ok = false; detail = `order ${perm} after ${k + 1}: ${counts}`; }
    }
    if (!busIntact(m)) { ok = false; detail = `order ${perm}: bus still shadowed`; }
  }
  check('taps removed in each of the 24 orders: the ones left still fire, and at the end m.read/m.write are the prototype\'s', ok, detail);
}

// ---------------- 3. the debugger is a tap client ----------------
{
  const m = running();
  const dbg = new Emu.Debugger(m);
  check('a debugger with no watchpoints leaves the bus alone', busIntact(m));
  const tapped = [];
  const rt = m.busTaps.addWriteTap({ start: 0x4000, end: 0x4001 }, (a, v) => tapped.push([a, v]));
  const w = dbg.addWatchpoint(0x4001, 1, { read: false, write: true });
  dbg.run(200);
  check('a watchpoint and a tap on the same write both fire', dbg.stopReason && dbg.stopReason.kind === 'watchpoint' && dbg.stopReason.address === 0x4001 &&
    tapped.length >= 2 && tapped[tapped.length - 1][0] === 0x4001 && tapped[tapped.length - 1][1] === dbg.stopReason.value, JSON.stringify(dbg.stopReason));
  // the debugger's own write is not a program access: no watchpoint, and no tap either (rawWrite)
  const n = tapped.length;
  dbg.resume(); dbg.write(0x4001, [0x77]);
  check('the debugger\'s own write reaches memory and fires neither', m.ram[0x4001] === 0x77 && tapped.length === n && !dbg.hit);
  // the watchpoint off: the tap goes on; the tap off: only then is the bus intact
  dbg.removeWatchpoint(w);
  check('the watchpoint removed, the tap\'s shadow stays', Object.hasOwn(m, 'write'));
  m.runCycles(m.cycle + 2000);
  check('...and the tap still fires', tapped.length > n);
  dbg.addWatchpoint(0x4000, 2, { read: false, write: true });
  rt();
  dbg.run(200);
  check('the tap removed first, the watchpoint still stops the machine', dbg.stopReason && dbg.stopReason.kind === 'watchpoint');
  dbg.detach();
  check('debugger detached and the tap gone: the bus is intact', busIntact(m));
}

// ---------------- 4. the CoCo 3's instruction held by HALT: each access reported once ----------------
// INC $FF4B on a drive that never brings DRQ: HALT holds its write, the frame ends, the instruction is suspended and
// later runs again from its start, replaying the read of $FF4B it made before the HALT (coco3.js replayRead). The
// controller sees each read once; a tap must report it once too. (Set-up: tests/halt-held.test.js.)
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }], ['6309', { cpu: '6309' }]]) {
  const m = Emu.createMachine('coco3', config);
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  const start = (dsk, sector, loop) => {
    [0xC6, sector, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, dsk, 0xF7, 0xFF, 0x40, ...loop].forEach((b, i) => m.poke(0x3000 + i, b));
    m.cpu.x = 0x4000; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  };
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  start(0xAA, 4, [0x7C, 0xFF, 0x4B, 0x20, 0xFB]);   // INC $FF4B / BRA
  const reads = [], tapped = [], watched = [];
  const rd = f.readIO.bind(f);
  f.readIO = (a) => { const v = rd(a); if (a === 0xFF4B) reads.push(v); return v; };
  const rt = m.busTaps.addReadTap({ start: 0xFF4B, end: 0xFF4B }, (a, v) => tapped.push(v));
  // a probe sees the INC once per execution: each INC reads $FF4B once (before the HALT), so once per controller read,
  // however often the instruction was suspended and resumed in between
  let incs = 0;
  const rpr = m.addProbe((pc) => { if (pc === 0x300F) incs++; });
  const dbg = new Emu.Debugger(m);
  dbg.addWatchpoint(0xFF4B, 1, { read: true, write: false });
  let suspended = 0;
  for (let fr = 0; fr < 400 && reads.length < 50; fr++) {
    if (!dbg.runFrame()) { watched.push(dbg.stopReason.value); dbg.resume(); }
    if (m.haltDefer) suspended++;
  }
  check(`held INC $FF4B (${label}): the tap reports each controller read once, with its value, though suspended ${suspended} times`,
    suspended > 0 && reads.length >= 50 && tapped.length === reads.length && tapped.every((v, i) => v === reads[i]), `tap ${tapped.length} controller ${reads.length}`);
  const done = m.haltDefer ? reads.length - 1 : reads.length;
  check(`held INC $FF4B (${label}): the watchpoint beside it still stops once per completed read`,
    watched.length === done && watched.every((v, i) => v === reads[i]), `stops ${watched.length} reads ${reads.length}`);
  check(`held INC $FF4B (${label}): a probe sees each INC once, not again when a suspended one resumes`,
    incs === reads.length, `probe ${incs} INCs for ${reads.length} controller reads`);
  dbg.detach(); rt(); rpr();
  check(`held INC $FF4B (${label}): all off, the bus is intact`, busIntact(m));
}

// ---------------- 5. the Session's probes and taps follow the machine, and are never saved ----------------
(async () => {
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  const m0 = s.shownMachine;
  for (let i = 0; i < 3; i++) m0.runFrame();
  const plain = JSON.stringify(m0.snapshot());
  const probed = [], written = [], read = [];
  const rp = s.hooks.addProbe((pc) => probed.push(pc));
  const rw = s.hooks.addWriteTap({ start: 0, end: 0xFFFF }, (a) => written.push(a));
  const rr = s.hooks.addReadTap({ start: 0x8000, end: 0xFFFF }, (a) => read.push(a));
  const json = JSON.stringify(m0.snapshot());
  const file = await s.snapshotFile();
  check('the Session\'s probes and taps are on the machine in use', m0.probes.length === 1 && m0.busTaps.writes.length === 1 && m0.busTaps.reads.length === 1);
  check('a snapshot taken with them is the snapshot taken without (no probe or tap in the JSON)', json === plain && !/probe|busTaps|pcWatch/.test(json));
  // openSnapshot: a new machine, built from the snapshot, gets them; the old one loses them
  s.openSnapshot(await s.readSnapshot(file.bytes));
  const m1 = s.shownMachine;
  probed.length = 0; written.length = 0; read.length = 0;
  m1.runFrame();
  check('openSnapshot: the restored machine has them (it had none of its own) and they fire', m1 !== m0 && m1.probes.length === 1 && probed.length > 1000 && written.length > 0 && read.length > 0);
  check('openSnapshot: the old machine has none left, its bus intact', m0.probes.length === 0 && m0.pcWatch === null && busIntact(m0));
  // switchMachine: the same, onto another family
  s.switchMachine('coco3', undefined, { menu: false });
  const m2 = s.shownMachine;
  probed.length = 0; written.length = 0;
  m2.runFrame();
  check('switchMachine: the new machine has them and they fire', m2.probes.length === 1 && probed.length > 1000 && written.length > 0 && m2.busTaps.reads.length === 1);
  check('switchMachine: the machine it replaced has none left', m1.probes.length === 0 && busIntact(m1));
  const snap2 = JSON.stringify(m2.snapshot());
  check('the new machine\'s snapshot holds no probe or tap', !/probe|busTaps|pcWatch/.test(snap2));
  rp(); rw(); rr(); rr();
  check('taken off the Session: gone from the machine in use too', m2.probes.length === 0 && m2.pcWatch === null && busIntact(m2));
  s.switchMachine('dragon64', undefined, { menu: false });
  check('...and not put on the next one', s.shownMachine.probes.length === 0 && busIntact(s.shownMachine));

  // ---------------- 6. HostHooks.attach is all or nothing ----------------
  {
    const hooks = new s.hooks.constructor();
    const ma = Emu.createMachine('dragon64'), mb = Emu.createMachine('dragon64');
    hooks.attach(ma);
    hooks.addProbe(() => {});
    hooks.addReadTap({ start: 0, end: 0xFFFF }, () => {});
    hooks.addWriteTap({ start: 0, end: 0xFFFF }, () => {});
    // mb's write is already shadowed by someone else: the write tap (the last hook) can't go on
    const own = (a, v) => Object.getPrototypeOf(mb).write.call(mb, a, v);
    mb.write = own;
    const threw = throws(() => hooks.attach(mb));
    check('attach that fails part way throws and puts back nothing on the new machine', threw && mb.probes.length === 0 && mb.pcWatch === null &&
      !Object.hasOwn(mb, 'read') && mb.write === own && mb.busTaps.reads.length === 0 && mb.busTaps.writes.length === 0);
    check('...and the hooks stay on the machine they were on', hooks.machine === ma && ma.probes.length === 1 && ma.busTaps.reads.length === 1 && ma.busTaps.writes.length === 1);
    delete mb.write;
    hooks.attach(mb);
    check('...from where a later attach moves them as usual', mb.probes.length === 1 && mb.busTaps.writes.length === 1 && ma.probes.length === 0 && busIntact(ma));
  }

  // ---------------- 7. the hooks follow the machine on screen through the chat's views ----------------
  {
    const fs = require('fs'), path = require('path');
    const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
    const backend = () => new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-test' });
    const c = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
    c.switchMachine('dragon64', undefined, { menu: false });
    const basic = c.shownMachine;
    const rp2 = c.hooks.addProbe(() => {});
    const rw2 = c.hooks.addWriteTap({ start: 0, end: 0xFFFF }, () => {});
    const on = (m) => m.probes.length === 1 && m.busTaps.writes.length === 1;
    const off = (m) => m.probes.length === 0 && busIntact(m);
    c.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE });
    const chatM = c.shownMachine;
    check('startChat: the hooks move to the chat machine on screen', chatM !== basic && on(chatM) && off(basic));
    c.showChat('basic');
    check('showChat(basic): back on the BASIC session', c.shownMachine === basic && on(basic) && off(chatM));
    c.showChat('chat');
    check('showChat(chat): on the chat machine again', c.shownMachine === chatM && on(chatM) && off(basic));
    c.toSidePanel();
    check('toSidePanel: on the BASIC session, the chat machine left clean', c.shownMachine === basic && on(basic) && off(chatM));
    c.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE });
    const chatM2 = c.shownMachine;
    c.endChat();
    check('endChat: on the BASIC session, the chat machine left clean', c.shownMachine === basic && on(basic) && off(chatM2) && chatM2 !== basic);
    rp2(); rw2();
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall probe and bus tap tests passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(e); process.exitCode = 1; });
