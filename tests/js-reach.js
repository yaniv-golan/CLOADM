// The raw-machine scan's reader of JavaScript (used by tests/chat-leaks.test.js; proved by tests/chat-leaks-scan.test.js).
//
// It is NOT a full parser, on purpose: every rule the scan has only ever looks at member chains (`a.b?.c[k]`),
// declarations and assignments (destructuring included), function heads (their parameters), call arguments, and the
// extent of functions and blocks. A token stream with matched brackets and a scope tree gives all of that without
// operator precedence or statements, and with no dependency (AGENTS.md 1.2: there is no package.json).
//
// Three steps:
//   1. TOKENIZE. Identifiers, punctuators, numbers, strings (their value), template literals (their `${}` expressions
//      are tokens, so code in one is scanned; a template with none is a string with a value), regular expressions
//      (told from a division by the token before the `/`), and comments dropped. Every token knows its line.
//      SELF-CHECK: every string, template, regex and comment must close and every bracket must match; a file that
//      fails is reported as a problem, so a mis-read file cannot silently lose its findings.
//   2. SCOPES. Functions (declarations, expressions, methods, getters/setters, arrows with or without parentheses),
//      blocks, class bodies, `for (...)` heads and `catch (e)`. `var` and parameters live in the function; `let`,
//      `const` and `class` in the nearest block. A name is resolved through the scope chain where it is USED, so a
//      shadowing parameter or a `for (let k ...)` in another function is a different binding from a `const k` here.
//   3. VALUES, to a fixpoint. Each binding holds a SET of abstract values - the union of everything ever assigned to it
//      (fail-safe: a name that was ever the Session is the Session): S (a Session), P (the Page), E (window.emu), a
//      string constant, an object or array literal of this file (with its properties / elements), a function of this
//      file, or an instance of a class of this file (with its `this.<field>`s). They flow through aliases, members,
//      destructures, bare and member assignments, `||`/`??`/`?:`, constant string `+`, and CALLS: `f(session)` with
//      `f` a function of this file gives its parameter the argument's values (also `this.m(...)`, `obj.m(...)` and
//      `new C(...)` for a class of this file).
// A REACH is then `.machine` / `?.machine` / `['machine']` / `._shown` / a computed key whose value includes one of
// those names, a destructure of either out of a holder (declaration or parameter), or Reflect.get/set/has/
// getOwnPropertyDescriptor/defineProperty or Object.getOwnPropertyDescriptor/defineProperty on a holder with such a key.
// A computed key on a holder whose value the reader cannot pin down is reported as such - when it is an EXPRESSION
// (`session['ma' + x]`, `session[0]`) or a name that may hold a string constant AND something unknown. A key that is a
// single name the reader knows nothing about (`session[k]` with `k` a parameter, or `k = location.hash`) is NOT
// reported: such a name is far more often an index than a field name, and THE BOUNDARY in tests/chat-leaks.test.js
// lists it under NOT CAUGHT.
'use strict';

const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof',
  'yield', 'await', 'do', 'else']);
// identifiers that are keywords: a `(` after one is not a call, and one cannot end an expression
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'new', 'delete', 'void',
  'throw', 'case', 'in', 'of', 'instanceof', 'else', 'do', 'yield', 'await', 'function', 'class', 'const', 'let', 'var',
  'export', 'import', 'extends', 'default', 'try', 'finally', 'break', 'continue', 'debugger', 'static', 'get', 'set']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=',
  '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const OPEN = { '(': ')', '[': ']', '{': '}', '${': '}' };
const PUNCT_BY_FIRST = new Map();
for (const q of PUNCT) { if (!PUNCT_BY_FIRST.has(q[0])) PUNCT_BY_FIRST.set(q[0], []); PUNCT_BY_FIRST.get(q[0]).push(q); }
const isDigit = (c) => c >= 48 && c <= 57;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 35 || c >= 128;
const isIdPart = (c) => isIdStart(c) && c !== 35 || isDigit(c);

