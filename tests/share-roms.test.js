// Run: node tests/share-roms.test.js
//
// Sharing with your own ROMs (js/media/romrefs.js, Session.shareFile): a link
// carries the moment without a byte of a ROM or cartridge image. It names the images by CRC, and every copy of
// their code in memory (BASIC copies itself into RAM: the Dragon 64 in its 64K mode, the CoCo 3) travels as a
// reference that the recipient fills in from their own image.
//
// The "ROMs" here are stand-ins made from this project's own firmware (examples/*.bin), never real ROMs. The
// copies BASIC would make are made here by writing a stand-in into RAM where BASIC puts it.
//
// Checked: no 16-byte window of any stand-in image is anywhere in what the link decodes to (every byte array
// and the JSON text; a run of one repeated byte excepted, as it carries no code); the same ROMs restore the moment
// exactly (the whole snapshot equal, and the machines run on identically); without them the needs-ROMs message
// names what is missing; another version of a ROM is refused, not loaded; a cartridge's image is named, not
// carried, and opens from the recipient's own copy.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const OURS = Buffer.concat(['liza.bin', 'welcome.bin', 'demo.bin', 'chat.bin', 'liza6803-mc10.bin'].map((f) => fs.readFileSync(path.join(__dirname, '../examples', f))));
// a stand-in image of `size` bytes, different for each `seed`
const standIn = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = OURS[(i * 3 + seed) % OURS.length] ^ ((i >> 8) + seed) & 0xFF; return b; };

const W = 16;
const uniform = (a, i) => { for (let k = 1; k < W; k++) if (a[i + k] !== a[i]) return false; return true; };
// every non-uniform 16-byte window of the images, as hex strings
function windows(images) {
  const set = new Set();
  for (const img of images) for (let i = 0; i + W <= img.length; i++) if (!uniform(img, i)) set.add(Buffer.from(img.subarray(i, i + W)).toString('hex'));
  return set;
}
// the first window of `bytes` that is in the set, or -1
function firstWindow(bytes, set) {
  for (let i = 0; i + W <= bytes.length; i++) if (!uniform(bytes, i) && set.has(Buffer.from(bytes.subarray(i, i + W)).toString('hex'))) return i;
  return -1;
}
// Everything a link decodes to, decoded here without the project's own code: the fragment as base64url, gunzip
// (Node's zlib), JSON.parse, and every base64 field ({ $typed, b64 }) and every plain array of byte values (the
// printout, DriveWire's buffers) as bytes; the JSON text itself is scanned too.
function linkContents(link) {
  const text = zlib.gunzipSync(Buffer.from(new URL(link).hash.slice(3), 'base64url'));
  const arrays = [];
  const walk = (v) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) arrays.push(Uint8Array.from(v)); else v.forEach(walk);
    } else if (v && typeof v === 'object') {
      if (typeof v.$typed === 'string' && typeof v.b64 === 'string') arrays.push(new Uint8Array(Buffer.from(v.b64, 'base64')));
      else Object.values(v).forEach(walk);
    }
  };
  walk(JSON.parse(text.toString('utf8')));
  return { text, arrays };
}
const snapText = (m) => Emu.state.toJSON(m.snapshot());
const run = (m, frames) => { for (let i = 0; i < frames; i++) m.runFrame(); return snapText(m); };
// a Session with these ROMs stored for the machine, on that machine
function withRoms(id, roms, config) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  for (const [socket, bytes] of Object.entries(roms)) s.roms.put(id, socket, bytes, `${socket}.rom`);
  s.switchMachine(id, config);
  return s;
}

