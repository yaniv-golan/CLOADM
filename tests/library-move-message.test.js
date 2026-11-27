// Run: node tests/library-move-message.test.js
//
// The message MediaLibrary.moveMedia's merge step fails with. js/library.js copyMedia merges the index's lists into
// the new store (session.index.mergeInto) and turns any failure into a mediaError naming what could not be written:
//
//     throw this.mediaError(e, 'the ROM and recent lists');
//
// mediaError then prefixes the item's name to the store's own reason, so the person reads exactly
//
//     the ROM and recent lists: <the store's reason>
//
// The page shows that text verbatim (js/ui/library.js choose(): `page.status(e.message, true)`), so the wording is
// what a person sees when a library move fails at the merge. This test pins that text, so a reworded item cannot
// silently change what the page says: mutate any word of 'the ROM and recent lists' and it goes red.
//
// The failure is injected by a store whose write of the two index lists throws, measured against an otherwise green
// baseline: the same move into a store that does not fail succeeds and shows nothing. That baseline is asserted
// here too, so a message change cannot be mistaken for a move that never reached the merge.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// a memory store whose write of the index's lists fails with a store reason, as a full or read-only backend would
class WriteRefusingStore extends Emu.MemoryMediaStore {
  writeSync(name, bytes) {
    if (name === 'roms/sockets.json' || name === 'roms/names.json') throw new Emu.MediaStoreError('permission', `${name}: the folder refused the write`);
    return super.writeSync(name, bytes);
  }
  // moveMedia's copy step is async; the merge goes through the async write, so refuse it there too
  async write(name, bytes) {
    if (name === 'roms/sockets.json' || name === 'roms/names.json') throw new Emu.MediaStoreError('permission', `${name}: the folder refused the write`);
    return super.writeSync(name, bytes);
  }
}

const bin = new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]);
const rom = (seed) => Uint8Array.from({ length: 0x4000 }, (_, i) => (i * seed + 7) & 0xFF);

(async () => {
  // ---- the exact text the page shows when the merge fails ----
  {
    const from = new Emu.MemoryMediaStore(), to = new WriteRefusingStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    s.switchMachine('dragon64');
    s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }]);
    await s.library.importMedia('HELLO.BIN', bin);
    await s.index.flush();
    let e = null;
    try { await s.library.moveMedia(to); } catch (x) { e = x; }
    // measured, not computed: the message the page would print (the store's own reason follows the item's name,
    // and mediaError has no stored name to strip here, so the backend's path stays in the reason)
    check('merge failure: the page is given exactly "the ROM and recent lists: <the store\'s reason>"',
      !!e && e.message === 'the ROM and recent lists: roms/sockets.json: the folder refused the write', e && JSON.stringify(e.message));
    // the exact wording itself, so a reworded item is caught even if the reason changed with it
    check('merge failure: the item is named "the ROM and recent lists"',
      !!e && /^the ROM and recent lists: /.test(e.message), e && JSON.stringify(e.message));
  }

  // ---- the baseline: the same move into a store that does not fail succeeds and reports no error ----
  // Without this, the checks above could pass on a move that never reached the merge.
  {
    const from = new Emu.MemoryMediaStore(), to = new Emu.MemoryMediaStore();
    const s = new Emu.Session({ store: Emu.memoryStore(), media: from });
    await s.ready();
    s.switchMachine('dragon64');
    s.addRoms([{ name: 'd64_1.rom', bytes: rom(3) }]);
    await s.library.importMedia('HELLO.BIN', bin);
    await s.index.flush();
    let e = null, r = null;
    try { r = await s.library.moveMedia(to); } catch (x) { e = x; }
    check('control: the same move into a store that does not fail succeeds', !e && !!r, e && e.message);
    check('control: and the ROM and recent lists did reach the new store', !!(await to.stat('roms/sockets.json')) && !!(await to.stat('roms/names.json')));
  }

  console.log(`${n - fail}/${n} library move message checks passed`);
  if (fail) process.exitCode = 1;
})().then(() => {}, (e) => { console.log(`FAIL library move message ${e.stack}`); process.exitCode = 1; });
