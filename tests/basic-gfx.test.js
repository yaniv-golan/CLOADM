// Run: node tests/basic-gfx.test.js
//
// The clean-room BASIC's graphics foundation (docs/clean-room-basic-p2.md sections 3, 5, 9 and 10): PCLEAR, PMODE,
// SCREEN, COLOR, PCLS, PSET, PRESET, PPOINT, PCOPY and the text screen's SET, RESET and POINT. BASIC programs are
// typed into a Dragon 64 running the image assembled from basic/ at test time (no other ROM), and the pages in RAM
// are compared byte for byte with tests/basic/gfxmodel.js, a reference model written from the document's tables, not
// from the 6809 code. Also: PPOINT and POINT read back, SCREEN's PIA1 and SAM settings against the document's table
// written out by hand, PCLEAR moving a program (it still lists and runs, MEM changes by the pages), the return to the
// text screen when anything is printed (the original's, gfx-text-return), and the ?FC ERROR and ?SN ERROR cases. The
// PSET runs here are those of PMODE 3 and 4; PMODE 0-2's are in tests/basic-gfx-pset.test.js. The helpers, the random
// data and the PSET runs: tests/basic/basic-gfx-lib.js.
const { G, check, tally, symbols, boot, typeAll, last, ramEq, hex, runPlans, ppointBytes, ppointCoords, pcopySrc, setOps } = require('./basic/basic-gfx-lib.js');

// ---- PSET, PRESET, PCLS and COLOR in PMODE 3 and 4, every colour set, against the model ----
runPlans((pl) => pl.m >= 3);

// ---- PPOINT of known bytes in every mode and set ----
{
  const b = boot();
  const bytes = ppointBytes;
  typeAll(b, ['CLEAR 200,&H7000']);
  const coords = ppointCoords;
  const lines = ['10 FOR M=0 TO 4:FOR S=0 TO 1:PMODE M,1:SCREEN 1,S:RESTORE', '20 FOR I=0 TO 29:READ X,Y:POKE &H7000+M*64+S*32+I,PPOINT(X,Y):NEXT I,S,M'];
  for (let i = 0; i < coords.length; i += 10) lines.push(`${100 + i} DATA ${coords.slice(i, i + 10).map((c) => c.join(',')).join(',')}`);
  typeAll(b, lines);
  // the first 8 rows of every mode lie in the page's first 256 bytes; fill them with known bytes
  const page = Array.from({ length: 256 }, (_, i) => bytes[i & 63] ^ (i >> 6));
  b.m.ram.set(page, 0x600);
  typeAll(b, ['RUN']);
  let bad = null;
  for (let m = 0; m <= 4 && !bad; m++) {
    const pic = new G.Picture(b.m.ram);
    for (let s = 0; s <= 1 && !bad; s++) coords.forEach(([x, y], i) => {
      const want = G.ppoint(m, s, pic.get(m, 1, x, y)), got = b.m.ram[0x7000 + m * 64 + s * 32 + i];
      if (!bad && want !== got) bad = `PMODE ${m} set ${s} (${x},${y}): ours ${got}, model ${want}`;
    });
  }
  check('PPOINT reads every mode and colour set as the model (30 points each)', !bad, bad || '');
  typeAll(b, ['PMODE 3,1:SCREEN 1,0:PCLS:FOR C=0 TO 8:PSET(C*4,20,C):POKE &H7100+C,PPOINT(C*4,20):NEXT', 'PMODE 4,1:SCREEN 1,1:PCLS:FOR C=0 TO 8:PSET(C*4,20,C):POKE &H7110+C,PPOINT(C*4,20):NEXT']);
  const p3 = [...b.m.ram.slice(0x7100, 0x7109)], p4 = [...b.m.ram.slice(0x7110, 0x7119)];
  check('PSET colours 0-8 read back in PMODE 3, set 0 (0 and 4 both 4, 5-8 as 1-4)', p3.join() === [4, 1, 2, 3, 4, 1, 2, 3, 4].join(), p3.join());
  // [BB gfx-ppoint: the original's PSET 0-8 IN PMODE 4,1 reads back 0 5 0 5 0 5 0 5 0: an even colour is black]
  check('PSET colours 0-8 read back in PMODE 4, set 1 (odd colours the set\'s colour 5, even ones black)', p4.join() === [0, 5, 0, 5, 0, 5, 0, 5, 0].join(), p4.join());
}

