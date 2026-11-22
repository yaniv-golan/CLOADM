// Run: node tests/claude-chat.test.js
//
// The Claude chat core, browser-free, with fetch injected: the backend that talks to the
// Anthropic Messages API, the host-side key store, the narrow byte channel between the firmware and the
// backend, and the brief builder. The real API is never called here: every request goes to a mocked fetch.
//
// What is proved:
//  * the request has the documented shape (URL, method, headers, model, streaming, system brief, messages,
//    tools) and the API version header;
//  * streaming SSE is parsed into text deltas in order, tool_use blocks are assembled and run, and the
//    model is called again with the tool_result;
//  * HTTP errors (401 invalid key, 429 rate limited, 500, 529), network errors and a non-JSON error body
//    give one clear message each, and none of them retries;
//  * the key never reaches machine memory, a snapshot, settings export or a share link.
const path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throwsAsync = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- a mocked fetch that speaks SSE the way the Messages API does ----
// events: [{event, data}] -> the text/event-stream body
const sse = (events) => events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
const textStream = (text, { stop_reason = 'end_turn', chunks = null } = {}) => {
  const parts = chunks || [text];
  const ev = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ...parts.map((t) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  return sse(ev);
};
// a fetch that answers with one scripted response and records what it was asked
function mockFetch(responder) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const r = responder(calls.length - 1, calls[calls.length - 1]);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}
// the system prompt's text, whether it arrived as a string or as the cached block array the backend sends now
const sysText = (body) => typeof body.system === 'string' ? body.system
  : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : '';
