/*
 * The receiving end of an asynchronous serial line (8 data bits, no parity, 1 stop bit): what an RS-232 printer
 * or terminal on the CoCo's or MC-10's bit-banger output makes of the levels the CPU writes.
 *
 * Sampling follows MAME 0.264's device_serial_interface (src/emu/diserial.cpp): a falling edge while idle starts
 * a character; its receive clock then samples the line 1.5, 2.5, ... 9.5 bit times later (the eight data bits,
 * least significant first, then the stop bit), and the character is complete at the last sample whatever the stop
 * bit's level (MAME's serial printer, src/devices/bus/rs232/printer.cpp rcv_complete, prints it regardless).
 *
 * The CPU's writes are only noted (write(at, level)); characters are decoded later (flush(now)), so receiving
 * puts no events on the machine's time line and cannot change its timing.
 */
export class SerialRx {
  // ticksPerBit: machine ticks per bit (tickHz / baud); onByte(byte, at): a character received, complete at tick at
  constructor(ticksPerBit, onByte) {
    this.ticksPerBit = ticksPerBit;
    this.onByte = onByte;
    this.level = 1;          // the line's level before the first noted edge (idle: mark, 1)
    this.edges = [];         // [tick, level] changes not yet decoded, in time order
    this.start = null;       // tick of the start bit of the character being received
  }
  // the line is at `level` (0 or 1) from tick `at` on
  write(at, level) {
    const last = this.edges.length ? this.edges[this.edges.length - 1][1] : this.level;
    if (level !== last) this.edges.push([at, level]);
  }
  // the level at tick t, from the noted edges
  levelAt(t) {
    let v = this.level;
    for (const [at, l] of this.edges) { if (at > t) break; v = l; }
    return v;
  }
  // decode every character whose last sample is before tick `now`
  flush(now) {
    for (;;) {
      if (this.start === null) {
        const i = this.edges.findIndex(([, l]) => l === 0);
        if (i < 0) { this.drop(Infinity); return; }
        this.start = this.edges[i][0];
      }
      const t = (k) => this.start + (k + 1.5) * this.ticksPerBit;   // sample k: data bits 0-7, stop bit 8
      if (t(8) >= now) { this.drop(this.start); return; }
      let byte = 0;
      for (let k = 0; k < 8; k++) if (this.levelAt(t(k))) byte |= 1 << k;
      const end = t(8);
      this.start = null;
      this.drop(end);
      this.onByte(byte, end);
    }
  }
  // forget the edges before tick t (keeping the level they leave)
  drop(t) {
    while (this.edges.length && this.edges[0][0] <= t) this.level = this.edges.shift()[1];
  }
  saveState() { return { level: this.level, edges: this.edges.map((e) => e.slice()), start: this.start }; }
  loadState(s) { this.level = s.level; this.edges = s.edges.map((e) => e.slice()); this.start = s.start; }
}
