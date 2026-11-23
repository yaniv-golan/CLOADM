// Run: node tests/held-writeio.test.js
//
// An outside write must not run in the middle of a held I/O access.
//
// The CoCo 3 keeps an instruction the disk controller's HALT suspended (js/machines/halt-replay.js haltDefer) and, between
// runs, asks the scheduler to pump that instruction's events with the held access's time (`haltResume` sets
// `heldIo`, which ioTime()/accessStart() read). That window exists for the held access's own devices. Anything else
// that reaches the bus in it runs in a machine state no instruction may see: the CPU's cycle count is the suspended
// instruction's, ioShift points its start back to d.s, and haltCancel()'s `!inStep` guard does not hold there.
//
// The READ side is deliberately NOT deferred, but not because it is inert: ioRead() runs the same ioSync(), and a
// read of the FDC has device side effects - a status or data read clears INTRQ/DRQ, and dropping DRQ reasserts HALT
// (js/machines/fdc.js updateLines). That is the point: the window exists so the held access's own devices run, and a
// read there is made at the held access's time (ioTime()'s held branch), where its side effects belong - a read that
// releases HALT is exactly what a halted loop waits for. A WRITE is not safe there, by two paths in ioWrite:
//   * ioSync() (js/machines/coco3.js) pumps the scheduler at the held access's time, which is behind the machine's
//     own time (the parked machine is at `cycle`, the held access at d.s + d.n*div - 1);
//   * a rate write to $FFD6-$FFD9 takes the `!inStep` branch and calls haltCancel(), which ends the suspended
//     instruction from inside the run of that very instruction's events. haltResume() then parks with a stale
//     local `d`, and the CPU's cycle count is never charged for the time that elapsed.
// Measured at commit 570d3fc (before this change), one identical $FFD9 write: made while parked it charges 34,724 CPU cycles
// over the frame; made one tick inside the window it charges 4,856. Same write, two machines.
//
// So a write from outside is queued while `heldIo` is set and made between instructions, at the machine's own time
// (the next runCycles). That is what an outside access means (docs/verification.md: between runs the CPU's cycle
// count is 0 and an access from outside is timed at the machine's time), and only a tool can make one while an
// instruction is held, so no firmware can observe the wait.
//
// The oracle is the machine itself: an outside write made inside the window must leave the machine exactly where the
// same write made once the machine is parked leaves it - the same trace, the same registers, the same cycle count
// and the same machine time. `poke` (no bus cycle, no timing) and reads are not deferred, and are pinned so.
const path = require('path');
const Emu = require('./load')();
const spec = require(path.join(__dirname, '../tools/mame-diff/fdc/spec.js'));

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase();

// A CoCo 3 with the CoCo FDC and no disk in drive 0: the controller's READ SECTOR never brings its DRQ, so the
// instruction that touches the data register is suspended and parked (ioTime.test.js section 6 uses the same run).
const held = () => {
  const t = spec.trace('coco3', { controller: 'cocofdc', halt: true, empty: true });
  const m = t.machine();
  let frames = 0;
  while (frames < 400) { m.runFrame(); frames++; if (m.halt.haltDefer && !m.inStep && m.cpu.cycleCount === 0) break; }
  return m;
};
// run `fn` inside the held window (from an event the held run fires), and record what the machine looked like
// immediately before and after
const inWindow = (m, fn) => {
  const seen = [];
  m.on('outside-write', (arg, at) => {
    if (!m.halt.heldIo) return;
    const before = { at, ioTime: m.ioTime(), cycle: m.cycle, div: m.div, held: !!m.halt.haltDefer, redirects: m.redirects };
    const threw = (() => { try { fn(m); return null; } catch (e) { return e.message; } })();
    seen.push({ before, threw, after: { ioTime: m.ioTime(), cycle: m.cycle, div: m.div, held: !!m.halt.haltDefer, redirects: m.redirects } });
  });
  m.schedule(m.cycle + 1, 'outside-write');
  return seen;
};
// The queue is drained by the run that queues it (the flush after runCycles), so a run leaves it behind in exactly
// one way: a stall. A DriveWire write in the held window sets Machine.waitFor's stall, and the flush leaves the
// queue for the run the stall ends in (js/machines/coco3.js flushOutsideWrites). That is how these tests reach a
// queue that outlives its run - the same path a real machine takes while its store is busy. A throwing handler is
// covered too: haltResume's catch flushes before the throw leaves the frame.
const queueThenThrow = (m, a, v) => {
  const seen = [];
  m.on('outside-write', () => {
    if (!m.halt.heldIo) return;
    seen.push(true);
    m.write(a, v);
    throw new Error('test: a host hook that throws');   // out of the frame, not caught by the handler
  });
  m.schedule(m.cycle + 1, 'outside-write');
  let err = null;
  try { m.runFrame(); } catch (e) { err = e; }
  return { seen, err };
};

