// Run: node tests/basic-cassette-tapes.test.js
//
// The clean-room BASIC's CLOAD, CLOADM, EXEC and SKIPF on tapes made by buildCas (basic/cassette.inc;
// docs/clean-room-basic.md), typed in through the keyboard on a Dragon 64 running our ROM (assembled at test time; no
// other ROM is used), with the emulator's cassette deck as the tape. The oracle is the repository's own tape code, which
// the MAME tape tests verify, never our ROM's: the tapes are built by buildCas and played by the deck's Tape.
//
// What is proved:
//  * CLOADM to the load address, with an offset, and EXEC runs it; a tokenised program saved at another address is
//    relinked; a text program loads; a tape with no $55 after its last block still loads; CLOAD "NAME" skips other
//    files; SKIPF;
//  * the display while it reads (docs/clean-room-basic.md section 12, from the black-box records bb4 and bb5): the
//    screen cleared, S at the top left changing between normal and inverse once a block, a file passed over shown
//    as its name after the S and the screen cleared again at its end, the file wanted as F and its name, F then
//    changing once a block, the OK prompt or the error on the second row;
//  * errors: a bad checksum gives ?IO ERROR (the top row left "f NAME") and leaves no half program, the file left
//    open: SKIPF, OPEN and CSAVE are then ?AO ERROR without reading the tape, EOF(-1) is -1, CLOAD goes ahead; a bad
//    block in a file passed over is ?IO ERROR (SKIPF, CLOAD "NAME"); CLOADM of a program and CLOAD of machine code
//    give ?FM ERROR; a text line without a number ?DS ERROR when the next line is begun (at once with more in its
//    block), the lines before it kept; CLOAD of a data file ?DS ERROR.
// The rest of the cassette tests: tests/basic-cassette.test.js.
const { Emu, check, tally, eq, tok, PROGST, boot, line, after, insert, program, listing, topBytes, watch, wiped, bytes, MC, ONE } = require('./basic/basic-cassette-lib.js');

// ---------------- (3) tapes made by buildCas ----------------
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

// ---------------- (4) names, SKIPF, errors ----------------
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
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
