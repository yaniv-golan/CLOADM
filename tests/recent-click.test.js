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
  // the module imports SessionError from ../session.js (for loadRow's "gone from the list" error): the import lines
  // are stripped here, so the real class is handed in, or the error would not be the type the page reports on its
  // own message line rather than in the console.
  return new Function('SessionError', `${src}\nreturn { recentRows, loadRow };`)(Emu.SessionError);
})();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const prog = (b, n) => Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${Array(n).fill(`$${b}`).join(',')}\nL BRA L\n END`, '6809'));
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
  check('recent click: a click loads the row\'s own file', s.shownMachine.ram[0x3000] === 0xBB, `$${s.shownMachine.ram[0x3000].toString(16)}`);
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
  check('recent click: after the list shifted, the click still loads the file the row named', s.shownMachine.ram[0x3000] === 0xAA, `$${s.shownMachine.ram[0x3000].toString(16)} want $aa (the row\'s index ${aRow.i} now holds c.bin)`);
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
  check('recent click: a row of a replaced name still loads the bytes it named', s.shownMachine.ram[0x3000] === 0xAA, `$${s.shownMachine.ram[0x3000].toString(16)} want $aa (the new a.bin is $ee)`);
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
  // and the error is a SessionError, which is what makes page.attempt put it on the drawer's message line instead
  // of also logging it as an unexpected error (js/ui/page.js attempt)
  let err = null;
  try { drawer.loadRow(s, rows[0]); } catch (e) { err = e; }
  check('recent click: "gone from the list" is a SessionError (the drawer reports it, the console does not)', err instanceof Emu.SessionError, err && err.constructor.name);
}

// 5. the row's name is compared by the SESSION's rule (Session.sameName: the store's own case rule), not by ===.
// A store that does not tell cases apart has one entry for "GAME.DSK" and "game.dsk"; a row drawn from one spelling
// must find the entry -- the same way every guard in the Session compares names.
{
  const ci = fresh({ media: new MemoryMediaStore({ caseInsensitive: true }) });   // a case-folding store, as APFS is
  ci.load('GAME.BIN', prog('AA', 2), { remember: true });
  const rows = drawer.recentRows(ci.recentMedia(), 'dragon64');
  const row = rows.find((x) => x.r.name === 'GAME.BIN');
  const other = { r: Object.assign({}, row.r, { name: 'game.bin' }), i: row.i };   // the same entry, other spelling
  let loaded = null;
  try { drawer.loadRow(ci, other); loaded = ci.personMachine.ram[0x3000]; } catch (e) { loaded = e.message; }
  check('recent click: a row found under another spelling of its name loads (names by Session.sameName, not ===)',
    loaded === 0xAA, String(loaded));
  // the control: a case-SENSITIVE store (two names), the same row is not the same file, and says so
  const cs = fresh();
  cs.load('GAME.BIN', prog('AA', 2), { remember: true });
  const csRow = drawer.recentRows(cs.recentMedia(), 'dragon64').find((x) => x.r.name === 'GAME.BIN');
  let msg = null;
  try { drawer.loadRow(cs, { r: Object.assign({}, csRow.r, { name: 'game.bin' }), i: csRow.i }); } catch (e) { msg = e.message; }
  check('recent click: on a case-sensitive store the two spellings are two names, so the stale row says it is gone',
    /no longer in the recent list/.test(String(msg)), String(msg));
}

console.log(fail ? `${fail} FAILED` : 'all recent-click checks passed');
process.exitCode = fail ? 1 : 0;
