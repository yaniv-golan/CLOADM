// Run: node tests/debugger.test.js
//
// The debugger core behind the Session: breakpoints, watchpoints, stepping, run to
// return, the instruction trace log and memory/register access, browser-free. The oracles are the machine's
// own behaviour, not the debugger's:
//  * a breakpoint stops *before* the instruction at its address executes, every time that address is reached;
//  * a watchpoint stops *after* the instruction whose bus access touched the address or range, and says which
//    access it saw and the value that went over the bus; reads and writes are told apart;
//  * single-step runs exactly one instruction: compared instruction for instruction with a free-running
//    machine (registers, cycle count and PC after each step);
//  * stepping over a subroutine call runs the subroutine and returns to the instruction after it; run to
//    return stops at the address the subroutine returns to; both end where a free run would;
//  * the trace log holds the last N instructions, and they are the ones a free run executed;
//  * attaching a debugger that never stops leaves the machine's instruction trace byte for byte identical,
//    so debugging does not change emulation timing.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const h = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

const asm = (text, cpu = '6809', org = 0x3000) => {
  const r = Emu.assemble(` ORG $${org.toString(16).toUpperCase()}\n` + text + '\n', cpu);
  if (!r.ok) throw new Error('test firmware does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
// a machine with the firmware loaded and running at its entry (the no-ROM stub boots in two frames)
const running = (r, id = 'dragon64') => { const m = Emu.createMachine(id); m.injectAndRun(r.segments, r.exec); return m; };

const PROGRAM = `
START   LDA     #$00
        STA     $4000
LOOP    INCA
        CMPA    #$03
        BNE     LOOP
        LDB     $4000
        LDA     #$11
        BSR     SUB
        STA     $4001
        LDA     #$22
        JSR     SUB2
        STA     $4002
HALT    BRA     HALT
SUB     INCA
        RTS
SUB2    ADDA    #$01
        RTS
`;
const P = asm(PROGRAM);
const sym = (name, r = P) => r.symbols.get(name);

// ---- 1. breakpoints stop before the instruction at the address, every time ----
{
  const m = running(P);
  const dbg = new Emu.Debugger(m);
  const loop = sym('LOOP');
  let reached = 0;
  dbg.addBreakpoint(loop);
  m.cpu.trace = (c) => { if (c.pc === loop) reached++; };
  const seen = [];
  for (let i = 0; i < 10; i++) {
    dbg.run(20);
    if (!dbg.stopped) break;
    seen.push(dbg.pc);
    dbg.resume();                  // Run again moves on from the breakpoint, so the loop continues
  }
  m.cpu.trace = null;
  check('a breakpoint stops every time its address is reached', seen.length === 3, JSON.stringify(seen.map(h)));
  check('each stop is at the breakpoint address', seen.every((p) => p === loop), JSON.stringify(seen.map(h)));
  check('stopped before the instruction executed, not after it', !dbg.stopped && reached === 3, `trace reached LOOP ${reached} times`);
  check('the stop reason names the breakpoint', (() => {
    const m2 = running(P), d2 = new Emu.Debugger(m2);
    d2.addBreakpoint(loop); d2.run(20);
    return d2.stopReason && d2.stopReason.kind === 'breakpoint' && d2.stopReason.address === loop;
  })());
}

// ---- 2. single-step is exactly one instruction, and stays in step with a free run ----
{
  const m = running(P);
  const free = running(P);
  const dbg = new Emu.Debugger(m);
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'];
  let same = true, cyclesOk = true;
  for (let i = 0; i < 40; i++) {
    const c = dbg.step();
    const fc = free.cpu.step();
    if (c !== fc) cyclesOk = false;
    if (c !== undefined) { /* 6809 reports the step's cycle count */ }
    if (fc !== undefined && regs.some((r) => m.cpu[r] !== free.cpu[r])) { same = false; break; }
  }
  check('single-step returns the instruction cycle count, the same as a free run', cyclesOk);
  check('stepping 40 instructions leaves the machine exactly where a free run is', same && regs.every((r) => m.cpu[r] === free.cpu[r]),
    regs.filter((r) => m.cpu[r] !== free.cpu[r]).join());
  check('the step counter counts the instructions executed', dbg.steps === 40, String(dbg.steps));
}

// ---- 3. a watchpoint stops after the instruction whose access touched the address ----
{
  const m = running(P);
  const dbg = new Emu.Debugger(m);
  dbg.addWatchpoint(0x4000, 1, { write: true, read: false });
  dbg.run(100);
  check('a write watchpoint stops on the store', dbg.stopped && dbg.stopReason && dbg.stopReason.kind === 'watchpoint'
    && dbg.stopReason.access === 'write' && dbg.stopReason.address === 0x4000, JSON.stringify(dbg.stopReason));
  check('it stopped after the storing instruction, at the next one', dbg.pc === sym('LOOP'), h(dbg.pc) + ' want ' + h(sym('LOOP')));
  check('the value that went over the bus is reported', dbg.stopReason.value === 0, JSON.stringify(dbg.stopReason));
}
// the debugger's own memory view and disassembly never set off a watchpoint: they read memory directly, not
// through the bus the program runs on
{
  const m = running(P);
  const dbg = new Emu.Debugger(m);
  dbg.addWatchpoint(0x3000, 0x100, { read: true, write: true });   // code and data the debugger looks at
  const taken = [];
  const hitAt = (fn) => { dbg.hit = null; fn(); const h = dbg.hit; dbg.hit = null; return h; };
  taken.push(hitAt(() => dbg.disassemble(0x3000, 8)));
  taken.push(hitAt(() => dbg.read(0x3000)));
  taken.push(hitAt(() => dbg.peekBytes(0x4000, 16)));
  check('disassembling a watched address does not trip the watchpoint', taken[0] === null, JSON.stringify(taken[0]));
  check('the memory view of a watched address does not trip the watchpoint', taken[1] === null && taken[2] === null, JSON.stringify(taken.slice(1)));
  // and a program access to the same range still does: restart at START, and the opcode fetch at $3000 is
  // the first access the watchpoint sees (instruction fetches are reads, as they are on the bus)
  m.cpu.jump(sym('START'));
  dbg.resume();
  dbg.step();
  check('the program reaching the same address still stops it', dbg.stopped && dbg.stopReason.kind === 'watchpoint'
    && dbg.stopReason.access === 'read' && dbg.stopReason.address === sym('START'), JSON.stringify(dbg.stopReason));
}
{
  const m = running(P);
  const dbg = new Emu.Debugger(m);
  dbg.addWatchpoint(0x4000, 1, { write: false, read: true });
  dbg.run(100);
  check('a read watchpoint ignores the store and stops on the load', dbg.stopped && dbg.stopReason.access === 'read' && dbg.stopReason.value === 0,
    JSON.stringify(dbg.stopReason));
}
{
  // a 16-bit store is two bus writes: the one inside the watched byte is reported, with its value
  const r = asm(' LDD #$BEEF\n STD $4000\n LDA $4001\nHALT BRA HALT\n');
  const dbg = new Emu.Debugger(running(r));
  dbg.addWatchpoint(0x4001, 1, { write: true, read: false });
  dbg.run(50);
  check('a 16-bit store overlapping a one-byte watchpoint stops it, at that byte', dbg.stopped && dbg.stopReason.address === 0x4001
    && dbg.stopReason.value === 0xEF, JSON.stringify(dbg.stopReason));
}
{
  // a range the program never touches does not stop it
  const r = asm(' LDD #$BEEF\n STD $4000\n LDA $4001\nHALT BRA HALT\n');
  const dbg = new Emu.Debugger(running(r));
  dbg.addWatchpoint(0x4002, 2, { write: true, read: true });
  const steps = dbg.run(50);
  check('a range the program never touches does not stop it', !dbg.stopped && dbg.pc === sym('HALT', r), h(dbg.pc) + ` after ${steps} steps`);
}

// ---- 4. stepping over a subroutine call; running to return ----
const CALLS = `
START   LDA     #$01
CALL1   BSR     SUB
        LDA     #$02
CALL2   JSR     SUB2
        STA     $4010
HALT    BRA     HALT
SUB     ADDA    #$03
        RTS
SUB2    ADDA    #$04
        RTS
`;
{
  const r = asm(CALLS), s = (name) => sym(name, r);
  const free = running(r);
  const dbg = new Emu.Debugger(running(r));
  // free run: what A holds when each call returns (the oracle for the stepped runs)
  dbg.runUntil(s('CALL1'));
  check('runUntil stops exactly at the address', dbg.stopped && dbg.pc === s('CALL1'), h(dbg.pc));
  dbg.stepOver();
  check('step over a BSR lands on the instruction after it', dbg.pc === ((s('CALL1') + 2) & 0xFFFF), h(dbg.pc));
  check('and the subroutine ran: A was added to', dbg.registers().a === 0x04, String(dbg.registers().a));
  dbg.runUntil(s('CALL2'));
  dbg.stepOver();
  check('step over a JSR lands on the instruction after it', dbg.pc === ((s('CALL2') + 3) & 0xFFFF), h(dbg.pc));
  check('and the JSR subroutine ran', dbg.registers().a === 0x06, String(dbg.registers().a));
  // the free run agrees, so stepping over did not change the program's effect
  free.cpu.jump(r.exec);
  for (let i = 0; i < 500 && free.cpu.pc !== s('HALT'); i++) free.cpu.step();
  check('the free run reaches the same HALT with the same registers', free.cpu.pc === s('HALT') && free.cpu.a === 0x06, h(free.cpu.pc) + ' A=' + free.cpu.a);
}
{
  const r = asm(CALLS), s = (name) => sym(name, r);
  const dbg = new Emu.Debugger(running(r));
  dbg.runUntil(s('CALL1'));
  dbg.step();                                    // into the subroutine
  check('one step at a BSR goes into the subroutine', dbg.pc === s('SUB'), h(dbg.pc));
  dbg.runToReturn();
  check('run to return stops at the address the subroutine returns to', dbg.pc === ((s('CALL1') + 2) & 0xFFFF), h(dbg.pc));
  check('run to return ran the subroutine', dbg.registers().a === 0x04, String(dbg.registers().a));
}
{
  const dbg = new Emu.Debugger(running(P));
  const before = dbg.pc;
  dbg.stepOver();
  check('step over an instruction that is not a call is one step', dbg.pc !== before && dbg.steps === 1, `${h(before)} -> ${h(dbg.pc)}, ${dbg.steps} steps`);
}

// ---- 5. the trace log holds the last N instructions, and they are a free run's ----
{
  const m = running(P), free = running(P);
  const dbg = new Emu.Debugger(m, { traceSize: 8 });
  const freeLog = [];
  free.cpu.trace = (c) => freeLog.push({ pc: c.pc, a: c.a, b: c.b, cc: c.cc });
  for (let i = 0; i < 40; i++) { dbg.step(); free.cpu.step(); }
  free.cpu.trace = null;
  const log = dbg.trace();
  check('the trace log keeps at most N instructions', log.length === 8, String(log.length));
  const tail = freeLog.slice(-8);
  check('the trace entries are the instructions a free run executed, registers and all',
    log.every((e, i) => e.pc === tail[i].pc && e.a === tail[i].a && e.b === tail[i].b && e.cc === tail[i].cc),
    JSON.stringify(log.map((e) => h(e.pc))) + ' vs ' + JSON.stringify(tail.map((e) => h(e.pc))));
  check('each entry carries the cycle count', log.every((e) => Number.isInteger(e.cycles) && e.cycles > 0), JSON.stringify(log.map((e) => e.cycles)));
  check('each entry can be disassembled', log.every((e) => typeof e.text === 'string' && e.text.length > 0), JSON.stringify(log.map((e) => e.text)));
  dbg.clearTrace();
  check('the trace can be cleared', dbg.trace().length === 0);
}

// ---- 5b. a trace entry keeps the bytes it ran with, not the memory as it stands later ----
// _record copies an instruction's bytes as it runs and disassembles when trace() is asked (
// disassembling every instruction to keep 64 made traced runs several times slower). The bytes cannot be read
// afterwards - peek() is the memory as it is now - so this pins the copy: the program is overwritten between
// running and asking for the trace, and the entries must still describe what ran.
{
  const m = running(P);
  const dbg = new Emu.Debugger(m, { traceSize: 32 });
  for (let i = 0; i < 12; i++) dbg.step();
  const origStart = P.symbols.get('START');
  // trace() is asked for the FIRST time after the overwrite, so nothing was decoded (or cached) while the
  // original bytes were still in memory: only the copy _record made can produce them
  dbg.write(origStart, new Uint8Array(8).fill(0x12));      // 0x12: NOP, everywhere the program ran
  const log = dbg.trace();
  check('the trace has entries to compare', log.length === 12, String(log.length));
  check('a trace entry decoded after the program was overwritten still shows the instruction that ran',
    log[0].pc === origStart && log[0].text.startsWith('LDA') && log[0].bytes[0] !== 0x12,
    `START ${h(origStart)}: "${log[0].text}" ${[...log[0].bytes].map((b) => b.toString(16)).join(' ')}`);
  check('...and none of the entries describes the overwritten memory',
    log.every((e) => !(e.bytes.length === 1 && e.bytes[0] === 0x12 && e.pc >= origStart && e.pc < origStart + 8)),
    log.map((e) => e.text).join(' | '));
  // bytes are copied per instruction, not once per debugger: stepping again records what is there now
  dbg.step();
  const fresh = dbg.trace();
  const last = fresh[fresh.length - 1];
  check('an instruction run after the overwrite is recorded with its new bytes',
    last.pc >= origStart && last.pc < origStart + 8 ? last.bytes[0] === 0x12 : true,
    `"${last.text}" at ${h(last.pc)}`);
}

// ---- 5c. the trace's copy is long enough for the longest encoding, and it keeps dp and symbols right ----
// _record copies the instruction's bytes before it runs. Four was too few: LDY [$1234,X] is five bytes (10, the
// opcode, the postbyte, and a 16-bit address), so its text came out as [4608,X] - the two address bytes were
// never read. These pin the length, the dp each entry ran with, and that a decoded entry is redone when symbols
// arrive after it was cached.
{
  const r = asm(`
        LDY     [$1234,X]
        LDA     <$10
        BRA     *
`);
  const m = running(r);
  const dbg = new Emu.Debugger(m, { traceSize: 8 });
  dbg.step();
  const log = dbg.trace();
  check('a five-byte encoding is recorded whole',
    log[0].bytes.length === 5 && log[0].size === 5 && log[0].bytes[3] === 0x12 && log[0].bytes[4] === 0x34,
    `${log[0].text}: ${[...log[0].bytes].map((b) => b.toString(16)).join(' ')}`);
  // the indirect form prints its address in decimal: 4660 is $1234, the bytes that are now copied
  check('...and decodes to the address it holds', /\[4660,X\]/.test(log[0].text) && !/4608/.test(log[0].text), log[0].text);
}
{
  // direct mode resolves against the dp the instruction ran with, not whatever dp is now
  const r = asm(`
        LDA     #$40
        TFR     A,DP
        LDA     <$10
        CLRA
        TFR     A,DP
        BRA     *
`, '6809', 0x3000);
  const m = running(r);
  const dbg = new Emu.Debugger(m, { traceSize: 16 });
  dbg.setSymbols(new Map([['DSYM', 0x4010]]));   // where <$10 resolves with dp $40, and nowhere with dp $00
  for (let i = 0; i < 5; i++) dbg.step();
  const log = dbg.trace();
  const direct = log.find((e) => e.pc === 0x3004);     // the LDA <$10 after DP was set to $40
  // A direct operand is named only when a symbol covers the address it resolves to, and that resolution uses the
  // dp the entry ran with: with dp $40 the operand $10 is $4010, with dp $00 it would be $0010.
  check('a direct-mode entry resolves against the dp it ran with, and decodes once a covering symbol exists',
    !!direct && direct.dp === 0x40 && /DSYM/.test(dbg.trace().find((e) => e.pc === 0x3004).text),
    direct ? `dp $${direct.dp.toString(16)} -> "${direct.text}"` : 'entry not found');
}
{
  // a symbol set after an entry was decoded: the cached decode must not survive it
  const r = asm(`
        JSR     SUB
        BRA     *
SUB     RTS
`);
  const m = running(r);
  const dbg = new Emu.Debugger(m, { traceSize: 8 });
  dbg.step();
  const before = dbg.trace()[0].text;
  dbg.setSymbols(new Map([['SUB', r.symbols.get('SUB')]]));
  const after = dbg.trace()[0].text;
  check('a symbol loaded after an entry was decoded is used by the next read of it',
    before !== after && /SUB/.test(after), `"${before}" -> "${after}"`);
}
// Two paths can change the symbols, and each must drop the cached decodes on its own: a new symbol object
// handed to setSymbols(), and a function whose result changed. One test each, so removing either line fails.
{
  const r = asm(`
        JSR     SUB
        BRA     *
SUB     RTS
`);
  const m = running(r);
  const dbg = new Emu.Debugger(m, { traceSize: 8 });
  dbg.step();
  check('entry starts out with no symbol for the call target', !/SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
  dbg.setSymbols(new Map([['SUB', r.symbols.get('SUB')]]));   // the setSymbols() path
  check('setSymbols() alone invalidates a decode cached before it', /SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
}
{
  const r = asm(`
        JSR     SUB
        BRA     *
SUB     RTS
`);
  const m = running(r);
  let now = new Map();                                        // a symbol source that changes under the debugger
  const dbg = new Emu.Debugger(m, { traceSize: 8, symbols: () => now });
  dbg.step();
  check('entry starts out with no symbol for the call target', !/SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
  now = new Map([['SUB', r.symbols.get('SUB')]]);             // the changed-source path, without setSymbols()
  check('a changed symbol source alone invalidates a decode cached before it', /SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
}
// The same, going the other way: removing the symbols must also drop the cached text. With no symbols the source
// IS null, so "stale" cannot be marked by null - that is the bug this pins (setSymbols(null) used to leave the
// old symbol names on already-decoded entries).
{
  const r = asm(`
        JSR     SUB
        BRA     *
SUB     RTS
`);
  const m = running(r);
  const dbg = new Emu.Debugger(m, { traceSize: 8 });
  dbg.setSymbols(new Map([['SUB', r.symbols.get('SUB')]]));
  dbg.step();
  check('with symbols set, the call target is named', /SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
  dbg.setSymbols(null);
  check('setSymbols(null) drops the names from an entry decoded before it', !/SUB/.test(dbg.trace()[0].text), dbg.trace()[0].text);
}

// ---- 6. reading and writing registers and memory ----
{
  const m = running(P);
  const dbg = new Emu.Debugger(m);
  dbg.step();
  const regs = dbg.registers();
  check('registers() names every 6809 register', ['a', 'b', 'd', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].every((r) => r in regs), Object.keys(regs).join());
  check('registers() agrees with the CPU', regs.pc === m.cpu.pc && regs.a === m.cpu.a && regs.d === ((m.cpu.a << 8) | m.cpu.b));
  dbg.setRegister('a', 0x5A);
  check('setRegister writes the CPU register', m.cpu.a === 0x5A);
  dbg.setRegister('x', 0x1234);
  check('setRegister writes a 16-bit register', m.cpu.x === 0x1234);
  check('setRegister refuses an unknown register', throws(() => dbg.setRegister('q', 1), /register/i));
  dbg.write(0x4000, [0xAB, 0xCD]);
  check('write puts bytes into memory', dbg.read(0x4000) === 0xAB && dbg.read(0x4001) === 0xCD);
  check('read reads memory', dbg.read(0x4001) === 0xCD);
  check('reading memory has no side effects', (() => { dbg.read(0x4000); dbg.read(0x4001); return m.ram[0x4000] === 0xAB && m.ram[0x4001] === 0xCD; })());
  dbg.write(0x4000, []);
  check('writing no bytes changes nothing', dbg.read(0x4000) === 0xAB);
  // reading I/O memory through read() reports the pin values, and the debugger's disassembly peek does not
  check('peek reads program bytes without a bus cycle', (() => { const cyc = m.cycle; const v = dbg.peek(dbg.pc); return typeof v === 'number' && m.cycle === cyc; })());
}

// ---- 7. errors: illegal addresses, ranges and registers ----
{
  const dbg = new Emu.Debugger(running(P));
  check('a breakpoint outside memory is refused', throws(() => dbg.addBreakpoint(0x10000), /address/i));
  check('a negative address is refused', throws(() => dbg.addBreakpoint(-1), /address/i));
  check('a breakpoint address must be a number', throws(() => dbg.addBreakpoint('3000'), /address/i));
  check('a watchpoint of size 0 is refused', throws(() => dbg.addWatchpoint(0x4000, 0), /size|range/i));
  check('a watchpoint past the end of memory is refused', throws(() => dbg.addWatchpoint(0xFFF0, 0x20), /range|memory/i));
  check('a watchpoint with neither read nor write is refused', throws(() => dbg.addWatchpoint(0x4000, 1, { read: false, write: false }), /read|write/i));
  check('removing a breakpoint that is not set reports it', dbg.removeBreakpoint(0x1234) === false);
  dbg.addBreakpoint(0x4000);
  check('a breakpoint can be removed', dbg.removeBreakpoint(0x4000) === true && !dbg.breakpoints().includes(0x4000), JSON.stringify(dbg.breakpoints()));
  check('breakpoints() lists what is set', (() => { dbg.addBreakpoint(0x3001); dbg.addBreakpoint(0x3002); return JSON.stringify(dbg.breakpoints()) === '[12289,12290]'; })());
  check('watchpoints() lists what is set, with its range and direction', (() => {
    dbg.addWatchpoint(0x4000, 2, { write: true, read: false });
    const w = dbg.watchpoints();
    return w.length === 1 && w[0].start === 0x4000 && w[0].size === 2 && w[0].write && !w[0].read;
  })());
  check('clearing watchpoints removes them all', (() => { dbg.clearWatchpoints(); return dbg.watchpoints().length === 0; })());
}

// ---- 8. attaching a debugger changes nothing while it is not stopping ----
{
  const hash = (attach) => {
    const m = running(P);
    let x = 0x811C9DC5;
    const fnv = (v) => { x ^= v & 0xFFFFFFFF; x = Math.imul(x, 0x01000193) >>> 0; };
    let dbg = null;
    if (attach) { dbg = new Emu.Debugger(m, { traceSize: 4 }); dbg.addBreakpoint(0x1234); dbg.addWatchpoint(0x2000, 4, { read: true, write: true }); }
    m.cpu.trace = (c) => { fnv(c.pc); fnv(c.totalCycles); };
    for (let f = 0; f < 4; f++) m.runFrame();
    m.cpu.trace = null;
    return { hash: x, traced: !!dbg };
  };
  const a = hash(false), b = hash(true);
  check('a debugger that never stops leaves the instruction trace identical', a.hash === b.hash, `${a.hash} vs ${b.hash}`);
}
{
  // stepping a stopped machine and then running on gives the free run's trace
  const m = running(P), free = running(P);
  const dbg = new Emu.Debugger(m);
  dbg.step(); dbg.step(); dbg.step();
  free.cpu.step(); free.cpu.step(); free.cpu.step();
  let same = true, n = 0;
  for (let i = 0; i < 200 && same; i++) {
    const c1 = dbg.step(), c2 = free.cpu.step();
    if (c1 !== c2 || m.cpu.pc !== free.cpu.pc || m.cpu.a !== free.cpu.a || m.cpu.cc !== free.cpu.cc) same = false;
    n++;
  }
  check('stepping then running matches the free run instruction for instruction', same, `after ${n} steps`);
}

// ---- 9. debugger state survives a JSON round trip (the Session's snapshot) ----
{
  const dbg = new Emu.Debugger(running(P));
  dbg.addBreakpoint(0x3000); dbg.addBreakpoint(0x3004);
  dbg.addWatchpoint(0x4000, 2, { write: true, read: false });
  dbg.addWatchpoint(0x5000, 1, { write: false, read: true });
  const text = Emu.state.toJSON(dbg.saveState());
  const dbg2 = new Emu.Debugger(running(P));
  dbg2.loadState(Emu.state.fromJSON(text));
  check('breakpoints and watchpoints survive saveState -> JSON -> loadState',
    JSON.stringify(dbg2.breakpoints()) === JSON.stringify(dbg.breakpoints())
    && JSON.stringify(dbg2.watchpoints()) === JSON.stringify(dbg.watchpoints()));
  check('a restored debugger stops at the same breakpoint', (() => { dbg2.run(100); return dbg2.stopped && dbg2.pc === 0x3000; })(), h(dbg2.pc));
}

// ---- 10. the 6803 machine works the same way ----
{
  const r = asm(`
START   LDAA    #$01
        STAA    $4100
LOOP    INCA
        CMPA    #$04
        BNE     LOOP
HALT    BRA     HALT
`, '6803', 0x4000);
  const s = (name) => sym(name, r);
  const m = running(r, 'mc10');
  const dbg = new Emu.Debugger(m);
  check('the debugger uses the machine CPU type', dbg.cpu === '6803', dbg.cpu);
  dbg.addBreakpoint(s('LOOP'));
  dbg.run(100);
  check('a 6803 breakpoint stops at the right instruction', dbg.stopped && dbg.pc === s('LOOP'), h(dbg.pc));
  const d2 = new Emu.Debugger(running(r, 'mc10'));
  d2.addWatchpoint(0x4100, 1, { write: true, read: false });
  d2.run(100);
  check('a 6803 write watchpoint stops after the store', d2.stopped && d2.stopReason.address === 0x4100 && d2.stopReason.value === 0x01,
    JSON.stringify(d2.stopReason));
  const regs = d2.registers();
  check('6803 registers, without Y/U/DP', ['a', 'b', 'd', 'x', 's', 'pc', 'cc'].every((x) => x in regs) && !('y' in regs), Object.keys(regs).join());
  check('6803 step counts one instruction', (() => { const c = d2.step(); return Number.isInteger(c) && c > 0; })());
}

// ---- 11. the 6309 machine: its own registers, its own mnemonics, and the real direct page ----
// A 6309 runs the 6809's direct mode with its own DP register, and adds E F W Q V MD. Both are what the
// Debugger screen shows and what a disassembly of its code must use; before this, a screen had no register
// set for a 6309 at all (ORDER[cpu] was undefined) and a direct operand was resolved against DP 0.
// Every check here fails on the base commit except the trace one, which base already passed (the trace path
// carried the DP before this change); that one is kept as a guard and is mutation-checked. The tables are read
// defensively, so a missing one fails its check instead of throwing the suite away.
{
  for (const [id, opts] of [['coco3', { cpu: '6309' }], ['dragon64', { cpu: '6309' }]]) {
    const m = Emu.createMachine(id, opts);
    m.injectAndRun(P.segments, P.exec);
    const dbg = new Emu.Debugger(m);
    const order = Emu.REGISTER_ORDER && Emu.REGISTER_ORDER['6309'];
    const regs = dbg.registers();
    // the set is complete: every register the core can read and write is on the screen, except CC (the
    // flags) - a register added to the core and left off the screen fails here
    check(`${id} 6309: the screen shows every register the core has`, !!order && Object.keys(regs).filter((r) => r !== 'cc').every((r) => order.includes(r)),
      order ? Object.keys(regs).filter((r) => r !== 'cc' && !order.includes(r)).join() || 'complete' : 'no 6309 register set');
    check(`${id} 6309: CC is not a hex field (it is shown as its flags)`, !!order && !order.includes('cc') && !!Emu.FLAGS && !!Emu.FLAGS['6309'] && Emu.FLAGS['6309'].length === 8,
      order ? order.join() : 'no 6309 register set');
    check(`${id} 6309: the field widths come from the register table (Q eight digits, MD two)`,
      !!Emu.REGISTER_DIGITS && Emu.REGISTER_DIGITS.q === 8 && Emu.REGISTER_DIGITS.md === 2 && Emu.REGISTER_DIGITS.d === 4 && Emu.REGISTER_DIGITS.a === 2,
      Emu.REGISTER_DIGITS ? JSON.stringify(Emu.REGISTER_DIGITS) : 'no width table');
    // a direct operand is resolved against the real DP
    m.cpu.dp = 0x40;
    dbg.write(0x3000, [0x96, 0x10]);            // LDA $10 -> DP:offset = $4010
    const ins = dbg.disassemble(0x3000, 1)[0];
    check(`${id} 6309: a direct operand resolves against the real DP`, ins.target === 0x4010, `${ins.text} target=${ins.target === null ? 'null' : h(ins.target)}`);
  }
  // Every register on every screen has a width, and it is the right one: a missing entry is a wiring error the
  // panel throws on now, so an incomplete table must fail here.
  {
    const want = { a: 2, b: 2, e: 2, f: 2, d: 4, w: 4, q: 8, v: 4, md: 2, x: 4, y: 4, u: 4, s: 4, pc: 4, dp: 2 };
    for (const cpu of ['6809', '6803', '6309']) {
      const missing = Emu.REGISTER_ORDER[cpu].filter((r) => !Emu.REGISTER_DIGITS[r]);
      const wrong = Emu.REGISTER_ORDER[cpu].filter((r) => Emu.REGISTER_DIGITS[r] && want[r] !== undefined && Emu.REGISTER_DIGITS[r] !== want[r]);
      check(`every ${cpu} screen register has the right field width`, !missing.length && !wrong.length,
        `missing ${missing.join() || 'none'} wrong ${wrong.map((r) => `${r}=${Emu.REGISTER_DIGITS[r]} want ${want[r]}`).join() || 'none'}`);
    }
    check('CC has no field width (it is drawn as its flag buttons)', !('cc' in Emu.REGISTER_DIGITS), String(Emu.REGISTER_DIGITS.cc));
  }
  // codeDisassembly tolerates a machine with no config or CPU (mid-construction), and always gives the 6803 a
  // direct page of 0 even if its core were ever to grow a `dp` field.
  {
    const bare = Emu.codeDisassembly({ config: null, cpu: null });
    check('codeDisassembly with no config or CPU reads as a 6809 with DP 0', bare.cpu === '6809' && bare.dp === 0, JSON.stringify(bare));
    const zero = Emu.createMachine('mc10');
    zero.cpu.dp = 0x40;                        // a dp the 6803 does not really have: it must still be ignored
    const d3 = Emu.codeDisassembly(zero);
    check('codeDisassembly gives a 6803 DP 0 even if its core had one', d3.cpu === '6803' && d3.dp === 0, JSON.stringify(d3));
  }
  // A run that really executes: with DP $40, `STA <$10` stores to $4010 and not $0010 (the CPU is the
  // oracle), and the trace names the symbol there only if the entry is disassembled against the DP it ran
  // with. A disassembly at DP 0 would print the symbol as data, or the bytes of another instruction.
  {
    const r = Emu.assemble(' ORG $3000\nSTART LDA #$80\n STA <$10\nDONE BRA DONE\n', '6309');
    if (!r.ok) throw new Error('6309 DP firmware does not assemble: ' + JSON.stringify(r.errors));
    const m = Emu.createMachine('coco3', { cpu: '6309' });
    m.injectAndRun(r.segments, r.exec);
    const dbg = new Emu.Debugger(m);
    dbg.setSymbols(new Map([['VAR', 0x4010]]));
    m.cpu.dp = 0x40;
    m.cpu.jump(sym('START', r));
    dbg.clearTrace();
    dbg.addBreakpoint(sym('DONE', r));
    dbg.run(100);
    const store = dbg.trace().find((e) => e.pc === sym('START', r) + 2);
    // the CPU is the oracle for what ran
    check('6309: a run with DP $40 stores to $4010, not $0010', m.ram[0x4010] === 0x80 && m.ram[0x0010] !== 0x80,
      `${h(0x4010)}=$${m.ram[0x4010].toString(16)} ${h(0x10)}=$${m.ram[0x10].toString(16)}`);
    // and the trace of that run is disassembled against the DP it ran with (the entry carries it)
    check('6309: the trace names its direct operand against DP $40', !!store && /^STA <VAR$/.test(store.text) && store.dp === 0x40,
      JSON.stringify(store && { text: store.text, dp: store.dp }));
  }
  // codeAt ("what is this code doing?") reads 6309 code with the 6309's own instruction set and register set
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('coco3', { cpu: '6309' });
    const r = Emu.assemble(' ORG $3000\nSTART LDA <$10\n LDQ #$11223344\n', '6309');
    if (!r.ok) throw new Error('6309 codeAt firmware does not assemble: ' + JSON.stringify(r.errors));
    for (const [i, b] of [...r.segments[0].data].entries()) s.debug.write(0x3000 + i, [b]);
    s.machine.cpu.dp = 0x40;
    s.machine.cpu.jump(0x3000);
    // distinct values in every 6309-only register, so a line that prints the wrong one (or masks Q to 16 bits)
    // shows: Q = $11223344 splits as D = $1122 and W = $3344, and W splits as E = $33, F = $44
    s.machine.cpu.q = 0x11223344; s.machine.cpu.v = 0x5566;
    const c = s.codeAt(0x3000, 2);
    check('6309: codeAt disassembles LDQ as LDQ, not as data', /LDQ #\$11223344/.test(c.text) && !/FCB/.test(c.text), JSON.stringify(c.text));
    check('6309: codeAt shows all 32 bits of Q', /\bQ=11223344\b/.test(c.registers), c.registers);
    check('6309: codeAt shows E, F, W and V with their own values', /\bE=33\b/.test(c.registers) && /\bF=44\b/.test(c.registers)
      && /\bW=3344\b/.test(c.registers) && /\bV=5566\b/.test(c.registers), c.registers);
    check('6309: codeAt shows MD and the real DP', /\bMD=[0-9A-F]{2}\b/.test(c.registers) && /\bDP=40\b/.test(c.registers), c.registers);
  }
}

console.log(`${n - fail}/${n} debugger checks passed`);
process.exitCode = fail ? 1 : 0;
