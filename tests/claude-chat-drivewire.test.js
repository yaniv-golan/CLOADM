// Run: node tests/claude-chat-drivewire.test.js
//
// The Claude chat over a real DriveWire channel, end to end in Node: the chat firmware
// (examples/chat.asm) on a CoCo with the Becker port finds the DriveWire server (DWINIT), opens virtual serial
// channel 14 (SERINIT), sends each typed byte with FASTWRITE and takes the reply with SERREAD / SERREADM, all
// through $FF41/$FF42 and the Session's DriveWire server (js/drivewire/server.js), which hands the bytes to the
// chat (js/claude/channel.js DriveWireChatChannel) and so to the backend. No mailbox, no page pump: the
// firmware drives the channel itself, as it would on a real machine with a Becker port.
//
// The backend is the real ClaudeBackend with a mocked fetch scripting the Messages API's SSE replies. The
// expected traffic comes from the DriveWire 4 specification's transaction layouts (server log), the expected
// text from what the test typed and what the mock replied.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const FONT = require('../tools/chat-font.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const KEY = 'sk-ant-DW-CHAT-TEST-KEY-0123456789';
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const textReply = (text) => sse([{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
function scripted(bodies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(bodies[Math.min(calls.length - 1, bodies.length - 1)], { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls };
}
// the chat screen as text: 6x8 cells of the 256x192 bitmap at $0400 matched against the chat font
const GLYPHS = [];
for (let c = FONT.FIRST; c <= FONT.LAST; c++) GLYPHS.push({ ch: String.fromCharCode(c), g: FONT.table().slice((c - FONT.FIRST) * 8, (c - FONT.FIRST) * 8 + 8) });
function chatScreen(s) {
  const out = [];
  for (let r = 0; r < 24; r++) {
    let line = '';
    for (let c = 0; c < 42; c++) {
      const cell = [];
      for (let y = 0; y < 8; y++) {
        let b = 0;
        for (let x = 0; x < 6; x++) { const px = c * 6 + x, ln = r * 8 + y; b = (b << 1) | ((s.readByte(0x400 + ln * 32 + (px >> 3))) >> (7 - (px & 7)) & 1); }
        cell.push(b);
      }
      const hit = GLYPHS.find((g) => g.g.every((v, i) => v === cell[i]));
      line += hit ? hit.ch : (cell.every((v) => !v) ? ' ' : '?');
    }
    out.push(line.trimEnd());
  }
  return out;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const frames = async (s, k) => { for (let i = 0; i < k; i++) { s.advance(1000 / s.shownMachine.fps + 0.01); if (s.shownMachine.stall) await s.shownMachine.stall; } };
// the firmware's own symbols (examples/chat.asm), assembled here
const include = (name) => { const p = path.join(__dirname, '../examples', name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const ASM = Emu.assemble(fs.readFileSync(path.join(__dirname, '../examples/chat.asm'), 'utf8'), '6809', { include });
const sym = (n) => ASM.symbols.get(n);

function open(bodies, { machine = 'coco', drivewire = true } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(machine);
  s.setClaudeKey(KEY);
  const { fetch, calls } = scripted(bodies);
  const backend = new Emu.ClaudeBackend({ fetch, apiKey: s.keyStore.get() });
  const basic = s.shownMachine;
  const chat = s.startChat({ backend, firmware: FIRMWARE, brief: 'BRIEF', tools: true, drivewire });
  return { s, chat, calls, basic };
}
async function say(s, calls, line, want) {
  s.typeText(`${line}\n`);
  for (let i = 0; i < 600 && calls.length < want; i++) { await frames(s, 1); await settle(); }
  await settle();
}

(async () => {
  check('the firmware\'s DriveWire channel is the one the Session uses', sym('DWCH') === Emu.CHAT_DW_CHANNEL && ASM.ok, `${sym('DWCH')} / ${Emu.CHAT_DW_CHANNEL}`);
  check('the firmware was rebuilt from its source (examples/chat.bin is chat.asm assembled)', Buffer.from(Emu.toBinary(ASM, { format: 'dragondos', maxGap: 2048 })).equals(Buffer.from(FIRMWARE)));

  // ---- the path: DWINIT, SERINIT 14, FASTWRITE, SERREAD / SERREADM, through the Session's chat server ----
  for (const id of ['coco', 'coco2b']) {
    const long = 'Over DriveWire. '.repeat(25).trim();   // 399 bytes: more than RXBUF and one SERREADM can take
    const { s, calls, basic } = open([textReply('Hi there, CoCo.'), textReply(long)], { machine: id });
    const log = [];
    s.chatServer.onTransaction = (op, info) => log.push([op, info]);
    const cm = s.shownMachine;
    check(`${id}: the chat machine has the Becker port and its own DriveWire server, not the BASIC session's`,
      cm !== basic && cm.becker && cm.becker.server === s.chatServer && s.chatServer !== s.drivewire && s.chatServer.drives === s.drivewire.drives);
    await frames(s, 30);
    check(`${id}: the firmware found the server (DWINIT answered) and chose DriveWire`, cm.ram[sym('DWMODE')] === 0xFF);
    check(`${id}: it opened channel 14 (SERINIT); the BASIC session's server saw nothing`, s.chatServer.channels[14].open && !s.drivewire.channels[14].open);
    await say(s, calls, 'Hello, CoCo: 2+2?', 1);
    check(`${id}: the typed line reaches the backend byte for byte, through FASTWRITE on channel 14`,
      calls.length === 1 && calls[0].body.messages.slice(-1)[0].content === 'Hello, CoCo: 2+2?', JSON.stringify(calls[0] && calls[0].body.messages.slice(-1)));
    await frames(s, 120);
    const shown = chatScreen(s);
    check(`${id}: the reply comes back down the channel (SERREAD / SERREADM) and shows on the chat screen`,
      shown.includes('> Hello, CoCo: 2+2?') && shown.includes('Hi there, CoCo.'), JSON.stringify(shown.filter(Boolean)));
    check(`${id}: the page's mailbox was not used (no pump: the firmware drives the channel)`,
      [0, 1, 2, 3].every((k) => cm.ram[0x7000 + k] === 0));
    const ops = new Set(log.map((l) => l[0]));
    check(`${id}: the server saw the DriveWire transactions of the specification (DWINIT, SERINIT, SERREADM)`,
      ['DWINIT', 'SERINIT', 'SERREADM'].every((o) => ops.has(o)), [...ops].join(','));
    // a reply longer than the firmware's 256-byte ring and one SERREADM (255): several reads, nothing lost
    log.length = 0;
    await say(s, calls, 'Again', 2);
    for (let i = 0; i < 400; i++) { await frames(s, 2); if (s.chatServer.channels[14].queue.length === 0 && !s.chat.busy) break; }
    await frames(s, 200);
    const reads = log.filter((l) => l[0] === 'SERREADM');
    const words = chatScreen(s).join(' ').split(/\s+/).filter((w) => w === 'DriveWire.' || w === 'Over');
    check(`${id}: a 399-byte reply takes several SERREADMs and arrives whole`, reads.length >= 2 && s.chatServer.channels[14].queue.length === 0
      && s.chat.messages.slice(-1)[0].content === long && words.length === 50, `${reads.length} reads; ${words.length} of its 50 words on screen`);
    // a 255-character typed line (the firmware's limit) goes out whole over FASTWRITE
    const line255 = Array.from({ length: 255 }, (_, i) => 'Long line over DriveWire, 0123456789. '[i % 38]).join('');
    for (let i = 0; i < 400 && s.chat.busy; i++) await frames(s, 2);
    await frames(s, 20);
    await say(s, calls, line255, 3);
    check(`${id}: a 255-character typed line reaches the backend byte for byte over DriveWire`, calls.length === 3
      && calls[2].body.messages.slice(-1)[0].content === line255, `${calls[2] && calls[2].body.messages.slice(-1)[0].content.length} characters`);
    // a 200-character line typed while that reply (399 bytes) still comes down the channel: the firmware keeps the
    // keys (its type-ahead ring) and sends the line whole once the reply has ended, not just its tail
    const ahead = ('Tell me the top line before you answer. Then say what the CoCo is, and why a long line wraps. ').repeat(3).slice(0, 199) + '?';   // (not ending in a space: a line's trailing spaces are not sent)
    const streaming = s.chat.busy || s.chatServer.channels[14].queue.length > 0;
    await say(s, calls, ahead, 4);
    check(`${id}: a 200-character line typed while a reply streams reaches the backend byte for byte over DriveWire`, streaming && calls.length === 4
      && calls[3].body.messages.slice(-1)[0].content === ahead, `streaming ${streaming}; ${JSON.stringify(calls[3] && calls[3].body.messages.slice(-1)[0].content)}`);
    const keyIn = (mem) => Buffer.from(mem).includes(Buffer.from(KEY, 'latin1'));
    check(`${id}: the API key is in neither machine's memory (the chat's, with its type-ahead ring, nor the BASIC session's)`,
      !keyIn(cm.ram) && !keyIn(basic.ram) && !keyIn(cm.snapshot ? Emu.state.toJSON(cm.snapshot()) : ''));
    // the BASIC session on screen and back: the chat's link is kept
    s.showChat('basic'); await frames(s, 2); s.showChat('chat'); await frames(s, 2);
    check(`${id}: showing the BASIC session and back keeps the chat's server and open channel`, s.shownMachine.becker.server === s.chatServer && s.chatServer.channels[14].open);
    s.endChat();
    check(`${id}: endChat drops the chat's server`, s.chatServer === null && s.shownMachine === basic);
  }

  // ---- where there is no Becker port ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY });
    check('a Dragon 64 has no Becker port: a DriveWire chat is refused, saying why', throws(() => s.startChat({ backend, firmware: FIRMWARE, drivewire: true }), /no Becker port/));
    check('without DriveWire the chat still needs a channel', throws(() => s.startChat({ backend, firmware: FIRMWARE }), /needs a channel/));
  }
  // the same firmware without a server answering: the mailbox (a CoCo with the Becker port off)
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('coco');
    const { fetch, calls } = scripted([textReply('By mailbox.')]);
    const channel = new Emu.MemoryChannel();
    s.startChat({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }), channel, firmware: FIRMWARE });
    await frames(s, 30);
    check('no Becker port answering: the firmware keeps the mailbox (DWMODE 0)', s.shownMachine.ram[sym('DWMODE')] === 0 && !s.shownMachine.becker);
    await say(s, calls, 'Mailbox?', 1);
    await frames(s, 60);
    check('... and the chat works over it as before', calls.length === 1 && chatScreen(s).includes('By mailbox.'), JSON.stringify(chatScreen(s).filter(Boolean)));
  }

  console.log(fail ? `${fail} FAILED` : `${n}/${n} DriveWire chat checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
