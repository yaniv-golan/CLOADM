// Run: node tests/basic-printer.test.js
//
// LLIST and PRINT #-2 on the clean-room BASIC (docs/clean-room-basic.md, section 12, the printer): the bb11 record
// of the real Dragon 64 BASIC (tests/basic/bb/bb11-real.jsonl, case stmt-printer2, run with the printer ready)
// replayed whole, ours identical to it, screen and printer bytes; with the printer busy (PIA 1 PB0 high, as the
// published $FF22 entry has it [DOC]) nothing is sent until it is ready, then the bytes in order (bb10 stmt-printer
// and bb6 famous-pokes are not used: their wait came from an emulator that read PB0 as busy); the published entry
// $800F is our printer routine;
// and mutants of each rule that must not match: the byte on the port before the strobe, the busy wait, PRINT #-2
// alone, the carriage return LIST leaves out at a full row, and the output back on the screen afterwards.
const fs = require('fs'), path = require('path');
const { buildBasic } = require('../tools/build-basic.js');
const { runCase } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const caseText = (name) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${name}.bas`), 'utf8');
const real = (file, name) => fs.readFileSync(path.join(__dirname, 'basic/bb', file), 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.case === name);
const want = real('bb11-real.jsonl', 'stmt-printer2');

const same = (r) => r.status === 'ok' && JSON.stringify(r.transcript) === JSON.stringify(want.transcript) && JSON.stringify(r.printer) === JSON.stringify(want.printer);
const built = buildBasic();
const r = runCase(built.rom, caseText('stmt-printer2'));
check('stmt-printer2: ours identical to the original\'s record, the screen and the 49 printer bytes [BB bb11]', same(r),
  JSON.stringify(r.printer && Buffer.from(r.printer.hex, 'hex').toString('latin1')));
// the busy line: PB0 held high, PRINT #-2,"AB" typed; no byte while busy, then both once it is let go [DOC]
const { Basic } = require('./basic/harness.js');
const busyRun = (rom) => {
  const b = new Basic(rom);
  b.waitOk({ limit: 600, stable: 3 });
  const pa = b.m.pia1.a, pb = b.m.pia1.b, was = pb.input, out = [];
  let last = pa.outValue(), busy = true;
  pb.input = () => (busy ? was() | 1 : was() & 0xFE);
  const before = pa.onOutput;
  pa.onOutput = (v) => { if (before) before(v); if ((v & 2) && !(last & 2) && (v & 0xFC) === (last & 0xFC)) out.push(b.m.pia0.b.outValue()); last = v; };
  b.type('PRINT #-2,"AB"\n');
  b.run(100);
  const whileBusy = out.length;
  busy = false;
  b.waitOk({ limit: 600 });
  return { whileBusy, after: Buffer.from(out).toString('latin1') };
};
{
  const g = busyRun(built.rom);
  check('PB0 busy: nothing sent while busy, then "AB" and a CR once ready [DOC]', g.whileBusy === 0 && g.after === 'AB\r', JSON.stringify(g));
}
check('$800F: JMP PRTOUT, the published printer entry', built.rom[0x0F] === 0x7E && built.rom[0x10] * 256 + built.rom[0x11] === built.symbols.get('PRTOUT'));
check('$8000: PRTOFF, the output back to the screen', built.symbols.get('PRTOFF') === 0x8000);

// mutants: each must no longer match the record (or, for the busy wait, no longer wait)
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
  if (f !== file) return t;
  if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`);
  return t.replace(from, to);
} }).rom;
for (const [what, file, from, to] of [
  ['the byte put on the port after the strobe (the last byte latched again)', 'printer.inc', '        STA     PIA0B\n        LDB     ,X\n        ANDB    #$FD\n        STB     ,X\n        ORB     #2\n        STB     ,X\n', '        LDB     ,X\n        ANDB    #$FD\n        STB     ,X\n        ORB     #2\n        STB     ,X\n        STA     PIA0B\n'],
  ['PRINT #-2 alone prints nothing', 'printer.inc', '        LDA     #13\n        BRA     PRTOUT', '        RTS\n        BRA     PRTOUT'],
  ['LIST\'s line end takes the screen\'s column on the printer too (no CR after a line there)', 'program.inc', 'LL3B    JSR     COLMN           ; (the printer\'s column on the printer: LLIST)\n', 'LL3B    LDA     <CURPOS+1\n        ANDA    #31\n'],
]) {
  const m = runCase(mutant(file, from, to), caseText('stmt-printer2'));
  check(`mutant "${what}": no longer as recorded`, !same(m));
}
// the output back on the screen at PRINT #-2's end, before the next statement of the line or the program [OWN: the
// record types one statement a line, and READY puts the output back after each]
const after = '#printer-ready\nPRINT #-2,"A":PRINT "B"\n10 PRINT #-2,"C";:PRINT "D"\nRUN\n';
const back = (rom) => { const x = runCase(rom, after); const p = x.printer ? Buffer.from(x.printer.hex, 'hex').toString('latin1') : ''; return { ok: p === 'A\rC' && x.transcript.includes('B') && x.transcript.includes('D'), p, t: x.transcript }; };
{
  const g = back(built.rom);
  check('PRINT #-2,"A":PRINT "B" and the same in a program: A and C to the printer, B and D on the screen [OWN]', g.ok, JSON.stringify(g));
  const m = back(mutant('printer.inc', '        LDD     #PRTOFF\n', '        LDD     #PRTOFF+5\n'));
  check('mutant "PRINT #-2 leaves the output on the printer": B and D no longer on the screen', !m.ok, JSON.stringify(m.p));
}
{
  const m = busyRun(mutant('printer.inc', '        BCS     PRO1\n', '        BRN     PRO1\n'));
  check('mutant "no busy wait": bytes sent while PB0 is busy', m.whileBusy > 0, JSON.stringify(m));
}

