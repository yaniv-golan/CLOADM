// connector/fold.js's comment stripper (strip, over its tokenizer, tokens), which squeezes the side panel's inline view:
//  * hand-built tricky inputs with their outputs written by hand: URLs in strings, // and /* */ inside strings,
//    regexes (classes included) and templates, nested templates and braces inside ${ }, division against a regex start
//    (after a value, after ) and ], after if (…), after return / typeof, after a property named like a keyword), line
//    ends kept where automatic semicolon insertion needs them (a removed /* */ comment that held one included),
//    indentation, trailing spaces and blank lines removed, and what does not end throwing;
//  * the whole corpus: every module the inline view folds (connector/view/panel.js's graph) is tokenized losslessly,
//    its stripped form keeps every token and every line break between tokens, holds no comment, is stable when
//    stripped again, and parses as a module in V8 (vm.SourceTextModule, in a child process);
//  * mutants of the tokenizer (every / a division, template nesting ignored, line ends dropped, …), each built from a
//    copy of fold.js, must turn these checks red.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const FOLD = path.join(ROOT, 'connector/fold.js');

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;

// [name, input, expected output]: the expected outputs are written by hand
const CASES = [
  ['a URL in a string', "const u = 'https://x.dev/a'; // site\n", "const u = 'https://x.dev/a';\n"],
  ['/* and */ in strings', 'const s = "/* not */ a"; /* c */ f(\'*/\');\n', 'const s = "/* not */ a"; f(\'*/\');\n'],
  ['a comment before the first token and after the last', "/* a */ const s = '*/'; /* b */\n// end\n", "const s = '*/';\n"],
  ['an escaped quote', "const s = 'it\\'s // not'; // yes\n", "const s = 'it\\'s // not';\n"],
  ['a string continued over a line', "const s = 'a\\\n// not a comment'; // c\n", "const s = 'a\\\n// not a comment';\n"],
  ['${ in a plain string', "const s = '${'; // c\nconst t = '}';\n", "const s = '${';\nconst t = '}';\n"],
  ['// in a regex', 'const r = /https?:\\/\\//g; // r\n', 'const r = /https?:\\/\\//g;\n'],
  ['/ in a regex class, then divisions', 'const r = /[/]+/; x = a / b / c; // d\n', 'const r = /[/]+/; x = a / b / c;\n'],
  ['a / in a regex class, then *', 'x = /[/]*/; // c\n', 'x = /[/]*/;\n'],
  ['/* in a regex after return', 'function f(s) { return /\\/*x/.test(s) } // e\n', 'function f(s) { return /\\/*x/.test(s) }\n'],
  ['division after a closing )', 'const h = (a + b) / 2 /* half */ / c; // d\n', 'const h = (a + b) / 2 / c;\n'],
  ['division after ] and after a number', 'x = v[1] / 2 // a\n/ 3; y = 1 / 2 /* c */ / 3;\n', 'x = v[1] / 2\n/ 3; y = 1 / 2 / 3;\n'],
  ['a regex after the ) of if (…)', 'if (ok) /x\\/\\//.test(s); // c\n', 'if (ok) /x\\/\\//.test(s);\n'],
  ['a regex after typeof', 'const k = typeof /\\/\\// // c\n', 'const k = typeof /\\/\\//\n'],
  ['a regex after a statement-ending }', 'function f() {}\n/re\\/\\//.test(x) // t\n', 'function f() {}\n/re\\/\\//.test(x)\n'],
  ['division after a property named return', 'const q = o.return / 2 // n\n/ 3;\n', 'const q = o.return / 2\n/ 3;\n'],
  ['division after ++', 'a++ / 2 // c\n/ 3;\n', 'a++ / 2\n/ 3;\n'],
  ['/= after a name', 'x /= 2; // c\n', 'x /= 2;\n'],
  ['a comment between typeof and its operand', 'const t = typeof/**/x;\n', 'const t = typeof x;\n'],
  ['// and /* */ as template text', 'const t = `a // b /* c */ ${d}`; // e\n', 'const t = `a // b /* c */ ${d}`;\n'],
  ['a nested template, with a } string and a // string in ${ }',
    'const t = `a // b ${x ? `c /* ${\'}\'} */` : "//"} d`; // e\n', 'const t = `a // b ${x ? `c /* ${\'}\'} */` : "//"} d`;\n'],
  ['a regex right after ${', 'const t = `${/\\/\\//.source}`; // c\n', 'const t = `${/\\/\\//.source}`;\n'],
  ['an object, a regex and a comment inside ${ }', 'const t = `${ { a: 1 }.a /* c */ }//${ /\\/\\//.source }`;\n', 'const t = `${ { a: 1 }.a }//${ /\\/\\//.source }`;\n'],
  ['a template over lines keeps its own spaces and blank lines', 'const t = `a  \n\n  // b  \n`;   // c\n', 'const t = `a  \n\n  // b  \n`;\n'],
  ['a line end inside a removed block comment stays (return ASI)', 'function g() { return /* a\nb */ 42 }\n', 'function g() { return\n42 }\n'],
  ['a whole-line comment between two lines keeps one line end (++ ASI)', 'a = b\n// c\n++c\n', 'a = b\n++c\n'],
  ['indentation, trailing spaces and blank lines go', '\n\n  if (a) {   \n\t\tb();  \n\n  }\n', 'if (a) {\nb();\n}\n'],
  ['spaces that keep operators apart stay', 'a + +b; c - -d; e = f /* g */ - -h;\n', 'a + +b; c - -d; e = f - -h;\n'],
  ['CRLF line ends', 'a = 1 // c\r\nb = 2\r\n', 'a = 1\nb = 2\n'],
];
const THROWS = [['an unterminated string', "const s = 'abc\n"], ['an unterminated template', 'const t = `abc ${x}'], ['an unterminated regex', 'x = /abc\n'],
  ['an unclosed ${', 'const t = `a ${ b `'], ['a stray }', 'a }'], ['an unterminated comment', 'a /* b']];

