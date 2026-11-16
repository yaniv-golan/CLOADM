#!/usr/bin/env node
// What MAME 0.289's HD6309 does with $1020, $1050, $1057 and $1058 — measured, not assumed.
//
//   node tools/mame-diff/6309/illegal-probe.js [profile]
//
// illegal.asm runs each of the four opcodes as raw bytes and records whether the $FFF0 Illegal
// Instruction handler ran. This script runs that firmware in MAME (the profile's HD6309 sibling) and in
// this project's core, and prints for each case: MAME's verdict, ours, and the cycle count each charges
// the opcode. MAME's cycles come from the instruction trace (totalcycles deltas), so the figure is the
// instruction's own, not an average.
//
// The firmware is our own and installed in place of the BASIC ROM, like the sweep: nothing here needs a
// real ROM.
const path = require('path');
const { loadEmu, assembleFile, romImage, writeRoms, mameConfigArgs } = require('../lib/firmware');
const { streamTrace, lockWork } = require('../lib/mame');

const PROFILE = process.argv[2] || 'dragon64';
const WORK = `/tmp/mame-diff/6309-illegal-${PROFILE}`;
const CASES = [
  { n: 1, name: '$10 $20', bytes: [0x10, 0x20], resume: 'RESUME1' },
  { n: 2, name: '$10 $50 NEGW', bytes: [0x10, 0x50], resume: 'RESUME2' },
  { n: 3, name: '$10 $57 ASRW', bytes: [0x10, 0x57], resume: 'RESUME3' },
  { n: 4, name: '$10 $58 ASLW', bytes: [0x10, 0x58], resume: 'RESUME4' },
  // Controls, and their rows are version-sensitive, unlike the trap rows above. Measured raw (totalcycles
  // before and after each instruction): 0.264 charges DIVD #$02 3 cycles (291 -> 294) where 0.289 charges
  // 28 (314 -> 342), so 0.264 undercharges that divide. DIVD #$00 is the divide-by-zero trap, and its
  // delta spans the trap handler's own instructions, which this excerpt does not print (175 -> 212 on
  // 0.264, 175 -> 235 on 0.289), so it is a control on the trap path's shape, not a divide figure.
  { n: 5, name: 'DIVD #$00', bytes: [0x11, 0x8d, 0x00], resume: 'RESUME5' },   // control: the same trap
  { n: 6, name: 'SWI3', bytes: [0x11, 0x3f], resume: 'RESUME6' },               // control: same vector and push
  { n: 7, name: 'DIVD #$02', bytes: [0x11, 0x8d, 0x02], resume: 'RESUME7' },   // control: a divide, no trap
  { n: 8, name: '$15 (page 1)', bytes: [0x15], resume: 'RESUME8' },            // control: illegal, one byte
  { n: 9, name: '$15 (native)', bytes: [0x15], resume: 'RESUME9' },            // control: illegal, native frame
];

const Emu = loadEmu();
const profile = Emu.profiles[PROFILE];
if (!profile) throw new Error(`no profile ${PROFILE}`);
if (!profile.options.cpu.values.includes('6309')) throw new Error(`${PROFILE} has no 6309 option`);
const system = profile.mame6309;
if (!system) throw new Error(`${PROFILE} has no HD6309 sibling in MAME`);

const asm = assembleFile(path.join(__dirname, 'illegal.asm'), '6309');
const span = Math.max(...profile.roms.map((s) => s.at + s.size)) - 0x8000;
const image = romImage(asm, 0x8000, span, 0x12);
const slots = {};
for (const sl of profile.roms) slots[sl.id] = image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);

