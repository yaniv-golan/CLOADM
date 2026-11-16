// Run: node tests/stub-console.test.js
// The no-ROM stub console (js/machines/stub.js, TextConsole): the VDG's 32x16 text screen only has the
// chip's own codes, so a name in a Latin accent - "Prologica" with an o-acute, as the CP 400 is really
// written - has to be folded to ASCII as it is drawn, not dropped. (Extending the character set is not an
// option: the real ROM's set is its own and the stub must not invent glyphs.)
const Emu = require('./load')();
let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

// a console over a 512-byte screen, as the SAM machines have at $0400
function screenConsole() {
  const ram = new Uint8Array(0x10000);
  let cur = 0x400;
  const c = new Emu.TextConsole(ram, 0x400, () => cur, (p) => { cur = p; });
  return {
    ram, c,
    cursor: () => cur,
    text: () => [...Array(512)].map((_, i) => { const v = ram[0x400 + i] & 0x3F; return String.fromCharCode(v < 32 ? v + 64 : v); }).join(''),
  };
}
const draw = (s) => { const t = screenConsole(); t.c.print(s); return t.text(); };
// how far the console's cursor moved: a character with no glyph must not advance it
const advance = (s) => { const t = screenConsole(); t.c.print(s); return t.cursorForTest(); };

check('plain ASCII is unchanged', draw('ABC 123') .startsWith('ABC 123'), draw('ABC 123').slice(0, 10));
// "Prologica" written properly: P r o g l o g i c a with an acute on the first o
check('an accented letter is folded, not dropped', draw('Prológica').startsWith('PROLOGICA'), draw('Prológica').slice(0, 12));
check('the CP 400 name renders whole', draw('Prológica CP 400').startsWith('PROLOGICA CP 400'), draw('Prológica CP 400').slice(0, 20));
// the letters a Spanish name needs, upper and lower case, composed and decomposed forms
for (const [src, want] of [
  ['áéíóúüñ', 'AEIOUUN'],     // á é í ó ú ü ñ (precomposed)
  ['áéíóúüñ', 'AEIOUUN'], // the same, decomposed
  ['ÁÉÍÓÚÜÑ', 'AEIOUUN'],     // upper case
  ['¿¡', 'NONE'],                      // inverted question/exclamation: no ASCII stand-in
]) {
  if (want === 'NONE') {
    // nothing drawn and the cursor has not moved (a blank cell renders as '@', so the screen alone
    // cannot tell "drew nothing" from "drew a blank")
    const t = screenConsole(); t.c.print(src);
    check(`folding ${JSON.stringify(src)} draws nothing`, t.cursor() === 0x400, 'cursor $' + t.cursor().toString(16));
  }
  else check(`folding ${JSON.stringify(src)}`, draw(src).startsWith(want), JSON.stringify(draw(src).slice(0, want.length)));
}
// a control code that is not a screen control is dropped rather than printed as noise
check('a non-ASCII symbol with no ASCII stand-in draws nothing', draw('Aé☃B').startsWith('AEB'), draw('Aé☃B').slice(0, 4));

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
