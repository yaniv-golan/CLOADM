// Run: node tests/basic-cassette.test.js
//
// The clean-room BASIC's cassette statements (basic/cassette.inc; docs/clean-room-basic.md): CSAVE, CSAVE ,A,
// CSAVEM, CLOAD, CLOADM, SKIPF and MOTOR, typed in through the keyboard on a Dragon 64 running our ROM (assembled
// at test time; no other ROM is used), with the emulator's cassette deck as the tape. The oracle is the
// repository's own tape code, which the MAME tape tests verify, never our ROM's: what our ROM writes is decoded
// from the deck's recording by js/media/cassette.js (samplesToCas) and js/media/formats.js (parseCas), and the
// tapes it reads are built by buildCas and played by the deck's Tape. The expected bytes are written out here by
// hand from the program typed (and checked against the program in RAM), not computed by the ROM.
//
// What is proved:
//  * a program saved with CSAVE and loaded back with CLOAD (into the same machine after NEW, and into a fresh
//    one) LISTs exactly as typed and is the same bytes in memory; one over 255 bytes takes several data blocks;
//  * the tape's blocks: a namefile with the name, type, flags and addresses, data blocks of 255 and the rest, an
//    end-of-file block, every checksum right, a leader of 256 $55 bytes before each block written after the motor
//    starts and one before the end of file that follows the data with the motor running;
//  * CSAVE ,A writes the LIST text, gapped, and CLOAD reads it back as a program; CSAVEM writes memory with its
//    addresses;
//  * tapes made by buildCas: CLOADM to the load address, with an offset, and EXEC runs it; a tokenised program
//    saved at another address is relinked; a text program loads; CLOAD "NAME" skips other files; SKIPF;
//  * the display while it reads (docs/clean-room-basic.md section 12, from the black-box records bb4 and bb5): the
//    screen cleared, S at the top left changing between normal and inverse once a block, a file passed over shown
//    as its name after the S and the screen cleared again at its end, the file wanted as F and its name, F then
//    changing once a block, the OK prompt or the error on the second row; the top row's bytes checked;
//  * errors: a bad checksum gives ?IO ERROR (the top row left "f NAME") and leaves no half program, the file left
//    open: SKIPF, OPEN and CSAVE are then ?AO ERROR without reading the tape, EOF(-1) is -1, CLOAD goes ahead; a bad
//    block in a file passed over is ?IO ERROR (SKIPF, CLOAD "NAME"); CLOADM of a program and CLOAD of machine code
//    give ?FM ERROR; a text line without a number ?DS ERROR when the next line is begun (at once with more in its
//    block), the lines before it kept; CLOAD of a data file ?DS ERROR; BREAK does not stop the search; MOTOR ON/OFF
//    switch the deck's motor;
//  * data files (the black-box case cas-files, bb4): OPEN "O" / PRINT #-1 / CLOSE write a type-1 namefile, the
//    records (hand-derived bytes whose SHA-256 is the original's) and an end-of-file block, the motor run three times;
//    OPEN "I" / INPUT #-1 / LINE INPUT #-1 / EOF(-1) read them back with the screen untouched, ?IE ERROR past the end;
//    the forms without #; a file over 255 bytes both ways; ?NO, ?ID, ?FM, ?AO (the file left open), ?DN, ?FD; OPEN to
//    #0 and #-2; and from bb8 cas-data2 and cas-data-errors: items left in a record dropped, OPEN "I" of machine code
//    or a tokenised program ?FM ERROR, NEW leaving a file open and RUN closing it, OPEN "O"'s namefile over the last
//    record (its exec and load); and mutants of our own source, each of which turns a data-file check red.
// The original's bb8 cassette records replayed on ours: tests/basic-cassette-bb8.test.js.
const { buildBasic } = require('../tools/build-basic.js');
const { Basic, Emu, cell } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b));
const hex = (a) => Buffer.from(a).toString('hex');

const { rom, symbols } = buildBasic();
const tok = (w) => symbols.get(w);           // a keyword's token (basic/tokens.json)
const PROGST = 0x1E01;                         // where a program starts [docs/clean-room-basic.md section 3]

function boot() {
  const b = new Basic(rom);
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('our BASIC did not boot');
  return b;
}
// type a line and wait for OK (a program line: until the screen settles)
function line(b, text, limit = 6000) {
  b.type(text + '\n');
  if (/^\d/.test(text)) b.run(10); else if (!b.waitOk({ limit })) throw new Error(`no OK after ${text}: ${b.screen().join(' | ')}`);
}
// every line that reached the screen after typing text (lines that scrolled off included), from that line on
function after(b, text, limit) {
  b.record();
  line(b, text, limit);
  const s = b.transcript();
  return s.slice(s.lastIndexOf(text));
}
// type a command with the deck recording: -> { bytes (.CAS from the decoder), blocks, bad }
function record(b, text) {
  b.m.deck.startRecording();
  line(b, text);
  const ev = b.m.deck.stopRecording();
  const r = Emu.samplesToCas(Emu.recordingToSamples(ev, b.m.tickHz), 44100);
  return { bytes: r.bytes, blocks: [...Emu.casBlocks(r.bytes)], bad: r.badBlocks };
}
const insert = (b, bytes) => b.m.deck.insert(new Emu.Tape(bytes, b.m.tickHz, 'test', b.m.profile.tape));
const program = (b) => { const r = b.m.ram; let x = PROGST; while (r[x] | r[x + 1]) x = (r[x] << 8) | r[x + 1]; return r.slice(PROGST, x + 2); };
const listing = (b) => { const s = after(b, 'LIST'); return s.slice(1, -1); };
// the top row of the screen as text (inverse as lower case) and its first ten bytes
const topRow = (b) => Array.from(b.m.ram.slice(0x400, 0x420), cell).join('').replace(/\s+$/, '');
const topBytes = (b) => Array.from(b.m.ram.slice(0x400, 0x40A));
// type a cassette command and wait for OK (or an error and OK), watching the top-left cell: -> { seq: the top row
// after each write to that cell ('(clear)' for a blank written there), screen, clears: the screens a clear wiped }
function watch(b, text, limit = 6000) {
  b.record();
  const seq = [], m = b.m;
  const remove = m.busTaps.addWriteTap({ start: 0x400, end: 0x400 }, (a, v) => {
    seq.push(v === 0x60 ? '(clear)' : (cell(v) + Array.from(m.ram.slice(0x401, 0x420), cell).join('')).replace(/\s+$/, ''));
  });
  b.type(text + '\n');
  const ok = b.waitOk({ limit });
  remove();
  if (!ok) throw new Error(`no OK after ${text}: ${b.screen().join(' | ')}`);
  return { seq, screen: b.screen(), clears: b.clears.map((c) => c.screen) };
}
const wiped = (w, text) => w.clears.length > 0 && w.clears[0][w.clears[0].length - 1] === text;
const bytes = (s) => [...s].map((c) => c.charCodeAt(0));

