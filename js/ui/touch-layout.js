/*
 * The on-screen keys' layout and what each key sends, without a DOM: shared by the page's panel (js/ui/touch-keys.js)
 * and the side-panel connector's view (connector/view/touch.js), so both type the same keys the same way.
 */
import { charToKeys } from '../machines/keyboards.js';

// label -> machine key name, and the code the stub reads (ASCII; the arrows as BASIC's codes)
export const SPECIAL = Object.freeze({
  '↑': ['UP', 94], '↓': ['DOWN', 10], '←': ['LEFT', 8], ENTER: ['ENTER', 13], SPACE: ['SPACE', 32],
  BREAK: ['BREAK', 3], CLEAR: ['CLEAR', 12],
});
// the character SHIFT + key types (the Dragon layout's shifted symbols), for the stub
export const SHIFTED = {};
for (let c = 32; c < 127; c++) { const ch = String.fromCharCode(c), k = charToKeys(ch); if (k && k.shift && !SHIFTED[k.key]) SHIFTED[k.key] = ch; }
Object.freeze(SHIFTED);

// the split thumb keyboard (a phone held sideways) and the ten-column one; '_' is the space bar
export const SPLIT = Object.freeze({
  left: ['1 2 3 4 5 6', '↑ Q W E R T', '↓ A S D F G', 'SHIFT Z X C V B', '_'],
  right: ['7 8 9 0 : -', 'Y U I O P @', 'H J K L ; ENTER', 'N M , . / ←', '_ SHIFT'],
});
export const FULL = Object.freeze(['1 2 3 4 5 6 7 8 9 0', 'Q W E R T Y U I O P', 'A S D F G H J K L ;', 'Z X C V B N M , . /', 'SHIFT ↑ ↓ ← _ : - @ ENTER']);
// joystick mode's key strip: the keys a game that asks "PRESS Y OR N" wants, and the space bar most use to
// start; ABC opens the full keyboard for one key, then back to the stick
export const STRIP = Object.freeze(['SPACE', 'ENTER', 'BREAK', '1', '2', 'Y', 'N', 'ABC']);
export const SHORT = Object.freeze({ SPACE: 'SPC', ENTER: 'ENT', BREAK: 'BRK' });
// a key is committed when the finger lifts, or after HOLD_MS still; moving MOVE_PX first cancels it
export const HOLD_MS = 100, MOVE_PX = 10;

// What a key sends: the machine key names (SHIFT first while SHIFT is on) and the code the no-ROM stub reads.
// label is a key's label ('_' is SPACE). -> { names, code }
export function keyPress(label, shift = false) {
  const t = label === '_' ? 'SPACE' : label;
  const sp = SPECIAL[t], name = sp ? sp[0] : t;
  let code = sp ? sp[1] : t.charCodeAt(0);
  if (shift && !sp && SHIFTED[name]) code = SHIFTED[name].charCodeAt(0);
  return { names: shift ? ['SHIFT', name] : [name], code };
}
