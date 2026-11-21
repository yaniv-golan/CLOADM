// run.js <dragon64|dragon32|coco|...> --sound: the SAM machines' sound output (the 6-bit DAC and the single-bit
// sound) against MAME's -wavwrite, through the command line's recording path.
// dac-sound.asm (our firmware, in place of the BASIC ROM) plays five segments: DAC square waves at two pitches,
// at half the swing, in the upper half, and the single-bit sound. Ours: the machine's level events of every frame
// through the page's output stage without its DC filter (js/host/audio.js AudioOutput, highPass false), as
// `cloadm --wav` records them, at MAME's sample rate. MAME's recording is lined up on the first segment's start.
// Over the middle 80% of each segment:
//   fundamental (rising crossings of the AC part): within 1%
//   RMS of the AC part, scaled by one factor for the whole run (MAME's output level is its own; the factor comes
//   from segment 1): within 0.5% in every other segment, which checks the DAC's scale, its upper half and the
//   single-bit sound's level against the DAC (a single-bit level of 31.5 DAC steps instead of 32 is 1.5% off)
//   mean level (DC), as ours x that factor + one offset (MAME's output sits lower: its silent level is not 0; the
//   offset comes from segment 1): within 0.5% of segment 1's RMS in every other segment, which checks where each
//   segment's levels sit, not just their swing (MAME does not block DC: its means follow the levels)
// Not sample by sample: MAME resamples its stream through its own filter and starts its sample clock elsewhere (as
// alpha/sound-compare.js).
const fs = require('fs'), path = require('path');
const { loadEmu, assembleFile, romImage, writeProfileRoms } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir, keepWorkDir } = require('../lib/workdir');
const { readWav, onset, stats } = require('../alpha/sound-compare.js');

const RATE = 48000;
const TOL = { freq: 0.01, rms: 0.005, mean: 0.005 };
const NAMES = ['DAC 63/0 fast', 'DAC 63/0 slow', 'DAC 32/0', 'DAC 63/32', 'single-bit'];

