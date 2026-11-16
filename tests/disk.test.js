// Disk image formats (js/media/disk.js): VDK, JVC and DMK to and from flux tracks.
// Expected values are derived here by hand (MFM cell patterns, CRC-CCITT, the RS-DOS interleave), not by
// running the code under test; round trips use images built by tools/mame-diff/fdc/images.js.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (name, fn, re) => { let msg = null; try { fn(); } catch (e) { msg = e.message; } check(name, msg !== null && re.test(msg), msg === null ? 'did not throw' : msg); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const DRIVE = { tracks: 84, heads: 2 };

// ---------------- MFM cells by hand
// 4E = 0100 1110; MFM clock bit = 1 only between two data 0s; the track starts with no previous bit (0):
//   d=0 c=1 | d=1 c=0 | d=0 c=0 | d=0 c=1 | d=1 c=0 | d=1 c=0 | d=1 c=0 | d=0 c=0
//   cells (clock, data): 10 01 00 10 01 01 01 00 -> flux at cells 0, 3, 6, 9, 11, 13, at the middle of each
//   2 us cell of a 100,000-cell track: position = cell * 2000 + 1000
{
  const jvc = new Uint8Array(18 * 256);
  for (let i = 0; i < jvc.length; i++) jvc[i] = (i * 13) & 0xff;
  const img = Emu.loadDisk(jvc, 'jvc', DRIVE);
  const flux = img.buffer(0, 0).slice(0, 6).map(Emu.mgTime);
  check('gap 1 (4E) flux at cells 0, 3, 6, 9, 11, 13', eq(flux, [1000, 7000, 13000, 19000, 23000, 27000]), flux.join(','));
  check('a formatted track has flux only (no neutral zones)', img.buffer(0, 0).every((v) => Emu.mgType(v) === Emu.MG_F));
  check('one track, one side', img.actualGeometry().tracks === 1 && img.actualGeometry().heads === 1);

  // decode the cells ourselves: find A1 A1 A1 (4489 x3) FE and check the ID field and its CRC
  const bits = Emu.fluxToBits(img.buffer(0, 0), 2000);
  check('one revolution decodes to 100,000 cells', bits.length === 100000, bits.length);
  const byteAt = (p) => { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[p + 2 * b + 1]; return v; };
  let sh = 0, id = null;
  for (let i = 0; i < bits.length - 200 && !id; i++) {
    sh = ((sh << 1) | bits[i]) & 0xffff;
    if (sh === 0x4489 && byteAt(i + 1 + 32) === 0xfe) id = Array.from({ length: 7 }, (_, k) => byteAt(i + 1 + 32 + 16 * k));
  }
  const crc = images.crc16([0xa1, 0xa1, 0xa1, ...id.slice(0, 5)]);
  check('first ID field: track 0, side 0, sector 1, size 1 (sector 1 first: the RS-DOS interleave starts with it)', id && eq(id.slice(0, 5), [0xfe, 0, 0, 1, 1]), id && id.join(','));
  // our own MFM ID CRC is on the next two bytes: decode them too
  const at = (() => { let s = 0; for (let i = 0; i < bits.length; i++) { s = ((s << 1) | bits[i]) & 0xffff; if (s === 0x4489 && byteAt(i + 1 + 32) === 0xfe) return i + 1 + 32; } return -1; })();
  const crcOnDisk = (byteAt(at + 16 * 5) << 8) | byteAt(at + 16 * 6);
  check('ID field CRC is CRC-CCITT of A1 A1 A1 FE 00 00 01 01', crcOnDisk === crc, `${crcOnDisk.toString(16)} vs ${crc.toString(16)}`);

  // sectors in disk order follow MAME's RS-DOS interleave {0,11,4,15,8,1,12,5,16,9,2,13,6,17,10,3,14,7}
  const order = Emu.readTrackSectors(img, 0, 0).map((s) => s.sector);
  check('JVC sectors in RS-DOS interleave order', eq(order, [1, 6, 11, 16, 3, 8, 13, 18, 5, 10, 15, 2, 7, 12, 17, 4, 9, 14]), order.join(','));
  const s7 = Emu.readTrackSectors(img, 0, 0).find((s) => s.sector === 7);
  check('sector 7 holds file bytes 1536..1791', eq(Array.from(s7.data), Array.from(jvc.slice(6 * 256, 7 * 256))));
}

