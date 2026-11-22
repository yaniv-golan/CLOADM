// MediaIndex.settled() (js/media/library.js): the point at which the writes queued so far are durable.
//
// The contract, from the code (library.js `_op`, `_failed`, `flush`, `settled`):
//  * every store write or remove the index makes is chained on `this.tail`, one after the other;
//  * settled() is flush(): it appends a marker to the tail at the moment it is called and resolves when the
//    marker runs, so it waits for every write queued BEFORE the call, in order, and for nothing queued after;
//  * a write that fails does not reject the chain: `_op` catches it and calls `_failed` (writeError, or
//    console.error), then the chain goes on. So settled() never rejects for a failed write, and it still
//    waits for that write to finish failing before it resolves;
//  * with nothing queued the tail is already resolved, so settled() resolves at once (a few promise turns,
//    before any timer or I/O callback).
// (tests/media-store.test.js has the held-write / release / failed-write checks for the common path; this file
// adds idle, a held failing write, a removal, writes issued after the call, concurrent calls and a store that
// throws synchronously, each with its own assertion so a broken settled() is named by what it got wrong.)
require('./load')();
const store = require('../js/host/media-store-memory.js');
const iface = require('../js/host/media-store.js');
const { MediaIndex } = require('../js/media/library.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// An asynchronous store (like OPFS: the index queues its writes) where any named write or remove can be held
// open until the test releases it, and a named write can be made to fail once it is released.
class GatedStore extends store.MemoryMediaStore {
  constructor() { super(); this.log = []; this.holds = new Map(); this.failing = new Set(); this.throwSync = new Set(); }
  get synchronous() { return false; }
  hold(name) { let r; const p = new Promise((res) => { r = res; }); this.holds.set(name, p); return () => { this.holds.delete(name); r(); }; }
  write(name, bytes) {
    if (this.throwSync.has(name)) throw new iface.MediaStoreError('quota', 'thrown before any promise (forced)');   // not an async function: a plain throw
    return this._gated('write', name, () => super.write(name, bytes));
  }
  remove(name) { return this._gated('remove', name, () => super.remove(name)); }
  async _gated(op, name, run) {
    this.log.push(`start ${op} ${name}`);
    const held = this.holds.get(name);
    if (held) await held;
    if (this.failing.has(name)) { this.log.push(`fail ${op} ${name}`); throw new iface.MediaStoreError('quota', 'no space (forced)'); }
    const r = await run();
    this.log.push(`done ${op} ${name}`);
    return r;
  }
}
const open = async () => { const s = new GatedStore(), idx = new MediaIndex(s); await idx.load(); return { s, idx }; };
// a settling promise that never resolves would park the suite (a parked Node process exits 0): every wait on
// one has a deadline, and its timer is cleared so a passing run does not sit on it
const deadline = (p, ms = 5000) => { let t; const timer = new Promise((r) => { t = setTimeout(() => r('timeout'), ms); }); return Promise.race([p, timer]).finally(() => clearTimeout(t)); };
const turn = () => new Promise((r) => setImmediate(r));
// while a write is held NOTHING correct can resolve, however slow the machine, so resolving inside this
// window is wrong whatever the implementation waited on
const HELD_MS = 400;
const stillPending = async (state) => { const until = Date.now() + HELD_MS; do { await turn(); } while (!state.done && Date.now() < until); return !state.done; };
const track = (p) => { const st = { done: false, rejected: null, at: null }; st.p = p.then(() => { st.done = true; }, (e) => { st.rejected = e; st.done = true; }); return st; };

(async () => {
  // ---- idle: nothing queued, so it resolves at once ----
  {
    const { idx } = await open();
    let resolved = false, timerFired = false;
    setImmediate(() => { timerFired = true; });
    await idx.settled(); resolved = true;
    check('settled(): with nothing queued it resolves at once, before the next I/O turn (no waiting)', resolved && !timerFired, `timerFired=${timerFired}`);
    // and again, after writes that have already landed
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    await idx.settled();
    timerFired = false; setImmediate(() => { timerFired = true; });
    await idx.settled();
    check('settled(): idle again after the writes landed resolves at once too', !timerFired);
  }

  // ---- pending while the LAST queued write is held; resolves after it, with every write finished ----
  {
    const { s, idx } = await open();
    const release = s.hold('recent/BBBB0002.bin');
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    idx.putRecent('BBBB0002', new Uint8Array([1, 2, 3]));
    const st = track(idx.settled());
    check('settled(): stays pending while the last queued write is still held in the store', await stillPending(st), s.log.join(' | '));
    release();
    const out = await deadline(st.p);
    check('settled(): resolves (does not reject) once the held write finishes',
      out !== 'timeout' && st.done && st.rejected === null, out === 'timeout' ? 'never settled' : String(st.rejected));
    const stored = await s.read('recent/BBBB0002.bin').then((b) => [...b].join(), () => 'missing');
    check('settled(): the held write is in the store when it resolves (the last write is not skipped)', stored === '1,2,3', stored);
  }

  // ---- the writes land in the order they were made ----
  {
    const { s, idx } = await open();
    const release = s.hold('roms/sockets.json');
    idx.putSocket('dragon64', 'bas', 'AAAA0001');   // held
    idx.putImage('CCCC0003', new Uint8Array([9]));  // queued behind it
    await turn();
    const startedWhileHeld = s.log.filter((l) => l.startsWith('start')).join();
    release();
    await deadline(idx.settled());
    const order = s.log.filter((l) => l.startsWith('done')).join();
    check('settled(): a write queued behind a held one does not start until the held one finishes',
      startedWhileHeld === 'start write roms/sockets.json', startedWhileHeld);
    check('settled(): writes reach the store in the order they were made', order === 'done write roms/sockets.json,done write roms/CCCC0003.rom', order);
  }

  // ---- a failing write: waited for, reported, not a rejection, and the queue goes on ----
  {
    const { s, idx } = await open();
    const seen = [];
    idx.writeError = (name, e) => seen.push(`${name}:${e.code}`);
    s.failing.add('recent/CCCC0003.bin');
    const release = s.hold('recent/CCCC0003.bin');
    idx.putRecent('CCCC0003', new Uint8Array([4]));   // held, then fails
    idx.putRecent('DDDD0004', new Uint8Array([5]));   // queued behind it
    const st = track(idx.settled());
    check('settled(): a write that is going to fail does not resolve it early: pending while that write is held', await stillPending(st) && seen.length === 0, `seen=${seen}`);
    release();
    const out = await deadline(st.p);
    check('settled(): the failed write is reported through writeError before it resolves, and it does not reject',
      out !== 'timeout' && st.rejected === null && seen.join() === 'recent/CCCC0003.bin:quota', `${out === 'timeout' ? 'never settled' : String(st.rejected)}; seen=${seen}`);
    const next = await s.read('recent/DDDD0004.bin').then((b) => [...b].join(), () => 'missing');
    check('settled(): the write after the failed one still reached the store (the failure did not stop the queue)', next === '5', next);
    // and the chain is intact for a later write
    idx.putRecent('EEEE0005', new Uint8Array([6]));
    await deadline(idx.settled());
    check('settled(): a later write after the failure is durable too', (await s.read('recent/EEEE0005.bin').then((b) => [...b].join(), () => 'missing')) === '6');
  }

  // ---- a failing removal and a store that throws synchronously ----
  {
    const { s, idx } = await open();
    const seen = [];
    idx.writeError = (name, e) => seen.push(`${name}:${e.code}`);
    await s.write('recent/FFFF0006.bin', new Uint8Array([7]));
    s.failing.add('recent/FFFF0006.bin');
    s.throwSync.add('roms/sockets.json');
    idx._remove('recent/FFFF0006.bin');              // rejects when it runs
    idx.putSocket('dragon64', 'bas', 'AAAA0001');   // the store throws before it returns a promise
    idx.putRecent('GGGG0007', new Uint8Array([8]));
    const out = await deadline(idx.settled().then(() => 'resolved', (e) => `rejected: ${e.message}`));
    check('settled(): a failing removal and a store that throws synchronously are reported, not rejected, and the queue goes on',
      out === 'resolved' && seen.join() === 'recent/FFFF0006.bin:quota,roms/sockets.json:quota' && (await s.read('recent/GGGG0007.bin').then((b) => b[0], () => -1)) === 8, `${out}; seen=${seen}`);
  }

  // ---- a write issued AFTER settled() was called is not waited for (the contract: it covers what was queued before) ----
  {
    const { s, idx } = await open();
    const releaseLate = s.hold('recent/HHHH0008.bin');
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    const st = track(idx.settled());                         // covers the socket write only
    idx.putRecent('HHHH0008', new Uint8Array([10]));         // queued after the call, and held
    const out = await deadline(st.p, 2000);
    const lateStarted = s.log.includes('start write recent/HHHH0008.bin'), lateDone = s.log.includes('done write recent/HHHH0008.bin');
    check('settled(): a write issued after the call is not waited for (it resolves while that write is still held)',
      out !== 'timeout' && st.done && st.rejected === null && !lateDone, `${out}; ${s.log.join(' | ')}`);
    check('settled(): ... and that late write is queued behind the covered one, so it had not finished when it resolved', !lateDone);
    // a second call, made after the late write, does cover it
    const st2 = track(idx.settled());
    check('settled(): a call made after the late write is pending while that write is held (it does cover it)', lateStarted && await stillPending(st2));
    releaseLate();
    await deadline(st2.p);
    check('settled(): ... and resolves once it lands', st2.done && (await s.read('recent/HHHH0008.bin').then((b) => b[0], () => -1)) === 10);
  }

  // ---- concurrent calls: each covers everything queued before it ----
  {
    const { s, idx } = await open();
    const release1 = s.hold('roms/sockets.json');
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    const a = track(idx.settled());
    const release2 = s.hold('recent/IIII0009.bin');
    idx.putRecent('IIII0009', new Uint8Array([11]));
    const b = track(idx.settled());
    release1();
    await deadline(a.p);
    const aEarly = a.done, bEarly = await stillPending(b);
    check('settled(): two calls: the first resolves when its own writes land, while the second is still waiting for the later one', aEarly && bEarly, `a=${a.done} b-pending=${bEarly}`);
    release2();
    const out = await deadline(b.p);
    check('settled(): ... and the second resolves once the later write lands', out !== 'timeout' && b.done && (await s.read('recent/IIII0009.bin').then((x) => x[0], () => -1)) === 11);
    // flush() is the same thing under another name
    const release3 = s.hold('roms/names.json');
    idx.putImage('JJJJ000A', new Uint8Array([1]), 'x.rom');
    const f = track(idx.flush()), g = track(idx.settled());
    const pending = await stillPending(f) && !g.done;
    release3();
    await deadline(Promise.all([f.p, g.p]));
    check('settled(): and flush() behave alike (both wait for a held write, both resolve after it)', pending && f.done && g.done);
  }

  // ---- a synchronous store: the writes are already done when the call returns ----
  {
    const sync = new store.MemoryMediaStore();   // answers synchronously (writeSync): the index does not queue
    const idx = new MediaIndex(sync); await idx.load();
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    const stored = (await sync.stat('roms/sockets.json')) !== null;
    let timerFired = false; setImmediate(() => { timerFired = true; });
    await idx.settled();
    check('settled(): on a synchronous store the write has already landed and settled() resolves at once', stored && !timerFired, `stored=${stored} timerFired=${timerFired}`);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
