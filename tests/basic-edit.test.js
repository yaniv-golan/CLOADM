// Run: node tests/basic-edit.test.js
//
// EDIT on the clean-room BASIC (docs/clean-room-basic.md): the bb10 record of the real Dragon 64 BASIC
// (tests/basic/bb/bb10-real.jsonl, case stmt-edit) replayed whole, which ours must give identically: EDIT n prints
// the line and then a second copy as it is edited; ENTER keeps the line; X goes to the end and inserts; L shows the
// line and starts it again; a count and space moves on; H deletes the rest and inserts; nD deletes n characters;
// EDIT of a missing line and EDIT with no number are ?UL ERROR; EDIT in a program shows both copies and comes back
// with no OK. Mutants of each rule must not be identical. Then our own rules [OWN]: insertion stops when the line is
// full, and LIST is as before once EDIT has spelt a line out.
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
const { compare } = require('../tools/basic-bb/compare.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const record = fs.readFileSync(path.join(__dirname, 'basic/bb/bb10-real.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).find((r) => r.case === 'stmt-edit');
const text = fs.readFileSync(path.join(__dirname, 'basic/cases/stmt-edit.bas'), 'utf8');
const same = (rom) => {
  const r = runCase(rom, text);
  return compare(new Map([['stmt-edit', record]]), new Map([['stmt-edit', { ...r, case: 'stmt-edit' }]]));
};
const mutant = (file, from, to) => buildBasic({ edit: (f, t) => {
  if (f !== file) return t;
  if (!t.includes(from)) throw new Error(`mutant source not found in ${file}: ${from}`);
  return t.replace(from, to);
} }).rom;

const { rom } = buildBasic();
{
  const r = same(rom);
  check('stmt-edit: ours identical to the original\'s record [BB bb10]', r.same === 1, r.report.slice(0, 3).join(' | '));
}

for (const [what, file, from, to] of [
  ['EDIT prints no first copy', 'lineinput.inc', 'JSR     LSTLIN          ; the first copy', 'CMPX    LSTLIN          ; the first copy'],
  ['ENTER does not show the rest of the line', 'lineinput.inc', 'EDENT   BSR     EDREST', 'EDENT   BRN     EDREST'],
  ['X inserts where it is instead of at the end', 'lineinput.inc', 'EDXT    BSR     EDREST', 'EDXT    BRN     EDREST'],
  ['L does not start the line again', 'lineinput.inc', '        JSR     CRLF\n        BRA     EDAGN', '        JSR     CRLF\n        BRA     EDC0'],
  ['space moves to the end, not by the count', 'lineinput.inc', 'EDSPC   BSR     EDSHOW', 'EDSPC   BSR     EDREST'],
  ['nD deletes one character', 'lineinput.inc', '        DECB\n        BNE     EDDEL', '        BRA     EDC0\n        BNE     EDDEL'],
  ['H keeps the rest of the line', 'lineinput.inc', 'EDHAK   CLR     ,X', 'EDHAK   TST     ,X'],
  ['a missing line is ?FC ERROR', 'lineinput.inc', '        LBCC    ULERR', '        LBCC    FCERR'],
  ['EDIT ends at OK', 'lineinput.inc', '        JMP     MAINLN', '        JMP     READY'],
]) check(`mutant "${what}": no longer identical`, same(mutant(file, from, to)).same === 0);

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
  !fullLine(runCase(mutant('lineinput.inc', 'CMPU    #LINBUF+LINMAX+1', 'CMPU    #LINBUF+LINMAX+3'), fullCase)));

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
