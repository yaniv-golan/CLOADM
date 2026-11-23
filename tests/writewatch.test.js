// Run: node tests/writewatch.test.js
//
// The memory-write observer (Session.watchWrites, js/writewatch.js; docs/automation.md, "Applying input on a guest
// write"). Oracles: the program's own instructions (STA extended writes A; STD extended A then B; PSHU A,B pushes B to
// U-1 then A to U-2) read from the debugger's trace, cross-checked with its write watchpoint; the time of each write
// from a separate bus tap reading the machine's access time (ioTime, MAME-verified) at the write, which must fall in
// the instruction's own time on the SAM's three rates and the CoCo 3's two speeds; the guest's own record of
// what its keyboard read saw; an unobserved run of the same machine for "changes nothing"; the disk controller's HALT
// for the CoCo 3's held instruction (set-up as in tests/probes.test.js).
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const asm = (text, cpu = '6809') => {
  const r = Emu.assemble(text, cpu);
  if (!r.ok) throw new Error('test firmware does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
const session = (id) => { const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false }); s.switchMachine(id, undefined, { menu: false }); return s; };
const busIntact = (m) => { const p = Object.getPrototypeOf(m); return !Object.hasOwn(m, 'read') && !Object.hasOwn(m, 'write') && m.read === p.read && m.write === p.write; };
const key = (e) => `${e.address.toString(16)}=${e.value.toString(16)} old ${e.old.toString(16)} pc ${e.pc.toString(16)} at ${e.at} f${e.frame}`;

// the marker writer: one write (STA), two (STD), two pushed (PSHU), at known PCs; interrupts off
const MARK = 0x3100;
const WRITER = asm(`MARK    EQU     $3100
        ORG     $3000
START   ORCC    #$50
        LDU     #MARK+4
        LDA     #$11
LOOP    STA     MARK
        LDB     #$34
        STD     MARK
        PSHU    A,B
        LEAU    2,U
        INCA
        BRA     LOOP
        END     START`);
const SYM = WRITER.symbols;
const PC_STA = SYM.get('LOOP'), PC_STD = PC_STA + 5, PC_PSHU = PC_STD + 3;
const started = (id = 'dragon64') => { const s = session(id); s.runAssembled(WRITER); s.runFrames(1); return s; };

