/*
 * DriveWire to a real CoCo over a serial cable, through the browser's Web Serial API: the page is
 * the DriveWire server, as a PC running the DriveWire 4 server would be. Bytes from the port go to a
 * DriveWireServer (js/drivewire/server.js); what it answers goes back, once any sector it is reading or writing
 * from the store is done. The serial line is 8N1 ("Low Level Protocol"); the rate is whatever the CoCo's
 * driver was built for (the specification: "determined by the capabilities of the Guest and Host").
 *
 * `serial` is injected (navigator.serial by default) so the link can be tested with a mocked port. Real hardware
 * cannot be tested automatically; see docs/verification.md (Web Serial) for the manual steps.
 */
export const SERIAL_DW_BAUDS = [38400, 57600, 115200, 230400];

export const webSerialAvailable = (serial = globalThis.navigator && globalThis.navigator.serial) => !!serial;

export class SerialDriveWireLink {
  constructor(server, { serial = globalThis.navigator && globalThis.navigator.serial, onState = null } = {}) {
    this.server = server;
    this.serial = serial;
    this.onState = onState;      // (state: 'closed' | 'open' | 'error', detail) => void
    this.state = 'closed';
    this.port = null; this.reader = null; this.writer = null;
    this.bytesIn = 0; this.bytesOut = 0;
  }
  set(state, detail) { this.state = state; if (this.onState) this.onState(state, detail); }
  // ask the user for a port (needs a user gesture in a page) and open it at `baud`
  async open(baud) {
    if (!this.serial) throw new Error('This browser has no Web Serial (Chrome or Edge on a desktop has it).');
    if (!SERIAL_DW_BAUDS.includes(baud)) throw new Error(`${baud} baud is not offered (${SERIAL_DW_BAUDS.join(', ')}).`);
    const port = await this.serial.requestPort();
    await port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.server.resetLink();
    this.set('open', baud);
    this.done = this.pump();
    return this;
  }
  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const b of value) { this.server.receive(b); this.bytesIn++; while (this.server.busy) await this.server.busy; }
        if (this.server.available) {
          const out = Uint8Array.from(this.server.output.splice(0));
          this.bytesOut += out.length;
          await this.writer.write(out);
        }
      }
      if (this.state === 'open') this.set('closed');
    } catch (e) {
      if (this.state === 'open') this.set('error', e.message);
    }
  }
  async close() {
    if (this.state !== 'open') return;
    this.set('closed');
    try { await this.reader.cancel(); } catch (e) { /* already gone */ }
    try { this.reader.releaseLock(); this.writer.releaseLock(); await this.port.close(); } catch (e) { /* unplugged */ }
  }
}