// ---------------------------------------------------------------- MAME
// The trace runs to the HALT loop; we want, per case, the cycles of the opcode instruction itself and
// whether the next instruction is TRAP. MAME's disassembly of the raw bytes is not what we are asking
// about, so the PC identities come from our assembler's symbols.
const sym = (name) => asm.symbols.get(name);
const ENTRIES_HALT = asm.symbols.get('HALT');
async function mameRun() {
  lockWork(WORK);
  const roms = {};
  for (const sl of profile.roms) for (const f of sl.files) roms[f] = slots[sl.id];
  // every other ROM the driver lists is not loaded while the firmware runs, but MAME refuses to start
  // without one: fill by size, as spec.js does
  const { execFileSync } = require('child_process');
  const { MAME } = require('../lib/mame');
  let listed = [];
  try {
    listed = [...execFileSync(MAME, [system, '-listroms'], { env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: WORK }), timeout: 30000 }).toString().matchAll(/^(\S+)\s+(\d+)\s+CRC\(/gm)]
      .map((m) => ({ name: m[1], size: Number(m[2]) }));
  } catch (e) { listed = []; }
  const mine = new Set(profile.roms.flatMap((sl) => sl.files));
  // the driver may ask for names the profile does not use (tanodr64h); match those by size, as spec.js does
  if (!listed.some((r) => mine.has(r.name))) {
    for (const sl of [...profile.roms].sort((a, b) => a.at - b.at)) {
      const r = listed.find((x) => x.size === sl.size && !(x.name in roms));
      if (r) roms[r.name] = slots[sl.id];
    }
  }
  for (const r of listed) if (!(r.name in roms)) roms[r.name] = new Uint8Array(r.size).fill(0x12);
  writeRoms(WORK, system, roms);

  const regs = ['pc:4', 'md:2'].map((r) => { const [name, w] = r.split(':'); return { name, width: +w, mame: name.toUpperCase() }; });
  const entries = [];
  // Run until the firmware reaches HALT, not for a fixed instruction count: the cases are spread over a
  // few hundred instructions and a cap that cuts the trace short silently reports the wrong deltas for
  // whichever case lands at the cut. MAME re-logs a HALT loop, so stop at the first HALT.
  await streamTrace({
    work: WORK, system, seconds: 6, args: ['-ext', '', ...mameConfigArgs({})], regs,
    onEntry(e) { entries.push(e); return e.pc !== ENTRIES_HALT; },
  });
  return entries;
}

// For each case: find the instruction at the PC (the raw opcode's address) and read its cycle delta.
function mameVerdict(entries) {
  const out = {};
  for (const c of CASES) {
    const start = sym(c.resume) - c.bytes.length;   // the FCB sits immediately before the continuation
    const i = entries.findIndex((e) => e.pc === start);
    if (i < 0) { out[c.n] = { found: false }; continue; }
    // The opcode is the entry at `start`; whatever it costs is the difference between that entry's cycle
    // count and the next instruction the CPU runs. When it traps that next instruction is the handler's
    // first one, not the continuation, so the delta includes the trap sequence - which is what we want to
    // compare, and `trapped` says which happened.
    if (i + 1 >= entries.length) { out[c.n] = { found: false }; continue; }
    const cycles = entries[i + 1].cycles - entries[i].cycles;
    const nextPc = entries[i + 1].pc;
    const trapped = nextPc === sym('TRAP');
    out[c.n] = { found: true, cycles, trapped, nextPc };
  }
  return out;
}

// ---------------------------------------------------------------- ours
function ourRun() {
  const m = Emu.createMachine(PROFILE, { cpu: '6309', mameCompat: true });
  m.setRoms(slots); m.reset(true);
  const m2 = Emu.createMachine(PROFILE, { cpu: '6309' });
  m2.setRoms(slots); m2.reset(true);
  const out = {};
  for (const [label, machine] of [['compat', m], ['default', m2]]) {
    const seen = [];
    machine.cpu.trace = (c) => seen.push({ pc: c.pc, cycles: c.totalCycles });
    for (let f = 0; f < 400 && !seen.some((s) => s.pc === sym('HALT')); f++) machine.runFrame();
    machine.cpu.trace = null;
    out[label] = {};
    for (const c of CASES) {
      const at = sym(c.resume) - c.bytes.length;
      const i = seen.findIndex((s) => s.pc === at);
      if (i < 0 || i + 1 >= seen.length) { out[label][c.n] = { found: false }; continue; }
      out[label][c.n] = { found: true, cycles: seen[i + 1].cycles - seen[i].cycles, trapped: seen[i + 1].pc === sym('TRAP') };
    }
  }
  return out;
}

(async () => {
  const [entries, ours] = [await mameRun(), ourRun()];
  const mame = mameVerdict(entries);
  console.log(`\nprofile ${PROFILE}, MAME ${system} (trace ${entries.length} instructions)\n`);
  console.log('  case  opcode         MAME                    ours (default)          ours (mameCompat)');
  for (const c of CASES) {
    const m = mame[c.n], d = ours.default[c.n], k = ours.compat[c.n];
    const fmt = (r) => !r || !r.found ? 'not found' : `${r.trapped ? 'TRAPS     ' : 'runs      '} ${String(r.cycles).padStart(3)} cyc`;
    console.log(`  ${c.n}     ${c.name.padEnd(15)} ${fmt(m).padEnd(23)} ${fmt(d).padEnd(23)} ${fmt(k)}`);
  }
  console.log('');
})();
