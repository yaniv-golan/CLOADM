/*
 * Claude chat backend: the Anthropic Messages API, streamed, with the user's own API key.
 * Browser-free (fetch is injected), no dependencies: the request and the server-sent events are handled
 * here rather than through an SDK, because the project may add no runtime dependencies (AGENTS rule 2).
 *
 * The brief is the system prompt (built by js/claude/brief.js; the caller passes it as `system`). The model
 * defaults to claude-opus-5-5 and can be changed with `model`. No thinking parameter is sent: thinking is left
 * at the model's default (adaptive) - the chat has no use for it and asking for it costs tokens. The model
 * still thinks, though, so a tool-call reply carries thinking blocks; they are kept with their signatures
 * because the next request in the tool loop must send them back exactly, and streaming is on so text shows on
 * the emulated screen as it arrives.
 *
 * Errors: every failure becomes one ClaudeError with a `code` and a message fit to show the user, and nothing
 * is retried (no automatic retry loops). Codes: 'no-key', 'invalid-key', 'forbidden',
 * 'rate-limited', 'server-error', 'network', 'aborted', 'bad-response', 'stalled'.
 *
 * A stall: when nothing arrives for `stallMs` (STALL_MS, 60 s) - no response to the request, or no bytes of its
 * stream - the request is aborted and the turn fails with 'stalled', so a reply that silently stops can't hold a
 * turn open forever. The timer runs only while a request is out, never while a tool runs or a card waits for the
 * person. 60 s because a working stream is not silent that long: the model's thinking streams as thinking deltas
 * and the API sends ping events while it works, so a minute with no byte at all is a broken connection, not a slow
 * answer; and a minute is about as long as a person waits before deciding something is wrong (Stop works before).
 *
 * Tools: `tools` is the API tool array; `runTool(name, input)` runs one and returns a string (or throws, which
 * is reported to the model as is_error). The loop runs tool calls until the model stops asking.
 */
import { SessionError } from '../errors.js';
import { asToolError, toolErrorJson } from './toolerrors.js';
import { apiMessages } from './history.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 8;          // a runaway tool loop stops rather than spending without bound
export const STALL_MS = 60000;      // no bytes for this long ends the request as 'stalled' (see above)

export class ClaudeError extends SessionError {
  constructor(code, message) { super(message); this.code = code; }
}

// the conversation as the API accepts it, or the turn fails with 'bad-history' (nothing invalid is ever sent)
function sendable(convo) {
  try { return apiMessages(convo); } catch (e) { throw new ClaudeError(e.code || 'bad-history', e.message); }
}

export class ClaudeBackend {
  // deps: { fetch, apiKey, model, runTool, maxTokens, stallMs }
  constructor({ fetch, apiKey = '', model = DEFAULT_MODEL, runTool = null, maxTokens = 4096, stallMs = STALL_MS } = {}) {
    if (typeof fetch !== 'function') throw new Error('ClaudeBackend needs a fetch function');
    this.fetch = fetch;
    this.apiKey = apiKey;
    this.model = model;
    this.runTool = runTool;
    this.maxTokens = maxTokens;
    this.stallMs = stallMs;
  }
  setKey(key) { this.apiKey = key || ''; }
  get hasKey() { return !!this.apiKey; }

