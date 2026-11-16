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

// gunzip, stopping as soon as more than max bytes come out -> bytes, or null when there are more
async function gunzipAtMost(bytes, max) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
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
  if (typeof snap.version !== 'number') throw new SnapshotError('This CLOADM snapshot has no format version.');
  if (snap.version > SNAPSHOT_VERSION) throw new SnapshotError(`This snapshot was saved by a newer CLOADM (format version ${snap.version}; this page reads version ${SNAPSHOT_VERSION}). Reload the page to update it.`);
  if (snap.version < SNAPSHOT_OLDEST) throw new SnapshotError(`This snapshot was saved by an older CLOADM (format version ${snap.version}), which this version no longer reads.`);
  if (!profiles[snap.machine]) throw new SnapshotError(`This snapshot is of a machine this CLOADM doesn't have (${snap.machine}).`);
  if (!snap.config || typeof snap.config !== 'object' || !snap.roms || typeof snap.roms !== 'object' || !snap.state || typeof snap.state !== 'object') {
    throw new SnapshotError('This CLOADM snapshot is incomplete.');
  }
  return snap;
}
