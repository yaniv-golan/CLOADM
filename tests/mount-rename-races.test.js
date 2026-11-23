// The Library and the drives changing one stored disk image at once.
//
// A stored disk image is a file two things write: the Library (an import, a rename, a new blank disk) and the drive
// that has it mounted (its sectors, on its own chain). Each of the three below was a real hole on main; each test
// holds the loser of the race inside the exact await where the check had already passed, so what is asserted is the
// ordering, not a lucky schedule.
//
//   3. renameMedia checked only that the SOURCE was not in a drive. A rename onto a name an in-flight newDisk (or
//      import) was creating therefore landed after that creation's lookup and before its write, and the creation's
//      write replaced the renamed image: the renamed image was GONE and the creation reported success. Refused now.
//   4. The DriveWire server a real CoCo is served from (serveRealCoco) and the chat's (startChat's chatServer) were
//      each built with the Session's store at the moment they were made, and moveMedia retargets only
//      Session.drivewire. After a move they read and wrote the OLD place, out of sight of the new one.
//   5. DriveWireServer.mount asked whether another drive held the image, then awaited the store's stat, then claimed
//      its drive. A guest's named-object mount and the user's mount in that window left TWO drives on one image --
//      the very thing the guard exists to refuse (two drives on one file overwrite each other's sectors).
//
// Every expected value is built here (an image from tools/mame-diff/fdc/images.js, a blank from Emu.blankDisk) or
// read off the store; none is produced by running the code under test to see what it says.
//
// Run: node tests/mount-rename-races.test.js
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');
const { DriveWireServer } = require('../js/drivewire/server.js');
const images = require('../tools/mame-diff/fdc/images');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const q = (p) => p.then((m) => ({ ok: true, m }), (e) => ({ ok: false, m: e.message }));
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const read = async (media, name) => media.read(name).catch(() => null);   // null when it is not there
const tick = () => new Promise((r) => setImmediate(r));
const session = async (media) => { const s = new Emu.Session({ media }); s.switchMachine('dgnalpha'); await s.ready(); return s; };
// an image whose bytes are all its own (the pattern names track, side and sector; different sizes differ everywhere)
const A = () => images.vdk(40, 1), B = () => images.vdk(26, 1);

