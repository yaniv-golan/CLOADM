// Run: node tests/debug-session.test.js
//
// The debugger through the Session: a front end talks to Session.debug, never to a
// Debugger directly, so the page and an embedder use the same path and the Session owns the lifetime of the
// debugger across a machine switch. Here:
//  * the Session makes a debugger for the machine in use, for the right CPU, and replaces it on a switch;
//  * breakpoints, watchpoints, stepping and the trace work through the Session;
//  * a program that came from the built-in assembler shows its symbols in the disassembly, and a program
//    that did not shows plain addresses;
//  * the debugger's breakpoints and watchpoints travel in the machine's snapshot, and a restored machine's
//    debugger stops at the same place;
//  * errors come back as SessionError (a message for the user), not as a crash.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return (e instanceof Emu.SessionError) && (!re || re.test(e.message)); } };
const h = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

const PROGRAM = `
START   LDA     #$00
        STA     $4000
LOOP    INCA
        CMPA    #$03
        BNE     LOOP
        STA     $4001
HALT    BRA     HALT
`;
const asmRun = (s, text, cpu = '6809', id = 'dragon64', org = 0x3000) => {
  const r = Emu.assemble(` ORG $${org.toString(16)}\n` + text + '\n', cpu);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  s.switchMachine(id);
  s.runAssembled(r);
  return r;
};

// ---- 1. the Session makes and replaces the debugger with the machine ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const d1 = s.debug;
  check('the Session makes a debugger for the machine in use', d1 instanceof Emu.Debugger && d1.machine === s.machine);
  check('the debugger knows the CPU', d1.cpu === '6809', d1.cpu);
  check('asking twice gives the same debugger', s.debug === d1);
  s.switchMachine('coco3');
  check('switching machine makes a new debugger for the new machine', s.debug !== d1 && s.debug.machine === s.machine);
  check('the old debugger was detached from the old machine', d1._readOrig === null);
  s.switchMachine('mc10');
  check('a 6803 machine gets a 6803 debugger', s.debug.cpu === '6803', s.debug.cpu);
}

// ---- 2. breakpoints, stepping and the trace through the Session ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, PROGRAM);
  const loop = r.symbols.get('LOOP');
  s.debug.addBreakpoint(loop);
  const ran = s.debug.run(50);
  check('a breakpoint stops the machine through the Session', s.debug.stopped && s.debug.pc === loop, h(s.debug.pc) + ` after ${ran} instructions`);
  check('the Session reports the stop', s.debug.stopReason.kind === 'breakpoint');
  check('the Session exposure is the debugger, not a copy', s.debug.read(0x4000) === s.machine.ram[0x4000]);
  s.debug.resume();
  const stepsBefore = s.debug.steps;
  s.debug.step();
  check('a step through the Session runs one instruction', s.debug.steps === stepsBefore + 1);
  check('the trace grows through the Session', s.debug.trace().length > 0 && s.debug.trace()[s.debug.trace().length - 1].pc === loop);
}
// the debugger's stepping through the Session does not change the machine, proved against a free run
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, PROGRAM);
  const free = Emu.createMachine('dragon64');
  free.injectAndRun(r.segments, r.exec);
  let same = true;
  for (let i = 0; i < 30 && same; i++) {
    s.debug.step();
    free.cpu.step();
    if (s.machine.cpu.pc !== free.cpu.pc || s.machine.cpu.a !== free.cpu.a) same = false;
  }
  check('stepping through the Session matches a free run', same);
}

// ---- 3. symbols from the built-in assembler appear in the disassembly ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, PROGRAM);
  const loop = r.symbols.get('LOOP');
  // the four instructions from BNE: the branch back to LOOP shows the symbol
  const block = s.debug.disassemble(r.symbols.get('START'), 5);
  const bne = block.find((i) => i.mnemonic === 'BNE');
  check('a branch target shows the assembler symbol', bne && /LOOP/.test(bne.text), bne && bne.text);
  check('plain instructions show no symbol', block[0].text === 'LDA #$00', block[0].text);
  // a program that did not come from the assembler has no symbols
  const s2 = new Emu.Session({ store: Emu.memoryStore() });
  s2.switchMachine('dragon64');
  s2.load('raw.bin', Emu.toBinary(r, { format: 'dragondos' }));
  const plain = s2.debug.disassemble(r.symbols.get('START'), 1)[0];
  check('a program that did not come from the assembler has plain addresses', /^\$/.test(plain.text.split(' ')[1] || '') || !/[A-Z]{3,}/.test(plain.text.split(' ')[1] || ''),
    plain.text);
}
// symbols given to the Session explicitly (an embedder's own) are used too
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const r = Emu.assemble(' ORG $3000\nSTART NOP\nWAIT BRA WAIT\n', '6809');
  s.runAssembled(r);
  s.debug.setSymbols(new Map([['WAIT', r.symbols.get('WAIT')]]));
  check('the Session debugger uses symbols it was given', /WAIT/.test(s.debug.disassemble(r.symbols.get('WAIT'), 1)[0].text),
    s.debug.disassemble(r.symbols.get('WAIT'), 1)[0].text);
}

