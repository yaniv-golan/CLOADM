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
  function writeIndex(list) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${indexFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ roms: list }, null, 1) + '\n');
    fs.renameSync(tmp, indexFile);
  }
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
      const list = readIndex();
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) {
        const crc = crcOf(f.bytes), file = `${crc}.rom`;
        fs.writeFileSync(path.join(dir, file), f.bytes);
        const entry = { file, name: f.name, crc, size: f.bytes.length, source, from, added: new Date(now()).toISOString() };
        const at = list.findIndex((r) => r.crc === crc);
        if (at >= 0) list[at] = entry; else list.push(entry);
      }
      writeIndex(list);
    },
    // names: the entries to forget (null: all) -> the names forgotten
    remove(names) {
      const list = readIndex(), gone = list.filter((r) => names === null || names.includes(r.name)), keep = list.filter((r) => !gone.includes(r));
      if (!gone.length) return [];
      writeIndex(keep);
      for (const r of gone) if (!keep.some((k) => k.file === r.file)) { try { fs.unlinkSync(path.join(dir, r.file)); } catch (e) { /* already gone */ } }
      return gone.map((r) => r.name);
    },
  };
}

module.exports = { romStore };
