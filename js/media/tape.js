/*
 * Cassette signal generated from a tape image: each bit is one full cycle of a square wave
 * (1200 Hz for 0 and 2400 Hz for 1 on the Dragon/CoCo), least significant bit first.
 * The machine advances it by CPU cycles while the motor runs and samples level().
 *
 * A .CAS image holds the bytes of a tape and nothing of its timing: a real recording has silence where the
 * recorder's motor stopped (around each namefile block) and a full leader in front of the blocks BASIC looks
 * for after switching the motor on. BASIC waits about half a second after the motor starts before it looks for
 * a leader (CASON), and the tape moves meanwhile, so a block whose leader the .CAS file shortened is missed.
 * Like MAME's .CAS player, the tape is therefore played with (`pad`, the default):
 *   - SILENCE * 2 of silence at the start of the tape, SILENCE before every later namefile block and SILENCE
 *     after every namefile block (before the block that follows it);
 *   - a leader of at least LEADER $55 bytes in front of the first block, every namefile block and the block
 *     after each namefile: the file's own leader, made up to LEADER bytes when it has fewer.
 * The amounts are MAME 0.264's, measured from what its cassette input delivers to our own firmware
 * (tools/mame-diff/tape/gaps.asm, run-gaps.js): 1 s of silence (2 s at the start), and leaders of 128 bytes. MAME also
 * shortens longer leaders to 128 bytes, adds a $55 to every block and lengthens runs of $55 between blocks;
 * the file's bytes are kept here (docs/verification.md, "Deviations from MAME").
 * With `pad: false` (the MC-10 family, which has no motor relay) the bytes play as they are after a leader of
 * LEADER bytes.
 */
import { casBlocks } from './cassette.js';

const LEADER = 128;
const SILENCE = 1;           // second

// The signal as entries (a duration in ticks and a level) and, for each byte of the image, the entry it starts
// at: silence and leader made up for a byte come just before it (byteStart points at them).
function build(bytes, tickHz, opts) {
  const half0 = Math.round(tickHz / (opts.zeroHz || 1200) / 2), half1 = Math.round(tickHz / (opts.oneHz || 2400) / 2);
  const silence = Math.round(SILENCE * tickHz);
  // what goes in front of a byte: { silence (units), leader (bytes) }
  const before = new Map();
  const add = (at, units, lead) => {
    const b = before.get(at) || { units: 0, lead: 0 };
    before.set(at, { units: b.units + units, lead: Math.max(b.lead, lead) });
  };
  if (opts.pad === false) add(0, 0, LEADER);
  else {
    const blocks = [...casBlocks(bytes)];
    // the $55 run in front of block i: where it starts, and how long it is (the $55 that ends the block before
    // it is that block's, played before any silence, as MAME does)
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
      add(l.at, units, LEADER - l.n);
    }
    if (!blocks.length) add(0, 0, LEADER);
  }
  let count = bytes.length * 16;
  for (const b of before.values()) count += (b.units ? 1 : 0) + Math.max(0, b.lead) * 16;
  const halves = new Uint32Array(count), levels = new Uint8Array(count), byteStart = new Uint32Array(bytes.length + 1);
  let o = 0;
  const emit = (byte) => {
    for (let bit = 0; bit < 8; bit++) {
      const h = (byte >> bit) & 1 ? half1 : half0;
      halves[o] = h; levels[o++] = 1;
      halves[o] = h; levels[o++] = 0;
    }
  };
  for (let i = 0; i <= bytes.length; i++) {
    byteStart[i] = o;
    const b = before.get(i);
    if (b) {
      if (b.units) { halves[o] = silence * b.units; levels[o++] = 0; }
      for (let k = 0; k < b.lead; k++) emit(0x55);
    }
    if (i < bytes.length) emit(bytes[i]);
  }
  return { halves: halves.subarray(0, o), levels: levels.subarray(0, o), byteStart };
}

class Tape {
  // bytes: tape image; tickHz: the machine's ticks per second; opts.zeroHz / opts.oneHz: bit frequencies;
  // opts.pad: false to play the bytes without the silence and leaders above
  constructor(bytes, tickHz, name, opts = {}) {
    this.name = name || 'tape';
    this.tickHz = tickHz;
    this.opts = opts;
    this.bytes = bytes;
    Object.assign(this, build(bytes, tickHz, opts));
    this.idx = 0;
    this.left = this.halves.length ? this.halves[0] : 0;
  }
  level() { return this.idx < this.halves.length && this.levels[this.idx] === 1; }
  atEnd() { return this.idx >= this.halves.length; }
  advance(cycles) {
    const d = this.halves;
    while (cycles > 0 && this.idx < d.length) {
      if (cycles < this.left) { this.left -= cycles; return; }
      cycles -= this.left;
      this.idx++;
      this.left = d[this.idx] || 0;
    }
  }
  // position at byte offset n of the image (0 = the start of the tape), with the silence and leader played in
  // front of that byte
  seekByte(n) {
    this.idx = n <= 0 ? 0 : n >= this.bytes.length ? this.halves.length : this.byteStart[n];
    this.left = this.halves[this.idx] || 0;
  }
  // the byte of the image being played (silence or leader made up for a byte counts as that byte)
  bytePosition() {
    const s = this.byteStart;
    let lo = 0, hi = this.bytes.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= this.idx) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // the whole tape at real speed, in seconds
  seconds() { let t = 0; for (const h of this.halves) t += h; return t / this.tickHz; }
  // layout 2: idx counts the entries of build(); a snapshot from before it (no layout) counted 128 leader bytes
  // and then the image's bytes, 16 entries each, and is placed at the same byte of the image. Its opts predate
  // `pad`, so the machine's own tape options (profileTape: the MC-10 family's pad: false) say whether it is padded.
  saveState() { return { name: this.name, bytes: this.bytes, tickHz: this.tickHz, opts: this.opts, idx: this.idx, left: this.left, layout: 2 }; }
  static fromState(s, version, profileTape = {}) {
    if (s.layout === 2) { const t = new Tape(s.bytes, s.tickHz, s.name, s.opts); t.idx = s.idx; t.left = s.left; return t; }
    if (version >= 3) throw new Error('snapshot: tape has no "layout"');
    const opts = Object.assign({}, s.opts, profileTape && profileTape.pad === false ? { pad: false } : {});
    const t = new Tape(s.bytes, s.tickHz, s.name, opts);
    if (opts.pad === false) { t.idx = s.idx; t.left = s.left; return t; }   // unpadded: the very same layout
    const old = s.idx - LEADER * 16;
    if (old < 0) t.seekByte(0);
    else if (old >> 4 >= s.bytes.length) t.seekByte(s.bytes.length);
    else { t.idx = t.byteStart[(old >> 4) + 1] - 16 + (old & 15); t.left = s.left; }   // the same cycle of that byte
    return t;
  }
  progress() { return this.halves.length ? this.idx / this.halves.length : 1; }
}

export { Tape };
