/*
 * The serial terminal's text (the serial panel, js/ui/serial-panel.js): no DOM, so Node tests import it as it is.
 */
// What a terminal shows of the bytes it received, as text: 7-bit characters; CR, LF and CR LF end lines; a
// backspace takes the last character back.
export function terminalText(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] & 0x7F;
    if (c === 13) { out += '\n'; if ((bytes[i + 1] & 0x7F) === 10) i++; }
    else if (c === 10) out += '\n';
    else if (c === 8) out = out.slice(0, -1);
    else if (c === 9 || c >= 32) out += String.fromCharCode(c);
  }
  return out;
}
