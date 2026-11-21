// Fast regression gate (seconds, no MAME needed): runs each family's diagnostic firmware - the same
// firmware the MAME comparisons use - and hashes the full instruction trace (registers and cycle
// counts) and every rendered frame of the video firmware, against values recorded in
// tests/regress-hashes.json.
//
//   node tests/regress.test.js            check
//   node tests/regress.test.js --update   record new values (only after the MAME comparisons pass:
//                                         node tools/mame-diff/run.js <profile> [--video])
//   node tests/regress.test.js --shard 2/4
//                                         run only shard 2 of 4 (the cases are independent, so several
//                                         processes can run the gate in parallel); tests/all.js does this
//                                         for you on a multi-core machine.
//   node tests/regress.test.js --count    print the number of cases, run none
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { recordText } = require('./regress-record.js');
const { assignShards } = require('./regress-shards.js');

const FILE = path.join(__dirname, 'regress-hashes.json');
const UPDATE = process.argv.includes('--update');
const spec = (family) => require(path.join(__dirname, '../tools/mame-diff', family, 'spec.js'));

// FNV-1a over 32-bit words
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };

function traceHash(t) {
  const m = t.machine();
  const names = t.regs.map((r) => r.name);
  let h = 0x811C9DC5, n = 0, c0 = null, halted = false;
  m.cpu.trace = (c) => {
    if (c0 === null) c0 = c.totalCycles;
    for (const r of names) h = fnv(h, c[r]);
    h = fnv(h, c.totalCycles - c0);
    if (c.pc === t.haltPc) halted = true;
    n++;
  };
  for (let f = 0; f < 5000 && n < t.instructions; f++) m.runFrame();
  return { hash: h.toString(16).padStart(8, '0'), instructions: n, halted };
}
function videoHash(v) {
  const m = v.machine();
  let h = 0x811C9DC5;
  for (let f = 0; f < v.frames; f++) {
    m.runFrame();
    const px = Emu.frameToRGBA(m.render());
    for (let i = 0; i < px.length; i++) h = fnv(h, px[i]);
  }
  return { hash: h.toString(16).padStart(8, '0'), frames: v.frames };
}

// the printer firmware (run.js <profile> --printer): the trace to the end and every byte the printer received
function printerHash(t) {
  const m = t.machine();
  const names = t.regs.map((r) => r.name);
  let h = 0x811C9DC5, c0 = null, halted = false;
  m.cpu.trace = (c) => {
    if (c0 === null) c0 = c.totalCycles;
    for (const r of names) h = fnv(h, c[r]);
    h = fnv(h, c.totalCycles - c0);
    if (c.pc === t.haltPc) { halted = true; m.cpu.trace = null; }
  };
  let after = -1;
  for (let f = 0; f < 3600 && after !== 0; f++) {
    m.runFrame();
    if (after < 0 && m.read(t.doneAddr) === 0xFF) after = 30;
    else if (after > 0) after--;
  }
  for (const b of m.printed) h = fnv(h, b);
  return { hash: h.toString(16).padStart(8, '0'), printed: m.printed.length, halted };
}
// the Reset button (reset.asm; run.js <profile> --reset): the trace through two presses with RAM kept, each made
// `pressAfter` frames after the firmware reaches SYNC (MAME presses at its own frame end; when, is outside the
// machine and nothing after it depends on it)
function resetHash(t) {
  const m = t.machine();
  const names = t.regs.map((r) => r.name);
  let h = 0x811C9DC5, n = 0, c0 = null, halted = false, seen = 0, wait = -1, presses = 0;
  m.cpu.trace = (c) => {
    if (c0 === null) c0 = c.totalCycles;
    for (const r of names) h = fnv(h, c[r]);
    h = fnv(h, c.totalCycles - c0);
    n++;
    if (c.pc === t.haltPc) { halted = true; m.cpu.trace = null; }
  };
  for (let f = 0; f < 600 && !halted; f++) {
    m.runFrame();
    const p = m.peek(t.phaseAddr);
    if (p > seen) { seen = p; wait = t.pressAfter; }
    if (wait > 0) wait--; else if (wait === 0) { wait = -1; m.reset(false); presses++; }
  }
  return { hash: h.toString(16).padStart(8, '0'), instructions: n, presses, halted };
}
// the sound a machine makes: every level change (frame offset and level, to 1e-9), frame by frame
function soundHash(v) {
  const m = v.machine();
  let h = 0x811C9DC5, events = 0;
  for (let f = 0; f < v.frames; f++) {
    m.runFrame();
    for (let i = 0; i < m.audioEvents.length; i += 2) { h = fnv(h, m.audioEvents[i]); h = fnv(h, Math.round(m.audioEvents[i + 1] * 1e9)); events++; }
  }
  return { hash: h.toString(16).padStart(8, '0'), frames: v.frames, events };
}

