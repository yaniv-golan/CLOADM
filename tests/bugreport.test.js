// Run: node tests/bugreport.test.js
//
// "Copy bug report" (js/bugreport.js: bugReport(session) and bugReportText). What it holds: the version stamp, the machine and its
// options, the browser, the file loaded last by name and SHA-256, and (only when asked) the ROM-free share link.
// What it must NEVER hold, each one PLANTED here and then looked for in the report, including everything its
// snapshot link decodes to: the Claude key, a user WAD (bytes, name or hash), ROM bytes (no 16-byte window of a ROM)
// and ROM file names (ROMs appear as CRCs only). The "ROMs" are stand-ins from this project's own firmware.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const OURS = Buffer.concat(['liza.bin', 'welcome.bin', 'demo.bin'].map((f) => fs.readFileSync(path.join(__dirname, '../examples', f))));
const standIn = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = OURS[(i * 3 + seed) % OURS.length] ^ ((i >> 8) + seed) & 0xFF; return b; };
const W = 16;
const uniform = (a, i) => { for (let k = 1; k < W; k++) if (a[i + k] !== a[i]) return false; return true; };
const windows = (imgs) => { const s = new Set(); for (const im of imgs) for (let i = 0; i + W <= im.length; i++) if (!uniform(im, i)) s.add(Buffer.from(im.subarray(i, i + W)).toString('hex')); return s; };
const hasWindow = (bytes, set) => { for (let i = 0; i + W <= bytes.length; i++) if (!uniform(bytes, i) && set.has(Buffer.from(bytes.subarray(i, i + W)).toString('hex'))) return true; return false; };
// every byte the report carries: its text, and its snapshot link's fragment decoded without the project's own code: the
// long link (#z=, js/media/snapshot.js encodeLongLink) is base64url of a version byte, then raw deflate of a u32 JSON
// length, the JSON and the byte arrays as raw bytes. The whole inflated box is scanned (JSON text and raw arrays alike).
function everything(text) {
  const out = [Buffer.from(text)];
  const m = /#z=([A-Za-z0-9_-]+)/.exec(text);
  if (m) {
    const bytes = Buffer.from(m[1], 'base64url');
    out.push(zlib.inflateRawSync(bytes.subarray(1)));
  }
  return out;
}

