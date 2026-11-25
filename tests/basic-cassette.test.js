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
//    end-of-file block, every checksum right, a leader of at least 128 $55 bytes before each;
//  * CSAVE ,A writes the LIST text, gapped, and CLOAD reads it back as a program; CSAVEM writes memory with its
//    addresses;
//  * tapes made by buildCas: CLOADM to the load address, with an offset, and EXEC runs it; a tokenised program
//    saved at another address is relinked; a text program loads; CLOAD "NAME" skips other files; SKIPF;
//  * the display while it reads (docs/clean-room-basic.md section 12, from the black-box records bb4 and bb5): the
//    screen cleared, S at the top left changing between normal and inverse once a block, a file passed over shown
//    as its name after the S and the screen cleared again at its end, the file wanted as F and its name, F then
//    changing once a block, the OK prompt or the error on the second row; the top row's bytes checked;
//  * errors: a bad checksum gives ?IO ERROR (the top row left "f NAME") and leaves no half program, and the next
//    SKIPF is ?AO ERROR without reading the tape; CLOADM of a program and CLOAD of machine code give ?FM ERROR; a
//    text line without a number ?DS ERROR, after the whole file is read; CLOAD of a data file ?DS ERROR; BREAK does
//    not stop the search; MOTOR ON/OFF switch the deck's motor.
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
  check('CSAVE: a leader of at least 128 $55 bytes before every block', leaders.every((c) => c >= 128), leaders.join(','));
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
  // [BB bb5 cas-errors] the error comes once the end-of-file block is read: F changed back at its leader
  check('a text line without a number: ?DS ERROR after the whole file (F normal again)', eq(w.screen, ['F DS', '?DS ERROR', 'OK']) && eq(w.seq.slice(-2), ['f DS', 'F DS']), JSON.stringify(w));
  check('?DS ERROR: the lines before it are not kept', listing(b).length === 0);
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
  // ?AO ERROR closed it: the same tape intact loads (the corruption is what failed)
  line(b, 'CLOAD');
  check('after ?AO ERROR the intact tape loads', eq(listing(b), ['2 REMGOOD']));
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
console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
