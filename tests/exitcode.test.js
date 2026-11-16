// No suite or tool forces process.exit(). Node 25.2.1 deadlocks intermittently in it: the main thread enters
// node::Environment::Exit and joins a background Sparkplug compile, whose worker is parked in
// CollectionBarrier::AwaitCollectionBackground waiting for a GC that the exiting thread will never run. The suite
// has printed its result and then never returns, and nothing reaps it (9 hangs in 300 runs of one unchanged suite
// under load). A suite must therefore end by setting process.exitCode and returning, so the event loop drains and
// Node exits by itself; an early bail sets exitCode and does a top-level `return`.
//
// The rule covers tools/ as well: a MAME comparison that prints its result and then never returns is the same bug,
// and it strands a finished run the same way.
//
// Correction to how this was first described: tools are covered by THIS static scan only. The runtime guard
// (tests/no-exit.js, on the runtime-guard branch) arms itself in every process except a tool's entry script,
// because a tool may use exit(0) as a success signal - tools/gen-page-preload.js exits 0 when the preload list is
// already right, and blocking it made the tool fall through into its write path. That includes
// tools/gen-rom-docs.js, which tests/romdocs.test.js spawns: it is NOT runtime-guarded, whatever an earlier commit
// message said. So nothing a tool does at run time is observed by that guard; only this scan sees a tool.
// Run: node tests/exitcode.test.js
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// One file is skipped, and only by the CROSS-CHECK below: tests/exitguard.test.js holds process.exit spellings
// inside multi-line template literals on purpose, to feed each one to the runtime guard. The MAIN scan must keep
// looking at it - findExits blanks template text and so correctly reports none there, and a live call later added
// to it would have to be caught. The cross-check's simple grep cannot blank a multi-line template, so it counts 5
// in that file and its one-sided "guard >= grep" assertion would fail on a file neither guard is wrong about.
// Skipped by name in the cross-check alone; a self-test below holds the main scan to scanning it.
// (The other guard files need no skip at all: no-exit.js and this file both grep clean, verified.)
const CROSS_CHECK_SKIP = new Set(['exitguard.test.js']);
const skipCrossCheck = (f) => path.dirname(f) === TESTS && CROSS_CHECK_SKIP.has(path.basename(f));

// The suites all.js runs, plus all.js itself, which spawns them; and every file under tools/, where the same
// deadlock strands a finished MAME run (a lockstep that prints its result and never returns).
const TESTS = path.join(__dirname);
const ROOT = path.join(__dirname, '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = [
  ...fs.readdirSync(TESTS).filter((f) => f === 'all.js' || f.endsWith('.test.js')).sort().map((f) => path.join(TESTS, f)),
  ...walk(path.join(ROOT, 'tools')),
];
check('there are suites and tools to check', files.length > 40, `${files.length} files`);
check('the tools are covered too', files.filter((f) => f.includes(`${path.sep}tools${path.sep}`)).length > 10,
  `${files.filter((f) => f.includes(`${path.sep}tools${path.sep}`)).length} tools`);

