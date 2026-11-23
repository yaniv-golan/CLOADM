// Audio comparison for the sound cartridges (run.js coco --cart <setup> --audio): MAME records the firmware's
// sound with -wavwrite; we run the same firmware, record what our cartridge does to its sound chips (each register
// or DAC write with its exact time), and turn that into the WAV MAME would write, through:
//   the chip itself                                   our own chip model (js/chips/sn76489.js) at MAME's stream rate,
//                                                     a write taking effect from the first sample at or after it
//                                                     (sound_stream::update; time_to_buffer_index rounds up)
//   default_resampler_stream::resampler_sound_update  a port of MAME 0.264's resampler (src/emu/sound.cpp, the
//                                                     oversampled branch: each output sample is the average of the
//                                                     input over its period, read 1 + floor(step) input samples late)
//   sound_manager::update                             the speakers summed every 1/50 s (STREAMS_UPDATE_FREQUENCY),
//                                                     each output sample stored as s16(x * 32767)
// with the machine's own output added: the CoCo's 6-bit DAC and single-bit sound both route to its speaker at gain
// 0.125 with range -1..1, so with the firmware's PIA1 outputs at 0 they hold -0.125 each (coco12.cpp).
// Arithmetic is done in single precision where MAME's sample_t is a float.
//
// One constant is measured, not derived from MAME's source: MAME's recording is one output sample (1/48000 s) later
// than the resampler alone puts it. It was found by fitting the Games Master recording (any other offset leaves
// thousands of samples wrong) and is the same for every setup. Write times are our machine's exact time under
// config.mameCompat (SamMachine.clockUnits: MAME's machine time, the CPU's cycles plus the resetOffset cycles
// before the first one), with no adjustment.
// Tolerance: 2 LSB per sample, for float rounding in the order MAME adds the streams (the machine's two DAC streams
// pass through their own 192 kHz resamplers; we add their constant). The first 960 output samples (20 ms, MAME's
// first sound update period) are not compared: MAME's resamplers emit zeros until each stream's latency has passed,
// and in that first period some Orchestra-90 DAC writes land one 192 kHz sample earlier than the fitted model puts
// them (from the second period on, every write lands where the model says). The run reports how many samples of
// that first period are over the tolerance, so the exclusion stays visible.
const fs = require('fs'), path = require('path');
const { runMame } = require('../lib/mame');

const f32 = Math.fround;
const ATTO = 1000000000000000000n;
const OUT_RATE = 48000;
const SKIP = 960, TOLERANCE = 2;

function readWav(file) {
  const d = fs.readFileSync(file);
  if (d.toString('latin1', 0, 4) !== 'RIFF' || d.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= d.length) {
    const id = d.toString('latin1', p, p + 4), size = d.readUInt32LE(p + 4), body = p + 8;
    if (id === 'fmt ') fmt = { channels: d.readUInt16LE(body + 2), rate: d.readUInt32LE(body + 4), bits: d.readUInt16LE(body + 14) };
    if (id === 'data') data = d.subarray(body, Math.min(d.length, body + size));
    p = body + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`${file}: expected 16-bit PCM`);
  const n = Math.floor(data.length / (2 * fmt.channels));
  const ch = [...Array(fmt.channels)].map(() => new Int16Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.channels; c++) ch[c][i] = data.readInt16LE((i * fmt.channels + c) * 2);
  return { rate: fmt.rate, channels: ch, frames: n };
}

