#!/usr/bin/env node
// Vendor WYRMFIRE at the pin (js/wyrmfire/pin.js) and build the Freedoom level disk CLOADM serves.
//
//   node tools/wyrmfire-vendor.js WYRMFIRE_CHECKOUT [--cache DIR]
//
// WYRMFIRE_CHECKOUT is a clone of https://github.com/yaniv-golan/wyrmfire at exactly the pinned commit (it is only
// read). The engine, its GPL licence and the converter are copied byte for byte into examples/wyrmfire/; then
// Freedoom 0.13.0 (BSD-3-Clause) is downloaded from its release at the pinned URL, the zip and freedoom1.wad are
// checked against their pinned SHA-256, and the VENDORED converter turns map E1M1 into examples/wyrmfire/freedoom-e1m1.vdk.
// Freedoom's COPYING.txt and credits go beside it. Every file must hash to the pin, or nothing is written.
// Only Freedoom is ever converted here: no id Software WAD is fetched or used.
// Afterwards: node tools/pwa-files.js --write (this tool does it) and node tests/all.js --only wyrmfire-files.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');
const { readZip } = require('../js/media/zip.js');
const { syncSw } = require('./pwa-files.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
class VendorError extends Error {}
const die = (m) => { throw new VendorError(m); };

// The README that ships in examples/wyrmfire/freedoom/. Written from the pin so it cannot drift from the files beside
// it, and so the CREDITS-LEVELS point stays recorded: that file does not exist at 0.13.0 (it was added to Freedoom on
// 2024-02-08, ten days after this release was cut, and corrected twice since), so nobody adds a later version's
// authors to this disk.
function freedoomReadme(pin = PIN) {
  const f = pin.freedoom, p = pin.files;
  return [
    'Freedoom, as used by CLOADM\'s WYRMFIRE',
    '======================================',
    '',
    `The level disk CLOADM serves (examples/wyrmfire/freedoom-e1m1.vdk and .dsk) is map E1M1 of Freedoom`,
    `${f.version}, converted for WYRMFIRE's engine by WYRMFIRE's own converter. It is a MODIFIED copy of that map,`,
    'not the map as Freedoom ships it.',
    '',
    `Freedoom release: ${f.version}`,
    `  ${f.url}`,
    `  zip SHA-256 ${f.zipSha256}`,
    `  freedoom1.wad SHA-256 ${f.wadSha256}`,
    '',
    'These three files are the release\'s own, byte for byte, as they appear in that zip (Freedoom\'s release build',
    'converts its .adoc/.txt sources to CRLF and adds a UTF-8 BOM; that is the form its own release ships):',
    '',
    '  COPYING.txt        Freedoom\'s BSD 3-Clause licence and copyright notice',
    '  CREDITS.txt        the project\'s contributors',
    '  CREDITS-MUSIC.txt  the music\'s contributors',
    '',
    `  COPYING.txt        SHA-256 ${p.freedoomCopying.sha256}`,
    `  CREDITS.txt        SHA-256 ${p.freedoomCredits.sha256}`,
    `  CREDITS-MUSIC.txt  SHA-256 ${p.freedoomMusic.sha256}`,
    '',
    'Copyright (c) 2001-2024 Contributors to the Freedoom project. All rights reserved.',
    'Distributed under the BSD 3-Clause licence in COPYING.txt. The full text of that licence, including its',
    'conditions and its warranty disclaimer, is in COPYING.txt.',
    '',
    'CREDITS-LEVELS is NOT here, deliberately: it does not exist at Freedoom 0.13.0. It was added to the Freedoom',
    'repository on 2024-02-08, after this release (2024-01-29), and has been corrected twice since. Do not copy a',
    'later version\'s CREDITS-LEVELS beside this disk: its authors and level set are not this release\'s.',
    '',
    'Freedoom is not affiliated with id Software.',
    'DOOM is a registered trademark of ZeniMax Media Inc. CLOADM and WYRMFIRE are independent projects, not affiliated',
    'with or endorsed by id Software, ZeniMax Media or Microsoft. References to DOOM describe file compatibility only.',
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const src = args.find((a) => !a.startsWith('--'));
  const cacheAt = args.indexOf('--cache');
  const cache = cacheAt >= 0 ? args[cacheAt + 1] : null;
  if (!src) die('usage: node tools/wyrmfire-vendor.js WYRMFIRE_CHECKOUT [--cache DIR]');
  const head = cp.execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== PIN.commit) die(`${src} is at ${head}, the pin is ${PIN.commit} (js/wyrmfire/pin.js)`);
  // the pinned Freedoom must be the one this WYRMFIRE commit pins too
  const env = fs.readFileSync(path.join(src, 'tools/versions.env'), 'utf8');
  for (const [k, v] of [['FREEDOOM_URL', PIN.freedoom.url], ['FREEDOOM_ZIP_SHA256', PIN.freedoom.zipSha256], ['FREEDOOM1_WAD_SHA256', PIN.freedoom.wadSha256]]) {
    if (!env.includes(`${k}=${v}\n`)) die(`tools/versions.env of the checkout does not pin ${k}=${v}`);
  }

  const out = new Map();   // path -> bytes, written only once every one is checked
  const want = (f, bytes) => {
    if (f.sha256 && sha(bytes) !== f.sha256) die(`${f.path}: SHA-256 ${sha(bytes)} is not the pinned ${f.sha256}`);
    if (f.size != null && bytes.length !== f.size) die(`${f.path}: ${bytes.length} bytes, the pin says ${f.size}`);
    out.set(f.path, bytes);
  };
  for (const key of ['engine', 'licence', 'converter', 'worker']) want(PIN.files[key], fs.readFileSync(path.join(src, PIN.files[key].from)));

  // Freedoom, at the pinned SHA-256
  let zip = cache && fs.existsSync(path.join(cache, 'freedoom.zip')) ? fs.readFileSync(path.join(cache, 'freedoom.zip')) : null;
  if (!zip) {
    console.log(`downloading ${PIN.freedoom.url}`);
    const res = await fetch(PIN.freedoom.url);
    if (!res.ok) die(`${PIN.freedoom.url}: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    if (cache) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'freedoom.zip'), zip); }
  }
  if (sha(zip) !== PIN.freedoom.zipSha256) die(`freedoom zip: SHA-256 ${sha(zip)} is not the pinned ${PIN.freedoom.zipSha256}`);
  const entries = new Map(readZip(new Uint8Array(zip)).map((e) => [e.name, e.data]));
  const wad = entries.get(PIN.freedoom.wad);
  if (!wad || sha(wad) !== PIN.freedoom.wadSha256) die(`${PIN.freedoom.wad}: missing or not the pinned SHA-256`);
  for (const key of ['freedoomCopying', 'freedoomCredits', 'freedoomMusic']) {
    const f = PIN.files[key], b = entries.get(f.zip);
    if (!b) die(`${f.zip}: not in the Freedoom zip`);
    want(f, Buffer.from(b));
  }
  // our README for the folder, written here so it follows the pin (never a hand copy): the release, which files are
  // the release's own, that the level was converted, and why CREDITS-LEVELS is absent
  want(Object.assign({}, PIN.files.freedoomReadme, { sha256: sha(Buffer.from(freedoomReadme())) }),
    Buffer.from(freedoomReadme()));
  // the level, made by the vendored converter (the same bytes the pin names)
  // (imported from the checkout: its bytes were just checked against the pin, so they are the vendored converter's)
  const conv = await import('file://' + path.resolve(src, PIN.files.converter.from));
  if (conv.VERSION !== PIN.converterVersion) die(`converter VERSION ${conv.VERSION}, the pin says ${PIN.converterVersion}`);
  const { disk, info } = await conv.convertAsync(new Uint8Array(wad), { map: PIN.freedoom.map, sha256: PIN.freedoom.wadSha256 });
  want(PIN.files.level, Buffer.from(disk));
  // the same disk as a JVC .dsk, written by CLOADM's own disk code (Help -> WYRMFIRE offers both)
  const { loadDisk, saveDisk } = require('../js/media/disk.js');
  want(PIN.files.levelDsk, Buffer.from(saveDisk(loadDisk(disk, 'vdk', { tracks: 80, heads: 2 }), 'jvc')));
  console.log(`level ${PIN.freedoom.map}: ${info.diskBytes} bytes, ${info.regions} regions, sha256 ${info.sha256}`);

  for (const [p, b] of out) { fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }); fs.writeFileSync(path.join(ROOT, p), b); console.log(`${p}: ${b.length} bytes`); }
  const { changed, count } = syncSw(ROOT);
  console.log(changed ? `sw.js: file list updated (${count} files)` : `sw.js: up to date (${count} files)`);
}
main().catch((e) => { console.error(`wyrmfire-vendor: ${e instanceof VendorError ? e.message : e.stack}`); process.exitCode = 1; });
