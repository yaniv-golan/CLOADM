/*
 * Model registry (data only). Each profile names its machine family; createMachine(id)
 * instantiates families[profile.family].
 *
 * ROM slot: { id, label, size, at (CPU address), bank, required, files (usual names, as dumped / used by
 * MAME), aliases (other names in common ROM sets, e.g. XRoar's), crcs (CRC32 of known-good dumps, used only
 * to recognise files) }. Names only help when a file's contents aren't recognised; sizes must still match.
 *
 * `joystick: false` marks a model with no joystick port at all (the MC-10 and its clones): the page's touch
 * panel offers no stick there, and no Hi-Res interface or The Rat either (js/host/input.js
 * touchJoystickOffered). Every other model has the two the Dragons and CoCos share (js/machines/cocopia.js).
 */
import { SamMachine } from './sam.js';
import { D64PlusMachine } from './d64plus.js';
import { Coco3Machine } from './coco3.js';

import { Mc10Machine } from './mc10.js';
import { AlphaMachine } from './alpha.js';
import { Debugger } from '../debugger.js';
import { registry } from '../util.js';

// machine families: the hardware each profile is built on
export const families = registry({ sam: SamMachine, alpha: AlphaMachine, d64plus: D64PlusMachine, coco3: Coco3Machine, mc10: Mc10Machine });

// configurable options: { name: { values, default } }; every machine also has `mameCompat`
const ram = (values, def = values[values.length - 1]) => ({ ram: { values, default: def, unit: 'K' } });
const cpu = (...values) => ({ cpu: { values, default: values[0] } });
// a joystick port can hold a Hi-Res interface, or "The Rat" mouse, instead of a stick (js/machines/cocopia.js);
// MAME's HIRES_INTF_TAG and ctrl_sel settings, by the names they go by on the machines
const HIRES = ['none', 'tandy-right', 'tandy-left', 'max3-right', 'max3-left', 'rat-right', 'rat-left'];
const hires = () => ({ hires: { values: HIRES, default: 'none' } });
const opts = (...parts) => Object.assign({}, ...parts);
// the Becker port for DriveWire at $FF41-$FF42 (MAME's "Becker Port" setting on its CoCo drivers)
const becker = { becker: { values: [false, true], default: false } };
// The Speech/Sound Pak in the cartridge port (MAME's `-ext ssc`). Only the models this project has run
// the Pak's lockstep on offer it: CoCo 1/2 (`coco`), CoCo 2B (`coco2b`) and CoCo 3 (`coco3`), and the Dragon 64
// (`dragon64`, whose MAME driver lists the `ssc` slot too), each compared with MAME 0.264 to HALT
// (`tools/mame-diff/run.js <profile> --ssc`). A model without this option refuses `ssc` at resolveConfig with the
// usual unknown-option message, and the page does not offer the board. 'music' inserts the Pak with its AY-8913
// routed; its speech side needs the SP0256, which is not implemented yet (README).
const ssc = { ssc: { values: ['none', 'music'], default: 'none' } };

const slot = (id, label, size, at, files, crcs, opts = {}) => Object.assign({ id, label, size, at, files, crcs, aliases: [], bank: 0, required: false }, opts);
// a ROM chip the machine reads directly rather than through the CPU bus: the Dragon 200-E's character
// generator. `at` is null (it has no CPU address) and `chip` marks it for the machine's own use.
const chip = (id, label, size, files, crcs) => slot(id, label, size, null, files, crcs, { required: true, chip: true });
const d64Roms = (f1, c1, f2, c2, aliases1 = [], aliases2 = []) => [
  slot('basic', '32K-mode BASIC', 0x4000, 0x8000, [f1], [c1], { required: true, aliases: aliases1 }),
  slot('basic64', '64K-mode BASIC', 0x4000, 0x8000, [f2], [c2], { bank: 1, aliases: aliases2 }),
];
const cocoRoms = (bas, extbas) => [
  slot('bas', 'Color BASIC', 0x2000, 0xA000, bas.files, bas.crcs, { required: true, aliases: bas.aliases || [] }),
  slot('extbas', 'Extended Color BASIC', 0x2000, 0x8000, extbas.files, extbas.crcs),
];