function compare(profileId, { work = workDir(`${profileId}-dac-sound`), keep = false } = {}) {
  if (keep) keepWorkDir(work, '--keep');
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const asm = assembleFile(path.join(__dirname, 'dac-sound.asm'), '6809');
  const image = romImage(asm, 0x8000, 0x4000, 0x12);
  const slots = {};
  for (const sl of profile.roms) if (!sl.chip) slots[sl.id] = image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  const halt = asm.symbols.get('HALT'), PHASE = asm.symbols.get('PHASE');
  // ---- ours: every frame's level events through the recording's output stage, the cycle each phase starts
  const m = Emu.createMachine(profileId, { mameCompat: true });
  m.setRoms(slots); m.reset(true);
  const chunks = [];
  const out = new Emu.AudioOutput(RATE, { buffered: () => 0, write: (c) => chunks.push(c) }, { highPass: false });
  out.volume = 1;
  const phases = [];
  let lastPhase = 0;
  const frame = () => {
    m.runFrame();
    out.push(m.audioEvents, m.frameCycles, m.fps);
    if (m.ram[PHASE] !== lastPhase) { lastPhase = m.ram[PHASE]; phases.push([lastPhase, m.frameBase]); }
  };
  for (let f = 0; f < 60 * 10 && m.cpu.pc !== halt; f++) frame();
  if (m.cpu.pc !== halt) { console.log(`[${profileId} dac sound] our firmware did NOT reach HALT`); return 1; }
  for (let f = 0; f < 25; f++) frame();
  const ours = Float64Array.from(chunks.flatMap((c) => Array.from(c)));
  // ---- MAME
  fs.mkdirSync(work, { recursive: true });
  writeProfileRoms(work, profile, slots);
  const wavFile = path.join(work, 'mame.wav');
  try { fs.unlinkSync(wavFile); } catch (e) { /* none */ }
  runMame({ work, system: profile.mame, lua: '', seconds: Math.ceil(m.frameBase / m.tickHz) + 1, args: ['-ext', '', '-wavwrite', wavFile, '-samplerate', String(RATE)] });
  const mw = readWav(wavFile);
  if (mw.rate !== RATE) { console.log(`[${profileId} dac sound] MAME wrote ${mw.rate} Hz, not ${RATE}`); return 1; }
  const mame = mw.samples;
  // ---- segments: phase 2k+1 starts segment k+1, 2k+2 ends it (frame resolution, our time); one alignment
  const at = (ph) => { const p = phases.find((x) => x[0] === ph); return p ? Math.floor((p[1] - m.frameCycles) / m.tickHz * RATE) : -1; };
  const first = at(1);
  const o1 = onset(ours, first), w1 = onset(mame, Math.max(1, first - RATE / 10), 0.002);
  if (o1 < 0 || w1 < 0) { console.log(`[${profileId} dac sound] the first segment's start was not found (ours ${o1}, MAME ${w1})`); return 1; }
  const shift = w1 - o1;
  console.log(`[${profileId} dac sound] MAME's recording lined up ${(shift / RATE * 1000).toFixed(2)} ms after ours (first step at ${(o1 / RATE).toFixed(4)} s); ${ours.length} samples ours, ${mame.length} MAME's`);
  const seg = NAMES.map((name, k) => {
    const start = at(2 * k + 1), end = at(2 * k + 2);
    if (start < 0 || end < 0) return { name, missing: true };
    const len = end - start, a = start + Math.floor(len * 0.1), b = start + Math.floor(len * 0.9);
    if (b + shift > mame.length) return { name, missing: true };
    return { name, so: stats(ours, a, b), sm: stats(mame, a + shift, b + shift) };
  });
  if (seg.some((s) => s.missing)) { console.log(`[${profileId} dac sound] segments not found: ${seg.filter((s) => s.missing).map((s) => s.name).join(', ')}`); return 1; }
  const scale = seg[0].sm.rms / seg[0].so.rms, offset = seg[0].sm.mean - seg[0].so.mean * scale, unit = seg[0].sm.rms;
  console.log(`[${profileId} dac sound] MAME's level is ${scale.toFixed(5)} x ours ${offset < 0 ? '-' : '+'} ${Math.abs(offset).toFixed(5)} (from segment 1)`);
  let ok = true;
  seg.forEach(({ name, so, sm }, k) => {
    const dF = Math.abs(so.freq - sm.freq) / sm.freq, dR = Math.abs(so.rms * scale - sm.rms) / sm.rms;
    const dM = Math.abs(so.mean * scale + offset - sm.mean) / unit;
    const pass = dF <= TOL.freq && (k === 0 || (dR <= TOL.rms && dM <= TOL.mean));
    console.log(`[${profileId} dac sound] ${pass ? 'ok  ' : 'FAIL'} ${name}: frequency ${so.freq.toFixed(1)} / ${sm.freq.toFixed(1)} Hz (${(dF * 100).toFixed(2)}%), ` +
      `RMS ${(so.rms * scale).toFixed(5)} / ${sm.rms.toFixed(5)} (${k === 0 ? 'the scale' : `${(dR * 100).toFixed(2)}%`}), ` +
      `mean ${(so.mean * scale + offset).toFixed(5)} / ${sm.mean.toFixed(5)} (${k === 0 ? 'the offset' : `${(dM * 100).toFixed(2)}% of segment 1's RMS`}) (ours scaled / MAME)`);
    if (!pass) ok = false;
  });
  if (!keep) try { fs.unlinkSync(wavFile); } catch (e) { /* none */ }
  console.log(`[${profileId} dac sound] ${ok ? 'every segment within tolerance' : 'NOT within tolerance'}`);
  return ok ? 0 : 1;
}

module.exports = { compare, TOL };