// ---------------- (1) CSAVE then CLOAD ----------------
const LINES = ['10 PRINT "HI"', '20 A=1:GOTO 10'];
{
  const b = boot();
  for (const l of LINES) line(b, l);
  const ram = program(b);
  // the program by hand: link, line number, tokens, 0; the end link [MBF layout]
  const l1 = [0x00, 0x0A, tok('T_PRINT'), 0x20, ...bytes('"HI"'), 0];
  const l2 = [0x00, 0x14, ...bytes('A'), tok('T_EQ'), ...bytes('1:'), tok('T_GO'), tok('T_TO'), 0x20, ...bytes('10'), 0];
  const a2 = PROGST + 2 + l1.length, end = a2 + 2 + l2.length;
  const want = [a2 >> 8, a2 & 0xFF, ...l1, end >> 8, end & 0xFF, ...l2, 0, 0];
  check('the program in RAM is the hand-built bytes', eq(ram, want), hex(ram));

  const tape = record(b, 'CSAVE "PROG"');
  const files = Emu.formats.parseCas(tape.bytes);
  check('CSAVE: the tape decodes with no bad block', tape.bad === 0 && tape.blocks.every((k) => k.ok), `${tape.bad} bad`);
  check('CSAVE: one file', files.length === 1, JSON.stringify(files.map((f) => f.name)));
  const f = files[0], head = tape.blocks[0];
  check('CSAVE: namefile block: 15 bytes, "PROG" padded with spaces', head.type === 0 && head.data.length === 15 && eq(head.data.slice(0, 8), bytes('PROG    ')), hex(head.data));
  check('CSAVE: file type 0 (BASIC), not ASCII, no gaps, exec and load 0', eq(head.data.slice(8), [0, 0, 0, 0, 0, 0, 0]), hex(head.data.slice(8)));
  check('CSAVE: the data is the program, end link included', eq(f.data, want), hex(f.data));
  check('CSAVE: blocks namefile, data, end of file', eq(tape.blocks.map((k) => k.type), [0x00, 0x01, 0xFF]) && tape.blocks[2].data.length === 0);
  const leaders = tape.blocks.map((k) => { let p = k.start - 1, c = 0; while (p >= 0 && tape.bytes[p] === 0x55) { p--; c++; } return c; });
  // [BB bb4 cas-save-load] a whole leader after the motor starts; the end of file, written with the motor running,
  // after one $55 (the decoder counts the data block's last $55 too: 2, as on the original's tape)
  check('CSAVE: a leader of 256 $55 bytes before the namefile and the data block, 2 before the end of file', leaders[0] >= 256 && leaders[0] <= 257 && leaders[1] >= 256 && leaders[1] <= 257 && leaders[2] === 2, leaders.join(','));
  check('CSAVE: a $55 after every block', tape.blocks.every((k) => tape.bytes[k.end] === 0x55));

  // rewind, NEW, CLOAD on the same machine
  line(b, 'NEW');
  check('NEW: no program', listing(b).length === 0);
  insert(b, tape.bytes);
  const w = watch(b, 'CLOAD');
  check('CLOAD: the screen is cleared first (the line typed is wiped, not scrolled off)', wiped(w, 'CLOAD'), JSON.stringify(w.clears));
  check('CLOAD: "F PROG" on the top row, OK on the second', eq(w.screen, ['F PROG', 'OK']), JSON.stringify(w.screen));
  check('CLOAD: the top row\'s bytes: F (normal), a blank, the name (normal)', eq(topBytes(b), [0x46, 0x60, 0x50, 0x52, 0x4F, 0x47, 0x60, 0x60, 0x60, 0x60]), hex(topBytes(b)));
  check('CLOAD: S, inverse at the namefile\'s leader, then F with the name, inverse at the data block, normal at the end of file',
    eq(w.seq, ['(clear)', 'S', 's', 'F PROG', 'f PROG', 'F PROG']), JSON.stringify(w.seq));
  check('CLOAD: LIST shows the program as typed', eq(listing(b), LINES), JSON.stringify(listing(b)));
  check('CLOAD: the same bytes in memory', eq(program(b), want));
  check('CLOAD: the motor is off afterwards', !b.m.deck.motor);
  // into a fresh machine, and it RUNs
  const c = boot();
  insert(c, tape.bytes);
  line(c, 'CLOAD "PROG"');
  check('CLOAD "PROG" into a fresh machine: LIST as typed', eq(listing(c), LINES), JSON.stringify(listing(c)));
  line(c, '10 PRINT "HI":END');
  check('the loaded program edits and runs', after(c, 'RUN').includes('HI'));
}

// a program over 255 bytes: several data blocks, and back
{
  const b = boot();
  const long = [];
  for (let i = 1; i <= 20; i++) long.push(`${i * 10} REM LINE ${i} OF A LONG ONE`);
  for (const l of long) line(b, l);
  const ram = program(b);
  const tape = record(b, 'CSAVE "LONG"');
  const sizes = tape.blocks.filter((k) => k.type === 1).map((k) => k.data.length);
  const want = []; for (let left = ram.length; left > 0; left -= 255) want.push(Math.min(255, left));
  check(`CSAVE of ${ram.length} bytes: data blocks of 255 and the rest`, ram.length > 255 && eq(sizes, want), sizes.join(','));
  check('CSAVE of a long program: the data is the program', eq(Emu.formats.parseCas(tape.bytes)[0].data, ram));
  line(b, 'NEW');
  insert(b, tape.bytes);
  const w = watch(b, 'CLOAD');
  const n = sizes.length + 1, toggles = w.seq.slice(w.seq.indexOf('F LONG') + 1);
  check(`CLOAD of a long program: the F changes once a block after the namefile (${n})`, toggles.length === n && toggles.every((t, i) => t === (i % 2 ? 'F LONG' : 'f LONG')), JSON.stringify(w.seq));
  check('CLOAD of a long program: the same bytes', eq(program(b), ram));
  check('CLOAD of a long program: LIST as typed', eq(listing(b), long), JSON.stringify(listing(b).slice(-2)));
}

// ---------------- (2) CSAVE ,A and CSAVEM ----------------
{
  const b = boot();
  for (const l of LINES) line(b, l);
  const tape = record(b, 'CSAVE "TEXT",A');
  const head = tape.blocks[0], f = Emu.formats.parseCas(tape.bytes)[0];
  check('CSAVE ,A: no bad block', tape.bad === 0);
  check('CSAVE ,A: namefile: BASIC, ASCII $FF, gaps $FF', eq(head.data.slice(0, 11), [...bytes('TEXT    '), 0, 0xFF, 0xFF]), hex(head.data));
  check('CSAVE ,A: the data is the LIST text, lines ended by CR', eq(f.data, bytes(LINES.join('\r') + '\r')), JSON.stringify(Buffer.from(f.data).toString('latin1')));
  line(b, 'NEW');
  insert(b, tape.bytes);
  line(b, 'CLOAD "TEXT"');
  check('CLOAD of a text file: LIST as typed', eq(listing(b), LINES), JSON.stringify(listing(b)));
}
{
  const b = boot();
  const code = [0x86, 0x2A, 0xB7, 0x35, 0x00, 0x39, 1, 2, 3, 4];
  line(b, `10 FOR I=0 TO 9:READ A:POKE 12288+I,A:NEXT`);
  line(b, `20 DATA ${code.join(',')}`);
  line(b, 'RUN');
  const tape = record(b, 'CSAVEM "CODE",&H3000,&H3009,&H3002');
  const head = tape.blocks[0], f = Emu.formats.parseCas(tape.bytes)[0];
  check('CSAVEM: no bad block', tape.bad === 0);
  check('CSAVEM: namefile: "CODE", type 2, not ASCII, exec $3002, load $3000',
    eq(head.data, [...bytes('CODE    '), 2, 0, 0, 0x30, 0x02, 0x30, 0x00]), hex(head.data));
  check('CSAVEM: the data is memory from start to end', eq(f.data, code), hex(f.data));
  check('CSAVEM with the end before the start: ?FC ERROR', after(b, 'CSAVEM "X",100,99,0').includes('?FC ERROR'));
}

