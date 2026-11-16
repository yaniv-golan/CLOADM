/*
 * The serial port, in the Machine tab (a minimal control): the device on the CoCo's or
 * MC-10's bit-banger (printer, terminal, loopback plug) or on the Dragon 64's 6551 (nothing, terminal, loopback
 * plug), the terminal's baud rate, and the terminal itself: what the machine sends, and a line to type into (Enter
 * sends it, with a CR). The state lives in the Session (serialDevice, attachSerial, terminalText, serialSend,
 * clearTerminal).
 */
import { $ } from './page.js';
import { SERIAL_BAUDS } from '../session.js';

export function setupSerialPanel(page) {
  const { session } = page;
  const baud = $('selBaud');
  for (const b of SERIAL_BAUDS) { const o = document.createElement('option'); o.value = b; o.textContent = `${b} baud`; baud.append(o); }
  const LABELS = { none: 'Nothing', printer: 'Printer', terminal: 'Terminal', loopback: 'Loopback plug' };
  function show() {
    const d = session.serialDevice;
    $('serialSection').hidden = !d;
    if (!d) return;
    const sel = $('selSerial');
    if ([...sel.options].map((o) => o.value).join() !== d.kinds.join()) {
      sel.replaceChildren(...d.kinds.map((k) => { const o = document.createElement('option'); o.value = k; o.textContent = LABELS[k]; return o; }));
    }
    sel.value = d.kind;
    baud.value = String(d.baud);
    baud.disabled = d.kind !== 'terminal';
    $('terminalBox').hidden = d.kind !== 'terminal';
    $('terminal').textContent = session.terminalText();
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }
  const attach = () => page.attempt(() => session.attachSerial($('selSerial').value, { baud: Number(baud.value) }));
  $('selSerial').onchange = attach;
  baud.onchange = attach;
  $('termInput').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    page.attempt(() => { session.serialSend(e.target.value + '\n'); e.target.value = ''; });
  };
  $('btnTermClear').onclick = () => session.clearTerminal();
  session.on((ev) => { if (ev === 'serial' || ev === 'machine') show(); });
}