// a host handler that throws out of the frame: the write it queued in the window is still made. The throw leaves
// through haltResume's catch (not the after-loop flush, which a throw never reaches), which clears the window and
// flushes before rethrowing, so a throw cannot strand a write the bus was told about.
{
  const m = held();
  const { seen, err } = queueThenThrow(m, 0xFFB1, 0x08);
  check('held window: a write queued in a run that throws on its way out is still made by that run',
    seen.length === 1 && !!err && /test: a host hook that throws/.test(err.message) && m.halt.outsideWrites.length === 0
      && m.gime.palette[1] === 0x08,
    `the handler ran ${seen.length}x, the frame threw ${err ? err.message : 'nothing'}, left ${m.halt.outsideWrites.length}, palette1 ${hex(m.gime.palette[1])}`);
}

// ---- 1. the window itself: a write from outside does not run in it ----
// Red at commit 570d3fc (before this change) for $FFD9: haltCancel runs inside the window, so the suspended instruction is
// already gone (held null) and `redirects` has moved before the event handler returns.
// The PIA0 and palette rows are CONTROLS, not fixes: their writes cannot tear the held state on the base either,
// so they pass there too; they are here to show the change is the rate path's, not every write's. The $FFD9 row is
// the one that fails without the fix.
for (const [label, addr, value] of [
  ['a rate write to $FFD9', 0xFFD9, 0x00],
  ['a PIA0 write to $FF01', 0xFF01, 0x00],
  ['a palette write to $FFB0', 0xFFB0, 0x01],
]) {
  const m = held();
  const d0 = m.halt.haltDefer, div0 = m.div;
  const want = d0.s + d0.n * div0 - 1;      // (the parked divider: a rate write changes m.div by the end of the frame)
  const seen = inWindow(m, (mm) => mm.write(addr, value));
  m.runFrame();
  check(`held window: ${label} from outside leaves the suspended instruction where it is`,
    seen.length === 1 && seen[0].before.held && seen[0].after.held && seen[0].after.redirects === seen[0].before.redirects,
    seen.length ? `held ${seen[0].before.held}->${seen[0].after.held}, redirects ${seen[0].before.redirects}->${seen[0].after.redirects}` : 'the window never ran');
  // (a control on the window itself, true before and after: inside it ioTime() is the held access's time. Not the
  // design's claim - the design's is that the write does not RUN there - but the premise it rests on.)
  check(`held window: ${label} is queued while the window reports the held access's time (control)`,
    seen.length === 1 && seen[0].before.ioTime === want,
    seen.length ? `ioTime ${seen[0].before.ioTime}, held access ${want}` : '');
}

// ---- 2. the deferred write lands, once, in order, and at the machine's own time ----
// A palette register ($FFB0-$FFBF) leaves a value to read back and changes no timing. Two writes in the window must
// land in the order they were made, one each. The ioWrite wrapper counts how many bus writes the machine made in the
// window: none may happen there.
{
  const m = held();
  const writes = [];
  const orig = m.ioWrite.bind(m);
  m.ioWrite = (a, v) => { writes.push([a, v, m.halt.heldIo]); return orig(a, v); };
  const inWin = inWindow(m, (mm) => { mm.write(0xFFB0, 0x01); mm.write(0xFFB1, 0x02); });
  m.runFrame();
  m.ioWrite = orig;
  const landed = writes.filter(([a]) => a === 0xFFB0 || a === 0xFFB1);
  check('held window: the deferred writes are not made while the window runs',
    inWin.length === 1 && landed.every(([, , during]) => !during) && writes.length > 0,
    `${landed.length} bus writes: ${landed.map(([a, v, during]) => `${hex(a)}=${v}${during ? ' (in window)' : ''}`).join(', ')}`);
  check('held window: both deferred writes land, once each, in the order they were made',
    landed.length === 2 && landed[0][0] === 0xFFB0 && landed[0][1] === 0x01 && landed[1][0] === 0xFFB1 && landed[1][1] === 0x02,
    landed.map(([a, v]) => `${hex(a)}=${v}`).join(' '));
  check('held window: the palette holds both deferred values',
    m.gime.palette[0] === 0x01 && m.gime.palette[1] === 0x02,
    `palette ${hex(m.gime.palette[0])}, ${hex(m.gime.palette[1])}`);
}

