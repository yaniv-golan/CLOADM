// Run: node tests/session-drives.test.js
//
// The floppy drives moved out of the Session into js/drives.js (session.drives, a DiskDrives), with shorter names
// (tests/session-drives-scenario.js MAP: mountDisk -> drives.mount, importDisk -> drives.importImage, ...):
//  * nothing the person keeps changed: the scenario (two stored disks; Ask Claude's restore point taken with them
//    linked, the firmware's sector writes, the point restored and the images put back whole, written again; drive 1
//    write-protected, a blank disk made, a download; the settings export; the snapshot file and the machine's
//    snapshot; the snapshot opened again and a disk kept from it; the library moved and a disk mounted from there)
//    gives, byte for byte, what it gave at the commit before the move (tests/fixtures/session-split/drives.json and
//    drives-moment.cloadm, made with the old names on the Session), and the snapshot file opens and saves back;
//  * the Session holds one DiskDrives as `drives`, none of the old names is left on the Session or its prototype,
//    and every new name is on the drives;
//  * the Session's key for a mount inside its own Library operation is held privately by its drives: no property of
//    the drives exposes it, and a mount given any key an embedder can make is refused while the library moves;
//  * the API key reaches none of it.
const fs = require('fs'), path = require('path');
const { scenario, MAP, KEY, NOW, sha } = require('./session-drives-scenario');
const { sameGzipContents } = require('./gzip-contents');
const { Emu, MemoryMediaStore, images } = require('./disks-common');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const FIX = path.join(__dirname, 'fixtures/session-split');
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i >= a.length && i >= b.length ? '' : `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`; };

