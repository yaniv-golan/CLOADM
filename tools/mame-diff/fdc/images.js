// Disk images for the floppy diagnostics (tools/mame-diff/fdc): built here, from nothing but a formula, so
// the same bytes go to MAME and to our controller. Every sector holds a pattern that names its own track,
// side and sector, so a read from the wrong place shows.
//
//   sectorByte(track, side, sector, i)   the pattern
//   vdk(tracks, heads), jvc(tracks, heads), dmk(tracks, heads)   image bytes (DMK: MFM, 18 x 256, our layout)

const sectorByte = (t, h, s, i) => (t * 7 + h * 3 + s * 11 + i * 5 + (i >> 4)) & 0xff;

function sectors(tracks, heads) {
  const out = [];
  for (let t = 0; t < tracks; t++) for (let h = 0; h < heads; h++) for (let s = 1; s <= 18; s++) {
    const d = new Uint8Array(256);
    for (let i = 0; i < 256; i++) d[i] = sectorByte(t, h, s, i);
    out.push(d);
  }
  return out;
}
function vdk(tracks, heads) {
  const header = [0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, tracks, heads, 0, 0];
  const out = new Uint8Array(12 + tracks * heads * 18 * 256);
  out.set(header);
  sectors(tracks, heads).forEach((d, k) => out.set(d, 12 + k * 256));
  return out;
}
function jvc(tracks, heads) {
  const header = heads === 2 ? [18, 2] : [];
  const out = new Uint8Array(header.length + tracks * heads * 18 * 256);
  out.set(header);
  sectors(tracks, heads).forEach((d, k) => out.set(d, header.length + k * 256));
  return out;
}

// A NitrOS-9 / OS-9 .dsk: headerless, geometry stated in LSN 0 (defs/rbf.d) and a device descriptor copy at $3F.
// The file holds each track's sectors in sector-ID order (wd177x_dsk.cpp:92-101 offsets a sector by how many IDs
// sort before it); the track itself is built in OS-9's interleave (os9_dsk.cpp:279). File bytes are the same
// pattern as jvc(), so a read from the wrong sector shows.
function os9(tracks, heads) {
  const size = tracks * heads * 18 * 256;
  const out = new Uint8Array(size);
  const put = (t, h, s, i, v) => { out[(((t * heads + h) * 18) + (s - 1)) * 256 + i] = v; };
  for (let t = 0; t < tracks; t++) for (let h = 0; h < heads; h++) for (let s = 1; s <= 18; s++) for (let i = 0; i < 256; i++) put(t, h, s, i, sectorByte(t, h, s, i));
  const tot = tracks * heads * 18;
  const at = (o, v) => { out[o] = v; };
  at(0, (tot >> 16) & 0xff); at(1, (tot >> 8) & 0xff); at(2, tot & 0xff);   // DD.TOT
  at(3, 18);                                                                 // DD.TKS
  at(0x10, heads === 2 ? 0x03 : 0x02);                                        // DD.FMT: FMT.SIDE | FMT.DNS
  at(0x11, 0); at(0x12, 18);                                                  // DD.SPT = 18
  at(0x3f, 1);            // opt_dtype
  at(0x3f + 3, 0x20);     // opt_type: COCO, sector base ID 1, 256-byte sectors
  at(0x3f + 4, 1);        // opt_density: bit 0 = MFM
  at(0x3f + 5, tracks >> 8); at(0x3f + 6, tracks & 0xff);   // opt_cylinders
  at(0x3f + 7, heads);    // opt_sides
  at(0x3f + 9, 0); at(0x3f + 10, 18);                       // opt_sectors_per_track
  at(0x3f + 11, 0); at(0x3f + 12, 18);                      // opt_track0_sectors
  at(0x3f + 13, 3);       // opt_interleave
  return out;
}

// CRC-CCITT as the WD controllers compute it (preset FFFF, polynomial 1021, over the A1 A1 A1 mark too)
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
// a DMK track (David Keil's layout): 64 IDAM pointers (bit 15 = MFM), then the raw track bytes
function dmkTrack(t, h, length) {
  const raw = [];
  const put = (n, v) => { for (let i = 0; i < n; i++) raw.push(v); };
  const idam = [];
  put(32, 0x4e);
  for (let s = 1; s <= 18; s++) {
    put(12, 0x00); put(3, 0xa1);
    idam.push(0x80 + raw.length);
    const id = [0xfe, t, h, s, 1];
    raw.push(...id);
    const c = crc16([0xa1, 0xa1, 0xa1, ...id]);
    raw.push(c >> 8, c & 0xff);
    put(22, 0x4e); put(12, 0x00); put(3, 0xa1);
    const data = [0xfb];
    for (let i = 0; i < 256; i++) data.push(sectorByte(t, h, s, i));
    raw.push(...data);
    const d = crc16([0xa1, 0xa1, 0xa1, ...data]);
    raw.push(d >> 8, d & 0xff);
    put(24, 0x4e);
  }
  while (raw.length < length - 0x80) raw.push(0x4e);
  const out = new Uint8Array(length);
  idam.forEach((p, k) => { const v = 0x8000 | p; out[2 * k] = v & 0xff; out[2 * k + 1] = v >> 8; });
  out.set(raw.slice(0, length - 0x80), 0x80);
  return out;
}
function dmk(tracks, heads, length = 0x80 + 6250) {
  const out = new Uint8Array(16 + tracks * heads * length);
  out[1] = tracks; out[2] = length & 0xff; out[3] = length >> 8; out[4] = heads === 1 ? 0x10 : 0;
  for (let t = 0; t < tracks; t++) for (let h = 0; h < heads; h++) out.set(dmkTrack(t, h, length), 16 + (t * heads + h) * length);
  return out;
}

module.exports = { sectorByte, vdk, jvc, os9, dmk, crc16 };
