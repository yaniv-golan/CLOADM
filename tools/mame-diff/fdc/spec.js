// Comparison spec for the floppy disk controllers: run.js <profile> --fdc [<controller>] [--images].
// boot.asm replaces the BASIC ROM, <board>.asm the DOS ROM (dragonfdc on dragon64: -ext dragon_fdc, ddos10.rom;
// premierfdc on dragon64: -ext premier_fdc, deltados.rom; cocofdc on coco and coco3: -ext fdc, disk11.rom (on the CoCo 3
// boot3.asm replaces the 32K BASIC ROM); multifdc on coco:
// the same controller in slot 4 of a Multi-Pak, -ext multi, the slot the front-panel switch selects at reset, so the
// firmware runs unchanged while the controller's NMI and HALT reach the CPU through the Multi-Pak), all generated
// by gen-diag.js. Four drives: 0 a double-sided disk, 1 the same kind
// write-protected (MAME opens an image inside a ZIP read-only), 2 a drive without a disk, 3 a DMK disk.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { loadEmu, assembleFile, romImage, writeRoms, writeProfileRoms, mameConfigArgs } = require('../lib/firmware');
const { REGS } = require('../lib/regs');
const { workDir } = require('../lib/workdir');
const images = require('./images');

// by controller; each runs on its profiles, and a profile's first controller is its default
const SETUPS = {
  dragonfdc: { profiles: ['dragon64'], board: 'dragon', instructions: 2600000, ext: 'dragon_fdc', device: 'dragon_fdc', rom: 'ddos10.rom', slot: 'dragon_fdc:wd2797', drive: 'qd', type: 'dragonfdc',
    disks: () => [{ name: 'd0.vdk', bytes: images.vdk(40, 2) }, { name: 'd1.vdk', bytes: images.vdk(40, 1), writeProtected: true }, null, { name: 'd3.dmk', bytes: images.dmk(10, 2) }] },
  premierfdc: { profiles: ['dragon64'], board: 'premier', instructions: 2900000, ext: 'premier_fdc', device: 'premier_fdc', rom: 'deltados.rom', slot: 'premier_fdc:wd2791', drive: 'qd', type: 'premierfdc',
    disks: () => [{ name: 'd0.vdk', bytes: images.vdk(40, 2) }, { name: 'd1.vdk', bytes: images.vdk(40, 1), writeProtected: true }, null, { name: 'd3.dmk', bytes: images.dmk(10, 2) }] },
  // the Dragon Alpha's built-in controller: the firmware is the boot ROM, drives 0 and 1 (the machine's own)
  alphafdc: { profiles: ['dgnalpha'], board: 'alpha', instructions: 2600000, builtin: true,
    disks: () => [{ name: 'd0.vdk', bytes: images.vdk(40, 2) }, { name: 'd1.vdk', bytes: images.vdk(40, 1), writeProtected: true }] },
  cocofdc: { profiles: ['coco', 'coco3'], board: 'coco', instructions: 2600000, ext: 'fdc', device: 'coco_fdc', rom: 'disk11.rom', slot: 'fdc:wd17xx', drive: '525dd', type: 'cocofdc',
    disks: () => [{ name: 'd0.jvc', bytes: images.jvc(40, 2) }, { name: 'd1.vdk', bytes: images.vdk(40, 1), writeProtected: true }, null, { name: 'd3.dmk', bytes: images.dmk(10, 2) }] },
};
// multifdc is the same cocofdc controller reached through a Multi-Pak. mameMedia() builds the Multi-Pak's
// -ext args from multiSlot and puts setup.ext in that slot, so the plain cocofdc setup (ext 'fdc') is right;
// an ext of 'multi' here would name the Multi-Pak itself as the slot-4 device.
SETUPS.multifdc = Object.assign({}, SETUPS.cocofdc, { profiles: ['coco'], byName: true, multiSlot: 4 });
// the same controller with a NitrOS-9 dump on drive 0: MAME identifies it as OS9 and we read it through the jvc
// branch, so the images both sides write from the same firmware must still be byte-identical
SETUPS['cocofdc-os9'] = Object.assign({}, SETUPS.cocofdc, {
  disks: () => [{ name: 'd0.dsk', bytes: images.os9(40, 2) }, { name: 'd1.vdk', bytes: images.vdk(40, 1), writeProtected: true }, null, { name: 'd3.dmk', bytes: images.dmk(10, 2) }],
});
// The Tano Dragon is a Dragon 64 with an NTSC field and a different ROM set; MAME's tanodr64h takes the same
// dragon_fdc cartridge, so the NMI firmware runs there unchanged. It exists only for the 6309 NMI comparison
// (--nmi --cpu 6309), which is the one case that needs a second Dragon model; the full diagnostic does not run
// on it, so its setup is not a default for the profile. byName keeps it out of the default search, which is
// what nmiOnly used to do.
SETUPS.tanodragonfdc = Object.assign({}, SETUPS.dragonfdc, { profiles: ['tanodr64'], byName: true });

