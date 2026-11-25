// The census tracer: what a program asks of the BASIC ROM, as addresses and effects, never as ROM bytes.
// Local-only (tools/census/README.md): census.js and tokens.js use it on a maintainer's machine with their own ROM dump.
//
// Ranges:
//   ROM      $8000-$BFFF   the BASIC ROM: a control transfer into it from outside it opens a record
//   MASKED   $8000-$FFFF   everything that holds or may hold ROM bytes (BASIC, its RAM copy in the Dragon 64's 64K mode,
//                          a cartridge or DOS at $C000, the 32 bytes at $FFE0-$FFFF the SAM maps from the ROM's last
//                          32), except the I/O page $FF00-$FFDF. (An I/O read that the machine answers from ROM, the
//                          floating bus at $FF60-$FFBF, reads it through the bus, so the taps see that read too.)
//   VECTORS  $A000-$A00F   BASIC's documented call vectors (POLCAT, CHROUT, ...): the one table a program may read
//
// A record: { program, target, from, kind, regsIn, regsOut, cyclesInRom, ramWritesOutsideRom: [{ addr, value }] }.
// It is open from the instruction at `target` (the first one inside ROM after one outside it, at `from`) to the first
// instruction outside ROM again; regsOut and cyclesInRom are taken there.
//
// The guard is structural: it does not look at values, it follows where data came from.
//   1. The program starts clean. Recording begins when the census loader starts the program (Machine.injectAndRun:
//      a .bin, a .cas loaded straight into memory, an asm step). Its registers are cleared then (A, B, X, Y, U, DP and
//      CC's flags; S is kept), and the RAM it was loaded into is clean. Nothing is recorded for a program started any
//      other way (by BASIC, from disk): its registers would hold whatever ROM code left in them. A stop (4) or a
//      discard (2) is final for the run: a second program loaded later starts nothing new.
//   2. Program code may not read ROM. Any read of MASKED by an instruction that started outside MASKED (a data read,
//      or a fetch by an instruction running on past $7FFF) DISCARDS THE PROGRAM: nothing it
//      did is output. The exceptions are reads that only pick where control goes next: the two bytes of a
//      JSR/JMP [$A00x] through the VECTORS table, and the CPU fetching an interrupt vector ($FFF2-$FFFF) as it takes
//      an interrupt.
//   3. ROM code that reads ROM data makes its stretch dirty. A data read of MASKED by ROM code (other than an
//      interrupt vector fetch), or of a dirty RAM cell, makes the current stretch of ROM code dirty. A record open
//      during a dirty stretch is REFUSED: written as its addresses only ({ program, target, from, kind, refused }),
//      no registers, cycles or writes. Every RAM cell ROM code writes during a dirty stretch becomes dirty.
//   4. Taint is sticky. When a dirty stretch hands control back to program code, the program may now hold ROM-derived
//      data in its registers, so everything it does from then on may depend on ROM bytes. Recording STOPS: nothing
//      later is written or counted, not even addresses. The same happens if program code reads a dirty RAM cell (as
//      data, or as an instruction other than JMP/JSR extended or RTS: the RAM hooks BASIC fills at boot).
//   5. Before the program starts (BASIC's boot, a loader), ROM code that writes a value it has read from ROM recently
//      (one of the last RECENT = 16 data reads, 0 and $FF aside) marks that cell dirty: the RAM hooks and tables BASIC
//      copies out of ROM, through registers or the stack. A value BASIC computes at boot from ROM data is not followed;
//      BASIC's boot is fixed code, not the program's. A sweep backs the heuristic up: when the program starts, before
//      its image goes in, every run of SWEEP_WINDOW (8) or more bytes of a ROM image found in RAM below $8000 is marked
//      dirty, however it got there; then the image's own cells are clean. Residue the heuristic misses that is shorter
//      than the window, or broken by a changed byte, is not marked (README, "What is left").
// What is left is what the census is for: the effects of running ROM code (constants in its instructions, its timing)
// on the program's own inputs. Two more guards bound that: the tripwire (the romrefs window check over a program's
// output values, against the ROM images: a 16-byte run of any image discards the program) and the scan limit (more than
// maxTargets distinct ROM entry points discards the program).
'use strict';
const { romWindowIn, windowIndex, WINDOW } = require('../../js/media/romrefs.js');

