/*
 * Keyboard matrices: key name -> [row, column]. Key names are shared by every layout so that
 * host keyboard mapping and auto-typing work the same on all machines.
 */
import { registry } from '../util.js';

const positions = (matrix) => {
  const pos = {};
  matrix.forEach((row, r) => row.forEach((k, c) => { if (k) pos[k] = [r, c]; }));
  return pos;
};

// character -> { key, shift } for typing text (the shifted symbols are the same on every layout)
const SHIFTED = {
  '!': '1', '"': '2', '#': '3', '$': '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9',
  '*': ':', '+': ';', '<': ',', '=': '-', '>': '.', '?': '/',
  '[': 'DOWN', ']': 'RIGHT', '\\': 'CLEAR',
  // Dragon 200-E only: the Spanish legends that share a Dragon key (MAME's dragon200e_keyboard:
  // PORT_CHAR(0xC7) on '0', 0xA1 on DOWN, 0xBF on RIGHT, 0xA7 on SPACE, 0xFC on BREAK - all shifted - and
  // 0xD1 on ';' as the key's only character, so it is unshifted).
  'Ç': '0', '¡': 'DOWN', '¿': 'RIGHT', '§': 'SPACE', 'ü': 'BREAK',
};
const PLAIN_EXTRA = { 'Ñ': 'N_TILDE' };   // a 200-E key of its own, not a shifted legend
const PLAIN = new Set('0123456789:;,-./@ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

export function charToKeys(ch) {
  if (ch === '\n' || ch === '\r') return { key: 'ENTER', shift: false };
  if (ch === ' ') return { key: 'SPACE', shift: false };
  if (ch === '^') return { key: 'UP', shift: false };
  const u = ch.toUpperCase();
  if (PLAIN_EXTRA[u]) return { key: PLAIN_EXTRA[u], shift: false };
  if (PLAIN.has(u)) return { key: u, shift: false };
  if (SHIFTED[ch]) return { key: SHIFTED[ch], shift: true };
  return null;
};

export const keyboards = registry({
  dragon: positions([
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', ':', ';', ',', '-', '.', '/'],
    ['@', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'],
    ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'],
    ['X', 'Y', 'Z', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE'],
    ['ENTER', 'CLEAR', 'BREAK', null, null, null, null, 'SHIFT'],
  ]),
  // Dragon 200-E: the same matrix as the Dragon (MAME's dragon200e_keyboard is dragon_keyboard with new
  // legends). N-tilde is physical column 3 of row 1, where the Dragon's key is ';', and the two symbols
  // with no Dragon key of their own are the shifted up/down arrows (MAME: PORT_CHAR('_'), 0xA1).
  dragon200e: positions([
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', ':', 'N_TILDE', ',', '-', '.', '/'],
    ['@', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'],
    ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'],
    ['X', 'Y', 'Z', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE'],
    ['ENTER', 'CLEAR', 'BREAK', null, null, null, null, 'SHIFT'],
  ]),
  // CoCo 1/2; the CoCo 3 adds ALT, CTRL, F1 and F2 in row 6
  coco: positions([
    ['@', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'],
    ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'],
    ['X', 'Y', 'Z', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE'],
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', ':', ';', ',', '-', '.', '/'],
    ['ENTER', 'CLEAR', 'BREAK', 'ALT', 'CTRL', 'F1', 'F2', 'SHIFT'],
  ]),
  // Tandy MC-10: columns are the 6803 port 1 strobes, rows 0-5 read at $BFFF, row 6 on port 2 bit 1.
  // The arrow keys are CONTROL + A/S/W/Z, handled by the machine (js/machines/mc10.js).
  mc10: positions([
    ['@', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'],
    ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'],
    ['X', 'Y', 'Z', null, null, null, 'ENTER', 'SPACE'],
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', ':', ';', ',', '-', '.', '/'],
    ['CTRL', null, 'BREAK', null, null, null, null, 'SHIFT'],
  ]),
  // Matra Alice: MAME's mc10.cpp INPUT_PORTS_START( alice ), position for position (checked against the
  // ports a running alice exposes). Its matrix is keyed by the AZERTY legends: row 0 is '@ H P X 0 8 CTRL',
  // row 1 'Q I A Y 1 9', and the digits run down the columns rather than along a row as on the MC-10.
  // MAME's CONTROL is this machine's CTRL (the same key, UCHAR_SHIFT_2).
  alice: positions([
    ['@', 'Q', 'B', 'C', 'D', 'E', 'F', 'G'],
    ['H', 'I', 'J', 'K', 'L', '/', 'N', 'O'],
    ['P', 'A', 'R', 'S', 'T', 'U', 'V', 'Z'],
    ['X', 'Y', 'W', null, null, null, 'ENTER', 'SPACE'],
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', ':', 'M', ',', '-', '.', ';'],
    ['CTRL', null, 'BREAK', null, null, null, null, 'SHIFT'],
  ]),
});

/*
 * Positional keyboard maps: a browser KeyboardEvent.code (the physical key, independent of the OS layout)
 * -> the key at that position in the machine's matrix (the layouts above). Kept here with the matrices so
 * the two are read and changed together.
 *
 * Transcription, not invention. Every entry was read from MAME 0.264's input-port definitions of the same
 * keyboard, where a port names the matrix row and a bit the column for the Dragons and CoCos, and for the
 * MC-10 and Alice the port is the column strobe (port 1) and the bit the row read at $BFFF:
 *   dragon  src/mame/trs/dragon.cpp   INPUT_PORTS_START( dragon_keyboard )
 *   coco    src/mame/trs/coco3.cpp    INPUT_PORTS_START( coco3_keyboard )  (CoCo 1/2 and 3 share the shape)
 *   mc10    src/mame/trs/mc10.cpp     INPUT_PORTS_START( mc10 )
 *   alice   src/mame/trs/mc10.cpp     INPUT_PORTS_START( alice )
 * MAME binds a physical key to every position that has a legend in these matrices, and to no others, so an
 * entry naming a key that is not at that position is a mistake; tests/input.test.js checks every entry.
 */
export const positionalKeys = registry({
  dragon: {
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
    Minus: ':',
    Semicolon: ';',
    Comma: ',',
    Equal: '-',
    Period: '.',
    Slash: '/',
    BracketLeft: '@',
    KeyA: 'A',
    KeyB: 'B',
    KeyC: 'C',
    KeyD: 'D',
    KeyE: 'E',
    KeyF: 'F',
    KeyG: 'G',
    KeyH: 'H',
    KeyI: 'I',
    KeyJ: 'J',
    KeyK: 'K',
    KeyL: 'L',
    KeyM: 'M',
    KeyN: 'N',
    KeyO: 'O',
    KeyP: 'P',
    KeyQ: 'Q',
    KeyR: 'R',
    KeyS: 'S',
    KeyT: 'T',
    KeyU: 'U',
    KeyV: 'V',
    KeyW: 'W',
    KeyX: 'X',
    KeyY: 'Y',
    KeyZ: 'Z',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    Backspace: 'LEFT',
    ArrowRight: 'RIGHT',
    Space: 'SPACE',
    Enter: 'ENTER',
    Home: 'CLEAR',
    End: 'BREAK',
    Escape: 'BREAK',
    ShiftLeft: 'SHIFT',
    ShiftRight: 'SHIFT',
  },
  coco: {
    BracketLeft: '@',
    KeyA: 'A',
    KeyB: 'B',
    KeyC: 'C',
    KeyD: 'D',
    KeyE: 'E',
    KeyF: 'F',
    KeyG: 'G',
    KeyH: 'H',
    KeyI: 'I',
    KeyJ: 'J',
    KeyK: 'K',
    KeyL: 'L',
    KeyM: 'M',
    KeyN: 'N',
    KeyO: 'O',
    KeyP: 'P',
    KeyQ: 'Q',
    KeyR: 'R',
    KeyS: 'S',
    KeyT: 'T',
    KeyU: 'U',
    KeyV: 'V',
    KeyW: 'W',
    KeyX: 'X',
    KeyY: 'Y',
    KeyZ: 'Z',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    Backspace: 'LEFT',
    ArrowRight: 'RIGHT',
    Space: 'SPACE',
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
    Minus: ':',
    Semicolon: ';',
    Comma: ',',
    Equal: '-',
    Period: '.',
    Slash: '/',
    Enter: 'ENTER',
    Home: 'CLEAR',
    End: 'BREAK',
    Escape: 'BREAK',
    AltLeft: 'ALT',
    ControlLeft: 'CTRL',
    F1: 'F1',
    F2: 'F2',
    ShiftLeft: 'SHIFT',
    ShiftRight: 'SHIFT',
  },
  mc10: {
    BracketLeft: '@',
    KeyH: 'H',
    KeyP: 'P',
    KeyX: 'X',
    Digit0: '0',
    Digit8: '8',
    ShiftLeft: 'CTRL',
    KeyA: 'A',
    KeyI: 'I',
    KeyQ: 'Q',
    KeyY: 'Y',
    Digit1: '1',
    Digit9: '9',
    KeyB: 'B',
    KeyJ: 'J',
    KeyR: 'R',
    KeyZ: 'Z',
    Digit2: '2',
    Minus: ':',
    BracketRight: 'BREAK',
    KeyC: 'C',
    KeyK: 'K',
    KeyS: 'S',
    Digit3: '3',
    Semicolon: ';',
    KeyD: 'D',
    KeyL: 'L',
    KeyT: 'T',
    Digit4: '4',
    Comma: ',',
    KeyE: 'E',
    KeyM: 'M',
    KeyU: 'U',
    Digit5: '5',
    Equal: '-',
    KeyF: 'F',
    KeyN: 'N',
    KeyV: 'V',
    Enter: 'ENTER',
    Digit6: '6',
    Period: '.',
    KeyG: 'G',
    KeyO: 'O',
    KeyW: 'W',
    Space: 'SPACE',
    Digit7: '7',
    Slash: '/',
    ShiftRight: 'SHIFT',
  },
  alice: {
    BracketLeft: '@',
    KeyH: 'H',
    KeyP: 'P',
    KeyX: 'X',
    Digit0: '0',
    Digit8: '8',
    ShiftLeft: 'CTRL',
    KeyQ: 'Q',
    KeyI: 'I',
    KeyA: 'A',
    KeyY: 'Y',
    Digit1: '1',
    Digit9: '9',
    KeyB: 'B',
    KeyJ: 'J',
    KeyR: 'R',
    KeyW: 'W',
    Digit2: '2',
    Minus: ':',
    BracketRight: 'BREAK',
    KeyC: 'C',
    KeyK: 'K',
    KeyS: 'S',
    Digit3: '3',
    KeyM: 'M',
    KeyD: 'D',
    KeyL: 'L',
    KeyT: 'T',
    Digit4: '4',
    Comma: ',',
    KeyE: 'E',
    Slash: '/',
    KeyU: 'U',
    Digit5: '5',
    Equal: '-',
    KeyF: 'F',
    KeyN: 'N',
    KeyV: 'V',
    Enter: 'ENTER',
    Digit6: '6',
    Period: '.',
    KeyG: 'G',
    KeyO: 'O',
    KeyZ: 'Z',
    Space: 'SPACE',
    Digit7: '7',
    Semicolon: ';',
    ShiftRight: 'SHIFT',
  },
});
