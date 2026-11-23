// Run: node tests/session-library.test.js
//
// The media library moved out of the Session into js/library.js (session.library, a MediaLibrary):
//  * nothing the person keeps changed: the scenario in tests/session-library-scenario.js (two stored disks written
//    by the machine, one write-protected; a program loaded; a slot; imports, renames, a refused rename, a delete; the
//    settings export; the snapshot file and the machine's snapshot; the library moved to another store) gives,
//    byte for byte, what it gave at the commit before the move (tests/fixtures/session-split/, made with the old
//    names on the Session), and the fixture's snapshot file opens and saves back byte-identical;
//  * the Session holds one MediaLibrary as `library`, its own `session` is the Session, and none of the moved names
//    is left on the Session or its prototype;
//  * the wiring: the library exists before the Session's DriveWire server first compares a name or asks whether the
//    library is moving; useMediaStore re-points the store handle, the media index and the ROM library; a move
//    re-points every DriveWire server the Session built;
//  * the API key reaches none of it: not the library's own state, the stored files, the snapshot or the export.
const fs = require('fs'), path = require('path');
const { scenario, KEY, NOW, sha } = require('./session-library-scenario');
const { sameGzipContents } = require('./gzip-contents');
const { Emu, MemoryMediaStore } = require('./disks-common');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const FIX = path.join(__dirname, 'fixtures/session-split');
// every name that moved, methods and fields (the Session's own copies of them must be gone)
const MOVED = ['useMediaStore', 'moveMedia', 'checkNoStoredMounts', 'boundedWait', 'libraryWritesSettled', 'libraryOp', 'copyMedia', 'checkNotMoving',
  'recentMedia', 'rememberMedia', 'afterMove', 'loadRecent', 'libName', 'listMedia', 'openMedia', 'downloadMedia', 'renameMedia', 'deleteMedia',
  'importMedia', 'mediaError', 'indexWriteError', 'sameName', 'caseInsensitive', '_caseInsensitive', 'measureCase', 'refreshCase', 'createExclusive',
  'creationFinished', 'landedRace', 'creationLanded', 'nameVacated', 'claimDiskName', 'releaseDiskName', 'claimingDiskName', 'claimedDiskName',
  'mediaMoveWaitMs', 'mediaSince', 'movingMedia', 'movingOps', 'moveDone', 'creating', 'creationsAsked', 'landing', 'pendingLands', 'diskClaims'];
// the first difference between two JSON texts, for a failure's detail
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i >= a.length && i >= b.length ? '' : `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`; };

