// Moving the library (Session.moveMedia) while the Library is being written: what the move does with an import,
// rename, delete or save already under way when it starts, one that starts while it copies, one that fails while
// it waits, and one that never ends.
// The oracle is what the stores hold after the move: every file this session put in the old store before the move
// began is in the new one, byte for byte, and nothing this session wrote while the move ran landed in the old one.
// Run: node tests/move-inflight.test.js
const Emu = require('./load')();

let n = 0, fail = 0;
const checkOuter = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const check = checkOuter;
const refuse = (p) => p.then(() => null, (e) => e);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const names = async (store, prefix = '') => (await store.list(prefix)).map((f) => f.name).sort().join(',');
const settle = () => new Promise((r) => setImmediate(r));

const bin = new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]);
const rom = (seed) => Uint8Array.from({ length: 0x4000 }, (_, i) => (i * seed + 7) & 0xFF);
// a store whose write() waits for `gate` (a promise) before writing: an operation caught in flight
function slowWrite(store, gate) {
  store.__write = store.write.bind(store);
  store.write = async (name, bytes) => { await gate; return store.__write(name, bytes); };
  return store;
}
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
// a session whose store is `from`, at rest with `setup` done
async function rig(from = new Emu.MemoryMediaStore(), opts = {}) {
  const s = new Emu.Session(Object.assign({ store: Emu.memoryStore(), media: from }, opts));
  await s.ready();
  return s;
}

