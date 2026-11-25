// Run: node tests/basic-rom-file.test.js
//
// The committed image of the clean-room BASIC, basic/cloadm-basic-d64.rom, is exactly what its source builds
// (node tools/build-basic.js writes it): a change to basic/ without rebuilding the image fails here.
const fs = require('fs');
const { buildBasic, ROM_FILE } = require('../tools/build-basic.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const built = buildBasic().rom;
const file = fs.existsSync(ROM_FILE) ? new Uint8Array(fs.readFileSync(ROM_FILE)) : null;
check('basic/cloadm-basic-d64.rom is committed', !!file);
if (file) {
  check('it is 16K', file.length === 0x4000, String(file.length));
  let at = -1;
  for (let i = 0; i < Math.max(file.length, built.length); i++) if (file[i] !== built[i]) { at = i; break; }
  check('it is what the source builds (node tools/build-basic.js)', at < 0, at < 0 ? '' : `first difference at $${(0x8000 + at).toString(16).toUpperCase()}`);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
