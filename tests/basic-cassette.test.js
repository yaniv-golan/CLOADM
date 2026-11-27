// Run: node tests/basic-cassette.test.js
//
// The clean-room BASIC's cassette statements (basic/cassette.inc; docs/clean-room-basic.md): CSAVE, CSAVE ,A, CSAVEM
// and CLOAD of what they wrote, and LIST and CLOAD as the corpus records show them, typed in through the keyboard on a
// Dragon 64 running our ROM (assembled at test time; no other ROM is used), with the emulator's cassette deck as the
// tape. The oracle is the repository's own tape code, which the MAME tape tests verify, never our ROM's: what our ROM
// writes is decoded from the deck's recording by js/media/cassette.js (samplesToCas) and js/media/formats.js
// (parseCas), and the tapes it reads are built by buildCas and played by the deck's Tape. The expected bytes are written out here by hand from the program typed (and checked
// against the program in RAM), not computed by the ROM.
//
// What is proved:
//  * a program saved with CSAVE and loaded back with CLOAD (into the same machine after NEW, and into a fresh
//    one) LISTs exactly as typed and is the same bytes in memory; one over 255 bytes takes several data blocks;
//  * the tape's blocks: a namefile with the name, type, flags and addresses, data blocks of 255 and the rest, an
//    end-of-file block, every checksum right, the leader counts the decoder reads as on the original's tapes;
//  * CSAVE ,A writes the LIST text, gapped, and CLOAD reads it back as a program; CSAVEM writes memory with its
//    addresses;
//  * the display while CLOAD reads (docs/clean-room-basic.md section 12): the screen cleared, S then F and the name,
//    changing between normal and inverse once a block, OK on the second row; the top row's bytes checked;
//  * LIST: no empty row after a line that fills its last row, at most 249 characters of a line; a program loaded ends
//    at its end marker.
// The other parts: tests/basic-cassette-tapes.test.js (tapes made by buildCas, names, SKIPF, errors),
// tests/basic-cassette-motor.test.js (searches, BREAK, MOTOR), tests/basic-cassette-data*.test.js (data files). The
// original's bb8 cassette records replayed on ours: tests/basic-cassette-bb8.test.js.
const { Emu, check, tally, eq, hex, tok, PROGST, boot, line, after, record, insert, program, listing, topBytes, watch, wiped, bytes } = require('./basic/basic-cassette-lib.js');

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
  // [BB bb10 cas-timing csave: 1, 2, 2] the namefile's and the data block's leaders (256 $55, then a pause while the
  // checksum is worked out, then the block's own $55) are split from their blocks by the pause, so the decoder drops
  // them: it counts the block's own $55, and the $55 after the block before
  check('CSAVE: the decoder counts 1 $55 before the namefile, 2 before the data block and the end of file, as on the original', eq(leaders, [1, 2, 2]), leaders.join(','));
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
  // [BB bb10 cas-ascii-save: the data block's SHA-256 is that of a CR, then each line and its CR]
  check('CSAVE ,A: the data is a CR, then the LIST text, lines ended by CR', eq(f.data, bytes('\r' + LINES.join('\r') + '\r')), JSON.stringify(Buffer.from(f.data).toString('latin1')));
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

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