// what the checks find wrong with a fold.js module (the real one, or a mutant): [label, ok, detail]
async function suite(mod, { corpus = true } = {}) {
  const res = [];
  for (const [name, input, want] of CASES) {
    let got; try { got = mod.strip(input); } catch (e) { got = `threw ${e.message}`; }
    res.push([`case: ${name}`, got === want, J({ got, want })]);
  }
  for (const [name, input] of THROWS) {
    let threw = false; try { mod.strip(input); } catch { threw = true; }
    res.push([`throws: ${name}`, threw]);
  }
  if (!corpus) return res;
  const { files } = mod.fold(path.join(ROOT, 'connector/view/panel.js'), { stripComments: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-fold-test-'));
  const bad = { lossless: [], tokens: [], comments: [], stable: [], threw: [] }, out = [];
  // the significant tokens, each marked with whether a line break came before it (in whitespace or a comment)
  const sig = (src) => { const r = []; let nl = false; for (const t of mod.tokens(src)) { if (t.type === 'ws' || t.type === 'comment') nl = nl || /[\n\r\u2028\u2029]/.test(t.text); else { r.push((nl && r.length ? '\n' : '') + t.text); nl = false; } } return r; };
  let before = 0, after = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f), src = fs.readFileSync(f, 'utf8');
    try {
      const toks = mod.tokens(src);
      if (toks.map((t) => t.text).join('') !== src) bad.lossless.push(rel);
      const s = mod.strip(src);
      before += src.length; after += s.length;
      if (J(sig(src)) !== J(sig(s))) bad.tokens.push(rel);
      if (mod.tokens(s).some((t) => t.type === 'comment')) bad.comments.push(rel);
      if (mod.strip(s) !== s) bad.stable.push(rel);
      const p = path.join(dir, `${out.length}.mjs`); fs.writeFileSync(p, s); out.push([rel, p]);
    } catch (e) { bad.threw.push(`${rel}: ${e.message}`); }
  }
  // V8 parses each stripped module (as a module: import, export, import.meta and top-level await allowed)
  const parse = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', `
    const vm = require('vm'), fs = require('fs'), bad = [];
    for (const [rel, p] of ${J(out)}) { try { new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { identifier: rel }); } catch (e) { bad.push(rel + ': ' + e.message); } }
    process.stdout.write(JSON.stringify(bad));`], { encoding: 'utf8', maxBuffer: 1 << 24 }));
  fs.rmSync(dir, { recursive: true, force: true });
  res.push([`corpus: ${files.length} modules tokenize without error`, files.length > 50 && !bad.threw.length, J(bad.threw)]);
  res.push(['corpus: tokens(src) gives back every character (lossless)', !bad.lossless.length, J(bad.lossless)]);
  res.push(['corpus: stripped, every module keeps every token and every line break between tokens', !bad.tokens.length, J(bad.tokens)]);
  res.push(['corpus: stripped, no module holds a comment, and stripping again changes nothing', !bad.comments.length && !bad.stable.length, J([bad.comments, bad.stable])]);
  res.push(['corpus: every stripped module parses as a module in V8', out.length === files.length && !parse.length, J(parse).slice(0, 600)]);
  res.push([`corpus: stripping saves at least a tenth (${before} -> ${after} characters)`, after > 0 && after < before * 0.9, `${before} -> ${after}`]);
  return res;
}

// [name, the text in fold.js, its replacement]
const MUTANTS = [
  ['every / is a division', "else if (c === '/' && regexAllowed())", "else if (c === '/' && false)"],
  ['template nesting ignored (${ does not open code)', "else if (c === '$' && src[k + 1] === '{') { braces.push('tmpl'); return push('tmpl', k + 2); }", ''],
  ['line ends dropped between tokens', "out += LT.test(gap) ? '\\n' : gap ? ' ' : '';", "out += gap ? ' ' : '';"],
  ['spaces dropped between tokens', "out += LT.test(gap) ? '\\n' : gap ? ' ' : '';", "out += LT.test(gap) ? '\\n' : '';"],
  ['a / after ) always divides', "prev.text === ')' ? prev.cond :", "prev.text === ')' ? false :"],
  ['no keyword takes a regex', "const BEFORE_EXPR = new Set([", "const BEFORE_EXPR = new Set([]); const UNUSED = (["],
  ['a property named like a keyword takes a regex', "&& !(prev2 && (prev2.text === '.' || prev2.text === '?.'))", ''],
  ['a regex class may not hold a /', "if (e === '[') cls = true; else if (e === ']') cls = false; else ", ''],
  ['escapes in strings ignored', "if (src[k] === '\\\\') k += src[k + 1] === '\\r' && src[k + 2] === '\\n' ? 3 : 2;\n        else ", ''],
  ['a regex may not follow ${', "if (prev.type === 'tmpl') return prev.text.endsWith('${');", ''],
  ['every } closes a ${', "if (braces.pop() === 'tmpl') templ(i + 1);", "if (braces.pop() || true) templ(i + 1);"],
];

(async () => {
  const mod = await import(pathToFileURL(FOLD).href);
  for (const [name, ok, detail] of await suite(mod)) check(name, ok, detail);

  // the fold itself strips with it: no comment is left in the folded inline view's modules, and the view is smaller
  const plain = mod.fold(path.join(ROOT, 'connector/view/panel.js'), { stripComments: false }).code, stripped = mod.fold(path.join(ROOT, 'connector/view/panel.js')).code;
  check('fold: the folded view strips its modules (only the fold\'s own // ---- markers and header remain as comments)',
    mod.tokens(stripped).filter((t) => t.type === 'comment').every((t) => /^\/\/ (----|CLOADM, folded)/.test(t.text)) && stripped.length < plain.length * 0.9, `${plain.length} -> ${stripped.length}`);

  const src = fs.readFileSync(FOLD, 'utf8'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-fold-mutant-'));
  try {
    for (const [name, from, to] of MUTANTS) {
      const at = src.split(from).length - 1;
      if (at !== 1) { check(`mutant "${name}": its text is in fold.js exactly once`, false, `${at} times`); continue; }
      const p = path.join(dir, `m${MUTANTS.findIndex((m) => m[0] === name)}.js`);
      fs.writeFileSync(p, src.replace(from, to));
      let red;
      try { red = (await suite(await import(pathToFileURL(p).href))).filter(([, ok]) => !ok).map(([l]) => l); } catch (e) { red = [`threw ${e.message}`]; }
      check(`mutant "${name}" turns the checks red`, red.length > 0, '');
      console.log(`       red: ${red.length ? red.join("; ") : 'nothing'}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`${n - fail}/${n} fold checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
