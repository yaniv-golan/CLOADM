// Run: node tests/claude-history.test.js
//
// What the chat remembers of a turn (AGENTS.md 4.6, Claude chat terminal: no MAME oracle; a mocked fetch only,
// never the real API; no ROMs). The report: Claude in the Ask panel said it had typed DIR and PROCS, and a
// few turns later said it could find no record of doing so. The history kept only each reply's text, and a turn
// that failed after its tools ran was dropped whole, so the next request held claims and no evidence.
//
// What is proved, through the real ChatSession and ClaudeBackend:
//  A. a turn is recorded whole: turn 1 = text, a type_text call, text; the request of turn 2 carries that tool_use
//     (its id and input) and its tool_result byte for byte as turn 1 sent them, then the reply; what the views show
//     (transcript) is the line and the reply's text exactly as it streamed, as before;
//  B. a turn that fails after a tool ran (a network error, Stop, a stall) keeps the completed rounds and ends with
//     the page's note "(Note from the page: this turn ended with <code> after these tool results.)"; the next
//     request carries the tool_result and the note; a turn that fails before any tool ran leaves the history as it
//     was; the views still show a failed turn the way they did (not at all: the panel shows the failed line itself);
//  trim() drops whole turns only: what is left starts with a person's line and every tool_use keeps its tool_result;
//  the API key is in no message of the history or of any request body (the tool results included).
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const KEY = 'sk-ant-HISTORY-TEST-KEY-0123456789';

// the API, scripted: each request takes the next reply. A reply is { sse } (a body), { network } (fetch rejects),
// { hang } (no answer until the request is aborted: Stop, or the stall limit).
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1 } } };
const textBlock = (i, t) => [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: i }];
const toolBlock = (i, id, name, input) => [{ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index: i }];
const end = (reason) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const reply = (text) => ({ sse: sse([start, ...textBlock(0, text), ...end('end_turn')]) });
const toolCall = (lead, id, name, input) => ({ sse: sse([start, ...(lead ? textBlock(0, lead) : []), ...toolBlock(lead ? 1 : 0, id, name, input), ...end('tool_use')]) });

function api(replies) {
  const bodies = [];
  const fetch = (url, init) => {
    bodies.push({ raw: init.body, json: JSON.parse(init.body) });
    const r = replies.shift() || reply('ok');
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal) { if (init.signal.aborted) { abort(); return; } init.signal.addEventListener('abort', abort, { once: true }); }
      if (r.network) { reject(new TypeError('fetch failed')); return; }
      if (r.hang) return;
      resolve(new Response(r.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });
  };
  return { fetch, bodies };
}

// a Dragon 64 without ROMs (the stub takes typed keys), Ask Claude open, acting allowed
function ask(replies, opts = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64'); frames(s, 40);
  s.setClaudeKey(KEY); s.consent.setAllowed(true);
  const a = api(replies);
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: a.fetch, apiKey: KEY, ...opts }) });
  return { s, chat, a };
}
// one line, with the machine running until the turn ends (type_text waits for the machine to read its keys)
async function line(s, chat, text, during = null) {
  let done = false;
  const p = chat.sendLine(text).then((r) => { done = true; return r; });
  for (let i = 0; i < 3000 && !done; i++) { frames(s, 1); if (during) during(i); await new Promise((r) => setImmediate(r)); }
  return done ? p : 'timeout';
}
const toolResults = (msgs) => msgs.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));

