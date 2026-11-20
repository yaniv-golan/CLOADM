/*
 * The media index: what the Session reads instead of reaching into storage on every call.
 *
 * Media that must survive a reload lives in a MediaStore (js/host/media-store.js). Reading it is
 * asynchronous and writing costs a round trip, but the Session's callers (the page, embedders, the
 * test suites) are synchronous and must stay so. So on startup the Session makes one awaited call —
 * ready() — which loads everything it needs into this index, and from then on:
 *   - reads answer from memory (synchronous, no round trip);
 *   - writes go to memory at once and are queued to the store, so the next read already sees them.
 *
 * The index holds:
 *   roms/<CRC>.rom        each ROM image once
 *   roms/sockets.json     { machine: { socket: CRC } } — which socket holds which image
 *   roms/names.json       { CRC: file name }          — the file each image came from
 *   recent/list.json      the recent-programs list (metadata only)
 *   recent/<CRC>.bin      the bytes of a recent program that is still stored
 *   meta/migrated         the one-time localStorage migration has run
 *
 * The index OWNS those names. User media lives under its own prefix (LIBRARY_PREFIX, below) so the two
 * can never collide: the Library lists, renames, deletes and imports only under that prefix, and the ROM
 * and recent blobs are changed only through the methods here, which keep the in-memory index in step.
 *
 * Writes are BEST-EFFORT until settled() (or flush()) resolves: they are chained so they reach the store
 * in the order they were made, and a failure is reported through writeError, but nothing waits for them on
 * the caller's behalf and a page that unloads mid-write can lose the last one.
 *
 * Disk images and DriveWire files do NOT go through this index: it loads every blob into
 * memory at startup, which is wrong for a 160K-800K image read and written by sector. They use a
 * MediaStore's readRange/writeRange directly; only small, always-wanted media belongs here.
 *
 * The one-time migration from localStorage (where main kept all of this before this item) is here too.
 * Browser-free: js/emu.js still loads in Node.
 */
import { MediaStoreError } from '../host/media-store.js';

export const ROM_SOCKETS = 'roms/sockets.json';
export const ROM_NAMES = 'roms/names.json';
export const RECENT_LIST = 'recent/list.json';
export const MIGRATION_MARKER = 'meta/migrated';
// the index's files that change in place (the rest are named by their contents' CRC, or written once)
export const INDEX_LISTS = [ROM_SOCKETS, ROM_NAMES, RECENT_LIST];
// the recent list's length (Session.rememberMedia keeps the newest)
export const RECENT_LENGTH = 5;
// user media lives here, apart from the index's own names; the Library may only touch this prefix
export const LIBRARY_PREFIX = 'library/';
export const isLibraryName = (name) => typeof name === 'string' && name.startsWith(LIBRARY_PREFIX) && name.length > LIBRARY_PREFIX.length;
// the prefixes the index owns; nothing else may write them
export const INDEX_PREFIXES = ['roms/', 'recent/', 'meta/'];
export const romImage = (crc) => `roms/${crc}.rom`;
export const recentFile = (crc) => `recent/${crc}.bin`;

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v) => enc.encode(JSON.stringify(v));
const parse = (bytes, fallback) => { try { return JSON.parse(dec.decode(bytes)); } catch (e) { return fallback; } };

// a read that treats a missing blob as absent rather than an error
export async function readOrNull(store, name) {
  try { return await store.read(name); } catch (e) { if (e instanceof MediaStoreError && e.code === 'not-found') return null; throw e; }
}

/*
 * TODO: remove after the 1.0 release (kept until the first tagged release, for pages that saved in the old layout).
 * One-time migration from the localStorage layout main used: 'romdata.<CRC>' (base64 image),
 * 'romname.<CRC>', 'rom.<machine>.<socket>' (the CRC), 'media.<CRC>' (base64 program), 'recent'
 * (the list as JSON). The small settings are untouched.
 *
 * Safe to re-run: the marker is written only after every migrated key has been removed, so an
 * interrupted run repeats from the start on the next load. Each step is idempotent (a blob written
 * twice is the same blob; a key removed twice is gone).
 */
