// The scenario tests/halt-replay-split.test.js replays to show that moving the CoCo 3's HALT replay into its own object
// (js/machines/halt-replay.js, machine.halt) changed no cycle and no byte: it ran once at the commit before the move,
// with the old names on the machine, and wrote tests/fixtures/halt-replay/expected.json; the test runs it again through
// machine.halt and compares. Not a suite itself (no .test.js suffix).
//
// h(m): where the HALT members live (the machine itself before the move, m.halt after it). Our own firmware throughout
// (tools/mame-diff/fdc: coco-halt.asm, coco-halt-empty.asm; never a ROM). For each case: the snapshot taken while an
// instruction is held (its JSON hashed), the trace that follows it (every instruction's registers and cycle count,
// and every frame's pixels, hashed), and the same continuation from the snapshot restored into a fresh machine.
//  * empty: the halted read on a drive with no disk (held for good), 6809;
//  * queued: the same, with an outside write queued in the held window and the run stalled (the snapshot carries it);
//  * tfm: a 6309 TFM over its own destination, held on an I/O access for three frames, then released;
//  * halted: coco-halt.asm's halted sector reads, snapshots taken every 7 frames through the run (released, held,
//    and with the rest of an instruction's wait still to come).
const crypto = require('crypto');
const path = require('path');
const Emu = require('./load')();
const spec = require(path.join(__dirname, '../tools/mame-diff/fdc/spec.js'));
const images = require('../tools/mame-diff/fdc/images');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
const REGS = ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'];

// n frames of m, every instruction's registers and its cycle count, every frame's pixels -> { trace, frames, instructions, cycles }
function follow(m, n) {
  let h = 0x811C9DC5, f = 0x811C9DC5, count = 0;
  m.cpu.trace = (c) => { for (const r of REGS) h = fnv(h, c[r]); h = fnv(h, c.totalCycles); count++; };
  for (let i = 0; i < n; i++) { m.runFrame(); const px = Emu.frameToRGBA(m.render()); for (let j = 0; j < px.length; j += 7) f = fnv(f, px[j]); }
  m.cpu.trace = null;
  return { trace: h.toString(16), frames: f.toString(16), instructions: count, cycles: m.cpu.totalCycles, at: m.cycle };
}
const snapText = (m) => Emu.state.toJSON(m.snapshot());

// held for good on an empty drive (as tests/held-writeio.test.js held())
function heldEmpty(h) {
  const m = spec.trace('coco3', { controller: 'cocofdc', halt: true, empty: true }).machine();
  for (let frames = 0; frames < 400; frames++) { m.runFrame(); if (h(m).haltDefer && !m.inStep && m.cpu.cycleCount === 0) break; }
  return m;
}
// a fresh machine of the same run with a snapshot restored into it
function restored(fresh, text) { const b = fresh(); b.restore(Emu.state.fromJSON(text)); return b; }