// multi (run.js --multi; a cartridge controller): the controller in a Multi-Pak's slot 4 (multiSlot, as multifdc;
// slots 1-3 empty; MAME offers controllers in slot 4 only) with <board>-multi.asm, the diagnostic plus the
// Multi-Pak's part
// write: the short <board>-write.asm (one sector on drives 0 and 1, the disk mounting tests) instead of the diagnostic;
// nmi: nmi.asm with nmi-boot.asm (when the 6809 starts taking NMI; dragon only);
// format: '<T>x<H>', <board>-format-<T>x<H>.asm (formats the blank disk in drive 0);
// cpu: '6809' (default) or '6309'. The NMI firmware is the one thing here that is about the CPU rather
// than the controller, so it is assembled for whichever core it runs on; the diagnostics are 6809 code
// and only ever run on the 6809.
// bare: gen-bare.js's read (bare-<board>.asm) in place of the BASIC ROM, and the cartridge ROM socket empty (all 00 in
// MAME, no ROM at all in ours): the controller driven by a program, with no DOS
function firmware(board, regenerate, profile, write = false, nmi = false, multi = false, format = null, cpu = '6809', halt = false, nitros9 = null, empty = false, bare = false) {
  if (bare) {
    if (regenerate) require('./gen-bare').write();
    const prog = assembleFile(path.join(__dirname, `bare-${board}.asm`), '6809');
    return { boot: romImage(prog, 0x8000, 0x4000, 0x12), dos: new Uint8Array(0x2000), bare: true, haltPc: prog.symbols.get('HALT') };
  }
  if (nitros9) {
    // the page's NitrOS-9 floppy loader as the CoCo 3's internal ROM; the controller's ROM socket holds RTS, never
    // run (the loader keeps the 32K internal ROM mapped). It ends in the hand-built boot track's loop.
    return { boot: loadEmu().nitros9LoaderRom('floppy'), dos: new Uint8Array(0x2000).fill(0x39), haltPc: nitros9.haltPc };
  }
  if (halt) {
    // coco-halt.asm is written by hand (not generated): the HALT and NMI reads at both CoCo 3 rates; with empty,
    // coco-halt-empty.asm: a halted read on a drive with no disk, which holds the CPU inside EMPTY's LDA for good
    const boot = assembleFile(path.join(__dirname, 'boot3.asm'), '6809');
    const diag = assembleFile(path.join(__dirname, empty ? 'coco-halt-empty.asm' : 'coco-halt.asm'), '6809');
    return { boot: romImage(boot, 0x8000, 0x8000, 0x12), dos: romImage(diag, 0xC000, 0x2000, 0x00), haltPc: diag.symbols.get('HALT'),
      stuckPc: empty ? diag.symbols.get('EMPTY') : undefined };
  }
  if (nmi) {
    const boot = assembleFile(path.join(__dirname, 'nmi-boot.asm'), cpu);
    const diag = assembleFile(path.join(__dirname, 'nmi.asm'), cpu);
    return { boot: romImage(boot, 0x8000, 0x4000, 0x12), dos: romImage(diag, 0xC000, 0x2000, 0x00), haltPc: diag.symbols.get('HALT') };
  }
  if (regenerate) require('./gen-diag').write();
  if (board === 'alpha') {
    // the boot ROM socket holds the diagnostic; the BASIC socket is never paged in
    const diag = assembleFile(path.join(__dirname, `alpha${write ? '-write' : ''}.asm`), '6809');
    return { slots: { boot: romImage(diag, 0xA000, 0x2000, 0x00), basic: new Uint8Array(0x4000).fill(0x12) }, haltPc: diag.symbols.get('HALT') };
  }
  const big = profile.roms[0].size === 0x8000;     // the CoCo 3's 32K internal ROM: boot3.asm (sets INIT0's SCS first)
  const boot = assembleFile(path.join(__dirname, big ? 'boot3.asm' : 'boot.asm'), '6809');
  const diag = assembleFile(path.join(__dirname, `${board}${write ? '-write' : multi ? '-multi' : format ? `-format-${format}` : ''}.asm`), '6809');
  return { boot: romImage(boot, 0x8000, big ? 0x8000 : 0x4000, 0x12), dos: romImage(diag, 0xC000, 0x2000, 0x00), haltPc: diag.symbols.get('HALT') };
}
function slotData(profile, bank0) {
  const out = {};
  for (const sl of profile.roms) out[sl.id] = bank0.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  return out;
}
// our machine with the controller and the same disks; media.bytes follow the writes
function machine(profileId, setup, fw, cpu = '6809') {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const m = Emu.createMachine(profileId, { mameCompat: true, cpu });
  m.setRoms(fw.slots || slotData(profile, fw.boot));
  let fdc = m.fdc;
  if (!setup.builtin) {
    fdc = new Emu.devices[setup.type]({ rom: fw.bare ? null : fw.dos });
    m.insertCartridge(setup.multiSlot ? new Emu.devices.multi([1, 2, 3, 4].map((n) => (n === setup.multiSlot ? fdc : null))) : fdc);
  }
  const disks = setup.disks();
  disks.forEach((d, i) => {
    if (!d) return;
    fdc.mount(i, { bytes: d.bytes.slice(), format: Emu.detectDiskFormat(d.bytes, d.name), name: d.name, writeProtected: !!d.writeProtected });
  });
  m.reset(true);
  return m;
}
// MAME's arguments and files: the disks written to the work directory
function mameMedia(work, setup) {
  const slot = setup.multiSlot ? `multi:slot${setup.multiSlot}:${setup.slot}` : setup.slot;
  const ext = setup.multiSlot ? ['-ext', 'multi', ...[1, 2, 3, 4].flatMap((n) => [`-ext:multi:slot${n}`, n === setup.multiSlot ? setup.ext : ''])] : ['-ext', setup.ext];
  const args = setup.builtin ? ['-ext', ''] : [...ext, '-ext:' + slot + ':2', setup.drive, '-ext:' + slot + ':3', setup.drive];
  setup.disks().forEach((d, i) => {
    if (!d) return;
    const file = path.join(work, d.name);
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    fs.writeFileSync(file, d.bytes);
    let arg = file;
    if (d.writeProtected) {
      const zip = path.join(work, d.name.replace(/\.\w+$/, '.zip'));
      try { fs.unlinkSync(zip); } catch (e) { /* none */ }
      cp.execFileSync('zip', ['-q', '-j', zip, file]);
      arg = zip;
    }
    args.push(`-flop${i + 1}`, arg);
  });
  return args;
}

