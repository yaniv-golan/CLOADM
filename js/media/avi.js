/*
 * AVI recording: a RIFF AVI 1.0 file with an 8-bit palettized video stream and a 16-bit mono PCM audio stream,
 * from the machine's own Frames (one byte per pixel plus a 256-entry colour table, js/video/frame.js).
 *
 *   frameRate(tickHz, frameCycles)        -> { num, den }: frames per second as an exact, reduced fraction
 *   sampleClock(sampleRate, { num, den }) -> { next() }: the samples each frame gets, the remainder carried exactly
 *   aviWriter({ rate, sampleRate, maxBytes }).addFrame(frame, samples).finish() -> the file's bytes
 *
 * Layout (Microsoft "AVI RIFF File Reference"; the AVIPALCHANGE chunk from vfw.h):
 *   RIFF 'AVI '
 *     LIST 'hdrl'  avih (MainAVIHeader)
 *                  LIST 'strl'  strh 'vids' (AVISF_VIDEO_PALCHANGES), strf BITMAPINFOHEADER (8 bits) + 256 RGBQUADs
 *                  LIST 'strl'  strh 'auds', strf PCMWAVEFORMAT (1 channel, 16 bits)
 *     LIST 'movi'  per frame: '00pc' (only when the colour table changed), '00db' (bottom-up rows, 4-byte aligned),
 *                  '01wb' (the frame's samples)
 *     idx1         every movi chunk: id, AVIIF_KEYFRAME (a palette change: AVIIF_NOTIME), offset from the 'movi' tag, size
 *
 * Pure: bytes in, bytes out, no clock, so the same frames and samples always give the same file.
 */

export class AviError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// The AVI 1.0 limit: readers that predate OpenDML stop at 1 GiB
export const AVI_LIMIT = 2 ** 30;

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
// x (a clock in Hz, possibly fractional: 14318180 / 16, 28636363 / 8) as p / q, exactly
function exact(x, what) {
  for (let q = 1; q <= 1 << 16; q++) if (Number.isInteger(x * q) && (x * q) / q === x) return [x * q, q];
  throw new AviError('bad-rate', `${what} ${x} is not a fraction with a small denominator`);
}
// tickHz / frameCycles as { num, den }, reduced: 888625 / 17784 on the PAL Dragons
export function frameRate(tickHz, frameCycles) {
  const [p, q] = exact(tickHz, 'the clock');
  if (!Number.isInteger(frameCycles) || frameCycles < 1) throw new AviError('bad-rate', `frameCycles ${frameCycles} is not a whole number`);
  const num = p, den = q * frameCycles, g = gcd(num, den);
  return { num: num / g, den: den / g };
}
// Frame k gets the samples between floor(k x sampleRate / fps) and floor((k + 1) x sampleRate / fps): the remainder
// is an integer, so nothing drifts however long the run
export function sampleClock(sampleRate, { num, den }) {
  let rem = 0;
  const per = sampleRate * den;   // per frame, in 1 / num samples
  return {
    next() { rem += per; const n = Math.floor(rem / num); rem -= n * num; return n; },
  };
}

const fourcc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const AVIF_HASINDEX = 0x10, AVIIF_KEYFRAME = 0x10, AVIIF_NOTIME = 0x100, AVISF_VIDEO_PALCHANGES = 0x10000;

class Out {
  constructor(size) { this.b = new Uint8Array(size); this.v = new DataView(this.b.buffer); this.p = 0; }
  u8(x) { this.b[this.p++] = x; return this; }
  u16(x) { this.v.setUint16(this.p, x, true); this.p += 2; return this; }
  i16(x) { this.v.setInt16(this.p, x, true); this.p += 2; return this; }
  u32(x) { this.v.setUint32(this.p, x >>> 0, true); this.p += 4; return this; }
  id(s) { return this.u32(fourcc(s)); }
  bytes(a) { this.b.set(a, this.p); this.p += a.length; return this; }
}
// one chunk: id, size, data, padded to an even length
function chunk(id, data) {
  const o = new Out(8 + data.length + (data.length & 1));
  o.id(id).u32(data.length).bytes(data);
  return o.b;
}

