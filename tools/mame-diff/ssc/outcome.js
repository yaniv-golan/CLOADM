// The Speech/Sound Pak's outcome comparison (case c): what the card's two output devices are
// told to do, in order.
//
// Why not an instruction lockstep. In this case the 6809's wait is unbounded and the PIC does answer, so the
// two CPUs genuinely overlap. MAME interleaves them on its scheduler (60 Hz quantum, and the $FF7E write's
// zero-delay synchronize can also cut the 6809's slice), so the number of poll reads between a command and its
// service differs between the emulators by construction, and an instruction-for-instruction comparison would
// fail for a reason that means nothing here.
//
// So the oracle is the outcome, which does not depend on the interleaving: the ordered sequence of SP0256
// allophone loads and AY-3-8913 address/data writes (value and order), the firmware's final work RAM, and that
// our run reaches HALT with no time-out. The sequence is recorded on our side through writes.js, which decodes
// the same port C rules MAME's coco_ssc.cpp uses, and pinned as a hash in tests/regress.test.js so a change to
// the card's behaviour cannot pass unnoticed.
//
// Both sides ARE compared: tools/mame-diff/ssc/compare.js runs the same firmware on MAME 0.264, taps the PIC's
// peripheral writes there, and checks the two sequences and the work RAM row for row. Measured: 107 of 107
// device-write rows identical, work RAM identical, HALT on both sides.
const path = require('path');
const Emu = require(path.join(__dirname, '../../..', 'tests/load.js'))();
const spec = require('./spec.js');
const { recordCardWrites, formatWrites } = require('./writes.js');

// run the INT3 case on our emulator to HALT, return the observed outcome. `onMachine` is handed the machine
// before it runs, so a caller that also wants the instruction trace (the regress gate) records that trace and
// this outcome from ONE run rather than two.
function runInt3({ profileId = 'coco', maxSteps = 4000000, onMachine = null } = {}) {
  const t = spec.trace(profileId, 'int3');
  const m = t.machine();
  const rec = recordCardWrites(m.cartPort);
  if (onMachine) onMachine(m, t);
  let steps = 0;
  while (m.cpu.pc !== t.haltPc && steps < maxSteps) { m.runCycles(m.cycle + 1e-9); steps++; }
  rec.uninstall();
  const lines = formatWrites(rec.log);
  return {
    halted: m.cpu.pc === t.haltPc,
    steps,
    haltPc: t.haltPc,
    timeouts: m.read(0x0410),
    lines,
    // the firmware's own work area, the same bytes the masked case pins
    ram: [0x0400, 0x0401, 0x0402, 0x0403, 0x0404, 0x0405].map((a) => m.read(a)),
  };
}

if (require.main === module) {
  const r = runInt3();
  console.log(`[coco ssc int3] HALT ${r.halted ? 'reached' : 'NOT reached'} at pc $${r.haltPc.toString(16).toUpperCase()}` +
    ` after ${r.steps} instructions`);
  console.log(`  device writes: ${r.lines.length} commands, ${r.lines.reduce((n, l) => n + l.split(' ').length - 1, 0)} entries`);
  console.log(`  final work RAM $0400-$0405: ${r.ram.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
  console.log('  sequence:');
  for (const l of r.lines) console.log('    ' + l);
  // Exit code: 0 only if the case did what it must. NOTE the wait in this build is unbounded and has no
  // time-out path at all (gen-roms.js substitutes `INC TIMEOUTS` out), so $0410 cannot become non-zero and is
  // NOT checked here - a check that cannot fail is not evidence (AGENTS.md hard rule 3). What actually proves
  // every command was serviced is that the firmware REACHED HALT: with no give-up path, a command the card did
  // not answer would leave the 6809 polling forever, so reaching HALT means all 37 were answered.
  const ok = r.halted && r.lines.length === 37;
  if (!ok) console.log(`FAIL: halted=${r.halted} commands=${r.lines.length}`);
  process.exitCode = ok ? 0 : 1;
}

module.exports = { runInt3 };
