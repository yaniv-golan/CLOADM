/*
 * The page's INCLUDE reader: a file name in assembler source -> its text from the same-origin examples/ folder,
 * or null. Used by the assembler panel and by Claude's assemble_and_load, so both read the same place and
 * neither can reach anything else: a name that is absolute, has a scheme, a backslash, a "." or ".." segment or
 * a character outside letters, digits and . _ - / is refused (null) without any request being made.
 *
 * A read never hangs: it ends after `timeoutMs` (INCLUDE_TIMEOUT_MS) with an error whose code is 'timeout', and
 * when the caller's `signal` (Claude's turn: Stop) aborts, with code 'aborted'. Both race the fetch and the body,
 * so a fetch that ignores its signal still ends. A missing file (404, network failure) is null, as before.
 */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

export const isExampleName = (name) => typeof name === 'string' && SAFE_NAME.test(name) && !name.split('/').some((p) => p === '..' || p === '.');

// a same-origin file of a few KB comes back in well under a second; 15 s is a server that is not answering
export const INCLUDE_TIMEOUT_MS = 15000;

const readError = (code, message) => Object.assign(new Error(message), { code, reader: true });

// fetchFn(url, { signal }) -> Response; base is the same-origin folder the names are relative to.
// The reader is (name, { signal } = {}) -> Promise<text | null>.
export function exampleReader(fetchFn = (u, init) => fetch(u, init), base = 'examples/', { timeoutMs = INCLUDE_TIMEOUT_MS } = {}) {
  return async (name, { signal = null } = {}) => {
    if (!isExampleName(name)) return null;
    if (signal && signal.aborted) throw readError('aborted', `reading ${name} was stopped`);
    const inner = new AbortController();
    let timer = null, onAbort = null;
    const ended = new Promise((resolve, reject) => {
      // (rejected before the fetch is aborted: a fetch may reject at once on abort, and the race must see why)
      onAbort = () => { reject(readError('aborted', `reading ${name} was stopped`)); inner.abort(); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { reject(readError('timeout', `reading ${name} took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`)); inner.abort(); }, timeoutMs);
    });
    ended.catch(() => {});
    const guard = (p) => Promise.race([p, ended]);
    try {
      let res;
      try { res = await guard(fetchFn(`${base}${name}`, { signal: inner.signal })); } catch (e) { if (e && e.reader) throw e; return null; }
      if (!res.ok) return null;
      try { return await guard(res.text()); } catch (e) { if (e && e.reader) throw e; return null; }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      inner.abort();
    }
  };
}