const P = registry({
  // ---- SAM family: 6809 + SAM + 2 PIAs + MC6847 ----
  dragon32: {
    options: opts(cpu('6809'), ram([32]), hires()),
    name: 'Dragon 32', family: 'sam', keyboard: 'dragon', video: 'pal', multiPak: true, mame: 'dragon32',
    roms: [slot('basic', 'Dragon 32 BASIC', 0x4000, 0x8000, ['d32.rom'], ['E3879310'], { required: true })],
  },
  dragon64: {
    options: opts(cpu('6809', '6309'), ram([64]), hires(), ssc),
    name: 'Dragon 64', family: 'sam', keyboard: 'dragon', video: 'pal', acia: true, rs232: true, bankSelect: true, multiPak: true, mame: 'dragon64', mame6309: 'dragon64h',
    roms: d64Roms('d64_1.rom', '60A4634C', 'd64_2.rom', '17893A42', ['d64rom1.rom', 'd64tano.rom'], ['d64rom2.rom', 'd64tano2.rom']),
  },
  dragon200: {
    options: opts(cpu('6809'), ram([64]), hires()),
    name: 'Dragon 200', family: 'sam', keyboard: 'dragon', video: 'pal', acia: true, rs232: true, bankSelect: true, mame: 'dragon200',
    roms: d64Roms('ic18.rom', '84F68BF9', 'ic17.rom', '17893A42'),
  },
  // Dragon 200-E: the Spanish 200 with a character generator ROM fitted in place of the VDG's internal set,
  // and the VDG rewired to reach it (MAME's dragon200e_state: char_rom_r() composes
  // (raster line << 8) | (PIA1 PB4 << 7) | byte & 0xFFF, and sam_read() drives AS from the fetched byte's
  // bit 7, INTEXT from its inverse and INV from the LK1 "Inverse Video" link). The matrix is the Dragon's;
  // only the legends differ (the Spanish characters), which is js/machines/keyboards.js's dragon200e.
  dragon200e: {
    options: opts(cpu('6809'), ram([64]), hires(), { inverseVideo: { values: [false, true], default: false } }),
    name: 'Dragon 200-E', family: 'sam', keyboard: 'dragon200e', video: 'pal', acia: true, bankSelect: true,
    mame: 'dragon200e', charGen: { intExtFromData: true },
    roms: [...d64Roms('ic18_v1.4e.ic34', '95AF0A0A', 'ic17_v1.4e.ic37', '48B985DF'),
      chip('chargen', 'Character generator', 0x1000, ['rom26.ic1'], ['565724BC'])],
  },
  tanodr64: {
    options: opts(cpu('6809', '6309'), ram([64]), hires()),
    name: 'Tano Dragon 64', family: 'sam', keyboard: 'dragon', video: 'ntsc', acia: true, rs232: true, bankSelect: true, mame: 'tanodr64', mame6309: 'tanodr64h',
    roms: d64Roms('d64_1.rom', '60A4634C', 'd64_2.rom', '17893A42', ['d64tano.rom'], ['d64tano2.rom']),
  },
  // Dragon Professional (Alpha): a Dragon 64 with a boot ROM, a third PIA, an AY-3-8912 and a built-in disk
  // interface (js/machines/alpha.js). MAME's ROM set: the boot ROM (v1.0, or v0.4) and a 16K BASIC.
  dgnalpha: {
    options: opts(cpu('6809'), ram([64])),
    name: 'Dragon Professional (Alpha)', family: 'alpha', keyboard: 'dragon', video: 'pal', acia: true, mame: 'dgnalpha',
    roms: [slot('boot', 'Boot ROM', 0x2000, 0xA000, ['alpha_bt_10.rom', 'alpha_bt_04.rom'], ['C3DAB585', 'D6172B56'], { required: true }),
      slot('basic', 'BASIC', 0x4000, 0x8000, ['alpha_ba.rom'], ['84F68BF9'], { bank: 1, required: true })],
  },
  // Dragon 64 Plus: a Dragon 64 with a second, 80-column board on a Hitachi HD6845S CRTC and its own
  // character generator (MAME's d64plus_state, src/mame/trs/dragon.cpp). Same BASIC ROMs as the 64.
  // The character generator is required: the 80-column screen has no picture without it. The timing PROM
  // (n82s147an.ic12) is not: MAME refuses to start the machine without its file, but the driver never
  // reads it and neither do we, so CLOADM neither needs nor uses it. Both are chips the machine reads
  // directly, not CPU bus sockets. The real glyphs are only exercised with a user-supplied generator.
  d64plus: {
    options: opts(cpu('6809'), ram([64])),
    name: 'Dragon 64 Plus', family: 'd64plus', keyboard: 'dragon', video: 'pal', acia: true, bankSelect: true, mame: 'd64plus',
    roms: [...d64Roms('d64_1.rom', '60A4634C', 'd64_2.rom', '17893A42'),
      chip('chargen', 'Character generator (80-column board)', 0x2000, ['chargen.ic22'], ['514F1450']),
      slot('prom', 'Timing PROM (not used)', 0x200, null, ['n82s147an.ic12'], ['92B6728D'], { chip: true })],
  },
  coco: {
    options: opts(cpu('6809', '6309'), ram([4, 16, 32, 64]), hires(), becker, ssc),
    name: 'CoCo 1/2', family: 'sam', keyboard: 'coco', video: 'ntsc', ca1Low: true, multiPak: true, mame: 'coco', mame6309: 'cocoh',
    roms: cocoRoms({ files: ['bas12.rom', 'bas11.rom', 'bas10.rom', 'bas13.rom'], crcs: ['54368805', '6270955A', '00B50AAA', 'D8F4D15E'] },
      { files: ['extbas11.rom', 'extbas10.rom'], crcs: ['A82A6254', '6111A086'] }),
  },
  coco2b: {
    options: opts(cpu('6809'), ram([4, 16, 32, 64]), hires(), becker, ssc),
    name: 'CoCo 2B', family: 'sam', keyboard: 'coco', video: 'ntsc', vdg: 't1', ca1Low: true, multiPak: true, mame: 'coco2b',
    roms: cocoRoms({ files: ['bas13.rom'], crcs: ['D8F4D15E'], aliases: ['bas14.rom'] }, { files: ['extbas11.rom'], crcs: ['A82A6254'] }),
  },
  mx1600: {
    options: opts(cpu('6809'), ram([4, 16, 32, 64]), hires(), becker),
    name: 'Dynacom MX-1600', clone: true, family: 'sam', keyboard: 'coco', video: 'ntsc', ca1Low: true, multiPak: true, mame: 'mx1600',
    roms: cocoRoms({ files: ['mx1600bas.rom'], crcs: ['D918156E'] }, { files: ['mx1600extbas.rom'], crcs: ['322A3D58'] }),
  },
  lzcolor64: {
    options: opts(cpu('6809'), ram([4, 16, 32, 64]), hires(), becker),
    name: 'LZ Color64', clone: true, family: 'sam', keyboard: 'coco', video: 'ntsc', ca1Low: true, multiPak: true, mame: 'lzcolor64',
    roms: cocoRoms({ files: ['color_basic.ci24'], crcs: ['B0717D71'] }, { files: ['extendido.ci23'], crcs: ['D1B1560D'] }),
  },
  cd6809: {
    options: opts(cpu('6809'), ram([4, 16, 32, 64]), hires(), becker),
    name: 'Codimex CD-6809', clone: true, family: 'sam', keyboard: 'coco', video: 'ntsc', ca1Low: true, multiPak: true, mame: 'cd6809',
    roms: cocoRoms({ files: ['cd6809bas84.rom', 'cd6809bas83.rom'], crcs: ['8A9971DA', 'F8E64142'] },
      { files: ['cd6809extbas84.rom', 'cd6809extbas83.rom'], crcs: ['8DC853E2', 'E5D5AA15'] }),
  },
  // Prológica CP 400: MAME's cp400(config) is coco(config) with a different default cartridge, and it loads one
  // 16K cp400bas.rom over $8000-$BFFF through the same SAM maps (src/mame/trs/coco12.cpp). So: CoCo hardware,
  // one 16K BASIC ROM, and the CoCo keyboard (only the sibling cp400c2 has a different matrix).
  // The name keeps its accent; the stub console folds it for the 32x16 screen (js/machines/stub.js).
  cp400: {
    options: opts(cpu('6809'), ram([4, 16, 32, 64]), hires(), becker),
    name: 'Prológica CP-400', family: 'sam', keyboard: 'coco', video: 'ntsc', ca1Low: true, mame: 'cp400',
    roms: [slot('basic', 'CP 400 BASIC', 0x4000, 0x8000, ['cp400bas.rom'], [], { required: true })],
  },

  // ---- GIME family ----
  coco3: {
    options: opts(cpu('6809', '6309'), ram([128, 512]), hires(), becker, ssc),
    name: 'CoCo 3', family: 'coco3', keyboard: 'coco', video: 'ntsc', multiPak: true, mame: 'coco3', mame6309: 'coco3h',
    roms: [slot('basic', 'Super Extended Color BASIC', 0x8000, 0x8000, ['coco3.rom'], ['B4C88D6C'], { required: true })],
  },
  coco3p: {
    options: opts(cpu('6809'), ram([128, 512]), hires(), becker),
    name: 'CoCo 3 (PAL)', family: 'coco3', keyboard: 'coco', video: 'pal', mame: 'coco3p',
    roms: [slot('basic', 'Super Extended Color BASIC', 0x8000, 0x8000, ['coco3p.rom'], ['FF050D80'], { required: true })],
  },

  // ---- MC-10 family: 6803 + MC6847 ----
  mc10: {
    options: opts(cpu('6803'), ram([4, 20])),
    name: 'MC-10', family: 'mc10', textScreen: 0x4000, keyboard: 'mc10', video: 'ntsc', mame: 'mc10', joystick: false,
    tape: { zeroHz: 1200, oneHz: 2400, pad: false }, basicFeatures: { timer: false, joystk: false, pmode: false },
    roms: [slot('basic', 'Micro Color BASIC', 0x2000, 0xE000, ['mc10.rom'], ['11FDA97E'], { required: true })],
  },
  alice: {
    options: opts(cpu('6803'), ram([4, 20])),
    // MAME's alice uses the MC-10 machine configuration unchanged (MC6847 NTSC, 3.58 MHz / 4)
    name: 'Matra Alice', family: 'mc10', textScreen: 0x4000, keyboard: 'alice', video: 'ntsc', mame: 'alice', joystick: false,
    tape: { zeroHz: 1200, oneHz: 2400, pad: false }, basicFeatures: { timer: false, joystk: false, pmode: false },
    roms: [slot('basic', 'BASIC', 0x2000, 0xE000, ['alice.rom'], ['F876ABE9'], { required: true })],
  },
});
for (const [id, p] of Object.entries(P)) p.id = id;