// ---- 3. the machine ends exactly where the same write made while parked leaves it ----
// The exact oracle: run the frame with the write in the window, and run the identical machine with the write made
// once the frame has ended (the machine parked). Release HALT in both, run on, and compare the whole run: the
// instruction trace, the registers, the CPU's cycle count and the machine's time.
const ramp = (m) => {
  const trace = [];
  m.cpu.trace = function () { trace.push(`${this.pc.toString(16)}:${this.cc.toString(16)}`); };
  return trace;
};
for (const [label, addr, value] of [['a rate write to $FFD9', 0xFFD9, 0x00], ['a PIA0 write to $FF01', 0xFF01, 0x00]]) {
  const run = (inWindowWrite) => {
    const m = held();
    const trace = ramp(m);
    if (inWindowWrite) { inWindow(m, (mm) => mm.write(addr, value)); m.runFrame(); }
    else { m.runFrame(); m.write(addr, value); }
    const parked = { cycle: m.cycle, total: m.cpu.totalCycles, div: m.div, held: !!m.halt.haltDefer, redirects: m.redirects };
    // release HALT and let the machine run on: the instruction that was held either completes or is dropped, and
    // from there the program is the same
    m.write(0xFF48, 0xD8);
    for (let i = 0; i < 4; i++) m.runFrame();
    return { parked, end: { cycle: m.cycle, total: m.cpu.totalCycles, div: m.div, pc: m.cpu.pc, a: m.cpu.a, x: m.cpu.x, y: m.cpu.y, cc: m.cpu.cc }, trace: trace.join() };
  };
  const a = run(true), b = run(false);
  check(`held window: ${label} from outside leaves the parked machine as the same write made while parked does`,
    a.parked.cycle === b.parked.cycle && a.parked.total === b.parked.total && a.parked.div === b.parked.div
      && a.parked.held === b.parked.held && a.parked.redirects === b.parked.redirects,
    `in window ${JSON.stringify(a.parked)}, parked ${JSON.stringify(b.parked)}`);
  check(`held window: ...and the run that follows is the same (trace, registers, cycles, time)`,
    a.end.cycle === b.end.cycle && a.end.total === b.end.total && a.end.div === b.end.div && a.end.pc === b.end.pc
      && a.end.a === b.end.a && a.end.x === b.end.x && a.end.y === b.end.y && a.end.cc === b.end.cc && a.trace === b.trace,
    `cycle ${a.end.cycle}/${b.end.cycle} total ${a.end.total}/${b.end.total} pc ${hex(a.end.pc)}/${hex(b.end.pc)} trace ${a.trace === b.trace ? 'same' : 'differs'}`);
}

// ---- 4. poke and reads are not deferred ----
// poke writes the image below the bus: there is no bus cycle and no timing, so nothing about a held access can be
// torn by it, and a tool that pokes during the window sees the byte at once - unless an outside write is already
// waiting, which it then queues behind (section 10). A read is serviced in the window at the held access's time,
// side effects and all: a guard that moved that time or dropped the byte shows here.
{
  const m = held();
  const d0 = m.halt.haltDefer, div0 = m.div;
  const logged = [];
  for (let i = 0; i < d0.log.length; i += 2) logged.push(d0.log[i]);
  const ram = logged.find((a) => a < 0xFF00 && m.writeKind(a) === null) ?? 0x0400;
  const was = m.peek(ram);
  // an I/O read whose value depends on the machine and is not 0: the FDC's status at $FF48 (a guard answering 0,
  // or one moving the answer off the held access's time, both show)
  const parkedRead = m.read(0xFF48);
  let afterPoke = null, readInWindow = null;
  inWindow(m, (mm) => {
    mm.poke(ram, (was ^ 0x5A) & 0xFF);
    afterPoke = { byte: mm.peek(ram), held: !!mm.halt.haltDefer, redirects: mm.redirects };
    readInWindow = { ioTime: mm.ioTime(), value: mm.read(0xFF48) };
  });
  m.runFrame();
  check('held window: a poke lands at once (no bus cycle, no timing to tear)',
    afterPoke !== null && afterPoke.byte === ((was ^ 0x5A) & 0xFF) && afterPoke.held && afterPoke.redirects === 0,
    JSON.stringify(afterPoke));
  // the read is serviced in the window, at the held access's time, and answers what PIA0 holds: the behaviour the
  // write side now matches by waiting for the machine's own time
  check('held window: a read is still serviced in it, at the held access\'s time, from the device',
    readInWindow !== null && readInWindow.ioTime === d0.s + d0.n * div0 - 1 && readInWindow.value === parkedRead && parkedRead !== 0,
    readInWindow ? `ioTime ${readInWindow.ioTime} (held access ${d0.s + d0.n * div0 - 1}), FDC $FF48 ${hex(readInWindow.value)} (parked read ${hex(parkedRead)})` : '');
}