  // One user turn through the Messages API, with the tool loop.
  //   send({ system, messages, tools, onText, onToolUse, signal })
  //   -> { text, lastText, stopReason, toolCalls, messages, usage }  (messages: the conversation including tool
  //      turns, without the final reply; text: every request's text; lastText: the final request's alone)
  // A failure throws a ClaudeError; once a tool has run, it carries e.partial (the conversation up to the failure).
  // onText(delta) is called for each streamed text piece; onToolUse(name, input, text, isError, value) for each
  // tool call, where text is exactly what the model receives and value is the raw result or the ToolError.
  // usage: the last request's usage object, so the caller can read cache_read_input_tokens / cache_creation_*.
  async send({ system, messages, tools = [], onText = null, onToolUse = null, signal = null }) {
    if (!this.apiKey) throw new ClaudeError('no-key', 'No API key: add your Anthropic API key to chat.');
    const convo = messages.map((m) => Object.assign({}, m));
    let toolCalls = 0, text = '', stopReason = null, usage = null;
    // A turn that fails after a tool has run has still changed things: the error carries the conversation built so
    // far (e.partial: the messages sent, then each completed round's tool_use and its tool_results), so the caller
    // can keep the evidence of what was done (ChatSession.sendLine) instead of forgetting it.
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // stopped while a tool ran (a card's Stop): the turn ends here, without another request
        if (signal && signal.aborted) throw new ClaudeError('aborted', 'Stopped.');
        const body = {
          model: this.model, max_tokens: this.maxTokens, stream: true,
          // always a conversation the API accepts (js/claude/history.js): no empty assistant message, every
          // tool_use answered, so one bad turn cannot make every later request of the chat fail
          messages: sendable(convo),
        };
        // Prompt caching. Caches are a prefix match over the rendered order tools -> system -> messages, so a
        // breakpoint on the last system block caches the tools and the whole brief together: that prefix is
        // byte-identical on every request of the conversation and every conversation with the same brief (the
        // brief carries only per-machine facts, no time or request id), so it is paid for once and read after.
        // The top-level cache_control then lets the system place one more breakpoint on the last cacheable
        // block, which walks forward as the conversation grows: each request reads everything accumulated so
        // far and writes only what the new turn added. Automatic + one explicit breakpoint is the shape the
        // prompt-caching guide recommends for an agent loop whose tail grows every round.
        if (system) body.system = withCacheBreakpoint(system);
        if (tools.length) body.tools = tools;
        if (system || tools.length) body.cache_control = { type: 'ephemeral' };
        const res = await this._request(body, { onText: (t) => { text += t; if (onText) onText(t); }, signal });
        // the last request of the turn is the one whose usage covers the whole conversation
        if (res.usage) usage = res.usage;
        stopReason = res.stopReason;
        // lastText: the last request's text alone (text is every request's): the reply after the last tool_result
        if (res.stopReason !== 'tool_use') return { text, lastText: res.text, stopReason, toolCalls, messages: convo, usage };
        // run each tool_use block, append the assistant turn and one user turn of tool_results
        convo.push({ role: 'assistant', content: res.content });
        const results = [];
        for (const b of res.content) {
          if (b.type !== 'tool_use') continue;
          // stopped during an earlier tool of this reply: the rest are not run (nor asked about); the results of the
          // ones that ran go into the conversation, so e.partial has them (the unanswered tool_use is dropped later)
          if (signal && signal.aborted) {
            if (results.length) convo.push({ role: 'user', content: results });
            throw new ClaudeError('aborted', 'Stopped.');
          }
          let out, isError = false, value = null;
          try {
            out = this.runTool ? await this.runTool(b.name, b.input) : 'No tools are available.';
            if (out == null) out = '';
          } catch (e) {
            isError = true;
            // every failure reaches the model coded (ToolError, js/claude/toolerrors.js): the code, the remedy and
            // what it sent - not a sentence it cannot act on; anything uncoded is tool-failed (asToolError).
            // toolErrorJson is the one place that shape is made.
            value = asToolError(e);
            out = toolErrorJson(value);
          }
          if (!isError) {
            value = out;
            // a tool that returns an object hands the model JSON, not "[object Object]"
            if (typeof out !== 'string') out = JSON.stringify(out);
          }
          toolCalls++;
          // text is exactly what the model receives; value is the raw result or the error, so the page and the
          // model never disagree about what was sent
          if (onToolUse) onToolUse(b.name, b.input, out, isError, value);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out), ...(isError ? { is_error: true } : {}) });
        }
        convo.push({ role: 'user', content: results });
      }
      throw new ClaudeError('bad-response', 'Claude kept calling tools without finishing; stopped.');
    } catch (e) {
      if (toolCalls && e && typeof e === 'object') e.partial = convo.slice();
      throw e;
    }
  }

  // One HTTP request, streaming the response -> { text, content, stopReason }. The request has its own abort
  // signal, aborted by the caller's (Stop) or by the stall timer; every wait races it, so a fetch or a stream that
  // ignores the signal still ends.
  async _request(body, { onText, signal }) {
    const inner = new AbortController();
    let stalled = false, timer = null;
    const ms = this.stallMs;
    const arm = () => { clearTimeout(timer); if (ms > 0) timer = setTimeout(() => { stalled = true; inner.abort(); }, ms); };
    const outer = () => inner.abort();
    if (signal) { if (signal.aborted) inner.abort(); else signal.addEventListener('abort', outer, { once: true }); }
    const ended = new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (inner.signal.aborted) fail(); else inner.signal.addEventListener('abort', fail, { once: true });
    });
    ended.catch(() => {});
    const guard = (p) => Promise.race([p, ended]);
    const stallError = () => new ClaudeError('stalled', `Claude stopped answering: nothing came for ${ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`}. Try again.`);
    arm();
    try {
      return await this._stream(body, { onText, signal: inner.signal, guard, arm });
    } catch (e) {
      if (stalled) throw stallError();
      if (inner.signal.aborted && !(e instanceof ClaudeError)) throw new ClaudeError('aborted', 'Stopped.');
      throw e;
    } finally {
      clearTimeout(timer);
      // whatever ended the request (an error event, a refused request, the reply done), its stream is let go
      inner.abort();
      if (signal) signal.removeEventListener('abort', outer);
    }
  }

  async _stream(body, { onText, signal, guard, arm }) {
    let res;
    try {
      res = await guard(this.fetch(API_URL, {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION,
          // the page calls the API straight from the browser, cross-origin: without this header the API answers
          // the CORS preflight with 400 and no Access-Control-Allow-Origin, so the browser blocks the request.
          // Source: the official TypeScript SDK sends it when dangerouslyAllowBrowser is on
          // (anthropics/anthropic-sdk-typescript, src/client.ts, buildHeaders); measured 2026-11-15 (docs/claude.md).
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      if (e && (e.name === 'AbortError' || (signal && signal.aborted))) throw new ClaudeError('aborted', 'Stopped.');
      throw new ClaudeError('network', `Could not reach Claude: ${e && e.message ? e.message : 'network error'}. Check your connection.`);
    }
    arm();
    if (!res.ok) throw await guard(this._httpError(res));
    // SSE: read the body line by line, accumulating each event's data until a blank line
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', text = '', stopReason = null, usage = null;
    const blocks = [];        // content blocks in index order
    for (;;) {
      let chunk;
      try { chunk = await guard(reader.read()); } catch (e) {
        if (signal.aborted) reader.cancel().catch(() => {});
        if (e && (e.name === 'AbortError' || signal.aborted)) throw new ClaudeError('aborted', 'Stopped.');
        throw new ClaudeError('network', 'The reply was cut off: network error.');
      }
      if (chunk.done) break;
      arm();
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') continue;                      // end of an event
        if (line.startsWith('event:')) continue;        // the type is also in data.type
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        const r = this._event(ev, blocks, onText);
        if (r && r.text) text += r.text;
        if (r && r.stop) stopReason = r.stop;
        // usage: message_start carries the input side (input_tokens, cache_creation_input_tokens,
        // cache_read_input_tokens); message_delta carries output_tokens and the final stop_reason. Keep the
        // merged object so a caller can verify caching from cache_read_input_tokens (the prompt-caching guide).
        if (r && r.usage) usage = Object.assign({}, usage, r.usage);
        if (ev.type === 'error') throw this._streamError(ev);
      }
    }
    // assemble the content blocks. Each block goes back to the API in the shape it arrived in, because the
    // next request in a tool loop sends the assistant turn verbatim: a thinking block without its signature
    // (or a block whose type was rewritten) makes the API reject the whole request.
    //   text      concatenated deltas
    //   tool_use  input rebuilt from its partial JSON
    //   thinking  thinking_delta text and signature_delta signature, in order
    //   anything else  the content_block object from content_block_start, with its deltas merged in
    const content = blocks.filter(Boolean).map((b) => {
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: safeJson(b.json) };
      if (b.type === 'text') return { type: 'text', text: b.text || '' };
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        const out = { type: b.type, thinking: b.thinking || '' };
        if (b.signature) out.signature = b.signature;
        if (b.data) out.data = b.data;
        return out;
      }
      return Object.assign({}, b.raw, b.extra || {});
    });
    if (!stopReason) stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return { text, content, stopReason, usage };
  }

  // one SSE event -> { text } for a text delta, { stop } for the stop reason, { usage } for token counts
  // (mutates `blocks`).
  //
  // Every block keeps the content_block object from content_block_start (`raw`) so a type this parser does
  // not know can still be sent back unchanged; known types get a working shape, and their deltas are merged
  // into it. Only text is reported to the screen: thinking and tool input are machinery, not the reply.
  _event(ev, blocks, onText) {
    switch (ev.type) {
      case 'message_start': return ev.message && ev.message.usage ? { usage: ev.message.usage } : null;
      case 'content_block_start': {
        const b = ev.content_block || {};
        const block = { type: b.type, raw: Object.assign({}, b), extra: {} };
        if (b.type === 'text') block.text = b.text || '';
        else if (b.type === 'tool_use') { block.id = b.id; block.name = b.name; block.json = ''; }
        else if (b.type === 'thinking') { block.thinking = b.thinking || ''; block.signature = b.signature || ''; }
        else if (b.type === 'redacted_thinking') { block.data = b.data || ''; }
        blocks[ev.index] = block;
        if (b.type === 'text' && b.text) { if (onText) onText(b.text); return { text: b.text }; }
        return null;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        if (!b || !ev.delta) return null;
        const d = ev.delta;
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; if (onText) onText(d.text); return { text: d.text }; }
        if (d.type === 'input_json_delta') { b.json = (b.json || '') + (d.partial_json || ''); return null; }
        if (d.type === 'thinking_delta') { b.thinking = (b.thinking || '') + (d.thinking || ''); return null; }
        if (d.type === 'signature_delta') { b.signature = d.signature || ''; return null; }
        // a delta this parser does not know: keep it on the block so nothing is lost
        b.extra = Object.assign({}, b.extra, d);
        return null;
      }
      case 'message_delta': {
        const out = {};
        if (ev.delta && ev.delta.stop_reason) out.stop = ev.delta.stop_reason;
        if (ev.usage) out.usage = ev.usage;
        return Object.keys(out).length ? out : null;
      }
      default: return null;
    }
  }
  // an error event inside a 200 stream: classified as the HTTP status its type stands for, so it reads the same
  // as that error would before the stream (an overloaded API says so, not just "Overloaded")
  _streamError(ev) {
    const t = (ev.error && ev.error.type) || '';
    const status = { authentication_error: 401, permission_error: 403, rate_limit_error: 429, api_error: 500, overloaded_error: 529 }[t] || 0;
    return this._classify(t, status, (ev.error && ev.error.message) || 'The reply failed.');
  }
  async _httpError(res) {
    let type = '', message = '';
    try { const body = await res.json(); type = (body.error && body.error.type) || ''; message = (body.error && body.error.message) || ''; }
    catch (e) { /* not JSON: a gateway page or an empty body */ }
    return this._classify(type, res.status, message);
  }
  // one clear message per failure kind (tell the user, no automatic retry)
  _classify(type, status, message) {
    const key = (t, s) => `${t} ${s}`;
    switch (key(type, status)) {
      case 'authentication_error 401': return new ClaudeError('invalid-key', 'The API key was refused: check it and try again.');
      case 'permission_error 403': return new ClaudeError('forbidden', 'Permission denied: this API key may not use the chat model.');
      case 'rate_limit_error 429': return new ClaudeError('rate-limited', 'Claude is rate limited right now. Try again in a moment.');
      case 'overloaded_error 529': return new ClaudeError('server-error', 'Claude is overloaded right now. Try again in a moment.');
      default: break;
    }
    if (status === 401) return new ClaudeError('invalid-key', 'The API key was refused: check it and try again.');
    if (status === 403) return new ClaudeError('forbidden', 'Permission denied: this API key may not use the chat model.');
    if (status === 429) return new ClaudeError('rate-limited', 'Claude is rate limited right now. Try again in a moment.');
    if (status >= 500) return new ClaudeError('server-error', `Claude's service had a problem${status ? ` (${status})` : ''}. Try again in a moment.`);
    if (status === 400) return new ClaudeError('bad-response', `The request was refused${message ? `: ${message}` : ''}.`);
    return new ClaudeError('bad-response', message || `Claude answered with an error${status ? ` (${status})` : ''}.`);
  }
}

const safeJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } };

// Put one cache_control breakpoint on the last system block, without mutating the caller's value.
// The API accepts `system` as a string (one text block) or as already-blocked content; a string becomes one
// block so it can carry the marker. Any cache_control already on a block is replaced, not duplicated (the API
// allows at most 4 breakpoints, and repeating one on a block is not meaningful).
function withCacheBreakpoint(system) {
  const MARK = { cache_control: { type: 'ephemeral' } };
  if (typeof system === 'string') return [{ type: 'text', text: system, ...MARK }];
  if (Array.isArray(system) && system.length) {
    const out = system.map((b) => Object.assign({}, b));
    const last = out[out.length - 1];
    return out.map((b, i) => {
      if (i !== out.length - 1) { const c = Object.assign({}, b); delete c.cache_control; return c; }
      return Object.assign({}, last, MARK);
    });
  }
  return system;
}
