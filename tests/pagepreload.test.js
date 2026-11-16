// play/index.html carries a generated <link rel="modulepreload"> list for /play/'s module graph
// (tools/gen-page-preload.js), so the browser learns about all of the page's modules from the HTML instead
// of one round trip per level of imports. This fails when the list is stale, when it names a module that
// does not exist, when a module the page starts with is missing from it, or when it includes something the
// page only reaches through import() (preloading that would undo the lazy import).
const cp = require('child_process'), fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const GEN = path.join(__dirname, '../tools/gen-page-preload.js');
const PAGE = path.join(__dirname, '../play/index.html');
const run = (...args) => cp.spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });

const r = run('--check');
check('the modulepreload list is up to date (run node tools/gen-page-preload.js)', r.status === 0, (r.stderr || '').trim());

// the list, as the browser sees it
const html = fs.readFileSync(PAGE, 'utf8');
const list = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);

check('every preloaded module exists', list.every((f) => fs.existsSync(path.join(__dirname, '..', f))),
  list.filter((f) => !fs.existsSync(path.join(__dirname, '..', f))).join(', '));
check('the entry module is not preloaded (its own <script> already requests it)', !list.includes('js/ui/main.js'));
check('no duplicates', new Set(list).size === list.length);

// every module the page reaches through static imports must be there: walk the graph here, independently
// of the generator, so a generator bug cannot make both sides agree
{
  const see = new Set(), order = [];
  const visit = (rel) => {
    const abs = path.join(__dirname, '..', rel);
    if (see.has(abs) || !fs.existsSync(abs)) return;
    see.add(abs);
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (m[1].startsWith('.')) visit(path.relative(path.join(__dirname, '..'), path.resolve(path.dirname(abs), m[1])));
    }
    order.push(rel);
  };
  visit('js/ui/main.js');
  const expected = order.filter((f) => f !== 'js/ui/main.js').sort();
  check('the list is exactly the static graph', JSON.stringify([...list].sort()) === JSON.stringify(expected),
    `missing: ${expected.filter((f) => !list.includes(f)).join(', ') || '-'} extra: ${list.filter((f) => !expected.includes(f)).join(', ') || '-'}`);
}

// a module reached only through import() must NOT be preloaded: that would defeat the lazy import
{
  const dyn = [];
  for (const f of list.concat('js/ui/main.js')) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) if (m[1].startsWith('.')) dyn.push(m[1]);
  }
  const lazy = dyn.filter((d) => list.some((f) => path.basename(f) === path.basename(d).replace(/^.*\//, '') && f.endsWith(d.replace(/^\.\.\//, ''))));
  check('nothing reachable only through import() is preloaded', lazy.length === 0, lazy.join(', '));
}

// and the check itself catches a stale list (the rom-docs test does the same for its doc)
{
  const saved = fs.readFileSync(PAGE, 'utf8');
  const stale = saved.replace('<link rel="modulepreload" href="js/util.js">', '');
  fs.writeFileSync(PAGE, stale);
  const bad = run('--check');
  fs.writeFileSync(PAGE, saved);
  check('the check fails on a stale list', bad.status === 1 && /out of date/.test(bad.stderr), (bad.stderr || '').trim());
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