function scenario(h) {
  const out = {};
  // ---- empty ----
  {
    const m = heldEmpty(h);
    const text = snapText(m);
    out.empty = { held: !!h(m).haltDefer, snapshot: sha(text), log: h(m).haltDefer.log.length, after: follow(m, 12) };
    out.empty.restored = follow(restored(() => heldEmpty(h), text), 12);
  }
  // ---- queued: an outside write made in the held window, the run stalled on a store that does not answer ----
  {
    const m = heldEmpty(h);
    m.on('split-window', () => { if (h(m).heldIo) { m.write(0xFFB0, 0x05); m.waitFor(new Promise(() => {})); } });
    m.schedule(m.cycle + 1, 'split-window');
    m.runFrame();
    const text = snapText(m);
    out.queued = { owed: h(m).outsideWrites.length, snapshot: sha(text) };
    m.stall = null;
    out.queued.after = follow(m, 6);
    out.queued.palette0 = m.gime.palette[0];
    const b = restored(() => heldEmpty(h), text);
    b.stall = null;
    out.queued.restored = follow(b, 6);
  }
  // ---- tfm: a 6309 TFM X+,Y+ over its own destination, held, then released (as tests/halt-replay.test.js) ----
  {
    const make = () => {
      const m = Emu.createMachine('coco3', { cpu: '6309' });
      const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
      m.insertCartridge(f);
      m.reset(true);
      f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
      for (let i = 0; i < 3; i++) m.runFrame();
      m.write(0xFF40, 0x29);
      for (let i = 0; i < 30; i++) m.runFrame();
      for (let a = 0xFEB0; a < 0xFF00; a++) m.poke(a, 0x10 + (a & 0x7F));
      const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0x8A, 0xF7, 0xFF, 0x40, 0x11, 0x38, 0x12, 0x20, 0xFE];
      code.forEach((b, i) => m.poke(0x3000 + i, b));
      m.cpu.x = 0xFEC0; m.cpu.y = 0xFEBF; m.cpu.w = 65; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
      return m;
    };
    const m = make();
    let held = 0;
    for (let i = 0; i < 3; i++) { m.runFrame(); if (h(m).haltDefer) held++; }
    const text = snapText(m);
    const release = (x) => { x.write(0xFF48, 0xD8); return follow(x, 4); };
    out.tfm = { held, snapshot: sha(text), log: h(m).haltDefer ? h(m).haltDefer.log.length : null, after: release(m) };
    out.tfm.mem = sha(Buffer.from(Array.from({ length: 0x50 }, (_, i) => m.peek(0xFEB0 + i))).toString('hex'));
    const b = make();
    for (let i = 0; i < 3; i++) b.runFrame();
    b.restore(Emu.state.fromJSON(text));
    out.tfm.restored = release(b);
  }
  // ---- halted: coco-halt.asm's halted sector reads, a snapshot every 7 frames ----
  {
    const t = spec.trace('coco3', { controller: 'cocofdc', halt: true });
    const m = t.machine();
    const snaps = [];
    let h0 = 0x811C9DC5, count = 0;
    m.cpu.trace = (c) => { for (const r of REGS) h0 = fnv(h0, c[r]); h0 = fnv(h0, c.totalCycles); count++; };
    for (let i = 1; i <= 70; i++) {
      m.runFrame();
      if (i % 7 === 0) { const text = snapText(m); snaps.push({ frame: i, held: !!h(m).haltDefer, tail: m.cpu.haltTail, snapshot: sha(text) }); }
    }
    m.cpu.trace = null;
    out.halted = { snaps, trace: h0.toString(16), instructions: count, cycles: m.cpu.totalCycles };
  }
  // ---- irqEntry: HALT inside an IRQ's entry, S in the I/O page ----
  {
    const rows = [];
    let found = 0;
    for (const fast of [false, true]) {
      for (let off = 0; off < 64; off++) {
        const m = Emu.createMachine('coco3', {});
        m.insertCartridge(new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) }));
        m.reset(true);
        for (let i = 0; i < 2; i++) m.runFrame();
        if (fast) m.write(0xFFD9, 0);
        [0x12, 0x20, 0xFD].forEach((b, i) => m.poke(0x3000 + i, b));          // NOP ; BRA *-1
        m.cpu.pc = 0x3000; m.cpu.s = 0xFF60; m.cpu.cc = 0x00;                  // IRQ enabled; the entry pushes to $FF54-$FF5F
        m.runCycles(m.cycle + 200);
        // whether the step's end found the HALT (the after-step haltArrived set the stop point), told apart from the
        // call fireEvent makes between instructions
        const H = h(m), orig = H.haltArrived.bind(H), fe = m.fireEvent.bind(m);
        let inFire = false, atEnd = false;
        m.fireEvent = (e) => { inFire = true; try { fe(e); } finally { inFire = false; } };
        H.haltArrived = function () { const b = this.haltS; orig(); if (!inFire && this.haltS >= 0 && b < 0) atEnd = true; };
        m.on('t-irq', () => m.setLine('test-irq', 'irq', true));
        m.on('t-halt', (on) => m.setLine('test', 'halt', on));
        const t0 = m.cycle + 40;
        m.schedule(t0, 't-irq');
        m.schedule(t0 + off, 't-halt', true);
        m.schedule(t0 + off + 300, 't-halt', false);
        let x = 0x811C9DC5;
        m.cpu.trace = (c) => { for (const r of REGS) x = fnv(x, c[r]); x = fnv(x, c.totalCycles); };
        m.runCycles(t0 + 1200);
        m.cpu.trace = null;
        if (atEnd) found++;
        rows.push(`${fast ? 'f' : 's'}${off}:${x.toString(16)}:${m.cpu.totalCycles}:${atEnd ? 1 : 0}`);
      }
    }
    out.irqEntry = { found, traces: sha(rows.join(' ')), rows: rows.length };
  }
  return out;
}

module.exports = { scenario };
