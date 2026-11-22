// Run: node tests/debugger-catchup.test.js
//
// Frame bookkeeping after a long debugger command. Over, Out, Run to and Step run outside the frame loop; the
// machine's frames must still follow its time, so that Run afterwards carries on as if the machine had never been
// stopped. The oracle is a free run of the same program on a second machine:
//  * after an Over that runs ~90 frames of machine time, the open frame's end is ahead of the machine's tick, and
//    the very next frame of the frame loop executes instructions (before the fix it closed ~90 empty frames first);
//  * a machine stopped before a long JSR, stepped over it and run on gives exactly the free run's instruction
//    trace (PC, registers and tick of every instruction) and exactly its frames (tick at which each frame closes,
//    frame count, the rendered picture and the frame's sound events), from boot to the end, Over included;
//  * the same for many single steps across frame ends, and for Out (run to return);
// on a SAM machine (Dragon 64), the CoCo 3 and the MC-10 (6803, whose runFrame also stops the tape motor).
const crypto = require('crypto');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// The program: the main loop changes the screen (so frames differ), then calls LONG, a delay of about 330,000
// instructions (some 90 frames of machine time), then changes the screen again.
const SRC = {
  '6809': (scr) => `
START   INC     $${scr.toString(16)}
        JSR     LONG
AFTER   INC     $${(scr + 1).toString(16)}
        BRA     START
LONG    LDB     #20
L1      LDX     #$2000
L2      LEAX    -1,X
        BNE     L2
        DECB
        BNE     L1
INNER   RTS
`,
  '6803': (scr) => `
START   INC     $${scr.toString(16)}
        JSR     LONG
AFTER   INC     $${(scr + 1).toString(16)}
        BRA     START
LONG    LDAB    #20
L1      LDX     #$2000
L2      DEX
        BNE     L2
        DECB
        BNE     L1
INNER   RTS
`,
};
const MODELS = [
  { id: 'dragon64', cpu: '6809', scr: 0x400, org: 0x3000 },
  { id: 'coco3', cpu: '6809', scr: 0x400, org: 0x3000 },
  { id: 'mc10', cpu: '6803', scr: 0x4000, org: 0x4400 },   // the MC-10's 4K of RAM: $4000-$4FFF
];

