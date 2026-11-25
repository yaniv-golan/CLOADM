// Run: node tests/basic-corpus.test.js
//
// Corpus mode of the black-box harness (tools/basic-bb/corpus.js):
//  * the corpus lint finds EXEC, USR, DEFUSR, CLOADM, CSAVEM, VARPTR and every PEEK that might read the ROM, by kind
//    and line number, and passes PEEK of RAM, of the I/O page and "... AND 32767", strings and remarks;
//  * listing rows join into program lines by their line numbers;
//  * keyword counts find keywords as BASIC crunches them (glued to names, GO TO as GO and TO), not in strings,
//    remarks or DATA, and count CIRCLE arcs and PUT actions apart; corpus-stats sums them over programs;
//  * the .keys sidecar parses, and a bad line is refused;
//  * the guard, on our own ROM, trips on machine code that reads the ROM and on a ROM routine that reads ROM data and
//    returns to machine code, and not on machine code that reads the I/O page or calls a routine that reads no ROM
//    data, nor on a BASIC program that runs no machine code, nor on code in RAM that ran before it was armed;
//  * compareCorpus reports a differing listing, the first RUN sample that parts, a differing status and error, and
//    missing programs, and passes identical records;
//  * end to end on our own ROM, with tapes of programs typed into it (their bytes taken from memory, put on tape by
//    buildCas): the listing comes back line by line (a line longer than a row joined), the run is sampled until it
//    ends, the error line is caught, a program the lint refuses is listed but not run, the text is hashed unless
//    asked for in full, and the CLI's two runs compare as identical;
//  * steps are judged by their result: with the typist reporting "not-consumed" for every line (as the real ROM's
//    CLOAD and LIST leave it) the program still loads, lists and runs, and the typist's status is only noted;
//  * a tape whose BASIC program comes after machine code is loaded by name; a tape with no BASIC is "no-basic";
//  * a program in the real token values (hand-encoded from the token probe's map) lists and counts its keywords;
//  * --only takes one name a time (names with commas) and --only-file a list.
const { corpusLint, joinListing, parseKeys, romGuard, runProgram, keywordCounts, firstBasic } = require('../tools/basic-bb/corpus.js');
const { stats } = require('../tools/basic-bb/corpus-stats.js');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { compareCorpus } = require('../tools/basic-bb/compare.js');
const { buildBasic } = require('../tools/build-basic.js');
const { Basic, Emu } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the corpus lint ----
const kinds = (line) => corpusLint([line]).map((p) => `${p.line}:${p.kind}`).join(',');
for (const [line, want] of [['10 X=PEEK(40000)', '10:peek'], ['20 X=PEEK(A)', '20:peek'], ['30 EXEC 32000', '30:machine-code'],
  ['40 X=USR0(1)', '40:machine-code'], ['50 DEFUSR0=1000', '50:machine-code'], ['60 CLOADM', '60:machine-code'],
  ['70 A=VARPTR(B$)', '70:machine-code'], ['80 X=PEEK(65504)', '80:peek'], ['90 X=PEEK(&HBFFF):EXEC', '90:machine-code,90:peek'],
  ['100 IF PEEK(A+1 OR 0 AND 32767) THEN 10', '100:peek']])
  check(`corpus lint: ${line}`, kinds(line) === want, kinds(line));
for (const line of ['10 X=PEEK(1024)', '10 IF PEEK(65280)=127 THEN 10', '10 X=PEEK(&HFF02)', '10 X=PEEK(A AND 32767)',
  '10 PRINT "EXEC PEEK(40000)"', '10 REM USR', "10 PRINT 1:' PEEK(40000)", '10 POKE 40000,1:POKE A,B', '10 DATA 1,2,3'])
  check(`corpus lint passes: ${line}`, corpusLint([line]).length === 0);

