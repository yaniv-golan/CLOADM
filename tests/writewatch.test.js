// Run: node tests/writewatch.test.js
//
// The memory-write observer (Session.watchWrites, js/writewatch.js; docs/automation.md, "Applying input on a guest
// write"). Oracles: the program's own instructions (STA extended writes A; STD extended A then B; PSHU A,B pushes B to
// U-1 then A to U-2) read from the debugger's trace, cross-checked with its write watchpoint; the time of each write
// from a separate bus tap reading the machine's access time (ioTime, MAME-verified) at the write, which must fall in
// the instruction's own cycles as the trace counts them; the guest's own record of
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

// ---------------- 1. the events are the program's writes, as the data sheet and the debugger's trace give them ----------------
{
  const s = started();
  const m = s.machine, d = s.debug;
  const events = [];
  const w = s.watchWrites({ start: MARK, end: MARK + 3 }, (ev) => events.push(ev));
  // the oracle: step 300 instructions with the debugger; from each trace entry (pc, registers before, cycles) and the
  // cycle it started at, the writes the data sheet says the instruction makes; the write watchpoint cross-checks the
  // first one of each instruction
  d.addWatchpoint(MARK, 4, { read: false, write: true });
  const mem = [0, 1, 2, 3].map((i) => s.readByte(MARK + i));
  const expected = [], times = [];
  const rt = m.busTaps.addWriteTap({ start: MARK, end: MARK + 3 }, () => times.push(m.ioTime()));
  let watched = 0, agree = 0;
  for (let i = 0; i < 300; i++) {
    const c0 = m.cycle, frame = m.frameCount;
    d.step();
    const t = d.trace().at(-1);
    const out = [];
    const wr = (address, value) => {
      const at = times[expected.length + out.length];
      if (!(at >= c0 && at < c0 + t.cycles)) out.bad = true;
      out.push({ address, value, old: mem[address - MARK], pc: t.pc, at, frame }); mem[address - MARK] = value;
    };
    if (t.pc === PC_STA) wr(MARK, t.a);
    else if (t.pc === PC_STD) { wr(MARK, t.a); wr(MARK + 1, 0x34); }
    else if (t.pc === PC_PSHU) { wr(t.u - 1, t.b); wr(t.u - 2, t.a); }
    if (out.bad) check(`instruction ${i} at ${t.pc.toString(16)}: its writes are timed within its own cycles`, false);
    if (out.length) {
      check(`instruction ${i}: the data sheet's cycle count (${t.cycles})`, t.cycles === { [PC_STA]: 5, [PC_STD]: 6, [PC_PSHU]: 7 }[t.pc]);
      watched++;
      const r = d.stopReason;
      if (r && r.kind === 'watchpoint' && r.address === out[0].address && r.value === out[0].value) agree++;
    }
    expected.push(...out);
  }
  check('the debugger\'s write watchpoint saw the first write of every writing instruction', watched > 100 && agree === watched, `${agree}/${watched}`);
  check('the events are the writes the trace gives, timed as the bus made them: address, value, old, pc, at, frame, in bus order',
    events.length === expected.length && events.every((e, i) => key(e) === key(expected[i])),
    `${events.length} vs ${expected.length}: ${events.slice(0, 3).map(key)} / ${expected.slice(0, 3).map(key)}`);
  check('every write was timed', times.length === expected.length);
  rt();
  w.remove();
  w.remove();
  d.clearWatchpoints();
  check('removed (twice): no probe, no run-end hook, the bus intact', m.pcWatch === null && m.runEndWatch === null && busIntact(m));
}

// ---------------- 2. a stepped run and free runs give identical events ----------------
{
  const runs = {};
  for (const how of ['session', 'bare runFrame', 'debugger']) {
    const s = started('dragon64');
    const ev = [], m = s.machine;
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
  const m = s.machine;
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
  const m = s.machine;
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
    const m = s.machine;
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
    const f = s.machine.frameCount, n = s.runFrames(5);
    const pc = how === 'breakpoint' ? prog.symbols.get('HERE') : prog.symbols.get('NEXT');
    check(`mc10: a ${how} stop stops runFrames part way through a frame`, s.paused && n === 0 && s.machine.frameCount === f && s.machine.cpu.pc === pc, `ran ${n}, pc ${s.machine.cpu.pc.toString(16)}`);
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
    check('switchMachine, openSnapshot and snapshotFile in a callback are SessionErrors; the machine stayed', errs.join() === 'switch refused,open refused,snapshot refused' && s.machine.id === 'dragon64', errs.join());
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
    const m = s.machine, trace = [];
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
  const m = a.s.machine;
  check(`${id}: unused, the machine has no run-end hook and its own bus`, m.runEndWatch === null && busIntact(m) && !a.s.writeWatch.active);
}

// ---------------- 8. observers follow the machine; not in snapshots ----------------
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
  check('after openSnapshot, the observer is on the restored machine', s.machine.id === 'dragon64' && ev.length > 10);
  const t = session('dragon64');
  t.openSnapshot(await t.readSnapshot(bytes));
  check('a snapshot taken while observed restores with no observer', !t.writeWatch.active && t.machine.pcWatch === null && busIntact(t.machine));
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
      const m = s.machine;
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
