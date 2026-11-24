// The colour demo's own words about ROMs (tools/build-demo.js, examples/demo.bin): it clears the screen, so the built-in
// firmware's banner ("NO ROM LOADED - BUILT-IN STUB") goes, and prints "RUNS WITHOUT ROMS" and "ADD YOURS FOR BASIC" on
// two lines, each centred on the 32 columns (the UX ruling's words, written out here). The committed binary is the
// build's, and every line fits the screen. Checked on a Dragon 64, a CoCo 1/2 and a CoCo 3 running without ROMs.
// Run: node tests/demo-text.test.js
const Emu = require('./load')();
const fs = require('fs');
const path = require('path');
const { build, NO_ROM_LINES } = require('../tools/build-demo.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const committed = fs.readFileSync(path.join(__dirname, '../examples/demo.bin'));
let built = null, error = '';
try { built = build().bytes; } catch (e) { error = e.message; }
check('the demo builds (no line wider than the 32 columns), and examples/demo.bin is that build', built && Buffer.compare(built, committed) === 0, error);
check('the ruling\'s two lines, no middle dot, no hyphen', JSON.stringify(NO_ROM_LINES) === JSON.stringify(['RUNS WITHOUT ROMS', 'ADD YOURS FOR BASIC']));

for (const id of ['dragon64', 'coco', 'coco3']) {
  const s = new Emu.Session({});
  s.switchMachine(id);
  for (let i = 0; i < 20; i++) s.advance(21);
  s.load('demo.bin', new Uint8Array(committed), { remember: false, ours: true });
  for (let i = 0; i < 30; i++) s.advance(21);
  // the text screen, row by row, as Claude's screen_text reads it (screenTextTool), trailing spaces kept to the 32 columns
  const rows = Emu.screenTextTool(s.chatTarget()).lines.map((r) => r.padEnd(32));
  const at = (line) => rows.findIndex((r) => r.trimEnd() === ' '.repeat((32 - line.length) >> 1) + line);
  const a = at('RUNS WITHOUT ROMS'), b = at('ADD YOURS FOR BASIC');
  check(`${id}: "RUNS WITHOUT ROMS" (from column 8) and, under it, "ADD YOURS FOR BASIC" (from column 7), centred`, a >= 0 && b === a + 1, JSON.stringify(rows));
  check(`${id}: the firmware's banner is gone (the demo cleared the screen)`, !rows.some((r) => /NO ROM LOADED|BUILT-IN STUB/.test(r)) && rows[0].startsWith('DRAGON 64 EMULATOR DEMO'));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
