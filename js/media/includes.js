/*
 * INCLUDE support for the assembler panel. The assembler is synchronous, so every file a source names -
 * including the ones the included files name in turn - is fetched first and handed to it as text.
 *
 *   const read = await loadIncludes(sourceText, (name) => fetch the text or return null);
 *   assemble(source, cpu, { include: read });
 *
 * Resolution descends into included files (nested includes work) and stops at a cycle or a file that
 * includes itself, leaving that INCLUDE for the assembler to report. A file that is missing is not
 * fetched twice.
 */

// every INCLUDE a source names, in order: [{ name, quoted }]
export function includeNames(source) {
  const out = [];
  for (const m of source.matchAll(/^\s*INCLUDE\s+(?:"([^"]+)"|(\S+))/gim)) out.push({ name: m[1] ?? m[2] });
  return out;
}

// load(source, fetchText) -> include(name) -> text | null. fetchText(name) -> string | null (may be async).
export async function loadIncludes(source, fetchText) {
  const files = new Map();   // name -> text | null (null: missing, not fetched again)
  const loading = new Set(); // names on the current chain, to break cycles
  const wanted = new Set();  // names already scheduled
  const queue = includeNames(source).map((x) => x.name);
  for (const n of queue) wanted.add(n);
  while (queue.length) {
    const name = queue.shift();
    if (files.has(name) || loading.has(name)) continue;
    loading.add(name);
    let text = null;
    try { text = await fetchText(name); } catch (e) { text = null; }
    files.set(name, text == null ? null : String(text));
    loading.delete(name);
    // descend: a file's own INCLUDEs join the queue (a cycle simply finds the name already loaded)
    if (files.get(name) != null) for (const { name: nested } of includeNames(files.get(name))) {
      if (!files.has(nested) && !wanted.has(nested)) { wanted.add(nested); queue.push(nested); }
    }
  }
  return (name) => files.get(name) ?? null;
}

// a readable one-line location for an assembler error: "liza-data.inc line 12: ..." or "line 3: ..."
export const describeError = (e) => `${e.file ? `${e.file} line ${e.line}` : `line ${e.line}`}: ${e.message}`;