// queue a write in the held window and stall the machine on the store, as a DriveWire write does; the run then
// ends with the write still owed
const queueAndStall = (m, a, v) => {
  inWindow(m, (mm) => { mm.write(a, v); mm.waitFor(new Promise(() => {})); });
  m.runFrame();
  return m.halt.outsideWrites.length;
};

// ---- 5. a queued write is let go even when the CPU never runs again ----
// A halt park can span frames: HALT stays asserted, runCycles makes no step, and the frame loop keeps calling it.
// The queue must not sit out the park. The flush after the loop makes it at the end of the very run the write was
// queued in, whatever happened inside (a step or a park), so the next read of a register sees it.
{
  const m = held();
  inWindow(m, (mm) => mm.write(0xFFB0, 0x03));
  // the write was made in an event of this frame's run; it must be in before that run returns
  m.runFrame();
  check('held window: a write queued in the window is made before the run that queued it returns',
    m.gime.palette[0] === 0x03 && m.halt.outsideWrites.length === 0,
    `palette0 ${hex(m.gime.palette[0])}, queued ${m.halt.outsideWrites.length}, still held ${!!m.halt.haltDefer}`);
  // and a run that makes no step at all still makes it: step no instruction, and the queue empties
  const m2 = held();
  m2.halt.outsideWrite(0xFFB1, 0x04);
  m2.runCycles(m2.cycle);                 // the CPU already at `end`: the loop makes no step
  check('held window: a run with no step to make still makes the queued write',
    m2.gime.palette[1] === 0x04 && m2.halt.outsideWrites.length === 0,
    `palette1 ${hex(m2.gime.palette[1])}, queued ${m2.halt.outsideWrites.length}`);
}

// ---- 6. a reset drops a queued write ----
// A reset drops every access made while an instruction was held, and the same write made while parked is wiped by
// one too (the reset clears the memory and the GIME). So a queued write must not survive it: made after the reset it
// would land in a machine the tool never wrote to.
{
  const m = held();
  const owed = queueAndStall(m, 0xFFB0, 0x07);
  m.reset(true);
  const left = m.halt.outsideWrites.length;
  const writes = [];
  const orig = m.ioWrite.bind(m);
  m.ioWrite = (a, v) => { writes.push(a); return orig(a, v); };
  m.stall = null;
  for (let i = 0; i < 3; i++) m.runFrame();
  m.ioWrite = orig;
  check('held window: a reset drops a queued outside write (as it drops the same write made while parked)',
    owed === 1 && left === 0 && writes.filter((a) => a === 0xFFB0).length === 0 && m.gime.palette[0] !== 0x07,
    `queued before reset ${owed}, left ${left}, writes ${writes.filter((a) => a === 0xFFB0).length}, palette0 ${hex(m.gime.palette[0])}`);
}

// ---- 7. a snapshot carries a queued write, and a restore makes it ----
// A saveState() can run while a write is queued - a halt park spans frames, and the queue is only drained by a run.
// The write is owed to the machine, so the file carries it (a restore into it would otherwise drop a debugger's
// write) and the restored machine makes it in its next run, exactly as the original does.
{
  const m = held();
  const owed = queueAndStall(m, 0xFFB0, 0x05);
  const snap = m.snapshot();
  const b = held();                                // the same run, so the same model, options and ROM set
  b.restore(Emu.state.fromJSON(Emu.state.toJSON(snap)));
  const bOwed = b.halt.outsideWrites.length;
  b.stall = null;                                  // the store answers (a snapshot carries no stall: it is not state)
  m.stall = null;
  b.runCycles(b.cycle);                            // no step: the flush after the loop still makes it
  m.runCycles(m.cycle);
  // (version 3 and later carry the queue as `outsideWrites`: machine.js's version note, "3:")
  check('held window: a snapshot carries the queued write, and the restore makes it as the original does',
    owed === 1 && bOwed === 1 && Array.isArray(snap.state.outsideWrites) && snap.state.outsideWrites.length === 1 && snap.version === Emu.SNAPSHOT_VERSION
      && b.gime.palette[0] === 0x05 && m.gime.palette[0] === 0x05,
    `queued ${owed}/${bOwed}, file ${Array.isArray(snap.state.outsideWrites) ? snap.state.outsideWrites.length : 'no key'} (v${snap.version}), palette0 ${hex(m.gime.palette[0])}/${hex(b.gime.palette[0])}`);
  // a malformed queue in a file is refused, not restored
  for (const [what, bad] of [['an address past the space', [{ a: 0x10000, v: 0 }]], ['a byte past $FF', [{ a: 0x400, v: 0x100 }]],
    ['not a pair', [{ a: 0x400 }]], ['not a list', 'x'],
    // poke() itself refuses the I/O page; a file must not get pokeNow to write the image beneath it
    ['a poke at $FF00', [{ a: 0xFF00, v: 0, poke: true }]], ['a poke at $FFFF', [{ a: 0xFFFF, v: 0, poke: true }]]]) {
    const file = Emu.state.fromJSON(Emu.state.toJSON(snap));
    file.state.outsideWrites = bad;
    let err = null;
    try { b.restore(file); } catch (e) { err = e; }
    check(`held window: a snapshot with ${what} in "outsideWrites" is refused`, !!err && /outsideWrites/.test(err.message), err ? err.message : 'restored');
  }
}

