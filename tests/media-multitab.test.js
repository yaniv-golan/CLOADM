// Run: node tests/media-multitab.test.js
//
// Two pages of one origin share one media store (OPFS, or one picked folder), each with its own MediaIndex in
// memory (js/media/library.js). Each change to a list (ROM sockets, ROM file names, the recent list) re-reads the
// stored list under a lock every page shares, applies only that change, and writes the result; nothing one page
// stored is lost to another page's write. Checked here:
//  * two indexes on one asynchronous store (as OPFS: the writes are queued) with interleaved writes of every kind
//    lose nothing, and each index ends up seeing the other's entries;
//  * the same on a synchronous store (two indexes on one in-memory store);
//  * the same socket changed in both: the change made last wins, for that socket only;
//  * collect in one page never removes an image another page's socket uses, nor one whose socket is on its way;
//  * the recent list: entries added in both are kept, newest first, to RECENT_LENGTH; a file the stored list still
//    names is not removed by the other page's eviction;
//  * the lock: navigator.locks is taken for every list change when the page gives it; without it, a lock per store;
//  * refresh(): another page's change read back in, with what changed;
//  * two Sessions with a channel between them (as BroadcastChannel): a ROM, a program and a Library item added in one
//    reach the other's index and panels ('roms', 'recent', 'library'); an in-memory store shares nothing.
// The page itself (two tabs on real OPFS) is tools/browser-check.js, group library.
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaIndex, ROM_SOCKETS, ROM_NAMES, RECENT_LIST, RECENT_LENGTH, romImage, recentFile } = require('../js/media/library.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const dec = new TextDecoder();
const stored = async (st, name, fallback) => { try { return JSON.parse(dec.decode(await st.read(name))); } catch (e) { return fallback; } };
const has = async (st, name) => !!(await st.stat(name));
const bytes = (n) => new Uint8Array([n, n + 1, n + 2]);
// Images and recent files are named by their contents' CRC (the index takes another page's blob only when it matches):
// K.<label> is the CRC of a stand-in made for that label, B.<label> or byCrc(crc) its bytes.
const { crc32 } = require('../js/util.js');
const made = new Map(), byLabel = new Map();
const stand = (label) => { if (!byLabel.has(label)) { const b = new TextEncoder().encode(`stand-in ${label}`); byLabel.set(label, b); made.set(crc32(b), b); } return byLabel.get(label); };
const K = new Proxy({}, { get: (t, label) => crc32(stand(label)) });   // (labels are names, e.g. HALF0001)
const B = new Proxy({}, { get: (t, label) => stand(label) });
const byCrc = (crc) => made.get(crc);

// an asynchronous store (like OPFS) whose every call takes a few turns, in a varying order, so the two indexes' reads
// and writes interleave
class SlowStore extends MemoryMediaStore {
  constructor(kind = 'opfs') { super(); this._kind = kind; this.n = 0; }
  get kind() { return this._kind; }
  get synchronous() { return false; }
  async _turns() { const k = (this.n++ * 7) % 5; for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); }
  async read(name) { await this._turns(); return super.read(name); }
  async write(name, b) { await this._turns(); return super.write(name, b); }
  async remove(name) { await this._turns(); return super.remove(name); }
  async list(p) { await this._turns(); return super.list(p); }
  async stat(name) { return super.stat(name); }
}
const entry = (name, crc, stored = true) => ({ name, crc, size: 3, machine: 'dragon64', stored });
// what rememberMedia does with an index: the program to the front, the oldest off the end
function remember(idx, name, crc) {
  const before = idx.recentMedia();
  const same = (r) => r.name === name && r.crc === crc;
  const list = before.filter((r) => !same(r));
  const dropped = list.splice(RECENT_LENGTH - 1);
  list.unshift(entry(name, crc));
  idx.putRecent(crc, byCrc(crc));
  idx.setRecent(list, { previous: before, removed: before.filter(same) });
  const kept = new Set(list.map((r) => r.crc));
  for (const d of dropped) if (!kept.has(d.crc)) idx.dropRecent(d.crc);
}