export async function migrateLocalStorage(ls, store) {
  const result = { migrated: false, images: 0, sockets: 0, recent: 0 };
  if (ls.get(MIGRATION_MARKER) !== null) return result;
  const keys = ls.keys ? ls.keys() : [];
  const romdata = keys.filter((k) => k.startsWith('romdata.'));
  const romname = keys.filter((k) => k.startsWith('romname.'));
  const socketKeys = keys.filter((k) => /^rom\.[^.]+\./.test(k));
  const mediaKeys = keys.filter((k) => k.startsWith('media.'));
  const hasRecent = keys.includes('recent');
  if (!romdata.length && !socketKeys.length && !mediaKeys.length && !hasRecent) return result;

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (romdata.length) {
    const names = {};
    for (const k of romname) names[k.slice(8)] = ls.get(k);
    for (const k of romdata) {
      const crc = k.slice(8);
      await store.write(romImage(crc), b64(ls.get(k)));
      result.images++;
    }
    // merge into whatever the store already has (a re-run after an interruption)
    const sockets = Object.assign({}, parse((await readOrNull(store, ROM_SOCKETS)) || new Uint8Array(0), {}));
    for (const k of socketKeys) {
      const m = k.slice(4), dot = m.indexOf('.');
      const machine = m.slice(0, dot), socket = m.slice(dot + 1);
      (sockets[machine] = sockets[machine] || {})[socket] = ls.get(k);
      result.sockets++;
    }
    if (socketKeys.length) await store.write(ROM_SOCKETS, json(sockets));
    const storedNames = Object.assign({}, parse((await readOrNull(store, ROM_NAMES)) || new Uint8Array(0), {}), names);
    if (Object.keys(storedNames).length) await store.write(ROM_NAMES, json(storedNames));
  }
  if (hasRecent) {
    for (const k of mediaKeys) await store.write(recentFile(k.slice(6)), b64(ls.get(k)));
    const list = parse(enc.encode(ls.get('recent') || '[]'), []) || [];
    await store.write(RECENT_LIST, json(list));
    result.recent = mediaKeys.length;
  }
  // last: remove what was moved, then mark the migration done
  for (const k of [...romdata, ...romname, ...socketKeys, ...mediaKeys]) ls.remove(k);
  if (hasRecent) ls.remove('recent');
  ls.set(MIGRATION_MARKER, '1');
  result.migrated = true;
  return result;
}

/*
 * The in-memory index. `store` is a MediaStore. load() reads the index blobs plus every ROM image and
 * recent file, so nothing below it needs to be asynchronous.
 *
 * A store that already holds its bytes in memory (MemoryMediaStore, and so the Node tests, embedders
 * and the import/download fallback) answers synchronously, and the index uses that: it is then loaded
 * in the constructor, and no caller anywhere becomes asynchronous. Every other store is asynchronous,
 * and the Session loads it with one awaited ready() at startup.
 */
export class MediaIndex {
  constructor(store) {
    this.store = store;
    this.synchronous = !!store.synchronous;
    this.ready = false;
    this.sockets = {};          // machine -> { socket: crc }
    this.names = {};            // crc -> file name
    this.images = new Map();    // crc -> Uint8Array
    this.recent = [];           // the list as the Session uses it: [{ name, crc, size, machine, stored }]
    this.recentBytes = new Map(); // crc -> Uint8Array
    this.changed = { sockets: new Set(), names: new Set(), recent: false };   // since load: what mergeInto counts as newer
    this.tail = Promise.resolve(); // the write chain: every store operation runs after the one before
    this.writeError = null;     // (name, error) => void: a background write failed (quota, permission)
    if (this.synchronous) this.loadSync();
  }

  async load() {
    this.changed = { sockets: new Set(), names: new Set(), recent: false };
    this.sockets = parse((await readOrNull(this.store, ROM_SOCKETS)) || new Uint8Array(0), {});
    this.names = parse((await readOrNull(this.store, ROM_NAMES)) || new Uint8Array(0), {});
    this.recent = parse((await readOrNull(this.store, RECENT_LIST)) || new Uint8Array(0), []);
    this.images.clear();
    this.recentBytes.clear();
    for (const f of await this.store.list('roms/')) {
      const m = /^roms\/([0-9A-Fa-f]+)\.rom$/.exec(f.name);
      if (m) this.images.set(m[1].toUpperCase(), await this.store.read(f.name));
    }
    for (const f of await this.store.list('recent/')) {
      const m = /^recent\/([0-9A-Fa-f]+)\.bin$/.exec(f.name);
      if (m) this.recentBytes.set(m[1].toUpperCase(), await this.store.read(f.name));
    }
    this.ready = true;
    return this;
  }

