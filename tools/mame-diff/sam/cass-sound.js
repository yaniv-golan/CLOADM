// run.js <dragon64|dragon32|coco|...> --cass-sound: the cassette input heard through the SAM machines' sound mux,
// against MAME's -wavwrite. cass-sound.asm (our firmware, in place of the BASIC ROM) selects the mux's sources while a
// tape we build here plays (a leader of $55 bytes, no ROM code), as BASIC's AUDIO ON does: see that file for the
// segments. Ours: the machine's level events through the command line's recording path (AudioOutput without its DC
// filter, as `cloadm --wav`); both recordings lined up on segment 1 (a DAC square wave, which also gives the scale and
// offset, as sam/dac-sound.js). Over the middle 80% of each segment:
//   RMS of the AC part, ours scaled: within TOL.rms of MAME's, as a fraction of segment 1's RMS (a silent segment
//   must be silent in both, a heard tape heard at the same level)
//   fundamental (rising crossings) where the tape is heard: within TOL.freq (the tape's tone, not something else)
//   mean level (DC): within TOL.mean of segment 1's RMS (where the mux's cassette bias sits)
// MAME 0.264 mixes no tape signal into the sound output (its cassette device's speaker is not routed to it on these
// drivers): with the cassette selected it outputs the bias alone, 32 DAC steps, and so does the machine. The tape
// heard is the page's "Tape sound", on the host side (js/host/tape-sound.js), not machine state.
const fs = require('fs'), path = require('path');
const { loadEmu, assembleFile, romImage, writeProfileRoms } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir, keepWorkDir } = require('../lib/workdir');
const { readWav, onset, stats } = require('../alpha/sound-compare.js');

const RATE = 48000;
const TOL = { freq: 0.02, rms: 0.05, mean: 0.05 };
const NAMES = ['DAC 63/0', 'cassette, sound on, motor on', 'cassette, sound off', 'cassette, motor off', 'DAC 0, motor on'];
// the tape: a long leader ($55), whose signal alternates the two bit frequencies
const tapeBytes = () => new Uint8Array(6000).fill(0x55);

// our machine running the firmware with the tape in the deck -> { m, slots, halt, PHASE, bytes } (tests/regress.test.js
// hashes its sound)
function setup(profileId) {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const asm = assembleFile(path.join(__dirname, 'cass-sound.asm'), '6809');
  const image = romImage(asm, 0x8000, 0x4000, 0x12);
  const slots = {};
  for (const sl of profile.roms) if (!sl.chip) slots[sl.id] = image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  const bytes = tapeBytes();
  const m = Emu.createMachine(profileId, { mameCompat: true });
  m.setRoms(slots); m.reset(true);
  m.deck.insert(new Emu.Tape(bytes, m.tickHz, 'leader.cas', m.profile.tape));
  return { m, slots, halt: asm.symbols.get('HALT'), PHASE: asm.symbols.get('PHASE'), bytes };
}

