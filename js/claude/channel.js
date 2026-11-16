/*
 * The narrow byte channel between the chat firmware and the backend.
 *
 * The firmware sends a line of bytes as the person types and reads the reply as bytes; DriveWire
 * will carry those bytes on an emulated machine and to real hardware over Web Serial. MemoryChannel carries
 * them inside the page until that branch lands, and DriveWireChatChannel (below) carries them on a DriveWire
 * virtual serial channel once it does.
 *
 * MemoryChannel follows the DriveWireChannel contract exactly (cloadm-6-drivewire,
 * js/media/drivewire.js), so swapping in DriveWire later is a one-file change and there is one vocabulary:
 *   onReceive(bytes | null)   what the machine sent (null: the channel closed)
 *   send(bytes) -> {accepted, queued}   bytes toward the machine; never blocks or drops, queues up to capacity
 *   ready()                   a promise that resolves when there is room again
 *   close()                   idempotent; fires onReceive(null) once
 *   queued / room / canSend / closed, and DEFAULT_CHANNEL_CAPACITY
 * Shape and naming also match the serial branch's precedent (js/machines/rs232.js): a push callback for bytes
 * from the machine, explicit byte arrays, no promise on the receive path, so an emulated and a real machine
 * work the same way.
 *
 * The firmware side is poll-shaped (it reads a status byte each frame), so MemoryChannel also offers poll()
 * and read(), which Drain the bytes the backend sent. DriveWire's SERREAD does the same job on a real machine.
 */
export const DEFAULT_CHANNEL_CAPACITY = 65536;
// the DriveWire virtual serial channel the chat firmware opens (examples/chat.asm DWCH)
export const CHAT_DW_CHANNEL = 14;