// ---- 4. errors cross the Session API as SessionError, with a message for the user ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  for (const [what, fn, re] of [
    ['a breakpoint outside memory', () => s.debug.addBreakpoint(0x10000), /address/i],
    ['a breakpoint that is not a number', () => s.debug.addBreakpoint('3000'), /address/i],
    ['a watchpoint range past the end of memory', () => s.debug.addWatchpoint(0xFFF0, 0x20), /range|memory/i],
    ['a watchpoint of size 0', () => s.debug.addWatchpoint(0x4000, 0), /size|range/i],
    ['a watchpoint watching neither direction', () => s.debug.addWatchpoint(0x4000, 1, { read: false, write: false }), /read|write/i],
    ['an unknown register', () => s.debug.setRegister('q', 1), /register/i],
    ['a register that is not a number', () => s.debug.setRegister('a', 'x'), /whole number/i],
    ['a run-to address that is not an address', () => s.debug.runUntil(0x10000), /address/i],
    ['a write to a bad address', () => s.debug.write(-1, [1]), /address/i],
  ]) {
    const e = err(fn);
    check(`${what} is a SessionError`, e instanceof Emu.SessionError && re.test(e.message), e ? `${e.constructor.name}: ${e.message}` : 'no error');
  }
  // a CPU no core provides is refused by name (the 6309 and 6803 now have register sets of their own)
  check('a CPU with no core is refused by name', (() => {
    const m = s.machine;
    Object.defineProperty(m, 'config', { value: Object.assign({}, m.config, { cpu: '6800' }), configurable: true });
    const e = err(() => new Emu.Debugger(m));
    Object.defineProperty(m, 'config', { value: m.config, configurable: true });
    return e instanceof Emu.SessionError && /6800/.test(e.message);
  })());
}

// ---- 4b. the 6309 has a debugger of its own: its mnemonics, its registers ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64', { cpu: '6309' });
  check('the 6309 session really runs the 6309 core', s.machine.cpu.constructor.name === 'CPU6309', s.machine.cpu.constructor.name);
  const dbg = s.debug;
  check('the 6309 debugger reports the 6309', dbg.cpu === '6309', dbg.cpu);
  // instructions only the 6309 has, one per addressing form, plus SWI3 which the two parts share
  const r = Emu.assemble(' ORG $3000\nSTART LDQ #$11223344\n AIM #$80,<$10\n TFM X+,Y+\n SWI3\n BRA START\n', '6309');
  s.runAssembled(r);
  const at = r.symbols.get('START');
  const texts = dbg.disassemble(at, 4).map((i) => i.text);
  check('the 6309 debugger shows 6309 mnemonics', texts[0] === 'LDQ #$11223344' && texts[1] === 'AIM #$80,<$10'
    && texts[2] === 'TFM X+,Y+' && texts[3] === 'SWI3', JSON.stringify(texts));
  // the 6309-only registers are readable and writable, and q splits into d and w
  dbg.setRegister('w', 0x1234);
  dbg.setRegister('q', 0xDEADBEEF);
  check('the 6309 debugger sets q, d and w', dbg.registers().q === 0xDEADBEEF && dbg.registers().d === 0xDEAD
    && dbg.registers().w === 0xBEEF, JSON.stringify([dbg.registers().q, dbg.registers().d, dbg.registers().w]));
  dbg.setRegister('md', 0x41);
  check('the 6309 debugger sets the md register', dbg.registers().md === 0x41, String(dbg.registers().md));
  const err2 = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  check('a 6309 register that does not exist is refused', err2(() => dbg.setRegister('z', 1)) instanceof Emu.SessionError);
  // stepping one 6309-only instruction records it, and advances PC by its length (LDQ # is 5 bytes)
  dbg.setRegister('pc', at);
  dbg.clearTrace();
  dbg.step();
  const entry = dbg.trace().pop();
  check('stepping a 6309 instruction traces it', entry.text === 'LDQ #$11223344' && entry.pc === at
    && entry.size === 5 && dbg.pc === ((at + 5) & 0xFFFF),
    JSON.stringify({ text: entry.text, pc: entry.pc, size: entry.size, now: dbg.pc }));
}

