/*
 * ROM identification and the ROM library. CLOADM recognises ROM images by their contents: each dropped
 * file is matched against every model's sockets (js/machines/profiles.js), so one drop sets up every
 * machine it fits.
 *
 * Matching, in order:
 *   1. CRC32 of the whole file against the known-good dumps of every socket (verified);
 *   2. a combined image covering both sockets of a two-socket model (a 32K Dragon 64 dump, a 16K CoCo
 *      BASIC + Extended BASIC), when the CRCs of its two halves are known (verified);
 *   3. the usual file name or an alias of a socket, only when the size is right too (loaded, unrecognised);
 *   4. size alone, only for the machine in use, as are combined images by size (loaded, unrecognised).
 * A file that fits nowhere, has the right name but the wrong size, is empty, or repeats another file is
 * reported and not loaded ('rejected'); one that can't be a ROM image at all (no name match, not a ROM
 * size) is 'ignored'. Entries of kind 'cartridge' (disk-controller ROMs) are stored, never booted.
 *
 * The library stores each image once (by CRC) and, per machine and socket, the CRC it holds.
 */
import { crc32 } from './util.js';

const kb = (n) => (n % 1024 ? `${n} bytes` : `${n / 1024}K`);
const baseName = (name) => name.split(/[\\/]/).pop().toLowerCase();
const names = (s) => s.files.concat(s.aliases || []);
// ROM chips are 2K..64K, a power of two
const romSized = (n) => n >= 2048 && n <= 65536 && (n & (n - 1)) === 0;

// the two sockets of a model in the order a combined image holds them (low address first, bank 0 first).
// A chip the machine reads directly (the 200-E's character generator) is not on the CPU bus and is never
// part of a combined image.
function combinedOrder(p) {
  const bus = p.roms.filter((s) => !s.chip);
  return bus.length === 2 ? [...bus].sort((x, y) => (x.bank - y.bank) || (x.at - y.at)) : null;
}

/*
 * Identify a set of files. files: [{ name, bytes }]; profiles: { id: profile }; current: the machine in use.
 * Returns { files: [{ name, size, crc, result, targets: [{ machine, socket, bytes }], message }] } where
 * result is 'verified', 'loaded-unrecognised' or 'rejected'. Targets are not yet applied.
 */
