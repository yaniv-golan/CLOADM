/*
 * MAME-style timers (emu_timer) on top of a machine's scheduler, for chips that keep exact time
 * (js/chips/attotime.js): the floppy drive and the disk controller.
 *
 * Each timer expires at an exact attotime. The clock keeps its timers in expiry order and has one machine
 * event pending, for the earliest, at its tick (fractional ticks allowed), reckoned from the CPU's current
 * position so that a time a whole number of cycles away lands exactly on that cycle. The machine decides when
 * the CPU sees it: with config.mameCompat the SAM machines follow MAME's scheduler slices, so a timer fires at
 * the same CPU check point as in MAME. The event sits 1e-7 tick late, so that one due exactly on a cycle
 * boundary is not taken for one due just before it by the floating-point tick arithmetic.
 *
 * now() is MAME's machine().time(): the expiry time while a timer runs, otherwise the CPU's time at the bus
 * access being performed: host.clockUnits() x host.unitAttos, exact. A machine has one time, as MAME's: while
 * any of its clocks runs a timer, the others' now() is that timer's time too (host.attoNow; a Multi-Pak's
 * cartridge arms the Multi-Pak's line timer from inside its own).
 *
 *   clock.attach(host, eventName)       once the device is in a machine (host: clockUnits, unitAttos, tickAt, schedule, on, off)
 *   clock.detach()                      the device is taken out: its queued event and its handler go
 *   const t = clock.timer(name, fn)     fn(param) runs at expiry
 *   t.adjust(delay, param)              expire `delay` attoseconds from now(); NEVER disables
 *   clock.tickOf(t) / timeAt(tick)     an exact time as the machine's tick, and back
 *   t.enabled()                         timers due at the same time run in the order they were set (MAME's list)
 *   clock.tick                          while a timer runs: the machine tick its event was taken at (for devices
 *                                       that also hand times to tick-based parts, such as a serial line)
 *   clock.saveState() / loadState(s)    timers by name (their owners register the callbacks again)
 */
import { NEVER, toText, fromText } from './attotime.js';

class Timer {
  constructor(clock, name, fn) { this.clock = clock; this.name = name; this.fn = fn; this.expire = NEVER; this.param = 0; this.seq = 0; }
  adjust(delay, param = 0) {
    this.param = param;
    this.seq = ++this.clock.seq;
    this.expire = delay >= NEVER ? NEVER : this.clock.now() + delay;
    this.clock.reschedule();
  }
  enabled() { return this.expire < NEVER; }
}

export class AttoClock {
  constructor() {
    this.host = null;
    this.timers = new Map();
    this.current = null;        // exact time of the timer being run
    this.eventName = null;
    this.pending = null;        // { at, gen } of the machine event scheduled for the earliest timer
    this.gen = 0;
    this.seq = 0;               // order of adjust() calls: timers due at the same time run in that order
    this.tick = null;           // the machine tick of the event being run (see the header)
  }
  timer(name, fn) { const t = new Timer(this, name, fn); this.timers.set(name, t); return t; }
  attach(host, eventName) {
    this.host = host;
    this.eventName = eventName;
    host.on(eventName, (gen, at) => this.fire(gen, at));
    if (!this.pending) this.reschedule();          // a restored clock's event is in the restored queue
  }
  // the device is taken out: its event is cancelled and its handler removed (timers keep their expiry, so a
  // clock attached again carries on)
  detach() {
    if (this.host) this.host.off(this.eventName);
    this.host = null;
    this.pending = null;
  }
  now() {
    if (this.current !== null) return this.current;
    if (!this.host) return 0n;
    if (this.host.attoNow != null) return this.host.attoNow;
    return BigInt(this.host.clockUnits()) * this.host.unitAttos;
  }
  // the exact time of machine tick `tick` (whole units), the inverse of tickOf
  timeAt(tick) {
    const h = this.host;
    return (BigInt(h.clockUnits()) + BigInt(Math.floor(tick - h.tickAt(0)))) * h.unitAttos;
  }
  tickOf(t) {
    const h = this.host, ref = BigInt(h.clockUnits());
    return h.tickAt(Number(t - ref * h.unitAttos) / Number(h.unitAttos)) + 1e-7;
  }
  earliest() {
    let best = null;
    for (const t of this.timers.values()) if (t.expire < NEVER && (!best || t.expire < best.expire || (t.expire === best.expire && t.seq < best.seq))) best = t;
    return best;
  }
  reschedule() {
    if (!this.host) return;
    const e = this.earliest();
    const at = e ? this.tickOf(e.expire) : null;
    if (this.pending && this.pending.at === at) return;
    this.gen++;
    this.pending = null;
    if (at === null) return;
    this.pending = { at, gen: this.gen };
    this.host.schedule(at, this.eventName, this.gen);
  }
  fire(gen, at = null) {
    if (!this.pending || gen !== this.pending.gen) return;      // superseded
    this.pending = null;
    const e = this.earliest();
    if (e) {
      const h = this.host, outer = h.attoNow;
      this.current = e.expire; this.tick = at; h.attoNow = e.expire;
      e.expire = NEVER;
      try { e.fn(e.param); } finally { this.current = null; this.tick = null; h.attoNow = outer; }
    }
    this.reschedule();
  }
  saveState() {
    const timers = {};
    for (const [n, t] of this.timers) timers[n] = { expire: toText(t.expire), param: t.param, seq: t.seq };
    return { timers, pending: this.pending ? { ...this.pending } : null, gen: this.gen, seq: this.seq };
  }
  loadState(s) {
    for (const [n, v] of Object.entries(s.timers)) {
      const t = this.timers.get(n);
      if (!t) throw new Error(`snapshot: unknown timer "${n}"`);
      t.expire = fromText(v.expire); t.param = v.param; t.seq = v.seq;
    }
    this.pending = s.pending ? { ...s.pending } : null;
    this.gen = s.gen;
    this.seq = s.seq;
  }
}