(async () => {
  // ---- interleaved writes of every kind, on an asynchronous store ----
  for (const sync of [false, true]) {
    const what = sync ? 'synchronous store' : 'asynchronous store';
    const st = sync ? new MemoryMediaStore() : new SlowStore();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    if (!sync) { await a.load(); await b.load(); }
    // both loaded the empty store; now each changes it without knowing the other's changes
    a.putSocket('dragon64', 'basic', K.AAAA0001); a.putImage(K.AAAA0001, B.AAAA0001, 'a-basic.rom');
    b.putSocket('coco2', 'basic', K.BBBB0001); b.putImage(K.BBBB0001, B.BBBB0001, 'b-basic.rom');
    a.putSocket('dragon64', 'dos', K.AAAA0002); a.putImage(K.AAAA0002, B.AAAA0002, 'a-dos.rom');
    b.putSocket('coco3', 'basic', K.BBBB0002); b.putImage(K.BBBB0002, B.BBBB0002, 'b-coco3.rom');
    remember(a, 'A1.BIN', K.C0000001);
    remember(b, 'B1.BIN', K.D0000001);
    remember(a, 'A2.BIN', K.C0000002);
    b.collect(); a.collect();
    await a.flush(); await b.flush();
    const sockets = await stored(st, ROM_SOCKETS, {}), names = await stored(st, ROM_NAMES, {}), recent = await stored(st, RECENT_LIST, []);
    check(`${what}: every socket either index set is stored`,
      sockets.dragon64?.basic === K.AAAA0001 && sockets.dragon64?.dos === K.AAAA0002 && sockets.coco2?.basic === K.BBBB0001 && sockets.coco3?.basic === K.BBBB0002, JSON.stringify(sockets));
    check(`${what}: every ROM file name either index set is stored`,
      names[K.AAAA0001] === 'a-basic.rom' && names[K.AAAA0002] === 'a-dos.rom' && names[K.BBBB0001] === 'b-basic.rom' && names[K.BBBB0002] === 'b-coco3.rom', JSON.stringify(names));
    const images = await Promise.all([K.AAAA0001, K.AAAA0002, K.BBBB0001, K.BBBB0002].map((c) => has(st, romImage(c))));
    check(`${what}: both collects kept every image a socket uses (either index's)`, images.every(Boolean), images.join());
    // (newest is the change stored last: the two queues interleave, so B1 may land before or after A2)
    const order = recent.map((r) => r.name);
    check(`${what}: the recent list holds both indexes' programs, each index's newest first`,
      order.length === 3 && order.includes('B1.BIN') && order.indexOf('A2.BIN') < order.indexOf('A1.BIN'), order.join());
    const blobs = await Promise.all([K.C0000001, K.D0000001, K.C0000002].map((c) => has(st, recentFile(c))));
    check(`${what}: every recent program's file is stored`, blobs.every(Boolean), blobs.join());
    // each index, refreshed (what the other page's message does), sees the other's entries and images
    await a.refresh(); await b.refresh();
    check(`${what}: after refresh each index has the other's sockets and images`,
      a.socketCrc('coco2', 'basic') === K.BBBB0001 && !!a.image(K.BBBB0002) && b.socketCrc('dragon64', 'dos') === K.AAAA0002 && !!b.image(K.AAAA0001),
      `${JSON.stringify(a.sockets)} | ${JSON.stringify(b.sockets)}`);
    check(`${what}: after refresh each index has the merged recent list and its files`,
      a.recentMedia().map((r) => r.name).join() === order.join() && b.recentMedia().map((r) => r.name).join() === order.join() && !!a.recentData(K.D0000001) && !!b.recentData(K.C0000002));
  }

  // ---- a list write's merged result becomes the index's own once nothing of it is queued ----
  {
    const st = new SlowStore();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    await a.load(); await b.load();
    b.putSocket('coco2', 'basic', K.BBBB0001); b.putImage(K.BBBB0001, B.BBBB0001);
    await b.flush();
    a.putSocket('dragon64', 'basic', K.AAAA0001);
    await a.flush();
    check('a list write reads the other index\'s entries back in (and their images)', a.socketCrc('coco2', 'basic') === K.BBBB0001 && !!a.image(K.BBBB0001), JSON.stringify(a.sockets));
  }

  // ---- the same socket changed in both: the last change wins, for that socket only ----
  for (const sync of [false, true]) {
    const st = sync ? new MemoryMediaStore() : new SlowStore();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    if (!sync) { await a.load(); await b.load(); }
    a.putSocket('dragon64', 'basic', K.AAAA0001); a.putSocket('dragon64', 'dos', K.AAAA0002);
    await a.flush();
    b.putSocket('dragon64', 'basic', K.BBBB0001);
    await b.flush();
    const s = await stored(st, ROM_SOCKETS, {});
    check(`same socket in both (${sync ? 'synchronous' : 'asynchronous'}): the change made last wins, the other socket stays`,
      s.dragon64.basic === K.BBBB0001 && s.dragon64.dos === K.AAAA0002, JSON.stringify(s));
    await a.refresh();
    check(`same socket in both (${sync ? 'synchronous' : 'asynchronous'}): the losing index, refreshed, shows the winner`, a.socketCrc('dragon64', 'basic') === K.BBBB0001);
  }

  // ---- collect never removes an image another index's socket uses ----
  {
    const st = new SlowStore();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    await a.load(); await b.load();
    // b stores a ROM (socket first, then the image: RomLibrary.put); a clears its machine and collects meanwhile
    b.putSocket('coco2', 'basic', K.BBBB0001); b.putImage(K.BBBB0001, B.BBBB0001, 'b.rom');
    a.putSocket('dragon64', 'basic', K.AAAA0001); a.putImage(K.AAAA0001, B.AAAA0001, 'a.rom');
    a.clearMachine('dragon64'); a.collect();
    await Promise.all([a.flush(), b.flush()]);
    check('collect: the image another index\'s socket uses is kept, with its name', await has(st, romImage(K.BBBB0001)) && (await stored(st, ROM_NAMES, {}))[K.BBBB0001] === 'b.rom');
    check('collect: the image no socket uses any more is removed, with its name', !(await has(st, romImage(K.AAAA0001))) && !(K.AAAA0001 in await stored(st, ROM_NAMES, {})));
    // an image whose socket another index has stored is not removed by a collect that started before it saw it
    const c = new MediaIndex(st); await c.load();
    b.putSocket('coco3', 'basic', K.BBBB0003);
    c.collect();
    b.putImage(K.BBBB0003, B.BBBB0003);
    await Promise.all([b.flush(), c.flush()]);
    check('collect: an image stored behind its socket survives another index\'s collect', await has(st, romImage(K.BBBB0003)));
    await a.refresh();
    check('refresh: an image another index removed is gone from memory too', !a.image(K.AAAA0001));
  }

  // ---- a blob another page is still writing (OPFS shows the file empty until its write closes) is not taken ----
  {
    const st = new SlowStore();
    const a = new MediaIndex(st); await a.load();
    const said = [];
    a.foreign = (kind) => said.push(kind);
    await st.write(ROM_SOCKETS, new TextEncoder().encode(JSON.stringify({ dragon64: { basic: K.HALF0001 } })));
    await st.write(romImage(K.HALF0001), new Uint8Array(0));   // created, not yet filled
    await a.refresh();
    check('half-written: an image whose bytes do not match its CRC yet is not taken', a.socketCrc('dragon64', 'basic') === K.HALF0001 && !a.image(K.HALF0001));
    await st.write(romImage(K.HALF0001), B.HALF0001);         // the write closes; the other page says so again
    said.length = 0;
    await a.refresh();
    check('half-written: once whole it is taken on the next message, and the panels hear of it', !!a.image(K.HALF0001) && said.includes('images'), said.join());
  }

  // ---- a list another page stored is put in place only with its blobs: never a row whose bytes are not read yet ----
  for (const kind of ['recent', 'roms']) {
    class HeldRead extends SlowStore {
      read(name) { if (this.hold && this.hold.test.test(name)) { const h = this.hold.p; return h.then(() => super.read(name)); } return super.read(name); }
    }
    const st = new HeldRead();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    await a.load(); await b.load();
    if (kind === 'recent') remember(a, 'HELD.BIN', K.HELD0001);
    else { a.putSocket('dragon64', 'basic', K.HELD0002); a.putImage(K.HELD0002, B.HELD0002); }
    await a.flush();
    let release; st.hold = { test: kind === 'recent' ? /^recent\/.*\.bin$/ : /^roms\/.*\.rom$/, p: new Promise((r) => { release = r; }) };
    const p = b.refresh();
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    const early = kind === 'recent' ? b.recentMedia().length : b.socketCrc('dragon64', 'basic');
    release(); st.hold = null;
    await p;
    check(`adopt (${kind}): while its blobs are being read, the other page's list is not in place yet (no row without its bytes)`, kind === 'recent' ? early === 0 : early === null, String(early));
    check(`adopt (${kind}): once read, the list and its blobs are in place together`,
      kind === 'recent' ? b.recentMedia().length === 1 && !!b.recentData(K.HELD0001) : !!b.image(b.socketCrc('dragon64', 'basic') || ''));
  }

  // ---- RomLibrary.put stores the socket before the image, so a collect elsewhere cannot catch the image alone ----
  // The other index's collect holds the lock and is stopped between reading the sockets and listing the images; the
  // ROM is put meanwhile. Stored socket-first, its socket step waits for the lock and its image is not written yet, so
  // the collect finds nothing to remove; image-first, the image lands unreferenced and the collect would remove it.
  {
    class GatedList extends SlowStore {
      async list(p) { if (p === 'roms/' && this.gate) { const g = this.gate; this.gate = null; this.listing = true; await g; } return super.list(p); }
    }
    const st = new GatedList();
    const S = new Emu.Session({ media: st });
    await S.ready();
    const c = new MediaIndex(st); await c.load();
    let open; st.gate = new Promise((r) => { open = r; });
    c.collect();
    for (let i = 0; i < 50 && !st.listing; i++) await new Promise((r) => setImmediate(r));
    S.roms.put('dragon64', 'basic', bytes(11));   // no file name: no names step ahead of the image in the queue
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    open();
    await Promise.all([c.flush(), S.index.flush()]);
    const crc = S.index.socketCrc('dragon64', 'basic');
    check('RomLibrary.put: the image survives a collect that was under way in another index', st.listing && !!crc && await has(st, romImage(crc)), `listing=${st.listing} crc=${crc}`);
  }

  // ---- the recent list: a file the stored list still names is not removed by an eviction elsewhere ----
  {
    const st = new SlowStore();
    const a = new MediaIndex(st), b = new MediaIndex(st);
    await a.load(); await b.load();
    for (let i = 1; i <= RECENT_LENGTH; i++) remember(a, `P${i}.BIN`, K[`E000000${i}`]);
    await a.flush(); await b.refresh();
    // b loads P1 again (to the front); a loads a new program, which evicts P1 from a's own list
    remember(b, 'P1.BIN', K.E0000001);
    await b.flush();
    remember(a, 'NEW.BIN', K.F0000001);
    await a.flush();
    const list = await stored(st, RECENT_LIST, []);
    check('recent: the entry the other index moved to the front stays (newest first)', list.map((r) => r.name).join() === 'NEW.BIN,P1.BIN,P5.BIN,P4.BIN,P3.BIN', list.map((r) => r.name).join());
    check('recent: its file is not removed by the eviction made from an older list', await has(st, recentFile(K.E0000001)));
    check('recent: the entry pushed off the end by the merge loses its file', !(await has(st, recentFile(K.E0000002))));
    check('recent: the list never grows past RECENT_LENGTH', list.length === RECENT_LENGTH);
  }

  // ---- the lock: navigator.locks for every list change when given; a lock per store otherwise ----
  {
    const st = new SlowStore();
    const taken = [];
    const locks = { request: async (name, run) => { taken.push(name); return run(); } };
    const a = new MediaIndex(st, { locks }), b = new MediaIndex(st, { locks });
    await a.load(); await b.load();
    a.putSocket('dragon64', 'basic', K.AAAA0001); b.putSocket('coco2', 'basic', K.BBBB0001); a.collect();
    await Promise.all([a.flush(), b.flush()]);
    check('lock: navigator.locks is taken, under one name, for every list change and the collect', taken.length >= 3 && taken.every((n) => n === 'cloadm-media-index'), taken.join());
  }

  // ---- what a list write says, and an index without a channel ----
  {
    const st = new SlowStore(), said = [];
    const a = new MediaIndex(st, { post: (w) => said.push(w) });
    await a.load();
    a.putSocket('dragon64', 'basic', K.AAAA0001); a.putImage(K.AAAA0001, B.AAAA0001, 'a.rom'); remember(a, 'X.BIN', K.C0000009); a.collect();
    await a.flush();
    check('post: a ROM change says "roms", a recent change "recent"', said.includes('roms') && said.includes('recent') && said.every((w) => w === 'roms' || w === 'recent'), said.join());
  }

  // ---- two Sessions with a channel between them ----
  {
    const st = new SlowStore('opfs');
    const bus = new Set();
    const channel = () => { const ch = { onmessage: null, postMessage: (data) => { for (const o of bus) if (o !== ch && o.onmessage) setImmediate(() => o.onmessage({ data })); } }; bus.add(ch); return ch; };
    const A = new Emu.Session({ media: st, mediaShare: { locks: null, channel: channel() } });
    const B = new Emu.Session({ media: st, mediaShare: { locks: null, channel: channel() } });
    await A.ready(); await B.ready();
    const heard = [];
    B.on((ev) => { if (ev === 'roms' || ev === 'recent' || ev === 'library') heard.push(ev); });
    A.roms.put('dragon64', 'basic', bytes(7), 'mine.rom');
    await A.index.flush();
    const wait = async (cond) => { const end = Date.now() + 3000; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); return cond(); };
    check('sessions: a ROM stored in one reaches the other\'s index, image and name', await wait(() => !!B.index.socketCrc('dragon64', 'basic') && !!B.index.image(B.index.socketCrc('dragon64', 'basic'))) && B.index.fileName(B.index.socketCrc('dragon64', 'basic')) === 'mine.rom');
    check('sessions: ... and the other one\'s panels hear "roms"', heard.includes('roms'), heard.join());
    A.switchMachine('dragon64');
    A.load('ONE.BIN', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 1, 0x30, 0x00, 0xAA, 0x39]));
    await A.index.flush();
    check('sessions: a program loaded in one is in the other\'s recent list, with its bytes', await wait(() => B.library.recentMedia().some((r) => r.name === 'ONE.BIN')) && !!B.index.recentData(B.library.recentMedia()[0].crc));
    check('sessions: ... and "recent" is heard', heard.includes('recent'), heard.join());
    await A.library.importMedia('SHELF.BIN', new Uint8Array([1, 2, 3]));
    check('sessions: a Library item added in one: the other hears "library", and lists it', await wait(() => heard.includes('library')) && (await B.library.listMedia()).some((f) => f.name === 'library/SHELF.BIN'));
    heard.length = 0;
    await A.library.deleteMedia('SHELF.BIN');
    check('sessions: a Library item removed in one: the other hears "library", and no longer lists it', await wait(() => heard.includes('library')) && !(await B.library.listMedia()).some((f) => f.name === 'library/SHELF.BIN'));
    // an in-memory store is the page's own: nothing is said
    const said = [];
    const mem = new Emu.Session({ media: new MemoryMediaStore(), mediaShare: { locks: null, channel: { onmessage: null, postMessage: (d) => said.push(d) } } });
    mem.roms.put('dragon64', 'basic', bytes(9), 'x.rom');
    await mem.library.importMedia('Q.BIN', new Uint8Array([1]));
    check('sessions: an in-memory store (the fallback) says nothing on the channel', said.length === 0, JSON.stringify(said));
    // ---- the ROM screen's marks: which sockets another tab changed, and what the running machine still has ----
    {
      const st2 = new SlowStore('opfs'), bus2 = new Set();
      const ch2 = () => { const ch = { onmessage: null, postMessage: (data) => { for (const o of bus2) if (o !== ch && o.onmessage) setImmediate(() => o.onmessage({ data })); } }; bus2.add(ch); return ch; };
      const C = new Emu.Session({ welcomeMenu: false, media: st2, mediaShare: { locks: null, channel: ch2() } });
      const D = new Emu.Session({ welcomeMenu: false, media: st2, mediaShare: { locks: null, channel: ch2() } });
      await C.ready(); await D.ready();
      // stand-in images (no ROM code: one byte value repeated), the socket's size
      const one = new Uint8Array(16384).fill(0x12), two = new Uint8Array(16384).fill(0x34);
      C.switchMachine('dragon64'); D.switchMachine('dragon64');
      const marks = [];
      D.on((ev, arg) => { if (ev === 'roms' && arg && arg.elsewhere) marks.push(...arg.elsewhere.map((x) => `${x.machine}:${x.socket}`)); });
      C.roms.put('dragon64', 'basic', one, 'one.rom');
      await C.index.flush();
      check('elsewhere: the other tab hears which socket changed', await wait(() => marks.includes('dragon64:basic')), marks.join());
      check('elsewhere: a socket the running machine does not use yet is not "still in the running machine"', D.romElsewhere('dragon64', 'basic') === null);
      check('elsewhere: the image follows its socket to the other tab (told again once it is written)', await wait(() => !!D.index.image(D.index.socketCrc('dragon64', 'basic') || '')));
      D.switchMachine('dragon64');   // a machine started now runs that ROM
      const runs = D.personMachine.romCrcs().basic;
      check('elsewhere: (switched off and on, the machine runs the stored ROM)', !!runs && runs === D.index.socketCrc('dragon64', 'basic'));
      C.roms.put('dragon64', 'basic', two, 'two.rom');
      await C.index.flush();
      check('elsewhere: replaced in another tab: the running machine keeps the old one, and says so', await wait(() => D.romElsewhere('dragon64', 'basic') === 'replaced')
        && D.personMachine.romCrcs().basic === runs, String(D.romElsewhere('dragon64', 'basic')));
      C.clearRoms();
      await C.index.flush();
      check('elsewhere: removed in another tab: "removed", and the running machine still has it', await wait(() => D.romElsewhere('dragon64', 'basic') === 'removed')
        && D.personMachine.romCrcs().basic === runs, String(D.romElsewhere('dragon64', 'basic')));
      check('elsewhere: only the person\'s own machine and that socket', D.romElsewhere('dragon64', 'basic64') === null && D.romElsewhere('coco2', 'basic') === null);
      D.powerCycle();
      check('elsewhere: switched off and on, it runs what is stored, and the mark goes', D.romElsewhere('dragon64', 'basic') === null && !D.personMachine.romCrcs().basic);
      // a socket this tab sets itself is its own again
      C.roms.put('dragon64', 'basic', one, 'one.rom'); await C.index.flush();
      await wait(() => D.index.socketCrc('dragon64', 'basic'));
      D.roms.put('dragon64', 'basic', two, 'two.rom');
      check('elsewhere: a socket this tab then sets itself is no longer marked', !D.index.changedElsewhere.has('dragon64:basic'));
    }
    // ---- the image follows its socket: told again once it is written (its socket was told first) ----
    {
      class HeldImage extends SlowStore {
        write(name, b) { if (/^roms\/.*\.rom$/.test(name) && this.hold) { const h = this.hold; return h.then(() => super.write(name, b)); } return super.write(name, b); }
      }
      const st3 = new HeldImage('opfs'), bus3 = new Set();
      const ch3 = () => { const ch = { onmessage: null, postMessage: (data) => { for (const o of bus3) if (o !== ch && o.onmessage) setImmediate(() => o.onmessage({ data })); } }; bus3.add(ch); return ch; };
      const E = new Emu.Session({ media: st3, mediaShare: { locks: null, channel: ch3() } });
      const F = new Emu.Session({ media: st3, mediaShare: { locks: null, channel: ch3() } });
      await E.ready(); await F.ready();
      let release; st3.hold = new Promise((r) => { release = r; });
      E.roms.put('dragon64', 'basic', new Uint8Array(16384).fill(0x56));   // no file name: the socket, then the image
      const crc = await (async () => { await wait(() => !!F.index.socketCrc('dragon64', 'basic')); return F.index.socketCrc('dragon64', 'basic'); })();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      const before = !!F.index.image(crc || '');
      release(); st3.hold = null;
      await E.index.flush();
      check('the image follows its socket to the other tab: told again once written', !!crc && !before && await wait(() => !!F.index.image(crc)), `before=${before}`);
    }
    // a message about another kind of store is not this page's
    const before = heard.length;
    await B.mediaElsewhere({ store: 'fsa', what: 'library' });
    check('sessions: a message about another store is ignored', heard.length === before);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