const okStream = (text, opts) => () => new Response(textStream(text, opts), {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});
// Node has Response/ReadableStream; js/ may not touch DOM globals, but the test may use Node's web globals
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---- 1. the request shape ----
(async () => {
  {
    const { fetch, calls } = mockFetch(okStream('Hello there.', { chunks: ['Hello', ' there', '.'] }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'sk-ant-test-key', model: 'claude-opus-5-5' });
    const got = [];
    const res = await backend.send({ text: 'hi', system: 'BRIEF', messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (t) => got.push(t) });
    check('one request when there is no tool call', calls.length === 1, `(${calls.length})`);
    const c = calls[0];
    check('the URL is the Messages endpoint', c.url === 'https://api.anthropic.com/v1/messages', c.url);
    check('it is a POST with the API key and version headers', c.init.method === 'POST'
      && c.init.headers['x-api-key'] === 'sk-ant-test-key' && !!c.init.headers['anthropic-version'], JSON.stringify(c.init.headers));
    check('it sends the browser-access header the API needs for a call from a page (CORS)', c.init.headers['anthropic-dangerous-direct-browser-access'] === 'true');
    check('it asks for streaming', c.body.stream === true);
    check('the model and max_tokens are sent', c.body.model === 'claude-opus-5-5' && Number.isInteger(c.body.max_tokens) && c.body.max_tokens > 0, JSON.stringify({ m: c.body.model, mt: c.body.max_tokens }));
    // the brief is the system prompt, as one text block carrying the cache breakpoint (see the caching tests)
    check('the brief is the system prompt', sysText(c.body) === 'BRIEF', JSON.stringify(c.body.system));
    check('the conversation is sent as messages', Array.isArray(c.body.messages) && c.body.messages[0].content === 'hi');
    check('no tools key when there are none', !('tools' in c.body));
    check('the streamed text arrives in order, delta by delta', got.join('') === 'Hello there.' && got.length === 3, JSON.stringify(got));
    check('the result carries the full text and stop reason', res.text === 'Hello there.' && res.stopReason === 'end_turn', JSON.stringify({ t: res.text, s: res.stopReason }));
    check('no thinking parameter is sent (adaptive is the model default)', !('thinking' in c.body));
  }

  // ---- 2. tools: a tool_use block is assembled from its input_json_delta, then the loop runs the result ----
  {
    const toolEvents = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'peek', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"address":1024,' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"length":4}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? toolEvents : textStream('Done.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const seen = [];
    const backend = new Emu.ClaudeBackend({
      fetch, apiKey: 'k',
      // the tool executor is injected; it returns a string for the tool_result
      runTool: async (name, input) => { seen.push({ name, input }); return '12 34 56 78'; },
    });
    const res = await backend.send({
      system: 'BRIEF', messages: [{ role: 'user', content: 'peek' }],
      tools: [{ name: 'peek', description: 'read memory', input_schema: { type: 'object', properties: { address: { type: 'number' }, length: { type: 'number' } }, required: ['address', 'length'] } }],
    });
    check('the tool was called once with the assembled JSON input', seen.length === 1 && seen[0].name === 'peek'
      && seen[0].input.address === 1024 && seen[0].input.length === 4, JSON.stringify(seen));
    check('a second request is made after the tool result', calls.length === 2, `(${calls.length})`);
    const second = calls[1].body;
    const last2 = second.messages.slice(-2);
    check('the assistant tool_use turn and the user tool_result turn are appended',
      last2[0].role === 'assistant' && last2[0].content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1')
      && last2[1].role === 'user' && last2[1].content[0].type === 'tool_result' && last2[1].content[0].tool_use_id === 'toolu_1'
      && last2[1].content[0].content === '12 34 56 78', JSON.stringify(last2));
    check('the final answer text comes back', res.text === 'Done.' && res.toolCalls === 1, JSON.stringify({ t: res.text, n: res.toolCalls }));
    check('the tools schema was passed on both requests', calls[0].body.tools.length === 1 && calls[1].body.tools.length === 1);
  }
  // a tool that throws is reported to the model as is_error, and does not abort the chat
  {
    const toolEvents = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'poke', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"address":70000}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? toolEvents : textStream('Sorry.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: async () => { throw new Error('address out of range'); } });
    const res = await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'poke' }] });
    const tr = calls[1].body.messages.slice(-1)[0].content[0];
    check('a tool error is returned to the model as is_error', tr.type === 'tool_result' && tr.is_error === true && /out of range/.test(tr.content), JSON.stringify(tr));
    check('the chat continues after a tool error', res.text === 'Sorry.');
  }
  // a CODED error (ToolError) reaches the model as JSON: the code, the remedy and what it sent, with is_error
  {
    const toolEvents = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_3', name: 'peek', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"address":70000}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? toolEvents : textStream('Sorry.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const seen = [];
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: async () => { throw new Emu.ToolError(Emu.TOOL_CODES.BAD_ADDRESS, 70000); } });
    await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'peek' }], onToolUse: (n, i, text, isError, value) => seen.push({ n, text, isError, value }) });
    const tr = calls[1].body.messages.slice(-1)[0].content[0];
    let parsed = null;
    try { parsed = JSON.parse(tr.content); } catch (e) { /* not JSON */ }
    check('a coded error reaches the model as JSON with the code and remedy',
      tr.type === 'tool_result' && tr.is_error === true && parsed && parsed.error.code === Emu.TOOL_CODES.BAD_ADDRESS
      && /0 to 65535/.test(parsed.error.remedy) && parsed.error.detail === '70000', JSON.stringify(tr));
    check('the is_error flag always accompanies a coded error, and onToolUse is told both', seen.length === 1
      && seen[0].isError === true && seen[0].value instanceof Emu.ToolError && seen[0].text === tr.content, JSON.stringify(seen.map((x) => ({ i: x.isError, t: x.text }))));
  }
  // a tool that returns an OBJECT hands the model JSON, not "[object Object]"
  {
    const toolEvents = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_4', name: 'peek', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"address":768}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? toolEvents : textStream('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = { address: 768, length: 2, bytes: [1, 2], truncated: false };
    const seen = [];
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: async () => result });
    await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'peek' }], onToolUse: (n, i, text, isError, value) => seen.push({ text, isError, value }) });
    const tr = calls[1].body.messages.slice(-1)[0].content[0];
    check('an object result reaches the model as JSON, never "[object Object]"',
      !/object Object/.test(tr.content) && JSON.parse(tr.content).address === 768 && tr.is_error === undefined, tr.content);
    check('onToolUse receives the text the model got and the raw object', seen[0].text === tr.content && seen[0].value === result && seen[0].isError === false);
  }

  // ---- 2b. thinking blocks survive the tool loop ----
  // Opus 5.5 always thinks, so a tool-call reply carries a thinking block with a signature. The second
  // request must send that block back exactly as it came: the API rejects a thinking block whose signature
  // was dropped, and it rejects the whole request, so the tool loop would fail on the second round.
  {
    const withThinking = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_th', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The person wants ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'memory read.' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'peek', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"address":1024}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Reading.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? withThinking : textStream('Done.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: async () => 'ok' });
    const res = await backend.send({ system: 'B', messages: [{ role: 'user', content: 'read 1024' }], tools: [{ name: 'peek' }] });
    check('the tool loop made the second request', calls.length === 2, `(${calls.length})`);
    const sentBack = calls.length === 2 ? calls[1].body.messages : [];
    const assistant = sentBack.find((m) => m.role === 'assistant');
    const think = assistant && assistant.content.find((b) => b.type === 'thinking');
    check('the thinking block is sent back in the second request', !!think, JSON.stringify(assistant && assistant.content));
    check('the thinking text is kept, assembled from thinking_delta',
      !!think && think.thinking === 'The person wants memory read.', think && JSON.stringify(think.thinking));
    check('the thinking signature is kept, from signature_delta',
      !!think && think.signature === 'sig-abc', think && JSON.stringify(think.signature));
    check('the tool_use block is still there beside it',
      !!assistant && assistant.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_9'), JSON.stringify(assistant && assistant.content));
    check('the text block is still there too',
      !!assistant && assistant.content.some((b) => b.type === 'text' && b.text === 'Reading.'), JSON.stringify(assistant && assistant.content));
    check('the thinking text is not streamed to the screen', res.text === 'Reading.Done.' || res.text === 'Reading.' + 'Done.', JSON.stringify(res.text));
  }

  // ---- 2c. a block type the parser does not know is passed back as it came ----
  {
    const odd = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_od', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"dragon 32"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'peek', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"address":0}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, calls } = mockFetch((i) => new Response(i === 0 ? odd : textStream('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: async () => 'r' });
    await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'peek' }] });
    const assistant = calls.length === 2 ? calls[1].body.messages.find((m) => m.role === 'assistant') : null;
    const kept = assistant && assistant.content.find((b) => b.type === 'server_tool_use');
    check('an unknown block type is passed back with its type and fields', !!kept && kept.id === 'srvtoolu_1' && kept.name === 'web_search',
      JSON.stringify(assistant && assistant.content));
  }

  // ---- 3. errors: one clear message each, and no retry ----
  const errCases = [
    ['an invalid key (401)', json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), /api key/i, 'invalid-key'],
    ['a permission error (403)', json(403, { type: 'error', error: { type: 'permission_error', message: 'no' } }), /permission/i, 'forbidden'],
    ['rate limited (429)', json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), /rate limit|too many/i, 'rate-limited'],
    ['a server error (500)', json(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }), /service|server/i, 'server-error'],
    ['overloaded (529)', json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), /overloaded|busy/i, 'server-error'],
    ['an error body that is not JSON', () => new Response('<html>gateway</html>', { status: 502 }), /service|server|502/i, 'server-error'],
  ];
  for (const [name, responder, re, code] of errCases) {
    const { fetch, calls } = mockFetch(responder);
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    let e = null;
    try { await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }] }); } catch (err) { e = err; }
    check(`${name}: one clear message`, e instanceof Emu.ClaudeError && re.test(e.message), e ? `${e.code}: ${e.message}` : 'no error');
    check(`${name}: classified as ${code}`, e && e.code === code, e && e.code);
    check(`${name}: no retry (exactly one request)`, calls.length === 1, `(${calls.length})`);
  }
  {
    const { fetch, calls } = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    let e = null;
    try { await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }] }); } catch (err) { e = err; }
    check('a network error is a clear message', e instanceof Emu.ClaudeError && e.code === 'network' && /network|offline|connect/i.test(e.message), e && e.message);
    check('a network error is not retried', calls.length === 1);
  }
  {
    // no key at all is refused before any request is made
    const { fetch, calls } = mockFetch(okStream('x'));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: '' });
    check('no key is refused without a request', await throwsAsync(() => backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }] }), /api key/i) && calls.length === 0);
  }
  {
    // a stream that carries an error event mid-way stops with that message
    const stream = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Par' } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } } },
    ]);
    const { fetch, calls } = mockFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    const partial = [];
    let e = null;
    try { await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }], onText: (t) => partial.push(t) }); } catch (err) { e = err; }
    check('a mid-stream error event is a clear error', e instanceof Emu.ClaudeError && /overloaded/i.test(e.message), e && e.message);
    check('text received before the error is kept', partial.join('') === 'Par', JSON.stringify(partial));
    check('a mid-stream error is not retried', calls.length === 1);
  }
  // an aborted request (BREAK) stops with its own error and does not retry
  {
    const { fetch, calls } = mockFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    let e = null;
    try { await backend.send({ system: 'B', messages: [{ role: 'user', content: 'x' }] }); } catch (err) { e = err; }
    check('an aborted request is reported as aborted', e instanceof Emu.ClaudeError && e.code === 'aborted', e && `${e.code}: ${e.message}`);
    check('an aborted request is not retried', calls.length === 1);
  }

  // ---- 4. the key never leaves the host ----
  {
    const KEY = 'sk-ant-UNIQUE-KEY-1234567890';
    const keyStore = new Emu.MemoryKeyStore();
    keyStore.set(KEY);
    check('the key store keeps the key on the host', keyStore.get() === KEY);
    check('the key store can be cleared', (() => { keyStore.clear(); return keyStore.get() === null; })());

    // a chat Session never puts the key in the machine, a snapshot, a settings export or a share link
    const s = new Emu.Session({ store: Emu.memoryStore(), keyStore });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    for (let i = 0; i < 3; i++) s.shownMachine.runFrame();
    check('setClaudeKey stores the key host-side, not in the emulated machine', s.keyStore.get() === KEY);
    const snapText = Emu.state.toJSON(s.shownMachine.snapshot());
    check('a snapshot does not contain the key', !snapText.includes(KEY));
    const exp = JSON.stringify(s.exportSettings());
    check('a settings export does not contain the key', !exp.includes(KEY) && !/sk-ant/.test(exp), exp.slice(0, 80));
    const share = s.shareUrl('https://cloadm.dev/play/');
    check('a share link does not contain the key', !share.includes(KEY) && !/key/i.test(new URL(share).search), share);
    // the machine's 64K of RAM does not contain it either
    const ramHasKey = Buffer.from(s.shownMachine.ram).includes(Buffer.from(KEY));
    check('the emulated machine memory does not contain the key', !ramHasKey);
  }

  // ---- 5. the brief builder ----
  {
    const brief = Emu.claudeBrief({ machine: 'Tandy Color Computer 1/2', ram: 64, cpu: '6809', software: 'none', family: 'dragon', view: 'full', edition: 'cloadm.dev', tools: true });
    check('the full-screen brief names the chat screen\'s real size for the replies, and plain text', brief.includes(`full-screen chat: ${Emu.CHAT_SCREEN.cols} columns by ${Emu.CHAT_SCREEN.rows} rows`)
      && !/48 columns|80 columns/.test(brief) && /plain text/i.test(brief), brief.match(/Your replies[^.]*/)[0]);
    check('the brief carries the per-call facts', brief.includes('Tandy Color Computer 1/2') && brief.includes('6809') && /64\s?K|64/.test(brief));
    // the Glossary's words, as on the page: without ROMs, never "the stub"
    check('the brief says the machine runs without ROMs, not "the stub"', /runs without ROMs/.test(brief) && !/\bstub\b/i.test(brief), brief.match(/[^.]*ROMs[^.]*\./g));
    check('the brief says everything is emulated and undoable', /emulated/i.test(brief) && /undo/i.test(brief));
    check('the brief says it is not LIZA', /LIZA/.test(brief));
    check('the brief explains BASIC line numbers and uppercase keywords', /line number/i.test(brief) && /uppercase/i.test(brief));
    const noTools = Emu.claudeBrief({ machine: 'X', ram: 32, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'cloadm.dev', tools: false });
    check('the brief leaves the tools out when they are off', !/can use the machine|machine tools/i.test(noTools) || /cannot|no access|aren't available/i.test(noTools));
    const c3 = Emu.claudeBrief({ machine: 'CoCo 3', ram: 512, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'cloadm.dev', tools: true });
    check('the CoCo 3 full-screen brief gives the same 42 columns for the replies (the firmware has no 80-column mode yet)', c3.includes('full-screen chat: 42 columns by 24 rows'), c3.match(/Your replies[^.]*/)[0]);

    // D: the brief does not assume BASIC, gives the machine's own screen, and says how far a tool's success goes
    const facts = (o) => Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', edition: 'test', tools: true, view: 'panel', family: 'dragon', software: 'basic', ...o });
    const rule = 'An acting tool\'s success means the keys or bytes reached the machine, not that the program did what you wanted. Check the effect with screen_text, peek or machine_info before you say it happened. If you can\'t read the result, say it is unverified.';
    check('D the brief states the verify rule whenever tools are on (and the contract carries it)', facts({}).includes(rule) && Emu.TOOL_CONTRACT.includes(rule) && !facts({ tools: false }).includes(rule));
    const none = facts({ software: 'none' }), nos9 = facts({ software: 'nitros9' }), withBasic = facts({});
    check('D a machine without BASIC ROMs: the brief does not claim BASIC', /No BASIC ROMs are loaded/.test(none) && !/BASIC ROMs are loaded;|BASIC is available|BASIC\'s prompt/.test(none), none.slice(-400));
    check('D NitrOS-9 running: the brief says so and that BASIC does not apply, not that BASIC is available', /NitrOS-9 is running/.test(nos9) && /BASIC commands and BASIC programs do not apply/.test(nos9) && !/BASIC ROMs are loaded;|BASIC is available/.test(nos9), nos9.slice(-400));
    check('D BASIC ROMs in: the brief says a program may be running rather than assuming BASIC\'s prompt', /BASIC ROMs are loaded; what runs now may be BASIC's prompt or a program, so do not assume either\./.test(withBasic) && !/BASIC is available/.test(withBasic));
    check('D an unknown software state is refused (the page must say what runs)', (() => { try { facts({ software: undefined }); return false; } catch (e) { return /software must be one of/.test(e.message); } })());
    check('D the brief gives the machine\'s own screen (32 by 16 on the MC6847 machines), and the panel brief does not give the chat firmware\'s',
      withBasic.includes('Its screen: 32 columns by 16 rows of text (MC6847).') && !/42 columns|24 rows/.test(withBasic) && facts({ family: 'mc10' }).includes('Its screen: 32 columns by 16 rows of text (MC6847).'), withBasic.match(/Its screen[^.]*\./)[0]);
    check('D the CoCo 3 and the Dragon 64 Plus: their wider screens are named', /GIME can also show 40, 64 or 80 columns/.test(facts({ family: 'coco3' })) && /80-column display/.test(facts({ family: 'd64plus' })));
    check('D a brief with no view is refused (the replies are read somewhere)', (() => { try { facts({ view: undefined }); return false; } catch (e) { return /view must be/.test(e.message); } })());
    check('D the fixed prose no longer puts the person on the chat firmware\'s screen', !/small green screen|chat font/.test(Emu.FIXED_BRIEF) && /chat font/.test(facts({ view: 'full' })) && !/chat font/.test(withBasic));

    // js/host/claude-brief.md is the prose a reader can edit; the page reads it and passes it as `base`.
    // The built-in copy is what Node tests and an embedder get without a file, so the two must not drift.
    const fs = require('fs');
    const briefPath = require('path').join(__dirname, '..', 'js/host/claude-brief.md');
    const onDisk = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, 'utf8') : null;
    check('js/host/claude-brief.md exists', onDisk !== null, briefPath);
    const norm = (s) => String(s).replace(/\r\n/g, '\n').trim();
    check('the built-in brief is kept in step with js/host/claude-brief.md',
      onDisk !== null && norm(onDisk) === norm(Emu.FIXED_BRIEF),
      onDisk === null ? 'no file' : JSON.stringify({ file: norm(onDisk).slice(0, 80), code: norm(Emu.FIXED_BRIEF).slice(0, 80) }));
    // and what the file holds is the prose alone: the builder adds the screen line and the facts
    check('the file is the fixed prose, not the assembled brief',
      onDisk !== null && !/^Machine:/m.test(onDisk) && !/^Screen:/m.test(onDisk), onDisk === null ? '' : 'has assembled parts');
  }

  // ---- 6. the firmware <-> backend byte channel (the narrow seam, the DriveWireChannel contract) ----
  {
    // send() is bytes toward the machine; fromMachine() is bytes from it (the DriveWireChannel names)
    const channel = new Emu.MemoryChannel();
    const fromMachine = [];
    channel.onReceive = (b) => fromMachine.push(b);
    channel.fromMachine(Uint8Array.of(65, 66));
    check('bytes from the machine reach onReceive', Buffer.from(fromMachine[0]).equals(Buffer.from('AB')), JSON.stringify(fromMachine));
    check('the channel reports nothing pending before the backend sends', channel.poll() === null);
    const r = channel.send(Uint8Array.of(67));
    check('send reports what it accepted and what is queued', r.accepted === true && r.queued === 1, JSON.stringify(r));
    check('poll returns one byte toward the machine', channel.poll() === 67);
    check('and then nothing', channel.poll() === null);
    // a full channel accepts what fits and says so; ready() waits for room; nothing accepted is lost
    const small = new Emu.MemoryChannel(2);
    const a = small.send(Uint8Array.of(1, 2, 3));
    check('a full channel accepts only what fits', a.accepted === false && a.queued === 2 && small.room === 0, JSON.stringify(a));
    check('canSend is false when full', small.canSend === false);
    let readyFired = false;
    const wait = small.ready().then(() => { readyFired = true; });
    await Promise.resolve(); await Promise.resolve();
    check('ready() waits while full', !readyFired);
    small.poll();
    await wait;
    check('ready() resolves when room comes back', readyFired);
    check('close fires onReceive(null) once and refuses sends', (() => {
      let nulls = 0; const c = new Emu.MemoryChannel();
      c.onReceive = (b) => { if (b === null) nulls++; };
      c.close(); c.close();
      return nulls === 1 && c.closed && c.send(Uint8Array.of(1)).accepted === false;
    })());
    // a chat session wires a typed line to the backend and the reply back down the channel
    const { fetch, calls } = mockFetch(okStream('Hi from Claude.'));
    const chat = new Emu.ChatSession({
      backend: new Emu.ClaudeBackend({ fetch, apiKey: 'k' }), channel: new Emu.MemoryChannel(), brief: 'BRIEF',
    });
    await chat.sendLine('hello there');
    check('a typed line becomes one user turn', calls[0].body.messages.slice(-1)[0].content === 'hello there', JSON.stringify(calls[0].body.messages));
    check('the reply is kept as the assistant turn', chat.messages.slice(-1)[0].role === 'assistant' && /Hi from Claude\./.test(chat.messages.slice(-1)[0].content), JSON.stringify(chat.messages.slice(-1)));
    check('the brief is the system prompt', sysText(calls[0].body) === 'BRIEF');
    // a typed line ending in CR is a complete line
    const chat2 = new Emu.ChatSession({ backend: new Emu.ClaudeBackend({ fetch, apiKey: 'k' }), channel: new Emu.MemoryChannel(), brief: 'BRIEF' });
    chat2.receive('hello\r');
    await new Promise((r2) => setTimeout(r2, 20));
    check('a CR-terminated typed line is sent, and the reply arrives as bytes toward the machine', chat2.messages.length === 2, JSON.stringify(chat2.messages));
  }

  // ---- 8. a refused reply says so on the screen ----
  // stop_reason "refusal" means the model declined; the person should be told rather than left with an empty
  // reply and no explanation.
  {
    const refusal = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_r', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch } = mockFetch(() => new Response(refusal, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const channel = new Emu.MemoryChannel();
    const chat = new Emu.ChatSession({ backend: new Emu.ClaudeBackend({ fetch, apiKey: 'k' }), channel, brief: 'B' });
    chat.receive('something it will not answer\r');
    await new Promise((r3) => setTimeout(r3, 20));
    const said = String.fromCharCode(...channel.read());
    check('a refusal is explained on the screen', /declined|refus/i.test(said), JSON.stringify(said));
  }

  // ---- 9. undo: a tool's change can be put back ----
  // a snapshot of the BASIC session is taken before Claude's first change in a turn, and "Undo
  // Claude's changes" restores it. The chat is started the way the page starts it (Session.startChat), so the
  // tools act on Session.chatTarget(); each turn is a backend whose reply runs the given tool calls.
  {
    const fs = require('fs');
    const s = new Emu.Session();
    s.switchMachine('dragon64');
    for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const basic = s.shownMachine;
    const turns = [];   // each turn: [[tool, input], ...]
    const backend = { send: async () => { for (const [name, input] of turns.shift() || []) await backend.runTool(name, input); return { text: 'Done.', stopReason: 'end_turn' }; } };
    const firmware = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
    const chat = s.startChat({ backend, channel: new Emu.MemoryChannel(), firmware, tools: true });
    s.consent.setAllowed(true);   // acting needs "Let Claude use the emulator"; these turns act
    // a turn settles when its tools do; type_text waits for the machine to read its keys, so the machines run
    // (frames) until the turn has ended
    const turn = async (...calls) => {
      turns.push(calls);
      let done = false; const p = chat.sendLine('do it').then(() => { done = true; });
      for (let i = 0; i < 4000 && !done; i++) { s.advance(1000 / s.shownMachine.fps + 0.01); await new Promise((r) => setImmediate(r)); }
      await p;
    };
    // a poke, then undo: the byte goes back to what it was
    const before = basic.ram[0x4000];
    await turn(['poke', { address: 0x4000, bytes: [before ^ 0xFF] }]);
    check('a poke changes the BASIC session\'s memory', basic.ram[0x4000] === (before ^ 0xFF), `$${basic.ram[0x4000].toString(16)}`);
    check('the poke took a restore point', chat.undo.length === 1, `${chat.undo.length}`);
    check('undoLast reports that it undid something', chat.undoLast() === true);
    check('undo restores the byte', basic.ram[0x4000] === before, `$${basic.ram[0x4000].toString(16)}`);
    check('the undo stack is empty after undoing', chat.undo.length === 0, `${chat.undo.length}`);
    check('undoLast with nothing to undo reports so', chat.undoLast() === false);
    // typing is undoable the same way: the restore point is the machine before the first key, and undo returns to it
    const taken = basic.stubKeysTaken;
    const shows = () => s.screenText(basic).some((l) => l.includes('HELLO'));
    const showedBefore = shows();
    await turn(['type_text', { text: 'HELLO' }]);
    check('typing delivers the keys: the stub took all 5 and the BASIC session shows HELLO', basic.stubKeysTaken - taken === 5 && !showedBefore && shows(), `${basic.stubKeysTaken - taken} taken`);
    check('typing took a restore point too', chat.undo.length === 1, `${chat.undo.length}`);
    chat.undoLast();
    check('undo returns the BASIC session to before the typing: HELLO is gone, nothing queued', !shows() && !basic.typist.busy && basic.stubKeys.length === 0, s.screenText(basic).join('|'));
    // one restore point per turn, and the stack keeps at most the last 10, dropping the oldest
    for (let i = 0; i < 14; i++) await turn(['poke', { address: 0x4010, bytes: [i] }], ['poke', { address: 0x4011, bytes: [i] }]);
    check('the undo stack keeps the last 10 turns only', chat.undo.length === 10, `${chat.undo.length}`);
    s.endChat();
  }

  // ---- the chat on a Dragon 64 Plus with its 80-column screen chosen ----
  // The chat machine is built with the BASIC session's config; it must still show its own VDG screen (the
  // firmware draws there, and the chat machine has no 80-column character generator, so the plus view drew
  // nothing: a blank chat). The BASIC session keeps the person's choice, in and out of the chat.
  {
    const fs = require('fs');
    const s = new Emu.Session();
    s.switchMachine('d64plus');
    s.setDisplay({ screen: 'plus' });
    const basic = s.shownMachine;
    check('d64plus: the 80-column screen chosen for BASIC', basic.view === 'plus');
    const backend = { send: async () => ({ text: 'Hi.', stopReason: 'end_turn' }) };
    const firmware = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
    s.startChat({ backend, channel: new Emu.MemoryChannel(), firmware, tools: false });
    for (let i = 0; i < 60; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const chat = s.shownMachine;
    // what is drawn: lit pixels in the frame, and in row 0 the prompt alone (its cell, nothing after it)
    const lit = (f, x0, y0, x1, y1) => { const px = Emu.frameToRGBA(f); let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((px[y * f.width + x] & 0xff00) > 0x8000) n++; return n; };
    const f = chat.render(), bx = Emu.MC6847.BORDER_X, by = Emu.MC6847.BORDER_Y;
    const all = lit(f, bx, by, bx + 256, by + 192), prompt = lit(f, bx, by, bx + 8, by + 8), rest = lit(f, bx + 8, by, bx + 256, by + 8);
    check('d64plus, plus chosen: the chat machine shows its VDG screen, not the 80-column one', chat !== basic && chat.view === 'vdg' && f.width === 320 && f.height === 240,
      `${chat.view} ${f.width}x${f.height}`);
    check('d64plus, plus chosen: the chat screen is drawn (lit pixels), its prompt in row 0', all > 0 && prompt > 0 && rest === 0, `${all} lit, prompt ${prompt}, rest of row 0 ${rest}`);
    check('d64plus: the setting stays the person\'s (plus)', s.display.screen === 'plus');
    s.showChat('basic');
    check('d64plus: "Show my BASIC session" shows the BASIC session on its 80-column screen', s.shownMachine === basic && basic.view === 'plus');
    s.showChat('chat');
    check('d64plus: back to the chat, its VDG screen again', s.shownMachine === chat && chat.view === 'vdg');
    s.endChat();
    check('d64plus: after the chat, the BASIC session on its 80-column screen', s.shownMachine === basic && basic.view === 'plus');
  }

  // ---- prompt caching ----
  // The Messages API is stateless and the chat resends the whole conversation every round (up to 8 tool
  // rounds), so without caching the brief and every earlier turn are paid for at full price on every request.
  // The backend puts one explicit breakpoint on the last system block (which, in render order tools ->
  // system -> messages, caches the tool list and the whole brief together) and one top-level automatic
  // breakpoint that follows the growing conversation. These checks pin the request shape and, above all, the
  // property that makes caching work: the shared prefix must be byte-identical from one turn to the next.
  {
    const { fetch, calls } = mockFetch(okStream('Hi.'));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    const brief = 'You are CLOADM\'s assistant. Machine: Dragon 64.';
    const tools = Emu.machineTools();
    await backend.send({ system: brief, messages: [{ role: 'user', content: 'hello' }], tools });

    const b = calls[0].body;
    // system is one text block, and ONLY the last system block carries the marker
    check('the system prompt is a block array', Array.isArray(b.system) && b.system.length === 1 && b.system[0].type === 'text', JSON.stringify(b.system));
    check('the system prompt text is unchanged by caching', b.system[0].text === brief);
    check('the last system block carries the cache breakpoint', b.system[b.system.length - 1].cache_control
      && b.system[b.system.length - 1].cache_control.type === 'ephemeral', JSON.stringify(b.system.slice(-1)));
    // top-level automatic caching for the growing tail
    check('automatic caching is on for the conversation', b.cache_control && b.cache_control.type === 'ephemeral', JSON.stringify(b.cache_control));
    // the tools are sent unmarked (the system breakpoint caches them: tools render before system)
    check('the tools are sent unchanged, with no marker of their own', Array.isArray(b.tools) && b.tools.length === tools.length
      && b.tools.every((t) => !('cache_control' in t)), `${b.tools.length} tools`);
    // never more than the 4 breakpoints the API allows (1 explicit + 1 automatic here)
    const markers = (JSON.stringify(b.system).match(/"cache_control"/g) || []).length + (b.cache_control ? 1 : 0);
    check('the request stays within the 4-breakpoint limit', markers <= 4, `${markers} breakpoints`);

    // the caller's string/system value is not mutated (a caller may reuse it for the next turn)
    check('the caller\'s system string is not mutated', typeof brief === 'string' && brief === 'You are CLOADM\'s assistant. Machine: Dragon 64.');
  }

  // The stable-prefix property, across turns and across a tool round: whatever the conversation does at the
  // END, the rendered prefix (tools + system) must stay byte-identical, or nothing after the change caches.
  {
    const { fetch, calls } = mockFetch((i) => new Response(
      i === 0 ? sse([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [] } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'screen_text', input: {} } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]) : textStream('Done.'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k', runTool: () => 'SCREEN' });
    const tools = Emu.machineTools();
    const brief = 'A stable brief.';
    // turn 1: two requests (the tool round)
    await backend.send({ system: brief, messages: [{ role: 'user', content: 'one' }], tools });
    // turn 2: the conversation grew by the assistant + tool turns; the prefix must be the same bytes
    await backend.send({ system: brief, messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'two' }], tools });

    const prefix = (body) => JSON.stringify({ tools: body.tools, system: body.system });
    const first = prefix(calls[0].body);
    check('the tools+system prefix is byte-identical across a tool round', prefix(calls[1].body) === first);
    check('the tools+system prefix is byte-identical across turns', prefix(calls[2].body) === first);
    check('and the whole conversation of the tool round was resent (the API is stateless)', calls[1].body.messages.length === 3
      && calls[1].body.messages[1].role === 'assistant' && calls[1].body.messages[2].content[0].type === 'tool_result');

    // the counter-example: a brief that carries a clock would change the prefix every turn
    const stamp = (t) => `Brief at ${t}.`;
    await backend.send({ system: stamp('10:00'), messages: [{ role: 'user', content: 'a' }], tools });
    await backend.send({ system: stamp('10:01'), messages: [{ role: 'user', content: 'b' }], tools });
    check('a timed brief breaks the prefix (which is why the real brief carries no clock)',
      prefix(calls[3].body) !== prefix(calls[4].body));
  }

  // usage is surfaced so a real caller can verify caching: cache_read_input_tokens on a repeat request
  {
    const withUsage = (read) => sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [],
        usage: { input_tokens: 10, cache_creation_input_tokens: read ? 0 : 900, cache_read_input_tokens: read } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch } = mockFetch((i) => new Response(withUsage(i === 0 ? 0 : 900), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: 'k' });
    const msgs = [{ role: 'user', content: 'same' }];
    const r1 = await backend.send({ system: 'B', messages: msgs, tools: Emu.machineTools() });
    const r2 = await backend.send({ system: 'B', messages: msgs, tools: Emu.machineTools() });
    check('the first request reports a cache write', r1.usage && r1.usage.cache_creation_input_tokens === 900 && r1.usage.cache_read_input_tokens === 0, JSON.stringify(r1.usage));
    check('the repeat request reports cache_read_input_tokens', r2.usage && r2.usage.cache_read_input_tokens === 900, JSON.stringify(r2.usage));
    check('usage is merged from message_start and message_delta', r2.usage.output_tokens === 3, JSON.stringify(r2.usage));
  }

  console.log(`${n - fail}/${n} Claude chat checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