// ---------------- VDK: sectors in order, header kept as MAME writes it
{
  const vdk = images.vdk(40, 2);
  check('VDK detected by signature', Emu.detectDiskFormat(vdk, 'x.vdk') === 'vdk' && Emu.detectDiskFormat(vdk, '') === 'vdk');
  const g = Emu.diskGeometry(vdk, 'vdk');
  check('VDK geometry from the header', g.tracks === 40 && g.heads === 2 && g.headerSize === 12);
  const img = Emu.loadDisk(vdk, 'vdk', DRIVE);
  const t5 = Emu.readTrackSectors(img, 5, 1);
  check('VDK sectors in order 1..18', eq(t5.map((s) => s.sector), Array.from({ length: 18 }, (_, i) => i + 1)));
  check('VDK track 5 side 1 sector 9 holds its pattern', t5[8].data.every((v, i) => v === images.sectorByte(5, 1, 9, i)));
  check('VDK round trip (load, save) is byte-identical', eq(Emu.saveDisk(img, 'vdk'), vdk));
}

// ---------------- JVC: header only for two sides (as MAME saves)
for (const heads of [1, 2]) {
  const jvc = images.jvc(35, heads);
  check(`JVC ${heads} side(s) detected (.dsk)`, Emu.detectDiskFormat(jvc, 'disk.dsk') === 'jvc');
  const img = Emu.loadDisk(jvc, 'jvc', { tracks: 42, heads: 2 });
  check(`JVC ${heads} side(s) round trip is byte-identical`, eq(Emu.saveDisk(img, 'jvc'), jvc));
}

