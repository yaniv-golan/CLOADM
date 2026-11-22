/*
 * Cassette audio: WAV files, the tape signal a .CAS image makes, and decoding a signal back to .CAS bytes.
 * Pure functions from bytes to bytes (no DOM, no storage).
 *
 * The Dragon/CoCo (and MC-10) tape format: every bit is one full cycle, 1200 Hz for 0 and 2400 Hz for 1,
 * least significant bit first; blocks are a leader of $55 bytes, the sync byte $3C, type, length, data and a
 * checksum (formats.parseCas reads the blocks).
 *
 *   parseWav(bytes)                    -> { sampleRate, channels, bits, samples: Float32Array (mono, -1..1) }
 *   writeWav(samples, sampleRate)      -> 16-bit PCM mono WAV bytes
 *   pcm16(samples)                     -> the 16-bit values writeWav stores (Int16Array)
 *   casToSamples(cas, opts) / casToWav -> the signal: one sine cycle per bit, starting upwards
 *   samplesToCas(samples, rate, opts)  -> { bytes, blocks, badBlocks, polarity }: the .CAS bytes in the signal
 *   wavToCas(wavBytes, opts)           -> the same from a WAV file
 *
 * The decoder copes with what real recordings do: a DC offset (removed by a moving average one 1200 Hz cycle
 * long), noise (a short low-pass, then crossings found with hysteresis), inverted phase (both polarities are decoded and the one with
 * more good blocks wins), writers off the nominal frequencies (each run's two cycle lengths are learnt first)
 * and speed drift (each cycle is judged against the local cycle length, tracked over neighbouring cycles), and silence between blocks (a gap starts a new run; bytes are re-aligned on the next
 * $55... $3C sync).
 */

const RIFF = 0x46464952, WAVE = 0x45564157, FMT = 0x20746D66, DATA = 0x61746164;

export class WavError extends Error {}

export function parseWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || v.getUint32(0, true) !== RIFF || v.getUint32(8, true) !== WAVE) throw new WavError('not a WAV file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = v.getUint32(p, true), size = v.getUint32(p + 4, true), body = p + 8;
    if (id === FMT) {
      if (size < 16) throw new WavError('WAV format chunk too short');
      if (body + 16 > b.length) throw new WavError('WAV format chunk cut short (the file ends inside it)');
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true) };
      if (fmt.format === 0xFFFE && size >= 40 && body + 26 <= b.length) fmt.format = v.getUint16(body + 24, true);   // WAVE_FORMAT_EXTENSIBLE: the sub-format
    } else if (id === DATA) {
      data = { start: body, size: Math.min(size, b.length - body) };
    }
    p = body + size + (size & 1);
  }
  if (!fmt) throw new WavError('WAV file has no format chunk');
  if (!data) throw new WavError('WAV file has no data');
  const { format, channels, bits, sampleRate } = fmt;
  if (!channels || !sampleRate) throw new WavError('WAV file has no channels or no sample rate');
  const pcm = format === 1, float = format === 3;
  if (!(pcm && [8, 16, 24, 32].includes(bits)) && !(float && bits === 32)) throw new WavError(`unsupported WAV encoding (format ${format}, ${bits} bits)`);
  const bytesPer = bits / 8, frame = fmt.blockAlign || bytesPer * channels, n = Math.floor(data.size / frame);
  const out = new Float32Array(n);
  const read = (o) => {
    if (float) return v.getFloat32(o, true);
    if (bits === 8) return (b[o] - 128) / 128;
    if (bits === 16) return v.getInt16(o, true) / 32768;
    if (bits === 24) return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
    return v.getInt32(o, true) / 2147483648;
  };
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += read(data.start + i * frame + c * bytesPer);
    out[i] = s / channels;
  }
  return { sampleRate, channels, bits, samples: out };
}

export function writeWav(samples, sampleRate) {
  const n = samples.length, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
  v.setUint32(0, RIFF, true); v.setUint32(4, 36 + n * 2, true); v.setUint32(8, WAVE, true);
  v.setUint32(12, FMT, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  v.setUint32(36, DATA, true); v.setUint32(40, n * 2, true);
  const pcm = pcm16(samples);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return b;
}
// samples (-1..1, clipped) -> 16-bit PCM values: writeWav's quantisation, shared with the AVI recorder (js/media/avi.js)
export function pcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  return out;
}

