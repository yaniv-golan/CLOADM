/* File formats: DragonDOS .BIN, DECB segmented .BIN, .CAS/.C10/.K7 tape images, WAV tape recordings, cartridges,
   BASIC listings */
import { casBlocks, wavToCas } from './cassette.js';

// ---------------- writers: the round-trip partners of parseDragonDos and parseDecb ----------------
// A segment is { addr, data }, as the assembler gives them and the parsers return them.
// What a writer refuses is a WriteError: `kind` says why ('empty', 'range', 'overlap', 'gap'), `at` and `gap` where.
export class WriteError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'WriteError'; this.kind = kind; Object.assign(this, extra); }
}
const word = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const hex4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');
function checkSegments(segments, exec) {
  if (!segments.length) throw new WriteError('empty', 'nothing to write: the program has no bytes');
  if (!Number.isInteger(exec) || exec < 0 || exec > 0xFFFF) throw new WriteError('range', `the execution address ${exec} is not a 16-bit address`);
  for (const g of segments) {
    if (!Number.isInteger(g.addr) || g.addr < 0 || g.addr + g.data.length > 0x10000) throw new WriteError('range', `a segment of ${g.data.length} bytes at ${g.addr} does not fit in the 64 KiB address space`, { at: g.addr });
  }
}
// DragonDOS binary: $55 type load length exec $AA data. One contiguous range: the segments are put in address order and
// a gap between two of them is filled with zero bytes, up to maxGap bytes (default 256); a larger gap, or segments that
// overlap, is a WriteError (a segmented format, writeDecb, holds them). type: 2 binary (default), 1 BASIC.
export function writeDragonDos(segments, exec, { type = 2, maxGap = 256 } = {}) {
  checkSegments(segments, exec);
  if (type !== 1 && type !== 2) throw new WriteError('range', `a DragonDOS file type is 1 (BASIC) or 2 (binary), not ${type}`);
  const sorted = segments.filter((g) => g.data.length).sort((a, b) => a.addr - b.addr);
  if (!sorted.length) throw new WriteError('empty', 'nothing to write: the program has no bytes');
  const lo = sorted[0].addr;
  let end = lo;
  for (const g of sorted) {
    if (g.addr < end) throw new WriteError('overlap', `the segment at ${hex4(g.addr)} overlaps the one before it`, { at: g.addr });
    if (g.addr - end > maxGap) throw new WriteError('gap', `a gap of ${g.addr - end} bytes (${hex4(end)} to ${hex4(g.addr - 1)}) is more than the ${maxGap} a DragonDOS file zero-fills`, { at: end, gap: g.addr - end });
    end = g.addr + g.data.length;
  }
  const len = end - lo;
  if (len > 0xFFFF) throw new WriteError('range', `the program spans ${len} bytes, more than a DragonDOS file's 65535`);
  const out = new Uint8Array(9 + len);
  out.set([0x55, type, ...word(lo), ...word(len), ...word(exec), 0xAA]);
  for (const g of sorted) out.set(g.data, 9 + g.addr - lo);
  return out;
}
// DECB (Color BASIC LOADM) segmented binary: ($00 length address data)* $FF $00 $00 exec. The segments stay as they are, in order
// (an empty one is left out).
export function writeDecb(segments, exec) {
  checkSegments(segments, exec);
  const kept = segments.filter((g) => g.data.length);       // an empty segment is no block (as writeDragonDos leaves it out)
  if (!kept.length) throw new WriteError('empty', 'nothing to write: the program has no bytes');
  const parts = [];
  for (const g of kept) {
    if (g.data.length > 0xFFFF) throw new WriteError('range', `a segment of ${g.data.length} bytes is more than a DECB block's 65535`, { at: g.addr });
    parts.push(0x00, ...word(g.data.length), ...word(g.addr), ...g.data);
  }
  parts.push(0xFF, 0x00, 0x00, ...word(exec));
  return Uint8Array.from(parts);
}

// DragonDOS binary: 0x55 type loadHi loadLo lenHi lenLo execHi execLo 0xAA data...
function parseDragonDos(b) {
  if (b.length < 9 || b[0] !== 0x55 || b[8] !== 0xAA) return null;
  const type = b[1], load = (b[2] << 8) | b[3], len = (b[4] << 8) | b[5], exec = (b[6] << 8) | b[7];
  if (len === 0 || 9 + len > b.length + 1) return null;
  const data = b.subarray(9, 9 + len);
  return {
    format: 'DragonDOS ' + (type === 1 ? 'BASIC' : 'binary'),
    basic: type === 1,
    segments: [{ addr: load, data }],
    exec: type === 1 ? null : exec,
  };
}

