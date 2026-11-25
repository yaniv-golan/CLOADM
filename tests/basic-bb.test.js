// Run: node tests/basic-bb.test.js
//
// The black-box tools for the clean-room BASIC (docs/clean-room-basic.md section 7) and its build:
//  * the lint refuses every way a case could read the ROM (EXEC, USR, DEFUSR, CLOADM, CSAVEM, VARPTR, a PEEK or a POKE
//    address not kept in RAM),
//    and accepts PEEK of a literal in RAM, "... AND 32767", strings and remarks, and lines that start with END:;
//  * compare() finds a differing line, a differing status and a missing case, and passes identical files;
//  * the transcript keeps a line that scrolls off even when every line on the screen is the same, and a write over
//    the top row that is not a scroll is flagged;
//  * the build: tokens.json becomes equates, keyword tables and dispatch tables; a repeated token is refused; the
//    image is 16K with the reset vector pointing at RESET.
const { lintCase } = require('../tools/basic-bb/lint.js');
const { compare } = require('../tools/basic-bb/compare.js');
const { buildBasic, tokensInc } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the lint ----
const refused = (line) => lintCase(line).length > 0;
for (const bad of ['10 X=PEEK(40000)', '10 X=PEEK(A)', '10 X=PEEK(A+1 OR 0 AND 32767)', '10 EXEC 32000', '10 X=USR(0)',
  '10 DEFUSR0=1000', '10 CLOADM', '10 CSAVEM "A",1,2,3', '10 X=PEEK (&HC000)', '10 X=PEEK(32768)', 'PRINT PEEK(49152)', '10 X=PEEK',
  '10 A=VARPTR(B$)', '10 POKE A,192', '10 POKE A+1 OR 0 AND 32767,1', '10 POKE 40000,1', '10 POKE'])
  check(`lint refuses ${bad}`, refused(bad));
for (const good of ['10 X=PEEK(1024)', '10 X=PEEK(&H7FFF)', '10 X=PEEK(A+1 AND 32767)', '10 PRINT "EXEC PEEK(49152)"',
  '10 REM EXEC USR PEEK(40000)', "10 PRINT 1:' EXEC", '2000 END:EXEC', '# EXEC in a directive line', '10 PRINT X',
  '10 POKE 20000,123', '10 POKE P+5 AND 32767,T', '10 POKE (A AND 32767),PEEK(1)'])
  check(`lint accepts ${good}`, !refused(good));

// ---- compare ----
const rec = (c, status, t) => [c, { case: c, status, transcript: t }];
{
  const a = new Map([rec('x', 'ok', ['OK', 'A']), rec('y', 'ok', ['B']), rec('z', 'ok', ['C'])]);
  const b = new Map([rec('x', 'ok', ['OK', 'A']), rec('y', 'ok', ['B', 'extra']), rec('z', 'timeout', ['C'])]);
  const r = compare(a, b);
  check('compare: identical cases counted', r.same === 1, String(r.same));
  check('compare: a differing line is reported', r.report.some((l) => /^y: line 2 differs/.test(l)), r.report.join(' | '));
  check('compare: a differing status is reported', r.report.some((l) => /^z: status ok vs timeout/.test(l)));
  const c = compare(new Map([rec('x', 'ok', ['A'])]), new Map([rec('w', 'ok', ['A'])]));
  check('compare: a case missing from either side is reported', c.report.length === 2 && c.same === 0, c.report.join(' | '));
  check('compare: identical files report nothing', compare(a, a).report.length === 0);
}

