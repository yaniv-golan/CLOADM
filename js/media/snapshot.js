/*
 * Snapshot files: a machine's snapshot (Machine.snapshot(), js/machines/machine.js) as
 * a file the user keeps, and back.
 *
 * The file is gzip-compressed UTF-8 JSON (RFC 1952, through the platform's CompressionStream; memory is
 * mostly zeroes and repeats, so a 64K machine's file is a few tens of kilobytes):
 *   { format: 'cloadm-state', version, machine, name, taken, config, roms: { socket: crc32 }, state }
 * `name` (the model's name) and `taken` (ISO 8601 time) are for people; everything else is the snapshot.
 * Byte arrays in `state` are base64 (state.toJSON in js/util.js). The machine's ROMs are never in a snapshot, only
 * their CRCs: whoever opens it needs the same ROMs, or none if it was taken on the stub firmware. A shared snapshot
 * (Session.shareFile) also has `share`: the cartridge and DOS images it names, and references in place of every
 * copy of ROM code in its memory (js/media/romrefs.js); a snapshot you keep has neither.
 * Uncompressed JSON is read too (a file someone unpacked to look inside). Files from pre-release builds, whose
 * format identifier was 'cloadm-snapshot' and whose layout differs, are recognised and refused with a message saying so.
 *
 * Browser-free: CompressionStream exists in browsers and in Node 18+.
 */
import { state } from '../util.js';
import { SNAPSHOT_FORMAT, SNAPSHOT_OLDEST, SNAPSHOT_VERSION } from '../machines/machine.js';
import { profiles } from '../machines/profiles.js';

export const SNAPSHOT_EXT = '.cloadm';

export class SnapshotError extends Error {}

// the most a snapshot unpacks to: the largest machine's is about 1 MB of JSON (a CoCo 3 with 512K), disks a few
// MB more. Counted while it is decompressed, so a small file can't make the page allocate gigabytes.
export const SNAPSHOT_MAX_BYTES = 64 << 20;

const isGzip = (b) => b.length >= 2 && b[0] === 0x1F && b[1] === 0x8B;
const startsWith = (b, head) => b.length >= head.length && head.every((v, i) => b[i] === v);
const JSON_START = new TextEncoder().encode(`{"format":"${SNAPSHOT_FORMAT}"`);
const isJson = (b) => startsWith(b, JSON_START);
// what pre-release builds wrote (another layout, versions up to 19): recognised only to refuse it clearly
export const PRERELEASE_SNAPSHOT_FORMAT = 'cloadm-snapshot';
const PRERELEASE_START = new TextEncoder().encode(`{"format":"${PRERELEASE_SNAPSHOT_FORMAT}"`);
const isPrerelease = (b) => startsWith(b, PRERELEASE_START);

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// may these bytes be a snapshot file? (cheap; decodeSnapshot decides)
export const looksLikeSnapshot = (name, bytes) => name.toLowerCase().endsWith(SNAPSHOT_EXT) || isJson(bytes) || isPrerelease(bytes) || isGzip(bytes);

// snapshot (from Machine.snapshot()) -> file bytes; meta: { name, taken } for people reading the file
export async function encodeSnapshot(snap, { name, taken }) {
  const { format, version, machine, config, roms, state: s, share } = snap;
  const text = state.toJSON(Object.assign({ format, version, machine, name, taken, config, roms, state: s }, share ? { share } : {}));
  return pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
}

// gunzip (or another DecompressionStream format), stopping as soon as more than max bytes come out -> bytes, or null
// when there are more
async function gunzipAtMost(bytes, max, format = 'gzip') {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const v of parts) { out.set(v, o); o += v.length; }
  return out;
}

