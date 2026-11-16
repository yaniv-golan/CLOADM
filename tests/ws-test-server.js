// A minimal WebSocket server for tests (RFC 6455: the handshake, unfragmented binary and text frames, close),
// so the DriveWire channel bridge can be tested against a real socket without a dependency.
// startWsServer(onConnection) -> { url, close() }; onConnection(conn) gets { send(bytes|string), close(),
// onMessage: (Uint8Array) => void, onClose: () => void }.
const http = require('http'), crypto = require('crypto');

function startWsServer(onConnection) {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  const sockets = new Set();
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(sock);
    const frame = (op, payload) => {
      const n = payload.length, head = n < 126 ? Buffer.from([0x80 | op, n]) : Buffer.from([0x80 | op, 126, n >> 8, n & 0xFF]);
      sock.write(Buffer.concat([head, payload]));
    };
    const conn = {
      send: (data) => (typeof data === 'string' ? frame(1, Buffer.from(data, 'utf8')) : frame(2, Buffer.from(data))),
      close: () => { frame(8, Buffer.alloc(0)); sock.end(); },
      onMessage: null, onClose: null,
    };
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0F, masked = buf[1] & 0x80;
        let n = buf[1] & 0x7F, at = 2;
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
        else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
        const need = at + (masked ? 4 : 0) + n;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        const payload = Buffer.from(buf.subarray(at + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(need);
        if (op === 8) { sock.end(); return; }
        if ((op === 1 || op === 2) && conn.onMessage) conn.onMessage(new Uint8Array(payload));
      }
    });
    sock.on('close', () => { sockets.delete(sock); if (conn.onClose) conn.onClose(); });
    sock.on('error', () => {});
    onConnection(conn);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${server.address().port}/`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}
module.exports = { startWsServer };
