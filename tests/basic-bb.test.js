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
//    image is 16K with the reset vector pointing at RESET;
//  * P2 (docs/clean-room-basic-p2.md sections 11 and 12): the graphics lint (pages, points, POKE to a page, the
//    directives); the sound measures on hand-built DAC events (period, tones split by a gap, sound off or a pitch
//    change but not by one odd period, a stepped wave, measures only) and compare's tolerances; #wav, #joy and a
//    graphics mode shown, end to end on our ROM, driven through the PIAs and the SAM with POKE; the typing sheet;
//  * the cassette: tape fixtures (tools/basic-bb/tapes.js: well formed, our own, corrupt), the lint's tape rules
//    (fixtures exist, CLOADM only of a fixture's machine code into memory set aside), #tape, #tape-blank,
//    #tape-rewind and #tape-blocks end to end on our ROM (the summary's blocks and motor runs, no raw bytes),
//    compare's tape summaries and the typing sheet's tape steps.
const { lintCase } = require('../tools/basic-bb/lint.js');
const { compare, cursorOnly } = require('../tools/basic-bb/compare.js');
const { buildBasic, tokensInc } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the lint ----
const refused = (line) => lintCase(line).length > 0;
for (const bad of ['10 X=PEEK(40000)', '10 X=PEEK(A)', '10 X=PEEK(A+1 OR 0 AND 32767)', '10 EXEC 32000', '10 X=USR(0)',
  '10 DEFUSR0=1000', '10 CLOADM', '10 CSAVEM "A",1,2,3', '10 X=PEEK (&HC000)', '10 X=PEEK(32768)', 'PRINT PEEK(49152)', '10 X=PEEK',
  '10 A=VARPTR(B$)', '10 POKE A,192', '10 POKE A+1 OR 0 AND 32767,1', '10 POKE 40000,1', '10 POKE',
  '#type PRINT PEEK(40000)\\n', '10 DATA REM:PRINT PEEK(40000)', '10 END:PRINT PEEK(40000)\nCONT', '10 POKE 4,129', '10 POKE 20000,1',
  'IF 1 THENEXEC 40000', 'PRINTUSR0(1)', 'X=PEEK(AOR 0 AND 32767)', '10 POKE P+5 AND 32767,T', 'CLEAR 200,20000\n10 POKE 19999,1'])
  check(`lint refuses ${bad}`, refused(bad));
for (const good of ['10 X=PEEK(1024)', '10 X=PEEK(&H7FFF)', '10 X=PEEK(A+1 AND 32767)', '10 PRINT "EXEC PEEK(49152)"',
  '10 REM EXEC USR PEEK(40000)', "10 PRINT 1:' EXEC", '2000 END:EXEC', '# EXEC in a directive line', '10 PRINT X',
  '10 POKE 1100,65', 'CLEAR 200,20000\n10 POKE 20000,123\nPOKE 32767,1', '# bb-only\n10 POKE P+5 AND 32767,T',
  '# bb-only\n10 POKE (A AND 32767),PEEK(1)', '2000 END:CONT', '10 DATA 1,2:PRINT 3'])
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
  // the keyword table: the words in token order, a word's place its token, so the gap is 14 $FF bytes
  const kw = inc.split('KWSTMT')[1].split('KWFUNC')[0].trim().split('\n').map((l) => l.trim().replace(/\s+/g, ' '));
  check('tokens: keyword table entries are the words in token order, $FF for a token without one', kw.length === 18 && kw[0] === 'FCS "FOR"' && kw[1] === 'FCS "TAB("'
    && kw.slice(2, 16).every((l) => l === 'FCB $FF') && kw[16] === 'FCS "+"' && kw[17] === 'FCB 0');
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

// ---- a machine that stopped reading the keyboard (stalled), and the screens a clear wiped (clears) ----
{
  const { runCase } = require('./basic/harness.js');
  const { compareClears } = require('../tools/basic-bb/compare.js');
  // SOUND holds the CPU for its whole length without a keyboard scan: the line after it is not taken at all
  const st = runCase(built.rom, '#nowait\nSOUND 1,255\nPRINT 1\n');
  check('a typed line of which no key is taken: status stalled at that line, nothing after it run', st.status === 'stalled' && st.at === 'line 3' && !st.transcript.includes('PRINT 1'), JSON.stringify([st.status, st.at, st.transcript]));
  const ok = runCase(built.rom, 'SOUND 1,20\nPRINT 1\n');
  check('a line typed once the sound is over is taken: ok', ok.status === 'ok' && ok.transcript.includes(' 1'));
  const cl = runCase(built.rom, 'PRINT "A"\nPRINT "B"\nCLS\nPRINT "C"\n');
  check('CLS: the screen it wiped is kept in clears, the transcript as before', cl.status === 'ok' && cl.clears.length === 1 && JSON.stringify(cl.clears[0].screen) === JSON.stringify(['OK', 'PRINT "A"', 'A', 'OK', 'PRINT "B"', 'B', 'OK', 'CLS']) && JSON.stringify(cl.transcript) === JSON.stringify(['OK', 'PRINT "C"', 'C', 'OK']), JSON.stringify(cl.clears));
  const none = runCase(built.rom, 'PRINT "A"\n');
  check('no clear: clears is empty', Array.isArray(none.clears) && none.clears.length === 0);
  check('compareClears: the same screens pass, frames ignored', compareClears([{ frame: 1, screen: ['A', 'B'] }], [{ frame: 9, screen: ['A', 'B'] }]).length === 0);
  check('compareClears: a different screen or count is reported', compareClears([{ frame: 1, screen: ['A', 'B'] }], [{ frame: 1, screen: ['A', 'C'] }]).length === 1 && compareClears([], [{ frame: 1, screen: ['A'] }]).length === 1);
  check('compareClears: a record without the field (made before it) is not compared', compareClears(undefined, [{ frame: 1, screen: ['A'] }]).length === 0);
}