export function identifyRoms(files, profiles, current = null) {
  const out = [];
  const seen = new Map();                 // crc -> first file name in this drop
  const claimed = new Map();              // "machine/socket" -> file name (unverified claims)
  const all = Object.values(profiles);
  const machines = all.filter((p) => p.kind !== 'cartridge');
  const sizes = [...new Set(machines.flatMap((p) => p.roms.map((s) => s.size)).concat(machines.filter(combinedOrder).map((p) => p.roms[0].size + p.roms[1].size)))].sort((a, b) => a - b);

  for (const f of files) {
    const bytes = f.bytes, name = f.name, size = bytes.length;
    const r = { name, size, crc: size ? crc32(bytes) : null, result: 'rejected', targets: [], message: '' };
    out.push(r);
    if (!size) { r.message = `${name}: empty file`; continue; }
    if (seen.has(r.crc)) { r.message = `${name}: same contents as ${seen.get(r.crc)}, skipped`; continue; }
    seen.set(r.crc, name);

    // 1. whole-file CRC
    for (const p of all) for (const s of p.roms) if (s.crcs.includes(r.crc) && s.size === size) r.targets.push({ machine: p.id, socket: s.id, bytes });
    // 2. combined image with known halves
    if (!r.targets.length) for (const p of all) {
      const order = combinedOrder(p);
      if (!order || order[0].size + order[1].size !== size) continue;
      const a = bytes.slice(0, order[0].size), b = bytes.slice(order[0].size);
      if (order[0].crcs.includes(crc32(a)) && order[1].crcs.includes(crc32(b))) {
        r.targets.push({ machine: p.id, socket: order[0].id, bytes: a }, { machine: p.id, socket: order[1].id, bytes: b });
      }
    }
    if (r.targets.length) { r.result = 'verified'; r.message = `${name}: ${describeTargets(r.targets, profiles)} (recognised)`; continue; }

    // 3. usual file name, right size only
    const n = baseName(name);
    const byName = [];
    for (const p of all) for (const s of p.roms) if (names(s).includes(n)) byName.push({ p, s });
    if (byName.length) {
      const fit = byName.filter(({ s }) => s.size === size);
      if (!fit.length) {
        const want = [...new Set(byName.map(({ s }) => kb(s.size)))].join(' or ');
        r.message = `${name}: named like a ${byName[0].p.name} ${byName[0].s.label} ROM, but it is ${kb(size)} instead of ${want}. Not loaded`;
        continue;
      }
      for (const { p, s } of fit) r.targets.push({ machine: p.id, socket: s.id, bytes });
    }
    // 4. size alone, for the machine in use: a free socket of that size, or a combined image by size
    if (!r.targets.length && current && profiles[current]) {
      const p = profiles[current];
      const bySize = p.roms.filter((s) => !s.chip && s.size === size);   // the character generator is not on the bus
      const free = bySize.find((s) => !claimed.has(`${p.id}/${s.id}`));
      const order = combinedOrder(p);
      if (free) r.targets.push({ machine: p.id, socket: free.id, bytes });
      else if (order && order[0].size + order[1].size === size) {
        r.targets.push({ machine: p.id, socket: order[0].id, bytes: bytes.slice(0, order[0].size) },
          { machine: p.id, socket: order[1].id, bytes: bytes.slice(order[0].size) });
      }
    }
    if (!r.targets.length && !byName.length && !romSized(size)) {
      r.result = 'ignored';
      r.message = `${name}: not a ROM, ignored`;
      continue;
    }
    if (!r.targets.length) {
      r.message = `${name}: ${kb(size)} doesn't match any ROM CLOADM knows` +
        (current && profiles[current] ? ` (the ${profiles[current].name} takes ${socketSizes(profiles[current])}; ROMs are ${sizes.map(kb).join(', ')})` : '') + '. Not loaded';
      continue;
    }
    // two unrecognised files for the same socket in one drop: the first one keeps it
    const clash = r.targets.find((t) => claimed.has(`${t.machine}/${t.socket}`));
    if (clash) {
      r.targets = [];
      r.message = `${name}: ${profiles[clash.machine].name} ${socketLabel(profiles[clash.machine], clash.socket)} was already filled by ${claimed.get(`${clash.machine}/${clash.socket}`)} from this drop. Not loaded`;
      continue;
    }
    for (const t of r.targets) claimed.set(`${t.machine}/${t.socket}`, name);
    r.result = 'loaded-unrecognised';
    r.message = `${name}: ${describeTargets(r.targets, profiles)} (not recognised: matched by ${byName.length ? 'file name' : 'size'} only)`;
  }
  // a verified image beats an unrecognised one for the same socket
  const verifiedSockets = new Set(out.filter((r) => r.result === 'verified').flatMap((r) => r.targets.map((t) => `${t.machine}/${t.socket}`)));
  for (const r of out) {
    if (r.result !== 'loaded-unrecognised') continue;
    const lost = r.targets.filter((t) => verifiedSockets.has(`${t.machine}/${t.socket}`));
    if (!lost.length) continue;
    r.targets = r.targets.filter((t) => !verifiedSockets.has(`${t.machine}/${t.socket}`));
    if (!r.targets.length) { r.result = 'rejected'; r.message = `${r.name}: a recognised copy of the same ROM was in this drop. Not loaded`; }
  }
  return { files: out };
}

const socketLabel = (p, id) => p.roms.find((s) => s.id === id).label;
const socketSizes = (p) => [...new Set(p.roms.map((s) => kb(s.size)))].join(' or ') + (combinedOrder(p) ? ` (or ${kb(p.roms[0].size + p.roms[1].size)} combined)` : '');
function describeTargets(targets, profiles) {
  const byMachine = new Map();
  for (const t of targets) {
    const label = socketLabel(profiles[t.machine], t.socket);
    if (!byMachine.has(t.machine)) byMachine.set(t.machine, []);
    byMachine.get(t.machine).push(label);
  }
  return [...byMachine].map(([id, labels]) => `${profiles[id].name} ${labels.join(' + ')}`).join('; ');
}

// status of each socket of a model, given its loaded images ({ socketId: Uint8Array })
export function socketStatus(profile, roms) {
  return profile.roms.map((s) => {
    const d = roms[s.id];
    const crc = d ? crc32(d) : null;
    const status = d ? (s.crcs.includes(crc) ? 'verified' : 'loaded-unrecognised') : s.required ? 'missing-required' : 'missing-optional';
    return { id: s.id, label: s.label, required: s.required, size: s.size, files: s.files, aliases: s.aliases || [], crc, status };
  });
}
export const isBootable = (profile, roms) => profile.kind !== 'cartridge' && profile.roms.every((s) => !s.required || !!roms[s.id]);

