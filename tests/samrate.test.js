// SAM CPU rate (R1..R0), hardware model (config.mameCompat off): the time of single instructions at each
// rate and address range. Expected times are worked out here by hand from the MC6883 data sheet (p. 11:
// slow cycles are 16 crystal clocks; at the address-dependent rate $0000-$7FFF and $FF00-$FF1F stay slow and
// everything else, $FFFF internal cycles included, is fast, 8 clocks; at R1 everything is fast) and the
// speed-change cycles XRoar uses (src/mc6883.c: 15 clocks slow->fast, 17 fast->slow, 25 fast->slow after an
// odd number of fast cycles). Bus cycle sequences are those of tests/buscycles.test.js. 16 clocks = 1 tick.
const Emu = require('./load')();

let fail = 0;
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got * 16} clocks${ok ? '' : `, expected ${want * 16}`}`);
};

// ROM at $8000: NOP, LDA $FF00, LDA $FF20, LDA $1234, NOP; RAM at $1000: NOP, LDA $9000, NOP
const rom = Emu.assemble(' ORG $8000\nR NOP\n LDA $FF00\n LDA $FF20\n LDA $1234\n NOP\n ORG $BFFE\n FDB R\n');
const ram = Emu.assemble(' ORG $1000\n NOP\n LDA $9000\n NOP\n NOP\n');
if (!rom.ok || !ram.ok) throw new Error('assembly failed');
const image = new Uint8Array(0x4000).fill(0x12);
for (const s of rom.segments) image.set(s.data, s.addr - 0x8000);

function machine(id = 'dragon64') {
  const p = Emu.profiles[id], m = Emu.createMachine(id, { mameCompat: false });
  const roms = {};
  for (const sl of p.roms) roms[sl.id] = image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  m.setRoms(roms); m.reset(true);
  for (const s of ram.segments) m.ram.set(s.data, s.addr);
  m.write(0xFFDD, 0);                                  // 64K
  return m;
}
// run instructions from pc after setting the SAM rate (and map type); return each one's time in ticks
function times(m, pc, n, { r0 = false, r1 = false, ty = false, warm = 0 } = {}) {
  if (r0) m.write(0xFFD7, 0);
  if (r1) m.write(0xFFD9, 0);
  if (ty) m.write(0xFFDF, 0);
  m.cpu.pc = pc; m.cpu.cc = 0x50;
  m.runningFast = false; m.extendSlow = false;         // start from a slow cycle
  const out = [];
  for (let i = 0; i < warm + n; i++) { const t0 = m.cycle; m.runCycles(m.cycle + 1e-6); if (i >= warm) out.push(m.cycle - t0); }
  return out;
}
const T = (clocks) => clocks / 16;

// rate 00: one tick per cycle anywhere
{
  const [nop, ldaPia0, ldaPia1, ldaRam] = times(machine(), 0x8000, 4);
  check('rate 00, NOP in ROM (2 cycles)', nop, 2);
  check('rate 00, LDA $FF00 (5 cycles)', ldaPia0, 5);
  check('rate 00, LDA $FF20', ldaPia1, 5);
  check('rate 00, LDA $1234', ldaRam, 5);
}
// rate 01 from ROM, starting slow
{
  const [nop, ldaPia0, ldaPia1, ldaRam, nop2] = times(machine(), 0x8000, 5, { r0: true });
  check('rate 01, NOP in ROM: slow->fast, fast', nop, T(15 + 8));
  // LDA $FF00: opcode, operand x2 and VMA fast; 5 fast cycles since the slow->fast one (odd), so the slow
  // read of $FF00 re-interleaves
  check('rate 01, LDA $FF00 from ROM: 4 fast, then $FF00 slow (re-interleave)', ldaPia0, T(8 * 4 + 25));
  check('rate 01, LDA $FF20 from ROM: slow->fast, then all fast', ldaPia1, T(15 + 8 * 4));
  // LDA $1234: opcode, operand x2, VMA fast; 4 fast cycles since the slow->fast one (even): plain fast->slow
  check('rate 01, LDA $1234 from ROM: RAM read slow', ldaRam, T(8 * 4 + 17));
  check('rate 01, NOP in ROM after a slow cycle', nop2, T(15 + 8));
}
// rate 01 from RAM: opcode fetches and dummy reads of RAM are slow
{
  const [nop, ldaRom, nop2, nop3] = times(machine(), 0x1000, 4, { r0: true });
  check('rate 01, NOP in RAM: both cycles slow', nop, 2);
  check('rate 01, LDA $9000 from RAM: 3 slow, VMA slow->fast, ROM read fast', ldaRom, T(16 * 3 + 15 + 8));
  check('rate 01, NOP in RAM after two fast cycles (re-interleave)', nop2, T(25 + 16));
  check('rate 01, NOP in RAM', nop3, 2);
}
// rate 01, map type 1: RAM above $8000 stays slow (see js/machines/sam.js)
{
  const m = machine();
  m.write(0xFFDF, 0);
  m.ram.set([0x12, 0x12], 0x9000);                   // NOP NOP in upper RAM
  const [nop] = times(m, 0x9000, 1, { r0: true });
  check('rate 01, map type 1, NOP in RAM at $9000: slow', nop, 2);
}
// R1: every cycle fast, RAM and $FF00 included
{
  const [nop, ldaPia0, , ldaRam] = times(machine(), 0x8000, 4, { r1: true });
  check('R1, NOP in ROM', nop, T(15 + 8));
  check('R1, LDA $FF00', ldaPia0, T(8 * 5));
  const [ramNop] = times(machine(), 0x1000, 1, { r1: true, warm: 0 });
  check('R1, NOP in RAM', ramNop, T(15 + 8));
  check('R1, LDA $1234', ldaRam, T(8 * 5));
}
// back to slow: one tick per cycle again
{
  const m = machine();
  times(m, 0x8000, 3, { r0: true });
  m.write(0xFFD6, 0);
  const [nop] = times(m, 0x8000, 1);
  check('rate 00 again, NOP in ROM', nop, 2);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