// DECB-style segmented binary: (0x00 lenHi lenLo addrHi addrLo data)* 0xFF 00 00 execHi execLo
function parseDecb(b) {
  let p = 0;
  const segments = [];
  while (p + 5 <= b.length) {
    const t = b[p];
    const len = (b[p + 1] << 8) | b[p + 2], addr = (b[p + 3] << 8) | b[p + 4];
    if (t === 0xFF) {
      if (segments.length === 0) return null;
      return { format: 'segmented binary', segments, exec: addr };
    }
    if (t !== 0x00 || p + 5 + len > b.length) return null;
    segments.push({ addr, data: b.subarray(p + 5, p + 5 + len) });
    p += 5 + len;
  }
  return null;
}

// Parse a .CAS image into files.
function parseCas(b) {
  const files = [];
  let cur = null;
  for (const { start, end, type, data, ok } of casBlocks(b)) {
    if (!ok) continue;
    if (type === 0x00 && data.length >= 15) {
      let name = '';
      for (let i = 0; i < 8; i++) name += String.fromCharCode(data[i]);
      cur = {
        name: name.trim(), fileType: data[8], ascii: data[9] !== 0,
        exec: (data[11] << 8) | data[12], load: (data[13] << 8) | data[14],
        chunks: [], start, end,
      };
      // include the leader preceding the namefile block
      while (cur.start > 0 && b[cur.start - 1] === 0x55) cur.start--;
      files.push(cur);
    } else if (type === 0x01 && cur) {
      cur.chunks.push(data); cur.end = end;
    } else if (type === 0xFF && cur) {
      cur.end = end; cur = null;
    }
  }
  for (const f of files) {
    const total = f.chunks.reduce((n, c) => n + c.length, 0);
    f.data = new Uint8Array(total);
    let o = 0;
    for (const c of f.chunks) { f.data.set(c, o); o += c.length; }
    delete f.chunks;
    f.typeName = ['BASIC', 'DATA', 'BINARY'][f.fileType] || 'TYPE ' + f.fileType;
  }
  return files;
}

function looksLikeBasicText(b) {
  if (b.length === 0 || b.length > 200000) return false;
  let printable = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 10 || c === 13 || c === 9 || (c >= 32 && c < 127)) printable++;
  }
  if (printable / b.length < 0.98) return false;
  const text = new TextDecoder('latin1').decode(b);
  return /^\s*\d+\s*\S/.test(text);
}

// Identify a program file. Returns a descriptor:
// { kind: 'binary'|'cas'|'cart'|'basictext'|'raw', ... }
function identify(name, bytes) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  // a WAV recording of a tape: decoded to .CAS bytes (js/media/cassette.js)
  if (ext === 'wav' || (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45)) {
    let r = null;
    try { r = wavToCas(bytes); } catch (e) { return { kind: 'wav', files: [], bytes, error: e.message }; }
    const files = parseCas(r.bytes);
    return { kind: files.length ? 'cas' : 'wav', files, bytes: r.bytes, wav: { blocks: r.blocks, badBlocks: r.badBlocks, seconds: r.seconds } };
  }
  if (ext === 'cas' || ext === 'c10' || ext === 'k7') { // .c10: MC-10, .k7: Matra Alice (same block format)
    const files = parseCas(bytes);
    if (files.length) return { kind: 'cas', files, bytes };
  }
  // up to 128K: the largest banked cartridge (MAME's banked_16k region)
  if (['rom', 'dgn', 'ccc'].includes(ext) && bytes.length <= 0x20000) return { kind: 'cart', bytes };
  const dd = parseDragonDos(bytes);
  if (dd) return Object.assign({ kind: 'binary' }, dd);
  const decb = parseDecb(bytes);
  if (decb) return Object.assign({ kind: 'binary' }, decb);
  const files = parseCas(bytes);
  if (files.length) return { kind: 'cas', files, bytes };
  if (looksLikeBasicText(bytes)) return { kind: 'basictext', text: new TextDecoder('latin1').decode(bytes) };
  return { kind: 'raw', bytes };
}

export const formats = { parseDragonDos, parseDecb, parseCas, identify, writeDragonDos, writeDecb };
