/*
 * ROM references for shared snapshots: a link may carry a moment
 * taken with the user's own ROMs and cartridges, but never a byte of them.
 *
 * A snapshot holds ROM code in two ways:
 *   - whole images: a cartridge's image and a disk controller's DOS ROM live in the cartridge port's state
 *     (fields `bytes` and `rom`); the machine's own ROMs are never in a snapshot, only their CRCs;
 *   - copies in memory: BASIC copies itself into RAM (the Dragon 64 in its 64K mode, the CoCo 3 always), and a
 *     program can copy any ROM anywhere.
 * stripRoms takes both out: each whole image becomes { $image: crc }, and every run of WINDOW or more bytes,
 * in any byte array of the state, that equals a run of a known image becomes a reference { path, at, crc, off,
 * len } with the bytes zeroed. Then it checks the result: no WINDOW-byte window of any image may be left in any
 * byte array (a run of one repeated byte excepted: padding carries no code), or it throws rather than share.
 * Byte arrays are Uint8Arrays and plain arrays of byte values (the printout, DriveWire's buffers and queues). A
 * tape being recorded is left out of a shared snapshot (share.dropped): its pulse timings could spell out ROM code.
 * restoreRoms puts everything back from the recipient's own images, found by CRC.
 *
 * Browser-free and pure: no Session, no storage.
 */
import { crc32 } from '../util.js';

export const WINDOW = 16;

const isBytes = (v) => v instanceof Uint8Array;
// a plain array of byte values (the printout, DriveWire's buffers and queues, ...): long enough to hold a window,
// every element a whole number from 0 to 255
const isByteList = (v) => Array.isArray(v) && v.length >= WINDOW && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);
const uniform = (a, i, n) => { const b = a[i]; for (let k = 1; k < n; k++) if (a[i + k] !== b) return false; return true; };
// a 32-bit hash of a[i..i+WINDOW)
const hashAt = (a, i) => { let h = 0; for (let k = 0; k < WINDOW; k++) h = (Math.imul(h, 31) + a[i + k]) | 0; return h; };
const same = (a, i, b, j, n) => { for (let k = 0; k < n; k++) if (a[i + k] !== b[j + k]) return false; return true; };

// every byte array in a value, with its path ('memory', 'cartridge.state.slots.0.state.bytes', 'printed', ...):
// Uint8Arrays, and plain arrays of byte values (value: a Uint8Array copy to scan, list: the array itself)
function byteArrays(v, path, out) {
  if (isBytes(v)) { out.push({ path, value: v }); return out; }
  if (isByteList(v)) { out.push({ path, value: Uint8Array.from(v), list: v }); return out; }
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) for (const [k, x] of Object.entries(v)) byteArrays(x, path ? `${path}.${k}` : k, out);
  return out;
}
const get = (root, path) => path.split('.').reduce((o, k) => o[k], root);
const set = (root, path, v) => { const ks = path.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], root)[last] = v; };

// the index of every non-uniform WINDOW-byte window of the images: hash -> [[image number, offset], ...]
export function windowIndex(images) {
  const index = new Map();
  images.forEach((img, n) => {
    const b = img.bytes;
    for (let i = 0; i + WINDOW <= b.length; i++) {
      if (uniform(b, i, WINDOW)) continue;
      const h = hashAt(b, i);
      const at = index.get(h);
      if (at) at.push([n, i]); else index.set(h, [[n, i]]);
    }
  });
  return index;
}

// the runs of a that equal runs of the images, longest first at each place: [{ at, image, off, len }]
export function findRuns(a, images, index = windowIndex(images)) {
  const runs = [];
  for (let i = 0; i + WINDOW <= a.length;) {
    const cands = uniform(a, i, WINDOW) ? null : index.get(hashAt(a, i));
    let best = null;
    if (cands) {
      for (const [n, off] of cands) {
        const b = images[n].bytes;
        if (!same(a, i, b, off, WINDOW)) continue;
        let len = WINDOW;
        while (i + len < a.length && off + len < b.length && a[i + len] === b[off + len]) len++;
        if (!best || len > best.len) best = { at: i, image: n, off, len };
      }
    }
    if (best) { runs.push(best); i += best.len; } else i++;
  }
  return runs;
}

