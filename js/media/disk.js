/*
 * Floppy disk images: VDK, JVC (.dsk) and DMK, to and from the flux-level track model the drive uses.
 *
 * The drive (js/chips/floppy.js) works the way MAME's floppy_image_device does: each track is a list of
 * flux transitions at angular positions (200,000,000 per revolution; one unit is 1 ns at 300 rpm). The
 * conversions here are ports of MAME 0.264's src/lib/formats (flopimg.cpp, vdk_dsk.cpp, jvc_dsk.cpp,
 * dmk_dsk.cpp) so that a disk read through our controller has its bits at exactly the times MAME's has
 * them, and an image written back from the flux is byte for byte what MAME writes:
 *   load: sectors -> MFM cells (build_pc_track_mfm: gap 1 = 32, gap 2 = 24, gap 3 = 22 bytes of 0x4E,
 *         100,000 cells per track) -> flux (generate_track_from_levels)
 *   save: flux -> bit cells through MAME's software PLL (generate_bitstream_from_track) -> sectors
 *         (extract_sectors_from_bitstream_mfm_pc) -> file
 * MAME cannot save DMK; our DMK writer follows the DMK format as published by David Keil (header, IDAM
 * pointer table, raw track bytes) and is checked against images built by hand in tests/disk.test.js.
 *
 * Everything here is a pure function of its arguments (bytes in, structures or bytes out).
 *
 *   detectDiskFormat(bytes, name)         'vdk' | 'jvc' | 'dmk' | null
 *   loadDisk(bytes, format, drive, geom?) FloppyImage (drive = { tracks, heads }: the drive's maxima;
 *                                         geom = the geometry to use instead of reading it from the bytes, as a
 *                                         restored drive does for an OS-9 disk whose LSN 0 the guest rewrote)
 *   saveDisk(image, format, options)      Uint8Array (options.trackLength for DMK; options.geometry, the
 *                                         geometry as mounted, which keeps an OS-9 save headerless)
 *   readTrackSectors(image, track, head)  [{ track, head, sector, size, data, deleted }] in disk order
 *   diskGeometry(bytes, format)           { tracks, heads, sectors, sectorSize, firstSector, headerSize }
 *                                         ... plus os9: true when a headerless dump states its own geometry in
 *                                         OS-9's LSN 0 (os9_dsk.cpp); the drive then uses OS-9's track layout
 */

export class DiskFormatError extends Error {
  constructor(message) { super(message); this.name = 'DiskFormatError'; }
}

// floppy_image magnetic orientation codes (flopimg.h): flux change, neutral, damaged, end of neutral; and the
// level codes the format builders use for cells (0 and 1)
export const MG_F = 0, MG_N = 1, MG_D = 2, MG_E = 3;
const MG_0 = 4, MG_1 = 5;
export const TIME_MASK = 0x0fffffff;
export const mgType = (v) => v >>> 28;
export const mgTime = (v) => v & TIME_MASK;
export const mg = (type, time) => type * 0x10000000 + time;
export const REVOLUTION = 200000000;