const cases = [];
for (const id of ['dragon32', 'dragon64', 'dragon200', 'tanodr64', 'coco', 'coco2b', 'mx1600', 'lzcolor64', 'cd6809']) {
  cases.push([`trace ${id}`, () => traceHash(spec('sam').trace(id, { regenerate: false }))]);
}
// More models, verified against MAME: the Dragon 200-E, the Prologica CP 400, the CoCo 1/2's 4K/16K/32K
// RAM options and the 4K mid-line sweep (all reviewed on 0.264: run.js <profile> [--video], plus --ram N)
for (const id of ['dragon200e', 'cp400']) {
  cases.push([`trace ${id}`, () => traceHash(spec('sam').trace(id, { regenerate: false }))]);
  cases.push([`video ${id}`, () => videoHash(spec('sam').video(id))]);
}
for (const ram of [4, 16, 32]) cases.push([`trace coco ${ram}K`, () => traceHash(spec('sam').trace('coco', { regenerate: false, config: { ram } }))]);
cases.push(['raster coco 4K', () => videoHash({ machine: spec('sam').raster('coco', { regenerate: false, config: { ram: 4 } }).machine, frames: 180 })]);
// PIA1 port B's input pins (pia1b.asm; run.js <profile> --pia1b)
for (const id of ['coco', 'coco2b', 'cp400', 'dragon32', 'dragon64']) cases.push([`trace ${id} pia1b.asm`, () => traceHash(spec('sam').pia1b(id))]);
// the RAM-size input (PB2) follows the fitted RAM: 16K reads it high, 32K and 64K from PIA0 PB6
for (const ram of [4, 16, 32]) cases.push([`trace coco ${ram}K pia1b.asm`, () => traceHash(spec('sam').pia1b('coco', { config: { ram } }))]);
cases.push(['trace coco3 pia1b.asm', () => traceHash(spec('coco3').pia1b('coco3'))]);
cases.push(['trace dgnalpha pia1b.asm', () => traceHash(spec('alpha').pia1b('dgnalpha'))]);
// The Reset button: what the CPU and the PIAs keep over a reset, RAM kept, BASIC's warm-start vector taken and
// refused (reset.asm; MAME agrees instruction for instruction: run.js <profile> --reset [--cpu 6309] on 0.264)
for (const id of ['dragon64', 'tanodr64', 'coco']) cases.push([`trace ${id} reset.asm`, () => resetHash(spec('sam').reset(id))]);
// the same on the HD6309 (run.js <dragon64|tanodr64> --reset --cpu 6309: dragon64h and tanodr64h)
cases.push(['trace dragon64 reset.asm 6309', () => resetHash(spec('sam').reset('dragon64', { config: { cpu: '6309' } }))]);
// The floating bus, $FF60-$FFBF with no cartridge fitted (floating.asm; run.js <profile> --floating). It reads
// the window in every indexed form and in extended mode, so the trace holds what each rule returned on every
// machine: MAME agrees instruction for instruction (run.js <profile> --floating, all five
// profiles on the 0.264 reference, which is why these hashes may be recorded).
for (const id of ['dragon32', 'dragon64', 'dragon200', 'tanodr64', 'coco']) cases.push([`trace ${id} floating.asm`, () => traceHash(spec('sam').floating(id))]);
for (const ram of [512, 128]) cases.push([`trace coco3 ${ram}K`, () => traceHash(spec('coco3').trace('coco3', { regenerate: false, config: { ram } }))]);
for (const id of ['mc10', 'alice']) cases.push([`trace ${id}`, () => traceHash(spec('mc10').trace(id, { regenerate: false }))]);
// the HD6309 sweep (6309/sweep.asm, generated): every 6309-only instruction in every addressing mode, both
// emulation and native, the four TFM variants, and traps, on the 16K window (dragon64h) and the CoCo 3's
// 32K one (coco3h). The machine is built with config.mameCompat, which encodes MAME 0.289 -- the version the
// cycle table is measured against -- so these hashes are recorded only after run.js <profile> --cpu 6309
// passes on 0.289, not on the 0.264 reference the other entries use.
for (const id of ['dragon64', 'coco3']) cases.push([`trace ${id} 6309`, () => traceHash(spec('6309').trace(id, { regenerate: false }))]);
// Dragon 64 Plus, identical with MAME 0.264 to HALT: the Dragon 64's diag on the d64plus (run.js d64plus)
// and the 80-column board firmware (plus.asm, run.js d64plus --plus). Both run under config.mameCompat, where the
// $FFE2 bank register does not reach memory, as in 0.264; the hardware behaviour (Compusense's technical notes)
// is tested in tests/d64plus.test.js.
cases.push(['trace d64plus', () => traceHash(spec('d64plus').trace('d64plus', { regenerate: false }))]);
cases.push(['trace d64plus plus.asm', () => traceHash(spec('d64plus').plus('d64plus'))]);
// the 80-column text screens of the screen-text reader (plustext.asm, run.js d64plus --plustext; its pictures with
// --plustext --video), also under mameCompat; the reader itself is tested in tests/d64plus-screen-text.test.js
cases.push(['trace d64plus plustext.asm', () => traceHash(spec('d64plus').plusText('d64plus', { regenerate: false }))]);
for (const id of ['dragon64', 'coco', 'coco2b']) cases.push([`video ${id}`, () => videoHash(spec('sam').video(id))]);
// SAM CPU rate: MAME-verified with config.mameCompat (run.js --rate / --ops), XRoar-verified without it
// (sam/run-xroar.js); fast-rate video without it (sam/run-fastvid.js, data sheet model)
for (const id of ['dragon64', 'coco']) {
  for (const file of ['rate.asm', 'ops.asm']) {
    cases.push([`trace ${id} ${file}`, () => traceHash(spec('sam').rate(id, { file }))]);
    cases.push([`trace ${id} ${file} hardware`, () => traceHash(spec('sam').rate(id, { file, config: { mameCompat: false } }))]);
  }
  cases.push([`video ${id} fastvid.asm hardware`, () => videoHash({ machine: () => spec('sam').rate(id, { file: 'fastvid.asm' }).machine({ mameCompat: false }), frames: 100 })]);
}
// mid-line video changes swept across every beam position (raster.asm), compared with MAME pixel by pixel
// by run.js <profile> --raster: every frame to the firmware's end, with MAME's timing (mameCompat)
// (the 200-E runs its character-generator variant, raster-chargen.asm)
for (const [id, family, frames] of [['coco', 'sam', 200], ['coco2b', 'sam', 200], ['dragon64', 'sam', 200], ['dragon200e', 'sam', 200], ['mc10', 'mc10', 135], ['coco3', 'coco3', 110]]) {
  cases.push([`raster ${id}`, () => videoHash({ machine: spec(family).raster(id, { regenerate: false }).machine, frames })]);
}
// the SAM display-counter probe at V 0 and V 1 (sam/samv.asm; sam/run-samv.js compares it with MAME)
for (const id of ['dragon64', 'dragon200e']) cases.push([`samv ${id}`, () => videoHash(spec('sam').samv(id))]);
// floppy disk controllers: the fdc/ firmware as the DOS ROM, four drives (run.js <profile> --fdc [controller])
for (const id of ['dragon64', 'coco', 'coco3']) cases.push([`trace ${id} fdc`, () => traceHash(spec('fdc').trace(id, { regenerate: false }))]);
// when the 6809 starts taking NMI: before S is loaded, EXG with S, TFR r,S (fdc/nmi.asm, run.js dragon64 --fdc --nmi)
cases.push(['trace dragon64 dragonfdc nmi', () => traceHash(spec('fdc').trace('dragon64', { nmi: true }))]);
// the same firmware on the HD6309 (run.js dragon64 --fdc --nmi --cpu 6309): the arming rule differs, so this is a
// different trace, not a duplicate of the case above
cases.push(['trace dragon64 dragonfdc nmi 6309', () => traceHash(spec('fdc').trace('dragon64', { nmi: true, cpu: '6309' }))]);
// the controller's HALT and NMI during halted sector reads at the CoCo 3's two CPU rates (fdc/coco-halt.asm, run.js
// coco3 --fdc cocofdc --halt): the read loops of NitrOS-9's floppy booter, Disk BASIC's style and a polled first byte
cases.push(['trace coco3 cocofdc halt', () => traceHash(spec('fdc').trace('coco3', { halt: true }))]);
// a halted read on a drive with no disk (fdc/coco-halt-empty.asm, run.js coco3 --fdc cocofdc --halt --empty): the
// CPU held inside EMPTY's LDA for good while the frames go on (4 s, as MAME runs it), the instruction suspended
cases.push(['trace coco3 cocofdc halt empty', () => {
  const t = spec('fdc').trace('coco3', { halt: true, empty: true });
  const m = t.machine();
  const names = t.regs.map((r) => r.name);
  let h = 0x811C9DC5, n = 0, c0 = null, last = -1;
  m.cpu.trace = (c) => {
    if (c0 === null) c0 = c.totalCycles;
    for (const r of names) h = fnv(h, c[r]);
    h = fnv(h, c.totalCycles - c0);
    last = c.pc;
    n++;
  };
  while (m.cycle < t.seconds * m.tickHz) m.runFrame();
  m.cpu.trace = null;
  return { hash: h.toString(16).padStart(8, '0'), instructions: n, held: last === t.stuck.pc && m.cpu.haltLine && m.haltDefer !== null && m.cpu.pc === t.stuck.pc };
}]);
// the page's NitrOS-9 floppy loader (js/machines/nitros9.js) reading a hand-built boot track, on both CPUs (run.js
// coco3 --fdc cocofdc --nitros9 [--cpu 6309])
for (const cpu of ['6809', '6309']) cases.push([`trace coco3 cocofdc nitros9${cpu === '6309' ? ' 6309' : ''}`, () => traceHash(spec('fdc').trace('coco3', { nitros9: true, cpu }))]);
cases.push(['trace dragon64 premierfdc', () => traceHash(spec('fdc').trace('dragon64', { controller: 'premierfdc', regenerate: false }))]);
// the same controllers in a Multi-Pak's slot 4 (<board>-multi.asm, run.js <profile> --fdc [controller] --multi)
for (const [id, controller] of [['dragon64', 'dragonfdc'], ['dragon64', 'premierfdc'], ['coco', 'cocofdc']]) {
  cases.push([`trace ${id} ${controller} multi`, () => traceHash(spec('fdc').trace(id, { controller, regenerate: false, multi: true }))]);
}
// a blank disk (js/media/disk.js blankDisk) formatted by <board>-format-<T>x<H>.asm (run.js --fdc <c> --blank ...)
for (const [id, controller, format, tracks] of [['dragon64', 'dragonfdc', 'vdk', 40], ['coco', 'cocofdc', 'jvc', 35]]) {
  cases.push([`trace ${id} ${controller} blank ${format} ${tracks}x1`, () => traceHash(spec('fdc').trace(id, { controller, regenerate: false, blank: { format, tracks, heads: 1 } }))]);
}
// the disk mounting tests' short firmware (<board>-write.asm, run.js <profile> --fdc [controller] --write)
for (const [id, controller] of [['dragon64', 'dragonfdc'], ['dragon64', 'premierfdc'], ['coco', 'cocofdc'], ['dgnalpha', 'alphafdc']]) {
  cases.push([`trace ${id} ${controller} write`, () => traceHash(spec('fdc').trace(id, { controller, regenerate: false, write: true }))]);
}
cases.push(['trace coco multifdc', () => traceHash(spec('fdc').trace('coco', { controller: 'multifdc', regenerate: false }))]);   // the CoCo FDC in Multi-Pak slot 4
// a NitrOS-9/OS-9 dump on drive 0 (run.js coco --fdc cocofdc-os9 --images): the OS-9 geometry from LSN 0, OS-9's
// own interleave and gaps, and a headerless save. Its own key, so a change to the OS-9 path moves this and nothing else
cases.push(['trace coco cocofdc-os9', () => traceHash(spec('fdc').trace('coco', { controller: 'cocofdc-os9', regenerate: false }))]);
// Dragon Professional (Alpha): the SAM diagnostic through our boot pager (run.js dgnalpha), the VDG modes
// (--video), the Alpha's own hardware (--board), its disk interface (--fdc alphafdc) and its sound (--sound,
// against MAME's -wavwrite within the tolerances in alpha/sound-compare.js)
cases.push(['trace dgnalpha', () => traceHash(spec('alpha').trace('dgnalpha', { regenerate: false }))]);
cases.push(['video dgnalpha', () => videoHash(spec('alpha').video('dgnalpha'))]);
cases.push(['trace dgnalpha board', () => traceHash(spec('alpha').board('dgnalpha'))]);
cases.push(['trace dgnalpha alphafdc', () => traceHash(spec('fdc').trace('dgnalpha', { controller: 'alphafdc', regenerate: false }))]);
cases.push(['sound dgnalpha', () => soundHash({ machine: spec('alpha').sound('dgnalpha').machine, frames: 240 })]);
// cartridges: the cart/ firmware as the cartridge ROM (run.js coco --cart <setup> [--audio])
// on the CoCo, the CoCo 3 and the Dragon 64 (run.js coco3 / dragon64 / dragon32 --cart; the Dragons have no banked board)
for (const id of ['coco', 'coco3', 'dragon64']) {
  for (const setup of ['banked', 'bankedshort', 'gmc', 'orch90', 'multi']) {
    if (spec('cart').SETUPS[setup].profiles.includes(id)) cases.push([`trace ${id} cart ${setup}`, () => traceHash(spec('cart').trace(id, { setup }))]);
  }
  for (const [setup, frames] of [['gmc', 360], ['orch90', 240], ['multi', 120]]) cases.push([`sound ${id} cart ${setup}`, () => soundHash({ machine: spec('cart').trace(id, { setup }).machine, frames })]);
}
cases.push(['trace dragon32 cart multi', () => traceHash(spec('cart').trace('dragon32', { setup: 'multi' }))]);
// Speech/Sound Pak (case c): the PIC enables INT3 ($30) and the 6809's wait is unbounded, so every
// command is serviced through the ISR. The oracle is the OUTCOME, not an instruction lockstep
// (tools/mame-diff/ssc/compare.js: the two CPUs genuinely overlap, so the poll counts differ by construction
// while the ordered device-write sequence and the final work RAM do not).
// The gate itself runs our emulator only, so it records our side in the same form as every other case - the
// full instruction trace's registers and cycle counts - and adds the final work RAM ($0400-$0405) and the
// ordered device-write sequence, so any change to what the card does to its chips shows up here.
//
// WHY THIS KEY MOVED ONCE, and why that was intended (AGENTS 4.2). The CoCo 3 case's trace hash changed with the
// fix that made ioTime() answer now() between instructions (it had used the last step's cycle count). The access
// whose timing moves is the SSC card's own clock, not the 6809's status read: runCycles calls processEventsMame
// BEFORE cpu.step() (js/machines/coco3.js), the card's attoclock timer fires there, and catchUp() asks the host
// what time it is - so inStep is rightly false and no instruction is running. Measured at that frame around the
// divergence: pc $A053 (the instruction not yet executed), cycle 331,884, cpu.cycleCount 2 (the PREVIOUS step's
// length), so the old code answered 331,891 - 7 ticks ahead - and now answers 331,884. (The other such frame
// measured is cycle 307,408 with cycleCount 8: 31 ticks ahead before.) Because the card is caught up to the
// machine's real time instead of a time ahead of it, the busy bit is sampled at a different moment and one poll
// pass is added: the 3 instructions $A082/$A085/$A087 at step 20,197, giving 24,301 instructions instead of
// 24,298.
// The 6809's own read of $FF7E is IN STEP and unchanged: watching the bus, that read happens at step 20,198 with
// inStep true, and the fix leaves every in-step answer alone - the first 12,859 in-step ioTime() answers of the
// two runs are identical element for element, and the first that differs is the poll iteration at step 20,197
// itself, downstream of the between-step card timer.
// Checked against MAME 0.264 (compare.js, and run.js --ssc, on both trees): the device-write rows are 107 of 107
// identical, the lockstep run is 1,157,487 instructions with HALT at 213,485 on both, and the outcome comparison
// differs in exactly the documented way and nowhere else ($0405 = $DF on MAME, $FF here). The MAME verdict did
// not change; only our instruction count did, in the direction the fix describes (the card had been run ahead of
// the machine between instructions).
// WHICH KEYS ARE MAME-BACKED, and the answer differs by model, so it is stated per model rather than for the case:
//   coco   - compare.js on 0.264: 107 of 107 device-write rows identical, work RAM identical, HALT both sides.
//   coco2b - the same, verified for this model: 107 of 107 identical, work RAM identical.
//            BUT the work-RAM part is not coverage of the sound-activity bit (below): those two models match
//            because the firmware's fixed read lands outside a window we do not model. Only the device-write
//            sequence is genuine coverage.
//   coco3  - the device-write sequence still matches 37 commands / 107 rows, but the final work RAM does NOT:
//            MAME leaves $0405 = $DF and we leave $FF. Measured (read-only probes on 0.264): bit 5 of $FF7E, the
//            sound-activity circuit, dips low for a while after an allophone load on EVERY model; the firmware
//            reads it at a fixed 18.384 ms after that load on every model too; 18.4 ms falls inside the CoCo 3's
//            dip and outside the CoCo 1/2's and 2B's. This emulator stubs the circuit (soundActive is never set
//            true, js/machines/ssc.js:107), so we read the bit high everywhere. Why the dip sits at a different
//            offset on the CoCo 3 is NOT established. So this key is NOT claimed as MAME-verified. It is kept
//            because it is still a real diagnostic run of our own card (AGENTS 4.4.7) and because the gap it
//            records is the one the README calls out; when the SP0256's audio - and with it the SAC - is
//            implemented, re-run the comparison and replace this note with the result.
// The masked %>0C case (tests/ssc.test.js section 8) keeps its own coverage, time-outs included.
function sscInt3Hash(profileId = 'coco') {
  const { runInt3 } = require('../tools/mame-diff/ssc/outcome.js');
  // ONE run: the trace and the outcome are recorded from the same machine. Two runs would double the work and
  // would pin an outcome the trace did not come from.
  let h = 0x811C9DC5, n = 0, c0 = null;
  const r = runInt3({ profileId, onMachine: (m, t) => {
    const names = t.regs.map((x) => x.name);
    m.cpu.trace = (c) => {
      if (c0 === null) c0 = c.totalCycles;
      for (const k of names) h = fnv(h, c[k]);
      h = fnv(h, c.totalCycles - c0);
      n++;
    };
  } });
  // then the outcome, so the trace alone cannot stand for the card's behaviour. No time-out fold-in: this build
  // has no time-out path, so $0410 cannot vary and hashing it would add a constant, not coverage.
  for (const v of r.ram) h = fnv(h, v);
  for (const line of r.lines) for (let i = 0; i < line.length; i++) h = fnv(h, line.charCodeAt(i));
  // r.halted is the authoritative check (the PC is AT HALT when the run ends); the trace callback fires as each
  // instruction starts, so it never sees the HALT instruction, which is why it is not the flag used here.
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), instructions: n, halted: r.halted };
}
cases.push(['trace coco ssc int3', () => sscInt3Hash()]);
// The Pak on the other two models the page offers it on. Each is its own entry, so a change that moves one model's
// trace and not another's is visible instead of averaged away: coco2b differs from coco in the VDG and the keyboard
// matrix, and coco3 goes through the GIME, so its cartridge and sound paths are not the CoCo 1/2's.
// coco2b is MAME-backed (compare.js on 0.264: 107/107 rows, work RAM identical). coco3 is NOT, and its key says so
// in its name rather than leaving a reader to assume it: compare.js differs there at $0405 by bit 5, the
// sound-activity circuit, which this emulator stubs (see the block above). The key stays because it still pins our
// own card's behaviour on that model; it just does not claim MAME agrees with it.
cases.push(['trace coco2b ssc int3', () => sscInt3Hash('coco2b')]);
cases.push(['trace coco3 ssc int3 (our side; MAME differs at $0405)', () => sscInt3Hash('coco3')]);
// The Pak on the Dragon 64. Its masked case is MAME-backed like the CoCos' (`run.js dragon64 --ssc`: 1,156,994
// instructions identical, HALT reached); its interrupt case is too (`compare.js dragon64`: 107 of 107 write rows
// identical, work RAM identical, HALT on both sides).
//
// WHAT THESE TWO KEYS DO AND DO NOT COVER, measured. They cover the Pak's decode ($FF7D/$FF7E, the PIC driving the
// AY and the SP0256) on the Dragon's cartridge port, and they do not cover the Dragon's own glue, because the
// firmware never touches it. Measured by mutation: inverting PIA1 PB2's bank-select polarity, and forcing bank 1
// at all times, both leave BOTH of these keys unchanged. That is a coverage fact, not a defect - `trace dragon64`
// (sam/diag.asm, whose phase 4 reads BANKID at $BF00 with PB2 both ways) is the key that fails on the PB2 mutation,
// and it is the one that should. The same holds for the 6551 ACIA: `acia dragon64` covers it, and `ssc.asm` never
// writes $FF04-$FF07.
//
// The interrupt key is the same number as the CoCo's (df189e5b, 7,506 instructions) because that run's firmware is
// the same and touches no Dragon-specific I/O; the masked key differs from the CoCo's RECORDED hash (87ece521
// against 5023fa01) only because sscMaskedHash runs on to the end of the frame in which HALT is first seen, and a
// 49.97 Hz PAL frame folds in a different number of trailing HALT-loop passes than a 59.92 Hz NTSC one - fewer,
// measured: 197,020 - 195,913 = 1,107 trailing instructions on the Dragon against 198,844 - 195,913 = 2,931 on
// the CoCo. The trace TO HALT is identical on both models: same hash (7b896afc), 195,913 instructions, 708,037
// cycles. The keys are kept per model anyway, as on the CoCos, so a change that moves one model's run is visible
// in its own key rather than averaged away.
//
// What these keys do NOT gate: the OFFER. `spec.trace` builds the machine and the Pak directly, so removing the
// `ssc` option from js/machines/profiles.js leaves both Dragon keys green (measured). The gate for the offer is
// tests/ssc-board.test.js, whose `dragon64 offers it` check fails on that mutation.
cases.push(['trace dragon64 ssc int3', () => sscInt3Hash('dragon64')]);
// The MASKED case (the source as it ships: IOCNT0 = $0C, so INT3 stays masked and every command times out). Its
// 37 time-outs are pinned in tests/ssc.test.js, but the gate needs this run's full trace too: AGENTS 4.4.7 asks
// for every diagnostic firmware run to be in the fast gate, and a core that started taking a masked interrupt
// would move this hash even if the out-of-firmware count somehow stayed 37.
// One entry per model the page offers the Pak on, for the same reason the int3 case has one each. Each is backed
// by its own `run.js <profile> --ssc` identical to HALT on MAME 0.264 (README verification table).
function sscMaskedHash(profileId = 'coco') {
  const t = require('../tools/mame-diff/ssc/spec.js').trace(profileId, 'masked');
  const m = t.machine();
  const names = t.regs.map((x) => x.name);
  let h = 0x811C9DC5, n = 0, c0 = null, halted = false;
  m.cpu.trace = (c) => {
    if (c0 === null) c0 = c.totalCycles;
    for (const k of names) h = fnv(h, c[k]);
    h = fnv(h, c.totalCycles - c0);
    if (c.pc === t.haltPc) halted = true;
    n++;
  };
  for (let f = 0; f < 5000 && m.cpu.pc !== t.haltPc; f++) m.runFrame();
  m.cpu.trace = null;
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), instructions: n, halted };
}
for (const id of ['coco', 'coco2b', 'coco3', 'dragon64']) cases.push([`trace ${id} ssc masked`, () => sscMaskedHash(id)]);
// cassette: our writer and reader firmware, compared with MAME by outcome (tools/mame-diff/tape/run-tape.js:
// MAME's recording of the writer, and MAME reading our files with the reader). The 6809 pair
// (tape/csave.asm, cload.asm) on the Dragon, CoCo and CoCo 3; the 6803 pair (csave6803.asm, cload6803.asm) on
// the MC-10 and Alice.
const tapeSpec = require('../tools/mame-diff/tape/spec.js');
for (const id of ['dragon64', 'coco', 'coco3']) for (const file of ['csave.asm', 'cload.asm']) cases.push([`trace ${id} ${file}`, () => traceHash(tapeSpec.trace(id, file))]);
for (const id of ['mc10', 'alice']) for (const file of ['csave6803.asm', 'cload6803.asm']) cases.push([`trace ${id} ${file}`, () => traceHash(tapeSpec.trace(id, file))]);
// how a .CAS is played (tape/cloadm.asm reading the image with one-byte leaders; run-playback.js compares it with MAME)
for (const id of ['dragon64', 'coco']) cases.push([`trace ${id} cloadm.asm`, () => traceHash(tapeSpec.trace(id, 'cloadm.asm'))]);
cases.push(['video coco3', () => videoHash(spec('coco3').video('coco3'))]);
// the GIME text attributes, every byte, 32/40/64/80 columns, lines per row 0-6, blink off and on, exact
// (run.js coco3 --video --attr)
cases.push(['video coco3 attributes', () => videoHash(spec('coco3').video('coco3', { file: 'vdg-attr.asm' }))]);
// the CoCo 3's artifact colours (run.js coco3 --video --artifact 1 / 2, exact against MAME)
for (const a of [1, 2]) {
  cases.push([`video coco3 artifact ${a}`, () => { const v = spec('coco3').video('coco3'); return videoHash({ machine: () => { const m = v.machine(); m.setComposite(a); m.monitor = 'rgb'; return m; }, frames: v.frames }); }]);
}
// the composite monitor: MAME's measured colours, $FF98 BPI and MOCH, artifact colours from them (vdg-composite.asm;
// run.js coco3 --video --composite [--artifact N], exact against MAME at 0, 1 and 2)
for (const a of [0, 1, 2]) {
  cases.push([`video coco3 composite artifact ${a}`, () => { const v = spec('coco3').video('coco3', { file: 'vdg-composite.asm' }); return videoHash({ machine: () => { const m = v.machine(); m.gime.artifact = a; m.monitor = 'composite'; return m; }, frames: 2200 }); }]);
}
cases.push(['video mc10', () => videoHash(spec('mc10').video('mc10'))]);
for (const [id, family] of [['dragon64', 'sam'], ['coco', 'sam'], ['coco3', 'coco3'], ['mc10', 'mc10']]) {
  cases.push([`printer ${id}`, () => printerHash(spec(family).printer(id))]);
}
// the bit-banger serial port in loopback (run.js <profile> --serial)
for (const [id, family] of [['coco', 'sam'], ['coco3', 'coco3'], ['mc10', 'mc10']]) {
  cases.push([`serial ${id}`, () => traceHash(spec(family).serial(id))]);
}
// the Dragon 64's 6551 ACIA with a loopback plug (run.js dragon64 --serial)
cases.push(['acia dragon64', () => traceHash(spec('sam').serial('dragon64'))]);

