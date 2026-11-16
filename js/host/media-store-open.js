/*
 * Choosing the media backend: one call the page makes at startup, so nothing else in the code has to
 * know which storage this browser offers.
 *
 *   OPFS        preferred: private to the page, no permission prompt, survives a reload.
 *   Files       the user's own folder, when they picked one (File System Access); written in place.
 *   Fallback    neither available: an in-memory store for this visit, with download and import.
 *
 * The choice is a run-time fact, not a build-time one: a test disables OPFS on the page and expects
 * the fallback, and the page must not care.
 */
import { OpfsMediaStore, opfsAvailable } from './media-store-opfs.js';
import { FsaMediaStore, fsaAvailable } from './media-store-fsa.js';
import { FallbackMediaStore, fallbackAvailable } from './media-store-fallback.js';

export { opfsAvailable, fsaAvailable, fallbackAvailable };

// The store to use. `prefer`: 'opfs' | 'fsa' | 'fallback' (the user's choice in the Library, or ?storage=).
// 'fsa' needs a `directory` the user picked: without one it is a misconfiguration, not a silent fallback,
// so it throws rather than leaving the page on some other store than the one asked for.
export async function openMediaStore({ prefer = null, directory = null } = {}) {
  if (prefer === 'fsa' || (directory && prefer !== 'opfs' && prefer !== 'fallback')) {
    if (!directory) throw new Error('The "files" storage needs a folder; choose one first');
    if (!await FsaMediaStore.authorize(directory)) throw new Error('Permission to write to that folder was refused');
    return new FsaMediaStore(directory);
  }
  if (prefer !== 'fallback' && opfsAvailable()) {
    const store = new OpfsMediaStore();
    await store.ready;
    return store;
  }
  return new FallbackMediaStore();
}

// The store at startup for the choice the user made in the Library (`choice`, null for the best there is) and,
// for 'fsa', the folder they picked (js/host/folder-handle.js). A folder's permission may not survive a reload,
// and asking for it again needs a click: then the page starts on the best other store and returns the folder as
// `reconnect`, for the Library to offer. -> { store, reconnect }
// With no folder at all (never picked, or its handle gone) 'fsa' is refused as openMediaStore refuses it, rather
// than quietly using another store.
export async function openChosenStore(choice, folder = null) {
  if (choice === 'fsa') {
    if (!folder) return { store: await openMediaStore({ prefer: 'fsa' }), reconnect: null };   // throws: needs a folder
    let granted = false;
    try { granted = !!folder && fsaAvailable() && (await folder.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { granted = false; }
    if (granted) return { store: new FsaMediaStore(folder), reconnect: null };
    return { store: await openMediaStore(), reconnect: folder };
  }
  return { store: await openMediaStore({ prefer: choice }), reconnect: null };
}

// what this browser can offer the Library, for the page to show
export function availableChoices() {
  return [
    { id: 'opfs', label: 'Inside this browser', available: opfsAvailable() },
    { id: 'fsa', label: 'A folder on this computer', available: fsaAvailable() },
    { id: 'fallback', label: 'Download and open files', available: fallbackAvailable() },
  ];
}