const ROM_LO = 0x8000, ROM_HI = 0xBFFF;
const IO_LO = 0xFF00, IO_HI = 0xFFDF;   // the SAM maps $FFE0-$FFFF from the ROM's last 32 bytes (js/machines/sam.js read)
const VEC_LO = 0xA000, VEC_HI = 0xA00F;
const HW_LO = 0xFFF2, HW_HI = 0xFFFF;
const RECENT = 16;
const SWEEP_WINDOW = 8;   // the sweep's shortest run (rule 5): census.js --sweep-window, 4 to 16   // the boot heuristic's memory: how many of ROM code's last data reads a write is matched against
const inRom = (a) => a >= ROM_LO && a <= ROM_HI;
const masked = (a) => a >= 0x8000 && !(a >= IO_LO && a <= IO_HI);
const REGS = ['a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'];
const WIDE = new Set(['x', 'y', 'u', 's', 'pc']);
// instructions program code may fetch from a dirty RAM cell: they only pick where control goes (BASIC's RAM hooks)
const HOOK_OPS = new Set([0x7E, 0xBD, 0x39]);   // JMP extended, JSR extended, RTS

const regs = (cpu, withPc) => {
  const r = {};
  for (const k of REGS) r[k] = cpu[k];
  if (withPc) r.pc = cpu.pc;
  return r;
};
// a register set's values as bytes (a 16-bit register: high, then low)
const regBytes = (r) => {
  const out = [];
  for (const [k, v] of Object.entries(r)) { if (WIDE.has(k)) out.push((v >> 8) & 0xFF, v & 0xFF); else out.push(v & 0xFF); }
  return out;
};
// the bytes a record outputs as values (addresses - target, from, write addresses - are not values)
const valueBytes = (rec) => (rec.regsIn ? [...regBytes(rec.regsIn), ...regBytes(rec.regsOut), ...rec.ramWritesOutsideRom.map((w) => w.value)] : []);

// What took control into ROM, from the instruction at `from` and how far S moved (an interrupt stacks 12 bytes, a FIRQ
// 3, a JSR/BSR 2). `from` is program code here; an instruction inside MASKED (a cartridge calling BASIC) is never read.
function kindOf(peek, from, sDelta) {
  if (masked(from)) return 'from-rom';
  const op = peek(from), pb = peek((from + 1) & 0xFFFF);
  const stacked = sDelta === -12 || sDelta === -3;
  let k = null;
  if (op === 0x9D || op === 0xBD) k = 'jsr';
  else if (op === 0xAD) k = (pb & 0x90) === 0x90 ? 'jsr-indirect' : 'jsr-indexed';
  else if (op === 0x0E || op === 0x7E) k = 'jmp';
  else if (op === 0x6E) k = (pb & 0x90) === 0x90 ? 'jmp-indirect' : 'jmp-indexed';
  else if (op === 0x8D) k = 'bsr';
  else if (op === 0x17) k = 'lbsr';
  else if (op === 0x39) k = 'rts';
  else if (op === 0x3B) k = 'rti';
  else if ((op === 0x35 || op === 0x37) && (pb & 0x80)) k = 'pul';
  else if (op === 0x16 || (op >= 0x20 && op <= 0x2F) || (op === 0x10 && pb >= 0x21 && pb <= 0x2F)) k = 'branch';
  else if (op === 0x1E || op === 0x1F) k = 'tfr';
  else if (op === 0x3F || ((op === 0x10 || op === 0x11) && pb === 0x3F)) k = 'swi';
  // an interrupt taken in place of the instruction at `from` (it runs later)
  if (stacked && k !== 'swi' && k !== 'rti') return 'interrupt';
  return k || 'other';
}

// The ROM images the tripwire looks for: the machine's own (its banks, or the built-in firmware), and a cartridge's.
function romImages(m) {
  const imgs = [];
  if (m.romBanks) for (const b of m.romBanks) if (b) imgs.push(b);
  if (!imgs.length && typeof m.currentRom === 'function') imgs.push(m.currentRom());
  const cart = m.cartPort && m.cartPort.rom && m.cartPort.rom();
  if (cart && cart.length) imgs.push(cart);
  return imgs.map((bytes) => ({ bytes }));
}

