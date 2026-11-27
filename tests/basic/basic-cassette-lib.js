// The shared part of tests/basic-cassette*.test.js: the clean-room BASIC's cassette statements (basic/cassette.inc;
// docs/clean-room-basic.md), typed in through the keyboard on a Dragon 64 running our ROM (assembled at test time; no
// other ROM is used), with the emulator's cassette deck as the tape. The oracle is the repository's own tape code,
// which the MAME tape tests verify, never our ROM's: what our ROM writes is decoded from the deck's recording by
// js/media/cassette.js (samplesToCas) and js/media/formats.js (parseCas), and the tapes it reads are built by buildCas
// and played by the deck's Tape. Here: the helpers that type and watch, the data-file checks (run on ours by groups of
// sections) and the mutants of our own source, each of which turns a data-file check red.
const { buildBasic } = require('../../tools/build-basic.js');
const { Basic, Emu, cell } = require('./harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const tally = () => ({ n, fail });
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
// the top row of the screen: its first ten bytes
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

// machine code: LDA #42 : STA $3500 : RTS
const MC = [0x86, 0x2A, 0xB7, 0x35, 0x00, 0x39];
// a one-line program, 1 REM ONE, saved at $1E01
const ONE = [0x1E, 0x0A, 0x00, 0x01, tok('T_REM'), ...bytes('ONE'), 0, 0, 0];

// ---------------- data files: OPEN, PRINT #-1, INPUT #-1, LINE INPUT #-1, EOF(-1), CLOSE ----------------
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

// the data-file checks, run on a ROM: -> [[name, ok, detail]]; run on ours (a group of sections in order on one
// machine, the groups split over the tests/basic-cassette-data*.test.js files), then on mutants of ours (below), each
// only through the section it breaks, from a fresh machine, the read sections with the tape our own ROM wrote (io.tape,
// which the write section sets): a mutant then costs its section, not the whole replay
const SECTIONS = ['write', 'read', 'forms', 'named', 'errors', 'kinds', 'across', 'errout', 'big'];
function* dataFileChecks(r, sections = SECTIONS, io = {}) {
  const want = (sec) => sections.includes(sec);
  const ck = (name, ok, detail = '') => [name, !!ok, detail];
  const boot1 = () => { const b = new Basic(r); if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no boot'); return b; };
  const say = (b, text, limit) => { try { return after(b, text, limit); } catch (e) { return [`(no OK: ${e.message})`]; } };
  const prog = (b, lines) => { line(b, 'NEW'); for (const l of lines) line(b, l); };
  let b = boot1(), tape = io.tape;
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
  io.tape = tape;
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
  // typed in direct mode, OPEN "I" shows the search as CLOAD does: the screen cleared, S, then F and the name, and the
  // first data block, read by OPEN, changes the F [BB bb10 cas-left-open2: OPEN "I",#-1,"GOOD" typed, the screen
  // cleared, s, F GOOD, f GOOD]
  insert(b, tape);
  say(b, 'OPEN "I",#-1,"F":PRINT EOF(-1)', 8000);
  const rows = b.screen().filter((l) => l.trim()), tops = b.flags.map((f) => f.row);
  yield ck('OPEN "I" typed in direct mode: the screen cleared, F F then f F (OPEN reads the first data block), EOF(-1) 0',
    b.clears.length === 1 && tops.includes('F F') && tops[tops.length - 1] === 'f F' && eq(rows, ['f F', ' 0', 'OK']), `${JSON.stringify(rows)} ${b.clears.length} clears ${JSON.stringify(tops)}`);
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
  // the decoder drops the leader of a block of 10 or more bytes written after the motor started (the pause before the
  // block splits the signal, as the original's does): read straight from that decoding, the data blocks after the
  // motor's stops are missed, their leaders gone while the motor gets up to speed [BB bb10 cas-timing data-read:
  // ?IE ERROR IN 10 on the original, a block missed]
  insert(c, big.bytes);
  const short = say(c, 'RUN', 20000);
  // (the second and third data blocks missed, the end of file, its leader kept, read: the first block's 24 records)
  yield ck('... read straight from the decoded recording: the blocks after a stop missed, as on the original', eq(short, ['RUN', 'RECORD 300', 'OK']), JSON.stringify(short));
  // with every block given a leader of 128 (as a tape played from its .CAS file has): all 40 records
  const lead = []; for (const k of Emu.casBlocks(big.bytes)) { let sum = k.type + k.data.length; for (const x of k.data) sum += x; lead.push(...new Array(128).fill(0x55), 0x3C, k.type, k.data.length, ...k.data, sum & 0xFF, 0x55); }
  line(c, 'CLOSE');
  insert(c, Uint8Array.from(lead));
  const sum = say(c, 'RUN', 20000);
  yield ck('... read back across its blocks: the 40 records', eq(sum, ['RUN', 'RECORD 820', 'OK']), JSON.stringify(sum));
  }
}

// mutants: our own source broken on purpose; each must turn at least one of the checks above red, in the section
// named last (the one it breaks: SECTIONS)
const MUTANTS = [
  ['a number printed to the tape keeps its space after it', 'print.inc', '        BEQ     PRNXT           ; (no space after it on the tape)', '        BRA     *+2', 'write'],
  ['; writes no carriage return to the tape', 'print.inc', 'PRSEMI  BSR     TAPCR', 'PRSEMI  BSR     TAPEQ', 'write'],
  ['a string record from the tape ends at a comma', 'io.inc', '        BMI     GI5A\n        CMPA    #\',\'', '        BRA     *+2\n        CMPA    #\',\'', 'read'],
  ['OPEN "I" shows the search as CLOAD does', 'cassette.inc', 'CFIND   BSR     CQUIET\n        BMI     CF1', 'CFIND   BSR     CQUIET\n        BRA     *+2', 'read'],
  ['a data file\'s blocks blink', 'cassette.inc', '        BMI     CRS0\n        LDB     #$40', '        BRA     *+2\n        LDB     #$40', 'read'],
  ['INPUT #-1 says ?EXTRA IGNORED', 'io.inc', 'INP5    TST     <ITMCOL', 'INP5    TST     <TRCFLG', 'kinds'],
  ['OPEN "I" of machine code let through', 'cassette.inc', '        LBHI    CLFM\n        TSTB', '        BRA     OP2\n        TSTB', 'kinds'],
  ['OPEN "I" of a tokenised program let through', 'cassette.inc', '        TSTB\n        LBEQ    CLFM', '        TSTB\n        BRA     OP2', 'kinds'],
  ['OPEN "O" with the printer\'s device is ?DN ERROR', 'cassette.inc', '        CMPD    #-1\n        LBNE    DNERR', '        CMPD    #-3\n        LBNE    DNERR', 'errors'],
  ['?AO ERROR closes the file', 'cassette.inc', 'GETNAO  TST     <CLDBAS\n        BPL     GETNAM\n        LDB     #ERR_AO', 'GETNAO  TST     <CLDBAS\n        BPL     GETNAM\n        CLR     <CLDBAS\n        LDB     #ERR_AO', 'errors'],
  ['CLOAD refuses with a file open', 'cassette.inc', 'GETNAM  CLR     <CLDBAS', 'GETNAM  TST     <CLDBAS\n        LBMI    GETNAO\n        CLR     <CLDBAS', 'errors'],
  ['RUN leaves a file open', 'interp.inc', 'RUN1    JSR     CLO1', 'RUN1    NOP\n        NOP\n        NOP', 'across'],
  ['OPEN "O" writes exec and load 0', 'cassette.inc', 'CWHEAD  LDB     #11', 'CWHEAD  LDB     #15', 'across'],
  ['EOF(-1) never true', 'cassette.inc', '        TFR     CC,B            ; C set (data): 0; clear (the end): -1', '        ORCC    #1', 'read'],
  ['the file type written as 0', 'cassette.inc', 'OPOUT   LDA     #1              ; a data file, ASCII, gaps', 'OPOUT   CLRA', 'write'],
  ['CLOSE writes no end-of-file block', 'cassette.inc', '        JSR     CFLUSH\n        JMP     CWDA2', '        JSR     CFLUSH\n        JMP     CASOFF', 'write'],
  ['PRINT #-1 with no file open is let through', 'cassette.inc', 'FILCHK  CMPA    <CLDBAS\n        BEQ     DVC1', 'FILCHK  CMPA    <CLDBAS\n        BRA     DVC1', 'forms'],
  ['a record not cut at the end of the file (?IE never)', 'cassette.inc', '        LBCC    IEERR', '        BRA     *+4', 'read'],
  ['a byte of a block taken with a signed offset (past 127: the screen)', 'cassette.inc', '        ABX                     ; (B unsigned: up to 254)\n        LDA     ,X', '        LDA     B,X\n        NOP', 'big'],
  ['the output left on the tape after an error', 'errors.inc', '        CLR     <DEVNUM         ; (the message on the screen, whatever PRINT #-1 was doing [OWN])', '', 'errout'],
];

// the data-file checks of the sections given, run on ours in order on one machine, each a check of its own
function runOurs(sections, io = {}) {
  for (const [name, ok, detail] of dataFileChecks(rom, sections, io)) check(`data file: ${name}`, ok, detail);
  return io;
}
// the tape our ROM writes in the write section (its checks are made in tests/basic-cassette-data.test.js), for the
// read sections' mutants in a file that does not run the write section on ours
function ourTape() {
  const io = {};
  for (const [name, ok, detail] of dataFileChecks(rom, ['write'], io)) if (!ok) throw new Error(`the write section failed on ours: ${name} ${detail}`);
  if (!io.tape) throw new Error('the write section on ours wrote no tape');
  return io.tape;
}
// the mutants of the sections given, each from a fresh machine through its section alone
function runMutants(sections, tape = null) {
  // (the read sections take the tape ours wrote: without it a mutant would throw, and a throw counts as red)
  if (MUTANTS.some(([, , , , sec]) => sections.includes(sec) && (sec === 'read' || sec === 'forms')) && !tape) throw new Error('no tape written by ours: the mutants of the read sections cannot run');
  for (const [what, file, from, to, sec] of MUTANTS) {
    if (!sections.includes(sec)) continue;
    let mrom, err = null;
    try {
      mrom = buildBasic({ edit: (f, t) => { if (f !== file) return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${what}`); return t.replace(from, to); } }).rom;
    } catch (e) { err = e.message; }
    let red = [];
    if (!err) { try { if (!SECTIONS.includes(sec)) throw new Error(`no section ${sec}`); for (const [name, ok] of dataFileChecks(mrom, [sec], { tape })) if (!ok) { red.push(name); break; } } catch (e) { red = [`(threw: ${e.message})`]; } }
    check(`mutant "${what}" turns a data-file check red`, !err && red.length > 0, err || red[0] || 'none failed');
  }
}

module.exports = { Basic, Emu, buildBasic, check, tally, eq, hex, rom, tok, PROGST, boot, line, after, record, insert, program, listing, topBytes,
  watch, wiped, bytes, MC, ONE, FILEDATA, REAL_SHA, sha, SECTIONS, MUTANTS, runOurs, ourTape, runMutants };