// A disk as the drive sees it: per track and head, the flux transitions (MAME's cell_data). Track k is track
// (k / heads), head (k % heads). A loader does not build the flux up front: it leaves a builder for each track
// (lazy()), and track(k) runs it the first time that track is asked for, so a mount costs the tracks the guest
// reaches rather than every track on the disk. A builder reads only what the loader handed it (its own copy of the
// image bytes), so when a track is built makes no difference to the flux it gets.
export class FloppyImage {
  #cells;
  constructor(tracks, heads) {
    this.tracks = tracks;
    this.heads = heads;
    this.#cells = [];
    for (let i = 0; i < tracks * heads; i++) this.#cells.push([]);
  }
  get count() { return this.#cells.length; }
  #index(k) {
    if (!Number.isInteger(k) || k < 0 || k >= this.#cells.length) throw new DiskFormatError(`no track index ${k} on this drive`);
    return k;
  }
  // the flux of track index k, built now if it has not been yet; the drive writes into the array it returns
  track(k) {
    let c = this.#cells[this.#index(k)];
    if (typeof c === 'function') { c = c(); this.#cells[k] = c; }
    return c;
  }
  setTrack(k, flux) { this.#cells[this.#index(k)] = flux; }
  // track index k is built by build() when it is first read
  lazy(k, build) { this.#cells[this.#index(k)] = build; }
  buffer(track, head) {
    if (track < 0 || track >= this.tracks || head < 0 || head >= this.heads) throw new DiskFormatError(`no track ${track} side ${head} on this drive`);
    return this.track(track * this.heads + head);
  }
  // floppy_image::get_actual_geometry: the highest track and head that hold anything (building what it looks at)
  actualGeometry() {
    let maxt = this.tracks - 1;
    for (; maxt >= 0; maxt--) {
      let any = false;
      for (let h = 0; h < this.heads; h++) if (this.track(maxt * this.heads + h).length) { any = true; break; }
      if (any) break;
    }
    let maxh = -1;
    if (maxt >= 0) {
      for (maxh = this.heads - 1; maxh >= 0; maxh--) {
        let any = false;
        for (let t = 0; t <= maxt; t++) if (this.track(t * this.heads + maxh).length) { any = true; break; }
        if (any) break;
      }
    }
    return { tracks: maxt + 1, heads: maxh + 1 };
  }
}

// ---------------------------------------------------------------- cell level buffers (flopimg.cpp)
// The cells a track builder writes (MAME's std::vector<uint32_t> of level codes), in a Uint32Array that doubles when
// full, so building a track allocates a handful of buffers instead of one array slot per cell. A cell is
// mg(MG_0 or MG_1, size): at most 5 * 2^28 + 2^28 - 1 < 2^32, so it fits a Uint32 exactly.
export class CellBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`cell buffer capacity ${capacity}`);
    this.cells = new Uint32Array(capacity);
    this.length = 0;
  }
  push(v) {
    if (this.length === this.cells.length) {
      const grown = new Uint32Array(this.cells.length * 2);
      grown.set(this.cells);
      this.cells = grown;
    }
    this.cells[this.length++] = v;
  }
}
const bitR = (buf, off) => mgType(buf.cells[off]) === MG_1;
function bitW(buf, val, size) { buf.push(mg(val ? MG_1 : MG_0, size)); }
function rawW(buf, n, val, size = 1000) { for (let i = n - 1; i >= 0; i--) bitW(buf, (val >>> i) & 1, size); }
function mfmW(buf, n, val, size = 1000) {
  let prec = buf.length ? (bitR(buf, buf.length - 1) ? 1 : 0) : 0;
  for (let i = n - 1; i >= 0; i--) {
    const bit = (val >>> i) & 1;
    bitW(buf, !(prec || bit), size);
    bitW(buf, bit, size);
    prec = bit;
  }
}
function calcCrcCcitt(buf, start, end) {
  let res = 0xffff;
  const size = end - start;
  for (let i = 1; i < size; i += 2) {
    res <<= 1;
    if (bitR(buf, start + i)) res ^= 0x10000;
    if (res & 0x10000) res ^= 0x11021;
  }
  return res & 0xffff;
}
// floor(REVOLUTION * t / total) in Numbers, exactly (MAME computes it in 64-bit integers). REVOLUTION * t itself can
// pass 2^53 (t < 2^28 and REVOLUTION < 2^28), so t is split as th * 2^16 + tl and the division done in two steps:
// with q = floor(REVOLUTION * th / total) and r its remainder,
//   REVOLUTION * t / total = q * 2^16 + (r * 2^16 + REVOLUTION * tl) / total.
// Every value formed is an integer below 2^53, which a Number holds exactly; % of two such integers is exact, and so
// is (x - x % total) / total, a division with no remainder. The bounds: th < 2^12, so REVOLUTION * th < 2^40;
// r < total < 2^36, so r * 2^16 < 2^52; REVOLUTION * tl < 2^44, so r * 2^16 + REVOLUTION * tl < 2^53; and the
// result is at most REVOLUTION (t <= total). total < 2^36 holds for every track, and levelsToFlux checks it: a
// WD track is 100,000 cells of 1000 units; the longest DMK track, 0x3FFF bytes, is under 16,383 steps of at most
// 128 cells (a 48-cell IAM, a 48-cell mark, a 32-cell FM byte) plus at most 4 * 16,383 MFM pad bytes of 16 cells,
// under 3.2 million cells of 1000 units, so total < 2^32.
const SPLIT = 0x10000;
export function fluxPosition(t, total) {
  const th = Math.floor(t / SPLIT), tl = t - th * SPLIT;
  const a = REVOLUTION * th, r = a % total, q = (a - r) / total;
  const b = r * SPLIT + REVOLUTION * tl, r2 = b % total;
  return q * SPLIT + (b - r2) / total;
}
// normalize_times + generate_track_from_levels: cells (a CellBuffer) -> flux positions over one revolution
function levelsToFlux(levels) {
  const dest = [];
  const cells = levels.cells, n = levels.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const e = cells[i], bit = mgType(e), t = mgTime(e);
    if (bit === MG_1) dest.push(mg(MG_F, total + (t >> 1)));
    else if (bit !== MG_0) dest.push(mg(bit, total));
    total += t;
  }
  if (total >= 2 ** 36) throw new RangeError(`a track of ${total} time units is beyond the exact flux arithmetic`);
  for (let i = 0; i < dest.length; i++) {
    const t = mgTime(dest[i]);
    const pos = total === REVOLUTION / 2 ? t * 2 : fluxPosition(t, total);
    dest[i] = mg(mgType(dest[i]), pos);
  }
  return dest;
}

