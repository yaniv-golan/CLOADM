// Run: node tests/claude-features.test.js
//
// Settings -> "Claude features: On / Off" (Session.claudeFeatures, js/ui/claude-features.js): On by default, kept in
// the store, in a settings export and taken back by an import, a bad value refused. And the Ask panel's line,
// "Nothing is sent until you ask. Then your question, and the screen text and memory Claude reads to answer it, go
// to Anthropic with your key ...", checked against what the code does: with a key saved and the panel's
// conversation started, nothing is fetched; asking sends one request with the question in it; the reads Claude makes
// to answer (screen_text, peek) come back in the next request, to the same API. (The browser check's `settings` and
// `commands` groups check what Off hides on the page.)
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
const textReply = (text) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
const toolReply = (uses) => sse([start, ...uses.flatMap((u, i) => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input || {}) } },
  { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);

(async () => {
  // ---- the setting ----
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  const heard = [];
  s.on((ev, arg) => { if (ev === 'claudefeatures') heard.push(arg); });
  check('Claude features are On by default', s.claudeFeatures === true && s.store.get('claudeFeatures') === null);
  s.setClaudeFeatures(false);
  check('Off is kept, and the page hears it', s.claudeFeatures === false && s.store.get('claudeFeatures') === '0' && heard.join() === 'false');
  const exp = s.exportSettings();
  check('Off is in the settings export', exp.settings.claudeFeatures === '0', JSON.stringify(exp.settings));
  const t = new Emu.Session({ store: Emu.memoryStore() });
  const r = t.importSettings(JSON.stringify(exp));
  check('...and an import in a fresh browser takes it back', r.applied.includes('claudeFeatures') && t.claudeFeatures === false);
  const u = new Emu.Session({ store: Emu.memoryStore() });
  const bad = u.importSettings({ format: 'cloadm-settings', version: 1, settings: { claudeFeatures: 'maybe' } });
  check('a bad value is ignored, and the default stays', bad.ignored.includes('claudeFeatures') && u.claudeFeatures === true);
  s.setClaudeFeatures(true);
  check('On again', s.claudeFeatures === true && s.exportSettings().settings.claudeFeatures === '1' && heard.join() === 'false,true');

  // ---- the line above Ask's input, against the code ----
  const html = fs.readFileSync(path.join(ROOT, 'play/index.html'), 'utf8');
  const LINE = "Nothing is sent until you ask. Then your question, the machine's facts and the chat so far go to Kapai, which runs the AI (or to Anthropic, with your own key or your Claude account in the plugin), and Claude can read the screen and any memory (ROM areas included) without asking. Only changes to the machine ask you first.";
  check('Ask Claude has the line, above its input', html.includes(`<p class="muted" id="askSendsLine">${LINE}</p>`) && html.indexOf('id="askSendsLine"') < html.indexOf('id="askInput"')
    && html.indexOf('id="askSendsLine"') > html.indexOf('id="askComposer"'));
  const KEY = 'sk-ant-FEATURES-TEST-KEY-0123456789';
  const a = new Emu.Session({ store: Emu.memoryStore() });
  a.switchMachine('dragon64');
  a.setClaudeKey(KEY);
  for (let i = 0; i < 60; i++) a.shownMachine.runFrame();
  const calls = [];
  const bodies = [toolReply([{ name: 'screen_text' }, { name: 'peek', input: { address: 0x0400, length: 16 } }, { name: 'peek', input: { address: 0xA000, length: 16 } },
    { name: 'poke', input: { address: 0x3000, bytes: [7] } }]), textReply('It says hello.')];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), key: init.headers['x-api-key'] }); return new Response(bodies[Math.min(calls.length - 1, 1)], { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const asked = [];
  a.consent.asker = (name) => { asked.push(name); Promise.resolve().then(() => a.consent.answer(false)); };
  const chat = a.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }), brief: 'BRIEF: the machine is a Dragon 64' });
  for (let i = 0; i < 30; i++) a.shownMachine.runFrame();
  check('"Nothing is sent until you ask": a key saved and the conversation started, nothing is fetched', calls.length === 0);
  await chat.sendLine('What does my screen say?');
  const first = calls[0], second = calls[1];
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  check('asking sends the question to Anthropic, with the key', !!first && /api\.anthropic\.com/.test(first.url) && first.key === KEY && text(first.body.messages[0]).includes('What does my screen say?'), first && first.url);
  const results = second ? second.body.messages.slice(-1)[0].content : [];
  const screen = a.screenText().join('');
  check('"the machine\'s facts": the brief goes with the question', !!first && JSON.stringify(first.body.system || '').includes('the machine is a Dragon 64'));
  check('"the chat so far": the next request carries the question and Claude\'s turn before it', !!second && text(second.body.messages[0]).includes('What does my screen say?') && second.body.messages.length >= 3);
  check('"Claude can read the screen and any memory (ROM areas included) without asking": screen_text and peek (RAM and the ROM area at $A000) answer with no card, to the same API',
    calls.length === 2 && /api\.anthropic\.com/.test(second.url) && results.length === 4 && !results[0].is_error && screen.trim().length > 0
    && results[0].content.includes(a.screenText().find((l) => l.trim()).trim()) && !results[1].is_error && /0400/.test(results[1].content)
    && !results[2].is_error && /A000/.test(results[2].content) && !asked.includes('screen_text') && !asked.includes('peek'), JSON.stringify(results).slice(0, 300));
  check('"Only changes to the machine ask you first": the poke asked, and declined, changed nothing', asked.includes('poke') && results[3].is_error && a.readByte(0x3000) !== 7, JSON.stringify(asked));
  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
