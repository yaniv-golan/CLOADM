// Run: node tests/claude-drivewire.test.js
//
// The chat on a DriveWire virtual serial channel. The chat side keeps the narrow
// byte-channel vocabulary it already uses (js/claude/channel.js: send() toward the machine, onReceive() from
// it, close(), queued/room/canSend/closed), and this adapter carries those bytes on a DriveWire channel of
// the server's documented interface:
//
//   server.onChannelOpen   (channel) => void            the guest opened the channel
//   server.onChannelClose  (channel) => void            the guest closed it
//   server.onChannelData   (channel, bytes) => void     the guest wrote to it
//   server.channelSend(channel, bytes)                  host -> guest; throws unless the guest opened it
//   server.closeChannel(channel, byHost)                close it (byHost: the guest learns it on SERREAD)
//   server.channels[channel].open                       whether the guest has it open
//
// The expected behaviour is written from that interface and the chat's own channel contract, not from the
// adapter: a byte the guest writes must reach the chat unchanged; a byte the chat sends must reach the guest's
// queue unchanged; bytes sent before the guest opens the channel must not be lost; and the adapter must not
// take over the server's callbacks, because the Session's DriveWire panel sets them too.
//
// The last section drives the REAL server (js/drivewire/server.js) the way a guest
// does: SERINIT, SERWRITE, SERREAD, SERREADM, SERTERM. That is the half the fake cannot prove - the 64 KB
// queue, the count channelSend returns and the onChannelRead the server actually fires.
const Emu = require('./load')();
const { DriveWireServer, CHANNEL_QUEUE_MAX } = require('../js/drivewire/server.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const CH = 3;

// A fake DriveWire server with exactly the channel interface the adapter is written against. Its queue and
// open flag are the server's (js/drivewire/server.js keeps them on channels[ch]), so the adapter can be
// checked against what the guest would actually see without pulling the server in.
//
// The 64 KB cap is the server's too: channelSend returns how many bytes it took, drops the rest and logs it,
// channelRoom says how much fits, and onChannelRead fires when the guest takes bytes out of the queue.
function fakeServer({ cap = 0x10000 } = {}) {
  const s = {
    onChannelOpen: null, onChannelClose: null, onChannelData: null, onChannelRead: null,
    channels: Array.from({ length: 15 }, () => ({ open: false, queue: [] })),
    log: [],
    channelRoom(ch) { const c = s.channels[ch]; return c ? Math.max(0, cap - c.queue.length) : 0; },
    channelSend(ch, bytes) {
      const c = s.channels[ch];
      if (!c || !c.open) throw new Error(`DriveWire channel ${ch} is not open`);
      const take = Math.max(0, Math.min(s.channelRoom(ch), bytes.length));
      c.queue.push(...bytes.slice(0, take));
      if (take < bytes.length) s.log.push({ dropped: bytes.length - take });
      return take;
    },
    closeChannel(ch, byHost = true) {
      const c = s.channels[ch];
      if (!c || !c.open) return false;
      c.open = false; c.queue = [];
      if (!byHost && s.onChannelClose) s.onChannelClose(ch);
      return true;
    },
    // what the guest does: SERINIT / SERTERM / SERWRITE / SERREAD
    guestOpen(ch) { s.channels[ch].open = true; if (s.onChannelOpen) s.onChannelOpen(ch); },
    guestClose(ch) { s.channels[ch].open = false; s.channels[ch].queue = []; if (s.onChannelClose) s.onChannelClose(ch); },
    guestWrite(ch, bytes) { if (s.channels[ch].open && s.onChannelData) s.onChannelData(ch, Uint8Array.from(bytes)); },
    guestRead(ch, n = 1) {
      const c = s.channels[ch];
      const out = c.queue.splice(0, n);
      if (s.onChannelRead) s.onChannelRead(ch);
      return out;
    },
  };
  return s;
}

// ---- 1. bytes the guest writes reach the chat unchanged ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  const got = [];
  // onReceive takes a block, as MemoryChannel.fromMachine does (the server hands over a SERWRITE's bytes)
  channel.onReceive = (b) => got.push(...b);
  server.guestOpen(CH);
  server.guestWrite(CH, [72, 105, 13]);
  check('bytes the guest writes reach the chat unchanged', JSON.stringify(got) === JSON.stringify([72, 105, 13]), JSON.stringify(got));
}

