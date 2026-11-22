// Media detection: which machine family a file is for, and the switch offer when it doesn't match the
// machine in use. Disk images in tests/fixtures/disks were made by MAME's imgtool (independent of this
// code): `imgtool create coco_jvc_rsdos|coco_jvc_dgndos|coco_vdk_dgndos`, some with a BASIC file put on.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const fixture = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/disks', f)));

// ---- disks: MAME-made images ----
for (const [file, family, format] of [['rsdos.dsk', 'coco', 'RS-DOS disk'], ['rsdos-empty.dsk', 'coco', 'RS-DOS disk'],
  ['dragondos.dsk', 'dragon', 'DragonDOS disk'], ['dragondos-empty.dsk', 'dragon', 'DragonDOS disk'], ['dragondos.vdk', 'dragon', 'VDK disk']]) {
  const d = Emu.detectMedia(file, fixture(file));
  check(`disk ${file}: ${format}, ${family}`, d.kind === 'disk' && d.family === family && d.format === format, JSON.stringify(d));
}
{
  // a JVC header (one byte here: sectors per track) shifts the image; detection still finds the layout
  const img = fixture('rsdos.dsk'), jvc = new Uint8Array(img.length + 1); jvc[0] = 18; jvc.set(img, 1);
  check('disk with a JVC header', Emu.detectMedia('game.dsk', jvc).family === 'coco');
  check('a blank (all-zero) disk image has no recognisable layout', Emu.detectMedia('blank.dsk', new Uint8Array(161280)).family === null);
  const bad = fixture('rsdos.dsk'); bad[(17 * 18 + 2) * 256 + 13] = 0x99;   // first granule of the directory entry out of range
  check('a corrupt RS-DOS directory is not taken for RS-DOS', Emu.detectMedia('bad.dsk', bad).family !== 'coco');
}

// ---- binaries, tapes and cartridges ----
{
  const prog = Emu.assemble(' ORG $3000\nL BRA L\n END', '6809');
  const dragon = Emu.toBinary(prog);                        // contiguous: DragonDOS header
  const decb = Uint8Array.from([0, 0, 2, 0x30, 0x00, 0x20, 0xFE, 0xFF, 0, 0, 0x30, 0x00]);
  check('DragonDOS binary -> Dragon', Emu.detectMedia('a.bin', dragon).family === 'dragon');
  check('DECB binary -> CoCo', Emu.detectMedia('a.bin', decb).family === 'coco');
  check('.c10 / .k7 tape -> MC-10', Emu.detectMedia('game.c10', new Uint8Array(300).fill(0x55)).family === 'mc10' && Emu.detectMedia('jeu.k7', new Uint8Array(300).fill(0x55)).family === 'mc10');
  check('.cas tape -> either Dragon or CoCo (no family)', Emu.detectMedia('game.cas', new Uint8Array(300).fill(0x55)).family === null);
  check('.dgn / .ccc cartridges', Emu.detectMedia('x.dgn', new Uint8Array(8192)).family === 'dragon' && Emu.detectMedia('x.ccc', new Uint8Array(8192)).family === 'coco');
}

// ---- the switch offer ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const r = s.inspect('games.dsk', fixture('rsdos.dsk'));
  check('RS-DOS disk on a Dragon: offer the CoCo', r.mismatch && r.mismatch.familyName === 'CoCo' && r.mismatch.suggest === 'coco', JSON.stringify(r.mismatch));
  check('DragonDOS disk on a Dragon: no offer', s.inspect('d.vdk', fixture('dragondos.vdk')).mismatch === null);
  // a model with ROMs is preferred: give the CoCo 2B a (synthetic) BASIC
  s.addRoms([{ name: 'bas14.rom', bytes: new Uint8Array(8192).fill(7) }]);   // a CoCo 2B alias only
  check('the offer prefers a machine of that family that has ROMs', s.inspect('games.dsk', fixture('rsdos.dsk')).mismatch.suggest === 'coco2b');
  s.switchMachine('mc10');
  check('a cartridge on the MC-10 (no cartridge port): offer a CoCo', s.inspect('game.rom', new Uint8Array(8192)).mismatch?.family === 'coco');
  check('a .c10 tape on the MC-10: no offer', s.inspect('t.c10', new Uint8Array(300).fill(0x55)).mismatch === null);
  s.switchMachine('coco');
  check('an MC-10 tape on a CoCo: offer the MC-10', s.inspect('t.c10', new Uint8Array(300).fill(0x55)).mismatch?.suggest === 'mc10');
  let msg = ''; try { s.load('games.dsk', fixture('rsdos.dsk')); } catch (e) { msg = e.message; }
  check('loading a disk as a program says what it is and that it goes in a disk drive', /RS-DOS disk for a CoCo.*go in a disk drive/.test(msg), msg);
}

// ---- start commands and pasted text ----
{
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  s.typeText('hello\r\nok');
  check('pasted text on the stub becomes key codes (upper case, CR)', s.shownMachine.stubKeys.join() === [72, 69, 76, 76, 79, 13, 79, 75].join());
  s.shownMachine.setRoms({ basic: new Uint8Array(16384).fill(0x39) }); s.shownMachine.reset(true);
  s.typeText('PRINT 1\n');
  check('pasted text with ROMs goes through the keyboard', s.shownMachine.typist.busy && s.shownMachine.typist.queue.join('') === 'PRINT 1\r');
}

// One rule for what a disk image is: detectMedia (what the page says about a file) reports the
// format detectDiskFormat (what the drive mounts) finds, whatever the file is called.
{
  const vdk = fixture('dragondos.vdk'), jvc = fixture('rsdos.dsk');
  const hdr = new Uint8Array(jvc.length + 1); hdr[0] = 18; hdr.set(jvc, 1);
  for (const [name, bytes, want] of [['game.vdk', vdk, 'vdk'], ['game.dsk', vdk, 'vdk'], ['GAME', vdk, 'vdk'], ['game.dsk', jvc, 'jvc'],
    ['game.os9', jvc, 'jvc'], ['game.dsk', hdr, 'jvc'], ['game.jvc', hdr, 'jvc']]) {
    const m = Emu.detectMedia(name, bytes), d = Emu.detectDiskFormat(bytes, name);
    check(`${name} (${want}): both detectors say ${want}`, d === want && m.kind === 'disk' && m.diskFormat === want, `detectDiskFormat ${d}, detectMedia ${m.kind}/${m.diskFormat}`);
  }
  check('a VDK named .dsk is a Dragon VDK disk', Emu.detectMedia('game.dsk', vdk).format === 'VDK disk' && Emu.detectMedia('game.dsk', vdk).family === 'dragon');
  const junk = new Uint8Array(1000).fill(7);
  check('a .dsk that is no disk format: a disk with no format, for both', Emu.detectDiskFormat(junk, 'x.dsk') === null && Emu.detectMedia('x.dsk', junk).diskFormat === null);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
