// Run: node tests/basic-pause.test.js
//
// The clean-room BASIC's keyboard checks while a program runs (docs/clean-room-basic.md, the per-statement BREAK
// test): SHIFT-@ pauses a running program until another key is pressed, @ alone does not, and BREAK stops it with
// BREAK IN n [UM]. The program writes a changing byte to the top-left cell of the text screen, so whether it runs
// is read from screen memory, never from BASIC's own variables. Then mutants (built from edited source by
// buildBasic({ edit })) that must each fail the checks: the per-statement test left out, and the @ row not read.
const { Basic } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');

let fail = 0, n = 0, firstFail = null;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; firstFail = firstFail || name; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const SCR = 0x400;
function suite(rom) {
  const b = new Basic(rom);
  b.run(150);
  if (!b.cleanStart()) throw new Error('no clean start');
  b.type('10 I=I+1:POKE 1024,I AND 63:GOTO 10\n'); b.run(10);
  b.m.typist.typePaced('RUN\n'); b.run(30);
  const cell = () => b.m.ram[SCR];
  const moving = () => { const a = cell(); b.run(3); return cell() !== a; };
  const hold = (keys, frames = 5) => { for (const k of keys) b.m.setKey(k, true); b.run(frames); for (const k of keys) b.m.setKey(k, false); b.run(5); };
  check('the program runs (the top-left cell keeps changing)', moving());
  hold(['SHIFT', '@']);
  check('SHIFT-@ pauses it: the cell holds still for 30 frames', !moving() && (() => { const a = cell(); b.run(30); return cell() === a; })());
  hold(['SPACE']);
  check('another key goes on with it', moving());
  hold(['@']);
  check('@ without SHIFT does not pause it', moving() && moving());
  hold(['BREAK']);
  b.waitOk({ limit: 300 });
  const t = b.screen();
  check('BREAK stops it: BREAK IN 10, then OK', t.includes('BREAK IN 10') && t[t.length - 1] === 'OK', JSON.stringify(t.slice(-3)));
}

suite(buildBasic().rom);

// ---- mutants: each must fail the checks ----
const MUTANTS = [
  ['no BREAK test between statements', 'interp.inc', 'NEWST1  JSR     BRKCHK', 'NEWST1  NOP'],
  ['the @ row not read', 'keyboard.inc', '        BITA    #$04\n        BNE     BRKNO', '        BITA    #$00\n        BEQ     BRKNO'],
];
for (const [name, file, from, to] of MUTANTS) {
  let used = false;
  const mrom = buildBasic({ edit: (f, text) => { if (f !== file) return text; if (!text.includes(from)) throw new Error(`mutant ${name}: no ${from}`); used = true; return text.replace(from, to); } }).rom;
  const f0 = fail, n0 = n, out = console.log;
  console.log = () => {};
  firstFail = null;
  let crashed = null;
  try { suite(mrom); } catch (e) { crashed = e.message; }
  console.log = out;
  const failed = crashed || fail > f0;
  fail = f0; n = n0;
  check(`mutant "${name}" fails the checks`, used && failed, crashed ? `(it stopped: ${crashed})` : `(first: ${firstFail})`);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
