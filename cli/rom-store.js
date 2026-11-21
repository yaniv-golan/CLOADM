// add_roms' store: the ROMs the person added through the MCP server, kept across restarts in a folder of the server's
// own (next to its config file: ~/.config/cloadm/roms/, %APPDATA%\cloadm\roms\ on Windows), never in the media root.
// Each image is one file, <CRC32>.rom, and index.json lists them: { "roms": [{ file, name, crc, size, source, from,
// added }] }, name being the file name it came with (a ROM CLOADM does not know by its contents is matched by that name
// and its size). The bytes are only read back to boot machines: nothing here logs or returns them.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcOf = (bytes) => (zlib.crc32(bytes) >>> 0).toString(16).toUpperCase().padStart(8, '0');
const INDEX = 'index.json';
const LOCK = 'index.lock', LOCK_STALE_MS = 10000, LOCK_WAIT_MS = 30000;

// a URL kept as origin + path: never the query or the fragment, which can hold a token (anything else, such as a path
// in the media root, is kept as it is)
function fromOf(from) {
  if (typeof from !== 'string') return from;
  let u;
  try { u = new URL(from); } catch (e) { return from; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : from;
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// dir: the store's folder (made on the first add); warn(text): a problem reading it back (never the bytes)
function romStore(dir, { warn = () => {}, now = () => Date.now() } = {}) {
  const indexFile = path.join(dir, INDEX);
  function readIndex() {
    let text;
    try { text = fs.readFileSync(indexFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') warn(`cannot read ${indexFile}: ${e.code || e.message}`); return []; }
    try {
      const j = JSON.parse(text);
      return Array.isArray(j.roms) ? j.roms.filter((r) => r && typeof r.file === 'string' && /^[0-9A-F]{8}\.rom$/.test(r.file) && typeof r.name === 'string') : [];
    } catch (e) { warn(`${indexFile} is not valid JSON (${e.message}); the stored ROMs are not used`); return []; }
  }
  // a file written whole or not at all: a new temporary file (O_EXCL: never through a link or over a file already
  // there), then renamed over the name, which replaces a link rather than following it
  function writeAtomic(file, data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try { fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* not made */ } throw e; }
  }
  // Two server processes may share the store. Every change reads the index again and writes it back while holding
  // index.lock, a file made with O_EXCL; the index itself is replaced by a rename, so a reader never sees half of it.
  // A lock older than LOCK_STALE_MS (its holder died) is broken. Breaking is the one step that is not exclusive: two
  // processes breaking the same dead lock at the same instant can both go on; the window is a few microseconds, after
  // ten seconds of nobody holding it.
  function locked(fn) {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, LOCK), until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch (e2) { continue; /* released meanwhile */ }
        if (Date.now() > until) throw new Error(`${lock} is held by another process; remove it if none is running`);
        sleepMs(5 + Math.floor(Math.random() * 20));
      }
    }
    try { return fn(); } finally { try { fs.unlinkSync(lock); } catch (e) { /* broken as stale by another */ } }
  }
  const writeIndex = (list) => writeAtomic(indexFile, JSON.stringify({ roms: list }, null, 1) + '\n');
  return {
    dir,
    // what is stored, without the bytes
    list: () => readIndex().map(({ name, crc, size, source, from, added }) => ({ name, crc, size, source, from, added })),
    // the stored ROMs as files for the toolbox -> [{ name, bytes }]; an image missing or changed on disk is left out
    files() {
      const out = [];
      for (const r of readIndex()) {
        let bytes;
        try { bytes = new Uint8Array(fs.readFileSync(path.join(dir, r.file))); } catch (e) { warn(`stored ROM ${r.name}: ${e.code || e.message}`); continue; }
        if (crcOf(bytes) !== r.crc) { warn(`stored ROM ${r.name}: its file changed on disk; not used`); continue; }
        out.push({ name: r.name, bytes });
      }
      return out;
    },
    // files: [{ name, bytes }]; an image already stored (same CRC) is replaced by the new entry
    add(files, { source, from }) {
      from = fromOf(from);
      locked(() => {
        const list = readIndex();
        for (const f of files) {
          const crc = crcOf(f.bytes), file = `${crc}.rom`;
          writeAtomic(path.join(dir, file), f.bytes);
          const entry = { file, name: f.name, crc, size: f.bytes.length, source, from, added: new Date(now()).toISOString() };
          const at = list.findIndex((r) => r.crc === crc);
          if (at >= 0) list[at] = entry; else list.push(entry);
        }
        writeIndex(list);
      });
    },
    // names: the entries to forget (null: all) -> the names forgotten
    remove: (names) => locked(() => {
      const list = readIndex(), gone = list.filter((r) => names === null || names.includes(r.name)), keep = list.filter((r) => !gone.includes(r));
      if (!gone.length) return [];
      writeIndex(keep);
      for (const r of gone) if (!keep.some((k) => k.file === r.file)) { try { fs.unlinkSync(path.join(dir, r.file)); } catch (e) { /* already gone */ } }
      return gone.map((r) => r.name);
    }),
  };
}

module.exports = { romStore };