// ---- 5. debugger state in the machine's snapshot ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, PROGRAM);
  s.debug.addBreakpoint(r.symbols.get('LOOP'));
  s.debug.addWatchpoint(0x4000, 2, { write: true, read: false });
  s.debug.step(); s.debug.step();
  const snap = s.machine.snapshot();          // includes the debugger (see js/machines/machine.js)
  const text = Emu.state.toJSON(snap);
  const restored = Emu.restoreSnapshot(Emu.state.fromJSON(text), s.machine.roms);
  check('a snapshot carries the breakpoints', JSON.stringify(restored.debugger.breakpoints()) === JSON.stringify(s.debug.breakpoints()),
    JSON.stringify(restored.debugger.breakpoints()));
  check('a snapshot carries the watchpoints', JSON.stringify(restored.debugger.watchpoints()) === JSON.stringify(s.debug.watchpoints()));
  // the restored machine's debugger stops at the same place the original would
  restored.debugger.run(50);
  check('a restored debugger stops at the same breakpoint', restored.debugger.stopped && restored.debugger.pc === r.symbols.get('LOOP'), h(restored.debugger.pc));
}

// ---- the frame loop under the debugger (the Debugger screen's Run): Session.advance stops at a breakpoint or
// watchpoint part way through a frame, emits 'debug', runs nothing while stopped, and carries on after resume.
// With nothing set it runs frames as before; with something set that never fires, the run is identical
// instruction for instruction and frame for frame to a free run.
{
  const fnv = (h, v) => Math.imul(h ^ (v & 0xFFFFFFFF), 0x01000193) >>> 0;
  const hashRun = (s, frames, viaDebugger) => {
    const m = s.machine; let hh = 0x811C9DC5;
    m.cpu.trace = (c) => { hh = fnv(hh, c.pc); hh = fnv(hh, c.a); hh = fnv(hh, c.x); hh = fnv(hh, c.totalCycles); };
    for (let f = 0; f < frames; f++) {
      if (viaDebugger) s.debug.runFrame(); else m.runFrame();
      const px = m.render().data; for (let i = 0; i < px.length; i += 7) hh = fnv(hh, px[i]);
    }
    m.cpu.trace = null;
    return hh;
  };
  const LOOPER = `
START   LDX     #$0400
FILL    INC     ,X+
        CMPX    #$0600
        BNE     FILL
AFTER   LDB     $0500
        STB     $4100
NEXT    BRA     START
`;
  const a = new Emu.Session({ store: Emu.memoryStore() }), b = new Emu.Session({ store: Emu.memoryStore() });
  asmRun(a, LOOPER); asmRun(b, LOOPER);
  b.debug.addBreakpoint(0xFFFE);                 // set, armed, never reached
  check('a debugger with a breakpoint is armed; without, not', b.debug.armed && !a.debug.armed);
  check('frames run through the debugger are identical to free frames (instructions, cycles, pictures)', hashRun(a, 20, false) === hashRun(b, 20, true));

  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, LOOPER);
  let events = 0;
  s.on((e) => { if (e === 'debug') events++; });
  const at = r.symbols.get('AFTER');             // LDB $0500, after the fill loop
  s.debug.addBreakpoint(at);
  const f0 = s.machine.frameCount;
  let ran = 0;
  for (let i = 0; i < 20 && !s.paused; i++) ran += s.advance(20);
  check('advance stops at the breakpoint part way through a frame and says so once', s.paused && s.debug.pc === at && s.debug.stopReason.kind === 'breakpoint'
    && events === 1, `${h(s.debug.pc)} ${JSON.stringify(s.debug.stopReason)} events ${events}`);
  const frames = s.machine.frameCount;
  check('while stopped, advance runs nothing', s.advance(100) === 0 && s.machine.frameCount === frames && s.debug.pc === at);
  const cyc = s.machine.cycle;
  s.resume();
  for (let i = 0; i < 20 && !s.paused; i++) s.advance(20);
  check('after resume it runs on (a whole fill loop) and stops at the same breakpoint the next time round', s.paused && s.debug.pc === at && events === 2
    && s.machine.cycle - cyc > 5000 && s.machine.frameCount >= f0, `${s.machine.cycle - cyc} cycles`);
  // a watchpoint through the frame loop: stops after the instruction that wrote
  s.debug.clearBreakpoints();
  s.debug.addWatchpoint(0x4100, 1, { read: false, write: true });
  s.resume();
  for (let i = 0; i < 20 && !s.paused; i++) s.advance(20);
  check('a write watchpoint stops the frame loop after the writing instruction', s.paused && s.debug.stopReason.kind === 'watchpoint' && s.debug.stopReason.address === 0x4100
    && s.debug.pc === r.symbols.get('NEXT'), `${h(s.debug.pc)} ${JSON.stringify(s.debug.stopReason)}`);
  // halt: the front end's Pause
  s.debug.clearWatchpoints();
  s.resume(); s.advance(20);
  s.debug.halt();
  check('halt stops the machine where it is', s.paused && s.debug.stopReason.kind === 'halt' && s.advance(50) === 0);
  // the trace is disassembled when read
  s.resume(); s.debug.clearTrace(); s.debug.step(); s.debug.step();
  const t = s.debug.trace();
  check('trace entries read with their disassembly', t.length === 2 && t.every((e) => typeof e.text === 'string' && e.text.length > 0 && e.size > 0), JSON.stringify(t.map((e) => e.text)));
}

