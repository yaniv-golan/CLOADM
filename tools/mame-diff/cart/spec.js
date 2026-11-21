// Comparison spec for the cartridges (run.js coco --cart <setup> [--audio]): boot.asm replaces
// the BASIC ROMs and jumps to the cartridge; the cartridge firmware (<setup>.asm, our own code) is the cartridge
// ROM. Each setup names MAME's slot options and media and builds the same cartridge for our machine.
//   banked       banked ROM cartridge, 128K image (an RPK with PCB "paged16k" makes MAME pick banked_16k)
//   bankedshort  the same with a 40K image: MAME repeats it to fill the 128K region
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { loadEmu, assembleFile, romImage, writeRoms, writeProfileRoms } = require('../lib/firmware');
const { REGS } = require('../lib/regs');
const { SN76489 } = require('./chips.js');

const RAMSRC = 0xC800, RAMBASE = 0x1000;
// the machines each setup runs on: MAME 0.264 offers the Games Master, the Orchestra-90 and the Multi-Pak on all of
// them, the banked boards (banked_16k, picked through an RPK) only on the CoCos (coco_cart_add_basic_devices; the
// Dragons' list, dragon_cart_add_basic_devices, has no banked board)
const PROFILES = ['coco', 'coco3', 'dragon64', 'dragon32'];
const COCOS = ['coco', 'coco3'];
const dragon = (profile) => profile.family !== 'coco3' && /^dragon/.test(profile.id);

