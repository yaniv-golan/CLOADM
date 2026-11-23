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
import { crc32 } from '../util.js';

export const ROM_SOCKETS = 'roms/sockets.json';
export const ROM_NAMES = 'roms/names.json';
export const RECENT_LIST = 'recent/list.json';
export const MIGRATION_MARKER = 'meta/migrated';
// the index's files that change in place (the rest are named by their contents' CRC, or written once)
export const INDEX_LISTS = [ROM_SOCKETS, ROM_NAMES, RECENT_LIST];
// the recent list's length (MediaLibrary.rememberMedia keeps the newest)
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
// what each list is when it is not stored yet (a fresh value each time: a merge changes it)
const LIST_EMPTY = { [ROM_SOCKETS]: () => ({}), [ROM_NAMES]: () => ({}), [RECENT_LIST]: () => [] };
const socketCrcs = (sockets) => { const out = new Set(); for (const m of Object.values(sockets || {})) for (const crc of Object.values(m || {})) out.add(crc); return out; };
// Another page's blob is taken only once it is whole: a store can show a file before its bytes are in (OPFS creates an
// empty file and fills it when the write closes), and a blob is named by its contents' CRC. One that does not match yet
// is read again on that page's next message (it says so once the write has closed).
const whole = (bytes, crc) => !!bytes && crc32(bytes) === String(crc).toUpperCase();
const recentKey = (r) => `${r.name}\0${String(r.crc).toUpperCase()}`;
// The lock every page on the origin takes to change the index's lists (navigator.locks), and, where there is no such
// thing (Node, an embedder), one per store in this process: what two indexes on one store in one process share.
export const INDEX_LOCK = 'cloadm-media-index';
const localLocks = new WeakMap();

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
  // share: { locks, post } for a store other pages use too (the page's OPFS or folder): locks is navigator.locks, and
  // post(what) tells the other pages a list changed ('roms' | 'recent'; Session.mediaShare). Without it the lists are
  // still merged on every write, under a lock per store in this process.
  constructor(store, { locks = null, post = null } = {}) {
    this.store = store;
    this.locks = locks;
    this.post = post;
    this.queued = {};           // list name -> changes of it queued and not yet written (the merged list waits for the last)
    this.foreign = null;        // (kind, detail) => void: another page changed a list ('sockets' with [{ machine, socket }],
                                // 'names', 'recent', 'images'); the Session's (mediaForeign)
    this.changedElsewhere = new Set();   // 'machine:socket' another page changed and this one has not set since
    this.synchronous = !!store.synchronous;
    this.ready = false;
    this.sockets = {};          // machine -> { socket: crc }
    this.names = {};            // crc -> file name
    this.images = new Map();    // crc -> Uint8Array
    this.recent = [];           // the list as the Session uses it: [{ name, crc, size, machine, stored }]
    this.recentBytes = new Map(); // crc (upper case) -> Uint8Array
    this.recentFiles = new Map(); // crc (upper case) -> the store name it was read from (an older build's case kept)
    this.changed = { sockets: new Set(), names: new Set(), recent: false };   // since load: what mergeInto counts as newer
    this.tail = Promise.resolve(); // the write chain: every store operation runs after the one before
    this.writeError = null;     // (name, error) => void: a background write failed (quota, permission)
    if (this.synchronous) this.loadSync();
  }

  async load() {
    this.changed = { sockets: new Set(), names: new Set(), recent: false };
    this.sockets = parse((await readOrNull(this.store, ROM_SOCKETS)) || new Uint8Array(0), {});
    this.names = parse((await readOrNull(this.store, ROM_NAMES)) || new Uint8Array(0), {});
    this.recent = this._readRecent(parse((await readOrNull(this.store, RECENT_LIST)) || new Uint8Array(0), []));
    this.images.clear();
    this.recentBytes.clear();
    for (const f of await this.store.list('roms/')) {
      const m = /^roms\/([0-9A-Fa-f]+)\.rom$/.exec(f.name);
      if (m) this.images.set(m[1].toUpperCase(), await this.store.read(f.name));
    }
    this.recentFiles.clear();
    for (const f of await this.store.list('recent/')) {
      const m = /^recent\/([0-9A-Fa-f]+)\.bin$/.exec(f.name);
      if (m) { this.recentBytes.set(m[1].toUpperCase(), await this.store.read(f.name)); this.recentFiles.set(m[1].toUpperCase(), f.name); }
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
    this.recent = this._readRecent(parse(read(RECENT_LIST) || new Uint8Array(0), []));
    this.images.clear();
    this.recentBytes.clear();
    for (const f of s.listSync('roms/')) {
      const m = /^roms\/([0-9A-Fa-f]+)\.rom$/.exec(f.name);
      if (m) this.images.set(m[1].toUpperCase(), read(f.name));
    }
    this.recentFiles.clear();
    for (const f of s.listSync('recent/')) {
      const m = /^recent\/([0-9A-Fa-f]+)\.bin$/.exec(f.name);
      if (m) { this.recentBytes.set(m[1].toUpperCase(), read(f.name)); this.recentFiles.set(m[1].toUpperCase(), f.name); }
    }
    this.ready = true;
    return this;
  }

  // ---- reads (synchronous, from memory) ----
  // The recent list's CRCs are NORMALISED (upper case) as it is read: the blobs are already keyed that way
  // (`recent/<CRC>.bin`, upper-cased above), and an older build could store a lower-case CRC in the list
  // itself. Without this a list holding one would show the same file twice — the entry it stored, and the
  // entry a later load makes under the upper-case CRC — and its own row would fail to find its bytes.
  _readRecent(list) {
    // Only real entries: an entry needs a name and a CRC. A hand-edited or older list can hold a null, a string
    // (which Object.assign copies as {0:'j',...}) or an object with one field missing; those have no row to draw
    // and no bytes to load, and grouping them would label junk against junk.
    return (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r === 'object' && typeof r.crc === 'string' && typeof r.name === 'string')
      .map((r) => Object.assign({}, r, { crc: r.crc.toUpperCase() }));
  }
  socketCrc(machine, socket) { return (this.sockets[machine] || {})[socket] || null; }
  image(crc) { return this.images.get(crc) || null; }
  fileName(crc) { return crc ? this.names[crc] || null : null; }
  recentMedia() { return this.recent.map((r) => Object.assign({}, r)); }
  recentData(crc) { return this.recentBytes.get(String(crc).toUpperCase()) || null; }

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
  // ---- the lists: read, merged with this change, written (several tabs share one store) ----
  // Two pages on one origin share the store (OPFS, or one picked folder), each with its own index in memory. Writing
  // this index's whole list over the stored one would drop what the other page added since this one loaded. So a
  // list is never written from memory: each change is a step that re-reads the stored list, applies THIS change to
  // it, and writes the result, under a lock all the pages share (locks: navigator.locks; without it a lock per store
  // in this process, which is what two indexes in one Node process share). What another page stored is kept; the same
  // entry changed in both ends as the change made last. The merged list then becomes this index's own (with the
  // images and recent files it names that this index lacks), unless another change of that list is still queued here.
  // A synchronous store (memory, the fallback: one page's own) does the same steps at once.
  _locked(run) {
    if (this.locks) return this.locks.request(INDEX_LOCK, run);
    const prev = localLocks.get(this.store) || Promise.resolve();
    const next = prev.then(run);
    localLocks.set(this.store, next.then(() => {}, () => {}));
    return next;
  }
  // a step that changes the list `name`: change(stored) -> the list to store. A synchronous store runs it now.
  _list(name, change, what = name === RECENT_LIST ? 'recent' : 'roms') {
    if (this.synchronous) {
      const r = this._readSync(name);
      const merged = change(parse(r || new Uint8Array(0), LIST_EMPTY[name]()));
      this.store.writeSync(name, json(merged));
      this._adoptSync(name, merged);
      this._post(what);
      return;
    }
    this.queued[name] = (this.queued[name] || 0) + 1;
    this._op(name, async () => {
      try {
        await this._locked(async () => {
          const merged = change(parse((await readOrNull(this.store, name)) || new Uint8Array(0), LIST_EMPTY[name]()));
          await this.store.write(name, json(merged));
          if (this.queued[name] === 1) await this._adopt(name, merged);   // nothing of ours queued behind it
        });
        this._post(what);
      } finally { this.queued[name]--; }
    });
  }
  _readSync(name) { try { return this.store.readSync(name); } catch (e) { if (e && e.code === 'not-found') return null; throw e; } }
  // A list as stored becomes this index's own, with the blobs it names that this index lacks. The blobs are read
  // FIRST and the list put in place after, in one step: a list put in place before its reads were done was seen by a
  // panel redrawn meanwhile naming a program whose bytes were not there yet ("no longer stored"), and by nothing that
  // said so afterwards until the reads were done.
  async _adopt(name, list) {
    let got = false;   // an image read now: a socket another page stored before its image (putSocket) can be used now
    if (name === ROM_SOCKETS) {
      const images = new Map();
      for (const crc of socketCrcs(list)) if (!this.images.has(crc)) { const b = await readOrNull(this.store, romImage(crc)); if (whole(b, crc)) images.set(crc, b); }
      const was = this._held(name);
      for (const [crc, b] of images) { this.images.set(crc, b); got = true; }
      this.sockets = list;
      this._took(name, was, got);
    } else if (name === ROM_NAMES) { const was = this._held(name); this.names = list; this._took(name, was); }
    else {
      const recent = this._readRecent(list), bytes = new Map();
      for (const r of recent) if (r.stored && !this.recentBytes.has(r.crc)) {
        const b = await readOrNull(this.store, recentFile(r.crc));
        if (whole(b, r.crc)) bytes.set(r.crc, b);
      }
      const was = this._held(name);
      for (const [crc, b] of bytes) { this.recentBytes.set(crc, b); this.recentFiles.set(crc, recentFile(crc)); }
      this.recent = recent;
      this._took(name, was);
    }
  }
  _adoptSync(name, list) {
    const was = this._held(name);
    let got = false;   // an image read now: a socket another page stored before its image (putSocket) can be used now
    if (name === ROM_SOCKETS) {
      this.sockets = list;
      for (const crc of socketCrcs(list)) if (!this.images.has(crc)) { const b = this._readSync(romImage(crc)); if (whole(b, crc)) { this.images.set(crc, b); got = true; } }
    } else if (name === ROM_NAMES) this.names = list;
    else {
      this.recent = this._readRecent(list);
      for (const r of this.recent) if (r.stored && !this.recentBytes.has(r.crc)) {
        const b = this._readSync(recentFile(r.crc));
        if (whole(b, r.crc)) { this.recentBytes.set(r.crc, b); this.recentFiles.set(r.crc, recentFile(r.crc)); }
      }
    }
    this._took(name, was, got);
  }
  // What adopting a stored list brought in that this index did not have is another page's doing: this index's own
  // changes are in memory already when it adopts (it adopts only once none of its own is queued). Each is reported to
  // `foreign` (the Session: the panels redraw, and the ROM screen marks the socket rows another page changed), and the
  // sockets go into changedElsewhere until this page sets them itself.
  _held(name) { return name === ROM_SOCKETS ? this.sockets : name === ROM_NAMES ? this.names : this.recent; }
  _took(name, was, got = false) {
    const now = this._held(name);
    if (JSON.stringify(was) === JSON.stringify(now)) { if (got) this._say('images', null); return; }
    if (name === ROM_SOCKETS) {
      const moved = [];
      for (const m of new Set([...Object.keys(was || {}), ...Object.keys(now || {})])) {
        const a = (was || {})[m] || {}, b = (now || {})[m] || {};
        for (const sock of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if ((a[sock] || null) !== (b[sock] || null)) { moved.push({ machine: m, socket: sock }); this.changedElsewhere.add(`${m}:${sock}`); }
        }
      }
      this._say('sockets', moved);
    } else this._say(name === ROM_NAMES ? 'names' : 'recent', null);
  }
  _say(kind, detail) { if (this.foreign) { try { this.foreign(kind, detail); } catch (e) { /* a listener's bug is not the store's */ } } }
  // tell the other pages on this store that a list changed (the Session's channel; none in Node or the fallback)
  _post(what) { if (this.post) { try { this.post(what); } catch (e) { /* a closed channel: nothing to tell */ } } }
  // Another page changed the store: read the lists again (those with no change of ours still queued) and the blobs
  // they name. -> the lists that differ from what this index had: ['roms'] and/or ['recent']
  async refresh() {
    const changed = new Set();
    await this._locked(async () => {
      for (const name of INDEX_LISTS) {
        if (this.queued[name]) continue;
        const list = parse((await readOrNull(this.store, name)) || new Uint8Array(0), LIST_EMPTY[name]());
        const before = JSON.stringify(name === ROM_SOCKETS ? this.sockets : name === ROM_NAMES ? this.names : this.recent);
        await this._adopt(name, list);
        const after = JSON.stringify(name === ROM_SOCKETS ? this.sockets : name === ROM_NAMES ? this.names : this.recent);
        if (before !== after) changed.add(name === RECENT_LIST ? 'recent' : 'roms');
      }
      // images another page's collect removed
      const used = socketCrcs(this.sockets);
      for (const crc of [...this.images.keys()]) if (!used.has(crc) && !(await readOrNull(this.store, romImage(crc)))) { this.images.delete(crc); changed.add('roms'); this._say('images', null); }
    });
    return [...changed];
  }

  // A socket is stored before its image (RomLibrary.put): a collect another page runs between the two then sees the
  // socket and keeps the image, where the other order would let it remove an image whose socket was on its way.
  putSocket(machine, socket, crc) {
    (this.sockets[machine] = this.sockets[machine] || {})[socket] = crc;
    this.changed.sockets.add(machine);
    this.changedElsewhere.delete(`${machine}:${socket}`);
    this._list(ROM_SOCKETS, (stored) => { (stored[machine] = Object.assign({}, stored[machine]))[socket] = crc; return stored; });
  }
  putImage(crc, bytes, name = null) {
    this.images.set(crc, bytes);
    if (name) {
      this.names[crc] = name; this.changed.names.add(crc);
      this._list(ROM_NAMES, (stored) => Object.assign(stored, { [crc]: name }));
    }
    this._write(romImage(crc), bytes);
    // the socket that names it was stored (and told) first: tell the other pages again now the image is there to read
    if (this.synchronous) this._post('roms'); else this._op(romImage(crc), () => this._post('roms'));
  }
  // The recent list: this change is what moved to the front (an entry new to the list, or one that moved up); the
  // stored list keeps every other entry in its own order, behind them, to RECENT_LENGTH, less the entries this change
  // took out. An entry this page's list merely pushed off its end is not taken out: it stays if another page moved it
  // up meanwhile, and the merged list's own end decides.
  // An entry pushed off the end of the merged list that no entry still names loses its file (dropRecent).
  // `previous`: the list this change was made from (this index's, unless the caller already showed the new one).
  // `removed`: the entries this change takes out of the list (rememberMedia: the one the new load replaces). Without
  // it, every entry of `previous` that `list` lacks is taken out: the list given is the list wanted.
  setRecent(list, { previous = this.recent, removed = null } = {}) {
    const before = new Map(previous.map((r, i) => [recentKey(r), i]));
    const now = new Set(list.map(recentKey));
    const gone = new Set(removed ? removed.map(recentKey) : [...before.keys()].filter((k) => !now.has(k)));
    // to the front: an entry new to the list, one that moved up, or one this change took out and put back (a load again)
    const front = list.filter((r, i) => !before.has(recentKey(r)) || i < before.get(recentKey(r)) || gone.has(recentKey(r))).map((r) => Object.assign({}, r));
    this.recent = list; this.changed.recent = true;
    let evicted = [];
    this._list(RECENT_LIST, (stored) => {
      const moved = new Set(front.map(recentKey));
      const all = [...front, ...this._readRecent(stored).filter((r) => !moved.has(recentKey(r)) && !gone.has(recentKey(r)))];
      evicted = all.slice(RECENT_LENGTH).map((r) => r.crc);
      return all.slice(0, RECENT_LENGTH);
    });
    // the files of entries the merge pushed off the end: known once it has run (at once on a synchronous store)
    if (this.synchronous) for (const crc of evicted) this.dropRecent(crc);
    else this._op(RECENT_LIST, async () => { for (const crc of evicted) await this.dropRecent(crc, true); });
  }
  // (written first: when a synchronous store is full the write throws and the bytes are not taken as kept)
  putRecent(crc, bytes) {
    const key = String(crc).toUpperCase(), name = recentFile(key);
    this._write(name, bytes); this.recentBytes.set(key, bytes); this.recentFiles.set(key, name);
  }
  // Remove EVERY file that could hold this CRC's bytes: an older build could have written `recent/<lower>.bin`, and
  // the row that read it can later be re-written under the upper-case name, so both spellings go. Not while the
  // stored list still names it: another page's entry (or a renamed copy) may be using that file (the list is read
  // again under the lock, so call this after the setRecent that dropped the entry).
  // (now: run in this step of the queue rather than queued behind it -> its promise)
  dropRecent(crc, now = false) {
    const key = String(crc).toUpperCase();
    const names = [...new Set([this.recentFiles.get(key) || recentFile(key), recentFile(key), recentFile(key.toLowerCase())])];
    if (this.recent.some((r) => r.crc === key)) return;   // this page's own list still uses it
    this.recentBytes.delete(key); this.recentFiles.delete(key);
    const used = (stored) => this._readRecent(stored).some((r) => r.crc === key);
    if (this.synchronous) {
      if (used(parse(this._readSync(RECENT_LIST) || new Uint8Array(0), []))) return;
      for (const name of names) this._remove(name);
      return;
    }
    const step = () => this._locked(async () => {
      if (used(parse((await readOrNull(this.store, RECENT_LIST)) || new Uint8Array(0), []))) return;
      for (const name of names) {
        try { await this.store.remove(name); } catch (e) { this._failed(name, e); }
      }
    });
    if (now) return step().catch((e) => this._failed(names[0], e));
    this._op(names[0], step);
  }
  // Drop the images no socket refers to any more. Which ones is decided on the STORED sockets, read under the lock
  // (another page's socket may use an image this page has no socket for), and so is the names list.
  collect() {
    const mine = socketCrcs(this.sockets);
    for (const crc of [...this.images.keys()]) if (!mine.has(crc)) this.images.delete(crc);
    const sweep = (sockets, files) => {
      const used = socketCrcs(sockets), gone = [];
      for (const f of files) {
        const m = /^roms\/([0-9A-Fa-f]+)\.rom$/.exec(f.name);
        if (m && !used.has(m[1].toUpperCase())) gone.push({ crc: m[1].toUpperCase(), name: f.name });
      }
      return gone;
    };
    const unname = (gone) => (stored) => { for (const g of gone) { delete stored[g.crc]; delete this.names[g.crc]; this.changed.names.add(g.crc); } return stored; };
    if (this.synchronous) {
      const gone = sweep(parse(this._readSync(ROM_SOCKETS) || new Uint8Array(0), {}), this.store.listSync('roms/'));
      for (const g of gone) this._remove(g.name);
      this._list(ROM_NAMES, unname(gone));
      return;
    }
    this.queued[ROM_NAMES] = (this.queued[ROM_NAMES] || 0) + 1;
    this._op(ROM_NAMES, async () => {
      try {
        await this._locked(async () => {
          const gone = sweep(parse((await readOrNull(this.store, ROM_SOCKETS)) || new Uint8Array(0), {}), await this.store.list('roms/'));
          for (const g of gone) { try { await this.store.remove(g.name); } catch (e) { this._failed(g.name, e); } }
          const names = unname(gone)(parse((await readOrNull(this.store, ROM_NAMES)) || new Uint8Array(0), {}));
          try { await this.store.write(ROM_NAMES, json(names)); } catch (e) { this._failed(ROM_NAMES, e); }
          if (this.queued[ROM_NAMES] === 1) this.names = names;
        });
        this._post('roms');
      } finally { this.queued[ROM_NAMES]--; }
    });
  }
  // the ROM images the sockets changed since loading refer to (reconnecting copies them with this visit's files)
  changedImages() {
    const out = new Set();
    for (const m of this.changed.sockets) for (const crc of Object.values(this.sockets[m] || {})) out.add(crc);
    return out;
  }
  clearMachine(machine) {
    this.sockets[machine] = {}; this.changed.sockets.add(machine);
    for (const k of [...this.changedElsewhere]) if (k.startsWith(`${machine}:`)) this.changedElsewhere.delete(k);
    this._list(ROM_SOCKETS, (stored) => Object.assign(stored, { [machine]: {} }));
  }

  // Write this index into another store's copy of it (MediaLibrary.moveMedia), merged rather than replaced: the files
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