// ---------------- 1. the events are the program's writes, as the debugger's trace gives them ----------------
// ev.at is the machine's ioTime at the write. On the SAM machines at the slow rate it is the instruction's start plus the
// CPU core's cycle count at the access, less one: the start of the instruction's last cycle for an instruction whose count
// the core charges whole at its start (STA, STD: the model checked against MAME), and the count so far for one it charges
// as it goes (PSHU: its pushes at its 5th and 6th cycles of 7). At the address-dependent and fast rates it is the access's
// own cycle through the SAM's stepTime; on the CoCo 3 it is in GIME clocks. In every case it falls in the instruction's own
// time, from the tick it started at to the tick the next one starts at.
const RATES = [
  ['dragon64', 'slow rate', null], ['dragon64', 'address-dependent rate', 0xFFD7], ['dragon64', 'fast rate', 0xFFD9],
  ['coco3', '0.89 MHz', null], ['coco3', '1.79 MHz', 0xFFD9],
];
for (const [id, rate, poke] of RATES) {
  const s = started(id);
  const m = s.shownMachine, d = s.debug;
  if (poke !== null) m.write(poke, 0);
  const events = [];
  const w = s.watchWrites({ start: MARK, end: MARK + 3 }, (ev) => events.push(ev));
  // the oracle: step 300 instructions with the debugger; from each trace entry (pc, registers before, cycles) the writes
  // the instruction makes; the write watchpoint cross-checks the first one of each instruction
  d.addWatchpoint(MARK, 4, { read: false, write: true });
  const mem = [0, 1, 2, 3].map((i) => s.readByte(MARK + i));
  const expected = [], times = [];
  const rt = m.busTaps.addWriteTap({ start: MARK, end: MARK + 3 }, () => times.push(m.ioTime()));
  let watched = 0, agree = 0, timed = true, lastCycle = true;
  for (let i = 0; i < 300; i++) {
    const c0 = m.cycle, frame = m.frameCount;
    d.step();
    const c1 = m.cycle, t = d.trace().at(-1);
    const out = [];
    const wr = (address, value) => {
      const at = times[expected.length + out.length];
      if (!(at >= c0 && at < c1) || (out.length && at < out.at(-1).at)) timed = false;
      if (t.pc === PC_PSHU ? at !== c0 + 4 + out.length : at !== c1 - 1) lastCycle = false;
      out.push({ address, value, old: mem[address - MARK], pc: t.pc, at, frame }); mem[address - MARK] = value;
    };
    if (t.pc === PC_STA) wr(MARK, t.a);
    else if (t.pc === PC_STD) { wr(MARK, t.a); wr(MARK + 1, 0x34); }
    else if (t.pc === PC_PSHU) { wr(t.u - 1, t.b); wr(t.u - 2, t.a); }
    if (out.length) {
      if (t.cycles !== { [PC_STA]: 5, [PC_STD]: 6, [PC_PSHU]: 7 }[t.pc]) check(`${id} ${rate}: instruction ${i}: the data sheet's cycle count (${t.cycles})`, false);
      watched++;
      const r = d.stopReason;
      if (r && r.kind === 'watchpoint' && r.address === out[0].address && r.value === out[0].value) agree++;
    }
    expected.push(...out);
  }
  const tag = `${id} ${rate}`;
  check(`${tag}: the debugger's write watchpoint saw the first write of every writing instruction`, watched > 100 && agree === watched, `${agree}/${watched}`);
  check(`${tag}: the events are the writes the trace gives: address, value, old, pc, at, frame, in bus order`,
    events.length === expected.length && times.length === expected.length && events.every((e, i) => key(e) === key(expected[i])),
    `${events.length} vs ${expected.length}: ${events.slice(0, 3).map(key)} / ${expected.slice(0, 3).map(key)}`);
  check(`${tag}: each write is timed within its own instruction, in bus order`, timed);
  if (id === 'dragon64' && poke === null) check(`${tag}: STA and STD writes at the start of the instruction's last cycle; PSHU's at its 5th and 6th`, lastCycle);
  if (id === 'dragon64' && poke !== null) check(`${tag}: not every write at the last cycle (the access's own cycle)`, !lastCycle);
  rt();
  w.remove();
  w.remove();
  d.clearWatchpoints();
  check(`${tag}: removed (twice): no probe, no run-end hook, the bus intact`, m.pcWatch === null && m.runEndWatch === null && busIntact(m));
}

// ---------------- 1b. remove() inside a callback ----------------
// An observer that removes itself on the STD's first byte gets nothing more, not even the STD's second byte (already
// queued); another observer of the same bytes still gets both.
{
  const s = started('dragon64');
  const a = [], b = [];
  const wa = s.watchWrites({ start: MARK, end: MARK + 1 }, (e) => { a.push(e); if (e.pc === PC_STD) wa.remove(); });
  s.watchWrites({ start: MARK, end: MARK + 1 }, (e) => b.push(e));
  s.runFrames(2);
  const std = b.filter((e) => e.pc === PC_STD);
  check('an observer removed in its callback gets nothing more, not the rest of the instruction\'s writes either',
    a.length === 2 && a[0].pc === PC_STA && a[1].pc === PC_STD && a[1].address === MARK, a.map(key).join(' | '));
  check('the other observer still gets both bytes of every STD', std.length > 100 && std.length % 2 === 0 && std.every((e, i) => e.address === MARK + (i & 1)));
}

