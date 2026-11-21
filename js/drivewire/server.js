/*
 * A DriveWire 4 server: the Host end of the DriveWire protocol, fed one byte at a time by
 * whatever carries it (the CoCo's Becker port, js/machines/becker.js; a TCP socket for MAME's coco_dwsock in
 * tools/mame-diff/drivewire). Browser-free.
 *
 * The authority is the DriveWire specification (github.com/boisy/DriveWire wiki, "DriveWire Specification",
 * DW 4.0.0; section names below are its headings):
 *   System Transactions: RESET ($FF/$FE/$F8), INIT ($49), TERM ($54), DWINIT ($5A), TIME ($23), NOP ($00)
 *   Disk Transactions: Read ($52) / ReRead ($72), Write ($57) / ReWrite ($77), Read Extended ($D2) / ReRead
 *     Extended ($F2), GetStat/SetStat ($47/$53)
 *   Printing: Print ($50), Print Flush ($46)
 *   Virtual Serial Channels: SERINIT ($45), SERREAD ($43), SERREADM ($63), SERWRITE ($C3), FASTWRITE ($80+n),
 *     SERWRITEM ($64), SERGETSTAT ($44), SERSETSTAT ($C4), SERTERM ($C5)
 *   Named Objects: OP_NAMEOBJ_MOUNT ($01), OP_NAMEOBJ_CREATE ($02)
 *   Appendix A (error codes), Appendix B (checksum), Appendix C (op codes)
 * Not implemented: WireBug (the spec: "not yet implemented"), the 230K bit-rate switch ops ($E6, $FD, a
 * serial-line matter that a Becker port does not have; Appendix C gives them a name and a note and nothing
 * else), OP_RFM ($D6) and OP_AARON ($41) (Appendix C lists both and describes no transaction) and the virtual
 * modem (the Hayes and 'dw' command sets, "High Level APIs"): a channel here is a raw byte pipe to the host
 * (onChannelData / channelSend), such as a WebSocket. Window channels (128-142) are served as the "Virtual Serial
 * Channels" section defines them - the same transactions as 0-14, and the same ch + 1 / ch + 17 reply arithmetic -
 * with no descriptor and no window FASTWRITE, which the specification does not define. An op code the server does
 * not know is a one-byte transaction it ignores. The 250 ms transaction timeouts ("Low Level Protocol") are not
 * kept: a Becker port does not lose bytes, and the machine waits for the server (see busy).
 *
 * Disks: up to 256 drives, each a name in a MediaStore (js/host/media-store.js), read and written a 256-byte
 * sector at a time with readRange / writeRange, nothing cached; several drives may be open at once. A sector
 * past the end of an image reads as zeroes; writing one grows the image (writeRange fills any gap with zeroes).
 * The store is asynchronous: while a sector is read or written, `busy` is a Promise and the server takes no
 * further bytes (they wait in its input queue); the carrier holds the guest until it settles, so what the
 * guest sees does not depend on how long the store takes.
 */

