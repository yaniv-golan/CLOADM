// Audio comparison for the Speech/Sound Pak's AY-3-8913 against MAME 0.264 (`<system> -ext ssc -wavwrite`). Both
// sides run our own firmware (gen-ay.js): the TMS7040 plays every AY step from its own reset, and the 6809 only
// opens the CoCo's sound mux.
//
//   node tools/mame-diff/ssc/audio.js [profile]          # coco (default), coco2b, coco3, dragon64; or SSC_PROFILE
//
// Two checks, both required:
//   1. WRITE TIMES. Every AY data write, its time on MAME's clock (a Lua tap on the PIC's port C) against ours:
//      the same count, and each within half a card cycle (the two clocks differ by 0.25 Hz in 894,886, which drifts
//      a third of a cycle over the 1.33 s program; measured worst 0.456 cycle, on the CoCo 3). This is where the
//      card's timing is pinned exactly.
//   2. LEVELS. Our machine's sound path, rendered through the port of MAME's resampler the cartridge comparisons
//      use (cart/audio.js), against MAME's recording at 48 kHz, 2 channels, within 2 LSB - compared at every
//      sample where BOTH recordings hold one value for three samples running, from the later of 20 ms (MAME's
//      first sound update period, as cart/audio.js) and the 6809's opening of the sound mux. Before the mux
//      opens the recording is the machine's own DAC and single-bit sound, which tools/mame-diff/sam/dac-sound.js
//      compares; the 6809 is in instruction lockstep with MAME (run.js <profile> --ssc), so that instant is the
//      same on both sides. Transitions are not part of the result: MAME's recording is one output sample
//      (1/48000 s) later than ours at every level change, on every model, with the writes themselves matching to
//      the cycle. That is the constant cart/audio.js measured for the cartridges, and with it every sample matches
//      too (reported on its own line), but where it comes from in MAME's sound path is not established
//      (docs/verification.md), so it is not applied to the result.
// The 2 LSB tolerance covers float rounding: MAME sums its streams and resamples them in 32-bit floats in its own
// order, and we do it in doubles in ours. It is not room for a level difference (the smallest AY level step here
// is 58 LSB).
const fs = require('fs'), path = require('path');
const { loadEmu, romImage, writeRoms } = require('../lib/firmware.js');
const { runMame } = require('../lib/mame.js');
const { readWav, resample, indexAt } = require('../cart/audio.js');
const { buildSp0256 } = require('./gen-roms.js');
const { ayPic, ayHost } = require('./gen-ay.js');