// the cell where the last sector of a build_wd_track_mfm track ends; a layout past cellCount cannot be built (loadDisk
// checks this at load, before any track is built)
function wdTrackEnd(cellCount, count, totalSize, gap1, gap2) {
  const etpos = gap1 * 16 + (count * (12 + 3 + 5 + 2 + gap2 + 12 + 3 + 1 + 2) + totalSize) * 16;
  if (etpos > cellCount) throw new DiskFormatError(`track layout too long (${etpos} cells, ${cellCount} available)`);
  return etpos;
}
// build_pc_track_mfm with gap 4a = -1 (build_wd_track_mfm). sects: [{ track, head, sector, size, data, deleted, badCrc }]
function buildWdTrackMfm(cellCount, sects, gap3, gap1, gap2) {
  const td = new CellBuffer(cellCount);   // the track ends at exactly cellCount cells
  for (let i = 0; i < gap1; i++) mfmW(td, 8, 0x4e);
  let totalSize = 0;
  for (const s of sects) totalSize += s.data ? s.data.length : (128 << s.size);
  const etpos = wdTrackEnd(cellCount, sects.length, totalSize, gap1, gap2);
  if (etpos + gap3 * 16 * (sects.length - 1) > cellCount) gap3 = Math.floor((cellCount - etpos) / 16 / (sects.length - 1));
  for (let i = 0; i < sects.length; i++) {
    const s = sects[i];
    for (let j = 0; j < 12; j++) mfmW(td, 8, 0x00);
    let cpos = td.length;
    for (let j = 0; j < 3; j++) rawW(td, 16, 0x4489);
    mfmW(td, 8, 0xfe);
    mfmW(td, 8, s.track); mfmW(td, 8, s.head); mfmW(td, 8, s.sector); mfmW(td, 8, s.size);
    mfmW(td, 16, calcCrcCcitt(td, cpos, td.length));
    for (let j = 0; j < gap2; j++) mfmW(td, 8, 0x4e);
    for (let j = 0; j < 12; j++) mfmW(td, 8, 0x00);
    cpos = td.length;
    for (let j = 0; j < 3; j++) rawW(td, 16, 0x4489);
    mfmW(td, 8, s.deleted ? 0xf8 : 0xfb);
    for (let j = 0; j < s.data.length; j++) mfmW(td, 8, s.data[j]);
    let crc = calcCrcCcitt(td, cpos, td.length);
    if (s.badCrc) crc ^= 0xffff;
    mfmW(td, 16, crc);
    if (i !== sects.length - 1) for (let j = 0; j < gap3; j++) mfmW(td, 8, 0x4e);
  }
  while (td.length < cellCount - 15) mfmW(td, 8, 0x4e);
  rawW(td, cellCount - td.length, 0x9254 >>> (16 + td.length - cellCount));
  return levelsToFlux(td);
}

// ---------------------------------------------------------------- flux -> bits -> sectors (flopimg.cpp)
// generate_bitstream_from_track: MAME's software PLL over one revolution, starting at the index
export function fluxToBits(tbuf, cellSize) {
  let hasInfo = false;
  for (const v of tbuf) if (mgType(v) === MG_F) { hasInfo = true; break; }
  if (!hasInfo) return new Uint8Array(Math.floor(REVOLUTION / cellSize));
  let period = cellSize;
  const periodAdjustBase = Math.trunc(period * 0.05);
  const minPeriod = Math.trunc(cellSize * 0.75), maxPeriod = Math.trunc(cellSize * 1.25);
  let phaseAdjust = 0, freqHist = 0, curEntry = tbuf.length - 1, curPos, nextIsFirst = false;
  let fluxToStep = 16;
  while (curEntry > 0 && fluxToStep) {
    if (mgType(tbuf[curEntry]) === MG_F) fluxToStep--;
    curEntry--;
  }
  curPos = mgTime(tbuf[curEntry]) - (period >> 1);
  while (curEntry > 0 && curPos > mgTime(tbuf[curEntry])) curEntry--;
  while (mgType(tbuf[curEntry]) !== MG_F) curEntry++;
  const get = () => {
    let bit, first;
    let edge = mgTime(tbuf[curEntry]);
    if (edge < curPos) edge += REVOLUTION;
    const next = curPos + period + phaseAdjust;
    if (edge >= next) { bit = false; phaseAdjust = 0; }
    else {
      bit = true;
      const delta = edge - (next - Math.trunc(period / 2));
      phaseAdjust = Math.trunc(0.65 * delta);
      if (delta < 0) freqHist = freqHist < 0 ? freqHist - 1 : -1;
      else if (delta > 0) freqHist = freqHist > 0 ? freqHist + 1 : 1;
      else freqHist = 0;
      if (freqHist) {
        const afh = freqHist < 0 ? -freqHist : freqHist;
        if (afh > 1) {
          let aper = Math.trunc(periodAdjustBase * delta / period);
          if (!aper) aper = freqHist < 0 ? -1 : 1;
          period += aper;
          if (period < minPeriod) period = minPeriod; else if (period > maxPeriod) period = maxPeriod;
        }
      }
    }
    first = nextIsFirst;
    nextIsFirst = false;
    curPos = next;
    if (curPos >= REVOLUTION) {
      curPos -= REVOLUTION;
      curEntry = 0;
      if (curPos >= Math.trunc(period / 2)) first = true; else nextIsFirst = true;
    }
    while (curEntry < tbuf.length - 1 && mgTime(tbuf[curEntry]) < curPos) curEntry++;
    if (curEntry === tbuf.length - 1 && mgTime(tbuf[curEntry]) < curPos) curEntry = 0;
    return [bit, first];
  };
  const bits = [];
  for (;;) { const r = get(); if (r[1]) { bits.push(r[0] ? 1 : 0); break; } }
  for (;;) { const r = get(); if (r[1]) break; bits.push(r[0] ? 1 : 0); }
  return Uint8Array.from(bits);
}