function tokenize(text) {
  const n = text.length, toks = [], problems = [];
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  // tokens come in order, so the line of each is found by moving one pointer forward (an earlier index - only ever an
  // error message's - searches from the start)
  let lp = 0;
  const lineAt = (idx) => { if (idx < lineStarts[lp]) lp = 0; while (lp + 1 < lineStarts.length && lineStarts[lp + 1] <= idx) lp++; return lp + 1; };
  let i = 0, nl = false;
  const add = (t, v, at) => { const tok = { t, v, line: lineAt(at), nl }; nl = false; toks.push(tok); return tok; };
  if (text.startsWith('#!')) while (i < n && text[i] !== '\n') i++;
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'id') return KW_BEFORE_REGEX.has(p.v);
    if (p.t !== 'p') return false;
    return !(p.v === ')' || p.v === ']' || p.v === '}' || p.v === '`end' || p.v === '++' || p.v === '--');
  };
  const escape = () => {   // at a backslash: the character it stands for, and i moved past it
    const c = text[i + 1];
    i += 2;
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (c in simple) return simple[c];
    if (c === 'x') { const h = text.slice(i, i + 2); i += 2; return String.fromCharCode(parseInt(h, 16)); }
    if (c === 'u') {
      if (text[i] === '{') { const e = text.indexOf('}', i); const h = text.slice(i + 1, e); i = e + 1; return String.fromCodePoint(parseInt(h, 16)); }
      const h = text.slice(i, i + 4); i += 4; return String.fromCharCode(parseInt(h, 16));
    }
    if (c === '\n') return '';
    return c === undefined ? '' : c;
  };
  // the text of a template from i (just after ` or after the } of a ${}), to its end or its next ${
  const templatePart = () => {
    let cooked = '';
    const from = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { cooked += escape(); continue; }
      if (c === '`') { i++; return { done: true, cooked }; }
      if (c === '$' && text[i + 1] === '{') { i += 2; return { done: false, cooked }; }
      let e = i + 1;
      while (e < n) { const ch = text[e]; if (ch === '`' || ch === '\\' || ch === '$') break; e++; }
      cooked += text.slice(i, e); i = e;
    }
    problems.push({ line: lineAt(from), what: 'an unclosed template literal' });
    return { done: true, cooked };
  };
  const stack = [];   // what each open `{` / `${` is, so the `}` of a `${` resumes its template
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '\n') { nl = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') { i++; continue; }
    if (c === '/' && d === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e < 0) { problems.push({ line: lineAt(i), what: 'an unclosed block comment' }); i = n; continue; }
      if (text.slice(i, e).includes('\n')) nl = true;
      i = e + 2; continue;
    }
    const at = i;
    if (c === "'" || c === '"') {
      let v = ''; i++;
      for (;;) {
        if (i >= n || text[i] === '\n') { problems.push({ line: lineAt(at), what: 'an unclosed string' }); break; }
        if (text[i] === '\\') { v += escape(); continue; }
        if (text[i] === c) { i++; break; }
        let e = i + 1;
        while (e < n) { const ch = text[e]; if (ch === c || ch === '\\' || ch === '\n') break; e++; }
        v += text.slice(i, e); i = e;
      }
      add('str', v, at); continue;
    }
    if (c === '`') {
      i++;
      const tok = add('tmpl', null, at);
      const r = templatePart();
      if (r.done) { tok.t = 'str'; tok.v = r.cooked; continue; }
      add('p', '${', i - 2);
      stack.push({ tmpl: tok });
      continue;
    }
    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false, ok = false;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; ok = true; break; }
        i++;
      }
      if (!ok) problems.push({ line: lineAt(at), what: 'an unclosed regular expression' });
      while (i < n && isIdPart(text.charCodeAt(i))) i++;
      add('re', text.slice(at, i), at); continue;
    }
    const cc = text.charCodeAt(i);
    if (isDigit(cc) || (c === '.' && isDigit(text.charCodeAt(i + 1)))) {
      while (i < n && (isIdPart(text.charCodeAt(i)) || text[i] === '.')) i++;
      add('num', text.slice(at, i), at); continue;
    }
    if (/[A-Za-z_$#\u0080-￿]/.test(c)) {
      i++;
      while (i < n && /[\w$\u0080-￿]/.test(text[i])) i++;
      add('id', text.slice(at, i), at); continue;
    }
    const cands = PUNCT_BY_FIRST.get(c);
    let p = (cands && cands.find((q) => text.startsWith(q, i))) || c;
    if (p === '?.' && isDigit(text.charCodeAt(i + 2))) p = '?';      // `a?.5:1` is a conditional
    i += p.length;
    if (p === '{') stack.push({});
    if (p === '}') {
      const top = stack.pop();
      if (top && top.tmpl) {
        add('p', '}', at);
        const r = templatePart();
        if (r.done) { add('p', '`end', i - 1); top.tmpl.close = toks.length - 1; } else { add('p', '${', i - 2); stack.push(top); }
        continue;
      }
    }
    add('p', p, at);
  }
  // match the brackets: every opener has its closer, or the file is reported
  const match = new Int32Array(toks.length).fill(-1);
  const open = [];
  toks.forEach((t, k) => {
    if (t.t !== 'p') return;
    if (OPEN[t.v]) { open.push(k); return; }
    if (t.v === ')' || t.v === ']' || t.v === '}') {
      const o = open.pop();
      if (o === undefined || OPEN[toks[o].v] !== t.v) { problems.push({ line: t.line, what: `an unmatched '${t.v}'` }); if (o !== undefined) open.push(o); return; }
      match[o] = k; match[k] = o;
    }
  });
  for (const o of open) problems.push({ line: toks[o].line, what: `an unclosed '${toks[o].v}'` });
  return { toks, match, problems };
}

