// Run: node tests/basic-using-regress.test.js
//
// PRINT USING's numeric field scanner (basic/using.inc USNUM) on the edges a review found no test held
// (docs/clean-room-basic.md section 2, PRINT USING): ** with $ (positive and negative), ** alone, $$, ** with $ and
// places, a trailing + with a negative number, a partial ^^^ printed as literals, and a field that ends at the very
// end of its format string (the format A$, one #, lies just below B$, "#", in the string space: the scanner must stop
// at A$'s length). Ours' answers [OWN]; the original's are to be recorded (bb14 using-star-dollar). Each mutant of the
// scanner's rules must change one answer.
const { buildBasic } = require('../tools/build-basic.js');
const { runCase } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const CASES = [
  ['"**$##";42', '**$42'], ['"**$##";-42', '*-$42'], ['"**##";42', '**42'], ['"$$##";42', ' $42'], ['"**$##.##";42', '**$42.00'],
  ['"##+";-5', ' 5-'], ['"##^^^";1.5', ' 2^^^'],
];
const program = CASES.map(([u], i) => `${10 + i * 10} PRINT USING ${u}`).join('\n')
  + '\n100 B$="#"+"":A$="#"+"":PRINT USING A$;55\nRUN\n';
const answers = (rom) => {
  const t = runCase(rom, program).transcript, k = t.lastIndexOf('RUN');
  return t.slice(k + 1, k + 1 + CASES.length + 1);
};
const want = [...CASES.map(([, w]) => w), '%55'];
{
  const got = answers(buildBasic().rom);
  CASES.forEach(([u, w], i) => check(`PRINT USING ${u}: ${JSON.stringify(w)}`, got[i] === w, JSON.stringify(got[i])));
  check('PRINT USING A$;55 with A$ "#" just below B$ "#": the field is one place, "%55"', got[CASES.length] === '%55', JSON.stringify(got[CASES.length]));
}
for (const [what, from, to] of [
  ['** without the $ that follows it', '        LDA     #8\n        BSR     UNFLAG\n        BRA     UNPLACE\n', '        LDA     #0\n        BSR     UNFLAG\n        BRA     UNPLACE\n'],
  ['a trailing + taken as a leading one', '        LDA     #32\n        BRA     UNTRAIL\n', '        LDA     #16\n        BRA     UNTRAIL\n'],
  ['three carets taken as an exponent', '        LDY     #4\n', '        LDY     #3\n'],
  ['no end-of-format test', '        BHS     UNEND\n', '        BRN     UNEND\n'],
]) {
  const rom = buildBasic({ edit: (f, t) => { if (f !== 'using.inc') return t; if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`); return t.replace(from, to); } }).rom;
  const got = answers(rom);
  check(`mutant "${what}": an answer changes`, JSON.stringify(got) !== JSON.stringify(want), JSON.stringify(got));
}
console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