// LIZA for the 6803: the scripted conversation on the MC-10 and the Alice, hashed the
// same way - every instruction's registers and cycle count, and every frame of the conversation. It has
// no MAME oracle: LIZA is application software, not hardware, so AGENTS' lockstep rule (4.4) does not
// apply to it, as it did not to the entries this replaces. The numbers are fixed so that any change to the
// assembler, the 6803 core, the stub console or the program itself shows up in this fast gate. The
// conversation is proved correct against the 6809 build in tests/liza6803.test.js.
// The build is one per machine (its title names the machine), so each entry loads ITS OWN .bin, the file
// the page fetches - not a fresh assembly - and the two hashes differ in the title and again in the
// profile's own timing.
// the end-of-conversation loop's address, the same in both machine builds (only the title differs)
const LIZA_DONE = Emu.assemble(fs.readFileSync(path.join(__dirname, '../examples/liza6803.asm'), 'utf8'), '6803',
  { include: (n) => { const p = path.join(__dirname, '../examples', n); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }, defines: { MC10: 1, ALICE: 0 } }).symbols.get('DONE');
function liza6803Hash(profileId) {
  const bin = new Uint8Array(fs.readFileSync(path.join(__dirname, `../examples/liza6803-${profileId}.bin`)));
  const d = Emu.formats.identify(`liza6803-${profileId}.bin`, bin);
  if (d.kind !== 'binary') throw new Error(`liza6803-${profileId}.bin is not a loadable binary`);
  const m = Emu.createMachine(profileId, { ram: 20 });
  m.injectAndRun(d.segments, d.exec);
  const names = ['pc', 'a', 'b', 'x', 's', 'cc'];
  let h = 0x811C9DC5, n = 0, halted = false;
  m.cpu.trace = (c) => { for (const k of names) h = fnv(h, c[k]); h = fnv(h, c.totalCycles); if (c.pc === LIZA_DONE) halted = true; n++; };
  const frame = () => { m.runFrame(); const px = Emu.frameToRGBA(m.render()); for (let i = 0; i < px.length; i++) h = fnv(h, px[i]); };
  for (let i = 0; i < 20; i++) frame();
  for (const line of ['Hello', 'I need a holiday', 'My boss says I work too much', 'i think you are a good listener', 'bye']) {
    for (const ch of (line + '\r').toUpperCase()) { m.stubKeys.push(ch.charCodeAt(0)); frame(); frame(); }
    for (let i = 0; i < 20; i++) frame();
  }
  m.cpu.trace = null;
  return { hash: h.toString(16).padStart(8, '0'), instructions: n, halted };
}
for (const id of ['mc10', 'alice']) cases.push([`liza6803 ${id}`, () => liza6803Hash(id)]);

