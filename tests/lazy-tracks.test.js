// TEMPORARY (branch claude/fdc-lazy-tracks): the flux a lazily built disk gives is the flux the eager loader gave.
// tests/lazy-tracks/disk-eager.mjs is js/media/disk.js as of v0.1.8 (commit 1dd66fa), frozen: every track built at
// load. This compares it with the lazy FloppyImage.track(k) path for every fixture and format, then runs the floppy
// firmware on four drives (double-sided, write-protected, empty, DMK) twice - once with every image built eagerly by
// the old loader, once lazily - and compares the drives' flux, bits, sectors and committed bytes after the writes
// and across a saveState / loadState round trip.
const Emu = require('./load')();
const Old = require('./lazy-tracks/disk-eager.mjs');
const images = require('../tools/mame-diff/fdc/images');
const path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSectors = (a, b) => a.length === b.length && a.every((s, i) => s.track === b[i].track && s.head === b[i].head && s.sector === b[i].sector
  && s.size === b[i].size && s.deleted === b[i].deleted && sameArr(s.data, b[i].data));
const tracksOf = (img) => Array.from({ length: img.count }, (_, k) => img.track(k));

// ---------------- the fixtures: every format and the geometries the loaders branch on
function jvcHeader(header, tracks, heads, sectors, size) {
  const out = new Uint8Array(header.length + tracks * heads * sectors * size);
  out.set(header);
  for (let i = header.length; i < out.length; i++) out[i] = (i * 31 + (i >> 9)) & 0xff;
  return out;
}
const vdkWp = images.vdk(40, 1); vdkWp[10] = 1;          // the VDK write-protect flag
const sdDmk = images.dmk(10, 2); sdDmk[4] = 0x40;          // single density
const wpDmk = images.dmk(10, 2); wpDmk[0] = 0xff;          // write-protected DMK
const FIXTURES = [
  ['vdk 35x1', images.vdk(35, 1), 'vdk'], ['vdk 40x2', images.vdk(40, 2), 'vdk'], ['vdk 80x2', images.vdk(80, 2), 'vdk'], ['vdk 40x1 write-protected', vdkWp, 'vdk'],
  ['jvc 35x1 headerless', images.jvc(35, 1), 'jvc'], ['jvc 40x2', images.jvc(40, 2), 'jvc'], ['jvc 80x2', images.jvc(80, 2), 'jvc'],
  ['jvc 4-byte header, 10 x 512 from 0', jvcHeader([10, 1, 2, 0], 40, 1, 10, 512), 'jvc'],
  ['jvc 3-byte header, 16 x 256', jvcHeader([16, 2, 1], 35, 2, 16, 256), 'jvc'],
  ['os9 40x2', images.os9(40, 2), 'jvc'], ['os9 35x1', images.os9(35, 1), 'jvc'],
  ['dmk 10x2 MFM', images.dmk(10, 2), 'dmk'], ['dmk 40x2 MFM', images.dmk(40, 2), 'dmk'], ['dmk 10x2 single density', sdDmk, 'dmk'], ['dmk write-protected', wpDmk, 'dmk'],
  ['blank vdk 40x2', Emu.blankDisk('vdk', 40, 2), 'vdk'], ['blank jvc 35x1', Emu.blankDisk('jvc', 35, 1), 'jvc'], ['blank dmk 40x2', Emu.blankDisk('dmk', 40, 2), 'dmk'],
];
const DRIVES = [{ tracks: 84, heads: 2 }, { tracks: 42, heads: 2 }, { tracks: 82, heads: 1 }];

