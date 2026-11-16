/* File formats: DragonDOS .BIN, DECB segmented .BIN, .CAS/.C10/.K7 tape images, WAV tape recordings, cartridges,
   BASIC listings */
import { casBlocks, wavToCas } from './cassette.js';
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

export const formats = { parseDragonDos, parseDecb, parseCas, identify };
