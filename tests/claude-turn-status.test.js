// Run: node tests/claude-turn-status.test.js
//
// A turn with Claude is never silent and never endless (the 0.1.1-pre report: "yes" sent in the side panel, then
// nothing while Claude streamed a long load_basic call):
//  * Session.claudeStatus says what the turn in progress is doing, for the status every view shows with Stop:
//    Thinking… while the reply comes (the request out, the stream running), Waiting for your OK while a card asks,
//    Using <tool>… while a tool runs, nothing once the turn has ended;
//  * Stop at a card or while a tool runs ends the turn without another request;
//  * a stream that goes quiet for the stall limit ends the turn as 'stalled' (the request aborted), one that keeps
//    sending does not, and Stop before the limit is a stop, not a stall; a response that never comes stalls too;
//  * an SSE error event, an HTTP error, a network error and an exception in the tool loop each end the turn with
//    a message, and the next line is answered;
//  * the API key is in no log line and no message.
// The backend is the real ClaudeBackend; fetch is mocked with streams this test controls (never the real API).
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const KEY = 'sk-ant-TURN-STATUS-KEY-0123456789';
// every log line the code under test writes, to show the key is in none of them
const logged = [];
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const f = console[k].bind(console);
  console[k] = (...a) => { const l = a.map(String).join(' '); if (!/^(ok |FAIL )/.test(l)) logged.push(l); f(...a); };
}

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
const textReply = (text) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
const toolReply = (uses) => sse([start, ...uses.flatMap((u, i) => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input || {}) } },
  { type: 'content_block_stop', index: i }]),
{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
// a turn that never ends leaves nothing for Node to wait on, and Node would exit quietly with code 0: a run that does
// not reach its summary fails
let finished = false;
process.on('exit', () => { if (!finished) { console.log('FAIL the test did not finish (a turn never ended)'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return !!fn(); };

// A fetch whose replies the test scripts: { body } at once, { chunks, gapMs } a piece at a time, { stall } left open
// after its chunks, { never } no response at all, { status, json } an HTTP error, { network } a failed connection,
// { gate } held until gate() is called. Like the browser's fetch, an abort ends the request (AbortError) - unless
// { deaf } is set, a fetch that ignores its signal, which the backend must still get out of.
function scripted(replies) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init, signal: init.signal });
    const r = replies.shift() || { body: textReply('ok') };
    const signal = r.deaf ? null : init.signal;
    const abortErr = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    return new Promise((resolve, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(abortErr()), { once: true });
      if (r.network) { reject(new TypeError('fetch failed')); return; }
      if (r.status) { resolve(new Response(JSON.stringify(r.json || {}), { status: r.status })); return; }
      if (r.never) return;
      let ctl;
      const body = new ReadableStream({ start(c) { ctl = c; } });
      if (signal) signal.addEventListener('abort', () => { try { ctl.error(abortErr()); } catch (e) { /* closed */ } }, { once: true });
      (async () => {
        if (r.gate) await new Promise((go) => { r.open = go; });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        for (const c of r.chunks || [r.body]) {
          if (signal && signal.aborted) return;
          try { ctl.enqueue(new TextEncoder().encode(c)); } catch (e) { return; }
          if (r.gapMs) await sleep(r.gapMs);
        }
        if (!r.stall) try { ctl.close(); } catch (e) { /* aborted */ }
      })();
    });
  };
  return { fetch, calls };
}