(async () => {
  const sizes = [];
  for (const [id, config, place] of [
    // the Dragon 64 in its 64K mode runs BASIC from RAM: the 64K-mode BASIC at $8000 to $BFFF
    ['dragon64', undefined, (m, roms) => m.ram.set(roms.basic64, 0x8000)],
    // the CoCo 3 copies its ROM into RAM (the top 32K of its first 64K: blocks $3C to $3F, physical $78000 up)
    ['coco3', { ram: 128 }, (m, roms) => m.memoryArray().set(roms.basic, m.memoryArray().length - 0x8000)],
  ]) {
    const profile = Emu.profiles[id];
    const roms = Object.fromEntries(profile.roms.map((r, k) => [r.id, standIn(r.size || 0x4000, 101 + k * 37)]));
    const s = withRoms(id, roms, config), m = s.machine;
    for (let i = 0; i < 20; i++) m.runFrame();
    place(m, roms);
    m.ram.set(roms[profile.roms[0].id].subarray(0x400, 0xC00), 0x3000);   // and a program that copied part of it
    const full = (await s.snapshotFile()).bytes.length;
    const link = await s.snapshotLink('https://cloadm.dev/play/');
    sizes.push(`${id}: snapshot file ${full} bytes, share link ${link.length} characters`);
    const set = windows(Object.values(roms));
    const { text, arrays } = linkContents(link);
    const inArrays = arrays.map((a) => firstWindow(a, set)).filter((i) => i >= 0);
    check(`${id}: the link holds no 16-byte window of any ROM, in any byte array or the JSON text`, inArrays.length === 0 && firstWindow(text, set) < 0,
      `${arrays.length} byte arrays, ${text.length} bytes of JSON`);
    check(`${id}: before sharing, memory did hold the ROM code (the test sees what it looks for)`, firstWindow(m.memoryArray(), set) >= 0);
    const snap = await s.readSnapshot(Emu.fromBase64Url(new URL(link).hash.slice(3)));
    check(`${id}: the link names the ROMs by CRC and refers to their code in memory`, snap.share.images.length === profile.roms.length
      && snap.share.images.every((x) => x.kind === 'rom' && x.crc === Emu.crc32(roms[profile.roms.find((r) => r.label === x.label).id]))
      && snap.share.refs.some((r) => r.path === 'memory' && r.len >= 0x800), JSON.stringify(snap.share.refs.map((r) => [r.path, r.at, r.len])));

    // the same ROMs: the moment opens exactly
    const r = withRoms(id, roms, config);
    r.openSnapshot(snap);
    check(`${id}: with the same ROMs it opens exactly (the whole snapshot is equal)`, snapText(r.machine) === snapText(m));
    check(`${id}: and both run on identically`, run(r.machine, 30) === run(m, 30));

    // no ROMs: the needs-ROMs message names them
    const none = new Emu.Session({ store: Emu.memoryStore() });
    none.switchMachine(id, config);
    const needs = (() => { try { none.openSnapshot(snap); return null; } catch (e) { return e; } })();
    check(`${id}: without the ROMs, the needs-ROMs message names them and nothing opens`, needs instanceof Emu.SnapshotRomsError
      && profile.roms.every((x) => needs.message.includes(x.label)) && none.machine.id === id && !none.machine.hasRom, needs && needs.message);

    // another version of a ROM: refused, not loaded
    const other = Object.assign({}, roms, { [profile.roms[0].id]: standIn(profile.roms[0].size || 0x4000, 999) });
    const o = withRoms(id, other, config);
    const before = snapText(o.machine);
    const mismatch = (() => { try { o.openSnapshot(snap); return null; } catch (e) { return e; } })();
    check(`${id}: another version of a ROM is refused with a clear message, and the machine is untouched`, mismatch instanceof Emu.SnapshotRomsError
      && /another version of/.test(mismatch.message) && /CRC/.test(mismatch.message) && snapText(o.machine) === before, mismatch && mismatch.message);
  }

  // a cartridge: its image is named, never carried; the recipient's own copy (a program they loaded) fills it in
  {
    const pak = standIn(0x2000, 7);
    pak[0] = 0x20; pak[1] = 0xFE;                       // BRA * at $C000, so it runs and stays put
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('coco');
    s.load('game.ccc', pak);
    for (let i = 0; i < 10; i++) s.machine.runFrame();
    s.machine.ram.set(pak.subarray(0x100, 0x500), 0x2000);   // a copy of part of it in RAM
    const link = await s.snapshotLink('https://cloadm.dev/play/');
    const { text, arrays } = linkContents(link);
    const set = windows([pak]);
    check('cartridge: the link holds no 16-byte window of its image', arrays.every((a) => firstWindow(a, set) < 0) && firstWindow(text, set) < 0);
    const snap = await s.readSnapshot(Emu.fromBase64Url(new URL(link).hash.slice(3)));
    check('cartridge: named by CRC as "the cartridge"', snap.share.images.some((x) => x.kind === 'cartridge' && x.crc === Emu.crc32(pak))
      && snap.share.placed.some((p) => p.path === 'cartridge.state.bytes'));
    const without = new Emu.Session({ store: Emu.memoryStore() });
    without.switchMachine('coco');
    const e = (() => { try { without.openSnapshot(snap); return null; } catch (x) { return x; } })();
    check('cartridge: without it, the message names the cartridge, its size and CRC', e instanceof Emu.SnapshotRomsError && /the cartridge \(8K, CRC [0-9A-F]{8}\)/.test(e.message), e && e.message);
    const own = new Emu.Session({ store: Emu.memoryStore() });
    own.switchMachine('coco');
    own.load('my copy.ccc', pak);                        // the recipient has it: loaded once, kept with recent programs
    own.openSnapshot(snap);
    // compared with the full snapshot opened the same way (a restored cartridge's slot clock counts one more
    // reschedule than the running one, with or without references: restore's own behaviour, not the link's)
    const plain = new Emu.Session({ store: Emu.memoryStore() });
    plain.switchMachine('coco');
    plain.load('my copy.ccc', pak);
    plain.openSnapshot(s.machine.snapshot());
    check('cartridge: with their own copy it opens exactly as the full snapshot does', snapText(own.machine) === snapText(plain.machine));
    check('cartridge: and both run on identically', run(own.machine, 30) === run(plain.machine, 30));
  }

  // ROM bytes outside memory: the printout (a plain array), DriveWire's print buffer and a channel queue (plain
  // arrays in the Becker port's state) and a tape being recorded (pulse timings, left out)
  {
    const roms = { bas: standIn(0x2000, 11), extbas: standIn(0x2000, 23) };
    const s = withRoms('coco', roms, { becker: true }), m = s.machine;
    for (let i = 0; i < 10; i++) m.runFrame();
    m.printed.push(...roms.bas.subarray(0x200, 0x600));                     // a program printed the ROM
    s.drivewire.printBuffer.push(...roms.extbas.subarray(0x100, 0x300));   // and sent it to the DriveWire printer
    m.deck.startRecording();
    for (let i = 0; i < 4; i++) m.runFrame();
    const queued = roms.bas.subarray(0x1000, 0x1100);                      // (code, not padding: many byte values)
    s.drivewire.channels[0].queue.push(queued);                           // and a virtual channel holds it, waiting
    const before = snapText(m);
    check('printout: the moment holds ROM bytes in the printout, the DriveWire print buffer, a channel queue and a recording', before.includes('"printed"')
      && new Set(queued).size > 32 && s.drivewire.channels[0].queue.length === 0x100
      && m.printed.length >= 0x400 && s.drivewire.printBuffer.length >= 0x200 && !!m.deck.recording);
    const link = await s.snapshotLink('https://cloadm.dev/play/');
    const { text, arrays } = linkContents(link);
    const set = windows(Object.values(roms));
    const left = arrays.map((a) => firstWindow(a, set)).filter((i) => i >= 0);
    check('printout: no 16-byte window of either ROM in the link, in any byte array or plain byte list or the JSON text', !left.length && firstWindow(text, set) < 0,
      `${arrays.length} arrays scanned`);
    const snap = await s.readSnapshot(Buffer.from(new URL(link).hash.slice(3), 'base64url'));
    check('printout: the printout, the print buffer and the channel queue travel as references', snap.share.refs.some((r) => r.path === 'printed' && r.len === 0x400)
      && snap.share.refs.some((r) => r.path === 'becker.printBuffer' && r.len === 0x200)
      && snap.share.refs.some((r) => r.path === 'becker.channels.0.queue' && r.len === 0x100), JSON.stringify(snap.share.refs.map((r) => [r.path, r.len])));
    check('recording: a tape being recorded is left out of the shared moment', snap.state.deck.recording === null && snap.share.dropped.includes('deck.recording'));
    const r = withRoms('coco', roms, { becker: true });
    r.openSnapshot(snap);
    check('printout: with the same ROMs the printout comes back byte for byte', Buffer.from(r.machine.printed).equals(Buffer.from(m.printed)));
    const full = JSON.parse(before), back = JSON.parse(snapText(r.machine));
    delete full.state.deck.recording; delete back.state.deck.recording;
    check('printout: and everything else is the moment (all but the recording left out)', JSON.stringify(back) === JSON.stringify(full));
  }

  // the stub: nothing to name, opens anywhere, as before
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    const snap = await s.readSnapshot(Emu.fromBase64Url(new URL(await s.snapshotLink('https://cloadm.dev/play/')).hash.slice(3)));
    check('stub: a moment without ROMs names nothing and needs nothing', snap.share.images.length === 0 && snap.share.refs.length === 0);
  }
  console.log(sizes.join('\n'));
  console.log(`${n - fail}/${n} share-with-ROMs checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
