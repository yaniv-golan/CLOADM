// Run: node tests/basic-corpus.test.js
//
// Corpus mode of the black-box harness (tools/basic-bb/corpus.js):
//  * the corpus lint finds EXEC, USR, DEFUSR, CLOADM, CSAVEM, VARPTR and every PEEK that might read the ROM, by kind
//    and line number, and passes PEEK of RAM, of the I/O page and "... AND 32767", strings and remarks;
//  * listing rows of 32 characters run on into the next row;
//  * the .keys sidecar parses, and a bad line is refused;
//  * the guard, on our own ROM, trips on machine code that reads the ROM and on a ROM routine that reads ROM data and
//    returns to machine code, and not on machine code that reads the I/O page or calls a routine that reads no ROM
//    data, nor on a BASIC program that runs no machine code, nor on code in RAM that ran before it was armed;
//  * compareCorpus reports a differing listing, the first RUN sample that parts, a differing status and error, and
//    missing programs, and passes identical records.
const { corpusLint, joinListing, parseKeys, romGuard } = require('../tools/basic-bb/corpus.js');
const { compareCorpus } = require('../tools/basic-bb/compare.js');
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

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
const long = '10 PRINT "' + 'A'.repeat(22);   // exactly 32 characters
check('a 32-character row runs on', JSON.stringify(joinListing([long, 'B"', '20 END'])) === JSON.stringify([long + 'B"', '20 END']));
check('short rows stay lines', JSON.stringify(joinListing(['10 A=1', '20 B=2'])) === JSON.stringify(['10 A=1', '20 B=2']));

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

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