// extract_sectors_from_bitstream_mfm_pc, keeping the ID fields as well. MAME reads a bit and then
// advances; posRef.p here is the index of the next bit to read, so each read is bits[p] then p + 1.
function readBit(bits, posRef) { const b = bits[posRef.p]; posRef.p = posRef.p + 1 === bits.length ? 0 : posRef.p + 1; return b; }
function readMfmByte(bits, posRef) {
  let res = 0;
  for (let i = 0; i < 8; i++) { readBit(bits, posRef); if (readBit(bits, posRef)) res |= 0x80 >> i; }
  return res;
}
export function bitsToSectors(bits) {
  const out = [];
  if (bits.length < 100) return out;
  const idblk = [], dblk = [];
  let shift = 0;
  for (let i = 0; i < 16; i++) if (bits[bits.length - 16 + i]) shift |= 0x8000 >> i;
  for (let i = 0; i < bits.length; i++) {
    shift = ((shift << 1) | bits[i]) & 0xffff;
    if (shift === 0x4489) {
      let header;
      const pr = { p: i + 1 === bits.length ? 0 : i + 1 };
      do {
        header = 0;
        for (let j = 0; j < 16; j++) if (readBit(bits, pr)) header |= 0x8000 >> j;
      } while (header === 0x4489 && pr.p > i);
      if (header === 0x5554 || header === 0x5555) { if (idblk.length < 100) idblk.push(pr.p); i = pr.p - 1; }
      if (header === 0x554a || header === 0x5549 || header === 0x5544 || header === 0x5545) {
        if (dblk.length < 100) dblk.push({ pos: pr.p, mark: header === 0x554a ? 0xf8 : header === 0x5549 ? 0xf9 : header === 0x5544 ? 0xfa : 0xfb });
        i = pr.p - 1;
      }
    }
  }
  for (const id of idblk) {
    const pr = { p: id };
    const track = readMfmByte(bits, pr), head = readMfmByte(bits, pr), sector = readMfmByte(bits, pr), size = readMfmByte(bits, pr);
    if (size >= 8) continue;
    const ssize = 128 << size;
    const d = dblk.find((b) => { const delta = b.pos - id; return delta >= 704 - 128 && delta <= 1008 + 128; });
    if (!d) continue;
    const dp = { p: d.pos };
    const data = new Uint8Array(ssize);
    for (let j = 0; j < ssize; j++) data[j] = readMfmByte(bits, dp);
    out.push({ track, head, sector, size, data, deleted: d.mark === 0xf8 || d.mark === 0xf9 });
  }
  return out;
}
export function readTrackSectors(image, track, head) {
  return bitsToSectors(fluxToBits(image.buffer(track, head), 2000));
}
// MAME's save: the sector numbered `id` is the last one with that number found on the track
function sectorById(sectors, id) {
  let found = null;
  for (const s of sectors) if (s.sector === id) found = s;
  return found;
}

// ---------------------------------------------------------------- detection and geometry
const u16le = (b, o) => b[o] | (b[o + 1] << 8);

// ---------------------------------------------------------------- OS-9 (os9_dsk.cpp)
// A NitrOS-9 .dsk is a headerless sector dump whose LSN 0 states its own geometry. MAME identifies it as OS9 and
// scores that above JVC (floppy.cpp:595-605), so a real OS-9 disk gets its sides right; we make the same decision
// inside our JVC branch, because the format name is what the drive mounts, saves and snapshots. Fields, from
// defs/rbf.d's LSN0 block: DD.TOT $00 (3 bytes, big-endian), DD.FMT $10 (bit 0 = FMT.SIDE, double sided),
// DD.SPT $11 (2 bytes, big-endian), DD.OPT $3F (32 bytes, a copy of the device descriptor).
const OS9_IDS = [1, 7, 13, 2, 8, 14, 3, 9, 15, 4, 10, 16, 5, 11, 17, 6, 12, 18];   // os9_dsk.cpp:279
const OS9_TRACKS = [35, 40, 80];   // the track counts os9_format has for 18 x 256 MFM (os9_dsk.cpp:262-300)
const OS9_GAPS = [18, 28, 20];     // os9_dsk.cpp:279, against JVC's 22, 32, 24 (jvc_dsk.cpp:253)

// os9_format::find_size for the formats a CoCo or Dragon FDC can take (18 sectors of 256 bytes, MFM, 35/40/80
// tracks, one or two heads); anything else returns null and the caller falls back to plain JVC. Line numbers are
// MAME 0.264's.
function os9Geometry(bytes) {
  const size = bytes.length;
  if (size < 0x60) return null;
  const totalSectors = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];      // :93
  const heads = (bytes[0x10] & 1) ? 2 : 1;                                 // :94
  const sectors = (bytes[0x11] << 8) | bytes[0x12];                        // :95
  if (totalSectors <= 0 || sectors <= 0) return null;                      // :97 (heads is never 0 here)
  if (sectors !== 18) return null;    // our track builder is MFM; the 10 and 16 sector OS-9 entries are not ours
  // the optional descriptor (:103-121), which MAME requires to describe a COCO disk before it will take one of
  // the 18 x 256 entries: those have sector base ID 1, and the non-COCO branch (:210-220) wants base ID 0
  const dtype = bytes[0x3f], type = bytes[0x3f + 3], density = bytes[0x3f + 4];
  const cylinders = (bytes[0x3f + 5] << 8) | bytes[0x3f + 6];
  const sides = bytes[0x3f + 7];
  const perTrack = (bytes[0x3f + 9] << 8) | bytes[0x3f + 10];
  const track0 = (bytes[0x3f + 11] << 8) | bytes[0x3f + 12];
  const interleave = bytes[0x3f + 13];
  let coco = (type & 0x20) !== 0;                                          // :118
  if (density & 0x80) coco = true;                                         // :125
  if (dtype !== 1) coco = false;                                           // :128-129
  if (!coco) return null;
  const sectorBaseId = (type & 2) ? 0 : 1;                                 // :116
  const sectorSize = (type & 4) ? 512 : 256;                               // :117
  for (const tracks of OS9_TRACKS) {
    if (tracks * heads * sectors * 256 !== size) continue;                 // :148
    if (size < totalSectors * 256) continue;                               // :151
    if (size > (totalSectors + sectors - 10) * 256) continue;              // :160
    if (sectorBaseId !== 1) continue;                                      // :169
    if (!(density & 1)) continue;                                          // :180 (we build MFM tracks)
    if (tracks > cylinders || heads > sides) continue;                      // :185, :190
    if (sectors > perTrack || sectors > track0) continue;                  // :194-198
    if (sectorSize !== 256) continue;                                      // :201
    if (interleave > sectors) continue;                                    // :206
    return { tracks, heads, sectors, sectorSize: 256, firstSector: 1, headerSize: 0, writeProtected: false, os9: true };
  }
  return null;
}

