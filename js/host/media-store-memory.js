/*
 * MemoryMediaStore: a MediaStore held in a Map. It is the Node test implementation, the embedder
 * default, and the target of the one-time localStorage migration in tests.
 *
 * It is also the base class for the browser backends: they inherit the range helpers below and supply
 * only the four primitives in their own way, so the contract's corner cases (short reads at the end,
 * zero fill past the end, rename collisions) are implemented once and tested once.
 *
 * quotaBytes: an optional cap, so a test can make a write fail exactly as a full browser store does.
 */
import { MediaStoreError, checkName, checkRange } from './media-store.js';

const now = () => Date.now();

export class MemoryMediaStore {
  constructor({ quotaBytes = Infinity, clock = now } = {}) {
    this.quotaBytes = quotaBytes;
    this.clock = clock;
    this.files = new Map();   // name -> { bytes: Uint8Array, mtime: number }
    this.bytes = 0;           // total held, to enforce quotaBytes the way a browser counts usage
  }
  get kind() { return 'memory'; }
  get supported() { return { randomAccess: true, writes: true, persistent: false }; }
  // A Map needs no I/O, so this store can answer at once; the media index uses this to load
  // synchronously, which is what keeps the Session's API synchronous in Node and for embedders.
  get synchronous() { return true; }
  // the synchronous forms; the async methods below are the same calls (a failure throws here, rejects there)
  readSync(name) {
    checkName(name);
    const e = this.files.get(name);
    if (!e) throw new MediaStoreError('not-found', `${name} is not in this store`);
    return e.bytes.slice();
  }
  statSync(name) { checkName(name); return this._entry(name); }
  listSync(prefix = '') {
    const out = [];
    for (const [name, e] of this.files) if (name.startsWith(prefix)) out.push({ name, size: e.bytes.length, mtime: e.mtime });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  writeSync(name, bytes) {
    checkName(name);
    const data = toBytes(bytes);
    const old = this.files.get(name);
    this._charge(data.length - (old ? old.bytes.length : 0));
    const mtime = this.clock();
    this.files.set(name, { bytes: data, mtime });
    return { name, size: data.length, mtime };
  }

  _entry(name) { const e = this.files.get(name); return e ? { name, size: e.bytes.length, mtime: e.mtime } : null; }
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
    const e = this.files.get(name);
    if (!e) throw new MediaStoreError('not-found', `${name} is not in this store`);
    if (at > e.bytes.length) throw new MediaStoreError('io', `${name}: offset ${at} is past the end (${e.bytes.length})`);
    return e.bytes.slice(at, at + n);
  }

  async write(name, bytes) { return this.writeSync(name, bytes); }

  async writeRange(name, offset, bytes) {
    checkName(name);
    const at = offset;
    const data = toBytes(bytes);
    const e = this.files.get(name);
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
    this.files.set(name, { bytes: next, mtime });
    return { name, size: next.length, mtime };
  }

  async rename(from, to) {
    checkName(from); checkName(to);
    const e = this.files.get(from);
    if (!e) throw new MediaStoreError('not-found', `${from} is not in this store`);
    if (from !== to && this.files.has(to)) throw new MediaStoreError('exists', `${to} is already in this store`);
    this.files.delete(from);
    const mtime = this.clock();
    this.files.set(to, { bytes: e.bytes, mtime });
    return { name: to, size: e.bytes.length, mtime };
  }

  async remove(name) {
    checkName(name);
    const e = this.files.get(name);
    if (!e) return false;
    this.bytes -= e.bytes.length;
    this.files.delete(name);
    return true;
  }

  async clear(prefix = '') {
    let n = 0;
    for (const [name, e] of [...this.files]) if (name.startsWith(prefix)) { this.bytes -= e.bytes.length; this.files.delete(name); n++; }
    return n;
  }
  // everything, for a test that wants to look inside
  snapshot() { return [...this.files].map(([name, e]) => ({ name, size: e.bytes.length, mtime: e.mtime })); }
}

// bytes may come from another realm (a browser Blob) or be a plain array: always store our own Uint8Array
export function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes.slice();
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  throw new MediaStoreError('io', 'write() takes a Uint8Array, an ArrayBuffer or an array of bytes');
}

