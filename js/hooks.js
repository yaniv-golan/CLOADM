/*
 * HostHooks: the probes and bus taps the Session itself holds (session.hooks), kept across machines. A machine
 * replaced by a switch or a restored snapshot (Session.adopt) gets them all again, in the order they were added,
 * and the machine it replaces loses them. They are host state: no snapshot carries them, and a restored machine
 * has none of its own.
 *
 *   hooks.addProbe(fn)                    Machine.addProbe on the machine in use, and on every later one
 *   hooks.addReadTap(range, fn)           m.busTaps.addReadTap, likewise
 *   hooks.addWriteTap(range, fn, opts)    m.busTaps.addWriteTap, likewise (opts: { old })
 *   hooks.addRunEnd(fn)                   Machine.addRunEnd, likewise
 *   hooks.add(attach)                     anything else kept on the machine in use: attach(m) puts it on m and returns
 *                                         its remove() (the disk controller's traces, session.disk). session.serial
 *                                         keeps a registry of its own, on the person's machine (SerialApi.follow)
 *
 * Each returns remove(), which takes it off the machine it is on and out of the Session's list (once).
 * Internal: the developer features build on it (the memory-write observer, Session.watchWrites: js/writewatch.js).
 */

export class HostHooks {
  constructor() {
    this.machine = null;
    this.list = [];          // { add(m) -> remove, remove (on this.machine) }
  }
  addProbe(fn) { return this._add((m) => m.addProbe(fn)); }
  addReadTap(range, fn) { return this._add((m) => m.busTaps.addReadTap(range, fn)); }
  addWriteTap(range, fn, opts) { return this._add((m) => m.busTaps.addWriteTap(range, fn, opts)); }
  addRunEnd(fn) { return this._add((m) => m.addRunEnd(fn)); }
  add(attach) {
    if (typeof attach !== 'function') throw new TypeError('hooks.add: attach is a function of the machine');
    return this._add(attach);
  }
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
  // m is the machine in use from now on: everything moves from the old one to it. All or nothing: if one can't go
  // on m (a bus tap on a machine whose bus something else shadows), what went on is taken off again, everything
  // stays on the old machine, and the error is thrown.
  attach(m) {
    if (m === this.machine) return;
    const added = [];
    try {
      if (m) for (const h of this.list) added.push(h.add(m));
    } catch (e) {
      for (const remove of added) remove();
      throw e;
    }
    for (const h of this.list) if (h.remove) h.remove();
    this.list.forEach((h, i) => { h.remove = m ? added[i] : null; });
    this.machine = m;
  }
}
