// Run: node tests/basic-edit.test.js
//
// EDIT on the clean-room BASIC (docs/clean-room-basic.md): every record of EDIT on the real Dragon 64 BASIC replayed
// whole, which ours must give identically (tests/basic/bb: bb10 stmt-edit, bb11 stmt-edit2 and stmt-edit3, bb12
// stmt-edit4 to stmt-edit4e, bb13c stmt-edit5, bb6 edit-digit-split). EDIT n prints the line and then a second copy as
// it is edited; ENTER keeps the line; X goes to the end and inserts; L shows the line and starts it again; a count
// and space moves on; H deletes the rest and inserts; nD deletes n characters; I inserts; nC changes n characters;
// nS c moves on to the n-th c and nK c deletes up to it (to the end when there is none); A starts again from the line
// as stored; E stores without showing the rest; Q leaves the line (OK); in insertion LEFT takes the last character
// out and SHIFT and the up arrow go back to the commands; EDIT 10X is ?SN ERROR; a line of 32 characters leaves an
// empty line under its first copy; EDIT of a missing line and EDIT with no number are ?UL ERROR; EDIT in a program
// shows both copies and comes back with no OK. Mutants of each rule must not be identical. Then our own rules [OWN]:
// S moves the cursor on to the n-th c after the cursor, control keys in C and insertion do nothing, EDIT after
// output mid-row, LEFT at the text's start, C at the line's end, insertion stops when the line is full, and LIST is
// as before once EDIT has spelt a line out.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
const { compare } = require('../tools/basic-bb/compare.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const CASES = ['stmt-edit', 'stmt-edit2', 'stmt-edit3', 'stmt-edit4', 'stmt-edit4b', 'stmt-edit4c', 'stmt-edit4d',
  'stmt-edit4e', 'edit-digit-split', 'stmt-edit5'];
const records = new Map();
for (const f of ['bb6', 'bb10', 'bb11', 'bb12', 'bb13c']) {
  for (const l of fs.readFileSync(path.join(__dirname, `basic/bb/${f}-real.jsonl`), 'utf8').trim().split('\n')) {
    const r = JSON.parse(l);
    if (CASES.includes(r.case)) records.set(r.case, r);
  }
}
const same = (rom, name) => {
  const r = runCase(rom, fs.readFileSync(path.join(__dirname, `basic/cases/${name}.bas`), 'utf8'));
  return compare(new Map([[name, records.get(name)]]), new Map([[name, { ...r, case: name }]]));
};
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
  if (f !== file) return t;
  if (!t.includes(from)) throw new Error(`mutant source not found in ${file}: ${from}`);
  return t.replace(from, to);
} }).rom;

const { rom } = buildBasic();
check('every EDIT case has its record', CASES.every((c) => records.has(c)), CASES.filter((c) => !records.has(c)).join());
for (const name of CASES) {
  const r = same(rom, name);
  check(`${name}: ours identical to the original's record [BB]`, r.same === 1, r.report.slice(0, 3).join(' | '));
}

