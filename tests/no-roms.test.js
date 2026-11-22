// No copyrighted ROM, or ROM-derived data, in the repository -- checked against the project's own known-good CRC
// table, so the check grows with the table and nothing is retyped here.
//
// Every TRACKED file (git ls-files, so nothing untracked, no browser store, nothing outside the tree) is examined:
//   - the WHOLE file, at ANY size (there is no size prefilter: the rule is never retired for a small file): if its
//     CRC32 is one of the known-good ROM CRCs it is a ROM, whatever size it is (a patched dump, a ROM pasted into a
//     fixture). FAIL, naming the file;
//   - and every ROM-sized window at 2 KB alignment (each of the table's own sizes), because a ROM embedded in a
//     larger container -- a listing, a test fixture, a data file -- would not be the whole file. A window's CRC
//     matching is the same evidence. Offset 0 counts: an image at the head of a container is embedded too, and the
//     whole-file check cannot see it (the file is longer than the ROM).
// SCOPE, stated so the check is not read as more than it is: windows are tried at 2 KB alignment and, on files small
// enough to be one ROM behind a short header, at 16/128/256/512/1024 bytes too. A ROM placed at any other unaligned
// offset of a LARGE container -- 3000 bytes into a 4 MB blob, say -- is not looked for: covering every byte offset
// would cost a CRC pass per byte. The whole-file check catches a file that IS the ROM whatever its offset rules are.
//
// The CRC table comes from the machine and cartridge profiles (js/machines/profiles.js), and from the modules that
// hold a known-good CRC as a bare constant outside them: js/machines/carts.js (ORCH90_CRC) and js/selftest.js
// (KNOWN, three Dragon ROMs). All are read from source, never retyped. The CRC function is js/util.js's crc32, the
// one the ROM identification uses. Neither is duplicated here.
//
// Run: node tests/no-roms.test.js
const fs = require('fs'), path = require('path'), cp = require('child_process');
const Emu = require('./load')();
const ROOT = path.join(__dirname, '..');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the known-good CRC table, from the profiles (never retyped) ----
// tableFrom() takes the two source objects so a synthetic one can be fed through the SAME code path below: a loop
// that is never reached would otherwise look exactly like a table with nothing in it.
//   profiles:   { id: { roms: [slot, ...] } }            (a machine's slots)
//   cartridges: { id: { roms: [slot, ...] } }            (a cartridge's slots -- `roms` IS its slot array: each entry
//                                                         is slot(...) at js/machines/profiles.js, there is no
//                                                         second `roms` inside it, and reading r.roms there found
//                                                         nothing at all while every loop looked fine)
// `seen` counts the SLOTS each class visited, so a class whose loop never runs is visible even while its CRCs are
// empty (every cartridge slot is CRC-less today: they are matched by name until the dumps are known).
// `extra` is the CRC the cartridge module recognises a board by (ORCH90_CRC in js/machines/carts.js): it is a
// known-good ROM CRC the profile table does not carry, so it is added under its own name.
function tableFrom(profiles, cartridges, extra = []) {
  const table = new Map();   // CRC (upper-case hex) -> a description, for the failure message
  const seen = { machines: 0, cartridges: 0 };
  const add = (slots, key, cls) => {
    for (const s of slots || []) {
      seen[cls]++;
      for (const c of s.crcs || []) table.set(String(c).toUpperCase(), `${key}/${s.id}`);
    }
  };
  for (const [key, p] of Object.entries(profiles || {})) add(p.roms, key, 'machines');
  for (const [key, c] of Object.entries(cartridges || {})) add(c.roms, key, 'cartridges');
  for (const [crc, where] of extra) table.set(String(crc).toUpperCase(), where);
  return { table, seen };
}
// Known-good ROM CRCs that live OUTSIDE the profile table, as bare constants in the modules that use them:
// js/machines/carts.js's ORCH90_CRC and js/selftest.js's KNOWN map (three Dragon ROMs). A scan that read only the
// profiles would pass on every one of them, so they are read here, from source. A missing constant is an ERROR rather
// than a silently smaller table: that is how the scan would come to miss a ROM the project already knows.
const CARTS = path.join(__dirname, '..', 'js', 'machines', 'carts.js');
const SELFTEST = path.join(__dirname, '..', 'js', 'selftest.js');
function outsideProfileCrcs() {
  const carts = fs.readFileSync(CARTS, 'utf8'), selftest = fs.readFileSync(SELFTEST, 'utf8');
  const orch = /^const ORCH90_CRC = '([0-9A-Fa-f]{8})';/m.exec(carts);
  const known = /^const KNOWN = \{([\s\S]*?)^\};/m.exec(selftest);
  const crcs = [];
  if (orch) crcs.push([orch[1], 'carts/orch90']);
  if (known) for (const m of known[1].matchAll(/'([0-9A-Fa-f]{8})'\s*:/g)) crcs.push([m[1], 'selftest/known']);
  return crcs;
}
const romTable = () => tableFrom(Emu.profiles, Emu.cartridgeRoms, outsideProfileCrcs());
// The sizes the scan tries: the profile table's own ROM sizes. Every size is the size of a ROM whose CRC the table
// holds, so a window the scan tries is a window a real ROM could occupy. (The Orchestra-90 image is 8K, which some
// profile slot already contributes; it adds no size of its own, and nothing here claims it does.)
function sizesFrom(profiles, cartridges) {
  const sizes = new Set();
  for (const p of Object.values(profiles || {})) for (const s of p.roms || []) if (s.size) sizes.add(s.size);
  for (const c of Object.values(cartridges || {})) for (const s of c.roms || []) if (s.size) sizes.add(s.size);
  return [...sizes].sort((a, b) => a - b);
}
const romSizes = () => sizesFrom(Emu.profiles, Emu.cartridgeRoms);