// ---------------- 2. a stepped run and free runs give identical events ----------------
{
  const runs = {};
  for (const how of ['session', 'bare runFrame', 'debugger']) {
    const s = started('dragon64');
    const ev = [], m = s.shownMachine;
    s.watchWrites({ start: MARK, end: MARK + 3 }, (e) => { ev.push(e); if (m.inStep || s.readByte(e.address) !== e.value) ev.bad = true; });
    if (how === 'debugger') s.debug.addBreakpoint(0xFFF0);    // armed: every frame runs through the debugger's steps
    let frames = 0;
    for (let i = 0; i < 6; i++) {
      if (how === 'bare runFrame') { m.runFrame(); frames++; } else frames += s.runFrames(1);
      check(`${how}: frame ${i}: everything written was delivered by the frame's end`, ev.length > 0 && m.busTaps.writes.length === 1, '');
    }
    runs[how] = { ev, frames, pic: Array.from(m.render().data).join() };
  }
  const base = runs.session.ev.map(key);
  for (const how of ['bare runFrame', 'debugger']) {
    check(`${how} gives the same events as the Session's run (${base.length})`, runs[how].ev.map(key).join('|') === base.join('|') && runs[how].frames === 6);
    check(`${how}: every callback ran between instructions, after the write landed`, !runs[how].ev.bad);
  }
  check('the Session\'s run: every callback ran between instructions, after the write landed', !runs.session.ev.bad && base.length > 1000);
}

// ---------------- 3. a write in a frame's last instruction arrives before the frame closes ----------------
// A bare machine.runFrame(): only the run-end hook can deliver it (the next probe is in the next frame).
{
  const s = started('dragon64');
  const m = s.shownMachine;
  let lastPc = -1, raw = 0, lastFrameWrites = 0;
  const rp = m.addProbe((pc) => { lastPc = pc; });
  const rt = m.busTaps.addWriteTap({ start: MARK, end: MARK + 3 }, () => raw++);
  const ev = [];
  s.watchWrites({ start: MARK, end: MARK + 3 }, (e) => ev.push(e));
  let ok = true, endWriters = 0;
  for (let i = 0; i < 200; i++) {
    const f = m.frameCount;
    m.runFrame();
    if (ev.length !== raw) ok = false;
    if ([PC_STA, PC_STD, PC_PSHU].includes(lastPc)) {
      endWriters++;
      if (ev.at(-1).frame !== f || ev.at(-1).pc !== lastPc) ok = false;
      lastFrameWrites++;
    }
  }
  rp(); rt();
  check(`every write is delivered before its frame closes, with its frame (${endWriters} frames ended on a writer)`, ok && endWriters > 5 && lastFrameWrites === endWriters, `${ev.length} vs ${raw}`);
}

// ---------------- 4. input from the callback is seen by the guest's next keyboard read ----------------
// docs/examples/framecount.asm with a frame-complete marker: each tick counts FRAME, writes it to DONE, then reads the
// keyboard matrix; a tick that finds SPACE down records FRAME in KEYSEEN (and counts the ticks it was down in HELD).
const MARKER = asm(`FRAME   EQU     $3100
KEYSEEN EQU     $3101
DONE    EQU     $3102
HELD    EQU     $3103
        ORG     $3000
START   ORCC    #$50
        CLR     FRAME
        CLR     KEYSEEN
        CLR     HELD
TICK    LDA     $FF02
WAITFS  LDA     $FF03
        BPL     WAITFS
        INC     FRAME
        LDA     FRAME
        STA     DONE
        LDA     #%01111111
        STA     $FF02
        LDA     $FF00
        ANDA    #%00101000
        CMPA    #%00101000
        BEQ     NOKEY
        LDA     FRAME
        STA     KEYSEEN
        INC     HELD
NOKEY   LDA     #$FF
        STA     $FF02
        BRA     TICK
        END     START`);
for (const id of ['dragon64', 'coco']) {
  const s = session(id);
  s.runAssembled(MARKER);
  const m = s.shownMachine;
  const seen = [];
  s.watchWrites({ start: 0x3102, end: 0x3102 }, (ev) => {
    seen.push(ev.value);
    if (ev.value === 20) m.setKey('SPACE', true);
    if (ev.value === 23) m.setKey('SPACE', false);
  });
  s.runFrames(40);
  check(`${id}: the key pressed at marker 20 and released at marker 23 is seen by exactly ticks 20, 21 and 22`,
    s.readByte(0x3103) === 3 && s.readByte(0x3101) === 22 && seen.includes(25), `held ${s.readByte(0x3103)} keyseen ${s.readByte(0x3101)}`);
}

