/*
 * EXPERIMENT (?ai=kapai): the Claude chat through Kapai, a hosted AI layer whose SDK runs the model and meters use
 * per install. The default path is js/claude/backend.js and is untouched; this backend is used only when the page is
 * opened with ?ai=kapai (js/ui/claude.js, js/host/kapai.js).
 *
 * It has the same contract as ClaudeBackend: send({ system, messages, tools, onText, onToolUse, signal }) ->
 * { text, lastText, stopReason, toolCalls, messages, usage }, failures as ClaudeError (with e.partial once a tool has
 * run), and `runTool(name, input)` set by ChatSession. So the consent gate is unchanged: every tool call the model
 * asks for, whichever AI answered, goes through ChatSession.serveTool, where js/claude/consent.js decides. Kapai never
 * runs a tool itself: its loop (the SDK's runTools) only calls the handlers given here, and each handler is runTool.
 *
 * Browser-free: the SDK is injected (`kapai`, the client; `runTools`, the SDK's exported loop), so Node tests run it
 * against a mock. The loop is the SDK's own runTools, given a `respond` built on the client's stream(), so text shows
 * as it arrives (the client's ai.runTools uses respond() and shows nothing until a round ends).
 *
 * Shapes. The conversation is kept in the Anthropic Messages form (js/claude/history.js checks it, and the chat
 * records it); Kapai takes OpenAI Responses-style items. toKapaiInput and fromKapaiItems convert, and an assistant
 * turn's thinking blocks ride on its first call as `providerData` (Kapai's server never gets it; the user's own
 * Anthropic key needs it back verbatim: anthropicOwnAI below).
 */
import { ClaudeError, ClaudeBackend } from './backend.js';
import { asToolError, toolErrorJson } from './toolerrors.js';
import { apiMessages } from './history.js';

// the same bound as ClaudeBackend: 8 tool rounds, then one more request for the reply = 9 requests at most
export const KAPAI_MAX_ROUNDS = 9;

// Anthropic tool -> Kapai tool ({ name, description?, parameters, strict? }). Anything else on the tool (a
// cache_control mark) is dropped: Kapai has no such member.
export function toKapaiTool(t) {
  const out = { name: t.name, parameters: t.input_schema || t.parameters || { type: 'object', properties: {} } };
  if (t.description) out.description = t.description;
  return out;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '');
const resultText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? b.text : JSON.stringify(b))).join('') : String(content ?? ''));

// Anthropic messages -> Kapai input items. A tool_use becomes a function_call (arguments as JSON text), a tool_result a
// function_call_output. The assistant's thinking blocks go on its first call as providerData.thinking.
export function toKapaiInput(messages) {
  const items = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { if (m.content) items.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = textOf(blocks);
    if (text) items.push({ role: m.role, content: text });
    const thinking = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    let first = true;
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const call = { type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) };
        if (first && thinking.length) call.providerData = { thinking };
        first = false;
        items.push(call);
      } else if (b.type === 'tool_result') {
        items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: resultText(b.content) });
      }
    }
  }
  return items;
}

