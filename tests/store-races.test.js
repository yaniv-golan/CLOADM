// Writes to the Library that did not go through its guards, each raced against a move or a rename.
//
//   1. A guest's named-object CREATE over a DriveWire server the Session built for a REAL CoCo (serveRealCoco) or for
//      the full-screen chat (startChat): only the Becker port's server was wired to the Library (mayWrite,
//      openLibraryOp). The other two wrote the store as a plain write, so a move that began while one was in flight
//      did not wait for it (the write landed in the place the move had left, and was lost), and a create asked while
//      the move copied was not refused (it wrote into the old place mid-copy).
//   2. addAndBootNitros9's floppy save, and drives.keepSnapshot (Save to Library), stored a disks/ name as a plain
//      Library operation: no claimed name, no creation's turn, no landing. A rename onto that name while the save was
//      in flight was not refused, and ran after it, replacing the saved image with the renamed one's bytes; an import
//      asked while it was in flight was read as a deliberate replace. Both now store as a creation, like an import.
//   3. renameMedia's case-only refusal named the destination as typed ("disks/WORK.VDK") where it means the name.
//   4. Messages that named nothing: a blank rename (": a disk image stays where it is"), a '..' destination
//      ("disks/..: not a media library name"), and Save to Library of a disk with no file name ("A disk image needs a
//      name.", for a disk the person never named).
//
// Each race holds the loser inside the exact await where its check has already passed, so what is asserted is the
// ordering, not a lucky schedule. Expected bytes are built here (tools/mame-diff/fdc/images.js, tools/nitros9) or
// read off the store, never produced by the code under test.
//
// Run: node tests/store-races.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const images = require('../tools/mame-diff/fdc/images');
const { makeOs9Disk } = require('../tools/nitros9/os9-image.js');
const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const q = (p) => p.then((m) => ({ ok: true, m }), (e) => ({ ok: false, m: e.message }));
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const read = async (media, name) => media.read(name).catch(() => null);
const settle = () => new Promise((r) => setImmediate(r));
const settleMany = async (k = 30) => { for (let i = 0; i < k; i++) await settle(); };
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const names = async (store, prefix = '') => (await store.list(prefix)).map((f) => f.name).sort().join(',');
const rig = async (media, id = 'coco3') => { const s = new Emu.Session({ store: Emu.memoryStore(), media }); s.switchMachine(id); await s.ready(); return s; };
// gate the store's write of one name: it waits until released
const holdWrite = (store, name) => {
  const g = deferred(), w = store.write.bind(store);
  store.write = async (nm, b) => { if (nm === name) await g.p; return w(nm, b); };
  return g;
};
const holdAllWrites = (store) => { const g = deferred(), w = store.write.bind(store); store.write = async (nm, b) => { await g.p; return w(nm, b); }; return g; };

// a mock Web Serial port (as tests/web-serial.test.js): bytes "from the CoCo" in, what the server wrote out
function mockSerial() {
  const written = [];
  let feed = null;
  const port = {
    readable: new ReadableStream({ start(c) { feed = c; } }),
    writable: new WritableStream({ write(chunk) { written.push(...chunk); } }),
    async open() {}, async close() {},
  };
  return { serial: { async requestPort() { return port; } }, written, send: (bytes) => feed.enqueue(Uint8Array.from(bytes)) };
}
const CREATE = (name) => [0x02, name.length, ...Buffer.from(name)];   // OP_NAMEOBJ_CREATE

