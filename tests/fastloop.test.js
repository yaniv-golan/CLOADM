// docs/development.md's "The fast loop" table must not rot: every suite pattern in it selects at least one suite
// (as `node tests/all.js --only` would), and every browser-check group it names is a group the check has
// (`node tools/browser-check.js --list-groups`). The commands in AGENTS.md's "Start here" name real files.
// Run: node tests/fastloop.test.js
const fs = require('fs'), path = require('path'), cp = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'development.md'), 'utf8');
const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && !f.startsWith('fixture-'));
const groups = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'browser-check.js'), '--list-groups'], { encoding: 'utf8', timeout: 30000 })
  .split('\n').map((l) => l.trim()).filter(Boolean);

const section = (/^## The fast loop\n([\s\S]*?)\n## /m.exec(doc) || [])[1] || '';
const rows = section.split('\n').filter((l) => /^\| /.test(l) && !/^\| You changed|^\|---/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
check('the fast-loop table is there, with a row per area', rows.length >= 15, `${rows.length} rows`);
// the comma lists inside the first backquoted span of a cell
const list = (cell) => { const m = /`([^`]+)`/.exec(cell); return m ? m[1].split(',').map((p) => p.trim()).filter(Boolean) : []; };
const badPats = [], badGroups = [];
for (const [what, s, g] of rows) {
  const pats = list(s);
  if (!pats.length) badPats.push(`${what}: no suites`);
  for (const p of pats) if (!suites.some((f) => f.includes(p))) badPats.push(`${what}: ${p}`);
  for (const gr of list(g)) if (!groups.includes(gr)) badGroups.push(`${what}: ${gr}`);
}
check('every suite pattern selects at least one suite', badPats.length === 0, badPats.join(' | '));
check('every browser-check group named is one the check has', groups.length > 10 && badGroups.length === 0, badGroups.join(' | '));
// not vacuous: the same readers reject a pattern and a group that do not exist
check('...and a made-up pattern or group would be caught', !suites.some((f) => f.includes('nosuchsuite')) && !groups.includes('noSuchGroup')
  && list('`a,b`').length === 2);

// AGENTS.md "Start here": every repository file its commands run exists
const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const start = (/^## Start here\n([\s\S]*?)\n## 1\. /m.exec(agents) || [])[1] || '';
const files = [...start.matchAll(/^node ((?:tests|tools|cli)\/[\w./-]+\.js)/gm)].map((m) => m[1]);
const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('AGENTS.md "Start here" lists its commands, and every script they run exists', files.length >= 8 && missing.length === 0,
  missing.length ? missing.join(' ') : `${files.length} commands`);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
