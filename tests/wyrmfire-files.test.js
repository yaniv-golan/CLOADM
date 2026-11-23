// WYRMFIRE's served files (js/wyrmfire/pin.js): the engine, its GPL licence, the converter, the Freedoom level disk
// and Freedoom's licence and credits are all present, each with the pinned SHA-256 and size; sw.js keeps them for
// offline use; the source note names the pinned commit; and the version the page shows is the pin's.
// No id Software data is involved: the level disk is Freedoom's (tools/wyrmfire-vendor.js builds it).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WYRMFIRE_PIN: PIN, wyrmfireSourceUrl } = require('../js/wyrmfire/pin.js');
const { pwaFiles } = require('../tools/pwa-files.js');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const listed = pwaFiles();
for (const [key, f] of Object.entries(PIN.files)) {
  const p = path.join(ROOT, f.path), there = fs.existsSync(p);
  check(`${key}: ${f.path} exists`, there);
  if (!there) continue;
  const b = fs.readFileSync(p);
  check(`${key}: SHA-256 and size are the pin's`, /^[0-9a-f]{64}$/.test(f.sha256) && sha(b) === f.sha256 && b.length === f.size, `${sha(b)} ${b.length}`);
  check(`${key}: kept for offline use (sw.js)`, listed.includes(f.path));
}
// the licence texts say what they are
const text = (k) => fs.readFileSync(path.join(ROOT, PIN.files[k].path), 'utf8');
check('the GPL text is the GNU GPL version 3', /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(text('licence')));
check('Freedoom\'s notice is the BSD 3-Clause text with its copyright line', /Copyright © 2001-2024\s+Contributors to the Freedoom project/.test(text('freedoomCopying'))
  && /Redistribution and use in source and binary forms/.test(text('freedoomCopying')));
check('the converter and its worker are labelled GPL', /SPDX-License-Identifier: GPL-3\.0-or-later/.test(text('converter')) && /SPDX-License-Identifier: GPL-3\.0-or-later/.test(text('worker')));
check('the converter\'s VERSION is the pin\'s', new RegExp(`export const VERSION = '${PIN.converterVersion.replace(/\./g, '\\.')}'`).test(text('converter')));
// the engine is a DragonDOS binary that loads and runs at $0C00 (wyrmfire docs/RELEASE.md)
{
  const b = fs.readFileSync(path.join(ROOT, PIN.files.engine.path));
  check('the engine: DragonDOS header 55 02 0C00 len 0C00 AA', b[0] === 0x55 && b[1] === 0x02 && b.readUInt16BE(2) === 0x0C00 && b.readUInt16BE(4) === b.length - 9
    && b.readUInt16BE(6) === 0x0C00 && b[8] === 0xAA);
}
// the level: an 80-track double-sided VDK (wyrmfire's converter output), written for the Dragon
{
  const b = fs.readFileSync(path.join(ROOT, PIN.files.level.path));
  check('the level disk is a VDK (dk header, 80 tracks, 2 sides)', b.toString('latin1', 0, 2) === 'dk' && b[8] === 80 && b[9] === 2, `${b.toString('latin1', 0, 2)} ${b[8]} ${b[9]}`);
}
// the source note names exactly the pinned commit and version
{
  const s = fs.readFileSync(path.join(ROOT, 'examples/wyrmfire/SOURCE.txt'), 'utf8');
  check('SOURCE.txt: the pinned version, commit and source link', s.includes(`Version:  ${PIN.version}`) && s.includes(`Commit:   ${PIN.commit}`) && s.includes(wyrmfireSourceUrl()));
  check('the source link is the tag once there is one, else the commit', wyrmfireSourceUrl() === `${PIN.repo}/tree/${PIN.tag || PIN.commit}`
    && wyrmfireSourceUrl({ ...PIN, tag: 'v9.9.9' }).endsWith('/tree/v9.9.9'));
}
check('the pin: a version, a 40-hex commit, the Dragon 64 with the bare DragonDOS controller', /^\d+\.\d+\.\d+$/.test(PIN.version) && /^[0-9a-f]{40}$/.test(PIN.commit)
  && PIN.machine.id === 'dragon64' && PIN.machine.controller === 'dragonfdc' && PIN.machine.config.ram === 64);
// no id Software data: nothing under examples/wyrmfire is a WAD, and the only disk is the pinned Freedoom one
{
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
  walk(path.join(ROOT, 'examples/wyrmfire'));
  const wads = all.filter((p) => { const b = fs.readFileSync(p); return /\.wad$/i.test(p) || ['IWAD', 'PWAD'].includes(b.toString('latin1', 0, 4)); });
  check('no WAD is served', !wads.length, wads.join(' '));
  const disks = all.filter((p) => /\.(vdk|dsk|jvc|dmk)$/i.test(p)).map((p) => path.relative(ROOT, p));
  check('the only level disk is the pinned Freedoom one', disks.length === 1 && disks[0] === PIN.files.level.path, disks.join(' '));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