// is any non-uniform WINDOW-byte window of the images in a? -> { at, image, off } or null
export function romWindowIn(a, images, index = windowIndex(images)) {
  for (let i = 0; i + WINDOW <= a.length; i++) {
    if (uniform(a, i, WINDOW)) continue;
    const cands = index.get(hashAt(a, i));
    if (cands) for (const [n, off] of cands) if (same(a, i, images[n].bytes, off, WINDOW)) return { at: i, image: n, off };
  }
  return null;
}

// The images a shared snapshot of this state refers to. images: the machine's own ROMs, [{ crc, bytes, kind,
// label }]; the cartridge port's images are added from the state.
//   snap -> a copy whose state holds no ROM code, with snap.share = { images: [{ crc, size, kind, label }],
//           placed: [{ path, crc }], refs: [{ path, at, crc, off, len }] }
// Throws when ROM code is left that can't be told apart (never seen in practice; then nothing is shared).
export function stripRoms(snap, machineRoms) {
  const out = Object.assign({}, snap, { state: structuredClone(snap.state) });
  const images = machineRoms.map((r) => ({ crc: r.crc, bytes: r.bytes, kind: r.kind || 'rom', label: r.label }));
  const placed = [];
  // a tape being recorded is left out: its pulse timings can spell out any bytes, ROM code too, and can't be told
  // apart from the rest; the moment opens with the deck not recording
  const dropped = [];
  if (out.state.deck && out.state.deck.recording) { out.state.deck.recording = null; dropped.push('deck.recording'); }
  // whole images in the cartridge port (a Multi-Pak's slots too): the field becomes { $image: crc }
  if (out.state.cartridge) {
    for (const { path, value } of byteArrays(out.state.cartridge, 'cartridge', [])) {
      const key = path.split('.').pop();
      if (key !== 'bytes' && key !== 'rom') continue;
      const crc = crc32(value);
      if (!images.some((x) => x.crc === crc)) images.push({ crc, bytes: value, kind: key === 'rom' ? 'dos' : 'cartridge', label: key === 'rom' ? 'the disk ROM' : 'the cartridge' });
      set(out.state, path, { $image: crc });
      placed.push({ path, crc });
    }
  }
  const index = windowIndex(images);
  const refs = [];
  for (const { path, value, list } of byteArrays(out.state, '', [])) {
    for (const r of findRuns(value, images, index)) {
      refs.push({ path, at: r.at, crc: images[r.image].crc, off: r.off, len: r.len });
      value.fill(0, r.at, r.at + r.len);
      if (list) list.fill(0, r.at, r.at + r.len);
    }
  }
  for (const { path, value } of byteArrays(out.state, '', [])) {
    const left = romWindowIn(value, images, index);
    if (left) throw new Error(`ROM code is left in ${path} at ${left.at} that can't be told apart from the data around it`);
  }
  out.share = { images: images.map((x) => ({ crc: x.crc, size: x.bytes.length, kind: x.kind, label: x.label })), placed, refs, dropped };
  return out;
}

// The ROM line on the Share screen: what the person opening a link must add, each image by its label ("32K-mode BASIC",
// "the disk ROM", "the cartridge"); '' when the moment needs nothing (it runs on the built-in firmware).
export const needsLine = (images) => (images.length ? `Needs ${images.map((x) => x.label).join(' and ')}: the person opening it adds their own.` : '');

// the images a shared snapshot needs that lookup(crc) doesn't have: [{ crc, size, kind, label }]
export const missingImages = (snap, lookup) => (snap.share ? snap.share.images.filter((x) => !lookup(x.crc)) : []);

// a shared snapshot -> the full snapshot, rebuilt from lookup(crc) -> bytes (the recipient's own images)
export function restoreRoms(snap, lookup) {
  if (!snap.share) return snap;
  const missing = missingImages(snap, lookup);
  if (missing.length) throw new Error(`missing images ${missing.map((x) => x.crc).join(', ')}`);
  const st = structuredClone(snap.state);
  for (const p of snap.share.placed) set(st, p.path, Uint8Array.from(lookup(p.crc)));
  for (const r of snap.share.refs) {
    const target = get(st, r.path), src = lookup(r.crc).subarray(r.off, r.off + r.len);
    if (Array.isArray(target)) for (let k = 0; k < src.length; k++) target[r.at + k] = src[k]; else target.set(src, r.at);
  }
  const out = Object.assign({}, snap, { state: st });
  delete out.share;
  return out;
}