// file bytes -> snapshot, with what is wrong in words a user can act on (SnapshotError); maxBytes: the most it
// may unpack to (SNAPSHOT_MAX_BYTES)
export async function decodeSnapshot(bytes, { maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const limit = maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${maxBytes} bytes`;
  const tooBig = () => new SnapshotError(`This file unpacks to more than ${limit}, far more than any CLOADM snapshot: it is not one.`);
  let raw = bytes;
  if (isGzip(bytes)) {
    try { raw = await gunzipAtMost(bytes, maxBytes); }
    catch (e) { throw new SnapshotError('This file is compressed but damaged, or not a CLOADM snapshot.'); }
    if (!raw) throw tooBig();
  } else if (bytes.length > maxBytes) throw tooBig();
  if (isPrerelease(raw)) throw new SnapshotError('This snapshot was saved by a pre-release build of CLOADM, whose snapshots this version does not read.');
  if (!isJson(raw)) throw new SnapshotError('This file is not a CLOADM snapshot.');
  let snap;
  try { snap = state.fromJSON(new TextDecoder().decode(raw)); }
  catch (e) { throw new SnapshotError('This CLOADM snapshot is damaged (it ends early or was edited).'); }
  return checked(snap);
}

// what every snapshot read (a file or a link) must be, in words a user can act on -> snap
function checked(snap) {
  if (!snap || typeof snap !== 'object') throw new SnapshotError('This CLOADM snapshot is incomplete.');
  if (typeof snap.version !== 'number') throw new SnapshotError('This CLOADM snapshot has no format version.');
  if (snap.version > SNAPSHOT_VERSION) throw new SnapshotError(`This snapshot was saved by a newer CLOADM (format version ${snap.version}; this page reads version ${SNAPSHOT_VERSION}). Reload the page to update it.`);
  if (snap.version < SNAPSHOT_OLDEST) throw new SnapshotError(`This snapshot was saved by an older CLOADM (format version ${snap.version}), which this version no longer reads.`);
  if (!profiles[snap.machine]) throw new SnapshotError(`This snapshot is of a machine this CLOADM doesn't have (${snap.machine}).`);
  if (!snap.config || typeof snap.config !== 'object' || !snap.roms || typeof snap.roms !== 'object' || !snap.state || typeof snap.state !== 'object') {
    throw new SnapshotError('This CLOADM snapshot is incomplete.');
  }
  return snap;
}

// ---------------- the long link (#z=) ----------------
// The moment a long link carries (Session.snapshotLink writes '#z=' + base64url of these bytes):
//   byte 0      the link format's version, LONG_LINK_VERSION (1); 2 to 31 are kept for later versions, which a page says are newer
//   bytes 1...  deflate-raw (RFC 1951, no header or checksum) of the container:
//     u32 little-endian J, the length of the skeleton
//     J bytes     the skeleton: UTF-8 JSON of the snapshot { format, version, machine, name, taken, config, roms, state,
//                 share? } as encodeSnapshot writes it, except that each typed array is { "$bin": its type, "o": offset,
//                 "n": byte length } (non-finite numbers stay { "$num": "Infinity" }, as in files)
//     the rest    the typed arrays' bytes, each at its offset from the end of the skeleton, in the byte order of the
//                 platform (little-endian, as files' base64 is)
// The rendered picture (state.frame) is left out (null): it is about half of what is left after compression, and the
// machine draws it again on the next frame (Machine.loadState clears it). Saved files keep it. A link is about half
// the length of the older '#s=' form (base64url of the gzip file), which pages still read (Session.readSnapshotLink).
export const LONG_LINK_VERSION = 1;
const TYPED_NAMES = new Set(['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array']);

// snapshot (as for encodeSnapshot) -> the link's bytes
export async function encodeLongLink(snap, { name, taken }) {
  const { format, version, machine, config, roms, state: s, share } = snap;
  const value = Object.assign({ format, version, machine, name, taken, config, roms, state: Object.assign({}, s, { frame: null }) }, share ? { share } : {});
  const parts = [];
  let at = 0;
  const skeleton = new TextEncoder().encode(JSON.stringify(value, function (k, v) {
    const raw = this[k];
    if (ArrayBuffer.isView(raw)) {
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      parts.push(bytes);
      const mark = { $bin: raw.constructor.name, o: at, n: bytes.length };
      at += bytes.length;
      return mark;
    }
    if (typeof raw === 'number' && !Number.isFinite(raw)) return { $num: String(raw) };
    return v;
  }));
  const box = new Uint8Array(4 + skeleton.length + at);
  new DataView(box.buffer).setUint32(0, skeleton.length, true);
  box.set(skeleton, 4);
  let o = 4 + skeleton.length;
  for (const p of parts) { box.set(p, o); o += p.length; }
  const packed = await pipe(box, new CompressionStream('deflate-raw'));
  const out = new Uint8Array(1 + packed.length);
  out[0] = LONG_LINK_VERSION;
  out.set(packed, 1);
  return out;
}

// the link's bytes -> snapshot (its state.frame null: Machine.loadState clears the picture), SnapshotError when they
// are not one this page reads; maxBytes: the most the container may unpack to
export async function decodeLongLink(bytes, { maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const damaged = () => new SnapshotError('This link\'s snapshot is damaged: it was cut short or changed on the way.');
  if (!bytes || bytes.length < 2) throw damaged();
  // a version byte a little past ours is a newer CLOADM's; anything else is not a link this page wrote
  if (bytes[0] > LONG_LINK_VERSION && bytes[0] < 32) throw new SnapshotError(`This link was made by a newer CLOADM (link format ${bytes[0]}; this page reads ${LONG_LINK_VERSION}). Reload the page to update it.`);
  if (bytes[0] !== LONG_LINK_VERSION) throw damaged();
  let box;
  try { box = await gunzipAtMost(bytes.subarray(1), maxBytes, 'deflate-raw'); } catch (e) { throw damaged(); }
  if (!box) throw new SnapshotError('This link\'s snapshot unpacks to far more than any CLOADM snapshot: it is not one.');
  if (box.length < 4) throw damaged();
  const j = new DataView(box.buffer, box.byteOffset, box.byteLength).getUint32(0, true);
  if (4 + j > box.length) throw damaged();
  const base = 4 + j, end = box.length;
  let snap;
  try {
    snap = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(box.subarray(4, base)), (k, v) => {
      if (v && typeof v === 'object' && typeof v.$bin === 'string') {
        if (!TYPED_NAMES.has(v.$bin) || !Number.isInteger(v.o) || !Number.isInteger(v.n) || v.o < 0 || v.n < 0 || base + v.o + v.n > end) throw new Error('bad array');
        const T = globalThis[v.$bin];
        if (v.n % T.BYTES_PER_ELEMENT) throw new Error('bad array');
        const copy = box.slice(base + v.o, base + v.o + v.n);
        return new T(copy.buffer, 0, v.n / T.BYTES_PER_ELEMENT);
      }
      if (v && typeof v === 'object' && typeof v.$num === 'string') return Number(v.$num);
      return v;
    });
  } catch (e) { throw damaged(); }
  if (!snap || snap.format !== SNAPSHOT_FORMAT) throw damaged();
  return checked(snap);
}
