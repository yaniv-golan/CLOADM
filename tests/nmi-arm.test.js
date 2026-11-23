// When the 6809 starts taking NMI. After reset NMI is disarmed until the program first loads S; an edge before
// that is lost. LDS, LEAS and TFR r,S arm it, EXG with S does not (MAME 0.264: m6809.cpp execute_set_input,
// m6809.lst TFR and EXG, base6x09.lst LD16 and LEA_us). The machine-level part runs tools/mame-diff/fdc/nmi.asm,
// which MAME agrees with instruction for instruction (run.js dragon64 --fdc --nmi).
const path = require('path');
const Emu = require('./load')();
const { CPU6809 } = Emu;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// a CPU with RAM everywhere and the NMI vector at $2000, running `code` at $1000 for `steps` instructions
function cpuAfter(code, { edgeFirst = false, steps = 1 } = {}) {
  const mem = new Uint8Array(0x10000);
  mem.set(code, 0x1000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00; mem[0xFFFC] = 0x20; mem[0xFFFD] = 0x00; mem[0x2000] = 0x3B;
  const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  if (edgeFirst) cpu.nmi();
  for (let i = 0; i < steps; i++) cpu.step();
  return cpu;
}
// run `steps` instructions, then raise an NMI edge and step once: was it taken (PC at the vector)?
function takes(code, steps) {
  const cpu = cpuAfter(code, { steps });
  cpu.nmi();
  cpu.step();
  return cpu.pc === 0x2000;
}
const NOP = 0x12;
check('after reset an NMI edge is not taken', !takes([NOP, NOP], 1));
check('LDS #$7F00 arms NMI', takes([0x10, 0xCE, 0x7F, 0x00, NOP], 1));
check('LEAS $7000,X arms NMI', takes([0x32, 0x89, 0x70, 0x00, NOP], 1));
check('TFR X,S arms NMI', takes([0x8E, 0x7F, 0x00, 0x1F, 0x14, NOP], 2));
check('TFR A,S (an 8-bit source) arms NMI', takes([0x86, 0x7F, 0x1F, 0x84, NOP], 2));
check('EXG X,S does not arm NMI', !takes([0x8E, 0x7F, 0x00, 0x1E, 0x14, NOP], 2));
check('EXG S,Y does not arm NMI', !takes([0x10, 0x8E, 0x7E, 0x00, 0x1E, 0x42, NOP], 2));
check('TFR S,X (S the source) does not arm NMI', !takes([0x1F, 0x41, NOP], 1));
// an edge before arming is lost, not taken once S is loaded
{
  const cpu = cpuAfter([0x10, 0xCE, 0x7F, 0x00, NOP, NOP], { edgeFirst: true, steps: 2 });
  check('an edge before LDS is dropped: no NMI after S is loaded', cpu.pc === 0x1005 && !cpu.nmiPending, `pc $${cpu.pc.toString(16)}`);
}

// the firmware on our Dragon 64 with the Dragon DOS controller: the NMI count after each of its five INTRQ pulses
{
  const t = require('../tools/mame-diff/fdc/spec.js').trace('dragon64', { nmi: true });
  const { assembleFile } = require('../tools/mame-diff/lib/firmware');
  const fw = assembleFile(path.join(__dirname, '../tools/mame-diff/fdc/nmi.asm'), '6809');
  const ends = new Set(Object.keys(Object.fromEntries(fw.symbols)).filter((k) => /^COUNT\d$/.test(k)).map((k) => fw.symbols.get(k)));
  const m = t.machine();
  const counts = [];
  let halted = false, prev = -1;
  // A after each pulse's "COUNTn LDA NMICNT"
  m.cpu.trace = (c) => { if (ends.has(prev)) counts.push(c.a); prev = c.pc; if (c.pc === t.haltPc) halted = true; };
  for (let f = 0; f < 20 && !halted; f++) m.runFrame();
  check('nmi.asm has its six pulses', ends.size === 6);
  check('nmi.asm reaches HALT', halted);
  check('nmi.asm: NMIs 0 (before S), 0 (EXG X,S), 0 (EXG S,Y), 1 (TFR X,S), 2 (another edge), 3 (after LDS)',
    JSON.stringify(counts) === '[0,0,0,1,2,3]', JSON.stringify(counts));
}

// ---- the HD6309's own arming rule ----
// The 6309 keeps LDS and LEAS as arming instructions (they are the 6809's encodings) but its TFR and EXG are
// a different implementation from the 6809's: MAME's hd6309.lst TFR/EXG (the two handlers at lines 798-809)
// read and write the 6309 register file and never touch the NMI arm, where the 6809's TFR handler
// (m6809.lst TFR, the base core) sets it for r,S. So on the 6309 the only way to arm NMI is LDS or LEAS.
// Verified in lockstep on dragon64 and tanodr64 (run.js <profile> --fdc --nmi --cpu 6309): every register and
// cycle count identical. The firmware's counts differ from the 6809's - [0,0,0,0,0,1] against [0,0,0,1,2,3] -
// which is the arming difference made visible: only its last pulse, the LDS, is taken on the 6309.
{
  const { CPU6309 } = Emu;
  check('the 6309 core is what this machine runs', Emu.cpus['6309'] === CPU6309);
  const takes6309 = (code, steps) => {
    const mem = new Uint8Array(0x10000);
    mem.set(code, 0x1000);
    mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00; mem[0xFFFC] = 0x20; mem[0xFFFD] = 0x00; mem[0x2000] = 0x12;
    const cpu = new CPU6309({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
    cpu.reset();
    for (let i = 0; i < steps; i++) cpu.step();
    cpu.nmi();
    cpu.step();
    return cpu.pc === 0x2000;
  };
  const NOP = 0x12;
  check('6309: after reset an NMI edge is not taken', !takes6309([NOP, NOP], 1));
  check('6309: LDS #$7F00 arms NMI', takes6309([0x10, 0xCE, 0x7F, 0x00, NOP], 1));
  check('6309: LEAS $7000,X arms NMI', takes6309([0x32, 0x89, 0x70, 0x00, NOP], 1));
  check('6309: TFR X,S does not arm NMI (unlike the 6809)', !takes6309([0x8E, 0x7F, 0x00, 0x1F, 0x14, NOP], 2));
  check('6309: EXG X,S does not arm NMI', !takes6309([0x8E, 0x7F, 0x00, 0x1E, 0x14, NOP], 2));
  // the 6309's own registers can be the source; none of them arms it either
  check('6309: TFR W,S does not arm NMI', !takes6309([0x10, 0x86, 0x7F, 0x00, 0x1F, 0x64, NOP], 2));
  check('6309: TFR 0,S does not arm NMI', !takes6309([0x1F, 0xC4, NOP], 1));
  // and the firmware's own count sequence on the 6309, which is what the lockstep compares
  const t9 = require('../tools/mame-diff/fdc/spec.js').trace('dragon64', { nmi: true, cpu: '6309' });
  const m9 = t9.machine();
  const counts9 = [];
  let halted9 = false, prev9 = -1;
  const fw9 = require('../tools/mame-diff/lib/firmware').assembleFile(path.join(__dirname, '../tools/mame-diff/fdc/nmi.asm'), '6309');
  const ends9 = new Set(Object.keys(Object.fromEntries(fw9.symbols)).filter((k) => /^COUNT\d$/.test(k)).map((k) => fw9.symbols.get(k)));
  m9.cpu.trace = (c) => { if (ends9.has(prev9)) counts9.push(c.a); prev9 = c.pc; if (c.pc === t9.haltPc) halted9 = true; };
  for (let f = 0; f < 20 && !halted9; f++) m9.runFrame();
  check('nmi.asm on the 6309 reaches HALT', halted9);
  // On the 6309 the count stays 0 for the first five pulses: the firmware sets S there only through EXG and
  // TFR, and the 6309 arms on neither, so those edges are dropped. It rises at pulse 6, the LDS - the 6309
  // does arm on that (MAME's 6309 uses the base core's LD16 handler, which sets lds_encountered,
  // base6x09.lst LD16) - so the 6309's own NMI entry, frame, vector and timing, is exercised too. That is
  // the difference from the 6809 above, where the TFR at pulse 4 already armed it (0,0,0,1,2,3). The
  // lockstep against tanodr64h and dragon64h agrees with this program instruction for instruction, which is
  // what makes it evidence rather than an assertion about our own code.
  check('nmi.asm on the 6309: dropped while only EXG and TFR set S, then taken once LDS does',
    JSON.stringify(counts9) === '[0,0,0,0,0,1]', JSON.stringify(counts9));
}

// ---- the two options fdc.trace() gained, and that they compose ----
// --cpu 6309 and --multi arrived on different branches and were merged here, so the combination has to be
// pinned: a merge that kept one side's argument but not its guard would let --multi pick a setup that exists
// only for the NMI firmware (tanodragonfdc), or let a 6309 trace build without a 6309.
//
// Every check below passes an explicit BOOLEAN as its condition. This file's helper is
// check(name, cond, detail) -- a truthiness test -- so passing a value and an expectation as the last two
// arguments silently tests only "is it truthy": a non-empty string such as "0,0,0" or a CPU name such as
// 'CPU6809' always passes. That mistake was made here once already and caught only by mutation.
{
  const fdc = require('../tools/mame-diff/fdc/spec.js');
  // (a) --multi on an nmiOnly setup throws, with THIS message. Asserting the text, not just that it throws:
  // a guard that refused for some other reason would otherwise pass.
  let msg = '';
  try {
    fdc.trace('tanodr64', { controller: 'tanodragonfdc', multi: true, regenerate: false });
  } catch (e) { msg = e.message; }
  check('tanodragonfdc + multi is rejected', msg !== '', msg || '(it was accepted)');
  check('tanodragonfdc + multi says why: --multi on an NMI-only setup',
    /--multi/.test(msg) && /tanodragonfdc/.test(msg), msg);
  // and a plain cartridge controller is still accepted, so the guard did not become "always throw"
  const okMulti = (() => { try { return fdc.trace('coco', { multi: true, regenerate: false }); } catch (e) { return null; } })();
  check('coco + multi still builds', okMulti !== null, '');
  // (b) nmi + 6309 still builds, AND the machine really runs a 6309. A constructor name alone would pass for a
  // machine built and then pointed at the wrong core, so run a 6309-only instruction on the machine's own CPU:
  // TFM X+,Y+ ($11 $38) copies memory on a 6309, where a 6809 treats $11 $38 as an undefined page-2 opcode and
  // charges two cycles, leaving PC at $1002 and memory untouched (js/cpu/cpu6809.js undefinedPrefixed).
  // The BOTH-increment form is used deliberately: it is the one TFM direction pair this core gets right on
  // every branch, so the assertion cannot be an artefact of the 3A/3B direction bug (fixed on
  // a separate change, not merged here). $11 $3A and $11 $3B are avoided for that reason.
  const t9n = fdc.trace('tanodr64', { controller: 'tanodragonfdc', nmi: true, cpu: '6309', regenerate: false });
  check('tanodr64 nmi + 6309 builds and targets the 6309 MAME sibling', t9n.system === 'tanodr64h', t9n.system);
  const m9n = t9n.machine();
  check('tanodr64 nmi + 6309 runs the 6309 core', m9n.cpu.constructor.name === 'CPU6309', m9n.cpu.constructor.name);
  const c = m9n.cpu, saved = { pc: c.pc, s: c.s, x: c.x, y: c.y, w: c.w, md: c.md };
  m9n.write(0x2000, 0xA1); m9n.write(0x2001, 0xB2); m9n.write(0x2002, 0xC3);
  m9n.write(0x1000, 0x11); m9n.write(0x1001, 0x38); m9n.write(0x1002, 0x12);   // TFM X+,Y+
  c.pc = 0x1000; c.x = 0x2000; c.y = 0x3000; c.w = 3; c.s = 0x8000;
  c.step();
  const dst = [m9n.read(0x3000), m9n.read(0x3001), m9n.read(0x3002)];
  check('a 6309-only instruction executes on that machine (TFM X+,Y+ copies the block)',
    dst.join(',') === '161,178,195', dst.join(','));
  check('...and moves both pointers and clears W',
    c.x === 0x2003 && c.y === 0x3003 && c.w === 0, `x=${c.x.toString(16)} y=${c.y.toString(16)} w=${c.w}`);
  check('...and the PC advances past it (a 6809 would leave it at $1002)', c.pc === 0x1003, c.pc.toString(16));
  Object.assign(c, saved);
}

// ---- the dragon64 nmi case the regression gate now hashes on the 6309 ----
// The gate has two keys for the NMI firmware, 'trace dragon64 dragonfdc nmi' (6809) and '... nmi 6309'. A key name
// proves nothing about what ran, so pin that the second really is a 6309 run of the same firmware: the spec must
// target the 6309 MAME sibling and its machine must be a CPU6309. The two traces must also differ -- on the 6309
// the firmware's TFR and EXG do not arm NMI, so the counts differ (0,0,0,0,0,1 against 0,0,0,1,2,3), which is
// what makes the second case worth hashing at all.
{
  const fdc = require('../tools/mame-diff/fdc/spec.js');
  const t9r = fdc.trace('dragon64', { nmi: true, cpu: '6309', regenerate: false });
  check('the gate 6309 NMI case targets the 6309 MAME sibling', t9r.system === 'dragon64h', t9r.system);
  const m9r = t9r.machine();
  check('...and its machine runs the 6309 core', m9r.cpu.constructor.name === 'CPU6309', m9r.cpu.constructor.name);
  // The two runs must differ in what the FIRMWARE records, not in the MAME system name -- that is already
  // established two lines up, and a check that restates it would pass no matter what the core did. Run both and
  // compare the NMI counts the firmware writes at its COUNTn labels: on the 6309 its TFR and EXG never arm NMI,
  // so the first five pulses are dropped and only the LDS is taken.
  const { assembleFile } = require('../tools/mame-diff/lib/firmware');
  const series = (t, cpu) => {
    const m = t.machine();
    const fw = assembleFile(path.join(__dirname, '../tools/mame-diff/fdc/nmi.asm'), cpu);
    const ends = new Set(Object.keys(Object.fromEntries(fw.symbols)).filter((k) => /^COUNT\d$/.test(k)).map((k) => fw.symbols.get(k)));
    const out = []; let prev = -1, halted = false;
    m.cpu.trace = (c) => { if (ends.has(prev)) out.push(c.a); prev = c.pc; if (c.pc === t.haltPc) halted = true; };
    for (let f = 0; f < 20 && !halted; f++) m.runFrame();
    return { out: JSON.stringify(out), halted };
  };
  const s9 = series(t9r, '6309'), s68 = series(fdc.trace('dragon64', { nmi: true, regenerate: false }), '6809');
  check('...and it is not the 6809 case in disguise: the firmware records different NMI counts',
    s9.out === '[0,0,0,0,0,1]' && s68.out === '[0,0,0,1,2,3]', `6309 ${s9.out} vs 6809 ${s68.out}`);
}

// ---- trace() rejects option keys it does not know ----
// Every option trace() takes is read explicitly, so a misspelt key -- or an option another branch added and this
// one did not -- is silently ignored and the trace comes back looking valid for the wrong setup. That happened
// once: `cpu: '6309'` was passed to a trace() that had no such option and the answer was a 6809 run with no
// error. Unknown keys are now rejected by name, whatever their value. undefined/null values for the KNOWN keys
// stay allowed: run.js passes `controller: undefined` when no controller is named and `blank: null` when --blank
// is absent.
{
  const fdc = require('../tools/mame-diff/fdc/spec.js');
  let msg = '';
  try { fdc.trace('dragon64', { nmi: true, regenerate: false, cpuu: '6309' }); } catch (e) { msg = e.message; }
  check('an unknown option key is rejected', msg !== '', msg || '(it was accepted)');
  check('...and the error names the bad key', /cpuu/.test(msg), msg);
  // the documented keys with undefined/null values are still fine (run.js's own calling pattern)
  let ok = true, okMsg = '';
  try { fdc.trace('dragon64', { controller: undefined, regenerate: false, write: false, nmi: false, multi: false, blank: null, cpu: '6809' }); }
  catch (e) { ok = false; okMsg = e.message; }
  check('undefined and null values for known keys are still accepted', ok, okMsg);
  // and the nested `blank` object gets the same treatment: a misspelt field is ignored otherwise, so a
  // `sides` typo (run.js's parser writes `heads`) would trace a different disk than asked for
  let bmsg = '';
  try { fdc.trace('dragon64', { controller: 'dragonfdc', regenerate: false, blank: { format: 'vdk', tracks: 40, heads: 1, sides: 2 } }); } catch (e) { bmsg = e.message; }
  check('an unknown blank field is rejected', bmsg !== '', bmsg || '(it was accepted)');
  check('...and the message names it', /sides/.test(bmsg), bmsg);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