// ---- SCREEN: PIA1 port B and the SAM, against the document's table written out by hand ----
{
  const TABLE = [[0, 0xB0, 3], [1, 0xC0, 4], [2, 0xD0, 5], [3, 0xE0, 6], [4, 0xF0, 6]];   // mode, PB7-PB4, SAM V
  const b = boot();
  typeAll(b, ['PCLEAR 8']);
  for (const [m, pb, v] of TABLE) for (const s of [0, 1]) {
    const p = m === 0 ? 8 : m === 4 ? 5 : 2;
    typeAll(b, [`10 PMODE ${m},${p}:SCREEN 1,${s}`, '20 GOTO 20']);
    b.type('RUN\n'); b.run(10);
    const out = b.m.pia1.b.outValue(), want = pb | (s << 3);
    check(`SCREEN 1,${s} in PMODE ${m},${p}: PB7-PB3 ${(want >> 3).toString(2)}, PB2 still high, SAM V ${v}, F at page ${p}`,
      (out & 0xF8) === want && (out & 4) === 4 && b.m.sam.vmode === v && b.m.sam.displayBase === G.pageStart(p),
      `PB ${out.toString(16)} V ${b.m.sam.vmode} F ${hex(b.m.sam.displayBase)}`);
    b.m.typist.holdPaced('BREAK'); b.waitOk({ limit: 600 });
    check(`after BREAK (PMODE ${m}, set ${s}): back to text, PB2 high, V 0, F $0400`, (b.m.pia1.b.outValue() & 0xFC) === 0x04 && b.m.sam.vmode === 0 && b.m.sam.displayBase === 0x400);
  }
  typeAll(b, ['10 PMODE 4,1:SCREEN 1,1:PRINT "TEXT";:X=1/0', 'RUN']);
  check('an error in a program with a picture shown: the text screen at OK', !b.graphicsShown() && b.screen().includes('?/0 ERROR IN 10'), b.screen().slice(-3).join('|'));
  typeAll(b, ['20 PMODE 4,1:SCREEN 1,0:PRINT "SHOWN"', '30 GOTO 30']);
  b.type('RUN 20\n'); b.run(20);
  // [BB gfx-text-return: the original shows the text screen again at PRINT and INPUT, not in an INKEY$ loop]
  check('PRINT while a picture is shown: the text screen is shown again', !b.graphicsShown() && b.screen().includes('SHOWN'));
  b.m.typist.holdPaced('BREAK'); b.waitOk({ limit: 600 });
  typeAll(b, ['20 PMODE 4,1:SCREEN 1,0:IF INKEY$="" THEN 20']);
  b.type('RUN 20\n'); b.run(20);
  check('a loop that prints nothing keeps the picture shown', b.graphicsShown());
  b.m.typist.holdPaced('BREAK'); b.waitOk({ limit: 600 });
  typeAll(b, ['SCREEN 1,1']);
  check('SCREEN 1 typed directly: back to text at the OK that follows', !b.graphicsShown());
}

