// The Speech/Sound Pak's SP0256 SOUND against MAME 0.264 (`<system> -ext ssc -wavwrite`), on our own speech image
// (gen-voice.js; installed in MAME as sp0256-al2.bin, never a real SP0256-AL2) and our own firmware: the PIC loads
// the image's 24 tests as the chip asks for them (with two holds, so the chip halts twice), and the 6809 only opens
// the CoCo's sound mux (gen-ay.js's host program).
//
//   node tools/mame-diff/ssc/speech-audio.js [profile]   # coco (default), coco2b, coco3, dragon64; or SSC_PROFILE
//
// MAME records at the speech chip's own stream rate, -samplerate 9285 (3,120,000 / 336, its whole-hertz stream), so
// each recorded sample is one sample of the chip. Ours runs under config.mameCompat (the same grid). The level our
// Pak gives the machine's sound path (Machine.cartSound: the speech level plus the AY's, which is idle here but
// heard, since the mux is open), mixed with the machine's own sound as the page hears it, is read at each speech
// sample's stamp, two sample periods after its start
// (js/machines/ssc.js, SP_LAG), and converted as MAME writes a WAV sample: clamped to +-1, times 32,767, truncated.
// Required, from the later of the end of MAME's first 1/50 s sound update and the 6809's opening of the sound mux,
// to the end of MAME's recording:
//   every sample within 1 LSB of MAME's, our sample k against MAME's sample k + 1.
// The one-sample offset is the constant the cartridge and AY comparisons also see (cart/audio.js, ssc/audio.js):
// MAME's recording is one output sample later than its streams put it, from its first sound update on. In the first
// update MAME's resampler holds one sample twice at the update's end, so the first 1/50 s is left out, as in those
// comparisons. The 1 LSB covers float rounding: MAME resamples the AY's idle level from its 1.79 MHz stream with
// 32-bit float sums before adding it, which moves the sum by an ulp at some samples; measured, 1 sample in 18,564
// differs, by 1. It is not room for a speech difference (the image's smallest change is far larger).
// Also required: the image played to its end (all 24 address loads), the recording is not clipped, and it holds
// more than 1,000 distinct values (the speech is in it).
const fs = require('fs'), path = require('path');
const { loadEmu, romImage, writeRoms } = require('../lib/firmware.js');
const { runMame } = require('../lib/mame.js');
const { readWav } = require('../cart/audio.js');
const { ayHost } = require('./gen-ay.js');
const { voiceImage, voicePic, tests } = require('./gen-voice.js');

const RATE = 9285, SECONDS = 2, TOLERANCE = 1;
const SKIP = Math.ceil(RATE / 50) + 4;    // MAME's first sound update (1/50 s), and a margin
const PROFILES = ['coco', 'coco2b', 'coco3', 'dragon64'];

function machineRoms(profile) {
  const host = ayHost();
  return Object.fromEntries(profile.roms.map((r) => [r.id, romImage(host, r.at, r.size, 0x12)]));
}

// our side: the WAV samples our Pak's sound path gives, by speech sample index. `pic` and `image` default to
// gen-voice.js's (tests/ssc.test.js passes the ones MAME's recording was made with).
function ours(profileId = 'coco', { seconds = SECONDS, pic = voicePic(), image = voiceImage() } = {}) {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const m = Emu.createMachine(profileId, { mameCompat: true });
  m.setRoms(machineRoms(profile));
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: pic, sp0256Rom: image }));
  m.reset(true);
  const pak = m.cartPort, events = [];
  let loads = 0;
  const load = pak.sp0256.loadAddress.bind(pak.sp0256);
  pak.sp0256.loadAddress = (n) => { loads++; return load(n); };
  const frames = Math.ceil(seconds * m.fps) + 2;
  // the machine's sound path as the page hears it: its own level and the cartridge's, mixed (audioEvents), each
  // event's offset counted from the frame's first tick (ssc/audio.js levelTimeline)
  for (let f = 0; f < frames; f++) {
    m.runFrame();
    const firstTick = m.frameBase - m.frameCycles;
    for (let i = 0; i < m.audioEvents.length; i += 2) events.push([Math.floor(firstTick + m.audioEvents[i]), m.audioEvents[i + 1]]);
  }
  // speech sample k is heard from its stamp: SP_LAG (2) periods after its start, on the chip's grid
  const g = pak.spGrid(), origin = BigInt(Math.round(m.powerOnTick()));
  const n = Math.floor(seconds * RATE);
  const out = new Int16Array(n);
  let e = 0, level = 0;
  for (let k = 0; k < n; k++) {
    const stamp = Number(origin + pak.spStart(BigInt(k) + 2n, g) / m.unitAttos);
    while (e < events.length && events[e][0] <= stamp) level = events[e++][1];
    out[k] = Math.trunc(Math.max(-1, Math.min(1, Math.fround(level))) * 32767);
  }
  return { samples: out, loads };
}

