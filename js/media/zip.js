/*
 * ZIP archive reader: stored and DEFLATE entries (RFC 1951 inflate written here, no dependencies), CRC
 * checked. Encrypted entries, zip64 archives and other compression methods are refused with a clear error.
 *
 *   readZip(bytes, limits) -> [{ name, data }]   directories are skipped; throws ZipError. limits: { maxEntry,
 *                                         maxTotal } in unpacked bytes (ZIP_LIMITS by default), checked against the
 *                                         central directory before anything is inflated, so a small archive can't
 *                                         make the page allocate gigabytes
 *   writeZip([{ name, data }]) -> bytes     stored (uncompressed) entries
 */
import { crc32 } from '../util.js';

export class ZipError extends Error {}

// the most a page unpacks from one archive: disk images, tapes and ROM packs are all far smaller
export const ZIP_LIMITS = Object.freeze({ maxEntry: 32 << 20, maxTotal: 64 << 20 });
// DEFLATE expands at most 1032:1 (RFC 1951: a 258-byte match costs at least 2 bits), plus a block header's worth
const maxInflated = (csize) => csize * 1032 + 1024;

// ---------------- inflate (RFC 1951) ----------------
// Huffman table: counts of codes per length and symbols sorted by code
function buildHuffman(lengths) {
  const counts = new Uint16Array(16), symbols = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) { left = (left << 1) - counts[len]; if (left < 0) throw new ZipError('bad DEFLATE data: over-subscribed code'); }
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = { lit: buildHuffman(l), dist: buildHuffman(new Uint8Array(30).fill(5)) };
  }
  return FIXED;
}

// inflate raw DEFLATE data; expectedSize sizes the output buffer (the result must match it exactly)
export function inflate(src, expectedSize) {
  const out = new Uint8Array(expectedSize);
  let op = 0, pos = 0, bitBuf = 0, bitCnt = 0;
  const need = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new ZipError('truncated DEFLATE data');
      bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
    }
  };
  const bits = (n) => { need(n); const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + code - first];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new ZipError('bad DEFLATE data: invalid code');
  };
  const put = (b) => { if (op >= out.length) throw new ZipError('DEFLATE data is longer than the stated size'); out[op++] = b; };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;              // to a byte boundary
      if (pos + 4 > src.length) throw new ZipError('truncated DEFLATE data');
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xFFFF) !== nlen) throw new ZipError('bad DEFLATE data: stored block length check');
      if (pos + len > src.length) throw new ZipError('truncated DEFLATE data');
      if (op + len > out.length) throw new ZipError('DEFLATE data is longer than the stated size');
      out.set(src.subarray(pos, pos + len), op);   // a stored block is a byte range: one copy, not len calls
      op += len; pos += len;
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) ({ lit, dist } = fixedTables());
      else {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        const clh = buildHuffman(cl);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clh);
          if (sym < 16) { lengths[i++] = sym; continue; }
          let rep, val = 0;
          if (sym === 16) { if (!i) throw new ZipError('bad DEFLATE data: repeat with no previous length'); val = lengths[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > lengths.length) throw new ZipError('bad DEFLATE data: too many code lengths');
          lengths.fill(val, i, i + rep); i += rep;
        }
        if (!lengths[256]) throw new ZipError('bad DEFLATE data: no end-of-block code');
        lit = buildHuffman(lengths.subarray(0, hlit));
        dist = buildHuffman(lengths.subarray(hlit));
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) { put(sym); continue; }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= 29) throw new ZipError('bad DEFLATE data: invalid length code');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw new ZipError('bad DEFLATE data: invalid distance code');
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > op) throw new ZipError('bad DEFLATE data: distance before the start');
        if (op + len > out.length) throw new ZipError('DEFLATE data is longer than the stated size');
        // A match's source may overlap what it is writing (a run repeating its own bytes). Copy the part that
        // does not overlap in one go, then double the copied length each time: the bytes just written are a valid
        // source for the next chunk, so a run of n bytes costs O(log n) copies rather than one a byte.
        const first = Math.min(len, d);
        out.copyWithin(op, op - d, op - d + first);
        let done = first;
        while (done < len) { const n = Math.min(len - done, done); out.copyWithin(op + done, op, op + n); done += n; }
        op += len;
      }
    } else throw new ZipError('bad DEFLATE data: reserved block type');
  } while (!last);
  if (op !== out.length) throw new ZipError('DEFLATE data is shorter than the stated size');
  return out;
}

