// Removing one ROM image (the Library's ROM tiles): Session.romFiles(), removeRom(), restoreRom(), and what a machine
// running the removed image does. The ROMs are synthetic stand-ins written here (a NOP-filled 16K image whose reset
// vector runs a loop that counts in screen memory), never real ones; the expected values are written out by hand.
//  - romFiles: each image once, its file name, size and the machines and cartridges using it, in profile order;
//  - removeRom: the image goes from every socket at once (the store is written, so a new index loaded from the same
//    store no longer has it); a shared image goes from both machines;
//  - restoreRom (Undo): every socket back, byte for byte;
//  - a running machine keeps the removed image: its trace (CPU registers and cycles) and frames are those of a twin
//    that never had it removed, until a switch off and on; after one it runs without ROMs.
// Run: node tests/rom-remove.test.js
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const json = (x) => JSON.stringify(x);
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
// a 16K BASIC stand-in at $8000: NOPs, then at $8000 "INC $0400 ; BRA $8000", reset vector $8000. seed varies a filler
// byte so two images differ
function standIn(seed) {
  const b = new Uint8Array(16384).fill(0x12);
  b.set([0x7C, 0x04, 0x00, 0x20, 0xFB], 0);
  b[0x2000] = seed;
  b[0x3FFE] = 0x80; b[0x3FFF] = 0x00;
  return b;
}
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const regs = (m) => json({ pc: m.cpu.pc, a: m.cpu.a, b: m.cpu.b, x: m.cpu.x, y: m.cpu.y, cc: m.cpu.cc, cycles: m.cpu.totalCycles, frame: m.frameCount });
const screenBytes = (m) => Array.from({ length: 512 }, (_, i) => m.read(0x0400 + i)).join(',');

(async () => {
  // ---- romFiles, remove from every socket, the store written, Undo byte for byte ----
  {
    const store = new MemoryMediaStore();
    const s = new Emu.Session({ media: store });
    s.switchMachine('dragon32');
    const d64 = standIn(1), d32 = standIn(2), dos = new Uint8Array(8192).fill(0x39);
    s.roms.put('dragon64', 'basic', d64, 'd64_1.rom');
    s.roms.put('tanodr64', 'basic', d64, 'd64_1.rom');
    s.roms.put('dragon32', 'basic', d32, 'd32.rom');
    s.roms.put('dragondos', 'rom', dos, 'ddos10.rom');
    const files = s.romFiles();
    check('romFiles: each image once, with its name, size and users in profile order',
      json(files.map((f) => [f.name, f.size, f.users])) === json([['d32.rom', 16384, ['Dragon 32']], ['d64_1.rom', 16384, ['Dragon 64', 'Tano Dragon 64']], ['ddos10.rom', 8192, ['DragonDOS cartridge']]]),
      json(files.map((f) => [f.name, f.size, f.users])));
    const crc = files[1].crc;
    const r = s.removeRom(crc);
    check('removeRom: a shared image goes from both machines; the others stay',
      !s.roms.get('dragon64').basic && !s.roms.get('tanodr64').basic && same(s.roms.get('dragon32').basic, d32) && s.romFiles().length === 2 && !s.roms.image(crc),
      json(s.romFiles().map((f) => f.name)));
    check('removeRom: it says which sockets it was in, and that the Dragon 32 in use does not run it',
      json(r.sockets) === json([{ owner: 'dragon64', socket: 'basic' }, { owner: 'tanodr64', socket: 'basic' }]) && r.running === null && r.name === 'd64_1.rom', json(r.sockets));
    await s.index.flush();
    const fresh = new Emu.Session({ media: store });
    await fresh.index.load();
    check('removeRom is written at once: a library loaded again from the store has no such ROM (a reload)',
      !fresh.roms.image(crc) && !fresh.roms.get('dragon64').basic && fresh.romFiles().length === 2, json(fresh.romFiles().map((f) => f.name)));
    s.restoreRom(r);
    check('restoreRom (Undo): every socket back, byte-identical, with its name',
      same(s.roms.get('dragon64').basic, d64) && same(s.roms.get('tanodr64').basic, d64) && s.roms.fileName(crc) === 'd64_1.rom' && s.romFiles().length === 3);
    let threw = null;
    try { s.removeRom('DEADBEEF'); } catch (e) { threw = e.message; }
    check('removeRom of a CRC not stored is refused', threw === 'That ROM is not stored.', threw);
  }

  // ---- a running machine keeps a removed ROM until it is switched off and on ----
  {
    const mk = () => { const s = new Emu.Session({ media: new MemoryMediaStore() }); s.switchMachine('dragon64'); s.addRoms([{ name: 'd64_1.rom', bytes: standIn(7) }]); return s; };
    const a = mk(), b = mk();
    frames(a, 20); frames(b, 20);
    const crc = a.romFiles()[0].crc;
    const r = a.removeRom(crc);
    check('removing the ROM the machine runs: it says the Dragon 64 runs it, and lists it as still running',
      r.running === 'Dragon 64' && a.romsStillRunning().has(crc) && !b.romsStillRunning().size, json(r.running));
    let ok = true;
    for (let i = 0; i < 30 && ok; i++) { frames(a, 1); frames(b, 1); ok = regs(a.shownMachine) === regs(b.shownMachine) && screenBytes(a.shownMachine) === screenBytes(b.shownMachine); }
    check('after the removal the trace and the frames are those of a twin that kept it (30 frames)', ok, `${regs(a.shownMachine)} ${regs(b.shownMachine)}`);
    a.reset();
    check('a reset is not a switch off and on: it still runs the removed ROM', a.shownMachine.hasRom && a.romsStillRunning().has(crc));
    a.powerCycle();
    check('after a switch off and on the machine runs without ROMs, and nothing is listed as still running',
      !a.shownMachine.hasRom && !a.romsStillRunning().size && !a.machineRoms().bootable);
    // Undo after the power cycle: the ROM goes back in and the machine restarts with it
    a.restoreRom(r);
    check('Undo after a switch off and on: the machine has its ROM again', a.shownMachine.hasRom && a.machineRoms().bootable);
    // Undo before a power cycle: the machine was never touched
    const c = mk(); frames(c, 5);
    const before = regs(c.shownMachine);
    const r2 = c.removeRom(crc); c.restoreRom(r2);
    check('Undo before a switch off and on: nothing listed as still running, the machine untouched',
      !c.romsStillRunning().size && regs(c.shownMachine) === before && c.shownMachine.hasRom);
  }

  // ---- a disk cartridge's ROM, removed while the cartridge is in: it comes out at the next switch off and on ----
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon64');
    const dos = new Uint8Array(8192).fill(0x39); dos[0] = 0x44; dos[1] = 0x4B;
    s.addRoms([{ name: 'ddos10.rom', bytes: dos }]);
    s.drives.insertDos('dragondos');
    const cart = s.shownMachine.cartPort;
    check('the DragonDOS cartridge went in with its ROM', !!(cart && cart.romBytes));
    if (cart && cart.romBytes) {
      const crc = s.romFiles().find((f) => f.name === 'ddos10.rom').crc;
      const r = s.removeRom(crc);
      check('removing the disk ROM the cartridge in use runs: still running until a switch off and on', r.running === 'Dragon 64' && cart.romBytes && s.romsStillRunning().has(crc));
      s.powerCycle();
      check('after a switch off and on the disk cartridge has no ROM', !s.shownMachine.cartPort || !s.shownMachine.cartPort.romBytes);
    }
  }

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
