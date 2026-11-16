/*
 * The Speech/Sound Pak comparison (stage 2): MAME's `coco -ext ssc` against our
 * emulator, driven by our own firmware on both sides.
 *
 *   node tools/mame-diff/run.js coco --ssc
 *
 * WHAT GOES INTO MAME, AND WHY IT IS OURS
 * MAME's coco_ssc device takes two ROMs from its own romset, coco_ssc: the TMS7040's internal ROM
 * (pic-7040-510.bin, 4 KB) and the SP0256-AL2 allophone data (sp0256-al2.bin, 2 KB). Both are dumps a user
 * supplies at run time; for verification this project substitutes files it builds itself, under MAME's own
 * names, through MAME's checksum-mismatch path (AGENTS.md hard rule 1, tools/mame-diff/lib/). The names are
 * identical in MAME 0.264 and 0.289.
 *
 * The 6809 firmware is installed as the CoCo's BASIC: the Pak presents no ROM at $C000 (its rom() is null),
 * so the only place for our 6809 code is the ROM socket BASIC occupies. It assembles at $A000 with its
 * vectors at $BFF2, and reaches the card only through $FF7D/$FF7E.
 *
 * STATUS: this run is in lockstep to HALT. With IOCNT0 = $0C the card correctly refuses INT3 and neither side
 * ever clears the busy flag, so all 37 of the firmware's commands time out on both; that is the regression case
 * for a core that takes a masked interrupt (tests/ssc.test.js section 8 pins the count). The firmware clears
 * TIMEOUTS at START rather than relying on a power-on RAM value, which the two emulators do not share.
 */
const fs = require('fs'), path = require('path');
const { loadEmu, romImage, writeRoms } = require('../lib/firmware.js');
const { REGS } = require('../sam/spec.js');
const { buildPic, buildSp0256, buildAsm, OUT: SSC_ROM_OUT, IOCNT0_MASKED, IOCNT0_INT3_ENABLED } = require('../ssc/gen-roms.js');

const HERE = __dirname;

// Our 6809 firmware as the two BASIC slots. The vectors at $BFF2 live in the `bas` slot (at $A000); the
// `extbas` slot at $8000 is not reached by this firmware but MAME wants a file of the right size.
// Two cases:
//   masked - the source as it ships: the PIC leaves INT3 masked and WAITBUS gives up after POLLMAX reads. This
//            is the existing regression case that fails if a core takes a masked interrupt.
//   int3   - the PIC enables INT3 ($30) and the 6809 waits without a bound, so every command is serviced and
//            TIMEOUTS stays 0. The ISR path, compared by the ordered device-write sequence: MAME interleaves
//            its two CPUs on its scheduler, so poll counts differ by construction and the write sequence does
//            not.
function firmware(caseId = 'masked') {
  const asm = buildAsm({ unbounded: caseId === 'int3' });
  const rom = romImage(asm, 0xA000, 0x2000, 0x12);
  return { asm, rom, haltPc: asm.symbols.get('HALT') };
}

module.exports = {
  // the same shape cart/spec.js's setups use, so run.js can drive it the same way.
  // WHICH MACHINES. The Pak is a Color Computer cartridge. This comparison runs on the Color Computer profiles;
  // a model is only OFFERED the Pak on the page once this run has matched to HALT for it (the `ssc` option in
  // js/machines/profiles.js). Measured with MAME 0.264: coco, coco2b and coco3 match; mx1600, lzcolor64, cd6809
  // and coco3p have not been run (offer nothing for them until they are).
  profiles: ['coco', 'coco2b', 'coco3', 'mx1600', 'lzcolor64', 'cd6809', 'coco3p'],
  trace(profileId, caseId = 'masked') {
    if (!this.profiles.includes(profileId)) throw new Error(`the Speech/Sound Pak comparison does not cover ${profileId}`);
    if (caseId !== 'masked' && caseId !== 'int3') throw new Error(`unknown SSC case: ${caseId}`);
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    // each case and each machine installs different ROMs, so each gets its own work directory
    const work = caseId === 'int3' ? `/tmp/mame-diff/${profileId}-ssc-int3` : `/tmp/mame-diff/${profileId}-ssc`;
    const fw = firmware(caseId);
    const pic = buildPic({ iocnt0: caseId === 'int3' ? IOCNT0_INT3_ENABLED : IOCNT0_MASKED });
    const sp = buildSp0256();
    // The machine's own ROM image, under the names MAME's driver for THAT profile takes. The CoCo 3 loads one
    // 32K ROM at $8000; the SAM-family CoCos load Color BASIC at $A000 and Extended Color BASIC at $8000. Our
    // firmware goes in the lowest socket, and every other socket gets a filler of its size.
    const bas = profile.roms.find((r) => r.id === 'bas' || r.id === 'basic');
    const wide = bas.size === 0x8000;
    const machineRoms = {};
    for (const r of profile.roms) {
      machineRoms[r.id] = r === bas ? (wide ? romImage(fw.asm, 0x8000, 0x8000, 0x12) : fw.rom) : new Uint8Array(r.size).fill(0x12);
    }
    return {
      caseId, work,
      label: `${profileId} ssc${caseId === 'int3' ? ' (INT3)' : ''}`, system: profile.mame, seconds: 4,
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: fw.haltPc, fw,
      instructions: 100000,
      install: () => {
        fs.mkdirSync(work, { recursive: true });
        // the machine's own ROMs: ours stand in for BASIC, under the files MAME's driver asks for
        writeRoms(work, profile.mame, Object.fromEntries(profile.roms.map((r) => [r.files[0], machineRoms[r.id]])));
        // the Pak's own romset, under MAME's names (coco_ssc.cpp ROM_START)
        writeRoms(work, 'coco_ssc', { 'pic-7040-510.bin': pic, 'sp0256-al2.bin': sp });
      },
      get args() { return ['-ext', 'ssc']; },
      machine: (config = {}) => {
        const m = Emu.createMachine(profileId, Object.assign({ mameCompat: true }, config));
        m.setRoms(Object.fromEntries(profile.roms.map((r) => [r.id, machineRoms[r.id]])));
        m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: pic, sp0256Rom: sp }));
        m.reset(true);
        return m;
      },
    };
  },
  firmware, SSC_ROM_OUT,
};
