/*
 * OpfsMediaStore: the MediaStore over the Origin Private File System — storage the page owns, invisible
 * to the user's file manager, which survives a reload and needs no permission prompt.
 *
 * Layout: one flat directory under the origin's private root, names in the contract's form. A "/" in a
 * name is a real subdirectory, created on demand.
 *
 * OPFS gives random access through FileSystemSyncAccessHandle (inside a worker) or, in the main thread,
 * only whole-file reads and writes. This module runs in the main thread (CLOADM has no workers and no
 * build step), so readRange reads the file and slices, and writeRange reads, splices and writes back.
 * That is honest and correct; the interface leaves the door open for a worker-backed handle later, and
 * disk images and DriveWire can move to one without changing the contract or any caller.
 */
import { MediaStoreError, checkName, checkRange, measureOnce } from './media-store.js';

export const opfsAvailable = () => typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';

// the directory holding `name`, creating missing parts; returns [dir, leafName]
async function dirFor(root, name, create) {
  const parts = name.split('/');
  const leaf = parts.pop();
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return [dir, leaf];
}

export class OpfsMediaStore {
  constructor({ root = null } = {}) { this.root = root; this.ready = this._open(); }
  get kind() { return 'opfs'; }
  get supported() { return { randomAccess: true, writes: true, persistent: true }; }
  async _open() { if (!this.root) this.root = await navigator.storage.getDirectory(); return this; }   // resolves to the store, so `await store.ready` gives a usable store
  async stat(name) {
    checkName(name);
    await this.ready;
    try {
      const [dir, leaf] = await dirFor(this.root, name, false);
      const fh = await dir.getFileHandle(leaf, { create: false });
      const f = await fh.getFile();
      return { name, size: f.size, mtime: f.lastModified };
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw wrap(e, name);
    }
  }

  // walk the tree under `prefix`; a prefix ending in "/" restricts to that directory
  async list(prefix = '') {
    return this._listing(prefix, await this._case());
  }
  // the listing itself, with the store's case rule given to it rather than asked for: detectCase() lists a store to
  // measure it, and a listing that asked for the rule from inside the measurement would wait on itself. Every
  // caller from outside goes through list(), which asks once and shares the answer.
  async _listing(prefix, ci) {
    await this.ready;
    const out = [];
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // start at the deepest directory the prefix names that exists, under ITS OWN path, and filter by name
    // (a prefix whose directory doesn't exist must not walk the root as if it were that directory). Each step
    // takes the entry's real spelling from its parent's listing, so a store that does not tell cases apart lists
    // GAME.DSK under library/ when it was asked for LIBRARY/, rather than under a path it does not have.
    let start = this.root, at = '';
    if (base) {
      for (const p of base.split('/')) {
        let real = null;
        try { for await (const [n, h] of start.entries()) if (h.kind === 'directory' && (ci ? n.toLowerCase() === p.toLowerCase() : n === p)) { real = n; break; } } catch (e) { break; }
        if (real === null) break;
        try { start = await start.getDirectoryHandle(real, { create: false }); at = at ? `${at}/${real}` : real; }
        catch (e) { break; }
      }
    }
    const walk = async (dir, path) => {
      for await (const [name, handle] of dir.entries()) {
        const full = path ? `${path}/${name}` : name;
        if (handle.kind === 'directory') { await walk(handle, full); continue; }
        if (!(ci ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix))) continue;
        // a file removed between the directory listing and this read (a delete or a rename in flight, as the
        // Library does while it lists) is no longer there: left out of the list, not an error for the whole of it
        let f;
        try { f = await handle.getFile(); } catch (e) { if (e && e.name === 'NotFoundError') continue; throw wrap(e, full); }
        out.push({ name: full, size: f.size, mtime: f.lastModified });
      }
    };
    // every method here answers with a MediaStoreError, a listing included: wrap what the walk throws
    try { await walk(start, at); } catch (e) { throw wrap(e, prefix || 'the store'); }
    // the walk kept only the names under `prefix`, by the store's rule: a second, identical filter here was dead
    // code (the walk's predicate is the same one on the same array)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // the store's own case rule decides how its names are compared: measure it (read-only, js/host/media-store.js
  // CASE), then fold names and prefixes when the file system does not tell them apart. Every caller shares the one
  // in-flight measurement (measureOnce), so a listing started while another measures waits for the real answer
  // instead of taking a guess. Nothing here answers on the side: the measurement itself lists through _listing,
  // which never asks this question, so there is no re-entrant call to answer.
  async _case() {
    await measureOnce(this);
    return this.caseInsensitive;
  }

  async _file(name, create = false) {
    const [dir, leaf] = await dirFor(this.root, name, create);
    return { dir, leaf, fh: await dir.getFileHandle(leaf, { create }) };
  }

  async read(name) {
    checkName(name);
    await this.ready;
    try {
      const { fh } = await this._file(name, false);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch (e) {
      if (e && e.name === 'NotFoundError') throw new MediaStoreError('not-found', `${name} is not in this store`);
      throw wrap(e, name);
    }
  }

  async readRange(name, offset, length) {
    checkName(name);
    const { offset: at, length: n } = checkRange(offset, length);
    const bytes = await this.read(name);
    if (at > bytes.length) throw new MediaStoreError('io', `${name}: offset ${at} is past the end (${bytes.length})`);
    return bytes.slice(at, at + n);
  }

  async write(name, bytes) {
    checkName(name);
    await this.ready;
    const data = toBytes(bytes), prev = await this.stat(name);
    try {
      const [dir, leaf] = await dirFor(this.root, name, true);
      const fh = await dir.getFileHandle(leaf, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
      const f = await fh.getFile();
      return { name, size: f.size, mtime: f.lastModified };
    } catch (e) { throw wrap(e, name, prev, data.length); }
  }

  async writeRange(name, offset, bytes) {
    checkName(name);
    const at = offset;
    const data = toBytes(bytes);
    const cur = await this.read(name);   // throws not-found as the contract says
    if (!Number.isInteger(at) || at < 0) throw new MediaStoreError('io', `Bad offset ${at}`);
    const end = at + data.length;
    const next = end <= cur.length ? cur : new Uint8Array(end);
    if (next !== cur) next.set(cur);
    next.set(data, at);
    await this.write(name, next);
    return this.stat(name);
  }

  async rename(from, to) {
    checkName(from); checkName(to);
    if (from === to) return this.stat(from);
    if (await this.stat(to)) throw new MediaStoreError('exists', `${to} is already in this store`);
    const bytes = await this.read(from);
    await this.write(to, bytes);
    await this.remove(from);
    return this.stat(to);
  }

  async remove(name) {
    checkName(name);
    await this.ready;
    try {
      const [dir, leaf] = await dirFor(this.root, name, false);
      await dir.removeEntry(leaf);
      return true;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return false;
      throw wrap(e, name);
    }
  }

  async clear(prefix = '') {
    await this.ready;
    let n = 0;
    for (const f of await this.list(prefix)) if (await this.remove(f.name)) n++;
    return n;
  }
}

const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
function wrap(e, name, prev, size) {
  if (e instanceof MediaStoreError) return e;
  // the browser reports a full disk as QuotaExceededError on the writable's write/close
  if (e && (e.name === 'QuotaExceededError' || e.code === 22)) return new MediaStoreError('quota', `No space left for ${name}`, e);
  return new MediaStoreError('io', `${name}: ${e && e.message ? e.message : 'storage error'}`, e);
}