// ---------------- archive ----------------
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function isZip(bytes) { return bytes.length >= 4 && u32(bytes, 0) === 0x04034B50 || (bytes.length >= 22 && u32(bytes, 0) === 0x06054B50); }

export function readZip(bytes, { maxEntry = ZIP_LIMITS.maxEntry, maxTotal = ZIP_LIMITS.maxTotal } = {}) {
  // end of central directory: the last signature within the final 64K + 22 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
    if (u32(bytes, i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a ZIP archive, or truncated (no end of central directory)');
  if (eocd >= 20 && u32(bytes, eocd - 20) === 0x07064B50) throw new ZipError('zip64 archives are not supported');
  const count = u16(bytes, eocd + 10), cdSize = u32(bytes, eocd + 12), cdOff = u32(bytes, eocd + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new ZipError('zip64 archives are not supported');
  if (cdOff + cdSize > eocd) throw new ZipError('truncated ZIP archive (central directory out of range)');
  const out = [];
  let p = cdOff, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014B50) throw new ZipError('corrupt ZIP central directory');
    const flags = u16(bytes, p + 8), method = u16(bytes, p + 10), crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20), usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;                                   // directory
    if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || local === 0xFFFFFFFF) throw new ZipError('zip64 archives are not supported');
    if (flags & 0x41) throw new ZipError(`${name}: encrypted ZIP entries are not supported`);
    if (usize > maxEntry) throw new ZipError(`${name}: ${usize} bytes unpacked, more than this page takes (${maxEntry})`);
    total += usize;
    if (total > maxTotal) throw new ZipError(`this archive holds more than ${maxTotal} bytes unpacked in all`);
    if (method === 8 && usize > maxInflated(csize)) throw new ZipError(`${name}: corrupt ZIP (stated size ${usize} bytes from ${csize} compressed)`);
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034B50) throw new ZipError(`${name}: truncated ZIP archive (local header missing)`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + csize > bytes.length) throw new ZipError(`${name}: truncated ZIP archive (data cut short)`);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) {
      if (csize !== usize) throw new ZipError(`${name}: stored entry sizes differ`);
      data = raw.slice();
    } else if (method === 8) {
      try { data = inflate(raw, usize); } catch (e) { throw new ZipError(`${name}: ${e.message}`); }
    } else throw new ZipError(`${name}: compression method ${method} is not supported (only stored and DEFLATE)`);
    if (crc32(data) !== crc.toString(16).toUpperCase().padStart(8, '0')) throw new ZipError(`${name}: CRC mismatch (corrupt archive)`);
    out.push({ name, data });
  }
  return out;
}

// a ZIP archive of stored entries (no compression: ROM images barely compress, and it keeps this small)
export function writeZip(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const le = (n, v) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (v >>> (8 * i)) & 0xFF; return b; };
  const cat = (arrs) => { const out = new Uint8Array(arrs.reduce((t, a) => t + a.length, 0)); let p = 0; for (const a of arrs) { out.set(a, p); p += a.length; } return out; };
  for (const { name, data } of entries) {
    const n = enc.encode(name), crc = parseInt(crc32(data), 16);
    const common = [le(2, 0), le(2, 0), le(2, 0), le(2, 0), le(4, crc), le(4, data.length), le(4, data.length), le(2, n.length), le(2, 0)];
    const local = cat([le(4, 0x04034B50), le(2, 20), ...common, n]);
    central.push(cat([le(4, 0x02014B50), le(2, 20), le(2, 20), ...common, le(2, 0), le(2, 0), le(2, 0), le(4, 0), le(4, off), n]));
    parts.push(local, data);
    off += local.length + data.length;
  }
  const cd = cat(central);
  return cat([...parts, cd, le(4, 0x06054B50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length), le(4, cd.length), le(4, off), le(2, 0)]);
}