// ---------------- OS-9 (NitrOS-9) dumps: a headerless .dsk whose LSN 0 states its own geometry
// Everything here is written from defs/rbf.d and os9_dsk.cpp, not from js/media/disk.js: DD.TOT $00 (3 bytes,
// big-endian), DD.TKS $03, DD.FMT $10 (bit 0 = double sided), DD.SPT $11 (2 bytes, big-endian), and the optional
// descriptor at $3F (dtype 1, type $20 = COCO + sector base ID 1 + 256-byte sectors, density bit 0 = MFM).
function os9Disk(tracks, heads, patch = () => {}) {
  const size = tracks * heads * 18 * 256;
  const b = new Uint8Array(size);
  // every sector carries a pattern naming its own place, then LSN 0 is written over sector 1 of track 0 side 0
  for (let t = 0; t < tracks; t++) for (let h = 0; h < heads; h++) for (let s = 1; s <= 18; s++) {
    const off = ((t * heads + h) * 18 + (s - 1)) * 256;
    for (let i = 0; i < 256; i++) b[off + i] = images.sectorByte(t, h, s, i);
  }
  const tot = tracks * heads * 18;
  b[0] = (tot >> 16) & 0xff; b[1] = (tot >> 8) & 0xff; b[2] = tot & 0xff;
  b[3] = 18;                                   // DD.TKS: sectors per track
  b[0x10] = heads === 2 ? 0x03 : 0x02;         // DD.FMT: FMT.SIDE | FMT.DNS
  b[0x11] = 0; b[0x12] = 18;                   // DD.SPT, big-endian: 18
  b[0x3f] = 1;                                 // opt_dtype
  b[0x3f + 3] = 0x20;                          // opt_type: COCO, base ID 1, 256-byte sectors
  b[0x3f + 4] = 1;                             // opt_density: bit 0 = MFM
  b[0x3f + 5] = tracks >> 8; b[0x3f + 6] = tracks & 0xff;   // opt_cylinders, big-endian
  b[0x3f + 7] = heads;                         // opt_sides
  b[0x3f + 9] = 0; b[0x3f + 10] = 18;          // opt_sectors_per_track, big-endian
  b[0x3f + 11] = 0; b[0x3f + 12] = 18;         // opt_track0_sectors, big-endian
  b[0x3f + 13] = 3;                            // opt_interleave
  patch(b);
  return b;
}
const geo = (bytes) => Emu.diskGeometry(bytes, 'jvc');
// must not be taken as OS-9; either it throws (no geometry at all) or it falls back to plain JVC
const notOs9 = (bytes) => { try { return !geo(bytes).os9; } catch (e) { return true; } };
{
  for (const [tracks, heads] of [[35, 1], [35, 2], [40, 1], [40, 2], [80, 1], [80, 2]]) {
    const b = os9Disk(tracks, heads);
    const g = geo(b);
    check(`OS-9 ${tracks}x${heads}: LSN 0 gives the geometry (${tracks} tracks, ${heads} side(s))`,
      g.tracks === tracks && g.heads === heads && g.sectors === 18 && g.sectorSize === 256 && g.headerSize === 0,
      JSON.stringify(g));
    check(`OS-9 ${tracks}x${heads}: still a .dsk the jvc branch reads, and no header`, Emu.detectDiskFormat(b, 'x.dsk') === 'jvc' && g.headerSize === 0);
  }
  // the size ambiguity is the whole point: 368,640 bytes is both 80x1x18 and 40x2x18
  check('368,640 bytes is ambiguous by size alone; LSN 0 decides it is 40x2',
    geo(os9Disk(40, 2)).heads === 2 && geo(os9Disk(40, 2)).tracks === 40, JSON.stringify(geo(os9Disk(40, 2))));
  // and a plain 80x1 dump of the same size that is not OS-9 must stay 80x1
  const rsdos = new Uint8Array(368640);
  rsdos[0] = 0; rsdos[1] = 1;                 // a plausible RS-DOS FAT head; the rest zeroes
  check('a 368,640-byte non-OS-9 image stays 80x1 (RS-DOS regression)', geo(rsdos).tracks === 80 && geo(rsdos).heads === 1, JSON.stringify(geo(rsdos)));
  // the CoCo FDC's drive is 42 tracks: 40x2 mounts, and it used to fail as 80x1
  const img = Emu.loadDisk(os9Disk(40, 2), 'jvc', { tracks: 42, heads: 2 });
  check('a 40x2 OS-9 image mounts on a CoCo 525dd drive as 40x2', JSON.stringify(img.actualGeometry()) === '{"tracks":40,"heads":2}', JSON.stringify(img.actualGeometry()));
  // the 80x2 image must no longer fall through to DMK (jvc threw "160 tracks", DMK then accepted it)
  check('80x2 is detected jvc, not dmk', Emu.detectDiskFormat(os9Disk(80, 2), 'x.dsk') === 'jvc');
  // round trip: headerless in, headerless out, byte for byte
  const b40 = os9Disk(40, 2);
  const back = Emu.saveDisk(Emu.loadDisk(b40, 'jvc', { tracks: 84, heads: 2 }), 'jvc', { geometry: geo(b40) });
  check('OS-9 40x2 round trip is byte-identical and gains no 2-byte header', eq(back, b40) && back.length === 368640, `${back.length} bytes`);
  // A JVC header wins over LSN 0, structurally: one track is 18 x 256 = 4608 bytes, a multiple of 256, so a file
  // with a 1-4 byte header can never be a whole number of tracks and os9Geometry's size test rejects it. That is
  // why no `headerSize === 0` guard is needed. Checked with a body that IS a valid OS-9 image on its own, so the
  // only thing that can stop the OS-9 path is the size; and the header's own geometry is what is returned.
  {
    const body = os9Disk(40, 2);
    check('the header-precedence body really is an OS-9 image on its own', geo(body).os9 === true && geo(body).heads === 2, JSON.stringify(geo(body)));
    const hdr = new Uint8Array(body.length + 2); hdr[0] = 18; hdr[1] = 2; hdr.set(body, 2);
    const g = geo(hdr);
    check('a JVC header wins over a valid OS-9 body behind it, and the answer is the header\'s', g.headerSize === 2 && g.heads === 2 && !g.os9, JSON.stringify(g));
  }
  // sectors land in OS-9's order: track position i holds sector ID per_sector_id[i], and its bytes come from the
  // file's (id - 1)-th slot of the track (wd177x_dsk.cpp:92-101)
  const sects = Emu.readTrackSectors(Emu.loadDisk(os9Disk(35, 1), 'jvc', DRIVE), 0, 0);
  check('OS-9 track order is the OS-9 interleave {1,7,13,...}', eq(sects.map((s) => s.sector), [1, 7, 13, 2, 8, 14, 3, 9, 15, 4, 10, 16, 5, 11, 17, 6, 12, 18]),
    sects.map((s) => s.sector).join(','));
  check('OS-9 sector 7 (track position 1) holds the file\'s 7th sector, bytes 1536..1791',
    sects[1].data.every((v, i) => v === images.sectorByte(0, 0, 7, i)));
  // the gaps differ from JVC's and must be MAME's: after the track's last data CRC comes gap 3, then the
  // end-of-track fill. Decode the cells and count 0x4E bytes between sector 18's CRC and the end of the track.
  // os9_dsk.cpp:279 sector_count 18, gap_1 18, gap_2 28, gap_3 20; jvc_dsk.cpp:253 uses 32, 24, 22.
  {
    const bits = Emu.fluxToBits(Emu.loadDisk(os9Disk(35, 1), 'jvc', DRIVE).buffer(0, 0), 2000);
    const byteAt = (p) => { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[p + 2 * b + 1]; return v; };
    let firstId = -1;
    for (let i = 0; i < bits.length - 200; i++) {
      let sh = 0; for (let k = 0; k < 16; k++) sh = ((sh << 1) | bits[i + k]) & 0xffff;
      if (sh === 0x4489 && byteAt(i + 32) === 0xfe) { firstId = i; break; }
    }
    // count the 0x4E cells directly after the first ID field's 12 zero bytes: that is gap 2 (os9_dsk: 28)
    let p = firstId + 32 + 16 * 7;                     // past the ID field + its CRC
    let gap2 = 0;
    while (byteAt(p + gap2 * 16) === 0x4e) gap2++;
    check('OS-9 gap 2 between the ID field and the data mark is 28 (os9_dsk.cpp:279), not JVC\'s 24', gap2 === 28, gap2);
    // and gap 1 before the first ID field is 18 schemes: count 0x4E from the start of the track
    let gap1 = 0;
    while (gap1 * 16 + 16 < firstId && byteAt(gap1 * 16) === 0x4e) gap1++;
    check('OS-9 gap 1 before the first ID field is 18 (os9_dsk.cpp:279), not JVC\'s 32', gap1 === 18, gap1);
    // gap 3 is the 0x4E run after a data field's CRC: 3 x A1 plus the FB mark is 4 bytes of framing before the 256
    // data bytes, then 2 CRC bytes, so the run starts 32 + 16 * (1 + 256 + 2) cells after the A1. os9_dsk: 20;
    // jvc: 22. Measured on the first data mark, which always has room for its whole field.
    let firstData = -1;
    for (let i = 0; i < bits.length - 200; i++) {
      let sh = 0; for (let k = 0; k < 16; k++) sh = ((sh << 1) | bits[i + k]) & 0xffff;
      if (sh === 0x4489 && byteAt(i + 32) === 0xfb) { firstData = i; break; }
    }
    const p3 = firstData + 32 + 16 * 259;              // A1 x3, FB, 256 data, 2 CRC
    let gap3 = 0;
    while (gap3 < 100 && byteAt(p3 + gap3 * 16) === 0x4e) gap3++;
    check('OS-9 gap 3 after a data field is 20 (os9_dsk.cpp:279), not JVC\'s 22', gap3 === 20, gap3);
  }
}
// mutations: each of these drops one of MAME's checks, and each must be refused (falling back to JVC, which
// then fails on size) rather than accepted as OS-9
{
  const rejected = (name, bytes) => {
    check(`mutation: ${name} is not taken as OS-9`, notOs9(bytes), (() => { try { return JSON.stringify(geo(bytes)); } catch (e) { return 'threw'; } })());
  };
  rejected('no double-sided bit (DD.FMT bit 0) on a 40x2-sized image would need 80x1 to pass the descriptor',
    os9Disk(40, 2, (b) => { b[0x10] = 0x02; }));
  rejected('DD.TOT larger than the image (os9_dsk.cpp:151)',
    os9Disk(40, 2, (b) => { const tot = 5000; b[0] = (tot >> 16) & 0xff; b[1] = (tot >> 8) & 0xff; b[2] = tot & 0xff; }));
  rejected('DD.TOT so small the size exceeds (TOT + SPT - 10) sectors (os9_dsk.cpp:160)',
    os9Disk(40, 2, (b) => { b[0] = 0; b[1] = 0; b[2] = 100; }));
  rejected('a descriptor that does not describe a COCO disk (no COCO bit and opt_dtype != 1, os9_dsk.cpp:118,128)',
    os9Disk(40, 2, (b) => { b[0x3f] = 0; b[0x3f + 3] = 0; }));
  // opt_dtype alone: the COCO bit is still set, so only the opt_dtype rule (os9_dsk.cpp:128) can reject it
  rejected('opt_dtype != 1 while the COCO bit is set (os9_dsk.cpp:128)',
    os9Disk(40, 2, (b) => { b[0x3f] = 0; }));
  rejected('a descriptor with the COCO bit cleared (opt_dtype 1 is not enough, os9_dsk.cpp:118)',
    os9Disk(40, 2, (b) => { b[0x3f + 3] = 0; }));
  rejected('sector base ID 0 when the COCO entry needs 1 (os9_dsk.cpp:169)',
    os9Disk(40, 2, (b) => { b[0x3f + 3] = 0x22; }));          // COCO bit and base-ID-0 bit, no 256-byte bit change
  rejected('a descriptor claiming fewer sides than DD.FMT (os9_dsk.cpp:190)',
    os9Disk(40, 2, (b) => { b[0x3f + 7] = 1; }));
  rejected('a descriptor saying the disk is single density (os9_dsk.cpp:180)',
    os9Disk(40, 2, (b) => { b[0x3f + 4] = 0; }));
  // the remaining checks, each isolated so its own rule is the one that rejects
  rejected('a descriptor allowing fewer sectors per track than DD.SPT (os9_dsk.cpp:194)',
    os9Disk(40, 2, (b) => { b[0x3f + 10] = 17; }));
  rejected('a descriptor allowing fewer track 0 sectors than DD.SPT (os9_dsk.cpp:194)',
    os9Disk(40, 2, (b) => { b[0x3f + 12] = 17; }));
  rejected('a descriptor saying 512-byte sectors (os9_dsk.cpp:201)',
    os9Disk(40, 2, (b) => { b[0x3f + 3] = 0x20 | 4; }));       // COCO bit and the 512-byte bit
  rejected('a descriptor whose interleave is larger than the track (os9_dsk.cpp:206)',
    os9Disk(40, 2, (b) => { b[0x3f + 13] = 19; }));
  rejected('an image too short to hold LSN 0 at all', os9Disk(40, 2).slice(0, 0x50));
  rejected('DD.TOT of zero (os9_dsk.cpp:97)', os9Disk(40, 2, (b) => { b[0] = 0; b[1] = 0; b[2] = 0; }));
  // the Gimix rule: opt_density bit 7 marks a COCO disk even with opt_type's COCO bit clear (os9_dsk.cpp:125).
  // Accepted *because of* that bit, so removing the rule changes the answer.
  {
    const gimix = os9Disk(40, 2, (b) => { b[0x3f + 3] = 0; b[0x3f + 4] = 0x81; });
    check('opt_density bit 7 alone marks the disk COCO (os9_dsk.cpp:125)', (() => { try { return geo(gimix).os9 === true; } catch (e) { return false; } })());
  }
  // 10- and 16-sector OS-9 images are not ours (18 x 256 MFM only); say so, and do not claim them. These are
  // genuine images at those sector counts - sized t*h*spt*256 with the descriptor saying so - not an 18-sector
  // fixture with DD.SPT patched, which is what an earlier version of this test did and why it proved nothing.
  const os9Spt = (tracks, heads, spt) => {
    const b = new Uint8Array(tracks * heads * spt * 256);
    const tot = tracks * heads * spt;
    b[0] = (tot >> 16) & 0xff; b[1] = (tot >> 8) & 0xff; b[2] = tot & 0xff;
    b[3] = spt; b[0x10] = heads === 2 ? 0x03 : 0x02; b[0x11] = 0; b[0x12] = spt;
    b[0x3f] = 1; b[0x3f + 3] = 0x20; b[0x3f + 4] = 1;
    b[0x3f + 6] = tracks; b[0x3f + 7] = heads;
    b[0x3f + 10] = spt; b[0x3f + 12] = spt; b[0x3f + 13] = 3;
    return b;
  };
  rejected('a genuine 10-sector OS-9 image (only the 18-sector entries are ours)', os9Spt(35, 1, 10));
  rejected('a genuine 16-sector OS-9 image (only the 18-sector entries are ours)', os9Spt(35, 1, 16));
}

