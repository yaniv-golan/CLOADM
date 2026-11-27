// Run: node tests/basic-ram.test.js
//
// The clean-room BASIC's RAM layout where programs can see it (docs/clean-room-basic.md, "The direct page"): the
// addresses the original keeps its system variables at, from black-box records of a real Dragon 64 (bb3
// ram-pointers, bb6 famous-pokes: tests/basic/bb/), pinned by symbol and by behaviour:
//  * every fixed address in the assembled ROM's symbols;
//  * a program that PEEKs and POKEs them: TRON (175), lower case (329), the program's start (25, NEW), TIMER (274),
//    the cold-start flag (113), the output device (111: 0 and $FF only);
//  * the two real records replayed on ours: identical, apart from the lines whose values come from the
//    interpreter's speed (TIMER after a run, the loop timings) and the printer (not built); bb8 ram-ptr25 ($25-26
//    after each kind of string made, direct and in a program; a direct GOSUB whose INPUT reply overran the typed
//    line) replayed whole: identical, with mutants of the rule it pins;
//  * the input buffers' places from ram-pointers2 (2026-11-26), and its eight timing loops: each takes the
//    original's count of fields or up to two more, never fewer.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const built = buildBasic(), sym = (s) => built.symbols.get(s);

// ---- the fixed addresses ----
const PINS = { TXTTAB: 0x19, VARTAB: 0x1B, ARYTAB: 0x1D, ARYEND: 0x1F, STRBOT: 0x21, FRETOP: 0x23, MEMTOP: 0x27,
  CURLIN: 0x68, DEVNUM: 0x6F, WARMFL: 0x71, CURPOS: 0x88, BLINK: 0x8F, KEYDLY: 0x97, TXTPTR: 0xA6, TRCFLG: 0xAF,
  TIMER: 0x112, RNDX: 0x115, SEED: 0x116, CASEFL: 0x149, STRDST: 0x25, EXECAD: 0x9D, BLKBUF: 0x1DA };   // ([BB bb8] rnd-seq, ram-ptr25, cas-cloadm2; [BB bb9] rnd-state)
for (const [name, at] of Object.entries(PINS)) check(`${name} at $${at.toString(16).toUpperCase().padStart(4, '0')}`, sym(name) === at, sym(name) === undefined ? 'missing' : `$${sym(name).toString(16)}`);

// ---- the variables through PEEK and POKE ----
const run = (text) => runCase(built.rom, text);
const lines = (r) => r.transcript;
{
  const r = run('PRINT PEEK(113);PEEK(175);PEEK(329);PEEK(111);PEEK(25);PEEK(26)\nTRON:PRINT PEEK(175):TROFF:PRINT PEEK(175)\n');
  check('cold start: 113 is 85, TRON off (0), upper case (255), output to the screen (0), the program at $1E01', lines(r).includes(' 85  0  255  0  30  1'), JSON.stringify(lines(r)));
  check('TRON sets 175 to 79, TROFF to 0', lines(r).includes(' 79') && lines(r).filter((l) => l === ' 0').length >= 1, JSON.stringify(lines(r)));
}
{
  const r = run('10 A=1\n20 B=2\nPOKE 175,79\nRUN\nPOKE 175,0\nRUN\n');
  const t = lines(r), first = t.indexOf('RUN');
  check('POKE 175,79 turns the trace on, POKE 175,0 off', t[first + 1] === '[10][20]' && t.slice(first + 2).includes('RUN') && t[t.lastIndexOf('RUN') + 1] === 'OK', JSON.stringify(t));
}
{
  const r = run('10 POKE 329,0:INPUT A$:POKE 329,255:PRINT ASC(A$);PEEK(329)\n#nowait\nRUN\nA\n');
  check('POKE 329,0: a letter typed comes in lower case (97); 255 back to upper', lines(r).includes(' 97  255'), JSON.stringify(lines(r)));
}
{
  const r = run('PRINT MEM:POKE 25,6:NEW\nPRINT MEM;PEEK(25)\nPOKE 25,30:NEW\nPRINT MEM;PEEK(25)\n');
  check('POKE 25,6:NEW frees the four graphics pages (MEM 24871 -> 31015 with no program), POKE 25,30:NEW gives them back', lines(r).includes(' 24871') && lines(r).includes(' 31015  6') && lines(r).includes(' 24871  30'), JSON.stringify(lines(r)));
}
{
  const r = run('TIMER=500:POKE 274,0:POKE 275,0:PRINT TIMER\n');
  check('274-275 are TIMER: POKEd to 0, TIMER reads 0 (or 1, a field later)', lines(r).some((l) => l === ' 0' || l === ' 1'), JSON.stringify(lines(r)));
}
{
  const r = run('POKE 111,254:PRINT "ON THE SCREEN":POKE 111,0\n');
  check('POKE 111 with a value other than 0 or 255: output stays on the screen (no printer) [OWN]', lines(r).includes('ON THE SCREEN'), JSON.stringify(lines(r)));
}

