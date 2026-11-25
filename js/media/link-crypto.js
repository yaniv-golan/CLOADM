/*
 * The short link's encryption: what a short link holds (a moment's .cloadm file, Session.shareFile, or a BASIC
 * program's link bytes, Session.programShortLink) is sealed in the browser with AES-GCM (128-bit key, 96-bit random IV,
 * 128-bit tag; WebCrypto) before it is uploaded, and the key travels only in the short link's fragment
 * (https://s.cloadm.dev/<id>#<key>), which browsers never send to a server. The server stores the sealed object and
 * cannot read what is in it.
 *
 * The sealed object (FROZEN at 0.3.0: a reader for every version ever written is kept; docs/automation.md, "Share links"):
 *   byte 0      SEALED_VERSION (1): this layout. 2 to 31 are kept for later layouts, which a page says are from a newer
 *               CLOADM; anything else is not a sealed object
 *   byte 1      the kind, in the clear so the server can say what a link opens: SEALED_KIND.moment (1, a .cloadm file),
 *               SEALED_KIND.program (2, the BASIC program link's bytes), SEALED_KIND.postcard (3, the LIZA postcard
 *               link's bytes) or SEALED_KIND.source (4, a program's source link's bytes) — the same numbers as a long link's byte 0. Kinds past the last of these, to 31, are kept for
 *               later kinds (under this version), which a page says are from a newer CLOADM;
 *               0 and 32 up are not kinds
 *   bytes 2-13  the IV
 *   the rest    the AES-GCM ciphertext with its tag (what it holds + 16), the two bytes above its additional
 *               authenticated data, so neither can be changed without the key refusing it
 *   key         16 random bytes as base64url (22 characters), only in the link
 *
 * Browser-free: crypto.subtle and crypto.getRandomValues exist in browsers and in Node 20+.
 */
import { fromBase64Url, toBase64Url } from '../util.js';

export const KEY_CHARS = 22;
const IV_BYTES = 12, TAG_BYTES = 16, HEAD = 2;
export const SEALED_VERSION = 1;
export const SEALED_KIND = Object.freeze({ moment: 1, program: 2, postcard: 3, source: 4 });
const KIND_MAX = Math.max(...Object.values(SEALED_KIND));
export const SEAL_OVERHEAD = HEAD + IV_BYTES + TAG_BYTES;
// the sealed object's clear header -> { version, kind }, or a LinkCryptoError naming what is wrong (a newer CLOADM's
// layout, or not a sealed object). The short-link Worker reads the same two bytes (shortlink/worker.js readSealedHead).
export function sealedHead(sealed) {
  if (!sealed || sealed.length < SEAL_OVERHEAD) throw new LinkCryptoError('The stored moment is damaged.');
  const version = sealed[0], kind = sealed[1];
  if (version > SEALED_VERSION && version < 32) throw new LinkCryptoError(`This short link was made by a newer CLOADM (sealed format ${version}; this page reads ${SEALED_VERSION}). Reload the page to update it.`);
  if (version !== SEALED_VERSION) throw new LinkCryptoError('The stored moment is damaged.');
  // a kind this page doesn't know, in the range kept for later kinds (past KIND_MAX, to 31), is a newer CLOADM's: a later kind can
  // be added under version 1. 0 and 32 up are not kinds at all.
  if (kind > KIND_MAX && kind < 32) throw new LinkCryptoError(`This short link was made by a newer CLOADM (a kind of link this page doesn't know, ${kind}). Reload the page to update it.`);
  if (!Object.values(SEALED_KIND).includes(kind)) throw new LinkCryptoError('The stored moment is damaged.');
  return { version, kind };
}

export class LinkCryptoError extends Error {}

const importKey = (raw, use) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);

// (bytes, kind: SEALED_KIND.*) -> { key: base64url of a fresh random key, sealed: the sealed object }
export async function sealMoment(bytes, kind = SEALED_KIND.moment) {
  if (!Object.values(SEALED_KIND).includes(kind)) throw new LinkCryptoError(`Not a kind of short link: ${kind}`);
  const raw = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const head = Uint8Array.of(SEALED_VERSION, kind);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, await importKey(raw, 'encrypt'), bytes));
  const sealed = new Uint8Array(HEAD + IV_BYTES + ct.length);
  sealed.set(head); sealed.set(iv, HEAD); sealed.set(ct, HEAD + IV_BYTES);
  return { key: toBase64Url(raw), sealed };
}

// is this a key as sealMoment writes them? (22 base64url characters: 16 bytes)
export const isLinkKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{22}$/.test(key);

// (sealed, key) -> { kind, bytes }: what it holds; LinkCryptoError when the key is not one, the object is from a newer
// CLOADM, or the bytes (the header included) were changed or cut
export async function openMoment(sealed, key) {
  if (!isLinkKey(key)) throw new LinkCryptoError('The link\'s key is missing or damaged.');
  const { kind } = sealedHead(sealed);
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(HEAD, HEAD + IV_BYTES), additionalData: sealed.subarray(0, HEAD) },
      await importKey(fromBase64Url(key), 'decrypt'), sealed.subarray(HEAD + IV_BYTES));
    return { kind, bytes: new Uint8Array(out) };
  } catch (e) { throw new LinkCryptoError('The link\'s key does not open the stored moment: the link was changed, or the moment was.'); }
}