class AviWriter {
  // rate: { num, den } frames per second (frameRate); sampleRate: the audio's; maxBytes: the file's limit
  constructor({ rate, sampleRate = 44100, maxBytes = AVI_LIMIT }) {
    if (!rate || !(rate.num > 0) || !(rate.den > 0)) throw new AviError('bad-rate', 'aviWriter needs rate: { num, den }');
    this.rate = rate;
    this.sampleRate = sampleRate;
    this.maxBytes = maxBytes;
    this.width = 0; this.height = 0;
    this.frames = 0;
    this.samples = 0;
    this.palette = null;         // the colour table in force (the first frame's goes in the header)
    this.first = null;           // that first table
    this.chunks = [];            // the movi chunks, as bytes
    this.index = [];             // { id, offset, size }
    this.moviBytes = 4;          // the 'movi' tag, then the chunks
    this.maxVideo = 0; this.maxAudio = 0;
  }
  // the file's size with `extra` more bytes of movi chunks in `count` more index entries
  sizeWith(extra, count) {
    return 12 + this.headerBytes() + 8 + this.moviBytes + extra + 8 + 16 * (this.index.length + count);
  }
  headerBytes() { return 12 + 64 + (12 + 64 + 8 + 40 + 1024) + (12 + 64 + 8 + 16); }
  // one machine frame (a Frame) and the samples (16-bit values) that play during it
  addFrame(frame, samples) {
    const { width, height } = frame;
    if (!this.frames) { this.width = width; this.height = height; }
    else if (width !== this.width || height !== this.height) {
      throw new AviError('size-changed', `frame ${this.frames} is ${width}x${height}, the recording ${this.width}x${this.height}`, { frame: this.frames });
    }
    const t = frame.table, pc = this.paletteChange(t);
    const stride = (width + 3) & ~3, pixels = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) pixels.set(frame.data.subarray(y * width, (y + 1) * width), (height - 1 - y) * stride);   // bottom-up
    const pcm = new Uint8Array(samples.length * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i], true);
    const parts = [];
    if (pc) parts.push(['00pc', pc]);
    parts.push(['00db', pixels]);
    parts.push(['01wb', pcm]);
    const made = parts.map(([id, data]) => [id, chunk(id, data), data.length]);
    const extra = made.reduce((a, [, c]) => a + c.length, 0);
    const size = this.sizeWith(extra, made.length);
    if (size > this.maxBytes) {
      throw new AviError('too-big', `frame ${this.frames} would take the file to ${size} bytes, past the AVI 1.0 limit of ${this.maxBytes}`, { frame: this.frames });
    }
    for (const [id, c, n] of made) {
      this.index.push({ id, offset: this.moviBytes, size: n });
      this.chunks.push(c);
      this.moviBytes += c.length;
    }
    if (pc || !this.frames) this.palette = Uint32Array.from(t);
    if (!this.frames) this.first = this.palette;
    this.maxVideo = Math.max(this.maxVideo, pixels.length);
    this.maxAudio = Math.max(this.maxAudio, pcm.length);
    this.frames++;
    this.samples += samples.length;
    return this;
  }
  // an AVIPALCHANGE for the entries that differ from the table in force (null: none, or the first frame)
  paletteChange(t) {
    const p = this.palette;
    if (!p) return null;
    let lo = -1, hi = -1;
    for (let i = 0; i < 256; i++) if (((p[i] ^ t[i]) & 0xFFFFFF) !== 0) { if (lo < 0) lo = i; hi = i; }
    if (lo < 0) return null;
    const n = hi - lo + 1, o = new Out(4 + 4 * n);
    o.u8(lo).u8(n & 0xFF).u16(0);   // bFirstEntry, bNumEntries (0 is 256), wFlags
    for (let i = lo; i <= hi; i++) o.u8(t[i] & 0xFF).u8((t[i] >>> 8) & 0xFF).u8((t[i] >>> 16) & 0xFF).u8(0);   // PALETTEENTRY: R, G, B, flags
    return o.b;
  }
  // the file's bytes
  finish() {
    if (!this.frames) throw new AviError('empty', 'the recording has no frames');
    const { num, den } = this.rate, w = this.width, h = this.height;
    const total = this.sizeWith(0, 0);
    const o = new Out(total);
    o.id('RIFF').u32(total - 8).id('AVI ');
    o.id('LIST').u32(this.headerBytes() - 8).id('hdrl');
    const perSec = Math.ceil((this.maxVideo + 8 + 1032) * num / den + this.sampleRate * 2);
    o.id('avih').u32(56)
      .u32(Math.round(1e6 * den / num)).u32(perSec).u32(0).u32(AVIF_HASINDEX)
      .u32(this.frames).u32(0).u32(2).u32(Math.max(this.maxVideo, this.maxAudio) + 8).u32(w).u32(h)
      .u32(0).u32(0).u32(0).u32(0);
    // the video stream
    o.id('LIST').u32(4 + 64 + 8 + 40 + 1024).id('strl');
    o.id('strh').u32(56).id('vids').u32(0).u32(AVISF_VIDEO_PALCHANGES).u16(0).u16(0).u32(0)
      .u32(den).u32(num).u32(0).u32(this.frames).u32(this.maxVideo).u32(0xFFFFFFFF).u32(0)
      .i16(0).i16(0).i16(w).i16(h);
    o.id('strf').u32(40 + 1024)
      .u32(40).u32(w).u32(h).u16(1).u16(8).u32(0).u32(((w + 3) & ~3) * h).u32(0).u32(0).u32(256).u32(0);   // BITMAPINFOHEADER, BI_RGB
    for (let i = 0; i < 256; i++) { const c = this.first[i]; o.u8((c >>> 16) & 0xFF).u8((c >>> 8) & 0xFF).u8(c & 0xFF).u8(0); }   // RGBQUAD: B, G, R, 0
    // the audio stream
    o.id('LIST').u32(4 + 64 + 8 + 16).id('strl');
    o.id('strh').u32(56).id('auds').u32(0).u32(0).u16(0).u16(0).u32(0)
      .u32(1).u32(this.sampleRate).u32(0).u32(this.samples).u32(this.maxAudio).u32(0xFFFFFFFF).u32(2)
      .i16(0).i16(0).i16(0).i16(0);
    o.id('strf').u32(16).u16(1).u16(1).u32(this.sampleRate).u32(this.sampleRate * 2).u16(2).u16(16);   // PCM, mono, 16 bits
    // the frames
    o.id('LIST').u32(this.moviBytes).id('movi');
    for (const c of this.chunks) o.bytes(c);
    o.id('idx1').u32(16 * this.index.length);
    for (const e of this.index) o.id(e.id).u32(e.id === '00pc' ? AVIIF_NOTIME : AVIIF_KEYFRAME).u32(e.offset).u32(e.size);
    if (o.p !== total) throw new AviError('internal', `the AVI came to ${o.p} bytes, not ${total}`);
    return o.b;
  }
}

export const aviWriter = (opts) => new AviWriter(opts);
