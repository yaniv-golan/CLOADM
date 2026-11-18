// Lockstep comparison of MAME's streamed trace with our emulator, instruction by instruction:
// registers must be identical and elapsed cycle counts (relative to the first instruction) equal.
// Exit codes: 0 identical and firmware reached HALT; 1 divergence, cycle mismatch or no HALT.
// A spec with `stuck: { pc }` instead expects the CPU to stop for good inside the instruction at pc (HALT held by a
// disk controller whose DRQ never comes): 0 when MAME's trace ends there, identical, and ours runs no further
// instruction for as long as MAME ran (spec.seconds), its CPU still held; HALT must not be reached.
const { streamTrace } = require('./mame');

const hx = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');

// spec: { system, work, seconds, args, regs: [{ name, width, mame }], luaPrelude, luaPostlude,
//         waitOps, machine (prepared, reset), haltPc }; or, in place of machine, ours: () => [regs (hex strings, in
//         the order of spec.regs), totalCycles] for our next instruction (a trace computed beforehand)
//
// The comparison is strict: there are no allowed differences. Where MAME and this project disagree the
// machine runs with config.mameCompat, which makes the core reproduce MAME's behaviour, so a comparison
// never needs an excuse for a difference it found (AGENTS.md section 1.3).
async function lockstep(spec) {
  const m = spec.machine, regs = spec.regs;
  const fmt = (c) => regs.map((r) => hx(c[r.name], r.width));
  // our trace, produced on demand
  const ours = [];
  let oi = 0;
  if (m) m.cpu.trace = (c) => ours.push([fmt(c), c.totalCycles]);
  const nextOurs = spec.ours || (() => {
    while (oi >= ours.length) {
      if (ours.length > 200000) { ours.splice(0, oi); oi = 0; }
      m.runFrame();
    }
    return ours[oi++];
  });

  let n = 0, base = null, regsOk = true, cycOk = true, firstCyc = -1, halted = -1, lastPc = -1;
  let prev = null;
  const hist = [];
  const report = (what) => {
    console.log(`${what} at instruction ${n}:`);
    console.log('      ' + regs.map((r) => r.name.toUpperCase().padEnd(r.width + 1)).join('') + ' elapsed');
    for (const [i, [mr, or, dis, mc, oc]] of hist.entries()) {
      const mark = i === hist.length - 1 ? '>>' : '  ';
      console.log(`${mark} M ${mr.join(' ')}  ${String(mc).padStart(8)}  ${dis}`);
      console.log(`${mark} O ${or.join(' ')}  ${String(oc).padStart(8)}`);
    }
  };
  await streamTrace(Object.assign({}, spec, {
    onEntry(e) {
      const next = nextOurs();
      if (!next) return false;          // (a trace computed beforehand has ended: MAME ran on past it)
      const [or, oc] = next;
      if (base === null) base = [e.cycles, oc];
      const mc = e.cycles - base[0], occ = oc - base[1];
      hist.push([e.regs, or, e.dis, mc, occ]);
      if (hist.length > 10) hist.shift();
      if (halted < 0 && e.pc === spec.haltPc) halted = n;
      lastPc = e.pc;
      // per instruction, on the delta from the previous one
      let mcDelta = mc, occDelta = occ;
      if (prev) { mcDelta -= prev[0]; occDelta -= prev[1]; }
      prev = [mc, occ];
      if (cycOk && occDelta !== mcDelta) {
        cycOk = false; firstCyc = n;
        hist[hist.length - 1][3] = `${e.dis}  [MAME ${mcDelta} cycles, ours ${occDelta}]`;
        report('CYCLE MISMATCH');
      }
      if (e.regs.join(' ') !== or.join(' ')) { regsOk = false; report('FIRST REGISTER DIVERGENCE'); return false; }
      n++;
      // A firmware whose HALT is a loop (BRA to itself) is re-logged by MAME on every pass, so a spec that
      // sets stopAtHalt ends the comparison at the first HALT: the count then says how much firmware was
      // compared. Specs that leave it unset keep running through the loop, as before.
      return !(spec.stopAtHalt && halted >= 0);
    },
  }));
  if (spec.stuck) {
    // MAME has stopped tracing: our machine runs on to MAME's time, and must trace nothing more
    while (m.cycle < spec.seconds * m.tickHz) m.runFrame();
    const more = ours.length - oi, held = m.cpu.haltLine;
    m.cpu.trace = null;
    const at = lastPc === spec.stuck.pc;
    console.log(`[${spec.label || spec.system}] compared ${n} instructions: ` +
      `${regsOk ? 'registers identical' : 'registers diverged'}; ` +
      `${cycOk ? 'cycle counts identical' : `cycles first differ at instruction ${firstCyc}`}; ` +
      `MAME's trace stops ${at ? 'at' : 'NOT at'} the held instruction ($${hx(spec.stuck.pc, 4)}${at ? '' : `; it stops at $${hx(lastPc & 0xFFFF, 4)}`}); ` +
      `ours: ${more} more instruction${more === 1 ? '' : 's'} in ${spec.seconds} s, CPU ${held ? 'still held by HALT' : 'NOT held'}` +
      `${halted >= 0 ? '; firmware reached HALT (it must not)' : ''}`);
    return regsOk && cycOk && n > 0 && at && more === 0 && held && halted < 0 ? 0 : 1;
  }
  if (m) m.cpu.trace = null;
  console.log(`[${spec.label || spec.system}] compared ${n} instructions: ` +
    `${regsOk ? 'registers identical' : 'registers diverged'}; ` +
    `${cycOk ? 'cycle counts identical' : `cycles first differ at instruction ${firstCyc}`}; ` +
    `${halted >= 0 ? `firmware reached HALT at instruction ${halted}` : 'firmware did NOT reach HALT'}`);
  return regsOk && cycOk && halted >= 0 && n > 0 ? 0 : 1;
}

module.exports = { lockstep, hx };
