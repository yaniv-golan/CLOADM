// The static census: which BASIC ROM entry points a program's own file refers to, read from the file's bytes as
// loaded (its segments), before anything runs. No ROM byte is read: the program image is the program's, and the
// ROM is used only to find copies of it IN the image (below), which are left out.
//
//   staticRefs(segments, exec, images, { maxCandidates }) ->
//     { refs: [{ from, target, slot?, kind, source }], dropped: bytes left out, candidatesDropped: bool }
//
// 1. ROM copied into the program file. A program file can carry ROM code or tables (a copy of a routine, a font):
//    every run of WINDOW (16, js/media/romrefs.js) or more bytes of a ROM image found in a segment, and WINDOW bytes
//    either side of it, is left out of the image before anything is decoded, so no operand inside it is ever reported.
// 2. Recursive descent from the exec address: each instruction's fall-through, branch and call targets inside the
//    image are followed; JMP, BRA/LBRA, RTS, RTI, PULS/PULU with PC and a JMP/JSR through a register or memory end
//    a path. A reference found this way is source 'static'.
// 3. A linear sweep decodes at every byte of the image: references only it finds (code the descent didn't reach -
//    a jump table, code after a computed jump - or data that happens to decode as one) are source 'candidate'.
//    At most maxCandidates distinct candidate targets per program; past that, all of them are dropped
//    (candidatesDropped), as the sweep is then mostly decoding data.
// A reference: a JSR/JMP extended, BSR/LBSR, or a branch, into $8000-$BFFF (target); or a JSR/JMP [$A000-$A00F]
// through BASIC's call vectors (slot: the vector's address; target: null - its value is ROM data, never read here).
// A direct-page JSR/JMP is skipped (DP is not known statically).
'use strict';
const { disassemble } = require('../../js/emu.js');
const { findRuns, windowIndex, WINDOW } = require('../../js/media/romrefs.js');

const ROM_LO = 0x8000, ROM_HI = 0xBFFF, VEC_LO = 0xA000, VEC_HI = 0xA00F;
const inRom = (a) => a >= ROM_LO && a <= ROM_HI;
const ENDS = new Set(['JMP', 'BRA', 'LBRA', 'RTS', 'RTI']);
const CALLS = { JSR: 'jsr', JMP: 'jmp', BSR: 'bsr', LBSR: 'lbsr' };

// the image: address -> byte, from the segments, with ROM copies (and a margin) left out
function image(segments, images) {
  const mem = new Map();
  let dropped = 0;
  const index = images.length ? windowIndex(images) : null;
  for (const seg of segments) {
    const data = Uint8Array.from(seg.data), keep = new Uint8Array(data.length).fill(1);
    if (index) {
      for (const r of findRuns(data, images, index)) {
        for (let i = Math.max(0, r.at - WINDOW); i < Math.min(data.length, r.at + r.len + WINDOW); i++) keep[i] = 0;
      }
    }
    for (let i = 0; i < data.length; i++) {
      const a = (seg.addr + i) & 0xFFFF;
      if (keep[i]) mem.set(a, data[i]); else { mem.delete(a); dropped++; }
    }
  }
  return { mem, dropped };
}

// the instruction at `at` -> null (not in the image, or running off it, or illegal) or { d, ref, next[], ends }
function decode(mem, at) {
  if (!mem.has(at)) return null;
  const d = disassemble('6809', at, { peek: (a) => (mem.has(a & 0xFFFF) ? mem.get(a & 0xFFFF) : 0) });
  for (let i = 0; i < d.size; i++) if (!mem.has((at + i) & 0xFFFF)) return null;   // runs off the image
  if (d.illegal) return null;
  const m = d.mnemonic, next = [], fall = (at + d.size) & 0xFFFF;
  let ref = null, ends = ENDS.has(m);
  if ((m === 'PULS' || m === 'PULU') && /\bPC\b/.test(d.text)) ends = true;
  if (CALLS[m] && d.mode === 'idx') {
    // through memory or a register: only [$A00x] (postbyte $9F, an extended indirect address) is a reference
    const pb = mem.get((at + 1) & 0xFFFF);
    if (pb === 0x9F && d.target != null && d.target >= VEC_LO && d.target <= VEC_HI - 1) ref = { slot: d.target, target: null, kind: `${CALLS[m]}-indirect` };
    ends = ends || m === 'JMP';
  } else if (d.target != null && (d.mode === 'ext' || d.mode === 'rel8' || d.mode === 'rel16')) {
    if (inRom(d.target)) ref = { target: d.target, kind: CALLS[m] || 'branch' };
    else next.push(d.target);
  }
  if (!ends) next.push(fall);
  return { d, ref, next, ends };
}

function staticRefs(segments, exec, images, { maxCandidates = 128 } = {}) {
  const { mem, dropped } = image(segments, images);
  const found = new Map();        // from -> ref
  // 2. recursive descent from exec
  const seen = new Set(), todo = exec != null ? [exec & 0xFFFF] : [];
  while (todo.length) {
    const at = todo.pop();
    if (seen.has(at)) continue;
    seen.add(at);
    const ins = decode(mem, at);
    if (!ins) continue;
    if (ins.ref) found.set(at, Object.assign({ from: at, source: 'static' }, ins.ref));
    for (const n of ins.next) if (mem.has(n) && !seen.has(n)) todo.push(n);
  }
  // 3. linear sweep
  const candidates = [];
  for (const at of [...mem.keys()].sort((a, b) => a - b)) {
    if (found.has(at)) continue;
    const ins = decode(mem, at);
    if (ins && ins.ref) candidates.push(Object.assign({ from: at, source: 'candidate' }, ins.ref));
  }
  const candTargets = new Set(candidates.map((c) => (c.target != null ? c.target : c.slot)));
  const candidatesDropped = candTargets.size > maxCandidates;
  const refs = [...found.values(), ...(candidatesDropped ? [] : candidates)].sort((a, b) => a.from - b.from);
  return { refs, dropped, candidatesDropped };
}

module.exports = { staticRefs, image, decode };