// ---- listing rows ----
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('rows without a line number run on', same(joinListing(['10 PRINT "A', 'B"', '20 END']), ['10 PRINT "A' + 'B"', '20 END']));
check('a row starting with a lower number runs on', same(joinListing(['10 A=1', '20 PRINT "', '15 POINTS"', '30 B=2']), ['10 A=1', '20 PRINT "15 POINTS"', '30 B=2']));
check('numbered rows are lines', same(joinListing(['10 A=1', '20 B=2']), ['10 A=1', '20 B=2']));

// ---- keyword counts ----
const kc = keywordCounts(['10 FORI=1TO9:PRINT"FOR";I:NEXT', '20 CIRCLE(128,96),50,4,1,0,.5:CIRCLE(9,9),5:PUT(0,0)-(9,9),A,PSET:PUT(0,0)-(9,9),A',
  '30 DATA PRINT,GOTO:GOTO 10', '40 REM PRINT', "50 ' PRINT", '60 X=INSTR(A$,B$)+TOTAL']);
const want = { FOR: 1, TO: 3, PRINT: 1, NEXT: 1, CIRCLE: 2, 'CIRCLE arc': 1, PUT: 2, 'PUT action': 1, PSET: 1, DATA: 1, GO: 1, INSTR: 1 };
check('keyword counts', JSON.stringify(Object.keys(kc).sort().map((k) => [k, kc[k]])) === JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]])), JSON.stringify(kc));
const st = stats([{ status: 'ended', keywords: { PRINT: 3, GO: 1 } }, { status: 'rom-read-possible', lint: [{ kind: 'peek' }, { kind: 'peek' }], keywords: { PRINT: 1 } }]);
check('corpus-stats', st.programs === 2 && st.status.ended === 1 && st.lint.peek === 1 && st.keywords.PRINT.programs === 2 && st.keywords.PRINT.uses === 4 && st.keywords.GO.uses === 1, JSON.stringify(st));

// ---- the .keys sidecar ----
const ev = parseKeys('# a comment\n100 keys SPACE\n200 keys SHIFT+UP 10\n300 type YES\\n\n');
check('keys: three events', ev.length === 3 && ev[0].hold === 6 && ev[1].keys.join('+') === 'SHIFT+UP' && ev[1].hold === 10 && ev[2].text === 'YES\n');
let threw = false;
try { parseKeys('soon keys A'); } catch { threw = true; }
check('keys: a bad line is refused', threw);

// ---- the guard, on our own ROM ----
const { rom, symbols } = buildBasic();
const s = (name) => symbols.get(name);
function guarded(lines, label) {
  const b = new Basic(rom);
  b.waitOk({ limit: 600, stable: 3 });
  const g = romGuard(b.m);
  g.watch();
  for (const l of lines) b.type(l + '\n');
  b.run(20);
  g.arm();
  b.type('RUN\n');
  const ok = b.waitOk();
  return { tripped: g.tripped, ok, label };
}
const mc = (bytes) => [`10 FOR I=0 TO ${bytes.length - 1}:READ A:POKE 28672+I,A:NEXT:EXEC 28672`, `20 DATA ${bytes.join(',')}`];
const hi = (v) => v >> 8, lo = (v) => v & 255;
for (const [label, lines, trips] of [
  ['machine code reading the ROM', mc([0xB6, 0xA0, 0x00, 0x39]), /read \$A000/],
  ['machine code reading the last ROM byte before the I/O page', mc([0xB6, 0xFE, 0xFF, 0x39]), /read \$FEFF/],
  ['a ROM routine reading ROM data, back in machine code', mc([0x8E, hi(s('BANNER')), lo(s('BANNER')), 0xBD, hi(s('PRTSTR')), lo(s('PRTSTR')), 0x39]), /returned/],
  ['machine code reading the reset vector', mc([0xFC, 0xFF, 0xFE, 0x39]), /read \$FFFE/],
  ['machine code reading the I/O page', mc([0xB6, 0xFF, 0x00, 0x39]), null],
  ['machine code calling CLS', mc([0xBD, hi(s('CLS')), lo(s('CLS')), 0x39]), null],
  // CLS called 40 times (most of the time in ROM code): the field interrupt lands in it, and its vector fetch is not
  // ROM data
  ['machine code calling CLS while interrupts come', mc([0xC6, 40, 0x34, 0x04, 0xBD, hi(s('CLS')), lo(s('CLS')), 0x35, 0x04, 0x5A, 0x26, 0xF6, 0x39]), null],
  ['a BASIC program with no machine code', ['10 FOR I=1 TO 20:PRINT I*I;:NEXT', '20 A$="X"+STR$(3):PRINT A$'], null]]) {
  const r = guarded(lines, label);
  check(`guard: ${label}`, r.ok && (trips ? trips.test(r.tripped || '') : r.tripped === null), String(r.tripped));
}