(async () => { try {
  // ---------------- 3. a rename may not take a name a creation is making ----------------
  // The creation's name is checked, then it WAITS on the disk chain (diskWritesDone) before it writes -- a real await
  // a drive's own write can hold open. A rename that lands inside that wait takes the name first, and the creation's
  // write then replaces the renamed image: main ended with the blank under that name, the imported image gone, and
  // both operations reporting success. The chain is held with a change of an unrelated image, so every disks/ change
  // made in the window queues behind it; then the rename and the creation run in the order they were asked, which is
  // the rename's advantage.
  {
    const media = new MemoryMediaStore();
    const s = await session(media);
    const keep = A();
    await media.writeSync('disks/keep.vdk', keep);
    let release = null;
    s.diskStoreChange(() => new Promise((r) => { release = () => r({ name: 'disks/hold', size: 0, mtime: 0 }); }), 'disks/hold');
    const nd = s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 });   // picks disk-1.vdk, parks on the chain
    for (let i = 0; i < 50; i++) await tick();
    const ren = q(s.library.renameMedia('disks/keep.vdk', 'disks/disk-1.vdk'));  // asked inside that wait
    for (let i = 0; i < 50; i++) await tick();
    release();
    const [rn, ndr] = [await ren, await q(nd)];
    const blank = Emu.blankDisk('vdk', 40, 1);
    check('3. a rename onto the name a new disk is creating is refused',
      !rn.ok && /being made under that name/.test(rn.m), rn.m || 'allowed');
    check('3. ... the new disk is made under the name it chose, with the blank image as stored',
      ndr.ok && ndr.m === 'New blank disk: disk-1.vdk in drive 0' && same(await read(media, 'disks/disk-1.vdk'), blank), ndr.m);
    // the proof of the hole: on main this is GONE -- the blank was written over the renamed image
    check('3. ... and the image the rename named is still there, under its own name and bytes',
      same(await read(media, 'disks/keep.vdk'), keep),
      `keep.vdk=${(await read(media, 'disks/keep.vdk')) ? 'present' : 'GONE'} stored=${JSON.stringify((await media.list('disks/')).map((f) => f.name))}`);
  }
  {
    // the same through importMedia (the library's drop): an image named fresh.vdk, held on the chain
    const media = new MemoryMediaStore();
    const s = await session(media);
    const keep = B(), fresh = A();
    await media.writeSync('disks/keep.vdk', keep);
    let release = null;
    s.diskStoreChange(() => new Promise((r) => { release = () => r({ name: 'disks/hold', size: 0, mtime: 0 }); }), 'disks/hold');
    const im = s.library.importMedia('fresh.vdk', fresh);
    for (let i = 0; i < 50; i++) await tick();
    const ren = q(s.library.renameMedia('disks/keep.vdk', 'disks/fresh.vdk'));
    for (let i = 0; i < 50; i++) await tick();
    release();
    const [rn, imr] = [await ren, await q(im)];
    check('3. a rename onto the name an import is making is refused too',
      !rn.ok && /being made under that name/.test(rn.m), rn.m || 'allowed');
    check('3. ... the import keeps its name and bytes, and the other image is untouched',
      imr.ok && same(await read(media, 'disks/fresh.vdk'), fresh) && same(await read(media, 'disks/keep.vdk'), keep),
      `${imr.ok ? 'import ok' : imr.m} keep.vdk=${(await read(media, 'disks/keep.vdk')) ? 'present' : 'GONE'}`);
  }
  {
    // a rename onto a name no creation is making is still an ordinary rename (the guard is not a refusal of
    // renames onto creation names in general): after the creation has finished, the name is simply taken
    const media = new MemoryMediaStore();
    const s = await session(media);
    await media.writeSync('disks/keep.vdk', A());
    const nd = await q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'later.vdk' }));
    await s.ejectDisk(0);
    const rn = await q(s.library.renameMedia('disks/keep.vdk', 'disks/later.vdk'));
    check('3. ... but a rename onto a name that is no longer in flight is refused as taken, not as in use',
      nd.ok && !rn.ok && /already/i.test(rn.m), `${nd.m} | ${rn.m}`);
  }
  {
    // A rename queued behind a creation that FAILS still runs: the creation's turn ends however it ends (refused by
    // the store, a mount that fails), and the rename is next. Otherwise one refused import would hold every later
    // rename for the session. (A creation AHEAD that never ends -- a store that stops answering -- holds it, as it
    // holds every creation: there is no deadline on a turn, by design; see createExclusive.)
    const media = new MemoryMediaStore();
    const s = await session(media);
    await media.writeSync('disks/keep.vdk', A());
    const realWrite = media.write.bind(media);
    media.write = (n, b) => (n === 'disks/never.vdk' ? Promise.reject(new MediaStoreError('quota', 'no space (forced)')) : realWrite(n, b));
    const im = q(s.library.importMedia('never.vdk', B()));            // refused at its store write
    const rn = q(s.library.renameMedia('disks/keep.vdk', 'disks/moved.vdk'));   // queued behind it
    const [imr, rnr] = [await im, await rn];
    check('3. a rename queued behind a creation that the store refused still runs',
      !imr.ok && rnr.ok && same(await read(media, 'disks/moved.vdk'), A()), `${imr.ok ? 'import ok' : imr.m} | ${rnr.ok ? 'rename ok' : rnr.m}`);
    // and a rename of a disk a drive holds is refused at once, before any turn is taken (the drive writes it)
    media.write = realWrite;
    const held = await q(s.importDisk('busy.vdk', B(), 0));
    const rn2 = await q(s.library.renameMedia('disks/busy.vdk', 'disks/elsewhere.vdk'));
    check('3. ... and a rename of a disk a drive holds is refused, naming the drive, with no waiting',
      held.ok && /is in drive 0; eject it before you rename it/.test(rn2.m), rn2.m || 'allowed');
  }
  {
    // The other order: the RENAME is asked first. On main the rename's check passed, its rename queued behind the
    // drives' writes, and a creation asked in the gap then chose that name from a listing that could not see the
    // queued rename, and its write landed over the renamed image. Both must be decided on the disk chain, in the
    // order they were queued: the rename runs, then the creation finds the name taken and refuses. The renamed bytes
    // stay under their new name and the blank is never written.
    const media = new MemoryMediaStore();
    const s = await session(media);
    const keep = A();
    await media.writeSync('disks/keep.vdk', keep);
    let release = null;
    s.diskStoreChange(() => new Promise((r) => { release = () => r({ name: 'disks/hold', size: 0, mtime: 0 }); }), 'disks/hold');
    const ren = q(s.library.renameMedia('disks/keep.vdk', 'disks/disk-1.vdk'));   // asked first; queues behind the hold
    for (let i = 0; i < 20; i++) await tick();
    const nd = s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 });     // asked second; its listing cannot see the queued rename
    for (let i = 0; i < 20; i++) await tick();
    release();
    const [rn, ndr] = [await ren, await q(nd)];
    const blank = Emu.blankDisk('vdk', 40, 1);
    check('3. rename asked first: it takes the name', rn.ok, rn.m || 'refused');
    // the creation behind it runs after the rename has LANDED (both are creations now), so its listing sees disk-1
    // and it takes the next free name. The hole was it writing over disk-1 from a stale listing.
    check('3. ... and the new disk asked behind it goes to the next free name, never over the renamed image',
      ndr.ok && ndr.m === 'New blank disk: disk-2.vdk in drive 0', ndr.m || 'refused');
    check('3. ... so the renamed image is still under disk-1 with its own bytes, and the blank is under disk-2',
      same(await read(media, 'disks/disk-1.vdk'), keep) && same(await read(media, 'disks/disk-2.vdk'), blank),
      `stored=${JSON.stringify((await media.list('disks/')).map((f) => f.name))} disk-1=${same(await read(media, 'disks/disk-1.vdk'), keep) ? 'keep' : 'OTHER'}`);
  }
  {
    // the claim a creation takes is RELEASED when it ends, including when it FAILS. An import whose write the store
    // refuses leaves nothing claimed: the image it was going to make is free at once for a rename to take. (A
    // creation that took its claim and never released it would show here as "a disk is being made under that name",
    // for the rest of the session.)
    const media = new MemoryMediaStore();
    const s = await session(media);
    await media.writeSync('disks/keep.vdk', B());
    const refused = Object.assign(new Error('the store refused it'), { code: 'io' });
    const realWrite = media.writeSync.bind(media);
    let refuse = true;
    media.writeSync = (n, b) => { if (n === 'disks/never.vdk' && refuse) throw refused; return realWrite(n, b); };
    const im = await q(s.library.importMedia('never.vdk', A()));
    refuse = false;
    const rn = await q(s.library.renameMedia('disks/keep.vdk', 'disks/never.vdk'));
    check('3. setup: the import was refused by the store', !im.ok, im.m);
    check('3. ... and the name it was going to make is free at once (its claim went with it)',
      rn.ok && same(await read(media, 'disks/never.vdk'), B()), rn.m);
    // the same for a new disk whose mount fails: it is created and stored, its claim released with the creation
    await s.ejectDisk(0);
    const nd = await q(s.newDisk(0, { format: 'vdk', tracks: 40, heads: 1 }, { name: 'gone.vdk' }));
    await s.ejectDisk(0);
    const r1 = await q(s.library.renameMedia('disks/gone.vdk', 'disks/moved.vdk'));
    const r2 = await q(s.library.renameMedia('disks/never.vdk', 'disks/gone.vdk'));
    check('3. ... and a disk a creation made is an ordinary disk once it has finished (its name renamable)',
      nd.ok && r1.ok && r2.ok && same(await read(media, 'disks/gone.vdk'), B()), `${nd.m} | ${r2.m}`);
  }

  {
    // The OTHER hole the reviewer found: rename asked first, then an IMPORT of the same name. The rename runs as a
    // creation but never LANDED the name it took, so an import queued behind it read it as a deliberate replace and
    // wrote its own bytes over the renamed image (both reported success). Every creation lands what it stores --
    // a rename included -- so the import behind it refuses as a second creation of that name.
    for (const how of ['importMedia', 'importDisk']) {
      const media = new MemoryMediaStore();
      const s = await session(media);
      const keep = A(), other = B();
      await media.writeSync('disks/keep.vdk', keep);
      const rn = q(s.library.renameMedia('disks/keep.vdk', 'disks/fresh.vdk'));   // asked first: takes the name
      const im = how === 'importMedia' ? q(s.library.importMedia('fresh.vdk', other)) : q(s.importDisk('fresh.vdk', other, 1));
      const [rr, ir] = [await rn, await im];
      check(`3. rename first, then ${how}: the import is refused as a second creation of the name`,
        rr.ok && !ir.ok && /already a disk named fresh\.vdk/.test(ir.m), `${rr.m || 'rename failed'} | ${ir.m || 'import wrote'}`);
      check(`3. ... and fresh.vdk still holds the RENAMED image, not the import's bytes`,
        same(await read(media, 'disks/fresh.vdk'), keep), same(await read(media, 'disks/fresh.vdk'), keep) ? 'keep' : 'OTHER');
    }
  }
  {
    // A rename that FAILS lands nothing (the name is not taken), so a creation queued BEHIND it is not refused as a
    // second creation: it is simply the first to take the name. The import is asked BEFORE the failing rename is
    // awaited, while its turn is still queued -- asked afterwards the test would pass with the rename landing in a
    // finally, even on failure, and could not tell the two apart.
    const media = new MemoryMediaStore();
    const s = await session(media);
    const rnP = q(s.library.renameMedia('disks/gone.vdk', 'disks/wanted.vdk'));   // the source is not there: it will fail
    const imP = q(s.library.importMedia('wanted.vdk', B()));                      // queued behind it, before it is awaited
    const [rn, im] = [await rnP, await imP];
    check('3. a rename that failed does not land the name it never took',
      !rn.ok && im.ok && same(await read(media, 'disks/wanted.vdk'), B()), `${rn.m} | ${im.m || 'refused'}`);
  }
  {
    // The claim is COUNTED, and that is pinned at its own contract rather than through a race. A rename cannot see
    // the difference from outside: it always queue behind every creation turn (createExclusive), so a claim wrongly
    // released while another creation of the name is in flight is masked by the turn. This checks the contract the
    // Session relies on directly: two claims of one name, one release, and the name is still claimed; a second
    // release frees it. A Set (or a Map set to 1) fails the middle step.
    const s = await session(new MemoryMediaStore());
    s.library.claimDiskName('disks/x.vdk');
    s.library.claimDiskName('disks/x.vdk');
    s.library.releaseDiskName('disks/x.vdk');
    check('3. one release does not free a name two creations hold', s.library.claimedDiskName('disks/x.vdk'));
    s.library.releaseDiskName('disks/x.vdk');
    check('3. ... and the second release does', !s.library.claimedDiskName('disks/x.vdk'));
  }

  {
    // A rename VACATES its source: A->X then X->Y leaves x.vdk free, so an import of it asked behind both must be
    // allowed (it used to refuse, naming x.vdk, because A->X had landed x.vdk and nothing ever un-landed it). The
    // refusal there was safe but wrong: the name was free.
    const media = new MemoryMediaStore();
    const s = await session(media);
    await media.writeSync('disks/a.vdk', A());
    const r1 = q(s.library.renameMedia('disks/a.vdk', 'disks/x.vdk'));
    const r2 = q(s.library.renameMedia('disks/x.vdk', 'disks/y.vdk'));
    const im = q(s.importDisk('x.vdk', B(), 1));
    const [a, b, c] = [await r1, await r2, await im];
    check('3. a rename that vacated a name frees it for a creation queued behind',
      a.ok && b.ok && c.ok && same(await read(media, 'disks/x.vdk'), B()) && same(await read(media, 'disks/y.vdk'), A()),
      `${a.m || ''} | ${b.m || ''} | ${c.m || 'refused'}`);
  }

  // ---------------- 4. a move retargets every DriveWire server the Session made ----------------
  {
    // serveRealCoco over a stub serial port and startChat's chatServer, both on the session's store, then a move
    const pending = () => new Promise(() => {});
    const port = { async open() {}, get writable() { return { getWriter: () => ({ write: async () => {}, releaseLock() {} }) }; },
      get readable() { return { getReader: () => ({ read: pending, cancel: async () => {} }) }; }, async close() {} };
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { serial: { requestPort: async () => port, getPorts: () => [], addEventListener() {}, removeEventListener() {} } }, configurable: true });
    try {
      const from = new MemoryMediaStore(), to = new MemoryMediaStore();
      await from.write('drivewire/OBJ', new Uint8Array(512).fill(9));
      const s = await session(from);
      const link = await s.serveRealCoco(115200);
      // the chat's server, built exactly as startChat builds it (the full-screen chat cannot run here without a
      // firmware and a backend; this is the object startChat makes and keeps in chatServer)
      s.chatServer = new DriveWireServer({ store: s.media, namePrefix: 'drivewire/', clock: s.drivewire.clock, sameName: (a, b) => s.library.sameName(a, b) });
      await s.library.moveMedia(to);   // (the served server is still open, as it is while the cable is in)
      check('4. after a move the session, its Becker server, the served one and the chat\'s all use the new store',
        s.media === to && s.drivewire.store === to && link.server.store === to && s.chatServer.store === to,
        `session ${s.media === to} becker ${s.drivewire.store === to} served ${link.server.store === to} chat ${s.chatServer.store === to}`);
      // and it is not just the field: a blob written to the NEW store only must be visible to the served server,
      // while the OLD store -- which the move leaves holding its copies -- is not where it looks
      await to.write('drivewire/AFTER', new Uint8Array(256).fill(3));
      const seen = await link.server.store.stat('drivewire/AFTER').catch(() => null);
      const oldOnly = await from.stat('drivewire/AFTER').catch(() => null);
      check('4. ... the served server reads an image that exists only in the new store',
        !!seen && seen.size === 256 && oldOnly === null, `${JSON.stringify(seen)} old=${JSON.stringify(oldOnly)}`);
    } finally {
      if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
    }
  }

  // ---------------- 5. two drives may not take one image, even when the mounts overlap ----------------
  {
    // The guest's named-object mount is parked in its stat -- its duplicate scan already done, so anything that
    // checks only before its first await is already past the check -- and ANY other mount of the image, the user's
    // or a second guest's, is asked in that gap. What matters is the end state: one drive on the image, and a
    // refusal for the mount that did not happen. (The order of the two decides the shape: a mount asked while the
    // first is deciding waits for it by design -- js/drivewire/server.js claimName -- so the one that loses is the
    // one that checks second, whichever it is. Main, which had no claim, left two drives on the file in each of
    // these orders; the probe below is the native one.)
    const setup = () => {
      const st = new MemoryMediaStore();
      st.writeSync('drivewire/OBJ', new Uint8Array(256));
      const srv = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
      const realStat = st.stat.bind(st);
      let go = null, first = true;
      st.stat = async (name) => { if (first) { first = false; await new Promise((r) => { go = r; }); } return realStat(name); };
      return { srv, realStat, release: () => go && go() };
    };
    const drivings = (srv) => [...srv.drives.values()].filter((d) => d.name === 'drivewire/OBJ').length;
    {
      // the guest is parked first; the user's mount is asked next
      const { srv, release } = setup();
      for (const b of [0x01, 3, ...[...'OBJ'].map((c) => c.charCodeAt(0))]) srv.receive(b);   // NAME MOUNT, parked in the stat
      const user = srv.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
      await tick(); await tick();
      release();
      const [u] = [await user];
      while (srv.busy) await srv.busy;
      const reply = srv.output.splice(0);
      check('5. guest first: one drive ends up on the image', drivings(srv) === 1, `${drivings(srv)} drives: ${JSON.stringify([...srv.drives.entries()].map(([d, v]) => [d, v.name]))}`);
      check('5. ... the user\'s mount is refused, naming the guest\'s drive', /already in DriveWire drive 255/.test(u), u);
      check('5. ... and the guest was handed its drive', reply.length === 1 && reply[0] === 255, JSON.stringify(reply));
    }
    {
      // the user's mount is asked first, and a second transaction arrives while it is in its stat: the two are
      // ordered by the claim, so whichever lands second is the one refused
      const { srv, release } = setup();
      const a = srv.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
      await tick();
      const b = srv.mount(1, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
      await tick(); await tick();
      release();
      const [ra, rb] = [await a, await b];
      check('5. user first: one drive ends up on the image', drivings(srv) === 1, `${drivings(srv)} drives`);
      check('5. ... the second is refused, naming the first\'s drive', ra === 'ok' && /already in DriveWire drive 0/.test(rb), `${ra} | ${rb}`);
    }
  }
  {
    // the same window between two of the user's own mounts (mountDriveWire for drives 0 and 1 while the store is
    // slow), which must end with one drive on the image either way
    const st = new MemoryMediaStore();
    st.writeSync('drivewire/OBJ', new Uint8Array(256));
    const srv = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
    const realStat = st.stat.bind(st);
    st.stat = async (name) => { await new Promise((r) => setTimeout(r, 5)); return realStat(name); };
    const a = srv.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
    const b = srv.mount(1, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
    const [ra, rb] = [await a, await b];
    const holders = [...srv.drives.values()].filter((d) => d.name === 'drivewire/OBJ').length;
    check('5. two overlapping mounts of one image leave one drive on it', holders === 1 && [ra, rb].filter((x) => x === 'ok').length === 1,
      `${ra} | ${rb} | ${holders} drives`);
  }
  {
    // The REGRESSION the reviewer found (it passed on main, failed here): the user's mount() parked in its stat, then
    // the guest's NAME MOUNT arm -- whose duplicate scan ran before its claim and never again inside it -- took a
    // second drive on the same file. Every arm must re-scan INSIDE the claim.
    const st = new MemoryMediaStore();
    st.writeSync('drivewire/OBJ', new Uint8Array(256));
    const srv = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
    const realStat = st.stat.bind(st);
    let go = null, first = true;
    st.stat = async (name) => { if (first) { first = false; await new Promise((r) => { go = r; }); } return realStat(name); };
    const user = srv.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
    await tick();
    for (const b of [0x01, 3, ...[...'OBJ'].map((c) => c.charCodeAt(0))]) srv.receive(b);   // NAME MOUNT, overlapping
    await tick();
    go();
    while (srv.busy) await srv.busy;
    const reply = srv.output.splice(0);
    const holders = [...srv.drives.values()].filter((d) => d.name === 'drivewire/OBJ').length;
    const u = await user;
    check('5. a guest NAME MOUNT overlapping a user mount leaves one drive on the image', holders === 1,
      `${holders} drives: ${JSON.stringify([...srv.drives.entries()].map(([d, v]) => [d, v.name]))}`);
    check('5. ... the user\'s mount went in, and the guest was refused (0)', u === 'ok' && reply.length === 1 && reply[0] === 0,
      `${u} | ${JSON.stringify(reply)}`);
  }
  {
    // Two servers that SHARE one drives map (serveRealCoco and the chat's server do): a claim that is per server lets
    // a guest on the served link and the user's mount on the Becker port past each other. The claim is shared
    // wherever the drives are.
    const st = new MemoryMediaStore();
    st.writeSync('drivewire/OBJ', new Uint8Array(256));
    const becker = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
    const served = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
    served.drives = becker.drives;
    const realStat = st.stat.bind(st);
    let go = null, first = true;
    st.stat = async (name) => { if (first) { first = false; await new Promise((r) => { go = r; }); } return realStat(name); };
    for (const b of [0x01, 3, ...[...'OBJ'].map((c) => c.charCodeAt(0))]) served.receive(b);   // the served link's guest
    await tick();
    // the guest holds the claim and is parked in the store; the Becker side's user mount must WAIT for it (not take
    // a second drive), so it is asked now and awaited only after the guest is let go
    const userP = becker.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);
    await tick();
    // PROOF OF THE WAIT (not just of the end state): while the served guest holds the claim, the Becker-side mount
    // has not finished. With a claim per server it finishes at once, which is the hole.
    let finishedEarly = false;
    userP.then(() => { finishedEarly = true; });
    for (let i = 0; i < 20; i++) await tick();
    check('5. ... and while the served guest holds the claim, the Becker-side mount has not finished (it waits)',
      !finishedEarly, finishedEarly ? 'finished while the guest still held the claim' : '');
    go();
    while (served.busy) await served.busy;
    const user = await userP;
    const holders = [...becker.drives.values()].filter((d) => d.name === 'drivewire/OBJ').length;
    check('5. servers sharing a drives map share one claim: still one drive on the image', holders === 1,
      `${holders} drives; user ${user}; guest reply ${JSON.stringify(served.output.splice(0))}`);
  }
  {
    // A case-insensitive store: the two spellings are ONE file, so two overlapping mounts of them must serialise.
    // With claims keyed by the exact string (not by the store's rule) they do not, and both pass the duplicate scan:
    // whichever lands second is the one that should have been refused, and the file ends up on the wrong drive.
    const st = new MemoryMediaStore({ caseInsensitive: true });
    st.writeSync('drivewire/OBJ', new Uint8Array(256));
    const srv = new DriveWireServer({ store: st, namePrefix: 'drivewire/', sameName: (a, b) => a.toLowerCase() === b.toLowerCase() });
    const realStat = st.stat.bind(st);
    let go = null, hold = true;
    st.stat = async (name) => { if (hold) { hold = false; await new Promise((r) => { go = r; }); } return realStat(name); };
    const a = srv.mount(0, 'drivewire/OBJ').then(() => 'ok', (e) => e.message);   // asked first: wins
    await tick();
    const b = srv.mount(1, 'drivewire/obj').then(() => 'ok', (e) => e.message);   // the other spelling, overlapping
    await tick();
    go();
    const [ra, rb] = [await a, await b];
    const holders = [...srv.drives.entries()].filter(([, d]) => d.name.toLowerCase() === 'drivewire/obj');
    check('5. two spellings of one file: exactly one drive holds it', holders.length === 1,
      JSON.stringify([...srv.drives.entries()].map(([d, v]) => [d, v.name])));
    check('5. ... on the drive that asked first, and the second is refused naming it',
      ra === 'ok' && holders[0][0] === 0 && /already in DriveWire drive 0/.test(rb), `${ra} | ${rb} | drive ${holders[0] && holders[0][0]}`);
  }
  {
    // a mount of an image that is NOT there, overlapping one of one that is: the missing one must not claim a drive
    // (it used to be able to: a failed stat left nothing behind, and a later claim did not look again)
    const st = new MemoryMediaStore();
    st.writeSync('drivewire/GONE', new Uint8Array(256));
    const srv = new DriveWireServer({ store: st, namePrefix: 'drivewire/' });
    await srv.mount(0, 'drivewire/GONE');
    const r = await srv.mount(1, 'drivewire/GONE').then(() => 'ok', (e) => e.message);
    check('5. a mount of an already-held image is refused, naming the drive', /already in DriveWire drive 0/.test(r), r);
  }

  } catch (e) { fail++; console.log('FAIL the suite threw: ' + (e && e.message)); }
  console.log(fail ? `${fail} of ${n} mount/rename-race checks FAILED` : `${n}/${n} mount/rename-race checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
