// Run: node tests/claude-kapai.test.js
//
// EXPERIMENT ?ai=kapai: the Claude chat through Kapai (js/claude/kapai-backend.js, js/host/kapai.js), with a mocked
// Kapai. No request leaves the machine: the client is scripted here, and the loop is the vendored SDK's own runTools
// (js/host/kapai/kapai-sdk-0.1.0-e250ded4.mjs). The live staging runs are manual and reported, not part of CI.
//  * every CLOADM tool converts to Kapai's shape ({ name, description, parameters }), and the SDK refuses the
//    Anthropic shape (input_schema) before any request;
//  * the conversation converts both ways (thinking, text, tool_use, tool_result and is_error survive);
//  * a turn on a real Session: the model's calls reach ChatSession.serveTool, so the consent gate decides every acting
//    tool (a read runs unasked, poke asks; a declined poke changes nothing and the model is told consent-declined);
//    the whole turn is recorded in the Messages form the chat keeps; text streams as it arrives;
//  * a tool error reaches the model as the coded JSON and is recorded is_error; the round limit ends the turn with
//    what ran kept; Stop at a card ends it with no further request; Kapai's errors become the chat's codes;
//  * the user's own Anthropic key as Kapai's own AI: the request it sends, and the thinking blocks carried back
//    through providerData;
//  * ?ai=kapai is a known URL parameter; anything else is an error; without it, nothing changes.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { KapaiBackend, toKapaiTool, toKapaiInput, fromKapaiItems, kapaiError, anthropicOwnAI, KAPAI_MAX_ROUNDS } = require('../js/claude/kapai-backend.js');
const { machineTools } = require('../js/claude/chat.js');
const { apiShapeProblem } = require('../js/claude/history.js');
const { parseUrlConfig } = require('../js/config.js');
const SDK = require('../js/host/kapai/kapai-sdk-0.1.0-e250ded4.mjs');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;

// ---- a scripted Kapai client: each round is { text } or { calls: [{ name, args }] } (or a function of the request) ----
function scripted(rounds) {
  const requests = [];
  let id = 0;
  const one = (req) => {
    requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })));
    const r = rounds[Math.min(requests.length - 1, rounds.length - 1)];
    return typeof r === 'function' ? r(req) : r;
  };
  const kapai = {
    ai: {
      async *stream(req) {
        const r = one(req);
        if (r.error) throw r.error;
        const output = [];
        if (r.text) {
          for (const part of r.text.match(/.{1,5}/gs)) yield { type: 'text', delta: part };
          output.push({ type: 'message', id: `m${++id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: r.text, annotations: [] }] });
        }
        const toolCalls = [];
        for (const c of r.calls || []) {
          const call = { callId: `call_${++id}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : J(c.args || {}) };
          toolCalls.push(call);
          output.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments });
          yield { type: 'tool_call', call };
        }
        yield { type: 'done', text: r.text || '', source: 'kapai', toolCalls, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      },
    },
  };
  return { kapai, requests };
}
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
function session(rounds, { allow = true, maxRounds } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  frames(s, 30);
  const { kapai, requests } = scripted(rounds);
  const backend = new KapaiBackend({ kapai, runTools: SDK.runTools, ...(maxRounds ? { maxRounds } : {}) });
  const chat = s.startAsk({ backend, brief: 'BRIEF' });
  const asked = [], used = [], texts = [];
  s.consent.asker = (name) => { asked.push(name); Promise.resolve().then(() => s.consent.answer(allow)); };
  chat.onToolUse = (name, input, text, isError) => used.push({ name, text, isError });
  chat.onText = (t) => texts.push(t);
  return { s, chat, requests, asked, used, texts };
}
const outputsOf = (req) => (Array.isArray(req.input) ? req.input.filter((i) => i.type === 'function_call_output') : []);