// ---------------- (3) tapes made by buildCas ----------------
// machine code: LDA #42 : STA $3500 : RTS
const MC = [0x86, 0x2A, 0xB7, 0x35, 0x00, 0x39];
const mcTape = Emu.buildCas([{ name: 'MC', type: 'binary', load: 0x3000, exec: 0x3000, data: MC }]);
{
  const b = boot();
  insert(b, mcTape);
  const w = watch(b, 'CLOADM');
  check('CLOADM: the screen cleared, then "F MC" and OK on the second row', wiped(w, 'CLOADM') && eq(w.screen, ['F MC', 'OK']), JSON.stringify(w));
  check('CLOADM: the prompt\'s cursor on the third row ($0440)', ((b.m.ram[0x88] << 8) | b.m.ram[0x89]) === 0x440);
  check('CLOADM: the bytes at the load address', eq(b.m.ram.slice(0x3000, 0x3006), MC));
  check('CLOADM then EXEC runs it from the exec address', after(b, 'EXEC:PRINT PEEK(&H3500)').includes(' 42'));
  const c = boot();
  insert(c, mcTape);
  line(c, 'CLOADM "MC",&H200');
  check('CLOADM with an offset: the bytes at load + offset', eq(c.m.ram.slice(0x3200, 0x3206), MC) && c.m.ram[0x3000] === 0);
  line(c, 'POKE &H3000,57');   // an RTS where the file would be without the offset
  check('CLOADM with an offset: EXEC runs it from exec + offset', after(c, 'EXEC:PRINT PEEK(&H3500)').includes(' 42'));
  insert(c, mcTape);
  const f = watch(c, 'CLOAD');
  check('CLOAD of machine code: "F MC", then ?FM ERROR on the second row', eq(f.screen, ['F MC', '?FM ERROR', 'OK']), JSON.stringify(f.screen));
}
// a tokenised program saved at another address (CoCo-style $2601): the links are rebuilt
{
  const at = 0x2601, l1 = [0x00, 0x0A, tok('T_PRINT'), ...bytes('"OK1"'), 0], l2 = [0x00, 0x14, tok('T_PRINT'), 0x32, tok('T_PLUS'), 0x33, 0];
  const a2 = at + 2 + l1.length, e = a2 + 2 + l2.length;
  const data = [a2 >> 8, a2 & 0xFF, ...l1, e >> 8, e & 0xFF, ...l2, 0, 0];
  const b = boot();
  insert(b, Emu.buildCas([{ name: 'TOK', type: 'basic', data }]));
  line(b, 'CLOAD');
  check('CLOAD of a program saved elsewhere: LIST', eq(listing(b), ['10 PRINT"OK1"', '20 PRINT2+3']), JSON.stringify(listing(b)));
  const ram = program(b), b2 = PROGST + 2 + l1.length;
  check('CLOAD of a program saved elsewhere: the links point into our program', ram[0] === b2 >> 8 && ram[1] === (b2 & 0xFF));
  const run = after(b, 'RUN');
  check('... and it runs', eq(run, ['RUN', 'OK1', ' 5', 'OK']), JSON.stringify(run));
  insert(b, Emu.buildCas([{ name: 'TOK', type: 'basic', data }]));
  const fm = watch(b, 'CLOADM');
  check('CLOADM of a program: "F TOK", ?FM ERROR on the second row', eq(fm.screen, ['F TOK', '?FM ERROR', 'OK']), JSON.stringify(fm.screen));
}
// a tape that ends right after the last block's checksum, with no $55 after it (archive .cas files often lack it):
// the last bit has no edge after it, and the load must still finish
{
  const l1 = [0x00, 0x0A, tok('T_PRINT'), ...bytes('"END"'), 0], a2 = PROGST + 2 + l1.length;
  const data = [a2 >> 8, a2 & 0xFF, ...l1, 0, 0];
  const tape = Emu.buildCas([{ name: 'CUT', type: 'basic', data }]);
  check('a tape built normally ends with $55 (the cut below is real)', tape[tape.length - 1] === 0x55 && tape[tape.length - 2] === 0xFF);
  const b = boot();
  insert(b, tape.slice(0, -1));
  let s, err = null;
  try { s = after(b, 'CLOAD', 3000); } catch (e) { err = e.message; }
  check('CLOAD of a tape with no $55 after its last block: it finishes', !err && s[s.length - 1] === 'OK' && eq(listing(b), ['10 PRINT"END"']), err || JSON.stringify(s));
  check('... and the motor is off', !err && !b.m.deck.motor);
}
// a program as text, in two blocks; a text line without a number
{
  const text = [];
  for (let i = 1; i <= 15; i++) text.push(`${i * 10} PRINT "TEXT LINE ${i}"`);
  const b = boot();
  insert(b, Emu.buildCas([{ name: 'ASC', type: 'basic', ascii: true, data: bytes(text.join('\r') + '\r') }]));
  line(b, 'CLOAD');
  check('CLOAD of a text program over 255 bytes (two blocks)', text.join('\r').length > 255 && eq(listing(b), text), JSON.stringify(listing(b).slice(-3)));
  insert(b, Emu.buildCas([{ name: 'DS', type: 'basic', ascii: true, data: bytes('10 PRINT 1\rPRINT 2\r') }]));
  const w = watch(b, 'CLOAD');
  // [BB bb5 cas-errors] a line without a number that is its block's last: the error once the next block (here the
  // end of file) is read, F changed back at its leader
  check('a text line without a number, its block\'s last: ?DS ERROR after the end of file is read (F normal again)', eq(w.screen, ['F DS', '?DS ERROR', 'OK']) && eq(w.seq.slice(-2), ['f DS', 'F DS']), JSON.stringify(w));
  // [BB bb8 cas-multi] the lines before it are kept
  check('?DS ERROR: the lines before it are kept', eq(listing(b), ['10 PRINT 1']), JSON.stringify(listing(b)));
  // [BB bb8 cas-multi] with more after it in its block: the error at once, the blocks after it not read (the letter
  // left inverse by the one data block read), and the next search goes on from the next block
  const rest = []; for (let i = 2; i <= 9; i++) rest.push(`${i * 10} REM MORE TEXT AFTER THE LINE ${i}`);
  const ds2 = Emu.buildCas([{ name: 'DS2', type: 'basic', ascii: true, data: bytes(['10 PRINT 1', 'PRINT 2', ...rest].join('\r') + '\r') },
    { name: 'NEXT', type: 'basic', ascii: true, data: bytes('7 REM NEXT\r') }]);
  check('the tape: DS2 has two data blocks', [...Emu.casBlocks(ds2)].filter((k) => k.type === 1).length === 3);
  insert(b, ds2);
  const w2 = watch(b, 'CLOAD');
  check('a line without a number with more in its block: ?DS ERROR at once ("f DS2": its second block not read)', eq(w2.screen, ['f DS2', '?DS ERROR', 'OK']) && eq(w2.seq.slice(-2), ['F DS2', 'f DS2']), JSON.stringify(w2));
  check('... the lines before it kept', eq(listing(b), ['10 PRINT 1']), JSON.stringify(listing(b)));
  const nx = watch(b, 'CLOAD');
  check('... and CLOAD goes on from the next block: DS2\'s second block and end of file, no clear at its end, then NEXT', eq(nx.seq, ['(clear)', 'S', 's', 'S', 's', 'F NEXT', 'f NEXT', 'F NEXT']) && eq(listing(b), ['7 REM NEXT']), JSON.stringify(nx.seq));
  // [BB bb5 cas-errors] CLOAD of a data file: ?DS ERROR, F normal (its end-of-file block read)
  insert(b, Emu.buildCas([{ name: 'NOTES', type: 'data', data: bytes('JUST DATA\r') }]));
  const d = watch(b, 'CLOAD');
  check('CLOAD of a data file: "F NOTES", ?DS ERROR on the second row', eq(d.screen, ['F NOTES', '?DS ERROR', 'OK']) && topBytes(b)[0] === 0x46, JSON.stringify(d.screen));
  // a data file whose lines have numbers loads as a program saved as text [OWN]
  insert(b, Emu.buildCas([{ name: 'NUM', type: 'data', data: bytes('10 PRINT 3\r') }]));
  watch(b, 'CLOAD');
  check('CLOAD of a data file of numbered lines: they go in as a program', eq(listing(b), ['10 PRINT 3']), JSON.stringify(listing(b)));
}

