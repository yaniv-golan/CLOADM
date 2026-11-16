/*
 * Where the API key lives: on the host only. The key is never part of the machine, so it can
 * never appear in machine memory, a snapshot, a share link or a settings export; those are all made from the
 * machine and the Session's settings store, never from here.
 *
 * KeyStore is the interface. MemoryKeyStore keeps it for the visit (Node tests and an embedder);
 * storageKeyStore (below) wraps localStorage for the page, so nothing here touches the DOM.
 */
export class MemoryKeyStore {
  constructor(key = null) { this.key = key; }
  get() { return this.key; }
  set(key) { this.key = key || null; }
  clear() { this.key = null; }
}

// Wrap any { getItem, setItem, removeItem } (localStorage in the page, a Map in tests) as a KeyStore.
// The key is kept under one name, separate from every Session setting.
export function storageKeyStore(storage, name = 'cloadm.anthropicKey') {
  const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
  return {
    get: () => safe(() => storage.getItem(name)),
    set: (key) => safe(() => { if (key) storage.setItem(name, key); else storage.removeItem(name); }),
    clear: () => safe(() => storage.removeItem(name)),
  };
}
