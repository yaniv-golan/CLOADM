// tools/affected.js: the fast-loop table as data. Every file under js/ maps to at least one suite or group; every
// suite pattern selects a suite and every group is one the browser check has; the rows that are in docs/development.md's
// table say exactly what the table says; and the answer for a sample diff is the one worked out by hand below.
// Run: node tests/affected.test.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { AREAS, SMOKE, affected } = require('../tools/affected.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && !f.startsWith('fixture-'));
const groups = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'browser-check.js'), '--list-groups'], { encoding: 'utf8', timeout: 30000 })
  .split('\n').map((l) => l.trim()).filter(Boolean);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// every file under js/, as the repository has it
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const jsFiles = walk('js');
const orphans = jsFiles.filter((f) => { const r = affected([f]); return !r.suites.length && !r.groups.length; });
check('every file under js/ maps to at least one suite or browser-check group', jsFiles.length > 150 && orphans.length === 0,
  orphans.length ? orphans.join(' ') : `${jsFiles.length} files`);

// the data's names are real
const badPats = [], badGroups = [];
for (const a of AREAS) {
  for (const p of a.suites) if (!suites.some((f) => f.includes(p))) badPats.push(p);
  for (const g of a.groups) if (!groups.includes(g)) badGroups.push(g);
}
for (const g of SMOKE) if (!groups.includes(g)) badGroups.push(`SMOKE ${g}`);
check('every suite pattern in the data selects a suite', badPats.length === 0, badPats.join(' '));
check('every group in the data (and in SMOKE) is a browser-check group', groups.length > 10 && badGroups.length === 0, badGroups.join(' '));

// the table rows, cell for cell (the same reader as tests/fastloop.test.js: the first backquoted list of a cell)
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'development.md'), 'utf8');
const section = (/^## The fast loop\n([\s\S]*?)\n## /m.exec(doc) || [])[1] || '';
const rows = section.split('\n').filter((l) => /^\| /.test(l) && !/^\| You changed|^\|---/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
const list = (cell) => { const m = /`([^`]+)`/.exec(cell); return m ? m[1].split(',').map((p) => p.trim()).filter(Boolean) : []; };
const docRows = new Map(rows.map(([what, s, g]) => [what, { suites: list(s), groups: list(g) }]));
const dataRows = AREAS.filter((a) => a.row);
const missing = [...docRows.keys()].filter((k) => !dataRows.some((a) => a.row === k));
const extra = dataRows.filter((a) => !docRows.has(a.row)).map((a) => a.row);
const differ = dataRows.filter((a) => docRows.has(a.row)).filter((a) => !same(a.suites, docRows.get(a.row).suites) || !same(a.groups, docRows.get(a.row).groups)).map((a) => a.row);
check('every row of the fast-loop table is in the data, and no data row claims one that is not', rows.length >= 15 && !missing.length && !extra.length,
  `${missing.length ? `missing: ${missing.join(' | ')} ` : ''}${extra.length ? `not in the table: ${extra.join(' | ')}` : ''}`);
check('...and each says the same suites and groups as the table', differ.length === 0, differ.join(' | '));

// a sample diff, the expected answer worked out from the table by hand:
//   js/cpu/cpu6809.js   -> the CPU row
//   js/ui/tape-panel.js -> the cassette row + the UI row (its panel's groups are known: no smoke set)
//   css/tokens.css      -> the UI row + the smoke set (no row knows its panel)
//   CHANGELOG.md        -> changelog
//   tests/zip.test.js   -> itself
//   notes/todo.txt      -> unmapped
{
  const r = affected(['js/cpu/cpu6809.js', 'js/ui/tape-panel.js', 'css/tokens.css', 'CHANGELOG.md', 'tests/zip.test.js', 'notes/todo.txt']);
  check('sample diff: the suites', same(r.suites, ['cpu', 'opcodes', 'disasm', 'asm', 'nmi-arm', 'regress', 'tape', 'session', 'readme', 'screen-alternative', 'changelog', 'zip']),
    r.suites.join(','));
  check('sample diff: the groups', same(r.groups, ['models', 'cpu6309', 'tape', 'tapePanel', 'tapeHud', 'semantics', 'pwa', 'uiQa', 'layout']), r.groups.join(','));
  check('sample diff: the file no row knows is named', same(r.unmapped, ['notes/todo.txt']) && r.notes.some((n) => n.includes('notes/todo.txt')), r.notes.join(' | '));
  const t = affected(['js/ui/tape-panel.js']);
  check('a UI file whose panel is known gets its groups, not the smoke set', !t.groups.includes('uiQa') && t.groups.includes('tapePanel'), t.groups.join(','));
  const m = affected(['js/ui/main.js']);
  check('a UI file no panel row knows gets the smoke set', SMOKE.every((g) => m.groups.includes(g)), m.groups.join(','));
}

// the command line, on a scratch git repository: a committed change and an untracked file, against the first commit
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-'));
  const git = (...a) => cp.execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
    fs.mkdirSync(path.join(dir, 'js', 'asm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'js', 'asm', 'x.js'), '');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'change');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '');                // untracked
    const out = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'affected.js'), 'HEAD~1'], { cwd: dir, encoding: 'utf8' });
    check('the command line: the --only commands for a diff plus an untracked file',
      out.includes('node tests/all.js --only changelog,asm,includes,disasm\n') && out.includes('node tools/browser-check.js --only debugger\n'), JSON.stringify(out));
    const bad = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'affected.js'), 'no-such-ref'], { cwd: dir, encoding: 'utf8' });
    check('the command line: a base git does not know is an error (exit 2), not an empty answer', bad.status === 2 && /failed/.test(bad.stderr), `status ${bad.status}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