const OUT_RATE = 48000, SKIP = 960, TOLERANCE = 2;
// The AY-8913's stream is its clock / 8 (MAME's ay8910.cpp device_start). Its clock is coco_ssc.cpp's
// DERIVED_CLOCK(2, 1), twice the cartridge port's, so the stream is one sample per four card cycles
// (js/machines/ssc.js, AY_DIV): the port's clock x 2 / 8, 223,721.6 a second on the NTSC machines.
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
  // MAME's time 0 is the machine's power-on origin (one CPU cycle after our frame origin on the CoCo 3)
  const origin = m.powerOnTick();
  const frames = Math.ceil(seconds * m.fps) + 2;
  for (let f = 0; f < frames; f++) {
    m.runFrame();
    if (f < fromFrame) continue;                          // the frames before the command are not compared
    const firstTick = m.frameBase - m.frameCycles;
    for (let i = 0; i < m.audioEvents.length; i += 2) {
      // an event's offset is cycles into the frame that just ran, which began at firstTick; both are whole
      // machine ticks, but frameBase can carry a fraction after a mid-frame stop, so floor it
      const tick = Math.floor(firstTick + m.audioEvents[i]);
      pts.push({ time: BigInt(tick - origin) * units, level: m.audioEvents[i + 1] });
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

// ---- MAME's side: the same two programs, the Pak in the extension slot, recorded with -wavwrite; a Lua tap on
// the PIC's port C (>0108) prints the time of every AY data write (BDIR set, BC1 clear, the AY selected) ----
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
  // No pokes: the 6809 program opens the mux itself, so the same images run on both emulators. The tap only reads.
  const lua = `
local m = manager.machine
local pic = m.devices[":ext:ssc:pic7040"].spaces["program"]
local rows = {}
-- the tap is kept in a global: MAME removes a tap whose handle is collected
TAP = pic:install_write_tap(0x0108, 0x0108, "aywrites", function(off, data, mask)
  if (data & 0x49) == 0x08 then rows[#rows + 1] = string.format("AYW %.15f", m.time:as_double()) end
end)
emu.register_stop(function() for _, r in ipairs(rows) do print(r) end end)`;
  // -nocompressor: MAME's mixer otherwise scales its whole output down when a sum passes full scale and lets it
  // recover over about a quarter of a second (measured: x0.89 after this firmware's all-at-15 step). That is
  // MAME's host-side protection, not the Pak; with it off, an over-range sample is clipped like any other.
  const run = runMame({ work, system: profile.mame, lua, seconds,
    args: ['-wavwrite', wav, '-samplerate', String(OUT_RATE), '-nocompressor', '-ext', 'ssc'] });
  const writes = run.output.split('\n').filter((l) => l.startsWith('AYW ')).map((l) => Number(l.slice(4)));
  return { run, wav, work, writes };
}

// the whole comparison
async function compare({ profileId = 'coco', seconds = SECONDS } = {}) {
  if (!PROFILES.includes(profileId)) throw new Error(`the Speech/Sound Pak audio comparison covers ${PROFILES.join(', ')}, not ${profileId}`);
  const tag = `[${profileId} ssc audio]`;
  const { run, wav, writes: mameWrites } = mameRecord({ profileId, seconds });
  if (!fs.existsSync(wav)) {
    console.log(`${tag} MAME wrote no recording (status ${run.status}${run.signal ? ', ' + run.signal : ''})`);
    return 1;
  }
  const mame = readWav(wav);
  const n = Math.floor(seconds * OUT_RATE);
  if (mame.frames < n) { console.log(`${tag} MAME's recording is short: ${mame.frames} of ${n}`); return 1; }
  const m = ourMachine(profileId);
  // our write times, on the machine's clock from its power-on origin (MAME's time 0)
  const pak = m.cartPort, ours = [];
  const dataW = pak.ay.dataW;
  pak.ay.dataW = function (v) { ours.push(Number(pak.cardPos - BigInt(m.powerOnTick())) / m.tickHz); return dataW.call(this, v); };
  const pts = levelTimeline(m, seconds);
  pak.ay.dataW = dataW;

  // 1. write times, in card cycles of the port's clock
  const cyc = m.cartClockHz;
  let worstW = 0;
  for (let i = 0; i < Math.min(ours.length, mameWrites.length); i++) worstW = Math.max(worstW, Math.abs(ours[i] - mameWrites[i]) * cyc);
  const writesOk = ours.length === mameWrites.length && ours.length > 100 && worstW < 0.5;

  // 2. levels where both recordings are steady; the AY's stream is MAME's whole-hertz rate (js/machines/ssc.js,
  // mameAySamples: floor(floor(port clock) x 2 / 8), 223,721 on the CoCos)
  const out = renderTimeline(pts, n, Math.floor(Math.floor(cyc) * 2 / 8));
  const v = (i) => Math.trunc(Math.fround(Math.max(-1, Math.min(1, out[i])) * 32767.0));
  // the mux opens at the first change of our sound path (the AY's level is never 0 once it is heard); the margin
  // covers the resampler's latency, 5 AY samples, under one output sample
  const opened = pts.find((p) => p.level !== 0);
  if (!opened) { console.log(`${tag} our machine never opened the sound mux`); return 1; }
  const from = Math.max(SKIP, Math.ceil(Number(opened.time) * OUT_RATE / 1e18) + 2);
  let compared = 0, worst = 0, over = 0, firstBad = -1;
  const levels = new Set();
  for (let i = from + 1; i < n - 1; i++) {
    const o = v(i);
    if (v(i - 1) !== o || v(i + 1) !== o) continue;
    for (let c = 0; c < 2; c++) {
      const M = mame.channels[c];
      if (M[i - 1] !== M[i] || M[i + 1] !== M[i]) continue;
      compared++;
      levels.add(M[i]);
      const d = Math.abs(o - M[i]);
      if (d > worst) worst = d;
      if (d > TOLERANCE) { over++; if (firstBad < 0) firstBad = i; }
    }
  }
  // Every sample, transitions included, with our render read one output sample late: the constant cart/audio.js
  // measured for the cartridges (MAME's recording is 1/48000 s later than the resampler alone puts it). Its source
  // in MAME is not established, so this line is REPORTED ONLY and is not part of the result.
  let allWorst = 0, allOver = 0;
  for (let i = from + 1; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const d = Math.abs(v(i - 1) - mame.channels[c][i]);
      if (d > allWorst) allWorst = d;
      if (d > TOLERANCE) allOver++;
    }
  }
  // the proven program's fixed-level steps alone hold 60-odd distinct levels; far fewer means it did not play
  const levelsOk = over === 0 && compared > n && levels.size > 60;
  console.log(`${tag} AY data writes: ${ours.length} ours, ${mameWrites.length} MAME's, ` +
    `largest time difference ${worstW.toFixed(3)} card cycles (limit 0.5)`);
  console.log(`${tag} levels: ${compared} steady samples (of ${n} x 2) compared with MAME's -wavwrite at ${OUT_RATE} Hz ` +
    `(from sample ${from}): largest difference ${worst} LSB (tolerance ${TOLERANCE}), ${over} over it` +
    `${firstBad >= 0 ? `, first at sample ${firstBad} (${(firstBad / OUT_RATE).toFixed(4)} s): MAME ${mame.channels[0][firstBad]}, ours ${v(firstBad)}` : ''}; ` +
    `${levels.size} distinct levels`);
  console.log(`${tag} (reported only, not the result) every sample from ${from}, with cart/audio.js's one-sample ` +
    `delay: largest difference ${allWorst} LSB, ${allOver} over ${TOLERANCE}`);
  console.log(`${tag} RESULT: ${writesOk && levelsOk ? 'identical' : 'differs'}`);
  return writesOk && levelsOk ? 0 : 1;
}

module.exports = { ourMachine, levelTimeline, renderTimeline, mameRecord, compare, OUT_RATE, SKIP, TOLERANCE, SECONDS, PROFILES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const profileId = process.env.SSC_PROFILE || args.find((a) => !a.startsWith('--')) || 'coco';
  compare({ profileId, seconds: Number(process.env.SSC_AUDIO_SECONDS || SECONDS) })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e.stack); process.exitCode = 1; });
}