// is this file a ROM image (rather than a program, tape or cartridge)? Known contents, or a socket's usual
// name or alias.
export function looksLikeRom(name, bytes, profiles) {
  if (!bytes.length) return false;
  const crc = crc32(bytes), n = baseName(name);
  for (const p of Object.values(profiles)) {
    for (const s of p.roms) if (s.crcs.includes(crc) || names(s).includes(n)) return true;
    const order = combinedOrder(p);
    if (order && order[0].size + order[1].size === bytes.length && order[0].crcs.includes(crc32(bytes.subarray(0, order[0].size)))
      && order[1].crcs.includes(crc32(bytes.subarray(order[0].size)))) return true;
  }
  return false;
}

/*
 * ROM library: each image stored once (by CRC) and, per machine and socket, the CRC it holds. The bytes
 * live in the media layer (js/media/library.js: a MediaIndex over a MediaStore), loaded into memory once
 * at startup, so every method here is synchronous; writes reach the store in the background.
 */
export class RomLibrary {
  // owners: { id: profile } of everything that holds ROMs, or a function returning it (read on every use)
  constructor(index, owners) { this.index = index; this.owners = typeof owners === 'function' ? owners : () => owners; }
  // name: the file it came from, shown in socket status and boot help
  put(machine, socket, bytes, name = null) {
    const crc = crc32(bytes);
    // the socket first: another page's collect then keeps the image it names (MediaIndex.putSocket)
    this.index.putSocket(machine, socket, crc);
    this.index.putImage(crc, bytes, name);
  }
  fileName(crc) { return this.index.fileName(crc); }
  // { socketId: Uint8Array } for a machine
  get(machine) {
    const out = {};
    for (const s of this.owners()[machine].roms) {
      const crc = this.index.socketCrc(machine, s.id);
      const data = crc && this.index.image(crc);
      if (data) out[s.id] = data;
    }
    return out;
  }
  clear(machine) {
    this.index.clearMachine(machine);
    this.collect();
  }
  // every stored socket: [{ owner, socket, crc }]
  sockets() {
    const out = [];
    for (const p of Object.values(this.owners())) for (const s of p.roms) {
      const crc = this.index.socketCrc(p.id, s.id);
      if (crc && this.index.image(crc)) out.push({ owner: p.id, socket: s.id, crc });
    }
    return out;
  }
  image(crc) { return this.index.image(crc); }
  // drop images no socket refers to any more
  collect() { this.index.collect(); }
}

/*
 * ROM pack: the user's own stored ROMs as one ZIP file, to carry them to another browser. It holds each
 * image once (roms/<CRC>.rom) and a manifest of which socket of which machine holds which image, so
 * images loaded by name or size go back to the same sockets. It is a local file only: never uploaded, and
 * never part of share links, URL configuration or settings export.
 */
export const ROM_PACK_MANIFEST = 'cloadm-rompack.json';
export function makeRomPack(library) {
  const sockets = library.sockets();
  const crcs = [...new Set(sockets.map((s) => s.crc))].sort();
  const manifest = { format: 'cloadm-rompack', version: 1, sockets: sockets.map((s) => ({ machine: s.owner, socket: s.socket, crc: s.crc })) };
  return { manifest, entries: [{ name: ROM_PACK_MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) }]
    .concat(crcs.map((crc) => ({ name: `roms/${crc}.rom`, data: library.image(crc) }))) };
}
export const isRomPack = (entries) => entries.some((e) => e.name === ROM_PACK_MANIFEST);
// restore a pack's sockets into the library -> { restored: [{ machine, socket }], skipped: [message] }
export function restoreRomPack(entries, library, owners) {
  const man = entries.find((e) => e.name === ROM_PACK_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(man.data)); } catch (e) { throw new Error('ROM pack: the manifest is not valid JSON'); }
  if (manifest.format !== 'cloadm-rompack' || manifest.version !== 1) throw new Error('ROM pack: unknown format or version');
  const images = new Map(entries.filter((e) => /^roms\/[0-9A-F]{8}\.rom$/.test(e.name)).map((e) => [e.name.slice(5, 13), e.data]));
  const restored = [], skipped = [];
  for (const { machine, socket, crc } of manifest.sockets || []) {
    const p = owners[machine], s = p && p.roms.find((x) => x.id === socket), data = images.get(crc);
    if (!s) { skipped.push(`${machine}/${socket}: not a ROM this version of CLOADM takes`); continue; }
    if (!data || crc32(data) !== crc) { skipped.push(`${p.name} ${s.label}: image missing or corrupt in the pack`); continue; }
    if (data.length !== s.size) { skipped.push(`${p.name} ${s.label}: it is ${data.length} bytes, CLOADM takes ${s.size}`); continue; }
    library.put(machine, socket, data, `${p.name} ${s.label}`);
    restored.push({ machine, socket });
  }
  return { restored, skipped };
}
