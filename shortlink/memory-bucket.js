/*
 * An in-memory stand-in for the Worker's bindings, for tests only (tests/shortlink-worker.test.js and the browser
 * check's shortLink group): an R2 bucket with the Workers API's head/get/put/delete and their conditions (onlyIf as
 * conditional headers or { etagMatches }), and a rate limiter with the binding's limit({ key }). Never deployed.
 */
export class MemoryBucket {
  constructor() { this.objects = new Map(); this.n = 0; this.failNext = []; }
  obj(key, o) {
    return o && { key, etag: o.etag, httpEtag: `"${o.etag}"`, size: o.bytes.length, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata,
      text: async () => new TextDecoder().decode(o.bytes), arrayBuffer: async () => o.bytes.slice().buffer };
  }
  async head(key) { return this.obj(key, this.objects.get(key)); }
  async get(key) { return this.obj(key, this.objects.get(key)); }
  async put(key, value, opts = {}) {
    const cur = this.objects.get(key), only = opts.onlyIf;
    if (this.failNext.length && this.failNext[0](key)) { this.failNext.shift(); return null; }   // a write that lost a race
    if (only instanceof Headers) { if (only.get('If-None-Match') === '*' && cur) return null; }
    else if (only && only.etagMatches !== undefined && (!cur || cur.etag !== only.etagMatches)) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes: bytes.slice(), etag: `e${++this.n}`, customMetadata: opts.customMetadata || {}, httpMetadata: opts.httpMetadata || {} });
    return this.obj(key, this.objects.get(key));
  }
  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }
  text(key) { const o = this.objects.get(key); return o ? new TextDecoder().decode(o.bytes) : null; }
}

// a rate limiter allowing `n` calls per key
export function memoryLimiter(n) {
  const seen = new Map();
  return { calls: [], async limit({ key }) { this.calls.push(key); const c = (seen.get(key) || 0) + 1; seen.set(key, c); return { success: c <= n }; } };
}