// ---------------- (4) names, SKIPF, errors, BREAK, MOTOR ----------------
const ONE = [0x1E, 0x0A, 0x00, 0x01, tok('T_REM'), ...bytes('ONE'), 0, 0, 0];
const two = (n) => [0x1E, 0x0A, 0x00, 0x02, tok('T_REM'), ...bytes(n), 0, 0, 0];
const twoFiles = Emu.buildCas([{ name: 'ONE', type: 'basic', data: ONE }, { name: 'TWO', type: 'basic', data: two('TWO') }]);
{
  const b = boot();
  insert(b, twoFiles);
  const w = watch(b, 'CLOAD "TWO"');
  check('CLOAD "TWO": "F TWO" and OK at the end', eq(w.screen, ['F TWO', 'OK']), JSON.stringify(w.screen));
  // ONE: its name after the S (still inverse from its namefile's leader), S changing at its data block and end of
  // file, the screen cleared at its end; then TWO found
  check('CLOAD "TWO": "S ONE" while ONE passes, a clear at its end, then "F TWO"',
    eq(w.seq, ['(clear)', 'S', 's', 'S ONE', 's ONE', '(clear)', 'S', 's', 'F TWO', 'f TWO', 'F TWO']), JSON.stringify(w.seq));
  check('CLOAD "TWO": TWO is loaded', eq(listing(b), ['2 REMTWO']), JSON.stringify(listing(b)));
  const c = boot();
  insert(c, twoFiles);
  // [BB bb5 cas-errors] a search that starts in the middle of a file (after ?FM ERROR at a namefile) does not clear
  // the screen at that file's end: only a file whose namefile it met is cleared away
  const e = boot();
  insert(e, Emu.buildCas([{ name: 'MC', type: 'binary', load: 0x3000, exec: 0x3000, data: MC }, { name: 'ONE', type: 'basic', data: ONE }]));
  check('CLOAD of machine code first: ?FM ERROR', eq(watch(e, 'CLOAD').screen, ['F MC', '?FM ERROR', 'OK']));
  const mid = watch(e, 'CLOAD');
  check('CLOAD from the middle of a file: no clear at its end, S changing at its blocks, then "F ONE"',
    eq(mid.seq, ['(clear)', 'S', 's', 'S', 's', 'F ONE', 'f ONE', 'F ONE']) && eq(mid.screen, ['F ONE', 'OK']), JSON.stringify(mid));
  const k = watch(c, 'SKIPF');
  check('SKIPF: the file passed over shown as found, "F ONE", OK on the second row', wiped(k, 'SKIPF') && eq(k.screen, ['F ONE', 'OK']) && eq(k.seq, ['(clear)', 'S', 's', 'F ONE', 'f ONE', 'F ONE']), JSON.stringify(k));
  line(c, 'CLOAD');
  check('SKIPF then CLOAD: the second file', eq(listing(c), ['2 REMTWO']), JSON.stringify(listing(c)));
  const d = boot();
  insert(d, twoFiles);
  line(d, 'SKIPF "ONE"');
  line(d, 'CLOAD');
  check('SKIPF "ONE" then CLOAD: the second file', eq(listing(d), ['2 REMTWO']));
}
{
  // a data byte changed with its checksum left as it was
  const cas = Emu.buildCas([{ name: 'BAD', type: 'basic', data: two('GOOD') }]);
  const blocks = [...Emu.casBlocks(cas)];
  const bad = Uint8Array.from(cas); bad[blocks[1].start + 3 + 6] ^= 0x01;
  check('the corrupted tape has one bad block', [...Emu.casBlocks(bad)].filter((k) => !k.ok).length === 1);
  const b = boot();
  line(b, '5 REM KEEP');
  insert(b, bad);
  const w = watch(b, 'CLOAD');
  // [BB bb5 cas-errors] "f BAD" (inverse f: the bad block's leader changed it) and the error on the second row
  check('CLOAD of a bad block: "f BAD", ?IO ERROR on the second row', eq(w.screen, ['f BAD', '?IO ERROR', 'OK']) && topBytes(b)[0] === 0x06, JSON.stringify(w.screen));
  check('?IO ERROR: no half-loaded program is left', listing(b).length === 0 && program(b).length === 2, JSON.stringify(listing(b)));
  check('?IO ERROR: the motor is off', !b.m.deck.motor);
  // [BB bb5 cas-errors] the file is left open: the next SKIPF is ?AO ERROR, with no clear and the tape not read
  insert(b, cas);
  const s = after(b, 'SKIPF');
  check('SKIPF after ?IO ERROR: ?AO ERROR, the screen not cleared', eq(s, ['SKIPF', '?AO ERROR', 'OK']) && b.screen().includes('?IO ERROR'), JSON.stringify(s));
  check('?AO ERROR: the tape is not read (still at its start)', b.m.deck.tape.progress() === 0, String(b.m.deck.tape.progress()));
  // [BB bb8 cas-left-open] ?AO ERROR leaves it open: OPEN and CSAVE are refused too, the tape untouched; EOF(-1) is -1
  // and PRINT #-1 ?FM ERROR (a file open for input)
  check('... and again: OPEN, CSAVE ?AO ERROR, the motor not run', eq(after(b, 'OPEN "O",#-1,"X"'), ['OPEN "O",#-1,"X"', '?AO ERROR', 'OK']) && eq(after(b, 'CSAVE "X"'), ['CSAVE "X"', '?AO ERROR', 'OK']) && b.m.deck.tape.progress() === 0 && !b.m.deck.motor);
  check('the file left open: EOF(-1) is -1, PRINT #-1 ?FM ERROR', eq(after(b, 'PRINT EOF(-1)'), ['PRINT EOF(-1)', '-1', 'OK']) && eq(after(b, 'PRINT #-1,1'), ['PRINT #-1,1', '?FM ERROR', 'OK']));
  // [BB bb8 cas-left-open] CLOAD goes ahead with it open: the same tape intact loads (the corruption is what failed)
  line(b, 'CLOAD');
  check('CLOAD with the file left open: the intact tape loads', eq(listing(b), ['2 REMGOOD']));
  // [BB bb8 cas-left-open] a bad block in a file passed over: SKIPF and CLOAD "NAME" give ?IO ERROR there
  const badThen = Emu.buildCas([{ name: 'BAD', type: 'basic', ascii: true, data: bytes('10 REM X\r') }, { name: 'GOOD', type: 'basic', data: two('GOOD') }]);
  const bt = Uint8Array.from(badThen), bk = [...Emu.casBlocks(badThen)];
  bt[bk[1].start + 3 + 1] ^= 0x01;
  const c = boot();
  insert(c, bt);
  const sk = watch(c, 'SKIPF');
  check('SKIPF over a file with a bad block: "f BAD", ?IO ERROR', eq(sk.screen, ['f BAD', '?IO ERROR', 'OK']), JSON.stringify(sk.screen));
  insert(c, bt);
  const nm = watch(c, 'CLOAD "GOOD"');
  check('CLOAD "GOOD" passing a file with a bad block: "S BAD", ?IO ERROR, nothing loaded', eq(nm.screen, ['S BAD', '?IO ERROR', 'OK']) && listing(c).length === 0, JSON.stringify(nm.screen));
}
{
  const b = boot();
  b.type('CLOAD\n');
  b.run(100);
  check('CLOAD with no tape: the motor runs while it searches', b.m.deck.motor && !b.screen().includes('OK', 2));
  // [BB bb5 cas-errors] BREAK does not stop a search: the original searched on after BREAK with OK awaited 10 s
  const job = b.m.typist.holdPaced('BREAK');
  for (let i = 0; job.status === 'typing' && i < 300; i++) b.frame();
  b.run(500);
  check('BREAK does not stop CLOAD\'s search: still searching 10 s later, motor on, S alone on a clear screen', b.m.deck.motor && eq(b.screen(), ['S']) && b.m.ram[0x400] === 0x53, JSON.stringify(b.screen()));
}
{
  // SKIPF with no file on the tape searches as CLOAD does, motor on, and BREAK does not stop it either
  const b = boot();
  b.type('SKIPF\n');
  b.run(500);
  check('SKIPF with no file on the tape: still searching after 10 s, motor on, the screen cleared, S', b.m.deck.motor && eq(b.screen(), ['S']) && b.m.ram[0x400] === 0x53, JSON.stringify(b.screen()));
  const job = b.m.typist.holdPaced('BREAK');
  for (let i = 0; job.status === 'typing' && i < 300; i++) b.frame();
  b.run(500);
  check('BREAK does not stop SKIPF\'s search', b.m.deck.motor && eq(b.screen(), ['S']), JSON.stringify(b.screen()));
}
{
  const b = boot();
  line(b, 'MOTOR ON');
  check('MOTOR ON: the motor runs', b.m.deck.motor);
  line(b, 'MOTOR OFF');
  check('MOTOR OFF: the motor stops', !b.m.deck.motor);
  check('MOTOR without ON or OFF: ?SN ERROR', after(b, 'MOTOR').includes('?SN ERROR'));
  const st = ['10 CSAVEM "A",1,2,3', '15 CLOADM "B",4:CLOADM', '20 CSAVE "C",A:SKIPF "D"', '30 CLOAD "E":MOTOR OFF'];
  for (const l of st) line(b, l);
  check('the cassette statements LIST as typed', eq(listing(b), st), JSON.stringify(listing(b)));
}
// MOTOR ON waits, as the cassette does, for a motor that was off [BB bb4 cas-motor-audio: MOTOR ON, an empty FOR
// of 500 passes and MOTOR OFF on one line, a motor run of 54.02 fields], and again for one already running [BB bb10
// time-motor: MOTOR ON:MOTOR ON:B=TIMER:MOTOR OFF, a run of 50.72 fields, MOTOR ON:A=TIMER:MOTOR OFF 25.44]
{
  const { runCase } = require('./basic/harness.js');
  const runs = (rom, line) => { const r = runCase(rom, `#tape three-progs\n${line}\n#tape-blocks w\n`); return r.tapes[0].motor.map((x) => x.length); };
  const loop = 'MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF';
  const near = (rom) => { const m = runs(rom, loop); return m.length === 1 && Math.abs(m[0] - 54.02) <= 1 ? m[0] : `${m}`; };
  const got = near(rom);
  check('MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF: a run of 54.02 fields (within one), as on the original', typeof got === 'number', `${got}`);
  const twice = runs(rom, 'MOTOR ON:MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF');
  check('... a second MOTOR ON with the motor running waits again: one wait (about 25.3 fields on the original) longer', twice.length === 1 && twice[0] - got >= 25 && twice[0] - got <= 26.5, `${twice}`);
  const mrom = buildBasic({ edit: (f, t) => { if (f !== 'cassette.inc') return t; if (!t.includes('        LDX     #MOTDLY\n        BSR     CW0')) throw new Error('mutant source not found: MOTOR'); return t.replace('        LDX     #MOTDLY\n        BSR     CW0', '        LDX     #1\n        BSR     CW0'); } }).rom;
  check('mutant "MOTOR ON does not wait": the run is no longer 54.02 fields', typeof near(mrom) !== 'number', `${near(mrom)}`);
}

