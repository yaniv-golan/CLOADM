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
 * CASE
 *   A store may tell upper from lower case, or not, and it depends on the FILE SYSTEM rather than on the
 *   backend: the Origin Private File System on a case-sensitive volume tells them apart, a folder on a
 *   default (case-insensitive) APFS or NTFS volume does not, and a folder on ext4 does. The same browser can
 *   be over any of them. So a backend does not declare it; it is measured, with no write to the user's
 *   storage:
 *
 *     store.caseInsensitive                  the answer, once it is known (null: not measured yet)
 *     store.caseInsensitive = boolean         set on MemoryMediaStore (a fact of the instance)
 *     store.caseMeasured                     true once a listing has settled the answer
 *     measureOnce(store) -> Promise<boolean> the same as detectCase, but concurrent callers share one
 *                                             measurement, so two listings started together cannot read a
 *                                             half-set rule. A measurement that rejects is not kept.
 *     detectCase(store) -> Promise<boolean>   measure it: list the store, then stat one listed name with its
 *                                             case flipped and compare against the listing (see `folds`).
 *                                             No usable name (an empty store, digits-only names, or only
 *                                             names this project cannot ask about) means the question cannot
 *                                             be put: the answer is `true` (refusing a little more is
 *                                             harmless; letting two names that are one file be used at once
 *                                             is not), and the store is left UNmeasured so a later name asks
 *                                             again. A MediaStoreError from the store records the safe
 *                                             answer; anything else is let out, so a bug is not taken for a
 *                                             measurement.
 *     detectCaseSync(store) -> boolean        a synchronous store DECLARES its rule (`store.declaresCase`):
 *                                             the instance knows, so there is nothing to list. A synchronous
 *                                             store that does not declare throws rather than being guessed at.
 *
 *   Every list() on the two real backends asks the store for its rule itself (their _case(), which awaits
 *   measureOnce), because a listing is the cheapest place to put the question. Those, and any backend that measures
 *   itself inside list(), MUST also supply _listing(prefix, ci) - the same walk with the rule handed to it - because
 *   the measurement lists the store and a listing that asked for the rule from inside the measurement would wait on
 *   itself. A backend whose list() does not measure needs neither. The requirement is on the shape, not on the name:
 *   detectCase calls _listing when the store has one and list() otherwise.
 *   The Session measures too, at ready(), useMediaStore and
 *   moveMedia, and after a write it makes (refreshCase) while the store has no answer yet. Whatever settles it,
 *   `Session.caseInsensitive` reads the STORE's answer once the store has one, so no guard runs on a guess the
 *   store has since corrected. Guards that compare media names must use that answer, never `===`: on a store
 *   that does not tell cases apart, `GAME.DSK` and `game.dsk` are one file.
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

