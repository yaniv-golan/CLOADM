/*
 * HostHooks: the probes and bus taps the Session itself holds (session.hooks), kept across machines. A machine
 * replaced by a switch or a restored snapshot (Session.adopt) gets them all again, in the order they were added,
 * and the machine it replaces loses them. They are host state: no snapshot carries them, and a restored machine
 * has none of its own.
 *
 *   hooks.addProbe(fn)                    Machine.addProbe on the machine in use, and on every later one
 *   hooks.addReadTap(range, fn)           m.busTaps.addReadTap, likewise
 *   hooks.addWriteTap(range, fn)          m.busTaps.addWriteTap, likewise
 *
 * Each returns remove(), which takes it off the machine it is on and out of the Session's list (once).
 * Internal for now: the developer features (a memory-write observer, a profiler) build on it; no public API yet.
 */

export class HostHooks {
  constructor() {
    this.machine = null;
    this.list = [];          // { add(m) -> remove, remove (on this.machine) }
  }
  addProbe(fn) { return this._add((m) => m.addProbe(fn)); }
  addReadTap(range, fn) { return this._add((m) => m.busTaps.addReadTap(range, fn)); }
  addWriteTap(range, fn) { return this._add((m) => m.busTaps.addWriteTap(range, fn)); }
  _add(add) {
    const h = { add, remove: null };
    if (this.machine) h.remove = add(this.machine);   // (a bad range or fn throws here, before it is kept)
    this.list.push(h);
    return () => {
      const i = this.list.indexOf(h);
      if (i < 0) return;
      this.list.splice(i, 1);
      if (h.remove) { h.remove(); h.remove = null; }
    };
  }
  // m is the machine in use from now on: everything moves from the old one to it
  attach(m) {
    if (m === this.machine) return;
    for (const h of this.list) if (h.remove) { h.remove(); h.remove = null; }
    this.machine = m;
    if (m) for (const h of this.list) h.remove = h.add(m);
  }
}
