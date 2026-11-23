// Floppy disks through the Session, part 3 of 4: a mount reading while the same image is written under its own
// name or another case spelling, on case-sensitive, case-insensitive and unmeasured stores. Split from
// tests/disks.test.js to keep each suite well under tests/all.js's per-suite cap; fixtures in disks-common.js.
const { Emu, images, MemoryMediaStore, same, session, putRoms, checker } = require('./disks-common');
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
    // the same, with the roles swapped: mount the ALREADY-lower-case name while drive 1 keeps writing the upper-case
    // one (a count kept under the lower-cased name would put the other file's writes on this mount's budget).
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon');
      await s.importDisk('WORK.DSK', images.vdk(40, 1), 1);
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      const other = s.diskController.drives[1];
      let reads = 0;
      const realRange = media.readRange.bind(media);
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk') {
          reads++;
          other.media.onWrite(0x100 + 0x10 * reads, new Uint8Array([0x5A]), other.media.bytes.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0];
      check('mounting the lower-case name while the other file\'s spelling folds onto it is written throughout: it still mounts',
        out === 'work.dsk in drive 0' && d.loaded, `${out instanceof Error ? out.message : out}; reads=${reads}`);
      check('... having read once (the two spellings are two stored files here)', reads === 1, `reads=${reads}`);
      check('... and it holds its own image (the other file\'s writes reached it nowhere)',
        !!d.media && same(d.media.bytes, images.vdk(40, 2)), d.loaded ? 'the mounted image is not the one stored for this name' : 'not mounted');
    }
    // A store that holds both spellings as ONE file (a File System Access folder on macOS or Windows; here
    // MemoryMediaStore({ caseInsensitive: true })): the other spelling IS this file, so its writes are this image's
    // changes and spend the mount's budget: without let-up the mount gives up after four reads, clearly and bounded.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      let reads = 0;
      const realRange = media.readRange;
      // each read of the image is followed by a write to it under the OTHER spelling (the link names WORK.DSK). The
      // writer stops after 20 writes so the test stays bounded even if the limit is removed.
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk' && reads < 20) {
          reads++;
          const cur = await media.read('disks/work.dsk');
          s.diskLink('disks/WORK.DSK')(0x100, new Uint8Array([reads & 0xFF]), cur.length);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      check('a case-insensitive store whose image keeps changing under another spelling: the mount gives up clearly',
        out instanceof Emu.SessionError && /kept writing while it was read; try again/.test(out.message),
        out instanceof Error ? out.message : String(out));
      check('... after 4 reads (the first and three more: one limit, because these are this image\'s own writes)',
        reads === 4, `reads=${reads}`);
      check('... and nothing was mounted', !s.diskController.drives[0].loaded);
    }
    // A write under the other spelling that is STILL LANDING when the read returns must not be missed (a case-
    // insensitive store). Pass 1 has a byte-neutral rewrite (a byte comparison would be fooled by it); pass 2's
    // real write is queued as that read finishes, so the mount must count it rather than look at bytes.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('work.dsk', images.vdk(40, 2), 0);
      await s.ejectDisk(0);
      let reads = 0;
      const realRange = media.readRange;
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/work.dsk') {
          reads++;
          if (reads === 1) {
            const cur = await media.read('disks/work.dsk');
            s.diskLink('disks/WORK.DSK')(0x100, cur.slice(0x100, 0x104), cur.length);
            await s.diskWritesDone().catch(() => {});
          } else if (reads === 2) {
            s.diskLink('disks/WORK.DSK')(0x400, new Uint8Array([0x77, 0x77, 0x77, 0x77]), (await media.stat('disks/work.dsk')).size);
          }
        }
        return out;
      };
      const out = await s.mountDisk(0, 'work.dsk').then((m) => m, (e) => e);
      media.readRange = realRange;
      const d = s.diskController.drives[0], stored = await media.read('disks/work.dsk');
      check('a write under another spelling that lands after the read returns is not missed (case-insensitive store)',
        out === 'work.dsk in drive 0' && d.loaded && !!d.media && d.media.bytes[0x400] === 0x77 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads}; mounted=${d.loaded}${d.media ? `; byte=${d.media.bytes[0x400]}` : ''}`);
    }
    // The one rule, both ways: mounting a.vdk while A.vdk is written during the read. On a case-sensitive store A.vdk
    // is another file: the mount never re-reads and holds a.vdk as stored. On a case-insensitive one it is this very
    // file: the mount re-reads and holds the current bytes.
    for (const caseInsensitive of [false, true]) {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      if (!caseInsensitive) { await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1); }
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      const held = d.loaded && same(d.media.bytes, stored);
      if (!caseInsensitive) {
        check('case-sensitive store: a write to A.vdk during a.vdk\'s mount does not re-read it, and the drive holds a.vdk as stored',
          out === 'a.vdk in drive 0' && reads() === 1 && held && same(stored, a) && (await media.read('disks/A.vdk'))[0x300] === 0x5A,
          `${out instanceof Error ? out.message : out}; reads=${reads()}`);
      } else {
        check('case-insensitive store: a write to A.vdk during a.vdk\'s mount re-reads it, and the drive holds the current bytes',
          out === 'a.vdk in drive 0' && reads() === 2 && held && stored[0x300] === 0x5A,
          `${out instanceof Error ? out.message : out}; reads=${reads()}`);
      }
    }
    // An own-name write during the read: a write to the image's own name queued in the window after the read returns and before the
    // mount decides (nothing awaited: it is still landing) must be seen, so the drive gets the new bytes. Both stores.
    for (const caseInsensitive of [false, true]) {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/a.vdk')(0x500, new Uint8Array([0x66]), a.length);   // queued, not waited for
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check(`an own-name write queued as the read returns is not missed: the drive holds the new bytes (${caseInsensitive ? 'case-insensitive' : 'case-sensitive'} store)`,
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x500] === 0x66 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The same race through the store listing: on a case-sensitive store another spelling changes during the
    // read, and an own-name write is queued the moment the store is listed (the mount used to list the store, after
    // its change check, to ask whether the two spellings were one file). Whatever the mount does in that window, the
    // drive must end up holding the image as stored once every write has landed, not the bytes from before.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: false } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1);
      const realList = media.list.bind(media);
      let injected = false;
      media.list = async (...x) => {
        if (!injected) { injected = true; s.diskLink('disks/a.vdk')(0x700, new Uint8Array([0x3C]), a.length); }
        return realList(...x);
      };
      raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      media.list = realList;
      await s.diskWritesDone().catch(() => {});
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('own-name write during the store listing: an own-name write in the window after the change check does not leave the drive on stale bytes',
        out === 'a.vdk in drive 0' && d.loaded && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; injected=${injected}; drive[0x700]=${d.loaded ? d.media.bytes[0x700] : '-'}; stored[0x700]=${stored[0x700]}`);
    }
    // Two spellings changed in one read: on a case-sensitive store the mount's own name AND a separate other spelling both change in
    // one read. The other file is not this image, but its own change is: it must re-read and hold the new bytes.
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: false } });
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await s.importDisk('A.vdk', images.vdk(40, 2), 1); await s.ejectDisk(1);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        s.diskLink('disks/a.vdk')(0x600, new Uint8Array([0x44]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('case-sensitive store, own name and another spelling both written in one read: the mount re-reads and holds the new bytes',
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && stored[0x600] === 0x44 && stored[0x300] !== 0x5A,
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // FAIL SAFE on a store whose rule is not measured: its measurement finds nothing to put the question with (it
    // lists nothing to measure), so the Session takes it as case-insensitive (main's rule, js/host/media-store.js
    // detectCase). The mount must then re-read on another spelling's write, and the drive must hold what is stored,
    // whether the store in fact folds (the write was to this image: the re-read is what gets it) or not.
    class UnmeasuredStore extends MemoryMediaStore {
      constructor(fold) { super(); this._fold = fold; this.declaresCase = false; this.caseInsensitive = null; }
      get synchronous() { return false; }
      key(name) { return this._fold ? name.toLowerCase() : name; }
      async _listing() { return []; }   // the measurement's own listing: nothing to ask about, so never measured
    }
    for (const fold of [true, false]) {
      const media = new UnmeasuredStore(fold);
      const s = new Emu.Session({ media });
      await s.ready();                       // the index of an asynchronous store loads first, then the ROMs go in
      putRoms(s, 'dragon64', 'dragondos', 'dragon');
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      if (!fold) await media.write('disks/A.vdk', images.vdk(40, 2));
      check(`setup: the store's rule is unmeasured and the Session takes it as case-insensitive (store ${fold ? 'folds' : 'keeps spellings apart'})`,
        media.caseMeasured !== true && s.caseInsensitive === true);
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check(`unmeasured store (${fold ? 'in fact folds' : 'in fact keeps spellings apart'}): another spelling's write re-reads, and the drive holds the stored bytes`,
        out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && same(d.media.bytes, stored) && (stored[0x300] === 0x5A) === fold,
        `${out instanceof Error ? out.message : out}; reads=${reads()}`);
    }
    // The rule is taken once per pass. Here the store is unmeasured when the mount counts (so A.vdk's earlier change
    // counts as this image's), is measured case-sensitive during the read, and the image's own name changes once in
    // that read. Summed by one rule the counts differ and the mount reads again; summed by the rule before and the
    // rule after, A.vdk's one earlier change and the own one cancel out and the mount would keep the old bytes.
    {
      const media = new UnmeasuredStore(false);
      let measurable = false;
      media._listing = async (prefix) => (measurable ? MemoryMediaStore.prototype.list.call(media, prefix) : []);
      const s = new Emu.Session({ media });
      await s.ready();
      putRoms(s, 'dragon64', 'dragondos', 'dragon');
      const a = images.vdk(40, 2);
      await s.importDisk('a.vdk', a, 0); await s.ejectDisk(0);
      await media.write('disks/A.vdk', images.vdk(40, 2));
      s.diskLink('disks/A.vdk')(0x300, new Uint8Array([0x5A]), a.length);
      await s.diskWritesDone();
      const unmeasured = s.caseInsensitive === true && media.caseMeasured !== true;
      let measured = null;
      const reads = raceFirstRead(media, 'disks/a.vdk', async () => {
        measurable = true;
        measured = await s.refreshCase();
        s.diskLink('disks/a.vdk')(0x900, new Uint8Array([0x42]), a.length);
        await s.diskWritesDone().catch(() => {});
      });
      const out = await s.mountDisk(0, 'a.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0], stored = await media.read('disks/a.vdk');
      check('the store is measured case-sensitive during the read and the image changes once: the mount still reads again (one rule per pass)',
        unmeasured && measured === false && out === 'a.vdk in drive 0' && reads() === 2 && d.loaded && d.media.bytes[0x900] === 0x42 && same(d.media.bytes, stored),
        `${out instanceof Error ? out.message : out}; unmeasured=${unmeasured}; measured=${measured}; reads=${reads()}`);
    }
    // mounting under UPPER case while the write comes in lower case, on a case-insensitive store: the mount re-reads
    {
      const { s, media } = session('dragon64', 'dragondos', 'dragon', { storeOpts: { caseInsensitive: true } });
      await s.importDisk('upper.vdk', images.vdk(40, 1), 1); await s.ejectDisk(1);
      let reads = 0;
      const realRange = media.readRange;
      media.readRange = async (name, ...a) => {
        const out = await realRange(name, ...a);
        if (name === 'disks/UPPER.vdk' && ++reads === 1) {
          s.diskLink('disks/upper.vdk')(0x300, new Uint8Array([0x5A]), 12 + 40 * 1 * 18 * 256);
          await s.diskWritesDone().catch(() => {});
        }
        return out;
      };
      const out = await s.mountDisk(0, 'disks/UPPER.vdk').then((m) => m, (e) => e);
      const d = s.diskController.drives[0];
      check('mounting under UPPER case, a change queued under lower case: the mount re-reads (case-insensitive store)',
        reads === 2 && d.loaded && d.media.bytes[0x300] === 0x5A && same(d.media.bytes, await media.read('disks/upper.vdk')),
        `${out instanceof Error ? out.message : out}; reads=${reads}`);
    }
  }
  const fail = failures();
  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