// ---- 2. bytes the chat sends reach the guest's queue unchanged ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  server.guestOpen(CH);
  const r = channel.send(Uint8Array.of(65, 66, 67));
  check('bytes the chat sends reach the guest queue unchanged', JSON.stringify(server.channels[CH].queue) === JSON.stringify([65, 66, 67]), JSON.stringify(server.channels[CH].queue));
  check('send reports what it took', r.accepted === true && r.queued === 3, JSON.stringify(r));
  check('queued reports the guest queue', channel.queued === 3, String(channel.queued));
}

// ---- 3. bytes sent before the guest opens the channel are not lost ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  const r = channel.send(Uint8Array.of(84, 104, 105, 110, 107));
  check('a send before the guest opens is accepted and held', r.accepted === true && channel.queued === 5, JSON.stringify({ r, queued: channel.queued }));
  check('and it has not reached the guest queue yet', server.channels[CH].queue.length === 0, JSON.stringify(server.channels[CH].queue));
  server.guestOpen(CH);
  check('the held bytes go to the guest when it opens the channel', JSON.stringify(server.channels[CH].queue) === JSON.stringify([84, 104, 105, 110, 107]), JSON.stringify(server.channels[CH].queue));
  check('and are no longer held twice', channel.queued === 5, String(channel.queued));
}

// ---- 4. the guest closing the channel is reported once, as null ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  const got = [];
  channel.onReceive = (b) => got.push(b);
  server.guestOpen(CH);
  server.guestClose(CH);
  check('the guest closing the channel reaches the chat as null', got.length === 1 && got[0] === null, JSON.stringify(got));
  check('and the channel says it is closed', channel.closed === true);
}

// ---- 5. the host closing tells the server it was the host ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  server.guestOpen(CH);
  let byHostSeen = null;
  const realClose = server.closeChannel;
  server.closeChannel = (ch, byHost) => { byHostSeen = byHost; return realClose(ch, byHost); };
  channel.close();
  check('closing from the chat side passes byHost = true', byHostSeen === true, String(byHostSeen));
  check('and the guest no longer has the channel open', server.channels[CH].open === false);
  channel.close();
  check('closing twice changes nothing', server.channels[CH].open === false && channel.closed === true);
}

// ---- 6. the server callbacks are wrapped, not replaced ----
{
  const server = fakeServer();
  const seen = { open: [], close: [], data: [] };
  server.onChannelOpen = (ch) => seen.open.push(ch);
  server.onChannelClose = (ch) => seen.close.push(ch);
  server.onChannelData = (ch, bytes) => seen.data.push([ch, ...bytes]);
  const channel = new Emu.DriveWireChatChannel(server, CH);
  channel.onReceive = () => {};
  server.guestOpen(CH);
  server.guestWrite(CH, [7]);
  server.guestClose(CH);
  check('the server’s own onChannelOpen still runs', JSON.stringify(seen.open) === JSON.stringify([CH]), JSON.stringify(seen.open));
  check('the server’s own onChannelClose still runs', JSON.stringify(seen.close) === JSON.stringify([CH]), JSON.stringify(seen.close));
  check('the server’s own onChannelData still runs', JSON.stringify(seen.data) === JSON.stringify([[CH, 7]]), JSON.stringify(seen.data));
}

// ---- 7. another channel's traffic does not reach this one ----
{
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  const got = [];
  channel.onReceive = (b) => got.push(b);
  server.guestOpen(CH + 1);
  server.guestWrite(CH + 1, [1, 2, 3]);
  server.guestClose(CH + 1);
  check('another channel’s bytes do not reach this chat', got.length === 0, JSON.stringify(got));
  check('another channel closing does not close this chat', channel.closed === false);
}

