// Comparison spec for the Dragon 64 Plus (MAME driver d64plus; src/mame/trs/dragon.cpp, d64plus_state).
//
// Two kinds of run:
//   trace()  - lockstep to HALT on our own firmware installed in the two BASIC ROM sockets, which is the
//              Dragon 64's diag.asm: a Dragon 64 Plus is one until software touches $FFE0-$FFE2, so this
//              proves the base machine (CPU, both PIAs, SAM, VDG, ACIA, ROM banks) is the 64's.
//   paging() - paging.asm without mameCompat: $FFE2 = $04 is the motherboard RAM, and the VDG never sees a bank.
//   plus()   - our 80-column firmware (plus.asm): programs the HD6845S, writes characters into the video
//              RAM bank through $FFE2, switches banks, and halts; the trace (every CRTC register access and
//              every $FFE2 bank write) is compared instruction for instruction.
//
// ROM files. MAME's d64plus needs four: the two BASIC banks, the 8K character generator and the 512-byte
// timing PROM. We supply our own generator (a pattern, never a real dump) and an empty PROM; the driver
// never reads the PROM, so its contents cannot affect a comparison.
const path = require('path'), fs = require('fs'), cp = require('child_process');
const { loadEmu, assembleFile, romImage, writeRoms, mameConfigArgs } = require('../lib/firmware');
const { REGS } = require('../lib/regs');

// An 8K character generator built from our own pattern, never a real ROM: each byte spells out the
// (code, raster line) address it was fetched for, so a pixel comparison proves which address the CRTC
// asked the chip for. Bit 7 of each byte is set on one cell in two, so the picture has both dark and lit
// pixels everywhere.
function genChargen() {
  const rom = new Uint8Array(0x2000);
  for (let a = 0; a < rom.length; a++) rom[a] = ((a >> 1) & 0x7F) ^ ((a & 1) ? 0xFF : 0x00);
  return rom;
}
function slotData(profile, bank0, bank1) {
  const out = {};
  for (const sl of profile.roms) {
    if (sl.chip) continue;
    const img = sl.bank === 1 ? bank1 : bank0;
    out[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  }
  return out;
}
// every file MAME asks for, by the socket it belongs to
function romFiles(profile, slots) {
  const files = {};
  for (const sl of profile.roms) for (const f of sl.files) {
    files[f] = sl.chip ? (sl.id === 'chargen' ? slots.chargen : new Uint8Array(sl.size)) : slots[sl.id];
  }
  return files;
}
function machine(profileId, slots, config = {}) {
  const m = loadEmu().createMachine(profileId, Object.assign({ mameCompat: true }, config));
  m.setRoms(slots);
  m.reset(true);
  return m;
}
// our own two 16K images from an assembled source file (an absolute path, so the SAM family's firmware can
// be used for the base machine)
function images(file, generator) {
  const asm = assembleFile(path.isAbsolute(file) ? file : path.join(__dirname, file), '6809', generator);
  const bank0 = romImage(asm, 0x8000, 0x4000, 0x12);
  const bank1 = bank0.slice(); bank1[0x3F00] = 0x22;
  return { asm, bank0, bank1 };
}
// chargen: the 8K character generator both emulators get (genChargen() unless a comparison needs another of our own)
function run(profileId, file, { regenerate = false, config = {}, work, seconds, instructions, generator, chargen = genChargen() }) {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const resolved = Emu.resolveConfig(profileId, Object.assign({ mameCompat: true }, config));
  const { asm, bank0, bank1 } = images(file, regenerate && generator);
  const slots = Object.assign(slotData(profile, bank0, bank1), { chargen, prom: new Uint8Array(0x200) });
  const files = romFiles(profile, slots);
  return {
    label: `${profileId} ${path.basename(file)}`, system: profile.mame, work, seconds, args: ['-ext', '', ...mameConfigArgs(resolved)],
    regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: asm.symbols.get('HALT'), asm,
    install: () => writeRoms(work, profile.mame, files),
    machine: () => machine(profileId, slots, config),
    instructions,
  };
}

module.exports = {
  // the 6551 and its RS-232 port in loopback: the Dragon 64's acia.asm and spec (d64plus() starts from dragon64(config)),
  // on this machine's own ROM files (run.js --serial)
  serial(profileId, opts) { return require('../sam/spec.js').acia(profileId, opts); },
  genChargen,
  family: 'd64plus',
  // The Dragon 64's diagnostic firmware on a Dragon 64 Plus (a 64 Plus is a 64 until software touches the
  // CRTC, so this proves the base machine). The firmware and its generator live in the SAM family folder:
  // it is the same program, and its trace hash is compared on the 64 as well (tests/regress.test.js).
  trace(profileId, { regenerate = true, config = {}, work = `/tmp/mame-diff/${profileId}` } = {}) {
    const sam = path.join(__dirname, '../sam');
    return run(profileId, path.join(sam, 'diag.asm'), { regenerate, config, work, seconds: 4, instructions: 300000, generator: path.join(sam, 'gen-diag.js') });
  },
  // the 80-column board: plus.asm programs the CRTC, the video RAM bank and the 32K banks
  plus(profileId, { config = {}, work = `/tmp/mame-diff/${profileId}-plus` } = {}) {
    return run(profileId, 'plus.asm', { config, work, seconds: 4, instructions: 400000 });
  },
  // the 80-column text screens for the screen-text reader: plustext.asm (written by text-screens.js) clears and
  // writes the video RAM and sets R1, R6, R9 and R12/R13 for each screen, then puts text on the MC6847 screen
  plusText(profileId, { regenerate = true, config = {}, work = `/tmp/mame-diff/${profileId}-plustext`, chargen } = {}) {
    return run(profileId, 'plustext.asm', { regenerate, config, work, seconds: 12, instructions: 500000, generator: path.join(__dirname, 'text-screens.js'), chargen });
  },
  // the paging the Harvey-Smith traced schematic gives where MAME 0.264's outcome is the same (paging.asm): $04
  // after bank A or B is the motherboard RAM, and the VDG never sees a bank. Ours runs WITHOUT mameCompat, so the
  // banks reach memory on our side and the comparison shows the CPU and the VDG still reach the motherboard RAM.
  paging(profileId, { config = {}, work = `/tmp/mame-diff/${profileId}-paging` } = {}) {
    return run(profileId, 'paging.asm', { config: Object.assign({ mameCompat: false }, config), work, seconds: 10, instructions: 1500000 });
  },
};
