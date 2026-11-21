// The Media tab's "Recent on this machine": a row must load the file it NAMES.
//
// The rows are built from one copy of the list and the click resolves the row's index. recentMedia() hands out
// COPIES, so resolving the index against a second call (all.indexOf(r)) matched nothing and was always -1:
// every row loaded nothing and reported "That file is no longer stored in this browser; load it again." This
// checks the index a row carries points at that row's own entry, which is what the page's handler uses.
//
// The page's DOM handler is exercised end to end in the browser check (tools/browser-check.js, the media
// group); this pins the arithmetic the handler depends on, on the Session's own data.
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore(), welcomeMenu: false });
s.switchMachine('dragon64', {}, { menu: false });
// three files, and one more on ANOTHER machine, so the drawer's per-machine filter has something to skip
const prog = (b, n) => Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${Array(n).fill(`$${b}`).join(',')}\nL BRA L\n END`, '6809'));
s.load('a.bin', prog('AA', 2));
s.load('b.bin', prog('BB', 3));
s.load('c.bin', prog('CC', 4));
s.switchMachine('coco', {}, { menu: false });
s.load('other.bin', prog('DD', 5));
s.switchMachine('dragon64', {}, { menu: false });

// what drawer.js does, in the form that works and in the form that was there
const all = s.recentMedia();
const rows = all.map((r, i) => ({ r, i })).filter((x) => x.r.machine === 'dragon64');

check('recent rows: the drawer shows this machine\'s entries, newest first', rows.map((x) => x.r.name).join() === 'c.bin,b.bin,a.bin', rows.map((x) => x.r.name).join());
check('recent rows: each row\'s index points at that row\'s own entry in the full list',
  rows.every((x) => all[x.i].name === x.r.name && all[x.i].crc === x.r.crc), JSON.stringify(rows.map((x) => [x.i, x.r.name, all[x.i].name])));
check('recent rows: the other machine\'s entry is not shown', !rows.some((x) => x.r.name === 'other.bin'));

// the OLD form: an index looked up in a second call never matches, so every row got -1
const oldRows = s.recentMedia().filter((r) => r.machine === 'dragon64').map((r) => ({ r, i: all.indexOf(r) }));
check('recent rows: looking an index up in a second call matches nothing (the -1 that broke every row)',
  oldRows.every((x) => x.i === -1), JSON.stringify(oldRows.map((x) => x.i)));

// and the index each row carries really loads that row's file
for (const x of rows) {
  const t = new Emu.Session({ store: Emu.memoryStore(), media: s.media, welcomeMenu: false });
  t.switchMachine('dragon64', {}, { menu: false });
  t.loadRecent(x.i);
  const want = x.r.name === 'a.bin' ? 0xAA : x.r.name === 'b.bin' ? 0xBB : 0xCC;
  check(`recent rows: row ${x.i} (${x.r.name}) loads its own bytes`, t.machine.ram[0x3000] === want, `$${t.machine.ram[0x3000].toString(16)} want $${want.toString(16)}`);
}

console.log(fail ? `${fail} FAILED` : 'all recent-row checks passed');
process.exitCode = fail ? 1 : 0;   // (suites never call process.exit: tests/no-exit.js guards it)
