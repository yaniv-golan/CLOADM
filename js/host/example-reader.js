/*
 * The page's INCLUDE reader: a file name in assembler source -> its text from the same-origin examples/ folder,
 * or null. Used by the assembler panel and by Claude's assemble_and_load, so both read the same place and
 * neither can reach anything else: a name that is absolute, has a scheme, a backslash, a "." or ".." segment or
 * a character outside letters, digits and . _ - / is refused (null) without any request being made.
 */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

export const isExampleName = (name) => typeof name === 'string' && SAFE_NAME.test(name) && !name.split('/').some((p) => p === '..' || p === '.');

// fetchFn(url) -> Response; base is the same-origin folder the names are relative to
export function exampleReader(fetchFn = (u) => fetch(u), base = 'examples/') {
  return async (name) => {
    if (!isExampleName(name)) return null;
    try {
      const res = await fetchFn(`${base}${name}`);
      return res.ok ? await res.text() : null;
    } catch (e) { return null; }
  };
}
