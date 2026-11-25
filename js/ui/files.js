/*
 * Gathering dropped or picked files: plain files, folders (drag and drop through webkitGetAsEntry, or a
 * folder picker) and ZIP archives, which are opened here. Each result is { name, bytes, from } where
 * `from` is null for a file given directly, or the folder / archive it came out of.
 */
import { isZip, readZip } from '../media/zip.js';

const readFile = async (file) => new Uint8Array(await file.arrayBuffer());
const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
// all entries of a directory (readEntries returns them in batches)
async function readDir(dir) {
  const reader = dir.createReader(), out = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return out;
    out.push(...batch);
  }
}
async function walk(entry, from, out) {
  if (entry.isFile) out.push({ file: await entryFile(entry), from });
  else if (entry.isDirectory) for (const e of await readDir(entry)) await walk(e, from || entry.name + '/', out);
}

// A drop or a pick of one .wad: the person's own WAD for WYRMFIRE (js/ui/wyrmfire.js, page.takeWad), never a program,
// a ROM or a Library file. -> the File, or null. (Only its name is looked at here; WYRMFIRE checks what it is.)
export const wadOf = (list) => (list.length === 1 && !list[0].from && /\.wad$/i.test(list[0].file.name) ? list[0].file : null);
// files of a drop: folders walked, everything else as given
export async function droppedFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every(Boolean)) {
    const out = [];
    for (const e of entries) await walk(e, null, out);
    return out;
  }
  return [...dataTransfer.files].map((file) => ({ file, from: null }));
}
// files from an <input type=file> (a folder picker sets webkitRelativePath)
export function pickedFiles(input) {
  return [...input.files].map((file) => ({ file, from: file.webkitRelativePath ? file.webkitRelativePath.split('/')[0] + '/' : null }));
}

// read the files and open ZIP archives -> { files: [{ name, bytes, from }], errors: [message] }
export async function expand(list) {
  const files = [], errors = [];
  for (const { file, from } of list) {
    const bytes = await readFile(file);
    if (/\.zip$/i.test(file.name) || isZip(bytes)) {
      try { for (const e of readZip(bytes)) files.push({ name: e.name.split('/').pop(), bytes: e.data, from: file.name + ': ' }); }
      catch (err) { errors.push(`${file.name}: ${err.message}`); }
    } else files.push({ name: file.name, bytes, from });
  }
  return { files, errors };
}