import { ByteQueue } from './byte-queue.js';
// op codes (Appendix C)
export const OP = {
  NOP: 0x00, NAMEOBJ_MOUNT: 0x01, NAMEOBJ_CREATE: 0x02, TIME: 0x23, SERREAD: 0x43, SERGETSTAT: 0x44,
  SERINIT: 0x45, PRINTFLUSH: 0x46, GETSTAT: 0x47, INIT: 0x49, PRINT: 0x50, READ: 0x52, SETSTAT: 0x53, TERM: 0x54,
  WRITE: 0x57, DWINIT: 0x5A, SERREADM: 0x63, SERWRITEM: 0x64, REREAD: 0x72, REWRITE: 0x77, FASTWRITE: 0x80,
  SERWRITE: 0xC3, SERSETSTAT: 0xC4, SERTERM: 0xC5, READEX: 0xD2, REREADEX: 0xF2, RESET3: 0xF8, RESET2: 0xFE,
  RESET1: 0xFF,
};
// error codes (Appendix A: "mirror the same codes used in OS-9"); write protect is OS-9's E$WP, which
// Appendix A does not list
export const E = { WP: 0xF2, CRC: 0xF3, READ: 0xF4, WRITE: 0xF5, NOTRDY: 0xF6 };
// SERSETSTAT codes ("The SERSETSTAT Transaction")
const SS_COMST = 0x28, SS_OPEN = 0x29, SS_CLOSE = 0x2A;
export const CHANNELS = 15;          // virtual serial channels 0-14
// Virtual window channels: "Channel number to initialize (0-14 for virtual serial channels, or 128-142 for
// virtual window channels)" ("The Virtual Serial Channels" section). The specification gives the numbering, the
// two SERREAD reply forms and nothing else - no window descriptor, and no FASTWRITE encoding ("- 128 + 32??? see
// aaw"), so a window channel here is the same raw byte pipe as a serial one.
export const WINDOW_BASE = 128, WINDOW_COUNT = 15;
export const CHANNELS_TOTAL = CHANNELS + WINDOW_COUNT;
// the channel numbers a transaction may name, in poll() order: serial first, then the window range
const CHANNEL_NUMBERS = [...Array(CHANNELS).keys(), ...Array.from({ length: WINDOW_COUNT }, (_, i) => WINDOW_BASE + i)];
export const CHANNEL_QUEUE_MAX = 65536;   // bytes a channel holds for the guest; more are dropped (and logged)
export const HOST_VERSION = 0x04;    // our DWINIT answer ("The exact meanings of the version byte are not yet defined")

// Appendix B: the 16-bit sum of the sector's bytes. The listing there ("while(--count)") would leave out the
// last byte; the transactions it serves are defined as "the 16 bit checksum on the 256 bytes", so every byte
// is summed here.
export function checksum(bytes) {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) s = (s + bytes[i]) & 0xFFFF;
  return s;
}

// the length of the transaction that starts with `pkt` (so far), or 0 if more bytes are needed to tell
function packetLength(pkt) {
  const op = pkt[0];
  switch (op) {
    case OP.DWINIT: case OP.PRINT: case OP.SERINIT: case OP.SERTERM: return 2;
    case OP.GETSTAT: case OP.SETSTAT: case OP.SERREADM: case OP.SERWRITE: case OP.SERGETSTAT: return 3;
    case OP.READ: case OP.REREAD: case OP.READEX: case OP.REREADEX: return 5;
    case OP.WRITE: case OP.REWRITE: return 263;
    case OP.SERWRITEM: return pkt.length < 3 ? 0 : 3 + pkt[2];
    case OP.SERSETSTAT: return pkt.length < 3 ? 0 : pkt[2] === SS_COMST ? 29 : 3;
    case OP.NAMEOBJ_MOUNT: case OP.NAMEOBJ_CREATE: return pkt.length < 2 ? 0 : 2 + pkt[1];
    default: return op >= OP.FASTWRITE && op < OP.FASTWRITE + CHANNELS ? 2 : 1;
  }
}