// ---- case: measuring whether a store tells GAME.DSK from game.dsk (see CASE above) ----
// The flip of a name: every ASCII letter's case swapped. Two names are one file exactly when their
// flips find each other, so the probe never needs a name of its own (checkName admits printable ASCII
// only, so this mapping is exact: no Unicode case folding to get wrong).
export function flipCase(name) {
  return name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
}
// the usable probe names, cheapest first: see probeName
function candidates(entries) {
  const usable = entries.map((e) => e.name)
    .filter((n) => /[A-Za-z]/.test(n))
    .filter((n) => { try { checkName(n); return true; } catch (e) { return false; } });
  return usable.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
}
// a listed name that can be put the question with: it must have a letter (a name of digits only cannot be
// flipped) and pass checkName (a store may hold a name this project does not write, such as a non-ASCII file in
// the user's own folder, and stat() refuses to ask about it). The shortest, so the stat is the cheapest, and the
// first by name among equals so the answer does not depend on listing order.
export function probeName(entries) { return candidates(entries)[0] || null; }
// Measure whether `store` tells upper from lower case, from ONE listing and one stat. The listing is the store's
// own account of which spellings exist; the stat asks what the store found for a listed name with its case
// flipped:
//
//   stat(flip) finds nothing                    the spellings are apart                   -> case-sensitive
//   stat(flip) finds something, and the
//     listing has `flip` as an entry of its own a genuinely different file is there        -> case-sensitive
//   stat(flip) finds something the listing
//     does not have as an entry                 the store matched a name it does not hold -> case-insensitive
//
// The second line is the whole of it, and it is what two earlier attempts got wrong: "something exists at the
// flipped path" is not the question (a case-sensitive store may hold a genuinely different file there), and
// comparing the leaf names of two lookups is not either (the flip can change a directory component too). Asking
// the LISTING whether that spelling exists answers both, and needs nothing but list() and stat().
function folds(entries, name, found) {
  if (!found) return false;                                       // nothing at the flip: the spellings are apart
  return !entries.some((e) => e.name === flipCase(name));         // found, and not an entry of its own: one file
}
// The listing a measurement may use: a backend whose list() asks for the rule itself (js/host/media-store-fsa.js
// _case) supplies _listing(prefix, ci), a listing given the rule instead of asking for it. Asking through list()
// there would wait on the measurement that is asking - the measurement would never finish. Every other store is
// listed as it is: a store that measures nothing has nothing to wait for.
//
// A measurement lists the WHOLE store (prefix ''), and that is what makes `ci` harmless rather than merely
// unobserved: at the empty prefix both walks match every name either way, so the answer cannot depend on it. The
// assertion below is that fact, made checkable: if a later change ever lists a measurement with a prefix, the rule
// it was given starts to matter and this fails loudly instead of quietly mis-filtering the probe.
async function listingFor(store, prefix = '') {
  if (typeof store._listing !== 'function') return store.list(prefix);
  if (prefix !== '') throw new Error(`case measurement must list the whole store, not ${JSON.stringify(prefix)}`);
  return store._listing(prefix, false);
}
// Measure whether `store` tells upper from lower case. Reads only: nothing is written, so a read-only
// folder and the user's own folder are both safe. A store already measured is answered from its own record, so
// a guard that runs many times costs one listing per store, not one per call.
export async function detectCase(store) {
  if (store.caseMeasured && typeof store.caseInsensitive === 'boolean') return store.caseInsensitive;
  let entries;
  try { entries = await listingFor(store); }
  catch (e) {
    // A store refusing to be read is not an answer: the safe answer, recorded, and said once. That is a
    // MediaStoreError (the contract's own failure type) and — belt and braces, because a backend could miss a
    // path — a DOMException, which is what the browser APIs underneath throw (NotAllowedError for a lapsed
    // permission, SecurityError, QuotaExceededError, InvalidStateError). Anything else is unexpected (a bug, a
    // shape we do not know): let it out, so it is not mistaken for a measurement and a later call can try again
    // rather than inheriting a wrong answer for the visit.
    if (e instanceof MediaStoreError || isDomException(e)) return refuse(store, e);
    throw e;
  }
  // Nothing to put the question with (an empty store, or only names this project cannot ask about): the safe
  // answer, but NOT a measurement — `caseMeasured` stays false, so the question is put again later.
  if (!probeName(entries)) return (store.caseInsensitive = true);
  for (const name of candidates(entries)) {
    let found;
    try { found = await store.stat(flipCase(name)); } catch (e) {
      // The flip could not be asked about (an invalid name, a transient refusal). That is not evidence either
      // way: move to the next candidate. If none can be asked, stay unmeasured so a later call tries again.
      if (e && (e.code === 'invalid-name' || e.code === 'io')) continue;
      return refuse(store, e);
    }
    store.caseMeasured = true;
    return (store.caseInsensitive = folds(entries, name, found));
  }
  return (store.caseInsensitive = true);
}
// a browser API's own failure: the DOMException shapes a MediaStore backend sits on. Named explicitly rather than
// by `instanceof DOMException`, because Node has no DOMException to test against and a test double carries only the
// name and the shape. A TypeError is NOT here: it is far more likely to be a bug than a permission lapse.
const DOM_FAILURES = new Set(['NotAllowedError', 'SecurityError', 'QuotaExceededError', 'InvalidStateError', 'NotFoundError', 'NotSupportedError']);
function isDomException(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof DOMException === 'function' && e instanceof DOMException) return true;
  return DOM_FAILURES.has(e.name);
}
// a listing or a stat the backend refuses outright: the safe answer, recorded so it is not asked again, and said
// once. (Set the answer BEFORE the flag, so a concurrent reader never sees the old rule with the measured flag.)
function refuse(store, e) {
  console.warn(`media store: cannot measure case sensitivity (${e && e.message ? e.message : e}); treating names as case-insensitive`);
  store.caseInsensitive = true;
  store.caseMeasured = true;
  return true;
}
// Measure once, even when several callers ask at the same moment. A listing on a real backend asks for the rule
// itself (js/host/media-store-fsa.js _case), so two listings issued together would each start a measurement; the
// one that went second could read the store's half-set state and answer with the SAFE (folding) answer while the
// store is exact. Sharing the one in-flight promise makes every caller see the same answer. A measurement that
// REJECTS is not kept: the next call tries again (a refusal must not decide the rule for good).
export function measureOnce(store) {
  if (store.caseMeasured && typeof store.caseInsensitive === 'boolean') return Promise.resolve(store.caseInsensitive);
  if (store._measuring) return store._measuring;
  const p = detectCase(store).then(
    (answer) => { store._measuring = null; return answer; },
    (e) => { store._measuring = null; throw e; });
  store._measuring = p;
  return p;
}
// the same for a store whose bytes are already in memory. A synchronous store declares its rule (MemoryMediaStore
// and what extends it): the instance knows whether it folds, so there is nothing to measure and no listing to do.
export function detectCaseSync(store) {
  if (store.caseMeasured && typeof store.caseInsensitive === 'boolean') return store.caseInsensitive;
  if (!store.declaresCase || typeof store.caseInsensitive !== 'boolean') throw new Error('a synchronous store must declare caseInsensitive');
  store.caseMeasured = true;
  return store.caseInsensitive;
}
