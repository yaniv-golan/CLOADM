/*
 * A DriveWire virtual serial channel carried over a WebSocket (the Claude chat builds on it). What the
 * guest writes on the channel is sent as binary messages; what the socket receives is queued for the guest
 * (js/drivewire/server.js channelSend), text as UTF-8. Bytes from the socket wait here until the guest has
 * opened the channel and while its queue in the server is full: the bridge hands over only what fits
 * (channelRoom) and the rest when the guest has read some (deliver, called on the server's onChannelRead).
 * A WebSocket cannot be told to stop receiving, so what waits here is capped too (TO_GUEST_MAX); past that,
 * bytes are dropped and counted (`dropped`, reported through onState). Bytes from the guest wait until the
 * socket is open. When the socket closes, the channel is closed from the host side, so the guest's next SERREAD
 * reports it.
 *
 * WebSocket is injected (the browser's by default; Node 22 has the same global), so this module is testable
 * without a page.
 */
import { ByteQueue } from '../drivewire/byte-queue.js';

export const TO_GUEST_MAX = 1 << 20;   // bytes waiting here for a guest that is behind

export class DriveWireSocket {
  constructor(server, channel, url, { WebSocket = globalThis.WebSocket, onState = null } = {}) {
    if (!WebSocket) throw new Error('WebSockets are not available here');
    this.server = server;
    this.channel = channel;
    this.url = url;
    this.onState = onState;          // (state: 'connecting' | 'open' | 'closed', detail) => void
    this.toGuest = new ByteQueue();  // from the socket, until the guest has room for it
    this.toSocket = [];              // from the guest, before the socket opened
    this.dropped = 0;                // bytes from the socket dropped because the guest was too far behind
    this.state = 'connecting';
    const ws = this.ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.set('open');
      if (this.toSocket.length) { ws.send(Uint8Array.from(this.toSocket)); this.toSocket = []; }
    };
    ws.onmessage = (e) => {
      const bytes = typeof e.data === 'string' ? new TextEncoder().encode(e.data) : new Uint8Array(e.data);
      const n = this.toGuest.push(bytes, TO_GUEST_MAX);
      if (n < bytes.length) { this.dropped += bytes.length - n; this.set(this.state, `${this.dropped} bytes dropped: the guest is behind`); }
      this.deliver();
    };
    ws.onclose = (e) => {
      const was = this.state;
      this.set('closed', e && e.code);
      if (was !== 'closed') this.server.closeChannel(this.channel, true);
    };
    ws.onerror = () => {};
  }
  set(state, detail) { this.state = state; if (this.onState) this.onState(state, detail); }
  // what came from the socket goes to the guest, as much as its queue has room for (called when the guest opens the
  // channel, when the socket sends, and when the guest has read some)
  deliver() {
    const n = Math.min(this.server.channelRoom(this.channel), this.toGuest.length);
    if (n) this.server.channelSend(this.channel, this.toGuest.take(n));
  }
  // bytes the guest wrote on the channel
  send(bytes) {
    if (this.state === 'open') this.ws.send(Uint8Array.from(bytes));
    else if (this.state === 'connecting') for (const b of bytes) this.toSocket.push(b);
  }
  close() { if (this.state !== 'closed') { this.state = 'closed'; this.ws.close(); this.set('closed'); } }
}