// ---- 7b. a snapshot taken with writes queued: the restored machine runs on identically (docs section 4.5) ----
// The queued writes here run code: a FORCE INTERRUPT to $FF48 releases HALT, so the held instruction finishes and the
// firmware goes on, and a palette write changes what is drawn. Saved with both owed, restored into a fresh machine,
// the stalls cleared, the restored run must equal the uninterrupted one: every instruction's registers and cycle
// count, and every frame's pixels.
{
  const REGS = ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'];
  const go = (mm, frames) => {
    let h = 0x811C9DC5, n = 0;
    const fnv = (x, v) => Math.imul(x ^ (v & 0xFFFFFFFF), 0x01000193) >>> 0;
    mm.cpu.trace = (c) => { n++; for (const r of REGS) h = fnv(h, c[r]); h = fnv(h, c.totalCycles); };
    for (let f = 0; f < frames; f++) {
      mm.runFrame();
      if (f > 0) { const px = mm.render().data; for (let i = 0; i < px.length; i++) h = fnv(h, px[i]); }   // (frame 0 may hold a pre-snapshot picture)
    }
    mm.cpu.trace = null;
    return { h, n, cycle: mm.cycle, total: mm.cpu.totalCycles, held: !!mm.halt.haltDefer, pal: mm.gime.palette[6] };
  };
  const m = held();
  inWindow(m, (mm) => { mm.write(0xFF48, 0xD8); mm.write(0xFFB6, 0x3F); mm.waitFor(new Promise(() => {})); });
  m.runFrame();
  const owed = m.halt.outsideWrites.length;
  const snap = m.snapshot();
  const b = held();
  b.restore(Emu.state.fromJSON(Emu.state.toJSON(snap)));
  m.stall = null; b.stall = null;
  const cont = go(m, 8), rest = go(b, 8);
  check('held window: restored with two writes queued (HALT release, palette), the run goes on identically (trace, frames)',
    owed === 2 && cont.n > 1000 && !cont.held && cont.pal === 0x3F && rest.h === cont.h && rest.n === cont.n
      && rest.cycle === cont.cycle && rest.total === cont.total,
    `owed ${owed}, instructions ${cont.n}/${rest.n}, hash ${cont.h.toString(16)}/${rest.h.toString(16)}, held after ${cont.held}/${rest.held}, palette6 ${hex(cont.pal)}/${hex(rest.pal)}`);
}

// ---- 7c. a queued poke keeps its poke flag through a snapshot ----
// A poke writes the memory image, even under ROM; a bus write there takes nothing. So a queued poke to a ROM-mapped
// address shows the flag's round trip: saved and restored, it must still land in the image beneath the ROM.
{
  const m = held();
  const at = 0xC100;
  const rom = m.writeKind(at) !== null;
  const owed = queueAndStall(m, 0xFFB7, 0x01);            // a stalled queue, so the poke waits behind it
  m.poke(at, 0x5A);
  const file = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const b = held();
  b.restore(file);
  b.stall = null;
  b.runCycles(b.cycle);                                   // no step: the after-loop flush makes both
  const image = (mm) => mm.mem[((mm.gime.blockFor(at >> 13) * 0x2000) + (at & 0x1FFF)) & (mm.mem.length - 1)];
  const flags = (file.state.outsideWrites || []).map((w) => w.poke);
  check('held window: a queued poke under ROM survives a snapshot as a poke and lands in the image',
    rom && owed === 1 && flags.length === 2 && flags[0] === false && flags[1] === true && image(b) === 0x5A && b.halt.outsideWrites.length === 0,
    `ROM at ${hex(at)} ${rom}, flags ${JSON.stringify(flags)}, image ${hex(image(b))}, left ${b.halt.outsideWrites.length}`);
}

