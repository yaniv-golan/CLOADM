// The scenario tests/session-library.test.js replays to show that moving the media library out of the Session
// (js/library.js, session.library) changed nothing the person keeps: it ran once at the commit before the move, with
// the old names on the Session, and wrote tests/fixtures/session-split/; the test runs it again with the new names
// and compares every byte. Not a suite itself (no .test.js suffix).
//
// lib(s): where the library's methods live (the Session itself before the move, session.library after it).
// On a Dragon 64 with our own firmware as BASIC and DragonDOS (tools/mame-diff/fdc, never a ROM):
//  * two disks imported and mounted, the firmware's sector writes landed, drive 1 then write-protected;
//  * a program loaded (the recent list), a settings export, a quick-save slot;
//  * the library: a program, a text file and a disk image imported, two renames (one a disk image), a delete;
//  * the snapshot file and the machine's own snapshot;
//  * the disks ejected and the library moved to another store: what was copied, and every stored byte there.
// -> { snapshotFile (bytes), machine (the machine snapshot as JSON text), report (JSON-able: everything else) }
const crypto = require('crypto');
const { Emu, images, session, runToHalt, MemoryMediaStore } = require('./disks-common');

const KEY = 'sk-ant-LIBRARY-FIXTURE-KEY-0123456789';
const NOW = new Date('2026-01-02T03:04:05Z');
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
// a program of our own: load $3000, a NOP loop (DragonDOS-style binary header, as the Library's tests use)
const PROGRAM = new Uint8Array([0x55, 2, 0x30, 0, 0, 3, 0x30, 0, 0xAA, 0x12, 0x20, 0xFE]);
// every file a store holds, by name, with its size and the hash of its bytes (no times: they are the clock's). A
// quick-save slot's file carries the moment it was taken, so it is hashed as the snapshot it decodes to without that.
async function storeReport(store) {
  const out = [];
  for (const prefix of ['library/', 'disks/', 'drivewire/', 'roms/', 'recent/', 'meta/']) {
    for (const f of await store.list(prefix)) {
      const bytes = await store.read(f.name);
      let hash = sha(bytes);
      if (f.name.endsWith('.cloadm')) { const snap = await Emu.decodeSnapshot(bytes); delete snap.taken; hash = sha(Emu.state.toJSON(snap)); }
      out.push({ name: f.name, size: f.size, sha: hash });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function scenario(lib) {
  const { s, media, halt } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
  s.setClaudeKey(KEY);
  s.store.set('keyboardMode', 'positional');
  s.store.set('tapeSound', '0');
  const report = {};
  // the drives: two stored disks, written by the machine
  report.import0 = await s.drives.importImage('work.vdk', images.vdk(40, 2), 0);
  report.import1 = await s.drives.importImage('other.vdk', images.vdk(40, 1), 1);
  report.halted = runToHalt(s, halt);
  await s.drives.writesDone();
  s.drives.setWriteProtect(1, true);
  report.drives = s.drives.status().drives;
  // the library
  await lib(s).importMedia('HELLO.BIN', PROGRAM);
  await lib(s).importMedia('notes/readme.txt', new TextEncoder().encode('kept by CLOADM'));
  await lib(s).importMedia('GAME.DSK', images.vdk(35, 1));
  await lib(s).renameMedia('disks/GAME.DSK', 'TOOLS.DSK');
  await lib(s).renameMedia('library/HELLO.BIN', 'HI.BIN');
  await lib(s).deleteMedia('library/notes/readme.txt');
  report.listing = (await lib(s).listMedia()).map((f) => ({ name: f.name, size: f.size }));
  report.opened = sha(await lib(s).openMedia('disks/TOOLS.DSK'));
  const dl = await lib(s).downloadMedia('library/HI.BIN');
  report.download = { name: dl.name, sha: sha(dl.bytes) };
  report.refused = await lib(s).renameMedia('disks/work.vdk', 'moved.vdk').then(() => null, (e) => e.message);
  report.sameName = [lib(s).sameName('GAME.DSK', 'game.dsk'), lib(s).caseInsensitive];
  // a program loaded: the recent list
  report.load = s.load('loop.bin', PROGRAM);
  report.recent = lib(s).recentMedia();
  // a quick-save slot and the settings
  report.slot = await s.saveSlot(2);
  report.slots = (await s.listSlots()).map((x) => ({ n: x.n, empty: !!x.empty, machine: x.machine || null, size: x.size || null }));
  report.settings = JSON.stringify(s.exportSettings());
  // the moment
  const file = await s.snapshotFile(NOW);
  const machine = Emu.state.toJSON(s.shownMachine.snapshot());
  report.snapshotName = file.name;
  report.stored = await storeReport(media);
  // the library moved: refused with disks in the drives, then done once they are out
  const there = new MemoryMediaStore({ caseInsensitive: true });
  report.moveRefused = await lib(s).moveMedia(there).then(() => null, (e) => e.message);
  await s.drives.eject(0);
  await s.drives.eject(1);
  report.moved = await lib(s).moveMedia(there);
  report.movedStore = await storeReport(there);
  report.after = (await lib(s).listMedia()).map((f) => ({ name: f.name, size: f.size }));
  report.remount = await s.drives.mount(0, 'work.vdk');
  report.movedDisk = sha(await there.read('disks/work.vdk'));
  return { snapshotFile: file.bytes, machine, report, s };
}

module.exports = { scenario, KEY, NOW, sha };
