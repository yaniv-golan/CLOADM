// The Media tab's "Recent on this machine" list: what makes two loads one entry, what makes two, and what a
// row's click loads.
//
// Identity is the NAME (case-folded, the store's own rule via Session.sameName) plus the CONTENT HASH. So:
//  - the same name and bytes loaded twice is one entry (the newest);
//  - the same name with DIFFERENT bytes is two real entries, because each keeps and loads its own bytes
//    (measured: the older row's loadRecent returns its own program, not the newer one's);
//  - a re-named copy of the same bytes keeps its own entry (the hash alone would swallow it);
//  - a name that differs only in case is the same file.
// Stored CRCs are normalised when the list is READ, so a list an older build wrote heals.
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { crc32 } = require('../js/util.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const show = (s) => s.recentMedia().map((r) => `${r.name}#${r.crc}${r.copy ? '*' : ''}`).join(' | ') || '(empty)';
const bytes = (s) => new TextEncoder().encode(s);

// a session on a fresh machine; `media` lets a test plant a stored list before the session reads it
const session = ({ media = new MemoryMediaStore() } = {}) => {
  const s = new Emu.Session({ store: Emu.memoryStore(), media, welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  return s;
};
// distinct programs with distinct first bytes AND lengths, so a wrong row shows in RAM as well as in the list
const progA = Emu.toBinary(Emu.assemble(' ORG $3000\n FCB $AA,$AA\nL BRA L\n END', '6809'));
const progB = Emu.toBinary(Emu.assemble(' ORG $3000\n FCB $BB,$BB,$BB,$BB,$BB\nL BRA L\n END', '6809'));

// ---- 1. the same file loaded twice is one entry ----
{
  const s = session();
  s.load('2048.bin', progA);
  s.load('2048.bin', progA);
  check('recent: the same name and bytes loaded twice is one entry', s.recentMedia().length === 1, show(s));
}

// ---- 2. RED on main: an older build's lower-case CRC is the same file, not a second entry ----
{
  const media = new MemoryMediaStore();
  const crc = crc32(progA), lower = crc.toLowerCase();
  media.writeSync('recent/list.json', bytes(JSON.stringify([
    { name: '2048.bin', crc: lower, size: progA.length, machine: 'dragon64', stored: true },
  ])));
  media.writeSync(`recent/${lower}.bin`, progA);
  // READ first, before any load: the CRC is normalised as the stored list is read (an entry an older build
  // wrote lower case comes back upper case, so it can never be a second identity for the same blob)
  const raw = session({ media });
  check('recent: the CRC of a stored entry is normalised to upper case as the list is read',
    raw.recentMedia().length === 1 && raw.recentMedia()[0].crc === crc, show(raw));
  const s = session({ media });
  s.load('2048.bin', progA);
  const r = s.recentMedia();
  check('recent: an entry stored with a lower-case CRC is the same file, not a second one', r.length === 1, show(s));
  check('recent: the CRC read back is normalised to upper case', r.length === 1 && r[0].crc === crc, show(s));
}

// ---- 3. the same name with DIFFERENT bytes: two real entries ----
{
  const s = session();
  s.load('2048.bin', progA);
  s.load('2048.bin', progB);
  const r = s.recentMedia();
  check('recent: the same name with different bytes is two entries', r.length === 2, show(s));
  check('recent: the newest is first', r.length === 2 && r[0].crc === crc32(progB), show(s));
  // each row loads its own bytes: this is WHY both rows are honest rather than one lying about the other
  const newest = session({ media: s.media });
  newest.loadRecent(0);
  check('recent: the newest row loads the newest bytes', newest.machine.ram[0x3000] === 0xBB, `$${newest.machine.ram[0x3000].toString(16)}`);
  const older = session({ media: s.media });
  older.loadRecent(1);
  check('recent: the older row loads its OWN bytes, not the newer ones', older.machine.ram[0x3000] === 0xAA, `$${older.machine.ram[0x3000].toString(16)}`);
}

// ---- 4. the two rows of one name are told apart ----
{
  const s = session();
  s.load('2048.bin', progA);
  s.load('2048.bin', progB);
  const r = s.recentMedia();
  check('recent: of two same-name entries the newest is unlabelled and the older is told apart',
    r.length === 2 && r[0].copy === false && r[1].copy === '2nd', JSON.stringify(r.map((x) => [x.name, x.copy])));
  // a single entry of a name is not labelled a copy
  const one = session();
  one.load('2048.bin', progA);
  check('recent: a name with one entry is not labelled a copy', one.recentMedia()[0].copy === null);
  // three of one name: the second and third are told apart, and a fourth would be "older copy"
  const progC = Emu.toBinary(Emu.assemble(' ORG $3000\n FCB $CC,$CC,$CC,$CC,$CC,$CC\nL BRA L\n END', '6809'));
  const three = session();
  for (const p of [progA, progB, progC]) three.load('2048.bin', p);
  const t = three.recentMedia();
  check('recent: three of one name are labelled newest, 2nd, 3rd',
    t.length === 3 && t[0].copy === false && t[1].copy === '2nd' && t[2].copy === '3rd', JSON.stringify(t.map((x) => x.copy)));
}

// ---- 5. a re-named copy of the same bytes keeps its own entry ----
{
  const s = session();
  s.load('mine.bin', progA);
  s.load('renamed.bin', progA);
  const r = s.recentMedia();
  check('recent: a re-named copy of the same bytes is its own entry',
    r.length === 2 && r.map((x) => x.name).sort().join() === 'mine.bin,renamed.bin', show(s));
}

// ---- 6. the name is compared by the store's case rule ----
// On a store that tells cases apart (a Map, ext4) two spellings are two files, and that is what these check.
// The folding itself is the store's own rule and is exercised on a store that declares it (caseInsensitive).
{
  const s = session();
  s.load('2048.bin', progA);
  s.load('2048.BIN', progA);
  check('recent: on a store that tells cases apart, two spellings are two files', s.recentMedia().length === 2, show(s));
  const ci = new MemoryMediaStore({ caseInsensitive: true });
  const t = session({ media: ci });
  t.load('2048.bin', progA);
  t.load('2048.BIN', progA);
  check('recent: on a store that does not tell cases apart, a case-only difference is the same file', t.recentMedia().length === 1, show(t));
  const u = session({ media: new MemoryMediaStore({ caseInsensitive: true }) });
  u.load('2048.bin', progA);
  u.load('2048.BIN', progB);
  check('recent: a case-only difference with other bytes is still two entries (identity needs the hash too)',
    u.recentMedia().length === 2 && u.recentMedia().map((x) => x.name).join() === '2048.BIN,2048.bin', show(u));
}

// ---- 7. a replaced entry's file goes, so the list and its files agree ----
{
  const s = session();
  const oldCrc = crc32(progA);
  s.load('2048.bin', progA);
  s.load('2048.bin', progA);   // the same file again: one entry, and its blob is rewritten, not orphaned
  check('recent: reloading the same file leaves ONE blob and the list agrees with it',
    s.recentMedia().length === 1 && s.media.listSync('recent/').filter((f) => f.name.endsWith('.bin')).length === 1,
    s.media.listSync('recent/').map((f) => f.name).join(','));
  // a different file of the same name keeps its own blob: both rows are real, so both must be stored
  s.load('2048.bin', progB);
  const blobs = s.media.listSync('recent/').filter((f) => f.name.endsWith('.bin')).map((f) => f.name);
  check('recent: two same-name entries keep their own blobs (neither row is left pointing at nothing)',
    s.recentMedia().length === 2 && blobs.includes(`recent/${oldCrc}.bin`) && blobs.includes(`recent/${crc32(progB)}.bin`), blobs.join(','));
}

// ---- 8. still the last 5, and only their files ----
{
  const s = session();
  for (let i = 0; i < 7; i++) s.load(`p${i}.bin`, Emu.toBinary(Emu.assemble(` ORG $3000\n FCB ${i}\nL BRA L\n END`, '6809')));
  const blobs = s.media.listSync('recent/').filter((f) => f.name.endsWith('.bin'));
  check('recent: still the last 5, and only their files', s.recentMedia().length === 5 && blobs.length === 5,
    `${s.recentMedia().length} entries, ${blobs.length} blobs`);
}

// ---- 9. a lower-case CRC in the stored list does not leave a file behind when the file is loaded again ----
{
  const media = new MemoryMediaStore();
  const crc = crc32(progA), lower = crc.toLowerCase();
  media.writeSync('recent/list.json', bytes(JSON.stringify([
    { name: '2048.bin', crc: lower, size: progA.length, machine: 'dragon64', stored: true },
  ])));
  // the blob is stored under the UPPER-case CRC, as this and every current build writes it: the lower-case
  // entry in the list is the old spelling of the same key, not a different file
  media.writeSync(`recent/${crc}.bin`, progA);
  const s = session({ media });
  s.load('2048.bin', progA);
  check('recent: the healed entry still loads (its bytes are found under the normalised CRC)', /2048\.bin/.test(s.loadRecent(0)) && s.machine.ram[0x3000] === 0xAA);
}

console.log(fail ? `${fail} FAILED` : 'all recent checks passed');
process.exit(fail ? 1 : 0);
