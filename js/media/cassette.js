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
 *   buildCas(files, { family })        -> .CAS bytes for programs: namefile, data and end-of-file blocks with their leaders
 *   tapeGaps(cas, { pad })             -> where a tape player adds silence and leader (the layout js/media/tape.js plays)
 *   casToSamples(cas, opts) / casToWav -> the signal: one cycle per bit, starting upwards, with a player's gaps
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
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return b;
}

// ---------------- building a tape ----------------
export const TAPE_LEADER = 128;   // $55 bytes a player puts in front of the blocks BASIC looks for (MAME's, js/media/tape.js)
export const TAPE_SILENCE = 1;    // seconds of silence around a namefile block (twice that at the start)
// what a family's tape is: the file extension, the bit frequencies, and whether a player pads it with silence and leaders
// (the MC-10 family has no motor relay: its bytes play as they are)
export const TAPE_FAMILIES = {
  dragon: { ext: 'cas', zeroHz: 1200, oneHz: 2400, pad: true },
  coco: { ext: 'cas', zeroHz: 1200, oneHz: 2400, pad: true },
  mc10: { ext: 'c10', zeroHz: 1200, oneHz: 2400, pad: false },
};
export const CAS_TYPES = { basic: 0x00, data: 0x01, binary: 0x02 };   // a namefile block's file type byte

const casBlock = (type, data, leader = TAPE_LEADER) => {
  let sum = (type + data.length) & 0xFF;
  for (const b of data) sum = (sum + b) & 0xFF;
  return [...new Array(leader).fill(0x55), 0x3C, type, data.length, ...data, sum, 0x55];
};

// Programs as .CAS bytes, the way BASIC's CSAVE writes them (the stream tools/mame-diff/tape/csave.asm writes, which the tape tests
// check against MAME): per file a namefile block (the name padded to 8, the file type, the ASCII flag twice, the exec and load
// addresses), the data in blocks of up to 255 bytes and an end-of-file block; every block is a 128-byte $55 leader, $3C, type,
// length, data, checksum and a trailing $55. files: [{ name, type: 'basic' |
// 'data' | 'binary', load, exec, data, ascii }] (load and exec for a binary; ascii for BASIC or data saved as text).
// The three families write the same blocks (the firmware the tape tests verify against MAME writes one stream for the 6809 and the
// 6803); family says which machines the tape is for and is checked.
export function buildCas(files, { family = 'dragon' } = {}) {
  if (!TAPE_FAMILIES[family]) throw new TypeError(`family is dragon, coco or mc10, not ${JSON.stringify(family)}`);
  if (!Array.isArray(files) || !files.length) throw new TypeError('buildCas needs a list of files');
  const out = [];
  for (const f of files) {
    if (typeof f.name !== 'string' || f.name.length > 8 || ![...f.name].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7F)) throw new TypeError(`a tape file's name is up to 8 printable ASCII characters, not ${JSON.stringify(f.name)}`);
    if (!(f.type in CAS_TYPES)) throw new TypeError(`a tape file's type is basic, data or binary, not ${JSON.stringify(f.type)}`);
    const addr = (v, what) => { if (v === undefined) return 0; if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new TypeError(`${what} is a 16-bit address, not ${v}`); return v; };
    if (f.type === 'binary' && (f.load === undefined || f.exec === undefined)) throw new TypeError('a binary tape file needs load and exec addresses');
    const load = addr(f.load, 'load'), exec = addr(f.exec, 'exec'), ascii = f.ascii ? 0xFF : 0x00, data = Array.from(f.data);
    const name = [...f.name.padEnd(8)].map((c) => c.charCodeAt(0));
    out.push(...casBlock(0x00, [...name, CAS_TYPES[f.type], ascii, ascii, exec >> 8, exec & 0xFF, load >> 8, load & 0xFF], TAPE_LEADER));
    for (let i = 0; i < data.length; i += 255) out.push(...casBlock(0x01, data.slice(i, i + 255)));
    out.push(...casBlock(0xFF, []));
  }
  return Uint8Array.from(out);
}

// What a tape player does to a .CAS image, as MAME's does (measured from what its cassette input delivers to our own firmware,
// tools/mame-diff/tape/gaps.asm; docs/verification.md): SILENCE * 2 of silence at the start, SILENCE before every later namefile
// block and after every namefile block, and a leader of at least TAPE_LEADER $55 bytes in front of the first block, every
// namefile block and the block after each: the file's own leader, made up to that length when it has fewer. With pad false (the
// MC-10 family) the bytes play as they are after a leader of TAPE_LEADER.
// -> Map: the index of a byte of the image -> { units: silences (of TAPE_SILENCE) just before it, lead: $55 bytes to add before it }.
// The deck (js/media/tape.js Tape) plays this layout, and casToSamples writes it into a WAV.
export function tapeGaps(bytes, { pad = true } = {}) {
  const before = new Map();
  const add = (at, units, lead) => {
    const b = before.get(at) || { units: 0, lead: 0 };
    before.set(at, { units: b.units + units, lead: Math.max(b.lead, lead) });
  };
  if (pad === false) { add(0, 0, TAPE_LEADER); return before; }
  const blocks = [...casBlocks(bytes)];
  // the $55 run in front of block i: where it starts, and how long it is (the $55 that ends the block before it is that
  // block's, played before any silence, as MAME does)
  const leaderOf = (i) => {
    const start = blocks[i].start, floor = i > 0 ? Math.min(start, blocks[i - 1].end + 1) : 0;
    let r = start; while (r > floor && bytes[r - 1] === 0x55) r--;
    return { at: r, n: start - r };
  };
  const want = new Set();
  blocks.forEach((b, i) => {
    if (i === 0) want.add(i);
    if (b.type === 0x00) { want.add(i); if (i + 1 < blocks.length) want.add(i + 1); }
  });
  add(0, 2, 0);
  for (const i of want) {
    const b = blocks[i], l = leaderOf(i);
    const units = b.type === 0x00 ? (i === 0 || l.at === 0 ? 0 : 1) : (i > 0 && blocks[i - 1].type === 0x00 ? 1 : 0);
    add(l.at, units, TAPE_LEADER - l.n);
  }
  if (!blocks.length) add(0, 0, TAPE_LEADER);
  return before;
}

