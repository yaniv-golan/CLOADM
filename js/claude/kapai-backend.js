/*
 * Claude chat backend through Kapai (https://stg.kap.ai/agents.md, "Add tool calls" and "Add the user's own AI"):
 * the same send() contract as ClaudeBackend (js/claude/backend.js), so the ChatSession and both views are unchanged.
 * Browser-free: the Kapai client is injected (js/host/kapai.js makes the page's).
 *
 * The conversation stays in the Messages API's form (js/claude/history.js keeps it valid). Each round converts it to
 * Kapai's items: a text message, a tool_use -> function_call (its arguments as JSON text), a tool_result ->
 * function_call_output (its content as text). The thinking blocks of an Anthropic reply ride on the first call of
 * their round as `providerData` (Kapai's server never gets it: sdk-reference.md, "Tool calls"), so a round that the
 * person's own key answers can send them back with their signatures, as the Messages API requires.
 *
 * Which AI answers is Kapai's decision (agents.md part 2: no `if` here): the included AI, or the person's own
 * Anthropic key through ownKeyResponder() below, by the app's own-AI policy.
 *
 * Errors: each becomes a ClaudeError with a code the views know, and the SDK's error is kept as `kapai`, so the page
 * can hand it to <kapai-limit-prompt> (its show(error)). Codes: 'quota' (a limit: the prompt explains it), 'rate-limited',
 * 'network' (offline or Kapai unavailable), 'aborted', 'tools-off' (the app's tool calls are off in Kapai's dashboard),
 * 'bad-response'. The message of a limit is the SDK's own sentence; agents.md: write no limit into the app's text.
 */
import { ClaudeError, STALL_MS } from './backend.js';
import { apiMessages } from './history.js';
import { asToolError, toolErrorJson } from './toolerrors.js';

const MAX_TOOL_ROUNDS = 8;          // as ClaudeBackend: a runaway tool loop stops rather than spending without bound

// the text of a content (a string, or a list of blocks or parts)
// (the text blocks of one message, such as a page note and the person's next line, are separate paragraphs)
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n\n') : '');
const isThinking = (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking');

// Anthropic tools -> Kapai tools ({ name, description, parameters }); agents.md, "Add tool calls"
export const kapaiTools = (tools) => tools.map(({ input_schema, cache_control, ...tool }) => ({ ...tool, parameters: input_schema }));
// and back, for the own key
export const anthropicTools = (tools) => (tools || []).map(({ parameters, strict, ...tool }) => ({ ...tool, input_schema: parameters }));

// The conversation (Messages API form) -> Kapai's input items.
export function kapaiInput(messages) {
  const items = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { if (m.content.trim()) items.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const thinking = blocks.filter(isThinking);
      const text = textOf(blocks.filter((b) => b.type === 'text'));
      if (text.trim()) items.push({ role: 'assistant', content: text });
      let first = true;
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const call = { type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input == null ? {} : b.input) };
        if (first && thinking.length) call.providerData = { anthropicThinking: thinking };
        first = false;
        items.push(call);
      }
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: textOf(b.content) });
      }
      const text = textOf(blocks.filter((b) => b.type === 'text'));
      if (text.trim()) items.push({ role: 'user', content: text });
    }
  }
  return items;
}

// the page's coded tool error, as toolErrorJson writes it: {"error":{"code":"…",…}}
const isToolError = (text) => {
  if (!text.startsWith('{"error":')) return false;
  try { const v = JSON.parse(text); return !!v && typeof v.error === 'object' && v.error !== null && typeof v.error.code === 'string'; } catch (e) { return false; }
};

// Kapai's input items -> the conversation (Messages API form), checked by apiMessages. The thinking blocks of a
// round come back from the providerData of its first call, at the start of its assistant message.
export function anthropicMessages(input) {
  const out = [];
  const last = () => out[out.length - 1];
  const blocksOf = (role) => {
    if (!last() || last().role !== role || typeof last().content === 'string') out.push({ role, content: [] });
    return last().content;
  };
  for (const item of typeof input === 'string' ? [{ role: 'user', content: input }] : input) {
    if (item.type === 'function_call') {
      const blocks = blocksOf('assistant');
      const thinking = item.providerData && Array.isArray(item.providerData.anthropicThinking) ? item.providerData.anthropicThinking : [];
      if (thinking.length) blocks.unshift(...thinking);
      let args = {};
      try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch (e) { args = {}; }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args });
    } else if (item.type === 'function_call_output') {
      // Kapai's output item has no error flag: a tool's failure is the page's coded error JSON (toolErrorJson,
      // js/claude/toolerrors.js), so that shape gets back the is_error the Messages API takes
      const output = String(item.output);
      blocksOf('user').push({ type: 'tool_result', tool_use_id: item.call_id, content: output, ...(isToolError(output) ? { is_error: true } : {}) });
    } else if (item.role === 'assistant' || item.role === 'user') {
      const text = textOf(item.content);
      if (text.trim()) blocksOf(item.role).push({ type: 'text', text });
    }
    // (system and developer messages: the brief is `instructions`, never a message)
  }
  // a message of one text block is a string, as the chat's own history has it
  for (const m of out) if (Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text') m.content = m.content[0].text;
  return apiMessages(out);
}

