// Run: node tests/claude-kapai.test.js
//
// The Claude chat through Kapai (js/claude/kapai-backend.js). AGENTS.md 4.6: no MAME oracle (the Claude chat terminal
// row: a mocked backend only, never the real API or Kapai's server); the oracle is the SDK's own mock (mockKapai, the
// vendored copy in js/vendor/kapai/, sdk-reference.md "The mock") and the Messages API's rules as js/claude/history.js
// checks them. No network: agents.md part 6 says not to call the server from automatic tests.
//
// What is proved:
//  A. the conversation's conversion: a Messages API history (text, thinking with its signature, tool_use, tool_result)
//     -> Kapai items (function_call with arguments as JSON text, function_call_output with text output, the thinking as
//     the first call's providerData) -> back to the same Messages API history, unchanged;
//  B. a whole turn on the mock: the first round is a call of the first tool, the backend runs it through runTool, the second's
//     reply quotes its output; the conversation it returns has the tool_use and its tool_result paired, as the
//     ChatSession records it; a ChatSession with this backend and no API key starts a turn and finishes it;
//  C. each refusal becomes the code the views know, with the SDK's error kept for <kapai-limit-prompt>: a limit
//     (daily-limit, out-of-credits) -> 'quota', rate-limited -> 'rate-limited', service-down and offline -> 'network',
//     tools off -> 'tools-off' with the app's own text, an aborted signal -> 'aborted';
//  E. a refused saved key keeps the page's own error code ('invalid-key'), though the SDK wraps it without a cause;
//  F. the saved key's refusal (stop_reason refusal) -> Kapai's incomplete "content_filter" -> the chat's 'refusal';
//  D. the person's own key as Kapai's app-managed own AI (anytime policy): the request goes to the Messages API with
//     the saved key, streams its text, and the second round sends the first's thinking block back with its signature and the
//     tool_result; Kapai's answer source is 'own'; the key is in no message.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const KEY = 'sk-ant-KAPAI-TEST-KEY-0123456789';

