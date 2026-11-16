/*
 * The library folder the user chose (File System Access), remembered across visits. A directory handle can't
 * go in localStorage, but it can be kept in IndexedDB (handles are structured-cloneable). The browser may still
 * ask for permission again after a reload; media-store-open.js deals with that.
 *
 * Every call resolves (null / false) rather than throwing where IndexedDB is missing or refused (a private
 * window, an embedding page), so the page starts on browser storage instead of failing.
 */
const DB = 'cloadm', STORE = 'handles', KEY = 'library-folder';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// the remembered folder handle, or null
export async function loadFolder() {
  try { return (await run('readonly', (s) => s.get(KEY))) || null; } catch (e) { return null; }
}
// remember it -> true when it was kept
export async function saveFolder(handle) {
  try { await run('readwrite', (s) => s.put(handle, KEY)); return true; } catch (e) { return false; }
}
export async function forgetFolder() {
  try { await run('readwrite', (s) => s.delete(KEY)); } catch (e) { /* nothing kept */ }
}