// ---- 7d. a restore keeps the queue's ORDER ----
// 7b's and 7c's writes commute, so a restore that reordered the queue would pass them. Two writes to the SAME register
// do not: the later value must be the one left after the restore and the flush, and the restored queue must equal the
// saved one entry for entry.
{
  const m = held();
  inWindow(m, (mm) => { mm.write(0xFFB6, 0x3F); mm.write(0xFFB6, 0x12); mm.waitFor(new Promise(() => {})); });
  m.runFrame();
  const saved = m.halt.outsideWrites.map((w) => [w.a, w.v, w.poke]);
  const b = held();
  b.restore(Emu.state.fromJSON(Emu.state.toJSON(m.snapshot())));
  const restored = b.halt.outsideWrites.map((w) => [w.a, w.v, w.poke]);
  b.stall = null;
  b.runCycles(b.cycle);                                   // no step: the after-loop flush makes both, in order
  check('held window: a restore keeps the queued writes in order (two to one register: the later value is final)',
    JSON.stringify(saved) === JSON.stringify([[0xFFB6, 0x3F, false], [0xFFB6, 0x12, false]])
      && JSON.stringify(restored) === JSON.stringify(saved) && b.gime.palette[6] === 0x12 && b.halt.outsideWrites.length === 0,
    `saved ${JSON.stringify(saved)}, restored ${JSON.stringify(restored)}, palette6 ${hex(b.gime.palette[6])}`);
}

// ---- 8. the debugger sees a deferred write only once it has landed ----
// Debugger.write while held is queued like any other outside write, so an immediate Debugger.read of the same
// address answers the byte before it - the machine has not made the write yet, and a read that answered otherwise
// would report a bus state the hardware never had. After the run it is there. (page.js's byte-set calls
// session.personInput() and refreshes, which runs a frame; the panel is not left showing a stale byte.)
{
  const m = held();
  const d0 = m.halt.haltDefer;
  // a RAM byte the suspended instruction did not touch: a write to one it did read would be caught by cpuCheck and
  // drop the instruction (an outside change to memory it used), which is a different rule and is already pinned
  const logged = new Set();
  for (let i = 0; i < d0.log.length; i += 2) logged.add(d0.log[i]);
  const ram = [...Array(0x100).keys()].map((i) => 0x0400 + i).find((a) => !logged.has(a) && m.writeKind(a) === null);
  const was = m.peek(ram);
  const dbg = new Emu.Debugger(m);
  let before = null, after = null, queued = null;
  inWindow(m, (mm) => {
    dbg.write(ram, [(was ^ 0x5A) & 0xFF]);
    before = dbg.read(ram);             // the debugger's own view (peek): nothing bus-side happens
    queued = mm.halt.outsideWrites.length;
  });
  m.runFrame();
  after = dbg.read(ram);
  dbg.detach();
  check('held window: a debugger write in the window is queued, and its read answers the machine as it stands',
    queued === 1 && before === was && after === ((was ^ 0x5A) & 0xFF),
    `queued ${queued} at ${hex(ram)}, read before ${hex(before)} (=${hex(was)}), after ${hex(after)}`);
}

// ---- 9. no watchpoint fires for a write the debugger queued itself ----
// Debugger.write goes through the unwrapped write, so it reports no access and a watchpoint on its address does not
// fire for it. The flush must do the same. Through machine.write it calls the debugger's wrapper, _access('write')
// matches the watchpoint, and the machine stops at the next instruction that runs - blamed on that instruction for a
// write the debugger made. Reached through the stall path: the queue waits across a run, HALT is released, and the
// flush at the top of the next run is followed by an instruction, which is where a spurious hit becomes a stop.
// (Without the stall the flush lands in the run that is still held, and that run makes no step, so _stepOnce drops
// a hit as it drops everything of a step that did not happen - the defect would not show.)
{
  const m = held();
  const d0 = m.halt.haltDefer;
  const logged = new Set();
  for (let i = 0; i < d0.log.length; i += 2) logged.add(d0.log[i]);
  const ram = [...Array(0x100).keys()].map((i) => 0x0400 + i).find((a) => !logged.has(a) && m.writeKind(a) === null);
  const dbg = new Emu.Debugger(m);
  dbg.addWatchpoint(ram, 1, { read: false, write: true });
  m.on('outside-write', () => { if (m.halt.heldIo) { dbg.write(ram, [0x5A]); m.waitFor(new Promise(() => {})); } });
  m.schedule(m.cycle + 1, 'outside-write');
  m.runFrame();
  const owed = m.halt.outsideWrites.length;
  m.stall = null;
  m.write(0xFF48, 0xD8);            // FORCE INTERRUPT: HALT goes, so instructions run again
  let stopped = 0;
  for (let i = 0; i < 40; i++) if (!dbg.runFrame()) { stopped++; dbg.resume(); }
  dbg.detach();
  check('held window: a watchpoint on the address does not fire for the debugger\'s own queued write',
    owed === 1 && stopped === 0 && m.peek(ram) === 0x5A,
    `owed ${owed}, stopped ${stopped}, byte ${hex(m.peek(ram))}`);
}

