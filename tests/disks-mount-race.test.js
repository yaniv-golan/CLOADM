// Floppy disks through the Session, part 2 of 4: a change to the image a mount is reading, made through the
// Library (a rename onto it, an import over it, a write under another case spelling while the mount reads). Split
// from tests/disks.test.js to keep each suite well under tests/all.js's per-suite cap; fixtures in disks-common.js.
const { Emu, images, same, session, checker } = require('./disks-common');
const { check, failures } = checker();

(async () => {
  // ---------------- a change to the image the mount reads, made through the Library, names that image
  // (a rename onto it, an import over it, a delete of it, and a write under another CASE spelling of it): each must
  // make the mount re-read, or fail clearly. This pins the names the diskStoreChange call sites pass.
  {
    // wraps readRange for `image`: counts reads, and after the first one has returned runs `during()` (which queues
    // a Library change) before letting the mount go on, so the change lands while the mount is still inside its read
    const raceFirstRead = (media, image, during) => {
      const real = media.readRange.bind(media);
      let reads = 0;
      media.readRange = async (name, ...a) => {
        const out = await real(name, ...a);
        if (name === image && ++reads === 1 && during) await during();
        return out;
      };
      return () => reads;
    };
    const setup = async () => {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('x.vdk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);                        // drive 0 free for the mount
      return { s, media };
    };
    // a rename onto the mounted name. The name has to be free for the rename to happen at all, so inside the race
    // x.vdk is removed from the store directly (a Library delete would be a change to x and would be noticed by its
    // own tag) and y.vdk is then renamed onto it through the Library. The only disk change QUEUED during the read is
    // that rename, and it names 'disks/x.vdk' only as the destination: tag it [src] alone and nothing is numbered
    // for 'disks/x.vdk' while the mount reads, so the mount returns the stale image.
    {
      const { s, media } = await setup();
      const y = images.vdk(40, 1);
      await s.importDisk('y.vdk', y, 1); await s.ejectDisk(1);
      let renamed = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => {
        await media.remove('disks/x.vdk');
        renamed = await s.renameMedia('disks/y.vdk', 'disks/x.vdk').then(() => 'ok', (e) => e.message);
      });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0];
      check('a rename onto the image being mounted: the mount reads again and holds the renamed image (not the stale one)',
        renamed === 'ok' && reads() === 2 && d.loaded && same(d.media.bytes, y) && same(d.media.bytes, await media.read('disks/x.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads()}; rename=${renamed}`);
    }
    // an import over the mounted name
    {
      const { s, media } = await setup();
      const fresh = images.vdk(40, 1); fresh.fill(0x77, 0x2000, 0x2100);
      let imported = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => { imported = await s.importMedia('disks/x.vdk', fresh).then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0];
      check('an import over the image being mounted: the mount reads again and holds the imported bytes',
        reads() === 2 && d.loaded && same(d.media.bytes, fresh), `${out instanceof Error ? out.message : out}; reads=${reads()}; import=${imported}`);
    }
    // importDisk over the image being mounted (into another drive): its write is tagged with the image's name, so
    // the mount reading meanwhile reads again and holds the imported bytes. The import's own mount then finds the
    // image in drive 0 and says so. The hook returns once the import's write has started in the disk queue (the
    // store's write is called), so the change is counted but has not landed when the mount decides.
    {
      const { s, media } = await setup();
      const fresh = images.vdk(40, 2); fresh.fill(0x6E, 0x2000, 0x2100);
      const realWrite = media.write.bind(media);
      let started = null; const writeStarted = new Promise((res) => { started = res; });
      media.write = (name, ...a) => { if (name === 'disks/x.vdk') started(); return realWrite(name, ...a); };
      let imported = null;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => {
        imported = s.importDisk('x.vdk', fresh, 1).then(() => 'ok', (e) => e.message);
        await writeStarted;
      });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      const importResult = await imported;
      media.write = realWrite;
      const d = s.diskController.drives[0];
      check('importDisk over the image being mounted: the mount reads again and holds the imported bytes',
        out === 'x.vdk in drive 0' && d.loaded && same(d.media.bytes, fresh) && same(fresh, await media.read('disks/x.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads()} (the import's own mount reads it too)`);
      check('... and the import says it was saved but is in drive 0, not put in drive 1',
        /x\.vdk was saved to your Library but not put in drive 1: .*already in drive 0/.test(String(importResult)) && !s.diskController.drives[1].loaded,
        String(importResult));
    }
    // The count is taken BEFORE the mount waits for the queued writes. Another file's write (W1) is held in the
    // store, so the mount's wait is still open when a write to this image (W2) is queued; W2 is held until the
    // mount's first read has returned. The mount must count W2 as a change under its read and read again; a count
    // taken after the wait would already include W2 and keep the bytes from before it.
    {
      const { s, media } = await setup();
      const x = await media.read('disks/x.vdk');
      await s.importDisk('y.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      const realRange = media.writeRange.bind(media);
      const gate = () => { let open; const p = new Promise((res) => { open = res; }); return { p, open }; };
      const g1 = gate(), g2 = gate();
      let w1Started = null; const w1 = new Promise((res) => { w1Started = res; });
      media.writeRange = async (name, ...a) => {
        if (name === 'disks/y.vdk') { w1Started(); await g1.p; }
        if (name === 'disks/x.vdk') await g2.p;
        return realRange(name, ...a);
      };
      s.diskLink('disks/y.vdk')(0x100, new Uint8Array([0x11]), 12 + 40 * 1 * 18 * 256);   // W1, held
      await w1;
      const reads = raceFirstRead(media, 'disks/x.vdk', async () => { g2.open(); });
      const pending = s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);   // counts, then waits on W1
      s.diskLink('disks/x.vdk')(0x800, new Uint8Array([0x99]), x.length);  // W2, queued during that wait
      g1.open();
      const out = await pending;
      media.writeRange = realRange;
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/x.vdk');
      check('a write to the image queued while the mount waits for earlier writes: the mount reads again and holds it',
        out === 'x.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x800] === 0x99 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The drive is flushed again after the read. The image is in drive 0 already and mounted there again; while the
    // store is read, the machine writes to that drive (our writer firmware), and it is stopped as soon as drive 0
    // holds written data, before the firmware stops the motor (which would commit it on its own). Those writes sit in
    // the drive until flushed: the flush after the read hands them to the store as changes to this image, so the
    // mount reads again and holds them. Without it they would only be handed over when the drive is emptied for the
    // new mount, after the decision, and the drive would hold the bytes from before.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
      await s.importDisk('p0.vdk', d0, 0);
      await s.importDisk('p1.vdk', d1, 1);
      const drive0 = s.diskController.drives[0];
      let dirty = false;
      const reads = raceFirstRead(media, 'disks/p0.vdk', async () => {
        for (let f = 0; f < 600 && !drive0.imageDirty; f++) s.shownMachine.runFrame();
        dirty = drive0.imageDirty;
      });
      const out = await s.mountDisk(0, 'p0.vdk').then((m) => m, (e) => e);
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/p0.vdk');
      check('the machine writes the drive (not yet committed) while it is mounted again: the flush after the read makes the mount read again and hold those writes',
        dirty && out === 'p0.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && !same(stored, d0),
        `${out instanceof Error ? out.message : out}; dirty=${dirty}; reads=${reads()}`);
    }
    // a delete of the very image being mounted: the re-read finds it gone, so the mount fails clearly
    {
      const { s, media } = await setup();
      await s.importDisk('w.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      let deleted = null;
      raceFirstRead(media, 'disks/x.vdk', async () => { deleted = await s.deleteMedia('disks/x.vdk').then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      check('a delete of the very image being mounted: the mount fails clearly rather than holding a deleted image',
        out instanceof Emu.SessionError && /x\.vdk is no longer stored/.test(out.message) && !s.diskController.drives[0].loaded,
        `${out instanceof Error ? out.message : out}; delete=${deleted}`);
    }
    // a rename AWAY from the mounted name (the source name): the mount must notice that too, and the re-read then
    // finds the name gone, so it fails clearly. Pins the [src] half of the rename's names.
    {
      const { s, media } = await setup();
      let away = null;
      raceFirstRead(media, 'disks/x.vdk', async () => { away = await s.renameMedia('disks/x.vdk', 'disks/moved.vdk').then(() => 'ok', (e) => e.message); });
      const out = await s.mountDisk(0, 'x.vdk').then((m) => m, (e) => e);
      check('a rename AWAY from the image being mounted: the mount re-reads, finds it gone and fails clearly',
        away === 'ok' && out instanceof Emu.SessionError && /x\.vdk is no longer stored/.test(out.message) && !s.diskController.drives[0].loaded,
        `${out instanceof Error ? out.message : out}; rename=${away}`);
    }
    // a distinct file whose name differs only in case must NOT be able to fail the mount, nor keep it re-reading:
    // on a case-sensitive store disks/WORK.DSK and disks/work.DSK are two files, and the mount follows the store's
    // rule (Session.sameName). The writer is not bound: it writes on every read the mount makes, so the mount has to
    // stop on the store's rule, not on the writer going quiet.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('work.DSK', images.vdk(40, 2), 0);
      await s.importDisk('WORK.DSK', images.vdk(40, 1), 1);
      await s.ejectDisk(0);
      const other = s.diskController.drives[1];
      let reads = 0;
      const realRange = media.readRange.bind(media);
      // while the mount reads its own file, drive 1 keeps writing the OTHER file (which folds to the same key)
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.DSK') {
          reads++;
          other.media.onWrite(0x100 + 0x10 * reads, new Uint8Array([0x5A]), other.media.bytes.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.DSK').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0];
      check('another file whose name folds to the same key writes throughout: the mount still mounts (its budget is its own name\'s)',
        out === 'work.DSK in drive 0' && d.loaded,
        `${out instanceof Error ? out.message : out}; reads=${reads}`);
      check('... having read once: on this store the other spelling is a separate file, so nothing was re-read',
        reads === 1, `reads=${reads}`);
      check('... and it holds its own image (the other file\'s writes reached it nowhere)',
        !!d.media && same(d.media.bytes, images.vdk(40, 2)), d.loaded ? 'the mounted image is not the one stored for this name' : 'not mounted');
    }
  }
  const fail = failures();
  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
