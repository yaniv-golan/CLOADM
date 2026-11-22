/*
 * Which machine family a piece of media is for, from the media itself:
 *  - binaries: a DragonDOS header ($55 … $AA) means Dragon; DECB segments ($00 len addr … $FF) mean CoCo;
 *  - disk images: a VDK header, or a DragonDOS directory track (track 20, sector 1 ends with the track and
 *    sector counts and their complements), means Dragon; an RS-DOS layout (track 17: a FAT of 68 granule
 *    entries in sector 2, directory entries from sector 3) means CoCo;
 *  - tapes: .c10 / .k7 are MC-10 / Alice tapes; Dragon and CoCo tapes share one format, so a .cas file
 *    says nothing about which of the two it is for;
 *  - cartridges: .dgn is a Dragon cartridge, .ccc a CoCo one; other ROM images fit both.
 * Returns { kind, family: 'dragon' | 'coco' | 'mc10' | null, format, reason }.
 */
import { formats } from './formats.js';
import { detectDiskFormat } from './disk.js';

const SECTOR = 256, SPT = 18;
const ext = (name) => (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';

// the family a model belongs to, for matching media
export function machineFamily(profile) {
  if (profile.family === 'mc10') return 'mc10';
  return profile.keyboard === 'dragon' ? 'dragon' : 'coco';
}
// the binary file format a model loads programs from: 'dragondos' for the Dragons, 'decb' for the CoCos, null for the MC-10
// and Alice (they load .c10 tapes; a program for them travels in a DragonDOS-style header only for this project's own
// loader). The 200-E has the Dragon's file format, though machineFamily counts it with the CoCos by its keyboard.
export function binaryFormat(profile) {
  if (profile.family === 'mc10') return null;
  return profile.keyboard === 'dragon' || profile.keyboard === 'dragon200e' ? 'dragondos' : 'decb';
}
export const FAMILY_NAMES = { dragon: 'Dragon', coco: 'CoCo', mc10: 'MC-10' };

// a raw disk image (after any header): DragonDOS or RS-DOS, by their directory tracks
export function diskLayout(img) {
  const sector = (t, s) => img.subarray((t * SPT + s - 1) * SECTOR, (t * SPT + s) * SECTOR);
  if (img.length >= (20 * SPT + 1) * SECTOR) {
    const b = sector(20, 1);
    const tracks = b[0xFC], spt = b[0xFD];
    if ((tracks === 40 || tracks === 80 || tracks === 35) && (spt === 18 || spt === 36) && b[0xFE] === (~tracks & 0xFF) && b[0xFF] === (~spt & 0xFF)) return 'dragondos';
  }
  if (img.length >= (17 * SPT + 4) * SECTOR) {
    const fat = sector(17, 2).subarray(0, 68);
    const fatOk = fat.every((v) => v === 0xFF || v <= 0x43 || (v >= 0xC0 && v <= 0xC9));
    const dir = sector(17, 3);
    let entries = 0, ok = true;
    for (let i = 0; i < SECTOR; i += 32) {
      const e = dir.subarray(i, i + 32);
      if (e[0] === 0xFF) break;
      if (e[0] === 0x00) continue;
      // name and extension in printable ASCII, file type 0-3, ASCII flag $00/$FF, first granule in range
      if (![...e.subarray(0, 11)].every((c) => c >= 0x20 && c < 0x7F) || e[11] > 3 || (e[12] !== 0 && e[12] !== 0xFF) || e[13] > 0x43) { ok = false; break; }
      entries++;
    }
    if (fatOk && ok && (entries > 0 || fat.every((v) => v === 0xFF))) return 'rsdos';
  }
  return null;
}

export function detectMedia(name, bytes) {
  const e = ext(name);
  // a disk: by its extension, or a VDK by its signature; diskFormat is what the drive will mount (detectDiskFormat)
  const diskFormat = detectDiskFormat(bytes, name);
  if (['vdk', 'dsk', 'jvc', 'os9', 'dmk'].includes(e) || diskFormat === 'vdk') {
    if (diskFormat === 'vdk') return { kind: 'disk', diskFormat, family: 'dragon', format: 'VDK disk', reason: 'VDK images are Dragon disks' };
    const header = diskFormat === 'dmk' ? 0 : bytes.length % SECTOR;         // JVC: a short header makes the size odd
    const layout = diskLayout(bytes.subarray(header));
    if (layout === 'dragondos') return { kind: 'disk', diskFormat, family: 'dragon', format: 'DragonDOS disk', reason: 'it has a DragonDOS directory track' };
    if (layout === 'rsdos') return { kind: 'disk', diskFormat, family: 'coco', format: 'RS-DOS disk', reason: 'it has an RS-DOS directory track' };
    return { kind: 'disk', diskFormat, family: null, format: 'disk image', reason: 'no DragonDOS or RS-DOS directory found' };
  }
  if (e === 'c10' || e === 'k7') return { kind: 'cas', family: 'mc10', format: 'MC-10 tape', reason: `.${e} tapes are for the MC-10 and Alice` };
  const d = formats.identify(name, bytes);
  if (d.kind === 'cart') {
    if (e === 'dgn') return { kind: 'cart', family: 'dragon', format: 'Dragon cartridge', reason: '.dgn is a Dragon cartridge' };
    if (e === 'ccc') return { kind: 'cart', family: 'coco', format: 'CoCo cartridge', reason: '.ccc is a CoCo cartridge' };
    return { kind: 'cart', family: null, format: 'cartridge', reason: '' };
  }
  if (d.kind === 'binary' && !d.basic) {
    if (bytes[0] === 0x55) return { kind: 'binary', family: 'dragon', format: 'DragonDOS binary', reason: '' };
    if (bytes[0] === 0x00) return { kind: 'binary', family: 'coco', format: 'DECB binary', reason: '' };
  }
  return { kind: d.kind, family: null, format: d.format || d.kind, reason: '' };
}
