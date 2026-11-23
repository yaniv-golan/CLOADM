// Snapshot files and opening them (js/media/snapshot.js, Session snapshots and slots).
//  * the file: gzip of JSON, version field, round trip; hand-built files with each defect and the message it gets
//  * every model: a snapshot file taken through the Session and opened in a fresh Session (another "browser")
//    continues with the same instructions, cycles, frames and memory as the original
//  * ROMs: a snapshot names its ROMs by CRC; opening it needs the same ones, never more, never others
//  * switching: a snapshot of another model or config says which machine it needs before anything changes
//  * quick-save slots in the Session's media store, under library/snapshots/
const zlib = require('zlib');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
const kv = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
// a file's bytes decompressed with Node's zlib, or null when it is not gzip at all (so a snapshot saved uncompressed
// is a named FAIL, not a crash: gunzipSync throws, and a check that throws reports nothing by name)
const gunzipOrNull = (bytes) => { try { return zlib.gunzipSync(Buffer.from(bytes)); } catch (e) { return null; } };

// `frames` frames: every instruction (pc, a, b, x, cycles), every frame's pixels, then all of memory
function run(m, frames) {
  let h = 0x811C9DC5;
  m.cpu.trace = (c) => { h = fnv(h, c.pc); h = fnv(h, c.a | 0); h = fnv(h, c.b | 0); h = fnv(h, c.x | 0); h = fnv(h, c.totalCycles); };
  for (let f = 0; f < frames; f++) { m.runFrame(); const px = m.render().data; for (let i = 0; i < px.length; i += 5) h = fnv(h, px[i]); }
  m.cpu.trace = null;
  const mem = m.memoryArray();
  for (let i = 0; i < mem.length; i++) h = fnv(h, mem[i]);
  return h >>> 0;
}
const picture = (m) => { let h = 0x811C9DC5; for (const v of m.render().data) h = fnv(h, v); return h; };

