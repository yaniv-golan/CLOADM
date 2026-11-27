// A machine's ROM image given to the program loader (the page's Open…, the MCP load tool) is not a cartridge.
// Reported on 0.4.1 from an iPhone: the Dragon 64 BASIC ROM opened with Open… came up as a Program Pak, the
// Library then added the same file as the machine's BASIC and switched it on, and BASIC started with itself in the
// cartridge slot: a green screen, "No OK after 5 seconds" and "The ROMs are recognised, so this looks like a problem
// in CLOADM". Session.load now refuses a ROM image (Session.isRom: known contents or the usual name) as a cartridge,
// and the page's Open… sends it to Your ROMs, as a drop on the screen does (tools/browser-check.js, group romInput).
// Every image here is synthetic: our own stand-in BASIC (tests/fixtures/reset-firmware.js) or seeded bytes, with
// the CRC forged only where recognition by contents is what is tested. No real ROM is used.
const Emu = require('./load')();
const { build } = require('./fixtures/reset-firmware');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const frames = (s, n) => { for (let i = 0; i < n; i++) s.shownMachine.runFrame(); };

// CRC-32 forging at a chosen offset: the 4 bytes at `pos` chosen so that the whole image has the wanted CRC (the
// CRC run forwards over what is before them and backwards over what is after). The code and vectors are untouched.
function forgeCrcAt(bytes, pos, want) {
  const T = new Uint32Array(256), top = new Uint8Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; top[T[n] >>> 24] = n; }
  let a = 0xFFFFFFFF;
  for (const b of bytes.subarray(0, pos)) a = (T[(a ^ b) & 0xFF] ^ (a >>> 8)) >>> 0;
  const back = (x, b) => { const j = top[x >>> 24]; return (((x ^ T[j]) << 8) | (j ^ b)) >>> 0; };
  let x = (parseInt(want, 16) ^ 0xFFFFFFFF) >>> 0;
  for (let i = bytes.length - 1; i >= pos + 4; i--) x = back(x, bytes[i]);
  for (let i = 0; i < 4; i++) x = back(x, 0);
  const v = (x ^ a) >>> 0, out = bytes.slice();
  for (let i = 0; i < 4; i++) out[pos + i] = (v >>> (8 * i)) & 0xFF;
  if (Emu.crc32(out) !== want) throw new Error(`forging ${want} failed`);
  return out;
}
const D64_1 = Emu.profiles.dragon64.roms.find((r) => r.id === 'basic').crcs[0];
const D64_2 = Emu.profiles.dragon64.roms.find((r) => r.id !== 'basic' && !r.chip).crcs[0];

// ---- a ROM image is refused as a cartridge, by name, by contents, and as a combined 32K image ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  frames(s, 3);
  const m = s.shownMachine, before = s.library.recentMedia().length;
  const cases = [
    ['the usual name (contents unknown)', 'd64_1.rom', fake(0x4000, 1)],
    ['known contents under another name', 'Dragon 64 BASIC.rom', forgeCrcAt(fake(0x4000, 2), 0x2000, D64_1)],
    ['a combined 32K image of the two', 'dragon64.rom', (() => {
      const b = new Uint8Array(0x8000);
      b.set(forgeCrcAt(fake(0x4000, 3), 0x2000, D64_1), 0); b.set(forgeCrcAt(fake(0x4000, 4), 0x2000, D64_2), 0x4000);
      return b;
    })()],
    ['a disk controller\'s ROM', 'ddos10.rom', fake(0x2000, 5)],
  ];
  for (const [what, name, bytes] of cases) {
    check(`${what}: Session.isRom says so`, Emu.Session.isRom(name, bytes));
    const e = refused(() => s.load(name, bytes));
    check(`${what}: load refuses it, saying it is a ROM to add, not a cartridge`,
      e instanceof Emu.SessionError && e.message === `${name} is a ROM image for a machine or a disk controller, not a cartridge: add it as a ROM (Add ROMs on the page, \`add_roms\` for the MCP server, --roms for the command line).`, e && e.message);
    check(`${what}: nothing went into the cartridge slot, the machine was not restarted, and it is not on the recent list`,
      m.cartPort === null && s.shownMachine === m && !m.hasRom && s.library.recentMedia().length === before,
      JSON.stringify({ cart: m.cartPort && m.cartPort.name, recent: s.library.recentMedia().length }));
  }
  // a cartridge that is not a ROM image still goes in, as before
  const msg = s.load('game.rom', fake(0x4000, 6), { remember: false });
  check('a cartridge image still loads as a Program Pak', /^game\.rom: Program Pak inserted/.test(msg) && m.cartPort && m.cartPort.name === 'Program Pak', msg);
}

// ---- the reported sequence: the page's Open… loaded the file, then kept it in the Library (which adds a ROM) ----
{
  const { basic, basic64 } = build(Emu);
  // our stand-in BASIC (prints OK), carrying the Dragon 64 ROMs' CRCs so that its sockets say "recognised"
  const rom1 = forgeCrcAt(basic, 0x3000, D64_1), rom2 = forgeCrcAt(basic64, 0x3000, D64_2);
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  frames(s, 3);
  const m = s.shownMachine;
  (async () => {
    // media-panel.js before the fix: doLoad = session.load, then keep() = library.importMedia
    const e = refused(() => s.load('d64_1.rom', rom1));
    const kept = await s.library.importMedia('d64_1.rom', rom1);
    await s.library.importMedia('d64_2.rom', rom2);
    frames(s, 10);
    check('Open… then keep: the load is refused and the Library adds the file as the machine\'s ROM', !!e && !!kept.roms && m.hasRom, e && e.message);
    check('Open… then keep: the cartridge slot stays empty, so BASIC is not started with itself plugged in',
      m.cartPort === null, m.cartPort && m.cartPort.name);
    const sockets = s.machineRoms('dragon64').sockets;
    check('the stand-in ROMs are recognised by contents (as in the report)', sockets.filter((x) => !x.chip).every((x) => x.status === 'verified'), JSON.stringify(sockets));
    check('with the ROMs added and the slot empty, our stand-in BASIC boots to OK (a sanity check of this set-up; it masks FIRQ, so it would boot with a cartridge in too)', s.bootStatus().state === 'ok', JSON.stringify(s.bootStatus()));
    console.log(fail ? `${fail} failed` : 'all passed');
    process.exitCode = fail ? 1 : 0;
  })().catch((err) => { console.log(`FAIL ${err.stack}`); process.exitCode = 1; });
}
