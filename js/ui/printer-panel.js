/*
 * The printer, in the Machine tab (a minimal control): what the machine's printer has
 * received, as text, with Save (the bytes as received) and Clear. The printout lives in the Session
 * (Session.printout, printoutText, printoutFile, clearPrintout).
 */
import { $ } from './page.js';

export function setupPrinterPanel(page) {
  const { session } = page;
  function show() {
    const text = session.printoutText(), n = session.machine.printed.length;
    $('printout').textContent = text;
    $('printout').scrollTop = $('printout').scrollHeight;
    $('printState').textContent = n ? `${n} byte${n === 1 ? '' : 's'}` : 'nothing yet';
    $('btnPrintSave').disabled = !n;
    $('btnPrintClear').disabled = !n;
    const serial = session.serialDevice;
    $('printerKind').textContent = !serial || serial.chip === '6551' ? 'Parallel printer port'
      : serial.kind === 'printer' ? 'Serial printer on the RS-232 port, 600 baud' : 'Serial printer unplugged (see Serial port)';
  }
  $('btnPrintSave').onclick = () => page.attempt(() => { const f = session.printoutFile(); page.download(f.name, f.bytes); });
  $('btnPrintClear').onclick = () => session.clearPrintout();
  session.on((ev) => { if (ev === 'printer' || ev === 'machine' || ev === 'serial') show(); });
}