  // the synchronous path, for a store whose bytes are already in memory
  loadSync() {
    this.changed = { sockets: new Set(), names: new Set(), recent: false };
    const s = this.store;
    const read = (n) => { try { return s.readSync(n); } catch (e) { if (e && e.code === 'not-found') return null; throw e; } };
    this.sockets = parse(read(ROM_SOCKETS) || new Uint8Array(0), {});
    this.names = parse(read(ROM_NAMES) || new Uint8Array(0), {});
    this.recent = parse(read(RECENT_LIST) || new Uint8Array(0), []);
    this.images.clear();
    this.recentBytes.clear();
    for (const f of s.listSync('roms/')) {
      const m = /^roms\/([0-9A-Fa-f]+)\.rom$/.exec(f.name);
      if (m) this.images.set(m[1].toUpperCase(), read(f.name));
    }
    for (const f of s.listSync('recent/')) {
      const m = /^recent\/([0-9A-Fa-f]+)\.bin$/.exec(f.name);
      if (m) this.recentBytes.set(m[1].toUpperCase(), read(f.name));
    }
    this.ready = true;
    return this;
  }

  // ---- reads (synchronous, from memory) ----
  socketCrc(machine, socket) { return (this.sockets[machine] || {})[socket] || null; }
  image(crc) { return this.images.get(crc) || null; }
  fileName(crc) { return crc ? this.names[crc] || null : null; }
  recentMedia() { return this.recent.map((r) => Object.assign({}, r)); }
  recentData(crc) { return this.recentBytes.get(crc) || null; }

  // ---- writes: memory at once, queued to the store ----
  // A synchronous store writes now (so a quota error reaches the caller); an asynchronous one is queued.
  // Writes are CHAINED: each one starts only after the one before it has finished, so two writes to the
  // same blob cannot race and the store ends with the last value written, not whichever finished last.
  // (Two concurrent createWritable() calls on one OPFS file can also throw outright.)
  _write(name, bytes) {
    if (this.synchronous) { this.store.writeSync(name, bytes); return; }
    this._op(name, () => this.store.write(name, bytes));
  }
  _remove(name) {
    // called now, as it always was (a synchronous store's remove must have happened when this returns); a throw
    // where it is called is reported like a rejection, rather than escaping as an unhandled rejection
    if (this.synchronous) {
      try {
        const p = this.store.remove(name);
        if (p && typeof p.catch === 'function') p.catch((e) => this._failed(name, e));
      } catch (e) { this._failed(name, e); }
      return;
    }
    this._op(name, () => this.store.remove(name));
  }
  _op(name, run) {
    // run() is called when this step starts, as before; a store whose write throws synchronously (every
    // asynchronous store here is `async`, which turns a throw into a rejection, but one need not) is reported
    // through the same path instead of rejecting the tail and stalling every later write.
    this.tail = this.tail.then(() => {
      try { return Promise.resolve(run()).catch((e) => this._failed(name, e)); } catch (e) { this._failed(name, e); }
    });
  }
  // a background write failed: report it, do not let it reject where nothing is listening.
  // It goes to writeError (the page's listener, js/ui/main.js: a status message) when one is set and does not
  // throw; otherwise (no listener: an embedder or Node; or the listener threw) it goes to console.error, so a
  // failure is reported unless both reporters fail. Nothing in here may throw: a reporter that throws (the
  // listener, or console.error itself if something replaced it) must not take the write queue with it, since a
  // rejecting tail drops every later write. So both calls are guarded, and a listener that throws anything at
  // all, falsy included, counts as having thrown. The listener is read once: one that clears writeError while
  // handling has still taken the report, rather than having it logged as well.
  _failed(name, e) {
    const listener = this.writeError;
    let threw = false, listenerError;
    if (listener) { try { listener(name, e); } catch (x) { threw = true; listenerError = x; } }
    if (listener && !threw) return;   // the listener took it: nothing more to report
    try {
      if (threw) console.error(`MediaIndex: ${name} could not be written, and the write-error listener failed too`, e, listenerError);
      else console.error(`MediaIndex: ${name} could not be written`, e);
    } catch (x) { /* nowhere left to report it: at least do not stop the queue */ }
  }
  putSocket(machine, socket, crc) {
    (this.sockets[machine] = this.sockets[machine] || {})[socket] = crc;
    this.changed.sockets.add(machine);
    this._write(ROM_SOCKETS, json(this.sockets));
  }
  putImage(crc, bytes, name = null) {
    this.images.set(crc, bytes);
    if (name) { this.names[crc] = name; this.changed.names.add(crc); this._write(ROM_NAMES, json(this.names)); }
    this._write(romImage(crc), bytes);
  }
  setRecent(list) { this.recent = list; this.changed.recent = true; this._write(RECENT_LIST, json(this.recent)); }
  // (written first: when a synchronous store is full the write throws and the bytes are not taken as kept)
  putRecent(crc, bytes) { this._write(recentFile(crc), bytes); this.recentBytes.set(crc, bytes); }
  dropRecent(crc) { this.recentBytes.delete(crc); this._remove(recentFile(crc)); }
  // drop images no socket refers to any more
  collect() {
    const used = new Set();
    for (const m of Object.values(this.sockets)) for (const crc of Object.values(m)) used.add(crc);
    for (const crc of [...this.images.keys()]) {
      if (used.has(crc)) continue;
      this.images.delete(crc); delete this.names[crc]; this.changed.names.add(crc);
      this._remove(romImage(crc));
    }
    this._write(ROM_SOCKETS, json(this.sockets));
    this._write(ROM_NAMES, json(this.names));
  }
  // the ROM images the sockets changed since loading refer to (reconnecting copies them with this visit's files)
  changedImages() {
    const out = new Set();
    for (const m of this.changed.sockets) for (const crc of Object.values(this.sockets[m] || {})) out.add(crc);
    return out;
  }
  clearMachine(machine) { this.sockets[machine] = {}; this.changed.sockets.add(machine); this._write(ROM_SOCKETS, json(this.sockets)); }

