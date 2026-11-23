// A stand-in for another machine's gzip, for tests that must not depend on the one that wrote a file. Preloaded with
// `node -r tests/gzip-platform.js <test>` (or NODE_OPTIONS=--require=...), it replaces CompressionStream('gzip') with one
// that writes the same contents through another deflate setting (zlib level 1: other bytes, another length) and the
// header's operating system byte of the OTHER of the two machines (19 on a Linux host, where Linux writes 3; 3 on a Mac,
// which writes 19: RFC 1952, section 2.3.1, byte 9). Contents are unchanged; anything that compares compressed bytes
// or sizes shows, whichever machine runs it.
const zlib = require('zlib');
const { otherOsByte } = require('./gzip-contents');
const IMPOSED = otherOsByte();
const Real = globalThis.CompressionStream;
globalThis.CompressionStream = class {
  constructor(format) {
    if (format !== 'gzip') { const r = new Real(format); this.writable = r.writable; this.readable = r.readable; return; }
    const chunks = []; let out;
    this.readable = new ReadableStream({ start(c) { out = c; } });
    this.writable = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk)); },
      close() { const gz = zlib.gzipSync(Buffer.concat(chunks), { level: 1 }); gz[9] = IMPOSED; out.enqueue(new Uint8Array(gz)); out.close(); },
    });
  }
};
