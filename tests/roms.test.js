// ROM identification across all machines, the per-machine ROM library and Session.addRoms.
// Only synthetic byte arrays are used: "known-good" CRCs are those of fake images, injected through test
// profiles. No real ROM is involved.
const Emu = require('./load')();
const { identifyRoms, socketStatus, isBootable, looksLikeRom, RomLibrary } = require('../js/roms.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// distinct synthetic images: a size and a seed
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed * 2654435761 >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const crc = Emu.crc32;
const K = 1024;

// ---- test profiles (data only, same shape as js/machines/profiles.js) ----
const slot = (id, label, size, at, files, crcs, o = {}) => Object.assign({ id, label, size, at, files, crcs, bank: 0, required: false }, o);
const A1 = fake(16 * K, 1), A2 = fake(16 * K, 2), B = fake(8 * K, 3), C = fake(8 * K, 4), D = fake(16 * K, 5), E = fake(32 * K, 6);
const P = {
  // Dragon 64 style: two 16K sockets in two banks
  d64: { id: 'd64', name: 'Test 64', roms: [slot('basic', '32K-mode BASIC', 16 * K, 0x8000, ['t64_1.rom'], [crc(A1)], { required: true }), slot('basic64', '64K-mode BASIC', 16 * K, 0x8000, ['t64_2.rom'], [crc(A2)], { bank: 1 })] },
  // a second model sharing the 64K-mode chip
  d200: { id: 'd200', name: 'Test 200', roms: [slot('basic', '32K-mode BASIC', 16 * K, 0x8000, ['t200.rom'], [crc(D)], { required: true }), slot('basic64', '64K-mode BASIC', 16 * K, 0x8000, ['t200_2.rom'], [crc(A2)], { bank: 1 })] },
  // CoCo style: BASIC at $A000 (required), Extended BASIC at $8000 (optional)
  cc: { id: 'cc', name: 'Test CoCo', roms: [slot('bas', 'Color BASIC', 8 * K, 0xA000, ['tbas.rom'], [crc(B)], { required: true }), slot('extbas', 'Extended Color BASIC', 8 * K, 0x8000, ['textbas.rom'], [crc(C)])] },
  // one 32K socket with an unknown-CRC revision
  c3: { id: 'c3', name: 'Test 3', roms: [slot('basic', 'Super Extended BASIC', 32 * K, 0x8000, ['t3.rom'], [crc(E)], { required: true, aliases: ['t3alt.rom'] })] },
  // a disk-controller cartridge ROM: stored, never booted
  dos: { id: 'dos', name: 'Test DOS cartridge', kind: 'cartridge', roms: [slot('rom', 'DOS ROM', 8 * K, 0xC000, ['tdos.rom'], [], { aliases: ['tdos2.rom'] })] },
};
const id = (files, current = null) => identifyRoms(files, P, current).files;
const targets = (r) => r.targets.map((t) => `${t.machine}/${t.socket}`).sort().join(',');

// ---- identification ----
{
  const [r] = id([{ name: 'whatever.bin', bytes: A1 }]);
  check('CRC match is verified regardless of the file name', r.result === 'verified' && targets(r) === 'd64/basic');
}
{
  const [r] = id([{ name: 'x', bytes: A2 }]);
  check('a ROM shared by several models goes to all of them', r.result === 'verified' && targets(r) === 'd200/basic64,d64/basic64', targets(r));
}
{
  const both = new Uint8Array(32 * K); both.set(A1); both.set(A2, 16 * K);
  const [r] = id([{ name: 'combined.rom', bytes: both }]);
  check('combined 32K image is split into both sockets (verified halves)', r.result === 'verified' && targets(r) === 'd64/basic,d64/basic64'
    && r.targets.find((t) => t.socket === 'basic').bytes.every((v, i) => v === A1[i]), targets(r));
  const cc = new Uint8Array(16 * K); cc.set(C); cc.set(B, 8 * K);   // $8000 Extended BASIC, then $A000 Color BASIC
  const [r2] = id([{ name: 'coco16k.rom', bytes: cc }]);
  check('combined 16K CoCo image: Extended BASIC first, then Color BASIC', r2.result === 'verified' && targets(r2) === 'cc/bas,cc/extbas'
    && r2.targets.find((t) => t.socket === 'bas').bytes.every((v, i) => v === B[i]));
}
{
  const [r] = id([{ name: 'T3.ROM', bytes: fake(32 * K, 99) }]);
  check('usual file name with the right size loads unrecognised', r.result === 'loaded-unrecognised' && targets(r) === 'c3/basic');
  const [w] = id([{ name: 't3.rom', bytes: fake(16 * K, 98) }], 'c3');
  check('usual file name with the wrong size is rejected, naming the size', w.result === 'rejected' && /16K instead of 32K/.test(w.message), w.message);
}
{
  const [r] = id([{ name: 'dump.bin', bytes: fake(8 * K, 50) }], 'cc');
  check('unknown file fits the machine in use by size (unrecognised)', r.result === 'loaded-unrecognised' && targets(r) === 'cc/bas');
  const [x] = id([{ name: 'dump.bin', bytes: fake(8 * K, 50) }]);
  check('size alone never assigns to other machines', x.result === 'rejected');
  const two = id([{ name: 'a.bin', bytes: fake(8 * K, 51) }, { name: 'b.bin', bytes: fake(8 * K, 52) }], 'cc');
  check('two unknown same-size files fill both free sockets', targets(two[0]) === 'cc/bas' && targets(two[1]) === 'cc/extbas');
  const three = id([{ name: 'a.bin', bytes: fake(8 * K, 51) }, { name: 'b.bin', bytes: fake(8 * K, 52) }, { name: 'c.bin', bytes: fake(8 * K, 53) }], 'cc');
  check('a third same-size file has no free socket and is rejected', three[2].result === 'rejected', three[2].message);
}
{
  const [r] = id([{ name: 'odd.bin', bytes: fake(4096, 7) }], 'cc');
  check('a ROM-sized file that fits nowhere is rejected, naming the expected sizes', r.result === 'rejected' && /8K/.test(r.message) && /16K/.test(r.message) && /32K/.test(r.message), r.message);
  const [i] = id([{ name: 'readme.txt', bytes: fake(5000, 7) }], 'cc');
  check('a file that cannot be a ROM image is ignored', i.result === 'ignored', i.message);
  const [e] = id([{ name: 'empty.rom', bytes: new Uint8Array(0) }]);
  check('an empty file is rejected', e.result === 'rejected' && /empty/.test(e.message));
  const d = id([{ name: 'one.rom', bytes: A1 }, { name: 'two.rom', bytes: A1.slice() }]);
  check('a duplicate in the same drop is skipped, naming the first', d[0].result === 'verified' && d[1].result === 'rejected' && /one\.rom/.test(d[1].message));
}
{
  const r = id([{ name: 'tbas.rom', bytes: fake(8 * K, 60) }, { name: 'real.bin', bytes: B }], 'cc');
  check('a verified dump wins over an unrecognised one for the same socket', r[1].result === 'verified' && r[0].result === 'rejected', r[0].message);
}
{
  check('looksLikeRom: by contents or usual name, not by size', looksLikeRom('x.bin', A1, P) && looksLikeRom('TBAS.ROM', fake(8 * K, 9), P) && !looksLikeRom('game.rom', fake(8 * K, 9), P));
}

{
  const [r] = id([{ name: 'T3ALT.ROM', bytes: fake(32 * K, 97) }]);
  check('an alias name with the right size loads unrecognised', r.result === 'loaded-unrecognised' && targets(r) === 'c3/basic');
  const [w] = id([{ name: 't3alt.rom', bytes: fake(8 * K, 96) }]);
  check('an alias name with the wrong size is rejected', w.result === 'rejected' && /instead of 32K/.test(w.message));
  const [d] = id([{ name: 'tdos2.rom', bytes: fake(8 * K, 95) }]);
  check('a disk-controller ROM (by alias) is stored for its cartridge', d.result === 'loaded-unrecognised' && targets(d) === 'dos/rom');
  check('a cartridge ROM never makes a machine bootable', !isBootable(P.dos, { rom: fake(8 * K, 95) }));
  const [x] = id([{ name: 'x.bin', bytes: fake(4096, 94) }], 'cc');
  check('the expected sizes named in a rejection are machine sockets only', !/\b8K, 8K/.test(x.message) && /4K doesn't match/.test(x.message), x.message);
}

// ---- socket status ----
{
  const s = socketStatus(P.cc, { bas: B });
  check('status: verified and missing-optional', s[0].status === 'verified' && s[1].status === 'missing-optional' && isBootable(P.cc, { bas: B }));
  const u = socketStatus(P.cc, { extbas: fake(8 * K, 70) });
  check('status: missing-required and loaded-unrecognised; not bootable', u[0].status === 'missing-required' && u[1].status === 'loaded-unrecognised' && !isBootable(P.cc, { extbas: C }));
}

// ---- library: stored once, per machine, garbage collected ----
{
  const store = new Emu.MemoryMediaStore();
  const lib = new RomLibrary(new Emu.MediaIndex(store), P);
  lib.put('d64', 'basic64', A2); lib.put('d200', 'basic64', A2);
  check('library stores a shared image once', store.listSync('roms/').filter((k) => /^roms\/[0-9A-F]+\.rom$/.test(k.name)).length === 1 && lib.get('d200').basic64.length === 16 * K);
  lib.clear('d64');
  check('clearing one machine keeps an image another machine uses', !!lib.get('d200').basic64 && !lib.get('d64').basic64);
  lib.clear('d200');
  check('the image is dropped when no machine uses it', store.listSync('roms/').filter((f) => /\.rom$/.test(f.name)).length === 0, store.listSync().map((f) => f.name).join(','));
}

// ---- Session: one drop sets up several machines, persists, and the machine in use restarts ----
{
  // test profiles on real families, with fake known-good CRCs
  const D64_1 = fake(16 * K, 11), D64_2 = fake(16 * K, 12), BAS = fake(8 * K, 13), EXT = fake(8 * K, 14);
  const base = Emu.profiles;
  const mk = (from, id, roms) => Object.assign({}, base[from], { id, name: `Test ${id}`, roms });
  base.t64 = mk('dragon64', 't64', [slot('basic', '32K-mode BASIC', 16 * K, 0x8000, ['t64_1.rom'], [crc(D64_1)], { required: true }), slot('basic64', '64K-mode BASIC', 16 * K, 0x8000, ['t64_2.rom'], [crc(D64_2)], { bank: 1 })]);
  base.ttano = mk('tanodr64', 'ttano', base.t64.roms);
  base.tcoco = mk('coco', 'tcoco', [slot('bas', 'Color BASIC', 8 * K, 0xA000, ['tbas.rom'], [crc(BAS)], { required: true }), slot('extbas', 'Extended Color BASIC', 8 * K, 0x8000, ['textbas.rom'], [crc(EXT)])]);
  try {
    const store = Emu.memoryStore();
    const media = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store, media });
    s.switchMachine('tcoco');
    const res = s.addRoms([{ name: 'a', bytes: D64_1 }, { name: 'b', bytes: D64_2 }, { name: 'c', bytes: BAS }, { name: 'junk.txt', bytes: fake(100, 1) }, { name: 'dd.rom', bytes: fake(8 * K, 77) }]);
    check('one drop sets up every machine it fits', ['t64', 'ttano', 'tcoco'].every((m) => res.bootable.includes(m)), res.bootable.join(','));
    check('per-file results: verified, ignored, and a file that fits nowhere rejected', res.files[0].result === 'verified' && res.files[3].result === 'ignored' && res.files[4].result === 'rejected', res.files.map((f) => f.result).join());
    check('ROMs for other machines come back as offers to switch, not errors', res.offers.map((o) => o.machine).sort().join() === 't64,ttano' && res.offers[0].files.join() === 'a,b', JSON.stringify(res.offers));
    const dos = s.addRoms([{ name: 'DDOS11C.ROM', bytes: fake(8 * K, 78) }]);
    check('a DragonDOS ROM is stored for the disk cartridge', dos.cartridges.length === 1 && dos.cartridges[0].id === 'dragondos' && dos.cartridges[0].sockets[0].status === 'loaded-unrecognised' && !dos.offers.length, JSON.stringify(dos.cartridges));
    check('the machine in use got its ROM and was power cycled', s.shownMachine.hasRom && s.shownMachine.framesSinceReset === 0);
    const st = s.machineRoms().sockets.map((x) => x.status).join(',');
    check('socket status of the machine in use', st === 'verified,missing-optional', st);
    const again = new Emu.Session({ store, media });
    again.switchMachine('ttano');
    check('ROMs persist through the store and load on switch', again.shownMachine.hasRom && again.machineRoms().sockets.every((x) => x.status === 'verified'));
    again.runWithoutRoms();
    check('run without ROMs uses the stub and keeps the stored ROMs', !again.shownMachine.hasRom && again.machineRoms('t64').bootable);
    again.switchMachine('t64'); again.switchMachine('ttano');
    check('the choice holds for this session', !again.shownMachine.hasRom);
    again.addRoms([{ name: 'b', bytes: D64_2 }]);
    check('dropping ROMs for that machine ends the stub choice', again.shownMachine.hasRom);
    again.clearRoms();
    check('clearRoms forgets only the machine in use', !again.shownMachine.hasRom && again.machineRoms('t64').bootable);
    check('machinesWithRoms lists set-up machines', again.machinesWithRoms().map((x) => x.id).sort().join(',') === 't64,tcoco');
  } finally { delete base.t64; delete base.ttano; delete base.tcoco; }
}