export function diskGeometry(bytes, format) {
  const size = bytes.length;
  if (format === 'vdk') {
    if (size < 12 || bytes[0] !== 0x64 || bytes[1] !== 0x6b) throw new DiskFormatError('not a VDK image (no "dk" signature)');
    const headerSize = u16le(bytes, 2);
    if (headerSize < 12) throw new DiskFormatError(`VDK header size ${headerSize} is too small`);
    const tracks = bytes[8], heads = bytes[9];
    if (!tracks || heads < 1 || heads > 2) throw new DiskFormatError(`VDK geometry ${tracks} tracks, ${heads} sides is not valid`);
    const need = headerSize + tracks * heads * 18 * 256;
    if (size < need) throw new DiskFormatError(`VDK image is ${size} bytes; its header needs ${need}`);
    return { tracks, heads, sectors: 18, sectorSize: 256, firstSector: 1, headerSize, writeProtected: !!(bytes[10] & 1) };
  }
  if (format === 'jvc') {
    if (!size) throw new DiskFormatError('empty image');
    const headerSize = size % 256;
    if (headerSize >= 5) throw new DiskFormatError(`JVC header of ${headerSize} bytes is not supported (sector attributes)`);
    // A headerless dump may be a NitrOS-9/OS-9 disk that states its own geometry in LSN 0. No guard is needed
    // against a file that has a JVC header: one whole track is 18 x 256 = 4608 bytes, a multiple of 256, so a file
    // with a 1-4 byte header has a size that no number of whole tracks can equal, and os9Geometry's size test
    // rejects it. A header therefore always wins, structurally rather than by a special case.
    { const os9 = os9Geometry(bytes); if (os9) return os9; }
    let heads = 1, sectors = 18, sectorSize = 256, firstSector = 1;
    if (headerSize >= 1) sectors = bytes[0];
    if (headerSize >= 2) heads = bytes[1];
    if (headerSize >= 3) sectorSize = 128 << bytes[2];
    if (headerSize >= 4) firstSector = bytes[3];
    if (!sectors || heads < 1 || heads > 2 || (headerSize >= 3 && bytes[2] > 3)) throw new DiskFormatError('JVC header geometry is not valid');
    if (sectors * sectorSize > 10000) throw new DiskFormatError('JVC track layout too long');
    const tracks = Math.floor((size - headerSize) / sectorSize / sectors / heads);
    if (tracks > 82) throw new DiskFormatError(`JVC image has ${tracks} tracks (at most 82)`);
    if (!tracks || tracks * heads * sectors * sectorSize !== size - headerSize) throw new DiskFormatError(`JVC image size ${size} does not match its geometry`);
    return { tracks, heads, sectors, sectorSize, firstSector, headerSize, writeProtected: false };
  }
  if (format === 'dmk') {
    if (size < 16) throw new DiskFormatError('DMK image shorter than its header');
    if (bytes[0] !== 0x00 && bytes[0] !== 0xff) throw new DiskFormatError('DMK write-protect byte must be 00 or FF');
    const trackLength = u16le(bytes, 2);
    if (trackLength < 0x80 || trackLength > 0x3fff) throw new DiskFormatError(`DMK track length ${trackLength} out of range`);
    const heads = bytes[4] & 0x10 ? 1 : 2;
    const tracks = Math.floor((size - 16) / (heads * trackLength));
    if (!tracks) throw new DiskFormatError('DMK image holds no complete track');
    return { tracks, heads, trackLength, singleDensity: !!(bytes[4] & 0x40), headerTracks: bytes[1], writeProtected: bytes[0] === 0xff, headerSize: 16 };
  }
  throw new DiskFormatError(`unknown disk format ${format}`);
}

// the format of a disk image: 'vdk', 'jvc', 'dmk' or null. A VDK is known by its "dk" signature whatever the file is
// called (VDKs are often named .dsk); .dsk and .os9 are JVC (a raw sector dump with an optional short header) or DMK.
// js/media/detect.js detectMedia reports this same answer.
export function detectDiskFormat(bytes, name = '') {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  if (e !== 'dmk' && bytes.length >= 2 && bytes[0] === 0x64 && bytes[1] === 0x6b) return 'vdk';
  if (e === 'vdk') return null;
  if (e === 'dmk') return 'dmk';
  if (e === 'jvc' || e === 'dsk' || e === 'os9' || e === '') {
    try { diskGeometry(bytes, 'jvc'); return 'jvc'; } catch (err) { /* not JVC */ }
    if (e !== 'jvc') { try { diskGeometry(bytes, 'dmk'); return 'dmk'; } catch (err) { /* not DMK */ } }
  }
  return null;
}

