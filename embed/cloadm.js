/*
 * CLOADM in your page: the host side of the embed API. Include this script, put
 * <iframe src="https://cloadm.dev/play/?embed=1&machine=dragon64"> in your page, then
 *
 *   const m = await CLOADM.attach(iframe);       // resolves once the emulator answers
 *   await m.type('PRINT 2+2\n');
 *   await m.load('game.cas', bytes);             // bytes: Uint8Array or array of numbers
 *   m.on('frame', (f) => ...);                   // also 'machine', 'loaded', 'reset'
 *
 * Calls: info, type, load, insertTape, reset, powerCycle, switchMachine(id, {ram}), peek(addr, n), poke(addr, bytes),
 * screenText, setDisplay({ view: 'sharp' }). Each returns a promise; errors reject with the emulator's message.
 * The protocol (js/embed-api.js): postMessage with { cloadm: 1, id, method, args } and replies by id.
 */
(function () {
  const METHODS = ['info', 'type', 'load', 'insertTape', 'reset', 'powerCycle', 'switchMachine', 'peek', 'poke', 'screenText', 'setDisplay'];
  let nextId = 1;

  function attach(frame, { timeout = 15000 } = {}) {
    const pending = new Map(), handlers = {};
    const target = () => frame.contentWindow;
    // calls go to the emulator's own origin only (the page it was given), never to whatever the frame holds now
    const origin = new URL(frame.src, location.href).origin;
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== target() || e.origin !== origin || !d || d.cloadm !== 1) return;
      if (d.event) { (handlers[d.event] || []).forEach((fn) => fn(d.data)); return; }
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if ('error' in d) p.reject(new Error(d.error)); else p.resolve(d.result);
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      target().postMessage({ cloadm: 1, id, method, args }, origin);
    });
    const machine = { call };
    for (const m of METHODS) machine[m] = (...args) => call(m, ...args);
    machine.on = (event, fn) => {
      (handlers[event] = handlers[event] || []).push(fn);
      if (event === 'frame') call('watchFrames', true);
      return machine;
    };
    // the page may still be loading: ask until it answers
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const ask = () => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); if (Date.now() - t0 > timeout) reject(new Error('CLOADM did not answer')); else ask(); }, 250);
        pending.set(id, { resolve: () => { clearTimeout(timer); resolve(machine); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        try { target().postMessage({ cloadm: 1, id, method: 'info', args: [] }, origin); } catch (e) { /* not loaded yet */ }
      };
      ask();
    });
  }
  window.CLOADM = { attach };
}());