module.exports = {
  SETUPS,
  // blank: { format: 'vdk' | 'jvc' | 'dmk', tracks, heads }: drive 0 holds js/media/disk.js blankDisk(...), the only
  // disk, and <board>-format-<T>x<H>.asm formats it (run.js --fdc <controller> --blank <format>:<T>x<H>)
  // cpu: '6809' (default) or '6309'; only the NMI firmware runs on the 6309 here
  trace(profileId, opts = {}) {
    // Every option below is read explicitly, so a key this function does not know is silently IGNORED -- the
    // caller gets a valid-looking trace of the wrong setup. That happened once: `cpu: '6309'` was passed to a
    // trace() with no such option and came back as a 6809 run with no error. Reject unknown keys by name, whatever
    // their value. A KNOWN key whose value is undefined or null is still fine: run.js passes `controller: undefined`
    // when no controller is named and `blank: null` when --blank is absent.
    const KNOWN = new Set(['controller', 'regenerate', 'write', 'nmi', 'multi', 'blank', 'cpu', 'halt', 'nitros9', 'empty', 'bare']);
    const unknown = Object.keys(opts).filter((k) => !KNOWN.has(k));
    if (unknown.length) throw new Error(`fdc.trace: unknown option ${unknown.map((k) => `'${k}'`).join(', ')} (known: ${[...KNOWN].join(', ')})`);
    const { controller, regenerate = true, write = false, nmi = false, multi = false, blank = null, cpu = '6809', halt = false, nitros9 = false, empty = false, bare = false } = opts;
    // `blank` is an object of its own, read field by field, so it needs the same check one level down: a
    // misspelt nested key (run.js's --blank parser writes heads, not sides) would otherwise be ignored and the
    // trace would come back for a different disk than the caller asked for.
    if (blank !== null && blank !== undefined) {
      if (typeof blank !== 'object') throw new Error(`fdc.trace: blank must be an object, not ${typeof blank}`);
      const KNOWN_BLANK = new Set(['format', 'tracks', 'heads']);
      const badBlank = Object.keys(blank).filter((k) => !KNOWN_BLANK.has(k));
      if (badBlank.length) throw new Error(`fdc.trace: unknown blank option ${badBlank.map((k) => `'${k}'`).join(', ')} (known: ${[...KNOWN_BLANK].join(', ')})`);
    }
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const id = controller || Object.keys(SETUPS).find((k) => !SETUPS[k].byName && SETUPS[k].profiles.includes(profileId));   // multifdc and tanodragonfdc only by name
    let setup = SETUPS[id];
    if (!setup || !setup.profiles.includes(profileId)) throw new Error(`no floppy controller comparison ${controller || ''} for ${profileId} (have: ${Object.entries(SETUPS).map(([k, v]) => `${k} on ${v.profiles.join(' and ')}`).join(', ')})`);
    if ((halt || nitros9) && (id !== 'cocofdc' || profileId !== 'coco3' || write || nmi || multi || blank || (halt && nitros9))) throw new Error(`--${halt ? 'halt' : 'nitros9'}: for cocofdc on coco3 alone, by itself`);
    if (empty && !halt) throw new Error('--empty: with --halt (the halted read on a drive with no disk)');
    if (bare && (!['dragonfdc', 'cocofdc'].includes(id) || !['dragon64', 'coco'].includes(profileId) || write || nmi || multi || blank || halt || nitros9 || cpu !== '6809')) throw new Error('--bare: dragonfdc on dragon64 or cocofdc on coco, by itself');
    if (nmi && setup.board !== 'dragon') throw new Error('--nmi: the NMI firmware is for dragonfdc on dragon64');
    if (cpu === '6309' && !nmi && !nitros9) throw new Error('--cpu 6309: only the NMI and NitrOS-9 floppy loader firmware run on the 6309 here');
    if (cpu === '6309' && !profile.mame6309) throw new Error(`${profileId}: no HD6309 sibling in MAME`);
    // byName setups exist for one mode alone -- tanodragonfdc is the Tano Dragon's entry for the NMI
    // comparison, and the full diagnostic has no setup that runs on that model -- so --multi, which runs
    // <board>-multi.asm, must not select them.
    if (multi && (setup.builtin || setup.multiSlot || setup.byName || write || nmi || blank)) throw new Error(`--multi: a cartridge controller's diagnostic only (not ${id}${write ? ' --write' : nmi ? ' --nmi' : blank ? ' --blank' : ''})`);
    if (multi) setup = Object.assign({}, setup, { multiSlot: 4 });
    // --nitros9: drive 0 holds a hand-built NitrOS-9 floppy (tools/nitros9/os9-image.js: 40 tracks, two sides) whose
    // boot track, once the loader has read it, ends in a loop
    const n9disk = nitros9 ? require('../../nitros9/os9-image.js').makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440, cpu: null }) : null;
    if (n9disk) setup = Object.assign({}, setup, { disks: () => [{ name: 'd0.dsk', bytes: n9disk.slice() }] });
    let format = null, seconds = write || nmi || halt || nitros9 || bare ? 4 : 20, instructions = nmi ? 3000 : write || halt || nitros9 || bare ? 400000 : setup.instructions + (multi ? 300000 : 0);
    if (blank) {
      format = `${blank.tracks}x${blank.heads}`;
      const have = (require('./gen-diag').FORMATS[setup.board] || []).map(([t, h]) => `${t}x${h}`);
      if (!have.includes(format)) throw new Error(`--blank: no format firmware ${format} for ${id} (have: ${have.join(', ') || 'none'})`);
      const bytes = Emu.blankDisk(blank.format, blank.tracks, blank.heads);
      setup = Object.assign({}, setup, { disks: () => [{ name: `blank.${blank.format}`, bytes: bytes.slice() }] });
      // about 0.8 s a track and side measured (the step; building and patching the 6K track at 0.89 MHz; the write
      // track waiting for the index and one revolution; sector 18 read back), then the reads: 80 x 2 halts after 130 s
      seconds = Math.ceil(10 + blank.tracks * blank.heads * 0.95);
      instructions = blank.tracks * blank.heads * 220000 + 600000;   // past HALT (dragonfdc 40 x 1: 8,750,860; cocofdc 35 x 1: 7,717,543)
    }
    const work = workDir(`${profileId}-${id}${bare ? '-bare' : ''}${write ? '-write' : ''}${halt ? '-halt' : ''}${empty ? '-empty' : ''}${nitros9 ? '-nitros9' : ''}${nmi ? '-nmi' : ''}${multi ? '-multi' : ''}${blank ? `-blank-${blank.format}-${format}` : ''}${cpu === '6309' ? '-6309' : ''}`);
    const fw = firmware(setup.board, regenerate, profile, write, nmi, multi, format, cpu, halt, n9disk, empty, bare);
    const slots = fw.slots || slotData(profile, fw.boot);
    const system = cpu === '6309' ? profile.mame6309 : profile.mame;
    return {
      label: `${profileId} ${id}${bare ? ' bare' : ''}${write ? ' write' : ''}${halt ? ' halt' : ''}${empty ? ' empty' : ''}${nitros9 ? ' nitros9' : ''}${nmi ? ' nmi' : ''}${multi ? ' multi' : ''}${blank ? ` blank ${blank.format} ${format}` : ''}${cpu === '6309' ? ' (6309)' : ''}`,
      system, work, seconds, write, multi, blank,
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: fw.haltPc, setup, fw,
      // --empty: the CPU held inside this instruction for good (lib/lockstep.js: the trace stops there on both sides)
      stuck: fw.stuckPc !== undefined ? { pc: fw.stuckPc } : null,
      instructions,             // past HALT (dragonfdc 2,402,179; cocofdc 2,529,837; premierfdc 2,811,924)
      install: () => {
        fs.mkdirSync(work, { recursive: true });
        writeProfileRoms(work, profile, slots, system);
        if (!setup.builtin) writeRoms(work, setup.device, { [setup.rom]: fw.dos });
      },
      // the RAM MAME fits is ours (the CoCo 3's default 512K)
      get args() { return [...mameMedia(work, setup), ...mameConfigArgs(Emu.resolveConfig(profileId, { mameCompat: true }))]; },
      machine: () => machine(profileId, setup, fw, cpu),
      fdcOf: (m) => (setup.builtin ? m.fdc : setup.multiSlot ? m.cartPort.slots[setup.multiSlot - 1] : m.cartPort),   // the controller in a machine machine() built
    };
  },
};
