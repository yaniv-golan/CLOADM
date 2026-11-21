// run.js dgnalpha --sound: the Dragon Alpha's AY-3-8912 (and the DAC beside it) against MAME's -wavwrite.
// sound.asm (our boot ROM) plays six segments: a tone, two tones at other volumes, noise, two envelopes and the
// DAC alone. MAME records the speaker at 48 kHz; we render our machine's sound levels (Machine.audioEvents) at the
// same rate in MAME's scale (MAME_UNIT, js/machines/alpha.js: our DAC level 1 is MAME's 63/16 x 0.125). The
// segments are timed by our firmware's phase counter; MAME's recording is lined up on the first one. Over the
// middle 80% of each segment:
//   fundamental (rising crossings of the AC part, with hysteresis): within 1% (tones, triangle envelope, DAC)
//   RMS of the AC part:                                             within 3% (5% for noise)
//   the attack-hold envelope: its 8 block means, relative to the segment's mean, within 3% of its range
// The mean level (DC) is reported, not compared: MAME's mix carries constant offsets (its DAC and single-bit
// DAC at -1 when silent, -0.25 together) and a slow DC-blocking drift, and our audio output removes DC.
// Why not sample by sample: MAME resamples the AY's 125 kHz stream to 48 kHz through its own filter, and its
// sample clock and ours start at different instants, so edges land on different samples. What is compared is
// what is heard: pitch, loudness and the levels' offset, segment by segment.
const fs = require('fs'), path = require('path');
const { loadEmu, assembleFile, romImage, writeRoms } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir, keepWorkDir } = require('../lib/workdir');
const MAME_UNIT = 63 / 16 * 0.125;      // js/machines/alpha.js

const RATE = 48000;
const TOL = { freq: 0.01, rms: 0.03, rmsNoise: 0.05, profile: 0.03 };
const NAMES = ['A $100 v15', 'B $080 v10 + C $040 v6', 'noise $0F v12', 'envelope $0E', 'envelope $0D', 'DAC square'];

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`${file}: not a 16-bit PCM WAV`);
  const n = data.length / 2 / fmt.channels, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  return { rate: fmt.rate, samples: out };
}
// ours: level events (absolute cycle, level) -> samples at RATE, zero-order hold, in MAME's scale
function render(events, tickHz, cycles) {
  const n = Math.floor(cycles / tickHz * RATE), out = new Float64Array(n);
  let e = 0, level = events.length ? events[1] : 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE * tickHz;
    while (e + 2 < events.length && events[e + 2] <= t) { e += 2; level = events[e + 1]; }
    out[i] = level * MAME_UNIT;
  }
  return out;
}
// segment starts: the first step between neighbouring samples larger than eps after `from` (MAME's output
// drifts slowly through its DC blocking, so a distance from the silence level would find the drift)
function onset(s, from, eps = 0.008) {
  for (let i = Math.max(1, from); i < s.length; i++) if (Math.abs(s[i] - s[i - 1]) > eps) return i;
  return -1;
}
function stats(s, a, b) {
  let sum = 0;
  for (let i = a; i < b; i++) sum += s[i];
  const mean = sum / (b - a);
  let sq = 0;
  for (let i = a; i < b; i++) sq += (s[i] - mean) ** 2;
  const rms = Math.sqrt(sq / (b - a)), h = rms * 0.3;
  // rising crossings with hysteresis (MAME's resampler ripples around steps)
  let zc = 0, low = s[a] - mean < 0;
  for (let i = a; i < b; i++) {
    const v = s[i] - mean;
    if (low && v > h) { zc++; low = false; } else if (!low && v < -h) low = true;
  }
  const blocks = [];
  for (let k = 0; k < 8; k++) {
    const p = a + Math.floor((b - a) * k / 8), q = a + Math.floor((b - a) * (k + 1) / 8);
    let t = 0; for (let i = p; i < q; i++) t += s[i];
    blocks.push(t / (q - p) - mean);
  }
  return { mean, rms, freq: zc / ((b - a) / RATE), blocks };
}

