/*
 * The import/download fallback, for a browser with neither OPFS nor the File System Access API.
 *
 * It is deliberately not a fresh MediaStore implementation: nothing a session holds survives a reload
 * there, so pretending otherwise would be a lie in the Library. What it gives the user is a way to keep
 * and bring back their own media, the same way the ROM pack already works:
 *
 *   keep(name)           download a stored blob as a file
 *   adopt(file)          read a file the user picked into the store
 *
 * The Session runs on this store (an in-memory one, marked `fallback`) for the whole visit, so every
 * feature works; the only difference is that the user has to keep and re-open their files themselves.
 */
import { MemoryMediaStore } from './media-store-memory.js';
import { MediaStoreError } from './media-store.js';

export const fallbackAvailable = () => typeof document !== 'undefined';

export class FallbackMediaStore extends MemoryMediaStore {
  get kind() { return 'fallback'; }
  get supported() { return { randomAccess: true, writes: true, persistent: false }; }
  // hand the user the blob as a file (the Library's download button is the same call)
  async keep(name) {
    const bytes = await this.read(name);
    return downloadBytes(bytes, fileNameOf(name));
  }
  // take a picked File back into the store under `name` (the Library's import button)
  async adopt(name, file) {
    const bytes = await readPicked(file);
    await this.write(name, bytes);
    return { name, size: bytes.length };
  }
}

const fileNameOf = (name) => name.split('/').pop();

// hand the user a file; the anchor is created and removed synchronously
export function downloadBytes(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

// read a file the user picked (a File, or an <input type=file>), as bytes
export async function readPicked(file) {
  if (!file) throw new MediaStoreError('io', 'No file was chosen');
  return new Uint8Array(await file.arrayBuffer());
}