// ---------------- OS-9 through a real drive: mount, write, flush, snapshot (js/chips/floppy.js)
// The two places that pass the mounted geometry to saveDisk are load-bearing: without them a headerless OS-9 image
// is written back with JVC's 2-byte header, so it no longer round-trips and the drive keeps its bytes twice. And a
// snapshot has to keep the geometry it mounted with, because an OS-9 disk's geometry comes from its own first
// sector: a guest that writes LSN 0 would otherwise make the restore come back as a different, smaller disk.
{
  const Emu2 = Emu;
  const mkDrive = () => {
    const m = Emu2.createMachine('coco');
    const f = new Emu2.devices.cocofdc({ rom: new Uint8Array(0x2000) });
    m.insertCartridge(f);
    return { m, fdc: m.cartPort };
  };
  const os9b = os9Disk(40, 2);
  const { fdc } = mkDrive();
  fdc.mount(0, { bytes: Uint8Array.from(os9b), format: 'jvc', name: 'x.dsk', writeProtected: false });
  const d = fdc.drives[0];
  check('OS-9 drive: mounts 40x2 and does not need the mounted bytes kept', d.geometry.tracks === 40 && d.geometry.heads === 2 && d.mountBytes === null,
    JSON.stringify({ g: d.geometry, mountBytes: !!d.mountBytes }));
  // flush() must write the image back without JVC's 2-byte header. The drive writes through saveDisk with the
  // geometry it mounted, so drive the same call flush() makes and check the length is the headerless one.
  d.imageDirty = true;
  d.flush();
  check('OS-9 drive: flush keeps the file headerless (no 2-byte JVC header added)', d.media.bytes.length === os9b.length, d.media.bytes.length);
  // everything a 40x2 disk carries, measured BEFORE the guest touches LSN 0 and before the snapshot
  const side1Of = (dd) => { let n = 0; for (let t = 0; t < 40 && dd.image.heads > 1; t++) n += dd.image.data[t * dd.image.heads + 1].length; return n; };
  const side10 = side1Of(d);
  // and a snapshot of a drive whose guest rewrote LSN 0 still restores as the same 40x2 disk
  d.media.bytes.fill(0, 0, 256);
  const snap = Emu2.state.fromJSON(Emu2.state.toJSON(d.saveState()));
  const { fdc: fdc2 } = mkDrive();
  let err = null;
  try { fdc2.drives[0].loadState(snap); } catch (e) { err = e; }
  check('OS-9 drive: a snapshot taken after the guest wrote LSN 0 restores (it used to throw on a 42-track drive)', !err, err && err.message);
  // the flux of every track is `data[track * heads + head]`, so a 40x2 disk's tracks are entries 0..79 and a
  // 40x2 restore must keep all of them: an 80x1 restore would leave half of these empty.
  // side 1 is untouched by the LSN 0 write, so its flux must come back cell for cell. (Total flux legitimately
  // changes: the written sector is on side 0.)
  check('...as the same 40x2 disk, keeping every side-1 track', !err && fdc2.drives[0].geometry.tracks === 40 && fdc2.drives[0].geometry.heads === 2
    && side10 > 0 && side1Of(fdc2.drives[0]) === side10,
    err ? '' : JSON.stringify({ g: fdc2.drives[0].geometry, side1Before: side10, side1After: side1Of(fdc2.drives[0]) }));
}