// ---------------------------------------------------------------- load
const JVC_INTERLEAVE = [0, 11, 4, 15, 8, 1, 12, 5, 16, 9, 2, 13, 6, 17, 10, 3, 14, 7];
const sizeCode = (n) => Math.log2(n / 128);
const TRACK_CELLS = 100000;   // a 2 us cell at 300 rpm

// An OS-9 image's geometry is read from its own first sector (os9Geometry), which a snapshot cannot re-derive once
// the guest has written LSN 0: the drive passes the geometry it mounted with as `geometry` on restore.
// Every check that can reject the image runs here; the tracks themselves are built on first use (FloppyImage.lazy),
// from a copy of the bytes taken now, so the caller may change `bytes` afterwards (the drive's flush() does).
export function loadDisk(bytes, format, drive, geometry = null) {
  const g = geometry || diskGeometry(bytes, format);
  const src = bytes.slice();
  if (format === 'dmk') return loadDmk(src, g, drive);
  if (g.tracks > drive.tracks) throw new DiskFormatError(`the image has ${g.tracks} tracks; the drive has ${drive.tracks}`);
  if (g.heads > drive.heads) throw new DiskFormatError(`the image has ${g.heads} sides; the drive has ${drive.heads}`);
  const [gap3, gap1, gap2] = g.os9 ? [OS9_GAPS[2], OS9_GAPS[0], OS9_GAPS[1]] : [22, 32, 24];
  if (g.tracks && g.heads) wdTrackEnd(TRACK_CELLS, g.sectors, g.sectors * g.sectorSize, gap1, gap2);   // every track has this layout
  const image = new FloppyImage(drive.tracks, drive.heads);
  let off = g.headerSize;
  for (let t = 0; t < g.tracks; t++) {
    for (let h = 0; h < g.heads; h++) {
      const trackBase = off;
      off += g.sectors * g.sectorSize;
      image.lazy(t * drive.heads + h, () => buildSectorTrack(src, format, g, t, h, trackBase, gap3, gap1, gap2));
    }
  }
  return image;
}
// one track of a VDK or JVC (or OS-9) image, whose sectors start at trackBase in bytes
function buildSectorTrack(bytes, format, g, t, h, trackBase, gap3, gap1, gap2) {
  const sects = new Array(g.sectors);
  const size = format === 'vdk' ? 1 : sizeCode(g.sectorSize);
  for (let i = 0; i < g.sectors; i++) {
    const data = (k) => bytes.slice(trackBase + k * g.sectorSize, trackBase + (k + 1) * g.sectorSize);
    const s = (sector, slot, k) => { sects[slot] = { track: t, head: h, sector, size, data: data(k), deleted: false, badCrc: false }; };
    if (g.os9) {
      // os9_dsk.cpp:279 with wd177x_dsk.cpp:92-101: track position i holds sector per_sector_id[i], and that
      // sector's bytes are the (id-1)-th slot of the track in the file, because build_sector_description
      // offsets each sector's data by how many sector IDs sort before it
      s(OS9_IDS[i], i, OS9_IDS[i] - 1);
    } else if (format === 'jvc' && g.sectors === 18) {
      // jvc_dsk.cpp:235-251: file offset i holds sector (1 + i), placed at track position interleave[i]
      s(g.firstSector + i, JVC_INTERLEAVE[i], i);
    } else {
      s(g.firstSector + i, i, i);
    }
  }
  // build_wd_track_mfm(cell_count, sector_count, sects, gap_3, gap_1, gap_2): OS-9's gaps are 20/18/28, JVC's 22/32/24
  return buildWdTrackMfm(TRACK_CELLS, sects, gap3, gap1, gap2);
}

