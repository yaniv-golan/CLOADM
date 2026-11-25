/*
 * Where short links are kept: the short-link Worker at https://s.cloadm.dev/ (shortlink/worker.js), behind a small
 * interface the Session uses without knowing it is a server (Session.shortLink, Session.readShortLink).
 *
 *   create({ machine, sealed, png }) -> { id, deleteToken }   sealed: the sealed object, encrypted in this browser
 *                                                             (js/media/link-crypto.js); png: the preview or null
 *   load(id)                         -> the sealed bytes
 *   remove(id, deleteToken)          -> nothing
 *   url(id, key)                     -> https://s.cloadm.dev/<id>#<key>
 *   reportUrl(id)                    -> https://s.cloadm.dev/api/report/<id>: the Worker's report page (no key)
 * Every failure is a ShortLinkError with a message for people. The key is never given to a store: it is only in url(),
 * which builds the address on this side.
 *
 * MemoryShortLinkStore keeps them in memory (tests, and Node), with the same refusals for a missing link or token.
 */
export class ShortLinkError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }

export const SHORT_LINK_BASE = 'https://s.cloadm.dev/';
const ID = /^[A-Za-z0-9_-]{8}$/;

// the /api/new body (shortlink/worker.js readNewLink): [u8 NEW_LINK_VERSION][u8 n][machine id][u32 LE sealed length]
// [sealed][png]. Version 2: the sealed object starts with its own version and kind (js/media/link-crypto.js), which the
// Worker reads; version 1 (a sealed object without them) was never deployed and is not read.
export const NEW_LINK_VERSION = 2;
export function newLinkBody(machine, sealed, png = null) {
  const m = new TextEncoder().encode(machine);
  if (m.length > 255) throw new ShortLinkError('Not a machine.');
  const out = new Uint8Array(2 + m.length + 4 + sealed.length + (png ? png.length : 0));
  out[0] = NEW_LINK_VERSION; out[1] = m.length; out.set(m, 2);
  new DataView(out.buffer).setUint32(2 + m.length, sealed.length, true);
  out.set(sealed, 6 + m.length);
  if (png) out.set(png, 6 + m.length + sealed.length);
  return out;
}

export class ShortLinkStore {
  constructor({ base = SHORT_LINK_BASE, fetch = (...a) => globalThis.fetch(...a) } = {}) { this.base = base; this.fetch = fetch; }
  url(id, key) { return `${this.base}${id}#${key}`; }
  reportUrl(id) { return ID.test(id) ? `${this.base}api/report/${id}` : null; }
  async call(path, init, what) {
    let res;
    try { res = await this.fetch(`${this.base}${path}`, init); }
    catch (e) { throw new ShortLinkError(`Couldn't reach ${new URL(this.base).host} to ${what}: check the connection. The long link still works.`); }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
      throw new ShortLinkError(msg || `${new URL(this.base).host} answered ${res.status} when asked to ${what}.`, res.status);
    }
    return res;
  }
  async create({ machine, sealed, png = null }) {
    const res = await this.call('api/new', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: newLinkBody(machine, sealed, png) }, 'make a short link');
    let out;
    try { out = await res.json(); } catch (e) { out = null; }
    if (!out || !ID.test(out.id) || typeof out.deleteToken !== 'string') throw new ShortLinkError('The short-link server gave an answer CLOADM does not understand.');
    return { id: out.id, deleteToken: out.deleteToken };
  }
  async load(id) {
    if (!ID.test(id)) throw new ShortLinkError('This short link is damaged.');
    let res;
    try { res = await this.call(`${id}.bin`, { method: 'GET' }, 'open the short link'); }
    catch (e) { if (e.status === 404) throw new ShortLinkError('This short link was removed, or never existed.', 404); throw e; }
    return new Uint8Array(await res.arrayBuffer());
  }
  async remove(id, deleteToken) {
    await this.call('api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, token: deleteToken }) }, 'remove the short link');
  }
}

export class MemoryShortLinkStore {
  constructor(base = SHORT_LINK_BASE) { this.base = base; this.links = new Map(); this.n = 0; }
  url(id, key) { return `${this.base}${id}#${key}`; }
  reportUrl(id) { return ID.test(id) ? `${this.base}api/report/${id}` : null; }
  async create({ machine, sealed, png = null }) {
    const id = `mem${String(++this.n).padStart(5, '0')}`, deleteToken = `token-${id}`;
    this.links.set(id, { machine, sealed: sealed.slice(), png: png && png.slice(), deleteToken });
    return { id, deleteToken };
  }
  async load(id) {
    const l = this.links.get(id);
    if (!l) throw new ShortLinkError('This short link was removed, or never existed.', 404);
    return l.sealed.slice();
  }
  async remove(id, deleteToken) {
    const l = this.links.get(id);
    if (!l) throw new ShortLinkError('That link is not there (it was removed already).', 404);
    if (l.deleteToken !== deleteToken) throw new ShortLinkError('That is not this link\'s delete token.', 403);
    this.links.delete(id);
  }
}
