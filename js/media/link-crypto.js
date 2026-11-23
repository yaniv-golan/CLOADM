/*
 * The short link's encryption: the moment (the .cloadm file Session.shareFile makes) is sealed in the browser with
 * AES-GCM (128-bit key, 96-bit random IV, 128-bit tag; WebCrypto) before it is uploaded, and the key travels only in
 * the short link's fragment (https://s.cloadm.dev/<id>#<key>), which browsers never send to a server. The server
 * stores the sealed bytes and cannot read them.
 *
 *   sealed = IV (12 bytes) || AES-GCM ciphertext with its tag (the moment's length + 16)
 *   key    = 16 random bytes as base64url (22 characters)
 *
 * Browser-free: crypto.subtle and crypto.getRandomValues exist in browsers and in Node 20+.
 */
import { fromBase64Url, toBase64Url } from '../util.js';

export const KEY_CHARS = 22;
const IV_BYTES = 12, TAG_BYTES = 16;
export const SEAL_OVERHEAD = IV_BYTES + TAG_BYTES;

export class LinkCryptoError extends Error {}

const importKey = (raw, use) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);

// bytes -> { key: base64url of a fresh random key, sealed: IV || ciphertext }
export async function sealMoment(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(raw, 'encrypt'), bytes));
  const sealed = new Uint8Array(IV_BYTES + ct.length);
  sealed.set(iv); sealed.set(ct, IV_BYTES);
  return { key: toBase64Url(raw), sealed };
}

// is this a key as sealMoment writes them? (22 base64url characters: 16 bytes)
export const isLinkKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{22}$/.test(key);

// (sealed, key) -> the moment's bytes; LinkCryptoError when the key is not one, or the bytes were changed or cut
export async function openMoment(sealed, key) {
  if (!isLinkKey(key)) throw new LinkCryptoError('The link\'s key is missing or damaged.');
  if (!sealed || sealed.length < SEAL_OVERHEAD) throw new LinkCryptoError('The stored moment is damaged.');
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, IV_BYTES) }, await importKey(fromBase64Url(key), 'decrypt'), sealed.subarray(IV_BYTES));
    return new Uint8Array(out);
  } catch (e) { throw new LinkCryptoError('The link\'s key does not open the stored moment: the link was changed, or the moment was.'); }
}