// The tracked file list. A checkout without .git (a tarball, an extracted download) cannot answer, and "no files" must
// never read as "no ROMs found": git's own failure is turned into an object that says so, and the caller FAILS.
// `cwd` is a parameter so the failure path is checked against directories that really are not the repository root.
//
// `git ls-files` at one directory, with no policy. Split out so the no-git path is checked on its own: through
// trackedFiles() a non-repository directory is refused by the root check before git is ever run, which would leave
// git's own failure path untested (and an untested path is where "no files" would come to read as "no ROMs").
function lsFilesAt(dir) {
  try {
    return cp.execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
  } catch (e) {
    return { error: ((e.stderr || '') + '').trim().split('\n').pop() || e.message };
  }
}
// The root matters as much as the .git, and it is the CWD that has to be the root, not merely git's top level.
// Run from a SUBDIRECTORY of the repository, `git ls-files` succeeds -- git's top level is the root either way --
// but lists only that subdirectory's files: one tracked file or none. That short (or empty) list is what the scan
// would read as "no ROMs found". So the list is trusted only when the cwd really is ROOT; anything else is an error,
// never a short or empty list.
function trackedFiles(cwd = ROOT) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
  if (real(cwd) !== real(ROOT)) return { error: `${cwd} is not the repository root` };
  return lsFilesAt(cwd);
}
// The header lengths a small container commonly puts before a ROM image (a .bin with an offset, a listing with a
// short preamble). Windows are also tried at these offsets, on files small enough to BE a ROM in a small container
// -- see the scope note at the top of this file for what is and is not covered.
const HEADER_OFFSETS = [16, 128, 256, 512, 1024];
// A file above this cannot be a single ROM behind a short header, so the extra passes are skipped (measured: trying
// them on every file takes ~1.7 s; on files this small, ~0.95 s for the whole suite).
const HEADER_SCAN_MAX = 2 * 32768 + 2048;

// every ROM-sized, aligned window of `bytes` whose CRC is in the table -> [{ offset, size, where }]
function scan(bytes, table, sizes, offsets = [0]) {
  const hits = [];
  for (const size of sizes) {
    if (size > bytes.length) continue;
    for (const base of offsets) {
      for (let off = base; off + size <= bytes.length; off += 2048) {
        const where = table.get(Emu.crc32(bytes.subarray(off, off + size)));
        if (where) hits.push({ offset: off, size, where });
      }
    }
  }
  return hits;
}

