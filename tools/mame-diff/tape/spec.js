// Cassette firmware for the Dragon/CoCo family (written for CLOADM), installed in place of the BASIC ROM:
//   csave.asm  writes a namefile, a data and an end-of-file block through the DAC, as BASIC's writer does
//   cload.asm  reads blocks from the cassette input, as BASIC's reader does, and reports what it read
// and the same pair for the MC-10 / Matra Alice, whose CPU is a 6803 and whose cassette is P20 / P24 of the
// 6803's port 2 with no motor relay:
//   csave6803.asm, cload6803.asm
// tests/tape.test.js runs them on our machines; run-tape.js runs them in MAME.
const path = require('path');
const { loadEmu, assembleFile, romImage } = require('../lib/firmware');

// the firmware as the profile's ROM slots; the 6809 pair is a 16K image at $8000 (Dragon 64: both banks the
// same) and a 32K one on the CoCo 3, whose BASIC socket spans $8000-$FFFF; the 6803 pair an 8K image at $E000
// in the MC-10's single BASIC slot. The image covers the profile's whole ROM area, so the slot slices fit.
function firmware(profileId, file) {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const is6803 = file.includes('6803');
  const asm = assembleFile(path.join(__dirname, file), is6803 ? '6803' : '6809');
  const base = Math.min(...profile.roms.map((sl) => sl.at));
  const end = Math.max(...profile.roms.map((sl) => sl.at + sl.size));
  const img = romImage(asm, base, end - base, is6803 ? 0x01 : 0x12);
  const slots = {}, files = {};
  for (const sl of profile.roms) slots[sl.id] = img.slice(sl.at - base, sl.at - base + sl.size);
  for (const sl of profile.roms) for (const f of sl.files) files[f] = slots[sl.id];
  return {
    asm, slots, files, system: profile.mame, haltPc: asm.symbols.get('HALT'),
    machine: (config = {}) => { const m = Emu.createMachine(profileId, config); m.setRoms(slots); m.reset(true); return m; },
  };
}

// the byte stream csave.asm writes, built here from the format, independently of the firmware
function csaveStream() {
  const block = (type, data) => {
    let sum = (type + data.length) & 0xFF;
    for (const d of data) sum = (sum + d) & 0xFF;
    return [0x3C, type, data.length, ...data, sum, 0x55];
  };
  const leader = () => new Array(128).fill(0x55);
  const name = [...'CLOADM  '].map((c) => c.charCodeAt(0)).concat([0x02, 0x00, 0x00, 0x30, 0x00, 0x30, 0x00]);
  const data = Array.from({ length: 255 }, (_, i) => (11 + 37 * i) & 0xFF);
  return Uint8Array.from([...leader(), ...block(0x00, name), ...leader(), ...block(0x01, data), ...leader(), ...block(0xFF, [])]);
}

// for the regression gate (tests/regress.test.js): the instruction trace of a firmware run on our machine;
// for the regression gate (tests/regress.test.js): the instruction trace of a firmware run on our machine;
// the reader reads the tape the writer writes
const REGS6809 = ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'].map((name) => ({ name }));
const REGS6803 = ['pc', 'a', 'b', 'x', 's', 'cc'].map((name) => ({ name }));
function trace(profileId, file) {
  const f = firmware(profileId, file), Emu = loadEmu();
  const is6803 = file.includes('6803');
  const load = file.startsWith('cload');
  return {
    regs: is6803 ? REGS6803 : REGS6809, haltPc: f.haltPc,
    // HALT comes after about 1,076,000 (csave) and 923,000 (cload) instructions on the 6809, and 1,165,000
    // (csave6803) and 1,247,000 (cload6803) on the 6803
    instructions: is6803 ? 1400000 : 1100000,
    machine: () => {
      // the MC-10 is compared at its base 4K fitting, which MAME's mc10 uses by default
      const m = f.machine(is6803 ? { ram: 4 } : {});
      if (load) m.deck.insert(new Emu.Tape(csaveStream(), m.tickHz, 'csave.cas', m.profile.tape));
      return m;
    },
  };
}

module.exports = { firmware, csaveStream, trace };