// ---- PCLEAR ----
{
  const b = boot();
  const mem = () => { typeAll(b, ['PRINT MEM']); return Number(last(b)); };
  const m4 = mem();
  typeAll(b, ['10 A=5:PRINT "RUN";A', '20 FOR I=1 TO 3:PRINT I;:NEXT']);
  const prog = () => { typeAll(b, ['LIST']); return b.screen().slice(-3, -1).join('|'); };
  const list = prog();
  const m4p = mem();
  typeAll(b, ['PCLEAR 1']);
  check('PCLEAR 1: MEM grows by 3 pages (4608)', mem() - m4p === 3 * 1536);
  check('PCLEAR 1: the program starts at $0C01 and lists the same', b.m.ram[0x0C00] === 0 && (b.m.ram[0x0C01] << 8 | b.m.ram[0x0C02]) > 0x0C01 && prog() === list);
  typeAll(b, ['RUN']);
  check('PCLEAR 1: the program runs', last(b) === ' 1  2  3' && b.screen().includes('RUN 5'));
  typeAll(b, ['PCLEAR 8']);
  check('PCLEAR 8: MEM 7 pages less than PCLEAR 1', mem() === m4p + 3 * 1536 - 7 * 1536);
  check('PCLEAR 8: the program at $3601, lists and runs', b.m.ram[0x3600] === 0 && prog() === list && (typeAll(b, ['RUN']), last(b) === ' 1  2  3'));
  typeAll(b, ['PCLEAR 4']);
  check('PCLEAR 4: MEM as at the start, less the program', mem() === m4p && m4 > m4p);
  typeAll(b, ['A=7:PCLEAR 2:PRINT A;"X"']);
  check('PCLEAR typed directly clears the variables and goes on', last(b) === ' 0 X');
  typeAll(b, ['15 B=3:PCLEAR 1:PRINT "AFTER";A;B:GOSUB 40', '40 PRINT "SUB":RETURN', 'CLS', 'RUN']);
  check('PCLEAR in a program (moving down): variables cleared, the program goes on from the next statement', b.screen().join('|').includes('RUN 5|AFTER 0  0|SUB| 1  2  3'), b.screen().slice(-5).join('|'));
  typeAll(b, ['15 B=3:PCLEAR 6:PRINT "AFTER";A;B:GOSUB 40', 'CLS', 'RUN']);
  check('PCLEAR in a program (moving up): the same', b.screen().join('|').includes('RUN 5|AFTER 0  0|SUB| 1  2  3'), b.screen().slice(-5).join('|'));
  typeAll(b, ['PCLEAR 4', '15 B=3:PCLEAR 8:PMODE 4,5:PCLS 1:PRINT "AFTER";A;B:GOSUB 40', 'CLS', 'RUN']);
  check('PCLEAR in a program, then its old place cleared by PCLS: the program goes on from where it moved to', b.screen().join('|').includes('RUN 5|AFTER 0  0|SUB| 1  2  3'), b.screen().slice(-5).join('|'));
  typeAll(b, ['1 CLEAR 300:PCLEAR 1:I=RND(-TIMER):PCLEAR 4:CLEAR 200:PRINT "OK1"', 'CLS', 'RUN']);
  check('CLEAR and PCLEAR in either order on a program\'s first line', b.screen().join('|').includes('OK1|RUN 5|AFTER 0  0|SUB'), b.screen().slice(-6).join('|'));
  for (const bad of ['PCLEAR 0', 'PCLEAR 9', 'PCLEAR -1', 'PCLEAR 256']) {
    typeAll(b, [bad]);
    check(`${bad}: ?FC ERROR`, last(b) === '?FC ERROR');
  }
  typeAll(b, ['NEW', 'PCLEAR 4', 'PMODE 4,1:PCLEAR 2:PMODE 4,1']);
  check('PMODE 4,1 after PCLEAR 2: ?FC ERROR (its pages are not reserved)', last(b) === '?FC ERROR');
  typeAll(b, ['PCLEAR 4']);
  b.m.ram.fill(0x55, 0x0600, 0x1E00);
  typeAll(b, ['PMODE 3,1:PCLEAR 2:PCLS 0', '10 PRINT "STILL"', 'RUN']);
  const reserved = b.m.ram.slice(0x0600, 0x0C00).every((v) => v === 0), outside = b.m.ram.slice(0x0C00, 0x1200).every((v) => v === 0x55);
  check('PCLEAR 2 with PMODE 3 current: the mode no longer fits and becomes PMODE 0,1 (PCLS fills one page)',
    reserved && outside && last(b) === 'STILL', `${reserved} ${outside}`);
  typeAll(b, ['NEW', 'CLEAR 200,&H2000', 'PCLEAR 8']);
  check('PCLEAR 8 with the top of memory at $2000: ?OM ERROR', last(b) === '?OM ERROR');
}

// ---- PCOPY ----
{
  const b = boot();
  typeAll(b, ['PCLEAR 8']);
  const src = pcopySrc;
  b.m.ram.set(src, G.pageStart(2));
  typeAll(b, ['PCOPY 2 TO 7']);
  check('PCOPY 2 TO 7 copies the 1536 bytes', ramEq(b.m.ram, Uint8Array.from([...new Array(G.pageStart(7)).fill(0), ...src]), G.pageStart(7), G.pageStart(8)) < 0);
  typeAll(b, ['PCOPY 7 TO 7']);
  check('PCOPY of a page to itself leaves it', ramEq(b.m.ram, Uint8Array.from([...new Array(G.pageStart(7)).fill(0), ...src]), G.pageStart(7), G.pageStart(8)) < 0);
  typeAll(b, ['PCLEAR 4']);
  for (const bad of ['PCOPY 1 TO 5', 'PCOPY 5 TO 1', 'PCOPY 0 TO 1', 'PCOPY 1 TO 9']) { typeAll(b, [bad]); check(`${bad} with 4 pages: ?FC ERROR`, last(b) === '?FC ERROR'); }
  typeAll(b, ['PCOPY 1,2']);
  check('PCOPY 1,2: ?SN ERROR', last(b) === '?SN ERROR');
}