// ---------------- 5. 'stop' stops the run after the writing instruction; resume goes on ----------------
{
  for (const how of ['session', 'debugger']) {
    const s = started('dragon64');
    const m = s.shownMachine;
    if (how === 'debugger') s.debug.addBreakpoint(0xFFF0);
    const ev = [];
    let stopAt = null;
    s.watchWrites({ start: MARK, end: MARK + 3 }, (e) => { ev.push(e); if (e.pc === PC_STD && e.value === 0x34 && stopAt === null) { stopAt = ev.length; return 'stop'; } return undefined; });
    const f = m.frameCount;
    const n = s.runFrames(5);
    const r = s.debug.stopReason;
    check(`${how}: 'stop' pauses the Session part way through the frame`, s.paused && n === 0 && m.frameCount === f && r && r.kind === 'write');
    check(`${how}: stopped after the STD, before the PSHU`, m.cpu.pc === PC_PSHU && r.pc === PC_PSHU && r.writer === PC_STD && r.address === MARK + 1 && ev.length === stopAt, `pc ${m.cpu.pc.toString(16)}`);
    s.debug.resume();
    s.runFrames(2);
    check(`${how}: resumed, the next event is the PSHU's first push, nothing twice`, ev[stopAt].pc === PC_PSHU && ev[stopAt].address === MARK + 3 && !s.paused);
  }
}

// the MC-10 too: its runFrame passes the run on (it once dropped it, so a debugger stop never stopped a running MC-10)
{
  const prog = asm(`        ORG     $4C00
START   SEI
LOOP    INCA
HERE    STAA    $4100
NEXT    BRA     LOOP
        END     START`, '6803');
  for (const how of ['write', 'breakpoint']) {
    const s = session('mc10');
    s.runAssembled(prog);
    s.runFrames(1);
    if (how === 'breakpoint') s.debug.addBreakpoint(prog.symbols.get('HERE'));
    else s.watchWrites({ start: 0x4100, end: 0x4100 }, (e) => (e.value === 0x40 ? 'stop' : undefined));
    const f = s.shownMachine.frameCount, n = s.runFrames(5);
    const pc = how === 'breakpoint' ? prog.symbols.get('HERE') : prog.symbols.get('NEXT');
    check(`mc10: a ${how} stop stops runFrames part way through a frame`, s.paused && n === 0 && s.shownMachine.frameCount === f && s.shownMachine.cpu.pc === pc, `ran ${n}, pc ${s.shownMachine.cpu.pc.toString(16)}`);
  }
}

// ---------------- 6. what the callback may not do; what is not reported ----------------
{
  const s = started('dragon64');
  const errs = [];
  const w = s.watchWrites({ start: MARK, end: MARK }, () => {
    if (errs.length) return;
    try { s.switchMachine('coco', undefined, { menu: false }); errs.push('switched'); } catch (e) { errs.push(e instanceof Emu.SessionError ? 'switch refused' : e.message); }
    try { s.openSnapshot({}); errs.push('opened'); } catch (e) { errs.push(e instanceof Emu.SessionError && /watchWrites/.test(e.message) ? 'open refused' : e.message); }
    s.snapshotFile().then(() => errs.push('snapshot taken'), (e) => errs.push(e instanceof Emu.SessionError ? 'snapshot refused' : e.message));
    s.pokeBytes(MARK, [0x99]);     // a poke is not the CPU's bus write: not reported
  });
  s.runFrames(1);
  setTimeout(() => {
    check('switchMachine, openSnapshot and snapshotFile in a callback are SessionErrors; the machine stayed', errs.join() === 'switch refused,open refused,snapshot refused' && s.shownMachine.id === 'dragon64', errs.join());
    w.remove();
  }, 0);
  const s2 = started('dragon64');
  const ev = [];
  s2.watchWrites({ start: 0x3F00, end: 0x3F0F }, (e) => ev.push(e));
  s2.pokeBytes(0x3F00, [1, 2, 3]);
  s2.debug.write(0x3F04, [4]);
  s2.runFrames(2);
  check('Session pokes and the debugger\'s writes are not reported', ev.length === 0 && s2.readByte(0x3F04) === 4);
  check('a bad range or callback is a SessionError', [() => s2.watchWrites({ start: 5, end: 4 }, () => {}), () => s2.watchWrites({ start: 0, end: 0x10000 }, () => {}), () => s2.watchWrites({ start: 0, end: 1 })]
    .every((f) => { try { f(); return false; } catch (e) { return e instanceof Emu.SessionError; } }));
}