// ---------------- load: old eager vs new lazy, track by track (in reverse order, so build order differs too)
for (const [name, bytes, format] of FIXTURES) {
  for (const drive of DRIVES) {
    let oldImg = null, oldErr = null, newImg = null, newErr = null;
    try { oldImg = Old.loadDisk(bytes, format, drive); } catch (e) { oldErr = e.message; }
    try { newImg = Emu.loadDisk(bytes, format, drive); } catch (e) { newErr = e.message; }
    const label = `${name} on ${drive.tracks}x${drive.heads}`;
    if (oldErr || newErr) { check(`${label}: the same load error`, oldErr === newErr, `${oldErr} / ${newErr}`); continue; }
    const full = drive === DRIVES[0];   // bits, sectors and saves on the 84 x 2 drive; flux on every drive
    let flux = 0, bits = 0, sects = 0;
    for (let k = newImg.count - 1; k >= 0; k--) {
      const a = oldImg.data[k], b = newImg.track(k);
      if (!sameArr(a, b)) flux++;
      if (!full) continue;
      if (a.length && !sameArr(Old.fluxToBits(a, 2000), Emu.fluxToBits(b, 2000))) bits++;
      const t = Math.floor(k / drive.heads), h = k % drive.heads;
      if (a.length && !sameSectors(Old.readTrackSectors(oldImg, t, h), Emu.readTrackSectors(newImg, t, h))) sects++;
    }
    check(`${label}: every track's flux${full ? ', bits and sectors' : ''} identical`, newImg.count === oldImg.data.length && !flux && !bits && !sects, `${flux} flux, ${bits} bits, ${sects} sector lists differ`);
    check(`${label}: same actual geometry`, JSON.stringify(oldImg.actualGeometry()) === JSON.stringify(newImg.actualGeometry()));
    if (!full) continue;
    // saving: same bytes in every format the image can be written as (with the mounted geometry, as flush() does)
    const g = Emu.diskGeometry(bytes, format);
    for (const to of ['vdk', 'jvc', 'dmk']) {
      const opts = to === 'dmk' ? (format === 'dmk' ? { trackLength: g.trackLength, writeProtected: g.writeProtected } : {}) : (format === to || (format === 'jvc' && to === 'vdk') ? { geometry: g } : {});
      let a, b;
      try { a = Old.saveDisk(oldImg, to, opts); } catch (e) { a = e.message; }
      try { b = Emu.saveDisk(Emu.loadDisk(bytes, format, drive), to, opts); } catch (e) { b = e.message; }   // a fresh lazy image: the save builds it
      check(`${label}: saved as ${to}, identical`, typeof a === 'string' ? a === b : typeof b !== 'string' && sameArr(a, b), typeof a === 'string' ? `${a} / ${b}` : '');
    }
  }
}

// errors that used to come from building a track still come at load, word for word
for (const [name, bytes, format] of [['jvc 36 x 256 (track layout too long)', jvcHeader([36, 1, 1], 2, 1, 36, 256), 'jvc'],
  ['dmk IDAM pointer not at an ID mark', (() => { const d = images.dmk(10, 2); d[16 + 7 * 2 * (0x80 + 6250) + 0] = 0x90; d[16 + 7 * 2 * (0x80 + 6250) + 1] = 0x80; return d; })(), 'dmk']]) {
  let a = null, b = null;
  try { Old.loadDisk(bytes, format, DRIVES[0]); } catch (e) { a = e.message; }
  try { Emu.loadDisk(bytes, format, DRIVES[0]); } catch (e) { b = e.message; }
  check(`${name}: still fails at load with the same message`, a !== null && a === b, `${a} / ${b}`);
}

// the builders read their own copy: changing the bytes after load (flush() commits in place) changes no track
{
  const bytes = images.vdk(40, 2);
  const img = Emu.loadDisk(bytes, 'vdk', DRIVES[0]);
  const ref = Old.loadDisk(bytes.slice(), 'vdk', DRIVES[0]).data;
  bytes.fill(0x55, 12);
  check('a track built after the source bytes change is the track as loaded', tracksOf(img).every((t, k) => sameArr(t, ref[k])));
}