// a cartridge firmware: the code at $C000 plus its RAM code (assembled at $1000) placed at RAMSRC
function firmware(file) {
  const asm = assembleFile(path.join(__dirname, file), '6809');
  const ramEnd = asm.symbols.get('RAMEND');
  const rom = romImage(asm, 0xC000, 0x4000, 0xFF);
  if (asm.segments.some((s) => s.addr >= 0xC000 && s.addr + s.data.length > RAMSRC)) throw new Error(`${file}: ROM code reaches RAMSRC`);
  const ram = romImage(asm, RAMBASE, ramEnd - RAMBASE, 0x00);
  if (RAMSRC - 0xC000 + ram.length > 0x4000) throw new Error(`${file}: RAM code too long`);
  rom.set(ram, RAMSRC - 0xC000);
  return { asm, rom, haltPc: asm.symbols.get('HALT') };
}
// bank k (k >= 1) of a banked image: a pattern that differs in every bank and every byte position
function bankPattern(k) {
  const b = new Uint8Array(0x4000);
  for (let i = 0; i < 0x4000; i++) b[i] = (k * 0x11 + i * 7 + (i >> 8) * 3) & 0xFF;
  return b;
}
function bankedImage(fw, size) {
  const img = new Uint8Array(size);
  for (let k = 0; k * 0x4000 < size; k++) img.set((k ? bankPattern(k) : fw.rom).subarray(0, Math.min(0x4000, size - k * 0x4000)), k * 0x4000);
  return img;
}
// an RPK (zip): layout.xml naming the PCB type, and the ROM
function writeRpk(work, name, pcb, bytes) {
  const dir = path.join(work, `${name}.d`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rom.bin'), bytes);
  fs.writeFileSync(path.join(dir, 'layout.xml'), `<?xml version="1.0" encoding="utf-8"?>
<romset version="1.0">
  <resources><rom id="rom" file="rom.bin"/></resources>
  <configuration><pcb type="${pcb}"><socket id="rom" uses="rom"/></pcb></configuration>
</romset>
`);
  const file = path.join(work, `${name}.rpk`);
  try { fs.unlinkSync(file); } catch (e) { /* none */ }
  cp.execFileSync('zip', ['-q', '-j', file, path.join(dir, 'layout.xml'), path.join(dir, 'rom.bin')]);
  return file;
}

const SETUPS = {
  banked: { profiles: COCOS, file: 'banked.asm', seconds: 4, instructions: 4000, size: 0x20000 },        // HALT at 3,208
  bankedshort: { profiles: COCOS, file: 'banked.asm', seconds: 4, instructions: 4000, size: 0xA000 },
  // Games Master: MAME loads a plain image into the cartridge's 128K region (-ext gmc -cart)
  gmc: {
    profiles: PROFILES, file: 'gmc.asm', seconds: 6, instructions: 440000, size: 0x10000,   // HALT at 439,801
    // the SN76489A's stream (4 MHz / 2) to its own speaker at gain 1.0, both channels
    audio: {
      seconds: 6,
      devices: [':ext:gmc:gmc_psg'],                  // what MAME must have built for the recording to mean anything
      capture(dev, record) {
        const w = dev.writeIO.bind(dev);
        dev.writeIO = (a, v) => { if (a === 0xFF41) record(dev.clock.now(), { data: v }); w(a, v); };
      },
      render(events, n, { resample, indexAt, chipStream }) {
        const rate = 2000000;
        for (const e of events) e.index = indexAt(rate, e.time);
        const psg = new SN76489();
        const count = Math.ceil(n * rate / 48000) + 4096;
        const s = chipStream({ write: (e) => psg.write(e.data), sample: () => psg.sample() / 32768 }, rate, events, count);
        const out = resample((k) => s[Math.min(k, count - 1)], rate, n);
        return [out, out];
      },
    },
    build(fw) { return { image: bankedImage(fw, this.size) }; },
    mame(work, b) { const f = path.join(work, 'gmc.rom'); fs.writeFileSync(f, b.image); return ['-ext', 'gmc', '-cart', f]; },
    device(Emu, b) { return new Emu.devices.gmc(b.image); },
  },
  // Orchestra-90: our firmware is the cartridge's own ROM (-ext orch90, the ROM under its MAME file name)
  orch90: {
    profiles: PROFILES, file: 'orch90.asm', seconds: 4, instructions: 200000,    // HALT at 194,383
    // two 8-bit DACs (192 kHz streams, range -1..1), the left one to the left speaker and the right one to the right,
    // each at gain 0.5
    audio: {
      seconds: 4,
      devices: [':ext:orch90'],
      capture(dev, record) {
        const w = dev.writeIO.bind(dev);
        dev.writeIO = (a, v) => { if (a === 0xFF7A || a === 0xFF7B) record(dev.clock.now(), { side: a & 1, data: v }); return w(a, v); };
      },
      render(events, n, { resample, indexAt, chipStream }) {
        const rate = 192000, count = Math.ceil(n * rate / 48000) + 64;
        return [0, 1].map((side) => {
          const evs = events.filter((e) => e.side === side).map((e) => Object.assign({}, e, { index: indexAt(rate, e.time) }));
          let code = 0;
          const s = chipStream({ write: (e) => { code = e.data; }, sample: () => Math.fround(-1 + Math.fround(code / 256) * 2) }, rate, evs, count);
          const r = resample((k) => s[Math.min(k, count - 1)], rate, n);
          return r.map((x) => Math.fround(x * 0.5));
        });
      },
    },
    build(fw) { return { rom: fw.rom.slice(0, 0x2000) }; },
    installRoms(work, b) { writeRoms(work, 'coco_orch90', { 'orchestra 90,1984,26 - 3143,tandy.rom': b.rom }); },
    mame() { return ['-ext', 'orch90']; },
    device(Emu, b) { return new Emu.devices.orch90(b.rom); },
  },
  // Multi-Pak: slot 1 a banked ROM cartridge (RPK; on the Dragons, whose Multi-Pak offers no banked board, a Program
  // Pak with the image's first 32K, which ignores the bank writes), slot 2 an Orchestra-90, slot 3 empty, slot 4 a
  // Games Master with the firmware (MAME: cart2-cart5 are slots 1-4)
  multi: {
    profiles: PROFILES, file: 'multi.asm', seconds: 4, instructions: 40000,      // HALT at 36,246
    audio: {
      seconds: 4,
      devices: [':ext:multi:slot2:orch90', ':ext:multi:slot4:gmc:gmc_psg'],
      capture(dev, record) {
        const gmc = dev.slots[3], orch = dev.slots[1];
        const w = gmc.writeIO.bind(gmc);
        gmc.writeIO = (a, v) => { if (a === 0xFF41) record(gmc.clock.now(), { chip: 'psg', data: v }); w(a, v); };
        const o = orch.writeIO.bind(orch);
        orch.writeIO = (a, v) => { if (a === 0xFF7A || a === 0xFF7B) record(orch.clock.now(), { chip: 'dac', side: a & 1, data: v }); return o(a, v); };
      },
      render(events, n, h) {
        const psg = SETUPS.gmc.audio.render(events.filter((e) => e.chip === 'psg'), n, h);
        const dac = SETUPS.orch90.audio.render(events.filter((e) => e.chip === 'dac'), n, h);
        return [0, 1].map((c) => psg[c].map((x, i) => Math.fround(x + dac[c][i])));
      },
    },
    build(fw) {
      const slot1 = new Uint8Array(0x20000);
      for (let k = 0; k < 8; k++) slot1.set(bankPattern(k + 0x40), k * 0x4000);
      const orch = new Uint8Array(0x2000).map((_, i) => (i * 13 + 0x5A) & 0xFF);
      return { slot1, orch, slot4: bankedImage(fw, 0x10000) };
    },
    installRoms(work, b) { writeRoms(work, 'coco_orch90', { 'orchestra 90,1984,26 - 3143,tandy.rom': b.orch }); },
    mame(work, b, profile) {
      const s4 = path.join(work, 'slot4.rom');
      fs.writeFileSync(s4, b.slot4);
      let slot1 = ['-cart2', writeRpk(work, 'slot1', 'paged16k', b.slot1)];
      if (dragon(profile)) {
        const f = path.join(work, 'slot1.rom');
        fs.writeFileSync(f, b.slot1.subarray(0, 0x8000));
        slot1 = ['-ext:multi:slot1', 'pak', '-cart2', f];
      }
      return ['-ext', 'multi', '-ext:multi:slot2', 'orch90', '-ext:multi:slot3', '', '-ext:multi:slot4', 'gmc',
        ...slot1, '-cart5', s4];
    },
    device(Emu, b, profile) {
      const slot1 = dragon(profile) ? new Emu.devices.rom(b.slot1.slice(0, 0x8000)) : new Emu.devices.banked(b.slot1);
      return new Emu.devices.multi([slot1, new Emu.devices.orch90(b.orch), null, new Emu.devices.gmc(b.slot4)]);
    },
  },
};
for (const s of ['banked', 'bankedshort']) {
  Object.assign(SETUPS[s], {
    build(fw) { return { image: bankedImage(fw, this.size) }; },
    mame(work, b) { return ['-cart', writeRpk(work, 'cart', 'paged16k', b.image)]; },
    device(Emu, b) { return new Emu.devices.banked(b.image); },
  });
}

function slotData(profile, img) {
  const out = {};
  for (const sl of profile.roms) out[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  return out;
}

module.exports = {
  SETUPS, firmware, bankedImage, writeRpk,
  trace(profileId, { setup: id } = {}) {
    const Emu = loadEmu(), profile = Emu.profiles[profileId];
    const setup = SETUPS[id];
    if (!setup || !setup.profiles.includes(profileId)) throw new Error(`no cartridge comparison ${id || ''} for ${profileId} (have: ${Object.entries(SETUPS).map(([k, v]) => `${k} on ${v.profiles.join('/')}`).join(', ')})`);
    const work = `/tmp/mame-diff/${profileId}-${id}`;
    const coco3 = profile.family === 'coco3';
    const boot = coco3 ? romImage(assembleFile(path.join(__dirname, 'boot3.asm'), '6809'), 0x8000, 0x8000, 0x12)
      : romImage(assembleFile(path.join(__dirname, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12);
    const fw = firmware(setup.file);
    const built = setup.build(fw);
    const slots = slotData(profile, boot);
    const files = {};
    for (const sl of profile.roms) for (const f of sl.files) files[f] = slots[sl.id];
    return {
      label: `${profileId} ${id}`, system: profile.mame, work, seconds: setup.seconds,
      regs: REGS, waitOps: ['CWAI', 'SYNC'], haltPc: fw.haltPc, setup, fw, built,
      instructions: setup.instructions,
      install: () => {
        fs.mkdirSync(work, { recursive: true });
        writeProfileRoms(work, profile, slots);
        if (setup.installRoms) setup.installRoms(work, built);
      },
      get args() { return setup.mame(work, built, profile); },
      machine: (config = {}) => {
        const m = Emu.createMachine(profileId, Object.assign({ mameCompat: true }, config));
        m.setRoms(slots);
        m.insertCartridge(setup.device(Emu, built, profile));
        m.reset(true);
        return m;
      },
    };
  },
};
