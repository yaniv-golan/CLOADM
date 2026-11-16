/*
 * The Becker port: a DriveWire link in the CoCo's I/O space, as MAME's coco_dwsock
 * (src/devices/bus/coco/coco_dwsock.cpp) maps it when its "Becker Port" setting is on (coco.cpp ff40_read /
 * ff40_write): $FF41 status (bit 1 set while the server has a byte for the guest; writes ignored), $FF42 data
 * (read: the next byte from the server; write: a byte to it). With no server, or nothing waiting, a data read
 * gives $5A, as MAME's does.
 *
 * The server (js/drivewire/server.js) answers at once, except while it reads or writes a sector in its store:
 * then the machine waits (Machine.waitFor) and runs on when the store has answered, so a program sees the same
 * thing however long the store takes.
 */
export class BeckerPort {
  constructor(machine) {
    this.machine = machine;
    this.server = null;
    this.pending = null;   // link state from a snapshot, waiting for a server
  }
  // connect a server (null: none); link state restored from a snapshot before it was connected is handed to it
  attach(server) {
    this.server = server;
    if (server && this.pending) {
      server.loadState(this.pending);
      this.pending = null;
    }
  }
  readIO(reg) {
    const s = this.server;
    if (reg === 0) return s && s.available ? 0x02 : 0x00;
    return s && s.available ? s.read() : 0x5A;
  }
  writeIO(reg, v) {
    const s = this.server;
    if (reg !== 1 || !s) return;
    s.receive(v);
    if (s.busy) this.machine.waitFor(s.busy);
  }
  // the server's link state (what is in flight); its drives are the host's configuration, not the machine's
  saveState() { return this.server ? this.server.saveState() : null; }
  loadState(s) {
    this.pending = null;
    if (s && this.server) this.server.loadState(s); else this.pending = s;
  }
}