// ---- pictures: #screenshot ----
{
  const { runCase } = require('./basic/harness.js');
  // two screens that read the same as text: a semigraphics block shows only in the picture
  const a = runCase(built.rom, 'PRINT "ABC"\n#screenshot one\n'), a2 = runCase(built.rom, 'PRINT "ABC"\n#screenshot one\n');
  const c = runCase(built.rom, 'PRINT "ABC";CHR$(143)\n#screenshot one\n');
  const s1 = a.shots && a.shots[0], s3 = c.shots && c.shots[0];
  check('#screenshot: a picture with its name, size and pixel hash', !!s1 && s1.name === 'one' && s1.width > 0 && s1.height > 0 && /^[0-9a-f]{64}$/.test(s1.sha256));
  check('#screenshot: the same screen gives the same hash', !!s1 && s1.sha256 === a2.shots[0].sha256);
  check('#screenshot: a block the text reader cannot see changes the hash', !!s3 && s3.sha256 !== s1.sha256 && a.transcript.includes('ABC') && c.transcript.includes('ABC'));
  const png = s1 ? Buffer.from(s1.png, 'base64') : Buffer.alloc(0);
  check('#screenshot: a PNG of that size', png.slice(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === s1.width && png.readUInt32BE(20) === s1.height);
  const rec = (r) => new Map([['g', { case: 'g', status: r.status, transcript: r.transcript, shots: r.shots }]]);
  const cmp = compare(rec(a), rec(c));
  check('compare: a differing picture is reported', cmp.same === 0 && cmp.report.some((l) => /pictures differ: one/.test(l)), cmp.report.join(' | '));
  check('compare: identical pictures pass', compare(rec(a), rec(a2)).same === 1);

  // the cursor (cursorOnly): two text pictures whose only difference is one 8 x 12 cell, a solid block in each, differ
  // only in the cursor's colour; two cells, a cell that is not one colour, or a difference across a cell's edge do not
  const pic = (t) => runCase(built.rom, `${t}\n#screenshot one\n`);
  const blue = pic('CLS:POKE 1100,175'), black = pic('CLS:POKE 1100,128');
  const two = pic('CLS:POKE 1100,175:POKE 1101,175'), two0 = pic('CLS:POKE 1100,128:POKE 1101,128');
  const half = pic('CLS:POKE 1100,172');
  const cur = compare(rec(blue), rec(black));
  check('compare: one solid cell of difference is the cursor only, and passes', cur.same === 1 && cur.report.length === 0 && cur.cursor.length === 1 && /^g: cursor only: one \(cell 12,2\)$/.test(cur.cursor[0]), JSON.stringify(cur));
  const cur2 = compare(rec(two), rec(two0));
  check('compare: two cells of difference still differ', cur2.same === 0 && cur2.report.some((l) => /pictures differ: one/.test(l)) && cur2.cursor.length === 0, JSON.stringify(cur2.report));
  const cur3 = compare(rec(half), rec(black));
  check('compare: one cell that is not a solid block still differs', cur3.same === 0 && cur3.report.some((l) => /pictures differ: one/.test(l)), JSON.stringify(cur3.report));
  // a block of difference the size of a cell but 4 pixels off the grid, drawn into a copy of the picture
  const zlib = require('zlib'), mkPng = (w, h, px) => {
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (t, d) => { const l = Buffer.alloc(4), body = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
    const raw = Buffer.alloc((w * 4 + 1) * h), hd = Buffer.alloc(13);
    for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    hd.writeUInt32BE(w, 0); hd.writeUInt32BE(h, 4); hd[8] = 8; hd[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', hd), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  };
  const s0 = black.shots[0], b0 = Buffer.from(s0.png, 'base64'), raw0 = zlib.inflateSync(b0.subarray(41, b0.length - 16));  // (one IDAT chunk)
  const px = Buffer.alloc(s0.width * s0.height * 4);
  for (let y = 0; y < s0.height; y++) raw0.copy(px, y * s0.width * 4, y * (s0.width * 4 + 1) + 1, (y + 1) * (s0.width * 4 + 1));
  const shifted = Buffer.from(px), aligned = Buffer.from(px), x0 = (s0.width - 256) / 2, y0 = (s0.height - 192) / 2;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) {
    shifted.writeUInt32BE(0xFF0000FF, ((y0 + 36 + y) * s0.width + x0 + 44 + x) * 4);
    aligned.writeUInt32BE(0xFF0000FF, ((y0 + 36 + y) * s0.width + x0 + 40 + x) * 4);
  }
  const fake = (b) => ({ name: 'one', sha256: require('crypto').createHash('sha256').update(b).digest('hex'), png: mkPng(s0.width, s0.height, b) });
  check('compare: a cell-sized difference off the grid is not the cursor', cursorOnly(fake(px), fake(shifted)) === null && cursorOnly(fake(px), fake(aligned)) === '5,3');
  // the same one-cell difference in a picture whose border is not black (a graphics mode) is not the cursor
  const border = (b) => { const c = Buffer.from(b); for (let x = 0; x < s0.width; x++) c.writeUInt32BE(0x30D200FF, x * 4); return c; };
  check('compare: a one-cell difference in a picture that is not of the text screen is not the cursor', cursorOnly(fake(border(px)), fake(border(aligned))) === null);
}

// ---- the run-time guard: code the case wrote must never run ----
{
  const { runCase } = require('./basic/harness.js');
  // points the IRQ vector's JMP ($0100 in our ROM) at an RTI it POKEd: the guard stops it whatever the lint says.
  // The RTI goes at $4E00 + the vector's low byte, so one POKE (the high byte) switches the vector: no field
  // interrupt can fall between two halves of it
  const hook = 'POKE 19968+PEEK(258),59:POKE 257,78\nPRINT "STILL HERE"\n';
  check('guard: the lint refuses the hooking case too (POKE into BASIC\'s own memory)', lintCase(hook).length > 0);
  const r = runCase(built.rom, hook);
  check('guard: a case that runs code it wrote is refused, nothing recorded', r.status === 'refused' && r.transcript.length === 0 && /\$4E[0-9A-F]{2}\b/.test(r.why), `${r.status} ${r.why}`);
  const plain = runCase(built.rom, 'POKE 20000,59\nPRINT PEEK(20000)\n');
  check('guard: writing RAM without running it is fine', plain.status === 'ok' && plain.transcript.includes(' 59'), plain.status);
}

// ---- P2 (docs/clean-room-basic-p2.md sections 11 and 12) ----

// the lint for graphics: pages within what the case reserves, points kept small, POKE to a page only with no PCLEAR
for (const bad of ['PCLEAR A', 'PCLEAR 10', 'PMODE 4,2', 'PMODE 3,3', 'PMODE 0,9', 'PMODE 0,P', 'PCLEAR 2\nPMODE 3,1',
  'PCLEAR 8\nPCLEAR 1\nPMODE 1,1', 'PMODE M,2', 'PMODE 0,4\nPMODE 4', 'PCOPY 1 TO 5', 'PCOPY A TO 2', 'PCLEAR 2\nPCOPY 1 TO 3',
  'PCLEAR 4\n10 POKE 1536,255', '10 POKE 7680,1', '10 PSET(X,Y)', '10 PSET(600,0)', '10 PSET(0,256)', '10 PSET(-1,0)',
  '10 PRESET(X AND 511,1)', '10 LINE(0,0)-(X,Y),PSET', '10 LINE -(0,A),PSET', '10 PRINT PPOINT(X,Y)', '10 A=POINT(I,0)',
  '10 CIRCLE(128,96),R', '10 CIRCLE(128,96),300', '10 PAINT(X,1),2,3', '10 GET(0,0)-(X,7),A,G', '10 PUT(0,Y)-(7,7),A,PSET',
  '10 SET(A,1,3)', '10 RESET(1,B)', '10 PSET(A(1),2)', '10 PSET(X AND 255 OR 4096,1)', '10 IF 1 THEN PSET(1,2) ELSE PSET(Y,2)',
  '#bogus', '#joy 4 1', '#joy 0 64', '#joy 0', '#frames x', '#wait-text (', '#wav-start a'])
  check(`lint refuses ${bad.replace(/\n/g, ' / ')}`, refused(bad));
for (const good of ['PCLEAR 1', 'PCLEAR 0', 'PCLEAR 9', 'PMODE 4,1', 'PMODE 0,4', 'PMODE 1,3', 'PCLEAR 8\nPMODE 4,5', 'PMODE M,1',
  'PMODE 0,4\nPMODE 0', 'PCOPY 1 TO 4', 'PCLEAR 8\nPCOPY 1 TO 8', '10 POKE 1536,255', '10 POKE 7679,1', '10 PSET(255,191)',
  '10 PSET(X AND 255,Y AND 127,3)', '10 PRESET((X+1) AND 255,0)', '10 LINE(0,0)-(255,191),PSET,BF', '10 LINE-(10,20),PRESET',
  '10 PRINT PPOINT(I AND 255,J AND 127)+A(I)', '10 A=POINT(63,31)', '10 CIRCLE(128,96),R AND 127,2,.5,.25,.75',
  '10 CIRCLE(128,96),255', '10 PAINT(128,96),2,3', '10 GET(0,0)-(15,7),A,G', '10 PUT(8,8)-(23,15),A,NOT', '10 SET(63,31,3)',
  '10 INPUT A(I)', '10 LINE INPUT A$', '10 PSET(300,200)', '10 DRAW "BM128,96R10"', '10 PRINT "PSET(X,Y)"', '10 COLOR C,0:SCREEN 1,S',
  '#wav a\nSOUND 1,1\n#wav-stop', '#joy 3 63', '#screenshot x', '#wait-text Q1$|ERROR IN 1\\d\\d', '#frames 10\n#timeout 60'])
  check(`lint accepts ${good.replace(/\n/g, ' / ')}`, !refused(good));

// sound measures, on hand-built DAC events: a square wave of a given period, written every half period
{
  const { soundMeasures } = require('./basic/harness.js');
  const square = (t0, period, n, lo = 0, hi = 63) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * period / 2, v: i & 1 ? hi : lo, on: true, dac: true }));
  const one = soundMeasures(square(100, 1000, 40), { cycles: 50000 });
  const t1 = one.tones[0] || {};
  check('sound: one square tone: its period, periods, length, levels', one.tones.length === 1 && t1.period === 1000 && t1.periods === 19 && t1.length === 19500 && t1.start === 100 && t1.levels === 2 && t1.low === 0 && t1.high === 63 && t1.writes === 40, JSON.stringify(one.tones));
  check('sound: the window\'s writes, heard writes and length', one.writes === 40 && one.heard === 40 && one.cycles === 50000);
  // an interrupt stretches one period by 300 cycles: still one tone, and the median ignores it
  const ev = square(0, 1000, 40).map((e, i) => (i >= 21 ? { ...e, t: e.t + 300 } : e));
  const st = soundMeasures(ev);
  check('sound: one stretched period neither splits the tone nor moves its period', st.tones.length === 1 && st.tones[0].period === 1000, JSON.stringify(st.tones.map((t) => t.period)));
  // two pitches back to back, no gap: split where the pitch changes
  const a = square(0, 1000, 20), b = square(20 * 500, 800, 20);
  const two = soundMeasures([...a, ...b]);
  check('sound: a pitch change with no gap makes two tones', two.tones.length === 2 && two.tones[0].period === 1000 && two.tones[1].period === 800, JSON.stringify(two.tones.map((t) => [t.period, t.periods])));
  // the same pitch twice: a gap over 20,000 cycles splits it, a shorter one does not
  const gap = (g) => soundMeasures([...square(0, 1000, 20), ...square(19 * 500 + g, 1000, 20)]).tones.length;
  check('sound: a gap of more than 20,000 cycles ends a tone', gap(25000) === 2 && gap(15000) === 1, `${gap(25000)} ${gap(15000)}`);
  // sound turned off between two notes: two tones; writes while off are counted but are no tone
  const offOn = [...square(0, 1000, 10), { t: 5000, v: 0, on: false, dac: false }, ...square(6000, 1000, 6).map((e) => ({ ...e, on: false })), { t: 9500, v: 0, on: true, dac: false }, ...square(10000, 1000, 10)];
  const oo = soundMeasures(offOn);
  check('sound: sound off between two notes splits them, and silent writes make no tone', oo.tones.length === 2 && oo.writes === 26 && oo.heard === 20, JSON.stringify({ t: oo.tones.length, w: oo.writes, h: oo.heard }));
  // a stepped wave (four levels a half period): the period is still the rising crossings' spacing
  const stair = [0, 21, 42, 63, 42, 21];
  const sw = soundMeasures(Array.from({ length: 60 }, (_, i) => ({ t: i * 200, v: stair[i % 6], on: true, dac: true })));
  check('sound: a stepped wave: its period, and four distinct levels', sw.tones.length === 1 && sw.tones[0].period === 1200 && sw.tones[0].levels === 4 && sw.tones[0].low === 0 && sw.tones[0].high === 63, JSON.stringify(sw.tones));
  // measures only: no list of levels or times ever leaves (decision 5)
  const keys = (o) => Object.keys(o).sort().join(',');
  check('sound: the window holds measures only', keys(soundMeasures(square(0, 1000, 8), { end: { enabled: true, mux: 0 } })) === 'cycles,end,heard,sha256,tones,writes');
  check('sound: a tone holds measures only', keys(t1) === 'high,length,levels,low,period,periods,start,writes');
  const ev2 = square(0, 1000, 40); ev2[10] = { ...ev2[10], v: 62 };
  check('sound: the hash tells apart two runs the measures do not', soundMeasures(ev2).sha256 !== one.sha256 && soundMeasures(square(100, 1000, 40)).sha256 === one.sha256);

  // compare: tolerances
  const { compareSounds } = require('../tools/basic-bb/compare.js');
  const win = (tones, end = { enabled: true, mux: 0 }) => [{ name: 'w', end, tones }];
  const tone = (o) => ({ start: 0, length: 20000, period: 1000, periods: 19, writes: 40, levels: 2, low: 0, high: 63, ...o });
  check('compare sounds: identical measures pass', compareSounds(win([tone()]), win([tone()])).length === 0);
  check('compare sounds: period within 0.5%, length within a field, levels count and writes ignored', compareSounds(win([tone()]), win([tone({ period: 1004, length: 37000, levels: 7, writes: 90, start: 900000 })])).length === 0);
  check('compare sounds: a period 0.6% off is reported', compareSounds(win([tone()]), win([tone({ period: 1006 })])).some((l) => /period/.test(l)));
  check('compare sounds: a length more than a field off is reported', compareSounds(win([tone()]), win([tone({ length: 40000 })])).some((l) => /length/.test(l)));
  check('compare sounds: a different swing is reported', compareSounds(win([tone()]), win([tone({ low: 1, high: 62 })])).some((l) => /levels/.test(l)));
  check('compare sounds: a different number of tones is reported', compareSounds(win([tone()]), win([tone(), tone({ start: 50000 })])).some((l) => /tones/.test(l)));
  check('compare sounds: a longer silence between tones is reported', compareSounds(win([tone(), tone({ start: 30000 })]), win([tone(), tone({ start: 60000 })])).some((l) => /silence/.test(l)));
  check('compare sounds: the state at the end is compared', compareSounds(win([tone()]), win([tone()], { enabled: true, mux: 1 })).some((l) => /end/.test(l)));
  const r1 = { case: 'q', status: 'ok', transcript: ['OK'], sounds: win([tone()]) }, r2 = { ...r1, sounds: win([tone({ period: 1100 })]) };
  check('compare: a case whose sound differs is not identical', compare(new Map([['q', r1]]), new Map([['q', r2]])).same === 0 && compare(new Map([['q', r1]]), new Map([['q', r1]])).same === 1);
}