// ---------------- 7. a no-op observer changes nothing; zero cost when unused ----------------
const MC10 = asm(`        ORG     $4C00
START   SEI
        LDX     #$4100
LOOP    STAA    0,X
        INCA
        STAA    $4101
        BRA     LOOP
        END     START`, '6803');
for (const id of ['dragon64', 'coco3', 'mc10']) {
  const prog = id === 'mc10' ? MC10 : MARKER;
  const run = (observe) => {
    const s = session(id);
    s.runAssembled(prog);
    const m = s.shownMachine, trace = [];
    m.addProbe((pc) => trace.push(pc, m.cycle, m.cpu.a, m.cpu.b));
    let n = 0;
    if (observe) s.watchWrites({ start: 0, end: 0xFFFF }, () => { n++; });
    if (id !== 'mc10') m.setKey('SPACE', true);
    s.runFrames(30);
    return { trace: trace.join(), pic: Array.from(m.render().data).join(), snap: JSON.stringify(m.snapshot()), n, s };
  };
  const a = run(false), b = run(true);
  check(`${id}: an observer of every address leaves the instruction stream and the frames identical (${b.n} writes seen)`, a.trace === b.trace && a.pic === b.pic && b.n > 100);
  check(`${id}: and the snapshot identical (observers are host state)`, a.snap === b.snap);
  const m = a.s.shownMachine;
  check(`${id}: unused, the machine has no run-end hook and its own bus`, m.runEndWatch === null && busIntact(m) && !a.s.writeWatch.active);
}