(async () => {
  // ---- the status, phase by phase, on an Ask Claude session ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    for (let i = 0; i < 20; i++) s.advance(1000 / s.machine.fps + 0.01);
    const replies = [];
    const { fetch, calls } = scripted(replies);
    const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }) });
    let asked = 0;
    s.claudeGate = () => { asked++; };
    check('no turn: no status', s.claudeStatus === null);
    // Thinking… while the request is out and while its stream runs
    const first = { gate: true, chunks: [textReply('Hello there.')] };
    replies.push(first);
    let turn = chat.sendLine('hi');
    await until(() => calls.length === 1);
    const out = s.claudeStatus;
    first.open();
    await turn;
    check('the request out: Thinking…', out && out.phase === 'thinking' && out.text === 'Thinking…', JSON.stringify(out));
    check('the turn over: no status', s.claudeStatus === null && chat.messages.slice(-1)[0].content === 'Hello there.');
    // a card: Waiting for your OK (poke with the switch off asks first); Stop there ends the turn, no more requests
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [1] } }]) }, { body: textReply('should not be asked') });
    turn = chat.sendLine('poke it');
    await until(() => !!s.claudePending);
    const waiting = s.claudeStatus;
    check('a card up: Waiting for your OK', asked === 1 && waiting && waiting.phase === 'consent' && waiting.text === 'Waiting for your OK' && waiting.tool === 'poke', JSON.stringify(waiting));
    s.stopClaude();
    await turn;
    check('Stop at the card: the turn ends stopped, no further request, no status', calls.length === 2 && chat.error && chat.error.code === 'aborted' && s.claudeStatus === null && !chat.busy,
      `${calls.length} ${chat.error && chat.error.code}`);
    replies.length = 0;
    // two acting calls in one reply: Stop at the first card ends the turn; the second is neither asked nor run
    replies.length = 0;
    asked = 0;
    replies.push({ body: toolReply([{ name: 'poke', input: { address: 0x3000, bytes: [1] } }, { name: 'poke', input: { address: 0x3001, bytes: [2] } }]) }, { body: textReply('should not be asked') });
    const ram = [s.machine.ram[0x3000], s.machine.ram[0x3001]];
    let callsBefore = calls.length;
    turn = chat.sendLine('poke both');
    await until(() => !!s.claudePending);
    s.stopClaude();
    await turn;
    await sleep(20);
    check('two calls in one reply, Stop at the first card: the second is not asked, nothing is written, no further request',
      asked === 1 && !s.claudePending && !chat.busy && s.claudeStatus === null && calls.length === callsBefore + 1
      && s.machine.ram[0x3000] === ram[0] && s.machine.ram[0x3001] === ram[1], `asked ${asked}, calls ${calls.length - callsBefore}`);
    // with the switch on, Stop while the first runs: the second does not run
    s.setClaudeAllowed(true);
    replies.length = 0;
    replies.push({ body: toolReply([{ name: 'machine_info' }, { name: 'poke', input: { address: 0x3001, bytes: [2] } }]) }, { body: textReply('should not be asked') });
    let hold;
    const inner0 = chat.runTool.bind(chat);
    const ran = [];
    chat.runTool = async (name, input) => { ran.push(name); if (name === 'machine_info') await new Promise((r) => { hold = r; }); return inner0(name, input); };
    callsBefore = calls.length;
    turn = chat.sendLine('look, then poke');
    await until(() => !!hold);
    s.stopClaude();
    hold();
    await turn;
    chat.runTool = inner0;
    s.setClaudeAllowed(false);
    check('switch on, Stop during the first call: the second call of the reply does not run', ran.join() === 'machine_info' && s.machine.ram[0x3001] === ram[1]
      && calls.length === callsBefore + 1 && chat.error && chat.error.code === 'aborted', ran.join());
    // a tool running: Using <tool>… (a read-only tool held by the test)
    let release;
    const inner = chat.runTool.bind(chat);
    chat.runTool = async (name, input) => { if (name === 'machine_info') await new Promise((r) => { release = r; }); return inner(name, input); };
    replies.length = 0;
    replies.push({ body: toolReply([{ name: 'machine_info' }]) }, { body: textReply('A Dragon 64.') });
    turn = chat.sendLine('what machine?');
    await until(() => !!release);
    const using = s.claudeStatus;
    release();
    await turn;
    chat.runTool = inner;
    check('a tool running: Using machine_info…', using && using.phase === 'tool' && using.text === 'Using machine_info…', JSON.stringify(using));
    check('after the tool, the turn ends with the reply and no status', s.claudeStatus === null && s.claudeTool === null && chat.messages.slice(-1)[0].content === 'A Dragon 64.');
    // Stop while a tool runs: the turn ends without asking again
    replies.push({ body: toolReply([{ name: 'machine_info' }]) }, { body: textReply('should not be asked') });
    release = null;
    chat.runTool = async (name, input) => { if (name === 'machine_info') await new Promise((r) => { release = r; }); return inner(name, input); };
    const before = calls.length;
    turn = chat.sendLine('again?');
    await until(() => !!release);
    s.stopClaude();
    release();
    await turn;
    chat.runTool = inner;
    check('Stop while a tool runs: the turn ends stopped, without another request', calls.length === before + 1 && chat.error && chat.error.code === 'aborted' && s.claudeStatus === null);
    // an exception in the tool loop (the page's handler throws): the turn ends with its message; the next line works
    replies.length = 0;
    replies.push({ body: toolReply([{ name: 'machine_info' }]) });
    const handler = chat.onToolUse;
    chat.onToolUse = () => { throw new Error('the tool loop broke'); };
    const kept = JSON.stringify(chat.messages);
    const res = await chat.sendLine('break it');
    chat.onToolUse = handler;
    // (no tool result reached the conversation, so the history is as it was: the line is not kept)
    check('an exception in the tool loop ends the turn with its message, and the line is not kept', res === null && chat.error && /the tool loop broke/.test(chat.error.message)
      && !chat.busy && s.claudeStatus === null && s.claudeTool === null && JSON.stringify(chat.messages) === kept);
    replies.push({ body: textReply('Back.') });
    await chat.sendLine('hello?');
    check('then the next line is answered', chat.messages.slice(-1)[0].content === 'Back.' && !chat.error);
    s.endChat();
  }

  // ---- the stall limit ----
  {
    const run = async (r, stallMs, onStart) => {
      const replies = [r];
      const { fetch, calls } = scripted(replies);
      const b = new Emu.ClaudeBackend({ fetch, apiKey: KEY, stallMs });
      const ctl = new AbortController();
      const t = Date.now();
      const p = b.send({ system: 'S', messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal });
      if (onStart) onStart(ctl);
      try { const out = await p; return { out, ms: Date.now() - t, calls }; } catch (e) { return { err: e, ms: Date.now() - t, calls }; }
    };
    check('the limit is 60 s unless set', Emu.STALL_MS === 60000 && new Emu.ClaudeBackend({ fetch: () => null }).stallMs === 60000);
    let r = await run({ stall: true, chunks: [sse([start])] }, 80);
    check('a stream that goes quiet ends as stalled, with a message saying so, and the request is aborted', r.err && r.err.code === 'stalled' && /stopped answering/.test(r.err.message)
      && r.calls[0].signal.aborted && r.ms >= 80, `${r.err && r.err.code} ${r.ms} ms`);
    r = await run({ never: true }, 80);
    check('a response that never comes stalls too', r.err && r.err.code === 'stalled' && r.calls[0].signal.aborted, `${r.err && r.err.code}`);
    r = await run({ stall: true, deaf: true, chunks: [sse([start])] }, 80);
    check('a fetch that ignores its abort signal still stalls out', r.err && r.err.code === 'stalled', `${r.err && r.err.code}`);
    // pieces 20 ms apart for ~400 ms against a 250 ms limit: the timer starts again with every piece
    const words = Array.from({ length: 20 }, (_, i) => `w${i} `);
    const pieces = [sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]),
      ...words.map((w) => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }])),
      sse([{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }])];
    r = await run({ gapMs: 20, chunks: pieces }, 250);
    check('a slow stream that keeps sending is not a stall', r.out && r.out.text === words.join('') && r.ms > 250, r.err ? r.err.message : `${r.ms} ms`);
    r = await run({ stall: true, chunks: [sse([start])] }, 5000, (ctl) => setTimeout(() => ctl.abort(), 30));
    check('Stop before the limit is a stop, not a stall', r.err && r.err.code === 'aborted' && r.ms < 1000, `${r.err && r.err.code} ${r.ms} ms`);
    // Stop while an HTTP error's body is still coming: a stop, not a raw error
    {
      const ctl = new AbortController();
      const b = new Emu.ClaudeBackend({ apiKey: KEY, stallMs: 5000, fetch: async () => ({ ok: false, status: 500, json: () => new Promise(() => {}) }) });
      const p = b.send({ system: 'S', messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal });
      setTimeout(() => ctl.abort(), 20);
      let e = null; try { await p; } catch (x) { e = x; }
      check('Stop while an HTTP error body is read: aborted', e && e.code === 'aborted', e && `${e.code} ${e.message}`);
    }
    // the backend alone (no Session gate): Stop during the first of two tool calls in one reply, the second never runs
    {
      const ctl = new AbortController();
      const ran = [];
      const { fetch, calls } = scripted([{ body: toolReply([{ name: 'a' }, { name: 'b' }]) }, { body: textReply('no') }]);
      const b = new Emu.ClaudeBackend({ fetch, apiKey: KEY, runTool: async (name) => { ran.push(name); if (name === 'a') ctl.abort(); return 'done'; } });
      let e = null; try { await b.send({ system: 'S', messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal }); } catch (x) { e = x; }
      check('backend: Stop during one tool call of a reply: the next is not run and no request follows', ran.join() === 'a' && calls.length === 1 && e && e.code === 'aborted', `${ran.join()} ${calls.length}`);
    }
    // an error event inside the stream reads as the error it stands for
    r = await run({ chunks: [sse([start, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] }, 5000);
    check('an SSE overloaded_error: server-error, "overloaded right now"', r.err && r.err.code === 'server-error' && /overloaded right now/.test(r.err.message), r.err && r.err.message);
    r = await run({ chunks: [sse([start, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }])] }, 5000);
    check('an SSE rate_limit_error: rate-limited', r.err && r.err.code === 'rate-limited', r.err && r.err.code);
  }

  // ---- the failures end a turn in a chat, with a message, and the next line is answered ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    const replies = [];
    const { fetch, calls: sentCalls } = scripted(replies);
    const backend = new Emu.ClaudeBackend({ fetch, apiKey: KEY, stallMs: 80 });
    const chat = s.startAsk({ backend });
    const cases = [
      ['HTTP 529', { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, 'server-error'],
      ['a network error', { network: true }, 'network'],
      ['an SSE error event', { chunks: [sse([start, { type: 'error', error: { type: 'api_error', message: 'Internal' } }])] }, 'server-error'],
      ['a stall', { stall: true, chunks: [sse([start])] }, 'stalled'],
    ];
    const messages = [];
    for (const [what, r, code] of cases) {
      replies.push(r);
      const res = await chat.sendLine(`try ${what}`);
      messages.push(chat.error && chat.error.message);
      check(`${what}: the turn ends (${code}) with a message, no status, and the line is not kept`, res === null && chat.error && chat.error.code === code && !!chat.error.message
        && !chat.busy && s.claudeStatus === null && !chat.messages.some((m) => m.content === `try ${what}`), `${chat.error && chat.error.code}: ${chat.error && chat.error.message}`);
      replies.push({ body: textReply(`fine after ${what}`) });
      await chat.sendLine('again');
      check(`${what}: then the next line is answered`, chat.messages.slice(-1)[0].content === `fine after ${what}`);
    }
    check('the key is in none of the messages', messages.every((m) => !m.includes(KEY)));
    // where the key does go: the x-api-key header of each request, and nowhere else in what is sent
    const sent = sentCalls;
    check('the key goes only in the x-api-key header: not in any request body, nor in any other header', sent.length > 4
      && sent.every((c) => c.init.headers['x-api-key'] === KEY && !c.init.body.includes(KEY) && !c.url.includes(KEY)
        && Object.entries(c.init.headers).every(([h, v]) => h === 'x-api-key' || !String(v).includes(KEY))), `${sent.length} requests`);
    s.endChat();
  }

  // a guard rather than a proof: the code under test logs nothing on these paths today; a log line added later that
  // carried the key would fail here
  check('the key is in no log line the code wrote', !logged.some((l) => l.includes(KEY)), `${logged.length} lines`);
  finished = true;
  console.log(`\n${n - fail}/${n} turn status checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