// #wav, #joy and graphics on our ROM, driven through the PIAs and the SAM with POKE (these cases are not linted:
// they are the harness's own tests, never run on the real ROM)
{
  const { runCase } = require('./basic/harness.js');
  // sound on (PIA1 CB2 high), then 20 cycles of a square wave from a BASIC loop, a pause of about a second, 20 more
  const prog = '10 POKE 65315,PEEK(65315) OR 8\n20 FOR I=1 TO 20:POKE 65312,0:POKE 65312,252:NEXT\n30 FOR I=1 TO 300:NEXT\n40 FOR I=1 TO 20:POKE 65312,0:POKE 65312,252:NEXT\n';
  const r = runCase(built.rom, `${prog}#wav loop\nRUN\n#wav-stop\n`);
  const s = r.sounds && r.sounds[0], tn = s ? s.tones : [];
  check('#wav: a run with its sound measured', r.status === 'ok' && !!s && s.name === 'loop', r.status);
  check('#wav: the two loops are two tones, the pause between them', tn.length === 2 && tn.every((t) => t.periods === 19 && t.low === 0 && t.high === 63) && tn[1].levels === 2 && tn[1].start - tn[0].start - tn[0].length > 20000, JSON.stringify(tn));
  check('#wav: the same loop gives the same period', tn.length === 2 && Math.abs(tn[0].period - tn[1].period) < 0.01 * tn[0].period && tn[0].period > 1000, JSON.stringify(tn.map((t) => t.period)));
  check('#wav: 80 DAC writes, all heard; sound left on with the DAC selected', !!s && s.writes === 80 && s.heard === 80 && s.end.enabled === true && s.end.mux === 0, JSON.stringify(s && { w: s.writes, h: s.heard, e: s.end }));
  const again = runCase(built.rom, `${prog}#wav loop\nRUN\n#wav-stop\n`);
  check('#wav: the same run gives the same hash', !!s && again.sounds[0].sha256 === s.sha256);
  const quiet = runCase(built.rom, `${prog.replace('OR 8', 'AND 247')}#wav off\nRUN\n#wav-stop\n`);
  check('#wav: with sound off, writes but no tones', quiet.sounds && quiet.sounds[0].writes === 80 && quiet.sounds[0].heard === 0 && quiet.sounds[0].tones.length === 0, JSON.stringify(quiet.sounds));
  check('#wav: left recording at the end of a case, it is stopped there', (runCase(built.rom, '#wav open\nPRINT 1\n').sounds || []).map((x) => x.name).join() === 'open');
  for (const bad of ['#wav a\n#wav b\n', '#wav-stop\n', '#joy 4 10\n', '#joy 0 64\n', '#joy 1\n'])
    check(`directive refused: ${bad.trim().replace(/\n/g, ' / ')}`, runCase(built.rom, bad).status === 'bad-directive');
  // #joy: the comparator (PIA0 PA7) against the DAC for the right joystick's x (the multiplexer's reset setting)
  const joy = runCase(built.rom, '#joy 0 40\nPOKE 65312,156:PRINT PEEK(65280) AND 128\nPOKE 65312,164:PRINT PEEK(65280) AND 128\n#joy 0 41\nPOKE 65312,164:PRINT PEEK(65280) AND 128\n');
  const answers = joy.transcript.filter((l) => /^ \d+$/.test(l)).join();
  check('#joy: sets the axis the comparator reads (40 >= 39, 40 < 41, 41 >= 41)', joy.status === 'ok' && answers === ' 128, 0, 128', answers);
  // the right joystick's y (the multiplexer's CA2 high: PIA0 CRA bit 3) and the left one's x (CB2 high: CRB bit 3)
  const sel = (reg, dac) => `POKE ${reg},PEEK(${reg}) OR 8:POKE 65312,${dac * 4}:A=PEEK(65280) AND 128:POKE ${reg},PEEK(${reg}) AND 247:PRINT A\n`;
  const axes = runCase(built.rom, `#joy 1 50\n#joy 2 10\n${sel(65281, 49)}${sel(65281, 51)}${sel(65283, 9)}${sel(65283, 11)}`);
  const got = axes.transcript.filter((l) => /^ \d+$/.test(l)).join();
  check('#joy: axis 1 is the right joystick\'s y, axis 2 the left one\'s x (50 >= 49, 50 < 51, 10 >= 9, 10 < 11)', axes.status === 'ok' && got === ' 128, 0, 128, 0', got);
  // a graphics mode shown with the SAM's offset moved off the text screen: the text behind it is still read
  const g = runCase(built.rom, 'POKE 65314,PEEK(65314) OR 128:POKE 65479,0:PRINT "HI"\nPRINT "AGAIN"\n#screenshot g\n');
  check('graphics shown: the OK prompt and the text behind the picture are read', g.status === 'ok' && g.transcript.includes('HI') && g.transcript.includes('AGAIN'), `${g.status} ${g.at || ''}`);
  const t = runCase(built.rom, 'PRINT "HI"\nPRINT "AGAIN"\n#screenshot g\n');
  check('graphics shown: the picture is not the text screen\'s', t.shots && g.shots && t.shots[0].sha256 !== g.shots[0].sha256);
}

