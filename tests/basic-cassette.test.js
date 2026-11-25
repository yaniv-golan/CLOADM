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
//  * errors: a bad checksum gives ?IO ERROR and leaves no half program; CLOADM of a program and CLOAD of
//    machine code give ?FM ERROR; a text line without a number ?DS ERROR; BREAK stops the search; MOTOR ON/OFF
//    switch the deck's motor.
const { buildBasic } = require('../tools/build-basic.js');
const { Basic, Emu } = require('./basic/harness.js');

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
  const s = after(b, 'CLOAD');
  check('CLOAD: prints SEARCHING and FOUND PROG', eq(s, ['CLOAD', 'SEARCHING', 'FOUND PROG', 'OK']), JSON.stringify(s));
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
  line(b, 'CLOAD');
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
  const s = after(b, 'CLOADM');
  check('CLOADM: SEARCHING, FOUND MC', eq(s, ['CLOADM', 'SEARCHING', 'FOUND MC', 'OK']), JSON.stringify(s));
  check('CLOADM: the bytes at the load address', eq(b.m.ram.slice(0x3000, 0x3006), MC));
  check('CLOADM then EXEC runs it from the exec address', after(b, 'EXEC:PRINT PEEK(&H3500)').includes(' 42'));
  const c = boot();
  insert(c, mcTape);
  line(c, 'CLOADM "MC",&H200');
  check('CLOADM with an offset: the bytes at load + offset', eq(c.m.ram.slice(0x3200, 0x3206), MC) && c.m.ram[0x3000] === 0);
  line(c, 'POKE &H3000,57');   // an RTS where the file would be without the offset
  check('CLOADM with an offset: EXEC runs it from exec + offset', after(c, 'EXEC:PRINT PEEK(&H3500)').includes(' 42'));
  insert(c, mcTape);
  check('CLOAD of machine code: ?FM ERROR', after(c, 'CLOAD').includes('?FM ERROR'));
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
  check('CLOADM of a program: ?FM ERROR', after(b, 'CLOADM').includes('?FM ERROR'));
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
  check('a text line without a number: ?DS ERROR', after(b, 'CLOAD').includes('?DS ERROR'));
}

// ---------------- (4) names, SKIPF, errors, BREAK, MOTOR ----------------
const ONE = [0x1E, 0x0A, 0x00, 0x01, tok('T_REM'), ...bytes('ONE'), 0, 0, 0];
const two = (n) => [0x1E, 0x0A, 0x00, 0x02, tok('T_REM'), ...bytes(n), 0, 0, 0];
const twoFiles = Emu.buildCas([{ name: 'ONE', type: 'basic', data: ONE }, { name: 'TWO', type: 'basic', data: two('TWO') }]);
{
  const b = boot();
  insert(b, twoFiles);
  const s = after(b, 'CLOAD "TWO"');
  check('CLOAD "TWO": skips ONE, finds TWO', eq(s, ['CLOAD "TWO"', 'SEARCHING', 'SKIP ONE', 'FOUND TWO', 'OK']), JSON.stringify(s));
  check('CLOAD "TWO": TWO is loaded', eq(listing(b), ['2 REMTWO']), JSON.stringify(listing(b)));
  const c = boot();
  insert(c, twoFiles);
  line(c, 'SKIPF');
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
  const s = after(b, 'CLOAD');
  check('CLOAD of a bad block: ?IO ERROR', eq(s, ['CLOAD', 'SEARCHING', 'FOUND BAD', '?IO ERROR', 'OK']), JSON.stringify(s));
  check('?IO ERROR: no half-loaded program is left', listing(b).length === 0 && program(b).length === 2, JSON.stringify(listing(b)));
  check('?IO ERROR: the motor is off', !b.m.deck.motor);
  // the same tape intact loads (the corruption is what failed)
  insert(b, cas);
  line(b, 'CLOAD');
  check('the intact tape loads', eq(listing(b), ['2 REMGOOD']));
}
{
  const b = boot();
  b.type('CLOAD\n');
  b.run(100);
  check('CLOAD with no tape: the motor runs while it searches', b.m.deck.motor && !b.screen().includes('OK', 2));
  const job = b.m.typist.holdPaced('BREAK');
  for (let i = 0; job.status === 'typing' && i < 500; i++) b.frame();
  check('BREAK stops the search: OK, motor off', b.waitOk({ limit: 300 }) && !b.m.deck.motor, JSON.stringify(b.screen()));
  line(b, 'MOTOR ON');
  check('MOTOR ON: the motor runs', b.m.deck.motor);
  line(b, 'MOTOR OFF');
  check('MOTOR OFF: the motor stops', !b.m.deck.motor);
  check('MOTOR without ON or OFF: ?SN ERROR', after(b, 'MOTOR').includes('?SN ERROR'));
  const st = ['10 CSAVEM "A",1,2,3', '15 CLOADM "B",4:CLOADM', '20 CSAVE "C",A:SKIPF "D"', '30 CLOAD "E":MOTOR OFF'];
  for (const l of st) line(b, l);
  check('the cassette statements LIST as typed', eq(listing(b), st), JSON.stringify(listing(b)));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
