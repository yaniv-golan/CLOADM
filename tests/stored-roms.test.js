// Session.storedRoms(): what the Library's ROMs card says: how many ROM images are stored (one image
// in the sockets of several models counts once) and the names of the machines and cartridges that use them, in profile
// order. Synthetic ROM images only (the project never uses real ones); the expected values are written out here.
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const img = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 0xff; return b; };
const json = (x) => JSON.stringify(x);

const s = new Emu.Session({ media: new MemoryMediaStore() });
s.switchMachine('dragon64');
check('none stored: count 0, no users', json(s.storedRoms()) === json({ count: 0, users: [] }), json(s.storedRoms()));
const d64 = img(16384, 1);
s.roms.put('dragon64', 'basic', d64, 'd64_1.rom');
s.roms.put('tanodr64', 'basic', d64, 'd64_1.rom');          // the same image in another model's socket
check('one image in two models: counted once, both named', json(s.storedRoms()) === json({ count: 1, users: ['Dragon 64', 'Tano Dragon 64'] }), json(s.storedRoms()));
s.roms.put('dragon32', 'basic', img(16384, 2), 'd32.rom');
s.roms.put('dragondos', 'rom', img(8192, 3), 'ddos10.rom');
check('a second machine and a disk cartridge: three images, in profile order (cartridges after the machines)',
  json(s.storedRoms()) === json({ count: 3, users: ['Dragon 32', 'Dragon 64', 'Tano Dragon 64', 'DragonDOS cartridge'] }), json(s.storedRoms()));
s.roms.clear('dragon64'); s.roms.clear('tanodr64');
check('a machine\'s ROMs removed: its image goes from the count', json(s.storedRoms()) === json({ count: 2, users: ['Dragon 32', 'DragonDOS cartridge'] }), json(s.storedRoms()));

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