// ---- 8. the channel number is validated ----
{
  const server = fakeServer();
  let threw = null;
  try { new Emu.DriveWireChatChannel(server, 15); } catch (e) { threw = e; }
  check('a channel past the last one is refused', !!threw && /0-14/.test(threw.message), threw && threw.message);
}

// ---- 9. the 64 KB channel cap: send only what fits, top up when the guest reads ----
{
  // a tiny cap makes the boundary reachable without 64 KB of bytes
  const server = fakeServer({ cap: 4 });
  const channel = new Emu.DriveWireChatChannel(server, CH);
  server.guestOpen(CH);
  const r = channel.send(Uint8Array.of(1, 2, 3, 4, 5, 6));
  check('send takes only what the channel has room for', JSON.stringify(server.channels[CH].queue) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(server.channels[CH].queue));
  check('the server took only what it had room for', r.taken === 4, JSON.stringify(r));
  check('and the whole send still fits the channel, so nothing was refused', r.accepted === true, JSON.stringify(r));
  check('nothing was dropped', server.log.length === 0, JSON.stringify(server.log));
  check('the rest is held for later', channel.queued === 6, String(channel.queued));
  server.guestRead(CH, 2);
  check('reading by the guest tops the queue up from the held bytes', JSON.stringify(server.channels[CH].queue) === JSON.stringify([3, 4, 5, 6]), JSON.stringify(server.channels[CH].queue));
  server.guestRead(CH, 4);
  check('and drains completely', JSON.stringify(server.channels[CH].queue) === JSON.stringify([]) && channel.queued === 0, JSON.stringify({ q: server.channels[CH].queue, queued: channel.queued }));
}

// ---- 10. the adapter wraps onChannelRead rather than replacing it ----
{
  const server = fakeServer({ cap: 4 });
  const seen = [];
  server.onChannelRead = (ch) => seen.push(ch);
  const channel = new Emu.DriveWireChatChannel(server, CH);
  server.guestOpen(CH);
  channel.send(Uint8Array.of(1, 2, 3, 4, 5));
  server.guestRead(CH, 1);
  check('the server’s own onChannelRead still runs', JSON.stringify(seen) === JSON.stringify([CH]), JSON.stringify(seen));
  check('and the adapter topped up on it', JSON.stringify(server.channels[CH].queue) === JSON.stringify([2, 3, 4, 5]), JSON.stringify(server.channels[CH].queue));
}

// ---- 11. the same adapter against the REAL DriveWire server ----
// A fresh server per check, driven through its own protocol, so nothing leaks between them.
function realServer() {
  const srv = new DriveWireServer();
  srv.drops = [];
  srv.onTransaction = (op, info) => { if (op === 'CHANNEL_DROPPED') srv.drops.push(info); };
  return srv;
}
const guestSend = (srv, ...bytes) => { for (const b of bytes) srv.receive(b); };

{
  // SERINIT opens the channel; what the chat sends lands in the server's queue for the guest
  const srv = realServer();
  const channel = new Emu.DriveWireChatChannel(srv, CH);
  guestSend(srv, 0x45, CH);
  check('the real server has the channel open after SERINIT', srv.channels[CH].open === true);
  channel.send(Uint8Array.of(65, 66, 67));
  check('the real server queued the chat’s bytes', JSON.stringify(srv.channels[CH].queue.toArray()) === JSON.stringify([65, 66, 67]), JSON.stringify(srv.channels[CH].queue.toArray()));
  // SERREAD answers [channel + 17, count] when several bytes wait
  guestSend(srv, 0x43);
  const status = srv.read();
  check('the guest is told bytes are waiting (SERREAD status)', status === CH + 17 || status === CH + 1, String(status));
}

{
  // the real 64 KB cap: the adapter sends only the room the server has, and the server drops nothing
  const srv = realServer();
  const channel = new Emu.DriveWireChatChannel(srv, CH);
  guestSend(srv, 0x45, CH);
  srv.channelSend(CH, new Uint8Array(CHANNEL_QUEUE_MAX - 1));   // one byte of room left
  const r = channel.send(Uint8Array.of(1, 2));
  check('against the real server, only the room it has is used', r.taken === 1, JSON.stringify(r));
  check('the real server dropped nothing', srv.drops.length === 0, JSON.stringify(srv.drops));
  check('the byte that did not fit is staged by the adapter', channel.held.length === 1, String(channel.held.length));
}