(async () => {
  // ---- the fixtures: everything kept is byte-identical to the commit before the move ----
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  const moment = new Uint8Array(fs.readFileSync(path.join(FIX, 'moment.cloadm')));
  const run = await scenario((s) => s.library);
  const got = JSON.stringify(run.report, null, 1), want = JSON.stringify(expected.report, null, 1);
  check('the scenario\'s report (drives, library listing and bytes, refusals, recent list, slots, settings, stored files, the move) is the parent commit\'s',
    got === want, firstDiff(got, want));
  for (const k of Object.keys(expected.report)) {
    check(`... ${k}`, JSON.stringify(run.report[k]) === JSON.stringify(expected.report[k]));
  }
  check('the machine\'s snapshot is byte-identical to the parent commit\'s', sha(run.machine) === expected.machine);
  // (the gzip header's operating system byte is the writing machine's: 3 on Linux, 19 on macOS, so the file is compared by
  // what it holds, and the fixture itself by its hash: tests/gzip-contents.test.js)
  const same = sameGzipContents(run.snapshotFile, moment);
  check('the snapshot file holds exactly what the parent commit\'s did (the fixture is the file whose hash is recorded)', sha(moment) === expected.snapshotFile && same.same, same.why);
  // The fixture opens, and saves back identical but for one counter: restoring a machine with a disk controller
  // re-arms its scheduler, which advances the scheduler's generation (`gen`) by one. That is Machine.restore's own
  // behaviour, the same at the commit before the move (measured there with this fixture); every other byte of the
  // state must come back as it was.
  {
    const s = run.s;
    const opened = s.openSnapshot(await s.readSnapshot(moment));
    const back = await s.snapshotFile(NOW);
    const text = async (bytes) => { const x = await Emu.decodeSnapshot(bytes); return Emu.state.toJSON(x); };
    const a = await text(moment), b = await text(back.bytes);
    const gens = (t) => [...t.matchAll(/"gen":(\d+)/g)].map((m) => Number(m[1]));
    const ga = gens(a), gb = gens(b);
    check('the fixture\'s snapshot file opens and saves back identical, but for the scheduler generation the restore advances',
      a !== b && a.replace(/"gen":\d+/g, '"gen":#') === b.replace(/"gen":\d+/g, '"gen":#') && ga.length === gb.length && ga.every((g, i) => gb[i] === g || gb[i] === g + 1),
      `${opened}; gen ${ga.join()} -> ${gb.join()}`);
  }
  // the key: nowhere
  {
    const s = run.s;
    const own = JSON.stringify(Object.fromEntries(Object.entries(s.library).filter(([k]) => k !== 'session')), (k, v) => (v instanceof Map || v instanceof Set ? [...v] : v));
    const stored = [];
    for (const prefix of ['library/', 'disks/', 'drivewire/', 'roms/', 'recent/', 'meta/']) for (const f of await s.media.list(prefix)) stored.push(Buffer.from(await s.media.read(f.name)).toString('latin1'));
    const decoded = Emu.state.toJSON(await Emu.decodeSnapshot(moment));
    check('the API key is not in the library\'s state, the stored files, the snapshot or the export',
      !own.includes('sk-ant') && stored.every((t) => !t.includes(KEY)) && !decoded.includes('sk-ant') && !got.includes('sk-ant') && !run.machine.includes('sk-ant'));
  }

  // ---- the Session holds one MediaLibrary, and none of the old names ----
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    check('session.library is a MediaLibrary whose session is the Session', s.library instanceof Emu.MediaLibrary && s.library.session === s);
    const left = MOVED.filter((k) => k in s);
    check('none of the moved names is on the Session or its prototype', left.length === 0, left.join());
    const missing = MOVED.filter((k) => !(k in s.library));
    check('every moved name is on the library', missing.length === 0, missing.join());
    check('the Session keeps the store handle and its services (media, index, roms)', s.media && s.index instanceof Emu.MediaIndex && s.roms.index === s.index);
    check('the constants stay exported from the library: DISK_PREFIX, DW_PREFIX, MEDIA_MOVE_WAIT_MS', Emu.DISK_PREFIX === 'disks/' && Emu.DW_PREFIX === 'drivewire/' && Emu.MEDIA_MOVE_WAIT_MS === 30000);
    const quick = new Emu.Session({ mediaMoveWaitMs: 25 });
    check('the Session hands mediaMoveWaitMs to its library', quick.library.mediaMoveWaitMs === 25 && s.library.mediaMoveWaitMs === Emu.MEDIA_MOVE_WAIT_MS);
  }

  // ---- the wiring: built first, re-pointed on a store change and on a move ----
  {
    // the DriveWire server compares names by the library's rule and refuses a write while it moves: both answer
    // straight after construction
    const ci = new Emu.Session({ media: new MemoryMediaStore({ caseInsensitive: true }) });
    const cs = new Emu.Session({ media: new MemoryMediaStore({ caseInsensitive: false }) });
    check('from construction: the DriveWire server compares names by the store\'s rule (through the library)',
      ci.drivewire.sameName('GAME.DSK', 'game.dsk') === true && cs.drivewire.sameName('GAME.DSK', 'game.dsk') === false);
    check('from construction: the DriveWire server may write (the library is not moving), and its Library operation is the library\'s',
      ci.drivewire.mayWrite() === true && await ci.drivewire.openLibraryOp(async () => 'ran') === 'ran');
    ci.library.movingMedia = true;
    check('... and it is refused once the library moves', ci.drivewire.mayWrite() === false
      && await ci.drivewire.openLibraryOp(async () => 'ran').then(() => false, (e) => /being moved/.test(e.message)));
    ci.library.movingMedia = false;
    // useMediaStore: the Session's handle, its index and the ROM library all follow
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    const writeError = () => {};
    s.index.writeError = writeError;
    // the first store tells cases apart, the new one does not: the rule must change with the store
    const other = new MemoryMediaStore({ caseInsensitive: true });
    const oldIndex = s.index, before = s.library.caseInsensitive;
    s.library.useMediaStore(other);
    check('useMediaStore: the Session\'s store handle, a new index on it (its write-error listener kept) and the ROM library\'s index',
      s.media === other && s.index !== oldIndex && s.index.store === other && s.index.writeError === writeError && s.roms.index === s.index);
    check('useMediaStore: the library takes the new store\'s case rule (case-sensitive before, case-insensitive after)',
      before === false && s.library.caseInsensitive === true, `before=${before} after=${s.library.caseInsensitive}`);
    // a move: every DriveWire server the Session built reads and writes the new store
    const there = new MemoryMediaStore();
    await s.library.importMedia('HELLO.BIN', new Uint8Array([1, 2, 3]));
    const r = await s.library.moveMedia(there);
    check('a move re-points the Session\'s store, index and DriveWire server', r.copied >= 1 && s.media === there && s.index.store === there && s.drivewire.store === there
      && (await s.library.listMedia()).map((x) => x.name).join() === 'library/HELLO.BIN');
  }

  console.log(`\n${n - fail}/${n} session library checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