// The person's own Anthropic key as Kapai's app-managed own AI (agents.md, "Add the user's own AI": the app keeps the
// key and makes the request; KapaiOwnAI.appManaged({ respond })). `claude()` gives a ClaudeBackend with the saved key.
// An async generator: the text streams as it comes, then each tool call, the first carrying the round's thinking.
// The SDK reports a failure of this respond as OwnAIError 'own_ai_failed' with its own message and no `cause`, so the
// page's own error (its code: a refused key, a rate limit, the network) is kept here, and KapaiBackend takes it back
// (respond.takeError()) to show the key states it always showed.
export function ownKeyResponder(claude) {
  let lastError = null;
  const respond = async function* respond(request) {
    lastError = null;
    const backend = claude();
    const queue = [];
    let wake = null, done = false, failure = null, result = null;
    const push = (ev) => { queue.push(ev); if (wake) { wake(); wake = null; } };
    backend.round({
      system: request.instructions || '',
      messages: anthropicMessages(request.input),
      tools: anthropicTools(request.tools),
      onText: (delta) => push({ type: 'text', delta }),
      signal: request.signal || null,
    }).then((r) => { result = r; }, (e) => { failure = e; }).finally(() => { done = true; if (wake) { wake(); wake = null; } });
    for (;;) {
      while (queue.length) yield queue.shift();
      if (done) break;
      await new Promise((r) => { wake = r; });
    }
    if (failure) { lastError = failure; throw failure; }
    const thinking = result.content.filter(isThinking);
    let first = true;
    for (const b of result.content) {
      if (b.type !== 'tool_use') continue;
      const call = { callId: b.id, name: b.name, arguments: JSON.stringify(b.input == null ? {} : b.input) };
      if (first && thinking.length) call.providerData = { anthropicThinking: thinking };
      first = false;
      yield { type: 'tool_call', call };
    }
    // a reply cut at its size, or a refusal: Kapai's incomplete reasons (a refusal is the provider's "content_filter")
    const incomplete = result.stopReason === 'max_tokens' ? { reason: 'max_output_tokens' } : result.stopReason === 'refusal' ? { reason: 'content_filter' } : null;
    yield { type: 'done', ...(incomplete ? { incomplete } : {}) };
  };
  respond.takeError = () => { const e = lastError; lastError = null; return e; };
  return respond;
}

// a Kapai error (or an abort) -> a ClaudeError the views know, with the SDK's own error kept as `kapai`
export function claudeErrorOf(e, signal) {
  if (e instanceof ClaudeError) return e;
  const name = e && e.name, code = e && e.code;
  const wrap = (c, message) => Object.assign(new ClaudeError(c, message), { kapai: e });
  if ((signal && signal.aborted) || name === 'AbortError') return wrap('aborted', 'Stopped.');
  if (name === 'QuotaExceededError') return wrap('quota', e.message);
  if (name === 'RateLimitedError') {
    return wrap('rate-limited', code === 'concurrency_limited' ? 'Another request is still running. Try again when it ends.' : `Too many requests. Try again in ${e.retryAfter} seconds.`);
  }
  if (name === 'KapaiUnavailableError') return wrap('network', 'AI is not available now. Try again soon.');
  // (the SDK's message already says "Your own AI failed: …"; the reference's "Your AI gave an error: " would say it twice)
  if (name === 'OwnAIError') return wrap(code === 'own_ai_failed' ? 'bad-response' : 'own-ai', e.message);
  // the messages of these codes speak to the developer (agents.md, "Handle the limit"): the app's own text
  if (code === 'capability_off') return wrap('tools-off', 'This feature is not on for this app yet.');
  if (code === 'unsupported_option') return wrap('bad-response', 'This feature does not work with this AI model now.');
  if (code === 'install_revoked') return wrap('bad-response', 'This device cannot use AI in this app.');
  if (code === 'app_suspended') return wrap('bad-response', 'AI is not available in this app now.');
  if (code === 'input_too_large') return wrap('bad-response', 'This conversation is too long. Start a new chat.');
  if (name === 'KapaiError' || (e && typeof code === 'string')) return wrap('bad-response', e.message || 'Something went wrong. Try again.');
  return wrap('bad-response', 'Something went wrong. Try again.');
}