export class DriveWireServer {
  // store: a MediaStore; clock(): a Date for TIME; namePrefix: where named objects live in the store
  // sameName(a, b): whether two stored names are one file, by the store's rule (the Session passes its own
  // Session.sameName, which follows the store's measured case rule); exact when the server has no store rule.
  constructor({ store = null, clock = () => new Date(), namePrefix = 'drivewire/', sameName = (a, b) => a === b } = {}) {
    this.store = store;
    this.sameName = sameName;
    this.clock = clock;
    this.namePrefix = namePrefix;
    this.claims = new Map();          // claim key -> promise: a mount of it is deciding (see claimName); shared with the drives
    this.drives = new Map();          // drive number -> { name, writeProtected, named }; carries `claims` when shared
    this.onPrint = null;              // (bytes) => void at Print Flush
    this.onChannelData = null;        // (channel, bytes) => void: the guest wrote to a channel
    this.onChannelOpen = null;        // (channel) => void
    this.onChannelRead = null;        // (channel) => void: the guest took bytes (room in the channel's queue again)
    this.onChannelClose = null;       // (channel) => void: the guest closed it
    this.onTransaction = null;        // (op, info) => void: every transaction, for a log
    this.mayWrite = null;             // () => boolean: false while the host's store must not be reached (a move)
    this.openLibraryOp = null;        // (run) => Promise: the host runs this store write as a Library operation
    this.busy = null;                 // Promise while a sector is being read or written
    this.resetLink();
  }
  // the protocol state (what is in flight on the link; the drives are the host's configuration)
  resetLink() {
    this.input = [];                  // bytes from the guest not yet taken
    this.pkt = [];                    // the transaction being received
    this.output = [];                 // bytes for the guest
    this.readex = null;               // Read Extended waiting for the guest's checksum: { sum, error }
    this.printBuffer = [];
    this.channels = Array.from({ length: CHANNELS_TOTAL }, () => ({ open: false, queue: new ByteQueue() }));
    this.statusQueue = [];            // SERREAD status bytes waiting (channel closed by the host)
    this.lease = null;                // the drive the last named object call mounted
  }

  // ---------------- drives ----------------
  // The name an image has in the store, as this server compares it. One place, so the guard, the mount and the
  // page's list cannot drift apart: a backend behind this server may be a folder on a case-insensitive volume,
  // where GAME.DSK and game.dsk are one file, so the comparison is the store's rule (the `sameName` it was given).
  sameStoredName(a, b) {
    return this.sameName(a, b);
  }
  // mount the store's `name` in `drive` (0-255); it must exist. The same image may not be in two drives: the
  // drives write the store in place, so two of them on one file would overwrite each other's sectors. Re-mounting
  // it in the drive that already holds it is allowed (an idempotent re-mount; the page re-mounts on a checkbox).
  //
  // The name is claimed while the claim is being made. The duplicate check and the drive are apart by an await (the
  // store's stat), and a mount that only checked before it waited could be overtaken: a guest's named-object mount
  // and the user's mount of one image, overlapping there, left two drives on one file. A claim is taken before the
  // first await and released after the drive is set, so an overlapping mount of the same image waits for the first
  // to decide and then sees it (or finds it gone). A failed stat releases its claim, so an image that is not
  // there does not hold a name.
  async mount(drive, name, { writeProtected = false } = {}) {
    if (!(drive >= 0 && drive <= 255 && Number.isInteger(drive))) throw new RangeError(`drive ${drive}: DriveWire drives are 0-255`);
    if (!this.store) throw new Error('no store to mount from');
    return this.claimName(name, async () => {
      const st = await this.store.stat(name);
      if (!st) throw new Error(`"${name}" is not in the store`);
      const holder = this.holderOf(name, drive);
      if (holder !== null) throw new Error(`"${name}" is already in DriveWire drive ${holder}: eject it there first.`);
      this.drives.set(drive, { name, writeProtected, named: false });
      return { drive, name, size: st.size };
    });
  }
  // the drive other than `except` that already holds `name` -> drive number, or null
  holderOf(name, except = null) {
    for (const [drive, d] of this.drives) {
      if (drive === except) continue;
      if (this.sameStoredName(d.name, name)) return drive;
    }
    return null;
  }
  // The claim map belongs to the DRIVES, not to this server: two servers can share one drives map (the one a real
  // CoCo is served from and the chat's both take Session.drivewire.drives), and a claim only one of them could see
  // would let a guest on one link and a user on the other take the same image. Whoever is given the drives is given
  // their claims, so the two always wait on each other.
  set drives(d) { this._drives = d; this.claims = (d && d.claims) || (this.claims || new Map()); if (d && !d.claims) d.claims = this.claims; }
  get drives() { return this._drives; }
  // The key a claim is held under: the name as the STORE compares it. holderOf() folds case by the store's rule
  // (this.sameName), so two spellings of one file must wait on one claim; the exact string as a key let OBJ and obj
  // claim at the same time and both pass the duplicate scan.
  claimKey(name) { return this.sameName ? (this.sameName(name, name.toLowerCase()) ? name.toLowerCase() : name) : name; }
  // One claim per stored image at a time: `run` re-checks the drives and then sets the one it decided on, and a
  // second claim of the same file waits for the first to finish before it checks, so it sees that drive (a
  // duplicate) instead of passing a scan made before the first landed. A failed run releases its claim, so an image
  // that is not there holds nothing.
  async claimName(name, run) {
    const key = this.claimKey(name);
    while (this.claims.has(key)) await this.claims.get(key).catch(() => {});
    let release;
    this.claims.set(key, new Promise((r) => { release = r; }));
    try { return await run(); } finally { this.claims.delete(key); release(); }
  }
  eject(drive) { if (this.lease === drive) this.lease = null; return this.drives.delete(drive); }
  get mounts() { return [...this.drives.entries()].sort((a, b) => a[0] - b[0]).map(([drive, d]) => ({ drive, name: d.name, writeProtected: d.writeProtected })); }

