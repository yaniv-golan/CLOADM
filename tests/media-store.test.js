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
    const r = s.recentMedia()[0];
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
    s.useMediaStore(fresh);
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
    const r = await s.importMedia('programs/game.bin', new Uint8Array(64).fill(7));
    check('importMedia stores a program under the library prefix', r.stored && r.stored.size === 64 && (await s.listMedia()).some((f) => f.name === 'library/programs/game.bin'), JSON.stringify(await s.listMedia()));
    check('openMedia reads it back', eq(await s.openMedia('programs/game.bin'), new Uint8Array(64).fill(7)));
    check('downloadMedia gives a file name and its bytes', (await s.downloadMedia('programs/game.bin')).name === 'game.bin');
    await s.renameMedia('programs/game.bin', 'programs/better.bin');
    check('renameMedia renames it', (await s.listMedia()).map((f) => f.name).join() === 'library/programs/better.bin');
    check('renameMedia onto a taken name is a clear error', await (async () => {
      await s.importMedia('other.bin', new Uint8Array(4));
      try { await s.renameMedia('programs/better.bin', 'other.bin'); return false; }
      catch (e) { return e instanceof Emu.SessionError && /already|storage/i.test(e.message); }
    })());
    check('deleteMedia removes it', (await s.deleteMedia('programs/better.bin')) === true && !(await s.listMedia()).some((f) => f.name === 'programs/better.bin'));
    check('openMedia of a deleted name is a clear error', await (async () => { try { await s.openMedia('programs/better.bin'); return false; } catch (e) { return e instanceof Emu.SessionError && /no longer stored/.test(e.message); } })());
    // a ROM image dropped through the same door goes through identification, not the blob store
    const rom = await s.importMedia('bas12.rom', new Uint8Array(8192).fill(3));
    check('importMedia identifies a ROM image and sets up its socket', !!rom.roms && s.machineRoms('coco').sockets.find((x) => x.id === 'bas').status !== 'missing-required');
    check('a ROM imported this way is not also listed as user media', !(await s.listMedia()).some((f) => /bas12/.test(f.name)));
    // a full store refuses the write with a message the user can act on
    const tiny = new Emu.Session({ store: Emu.memoryStore(), media: new store.MemoryMediaStore({ quotaBytes: 100 }) });
    let quotaMsg = '';
    try { await tiny.importMedia('big.bin', new Uint8Array(500)); } catch (e) { quotaMsg = e.message; }
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
    s.load('prog.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809')));
    await s.index.flush();
    const internal = (await media.list()).map((f) => f.name).filter((n) => !n.startsWith('library/'));
    check('setup: the index has its own blobs (roms/, recent/, meta/)', internal.some((n) => n.startsWith('roms/')) && internal.some((n) => n.startsWith('recent/')), internal.join(','));
    check('listMedia shows only user media, never the index blobs', (await s.listMedia()).length === 0, JSON.stringify(await s.listMedia()));

    // import over an index name is impossible: it lands under library/ instead
    await s.importMedia('roms/sockets.json', new Uint8Array([0xDE, 0xAD]));
    const socketsBlob = JSON.parse(Buffer.from(await media.read('roms/sockets.json')).toString());
    check('importMedia cannot overwrite the socket map', socketsBlob.coco && socketsBlob.coco.bas, JSON.stringify(socketsBlob));
    check('importMedia of an index-looking name is stored under library/', (await s.listMedia()).some((f) => f.name === 'library/roms/sockets.json'));

    // deleteMedia and renameMedia target library/ names, so an index name cannot be hit
    check('renameMedia of an index-looking name renames the library copy only',
      (await s.renameMedia('roms/sockets.json', 'mine.json')).name === 'library/mine.json' && (await media.stat('roms/sockets.json')) !== null);
    await s.importMedia('roms/sockets.json', new Uint8Array([0xBE, 0xEF]));
    check('deleteMedia of an index-looking name removes the library copy, not the index blob',
      (await s.deleteMedia('roms/sockets.json')) === true && (await media.stat('roms/sockets.json')) !== null);
    // a ".." name cannot climb out of the prefix
    let traversal = '';
    try { await s.importMedia('../roms/sockets.json', new Uint8Array([1])); } catch (e) { traversal = e.message; }
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