// the typing sheet spells out the P2 directives
{
  const { sheet } = require('../tools/basic-bb/sheet.js');
  const sh = sheet('p2', '#joy 3 10\n#wav tune\nSOUND 100,5\n#wav-stop\n#screenshot pic\n');
  check('sheet: #joy, #wav, #wav-stop and #screenshot as steps', /left joystick's up-down position so that JOYSTK\(3\) reads 10[^]*Start recording the speaker \(sound "tune"\)[^]*Type:  SOUND 100,5[^]*Stop recording[^]*Photograph the screen \(picture "pic"\)/.test(sh), sh);
}

// ---- a line judged by what follows it, not by the typist ----
// the real ROM stops reading the keyboard while PLAY sounds, so the typist reports "not-consumed" for a line that ran:
// the case goes on, with the note in its result; keys that were really not taken still fail the wait after them
{
  const { runCase } = require('./basic/harness.js');
  const real = Basic.prototype.type;
  const text = 'PRINT "A"\nPRINT "B"\n';
  const plain = runCase(built.rom, text);
  let r;
  try {
    Basic.prototype.type = function (t, limit) { real.call(this, t, limit); return /B/.test(t) ? 'not-consumed' : 'done'; };
    r = runCase(built.rom, text);
  } finally { Basic.prototype.type = real; }
  check('typist not-consumed: the case goes on', r.status === 'ok' && JSON.stringify(r.transcript) === JSON.stringify(plain.transcript), JSON.stringify(r));
  check('typist not-consumed: noted with its line', JSON.stringify(r.typist) === JSON.stringify([{ at: 'line 2', status: 'not-consumed' }]), JSON.stringify(r.typist));
  try {
    Basic.prototype.type = function (t, limit) { if (!/B/.test(t)) return real.call(this, t, limit); this.m.typist.typePaced(t.slice(0, 3)); return 'not-consumed'; };
    r = runCase(built.rom, '#timeout 3\n' + text);
  } finally { Basic.prototype.type = real; }
  check('keys really not taken: the wait after them fails', r.status === 'timeout' && r.at === 'line 3', JSON.stringify({ status: r.status, at: r.at }));
}

// ---- the boot screen is never recorded ----
// a ROM's banner is ROM text; our own banner ("CLOADM BASIC") stands in for it. A case that starts with CLS, one
// that never clears and scrolls, and a start whose CLS is lost (a ROM that drops the first key) must record no row
// of it, in text or in a picture
{
  const { runCase } = require('./basic/harness.js');
  const BANNER = 'CLOADM BASIC';
  const hasBanner = (r) => JSON.stringify(r).includes(BANNER);
  const r1 = runCase(built.rom, 'CLS\nPRINT "ONE"\n#screenshot a\n');
  check('boot banner: a case starting with CLS records none of it', r1.status === 'ok' && !hasBanner(r1.transcript) && r1.transcript.includes('ONE'), JSON.stringify(r1.transcript));
  const many = Array.from({ length: 20 }, (_, i) => `PRINT ${i}`).join('\n');
  const r2 = runCase(built.rom, 'PRINT "TWO"\n#screenshot b\n' + many + '\n');
  check('boot banner: a case that never clears and scrolls records none of it', r2.status === 'ok' && !hasBanner(r2.transcript) && r2.transcript.includes('TWO'), JSON.stringify(r2.transcript.slice(0, 4)));
  // the pictures: the screen's memory when each was taken held no banner (the picture is drawn from it)
  const shotHasBanner = (text) => {
    let seen = false;
    const real = Basic.prototype.shot;
    Basic.prototype.shot = function (name) { if (this.rows().join('\n').includes(BANNER)) seen = true; return real.call(this, name); };
    try { runCase(built.rom, text); } finally { Basic.prototype.shot = real; }
    return seen;
  };
  check('boot banner: no picture is taken with it on the screen', !shotHasBanner('#screenshot first\nPRINT "X"\n#screenshot second\n'));
  // a ROM that drops the first key of the harness's CLS: "LS" is a syntax error, the screen is not cleared
  const realType = Basic.prototype.cleanStart;
  let screenAfter = null;
  Basic.prototype.cleanStart = function (limit) {
    const tp = this.m.typist.typePaced.bind(this.m.typist);
    this.m.typist.typePaced = (t) => { this.m.typist.typePaced = tp; return tp(t.replace(/^C/, '')); };
    const ok = realType.call(this, limit);
    screenAfter = this.screen();
    return ok;
  };
  let r3;
  try { r3 = runCase(built.rom, 'PRINT "THREE"\n'); } finally { Basic.prototype.cleanStart = realType; }
  check('boot banner: a lost CLS stops the case with nothing recorded', r3.status === 'no-clean-start' && r3.transcript.length === 0, JSON.stringify(r3));
  check('boot banner: and the screen held none of it even then (blanked from outside first)', screenAfter && !screenAfter.join('\n').includes(BANNER), JSON.stringify(screenAfter));
}

// ---- local-only cases: never written to a results file ----
// a case whose output may hold ROM text (CLS past 8 prints the original's hidden message) runs only with --local,
// and only its shape is printed: the lines typed, OK, blank lines and error codes; any other line as <text N>
{
  const { localShape } = require('../tools/basic-bb/run.js');
  const caseText = '# local-only\nCLS 9\nPRINT "DONE"\n';
  const shape = localShape(['OK', 'CLS 9', '(C) SOME ROM TEXT', '', 'OK', 'PRINT "DONE"', 'DONE', '?FC ERROR IN 20', 'OK'], caseText);
  check('localShape: ROM text hidden, the rest kept', JSON.stringify(shape) === JSON.stringify(['OK', 'CLS 9', '<text 17>', '', 'OK', 'PRINT "DONE"', '<text 4>', '?FC ERROR IN 20', 'OK']), JSON.stringify(shape));
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-local-'));
  fs.writeFileSync(path.join(dir, 'loc.bas'), '# bb-only\n# local-only\nPRINT "SECRET"\n');
  fs.writeFileSync(path.join(dir, 'pub.bas'), 'PRINT "PUBLIC"\n');
  const run = (extra) => execFileSync(process.execPath, [path.join(__dirname, '../tools/basic-bb/run.js'), '--ours', '--cases', dir, '--out', path.join(dir, 'o.jsonl'), ...extra], { encoding: 'utf8' });
  run([]);
  const written = fs.readFileSync(path.join(dir, 'o.jsonl'), 'utf8');
  check('local-only: skipped without --local, the others written', !written.includes('SECRET') && written.includes('PUBLIC') && written.split('\n').filter(Boolean).length === 1);
  const printed = run(['--local', '--only', 'loc']);
  const written2 = fs.readFileSync(path.join(dir, 'o.jsonl'), 'utf8');
  check('local-only with --local: nothing written, only its shape printed', written2 === '' && printed.includes('<text 6>') && !/^\s*SECRET$/m.test(printed), printed);
  // a case that stops on a wait is written with status timeout and the step, named in the summary, and the exit is 1
  fs.writeFileSync(path.join(dir, 'hang.bas'), '#timeout 2\n10 GOTO 10\nRUN\n');
  let rc = 0, said = '';
  try { said = run(['--only', 'hang,pub']); } catch (e) { rc = e.status; said = e.stdout; }
  const recs = fs.readFileSync(path.join(dir, 'o.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hang = recs.find((r) => r.case === 'hang');
  check('a hung case: status timeout with its step, named in the summary, exit 1', rc === 1 && hang && hang.status === 'timeout' && hang.at === 'line 3' && /1 of 2 ok; not results: hang \(timeout at line 3\)/.test(said), said);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- the cassette: tape fixtures, #tape, #tape-blank, #tape-rewind, #tape-blocks, the lint's tape rules ----
{
  const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
  const { readFixture, fixtureCas } = require('../tools/basic-bb/tapes.js');
  const { runCase, Emu } = require('./basic/harness.js');
  const { compareTapes } = require('../tools/basic-bb/compare.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-tapes-'));
  const put = (name, o) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(o));
  const P = 'written for this test';
  put('ok', { provenance: P, files: [{ name: 'A', type: 'basic', ascii: true, lines: ['10 PRINT 1'] }, { name: 'D', type: 'data', data: [72, 73, 13] }] });
  put('noprov', { files: [{ name: 'A', type: 'basic', ascii: true, lines: ['10 PRINT 1'] }] });
  put('tokens', { provenance: P, files: [{ name: 'A', type: 'basic', data: [0x1E, 0x07, 0, 10, 0x87, 0, 0, 0] }] });
  put('longname', { provenance: P, files: [{ name: 'TOOLONGNAME', type: 'data', lines: ['X'] }] });
  put('noload', { provenance: P, files: [{ name: 'M', type: 'binary', data: [1] }] });
  put('both', { provenance: P, files: [{ name: 'X', type: 'data', lines: ['A'], data: 'B' }] });
  put('mclow', { provenance: P, files: [{ name: 'M', type: 'binary', load: 0x6000, exec: 0x6000, data: [1, 2] }] });
  put('mchigh', { provenance: P, files: [{ name: 'M', type: 'binary', load: 0x7FFF, exec: 0x7FFF, data: [1, 2] }] });
  put('mcok', { provenance: P, files: [{ name: 'M', type: 'binary', load: 0x7000, exec: 0x7000, data: [1, 2] }] });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const throws = (name) => { try { readFixture(name, dir); return false; } catch { return true; } };
  check('tape fixture: a good one reads, lines ended by CR', !throws('ok') && readFixture('ok', dir).files[0].data.join() === [...'10 PRINT 1\r'].map((c) => c.charCodeAt(0)).join());
  for (const bad of ['noprov', 'tokens', 'longname', 'noload', 'both', 'broken', 'missing', 'Bad_Name', '../ok'])
    check(`tape fixture refused: ${bad}`, throws(bad));
  // the fixtures in the repository: all read, and build tapes whose blocks decode
  for (const f of fs.readdirSync(path.join(__dirname, 'basic/tapes'))) {
    const name = f.replace(/\.json$/, ''), fx = readFixture(name), blocks = [...Emu.casBlocks(fixtureCas(fx, Emu))];
    check(`tests/basic/tapes/${f}: reads, builds, and ${fx.corrupt.length ? 'has exactly its corrupted block bad' : 'every block is good'}`, blocks.length >= 3 && blocks.filter((k) => !k.ok).length === fx.corrupt.length);
  }
  // corrupt: the byte flipped, the checksum left (so that block fails), the rest untouched
  {
    const good = fixtureCas({ files: [{ name: 'A', type: 'data', data: [1, 2, 3] }], corrupt: [] }, Emu);
    const bad = fixtureCas({ files: [{ name: 'A', type: 'data', data: [1, 2, 3] }], corrupt: [{ block: 1, byte: 2, xor: 4 }] }, Emu);
    const diff = [...good].map((v, i) => (v !== bad[i] ? i : -1)).filter((i) => i >= 0), k = [...Emu.casBlocks(bad)];
    check('tape fixture corrupt: one byte flipped, that block\'s checksum then wrong', diff.length === 1 && bad[diff[0]] === 7 && !k[1].ok && k[0].ok && k[2].ok, JSON.stringify(diff));
  }
  // the CLI writes the fixture as .cas and as a WAV that decodes back to the same blocks
  {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, '../tools/basic-bb/tapes.js'), 'three-progs', '--cas', path.join(dir, 't.cas'), '--wav', path.join(dir, 't.wav')]);
    const cas = fs.readFileSync(path.join(dir, 't.cas')), back = Emu.wavToCas(fs.readFileSync(path.join(dir, 't.wav'))).bytes;
    const sig = (b) => [...Emu.casBlocks(b)].map((k) => `${k.type}:${Buffer.from(k.data).toString('hex')}:${k.ok}`).join();
    check('tapes.js NAME --cas --wav: the fixture\'s tape, and a recording of it that decodes to the same blocks', sig(cas) === sig(fixtureCas(readFixture('three-progs'), Emu)) && sig(back) === sig(cas));
  }

  // the lint: fixtures must exist and be well formed; #tape-rewind and #tape-blocks need a tape; CLOADM only of a
  // fixture's machine code, into memory set aside, with no offset; CSAVEM in any spelling refused
  const lt = (t) => lintCase(t, { tapes: dir });
  for (const bad of ['#tape missing', '#tape noprov', '#tape tokens', '#tape-rewind', '#tape-blocks x', '#tape-rewind\n#tape ok',
    '10 CLOADM', 'CLEAR 200,28672\nCLOADM', 'CLEAR 200,28672\n#tape-blank\n#tape mcok\nCLOADM', 'CLEAR 200,28672\n#tape ok\nCLOADM',
    'CLEAR 200,28672\n#tape mclow\nCLOADM', 'CLEAR 200,28672\n#tape mchigh\nCLOADM', '#tape mcok\nCLOADM', 'CLEAR 200,28672\n#tape mcok\nCLOADM "M",512',
    'CLEAR 200,28672\n#tape mcok\n#tape ok\nCLOADM', 'CLEAR 200,28672\n#tape-blank\nCLOAD M', 'CLEAR 200,28672\n#tape mcok\n10 X=1:CLOADM:EXEC',
    '10 CSAVEM "A",1,2,3', '10 CSAVE M', 'CLOAD M$'])
    check(`lint refuses ${bad.replace(/\n/g, ' / ')}`, lt(bad).length > 0);
  for (const good of ['#tape ok', '#tape-blank\nCSAVE "X"\n#tape-blocks a\n#tape-rewind\nCLOAD', '#tape ok\n#tape-rewind\n#tape-blocks b',
    'CLEAR 200,28672\n#tape mcok\nCLOADM\nCLOADM "M"', 'CLEAR 200,28672\n#tape mcok\n10 CLOADM:PRINT 1', 'CLEAR 200,28672\n#tape mcok\nCLOAD M', 'CSAVE "M"', 'CLOAD "M"', '10 PRINT "CLOADM"'])
    check(`lint accepts ${good.replace(/\n/g, ' / ')}`, lt(good).length === 0, lt(good).join('; '));
  check('lint: the default fixtures folder is tests/basic/tapes', lintCase('#tape three-progs').length === 0 && lintCase('#tape ok').length > 0);

  // on our ROM: CSAVE onto a blank tape, the summary, rewind, CLOAD back
  const prog = '10 PRINT "TAPE"\n20 A=1\n';
  const r = runCase(built.rom, `#tape-blank\n${prog}CSAVE "PROG"\n#tape-blocks saved\n#tape-rewind\nNEW\nCLOAD\nLIST\n#tape-blocks loaded\n`);
  const [saved, loaded] = r.tapes || [];
  const bl = saved ? saved.blocks : [];
  check('#tape-blank / #tape-blocks: the blocks CSAVE wrote: namefile, data, end of file, none bad', r.status === 'ok' && bl.map((k) => k.type).join() === '0,1,255' && bl.every((k) => k.ok) && saved.bad === 0, JSON.stringify(r.tapes));
  check('#tape-blocks: the namefile\'s fields', !!bl[0] && bl[0].name === 'PROG    ' && bl[0].fileType === 0 && bl[0].ascii === 0 && bl[0].gaps === 0 && bl[0].exec === 0 && bl[0].load === 0 && bl[0].length === 15);
  check('#tape-blocks: leaders of at least 128 $55 bytes', bl.length === 3 && bl.every((k) => k.leader >= 128), JSON.stringify(bl.map((k) => k.leader)));
  // the data block's hash is that of the program in RAM, typed the same way into a fresh machine
  {
    const b = new Basic(built.rom);
    b.waitOk({ limit: 600 });
    b.type(prog); b.run(20);
    const ram = b.m.ram, start = 0x1E01;
    let x = start; while (ram[x] | ram[x + 1]) x = (ram[x] << 8) | ram[x + 1];
    const want = crypto.createHash('sha256').update(ram.slice(start, x + 2)).digest('hex');
    check('#tape-blocks: a data block is its length and the SHA-256 of its bytes, never the bytes', !!bl[1] && bl[1].sha256 === want && bl[1].length === x + 2 - start && Object.keys(bl[1]).sort().join() === 'leader,length,ok,sha256,type', JSON.stringify(bl[1]));
  }
  check('#tape-blocks: nothing but the summary\'s fields', (r.tapes || []).length === 2 && r.tapes.every((t) => Object.keys(t).every((k) => ['name', 'motor', 'blocks', 'bad'].includes(k))));
  check('#tape-blocks: the motor ran once for CSAVE, for a few seconds', !!saved && saved.motor.length === 1 && saved.motor[0].start === 0 && saved.motor[0].length > 50 && !saved.motor[0].carried, JSON.stringify(saved && saved.motor));
  check('#tape-rewind: the recording becomes the tape; CLOAD loads the program back', r.transcript.join('|').includes('LIST|10 PRINT "TAPE"|20 A=1|OK'), JSON.stringify(r.transcript));
  check('#tape-blocks after a rewind: the motor only, no blocks (nothing recorded)', !!loaded && loaded.blocks === undefined && loaded.motor.length >= 1, JSON.stringify(loaded));
  // a later summary holds only the blocks written since the one before
  const r2 = runCase(built.rom, '#tape-blank\n10 REM A\nCSAVE "ONE"\n#tape-blocks one\nCSAVE "TWO"\n#tape-blocks two\n#tape-blocks none\n');
  const names = (t) => t.blocks.filter((k) => k.type === 0).map((k) => k.name.trim()).join();
  check('#tape-blocks: each summary the blocks since the last', !!r2.tapes && names(r2.tapes[0]) === 'ONE' && names(r2.tapes[1]) === 'TWO' && r2.tapes[2].blocks.length === 0 && r2.tapes[2].motor.length === 0, JSON.stringify(r2.tapes && r2.tapes.map(names)));
  // a fixture played; #tape-rewind of a fixture plays it again from the start
  const r3 = runCase(built.rom, '#tape three-progs\nCLOAD "TWO"\n#tape-rewind\nCLOAD "TWO"\nLIST\n');
  check('#tape NAME: the fixture plays; #tape-rewind plays it again from the start', r3.status === 'ok' && r3.transcript.filter((l) => l === 'SKIP ONE').length === 2 && r3.transcript.includes('10 PRINT "PROGRAM TWO"'), JSON.stringify(r3.transcript));
  // the motor: one run on one line, left running past OK (length null), then carried into the next summary
  const r4 = runCase(built.rom, '#tape three-progs\nMOTOR ON:FOR I=1 TO 300:NEXT:MOTOR OFF\n#tape-blocks loop\nMOTOR ON\n#tape-blocks on\nMOTOR OFF\n#tape-blocks off\n');
  const [loop, on, off] = r4.tapes || [];
  check('#tape-blocks: a MOTOR ON ... OFF on one line is one run of some fields', !!loop && loop.motor.length === 1 && loop.motor[0].length > 5 && !loop.motor[0].carried, JSON.stringify(loop));
  check('#tape-blocks: the motor still running: length null', !!on && on.motor.length === 1 && on.motor[0].length === null, JSON.stringify(on));
  check('#tape-blocks: a run going when the summary window began is marked carried', !!off && off.motor.length === 1 && off.motor[0].carried === true && off.motor[0].length > 0, JSON.stringify(off));
  check('#tape bad-block: our ROM gives ?IO ERROR', runCase(built.rom, '#tape bad-block\nCLOAD\n').transcript.includes('?IO ERROR'));
  // directives used wrongly stop the case
  for (const bad of ['#tape-rewind\n', '#tape-blocks x\n', '#tape no-such-tape\n', '#tape ../tapes/mc\n'])
    check(`tape directive refused at run time: ${bad.trim()}`, runCase(built.rom, bad).status === 'bad-directive');
  check('#tape NAME from another folder (runCase\'s tapes)', runCase(built.rom, '#tape ok\nCLOAD\nLIST\n', { tapes: dir }).transcript.includes('10 PRINT 1'));

  // compare: the summaries
  const T = (o = {}) => ({ name: 't', blocks: [{ type: 0, length: 15, ok: true, leader: 128, name: 'A       ', fileType: 0, ascii: 0, gaps: 0, exec: 0, load: 0 }, { type: 1, length: 3, ok: true, leader: 129, sha256: 'aa' }], bad: 0, motor: [{ start: 0, length: 100 }], ...o });
  const B = T().blocks;
  check('compare tapes: identical summaries pass', compareTapes([T()], [T()]).length === 0);
  check('compare tapes: a data hash differs', compareTapes([T()], [T({ blocks: [B[0], { ...B[1], sha256: 'bb' }] })]).some((l) => /block 2/.test(l)));
  check('compare tapes: a namefile field differs', compareTapes([T()], [T({ blocks: [{ ...B[0], gaps: 255 }, B[1]] })]).some((l) => /block 1/.test(l)));
  check('compare tapes: a leader differs', compareTapes([T()], [T({ blocks: [{ ...B[0], leader: 127 }, B[1]] })]).length === 1);
  check('compare tapes: a missing block, and blocks in only one', compareTapes([T()], [T({ blocks: B.slice(0, 1) })]).some((l) => /2 vs 1 blocks/.test(l)) && compareTapes([T()], [T({ blocks: undefined })]).some((l) => /only one/.test(l)));
  check('compare tapes: the number of bad blocks', compareTapes([T()], [T({ bad: 1 })]).some((l) => /bad/.test(l)));
  check('compare tapes: motor times within one field pass, more than one do not', compareTapes([T()], [T({ motor: [{ start: 0.9, length: 100.9 }] })]).length === 0
    && compareTapes([T()], [T({ motor: [{ start: 0, length: 101.2 }] })]).some((l) => /motor run 1: 100 vs 101.2/.test(l))
    && compareTapes([T()], [T({ motor: [{ start: 1.5, length: 100 }] })]).some((l) => /starts at/.test(l)));
  check('compare tapes: the number of motor runs, and still running vs stopped', compareTapes([T()], [T({ motor: [] })]).some((l) => /1 vs 0 motor runs/.test(l)) && compareTapes([T()], [T({ motor: [{ start: 0, length: null }] })]).some((l) => /still running/.test(l)));
  check('compare tapes: a carried run\'s length is not compared, whether it was carried is', compareTapes([T({ motor: [{ start: 0, length: 5, carried: true }] })], [T({ motor: [{ start: 0, length: 50, carried: true }] })]).length === 0
    && compareTapes([T({ motor: [{ start: 0, length: 5, carried: true }] })], [T({ motor: [{ start: 0, length: 5 }] })]).some((l) => /carried/.test(l)));
  check('compare tapes: summaries by name and number', compareTapes([T()], [T({ name: 'u' })]).some((l) => /named u/.test(l)) && compareTapes([T()], []).some((l) => /1 vs 0 tape/.test(l)));
  const rr = { case: 'k', status: 'ok', transcript: ['OK'], tapes: [T()] };
  check('compare: a case whose tape summary differs is not identical', compare(new Map([['k', rr]]), new Map([['k', { ...rr, tapes: [T({ bad: 1 })] }]])).same === 0 && compare(new Map([['k', rr]]), new Map([['k', rr]])).same === 1);

  // the typing sheet
  const { sheet } = require('../tools/basic-bb/sheet.js');
  const sh = sheet('t', '#tape-blank\nCSAVE "A"\n#tape-blocks a\n#tape-rewind\nCLOAD\n#tape three-progs\n');
  check('sheet: blank tape, rewind and a fixture as steps; the summaries said to come from run.js only', /run\.js: nothing to write down[^]*blank tape[^]*RECORD and PLAY[^]*CSAVE "A"[^]*rewind the tape[^]*CLOAD[^]*tape three-progs at its start \(tests\/basic\/tapes\/three-progs\.json; node tools\/basic-bb\/tapes\.js three-progs --wav FILE/.test(sh) && (sh.match(/^\d+\./gm) || []).length === 8, sh);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
