// Run: node tests/claude-session.test.js
//
// The Claude chat on a Session, as the page opens it with ?app=claude:
//  * startChat keeps the machine in use as the BASIC session and runs the chat firmware (examples/chat.bin) on a
//    second machine of the same model, which goes on screen; endChat and a machine switch bring BASIC back;
//  * a line typed on the chat machine reaches the backend byte for byte, through the channel, after frames run;
//    the reply comes back down the channel;
//  * Claude's tools act on the BASIC session, never on the chat machine, once the person allows it: poke writes its
//    memory, type_text types into it while the chat stays on screen (the BASIC session runs beside it);
//    one snapshot before the first change of a turn (not one per tool call); Undo restores the BASIC session
//    exactly (its whole snapshot is equal to the one before the turn);
//  * with the machine tools off, no tools are sent and a tool call is refused;
//  * Ask Claude: the conversation in the side panel without the chat machine; the
//    same ChatSession to full screen (the firmware is given what was said) and back; reading always works, acting
//    asks first (Allow, or "Just tell me the fix", which changes nothing); Stop; restore points;
//  * the API key never reaches either machine's memory, a snapshot or a settings export.
// The backend is the real ClaudeBackend with a mocked fetch that scripts the Messages API's SSE replies.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const KEY = 'sk-ant-SESSION-TEST-KEY-0123456789';

// ---- a scripted Messages API ----
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
const textReply = (text) => sse([start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
const toolReply = (uses) => sse([start, ...uses.flatMap((u, i) => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input || {}) } },
  { type: 'content_block_stop', index: i }]),
{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
function scripted(bodies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const b = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return new Response(b, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls };
}
// the chat screen as text: each 6x8 cell of the 256x192 bitmap at $0400 matched against the chat font
// (tools/chat-font.js, the table the firmware is built with), 42 columns by 24 rows
const FONT = require('../tools/chat-font.js');
const GLYPHS = [];
for (let c = FONT.FIRST; c <= FONT.LAST; c++) GLYPHS.push({ ch: String.fromCharCode(c), g: FONT.table().slice((c - FONT.FIRST) * 8, (c - FONT.FIRST) * 8 + 8) });
function chatScreen(m) {
  const out = [];
  for (let r = 0; r < 24; r++) {
    let line = '';
    for (let c = 0; c < 42; c++) {
      const cell = [];
      for (let y = 0; y < 8; y++) {
        let b = 0;
        for (let x = 0; x < 6; x++) { const px = c * 6 + x, ln = r * 8 + y; b = (b << 1) | ((m.ram[0x400 + ln * 32 + (px >> 3)] >> (7 - (px & 7))) & 1); }
        cell.push(b);
      }
      const hit = GLYPHS.find((g) => g.g.every((v, i) => v === cell[i]));
      line += hit ? hit.ch : (cell.every((v) => !v) ? ' ' : '?');
    }
    out.push(line.trimEnd());
  }
  return out;
}
// the same, read from the rendered frame: the 256x192 picture starts where the border (the foreground colour in
// graphics modes) gives way to the background, and a cell is a glyph when its lit pixels match it
function frameScreen(m) {
  const f = m.render(), fg = f.table[f.data[0]];
  let ox = f.width, oy = f.height;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (f.table[f.data[y * f.width + x]] !== fg) { ox = Math.min(ox, x); oy = Math.min(oy, y); }
  const lit = (x, y) => (f.table[f.data[(oy + y) * f.width + ox + x]] === fg ? 1 : 0);
  const out = [];
  for (let r = 0; r < 24; r++) {
    let line = '';
    for (let c = 0; c < 42; c++) {
      const cell = [];
      for (let y = 0; y < 8; y++) { let b = 0; for (let x = 0; x < 6; x++) b = (b << 1) | lit(c * 6 + x, r * 8 + y); cell.push(b); }
      const hit = GLYPHS.find((g) => g.g.every((v, i) => v === cell[i]));
      line += hit ? hit.ch : (cell.every((v) => !v) ? ' ' : '?');
    }
    out.push(line.trimEnd());
  }
  return out;
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.machine.fps + 0.01); };
const snapText = (m) => Emu.state.toJSON(m.snapshot());

