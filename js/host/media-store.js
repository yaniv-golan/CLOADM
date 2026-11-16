/*
 * MediaStore: the one storage interface the rest of CLOADM uses for media that must survive a reload
 * (ROM images, recent programs, and disk images and DriveWire files).
 *
 * Small settings (machine, options, flags) do NOT belong here: they stay in localStorage as before.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRACT
 * ---------------------------------------------------------------------------------------------
 * A store holds named byte blobs. Names are flat strings of printable ASCII without a leading "/" or
 * "\", at most 200 characters; "/" groups them into a prefix for list(prefix) and clear(prefix). A
 * name is unique within a store. Every method returns a Promise.
 *
 *   stat(name)                       -> { name, size, mtime } | null      (no bytes read)
 *   list(prefix = '')                -> [{ name, size, mtime }]           (sorted by name)
 *   read(name)                       -> Uint8Array                        (the whole blob)
 *   readRange(name, offset, length)  -> Uint8Array                        (random access)
 *   write(name, bytes)               -> { name, size, mtime }             (whole blob; create or replace)
 *   writeRange(name, offset, bytes)  -> { name, size, mtime }             (in place; exists first)
 *   rename(from, to)                 -> { name, size, mtime }             (fails 'exists' if `to` is taken)
 *   remove(name)                     -> boolean                          (true if it existed)
 *   clear(prefix = '')               -> number                           (count removed)
 *
 * RANDOM ACCESS (the reason this interface exists)
 *   readRange(name, offset, length): `offset` must satisfy 0 <= offset <= size, otherwise it rejects
 *   with code 'io' (a window that starts past the end is a caller bug, not an empty read). A window
 *   that runs past the end returns the bytes that exist, so it may be shorter than `length`; a
 *   `length` of 0 returns an empty array. Reading a missing name rejects with 'not-found'.
 *   writeRange(name, offset, bytes): the name must exist ('not-found' otherwise). Bytes overwrite in
 *   place; if the write runs past the current end the blob grows and any gap between the old end and
 *   `offset` is filled with zeroes. It never rewrites the whole blob: a disk image is written a
 *   sector at a time.
 *   Nothing is exclusive: several names may be used at once, in any interleaving.
 *
 * ORDERING
 *   Each call is independent; this interface says nothing about what happens if two writes to the SAME
 *   name are in flight at once, and on some backends (OPFS) two concurrent createWritable() calls on one
 *   file can even throw. A caller that may write a name twice must chain its writes. MediaIndex does that
 *   for the media it owns; a caller using the store directly (a disk image, say) must do it too.
 *
 * DURABILITY
 *   A write is best-effort until its promise resolves: resolve it, and the bytes are in the store as far
 *   as the backend can guarantee (for OPFS and File System Access, that is the browser's own storage, not
 *   a flushed disk). Nothing here can hold a page open across an unload, so a page that goes away
 *   mid-write can lose the last write. Callers that need a known point of durability await the writes.
 *
 * FAILURES
 *   Every rejection is a MediaStoreError with one of these codes:
 *     'not-found'    the name is not in the store
 *     'exists'       rename's target is already there
 *     'quota'        the browser refused the write for space (or the store's quota was reached)
 *     'invalid-name' the name is empty, too long, or has a leading slash or a control character
 *     'unsupported'  this implementation cannot do that operation
 *     'io'           anything else the backend reported
 *
 * WHAT THIS INTERFACE IS NOT FOR
 *   It is a general store, but CLOADM's media index (js/media/library.js) is only for small media that is
 *   always wanted: it loads every blob into memory at startup. Disk images (160K-800K,
 *   read and written a sector at a time) and DriveWire files must use readRange/writeRange on a
 *   store directly and keep nothing in the index.
 *
 * WHAT EACH IMPLEMENTATION GUARANTEES
 *   MemoryMediaStore (js/host/media-store-memory.js)  every method; used by Node tests and embedders.
 *   OpfsMediaStore  (js/host/media-store-opfs.js)     every method; browser-private, survives reload.
 *   FsaMediaStore   (js/host/media-store-fsa.js)      every method; a folder the user picked, written
 *                                                     back in place where the browser allows it.
 *   The import/download fallback (js/host/media-store-fallback.js) is not a store: where neither
 *   browser API exists it keeps blobs for the session in memory and hands the user a file to keep
 *   (download) or to read back (file picker). Its limits are stated in that module.
 *
 * This module is browser-free, so js/emu.js still loads in Node.
 */

export class MediaStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'MediaStoreError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// Printable ASCII, no control characters; "/" groups names into prefixes but may not lead.
const NAME = /^[\x20-\x7E]{1,200}$/;
export function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('/') || name.startsWith('\\') || name.includes('\\')) {
    throw new MediaStoreError('invalid-name', `Not a valid media name: ${JSON.stringify(name)}`);
  }
  return name;
}

// The operations every store shares, in terms of the few primitives it has. A backend supplies
// _stat, _list, _read and _write, and gets readRange/writeRange/rename/clear for free where its own
// API cannot do better. Backends that can do better override them.
export const DEFAULT_RANGE_LIMIT = 1 << 24;   // a window larger than this is a caller bug
export function checkRange(offset, length) {
  if (!Number.isInteger(offset) || offset < 0) throw new MediaStoreError('io', `Bad offset ${offset}`);
  if (!Number.isInteger(length) || length < 0 || length > DEFAULT_RANGE_LIMIT) throw new MediaStoreError('io', `Bad length ${length}`);
  return { offset, length };
}