// The window check over a program's whole output stream of values, as it grows
class Tripwire {
  constructor(images) { this.images = images; this.index = windowIndex(images); this.stream = []; }
  // -> null, or { at, image, off } where a WINDOW-byte run of an image appears
  add(bytes) {
    const from = Math.max(0, this.stream.length - (WINDOW - 1));
    this.stream.push(...bytes);
    return romWindowIn(Uint8Array.from(this.stream.slice(from)), this.images, this.index);
  }
}

// The reads one instruction made that only pick where control goes, and may therefore come from MASKED:
//   - a JSR/JMP [$A00x] (opcode $AD or $6E, postbyte $9F, an address in VECTORS) reading its two address bytes there,
//     landing where they point;
//   - the CPU fetching an interrupt vector ($FFF2-$FFFF) as it takes an interrupt (S down by 12, or 3 for a FIRQ),
//     landing where it points.
// reads: [address, value] of the instruction's data reads from MASKED -> true when all of them are one of those.
function onlyPicksTarget(reads, peek, from, newPc, sDelta) {
  if (reads.length !== 2) return false;
  const [[a0, v0], [a1, v1]] = reads;
  if (a1 !== ((a0 + 1) & 0xFFFF) || ((v0 << 8) | v1) !== newPc) return false;
  if (a0 >= HW_LO && a1 <= HW_HI) return sDelta === -12 || sDelta === -3;
  if (a0 < VEC_LO || a1 > VEC_HI) return false;
  const op = peek(from), pb = peek((from + 1) & 0xFFFF), at = (peek((from + 2) & 0xFFFF) << 8) | peek((from + 3) & 0xFFFF);
  return (op === 0xAD || op === 0x6E) && pb === 0x9F && at === a0;
}

// The sweep's run finder: the runs of `a` (at least w bytes) equal to runs of the images. Like romrefs.js's findRuns,
// with a window of its own: a sweep match only costs recording (the cells become dirty), so it can afford a shorter
// window than the share-link check. Windows of one repeated byte are not indexed (padding, cleared RAM).
const uniformAt = (b, i, w) => { for (let k = 1; k < w; k++) if (b[i + k] !== b[i]) return false; return true; };
const keyAt = (b, i, w) => { let h = 0; for (let k = 0; k < w; k++) h = (Math.imul(h, 31) + b[i + k]) | 0; return h; };
function runIndex(images, w) {
  const index = new Map();
  images.forEach((img, n) => {
    const b = img.bytes;
    for (let i = 0; i + w <= b.length; i++) {
      if (uniformAt(b, i, w)) continue;
      const h = keyAt(b, i, w), at = index.get(h);
      if (at) at.push([n, i]); else index.set(h, [[n, i]]);
    }
  });
  return { images, w, index };
}
function romRuns(a, { images, w, index }) {
  const runs = [];
  for (let i = 0; i + w <= a.length;) {
    let best = 0;
    const cands = uniformAt(a, i, w) ? null : index.get(keyAt(a, i, w));
    if (cands) {
      for (const [n, off] of cands) {
        const b = images[n].bytes;
        let len = 0;
        while (i + len < a.length && off + len < b.length && a[i + len] === b[off + len]) len++;
        if (len >= w && len > best) best = len;
      }
    }
    if (best) { runs.push({ at: i, len: best }); i += best; } else i++;
  }
  return runs;
}

