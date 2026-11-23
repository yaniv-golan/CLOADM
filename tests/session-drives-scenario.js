// The scenario tests/session-drives.test.js replays to show that moving the floppy drives out of the Session
// (js/drives.js, session.drives) changed nothing the person keeps: it ran once at the commit before the move, with the
// old names on the Session, and wrote tests/fixtures/session-split/drives.json and drives-moment.cloadm; the test runs
// it again through the new names and compares every byte. Not a suite itself (no .test.js suffix).
//
// MAP: each old Session name -> its name under session.drives (the test also checks no old name is left).
// On a Dragon 64 with our own firmware as BASIC and DragonDOS (tools/mame-diff/fdc, never a ROM):
//  * two disks imported and mounted; Ask Claude's restore point taken by a poke, with the drives linked; the firmware
//    writes a sector on both; the point restored (the stored images put back whole); the firmware writes again;
//  * drive 1 write-protected, a blank disk made in drive 2, drive 0 downloaded;
//  * the snapshot file and the machine snapshot; the snapshot opened again (the drives unlinked): drive 0's disk refused
//    (its name is taken), drive 2's kept in the Library once its stored file is gone;
//  * the drives emptied, the library moved to another store, a disk mounted from there.
// -> { snapshotFile, machine (JSON text), report (JSON-able: everything else), s }
const crypto = require('crypto');
const { Emu, images, session, runToHalt, MemoryMediaStore } = require('./disks-common');

const KEY = 'sk-ant-DRIVES-FIXTURE-KEY-0123456789';
const NOW = new Date('2026-01-02T03:04:05Z');
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
const MAP = {
  diskMachine: 'targetMachine', diskDosChoices: 'dosChoices', diskController: 'controller', diskControllerOf: 'controllerOf',
  bareDiskController: 'bareController', bareDiskChoice: 'bareChoice', plugBareDiskController: 'plugBareController', fitDiskRom: 'fitRom',
  diskRomWaiting: 'romWaiting', blankDiskChoices: 'blankChoices', blankDiskController: 'blankController', newDisk: 'newDisk',
  insertDiskDos: 'insertDos', preferredDiskDos: 'preferredDos', diskStoreName: 'storeName', storedDiskName: 'storedName',
  driveCount: 'count', checkDrive: 'checkDrive', listDisks: 'list', importDisk: 'importImage', importDiskStored: 'importStored',
  mountDisk: 'mount', checkDiskLater: 'checkLater', disksChecked: 'checked', diskLink: 'link', storedDisks: 'stored',
  restorePoint: 'restorePoint', relinkPoint: 'relinkPoint', queueDiskWrite: 'queueWrite', diskWriteFailed: 'writeFailed',
  diskStoreChange: 'storeChange', noteDiskChange: 'noteChange', diskWritesSettled: 'writesSettled', addDiskError: 'addError',
  flushDisks: 'flush', diskWritesDone: 'writesDone', ejectDisk: 'eject', setDiskWriteProtect: 'setWriteProtect', diskStatus: 'status',
  diskActivity: 'activity', keepSnapshotDisk: 'keepSnapshot', downloadDisk: 'download', checkNotInDrive: 'checkNotInDrive',
  diskMachines: 'machines', diskHolder: 'holder',
  // fields
  diskWriting: 'writing', diskMounts: 'mounts', diskChecks: 'checks', diskQueued: 'queued', diskLanded: 'landed',
  diskChanges: 'changes', diskError: 'error', diskUnsaved: 'unsaved',
};
const dead = () => new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: KEY });
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err: err.message }));
async function storeReport(store) {
  const out = [];
  for (const prefix of ['library/', 'disks/', 'drivewire/']) for (const f of await store.list(prefix)) out.push({ name: f.name, size: f.size, sha: sha(await store.read(f.name)) });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// moved: false runs the old names on the Session, true the new ones on session.drives
async function scenario(moved) {
  const { s, media, halt } = session('dragon64', 'dragondos', 'dragon');
  const d = (old) => (moved ? s.drives[MAP[old]] : s[old]);
  const fn = (old) => { const f = d(old); if (typeof f !== 'function') throw new Error(`${old} is not a method`); return f.bind(moved ? s.drives : s); };
  s.setClaudeKey(KEY);
  s.store.set('keyboardMode', 'positional');
  const report = {};
  report.choices = fn('diskDosChoices')();
  report.import0 = await fn('importDisk')('work.vdk', images.vdk(40, 2), 0);
  report.import1 = await fn('importDisk')('other.vdk', images.vdk(40, 1), 1);
  report.controller = d('diskController').type;
  report.count = d('driveCount');
  report.preferred = fn('preferredDiskDos')() && fn('preferredDiskDos')().id;
  report.listed = (await fn('listDisks')()).map((f) => f.name);
  // Ask Claude: a turn's restore point with both drives linked, then the firmware writes, then the point comes back
  s.consent.setAllowed(true);
  const chat = s.startAsk({ backend: dead() });
  const poke = await call(chat, 'poke', { address: 0x7F00, bytes: [7] });
  report.poke = poke.ok;
  report.points = s.claudePoints.length;
  report.halted = runToHalt(s, halt);
  await fn('diskWritesDone')();
  report.written = await storeReport(media);
  report.restore = s.restoreClaude();
  await fn('diskWritesDone')();
  report.restored = await storeReport(media);
  report.statusAfterRestore = fn('diskStatus')();
  s.endChat();
  report.halted2 = runToHalt(s, halt);
  await fn('diskWritesDone')();
  report.rewritten = await storeReport(media);
  // the person's changes
  fn('setDiskWriteProtect')(1, true);
  report.blank = await fn('newDisk')(2, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'blank.vdk' });
  const dl = await fn('downloadDisk')(0);
  report.download = { name: dl.name, sha: sha(dl.bytes) };
  report.status = fn('diskStatus')();
  report.activity = fn('diskActivity')();
  report.settings = JSON.stringify(s.exportSettings());
  // the moment
  const file = await s.snapshotFile(NOW);
  const machine = Emu.state.toJSON(s.shownMachine.snapshot());
  report.snapshotName = file.name;
  // opened again: its disks are the snapshot's, unlinked; drive 0's is kept in the Library under a name of its own
  report.opened = s.openSnapshot(await s.readSnapshot(file.bytes));
  report.statusOpened = fn('diskStatus')();
  report.kept = await fn('keepSnapshotDisk')(0).then((x) => x, (e) => `refused: ${e.message}`);
  await media.remove('disks/blank.vdk');   // gone from the store behind the drives' back: drive 2's copy is kept again
  report.keptBlank = await fn('keepSnapshotDisk')(2).then((x) => x, (e) => `refused: ${e.message}`);
  report.statusKept = fn('diskStatus')();
  await fn('diskWritesDone')();
  report.stored = await storeReport(media);
  // the drives emptied and the library moved; a disk mounted from the new place
  for (let i = 0; i < 4; i++) await fn('ejectDisk')(i).catch(() => {});
  const there = new MemoryMediaStore();
  report.moved = await s.library.moveMedia(there);
  report.remount = await fn('mountDisk')(0, 'work.vdk');
  report.movedStore = await storeReport(there);
  report.final = fn('diskStatus')();
  return { snapshotFile: file.bytes, machine, report, s };
}

module.exports = { scenario, MAP, KEY, NOW, sha };