// code in RAM that ran before the guard was armed counts as BASIC's own (a ROM's routines in RAM run while it boots,
// loads and lists): run again after, it may read the ROM
{
  const b = new Basic(rom);
  b.waitOk({ limit: 600, stable: 3 });
  const g = romGuard(b.m);
  g.watch();
  for (const l of mc([0xB6, 0xA0, 0x00, 0x39])) b.type(l + '\n');
  b.type('RUN\n'); b.waitOk();
  g.arm();
  b.type('EXEC 28672\n');
  check('guard: code that ran before arm() is not the program\'s', b.waitOk() && g.tripped === null, String(g.tripped));
}

// ---- compareCorpus ----
const rec = (over = {}) => ({ program: 'GAME.cas', sha256: 'aa', status: 'ok', list: ['h1', 'h2'], samples: [{ frame: 50, screen: 's1', pix: 'p1' }, { frame: 100, screen: 's2', pix: 'p2' }], ...over });
const cmp = (x, y) => compareCorpus(new Map([['aa', x]]), new Map(y ? [['aa', y]] : []));
check('compareCorpus: identical', cmp(rec(), rec()).same === 1 && cmp(rec(), rec()).report.length === 0);
check('compareCorpus: listing', /LIST differs from line 2/.test(cmp(rec(), rec({ list: ['h1', 'hX'] })).report[0] || ''));
check('compareCorpus: run text', /RUN parts at frame 100 \(text\)/.test(cmp(rec(), rec({ samples: [rec().samples[0], { frame: 100, screen: 'sX', pix: 'p2' }] })).report[0] || ''));
check('compareCorpus: run pixels', /RUN parts at frame 50 \(pixels\)/.test(cmp(rec(), rec({ samples: [{ frame: 50, screen: 's1', pix: 'pX' }] })).report[0] || ''));
check('compareCorpus: shorter run', /after frame 50 \(2 vs 1 samples\)/.test(cmp(rec(), rec({ samples: [rec().samples[0]] })).report[0] || ''));
check('compareCorpus: status and error', /status ok vs rom-read.*error null vs "\?SN ERROR IN 20"/.test(cmp(rec(), rec({ status: 'rom-read', error: '?SN ERROR IN 20' })).report[0] || ''));
check('compareCorpus: full text shown', /"10 A=1" vs "10 A=2"/.test(cmp(rec({ full: true, list: ['10 A=1'] }), rec({ full: true, list: ['10 A=2'] })).report[0] || ''));
check('compareCorpus: missing', /missing from the second file/.test(cmp(rec(), null).report[0] || ''));