export class MemoryChannel {
  constructor(capacity = DEFAULT_CHANNEL_CAPACITY) {
    this.capacity = capacity;
    this.rx = [];             // bytes waiting for the machine
    this.onReceive = null;    // (bytes | null) -> void: what the machine sent
    this.closed = false;
    this._ready = [];         // resolvers waiting for room
  }
  get queued() { return this.rx.length; }
  get canSend() { return !this.closed && this.rx.length < this.capacity; }
  get room() { return this.closed ? 0 : this.capacity - this.rx.length; }
  // bytes toward the machine
  send(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (this.closed) return { accepted: false, queued: this.rx.length };
    const take = Math.min(this.capacity - this.rx.length, data.length);
    for (let i = 0; i < take; i++) this.rx.push(data[i]);
    return { accepted: take === data.length, queued: this.rx.length };
  }
  ready() {
    if (this.closed || this.rx.length < this.capacity) return Promise.resolve();
    return new Promise((resolve) => this._ready.push(resolve));
  }
  // bytes from the machine (the firmware wrote them): hand them to the host
  fromMachine(bytes) {
    if (this.closed) return;
    if (this.onReceive) this.onReceive(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }
  // the firmware's read side: the next byte toward the machine, or null. Taking a byte is what SERREAD does,
  // so it makes room and wakes anyone waiting in ready().
  poll() {
    if (!this.rx.length) return null;
    const b = this.rx.shift();
    this._wake();
    return b;
  }
  // everything waiting for the machine, as one block
  read() { const q = Uint8Array.from(this.rx); this.rx.length = 0; this._wake(); return q; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.rx = [];
    this._wake();
    if (this.onReceive) this.onReceive(null);
  }
  _wake() { for (const r of this._ready.splice(0)) r(); }
}

// The same channel, carried by a DriveWire virtual serial channel. It has the vocabulary
// above, so the chat cannot tell the two apart; the bytes live in the server's per-channel queue, which is
// what the guest's SERREAD takes and what channelSend fills.
//
// The server's callbacks belong to whoever owns the server (the Session wires them for its DriveWire panel),
// so this adapter wraps them: it saves the existing callback, runs it, then takes the traffic for its own
// channel. Replacing them would silently cut the panel off.
//
// Bytes sent before the guest opens the channel wait in `held`: channelSend throws unless the guest opened
// it, and losing a reply in flight would be worse than holding it.
export class DriveWireChatChannel {
  constructor(server, channel, { capacity = DEFAULT_CHANNEL_CAPACITY } = {}) {
    if (!(Number.isInteger(channel) && channel >= 0 && channel < 15)) throw new RangeError(`DriveWire channels are 0-14; ${channel} is not one`);
    this.server = server;
    this.channel = channel;
    this.capacity = capacity;
    this.held = [];           // bytes toward the machine, before the guest opens the channel
    this.onReceive = null;    // (bytes | null) -> void: what the machine sent
    this.closed = false;
    this._ready = [];         // resolvers waiting for room
    const s = server;
    this._saved = { open: s.onChannelOpen, close: s.onChannelClose, data: s.onChannelData, read: s.onChannelRead };
    s.onChannelOpen = (ch) => {
      if (this._saved.open) this._saved.open(ch);
      if (ch === this.channel) this.deliver();
    };
    s.onChannelClose = (ch) => {
      if (this._saved.close) this._saved.close(ch);
      if (ch === this.channel) this.remoteClosed();
    };
    s.onChannelData = (ch, bytes) => {
      if (this._saved.data) this._saved.data(ch, bytes);
      if (ch === this.channel && this.onReceive) this.onReceive(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    };
    // the guest took bytes out of the queue, which makes room: send it what has been waiting
    s.onChannelRead = (ch) => {
      if (this._saved.read) this._saved.read(ch);
      if (ch === this.channel) this.deliver();
    };
  }
  get open() { const c = this.server.channels[this.channel]; return !!c && c.open; }
  // everything still on its way to the machine: staged here plus already in the server's queue
  get queued() { const c = this.server.channels[this.channel]; return this.held.length + (c ? c.queue.length : 0); }
  get canSend() { return !this.closed && this.held.length < this.capacity; }
  get room() { return this.closed ? 0 : Math.max(0, this.capacity - this.held.length); }
  // How much the server will actually take right now. The server caps each channel (64 KB) and drops what
  // does not fit, so asking it first is the difference between staging the remainder and losing it.
  serverRoom() {
    if (!this.open) return 0;
    if (typeof this.server.channelRoom === 'function') return this.server.channelRoom(this.channel);
    const c = this.server.channels[this.channel];
    return c ? Math.max(0, 0x10000 - c.queue.length) : 0;
  }
  // Bytes toward the machine. `capacity` bounds this adapter's staging buffer (`held`), not the server's
  // queue: the queue is the server's own 64 KB and the guest drains it. What the server has no room for is
  // staged and handed over on the next onChannelRead (or onChannelOpen), so a reply larger than the room left
  // in the queue waits instead of being truncated by the server. `taken` is what the server took now,
  // `queued` is everything still on its way, and `accepted` says the whole call was accepted (moved or staged).
  send(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (this.closed) return { accepted: false, taken: 0, queued: this.queued };
    const fits = Math.max(0, Math.min(this.capacity - this.held.length, data.length));
    for (let i = 0; i < fits; i++) this.held.push(data[i]);
    const taken = this.deliver();
    return { accepted: fits === data.length, taken, queued: this.queued };
  }
  ready() {
    if (this.closed || this.queued < this.capacity) return Promise.resolve();
    return new Promise((resolve) => this._ready.push(resolve));
  }
  // Hand the server as much of `held` as it will take: on the guest opening the channel, and again whenever
  // the guest reads (which is what makes room). Returns how many bytes moved.
  deliver() {
    if (!this.held.length || !this.open) return 0;
    const room = this.serverRoom();
    if (room <= 0) return 0;
    const n = Math.min(room, this.held.length);
    const chunk = Uint8Array.from(this.held.slice(0, n));
    const took = this.server.channelSend(this.channel, chunk);
    // the server returns the count it took; trust it over our own arithmetic
    const moved = typeof took === 'number' ? took : n;
    this.held.splice(0, moved);
    this._wake();
    return moved;
  }
  // the guest closed the channel: the chat learns it once, as null
  remoteClosed() {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    this._wake();
    if (this.onReceive) this.onReceive(null);
  }
  // the chat closes it: the guest learns it on its next SERREAD (byHost), and nothing is reported back
  close() {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    this._wake();
    this.server.closeChannel(this.channel, true);
  }
  _wake() { for (const r of this._ready.splice(0)) r(); }
}