// ---- the trace shows each instruction as it ran, even when the code has since rewritten it ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, `
START   LDA     #$12
        STA     PATCH+1
PATCH   LDB     #$00
        LDA     #$34
        STA     PATCH+1
DONE    BRA     DONE
`);
  const d = s.debug, patch = r.symbols.get('PATCH');
  d.machine.cpu.jump(r.symbols.get('START'));
  d.clearTrace();
  for (let i = 0; i < 5; i++) d.step();
  const ran = d.trace().find((e) => e.pc === patch);
  check('self-modifying code: the trace shows the instruction it ran (LDB #$12), not what memory holds now (#$34)',
    ran && /LDB\s+#\$12/.test(ran.text) && ran.bytes.length === 2 && ran.bytes[1] === 0x12 && d.machine.cpu.b === 0x12
    && /LDB\s+#\$34/.test(d.disassemble(patch, 1)[0].text), `${ran && ran.text} / now ${d.disassemble(patch, 1)[0].text}`);
}

// ---- stepping after the machine's clock has passed 2^24 ticks (where adding a tiny fraction to the tick is lost
// to float precision): a step runs exactly one instruction and a run stops at its breakpoint, on every family's
// runCycles (SAM machines, the CoCo 3 and the MC-10) ----
for (const [id, cpu, org, text] of [
  ['dragon64', '6809', 0x3000, 'LOOP    INCA\n        NOP\nMID     NOP\n        BRA     LOOP'],
  ['coco3', '6809', 0x3000, 'LOOP    INCA\n        NOP\nMID     NOP\n        BRA     LOOP'],
  ['mc10', '6803', 0x4100, 'LOOP    INCA\n        NOP\nMID     NOP\n        BRA     LOOP'],
]) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, text, cpu, id, org);
  const m = s.machine, d = s.debug;
  while (m.cycle < 2 ** 24 + 1000) m.runFrame();
  const loop = r.symbols.get('LOOP'), mid = r.symbols.get('MID');
  d.machine.cpu.jump(loop);
  const t0 = m.cpu.totalCycles, a0 = m.cpu.a;
  d.step(); d.step();
  check(`${id}: past 2^24 ticks (${Math.round(m.cycle)}), a step runs exactly one instruction`, d.pc === mid && m.cpu.a === ((a0 + 1) & 0xFF)
    && m.cpu.totalCycles - t0 === d.trace().slice(-2).reduce((t, e) => t + e.cycles, 0) && d.trace().slice(-2).every((e) => e.cycles > 0),
    `${h(d.pc)} A ${m.cpu.a} vs ${a0}`);
  d.addBreakpoint(loop);
  const ran = d.run(1000);                         // from MID: NOP, BRA, then the breakpoint
  check(`${id}: past 2^24 ticks, a run stops at its breakpoint`, d.stopped && d.stopReason.kind === 'breakpoint' && d.pc === loop && ran === 2,
    `${ran} ${JSON.stringify(d.stopReason)}`);
}

// ---- a breakpoint that stops the machine part way through a frame keeps that frame open with its sound: the
// sound made before the stop is played with the frame when it finishes, after the machine resumes ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  const r = asmRun(s, `
LOOP    NOP
        BRA     LOOP