// ---- end to end on our own ROM ----
function tape(lines, name) {
  const b = new Basic(rom);
  b.waitOk({ limit: 600, stable: 3 });
  for (const l of lines) b.type(l + '\n');
  b.run(20);
  const w = (a) => (b.m.ram[a] << 8) | b.m.ram[a + 1], start = w(s('TXTTAB')), end = w(s('VARTAB'));
  return Emu.buildCas([{ name, type: 'basic', data: b.m.ram.slice(start, end) }]);
}
const prog = ['10 CLS:PRINT "HELLO"', '20 FOR I=1 TO 3:PRINT I:NEXT', '30 PRINT "A LINE THAT IS LONGER THAN ONE ROW OF THE SCREEN"', '40 PRINT 1/0'];
const listed = ['10 CLS:PRINT "HELLO"', '20 FOR I=1 TO 3:PRINT I:NEXT', '30 PRINT "A LINE THAT IS LONGER', 'THAN ONE ROW OF THE SCREEN"', '40 PRINT 1/0'];
const cas = tape(prog, 'DEMO');
const full = runProgram(rom, cas, { name: 'DEMO', full: true, frames: 400, every: 25 });
check('run: the listing, row by row', same(full.list, listed) && full.listLines === 4, JSON.stringify(full.list));
check('run: keyword counts from the listing', full.keywords.PRINT === 4 && full.keywords.FOR === 1 && full.keywords.CLS === 1, JSON.stringify(full.keywords));
check('run: ended, with its error line', full.status === 'ended' && full.error === '?/0 ERROR IN 40', `${full.status} ${full.error}`);
check('run: the samples show the program\'s output', full.samples.length > 1 && full.samples[0].screen[0] === 'HELLO' && full.samples[0].screen.includes(' 3') && /^[0-9a-f]{16}$/.test(full.samples[0].pix), JSON.stringify(full.samples[0]));
const hashed = runProgram(rom, cas, { name: 'DEMO', frames: 400, every: 25 });
check('run: hashed by default', hashed.list.length === 5 && hashed.list.every((h) => /^[0-9a-f]{16}$/.test(h)) && typeof hashed.samples[0].screen === 'string' && !JSON.stringify(hashed).includes('HELLO'));
const peeky = runProgram(rom, tape(['10 PRINT PEEK(40000)', '20 PRINT "NEVER"'], 'PEEKY'), { name: 'PEEKY', full: true });
check('run: a program the lint refuses is listed, not run', peeky.status === 'rom-read-possible' && !peeky.samples && peeky.lint.length === 1 && peeky.lint[0].line === '10' && peeky.listLines === 2, JSON.stringify(peeky));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  fs.writeFileSync(path.join(dir, 'DEMO.cas'), cas);
  fs.writeFileSync(path.join(dir, 'DEMO.keys'), '# no keys are read: the run must still match\n30 keys SPACE\n');
  const cli = (out, extra = []) => execFileSync(process.execPath, [path.join(__dirname, '../tools/basic-bb/corpus.js'), '--ours', '--corpus', dir, '--out', path.join(dir, out), '--frames', '300', ...extra], { encoding: 'utf8' });
  cli('a.jsonl'); cli('b.jsonl');
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8'));
  check('cli: one record, with the tape\'s sha256 and the ROM\'s CRC', r.program === 'DEMO.cas' && /^[0-9a-f]{64}$/.test(r.sha256) && /^[0-9A-F]{8}$/.test(r.rom) && r.full === false);
  const cmp2 = execFileSync(process.execPath, [path.join(__dirname, '../tools/basic-bb/compare.js'), path.join(dir, 'a.jsonl'), path.join(dir, 'b.jsonl')], { encoding: 'utf8' });
  check('cli: two runs compare as identical', /1 programs identical/.test(cmp2), cmp2.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- steps judged by their result ----
{
  const real = Basic.prototype.type;
  Basic.prototype.type = function (t, limit) { real.call(this, t, limit); return 'not-consumed'; };
  let r;
  try { r = runProgram(rom, cas, { name: 'DEMO', full: true, frames: 400, every: 25 }); } finally { Basic.prototype.type = real; }
  check('typist not-consumed: still loads, lists and runs', r.status === 'ended' && r.listLines === 4 && r.error === '?/0 ERROR IN 40', JSON.stringify({ status: r.status, at: r.at }));
  check('typist not-consumed: noted, not an error', r.typist && r.typist.CLOAD === 'not-consumed' && r.typist.LIST === 'not-consumed' && r.typist.RUN === 'not-consumed', JSON.stringify(r.typist));
}

// ---- tapes with machine code first, or no BASIC ----
const progBytes = (lines) => {   // a tokenised program with any link values (CLOAD relinks)
  const out = [];
  for (const [num, body] of lines) out.push(0x12, 0x34, num >> 8, num & 255, ...body, 0);
  return [...out, 0, 0];
};
const bin = { name: 'CODE', type: 'binary', load: 0x3000, exec: 0x3000, data: [0x39] };
{
  const prog = { name: 'GAME', type: 'basic', data: progBytes([[10, [0x87, 0x20, 0x31]]]) };   // 10 PRINT 1
  const two = Emu.buildCas([bin, prog]);
  check('firstBasic: after machine code', JSON.stringify(firstBasic(two)) === JSON.stringify({ name: 'GAME', first: false }));
  const r = runProgram(rom, two, { name: 'TWO', full: true, frames: 200, every: 25 });
  check('machine code first: the BASIC file is loaded by name', r.loadedByName === true && same(r.list, ['10 PRINT 1']) && r.status === 'ended', JSON.stringify(r));
  const none = runProgram(rom, Emu.buildCas([bin]), { name: 'BIN' });
  check('a tape with no BASIC: no-basic', none.status === 'no-basic' && firstBasic(Emu.buildCas([bin])) === null, JSON.stringify(none));
}

// ---- the real token values ----
{
  // from the token probe's map (tests/basic/bb/bb1-real.jsonl): $80 FOR, $87 PRINT, $BC TO, $8B NEXT, $CB =,
  // $FF $80 SGN, $FF $84 RND
  const prog = { name: 'TOK', type: 'basic', data: progBytes([
    [10, [0x80, 0x49, 0xCB, 0x31, 0x20, 0xBC, 0x20, 0x33]],                    // 10 FORI=1 TO 3
    [20, [0x87, 0x20, 0xFF, 0x80, 0x28, 0x49, 0x29, 0x3B, 0xFF, 0x84, 0x28, 0x30, 0x29]],   // 20 PRINT SGN(I);RND(0)
    [30, [0x8B]]]) };                                                        // 30 NEXT
  const r = runProgram(rom, Emu.buildCas([prog]), { name: 'TOK', full: true, frames: 200, every: 25 });
  check('real tokens: the listing', same(r.list, ['10 FORI=1 TO 3', '20 PRINT SGN(I);RND(0)', '30 NEXT']), JSON.stringify(r.list));
  check('real tokens: the keyword counts', JSON.stringify(r.keywords) === JSON.stringify({ FOR: 1, TO: 1, PRINT: 1, SGN: 1, RND: 1, NEXT: 1 }), JSON.stringify(r.keywords));
}

// ---- --only: one name a time, names with commas ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-only-'));
  fs.writeFileSync(path.join(dir, 'Game, The.cas'), cas);
  fs.writeFileSync(path.join(dir, 'Other.cas'), cas);
  const run = (args) => { execFileSync(process.execPath, [path.join(__dirname, '../tools/basic-bb/corpus.js'), '--ours', '--corpus', dir, '--out', path.join(dir, 'o.jsonl'), '--frames', '50', ...args]); return fs.readFileSync(path.join(dir, 'o.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).program); };
  check('--only with a comma in the name', same(run(['--only', 'Game, The']), ['Game, The.cas']));
  fs.writeFileSync(path.join(dir, 'names.txt'), 'Game, The.cas\nOther\n');
  check('--only-file', same(run(['--only-file', path.join(dir, 'names.txt')]), ['Game, The.cas', 'Other.cas']));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
