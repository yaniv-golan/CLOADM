/* Session store backed by the browser's localStorage (silently non-persistent when storage is unavailable). */
export function localStore(prefix = 'cloadm.') {
  const tryDo = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
  return {
    get: (k) => tryDo(() => localStorage.getItem(prefix + k)),
    set: (k, v) => tryDo(() => localStorage.setItem(prefix + k, v)),
    remove: (k) => tryDo(() => localStorage.removeItem(prefix + k)),
    keys: () => tryDo(() => Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)), []),
  };
}

// Ask the browser to keep this site's storage (ROMs, programs) instead of clearing it when space runs low.
// -> 'kept' (granted now or before), 'may-clear' (refused) or 'unknown' (no StorageManager here)
export async function keepStorage() {
  const sm = typeof navigator !== 'undefined' && navigator.storage;
  if (!sm || !sm.persist) return 'unknown';
  try {
    if (sm.persisted && await sm.persisted()) return 'kept';
    return (await sm.persist()) ? 'kept' : 'may-clear';
  } catch (e) { return 'unknown'; }
}
