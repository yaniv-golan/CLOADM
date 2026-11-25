/*
 * The device on a machine's bit-banger serial port (the CoCo's and the MC-10's RS-232 port): what the machine's
 * transmit line reaches, and what drives its receive line. The machine calls txd(at, level) when it changes its
 * output and rxd(at) when it reads its input; at = machine ticks.
 *
 *   none      nothing plugged in (the Dragon 64's serial port by default): RXD at mark, and CTS, DSR and DCD idle high (not
 *             asserted), as MAME's dragon64 fits no RS-232 device by default: the 6551 status reads DSR and DCD set and
 *             never TDRE (CTS high masks it), and a byte written goes nowhere
 *   printer   a serial printer, 600 baud 8N1 (MAME's default for these machines, rs_printer); what it receives
 *             goes to onPrint (the machine's printout); its RXD output is 0 (rs232/printer.cpp:
 *             m_initial_rx_state = 0)
 *   loopback  RXD follows TXD (MAME rs232/loopback.cpp). Its handshake lines (CTS, DSR, DCD) follow RTS and DTR,
 *             which none of these ports wires out, so they stay high (not asserted) - unless the plug holds them
 *             asserted ({ handshake: 'asserted' }, as MAME's patch box wired that way: the Dragon 64's ACIA, whose
 *             RTS and DTR MAME's dragon64 does not connect, can only transmit with CTS asserted)
 *   terminal  bytes both ways at `baud`, 8N1: what the machine sends is received (the listeners' tx), and
 *             send(bytes) queues bytes the line then carries to the machine, one after another
 *
 * Listeners (`listeners`, a Set of { tx(byte, at), rx(byte, at) }, either optional) see the bytes that cross the
 * wire, in the order the listeners were added: tx a byte the machine sent, decoded by the printer's or the terminal's
 * receiver (at: the tick of its last sample, the middle of the stop bit); rx a byte the terminal sent, once its stop
 * bit has ended (at: that tick), found when the machine reads its RXD (rxd) or the port is flushed. The loopback and
 * 'none' decode nothing, so they have nothing to tell.
 *
 * Nothing here schedules events: levels are worked out from times, so a device cannot change the machine's
 * timing.
 */
import { SerialRx } from './serial.js';

export const SERIAL_DEVICES = ['none', 'printer', 'loopback', 'terminal'];
const PRINTER_BAUD = 600;

export class SerialPort {
  // tickHz: machine ticks per second; onPrint(byte): a byte for the printer
  constructor(tickHz, onPrint) {
    this.tickHz = tickHz;
    this.onPrint = onPrint;
    this.listeners = new Set();  // { tx(byte, at), rx(byte, at) }: the bytes that cross the wire (not state)
    this.attach('printer');
  }
  // plug in a device: 'none', 'printer', 'loopback' (with { handshake: 'open' | 'asserted' }) or 'terminal' (with
  // { baud })
  attach(kind, { baud = 9600, handshake = 'open' } = {}) {
    if (!SERIAL_DEVICES.includes(kind)) throw new Error(`no serial device "${kind}"`);
    this.kind = kind;
    this.handshake = kind === 'loopback' ? handshake : null;
    this.baud = kind === 'printer' ? PRINTER_BAUD : baud;
    this.line = 1;                                  // the machine's TXD level
    this.queue = [];                                // terminal: bytes being sent to the machine, in order
    this.txStart = 0;                               // terminal: tick queue[0]'s start bit began
    this.rx = kind === 'loopback' || kind === 'none' ? null : new SerialRx(this.tickHz / this.baud,
      (b, at) => { if (this.kind === 'printer') this.onPrint(b); for (const l of this.listeners) if (l.tx) l.tx(b, at); });
  }
  get ticksPerBit() { return this.tickHz / this.baud; }
  // the DCD (carrier detect) level the device gives from reset: the printer and a terminal (MAME's null modem) drive
  // it low (rs232/printer.cpp, null_modem.cpp: output_dcd(0)); the loopback drives it only from DTR, which these
  // ports do not have, so it stays high; with nothing plugged in nothing drives it, so it stays high
  get dcd() { return this.kind === 'none' || (this.kind === 'loopback' && this.handshake === 'open') ? 1 : 0; }
  get dsr() { return this.dcd; }
  // CTS (the MC-10 reads it as "printer ready"): low from the printer or a terminal (output_cts(0)); the loopback
  // drives it only from RTS, which these ports do not have, so it stays high; with nothing plugged in, high
  get cts() { return this.kind === 'none' || (this.kind === 'loopback' && this.handshake === 'open') ? 1 : 0; }
  txd(at, level) {
    this.line = level;
    if (this.rx) this.rx.write(at, level);
  }
  // the machine's RXD at tick `at`
  rxd(at) {
    if (this.kind === 'printer') return 0;
    if (this.kind === 'none') return 1;
    if (this.kind === 'loopback') return this.line;
    // terminal: the queued bytes back to back, each a start bit, 8 data bits (least significant first), a stop bit
    const bit = this.ticksPerBit;
    while (this.queue.length && at >= this.txStart + 10 * bit) {
      const b = this.queue.shift();
      this.txStart += 10 * bit;
      this.onDelivered(b, this.txStart);
    }
    if (!this.queue.length || at < this.txStart) return 1;
    const k = Math.floor((at - this.txStart) / bit);
    return k === 0 ? 0 : k <= 8 ? (this.queue[0] >> (k - 1)) & 1 : 1;
  }
  // terminal: queue bytes for the machine; the first starts at tick `at` (or when the one before ends)
  send(bytes, at) {
    if (this.kind !== 'terminal') throw new Error('only a terminal sends');
    this.rxd(at);                                   // drop the bytes already sent by now
    if (!this.queue.length) this.txStart = at;
    this.queue.push(...bytes);
  }
  // a byte has crossed the wire into the machine: its stop bit ended at tick `at`
  onDelivered(byte, at) { for (const l of this.listeners) if (l.rx) l.rx(byte, at); }
  // decode what the machine has completely sent by tick `now`, and hand on what has reached it by then
  flush(now) {
    if (this.rx) this.rx.flush(now);
    if (this.kind === 'terminal') this.rxd(now);
  }
  saveState() {
    return { kind: this.kind, baud: this.baud, handshake: this.handshake, line: this.line, queue: this.queue.slice(), txStart: this.txStart,
      rx: this.rx ? this.rx.saveState() : null };
  }
  loadState(s) {
    this.attach(s.kind, { baud: s.baud, handshake: s.handshake || 'open' });
    this.line = s.line; this.queue = s.queue.slice(); this.txStart = s.txStart;
    if (this.rx) this.rx.loadState(s.rx);
  }
}
