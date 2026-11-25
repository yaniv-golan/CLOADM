// The census tracer: what a program asks of the BASIC ROM, as addresses and effects, never as ROM bytes.
// Local-only (tools/census/README.md): census.js and tokens.js use it on a maintainer's machine with their own ROM dump.
//
// Ranges:
//   ROM      $8000-$BFFF   the BASIC ROM: a control transfer into it from outside it opens a record
//   MASKED   $8000-$FEFF   everything that holds or may hold ROM code (BASIC, its RAM copy in the Dragon 64's 64K
//                          mode, a cartridge or DOS at $C000): no byte read from here is ever output
//
// A record: { program, target, from, kind, regsIn, regsOut, cyclesInRom, ramWritesOutsideRom: [{ addr, value }] }.
// It is open from the instruction at `target` (the first one inside ROM after one outside it, at `from`) to the
// first instruction outside ROM again; regsOut and cyclesInRom are taken there.
//
// The guard (guardRecord, and the tripwire in Tripwire) stands between the tracer and any output:
//   1. taint: every byte read from MASKED as data (any read that is not the CPU fetching the instruction at its PC)
//      is a tainted value; so is every byte read from a RAM cell that holds a tainted value written by ROM code.
//      A record whose register values or written values include a tainted value is refused: it is not written,
//      only counted (its addresses alone). Taint is followed per stretch of ROM code, with the registers ROM
//      leaves behind carried over (trace); 0 and $FF are never tainted (BLANK). A value ROM code computes from
//      a ROM byte (rather than copying it) is not followed: the tripwire and the scan limit bound that.
//   2. tripwire: the stream of every value byte a program's records output, checked with js/media/romrefs.js's
//      window check against the ROM images: a run of WINDOW (16) bytes of any image aborts that program and
//      discards everything it produced.
//   3. scan limit: a program that enters more than maxTargets distinct ROM addresses is treated as a scan of the
//      ROM (entering every address and watching what comes out) and is aborted, everything discarded.
'use strict';
const { romWindowIn, windowIndex, WINDOW } = require('../../js/media/romrefs.js');

const ROM_LO = 0x8000, ROM_HI = 0xBFFF;
const MASK_LO = 0x8000, MASK_HI = 0xFEFF;
const inRom = (a) => a >= ROM_LO && a <= ROM_HI;
const masked = (a) => a >= MASK_LO && a <= MASK_HI;
const REGS = ['a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'];
const WIDE = new Set(['x', 'y', 'u', 's', 'pc']);

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
const valueBytes = (rec) => [...regBytes(rec.regsIn), ...regBytes(rec.regsOut), ...rec.ramWritesOutsideRom.map((w) => w.value)];

// What took control into ROM, from the instruction at `from` (a RAM or cartridge address; read here, never output)
// and how far S moved (an interrupt stacks 12 bytes, a FIRQ 3, a JSR/BSR 2).
function kindOf(peek, from, sDelta) {
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
  else if (op === 0x16 || (op >= 0x20 && op <= 0x2F) || (op === 0x10 && peek((from + 1) & 0xFFFF) >= 0x21 && peek((from + 1) & 0xFFFF) <= 0x2F)) k = 'branch';
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
    return romWindowIn(Uint8Array.from(this.stream.slice(from)), this.images, this.index) || romWindowIn(Uint8Array.from(bytes), this.images, this.index);
  }
}

// Values that carry no information on their own: 0 and $FF, the fill of empty ROM and RAM and the commonest
// constants (romrefs.js skips runs of one repeated byte for the same reason). They are never tainted; the tripwire
// still sees them.
const BLANK = (v) => v === 0x00 || v === 0xFF;
const taintedReg = (k, v, taint) => (WIDE.has(k) ? [(v >> 8) & 0xFF, v & 0xFF] : [v & 0xFF]).some((b) => taint.has(b));

// -> null when the record may be written, else the reason it may not. taint: the tainted values of the record's
// ROM segment; rec.inTainted: the registers found tainted when it was opened (trace).
function guardRecord(rec, taint) {
  if (rec.inTainted && rec.inTainted.length) return 'tainted-register-in';
  for (const [k, v] of Object.entries(rec.regsIn)) if (taintedReg(k, v, taint)) return 'tainted-register-in';
  for (const [k, v] of Object.entries(rec.regsOut)) if (taintedReg(k, v, taint)) return 'tainted-register-out';
  for (const w of rec.ramWritesOutsideRom) {
    if (masked(w.addr)) return 'write-in-masked-range';
    if (taint.has(w.value)) return 'tainted-write';
  }
  return null;
}