(async () => {
  const { bugReport } = await import('../js/bugreport.js');
  const KEY = 'sk-ant-api03-PLANTED-BUGREPORT-KEY-9f8e7d6c5b4a';
  const ROMNAME = 'PLANTED-my-own-dump-d64.rom';
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.keyStore.set(KEY);
  const p = Emu.profiles.dragon64;
  const roms = p.roms.map((r, k) => standIn(r.size || 0x4000, 21 + k * 17));
  p.roms.forEach((r, k) => s.roms.put('dragon64', r.id, roms[k], k ? `second-${ROMNAME}` : ROMNAME));
  s.switchMachine('dragon64');
  for (let i = 0; i < 10; i++) s.shownMachine.runFrame();

  // a file loaded: named and hashed
  const prog = fs.readFileSync(path.join(__dirname, '../examples/2048.bin'));
  s.load('MYGAME.BIN', new Uint8Array(prog));
  for (let i = 0; i < 5; i++) s.shownMachine.runFrame();
  s.shownMachine.ram.set(roms[0].subarray(0x200, 0xA00), 0x3000);   // a program that copied ROM code into RAM
  const plain = await bugReport(s, { browser: 'TestBrowser/1.0' });
  const sha = crypto.createHash('sha256').update(prog).digest('hex');
  check('the report: version stamp, machine and options, browser, file name and SHA-256', /^Version: v\d+\.\d+\.\d+\S* · \S+$/m.test(plain.text)
    && plain.text.includes('Machine: Dragon 64 (dragon64)') && /ram=64/.test(plain.text) && plain.text.includes('Browser: TestBrowser/1.0')
    && plain.text.includes(`File: MYGAME.BIN, SHA-256 ${sha}`), plain.text);
  check('ROMs by CRC only', p.roms.every((r, k) => plain.text.includes(`${r.id} ${Emu.crc32(roms[k])}`) && /^[0-9A-F]{8}$/.test(Emu.crc32(roms[k])) && Emu.crc32(roms[k]) !== '00000000'));
  check('no snapshot unless asked for (the checkbox is off by default)', !/#[sz]=/.test(plain.text) && !/^Snapshot/m.test(plain.text) && plain.parts.snapshot === null);

  const withSnap = await bugReport(s, { browser: 'TestBrowser/1.0', snapshot: true });
  check('asked for, the snapshot is the ROM-free share link', /^Snapshot \(holds no ROM\): https:\/\/cloadm\.dev\/play\/\?machine=dragon64.*#z=/m.test(withSnap.text));
  const decoded = await s.readSnapshotLink(new URL(withSnap.parts.snapshot).hash);
  check('...and that link opens as a shared snapshot (ROMs as references)', !!decoded && !!decoded.share && decoded.share.images.length === p.roms.length);

  // what must never be in it, with the snapshot included
  const all = everything(withSnap.text), set = windows(roms);
  const has = (needle) => all.some((b) => b.includes(Buffer.from(needle)));
  check('never the Claude key', !has(KEY) && !has('PLANTED-BUGREPORT-KEY'));
  check('never a ROM file name (only CRCs)', !has('PLANTED-my-own-dump') && !has('.rom'));
  check('never a ROM\'s bytes (no 16-byte window of either ROM anywhere it carries)', all.length === 2 && all.every((b) => !hasWindow(b, set)), `${all.length} byte blocks scanned`);
  check('the scan sees ROM code where it is (memory did hold it)', hasWindow(s.shownMachine.memoryArray(), set));

  // a WAD loaded last: not named, not hashed, no bytes
  // by its name alone (no magic), and by its magic alone under another name
  for (const [name, magic] of [['PLANTED-E1M1.wad', 'XXXX'], ['PLANTEDLEVEL.DAT', 'PWAD']]) {
    const wad = new Uint8Array(4096);
    wad.set(Buffer.from(magic), 0);
    for (let i = 4; i < wad.length; i++) wad[i] = (i * 37 + 11) & 0xFF;
    try { s.load(name, wad); } catch (e) { /* not a program: it still counts as the file loaded last */ }
    const r = await bugReport(s, { browser: 'TestBrowser/1.0', snapshot: true });
    const b = everything(r.text), wsha = crypto.createHash('sha256').update(wad).digest('hex');
    check(`a WAD loaded last (${name}): the report says so and holds no name, hash or bytes of it`, r.text.includes('File: a WAD (not included)')
      && !b.some((x) => x.includes(Buffer.from('PLANTED')) || x.includes(Buffer.from(wsha)) || x.includes(Buffer.from(wad.subarray(4, 4 + W)))), r.text.split('\n')[5]);
  }

  // a cartridge loaded last: someone's ROM, so "a cartridge, CRC32 X" and its CRC on the ROMs line; never its name or hash
  {
    const c = new Emu.Session({ store: Emu.memoryStore() });
    c.switchMachine('coco');
    const pak = standIn(0x2000, 77); pak[0] = 0x20; pak[1] = 0xFE;
    c.load('PLANTED-SECRET-CART.ccc', pak);
    for (let i = 0; i < 5; i++) c.shownMachine.runFrame();
    const r = await bugReport(c, { browser: 'B', snapshot: true }), crc = Emu.crc32(pak), psha = crypto.createHash('sha256').update(pak).digest('hex');
    const b = everything(r.text);
    check('a cartridge loaded last: "a cartridge, CRC32 X", its CRC on the ROMs line, no name, no SHA-256, none of its bytes',
      r.text.includes(`File: a cartridge, CRC32 ${crc}`) && new RegExp(`^ROMs \\(CRC32\\): .*cartridge ${crc}`, 'm').test(r.text)
      && !b.some((x) => x.includes(Buffer.from('PLANTED-SECRET-CART')) || x.includes(Buffer.from(psha))) && b.every((x) => !hasWindow(x, windows([pak]))), r.text.split('\n').slice(3, 6).join(' | '));
  }

  // nothing loaded; and a moment that cannot be shared says why instead of failing
  const fresh = new Emu.Session({ store: Emu.memoryStore() });
  fresh.switchMachine('coco');
  const f = await bugReport(fresh, {});
  check('nothing loaded, no ROMs: said plainly', f.text.includes('File: none loaded') && f.text.includes('ROMs (CRC32): none (runs without ROMs)'));
  const { bugReportText } = await import('../js/bugreport.js');
  const noted = bugReportText({ stamp: 'v1 · abc1234', machine: { id: 'coco3', name: 'CoCo 3' }, options: {}, roms: {}, browser: 'B', file: null, snapshot: null, snapshotNote: 'not included (NitrOS-9)' });
  check('a snapshot that cannot be included says why', noted.includes('Snapshot: not included (NitrOS-9)') && noted.includes('Version: v1 · abc1234'));
  // WYRMFIRE with a level converted from the person's own WAD (the Freedoom disk started as level 'user', as
  // tests/wyrmfire-session.test.js does: no id Software data here): the report, asked for its snapshot, carries none
  // (Session.shareFile refuses a WYRMFIRE moment), never the WAD's name, and no 16-byte window of the level disk
  {
    const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');
    const engine = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', PIN.files.engine.path)));
    const level = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', PIN.files.level.path)));
    const ws = new Emu.Session({ welcomeMenu: false });
    ws.startWyrmfire(engine, level, { level: 'user', name: 'MYDOOM-PLANTED.WAD' });
    ws.runFrames(5);
    const w = await bugReport(ws, { snapshot: true });
    check('WYRMFIRE, own WAD: the report says its snapshot is not included, and why', w.parts.snapshot === null && /^not included \(Snapshots are off while WYRMFIRE runs\.\)$/.test(w.parts.snapshotNote), w.parts.snapshotNote);
    check('WYRMFIRE, own WAD: the report never names the WAD, and holds no part of the level disk',
      !/MYDOOM|PLANTED/i.test(w.text) && !everything(w.text).some((b) => hasWindow(b, windows([level]))), w.text);
  }
  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