// MAME's default resampler from `inRate` to `outRate` (48 kHz by default) over output samples [0, n), the input
// given as a function of the input sample index (values already scaled as floats). Output sample j of second s
// starts at s + j x sra attoseconds (stream_buffer index_time); updates come every 1/50 s of machine time
// (sound_manager's timer), and each one starts its output run from the exact time, as resampler_sound_update does.
function resample(input, inRate, n, latencySamples = null, outRate = OUT_RATE) {
  const sra = ATTO / BigInt(outRate);                        // HZ_TO_ATTOSECONDS(outRate), truncated
  const ina = ATTO / BigInt(inRate);
  const step = f32(f32(inRate) / f32(outRate));
  const stepinv = f32(1.0 / step);
  const latency = BigInt(latencySamples ?? 1 + Math.trunc(step)) * ina;
  const out = new Float32Array(n);
  const timeOf = (j) => BigInt(Math.floor(j / outRate)) * ATTO + BigInt(j % outRate) * sra;
  // the update periods: sound_manager::update every 1/50 s, each covering floor(period / sra) samples
  const updAttos = ATTO / 50n;
  let last = 0n, j = 0, k = 1n;
  while (j < n) {
    const t = k * updAttos; k++;
    const count = Number((t - last) / sra);
    const endTime = last + BigInt(count) * sra;
    const jEnd = Math.min(n, j + count);
    // one resampler_sound_update call for outputs [j, jEnd)
    let start = timeOf(j), dst = j;
    while (latency > start && dst < jEnd) { out[dst++] = 0; start = timeOf(dst); }
    if (dst < jEnd) {
      const reb = start - latency;
      let src = Number(reb / ina);                           // rebased view: time_to_buffer_index(round down)
      let srcpos = f32(Number(reb - BigInt(src) * ina) / Number(ina));
      let cur = f32(input(src++));
      for (; dst < jEnd; dst++) {
        const scale = f32(1.0 - srcpos);
        let sample = f32(cur * scale);
        let remaining = f32(step - scale);
        while (remaining >= 1.0) { sample = f32(sample + f32(input(src++))); remaining = f32(remaining - 1.0); }
        cur = f32(input(src++));
        sample = f32(sample + f32(cur * remaining));
        out[dst] = f32(sample * stepinv);
        srcpos = remaining;
      }
    }
    j = jEnd; last = endTime;
  }
  return out;
}

// first sample of a stream at `rate` that starts at or after t (attoseconds): time_to_buffer_index(t, round up),
// counted within each second as MAME does
function indexAt(rate, t) {
  const sa = ATTO / BigInt(rate), sec = t / ATTO, rem = t % ATTO;
  return Number(sec) * rate + Number((rem + sa - 1n) / sa);
}
// a stream of `count` samples at `rate` from a chip model and time-stamped writes: chip.write(event) applies one,
// chip.sample() gives the next sample's float value
function chipStream(chip, rate, events, count) {
  const out = new Float32Array(count);
  let e = 0;
  for (let k = 0; k < count; k++) {
    while (e < events.length && events[e].index <= k) chip.write(events[e++]);
    out[k] = chip.sample();
  }
  return out;
}

// run our machine for `seconds` with the setup's capture hooks; events get their MAME stream index per rate
function capture(t, seconds) {
  const m = t.machine();
  const events = [];
  t.setup.audio.capture(m.cartPort, (time, ev) => events.push(Object.assign({ time }, ev)));
  const frames = Math.ceil(seconds * m.fps) + 2;
  for (let f = 0; f < frames; f++) m.runFrame();
  return events;
}