function compare(profileId, { work = workDir(`${profileId}-cass-sound`), keep = false } = {}) {
  if (keep) keepWorkDir(work, '--keep');
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  // ---- ours
  const { m, slots, halt, PHASE, bytes } = setup(profileId);
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
  if (m.cpu.pc !== halt) { console.log(`[${profileId} cassette sound] our firmware did NOT reach HALT`); return 1; }
  for (let f = 0; f < 25; f++) frame();
  const ours = Float64Array.from(chunks.flatMap((c) => Array.from(c)));
  // ---- MAME
  fs.mkdirSync(work, { recursive: true });
  writeProfileRoms(work, profile, slots);
  const wavFile = path.join(work, 'mame.wav'), cas = path.join(work, 'leader.cas');
  fs.writeFileSync(cas, bytes);
  try { fs.unlinkSync(wavFile); } catch (e) { /* none */ }
  const lua = 'for tag, c in pairs(manager.machine.cassettes) do c:play() end';
  runMame({ work, system: profile.mame, lua, seconds: Math.ceil(m.frameBase / m.tickHz) + 1, args: ['-ext', '', '-cass', cas, '-wavwrite', wavFile, '-samplerate', String(RATE)] });
  const mw = readWav(wavFile);
  if (mw.rate !== RATE) { console.log(`[${profileId} cassette sound] MAME wrote ${mw.rate} Hz, not ${RATE}`); return 1; }
  const mame = mw.samples;
  // ---- segments (as sam/dac-sound.js)
  const at = (ph) => { const p = phases.find((x) => x[0] === ph); return p ? Math.floor((p[1] - m.frameCycles) / m.tickHz * RATE) : -1; };
  const first = at(1);
  const o1 = onset(ours, first), w1 = onset(mame, Math.max(1, first - RATE / 10), 0.002);
  if (o1 < 0 || w1 < 0) { console.log(`[${profileId} cassette sound] the first segment's start was not found (ours ${o1}, MAME ${w1})`); return 1; }
  const shift = w1 - o1;
  console.log(`[${profileId} cassette sound] MAME's recording lined up ${(shift / RATE * 1000).toFixed(2)} ms after ours; ${ours.length} samples ours, ${mame.length} MAME's`);
  const seg = NAMES.map((name, k) => {
    const start = at(2 * k + 1), end = at(2 * k + 2);
    if (start < 0 || end < 0) return { name, missing: true };
    const len = end - start, a = start + Math.floor(len * 0.1), b = start + Math.floor(len * 0.9);
    if (b + shift > mame.length) return { name, missing: true };
    return { name, so: stats(ours, a, b), sm: stats(mame, a + shift, b + shift) };
  });
  if (seg.some((s) => s.missing)) { console.log(`[${profileId} cassette sound] segments not found: ${seg.filter((s) => s.missing).map((s) => s.name).join(', ')}`); return 1; }
  const scale = seg[0].sm.rms / seg[0].so.rms, offset = seg[0].sm.mean - seg[0].so.mean * scale, unit = seg[0].sm.rms;
  console.log(`[${profileId} cassette sound] MAME's level is ${scale.toFixed(5)} x ours ${offset < 0 ? '-' : '+'} ${Math.abs(offset).toFixed(5)} (from segment 1)`);
  let ok = true;
  seg.forEach(({ name, so, sm }, k) => {
    const heard = sm.rms > unit * 0.1;
    const dR = Math.abs(so.rms * scale - sm.rms) / unit, dM = Math.abs(so.mean * scale + offset - sm.mean) / unit;
    const dF = heard ? Math.abs(so.freq - sm.freq) / sm.freq : 0;
    const pass = k === 0 || (dR <= TOL.rms && dM <= TOL.mean && dF <= TOL.freq);
    console.log(`[${profileId} cassette sound] ${pass ? 'ok  ' : 'FAIL'} ${name}: RMS ${(so.rms * scale).toFixed(5)} / ${sm.rms.toFixed(5)} (${k === 0 ? 'the scale' : `${(dR * 100).toFixed(2)}% of segment 1's`}), ` +
      `frequency ${so.freq.toFixed(1)} / ${sm.freq.toFixed(1)} Hz${heard ? ` (${(dF * 100).toFixed(2)}%)` : ' (silent)'}, ` +
      `mean ${(so.mean * scale + offset).toFixed(5)} / ${sm.mean.toFixed(5)} (${k === 0 ? 'the offset' : `${(dM * 100).toFixed(2)}%`}) (ours scaled / MAME)`);
    if (!pass) ok = false;
  });
  if (!keep) try { fs.unlinkSync(wavFile); fs.unlinkSync(cas); } catch (e) { /* none */ }
  console.log(`[${profileId} cassette sound] ${ok ? 'every segment within tolerance' : 'NOT within tolerance'}`);
  return ok ? 0 : 1;
}

module.exports = { compare, setup, TOL, tapeBytes };
