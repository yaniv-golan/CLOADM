// The static census: which BASIC ROM entry points a program's own file refers to, read from the file's bytes as
// loaded (its segments), before anything runs. No ROM byte is read: the program image is the program's, and the ROM
// is used only to find copies of it IN the image.
//
//   staticRefs(segments, images) -> { refs: [{ from, target, slot?, kind }], skipped: null | 'rom-run-in-image' }
//
// A linear scan decodes an instruction at every byte of the image, so a reference may come from data that happens to
// decode as one, or from dead code. A reference: a JSR/JMP extended, BSR/LBSR or a branch into $8000-$BFFF
// (target); or a JSR/JMP [$A000-$A00F] through BASIC's call vectors (slot: the vector's address; target null - its
// value is ROM data, never read here). A direct-page JSR/JMP is skipped (DP is not known statically).
// An image holding a run of WINDOW (16) or more bytes of a ROM image (a copied routine or table) is not scanned at all;
// segments that follow each other in memory are checked as one run.
'use strict';
const { disassemble } = require('../../js/emu.js');
const { findRuns, windowIndex } = require('../../js/media/romrefs.js');

const ROM_LO = 0x8000, ROM_HI = 0xBFFF, VEC_LO = 0xA000, VEC_HI = 0xA00F;
const CALLS = { JSR: 'jsr', JMP: 'jmp', BSR: 'bsr', LBSR: 'lbsr' };

// segments that follow each other in memory joined into one run (a tape file's blocks may each be a segment, and a
// ROM copy split across two of them is still one copy)
function contiguous(segments) {
  const runs = [];
  let cur = null, end = -1;
  for (const seg of segments) {
    if (cur && seg.addr === end) { cur.push(...seg.data); end += seg.data.length; continue; }
    if (cur) runs.push(Uint8Array.from(cur));
    cur = [...seg.data]; end = seg.addr + seg.data.length;
  }
  if (cur) runs.push(Uint8Array.from(cur));
  return runs;
}

function staticRefs(segments, images) {
  if (images.length) {
    const index = windowIndex(images);
    for (const run of contiguous(segments)) if (findRuns(run, images, index).length) return { refs: [], skipped: 'rom-run-in-image' };
  }
  const mem = new Map();
  for (const seg of segments) for (let i = 0; i < seg.data.length; i++) mem.set((seg.addr + i) & 0xFFFF, seg.data[i]);
  const peek = (a) => (mem.has(a & 0xFFFF) ? mem.get(a & 0xFFFF) : 0);
  const refs = [];
  for (const at of [...mem.keys()].sort((a, b) => a - b)) {
    const d = disassemble('6809', at, { peek });
    if (d.illegal || d.target == null) continue;
    let whole = true;
    for (let i = 0; i < d.size; i++) if (!mem.has((at + i) & 0xFFFF)) whole = false;
    if (!whole) continue;
    if (CALLS[d.mnemonic] && d.mode === 'idx') {
      if (peek(at + 1) === 0x9F && d.target >= VEC_LO && d.target <= VEC_HI - 1) refs.push({ from: at, target: null, slot: d.target, kind: `${CALLS[d.mnemonic]}-indirect` });
    } else if (((d.mode === 'ext' && CALLS[d.mnemonic]) || d.mode === 'rel8' || d.mode === 'rel16') && d.target >= ROM_LO && d.target <= ROM_HI) {
      refs.push({ from: at, target: d.target, kind: CALLS[d.mnemonic] || 'branch' });
    }
  }
  return { refs, skipped: null };
}

module.exports = { staticRefs };