(async () => {
  // ---- the fixtures: everything kept is byte-identical to the commit before the move ----
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'drives.json'), 'utf8'));
  const moment = new Uint8Array(fs.readFileSync(path.join(FIX, 'drives-moment.cloadm')));
  const run = await scenario(true);
  const got = JSON.stringify(run.report, null, 1), want = JSON.stringify(expected.report, null, 1);
  check('the scenario\'s report (mounts, restore point, writes, protection, new disk, download, status, settings, kept disk, move) is the parent commit\'s',
    got === want, firstDiff(got, want));
  for (const k of Object.keys(expected.report)) check(`... ${k}`, JSON.stringify(run.report[k]) === JSON.stringify(expected.report[k]));
  check('the machine\'s snapshot is byte-identical to the parent commit\'s', sha(run.machine) === expected.machine);
  // (the gzip header's operating system byte is the writing machine's: 3 on Linux, 19 on macOS, so the file is compared by
  // what it holds, and the fixture itself by its hash: tests/gzip-contents.test.js)
  const same = sameGzipContents(run.snapshotFile, moment);
  check('the snapshot file holds exactly what the parent commit\'s did (the fixture is the file whose hash is recorded)', sha(moment) === expected.snapshotFile && same.same, same.why);
  // opened and saved back: identical but for the scheduler generation a restore with a disk controller advances
  // (Machine.restore's own behaviour, the same at the commit before the move: see tests/session-library.test.js)
  {
    const s = run.s;
    s.openSnapshot(await s.readSnapshot(moment));
    const back = await s.snapshotFile(NOW);
    const text = async (bytes) => Emu.state.toJSON(await Emu.decodeSnapshot(bytes));
    const a = await text(moment), b = await text(back.bytes);
    const gens = (t) => [...t.matchAll(/"gen":(\d+)/g)].map((m) => Number(m[1]));
    const ga = gens(a), gb = gens(b);
    check('the fixture\'s snapshot file opens and saves back identical, but for the scheduler generation the restore advances',
      a.replace(/"gen":\d+/g, '"gen":#') === b.replace(/"gen":\d+/g, '"gen":#') && ga.length === gb.length && ga.every((g, i) => gb[i] === g || gb[i] === g + 1),
      `gen ${ga.join()} -> ${gb.join()}`);
  }
  // the key: nowhere
  {
    const s = run.s;
    const own = JSON.stringify(Object.fromEntries(Object.entries(s.drives).filter(([k]) => k !== 'session')), (k, v) => (v instanceof Map || v instanceof Set ? [...v] : typeof v === 'symbol' ? String(v) : v));
    const stored = [];
    for (const prefix of ['library/', 'disks/', 'drivewire/']) for (const f of await s.media.list(prefix)) stored.push(Buffer.from(await s.media.read(f.name)).toString('latin1'));
    const decoded = Emu.state.toJSON(await Emu.decodeSnapshot(moment));
    check('the API key is not in the drives\' state, the stored files, the snapshot or the report',
      !own.includes('sk-ant') && stored.every((t) => !t.includes(KEY)) && !decoded.includes('sk-ant') && !got.includes('sk-ant') && !run.machine.includes('sk-ant'));
  }

  // ---- the Session holds one DiskDrives, and none of the old names ----
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    check('session.drives is a DiskDrives whose session is the Session', s.drives instanceof Emu.DiskDrives && s.drives.session === s);
    const left = Object.keys(MAP).filter((k) => k in s);
    check('none of the old names is on the Session or its prototype', left.length === 0, left.join());
    const missing = Object.values(MAP).filter((k) => !(k in s.drives));
    check('every new name is on the drives', missing.length === 0, missing.join());
    check('BARE_NOTE is exported from the drives\' module', typeof Emu.BARE_NOTE === 'string' && /no disk ROM/.test(Emu.BARE_NOTE));
  }

  // ---- the Session's mount key: held privately, so nothing outside can skip the move checks ----
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon64');
    const own = Reflect.ownKeys(s.drives);
    check('the mount key is not reachable on the drives: no `held`, no Symbol-named or Symbol-valued own property',
      !('held' in s.drives) && own.every((k) => typeof k !== 'symbol' && typeof s.drives[k] !== 'symbol'), own.map(String).join());
    await s.media.write('disks/a.vdk', images.vdk(40, 1));
    s.library.movingMedia = true;
    const forged = await s.drives.mount(0, 'a.vdk', { [Symbol('held')]: true, held: true }).then(() => 'mounted', (e) => e.message);
    s.library.movingMedia = false;
    check('while the library moves, a mount with any key an embedder can make is refused', /being moved/.test(forged), forged);
    // (the Session's own use of the key, a NitrOS-9 floppy boot inside a move, is tests/move-inflight.test.js's)
  }

  // ---- the drives' writes land in order, and an eject waits for them, on a store that answers slowly ----
  let chained = false;
  {
    // a store whose writes answer in reverse: each write waits less than the one before it, so writes started together
    // finish last-first. Only the drives' chain keeps them in the order the machine made them.
    class SlowStore extends MemoryMediaStore {
      constructor() { super(); this.delay = 60; }
      async writeRange(name, offset, data) { const d = this.delay; this.delay = Math.max(0, this.delay - 20); await new Promise((r) => setTimeout(r, d)); return super.writeRange(name, offset, data); }
    }
    const media = new SlowStore();
    const s = new Emu.Session({ media });
    await media.write('disks/a.vdk', images.vdk(40, 1));
    const size = (await media.stat('disks/a.vdk')).size;
    const link = s.drives.link('disks/a.vdk');
    link(100, new Uint8Array([1]), size);
    link(100, new Uint8Array([2]), size);
    link(101, new Uint8Array([3]), size);
    // waited for on timers (every write landed, or 5 s), not through writesDone: if the writes are not one chain,
    // writesDone awaits a promise already settled while earlier writes are still out, a loop of microtasks that never
    // lets a timer run, so it could not fail, only hang. It is asked only once every write has landed.
    for (let i = 0; i < 100 && s.drives.landed < s.drives.queued; i++) await new Promise((r) => setTimeout(r, 50));
    const b = await media.read('disks/a.vdk');
    chained = s.drives.landed === s.drives.queued && b[100] === 2 && b[101] === 3;
    if (chained) await s.drives.writesDone();
    check('two writes to the same byte land in the order made, and writesDone then resolves',
      chained, `byte 100=${b[100]} 101=${b[101]} landed ${s.drives.landed}/${s.drives.queued}`);
  }
  // (only once the writes are known to be one chain: otherwise the eject's own wait spins, as above)
  if (!chained) check('eject resolves once the drive\'s writes are in the store', false, 'not run: the drives\' writes are not one chain');
  else {
    // the firmware's sector writes are still in the drive (not yet handed to the store) when it is ejected: the
    // eject commits them and resolves only once the store has them
    class SlowStore extends MemoryMediaStore {
      async writeRange(name, offset, data) { await new Promise((r) => setTimeout(r, 30)); return super.writeRange(name, offset, data); }
    }
    const { session: rig, runToHalt, expectImage, pattern } = require('./disks-common');
    const { s, media, halt } = rig('dragon64', 'dragondos', 'dragon', { media: new SlowStore() });
    const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
    await s.drives.importImage('work.vdk', d0, 0);
    await s.drives.importImage('other.vdk', d1, 1);
    runToHalt(s, halt);
    await s.drives.eject(0);
    const now = await media.read('disks/work.vdk');
    const want = expectImage(d0, 12, 2, pattern(0x11));
    check('eject resolves once the drive\'s writes are in the store', now.length === want.length && now.every((v, i) => v === want[i]));
    await s.drives.writesDone();
  }

  console.log(`\n${n - fail}/${n} session drives checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