// Disk-controller cartridge ROMs. Disk BASIC lives in the cartridge, not the computer; these are
// recognised and stored now for the disk cartridges, which will add their sockets
// and known-good CRCs. Until then they are matched by name, at the usual 8K size.
export const cartridgeRoms = registry({
  // controller: the board in js/machines/fdc.js the ROM goes in
  dragondos: { id: 'dragondos', name: 'DragonDOS cartridge', for: 'Dragon', controller: 'dragonfdc', roms: [slot('rom', 'DragonDOS ROM', 0x2000, 0xC000, ['ddos10.rom'], [], { aliases: ['ddos11c.rom', 'ddos12a.rom', 'ddos42.rom'] })] },
  deltados: { id: 'deltados', name: 'Delta DOS cartridge', for: 'Dragon', controller: 'premierfdc', roms: [slot('rom', 'Delta DOS ROM', 0x2000, 0xC000, ['deltados.rom'], [])] },
  rsdos: { id: 'rsdos', name: 'Disk BASIC (RS-DOS) cartridge', for: 'CoCo', controller: 'cocofdc', roms: [slot('rom', 'Disk BASIC ROM', 0x2000, 0xC000, ['disk11.rom'], [], { aliases: ['disk10.rom', 'disk12.rom'] })] },
  cp400dsk: { id: 'cp400dsk', name: 'CP-400 disk cartridge', for: 'Prológica CP-400', roms: [slot('rom', 'CP-400 disk ROM', 0x2000, 0xC000, ['cp400dsk.rom'], [])] },
});
for (const c of Object.values(cartridgeRoms)) c.kind = 'cartridge';