`);
  const m = s.machine, d = s.debug;
  s.advance(1000 / m.fps);                          // a whole frame, so the next one starts fresh
  // part way into a frame, with a sound change, then a stop (as a debugger's runTo does)
  m.runFrame(() => { m.runCycles(m.frameBase + 1000); m.setSoundLevel(0.25); return false; });
  const before = m.audioEvents.slice();
  d.addBreakpoint(r.symbols.get('LOOP'));
  const played = [];
  s.advance(1000 / m.fps, { onFrame: () => played.push(m.audioEvents.slice()) });
  check('a breakpoint stops the machine part way through a frame, with no frame played', s.paused && played.length === 0 && m.frameOpen);
  d.removeBreakpoint(r.symbols.get('LOOP'));
  d.resume();
  s.advance(1000 / m.fps, { onFrame: () => played.push(m.audioEvents.slice()) });
  check('on resuming, the frame finishes with the sound made before the stop', played.length >= 1
    && before.every((v, i) => played[0][i] === v) && played[0].includes(0.25), JSON.stringify([before, played[0]]));
}

// ---- a breakpoint stops the
// running machine at exactly the instruction a free run executes there (compared with that run's own trace); step
// over and run to return arrive at the caller's stack level, not in a deeper recursive call; and a command that
// does not get there within its limit stops anyway instead of leaving the machine running free ----
{
  const LOOPER = `
START   LDX     #$0400
FILL    INC     ,X+
        CMPX    #$0600
        BNE     FILL
AFTER   LDB     $0500
        STB     $4100
NEXT    BRA     START
`;
  const free = new Emu.Session({ store: Emu.memoryStore() }), dbgd = new Emu.Session({ store: Emu.memoryStore() });
  const rf = asmRun(free, LOOPER); asmRun(dbgd, LOOPER);
  const after = rf.symbols.get('AFTER');
  // the free run's own trace: every instruction's address and the cycle count before it ran
  const log = [];
  free.machine.cpu.trace = (c) => { if (log.length < 200000) log.push([c.pc, c.totalCycles]); };
  for (let f = 0; f < 3; f++) free.machine.runFrame();
  free.machine.cpu.trace = null;
  const firstAt = log.findIndex(([pc]) => pc === after);
  dbgd.debug.addBreakpoint(after);
  for (let i = 0; i < 20 && !dbgd.paused; i++) dbgd.advance(20);
  const t = dbgd.debug.trace();
  check('a breakpoint stops the running machine before the very instruction the free run executes there (same cycle count)',
    firstAt > 0 && dbgd.paused && dbgd.debug.pc === after && dbgd.machine.cpu.totalCycles === log[firstAt][1]
    && t[t.length - 1].pc === log[firstAt - 1][0], `free ${log[firstAt] && log[firstAt][1]} vs ${dbgd.machine.cpu.totalCycles}`);

  const RECURSE = `
START   LDS     #$3F00
        LDA     #3
        JSR     REC
DONE    BRA     DONE
REC     DECA
        BEQ     OUT
CALL    JSR     REC
RET     NOP
OUT     RTS
FOREVER BRA     FOREVER
SPIN    JSR     FOREVER
        BRA     SPIN