// one sine cycle per bit, LSB first, starting upwards; silence before and after
export function casToSamples(cas, { sampleRate = 44100, zeroHz = 1200, oneHz = 2400, amplitude = 0.75, silence = 0.25 } = {}) {
  const pad = Math.round(sampleRate * silence);
  let t = 0;   // fractional sample position, so long tapes keep their exact bit rate
  const cycle0 = sampleRate / zeroHz, cycle1 = sampleRate / oneHz;
  let total = 0;
  for (const byte of cas) for (let k = 0; k < 8; k++) total += (byte >> k) & 1 ? cycle1 : cycle0;
  const out = new Float32Array(pad * 2 + Math.ceil(total) + 1);
  let i = pad;
  for (const byte of cas) {
    for (let k = 0; k < 8; k++) {
      const len = (byte >> k) & 1 ? cycle1 : cycle0, end = t + len;
      for (; i - pad < end; i++) out[i] = amplitude * Math.sin(2 * Math.PI * ((i - pad) - t) / len);
      t = end;
    }
  }
  return out;
}

export const casToWav = (cas, opts = {}) => writeWav(casToSamples(cas, opts), opts.sampleRate || 44100);

// ---------------- decoding ----------------

// full cycles between crossings of one direction (rising for polarity +1), found with hysteresis around a
// DC-free signal; returns [start sample, length in samples] pairs as Float64Array (crossings interpolated)
function cycles(x, rate, polarity, zeroHz) {
  const n = x.length, w = Math.max(3, Math.round(rate / zeroHz));
  // DC: subtract the centred moving average over one long cycle (a whole cycle of either bit averages to zero)
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + x[i];
  const y = new Float32Array(n), h = w >> 1;
  // noise: a centred box low-pass a sixth of a short cycle wide (passes 2400 Hz, cuts broadband hiss)
  const k = Math.max(0, Math.round(rate / zeroHz / 24));
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1), a = Math.max(0, i - k), b = Math.min(n, i + k + 1);
    y[i] = (sum[b] - sum[a]) / (b - a) - (sum[hi] - sum[lo]) / (hi - lo);
  }
  // squelch: the RMS over one long cycle against the recent signal level (slow peak follower), so noise in
  // the silence between blocks makes no cycles; hysteresis from the same RMS
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i] + y[i] * y[i];
  const slow = Math.exp(-1 / (rate * 0.5));
  let level = 0;
  const out = [];
  let state = 0, last = -1, down = -1;
  // where the signal last went through zero in the direction d, at or before sample i
  const zero = (i, d) => {
    let j = i;
    while (j > 0 && y[j - 1] * polarity * d > 0) j--;
    const prev = j > 0 ? y[j - 1] * polarity : 0, cur = y[j] * polarity;
    return j > 0 && cur !== prev ? j - cur / (cur - prev) : j;
  };
  // a run ends (silence or the end of the signal): its last cycle has no next crossing, so it is closed from
  // its first half (the falling crossing comes half a cycle after the rising one)
  const close = () => { if (last >= 0 && down > last) out.push(last, 2 * (down - last)); state = 0; last = -1; down = -1; };
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1);
    const rms = Math.sqrt((sq[hi] - sq[lo]) / (hi - lo));
    level = rms > level ? rms : level * slow;
    if (rms < level * 0.5 || rms < 1e-3) { close(); continue; }
    const s = y[i] * polarity, th = rms * 0.25;
    if (state <= 0 && s > th) {
      // the crossing: where the signal went through zero before reaching the threshold
      const at = zero(i, 1);
      if (last >= 0) out.push(last, at - last);
      last = at; down = -1;
      state = 1;
    } else if (state >= 0 && s < -th) { if (last >= 0) down = zero(i, -1); state = -1; }
  }
  close();
  return Float64Array.from(out);
}

// cycles -> runs of bits. A gap (no cycle for over 3 long cycles, or one far too short) ends a run. In each run
// the two cycle lengths are learnt first (two means over the run: writers and tape speeds are rarely exactly
// 1200 and 2400 Hz), then every cycle is judged against the geometric mean of the two at the local speed,
// which is tracked from both kinds of cycle (speed drift)
function bitRuns(cyc, rate, zeroHz, oneHz) {
  const n = cyc.length / 2, nom1 = rate / oneHz, nom0 = rate / zeroHz;
  const runs = [];
  let start = 0;
  const finish = (end) => {
    if (end - start < 8) return;
    const lens = [];
    for (let i = start; i < end; i++) lens.push(cyc[2 * i + 1]);
    // two means on log length, from the nominal lengths
    let a = Math.log(nom1), b = Math.log(nom0);
    for (let it = 0; it < 20; it++) {
      let sa = 0, na = 0, sb = 0, nb = 0;
      const mid = (a + b) / 2;
      for (const l of lens) { const v = Math.log(l); if (v < mid) { sa += v; na++; } else { sb += v; nb++; } }
      if (na) a = sa / na;
      if (nb) b = sb / nb;
    }
    // one kind only (a run of 0s or of 1s): keep the nominal ratio
    let ratio = Math.exp(b - a);
    if (ratio < 1.3 || ratio > 3) { ratio = nom0 / nom1; if (Math.exp(a) > nom1 * Math.sqrt(ratio)) a = Math.log(Math.exp(a) / ratio); }
    let unit = Math.exp(a);
    const bits = [];
    for (const len of lens) {
      const one = len < unit * Math.sqrt(ratio);
      bits.push(one ? 1 : 0);
      unit += ((one ? len : len / ratio) - unit) * 0.05;
    }
    runs.push(bits);
  };
  for (let i = 0; i < n; i++) {
    const len = cyc[2 * i + 1];
    if (len > nom0 * 3 || len < nom1 / 3) { finish(i); start = i + 1; }
  }
  finish(n);
  return runs;
}

