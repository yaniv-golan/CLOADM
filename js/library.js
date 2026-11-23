// The media library of a Session (session.library): what the person keeps in the media store, apart from the ROM
// and recent-program bookkeeping the media index owns (js/media/library.js). The Library screen's list, open,
// download, rename, delete and import; the recent list; the creations of disk names, one at a time, and the names
// they claim; the store's rule for upper and lower case (sameName); and moving all of it to another store
// (moveMedia, with the Library operations it waits for: libraryOp, checkNotMoving).
//
// The Session builds one with itself as its `session` (as session.disk and session.serial are): the store handle
// (session.media), the media index (session.index) and the ROM library stay the Session's, since they are services
// it hands to others; this re-points them when the library moves (useMediaStore). The floppy drives are the
// Session's too: the library asks it which disk a drive holds (diskHolder, checkNotInDrive) and has it queue a
// disk image's change behind the drives' writes (diskStoreChange). Nothing here is saved in a snapshot or a
// settings export.
import { SessionError } from './errors.js';
import { detectCaseSync, measureOnce } from './host/media-store.js';
import { MediaIndex, LIBRARY_PREFIX, INDEX_PREFIXES, INDEX_LISTS, romImage, RECENT_LENGTH, isLibraryName } from './media/library.js';
import { detectMedia } from './media/detect.js';
import { profiles } from './machines/profiles.js';
import { crc32 } from './util.js';

// floppy disk images live in the media store under this prefix (never in the media index)
export const DISK_PREFIX = 'disks/';
// A disk image's own file name (what follows the prefix): not empty, not whitespace ONLY, no separator, and not the
// segment '.' or '..' -- a name a folder store or OPFS cannot hold, and one that would climb out of its prefix.
// Surrounding spaces are part of the name and are kept: a store that already holds " a.vdk" (main wrote such names)
// must still be able to mount it, and a person who typed one meant it.
export const isDiskFileName = (base) => diskFileNameProblem(base) === null;
// Why `base` is not a disk image's file name -> the reason, or null when it is one. A rename's destination gets the
// reason (what is wrong with the name), the other doors the short "A disk image needs a name."
export const diskFileNameProblem = (base) => {
  if (typeof base !== 'string' || base.length === 0) return 'it is empty';
  if (/^\s+$/.test(base)) return 'it is empty or only spaces';
  if (/[\\/]/.test(base)) return 'it has a folder separator; a disk image is one file';
  if (base === '.' || base === '..') return 'it is only dots';
  return null;
};
// where DriveWire images live in the media store
export const DW_PREFIX = 'drivewire/';
// everything CLOADM keeps in a media store (what moving the library copies)
const STORE_PREFIXES = [LIBRARY_PREFIX, DISK_PREFIX, DW_PREFIX, ...INDEX_PREFIXES];
// how long moveMedia waits for the Library operations under way before it gives up on them. A move never copies
// the library out from under an import, a rename, a delete or a save it could not settle (see libraryOp); a store
// that stopped answering would otherwise hang the move for good, so the wait ends with an error and the session
// stays on the old store, with its library as it was.
export const MEDIA_MOVE_WAIT_MS = 30000;

// Does the store tell GAME.DSK from game.dsk? A store whose bytes are already in memory answers now (its class
// declares the fact, or a listing settles it); an asynchronous one is measured by the Session's ready(), so this
// starts at the safe answer (see CASE in js/host/media-store.js) and the guards here never compare names with ===
// without it.
const startingCase = (media) => (media.synchronous ? detectCaseSync(media) : (typeof media.caseInsensitive === 'boolean' ? media.caseInsensitive : true));

