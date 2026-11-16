// ROM pack: the user's stored ROMs as one ZIP file, restored exactly (sockets filled by name or size
// included) into a fresh browser store; corrupt packs; and that ROMs never appear in settings export,
// share links or URL configuration. Synthetic images only.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const K = 1024;

// a set of stored ROMs: Dragon 64 by name, a CoCo socket by size only, a DragonDOS ROM for the cartridge
const D1 = fake(16 * K, 1), D2 = fake(16 * K, 2), BAS = fake(8 * K, 3), DOS = fake(8 * K, 4);
const a = new Emu.Session({ store: Emu.memoryStore() });
a.switchMachine('coco');
a.addRoms([{ name: 'd64_1.rom', bytes: D1 }, { name: 'd64_2.rom', bytes: D2 }, { name: 'mydump.bin', bytes: BAS }, { name: 'ddos10.rom', bytes: DOS }]);
check('setup: ROMs stored by name, by size and for the cartridge', a.machineRoms('dragon64').bootable && a.machineRoms('coco').bootable && !!a.roms.get('dragondos').rom);

const pack = a.exportRomPack();
check('the pack is one ZIP file', pack.name === 'cloadm-roms.zip' && Emu.isZip(pack.bytes));
const entries = Emu.readZip(pack.bytes);
check('each image is stored once (Dragon 64 and Tano share their chips)', entries.filter((e) => e.name.startsWith('roms/')).length === 4, entries.map((e) => e.name).join(' '));
check('it is recognised as a ROM pack', Emu.Session.isRomPack(entries) && !Emu.Session.isRomPack([{ name: 'bas13.rom', data: BAS }]));

// restore into a fresh store: every socket comes back, including the one filled by size only
const b = new Emu.Session({ store: Emu.memoryStore() });
b.switchMachine('coco');
const res = b.importRomPack(Emu.readZip(pack.bytes));
const sameSockets = ['dragon64', 'tanodr64', 'coco', 'dragondos'].every((id) => {
  const x = a.roms.get(id), y = b.roms.get(id);
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((k) => same(x[k], y[k]));
});
check('round trip: every socket of every machine and cartridge restored byte for byte', sameSockets && !res.skipped.length, res.skipped.join('; '));
check('round trip: the machine in use got its ROMs and was power cycled', b.machine.hasRom && same(b.machine.roms.bas, BAS) && b.machine.framesSinceReset === 0);
check('round trip: export of the restored store is identical', same(b.exportRomPack().bytes, pack.bytes));

// damaged packs
{
  const bad = Emu.readZip(pack.bytes).map((e) => (e.name.startsWith('roms/') && same(e.data, BAS) ? { name: e.name, data: e.data.slice(0, 100) } : e));
  const c = new Emu.Session({ store: Emu.memoryStore() }); c.switchMachine('coco');
  const r = c.importRomPack(bad);
  check('a corrupt image is skipped and reported, the rest restored', r.skipped.length === 1 && /Color BASIC/.test(r.skipped[0]) && c.machineRoms('dragon64').bootable && !c.machineRoms('coco').bootable, r.skipped.join('; '));
  const man = { name: 'cloadm-rompack.json', data: new TextEncoder().encode('{"format":"other"}') };
  let threw = false; try { c.importRomPack([man]); } catch (e) { threw = /unknown format/.test(e.message); }
  check('an unknown pack format is refused', threw);
  const odd = { name: 'cloadm-rompack.json', data: new TextEncoder().encode(JSON.stringify({ format: 'cloadm-rompack', version: 1, sockets: [{ machine: 'nosuch', socket: 'x', crc: '00000000' }] })) };
  check('sockets this version does not have are skipped', /not a ROM this version of CLOADM takes/.test(c.importRomPack([odd]).skipped[0]));
}

// ROMs never leave through settings export, share links or URL configuration
{
  const crcs = a.roms.sockets().map((s) => s.crc);
  const b64 = Buffer.from(BAS).toString('base64').slice(0, 40);
  const settings = JSON.stringify(a.exportSettings());
  check('settings export holds settings', /"machine":"coco"/.test(settings));
  check('settings export holds no ROM keys, CRCs or data', !/rom\.|romdata/.test(settings) && !crcs.some((c) => settings.includes(c)) && !settings.includes(b64), settings.slice(0, 200));
  for (const id of ['coco', 'dragon64', 'coco3']) {
    a.switchMachine(id);
    const url = a.shareUrl('https://cloadm.dev/');
    const params = [...new URL(url).searchParams.keys()];
    check(`share link for ${id} carries only the machine and its options`, params.every((k) => k === 'machine' || a.machine.profile.options[k]) && !crcs.some((c) => url.includes(c)) && !/rom/i.test(url.replace(/machine=[^&]*/, '')), url);
  }
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
