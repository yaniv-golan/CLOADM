// Run: node tests/basic-screen.test.js
//
// The clean-room BASIC's text screen statements, checked in screen memory (tests/basic/harness.js):
//  * CLS clears to spaces ($60) and homes the cursor;
//  * CLS c fills every cell with colour c's block [UM]: 0 black ($80, no element lit), 1-8 the semigraphics-4
//    character with all four elements lit and the colour in bits 4-6 [HW: the MC6847 data sheet], so $8F + 16 x (c-1);
//    the cursor goes home, and text printed after it starts at the top;
//  * CLS with a colour above 8 gives ?FC ERROR (provisional [OWN]: the black-box case screen-cls asks the original),
//    CLS with a string ?TM ERROR, and CLS c inside a program line.
const { Basic } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const { rom } = buildBasic();
const b = new Basic(rom);
if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('our BASIC did not boot');
const SCR = 0x400;
const cells = () => Array.from(b.m.ram.slice(SCR, SCR + 512));
const run = (line) => { b.type(line + '\n'); b.waitOk(); };

// the expected block for each colour, from the data sheet's format, computed apart from the ROM's own arithmetic
const block = (c) => (c === 0 ? 0x80 : 0x80 | ((c - 1) << 4) | 0x0F);
for (let c = 0; c <= 8; c++) {
  b.type(`CLS${c}\n`);
  b.waitOk();
  // the prompt's OK and the line typed are on the top rows; everything from row 4 on is the fill
  const rest = cells().slice(4 * 32);
  check(`CLS ${c}: every cell below the prompt is ${block(c).toString(16)}`, rest.every((v) => v === block(c)), rest.slice(0, 4).map((v) => v.toString(16)).join(' '));
}
run('CLS3:PRINT"HI"');
check('CLS 3 then PRINT: the text at the top', b.screen()[0] === 'HI');
check('... and the fill kept below it', cells().slice(4 * 32).every((v) => v === 0xAF));
run('CLS');
check('CLS: all spaces but the prompt', cells().slice(2 * 32).every((v) => v === 0x60) && b.screen()[0] === 'OK');
b.record();
run('CLS 9');
check('CLS 9: ?FC ERROR', b.transcript().includes('?FC ERROR'), JSON.stringify(b.transcript()));
b.record();
run('CLS "A"');
check('CLS "A": ?TM ERROR', b.transcript().includes('?TM ERROR'), JSON.stringify(b.transcript()));
run('10 CLS 7:PRINT "X";');
run('RUN');
check('CLS c in a program', b.screen()[0] === 'X' && cells().slice(4 * 32).every((v) => v === block(7)));

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
