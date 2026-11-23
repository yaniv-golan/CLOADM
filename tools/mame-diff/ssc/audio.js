// Audio comparison for the Speech/Sound Pak's AY-3-8913: MAME 0.264 records the AY case's sound with -wavwrite;
// we run the same firmware and render our machine's sound path through the same resampler the cartridge
// comparisons use (cart/audio.js). Both sides run our own firmware (gen-ay.js): the TMS7040 plays every AY step
// from its own reset, and the 6809 only opens the CoCo's sound mux.
//
//   node tools/mame-diff/ssc/audio.js [profile]        # coco (default), coco2b, coco3, dragon64; or SSC_PROFILE
//
// Same constants as the cartridges: 48 kHz, 2 channels, the first 960 output samples (20 ms) skipped, 2 LSB
// tolerance (cart/audio.js). The tolerance covers float rounding: MAME sums its streams and resamples them in
// 32-bit floats in its own order, and we do it in doubles in ours; it is not room for a level or a timing
// difference (one AY level step is at least 100 LSB here, and one sample of timing moves a tone edge by
// thousands). It is stated in docs/verification.md.
const fs = require('fs'), path = require('path');
const { loadEmu, romImage, writeRoms } = require('../lib/firmware.js');
const { runMame } = require('../lib/mame.js');
const { readWav, resample, indexAt } = require('../cart/audio.js');
const { buildSp0256 } = require('./gen-roms.js');
const { ayPic, ayHost } = require('./gen-ay.js');

const OUT_RATE = 48000, SKIP = 960, TOLERANCE = 2;
// The AY-8913's stream is its clock / 8 (MAME's ay8910.cpp device_start). Its clock is coco_ssc.cpp's
// DERIVED_CLOCK(2, 1), twice the machine's cycle rate, so the stream is one sample per four card cycles
// (js/machines/ssc.js, AY_DIV): 223,721.6 a second on the NTSC machines.
const AY_DIV = 4;
const SECONDS = 6;
// the models the page offers the Pak on (js/machines/profiles.js's `ssc` option)
const PROFILES = ['coco', 'coco2b', 'coco3', 'dragon64'];

// The machine's ROM sockets, each holding the 6809 program laid at its own base and size (as ssc/spec.js does).
function machineRoms(profile) {
  const host = ayHost();
  return Object.fromEntries(profile.roms.map((r) => [r.id, romImage(host, r.at, r.size, 0x12)]));
}

// machine -> the AY case's PIC program in the Pak, and the mux-opening 6809 program in the BASIC socket(s)
function ourMachine(profileId = 'coco') {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const m = Emu.createMachine(profileId, { mameCompat: true });
  // the cartridge is inserted BEFORE the reset: a reset after insertCartridge() would clear what the insert set up
  m.setRoms(machineRoms(profile));
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: ayPic(), sp0256Rom: buildSp0256() }));
  m.reset(true);
  return m;
}

// The machine's sound path as a level timeline in attoseconds. mixCartAudio() has already folded the cartridge's
// level into audioEvents by the end of each frame, so only audioEvents is read. An event's `cycle` offset is
// relative to the frame that just ran, whose first tick is `frameBase - frameCycles` once the frame is complete.
function levelTimeline(m, seconds, fromFrame = 0) {
  const pts = [];                                         // { time (attoseconds), level }
  const units = m.unitAttos;
  const frames = Math.ceil(seconds * m.fps) + 2;
  for (let f = 0; f < frames; f++) {
    m.runFrame();
    if (f < fromFrame) continue;                          // the frames before the command are not compared
    const firstTick = m.frameBase - m.frameCycles;
    for (let i = 0; i < m.audioEvents.length; i += 2) {
      // an event's offset is cycles into the frame that just ran, which began at firstTick; both are whole
      // machine ticks, but frameBase can carry a fraction after a mid-frame stop, so floor it
      const tick = Math.floor(firstTick + m.audioEvents[i]);
      pts.push({ time: BigInt(tick) * units, level: m.audioEvents[i + 1] });
    }
  }
  return pts;
}

// Expand the timeline into a step stream at `rate` and resample it to OUT_RATE, through the port of MAME's
// resampler the cartridge comparisons use (cart/audio.js: the average over each output period).
function renderTimeline(pts, n, rate) {
  const count = Math.ceil(n * rate / OUT_RATE) + 4096;
  const idx = pts.map((p) => indexAt(rate, p.time));
  const step = new Float32Array(count);
  let i = 0, level = 0;
  for (let k = 0; k < count; k++) {
    while (i < idx.length && idx[i] <= k) level = pts[i++].level;
    step[k] = level;
  }
  return resample((k) => step[Math.min(k, count - 1)], rate, n);
}