// ---------------- 8. observers follow the machine; not in snapshots ----------------
// ---------------- a full-screen chat: observers are on the person's machine ----------------
// With the Claude chat full screen the chat machine is on screen and the person's (the BASIC session) runs beside it.
// watchWrites observes the person's machine: docs/examples/framecount.asm on the BASIC session counts FRAME ($3100)
// once a field, and each INC is one event, stamped with the BASIC machine's frame. A 'stop' belongs to the machine that
// wrote: it freezes the BASIC session right after the writing instruction while the chat machine runs on, and the page
// is told ('writeStop'); back in the side panel it is that machine's debugger stop, and step and resume act on it.
{
  const fsx = require('fs'), pathx = require('path');
  const firmware = new Uint8Array(fsx.readFileSync(pathx.join(__dirname, '..', 'examples/chat.bin')));
  const prog = Emu.assemble(fsx.readFileSync(pathx.join(__dirname, '..', 'docs/examples/framecount.asm'), 'utf8'), '6809');
  const fs3 = new Emu.Session({ welcomeMenu: false, store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  fs3.switchMachine('dragon64', {}, { menu: false });
  const basic = fs3.shownMachine;
  fs3.runAssembled(prog);
  fs3.runFrames(5);
  fs3.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware, brief: '', tools: false });
  const chatM = fs3.shownMachine;
  const WAITFS = prog.symbols.get('WAITFS'), INCPC = WAITFS + 5, AFTER = WAITFS + 8;   // LDA ext (3), BPL (2), INC ext (3)
  const evs = [];
  const w = fs3.watchWrites({ start: 0x3100, end: 0x3100 }, (ev) => { evs.push(ev); return ev.value === 12 ? 'stop' : undefined; });
  check('full screen: the chat machine on screen, the observer\'s tap on the BASIC session', chatM !== basic && fs3.personMachine === basic && basic.busTaps.writes.length === 1 && chatM.busTaps.writes.length === 0);
  const told = [];
  fs3.on((ev, arg) => { if (ev === 'writeStop') told.push(arg); });
  const c0 = chatM.frameCount;
  const n = fs3.runFrames(20);
  check('full screen: each of the BASIC guest\'s INC FRAME is an event, from its PC, stamped with the BASIC machine\'s frame',
    evs.length > 3 && evs.every((e, k) => e.pc === INCPC && (k === 0 || e.value === ((evs[k - 1].value + 1) & 0xFF))) && evs[evs.length - 1].frame === basic.frameCount,
    `${evs.length} events, last ${JSON.stringify(evs[evs.length - 1])}`);
  check('full screen: \'stop\' at FRAME 12: the chat runs all 20 frames, unpaused, and the BASIC machine is frozen right after that INC',
    n === 20 && chatM.frameCount === c0 + 20 && !fs3.paused && basic.ram[0x3100] === 12 && basic.cpu.pc === AFTER && evs[evs.length - 1].value === 12,
    `ran ${n}, chat +${chatM.frameCount - c0}, paused ${fs3.paused}, pc $${basic.cpu.pc.toString(16)}, FRAME ${basic.ram[0x3100]}`);
  check('full screen: the stop is kept for the BASIC machine, not given to the chat machine\'s debugger, and the page is told once',
    fs3.pendingStop && fs3.pendingStop.machine === basic && !(fs3.debugger && fs3.debugger.stopped) && told.length === 1 && told[0].address === 0x3100 && told[0].value === 12,
    JSON.stringify(told));
  const frozen = { pc: basic.cpu.pc, frame: basic.frameCount, cycles: basic.cpu.totalCycles, events: evs.length };
  fs3.runFrames(5);
  check('full screen: the BASIC machine stays frozen while the chat machine runs on',
    basic.cpu.pc === frozen.pc && basic.frameCount === frozen.frame && basic.cpu.totalCycles === frozen.cycles && evs.length === frozen.events && chatM.frameCount === c0 + 25);
  fs3.toSidePanel();
  const r = fs3.debug.stopReason || {};
  check('side panel: the BASIC machine on screen, paused on its own debugger right after the write, with the write\'s reason',
    fs3.shownMachine === basic && fs3.paused && fs3.debug.machine === basic && r.kind === 'write' && r.address === 0x3100 && r.value === 12 && r.pc === AFTER && r.writer === INCPC && !fs3.pendingStop,
    JSON.stringify(r));
  const s0 = basic.cpu.totalCycles;
  fs3.debug.step();
  check('side panel: step moves the BASIC machine one instruction', basic.cpu.pc !== AFTER && basic.cpu.totalCycles > s0, `$${basic.cpu.pc.toString(16)}`);
  fs3.debug.resume();
  fs3.runFrames(3);
  check('side panel: resumed, the BASIC guest goes on counting', !fs3.paused && basic.ram[0x3100] > 12, `${basic.ram[0x3100]}`);
  w.remove();
  check('full screen: removed, neither machine keeps a tap', basic.busTaps.writes.length === 0 && chatM.busTaps.writes.length === 0);
}

