// Run: node tests/chat-long-lines.test.js
//
// Long lines typed on the full-screen chat reach the backend byte for byte, through the Session (startChat), on every
// path the chat takes: the page's mailbox and DriveWire on a Becker port, on the Dragon 64, the CoCo, the CoCo 2B and
// the CoCo 3. (The MC-10 and the Alice have no 6809: the page opens their chat on a Dragon 64, the first case here.)
// The chat firmware (examples/chat.asm) holds a line of 1024 characters (BMAX; its lengths are 16-bit). A line used
// to stop at 255: anything typed past it was not sent, so a 269-character prompt arrived as its first 255.
//  * lines of 256, 269 and 1000 characters arrive whole, as typed;
//  * a line of 1025: the first 1024 are sent and the 1025th is refused with a notice on the chat screen, "[Full: 1024
//    characters. ENTER sends it.]", then the screen goes on as before (ENTER takes the notice away);
//  * the API key reaches neither machine's memory;
//  * on a CoCo with 4K or 16K the chat is refused, saying it needs 32K (its firmware uses $0400-$7FFF), and nothing
//    changes; with 32K it starts.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const FONT = require('../tools/chat-font.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const KEY = 'sk-ant-LONG-LINES-TEST-KEY-0123456789';
const NOTICE = '[Full: 1024 characters. ENTER sends it.]';
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const reply = sse([{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
// the chat screen as text (42 x 24 cells of the 6x8 font, at $0400)
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
const settle = () => new Promise((r) => setTimeout(r, 0));
const frames = async (s, k) => { for (let i = 0; i < k; i++) { s.advance(1000 / s.shownMachine.fps + 0.01); if (s.shownMachine.stall) await s.shownMachine.stall; } };
// a line of text of length len, no space at either end (a line's trailing spaces are not sent)
const CHARS = 'abcdefghij klmnopqrstuvwxyz ABCDEFGHIJKLM NOPQRSTUVWXYZ 0123456789 .,?!';
const textOf = (len) => Array.from({ length: len }, (_, i) => CHARS[(i * 7) % CHARS.length]).join('').replace(/^ | $/g, '.');

const CASES = [['dragon64', false], ['coco', false], ['coco', true], ['coco2b', true], ['coco3', true]];
(async () => {
  for (const [machine, drivewire] of CASES) {
    const label = `${machine} (${drivewire ? 'DriveWire' : 'mailbox'})`;
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine(machine);
    s.setClaudeKey(KEY);
    const calls = [];
    const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(reply, { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: s.keyStore.get() });
    const basic = s.shownMachine;
    s.startChat(Object.assign({ backend, firmware: FIRMWARE }, drivewire ? { drivewire: true } : { channel: new Emu.MemoryChannel() }));
    const cm = s.shownMachine;
    await frames(s, 30);
    const last = () => calls.length && calls[calls.length - 1].messages.slice(-1)[0].content;
    // a turn: the line typed, ENTER, until the backend has it and the reply has come back (the prompt again)
    const say = async (line, want) => {
      s.typeText(`${line}\n`);
      for (let i = 0; i < 3000 && calls.length < want; i++) { await frames(s, 1); await settle(); }
      for (let i = 0; i < 300 && (s.chat.busy || s.readByte(Emu.CHAT_STATE.wait, cm)); i++) { await frames(s, 1); await settle(); }
    };
    let k = 0;
    for (const len of [256, 269, 1000]) {
      const text = textOf(len);
      await say(text, ++k);
      check(`${label}: a ${len}-character line reaches the backend byte for byte`, calls.length === k && last() === text,
        `${calls.length} calls; ${String(last()).length} characters`);
    }
    // 1025: the 1025th key is refused, with the notice on screen
    const over = textOf(1025);
    s.typeText(over);
    let noticed = false;
    for (let i = 0; i < 3000 && !noticed; i++) { await frames(s, 1); noticed = chatScreen(s).includes(NOTICE); }
    const blen = s.readByte(Emu.CHAT_STATE.blen, cm) * 256 + s.readByte(Emu.CHAT_STATE.blen + 1, cm);
    check(`${label}: a 1025th character is refused: the line holds 1024 and the screen says the message is full`, noticed && blen === 1024, `notice ${noticed}, BLEN ${blen}`);
    await say('', ++k);
    check(`${label}: ENTER then sends exactly the first 1024 characters, and takes the notice away`,
      calls.length === k && last() === over.slice(0, 1024) && !chatScreen(s).includes(NOTICE), `${String(last()).length} characters`);
    const keyIn = (mem) => Buffer.from(mem).includes(Buffer.from(KEY, 'latin1'));
    check(`${label}: the API key is in neither machine's memory`, !keyIn(cm.ram) && !keyIn(basic.ram));
    s.endChat();
  }
  // ---- memory: the firmware needs 32K ($0400-$7FFF). With 4K or 16K it would load into memory that is not there
  // and leave a dead screen; startChat refuses, saying so, and changes nothing ----
  for (const id of ['coco', 'coco2b']) {
    for (const ram of [4, 16, 32]) {
      const s = new Emu.Session({ store: Emu.memoryStore() });
      s.switchMachine(id, { ram });
      const basic = s.shownMachine;
      const backend = new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY });
      let err = '';
      try { s.startChat({ backend, firmware: FIRMWARE, channel: new Emu.MemoryChannel() }); } catch (e) { err = e.message; }
      if (ram < 32) {
        check(`${id} ${ram}K: the chat is refused, saying it needs 32K, and nothing changes`,
          /needs 32K of memory or more; this .* has \d+K/.test(err) && s.shownMachine === basic && !s.chatMachines && !s.chat, err);
      } else {
        await frames(s, 30);
        check(`${id} ${ram}K: the chat starts and its firmware draws the prompt`, !err && !!s.chatMachines && chatScreen(s)[0].startsWith('>'),
          err || JSON.stringify(chatScreen(s)[0]));
        s.endChat();
      }
    }
  }

  console.log(`\n${n - fail}/${n} chat long-line checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
