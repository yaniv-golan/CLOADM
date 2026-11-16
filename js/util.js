/* Small shared helpers: hex formatting, CRC-32 (ROM identification) and snapshot state helpers. */
export const hex = (v, digits = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
export const crc32 = (bytes) => {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0');
};

// ---- state (snapshots) ----
// Components implement saveState() -> plain data (numbers, booleans, strings, arrays, objects,
// typed arrays) and loadState(data). Typed arrays are restored in place, because several are
// shared views (e.g. the CoCo 3's 64K window, the 6803's on-chip RAM).
const copy = (v) => ArrayBuffer.isView(v) ? v.slice()
  : Array.isArray(v) ? v.map(copy)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]))
  : v;
// A lookup table keyed by names that come from files or callers: no prototype, so an inherited name such as
// "constructor" or "toString" is not an entry (it reads undefined like any unknown name).
export const registry = (entries) => Object.assign(Object.create(null), entries);

const TYPED = registry({ Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array });
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
// (a plain loop: Uint8Array.from with a mapping function is about 20 times slower on a disk-sized snapshot)
const unb64 = (s) => { const t = atob(s), out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };
// base64url (RFC 4648 section 5, no padding): bytes in a URL fragment
export const toBase64Url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (s) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return unb64(t + '='.repeat((4 - (t.length % 4)) % 4));
};
export const state = {
  copy,
  save(obj, keys) {
    const o = {};
    for (const k of keys) o[k] = copy(obj[k]);
    return o;
  },
  // a key the snapshot lacks is an error
  load(obj, data, keys) {
    for (const k of keys) {
      if (!(k in data)) throw new Error(`snapshot: missing "${k}"`);
      const v = data[k];
      if (ArrayBuffer.isView(obj[k])) {
        if (!ArrayBuffer.isView(v) || v.length !== obj[k].length) throw new Error(`snapshot: "${k}" has the wrong size`);
        obj[k].set(v);
      } else obj[k] = copy(v);
    }
  },
  // JSON with typed arrays (base64) and non-finite numbers
  toJSON(value) {
    return JSON.stringify(value, function (k, v) {
      const raw = this[k];
      if (ArrayBuffer.isView(raw)) return { $typed: raw.constructor.name, b64: b64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) };
      if (typeof raw === 'number' && !Number.isFinite(raw)) return { $num: String(raw) };
      return v;
    });
  },
  fromJSON(text) {
    return JSON.parse(text, (k, v) => {
      if (v && typeof v === 'object' && v.$typed) {
        const T = TYPED[v.$typed];
        if (!T) throw new Error(`state: unknown typed array ${v.$typed}`);
        const bytes = unb64(v.b64);
        return new T(bytes.buffer, 0, bytes.byteLength / T.BYTES_PER_ELEMENT);
      }
      if (v && typeof v === 'object' && v.$num) return Number(v.$num);
      return v;
    });
  },
};