// ---- MAME's side: the same two programs, the Pak in the extension slot, recorded with -wavwrite ----
function mameRecord({ profileId = 'coco', seconds = SECONDS } = {}) {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const work = `/tmp/mame-diff/${profileId}-ssc-audio`;
  const wav = path.join(work, 'mame.wav');
  fs.rmSync(work, { recursive: true, force: true });
  const roms = machineRoms(profile);
  writeRoms(work, profile.mame, Object.fromEntries(profile.roms.map((r) => [r.files[0], roms[r.id]])));
  // the Pak's romset under MAME's names: our AY program and the hand-built SP0256 data
  writeRoms(work, 'coco_ssc', { 'pic-7040-510.bin': ayPic(), 'sp0256-al2.bin': buildSp0256() });
  // No Lua pokes: the 6809 program opens the mux itself, so the same images run on both emulators.
  const lua = `emu.register_frame_done(function() end)`;
  // -wavwrite records even with baseArgs' '-sound none' (the orch90 comparison records 59,492 samples with sound
  // under it), so nothing is overridden: the same argument shape cart/audio.js uses, the slot option last.
  const run = runMame({ work, system: profile.mame, lua, seconds,
    // -nocompressor: MAME's mixer otherwise scales its whole output down when a sum passes full scale and lets it
    // recover over about a quarter of a second (measured: x0.89 after this firmware's all-at-15 step). That is
    // MAME's host-side protection, not the Pak; with it off, an over-range sample is clipped like any other.
    args: ['-wavwrite', wav, '-samplerate', String(OUT_RATE), '-nocompressor', '-ext', 'ssc'] });
  return { run, wav, work };
}

// the whole comparison
async function compare({ profileId = 'coco', seconds = SECONDS } = {}) {
  if (!PROFILES.includes(profileId)) throw new Error(`the Speech/Sound Pak audio comparison covers ${PROFILES.join(', ')}, not ${profileId}`);
  const { run, wav } = mameRecord({ profileId, seconds });
  if (!fs.existsSync(wav)) {
    console.log(`[${profileId} ssc audio] MAME wrote no recording (status ${run.status}${run.signal ? ', ' + run.signal : ''})`);
    return 1;
  }
  const mame = readWav(wav);
  const n = Math.floor(seconds * OUT_RATE);
  if (mame.frames < n) { console.log(`[${profileId} ssc audio] MAME's recording is short: ${mame.frames} of ${n}`); return 1; }
  const m = ourMachine(profileId);
  const pts = levelTimeline(m, seconds);
  // the AY's stream rate on this machine: its cycle rate x 2 / 8
  const ours = renderTimeline(pts, n, Math.round(m.tickHz * 2 / 8));
  let worst = 0, over = 0, firstBad = -1, sound = 0, early = 0;
  const levels = new Set();
  for (let i = 10; i < n; i++) {
    const v = Math.trunc(Math.fround(Math.max(-1, Math.min(1, ours[i])) * 32767.0));
    for (let c = 0; c < 2; c++) {
      const d = Math.abs(v - mame.channels[c][i]);
      if (i < SKIP) { if (d > TOLERANCE) early++; continue; }
      // MAME's recording is 0 while the mux has not opened the Pak's output (set_sound_enable's gain 0)
      if (mame.channels[c][i] !== 0) sound++;
      levels.add(mame.channels[c][i]);
      if (d > worst) worst = d;
      if (d > TOLERANCE) { over++; if (firstBad < 0) firstBad = i; }
    }
  }
  // the firmware's fixed-level steps alone give 60-odd distinct levels; far fewer means it did not play
  const ok = over === 0 && sound > n && levels.size > 60;
  console.log(`[${profileId} ssc audio] ${n} samples x 2 channels at ${OUT_RATE} Hz compared with MAME's -wavwrite ` +
    `(first ${SKIP} skipped): largest difference ${worst} LSB (tolerance ${TOLERANCE}), ${over} samples over it` +
    `${firstBad >= 0 ? `, first at sample ${firstBad} (${(firstBad / OUT_RATE).toFixed(4)} s)` : ''}; ` +
    `${pts.length} level changes; ${sound} samples with sound, ${levels.size} distinct levels; ` +
    `in the skipped first period ${early} over the tolerance`);
  return ok ? 0 : 1;
}

module.exports = { ourMachine, levelTimeline, renderTimeline, mameRecord, compare, AY_DIV, OUT_RATE, SKIP, TOLERANCE, SECONDS, PROFILES };

if (require.main === module) {
  const profileId = process.env.SSC_PROFILE || process.argv[2] || 'coco';
  compare({ profileId, seconds: Number(process.env.SSC_AUDIO_SECONDS || SECONDS) })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e.stack); process.exitCode = 1; });
}
