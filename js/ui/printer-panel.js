/*
 * The printer, in the Machine tab (a minimal control): what the machine's printer has
 * received, as text, with Save (the bytes as received) and Clear. The printout lives in the Session
 * (Session.printout, printoutText, printoutFile, clearPrintout).
 */
import { $ } from './page.js';

export function setupPrinterPanel(page) {
  const { session } = page;
  let shownText = null, shownCount = null;
  function show(ev) {
    // the printout, the byte count and the buttons: re-rendered (and scrolled to the end) only when the
    // printout changed. The 'printer' event reports any running machine's printout (a chat's BASIC session
    // prints off screen too), but the panel shows the machine on screen: when its printout did not change,
    // the scroll stays where the person put it. The byte count is part of the change (bytes that render as
    // nothing, like a Dragon's reset $FF, still count).
    const text = session.printoutText(), n = session.shownMachine.printed.length;
    if (text !== shownText || n !== shownCount) {
      shownText = text; shownCount = n;
      $('printout').textContent = text;
      $('printout').scrollTop = $('printout').scrollHeight;
      $('printState').textContent = n ? `${n} byte${n === 1 ? '' : 's'}` : 'nothing yet';
      $('btnPrintSave').disabled = !n;
      $('btnPrintClear').disabled = !n;
    }
    // what kind of printer the machine on screen has: follows the machine and the serial device, not the
    // printout (a machine switch changes it with nothing printed)
    if (ev !== 'printer') {
      const serial = session.serial.device;
      $('printerKind').textContent = !serial || serial.chip === '6551' ? 'Parallel printer port'
        : serial.kind === 'printer' ? 'Serial printer on the RS-232 port, 600 baud' : 'Serial printer unplugged (see Serial port)';
    }
  }
  $('btnPrintSave').onclick = () => page.attempt(() => { const f = session.printoutFile(); page.download(f.name, f.bytes); });
  $('btnPrintClear').onclick = () => session.clearPrintout();
  session.on((ev) => { if (ev === 'printer' || ev === 'machine' || ev === 'serial') show(ev); });
}
