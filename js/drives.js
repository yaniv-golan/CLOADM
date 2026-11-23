// The floppy drives of a Session (session.drives): the disk controller of the person's machine (a disk cartridge,
// a bare controller with no disk ROM, or a machine's own interface), the disk cartridge offered and inserted, new
// blank disks, the drives' disks mounted from and written back to the media store (in order, only the bytes that
// changed), their status, the links a restore point records and relinks, and a snapshot's disk kept in the Library.
//
// The Session builds one with itself as its `session` (as session.disk, session.serial and session.library are). The
// machines, the ROM library, the store handle (session.media), the media library (session.library: the names being
// made, the case rule, the Library operations a move waits for) and the events stay the Session's; this asks them.
// Nothing here is saved in a snapshot or a settings export: a drive's link to the store is not part of a snapshot.
import { SessionError } from './errors.js';
import { devices } from './machines/bus.js';
import { MultiPak } from './machines/carts.js';
import { DiskController, FDC_BOARDS } from './machines/fdc.js';
import { DRIVE_TYPES } from './chips/floppy.js';
import { detectDiskFormat, diskGeometry, blankDisk, DiskFormatError } from './media/disk.js';
import { MediaStoreError } from './host/media-store.js';
import { cartridgeRoms } from './machines/profiles.js';
import { DISK_PREFIX, isDiskFileName } from './library.js';

// how many times mount reads an image again when the image moved under its read (its own stored name, or
// another spelling of the same file on a store that folds case): the image is read four times at most before the
// mount gives up. A write to a DIFFERENT stored file never spends this.
const MOUNT_READ_RETRIES = 3;
// the disk cartridges each family can take (js/machines/profiles.js cartridgeRoms), the usual one first
const DISK_DOS = { dragon: ['dragondos', 'deltados'], coco: ['rsdos'] };
// what a disk mounted without a disk ROM is good for (the end of the mount's message: "level.vdk is in drive 0, ...")
export const BARE_NOTE = 'on the disk controller only (no disk ROM). Programs that read the disk directly can use it; DIR and other disk commands need your disk ROM.';

export class DiskDrives {
  #held;
  // session: the Session it belongs to. held: the Session's key for a mount made inside a Library operation of its
  // own (bootNitros9; see Session.mountDriveWire), kept in a private field: nothing outside the Session and this class
  // can read it, so an embedder calling mount cannot skip its move checks.
  constructor(session, { held }) {
    this.session = session;
    this.#held = held;
    this.writing = Promise.resolve();   // the chain of disk image writes to the media store
    this.mounts = 0;                // mounts made so far: each mount's link carries the next number (link)
    this.checks = new Set();        // background round-trip checks not yet run (checkLater)
    this.queued = 0;                // changes to stored disk images queued so far (queueWrite, storeChange)
    this.landed = 0;                // of those, the ones finished (done or refused)
    this.changes = new Map();       // stored image name (exact spelling) -> how many of those changes were to it
    this.error = null;              // a disk write the store refused, reported by writesDone()
    this.unsaved = new Map();       // stored image name -> why its last write was refused (until one succeeds)
  }
  // ---------------- floppy disks ----------------
  // Disk images live in the media store under DISK_PREFIX and are used through its random access: a mount
  // reads the image with readRange, and what the machine writes goes back with writeRange, only the bytes
  // that changed (the drive commits them when its motor stops, on eject and before the machine goes away).
  // They never go through the media index, which keeps everything it owns in memory. Writes to the store are
  // chained, so they land in order; writesDone() waits for them.
  // The disk cartridge (DragonDOS, Delta DOS or Disk BASIC) runs the user's ROM, like every other. Without one a disk
  // still mounts: the disk controller goes in with no ROM (its cartridge space reads 00, and it raises no line, so
  // the program running keeps going), for programs that drive the controller themselves. A disk ROM added later
  // takes its place at the next reset or power cycle (fitRom).

