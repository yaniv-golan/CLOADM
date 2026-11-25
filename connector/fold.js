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

// ---- comments and layout: a small JavaScript tokenizer (no dependencies, rule 1.2) ----
// tokens(src) splits a module into tokens; every character belongs to exactly one, so joining their text gives src back.
// Types: ws (spaces, tabs, line ends), comment (// and /* */), str ('…' "…"), tmpl (a template literal's text
// pieces: `…` or `…${, }…${, }…`), regex, num, name, punct. The hard parts:
//  * a template's ${ … } is code, with its own strings, templates and braces: a brace stack tells a } that closes a
//    ${ (the template text resumes) from one that closes a block (a statement ends) or an expression (a value ends);
//  * a / starts a regex or is a division, decided by the previous significant token: after a value (a name, a number,
//    a string, a whole template, a regex, ), ], ++, --, or the } of an expression) it divides, except after the
//    keywords that take an expression (return, typeof, …) unless they are a property name (x.return), and after the )
//    of if (…) / while (…) / for (…) / for await (…) / with (…) (not o.if(…)); after any other punctuator, the } of a
//    block, a template's ${ and at the start, a regex begins. A regex's [ … ] class may hold a /.
//  * which } is which: a { opens an expression (an object literal, the body of a function or class expression) where
//    an expression may start: after an operator, ( [ , ? : or a keyword that takes one (not else or do), and for a
//    function or class whose keyword stands there; it opens a block after ) (unless it is a function expression's
//    parameters), => , ; , } , else, do, a name, and at the start. Known limit: a block after a label or `case x:` reads
//    as an object; a / right after its } would then divide. (export default { … } is an expression; export default
//    function / class a declaration; the string of import … from 'x' ends its statement.) tests/fold.test.js checks every module the fold takes in V8.
// A string, regex or template that does not end, or a stray }, throws: the folder fails loudly rather than guess.
const LT = /[\n\r\u2028\u2029]/;
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??',
  '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '/=', '**', '<<', '>>'];
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
const COND = new Set(['if', 'while', 'for', 'with']);
export function tokens(src) {
  const out = [], braces = [], parens = [];
  let i = 0, prev = null, prev2 = null;   // the last two significant tokens
  let fn = null, cls = null;   // a function / class keyword whose ( / { is still to come: { expr, depth }
  const push = (type, end, extra) => {
    const t = Object.assign({ type, text: src.slice(i, end) }, extra); out.push(t); i = end;
    if (type !== 'ws' && type !== 'comment') {
      // a pending function / class keyword that this token cannot continue was a property name ({ class: 'x' },
      // { function: 1 }): it is dropped, so no later ( or { takes it. A function goes on with *, a name or its (; a
      // class with a name (its own, extends) or its {, and once one of those came, with anything (an extends clause).
      if (fn && !(t.text === '*' || type === 'name')) fn = null;
      if (cls && !cls.seen && type !== 'name') cls = null;
      if (cls) cls.seen++;
      prev2 = prev; prev = t;
    }
    return t;
  };
  const where = () => `${src.slice(0, i).split('\n').length}`;
  const dotted = () => !!prev2 && (prev2.text === '.' || prev2.text === '?.');   // prev is a property name
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'name') return BEFORE_EXPR.has(prev.text) && !dotted();
    if (prev.type === 'punct') return prev.text === ')' ? prev.cond : prev.text === '}' ? !prev.value : !(prev.text === ']' || prev.text === '++' || prev.text === '--');
    if (prev.type === 'tmpl') return prev.text.endsWith('${');   // code starts after ${; a whole template is a value
    // the module specifier of import … from 'x', import 'x' or export … from 'x' ends its statement
    if (prev.type === 'str') return !!prev2 && (prev2.text === 'from' || prev2.text === 'import');
    return false;   // num, str, regex
  };
  // may an expression start here (so a { opens an object, a function or class keyword makes an expression)?
  const exprStart = () => {
    if (!prev) return false;
    if (prev.type === 'name') return (BEFORE_EXPR.has(prev.text) && prev.text !== 'else' && prev.text !== 'do' && !dotted()) || (prev.text === 'default' && !!prev2 && prev2.text === 'export');
    if (prev.type === 'punct') return !(prev.text === ')' || prev.text === ']' || prev.text === '}' || prev.text === ';' || prev.text === '++' || prev.text === '--' || prev.text === '=>');
    return prev.type === 'tmpl' && prev.text.endsWith('${');
  };
  const braceKind = () => {
    if (cls && cls.depth === parens.length) { const k = cls.expr ? 'value' : 'block'; cls = null; return k; }
    if (prev && prev.text === ')') return prev.fnExpr ? 'value' : 'block';
    return exprStart() ? 'value' : 'block';
  };
  // the text of a template from src[i] (just after ` or }) to its next ` (ends it) or ${ (code follows)
  const templ = (start) => {
    let k = start;
    for (;;) {
      if (k >= src.length) throw new Error(`unterminated template literal at line ${where()}`);
      const c = src[k];
      if (c === '\\') k += 2;
      else if (c === '`') return push('tmpl', k + 1);
      else if (c === '$' && src[k + 1] === '{') { braces.push('tmpl'); return push('tmpl', k + 2); }
      else k++;
    }
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\ufeff' || c === '\u00a0' || LT.test(c)) {
      let k = i + 1; while (k < src.length && /[ \t\v\f\ufeff\u00a0\n\r\u2028\u2029]/.test(src[k])) k++; push('ws', k);
    } else if (c === '/' && d === '/') {
      let k = i + 2; while (k < src.length && !LT.test(src[k])) k++; push('comment', k);
    } else if (c === '/' && d === '*') {
      const k = src.indexOf('*/', i + 2); if (k < 0) throw new Error(`unterminated comment at line ${where()}`); push('comment', k + 2);
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      for (;;) {
        if (k >= src.length || src[k] === '\n' || src[k] === '\r') throw new Error(`unterminated string at line ${where()}`);
        if (src[k] === '\\') k += src[k + 1] === '\r' && src[k + 2] === '\n' ? 3 : 2;
        else if (src[k++] === c) break;
      }
      push('str', k);
    } else if (c === '`') templ(i + 1);
    else if (c === '/' && regexAllowed()) {
      let k = i + 1, cls = false;
      for (;;) {
        if (k >= src.length || LT.test(src[k])) throw new Error(`unterminated regex at line ${where()}`);
        const e = src[k];
        if (e === '\\') k += 2;
        else { k++; if (e === '[') cls = true; else if (e === ']') cls = false; else if (e === '/' && !cls) break; }
      }
      while (k < src.length && /[\w$]/.test(src[k])) k++;
      push('regex', k);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d))) {
      const m = /^(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/.exec(src.slice(i, i + 64)); push('num', i + m[0].length);
    } else if (/[\p{ID_Start}$_\\#]/u.test(c) || c >= '\ud800') {
      let k = i + 1; while (k < src.length && (/[\p{ID_Continue}$\u200c\u200d\\]/u.test(src[k]) || src[k] >= '\ud800' && src[k] <= '\udfff' || (src[k - 1] === '\\' && src[k] === 'u'))) k++;
      const word = src.slice(i, k), dot = !!prev && (prev.text === '.' || prev.text === '?.');
      // export default function / class: a declaration, whatever the default exports otherwise
      const at = { expr: exprStart() && !(prev && prev.text === 'default'), depth: parens.length, seen: 0 };
      push('name', k);
      if (word === 'function' && !dot) fn = at;
      if (word === 'class' && !dot) cls = at;
    } else if (c === '}') {
      if (!braces.length) throw new Error(`unbalanced } at line ${where()}`);
      const kind = braces.pop();
      if (kind === 'tmpl') templ(i + 1); else push('punct', i + 1, { value: kind === 'value' });
    } else {
      const p = PUNCT.find((q) => src.startsWith(q, i) && !(q === '?.' && /[0-9]/.test(src[i + 2]))) || c;
      if (p === '{') braces.push(braceKind());
      if (p === '(') {
        const cond = !!prev && prev.type === 'name' && ((COND.has(prev.text) && !dotted()) || (prev.text === 'await' && !!prev2 && prev2.text === 'for'));
        const own = fn && fn.depth === parens.length ? fn : null; if (own) fn = null;   // a function's parameters
        parens.push({ cond, fnExpr: !!own && own.expr });
      }
      const r = p === ')' ? parens.pop() : null;
      push('punct', i + p.length, r ? { cond: r.cond, fnExpr: r.fnExpr } : p === ')' ? { cond: false } : undefined);
    }
  }
  if (braces.length) throw new Error(`unclosed { or \${ at end`);
  return out;
}

// the module without its comments and with its layout squeezed: every token kept, byte for byte, in order; between
// two tokens a line end where the original had one (in whitespace or inside a removed /* */ comment), so automatic
// semicolon insertion sees the same lines; else one space where the original had any gap (a + +b stays apart), else
// nothing. Indentation, trailing spaces, blank lines and comments go. Strings, templates and regexes are tokens, so
// nothing inside them is touched. tests/fold.test.js proves it on hand-built cases and on every module the fold takes.
export function strip(src) {
  let out = '', gap = '';
  for (const t of tokens(src)) {
    if (t.type === 'ws' || t.type === 'comment') { gap += t.text; continue; }
    if (out) out += LT.test(gap) ? '\n' : gap ? ' ' : '';
    out += t.text; gap = '';
  }
  return out && `${out}\n`;
}

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
  return { code, modules: order.length, files: order };
}