async function compare(t) {
  const a = t.setup.audio;
  if (!a) { console.error(`${t.label}: this setup has no sound`); return 1; }
  const wav = path.join(t.work, 'mame.wav');
  try { fs.unlinkSync(wav); } catch (e) { /* none */ }
  // the Lua probe prints what MAME built in the cartridge slot and the images it mounted, for the report below
  const probe = `local n = 0
emu.register_frame_done(function()
  n = n + 1
  if n ~= 2 then return end
  for tag, _ in pairs(manager.machine.devices) do if tag:find('^:ext') then print('SLOT ' .. tag) end end
  for _, img in pairs(manager.machine.images) do if img.exists then print('IMAGE ' .. img.device.tag .. ' ' .. img.filename) end end
end)
`;
  const args = [...t.args, '-wavwrite', wav, '-samplerate', String(OUT_RATE)];
  const run = runMame({ work: t.work, system: t.system, lua: probe, seconds: a.seconds, args });
  // only a finished run's recording is compared: a MAME killed or failing leaves a short or unfinished WAV
  if (run.signal || run.status !== 0 || !fs.existsSync(wav)) {
    console.log(`[${t.label} audio] MAME did not finish its ${a.seconds} s (${run.signal ? `stopped by ${run.signal}` : `status ${run.status}`}${fs.existsSync(wav) ? '' : ', no recording'}): not compared`);
    return 1;
  }
  // MAME built the cartridge the comparison is about (a run that put the image on another board records only the
  // machine's own level)
  const built = run.output.split('\n').filter((l) => l.startsWith('SLOT ')).map((l) => l.slice(5));
  const absent = a.devices.filter((d) => !built.includes(d));
  if (absent.length) {
    console.log(`[${t.label} audio] MAME did not build ${absent.join(', ')} (its slot: ${built.join(', ') || 'nothing'}; arguments: ${args.join(' ')}): not compared`);
    return 1;
  }
  const mame = readWav(wav);
  if (mame.rate !== OUT_RATE || mame.channels.length !== 2) throw new Error(`MAME wrote ${mame.channels.length} channels at ${mame.rate} Hz`);
  const n = Math.floor(a.seconds * OUT_RATE);
  if (mame.frames < n) { console.log(`[${t.label} audio] MAME's recording is short: ${mame.frames} of ${n} samples: not compared`); return 1; }
  const events = capture(t, a.seconds + 0.05);
  // the cartridge's speakers per channel, then MAME's one-sample delay
  const cart = a.render(events, n, { resample, indexAt, chipStream });
  let worst = 0, over = 0, firstBad = -1, sound = 0, early = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 10; i < n; i++) {
      const x = Math.max(-1, Math.min(1, f32(f32(-0.25) + cart[c][i - 1])));
      const v = Math.trunc(f32(x * 32767.0));
      const d = Math.abs(v - mame.channels[c][i]);
      if (i < SKIP) { if (d > TOLERANCE) early++; continue; }
      if (mame.channels[c][i] !== -8191) sound++;
      if (d > worst) worst = d;
      if (d > TOLERANCE) { over++; if (firstBad < 0) firstBad = i; }
    }
  }
  const ok = over === 0 && sound > n / 10;
  // MAME's recording holds only the machine's own level while ours has the cartridge's sound: MAME's cartridge made
  // none. Say so, with what MAME built and mounted, its output and the arguments, rather than only the differences.
  if (sound === 0 && events.length) {
    const lines = run.output.split('\n');
    console.log(`[${t.label} audio] MAME's recording has no cartridge sound (every sample is the machine's own level), ours has ${events.length} writes`);
    console.log(`  MAME's slot devices: ${lines.filter((l) => l.startsWith('SLOT ')).map((l) => l.slice(5)).join(', ') || 'none'}`);
    console.log(`  MAME's images: ${lines.filter((l) => l.startsWith('IMAGE ')).map((l) => l.slice(6)).join(', ') || 'none'}`);
    console.log(`  MAME's output: ${lines.filter((l) => l && !/^(SLOT|IMAGE) /.test(l)).slice(-8).join(' | ') || '(none)'}`);
    console.log(`  arguments: ${args.join(' ')}`);
  }
  console.log(`[${t.label} audio] ${n} samples x 2 channels at ${OUT_RATE} Hz compared with MAME's -wavwrite (first ${SKIP} skipped): ` +
    `largest difference ${worst} LSB (tolerance ${TOLERANCE}), ${over} samples over it${firstBad >= 0 ? `, first at sample ${firstBad} (${(firstBad / OUT_RATE).toFixed(4)} s)` : ''}; ` +
    `${events.length} writes; ${sound} samples with sound; in the skipped first period ${early} samples over the tolerance`);
  return ok ? 0 : 1;
}

module.exports = { compare, resample, readWav, indexAt, chipStream, capture };
