// Run: node tests/basic-cursor-mutants.test.js
//
// The mutants of the clean-room BASIC's cursor (docs/clean-room-basic.md, "The cursor"): each built from edited
// source by buildBasic({ edit }) must fail the quick checks of tests/basic-cursor.test.js (the countdown, the
// transformation, the delay, the keyboard, running programs, KEYDLY; tests/basic/basic-cursor-lib.js) on the Dragon 64.
const { buildBasic } = require('../tools/build-basic.js');
const { st, check, tally, suite } = require('./basic/basic-cursor-lib.js');

// ---- mutants: each must fail the quick checks ----
const MUTANTS = [
  ['reload 49', 'keyboard.inc', 'LDA     #50', 'LDA     #49'],
  ['toggle bit 5', 'keyboard.inc', 'EORA    #$40', 'EORA    #$20'],
  ['$60 not written on accept', 'keyboard.inc', 'LDB     #$60\n        LDX     <CURPOS\n        STB     ,X', 'LDB     #$60\n        LDX     <CURPOS\n        TST     ,X'],
  ['moving resets the countdown', 'screen.inc', 'CHRDON  STX     <CURPOS', 'CHRDON  STX     <CURPOS\n        LDB     #50\n        STB     <BLINK'],
  ['accepting resets the countdown', 'keyboard.inc', '        STB     ,X\n        PULS    B,X,PC', '        STB     ,X\n        LDB     #50\n        STB     <BLINK\n        PULS    B,X,PC'],
  ['delay 1 pass fewer', 'keyboard.inc', 'LEAX    -55,X', 'LEAX    -56,X'],
  ['the cursor address not read from RAM', 'keyboard.inc', '        LDX     <CURPOS\n        LDA     ,X', '        LDX     #SCREEN\n        LDA     ,X'],
  ['a 0 countdown toggles at once', 'keyboard.inc', 'KW1     DEC     <BLINK\n        BNE     KW2', 'KW1     DEC     <BLINK\n        BGT     KW2'],
  ['the cursor\'s delay not from KEYDLY', 'keyboard.inc', 'KW2     LDX     <KEYDLY', 'KW2     LDX     #1118\n        NOP'],
  ['printing counts the countdown down', 'screen.inc', 'CHRPUT  STA     ,X+', 'CHRPUT  STA     ,X+\n        DEC     <BLINK'],
  ['the delay 10% longer', 'keyboard.inc', 'LEAX    -55,X', 'LEAX    50,X'],
];
for (const [name, file, from, to] of MUTANTS) {
  let used = false;
  const mrom = buildBasic({ edit: (f, text) => { if (f !== file) return text; if (!text.includes(from)) throw new Error(`mutant ${name}: no ${from}`); used = true; return text.replace(from, to); } }).rom;
  const f0 = st.fail, n0 = st.n, out = console.log;
  console.log = () => {};
  st.firstFail = null;
  let crashed = null;
  try { suite(mrom, { quick: true }); } catch (e) { crashed = e.message; }
  console.log = out;
  const failed = crashed || st.fail > f0;
  st.fail = f0; st.n = n0;
  check(`mutant "${name}" fails the checks`, used && failed, crashed ? `(it stopped: ${crashed})` : `(first: ${st.firstFail})`);
}

const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
