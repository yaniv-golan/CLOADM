// Run: node tests/basic-screen.test.js
//
// The clean-room BASIC's text screen statements, checked in screen memory (tests/basic/harness.js):
//  * CLS clears to spaces ($60) and homes the cursor;
//  * CLS c fills every cell with colour c's block [UM]: 0 black ($80, no element lit), 1-8 the semigraphics-4
//    character with all four elements lit and the colour in bits 4-6 [HW: the MC6847 data sheet], so $8F + 16 x (c-1);
//    the cursor goes home, and text printed after it starts at the top;
//  * CLS with a colour 9-255 prints our own line (MADE WITHOUT PEEKING) and an empty line, no error (the original's shape from
//    the local-only black-box case screen-cls-range; the text is ours: a deliberate difference); past 255 ?FC ERROR;
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
// a colour 9-255: no error, one line of our own text and an empty line (the original's shape, bb2 screen-cls-range;
// the text is ours, never the original's); past 255 ?FC ERROR
for (const c of [9, 10, 255]) {
  b.record();
  run(`CLS ${c}`);
  const t = b.transcript(), at = t.indexOf(`CLS ${c}`);
  check(`CLS ${c}: our own line, an empty line, OK`, JSON.stringify(t.slice(at + 1)) === JSON.stringify(['MADE WITHOUT PEEKING', '', 'OK']), JSON.stringify(t));
}
// the boundaries, from the original (bb2 screen-cls-range and its boundary run): 8 and 8.5 clear (a colour is truncated),
// 9, 9.5 and 255.9 print the line, 256, 1E3 and -1 are ?FC ERROR
for (const c of ['9.5', '255.9']) {
  b.record();
  run(`CLS ${c}`);
  const t = b.transcript(), at = t.indexOf(`CLS ${c}`);
  check(`CLS ${c}: truncated to a colour past 8, our own line`, JSON.stringify(t.slice(at + 1)) === JSON.stringify(['MADE WITHOUT PEEKING', '', 'OK']), JSON.stringify(t));
}
for (const c of ['8', '8.5']) {
  run(`CLS ${c}`);
  check(`CLS ${c}: truncated to colour 8, the screen filled`, cells().slice(4 * 32).every((v) => v === block(8)));
}
// a second line of our own for CLS 67 (67.5 truncates to it); its neighbours print the first
for (const [c, line] of [['66', 'MADE WITHOUT PEEKING'], ['67', 'OK BOOMER'], ['67.5', 'OK BOOMER'], ['68', 'MADE WITHOUT PEEKING']]) {
  b.record();
  run(`CLS ${c}`);
  const t = b.transcript(), at = t.indexOf(`CLS ${c}`);
  check(`CLS ${c}: ${line}, an empty line, OK`, JSON.stringify(t.slice(at + 1)) === JSON.stringify([line, '', 'OK']), JSON.stringify(t));
}
for (const c of [256, -1, '1E3']) {
  b.record();
  run(`CLS ${c}`);
  check(`CLS ${c}: ?FC ERROR`, b.transcript().includes('?FC ERROR'), JSON.stringify(b.transcript()));
}
b.record();
run('CLS "A"');
check('CLS "A": ?TM ERROR', b.transcript().includes('?TM ERROR'), JSON.stringify(b.transcript()));
run('10 CLS 7:PRINT "X";');
run('RUN');
check('CLS c in a program', b.screen()[0] === 'X' && cells().slice(4 * 32).every((v) => v === block(7)));

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
