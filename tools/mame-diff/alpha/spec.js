// Comparison spec for the Dragon Alpha (dgnalpha): run.js dgnalpha [--video | --board | --pia1b].
// --board: board.asm, our boot ROM for the Alpha's own hardware (ROM paging, PIA2, the AY-3-8912, the modem),
// with a marked 16K image in the BASIC socket.
// The SAM family's firmware (sam/diag.asm, sam/vdg.asm) goes in the BASIC socket (alpha_ba.rom, 16K) and
// pager.asm in the boot socket (alpha_bt_10.rom, 8K): the Alpha starts in the boot ROM bank, and the pager
// switches to the BASIC bank through PIA2 and jumps through its reset vector.
const path = require('path');
const { loadEmu, assembleFile, romImage, writeRoms, mameConfigArgs } = require('../lib/firmware');
const sam = require('../sam/spec');
const { workDir } = require('../lib/workdir');
const { REGS } = require('../lib/regs');

const pager = () => romImage(assembleFile(path.join(__dirname, 'pager.asm'), '6809'), 0xA000, 0x2000, 0x12);
// the Alpha's ROM slots for a 16K image meant for $8000-$BFFF
const slotsFor = (bank) => ({ boot: pager(), basic: bank });
const filesFor = (profile, slots) => {
  const files = {};
  for (const sl of profile.roms) files[sl.files[0]] = slots[sl.id];
  return files;
};
function machine(profileId, slots, config = {}) {
  const m = loadEmu().createMachine(profileId, Object.assign({ mameCompat: true }, config));
  m.setRoms(slots);
  m.reset(true);
  return m;
}

module.exports = {
  family: 'alpha',
  slotsFor,
  trace(profileId, { regenerate = true, config = {}, work = workDir(profileId) } = {}) {
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const resolved = Emu.resolveConfig(profileId, Object.assign({ mameCompat: true }, config));
    const asm = assembleFile(path.join(__dirname, '../sam/diag.asm'), '6809', regenerate && path.join(__dirname, '../sam/gen-diag.js'));
    const slots = slotsFor(romImage(asm, 0x8000, 0x4000, 0x12));
    return {
      label: profileId, system: profile.mame, work, seconds: 4, args: ['-ext', '', ...mameConfigArgs(resolved)],
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: asm.symbols.get('HALT'),
      install: () => writeRoms(work, profile.mame, filesFor(profile, slots)),
      machine: () => machine(profileId, slots, config),
      instructions: 300000,
    };
  },
  // the 6551 with nothing in the serial port (run.js dgnalpha --serial-idle): sam/acia-idle.asm in the BASIC socket, behind the pager,
  // the same firmware and log as the Dragon 64's (sam/spec.js aciaIdle)
  aciaIdle(profileId, { config = {}, work = `/tmp/mame-diff/${profileId}-acia-idle` } = {}) {
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const resolved = Emu.resolveConfig(profileId, Object.assign({ mameCompat: true }, config));
    const asm = assembleFile(path.join(__dirname, '../sam/acia-idle.asm'), '6809');
    const slots = slotsFor(romImage(asm, 0x8000, 0x4000, 0x12));
    return {
      label: `${profileId} ACIA, nothing in the port`, system: profile.mame, work, seconds: 4, args: ['-ext', '', ...mameConfigArgs(resolved)],
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: asm.symbols.get('HALT'),
      install: () => writeRoms(work, profile.mame, filesFor(profile, slots)),
      machine: () => machine(profileId, slots, config),
      instructions: 100000,
      result: (m) => ({ done: m.ram[0x7000] === 0xFF, log: [...m.ram.slice(0x7100, 0x7100 + 22)] }),
    };
  },
  // PIA1 port B's input pins (run.js dgnalpha --pia1b): alpha/pia1b.asm, the same 8K at $A000 in both ROM banks
  // (PIA1 PB2 pages them)
  pia1b(profileId, { config = {}, work = `/tmp/mame-diff/${profileId}-pia1b` } = {}) {
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const resolved = Emu.resolveConfig(profileId, Object.assign({ mameCompat: true }, config));
    const asm = assembleFile(path.join(__dirname, 'pia1b.asm'), '6809');
    const code = romImage(asm, 0xA000, 0x2000, 0x12);
    const basic = new Uint8Array(0x4000).fill(0x12);
    basic.set(code, 0x2000);
    const slots = { boot: code, basic };
    return {
      label: `${profileId} pia1b.asm`, system: profile.mame, work, seconds: 4, args: ['-ext', '', ...mameConfigArgs(resolved)],
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: asm.symbols.get('HALT'),
      install: () => writeRoms(work, profile.mame, filesFor(profile, slots)),
      machine: (cfg = config) => machine(profileId, slots, cfg),
      instructions: 400000,
    };
  },
  // video firmware for the regression test (sam/vdg.asm in the BASIC socket)
  video(profileId) {
    const asm = assembleFile(path.join(__dirname, '../sam/vdg.asm'), '6809');
    const slots = slotsFor(romImage(asm, 0x8000, 0x4000, 0x12));
    return { machine: () => machine(profileId, slots), frames: 680 };
  },
  // sound.asm (run.js --sound): the firmware and a machine running it
  sound(profileId) {
    const asm = assembleFile(path.join(__dirname, 'sound.asm'), '6809');
    const slots = { boot: romImage(asm, 0xA000, 0x2000, 0x00), basic: new Uint8Array(0x4000).fill(0x12) };
    return { slots, haltPc: asm.symbols.get('HALT'), machine: () => machine(profileId, slots) };
  },
  board(profileId, { work = workDir(`${profileId}-board`) } = {}) {
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const asm = assembleFile(path.join(__dirname, 'board.asm'), '6809');
    const basic = new Uint8Array(0x4000).fill(0x12);
    basic[0] = 0xB1; basic[0x2000] = 0xB2; basic[0x3FFF] = 0xB3;
    const slots = { boot: romImage(asm, 0xA000, 0x2000, 0x00), basic };
    return {
      label: `${profileId} board`, system: profile.mame, work, seconds: 4, args: ['-ext', ''],
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: asm.symbols.get('HALT'),
      install: () => writeRoms(work, profile.mame, filesFor(profile, slots)),
      machine: () => machine(profileId, slots),
      instructions: 60000,                          // past HALT (51,135)
    };
  },
};