// Finds a live process-exit call of any spelling, with its line and column, without being fooled by prose.
//
// It works in two steps: mask the source, then match on the masked copy.
//   mask() returns a string the same length as the source in which every character that is not live code has
//   been replaced by a space (newlines kept, so line and column survive). Blanked: comments, string bodies,
//   regex literals, and the literal text of a template. KEPT: everything else, including the code inside a
//   template's ${ ... }, recursively, and the body of a string that is a property name in `process['exit']`.
// Matching on that cannot be fooled by a comment or a log line (blanked), and cannot be blinded by a regex
// containing quotes or a template with ${} in it - the two ways an earlier, state-machine version of this
// guard passed four live calls in tools/gen-page-preload.js.
// Covered: process.exit(, process . exit (, process['exit'](, process["exit"](, process [ 'exit' ] ( and
// process.reallyExit(. Not covered by any reading of source: `.call()` chaining and a value aliased into a
// variable (`const e = process.exit; e(1)`) - the runtime guard (tests/exitguard.test.js) catches those in a
// SUITE at run time. A tool has no runtime guard (see the note at the top), so for a tool these are simply
// out of reach of both checks, and this scan is all a tool gets.
function mask(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  // where a regex can start: after nothing, an operator, an opening bracket or a keyword - not after a value.
  // After `)` it depends: `f(x) / 2` is division, but `if (x) /re/.test(s)` begins a statement with a regex. So a
  // `)` that closes an if/while/for head allows one. This used to be a limit of the scan: it treated every `)` as
  // a value, so `if (ok) /['"]/.test(s)` read that quote as a string start and blanked the rest of the file -
  // hundreds of lines of code and any live call in them, silently.
  const regexCanStart = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    if (/[=(,:;[!&|?{}<>+\-*%~^]/.test(src[k])) return true;
    if (src[k] === ')') {                                  // walk back to the matching ( and look before it
      let depth = 0, j = k;
      for (; j >= 0; j--) {
        if (src[j] === ')') depth++;
        else if (src[j] === '(') { depth--; if (depth === 0) break; }
      }
      if (j < 0) return false;
      let b = j - 1;
      while (b >= 0 && /\s/.test(src[b])) b--;
      return /\b(if|while|for|with)$/.test(src.slice(Math.max(0, b - 6), b + 1));
    }
    return /\b(return|typeof|case|in|of|new|delete|void|instanceof|yield|await|do|else|throw)$/.test(src.slice(Math.max(0, k - 12), k + 1));
  };
  // scan code from `from`; when stopAtBrace, return the index just past the matching `}` that closes the ${}
  function scanCode(from, stopAtBrace) {
    let k = from, depth = 0;
    while (k < n) {
      const c = src[k], d = src[k + 1];
      if (c === '/' && d === '/') { const s = k; while (k < n && src[k] !== '\n') k++; blank(s, k); continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', k + 2); const end = e < 0 ? n : e + 2; blank(k, end); k = end; continue; }
      if (c === '/' && regexCanStart(k)) {
        let e = k + 1, inClass = false;
        while (e < n) { const ch = src[e]; if (ch === '\\') { e += 2; continue; } if (ch === '[') inClass = true; else if (ch === ']') inClass = false; else if (ch === '/' && !inClass) { e++; break; } else if (ch === '\n') break; e++; }
        while (e < n && /[a-z]/i.test(src[e])) e++;
        blank(k, e); k = e; continue;
      }
      if (c === '"' || c === "'") {
        let e = k + 1; while (e < n && src[e] !== c) { if (src[e] === '\\') e++; e++; }
        // keep the body only when it is the property name of a bracket access on process: process['exit'] or
        // process [ "exit" ], which masking the string would otherwise erase
        let b = k - 1; while (b >= 0 && /[ \t]/.test(src[b])) b--;
        const isPropName = src[b] === '[' && /process\s*$/.test(src.slice(Math.max(0, b - 40), b));
        if (!isPropName) blank(k + 1, e);
        k = Math.min(n, e + 1); continue;
      }
      if (c === '`') { k = scanTemplate(k + 1); continue; }
      if (c === '{') { depth++; k++; continue; }
      if (c === '}') { if (stopAtBrace && depth === 0) return k + 1; depth--; k++; continue; }
      k++;
    }
    return n;
  }
  // a template body: its literal text is blanked, but a ${ ... } inside it is code and stays. Like a quoted
  // string, a template that is the PROPERTY NAME in process[`exit`] must keep its text, or the bracket rule
  // could not see it - the same reason the quote branches check for a preceding `process[`.
  function scanTemplate(from) {
    // from is just past the opening backtick; walk back over whitespace (newlines included, so a property name
    // written across lines still counts) to the character before it
    let b = from - 2;
    while (b >= 0 && /\s/.test(src[b])) b--;
    const isPropName = src[b] === '[' && /process\s*$/.test(src.slice(Math.max(0, b - 40), b));
    let k = from, textFrom = from;   // start of the current run of literal template text
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') { if (!isPropName) blank(textFrom, k); return k + 1; }
      if (src[k] === '$' && src[k + 1] === '{') {
        if (!isPropName) blank(textFrom, k + 2);   // the literal text so far, and the "${" itself
        k = scanCode(k + 2, true);                 // the code inside ${ } is kept by the scan
        textFrom = k;                              // literal text resumes after the closing }
        continue;
      }
      k++;
    }
    if (!isPropName) blank(textFrom, n);
    return n;
  }
  scanCode(0, false);
  return out.join('');
}

function findExits(src) {
  const masked = mask(src);
  // line/column of an index
  const at = (idx) => { const before = masked.slice(0, idx).split('\n'); return { line: before.length, col: before[before.length - 1].length + 1 }; };
  const hits = [];
  // `process`, optionally reached through globalThis (`globalThis.process.exit(`), optionally with `?.` before
  // the property (`process?.exit(`), which is the same call when process is defined - always here. The `?.` can
  // also sit before the CALL (`process.exit?.(0)`), which is a different position and would otherwise be missed:
  // CALLQ is that suffix, and a plain `(` is the same thing without it.
  const OBJ = String.raw`(?:(?:globalThis|global|self|window)\s*\.\s*)?process`;
  const DOT = String.raw`(?:\s*\?\s*\.|\s*\.)`;
  const QOPEN = String.raw`(?:\s*\?\s*\.\s*)?\(`;      // `?.(` or plain `(`
  const CALL = new RegExp(String.raw`(?<![.\w$])${OBJ}${DOT}\s*(exit|reallyExit)\s*${QOPEN}`, 'g');
  // a bracket access, with a string or a template for the property name: process['exit'], process["exit"],
  // process[`ex${''}it`] is not worth supporting (the name is not literal); the plain template is.
  const BRACKET = new RegExp(String.raw`(?<![.\w$])${OBJ}\s*\[\s*(['"\`])exit\1\s*\]\s*${QOPEN}`, 'g');
  for (const [re, kind] of [[CALL, 'dot'], [BRACKET, 'bracket']]) {
    let m;
    while ((m = re.exec(masked))) {
      const { line, col } = at(m.index);
      const what = kind === 'dot' ? `process.${m[1]}(` : `process[${m[1]}exit${m[1]}](`;
      hits.push({ line, col, what });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.col - b.col);
}

// The single FAIL shape, shared with the runtime guard:
//   FAIL <file>: process.exit() called at <line>: <spelling>
// One line per offending file, so a scan that finds several names them all rather than summarising. Printed by
// hand because the harness prefixes its own "FAIL <check name>" and this shape puts the file first.
// Whether the MAIN scan skips a file. It skips none: the cross-check's exemption must not reach here, or a live
// call added to one of those files would be invisible to the guard itself. A self-test below holds this to it.
const scanSkips = () => false;
const offenderLines = [], unreadable = [];
for (const f of files) {
  if (scanSkips(f)) continue;
  let src;
  // Fail closed: a file the guard cannot read is reported and fails the gate. Skipping it would let a whole file
  // go unchecked while the run looked clean, which is the one way this guard could pass falsely.
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { unreadable.push(`${path.relative(ROOT, f)} (${e.code || e.message})`); continue; }
  const hits = findExits(src);
  if (hits.length) offenderLines.push(`${path.relative(ROOT, f)}: process.exit() called at ${hits[0].line}: ${hits[0].what}`);
}
for (const l of offenderLines) console.log(`FAIL ${l}`);
if (offenderLines.length) fail += offenderLines.length;   // each is a failure, so the run exits 1
check('no suite or tool calls process.exit()', offenderLines.length === 0,
  offenderLines.length ? `${offenderLines.length} file(s), named above` : `${files.length} files clean`);
check('every suite and tool could be read', unreadable.length === 0,
  unreadable.length ? `unreadable: ${unreadable.slice(0, 6).join(', ')}` : 'all readable');

// The guard must not be vacuous: it has to flag a real call, and leave a comment alone.
check('a real call is detected', findExits('if (bad) { process.exit(1); }').length === 1);
check('a spaced-out call is detected', findExits('process . exit (2)').length === 1);
check('a comment is not flagged', findExits('// process.exit(1)\nconst a = 1;').length === 0);
check('a block comment is not flagged', findExits('/* process.exit() */ const a = 1;').length === 0);
check('a string is not flagged', findExits('console.log("process.exit(1)");').length === 0);
check('a lookalike property is not flagged', findExits('obj.process.exit(1);').length === 0);
check('setting exitCode is not flagged', findExits('process.exitCode = fail ? 1 : 0;').length === 0);
// the spellings the plain regex missed: the walker has to reach them, or widening it would be a claim only
check("a bracket call is detected (process['exit'])", findExits("if (bad) process['exit'](1);").length === 1);
check('a double-quoted bracket call is detected', findExits('if (bad) process["exit"](1);').length === 1);
check('a spaced bracket call is detected', findExits("process [ 'exit' ] (1);").length === 1);
check('reallyExit is detected', findExits('process.reallyExit(1);').length === 1);
// the spellings reachable without an alias: optional chaining, a global prefix, and a template property name
check('optional chaining is detected (process?.exit)', findExits('process?.exit(1);').length === 1);
// `?.` before the CALL, not the property: a different position, and missed until it was pointed out
check('an optional call is detected (process.exit?.(0))', findExits('process.exit?.(0);').length === 1);
check('a spaced optional call is detected (process.exit ?. (0))', findExits('process.exit ?. (0);').length === 1);
check('an optional reallyExit is detected', findExits('process.reallyExit?.(1);').length === 1);
check('a bracket call with ?. before it is detected', findExits("process['exit']?.(1);").length === 1);
check('globalThis with an optional call is detected', findExits('globalThis.process.exit?.(1);').length === 1);
// a regex literal after `)`: `f(x) / 2` is division, but `if (ok) /re/.test(s)` starts a statement. Getting this
// wrong read the quote in /['"]/ as a string start and blanked the rest of the file, so a live call later in it
// was invisible. Both halves are pinned: the regex is blanked, and division is not.
check('a regex after an if ( ) with a quote class does not blind the scan', findExits(
  "if (ok) /['\"]/.test(s);\nconst a = 1;\nprocess.exit(1);").length === 1);
check('a regex after a while ( ) with a quote class does not blind the scan', findExits(
  "while (ok) /['\"]/.test(s);\nprocess.exit(1);").length === 1);
check('a regex after a for ( ) does not blind the scan', findExits(
  "for (;;) /['\"]/.test(s);\nprocess.exit(1);").length === 1);
check('division after a call is not treated as a regex', findExits(
  'const r = f(x) / 2;\nprocess.exit(1);').length === 1);
check('division after a paren group is not treated as a regex', findExits(
  'const r = (a + b) / 2;\nprocess.exit(1);').length === 1);
check('spaced optional chaining is detected', findExits('process ? . exit (1);').length === 1);
check('globalThis is detected', findExits('globalThis.process.exit(1);').length === 1);
check('globalThis with optional chaining is detected', findExits('globalThis.process?.exit(1);').length === 1);
check('a template property name is detected (process[`exit`])', findExits('process[`exit`](1);').length === 1);
check('a multi-line template used as a property name is detected', findExits('process[\n  `exit`\n](1);').length === 1);
check('a template merely naming the call is not flagged', findExits('const s = `process.exit(1)`;').length === 0);
check('a string naming a bracket call is not flagged', findExits('console.log("process[\'exit\'](1)");').length === 0);
check('the reported line is the call line', findExits('const a = 1;\nconst b = 2;\nprocess.exit(3);')[0].line === 3);
check('the reported column is the call column', findExits('const a = 1;\n  process.exit(3);')[0].col === 3);
// a bracket spelling inside prose is text, not a call: the case the string-stripping and the bracket rule fight over
check('a prose string naming a bracket call is not flagged',
  findExits('throw new Error("do not use process[\'exit\']( here");').length === 0);
check('a template string naming a bracket call is not flagged',
  findExits('const msg = `never process["exit"](`;').length === 0);
// and the FAIL line has that shape, with the file first
{
  const rel = 'tools/x.js';
  const line = `${rel}: process.exit() called at 12: process["exit"](`;
  check('the FAIL line puts the file first',
    new RegExp(`^FAIL ${rel.replace(/[.]/g, '\\.')}: process\\.exit\\(\\) called at 12: process\\["exit"\\]\\($`).test(`FAIL ${line}`), `FAIL ${line}`);
}

// Regressions: each of these made the guard pass a live call. They are the reason this is a lexer.
// A regex literal containing quotes used to start a "string" and swallow the rest of the file - this exact shape
// (a matchAll over a regex with ' and " in a character class, then a call) is from tools/gen-page-preload.js.
check('a call after a regex literal containing quotes is detected', findExits(
  "for (const m of text.matchAll(/(?:^|\\n)\\s*from\\s+['\"]([^'\"]+)['\"]/g)) { use(m); }\nprocess.exit(1);").length === 1);
check('a call after a regex with an escaped slash is detected', findExits("const r = /a\\/b/; process.exit(2);").length === 1);
// An APOSTROPHE inside a regex literal - the shape that made main's guard miss tests/registries.test.js, whose
// line 19 is /doesn't have \(constructor\)/ and whose process.exit is 20 lines further down. A scanner that reads
// the ' as a string start swallows the rest of the file. Both halves are pinned: the apostrophe is inert, and the
// call after it is still found.
check('an apostrophe inside a regex does not blind the scan', findExits(
  "check('x', e instanceof Error && /doesn't have \\(constructor\\)/.test(e.message));\nconst n = 1;\nprocess.exit(1);").length === 1);
check('an apostrophe inside a regex on the same line as the call is still found', findExits(
  "/doesn't/.test(s); process.exit(1);").length === 1);
check('a contraction in a log string does not blind the scan', findExits(
  'console.log("it doesn\'t matter");\nprocess.exit(1);').length === 1);
check('division after an identifier is not a regex', findExits('const half = total / 2; process.exit(1);').length === 1);
// A template with ${ } used to leave the lexer in string state for the rest of the file.
check('a call after a template containing ${} is detected', findExits('const s = `a ${x} b`;\nprocess.exit(1);').length === 1);
check('a call inside a ${} expression is detected', findExits('const s = `a ${process.exit(1)} b`;').length === 1);
check('a call after a nested template is detected', findExits('const s = `a ${ `b ${c}` } d`;\nprocess.exit(1);').length === 1);
check('a call after a template with a brace object inside ${} is detected',
  findExits('const s = `x ${ { a: 1 }.a } y`;\nprocess.exit(1);').length === 1);
check('a call after a multi-line template is detected', findExits('const s = `line1\nline2 ${x}\nline3`;\nprocess.exit(1);').length === 1);

// The exemption must apply to the CROSS-CHECK only: the main scan has to keep looking at those files, or a live
// call added to one of them would be invisible to the very guard that exists to catch it.
//
// The probe reads each file's REAL text and plants the call in the string, in memory - it never writes to the
// repository. Editing the file in place and restoring in a finally would leave a live process.exit behind on a
// SIGKILL or a timeout wrapper (KILL after TERM, and finally does not run), or show a parallel reader a file with
// a planted call in it. The planted line is `if (false) process.exit(0);`: never executed, so it cannot do
// anything, but a live call the lexer must see. A string would prove nothing.
{
  const guardFiles = ['exitcode.test.js', 'exitguard.test.js', 'no-exit.js'];
  const planted = 'if (false) process.exit(0);';
  const missed = [];
  for (const name of guardFiles) {
    const p = path.join(TESTS, name);
    if (!fs.existsSync(p)) continue;                    // exitguard.test.js and no-exit.js arrive with the other branch
    const original = fs.readFileSync(p, 'utf8');
    // the real text as it stands must scan clean (its calls are inside strings, which the lexer blanks)
    if (findExits(original).length !== 0) missed.push(`${name}: the file itself wrongly flagged`);
    // the same text with one live call planted at the end must be caught, at the line we planted it on
    const withCall = `${original}\n${planted}\n`;
    const hits = findExits(withCall);
    if (hits.length !== 1) missed.push(`${name}: planted live call not caught (found ${hits.length})`);
    else if (hits[0].line !== original.split('\n').length + 1) missed.push(`${name}: reported line ${hits[0].line}, planted on ${original.split('\n').length + 1}`);
  }
  check('the main scan catches a live call planted in every guard file\'s real text', missed.length === 0, missed.join('; '));
  // and the POLICY, which is what matters: the exemption must not reach the main scan, so no file may be
  // skipped there - checked through the same predicate the loop uses, not by re-reading findExits
  const skipped = guardFiles.filter((n) => scanSkips(path.join(TESTS, n)));
  check('the main scan skips no guard file (the exemption is the cross-check\'s only)', skipped.length === 0, skipped.join(', '));
}
//
// It is line-by-line on purpose. An earlier version ran its string/template patterns across the whole file with
// [\s\S], and a pair of backticks inside two REGEX LITERALS then swallowed everything between them - including a
// live call - so the cross-check went blind exactly where the guard had. Every pattern below is bounded to a
// single line, so a misread can blank one line and never a call on another. A count can still be too high (prose
// that this dumb stripper does not recognise) and the check allows that; it only fails when it is too LOW.
{
  const plain = (s) => s
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))                                  // a whole-line comment
    .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))                    // a trailing comment (not http://)
    .join('\n')
    .replace(/\/\*[^\n]*?\*\//g, '')                                     // a one-line block comment
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")                               // '...' on one line
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')                               // "..." on one line
    .replace(/`(?:\\.|[^`\\\n])*`/g, '``');                              // `...` on one line
  const GREP = /process\s*\.\s*exit\s*\(/g;
  // its own self-tests: the shapes that blinded an earlier version, and the ones it must not over-correct for
  const blindCases = [
    ['the gen-page-preload regex-with-quotes shape',
      "for (const m of text.matchAll(/(?:^|\\n)\\s*from\\s+['\"]([^'\"]+)['\"]/g)) { use(m); }\nprocess.exit(1);", 1],
    ['backticks inside two regex literals around a call',
      'const a = /[`]/;\nprocess.exit(1);\nconst b = /[`]/;', 1],
    ['a URL string and a call on one line', 'const u = "http://x"; process.exit(1);', 1],
    ['an apostrophe in a line comment', "// don't do this\nprocess.exit(1);", 1],
    ['a template spanning lines does not eat the call after it', 'const s = `a\nb\nc`;\nprocess.exit(1);', 1],
  ];
  const blind = blindCases.filter(([, src, want]) => (plain(src).match(GREP) || []).length < want).map(([n]) => n);
  check('the cross-check grep is not blinded by a regex or a spanning string', blind.length === 0, blind.join('; '));

  const short = [];
  for (const f of files) {
    if (skipCrossCheck(f)) continue;                   // see CROSS_CHECK_SKIP above
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const grepCount = (plain(src).match(GREP) || []).length;
    const ours = findExits(src).length;
    if (ours < grepCount) short.push(`${path.relative(ROOT, f)}: guard ${ours}, grep ${grepCount}`);
  }
  check('the guard finds at least as many calls as a plain grep, in every file', short.length === 0, short.slice(0, 4).join('; '));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