const byteAt = (bits, p) => { let v = 0; for (let k = 0; k < 8; k++) v |= bits[p + k] << k; return v; };

// a run of bits -> bytes: aligned on the first $55 $3C sync; from the start of the $55 leader before it
function runToBytes(bits) {
  for (let p = 8; p + 8 <= bits.length; p++) {
    if (byteAt(bits, p) !== 0x3C || byteAt(bits, p - 8) !== 0x55) continue;
    let q = p - 8;
    while (q - 8 >= 0 && byteAt(bits, q - 8) === 0x55) q -= 8;
    const out = [];
    for (let r = q; r + 8 <= bits.length; r += 8) out.push(byteAt(bits, r));
    return out;
  }
  return [];
}

// The blocks in .CAS bytes, in order: a $3C sync byte after a $55 leader byte, then type, length, the data and a
// checksum (the sum of type, length and data). -> { start (the sync byte), type, data, ok, end (just past it) }; a
// block cut short by the end of the bytes is the last, with ok false. The tape decoder (samplesToCas) and the
// file parser (js/media/formats.js parseCas) read blocks through this.
export function* casBlocks(b) {
  for (let p = 1; p + 3 <= b.length; p++) {
    if (b[p] !== 0x3C || b[p - 1] !== 0x55) continue;
    const type = b[p + 1], len = b[p + 2];
    if (p + 3 + len >= b.length) { yield { start: p, type, data: b.subarray(p + 3, p + 3 + len), ok: false, end: b.length }; return; }
    const data = b.subarray(p + 3, p + 3 + len);
    let sum = (type + len) & 0xFF;
    for (let i = 0; i < len; i++) sum = (sum + data[i]) & 0xFF;
    yield { start: p, type, data, ok: sum === b[p + 3 + len], end: p + 4 + len };
    p += 3 + len;
  }
}

// blocks in .CAS bytes with their checksum verdict
function blocks(bytes) {
  const good = [], bad = [];
  for (const k of casBlocks(bytes)) (k.ok ? good : bad).push(k.start);
  return { good, bad };
}

export function samplesToCas(samples, sampleRate, { zeroHz = 1200, oneHz = 2400 } = {}) {
  let best = null;
  for (const polarity of [1, -1]) {
    const runs = bitRuns(cycles(samples, sampleRate, polarity, zeroHz), sampleRate, zeroHz, oneHz);
    const bytes = Uint8Array.from(runs.flatMap(runToBytes));
    const { good, bad } = blocks(bytes);
    const r = { bytes, blocks: good.length, badBlocks: bad.length, polarity };
    if (!best || r.blocks > best.blocks || (r.blocks === best.blocks && r.badBlocks < best.badBlocks)) best = r;
  }
  return best;
}

export function wavToCas(wavBytes, opts = {}) {
  const w = parseWav(wavBytes);
  return Object.assign(samplesToCas(w.samples, w.sampleRate, opts), { sampleRate: w.sampleRate, seconds: w.samples.length / w.sampleRate });
}

// ---------------- what a machine wrote ----------------
// A recording from the cassette deck: [tick, level] pairs (level 0..1, null when the motor stopped) over
// tickHz ticks a second -> samples at sampleRate (silence while the motor is off)
export function recordingToSamples(events, tickHz, sampleRate = 44100) {
  if (!events.length) return new Float32Array(0);
  const t0 = events[0][0], t1 = events[events.length - 1][0];
  const n = Math.ceil((t1 - t0) / tickHz * sampleRate) + 1;
  const out = new Float32Array(n);
  let e = 0, level = null;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * tickHz / sampleRate;
    while (e < events.length && events[e][0] <= t) level = events[e++][1];
    out[i] = level === null ? 0 : level * 2 - 1;
  }
  return out;
}