const parseArgs = (s) => { try { const v = s ? JSON.parse(s) : {}; return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };

// Kapai items -> Anthropic messages: an assistant text and the calls after it make one assistant message (thinking
// first, from providerData), the outputs after them one user message of tool_results. errored: the call ids whose
// result was an error (Kapai has no is_error member; the chat keeps it, as ClaudeBackend does).
export function fromKapaiItems(items, errored = new Set()) {
  const out = [];
  const last = () => out[out.length - 1];
  for (const it of items) {
    if (it.type === 'function_call') {
      let m = last();
      if (!m || m.role !== 'assistant' || typeof m.content === 'string') {
        m = { role: 'assistant', content: m && m.role === 'assistant' && typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [] };
        if (last() && last().role === 'assistant') out.pop();
        out.push(m);
      }
      const pd = it.providerData;
      if (pd && Array.isArray(pd.thinking) && !m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) m.content.unshift(...pd.thinking);
      m.content.push({ type: 'tool_use', id: it.call_id, name: it.name, input: parseArgs(it.arguments) });
    } else if (it.type === 'function_call_output') {
      let m = last();
      if (!m || m.role !== 'user' || !Array.isArray(m.content) || !m.content.every((b) => b.type === 'tool_result')) { m = { role: 'user', content: [] }; out.push(m); }
      m.content.push({ type: 'tool_result', tool_use_id: it.call_id, content: String(it.output ?? ''), ...(errored.has(it.call_id) ? { is_error: true } : {}) });
    } else if (it.role) {
      out.push({ role: it.role, content: typeof it.content === 'string' ? it.content : textOf(it.content) });
    }
  }
  return out;
}

// the SDK's output items -> the input items of the next round (as the SDK's runTools does it)
const inputOf = (item) => (item.type === 'function_call'
  ? { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments, ...(item.providerData !== undefined ? { providerData: item.providerData } : {}) }
  : { role: 'assistant', content: (item.content || []).map((p) => p.text || '').join('') });

// A Kapai SDK error -> ClaudeError, with a text of CLOADM's own where the vendor asks for one (capability_off,
// unsupported_option, own_ai_no_tools) and Kapai's own sentence where it is meant for the user (quota_exceeded).
// Classified by code and class name, not instanceof: the page and a test can hold different copies of the SDK.
export function kapaiError(e, signal) {
  if (e instanceof ClaudeError) return e;
  if ((signal && signal.aborted) || (e && e.name === 'AbortError')) return new ClaudeError('aborted', 'Stopped.');
  const code = (e && e.code) || '';
  const cls = (e && e.constructor && e.constructor.name) || '';
  const out = (c, m) => Object.assign(new ClaudeError(c, m), { kapai: { code, status: e && e.status, details: e && e.details } });
  switch (code) {
    case 'quota_exceeded': return out('quota', (e && e.message) || 'You have reached the limit of the included AI.');
    case 'rate_limited': return out('rate-limited', `Too many requests. Try again in ${e.retryAfter ?? 'a few'} seconds.`);
    case 'concurrency_limited': return out('rate-limited', 'Another request is still running. Try again when it ends.');
    case 'capability_off': return out('forbidden', 'This feature is not on for this app yet.');
    case 'unsupported_option': return out('bad-response', 'This feature does not work with this AI model now.');
    case 'input_too_large': return out('too-large', `This conversation is too long for the included AI${e.details && e.details.maxInputTokens ? ` (${e.details.maxInputTokens} tokens at most)` : ''}. Start a new chat.`);
    case 'own_ai_no_tools': return out('bad-response', 'Your AI cannot use this feature. Switch to the included AI.');
    case 'own_ai_failed': return out('bad-response', `Your own AI failed: ${e.message}`);
    case 'network_error': return out('network', 'Could not reach the AI service. Check your connection.');
    default: break;
  }
  if (cls === 'KapaiUnavailableError' || ['timeout', 'upstream_unavailable', 'circuit_open', 'stream_interrupted', 'stream_ended', 'unavailable'].includes(code)) {
    return out('server-error', (e && e.message) || 'The AI service is not available now. Try again soon.');
  }
  return out('bad-response', (e && e.message) || 'The AI service answered with an error.');
}

export class KapaiBackend {
  // deps: { kapai (the SDK client), runTools (the SDK's exported loop), maxRounds, stream (false: one respond() a round) }
  constructor({ kapai, runTools, maxRounds = KAPAI_MAX_ROUNDS, stream = true } = {}) {
    if (!kapai || !kapai.ai) throw new Error('KapaiBackend needs a Kapai client');
    if (typeof runTools !== 'function') throw new Error('KapaiBackend needs the SDK\'s runTools');
    this.kapai = kapai;
    this.runToolsLoop = runTools;
    this.maxRounds = maxRounds;
    this.stream = stream;
    this.runTool = null;
    this.apiKey = '';
  }
  // the user's own Anthropic key: kept for the own-AI adapter (js/host/kapai.js reads it); Kapai itself needs none
  setKey(key) { this.apiKey = key || ''; if (this.kapai.ownAI && this.kapai.ownAI.changed) this.kapai.ownAI.changed(); }
  get hasKey() { return true; }

  async send({ system, messages, tools = [], onText = null, onToolUse = null, signal = null }) {
    let convo;
    try { convo = apiMessages(messages.map((m) => Object.assign({}, m))); } catch (e) { throw new ClaudeError(e.code || 'bad-history', e.message); }
    const start = toKapaiInput(convo);
    const errored = new Set();
    let toolCalls = 0, text = '', history = start, ran = [];
    const handlers = {};
    for (const t of tools) {
      handlers[t.name] = async (args, call) => {
        if (signal && signal.aborted) throw new ClaudeError('aborted', 'Stopped.');
        let out, isError = false, value = null;
        try {
          out = this.runTool ? await this.runTool(t.name, args) : 'No tools are available.';
          if (out == null) out = '';
        } catch (e) {
          isError = true;
          value = asToolError(e);
          out = toolErrorJson(value);
          errored.add(call.callId);
        }
        if (!isError) { value = out; if (typeof out !== 'string') out = JSON.stringify(out); }
        toolCalls++;
        if (onToolUse) onToolUse(t.name, args, out, isError, value);
        ran.push({ type: 'function_call_output', call_id: call.callId, output: out });
        return out;
      };
    }
    // one round: streamed, so text shows as it arrives; the result has the shape of the SDK's respond()
    // The signal goes to each round's request, not to the loop: the SDK's runTools races a handler against its
    // request's signal, so on Stop it would return while a tool still runs (a card waiting, keys going in) and drop
    // that call's result. Here the loop waits for the tool, as ClaudeBackend does, and Stop ends it before the next
    // round, with what ran kept (e.partial).
    const respond = async (req0) => {
      history = req0.input; ran = [];
      if (signal && signal.aborted) throw new ClaudeError('aborted', 'Stopped.');
      const req = signal ? { ...req0, signal } : req0;
      let res;
      if (this.stream) {
        for await (const ev of this.kapai.ai.stream(req)) {
          if (ev.type === 'text') { text += ev.delta; if (onText) onText(ev.delta); } else if (ev.type === 'done') res = ev;
        }
        if (!res) throw new ClaudeError('bad-response', 'The AI service ended the answer without finishing it.');
      } else {
        res = await this.kapai.ai.respond(req);
        if (res.text) { text += res.text; if (onText) onText(res.text); }
      }
      history = [...req.input, ...(res.output || []).map(inputOf)];
      return res;
    };
    const request = { input: start, ...(system ? { instructions: typeof system === 'string' ? system : textOf(system) } : {}), ...(tools.length ? { tools: tools.map(toKapaiTool) } : {}) };
    try {
      const run = await this.runToolsLoop(respond, request, { handlers, maxRounds: this.maxRounds });
      const msgs = [...convo, ...fromKapaiItems(run.input.slice(start.length), errored)];
      // the reply after the last tool results is the caller's to record (as ClaudeBackend): drop it from messages
      if (msgs.length && msgs[msgs.length - 1].role === 'assistant' && typeof msgs[msgs.length - 1].content === 'string') msgs.pop();
      if (run.stopped === 'max_rounds') throw Object.assign(new ClaudeError('bad-response', 'Claude kept calling tools without finishing; stopped.'), { partial: msgs });
      const last = run.last || {};
      return {
        text, lastText: run.text || '', stopReason: run.stopped === 'incomplete' ? 'max_tokens' : 'end_turn', toolCalls, messages: msgs,
        usage: run.usage || null, source: last.source || null,
      };
    } catch (e) {
      const err = kapaiError(e, signal);
      if (toolCalls && !err.partial) {
        const outs = ran.filter((o) => !history.some((h) => h.type === 'function_call_output' && h.call_id === o.call_id));
        err.partial = [...convo, ...fromKapaiItems([...history, ...outs].slice(start.length), errored)];
      }
      throw err;
    }
  }
}

// The user's own Anthropic key as Kapai's "own AI" (KapaiOwnAI.appManaged's respond): one round of the Messages API
// through ClaudeBackend's own request (streaming, stall timer, errors), with the round's thinking blocks handed back as
// providerData so the next round sends them verbatim. Untested against the live API (no key was available): the
// tests run it on a mocked fetch.
export function anthropicOwnAI({ fetch, getKey, model }) {
  const one = () => new ClaudeBackend({ fetch, apiKey: getKey(), ...(model ? { model } : {}) });
  return async function* respond(request) {
    const b = one();
    const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input;
    const messages = apiMessages(fromKapaiItems(input));
    const body = { model: b.model, max_tokens: request.maxOutputTokens || b.maxTokens, stream: true, messages };
    if (request.instructions) body.system = [{ type: 'text', text: request.instructions, cache_control: { type: 'ephemeral' } }];
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters }));
      const c = request.toolChoice;
      if (c) body.tool_choice = c === 'required' ? { type: 'any' } : typeof c === 'object' ? { type: 'tool', name: c.name } : { type: c };
      if (request.parallelToolCalls === false) body.tool_choice = Object.assign({ type: 'auto' }, body.tool_choice, { disable_parallel_tool_use: true });
    }
    if (body.system || body.tools) body.cache_control = { type: 'ephemeral' };
    // (ClaudeBackend's request has no public name; the text comes whole at the round's end)
    const res = await b._request(body, { onText: () => {}, signal: request.signal || null });
    if (res.text) yield { type: 'text', delta: res.text };
    const thinking = res.content.filter((x) => x.type === 'thinking' || x.type === 'redacted_thinking');
    let first = true;
    for (const x of res.content) {
      if (x.type !== 'tool_use') continue;
      yield { type: 'tool_call', call: { callId: x.id, name: x.name, arguments: JSON.stringify(x.input ?? {}), ...(first && thinking.length ? { providerData: { thinking } } : {}) } };
      first = false;
    }
    const u = res.usage || {};
    const input_tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    yield { type: 'done', usage: { input_tokens, output_tokens: u.output_tokens || 0, total_tokens: input_tokens + (u.output_tokens || 0) }, ...(res.stopReason === 'max_tokens' ? { incomplete: { reason: 'max_output_tokens' } } : {}) };
  };
}
