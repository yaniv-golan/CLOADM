// Audio comparison for the Speech/Sound Pak's AY-3-8913: MAME 0.264 records the tone firmware's
// sound with -wavwrite; we run the same firmware and render our machine's sound path through the same resampler
// the cartridge comparisons use (cart/audio.js). Both sides run our own TMS7040 firmware
// (tools/mame-diff/ssc/ssc-tone.asm), which programs the AY's mixer, two tone periods and two volumes and then
// changes the frequency twice.
//
//   node tools/mame-diff/ssc/audio.js
//
// Same constants as the cartridges: 48 kHz, 2 channels, the first 960 output samples (20 ms) skipped, 2 LSB
// tolerance (cart/audio.js). The tolerance covers float rounding in the order MAME sums its streams; it is stated
// in the README.
const fs = require('fs'), path = require('path');
const { loadEmu, romImage, assembleFile, writeProfileRoms, writeRoms } = require('../lib/firmware.js');
const { runMame, baseArgs } = require('../lib/mame.js');
const { readWav, resample, indexAt } = require('../cart/audio.js');
const { buildSp0256, buildAsm, OUT: SSC_ROM_OUT } = require('./gen-roms.js');

const HERE = __dirname;
const OUT_RATE = 48000, SKIP = 960, TOLERANCE = 2;
// the SSC speaker's silence level in this recording, measured (see the note in compare())
const SILENCE_LSB = 0;
// The AY-8913's stream is clock / 8 (js/chips/ay8910.js, from MAME's ay8910.cpp). The card and the AY run at the
// 6809's cycle rate: coco_ssc.cpp's DERIVED_CLOCK(2, 1) with tms7000.cpp's divider of 2.
const CARD_HZ = 894886.25;
const AY_RATE = Math.round(CARD_HZ / 8);
const SECONDS = 6;

function toneFirmware() {
  return romImage(assembleFile(path.join(HERE, 'ssc-tone.asm'), '7000'), 0xF000, 0x1000, 0xFF);
}

// The 6809 firmware drives everything - it selects the mux and issues the commands on its own schedule - so
// there is no trigger frame and no poke on either side. (Earlier revisions poked $FF7E from Lua at a chosen
// frame; that is gone, and these constants were what remained of it.)
const MACHINE = 'coco';

// machine -> the tone firmware as the Pak's PIC, and the mux-selecting 6809 firmware in the BASIC socket, so the
// CoCo's own code opens the sound mux and issues the commands - no Lua pokes on either side.
function ourMachine() {
  const Emu = loadEmu();
  const asm = buildAsm({ mux: true });
  const rom = romImage(asm, 0xA000, 0x2000, 0x12);
  const m = Emu.createMachine(MACHINE, { mameCompat: true });   // the SSC's machine (ssc/spec.js)
  // the order matters: setRoms picks the `bas`/`extbas` slot names of the coco profile, and the cartridge is
  // inserted BEFORE the reset - a reset after insertCartridge() would clear what the insert set up
  m.setRoms({ bas: rom, extbas: new Uint8Array(0x2000).fill(0x12) });
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: buildSp0256() }));
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

// ---- MAME's side: the same firmware as the CoCo's BASIC ROM (`coco`, not `coco3`), the Pak in the ----
// ---- extension slot, recorded with -wavwrite ----
function mameRecord({ seconds = SECONDS, work = '/tmp/mame-diff/ssc-audio' } = {}) {
  const Emu = loadEmu();
  const wav = path.join(work, 'mame.wav');
  fs.rmSync(work, { recursive: true, force: true });
  try { fs.unlinkSync(wav); } catch (e) { /* none */ }
  writeProfileRoms(work, Emu.profiles.coco, {
    bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12),
    extbas: new Uint8Array(0x2000).fill(0x12),
  });
  // the Pak's romset under MAME's names: our tone firmware and the hand-built SP0256 data
  writeRoms(work, 'coco_ssc', { 'pic-7040-510.bin': toneFirmware(), 'sp0256-al2.bin': buildSp0256() });
  // The 6809 firmware (ssc.asm with the mux case) does everything itself: it selects the cartridge on the CoCo's
  // sound mux (PIA0 CRB / PIA1 CRB, the condition coco.cpp:555 tests), drives the Pak, and runs its commands.
  // No Lua pokes: the same 6809 image runs on both emulators, so there is nothing to keep in step by hand.
  const lua = `emu.register_frame_done(function() end)`;
  // -wavwrite records even with baseArgs' '-sound none' (the orch90 comparison records 59,492 samples with sound
  // under it), so nothing is overridden: the same argument shape cart/audio.js uses, the slot option last.
  const run = runMame({ work, system: MACHINE, lua, seconds,
    args: ['-wavwrite', wav, '-samplerate', String(OUT_RATE), '-ext', 'ssc'] });
  return { run, wav, work };
}

// the whole comparison
async function compare({ seconds = SECONDS } = {}) {
  const { run, wav } = mameRecord({ seconds });
  if (!fs.existsSync(wav)) {
    console.log(`[ssc audio] MAME wrote no recording (status ${run.status}${run.signal ? ', ' + run.signal : ''})`);
    return 1;
  }
  const mame = readWav(wav);
  const n = Math.floor(seconds * OUT_RATE);
  if (mame.frames < n) { console.log(`[ssc audio] MAME's recording is short: ${mame.frames} of ${n}`); return 1; }
  const m = ourMachine();
  const pts = levelTimeline(m, seconds);
  const ours = renderTimeline(pts, n, AY_RATE);
  let worst = 0, over = 0, firstBad = -1, sound = 0, early = 0;
  for (let i = 10; i < n; i++) {
    const v = Math.trunc(Math.fround(Math.max(-1, Math.min(1, ours[i])) * 32767.0));
    for (let c = 0; c < 2; c++) {
      const d = Math.abs(v - mame.channels[c][i]);
      if (i < SKIP) { if (d > TOLERANCE) early++; continue; }
      // Counted against SILENCE_LSB, this recording's own measured silence level (0: the most common value when
      // the AY is muted). It is NOT the -8191 the machine's own DAC stream idles at, which is why it is named
      // here rather than assumed - hard-coding -8191 would have counted silence as sound.
      if (mame.channels[c][i] !== SILENCE_LSB) sound++;
      if (d > worst) worst = d;
      if (d > TOLERANCE) { over++; if (firstBad < 0) firstBad = i; }
    }
  }
  const ok = over === 0 && sound > n / 10;
  console.log(`[ssc audio] ${n} samples x 2 channels at ${OUT_RATE} Hz compared with MAME's -wavwrite ` +
    `(first ${SKIP} skipped): largest difference ${worst} LSB (tolerance ${TOLERANCE}), ${over} samples over it` +
    `${firstBad >= 0 ? `, first at sample ${firstBad} (${(firstBad / OUT_RATE).toFixed(4)} s)` : ''}; ` +
    `${pts.length} level changes; ${sound} samples with sound; in the skipped first period ${early} over the tolerance`);
  return ok ? 0 : 1;
}

module.exports = { toneFirmware, ourMachine, levelTimeline, renderTimeline, mameRecord, compare, AY_RATE, OUT_RATE, SKIP, TOLERANCE, SECONDS };

if (require.main === module) {
  compare({ seconds: Number(process.env.SSC_AUDIO_SECONDS || SECONDS) })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e.stack); process.exitCode = 1; });
}
