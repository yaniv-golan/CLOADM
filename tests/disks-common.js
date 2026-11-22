// Shared fixtures for the floppy-disk suites (tests/disks*.test.js): our firmware as BASIC and the DOS ROM,
// a recording MemoryMediaStore and a Session built on them. See tests/disks.test.js for what the firmware does.
// Not a suite itself (no .test.js suffix): each suite file requires it and keeps its own pass/fail count.
const path = require('path');
const Emu = require('./load')();
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
const images = require('../tools/mame-diff/fdc/images');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');


const FDC = path.join(__dirname, '../tools/mame-diff/fdc');
require(path.join(FDC, 'gen-diag')).write();
const boot = romImage(assembleFile(path.join(FDC, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12);
const writer = (board) => { const a = assembleFile(path.join(FDC, `${board}-write.asm`), '6809'); return { rom: romImage(a, 0xC000, 0x2000, 0x00), halt: a.symbols.get('HALT') }; };
const pattern = (first) => Array.from({ length: 256 }, (_, i) => (first + 3 * i) & 0xff);
// sector 3 of track 1, side 0, after the header (VDK 12 bytes, a two-sided JVC 2), sectors in order
const sectorOffset = (header, heads) => header + ((1 * heads + 0) * 18 + 2) * 256;
const expectImage = (bytes, header, heads, data) => { const e = bytes.slice(); e.set(data, sectorOffset(header, heads)); return e; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// a MemoryMediaStore that records the writes it receives
function spyStore(opts) {
  const st = new MemoryMediaStore(opts);
  st.calls = [];
  for (const m of ['write', 'writeRange', 'read', 'readRange']) {
    const orig = st[m].bind(st);
    st[m] = (name, ...a) => { st.calls.push({ m, name, offset: m.endsWith('Range') ? a[0] : null, length: m === 'writeRange' ? a[1].length : m === 'write' ? a[0].length : m === 'readRange' ? a[1] : null }); return orig(name, ...a); };
  }
  return st;
}
// a session on `machine` with our boot firmware as BASIC and the writer as the DOS ROM of `dos`
// (storeOpts: MemoryMediaStore's options, e.g. { caseInsensitive: true }; media: a store to use instead)
function session(machine, dos, board, { storeOpts, media: given } = {}) {
  const media = given || spyStore(storeOpts);
  const s = new Emu.Session({ media });
  return { s, media, halt: putRoms(s, machine, dos, board) };
}
// our firmware as the machine's BASIC and as the DOS ROM, on `machine` -> the writer's HALT address
function putRoms(s, machine, dos, board) {
  s.switchMachine(machine);
  const p = Emu.profiles[machine];
  for (const sl of p.roms) s.roms.put(machine, sl.id, boot.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size), 'boot.rom');
  s.loadSavedRoms();
  const w = writer(board);
  if (dos) s.roms.put(dos, 'rom', w.rom, 'firmware.rom');
  return w.halt;
}
const runToHalt = (s, halt, frames = 600) => { let f = 0; while (s.shownMachine.cpu.pc !== halt && f < frames) { s.shownMachine.runFrame(); f++; } return s.shownMachine.cpu.pc === halt; };
const log = (s) => s.shownMachine.ram.slice(0x6000, 0x6000 + 32);


// a fresh pass/fail count for one suite file: check(), rejects() and failures() (each suite prints its own summary)
function checker() {
  let fail = 0;
  const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
  const rejects = async (name, p, re) => { let msg = null; try { await p; } catch (e) { msg = e instanceof Emu.SessionError ? e.message : `not a SessionError: ${e.message}`; } check(name, msg !== null && re.test(msg), msg === null ? 'did not reject' : msg); };
  return { check, rejects, failures: () => fail };
}

module.exports = { path, assembleFile, romImage, Emu, images, MemoryMediaStore, MediaStoreError, FDC, boot, writer, pattern, sectorOffset, expectImage, same, spyStore, session, putRoms, runToHalt, log, checker };