// the 6803 welcome program on the MC-10 and the Alice: its screen after the draw (every
// raw cell of the 32x16 screen, so a changed subtitle, menu line or colour shows up) and the mailbox each
// key 1-4 posts. The program itself is not hardware, so this trace has no MAME oracle of its own: the screen
// is proved in tests/welcome6803.test.js against the VDG character set, and MAME verified the same bytes the
// page ships by lockstep (node tools/mame-diff/run.js <machine> --welcome: every instruction identical, to
// HALT) and by pixel comparison (tools/mame-diff/mc10/run-welcome-video.js: 0 of 49152 pixels differ). The
// two hashes differ: the subtitle names the machine. back: a returning visitor's menu ("WELCOME
// BACK" and option 5, "CARRY ON WITH LIZA", whose key 5 is posted too), verified the same way with --back. The two
// "back" hashes are equal: "WELCOME BACK" takes the subtitle's place, so nothing on the screen names the machine.
function welcome6803Hash(id, back = false) {
  const file = `welcome6803-${id}.bin`;
  const bin = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples', file)));
  const s = new Emu.Session();
  s.switchMachine(id);
  s.startWelcome(bin, back ? { greeting: 'back', carryOn: 'LIZA' } : {});
  const names = ['pc', 'a', 'b', 'x', 's', 'cc'];
  let h = 0x811C9DC5, n = 0;
  s.machine.cpu.trace = (c) => { for (const k of names) h = fnv(h, c[k]); h = fnv(h, c.totalCycles); n++; };
  const frame = () => s.advance(1000 / s.machine.fps + 0.01);
  for (let i = 0; i < 50; i++) frame();
  for (let i = 0; i < 512; i++) h = fnv(h, s.machine.ram[0x4000 + i]);    // the screen, cell by cell
  // each key posts into the mailbox; the Session clears it after the frame, so hash what the program wrote
  // by running a frame at a time and reading the mailbox the machine holds between them
  const mailbox = [];
  s.on((e) => { if (e.startsWith('welcome:')) mailbox.push(e); });
  for (const k of ['1', '2', '3', '4', '5']) { s.machine.stubKeys.push(k.charCodeAt(0)); frame(); frame(); }
  for (const e of mailbox) for (const c of e) h = fnv(h, c.charCodeAt(0));
  s.machine.cpu.trace = null;
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), instructions: n, events: mailbox.length };
}
for (const id of ['mc10', 'alice']) {
  cases.push([`welcome6803 ${id}`, () => welcome6803Hash(id)]);
  cases.push([`welcome6803 ${id} back`, () => welcome6803Hash(id, true)]);
}