// PRINT # to the other devices goes on as before PRTDEV took the device: #-1 to the tape file, #-3 ?DN ERROR (CDEV
// reads the device from the # in A, which PRTDEV's look at #-2 must put back) [OWN]
const others = (rom) => { const r = runCase(rom, '#tape-blank\n10 OPEN "O",#-1,"F"\n20 PRINT #-1,"A"\n30 CLOSE #-1\nRUN\nPRINT #-3,1\n'); const t = r.transcript.join('|'); return { ok: r.status === 'ok' && t.includes('RUN|OK') && t.includes('?DN ERROR'), t }; };
{
  const g = others(built.rom);
  check('PRINT #-1 writes to the tape file and PRINT #-3 is ?DN ERROR, as before', g.ok, g.t);
  const m = others(mutant('printer.inc', "        LDA     #'#'            ; (CDEV reads the device from the #, in A)\n", ''));
  check('mutant "A not put back before CDEV": PRINT #-1 no longer works', !m.ok, m.t);
}

// The printer's own column [OWN]: PRINT #-2's comma moves to the next 16 of it and TAB(n) to its column n, whatever the
// screen's column (the screen's column made a comma after PRINT "XYZ"; loop for ever, its spaces never moving it)
const pcol = (rom) => {
  const p = (x) => (x.printer ? Buffer.from(x.printer.hex, 'hex').toString('latin1') : '');
  const a = runCase(rom, '#printer-ready\n#timeout 5\n10 PRINT "XYZ";:PRINT #-2,"A","B"\nRUN\n');
  const b = runCase(rom, '#printer-ready\nPRINT #-2,"A";TAB(5);"B"\n');
  return { comma: a.status === 'ok' && p(a) === 'A' + ' '.repeat(15) + 'B\r', tab: b.status === 'ok' && p(b) === 'A    B\r', a: [a.status, p(a)], b: [b.status, p(b)] };
};
{
  const g = pcol(built.rom);
  check('PRINT #-2,"A","B" after the screen\'s column 3: B at the printer\'s column 16', g.comma, JSON.stringify(g.a));
  check('PRINT #-2,"A";TAB(5);"B": B at the printer\'s column 5', g.tab, JSON.stringify(g.b));
  const m = pcol(mutant('print.inc', '        CMPA    #$FE\n        BNE     COLM1\n', '        CMPA    #$FE\n        BRA     COLM1\n'));
  check('mutant "the comma and TAB( take the screen\'s column": no longer as above', !m.comma && !m.tab, JSON.stringify([m.a, m.b]));
}
// BREAK during LLIST: the output back on the screen, the screen's column as it was (no empty row before OK) and $6F
// (DEVNUM) 0; an error in LLIST's range the same [OWN]
const lines = Array.from({ length: 120 }, (_, k) => `${k + 1} REM LINE ${k + 1}`).join('\n');
const brk = (rom) => {
  const x = runCase(rom, `#printer-ready\n${lines}\n#nowait\nLLIST\n#break\nPRINT PEEK(111)\nLLIST X\nPRINT PEEK(111)\n`);
  const t = x.transcript, k = t.lastIndexOf('LLIST'), j = t.indexOf('LLIST X');
  return { ok: x.status === 'ok' && t[k + 1] !== '' && t[j + 1] === '?SN ERROR' && t.filter((l) => l === ' 0').length === 2, t: t.slice(k - 1) };
};
{
  const g = brk(built.rom);
  check('BREAK and an error in LLIST: no empty row, PEEK(111) 0 after each', g.ok, JSON.stringify(g.t));
  const m = brk(mutant('printer.inc', 'PRTEND  CLR     <DEVNUM\n', 'PRTEND  NOP\n        NOP\n'));
  check('mutant "PRTEND leaves DEVNUM": PEEK(111) is not 0 after BREAK', !m.ok, JSON.stringify(m.t));
}
// PRINT #-23 is ?DN ERROR, as for any other device but -1 and -2 [OWN]
const dn = (rom) => { const x = runCase(rom, '#printer-ready\nPRINT #-23,1\n'); return { ok: x.transcript.includes('?DN ERROR') && !x.printer, t: x.transcript }; };
{
  check('PRINT #-23,1: ?DN ERROR, nothing printed', dn(built.rom).ok, JSON.stringify(dn(built.rom).t));
  const m = dn(mutant('printer.inc', '        LBCS    DNERR           ; (a digit after the 2: #-20 to #-29, ?DN ERROR as for any other device)\n', ''));
  check('mutant "a digit after #-2 not refused": no longer ?DN ERROR', !m.ok, JSON.stringify(m.t));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