(async () => {
  const sdk = await import('../js/vendor/kapai/index.js');
  const kb = await import('../js/claude/kapai-backend.js');
  const { ClaudeBackend, ClaudeError } = await import('../js/claude/backend.js');
  const { ChatSession, machineTools } = await import('../js/claude/chat.js');
  const { apiMessages } = await import('../js/claude/history.js');
  const tools = machineTools();

  // ---- A. conversion
  const thinking = { type: 'thinking', thinking: 'Look at the screen first.', signature: 'SIG-123' };
  const history = [
    { role: 'user', content: 'What is on the screen?' },
    { role: 'assistant', content: [thinking, { type: 'text', text: 'Let me read it.' }, { type: 'tool_use', id: 'toolu_1', name: 'screen_text', input: { rows: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'OK' }] },
    { role: 'assistant', content: 'It says OK.' },
    { role: 'user', content: 'Thanks' },
  ];
  const items = kb.kapaiInput(history);
  check('A: a user line is a user message', items[0].role === 'user' && items[0].content === 'What is on the screen?');
  check('A: the assistant text comes before its call', items[1].role === 'assistant' && items[1].content === 'Let me read it.');
  check('A: tool_use -> function_call, arguments as JSON text', items[2].type === 'function_call' && items[2].call_id === 'toolu_1' && items[2].name === 'screen_text' && items[2].arguments === '{"rows":2}');
  check('A: the thinking rides on the first call as providerData', JSON.stringify(items[2].providerData) === JSON.stringify({ anthropicThinking: [thinking] }));
  check('A: tool_result -> function_call_output with text', items[3].type === 'function_call_output' && items[3].call_id === 'toolu_1' && items[3].output === 'OK');
  check('A: 6 items, the last the new line', items.length === 6 && items[5].content === 'Thanks', JSON.stringify(items.map((i) => i.type || i.role)));
  const back = kb.anthropicMessages(items);
  // (a string content and one text block are the same message to the API: compared as blocks)
  const blocks = (list) => JSON.stringify(list.map((x) => ({ role: x.role, content: typeof x.content === 'string' ? [{ type: 'text', text: x.content }] : x.content })));
  check('A: back to the Messages API history, unchanged', blocks(back) === blocks(apiMessages(history)), JSON.stringify(back));
  const errOut = '{"error":{"code":"consent-declined","remedy":"r"}}';
  const errBack = kb.anthropicMessages([{ role: 'user', content: 'x' }, { type: 'function_call', call_id: 'c1', name: 'poke', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: errOut }, { role: 'user', content: 'y' }]);
  check('A: a tool\'s coded error comes back as a tool_result with is_error', errBack[2].content[0].is_error === true && errBack[2].content[0].content === errOut, JSON.stringify(errBack[2]));
  const okBack = kb.anthropicMessages([{ role: 'user', content: 'x' }, { type: 'function_call', call_id: 'c1', name: 'peek', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '{"error_rate":1}' }, { role: 'user', content: 'y' }]);
  check('A: and a result that only looks like one does not', !('is_error' in okBack[2].content[0]));
  const tk = kb.kapaiTools(tools);
  check('A: tools get parameters, no input_schema', tk.length === tools.length && tk.every((t, i) => t.parameters === tools[i].input_schema && !('input_schema' in t)));
  check('A: and back', JSON.stringify(kb.anthropicTools(tk)) === JSON.stringify(tools.map(({ cache_control, ...t }) => t)));

  // ---- B. a whole turn on the mock
  const ran = [];
  const be = new kb.KapaiBackend({ kapai: sdk.mockKapai('new') });
  be.runTool = async (name, input) => { ran.push([name, input]); return 'SCREEN: READY'; };
  let streamed = '';
  const used = [];
  const res = await be.send({ system: 'brief', messages: [{ role: 'user', content: 'What is on the screen?' }], tools, onText: (t) => { streamed += t; }, onToolUse: (nm) => used.push(nm) });
  check('B: the first tool ran once with {}', ran.length === 1 && ran[0][0] === tools[0].name && JSON.stringify(ran[0][1]) === '{}', JSON.stringify(ran));
  check('B: onToolUse saw it', used.length === 1 && used[0] === tools[0].name);
  check('B: round 2 quotes the output', /SCREEN: READY/.test(res.lastText), JSON.stringify(res.lastText));
  check('B: the text streamed is the text returned', streamed === res.text && res.text.length > 0);
  check('B: one tool call, end_turn', res.toolCalls === 1 && res.stopReason === 'end_turn');
  const m = res.messages;
  check('B: the conversation holds the tool round, paired', m.length === 3 && m[1].role === 'assistant' && m[1].content.some((b) => b.type === 'tool_use') && m[2].content[0].type === 'tool_result' && m[2].content[0].tool_use_id === m[1].content.find((b) => b.type === 'tool_use').id);
  check('B: and the Messages API rules accept it', (() => { try { apiMessages([...m, { role: 'assistant', content: res.lastText }, { role: 'user', content: 'next' }]); return true; } catch (e) { return false; } })());
  // through the ChatSession, with no key anywhere
  const chat = new ChatSession({ backend: new kb.KapaiBackend({ kapai: sdk.mockKapai('new') }), brief: 'b', tools: false });
  let shown = '';
  chat.onText = (t) => { shown += t; };
  const r2 = await chat.sendLine('Hello');
  check('B: a ChatSession with no key starts and ends a turn', !!r2 && !chat.error && /mock answer/.test(shown), JSON.stringify(shown));
  check('B: the turn is recorded', chat.messages.length === 2 && chat.messages[1].role === 'assistant');

  // ---- C. refusals
  const errOf = async (k, opts = {}) => { try { await new kb.KapaiBackend({ kapai: k }).send({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: opts.tools || [], signal: opts.signal }); return null; } catch (e) { return e; } };
  for (const [state, code] of [['daily-limit', 'quota'], ['out-of-credits', 'quota'], ['rate-limited', 'rate-limited'], ['service-down', 'network'], ['offline', 'network']]) {
    const e = await errOf(sdk.mockKapai(state));
    check(`C: ${state} -> ${code}`, e instanceof ClaudeError && e.code === code && !!e.kapai && e.kapai instanceof sdk.KapaiError, e && `${e.code} ${e.message}`);
  }
  const q = await errOf(sdk.mockKapai('daily-limit'));
  check('C: a limit keeps the SDK\'s QuotaExceededError and its message', q.kapai instanceof sdk.QuotaExceededError && q.message === q.kapai.message);
  const off = await errOf(sdk.mockKapai('new', { off: ['tools'] }), { tools });
  check('C: tools off -> tools-off, the app\'s own text', off && off.code === 'tools-off' && off.message === 'This feature is not on for this app yet.', off && `${off.code} ${off.message}`);
  const ac = new AbortController(); ac.abort();
  const ab = await errOf(sdk.mockKapai('new'), { signal: ac.signal });
  check('C: an aborted signal -> aborted', ab && ab.code === 'aborted', ab && `${ab.code} ${ab.message}`);

  // ---- D. the person's own key, app-managed
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1 } } };
  const replies = [
    sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read it.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-OWN' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_own', name: 'screen_text', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]),
    sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY.' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]),
  ];
  const bodies = [], keys = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body)); keys.push(init.headers['x-api-key']);
    const body = replies.shift();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
  };
  const ownAI = sdk.KapaiOwnAI.appManaged({ label: () => 'api.anthropic.com', respond: kb.ownKeyResponder(() => new ClaudeBackend({ fetch, apiKey: KEY })), openSettings: () => {} });
  const own = new kb.KapaiBackend({ kapai: sdk.mockKapai('own-key', { ownAIPolicy: 'anytime', ownAI }) });
  own.runTool = async () => 'READY';
  let ownText = '';
  const r3 = await own.send({ system: 'the brief', messages: [{ role: 'user', content: 'Screen?' }], tools, onText: (t) => { ownText += t; } });
  check('D: two requests to the Messages API, with the saved key', bodies.length === 2 && keys.every((k) => k === KEY), `${bodies.length}`);
  check('D: the brief is the system prompt', JSON.stringify(bodies[0].system).includes('the brief'));
  check('D: the tools go back with input_schema', bodies[0].tools.length === tools.length && bodies[0].tools.every((t) => t.input_schema && !t.parameters));
  const sent2 = bodies[1].messages;
  const asst = sent2.find((x) => x.role === 'assistant');
  check('D: round 2 sends the thinking block back first, with its signature', asst && asst.content[0].type === 'thinking' && asst.content[0].signature === 'SIG-OWN' && asst.content[1].type === 'tool_use' && asst.content[1].id === 'toolu_own', JSON.stringify(asst));
  check('D: and the tool_result', sent2[sent2.length - 1].content[0].type === 'tool_result' && sent2[sent2.length - 1].content[0].content === 'READY');
  check('D: the reply streamed', ownText === 'It says READY.' && r3.lastText === 'It says READY.', JSON.stringify(ownText));
  check('D: Kapai says the own key answered', r3.source === 'own', r3.source);
  check('D: the key is in no message', !JSON.stringify(bodies.map((b) => b.messages)).includes(KEY) && !JSON.stringify(r3.messages).includes(KEY));

  // ---- E. the saved key refused: the SDK reports own_ai_failed with no cause; the page's own error comes back
  const refuse = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 });
  const ownE = kb.ownKeyResponder(() => new ClaudeBackend({ fetch: refuse, apiKey: KEY }));
  const kE = sdk.mockKapai('own-key', { ownAIPolicy: 'anytime', ownAI: sdk.KapaiOwnAI.appManaged({ label: () => 'api.anthropic.com', respond: ownE, openSettings: () => {} }) });
  let eE = null;
  try { await new kb.KapaiBackend({ kapai: kE, ownKey: ownE }).send({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { eE = e; }
  check('E: a refused saved key is the page\'s own invalid-key error, not the SDK\'s own_ai_failed', eE instanceof ClaudeError && eE.code === 'invalid-key', eE && `${eE.code} ${eE.message}`);
  let eF = null;
  try { await new kb.KapaiBackend({ kapai: kE }).send({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { eF = e; }
  check('E: without the responder it is the SDK\'s own message, said once', eF && eF.code === 'bad-response' && /^Your own AI failed: The API key was refused/.test(eF.message) && !/gave an error/.test(eF.message), eF && `${eF.code} ${eF.message}`);

  // ---- F. a refusal of the saved key's model: Kapai's "content_filter" on the way, the chat's 'refusal' at the end
  const refusal = sse([start, { type: 'message_delta', delta: { stop_reason: 'refusal' } }, { type: 'message_stop' }]);
  const fetchR = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(refusal)); c.close(); } }), { status: 200 });
  const ownR = kb.ownKeyResponder(() => new ClaudeBackend({ fetch: fetchR, apiKey: KEY }));
  const kR = sdk.mockKapai('own-key', { ownAIPolicy: 'anytime', ownAI: sdk.KapaiOwnAI.appManaged({ label: () => 'api.anthropic.com', respond: ownR, openSettings: () => {} }) });
  const rR = await new kb.KapaiBackend({ kapai: kR, ownKey: ownR }).send({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  check('F: a refusal of the saved key\'s model is the chat\'s refusal', rR.stopReason === 'refusal' && rR.text === '' && rR.source === 'own', JSON.stringify({ stop: rR.stopReason, src: rR.source }));

  console.log(`${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log("FAIL", (e && e.stack) || e); process.exitCode = 1; });
