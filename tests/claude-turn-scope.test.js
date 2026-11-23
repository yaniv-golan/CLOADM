// Run: node tests/claude-turn-scope.test.js
//
// What a turn with Claude leaves behind ends with the turn, and nothing it leaves can wedge the chat:
//  * Stop while assemble_and_load reads an INCLUDE that never arrives ends the read and the turn; the page's
//    reader (js/host/example-reader.js) passes the turn's signal to fetch and has its own timeout, after which the
//    tool fails with include-unreadable and the turn goes on; a reader that ignores the signal still lets Stop stop;
//  * a pause made by the person's key belongs to its turn: when the turn ends (finished, failed, stopped) the
//    pause ends, what it held back is never typed, and the next turn does not start paused; no pause outside a turn;
//  * an empty reply (a turn of tool calls only, a refusal, whitespace) is not recorded, and Stop before any
//    text, a stream that fails or stalls mid-reply leave a history the API accepts. The mocked API here refuses
//    what the Messages API refuses (an empty assistant message, a blank text block, a tool_use without its
//    tool_result, a tool_result without its tool_use, a first message that is not the user's) with a 400, so a
//    history that would wedge the real chat fails these tests. apiMessages (js/claude/history.js) is also tested
//    on hand-built histories. Never the real API.
const Emu = require('./load')();
const fs = require('fs'), path = require('path');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const KEY = 'sk-ant-TURN-SCOPE-KEY-0123456789';
let finished = false;
process.on('exit', () => { if (!finished) { console.log('FAIL the test did not finish (a turn never ended)'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return !!fn(); };
// a promise that has to settle within ms, else 'timeout' (so a turn that hangs fails the check instead of the run)
const within = (p, ms = 2000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(ms).then(() => 'timeout')]);

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
const end = (reason) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: {} }, { type: 'message_stop' }];
const textReply = (text) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
const noText = (reason = 'end_turn') => sse([start, ...end(reason)]);
const emptyTextBlock = () => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
let toolN = 0;
const toolReply = (uses, { lead = null } = {}) => {
  const ev = [start];
  let i = 0;
  if (lead != null) ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, ...(lead ? [{ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: lead } }] : []), { type: 'content_block_stop', index: i++ });
  for (const u of uses) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${++toolN}`, name: u.name, input: {} } },
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input || {}) } }, { type: 'content_block_stop', index: i++ });
  }
  return sse([...ev, ...end('tool_use')]);
};

// What the Messages API refuses in `messages` (a 400 invalid_request_error), as far as this chat can produce it.
function apiProblem(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages: at least one message is required';
  if (messages[0].role !== 'user') return 'messages: first message must use the "user" role';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const final = i === messages.length - 1;
    if (typeof m.content === 'string') {
      if (!m.content.trim() && !(final && m.role === 'assistant')) return `messages.${i}: all messages must have non-empty content except for the optional final assistant message`;
      continue;
    }
    if (!Array.isArray(m.content) || (!m.content.length && !(final && m.role === 'assistant'))) return `messages.${i}: all messages must have non-empty content`;
    for (const b of m.content) {
      if (b.type === 'text' && !String(b.text || '').trim()) return `messages.${i}: text content blocks must contain non-whitespace text`;
      if (b.type === 'tool_use') {
        const next = messages[i + 1];
        const ok = next && next.role === 'user' && Array.isArray(next.content) && next.content.some((r) => r.type === 'tool_result' && r.tool_use_id === b.id);
        if (!ok) return `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${b.id}`;
      }
      // (the API refuses text before a tool_result in a user message: the tool_results come first)
      if (b.type === 'tool_result' && m.content.indexOf(b) > m.content.findIndex((x) => x.type !== 'tool_result') && m.content.some((x) => x.type !== 'tool_result')) return `messages.${i}: tool_result blocks must come first in the content`;
      if (b.type === 'tool_result') {
        const prev = messages[i - 1];
        const ok = prev && prev.role === 'assistant' && Array.isArray(prev.content) && prev.content.some((u) => u.type === 'tool_use' && u.id === b.tool_use_id);
        if (!ok) return `messages.${i}: unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}`;
      }
    }
  }
  return null;
}

// A fetch whose replies the test scripts, refusing invalid conversations as the API does: { body } at once,
// { chunks, stall } pieces and then left open, { gate } held until open() is called, { status } an HTTP error.
function strictApi(replies) {
  const calls = [], refused = [];
  const fetch = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, signal: init.signal });
    const abortErr = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const problem = apiProblem(body.messages);
    if (problem) {
      refused.push(problem);
      return Promise.resolve(new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: problem } }), { status: 400 }));
    }
    const r = replies.shift() || { body: textReply('ok') };
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortErr()), { once: true });
      let ctl;
      const stream = new ReadableStream({ start(c) { ctl = c; } });
      init.signal.addEventListener('abort', () => { try { ctl.error(abortErr()); } catch (e) { /* closed */ } }, { once: true });
      (async () => {
        if (r.gate) await new Promise((go) => { r.open = go; });
        if (r.status) { resolve(new Response(JSON.stringify(r.json || {}), { status: r.status })); return; }
        resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        for (const c of r.chunks || [r.body]) {
          if (init.signal.aborted) return;
          try { ctl.enqueue(new TextEncoder().encode(c)); } catch (e) { return; }
        }
        if (!r.stall) try { ctl.close(); } catch (e) { /* aborted */ }
      })();
    });
  };
  return { fetch, calls, refused };
}

// a Session with Ask Claude started on a Dragon 64 at its prompt
function askSession({ include = null, stallMs } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  s.setClaudeKey(KEY);
  for (let i = 0; i < 20; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  const replies = [];
  const api = strictApi(replies);
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: api.fetch, apiKey: KEY, ...(stallMs ? { stallMs } : {}) }), include });
  const tools = [];
  chat.onToolUse = (name, input, text, isError, value) => tools.push({ name, text, isError, value });
  return { s, chat, replies, api, tools };
}

(async () => {
  // ================= an INCLUDE that never arrives =================
  {
    // the reader on its own: the fetch gets a signal, Stop and the timeout each end a read that never answers
    const seen = [];
    const never = (url, init) => { seen.push({ url, signal: init && init.signal }); return new Promise(() => {}); };
    const read = Emu.exampleReader(never, 'examples/', { timeoutMs: 60000 });
    const ctl = new AbortController();
    const p = within(read('hang.asm', { signal: ctl.signal }));
    await sleep(20);
    ctl.abort();
    const r = await p;
    check('INCLUDE reader: Stop ends a read whose fetch never answers (error code aborted), and the fetch\'s own signal is aborted',
      r !== 'timeout' && r.e && r.e.code === 'aborted' && seen[0].signal && seen[0].signal.aborted && seen[0].url === 'examples/hang.asm', JSON.stringify(r));
    const t = Date.now();
    // (timeoutMs 200 against >= 195: a timer can fire a millisecond early by Date.now(); the point is the code)
    const r2 = await within(Emu.exampleReader(never, 'examples/', { timeoutMs: 200 })('slow.asm'), 3000);
    check('INCLUDE reader: with no Stop, a read that never answers ends at the timeout (error code timeout)', r2 !== 'timeout' && r2.e && r2.e.code === 'timeout' && Date.now() - t >= 195
      && seen[1].signal.aborted, JSON.stringify(r2));
    check('INCLUDE reader: the default timeout is 15 s', Emu.INCLUDE_TIMEOUT_MS === 15000);
    // a fetch that follows the spec and rejects (AbortError) the moment its signal aborts: still timeout / aborted
    const spec = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const rt = await within(Emu.exampleReader(spec, 'examples/', { timeoutMs: 40 })('t.asm'), 3000);
    const sc = new AbortController();
    const ra = within(Emu.exampleReader(spec, 'examples/', { timeoutMs: 60000 })('s.asm', { signal: sc.signal }), 3000);
    sc.abort();
    const rs = await ra;
    check('INCLUDE reader: with a fetch that rejects at once on abort, the timeout is still timeout and Stop still aborted (not a missing file)',
      rt.e && rt.e.code === 'timeout' && rs.e && rs.e.code === 'aborted', JSON.stringify([rt, rs]));
    // a body that never finishes is a hang too
    const slowBody = () => Promise.resolve({ ok: true, text: () => new Promise(() => {}) });
    const r3 = await within(Emu.exampleReader(slowBody, 'examples/', { timeoutMs: 60 })('body.asm'), 3000);
    check('INCLUDE reader: a body that never finishes ends at the timeout too', r3 !== 'timeout' && r3.e && r3.e.code === 'timeout', JSON.stringify(r3));
    // what still works as before: a file, a missing one, a refused name (no request), a failed connection
    const files = { 'a.asm': ' FCB 1\n' };
    const fake = (url) => { seen.push({ url }); const name = url.slice('examples/'.length); return Promise.resolve(files[name] != null ? new Response(files[name]) : new Response('', { status: 404 })); };
    const rd = Emu.exampleReader(fake);
    const before = seen.length;
    check('INCLUDE reader: a file reads, a missing file and a failed connection are null, an unsafe name is null without a request',
      await rd('a.asm') === ' FCB 1\n' && await rd('b.asm') === null && await rd('../x') === null && seen.length === before + 2
      && await Emu.exampleReader(() => Promise.reject(new TypeError('fetch failed')))('c.asm') === null);
  }
  {
    // Stop in the panel's turn while assemble_and_load waits on the page's reader with a fetch that never answers
    const fetched = [];
    const include = Emu.exampleReader((url, init) => { fetched.push(init && init.signal); return new Promise(() => {}); });
    const { s, chat, replies, api, tools } = askSession({ include });
    s.consent.setAllowed(true);
    const ram = s.shownMachine.ram[0x3000];
    replies.push({ body: toolReply([{ name: 'assemble_and_load', input: { source: ' INCLUDE "hang.asm"\n FCB 9\n', org: 0x3000 } }]) }, { body: textReply('should not be asked') });
    const turn = chat.sendLine('assemble it');
    check('INCLUDE turn: the read is under way, with the status Using assemble_and_load…', await until(() => fetched.length === 1)
      && s.claudeStatus && s.claudeStatus.text === 'Using assemble_and_load…', JSON.stringify(s.claudeStatus));
    s.stopClaude();
    const r = await within(turn);
    check('INCLUDE turn: Stop ends the turn (stopped), the fetch is aborted, the tool fails stopped, nothing is written, no further request',
      r !== 'timeout' && r.v === null && chat.error && chat.error.code === 'aborted' && !chat.busy && s.claudeStatus === null && fetched[0].aborted
      && tools.length === 1 && tools[0].isError && tools[0].value.code === Emu.TOOL_CODES.STOPPED && s.shownMachine.ram[0x3000] === ram && api.calls.length === 1,
      `${r === 'timeout' ? 'the turn hung' : ''} ${chat.error && chat.error.code} calls ${api.calls.length} ${tools.map((x) => x.value && x.value.code)}`);
    replies.length = 0;
    replies.push({ body: textReply('Here again.') });
    await within(chat.sendLine('hello?'));
    check('INCLUDE turn: the next line is answered', chat.messages.slice(-1)[0].content === 'Here again.' && !api.refused.length, api.refused.join('; '));
    s.endChat();
  }
  {
    // the timeout: the tool returns include-unreadable to the model, and the turn goes on to its reply
    const include = Emu.exampleReader(() => new Promise(() => {}), 'examples/', { timeoutMs: 50 });
    const { s, chat, replies, api, tools } = askSession({ include });
    s.consent.setAllowed(true);
    replies.push({ body: toolReply([{ name: 'assemble_and_load', input: { source: ' INCLUDE "hang.asm"\n', org: 0x3000 } }]) }, { body: textReply('The include file could not be read.') });
    const r = await within(chat.sendLine('assemble it'), 3000);
    const result = api.calls[1] && api.calls[1].body.messages.slice(-1)[0].content[0];
    check('INCLUDE timeout: the tool fails include-unreadable naming the file, the model is told so, and the turn ends with its reply',
      r !== 'timeout' && r.v && tools[0].isError && tools[0].value.code === Emu.TOOL_CODES.INCLUDE_UNREADABLE && /hang\.asm/.test(tools[0].value.tool.detail)
      && result && result.is_error && JSON.parse(result.content).error.code === 'include-unreadable'
      && chat.messages.slice(-1)[0].content === 'The include file could not be read.' && !chat.busy && s.claudeStatus === null, JSON.stringify(result));
    s.endChat();
  }
  {
    // several INCLUDEs on a server that does not answer: the first timeout fails the call, the rest are not waited for
    const asked = [];
    const include = Emu.exampleReader((url) => { asked.push(url); return new Promise(() => {}); }, 'examples/', { timeoutMs: 50 });
    const { s, chat, replies, tools } = askSession({ include });
    s.consent.setAllowed(true);
    replies.push({ body: toolReply([{ name: 'assemble_and_load', input: { source: ' INCLUDE "a.asm"\n INCLUDE "b.asm"\n INCLUDE "c.asm"\n', org: 0x3000 } }]) }, { body: textReply('No.') });
    await within(chat.sendLine('assemble it'), 3000);
    check('INCLUDE timeout with three INCLUDEs: one read is waited for, the call fails include-unreadable naming it', asked.join() === 'examples/a.asm'
      && tools[0].value.code === Emu.TOOL_CODES.INCLUDE_UNREADABLE && /a\.asm/.test(tools[0].value.tool.detail), asked.join());
    s.endChat();
  }
  {
    // a reader that ignores the signal altogether (an embedder's): Stop still ends the turn
    let asked = 0;
    const { s, chat, replies } = askSession({ include: () => { asked++; return new Promise(() => {}); } });
    s.consent.setAllowed(true);
    replies.push({ body: toolReply([{ name: 'assemble_and_load', input: { source: ' INCLUDE "x.asm"\n', org: 0x3000 } }]) });
    const turn = chat.sendLine('assemble it');
    await until(() => asked === 1);
    s.stopClaude();
    const r = await within(turn);
    check('INCLUDE deaf reader: Stop ends the turn even though the read never ends', r !== 'timeout' && chat.error && chat.error.code === 'aborted' && !chat.busy);
    s.endChat();
  }

  // ================= the pause belongs to its turn =================
  const pausedTurn = async (s, chat, replies, reply) => {
    const m = s.shownMachine;
    s.consent.setAllowed(true);
    const gated = { gate: true, ...reply };
    replies.push(gated);
    const turn = chat.sendLine('type for me');
    await until(() => !!gated.open);
    // Claude has typing going in during the turn (as a type_text in progress would)
    const job = s.typeTextPaced('10 PRINT 1\n20 PRINT 2\n', m);
    s.claudeActing = { name: 'type_text', input: { text: '10 PRINT 1\n20 PRINT 2\n' } };
    const paused = s.pauseClaude();
    const during = s.claudeStatus;
    gated.open();
    const r = await within(turn);
    return { paused, during, r, job, m };
  };
  for (const [how, reply, code] of [['finishes', { body: textReply('Done.') }, null], ['fails', { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }, 'server-error']]) {
    const { s, chat, replies, api } = askSession();
    const { paused, during, r, job, m } = await pausedTurn(s, chat, replies, reply);
    check(`pause per turn: a turn that ${how} while paused: the pause ends with it, nothing it held is typed, the held typing ends stopped`,
      paused && during && during.phase === 'paused' && r !== 'timeout' && s.consent.paused === null && job.status === 'stopped'
      && m.typist.queue.length === 0 && (code ? chat.error && chat.error.code === code : !chat.error), `${JSON.stringify(during)} ${chat.error && chat.error.code}`);
    // the next turn does not start paused: its status is Thinking…, and an acting tool runs without waiting for a Resume
    s.claudeActing = null;
    const ram = m.ram[0x3000];
    const next = { gate: true, body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [(ram + 1) & 0xFF] } }]) };
    replies.push(next, { body: textReply('Poked.') });
    const turn = chat.sendLine('poke it');
    await until(() => !!next.open);
    const status = s.claudeStatus;
    next.open();
    const r2 = await within(turn);
    check(`pause per turn: after a turn that ${how} while paused, the next turn is not paused: Thinking…, and its poke runs without a Resume`,
      status && status.phase === 'thinking' && r2 !== 'timeout' && m.ram[0x3000] === ((ram + 1) & 0xFF) && chat.messages.slice(-1)[0].content === 'Poked.' && !api.refused.length,
      `${JSON.stringify(status)} ${r2 === 'timeout' ? 'the turn hung' : ''}`);
    s.endChat();
  }
  {
    // stopped while paused (already so before; kept), and no pause outside a turn
    const { s, chat, replies } = askSession();
    const gated = { gate: true, body: textReply('x') };
    s.consent.setAllowed(true);
    replies.push(gated);
    const turn = chat.sendLine('type');
    await until(() => !!gated.open);
    const job = s.typeTextPaced('10 PRINT 1\n', s.shownMachine);
    s.claudeActing = { name: 'type_text', input: { text: '10 PRINT 1\n' } };
    s.pauseClaude();
    s.stopClaude();
    const r = await within(turn);
    check('pause per turn: Stop while paused: the turn ends stopped and the pause with it', r !== 'timeout' && s.consent.paused === null && job.status === 'stopped' && chat.error.code === 'aborted');
    // after the turn: Claude's typing still going in, a key does not pause (there is no turn to resume)
    s.typeTextPaced('10 PRINT 1\n', s.shownMachine);
    s.claudeActing = { name: 'type_text', input: { text: '10 PRINT 1\n' } };
    check('pause per turn: no turn in progress: pauseClaude does nothing, so no pause can carry into the next turn', !chat.busy && s.claudeBusyActing && s.pauseClaude() === false && s.consent.paused === null);
    s.endChat();
  }

  // ================= the history stays one the API accepts =================
  const valid = (api, i) => api.calls[i] && apiProblem(api.calls[i].body.messages) === null;
  const noBlank = (chat) => chat.messages.every((m) => typeof m.content !== 'string' || m.content.trim());
  {
    const cases = [
      ['a turn of tool calls only (no text at all)', [{ body: toolReply([{ name: 'machine_info' }]) }, { body: noText() }]],
      ['a turn of tool calls after an empty text block, then no text', [{ body: toolReply([{ name: 'machine_info' }], { lead: '' }) }, { body: emptyTextBlock() }]],
      ['a refusal (no text blocks)', [{ body: noText('refusal') }]],
      ['a refusal after tool calls', [{ body: toolReply([{ name: 'machine_info' }]) }, { body: noText('refusal') }]],
      ['a reply of whitespace only', [{ body: textReply('\n  \n') }]],
      ['a reply that is an empty text block', [{ body: emptyTextBlock() }]],
    ];
    for (const [what, script] of cases) {
      const { chat, replies, api, s } = askSession();
      replies.push({ body: textReply('First answer.') });
      await chat.sendLine('first');
      replies.push(...script);
      const r = await within(chat.sendLine('second'));
      replies.length = 0;
      replies.push({ body: textReply('Third answer.') });
      const at = api.calls.length;
      const r3 = await within(chat.sendLine('third'));
      // the next request: 'second' is never glued to 'third' (a turn of tool calls is a note of what it used; a
      // refusal or nothing drops the question, so a refused question is not sent again inside every later one)
      const sent = api.calls[at].body.messages;
      // (a refusal after tool calls keeps the question, its tool round - the tool_use and its tool_result - and the note)
      const tooly = /tool calls/.test(what);
      const shape = tooly
        ? sent.length === 7 && sent[2].content === 'second' && sent[3].role === 'assistant' && sent[3].content.some((b) => b.type === 'tool_use' && b.name === 'machine_info')
          && sent[4].content[0].type === 'tool_result' && sent[4].content[0].tool_use_id === sent[3].content.find((b) => b.type === 'tool_use').id
          && sent[5].role === 'assistant' && sent[5].content === '(Note from the page, not a reply: in this turn Claude called machine_info and wrote no text.)'
          && chat.messages.filter((m) => m.note).length === 1 && !('note' in sent[5]) && sent[6].content === 'third'
        : sent.length === 3 && sent[2].content === 'third' && !JSON.stringify(sent).includes('second');
      check(`history: ${what}: no blank assistant message is kept, every request is valid, the question is not glued to the next, and the next line is answered`,
        r !== 'timeout' && r3 !== 'timeout' && noBlank(chat) && !api.refused.length && valid(api, at) && shape && !chat.error && chat.messages.slice(-1)[0].content === 'Third answer.',
        `${api.refused.join('; ')} ${chat.error && chat.error.message} ${JSON.stringify(sent)}`);
      s.endChat();
    }
  }
  {
    // Stop before any text, an SSE error mid-reply, the stall limit mid-reply, Stop during a tool: the next request is valid
    const ends = [
      ['Stop before any text', { gate: true, body: textReply('never') }, async (s, r) => { await until(() => !!r.open); s.stopClaude(); r.open(); }],
      ['an error event mid-reply', { chunks: [sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] }, null],
      ['the stall limit mid-reply', { stall: true, chunks: [sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } }])] }, null],
      ['Stop during a tool', { body: toolReply([{ name: 'assemble_and_load', input: { source: ' INCLUDE "x.asm"\n', org: 0x3000 } }]) }, async (s) => { await until(() => s.claudeTool === 'assemble_and_load'); s.stopClaude(); }],
    ];
    for (const [what, reply, act] of ends) {
      const { chat, replies, api, s } = askSession({ stallMs: 80, include: () => new Promise(() => {}) });
      s.consent.setAllowed(true);
      replies.push({ body: textReply('First answer.') });
      await chat.sendLine('first');
      replies.push(reply);
      const turn = chat.sendLine('second');
      if (act) await act(s, reply);
      const r = await within(turn);
      const failed = chat.error && chat.error.code;
      replies.length = 0;
      replies.push({ body: textReply('Next answer.') });
      const at = api.calls.length;
      await within(chat.sendLine('next'));
      check(`history: ${what}: the turn ends (${failed}), the history has no blank message, and the next request is valid and answered`,
        r !== 'timeout' && failed && noBlank(chat) && valid(api, at) && !api.refused.length && chat.messages.slice(-1)[0].content === 'Next answer.'
        // the person's lines: a turn in which a tool result came back keeps its line (marked ended) and the result
        // with the page's note; a turn in which none did is dropped
        && chat.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join() === (/during a tool/.test(what) ? 'first,second,next' : 'first,next')
        && (!/during a tool/.test(what) || (chat.messages.find((m) => m.content === 'second').ended === 'aborted'
          && JSON.stringify(api.calls[at].body.messages).includes('(Note from the page: this turn ended with aborted after these tool results.)'))),
        `${api.refused.join('; ')} ${JSON.stringify(chat.messages)}`);
      s.endChat();
    }
  }
  {
    // the backend on a history that is already wrong (an empty assistant message, as a chat from before this fix
    // could hold): the request it sends is valid, and the reply comes
    const replies = [{ body: textReply('Fine.') }];
    const api = strictApi(replies);
    const b = new Emu.ClaudeBackend({ fetch: api.fetch, apiKey: KEY });
    const out = await b.send({ system: 'S', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '' }, { role: 'user', content: 'b' }] });
    check('history: backend: a history holding an empty assistant message is sent as a valid conversation (no 400)', out.text === 'Fine.' && !api.refused.length && valid(api, 0)
      && JSON.stringify(api.calls[0].body.messages) === JSON.stringify([{ role: 'user', content: 'a\n\nb' }]), JSON.stringify(api.calls[0].body.messages));
  }
  {
    // apiMessages on hand-built histories; the expected outputs are written out by hand
    const A = Emu.apiMessages;
    const think = { type: 'thinking', thinking: 't', signature: 'sig' };
    const use = (id) => ({ type: 'tool_use', id, name: 'peek', input: {} });
    const res = (id) => ({ type: 'tool_result', tool_use_id: id, content: '1' });
    const good = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [think, { type: 'text', text: 'looking' }, use('u1')] }, { role: 'user', content: [res('u1')] }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }];
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    check('history: apiMessages: a valid conversation is unchanged (and the input is not modified)', same(A(good), good) && apiProblem(good) === null);
    const input = [{ role: 'assistant', content: 'stale' }, { role: 'user', content: 'q' }, { role: 'assistant', content: '' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: '  \n' }, { role: 'user', content: 'q3' }];
    const copy = JSON.stringify(input);
    check('history: apiMessages: a leading assistant message and empty or blank assistant messages are dropped, and the user lines joined',
      same(A(input), [{ role: 'user', content: 'q\n\nq2\n\nq3' }]) && JSON.stringify(input) === copy, JSON.stringify(A(input)));
    check('history: apiMessages: a tool_use without its tool_result is dropped, and an assistant message left with only thinking goes too',
      same(A([{ role: 'user', content: 'q' }, { role: 'assistant', content: [think, use('u2')] }, { role: 'user', content: 'q2' }]), [{ role: 'user', content: 'q\n\nq2' }]),
      JSON.stringify(A([{ role: 'user', content: 'q' }, { role: 'assistant', content: [think, use('u2')] }, { role: 'user', content: 'q2' }])));
    check('history: apiMessages: a tool_result without its tool_use is dropped; blank text blocks are dropped, others kept',
      same(A([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'ok' }] }, { role: 'user', content: [res('zz'), { type: 'text', text: 'more' }] }]),
        [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'more' }] }]));
    check('history: apiMessages: two tool_uses, one answered: the answered pair is kept, the other dropped',
      same(A([{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('a'), use('b')] }, { role: 'user', content: [res('a')] }]),
        [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('a')] }, { role: 'user', content: [res('a')] }]));
    // every output above, and random mixes of these pieces, are conversations the API accepts
    const pieces = [{ role: 'user', content: 'u' }, { role: 'user', content: '' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: '' }, { role: 'assistant', content: ' ' },
      { role: 'assistant', content: [think, use('r1')] }, { role: 'user', content: [res('r1')] }, { role: 'user', content: [res('r2')] }, { role: 'assistant', content: [{ type: 'text', text: '' }] }, { role: 'assistant', content: [] }];
    let seed = 7, bad = null;
    const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % k; };
    // (more pieces: text with a tool_result, a user line before one; the history the chat sends always ends on the
    // person's line, so that is added after each random history half the time)
    pieces.push({ role: 'user', content: [{ type: 'text', text: 'note' }, res('r1')] }, { role: 'user', content: [{ type: 'text', text: ' ' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }, use('r2')] });
    let threw = 0;
    for (let t = 0; t < 4000 && !bad; t++) {
      const h = Array.from({ length: 1 + rnd(8) }, () => pieces[rnd(pieces.length)]);
      if (rnd(2)) h.push({ role: 'user', content: 'last line' });
      let out = null, err = null;
      try { out = A(h); } catch (e) { err = e; }
      const asks = h[h.length - 1].role === 'user' && typeof h[h.length - 1].content === 'string' && h[h.length - 1].content.trim();
      if (err) { threw++; if (err.code !== 'bad-history' || asks) bad = { h, why: `threw ${err.code} ${err.message}` }; continue; }
      const why = apiProblem(out) || (out[out.length - 1].role !== 'user' ? 'it ends on an assistant message' : null);
      if (why) bad = { h, out, why };
      else if (asks && !(typeof out[out.length - 1].content === 'string' ? out[out.length - 1].content : out[out.length - 1].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')).endsWith(h[h.length - 1].content)) bad = { h, out, why: 'the last line was lost' };
    }
    check('history: apiMessages: 4000 random histories of good and bad pieces all come out valid (ending on the person\'s line, never lost), or are refused with bad-history when nothing ends them',
      !bad && threw > 0, bad ? JSON.stringify(bad) : `${threw} refused`);
    // the shapes a review found (each failed before): an orphan tool_result left first, text joined before a
    // tool_result, a blank last user message, nothing at all
    const orphanFirst = [{ role: 'assistant', content: [use('x')] }, { role: 'user', content: [res('x')] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'q' }];
    check('history: apiMessages: a tool_result whose tool_use was the dropped leading message is dropped too (it never comes first)',
      same(A(orphanFirst), [{ role: 'user', content: 'q' }]), JSON.stringify(A(orphanFirst)));
    const textBefore = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('y')] }, { role: 'user', content: 'note' }, { role: 'user', content: [res('y')] }];
    const tb = A(textBefore);
    check('history: apiMessages: a user line joined with a tool_result comes after it (tool_results first), and the result is valid',
      same(tb, [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('y')] }, { role: 'user', content: [res('y'), { type: 'text', text: 'note' }] }]) && apiProblem(tb) === null, JSON.stringify(tb));
    const inOne = A([{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('z')] }, { role: 'user', content: [{ type: 'text', text: 'n' }, res('z')] }]);
    check('history: apiMessages: text before a tool_result in one user message is put after it', same(inOne.slice(-1), [{ role: 'user', content: [res('z'), { type: 'text', text: 'n' }] }]) && apiProblem(inOne) === null, JSON.stringify(inOne));
    const refusedWith = (h) => { try { return { out: A(h) }; } catch (e) { return { code: e.code, message: e.message }; } };
    const blankLast = refusedWith([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '  ' }]);
    check('history: apiMessages: a blank last user message is refused (bad-history), not sent as a conversation ending on the assistant', blankLast.code === 'bad-history' && /does not end with a question/.test(blankLast.message), JSON.stringify(blankLast));
    const nothing = [[], [{ role: 'user', content: ' ' }], [{ role: 'assistant', content: 'a' }]].map(refusedWith);
    check('history: apiMessages: nothing to send (no messages, only blank, only an assistant message) is refused (bad-history), never []', nothing.every((r) => r.code === 'bad-history'), JSON.stringify(nothing));
    // what an adversarial review found getting through (each passed both apiMessages and the checker before)
    const q = { role: 'user', content: 'q' };
    const tu = (id) => ({ type: 'tool_use', name: 'peek', input: {}, ...(id === undefined ? {} : { id }) });
    const tr = (id) => ({ type: 'tool_result', content: '1', ...(id === undefined ? {} : { tool_use_id: id }) });
    const odd = [
      ['a repeated tool_use id', [q, { role: 'assistant', content: [tu('a'), tu('a')] }, { role: 'user', content: [tr('a'), { type: 'text', text: 'q2' }] }],
        [q, { role: 'assistant', content: [tu('a')] }, { role: 'user', content: [tr('a'), { type: 'text', text: 'q2' }] }]],
      ['one tool_use answered twice', [q, { role: 'assistant', content: [tu('a')] }, { role: 'user', content: [tr('a'), tr('a'), { type: 'text', text: 'q2' }] }],
        [q, { role: 'assistant', content: [tu('a')] }, { role: 'user', content: [tr('a'), { type: 'text', text: 'q2' }] }]],
      ['ids missing', [q, { role: 'assistant', content: [{ type: 'text', text: 't' }, tu()] }, { role: 'user', content: [tr(), { type: 'text', text: 'q2' }] }],
        [q, { role: 'assistant', content: [{ type: 'text', text: 't' }] }, { role: 'user', content: [{ type: 'text', text: 'q2' }] }]],
      ['unknown and untyped blocks', [{ role: 'user', content: [{ type: 'foo' }, { text: 'x' }, 'hi', { type: 'text', text: 'q' }] }], [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]],
      ['thinking in a user message', [{ role: 'user', content: [think, { type: 'text', text: 'q' }] }], [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]],
      ['a server tool block in an assistant message is passed back as it came', [q, { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} }, { type: 'text', text: 'a' }] }, { role: 'user', content: 'q2' }],
        [q, { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} }, { type: 'text', text: 'a' }] }, { role: 'user', content: 'q2' }]],
      ['an image in an assistant message, blocks in the wrong role', [q, { role: 'assistant', content: [{ type: 'image', source: {} }, tr('z'), { type: 'text', text: 'a' }] }, { role: 'user', content: [tu('k'), { type: 'text', text: 'q2' }] }],
        [q, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'text', text: 'q2' }] }]],
    ];
    for (const [what, h, want] of odd) {
      const r = refusedWith(h);
      check(`history: apiMessages: ${what}: made valid (expected written by hand)`, r.out && same(r.out, want) && apiProblem(r.out) === null && Emu.apiShapeProblem(r.out) === null, JSON.stringify(r));
    }
    check('history: apiShapeProblem: repeated or missing ids, a block in the wrong role, an unknown block are each a problem',
      [[q, { role: 'assistant', content: [tu('a'), tu('a')] }, { role: 'user', content: [tr('a')] }], [q, { role: 'assistant', content: [tu('a')] }, { role: 'user', content: [tr('a'), tr('a')] }],
        [q, { role: 'assistant', content: [tu()] }, { role: 'user', content: [tr()] }], [{ role: 'user', content: [think, { type: 'text', text: 'q' }] }], [{ role: 'user', content: [{ type: 'foo' }] }],
        [q, { role: 'assistant', content: [{ type: 'image', source: {} }] }, q]].every((h) => !!Emu.apiShapeProblem(h)));
    check('history: apiShapeProblem: the checker agrees with the mocked API on what is valid', Emu.apiShapeProblem(good) === null && Emu.apiShapeProblem(tb) === null
      && !!Emu.apiShapeProblem([{ role: 'user', content: [{ type: 'text', text: 'n' }, res('y')] }]) && !!Emu.apiShapeProblem([]) && !!Emu.apiShapeProblem([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]));
  }

  {
    // the backend never sends an invalid conversation: the turn fails with bad-history and no request is made
    const api = strictApi([]);
    const b = new Emu.ClaudeBackend({ fetch: api.fetch, apiKey: KEY });
    let err = null;
    try { await b.send({ system: 'S', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: ' ' }] }); } catch (e) { err = e; }
    check('history: backend: a history with no question at the end fails the turn (bad-history, a ClaudeError) and nothing is sent', err && err.code === 'bad-history' && err instanceof Emu.ClaudeError && api.calls.length === 0, err && err.message);
    // sendLine: a blank line is no turn (no request, nothing recorded, not busy), whatever reaches it
    const { chat, api: api2, s } = askSession();
    let ends = 0;
    const was = chat.onTurnEnd;
    chat.onTurnEnd = () => { ends++; was(); };
    const outs = [];
    for (const line of ['', '   ', '\n\t', null, undefined, 42]) outs.push(await chat.sendLine(line));
    check('history: sendLine: a blank (or not a string) line starts no turn: no request, nothing recorded, no error', outs.every((o) => o === null) && api2.calls.length === 0
      && chat.messages.length === 0 && !chat.busy && !chat.error && ends === 0, JSON.stringify({ outs, calls: api2.calls.length, msgs: chat.messages }));
    s.endChat();
  }

  {
    // a key while a card waits pauses Claude (merged with the acting-tools contract: runTool's re-check holds the call
    // past the card): the card stays the person's to answer, and Allow does not let the action run past the pause -
    // it waits for Resume, then acts and the turn ends
    const { s, chat, replies } = askSession();
    s.consent.asker = () => {};
    s.consent.setAllowed(true);
    // (the second poke asks again: the switch is turned off while the reply comes, so its consent card comes up)
    const second = { gate: true, body: toolReply([{ name: 'poke', input: { address: 0x3001, bytes: [2] } }]) };
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [1] } }]) }, second, { body: textReply('Done.') });
    const turn = chat.sendLine('poke twice');
    await until(() => !!second.open);
    s.consent.setAllowed(false);
    second.open();
    await until(() => !!s.consent.pending);
    const during = { acting: s.claudeBusyActing, paused: s.pauseClaude(), state: !!s.consent.paused, card: !!s.consent.pending };
    s.consent.answer(true);
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    const held = { poked: s.shownMachine.ram[0x3001], busy: chat.busy, paused: !!s.consent.paused };
    s.resumeClaude();
    const r = await within(turn);
    check('pause per turn: a key while a card waits pauses Claude (Claude acted this turn), the card stays up; Allow does not act while paused; Resume acts and the turn ends',
      during.acting && during.paused === true && during.state && during.card && held.poked === 0 && held.busy && held.paused
      && s.shownMachine.ram[0x3001] === 2 && r !== 'timeout' && chat.messages.slice(-1)[0].content === 'Done.', JSON.stringify({ during, held }));
    s.endChat();
  }

  {
    // an abort of the turn while paused (BREAK on the chat screen calls chat.abort, not Stop) ends the pause: the
    // action waiting on it is refused, nothing held is typed, the turn ends; a Resume after it does nothing
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const m = s.shownMachine;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { body: textReply('x') });
    // (pause as soon as the first poke has run: the second waits on the pause)
    let job = null;
    const off = s.on(() => { if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); s.pauseClaude(); } });
    const turn = chat.sendLine('poke twice');
    await until(() => !!s.consent.paused);
    const waiting = s.consent.paused && s.consent.paused.wake.length;
    await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0);
    chat.abort();
    const r = await within(turn);
    const resumed = s.resumeClaude();
    await sleep(20);
    check('pause per turn: an abort while paused (BREAK) ends the pause: the waiting poke is refused, nothing held is typed, the turn ends stopped, Resume after it does nothing',
      r !== 'timeout' && s.consent.paused === null && m.ram[0x3001] !== 8 && job && job.status === 'stopped' && m.typist.queue.length === 0 && chat.error && chat.error.code === 'aborted' && resumed === false,
      JSON.stringify({ waiting, r: r === 'timeout' ? r : 'ended', ram: m.ram[0x3001], job: job && job.status, err: chat.error && chat.error.code }));
    if (typeof off === 'function') off();
    s.endChat();
  }

  // Esc while paused and the page's own machine actions: a Reset, a power cycle, a machine switch or a snapshot load while Claude
  // is paused stops Claude: the pause ends, the waiting action is refused, nothing held is ever typed (not into the
  // machine that starts over, not into a new one), the turn ends stopped, and a Resume afterwards does nothing.
  // Reset and power cycle keep the conversation and say why it stopped ('claude-stopped'); a switch or a snapshot
  // load replaces the machine and closes the conversation.
  for (const how of ['reset', 'powerCycle', 'switchMachine', 'openSnapshot']) {
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const m = s.shownMachine;
    const snap = how === 'openSnapshot' ? await s.readSnapshot((await s.snapshotFile()).bytes) : null;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { body: textReply('x') });
    let job = null;
    const notes = [];
    const off = s.on((ev, arg) => {
      if (ev === 'claude-stopped') notes.push(arg);
      if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); s.pauseClaude(); }
    });
    const texts = [];
    chat.onText = (t) => texts.push(t);
    const turn = chat.sendLine('poke twice');
    await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0);
    const held = s.consent.paused && s.consent.paused.held.queue.length;
    if (how === 'reset') s.reset();
    else if (how === 'powerCycle') s.powerCycle();
    else if (how === 'switchMachine') s.switchMachine('coco2');
    else s.openSnapshot(snap);
    const r = await within(turn);
    const resumed = s.resumeClaude();
    for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const now = s.shownMachine;
    const keeps = how === 'reset' || how === 'powerCycle';
    check(`${how} while Claude is paused stops Claude: pause ended, waiting poke refused, held keys dropped, turn ended stopped, Resume afterwards types nothing`,
      held > 0 && r !== 'timeout' && s.consent.paused === null && m.ram[0x3001] !== 8 && now.ram[0x3001] !== 8 && job && job.status === 'stopped'
      && m.typist.queue.length === 0 && now.typist.queue.length === 0 && !(now.stubKeys && now.stubKeys.length) && chat.error && chat.error.code === 'aborted' && resumed === false
      && !s.claudeBusyActing && (keeps ? s.chat === chat && notes.length === 1 && (how === "reset" ? notes[0] === "you reset the machine" : notes[0] === "the machine restarted")
        && texts.includes(`\r\n[stopped: ${notes[0]}]\r\n`) : s.chat === null),
      JSON.stringify({ held, r: r === 'timeout' ? r : 'ended', ram: m.ram[0x3001], job: job && job.status, err: chat.error && chat.error.code, notes, texts, q: now.typist.queue.length }));
    off();
    s.endChat();
  }
  // every other restart of the machine Claude acts on (the machine's onReset): a program, a cartridge, the welcome
  // menu, LIZA, ROMs cleared. Paused: Claude stops, and nothing held is typed into the machine that started over.
  {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const restarts = {
      clearRoms: (s) => s.clearRoms(),
      runAssembled: (s) => s.runAssembled(Emu.assemble('  ORG $4000\nL BRA L\n  END L\n', '6809')),
      'a .bin load': (s) => s.load('x.bin', new Uint8Array([0x00, 0x00, 0x02, 0x40, 0x00, 0x20, 0xFE, 0xFF, 0x00, 0x00, 0x40, 0x00])),
      'a cartridge': (s) => s.load('x.ccc', new Uint8Array(8192).fill(0x12)),
      'the welcome menu': (s) => s.startWelcome(ex('welcome.bin')),
      LIZA: (s) => s.startLiza((n) => ex(n)),
    };
    for (const [how, act] of Object.entries(restarts)) {
      const { s, chat, replies } = askSession();
      s.consent.setAllowed(true);
      const m = s.shownMachine;
      replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { body: textReply('x') });
      let job = null;
      const off = s.on(() => { if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); s.pauseClaude(); } });
      const turn = chat.sendLine('poke twice');
      await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0);
      try { await act(s); } catch (e) { /* (a restart that refuses still must not leave a pause behind) */ }
      const r = await within(turn);
      const resumed = s.resumeClaude();
      const q = s.shownMachine.typist.queue.length;
      check(`a restart by ${how} while Claude is paused stops Claude: the waiting poke is refused, Resume afterwards types nothing`,
        r !== 'timeout' && s.consent.paused === null && resumed === false && q === 0 && s.shownMachine.ram[0x3001] !== 8 && chat.error && chat.error.code === 'aborted' && job.status === 'stopped',
        JSON.stringify({ r: r === 'timeout' ? r : 'ended', resumed, q, err: chat.error && chat.error.code, job: job && job.status }));
      off();
      s.endChat();
    }
  }
  // with a BASIC ROM fitted (our own: BRA * at $8000, the reset vector there) a program starts without a reset; it
  // takes over the machine all the same, so loading or running one stops Claude, paused or acting
  {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const rom = new Uint8Array(16384); rom[0] = 0x20; rom[1] = 0xFE; rom[0x3FFE] = 0x80; rom[0x3FFF] = 0x00;
    const loads = {
      'a machine-code .bin': (s) => s.load('x.bin', new Uint8Array([0x00, 0x00, 0x02, 0x40, 0x00, 0x20, 0xFE, 0xFF, 0x00, 0x00, 0x40, 0x00])),
      runAssembled: (s) => s.runAssembled(Emu.assemble('  ORG $4000\nL BRA L\n  END L\n', '6809')),
      LIZA: (s) => s.startLiza((n) => ex(n)),
      'a .bas listing': (s) => s.load('x.bas', new TextEncoder().encode('10 PRINT "HI"\n20 GOTO 10\n')),
    };
    for (const [how, act] of Object.entries(loads)) {
      for (const paused of [true, false]) {
        const { s, chat, replies } = askSession();
        s.shownMachine.setRoms({ basic: rom, basic64: null }); s.shownMachine.reset(true);
        s.consent.setAllowed(true);
        const m = s.shownMachine;
        replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { gate: true, body: textReply('x') });
        let job = null;
        const off = s.on(() => { if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); if (paused) s.pauseClaude(); } });
        const turn = chat.sendLine('poke twice');
        if (paused) await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0); else await until(() => !!job && m.typist.queue.length > 0);
        const fromBefore = m.typist.queue.length;
        try { await act(s); } catch (e) { /* (a load that refuses still must not leave Claude going) */ }
        const r = await within(turn);
        const resumed = s.resumeClaude();
        const own = m.typist.queue.filter((c) => c && c.job === job).length;
        check(`with ROMs, ${how} while Claude is ${paused ? 'paused' : 'typing'} stops Claude: the turn ends stopped, ${paused ? 'the waiting poke is refused, ' : ''}none of Claude's keys are typed into the program`,
          r !== 'timeout' && s.consent.paused === null && resumed === false && own === 0 && chat.error && chat.error.code === 'aborted' && job.status === 'stopped' && !s.claudeBusyActing
          && (!paused || m.ram[0x3001] !== 8),
          JSON.stringify({ r: r === 'timeout' ? r : 'ended', resumed, own, fromBefore, err: chat.error && chat.error.code, job: job && job.status }));
        off();
        s.endChat();
      }
    }
  }
  // a load that is refused or cancelled takes nothing over: Claude stays paused (Resume works) and no note is made
  {
    const refused = {
      'a raw file whose address prompt is cancelled': (s) => s.load('x.raw', new Uint8Array(100).fill(1), { askAddresses: () => null }),
      'a .bas listing without a ROM': (s) => s.load('x.bas', new TextEncoder().encode('10 PRINT "HI"\n')),
      'a disk image': (s) => s.load('x.dsk', new Uint8Array(161280)),
    };
    for (const [how, act] of Object.entries(refused)) {
      const { s, chat, replies } = askSession();
      s.consent.setAllowed(true);
      const m = s.shownMachine;
      replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { body: textReply('x') });
      let job = null;
      const notes = [];
      const off = s.on((ev, arg) => { if (ev === 'claude-stopped') notes.push(arg); if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); s.pauseClaude(); } });
      const turn = chat.sendLine('poke twice');
      await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0);
      let threw = false;
      try { await act(s); } catch (e) { threw = true; }
      const still = !!s.consent.paused && chat.busy;
      const resumed = s.resumeClaude();
      const r = await within(turn);
      check(`${how} (refused) leaves Claude paused, no note; Resume then carries on`,
        threw && still && resumed === true && !notes.length && r !== 'timeout' && !chat.error && m.ram[0x3001] === 8,
        JSON.stringify({ threw, still, resumed, notes, err: chat.error && chat.error.code }));
      off();
      s.endChat();
    }
  }
  // what the program on the machine asks for itself (Session.asMachine, as the page's welcome handlers run it):
  // Claude typing 1 on the welcome menu starts LIZA, and that does not stop Claude's turn; while paused, the key
  // was the person's, so the same start stops Claude
  {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.startWelcome(ex(s.welcomeFile));
    for (let i = 0; i < 200; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    s.consent.setAllowed(true);
    const done = { gate: true, body: textReply('LIZA is up.') };
    replies.push({ body: toolReply([{ name: 'type_text', input: { text: '1' } }]) }, done);
    const notes = [];
    let liza = null;
    const off = s.on((ev, arg) => {
      if (ev === 'claude-stopped') notes.push(arg);
      if (ev === 'welcome:liza') liza = s.asMachine(() => s.runLiza(ex(s.lizaFile)), s.machineTicket());
    });
    const turn = chat.sendLine('start LIZA for me');
    for (let i = 0; i < 1200 && !liza; i++) { s.advance(1000 / s.shownMachine.fps + 0.01); await sleep(1); }
    await until(() => !!done.open || !chat.busy);
    const during = { liza: !!liza, busy: chat.busy, err: chat.error && chat.error.code, notes: notes.slice() };
    if (done.open) done.open();
    const r = await within(turn);
    check('Claude choosing LIZA on the welcome menu (its own key) starts LIZA and its turn goes on: not stopped, no note',
      during.liza && during.busy && !during.err && !notes.length && r !== 'timeout' && chat.messages.slice(-1)[0].content === 'LIZA is up.', JSON.stringify(during));
    off();
    s.endChat();
  }
  {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const m = s.shownMachine;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }, { name: 'poke', input: { address: 0x3001, bytes: [8] } }]) }, { body: textReply('x') });
    let job = null;
    const off = s.on(() => { if (!job && m.ram[0x3000] === 7 && s.claudeActing) { job = s.typeTextPaced('10 PRINT 1\n', m); s.pauseClaude(); } });
    const turn = chat.sendLine('poke twice');
    await until(() => !!s.consent.paused && s.consent.paused.wake.length > 0);
    s.asMachine(() => s.runLiza(ex(s.lizaFile)), s.machineTicket());
    const r = await within(turn);
    check('a program start the machine asked for while Claude is paused (the person\'s key) stops Claude; Resume afterwards types nothing',
      r !== 'timeout' && s.consent.paused === null && s.resumeClaude() === false && s.shownMachine.typist.queue.length === 0 && chat.error && chat.error.code === 'aborted',
      JSON.stringify({ err: chat.error && chat.error.code }));
    off();
    s.endChat();
  }
  // Every way the person's input reaches the machine Claude acts on pauses Claude, as a key on the screen does,
  // so the ticket counts only Claude's own typing: the person's text (Session.typeText: a paste, the type-in panel,
  // a tap on the welcome menu, a POKE from the book, the embed API) and the person's keys (Session.personInput: the
  // keyboard on the screen or the page's body, the on-screen keys). Claude's own typing (typeTextPaced, and RUN for
  // its run tool, queueText) never does.
  for (const how of ['typed text (a paste, the type-in panel, a tap on the menu)', 'a key (the page\'s body, an on-screen key)']) {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.startWelcome(ex(s.welcomeFile));
    for (let i = 0; i < 200; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    s.consent.setAllowed(true);
    const next = { gate: true, body: toolReply([{ name: 'type_text', input: { text: '2' } }]) };
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, next, { body: textReply('x') });
    let liza = null;
    const off = s.on((ev) => { if (ev === 'welcome:liza') liza = s.asMachine(() => s.runLiza(ex(s.lizaFile)), s.machineTicket()); });
    const turn = chat.sendLine('poke, then choose');
    await until(() => !!next.open && s.claudeBusyActing);
    const before = s.claudeStatus && s.claudeStatus.phase;
    if (how.startsWith('typed')) s.typeText('1');
    else { s.personInput(); s.shownMachine.stubKeys.push(0x31); }
    const paused = !!s.consent.paused, phase = s.claudeStatus && s.claudeStatus.phase;
    for (let i = 0; i < 600 && !liza; i++) { s.advance(1000 / s.shownMachine.fps + 0.01); await sleep(0); }
    if (next.open) next.open();
    const r = await within(turn);
    check(`the person's input: the person's ${how} while Claude acts at the welcome menu pauses Claude, and LIZA it starts stops Claude's turn (not Claude's ticket)`,
      before === 'thinking' && paused && phase === 'paused' && !!liza && r !== 'timeout' && chat.error && chat.error.code === 'aborted' && !s.claudeBusyActing,
      JSON.stringify({ before, paused, phase, liza: !!liza, err: chat.error && chat.error.code }));
    off();
    s.endChat();
  }
  {
    // the POKE book's line, Claude's own RUN, and input to another machine than Claude's
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const next = { gate: true, body: textReply('x') };
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, next);
    const turn = chat.sendLine('poke');
    await until(() => !!next.open && s.claudeBusyActing);
    s.queueText('RUN\n');
    const ownRun = !!s.consent.paused;
    const other = s.personInput({});
    const poke = s.typePoke(0) && !!s.consent.paused;
    const pauses = s.consent.pauses;
    const again = s.personInput();
    next.open();
    await within(turn);
    check('the person\'s input: a POKE typed from the book pauses Claude; Claude\'s own RUN (queueText) and input to another machine do not; once paused, more input makes no new pause',
      !ownRun && other === false && poke && again === false && s.consent.pauses === pauses, JSON.stringify({ ownRun, other, poke, again }));
    s.endChat();
  }
  {
    // a POKE from the book while a program runs on the stub (the welcome menu) is stored at once, not typed: the
    // person's change to Claude's machine all the same, so Claude pauses first
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.startWelcome(ex(s.welcomeFile));
    for (let i = 0; i < 200; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    s.consent.setAllowed(true);
    const next = { gate: true, body: textReply('x') };
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, next);
    const turn = chat.sendLine('poke');
    await until(() => !!next.open && s.claudeBusyActing);
    const msg = s.typePoke(0);
    const paused = !!s.consent.paused;
    next.open();
    await within(turn);
    check('the person\'s input: a POKE from the book stored at once on the stub (a program running) pauses Claude', /^Done:/.test(msg) && paused, JSON.stringify({ msg, paused }));
    s.endChat();
  }
  {
    // not acting (no turn, or a turn that only thinks): the person's input is just theirs, nothing pauses
    const { s, chat, replies } = askSession();
    const idle = s.personInput() || s.typeText('A') === 0 || !!s.consent.paused;
    const think = { gate: true, body: textReply('hi') };
    replies.push(think);
    const turn = chat.sendLine('hello');
    await until(() => !!think.open);
    const thinking = s.personInput();
    think.open();
    await within(turn);
    check('the person\'s input: with no turn, or a turn that only thinks, the person\'s input pauses nothing', !idle && thinking === false && !s.consent.paused, JSON.stringify({ idle, thinking }));
    s.endChat();
  }
  // the ticket is taken when the program asks (the page does it as the event comes): a start it asks for after
  // Claude began acting meanwhile (the key came while Claude only thought: the person's), or after a pause and
  // Resume meanwhile (the person pressed a key), stops Claude
  for (const how of ['the key came while Claude only thought', 'a pause and Resume came between']) {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const m = s.shownMachine;
    const think = { gate: true, body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) };
    replies.push(think, { gate: true, body: textReply('x') });
    const turn = chat.sendLine('poke');
    await until(() => !!think.open);
    let ticket = null, job = null;
    if (how.startsWith('the key')) {
      ticket = s.machineTicket();                       // Claude only thinking: not acting
      think.open();
      await until(() => m.ram[0x3000] === 7 && s.claudeBusyActing);
    } else {
      think.open();
      await until(() => m.ram[0x3000] === 7 && s.claudeBusyActing);
      job = s.typeTextPaced('10 PRINT 1\n', m);
      ticket = s.machineTicket();                       // acting, not paused: Claude's, so far
      s.pauseClaude(); s.resumeClaude();               // the person pressed a key, then Resume
    }
    s.asMachine(() => s.runLiza(ex(s.lizaFile)), ticket);
    const r = await within(turn);
    check(`a start the machine asked for stops Claude when ${how}`, ticket && r !== 'timeout' && chat.error && chat.error.code === 'aborted' && !s.claudeBusyActing,
      JSON.stringify({ ticket: ticket && ticket.claude, err: chat.error && chat.error.code }));
    s.endChat();
  }
  // LIZA's BYE asks for the menu at once; the menu comes LIZA_BYE_SECONDS later. Whose keys asked is decided at the
  // BYE (Session.menuTicket): the person's BYE (while Claude was paused, or only thought) stops Claude when the menu
  // starts, even after a Resume or Claude's first action during the goodbye
  for (const how of ['paused, then Resume during the goodbye', 'Claude only thought, then acted during the goodbye']) {
    const fs = require('fs'), ex = (n) => fs.readFileSync(require('path').join(__dirname, '..', 'examples', n));
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    s.runLiza(ex(s.lizaFile));
    for (let i = 0; i < 200; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const m = s.shownMachine;
    let menu = false;
    const off = s.on((ev, arg) => {
      if (ev === 'menu' && arg !== 'back') { menu = true; s.asMachine(() => s.startWelcome(ex(s.welcomeFile), { greeting: 'bye' }), s.menuTicket); }
    });
    const think = { gate: true, body: toolReply([{ name: 'poke', input: { address: 0x0400, bytes: [0x41] } }]) };
    const next = { gate: true, body: toolReply([{ name: 'type_text', input: { text: 'ZZZ' } }]) };
    const thinking = how.startsWith('Claude only');
    replies.push(...(thinking ? [think, next, { body: textReply('ok') }] : [{ body: toolReply([{ name: 'poke', input: { address: 0x0400, bytes: [0x41] } }]) }, next, { body: textReply('ok') }]));
    const turn = chat.sendLine('do something');
    if (thinking) {
      await until(() => !!think.open);
      s.typeText('BYE\n');
      for (let i = 0; i < 20; i++) s.advance(1000 / m.fps + 0.01);
      think.open();
      await until(() => !!next.open && s.claudeBusyActing);
    } else {
      await until(() => !!next.open && s.claudeBusyActing);
      s.pauseClaude();
      s.typeText('BYE\n');
      for (let i = 0; i < 20; i++) s.advance(1000 / m.fps + 0.01);
      s.resumeClaude();
    }
    for (let i = 0; i < 400 && !menu; i++) s.advance(1000 / m.fps + 0.01);
    if (next.open) next.open();
    const r = await within(turn);
    check(`the menu after the person's BYE in LIZA stops Claude (${how})`, menu && r !== 'timeout' && chat.error && chat.error.code === 'aborted',
      JSON.stringify({ menu, err: chat.error && chat.error.code, ticket: s.menuTicket && s.menuTicket.claude }));
    off();
    s.endChat();
  }
  {
    // a key while a card waits (Claude acted this turn, its next action asks) is the person's: the ticket says so
    const { s, chat, replies } = askSession();
    s.consent.asker = () => {};
    s.consent.setAllowed(true);
    const second = { gate: true, body: toolReply([{ name: 'poke', input: { address: 0x3001, bytes: [2] } }]) };
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [1] } }]) }, second, { body: textReply('Done.') });
    const turn = chat.sendLine('poke twice');
    await until(() => !!second.open);
    s.consent.setAllowed(false);
    second.open();
    await until(() => !!s.consent.pending);
    const t = s.machineTicket();
    s.consent.answer(false);
    await within(turn);
    check('a ticket taken while a card waits is not Claude\'s (a key then is the person\'s)', s.claudeBusyActing === false && t.claude === false, JSON.stringify({ claude: t.claude }));
    s.endChat();
  }
  {
    // asMachine is synchronous: it refuses async work (whose awaits would let the person's actions through
    // unstopped), and the flag never outlives it, nested or thrown
    const { s } = askSession();
    let refused = false;
    try { s.asMachine(async () => {}); } catch (e) { refused = /synchronous/.test(e.message); }
    let inner = null;
    s.asMachine(() => { s.asMachine(() => { inner = s.machineDriven; }, { claude: true }); }, null);
    try { s.asMachine(() => { throw new Error('x'); }); } catch (e) { /* expected */ }
    check('asMachine refuses async work, and its ticket is set only inside it (nested, thrown)', refused && inner && inner.claude === true && s.machineDriven === null);
    s.endChat();
  }
  {
    // the full-screen chat: a Reset of the chat machine on screen (its chat view) leaves Claude's work on the BASIC
    // session alone; a Reset with the BASIC session on screen stops it
    const fs = require('fs');
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    s.startChat({ backend: chat.backend, channel: new Emu.MemoryChannel(), firmware: fs.readFileSync(require('path').join(__dirname, '..', 'examples', 'chat.bin')) });
    const basic = s.chatMachines.basic;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, { gate: true, body: textReply('x') });
    let job = null;
    const off = s.on(() => { if (!job && basic.ram[0x3000] === 7 && s.claudeActing) job = s.typeTextPaced('10 PRINT 1\n20 PRINT 2\n', basic); });
    const turn = chat.sendLine('poke');
    await until(() => !!job && basic.typist.queue.length > 0);
    const onChat = s.shownMachine === s.chatMachines.chat;
    s.reset();
    const kept = { busy: chat.busy, q: basic.typist.queue.length, err: chat.error };
    // (the BASIC session restarting while the chat is on screen: its own onReset, not this.machine's)
    basic.reset(false);
    const r = await within(turn);
    check('full-screen chat: Reset of the chat machine leaves Claude typing in the BASIC session; a restart of the BASIC session (chat on screen) stops it',
      onChat && kept.busy && kept.q > 0 && !kept.err && r !== 'timeout' && chat.error && chat.error.code === 'aborted' && basic.typist.queue.length === 0,
      JSON.stringify({ onChat, kept: { busy: kept.busy, q: kept.q }, err: chat.error && chat.error.code }));
    off();
    s.endChat();
  }
  {
    // the same for a Reset while Claude acts unpaused (its typing still going in): Claude stops, nothing more is typed
    const { s, chat, replies } = askSession();
    s.consent.setAllowed(true);
    const m = s.shownMachine;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, { gate: true, body: textReply('x') });
    let job = null;
    const off = s.on(() => { if (!job && m.ram[0x3000] === 7 && s.claudeActing) job = s.typeTextPaced('10 PRINT 1\n20 PRINT 2\n', m); });
    const turn = chat.sendLine('poke');
    await until(() => !!job && m.typist.queue.length > 0);
    s.reset();
    const r = await within(turn);
    for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    check('Reset while Claude acts (not paused) stops Claude: the turn ends stopped and its typing is dropped',
      r !== 'timeout' && chat.error && chat.error.code === 'aborted' && m.typist.queue.length === 0 && !s.claudeBusyActing && job.status === 'stopped',
      JSON.stringify({ err: chat.error && chat.error.code, q: m.typist.queue.length, job: job && job.status }));
    off();
    s.endChat();
  }
  {
    // a Reset with no turn in progress and nothing acting leaves the conversation alone (no note)
    const { s, chat } = askSession();
    const notes = [];
    s.on((ev, arg) => { if (ev === 'claude-stopped') notes.push(arg); });
    s.reset(); s.powerCycle();
    check('Reset and power cycle with Claude idle stop nothing and add no note', s.chat === chat && !notes.length && !chat.error);
    s.endChat();
  }

  // ================= what the turn did on the machine ends with it =================
  // A turn that acted (a real poke through the gate), then ends: finished, stopped, failed, stalled. Afterwards
  // claudeActing is clear, and a later turn that only answers in text is not acting: a key does not pause it.
  for (const [how, ending, stall] of [['finishes', { body: textReply('Poked.') }], ['is stopped', { gate: true, body: textReply('late') }],
    ['fails', { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }], ['stalls', { chunks: [sse([start])], stall: true }, 80]]) {
    const { s, chat, replies, api } = askSession(stall ? { stallMs: stall } : {});
    s.consent.setAllowed(true);
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [0x42] } }]) }, ending);
    let acted = false;
    s.on(() => { if (s.claudeActing && s.claudeActing.name === 'poke') acted = true; });
    const turn = chat.sendLine('poke it');
    await until(() => s.shownMachine.ram[0x3000] === 0x42 && (!ending.gate || !!ending.open));
    if (ending.gate) s.stopClaude();
    const r = await within(turn, 3000);
    const cleared = s.claudeActing === null && !s.claudeBusyActing;
    // the next turn: text only, held open while a key is pressed
    const text = { gate: true, body: textReply('Just words.') };
    replies.push(text);
    const next = chat.sendLine('explain it');
    await until(() => !!text.open);
    const during = { busyActing: s.claudeBusyActing, paused: s.pauseClaude(), status: s.claudeStatus && s.claudeStatus.phase };
    text.open();
    const r2 = await within(next);
    check(`pause per turn: a turn that acted and ${how}: claudeActing ends with it, and a later text-only turn is not paused by a key (not acting, status Thinking…)`,
      acted && r !== 'timeout' && cleared && !during.busyActing && during.paused === false && s.consent.paused === null && during.status === 'thinking'
      && r2 !== 'timeout' && chat.messages.slice(-1)[0].content === 'Just words.' && !api.refused.length,
      JSON.stringify({ acted, cleared, during, err: chat.error && chat.error.code }));
    s.endChat();
  }

  finished = true;
  console.log(`\n${n - fail}/${n} turn scope checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL test crashed:', e && e.stack || e); finished = true; process.exitCode = 1; });

// The ticket a menu is STARTED with, by what asked for it (Session.menuTicketFor). The page's 'menu' handler used
// to apply one expression to every offer: `arg !== 'back' ? session.menuTicket || asked : null`. For 'none' -- the
// machine question's switch, always the person's own act -- that could take a ticket left over from an earlier LIZA
// BYE, so a person's click on a machine would start the menu as if Claude had asked. The rule is one place now.
{
  const { s } = askSession();
  const person = { claude: false };
  const claudes = { claude: true, pauses: 0 };
  s.menuTicket = claudes;
  const got = {
    none: s.menuTicketFor('none', person),        // the person chose a machine: no ticket, whatever an earlier BYE left
    back: s.menuTicketFor('back', person),        // a returning visit: none either
    program: s.menuTicketFor(null, person),       // a program asked (the demo's key, or a LIZA BYE: 'menu' with no arg)
    programNoBye: (() => { const was = s.menuTicket; s.menuTicket = null; const t = s.menuTicketFor(null, person); s.menuTicket = was; return t; })(),
  };
  check('menuTicketFor: a machine question takes no ticket, and a program\'s menu takes the BYE\'s (or the event\'s)',
    got.none === null && got.back === null && got.program === claudes && got.programNoBye && got.programNoBye.claude === false,
    JSON.stringify({ none: got.none, back: got.back, program: !!got.program, programNoBye: !!got.programNoBye }));
  // and with no BYE in play, a program's menu still takes the ticket taken at the event, never a stale one
  s.menuTicket = null;
  check('menuTicketFor: with no BYE on record, the menu takes the ticket taken at the event',
    s.menuTicketFor(null, person) && s.menuTicketFor(null, person).claude === person.claude,
    JSON.stringify(s.menuTicketFor(null, person)));
  // THE CALLER: the rule above is worth nothing if the page does not use it. js/ui/welcome.js's 'menu' handler is
  // its only caller, and the Session cannot test a caller, so the source is checked: that one line must route
  // through menuTicketFor, and no copy of the old one-expression rule may be left anywhere in the page.
  // (The live path through the page is checked in tools/browser-check.js by counting the start's ticket.)
  {
    const src = fs.readFileSync(path.join(__dirname, '../js/ui/welcome.js'), 'utf8');
    const line = src.split('\n').find((l) => /byMachine:\s*session\.menuTicketFor\(/.test(l));
    check('the page\'s menu handler takes its ticket from Session.menuTicketFor (its only caller)',
      !!line && /session\.menuTicketFor\(arg,\s*asked\)/.test(line),
      line ? line.trim() : 'no byMachine: session.menuTicketFor(arg, asked) line in js/ui/welcome.js');
    const oldStyle = /arg\s*!==\s*'back'\s*\?\s*session\.menuTicket/.test(src);
    check('the page keeps no copy of the old one-expression ticket rule',
      !oldStyle, oldStyle ? 'found the old expression in js/ui/welcome.js' : 'none found');
  }
}
