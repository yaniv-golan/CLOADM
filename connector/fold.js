// Folds an ES module and its whole import graph into one module script with no imports, for variant B of the
// side-panel view (connector/build.js), whose CSP allows inline scripts and nothing fetched. No dependencies: it
// understands the import/export forms CLOADM's js/ uses (named imports, `import * as`, `export {...}`, `export * from`,
// `export {...} from`, `export const/let/function/class`, `export const A = 0, B = 1;` on one line), refuses import
// cycles (there are none) and fails loudly on any other form, so a new one cannot slip through unfolded.
// Each module becomes `const __mN = {}; await (async () => { body; Object.assign(__mN, {exports}) })();`, in the order
// ES modules evaluate them (depth first, dependencies first). A name a module does not export fails at load, as the
// ES module would (__need). tests/connector.test.js runs the folded emulator against the plain modules.
// import.meta.url has no meaning in an inline script: it becomes "bundle:/<path>", so js/host/audio.js's AudioWorklet
// fails to load and Audio plays through its ScriptProcessorNode fallback.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STMT = /(?:^|\n)[ \t]*(import|export)\b/g;

// the names declared by `const a = …, b = …;` starting at src[i] (after the keyword): the first name, and on a
// declaration's first line the names after its top-level commas (CLOADM writes `export const A = 0, B = 1;` on one line); a name missed here fails loudly at load (__need)
function declarators(src, i) {
  const line = src.slice(i, src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i));
  const first = /^([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (!first) throw new Error(`cannot read declaration: ${line.slice(0, 60)}`);
  const names = [first[1]];
  let depth = 0, q = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) break;
    else if (c === '/' && line[k + 1] === '/') break;
    else if (c === ',' && depth === 0) { const m = /^\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(line.slice(k + 1)); if (m) names.push(m[1]); }
  }
  return names;
}

function transform(file, src, idOf) {
  const exports = [], stars = [], deps = [];
  const spec = (s) => { const f = path.resolve(path.dirname(file), s); deps.push(f); return f; };
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split(/\s+as\s+/); return [a, b || a]; });
  let out = src
    // (__need: a name the module does not export fails here, at load, as the ES module would, not as undefined later)
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_, names, s) => { const m = idOf(spec(s)), l = list(names);
      return `__need(${m}, ${JSON.stringify(l.map(([a]) => a))}, ${JSON.stringify(s)}); const { ${l.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${m};`; })
    .replace(/import\s*\*\s*as\s+([\w$]+)\s+from\s*'([^']+)';?/g, (_, n, s) => `const ${n} = ${idOf(spec(s))};`)
    .replace(/export\s*\*\s*from\s*'([^']+)';?/g, (_, s) => { stars.push(idOf(spec(s))); return ''; })
    .replace(/export\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_, names, s) => { const m = idOf(spec(s)); for (const [a, b] of list(names)) exports.push(`${b}: ${m}.${a}`); return ''; })
    .replace(/export\s*\{([^}]*)\};?/g, (_, names) => { for (const [a, b] of list(names)) exports.push(a === b ? a : `${b}: ${a}`); return ''; });
  out = out.replace(/(^|\n)([ \t]*)export\s+((?:async\s+)?function\*?|class)\s+([\w$]+)/g, (_, nl, ws, kw, n) => { exports.push(n); return `${nl}${ws}${kw} ${n}`; });
  out = out.replace(/(^|\n)([ \t]*)export\s+(const|let|var)\s+/g, (m, nl, ws, kw, off, s) => `${nl}${ws}${kw} \u0000`);
  out = out.replace(/\u0000/g, (_, off, s) => { exports.push(...declarators(s, off + 1)); return ''; });
  // anything left over is a form this folder does not know
  for (const m of out.matchAll(STMT)) {
    const line = out.slice(m.index, out.indexOf('\n', m.index + 1)).trim();
    if (/^(import|export)\b/.test(line) && !/^import\s*\(/.test(line)) throw new Error(`${path.relative(repo, file)}: cannot fold "${line.slice(0, 80)}"`);
  }
  // import.meta.url: no URL inside an inline script. audio.js uses it only for its AudioWorklet module, which then
  // fails to load and the Audio class plays through its ScriptProcessorNode fallback (reported as `audio:` in the view)
  out = out.replaceAll('import.meta.url', JSON.stringify(`bundle:/${path.relative(repo, file)}`));
  return { out, exports, stars, deps };
}

// whole-line comments only (a line that is just `// …`, or a block comment that starts and ends a line run):
// safe for CLOADM's sources, whose template literals hold no such lines (tests/connector.test.js runs the result)
const strip = (s) => s.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n/gm, '').replace(/^[ \t]*\/\/.*\n/gm, '');

export function fold(entry, { stripComments = true, tail = '' } = {}) {
  const order = [], ids = new Map(), state = new Map();
  const idOf = (f) => { if (!ids.has(f)) ids.set(f, `__m${ids.size}`); return ids.get(f); };
  const mods = new Map();
  const visit = (f) => {
    if (state.get(f) === 'done') return;
    if (state.get(f) === 'busy') throw new Error(`import cycle through ${path.relative(repo, f)}`);
    state.set(f, 'busy');
    let src = fs.readFileSync(f, 'utf8');
    if (stripComments) src = strip(src);
    const t = transform(f, src, idOf);
    mods.set(f, t);
    for (const d of t.deps) visit(d);
    state.set(f, 'done'); order.push(f);
  };
  visit(path.resolve(entry));
  let code = `// CLOADM, folded into one module by connector/fold.js (${order.length} modules)\n`
    + `const __need = (m, names, from) => { for (const n of names) if (!(n in m)) throw new SyntaxError(\`'\${from}' does not export \${n}\`); };\n`;
  for (const f of order) {
    const { out, exports, stars } = mods.get(f), id = idOf(f);
    code += `const ${id} = {};\nawait (async () => {\n// ---- ${path.relative(repo, f)}\n${out}\n`
      + `${stars.map((s) => `Object.assign(${id}, ${s});\n`).join('')}Object.assign(${id}, { ${exports.join(', ')} });\n})();\n`;
  }
  code += tail.replaceAll('__ENTRY__', idOf(path.resolve(entry)));
  if (/<!--|<script/i.test(code)) code = code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return { code, modules: order.length };
}