// ---------------- LIST and CLOAD as the corpus records show them [BB corpus] ----------------
{
  // a line that ends at the right edge of the screen (32 or 64 characters) is followed by no empty row
  const b = boot();
  line(b, '10 REM ' + 'X'.repeat(25));
  line(b, '20 REM ' + 'Y'.repeat(57));
  line(b, '30 REM Z');
  const l = listing(b);
  check('LIST: no empty row after a line that fills its last row (32 and 64 characters)', eq(l, ['10 REM ' + 'X'.repeat(25), '20 REM ' + 'Y'.repeat(25), 'Y'.repeat(32), '30 REM Z']), JSON.stringify(l));
  line(b, 'NEW');
  line(b, '10 REM ' + 'X'.repeat(24));
  check('LIST: a line one short of the edge ends with its carriage return as before', eq(listing(b), ['10 REM ' + 'X'.repeat(24)]));
}
{
  // a program on tape with a line of 304 characters' text, then its end marker, then bytes that look like more lines
  const text = [tok('T_REM'), ...bytes('A'.repeat(300))];
  const prog = [0x1E, 0x07, 0x00, 0x0A, ...text, 0, 0x1F, 0x00, 0x00, 0x14, tok('T_REM'), ...bytes('B'), 0, 0, 0, 0x12, 0x34, 0x00, 0x00, ...bytes('!!!'), 0, 0, 0];
  const b = boot();
  insert(b, Emu.buildCas([{ name: 'LONG', type: 'basic', data: prog }]));
  line(b, 'CLOAD');
  line(b, 'CLS');
  const rows = listing(b), joined = rows.slice(0, -1).join('');
  check('LIST: at most 249 characters of a line\'s text', joined === '10 ' + ('REM' + 'A'.repeat(300)).slice(0, 249) && rows[rows.length - 1] === '20 REMB', JSON.stringify(rows.map((r) => r.length)));
  check('CLOAD: the program ends at its end marker; what was loaded after it is no line', eq(rows.slice(-1), ['20 REMB']) && program(b).length === text.length + 5 + 4 + 2 + 1 + 2, JSON.stringify(rows.slice(-2)));
}
// ---------------- (5) data files: OPEN, PRINT #-1, INPUT #-1, LINE INPUT #-1, EOF(-1), CLOSE ----------------
// The program of the black-box case cas-files (tests/basic/cases/cas-files.bas) and what the original did with it
// [BB bb4 cas-files]. The data bytes are written out by hand from what PRINT #-1 is given: a record per item, ended
// by a carriage return (";" and "," end one too), a number with its sign's place and no space after it. The same
// bytes' SHA-256 is the one the original's block has in the record (bb4-real.jsonl), so the hand derivation is checked
// against the original without its bytes being kept.
const WRITE = ['10 OPEN "O",#-1,"F"', '20 PRINT #-1,"HELLO";42', '30 PRINT #-1,"A,B","C"', '40 FOR I=1 TO 3:PRINT #-1,I*I:NEXT',
  '50 PRINT #-1,"LAST LINE"', '60 CLOSE #-1', '70 PRINT "WRITTEN"'];
const RECORDS = ['HELLO', ' 42', 'A,B', 'C', ' 1', ' 4', ' 9', 'LAST LINE'];
const FILEDATA = bytes(RECORDS.join('\r') + '\r');
const REAL_SHA = 'b4ad57e2103b13abbebd8d11df8c828675990ed6a87a60b31c9bfd2be8a307eb';  // [BB bb4 cas-files] its block 2
const sha = (a) => require('crypto').createHash('sha256').update(Uint8Array.from(a)).digest('hex');
check('data file: the hand-derived records have the original\'s data hash', sha(FILEDATA) === REAL_SHA && FILEDATA.length === 35);

