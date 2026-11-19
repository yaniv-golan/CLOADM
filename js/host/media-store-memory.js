/*
 * MemoryMediaStore: a MediaStore held in a Map. It is the Node test implementation, the embedder
 * default, and the target of the one-time localStorage migration in tests.
 *
 * It is also the base class for the browser backends: they inherit the range helpers below and supply
 * only the four primitives in their own way, so the contract's corner cases (short reads at the end,
 * zero fill past the end, rename collisions) are implemented once and tested once.
 *
 * quotaBytes: an optional cap, so a test can make a write fail exactly as a full browser store does.
 * caseInsensitive: true makes names that differ only in case ONE entry, as a folder on APFS or NTFS does. It
 * is declared, not measured (the instance knows what it is), which is what keeps this store synchronous. The
 * entry keeps the spelling it was first written with: write('GAME.DSK') then write('game.dsk') replaces that
 * entry, and list()/stat() still say GAME.DSK. Default false: a Map tells them apart, as ext4 does, so every
 * existing test means what it meant before.
 */
import { MediaStoreError, checkName, checkRange } from './media-store.js';

const now = () => Date.now();

export class MemoryMediaStore {
  constructor({ quotaBytes = Infinity, clock = now, caseInsensitive = false } = {}) {
    this.quotaBytes = quotaBytes;
    this.clock = clock;
    this.caseInsensitive = !!caseInsensitive;
    this.declaresCase = true;   // the answer is this instance's own, not measured from a listing
    this.files = new Map();   // key (see key()) -> { name, bytes: Uint8Array, mtime: number }
    this.bytes = 0;           // total held, to enforce quotaBytes the way a browser counts usage
  }
  get kind() { return 'memory'; }
  get supported() { return { randomAccess: true, writes: true, persistent: false }; }
  // A Map needs no I/O, so this store can answer at once; the media index uses this to load
  // synchronously, which is what keeps the Session's API synchronous in Node and for embedders.
  get synchronous() { return true; }
  // the Map key for a name: the name itself, or its fold when the store does not tell cases apart
  key(name) { return this.caseInsensitive ? name.toLowerCase() : name; }
  // the synchronous forms; the async methods below are the same calls (a failure throws here, rejects there)
  readSync(name) {
    checkName(name);
    const e = this.files.get(this.key(name));
    if (!e) throw new MediaStoreError('not-found', `${name} is not in this store`);
    return e.bytes.slice();
  }
  statSync(name) { checkName(name); return this._entry(name); }
  listSync(prefix = '') {
    const out = [];
    for (const [key, e] of this.files) if (key.startsWith(this.key(prefix))) out.push({ name: e.name, size: e.bytes.length, mtime: e.mtime });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  writeSync(name, bytes) {
    checkName(name);
    const data = toBytes(bytes);
    const key = this.key(name);
    const old = this.files.get(key);
    this._charge(data.length - (old ? old.bytes.length : 0));
    const mtime = this.clock();
    // a store that does not tell cases apart is writing the entry that is already there: keep its spelling
    this.files.set(key, { name: old ? old.name : name, bytes: data, mtime });
    return { name: this.files.get(key).name, size: data.length, mtime };
  }

  _entry(name) { const e = this.files.get(this.key(name)); return e ? { name: e.name, size: e.bytes.length, mtime: e.mtime } : null; }
  _charge(delta) {
    if (this.bytes + delta > this.quotaBytes) {
      throw new MediaStoreError('quota', `No space left in this store (${this.quotaBytes} bytes)`);
    }
    this.bytes += delta;
  }

  async stat(name) { return this.statSync(name); }
  async list(prefix = '') { return this.listSync(prefix); }
  async read(name) { return this.readSync(name); }

  async readRange(name, offset, length) {
    checkName(name);
    const { offset: at, length: n } = checkRange(offset, length);
    const e = this.files.get(this.key(name));
    if (!e) throw new MediaStoreError('not-found', `${name} is not in this store`);
    if (at > e.bytes.length) throw new MediaStoreError('io', `${name}: offset ${at} is past the end (${e.bytes.length})`);
    return e.bytes.slice(at, at + n);
  }

  async write(name, bytes) { return this.writeSync(name, bytes); }

  async writeRange(name, offset, bytes) {
    checkName(name);
    const at = offset;
    const data = toBytes(bytes);
    const key = this.key(name);
    const e = this.files.get(key);
    if (!e) throw new MediaStoreError('not-found', `${name} is not in this store`);
    if (!Number.isInteger(at) || at < 0) throw new MediaStoreError('io', `Bad offset ${at}`);
    // a window past the end is allowed: the gap up to `at` becomes zeroes (the contract's stated rule)
    const end = at + data.length;
    const grown = Math.max(0, end - e.bytes.length);
    this._charge(grown);   // the gap, if any, also costs a byte per byte
    const next = end <= e.bytes.length ? e.bytes : new Uint8Array(end);
    if (next !== e.bytes) next.set(e.bytes);
    next.set(data, at);
    const mtime = this.clock();
    this.files.set(key, { name: e.name, bytes: next, mtime });
    return { name: e.name, size: next.length, mtime };
  }

  async rename(from, to) {
    checkName(from); checkName(to);
    const key = this.key(from), toKey = this.key(to);
    const e = this.files.get(key);
    if (!e) throw new MediaStoreError('not-found', `${from} is not in this store`);
    if (key !== toKey && this.files.has(toKey)) throw new MediaStoreError('exists', `${to} is already in this store`);
    this.files.delete(key);
    const mtime = this.clock();
    this.files.set(toKey, { name: to, bytes: e.bytes, mtime });
    return { name: to, size: e.bytes.length, mtime };
  }

  async remove(name) {
    checkName(name);
    const key = this.key(name);
    const e = this.files.get(key);
    if (!e) return false;
    this.bytes -= e.bytes.length;
    this.files.delete(key);
    return true;
  }

  async clear(prefix = '') {
    let n = 0;
    for (const [key, e] of [...this.files]) if (key.startsWith(this.key(prefix))) { this.bytes -= e.bytes.length; this.files.delete(key); n++; }
    return n;
  }
  // everything, for a test that wants to look inside
  snapshot() { return [...this.files.values()].map((e) => ({ name: e.name, size: e.bytes.length, mtime: e.mtime })); }
}

// bytes may come from another realm (a browser Blob) or be a plain array: always store our own Uint8Array
export function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes.slice();
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  throw new MediaStoreError('io', 'write() takes a Uint8Array, an ArrayBuffer or an array of bytes');
}