process.exitCode = 1;
(async () => {
  // ---- A. a turn is recorded whole ----
  {
    const { s, chat, a } = ask([toolCall('I will type it. ', 'toolu_A1', 'type_text', { text: 'HI\n' }), reply('Typed HI.'), reply('Yes.')]);
    let seen = null;
    const emit = chat.emitTool.bind(chat);
    chat.emitTool = (nm, i, text, isError, v) => { seen = text; emit(nm, i, text, isError, v); };
    const r1 = await line(s, chat, 'type HI');
    check('A turn 1 ran: text, type_text, text', r1 && r1.toolCalls === 1 && r1.text === 'I will type it. Typed HI.' && seen === '{"requested":3,"consumed":3,"lines_requested":1,"lines_delivered":1}', JSON.stringify(r1 && r1.text));
    const r2 = await line(s, chat, 'did you type it?');
    const t1 = a.bodies[1].json.messages, t2 = a.bodies[2].json.messages;
    // turn 1's second request sent [line, assistant(text, tool_use), user(tool_result)]: turn 2 sends exactly those
    const use = t2[1] && Array.isArray(t2[1].content) ? t2[1].content.find((b) => b.type === 'tool_use') : null;
    check('A the request of turn 2 carries the tool_use with its id and input', use && use.id === 'toolu_A1' && use.name === 'type_text' && JSON.stringify(use.input) === '{"text":"HI\\n"}', JSON.stringify(t2[1]));
    check('A and its tool_result byte for byte as turn 1 sent it', r2 && t2.length === 5 && JSON.stringify(t2.slice(0, 3)) === JSON.stringify(t1)
      && JSON.stringify(t2[2]) === JSON.stringify({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: seen }] })
      && a.bodies[2].raw.includes(JSON.stringify(seen)), JSON.stringify(t2));
    check('A then the reply after the tool (the last request\'s text, not repeated), then the next line', t2[3].role === 'assistant' && t2[3].content === 'Typed HI.' && t2[4].content === 'did you type it?', JSON.stringify(t2.slice(3)));
    check('A the views show what they showed before: the line and the reply exactly as it streamed, no tool round',
      JSON.stringify(Emu.transcript(chat.messages)) === JSON.stringify([{ role: 'user', content: 'type HI', turn: 1 }, { role: 'assistant', content: 'I will type it. Typed HI.', turn: 1 }, { role: 'user', content: 'did you type it?', turn: 2 }, { role: 'assistant', content: 'Yes.', turn: 2 }]),
      JSON.stringify(Emu.transcript(chat.messages)));
    check('A every request was one the API accepts', a.bodies.every((b) => Emu.apiShapeProblem(b.json.messages) === null));
    check('A the key is in no message of the history and no request\'s messages', !JSON.stringify(chat.messages).includes(KEY) && a.bodies.every((b) => !JSON.stringify(b.json.messages).includes(KEY) && !JSON.stringify(b.json.system || '').includes(KEY)));
    s.endChat();
  }

  // ---- B. a turn that fails after a tool ran keeps what ran ----
  for (const [what, code, failing, act, opts] of [
    ['a network error', 'network', { network: true }, null, {}],
    ['Stop', 'aborted', { hang: true }, (s, chat) => chat.abort(), {}],
    ['a stall', 'stalled', { hang: true }, null, { stallMs: 60 }],
  ]) {
    const { s, chat, a } = ask([reply('First.'), toolCall('', 'toolu_B1', 'poke', { address: 0x3000, bytes: [7] }), failing, reply('Next.')], opts);
    await line(s, chat, 'first');
    let stopped = false;
    const r = await line(s, chat, 'poke it', act ? () => { if (!stopped && a.bodies.length === 3) { stopped = true; act(s, chat); } } : null);
    check(`failed turn: ${what}: the turn failed (${code}) after the poke landed`, r === null && chat.error && chat.error.code === code && s.shownMachine.ram[0x3000] === 7, chat.error && chat.error.code);
    const note = `(Note from the page: this turn ended with ${code} after these tool results.)`;
    check(`failed turn: ${what}: the history keeps the line (marked ended), the tool round and the page's note`,
      chat.messages.length === 5 && chat.messages[2].content === 'poke it' && chat.messages[2].ended === code
      && chat.messages[3].content.some((b) => b.type === 'tool_use' && b.id === 'toolu_B1')
      && JSON.stringify(chat.messages[4].content.map((b) => b.type)) === '["tool_result","text"]' && chat.messages[4].content[1].text === note, JSON.stringify(chat.messages.slice(2)));
    await line(s, chat, 'what happened?');
    const next = a.bodies[a.bodies.length - 1].json.messages;
    check(`failed turn: ${what}: the next request carries the tool_result and the note, and is one the API accepts`,
      Emu.apiShapeProblem(next) === null && toolResults(next).length === 1 && toolResults(next)[0].tool_use_id === 'toolu_B1'
      && JSON.parse(toolResults(next)[0].content).written === 1 && JSON.stringify(next).includes(JSON.stringify(note)) && next[next.length - 1].content.slice(-1)[0].text === 'what happened?', JSON.stringify(next.slice(2)));
    check(`failed turn: ${what}: the views show the failed turn as before (not at all; the panel shows the failed line itself)`,
      JSON.stringify(Emu.transcript(chat.messages).map((m) => m.content)) === JSON.stringify(['first', 'First.', 'what happened?', 'Next.']), JSON.stringify(Emu.transcript(chat.messages)));
    s.endChat();
  }
  // a failure before any tool ran: the history is as it was
  for (const [what, failing, opts] of [['a network error', { network: true }, {}], ['a stall', { hang: true }, { stallMs: 60 }]]) {
    const { s, chat } = ask([reply('First.'), failing, reply('Next.')], opts);
    await line(s, chat, 'first');
    const before = JSON.stringify(chat.messages);
    const r = await line(s, chat, 'second');
    check(`failed turn: ${what} before any tool ran: the history is unchanged`, r === null && chat.error && JSON.stringify(chat.messages) === before, JSON.stringify(chat.messages));
    s.endChat();
  }
  // Stop during the second of two tool calls in one reply: the first one's result is kept, the unanswered call is not
  {
    const two = { sse: sse([start, ...toolBlock(0, 'toolu_C1', 'poke', { address: 0x3000, bytes: [1] }), ...toolBlock(1, 'toolu_C2', 'poke', { address: 0x3001, bytes: [2] }), ...end('tool_use')]) };
    const { s, chat, a } = ask([two, reply('Next.')]);
    const inner = chat.runTool.bind(chat);
    chat.runTool = async (nm, input) => { const out = await inner(nm, input); if (input.address === 0x3000) chat.abort(); return out; };
    await line(s, chat, 'poke twice');
    chat.runTool = inner;
    check('failed turn: Stop between two calls of one reply: the first result is kept, the second call is neither run nor kept',
      chat.error.code === 'aborted' && s.shownMachine.ram[0x3000] === 1 && s.shownMachine.ram[0x3001] === 0 && toolResults(chat.messages).map((b) => b.tool_use_id).join() === 'toolu_C1'
      && !JSON.stringify(chat.messages).includes('toolu_C2'), JSON.stringify(chat.messages));
    await line(s, chat, 'and now?');
    check('failed turn: and the next request is one the API accepts', Emu.apiShapeProblem(a.bodies[a.bodies.length - 1].json.messages) === null);
    s.endChat();
  }

  // the page's Stop with a reason (a Reset): the note says why
  {
    const { s, chat, a } = ask([toolCall('', 'toolu_R1', 'poke', { address: 0x3000, bytes: [7] }), { hang: true }, reply('Next.')]);
    let done = false;
    await line(s, chat, 'poke it', () => { if (!done && a.bodies.length === 2) { done = true; chat.abort('you reset the machine'); } });
    const note = chat.messages[chat.messages.length - 1].content.slice(-1)[0].text;
    check('failed turn: a page Stop with a reason: the note carries it', note === '(Note from the page: this turn ended with aborted (you reset the machine) after these tool results.)', note);
    s.endChat();
  }

  // ---- trim drops whole turns ----
  {
    const { s, chat } = ask([]);
    const big = 'x'.repeat(3000);
    const turnOf = (i) => [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'peek', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] }, { role: 'assistant', content: `a${i}` }];
    chat.messages = [0, 1, 2, 3, 4, 5].flatMap(turnOf);
    // a limit that two turns and a bit fit in: only whole turns go, from the front
    chat.trim(2 * JSON.stringify(turnOf(0)).length + 200);
    const left = chat.messages;
    check('trim: what is left is the newest whole turns, starting with a person\'s line', left.length === 8 && left[0].content === 'q4' && Emu.opensTurn(left[0]) && left[7].content === 'a5', JSON.stringify(left.map((m) => (typeof m.content === 'string' ? m.content : m.content[0].type))));
    check('trim: every tool_use keeps its tool_result (nothing for apiMessages to drop)', JSON.stringify(Emu.apiMessages([...left, { role: 'user', content: 'q6' }])) === JSON.stringify([...left, { role: 'user', content: 'q6' }]));
    chat.messages = turnOf(9);
    chat.trim(10);
    check('trim: the newest turn always stays, however large', chat.messages.length === 4 && chat.messages[0].content === 'q9');
    s.endChat();
  }

  console.log(`\n${n - fail}/${n} chat history checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