// ---- the real records, replayed on ours ----
const real = (file, name) => fs.readFileSync(path.join(__dirname, 'basic/bb', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.case === name);
const caseText = (name) => fs.readFileSync(path.join(__dirname, 'basic/cases', `${name}.bas`), 'utf8');
// the lines whose values are the interpreter's speed, not the layout
const speedOrBuffer = (l) => /^TI \d+ 112 \d+$/.test(l) || /^NORMAL \d+ FAST \d+ MAX \d+$/.test(l);
for (const [file, name] of [['bb3-real.jsonl', 'ram-pointers'], ['bb6-real.jsonl', 'famous-pokes']]) {
  const want = real(file, name), got = run(caseText(name));
  let t = got.transcript;
  // famous-pokes ends at the printer on the original (it waited for one); ours prints on the screen: compare up to there
  if (name === 'famous-pokes') { const at = want.transcript.length; t = t.slice(0, at); }
  const diff = [];
  for (let i = 0; i < Math.max(t.length, want.transcript.length); i++) {
    const a = want.transcript[i], b = t[i];
    if (a !== b && !(a && b && speedOrBuffer(a) && speedOrBuffer(b))) diff.push(`${i + 1}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  check(`${name}: ours matches the original's record line for line (speed lines aside)`, diff.length === 0, diff.slice(0, 3).join(' | '));
}

// ---- $25-26: bb8 ram-ptr25 replayed whole, on ours and on mutants of the rule ----
{
  const { compare } = require('../tools/basic-bb/compare.js');
  const want = real('bb8-real.jsonl', 'ram-ptr25'), text = caseText('ram-ptr25');
  const same = (rom) => { const r = runCase(rom, text); return compare(new Map([['c', want]]), new Map([['c', { ...r, case: 'ram-ptr25' }]])); };
  const ours = same(built.rom);
  check('ram-ptr25: ours identical to the original\'s record', ours.same === 1, ours.report.slice(0, 2).join(' | '));
  for (const [what, file, from, to] of [
    ['a copy does not move it', 'strings.inc', 'DSTX    LEAX    1,X\n        STX     <STRDST', 'DSTX    LEAX    1,X\n        NOP\n        NOP'],
    ['a new string (CHR$\'s) leaves it a byte further on', 'strings.inc', '        ADDD    #1\n        STD     <STRDST', '        ADDD    #2\n        STD     <STRDST'],
    ['RETURN goes on right after the line number', 'interp.inc', '        PSHS    U\n        LBRA    DS1', '        STX     <TXTPTR\n        JMP     ,U'],
  ]) {
    const rom = buildBasic({ edit: (f, t) => { if (f !== file) return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${what}`); return t.replace(from, to); } }).rom;
    check(`ram-ptr25 mutant "${what}": no longer identical`, same(rom).same === 0);
  }
}

// ---- the input buffers' places: ram-pointers2 on the original [BB 2026-11-26] ----
// The typed line at 733 ($2DD) and its crunched form written over it a byte behind, from 732: the text pointer in
// direct mode at the PRINT of each line below (757, 761, 765: +4 for each X=0: before it), a marker in a typed
// line's REM found at 809 (crunched) and 837 (as typed), and a reply to INPUT at 733.
check('LINBUF at $02DD, CRNBUF at $02DC', sym('LINBUF') === 0x2DD && sym('CRNBUF') === 0x2DC);
{
  const r = run('#timeout 120\nPRINT "T";PEEK(166)*256+PEEK(167)\nX=0:PRINT "T";PEEK(166)*256+PEEK(167)\nX=0:Y=0:PRINT "T";PEEK(166)*256+PEEK(167)\n'
    + 'FOR I=0 TO 1022:P=(PEEK(I AND 32767)=81)AND(PEEK(I+1 AND 32767)=90):PRINT LEFT$(STR$(I),-6*P);:NEXT:REM QZ\n'
    + '10 INPUT A$\n20 FOR I=0 TO 1022:IF PEEK(I AND 32767)=81 THEN IF PEEK(I+1 AND 32767)=74 THEN PRINT I;\n30 NEXT:PRINT "DONE"\n#nowait\nRUN\n#type QJ\\n\n#wait-text ^OK(?![\\s\\S])\n');
  const t = lines(r);
  check('the text pointer in direct mode: 757, 761, 765 as on the original', t.includes('T 757') && t.includes('T 761') && t.includes('T 765'), JSON.stringify(t.filter((l) => /^T /.test(l))));
  check('a typed line\'s marker at 809 (crunched) and 837 (as typed), as on the original', t.includes(' 809 837'), JSON.stringify(t.filter((l) => /^ \d/.test(l))));
  check('a reply to INPUT at 733, as on the original', t.includes(' 733 DONE'), JSON.stringify(t.slice(-3)));
}

const REAL8 = { FOR: 113, ADD: 205, MUL: 224, DIV: 177, STR: 174, GOSUB: 83, IF: 516, MID: 137 };
// ---- as fast as the original and never faster (loops time games): ram-pointers2 itself, the whole case as the
// original ran it (what comes before its timing program counts: CLEAR 300 leaves the string loops more room, and a
// GOSUB's time depends on how many lines come before its target), against the original's counts
// (2026-11-26, docs/clean-room-basic.md section 2; each loop started just after a field begins): each of ours is
// the original's count or up to two fields more ----
{
  const REAL = REAL8;
  const r = run(caseText('ram-pointers2'));
  const t = lines(r).join(' ');
  check('ram-pointers2 runs to its end', r.status === 'ok', r.status);
  for (const [name, real] of Object.entries(REAL)) {
    const all = [...t.matchAll(new RegExp(`\\b${name} (\\d+)`, 'g'))], got = all.length ? +all[all.length - 1][1] : NaN; // (the last: the result lines, after the program's own text)
    check(`${name}: the original's ${real} fields, or up to 2 more, never fewer (ram-pointers2)`, got >= real && got <= real + 2, `${got}`);
  }
}

// ---- bb8 cas-cloadm2's two PEEK loops: never faster than the original, and at most 1% slower [BB 2026-11-26] ----
// The case as typed, against the original's record. Loop A (`FOR I=0 TO 1022:P=PEEK(I AND 32767):IF P=112 OR
// P=114 ...`, RUN after each CLOADM "MCX"): from the S a CLOADM shows on the top row (its search) to the screen the
// next CLOADM clears, which holds the load, loop A's 1023 passes, a six-pass PEEK loop and lines typed. Loop B (`S=0:FOR
// I=0 TO 599:S=S+PEEK(28928+I AND 32767):NEXT`): from BIGMC's last block (its last top-row flag) to the case's end,
// which holds loop B's 600 passes, NEW, three lines and RUN (a CLOADM and a SKIPF whose motor runs match the
// original's). The typist is paced alike on both, so these spans differ by what the machine runs; without FIN's
// wait for each digit (FPNX10: the original's time for a digit, by the number so far and the digit's bits, bb10
// time-literals) ours took 326 fields less in each of A's spans and 186 less in B's.
{
  const want = real('bb8-real.jsonl', 'cas-cloadm2'), text = caseText('cas-cloadm2');
  const spans = (r) => {
    const s = r.flags.filter((f) => f.row === 's').map((f) => f.frame), c = r.clears.map((x) => x.frame);
    return { A1: c[1] - s[0], A2: c[2] - s[1], B: r.frames - r.flags[r.flags.length - 1].frame };
  };
  const w = spans(want);
  const judge = (rom) => { const r = runCase(rom, text); return r.status === 'ok' && r.clears && r.clears.length === 3 ? spans(r) : null; };
  const within = (g) => g && Object.keys(w).every((k) => g[k] >= w[k] && g[k] <= w[k] * 1.01);
  const g = judge(built.rom);
  check('cas-cloadm2: loops A and B take the original\'s time or up to 1% more (fields)', within(g), JSON.stringify({ ours: g, original: w }));
  // (a mutant: one or more replacements in fpconv.inc, from, to, ...)
  const mutant = (...ft) => buildBasic({ edit: (f, t) => {
    if (f !== 'fpconv.inc') return t;
    for (let i = 0; i < ft.length; i += 2) { if (!t.includes(ft[i])) throw new Error(`mutant source not found: ${ft[i]}`); t = t.replace(ft[i], ft[i + 1]); }
    return t;
  } }).rom;
  for (const [what, ...ft] of [
    ['a digit waits a tenth less', '        LDB     #FIDLY\nFPW1', '        LDB     #FIDLY*9/10\nFPW1'],
    ['a digit waits a tenth more', '        LDB     #FIDLY\nFPW1', '        LDB     #FIDLY*11/10\nFPW1'],
    // (B 2420 against at most 2419.96: thin, as the change is worth two fields of loop B; tests/basic-timing.test.js
    // checks the loop itself against bb12 time-loopb)
    ['the conversion to an integer waits for places under 16 bits, 17 cycles each (before bb12)', 'CMPB    #17 ', 'CMPB    #16 ', 'SUBA    #17 ', 'SUBA    #16 ', 'PSHS    D\n        PULS    D', 'PSHS    B\n        PULS    B'],
  ]) {
    const m = judge(mutant(...ft));
    check(`cas-cloadm2 mutant "${what}": outside the original's time .. +1%`, !within(m), JSON.stringify(m));
  }
  // how long a 0 and a digit after the point wait is pinned by ram-pointers2's loops too: 1000 (IF), 2.5 (ADD, MUL)
  for (const [what, from, to] of [
    ['a 0 waits a tenth more', 'LDB     #FIZERO', 'LDB     #FIZERO*11/10'],
    ['a 0 waits a tenth less', 'LDB     #FIZERO', 'LDB     #FIZERO*9/10'],
    ['a digit after the point waits as one before it', 'SUBB    #FIDP', 'SUBB    #0'],
  ]) {
    const t = lines(runCase(mutant(from, to), caseText('ram-pointers2'))).join(' ');
    const out = Object.entries(REAL8).filter(([k, v]) => { const all = [...t.matchAll(new RegExp(`\\b${k} (\\d+)`, 'g'))]; return !(all.length && +all[all.length - 1][1] >= v && +all[all.length - 1][1] <= v + 2); }).map(([k]) => k);
    check(`ram-pointers2 mutant "${what}": a loop outside the original's count .. +2`, out.length > 0, out.join(','));
  }
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