// ---- 10. the later call's value is final: a write or a poke behind a stalled queue waits in order ----
// A stall holds the queue across runs. A later outside write (a debugger write, heldIo false) must not land at once
// and then be overwritten by the older queued value: it queues behind it. A poke, too, though it writes the image
// with no bus cycle - its value must be the one left in memory.
{
  const m = held();
  const owed = queueAndStall(m, 0xFFB0, 0x01);          // queued, stalled: not made yet
  const dbg = new Emu.Debugger(m);
  dbg.write(0xFFB0, [0x02]);                            // a later debugger write to the same register
  const behind = m.halt.outsideWrites.length;
  m.stall = null;
  m.runCycles(m.cycle);                                 // no step: the flush after the loop makes both, in order
  dbg.detach();
  check('held window: a later outside write behind a stalled queue lands last, not first',
    owed === 1 && behind === 2 && m.gime.palette[0] === 0x02 && m.halt.outsideWrites.length === 0,
    `queued ${owed} then ${behind}, palette0 ${hex(m.gime.palette[0])}, left ${m.halt.outsideWrites.length}`);

  // a poke behind a stalled queued write to the same byte: the poke's value is final
  const p2 = held();
  const owed2 = queueAndStall(p2, 0x0401, 0x11);
  p2.poke(0x0401, 0x22);
  const behind2 = p2.halt.outsideWrites.length;
  p2.stall = null;
  p2.runCycles(p2.cycle);
  check('held window: a poke behind a stalled queue lands last, and its value is final',
    owed2 === 1 && behind2 === 2 && p2.peek(0x0401) === 0x22 && p2.halt.outsideWrites.length === 0,
    `queued ${owed2} then ${behind2}, byte ${hex(p2.peek(0x0401))}, left ${p2.halt.outsideWrites.length}`);
}

// ---- 11. a write made DURING the flush waits behind the entries still queued ----
// The queued write's own device side effects pump events. A handler that writes from one must queue behind what is
// still waiting, or it lands ahead of an older entry and is then overwritten by it. Here the first entry is a
// $FFD9 rate write (its ioSync fires the event scheduled with it), the second a $0400 write; the handler pokes $0400
// in between. The later write must be the final one.
{
  const m = held();
  m.halt.outsideWrite(0xFFD9, 0x00);             // first: its I/O sync pumps the event below
  m.halt.outsideWrite(0x0400, 0x11);             // second: the older value that must not win
  let inFlush = null;
  m.on('mid-flush', () => {
    inFlush = m.halt.outsideWrites.length;       // (the one being made now, still at the head, plus one waiting)
    m.write(0x0400, 0x22);                  // a later write from a handler
  });
  m.schedule(m.cycle, 'mid-flush');
  m.runCycles(m.cycle);                     // no step: the after-loop flush makes the queue
  check('held window: a write made during the flush queues behind the entries still waiting',
    inFlush !== null && inFlush === 2 && m.peek(0x0400) === 0x22 && m.halt.outsideWrites.length === 0,
    `in flush saw ${inFlush} waiting, byte ${hex(m.peek(0x0400))}, left ${m.halt.outsideWrites.length}`);
}

// ---- 12. a debugger detached between the queue and the flush ----
// The flush makes each entry through the machine's own bus write, so a debugger attached at the time of the flush
// cannot report it, and one detached before it changes nothing.
{
  const m = held();
  const dbg = new Emu.Debugger(m);
  inWindow(m, (mm) => { dbg.write(0xFFB2, [0x03]); mm.waitFor(new Promise(() => {})); });
  m.runFrame();
  const owed = m.halt.outsideWrites.length;
  dbg.detach();
  m.stall = null;
  m.runFrame();
  check('held window: detaching a debugger between the queue and the flush still makes the queued write',
    owed === 1 && m.gime.palette[2] === 0x03 && m.halt.outsideWrites.length === 0,
    `owed ${owed}, palette2 ${hex(m.gime.palette[2])}, left ${m.halt.outsideWrites.length}`);
}

