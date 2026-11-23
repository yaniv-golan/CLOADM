// Moving the library to another store (the Library's "Where your library is kept"):
// MediaLibrary.moveMedia copies every file, keeps what the new place already has (but merges the index: ROM sockets and
// names, the recent list), refuses while a stored disk is in a drive, leaves the session where it was when a copy
// fails, and from then on reads and writes the new store. Reconnecting a folder copies only what this visit wrote.
// The expected contents are worked out from what each test put in the stores, not read back through moveMedia.
// Run: node tests/storage-move.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const refuse = (p) => p.then(() => null, (e) => e);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const dump = async (store) => {
  const out = new Map();
  for (const f of await store.list('')) out.set(f.name, await store.read(f.name));
  return out;
};

const dsk = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/disks/rsdos.dsk')));
const bin = new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]);
const rom = (seed) => Uint8Array.from({ length: 0x4000 }, (_, i) => (i * seed + 7) & 0xFF);

(async () => {
  // ---- a full library moves: every file copied byte for byte, the old place untouched ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    s.switchMachine('dragon64');
    s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }, { name: 'd64_2.rom', bytes: rom(5) }]);
    await s.library.importMedia('HELLO.BIN', bin);
    await s.library.importMedia('UTILS.DSK', dsk);
    await s.saveSlot(1);
    await s.index.flush();
    const before = await dump(from);
    await from.write('notes/mine.txt', new Uint8Array([1]));   // a file of the user's own, not CLOADM's
    const events = [];
    s.on((e) => events.push(e));
    const r = await s.library.moveMedia(to);
    const after = await dump(to), old = await dump(from);
    check('move: every file is copied, byte for byte', after.size === before.size && [...before].every(([k, v]) => after.has(k) && same(after.get(k), v)),
      `${before.size} files: ${[...before.keys()].join(', ')}`);
    check('move: a file that isn\'t CLOADM\'s is not copied', !after.has('notes/mine.txt'));
    check('move: it covers the library, disks, ROMs and slots', ['library/HELLO.BIN', 'disks/UTILS.DSK'].every((k) => after.has(k))
      && [...after.keys()].some((k) => k.startsWith('roms/')) && [...after.keys()].some((k) => /snapshots\/slot-1/.test(k)), [...after.keys()].join(', '));
    check('move: the result counts what was copied', r.copied === before.size && r.kept === 0, JSON.stringify(r));
    check('move: the old place keeps its copies', [...before].every(([k, v]) => old.has(k) && same(old.get(k), v)) && old.has('notes/mine.txt'));
    check('move: the session now uses the new store', s.media === to && s.index.store === to && s.roms.index === s.index && s.drivewire.store === to);
    check('move: the library lists the same items from the new store', (await s.library.listMedia()).map((x) => x.name).join() === 'disks/UTILS.DSK,library/HELLO.BIN,library/snapshots/slot-1.cloadm',
      (await s.library.listMedia()).map((x) => x.name).join());
    check('move: the ROMs come from the new store (the Dragon 64 still boots BASIC)', s.machineRoms('dragon64').bootable);
    check('move: says so (storage) and the ROM views refresh (roms)', events.includes('storage') && events.includes('roms'), events.join());
    await s.library.importMedia('AFTER.BIN', bin);
    check('move: what is added afterwards goes to the new store only', !!(await to.stat('library/AFTER.BIN')) && !(await from.stat('library/AFTER.BIN')));
    const again = await s.library.moveMedia(to);
    check('move: to the store already in use does nothing', again.copied === 0 && again.kept === 0 && s.media === to);
  }

  // ---- a place that already has some of the files keeps its own ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    await s.library.importMedia('HELLO.BIN', bin);
    await s.library.importMedia('OTHER.BIN', bin);
    const theirs = new Uint8Array([1, 2, 3]);
    await to.write('library/HELLO.BIN', theirs);
    const r = await s.library.moveMedia(to);
    check('existing: a file the new place has is kept as it is there', same(await to.read('library/HELLO.BIN'), theirs));
    check('existing: the rest is copied; counted as kept and copied', same(await to.read('library/OTHER.BIN'), bin) && r.kept === 1 && r.copied >= 1, JSON.stringify(r));
  }

  // ---- the index moves with the library: ROM socket assignments made since are not lost ----
  // The index's own files (roms/sockets.json, roms/names.json, recent/list.json) change in place, so a place that
  // already has an older copy must not keep it: a library moved to the browser and back to its folder keeps the
  // ROMs set while it was in the browser, the folder's own entries for other machines stay, and ROMs removed in
  // the browser do not come back from the folder's old copy.
  {
    const folder = new Emu.MemoryMediaStore(), browser = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: folder });
    await s.ready();
    s.switchMachine('dragon64');
    s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }, { name: 'd64_2.rom', bytes: rom(5) }]);
    s.addRoms([{ name: 'd32.rom', bytes: rom(11) }]);
    await s.library.importMedia('RECENT.BIN', bin);
    await s.library.moveMedia(browser);
    // in the browser: the CoCo's ROMs added, the Dragon 32's removed
    s.addRoms([{ name: 'bas13.rom', bytes: rom(7).subarray(0, 0x2000) }, { name: 'extbas11.rom', bytes: rom(9).subarray(0, 0x2000) }]);
    s.switchMachine('dragon32');
    s.clearRoms();
    s.switchMachine('dragon64');
    await s.index.flush();
    await s.library.moveMedia(folder);
    const sockets = JSON.parse(new TextDecoder().decode(await folder.read('roms/sockets.json')));
    check('back to the folder: the ROMs set in the browser are in its index (the CoCo boots)', s.machineRoms('coco').bootable && !!(sockets.coco && sockets.coco.bas),
      JSON.stringify(sockets));
    check('back to the folder: its entries the browser did not change stay (the Dragon 64 boots)', s.machineRoms('dragon64').bootable);
    check('back to the folder: ROMs removed in the browser stay removed', !s.machineRoms('dragon32').bootable && !Object.keys(sockets.dragon32 || {}).length,
      JSON.stringify(sockets.dragon32));
    // a fresh session on the folder reads the same (what a reload sees)
    const s2 = new Emu.Session({ store: Emu.memoryStore(), media: folder });
    await s2.ready();
    check('back to the folder: a reload sees the same ROMs', s2.machineRoms('coco').bootable && s2.machineRoms('dragon64').bootable && !s2.machineRoms('dragon32').bootable);
    const names = JSON.parse(new TextDecoder().decode(await folder.read('roms/names.json')));
    check('back to the folder: the file names of the ROMs added in the browser are kept', Object.values(names).includes('bas13.rom') && Object.values(names).includes('d64_1.rom'),
      JSON.stringify(names));
  }

  // ---- reconnecting a folder (its permission came back): what this visit added in the browser goes there too ----
  // The folder's own index stays, except what changed in this visit: until the folder was reconnected the library
  // was kept in the browser, and what was added there must not be stranded.
  {
    const folder = new Emu.MemoryMediaStore(), browser = new Emu.MemoryMediaStore();
    // the folder: the Dragon 64's ROMs and a program of its own
    {
      const f = new Emu.Session({ store: Emu.memoryStore(), media: folder });
      await f.ready();
      f.switchMachine('dragon64');
      f.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }, { name: 'd64_2.rom', bytes: rom(5) }]);
      await f.library.importMedia('THERE.BIN', bin);
      await f.index.flush();
    }
    // the browser's own older index: other Dragon 64 ROMs from before the folder was chosen
    {
      const b = new Emu.Session({ store: Emu.memoryStore(), media: browser });
      await b.ready();
      b.switchMachine('dragon64');
      b.addRoms([{ name: 'old_1.rom', bytes: rom(13) }, { name: 'old_2.rom', bytes: rom(17) }]);
      await b.index.flush();
    }
    const folderD64 = JSON.parse(new TextDecoder().decode(await folder.read('roms/sockets.json'))).dragon64;
    // this visit starts on the browser (the folder needs permission again), and adds a program and the CoCo's ROMs
    const s = new Emu.Session({ store: Emu.memoryStore(), media: browser });
    await s.ready();
    s.switchMachine('dragon64');
    await s.library.importMedia('HERE.BIN', bin);
    s.addRoms([{ name: 'bas13.rom', bytes: rom(7).subarray(0, 0x2000) }, { name: 'extbas11.rom', bytes: rom(9).subarray(0, 0x2000) }]);
    await s.index.flush();
    const r = await s.library.moveMedia(folder, { reconnecting: true });
    const sockets = JSON.parse(new TextDecoder().decode(await folder.read('roms/sockets.json')));
    check('reconnect: the program added in the browser is in the folder, with the folder\'s own',
      !!(await folder.stat('library/HERE.BIN')) && !!(await folder.stat('library/THERE.BIN'))
      && (await s.library.listMedia()).map((x) => x.name).join() === 'library/HERE.BIN,library/THERE.BIN', (await s.library.listMedia()).map((x) => x.name).join());
    check('reconnect: the ROMs added in the browser are in the folder\'s index (the CoCo boots)', s.machineRoms('coco').bootable && !!(sockets.coco && sockets.coco.bas),
      JSON.stringify(sockets));
    check('reconnect: the folder\'s own Dragon 64 ROMs win over the browser\'s older ones', JSON.stringify(sockets.dragon64) === JSON.stringify(folderD64),
      `${JSON.stringify(sockets.dragon64)} vs ${JSON.stringify(folderD64)}`);
    check('reconnect: the session uses the folder, and counts what it copied', s.media === folder && r.copied > 0, JSON.stringify(r));
  }

  // ---- reconnecting: only what this visit wrote goes across ----
  // The browser held the library only while the folder waited for permission; what it had from before is stale. A
  // program deleted from the folder, still in the browser from an earlier visit, must not come back.
  {
    const folder = new Emu.MemoryMediaStore(), browser = new Emu.MemoryMediaStore();
    await folder.write('library/KEPT.BIN', bin);
    await browser.write('library/DELETED.BIN', bin);     // from an earlier visit; deleted from the folder since
    await browser.write('library/KEPT.BIN', bin);
    await new Promise((ok) => setTimeout(ok, 5));          // this visit starts later
    const s = new Emu.Session({ store: Emu.memoryStore(), media: browser });
    await s.ready();
    s.switchMachine('dragon64');
    await s.library.importMedia('NEW.BIN', bin);
    const r = await s.library.moveMedia(folder, { reconnecting: true });
    check('reconnect: what this visit added goes to the folder', !!(await folder.stat('library/NEW.BIN')), JSON.stringify(r));
    check('reconnect: what the browser had from before does not (a program deleted from the folder stays deleted)', !(await folder.stat('library/DELETED.BIN'))
      && (await s.library.listMedia()).map((x) => x.name).join() === 'library/KEPT.BIN,library/NEW.BIN', (await s.library.listMedia()).map((x) => x.name).join());
  }

  // ---- the recent list is the newer side's, not padded with the other's older entries ----
  {
    const folder = new Emu.MemoryMediaStore(), browser = new Emu.MemoryMediaStore();
    {
      const f = new Emu.Session({ store: Emu.memoryStore(), media: folder });
      await f.ready();
      f.switchMachine('dragon64');
      f.load('OLD1.BIN', Uint8Array.from(bin, (v, i) => (i === 9 ? 0x12 : v)));
      f.load('OLD2.BIN', Uint8Array.from(bin, (v, i) => (i === 9 ? 0x13 : v)));
      await f.index.flush();
    }
    const s = new Emu.Session({ store: Emu.memoryStore(), media: browser });
    await s.ready();
    s.switchMachine('dragon64');
    s.load('NOW.BIN', bin);
    await s.library.moveMedia(folder);
    check('move: the recent list is the library\'s own, the other place\'s older entries are not appended', s.library.recentMedia().map((r) => r.name).join() === 'NOW.BIN',
      s.library.recentMedia().map((r) => r.name).join());
  }

  // ---- refused while a stored disk is in a drive ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    s.switchMachine('coco');
    s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom');
    await s.library.importMedia('WORK.DSK', dsk);
    await s.drives.mount(1, 'disks/WORK.DSK');
    const e = await refuse(s.library.moveMedia(to));
    check('in a drive: the move is refused and says which drive holds what', e instanceof Emu.SessionError && /Eject the disks first \(drive 1: WORK\.DSK\)/.test(e.message), e && e.message);
    check('in a drive: nothing moved', s.media === from && (await to.list('')).length === 0);
    await s.drives.eject(1);
    const r = await s.library.moveMedia(to);
    check('in a drive: once ejected it moves', s.media === to && r.copied > 0);
  }

  // ---- a copy that fails (no space there) leaves the session where it was ----
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore({ quotaBytes: 4096 });
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    await s.library.importMedia('UTILS.DSK', dsk);
    const e = await refuse(s.library.moveMedia(to));
    check('no space: a SessionError naming the file', e instanceof Emu.SessionError && /No space left .* for disks\/UTILS\.DSK/.test(e.message), e && e.message);
    check('no space: the session stays on the old store with its library', s.media === from && (await s.library.listMedia()).map((x) => x.name).join() === 'disks/UTILS.DSK');
  }
})().then(() => {
  console.log(`${n - fail}/${n} storage move checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL storage move ${e.stack}`); process.exitCode = 1; });
