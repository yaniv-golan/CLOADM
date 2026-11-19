// A US keyboard as a browser reports it: printable character -> the KeyboardEvent.code of its key and
// whether Shift is held to type it (the US ANSI layout as Chrome/Firefox/Safari report it on Windows, macOS
// and Linux; UI Events KeyboardEvent code Values, W3C, section 3.1.1 "Alphanumeric Section"). Used by
// tests/input.test.js and tools/browser-check.js to send the events a person typing on such a keyboard sends.
const ROWS = [
  ['`~', 'Backquote'], ['1!', 'Digit1'], ['2@', 'Digit2'], ['3#', 'Digit3'], ['4$', 'Digit4'], ['5%', 'Digit5'],
  ['6^', 'Digit6'], ['7&', 'Digit7'], ['8*', 'Digit8'], ['9(', 'Digit9'], ['0)', 'Digit0'], ['-_', 'Minus'],
  ['=+', 'Equal'], ['[{', 'BracketLeft'], [']}', 'BracketRight'], ['\\|', 'Backslash'], [';:', 'Semicolon'],
  ["'\"", 'Quote'], [',<', 'Comma'], ['.>', 'Period'], ['/?', 'Slash'], [' ', 'Space'],
];
const US = {};
for (const [pair, code] of ROWS) { US[pair[0]] = { code, shift: false }; if (pair[1]) US[pair[1]] = { code, shift: true }; }
for (let c = 65; c <= 90; c++) {
  const up = String.fromCharCode(c);
  US[up.toLowerCase()] = { code: `Key${up}`, shift: false };
  US[up] = { code: `Key${up}`, shift: true };
}
module.exports = { US };