  // Write this index into another store's copy of it (Session.moveMedia), merged rather than replaced: the files
  // change in place, so keeping either side's whole file loses the other side's entries. Each machine's sockets
  // and each ROM's file name come from here when `ours` says so, and from there otherwise, and what only one side
  // has is kept; the recent list is the newer side's. ours: 'all' (a move: this is the library in use) or 'changed' (reconnecting a
  // folder: it is the library, and only what changed here since this index was loaded is newer). -> the number of
  // files written.
  async mergeInto(store, { ours = 'all' } = {}) {
    await this.flush();
    const read = async (name, fallback) => { const b = await readOrNull(store, name); return b ? parse(b, fallback) : null; };
    const theirs = { sockets: await read(ROM_SOCKETS, {}), names: await read(ROM_NAMES, {}), recent: await read(RECENT_LIST, []) };
    const mine = (set, key) => ours === 'all' || set.has(key);
    const sockets = Object.assign({}, theirs.sockets);
    for (const [m, v] of Object.entries(this.sockets)) if (mine(this.changed.sockets, m) || !(m in sockets)) sockets[m] = v;
    const names = Object.assign({}, theirs.names);
    for (const [crc, n] of Object.entries(this.names)) if (mine(this.changed.names, crc) || !(crc in names)) names[crc] = n;
    for (const crc of this.changed.names) if (!(crc in this.names)) delete names[crc];   // a name dropped here (collect)
    // the recent list is a list of the latest, not a set: the newer one, whole (the other's older entries would
    // push the latest out or come back after being dropped)
    const recent = ours === 'all' || this.changed.recent ? this.recent : theirs.recent || [];
    let written = 0;
    const put = async (name, value, any) => { if (any) { await store.write(name, json(value)); written++; } };
    await put(ROM_SOCKETS, sockets, theirs.sockets || Object.keys(this.sockets).length);
    await put(ROM_NAMES, names, theirs.names || Object.keys(this.names).length);
    await put(RECENT_LIST, recent, theirs.recent || this.recent.length);
    return written;
  }
  // wait for every queued write to reach the store (startup, tests, before a download). This is the only
  // point at which a caller may treat the writes as durable.
  async flush() { await (this.tail = this.tail.then(() => {})); }
  // the same thing under the name that says what it means
  async settled() { await this.flush(); }
}
