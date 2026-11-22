// A click on a Recent row loads the file that row NAMED, even when the list changed between drawing and clicking.
//
// DEFENSIVE, not a shipped bug, and that is deliberate to state: in the real page the list changes only through
// Session.load(), which changes it synchronously and then emits 'loaded', and the drawer redraws its rows on
// 'loaded', 'machine' and 'roms' -- so the rows are rebuilt before a click can use a stale index. I could not find
// a page path that shifts the list without a redraw (no background store write, no cross-tab eviction: the drawer
// listens to THIS page's Session, and every rememberMedia call is inside load()). This test pins the contract the
// handler depends on anyway, so a future list change that does not redraw cannot turn a click into the wrong file.
//
// The rows are built by js/ui/drawer.js's recentRows and clicked through its loadRow -- the code the drawer runs, not
// a copy. Both are DOM-free, so this runs in the fast Node gate; the page's handler is exercised in the browser check.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

// evaluate the module's source without its page.js import (no DOM here), then use its real exports
const drawer = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../js/ui/drawer.js'), 'utf8')
    .replace(/^import .*$/mg, '').replace(/^export /mg, '');
  return new Function(`${src}\nreturn { recentRows, loadRow };`)();
})();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const prog = (b, n) => Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${Array(n).fill(`$${b}`).join(',')}\nL BRA L\n END`, '6809'), { format: 'dragondos' });
const fresh = ({ media = new MemoryMediaStore(), store = Emu.memoryStore() } = {}) => {
  const s = new Emu.Session({ store, media, welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  return s;
};

// 1. the plain case: a click loads the row's own file
{
  const s = fresh();
  s.load('a.bin', prog('AA', 2));
  s.load('b.bin', prog('BB', 3));
  const rows = drawer.recentRows(s.recentMedia(), 'dragon64');
  drawer.loadRow(s, rows.find((x) => x.r.name === 'b.bin'));
  check('recent click: a click loads the row\'s own file', s.machine.ram[0x3000] === 0xBB, `$${s.machine.ram[0x3000].toString(16)}`);
}

// 2. the list CHANGES between drawing the rows and clicking one: another load pushes every row down one. The old
// index would now point at a different file; the click must still load the file the row named.
{
  const s = fresh();
  s.load('a.bin', prog('AA', 2));
  s.load('b.bin', prog('BB', 3));
  const rows = drawer.recentRows(s.recentMedia(), 'dragon64');   // drawn now: b.bin at index 0, a.bin at 1
  s.load('c.bin', prog('CC', 4));                                // the list shifts: c.bin 0, b.bin 1, a.bin 2
  const aRow = rows.find((x) => x.r.name === 'a.bin');
  drawer.loadRow(s, aRow);
  check('recent click: after the list shifted, the click still loads the file the row named', s.machine.ram[0x3000] === 0xAA, `$${s.machine.ram[0x3000].toString(16)} want $aa (the row\'s index ${aRow.i} now holds c.bin)`);
}

// 3. a same-name entry replaced by different bytes while the drawer is open: the row is stale. It must not load the
// NEW bytes silently as if they were the ones it named (both have the name, so identity is name+crc+machine).
{
  const s = fresh();
  s.load('a.bin', prog('AA', 2));
  s.load('keep.bin', prog('99', 2));
  const rows = drawer.recentRows(s.recentMedia(), 'dragon64');
  const oldA = rows.find((x) => x.r.name === 'a.bin');
  s.load('a.bin', prog('EE', 5));                                // the same name, new bytes: a different entry
  // the row named the OLD a.bin: it is still in the list (as the "2nd" copy), so the click must load ITS bytes
  drawer.loadRow(s, oldA);
  check('recent click: a row of a replaced name still loads the bytes it named', s.machine.ram[0x3000] === 0xAA, `$${s.machine.ram[0x3000].toString(16)} want $aa (the new a.bin is $ee)`);
}

// 4. evicted while the drawer is open: nothing can be loaded, and it must say so rather than load a neighbour
{
  const s = fresh();
  s.load('old.bin', prog('AA', 2));
  const rows = drawer.recentRows(s.recentMedia(), 'dragon64');
  for (let i = 1; i <= 5; i++) s.load(`n${i}.bin`, prog(30 + i, 3));   // evicts old.bin
  let msg = null;
  try { drawer.loadRow(s, rows[0]); } catch (e) { msg = e.message; }
  check('recent click: a row evicted while the drawer is open says the file is gone (loads no neighbour)',
    !!msg && /no longer (stored|in the recent list)/.test(msg), String(msg));
}

console.log(fail ? `${fail} FAILED` : 'all recent-click checks passed');
process.exitCode = fail ? 1 : 0;