  // where a file the person loads goes: the BASIC session while the Claude chat is full screen (Session.loadTarget)
  // the person's disks go in the same machine, so a disk dropped on the chat screen lands in the drives the person
  // sees, and the drives card shows those drives, not the chat machine's empty ones (it is a fresh machine: only a
  // model with its own disk interface, the Dragon Alpha, has a controller there at all)
  get targetMachine() { return this.session.loadTarget().m; }
  // the disk cartridges this machine can take: [{ id, name, controller, ready (ROM stored), inserted }]
  // A machine with its own disk interface (the Dragon Alpha) offers only that: { id: 'builtin', builtin: true }.
  dosChoices() {
    const m = this.targetMachine;
    if (m && m.fdc instanceof DiskController) return [{ id: 'builtin', name: m.fdc.name, controller: m.fdc.type, ready: true, inserted: true, builtin: true }];
    if (!m || !m.hasCartridgePort) return [];
    const ids = DISK_DOS[m.profile.lineage] || [];
    const fdc = this.controller;
    return ids.map((id) => ({ id, name: cartridgeRoms[id].name, controller: cartridgeRoms[id].controller, rom: cartridgeRoms[id].roms[0].files[0], ready: !!this.session.roms.get(id).rom, inserted: !!fdc && fdc.type === cartridgeRoms[id].controller }));
  }
  // the disk controller: the machine's own (the Dragon Alpha's), else the one in the cartridge port or in one of
  // its Multi-Pak's slots, or null
  get controller() { return this.controllerOf(this.targetMachine); }
  controllerOf(m) {
    if (m.fdc instanceof DiskController) return m.fdc;
    if (m.cartPort instanceof MultiPak) return m.cartPort.slots.find((c) => c instanceof DiskController) || null;
    return m.cartPort instanceof DiskController ? m.cartPort : null;
  }
  // the disk controller in use when it holds no ROM (plugged in for a disk mounted without a disk ROM), or null
  get bareController() {
    const fdc = this.targetMachine && this.controller;
    return fdc && fdc !== this.targetMachine.fdc && !fdc.romBytes ? fdc : null;
  }
  // the disk system a disk mounted without a disk ROM uses: the one last chosen for this family, else the first
  bareChoice() {
    const choices = this.dosChoices().filter((c) => !c.builtin), saved = this.session.store.get(`diskDos.${this.targetMachine.profile.lineage}`);
    return choices.find((c) => c.id === saved) || choices[0] || null;
  }
  // The disk controller with no ROM, into an empty cartridge port: no reset, so the program running keeps going (the
  // board raises no line of its own). A cartridge in the port comes out, and the machine is powered up afresh, as
  // insertDos does: the program was running from that cartridge.
  plugBareController(choice) {
    const m = this.targetMachine;
    this.flush();
    const had = !!m.cartPort;
    m.insertCartridge(new devices[choice.controller]({}));
    if (had) {
      this.session.endWelcome();
      this.session.keys.clear();
      m.reset(true);
      this.session.acc = 0;
      this.session.poweredOn();
    }
    this.session.emit('disks');
  }
  // A disk controller plugged in without a ROM takes the disk ROM the user has added since: called by a reset and a
  // power cycle, before the machine restarts. The ROM goes into the board's socket when it is the same board; another
  // board (the Delta DOS cartridge for a Dragon controller) replaces it, with the disks moved across. Not while
  // NitrOS-9 runs: its floppy boot uses the controller without a ROM on purpose. -> the disk system put in, or null
  fitRom(m = this.targetMachine) {
    if (m !== this.targetMachine || this.session.nitros9Running) return null;
    const fdc = this.bareController, dos = fdc && this.preferredDos();
    if (!dos) return null;
    const rom = this.session.roms.get(dos.id).rom;
    if (dos.controller === fdc.type) {
      fdc.fitRom(rom);
      m.cartridgeChanged();
    } else {
      fdc.flush();
      const next = new devices[dos.controller]({ rom });
      const media = fdc.drives.slice(0, Math.min(fdc.fitted, next.fitted)).map((d) => (d.loaded ? d.media : null));
      m.insertCartridge(next);
      media.forEach((md, i) => { if (md) next.mount(i, md); });
    }
    this.session.store.set(`diskDos.${m.profile.lineage}`, dos.id);
    this.session.emit('disks');
    return dos;
  }
  // a disk ROM stored for the board in use, waiting for the next reset or power cycle to go in (the page says so)
  get romWaiting() { return !!this.bareController && !this.session.nitros9Running && !!this.preferredDos(); }
  // plug a disk cartridge in (whatever was in the port comes out) and power the machine up with it
  // ---------------- blank disks (Session.newDisk) ----------------
  // The sizes offered for a new disk: the usual ones of the disk system in use (or the one a mount would plug in),
  // in the format its images usually come in. [{ format, tracks, heads, size, label }]
  blankChoices() {
    const type = this.blankController();
    if (!type) return [];
    const kb = (t, h) => `${Math.round(t * h * 18 * 256 / 1024)}K`;
    const list = { dragonfdc: [['vdk', 40, 1], ['vdk', 40, 2], ['vdk', 80, 2]], premierfdc: [['vdk', 40, 1], ['vdk', 40, 2], ['vdk', 80, 2]],
      cocofdc: [['jvc', 35, 1], ['jvc', 40, 1], ['jvc', 40, 2]], alphafdc: [['vdk', 80, 2], ['vdk', 40, 2]] }[type] || [];
    return list.map(([format, tracks, heads]) => ({ format, tracks, heads, size: kb(tracks, heads),
      label: `${tracks} tracks, ${heads === 1 ? 'single' : 'double'}-sided (${kb(tracks, heads)})${type === 'cocofdc' && tracks === 35 ? ', as Disk BASIC formats' : ''}` }));
  }
  // the controller type a new disk is for: the one in use, else the preferred disk system's (null: no drives)
  blankController() {
    const fdc = this.targetMachine && this.controller;
    if (fdc) return fdc.type;
    const dos = this.dosChoices().find((c) => c.id === (this.preferredDos() || {}).id) || this.dosChoices()[0];
    return dos ? dos.controller : null;
  }
  // A new, empty disk (js/media/disk.js blankDisk) stored in the library and put in `drive`: `format` 'vdk', 'jvc'
  // or 'dmk'; tracks and sides the drive must take. name: the image's name (default disk-<n>.<format>, the first
  // free); a name already in the library is refused (a new disk never replaces one). -> the mount's message
  async newDisk(drive, { format, tracks, heads }, { name = null, writeProtected = false } = {}) {
    this.checkDrive(drive);
    const type = this.blankController();
    if (!type) throw new SessionError(`The ${this.targetMachine.profile.name} has no disk drives in CLOADM. Disks go in on the Dragons and the CoCos.`);
    if (!['vdk', 'jvc', 'dmk'].includes(format)) throw new SessionError(`A new disk is a VDK, JVC or DMK image, not "${format}".`);
    const kind = DRIVE_TYPES[FDC_BOARDS[type].drive];
    if (!Number.isInteger(tracks) || tracks < 1 || tracks > Math.min(kind.tracks, 82)) throw new SessionError(`Drive ${drive} takes disks of 1 to ${Math.min(kind.tracks, 82)} tracks, not ${tracks}.`);
    if (heads !== 1 && heads !== 2) throw new SessionError(`A disk has 1 or 2 sides, not ${heads}.`);
    let bytes;
    try { bytes = blankDisk(format, tracks, heads); } catch (e) { throw new SessionError(e instanceof DiskFormatError ? e.message : String(e)); }
    // one creation at a time (createExclusive): the name is chosen and checked, written and mounted before another
    // creation looks, so a second one sees this disk and is refused rather than replacing its bytes
    return this.session.library.createExclusive(async (askedAt) => {
      // What this creation's errors are reported under. The listing below is the only throw here that is not
      // already a SessionError naming the disk (the name checks here and importStored itself throw
      // SessionErrors, which mediaError hands on unchanged), so it is the one that needs a name. That name is the
      // one asked for, but it cannot always be one: with no name asked the name is CHOSEN FROM THIS LISTING
      // (disk-1.vdk and on), so a failing listing fails before a name exists, and a name that leaves nothing after
      // the prefix ("disks/") would make the message start with ": ". Both report as the creation itself: "A new
      // disk". The derivation happens before the listing so that a name mediaError refuses ("A disk image needs a
      // name.") is still raised first, as it was when the derivation moved inside the turn.
      const label = (name ? this.storeName(name).slice(DISK_PREFIX.length) : '') || 'A new disk';
      let listed;
      try { listed = await this.list(); } catch (e) { throw this.session.library.mediaError(e, label, DISK_PREFIX); }
      const stored = new Set(listed.map((d) => d.name));
      // on a store that does not tell cases apart, a name already there in another case is that same disk
      const taken = (n) => stored.has(n) || [...stored].some((s) => this.session.library.sameName(s, n));
      let full;
      if (name) {
        full = this.storeName(name);
        const base = full.slice(DISK_PREFIX.length);
        if (detectDiskFormat(bytes, base) !== format) throw new SessionError(`${base}: a ${format.toUpperCase()} image needs a name ending .${format === 'jvc' ? 'dsk' : format}.`);
        if (taken(full)) {
          const same = [...stored].find((s) => this.session.library.sameName(s, full));
          throw new SessionError(`There is already a disk named ${same.slice(DISK_PREFIX.length)} in your library: choose another name.`);
        }
      } else {
        const ext = format === 'jvc' ? 'dsk' : format;
        for (let n = 1; !full || taken(full); n++) full = `${DISK_PREFIX}disk-${n}.${ext}`;
      }
      // the name is decided: claim it before the next await (importStored's), so a rename cannot take it while
      // the blank is being written. (A name picked from the listing is claimed in the same step as the pick.)
      this.session.library.claimDiskName(full);
      try {
        const msg = await this.importStored(full, full.slice(DISK_PREFIX.length), bytes, drive, writeProtected, askedAt);
        return `New blank disk: ${msg}`;
      } finally { this.session.library.releaseDiskName(full); }
    });
  }
  insertDos(id) {
    const m = this.targetMachine, choice = this.dosChoices().find((c) => c.id === id);
    if (choice && choice.builtin) throw new SessionError(`The ${m.profile.name}'s disk interface is built in: no cartridge needed.`);
    if (!choice) throw new SessionError(`The ${m.profile.name} can't take ${cartridgeRoms[id] ? `the ${cartridgeRoms[id].name}` : `"${id}"`}.`);
    if (!choice.ready) throw new SessionError(`The ${choice.name} needs its ROM (${cartridgeRoms[id].roms[0].files.join(', ')}). Load the ROM file first.`);
    this.flush();
    this.session.endWelcome();
    this.session.keys.clear();
    m.insertCartridge(new devices[choice.controller]({ rom: this.session.roms.get(id).rom }));
    m.reset(true);
    this.session.acc = 0;
    this.session.store.set(`diskDos.${m.profile.lineage}`, id);
    this.session.poweredOn();
    this.session.emit('disks');
    return `${choice.name} inserted`;
  }
  // the cartridge a mount plugs in when none is: the last one chosen for this family, else the first with its ROM
  preferredDos() {
    const choices = this.dosChoices(), saved = this.session.store.get(`diskDos.${this.session.shownMachine.profile.lineage}`);
    return choices.find((c) => c.id === saved && c.ready) || choices.find((c) => c.ready) || null;
  }
  // The stored name for a disk the user asked for. What follows the prefix is the file's own name -- in the drives,
  // in the Library, and in every message -- so anything that is not one is refused: nothing after the prefix
  // ('disks/'), a trailing separator ('disks/a/'), whitespace only (' ', 'disks/ '), or the segment '.' or '..'
  // ('disks/.', 'disks/..', 'x/..' -- a folder store and OPFS can hold neither, and '..' must not reach the store;
  // libName refuses it for library names and this is the same rule). A leading dot in a real name ('.vdk') is a
  // file's name and stays allowed. Refused here because every door (importImage, newDisk, mount, importMedia)
  // goes through this, and a store that let one through would hold a blob named 'disks/' and say " in drive 0".
  storeName(name) {
    if (typeof name !== 'string' || !name) throw new SessionError('A disk image needs a name.');
    const full = this.storedName(name);
    if (!isDiskFileName(full.slice(DISK_PREFIX.length))) throw new SessionError('A disk image needs a name.');
    return full;
  }
  // The stored name of a disk that is ALREADY there, for reading it back. The rule above decides what CLOADM may
  // CREATE; it must not decide what it can READ. A store from an earlier build holds 'disks/ ' and
  // 'disks/sub/x.vdk' (main let both be renamed into place), and refusing to name them would strand them -- the same
  // fault as refusing a stored " a.vdk". So only the derivation is shared, not the check: nothing after the prefix
  // is still not a name at all, and '..' is still refused (it must never become a store path).
  storedName(name) {
    if (typeof name !== 'string' || !name) throw new SessionError('A disk image needs a name.');
    const full = name.startsWith(DISK_PREFIX) ? name : DISK_PREFIX + String(name).split(/[\\/]/).pop();
    const base = full.slice(DISK_PREFIX.length);
    if (!base || /(^|\/)\.\.(\/|$)/.test(base)) throw new SessionError('A disk image needs a name.');
    return full;
  }
  // drives this machine's controller has (the Alpha fits 2; a disk cartridge 4)
  get count() { const fdc = this.targetMachine && this.controller; return fdc ? fdc.fitted : 4; }
  checkDrive(drive) {
    const n = this.count;
    if (!Number.isInteger(drive) || drive < 0 || drive >= n) throw new SessionError(`There is no drive ${drive} (drives 0 to ${n - 1}).`);
  }
  // disk images in the store: [{ name, size, mtime }] (names with DISK_PREFIX)
  async list() { return this.session.media.list(DISK_PREFIX); }
  // a disk image from the user: checked, stored (replacing a stored image of that name that no drive holds)
  // and mounted -> message
  // The whole check-and-mount is one creation, so an import of a name a new disk is making waits for that disk and
  // then meets it in its drive instead of replacing its bytes.
  async importImage(name, bytes, drive = 0, { writeProtected = false } = {}) {
    this.checkDrive(drive);
    this.session.library.checkNotMoving();
    const full = this.storeName(name), base = full.slice(DISK_PREFIX.length);
    const format = detectDiskFormat(bytes, base);
    if (!format) throw new SessionError(`${base}: not a disk image CLOADM can read (VDK, JVC/DSK or DMK).`);
    try { diskGeometry(bytes, format); } catch (e) { throw new SessionError(`${base}: ${e.message}`); }
    return this.session.library.claimingDiskName(full, () => this.session.library.createExclusive((askedAt) => this.importStored(full, base, bytes, drive, writeProtected, askedAt)));
  }
  // the stored part of importImage, run as one creation. askedAt: the landing count when this creation was asked
  // for (see createExclusive), which tells a second creation of one name from a deliberate replace.
  async importStored(full, base, bytes, drive, writeProtected, askedAt = 0) {
    this.session.library.checkNotMoving();
    // a creation of this name landed after this one was asked for: it is a second creation of one name, and must
    // refuse rather than replace. This is also the same-drive case the holder checks below cannot see -- they
    // look for the image in a drive, and a creation's image may have been put in this very drive (the eject below
    // would remove it) or be about to be mounted after this operation read the drive as empty.
    // a creation of this name landed after this one was asked for -- a new disk, an import or a RENAME (all three
    // are creations: one at a time, in ask order) -- so this one is a second creation and refuses
    const raced = this.session.library.landedRace(full, askedAt);
    if (raced) throw new SessionError(`There is already a disk named ${raced.slice(DISK_PREFIX.length)} in your library: choose another name.`);
    const holder = this.holder(full, { machine: this.targetMachine, drive });
    if (holder) throw new SessionError(`${holder.name} is in drive ${holder.drive}${holder.where}; eject it there first.`);
    if (this.status().drives.some((d) => this.session.library.sameName(d.name, full))) await this.eject(drive);
    await this.writesDone();
    // checked again with nothing left to wait for: a mount of this name that went in meanwhile keeps its file
    const again = this.holder(full);
    if (again) throw new SessionError(`${again.name} is in drive ${again.drive}${again.where}; eject it there first.`);
    this.session.library.checkNotMoving();
    try { await this.storeChange(() => this.session.media.write(full, bytes), full); } catch (e) { throw this.session.library.mediaError(e, base, full); }
    // The name is stored, so from here on this creation lands it however it ends -- mounted, a mount that fails, or a
    // case probe that throws -- and it lands it only at the end: a creation asked at any point while this one runs
    // (askedAt below this landing) is waiting behind it and refuses, while one asked after it finished is a
    // deliberate replace. Landing straight after the write would let an import asked between the write and the end
    // count as a replace and take the name.
    try {
      await this.session.library.refreshCase();   // the store has a name now: it can put its case rule to the test
      // stored by now: a mount that fails says so, rather than that the import did not happen
      try { return await this.mount(drive, full, { writeProtected }); }
      catch (e) { throw new SessionError(`${base} was saved to your Library but not put in drive ${drive}: ${e.message}`); }
    } catch (e) {
      // What is left here (the case probe, above all) is reported as this creation's own error, named the way
      // importMedia names it (`base`, the stored name without its prefix), so both callers of this creation --
      // importImage and newDisk -- get the same form. A SessionError is handed on unchanged, which keeps the
      // creation's own messages exact: the "in drive N" refusals, and the mount failure just above, which already
      // names the disk. (A backend message that itself embeds the path therefore repeats it, exactly as
      // importMedia's has always done: mediaError adds the name to whatever the store said.)
      throw this.session.library.mediaError(e, base, full);
    } finally { this.session.library.creationLanded(full); }
  }
  // a stored disk image into a drive (plugging in the disk cartridge if none is) -> message
  // opts[<the Session's key>]: as for mountDriveWire (the caller's Library operation is what the move waits for)
  async mount(drive, name, opts = {}) {
    const { writeProtected = false } = opts, held = opts[this.#held] === true;
    this.checkDrive(drive);
    if (!held) this.session.library.checkNotMoving();
    const full = this.storedName(name), base = full.slice(DISK_PREFIX.length);
    const holder = this.holder(full, { machine: this.targetMachine, drive });
    if (holder) throw new SessionError(`${holder.name} is already in drive ${holder.drive}${holder.where}.`);
    let fdc = this.controller;
    if (!fdc && this.targetMachine.cartPort instanceof MultiPak) throw new SessionError('The Multi-Pak has no disk controller: put one in one of its slots first (Multi-Pak…).');
    // the disk cartridge a mount plugs in: the user's disk ROM's, else the controller alone (bare)
    const dos = fdc ? null : this.preferredDos(), bare = fdc || dos ? null : this.bareChoice();
    if (!fdc && !dos && !bare) throw new SessionError(`The ${this.targetMachine.profile.name} has no disk drives in CLOADM. Disks go in on the Dragons and the CoCos.`);
    // The image is read once every write is in the store: the drive's own (a disk mounted again in the drive it is
    // in must be the image that drive wrote) and every one queued, a restore's put-back included. The machine runs
    // while the store is read, so the read is taken only if nothing has been queued for THIS image since before the
    // wait (a write, an import, a rename or a delete of it, with the drive flushed again); otherwise it is read
    // again. "This image" follows the store's own case rule (sameName): on a store that holds 'disks/A.vdk' and
    // 'disks/a.vdk' as one file a change under either spelling is a change to it, and on one that keeps them apart
    // only its exact name is. A store whose rule is not measured yet is taken as case-insensitive, so the mount
    // reads again rather than keep bytes that may be stale. Nothing here waits between the count and the check, so
    // a change queued while the store is read cannot slip past it. Every change to this image, under any spelling
    // it shares, spends the four-read budget; another file's changes never do. The rule is taken once per pass, so
    // the count before and after a read are summed over the same names even if the store is measured meanwhile.
    const changesTo = (ci) => { let c = 0; for (const [n, k] of this.changes) if (this.session.library.sameName(n, full, ci)) c += k; return c; };
    let bytes, reads = 0;
    for (;;) {
      const flush = () => { const f = this.controller; if (f && f.drives[drive].loaded) f.drives[drive].flush(); };
      flush();
      // counted before the wait: a change to this image queued from here on (even in the step after the wait)
      // means read again
      const ci = this.session.library.caseInsensitive, before = changesTo(ci);
      await this.writesDone();
      try {
        const st = await this.session.media.stat(full);
        if (!st) throw new MediaStoreError('not-found', full);
        bytes = await this.session.media.readRange(full, 0, st.size);
      } catch (e) { throw this.session.library.mediaError(e, base, full); }
      flush();
      const moved = changesTo(ci) !== before;
      if (!moved) break;
      if (++reads > MOUNT_READ_RETRIES) throw new SessionError(`${base}: the drives kept writing while it was read; try again.`);
    }
    // from here on nothing waits, so what is checked is what the mount finds: another mount that went in meanwhile
    // (into another drive, or into this one) is seen
    const again = this.holder(full, { machine: this.targetMachine, drive });
    if (again) throw new SessionError(`${base} is already in drive ${again.drive}${again.where}.`);
    if (!held) this.session.library.checkNotMoving();
    const format = detectDiskFormat(bytes, base);
    if (!format) throw new SessionError(`${base}: not a disk image CLOADM can read (VDK, JVC/DSK or DMK).`);
    fdc = this.controller;
    if (!fdc) {
      if (this.targetMachine.cartPort instanceof MultiPak) throw new SessionError(`${base}: the disk cartridge was taken out; mount it again.`);
      if (dos) this.insertDos(dos.id); else this.plugBareController(bare);
      fdc = this.controller;
    }
    if (fdc.drives[drive].loaded) fdc.eject(drive);   // flushed above: nothing more to write
    try {
      this.unsaved.delete(full);        // read afresh from the store: nothing is outstanding
      fdc.mount(drive, { bytes, format, name: full, writeProtected, onWrite: this.link(full) });
    } catch (e) { throw new SessionError(`${base}: ${e.message}`); }
    this.checkLater(fdc.drives[drive]);
    this.session.emit('disks');
    const wp = writeProtected ? ' (write-protected)' : '';
    if (fdc === this.bareController) return `${base} is in drive ${drive}${wp}, ${BARE_NOTE}`;
    return `${base} in drive ${drive}${wp}`;
  }
  // A mounted drive works out whether a snapshot must carry its image as mounted (js/chips/floppy.js, get
  // mountBytes: a round trip through the disk format, about three times the cost of the mount) only when first
  // asked. Ask it here, in a task of its own once the mount has returned (setTimeout, so the Session stays
  // DOM-free), so that neither the mount nor the first snapshot after it (a restore point at the start of a Claude
  // turn, a share) pays for it. Outside emulation: it changes no machine state and no emulated time, and a
  // snapshot taken before it runs gets the same answer through the getter. A drive whose disk was changed or taken
  // out by then is left alone: its new mount has its own check. checked() resolves once every check asked for
  // so far has run.
  checkLater(drive) {
    const media = drive.media;
    const p = new Promise((resolve) => setTimeout(() => {
      try { if (drive.media === media) void drive.mountBytes; } finally { resolve(); }
    }, 0));
    this.checks.add(p);
    p.then(() => this.checks.delete(p));
  }
  checked() { return Promise.all([...this.checks]); }
  // A mounted disk's link to its stored image (media.onWrite). Each mount gets a link of its own, and the link is
  // the identity of that continuous mount of that stored image: link.mount = { id, name, writes (how many changes
  // the drive has handed to the store through it), failed (a write through it was refused and no whole image has
  // been written since: the stored image may lack it), readOnly (the store refused a write as not allowed), broken (the
  // stored image could not be put back after a restore: nothing more is written through it) }. A link is not part
  // of a snapshot: a restore point records the links (stored) and the restore relinks only the same mount.
  link(name) {
    const mount = { id: ++this.mounts, name, writes: 0, failed: false, readOnly: false, broken: false };
    const link = (offset, data, size) => { mount.writes++; this.queueWrite(name, offset, data, size, mount); };
    link.mount = mount;
    return link;
  }
  // the drives of machine m linked to the media store: [{ drive, name, link, writes (link.mount.writes now), wpt }]
  stored(m) {
    const fdc = this.controllerOf(m);
    return fdc ? fdc.drives.flatMap((d, i) => (d.loaded && d.media.onWrite && d.media.onWrite.mount
      ? [{ drive: i, name: d.media.name, link: d.media.onWrite, writes: d.media.onWrite.mount.writes, wpt: !!d.wpt }] : [])) : [];
  }
  // A restore point put back on machine m (Session.restoreClaude and the chat's undoLast both come here) -> the
  // notices for the person: [string], one per drive whose restored disk is not linked to the Library.
  // The point is checked first (a SessionError, nothing changed); the drives' changes go to the store first (the
  // restore replaces the drives, dirty tracks and all); a load that fails part way is rolled back to the machine as
  // it was, with its links. Then each drive the point holds linked to the store (pointDisks) is linked again ONLY if
  // the same mount (the same link) is still in that drive, i.e. the same continuous mount since the point: anything
  // else (ejected, replaced or changed in the Library, mounted again, in another drive) leaves the store alone and the
  // drive unlinked, with a notice. The same mount keeps the write protection the person has set now. A linked disk the machine wrote to since the point has the store image put back to
  // the image the drive holds now (whole, so the undone writes are not left mixed in), unless it is write-protected
  // or its stored file refused writes: then it is not written and comes back unlinked, with a notice. A disk not
  // written to since the point is not written at all.
  restorePoint(m, snap) {
    try { m.checkSnapshot(snap); } catch (e) { throw new SessionError(`Can't restore that point (${e.message}): nothing was changed, and your restore points are kept.`); }
    const fdc = this.controllerOf(m);
    if (fdc) fdc.flush();
    const before = m.snapshot(), linked = this.stored(m);
    try { m.loadSnapshotState(snap); } catch (e) {
      m.loadSnapshotState(before);
      const back = this.controllerOf(m);
      for (const x of linked) back.drives[x.drive].media.onWrite = x.link;
      throw new SessionError(`Can't restore that point (${e.message}): the machine was put back as it was, and your restore points are kept.`);
    }
    this.session.cancelLoadTyping(m);          // a load's EXEC still waiting was for the machine as it was
    const notices = this.relinkPoint(m, (this.session.claudePointInfo.get(snap) || {}).disks || [], linked);
    // A restore point is a loaded moment too, and goes back onto the same machine (no new Machine, no Reset): the
    // boot watchdog must not count 5 s from it either, or a point taken on a game would answer 'failed' with the
    // socket cause after Claude's undo. Machine.loadSnapshotState deliberately does not mark it (a boot-failure
    // moment carries its diagnosis in the snapshot), so the Session does, here, where the point's state is put
    // back. The latch is re-armed by the same frame rule every reset uses: the point's own frame is a new run.
    m.restored = true;
    // Announced as its own event, not 'reset': an undo is not a Reset, and the listeners that hear 'reset' (a
    // sound discontinuity, the drives card, the welcome shelf, the slots) must not act on a Reset that never
    // happened. boot-help listens for 'restored' and re-checks, so the "No OK" box raised by the run the undo took
    // away goes with it (restorePoint answers 'restored' for the machine now, so one check closes it).
    this.session.emit('restored');
    this.session.emit('disks');
    return notices;
  }
  relinkPoint(m, pointDisks, linked) {
    const fdc = this.controllerOf(m), notices = [];
    const unsaved = (drive, why) => notices.push(`Drive ${drive} ${why}; the restored disk isn't saved to the Library. Download it to keep it.`);
    for (const was of pointDisks) {
      const d = fdc && fdc.drives[was.drive];
      if (!(d && d.loaded && d.media.name === was.name)) continue;
      const now = linked.find((x) => x.drive === was.drive), mount = was.link.mount;
      if (!now || now.link !== was.link || mount.broken) { unsaved(was.drive, 'was changed since this point'); continue; }
      // the same mount: write protection is the person's setting for it, not the machine's, so it stays as it is now
      d.setWriteProtect(now.wpt);
      if (mount.writes === was.writes && !mount.failed) { d.media.onWrite = was.link; continue; }
      if (now.wpt) { unsaved(was.drive, 'is write-protected'); continue; }
      if (mount.readOnly) { unsaved(was.drive, 'is a read-only file'); continue; }
      d.media.onWrite = was.link;
      this.queueWrite(was.name, 0, d.media.bytes.slice(), d.media.bytes.length, mount, { drive: was.drive, machine: m });
    }
    return notices;
  }
  // The drive's changes, in order, to the stored image: in place, or the whole file when its size changed. mount: the
  // link's mount (a refused write marks it failed until a whole image is written; writes through a broken one are dropped: the stored image is no longer the drive's). rollback:
  // { drive, machine } for the whole image a restore puts back; if the store refuses it, the stored image is a mix
  // of two versions, so the mount is broken and the drive unlinked, and the error says the disk isn't saved.
  queueWrite(name, offset, data, size, mount = null, rollback = null) {
    this.noteChange(name);
    // the write's own outcome only: a listener's error is not the write's, and every write is counted as landed
    this.writing = this.writing.then(async () => {
      let cleared = false;
      try {
        if (!(mount && mount.broken)) {
          if (offset === 0 && data.length === size) await this.session.media.write(name, data);
          else await this.session.media.writeRange(name, offset, data);
          if (mount && offset === 0 && data.length === size) mount.failed = false;
          cleared = this.unsaved.delete(name);
        }
      } catch (e) { this.writeFailed(e, name, mount, rollback); } finally { this.landed++; }
      if (cleared) this.session.emitApart('disks');
    }).catch(() => {});
  }
  // what a refused disk write leaves: the mount marked, the error to report, the drive unlinked for a put-back
  writeFailed(e, name, mount, rollback) {
    if (mount) mount.failed = true;
    if (mount && e && e.code === 'unsupported') mount.readOnly = true;
    const base = name.slice(DISK_PREFIX.length);
    if (rollback) {
      mount.broken = true;
      const fdc = this.controllerOf(rollback.machine), d = fdc && fdc.drives[rollback.drive];
      if (d && d.loaded && d.media.onWrite && d.media.onWrite.mount === mount) d.media.onWrite = null;
      this.unsaved.delete(name);
      const why = this.session.library.mediaError(e, base, name).message.replace(/[.\s]+$/, '');
      this.addError(new SessionError(`Drive ${rollback.drive}: the Library's ${base} couldn't be put back to the restored disk (${why}); the restored disk isn't saved to the Library. Download it to keep it.`));
    } else {
      const err = this.session.library.mediaError(e, base, name);
      this.addError(err);
      this.unsaved.set(name, err.message);
    }
    this.session.emitApart('diskerror');
    this.session.emitApart('disks');
  }
  // A change the Library makes to the stored disk images (op: an import's write, a rename, a delete), run in the
  // same chain as the drives' writes, so a mount waiting for the chain reads after it lands, and one reading
  // meanwhile reads again (changes, for the names the change is to). Its failure goes to the caller only.
  // name: the stored name the change is to (for a rename, both the old and the new one). -> what op returns
  storeChange(op, name = null) {
    this.noteChange(name);
    const p = this.writing.then(op);
    this.writing = p.then(() => {}, () => {}).then(() => { this.landed++; });
    return p;
  }
  // A change to a stored disk image is queued: count it everywhere (writesSettled waits on that), and under
  // the exact names it is to, which a mount sums by the store's case rule to see whether its own image moved under
  // its read. (The map grows by distinct spelling, not by change; a session writes to finitely many names.)
  noteChange(name) {
    this.queued++;
    for (const n of [].concat(name || [])) if (n) this.changes.set(n, (this.changes.get(n) || 0) + 1);
  }
  // the disk changes queued now have landed (written or refused), without reporting a refusal
  async writesSettled() {
    const upTo = this.queued;
    while (this.landed < upTo) await this.writing;
  }
  // a refused disk write, reported once by writesDone: several pending are reported together, none dropped
  addError(err) { this.error = this.error ? new SessionError(`${this.error.message} ${err.message}`) : err; }
  // every drive's changes handed to the store now (they are written in the background)
  // (every machine with drives: in a full-screen chat the BASIC session beside the chat machine too)
  flush() { for (const { machine } of this.machines()) { const fdc = this.controllerOf(machine); if (fdc) fdc.flush(); } }
  // wait until the store has every change handed to it; a failed write is reported once, here
  // (the writes queued when it is called: one queued later is not waited for, so it always ends)
  async writesDone() {
    await this.writesSettled();
    const e = this.error;
    this.error = null;
    if (e) throw e;
  }
  async eject(drive) {
    this.checkDrive(drive);
    const fdc = this.controller;
    if (fdc) fdc.eject(drive);
    this.session.emit('disks');
    await this.writesDone();
  }
  setWriteProtect(drive, on) {
    this.checkDrive(drive);
    const fdc = this.controller;
    if (!fdc || !fdc.drives[drive].loaded) throw new SessionError(`Drive ${drive} is empty.`);
    fdc.setWriteProtect(drive, on);
    this.session.emit('disks');
  }
  // { dos: { id, name } | null, drives: [{ drive, name, file, writeProtected, size, stored, unsaved }] } for the
  // drives with a disk; stored: false for a disk that came with a snapshot (not linked to the store); unsaved:
  // why the store refused this image's last write (its changes are only in the drive until a write succeeds)
  // count: the drives there are (or will be once a cartridge goes in)
  status() {
    const fdc = this.targetMachine && this.controller;
    if (!fdc) return { dos: null, count: 4, drives: [] };
    const id = this.targetMachine.fdc === fdc ? 'builtin' : Object.keys(cartridgeRoms).find((k) => cartridgeRoms[k].controller === fdc.type);
    // bare: the controller holds no ROM (a disk mounted without a disk ROM)
    const bare = fdc === this.bareController;
    return {
      dos: { id, name: id === 'builtin' ? fdc.name : bare ? fdc.plainName : cartridgeRoms[id].name, bare },
      count: fdc.fitted,
      drives: fdc.drives.map((d, i) => (d.loaded ? { drive: i, name: d.media.name, file: d.media.name.split('/').pop(), writeProtected: !!d.wpt, size: d.media.bytes.length, stored: !!d.media.onWrite, unsaved: (d.media.onWrite && this.unsaved.get(d.media.name)) || null } : null)).filter(Boolean),
    };
  }
  // the drive lights: [lit, ...] per drive. A drive's light is on while it is selected, its motor runs and the
  // controller is busy with a command (it is reading, writing or stepping)
  activity() {
    const fdc = this.targetMachine && this.controller;
    if (!fdc) return [false, false, false, false];
    const busy = !!(fdc.wd.status & 1);
    return fdc.drives.slice(0, fdc.fitted).map((d) => busy && fdc.wd.floppy === d && d.mon === 0);
  }
  // The disk that came with a snapshot (not linked to the Library: status stored: false) saved to the Library under
  // its name, and the drive linked to it from then on, so what the machine writes goes there (R25: a switch takes it
  // out, and only the Library keeps it) -> message. A name the Library already has is refused: that is another disk.
  async keepSnapshot(drive) {
    this.checkDrive(drive);
    const fdc = this.controller, d = fdc && fdc.drives[drive];
    if (!d || !d.loaded) throw new SessionError(`Drive ${drive} is empty.`);
    const full = this.storeName(d.media.name), base = full.slice(DISK_PREFIX.length);
    if (d.media.onWrite) throw new SessionError(`${base} is already in your Library.`);
    const media = d.media;
    // A Library operation (libraryOp): a move that starts meanwhile waits for it, so it looks in and writes to the one
    // store, which the move then copies. The look and the write are one queued disk change (storeChange): when it
    // runs, the image is copied and the drive linked in one synchronous step, so a write the machine makes after it
    // goes to the store behind this one, never into the gap between them. It is queued under no name: no mount of this
    // image can be reading it meanwhile (one that waits for the queue finds the drive linked under the name and is
    // refused; one that read before finds no file), so a per-name count would change nothing.
    // (storeChange counts it in queued all the same, so writesSettled waits for it.)
    try {
      await this.session.library.libraryOp(() => this.storeChange(async () => {
        if (await this.session.media.stat(full)) throw new SessionError(`Your Library already has a disk named ${base}; download this one instead.`);
        if (fdc.drives[drive].media !== media || media.onWrite) throw new SessionError(`Drive ${drive} no longer holds that disk.`);
        d.flush();
        const bytes = media.bytes.slice(), oldName = media.name;
        media.name = full; media.onWrite = this.link(full);
        try { await this.session.media.write(full, bytes); } catch (e) { if (media.onWrite) { media.onWrite = null; media.name = oldName; } throw e; }
      }));
    } catch (e) { throw this.session.library.mediaError(e, base, full); }
    await this.session.library.refreshCase();
    this.session.emit('disks');
    return `Saved ${base} to your Library`;
  }
  // the image in a drive as it is now, written changes included -> { name, bytes }
  async download(drive) {
    this.checkDrive(drive);
    const fdc = this.controller;
    if (!fdc || !fdc.drives[drive].loaded) throw new SessionError(`Drive ${drive} is empty.`);
    fdc.drives[drive].flush();
    await this.writesDone();
    const m = fdc.drives[drive].media;
    return { name: m.name.split('/').pop(), bytes: m.bytes.slice() };
  }
  checkNotInDrive(name, what) {
    const held = this.holder(name);
    if (held) throw new SessionError(`${name.slice(DISK_PREFIX.length)}${held.name !== name ? ` (stored as ${held.name.slice(DISK_PREFIX.length)})` : ''} is in drive ${held.drive}${held.where}; eject it before you ${what} it.`);
  }
  // The machines whose drives can hold a stored disk now: the one in use and, in a full-screen chat, the BASIC
  // session beside the chat machine (it keeps its drives, and the Library's guards must see them while the chat is
  // on screen) -> [{ machine, where }], where: '' for the machine on screen, else how a message names it
  machines() {
    const out = this.session.shownMachine ? [{ machine: this.session.shownMachine, where: '' }] : [];
    const c = this.session.chatMachines;
    if (c) for (const m of [c.basic, c.chat]) if (m && m !== this.session.shownMachine) out.push({ machine: m, where: m === c.basic ? ' of your BASIC session' : ' of the chat machine' });
    return out;
  }
  // the drive that holds the disk image `name`, on any of those machines -> { drive, where, machine, name } | null;
  // skip: { machine, drive } not to count (the drive a mount is about to replace). On a store that does not tell
  // upper from lower case, `name` and what a drive holds are compared that way (see CASE, js/host/media-store.js).
  holder(name, skip = null) {
    for (const { machine, where } of this.machines()) {
      const fdc = this.controllerOf(machine);
      if (!fdc) continue;
      const drive = fdc.drives.findIndex((d, i) => d.loaded && this.session.library.sameName(d.media.name, name) && !(skip && skip.machine === machine && skip.drive === i));
      if (drive >= 0) return { drive, where, machine, name: fdc.drives[drive].media.name };
    }
    return null;
  }
}