// The signal of a .CAS image: one cycle per bit, LSB first, starting upwards, a sine (default) or a square wave.
//   family: dragon | coco | mc10 (default dragon) gives zeroHz, oneHz and pad (below); each can be given to override
//   gaps: 'player' (default) puts in the silence and leader a player does (tapeGaps), 'none' plays the bytes as they are
//   wave: 'sine' | 'square'; amplitude 0..1 (default 0.75); sampleRate (default 44100)
export function casToSamples(cas, { family = 'dragon', sampleRate = 44100, zeroHz, oneHz, pad, amplitude = 0.75, wave = 'sine', gaps = 'player' } = {}) {
  const fam = TAPE_FAMILIES[family];
  if (!fam) throw new TypeError(`family is dragon, coco or mc10, not ${JSON.stringify(family)}`);
  if (wave !== 'sine' && wave !== 'square') throw new TypeError(`wave is sine or square, not ${JSON.stringify(wave)}`);
  if (gaps !== 'player' && gaps !== 'none') throw new TypeError(`gaps is player or none, not ${JSON.stringify(gaps)}`);
  zeroHz = zeroHz || fam.zeroHz; oneHz = oneHz || fam.oneHz;
  const before = gaps === 'player' ? tapeGaps(cas, { pad: pad === undefined ? fam.pad : pad }) : new Map();
  const cycle0 = sampleRate / zeroHz, cycle1 = sampleRate / oneHz, silence = Math.round(TAPE_SILENCE * sampleRate);
  // two passes over the same walk: the length first, then the samples; t is a fractional position, so long tapes keep their exact bit rate
  const walk = (silent, bit) => {
    let t = 0;
    const byte = (v) => { for (let k = 0; k < 8; k++) { const len = (v >> k) & 1 ? cycle1 : cycle0; bit(t, len); t += len; } };
    for (let i = 0; i <= cas.length; i++) {
      const g = before.get(i);
      if (g) { if (g.units) { silent(t, g.units * silence); t += g.units * silence; } for (let k = 0; k < g.lead; k++) byte(0x55); }
      if (i < cas.length) byte(cas[i]);
    }
    return t;
  };
  const out = new Float32Array(Math.ceil(walk(() => {}, () => {})) + 1);
  const square = wave === 'square';
  walk(() => {}, (t, len) => {
    const end = t + len;
    for (let i = Math.ceil(t); i < end && i < out.length; i++) {
      const phase = (i - t) / len;
      out[i] = amplitude * (square ? (phase < 0.5 ? 1 : -1) : Math.sin(2 * Math.PI * phase));
    }
  });
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
  // and the loudest signal within 8 s either side (a sliding maximum of that RMS): the noise in the silence of a recording that a
  // player padded (2 s at the start, 1 s around a namefile) is quiet next to the blocks close by, even where the follower above
  // has forgotten them; noise that touches a block is always within reach of it, so it never joins the block's run
  const rmsAt = new Float32Array(n);
  for (let i = 0; i < n; i++) { const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1); rmsAt[i] = Math.sqrt((sq[hi] - sq[lo]) / (hi - lo)); }
  const near = new Float32Array(n), reach = Math.round(rate * 8), dq = new Int32Array(n);
  for (let i = 0, head = 0, tail = 0, next = 0; i < n; i++) {
    for (; next < n && next <= i + reach; next++) { while (tail > head && rmsAt[dq[tail - 1]] <= rmsAt[next]) tail--; dq[tail++] = next; }
    while (dq[head] < i - reach) head++;
    near[i] = rmsAt[dq[head]];
  }
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
  // (a silence also ends the run of bits: a mark between the cycles, a cycle of infinite length, which bitRuns takes as a gap)
  const close = () => { if (last >= 0) { if (down > last) out.push(last, 2 * (down - last)); out.push(last, Infinity); } state = 0; last = -1; down = -1; };
  for (let i = 0; i < n; i++) {
    const rms = rmsAt[i];
    level = rms > level ? rms : level * slow;
    if (rms < level * 0.5 || rms < near[i] * 0.4 || rms < 1e-3) { close(); continue; }
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

// a run of bits -> bytes: aligned on the first $55 $3C sync; from the start of the $55 leader before it. A run that starts with its
// leader (after a silence, or at the start of the signal) can have its first bytes damaged where the signal began (the first
// cycle's start is the least certain): up to three bytes there that are a bit or two off $55 are the leader's and are read as $55.
function runToBytes(bits) {
  for (let p = 8; p + 8 <= bits.length; p++) {
    if (byteAt(bits, p) !== 0x3C || byteAt(bits, p - 8) !== 0x55) continue;
    let q = p - 8;
    while (q - 8 >= 0 && byteAt(bits, q - 8) === 0x55) q -= 8;
    const out = [];
    if (q > 0 && q <= 24) {
      const lead = Math.floor(q / 8), off = q % 8, near = (v) => { let d = v ^ 0x55, c = 0; for (; d; d &= d - 1) c++; return c <= 2; };
      if (lead > 0 && Array.from({ length: lead }, (_, k) => byteAt(bits, off + 8 * k)).every(near)) for (let k = 0; k < lead; k++) out.push(0x55);
    }
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
