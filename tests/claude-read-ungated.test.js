// Run: node tests/claude-read-ungated.test.js
//
// Reading the person's machine never waits for "Let Claude use the emulator": with the switch off, Claude's
// read-only tools (screen_text, peek, machine_info, disassemble) are offered to the model and answer from the
// person's machine, with no card, in both views (the side panel and the full-screen chat) and with the welcome menu
// on screen. Only the acting tools ask first; a refused one changes nothing.
// The backend is the real ClaudeBackend with a mocked fetch that scripts the Messages API's SSE replies.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const WELCOME = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/welcome.bin')));
const KEY = 'sk-ant-READ-TEST-KEY-0123456789';

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
    calls.push({ body: JSON.parse(init.body) });
    const b = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return new Response(b, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls };
}
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const snapText = (m) => Emu.state.toJSON(m.snapshot());

const READS = [
  { name: 'screen_text' },
  { name: 'peek', input: { address: 0x0400, length: 32 } },
  { name: 'machine_info' },
  { name: 'disassemble', input: { address: 0x4000, count: 2 } },
];

// One turn with the switch off: Claude reads with every read-only tool, then tries a poke, which the person declines.
async function turn(L, s, chat, calls, person) {
  const asked = [];
  s.claudeGate = (name) => { asked.push(name); Promise.resolve().then(() => s.answerClaude(false)); };
  check(`${L}: the switch is off`, s.claudeAllowed === false);
  const before = snapText(person);
  await chat.sendLine('What is on my screen? Then put 7 at $3000.');
  const offered = (calls[0] && calls[0].body.tools || []).map((t) => t.name);
  check(`${L}: every read-only tool is offered to the model with the switch off`, Emu.READ_ONLY_TOOLS.every((t) => offered.includes(t)), offered.join(','));
  const results = (calls[1] && calls[1].body.messages.slice(-1)[0].content) || [];
  const byName = (i) => results[i] || {};
  const screen = s.screenText(person);
  check(`${L}: screen_text answers from the person's machine with no card (the welcome menu)`, !byName(0).is_error
    && /PRESS 1 TO 5/.test(byName(0).content) && screen.some((r) => /PRESS 1 TO 5/.test(r)), JSON.stringify(byName(0)).slice(0, 200));
  let peek = null;
  try { peek = JSON.parse(byName(1).content); } catch (e) { /* not JSON: fails below */ }
  const want = Array.from({ length: 32 }, (_, i) => s.readByte(0x0400 + i, person));
  // the hex dump's lines ("$0400: 8F 8F ..."), back to bytes
  const got = peek && Array.isArray(peek.hex) ? peek.hex.flatMap((l) => l.split(':')[1].trim().split(/\s+/).map((h) => parseInt(h, 16))) : null;
  check(`${L}: peek answers the person's screen memory byte for byte with no card`, !byName(1).is_error && Array.isArray(got)
    && JSON.stringify(got) === JSON.stringify(want), JSON.stringify(byName(1)).slice(0, 200));
  check(`${L}: machine_info and disassemble answer with no card`, !byName(2).is_error && !byName(3).is_error, JSON.stringify([byName(2), byName(3)]).slice(0, 200));
  check(`${L}: only the acting tool asked; the person said no and it was refused`, asked.join() === 'poke' && byName(4).is_error
    && /consent-declined/.test(byName(4).content), `${asked.join()} ${JSON.stringify(byName(4))}`);
  check(`${L}: the person's machine is unchanged by the turn`, s.readByte(0x3000, person) !== 7 && s.claudeAllowed === false);
  return before;
}

(async () => {
  // ---- the side panel, beside the welcome menu ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    s.startWelcome(WELCOME);
    frames(s, 120);
    const person = s.shownMachine;
    check('panel: (setup) the welcome menu runs on the person\'s machine', s.welcomeRunning);
    const { fetch, calls } = scripted([toolReply([...READS, { name: 'poke', input: { address: 0x3000, bytes: [7] } }]), textReply('It is the welcome menu.')]);
    const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }), brief: 'BRIEF' });
    check('panel: the conversation is beside the person\'s machine, which stays on screen', s.shownMachine === person && !s.chatMachines && chat.target.machine === person);
    await turn('panel (welcome menu)', s, chat, calls, person);
    check('panel: the welcome menu is still on screen', s.shownMachine === person && s.welcomeRunning);
  }
  // ---- the full-screen chat, opened from the welcome menu: the reads go to the BASIC session behind it ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    s.startWelcome(WELCOME);
    frames(s, 120);
    const person = s.shownMachine;
    const { fetch, calls } = scripted([toolReply([...READS, { name: 'poke', input: { address: 0x3000, bytes: [7] } }]), textReply('It is the welcome menu.')]);
    const chat = s.startChat({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: 'BRIEF' });
    check('full screen: the chat machine is on screen, the person\'s machine is the target', s.shownMachine !== person && chat.target.machine === person);
    await turn('full screen (welcome menu behind)', s, chat, calls, person);
  }

  console.log(`\n${n - fail}/${n} passed`);
  process.exit(fail ? 1 : 0);
})();