// ---- the build ----
const built = buildBasic();
check('build: a 16K image', built.rom.length === 0x4000);
check('build: the reset vector points at RESET', built.rom[0x3FFE] * 256 + built.rom[0x3FFF] === built.symbols.get('RESET'));
check('build: $8000-$80FF is left free for later fixed entry points', built.rom.subarray(0, 0x100).every((x) => x === 0xFF));
{
  const inc = tokensInc({ statements: [{ word: 'FOR', handler: 'FORST' }, { word: 'TAB(', handler: null }, { word: '+', token: '0x90' }],
    functions: [{ word: 'STR$', handler: 'STRS' }] });
  check('tokens: equates, explicit values and names', /T_FOR\s+EQU\s+\$80/.test(inc) && /T_TAB\s+EQU\s+\$81/.test(inc) && /T_PLUS\s+EQU\s+\$90/.test(inc) && /T_STRSF\s+EQU\s+\$80/.test(inc));
  // $80 FORST, $81 TAB( (no handler), $82-$8F (a gap), $90 + (no handler): 16 UNIMPLs, and FORST first
  const st = inc.split('STMTDS')[1].split('FUNCDS')[0];
  check('tokens: a gap in the dispatch table and a missing handler run UNIMPL', (st.match(/FDB\s+UNIMPL/g) || []).length === 16 && /^\s+FDB\s+FORST/.test(st));
  check('tokens: keyword table entries are the word and its token', /FCS\s+"TAB\("\n\s+FCB\s+\$81/.test(inc));
  let threw = false;
  try { tokensInc({ statements: [{ word: 'A' }, { word: 'B', token: 0x80 }], functions: [] }); } catch (e) { threw = /repeated/.test(e.message); }
  check('tokens: a repeated token is refused', threw);
}

// ---- the transcript ----
{
  const b = new Basic(built.rom);
  b.waitOk({ limit: 600 });
  b.record();
  for (let i = 0; i < 20; i++) b.type('10 REM SAME\n');
  b.run(10);
  const t = b.transcript();
  check('transcript: 20 identical lines scrolled through are all kept', t.filter((l) => l === '10 REM SAME').length === 20, String(t.length));
  check('transcript: nothing flagged by scrolling', b.flags.length === 0);
  b.m.write(0x400, 0x41);          // a write over the top row's text that is not a scroll
  check('transcript: a write over text in the top row is flagged', b.flags.length === 1 && b.flags[0].kind === 'top-row-overwritten');
}

// ---- by hand on a real Dragon: the typing sheet, and the written transcript imported ----
{
  const { sheet } = require('../tools/basic-bb/sheet.js');
  const { importText } = require('../tools/basic-bb/import.js');
  const sh = sheet('demo', '# a comment\n10 PRINT 1\nRUN\n#type 5\\n\n#keys SHIFT+0\n#break\n');
  check('sheet: every step in order, directives spelt out', /Type:  10 PRINT 1 .*cursor is back[^]*Type:  RUN .*OK is shown[^]*Type:  5  ENTER[^]*Press SHIFT and 0 together[^]*Press BREAK/.test(sh) && !/comment/.test(sh), sh);
  const imp = importText('=== a\nOK\nPRINT 1  \n 1\nOK\n\n=== b\nOK\n');
  check('import: cases and their lines, trailing spaces and blank lines at the end dropped',
    imp.length === 2 && imp[0].case === 'a' && imp[0].transcript.join('|') === 'OK|PRINT 1| 1|OK' && imp[1].transcript.join('|') === 'OK' && imp[0].status === 'ok');
  const ours = new Map([['a', { case: 'a', status: 'ok', transcript: ['OK', 'PRINT 1', ' 1', 'OK'] }]]);
  check('import: compares with our run line for line', compare(new Map(imp.slice(0, 1).map((c) => [c.case, c])), ours).same === 1);
}

// ---- the run-time guard: code the case wrote must never run ----
{
  const { runCase } = require('./basic/harness.js');
  // passes the lint (literal RAM addresses), but points the IRQ vector's JMP ($0100 in our ROM) at an RTS it POKEd
  const hook = 'POKE 20000,59:POKE 257,78:POKE 258,32\nPRINT "STILL HERE"\n';
  check('guard: the hooking case passes the lint (the guard is what stops it)', lintCase(hook).length === 0);
  const r = runCase(built.rom, hook);
  check('guard: a case that runs code it wrote is refused, nothing recorded', r.status === 'refused' && r.transcript.length === 0 && /\$4E20/.test(r.why), `${r.status} ${r.why}`);
  const plain = runCase(built.rom, 'POKE 20000,59\nPRINT PEEK(20000)\n');
  check('guard: writing RAM without running it is fine', plain.status === 'ok' && plain.transcript.includes(' 59'), plain.status);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