// each mutant against the case that shows its rule
for (const [what, name, from, to] of [
  ['EDIT prints no first copy', 'stmt-edit', '        JSR     PRTSTR', '        CMPX    PRTSTR'],
  ['the first copy ends as LIST does (no empty line under 32 characters)', 'stmt-edit3', '        JSR     PRTSTR          ; leaves an empty one under it [BB bb11 stmt-edit3]\n        JSR     CRLF', '        JSR     PRTSTR\n        JSR     NEWLIN'],
  ['ENTER does not show the rest of the line', 'stmt-edit', 'EDENT   BSR     EDREST', 'EDENT   BRN     EDREST'],
  ['X inserts where it is instead of at the end', 'stmt-edit', 'EDXT    BSR     EDREST', 'EDXT    BRN     EDREST'],
  ['L does not start the line again', 'stmt-edit', 'EDLST   BSR     EDREST          ; L: the rest shown, and the line again from its start\n        JSR     CRLF', 'EDLST   BSR     EDREST\n        RTS'],
  ['space moves to the end, not by the count', 'stmt-edit', "' ',EDSHOW-EDBASE", "' ',EDREST-EDBASE"],
  ['nD deletes one character', 'stmt-edit', '        DECB\n        BNE     EDDEL', '        RTS\n        BNE     EDDEL'],
  ['H keeps the rest of the line', 'stmt-edit', 'EDHAK   CLR     ,X', 'EDHAK   TST     ,X'],
  ['a missing line is ?FC ERROR', 'stmt-edit', '        LBCC    ULERR', '        LBCC    FCERR'],
  ['EDIT ends at OK', 'stmt-edit', '        JMP     MAINLN', '        JMP     READY'],
  ['I is not a command', 'stmt-edit2', "'I',EDINS-EDBASE", "'#',EDINS-EDBASE"],
  ['nC changes one character', 'stmt-edit2', '        DECB\n        BNE     EDCHG', '        RTS\n        BNE     EDCHG'],
  ['nS and nK find the first c whatever n is', 'stmt-edit2', '        DECB\n        BNE     EDF1', '        RTS\n        BNE     EDF1'],
  ['K deletes the c too', 'stmt-edit2', 'EDKILL  BSR     EDFIND          ; nK c: the characters up to the n-th c gone\n        PSHS    X', 'EDKILL  BSR     EDFIND\n        LEAU    1,U\n        PSHS    X'],
  ['K with no such c deletes nothing', 'stmt-edit5', 'EDF2    LEAU    -1,U', 'EDF2    TFR     X,U'],
  ['A keeps the changes made', 'stmt-edit2', '        LBRA    EDIT1', '        LBRA    EDNUM'],
  ['E shows the rest', 'stmt-edit2', "'E',EDEND-EDBASE", "'E',EDENT-EDBASE"],
  ['Q stores the line', 'stmt-edit2', "'Q',EDQUIT-EDBASE", "'Q',EDEND-EDBASE"],
  ['LEFT in insertion does nothing', 'stmt-edit3', '        CMPA    #8\n        BEQ     EDBS', '        CMPA    #8\n        BEQ     EDINS'],
  ['SHIFT and up in insertion go in as a character', 'stmt-edit3', '        CMPA    #$5F            ; SHIFT and the up arrow: the commands again\n        BEQ     EDSH1', '        CMPA    #$5F\n        BRN     EDSH1'],
  ['anything may follow the number', 'stmt-edit4c', '        JSR     ENDCHK', '        CMPX    ENDCHK'],
  ['A keeps an insertion', 'stmt-edit5', '        LBRA    EDIT1', '        LBRA    EDNUM'],
]) check(`mutant "${what}": ${name} no longer identical`, same(mutant('edit.inc', from, to), name).same === 0);

// [OWN] where S leaves the cursor: the records show only that S then ENTER leaves the line as it was. Ours moves on
// to the n-th c, showing what it passes, so a D after it deletes that c.
const sCase = '#timeout 15\n10 PRINT "ABC"\n#nowait\nEDIT 10\n#type 2S"D\\n\nLIST\n';
const sMoved = (r) => r.status === 'ok' && r.transcript.join('|').includes('10 PRINT "ABC|LIST|10 PRINT "ABC|OK');
{
  const r = runCase(rom, sCase);
  check('[OWN] 2S" then D deletes the second quote', sMoved(r), r.transcript.slice(-5).join(' | '));
}
check('mutant "S does not move": the S check fails',
  !sMoved(runCase(mutant('edit.inc', '        BRA     EDSHOW\nEDKILL', '        RTS\nEDKILL'), sCase)));

