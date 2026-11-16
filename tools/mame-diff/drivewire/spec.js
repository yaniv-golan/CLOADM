// DriveWire over the Becker port: the server set-up dw.asm expects, and our machine running it.
// run-dw.js runs the same firmware in MAME (coco_dwsock, a TCP link to a server built here) and compares.
const fs = require('fs'), path = require('path');
const { loadEmu, assembleFile, romImage } = require('../lib/firmware');
const { DriveWireServer } = require('../../../js/drivewire/server.js');
const { MemoryMediaStore } = require('../../../js/host/media-store-memory.js');

const LOG = 0x6000, LOGEND = 0x5FF0, DONE = 0x5FF2;
const CLOCK = new Date(2026, 10, 14, 12, 34, 56);   // TIME answers 126, 11, 14, 12, 34, 56

// the store and drives: drive 0 an 8-sector image, drive 1 write protected, drive 2 two sectors; a named object
// of 300 bytes (its second sector is part zeroes)
async function fixture() {
  const store = new MemoryMediaStore({ clock: () => 0 });
  const fill = (n, f) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xFF);
  await store.write('disks/disk0.dsk', fill(8 * 256, (i) => (i >> 8) * 31 + (i & 0xFF) * 3));
  await store.write('disks/disk1.dsk', fill(2 * 256, () => 0xE5));
  await store.write('disks/disk2.dsk', fill(2 * 256, () => 0x11));
  await store.write('drivewire/NAMED.DAT', fill(300, (i) => (i < 12 ? 'NAMED OBJECT'.charCodeAt(i) : i)));
  const server = new DriveWireServer({ store, clock: () => CLOCK });
  await server.mount(0, 'disks/disk0.dsk');
  await server.mount(1, 'disks/disk1.dsk', { writeProtected: true });
  await server.mount(2, 'disks/disk2.dsk');
  // what leaves the server: the printout, and what the guest wrote on each channel
  const out = { printed: [], channels: [] };
  server.onPrint = (b) => out.printed.push(...b);
  // the host on channel 3: "HELLO" when it opens; each byte echoed with its case changed; 'q' closes it
  server.onChannelOpen = (ch) => { if (ch === 3) server.channelSend(3, [...'HELLO'].map((c) => c.charCodeAt(0))); };
  server.onChannelData = (ch, bytes) => {
    for (const b of bytes) {
      out.channels.push(ch, b);
      if (ch !== 3) continue;
      if (b === 0x71) server.closeChannel(3); else server.channelSend(3, [b ^ 0x20]);
    }
  };
  return { store, server, out };
}
// what the run left behind: the log, the disks, the printout and the channel bytes
async function outcome(readMem, store, out) {
  const end = (readMem(LOGEND) << 8) | readMem(LOGEND + 1);
  const log = [];
  for (let a = LOG; a < end && a < LOG + 0x1000; a++) log.push(readMem(a));
  const files = {};
  for (const e of await store.list()) files[e.name] = [...await store.read(e.name)];
  return { done: readMem(DONE) === 0xFF, log, files, printed: out.printed.slice(), channels: out.channels.slice() };
}

function firmware(profileId) {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const coco3 = profile.family === 'coco3';
  let src = fs.readFileSync(path.join(__dirname, 'dw.asm'), 'utf8');
  if (coco3) src = src.replace('ORG     $BFF2', 'ORG     $FFF2');
  const asm = Emu.assemble(src, '6809');
  if (!asm.ok) throw new Error('dw.asm: ' + asm.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const image = romImage(asm, 0x8000, coco3 ? 0x8000 : 0x4000, 0x12);
  const slots = {}, files = {};
  for (const sl of profile.roms) {
    slots[sl.id] = coco3 ? image : image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
    files[sl.files[0]] = slots[sl.id];
  }
  return { asm, slots, files, haltPc: asm.symbols.get('HALT'), system: profile.mame };
}

// our machine, Becker port on, running dw.asm against the fixture's server until HALT
async function runOurs(profileId, { frames = 2000, onMachine = null } = {}) {
  const Emu = loadEmu();
  const fw = firmware(profileId);
  const { store, server, out } = await fixture();
  const m = Emu.createMachine(profileId, { becker: true });
  m.setRoms(fw.slots);
  m.becker.attach(server);
  m.reset(true);
  if (onMachine) onMachine(m);
  for (let f = 0; f < frames && m.cpu.pc !== fw.haltPc; f++) while (!m.runFrame()) await m.stall;
  return Object.assign(await outcome((a) => m.read(a), store, out), { machine: m, server });
}

module.exports = { LOG, LOGEND, DONE, CLOCK, fixture, outcome, firmware, runOurs };