// Trace machine m -> { detach(), finish() -> { records, refused, started, stopped, error } }.
//   records: the records written in full; refused: the records written as addresses only (a dirty stretch);
//   started: the census loader started the program; stopped: why recording stopped (sticky taint), or null;
//   error: why the program is discarded (it read ROM, or scanned it), or null.
// opts: { program, maxWrites, maxTargets }
function trace(m, { program = '', maxWrites = 256, maxTargets = 512, sweepWindow = SWEEP_WINDOW } = {}) {
  if (!Number.isInteger(sweepWindow) || sweepWindow < 4 || sweepWindow > 16) throw new RangeError('sweepWindow is 4 to 16 bytes');
  const cpu = m.cpu, peek = (a) => m.peek(a & 0xFFFF);
  const records = [], refused = [];
  const dirtyRam = new Uint8Array(0x10000);   // 1: a RAM cell holding ROM-derived data
  const targets = new Set();
  let started = false, stopped = null, error = null;
  let dirtyStretch = false;                   // the current stretch of ROM code has read ROM data
  let open = null, prevPc = null, prevS = 0, curPc = 0;
  let stepReads = [];                         // [address, value] of the data reads from MASKED in the current instruction
  let stepFetchDirty = false;                 // the current instruction was fetched (partly) from a dirty RAM cell
  const recent = [];                          // the last data-read values from MASKED or dirty RAM by ROM code (boot heuristic)
  const images = romImages(m);

  const close = (atEnd) => {
    const rec = { program, target: open.target, from: open.from, kind: open.kind };
    if (dirtyStretch) refused.push(Object.assign(rec, { refused: 'rom-data-read' }));
    else {
      Object.assign(rec, { regsIn: open.regsIn, regsOut: regs(cpu, true), cyclesInRom: m.cycle - open.cycle, ramWritesOutsideRom: open.writes });
      if (open.dropped) rec.writesDropped = open.dropped;
      if (atEnd) rec.open = true;   // still inside ROM when the program's run ended
      records.push(rec);
    }
    open = null;
  };
  const stop = (why) => { if (!stopped) stopped = why; if (open) open = null; };
  const probe = (pc) => {
    if (error) return;
    const from = prevPc, sDelta = ((cpu.s - prevS) << 16) >> 16;
    // the instruction just done (at `from`): judge its reads
    const reads = stepReads, fetchDirty = stepFetchDirty;
    stepReads = []; stepFetchDirty = false;
    if (from !== null) {
      const romCode = masked(from);
      if (reads.length && !onlyPicksTarget(reads, peek, from, pc, sDelta)) {
        if (!romCode) { if (started && !stopped) error = 'program-read-rom'; }
        else dirtyStretch = true;
      }
      if (!romCode && fetchDirty && !HOOK_OPS.has(peek(from)) && started) stop('program-ran-rom-data');
    }
    if (error) return;
    const wasIn = from !== null && inRom(from), nowIn = inRom(pc);
    const closing = open && !nowIn;
    if (closing) close(false);
    // ROM code hands control to program code: a dirty stretch taints the program for good
    if (from !== null && masked(from) && !masked(pc)) { if (dirtyStretch && started) stop('rom-data-returned'); dirtyStretch = false; }
    if (!closing && !open && nowIn && from !== null && !wasIn && started && !stopped) {
      targets.add(pc);
      if (targets.size > maxTargets) { error = `scan: more than ${maxTargets} distinct ROM entry points`; return; }
      open = { target: pc, from, kind: kindOf(peek, from, sDelta), regsIn: regs(cpu, false), cycle: m.cycle, writes: [], dropped: 0 };
    }
    prevPc = pc; prevS = cpu.s; curPc = pc;
  };
  const onRead = (a, v) => {
    const fetch = a === cpu.pc;   // the CPU fetching the instruction (it reads at its PC); anything else is data
    // a read of MASKED is a fetch only for an instruction that started there: program code reading ROM at its PC
    // (an instruction running on past $7FFF, LDA 0,PCR at the top of RAM) reads ROM data
    if (masked(a)) {
      if (fetch && masked(curPc)) return;
      stepReads.push([a, v]);
      // ROM code reading ROM data: dirty at once (its writes in this instruction too), but for the reads judged at
      // the next instruction (a vector, which only picks where control goes: the return address a JSR [$A00x] pushes
      // after reading it is no ROM data)
      if (masked(curPc) && !(a >= VEC_LO && a <= VEC_HI) && !(a >= HW_LO && a <= HW_HI)) dirtyStretch = true;
      return;
    }
    if (!dirtyRam[a]) return;
    if (masked(curPc)) { dirtyStretch = true; return; }   // ROM code reading ROM-derived data from RAM
    if (fetch) stepFetchDirty = true;                      // judged at the next instruction (a RAM hook may be fetched)
    else if (started) stop('program-read-rom-data');
  };
  const onWrite = (a, v) => {
    if (masked(a)) return;
    const romCode = masked(curPc);
    if (!romCode) dirtyRam[a] = 0;                         // program code writes its own data (until it stops)
    else if (started) dirtyRam[a] = dirtyStretch ? 1 : 0;
    else dirtyRam[a] = v !== 0 && v !== 0xFF && recent.includes(v) ? 1 : 0;
    if (!open) return;
    if (open.writes.length < maxWrites) open.writes.push({ addr: a, value: v });
    else open.dropped++;
  };
  // the boot heuristic's memory of what ROM code last read (5): kept from the read taps
  const onReadRecent = (a, v) => { if (!started && masked(curPc) && a !== cpu.pc && (masked(a) || dirtyRam[a])) { recent.push(v); if (recent.length > RECENT) recent.shift(); } };
  // the census loader starting the program (1)
  const inject = m.injectAndRun;
  m.injectAndRun = function (segments, exec) {
    // the sweep (rule 5) looks at RAM as BASIC left it, before the program goes in: injectAndRun boots (or resets the
    // built-in firmware), then pokes the program; the first poke runs the sweep, so a ROM run the program's image
    // overlaps is seen whole and its cells outside the image stay marked
    let swept = false;
    const sweepNow = () => { if (!swept) { swept = true; sweep(); } };
    const ownPoke = Object.hasOwn(this, 'poke') ? this.poke : null, poke = this.poke;
    this.poke = function (a, v) { sweepNow(); return poke.call(this, a, v); };
    try { inject.call(this, segments, exec); } finally { if (ownPoke) this.poke = ownPoke; else delete this.poke; }
    sweepNow();
    for (const seg of segments) for (let i = 0; i < seg.data.length; i++) dirtyRam[(seg.addr + i) & 0xFFFF] = 0;
    if (exec == null) return;
    cpu.a = 0; cpu.b = 0; cpu.x = 0; cpu.y = 0; cpu.u = 0; cpu.dp = 0; cpu.cc &= 0x50;
    // (stopped and error are never cleared: a stop or a discard is final for the run, so a second program loaded over
    // RAM the first one's ROM calls filled starts nothing new; RAM is not cleared between loads with ROMs)
    started = true; dirtyStretch = false; open = null;
    stepReads = []; stepFetchDirty = false; prevPc = null;
  };
  // every run of sweepWindow or more bytes of a ROM image in RAM below $8000 is ROM data, however it got there (a copy
  // the heuristic missed: through the stack, a longer block); windows of one repeated byte are skipped
  const sweep = () => {
    const below = new Uint8Array(0x8000);
    for (let a = 0; a < 0x8000; a++) below[a] = m.peek(a);
    for (const r of romRuns(below, sweepIndex)) for (let a = r.at; a < r.at + r.len; a++) dirtyRam[a] = 1;
  };
  const sweepIndex = runIndex(images, sweepWindow);
  const removers = [
    m.addProbe(probe),
    m.busTaps.addReadTap({ start: 0, end: 0xFFFF }, (a, v) => { onReadRecent(a, v); onRead(a, v); }),
    m.busTaps.addWriteTap({ start: 0, end: 0xFFFF }, onWrite),
    () => { m.injectAndRun = inject; if (m.injectAndRun === Object.getPrototypeOf(m).injectAndRun) delete m.injectAndRun; },
  ];
  const detach = () => { while (removers.length) removers.pop()(); };
  return {
    detach,
    get error() { return error; },
    get stopped() { return stopped; },
    get started() { return started; },
    isDirty: (a) => dirtyRam[a & 0xFFFF] === 1,
    finish() {
      detach();
      if (!error && prevPc !== null && stepReads.length && !masked(prevPc) && started && !stopped) error = 'program-read-rom';
      if (open && !error && !stopped) close(true);
      return { records, refused, started, stopped, error };
    },
  };
}

module.exports = { SWEEP_WINDOW, runIndex, romRuns, ROM_LO, ROM_HI, IO_LO, IO_HI, VEC_LO, VEC_HI, inRom, masked, kindOf, regBytes, valueBytes, romImages, Tripwire, onlyPicksTarget, trace };