// DriveWire on the Becker port (tools/mame-diff/drivewire/run-dw.js): dw.asm's trace to HALT, everything the server
// sent it, and the disks the server wrote
async function driveWireHash(id) {
  const dw = require('../tools/mame-diff/drivewire/spec.js');
  let h = 0x811C9DC5, n = 0, c0 = null;
  const r = await dw.runOurs(id, { onMachine: (m) => {
    m.cpu.trace = (c) => {
      if (c0 === null) c0 = c.totalCycles;
      for (const k of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc']) h = fnv(h, c[k]);
      h = fnv(h, c.totalCycles - c0);
      n++;
    };
  } });
  for (const v of r.log) h = fnv(h, v);
  for (const [name, bytes] of Object.entries(r.files)) { for (const c of name) h = fnv(h, c.charCodeAt(0)); for (const v of bytes) h = fnv(h, v); }
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), instructions: n, halted: r.done };
}
for (const id of ['coco', 'coco3']) cases.push([`drivewire ${id}`, () => driveWireHash(id)]);

// --shard i/n: run shard i (0-based) of n. The cases share no state -- each builds its own machine -- so the
// shard's results are the whole run's for the cases it covers. Each case is in exactly one shard, and the shards
// are about equal in cost (tests/regress-shards.js; tests/regress-shards.test.js checks the split). Running them
// all is the runner's business (tests/all.js decides the shard count), and a shard run on its own is a partial run
// by design.
// --count: print how many cases the gate has and run none (tests/all.js checks that its shards ran them all)
if (process.argv.includes('--count')) { console.log(`${cases.length} regression cases`); return; }
// A usage error: say what is wrong, set exitCode = 2 and record it. Each call is followed by a `return` here,
// because usage() only records the error -- without the return the code below it would run on with a missing or
// malformed argument. The top-level `return` after this block then stops the rest of the file (legal in a
// CommonJS module), so nothing runs and Node exits by itself, without calling process.exit.
let usageErr = null;
const usage = (msg) => { console.error(msg); process.exitCode = 2; usageErr = msg; };
const shard = (() => {
  const i = process.argv.indexOf('--shard');
  if (i < 0) return null;
  const m = /^(\d+)\/(\d+)$/.exec(process.argv[i + 1] || '');
  if (!m) { usage('--shard needs i/n, e.g. --shard 0/4'); return null; }
  const [idx, of] = [Number(m[1]), Number(m[2])];
  if (idx >= of || of < 1) { usage('--shard i/n needs 0 <= i < n'); return null; }
  // Recording new hashes from a shard would write the file with only this shard's cases, deleting every other
  // hash -- the opposite of what --update means. Refuse rather than produce a corrupted baseline.
  if (UPDATE) { usage('--update records every case, so it cannot be used with --shard; run --update without a shard'); return null; }
  return { idx, of };
})();
if (usageErr) return;   // a usage error: exitCode is 2, and the rest of the file must not run
const expected = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const split = shard && assignShards(cases.map(([name]) => name), expected, shard.of);
const mine = shard ? cases.filter(([name]) => split.get(name) === shard.idx) : cases;
const actual = {};
let fail = 0;
const t0 = Date.now();
(async () => {
  for (const [name, run] of mine) {
    const r = await run();
    actual[name] = r;
    if (r.halted === false) { fail++; console.log(`FAIL ${name}: firmware did not reach HALT`); continue; }
    const exp = expected[name];
    if (UPDATE) console.log(`rec  ${name}: ${r.hash}`);
    else if (!exp) { fail++; console.log(`FAIL ${name}: no recorded value (run with --update after the MAME comparison)`); }
    else if (exp.hash !== r.hash) { fail++; console.log(`FAIL ${name}: ${r.hash}, recorded ${exp.hash}`); }
    else console.log(`ok   ${name}`);
  }
  // Keep the file's existing order and append new cases (regress-record.js says why): a re-record then shows only
  // the entries whose values changed.
  if (UPDATE) fs.writeFileSync(FILE, recordText(fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null, actual));
  const n = mine.length;
  const label = shard ? `regression hashes, shard ${shard.idx}/${shard.of}` : 'regression hashes';
  console.log(`${n - fail}/${n} ${label} ${UPDATE ? 'recorded' : 'match'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  // A usage error already set exitCode = 2 and printed its message; the throw only exists to stop the run, so
  // it must not turn into Node's uncaught-error exit 1. Anything else is a real failure.
  if (process.exitCode === 2) return;
  console.log('FAIL', e.stack);
  process.exitCode = 1;
});
