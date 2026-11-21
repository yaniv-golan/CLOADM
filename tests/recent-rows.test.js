// The Media tab's "Recent on this machine": a row must load the file it NAMES.
//
// The rows are built by `recentRows` in js/ui/drawer.js, which is imported here: this exercises the code the drawer
// runs, not a copy of its arithmetic. The index must come from the SAME list the row was drawn from -- recentMedia()
// hands out copies, so an index looked up in a second call with indexOf() matches nothing and is always -1, which
// made every row say "That file is no longer stored in this browser; load it again."
//
// The page's DOM handler is exercised end to end in the browser check (tools/browser-check.js, media group).
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
// js/ui/drawer.js imports js/ui/page.js, which needs a document; load only the symbol under test by evaluating the
// module's source with the import replaced, so the test runs the REAL exported function and not a stand-in.
const fs = require('fs'), path = require('path');
const { recentRows } = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../js/ui/drawer.js'), 'utf8')
    .replace(/^import .*$/mg, '').replace(/^export /mg, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { recentRows };`)();
})();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore(), welcomeMenu: false });
s.switchMachine('dragon64', {}, { menu: false });
const prog = (b, n) => Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${Array(n).fill(`$${b}`).join(',')}\nL BRA L\n END`, '6809'));
s.load('a.bin', prog('AA', 2));
s.load('b.bin', prog('BB', 3));
s.load('c.bin', prog('CC', 4));
s.switchMachine('coco', {}, { menu: false });
s.load('other.bin', prog('DD', 5));
s.switchMachine('dragon64', {}, { menu: false });

// The drawer calls recentMedia() and nothing else: pass a FRESH copy, exactly as it gets one, so a row's index is
// resolved against a list of different objects -- which is what made indexOf -1 for every row.
const rows = recentRows(s.recentMedia(), 'dragon64');
const all = s.recentMedia();   // the same call again, as the drawer's handler does for loadRecent

check('recent rows: the drawer shows this machine\'s entries, newest first', rows.map((x) => x.r.name).join() === 'c.bin,b.bin,a.bin', rows.map((x) => x.r.name).join());
check('recent rows: each row\'s index points at that row\'s own entry in the full list',
  rows.every((x) => all[x.i].name === x.r.name && all[x.i].crc === x.r.crc), JSON.stringify(rows.map((x) => [x.i, x.r.name, all[x.i].name])));
check('recent rows: the other machine\'s entry is not shown', !rows.some((x) => x.r.name === 'other.bin'));

// The bug was in the HANDLER, not in the row builder: it resolved each click's index with all.indexOf(r) against a
// SECOND recentMedia() call, whose objects are different -- always -1 (shown here, for the record). So the handler
// must not recompute an index: it uses the one recentRows gave it. This reads the drawer's own source for that.
{
  const drawerSrc = fs.readFileSync(path.join(__dirname, '../js/ui/drawer.js'), 'utf8');
  const body = /function recent\(\)[\s\S]*?\n  \}/.exec(drawerSrc);
  const oldRows = s.recentMedia().filter((r) => r.machine === 'dragon64').map((r) => ({ r, i: all.indexOf(r) }));
  check('recent rows: an index looked up against a second call is -1 (the bug this pins)', oldRows.every((x) => x.i === -1), JSON.stringify(oldRows.map((x) => x.i)));
  check('recent rows: the drawer does not recompute an index for a click (no indexOf in its recent handler)',
    !!body && !/indexOf\s*\(/.test(body[0]) && /loadRecent\(i\)/.test(body[0]), body ? (body[0].match(/loadRecent\([^)]*\)/) || ['?'])[0] : 'handler not found');
}

// and the index each row carries really loads that row's file
for (const x of rows) {
  const t = new Emu.Session({ store: Emu.memoryStore(), media: s.media, welcomeMenu: false });
  t.switchMachine('dragon64', {}, { menu: false });
  t.loadRecent(x.i);
  const want = x.r.name === 'a.bin' ? 0xAA : x.r.name === 'b.bin' ? 0xBB : 0xCC;
  check(`recent rows: row ${x.i} (${x.r.name}) loads its own bytes`, t.machine.ram[0x3000] === want, `$${t.machine.ram[0x3000].toString(16)} want $${want.toString(16)}`);
}

console.log(fail ? `${fail} FAILED` : 'all recent-row checks passed');
process.exitCode = fail ? 1 : 0;
