// docs/roms.md is generated from the profiles by tools/gen-rom-docs.js; this fails when it is out of date,
// and checks that the check itself catches a stale file and that the doc covers every socket.
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const GEN = path.join(__dirname, '../tools/gen-rom-docs.js');
const run = (...args) => cp.spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });

const r = run('--check');
check('docs/roms.md is up to date (run node tools/gen-rom-docs.js)', r.status === 0, (r.stderr || '').trim());

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'romdocs-')), 'roms.md');
run('--out', tmp);
const doc = fs.readFileSync(tmp, 'utf8');
fs.writeFileSync(tmp, doc.replace('Required', 'Requried'));
check('the check fails on a stale file', run('--check', '--out', tmp).status === 1);
fs.rmSync(path.dirname(tmp), { recursive: true });

const missing = [];
for (const p of Object.values(Emu.profiles).concat(Object.values(Emu.cartridgeRoms))) {
  if (!doc.includes(`### ${p.name}`)) missing.push(p.name);
  for (const s of p.roms) for (const n of s.files.concat(s.aliases, s.crcs)) if (!doc.includes(`\`${n}\``)) missing.push(`${p.name}: ${n}`);
}
check('every machine, socket name, alias and CRC is in the doc', !missing.length, missing.join(', '));
check('the doc warns about the buggy BASIC revisions', /bas10\.rom.*bas11\.rom/.test(doc) && /extbas10\.rom/.test(doc));
check('the doc points at the /roms page, never at the archive\'s ROM folder', /\(https:\/\/cloadm\.dev\/roms\/\)/.test(doc) && !/colorcomputerarchive\.com\/repo\/ROMs/i.test(doc));
// the /roms page's machine table is generated with the doc: every model, with its sockets
{
  const page = fs.readFileSync(path.join(__dirname, '../roms/index.html'), 'utf8');
  const rows = [...page.matchAll(/<tr><td>([^<]+)<\/td><td>([^<]*)<\/td>/g)];
  check('the /roms page table has every machine and its required ROMs', rows.length === Object.keys(Emu.profiles).length
    && Object.values(Emu.profiles).every((p) => rows.some((r) => r[1] === p.name.replace(/&/g, '&amp;') && p.roms.filter((s) => s.required).every((s) => r[2].includes(s.label)))));
}

// the README's per-machine table is generated with the doc: same rows
{
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const m = readme.match(/<!-- rom-table:start[^>]*-->\n([\s\S]*?)\n<!-- rom-table:end -->/);
  check('README ROM table is the generated one (same rows as docs/roms.md)', !!m && doc.includes(m[1]) && Object.values(Emu.profiles).every((p) => m[1].includes(`| ${p.name} |`)));
  const stale = readme.replace('-->\n| Machine |', '-->\n| Model |');   // inside the generated block
  fs.writeFileSync(path.join(__dirname, '../README.md'), stale);
  const r2 = run('--check');
  fs.writeFileSync(path.join(__dirname, '../README.md'), readme);
  check('the check fails on a stale README table', r2.status === 1 && /README\.md/.test(r2.stderr));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