`;
  const r = new Emu.Session({ store: Emu.memoryStore() });
  const sym = asmRun(r, RECURSE).symbols;
  const d = r.debug;
  d.machine.cpu.jump(sym.get('START'));
  d.runUntil(sym.get('CALL'));                     // the first inner call, one level down
  const s0 = d.machine.cpu.s;
  d.stepOver();
  check('step over a recursive call stops back at the caller\'s level, not in the deeper call that passes the same address',
    d.pc === sym.get('RET') && d.machine.cpu.s === s0 && d.stopReason.kind === 'until', `${h(d.pc)} S ${h(d.machine.cpu.s)} vs ${h(s0)}`);
  d.machine.cpu.jump(sym.get('START'));
  d.runUntil(sym.get('CALL'));
  d.step();                                        // into REC, two levels down
  const s1 = d.machine.cpu.s;
  d.runToReturn();
  check('run to return stops where this call returns, above its stack level', d.pc === sym.get('RET') && d.machine.cpu.s === s1 + 2 && d.stopReason.kind === 'until',
    `${h(d.pc)} S ${h(d.machine.cpu.s)} vs ${h(s1 + 2)}`);
  d.machine.cpu.jump(sym.get('SPIN'));
  d.resume();
  d.stepOver(5000);
  check('step over a call that never returns stops at its limit (kind limit) instead of leaving the machine running',
    d.stopped && r.paused && d.stopReason.kind === 'limit' && d.stopReason.instructions === 5000 && d.pc === sym.get('FOREVER'), JSON.stringify(d.stopReason));
  d.resume();
  d.runToReturn(3000);
  check('run to return that never returns stops at its limit too', d.stopped && d.stopReason.kind === 'limit' && d.stopReason.instructions === 3000);
  d.resume();
  d.runUntil(0xFFFF, 2000);
  check('run to an address never reached stops at its limit', d.stopped && d.stopReason.kind === 'limit');

  // the 6803 stacks the return address low byte first, below S: run to return on the MC-10 reads it from S+1
  const m = new Emu.Session({ store: Emu.memoryStore() });
  const sym3 = asmRun(m, `
START   LDS     #$4F00
        LDAA    #3
        JSR     REC
DONE    BRA     DONE
REC     DECA
        BEQ     OUT
CALL    JSR     REC
RET     NOP
OUT     RTS
`, '6803', 'mc10', 0x4100).symbols;
  const d3 = m.debug;
  d3.machine.cpu.jump(sym3.get('START'));
  d3.runUntil(sym3.get('CALL'));
  d3.step();                                       // into REC, two levels down
  const s3 = d3.machine.cpu.s;
  check('6803: after JSR the return address is at S+1 (high) and S+2 (low)', ((d3.peek(s3 + 1) << 8) | d3.peek(s3 + 2)) === sym3.get('RET'),
    `${h(d3.peek(s3 + 1))} ${h(d3.peek(s3 + 2))}`);
  d3.runToReturn(5000);
  check('6803: run to return stops where this call returns, above its stack level', d3.pc === sym3.get('RET') && d3.machine.cpu.s === s3 + 2 && d3.stopReason.kind === 'until',
    `${h(d3.pc)} S ${h(d3.machine.cpu.s)} vs ${h(s3 + 2)} ${JSON.stringify(d3.stopReason)}`);
  d3.resume();
  d3.machine.cpu.jump(sym3.get('START'));
  d3.runUntil(sym3.get('CALL'));
  const s4 = d3.machine.cpu.s;
  d3.stepOver();
  check('6803: step over a recursive call stops back at the caller\'s level', d3.pc === sym3.get('RET') && d3.machine.cpu.s === s4 && d3.stopReason.kind === 'until',
    `${h(d3.pc)} S ${h(d3.machine.cpu.s)} vs ${h(s4)}`);
}

// ---- breakpoints saved in a snapshot come back when the snapshot is opened through the Session ----
const snapshotBreakpoints = (async () => {
  const a = new Emu.Session({ store: Emu.memoryStore() });
  asmRun(a, PROGRAM);
  a.debug.addBreakpoint(0x3005);
  a.debug.addWatchpoint(0x4001, 1, { read: false, write: true });
  const f = await a.snapshotFile();
  const b = new Emu.Session({ store: Emu.memoryStore() });
  b.switchMachine('coco');
  b.openSnapshot(await b.readSnapshot(f.bytes));
  check('opening a snapshot through the Session brings its breakpoints and watchpoints back',
    b.machine.debugger === b.debug && JSON.stringify(b.debug.breakpoints()) === '[12293]' && b.debug.watchpoints().length === 1
    && b.debug.watchpoints()[0].start === 0x4001, JSON.stringify(b.debug.breakpoints()));
})();

snapshotBreakpoints.then(() => {
  console.log(`${n - fail}/${n} Session debugger checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL snapshot breakpoints ${e.stack}`); process.exitCode = 1; });