(async () => {
  // ---- tools ----
  {
    const tools = machineTools();
    const k = tools.map(toKapaiTool);
    check('every CLOADM tool converts: name, description and its schema as parameters, no input_schema', k.length === tools.length && k.every((t, i) => t.name === tools[i].name && t.description === tools[i].description
      && J(t.parameters) === J(tools[i].input_schema) && !('input_schema' in t)), J(k.map((t) => t.name)));
    check('within Kapai\'s documented limits: at most 32 tools, names of 1 to 64 [A-Za-z0-9_-], schemas under 16,384 characters',
      k.length <= 32 && k.every((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t.name) && J(t.parameters).length <= 16384));
    // the SDK refuses the Anthropic shape before any request (a fetch that is called fails the check)
    let fetched = 0;
    const real = new SDK.Kapai({ publishableKey: 'pk_test_000000000000000000000000', baseUrl: 'https://kapai.invalid', fetch: async () => { fetched++; throw new Error('no network in tests'); }, debug: false });
    let err = null;
    try { await real.ai.respond({ input: 'x', tools }); } catch (e) { err = e; }
    check('the SDK refuses input_schema before any request: invalid_request, names the tool', err && err.code === 'invalid_request' && /rename it to `parameters`/.test(err.message) && err.details && err.details.tool === 0 && fetched === 0, J(err && { code: err.code, message: err.message, details: err.details, fetched }));
  }

  // ---- the conversation both ways ----
  {
    const convo = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'SIG' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'screen_text', input: {} }, { type: 'tool_use', id: 'toolu_2', name: 'peek', input: { address: 1024, length: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'SCREEN' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"error":{"code":"bad-address"}}', is_error: true }] },
      { role: 'assistant', content: 'Done.' },
    ];
    const items = toKapaiInput(convo);
    check('to Kapai: messages, calls with JSON arguments, outputs; thinking on the first call only', J(items.map((i) => i.type || i.role)) === J(['user', 'assistant', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'assistant'])
      && items[2].arguments === '{}' && items[3].arguments === J({ address: 1024, length: 2 }) && items[2].providerData && items[2].providerData.thinking[0].signature === 'SIG' && !items[3].providerData, J(items));
    const back = fromKapaiItems(items, new Set(['toolu_2']));
    check('and back: the same conversation (thinking first, the text, both calls; is_error kept)', J(back) === J(convo), J(back));
  }

  // ---- a turn: a read and an acting call, the consent gate, the record ----
  {
    const t = session([{ text: 'Looking.', calls: [{ name: 'screen_text' }, { name: 'poke', args: { address: 0x3000, bytes: [7] } }] }, { text: 'Poked 7 at $3000.' }]);
    const res = await t.chat.sendLine('poke 7 at 3000 hex');
    check('the turn ends with the reply, two tool calls, end_turn', res && res.lastText === 'Poked 7 at $3000.' && res.toolCalls === 2 && res.stopReason === 'end_turn', J(res && { lastText: res.lastText, toolCalls: res.toolCalls, err: t.chat.error && t.chat.error.message }));
    check('the consent gate: poke asked, screen_text did not', J(t.asked) === J(['poke']), J(t.asked));
    check('the poke reached the BASIC session', t.s.shownMachine.ram[0x3000] === 7);
    check('two requests: the second sends both outputs back', t.requests.length === 2 && outputsOf(t.requests[1]).length === 2 && t.requests[1].tools.length === machineTools().length && t.requests[0].instructions === 'BRIEF', J(t.requests.map((r) => r.input.length)));
    check('text streamed in pieces as it came, both rounds', t.texts.join('').includes('Looking.') && t.texts.join('').includes('Poked 7') && t.texts.length > 4, J(t.texts));
    const ok = apiShapeProblem(t.chat.messages, { open: true }) === null;
    const roles = t.chat.messages.map((m) => m.role);
    check('the whole turn is recorded in the Messages form: line, tool_use, tool_result, reply', ok && J(roles) === J(['user', 'assistant', 'user', 'assistant'])
      && t.chat.messages[1].content.filter((b) => b.type === 'tool_use').length === 2 && t.chat.messages[3].content === 'Poked 7 at $3000.', J(t.chat.messages));
    // the next turn sends the recorded history again, converted
    t.requests.length = 0;
    await t.chat.sendLine('thanks');
    check('the next turn sends the history: calls and outputs paired', t.requests[0].input.filter((i) => i.type === 'function_call').length === 2 && t.requests[0].input.filter((i) => i.type === 'function_call_output').length === 2);
  }
  // ---- declined: nothing changes, the model is told ----
  {
    const t = session([{ calls: [{ name: 'poke', args: { address: 0x3000, bytes: [9] } }] }, { text: 'OK, do it yourself.' }], { allow: false });
    const before = t.s.shownMachine.ram[0x3000];
    await t.chat.sendLine('poke');
    const out = outputsOf(t.requests[1])[0];
    check('a declined poke changes nothing, and Kapai never bypasses the card', t.s.shownMachine.ram[0x3000] === before && J(t.asked) === J(['poke']));
    check('the model gets consent-declined as the call\'s output', out && /consent-declined/.test(out.output), J(out));
  }
  // ---- a tool error ----
  {
    const t = session([{ calls: [{ name: 'peek', args: { address: 70000, length: 1 } }] }, { text: 'Bad address.' }]);
    await t.chat.sendLine('peek');
    const out = outputsOf(t.requests[1])[0];
    const rec = t.chat.messages[2] && t.chat.messages[2].content[0];
    check('a tool error reaches the model coded (bad-address), recorded is_error', out && /"code":"bad-address"/.test(out.output) && rec && rec.is_error === true && t.used[0].isError, J({ out, rec }));
  }
  // ---- arguments that are not JSON, and an unknown tool: the SDK answers them, no handler runs ----
  {
    const t = session([{ calls: [{ name: 'format_disk', args: {} }, { name: 'poke', args: '{bad' }] }, { text: 'Hm.' }]);
    await t.chat.sendLine('x');
    const outs = outputsOf(t.requests[1]).map((o) => o.output);
    check('unknown tool and bad JSON: the SDK\'s own outputs, nothing run, nothing asked', /no tool with this name/.test(outs[0]) && /not valid JSON/.test(outs[1]) && t.used.length === 0 && t.asked.length === 0, J(outs));
  }
  // ---- the round limit ----
  {
    const t = session([{ calls: [{ name: 'machine_info' }] }], { maxRounds: 3 });
    await t.chat.sendLine('loop');
    check(`the round limit (here 3; ${KAPAI_MAX_ROUNDS} by default, as ClaudeBackend): 3 requests, the turn fails, what ran is kept`, t.requests.length === 3 && t.chat.error && t.chat.error.code === 'bad-response' && /kept calling tools/.test(t.chat.error.message)
      && t.used.length === 2 && t.chat.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')), J({ req: t.requests.length, used: t.used.length, err: t.chat.error && t.chat.error.message }));
  }
  // ---- Stop at the card: no further request ----
  {
    const t = session([{ calls: [{ name: 'poke', args: { address: 0x3000, bytes: [5] } }] }, { text: 'never' }]);
    t.s.consent.asker = () => { setTimeout(() => t.s.stopClaude(), 5); };
    const before = t.s.shownMachine.ram[0x3000];
    const res = await t.chat.sendLine('poke');
    check('Stop at the card: aborted, nothing written, no second request', res === null && t.chat.error && t.chat.error.code === 'aborted' && t.requests.length === 1 && t.s.shownMachine.ram[0x3000] === before, J({ err: t.chat.error && t.chat.error.code, req: t.requests.length }));
    // as with ClaudeBackend, the call that ran (refused: stopped) is kept with the turn, so the next turn knows
    const kept = t.chat.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result');
    check('Stop at the card: the stopped call is kept in the conversation (the loop waits for the tool, not the signal)', kept && /"code":"stopped"/.test(kept.content), J(t.chat.messages));
  }
  // ---- Kapai's errors become the chat's ----
  {
    const err = (code, extra = {}) => Object.assign(new Error(`kapai ${code}`), { code, ...extra });
    const cases = [
      [err('capability_off', { status: 403 }), 'forbidden', /not on for this app/],
      [err('rate_limited', { retryAfter: 12 }), 'rate-limited', /12 seconds/],
      [err('quota_exceeded'), 'quota', /kapai quota_exceeded/],
      [err('input_too_large', { details: { maxInputTokens: 16000 } }), 'too-large', /16000 tokens/],
      [Object.assign(new (class KapaiUnavailableError extends Error {})('down'), { code: 'upstream_unavailable' }), 'server-error', /down/],
      [err('unsupported_option'), 'bad-response', /does not work with this AI model/],
    ];
    for (const [e, code, re] of cases) { const c = kapaiError(e); check(`${e.code} -> ${code}`, c.code === code && re.test(c.message), J({ code: c.code, message: c.message })); }
    const t = session([{ error: err('capability_off', { status: 403 }) }]);
    const res = await t.chat.sendLine('hi');
    check('a refused first round: the turn fails with the app\'s text, the line is not kept', res === null && t.chat.error.code === 'forbidden' && t.chat.messages.length === 0);
  }
  // ---- the user's own Anthropic key as the own AI (mocked fetch; never the live API here) ----
  {
    const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${J(e)}\n\n`).join('');
    const bodies = [];
    const fetch = async (url, init) => {
      bodies.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(sse([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG1' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'screen_text', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }]), { status: 200 });
    };
    const respond = anthropicOwnAI({ fetch, getKey: () => 'sk-ant-TEST' });
    const evs = [];
    for await (const ev of respond({ input: [{ role: 'user', content: 'hi' }], instructions: 'BRIEF', tools: [toKapaiTool(machineTools()[1])], toolChoice: 'auto' })) evs.push(ev);
    const b = bodies[0];
    check('own AI: the Messages API with the key, the brief cached, tools back in input_schema form', b.url === 'https://api.anthropic.com/v1/messages' && b.headers['x-api-key'] === 'sk-ant-TEST' && b.body.system[0].cache_control && b.body.tools[0].input_schema && b.body.tool_choice.type === 'auto', J(b.body));
    const call = evs.find((e) => e.type === 'tool_call');
    check('own AI: the call carries the thinking block with its signature as providerData', call && call.call.callId === 'toolu_9' && call.call.providerData.thinking[0].signature === 'SIG1', J(evs));
    check('own AI: usage counts the cached input', evs[evs.length - 1].usage.input_tokens === 105, J(evs[evs.length - 1]));
    // round 2: the history (as the SDK keeps it) sends the thinking back verbatim before the tool_use
    for await (const ev of respond({ input: [{ role: 'user', content: 'hi' }, { type: 'function_call', call_id: 'toolu_9', name: 'screen_text', arguments: '{}', providerData: call.call.providerData }, { type: 'function_call_output', call_id: 'toolu_9', output: 'SCREEN' }], tools: [] })) void ev;
    const m = bodies[1].body.messages;
    check('own AI round 2: thinking sent back verbatim, then tool_use and its tool_result', J(m[1].content[0]) === J({ type: 'thinking', thinking: 'hmm', signature: 'SIG1' }) && m[1].content[1].type === 'tool_use' && m[2].content[0].type === 'tool_result', J(m));
  }
  // ---- the URL parameter ----
  {
    const a = parseUrlConfig('?ai=kapai'), b = parseUrlConfig('?ai=openai'), c = parseUrlConfig('');
    check('?ai=kapai is known and set; another value is an error; absent is null', a.ai === 'kapai' && !a.errors.length && b.ai === null && /ai=openai/.test(b.errors.join()) && c.ai === null, J([a.errors, b.errors]));
  }
  // ---- the default path does not load Kapai ----
  {
    const src = fs.readFileSync(path.join(__dirname, '../js/ui/claude.js'), 'utf8');
    check('js/ui/claude.js builds ClaudeBackend unless ai is kapai', /ai === 'kapai'\s*\?\s*lazyKapaiBackend/.test(src) && /:\s*new ClaudeBackend\(/.test(src));
    const host = fs.readFileSync(path.join(__dirname, '../js/host/kapai.js'), 'utf8');
    check('the SDK is a dynamic import (the default path never fetches it)', /await import\(SDK_URL\)/.test(host) && !/^import .*kapai-sdk/m.test(host));
  }

  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