// ---- SET, RESET, POINT ----
{
  const b = boot();
  typeAll(b, ['CLEAR 200,&H7000']);
  const ops = setOps;
  const lines = ['10 CLS:FOR I=0 TO 63:READ X,Y,C:IF C<0 THEN RESET(X,Y) ELSE SET(X,Y,C)', '20 NEXT:RESTORE:FOR I=0 TO 63:READ X,Y,C:POKE &H7000+I,POINT(X,Y)+1:NEXT', '30 FOR I=0 TO 511:POKE &H7100+I,PEEK(1024+I):NEXT:CLS'];
  for (let i = 0; i < ops.length; i += 12) lines.push(`${100 + i} DATA ${ops.slice(i, i + 12).map((q) => q.join(',')).join(',')}`);
  typeAll(b, lines);
  typeAll(b, ['RUN']);
  const cls = Uint8Array.from(b.m.ram.slice(0x7100, 0x7300));
  const base = new Uint8Array(512);
  // a cell never touched keeps CLS's byte: take it from a cell no point lies in
  const touched = new Set(ops.map(([x, y]) => G.sgCell(x, y).addr - 0x400));
  const blank = [...Array(512).keys()].find((i) => !touched.has(i));
  base.fill(cls[blank]);
  for (const [x, y, c] of ops) { const q = G.sgCell(x, y), i = q.addr - 0x400; base[i] = c < 0 ? G.sgReset(base[i], q.bit) : G.sgSet(base[i], q.bit, c); }
  const at = ramEq(base, cls, 0, 512);
  check('SET and RESET: the text screen as the model (64 points)', at < 0 && !(cls[blank] & 0x80), at < 0 ? '' : `cell ${at}: ours ${cls[at].toString(16)}, model ${base[at].toString(16)}`);
  const pts = ops.map(([x, y]) => { const q = G.sgCell(x, y); return G.sgPoint(base[q.addr - 0x400], q.bit) + 1; });
  check('POINT reads them back (lit: the colour, not lit: 0, a text character: -1)', pts.join() === [...b.m.ram.slice(0x7000, 0x7000 + ops.length)].join());
  for (const bad of ['SET(64,0,1)', 'SET(0,32,1)', 'SET(0,0,9)', 'RESET(64,0)', 'PRINT POINT(0,32)']) { typeAll(b, [bad]); check(`${bad}: ?FC ERROR`, last(b) === '?FC ERROR'); }
}

// ---- errors ----
{
  const b = boot();
  const cases = [['PSET(-1,0)', 'FC'], ['PSET(65536,0)', 'FC'],
    ['PSET(0,0,9)', 'FC'], ['COLOR 9', 'FC'], ['COLOR 1,9', 'FC'], ['PCLS 9', 'FC'], ['PMODE 5,1', 'FC'], ['PMODE 0,0', 'FC'], ['PMODE 0,5', 'FC'], ['PMODE 3,2', 'FC'],
    ['SCREEN 256', 'FC'], ['PSET(1,2', 'SN'], ['PSET 1,2', 'SN'], ['PSET(1)', 'SN'], ['PRINT PPOINT(1,2', 'SN'], ['PSET("A",1)', 'TM']];
  for (const [line, err] of cases) { typeAll(b, [line]); check(`${line}: ?${err} ERROR`, last(b) === `?${err} ERROR`, last(b)); }
  // [BB gfx-errors: PSET(256,0), PSET(0,192), PRESET(300,10), SCREEN 2 and SCREEN 1,2 are no error, and PPOINT(256,0)
  // and PPOINT(0,192) then read 1: a point past the picture is taken at its edge]
  typeAll(b, ['PMODE 4,1:PCLS:PSET(256,0):PSET(0,192):PSET(300,191):PRESET(255,191)', 'PRINT PPOINT(256,0);PPOINT(0,192);PPOINT(300,1000);PPOINT(254,191)']);
  check('points past the picture are clamped to its edge', last(b) === ' 1  1  0  0' && (b.m.ram[0x61F] & 1) === 1 && b.m.ram[0x600 + 191 * 32] === 0x80, last(b));
  for (const line of ['SCREEN 2', 'SCREEN 1,2']) { typeAll(b, [line]); check(`${line}: no error`, b.screen().slice(-1)[0] === 'OK' && !last(b).includes('ERROR'), last(b)); }
  typeAll(b, ['PMODE 4,1:PCLS:SCREEN 1,1:PSET(0,0):PSET(1,0):PRESET(0,0)']);
  const lp = (o) => b.m.ram[symbols.get('LASTX') + o] << 8 | b.m.ram[symbols.get('LASTX') + o + 1];
  check('PMODE 4,1:PSET(0,0):PSET(1,0):PRESET(0,0): $0600 is $40', b.m.ram[0x600] === 0x40, b.m.ram[0x600].toString(16));
  // [BB gfx-line pmode4-boxes: LINE -(x,y) after PSET starts from the previous LINE's end]
  typeAll(b, ['LINE(10,20)-(30,40),PSET:PSET(200,150,1):PRESET(5,5):PRINT PPOINT(7,9)']);
  check('PSET, PRESET and PPOINT leave the last point (the LINE\'s end, 30,40)', lp(0) === 30 && lp(2) === 40, `${lp(0)},${lp(2)}`);
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