function compare(profileId, { work = workDir(`${profileId}-sound`), keep = false } = {}) {
  if (keep) keepWorkDir(work, '--keep');
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const asm = assembleFile(path.join(__dirname, 'sound.asm'), '6809');
  const slots = { boot: romImage(asm, 0xA000, 0x2000, 0x00), basic: new Uint8Array(0x4000).fill(0x12) };
  const halt = asm.symbols.get('HALT');
  // ---- ours: run to HALT, recording the level events and the cycle each phase starts
  const m = Emu.createMachine(profileId, { mameCompat: true });
  m.setRoms(slots); m.reset(true);
  const events = [], phases = [];
  let lastPhase = 0;
  for (let f = 0; f < 60 * 8 && m.cpu.pc !== halt; f++) {
    m.runFrame();
    for (let i = 0; i < m.audioEvents.length; i += 2) events.push(m.frameBase - m.frameCycles + m.audioEvents[i], m.audioEvents[i + 1]);
    if (m.ram[0x7000] !== lastPhase) { lastPhase = m.ram[0x7000]; phases.push([lastPhase, m.frameBase]); }
  }
  if (m.cpu.pc !== halt) { console.log(`[${profileId} sound] our firmware did NOT reach HALT`); return 1; }
  for (let f = 0; f < 25; f++) { m.runFrame(); for (let i = 0; i < m.audioEvents.length; i += 2) events.push(m.frameBase - m.frameCycles + m.audioEvents[i], m.audioEvents[i + 1]); }
  // events within a frame may repeat a level: keep the timeline monotonic
  const ours = render(events, m.tickHz, m.frameBase);
  // ---- MAME
  fs.mkdirSync(work, { recursive: true });
  const files = {};
  for (const sl of profile.roms) files[sl.files[0]] = slots[sl.id];
  writeRoms(work, profile.mame, files);
  const wavFile = path.join(work, 'mame.wav');
  try { fs.unlinkSync(wavFile); } catch (e) { /* none */ }
  runMame({ work, system: profile.mame, lua: '', seconds: Math.ceil(m.frameBase / m.tickHz) + 1, args: ['-ext', '', '-wavwrite', wavFile, '-samplerate', String(RATE)] });
  const mw = readWav(wavFile);
  if (mw.rate !== RATE) { console.log(`[${profileId} sound] MAME wrote ${mw.rate} Hz, not ${RATE}`); return 1; }
  const mame = mw.samples;
  // ---- segments: phase 2k+1 starts segment k+1 and phase 2k+2 ends it, in our machine's own time (frame
  // resolution); MAME's recording is lined up once, on the first step of the first segment in both
  const at = (ph) => { const p = phases.find((x) => x[0] === ph); return p ? Math.floor((p[1] - m.frameCycles) / m.tickHz * RATE) : -1; };
  const first = at(1);
  const o1 = onset(ours, first), w1 = onset(mame, Math.max(1, first - RATE / 10));
  if (o1 < 0 || w1 < 0) { console.log(`[${profileId} sound] the first segment's start was not found (ours ${o1}, MAME ${w1})`); return 1; }
  const shift = w1 - o1;
  let ok = true;
  console.log(`[${profileId} sound] MAME's recording lined up ${(shift / RATE * 1000).toFixed(2)} ms after ours (first step at ${(o1 / RATE).toFixed(4)} s)`);
  NAMES.forEach((name, k) => {
    const start = at(2 * k + 1), end = at(2 * k + 2);
    if (start < 0 || end < 0) { console.log(`[${profileId} sound] ${name}: segment not found`); ok = false; return; }
    const len = end - start, a = start + Math.floor(len * 0.1), b = start + Math.floor(len * 0.9);
    const so = stats(ours, a, b), sm = stats(mame, a + shift, b + shift);
    const noise = /noise/.test(name), ramp = /\$0D/.test(name);
    const dF = Math.abs(so.freq - sm.freq) / sm.freq, dR = Math.abs(so.rms - sm.rms) / sm.rms;
    const range = Math.max(...sm.blocks) - Math.min(...sm.blocks);
    const dP = Math.max(...so.blocks.map((v, i) => Math.abs(v - sm.blocks[i]))) / range;
    const pass = (noise || ramp || dF <= TOL.freq) && dR <= (noise ? TOL.rmsNoise : TOL.rms) && (!ramp || dP <= TOL.profile);
    console.log(`[${profileId} sound] ${pass ? 'ok  ' : 'FAIL'} ${name}: ${ramp ? `shape within ${(dP * 100).toFixed(2)}% of its range, ` : ''}frequency ${so.freq.toFixed(1)} / ${sm.freq.toFixed(1)} Hz (${(dF * 100).toFixed(2)}%${noise || ramp ? ', not compared' : ''}), ` +
      `RMS ${so.rms.toFixed(5)} / ${sm.rms.toFixed(5)} (${(dR * 100).toFixed(2)}%); mean ${so.mean.toFixed(4)} / ${sm.mean.toFixed(4)} (ours / MAME)`);
    if (!pass) ok = false;
  });
  if (!keep) try { fs.unlinkSync(wavFile); } catch (e) { /* none */ }
  console.log(`[${profileId} sound] ${ok ? 'every segment within tolerance' : 'NOT within tolerance'}`);
  return ok ? 0 : 1;
}

module.exports = { compare, TOL, readWav, onset, stats };