// dmk_dsk.cpp load (MFM and FM tracks)
function wideFm(val) {
  let res = 0;
  for (let i = 15; i >= 0; i--) if ((val >> i) & 1) res += 2 ** (i * 2 + 1);
  return res;
}
function dataToWideFm(val) {
  let res = 0xaaaa;
  for (let i = 7; i >= 0; i--) res |= ((val >> i) & 1) << (i * 2);
  return wideFm(res);
}
function loadDmk(bytes, g, drive) {
  if (g.tracks > drive.tracks) throw new DiskFormatError(`the image has ${g.tracks} tracks; the drive has ${drive.tracks}`);
  if (g.heads > drive.heads) throw new DiskFormatError(`the image has ${g.heads} sides; the drive has ${drive.heads}`);
  const image = new FloppyImage(drive.tracks, drive.heads);
  const { trackLength: tsize, heads } = g;
  for (let track = 0; track < g.tracks; track++) {
    for (let head = 0; head < heads; head++) {
      const base = 16 + (heads * track + head) * tsize;
      const td = bytes.subarray(base, base + tsize);
      // identify() checks: every IDAM pointer inside the track and at an FE byte
      for (let k = 0; k < 64; k++) {
        const e = u16le(td, 2 * k);
        if (!e) continue;
        const o = e & 0x3fff;
        if (o >= tsize || td[o] !== 0xfe) throw new DiskFormatError(`DMK track ${track} side ${head}: IDAM pointer ${k} does not point at an ID mark`);
      }
      image.lazy(track * drive.heads + head, () => buildDmkTrack(td, tsize, g.singleDensity));
    }
  }
  return image;
}
// one DMK track (td: its bytes, IDAM table first) as flux
function buildDmkTrack(td, tsize, isSd) {
  const fmStride = isSd ? 1 : 2;
  let fmLoss = 0;
  const raw = new CellBuffer(tsize * 16);   // a double-density track's data bytes; marks and FM grow it
  const markLocation = new Array(129).fill(-1), markValue = new Array(129).fill(0xfe), markIsMfm = new Array(129).fill(!isSd);
  let iamLocation = -1, markCount = 0;
  let tho = 0;
  let trackOffset = u16le(td, tho) & 0x3fff;
  let idamIsMfm = !!(td[tho + 1] & 0x80);
  tho += 2;
  while (trackOffset !== 0 && trackOffset >= 0x83 && trackOffset < tsize && tho < 0x80) {
    const markOffset = idamIsMfm ? 3 : 0;
    markLocation[markCount] = trackOffset - markOffset; markValue[markCount] = 0xfe; markIsMfm[markCount] = idamIsMfm; markCount++;
    const stride = idamIsMfm ? 1 : fmStride;
    for (let i = trackOffset + 10 * stride; i < trackOffset + 53 * stride; i++) {
      if (td[i] >= 0xf8 && td[i] <= 0xfb) {
        if (!idamIsMfm || u16le(td, i - 2) === 0xa1a1) {
          markLocation[markCount] = i - markOffset; markValue[markCount] = td[i]; markIsMfm[markCount] = idamIsMfm; markCount++;
          break;
        }
      }
    }
    idamIsMfm = !!(td[tho + 1] & 0x80);
    trackOffset = u16le(td, tho) & 0x3fff;
    tho += 2;
  }
  if (markCount > 0) markIsMfm[markCount] = markIsMfm[markCount - 1];
  for (let i = markLocation[0] - 1; i >= 3; i--) {
    if (td[i] === 0xfc && (isSd || u16le(td, i - 2) === 0xc2c2)) { iamLocation = i - (isSd ? 0 : 3); break; }
  }
  let curMark = 0;
  let encMfm = markIsMfm[curMark];
  for (let offset = 0x80; offset < tsize; offset++) {
    if (offset === iamLocation) {
      if (!isSd) { rawW(raw, 16, 0x5224); rawW(raw, 16, 0x5224); rawW(raw, 16, 0x5224); offset += 3; }
      else { rawW(raw, 32, wideFm(0xf77a)); offset += fmStride; }
    }
    if (offset + 8 >= markLocation[curMark]) {
      const ne = markIsMfm[curMark];
      if (ne !== encMfm) encMfm = ne;
    }
    if (offset === markLocation[curMark] || (!encMfm && offset - fmStride + 1 === markLocation[curMark])) {
      if (encMfm) {
        rawW(raw, 16, 0x4489); rawW(raw, 16, 0x4489); rawW(raw, 16, 0x4489);
        offset += 3;
        if (fmStride === 1) fmLoss += 3;
      } else {
        const mark = { 0xfb: 0xf56f, 0xfa: 0xf56e, 0xf9: 0xf56b, 0xf8: 0xf56a, 0xfe: 0xf57e }[markValue[curMark]] || 0xf56f;
        rawW(raw, 32, wideFm(mark));
        offset += fmStride;
      }
      curMark++;
    }
    if (encMfm) {
      if (fmStride === 1) fmLoss++;
      mfmW(raw, 8, offset < tsize ? td[offset] : 0xff);
    } else rawW(raw, 32, dataToWideFm(offset < tsize ? td[offset] : 0xff));
    if (!encMfm) offset += fmStride - 1;
  }
  if (fmLoss !== 0) {
    if (encMfm) for (let j = 0; j < fmLoss; j++) mfmW(raw, 8, 0x4e);
    else for (let j = 0; j < (fmLoss >> 1); j++) rawW(raw, 32, dataToWideFm(0xff));
  }
  return levelsToFlux(raw);
}

// ---------------------------------------------------------------- blank disks
// A new, empty disk of `tracks` tracks and `heads` sides (DiskDrives.newDisk), for the DOS to initialise (DSKINIT,
// DSKINI0). VDK and JVC hold sectors, so their blank is a low-level formatted disk: 18 sectors of 256 bytes per
// track, numbered from 1, every data byte BLANK_FILL (E5, the byte formatters conventionally fill with). A DMK
// holds the raw track, so its blank is unformatted: no ID marks (an empty IDAM table) over a track of 4E gap
// bytes, as a disk fresh from the box reads (record not found) until it is formatted. Headers are the ones
// saveDisk writes (MAME's vdk_format::save and jvc_format::save; the DMK layout of David Keil's specification).
// A DMK blank is double-sided only. A single-sided DMK marks it in byte 4 (bit 4), which MAME 0.264, our
// reference, cannot load: its dmk_format::identify reads that bit as the side count (line 89) and then rejects any
// non-zero byte 4 as reserved (lines 97-102). Later MAME (master: read_header checks from byte 5, and its own writer
// sets 0x10 for one side) agrees with our layout, but a blank we cannot compare with the reference is not made.
export const BLANK_FILL = 0xe5;
export const DMK_TRACK = 0x80 + 6250;        // IDAM table + one double-density revolution, as saveDisk's DMK
export function blankDisk(format, tracks, heads) {
  if (!Number.isInteger(tracks) || tracks < 1 || tracks > 82) throw new DiskFormatError(`a disk of ${tracks} tracks (1 to 82)`);
  if (heads !== 1 && heads !== 2) throw new DiskFormatError(`a disk of ${heads} sides (1 or 2)`);
  const data = tracks * heads * 18 * 256;
  if (format === 'vdk' || format === 'jvc') {
    const header = format === 'vdk' ? [0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, tracks, heads, 0, 0] : heads === 2 ? [18, 2] : [];
    const out = new Uint8Array(header.length + data).fill(BLANK_FILL);
    out.set(header);
    return out;
  }
  if (format === 'dmk') {
    if (heads !== 2) throw new DiskFormatError('a blank DMK is double-sided (MAME 0.264 cannot load a single-sided DMK)');
    const out = new Uint8Array(16 + tracks * heads * DMK_TRACK);
    out[1] = tracks; out[2] = DMK_TRACK & 0xff; out[3] = DMK_TRACK >> 8; out[4] = heads === 1 ? 0x10 : 0x00;
    for (let k = 0; k < tracks * heads; k++) out.fill(0x4e, 16 + k * DMK_TRACK + 0x80, 16 + (k + 1) * DMK_TRACK);
    return out;
  }
  throw new DiskFormatError(`unknown disk format ${format} (vdk, jvc or dmk)`);
}