(async () => {
  // ---- an import under way when the move starts: the move waits for it, and its file moves too ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    const gate = deferred();
    const slow = slowWrite(from, gate.p);
    const imp = s.importMedia('LATE.BIN', bin);
    await settle();                       // the import is inside from.write now
    const mv = s.moveMedia(to);
    await settle();
    check('import in flight: the move has not finished while the import is stuck (it waits for it)', from === s.media);
    gate.resolve();
    const [r, stored] = await Promise.all([mv, imp]);
    check('import in flight: the import finished, the move finished, the file is in the new place byte for byte',
      same(await to.read('library/LATE.BIN'), bin) && r.copied >= 1 && stored && stored.stored, JSON.stringify(r));
    check('import in flight: the session is on the new place', s.media === to);
    check('import in flight: the old place kept its copies (nothing was lost either way)', same(await slow.read('library/LATE.BIN'), bin));
  }

  // ---- a rename under way: it lands in the old place before the copy, which takes the new name ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('OLD.BIN', bin);
    const gate = deferred();
    from.__rename = from.rename.bind(from);
    from.rename = async (a, b) => { await gate.p; return from.__rename(a, b); };
    const ren = s.renameMedia('library/OLD.BIN', 'NEW.BIN');
    await settle();
    const mv = s.moveMedia(to);
    gate.resolve();
    await Promise.all([ren, mv]);
    check('rename in flight: the moved library has the new name (not the old one)', (await names(to, 'library/')) === 'library/NEW.BIN', await names(to, 'library/'));
    check('rename in flight: the session is on the new place', s.media === to);
  }

  // ---- a delete under way: the file is gone from the moved library, never brought back by the copy ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('GONE.BIN', bin);
    await s.importMedia('KEEP.BIN', bin);
    const gate = deferred();
    from.__remove = from.remove.bind(from);
    from.remove = async (nm) => { await gate.p; return from.__remove(nm); };
    const del = s.deleteMedia('GONE.BIN');
    await settle();
    const mv = s.moveMedia(to);
    gate.resolve();
    await Promise.all([del, mv]);
    check('delete in flight: the moved library has only the file that was kept', (await names(to, 'library/')) === 'library/KEEP.BIN', await names(to, 'library/'));
  }

  // ---- a quick-save slot being written: the slot is in the moved library, with the snapshot the save took ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('dragon64');
    const gate = deferred();
    const slow = slowWrite(from, gate.p);
    const save = s.saveSlot(1);
    await settle();
    const mv = s.moveMedia(to);
    gate.resolve();
    const msg = await save;
    await mv;
    const slots = (await names(to, 'library/snapshots/'));
    check('save in flight: the slot is in the moved library', /^library\/snapshots\/slot-1\./.test(slots) && msg === 'Took snapshot 1', `${slots} | ${msg}`);
    check('save in flight: the slot holds the snapshot (it reads back in the new place)', (await s.listSlots())[0].machine === 'dragon64',
      JSON.stringify((await s.listSlots())[0]));
  }

  // ---- a move during a slow write that FAILS: the move neither hangs nor swallows the error ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('SAFE.BIN', bin);
    const gate = deferred();
    from.__write = from.write.bind(from);
    from.write = async (nm, bytes) => { await gate.p; throw Object.assign(new Error('the folder went away'), { code: 'io' }); };
    const imp = s.importMedia('DOOMED.BIN', bin);
    await settle();
    const mv = s.moveMedia(to);
    await settle();
    gate.resolve();
    const [e, r] = await Promise.all([refuse(imp), refuse(mv)]);
    check('a failing operation: its own caller gets the store\'s error (not a hang, not a swallowed one)',
      e instanceof Emu.SessionError && /the folder went away/.test(e.message), e && e.message);
    check('a failing operation: the move went on and finished (one operation failing is not the move failing)',
      !(r instanceof Error) && s.media === to, r instanceof Error ? r.message : JSON.stringify(r));
    check('a failing operation: what was there before it moves, what it tried to write is in neither place',
      same(await to.read('library/SAFE.BIN'), bin) && !(await to.stat('library/DOOMED.BIN')) && !(await from.stat('library/DOOMED.BIN')));
  }

  // ---- an operation started DURING the move: refused with the same message the Library uses, nothing written to
  // either place, and it works once the move is done ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('BEFORE.BIN', bin);
    const gate = deferred();
    to.__stat = to.stat.bind(to);
    to.stat = async (nm) => { await gate.p; return to.__stat(nm); };   // the copy, held in the new place
    const mv = s.moveMedia(to);
    await settle();
    const tries = await Promise.all([
      s.importMedia('DURING.BIN', bin), s.renameMedia('library/BEFORE.BIN', 'DURING.BIN'), s.deleteMedia('BEFORE.BIN'), s.saveSlot(2),
      s.importDriveWireImage('during.dsk', new Uint8Array(256)),
    ].map(refuse));
    check('during the move: import, rename, delete, save and a DriveWire image are refused, saying the library is being moved',
      tries.every((e) => e instanceof Emu.SessionError && /library is being moved/.test(e.message)), tries.map((e) => (e ? e.message : 'accepted')).join(' | '));
    check('during the move: nothing of them landed in the old place',
      !(await from.stat('library/DURING.BIN')) && !(await from.stat('drivewire/during.dsk')) && !!await from.stat('library/BEFORE.BIN')
      && (await names(from, 'library/')).indexOf('slot-2') < 0, await names(from, 'library/'));
    gate.resolve();
    await mv;
    check('during the move: the moved library is what it was when the move began', (await names(to, 'library/')) === 'library/BEFORE.BIN', await names(to, 'library/'));
    const after = await s.importMedia('DURING.BIN', bin);
    check('during the move: once it is done the same import works, into the new place only', after && same(await to.read('library/DURING.BIN'), bin) && !(await from.stat('library/DURING.BIN')));
  }

  // ---- an operation that never ends: the wait is bounded, the move fails with a message, nothing moves ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from, { mediaMoveWaitMs: 30 });
    await s.importMedia('SAFE.BIN', bin);
    const gate = deferred();   // never resolved
    from.__write = from.write.bind(from);
    from.write = async (nm, bytes) => { await gate.p; return from.__write(nm, bytes); };
    const imp = s.importMedia('STUCK.BIN', bin);
    await settle();
    const started = Date.now();
    const e = await refuse(s.moveMedia(to));
    const took = Date.now() - started;
    check('a stuck operation: the move gives up after its wait and says so', e instanceof Emu.SessionError && /still being written to/.test(e.message), e && e.message);
    check('a stuck operation: it gave up at about the wait (not at once, not never)', took >= 25 && took < 3000, `${took} ms`);
    check('a stuck operation: the session stayed on the old place and nothing was copied', s.media === from && (await to.list('')).length === 0);
    gate.resolve();
    await refuse(imp);
    check('a stuck operation: once it finally ends the move works', !(await refuse(s.moveMedia(to))) && s.media === to && same(await to.read('library/SAFE.BIN'), bin));
  }

  // ---- a disks/ operation never ends (a disks/ rename runs in the drives' write chain, not only in the Library's):
  // the move's wait covers that too, so it gives up with a message rather than hang for good ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from, { mediaMoveWaitMs: 30 });
    await from.write('disks/W.DSK', new Uint8Array(1024));
    await s.importMedia('SAFE.BIN', bin);
    const gate = deferred();   // never resolved
    from.__rename = from.rename.bind(from);
    from.rename = async (a, b) => { await gate.p; return from.__rename(a, b); };
    const ren = s.renameMedia('disks/W.DSK', 'X.DSK');
    await settle();
    const started = Date.now();
    const e = await refuse(s.moveMedia(to));
    check('a stuck disks/ rename: the move gives up after its wait and says so (the drives\' chain is bounded too)',
      e instanceof Emu.SessionError && /drives are still writing/.test(e.message), e && e.message);
    check('a stuck disks/ rename: it gave up at about the wait, and the session stayed on the old place',
      Date.now() - started < 3000 && s.media === from && (await to.list('')).length === 0, `${Date.now() - started} ms`);
    gate.resolve(); await refuse(ren);
    // (the refused operation is the caller's: nothing is left waiting)
    check('a stuck disks/ rename: once it finally ends the move works', !(await refuse(s.moveMedia(to))) && s.media === to);
  }

  // ---- the two waits share ONE deadline. The disks' chain is held for most of the bound and then finishes, and
  // the Library operation never ends: the move must still stop inside the one bound. With a fresh timeout per wait
  // the worst case would be about twice it ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const BOUND = 300;
    const s = await rig(from, { mediaMoveWaitMs: BOUND });
    await from.write('disks/W.DSK', new Uint8Array(1024));
    // the disks' write chain, held until well into the move's wait
    const diskGate = deferred();
    from.__writeRange = from.writeRange.bind(from);
    from.writeRange = async (...a) => { await diskGate.p; return from.__writeRange(...a); };
    s.queueDiskWrite('disks/W.DSK', 0, new Uint8Array([7]), 1024);
    // and a Library operation that never ends, so the second wait is the one that fails
    const opGate = deferred();
    from.__write = from.write.bind(from);
    from.write = async (nm, bytes) => { if (nm === 'library/STUCK.BIN') await opGate.p; return from.__write(nm, bytes); };
    const imp = s.importMedia('STUCK.BIN', bin);
    await settle();
    const started = Date.now();
    const mv = refuse(s.moveMedia(to));
    setTimeout(() => diskGate.resolve(), Math.round(BOUND * 0.67));   // the first wait ends 67% in
    const e = await mv;
    const took = Date.now() - started;
    check('two waits, one deadline: the first wait does not leave the second a fresh full one',
      e instanceof Emu.SessionError && /still being written to/.test(e.message) && took < BOUND * 1.3,
      `${took} ms (one bound ${BOUND}; a fresh timeout per wait would be ~${Math.round(BOUND * 1.67)}): ${e && e.message}`);
    opGate.resolve(); await refuse(imp);
  }

  // ---- a deadline already spent by the first wait, with the second wait's work already settled: the move must
  // still succeed (settled work wins over a 0 ms expiry), or a fast move would fail for having been nearly on time
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from, { mediaMoveWaitMs: 60 });
    await from.write('disks/W.DSK', new Uint8Array(1024));
    await s.importMedia('SAFE.BIN', bin);
    // the disks' chain finishes just inside the bound, so the second wait meets a spent deadline with nothing
    // pending: it must not fail a move that was in time
    from.__writeRange = from.writeRange.bind(from);
    from.writeRange = async (...a) => { await new Promise((r) => setTimeout(r, 55)); return from.__writeRange(...a); };
    s.queueDiskWrite('disks/W.DSK', 0, new Uint8Array([7]), 1024);
    await settle();
    const t = Date.now();
    const e = await refuse(s.moveMedia(to));
    check('a deadline nearly spent by the first wait: the move still completes when nothing else is pending',
      e === null && s.media === to && Date.now() - t < 200, e ? e.message : `${Date.now() - t} ms`);
  }

  // ---- boundedWait when the deadline has already passed: work settled at that point does not fail the wait, and a
  // wait still pending is expired. Pinned directly, without the timing race a whole move would need ----
  {
    const s = await rig();
    const past = Date.now() - 1;
    // it returns nothing (the value is the caller's own promise): what matters is whether it throws
    const settledPast = await s.boundedWait(Promise.resolve(), 'the test wait', past).then(() => 'returned', (e) => e);
    check('boundedWait at a deadline already reached: settled work does not fail', settledPast === 'returned', settledPast && (settledPast.message || settledPast));
    const pending = await s.boundedWait(new Promise(() => {}), 'the test wait', past).then(() => 'returned', (e) => e);
    check('boundedWait at a deadline already reached: a wait still pending expires, with the message',
      pending instanceof Emu.SessionError && /the test wait and did not finish/.test(pending.message), pending && (pending.message || pending));
    const settledNow = await s.boundedWait(Promise.resolve(), 'the test wait', Date.now()).then(() => 'returned', (e) => e);
    check('boundedWait at exactly now: settled work does not fail', settledNow === 'returned', settledNow && (settledNow.message || settledNow));
  }

  // ---- a move that is refused (a disk in a drive) waits for nothing: the operation then runs as usual ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    const gate = deferred();
    const slow = slowWrite(from, gate.p);
    const imp = s.importMedia('ONE.BIN', bin);
    await settle();
    const e = await refuse(s.moveMedia(to));
    check('a refused move: it does not wait for the operation (refused at once)', e instanceof Emu.SessionError);
    gate.resolve();
    await imp;
    check('a refused move: the operation simply finished in the place it started', same(await slow.read('library/ONE.BIN'), bin) && s.media === from);
  }

  // ---- a ROM drop uses the index, which keeps its lists in memory: not while the move copies (the merge takes
  // what the index has when it copies), and one that failed leaves nothing half done ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('dragon64');
    await s.importMedia('HOLD.BIN', bin);   // one file to copy, so the move is held in the new place
    const gate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await gate.p; return to.__write(nm, bytes); };   // the copy, held in the new place
    const mv = s.moveMedia(to);
    await settle();
    const drop = (() => { try { s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }, { name: 'd64_2.rom', bytes: rom(5) }]); return null; } catch (e) { return e; } })();
    check('during the move: a ROM drop that writes the index is refused, as the Library\'s own changes are',
      drop instanceof Emu.SessionError && /library is being moved/.test(drop.message), drop && drop.message);
    gate.resolve();
    await mv;
    const r = s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }, { name: 'd64_2.rom', bytes: rom(5) }]);
    await s.index.flush();
    check('during the move: once it is done the drop works and lands in the new place', r.bootable.includes('dragon64') && !!(await to.stat('roms/sockets.json')));
  }

  // ---- the Library's other store writers, refused while the move copies: a ROM clear and a ROM-pack restore
  // (which write roms/*), a DriveWire mount (which hands the drives the store they then read and write in), and the
  // NitrOS-9 boot/its floppy save (which read the store and mount the image). None may write to the old place
  // after the move began or hand a drive the old store.
  // Which guard refuses each, and which of those guards this review round added. A move already running when the
  // call starts is refused before any await in every case; every guard below except mountDriveWire's re-check
  // predates this round (clearRoms and importRomPack got theirs in d669c7c, mountDriveWire its first in 2bb90bc).
  //
  //   clearRoms, importRomPack   their own first checkNotMoving (predates this round)
  //   mountDriveWire             its FIRST check (predates this round: 2bb90bc). What this round adds is the
  //                              re-check after the mount's awaited stat (js/session.js), which this block cannot
  //                              reach: a move already running is refused by the first check before the stat. That
  //                              re-check is pinned by the in-flight mount case further down ("a mount in flight
  //                              when the move starts")
  //   bootNitros9                the FIRST of its two checks (predates this round, d669c7c). The second is the
  //                              start of its Library operation, after its reads. A move already running when the
  //                              boot starts is refused by the first, which is the case this block sets up; the boot
  //                              caught during its reads, and the move that begins inside the boot's mount, are the
  //                              blocks further down ("bootNitros9's own race")
  //   addAndBootNitros9          its floppy-save check before the write (predates this round); the DriveWire arm
  //                              goes through importDriveWireImage and bootNitros9, both covered above
  //
  // So this block pins that each entry point is closed to a move in progress (mostly by pre-existing guards); the
  // guards this round added are pinned by the in-flight cases below. ----
  {
    const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('coco3');
    s.addRoms([{ name: 'bas13.rom', bytes: rom(7).subarray(0, 0x2000) }, { name: 'extbas11.rom', bytes: rom(9).subarray(0, 0x2000) }]);
    await s.importDriveWireImage('boot.dsk', makeOs9Disk(Emu, { cpu: '6809' }));
    await s.importMedia('HOLD.BIN', bin);   // one file to copy, so the move is held in the new place
    const beforeSockets = JSON.stringify(s.index.sockets);
    const gate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await gate.p; return to.__write(nm, bytes); };
    const mv = s.moveMedia(to);
    await settle();
    const guarded = (fn) => { try { const r = fn(); return r instanceof Promise ? r.then(() => null, (e) => e) : null; } catch (e) { return Promise.resolve(e); } };
    const packs = [{ name: 'cloadm-rompack.json', data: new TextEncoder().encode(JSON.stringify({ format: 'cloadm-rompack', version: 1, sockets: [] })) }];
    const [clear, pack, dwMount, n9boot, n9add] = await Promise.all([
      guarded(() => s.clearRoms()),
      guarded(() => s.importRomPack(packs)),
      guarded(() => s.mountDriveWire(0, 'boot.dsk')),
      guarded(() => s.bootNitros9('boot.dsk', 'drivewire')),
      guarded(() => s.addAndBootNitros9('floppy.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' }))),
    ]);
    const all = [clear, pack, dwMount, n9boot, n9add];
    check('during the move: clearRoms, a ROM-pack restore, a DriveWire mount, a NitrOS-9 boot and its floppy save are refused, saying the library is being moved',
      all.every((e) => e instanceof Emu.SessionError && /library is being moved/.test(e.message)), all.map((e) => (e ? e.message : 'accepted')).join(' | '));
    check('during the move: none of them changed the index or mounted anything',
      JSON.stringify(s.index.sockets) === beforeSockets && s.driveWireMounts.length === 0 && s.diskStatus().drives.length === 0,
      `sockets unchanged=${JSON.stringify(s.index.sockets) === beforeSockets} DriveWire mounts=${(s.drivewire.mounts || []).length} disks=${s.diskStatus().drives.length}`);
    check('during the move: nothing of them is in the old place either', !(await from.stat('disks/floppy.dsk')) && !!(await from.stat('drivewire/boot.dsk')));
    gate.resolve();
    await mv;
    const remount = await refuse(s.mountDriveWire(0, 'boot.dsk'));
    check('during the move: once it is done the mount and the boot work, on the new store',
      remount === null && s.drivewire.store === to && s.driveWireMounts.length === 1);
  }

  // ---- a DriveWire mount whose stat is in flight when a move starts: the guard's first check passed before the
  // move began, and the drive would otherwise come out of the mount onto the old store. The re-check after the
  // await ejects it and refuses, so nothing is left mounted mid-copy ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importDriveWireImage('boot.dsk', new Uint8Array(512));
    await s.importMedia('HOLD.BIN', bin);
    // the server's stat of the image, held: the mount is inside drivewire.mount when the move starts
    const gate = deferred();
    from.__stat = from.stat.bind(from);
    from.stat = async (nm) => { if (nm === 'drivewire/boot.dsk') await gate.p; return from.__stat(nm); };
    const mount = s.mountDriveWire(0, 'boot.dsk').then(() => 'mounted', (e) => e);
    await settle();
    // and the copy held in the new place, so the move is still running when the mount's stat returns
    const copyGate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
    const mv = refuse(s.moveMedia(to));
    await settle();
    gate.resolve();                       // the mount resumes while the move copies
    await settle();
    const mres = await mount;
    copyGate.resolve();
    const mverr = await mv;
    check('a mount in flight when the move starts: refused with the moving message (its first guard ran too early)',
      mres instanceof Emu.SessionError && /library is being moved/.test(mres.message), mres && (mres.message || mres));
    check('a mount in flight when the move starts: nothing is left mounted, and the move completes',
      !(mverr instanceof Error) && (s.drivewire.mounts || []).length === 0, `${mverr && mverr.message} mounts=${JSON.stringify(s.drivewire.mounts)}`);
  }

  // ---- a guest's named-object mount/create while the move copies: the server asks the host before touching the
  // store, and is answered "no such object" (0). The refusal has to be distinguishable from "not found", which the
  // same reply would give for a different reason: the test reads the host's answer directly (`mayWrite`), and takes
  // a control run just after the move, where the same request is answered with a drive ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('HOLD.BIN', bin);
    await from.write('drivewire/OLD', new Uint8Array(256));
    const srv = s.drivewire;
    // the host's gate is the evidence: during the copy it says no, and before/after it says yes
    check('the guest store gate: open with no move running', srv.mayWrite() === true);
    // count the store stats: the ENTRY check must refuse before the server ever asks the store (otherwise the
    // post-stat check would also refuse it, and this case would pass with the entry check gone)
    let stats = 0;
    from.__stat = from.stat.bind(from);
    from.stat = async (nm) => { stats++; return from.__stat(nm); };
    const copyGate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
    const mv = refuse(s.moveMedia(to));
    await settle();
    check('the guest store gate: closed while the library is copied', s.movingMedia === true && srv.mayWrite() === false);
    // and the request made then is answered 0 with nothing mounted, and never reached the store
    for (const b of [0x01, 3, 0x4F, 0x4C, 0x44]) srv.receive(b);
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    const during = srv.output.splice(0);
    check('a guest NAMEOBJ_MOUNT while the move copies: answered 0, no drive handed out, the store never asked',
      JSON.stringify(during) === '[0]' && srv.drives.size === 0 && stats === 0,
      JSON.stringify({ out: during, drives: [...srv.drives], stats }));
    copyGate.resolve(); await mv;
    check('the guest store gate: open again once the move is done', srv.mayWrite() === true);
    // control: the same request with no move running is answered with a drive
    for (const b of [0x01, 3, 0x4F, 0x4C, 0x44]) srv.receive(b);
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    const after = srv.output.splice(0);
    check('control: the same mount after the move is answered with a drive', after.length === 1 && after[0] >= 1 && srv.drives.size === 1,
      JSON.stringify({ after, drives: [...srv.drives] }));
  }

  // ---- a guest mount that started BEFORE the move and whose stat is still pending when the copy begins: the host's
  // gate was open when it was accepted, and the stat resolves against the old store. A mount hands the guest a drive
  // it then writes through, so it must be refused like a create - `mayWrite` is checked again after the stat, both
  // arms. Without it the guest is answered with a drive and its writes land in the old place mid-copy ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('HOLD.BIN', bin);
    await from.write('drivewire/OLD', new Uint8Array(256));
    const srv = s.drivewire;
    // the guest's mount, accepted while no move runs; the store's stat of the name is held
    const statGate = deferred();
    from.__stat = from.stat.bind(from);
    from.stat = async (nm) => { if (nm === 'drivewire/OLD') await statGate.p; return from.__stat(nm); };
    for (const b of [0x01, 3, 0x4F, 0x4C, 0x44]) srv.receive(b);   // NAME "OLD"
    await settle();
    check('a guest mount in flight: it is inside its stat, nothing answered yet', srv.output.length === 0);
    // the move starts and is held in its copy, then the mount's stat returns
    const copyGate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
    const mv = refuse(s.moveMedia(to));
    await settle();
    statGate.resolve();
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    check('a guest mount whose stat returns mid-copy: answered 0 (no drive handed out from the old store)',
      JSON.stringify(srv.output.splice(0)) === '[0]' && srv.drives.size === 0, JSON.stringify([...srv.drives]));
    copyGate.resolve(); await mv;
    // control: the same mount with no move running is answered with a drive
    for (const b of [0x01, 3, 0x4F, 0x4C, 0x44]) srv.receive(b);
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    const after = srv.output.splice(0);
    check('control: the same in-flight mount after the move is answered with a drive', after.length === 1 && after[0] >= 1 && srv.drives.size === 1,
      JSON.stringify({ after, drives: [...srv.drives] }));
  }

  // ---- a guest CREATE whose store write is in flight when a move starts. The create is one Library operation that
  // also hands the guest its drive, so the move waits for it, and then finds that drive mounted on the store it is
  // about to leave: the move is refused (nothing copied, the session where it was) and the guest keeps a drive on
  // the store the session still uses. The exact sequence: the create registers its operation; the move starts
  // while its write is pending and passes its first busy check (no drive yet); the move waits for the operation;
  // the write lands and the drive is handed out; the move's re-check after the wait refuses. Before this, the drive
  // was handed out after the operation had settled, the move copied anyway, and the guest's later writes through
  // that drive went to the old store, lost after the switch. Run twice: as the Session wires it, and with the
  // host's operation answering its caller a turn late (after the move has seen it settle), which is what pins that
  // the drive is handed out INSIDE the operation and not by the caller once it resumes: with the wiring alone, the
  // microtask order happens to let the caller resume first. ----
  for (const late of [false, true]) {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('HOLD.BIN', bin);
    const srv = s.drivewire;
    if (late) srv.openLibraryOp = (run) => s.libraryOp(run).then(async (v) => { await settle(); return v; });
    const check = (name, cond, detail) => checkOuter(`${late ? '[caller resumes late] ' : ''}${name}`, cond, detail);
    const writeGate = deferred();
    let copiedWrites = 0;
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { copiedWrites++; return to.__write(nm, bytes); };
    from.__write = from.write.bind(from);
    from.write = async (nm, bytes) => { if (nm === 'drivewire/NEW') await writeGate.p; return from.__write(nm, bytes); };
    for (const b of [0x02, 3, 0x4E, 0x45, 0x57]) srv.receive(b);   // CREATE "NEW"
    await settle();
    check('create in flight: the create is inside its write (its Library operation registered), nothing answered yet',
      srv.output.length === 0 && s.movingOps.size === 1);
    const mv = refuse(s.moveMedia(to));
    await settle();
    check('create in flight: the move passed its first busy check and is waiting for the create',
      s.movingMedia === true && srv.drives.size === 0 && s.media === from);
    writeGate.resolve();                  // the write lands; the create hands out its drive inside its operation
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    const mverr = await mv;
    const out = srv.output.splice(0);
    check('create in flight: the guest was answered with its drive, on the store the session still uses',
      out.length === 1 && out[0] >= 1 && srv.drives.size === 1 && srv.drives.get(out[0]).name === 'drivewire/NEW' && !!(await from.stat('drivewire/NEW')),
      JSON.stringify({ out, drives: [...srv.drives] }));
    check('create in flight: the move was refused after its wait, naming the guest\'s drive',
      mverr instanceof Emu.SessionError && /Eject the disks first/.test(mverr.message) && mverr.message.includes(`DriveWire drive ${out[0]}: NEW`),
      mverr ? mverr.message : 'the move succeeded');
    check('create in flight: nothing was copied, and the session stayed on the old store, no longer moving',
      copiedWrites === 0 && (await to.list('')).length === 0 && s.media === from && srv.store === from && s.movingMedia === false,
      JSON.stringify({ copiedWrites, inNew: await names(to), onOld: s.media === from }));
    // the guest's write through its drive lands where the session keeps its library
    const sector = Uint8Array.from({ length: 256 }, (_, i) => i ^ 0x5A);
    await srv.store.writeRange('drivewire/NEW', 0, sector);
    check('create in flight: what the guest writes through the drive is in the store the session uses',
      same((await s.media.read('drivewire/NEW')).subarray(0, 256), sector));
    // control: with the guest's drive released, the same move goes through and carries the object
    srv.eject(out[0]);
    const r = await refuse(s.moveMedia(to));
    check('control: with the drive released, the move succeeds and the object (with the guest\'s write) moves',
      !(r instanceof Error) && s.media === to && same((await to.read('drivewire/NEW')).subarray(0, 256), sector), r && r.message);
  }
  // ---- the other order of the same race: the create's write FAILS while the move waits for it. The create then
  // hands out no drive (answered 0), so the move's re-check finds nothing mounted and the move goes through. ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    await s.importMedia('HOLD.BIN', bin);
    const srv = s.drivewire;
    const writeGate = deferred();
    from.__write = from.write.bind(from);
    from.write = async (nm, bytes) => {
      if (nm === 'drivewire/NEW') { await writeGate.p; throw Object.assign(new Error('the store is full'), { code: 'quota' }); }
      return from.__write(nm, bytes);
    };
    for (const b of [0x02, 3, 0x4E, 0x45, 0x57]) srv.receive(b);   // CREATE "NEW"
    await settle();
    const mv = refuse(s.moveMedia(to));
    await settle();
    check('create failing in flight: the move is waiting for it', s.movingMedia === true && srv.output.length === 0);
    writeGate.resolve();
    for (let k = 0; k < 200 && srv.busy; k++) await srv.busy;
    const r = await mv;
    const out = srv.output.splice(0);
    check('create failing in flight: the guest is answered 0 and no drive is handed out',
      JSON.stringify(out) === '[0]' && srv.drives.size === 0, JSON.stringify({ out, drives: [...srv.drives] }));
    check('create failing in flight: the move then goes through, carrying the library',
      !(r instanceof Error) && s.media === to && srv.store === to && same(await to.read('library/HOLD.BIN'), bin) && !(await to.stat('drivewire/NEW')),
      r && r.message);
  }

  // ---- bootNitros9's own race: it reads the image, awaits, and only then changes the machine and mounts. A move
  // that begins while those reads are in flight refuses the boot at its post-reads check, before anything has
  // changed (the switch, the controller, the drives, the Becker link, the debugger, the welcome menu's stub run are
  // all as they were). Past that check the rest of the boot is one Library operation: a move that begins inside its
  // mount waits for it, then finds drive 0 mounted and is refused itself, so a boot is never left half done. ----
  {
    const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
    // a DriveWire boot, which would switch the machine to turn the Becker port on (and with it start the link over)
    {
      const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
      const s = await rig(from);
      s.switchMachine('coco3');
      await s.importDriveWireImage('boot.dsk', makeOs9Disk(Emu, { cpu: '6809' }));
      await s.importMedia('HOLD.BIN', bin);
      const wasMachine = s.shownMachine;
      s.drivewire.output.push(0xA5);        // a byte for the guest on the link: a switch to the Becker port drops it
      // bootNitros9's first awaited read, held: the boot is inside its reads while the move starts
      const gate = deferred();
      from.__read = from.read.bind(from);
      from.read = async (nm) => { if (/^drivewire\//.test(nm)) await gate.p; return from.__read(nm); };
      const boot = s.bootNitros9('boot.dsk', 'drivewire').then(() => null, (e) => e);
      await settle();
      // the copy held in the new place too: the move is provably still running when the boot's read returns
      const copyGate = deferred();
      to.__write = to.write.bind(to);
      to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
      const mv = s.moveMedia(to);
      await settle();
      check('a boot whose reads are in flight when the move starts: the move is still copying when the read returns',
        s.movingMedia === true && s.driveWireMounts.length === 0, `moving=${s.movingMedia} mounts=${JSON.stringify(s.driveWireMounts)}`);
      gate.resolve();
      await settle();
      const e = await boot;
      copyGate.resolve();
      const mvRes = await mv.then(() => null, (x) => x);
      check('a boot whose reads are in flight when the move starts: refused, saying the library is being moved',
        e instanceof Emu.SessionError && /library is being moved/.test(e.message), e ? e.message : 'accepted');
      check('a boot whose reads are in flight when the move starts: nothing was mounted, and the move completed',
        !(mvRes instanceof Error) && s.driveWireMounts.length === 0, `${mvRes && mvRes.message} mounts=${JSON.stringify(s.driveWireMounts)}`);
      check('a boot whose reads are in flight when the move starts: the machine was not switched, and the link kept its state',
        s.shownMachine === wasMachine && !s.shownMachine.config.becker && JSON.stringify(s.drivewire.output) === '[165]',
        `same=${s.shownMachine === wasMachine} becker=${s.shownMachine.config.becker} output=${JSON.stringify(s.drivewire.output)}`);
      s.drivewire.output.length = 0;
    }
    // a floppy boot that also has to turn the Becker port on: the switch comes first, then the controller goes in,
    // then mountDisk refuses - so without the post-reads check the machine is left switched and with a cartridge
    // that were not there, although the boot was refused. The boot must be refused with the machine exactly as it was.
    {
      const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
      const s = await rig(from);
      s.switchMachine('coco3');
      // the image in the store (importDisk would want a disk ROM to mount it; the boot reads the store itself)
      await from.write('disks/floppy.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' }));
      await s.importMedia('HOLD.BIN', bin);
      // what a switch would throw away, set up so a refused boot can be seen not to have touched it: a breakpoint,
      // the debugger paused, the welcome menu's stub run
      const dbg = s.debug;
      dbg.addBreakpoint(0x1234);
      dbg._stop('break', { pc: s.shownMachine.cpu.pc });
      s.inject([{ addr: 0x3000, data: new Uint8Array([0x20, 0xFE]) }], 0x3000);   // a stub program (BRA *)
      const stub = s.stubRun;
      const was = { machine: s.shownMachine, profile: s.shownMachine.id, cpu: s.shownMachine.config.cpu, becker: s.shownMachine.config.becker, cart: s.shownMachine.cartPort };
      check('a floppy boot whose reads are in flight: the machine is not yet set up to boot it (the switch and the controller come after the reads)',
        was.profile === 'coco3' && was.becker === false && s.diskController === null, `${was.profile} becker=${was.becker} controller=${!!s.diskController}`);
      // the boot's awaited read of the floppy image, held
      const gate = deferred();
      from.__read = from.read.bind(from);
      from.read = async (nm) => { if (/^disks\//.test(nm)) await gate.p; return from.__read(nm); };
      const boot = s.bootNitros9('floppy.dsk', 'disk').then(() => null, (e) => e);
      await settle();
      // the copy held in the new place too: the move is provably still running when the boot's read returns
      const copyGate = deferred();
      to.__write = to.write.bind(to);
      to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
      const mv = s.moveMedia(to);
      await settle();
      check('a floppy boot whose reads are in flight: the move is still copying when the read returns',
        s.movingMedia === true, `moving=${s.movingMedia}`);
      gate.resolve();
      await settle();
      const e = await boot;
      copyGate.resolve();
      const mvRes = await mv.then(() => null, (x) => x);
      check('a floppy boot whose reads are in flight when the move starts: refused, saying the library is being moved',
        e instanceof Emu.SessionError && /library is being moved/.test(e.message), e ? e.message : 'accepted');
      // the machine is unchanged: same machine object, same CPU and Becker setting, no cartridge plugged in, no drive
      check('a refused floppy boot: the machine is exactly as it was (not switched, no controller in the port)',
        s.shownMachine === was.machine && s.shownMachine.id === was.profile && s.shownMachine.config.cpu === was.cpu &&
          s.shownMachine.config.becker === was.becker && s.shownMachine.cartPort === was.cart &&
          s.diskStatus().drives.length === 0,
        `same machine=${s.shownMachine === was.machine} profile=${s.shownMachine.id}/${was.profile} cpu=${s.shownMachine.config.cpu}/${was.cpu} becker=${s.shownMachine.config.becker}/${was.becker} cart=${!!s.shownMachine.cartPort} drives=${s.diskStatus().drives.length} | ${mvRes && mvRes.message}`);
      check('a refused floppy boot: the debugger kept its breakpoint and stays paused, and the welcome menu\'s stub run is kept',
        s.debugger === dbg && dbg.breakpoints().join() === String(0x1234) && s.paused === true && stub !== null && s.stubRun === stub,
        `same debugger=${s.debugger === dbg} bps=${dbg.breakpoints()} paused=${s.paused} stub=${stub !== null}/${s.stubRun === stub}`);
    }
    // the same race one step later: the boot has passed its post-reads check, so it has begun its Library operation
    // and already rebuilt the machine, and the move begins inside the mount's own awaited stat. The move waits for
    // the boot, which completes (drive 0 mounted, NitrOS-9 starting), and is then refused, naming the drive: nothing
    // copied, the session on the store the boot's drive uses. One case per kind of boot.
    for (const kind of ['floppy', 'drivewire']) {
      const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
      const s = await rig(from);
      s.switchMachine('coco3');
      const image = kind === 'floppy' ? 'disks/floppy.dsk' : 'drivewire/boot.dsk';
      await from.write(image, kind === 'floppy'
        ? makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' })
        : makeOs9Disk(Emu, { cpu: '6809' }));
      await s.importMedia('HOLD.BIN', bin);
      const was = s.shownMachine;
      // the mount's own stat of the image (not the boot's read) is held: the boot is past its post-reads check
      const statGate = deferred();
      let heldStat = false;
      from.__stat = from.stat.bind(from);
      from.stat = async (nm) => { if (nm === image && !heldStat) { heldStat = true; await statGate.p; } return from.__stat(nm); };
      let copiedWrites = 0;
      to.__write = to.write.bind(to);
      to.write = async (nm, bytes) => { copiedWrites++; return to.__write(nm, bytes); };
      const boot = s.bootNitros9(image.split('/')[1], kind === 'floppy' ? 'disk' : 'drivewire').then((m) => m, (e) => e);
      await settle();
      check(`[${kind}, inside the mount] the boot has rebuilt the machine and is inside its mount's stat`,
        s.shownMachine !== was && heldStat && (kind === 'floppy' ? !!s.diskController : s.shownMachine.config.becker === true),
        `switched=${s.shownMachine !== was} held=${heldStat}`);
      const mv = refuse(s.moveMedia(to));
      await settle();
      check(`[${kind}, inside the mount] the move is waiting for the boot`, s.movingMedia === true && s.media === from);
      statGate.resolve();                    // the mount resumes; the move is still waiting for the boot
      const msg = await boot;
      const mvRes = await mv;
      check(`[${kind}, inside the mount] the boot completed: NitrOS-9 is starting from drive 0`,
        typeof msg === 'string' && /^Booting NitrOS-9/.test(msg) && s.nitros9Running &&
          (kind === 'floppy' ? s.diskStatus().drives.some((d) => d.drive === 0) : s.driveWireMounts.some((d) => d.drive === 0)),
        msg instanceof Error ? msg.message : msg);
      check(`[${kind}, inside the mount] the move was then refused, naming drive 0`,
        mvRes instanceof Emu.SessionError && /Eject the disks first \((DriveWire )?drive 0: /.test(mvRes.message), mvRes ? mvRes.message : 'the move succeeded');
      check(`[${kind}, inside the mount] nothing was copied, and the session stayed on the store the drive uses`,
        copiedWrites === 0 && s.media === from && s.movingMedia === false && (kind === 'floppy' || s.drivewire.store === from),
        JSON.stringify({ copiedWrites, onOld: s.media === from }));
    }
  }

  // ---- the mounts' move checks cannot be skipped from outside: bootNitros9 runs its mount inside its own Library
  // operation with a module-private key, and nothing an embedder can pass (such as { held: true }) does the same ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('coco3');
    s.switchMachine('coco3', Object.assign({}, s.shownMachine.config, { becker: true }));
    await s.importDriveWireImage('pub.dsk', new Uint8Array(512));
    await from.write('disks/pub.dsk', new Uint8Array(161280));
    await s.importMedia('HOLD.BIN', bin);
    const copyGate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await copyGate.p; return to.__write(nm, bytes); };
    const mv = refuse(s.moveMedia(to));
    await settle();
    const dw = await refuse(s.mountDriveWire(0, 'pub.dsk', { held: true }));
    const fd = await refuse(s.mountDisk(0, 'pub.dsk', { held: true }));
    check('a public mountDriveWire with { held: true } during a move: still refused, nothing mounted',
      dw instanceof Emu.SessionError && /library is being moved/.test(dw.message) && s.driveWireMounts.length === 0, dw ? dw.message : 'mounted');
    check('a public mountDisk with { held: true } during a move: still refused',
      fd instanceof Emu.SessionError && /library is being moved/.test(fd.message), fd ? fd.message : 'mounted');
    copyGate.resolve();
    check('the move then completes', !(await mv) && s.media === to);
  }

  // ---- addAndBootNitros9: a move that begins after the image is saved refuses the boot, and the message says the
  // image was kept (as importDisk does for its mount), for either kind of image ----
  {
    const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
    for (const kind of ['floppy', 'drivewire']) {
      const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
      const s = await rig(from);
      s.switchMachine('coco3');
      await s.importMedia('HOLD.BIN', bin);
      const file = `${kind}9.dsk`, stored = (kind === 'floppy' ? 'disks/' : 'drivewire/') + file;
      const bytes = kind === 'floppy'
        ? makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' })
        : makeOs9Disk(Emu, { cpu: '6809' });
      // the save is held, the move starts (it waits for the save), the save lands: the boot then meets the move
      const writeGate = deferred();
      from.__write = from.write.bind(from);
      from.write = async (nm, b) => { if (nm === stored) await writeGate.p; return from.__write(nm, b); };
      const copyGate = deferred();
      to.__write = to.write.bind(to);
      to.write = async (nm, b) => { await copyGate.p; return to.__write(nm, b); };
      const was = s.shownMachine;
      const boot = refuse(s.addAndBootNitros9(file, bytes));
      await settle();
      const mv = refuse(s.moveMedia(to));
      await settle();
      writeGate.resolve();
      const e = await boot;
      check(`[${kind}] addAndBootNitros9 refused by a move begun after its save: says the image was saved`,
        e instanceof Emu.SessionError && e.message === `${file} was saved to your Library but not booted: The library is being moved: try again once it is done.`,
        e ? e.message : 'booted');
      check(`[${kind}] ...and it was: the image is stored, the machine untouched`,
        same(await from.read(stored), bytes) && s.shownMachine === was && s.driveWireMounts.length === 0);
      copyGate.resolve();
      const r = await mv;
      check(`[${kind}] ...and the move carries it`, !r && s.media === to && same(await to.read(stored), bytes), r && r.message);
    }
  }

  // ---- a program loaded while the move copies: it loads and runs, its recent-list entry is written when the move
  // is done, into the new place (nothing goes to the old one after the move began) ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('dragon64');
    await s.importMedia('HOLD.BIN', bin);
    const gate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => { await gate.p; return to.__write(nm, bytes); };
    const mv = s.moveMedia(to);
    await settle();
    const msg = s.load('DURING.BIN', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 1, 0x30, 0x00, 0xAA, 0x39]));
    check('a load during the move: the program loads at once', /binary/.test(msg), msg);
    check('a load during the move: its entry is in this visit\'s list already', s.recentMedia()[0].name === 'DURING.BIN');
    check('a load during the move: nothing of it is written to the old place', !(await from.stat('recent/list.json')));
    gate.resolve();
    await mv;
    await s.index.flush();
    const stored = JSON.parse(new TextDecoder().decode(await to.read('recent/list.json')));
    check('a load during the move: once it is done the recent list is written to the new place, with the entry',
      stored[0].name === 'DURING.BIN' && stored[0].stored === true && (await to.list('recent/')).some((f) => /^recent\/[0-9A-F]+\.bin$/.test(f.name)), JSON.stringify(stored));
    check('a load during the move: the old place never got the list', !(await from.stat('recent/list.json')));
  }

  // ---- a program loaded during a move into a new place with no room: the entry says its bytes were not kept (the
  // deferred write finds the full store, as the immediate path does), so the Media tab does not claim what is not
  // there ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = await rig(from);
    s.switchMachine('dragon64');
    await s.importMedia('HOLD.BIN', bin);
    const gate = deferred();
    to.__write = to.write.bind(to);
    to.write = async (nm, bytes) => {
      await gate.p;
      if (/^recent\/[0-9A-F]+\.bin$/.test(nm)) throw Object.assign(new Error('no room'), { code: 'quota' });
      return to.__write(nm, bytes);
    };
    // the index of a store whose bytes are in memory writes synchronously (MediaIndex.writeSync): the same refusal
    to.__writeSync = to.writeSync.bind(to);
    to.writeSync = (nm, bytes) => {
      if (/^recent\/[0-9A-F]+\.bin$/.test(nm)) throw Object.assign(new Error('no room'), { code: 'quota' });
      return to.__writeSync(nm, bytes);
    };
    const mv = s.moveMedia(to);
    await settle();
    s.load('DUR.BIN', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 1, 0x30, 0x00, 0xAA, 0x39]));
    gate.resolve();
    await mv;
    await settle();
    const e = s.recentMedia()[0];
    check('a load into a full new place: the entry says its bytes were not kept', e.name === 'DUR.BIN' && e.stored === false, JSON.stringify(e));
    check('a load into a full new place: the list on disk says so too, and holds no blob it could not write',
      JSON.parse(new TextDecoder().decode(await to.read('recent/list.json')))[0].stored === false && !(await to.list('recent/')).some((f) => /\.bin$/.test(f.name)));
  }
})().then(() => {
  console.log(`${n - fail}/${n} move-in-flight checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL move in flight ${e.stack}`); process.exitCode = 1; });
