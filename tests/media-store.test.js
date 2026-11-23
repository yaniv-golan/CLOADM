// MediaStore interface, tested against the in-memory implementation: every method, random access at
// the start, middle, end and past the end, several images open at once, odd names, quota errors, and
// the one-time localStorage migration (including an interrupted run).
const Emu = require('./load')();
const store = require('../js/host/media-store-memory.js');
const iface = require('../js/host/media-store.js');
const { MediaIndex: ifaceIndex, migrateLocalStorage: ifaceMigrate } = require('../js/media/library.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// run fn, requiring a MediaStoreError with `code`
const rejects = async (fn, code) => { try { await fn(); return false; } catch (e) { return e instanceof iface.MediaStoreError && (!code || e.code === code) ? true : (console.log('   threw:', e && e.constructor && e.constructor.name, e && e.code, e && e.message), false); } };
const bytes = (n, seed = 0) => { const b = new Uint8Array(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

(async () => {
  // ---- stat, list, read, write, remove, rename, clear ----
  {
    const s = new store.MemoryMediaStore({ clock: (() => { let t = 1000; return () => (t += 10); })() });
    check('stat of a missing name is null, not an error', (await s.stat('nope')) === null);
    const w = await s.write('roms/basic.rom', bytes(64, 1));
    check('write returns name, size and mtime', w.name === 'roms/basic.rom' && w.size === 64 && typeof w.mtime === 'number', JSON.stringify(w));
    check('stat reports size and mtime, reading no bytes', (await s.stat('roms/basic.rom')).size === 64);
    check('read returns exactly what was written', eq(await s.read('roms/basic.rom'), bytes(64, 1)));
    check('read returns a copy: changing it does not change the store',
      (() => true)() && (await (async () => { const a = await s.read('roms/basic.rom'); a[0] ^= 0xFF; return eq(await s.read('roms/basic.rom'), bytes(64, 1)); })()));
    await s.write('roms/extbas.rom', bytes(32, 2));
    await s.write('tape.cas', bytes(8, 3));
    const all = await s.list();
    check('list is sorted by name and carries size and mtime', all.map((x) => x.name).join() === 'roms/basic.rom,roms/extbas.rom,tape.cas' && all.every((x) => typeof x.size === 'number'));
    check('list takes a prefix', (await s.list('roms/')).map((x) => x.name).join() === 'roms/basic.rom,roms/extbas.rom');
    const r = await s.rename('tape.cas', 'tapes/tape.cas');
    check('rename moves the blob and its bytes', r.name === 'tapes/tape.cas' && (await s.stat('tape.cas')) === null && eq(await s.read('tapes/tape.cas'), bytes(8, 3)));
    check('rename onto an existing name fails with exists', await rejects(() => s.rename('tapes/tape.cas', 'roms/basic.rom'), 'exists'));
    check('rename of a missing name fails with not-found', await rejects(() => s.rename('gone', 'x'), 'not-found'));
    check('remove says whether it existed', (await s.remove('tapes/tape.cas')) === true && (await s.remove('tapes/tape.cas')) === false);
    check('clear counts what it removed', (await s.clear('roms/')) === 2 && (await s.list()).length === 0);
    check('clear(prefix) leaves other names alone', (await (async () => { const t = new store.MemoryMediaStore(); await t.write('a/1', bytes(1)); await t.write('b/1', bytes(1)); const n = await t.clear('a/'); return n === 1 && (await t.list()).map((x) => x.name).join() === 'b/1'; })()));
  }

  // ---- names ----
  {
    const s = new store.MemoryMediaStore();
    const odd = ['a b.bin', 'quote"and\'apos.rom', 'semi;colon.rom', '#hash$dollar%percent.rom', 'paren(1)[2]{3}.dsk'];
    for (const n of odd) await s.write(n, bytes(4));
    check('odd but legal names round-trip', (await s.list()).length === 5 && eq(await s.read('quote"and\'apos.rom'), bytes(4)));
    check('a name of 200 characters is accepted', (await s.write('x'.repeat(200), bytes(1))).name.length === 200);
    // the contract is printable ASCII: anything else is refused, not silently mangled
    for (const bad of ['', '/leading', '\\leading', 'back\\slash', 'bell\u0007', 'x'.repeat(201), 'ünïcode.rom', 'em—dash.rom', null, 42]) {
      check(`invalid name ${JSON.stringify(bad)} is refused`, await rejects(() => s.write(bad, bytes(1)), 'invalid-name'));
    }
    check('write refuses something that is not bytes', await rejects(() => s.write('ok', 'a string'), 'io'));
  }

  // ---- random access: start, middle, end, past the end ----
  {
    const s = new store.MemoryMediaStore();
    const img = bytes(1000, 7);
    await s.write('disk.dsk', img);
    check('readRange at the start', eq(await s.readRange('disk.dsk', 0, 16), img.slice(0, 16)));
    check('readRange in the middle', eq(await s.readRange('disk.dsk', 500, 16), img.slice(500, 516)));
    check('readRange at the end', eq(await s.readRange('disk.dsk', 984, 16), img.slice(984, 1000)));
    check('readRange running past the end is short, not an error', eq(await s.readRange('disk.dsk', 990, 16), img.slice(990, 1000)));
    check('readRange of zero length is empty', (await s.readRange('disk.dsk', 10, 0)).length === 0);
    check('readRange at exactly the end is empty', (await s.readRange('disk.dsk', 1000, 4)).length === 0);
    check('readRange past the end fails with io', await rejects(() => s.readRange('disk.dsk', 1001, 4), 'io'));
    check('readRange of a missing name fails with not-found', await rejects(() => s.readRange('gone', 0, 4), 'not-found'));

    // writes: in place (size unchanged), at the end (grows), and past the end (gap filled with zeroes)
    await s.writeRange('disk.dsk', 0, Uint8Array.of(1, 2, 3, 4));
    check('writeRange at the start overwrites in place', eq((await s.read('disk.dsk')).slice(0, 4), Uint8Array.of(1, 2, 3, 4)) && (await s.stat('disk.dsk')).size === 1000);
    await s.writeRange('disk.dsk', 996, Uint8Array.of(9, 9, 9, 9));
    check('writeRange at the end overwrites without growing', (await s.stat('disk.dsk')).size === 1000 && eq((await s.read('disk.dsk')).slice(996), Uint8Array.of(9, 9, 9, 9)));
    await s.writeRange('disk.dsk', 998, Uint8Array.of(5, 5, 5, 5));
    const grown = await s.read('disk.dsk');
    check('writeRange running past the end grows the blob', grown.length === 1002 && eq(grown.slice(998), Uint8Array.of(5, 5, 5, 5)));
    await s.write('gap.bin', Uint8Array.of(1));
    await s.writeRange('gap.bin', 4, Uint8Array.of(2));
    check('writeRange past the end fills the gap with zeroes', eq(await s.read('gap.bin'), Uint8Array.of(1, 0, 0, 0, 2)));
    check('writeRange of a missing name fails with not-found', await rejects(() => s.writeRange('new.dsk', 0, bytes(4)), 'not-found'));
  }

  // ---- several images open at once, interleaved ----
  {
    const s = new store.MemoryMediaStore();
    const names = ['drive0.vdk', 'drive1.vdk', 'drive2.vdk', 'drive3.vdk'];
    for (let i = 0; i < names.length; i++) await s.write(names[i], new Uint8Array(256 * 16).fill(i));
    // interleave: each write lands in its own image and none disturbs the others
    for (let round = 0; round < 16; round++) for (let i = 0; i < names.length; i++) await s.writeRange(names[i], round * 16, new Uint8Array(16).fill(0xA0 + i));
    let ok = true;
    for (let i = 0; i < names.length; i++) {
      const img = await s.read(names[i]);
      for (let round = 0; round < 16; round++) for (let j = 0; j < 16; j++) if (img[round * 16 + j] !== 0xA0 + i) ok = false;
      for (let k = 256; k < img.length; k++) if (img[k] !== i) ok = false;
    }
    check('four images written interleaved stay independent', ok);
    check('all four are listed', (await s.list()).length === 4);
  }

  // ---- quota ----
  {
    const s = new store.MemoryMediaStore({ quotaBytes: 100 });
    await s.write('a', bytes(60));
    check('a write past the quota fails with quota', await rejects(() => s.write('b', bytes(60)), 'quota'));
    check('the failed write changed nothing', (await s.stat('b')) === null && (await s.stat('a')).size === 60);
    await s.write('a', bytes(40));
    check('replacing a blob charges only the difference', (await s.stat('a')).size === 40 && (await s.write('b', bytes(60))).size === 60);
    check('growing past the quota through writeRange fails with quota',
      await rejects(() => s.writeRange('b', 60, bytes(50)), 'quota'));
    check('a zero-length write at the end is allowed at the quota', (await s.writeRange('b', 60, new Uint8Array(0))).size === 60);
    await s.remove('b');
    check('removing frees space again', (await s.write('c', bytes(60))).size === 60);
  }
  // the synchronous write the media index uses with this store
  {
    const s = new store.MemoryMediaStore({ quotaBytes: 10 });
    let err = null;
    try { s.writeSync('a', bytes(100)); } catch (e) { err = e; }
    check('writeSync past the quota throws quota', err && err.code === 'quota', err ? err.code : 'returned');
    check('...and stored nothing', s.statSync('a') === null && s.bytes === 0);
    check('writeSync within the quota stores it', s.writeSync('b', bytes(10)).size === 10 && s.readSync('b').length === 10);
    let bad = null;
    try { s.writeSync('../x', bytes(1)); } catch (e) { bad = e; }
    check('writeSync with a bad name throws', !!bad);
  }
  // a program loaded while the store is full: it loads, and the recent list says its bytes are not kept
  {
    const Emu = require('./load')();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: new store.MemoryMediaStore({ quotaBytes: 300 }) });
    s.switchMachine('coco');
    let err = null, msg = null;
    try { msg = s.load('big.bin', new Uint8Array(1000).fill(0x12), { askAddresses: () => ({ load: 0x3000, exec: 0x3000 }) }); } catch (e) { err = e; }
    const r = s.library.recentMedia()[0];
    check('a full store: the program still loads', !err && /raw/.test(msg || ''), err ? err.message : msg);
    check('...and the recent list says it is not stored', r && r.name === 'big.bin' && r.stored === false, JSON.stringify(r));
  }

  // ---- the Session moves to another store (the page falls back to memory when browser storage fails) ----
  {
    const Emu = require('./load')();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: new store.MemoryMediaStore() });
    s.switchMachine('coco');
    const seen = [];
    s.index.writeError = (name) => seen.push(name);
    const fresh = new store.MemoryMediaStore({ quotaBytes: 10 });
    s.library.useMediaStore(fresh);
    check('useMediaStore: the Session, its media index and the ROM library use the new store', s.media === fresh && s.index.store === fresh && s.roms.index === s.index);
    check('...the write-error listener carries over', s.index.writeError !== undefined && s.index.writeError !== null);
    s.index.writeError('x', new Error('y'));
    check('...and is the same listener', seen.join() === 'x');
  }

  // ---- the localStorage migration ----
  {
    // a localStorage state exactly as current main writes it: ROM images base64, socket CRCs, a recent
    // list and its files, plus the small settings that must stay put
    const { migrateLocalStorage } = require('../js/media/library.js');
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    const rom1 = bytes(16384, 11), rom2 = bytes(8192, 12), prog = bytes(300, 13);
    const kv = new Map([
      ['machine', 'coco'], ['config.coco', '{"ram":64}'], ['visited', '1'], ['recent', JSON.stringify([{ name: 'game.bin', crc: 'ABCD1234', size: 300, machine: 'coco', stored: true }])],
      ['media.ABCD1234', b64(prog)], ['romdata.11112222', b64(rom1)], ['romname.11112222', 'bas12.rom'], ['rom.coco.bas', '11112222'],
      ['romdata.33334444', b64(rom2)], ['romname.33334444', 'extbas11.rom'], ['rom.coco.extbas', '33334444'],
    ]);
    const ls = { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v), remove: (k) => kv.delete(k), keys: () => [...kv.keys()] };
    const m = new store.MemoryMediaStore();
    const res = await migrateLocalStorage(ls, m);
    check('migration reports what it moved', res.migrated && res.images === 2 && res.sockets === 2 && res.recent === 1, JSON.stringify(res));
    check('migration wrote the ROM images as blobs', eq(await m.read('roms/11112222.rom'), rom1) && eq(await m.read('roms/33334444.rom'), rom2));
    check('migration kept the socket map, which socket holds which CRC',
      JSON.stringify(await m.read('roms/sockets.json').then((b) => JSON.parse(Buffer.from(b).toString()))) === JSON.stringify({ coco: { bas: '11112222', extbas: '33334444' } }));
    check('migration kept the file names', JSON.stringify(JSON.parse(Buffer.from(await m.read('roms/names.json')).toString())) === JSON.stringify({ '11112222': 'bas12.rom', '33334444': 'extbas11.rom' }));
    check('migration wrote the recent list and its file', eq(await m.read('recent/ABCD1234.bin'), prog) && (await m.stat('recent/list.json')) !== null);
    check('migration left nothing behind in localStorage', ![...kv.keys()].some((k) => /^(rom|romdata|romname|media)/.test(k) || k === 'recent'), [...kv.keys()].join(','));
    check('migration left the small settings alone', kv.get('machine') === 'coco' && kv.get('config.coco') === '{"ram":64}' && kv.get('visited') === '1');
    const again = await migrateLocalStorage(ls, m);
    check('a second run does nothing', !again.migrated && again.images === 0);

    // interrupted halfway: the marker was not written, so the next run redoes it and still leaves nothing
    const kv2 = new Map([['recent', JSON.stringify([{ name: 'g.bin', crc: 'DDDD0001', size: 4, machine: 'coco', stored: true }])], ['media.DDDD0001', b64(bytes(4, 3))], ['romdata.55556666', b64(bytes(1024, 4))], ['romname.55556666', 'x.rom']]);
    const ls2 = { get: (k) => kv2.get(k) ?? null, set: (k, v) => kv2.set(k, v), remove: (k) => kv2.delete(k), keys: () => [...kv2.keys()] };
    const m2 = new store.MemoryMediaStore();
    // simulate a crash after the first blob was written but before anything was removed
    await m2.write('roms/55556666.rom', bytes(1024, 4));
    const res2 = await migrateLocalStorage(ls2, m2);
    check('an interrupted migration is redone safely', res2.migrated && eq(await m2.read('roms/55556666.rom'), bytes(1024, 4)) && eq(await m2.read('recent/DDDD0001.bin'), bytes(4, 3)));
    check('the redone migration also leaves nothing behind', ![...kv2.keys()].some((k) => /^(rom|romdata|romname|media)/.test(k) || k === 'recent'), [...kv2.keys()].join(','));
    // a store with no marker but nothing to migrate: no work, marker not needed
    const empty = await migrateLocalStorage({ get: () => null, set() {}, remove() {}, keys: () => [] }, new store.MemoryMediaStore());
    check('nothing to migrate is not an error', empty.migrated === false && empty.images === 0);
  }

  // ---- the Session's library methods (what the Library screen will call) ----
  {
    const Emu = require('./load')();
    const media = new store.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media });
    s.switchMachine('coco');
    const r = await s.library.importMedia('programs/game.bin', new Uint8Array(64).fill(7));
    check('importMedia stores a program under the library prefix', r.stored && r.stored.size === 64 && (await s.library.listMedia()).some((f) => f.name === 'library/programs/game.bin'), JSON.stringify(await s.library.listMedia()));
    check('openMedia reads it back', eq(await s.library.openMedia('programs/game.bin'), new Uint8Array(64).fill(7)));
    check('downloadMedia gives a file name and its bytes', (await s.library.downloadMedia('programs/game.bin')).name === 'game.bin');
    await s.library.renameMedia('programs/game.bin', 'programs/better.bin');
    check('renameMedia renames it', (await s.library.listMedia()).map((f) => f.name).join() === 'library/programs/better.bin');
    check('renameMedia onto a taken name is a clear error', await (async () => {
      await s.library.importMedia('other.bin', new Uint8Array(4));
      try { await s.library.renameMedia('programs/better.bin', 'other.bin'); return false; }
      catch (e) { return e instanceof Emu.SessionError && /already|storage/i.test(e.message); }
    })());
    check('deleteMedia removes it', (await s.library.deleteMedia('programs/better.bin')) === true && !(await s.library.listMedia()).some((f) => f.name === 'programs/better.bin'));
    check('openMedia of a deleted name is a clear error', await (async () => { try { await s.library.openMedia('programs/better.bin'); return false; } catch (e) { return e instanceof Emu.SessionError && /no longer stored/.test(e.message); } })());
    // a ROM image dropped through the same door goes through identification, not the blob store
    const rom = await s.library.importMedia('bas12.rom', new Uint8Array(8192).fill(3));
    check('importMedia identifies a ROM image and sets up its socket', !!rom.roms && s.machineRoms('coco').sockets.find((x) => x.id === 'bas').status !== 'missing-required');
    check('a ROM imported this way is not also listed as user media', !(await s.library.listMedia()).some((f) => /bas12/.test(f.name)));
    // a full store refuses the write with a message the user can act on
    const tiny = new Emu.Session({ store: Emu.memoryStore(), media: new store.MemoryMediaStore({ quotaBytes: 100 }) });
    let quotaMsg = '';
    try { await tiny.library.importMedia('big.bin', new Uint8Array(500)); } catch (e) { quotaMsg = e.message; }
    check('a full store is reported, not thrown raw', /No space left/.test(quotaMsg), quotaMsg);
  }

  // ---- a failing write or remove is reported, not swallowed ----
  {
    class FailingStore extends store.MemoryMediaStore {
      get synchronous() { return false; }
      async write(name, bytes) { if (name === 'roms/sockets.json') throw new iface.MediaStoreError('quota', 'no space (forced)'); return super.write(name, bytes); }
      async remove(name) { if (name.startsWith('roms/') && name.endsWith('.rom')) throw new iface.MediaStoreError('io', 'remove failed (forced)'); return super.remove(name); }
    }
    const failing = new FailingStore();
    const idx = new ifaceIndex(failing);
    await idx.load();
    const seen = [];
    idx.writeError = (name, e) => seen.push(`${name}:${e.code}`);
    idx.putImage('AAAA0001', new Uint8Array([1]));
    idx.putSocket('m', 's', 'AAAA0001');
    await idx.flush();
    // the failed sockets.json write is reported, and the image write that came before it still landed
    check('a failed write is reported through writeError', seen.some((x) => x.startsWith('roms/sockets.json:quota')), seen.join(' '));
    check('a failed write does not stop the writes before it', (await failing.read('roms/AAAA0001.rom')).join() === '1');
    // a failed remove is reported too (this used to be swallowed by .catch(() => {}))
    seen.length = 0;
    idx.sockets = {};             // no socket refers to the image now, so collect() removes it
    idx.collect();
    await idx.flush();
    check('a failed remove is reported through writeError', seen.some((x) => x === 'roms/AAAA0001.rom:io'), seen.join(' '));
  }

  // ---- the queue survives a writeError listener that throws: the failing write is still reported
  // ---- (by the index itself, not by the listener that threw) and every later write still reaches the store ----
  {
    class AlwaysFailingStore extends store.MemoryMediaStore {
      get synchronous() { return false; }
      async write(name, bytes) { if (name === 'roms/sockets.json') throw new iface.MediaStoreError('quota', 'no space (forced)'); return super.write(name, bytes); }
    }
    const st = new AlwaysFailingStore();
    const idx = new ifaceIndex(st);
    await idx.load();
    // the page's listener (js/ui/main.js) draws the status line; a listener bug must not stop the queue
    const seen = [];
    idx.writeError = (name) => { seen.push(name); throw new Error('listener bug (forced)'); };
    const logged = [], realError = console.error;
    console.error = (...a) => logged.push(a);
    try {
      idx.putImage('AAAA0001', new Uint8Array([1]));
      idx.putSocket('m', 's', 'AAAA0001');          // its store write throws 'quota'
      idx.putRecent('BBBB0002', new Uint8Array([2]));  // queued after the failure and the throwing listener
      let settled = 'pending';
      await Promise.race([idx.settled().then(() => { settled = 'resolved'; }, (e) => { settled = `rejected: ${e.message}`; }),
        new Promise((r) => setTimeout(() => r('timeout'), 2000)).then(() => { if (settled === 'pending') settled = 'timeout'; })]);
      check('a throwing writeError listener: settled() still resolves (the queue does not stall)', settled === 'resolved', settled);
      check('... the listener was called with the failed write\'s name', seen.includes('roms/sockets.json'), seen.join(' '));
      check('... and the failure is reported by the index as well, not only through the listener that threw',
        logged.some((a) => typeof a[0] === 'string' && /MediaIndex: roms\/sockets\.json could not be written/.test(a[0])
          && /listener failed too/.test(a[0]) && a.some((x) => x instanceof iface.MediaStoreError && x.code === 'quota') && a.some((x) => x instanceof Error && x.message === 'listener bug (forced)')),
        logged.map((a) => a.map((x) => (x && x.message) || String(x)).join(' ')).join(' | '));
      check('... every write after it still reaches the store (the image from before and the recent file from after)',
        (await st.stat('roms/AAAA0001.rom')) !== null && (await st.stat('recent/BBBB0002.bin')) !== null);
      // a listener that throws does not make the failure report itself into an unhandled rejection
      check('... settled() then resolves again for later writes', await idx.settled().then(() => true, () => false));
    } finally { console.error = realError; }
    // with no listener at all (an embedder that never sets one) the failure is still reported, not dropped
    const st2 = new AlwaysFailingStore();
    const idx2 = new ifaceIndex(st2);
    await idx2.load();
    const logged2 = [], realError2 = console.error;
    console.error = (...a) => logged2.push(a);
    try {
      idx2.putSocket('m', 's', 'AAAA0001');
      await idx2.settled();
      check('with no writeError listener, a failed write is still reported (console.error) and the queue goes on',
        logged2.some((a) => typeof a[0] === 'string' && /MediaIndex: roms\/sockets\.json could not be written/.test(a[0]) && !/listener/.test(a[0]))
        && await idx2.settled().then(() => true, () => false),
        logged2.map((a) => a.map((x) => (x && x.message) || String(x)).join(' ')).join(' | '));
    } finally { console.error = realError2; }
    // the synchronous store's remove path (a separate branch: it does not go through the tail at all). A remove
    // that throws where it is called, with a listener that throws, must be reported, not escape as an unhandled
    // rejection -- which is fatal in Node.
    const st3 = new store.MemoryMediaStore();   // synchronous
    const idx3 = new ifaceIndex(st3);
    st3.remove = () => { throw new iface.MediaStoreError('io', 'remove threw (forced)'); };
    const logged3 = [], realError3 = console.error;
    console.error = (...a) => logged3.push(a);
    let rejected = null;
    const onRejection = (e) => { rejected = e; };
    process.on('unhandledRejection', onRejection);
    try {
      idx3.writeError = () => { throw new Error('listener bug on remove (forced)'); };
      idx3.putImage('AAAA0001', new Uint8Array([1]));
      idx3.sockets = {};                    // nothing refers to it, so collect() removes it (through _remove)
      idx3.collect();
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      check('a synchronous store whose remove throws, with a listener that throws: reported (both errors), and no unhandled rejection',
        logged3.some((a) => typeof a[0] === 'string' && /MediaIndex: roms\/AAAA0001\.rom could not be written/.test(a[0]) && /listener failed too/.test(a[0])
          && a.some((x) => x instanceof iface.MediaStoreError && x.code === 'io') && a.some((x) => x instanceof Error && x.message === 'listener bug on remove (forced)'))
        && rejected === null, `${rejected ? `unhandled: ${rejected.message}` : 'none'} | ${logged3.map((a) => a.map((x) => (x && x.message) || String(x)).join(' ')).join(' | ')}`);
    } finally { process.removeListener('unhandledRejection', onRejection); console.error = realError3; }
    // a reporter that throws must not take the queue with it either: console.error itself replaced by a throwing
    // function (as an instrumentation or a test might)
    {
      class FailingStore4 extends store.MemoryMediaStore {
        get synchronous() { return false; }
        async write(name, bytes) { if (name === 'roms/sockets.json') throw new iface.MediaStoreError('quota', 'no space (forced)'); return super.write(name, bytes); }
      }
      const st4 = new FailingStore4();
      const idx4 = new ifaceIndex(st4);
      await idx4.load();
      const realError4 = console.error;
      console.error = () => { throw new Error('console.error replaced (forced)'); };
      let settled4 = 'pending';
      try {
        idx4.putSocket('m', 's', 'AAAA0001');
        idx4.putRecent('EEEE0005', new Uint8Array([5]));      // queued after the failure: must still reach the store
        await Promise.race([idx4.settled().then(() => { settled4 = 'resolved'; }, (e) => { settled4 = `rejected: ${e.message}`; }),
          new Promise((r) => setTimeout(() => r('timeout'), 2000)).then(() => { if (settled4 === 'pending') settled4 = 'timeout'; })]);
      } finally { console.error = realError4; }
      // (this pins the queue surviving a throwing reporter; it does not prove a fallback report exists -- on
      // pre-fix code the fallback is never called here and this still passes. The falsy-throw test below is the
      // one that pins the report itself.)
      check('a console.error that throws: the queue still resolves and later writes still land (the reporter cannot stop it)',
        settled4 === 'resolved' && (await st4.stat('recent/EEEE0005.bin')) !== null, settled4);
    }
    // a listener that throws a falsy value has still thrown: the failure is reported, not taken as success
    {
      const st5 = new AlwaysFailingStore();
      const idx5 = new ifaceIndex(st5);
      await idx5.load();
      idx5.writeError = () => { throw undefined; };
      const logged5 = [], realError5 = console.error;
      console.error = (...a) => logged5.push(a);
      try { idx5.putSocket('m', 's', 'AAAA0001'); await idx5.settled(); } finally { console.error = realError5; }
      check('a listener that throws a falsy value counts as throwing: the failure is still reported',
        logged5.some((a) => typeof a[0] === 'string' && /could not be written/.test(a[0]) && /listener failed too/.test(a[0])),
        logged5.map((a) => a.map((x) => String(x && x.message !== undefined ? x.message : x)).join(' ')).join(' | ') || 'nothing logged');
    }
  }

  // ---- an asynchronous store whose write throws SYNCHRONOUSLY (not a rejected promise): the throw is reported
  // ---- and the queue goes on, exactly as for a rejection. Without _op's try around run(), the throw would reject
  // ---- the tail and every later write would be lost.
  {
    class SyncThrowStore extends store.MemoryMediaStore {
      get synchronous() { return false; }               // queued, like OPFS
      write(name, bytes) {                              // NOT async: a synchronous throw, not a rejection
        if (name === 'roms/sockets.json') throw new iface.MediaStoreError('quota', 'no space (thrown)');
        return super.write(name, bytes);
      }
    }
    const st = new SyncThrowStore();
    const idx = new ifaceIndex(st);
    await idx.load();
    const reported = [];
    idx.writeError = (name, e) => reported.push(`${name}:${e.code}`);
    idx.putSocket('m', 's', 'AAAA0001');            // its store write throws synchronously
    idx.putRecent('BBBB0002', new Uint8Array([2]));   // queued after the failure
    let settled = 'pending';
    await Promise.race([idx.settled().then(() => { settled = 'resolved'; }, (e) => { settled = `rejected: ${e.message}`; }),
      new Promise((r) => setTimeout(() => r('timeout'), 2000)).then(() => { if (settled === 'pending') settled = 'timeout'; })]);
    check('a store whose write throws synchronously: settled() resolves (the throw does not reject the tail)', settled === 'resolved', settled);
    check('... it is reported once, through the same path as a rejection', reported.join() === 'roms/sockets.json:quota', reported.join() || 'nothing reported');
    check('... and the write queued after it still reaches the store', (await st.stat('recent/BBBB0002.bin')) !== null);
  }

  // ---- writes to one blob are chained: the last write wins, whatever the store's latency ----
  {
    // a store whose latency varies per call, the way OPFS's does; without chaining, the write that
    // started first can finish last and the older value is the one left in storage
    class VaryingStore extends store.MemoryMediaStore {
      constructor() { super(); this.n = 0; }
      get synchronous() { return false; }
      async write(name, bytes) {
        const delay = [12, 1, 9, 2, 15, 3][this.n++ % 6];
        await new Promise((r) => setTimeout(r, delay));
        return super.write(name, bytes);
      }
    }
    const varying = new VaryingStore();
    const idx = new ifaceIndex(varying);
    await idx.load();
    // two socket writes in a row: the second must be what the store ends with
    idx.putSocket('dragon64', 'a', 'AAAA0001');
    idx.putSocket('dragon64', 'b', 'BBBB0002');
    await idx.flush();
    const stored = JSON.parse(Buffer.from(await varying.read('roms/sockets.json')).toString());
    check('chained writes: the store ends with BOTH socket writes', stored.dragon64.a === 'AAAA0001' && stored.dragon64.b === 'BBBB0002', JSON.stringify(stored));

    // a burst of writes to the same blob: the last one wins, never an earlier one finishing late
    for (let i = 0; i < 8; i++) idx.setRecent([{ name: `n${i}`, crc: String(i), stored: true }]);
    await idx.flush();
    const list = JSON.parse(Buffer.from(await varying.read('recent/list.json')).toString());
    check('chained writes: a burst ends with the last value, not the slowest', list.length === 1 && list[0].name === 'n7', JSON.stringify(list));
    // and the image blob itself, written twice
    idx.putImage('AAAA0001', new Uint8Array([1, 1, 1]));
    idx.putImage('AAAA0001', new Uint8Array([2, 2, 2]));
    await idx.flush();
    check('chained writes: the last image bytes are the ones stored', (await varying.read('roms/AAAA0001.rom')).join() === '2,2,2');
  }

  // ---- the index's own blobs are not user media: the Library cannot list, read, rename, delete or
  // ---- import over them, and a ROM or recent change never leaves the index stale ----
  {
    const Emu = require('./load')();
    const media = new store.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media });
    s.switchMachine('coco');
    s.addRoms([{ name: 'bas12.rom', bytes: new Uint8Array(8192).fill(0x31) }]);
    s.load('prog.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809'), { format: 'dragondos' }));
    await s.index.flush();
    const internal = (await media.list()).map((f) => f.name).filter((n) => !n.startsWith('library/'));
    check('setup: the index has its own blobs (roms/, recent/, meta/)', internal.some((n) => n.startsWith('roms/')) && internal.some((n) => n.startsWith('recent/')), internal.join(','));
    check('listMedia shows only user media, never the index blobs', (await s.library.listMedia()).length === 0, JSON.stringify(await s.library.listMedia()));

    // import over an index name is impossible: it lands under library/ instead
    await s.library.importMedia('roms/sockets.json', new Uint8Array([0xDE, 0xAD]));
    const socketsBlob = JSON.parse(Buffer.from(await media.read('roms/sockets.json')).toString());
    check('importMedia cannot overwrite the socket map', socketsBlob.coco && socketsBlob.coco.bas, JSON.stringify(socketsBlob));
    check('importMedia of an index-looking name is stored under library/', (await s.library.listMedia()).some((f) => f.name === 'library/roms/sockets.json'));

    // deleteMedia and renameMedia target library/ names, so an index name cannot be hit
    check('renameMedia of an index-looking name renames the library copy only',
      (await s.library.renameMedia('roms/sockets.json', 'mine.json')).name === 'library/mine.json' && (await media.stat('roms/sockets.json')) !== null);
    await s.library.importMedia('roms/sockets.json', new Uint8Array([0xBE, 0xEF]));
    check('deleteMedia of an index-looking name removes the library copy, not the index blob',
      (await s.library.deleteMedia('roms/sockets.json')) === true && (await media.stat('roms/sockets.json')) !== null);
    // a ".." name cannot climb out of the prefix
    let traversal = '';
    try { await s.library.importMedia('../roms/sockets.json', new Uint8Array([1])); } catch (e) { traversal = e.message; }
    check('a name with .. cannot escape the library prefix', /not a media library name/.test(traversal), traversal);
    // the socket map is still what the index holds in memory, and the machine still boots from it
    check('the in-memory index was never stale or corrupted', s.machineRoms('coco').sockets.find((x) => x.id === 'bas').crc === socketsBlob.coco.bas);
    // a ROM dropped later still round-trips through the index
    const before = s.roms.sockets().length;
    s.clearRoms();
    await s.index.flush();
    check('clearRoms still goes through the index', s.roms.sockets().length === before - 1 && JSON.parse(Buffer.from(await media.read('roms/sockets.json')).toString()).coco.bas === undefined);
  }

  // ---- the media index: an asynchronous store's writes start on their own and settle in order ----
  {
    // a store that delays every write, like OPFS: the index must not leave the queue for a later flush
    class SlowStore extends store.MemoryMediaStore {
      constructor() { super(); this.delays = 0; }
      get synchronous() { return false; }   // like OPFS: no synchronous path at all
      async write(name, bytes) { this.delays++; await new Promise((r) => setTimeout(r, 3)); return super.write(name, bytes); }
    }
    const slow = new SlowStore();
    const idx = new ifaceIndex(slow);
    check('index over a slow store is asynchronous (not loaded in the constructor)', idx.synchronous === false && idx.ready === false);
    await idx.load();
    check('index load reads the store', idx.ready === true);
    // two separate batches of writes: both must reach the store without anyone calling flush()
    idx.setRecent([{ name: 'a', crc: 'A', stored: true }]);
    idx.putRecent('A', new Uint8Array([1]));
    await idx.flush();
    idx.setRecent([{ name: 'b', crc: 'B', stored: true }]);
    idx.putRecent('B', new Uint8Array([2]));
    await idx.flush();
    check('the second batch reaches the store too (the drain restarts)', (await slow.read('recent/list.json')).length > 0
      && (await slow.stat('recent/B.bin')) !== null && (await slow.stat('recent/A.bin')) !== null);
    const list = JSON.parse(Buffer.from(await slow.read('recent/list.json')).toString());
    check('the last write wins, in order', list.length === 1 && list[0].name === 'b', JSON.stringify(list));
  }

  // ---- case: the store's own rule, and how it is measured (js/host/media-store.js CASE) ----
  {
    const st = new store.MemoryMediaStore({ caseInsensitive: true });
    await st.write('disks/GAME.DSK', bytes(10, 1));
    check('case-insensitive store: a name is found in any case', (await st.stat('disks/game.dsk')).name === 'disks/GAME.DSK');
    check('case-insensitive store: the entry keeps the spelling it was written with', (await st.list()).map((x) => x.name).join() === 'disks/GAME.DSK');
    await st.write('DISKS/game.dsk', bytes(4, 2));
    check('case-insensitive store: writing the same name in another case replaces the entry, spelling and size of the first kept',
      (await st.list()).map((x) => `${x.name}:${x.size}`).join() === 'disks/GAME.DSK:4' && eq(await st.read('disks/GAME.DSK'), bytes(4, 2)));
    check('case-insensitive store: list(prefix) is prefix-matched without case', (await st.list('DISKS/')).length === 1 && (await st.list('disks/')).length === 1);
    check('case-insensitive store: rename onto the same entry in another case is allowed (from === to after folding)',
      (await st.rename('disks/GAME.DSK', 'disks/game.dsk')).name === 'disks/game.dsk');
    check('case-insensitive store: rename onto a DIFFERENT entry in another case is refused as exists',
      await (async () => { await st.write('disks/OTHER.DSK', bytes(1)); return rejects(() => st.rename('disks/game.dsk', 'disks/OTHER.dsk'), 'exists'); })());
    check('case-insensitive store: remove in another case removes it', await st.remove('DISKS/GAME.DSK') === true && (await st.stat('disks/GAME.DSK')) === null);
    check('case-insensitive store: writeRange in another case writes the entry there', await (async () => { const t = new store.MemoryMediaStore({ caseInsensitive: true }); await t.write('a/B.bin', bytes(8, 5)); await t.writeRange('A/b.BIN', 0, Uint8Array.of(9)); return (await t.read('a/B.bin'))[0] === 9 && (await t.stat('a/b.bin')).name === 'a/B.bin'; })());
    check('case-insensitive store: clear(prefix) in another case clears it', await (async () => { const t = new store.MemoryMediaStore({ caseInsensitive: true }); await t.write('a/B.bin', bytes(1)); return await t.clear('A/') === 1 && (await t.list()).length === 0; })());
    const sens = new store.MemoryMediaStore();
    await sens.write('disks/GAME.DSK', bytes(3));
    check('case-sensitive store: the other case is another name (missing, not an alias)', (await sens.stat('disks/game.dsk')) === null);
  }

  // ---- measuring it: read-only, cached, and the safe answer while there is nothing to ask about ----
  {
    // A backend with no declared answer: a Map store that folds names when `fold` is set and knows nothing about
    // `caseInsensitive`. It is not a MemoryMediaStore, because that one declares the fact by design; this stands
    // in for OPFS and FSA, whose answer only a listing can supply.
    class Raw {
      constructor(fold) { this.fold = fold; this.m = new Map(); }
      k(n) { return this.fold ? n.toLowerCase() : n; }
      async write(n, b) { this.m.set(this.k(n), { name: n, b }); return { name: n, size: b.length, mtime: 1 }; }
      async stat(n) { const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length, mtime: 1 } : null; }
      async list() { return [...this.m.values()].map((e) => ({ name: e.name, size: e.b.length, mtime: 1 })); }
      async read(n) { return this.m.get(this.k(n)).b.slice(); }
      listSync() { return this.m.values().map ? [] : [...this.m.values()].map((e) => ({ name: e.name })); }   // never used
      async remove(n) { return this.m.delete(this.k(n)); }
      statSync(n) { const e = this.m.get(this.k(n)); return e ? { name: e.name, size: e.b.length } : null; }
    }
    const empty = new Raw(true);
    check('an empty store: the safe answer is case-insensitive, and it is NOT a measurement',
      await iface.detectCase(empty) === true && !empty.caseMeasured);
    const s = new Raw(true);
    await s.write('names/HOLDER.BIN', bytes(1));
    const w0 = s.m.size;
    check('a store with a name: measured from the listing and a stat, writing nothing',
      await iface.detectCase(s) === true && s.caseMeasured && s.m.size === w0);
    check('and leaves no probe behind: exactly the name the test wrote', (await s.list()).map((x) => x.name).join() === 'names/HOLDER.BIN');
    check('it does not measure again once measured', await iface.detectCase(s) === true && s.caseInsensitive === true);
    // a store is measured once: a second call answers from its own record without listing again
    const sens2 = new Raw(false); await sens2.write('names/HOLDER.BIN', bytes(1));
    let listings = 0; const origList = sens2.list.bind(sens2); sens2.list = (...x) => { listings++; return origList(...x); };
    check('a store already measured is answered from its record, with no second listing',
      await iface.detectCase(sens2) === false && await iface.detectCase(sens2) === false && listings === 1, `listings=${listings}`);
    const sens = new Raw(false); await sens.write('names/HOLDER.BIN', bytes(1));
    check('it says case-sensitive where the flip of a stored name is missing', await iface.detectCase(sens) === false);
    // digits-only names cannot put the question: the safe answer, and no measurement
    const digits = new Raw(true); await digits.write('12345678', bytes(1));
    check('a store whose only names have no letters: the safe answer, not a measurement', await iface.detectCase(digits) === true && !digits.caseMeasured);
    // a synchronous store DECLARES its rule (the fact is the instance's own): detectCaseSync reads it and lists
    // nothing. A synchronous store that does not declare is a bug in the store, and is refused rather than guessed
    // at — guessing without a listing cannot be right, and a silent wrong answer here is the unsafe direction.
    const sync = new store.MemoryMediaStore({ caseInsensitive: true });
    check('detectCaseSync takes a declaring store\'s answer and lists nothing',
      iface.detectCaseSync(sync) === true && sync.caseMeasured);
    const syncSens = new store.MemoryMediaStore();
    check('detectCaseSync takes the other answer too', iface.detectCaseSync(syncSens) === false && syncSens.caseMeasured);
    class Undeclared extends store.MemoryMediaStore { constructor() { super(); this.declaresCase = false; } }
    let threw = null; try { iface.detectCaseSync(new Undeclared()); } catch (e) { threw = e; }
    check('detectCaseSync refuses a synchronous store that does not declare, rather than guessing',
      threw instanceof Error && /must declare/.test(threw.message), threw && threw.message);
    // a store that refuses to be listed or stat'ed: fail safe, and say so once
    // A lapsed folder permission (NotAllowedError) is what the browser throws after a reload. It must not break
    // the measurement, and a listing must not let it out raw: every method here answers with a MediaStoreError
    // (the contract's FAILURES section), and the case rule falls back to the safe answer.
    {
      const { FsaMediaStore } = require('../js/host/media-store-fsa.js');
      const perm = () => { const e = new Error('permission denied'); e.name = 'NotAllowedError'; return e; };
      const folder = { name: 'm', kind: 'directory',
        async queryPermission() { return 'granted'; },
        async getDirectoryHandle() { throw perm(); },
        async getFileHandle() { throw perm(); },
        async removeEntry() { throw perm(); },
        entries() { return { [Symbol.asyncIterator]() { return { next() { throw perm(); } }; } }; } };
      const store = new FsaMediaStore(folder);
      let measured = null, threw = null;
      try { measured = await iface.detectCase(store); } catch (e) { threw = e; }
      check('a folder whose permission lapsed measures the safe answer instead of throwing',
        threw === null && measured === true && store.caseMeasured === true, `threw=${threw && threw.name} measured=${measured}`);
      let listErr = null;
      try { await store.list('roms/'); } catch (e) { listErr = e; }
      check('and a listing answers with a MediaStoreError, not the raw DOMException',
        listErr instanceof iface.MediaStoreError && listErr.code === 'unsupported', listErr && `${listErr.name}/${listErr.code}`);
      // a DOMException that reaches detectCase from any backend is still a refusal, not a measurement
      const raw = new Raw(false);
      raw.list = async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; };
      let rawThrew = null, rawAnswer = null;
      try { rawAnswer = await iface.detectCase(raw); } catch (e) { rawThrew = e; }
      check('a raw DOMException from any backend is taken as a refusal, not a measurement',
        rawThrew === null && rawAnswer === true && raw.caseMeasured === true,
        `threw=${rawThrew && rawThrew.name} answer=${rawAnswer}`);
      // and a genuine bug is NOT: it is let out so a later call can retry
      const buggy = new Raw(false);
      buggy.list = async () => { throw new TypeError('a real bug'); };
      let bugThrew = null; try { await iface.detectCase(buggy); } catch (e) { bugThrew = e; }
      check('an ordinary TypeError is still let out (a bug is not a refusal)',
        bugThrew instanceof TypeError && !buggy.caseMeasured, bugThrew && bugThrew.message);
    }

    // a store that refuses the way backends do: a MediaStoreError, which detectCase records as the safe answer
    class Broken extends Raw { async list() { throw new iface.MediaStoreError('io', 'permission denied (test)'); } }
    const warnings = []; const origWarn = console.warn; console.warn = (m) => warnings.push(m);
    const broken2 = new Broken(false);
    check('a store that cannot be read fails safe: names treated as case-insensitive', await iface.detectCase(broken2) === true);
    await iface.detectCase(broken2);   // measured now: answered from its record, no second warning
    console.warn = origWarn;
    check('and it says so once, because the failed measurement is recorded (not retried on every call)',
      warnings.length === 1 && /case sensitivity/.test(warnings[0]), warnings.join(' | '));
    check('flipCase swaps every ASCII letter and nothing else', iface.flipCase('GAME.dsk') === 'game.DSK' && iface.flipCase('a1-_ Z') === 'A1-_ z');
    // A name this project does not write: a store may hold a name this project does not write (a non-ASCII file in the user's own folder, say),
    // and stat() refuses to ask about it. Such a name must not be the one the question is put with: it is passed
    // over, and the next usable name answers. (Before this, one such file settled "folding" for good on an exact
    // folder, so two genuinely different disks could be refused forever.)
    const odd = new Raw(false);
    await odd.write('\u00dc.txt', bytes(1));              // the invalid name, and the shortest, so picked first
    await odd.write('disks/GAME.DSK', bytes(1));
    await odd.write('disks/game.DSK', bytes(1));
    check('a non-ASCII name in the folder is skipped, and the folder still measures case-SENSITIVE',
      await iface.detectCase(odd) === false && odd.caseMeasured === true,
      `ci=${odd.caseInsensitive} measured=${odd.caseMeasured}`);
    check('probeName skips a name checkName refuses', iface.probeName([{ name: '\u00dc.txt' }, { name: 'a.bin' }]) === 'a.bin');
    // and the same on a folding folder: the invalid name must not hide the answer either
    const oddFold = new Raw(true);
    await oddFold.write('\u00dc.txt', bytes(1));
    await oddFold.write('disks/GAME.DSK', bytes(1));
    check('a non-ASCII name on a folding folder still measures case-INSENSITIVE',
      await iface.detectCase(oddFold) === true && oddFold.caseMeasured === true, `ci=${oddFold.caseInsensitive}`);
    // every name invalid: there is nothing to put the question with, so the store stays UNMEASURED and a later
    // name asks again — it must not settle "folding" for good (the same rule as an empty store)
    const allOdd = new Raw(false);
    await allOdd.write('\u00dc.txt', bytes(1));
    await allOdd.write('\u00e9.bin', bytes(1));
    check('a folder whose only names this project cannot ask about stays unmeasured, at the safe answer',
      await iface.detectCase(allOdd) === true && !allOdd.caseMeasured, `measured=${allOdd.caseMeasured}`);
    await allOdd.write('NEW.DSK', bytes(1));   // a name it can ask about arrives
    check('and the next measurement, now that there is a name, answers properly',
      await iface.detectCase(allOdd) === false && allOdd.caseMeasured === true, `ci=${allOdd.caseInsensitive}`);
    // A flip the store fails to stat on ONE candidate is passed over for the next, and that one answers: the
    // first name's failure is not the store's answer.
    const flaky = new Raw(false);
    await flaky.write('aa/GAME.DSK', bytes(1));
    await flaky.write('aa/game.DSK', bytes(1));
    await flaky.write('b/OTHER.DSK', bytes(1));          // the next candidate, short enough to be tried second
    const realStat = flaky.stat.bind(flaky);
    flaky.stat = async (n) => { if (n === 'AA/game.dsk') throw Object.assign(new Error('transient'), { code: 'io' }); return realStat(n); };
    check('a flip the store fails to stat on one name does not decide: the next candidate answers',
      await iface.detectCase(flaky) === false && flaky.caseMeasured === true, `ci=${flaky.caseInsensitive} measured=${flaky.caseMeasured}`);
    // and if EVERY candidate's flip fails that way, nothing decides it: the safe answer, unmeasured, re-asked later
    const allFlaky = new Raw(false);
    await allFlaky.write('d/GAME.DSK', bytes(1));
    allFlaky.stat = async (n) => { if (/^D\//.test(n)) throw Object.assign(new Error('transient'), { code: 'io' }); return null; };
    check('a store whose every flip fails stays unmeasured, at the safe answer',
      await iface.detectCase(allFlaky) === true && !allFlaky.caseMeasured, `measured=${allFlaky.caseMeasured}`);
    check('probeName takes the shortest name with a letter, and null when none has one',
      iface.probeName([{ name: '123' }, { name: 'ABCD' }, { name: 'Zs' }]) === 'Zs' && iface.probeName([{ name: '123' }]) === null);
  }

// A faithful File System Access folder for Node: files keyed by (folded) full path, each carrying the real path.
// fold: true = one entry for both spellings (APFS/NTFS), false = distinct entries (ext4). The folder decides, as a
// real one does; the store and the measurement must follow it.
function fsaFolder({ fold }) {
  const files = new Map();
  const key = (p) => (fold ? p.toLowerCase() : p);
  const put = (p, bytes) => { const k = key(p); files.set(k, { name: (files.get(k) || {}).name || p, bytes }); };
  const has = (p) => files.has(key(p));
  const under = (prefix) => [...files.keys()].some((k) => k.startsWith(key(prefix)));
  const mkFile = (bytes, name) => new File([bytes], name, { lastModified: 1700000000000 });
  const dir = (prefix) => ({
    name: prefix || 'mock', kind: 'directory',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getDirectoryHandle(name, { create } = {}) {
      const at = prefix ? `${prefix}/${name}` : name;
      if (!create && !under(at + '/')) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return dir(at);
    },
    async getFileHandle(name, { create } = {}) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!create && !has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return {
        async getFile() { return mkFile((files.get(key(p)) || {}).bytes || new Uint8Array(0), (files.get(key(p)) || {}).name || name); },
        async createWritable(opts = {}) {
          let buf = opts.keepExistingData ? ((files.get(key(p)) || {}).bytes || new Uint8Array(0)).slice() : new Uint8Array(0);
          return {
            write(d) {
              if (d && d.type === 'write') { const end = d.position + d.data.length; if (end > buf.length) { const n = new Uint8Array(end); n.set(buf); buf = n; } buf.set(d.data, d.position); }
              else if (d == null) buf = new Uint8Array(0);
              else buf = d instanceof Uint8Array ? d : new Uint8Array(d);
              return Promise.resolve();
            },
            truncate(n) { buf = buf.slice(0, n); return Promise.resolve(); },
            close() { put(p, buf); return Promise.resolve(); },
          };
        },
      };
    },
    async removeEntry(name) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      files.delete(key(p));
    },
    entries() {
      const base = prefix ? prefix + '/' : '';
      const kids = new Map();
      for (const [k, e] of files) {
        if (!k.startsWith(key(base))) continue;
        const rest = e.name.slice(base.length), slash = rest.indexOf('/');
        if (slash < 0) { kids.set(rest, 'file'); continue; }
        kids.set(rest.slice(0, slash), 'directory');
      }
      return {
        [Symbol.asyncIterator]() {
          const it = kids.entries();
          return { next() {
            const r = it.next();
            if (r.done) return Promise.resolve({ done: true });
            const [n, kind] = r.value, p = base + n;
            const e = files.get(key(p));
            return Promise.resolve({ done: false, value: [n, kind === 'file' ? { kind: 'file', async getFile() { return mkFile((e || {}).bytes || new Uint8Array(0), (e || {}).name || n); } } : dir(p)] });
          } };
        },
      };
    },
  });
  return { root: dir(''), put, files };
}