// ---------------------------------------------------------------- save
export function saveDisk(image, format, options = {}) {
  const { tracks, heads } = image.actualGeometry();
  if (!tracks) throw new DiskFormatError('the disk holds no tracks');
  if (format === 'vdk' || format === 'jvc') {
    const geo = options.geometry || { sectors: 18, sectorSize: 256, firstSector: 1 };
    const std = geo.sectors === 18 && geo.sectorSize === 256 && geo.firstSector === 1;
    let header;
    if (format === 'vdk') {
      if (!std) throw new DiskFormatError('VDK holds 18 sectors of 256 bytes per track');
      header = [0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, tracks, heads, 0, 0];   // vdk_format::save
    } else if (geo.os9) header = [];    // a headerless OS-9 dump stays headerless; MAME saves these as OS9 (wd177x_format::save)
    else if (std) header = heads === 2 ? [18, 2] : [];      // jvc_format::save
    else header = [geo.sectors, heads, sizeCode(geo.sectorSize), geo.firstSector];
    const out = new Uint8Array(header.length + tracks * heads * geo.sectors * geo.sectorSize);
    out.set(header);
    let off = header.length;
    for (let t = 0; t < tracks; t++) {
      for (let h = 0; h < heads; h++) {
        const sectors = readTrackSectors(image, t, h);
        for (let i = 0; i < geo.sectors; i++) {
          const s = sectorById(sectors, geo.firstSector + i);
          if (!s || s.data.length !== geo.sectorSize) throw new DiskFormatError(`track ${t} side ${h}: sector ${geo.firstSector + i} is missing or not ${geo.sectorSize} bytes`);
          out.set(s.data, off);
          off += geo.sectorSize;
        }
      }
    }
    return out;
  }
  if (format === 'dmk') return saveDmk(image, tracks, heads, options);
  throw new DiskFormatError(`unknown disk format ${format}`);
}

// MFM bit cells -> bytes, framing bytes on sync marks (A1 with a missing clock, C2 likewise) as the WD
// controller's read track does; IDAM pointers to every FE that follows A1 A1 A1.
function bitsToDmkTrack(bits, length) {
  const data = new Uint8Array(length - 0x80).fill(0x4e);
  const idam = [];
  let shift = 0, count = 0, n = 0, a1run = 0;
  for (let i = 0; i < bits.length && n < data.length; i++) {
    shift = ((shift << 1) | bits[i]) & 0xffff;
    count++;
    // A1 with a missing clock cannot occur in plain MFM, so it re-frames at any phase; C2's pattern can
    // appear in a run of 00s one cell off, so it only counts where a byte ends anyway
    const sync = shift === 0x4489 ? 0xa1 : shift === 0x5224 && count === 16 ? 0xc2 : -1;
    if (sync >= 0 && count >= 8) {
      data[n++] = sync; count = 0;
      a1run = sync === 0xa1 ? a1run + 1 : 0;
      continue;
    }
    if (count === 16) {
      let v = 0;
      for (let b = 0; b < 8; b++) if (shift & (1 << (14 - 2 * b))) v |= 0x80 >> b;
      if (v === 0xfe && a1run >= 3 && idam.length < 64) idam.push(0x8000 | (0x80 + n));
      a1run = 0;
      data[n++] = v; count = 0;
    }
  }
  const out = new Uint8Array(length);
  idam.forEach((p, k) => { out[2 * k] = p & 0xff; out[2 * k + 1] = p >> 8; });
  out.set(data, 0x80);
  return out;
}
function saveDmk(image, tracks, heads, options) {
  const length = options.trackLength || 0x80 + 6250;
  const cells = (length - 0x80) * 16;
  const cellSize = Math.floor(REVOLUTION / cells);
  const out = new Uint8Array(16 + tracks * heads * length);
  out[0] = options.writeProtected ? 0xff : 0x00;
  out[1] = tracks; out[2] = length & 0xff; out[3] = length >> 8;
  out[4] = heads === 1 ? 0x10 : 0x00;
  for (let t = 0; t < tracks; t++) {
    for (let h = 0; h < heads; h++) {
      out.set(bitsToDmkTrack(fluxToBits(image.buffer(t, h), cellSize), length), 16 + (heads * t + h) * length);
    }
  }
  return out;
}