{
  // SERREADM by the guest makes room, the server fires onChannelRead, the adapter tops the queue back up
  const srv = realServer();
  const channel = new Emu.DriveWireChatChannel(srv, CH);
  guestSend(srv, 0x45, CH);
  srv.channelSend(CH, new Uint8Array(CHANNEL_QUEUE_MAX - 2));
  channel.send(Uint8Array.of(9, 8, 7, 6));
  const tailBefore = srv.channels[CH].queue.toArray().slice(-2);
  check('two of the four crossed into the real queue', JSON.stringify(tailBefore) === JSON.stringify([9, 8]), JSON.stringify(tailBefore));
  check('and two are staged by the adapter', channel.held.length === 2, String(channel.held.length));
  guestSend(srv, 0x63, CH, 2);                                  // SERREADM: take two
  check('the real queue is full again', srv.channels[CH].queue.length === CHANNEL_QUEUE_MAX, String(srv.channels[CH].queue.length));
  const tailAfter = srv.channels[CH].queue.toArray().slice(-2);
  check('and the staged bytes are the ones that went across', JSON.stringify(tailAfter) === JSON.stringify([7, 6]), JSON.stringify(tailAfter));
  check('the adapter has nothing left staged', channel.held.length === 0, String(channel.held.length));
}

{
  // SERTERM ($C5) by the guest reaches the chat as null, once
  const srv = realServer();
  const channel = new Emu.DriveWireChatChannel(srv, CH);
  const got = [];
  channel.onReceive = (b) => got.push(b);
  guestSend(srv, 0x45, CH);
  guestSend(srv, 0xC5, CH);
  check('a SERTERM reaches the chat as null', got.length === 1 && got[0] === null, JSON.stringify(got));
  check('and the adapter reports the channel closed', channel.closed === true);
}

{
  // SERWRITE ($C3) by the guest reaches the chat unchanged
  const srv = realServer();
  const channel = new Emu.DriveWireChatChannel(srv, CH);
  const got = [];
  channel.onReceive = (b) => got.push(...b);
  guestSend(srv, 0x45, CH);
  guestSend(srv, 0xC3, CH, 72);
  check('a SERWRITE reaches the chat unchanged', JSON.stringify(got) === JSON.stringify([72]), JSON.stringify(got));
}

// ---- 11. a whole conversation crosses the DriveWire channel ----
// sendLine is async, so this runs after the synchronous checks above.
async function conversation() {
  // the SSE shape the Messages API sends, and a fetch that answers with it (the real API is never called)
  const stream = (text) => [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ].map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  const asked = [];
  const fetch = async (url, init) => { asked.push(JSON.parse(init.body)); return new Response(stream('Hello from Claude.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const server = fakeServer();
  const channel = new Emu.DriveWireChatChannel(server, CH);
  new Emu.ChatSession({ backend: new Emu.ClaudeBackend({ fetch, apiKey: 'k' }), channel, brief: 'B', tools: false });
  server.guestOpen(CH);
  server.guestWrite(CH, [...new TextEncoder().encode('what is a Dragon 32?'), 13]);
  // let the backend's promise chain run (a mocked fetch answers at once)
  await new Promise((r) => setTimeout(r, 20));
  const reply = String.fromCharCode(...server.channels[CH].queue);
  check('the typed line reaches the backend over DriveWire', asked.length === 1 && asked[0].messages.some((m) => m.role === 'user' && m.content === 'what is a Dragon 32?'), JSON.stringify(asked.map((a) => a.messages)));
  check('the reply comes back on the guest’s DriveWire channel', reply.includes('Hello from Claude.'), JSON.stringify(reply));
}

conversation().then(() => {
  console.log(`${n - fail}/${n} DriveWire chat channel checks passed`);
  process.exitCode = fail ? 1 : 0;
}, (e) => { console.log(`FAIL the conversation threw: ${e && e.stack}`); process.exitCode = 1; });