// the data-file checks, run on a ROM: -> [[name, ok, detail]]; run on ours (every section), then on mutants of ours
// (below), each only through the section it breaks (only: a section's name), from a fresh machine, the read sections
// with the tape our own ROM wrote (ourTape): a mutant then costs its section, not the whole replay
const SECTIONS = ['write', 'read', 'forms', 'named', 'errors', 'kinds', 'across', 'errout', 'big'];
let ourTape = null;
function* dataFileChecks(r, only = null) {
  const want = (sec) => !only || only === sec;
  const ck = (name, ok, detail = '') => [name, !!ok, detail];
  const boot1 = () => { const b = new Basic(r); if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no boot'); return b; };
  const say = (b, text, limit) => { try { return after(b, text, limit); } catch (e) { return [`(no OK: ${e.message})`]; } };
  const prog = (b, lines) => { line(b, 'NEW'); for (const l of lines) line(b, l); };
  let b = boot1(), tape = ourTape;
  if (want('write')) {
  // writing
  for (const l of WRITE) line(b, l);
  b.m.deck.startRecording();
  const run = say(b, 'RUN');
  const ev = b.m.deck.stopRecording();
  const dec = Emu.samplesToCas(Emu.recordingToSamples(ev, b.m.tickHz), 44100), blocks = [...Emu.casBlocks(dec.bytes)];
  yield ck('OPEN "O", PRINT #-1, CLOSE in a program: RUN prints only WRITTEN', eq(run, ['RUN', 'WRITTEN', 'OK']), JSON.stringify(run));
  yield ck('the file: a namefile, one data block, an end-of-file block, all good', dec.badBlocks === 0 && eq(blocks.map((k) => k.type), [0, 1, 0xFF]) && blocks.every((k) => k.ok), JSON.stringify(blocks.map((k) => [k.type, k.data.length, k.ok])));
  yield ck('the namefile: "F" padded, type 1 (data), ASCII $FF, gaps $FF, exec 0, load 0', blocks[0] && eq(blocks[0].data, [...bytes('F       '), 1, 0xFF, 0xFF, 0, 0, 0, 0]), blocks[0] && hex(blocks[0].data));
  yield ck('the data block: the records, each ended by CR; no space after a number', blocks[1] && eq(blocks[1].data, FILEDATA), blocks[1] && JSON.stringify(Buffer.from(blocks[1].data).toString('latin1')));
  yield ck('the end-of-file block is empty', blocks[2] && blocks[2].data.length === 0);
  // the motor's runs: the namefile, the data block (written at CLOSE), the end of file [BB bb4 cas-files: three]
  let runs = 0, on = false;
  for (const [, lv] of ev) { if (lv !== null && !on) runs++; on = lv !== null; }
  yield ck('the motor ran three times (namefile; data block; end of file), and is off', runs === 3 && !b.m.deck.motor, `${runs} runs`);
  tape = dec.bytes;
  if (!only) ourTape = tape;
  }
  if (want('read')) {
  // reading it back: INPUT #-1 until EOF(-1), then past the end
  prog(b, ['10 OPEN "I",#-1,"F"', '20 IF EOF(-1) THEN 50', '30 INPUT #-1,A$:PRINT "<";A$;">"', '40 GOTO 20', '50 PRINT "END OF FILE"', '60 INPUT #-1,A$']);
  insert(b, tape);
  const rd = say(b, 'RUN', 8000);
  const clears = b.clears.length, flags = b.flags.map((f) => `${f.frame}:${f.row}`);
  yield ck('INPUT #-1 reads each record (leading spaces dropped, commas kept), EOF(-1) ends the loop, then ?IE ERROR IN 60',
    eq(rd, ['RUN', ...RECORDS.map((x) => `<${x.trim()}>`), 'END OF FILE', '?IE ERROR IN 60', 'OK']), JSON.stringify(rd));
  // [BB bb4 cas-files, bb8 cas-data2] no clear and no change to the top row but the scroll's: no blink either
  yield ck('OPEN "I" and the reads leave the screen alone: no clear, the top row never written but by a scroll', clears === 0 && flags.length === 0, `${clears} clears, ${JSON.stringify(flags)}`);
  yield ck('the motor is off after the reads', !b.m.deck.motor);
  yield ck('CLOSE #-1 after ?IE ERROR: OK', eq(say(b, 'CLOSE #-1'), ['CLOSE #-1', 'OK']));
  // in direct mode too, a data file shows nothing [OWN: the records' data files are read in programs]
  insert(b, tape);
  const od = say(b, 'OPEN "I",#-1,"F":PRINT EOF(-1)', 8000);
  yield ck('OPEN "I" and EOF(-1) typed in direct mode: nothing shown either', eq(od, ['OPEN "I",#-1,"F":PRINT EOF(-1)', ' 0', 'OK']) && b.clears.length === 0 && b.flags.length === 0, `${JSON.stringify(od)} ${b.clears.length} clears ${JSON.stringify(b.flags)}`);
  line(b, 'CLOSE');
  }
  if (want('forms')) {
  // the forms without #, and LINE INPUT #-1 (leading spaces kept)
  prog(b, ['10 OPEN "I",-1,""', '20 IF EOF(-1) THEN 50', '30 LINE INPUT #-1,L$:PRINT "[";L$;"]"', '40 GOTO 20', '50 CLOSE -1', '60 PRINT "DONE"']);
  insert(b, tape);
  const li = say(b, 'RUN', 8000);
  yield ck('OPEN "I",-1,"", LINE INPUT #-1 (spaces kept), CLOSE -1', eq(li, ['RUN', ...RECORDS.map((x) => `[${x}]`), 'DONE', 'OK']), JSON.stringify(li));
  yield ck('CLOSE -1 closed it: PRINT #-1 is ?NO ERROR', eq(say(b, 'PRINT #-1,1'), ['PRINT #-1,1', '?NO ERROR', 'OK']));
  yield ck('INPUT #-1 in direct mode: ?ID ERROR', eq(say(b, 'INPUT #-1,A'), ['INPUT #-1,A', '?ID ERROR', 'OK']));
  }
  // a tape made by buildCas: a file passed over, then a data file with a comma in a record, numbers, a bad number
  const two = Emu.buildCas([{ name: 'OTHER', type: 'data', data: bytes('NOT THIS\r') },
    { name: 'DATA', type: 'data', data: bytes('HELLO,42\r 3.5\r7,8\rX\r') }]);
  if (want('named')) {
  prog(b, ['10 OPEN "I",#-1,"DATA"', '20 INPUT #-1,A$,B', '30 INPUT #-1,C,D', '40 PRINT A$;"/";B;"/";C;"/";D', '50 INPUT #-1,E']);
  insert(b, two);
  const nm = say(b, 'RUN', 8000);
  yield ck('OPEN "I" with a name passes another file; a string item takes the whole record, numbers split at commas; a bad number ?FD ERROR',
    eq(nm, ['RUN', 'HELLO,42/ 3.5 / 7 / 8', '?FD ERROR IN 50', 'OK']), JSON.stringify(nm));
  yield ck('... and nothing of the search on the screen (no clear)', b.clears.length === 0);
  line(b, 'CLOSE');
  }
  if (want('errors')) {
  // errors: the file open the other way, opened twice, other devices and modes
  prog(b, ['10 OPEN "I",#-1,"DATA"', '20 PRINT #-1,1']);
  insert(b, two);
  yield ck('PRINT #-1 to a file open for input: ?FM ERROR', eq(say(b, 'RUN', 8000), ['RUN', '?FM ERROR IN 20', 'OK']));
  insert(b, two);
  // [BB bb8 cas-data-errors, cas-left-open] SKIPF, CSAVE and OPEN refuse with a file open, which stays open
  yield ck('SKIPF with a file open: ?AO ERROR, the tape not read', eq(say(b, 'SKIPF'), ['SKIPF', '?AO ERROR', 'OK']) && b.m.deck.tape.progress() === 0);
  yield ck('... and the file still open: PRINT #-1 still ?FM ERROR', eq(say(b, 'PRINT #-1,1'), ['PRINT #-1,1', '?FM ERROR', 'OK']));
  // [BB bb8 cas-left-open] CLOAD goes ahead: the data file OTHER, ?DS ERROR; the file open is forgotten
  say(b, 'CLOAD');
  yield ck('CLOAD with a file open goes ahead: OTHER read (a data file: ?DS ERROR)', eq(b.screen(), ['F OTHER', '?DS ERROR', 'OK']) && b.m.deck.tape.progress() > 0, JSON.stringify(b.screen()));
  yield ck('... after which no file is open: PRINT #-1 is ?NO ERROR', eq(say(b, 'PRINT #-1,1'), ['PRINT #-1,1', '?NO ERROR', 'OK']));
  prog(b, ['10 OPEN "O",#-1,"A"', '20 INPUT #-1,X']);
  yield ck('INPUT #-1 from a file open for output: ?FM ERROR', eq(say(b, 'RUN'), ['RUN', '?FM ERROR IN 20', 'OK']));
  yield ck('OPEN with a file already open: ?AO ERROR', eq(say(b, 'OPEN "O",#-1,"B"'), ['OPEN "O",#-1,"B"', '?AO ERROR', 'OK']));
  yield ck('INPUT #-1 in a program with no file open: ?NO ERROR', eq(say(b, 'RUN 20'), ['RUN 20', '?NO ERROR IN 20', 'OK']));
  yield ck('EOF(-1) with no file open: ?NO ERROR', eq(say(b, 'PRINT EOF(-1)'), ['PRINT EOF(-1)', '?NO ERROR', 'OK']));
  yield ck('CLOSE with nothing open: OK, the motor not run', eq(say(b, 'CLOSE #-1'), ['CLOSE #-1', 'OK']) && eq(say(b, 'CLOSE'), ['CLOSE', 'OK']) && !b.m.deck.motor);
  yield ck('a device other than -1, 0 and -2: ?DN ERROR', eq(say(b, 'OPEN "I",#-3,"X"'), ['OPEN "I",#-3,"X"', '?DN ERROR', 'OK']) && eq(say(b, 'OPEN "O",#1,"X"'), ['OPEN "O",#1,"X"', '?DN ERROR', 'OK']) && eq(say(b, 'CLOSE #0'), ['CLOSE #0', '?DN ERROR', 'OK']));
  // [BB bb8 cas-data-errors] OPEN to the screen (0) or the printer (-2): no error, nothing opened, nothing written
  const p0 = b.m.deck.tape.progress();
  yield ck('OPEN "O",#-2 and OPEN "O",#0: OK, the tape not moved, no file open (PRINT #-1 ?NO ERROR)', eq(say(b, 'OPEN "O",#-2,"E"'), ['OPEN "O",#-2,"E"', 'OK']) && eq(say(b, 'OPEN "O",#0,"E"'), ['OPEN "O",#0,"E"', 'OK']) && b.m.deck.tape.progress() === p0 && eq(say(b, 'PRINT #-1,1'), ['PRINT #-1,1', '?NO ERROR', 'OK']));
  yield ck('a mode other than I or O: ?FM ERROR', eq(say(b, 'OPEN "X",#-1,"X"'), ['OPEN "X",#-1,"X"', '?FM ERROR', 'OK']));
  }
  if (want('kinds')) {
  // [BB bb8 cas-data2] INPUT #-1 with items left in its record: the rest dropped, no ?EXTRA IGNORED; OPEN "I" of
  // machine code or of a tokenised program ?FM ERROR (closed: CLOSE is no error), of a program as text read
  const mixed = Emu.buildCas([{ name: 'D', type: 'data', data: bytes('1,2,3\rX\r') }, { name: 'CODE', type: 'binary', load: 0x3000, exec: 0x3000, data: MC },
    { name: 'TOK', type: 'basic', data: ONE }, { name: 'TXT', type: 'basic', ascii: true, data: bytes('10 PRINT 1\r') }]);
  prog(b, ['10 OPEN "I",#-1,"D"', '20 INPUT #-1,A,B:PRINT A;B', '30 INPUT #-1,C$:PRINT "<";C$;">"', '40 CLOSE #-1']);
  insert(b, mixed);
  yield ck('INPUT #-1 with an item left in the record: dropped, no ?EXTRA IGNORED', eq(say(b, 'RUN', 8000), ['RUN', ' 1  2', '<X>', 'OK']));
  for (const [nm, want] of [['CODE', ['RUN', '?FM ERROR IN 10', 'OK']], ['TOK', ['RUN', '?FM ERROR IN 10', 'OK']], ['TXT', ['RUN', '[10 PRINT 1]', 'OK']]]) {
    prog(b, [`10 OPEN "I",#-1,"${nm}"`, '20 LINE INPUT #-1,L$:PRINT "[";L$;"]"', '30 CLOSE #-1']);
    insert(b, mixed);
    yield ck(`OPEN "I" of ${nm}: ${want[1]}`, eq(say(b, 'RUN', 8000), want) && eq(say(b, 'CLOSE #-1'), ['CLOSE #-1', 'OK']));
  }
  }
  if (want('across')) {
  // [BB bb8 cas-data-errors] a file open for output across NEW (?AO ERROR after it) and across RUN (closed as CLOSE
  // does: its data and end of file written before the program's OPEN); OPEN "O" builds its namefile in the block
  // buffer over the last record written, so its exec and load addresses are that record's bytes 11-14
  const c = boot1();
  const rec = (text) => { c.m.deck.startRecording(); const t = say(c, text, 8000); const ev = c.m.deck.stopRecording(); return { t, blocks: [...Emu.casBlocks(Emu.samplesToCas(Emu.recordingToSamples(ev, c.m.tickHz), 44100).bytes)] }; };
  const nf = (k) => k && k.type === 0 && [String.fromCharCode(...k.data.slice(0, 8)).trim(), (k.data[11] << 8) | k.data[12], (k.data[13] << 8) | k.data[14]];
  prog(c, ['10 OPEN "O",#-1,"N"', '20 PRINT #-1,"OPEN ACROSS NEW"']);
  const r1 = rec('RUN');
  yield ck('a fresh machine\'s OPEN "O": the namefile\'s exec and load 0', eq(nf(r1.blocks[0]), ['N', 0, 0]), JSON.stringify(nf(r1.blocks[0])));
  line(c, 'NEW');
  yield ck('NEW leaves it open: OPEN ?AO ERROR', eq(say(c, 'OPEN "O",#-1,"P"'), ['OPEN "O",#-1,"P"', '?AO ERROR', 'OK']));
  const r2 = rec('CLOSE #-1');
  yield ck('... and CLOSE then writes its record and the end of file', eq(r2.blocks.map((k) => k.type), [1, 0xFF]) && eq(r2.blocks[0].data, bytes('OPEN ACROSS NEW\r')));
  prog(c, ['10 OPEN "O",#-1,"R"', '20 PRINT #-1,"OPEN ACROSS RUN"']);
  const r3 = rec('RUN');
  yield ck('OPEN "O" after a record was written: exec and load are its bytes 11-14 (" NEW")', eq(nf(r3.blocks[0]), ['R', 0x204E, 0x4557]), JSON.stringify(nf(r3.blocks[0])));
  const r4 = rec('RUN');
  yield ck('RUN closes the file left open: its record and end of file, then the new namefile (" RUN")', eq(r4.blocks.map((k) => k.type), [1, 0xFF, 0]) && eq(r4.blocks[0].data, bytes('OPEN ACROSS RUN\r')) && eq(nf(r4.blocks[2]), ['R', 0x2052, 0x554E]), JSON.stringify(r4.blocks.map((k) => k.type)));
  line(c, 'CLOSE');
  }
  if (want('errout')) {
  // (last of the machine's checks: it leaves a file open for output)
  yield ck('an error in PRINT #-1 is shown on the screen, and the output is the screen again', eq(say(b, 'OPEN "O",#-1,"Z":PRINT #-1,1/0', 300), ['OPEN "O",#-1,"Z":PRINT #-1,1/0', '?/0 ERROR', 'OK']) && b.m.ram[0x6F] === 0);
  }
  if (want('big')) {
  // a file over 255 bytes: blocks of 255 and the rest, written as the buffer fills; read back whole
  const c = boot1();
  ['10 OPEN "O",#-1,"BIG"', '20 FOR I=1 TO 40:PRINT #-1,"RECORD";I:NEXT', '30 CLOSE #-1'].forEach((l) => line(c, l));
  c.m.deck.startRecording();
  say(c, 'RUN', 20000);
  const bev = c.m.deck.stopRecording(), big = Emu.samplesToCas(Emu.recordingToSamples(bev, c.m.tickHz), 44100);
  const want = []; for (let i = 1; i <= 40; i++) want.push('RECORD', ` ${i}`);
  const all = bytes(want.join('\r') + '\r'), bb = [...Emu.casBlocks(big.bytes)].filter((k) => k.type === 1);
  const sizes = []; for (let left = all.length; left > 0; left -= 255) sizes.push(Math.min(255, left));
  yield ck(`a file of ${all.length} bytes: data blocks of 255 and the rest, the bytes in order`, all.length > 255 && eq(bb.map((k) => k.data.length), sizes) && eq(bb.flatMap((k) => Array.from(k.data)), all), bb.map((k) => k.data.length).join(','));
  prog(c, ['10 OPEN "I",#-1,"BIG":N=0', '20 IF EOF(-1) THEN 40', '30 INPUT #-1,A$,B:N=N+B:GOTO 20', '40 CLOSE #-1:PRINT A$;N']);
  insert(c, big.bytes);
  const sum = say(c, 'RUN', 20000);
  yield ck('... read back across its blocks: the 40 records', eq(sum, ['RUN', 'RECORD 820', 'OK']), JSON.stringify(sum));
  }
}
for (const [name, ok, detail] of dataFileChecks(rom)) check(`data file: ${name}`, ok, detail);
// mutants: our own source broken on purpose; each must turn at least one of the checks above red, in the section
// named last (the one it breaks: SECTIONS)
const MUTANTS = [
  ['a number printed to the tape keeps its space after it', 'print.inc', '        BEQ     PRNXT           ; (no space after it on the tape)', '        BRA     *+2', 'write'],
  ['; writes no carriage return to the tape', 'print.inc', 'PRSEMI  BSR     TAPCR', 'PRSEMI  BSR     TAPEQ', 'write'],
  ['a string record from the tape ends at a comma', 'io.inc', '        BMI     GI5A\n        CMPA    #\',\'', '        BRA     *+2\n        CMPA    #\',\'', 'read'],
  ['OPEN "I" shows the search as CLOAD does', 'cassette.inc', 'CFIND   BSR     CQUIET\n        BMI     CF1', 'CFIND   BSR     CQUIET\n        BRA     *+2', 'read'],
  ['a data file\'s blocks blink', 'cassette.inc', '        BMI     CRS0\n        LDB     #$40', '        BRA     *+2\n        LDB     #$40', 'read'],
  ['a data file is not quiet (CLDBAS not looked at)', 'cassette.inc', 'CQ1     ORA     <CLDBAS', 'CQ1     NOP\n        NOP', 'read'],
  ['INPUT #-1 says ?EXTRA IGNORED', 'io.inc', 'INP5    TST     <ITMCOL', 'INP5    TST     <TRCFLG', 'kinds'],
  ['OPEN "I" of machine code let through', 'cassette.inc', '        LBHI    CLFM\n        TSTB', '        BRA     OP2\n        TSTB', 'kinds'],
  ['OPEN "I" of a tokenised program let through', 'cassette.inc', '        TSTB\n        LBEQ    CLFM', '        TSTB\n        BRA     OP2', 'kinds'],
  ['OPEN "O" with the printer\'s device is ?DN ERROR', 'cassette.inc', '        CMPD    #-1\n        LBNE    DNERR', '        CMPD    #-3\n        LBNE    DNERR', 'errors'],
  ['?AO ERROR closes the file', 'cassette.inc', 'GETNAO  TST     <CLDBAS\n        BPL     GETNAM\n        LDB     #ERR_AO', 'GETNAO  TST     <CLDBAS\n        BPL     GETNAM\n        CLR     <CLDBAS\n        LDB     #ERR_AO', 'errors'],
  ['CLOAD refuses with a file open', 'cassette.inc', 'GETNAM  CLR     <CLDBAS', 'GETNAM  TST     <CLDBAS\n        LBMI    GETNAO\n        CLR     <CLDBAS', 'errors'],
  ['RUN leaves a file open', 'interp.inc', 'RUN1    JSR     CLO1', 'RUN1    NOP\n        NOP\n        NOP', 'across'],
  ['OPEN "O" writes exec and load 0', 'cassette.inc', '        STD     ,U\n        STB     2,U', '        STD     ,U\n        STB     2,U\n        CLR     3,U\n        CLR     4,U\n        CLR     5,U\n        CLR     6,U', 'across'],
  ['EOF(-1) never true', 'cassette.inc', '        TFR     CC,B            ; C set (data): 0; clear (the end): -1', '        ORCC    #1', 'read'],
  ['the file type written as 0', 'cassette.inc', '        LDD     #$01FF          ; a data file, ASCII, gaps', '        LDD     #$00FF', 'write'],
  ['CLOSE writes no end-of-file block', 'cassette.inc', '        JSR     CFLUSH\n        JMP     CWDA2', '        JSR     CFLUSH\n        JMP     CASOFF', 'write'],
  ['PRINT #-1 with no file open is let through', 'cassette.inc', 'FILCHK  CMPA    <CLDBAS\n        BEQ     DVC1', 'FILCHK  CMPA    <CLDBAS\n        BRA     DVC1', 'forms'],
  ['a record not cut at the end of the file (?IE never)', 'cassette.inc', '        LBCC    IEERR', '        BRA     *+4', 'read'],
  ['a byte of a block taken with a signed offset (past 127: the screen)', 'cassette.inc', '        ABX                     ; (B unsigned: up to 254)\n        LDA     ,X', '        LDA     B,X\n        NOP', 'big'],
  ['the output left on the tape after an error', 'errors.inc', '        CLR     <DEVNUM         ; (the message on the screen, whatever PRINT #-1 was doing [OWN])', '', 'errout'],
];
// (the read sections take the tape ours wrote: without it a mutant would throw, and a throw counts as red)
if (!ourTape) throw new Error('the data-file checks on ours wrote no tape: the mutants of the read sections cannot run');
for (const [what, file, from, to, sec] of MUTANTS) {
  let mrom, err = null;
  try {
    mrom = buildBasic({ edit: (f, t) => { if (f !== file) return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${what}`); return t.replace(from, to); } }).rom;
  } catch (e) { err = e.message; }
  let red = [];
  if (!err) { try { if (!SECTIONS.includes(sec)) throw new Error(`no section ${sec}`); for (const [name, ok] of dataFileChecks(mrom, sec)) if (!ok) { red.push(name); break; } } catch (e) { red = [`(threw: ${e.message})`]; } }
  check(`mutant "${what}" turns a data-file check red`, !err && red.length > 0, err || red[0] || 'none failed');
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
