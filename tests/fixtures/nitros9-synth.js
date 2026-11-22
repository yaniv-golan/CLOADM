// A SYNTHETIC OS-9 floppy image that inspectOs9Disk (js/media/os9.js) accepts as a NitrOS-9 floppy boot disk.
// Built here from the OS-9 RBF volume layout and the OS-9 module header - not from any real disk image, and with no
// code from any real system: the modules are named for what the detection looks for and carry filler bytes.
//
// It exists so a test can exercise the floppy-boot path WITHOUT the user's NitrOS-9 image, which may not be
// committed. It is an image of a disk, not a ROM, and it holds no system code.
//
// The layout the detection reads (js/media/os9.js, inspectOs9Disk):
//   LSN0       DD.TOT (24-bit), DD.MAP, DD.BIT (a power of two), DD.DIR (inside the image, and the root directory's
//              first entry has bit 7 set), DD.SPT, DD.SID, DD.BT (24-bit) / DD.BSZ (16-bit): the BOOT FILE
//   DD.BT      the boot file: an OS-9 module list (Init names the CPU, DD names the boot driver, VTIO the console)
//   track 34   the boot track: "OS", then a Boot module and Krn
const SECTOR = 256, SPT = 18, BOOT_TRACK = 34, TRACKS = 40, SIDES = 1;

// an OS-9 module header: $87 $CD, size (16-bit), name offset (16-bit), then the name with its last character's high
// bit set. The body is filler. `find` writes a second copy of the name where a reader looks for it.
function module(name, size, { find = null } = {}) {
  const b = new Uint8Array(size);
  const nb = [...name].map((c, i) => (i === name.length - 1 ? c.charCodeAt(0) | 0x80 : c.charCodeAt()));
  b[0] = 0x87; b[1] = 0xCD;
  b[2] = size >> 8; b[3] = size & 255;
  b[4] = 0; b[5] = 9;                  // the name's offset
  b.set(nb, 9);
  if (find != null) b.set(nb, find);
  return b;
}

export function synthNitrOs9Floppy({ cpu = '6809' } = {}) {
  const total = TRACKS * SIDES * SPT;
  const b = new Uint8Array(total * SECTOR);
  const dirLsn = 1, bootFileLsn = 2;
  // LSN0: the OS-9 volume descriptor
  b[0] = (total >> 16) & 255; b[1] = (total >> 8) & 255; b[2] = total & 255;   // DD.TOT (24-bit)
  b[4] = 0; b[5] = 1;                  // DD.MAP: one byte of allocation map
  b[6] = 0; b[7] = 8;                  // DD.BIT: 8 sectors per cluster (a power of two)
  b[8] = 0; b[9] = 0; b[10] = dirLsn;  // DD.DIR
  b[0x0F] = TRACKS;                    // DD.TKS
  b[0x10] = SIDES === 2 ? 1 : 0;       // DD.SID
  b[0x11] = 0; b[0x12] = SPT;          // DD.SPT
  // DD.BT / DD.BSZ: the boot FILE (the detection reads its module list: Init, DD, VTIO)
  const init = module('init', 0x100);
  const cpuText = Buffer.from(`NitrOS-9/${cpu}   CoCo 3`);
  init.set(cpuText.subarray(0, Math.min(cpuText.length, 0x60)), 0x20);
  const dd = module('DD', 0x100);
  dd[0x0B] = 0; dd[0x0C] = 0x20;       // the driver's name is at dd + 0x20
  // (the driver name is "rb1773", as the real image's DD module holds it - os9.js compares it without a dot)
  dd.set([...'rb1773'].map((c, i, a) => (i === a.length - 1 ? c.charCodeAt(0) | 0x80 : c.charCodeAt())), 0x20);
  const vtio = module('VTIO', 0x80);
  const bootFile = Buffer.concat([init, dd, vtio]);
  b.set(bootFile, bootFileLsn * SECTOR);
  b[0x15] = (bootFileLsn >> 16) & 255; b[0x16] = (bootFileLsn >> 8) & 255; b[0x17] = bootFileLsn & 255;
  b[0x18] = (bootFile.length >> 8) & 255; b[0x19] = bootFile.length & 255;
  // the volume label at $1F, an OS-9 name (high bit on its last character)
  b.set([...'CLOADM'].map((c, i, a) => (i === a.length - 1 ? c.charCodeAt(0) | 0x80 : c.charCodeAt())), 0x1F);
  // DD.DIR's first entry: a file descriptor with the "directory" attribute
  b.set([0x80], dirLsn * SECTOR);
  // the BOOT TRACK (track 34, side 0): "OS", then Boot and Krn
  const t = BOOT_TRACK * SPT * SIDES * SECTOR;
  b[t] = 0x4F; b[t + 1] = 0x53;        // "OS"
  b.set(Buffer.concat([module('Boot', 0x120), module('Krn', 0x100)]), t + 2);
  return b;
}