function mame(profileId = 'coco', seconds = SECONDS) {
  const Emu = loadEmu();
  const profile = Emu.profiles[profileId];
  const work = `/tmp/mame-diff/${profileId}-ssc-voice`;
  const wav = path.join(work, 'mame.wav');
  fs.rmSync(work, { recursive: true, force: true });
  const roms = machineRoms(profile);
  writeRoms(work, profile.mame, Object.fromEntries(profile.roms.map((r) => [r.files[0], roms[r.id]])));
  // both are OUR images under MAME's file names: never a real SP0256-AL2 or PIC dump (AGENTS.md hard rule 1)
  writeRoms(work, 'coco_ssc', { 'pic-7040-510.bin': voicePic(), 'sp0256-al2.bin': voiceImage() });
  // -nocompressor: with it on, MAME scales its whole output down after a loud sum (ssc/audio.js)
  const run = runMame({ work, system: profile.mame, lua: '', seconds,
    args: ['-wavwrite', wav, '-samplerate', String(RATE), '-nocompressor', '-ext', 'ssc'] });
  if (!fs.existsSync(wav)) throw new Error(`MAME wrote no recording (status ${run.status}${run.signal ? ', ' + run.signal : ''})`);
  const w = readWav(wav);
  if (w.rate !== RATE) throw new Error(`MAME recorded at ${w.rate} Hz, not ${RATE}`);
  return { samples: w.channels[0], right: w.channels[1] };
}

// our samples against MAME's (ours k against MAME's k + 1), from the later of SKIP and the 6809's opening of the
// sound mux (the first change of our level, the AY's idle level becoming heard) to the end of MAME's recording.
// Before the mux opens the recording is the machine's own sound, which tools/mame-diff/sam/dac-sound.js compares
// (on the CoCo 3 it differs here, -8,191 against 0, until the mux opens; the 6809 is in lockstep with MAME, so that
// instant is the same on both sides).
function compareSamples(o, M) {
  let opened = 0;
  while (opened < o.length && o[opened] === 0) opened++;
  // + 4: the sample the mux opens on is gated by MAME when it mixes and by us when the sample is made (one sample
  // apart on the CoCo 3, measured)
  const from = Math.max(SKIP, opened + 4);
  let compared = 0, worst = 0, over = 0, firstBad = -1, clipped = 0;
  for (let k = from; k + 1 < M.length && k < o.length; k++) {
    const d = Math.abs(o[k] - M[k + 1]);
    compared++;
    if (d > worst) worst = d;
    if (d > TOLERANCE) { over++; if (firstBad < 0) firstBad = k; }
    if (Math.abs(M[k + 1]) >= 32767) clipped++;
  }
  const distinct = new Set(M).size;
  return { from, compared, worst, over, firstBad, clipped, distinct };
}

function compare({ profileId = 'coco' } = {}) {
  if (!PROFILES.includes(profileId)) throw new Error(`the speech sound comparison covers ${PROFILES.join(', ')}, not ${profileId}`);
  const tag = `[${profileId} ssc speech sound]`;
  const M = mame(profileId), O = ours(profileId);
  const r = compareSamples(O.samples, M.samples);
  const sameRight = M.samples.every((v, i) => v === M.right[i]);
  const expected = tests().length;
  const ok = r.over === 0 && r.compared > 15000 && r.clipped === 0 && r.distinct > 1000 && O.loads === expected && sameRight;
  console.log(`${tag} ${r.compared} samples at ${RATE} Hz compared with MAME's -wavwrite (from sample ${r.from}, ours k ` +
    `against MAME's k + 1): largest difference ${r.worst} LSB (tolerance ${TOLERANCE}), ${r.over} over it` +
    `${r.firstBad >= 0 ? `, first at sample ${r.firstBad}: ours ${O.samples[r.firstBad]}, MAME's ${M.samples[r.firstBad + 1]}` : ''}`);
  console.log(`${tag} ${O.loads} of ${expected} address loads; MAME's recording: ${r.distinct} distinct values, ` +
    `${r.clipped} clipped, both channels the same: ${sameRight}`);
  console.log(`${tag} RESULT: ${ok ? 'identical' : 'differs'}`);
  return ok ? 0 : 1;
}

module.exports = { ours, mame, compareSamples, compare, RATE, SECONDS, SKIP, TOLERANCE, PROFILES };

if (require.main === module) {
  const profileId = process.env.SSC_PROFILE || process.argv.slice(2).find((a) => !a.startsWith('--')) || 'coco';
  try { process.exitCode = compare({ profileId }); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
