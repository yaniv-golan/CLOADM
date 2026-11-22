/*
 * The serial port, in the Machine tab (a minimal control): the device on the CoCo's or
 * MC-10's bit-banger (printer, terminal, loopback plug) or on the Dragon 64's 6551 (nothing, terminal, loopback
 * plug), the terminal's baud rate, and the terminal itself: what the machine sends, and a line to type into (Enter
 * sends it, with a CR). The port lives in the Session (serial.device, serial.attach, serial.send); the terminal's
 * log is this panel's own: a subscriber (serial.subscribe) keeping what reached the terminal, emptied by Clear and
 * when another machine takes over.
 */
import { $ } from './page.js';
import { SERIAL_BAUDS } from '../session.js';
import { terminalText } from './terminal-text.js';

export function setupSerialPanel(page) {
  const { session } = page;
  const baud = $('selBaud');
  for (const b of SERIAL_BAUDS) { const o = document.createElement('option'); o.value = b; o.textContent = `${b} baud`; baud.append(o); }
  const LABELS = { none: 'Nothing', printer: 'Printer', terminal: 'Terminal', loopback: 'Loopback plug' };
  let log = [];                     // what the machine has sent to the terminal
  session.serial.subscribe({ tx: (bytes, info) => { if (info.device === 'terminal') { log.push(...bytes); show(); } } });
  function show() {
    const d = session.serial.device;
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
    $('terminal').textContent = terminalText(log);
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }
  const attach = () => page.attempt(() => session.serial.attach($('selSerial').value, { baud: Number(baud.value) }));
  $('selSerial').onchange = attach;
  baud.onchange = attach;
  $('termInput').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    page.attempt(() => { session.serial.send(e.target.value + '\n', { text: true }); e.target.value = ''; });
  };
  $('btnTermClear').onclick = () => { log = []; show(); };
  session.on((ev) => {
    if (ev === 'machine') log = [];
    if (ev === 'serial' || ev === 'machine') show();
  });
}