// Trace machine m -> { detach(), error, finish() -> { records, refused, error } }.
// Refused records are kept as { program, target, from, kind, refused: reason } (addresses only).
// opts: { program, maxWrites, maxTargets }
//
// Taint (see the header) is followed per stretch of code: `taint` holds the values read since control last left
// ROM. When it leaves ROM, the registers holding a tainted value are noted (leftTainted, with their values) and the
// set starts afresh. When control comes back, a register is tainted if it still holds what ROM left in it and that
// was tainted, or if it holds a value read since (RAM code reading ROM, or a RAM cell ROM code filled with a
// tainted value).
function trace(m, { program = '', maxWrites = 256, maxTargets = 512 } = {}) {
  const cpu = m.cpu, peek = (a) => m.peek(a & 0xFFFF);
  const records = [], refused = [];
  const taint = new Set();          // tainted values read since control last left ROM
  const taintedRam = new Set();     // RAM cells holding a tainted value written by ROM code
  const targets = new Set();
  let stepReads = [];               // [address, value] of the data reads from MASKED made by the last instruction
  let leftVals = null, leftTainted = new Set();
  let open = null, prevPc = null, prevS = 0, error = null;
  const addTaint = (v) => { if (!BLANK(v)) taint.add(v); };

  const close = (exitAtEnd) => {
    const rec = {
      program, target: open.target, from: open.from, kind: open.kind,
      regsIn: open.regsIn, regsOut: regs(cpu, true), cyclesInRom: m.cycle - open.cycle,
      ramWritesOutsideRom: open.writes,
    };
    if (open.dropped) rec.writesDropped = open.dropped;
    if (exitAtEnd) rec.open = true;     // still inside ROM when the program's run ended
    const why = guardRecord(Object.assign({ inTainted: open.inTainted }, rec), taint);
    open = null;
    if (why) refused.push({ program, target: rec.target, from: rec.from, kind: rec.kind, refused: why });
    else records.push(rec);
  };
  const probe = (pc) => {
    if (error) return;
    const wasIn = prevPc !== null && inRom(prevPc), here = inRom(pc);
    const entering = prevPc !== null && !wasIn && here;
    // the last instruction's data reads from ROM. A JSR or JMP through a vector in ROM reads the target's address
    // there: that is the target, which is output anyway, so those two reads are not taint.
    const r = stepReads;
    stepReads = [];
    const vector = entering && r.length === 2 && r[1][0] === ((r[0][0] + 1) & 0xFFFF) && ((r[0][1] << 8) | r[1][1]) === pc;
    if (!vector) for (const [, v] of r) addTaint(v);
    if (wasIn && !here) {
      if (open) close(false);
      leftVals = regs(cpu, false);
      leftTainted = new Set(Object.keys(leftVals).filter((k) => taintedReg(k, leftVals[k], taint)));
      taint.clear();
    } else if (entering) {
      targets.add(pc);
      if (targets.size > maxTargets) { error = `scan: more than ${maxTargets} distinct ROM entry points`; return; }
      const regsIn = regs(cpu, false);
      const inTainted = Object.keys(regsIn).filter((k) => (leftVals && leftVals[k] === regsIn[k] && leftTainted.has(k)) || taintedReg(k, regsIn[k], taint));
      open = { target: pc, from: prevPc, kind: kindOf(peek, prevPc, ((cpu.s - prevS) << 16) >> 16), regsIn, inTainted, cycle: m.cycle, writes: [], dropped: 0 };
    }
    prevPc = pc; prevS = cpu.s;
  };
  const onRead = (a, v) => {
    if (masked(a)) { if (a !== cpu.pc) stepReads.push([a, v]); }   // a data read (an instruction fetch reads at the PC)
    else if (taintedRam.has(a)) addTaint(v);
  };
  const onWrite = (a, v) => {
    if (masked(a)) return;
    if (masked(cpu.pc) && taint.has(v)) taintedRam.add(a); else taintedRam.delete(a);
    if (!open) return;
    if (open.writes.length < maxWrites) open.writes.push({ addr: a, value: v });
    else open.dropped++;
  };
  const removers = [
    m.addProbe(probe),
    m.busTaps.addReadTap({ start: 0, end: 0xFFFF }, onRead),
    m.busTaps.addWriteTap({ start: 0, end: 0xFFFF }, onWrite),
  ];
  const detach = () => { while (removers.length) removers.pop()(); };
  return {
    detach,
    get error() { return error; },
    finish() {
      detach();
      for (const [, v] of stepReads) addTaint(v);
      stepReads = [];
      if (open && !error) close(true);
      return { records, refused, error };
    },
  };
}

module.exports = { ROM_LO, ROM_HI, MASK_LO, MASK_HI, BLANK, inRom, masked, kindOf, regBytes, valueBytes, romImages, Tripwire, guardRecord, trace };
