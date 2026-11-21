// Two rows can share ONE blob: a renamed copy of the same bytes keeps its own entry (the name differs, the CRC
// does not), so `recent/<CRC>.bin` backs both rows. Eviction drops the oldest entry and its file -- but the file
// may still be the only copy for a surviving row. Dropping it leaves that row pointing at nothing: `stored: true`,
// and a click says "no longer stored", across reloads.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { crc32 } = require('../js/util.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const prog = (n) => Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${Array(n).fill('$11').join(',')}\nL BRA L\n END`, '6809'));
const A = prog(2);
const session = ({ media = new MemoryMediaStore(), store = Emu.memoryStore() } = {}) => {
  const s = new Emu.Session({ store, media, welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  return s;
};
const blobs = (media) => media.listSync('recent/').filter((f) => f.name.endsWith('.bin')).map((f) => f.name.toUpperCase());

// the review's exact sequence: mine.bin (A), p1..p3, renamed.bin (A), p4 -> mine.bin is evicted, A must survive
{
  const media = new MemoryMediaStore();
  const s = session({ media });
  s.load('mine.bin', A);
  s.load('p1.bin', prog(3));
  s.load('p2.bin', prog(4));
  s.load('p3.bin', prog(5));
  s.load('renamed.bin', A);          // the same bytes under another name: its own row, the same blob
  s.load('p4.bin', prog(6));         // evicts mine.bin (the oldest)
  const rows = s.recentMedia();
  const renamed = rows.find((r) => r.name === 'renamed.bin');
  check('eviction: the renamed copy keeps its row', !!renamed, JSON.stringify(rows.map((r) => r.name)));
  check('eviction: and its bytes were not deleted with the evicted entry', !!renamed && renamed.stored, JSON.stringify(renamed));
  check('eviction: the blob for the shared bytes is still in the store', blobs(media).includes(`RECENT/${crc32(A)}.BIN`), blobs(media).join(','));
  // and it still loads, across a reload
  const s2 = session({ media, store: s.store });
  const idx = s2.recentMedia().findIndex((r) => r.name === 'renamed.bin');
  let loaded = false;
  try { s2.loadRecent(idx); loaded = true; } catch (e) { loaded = false; }
  check('eviction: after a reload the renamed copy still loads', loaded && s2.machine.ram[0x3000] === 0x11);
}

// evicting the LAST reference to a CRC must still delete its file (no leak)
{
  const media = new MemoryMediaStore();
  const s = session({ media });
  s.load('only.bin', A);
  for (let i = 1; i <= 5; i++) s.load(`q${i}.bin`, prog(10 + i));
  check('eviction: the last reference to a blob does delete its file', !blobs(media).includes(`RECENT/${crc32(A)}.BIN`), blobs(media).join(','));
}

// A list an older build wrote may hold a LOWER-CASE crc, with the blob stored under that lower-case name on a
// store that tells cases apart. The read normalises the CRC to upper case; the DELETE must still remove the file
// that is actually there, or the lower-case blob is orphaned and stays in the store for ever.
{
  const media = new MemoryMediaStore();   // case-SENSITIVE: recent/<lower>.bin and recent/<UPPER>.bin are two files
  const a = prog(7);
  const crc = crc32(a), lower = crc.toLowerCase();
  media.writeSync('recent/list.json', new TextEncoder().encode(JSON.stringify([
    { name: 'old.bin', crc: lower, size: a.length, machine: 'dragon64', stored: true },
  ])));
  media.writeSync(`recent/${lower}.bin`, a);
  const s = session({ media });
  check('old list: the lower-case entry still loads (read normalises the CRC)', /old\.bin/.test(s.loadRecent(0)) && s.machine.ram[0x3000] === 0x11);
  // loading five more files evicts old.bin; its file must go, whichever case it is stored under
  for (let i = 1; i <= 5; i++) s.load(`z${i}.bin`, prog(20 + i));
  // the file it was stored as is `recent/<lower>.bin`: assert on THAT name, not on an upper-cased listing
  const left = media.listSync('recent/').map((f) => f.name);
  check('old list: evicting it removes the lower-case file it was actually stored as',
    !left.includes(`recent/${lower}.bin`) && !left.includes(`recent/${crc}.bin`), left.join(','));
}

console.log(fail ? `${fail} FAILED` : 'all recent-shared checks passed');
process.exitCode = fail ? 1 : 0;