// ---- 13. a queued poke is made as a poke, not as a bus write ----
// The flush changed shape (one entry at a time, through busWrite), so it must still send a poke entry to pokeNow:
// poke writes the memory image, even where ROM is mapped over it, and takes no bus cycle. Asserted directly, on the
// two paths, because a RAM byte reads the same either way and would not tell them apart.
{
  const m = held();
  m.halt.outsideWrite(0xFFB3, 0x04);            // a bus write first
  m.poke(0x0402, 0x33);                    // a poke behind it
  const calls = [];
  const bw = m.busWrite.bind(m), pn = m.pokeNow.bind(m);
  m.busWrite = (a, v) => { calls.push(['busWrite', a, v]); return bw(a, v); };
  m.pokeNow = (a, v) => { calls.push(['pokeNow', a, v]); return pn(a, v); };
  m.runCycles(m.cycle);                    // no step: the after-loop flush makes both, in order
  m.busWrite = bw; m.pokeNow = pn;
  const pokeCall = calls.filter(([k]) => k === 'pokeNow');
  const busForPoke = calls.filter(([k, a]) => k === 'busWrite' && a === 0x0402);
  check('held window: a queued poke is flushed through pokeNow (the image), never through busWrite',
    pokeCall.length === 1 && pokeCall[0][1] === 0x0402 && pokeCall[0][2] === 0x33 && busForPoke.length === 0
      && m.peek(0x0402) === 0x33 && m.gime.palette[3] === 0x04,
    `pokeNow ${JSON.stringify(pokeCall)}, busWrite for it ${busForPoke.length}, byte ${hex(m.peek(0x0402))}, palette3 ${hex(m.gime.palette[3])}`);
}

// ---- 14. a write made during the flush of the LAST queued entry still queues behind it ----
// Section 11 covers an entry with another still waiting. With one entry, a flush that takes it off the queue before
// making it leaves the queue empty while its busWrite runs: ioWrite's ioSync fires events, a handler's write to the
// same register then lands at once (write() sees no queue), and the older queued value lands after it and wins.
{
  const m = held();
  m.halt.outsideWrite(0xFFB2, 0x01);             // the only entry: the older value
  let inFlush = null;
  m.on('mid-flush-last', () => {
    inFlush = m.halt.outsideWrites.length;       // the entry being made is still at the head
    m.write(0xFFB2, 0x02);                  // a later write from a handler, pumped by that entry's ioSync
  });
  m.schedule(m.cycle, 'mid-flush-last');
  m.runCycles(m.cycle);                     // no step: the after-loop flush makes the queue
  check('held window: a write made during the flush of the last entry lands after it (its value is final)',
    inFlush === 1 && m.gime.palette[2] === 0x02 && m.halt.outsideWrites.length === 0,
    `in flush saw ${inFlush} queued, palette2 ${hex(m.gime.palette[2])}, left ${m.halt.outsideWrites.length}`);
}

// ---- 15. a flushed write that stalls the machine stops the run before an instruction ----
// A flushed entry can set a stall (a DriveWire write through Machine.waitFor; here an event its ioSync fires). The
// flush then stops, and the run must stop with it: no instruction may run while the machine waits on its store.
{
  const m = held();
  m.write(0xFF48, 0xD8);                    // FORCE INTERRUPT: HALT goes, so instructions run again
  for (let i = 0; i < 3; i++) m.runFrame();
  const free = !m.halt.haltDefer && !m.cpu.haltLine;
  m.halt.outsideWrite(0xFFB4, 0x05);
  m.halt.outsideWrite(0xFFB5, 0x06);             // waits behind the stall
  m.on('stall-mid-flush', () => m.waitFor(new Promise(() => {})));
  m.schedule(m.cycle, 'stall-mid-flush');
  const tc = m.cpu.totalCycles, pc = m.cpu.pc, cyc = m.cycle;
  m.runCycles(m.cycle + 20000);
  check('held window: a flushed write that stalls the machine ends the run before any instruction runs',
    free && !!m.stall && m.cpu.totalCycles === tc && m.cpu.pc === pc && m.cycle === cyc
      && m.gime.palette[4] === 0x05 && m.halt.outsideWrites.length === 1,
    `free ${free}, stall ${!!m.stall}, cycles run ${m.cpu.totalCycles - tc}, pc ${hex(pc)} -> ${hex(m.cpu.pc)}, palette4 ${hex(m.gime.palette[4])}, left ${m.halt.outsideWrites.length}`);
  m.stall = null;
  m.runCycles(m.cycle);
  check('held window: ...and the next run makes the rest of the queue',
    m.gime.palette[5] === 0x06 && m.halt.outsideWrites.length === 0, `palette5 ${hex(m.gime.palette[5])}, left ${m.halt.outsideWrites.length}`);
}

console.log(fail ? `${fail} of ${n} held-write checks FAILED` : `all ${n} held-write checks passed`);
process.exitCode = fail ? 1 : 0;