// ---------------- a restart or a new program releases a write stop held beside a full-screen chat ----------------
// The stop is about the program that wrote. A power cycle, a load or runAssembled on the frozen BASIC session starts
// something new there: the stop is dropped, the machine runs again, and the side panel shows no stale write stop. A
// machine switch replaces the machine, so its stop goes too.
{
  const fsx = require('fs'), pathx = require('path');
  const firmware = new Uint8Array(fsx.readFileSync(pathx.join(__dirname, '..', 'examples/chat.bin')));
  const prog = Emu.assemble(fsx.readFileSync(pathx.join(__dirname, '..', 'docs/examples/framecount.asm'), 'utf8'), '6809');
  const LOOP = Emu.assemble(' ORG $3800\nL INC $3900\n BRA L\n END L', '6809');
  // a Dragon 64 running framecount.asm, a full-screen chat, and a watchWrites 'stop' at FRAME 12 that froze it. With
  // roms, the machine runs this project's own reset firmware (tests/fixtures/reset-firmware.js) as its BASIC: a
  // program started there is not a reset (the built-in firmware's start is one, and a reset releases the stop too)
  const { basic: FAKE_BASIC, basic64: FAKE_BASIC64 } = require('./fixtures/reset-firmware').build(Emu);
  const frozen = (roms = false) => {
    const s = new Emu.Session({ welcomeMenu: false, store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
    s.switchMachine('dragon64', {}, { menu: false });
    if (roms) { s.addRoms([{ name: 'd64_1.rom', bytes: FAKE_BASIC }, { name: 'd64_2.rom', bytes: FAKE_BASIC64 }]); s.powerCycle({ menu: false }); s.runFrames(5); }
    if (s.shownMachine.useStub === roms) throw new Error(roms ? 'the reset firmware is not in' : 'not on the built-in firmware');
    const basic = s.shownMachine;
    s.runAssembled(prog);
    s.runFrames(5);
    s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware, brief: '', tools: false });
    s.watchWrites({ start: 0x3100, end: 0x3100 }, (ev) => (ev.value === 12 ? 'stop' : undefined));
    s.runFrames(20);
    if (!s.pendingStop || s.pendingStop.machine !== basic) throw new Error('no write stop to release');
    return { s, basic };
  };
  // after the action: no stop kept, the BASIC session runs on beside the chat, and the side panel shows no write stop
  const released = (label, act, runs, roms = false) => {
    const { s, basic } = frozen(roms);
    const resets = basic.resetAt;
    act(s, basic);
    if (roms && basic.resetAt !== resets) throw new Error(`${label}: the machine was reset, so this does not test the start on its own`);
    const c0 = basic.cpu.totalCycles;
    s.runFrames(3);
    const ran = basic.cpu.totalCycles > c0 && runs(basic);
    s.toSidePanel();
    const r = s.debugger && s.debugger.stopReason;
    check(`${label}: the write stop is released, the BASIC session runs again, and the side panel shows no stale write stop`,
      !s.pendingStop && ran && !s.paused && !(r && r.kind === 'write'), JSON.stringify({ pending: !!s.pendingStop, ran, paused: s.paused, reason: r }));
  };
  released('full screen, power cycle', (s) => s.powerCycle({ menu: false }), () => true);
  released('full screen, a load', (s) => s.load('loop.bin', Emu.toBinary(LOOP, { format: 'dragondos' }), { remember: false }), (m) => m.ram[0x3900] !== 0);
  released('full screen, runAssembled', (s) => s.runAssembled(LOOP), (m) => m.ram[0x3900] !== 0);
  released('full screen, a load with ROMs (no reset)', (s) => s.load('loop.bin', Emu.toBinary(LOOP, { format: 'dragondos' }), { remember: false }), (m) => m.ram[0x3900] !== 0, true);
  released('full screen, runAssembled with ROMs (no reset)', (s) => s.runAssembled(LOOP), (m) => m.ram[0x3900] !== 0, true);
  // a Reset of the screen restarts the chat machine on screen, not the frozen BASIC session: its stop is kept, it stays
  // frozen, and the side panel presents the stop
  {
    const { s, basic } = frozen();
    const chatM = s.shownMachine, chatReset = chatM.resetAt, before = basic.cpu.totalCycles;
    s.reset();
    s.runFrames(3);
    const kept = s.pendingStop && s.pendingStop.machine === basic && basic.cpu.totalCycles === before;
    s.toSidePanel();
    const r = s.debugger && s.debugger.stopReason;
    check('full screen, a Reset of the screen (the chat machine): the BASIC session\'s stop is kept, it stays frozen, and the side panel presents it',
      chatReset !== chatM.resetAt && kept && s.paused && r && r.kind === 'write' && r.value === 12,
      JSON.stringify({ chatReset: chatM.resetAt !== chatReset, kept, paused: s.paused, reason: r }));
  }
  // a program the machine asked for itself (the welcome menu's choice, started under the ticket taken when it asked:
  // asMachine) is started with Claude's exemption, which returns from stopClaudeFor early: it still releases the stop
  {
    const { s, basic } = frozen(true);
    s.claudeActing = true; s.chat.busy = true;            // Claude acting, as when the menu's keys were Claude's
    const ticket = s.machineTicket();
    if (!ticket.claude) throw new Error('the ticket does not hold: this would not reach the exemption');
    s.asMachine(() => s.runAssembled(LOOP), ticket);
    s.claudeActing = null; s.chat.busy = false;
    const c0 = basic.cpu.totalCycles;
    s.runFrames(3);
    check('full screen, a program started under a menu ticket that holds (stopClaudeFor returns early): the write stop is still released',
      !s.pendingStop && basic.cpu.totalCycles > c0 && basic.ram[0x3900] !== 0, JSON.stringify({ pending: !!s.pendingStop }));
  }
  {
    const { s } = frozen();
    s.switchMachine('coco', {}, { menu: false });
    check('a machine switch drops the write stop of the machine it replaces', !s.pendingStop && !s.paused && !(s.debugger && s.debugger.stopped));
  }
}