export const profiles = P;
export const availableProfiles = () => Object.values(P);
// options every machine has
const COMMON = { mameCompat: { values: [false, true], default: false } }; // reproduce MAME artefacts (comparisons only)

// Resolve a config ({ option: value }) against a profile: defaults filled in, values validated.
export const resolveConfig = (id, config = {}) => {
  const p = P[id];
  if (!p) throw new Error('unknown machine ' + id);
  const all = Object.assign({}, COMMON, p.options);
  for (const k of Object.keys(config)) if (!(k in all)) throw new Error(`${p.name}: unknown option "${k}"`);
  const out = {};
  for (const [k, o] of Object.entries(all)) {
    const v = k in config ? config[k] : o.default;
    if (!o.values.includes(v)) throw new Error(`${p.name}: ${k} must be one of ${o.values.join(', ')} (got ${v})`);
    out[k] = v;
  }
  return Object.freeze(out);
};
export const createMachine = (id, config = {}) => {
  const p = P[id];
  if (!p) throw new Error('unknown machine ' + id);
  const Family = families[p.family];
  return new Family(p, resolveConfig(id, config));
};

// a machine restored from a snapshot, given the same ROMs ({ slotId: Uint8Array })
// The display settings (composite colour, the artifact phase, the CoCo 3's monitor) are not machine state: a
// restored machine has its defaults until the Session applies them (Session.applyDisplay).
export const restoreSnapshot = (snap, roms) => {
  const m = createMachine(snap.machine, snap.config);
  m.setRoms(roms);
  // a snapshot that carried a debugging setup gets a debugger to hold it, in place before the restore so the
  // machine's loadState hands the state straight to it
  if (snap.state && snap.state.debugger) m.debugger = new Debugger(m);
  m.restore(snap);
  return m;
};
