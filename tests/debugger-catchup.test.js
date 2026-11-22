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
// instructions (some 100 frames of machine time) that reads the keyboard's rows (every column driven low) on every
// pass and shows them on the screen, then changes the screen again. Keys typed while LONG runs (the typist presses
// one per frame it closes) reach the registers and the screen, so a frame closed without its typist step shows.
const SRC = {
  '6809': (scr) => `
        CLR     $FF02
START   INC     $${scr.toString(16)}
        JSR     LONG
AFTER   INC     $${(scr + 1).toString(16)}
        BRA     START
LONG    LDB     #10
L1      LDX     #$2000
L2      LDA     $FF00
        STA     $${(scr + 2).toString(16)}
        LEAX    -1,X
        BNE     L2
        DECB
        BNE     L1
INNER   RTS
`,
  '6803': (scr) => `
        CLR     $02
START   INC     $${scr.toString(16)}
        JSR     LONG
AFTER   INC     $${(scr + 1).toString(16)}
        BRA     START
LONG    LDAB    #10
L1      LDX     #$2000
L2      LDAA    $BFFF
        STAA    $${(scr + 2).toString(16)}
        DEX
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
// record differs says where two runs part. type: text the typist types when the program first reaches the JSR
// (the same instruction on every run, whatever drives the machine there). state: start from this snapshot instead.
const recorded = (model, r, { type = null, state = null } = {}) => {
  const m = Emu.createMachine(model.id);
  if (state) m.loadState(Emu.state.fromJSON(state)); else m.injectAndRun(r.segments, r.exec);
  const t = { m, count: 0, h1: 0x811C9DC5, h2: 0x01000193, frames: [] };
  const mix = (v) => { t.h1 = Math.imul(t.h1 ^ v, 0x01000193) >>> 0; t.h2 = (Math.imul(t.h2 + v, 0x9E3779B1) ^ (t.h2 >>> 15)) >>> 0; };
  const jsr = r.symbols.get('START') + 3;
  m.cpu.trace = (c) => {
    if (type && c.pc === jsr) { m.typist.type(type); type = null; }
    t.count++; mix(c.pc); mix(c.a); mix(c.b); mix(c.x); mix(c.cc); mix(c.s); mix(m.cycle | 0); mix(Math.floor(m.cycle / 2 ** 32));
  };
  const orig = m.runFrame;
  // every frame the machine closes, whoever closes it (the frame loop, or the debugger as it runs)
  m.runFrame = function (...args) {
    const ok = orig.apply(this, args);
    if (ok) t.frames.push(`${this.frameCount} ${this.frameBase} ins ${t.count} ${t.h1.toString(16)}${t.h2.toString(16)} pic ${sha(this.render())} snd ${this.audioEvents.join(',')}`);
    return ok;
  };
  return t;
};
const TYPED = 'ABC';
// a program that toggles the single-bit sound output (the 6809 machines' PIA1 PB1, the MC-10's $BFFF bit 7) every
// few dozen cycles, so every frame has sound events
const SOUND = {
  '6809': `
        LDA     $FF23
        ANDA    #$FB
        STA     $FF23
        LDA     #$FE
        STA     $FF22
        LDA     $FF23
        ORA     #$04
        STA     $FF23
        CLRA
T       EORA    #$02
S       STA     $FF22
        LDB     #4
W       DECB
        BNE     W
        BRA     T
`,
  '6803': `
        CLRA
T       EORA    #$80
S       STAA    $BFFF
        LDAB    #4
W       DECB
        BNE     W
        BRA     T
`,
};
const buildSound = (model) => {
  const r = Emu.assemble(` ORG $${model.org.toString(16)}\n` + SOUND[model.cpu], model.cpu);
  if (!r.ok) throw new Error('sound firmware does not assemble: ' + JSON.stringify(r.errors));
  r.symbols.set('START', -100);   // (recorded() types at START+3: never reached here)
  return r;
};
const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `#${i}: ${a[i]} / ${b[i]}`; return 'none'; };

for (const model of MODELS) {
  const r = build(model.cpu, model.scr, model.org);
  const sym = (s) => r.symbols.get(s);
  const FRAMES = 300;

  // the oracle: a free run of FRAMES frames, with keys typed while the long call runs. The same run without them
  // differs, so the keys reach the program.
  const free = recorded(model, r, { type: TYPED });
  while (free.m.frameCount < FRAMES) free.m.runFrame();
  {
    const quiet = recorded(model, r);
    while (quiet.m.frameCount < FRAMES) quiet.m.runFrame();
    check(`${model.id}: the keys typed during the long call reach the program (a run without them differs)`, firstDiff(quiet.frames, free.frames) !== 'none');
  }

  // ---- 1. Over a long JSR, then Run: the next frame runs instructions ----
  {
    const t = recorded(model, r, { type: TYPED });
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
    check(`${model.id}: stopped, stepped over the long call (keys typed during it) and resumed: every instruction (PC, registers, tick) and every frame (closing tick, picture, sound) as in the free run, the frames inside the Over included`,
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
    const t = recorded(model, r, { type: TYPED });
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

  // ---- 4. a snapshot restored, then stepped, and frames and steps in turn (Pause between frames, Step, Run). A
  // restored machine, and one whose frame the frame loop closed, have no frame open: the first step opens one before
  // its instruction runs, as the frame loop would, so that instruction's sound is in the frame. The snapshot is taken
  // with the PC on the speaker write (S), so the first step after the restore writes the speaker; SOUND toggles the
  // speaker every 12 instructions, so later steps after a frame start on it too. ----
  {
    const snd = buildSound(model);
    const src = Emu.createMachine(model.id);
    src.injectAndRun(snd.segments, snd.exec);
    for (let i = 0; i < 5; i++) src.runFrame();
    new Emu.Debugger(src).runUntil(snd.symbols.get('S'));
    const state = Emu.state.toJSON(src.saveState());
    const END = src.frameCount + 60;
    const ref = recorded(model, snd, { state });
    while (ref.m.frameCount < END) ref.m.runFrame();
    const t = recorded(model, snd, { state });
    const d = new Emu.Debugger(t.m);
    let onSound = 0;
    for (let k = 0; t.m.frameCount < END; k++) {
      if (t.m.cpu.pc === snd.symbols.get('S')) onSound++;   // the first step after the frame writes the speaker
      for (let i = 0; i < 1 + (k % 7); i++) d.step();
      d.resume();
      t.m.runFrame();
    }
    const sounds = ref.frames.filter((f) => f.split(' snd ')[1].split(',').length > 20).length;
    check(`${model.id}: restored from a snapshot, then a few steps after every frame (${onSound} of them, the first included, starting on the speaker write): every instruction, picture and sound event as in a free run from the snapshot (${sounds} of ${ref.frames.length} frames full of sound)`,
      onSound > 0 && t.frames.length && sounds === ref.frames.length && t.frames.length === ref.frames.length && firstDiff(t.frames, ref.frames) === 'none', firstDiff(t.frames, ref.frames).slice(0, 300));
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