// Every known-good ROM in one file, as the repository scan judges it: the WHOLE file at any size (a dump that is not
// one of the table's sizes), plus every ROM-sized aligned window inside it (a ROM embedded in a larger container).
// Offset 0 is a hit like any other: a ROM at the head of a longer container is embedded, and the whole-file check
// cannot see it -- that file is longer than the ROM, so its CRC is not the ROM's.
// This is ONE function, used by the repository scan below and by the detector's own checks, so a defect here (the
// `if (h.offset)` filter this replaced dropped every offset-0 window and no check could see it) is caught by a check
// and not only by what happens to be in the tree. A window that IS the whole file (offset 0, file exactly ROM-sized)
// repeats the whole-file hit, so it is not listed twice.
function hitsIn(bytes, table, sizes) {
  const out = [];
  const whole = table.get(Emu.crc32(bytes));
  if (whole) out.push({ offset: null, size: bytes.length, where: whole });
  const offsets = [0, ...(bytes.length <= HEADER_SCAN_MAX ? HEADER_OFFSETS : [])];
  for (const h of scan(bytes, table, sizes, offsets)) if (!(h.offset === 0 && h.size === bytes.length && whole)) out.push(h);
  return out;
}

// The repository scan itself: every tracked file, through hitsIn (the one path the checks below also use), so what
// is measured here is what a clean run means. `table`/`sizes` are parameters so a synthetic table can be run through
// the very loop a real scan uses -- a "the scan would catch X" check that re-implements the loop proves nothing
// about it.
const ORCH = (outsideProfileCrcs().find(([, where]) => where === 'carts/orch90') || [null])[0];
function scanRepo(list, table, sizes) {
  const hits = [];
  for (const f of list) {
    const abs = path.join(ROOT, f);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }   // (a tracked file not in the working copy: nothing to read)
    if (!st.isFile()) continue;
    // No size prefilter. The header promises the WHOLE file at any size, and a prefilter would silently retire that
    // rule for every file below the smallest ROM -- a rule never run on a file could be broken without a red check.
    for (const h of hitsIn(fs.readFileSync(abs), table, sizes)) {
      hits.push(h.offset === null ? `${f} (whole file, ${h.size} bytes, ${h.where})` : `${f} @${h.offset} (${h.size} bytes, ${h.where})`);
    }
  }
  return hits;
}