// ---------------- DMK: hand-built tracks (images.js) and our writer
{
  const dmk = images.dmk(4, 2);
  check('DMK detected', Emu.detectDiskFormat(dmk, 'a.dmk') === 'dmk');
  const img = Emu.loadDisk(dmk, 'dmk', DRIVE);
  const s = Emu.readTrackSectors(img, 3, 1);
  check('DMK sectors decode with their pattern', s.length === 18 && s.every((x) => x.data.every((v, i) => v === images.sectorByte(3, 1, x.sector, i))));
  const out = Emu.saveDisk(img, 'dmk', { trackLength: 0x80 + 6250 });
  check('DMK round trip of a hand-built image is byte-identical', eq(out, dmk));
  // the same disk saved from a VDK's flux, read back as DMK: the same sectors
  const fromVdk = Emu.saveDisk(Emu.loadDisk(images.vdk(4, 2), 'vdk', DRIVE), 'dmk');
  const back = Emu.loadDisk(fromVdk, 'dmk', DRIVE);
  // a length guard first: [].every() is true, so an empty track list would pass this check vacuously
  const readBack = Emu.readTrackSectors(back, 2, 0);
  check('VDK disk written as DMK reads back 18 sectors, each holding its pattern',
    readBack.length === 18 && readBack.every((x) => x.data.every((v, i) => v === images.sectorByte(2, 0, x.sector, i))),
    `${readBack.length} sectors`);
  check('DMK IDAM pointers flag MFM (bit 15)', (fromVdk[16 + 1] & 0x80) === 0x80);
}

