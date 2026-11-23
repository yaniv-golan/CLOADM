// A disk without a disk ROM: the disk controller goes in alone (DiskDrives.mount), on the Dragon 64 (the Dragon
// controller, a VDK) and the CoCo (the CoCo controller, a JVC .dsk). No ROM at all: the machine runs the built-in
// firmware, and the program is tools/mame-diff/fdc/gen-bare.js's RAM build, which drives the controller through its
// registers (restore, read track 0 sector 1 by polling DRQ) as a game reading its own level disk does. The same read
// routine, as a ROM, is the --bare lockstep comparison with MAME (tools/mame-diff/run.js <profile> --fdc --bare).
//  - the mount's exact message (the page's toast and the command line's note), the board's state (no ROM, its
//    cartridge space reads 00, no CART line tied to Q) and the board menu's name for it;
//  - the program loaded first keeps running when the disk goes in (no reset: its count goes on, its code is intact),
//    its first read (no controller yet) fails and its next one reads the sector, byte for byte as the image holds it
//    (the expected bytes come from the images' formula, not from the code under test);
//  - a disk ROM added afterwards goes in at the next power cycle (the same board: into its socket; the Delta DOS
//    ROM on a Dragon: its own board, the disk moved across), and not before;
//  - a snapshot taken in the middle of a read restores into a fresh machine and runs on identically (trace and frames);
//  - the board comes out with the program still running; the MC-10 still has no drives; a Multi-Pak without a
//    controller still refuses; the link's disk= goes before load=; the command box finds "Insert a disk…" by "mount";
//  - the command line: --disk without a ROM prints the note to stderr, the JSON has it as an added field, and the
//    program reads the disk.
// Run: node tests/disk-bare.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();
const gen = require('../tools/mame-diff/fdc/gen-bare.js');
const images = require('../tools/mame-diff/fdc/images.js');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-bare-'));
const { ADDR } = gen;
const NOTE = 'on the disk controller only (no disk ROM). Programs that read the disk directly can use it; DIR and other disk commands need your disk ROM.';
// track 0, side 0, sector 1 as images.js builds every sector: (t * 7 + h * 3 + s * 11 + i * 5 + (i >> 4)) & 0xff
const T0S1 = Array.from({ length: 256 }, (_, i) => (11 + i * 5 + (i >> 4)) & 0xff);
const program = (board) => { const r = Emu.assemble(gen.source(board, 'ram'), '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return Emu.toBinary(r, { format: 'dragondos' }); };
const word = (m, a) => (m.ram[a] << 8) | m.ram[a + 1];
const frames = (s, n) => { for (let i = 0; i < n; i++) s.shownMachine.runFrame(); };
const topLine = (s) => s.screenText()[0];

const CASES = [
  { id: 'dragon64', board: 'dragon', file: 'level.vdk', image: () => images.vdk(40, 1), controller: 'dragonfdc', plain: 'Dragon disk controller', dos: 'dragondos', rom: 'ddos10.rom' },
  { id: 'coco', board: 'coco', file: 'level.dsk', image: () => images.jvc(35, 1), controller: 'cocofdc', plain: 'CoCo disk controller', dos: 'rsdos', rom: 'disk11.rom' },
];

(async () => {
  check('the expected sector is the image\'s: track 0 sector 1 of the VDK (after its 12-byte header) and of the JVC',
    T0S1.every((v, i) => images.vdk(40, 1)[12 + i] === v && images.jvc(35, 1)[i] === v));

  for (const c of CASES) {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine(c.id, undefined, { menu: false });
    const m = s.shownMachine;
    check(`${c.id}: no ROMs, no disk ROM stored, no controller`, m.useStub && !s.drives.dosChoices().some((x) => x.ready) && s.drives.controller === null && s.drives.status().dos === null);
    // the game first
    s.load('reader.bin', program(c.board));
    frames(s, 20);
    check(`${c.id}: the program runs, and its first read (no controller yet) reads nothing`, m.ram[ADDR.DONE] === 1 && word(m, ADDR.CNT) === 0 && word(m, ADDR.TICK) > 0);
    check(`${c.id}: its screen says so`, /^NO DISK/.test(topLine(s) || ''), topLine(s));
    const code = m.ram.slice(0x3000, 0x3100), frame0 = m.frameCount, tick0 = word(m, ADDR.TICK);
    // then the disk, with no disk ROM
    let events = 0;
    s.on((e) => { if (e === 'disks') events++; });
    const msg = await s.drives.importImage(c.file, c.image(), 0).catch((e) => `refused: ${e.message}`);
    check(`${c.id}: the mount's message is the toast's, word for word`, msg === `${c.file} is in drive 0, ${NOTE}`, msg);
    check(`${c.id}: Session.BARE_NOTE is that note`, Emu.BARE_NOTE === NOTE);
    const fdc = s.drives.controller;
    check(`${c.id}: the ${c.controller} is in the cartridge port with no ROM`, !!fdc && m.cartPort === fdc && fdc.type === c.controller && fdc.romBytes === null && fdc.rom() === null && s.drives.bareController === fdc);
    check(`${c.id}: diskStatus says bare, with the board's own name`, s.drives.status().dos.bare === true && s.drives.status().dos.name === c.plain && s.drives.status().drives[0].file === c.file, JSON.stringify(s.drives.status().dos));
    check(`${c.id}: the cartridge space reads 00`, [0xC000, 0xD000, 0xFEFF].every((a) => s.readByte(a) === 0x00));
    check(`${c.id}: the board ties no CART line to Q and raises none`, !fdc.cartLineFollowsQ && fdc.lines.value('cart') !== 'q' && !fdc.lines.level('cart') && !m.interrupts.asserted('firq'),
      `${fdc.lines.value('cart')} ${fdc.lines.level('cart')}`);
    check(`${c.id}: a 'disks' event for the board and the mount`, events >= 1);
    check(`${c.id}: no disk ROM is waiting for a reset`, !s.drives.romWaiting);
    // the game was not reset: it runs on, and its next read succeeds
    frames(s, 5);
    check(`${c.id}: the program keeps running through the mount (no reset: frames and its count go on, its code intact)`,
      m.frameCount === frame0 + 5 && word(m, ADDR.TICK) > tick0 && m.ram.slice(0x3000, 0x3100).every((v, i) => v === code[i]) && m.ram[ADDR.DONE] === 1);
    check(`${c.id}: running, the board still raises no CART line`, fdc.lines.value('cart') !== 'q' && !fdc.lines.level('cart') && !m.interrupts.asserted('firq'), `${fdc.lines.value('cart')} ${fdc.lines.level('cart')}`);
    m.ram[ADDR.TRIG] = 1;
    frames(s, 40);
    const buf = Array.from(m.ram.slice(ADDR.BUF, ADDR.BUF + 256));
    check(`${c.id}: its next read finds the disk: status 00, 256 bytes`, m.ram[ADDR.DONE] === 2 && m.ram[ADDR.STAT] === 0 && word(m, ADDR.CNT) === 256,
      `done ${m.ram[ADDR.DONE]} status ${m.ram[ADDR.STAT].toString(16)} count ${word(m, ADDR.CNT)}`);
    check(`${c.id}: the bytes read are track 0 sector 1 of the image`, buf.every((v, i) => v === T0S1[i]));
    const hex = T0S1.slice(0, 4).map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    check(`${c.id}: its screen says READ OK and the first bytes`, (topLine(s) || '').startsWith(`READ OK ${hex}`), topLine(s));

    // ---- a snapshot in the middle of a read: restored into a fresh machine, it runs on identically
    m.ram[ADDR.TRIG] = 1;
    let mid = false;
    // (the frame left open where it stops, as the debugger leaves it: both machines then finish it)
    const inRead = () => !!(fdc.wd.status & 1) && m.cpu.x > ADDR.BUF + 16 && m.cpu.x < ADDR.BUF + 240;
    for (let f = 0; f < 200 && !mid; f++) {
      m.runFrame((end) => { while (m.cycle < end) { m.runCycles(end, 1); if (inRead()) { mid = true; return false; } } return true; });
    }
    check(`${c.id}: stopped in the middle of the sector transfer`, mid, `x ${m.cpu.x.toString(16)} status ${fdc.wd.status.toString(16)}`);
    const text = Emu.state.toJSON(m.snapshot());
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), m.roms);
    const run = (mm) => { const out = []; for (let i = 0; i < 30; i++) { mm.runFrame(); out.push(mm.cpu.pc, mm.cpu.x, mm.cycles, Emu.state.toJSON(mm.snapshotPicture ? Array.from(mm.snapshotPicture().data.slice(0, 64)) : [])); } return out.join(','); };
    const bFdc = b.cartPort;
    check(`${c.id}: the restored machine has the board with no ROM and the disk`, bFdc && bFdc.type === c.controller && bFdc.romBytes === null && bFdc.drives[0].loaded);
    const continued = run(m), restored = run(b);
    check(`${c.id}: the restored machine runs on identically (registers, cycles, frames)`, continued === restored);
    check(`${c.id}: and finishes the read: the sector in memory, status 00`, b.ram[ADDR.STAT] === 0 && Array.from(b.ram.slice(ADDR.BUF, ADDR.BUF + 256)).every((v, i) => v === T0S1[i]) && b.ram[ADDR.DONE] === 3);

    // ---- a disk ROM added afterwards goes in at the next power cycle, not before (our own bytes: 8K of RTS)
    const dosRom = new Uint8Array(0x2000).fill(0x39);
    s.roms.put(c.dos, 'rom', dosRom, c.rom);
    s.emit('roms');
    check(`${c.id}: a disk ROM added is waiting for the next reset or power cycle`, s.drives.romWaiting && s.drives.controller === fdc && fdc.romBytes === null && s.readByte(0xC000) === 0x00);
    s.powerCycle({ menu: false });
    check(`${c.id}: the power cycle puts it in the board's socket: the same board, the disk still in drive 0`,
      s.drives.controller === fdc && !!fdc.romBytes && s.readByte(0xC000) === 0x39 && fdc.drives[0].loaded && s.drives.status().drives[0].file === c.file);
    check(`${c.id}: and the drives card now names the disk ROM`, s.drives.status().dos.bare === false && s.drives.status().dos.id === c.dos && !s.drives.romWaiting && s.drives.bareController === null);
    const msg2 = await s.drives.mount(1, c.file === 'level.vdk' ? 'level.vdk' : 'level.dsk').catch((e) => e.message);
    check(`${c.id}: a mount with the disk ROM in says no more than where the disk is`, /already in drive 0/.test(msg2), msg2);
  }

  // ---- the Delta DOS ROM on a Dragon whose controller went in bare: its own board replaces it, with the disk
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon64', undefined, { menu: false });
    await s.drives.importImage('level.vdk', images.vdk(40, 1), 0);
    const bare = s.drives.controller;
    s.roms.put('deltados', 'rom', new Uint8Array(0x2000).fill(0x12), 'deltados.rom');
    check('Delta DOS added: waiting for the next reset', s.drives.romWaiting && s.drives.controller === bare);
    s.reset();
    const fdc = s.drives.controller;
    check('a reset puts the Premier board in its place, with the disk moved across', fdc !== bare && fdc.type === 'premierfdc' && !!fdc.romBytes && fdc.drives[0].loaded
      && s.drives.status().drives[0].file === 'level.vdk' && s.drives.status().dos.id === 'deltados' && s.readByte(0xC000) === 0x12);
  }

  // ---- the board comes out with the program running on; no drives on the MC-10; a Multi-Pak still needs a controller
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('dragon64', undefined, { menu: false });
    s.load('reader.bin', program('dragon'));
    frames(s, 5);
    await s.drives.importImage('level.vdk', images.vdk(40, 1), 0);
    const f0 = s.shownMachine.frameCount, t0 = word(s.shownMachine, ADDR.TICK);
    const said = s.takeOutCartridge();
    frames(s, 5);
    check('takeOutCartridge: the board with no ROM comes out and the program runs on', said === 'Dragon disk controller taken out' && s.shownMachine.cartPort === null
      && s.drives.status().drives.length === 0 && s.shownMachine.frameCount === f0 + 5 && word(s.shownMachine, ADDR.TICK) > t0, said);
    check('the disk stays in the Library', (await s.drives.list()).some((d) => d.name === 'disks/level.vdk'));
    let err = null;
    try { s.takeOutCartridge(); } catch (e) { err = e.message; }
    check('an empty port says so', err === 'The cartridge port is empty.', err);
    s.switchMachine('mc10', undefined, { menu: false });
    err = null;
    try { await s.drives.importImage('x.vdk', images.vdk(40, 1), 0); } catch (e) { err = e.message; }
    check('the MC-10 has no disk drives', /no disk drives/.test(err || ''), err);
    s.switchMachine('coco', undefined, { menu: false });
    s.shownMachine.insertCartridge(new Emu.devices.multi([null, null, null, null]));
    err = null;
    try { await s.drives.importImage('y.dsk', images.jvc(35, 1), 0); } catch (e) { err = e.message; }
    check('a Multi-Pak with no controller in a slot still refuses', /Multi-Pak has no disk controller/.test(err || ''), err);
    s.switchMachine('dgnalpha', undefined, { menu: false });
    check('the Dragon Alpha keeps its built-in interface', s.drives.status().dos.id === 'builtin' && !s.drives.status().dos.bare);
  }

  // ---- a disk inserted while a cartridge game runs from the port: the board replaces it, and the machine powers up
  {
    const s = new Emu.Session({ media: new MemoryMediaStore() });
    s.switchMachine('coco', undefined, { menu: false });
    s.shownMachine.insertCartridge(new Emu.devices.rom(new Uint8Array(0x2000).fill(0x12)));
    let fw = 0;
    s.on((e) => { if (e === 'firmware') fw++; });
    await s.drives.importImage('z.dsk', images.jvc(35, 1), 0);
    check('a cartridge in the port comes out for the board, and the machine is powered up', s.drives.bareController === s.shownMachine.cartPort && fw === 1);
  }

  // ---- the link: disk= mounts before load= (whatever order the link gives them); unknown parameters as before
  {
    const cfg = Emu.parseUrlConfig('?load=https://x.test/game.bin&disk=https://x.test/level.vdk');
    check('?load=…&disk=…: the disk first, then the game', cfg.media.map((x) => x.kind).join() === 'disk,load' && !cfg.errors.length, JSON.stringify(cfg));
    const again = Emu.parseUrlConfig(new URL(Emu.buildUrl('https://cloadm.dev/play', cfg)).search);
    check('the link written back reads the same', JSON.stringify(again.media) === JSON.stringify(cfg.media));
    check('disk= without a link is refused, as the other media', Emu.parseUrlConfig('?disk=').errors.some((e) => /^disk=: not a link to a file/.test(e)));
    check('an unknown parameter keeps its error', Emu.parseUrlConfig('?disks=x').errors.some((e) => /^disks: not a CLOADM setting/.test(e)));
  }

  // ---- the command box: "Insert a disk…", "New blank disk", "Eject disk"
  {
    const { COMMANDS, rankCommands } = await import('../js/ui/command-box.js').catch(() => ({}));
    const words = (q) => (rankCommands ? rankCommands(COMMANDS, q) : []).map((r) => r.c[0]);
    check('Ctrl+K: "mount" finds "Insert a disk…"', words('mount').includes('Insert a disk…'), JSON.stringify(words('mount')));
    check('Ctrl+K: "disk", "drive", "vdk" and "dsk" find it too', ['disk', 'drive', 'vdk', 'dsk'].every((w) => words(w).includes('Insert a disk…')));
    check('Ctrl+K: "New blank disk" and "Eject disk" are there', words('blank').includes('New blank disk') && words('eject').includes('Eject disk'));
    const eject = (COMMANDS || []).find((c) => c[0] === 'Eject disk');
    check('Ctrl+K: "Eject disk" is listed only while a disk is in, as the tape\'s Eject', !!eject && typeof eject[5] === 'function'
      && eject[5]({ session: { drives: { status: () => ({ drives: [] }) } } }) === false && eject[5]({ session: { drives: { status: () => ({ drives: [{ drive: 0 }] }) } } }) === true);
  }

  // ---- the command line: --disk with no disk ROM
  {
    const bin = path.join(TMP, 'reader.bin'), disk = path.join(TMP, 'level.vdk');
    fs.writeFileSync(bin, program('dragon'));
    fs.writeFileSync(disk, images.vdk(40, 1));
    const args = ['-m', 'dragon64', '--load', bin, '--frames', '10', '--disk', disk, '--poke', `0x${ADDR.TRIG.toString(16)}=1`, '--frames', '40'];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), ...args, '--screen'], { cwd: ROOT, encoding: 'utf8' });
    check('cli: --disk without a disk ROM succeeds and prints the note to stderr', r.status === 0 && r.stderr.trim() === `cloadm: level.vdk is in drive 0, ${NOTE}`, `${r.status} ${r.stderr}`);
    check('cli: the program reads the disk (its screen)', r.stdout.startsWith(`READ OK ${T0S1.slice(0, 4).map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`), r.stdout.split('\n')[0]);
    const j = spawnSync(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), ...args, '--peek', `0x${ADDR.STAT.toString(16)}`, '--json'], { cwd: ROOT, encoding: 'utf8' });
    let o = null; try { o = JSON.parse(j.stdout); } catch (e) { o = null; }
    const step = o && o.steps.find((x) => x.step === 'disk'), peek = o && o.steps.find((x) => x.step === 'peek');
    check('cli --json: the disk step carries the note as an added field, and nothing on stderr', !!step && step.note === `level.vdk is in drive 0, ${NOTE}` && step.message === step.note && j.stderr === '', j.stderr);
    check('cli --json: the read status is 00', !!peek && peek.bytes[0] === 0);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL the suite stopped: ${e.stack || e}`); console.log('1 FAILED'); process.exitCode = 1; });
