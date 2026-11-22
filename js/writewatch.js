/*
 * WriteWatch: the Session's memory-write observers (session.watchWrites), built on the host hooks (js/hooks.js):
 * a bus write tap per observer, one probe and one run-end hook. Host state: never in a snapshot, and they follow
 * the person's machine (Session.followPerson moves the hooks; install calls it): the machine in use, or the BASIC
 * session beside a full-screen chat, whose frame then runs through runTo too (Session.watchedRun).
 *
 *   const w = session.watchWrites({ start, end }, (ev) => { ... });   // start..end inclusive
 *   ev = { address, value, old, pc, at, frame }
 *   w.remove();                                                         // once; a second call does nothing
 *
 * When: the write tap only queues the event, during the bus cycle; the callback runs after the writing instruction
 * is done and before the next one starts. Three places deliver the queue, whichever comes first:
 *   * the Session's own run (runTo below), which steps the frame an instruction at a time while an observer is
 *     registered, so that a callback returning 'stop' stops it before the next instruction;
 *   * the run-end hook: Machine.runFrame once the frame's instructions are run (a write in the frame's last
 *     instruction arrives before the frame closes), and the debugger after each instruction it steps;
 *   * the probe, before the next instruction starts, for any other run (a bare machine.runFrame()).
 * A CoCo 3 instruction held by HALT is not done: nothing is delivered while it waits (machine.cpuHeld), and the
 * writes it made before it was suspended are reported once (the taps skip its replayed accesses).
 *
 * ev.pc is the address of the instruction that made the write, as its probe saw it (for the bytes an interrupt
 * stacks: the instruction the interrupt came before). ev.at is the machine's time of the write (ioTime), ev.frame
 * the frame it was in (machine.frameCount), ev.old the byte the address read as just before it.
 */
import { SessionError } from './errors.js';

const isAddr = (a) => Number.isInteger(a) && a >= 0 && a <= 0xFFFF;

export class WriteWatch {
  constructor(session) {
    this.s = session;
    this.list = [];            // { start, end, fn, removeTap }
    this.queue = [];           // { w, ev } in bus order
    this.pc = 0;               // the instruction under way (the probe's pc)
    this.hookRemovers = null;  // the probe and the run-end hook, while any observer is registered
    this.delivering = false;   // a callback is running (SessionError for snapshots and switches)
    this.stopAsked = false;    // a callback returned 'stop' (runTo stops there)
  }
  get active() { return this.list.length > 0; }

  add(range, fn) {
    const { start, end } = range || {};
    if (!isAddr(start) || !isAddr(end) || end < start) throw new SessionError(`watchWrites: the range is { start, end }, addresses from 0 to $FFFF with start <= end (got ${start}, ${end})`);
    if (typeof fn !== 'function') throw new SessionError('watchWrites: the callback must be a function of the event');
    const hooks = this.s.hooks;
    const w = { start, end, fn, removeTap: null };
    if (!this.hookRemovers) {
      this.hookRemovers = [
        hooks.addProbe((pc) => { if (this.queue.length) this.drain(); this.pc = pc; }),
        hooks.addRunEnd(() => { if (this.queue.length) this.drain(); }),
      ];
    }
    w.removeTap = hooks.addWriteTap({ start, end }, (address, value, old) => {
      const m = hooks.machine;
      this.queue.push({ w, ev: { address, value, old, pc: this.pc, at: m.ioTime(), frame: m.frameCount } });
    }, { old: true });
    this.list.push(w);
    return {
      remove: () => {
        const i = this.list.indexOf(w);
        if (i < 0) return;
        this.list.splice(i, 1);
        w.removeTap();
        if (this.list.length) return;
        for (const r of this.hookRemovers) r();
        this.hookRemovers = null;
        this.queue.length = 0;
      },
    };
  }

  // the machine in use changed (Session.install): what the old one queued is not delivered
  reset() { this.queue.length = 0; this.stopAsked = false; }

  // SessionError when a callback is running: `what` may not happen between two instructions
  guard(what) {
    if (this.delivering) throw new SessionError(`${what} is not allowed in a watchWrites callback (the machine is between two instructions)`);
  }

  // deliver what the instruction just done wrote; a callback returning 'stop' stops the run through the debugger
  // ('write', after the queued events are all delivered)
  drain() {
    const m = this.s.hooks.machine;
    if (this.delivering || !m || m.cpuHeld) return;   // (a held CoCo 3 instruction is not done yet)
    let stop = null;
    this.delivering = true;
    try {
      while (this.queue.length) {
        const { w, ev } = this.queue.shift();
        if (!this.list.includes(w)) continue;           // removed since the write
        if (w.fn(ev) === 'stop' && !stop) stop = ev;
      }
    } finally { this.delivering = false; }
    if (stop) {
      this.stopAsked = true;
      this.s.debug._stop('write', { address: stop.address, value: stop.value, pc: m.cpu.pc, writer: stop.pc });
    }
  }

  // Machine.runFrame's run while an observer is registered: an instruction at a time, delivering after each ->
  // false when a callback stopped it (the frame stays open), true at the frame's end
  runTo(m, end) {
    this.stopAsked = false;
    while (m.cycle < end && !m.stall) {
      m.runCycles(end, 1);
      if (this.queue.length) this.drain();
      if (this.stopAsked) { this.stopAsked = false; return false; }
    }
    return true;
  }
}
