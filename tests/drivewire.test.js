// DriveWire: the server (js/drivewire/server.js) against the DriveWire 4 specification
// (github.com/boisy/DriveWire wiki, "DriveWire Specification"; sections named below), and the Becker port
// (js/machines/becker.js). Every expected byte is built here from the specification's tables, not by the code
// under test: packets are written out by hand, checksums summed here. The authority for the Becker port's
// behaviour in a machine is tools/mame-diff/drivewire/run-dw.js (dw.asm in MAME 0.264 and on our machine).
const Emu = require('./load')();
const { DriveWireServer, OP, E } = require('../js/drivewire/server.js');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');
const spec = require('../tools/mame-diff/drivewire/spec.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sum16 = (bytes) => { let s = 0; for (const b of bytes) s += b; return s & 0xFFFF; };   // Appendix B, every byte
const sector = (seed) => Array.from({ length: 256 }, (_, i) => (seed + i * 5) & 0xFF);
const str = (s) => [...s].map((c) => c.charCodeAt(0));

// a server over a fresh store with drives 0 (4 sectors), 1 (write protected), 2 (1 sector)
async function setup(store = new MemoryMediaStore()) {
  await store.write('d0', Uint8Array.from([...sector(1), ...sector(2), ...sector(3), ...sector(4)]));
  await store.write('d1', Uint8Array.from(sector(9)));
  await store.write('d2', Uint8Array.from(sector(7)));
  await store.write('drivewire/OBJ', Uint8Array.from(sector(11)));
  const s = new DriveWireServer({ store, clock: () => new Date(2026, 0, 2, 3, 4, 5) });
  await s.mount(0, 'd0'); await s.mount(1, 'd1', { writeProtected: true }); await s.mount(2, 'd2');
  return s;
}
// send bytes, let any sector operation finish, take everything the server has for the guest
async function xfer(s, bytes) {
  for (const b of bytes) s.receive(b);
  while (s.busy) await s.busy;
  return s.output.splice(0);
}

(async () => {
  // ---------------- System Transactions ----------------
  {
    const s = await setup();
    check('RESET, INIT, TERM, NOP: no reply', eq(await xfer(s, [0xFF, 0xFE, 0xF8, 0x49, 0x54, 0x00]), []));
    check('DWINIT: one byte back ("the DW4 Host will" respond)', (await xfer(s, [0x5A, 0x01])).length === 1);
    check('TIME: year - 1900, month 1-12, day, hour, minute, second', eq(await xfer(s, [0x23]), [126, 1, 2, 3, 4, 5]));
    check('an unknown op code is ignored and the link stays in step', eq(await xfer(s, [0x41, 0x23]), [126, 1, 2, 3, 4, 5]));
  }

  // ---------------- Read / ReRead ----------------
  {
    const s = await setup();
    const want = sector(2);
    check('Read: 0, the 16-bit checksum high byte first, the 256 bytes (drive 0 LSN 1)',
      eq(await xfer(s, [0x52, 0, 0, 0, 1]), [0, sum16(want) >> 8, sum16(want) & 0xFF, ...want]));
    check('ReRead: the same', eq(await xfer(s, [0x72, 0, 0, 0, 1]), [0, sum16(want) >> 8, sum16(want) & 0xFF, ...want]));
    check('Read: the LSN is 24 bits, high byte first (LSN $000003)', eq((await xfer(s, [0x52, 0, 0, 0, 3])).slice(3), sector(4)));
    check('Read: a drive with nothing mounted gives one error byte, $F6 (Appendix A: not ready)', eq(await xfer(s, [0x52, 7, 0, 0, 0]), [E.NOTRDY]));
    const past = await xfer(s, [0x52, 0, 0x01, 0, 0]);
    check('Read: a sector past the end of the image reads as zeroes', past.length === 259 && eq(past.slice(0, 3), [0, 0, 0]) && past.slice(3).every((v) => v === 0));
  }

  // ---------------- Read Extended ----------------
  {
    const s = await setup();
    const want = sector(3);
    const data = await xfer(s, [0xD2, 0, 0, 0, 2]);
    check('Read Extended: the 256 bytes first, nothing else yet', eq(data, want));
    check('Read Extended: the guest\'s checksum (high byte first) matches: 0', eq(await xfer(s, [sum16(want) >> 8, sum16(want) & 0xFF]), [0]));
    await xfer(s, [0xF2, 0, 0, 0, 2]);
    check('ReRead Extended: a checksum that does not match: 243 ($F3)', eq(await xfer(s, [0, 0]), [243]));
    const none = await xfer(s, [0xD2, 9, 0, 0, 0]);
    check('Read Extended, drive not mounted: 256 zeroes', none.length === 256 && none.every((v) => v === 0));
    check('... then, after the checksum, the error ($F6)', eq(await xfer(s, [0, 0]), [E.NOTRDY]));
  }

  // ---------------- Write / ReWrite ----------------
  {
    const store = new MemoryMediaStore();
    const s = await setup(store);
    const calls = [];
    for (const k of ['write', 'writeRange', 'read']) { const f = store[k].bind(store); store[k] = (...a) => { calls.push(k); return f(...a); }; }
    const data = sector(0x40), ck = sum16(data);
    check('Write: 0 when the checksum matches', eq(await xfer(s, [0x57, 0, 0, 0, 2, ...data, ck >> 8, ck & 0xFF]), [0]));
    const img = await store.read('d0');
    check('Write: the sector is in the image, the rest untouched', eq([...img.slice(512, 768)], data) && eq([...img.slice(256, 512)], sector(2)) && eq([...img.slice(768)], sector(4)));
    check('Write: one writeRange, never a whole-image write', eq(calls.filter((c) => c !== 'read'), ['writeRange']), calls.join());
    check('ReWrite: the same', eq(await xfer(s, [0x77, 0, 0, 0, 3, ...data, ck >> 8, ck & 0xFF]), [0]));
    check('Write: a wrong checksum is 243 and nothing is written',
      eq(await xfer(s, [0x57, 0, 0, 0, 0, ...data, ck >> 8, (ck + 1) & 0xFF]), [243]) && eq([...(await store.read('d0')).slice(0, 256)], sector(1)));
    check('Write: a write-protected drive gives $F2 (OS-9 E$WP) and keeps its image',
      eq(await xfer(s, [0x57, 1, 0, 0, 0, ...data, ck >> 8, ck & 0xFF]), [E.WP]) && eq([...(await store.read('d1'))], sector(9)));
    check('Write: a drive with nothing mounted gives $F6', eq(await xfer(s, [0x57, 5, 0, 0, 0, ...data, ck >> 8, ck & 0xFF]), [E.NOTRDY]));
    await xfer(s, [0x57, 2, 0, 0, 3, ...data, ck >> 8, ck & 0xFF]);
    const grown = await store.read('d2');
    check('Write past the end: the image grows, the gap is zeroes', grown.length === 4 * 256 && eq([...grown.slice(0, 256)], sector(7))
      && grown.slice(256, 768).every((v) => v === 0) && eq([...grown.slice(768)], data));
  }

  // ---------------- several images at once, and store failures ----------------
  {
    const s = await setup();
    const got = [];
    for (const [d, l] of [[0, 3], [2, 0], [0, 0], [1, 0], [2, 0], [0, 1]]) got.push((await xfer(s, [0x52, d, 0, 0, l])).slice(3));
    check('several images open at once, read in any order', eq(got[0], sector(4)) && eq(got[1], sector(7)) && eq(got[2], sector(1)) && eq(got[3], sector(9)) && eq(got[4], sector(7)) && eq(got[5], sector(2)));
    // a store that fails: reads $F4, writes $F5 (Appendix A)
    const bad = new MemoryMediaStore();
    const t = await setup(bad);
    bad.readRange = async () => { throw new MediaStoreError('io', 'disk gone'); };
    bad.stat = async () => ({ name: 'd0', size: 4096, mtime: 0 });
    bad.writeRange = async () => { throw new MediaStoreError('quota', 'full'); };
    check('a read the store fails: $F4', eq(await xfer(t, [0x52, 0, 0, 0, 0]), [E.READ]));
    const d = sector(1), c = sum16(d);
    check('a write the store fails: $F5', eq(await xfer(t, [0x57, 0, 0, 0, 0, ...d, c >> 8, c & 0xFF]), [E.WRITE]));
    // bytes sent while a sector is on its way wait their turn
    const u = await setup();
    for (const b of [0x52, 0, 0, 0, 0, 0x23]) u.receive(b);
    check('a transaction sent while a sector is read waits for it', u.busy !== null && u.output.length === 0);
    while (u.busy) await u.busy;
    check('... and is answered after it, in order', eq(u.output.splice(0), [0, sum16(sector(1)) >> 8, sum16(sector(1)) & 0xFF, ...sector(1), 126, 1, 2, 3, 4, 5]));
    let refused = '';
    try { await u.mount(256, 'd0'); } catch (e) { refused = e.message; }
    check('mount: drives are 0-255', /0-255/.test(refused), refused);
    try { await u.mount(3, 'nothere'); refused = ''; } catch (e) { refused = e.message; }
    check('mount: the image must be in the store', /not in the store/.test(refused), refused);
  }

  // ---------------- Named Objects ----------------
  {
    const store = new MemoryMediaStore();
    const s = await setup(store);
    const [drv] = await xfer(s, [0x01, 3, ...str('OBJ')]);
    check('NAMEOBJ_MOUNT: a drive from 1 to 255', drv >= 1 && drv <= 255, `(${drv})`);
    check('... which reads the object', eq((await xfer(s, [0x52, drv, 0, 0, 0])).slice(3), sector(11)));
    check('NAMEOBJ_MOUNT: a missing object gives 0', eq(await xfer(s, [0x01, 4, ...str('NONE')]), [0]));
    check('... and released the previous lease (its drive is no longer mounted)', eq(await xfer(s, [0x52, drv, 0, 0, 0]), [E.NOTRDY]));
    check('NAMEOBJ_CREATE: an object that exists gives 0', eq(await xfer(s, [0x02, 3, ...str('OBJ')]), [0]));
    const [nd] = await xfer(s, [0x02, 3, ...str('NEW')]);
    check('NAMEOBJ_CREATE: a new object is created and mounted', nd >= 1 && nd <= 255 && (await store.stat('drivewire/NEW')).size === 0);
    const data = sector(3), ck = sum16(data);
    check('... and takes a write', eq(await xfer(s, [0x57, nd, 0, 0, 0, ...data, ck >> 8, ck & 0xFF]), [0]) && eq([...(await store.read('drivewire/NEW'))], data));
    check('NAMEOBJ_MOUNT of an object already mounted gives its drive again', eq(await xfer(s, [0x01, 3, ...str('NEW')]), [nd]));
  }

  // ---------------- Printing ----------------
  {
    const s = await setup();
    const printed = [];
    s.onPrint = (b) => printed.push([...b]);
    await xfer(s, [0x50, 0x48, 0x50, 0x49]);
    check('Print: bytes wait in the buffer until the flush', printed.length === 0);
    await xfer(s, [0x46]);
    check('Print Flush: the buffer goes out', printed.length === 1 && eq(printed[0], [0x48, 0x49]));
  }

  // ---------------- Virtual Serial Channels ----------------
  {
    const s = await setup();
    const wrote = [];
    s.onChannelData = (ch, b) => wrote.push([ch, ...b]);
    check('SERREAD with nothing waiting: 0 (and byte 2 ignored)', (await xfer(s, [0x43]))[0] === 0);
    let refused = false;
    try { s.channelSend(2, [1]); } catch (e) { refused = /not open/.test(e.message); }
    check('the host cannot send on a channel the guest has not opened', refused);
    await xfer(s, [0x45, 2]);
    s.channelSend(2, [0x41]);
    check('SERREAD, one byte waiting on channel 2: (2 + 1, the byte)', eq(await xfer(s, [0x43]), [3, 0x41]));
    s.channelSend(2, [1, 2, 3]);
    check('SERREAD, three bytes waiting on channel 2: (2 + 17, 3)', eq(await xfer(s, [0x43]), [19, 3]));
    check('SERREADM channel 2, 2 bytes', eq(await xfer(s, [0x63, 2, 2]), [1, 2]));
    check('SERREADM for more than is waiting: no answer', eq(await xfer(s, [0x63, 2, 5]), []));
    check('... and the link stays in step', eq(await xfer(s, [0x23]), [126, 1, 2, 3, 4, 5]));
    await xfer(s, [0xC3, 2, 0x61, 0x82, 0x62, 0x64, 2, 2, 0x63, 0x64]);
    check('SERWRITE, FASTWRITE ($80 + channel), SERWRITEM: the bytes reach the host', JSON.stringify(wrote) === JSON.stringify([[2, 0x61], [2, 0x62], [2, 0x63, 0x64]]));
    check('a FASTWRITE to a channel not open is dropped', wrote.length === 3 && (await xfer(s, [0x85, 0x7A])).length === 0 && wrote.length === 3);
    check('SERSETSTAT SS.ComSt takes 26 more bytes; SERGETSTAT takes 3 in all', eq(await xfer(s, [0xC4, 2, 0x28, ...new Array(26).fill(0x23), 0x44, 2, 1, 0x23]), [126, 1, 2, 3, 4, 5]));
    s.closeChannel(2);
    check('a channel the host closes: SERREAD gives (16, channel)', eq(await xfer(s, [0x43]), [16, 2]));
    check('... once', (await xfer(s, [0x43]))[0] === 0);
    await xfer(s, [0xC4, 4, 0x29]);
    const closed = [];
    s.onChannelClose = (ch) => closed.push(ch);
    await xfer(s, [0xC4, 4, 0x2A, 0xC5, 4]);
    check('SERSETSTAT SS.Open / SS.Close open and close; SERTERM on a closed channel does nothing', eq(closed, [4]) && !s.channels[4].open);
  }

  // ---------------- Virtual window channels (128-142) ----------------
  // "The Virtual Serial Channels" section: "Channel number to initialize (0-14 for virtual serial channels, or
  // 128-142 for virtual window channels)". SERREAD's replies: "129 to 143 | Byte 2 contains a single byte of
  // data for VWindow channel (byte 1 - 1 - 128)" and "145 - 161 | Byte 2 contains the number of bytes waiting
  // for VWindow channel (byte 1 - 1 - 16 - 128)". Both ends of the range are checked, so the arithmetic is
  // pinned by the table's own numbers rather than by a middle value that happens to agree.
  {
    const s = await setup();
    const wrote = [];
    s.onChannelData = (ch, b) => wrote.push([ch, ...b]);
    // before: 128 was ignored entirely. SERINIT opens it and writes reach the host.
    check('SERINIT on window channel 128 opens it', (await xfer(s, [0x45, 128])).length === 0 && s.channelAt(128).open);
    check('SERINIT on window channel 142 opens it', (await xfer(s, [0x45, 142])).length === 0 && s.channelAt(142).open);
    await xfer(s, [0xC3, 128, 0x21]);
    check('SERWRITE on a window channel reaches the host', JSON.stringify(wrote) === JSON.stringify([[128, 0x21]]));
    // one byte waiting: byte 1 = ch + 1 for both ranges, and for a window channel that is 0x81-0x8F (7-6 = 0b10,
    // "VWindow mode")
    s.channelSend(128, [0x5A]);
    check('SERREAD, one byte on window channel 128: (129, byte), mode bits 7-6 = 0b10', eq(await xfer(s, [0x43]), [129, 0x5A]));
    s.channelSend(142, [0x6B]);
    check('SERREAD, one byte on window channel 142: (143, byte)', eq(await xfer(s, [0x43]), [143, 0x6B]));
    // several waiting: the table gives 145-161, which is ch + 17, the same expression the serial channels use
    s.channelSend(128, [1, 2, 3]);
    check('SERREAD, three bytes on window channel 128: (145, 3)', eq(await xfer(s, [0x43]), [145, 3]));
    check('SERREADM takes window channel bytes', eq(await xfer(s, [0x63, 128, 2]), [1, 2]));
    // one byte is left on 128, so it answers before 142: poll() walks the channels in ascending order
    check('SERREAD, the byte left on 128 answers before 142', eq(await xfer(s, [0x43]), [129, 3]));
    s.channelSend(142, [4, 5]);
    check('SERREAD, two bytes on window channel 142: (159, 2)', eq(await xfer(s, [0x43]), [159, 2]));
    check('SERREADM on the other end of the range', eq(await xfer(s, [0x63, 142, 2]), [4, 5]));
    // the serial range is untouched: channel 0 still answers with the serial base
    await xfer(s, [0x45, 0]);
    s.channelSend(0, [7, 8]);
    check('a serial channel still answers with ch + 17, not the window base', eq(await xfer(s, [0x43]), [17, 2]));
    // a number in neither range is still ignored, as before
    check('SERINIT on 127 is ignored', (await xfer(s, [0x45, 127])).length === 0 && !s.channelAt(127));
    check('SERINIT on 143 is ignored', (await xfer(s, [0x45, 143])).length === 0 && !s.channelAt(143));
    // state: all 30 channel records are saved and restored as they were (window channels open from the SERINITs
    // above, channel 0 open with two bytes queued); any other count is a damaged snapshot and refused
    const st = s.saveState();
    check('state: the server now saves 30 channel records', st.channels.length === 30);
    const t = await setup();
    t.loadState(JSON.parse(JSON.stringify(st)));
    check('state: every channel record, window channels included, restored as saved', t.channels.length === 30
      && JSON.stringify(t.saveState().channels) === JSON.stringify(st.channels) && st.channels.slice(15).some((c) => c.open),
      JSON.stringify(st.channels.map((c) => c.open)));
    check('... and the serial channel is restored as saved', t.channelAt(0).open && t.channelAt(0).queue.length === 2);
    for (const n of [15, 20]) {
      let bad = '';
      try { (await setup()).loadState(JSON.parse(JSON.stringify(Object.assign({}, st, { channels: st.channels.slice(0, n) })))); } catch (e) { bad = e.message; }
      check(`state: ${n} channel records are refused`, /wrong size/.test(bad), bad);
    }
  }

  // ---------------- state ----------------
  {
    const s = await setup();
    const data = sector(5), ck = sum16(data);
    const packet = [0x57, 0, 0, 0, 1, ...data, ck >> 8, ck & 0xFF];
    await xfer(s, [0xD2, 0, 0, 0, 0]);            // a Read Extended waiting for its checksum...
    const t = await setup();
    t.loadState(JSON.parse(JSON.stringify(s.saveState())));
    check('state: a Read Extended waiting for the checksum carries on', eq(await xfer(t, [sum16(sector(1)) >> 8, sum16(sector(1)) & 0xFF]), [0]));
    await xfer(t, packet.slice(0, 100));           // ... and a Write part way through its packet
    const u = await setup();
    u.loadState(JSON.parse(JSON.stringify(t.saveState())));
    check('state: a Write part way through carries on', eq(await xfer(u, packet.slice(100)), [0]));
    let refused = '';
    try { const v = await setup(); const st = v.saveState(); delete st.readex; v.loadState(st); } catch (e) { refused = e.message; }
    check('state: a field missing is refused', /missing "drivewire.readex"/.test(refused), refused);
    const w = await setup();
    w.receive(0x52); w.receive(0); w.receive(0); w.receive(0); w.receive(0);
    refused = '';
    try { w.saveState(); } catch (e) { refused = e.message; }
    check('state: not while a sector is being read', /being read or written/.test(refused), refused);
    while (w.busy) await w.busy;
  }

  // ---------------- the Becker port ----------------
  {
    const m = Emu.createMachine('coco', { becker: true });
    m.reset(true);
    check('Becker port with no server: status 0, data $5A (as MAME)', m.read(0xFF41) === 0 && m.read(0xFF42) === 0x5A);
    const s = await setup();
    m.becker.attach(s);
    m.write(0xFF42, 0x23);
    check('a byte written to $FF42 reaches the server; $FF41 bit 1 shows the answer', m.read(0xFF41) === 0x02);
    const got = [];
    while (m.read(0xFF41) & 2) got.push(m.read(0xFF42));
    check('$FF42 reads the answer byte by byte, then status 0', eq(got, [126, 1, 2, 3, 4, 5]) && m.read(0xFF41) === 0);
    check('a CoCo without the option has no Becker port', Emu.createMachine('coco').becker === null);
    let refused = '';
    try { Emu.createMachine('dragon64', { becker: true }); } catch (e) { refused = e.message; }
    check('the Dragon 64 has no Becker port option (as in MAME)', /unknown option "becker"/.test(refused), refused);
    const c3 = Emu.createMachine('coco3', { becker: true });
    c3.reset(true); c3.becker.attach(await setup());
    c3.write(0xFF42, 0x23);
    check('CoCo 3: nothing at $FF40-$FF5F until the GIME enables the spare chip select ($FF90 bit 2)', c3.read(0xFF41) === 0 && c3.becker.server.available === 0);
    c3.write(0xFF90, 0x04); c3.write(0xFF42, 0x23);
    check('CoCo 3: with it on, the Becker port answers', c3.read(0xFF41) === 0x02);
  }

  // ---------------- the machine waits for the store, so timing does not depend on it ----------------
  {
    // dw.asm against a store that answers after a random real-time delay must leave exactly what it leaves
    // against the in-memory store, and run the same instructions to the cycle
    const traceOf = async (slow) => {
      let h = 0x811C9DC5, n = 0;
      const r = await spec.runOurs('coco', {
        onMachine: (m) => {
          if (slow) {
            const st = m.becker.server.store;
            for (const k of ['readRange', 'writeRange', 'stat', 'write']) {
              const f = st[k].bind(st);
              st[k] = (...a) => new Promise((res) => setTimeout(res, Math.random() * 3)).then(() => f(...a));
            }
          }
          m.cpu.trace = (c) => { n++; for (const v of [c.pc, c.a, c.b, c.x, c.y, c.u, c.s, c.cc, c.totalCycles]) h = Math.imul(h ^ v, 16777619) >>> 0; };
        },
      });
      return { h, n, log: r.log.join(), files: JSON.stringify(r.files), done: r.done };
    };
    const fast = await traceOf(false), slow = await traceOf(true);
    check('dw.asm runs to the end', fast.done && slow.done);
    check('a slow store: the same instructions and cycles, the same log and disks', fast.h === slow.h && fast.n === slow.n && fast.log === slow.log && fast.files === slow.files, `(${fast.n} instructions)`);
  }

  // ---------------- the byte queue under a channel and the bridge ----------------
  {
    const { ByteQueue } = require('../js/drivewire/byte-queue.js');
    const q = new ByteQueue();
    check('ByteQueue: push copies and caps', q.push([1, 2, 3]) === 3 && q.push(new Uint8Array([4, 5, 6, 7]), 5) === 2 && q.length === 5 && q.push([9], 5) === 0);
    check('ByteQueue: take crosses chunks, in order; a part-taken chunk keeps the rest', eq([...q.take(2)], [1, 2]) && eq([...q.take(2)], [3, 4]) && eq(q.toArray(), [5]) && q.length === 1);
    check('ByteQueue: take more than waits gives what waits', eq([...q.take(10)], [5]) && q.length === 0 && q.take(3).length === 0);
    check('ByteQueue: from / toArray round-trip (the snapshot form)', eq(ByteQueue.from([7, 8, 9]).toArray(), [7, 8, 9]));
    const many = new ByteQueue();
    for (let i = 0; i < 5000; i++) many.push([i & 0xFF]);
    let ok = true;
    for (let i = 0; i < 5000; i += 7) { const t = many.take(7); for (let k = 0; k < t.length; k++) if (t[k] !== ((i + k) & 0xFF)) ok = false; }
    check('ByteQueue: 5,000 one-byte chunks taken 7 at a time, in order, used chunks dropped', ok && many.length === 0 && many.chunks.length - many.head === 0);
    // a megabyte backlog drained 255 bytes at a time: linear (an array shifted from the front would move ~2 GB)
    const big = new ByteQueue(), t0 = Date.now();
    for (let i = 0; i < 1024; i++) big.push(new Uint8Array(1024).fill(i & 0xFF));
    let sum = 0;
    while (big.length) { const t = big.take(255); sum += t.length; }
    check('ByteQueue: a 1 MB backlog drained 255 bytes at a time quickly (no shifting)', sum === 1 << 20 && Date.now() - t0 < 2000, `(${Date.now() - t0} ms)`);
  }

  // ---------------- a bounded channel queue, and a bridge that waits for the guest ----------------
  {
    const { CHANNEL_QUEUE_MAX } = require('../js/drivewire/server.js');
    const { TO_GUEST_MAX } = require('../js/host/drivewire-ws.js');
    const s = await setup();
    const log = [];
    s.onTransaction = (op, info) => log.push([op, info]);
    await xfer(s, [0x45, 1]);
    const big = new Uint8Array(200000).map((_, i) => i & 0xFF);
    let taken = -1, threw = '';
    try { taken = s.channelSend(1, big); } catch (e) { threw = e.message; }
    check('channelSend of 200,000 bytes: no stack overflow, takes the queue\'s 64 KB', !threw && taken === CHANNEL_QUEUE_MAX && CHANNEL_QUEUE_MAX === 65536, threw || `(${taken})`);
    const drop = log.find((l) => l[0] === 'CHANNEL_DROPPED');
    check('... the rest is dropped, and logged with its count', !!drop && drop[1].channel === 1 && drop[1].dropped === 200000 - 65536 && s.channelRoom(1) === 0);
    check('SERREAD with more than 255 waiting: (1 + 17, 255)', eq(await xfer(s, [0x43]), [18, 255]));
    let reads = 0;
    s.onChannelRead = (ch) => { if (ch === 1) reads++; };
    const got = await xfer(s, [0x63, 1, 255]);
    check('SERREADM takes them in order, and the server says the guest has read (room again)', eq(got, [...big.slice(0, 255)]) && reads === 1 && s.channelRoom(1) === 255);

    // the WebSocket bridge, with a stand-in WebSocket: what the guest cannot take yet waits in the bridge
    class FakeSocket {
      constructor() { FakeSocket.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send() {} close() { if (this.onclose) this.onclose({ code: 1000 }); }
      receive(bytes) { this.onmessage({ data: bytes.buffer }); }
    }
    const ses = new Emu.Session();
    ses.WebSocket = FakeSocket;
    ses.switchMachine('coco', { becker: true });
    const m = ses.machine;
    const states = [];
    const sock = ses.connectDriveWireChannel(2, 'ws://test/');
    sock.onState = (st, detail) => { states.push(detail); ses.emit('drivewire'); };
    for (const b of [0x45, 2]) m.write(0xFF42, b);
    FakeSocket.last.receive(new Uint8Array(100000).map((_, i) => (i * 3) & 0xFF));
    const srv = ses.drivewire;
    check('bridge: the server\'s queue is filled to its cap, the rest waits in the bridge', srv.channels[2].queue.length === CHANNEL_QUEUE_MAX && sock.toGuest.length === 100000 - CHANNEL_QUEUE_MAX && sock.dropped === 0);
    for (const b of [0x63, 2, 200]) m.write(0xFF42, b);
    const first = []; while (m.read(0xFF41) & 2) first.push(m.read(0xFF42));
    check('bridge: when the guest reads, the bridge tops the queue up from what waits, in order',
      first.length === 200 && first[199] === ((199 * 3) & 0xFF) && srv.channels[2].queue.length === CHANNEL_QUEUE_MAX && sock.toGuest.length === 100000 - CHANNEL_QUEUE_MAX - 200);
    // nothing is lost or reordered across the hand-over: the byte after the queue's first 64 KB
    for (let k = 0; k < 256; k++) { for (const b of [0x63, 2, 255]) m.write(0xFF42, b); while (m.read(0xFF41) & 2) m.read(0xFF42); }
    for (const b of [0x63, 2, 1]) m.write(0xFF42, b);
    const at = 200 + 256 * 255;
    check('bridge: bytes after the first 64 KB arrive in order', m.read(0xFF42) === ((at * 3) & 0xFF));
    // a guest far behind: past TO_GUEST_MAX the bridge drops, counts and says so
    const before = sock.toGuest.length, room = srv.channelRoom(2), N = TO_GUEST_MAX + 5000;
    FakeSocket.last.receive(new Uint8Array(N));
    const accepted = TO_GUEST_MAX - before;
    check('bridge: past its own cap the bridge drops the excess, counts it and reports it',
      sock.dropped === N - accepted && sock.toGuest.length === before + accepted - Math.min(room, before + accepted)
      && /bytes dropped: the guest is behind/.test(states[states.length - 1] || ''), `(${sock.dropped} dropped, ${sock.toGuest.length} waiting)`);
  }

  // ---------------- the Session ----------------
  {
    const s = new Emu.Session();
    s.switchMachine('coco', { becker: true });
    const m = s.machine;
    check('Session: the server is on the Becker port of a CoCo with the option', m.becker.server === s.drivewire);
    let msg = '';
    try { await s.importDriveWireImage('odd.dsk', new Uint8Array(300)); } catch (e) { msg = e instanceof Emu.SessionError ? e.message : 'wrong error'; }
    check('Session: an image that is not whole 256-byte sectors is refused', /not a whole number of 256-byte sectors/.test(msg), msg);
    await s.importDriveWireImage('boot.dsk', Uint8Array.from([...sector(1), ...sector(2)]));
    await s.newDriveWireImage('blank.dsk', 4);
    check('Session: images in the store', JSON.stringify(await s.driveWireImages()) === JSON.stringify([{ name: 'blank.dsk', size: 1024 }, { name: 'boot.dsk', size: 512 }]));
    await s.mountDriveWire(0, 'boot.dsk'); await s.mountDriveWire(1, 'blank.dsk', { writeProtected: true });
    msg = '';
    try { await s.mountDriveWire(2, 'nothere.dsk'); } catch (e) { msg = e instanceof Emu.SessionError ? e.message : 'wrong error'; }
    check('Session: mounting an image not in the store is refused', /"nothere.dsk" is not in the store/.test(msg), msg);
    check('Session: what is mounted', JSON.stringify(s.driveWireMounts) === JSON.stringify([{ drive: 0, name: 'boot.dsk', writeProtected: false }, { drive: 1, name: 'blank.dsk', writeProtected: true }]));
    // the guest reads drive 0 LSN 1 through the port; while the store works, advance runs nothing
    for (const b of [0x52, 0, 0, 0, 1]) m.write(0xFF42, b);
    check('Session: while the server waits for the store, the machine waits and advance runs no frames', !!m.stall && s.advance(100) === 0);
    await m.stall;
    const got = [];
    while (m.read(0xFF41) & 2) got.push(m.read(0xFF42));
    check('Session: then the sector arrives', eq(got.slice(3), sector(2)));
    for (const b of [0x50, 0x41, 0x50, 0x0D, 0x46]) m.write(0xFF42, b);
    check('Session: DriveWire printing goes to the printout', s.printoutText().endsWith('A\n'), JSON.stringify(s.printoutText()));
    s.ejectDriveWire(1);
    check('Session: eject', s.driveWireMounts.length === 1);
    const f = await s.driveWireFile('boot.dsk');
    check('Session: an image as a file to keep', f.name === 'boot.dsk' && f.bytes.length === 512);
    msg = '';
    try { s.connectDriveWireChannel(15, 'ws://x/'); } catch (e) { msg = e.message; }
    check('Session: channels are 0-14', /0-14/.test(msg), msg);
    try { s.connectDriveWireChannel(1, 'http://x/'); msg = ''; } catch (e) { msg = e.message; }
    check('Session: a channel connects to a ws:// address', /ws:\/\//.test(msg), msg);
    s.switchMachine('dragon64');
    check('Session: a machine without the port leaves the server alone', s.machine.becker === null);
  }

  // ---------------- a channel over a WebSocket (a local test server) ----------------
  {
    const { startWsServer } = require('./ws-test-server.js');
    const received = [];
    let conn = null;
    const srv = await startWsServer((c) => { conn = c; c.onMessage = (b) => received.push(...b); c.send('HI'); });
    const s = new Emu.Session();
    s.switchMachine('coco', { becker: true });
    const m = s.machine;
    const sock = s.connectDriveWireChannel(4, srv.url);
    // (cond is evaluated once per pass, never again after it holds: a poll consumes what it reads)
    const until = async (cond, ms = 3000) => { const t = Date.now(); for (;;) { if (cond()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 10)); } };
    check('WebSocket: the channel\'s socket opens', await until(() => sock.state === 'open' && conn));
    await until(() => sock.toGuest.length === 2);
    const poll = () => { m.write(0xFF42, 0x43); return [m.read(0xFF42), m.read(0xFF42)]; };
    check('WebSocket: what the socket sends waits until the guest opens the channel', eq(poll(), [0, 0]));
    for (const b of [0x45, 4]) m.write(0xFF42, b);
    check('WebSocket: then it is waiting for the guest: SERREAD (4 + 17, 2)', eq(poll(), [21, 2]));
    for (const b of [0x63, 4, 2]) m.write(0xFF42, b);
    check('WebSocket: SERREADM gives "HI"', eq([m.read(0xFF42), m.read(0xFF42)], str('HI')));
    for (const b of [0x84, 0x6F, 0x64, 4, 2, 0x6B, 0x21]) m.write(0xFF42, b);
    check('WebSocket: what the guest writes (FASTWRITE, SERWRITEM) reaches the socket', await until(() => received.length === 3) && eq(received, str('ok!')), JSON.stringify(received));
    conn.send(Uint8Array.from([7]));
    check('WebSocket: a binary message arrives as its bytes', await until(() => { const r = poll(); return r[0] === 5 && r[1] === 7; }));
    conn.close();
    check('WebSocket: the socket closing closes the channel; SERREAD reports it (16, 4)', await until(() => sock.state === 'closed') && eq(poll(), [16, 4]));
    check('Session: the channel list shows it closed', s.driveWireChannels[0].state === 'closed' && !s.driveWireChannels[0].open);
    s.connectDriveWireChannel(4, null);
    check('Session: disconnecting removes it', s.driveWireChannels.length === 0);
    // The getter used to index the server's 30-record array with the channel NUMBER, so a window channel (128-142)
    // read past the end and threw - and the DriveWire panel calls this getter on every show(). Indexing goes
    // through channelAt(), which maps a window channel to its record.
    s.connectDriveWireChannel(128, 'ws://example.invalid/w');
    let listed = null, threw = null;
    try { listed = s.driveWireChannels; } catch (e) { threw = e; }
    check('Session: a connected window channel appears in the channel list without throwing',
      !threw && listed.length === 1 && listed[0].channel === 128 && listed[0].open === false && listed[0].state === 'connecting',
      threw ? threw.message : JSON.stringify(listed));
    s.connectDriveWireChannel(128, null);
    check('Session: disconnecting a window channel removes it', s.driveWireChannels.length === 0);
    srv.close();
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