// ---- the repository ----
{
  const { table, seen } = romTable(), sizes = romSizes();
  // The table must be real: a vacuous scan of an empty table would pass everything. And each source class must be
  // REACHED -- a slot count of 0 in either class means that loop read nothing, whatever its CRCs say.
  check('the known-good ROM CRC table is read from the profiles', table.size >= 20 && sizes.length >= 1, `${table.size} CRCs, sizes ${sizes.join(',')}`);
  check('both CRC sources are reached: machines and cartridges visit at least one slot each (their CRCs may be empty)',
    seen.machines > 0 && seen.cartridges > 0, `${seen.machines} machine slots, ${seen.cartridges} cartridge slots`);
  // The CRC the cartridge module recognises a board by is IN the table: it is a known-good ROM CRC written as a bare
  // constant outside the profile table, and a scan that did not read it would pass on that ROM. A missing constant
  // is a FAIL, not a quietly smaller table.
  check('the Orchestra-90 CRC is read from js/machines/carts.js and is in the table',
    /^[0-9A-F]{8}$/.test(String(ORCH)) && table.get(ORCH) === 'carts/orch90', `${ORCH} -> ${table.get(ORCH)}`);
  // every CRC that lives outside the profile table is in the table: carts.js's one and selftest.js's three
  {
    const outside = outsideProfileCrcs();
    const missing = outside.filter(([crc]) => !table.has(String(crc).toUpperCase()));
    check('...and every CRC js/selftest.js names is in the table too', outside.length >= 4 && missing.length === 0,
      `${outside.length} outside the profiles: ${missing.map(([c]) => c).join(', ') || 'all present'}`);
    // and the reader really reads the constants: a synthetic module text with a CRC the table lacks would be missing
    check('...from a constant that a missing or renamed one would empty (so the check bites)',
      outside.some(([, where]) => where === 'selftest/known') && outside.some(([, where]) => where === 'carts/orch90'),
      JSON.stringify(outside.map(([, w]) => w)));
  }
  // and the cartridge path is reached through the shape the real table uses: a synthetic cartridge with a CRC comes
  // back out of tableFrom, which the old nested `r.roms` loop never could have done.
  {
    const cart = { zz: { id: 'zz', roms: [{ id: 'rom', size: 0x2000, crcs: ['DEADBEEF'] }] } };
    const got = tableFrom({}, cart);
    check('a synthetic cartridge CRC is read through the cartridge path (a slot IS the cartridge\'s roms entry)',
      got.table.get('DEADBEEF') === 'zz/rom', JSON.stringify([...got.table]));
  }
  const files = trackedFiles();
  // Without git the list is unknown, not empty. FAIL, loudly: an empty list would pass the scan while covering nothing.
  check('the file list came from git (a checkout without .git cannot be scanned)',
    Array.isArray(files) && !files.error, Array.isArray(files) ? '' : String(files.error));
  const list = Array.isArray(files) ? files : [];
  check('the scan covers the tracked repository', list.length > 500, `${list.length} tracked files`);
  check('...and the list really is this repository\'s (a known tracked file is in it)',
    list.includes('AGENTS.md') && list.includes('js/machines/profiles.js'), list.includes('AGENTS.md') ? '' : 'AGENTS.md missing');
  // Two ways the cwd is not the repository root, both of which `git ls-files` answers without an error: a directory
  // that is no repository at all (git fails, no list) and one INSIDE the repository but not at its root (git
  // succeeds, with that subdirectory's files or none). Neither may read as "no ROMs found".
  {
    const bare = fs.mkdtempSync(path.join(require('os').tmpdir(), 'no-roms-nogit-'));
    try {
      // git's own failure, with no policy in front of it: an error object, never an empty list
      const raw = lsFilesAt(bare);
      check('...and a directory with no .git makes git itself fail with an ERROR, not an empty list',
        !!raw.error && !Array.isArray(raw), JSON.stringify(raw).slice(0, 120));
      // and through the scan's entry point it is refused (by the root check here: either way, never a list)
      const got = trackedFiles(bare);
      check('...and a checkout with no .git is refused by the scan, never read as "no ROMs"',
        !!got.error && !Array.isArray(got), JSON.stringify(got).slice(0, 120));
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  }
  {
    const nested = fs.mkdtempSync(path.join(ROOT, '.no-roms-nested-'));
    try {
      const got = trackedFiles(nested);
      check('...and a directory inside the repository that is not its root is a FAIL, not a short or empty list',
        !!got.error && !Array.isArray(got), Array.isArray(got) ? `${got.length} files` : JSON.stringify(got).slice(0, 120));
    } finally { fs.rmSync(nested, { recursive: true, force: true }); }
  }
  const hits = scanRepo(list, table, sizes);
  // An empty list would make "no hits" a fact about nothing: it FAILS rather than reporting a clean repository.
  check('no tracked file holds a known-good ROM (whole or as an aligned window)', list.length > 0 && hits.length === 0,
    list.length ? hits.slice(0, 8).join(' | ') : 'the file list is empty: nothing was scanned');
  // The repository scan must be able to FAIL, or "clean" means nothing. Claim one of our own tracked examples is a
  // known-good ROM (a synthetic table entry -- no ROM is used or fabricated) and require the SAME loop above to catch
  // it: scanRepo with the claimed table must report examples/liza.bin and nothing else.
  {
    const liza = fs.readFileSync(path.join(ROOT, 'examples', 'liza.bin'));
    const claimed = new Map([[Emu.crc32(liza).toUpperCase(), 'synthetic/liza']]);
    const caught = scanRepo(list, claimed, sizes);
    check('the repository scan catches a tracked file when the table says it is a ROM (synthetic entry, our own example)',
      caught.length === 1 && caught[0].startsWith('examples/liza.bin '), JSON.stringify(caught.slice(0, 3)));
  }
  // And a file SMALLER than every ROM the table knows is still judged on its whole-file CRC: that is what "no size
  // prefilter" means. examples/demo.bin is 329 bytes, below the table's smallest ROM (512); claimed as a ROM, the
  // scan must report it. A prefilter would skip it and this check would go red.
  {
    const small = fs.readFileSync(path.join(ROOT, 'examples', 'demo.bin'));
    const smallest = Math.min(...sizes);
    const caught = scanRepo(list, new Map([[Emu.crc32(small).toUpperCase(), 'synthetic/small']]), sizes);
    check('a file smaller than every ROM in the table is still judged (no size prefilter)',
      small.length < smallest && caught.length === 1 && caught[0].startsWith('examples/demo.bin '),
      `${small.length} bytes, smallest ROM ${smallest}: ${JSON.stringify(caught.slice(0, 2))}`);
  }
}

// ---- the detector itself: it must catch a ROM, so a clean run means something ----
// No ROM is used or fabricated: the test takes one of the project's OWN example programs, computes its CRC, and puts
// that CRC into the table for the duration of the check. A detector that cannot find a known CRC in a file it was
// given is a detector that would not find a ROM either.
{
  const emu = fs.readFileSync(path.join(ROOT, 'examples', 'liza.bin'));
  const victim = fs.readFileSync(path.join(ROOT, 'examples', 'demo.bin'));
  const fake = new Map([[Emu.crc32(emu).toUpperCase(), 'synthetic/liza']]);
  const sizes = [emu.length];
  const found = hitsIn(emu, fake, sizes);
  check('the detector finds a known CRC in a file it is given (a synthetic table entry for our own example)',
    found.length === 1 && found[0].offset === null && found[0].size === emu.length, JSON.stringify(found));
  // and it finds one EMBEDDED in a larger blob at a 2 KB boundary, which is the case the whole-file check misses
  const padded = Buffer.concat([Buffer.alloc(4096, 0x55), victim]);
  const embedded = hitsIn(padded, new Map([[Emu.crc32(victim).toUpperCase(), 'synthetic/demo']]), [victim.length]);
  check('... and one embedded at a 2 KB boundary inside a larger file', embedded.length === 1 && embedded[0].offset === 4096, JSON.stringify(embedded));
  // a ROM at the HEAD of a longer container: offset 0, which dropping the old `if (h.offset)` filter is what makes
  // visible. The whole-file CRC differs (the container is longer), so this is the only check that can see it.
  const headed = Buffer.concat([victim, Buffer.alloc(4096, 0x55)]);
  const atHead = hitsIn(headed, new Map([[Emu.crc32(victim).toUpperCase(), 'synthetic/demo']]), [victim.length]);
  check('... and one embedded at offset 0 of a longer file (the whole-file CRC cannot see that)',
    atHead.length === 1 && atHead[0].offset === 0 && Emu.crc32(headed) !== Emu.crc32(victim), JSON.stringify(atHead));
  // a ROM-sized file that is exactly its own window is reported ONCE, not twice (whole file and window coincide)
  const exact = hitsIn(victim, new Map([[Emu.crc32(victim).toUpperCase(), 'synthetic/demo']]), [victim.length]);
  check('... and a ROM-sized file is reported once, not twice as whole file and window',
    exact.length === 1 && exact[0].offset === null, JSON.stringify(exact));
  // a ROM behind a short container header: 1024 bytes is NOT a 2 KB multiple, so the aligned pass alone misses it and
  // the header offsets are what find it. This is the case the scope note describes, held by a check so the offsets
  // cannot be dropped silently.
  {
    const behind = Buffer.concat([Buffer.alloc(1024, 0xAA), victim]);
    const found = hitsIn(behind, new Map([[Emu.crc32(victim).toUpperCase(), 'synthetic/header']]), [victim.length]);
    const alignedOnly = scan(behind, new Map([[Emu.crc32(victim).toUpperCase(), 'synthetic/header']]), [victim.length]);
    check('...and one behind a 1024-byte header, which the aligned pass alone misses',
      found.length === 1 && found[0].offset === 1024 && alignedOnly.length === 0, JSON.stringify([found, alignedOnly]));
  }
  // a negative control: a blob the table does not know is not reported
  check('... and a blob it does not know is not reported', hitsIn(Buffer.alloc(4096, 7), fake, sizes).length === 0);
}

console.log(fail ? `${fail} of ${n} no-ROM checks FAILED` : `${n}/${n} no-ROM checks passed`);
process.exitCode = fail ? 1 : 0;