  // ---------------- the link ----------------
  // a byte from the guest
  receive(byte) {
    this.input.push(byte & 0xFF);
    this.pump();
  }
  get available() { return this.output.length; }
  // the next byte for the guest (undefined if there is none)
  read() { return this.output.shift(); }

  // take bytes from the input queue while no sector operation is in progress
  pump() {
    while (!this.busy && this.input.length) {
      const b = this.input.shift();
      if (this.readex) { this.pkt.push(b); if (this.pkt.length === 2) this.finishReadex(); continue; }
      this.pkt.push(b);
      const n = packetLength(this.pkt);
      if (n && this.pkt.length >= n) { const p = this.pkt; this.pkt = []; this.transaction(p); }
    }
  }
  // run an asynchronous step; the link waits for it
  wait(promise) {
    this.busy = promise.then(() => { this.busy = null; this.pump(); });
    return this.busy;
  }
  // a store write that must not be lost to a library move: the host's Library operation (libraryOp) when it wires
  // one, so the move waits for this and this cannot start while the move copies; run directly when it does not (a
  // server outside a Session, e.g. the protocol tests). The host's op refuses a move in progress by rejecting,
  // which the caller turns into reply(0).
  storeOp(run) { return this.openLibraryOp ? this.openLibraryOp(run) : run(); }
  log(op, info) { if (this.onTransaction) this.onTransaction(op, info); }