(async () => {
  const s = started('dragon64');
  const ev = [];
  s.watchWrites({ start: MARK, end: MARK }, (e) => ev.push(e));
  s.runFrames(1);
  const { bytes } = await s.snapshotFile();
  s.switchMachine('coco', undefined, { menu: false });
  s.runAssembled(WRITER);
  ev.length = 0;
  s.runFrames(1);
  check('after switchMachine, the observer is on the new machine', ev.length > 10 && ev.every((e) => e.pc === PC_STA || e.pc === PC_STD));
  s.openSnapshot(await s.readSnapshot(bytes));
  ev.length = 0;
  s.runFrames(1);
  check('after openSnapshot, the observer is on the restored machine', s.shownMachine.id === 'dragon64' && ev.length > 10);
  const t = session('dragon64');
  t.openSnapshot(await t.readSnapshot(bytes));
  check('a snapshot taken while observed restores with no observer', !t.writeWatch.active && t.shownMachine.pcWatch === null && busIntact(t.shownMachine));
})().then(() => heldTest()).catch((e) => { fail++; console.log('FAIL', e.stack); }).finally(() => setTimeout(() => {
  console.log(fail ? `${fail} FAILED` : 'all write-observer checks passed');
  process.exitCode = fail ? 1 : 0;
}, 0));

// ---------------- 9. the CoCo 3's instruction held by HALT: each write reported once, after it completes ----------------
// STD $FEFF writes A to $FEFF (RAM) and then B to $FF00 (I/O); the disk controller's HALT (a read sector on a drive
// whose DRQ comes slowly) holds the I/O access, the frame ends and the instruction is suspended; when it runs again
// its $FEFF write is replayed, not made again. LDA $FF4B takes each byte.
function heldTest() {
  for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
    for (const how of ['session', 'bare runFrame']) {
      const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
      s.switchMachine('coco3', config, { menu: false });
      const m = s.shownMachine;
      const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
      m.insertCartridge(f);
      m.reset(true);
      f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
      f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
      for (let i = 0; i < 3; i++) m.runFrame();
      m.write(0xFF40, 0x29);
      for (let i = 0; i < 30; i++) m.runFrame();
      // LDB #4 / STB $FF4A / LDB #$80 / STB $FF48 / LDB #$AA / STB $FF40 / loop: INCA / STD $FEFF / LDB $FF4B / BRA loop
      [0xC6, 4, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0xAA, 0xF7, 0xFF, 0x40,
        0x4C, 0xFD, 0xFE, 0xFF, 0xF6, 0xFF, 0x4B, 0x20, 0xF7].forEach((b, i) => m.poke(0x3000 + i, b));
      m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
      const STD_PC = 0x3010;
      let stds = 0, held = 0, suspended = 0;
      m.addProbe((pc) => { if (pc === STD_PC) stds++; });
      const ev = [];
      s.watchWrites({ start: 0xFEFF, end: 0xFEFF }, (e) => { ev.push(e); if (m.cpuHeld || m.inStep) held++; });
      for (let fr = 0; fr < 300 && ev.length < 60; fr++) {
        if (how === 'session') s.runFrames(1); else m.runFrame();
        if (m.haltDefer) suspended++;
      }
      const done = stds - (m.cpuHeld ? 1 : 0);   // (one held now has had its probe, not its delivery)
      check(`held STD (${label}, ${how}): suspended ${suspended} times, each completed STD's $FEFF write reported once`,
        suspended > 0 && ev.length >= 60 && ev.length === done && ev.every((e, i) => e.pc === STD_PC && (i === 0 || e.value === ((ev[i - 1].value + 1) & 0xFF))),
        `events ${ev.length} STDs ${stds} held now ${m.cpuHeld}`);
      check(`held STD (${label}, ${how}): no callback while the instruction was held`, held === 0);
    }
  }
}
