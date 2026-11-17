/*
 * NitrOS-9 boot disks: what an image is, from its own bytes (pure functions, no machine).
 *
 *   inspectOs9Disk(bytes) -> { os9, label, cpu, boot, reason }
 *     os9    the image has an OS-9 LSN 0 and root directory (RBF's layout, NitrOS-9 defs/rbf.d)
 *     label  the volume name (DD.NAM)
 *     cpu    '6309' | '6809' | null: the CPU the boot file's Init module names ("NitrOS-9/6309 Level 2", printed by
 *            level1/modules/init.asm:96, which writes "NitrOS-9/" followed by the CPU), null when the image doesn't say
 *     boot   'becker' | 'drivewire' (another DriveWire link: the bit-banger, an Arduino) | 'floppy' | 'other' | null
 *            how its boot track's Boot module reaches the disk (null: no boot track at LSN 612)
 *     reason null when it boots over the Becker port, else why not, for the user
 *   checkNitros9DriveWire(bytes) -> the inspectOs9Disk result, or throws Os9ImageError with that reason
 *
 * Sources (tag v3.3.0 of github.com/nitros9project/nitros9):
 *   defs/rbf.d                LSN 0: DD.TOT $00 (3), DD.MAP $04 (2), DD.BIT $06 (2), DD.DIR $08 (3), DD.FMT $10,
 *                             DD.SPT $11 (2), DD.BT $15 (3), DD.BSZ $18 (2), DD.NAM $1F (32, last char | $80);
 *                             a file descriptor's FD.ATT $00 has DIR. = $80 for a directory
 *   defs/os9.d                module header: M$ID $87CD, M$Size $02, M$Name $04; a device descriptor's M$PDev $0B
 *   level1/coco1/modules/rel.asm   the boot track (track 34, LSN 612-629 on a DriveWire disk) starts "OS" and is
 *                             entered at $2602
 *   level1/modules/dwread.asm:76, 79   the Becker build's DriveWire reads poll $FF41 and read $FF42 (the boot track's
 *                             Boot module includes it); the bit-banger and Arduino builds don't touch them (their DD
 *                             still names the DriveWire driver, rbdw)
 *   level1/modules/boot_1773.asm   the floppy booter (rb1773 is the floppy driver; DD's M$PDev names it)
 *   level2/coco3/bootfiles/makefile   the headless builds leave VTIO (screen and keyboard) out of the boot file
 */

export class Os9ImageError extends Error {}

export const BOOT_LSN = 612;            // track 34 of 18-sector tracks: where REL, Boot and Krn live
export const BOOT_SECTORS = 18;
const SECTOR = 256;

// where to get the official images (the NitrOS-9 project's releases; CLOADM never hosts or fetches them)
export const NITROS9_RELEASES = 'https://github.com/nitros9project/nitros9/releases';

const u16 = (b, a) => (b[a] << 8) | b[a + 1];
const u24 = (b, a) => (b[a] << 16) | (b[a + 1] << 8) | b[a + 2];

// an OS-9 name (high bit set on the last character) at a, within [a, end)
function os9Name(b, a, end) {
  let s = '';
  for (let i = a; i < end && i < a + 64; i++) {
    s += String.fromCharCode(b[i] & 0x7F);
    if (b[i] & 0x80) return s;
  }
  return null;
}

// the modules in b[start, end): [{ name, at, size }] (stops at the first byte that isn't a module header)
export function os9Modules(b, start, end) {
  const out = [];
  let a = start;
  while (a + 9 <= end && b[a] === 0x87 && b[a + 1] === 0xCD) {
    const size = u16(b, a + 2), name = os9Name(b, a + u16(b, a + 4), Math.min(end, a + size));
    if (size < 9 || a + size > end || name === null) break;
    out.push({ name, at: a, size });
    a += size;
  }
  return out;
}

// does the code in b[a, a + n) address one of these I/O locations (an extended operand $FFxx)?
const touches = (b, a, n, regs) => {
  for (let i = a; i < a + n - 1; i++) if (b[i] === 0xFF && regs.includes(b[i + 1])) return true;
  return false;
};
const BECKER = [0x41, 0x42];