  transaction(p) {
    const op = p[0];
    switch (op) {
      case OP.RESET1: case OP.RESET2: case OP.RESET3: this.log('RESET'); break;
      case OP.INIT: this.log('INIT'); break;
      case OP.TERM: this.log('TERM'); break;
      case OP.NOP: break;
      case OP.DWINIT: this.output.push(HOST_VERSION); this.log('DWINIT', { guest: p[1] }); break;
      case OP.TIME: {
        const d = this.clock();
        this.output.push(d.getFullYear() - 1900, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
        this.log('TIME');
        break;
      }
      case OP.READ: case OP.REREAD: this.read256(p, false); break;
      case OP.READEX: case OP.REREADEX: this.read256(p, true); break;
      case OP.WRITE: case OP.REWRITE: this.write256(p); break;
      case OP.GETSTAT: case OP.SETSTAT: this.log(op === OP.GETSTAT ? 'GETSTAT' : 'SETSTAT', { drive: p[1], code: p[2] }); break;
      case OP.PRINT: this.printBuffer.push(p[1]); break;
      case OP.PRINTFLUSH: {
        const out = Uint8Array.from(this.printBuffer);
        this.printBuffer = [];
        if (this.onPrint) this.onPrint(out);
        this.log('PRINTFLUSH', { bytes: out.length });
        break;
      }
      case OP.SERINIT: this.openChannel(p[1]); break;
      case OP.SERTERM: this.closeChannel(p[1], false); break;
      case OP.SERSETSTAT:
        if (p[2] === SS_OPEN) this.openChannel(p[1]);
        else if (p[2] === SS_CLOSE) this.closeChannel(p[1], false);
        this.log('SERSETSTAT', { channel: p[1], code: p[2] });
        break;
      case OP.SERGETSTAT: this.log('SERGETSTAT', { channel: p[1], code: p[2] }); break;
      case OP.SERWRITE: this.channelWrite(p[1], [p[2]]); break;
      case OP.SERWRITEM: this.channelWrite(p[1], p.slice(3)); break;
      case OP.SERREAD: this.output.push(...this.poll()); break;
      case OP.SERREADM: {
        // "requesting more bytes than are present will result in a server error, and it will simply not respond"
        const c = this.channelAt(p[1]);
        if (c && p[2] <= c.queue.length) { for (const b of c.queue.take(p[2])) this.output.push(b); this.channelRead(p[1]); }
        this.log('SERREADM', { channel: p[1], count: p[2] });
        break;
      }
      case OP.NAMEOBJ_MOUNT: case OP.NAMEOBJ_CREATE: this.namedObject(op === OP.NAMEOBJ_CREATE, p.slice(2)); break;
      default:
        if (op >= OP.FASTWRITE && op < OP.FASTWRITE + CHANNELS) this.channelWrite(op - OP.FASTWRITE, [p[1]]);
        else this.log('UNKNOWN', { op });
    }
  }

  // ---------------- disk transactions ----------------
  // the sector (256 bytes) at `lsn` of `drive`: { data } or { error }
  async sector(drive, lsn) {
    const d = this.drives.get(drive);
    if (!d) return { error: E.NOTRDY };
    try {
      const got = await this.store.readRange(d.name, lsn * 256, 256);
      const data = new Uint8Array(256);
      data.set(got);
      return { data };
    } catch (e) {
      // a sector wholly past the end reads as zeroes (readRange refuses an offset beyond the end)
      if (e && e.code === 'io') { const st = await this.store.stat(d.name).catch(() => null); if (st && lsn * 256 >= st.size) return { data: new Uint8Array(256) }; }
      return { error: E.READ };
    }
  }
  read256(p, extended) {
    const drive = p[1], lsn = (p[2] << 16) | (p[3] << 8) | p[4];
    this.wait(this.sector(drive, lsn).then((r) => {
      this.log(extended ? 'READEX' : 'READ', { drive, lsn, error: r.error || 0 });
      if (!extended) {
        if (r.error) this.output.push(r.error);
        else { const s = checksum(r.data); this.output.push(0, s >> 8, s & 0xFF, ...r.data); }
        return;
      }
      // Read Extended: the sector (or 256 zeroes), then the guest's checksum, then the result
      this.output.push(...(r.data || new Uint8Array(256)));
      this.readex = { sum: r.data ? checksum(r.data) : 0, error: r.error || 0 };
    }));
  }
  finishReadex() {
    const { sum, error } = this.readex, guest = (this.pkt[0] << 8) | this.pkt[1];
    this.readex = null; this.pkt = [];
    this.output.push(error || (guest === sum ? 0 : E.CRC));
  }
  write256(p) {
    const drive = p[1], lsn = (p[2] << 16) | (p[3] << 8) | p[4], data = Uint8Array.from(p.slice(5, 261));
    const guest = (p[261] << 8) | p[262], d = this.drives.get(drive);
    const done = (error) => { this.output.push(error); this.log('WRITE', { drive, lsn, error }); };
    if (checksum(data) !== guest) return done(E.CRC);
    if (!d) return done(E.NOTRDY);
    if (d.writeProtected) return done(E.WP);
    this.wait(this.store.writeRange(d.name, lsn * 256, data).then(() => done(0), () => done(E.WRITE)));
  }

  // ---------------- named objects ----------------
  // the reply is the drive the object is now in, or 0; the last call's mount is released ("lease")
  namedObject(create, nameBytes) {
    const name = this.namePrefix + String.fromCharCode(...nameBytes);
    const reply = (drive) => { this.output.push(drive); this.log(create ? 'NAMEOBJ_CREATE' : 'NAMEOBJ_MOUNT', { name, drive }); };
    if (this.lease !== null) { const d = this.drives.get(this.lease); if (d && d.named) this.drives.delete(this.lease); this.lease = null; }
    if (!this.store) return reply(0);
    // the host can say the store must not be written now (the library is being copied): the guest is answered
    // "no such object" (0), the protocol's way of refusing, rather than a drive mounted on a store the copy has left
    if (this.mayWrite && !this.mayWrite()) return reply(0);
    this.wait((async () => {
      try {
        for (const [n, d] of this.drives) if (this.sameStoredName(d.name, name)) { if (create) return reply(0); return reply(n); }
        if (create) {
          // A create writes the store, so the whole of it - the stat that decides the name is new, the write, and
          // handing the guest its drive - runs as ONE Library operation, registered before its first await. The
          // move waits for it to settle before it copies, and a create cannot begin once a move has begun (the
          // host's op refuses while it copies). The drive is handed out inside the operation, with nothing awaited
          // after the write, so by the time the operation has settled the drive is in `drives`: a move that waited
          // for it then finds the drive mounted (its re-check after the wait) and is refused, rather than copying
          // while the guest writes through a drive on the store it is leaving. A check after each await cannot do
          // this: between a check and the write, a move can still start, and the write then lands in the store it
          // is copying.
          await this.storeOp(() => this.claimName(name, async () => {
            if (await this.store.stat(name)) return reply(0);   // it exists: a create is refused (the mount arm answers it instead)
            let free = 0;
            for (let n = 255; n >= 1 && !free; n--) if (!this.drives.has(n)) free = n;
            if (!free) return reply(0);
            await this.store.write(name, new Uint8Array(0));
            this.drives.set(free, { name, writeProtected: false, named: true });
            this.lease = free;
            reply(free);
          }));
          return;
        }
        // the same claim a mount takes (claimName): the duplicate scan above ran before the first await, so without
        // it the user's mount of this image could land in the stat's gap and leave two drives on the file
        await this.claimName(name, async () => {
          // the scan above ran before this claim and can be stale: a mount of the same image (the user's, or
          // another guest's) may have landed in between. Re-scan INSIDE the claim, which is what closes the window.
          for (const [n, d] of this.drives) if (this.sameStoredName(d.name, name)) return reply(n);
          const st = await this.store.stat(name);
          // the stat awaited: a move can have begun since. A mount hands the guest a drive it then writes through
          // (Write, SetStat), so it must not come out of here onto a store the copy has left. Refused now, with the
          // same reply(0). (A create needs no check here: it ran as one Library operation, which the move waits for.)
          if (this.mayWrite && !this.mayWrite()) return reply(0);
          if (!st) return reply(0);
          // and again: the stat awaited, so a mount can have landed since the re-scan too
          for (const [n, d] of this.drives) if (this.sameStoredName(d.name, name)) return reply(n);
          let free = 0;
          for (let n = 255; n >= 1 && !free; n--) if (!this.drives.has(n)) free = n;
          if (!free) return reply(0);
          this.drives.set(free, { name, writeProtected: false, named: true });
          this.lease = free;
          reply(free);
        });
      } catch (e) { reply(0); }
    })());
  }

  // ---------------- virtual serial channels ----------------
  // The channel state for a channel number the guest sent: 0-14 for a serial channel, 128-142 for a window
  // channel, or null for any other number (which the server ignores, as it always has).
  channelAt(n) {
    if (n >= 0 && n < CHANNELS) return this.channels[n];
    if (n >= WINDOW_BASE && n < WINDOW_BASE + WINDOW_COUNT) return this.channels[CHANNELS + (n - WINDOW_BASE)];
    return null;
  }
  openChannel(ch) {
    const c = this.channelAt(ch);
    if (!c) return this.log('SERINIT', { channel: ch, ignored: true });
    c.open = true;
    this.log('SERINIT', { channel: ch });
    if (this.onChannelOpen) this.onChannelOpen(ch);
  }
  // closed by the guest (byHost false) or by the host (a status byte for the guest's next SERREAD)
  closeChannel(ch, byHost = true) {
    const c = this.channelAt(ch);
    if (!c || !c.open) return false;
    c.open = false; c.queue.clear();
    if (byHost) this.statusQueue.push(ch);
    else if (this.onChannelClose) this.onChannelClose(ch);
    this.log('SERTERM', { channel: ch, byHost });
    return true;
  }
  channelWrite(ch, bytes) {
    const c = this.channelAt(ch);
    if (!c || !c.open) return this.log('SERWRITE', { channel: ch, dropped: bytes.length });
    if (this.onChannelData) this.onChannelData(ch, Uint8Array.from(bytes));
  }
  // bytes from the host for the guest on channel `ch` (it must be open) -> how many were taken; past
  // CHANNEL_QUEUE_MAX the rest are dropped and logged (CHANNEL_DROPPED). A host with more to send waits for room
  // (channelRoom, onChannelRead).
  channelSend(ch, bytes) {
    const c = this.channelAt(ch);
    if (!c || !c.open) throw new Error(`DriveWire channel ${ch} is not open`);
    // appended byte by byte (no spread: a large array would overflow the call stack), up to CHANNEL_QUEUE_MAX
    const n = c.queue.push(bytes, CHANNEL_QUEUE_MAX);
    if (n < bytes.length) this.log('CHANNEL_DROPPED', { channel: ch, dropped: bytes.length - n });
    return n;
  }
  // room left in channel `ch`'s queue for the guest
  channelRoom(ch) { const c = this.channelAt(ch); return c && c.open ? CHANNEL_QUEUE_MAX - c.queue.length : 0; }
  channelRead(ch) { if (this.onChannelRead) this.onChannelRead(ch); }

  // "The SERREAD / POLL Transaction": [0, 0] nothing; [16, ch] a channel closed; [ch + 1, byte] one byte;
  // [ch + 17, count] several bytes waiting (count at most 255; the guest takes them with SERREADM).
  // The same two forms serve window channels: the table lists them as "129 to 143" for one byte and
  // "145 - 161" for a count, and evaluating its own expressions ("byte 1 - 1 - 128" and "byte 1 - 1 - 16 - 128")
  // gives ch + 1 and ch + 17 for 128-142 exactly as for 0-14, so no arithmetic changes - only the range walked.
  // Serial channels are polled first, which keeps their replies where they were.
  poll() {
    if (this.statusQueue.length) return [16, this.statusQueue.shift()];
    for (const ch of CHANNEL_NUMBERS) {
      const q = this.channelAt(ch).queue;
      if (q.length === 1) { const b = q.take(1)[0]; this.channelRead(ch); return [ch + 1, b]; }
      if (q.length > 1) return [ch + 17, Math.min(q.length, 255)];
    }
    return [0, 0];
  }

  // ---------------- state ----------------
  saveState() {
    if (this.busy) throw new Error('DriveWire: a sector is being read or written');
    return {
      input: this.input.slice(), pkt: this.pkt.slice(), output: this.output.slice(), readex: this.readex && Object.assign({}, this.readex),
      printBuffer: this.printBuffer.slice(), channels: this.channels.map((c) => ({ open: c.open, queue: c.queue.toArray() })),
      statusQueue: this.statusQueue.slice(), lease: this.lease,
    };
  }
  loadState(s) {
    for (const k of ['input', 'pkt', 'output', 'readex', 'printBuffer', 'channels', 'statusQueue', 'lease']) if (!(k in s)) throw new Error(`snapshot: missing "drivewire.${k}"`);
    if (s.channels.length !== CHANNELS_TOTAL) throw new Error('snapshot: "drivewire.channels" has the wrong size');
    this.input = s.input.slice(); this.pkt = s.pkt.slice(); this.output = s.output.slice();
    this.readex = s.readex && Object.assign({}, s.readex);
    this.printBuffer = s.printBuffer.slice();
    this.channels = s.channels.map((c) => ({ open: c.open, queue: ByteQueue.from(c.queue) }));
    this.statusQueue = s.statusQueue.slice(); this.lease = s.lease;
  }
}
