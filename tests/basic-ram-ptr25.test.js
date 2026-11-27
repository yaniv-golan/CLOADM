// Run: node tests/basic-ram-ptr25.test.js
//
// The clean-room BASIC's $25-26 (STRDST, docs/clean-room-basic.md, "The direct page"): bb8 ram-ptr25 (the pointer
// after each kind of string made, direct and in a program; a direct GOSUB whose INPUT reply overran the typed line)
// replayed whole on ours, identical to the original's record, and on mutants of the rule it pins, each no longer
// identical (tests/basic-ram.test.js says more).
const { buildBasic } = require('../tools/build-basic.js');
const { check, tally, built, real, caseText, runCase } = require('./basic/basic-ram-lib.js');

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

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