(async () => {
  // ---------------- the file ----------------
  const s = new Emu.Session({ store: kv() });
  s.switchMachine('dragon64');
  for (let f = 0; f < 20; f++) s.shownMachine.runFrame();
  const file = await s.snapshotFile(new Date('2026-11-14T16:30:05.250Z'));
  check('file name: model and time, .cloadm', file.name === 'Dragon64-20261114-163005.cloadm', file.name);
  check('file is gzip', file.bytes[0] === 0x1F && file.bytes[1] === 0x8B);
  // read it back independently of the code under test (Node's zlib, plain JSON). A file that does not decompress is
  // left null here and reported by the named check below, not by a throw that stops the suite before its summary.
  const fileRaw = (() => { try { return zlib.gunzipSync(Buffer.from(file.bytes)); } catch (e) { return null; } })();
  const json = fileRaw ? JSON.parse(fileRaw.toString('utf8')) : {};
  check('the file decompresses (a snapshot saved uncompressed is caught here, by name)', fileRaw != null, fileRaw ? '' : 'it does not decompress');
  check(`header fields: format, version ${Emu.SNAPSHOT_VERSION}, machine, name, taken, config, ROM CRCs; the state has the picture`,
    json.format === 'cloadm-state' && json.version === Emu.SNAPSHOT_VERSION && json.machine === 'dragon64' && json.name === 'Dragon 64'
    && json.taken === '2026-11-14T16:30:05.250Z' && json.config.ram === 64 && JSON.stringify(json.roms) === '{}' && json.state && json.state.frame && json.state.frame.$typed === 'Uint8Array',
    JSON.stringify(Object.keys(json)));
  check('a 64K machine fits in under 40 KB', file.bytes.length < 40 * 1024, `${file.bytes.length} bytes`);

  // ------------- a saved snapshot FILE is gzip, and smaller than what it holds -------------
  // The stored size is a gzip artifact (the compressor's own choice of bytes), which the macOS suite taught the
  // session tests to stop comparing (tests/gzip-contents.js); that leaves NOTHING checking that a snapshot is
  // compressed at all. This does, on files the REAL save paths write - the Session's snapshot file and a quick-save
  // slot in the media store - never on a buffer the test builds itself. For two machines of different sizes (a 64K
  // Dragon, a 512K CoCo 3) the file starts with the gzip magic and is smaller than its own decompressed bytes, and
  // the decompressed bytes are the JSON the file holds (a plain JSON header, read with Node's zlib: the code under
  // test is not trusted to say what is inside). A packet that went uncompressed would fail all three.
  for (const [id, ram] of [['dragon64', 64], ['coco3', 512]]) {
    const m = new Emu.Session({ store: kv() });
    m.switchMachine(id, { ram });
    for (let f = 0; f < 20; f++) m.shownMachine.runFrame();
    const f = await m.snapshotFile(new Date('2026-01-02T03:04:05Z'));
    const raw = gunzipOrNull(f.bytes);
    const head = raw ? JSON.parse(raw.toString('utf8')) : null;
    check(`snapshot file (${id}, ${ram}K): starts with the gzip magic 1f 8b`,
      f.bytes[0] === 0x1F && f.bytes[1] === 0x8B, `${f.bytes[0].toString(16)} ${f.bytes[1].toString(16)}`);
    check(`snapshot file (${id}, ${ram}K): is a whole gzip file (not stored uncompressed)`,
      raw != null, raw ? '' : 'it does not decompress: the file was saved uncompressed');
    check(`snapshot file (${id}, ${ram}K): smaller than the state it holds`,
      raw != null && f.bytes.length < raw.length, `${f.bytes.length} stored vs ${raw ? raw.length : '(not gzip)'} decoded`);
    check(`snapshot file (${id}, ${ram}K): what it holds is this machine's JSON (${head && head.machine})`,
      !!head && head.format === 'cloadm-state' && head.machine === id && head.version === Emu.SNAPSHOT_VERSION, JSON.stringify(head && { format: head.format, machine: head.machine, version: head.version }));
    // the quick-save slot: saved through the Session (saveSlot writes library/snapshots/slot-1.cloadm through the
    // media store), then read back from the store - the file the real save path wrote, not one the test built
    const saved = await m.saveSlot(1);
    const slot = await m.media.read('library/snapshots/slot-1.cloadm');
    const slotRaw = gunzipOrNull(slot);
    check(`quick-save slot (${id}, ${ram}K): stored as gzip, smaller than its contents`,
      !!saved && slot[0] === 0x1F && slot[1] === 0x8B && slotRaw != null && slot.length < slotRaw.length,
      `${slot.length} stored vs ${slotRaw ? slotRaw.length : '(not gzip)'} decoded`);
  }

  const back = await s.readSnapshot(file.bytes);
  const again = await Emu.encodeSnapshot(back, { name: 'Dragon 64', taken: '2026-11-14T16:30:05.250Z' });
  const againRaw = (() => { try { return zlib.gunzipSync(Buffer.from(again)); } catch (e) { return null; } })();
  check('round trip: decode then encode gives the same JSON', againRaw != null && fileRaw != null && againRaw.toString() === fileRaw.toString(),
    againRaw == null ? 'the re-encoded file does not decompress' : '');
  // an uncompressed snapshot keeps the same header and state, so the Session must read one too. The bytes here are
  // made by the test from `back` (the snapshot it just decoded), not by the writer, so this holds even when the writer
  // is the thing under test.
  const unpacked = new TextEncoder().encode(Emu.state.toJSON(Object.assign({}, back)));
  let unpackedRead = null; try { unpackedRead = (await s.readSnapshot(unpacked)).machine; } catch (e) { unpackedRead = e.message; }
  check('uncompressed JSON reads too', unpackedRead === 'dragon64', `read back ${unpackedRead}`);
  check('looksLikeSnapshot: by extension, gzip or JSON; not a .CAS', Emu.looksLikeSnapshot('x.cloadm', new Uint8Array(4)) && Emu.looksLikeSnapshot('a', file.bytes)
    && !Emu.looksLikeSnapshot('liza.cas', new Uint8Array([0x55, 0x55, 0x3C])));
  // an unpacked pre-release file is taken as a snapshot (so it gets the pre-release refusal, not another loader)
  check('looksLikeSnapshot: an uncompressed pre-release file too',
    Emu.looksLikeSnapshot('old.json', new TextEncoder().encode('{"format":"cloadm-snapshot","version":19}')));

  // hand-built defective files: each refused with its own message
  const gz = (obj) => new Uint8Array(zlib.gzipSync(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))));
  const base = Object.assign({}, json);
  const cases = [
    ['not a snapshot (a tape)', new Uint8Array([0x55, 0x55, 0x55, 0x3C, 0x00]), /not a CLOADM snapshot/],
    ['gzip of something else', gz('hello'), /not a CLOADM snapshot/],
    ['damaged gzip', file.bytes.slice(0, 200), /damaged/],
    ['cut-off JSON', gz(JSON.stringify(base).slice(0, 300)), /damaged/],
    ['newer version', gz(Object.assign({}, base, { version: Emu.SNAPSHOT_VERSION + 1 })), new RegExp(`newer CLOADM \\(format version ${Emu.SNAPSHOT_VERSION + 1}; this page reads version ${Emu.SNAPSHOT_VERSION}\\)`)],
    ['older version (0)', gz(Object.assign({}, base, { version: 0 })), /older CLOADM \(format version 0\)/],
    // pre-release builds wrote another layout under the identifier "cloadm-snapshot", up to version 19: refused by
    // the identifier, whatever the version (19 is above SNAPSHOT_VERSION and must not be called newer; 1 must not be read)
    ['pre-release, version 19', gz(Object.assign({}, base, { format: 'cloadm-snapshot', version: 19 })), /^This snapshot was saved by a pre-release build of CLOADM, whose snapshots this version does not read\.$/],
    ['pre-release, version 15', gz(Object.assign({}, base, { format: 'cloadm-snapshot', version: 15 })), /pre-release build of CLOADM/],
    ['pre-release, version 1', gz(Object.assign({}, base, { format: 'cloadm-snapshot', version: 1 })), /pre-release build of CLOADM/],
    ['pre-release, uncompressed', new TextEncoder().encode(JSON.stringify(Object.assign({}, base, { format: 'cloadm-snapshot', version: 19 }))), /pre-release build of CLOADM/],
    ['no version', gz(Object.assign({}, base, { version: undefined })), /no format version/],
    ['unknown machine', gz(Object.assign({}, base, { machine: 'zx81' })), /machine this CLOADM doesn't have \(zx81\)/],
    ['no state', gz(Object.assign({}, base, { state: undefined })), /incomplete/],
  ];
  for (const [name, bytes, re] of cases) {
    const e = await rejects(s.readSnapshot(bytes));
    check(`refused: ${name}`, e instanceof Emu.SessionError && re.test(e.message), e ? e.message : 'accepted');
  }

  // ---------------- every model: open in another browser, continue identically ----------------
  for (const id of Object.keys(Emu.profiles)) {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine(id);
    a.typeText('POKE 1024,65\n');                 // the stub carries out POKE lines: some activity on screen
    for (let f = 0; f < 37; f++) a.shownMachine.runFrame();
    const before = picture(a.shownMachine);
    const f = await a.snapshotFile();
    const b = new Emu.Session({ store: kv() });
    b.switchMachine(id === 'dragon64' ? 'coco' : 'dragon64');
    const snap = await b.readSnapshot(f.bytes);
    const sw = b.snapshotSwitch(snap);
    b.openSnapshot(snap);
    const shown = picture(b.shownMachine);
    const cont = run(a.shownMachine, 30), restored = run(b.shownMachine, 30);
    check(`${id}: opened elsewhere, it asked to switch, shows the same picture and runs identically`, sw && sw.machine === id && b.shownMachine.id === id
      && shown === before && cont === restored, `(${(f.bytes.length / 1024).toFixed(1)} KB)`);
  }

  // a tape in the deck part way through, and the SAM CPU rate, survive
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('coco');
    a.insertTape('t.cas', new Uint8Array(4096).fill(0x55));
    a.shownMachine.deck.motor = true;
    a.typeText('POKE 65495,0\n');
    for (let f = 0; f < 40; f++) a.shownMachine.runFrame();
    const b = new Emu.Session({ store: kv() });
    b.openSnapshot(await b.readSnapshot((await a.snapshotFile()).bytes));
    const t = b.shownMachine.deck.tape;
    check('tape in the deck: same name and position; SAM rate 01 kept; then identical', t && t.name === 't.cas' && b.shownMachine.deck.time === a.shownMachine.deck.time
      && b.shownMachine.sam.rate === 1 && b.cpuRate().rate === 1 && run(a.shownMachine, 20) === run(b.shownMachine, 20), `${a.shownMachine.deck.time}`);
  }

  // the Dragon 64 Plus's own state: the two 32K banks, the 2K video RAM and the plus picture, taken
  // part way through a frame while the 80-column screen is the one being shown
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('d64plus');
    a.setDisplay({ screen: 'plus' });
    const m = a.shownMachine;
    // the plus screen, with the CRTC programmed and characters in the video RAM bank
    for (const [r, v] of [[0, 113], [1, 80], [4, 25], [5, 4], [6, 22], [9, 11], [13, 0]]) { m.write(0xFFE0, r); m.write(0xFFE1, v); }
    m.write(0xFFE2, 0x01);
    for (let i = 0; i < 0x800; i++) m.write(i, (i * 7) & 0xFF);
    // a distinct byte in each 32K bank, then back to bank A so the snapshot holds a non-default selection
    m.write(0xFFE2, 0x00); m.write(0x1000, 0x10);
    m.write(0xFFE2, 0x02); m.write(0x1000, 0x20);
    m.write(0xFFE2, 0x06); m.write(0x1000, 0x30);
    m.write(0xFFE2, 0x02);                          // bank A, no overlay
    for (let f = 0; f < 20; f++) m.runFrame();      // stop somewhere inside a CRTC frame
    const banks = [m.pramBank, m.vramBank], pre = picture(m), videoByte = m.videoRam[0x100];
    const f = await a.snapshotFile();
    const cont = run(a.shownMachine, 30);
    const b = new Emu.Session({ store: kv() });
    b.switchMachine('d64plus');
    b.setDisplay({ screen: 'plus' });               // the host chooses the view (the Display tab), not the snapshot
    b.openSnapshot(await b.readSnapshot(f.bytes));
    const r = b.shownMachine;
    check('Dragon 64 Plus: the banks, the video RAM and the plus picture are in the snapshot',
      r.pramBank === banks[0] && r.vramBank === banks[1] && r.videoRam[0x100] === videoByte
      && r.plusRam[0x1000] === 0x20 && r.ram[0x1000] === 0x10 && r.crtc.reg[0] === 113 && picture(r) === pre,
      `(bank ${banks[0]}, video ${banks[1]}, ${(f.bytes.length / 1024).toFixed(1)} KB)`);
    check('Dragon 64 Plus: the restored machine draws and runs identically from mid-frame', run(b.shownMachine, 30) === cont);
  }

  // ---------------- versions and missing state ----------------
  // SNAPSHOT_VERSION is the layout written; SNAPSHOT_OLDEST the oldest still read (js/machines/machine.js says when
  // each moves). Machine.restore refuses a version outside that range, naming it, and a key missing from a snapshot
  // it does read is damage: refused with a message naming the key.
  {
    check(`SNAPSHOT_OLDEST ${Emu.SNAPSHOT_OLDEST}, SNAPSHOT_VERSION ${Emu.SNAPSHOT_VERSION}: the current is at least the oldest, which is at least 1`,
      Emu.SNAPSHOT_OLDEST >= 1 && Emu.SNAPSHOT_VERSION >= Emu.SNAPSHOT_OLDEST);
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('coco');
    for (let f = 0; f < 10; f++) a.shownMachine.runFrame();
    const snap = await a.readSnapshot((await a.snapshotFile()).bytes);
    let e = throws(() => Emu.createMachine('coco').restore(structuredClone(snap)));
    check('Machine.restore: the current version is read', !e, e && e.message);
    for (const v of [Emu.SNAPSHOT_OLDEST - 1, Emu.SNAPSHOT_VERSION + 1]) {
      e = throws(() => Emu.createMachine('coco').restore(Object.assign({}, snap, { version: v })));
      check(`Machine.restore: version ${v} refused, naming the range it reads`,
        e && e.message === `snapshot format version ${v}; this version reads ${Emu.SNAPSHOT_OLDEST} to ${Emu.SNAPSHOT_VERSION}`, e && e.message);
    }
    e = throws(() => Emu.createMachine('coco').restore(Object.assign({}, snap, { format: 'cloadm-snapshot' })));
    check('Machine.restore: a pre-release identifier is not a snapshot', e && e.message === 'not a snapshot', e && e.message);
    const old = structuredClone(snap); delete old.state.cpu.haltTail;
    e = throws(() => Emu.createMachine('coco').restore(old));
    check('a snapshot lacking a key: refused, naming it', e && /missing "haltTail"/.test(e.message), e && e.message);
    // the CoCo 3's HALT-inside-an-instruction state: stepS / stepN through state.load, stepNoStop checked on its own
    {
      const c = Emu.createMachine('coco3'); c.reset(true); for (let f = 0; f < 3; f++) c.runFrame();
      const ok = structuredClone(c.snapshot());
      const c2 = Emu.createMachine('coco3');
      let ec = throws(() => c2.restore(ok));
      if (!ec) ec = throws(() => { for (let f = 0; f < 3; f++) c2.runFrame(); });
      check('a CoCo 3 snapshot restores and runs', !ec, ec && ec.message);
      const all = structuredClone(ok);
      for (const k of ['stepS', 'stepN', 'stepNoStop', 'haltAt', 'haltS', 'haltK', 'haltN']) delete all.state[k];
      ec = throws(() => Emu.createMachine('coco3').restore(all));
      check('...without its HALT-in-instruction state: refused', ec && /missing/.test(ec.message), ec && ec.message);
      const only = structuredClone(ok); delete only.state.stepNoStop;
      check('...the snapshot really keeps stepS and lacks only stepNoStop', 'stepS' in only.state && !('stepNoStop' in only.state));
      ec = throws(() => Emu.createMachine('coco3').restore(only));
      check('...without only stepNoStop: refused, naming it', ec && /snapshot: missing "stepNoStop"/.test(ec.message), ec && ec.message);
    }
    // The Speech/Sound Pak's AY state, deleted from the path it lives at (state.cartridge.state, not state.cart).
    // The restore must refuse it with the project's own message, not default it and not fail with a TypeError
    // out of the AY's loader.
    {
      const pak = new Emu.SpeechSoundPak({ tms7040Rom: new Uint8Array(0x1000).fill(0xFF), sp0256Rom: new Uint8Array(0x800) });
      const m = Emu.createMachine('coco');
      m.insertCartridge(pak); m.reset(true);
      const whole = JSON.parse(Emu.state.toJSON(m.snapshot()));
      const e0 = throws(() => Emu.restoreSnapshot(Emu.state.fromJSON(JSON.stringify(whole)), m.roms));
      check('a snapshot with a Speech/Sound Pak restores', !e0, e0 && e0.message);
      const snap = structuredClone(whole);
      const cart = snap.state.cartridge.state;
      for (const k of ['ay', 'ayLevel', 'ayDiv']) delete cart[k];
      check('the damaged snapshot really lacks the AY keys',
        !('ay' in cart) && !('ayLevel' in cart) && !('ayDiv' in cart), Object.keys(cart).join(','));
      const e = throws(() => Emu.restoreSnapshot(Emu.state.fromJSON(JSON.stringify(snap)), m.roms));
      check('a snapshot with the AY keys deleted is refused, naming the key',
        e && /snapshot: missing "(ay|ayLevel|ayDiv)"/.test(e.message), e && e.message);
      // The case above deletes all three keys, so state.load refuses ayLevel first and never reaches `ay`.
      // Delete ONLY `ay`, so the `ay` check itself is what refuses.
      const only = structuredClone(whole);
      delete only.state.cartridge.state.ay;
      check('the snapshot really keeps ayLevel and ayDiv, and lacks only ay',
        'ayLevel' in only.state.cartridge.state && 'ayDiv' in only.state.cartridge.state && !('ay' in only.state.cartridge.state),
        Object.keys(only.state.cartridge.state).join(','));
      const ea = throws(() => Emu.restoreSnapshot(Emu.state.fromJSON(JSON.stringify(only)), m.roms));
      check('a snapshot missing only `ay` is refused, naming it',
        ea && /snapshot: missing "ay"/.test(ea.message), ea && ea.message);
    }
  }

  // ---------------- decompression limit ----------------
  // A gzip file of zeros is ~1000 times smaller than what it unpacks to: decoding stops once more than the limit
  // has come out (SNAPSHOT_MAX_BYTES, 64 MiB; the largest real snapshot is about 1 MB), before allocating it all.
  {
    check('the default limit is 64 MiB', Emu.SNAPSHOT_MAX_BYTES === 64 << 20, String(Emu.SNAPSHOT_MAX_BYTES));
    const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(3 << 20), { level: 9 }));
    const e = await rejects(Emu.decodeSnapshot(bomb, { maxBytes: 1 << 20 }));
    check('a file unpacking past the limit: refused, saying so', e instanceof Emu.SnapshotError && /unpacks to more than 1 MB/.test(e.message), e && e.message);
    const plain = new Uint8Array(2000).fill(0x20);
    const e2 = await rejects(Emu.decodeSnapshot(plain, { maxBytes: 1000 }));
    check('an uncompressed file over the limit: refused too', e2 instanceof Emu.SnapshotError && /more than 1000 bytes/.test(e2.message), e2 && e2.message);
    const real = (await s.snapshotFile()).bytes;
    check('a real snapshot is far under the default', (await Emu.decodeSnapshot(real)).machine === 'dragon64');
  }

  // ---------------- ROMs ----------------
  {
    const basic = fake(0x4000, 7), other = fake(0x4000, 8);
    const a = new Emu.Session({ store: kv() });
    a.roms.put('dragon32', 'basic', basic, 'd32.rom');
    a.switchMachine('dragon32');
    for (let f = 0; f < 10; f++) a.shownMachine.runFrame();
    check('the snapshot names the ROM by CRC, never its bytes', !a.shownMachine.useStub);
    const bytes = (await a.snapshotFile()).bytes;
    const text = gunzipOrNull(bytes) != null ? gunzipOrNull(bytes).toString() : '';   // (named, not thrown: see gunzipOrNull)
    const crc = Emu.crc32(basic);
    check('...', text !== '' && JSON.parse(text).roms.basic === crc && !text.includes(Buffer.from(basic.subarray(0, 48)).toString('base64')));
    const b = new Emu.Session({ store: kv() });
    b.switchMachine('dragon64');
    const snap = await b.readSnapshot(bytes);
    let e = throws(() => b.openSnapshot(snap));
    check('no ROMs here: refused, saying what it needs, and the machine in use is unchanged', e instanceof Emu.SnapshotRomsError && e.machine === 'dragon32'
      && e.message === 'This snapshot needs Dragon 32 BASIC. Add ROMs once and it opens right here.' && b.shownMachine.id === 'dragon64', e && e.message);
    b.roms.put('dragon32', 'basic', other);
    e = throws(() => b.openSnapshot(snap));
    check('another ROM version: refused with both CRCs', e instanceof Emu.SnapshotRomsError && /another version of Dragon 32 BASIC \(it ran with CRC [0-9A-F]{8}, yours is [0-9A-F]{8}\)/.test(e.message), e && e.message);
    b.roms.put('dragon32', 'basic', basic);
    b.openSnapshot(snap);
    check('with the same ROM: opens and runs identically', b.shownMachine.id === 'dragon32' && !b.shownMachine.useStub && run(a.shownMachine, 20) === run(b.shownMachine, 20));
    // a stub snapshot opened where ROMs are stored: on the stub (and the machine says so), identical
    const c = new Emu.Session({ store: kv() });
    c.switchMachine('dragon32');
    c.runWithoutRoms();
    for (let f = 0; f < 10; f++) c.shownMachine.runFrame();
    const stubSnap = await b.readSnapshot((await c.snapshotFile()).bytes);
    b.openSnapshot(stubSnap);
    check('a stub snapshot opens on the stub where ROMs are stored', b.shownMachine.useStub && b.stubChosen.has('dragon32') && run(c.shownMachine, 20) === run(b.shownMachine, 20));
    // the core refuses a ROM set that differs either way
    const m = Emu.createMachine('dragon32');
    check('Machine.restore: refused with an extra ROM the snapshot ran without', /without basic ROM/.test((throws(() => { m.setRoms({ basic }); m.restore(stubSnap); }) || {}).message));
  }

  // ---------------- switching ----------------
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('mc10', { ram: 4 });
    const snap = await a.readSnapshot((await a.snapshotFile()).bytes);
    check('same machine and config: no switch', a.snapshotSwitch(snap) === null);
    a.switchMachine('mc10', { ram: 20 });
    const sw = a.snapshotSwitch(snap);
    check('other RAM: switch to MC-10 (4K)', sw && sw.text === 'MC-10 (4K)' && sw.config.ram === 4, sw && sw.text);
    a.switchMachine('coco3');
    check('other model: switch to it', a.snapshotSwitch(snap).text === 'MC-10 (4K)');
    a.openSnapshot(snap);
    check('opened: the MC-10 with 4K, remembered as its config', a.shownMachine.id === 'mc10' && a.shownMachine.config.ram === 4 && a.savedConfig('mc10').ram === 4);
    check('Machine.restore: other config refused', !!throws(() => Emu.createMachine('mc10', { ram: 20 }).restore(snap)));
    // a config the model can't take is not remembered: the machine falls back to its defaults
    const st = kv(), d = new Emu.Session({ store: st });
    d.switchMachine('dragon32', { ram: 999 });
    check('switchMachine with a config the model can\'t take: defaults, nothing remembered', d.shownMachine.config.ram === 32 && st.get('config.dragon32') === null, st.get('config.dragon32'));
  }

  // ---------------- a snapshot that can't be restored changes nothing ----------------
  // The machine is built and restored aside and swapped in only when that worked: a damaged file
  // leaves the machine in use, its config, the remembered machine and the stub choice exactly as they were.
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('coco2b');
    for (let f = 0; f < 5; f++) a.shownMachine.runFrame();
    const good = await a.readSnapshot((await a.snapshotFile()).bytes);
    const store = kv(), b = new Emu.Session({ store });
    b.switchMachine('dragon64');
    for (let f = 0; f < 5; f++) b.shownMachine.runFrame();
    const before = b.shownMachine, h = picture(before), pc = before.cpu.pc, keys = JSON.stringify(store.keys().sort().map((k) => [k, store.get(k)]));
    const bad = structuredClone(good);
    bad.state.memory = bad.state.memory.slice(0, 100);
    const e = throws(() => b.openSnapshot(bad));
    check('a snapshot that fails to restore: refused as a SessionError', e instanceof Emu.SessionError && /memory size/.test(e.message), e && `${e.constructor.name}: ${e.message}`);
    check('...the machine in use is the same object, untouched', b.shownMachine === before && b.shownMachine.id === 'dragon64' && picture(b.shownMachine) === h && b.shownMachine.cpu.pc === pc);
    check('...nothing remembered changed (machine, config)', JSON.stringify(store.keys().sort().map((k) => [k, store.get(k)])) === keys);
    check('...the stub choice is unchanged', !b.stubChosen.has('coco2b') && !b.stubChosen.has('dragon64'));
    // the same machine and config (no switch): the machine in use is not touched either
    const c = new Emu.Session({ store: kv() });
    c.switchMachine('coco2b');
    for (let f = 0; f < 5; f++) c.shownMachine.runFrame();
    const cm = c.shownMachine, ch = picture(cm), cpc = cm.cpu.pc;
    check('same model, damaged snapshot: refused, the machine untouched', throws(() => c.openSnapshot(bad)) instanceof Emu.SessionError && c.shownMachine === cm && picture(cm) === ch && cm.cpu.pc === cpc);
    b.openSnapshot(good);
    check('then the good one opens', b.shownMachine.id === 'coco2b' && run(a.shownMachine, 10) === run(b.shownMachine, 10));
  }

  // ---------------- the machine a snapshot opens on is the Session's like any other ----------------
  // (openSnapshot and switchMachine share Session.adopt): its Becker port is connected to the Session's DriveWire
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('coco', { becker: true });
    for (let f = 0; f < 5; f++) a.shownMachine.runFrame();
    const snap = await a.readSnapshot((await a.snapshotFile()).bytes);
    const b = new Emu.Session({ store: kv() });
    b.switchMachine('dragon64');
    b.openSnapshot(snap);
    check('opened with a Becker port: it is attached to the Session\'s DriveWire server', !!b.shownMachine.becker && b.shownMachine.becker.server === b.drivewire);
    const c = new Emu.Session({ store: kv() });
    c.switchMachine('coco', { becker: true });
    const before = c.shownMachine;
    c.openSnapshot(snap);           // the same model and config: no switch, but a new machine all the same
    check('...also when no switch was needed', c.shownMachine !== before && c.shownMachine.becker.server === c.drivewire);
  }

  // ---------------- breakpoints and watchpoints come back with the snapshot ----------------
  // The debugger's setup is part of the snapshot (Machine.saveState `debugger`); opening it through
  // the Session gives the Session's debugger those breakpoints, with the Session's symbols.
  {
    const a = new Emu.Session({ store: kv() });
    a.switchMachine('dragon64');
    a.debug.addBreakpoint(0x8123);
    a.debug.addWatchpoint(0x0400, 4, { read: false, write: true });
    const snap = await a.readSnapshot((await a.snapshotFile()).bytes);
    const b = new Emu.Session({ store: kv() });
    b.switchMachine('coco');
    b.setLabels(new Map([['HERE', 0x8123]]));
    b.openSnapshot(snap);
    check('opened: the breakpoints are the Session debugger\'s', JSON.stringify(b.debug.breakpoints()) === '[33059]', JSON.stringify(b.debug.breakpoints()));
    check('...and the watchpoints', JSON.stringify(b.debug.watchpoints()) === JSON.stringify([{ start: 0x400, size: 4, read: false, write: true }]), JSON.stringify(b.debug.watchpoints()));
    check('...the debugger is the machine\'s and shows the Session\'s symbols', b.debug.machine === b.shownMachine && b.shownMachine.debugger === b.debug
      && (b.shownMachine.poke(0x3000, 0x7E), b.shownMachine.poke(0x3001, 0x81), b.shownMachine.poke(0x3002, 0x23), /HERE/.test(b.debug.disassemble(0x3000, 1)[0].text)), b.debug.disassemble(0x3000, 1)[0].text);
    // a snapshot without a debugging setup clears the old machine's breakpoints
    const c = new Emu.Session({ store: kv() });
    c.switchMachine('dragon64');
    c.debug.addBreakpoint(0x9000);
    const d = new Emu.Session({ store: kv() });
    d.switchMachine('dragon64');
    const plain = await d.readSnapshot((await d.snapshotFile()).bytes);
    c.openSnapshot(plain);
    check('a snapshot without breakpoints: none afterwards', c.debug.breakpoints().length === 0);
  }

  // ---------------- quick-save slots, in the Session's media store (a MemoryMediaStore here) ----------------
  {
    const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
    const { MediaStoreError } = require('../js/host/media-store.js');
    const media = new MemoryMediaStore();
    const a = new Emu.Session({ store: kv(), media });
    a.switchMachine('coco2b');
    check('three empty slots', JSON.stringify(await a.listSlots()) === '[{"n":1,"empty":true},{"n":2,"empty":true},{"n":3,"empty":true}]');
    for (let f = 0; f < 15; f++) a.shownMachine.runFrame();
    await a.saveSlot(2);
    const list = await a.listSlots();
    check('slot 2 holds the CoCo 2B, a snapshot file in the library (library/snapshots/), so the Library lists it',
      list[1].machine === 'coco2b' && list[1].name === 'CoCo 2B' && list[1].size > 0 && list[0].empty
      && (await a.library.listMedia()).map((x) => x.name).join() === 'library/snapshots/slot-2.cloadm', JSON.stringify(list[1]));
    const b = new Emu.Session({ store: kv(), media });   // a reload: a new page, the same store
    b.switchMachine('dragon64');
    const snap = await b.readSlot(2);
    b.openSnapshot(snap);
    check('after a reload, slot 2 opens the same moment', b.shownMachine.id === 'coco2b' && run(a.shownMachine, 20) === run(b.shownMachine, 20));
    check('empty slot: says so', /Snapshot 1 is empty/.test((await rejects(b.readSlot(1))).message));
    check('no snapshot 4', /no snapshot 4/.test((await rejects(b.saveSlot(4))).message));
    check('no snapshot 1.5', /no snapshot 1\.5/.test(((await rejects(b.saveSlot(1.5))) || {}).message) && !(await media.stat('library/snapshots/slot-1.5.cloadm')));
    check('readSlot(1.5) and clearSlot(1.5): no such slot either', /no snapshot 1\.5/.test(((await rejects(b.readSlot(1.5))) || {}).message) && /no snapshot 1\.5/.test(((await rejects(b.clearSlot(1.5))) || {}).message));
    await media.write('library/snapshots/slot-3.cloadm', new Uint8Array([1, 2, 3]));
    const bad = (await b.listSlots())[2];
    check('a damaged slot is listed with its error', /not a CLOADM snapshot/.test(bad.error), JSON.stringify(bad));
    // a slot a pre-release build saved: listed with the pre-release refusal, and refused when opened
    const slot2Raw = gunzipOrNull(await media.read('library/snapshots/slot-2.cloadm'));
    const pre = new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, slot2Raw ? JSON.parse(slot2Raw.toString()) : {}, { format: 'cloadm-snapshot', version: 19 })))));
    await media.write('library/snapshots/slot-3.cloadm', pre);
    const preRow = (await b.listSlots())[2];
    check('a pre-release slot is listed with the pre-release refusal', /pre-release build of CLOADM/.test(preRow.error), JSON.stringify(preRow));
    const preErr = await rejects(b.readSlot(3));
    check('...and opening it is refused with the same message', preErr instanceof Emu.SessionError && /pre-release build of CLOADM/.test(preErr.message), preErr && preErr.message);
    await b.clearSlot(2);
    check('cleared', (await b.listSlots())[1].empty);
    // a full store: the user is told, nothing half-written is listed
    const full = new MemoryMediaStore();
    full.write = async () => { throw new MediaStoreError('quota', 'full'); };
    const c = new Emu.Session({ store: kv(), media: full });
    c.switchMachine('dragon64');
    const e = await rejects(c.saveSlot(1));
    check('full storage: taking a snapshot says there is no space', e instanceof Emu.SessionError && /No space left in this browser's storage for snapshot 1/.test(e.message)
      && (await c.listSlots())[0].empty, e && e.message);
  }

  // share links (the Share screen): the snapshot in the URL's fragment, base64url, read back to the same moment
  {
    const s = new Emu.Session();
    s.switchMachine('coco3', { ram: 128 });
    for (let i = 0; i < 30; i++) s.shownMachine.runFrame();
    s.shownMachine.poke(0x2000, 0x5A);
    const link = await s.snapshotLink('https://cloadm.dev/play/?start=liza#share');
    const u = new URL(link);
    check('share link: /play/ with the machine and its options, the snapshot after #s= in base64url',
      u.pathname === '/play/' && u.search === '?machine=coco3&cpu=6809&ram=128&becker=0&ssc=none' && /^#s=[A-Za-z0-9_-]+$/.test(u.hash), link.slice(0, 90));
    const ref = run(s.shownMachine, 0);
    const b = new Emu.Session();
    b.switchMachine('dragon64');
    const snap = await b.readSnapshotLink(u.hash);
    b.openSnapshot(snap);
    check('share link: read back in a fresh Session, the same machine, config and memory', b.shownMachine.id === 'coco3' && b.shownMachine.config.ram === 128
      && run(b.shownMachine, 0) === ref && b.shownMachine.peek(0x2000) === 0x5A);
    check('share link: no #s= is no snapshot', (await b.readSnapshotLink('#share')) === null && (await b.readSnapshotLink('')) === null);
    const cut = await rejects(b.readSnapshotLink(u.hash.slice(0, u.hash.length - 300)));
    const bad = await rejects(b.readSnapshotLink('#s=not*base64!'));
    const junk = await rejects(b.readSnapshotLink('#s=' + Buffer.from('hello').toString('base64url')));
    check('share link: cut short, changed or not a snapshot: "damaged", as a SessionError', [cut, bad, junk].every((e) => e instanceof Emu.SessionError && /This link's snapshot is damaged/.test(e.message)),
      [cut, bad, junk].map((e) => e && e.message).join(' | '));
    // with ROMs or a cartridge the link is made too, without their bytes (tests/share-roms.test.js checks the bytes)
    const r = new Emu.Session();
    r.switchMachine('dragon64');
    r.shownMachine.setRoms({ basic: fake(0x4000, 7) });
    const withRoms = await r.readSnapshotLink(new URL(await r.snapshotLink('https://cloadm.dev/play/')).hash);
    check('share link: with your own ROMs, made; it names them by CRC', withRoms.roms.basic === Emu.crc32(fake(0x4000, 7))
      && withRoms.share.images.some((x) => x.kind === 'rom' && x.crc === withRoms.roms.basic));
    check('base64url round trip, every byte value', (() => { const all = Uint8Array.from({ length: 256 * 3 + 1 }, (_, i) => (i * 7) & 0xFF);
      const t = Emu.toBase64Url ? Emu.toBase64Url(all) : null; return t && /^[A-Za-z0-9_-]+$/.test(t) && Buffer.from(Emu.fromBase64Url(t)).equals(Buffer.from(all)); })());
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
