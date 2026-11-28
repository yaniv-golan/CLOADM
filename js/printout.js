/*
 * A printout as text: what the printer received (a machine's `printed` bytes) as a person reads it. No DOM, so the
 * page's Printer box (js/ui/printer-panel.js) and the Session (Session.printoutText, printoutLines, printoutTextFile)
 * share one reading of the bytes, and Node tests run it.
 *
 * The text: printable ASCII and TAB; CR, LF and CR LF end lines. Control characters and bytes from $80 up
 * (printer-specific codes and graphics; a Dragon's reset sends $FF, see sam.js; a CoCo's serial printer can take a
 * start bit as a NUL) are left out. The raw bytes keep them (Session.printoutFile).
 */

// the text of bytes[from..]: { text, afterCR }. afterCR: the last byte read was a CR, so an LF that comes next (in
// this call or the next one, from `from` on) ends no second line. Reading a printout in pieces, each piece from where
// the last ended with the last's afterCR, gives exactly the text of reading it all at once.
export function printoutText(bytes, from = 0, afterCR = false) {
  let text = '';
  for (let i = from; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 10 && afterCR) { afterCR = false; continue; }
    afterCR = c === 13;
    if (c === 13 || c === 10) text += '\n';
    else if (c === 9 || (c >= 32 && c < 127)) text += String.fromCharCode(c);
  }
  return { text, afterCR };
}

// whether text has anything to see: a character other than a space, a TAB or a line end
const VISIBLE = /[^\s]/;
export const hasVisible = (text) => VISIBLE.test(text);

// the lines of text as shown: each line end ends one, and text after the last line end is one more. 0 when there is
// nothing to see (empty lines alone, spaces, or bytes that are not text at all).
export function printoutLines(text) {
  if (!hasVisible(text)) return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}

// the text as a .txt file: CR LF line ends, plain ASCII (printoutText gives nothing else)
export const printoutTxt = (text) => Uint8Array.from(text.replace(/\n/g, '\r\n'), (ch) => ch.charCodeAt(0));

// A printout read as it grows: read(printed) takes the bytes added since the last read, and starts over when the
// printout is a different one (another machine's, a snapshot's: another array) or has shrunk (Clear). Each read is
// the cost of the new bytes only. It keeps the whole text, its line count and whether it has anything to see.
export class PrintoutReader {
  constructor() { this.reset(null); }
  reset(source) {
    this.source = source; this.bytes = 0; this.afterCR = false;
    this.text = ''; this.newlines = 0; this.visible = false;
  }
  // -> { fresh: started over (the text is all new: render it whole), replaced: another printout (another array, not
  // this one cleared; the first read of a new reader is not one), added: the text new since the last read (all of it after a Clear; none for another printout,
  // which was printed before, not now) }
  read(printed) {
    let fresh = false, replaced = false;
    if (printed !== this.source || printed.length < this.bytes) { replaced = this.source !== null && printed !== this.source; this.reset(printed); fresh = true; }
    if (printed.length === this.bytes) return { fresh, replaced, added: '' };
    const { text, afterCR } = printoutText(printed, this.bytes, this.afterCR);
    this.bytes = printed.length; this.afterCR = afterCR;
    this.text += text;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.newlines++;
    if (!this.visible && hasVisible(text)) this.visible = true;
    return { fresh, replaced, added: replaced ? '' : text };
  }
  // printoutLines(this.text), kept as the text grows
  get lines() { return this.visible ? this.newlines + (this.text.endsWith('\n') ? 0 : 1) : 0; }
}