const REACH = new Set(['machine', '_shown']);
// the one 'nothing known' value, shared: every reader treats a value set as read-only (writers copy first)
const UNKNOWN = new Set(['?']);
const HOLDERS = ['S', 'P', 'E'];
// opts: { sessionClass: the class whose `this` is the Session (js/session.js), emuMachineOk: `emu.machine` is the
// licensed shown-machine accessor here, exempt: (fnName, className) => bool - the accessors' own bodies }
function analyse(text, opts = {}) {
  const { toks, match, problems } = tokenize(text);
  // a file the self-check rejects is reported as that and nothing more: with a bracket unmatched there is no extent to
  // read a scope or a chain by, and any finding after the break would be a guess
  if (problems.length) return { findings: [], problems, tokens: toks.length };
  const N = toks.length;
  const EOF = { t: 'eof', v: '' };
  const T = (k) => (k >= 0 && k < N ? toks[k] : EOF);
  const isP = (k, v) => { const t = T(k); return t.v === v && t.t === 'p'; };
  const isId = (k, v) => { const t = T(k); return t.t === 'id' && (v === undefined || t.v === v); };
  const endsExpr = (k) => {
    const t = T(k);
    if (t.t === 'id') return !KEYWORDS.has(t.v) || t.v === 'get' || t.v === 'set' || t.v === 'static';
    if (t.t === 'num' || t.t === 'str' || t.t === 're') return true;
    return t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}' || t.v === '`end');
  };
  // the last token of the expression starting at k (stops at , ; and an enclosing closer, and at a line break that
  // ends a statement by ASI)
  const exprEnd = (k) => {
    let j = k;
    while (j < N) {
      const t = T(j);
      if (t.t === 'p') {
        if (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}') return j - 1;
        if (OPEN[t.v]) { j = match[j] + 1; continue; }
      }
      if (t.t === 'tmpl') { j = t.close + 1; continue; }
      if (j > k && t.nl && endsExpr(j - 1) && (t.t === 'id' || t.t === 'str' || t.t === 'num' || t.t === 'tmpl')
        && !(t.t === 'id' && (t.v === 'in' || t.v === 'of' || t.v === 'instanceof'))) return j - 1;
      j++;
    }
    return N - 1;
  };

  // ---- scopes ----
  const scopes = [{ id: 0, parent: -1, kind: 'module', start: 0, end: N - 1, decls: new Map() }];
  const fnAt = new Map();      // token index of a function's start (its `(` or single param) -> scope
  const newScope = (kind, start, end, extra) => { const s = { id: scopes.length, parent: -1, kind, start, end, decls: new Map(), ...extra }; scopes.push(s); return s; };
  const paramPatterns = (fn, open, close) => {
    fn.params = [];
    if (open === close) { fn.params.push({ at: open, end: open }); return; }   // a single unparenthesised param
    let s = open + 1;
    for (let j = open + 1; j <= close; j++) {
      if (j < close && OPEN[T(j).v] && T(j).t === 'p') { j = match[j]; continue; }
      if (j === close || isP(j, ',')) { if (j > s) fn.params.push({ at: s, end: j - 1 }); s = j + 1; }
    }
  };
  const blockOf = new Set();
  for (let k = 0; k < N; k++) {
    const t = toks[k];
    if (t.t === 'p' && t.v === '=>') {
      let open, close;
      if (isP(k - 1, ')')) { close = k - 1; open = match[close]; } else { open = close = k - 1; }
      const end = isP(k + 1, '{') ? match[k + 1] : exprEnd(k + 1);
      const fn = newScope('fn', open, end, { arrow: true, name: null });
      paramPatterns(fn, open, close);
      fnAt.set(open, fn);
      if (isId(open - 1, 'async')) fnAt.set(open - 1, fn);
      if (isP(k + 1, '{')) blockOf.add(k + 1);
    } else if (t.t === 'p' && t.v === '{' && isP(k - 1, ')')) {
      const close = k - 1, open = match[close], before = T(open - 1);
      if (before.t === 'id' && ['if', 'while', 'switch', 'with', 'for'].includes(before.v)) continue;
      if (before.t === 'id' && before.v === 'catch') {
        const c = newScope('block', open, match[k]);
        paramPatterns(c, open, close); c.catch = true; blockOf.add(k);
        continue;
      }
      const name = before.t === 'id' && before.v !== 'function' ? before.v : null;
      let decl = false;
      if (name && (isId(open - 2, 'function') || (isP(open - 2, '*') && isId(open - 3, 'function')))) {
        const f = isId(open - 2, 'function') ? open - 2 : open - 3;
        decl = !(isP(f - 1, '=') || isP(f - 1, '(') || isP(f - 1, ',') || isP(f - 1, ':') || isId(f - 1, 'return') || isP(f - 1, '||') || isP(f - 1, '??') || isP(f - 1, '?'));
      }
      const accessor = isId(open - 2, 'get') ? 'get' : isId(open - 2, 'set') ? 'set' : null;
      const fn = newScope('fn', open, match[k], { arrow: false, name, decl, accessor, nameTok: open - 1 });
      paramPatterns(fn, open, close);
      fnAt.set(open, fn);
      if (before.t === 'id' && before.v === 'function') fnAt.set(open - 1, fn);
      if (name && isId(open - 2, 'function')) fnAt.set(open - 2, fn);
      if (isId(open - 2, 'async') || isId(open - 3, 'async')) fnAt.set(isId(open - 2, 'async') ? open - 2 : open - 3, fn);
      blockOf.add(k);
    } else if (t.t === 'id' && t.v === 'class' && !isP(k - 1, '.')) {
      let j = k + 1;
      while (j < N && !isP(j, '{')) { if (OPEN[T(j).v] && T(j).t === 'p') j = match[j]; j++; }
      if (j >= N) continue;
      const name = isId(k + 1) && T(k + 1).v !== 'extends' ? T(k + 1).v : null;
      const c = newScope('class', j, match[j], { name, classTok: k, methods: new Map(), fields: new Map() });
      blockOf.add(j);
      c.decl = !!name && !(isP(k - 1, '=') || isP(k - 1, '(') || isP(k - 1, ','));
    } else if (t.t === 'id' && t.v === 'for' && (isP(k + 1, '(') || (isId(k + 1, 'await') && isP(k + 2, '(')))) {
      const open = isP(k + 1, '(') ? k + 1 : k + 2, close = match[open];
      const end = isP(close + 1, '{') ? match[close + 1] : exprEnd(close + 1);
      newScope('block', open, end, { forHead: true });
    }
  }
  for (let k = 0; k < N; k++) if (isP(k, '{') && !blockOf.has(k)) newScope('block', k, match[k]);
  // innermost scope of every token, by a sweep over the scopes sorted outermost-first
  const scopeAt = new Int32Array(N);
  {
    const order = scopes.slice(1).sort((a, b) => a.start - b.start || b.end - a.end);
    const stack = [scopes[0]];
    let q = 0;
    for (let k = 0; k < N; k++) {
      while (stack.length > 1 && stack[stack.length - 1].end < k) stack.pop();
      while (q < order.length && order[q].start === k) {
        const s = order[q++];
        while (stack.length > 1 && stack[stack.length - 1].end < s.start) stack.pop();
        s.parent = stack[stack.length - 1].id;
        stack.push(s);
      }
      scopeAt[k] = stack[stack.length - 1].id;
    }
    for (; q < order.length; q++) order[q].parent = 0;
  }
  const fnScopeOf = (sid) => { let s = scopes[sid]; while (s.kind !== 'fn' && s.kind !== 'module') s = scopes[s.parent]; return s; };
  const classOfFn = (fn) => { const p = scopes[fn.parent]; return p && p.kind === 'class' ? p : null; };

  // ---- bindings ----
  let changed = false;
  const binding = () => ({ vals: new Set() });
  const declare = (scope, name) => { if (!scope.decls.has(name)) scope.decls.set(name, binding()); return scope.decls.get(name); };
  const resolved = new Array(N);
  const resolve = (name, k) => {
    if (resolved[k] && resolved[k].name === name) return resolved[k].b;
    const b = resolveWalk(name, k);
    resolved[k] = { name, b };
    return b;
  };
  const resolveWalk = (name, k) => {
    for (let s = scopes[scopeAt[k]]; s; s = s.parent >= 0 ? scopes[s.parent] : null) if (s.decls.has(name)) return s.decls.get(name);
    return declare(scopes[0], name);      // an undeclared name: the file's own global
  };
  // Each set and table carries the CLOCK of its last growth, and each fact the containers its last evaluation read:
  // a fact none of whose inputs grew since is not evaluated again (its result could not differ).
  let clock = 0, deps = null;
  const rd = (c) => { if (deps && c) deps.add(c); return c; };
  const grew = (c) => { c.stamp = ++clock; changed = true; };
  const addAll = (set, vals) => { let g = false; for (const v of vals) if (!set.has(v)) { set.add(v); g = true; } if (g) grew(set); };
  const newKey = (tab, key) => { if (!tab.has(key)) { tab.set(key, new Set()); grew(tab); } return tab.get(key); };
  // `this` at k: the class whose method (or field) it is in, crossing arrows; a plain function's own `this` is unknown
  const thisVal = (k) => {
    for (let s = scopes[scopeAt[k]]; s; s = s.parent >= 0 ? scopes[s.parent] : null) {
      if (s.kind === 'class') return s;
      if (s.kind === 'fn' && !s.arrow) return classOfFn(s);
      if (s.kind === 'module') return null;
    }
    return null;
  };
  // the class whose `this` is the Session: its methods and `this.<field>`s are the Session's own
  const sessionScope = () => scopes.find((c) => c.kind === 'class' && opts.sessionClass && c.name === opts.sessionClass) || null;
  let sessionCls;
  const classVal = (c) => (c && opts.sessionClass && c.name === opts.sessionClass ? 'S' : c ? `C:${c.id}` : '?');

  const objects = new Map(), arrays = new Map();   // token index of a literal -> Map(prop -> Set) / Set
  const facts = [];
  // the abstract value of a member of each value
  const member = (vals, name) => {
    const out = new Set();
    for (const v of vals) {
      if (v === 'W' && name === 'emu') out.add('E');
      else if ((v === 'E' || v === 'P') && name === 'session') out.add('S');
      else if (v === 'E' && name === 'page') out.add('P');
      else if (v.startsWith('o:')) { const o = rd(objects.get(+v.slice(2))); if (o && o.has(name)) for (const x of rd(o.get(name))) out.add(x); }
      else if (v.startsWith('a:') && name === '[]') { const a = rd(arrays.get(+v.slice(2))); if (a) for (const x of a) out.add(x); }
      else if (v.startsWith('C:') || v.startsWith('K:') || (v === 'S' && sessionCls)) {
        const c = v === 'S' ? sessionCls : scopes[+v.slice(2)];
        const inst = v === 'S' || v.startsWith('C:');
        const tab = rd(inst ? c.fields : c.statics || (c.statics = new Map()));
        if (tab.has(name)) for (const x of rd(tab.get(name))) out.add(x);
        if (inst && c.methods.has(name)) out.add(`fn:${c.methods.get(name)}`);
      }
    }
    return out.size ? out : UNKNOWN;
  };
  const memberPath = (vals, path) => path.reduce((v, p) => member(v, p), vals);
  const strings = (vals) => [...vals].filter((v) => v.startsWith('s:')).map((v) => v.slice(2));

  // split [s, e] at its top-level occurrences of the given punctuators
  const splitTop = (s, e, seps) => {
    const parts = []; let from = s;
    for (let j = s; j <= e; j++) {
      const t = T(j);
      if (t.t === 'tmpl') { j = t.close; continue; }
      if (t.t === 'p' && OPEN[t.v]) { j = match[j]; continue; }
      if (t.t === 'p' && seps.has(t.v)) { parts.push([from, j - 1]); from = j + 1; }
    }
    parts.push([from, e]);
    return parts;
  };
  const UNION = new Set([',', '||', '??', '&&', '?', ':', '=']);
  const literalFacts = (k) => {   // an object or array literal at k, read once: its properties become facts
    if (isP(k, '{')) {
      if (objects.has(k)) return;
      objects.set(k, new Map());
      for (const [a, b] of splitTop(k + 1, match[k] - 1, new Set([',']))) {
        if (a > b || isP(a, '...')) continue;
        let key = null, valAt = null;
        if ((isId(a) || T(a).t === 'str' || T(a).t === 'num') && isP(a + 1, ':')) { key = T(a).v; valAt = a + 2; }
        else if (isP(a, '[') && isP(match[a] + 1, ':')) { facts.push({ kind: 'prop', obj: k, keyRange: [a + 1, match[a] - 1], range: [match[a] + 2, b] }); continue; }
        else if (isId(a) && a === b) { key = T(a).v; valAt = a; }
        else if (isId(a) && isP(a + 1, '(')) { key = T(a).v; valAt = a + 1; }
        else if ((isId(a, 'async') || isP(a, '*')) && isId(a + 1) && isP(a + 2, '(')) { key = T(a + 1).v; valAt = a + 2; }
        if (key !== null) facts.push({ kind: 'prop', obj: k, key, range: [valAt, b] });
      }
      changed = true;
    } else if (isP(k, '[')) {
      if (arrays.has(k)) return;
      arrays.set(k, new Set());
      for (const [a, b] of splitTop(k + 1, match[k] - 1, new Set([',']))) if (a <= b) facts.push({ kind: 'elem', arr: k, range: isP(a, '...') ? null : [a, b] });
      changed = true;
    }
  };

  // ---- evaluation ----
  // a chain from k: its values and its last token. `report` records the reaches it passes.
  function chain(k, report, lim = N - 1) {
    let vals, j, base = null;
    const t = T(k);
    if (fnAt.has(k)) { const fn = fnAt.get(k); return { vals: new Set([`fn:${fn.id}`]), end: fn.end }; }
    if (t.t === 'id' && t.v === 'new') {
      // `new X.Y(args)`: the class is the chain up to the arguments, and the value an instance of it
      let ce = k + 1;
      while (isP(ce + 1, '.') && isId(ce + 2)) ce += 2;
      const c = chain(k + 1, report, Math.min(ce, lim));
      const end = isP(ce + 1, '(') && ce + 1 <= lim ? match[ce + 1] : c.end;
      return { vals: new Set([...c.vals].filter((v) => v.startsWith('K:')).map((v) => `C:${v.slice(2)}`).concat(['?'])), end };
    }
    if (t.t === 'id') {
      if (t.v === 'this') vals = new Set([classVal(thisVal(k))]);
      else if (t.v === 'window' || t.v === 'globalThis') vals = new Set(['W']);
      else {
        vals = rd(resolve(t.v, k).vals);
        const seed = t.v === 'session' ? 'S' : t.v === 'page' ? 'P' : t.v === 'emu' ? 'E' : null;
        if (seed) { vals = new Set(vals); vals.add(seed); } else if (!vals.size) vals = UNKNOWN;
        base = t.v;
      }
      j = k + 1;
    } else if (t.t === 'str') { vals = new Set([`s:${t.v}`]); j = k + 1; }
    else if (t.t === 'tmpl') { vals = UNKNOWN; j = t.close + 1; }
    else if (t.t === 'num' || t.t === 're') { vals = UNKNOWN; j = k + 1; }
    else if (isP(k, '(')) { vals = evalRange(k + 1, match[k] - 1); j = match[k] + 1; }
    else if (isP(k, '{') || isP(k, '[')) { literalFacts(k); vals = new Set([`${isP(k, '{') ? 'o' : 'a'}:${k}`]); j = match[k] + 1; }
    else return { vals: UNKNOWN, end: k };
    for (let first = true; j <= lim; first = false) {
      if ((isP(j, '.') || isP(j, '?.')) && isId(j + 1)) {
        const name = T(j + 1).v;
        if (report) reach(vals, name, j + 1, first ? base : null, `${first && base ? base : '…'}${T(j).v}${name}`);
        vals = member(vals, name);
        if (t.v === 'this' && first && name === 'session') { vals = new Set(vals); vals.add('S'); }
        j += 2; continue;
      }
      if (isP(j, '?.')) { j++; continue; }
      if (isP(j, '[')) {
        const keyVals = evalRange(j + 1, match[j] - 1);
        if (report) computed(vals, j, keyVals, first ? base : null);
        const out = new Set();
        for (const s of strings(keyVals)) for (const v of member(vals, s)) out.add(v);
        for (const v of member(vals, '[]')) out.add(v);
        vals = out; j = match[j] + 1; continue;
      }
      if (isP(j, '(')) {
        if (report && (base === 'Reflect' || base === 'Object')) reflect(k, j);
        vals = UNKNOWN; j = match[j] + 1; continue;
      }
      if (T(j).t === 'tmpl') { vals = UNKNOWN; j = T(j).close + 1; continue; }
      break;
    }
    return { vals, end: j - 1 };
  }
  function evalRange(s, e) {
    if (s > e) return UNKNOWN;
    if (s === e && T(s).t === 'id' && !fnAt.has(s) && !KEYWORDS.has(T(s).v) && !['session', 'page', 'emu', 'this', 'window', 'globalThis'].includes(T(s).v)) {
      const b = resolve(T(s).v, s);
      rd(b.vals);
      return b.vals.size ? b.vals : UNKNOWN;     // (read-only: every caller copies before it changes a set)
    }
    if (fnAt.has(s) && fnAt.get(s).end <= e) return new Set([`fn:${fnAt.get(s).id}`]);
    const parts = splitTop(s, e, UNION);
    if (parts.length > 1) {
      // `a ? b : c` - the condition is not a value of the whole; every other part may be
      const out = new Set();
      parts.forEach(([a, b], idx) => { if (!(idx === 0 && splitTop(s, e, new Set(['?'])).length > 1)) for (const v of evalRange(a, b)) out.add(v); });
      return out;
    }
    while (s <= e && T(s).t === 'id' && (T(s).v === 'await' || T(s).v === 'void' || T(s).v === 'typeof' || T(s).v === 'delete')) { if (T(s).v !== 'await') return UNKNOWN; s++; }
    const plus = splitTop(s, e, new Set(['+']));
    if (plus.length > 1) {
      let acc = [''];
      for (const [a, b] of plus) {
        const v = evalRange(a, b);
        const str = strings(v);
        if (str.length !== v.size || !str.length) return UNKNOWN;
        acc = acc.flatMap((x) => str.map((y) => x + y));
        if (acc.length > 16) return UNKNOWN;
      }
      return new Set(acc.map((x) => `s:${x}`));
    }
    const c = chain(s, false, e);
    return c.end === e ? c.vals : UNKNOWN;
  }

  // ---- reports ----
  const findings = new Map();
  const say = (k, what) => { const key = `${T(k).line}|${what}`; if (!findings.has(key)) findings.set(key, { line: T(k).line, what }); };
  // the method (or function) a token is in: the nearest non-arrow function and its class
  const methodOf = (k) => {
    for (let s = scopes[scopeAt[k]]; s; s = s.parent >= 0 ? scopes[s.parent] : null) if (s.kind === 'fn' && !s.arrow) return s;
    return null;
  };
  const exempt = (k) => {
    if (!opts.exempt) return false;
    for (let s = scopes[scopeAt[k]]; s; s = s.parent >= 0 ? scopes[s.parent] : null) {
      if (s.kind === 'fn' && !s.arrow) { const c = classOfFn(s); return opts.exempt(s.name, c && c.name, s.accessor); }
    }
    return false;
  };
  const holderKinds = (vals, name) => HOLDERS.filter((h) => vals.has(h) && !(h === 'E' && name === 'machine' && opts.emuMachineOk));
  function reach(vals, name, k, base, text) {
    if (!REACH.has(name)) return;
    if (!holderKinds(vals, name).length) return;
    if (exempt(k)) return;
    // the constructor's own `this._shown = null` is the field's declaration, not a reach
    if (name === '_shown' && opts.sessionClass && isP(k + 1, '=') && isId(k + 2, 'null')) {
      const m = methodOf(k), c = m && classOfFn(m);
      if (m && m.name === 'constructor' && c && c.name === opts.sessionClass) return;
    }
    say(k, text);
  }
  // a key on a holder: its value names a reach, or it cannot be pinned down
  function keyVerdict(vals, keyVals, single) {
    const str = strings(keyVals);
    const hit = str.find((s) => REACH.has(s));
    if (hit) return holderKinds(vals, hit).length ? `=${JSON.stringify(hit)}` : null;
    if (!holderKinds(vals, 'x').length) return null;
    if (single) return str.length && keyVals.size > str.length ? '=unknown, several bindings' : null;
    return str.length === keyVals.size ? null : '[computed]';
  }
  function computed(vals, j, keyVals, base) {
    const single = match[j] === j + 2 && isId(j + 1);
    const v = keyVerdict(vals, keyVals, single);
    if (v && !exempt(j)) say(j, `${base || '…'}[${single ? T(j + 1).v : T(j + 1).t === 'str' ? JSON.stringify(T(j + 1).v) : '…'}]${v === '[computed]' ? ' computed' : v}`);
  }
  const REFLECT = { Reflect: new Set(['get', 'set', 'has', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty']), Object: new Set(['getOwnPropertyDescriptor', 'defineProperty']) };
  function reflect(k, j) {
    if (!isP(k + 1, '.') || !isId(k + 2) || !REFLECT[T(k).v].has(T(k + 2).v) || j !== k + 3) return;
    const args = splitTop(j + 1, match[j] - 1, new Set([',']));
    if (args.length < 2) return;
    const target = evalRange(...args[0]), keyVals = evalRange(...args[1]);
    const single = args[1][0] === args[1][1] && isId(args[1][0]);
    const v = keyVerdict(target, keyVals, single);
    if (v) say(k, `${T(k).v}.${T(k + 2).v}(holder, key${v === '[computed]' ? ' computed' : v})`);
  }

  // ---- patterns (destructuring) ----
  // leaves: [{name, tok, path, def:[s,e]|null}], keys: [{name|null, keyRange, path}] (a key read at path)
  function pattern(k, path, leaves, keys) {
    if (isId(k)) { leaves.push({ name: T(k).v, tok: k, path }); return k; }
    if (isP(k, '{')) {
      for (const [a, b] of splitTop(k + 1, match[k] - 1, new Set([',']))) {
        if (a > b) continue;
        if (isP(a, '...')) { if (isId(a + 1)) leaves.push({ name: T(a + 1).v, tok: a + 1, path: null }); continue; }
        let key = null, keyRange = null, sub = a;
        if (isP(a, '[')) { keyRange = [a + 1, match[a] - 1]; sub = match[a] + 2; }
        else { key = T(a).v; sub = isP(a + 1, ':') ? a + 2 : a; }
        keys.push({ name: key, keyRange, path, at: a });
        const eq = splitTop(sub, b, new Set(['=']));
        const leafPath = key === null ? null : path && [...path, key];
        const before = leaves.length;
        pattern(sub, leafPath, leaves, keys);
        if (eq.length > 1) for (let q = before; q < leaves.length; q++) leaves[q].def = leaves[q].def || [eq[1][0], b];
      }
      return match[k];
    }
    if (isP(k, '[')) {
      for (const [a, b] of splitTop(k + 1, match[k] - 1, new Set([',']))) {
        if (a > b) continue;
        if (isP(a, '...')) { if (isId(a + 1)) leaves.push({ name: T(a + 1).v, tok: a + 1, path: null }); continue; }
        const eq = splitTop(a, b, new Set(['=']));
        const before = leaves.length;
        pattern(a, path && [...path, '[]'], leaves, keys);
        if (eq.length > 1) for (let q = before; q < leaves.length; q++) leaves[q].def = leaves[q].def || [eq[1][0], b];
      }
      return match[k];
    }
    return k;
  }
  // a pattern bound from a source: its leaves get the source's members, and its keys are checked for reaches
  const patternChecks = [];
  function bindPattern(k, scope, src) {
    const leaves = [], keys = [];
    const end = pattern(k, [], leaves, keys);
    for (const l of leaves) {
      const b = declare(scope, l.name);
      facts.push({ kind: 'leaf', b, src, path: l.path, def: l.def || null, tok: l.tok });
    }
    if (keys.length) patternChecks.push({ open: k, keys, src });
    return end;
  }

  // ---- facts: every binding, assignment, call and class member of the file ----
  const declEq = new Set();
  for (const s of scopes) {
    if (!s.params) continue;
    s.paramIn = s.params.map(() => new Set());
    s.params.forEach((p, i) => {
      const at = isP(p.at, '...') ? p.at + 1 : p.at;
      const src = () => (isP(p.at, '...') ? UNKNOWN : rd(s.paramIn[i]));
      bindPattern(at, s, src);
      const eq = splitTop(p.at, p.end, new Set(['=']));
      if (eq.length > 1) { declEq.add(eq[0][1] + 1); const b = isId(at) ? declare(s, T(at).v) : null; if (b) facts.push({ kind: 'bind', b, range: [eq[1][0], p.end] }); }
    });
  }
  for (let k = 0; k < N; k++) {
    const t = toks[k];
    if (t.t === 'id' && (t.v === 'const' || t.v === 'let' || t.v === 'var') && !isP(k - 1, '.') && !isP(k - 1, '?.') && (isId(k + 1) || isP(k + 1, '{') || isP(k + 1, '['))) {
      const fnScope = fnScopeOf(scopeAt[k]);
      const scope = t.v === 'var' ? fnScope : scopes[scopeAt[k]];
      let j = k + 1;
      for (;;) {
        const pEnd = pattern(j, [], [], []);
        const forOf = isId(pEnd + 1, 'of') || isId(pEnd + 1, 'in');
        let src;
        if (isP(pEnd + 1, '=')) {
          declEq.add(pEnd + 1);
          const e = exprEnd(pEnd + 2), r = [pEnd + 2, e];
          src = () => evalRange(...r);
          bindPattern(j, scope, src);
          j = e + 1;
        } else if (forOf) {
          const close = match[scopes[scopeAt[k]].start] >= 0 && isP(scopes[scopeAt[k]].start, '(') ? match[scopes[scopeAt[k]].start] : exprEnd(pEnd + 2) + 1;
          const r = [pEnd + 2, close - 1], of = isId(pEnd + 1, 'of');
          src = () => (of ? member(evalRange(...r), '[]') : UNKNOWN);
          bindPattern(j, scope, src);
          j = close;
        } else { bindPattern(j, scope, () => new Set()); j = pEnd + 1; }
        if (isP(j, ',') && (isId(j + 1) || isP(j + 1, '{') || isP(j + 1, '['))) { j++; continue; }
        break;
      }
    } else if (t.t === 'id' && t.v === 'function' && !isP(k - 1, '.')) {
      const fn = fnAt.get(k);
      if (fn && fn.decl && fn.name) declare(scopes[fn.parent], fn.name).vals.add(`fn:${fn.id}`);
    } else if (t.t === 'id' && t.v === 'class' && !isP(k - 1, '.')) {
      const c = scopes.find((s) => s.kind === 'class' && s.classTok === k);
      if (c && c.name && c.decl) declare(scopes[c.parent], c.name).vals.add(`K:${c.id}`);
    }
  }
  // class members: methods by name; a field initialiser `x = value` is `this.x`
  for (const s of scopes) {
    if (s.kind === 'fn' && !s.arrow && s.name) { const c = classOfFn(s); if (c) c.methods.set(s.name, s.id); }
  }
  const lhsStart = (e) => {   // the first token of the member chain ending at e
    let j = e;
    for (;;) {
      if (isP(j, ')') || isP(j, ']')) { const o = match[j]; if (endsExpr(o - 1) || isP(o - 1, '?.')) { j = o - 1; continue; } return o; }
      if (isP(j, '?.')) { j--; continue; }
      if (isId(j) && (isP(j - 1, '.') || isP(j - 1, '?.'))) { j -= 2; continue; }
      return j;
    }
  };
  const ASSIGN = new Set(['=', '||=', '??=', '&&=']);
  // every name this file can bind a function to: a declared name, a method, a property key or member it writes
  const fileNames = new Set();
  for (const sc of scopes) { for (const name of sc.decls.keys()) fileNames.add(name); if (sc.kind === 'fn' && sc.name) fileNames.add(sc.name); }
  const NAMES_BEFORE = new Set([':', '=', ',', '}', '||=', '??=']);
  for (let k = 0; k + 1 < N; k++) {
    if (toks[k].t !== 'id') continue;
    const nx = toks[k + 1];
    if (nx.t === 'p' && (NAMES_BEFORE.has(nx.v) || (nx.v === '(' && fnAt.has(k + 1)))) fileNames.add(toks[k].v);
  }
  for (let k = 0; k < N; k++) {
    const t = toks[k];
    if (t.t === 'p' && ASSIGN.has(t.v) && !declEq.has(k)) {
      const e = exprEnd(k + 1), r = [k + 1, e];
      const l = k - 1;
      if (isId(l) && !isP(l - 1, '.') && !isP(l - 1, '?.')) {
        const sc = scopes[scopeAt[l]];
        if (sc.kind === 'class') { const c = sc; facts.push({ kind: 'field', cls: c, name: T(l).v, range: r }); continue; }
        facts.push({ kind: 'bind', b: resolve(T(l).v, l), range: r });
      } else if (isId(l) && (isP(l - 1, '.') || isP(l - 1, '?.'))) {
        const s0 = lhsStart(l - 2);
        facts.push({ kind: 'set', obj: [s0, l - 2], key: T(l).v, range: r });
      } else if (isP(l, ']') && endsExpr(match[l] - 1)) {
        const s0 = lhsStart(match[l] - 1);
        facts.push({ kind: 'set', obj: [s0, match[l] - 1], keyRange: [match[l] + 1, l - 1], range: r });
      }
    } else if (t.t === 'p' && t.v === '(' && !fnAt.has(k) && (endsExpr(k - 1) || isP(k - 1, '`end')) && !(T(k - 1).t === 'id' && KEYWORDS.has(T(k - 1).v) && T(k - 1).v !== 'get' && T(k - 1).v !== 'set')) {
      // A callee can be a function of THIS file only through a name this file binds or a property key it writes; a
      // call through any other name (`console.log`, `page.evaluate`) cannot bind a parameter here, so it is not a fact.
      // (A callee ending in `)` or `]` is kept: its name is not in the text.)
      if (isId(k - 1) && !fileNames.has(T(k - 1).v)) continue;
      const s0 = lhsStart(k - 1);
      const args = splitTop(k + 1, match[k] - 1, new Set([','])).filter(([a, b]) => a <= b);
      facts.push({ kind: 'call', callee: [s0, k - 1], isNew: isId(s0 - 1, 'new'), args });
    }
  }

  sessionCls = sessionScope();
  // ---- the fixpoint ----
  const evalSrc = (f) => (f.range ? evalRange(...f.range) : UNKNOWN);
  // The values only grow and are finite, so the fixpoint settles; a file that has not settled within MAX_PASSES is a
  // PROBLEM, reported at the fact that was still growing, never a result: stopping early would leave names unlearned
  // and their reaches unseen. (A real file settles in a handful of passes; `maxPasses` is for the test that forces it.)
  const MAX_PASSES = opts.maxPasses || 40;
  const factTok = (f) => (f.tok !== undefined ? f.tok : f.range ? f.range[0] : f.callee ? f.callee[0]
    : Array.isArray(f.obj) ? f.obj[0] : f.obj !== undefined ? f.obj : f.arr);
  let settled = false, lastGrew = null;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    changed = false;
    for (let q = 0; q < facts.length; q++) {
      const f = facts[q];
      if (f.deps) { let stale = false; for (const c of f.deps) if ((c.stamp || 0) > f.at) { stale = true; break; } if (!stale) continue; }
      deps = new Set(); f.at = clock;
      const before = clock;
      if (f.kind === 'bind') addAll(f.b.vals, evalSrc(f));
      else if (f.kind === 'leaf') {
        const v = f.path === null ? UNKNOWN : memberPath(f.src(), f.path);
        addAll(f.b.vals, v);
        if (f.def) addAll(f.b.vals, evalRange(...f.def));
      } else if (f.kind === 'prop') {
        const tab = objects.get(f.obj);
        const keys = f.key !== undefined ? [f.key] : strings(evalRange(...f.keyRange));
        for (const key of keys) addAll(newKey(tab, key), evalSrc(f));
      } else if (f.kind === 'elem') addAll(arrays.get(f.arr), f.range ? evalRange(...f.range) : UNKNOWN);
      else if (f.kind === 'field') addAll(newKey(f.cls.fields, f.name), evalSrc(f));
      else if (f.kind === 'set') {
        const objs = evalRange(...f.obj);
        const keys = f.key !== undefined ? [f.key] : strings(evalRange(...f.keyRange));
        const v = evalSrc(f);
        for (const o of objs) {
          for (const key of keys) {
            let tab = null;
            if (o.startsWith('o:')) tab = objects.get(+o.slice(2));
            else if (o.startsWith('C:')) tab = scopes[+o.slice(2)].fields;
            else if (o === 'S' && sessionCls) tab = sessionCls.fields;
            else if (o.startsWith('K:')) tab = scopes[+o.slice(2)].statics || (scopes[+o.slice(2)].statics = new Map());
            if (!tab) continue;
            addAll(newKey(tab, key), v);
          }
          if (o.startsWith('a:') && f.keyRange) addAll(arrays.get(+o.slice(2)), v);
        }
      } else if (f.kind === 'call') {
        const callee = evalRange(...f.callee);
        for (const c of callee) {
          let fn = null;
          if (c.startsWith('fn:')) fn = scopes[+c.slice(3)];
          else if (c.startsWith('K:') && f.isNew) { const id = scopes[+c.slice(2)].methods.get('constructor'); if (id !== undefined) fn = scopes[id]; }
          if (!fn || !fn.paramIn) continue;
          f.args.forEach((r, i) => { if (i < fn.paramIn.length) addAll(fn.paramIn[i], isP(r[0], '...') ? UNKNOWN : evalRange(...r)); });
        }
      }
      f.deps = deps; deps = null;
      if (clock !== before) lastGrew = f;
    }
    if (!changed) { settled = true; break; }
  }
  if (!settled) {
    problems.push({ line: lastGrew ? T(factTok(lastGrew)).line : 1, what: `the values did not settle in ${MAX_PASSES} passes` });
    return { findings: [], problems, tokens: N };
  }

  // ---- the reaches ----
  // a chain can only report if one of its links is `.machine` / `._shown`, a computed key, or it is a Reflect/Object
  // call: anything else is skipped before it is evaluated
  const mayReport = (k) => {
    if (isId(k, 'Reflect') || isId(k, 'Object')) return true;
    let j = isP(k, '(') ? match[k] + 1 : k + 1;
    while (j < N) {
      if ((isP(j, '.') || isP(j, '?.')) && isId(j + 1)) { if (REACH.has(T(j + 1).v)) return true; j += 2; continue; }
      if (isP(j, '?.')) { j++; continue; }
      if (isP(j, '[')) return true;
      if (isP(j, '(')) { j = match[j] + 1; continue; }
      if (T(j).t === 'tmpl') { j = T(j).close + 1; continue; }
      return false;
    }
    return false;
  };
  for (let k = 0; k < N; k++) {
    if (isP(k - 1, '.') || isP(k - 1, '?.')) continue;
    if (!mayReport(k)) continue;
    const t = toks[k];
    if (t.t === 'id' && !(KEYWORDS.has(t.v) && t.v !== 'get' && t.v !== 'set' && t.v !== 'static')) chain(k, true);
    else if (isP(k, '(') && !endsExpr(k - 1) && !fnAt.has(k)) chain(k, true);
    else if (t.t === 'str' && isP(k + 1, '[')) chain(k, true);
  }
  for (const { open, keys, src } of patternChecks) {
    const base = src();
    for (const key of keys) {
      if (key.path === null) continue;
      const vals = memberPath(base, key.path);
      if (key.name !== null) {
        if (REACH.has(key.name) && holderKinds(vals, key.name).length && !exempt(open)) say(open, `{ ${key.name} } destructured from a holder`);
      } else {
        const v = keyVerdict(vals, evalRange(...key.keyRange), key.keyRange[0] === key.keyRange[1] && isId(key.keyRange[0]));
        if (v && !exempt(open)) say(open, `{ [key]${v} } destructured from a holder`);
      }
    }
  }
  return { findings: [...findings.values()].sort((a, b) => a.line - b.line), problems, tokens: N };
}

module.exports = { tokenize, analyse };