function open(bodies, { machine = 'dragon64', tools = true } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(machine);
  s.setClaudeKey(KEY);
  const { fetch, calls } = scripted(bodies);
  const backend = new Emu.ClaudeBackend({ fetch, apiKey: s.keyStore.get() });
  const channel = new Emu.MemoryChannel();
  const basic = s.machine;
  const chat = s.startChat({ backend, channel, firmware: FIRMWARE, brief: 'BRIEF', tools });
  return { s, chat, calls, basic, channel };
}
// type a line on the chat machine (stub keyboard: POLCAT) and run frames until the backend has been called
async function say(s, calls, line, want) {
  s.typeText(`${line}\n`);
  for (let i = 0; i < 400 && calls.length < want; i++) { frames(s, 1); await settle(); }
  await settle();
}

(async () => {
  // ---- opening and closing ----
  {
    const { s, chat, basic } = open([textReply('Hi.')]);
    check('startChat: a second machine of the same model goes on screen', s.machine !== basic && s.machine.id === basic.id
      && s.chatView === 'chat' && s.chatMachines.basic === basic && s.chatMachines.chat === s.machine);
    check('the chat machine runs the stub (no ROM needed) with the chat firmware', !s.machine.hasRom && s.machine.cpu.pc >= 0x6000 && s.machine.cpu.pc < 0x7000, s.machine.cpu.pc.toString(16));
    check('the chat has the machine tools on by default: every read-only and acting tool, and nothing else',
      JSON.stringify(chat.tools.map((t) => t.name).sort()) === JSON.stringify([...Emu.machineTools().map((t) => t.name)].sort())
      && chat.tools.length === Emu.READ_ONLY_TOOLS.length + Emu.ACTING_TOOL_NAMES.length,
      chat.tools.map((t) => t.name).join(','));
    check('showChat("basic") puts the BASIC session on screen, and back', s.showChat('basic') && s.machine === basic && s.chatView === 'basic'
      && s.showChat('chat') && s.machine === s.chatMachines.chat);
    s.endChat();
    check('endChat: the BASIC session is back on screen and the chat is gone', s.machine === basic && s.chat === null && s.chatMachines === null);
    const w = new Emu.Session({ store: Emu.memoryStore() });
    w.switchMachine('dragon64');
    w.startWelcome(new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/welcome.bin'))));
    w.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY }), channel: new Emu.MemoryChannel(), firmware: FIRMWARE });
    check('the welcome program is not running on the chat machine', !w.welcomeRunning);
    w.endChat();
    check('closing a chat opened from the welcome menu comes back to the welcome program', w.welcomeRunning);
    // and its keys still reach the page: a key the program posts after the chat is a welcome event again
    const heard = [];
    w.on((ev) => { if (ev === 'welcome:demo') heard.push('demo'); });
    w.machine.poke(0x6003, 2);
    let flushed = true;
    try { w.flushWelcome(); } catch (e) { flushed = e.message; }
    check('after the chat, the welcome menu\'s keys are events again (key 2: the colour demo)', flushed === true && heard.join() === 'demo', String(flushed));
    const o2 = open([textReply('Hi.')]);
    o2.s.switchMachine('coco');
    check('a machine switch closes the chat', o2.s.chat === null && o2.s.machine.id === 'coco' && o2.s.chatView === null);
  }
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('mc10');
    const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: KEY });
    check('the chat needs a 6809', throws(() => s.startChat({ backend, channel: new Emu.MemoryChannel(), firmware: FIRMWARE }), /needs a 6809/));
    s.switchMachine('dragon64');
    check('the chat needs its firmware', throws(() => s.startChat({ backend, channel: new Emu.MemoryChannel() }), /firmware/));
    check('the chat needs a backend', throws(() => s.startChat({ channel: new Emu.MemoryChannel(), firmware: FIRMWARE }), /backend/));
    check('a key that is not an Anthropic key is refused', throws(() => s.setClaudeKey('hello'), /sk-ant-/) && !s.hasClaudeKey);
  }

  // ---- the chat machine shows the firmware's screen: 256x192 two-colour graphics from $0400 ----
  // Expected picture from the MC6847 data sheet's graphics mode GM7 (CG6/RG6, 'resolution graphics 6') with
  // CSS=0: a 1 bit is green, a 0 bit black, eight pixels a byte, 32 bytes a line, 192 lines; the SAM shows it
  // from the display offset ($0400). It is built here from RAM, not from the firmware.
  for (const id of ['dragon64', 'dragon32', 'coco', 'coco3']) {
    const { s } = open([textReply('x')], { machine: id });
    s.setDisplay({ view: 'sharp' }, { remember: false });
    s.machine.setComposite(0);
    frames(s, 10);
    s.typeText('Hello');
    frames(s, 30);
    // a frame during which the screen memory did not change (the cursor blinks), so RAM is what was drawn
    // memory as the CPU sees it (the CoCo 3's RAM sits behind its MMU)
    const m = s.machine, screen = () => Uint8Array.from({ length: 6144 }, (_, i) => s.readByte(0x400 + i));
    for (let i = 0; i < 100; i++) { const r0 = screen(); frames(s, 1); if (Buffer.from(r0).equals(Buffer.from(screen()))) break; }
    const f = m.render(), green = f.table[f.data[0]];   // the border is the foreground colour in graphics modes
    const ram = screen(), sx = f.width >= 512 ? 2 : 1;   // the CoCo 3's frame is 640 wide: two pixels a dot
    let at = null;
    for (let oy = 0; oy + 192 <= f.height && !at; oy++) for (let ox = 0; ox + 256 * sx <= f.width && !at; ox++) {
      let same = true;
      for (let y = 0; y < 192 && same; y++) for (let x = 0; x < 256 && same; x++) {
        const on = (ram[y * 32 + (x >> 3)] >> (7 - (x & 7))) & 1;
        const c = f.table[f.data[(oy + y) * f.width + ox + x * sx]];
        same = on ? c === green : c !== green;
      }
      if (same) at = [ox, oy];
    }
    const lit = [...ram].filter((b) => b).length;
    check(`${id}: the screen is $0400-$1BFF in 256x192 two-colour graphics, green on black`, !!at && lit > 10, `${at} (${lit} bytes lit, ${f.width}x${f.height})`);
  }

  // ---- a typed line reaches the backend, the reply comes back ----
  {
    const { s, calls, channel } = open([textReply('Hello from Claude.')]);
    frames(s, 10);
    await say(s, calls, 'Hello, Claude: 1+1?', 1);
    check('the typed line reaches the backend byte for byte (case kept)', calls.length === 1 && calls[0].body.messages.slice(-1)[0].content === 'Hello, Claude: 1+1?',
      JSON.stringify(calls[0] && calls[0].body.messages));
    check('the request carries the key, the brief and the browser-access header', calls[0].headers['x-api-key'] === KEY && calls[0].body.system.map((b) => b.text).join('') === 'BRIEF'
      && calls[0].headers['anthropic-dangerous-direct-browser-access'] === 'true');
    check('the tools go with the request, read-only and acting alike',
      Array.isArray(calls[0].body.tools) && calls[0].body.tools.length === Emu.machineTools().length
      && calls[0].body.tools.some((t) => t.name === 'screen_text') && calls[0].body.tools.some((t) => t.name === 'poke'));
    const waiting = channel.queued;
    frames(s, 40);
    check('the reply, the CR LF that ends it and the end-of-reply byte are handed to the chat firmware, a byte a frame', waiting === 'Hello from Claude.\r\n\x04'.length && channel.queued === 0, `${waiting} queued, ${channel.queued} left`);
    check('the conversation holds the turn', s.chat.messages.length === 2 && s.chat.messages[1].content === 'Hello from Claude.');
    const shown = chatScreen(s.machine);
    check('the chat screen shows the line and the whole reply (a reply ends its line)', shown.includes('> Hello, Claude: 1+1?') && shown.includes('Hello from Claude.'),
      JSON.stringify(shown.filter(Boolean)));
  }
  // A wrapped error, a line typed while it was still arriving, then a new prompt: checked on the rendered frame
  // (what the person sees), not only in memory. The early line must not be taken (the firmware waits for the
  // end-of-reply byte), the wrapped error keeps both its lines whole, and the next prompt starts its own line.
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setDisplay({ view: 'sharp' }, { remember: false });
    s.machine.setComposite(0);
    const { fetch, calls } = scripted([textReply('Second answer.')]);
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: '' });
    const channel = new Emu.MemoryChannel();
    s.startChat({ backend, channel, firmware: FIRMWARE });
    frames(s, 10);
    s.typeText('first\n');
    for (let i = 0; i < 200 && !s.chat.error; i++) { frames(s, 1); await settle(); }
    frames(s, 10);
    const midway = channel.queued;
    s.typeText('Poke it, then run it.\n');          // typed while the error is still arriving
    for (let i = 0; i < 400 && channel.queued; i++) frames(s, 1);
    frames(s, 60);
    backend.setKey(KEY);
    await say(s, calls, 'second', 1);
    for (let i = 0; i < 400 && channel.queued; i++) frames(s, 1);
    frames(s, 30);
    const want = ['> first', 'Thinking...', '[No API key: add your Anthropic API key to', 'chat.]', '> second', 'Thinking...', 'Second answer.', '>'];
    const ram = chatScreen(s.machine).filter(Boolean);
    const shown = frameScreen(s.machine).filter(Boolean);
    check('frame: a wrapped error, a line typed during it and a new prompt each stay whole, line by line', midway > 10
      && JSON.stringify(shown) === JSON.stringify(want), `${midway} bytes were still to come; ${JSON.stringify(shown)}`);
    check('the line typed while the error was arriving was not taken (no request, nothing on screen)', calls.length === 1
      && calls[0].body.messages.slice(-1)[0].content === 'second' && !shown.some((l) => /Poke/.test(l)) && JSON.stringify(ram) === JSON.stringify(want));
  }

  // ---- the same chat on a CoCo 3, whose RAM sits behind its MMU (the mailbox at CPU $7000) ----
  {
    const { s, calls, channel } = open([textReply('Hi, CoCo 3.')], { machine: 'coco3' });
    frames(s, 10);
    await say(s, calls, 'hello from a CoCo 3', 1);
    check('coco3: the typed line reaches the backend', calls.length === 1 && calls[0].body.messages.slice(-1)[0].content === 'hello from a CoCo 3',
      JSON.stringify(calls[0] && calls[0].body.messages));
    frames(s, 40);
    check('coco3: the reply reaches the firmware', channel.queued === 0);
  }

  // ---- tools act on the BASIC session; one snapshot per turn; Undo restores it exactly ----
  {
    const bodies = [
      toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [1, 2, 3] } }, { name: 'peek', input: { address: 0x3000, length: 3 } }]),
      toolReply([{ name: 'type_text', input: { text: 'PRINT 7\n' } }]),
      textReply('Done.'),
    ];
    const { s, chat, calls, basic } = open(bodies);
    s.setClaudeAllowed(true);
    frames(s, 10);
    const before = snapText(basic);
    const chatMachine = s.machine, chatRam = chatMachine.ram.slice(0x3000, 0x3003);
    await say(s, calls, 'poke something', 3);
    for (let i = 0; i < 20 && chat.busy; i++) await settle();
    const tr = calls[1] && calls[1].body.messages.slice(-1)[0].content;
    check('poke wrote the BASIC session, not the chat machine', basic.ram[0x3000] === 1 && basic.ram[0x3001] === 2 && basic.ram[0x3002] === 3
      && chatMachine.ram.slice(0x3000, 0x3003).every((b, i) => b === chatRam[i]));
    const peeked = Array.isArray(tr) ? (() => { try { return JSON.parse(tr[1].content); } catch (e) { return null; } })() : null;
    check('peek read it back from the BASIC session', peeked && JSON.stringify(peeked.bytes) === JSON.stringify([1, 2, 3]) && peeked.truncated === false, JSON.stringify(tr));
    check('type_text leaves the chat on screen (the BASIC session is beside it, live)', s.machine === chatMachine && s.chatView === 'chat' && s.besideMachine() === basic);
    // type_text answers once the BASIC session (the stub here) has taken every key: its result says so
    const typed = (() => { try { return JSON.parse(calls[2].body.messages.slice(-1)[0].content[0].content); } catch (e) { return null; } })();
    check('type_text delivered every key to the BASIC session and says so', typed && typed.requested === 8 && typed.consumed === 8 && typed.lines_delivered === 1
      && basic.stubKeys.length === 0, JSON.stringify(typed));
    // (the BASIC session runs beside the chat, so the snapshot is of the moment before the poke, not of `before`)
    const point = chat.undo.length === 1 ? Emu.state.toJSON(chat.undo[0]) : '';
    check('one snapshot for the turn, before its first change', chat.undo.length === 1 && point !== before && JSON.parse(point) && chat.undo[0] !== null);
    frames(s, 30);
    check('the typed text ran on the BASIC session, off screen', s.screenText(basic).some((l) => l.includes('PRINT 7')), s.screenText(basic).join('|'));
    check('Undo restores the BASIC session exactly to the snapshot; the chat stays on screen', chat.undoLast() && snapText(basic) === point && s.machine === chatMachine && chat.undo.length === 0);
    check('nothing left to undo', chat.undoLast() === false);
  }

  // ---- "Let Claude use the machine" off ----
  {
    const { s, chat, calls, basic } = open([textReply('No tools.')], { tools: true });
    chat.setTools(false);
    frames(s, 10);
    await say(s, calls, 'hi', 1);
    check('tools off: the request has no tools', calls.length === 1 && !('tools' in calls[0].body), JSON.stringify(Object.keys(calls[0].body)));
    let refused = false, refusedCode = null;
    try { await chat.runTool('poke', { address: 0x3000, bytes: [9] }); } catch (e) { refused = /no-consent/.test(e.message); refusedCode = e.code; }
    check('tools off: a tool call is refused with the no-consent CODE (not bare prose), and nothing changes',
      refused && refusedCode === Emu.TOOL_CODES.NO_CONSENT && basic.ram[0x3000] !== 9 && chat.undo.length === 0,
      `code ${refusedCode}`);
  }

  // ---- tool errors ----
  {
    const { chat, basic } = open([textReply('x')]);
    const err = async (name, input, re) => { try { await chat.runTool(name, input); return false; } catch (e) { return re.test(e.message); } };
    const code = async (name, input) => { try { await chat.runTool(name, input); return null; } catch (e) { return e.code; } };
    check('peek: address checked, with codes', await code('peek', { address: 70000 }) === Emu.TOOL_CODES.BAD_ADDRESS
      && await code('peek', { address: 0xFFFF, length: 2 }) === Emu.TOOL_CODES.PAST_END);
    check('poke: bytes checked', await err('poke', { address: 0x3000, bytes: [] }, /empty/) && await err('poke', { address: 0x3000, bytes: [256] }, /bad-byte/)
      && await err('poke', { address: 0xFFFF, bytes: [1, 2] }, /past-end/));
    // an unknown tool is a coded refusal now, not a prose one: the model is told the code, the remedy and
    // the name it sent, so it knows to pick a name from the list in the request
    check('an unknown tool carries the unknown-tool code, its remedy and the name sent',
      await code('format_disk', {}) === Emu.TOOL_CODES.UNKNOWN_TOOL
      && await err('format_disk', {}, /unknown-tool.*\(got format_disk\)/));
    check('a refused tool call takes no snapshot', chat.undo.length === 0 && basic.ram[0x3000] !== 1);
  }


  // ---- Ask Claude: the side panel, consent, Stop, restore points, and the move to full screen and back ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    const basic = s.machine;
    frames(s, 30);
    const bodies = [
      toolReply([{ name: 'screen_text' }, { name: 'poke', input: { address: 0x3000, bytes: [7] } }]), textReply('Change $3000 to 7 yourself.'),
      toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [9] } }]), textReply('Poked.'),
      textReply('Still here, full screen.'),
    ];
    const { fetch, calls } = scripted(bodies);
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: KEY });
    const chat = s.startAsk({ backend, brief: 'BRIEF' });
    check('startAsk: a conversation with no chat machine, beside the machine in use', s.chat === chat && !s.chatMachines && s.machine === basic
      && s.claudeView === 'panel' && chat.channel === null && chat.target.machine === basic);
    check('startAsk again gives the same conversation', s.startAsk({ backend }) === chat);
    // the person says no: reading worked, the poke is refused with the reason, nothing changed
    const asked = [];
    s.claudeGate = (name, input) => { asked.push(name); Promise.resolve().then(() => s.answerClaude(false)); };
    const before = snapText(basic);
    const r1 = await chat.sendLine('What is on the screen? Fix it.');
    const results = calls[1] && calls[1].body.messages.slice(-1)[0].content;
    check('reading needs no permission; acting asks first', asked.join() === 'poke' && Array.isArray(results) && !results[0].is_error && /OK|STUB|DRAGON/i.test(results[0].content),
      JSON.stringify(results && results[0]));
    // The gate derives its set from the schemas (ACTING_TOOL_NAMES), so this holds for every acting tool, not
    // just poke. Iterate the schemas themselves - not the gate's own list - and require each to raise the card:
    // if the two ever disagree, this fails rather than agreeing with itself.
    {
      const askedNow = [];
      const ranTools = [];                 // the tools that actually reached ChatSession.runTool
      s.claudeAllowed = false;
      s.claudeGate = (name) => { askedNow.push(name); Promise.resolve().then(() => s.answerClaude(false)); };
      const gateText = { poke: { address: 0x3000, bytes: [1] }, type_text: { text: 'X' }, press_break: {} };
      const schemas = Emu.actingTools().map((t) => t.name);
      // chat.backend.runTool is the Session's gate wrapper; chat.runTool is the real dispatcher. Watching the
      // LATTER is what lets the check below tell "the gate refused it" from "it ran and happened to change
      // nothing" - the distinction that made the old assertion unable to fail.
      const inner = chat.runTool.bind(chat);
      chat.runTool = (name, input) => { ranTools.push(name); return inner(name, input); };
      for (const name of schemas) {
        try { await chat.backend.runTool(name, gateText[name] || {}); } catch (e) { /* declined: expected */ }
      }
      chat.runTool = inner;
      // load_basic checks its program before its own card (every call): this BASIC session has no ROMs, so it is
      // refused no-basic before anyone is asked, and it never runs either (ranTools below)
      check('every acting tool in the schemas raises the consent card before it runs (load_basic: refused before its own card here)',
        JSON.stringify(askedNow) === JSON.stringify(schemas.filter((x) => x !== 'load_basic')), `${askedNow.join(',')} asked of ${schemas.join(',')}`);
      check('the gate\'s set is exactly the schemas\' names, in the same order',
        JSON.stringify([...Emu.ACTING_TOOL_NAMES]) === JSON.stringify(schemas),
        `gate ${[...Emu.ACTING_TOOL_NAMES].join(',')} vs schemas ${schemas.join(',')}`);
      // The point of a refusal is that the tool never RAN: no poke reached memory and no restore point was
      // pushed. Asserting the world afterwards (ram unchanged, undo empty) is weak on its own, because in the
      // real path the gate returns before runTool is even called, so those are true for reasons unrelated to
      // the refusal. So also count the runTool calls: each acting name must have been refused BEFORE dispatch.
      // Mutation that must fail this: make the gate answer true (allow) - then the tools run, the poke lands
      // and a snapshot is pushed, and this fails on both counts.
      check('a refused acting tool never reached runTool: nothing was poked and no restore point was pushed',
        ranTools.length === 0 && basic.ram[0x3000] !== 1 && chat.undo.length === 0,
        `runTool calls: ${ranTools.join(',') || 'none'} | ram[0x3000]=${basic.ram[0x3000]} | undo=${chat.undo.length}`);
    }
    check('"Just tell me the fix": the poke is refused with the reason Claude is given, and nothing changes', results[1].is_error && /Just tell me the fix/.test(results[1].content)
      && snapText(basic) === before && chat.undo.length === 0 && !s.claudeAllowed && r1 && r1.text === 'Change $3000 to 7 yourself.', JSON.stringify(results[1]));
    // the person allows it: the poke happens after a restore point, and stays allowed
    s.claudeGate = () => { Promise.resolve().then(() => s.answerClaude(true)); };
    await chat.sendLine('Do it for me.');
    const points = s.claudePoints;
    check('Allow: the change is made after a restore point, stamped with its time; the switch stays on', basic.ram[0x3000] === 9 && s.claudeAllowed
      && points.length === 1 && points[0].index === 0 && typeof points[0].at === 'number' && Emu.state.toJSON(chat.undo[0]) === before);
    check('restoreClaude puts the BASIC session back to the restore point and drops it', s.restoreClaude(0) && snapText(basic) === before && s.claudePoints.length === 0);
    // Stop while Claude's typing is still going in
    s.typeText('PRINT 1\nPRINT 2\n', basic);
    s.claudeActing = { name: 'type_text', input: { text: 'PRINT 1\nPRINT 2\n' } };
    check('while typing goes in, Claude is acting', s.claudeBusyActing);
    s.stopClaude();
    check('Stop: the typing stops and Claude is no longer acting', !s.claudeBusyActing && basic.stubKeys.length === 0 && s.claudeActing === null);
    // to full screen: the same conversation, given to the firmware; both machines run
    const channel = new Emu.MemoryChannel();
    const same = s.startChat({ backend, channel, firmware: FIRMWARE, brief: 'BRIEF' });
    const told = new TextDecoder().decode(Uint8Array.from(channel.rx));
    check('to full screen: the same ChatSession, now on the chat machine, with the BASIC session beside it', same === chat && s.claudeView === 'full' && s.chatMachines.basic === basic
      && s.machine === s.chatMachines.chat && s.besideMachine() === basic && chat.channel === channel && chat.messages.length === 4);
    check('the firmware is given what was said so far, each turn on its own line, then a prompt', /^> What is on the screen\? Fix it\.\r\nChange \$3000 to 7 yourself\.\r\n> Do it for me\.\r\nPoked\.\r\n\x04$/.test(told), JSON.stringify(told));
    const pc0 = basic.cpu.totalCycles;
    frames(s, 5);
    check('the BASIC session runs while the chat is on screen (the live picture-in-picture)', basic.cpu.totalCycles > pc0);
    for (let i = 0; i < 400 && channel.queued; i++) frames(s, 1);
    await say(s, calls, 'still there?', 5);
    for (let i = 0; i < 20 && chat.busy; i++) await settle();
    check('a line typed on the chat machine goes on in the same conversation', calls.length === 5 && calls[4].body.messages.length === 5
      && calls[4].body.messages[4].content === 'still there?' && chat.messages.slice(-1)[0].content === 'Still here, full screen.', JSON.stringify(calls[4] && calls[4].body.messages.map((m) => m.content)));
    // back to the side panel: the BASIC session on screen, the chat machine gone, the conversation kept
    s.toSidePanel();
    check('back to the side panel: the BASIC session on screen, no chat machine, the conversation kept', s.claudeView === 'panel' && !s.chatMachines && s.machine === basic
      && s.chat === chat && chat.channel === null && channel.closed && chat.messages.length === 6);
    s.endChat();
    check('closing ends the conversation', s.chat === null && s.claudeView === null && s.machine === basic);
  }

  // ---- a key the person presses pauses Claude (14b follow-up); the Debugger's code ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    const m = s.machine;
    const { fetch } = scripted([textReply('x')]);
    const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }) });
    s.setClaudeAllowed(true);
    // Claude has typing going in
    const job = s.typeTextPaced('10 PRINT 1\n20 PRINT 2\n', m);
    s.claudeActing = { name: 'type_text', input: { text: '10 PRINT 1\n20 PRINT 2\n' } };
    chat.busy = true;
    const queued = m.typist.queue.length;
    check('pauseClaude holds back what Claude still had to type', queued === 22 && s.pauseClaude() && m.typist.queue.length === 0 && s.claudePaused.held.queue.length === queued && s.claudeBusyActing);
    check('pausing twice does nothing', s.pauseClaude() === false);
    // Claude's next action waits while paused
    let done = false;
    const next = chat.backend.runTool('poke', { address: 0x3000, bytes: [5] }).then(() => { done = true; });
    await settle();
    check('an action while paused waits (nothing changed)', !done && m.ram[0x3000] !== 5);
    m.stubKeys.push(88);                          // the person's own key
    check('resumeClaude queues the held typing after the person\'s key, and the waiting action goes on', s.resumeClaude() && m.stubKeys[0] === 88
      && m.stubKeys.length === 1 && m.typist.queue.length === queued && s.claudePaused === null && (await next, done) && m.ram[0x3000] === 5);
    // Stop while paused: the held typing is dropped and a waiting action is refused
    s.claudeActing = { name: 'type_text', input: { text: 'x' } };
    s.pauseClaude();
    let refused = false;
    const blocked = chat.backend.runTool('poke', { address: 0x3001, bytes: [6] }).catch((e) => { refused = /stopped Claude/.test(e.message); });
    s.stopClaude();
    await blocked;
    check('Stop while paused: nothing held is typed, the waiting action is refused, the typing ends stopped', refused && m.stubKeys.length === 0 && m.typist.queue.length === 0
      && m.ram[0x3001] !== 6 && s.claudePaused === null && job.status === 'stopped');
    chat.busy = false;
    // codeAt: the code and the registers, as the Debugger would show them
    [0x86, 0x41, 0xA7, 0x80, 0x5A, 0x26, 0xFB, 0x39].forEach((b, i) => m.poke(0x3000 + i, b));
    const code = s.codeAt(0x3000, 5);
    check('codeAt: one line per instruction with its address and bytes, then the registers', code.from === 0x3000 && code.to === 0x3007
      && code.text === '3000  86 41        LDA #$41\n3002  A7 80        STA ,X+\n3004  5A           DECB\n3005  26 FB        BNE $3002\n3007  39           RTS'
      && /^PC=[0-9A-F]{4} A=/.test(code.registers), JSON.stringify(code));
    s.endChat();
  }

  // ---- the key never reaches the machines, a snapshot or an export ----
  {
    const { s, calls, basic } = open([textReply('ok')]);
    frames(s, 10);
    await say(s, calls, 'hi', 1);
    frames(s, 10);
    const has = (u8) => Buffer.from(u8).includes(Buffer.from(KEY));
    check('neither machine holds the key in memory', !has(basic.ram) && !has(s.chatMachines.chat.ram));
    check('no snapshot of either machine holds the key', !snapText(basic).includes(KEY) && !snapText(s.chatMachines.chat).includes(KEY));
    const exp = JSON.stringify(s.exportSettings());
    check('the settings export holds no key', !exp.includes(KEY) && !/sk-ant/.test(exp));
  }

  console.log(`${n - fail}/${n} Claude session checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
