/*
 * BusTaps: observers of the CPU's bus accesses for the host (the debugger's watchpoints; later a memory-write
 * observer and a profiler). Host state, never machine state: nothing here goes in a snapshot.
 *
 *   m.busTaps.addReadTap({ start, end }, fn)    fn(address, value) after each read of start..end (both inclusive)
 *   m.busTaps.addWriteTap({ start, end }, fn)   fn(address, value) after each write there (value: the byte, 0-255);
 *                                               with { old: true }, fn(address, value, old): old is the byte the
 *                                               address read as just before the write (m.peek, no bus cycle)
 *
 * Each returns remove(), which takes that tap off (once; a second call does nothing). Taps on one kind of access
 * run in registration order.
 *
 * Zero cost when unused: the CPU calls the machine's read/write. The first read tap shadows m.read with an instance
 * property that calls the family's own read and then the taps; the last read tap taken off deletes that property,
 * so m.read is the family's method again, whatever order the taps came off in. Writes the same, separately (a
 * write tap leaves reads alone). Nothing else may shadow m.read or m.write: a second observer is a tap.
 *
 * What is reported: every access that goes through the bus methods - the CPU's, and any made through m.read /
 * m.write from outside - once. The family's own methods (rawRead, rawWrite) bypass the taps: the debugger's own
 * memory writes go there, so a watchpoint never fires on what the debugger wrote.
 *
 * Each access is reported once. On the CoCo 3 an instruction that the disk controller's HALT suspends runs again
 * from its start, and the accesses it made before the held one are replayed rather than made again
 * (Coco3Machine.replayRead / replayWrite): they were reported when they were made, and a tap is not called for
 * the replay (Machine.replaying). The one exception is a tap added with { replays: true }, the debugger's: a
 * watchpoint hit belongs to the instruction that completes, so the debugger drops what an instruction reported
 * when it was suspended (Debugger._stepOnce) and takes its accesses again, replayed ones included, from the run
 * that completes it.
 */

const isAddr = (a) => Number.isInteger(a) && a >= 0 && a <= 0xFFFF;

export class BusTaps {
  constructor(machine) {
    this.m = machine;
    this.reads = [];
    this.writes = [];
    this.shadows = { read: null, write: null };   // the instance properties the taps put on the machine
  }
  addReadTap(range, fn, opts) { return this._add('reads', range, fn, opts); }
  addWriteTap(range, fn, opts) { return this._add('writes', range, fn, opts); }
  get active() { return this.reads.length > 0 || this.writes.length > 0; }
  // the family's own bus methods, below any tap
  rawRead(a) { return Object.getPrototypeOf(this.m).read.call(this.m, a); }
  rawWrite(a, v) { Object.getPrototypeOf(this.m).write.call(this.m, a, v); }

  _add(kind, range, fn, { replays = false, old = false } = {}) {
    const { start, end } = range || {};
    if (!isAddr(start) || !isAddr(end) || end < start) throw new RangeError(`bus tap: a range is { start, end }, addresses from 0 to $FFFF with start <= end (got ${start}, ${end})`);
    if (typeof fn !== 'function') throw new TypeError('bus tap: fn(address, value) must be a function');
    const tap = { start, end, fn, replays: !!replays, old: kind === 'writes' && !!old };
    this[kind] = [...this[kind], tap];       // a new list: a tap taken off while the taps run doesn't skip another
    this._shadow(kind);
    return () => {
      if (!this[kind].includes(tap)) return;
      this[kind] = this[kind].filter((t) => t !== tap);
      this._shadow(kind);
    };
  }
  _shadow(kind) {
    const m = this.m, prop = kind === 'reads' ? 'read' : 'write';
    if (this[kind].length === 0) { if (m[prop] === this.shadows[prop]) delete m[prop]; this.shadows[prop] = null; return; }
    if (this.shadows[prop]) return;
    // (anything else shadowing the bus would be skipped by the taps, or lose its hook when they go)
    if (Object.hasOwn(m, prop)) { this[kind] = []; throw new Error(`bus tap: machine.${prop} is already shadowed; only the bus taps may shadow it`); }
    const base = Object.getPrototypeOf(m)[prop];
    if (prop === 'read') {
      m.read = this.shadows.read = (a) => {
        const replayed = m.replaying();       // (asked first: the access itself moves the replay on)
        const v = base.call(m, a);
        const taps = this.reads;
        for (let i = 0; i < taps.length; i++) {
          const t = taps[i];
          if (a >= t.start && a <= t.end && (!replayed || t.replays)) t.fn(a, v);
        }
        return v;
      };
    } else {
      m.write = this.shadows.write = (a, v) => {
        const replayed = m.replaying();
        const taps = this.writes;
        // the byte before the write, for a tap that asked for it (only for an address one of them covers)
        let old = -1;
        for (let i = 0; i < taps.length; i++) {
          const t = taps[i];
          if (t.old && a >= t.start && a <= t.end && (!replayed || t.replays)) { old = m.peek(a & 0xFFFF); break; }
        }
        base.call(m, a, v);
        const b = v & 0xFF;
        for (let i = 0; i < taps.length; i++) {
          const t = taps[i];
          if (a >= t.start && a <= t.end && (!replayed || t.replays)) t.fn(a, b, old);
        }
      };
    }
  }
}
