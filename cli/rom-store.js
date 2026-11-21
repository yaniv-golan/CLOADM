// add_roms' store: the ROMs the person added through the MCP server, kept across restarts in a folder of the server's
// own (next to its config file: ~/.config/cloadm/roms/, %APPDATA%\cloadm\roms\ on Windows), never in the media root.
// Each image is one file, <CRC32>.rom, and index.json lists them: { "roms": [{ file, name, crc, size, source, from,
// added }] }, name being the file name it came with (a ROM CLOADM does not know by its contents is matched by that name
// and its size). The bytes are only read back to boot machines: nothing here logs or returns them.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const T = require('../js/mcp/tools.js');

const crcOf = (bytes) => (zlib.crc32(bytes) >>> 0).toString(16).toUpperCase().padStart(8, '0');
const INDEX = 'index.json';
const LOCK = 'index.lock';

// a URL kept as origin + path: never the query or the fragment, which can hold a token (anything else, such as a path
// in the media root, is kept as it is). A secret in the URL's path itself is not covered: only what follows the path is.
function fromOf(from) {
  if (typeof from !== 'string') return from;
  let u;
  try { u = new URL(from); } catch (e) { return from; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : from;
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// dir: the store's folder (made on the first add); warn(text): a problem reading it back (never the bytes)
// lockStaleMs, lockWaitMs: how old a lock must be to be broken, and how long a change waits for one (tests shorten them)
function romStore(dir, { warn = () => {}, now = () => Date.now(), lockStaleMs = 10000, lockWaitMs = 30000 } = {}) {
  const LOCK_STALE_MS = lockStaleMs, LOCK_WAIT_MS = lockWaitMs;
  const indexFile = path.join(dir, INDEX);
  // the index's entries. Reading (list, files) never changes anything: a bad file gives [] and a warning. strict is for
  // the changes (add, remove), which write the index back and would drop every entry they could not read: an index that
  // cannot be read at all is an error (cannot-write, naming the file), and one that is not valid is moved aside as
  // index.json.corrupt-<time> (the warning names it), so what it listed can be recovered by hand and the change goes on
  // with an empty list
  function readIndex(strict = false) {
    let text;
    try { text = fs.readFileSync(indexFile, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return [];
      if (strict) throw new T.McpToolError('cannot-write', `cannot read ${indexFile}: ${e.code || e.message}; nothing was changed`);
      warn(`cannot read ${indexFile}: ${e.code || e.message}`); return [];
    }
    try {
      const j = JSON.parse(text);
      if (!j || !Array.isArray(j.roms)) throw new Error('no "roms" list');
      return j.roms.filter((r) => r && typeof r.file === 'string' && /^[0-9A-F]{8}\.rom$/.test(r.file) && typeof r.name === 'string');
    } catch (e) {
      if (!strict) { warn(`${indexFile} is not valid (${e.message}); the stored ROMs are not used`); return []; }
      let aside = `${indexFile}.corrupt-${Date.now()}`;
      for (let k = 2; fs.existsSync(aside); k++) aside = `${indexFile}.corrupt-${Date.now()}-${k}`;   // never over an earlier one
      try { fs.renameSync(indexFile, aside); } catch (e2) { throw new T.McpToolError('cannot-write', `${indexFile} is not valid (${e.message}) and cannot be moved aside: ${e2.code || e2.message}; nothing was changed`); }
      warn(`${indexFile} is not valid (${e.message}); moved to ${aside}, and the store starts empty`);
      return [];
    }
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
  // A lock older than LOCK_STALE_MS (its holder died) is broken. Breaking is the one step that is not exclusive: if one
  // process stalls between its stat and its unlink, another can break and take the lock in between, and the stalled
  // one then removes the new lock, so two can both proceed. It takes a holder dead for ten seconds and two waiters
  // meeting at that instant. While it waits, the process is blocked (Atomics.wait, not a timer): at most LOCK_WAIT_MS,
  // and only after a crashed holder, since a live one holds the lock for milliseconds.
  // Any failure here is an McpToolError (cannot-write) saying what to do.
  function locked(fn) {
    const lock = path.join(dir, LOCK), until = Date.now() + LOCK_WAIT_MS;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { throw new T.McpToolError('cannot-write', `cannot make the ROM store ${dir}: ${e.code || e.message}`); }
    for (;;) {
      try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
        // on Windows a lock being deleted by its holder answers EPERM or EACCES to a new open
        if (e.code !== 'EEXIST' && !(process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES'))) throw new T.McpToolError('cannot-write', `cannot lock the ROM store ${dir}: ${e.code || e.message}`);
        try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch (e2) { continue; /* released meanwhile */ }
        if (Date.now() > until) throw new T.McpToolError('cannot-write', `the ROM store is locked: ${lock} is held by another process; remove index.lock if no CLOADM server is running`);
        sleepMs(5 + Math.floor(Math.random() * 20));
      }
    }
    try {
      // temporary files left by a process that died between writing and renaming (a live writer holds the lock)
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) { try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(path.join(dir, f)); } catch (e) { /* gone */ } }
      return fn();
    } catch (e) {
      throw e instanceof T.McpToolError ? e : new T.McpToolError('cannot-write', `ROM store ${dir}: ${e.code || e.message}`);
    } finally { try { fs.unlinkSync(lock); } catch (e) { /* broken as stale by another */ } }
  }
  // every entry's "from" is scrubbed again, so an entry written by an older version with a query in it loses it
  const writeIndex = (list) => writeAtomic(indexFile, JSON.stringify({ roms: list.map((r) => ({ ...r, from: fromOf(r.from) })) }, null, 1) + '\n');
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
        const list = readIndex(true);
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
      const list = readIndex(true), gone = list.filter((r) => names === null || names.includes(r.name)), keep = list.filter((r) => !gone.includes(r));
      if (!gone.length) return [];
      writeIndex(keep);
      for (const r of gone) if (!keep.some((k) => k.file === r.file)) { try { fs.unlinkSync(path.join(dir, r.file)); } catch (e) { /* already gone */ } }
      return gone.map((r) => r.name);
    }),
  };
}

module.exports = { romStore };