// ---------------- errors
{
  const vdk = images.vdk(2, 1);
  throws('VDK without "dk"', () => Emu.loadDisk(Uint8Array.from([0, 0, ...vdk.slice(2)]), 'vdk', DRIVE), /signature/);
  throws('VDK shorter than its header says', () => Emu.loadDisk(vdk.slice(0, vdk.length - 1), 'vdk', DRIVE), /header needs/);
  throws('VDK with more tracks than the drive', () => Emu.loadDisk(images.vdk(43, 1), 'vdk', { tracks: 42, heads: 2 }), /drive has 42/);
  throws('JVC whose size is not whole tracks', () => Emu.loadDisk(new Uint8Array(18 * 256 * 3 + 256), 'jvc', DRIVE), /header|size/);
  throws('JVC with a 5-byte header', () => Emu.loadDisk(new Uint8Array(18 * 256 + 5), 'jvc', DRIVE), /not supported/);
  throws('JVC with 83 tracks', () => Emu.loadDisk(new Uint8Array(83 * 18 * 256), 'jvc', DRIVE), /at most 82/);
  const dmk = images.dmk(1, 2);
  const badPtr = dmk.slice(); badPtr[16] = 0x90; badPtr[17] = 0x80;     // IDAM pointer at a byte that is not FE
  throws('DMK IDAM pointer not at an ID mark', () => Emu.loadDisk(badPtr, 'dmk', DRIVE), /IDAM/);
  const badLen = dmk.slice(); badLen[2] = 0x10; badLen[3] = 0;
  throws('DMK track length out of range', () => Emu.loadDisk(badLen, 'dmk', DRIVE), /track length/);
  check('unknown file: no format', Emu.detectDiskFormat(new Uint8Array(1000), 'x.bin') === null);
  check('.vdk without signature: no format', Emu.detectDiskFormat(new Uint8Array(4620), 'x.vdk') === null);
  const img = Emu.loadDisk(images.vdk(2, 1), 'vdk', DRIVE);
  img.setBuffer(1, 0, []);                                                 // a track with nothing on it
  img.setBuffer(1, 0, Emu.loadDisk(images.vdk(2, 1), 'vdk', DRIVE).buffer(0, 0));   // track 0's flux on track 1: sectors say track 0
  check('saving keeps whatever IDs the track has (MAME ignores the ID track)', Emu.saveDisk(img, 'vdk').length === 12 + 2 * 18 * 256);
  const empty = Emu.loadDisk(images.vdk(2, 1), 'vdk', DRIVE);
  empty.setBuffer(1, 0, [Emu.mg(Emu.MG_N, 0)]);
  throws('saving a track without its sectors fails (MAME would crash)', () => Emu.saveDisk(empty, 'vdk'), /sector 1 is missing/);
}

