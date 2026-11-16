/*
 * Cassette signal generated from a tape image: each bit is one full cycle of a square wave
 * (1200 Hz for 0 and 2400 Hz for 1 on the Dragon/CoCo), least significant bit first.
 * The machine advances it by CPU cycles while the motor runs and samples level().
 */
class Tape {
  // bytes: tape image; tickHz: the machine's ticks per second; opts.zeroHz / opts.oneHz: bit frequencies
  constructor(bytes, tickHz, name, opts = {}) {
    this.name = name || 'tape';
    this.tickHz = tickHz;
    this.opts = opts;
    this.bytes = bytes;
    const half0 = Math.round(tickHz / (opts.zeroHz || 1200) / 2), half1 = Math.round(tickHz / (opts.oneHz || 2400) / 2);
    // prepend a short leader so the ROM has time to sync after the motor starts
    const lead = 128;
    const total = (bytes.length + lead) * 16;
    const d = new Uint16Array(total);
    let o = 0;
    const emit = (byte) => {
      for (let bit = 0; bit < 8; bit++) {
        const h = (byte >> bit) & 1 ? half1 : half0;
        d[o++] = h; d[o++] = h;
      }
    };
    for (let i = 0; i < lead; i++) emit(0x55);
    for (let i = 0; i < bytes.length; i++) emit(bytes[i]);
    this.halves = d;
    this.leadHalves = lead * 16;
    this.idx = 0;
    this.left = d.length ? d[0] : 0;
  }
  level() { return this.idx < this.halves.length && (this.idx & 1) === 0; }
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
  // position at byte offset within the image (0 = start, including leader)
  seekByte(n) {
    this.idx = n <= 0 ? 0 : Math.min(this.halves.length, this.leadHalves + n * 16);
    this.left = this.halves[this.idx] || 0;
  }
  saveState() { return { name: this.name, bytes: this.bytes, tickHz: this.tickHz, opts: this.opts, idx: this.idx, left: this.left }; }
  static fromState(s) {
    const t = new Tape(s.bytes, s.tickHz, s.name, s.opts);
    t.idx = s.idx; t.left = s.left;
    return t;
  }
  progress() { return this.halves.length ? this.idx / this.halves.length : 1; }
}

export { Tape };