const build = (cpu, scr, org) => {
  const r = Emu.assemble(` ORG $${org.toString(16)}\n` + SRC[cpu](scr), cpu);
  if (!r.ok) throw new Error('test firmware does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
// the picture: its colour codes and the colour table they index
const sha = (f) => crypto.createHash('sha1').update(f.data).update(new Uint8Array(f.table.buffer)).digest('hex');

// A machine with the program loaded and running, every instruction and every closed frame recorded. The
// instructions go into a running hash (two 32-bit lanes over PC, registers and tick: a million instructions as
// strings would not fit in memory); each closed frame records the count and hash so far, so the first frame whose
// record differs says where two runs part.
const recorded = (model, r) => {
  const m = Emu.createMachine(model.id);
  m.injectAndRun(r.segments, r.exec);
  const t = { m, count: 0, h1: 0x811C9DC5, h2: 0x01000193, frames: [] };
  const mix = (v) => { t.h1 = Math.imul(t.h1 ^ v, 0x01000193) >>> 0; t.h2 = (Math.imul(t.h2 + v, 0x9E3779B1) ^ (t.h2 >>> 15)) >>> 0; };
  m.cpu.trace = (c) => { t.count++; mix(c.pc); mix(c.a); mix(c.b); mix(c.x); mix(c.cc); mix(c.s); mix(m.cycle | 0); mix(Math.floor(m.cycle / 2 ** 32)); };
  const orig = m.runFrame;
  // every frame the machine closes, whoever closes it (the frame loop, or the debugger as it runs)
  m.runFrame = function (...args) {
    const ok = orig.apply(this, args);
    if (ok) t.frames.push(`${this.frameCount} ${this.frameBase} ins ${t.count} ${t.h1.toString(16)}${t.h2.toString(16)} pic ${sha(this.render())} snd ${this.audioEvents.join(',')}`);
    return ok;
  };
  return t;
};
const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `#${i}: ${a[i]} / ${b[i]}`; return 'none'; };

for (const model of MODELS) {
  const r = build(model.cpu, model.scr, model.org);
  const sym = (s) => r.symbols.get(s);
  const FRAMES = 300;

  // the oracle: a free run of FRAMES frames
  const free = recorded(model, r);
  while (free.m.frameCount < FRAMES) free.m.runFrame();

  // ---- 1. Over a long JSR, then Run: the next frame runs instructions ----
  {
    const t = recorded(model, r);
    const d = new Emu.Debugger(t.m);
    d.runUntil(sym('START') + 3);   // stopped at the JSR (INC extended is 3 bytes on both CPUs)
    check(`${model.id}: stopped at the JSR`, t.m.cpu.pc === sym('START') + 3 && d.stopped, t.m.cpu.pc.toString(16));
    const c0 = t.m.cycle;
    d.stepOver();
    const ran = t.m.cycle - c0;
    check(`${model.id}: Over ran the long call back to AFTER (${(ran / t.m.frameCycles).toFixed(1)} frames of machine time)`,
      t.m.cpu.pc === sym('AFTER') && d.stopReason.kind === 'until' && ran > 60 * t.m.frameCycles, `${t.m.cpu.pc.toString(16)} ${ran}`);
    const end = t.m.frameBase + t.m.frameCycles;
    check(`${model.id}: after the Over the open frame ends ahead of the machine's tick (bookkeeping followed it)`,
      t.m.frameOpen && t.m.cycle < end && t.m.cycle >= t.m.frameBase, `cycle ${t.m.cycle} frameBase ${t.m.frameBase} end ${end}`);
    d.resume();
    const n0 = t.count, f0 = t.m.frameCount;
    t.m.runFrame();
    check(`${model.id}: the first frame after Run executes instructions`, t.count > n0 && t.m.frameCount === f0 + 1, `${t.count - n0} instructions`);
    while (t.m.frameCount < FRAMES) t.m.runFrame();
    check(`${model.id}: stopped, stepped over the long call and resumed: every instruction (PC, registers, tick) and every frame (closing tick, picture, sound) as in the free run, the frames inside the Over included`,
      t.frames.length === free.frames.length && firstDiff(t.frames, free.frames) === 'none', `${t.frames.length} frames, ${t.count} instructions / ${free.frames.length}, ${free.count} ${firstDiff(t.frames, free.frames)}`);
  }

  // ---- 1b. the frame loop with a breakpoint set runs frames through the debugger, which stops at it (the MC-10's
  // own runFrame once dropped the debugger's run and ran the frame free) ----
  {
    const t = recorded(model, r);
    const d = new Emu.Debugger(t.m);
    d.addBreakpoint(sym('AFTER'));
    let frames = 0;
    while (frames < 200 && d.runFrame() !== false) frames++;
    check(`${model.id}: an armed frame loop stops at the breakpoint, before the instruction there`,
      d.stopped && d.stopReason.kind === 'breakpoint' && t.m.cpu.pc === sym('AFTER') && frames > 60, `${frames} frames, pc ${t.m.cpu.pc.toString(16)}`);
  }

  // ---- 2. Out (run to return) from inside the long call, and single steps across frame ends ----
  {
    const t = recorded(model, r);
    const d = new Emu.Debugger(t.m);
    d.runUntil(sym('L2'));
    // ~6 frames of machine time, one instruction at a time, by Step and by Run limited to one instruction (each
    // returns at once: after the instruction that reaches a frame's end, that frame is closed before it returns)
    let behind = 0, f0 = t.m.frameCount;
    for (let i = 0; i < 20000; i++) {
      if (i & 1) d.run(1); else d.step();
      if (!t.m.frameOpen || t.m.cycle >= t.m.frameBase + t.m.frameCycles) behind++;
    }
    check(`${model.id}: 20,000 single steps (Step and Run 1) cross ${t.m.frameCount - f0} frame ends and leave the open frame ahead of the tick after every one`,
      behind === 0 && t.m.frameCount - f0 > 3, `${behind} steps left it behind`);
    d.runToReturn();
    check(`${model.id}: Out returns to AFTER with the open frame ahead of the tick`,
      t.m.cpu.pc === sym('AFTER') && t.m.cycle < t.m.frameBase + t.m.frameCycles, `${t.m.cpu.pc.toString(16)} ${t.m.cycle} ${t.m.frameBase}`);
    d.resume();
    while (t.m.frameCount < FRAMES) t.m.runFrame();
    check(`${model.id}: steps, Out and Run give the free run's instructions and frames`,
      t.frames.length === free.frames.length && firstDiff(t.frames, free.frames) === 'none', firstDiff(t.frames, free.frames));
  }
}

// ---- 3. through the Session: Over, then Run, and the next frame runs the guest ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const r = build('6809', 0x400, 0x3000);
  s.runAssembled(r);
  s.runFrames(3);
  const d = s.debug;
  d.runUntil(r.symbols.get('START') + 3);
  d.stepOver();
  check('session: Over leaves the debugger stopped at AFTER', s.paused && d.pc === r.symbols.get('AFTER'));
  s.resume();
  const m = s.shownMachine, t0 = m.cpu.totalCycles, end = m.frameBase + m.frameCycles;
  // the Over stopped part way through a frame: the first frame after Run runs the guest to that frame's end
  check('session: Run, and the first frame runs the guest to the open frame\'s end', s.runFrames(1) === 1 && m.cpu.totalCycles > t0 && m.cycle >= end && m.frameBase === end,
    `${m.cpu.totalCycles - t0} cycles in the frame, cycle ${m.cycle}, end ${end}`);
}

console.log(`\n${n - fail}/${n} checks passed`);
if (fail) process.exitCode = 1;
