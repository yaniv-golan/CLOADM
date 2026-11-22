// Run: node tools/profile-cost.js [frames]
//
// What profiling costs: the same frames run with no profile, with a 'cycles' profile and with a 'samples' one, on
// the Dragon 64, the CoCo 3 and the MC-10, best of five runs each. The workload is a loop over RAM that reads,
// adds and writes (many bus accesses an instruction, so the read and write taps are at their busiest). Wall-clock
// time, so it is printed, not checked: the budget is 2x (docs/automation.md, "Finding hot spots").
const Emu = require('../tests/load')();

const frames = Number(process.argv[2]) || 300;
const PROGRAMS = {
  6809: `        ORG $3000
START   ORCC #$50
        LDX #$3400
LOOP    LDA ,X
        ADDA #3
        STA ,X+
        CMPX #$3800
        BNE LOOP
        BRA START
        END START`,
  6803: `        ORG $4800
START   SEI
        LDX #$4A00
LOOP    LDAA 0,X
        ADDA #3
        STAA 0,X
        INX
        CPX #$4E00
        BNE LOOP
        BRA START
        END START`,
};
function time(id, mode) {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine(id, {}, { menu: false });
    s.runAssembled(Emu.assemble(PROGRAMS[s.machine.config.cpu === '6803' ? 6803 : 6809], s.machine.config.cpu === '6803' ? '6803' : '6809'));
    s.runFrames(5);
    const p = mode ? s.profile({ mode }) : null;
    const t = process.hrtime.bigint();
    s.runFrames(frames);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
    if (p) p.stop();
  }
  return best;
}
for (const id of ['dragon64', 'coco3', 'mc10']) {
  const base = time(id, null), cycles = time(id, 'cycles'), samples = time(id, 'samples');
  console.log(`${id.padEnd(9)} ${frames} frames: none ${base.toFixed(0)} ms, cycles ${cycles.toFixed(0)} ms (${(cycles / base).toFixed(2)}x), samples ${samples.toFixed(0)} ms (${(samples / base).toFixed(2)}x)`);
}
