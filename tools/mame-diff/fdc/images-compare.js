// run.js <profile> --fdc --images: the disk images MAME writes and the ones we write from the same firmware
// must be byte-identical. MAME runs the firmware to HALT without tracing and exits normally, saving every
// changed image it can save (it commits a disk when its motor stops, as we do); our machine runs the same
// firmware to HALT and flushes its drives. Compared: drive 0 (written by the firmware) and drive 1 (write-
// protected: it must come back unchanged from both). MAME cannot save DMK (dmk_format::supports_save is
// false), so drive 3 is checked against our own writer instead: the sector the firmware wrote must read back.
const fs = require('fs'), path = require('path');
const { runMame } = require('../lib/mame');
const { loadEmu } = require('../lib/firmware');

function compare(t) {
  const Emu = loadEmu();
  let ok = true;
  // MAME, untraced, to completion
  const args = t.args;                       // writes fresh copies of the disks into the work directory
  // a MAME that failed (an image it could not load, any fatal error) or was killed saved nothing to compare: the
  // comparison fails, whatever our side does
  const r = runMame({ work: t.work, system: t.system, lua: '', seconds: t.seconds, args });
  if (r.status || r.signal) {
    console.log(`[${t.label} images] MAME did not run to its end (${r.signal ? `stopped by ${r.signal}` : `exit status ${r.status}`}): ${r.output.trim().split('\n').filter((l) => /Fatal error/.test(l)).join(' | ') || r.output.trim().split('\n').slice(-1)[0] || 'no message'}`);
    return 1;
  }
  // ours, to HALT
  const m = t.machine();
  let frames = 0;
  while (m.cpu.pc !== t.haltPc && frames < 60 * t.seconds) { m.runFrame(); frames++; }
  if (m.cpu.pc !== t.haltPc) { console.log(`[${t.label} images] our firmware did NOT reach HALT`); return 1; }
  const fdc = t.fdcOf(m);
  fdc.flush();
  const disks = t.setup.disks();
  disks.forEach((d, i) => {
    if (!d) return;
    const ours = fdc.drives[i].media.bytes;
    if (/\.dmk$/.test(d.name) && t.blank) {
      // a blank DMK, formatted: every track and side must hold sectors 1-18 of 256 bytes, each the track and
      // side's fill (gen-diag formatFill), as the firmware wrote them
      const { formatFill } = require('./gen-diag');
      const img = Emu.loadDisk(ours, 'dmk', { tracks: fdc.drives[i].tracks, heads: 2 });
      let bad = null;
      for (let tr = 0; tr < t.blank.tracks && !bad; tr++) for (let h = 0; h < t.blank.heads && !bad; h++) {
        const secs = Emu.readTrackSectors(img, tr, h);
        for (let n = 1; n <= 18 && !bad; n++) {
          const s = secs.find((x) => x.sector === n && x.track === tr);
          if (!s || s.data.length !== 256 || s.data.some((v) => v !== formatFill(tr, h))) bad = `track ${tr} side ${h} sector ${n}`;
        }
      }
      console.log(`[${t.label} images] drive ${i} ${d.name}: MAME cannot save DMK; ours ${bad ? `does NOT hold the formatted ${bad}` : `holds every sector the firmware formatted (${t.blank.tracks} x ${t.blank.heads} x 18)`}`);
      if (bad) ok = false;
      return;
    }
    if (/\.dmk$/.test(d.name)) {
      const changed = ours.length !== d.bytes.length || ours.some((v, k) => v !== d.bytes[k]);
      // the write firmware leaves drive 3 alone
      if (t.write) { console.log(`[${t.label} images] drive ${i} ${d.name}: ${changed ? 'CHANGED' : 'unchanged'} (not written by this firmware)`); if (changed) ok = false; return; }
      const img = Emu.loadDisk(ours, 'dmk', { tracks: fdc.drives[i].tracks, heads: 2 });
      const s = Emu.readTrackSectors(img, 3, 0).find((x) => x.sector === 8);
      const inv = require('./gen-diag').BOARDS[t.setup.board].inv;        // the WD2791 stores the complement
      const want = Array.from({ length: 256 }, (_, k) => ((0x44 + 3 * k) & 0xff) ^ inv);
      const good = changed && s && want.every((v, k) => s.data[k] === v);
      console.log(`[${t.label} images] drive ${i} ${d.name}: MAME cannot save DMK; ours ${changed ? 'rewritten' : 'unchanged'}, track 3 sector 8 ${good ? 'holds what the firmware wrote' : 'does NOT hold what the firmware wrote'}`);
      if (!good) ok = false;
      return;
    }
    const mame = fs.readFileSync(path.join(t.work, d.name));
    let first = -1;
    const n = Math.max(mame.length, ours.length);
    for (let k = 0; k < n; k++) if (mame[k] !== ours[k]) { first = k; break; }
    const changed = ours.some((v, k) => v !== d.bytes[k]) || ours.length !== d.bytes.length;
    const same = first < 0;
    console.log(`[${t.label} images] drive ${i} ${d.name}: ${mame.length} bytes from MAME, ${ours.length} from us: ${same ? 'identical' : `differ from byte ${first}`}` +
      `${d.writeProtected ? (changed ? ' (write-protected disk CHANGED)' : ' (write-protected: unchanged)') : (changed ? ' (written by the firmware)' : ' (NOT written)')}`);
    if (!same || (d.writeProtected ? changed : !changed)) ok = false;
  });
  return ok ? 0 : 1;
}

module.exports = { compare };