// The same for the Origin Private File System, which walks differently: entries() yields [name, handle] where a
// handle IS the directory or the file (no separate getFileHandle for a child already listed), and files are
// written through a writable on the file handle. `fold` is the volume's own rule, as in fsaFolder.
function opfsRoot({ fold }) {
  const files = new Map();
  const key = (p) => (fold ? p.toLowerCase() : p);
  const put = (p, bytes) => { const k = key(p); files.set(k, { name: (files.get(k) || {}).name || p, bytes }); };
  const has = (p) => files.has(key(p));
  const under = (prefix) => [...files.keys()].some((k) => k.startsWith(key(prefix)));
  const mk = (bytes, name) => ({ size: bytes.length, lastModified: 1700000000000, name, async arrayBuffer() { return bytes.slice().buffer; } });
  const dir = (prefix) => ({
    name: prefix ? prefix.split('/').pop() : 'opfs', kind: 'directory',
    async getDirectoryHandle(name, { create } = {}) {
      const at = prefix ? `${prefix}/${name}` : name;
      if (!create && !under(at + '/')) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return dir(at);
    },
    async getFileHandle(name, { create } = {}) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!create && !has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return {
        async getFile() { return mk((files.get(key(p)) || {}).bytes || new Uint8Array(0), (files.get(key(p)) || {}).name || name); },
        async createWritable() {
          let buf = new Uint8Array(0);
          return {
            async write(d) { buf = d instanceof Uint8Array ? d.slice() : new Uint8Array(d); },
            async close() { put(p, buf); },
          };
        },
      };
    },
    async removeEntry(name) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      files.delete(key(p));
    },
    // what a walk sees: each child as [name, handle], the handle itself being the directory or the file
    entries() {
      const base = prefix ? prefix + '/' : '';
      const kids = new Map();
      for (const [k, e] of files) {
        if (!k.startsWith(key(base))) continue;
        const rest = e.name.slice(base.length), slash = rest.indexOf('/');
        if (slash < 0) { kids.set(rest, 'file'); continue; }
        kids.set(rest.slice(0, slash), 'directory');
      }
      return {
        [Symbol.asyncIterator]() {
          const it = kids.entries();
          return { next() {
            const r = it.next();
            if (r.done) return Promise.resolve({ done: true });
            const [n, kind] = r.value, p = base + n, e = files.get(key(p));
            return Promise.resolve({ done: false, value: [n, kind === 'file' ? { kind: 'file', async getFile() { return mk((e || {}).bytes || new Uint8Array(0), (e || {}).name || n); } } : dir(p)] });
          } };
        },
      };
    },
  });
  return { root: dir(''), put };
}

  // ---- the real backends, measured against a folder that decides for itself ----
  // The probe tests above use Map doubles whose stat echoes what was asked, which is why earlier probes found
  // shape after shape of wrong probe. These drive the REAL backends over a folder whose folding is its own fact, in
  // every arrangement that matters: one file, two genuinely different files that are each other's case (including
  // a directory whose own spelling differs), and nothing at all.
  {
    const { FsaMediaStore } = require('../js/host/media-store-fsa.js');
    const { OpfsMediaStore } = require('../js/host/media-store-opfs.js');
    const cases = [
      // [fold, files, expected caseInsensitive]
      [true, ['disks/GAME.DSK'], true],
      [true, ['disks/GAME.DSK', 'disks/game.dsk'], true],           // one folder directory, still one entry
      [true, ['disks/GAME.DSK', 'DISKS/game.dsk'], true],           // and a second directory spelling is that folder too
      [false, ['disks/GAME.DSK'], false],
      [false, ['disks/GAME.DSK', 'DISKS/game.dsk'], false],         // two genuinely different files, different dirs
      [false, ['disks/GAME.DSK', 'disks/game.DSK'], false],         // two genuinely different files, one dir
      [true, [], true],                                              // nothing to ask with: the safe answer
    ];
    // A measurement must not list through its own question: if it does, detectCase either recurses until the stack
    // goes or waits on itself. Either way this check names the defect, and it runs early in the block so that a
    // broken split is reported by it rather than by whichever check happens to hit the recursion first.
    {
      const folder = fsaFolder({ fold: false }); folder.put('disks/GAME.DSK', new Uint8Array(1));
      const of = opfsRoot({ fold: false }); of.put('disks/GAME.DSK', new Uint8Array(1));
      for (const [what, store] of [['FsaMediaStore', new FsaMediaStore(folder.root)], ['OpfsMediaStore', new OpfsMediaStore({ root: of.root })]]) {
        let answer;
        try { answer = await Promise.race([iface.measureOnce(store), new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000))]); }
        catch (e) { answer = `threw ${e && e.name}`; }
        // `false` is the right answer AND evidence the measurement ran: the folder tells cases apart. A store that
        // merely did not hang would still have to give this answer.
        check(`${what}: the first measurement completes (no deadlock through its own listing)`, answer === false, `answer=${answer}`);
      }
    }
    for (const [fold, layout, want] of cases) {
      const folder = fsaFolder({ fold });
      for (const p of layout) folder.put(p, new Uint8Array(1));
      const store = new FsaMediaStore(folder.root);
      const got = await iface.detectCase(store);
      check(`FsaMediaStore over a ${fold ? 'folding' : 'exact'} folder, ${JSON.stringify(layout)}: measured ${want}`,
        got === want, `got ${got}`);
      // the same arrangements through the other backend: its walk is its own code, so a rule that holds for one
      // walk is not evidence for the other
      const of = opfsRoot({ fold });
      for (const p of layout) of.put(p, new Uint8Array(1));
      const opfsStore = new OpfsMediaStore({ root: of.root });
      const gotOpfs = await iface.detectCase(opfsStore);
      check(`OpfsMediaStore over a ${fold ? 'folding' : 'exact'} store, ${JSON.stringify(layout)}: measured ${want}`,
        gotOpfs === want, `got ${gotOpfs}`);
    }
    // Two things make this a real test, and the first version got both wrong. The prefix: with 'disks/' a listing
    // that folded still walked the same directory and found the same files, so it passed for the wrong reason - a
    // prefix that names an entry ('disks/G') is filtered for real. And the fixture has to make the GUESS wrong:
    //   - a folder that tells cases apart, holding both spellings: the right answer is case-sensitive, so a caller
    //     that guessed case-insensitive returns 'disks/game.DSK' as well, one name too many;
    //   - a folder that does not, holding ONE file spelled in lower case: it can only hold one, and 'disks/game.dsk'
    //     matches the prefix 'disks/G' only where the listing folds, so a caller that guessed case-sensitive
    //     returns nothing at all.
    // One folder rule cannot do both (on an exact folder a guess of exact is right, on a folding one a guess of
    // folding is), so the first version proved only half of it.
    {
      const fixtures = [
        { fold: false, put: ['disks/GAME.DSK', 'disks/game.DSK'], want: 'disks/GAME.DSK', why: 'catches a guess of case-insensitive' },
        { fold: true, put: ['disks/game.dsk'], want: 'disks/game.dsk', why: 'catches a guess of case-sensitive' },
      ];
      for (const { fold, put, want, why } of fixtures) {
        const folder = fsaFolder({ fold }); for (const p of put) folder.put(p, new Uint8Array(1));
        const opfs = opfsRoot({ fold }); for (const p of put) opfs.put(p, new Uint8Array(1));
        for (const [what, store] of [['FsaMediaStore', new FsaMediaStore(folder.root)], ['OpfsMediaStore', new OpfsMediaStore({ root: opfs.root })]]) {
          const [a, b] = await Promise.all([store.list('disks/G'), store.list('disks/G')]);
          check(`${what} over a ${fold ? 'folding' : 'exact'} folder (${why}): a second concurrent listing sees the measured answer`,
            store.caseInsensitive === fold && a.map((x) => x.name).join() === want && b.map((x) => x.name).join() === want,
            `ci=${store.caseInsensitive} a=[${a.map((x) => x.name)}] b=[${b.map((x) => x.name)}]`);
        }
      }
    }
    // A store that KEEPS the first answer it gave is wrong, and only this shape shows it: an empty store's safe
    // answer is case-insensitive and UNMEASURED, so once a name arrives the question is put again and the answer
    // may change. Caching the first answer would leave a case-sensitive folder answering case-insensitive for good
    // - the same class of bug this commit is about - and every test above would still pass, because they all
    // measure a store that is already populated.
    {
      for (const [what, make] of [
        ['FsaMediaStore', () => { const f = fsaFolder({ fold: false }); return [new FsaMediaStore(f.root), f]; }],
        ['OpfsMediaStore', () => { const f = opfsRoot({ fold: false }); return [new OpfsMediaStore({ root: f.root }), f]; }],
      ]) {
        const [store, folder] = make();
        // the empty store listed through _case() FIRST, so a backend that stores the answer it first gave has one
        // to be stale with; an empty store has nothing to ask, so the safe answer is folding and nothing is measured
        const emptyListed = await store.list('disks/G');
        const emptyAnswer = await iface.measureOnce(store);
        const wasMeasured = store.caseMeasured;
        folder.put('disks/game.dsk', new Uint8Array(1));
        // this prefix matches 'disks/game.dsk' only where the listing folds. A store that re-measures finds this
        // folder exact and returns nothing; one that kept its first (folding) answer returns the file.
        const listed = await store.list('disks/G');
        const after = await iface.measureOnce(store);
        check(`${what}: an empty store's safe answer is not a measurement, so the rule is measured once it has a name`,
          emptyListed.length === 0 && emptyAnswer === true && wasMeasured !== true && listed.length === 0 && after === false,
          `empty=${emptyAnswer} measuredThen=${wasMeasured} listed=[${listed.map((x) => x.name)}] after=${after}`);
        check(`${what}: ... and that second call is a real measurement (caseMeasured is true) and is kept`,
          store.caseMeasured === true && store.caseInsensitive === false && (await iface.measureOnce(store)) === false,
          `measured=${store.caseMeasured} ci=${store.caseInsensitive}`);
      }
    }
    // A self-measuring backend's _listing must be its own walk, not a call back into list(): the measurement lists
    // through _listing, so a _listing that awaits measureOnce (directly or through list()) asks the measurement for
    // its own answer and never settles. The two real backends are shaped that way and are covered above; this case
    // pins WHAT the contract requires rather than tolerating the cyclic shape. It must terminate: the recursion
    // runs out of stack, which is a loud failure the suite can report, not a hang.
    {
      class Cyclic extends require('../js/host/media-store-memory.js').MemoryMediaStore {
        get synchronous() { return false; }
        constructor() { super(); this.declaresCase = false; this.caseInsensitive = null; }
        async _listing(prefix) { return this.list(prefix); }          // the forbidden shape: back into measureOnce
        async list(prefix = '') { await iface.measureOnce(this); return super.listSync(prefix); }
      }
      const s = new Cyclic(); await s.write('GAME.DSK', new Uint8Array(1));
      let answer;
      try { answer = await Promise.race([iface.measureOnce(s), new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000))]); }
      catch (e) { answer = `threw ${e && e.name}`; }
      check('a cyclic _listing is not supported, and says so by failing rather than by silently measuring nothing',
        typeof answer === 'string' && /threw/.test(answer) && !s.caseMeasured, `answer=${answer} measured=${s.caseMeasured}`);
    }
    // and the measurement only ever lists the WHOLE store. That is what makes the rule it passes inert (at the
    // empty prefix both walks match every name either way), so it is asserted rather than assumed: the store below
    // records what it was asked for, and a prefixed measurement would be visible here.
    {
      const s = new (require('../js/host/media-store-memory.js').MemoryMediaStore)();
      await s.write('a/GAME.DSK', new Uint8Array(1));
      const seen = [];
      const store = { caseMeasured: false, caseInsensitive: null, list: (p) => s.listSync(p), _listing: (p, ci) => { seen.push([p, ci]); return s.listSync(p); } };
      await iface.detectCase(store);
      check('detectCase lists the whole store, so the rule it passes cannot decide the probe',
        seen.length === 1 && seen[0][0] === '', JSON.stringify(seen));
    }
    // What a failure does, decided rather than accidental, and tested both ways:
    //  - a measurement that THROWS (not a store refusal: a bug or an unexpected error) is not cached, so the next
    //    call tries again — a rejected promise left in place would freeze the safe answer for the whole visit;
    //  - a store that REFUSES (detectCase's own catch) is different on purpose: it records the safe answer so it is
    //    not asked on every call (the rule tested above as "says so once").
    {
      const folder = fsaFolder({ fold: false });
      folder.put('disks/GAME.DSK', new Uint8Array(1));
      const store = new FsaMediaStore(folder.root);
      let broken = true;
      // the seam the measurement actually uses: patching list() would no longer test anything, because the
      // measurement lists through _listing (it must not ask for the answer it is computing)
      const realList = store._listing.bind(store);
      // a throw with no code is an unexpected error: detectCase lets that shape out (see its catch)
      store._listing = async (pr, ci) => { if (broken) throw new Error('the test broke the store'); return realList(pr, ci); };
      let firstThrew = null;
      try { await iface.measureOnce(store); } catch (e) { firstThrew = e; }
      broken = false;
      let after = null;
      try { after = await store._case(); } catch (e) { after = `threw again: ${e.message}`; }
      check('an unexpected measurement failure is not cached: the next call tries again and answers',
        firstThrew instanceof Error && after === false && store.caseInsensitive === false && !store._measuring,
        `firstThrew=${firstThrew && firstThrew.message} after=${after} ci=${store.caseInsensitive}`);
    }
    // measureOnce itself shares one in-flight measurement, whatever the caller (not only through _case)
    {
      class Slow extends (require('../js/host/media-store-memory.js').MemoryMediaStore) {
        get synchronous() { return false; }
        constructor() { super(); this.declaresCase = false; this.caseInsensitive = null; this.listCalls = 0; }
        async list(p = '') { this.listCalls++; await new Promise((r) => setTimeout(r, 5)); return super.listSync(p); }
      }
      const s2 = new Slow(); await s2.write('disks/GAME.DSK', new Uint8Array(1));
      const [x, y, z] = await Promise.all([iface.measureOnce(s2), iface.measureOnce(s2), iface.measureOnce(s2)]);
      check('three concurrent callers share one measurement, and all see the same answer',
        x === false && y === false && z === false && s2.listCalls === 1 && s2.caseMeasured === true,
        `x=${x} y=${y} z=${z} listings=${s2.listCalls}`);
    }
    // and a second measurement costs no listing (the answer is the store's own record)
    const folder = fsaFolder({ fold: false });
    folder.put('disks/GAME.DSK', new Uint8Array(1));
    const store = new FsaMediaStore(folder.root);
    await iface.detectCase(store);
    let listed = 0; const orig = store.list.bind(store); store.list = (...a) => { listed++; return orig(...a); };
    await iface.detectCase(store);
    check('FsaMediaStore: a measured store answers without listing again', listed === 0, `listings=${listed}`);
  }

  // ---- MediaIndex.settled(): the point at which the queued writes are durable ----
  {
    // A store like OPFS: asynchronous, and a named write can be held open until the test releases it. A
    // correct settled() waits on the write queue, so it is still pending while the LAST queued write is
    // held, with the queue drained up to it, so nothing but waiting lets it finish; and at the moment it
    // resolves every write the store was given has finished. It covers the writes queued before it: like
    // flush(), it appends a marker at call time, so a write queued after the call is deliberately not
    // waited for.
    //
    // "Waits on the queue" is separated from "waits a while" without freezing or patching anything, so the
    // argument holds for any delay API (a bare setTimeout, setInterval, AbortSignal.timeout, a platform
    // sleep, a Date.now spin): while the last write is held NOTHING correct can resolve, however loaded the
    // machine is, so any settled() that resolves inside HELD_MS is wrong whatever it waited on. No promise
    // about how fast a CORRECT one resolves is made beyond the liveness deadline: a tight time window after
    // the release would wrongly fail correct bodies (a post-flush setImmediate) on a loaded machine, where one
    // turn's latency can exceed it.
    // Limits: a wrong settled() that simply waits longer than HELD_MS, unrelated to the release, is not
    // caught; nor is one that blocks the thread synchronously.
    class GatedStore extends store.MemoryMediaStore {
      constructor() { super(); this.started = []; this.finished = 0; this.holds = new Map(); this.fail = null; }
      get synchronous() { return false; }   // like OPFS: the index queues its writes
      hold(name) { let r; const p = new Promise((res) => { r = res; }); this.holds.set(name, p); return () => { this.holds.delete(name); r(); }; }
      async write(name, bytes) {
        this.started.push(name);
        const held = this.holds.get(name);
        if (held) await held;
        if (name === this.fail) throw new iface.MediaStoreError('quota', 'no space (forced)');
        const done = await super.write(name, bytes);
        this.finished++;
        return done;
      }
    }
    const gated = new GatedStore();
    const idx = new ifaceIndex(gated);
    await idx.load();
    // a settled() that never resolves parks the suite, and a parked Node process exits 0, which the gate
    // would report as a pass: every wait on a settling promise here is given a deadline instead, and the
    // deadline timer is cleared so a passing run does not sit on it for the rest of its timeout
    const deadline = (p, ms) => {
      let t;
      const timer = new Promise((r) => { t = setTimeout(() => r('timeout'), ms); });
      return Promise.race([p, timer]).finally(() => clearTimeout(t));
    };
    // long enough that a settled() which waits instead of watching cannot plausibly resolve inside it, and
    // that a correct one is never timed at all: it cannot resolve while the write is held, at any speed
    const HELD_MS = 500;
    const releaseLast = gated.hold('recent/BBBB0002.bin');
    // these three are queued on the store; the last one is held, so the queue can drain up to it and no
    // further. Holding the LAST write is what makes the wait observable: if the queue were free to finish,
    // a settled() that simply slept would find it drained and look correct.
    idx.putSocket('dragon64', 'bas', 'AAAA0001');
    idx.setRecent([{ name: 'game.bin', crc: 'BBBB0002', stored: true }]);
    idx.putRecent('BBBB0002', new Uint8Array([1, 2, 3]));
    let done = false, failed = null, finishedAtResolve = null, startedAtResolve = null;
    const settling = idx.settled().then(() => {
      // read the store's counters as settled() resolves, before anything else can run
      finishedAtResolve = gated.finished; startedAtResolve = gated.started.length; done = true;
    }, (e) => { failed = e; done = true; });
    // give any implementation that resolves on its own every chance to do so, for HELD_MS of real time. A
    // correct one cannot, because the last write is still held.
    // (do/while: the hold is entered at least once, so a stall between computing the end time and the first
    // check cannot skip it)
    const heldUntil = Date.now() + HELD_MS;
    do { await new Promise((r) => setImmediate(r)); } while (!done && Date.now() < heldUntil);
    check('settled(): is still pending while the store holds a queued write',
      gated.started.length >= 3 && gated.finished === gated.started.length - 1 && !done,
      `started=${gated.started.length} finished=${gated.finished} done=${done}${failed ? ` failed=${failed.message}` : ''}`);
    releaseLast();
    // from here only liveness is required: a correct settled() has everything it needs and resolves; one
    // that never resolves is caught by the deadline rather than parking the suite
    const outcome = await deadline(settling, 5000);
    check('settled(): resolves (does not reject) once the held write is released',
      outcome !== 'timeout' && failed === null,
      outcome === 'timeout' ? 'never settled' : (failed ? `rejected: ${failed.message}` : 'resolved'));
    check('settled(): every write the store was given has finished by the time it resolves',
      outcome !== 'timeout' && done && failed === null && startedAtResolve >= 3 && finishedAtResolve === startedAtResolve,
      `started=${startedAtResolve} finished=${finishedAtResolve}`);

    // a queued write that fails is reported through writeError, and settled() does not reject for it
    gated.fail = 'recent/CCCC0003.bin';
    const seen = [];
    idx.writeError = (name, e) => seen.push(`${name}:${e.code}`);
    idx.putRecent('CCCC0003', new Uint8Array([4]));
    idx.putRecent('DDDD0004', new Uint8Array([5]));
    const before = gated.finished;
    // read the counter at the instant this call resolves, as for the first call: a settled() that hands
    // back an earlier flush (memoised, or correct only once) resolves before this queue has drained
    let rejected = null, second = 'pending', secondFinished = null;
    await deadline(idx.settled().then(() => { secondFinished = gated.finished; second = 'resolved'; },
      (e) => { rejected = e; secondFinished = gated.finished; second = 'resolved'; }), 5000);
    // the failed write does not finish; the one after it does, so the queue went on
    check('settled(): a failed queued write is reported through writeError, it does not reject, and the queue goes on',
      second === 'resolved' && rejected === null && seen.join() === 'recent/CCCC0003.bin:quota' && secondFinished === before + 1,
      `${second === 'pending' ? 'never resolved' : (rejected ? rejected.message : seen.join())}; ${secondFinished === null ? 'n/a' : secondFinished - before} finished by then`);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
