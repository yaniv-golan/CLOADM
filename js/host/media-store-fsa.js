/*
 * FsaMediaStore: the MediaStore over a directory the user picked with the File System Access API.
 *
 * The files are the user's own, in a folder they chose, so the Library can offer "keep my media here"
 * instead of leaving it inside the browser. Where the browser allows it the file is written back in
 * place (createWritable with keepExistingData, so a sector write does not rewrite the image).
 *
 * Permission is asked for separately from choosing the folder. The Library remembers the folder handle in
 * IndexedDB (js/host/folder-handle.js); after a reload the browser may ask again, and the page then offers to
 * reconnect (media-store-open.js, openChosenStore).
 *
 * Uploading is never involved: a File System Access handle is local to the machine.
 */
import { MediaStoreError, checkName, checkRange, measureOnce } from './media-store.js';

export const fsaAvailable = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

export class FsaMediaStore {
  constructor(directory) { this.directory = directory; }
  get kind() { return 'fsa'; }
  get supported() { return { randomAccess: true, writes: true, persistent: true }; }
  get name() { return this.directory && this.directory.name; }

  // ask for read/write permission; true when granted
  static async authorize(directory, mode = 'readwrite') {
    const opts = { mode };
    if ((await directory.queryPermission(opts)) === 'granted') return true;
    return (await directory.requestPermission(opts)) === 'granted';
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

  async _dir(name, create = false) {
    const parts = name.split('/'); const leaf = parts.pop();
    let d = this.directory;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return [d, leaf];
  }

  async stat(name) {
    checkName(name);
    try {
      const [d, leaf] = await this._dir(name);
      const f = await (await d.getFileHandle(leaf, { create: false })).getFile();
      return { name, size: f.size, mtime: f.lastModified };
    } catch (e) { if (e && e.name === 'NotFoundError') return null; throw wrap(e, name); }
  }

  async list(prefix = '') {
    return this._listing(prefix, await this._case());
  }
  // the listing itself, with the store's case rule given to it rather than asked for: detectCase() lists a store to
  // measure it, and a listing that asked for the rule from inside the measurement would wait on itself. Every
  // caller from outside goes through list(), which asks once and shares the answer.
  async _listing(prefix, ci) {
    const out = [];
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // Start at the deepest directory the prefix names that exists, under ITS OWN path (as the OPFS store does):
    // each step takes the entry's real spelling from its parent's listing rather than the prefix's spelling, so a
    // folder that does not tell cases apart lists GAME.DSK under library/ when it was asked for LIBRARY/.
    let start = this.directory, at = '';
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
      for await (const [name, h] of dir.entries()) {
        const full = path ? `${path}/${name}` : name;
        if (h.kind === 'directory') { await walk(h, full); continue; }
        if (!(ci ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix))) continue;
        const f = await h.getFile();
        out.push({ name: full, size: f.size, mtime: f.lastModified });
      }
    };
    // Every method here answers with a MediaStoreError (the contract's FAILURES section), and a listing is no
    // exception: a lapsed permission (NotAllowedError), a security refusal or a quota error from the directory
    // walk is wrapped, not let out raw.
    try { await walk(start, at); } catch (e) { throw wrap(e, prefix || 'the store'); }
    // the walk kept only the names under `prefix`, by the store's rule: a second, identical filter here was dead
    // code (the walk's predicate is the same one on the same array)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async read(name) {
    checkName(name);
    try {
      const [d, leaf] = await this._dir(name);
      return new Uint8Array(await (await (await d.getFileHandle(leaf, { create: false })).getFile()).arrayBuffer());
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
    const data = toBytes(bytes);
    try {
      const [d, leaf] = await this._dir(name, true);
      const fh = await d.getFileHandle(leaf, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
      const f = await fh.getFile();
      return { name, size: f.size, mtime: f.lastModified };
    } catch (e) { throw wrap(e, name); }
  }

  // write in place where the browser allows it (keepExistingData), so a disk sector write does not
  // rewrite the whole image; fall back to read-splice-write where it does not.
  async writeRange(name, offset, bytes) {
    checkName(name);
    const at = offset;
    const data = toBytes(bytes);
    const cur = await this.read(name);
    if (!Number.isInteger(at) || at < 0) throw new MediaStoreError('io', `Bad offset ${at}`);
    const end = at + data.length;
    try {
      const [d, leaf] = await this._dir(name);
      const fh = await d.getFileHandle(leaf, { create: true });
      const w = await fh.createWritable({ keepExistingData: true });
      try {
        await w.write({ type: 'write', position: at, data });   // grows the file if `end` is past it
        await w.truncate(Math.max(end, cur.length));
      } finally { await w.close(); }
      const f = await fh.getFile();
      return { name, size: f.size, mtime: f.lastModified };
    } catch (e) {
      if (e && (e.name === 'NotSupportedError' || e.name === 'InvalidStateError')) {
        const next = end <= cur.length ? cur : new Uint8Array(end);
        if (next !== cur) next.set(cur);
        next.set(data, at);
        return this.write(name, next);
      }
      throw wrap(e, name);
    }
  }

  async rename(from, to) {
    checkName(from); checkName(to);
    if (from === to) return this.stat(from);
    // A case-only rename is not refused here: that needs FileSystemHandle.move() to be done without losing the
    // file, which this store does not have. The Session refuses one (MediaLibrary.renameMedia); a direct caller that
    // makes one on a folder that does not tell cases apart loses the file. Reported, not fixed here.
    if (await this.stat(to)) throw new MediaStoreError('exists', `${to} is already in this store`);
    await this.write(to, await this.read(from));
    await this.remove(from);
    return this.stat(to);
  }

  async remove(name) {
    checkName(name);
    try {
      const [d, leaf] = await this._dir(name);
      await d.removeEntry(leaf);
      return true;
    } catch (e) { if (e && e.name === 'NotFoundError') return false; throw wrap(e, name); }
  }

  async clear(prefix = '') {
    let n = 0;
    for (const f of await this.list(prefix)) if (await this.remove(f.name)) n++;
    return n;
  }
}

const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
function wrap(e, name) {
  if (e instanceof MediaStoreError) return e;
  if (e && (e.name === 'QuotaExceededError' || e.code === 22)) return new MediaStoreError('quota', `No space left for ${name}`, e);
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return new MediaStoreError('unsupported', `${name}: permission was refused`, e);
  return new MediaStoreError('io', `${name}: ${e && e.message ? e.message : 'storage error'}`, e);
}
