// Run: node tests/basic-ram.test.js
//
// The clean-room BASIC's RAM layout where programs can see it (docs/clean-room-basic.md, "The direct page"): the
// addresses the original keeps its system variables at, from black-box records of a real Dragon 64 (bb3
// ram-pointers, bb6 famous-pokes: tests/basic/bb/), pinned by symbol and by behaviour:
//  * every fixed address in the assembled ROM's symbols;
//  * a program that PEEKs and POKEs them: TRON (175), lower case (329), the program's start (25, NEW), TIMER (274),
//    the cold-start flag (113), the output device (111: 0 and $FF only);
//  * the two real records replayed on ours: identical, apart from the lines whose values come from the
//    interpreter's speed (TIMER after a run, the loop timings), the direct-mode text pointer (where the input
//    buffer is: not yet the original's) and the printer (not built).
const fs = require('fs'), path = require('path');
const { runCase } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');
let n = 0, fail = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const built = buildBasic(), sym = (s) => built.symbols.get(s);

// ---- the fixed addresses ----
const PINS = { TXTTAB: 0x19, VARTAB: 0x1B, ARYTAB: 0x1D, ARYEND: 0x1F, STRBOT: 0x21, FRETOP: 0x23, MEMTOP: 0x27,
  CURLIN: 0x68, DEVNUM: 0x6F, WARMFL: 0x71, CURPOS: 0x88, BLINK: 0x8F, KEYDLY: 0x97, TXTPTR: 0xA6, TRCFLG: 0xAF,
  TIMER: 0x112, CASEFL: 0x149 };
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
// the lines whose values are the interpreter's speed or the input buffer's place, not the layout
const speedOrBuffer = (l) => /^TI \d+ 112 \d+$/.test(l) || /^L 65535 T \d+$/.test(l) || /^NORMAL \d+ FAST \d+ MAX \d+$/.test(l);
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
  check(`${name}: ours matches the original's record line for line (speed and input-buffer lines aside)`, diff.length === 0, diff.slice(0, 3).join(' | '));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