export class KapaiBackend {
  // deps: { kapai (a Kapai client), ownKey (the ownKeyResponder given to the client, if any), runTool, maxTokens,
  //         stallMs (the own key's request: ClaudeBackend's stall limit; the page's responder reads it from here) }
  constructor({ kapai, ownKey = null, runTool = null, maxTokens = 4096, stallMs = STALL_MS } = {}) {
    if (!kapai || !kapai.ai) throw new Error('KapaiBackend needs a Kapai client');
    this.kapai = kapai;
    this.ownKey = ownKey;
    this.stallMs = stallMs;
    this.runTool = runTool;
    this.maxTokens = maxTokens;
  }
  // (no apiKey field: the chat needs no key to start a turn; the person's own key is Kapai's own-AI source)
  setKey() {}

  // One user turn, with the tool loop: the same contract as ClaudeBackend.send.
  async send({ system, messages, tools = [], onText = null, onToolUse = null, signal = null }) {
    const convo = messages.map((m) => Object.assign({}, m));
    let toolCalls = 0, text = '', usage = null;
    const kTools = tools.length ? kapaiTools(tools) : null;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (signal && signal.aborted) throw new ClaudeError('aborted', 'Stopped.');
        let sent;
        try { sent = apiMessages(convo); } catch (e) { throw new ClaudeError(e.code || 'bad-history', e.message); }
        const request = { instructions: system || undefined, input: kapaiInput(sent), maxOutputTokens: this.maxTokens };
        if (kTools) request.tools = kTools;
        if (signal) request.signal = signal;
        let roundText = '', done = null;
        try {
          for await (const ev of this.kapai.ai.stream(request)) {
            if (ev.type === 'text') { roundText += ev.delta; text += ev.delta; if (onText) onText(ev.delta); }
            else if (ev.type === 'done') done = ev;
          }
        } catch (e) {
          // the saved key's own failure, as the page's request had it (ownKeyResponder)
          const own = e && e.name === 'OwnAIError' && e.code === 'own_ai_failed' && this.ownKey ? this.ownKey.takeError() : null;
          throw own instanceof ClaudeError ? own : claudeErrorOf(e, signal);
        }
        if (!done) throw new ClaudeError('bad-response', 'The answer ended with no result. Try again.');
        if (done.usage) usage = done.usage;
        // a round cut at its largest size: none of its calls run (agents.md), and the text so far is the reply; the own
        // key's refusal comes as "content_filter" (sdk-reference.md, kapai.ai.respond) and is the chat's refusal
        if (done.incomplete) return { text, lastText: roundText, stopReason: done.incomplete.reason === 'content_filter' ? 'refusal' : 'max_tokens', toolCalls, messages: convo, usage, source: done.source };
        if (!done.toolCalls.length) return { text, lastText: roundText, stopReason: 'end_turn', toolCalls, messages: convo, usage, source: done.source };
        // the assistant's round as the Messages API has it (its thinking from the first call's providerData)
        const thinking = done.toolCalls[0].providerData && Array.isArray(done.toolCalls[0].providerData.anthropicThinking) ? done.toolCalls[0].providerData.anthropicThinking : [];
        const content = [...thinking];
        if (roundText.trim()) content.push({ type: 'text', text: roundText });
        const parsed = done.toolCalls.map((c) => { let input = {}; try { input = c.arguments ? JSON.parse(c.arguments) : {}; } catch (e) { input = null; } return { c, input }; });
        for (const { c, input } of parsed) content.push({ type: 'tool_use', id: c.callId, name: c.name, input: input || {} });
        convo.push({ role: 'assistant', content });
        const results = [];
        for (const { c, input } of parsed) {
          if (signal && signal.aborted) {
            if (results.length) convo.push({ role: 'user', content: results });
            throw new ClaudeError('aborted', 'Stopped.');
          }
          let out, isError = false, value = null;
          try {
            if (input === null) throw new Error('The arguments of this call were not JSON.');
            out = this.runTool ? await this.runTool(c.name, input) : 'No tools are available.';
            if (out == null) out = '';
          } catch (e) { isError = true; value = asToolError(e); out = toolErrorJson(value); }
          if (!isError) { value = out; if (typeof out !== 'string') out = JSON.stringify(out); }
          toolCalls++;
          if (onToolUse) onToolUse(c.name, input || {}, out, isError, value);
          results.push({ type: 'tool_result', tool_use_id: c.callId, content: String(out), ...(isError ? { is_error: true } : {}) });
        }
        convo.push({ role: 'user', content: results });
      }
      throw new ClaudeError('bad-response', 'Claude kept calling tools without finishing; stopped.');
    } catch (e) {
      if (toolCalls && e && typeof e === 'object') e.partial = convo.slice();
      throw e;
    }
  }
}