// ---- boot watchdog: reads the screen through the Session ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon32');
  check('watchdog: the stub is not a boot failure', s.bootStatus().state === 'stub');
  // a deliberately wrong ROM: 16K of RTS ($39) loaded by size; the CPU runs, nothing prints OK
  s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
  check('watchdog: booting right after power-on', s.shownMachine.hasRom && s.bootStatus(5).state === 'booting');
  for (let i = 0; i < 5 * 50 + 2; i++) s.shownMachine.runFrame();
  const st = s.bootStatus(5);
  check('watchdog: no OK within 5 s -> failed, cause from the socket status', st.state === 'failed' && /Dragon 32 BASIC is wrong\.bin, which isn't recognised/.test(st.cause), st.cause);
  // BASIC's OK on a line of its own (VDG codes: O=$0F, K=$0B), on the page BASIC shows: the SAM's display offset at
  // $0400 (F1, $FFC9), which BASIC sets and this RTS-filled ROM does not
  s.shownMachine.write(0xFFC9, 0);
  s.shownMachine.ram[0x400 + 32 * 3] = 0x0F; s.shownMachine.ram[0x400 + 32 * 3 + 1] = 0x0B;
  for (let c = 2; c < 32; c++) s.shownMachine.ram[0x400 + 32 * 3 + c] = 0x60;
  check('watchdog: OK on the screen -> ok', s.bootStatus(5).state === 'ok' && s.screenText()[3].trim() === 'OK');
  s.shownMachine.ram.fill(0x60, 0x400, 0x600);
  check('watchdog: stays ok after the screen is cleared', s.bootStatus(5).state === 'ok');
  s.powerCycle();
  check('watchdog: a power cycle starts over', s.bootStatus(5).state === 'booting');
  check('screenText: MC-10 reads its own text screen', (() => { s.switchMachine('mc10'); s.shownMachine.runFrame(); s.shownMachine.runFrame(); return s.screenText().join('\n').includes('BUILT-IN STUB'); })());
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