export class MediaLibrary {
  // session: the Session it belongs to. mediaMoveWaitMs: how long moveMedia waits for the Library operations
  // under way (MEDIA_MOVE_WAIT_MS); a test sets it short to prove the wait is bounded.
  constructor(session, { mediaMoveWaitMs = MEDIA_MOVE_WAIT_MS } = {}) {
    this.session = session;
    this.mediaMoveWaitMs = mediaMoveWaitMs;
    this._caseInsensitive = startingCase(session.media);
    this.mediaSince = Date.now();   // when this visit started using the store: reconnecting copies what it wrote since
    this.movingMedia = false;       // moveMedia is copying the library to another place
    this.movingOps = new Set();     // Library operations under way that the move waits for (libraryOp)
    this.moveDone = null;           // a promise resolved when the move under way ends (afterMove)
    this.creating = Promise.resolve();   // the creation of a library name in flight (createExclusive: newDisk, imports)
    this.creationsAsked = [];       // askedAt of each creation asked and not yet finished, oldest first (createExclusive)
    this.landing = 0;               // names creations have landed so far (each creation notes it when asked: createExclusive)
    this.pendingLands = [];         // { name, at }: names landed that a creation still queued may have to refuse
    this.diskClaims = new Map();    // stored name -> how many creations are making it (claimDiskName: a rename may not take one)
  }
  // Keep media in another store from now on, starting with an empty library there (the page does this with an
  // in-memory store when browser storage can't be opened or read). The media index's write-error listener stays.
  useMediaStore(media) {
    const writeError = this.session.index.writeError;
    this.session.media = media;
    this._caseInsensitive = startingCase(media);
    this.mediaSince = Date.now();   // when this visit started using the store: reconnecting copies what it wrote since
    this.session.index = new MediaIndex(media);
    this.session.index.writeError = writeError;
    this.session.roms.index = this.session.index;
  }
  // Keep the library somewhere else from now on: the Library's "Where your library is kept". Every file CLOADM
  // keeps in the current store (the library and its quick-save slots, disk images, DriveWire images, ROMs, recent
  // programs: STORE_PREFIXES; nothing else in a folder of the user's) is copied there first; a file the new place
  // already has is left as it is, and the old place keeps its copies, so nothing is lost either way. The index's
  // lists (ROM sockets and names, the recent list) change in place, so they are merged (MediaIndex.mergeInto):
  // this library's entries win, and with `reconnecting` (a folder that holds the library, reconnected after this
  // visit kept it in the browser) the folder's win except what changed in this visit. Refused while a stored
  // disk is in a drive, since the drives read and write it where it is kept now (checked at the start, and again
  // after the waits below, right before the copy: checkNoStoredMounts).
  // A copy that fails leaves the session on the old store.
  // The library must not change while it is copied, and it must not be copied out from under what is already
  // writing to it: the move waits for the Library operations under way (libraryOp: imports, renames, deletes,
  // saves) to settle first - whichever way each one ends (a failure is its caller's to report) - and while it
  // copies every new one is refused (checkNotMoving: "try again once it is done"). The wait is bounded
  // (MEDIA_MOVE_WAIT_MS): a store that stops answering ends it with an error, and nothing is moved.
  // -> { copied, kept }: how many files were copied, and how many the new place already had
  async moveMedia(store, { reconnecting = false } = {}) {
    this.checkNoStoredMounts();
    let copied = 0, kept = 0;
    if (store === this.session.media) return { copied, kept };
    if (this.movingMedia) throw new SessionError('The library is being moved already.');
    // The operations under way are taken now, in the same step as both checks, so nothing starts between them; the
    // marker is set now too, so nothing that starts from here on can slip past either (its own guard refuses it).
    const waiting = [...this.movingOps];
    this.movingMedia = true;
    let done;
    this.moveDone = new Promise((resolve) => { done = resolve; });
    this.moveDone.then(() => {}, () => {});
    try {
      // the disks' last writes, and the Library operations, under the one bound: either can be stuck on a store
      // that stopped answering (a disks/ rename or import runs in the disks' chain too), and neither may hang the
      // move for good. One deadline for both: the whole wait is bounded by mediaMoveWaitMs, not twice it
      const deadline = Date.now() + this.mediaMoveWaitMs;
      await this.boundedWait(this.session.diskWritesSettled(), 'The drives are still writing to the library', deadline);
      await this.libraryWritesSettled(waiting, deadline);
      // ...and checked again now that they have: an operation the move waited for can have left a drive mounted
      // on the old store (the guest's DriveWire create hands out its drive inside its Library operation). Copying
      // now would leave that drive writing to the store the session is about to leave, so the move is refused
      // instead, with nothing copied and the session where it was.
      this.checkNoStoredMounts();
      return await this.copyMedia(store, reconnecting);
    } finally { this.movingMedia = false; this.moveDone = null; done(); }
  }
  // a move is refused while a drive reads and writes a stored image where the library is kept now: a disk in a
  // floppy drive, or a DriveWire drive (the user's mount, or the guest's named object)
  checkNoStoredMounts() {
    const busy = this.session.diskMachines().flatMap(({ machine, where }) => this.session.storedDisks(machine).map((d) => `drive ${d.drive}${where}: ${d.name.split('/').pop()}`))
      .concat(this.session.driveWireMounts.map((d) => `DriveWire drive ${d.drive}: ${d.name}`));
    if (busy.length) throw new SessionError(`Eject the disks first (${busy.join(', ')}): they are read and written where the library is kept now.`);
  }
  // `work` done, or `deadline` (a Date.now() value) reached: what it waits on never ended (a store that stopped
  // answering). The first wait is given the deadline itself, so the two together stay within the one bound.
  // A deadline already reached (the first wait used it all) is not a failure on its own: work that is settled when
  // the race is set up wins over the 0 ms expiry, so a second wait with nothing outstanding does not fail a move
  // that was in time; a wait still pending then is expired. It returns nothing: the work's value is the caller's.
  async boundedWait(work, what, deadline) {
    let timer = null;
    const left = Math.max(0, deadline - Date.now());
    const tooLong = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SessionError(`${what} and did not finish: the move was stopped and your library is where it was. Try again once it is done.`)), left);
      // (not unref'd: while it waits this timer is what ends the wait, so it must keep the process alive)
    });
    try { await Promise.race([work, tooLong]); } finally { clearTimeout(timer); }
  }
  // the Library operations in `waiting` have settled (finished or failed; their entry is gone from movingOps),
  // or the move's deadline has passed and the move gives up: an operation that never ends (a store that stopped
  // answering) fails the move with a message and leaves the session on its old store
  async libraryWritesSettled(waiting, deadline) {
    if (!waiting.length) return;
    await this.boundedWait(Promise.all(waiting), `The library is still being written to (${waiting.length} operation${waiting.length === 1 ? '' : 's'})`, deadline);
  }
  // A Library operation that writes, renames or deletes in the store, run so that the move waits for it and it
  // does not start while the move is copying. -> run()'s value; run's failure is the caller's (a move that waited
  // for it keeps going: the operation says what went wrong to its own caller, and the move copies what is there).
  // The caller has checked the move is not on (checkNotMoving) and taken whatever else it needs to read from the
  // store BEFORE this call: once it is async, a move may begin before its first await, and then its store is the
  // old one while the session uses the new one. Between the check and this call nothing awaits, so neither can a
  // move begin.
  async libraryOp(run) {
    if (this.movingMedia) throw new SessionError('The library is being moved: try again once it is done.');
    // registered synchronously, and only then started: a move that begins now (it cannot, this step runs to its
    // first await) or already began (checked above) sees this, and its guard is the one that refuses.
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    this.movingOps.add(settled);
    try {
      const p = (async () => run())();
      p.then(() => {}, () => {});   // its failure is the caller's (below), not a rejection nothing listens to
      return await p;
    } finally { this.movingOps.delete(settled); settle(); }
  }
  async copyMedia(store, reconnecting) {
    let copied = 0, kept = 0;
    await this.session.index.flush();
    const files = [];
    for (const prefix of STORE_PREFIXES) files.push(...await this.session.media.list(prefix));
    // Reconnecting, the folder is the library and the browser held it only for this visit: what the browser had
    // from before is stale (copying it would bring back what was deleted from the folder), so only the files
    // written in this visit go across, with the ROM images the sockets set in this visit use.
    const images = reconnecting ? new Set([...this.session.index.changedImages()].map(romImage)) : null;
    const wanted = (f) => !reconnecting || f.mtime >= this.mediaSince || images.has(f.name);
    for (const f of files) {
      if (INDEX_LISTS.includes(f.name) || !wanted(f)) continue;   // the lists are merged below, not kept or replaced whole
      if (await store.stat(f.name)) { kept++; continue; }
      try { await store.write(f.name, await this.session.media.read(f.name)); } catch (e) { throw this.mediaError(e, f.name, f.name); }
      copied++;
    }
    // the index's lists, merged: a move takes this library's entries, reconnecting the folder's except what
    // changed in this visit
    try { copied += await this.session.index.mergeInto(store, { ours: reconnecting ? 'changed' : 'all' }); } catch (e) { throw this.mediaError(e, 'the ROM and recent lists'); }
    this.useMediaStore(store);
    await this.session.index.load();
    await this.measureCase();   // the new store's own answer: another file system can tell cases apart where this one did not
    // every DriveWire server the Session made reads and writes the store it is serving from: this one, and the ones
    // serveRealCoco and the full-screen chat built (they outlive their links, and are used from the drives the
    // drives list shares). A move that retargeted only the Becker port's left them on the old place.
    for (const server of this.session.dwServers()) server.store = store;
    this.session.emit('roms');
    this.session.emit('storage');
    return { copied, kept };
  }

  // no disk goes in while the library is being moved (moveMedia): it would be read from one place and written to the other
  // (nor does the Library change anything: the copy would miss it, and the library moved to would not have it)
  checkNotMoving() { if (this.movingMedia) throw new SessionError('The library is being moved: try again once it is done.'); }
  // The last few programs, tapes and cartridges loaded (bytes kept for items up to 1 MB).
  // `copy` labels the rows that need telling apart, for two entries of ONE name — grouped with this.sameName,
  // the store's own rule, so a store that tells cases apart does not group "GAME.BIN" with "game.bin" — that
  // have different bytes: the newest is copy === false, the rest are later copies and get an ordinal (the
  // SECOND '2nd', the THIRD '3rd', or 'older copy' past that). A name with a single entry is never labelled,
  // and `copy` is null for it: there is nothing to tell it from.
  recentMedia() {
    const list = this.session.index.recentMedia();
    // sameName is a folding rule, not an equivalence-key function (on a case-sensitive store it is ===), so
    // entries are grouped by comparing against the names already seen rather than by a lower-cased key.
    // Grouped by NAME and MACHINE: the drawer shows one machine's rows (drawer.js filters by machine), so two of
    // one name on different machines are not copies of each other -- a lone Dragon row must not read "2nd".
    const groups = [];   // [{ name, machine, members: [] }]
    for (const r of list) {
      let g = groups.find((x) => x.machine === r.machine && this.sameName(x.name, r.name));
      if (!g) { g = { name: r.name, machine: r.machine, members: [] }; groups.push(g); }
      g.members.push(r);
    }
    const label = new Map();
    for (const g of groups) {
      if (g.members.length < 2) continue;
      g.members.forEach((r, n) => label.set(r, n === 0 ? false : n === 1 ? '2nd' : n === 2 ? '3rd' : 'older copy'));
    }
    return list.map((r) => Object.assign({}, r, { copy: label.has(r) ? label.get(r) : null }));
  }
  // A full store is not an error here: the program is loaded already, and the entry says its bytes were not kept.
  // While the library moves, the index's two writes wait for it (afterMove): made against the old place now they
  // would be the ones the move leaves behind, and they go to the index's store, which is the new place by then.
  // The list is this visit's at once (the program ran), so the Media tab and "Last time" see it.
  rememberMedia(name, bytes) {
    const crc = crc32(bytes);
    // Identity is the NAME (by this.sameName, the store's own case rule) plus the CONTENT HASH: this load
    // replaces the entry with the same name and the same bytes. Two things follow, and both are deliberate:
    //  - the SAME NAME with DIFFERENT bytes stays as its own entry. Each entry has its own blob (a blob is
    //    named by its CRC) and loadRecent gives each row its own bytes (measured), so the older row is not a
    //    lie about the newer one; the list labels it (see recentMedia).
    //  - a RE-NAMED copy of the same bytes keeps its own entry too: a hash-only key would swallow it.
    // A stored CRC may be in either case (an older build wrote it lower case); the index normalises the
    // entries it reads, and compared here case-insensitively they are the same blob.
    const list = this.session.index.recentMedia().filter((r) => !(this.sameName(r.name, name) && String(r.crc).toUpperCase() === crc));
    const dropped = list.splice(RECENT_LENGTH - 1);
    list.unshift({ name, crc, size: bytes.length, machine: this.session.shownMachine.id, stored: bytes.length <= 1 << 20 });
    const entry = list[0];
    // the two writes that go to the store. Made now, against the old place, while the library is moving, they are
    // the ones the move leaves behind: then they are made once it is done, and if the new place is full the entry
    // says so (the bytes are not kept), as the immediate path does.
    const write = (entry) => {
      // A blob is named by its CRC and can back MORE than one row: a renamed copy of the same bytes keeps its own
      // entry with the same CRC. So an evicted entry's file may still be the only copy for a survivor, and dropping
      // it would leave that row stored:true with nothing behind it (measured: the row then fails to load, even
      // after a reload). Only a CRC no surviving entry references is deleted.
      const kept = new Set(list.map((r) => String(r.crc).toUpperCase()));
      for (const old of dropped) if (!kept.has(String(old.crc).toUpperCase())) this.session.index.dropRecent(old.crc);
      try { if (entry.stored) this.session.index.putRecent(crc, bytes); }
      catch (e) { if (!(e && e.code === 'quota')) throw e; entry.stored = false; this.session.index.recentBytes.delete(crc); }
      this.session.index.setRecent(list);
    };
    if (this.movingMedia) {
      this.session.index.recentBytes.set(crc, bytes); this.session.index.recent = list;   // this visit's list at once
      this.afterMove(() => write(entry)).catch(() => {});
    } else try { write(entry); } catch (e) { if (!(e && e.code === 'quota')) throw e; }
  }
  // run() once the move in progress, if any, is done: for an index write that can wait (the in-memory list already
  // changed), so it reaches the store the session uses then, never the old one after the move began. A failed move
  // changes nothing, so the write is still the right one.
  async afterMove(run) {
    while (this.movingMedia) await this.moveDone;
    return run();
  }
  // load a recent item again (on the machine it was loaded on) -> message
  loadRecent(i = 0) {
    const r = this.recentMedia()[i];
    const data = r && r.stored && this.session.index.recentData(r.crc);
    if (!data) throw new SessionError('That file is no longer stored in this browser; load it again.');
    if (r.machine !== this.session.shownMachine.id && profiles[r.machine]) this.session.switchMachine(r.machine);
    return this.session.load(r.name, data);
  }

  // ---------------- the media library (what the Library screen will call) ----------------
  // User media lives under LIBRARY_PREFIX ('library/'), apart from the index's own names (roms/, recent/,
  // meta/). Every method here touches only that prefix: the ROM and recent blobs belong to the index and
  // changing them behind its back would leave it stale (or corrupt it), so a name outside the prefix is
  // refused rather than accepted.
  // The user's media is under two prefixes: LIBRARY_PREFIX for everything loaded or added, and DISK_PREFIX for
  // floppy disk images, which drives read and write in place. A name with either prefix is
  // taken as it is; a bare name goes under LIBRARY_PREFIX.
  libName(name) {
    const disk = typeof name === 'string' && name.startsWith(DISK_PREFIX) && name.length > DISK_PREFIX.length;
    const root = disk || (name && name.startsWith(LIBRARY_PREFIX)) ? name : LIBRARY_PREFIX + name;
    // no ".." segment: a name must not be able to climb out of its prefix
    if ((!disk && !isLibraryName(root)) || /(^|\/)\.\.(\/|$)/.test(root)) throw new SessionError(`${name}: not a media library name`);
    return root;
  }
  // Everything the user's media holds (the library and the disk images), with sizes and modification times ->
  // [{ name, size, mtime }] sorted by name (the index's own blobs are not listed: they are not the user's media)
  async listMedia() {
    const all = [...await this.session.media.list(LIBRARY_PREFIX), ...await this.session.media.list(DISK_PREFIX)];
    return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  // read a stored blob by name -> Uint8Array (throws SessionError when it is gone)
  async openMedia(name) {
    const full = this.libName(name);
    try { return await this.session.media.read(full); } catch (e) { throw this.mediaError(e, name, full); }
  }
  // { name, bytes } to save the user's file with (the Library's download, and the fallback's "keep")
  async downloadMedia(name) { return { name: name.split('/').pop(), bytes: await this.openMedia(name) }; }
  // a rename keeps the item under its prefix: `to` is a bare name or a name under the same prefix
  // A disk image in a drive is the drive's: the drive reads it and writes back to it under that name, so it is not
  // renamed, deleted or replaced while it is there -> refuses with the drive it is in
  // Name comparisons here follow the store: on a store that does not tell upper from lower case (see CASE in
  // js/host/media-store.js) GAME.DSK and game.dsk are one file, so they are one name to every guard below.
  // ci: the rule to compare by (default: the store's rule now); a caller that must compare twice by one rule passes it
  sameName(a, b, ci = this.caseInsensitive) { return ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; }
  // A new disk (newDisk) and an import (importDisk, importMedia) make a name that did not exist, and each checks
  // the library before it writes. The check and the write are apart by awaits -- the listing of what is stored,
  // the wait for the drives' writes -- so two creations can both pass the check, and the later write replaces the
  // earlier one's bytes under the same name: a blank disk held at its read-back was replaced by an import of its
  // name, and the mount that then read it back had nothing to mount. (Choosing the first free name can await a
  // listing of its own, so even a name reserved straight after the check could be taken before it was written.)
  // Creations therefore run one at a time (createExclusive): the second waits for the first to have written -- or
  // failed -- and then checks again, so it is refused with the library's "already exists" as it would have been
  // had it come second, and never takes the name or its bytes. Files, slots and DriveWire images are made by
  // writes that replace (a file is imported again as a newer version of itself), so only these creations are
  // serialised.
  // -> what op returns
  // The creation in flight runs op, then the next one runs. newDisk does not come back through here: it holds the
  // turn already and calls the stored half (importDiskStored) directly, because re-entering would wait on its own
  // turn and never finish.
  //
  // Two creations of one name must not both pass their check: the later write replaces the earlier one's bytes
  // under the same name. Serialising them is not enough -- the second must know it is a SECOND creation and not a
  // deliberate replace -- and the fact that tells them apart is the order of asking:
  //   * a creation asked while a creation of that name was in flight is a second creation of it: if that one lands
  //     the name, this one refuses;
  //   * an import asked after the name is already in the library is a replace (a disk in a drive taking a newer
  //     copy of itself), which is what importDisk has always done, and stays allowed.
  // Names are compared with this.sameName -- the store's own rule (CASE in js/host/media-store.js) -- never with a
  // key computed once: the store's rule can be learned (refreshCase) between asking and landing, and a key made
  // under one rule then compared under another reopens the hole. The names in flight are kept as the raw strings
  // they were asked with; a creation waiting for a name is tested against them with sameName at the moment it is
  // asked, and again when its turn comes (so a name a new disk picks inside its turn is seen too).
  // `askedAt`: how many names creations had LANDED when this one was asked for. A name landed after that is one
  // this creation was waiting behind.
  // There is no deadline on a turn. A creation whose store write never answers holds every later creation, as a
  // hung store write already holds a mount or a library move: giving up on the wait would not stop the write, which
  // could then land, mount and claim the name alongside the creations let in after it. An honest wait keeps the
  // one-at-a-time guarantee; a store that never answers is the store backend's to fix.
  // A disk creation's name, claimed while it is being made (newDisk, importDisk, importMedia): the name it will
  // write, marked BEFORE the creation's first await that can let another Library action in, and released when it
  // ends. A rename onto a claimed name is refused instead of racing the write. A newDisk with no name has none to
  // claim until its listing has picked one; that far a rename cannot be blocked, and a name the listing picked is
  // claimed in the same step it is picked (nothing awaits between the pick and the claim).
  claimDiskName(full) { this.diskClaims.set(full, (this.diskClaims.get(full) || 0) + 1); }
  // counted, not a Set: two creations of one name can be in flight (the second is refused at its turn, but it holds
  // its claim until then), and the first to end must not release the second's claim
  releaseDiskName(full) {
    const n = this.diskClaims.get(full);
    if (n === undefined) return;
    if (n > 1) this.diskClaims.set(full, n - 1); else this.diskClaims.delete(full);
  }
  // run a disk creation with its name claimed until it ends (whatever it ends with)
  claimingDiskName(full, run) {
    this.claimDiskName(full);
    let p;
    try { p = Promise.resolve(run()); } catch (e) { this.releaseDiskName(full); throw e; }
    return p.finally(() => this.releaseDiskName(full));
  }
  claimedDiskName(full) { for (const n of this.diskClaims.keys()) if (this.sameName(n, full)) return true; return false; }
  createExclusive(op) {
    const askedAt = this.landing;
    this.creationsAsked.push(askedAt);
    const run = this.creating.then(() => op(askedAt), () => op(askedAt));   // after the one in flight, however it ended
    this.creating = run.then(() => this.creationFinished(), () => this.creationFinished());
    return run;
  }
  // the oldest creation (they run in the order asked) is done: drop the landings no creation still queued can be
  // behind -- one only refuses a landing after its own askedAt, and the oldest queued one has the smallest askedAt
  // (landing only grows) -- so pendingLands holds at most the landings made while some creation was queued
  creationFinished() {
    this.creationsAsked.shift();
    const oldest = this.creationsAsked[0];
    this.pendingLands = oldest === undefined ? [] : this.pendingLands.filter((p) => p.at > oldest);
  }
  // has a creation in flight that this one was waiting behind already landed this name? -> the spelling it was
  // stored with by the latest such landing (for the refusal's message), or null
  landedRace(full, askedAt) {
    for (let i = this.pendingLands.length - 1; i >= 0; i--) {
      const p = this.pendingLands[i];
      if (p.at <= askedAt) break;
      if (this.sameName(p.name, full)) return p.vacated ? null : p.name;
    }
    return null;
  }
  // a creation has stored `full` and finished: count it, so a creation waiting behind it refuses (createExclusive)
  creationLanded(full) {
    this.landing++;
    this.pendingLands.push({ name: full, at: this.landing });
  }
  // a rename moved an image AWAY from `full`: the name is free again, so a creation waiting behind it must not read
  // an earlier landing of that name as still taken (A->X then X->Y leaves x.vdk free for an import behind both).
  // Recorded as a landing of a name that is no longer there, which landedRace treats as "not taken" by this one.
  nameVacated(full) {
    this.landing++;
    this.pendingLands.push({ name: full, vacated: true, at: this.landing });
  }
  // Does this library treat GAME.DSK and game.dsk as one name? The store's own settled answer wins: a real
  // backend measures itself inside every list() (js/host/media-store-fsa.js _case), so the store can be settled by
  // a route this Session did not take. Answering from the store whenever it has been measured is what keeps the
  // two from drifting; the Session's own value is only the fallback while the store has no answer yet.
  get caseInsensitive() {
    const store = this.session.media;
    if (typeof store.caseInsensitive === 'boolean' && store.caseMeasured) return store.caseInsensitive;
    return this._caseInsensitive;
  }
  set caseInsensitive(v) { this._caseInsensitive = v; }
  // Measure the store's rule now. Read-only (nothing is written to the user's folder). An empty store has nothing
  // to put the question with: the measurement leaves it unmeasured (safe answer), and the question is put again when
  // the store first gains a name (refreshCase).
  async measureCase(store = this.session.media) {
    // one path: measureOnce shares a measurement already in flight, so the Session and a listing that is measuring
    // the same store wait on the same answer rather than starting a second one
    if (store.synchronous) detectCaseSync(store); else await measureOnce(store);
    return this.caseInsensitive;
  }
  // The same, when the store has just gained a name: an empty store's safe answer (case-insensitive) can be
  // measured properly now there is a name to put the question with. Once measured it is not measured again (a
  // store's answer is a property of the file system, not of what is in it).
  async refreshCase() {
    // one question, asked the one way it is asked anywhere (js/host/media-store.js detectCase): an empty store
    // comes out unmeasured, and the next write asks again. Nothing here resolves a name through a path, so a
    // folder whose directory spelling differs from what was asked for cannot decide it.
    const store = this.session.media;
    await (store.synchronous ? detectCaseSync(store) : measureOnce(store));
    return this.caseInsensitive;
  }
  async renameMedia(from, to) {
    const src = this.libName(from), prefix = src.startsWith(DISK_PREFIX) ? DISK_PREFIX : LIBRARY_PREFIX;
    this.checkNotMoving();
    this.session.checkNotInDrive(src, 'rename');
    const dst = this.libName(to.startsWith(DISK_PREFIX) || to.startsWith(LIBRARY_PREFIX) ? to : prefix + to);
    if (!dst.startsWith(prefix)) throw new SessionError(`${to}: a ${prefix === DISK_PREFIX ? 'disk image' : 'library item'} stays where it is`);
    // The destination is a name this operation MAKES, so a disk image's must be a file's own name, as every other
    // door that makes one insists -- and the refusal says what is wrong with it. Without this a rename to ' ' stored
    // 'disks/ ' and a rename to 'sub/x.vdk' stored 'disks/sub/x.vdk': names no mount could read back.
    if (prefix === DISK_PREFIX) {
      const problem = diskFileNameProblem(dst.slice(DISK_PREFIX.length));
      if (problem) throw new SessionError(`${to}: not a disk image name: ${problem}.`);
    }
    // A disk image's move runs as one CREATION, like a new disk or an import: one at a time, in the order each was
    // asked, and its turn comes after every creation queued before it has ENDED. Two holes on main close with it:
    //   - a rename onto a name a creation is making is refused above, before the queue (that creation's turn ends
    //     before this rename's starts, so it is the creation's name while it lasts);
    //   - a creation asked while this rename is queued runs after the rename has RUN, so its listing sees the moved
    //     image under the new name and does not choose it. (On main the creation chose the name from a listing made
    //     before the queued rename ran, and wrote its own bytes over the renamed image.)
    const claim = prefix === DISK_PREFIX;
    if (claim && this.claimedDiskName(dst)) throw new SessionError(`${to}: a disk is being made under that name: try again once it is done.`);
    // A case-only rename on a store that does not tell cases apart cannot be done: it is one file, and the
    // store's write-then-remove would replace it and then delete it. (The name is the name it already has.)
    if (this.caseInsensitive && dst !== src && dst.toLowerCase() === src.toLowerCase()) {
      throw new SessionError(`${to}: this ${this.session.media.kind === 'fsa' ? 'folder' : 'storage'} does not tell upper from lower case, so ${src.slice(prefix.length)} and ${to} are the same name.`);
    }
    const op = () => this.session.media.rename(src, dst);
    const run = async () => {
      const r = await this.libraryOp(() => (src.startsWith(DISK_PREFIX) ? this.session.diskStoreChange(op, [src, dst]) : op()));
      // the rename took `dst`: land it, so a creation queued behind this one sees the name as taken (landedRace)
      // and refuses, rather than reading it as a deliberate replace and writing its own bytes over the renamed
      // image. And it vacated `src`: a creation queued behind must not read an earlier landing of that name as
      // still taken. Both only on success: a rename that failed took nothing and vacated nothing.
      if (claim) { this.creationLanded(dst); this.nameVacated(src); }
      return r;
    };
    try {
      return await (claim ? this.createExclusive(() => run()) : run());
    } catch (e) { throw this.mediaError(e, from, src); }
  }
  async deleteMedia(name) {
    const full = this.libName(name);
    this.checkNotMoving();
    this.session.checkNotInDrive(full, 'delete');
    const op = () => this.session.media.remove(full);
    try {
      return await this.libraryOp(() => (full.startsWith(DISK_PREFIX) ? this.session.diskStoreChange(op, full) : op()));
    } catch (e) { throw this.mediaError(e, name, full); }
  }
  // take a file the user picked into the library under `name`; ROM images go through identification, so
  // they land in the index's own sockets rather than being written as an opaque blob; disk images go under
  // DISK_PREFIX, where the drives find them
  async importMedia(name, bytes) {
    this.checkNotMoving();
    if (this.session.constructor.isRom(name, bytes)) return { roms: this.session.addRoms([{ name, bytes }]) };
    // the file's own name is the last segment; anything that is not a file name (a path ending in a separator, a
    // whitespace-only name, '.', '..') leaves nothing to name the file with. A disk image is refused as a disk
    // (diskStoreName's rule, reached through this door too); anything else is refused as a file -- what it is is
    // decided by its bytes, not by the missing name.
    const base = name.split(/[\\/]/).pop();
    const kind = detectMedia(base, bytes).kind;
    if (!base || !isDiskFileName(base)) throw new SessionError(kind === 'disk' ? 'A disk image needs a name.' : 'A file needs a name.');
    const target = kind === 'disk' ? DISK_PREFIX + base : this.libName(name);
    this.session.checkNotInDrive(target, 'replace');   // synchronous, so it needs no creation's turn: a disk in a drive is not replaced
    // non-disk media (programs, ROMs) are made by writes that replace, so they take no creation's turn; a disk
    // image may replace one of its name, but not take a name a new disk (or another import) is making: it runs as
    // one creation, ordered behind that one, and checks again (createExclusive)
    const disk = target.startsWith(DISK_PREFIX);
    // this runs when the creation's turn comes, which may be long after the caller was let in: a library move may
    // have started meanwhile, and writing now would put the image in the folder it is moving away from. It runs as a
    // Library operation, whose own check refuses it then (and which the move waits for once it has started).
    if (disk) this.claimDiskName(target);   // before the creation's first await: a rename may not take the name it is making
    const write = (askedAt) => this.libraryOp(async () => {
      // a creation of this name landed after this one was asked for: a second creation of one name, refused rather
      // than replacing it
      const raced = this.landedRace(target, askedAt);
      if (raced) throw new SessionError(`There is already a disk named ${raced.slice(DISK_PREFIX.length)} in your library: choose another name.`);
      this.session.checkNotInDrive(target, 'replace');   // again, now no creation of the name is in flight
      const r = await (disk ? this.session.diskStoreChange(() => this.session.media.write(target, bytes), target) : this.session.media.write(target, bytes));
      // stored: landed however the rest ends, and only at the end (as importDiskStored)
      // the store has a name now: on an empty store that is the first chance to put its case rule to the test (a
      // read of the store it was written to, so inside the same Library operation)
      try { await this.refreshCase(); } finally { if (disk) this.creationLanded(target); }
      return { stored: r };
    });
    // What a failure is reported under. A disk image is stored under its own file name, so that is what the drives and
    // the Library show; any other file is stored under the path the person dropped (library/dir/prog.bin), so its
    // name is the stored one without the library prefix -- what the Library lists, not just the leaf.
    const shown = disk ? base : target.slice(LIBRARY_PREFIX.length);
    try { return disk ? await this.createExclusive(write) : await write(0); } catch (e) { throw this.mediaError(e, shown, target); }
    finally { if (disk) this.releaseDiskName(target); }
  }
  // A store failure as the user should read it, named once. `name` is what the person sees (their file's own name);
  // `stored` is the store's name for the file this operation works on, when the caller knows it -- and the caller
  // always does: it is the name it just asked the store about. Nothing is guessed from the message: the two real
  // backends lead their reason with the STORED path (`disks/work.vdk: permission was refused`), and that leading
  // copy is dropped only when it is exactly this operation's stored name. Any other path the reason carries is
  // kept: it is where the store failed, and a rename that fails at its destination must say so.
  //   not-found, quota: said in the session's own words, with the name (what failed, then what to do); the store's
  //     message is not used, so the several ways the backends word it (js/host/media-store-{fsa,opfs,memory}.js)
  //     cannot make the sentence read differently.
  // A SessionError is the session's own message already: it is handed on unchanged, so nothing above is said twice.
  // What the page's background-write listener says when an index write fails (js/ui/main.js wires this method to its
  // status line). The index's name IS the stored name, so it is handed over: without it a ROM image's path was
  // repeated. -> the message
  indexWriteError(name, e) { return this.mediaError(e, name, name).message; }
  mediaError(e, name, stored = null) {
    if (e instanceof SessionError) return e;
    if (e && e.code === 'not-found') return new SessionError(`${name} is no longer stored in this browser; load it again.`);
    if (e && e.code === 'quota') return new SessionError(`No space left in this browser's storage for ${name}. Delete something, or save your media as files.`);
    let said = e && e.message ? e.message : 'storage error';
    // the reason's leading "<path>: " is this file's copy of the name only when the path IS this operation's stored
    // name for it -- compared whole, so a longer or different name is left alone (and a name with a space works)
    if (stored && said.startsWith(`${stored}: `)) said = said.slice(stored.length + 2);
    return new SessionError(`${name}: ${said}`);
  }
}