// ---------------- blank disks (blankDisk): sizes and headers derived here from the formats, then round trips
{
  const vdk = Emu.blankDisk('vdk', 40, 2);
  // VDK: "dk", header size 12 (LE), version 10/10, source 'M', flags 1, tracks, sides, 2 more bytes; then the sectors
  check('blank VDK 40 x 2: 12-byte header, then 40 x 2 x 18 x 256 bytes', vdk.length === 12 + 40 * 2 * 18 * 256
    && eq(Array.from(vdk.slice(0, 12)), [0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, 40, 2, 0, 0]));
  check('blank VDK: every data byte E5', vdk.slice(12).every((v) => v === 0xe5));
  const jvc1 = Emu.blankDisk('jvc', 35, 1), jvc2 = Emu.blankDisk('jvc', 40, 2);
  // JVC: no header for single-sided 18 x 256 (161,280 bytes for 35 tracks: RS-DOS's disk); two-sided: [18, 2]
  check('blank JVC 35 x 1: no header, 161,280 bytes (35 x 18 x 256)', jvc1.length === 161280 && jvc1.every((v) => v === 0xe5));
  check('blank JVC 40 x 2: header 18, 2, then 40 x 2 x 18 x 256', jvc2.length === 2 + 40 * 2 * 4608 && jvc2[0] === 18 && jvc2[1] === 2);
  const dmk = Emu.blankDisk('dmk', 40, 2);
  // DMK: 16-byte header (WP, tracks, track length LE, flags: 0 for double-sided double density, the rest 0), then
  // each track and side (track 0 side 0, track 0 side 1, ...) as 0x80 IDAM bytes and the raw track
  check('blank DMK 40 x 2: header (not WP, 40 tracks, length 0x80+6250, double-sided), 80 track sides', dmk.length === 16 + 80 * (0x80 + 6250)
    && dmk[0] === 0 && dmk[1] === 40 && (dmk[2] | (dmk[3] << 8)) === 0x80 + 6250 && dmk.slice(4, 16).every((v) => v === 0));
  check('blank DMK: no ID marks (an empty IDAM table) over 4E gap bytes', [0, 17, 79].every((k) => { const o = 16 + k * (0x80 + 6250); return dmk.slice(o, o + 0x80).every((v) => v === 0) && dmk.slice(o + 0x80, o + 0x80 + 6250).every((v) => v === 0x4e); }));
  throws('blank DMK: single-sided refused (MAME 0.264 cannot load one)', () => Emu.blankDisk('dmk', 40, 1), /double-sided/);
  // they are what they say: detected, the geometry read back, and (VDK, JVC) saved back to the same bytes
  for (const [f, b, t, h, name] of [['vdk', vdk, 40, 2, 'a.vdk'], ['jvc', jvc1, 35, 1, 'a.dsk'], ['jvc', jvc2, 40, 2, 'b.dsk'], ['dmk', dmk, 40, 2, 'a.dmk']]) {
    const g = Emu.diskGeometry(b, f);
    check(`blank ${f} ${t} x ${h}: detected as ${f}, geometry read back`, Emu.detectDiskFormat(b, name) === f && g.tracks === t && g.heads === h);
  }
  for (const [f, b] of [['vdk', vdk], ['jvc', jvc1], ['jvc', jvc2]]) check(`blank ${f}: load then save gives the same bytes`, eq(Emu.saveDisk(Emu.loadDisk(b, f, DRIVE), f), b));
  const blankDmk = Emu.loadDisk(dmk, 'dmk', DRIVE);
  check('blank DMK: no sector on any track or side (unformatted)', [0, 20, 39].every((t) => Emu.readTrackSectors(blankDmk, t, 0).length === 0 && Emu.readTrackSectors(blankDmk, t, 1).length === 0));
  check('blank VDK: track 39 side 1 holds sectors 1-18 of E5', (() => { const sec = Emu.readTrackSectors(Emu.loadDisk(vdk, 'vdk', DRIVE), 39, 1); return sec.length === 18 && sec.every((x) => x.track === 39 && x.data.every((v) => v === 0xe5)); })());
  throws('blank disk: 0 tracks refused', () => Emu.blankDisk('vdk', 0, 1), /1 to 82/);
  throws('blank disk: 83 tracks refused', () => Emu.blankDisk('jvc', 83, 1), /1 to 82/);
  throws('blank disk: 3 sides refused', () => Emu.blankDisk('vdk', 40, 3), /1 or 2/);
  throws('blank disk: an unknown format refused', () => Emu.blankDisk('adf', 40, 1), /unknown disk format adf/);
}

// ---------------- MAME's time arithmetic (attotime) where it rounds
import('../js/chips/attotime.js').then((A) => {
  check('attotime / 2 rounds half up', A.div(5n, 2) === 3n && A.div(4n, 2) === 2n);
  check('attotime / 100 rounds at 50', A.div(149n, 100) === 1n && A.div(150n, 100) === 2n);
  check('from_double(0.2) is 200 ms exactly', A.fromDouble(0.2) === 200000000000000000n);
  check('MAME\'s float 60/300 revolution: 0.20000000298 s', A.fromDouble(Math.fround(60 / Math.fround(300))) === 200000002980232238n || A.fromDouble(Math.fround(60 / Math.fround(300))) === 200000002980232224n);
  check('from_ticks(12, 1 MHz) = 12 us', A.fromTicks(12, 1000000) === 12000000000000n);
  check('as_ticks floors', A.asTicks(A.fromTicks(7, 250000) - 1n, 250000) === 6n);
  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
});