(async () => { try {
  // ---------------- 1. a guest's CREATE over the other DriveWire servers ----------------
  // Each guest: how to send it bytes and read its answers. The real CoCo is a mocked Web Serial cable; the chat's
  // server is fed directly (its Becker link is the chat machine's).
  const guests = {
    'real CoCo (Web Serial)': async (s) => {
      const m = mockSerial();
      s.webSerial = m.serial;
      await s.serveRealCoco(115200);
      return { server: s.serialLink.server, send: (b) => m.send(b), out: () => m.written.splice(0) };
    },
    'chat (DriveWire)': async (s) => {
      s.startChat({ backend: { send() {} }, firmware: FIRMWARE, drivewire: true, tools: false });
      const srv = s.chatServer;
      return { server: srv, send: (b) => { for (const x of b) srv.receive(x); }, out: () => srv.output.splice(0) };
    },
  };
  for (const [who, attach] of Object.entries(guests)) {
    // a) the create's write is in flight when a move starts: the move waits for it, then finds the guest's drive and
    //    is refused, and the object is in the store the session still uses
    {
      const from = new MemoryMediaStore(), to = new MemoryMediaStore();
      const s = await rig(from);
      const g = await attach(s);
      const gate = holdWrite(from, 'drivewire/NEW');
      g.send(CREATE('NEW'));
      await settleMany();
      check(`1a [${who}] a guest's create in flight is a Library operation the move can wait for`, s.library.movingOps.size === 1, `ops=${s.library.movingOps.size}`);
      const mv = q(s.library.moveMedia(to));
      await settleMany();
      gate.resolve();
      for (let k = 0; k < 200 && g.server.busy; k++) await g.server.busy;
      await settleMany();
      const r = await mv, out = g.out();
      check(`1a [${who}] the guest is answered with its drive`, out.length === 1 && out[0] >= 1, JSON.stringify(out));
      check(`1a [${who}] the move waited for it and was refused, naming the guest's drive`,
        !r.ok && /Eject the disks first/.test(r.m) && r.m.includes(`DriveWire drive ${out[0]}: NEW`), r.m || 'the move went through');
      check(`1a [${who}] ...the object is in the store the session uses, and nothing went to the new place`,
        s.media === from && !!(await from.stat('drivewire/NEW')) && (await names(to)) === '',
        JSON.stringify({ onOld: s.media === from, inNew: await names(to) }));
    }
    // b) a create asked while the move copies: answered "no such object" (0), and the store is not written
    {
      const from = new MemoryMediaStore(), to = new MemoryMediaStore();
      const s = await rig(from);
      await s.library.importMedia('HOLD.BIN', Uint8Array.from([1, 2, 3]));
      const g = await attach(s);
      const copy = holdAllWrites(to);
      const mv = q(s.library.moveMedia(to));
      await settleMany();
      check(`1b [${who}] the move is copying`, s.library.movingMedia === true);
      g.send(CREATE('MID'));
      await settleMany();
      for (let k = 0; k < 200 && g.server.busy; k++) await g.server.busy;
      const out = g.out();
      copy.resolve();
      const r = await mv;
      check(`1b [${who}] a create asked mid-copy is answered 0`, JSON.stringify(out) === '[0]', JSON.stringify(out));
      check(`1b [${who}] ...and wrote nothing, in either place; the move went through`,
        r.ok && s.media === to && !(await from.stat('drivewire/MID')) && !(await to.stat('drivewire/MID')),
        JSON.stringify({ move: r.m, old: await names(from, 'drivewire/'), now: await names(to, 'drivewire/') }));
    }
    // c) a named-object MOUNT asked while the move copies: it would hand the guest a drive it then writes through, on
    //    the store the copy is leaving, so it is answered 0 and no drive is handed out
    {
      const from = new MemoryMediaStore(), to = new MemoryMediaStore();
      const s = await rig(from);
      await from.write('drivewire/OLD', new Uint8Array(256));
      const g = await attach(s);
      const copy = holdAllWrites(to);
      const mv = q(s.library.moveMedia(to));
      await settleMany();
      g.send([0x01, 3, ...Buffer.from('OLD')]);   // OP_NAMEOBJ_MOUNT "OLD"
      await settleMany();
      for (let k = 0; k < 200 && g.server.busy; k++) await g.server.busy;
      const out = g.out(), drives = g.server.drives.size;
      copy.resolve();
      const r = await mv;
      check(`1c [${who}] a mount asked mid-copy is answered 0, with no drive handed out; the move goes through`,
        JSON.stringify(out) === '[0]' && drives === 0 && r.ok && s.media === to, JSON.stringify({ out, drives, move: r.m }));
    }
  }

  // ---------------- 2. the disk saves that took no creation's turn ----------------
  const FLOPPY = () => makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: '6309' });
  // a) addAndBootNitros9: a rename onto the name while its save is held in the store
  {
    const media = new MemoryMediaStore();
    const s = await rig(media);
    const keep = images.vdk(40, 1), boot = FLOPPY();
    await media.writeSync('disks/keep.vdk', keep);
    const gate = holdWrite(media, 'disks/n9.dsk');
    const add = q(s.addAndBootNitros9('n9.dsk', boot));
    await settleMany();
    const ren = q(s.library.renameMedia('disks/keep.vdk', 'n9.dsk'));
    await settleMany();
    gate.resolve();
    const [a, rn] = [await add, await ren];
    check('2a a rename onto the name addAndBootNitros9 is saving is refused', !rn.ok && /being made under that name/.test(rn.m), rn.m || 'allowed');
    check('2a ...the NitrOS-9 image is stored as given and boots', a.ok && /^Booting NitrOS-9\/6309 from n9\.dsk in floppy drive 0/.test(a.m) && same(await read(media, 'disks/n9.dsk'), boot), a.m);
    check('2a ...and the image the rename named is still there, as it was', same(await read(media, 'disks/keep.vdk'), keep), await names(media, 'disks/'));
  }
  // b) the other order: a rename onto the name is in flight when addAndBootNitros9 is asked. The rename lands first;
  //    the save is a second creation of the name and refuses, rather than writing over the renamed image
  {
    const media = new MemoryMediaStore();
    const s = await rig(media);
    const keep = images.vdk(40, 1);
    await media.writeSync('disks/keep.vdk', keep);
    let release = null;
    s.drives.storeChange(() => new Promise((r) => { release = () => r({ name: 'disks/hold', size: 0, mtime: 0 }); }), 'disks/hold');
    const ren = q(s.library.renameMedia('disks/keep.vdk', 'n9.dsk'));
    await settleMany();
    const add = q(s.addAndBootNitros9('n9.dsk', FLOPPY()));
    await settleMany();
    release();
    const [rn, a] = [await ren, await add];
    check('2b a rename in flight first: it goes through', rn.ok, rn.m);
    check('2b ...and addAndBootNitros9 asked behind it refuses the name', !a.ok && a.m === 'There is already a disk named n9.dsk in your library: choose another name.', a.m || 'allowed');
    check('2b ...leaving the renamed image as it was', same(await read(media, 'disks/n9.dsk'), keep), await names(media, 'disks/'));
  }
  // c) keepSnapshot (Save to Library): a rename onto the name while its save is held in the store
  const snapshotDisk = async (media) => {
    const s = await rig(media, 'dragon64');
    await s.drives.importImage('work.vdk', images.vdk(40, 2), 0);
    const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
    await s.drives.eject(0);
    await s.library.deleteMedia('disks/work.vdk');
    s.openSnapshot(snap);
    return { s, bytes: (await s.drives.download(0)).bytes, snap };
  };
  {
    const media = new MemoryMediaStore();
    const { s, bytes } = await snapshotDisk(media);
    const other = images.vdk(26, 1);
    await media.writeSync('disks/other.vdk', other);
    const gate = holdWrite(media, 'disks/work.vdk');
    const kept = q(s.drives.keepSnapshot(0));
    await settleMany();
    const ren = q(s.library.renameMedia('disks/other.vdk', 'work.vdk'));
    await settleMany();
    gate.resolve();
    const [k, rn] = [await kept, await ren];
    check('2c a rename onto the name Save to Library is saving is refused', !rn.ok && /being made under that name/.test(rn.m), rn.m || 'allowed');
    check('2c ...the snapshot\'s disk is saved, byte for byte, and its drive linked', k.ok && k.m === 'Saved work.vdk to your Library' && same(await read(media, 'disks/work.vdk'), bytes) && s.drives.status().drives[0].stored === true, k.m);
    check('2c ...and the renamed image is still there under its own name', same(await read(media, 'disks/other.vdk'), other), await names(media, 'disks/'));
  }
  // d) keepSnapshot: an import of the name asked while the save is held is a second creation, and refuses
  {
    const media = new MemoryMediaStore();
    const { s, bytes } = await snapshotDisk(media);
    const gate = holdWrite(media, 'disks/work.vdk');
    const kept = q(s.drives.keepSnapshot(0));
    await settleMany();
    const im = q(s.library.importMedia('work.vdk', images.vdk(26, 1)));
    await settleMany();
    gate.resolve();
    const [k, i] = [await kept, await im];
    check('2d Save to Library goes through', k.ok, k.m);
    check('2d ...an import of its name asked meanwhile is refused', !i.ok && /work\.vdk/.test(i.m), i.m || 'allowed');
    check('2d ...and the saved disk is the snapshot\'s', same(await read(media, 'disks/work.vdk'), bytes));
  }

  // ---------------- 3. the case-only refusal names the name, not the typed path ----------------
  {
    const media = new MemoryMediaStore({ caseInsensitive: true });
    const s = await rig(media, 'dragon64');
    await media.writeSync('disks/work.vdk', images.vdk(40, 1));
    for (const to of ['WORK.VDK', 'disks/WORK.VDK']) {
      const r = await q(s.library.renameMedia('disks/work.vdk', to));
      check(`3 case-only rename to ${JSON.stringify(to)}: the refusal names WORK.VDK, not the path`,
        !r.ok && r.m === `${to}: this storage does not tell upper from lower case, so work.vdk and WORK.VDK are the same name.`, r.m);
    }
  }

  // ---------------- 4. messages that say what is wrong ----------------
  {
    const media = new MemoryMediaStore();
    const s = await rig(media, 'dragon64');
    await media.writeSync('disks/work.vdk', images.vdk(40, 1));
    await media.writeSync('library/prog.bin', Uint8Array.from([1]));
    const cases = [
      ['disks/work.vdk', '', 'work.vdk was not renamed: the new name is blank (empty or only spaces).'],
      ['disks/work.vdk', '   ', 'work.vdk was not renamed: the new name is blank (empty or only spaces).'],
      ['disks/work.vdk', 'disks/', 'work.vdk was not renamed: the new name is blank (empty or only spaces).'],
      ['disks/work.vdk', 'disks/ ', 'work.vdk was not renamed: the new name is blank (empty or only spaces).'],
      ['library/prog.bin', '', 'prog.bin was not renamed: the new name is blank (empty or only spaces).'],
      ['library/prog.bin', 'library/', 'prog.bin was not renamed: the new name is blank (empty or only spaces).'],
      ['disks/work.vdk', '..', 'work.vdk was not renamed: ".." is not a name a file can have.'],
      ['disks/work.vdk', 'disks/..', 'work.vdk was not renamed: ".." is not a name a file can have.'],
      ['library/prog.bin', '..', 'prog.bin was not renamed: ".." is not a name a file can have.'],
      ['library/prog.bin', 'a/../b.bin', 'prog.bin was not renamed: ".." is not a name a file can have.'],
    ];
    for (const [from, to, want] of cases) {
      const r = await q(s.library.renameMedia(from, to));
      check(`4 rename ${from} to ${JSON.stringify(to)}: "${want}"`, !r.ok && r.m === want, r.m || 'allowed');
    }
    check('4 ...and none of them changed the store', (await names(media)) === 'disks/work.vdk,library/prog.bin', await names(media));
  }
  {
    // Save to Library of a disk whose name is no file's name (a snapshot made by an earlier build with 'disks/ ')
    const media = new MemoryMediaStore();
    const { s, snap } = await snapshotDisk(media);
    for (const nm of ['disks/ ', ' ', 'disks/']) {
      s.openSnapshot(snap);
      const d = s.drives.controller.drives[0];
      d.media.name = nm;
      const r = await q(s.drives.keepSnapshot(0));
      check(`4 Save to Library of a disk named ${JSON.stringify(nm)}: says the disk has no file name, and what to do`,
        !r.ok && r.m === 'The disk in drive 0 has no file name to save it under: download it, then add it to your Library under a name.', r.m || 'saved');
    }
    check('4 ...and nothing was stored', (await names(media, 'disks/')) === '', await names(media, 'disks/'));
  }

  console.log(fail ? `${fail} of ${n} FAILED` : `all ${n} passed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.log('FAIL', e.stack); process.exitCode = 1; } })();
