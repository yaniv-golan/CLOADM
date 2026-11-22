// disk-read.mjs - a Dragon 64 reads two sectors of a VDK disk through the disk controller's registers, from Node, with the
// public modules only (no test helper, no browser, no DOS ROM).
//
//   node docs/examples/disk-read.mjs
//
// It runs from any directory (it finds the repository from its own path; set CLOADM_DIR=/path/to/cloadm to use it from a copy
// elsewhere). What it does, each step checked:
//   1. builds a VDK disk image in memory with blankDisk and fills every sector with a known pattern (diskGeometry says where
//      each sector sits in the file)
//   2. makes a Dragon 64 Session on the built-in firmware, plugs the Dragon disk controller into the cartridge port WITHOUT a
//      DOS ROM (new devices.dragonfdc(): the cartridge space just reads 00) and mounts the disk in drive 0
//   3. assembles docs/examples/diskread.asm and runs it: the guest drives the WD2797 itself through $FF40-$FF43
//   4. waits for the guest's done byte in RAM, then compares the bytes it read with the sectors it should have read
//   5. prints the elapsed frames and CPU cycles as one JSON line
// docs/automation.md ("Reading a disk with no DOS ROM") explains it; tests/disk-read-example.test.js runs it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CLOADM_DIR ? pathToFileURL(resolve(process.env.CLOADM_DIR) + '/') : new URL('../../', import.meta.url);
const { Session, assemble, blankDisk, diskGeometry, devices } = await import(new URL('js/emu.js', root));

const DONE = 0x3100, STAT1 = 0x3101, STAT2 = 0x3102, END1 = 0x3104, END2 = 0x3106, BUF1 = 0x3200, BUF2 = 0x3300;   // diskread.asm
const fail = (what) => { throw new Error(`disk-read: ${what}`); };
const hex = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');

// 1. a disk: 40 tracks, one side, 18 sectors of 256 bytes, every byte a known function of where it is
const pattern = (track, sector, i) => (track * 53 + sector * 29 + i * 7 + (i >> 3) * 13 + 1) & 0xFF;
const vdk = blankDisk('vdk', 40, 1);
const g = diskGeometry(vdk, 'vdk');
if (g.sectorSize !== 256 || g.sectors !== 18 || g.heads !== 1) fail(`unexpected geometry ${JSON.stringify(g)}`);
for (let track = 0; track < g.tracks; track++) {
  for (let sector = g.firstSector; sector < g.firstSector + g.sectors; sector++) {
    const at = g.headerSize + (track * g.heads * g.sectors + (sector - g.firstSector)) * g.sectorSize;
    for (let i = 0; i < g.sectorSize; i++) vdk[at + i] = pattern(track, sector, i);
  }
}
const sectorBytes = (track, sector) => Uint8Array.from({ length: 256 }, (_, i) => pattern(track, sector, i));

// 2. a machine with a disk controller and no DOS: the controller is a cartridge, and with no ROM given it is registers only
const session = new Session({ welcomeMenu: false });
session.switchMachine('dragon64', {}, { menu: false });
const m = session.machine;
const fdc = new devices.dragonfdc();
m.insertCartridge(fdc);
fdc.mount(0, { bytes: vdk, format: 'vdk', name: 'known.vdk' });

// 3. the guest, assembled from source and run on the built-in firmware
const res = assemble(readFileSync(new URL('docs/examples/diskread.asm', root), 'utf8'), '6809');
if (!res.ok) fail(res.errors.map((e) => e.message).join('; '));
session.runAssembled(res);
if (session.diskController !== fdc || !fdc.drives[0].loaded) fail('running the program took the controller or the disk away');

// 4. wait on a memory byte, whole frames with a bound, then compare what landed in RAM with the sectors
const frame0 = m.frameCount, cycles0 = m.now();
for (let n = 0; session.readByte(DONE) !== 0xA5; n++) { if (n > 600) fail(`the guest never finished (status ${hex(session.readByte(STAT1))}, ${hex(session.readByte(STAT2))})`); session.runFrames(1); }
const frames = m.frameCount - frame0, cycles = m.now() - cycles0;
const word = (a) => (session.readByte(a) << 8) | session.readByte(a + 1);
const reads = [[0, 1, BUF1, STAT1, END1], [2, 5, BUF2, STAT2, END2]].map(([track, sector, at, stat, end]) => {
  const got = Uint8Array.from({ length: 256 }, (_, i) => session.readByte(at + i)), want = sectorBytes(track, sector);
  const status = session.readByte(stat), taken = word(end) - at;
  // status: bit 7 not ready, 4 record not found, 3 CRC error, 2 lost data, 0 busy: none may be set after a good read
  if (status & 0x9D) fail(`track ${track} sector ${sector}: the controller's status is ${hex(status)}`);
  if (taken !== 256) fail(`track ${track} sector ${sector}: the guest took ${taken} bytes, not 256`);
  const bad = got.findIndex((b, i) => b !== want[i]);
  if (bad >= 0) fail(`track ${track} sector ${sector}: byte ${bad} is ${hex(got[bad])}, the disk has ${hex(want[bad])}`);
  return { track, sector, at: hex(at, 4), bytes: got.length, match: true, status: hex(status) };
});

// 5. what happened and how long it took (emulated time: the same on every run)
console.log(JSON.stringify({ reads, frames, cycles }));