// ---------------- the drives: floppy firmware on four drives, eager (old loader) and lazy, writes, snapshots
const spec = require(path.join(__dirname, '../tools/mame-diff/fdc/spec.js'));
function eagerFrom(img, media, drive) {
  // the old loader's image, copied into a FloppyImage with every track built
  const old = Old.loadDisk(media.bytes, media.format, { tracks: drive.tracks, heads: drive.sides }, drive.geometry);
  const out = new Emu.FloppyImage(img.tracks, img.heads);
  old.data.forEach((t, k) => out.setTrack(k, t));
  return out;
}
function driveState(fdc) {
  return fdc.drives.map((d) => {
    if (!d.image) return 'empty';
    const tracks = tracksOf(d.image);
    const sectors = [];
    for (let k = 0; k < tracks.length; k++) if (tracks[k].length) sectors.push(JSON.stringify(Emu.readTrackSectors(d.image, Math.floor(k / d.image.heads), k % d.image.heads).map((s) => [s.track, s.head, s.sector, Array.from(s.data)])));
    return JSON.stringify({ flux: tracks, sectors, bytes: Array.from(d.media.bytes), wpt: d.wpt, written: [...d.written] });
  });
}
const PC = (m) => m.cpu.pc;
for (const [profile, opts, frames, at] of [
  ['dragon64', { controller: 'dragonfdc', write: true }, 300, 120],
  ['coco', { controller: 'cocofdc', write: true }, 300, 120],
  ['coco', { controller: 'cocofdc-os9', write: true }, 300, 120],
  ['dragon64', { controller: 'dragonfdc' }, 700, 286],
]) {
  const t = spec.trace(profile, Object.assign({ regenerate: false }, opts));
  const lazy = t.machine(), eager = t.machine();
  t.fdcOf(eager).drives.forEach((d) => { if (d.image) d.image = eagerFrom(d.image, d.media, d); });
  const label = `${t.label}`;
  let same = true, snapAt = null;
  for (let f = 0; f < frames; f++) {
    lazy.runFrame(); eager.runFrame();
    if (PC(lazy) !== PC(eager) || lazy.cycle !== eager.cycle) { same = false; break; }
    if (f === at) snapAt = { lazy: Emu.state.toJSON(lazy.snapshot()), eager: Emu.state.toJSON(eager.snapshot()), frame: f };
  }
  check(`${label}: eager and lazy machines run in step for ${frames} frames`, same);
  const ds = driveState(t.fdcOf(lazy)), de = driveState(t.fdcOf(eager));
  check(`${label}: drives 0-3 identical after the run (flux, sectors, committed bytes, write-protect)`, ds.every((s, i) => s === de[i]), ds.map((s, i) => s === de[i] ? '=' : 'x').join(''));
  t.fdcOf(lazy).drives.forEach((d) => d.flush()); t.fdcOf(eager).drives.forEach((d) => d.flush());
  check(`${label}: flushed images identical`, t.fdcOf(lazy).drives.every((d, i) => !d.media || sameArr(d.media.bytes, t.fdcOf(eager).drives[i].media.bytes)));
  check(`${label}: the snapshot at frame ${at} is the same text from either`, snapAt && snapAt.lazy === snapAt.eager);
  // restore that snapshot twice: lazily, and with every track built at once; both continue as the original did
  if (snapAt) {
    const rl = Emu.restoreSnapshot(Emu.state.fromJSON(snapAt.lazy), lazy.roms);
    const re = Emu.restoreSnapshot(Emu.state.fromJSON(snapAt.lazy), lazy.roms);
    t.fdcOf(re).drives.forEach((d) => { if (d.image) tracksOf(d.image); });
    let ok = true;
    for (let f = snapAt.frame + 1; f < frames; f++) { rl.runFrame(); re.runFrame(); if (PC(rl) !== PC(re) || rl.cycle !== re.cycle) { ok = false; break; } }
    check(`${label}: restored lazily and eagerly, both run in step to frame ${frames}`, ok);
    const rs = driveState(t.fdcOf(rl)), rse = driveState(t.fdcOf(re));
    check(`${label}: and the restored drives end identical to each other and to the uninterrupted run`, rs.every((s, i) => s === rse[i] && s === ds[i]),
      rs.map((s, i) => (s === rse[i] ? '=' : 'x') + (s === ds[i] ? '=' : 'x')).join(' '));
    [rl, re].forEach((m) => t.fdcOf(m).drives.forEach((d) => d.flush()));   // committed as the uninterrupted run's were above
    const sl = Emu.state.toJSON(rl.snapshot());
    // (not the uninterrupted run's text: a restore leaves the scheduler's generation counter one apart)
    check(`${label}: their snapshots at the end are the same text`, sl === Emu.state.toJSON(re.snapshot()));
  }
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all passed');