export function inspectOs9Disk(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const out = { os9: false, label: null, cpu: null, boot: null, reason: null };
  const not = (why) => Object.assign(out, { reason: why });
  if (!b.length) return not('The file is empty.');
  if (b.length % SECTOR) return not(`It isn't a disk image of whole 256-byte sectors (${b.length} bytes).`);
  const sectors = b.length / SECTOR;
  const tot = u24(b, 0x00), map = u16(b, 0x04), bit = u16(b, 0x06), dir = u24(b, 0x08), spt = u16(b, 0x11);
  // LSN 0 as RBF writes it: a size, an allocation map of at least one byte, a power-of-two cluster size, sectors
  // per track, and a root directory inside the image whose descriptor says "directory"
  const lsn0 = tot > 0 && map > 0 && bit > 0 && (bit & (bit - 1)) === 0 && spt > 0 && dir > 0 && dir < sectors &&
    (b[dir * SECTOR] & 0x80) !== 0;
  if (!lsn0) return not('It isn\'t an OS-9 disk: its first sector has no OS-9 volume information.');
  out.os9 = true;
  out.label = (os9Name(b, 0x1F, 0x3F) || '').replace(/\0/g, '').trim() || null;
  // the boot file (DD.BT, DD.BSZ): its Init module names the CPU, its DD descriptor the boot driver
  const bt = u24(b, 0x15), bsz = u16(b, 0x18);
  const mods = bt && bsz && (bt + Math.ceil(bsz / SECTOR)) <= sectors ? os9Modules(b, bt * SECTOR, bt * SECTOR + bsz) : [];
  const init = mods.find((m) => m.name.toLowerCase() === 'init');
  if (init) {
    const text = String.fromCharCode(...b.subarray(init.at, init.at + init.size));
    out.cpu = /NitrOS-9\/6309/.test(text) ? '6309' : /NitrOS-9\/6809/.test(text) ? '6809' : null;
  }
  const dd = mods.find((m) => m.name === 'DD');
  const ddDriver = dd ? os9Name(b, dd.at + u16(b, dd.at + 0x0B), dd.at + dd.size) : null;
  // the boot track: "OS" at LSN 612, then REL, Boot and Krn
  if (sectors < BOOT_LSN + BOOT_SECTORS || b[BOOT_LSN * SECTOR] !== 0x4F || b[BOOT_LSN * SECTOR + 1] !== 0x53) {
    if (ddDriver && ddDriver.toLowerCase() === 'rb1773') { out.boot = 'floppy'; return not('This is a NitrOS-9 floppy disk image: it boots from a floppy drive, not over DriveWire. Use the DriveWire image of the release (its name ends in _becker.dsk).'); }
    return not('This OS-9 disk has no boot track, so it can\'t be booted (it may be a data disk).');
  }
  const track = BOOT_LSN * SECTOR, trackEnd = track + BOOT_SECTORS * SECTOR;
  let first = track + 2;
  while (first < trackEnd - 1 && !(b[first] === 0x87 && b[first + 1] === 0xCD)) first++;
  const boot = os9Modules(b, first, trackEnd).find((m) => m.name === 'Boot');
  if (!boot) { out.boot = 'other'; return not('This disk\'s boot track has no NitrOS-9 Boot module.'); }
  const driver = (ddDriver || '').toLowerCase();
  out.boot = touches(b, boot.at, boot.size, BECKER) ? 'becker' : driver === 'rbdw' ? 'drivewire' : driver === 'rb1773' ? 'floppy' : 'other';
  if (out.boot === 'drivewire') return not('This NitrOS-9 image talks DriveWire over a serial cable (the bit-banger or an Arduino), not the Becker port CLOADM serves. Use the image whose name ends in _becker.dsk.');
  if (out.boot === 'floppy') return not('This is a NitrOS-9 floppy disk image: it boots from a floppy drive, not over DriveWire. Use the DriveWire image of the release (its name ends in _becker.dsk).');
  if (out.boot === 'other') return not('This NitrOS-9 image boots from another device (not DriveWire on the Becker port). Use the image whose name ends in _becker.dsk.');
  // a "headless" build has no VTIO (the screen and keyboard driver): its console is a DriveWire virtual window
  if (!mods.some((m) => m.name === 'VTIO')) return not('This is a headless NitrOS-9 build: its console is a DriveWire terminal, not the CoCo 3\'s screen and keyboard. Use the image whose name ends in _becker.dsk (not _becker_headless.dsk).');
  return out;
}

// the inspection of an image that boots over the Becker port, or Os9ImageError with the reason
export function checkNitros9DriveWire(bytes) {
  const r = inspectOs9Disk(bytes);
  if (r.reason) throw new Os9ImageError(r.reason);
  return r;
}
