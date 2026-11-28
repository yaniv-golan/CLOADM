/*
 * The printer, in the Machine tab (a minimal control): what the machine's printer has received, as text, its line
 * count, Save printout (the text as shown, a .txt with CR LF line ends) and Clear. The printout lives in the Session
 * (Session.printout, printoutText, printoutLines, printoutTextFile, printoutFile for the raw bytes, clearPrintout);
 * js/printout.js reads it as text.
 *
 * Rendering: only the text new since the last render is appended (PrintoutReader), and nothing is rendered while the
 * box is hidden (another tab, the drawer or the phone's Settings sheet closed, another page): it catches up when it
 * shows. A live update keeps the view at the end only if it was at the end (within about a line); scrolled up, the
 * view stays where the person put it. When the box comes into view it shows the end.
 *
 * The first time each machine (by model) prints text in a session while the box is out of sight, a toast says so, and its
 * Show opens Settings → Machine at the Printer box.
 */
import { $ } from './page.js';
import { PrintoutReader, hasVisible } from '../printout.js';

const PRINTED_TOAST = 'Printed to the printer';

export function setupPrinterPanel(page) {
  const { session } = page;
  const box = $('printout');
  const reader = new PrintoutReader();
  let pending = '', whole = true;      // text read but not yet in the box; whole: the box is to be rendered afresh
  let shownLines = null;               // the count the state and the buttons were last set for
  let wasShown = false;
  const toasted = new Set();           // the machines (model ids) the first-print toast has been for, this session
  const shown = () => box.getClientRects().length > 0;
  // within about one line of the end
  function atEnd() {
    const cs = getComputedStyle(box);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 16;
    return box.scrollHeight - box.scrollTop - box.clientHeight <= line + 1;
  }
  // the bytes new on the machine on screen, read (cheap: the new bytes only); added: whether a 'printer' event brought
  // them (a switch or a restore brings a printout that was printed before)
  function read(printed) {
    const r = reader.read(session.shownMachine.printed);
    if (r.fresh) { pending = reader.text; whole = true; } else pending += r.added;
    // (what this print added: a printout already there, from a snapshot or printed off screen, is not this print, and
    // a reset's $FF or a start-bit NUL alone is nothing to see)
    if (printed && hasVisible(r.added) && !toasted.has(session.shownMachine.id)) {
      toasted.add(session.shownMachine.id);
      // (in sight already, the box says it: no toast, and none later for this machine)
      if (!shown()) page.toast(PRINTED_TOAST, { action: { label: 'Show', run: reveal } });
    }
  }
  // the box brought up to date; toEnd: show the end whatever the scroll was
  function render(toEnd = false) {
    if (!shown() || (!toEnd && !whole && !pending && shownLines === reader.lines)) return;
    const follow = toEnd || whole || atEnd();
    if (whole) { box.textContent = pending; whole = false; }
    else if (pending) {
      const last = box.lastChild;
      if (last && last.nodeType === Node.TEXT_NODE) last.appendData(pending); else box.append(pending);
    }
    pending = '';
    if (follow) box.scrollTop = box.scrollHeight;
    const n = reader.lines;
    if (n !== shownLines) {
      shownLines = n;
      $('printState').textContent = n ? `${n} line${n === 1 ? '' : 's'}` : 'nothing yet';
      $('btnPrintSave').disabled = !n;
      $('btnPrintClear').disabled = !n;
    }
  }
  // what kind of printer the machine on screen has: follows the machine and the serial device, not the printout
  function kind() {
    const serial = session.serial.device;
    $('printerKind').textContent = !serial || serial.chip === '6551' ? 'Parallel printer port'
      : serial.kind === 'printer' ? 'Serial printer, 600 baud' : 'Not plugged in · choose Printer under Serial port';
  }
  // the toast's Show: Settings → Machine (the phone's Settings sheet, or the drawer's tab), at the Printer box, its end shown
  function reveal() {
    // (in the phone's sheet the heading goes to the top, so the printout's end shows under it; in the drawer, the
    // whole box comes into view where it fits, its heading first, the page moved no more than that)
    if (page.openSettings('tab-machine')) $('printerHeading').scrollIntoView({ block: 'start' });
    else { $('btnPrintSave').scrollIntoView({ block: 'nearest' }); $('printerHeading').scrollIntoView({ block: 'nearest' }); }
    box.focus({ preventScroll: true });
    render(true);
  }
  // the box comes into view (a tab, the drawer, a sheet, a page): rendered then, at the end. (A frame later: changing
  // the box inside the observer's own callback would resize what it observes.)
  new ResizeObserver(() => {
    const now = shown();
    if (now && !wasShown) requestAnimationFrame(() => render(true));
    wasShown = now;
  }).observe(box);
  $('btnPrintSave').onclick = () => page.attempt(() => { const f = session.printoutTextFile(); page.download(f.name, f.bytes); });
  $('btnPrintClear').onclick = () => session.clearPrintout();
  session.on((ev) => {
    // the 'printer' event reports any running machine's printout (a chat's BASIC session prints off screen too); the
    // box shows the machine on screen, and renders only what changed in its printout
    if (ev === 'printer') { read(true); render(); }
    else if (ev === 'machine' || ev === 'serial') { read(false); render(); kind(); }
  });
}
