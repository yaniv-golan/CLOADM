// Run: node tests/basic-bb10-scr.test.js
//
// bb10 scr-prompt-idle (tests/basic/bb/bb10-real.jsonl) replayed on the clean-room BASIC (docs/clean-room-basic.md
// sections 7, 12 and 14): identical ($97-$98 = 4, 94; the blink, pictures that differ only in the cursor counted
// alike), and a mutant of the keyboard's debounce delay that turns it red. The rest of bb10: tests/basic-bb10.test.js.
const { identical, mutants, tally } = require('./basic/basic-bb10-lib.js');

identical(['scr-prompt-idle']);
mutants([
  ['the debounce delay at its old value', 'boot.inc', '        LDD     #1118 ', '        LDD     #300 ', 'scr-prompt-idle'],
]);
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
