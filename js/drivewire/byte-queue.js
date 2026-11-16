/*
 * A queue of bytes taken from the front in pieces: the chunks as they arrived, the index of the first one still
 * waiting and an offset into it, so taking n bytes costs about n (not the length of what is still waiting, as shifting an array would: quadratic when a
 * guest is far behind). Used for a DriveWire channel's bytes for the guest (js/drivewire/server.js) and for
 * what a WebSocket bridge holds back (js/host/drivewire-ws.js).
 */
export class ByteQueue {
  constructor() { this.chunks = []; this.head = 0; this.offset = 0; this.length = 0; }
  // add up to `max - length` of `bytes` (a copy) -> how many were added
  push(bytes, max = Infinity) {
    const n = Math.max(0, Math.min(bytes.length, max - this.length));
    if (!n) return 0;
    const c = new Uint8Array(n);
    for (let i = 0; i < n; i++) c[i] = bytes[i] & 0xFF;
    this.chunks.push(c);
    this.length += n;
    return n;
  }
  // remove and return the first n bytes (fewer if fewer wait)
  take(n) {
    n = Math.min(n, this.length);
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[this.head], k = Math.min(n - o, c.length - this.offset);
      out.set(c.subarray(this.offset, this.offset + k), o);
      o += k; this.offset += k;
      if (this.offset === c.length) { this.chunks[this.head++] = null; this.offset = 0; }
    }
    this.length -= n;
    // drop the used chunks now and then (not on every take: that would be the shifting this avoids)
    if (this.head > 1024 && this.head * 2 > this.chunks.length) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
    return out;
  }
  clear() { this.chunks = []; this.head = 0; this.offset = 0; this.length = 0; }
  toArray() {
    const out = [];
    for (let j = this.head; j < this.chunks.length; j++) { const c = this.chunks[j]; for (let i = j === this.head ? this.offset : 0; i < c.length; i++) out.push(c[i]); }
    return out;
  }
  static from(bytes) { const q = new ByteQueue(); q.push(bytes); return q; }
}