// [OWN] the edges no record shows. EDIT after output that leaves the cursor mid-row (PRINT "XY";) starts its first
// copy on the next line, and the line it edits holds no carriage return: X, Z and ENTER store 10 PRINT "ABC"Z, which
// runs. LEFT at the text's start takes nothing out (the number's space stays). C at the line's end changes
// nothing, and the keys after it are not stored.
const ownCases = [
  ['EDIT after PRINT "XY"; edits the line cleanly',
    '#timeout 20\n10 PRINT "ABC"\n#nowait\nPRINT "XY";:EDIT 10\n#type XZ\\n\nLIST\nRUN\n',
    (t) => t.includes('XY|10 PRINT "ABC"|10 PRINT "ABC"Z|LIST|10 PRINT "ABC"Z|OK|RUN|ABC 0|OK'),
    ['        JSR     NEWLIN          ; on a line', '        CMPX    NEWLIN          ; on a line']],
  ['LEFT at the text\'s start takes nothing out',
    '#timeout 20\n10 PRINT "ABC"\n#nowait\nEDIT 10\n#type I\n#keys LEFT\n#keys LEFT\n#type \\n\nLIST\n',
    (t) => t.includes('EDIT 10|10 PRINT "ABC"|10 PRINT "ABC"|LIST|10 PRINT "ABC"|OK'),
    ['        BLS     EDINS\n        JSR     <ZCHROUT        ; (back one', '        BLO     EDINS\n        JSR     <ZCHROUT        ; (back one']],
  ['S starts after the cursor: 4 S" on a quote moves on to the next one',
    '#timeout 20\n10 REM "X"Y"\n#nowait\nEDIT 10\n#type 4 S"D\\n\nLIST\n',
    (t) => t.includes('LIST|10 REM "XY"|OK'),
    ['        TFR     X,U\nEDF1', '        LEAU    -1,X\nEDF1']],
  ['ENTER in C is not a change: 2C, ENTER, Q, R change two characters',
    '#timeout 20\n10 PRINT 7\n#nowait\nEDIT 10\n#type 2C\\nQR\\n\nLIST\n',
    (t) => t.includes('LIST|10 QRINT 7|OK'),
    ['        CMPA    #\' \'\n        BLO     EDCH1', '        CMPA    #\' \'\n        BRN     EDCH1']],
  ['a control key in insertion goes nowhere: I, RIGHT, Z in a string leaves it 2 characters long',
    '#timeout 20\n10 A$="7":PRINT LEN(A$)\n#nowait\nEDIT 10\n#type 4 I\n#keys RIGHT\n#type Z\\n\nRUN\n',
    (t) => t.includes('RUN| 2|OK'),
    ['        CMPA    #\' \'\n        BLO     EDINS', '        CMPA    #\' \'\n        BRN     EDINS']],
  ['C at the line\'s end changes nothing',
    '#timeout 20\n10 PRINT 7\n#nowait\nEDIT 10\n#type 99 3CZZZ\\n\nLIST\nPRINT 1\n',
    (t) => t.includes('LIST|10 PRINT 7|OK|PRINT 1| 1|OK'),
    ['EDCHG   TST     ,X              ; nC: n characters changed, as far as the line goes\n        BEQ     EDSH1', 'EDCHG   TST     ,X\n        BRN     EDSH1']],
];
for (const [what, text, ok, [from, to]] of ownCases) {
  const r = runCase(rom, text);
  check(`[OWN] ${what}`, r.status === 'ok' && ok(r.transcript.join('|')), r.transcript.slice(-6).join(' | '));
  const m = runCase(mutant('edit.inc', from, to), text);
  check(`mutant of "${what}": the check fails`, !(m.status === 'ok' && ok(m.transcript.join('|'))));
}

// [OWN] a line of 250 characters (the most a line holds, its number included) takes no more in insertion; LIST
// afterwards spells the line out as before (the output EDIT borrowed is back)
const line = `10 PRINT "${'A'.repeat(250 - 11)}"`;
const fullLine = (r) => r.status === 'ok' && !r.transcript.join('').includes('Z') && r.transcript.join('').includes(`${line.slice(-20)}OK`) && r.transcript.slice(-2).join() === ' 1,OK';
const fullCase = `#timeout 60\n${line}\n#nowait\nEDIT 10\n#type XZZ\\n\nLIST\nPRINT 1\n`;
{
  const r = runCase(rom, fullCase);
  check('a full line takes nothing more in insertion; LIST and PRINT work after EDIT', fullLine(r), `${r.status} ${r.transcript.slice(-4).join(' | ')}`);
}
check('mutant "a full line takes two more": the full-line check fails',
  !fullLine(runCase(mutant('edit.inc', 'CMPU    #LINBUF+LINMAX+1', 'CMPU    #LINBUF+LINMAX+3'), fullCase)));

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
