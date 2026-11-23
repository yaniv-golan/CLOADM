// Run: node tests/claude-acting-contract.test.js
//
// The acting tools' contract (AGENTS.md 4.6, Claude chat terminal: no MAME oracle; mocked fetch only, never the
// real API). Browser-free, no network, no ROMs: BASIC is our own idle firmware in the BASIC socket, with BASIC's
// pointers and the OK prompt set up by the test (as tests/basic-load.test.js does).
//
// What is proved:
//  * every acting tool x every outcome (success and each error code it can return), through the real backend with
//    a mocked fetch: the exact tool_result the model receives - JSON, is_error, the code, its remedy - and that the
//    codes each description names are exactly the codes this table produces for that tool (both ways);
//  * schemas against the code: every range, length and default in the schemas is the constant the code applies,
//    and the code enforces it at the boundary (the value at the limit passes the check, one past it is refused);
//  * the gate: every acting tool (iterated from the schemas, so a tool added later is covered) passes the consent
//    gate before anything, then the restore point (withRestorePoint) before its first change; a refusing gate
//    changes nothing; the Session's chats use the Session's gate, and a ChatSession without one refuses (no-consent);
//  * the pre-act re-check: Claude paused during an INCLUDE read or while a card waits (then answered yes) changes
//    nothing until Resume (Stop, Esc: stopped); the switch turned off during the check is no-consent for a call that
//    relied on it, while a call allowed on its own card goes on;
//  * no raw exception escapes: anything uncoded inside a tool is tool-failed, from runTool itself and through the
//    backend; Stop while a consent card is up is stopped (not consent-declined).
const Emu = require('./load')();
const C = Emu.TOOL_CODES;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const KEY = 'sk-ant-CONTRACT-TEST-KEY-0123456789';

// a ROM-less machine (the stub reads typed keys) and a machine with "BASIC" (our idle firmware) at its OK prompt.
// The idle firmware never reads the keyboard; with scan: true it reads it without end (PIA0 port B drives every
// column low, port A is read: every column is scanned on every read), as a program waiting for a key does.
const stub = () => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64'); frames(s, 40); return s; };
const START = 0x1E01, FRETOP = 0x7E00, P = 0x19;   // the Dragon's TXTTAB.. pointers at $19 [ITD App.8]
const SCAN = ' CLR $FF03\n LDA #$FF\n STA $FF02\n LDA #$04\n STA $FF03\n CLR $FF02\n CLR $FF01\n CLR $FF00\n LDA #$04\n STA $FF01\nIDLE LDA $FF00\n BRA IDLE\n';
function basic({ ok = true, scan = false } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64');
  const m = s.shownMachine;
  const asm = Emu.assemble(` ORG $8000\nSTART STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\n${scan ? SCAN : 'IDLE BRA IDLE\n'}`, '6809');
  const rom = new Uint8Array(0x4000).fill(0xFF); rom.set(asm.segments[0].data, 0);
  m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
  const w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  s.pokeBytes(START - 1, [0, 0, 0], m);
  w(P, START); w(P + 2, START + 2); w(P + 4, START + 2); w(P + 6, START + 2); w(P + 8, FRETOP);
  for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;
  if (ok) { m.ram[0x400 + 64] = 0x0F; m.ram[0x400 + 65] = 0x0B; }   // "OK"
  frames(s, 3);
  return s;
}
const scanning = () => basic({ scan: true });

// The model's side: a scripted API. Request 1 answers with one tool_use, request 2 ends the turn; what request 2
// sends back is the tool_result the model receives. The mock never looks at the abort signal, so a turn the person
// stopped still shows what would have been sent.
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const msgStart = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } };
const toolTurn = (name, input) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
const endTurn = sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);

// One tool call as the model makes it -> { isError, json } (what the model receives). `setup(s, chat)` arranges
// the outcome (consent, a stubbed target method). With `run` the machine runs frames while the call is in flight
// (typing waits for the machine to read its keys); otherwise it stands still, so a refusal can be shown to change
// nothing at all.
async function modelCall(s, name, input, setup = null, run = false) {
  const sent = [];
  const bodies = [toolTurn(name, input), endTurn];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(bodies[sent.length - 1], { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  s.setClaudeKey(KEY);
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }) });
  if (setup) await setup(s, chat);
  // what the backend hands the model for the call (onToolUse's text is exactly the tool_result's content): a turn the
  // person stopped sends no further request (js/claude/backend.js), so that is where a stopped call's result is read
  let seen = null;
  const emit = chat.emitTool.bind(chat);
  chat.emitTool = (n, i, text, isError, v) => { seen = { content: text, is_error: isError }; emit(n, i, text, isError, v); };
  let done = false;
  const p = chat.sendLine('go').then(() => { done = true; });
  for (let i = 0; i < 2000 && !done; i++) { if (run) frames(s, 1); await new Promise((r) => setImmediate(r)); }
  if (!done) return { isError: null, json: null, raw: 'the call did not settle', chat };
  await p;
  const res = sent[1] ? sent[1].messages.slice(-1)[0].content[0] : chat.error && chat.error.code === 'aborted' ? seen : null;
  if (!res) return { isError: null, json: null, raw: 'no tool_result was sent', chat };
  let json = null; try { json = JSON.parse(res.content); } catch (e) { /* not JSON: the check below fails */ }
  return { isError: res.is_error === true, json, raw: res.content, chat };
}

// arrangements
const allow = (s) => { s.consent.setAllowed(true); };
const say = (answer) => (s) => { s.consent.asker = () => { Promise.resolve().then(() => answer(s)); }; };
const decline = say((s) => s.consent.answer(false));
const loadYes = say((s) => s.consent.answer(true));
const stopOnCard = say((s) => s.stopClaude());
const nobody = (s) => { s.consent.asker = null; };
// a key the person pressed has paused Claude; Stop while the action waits
// (the person presses Stop as soon as the action is waiting: when its wake-up is queued)
const pausedThenStop = (s) => {
  s.consent.setAllowed(true);
  const wake = [];
  wake.push = function (f) { Array.prototype.push.call(this, f); Promise.resolve().then(() => s.stopClaude()); return this.length; };
  s.consent.paused = { held: { queue: [], stub: [] }, wake };
};
const raw = (method) => (s, chat) => { s.consent.setAllowed(true); chat.target[method] = () => { throw new Error('boom inside the emulator'); }; };
// type_text's job, as the typist would end it
const job = (status, extra = {}) => (s, chat) => {
  s.consent.setAllowed(true);
  chat.target.typeText = (text) => Object.assign({ promise: Promise.resolve(), status, requested: text.length, consumed: 0, linesRequested: 0, linesDelivered: 0, end() {} }, extra);
};
// a keyboard job the machine's reset ended part-way (Machine.reset clears the typist with 'machine-restarted'), from
// the target method that starts it
const restarted = (method) => (s, chat) => {
  s.consent.setAllowed(true);
  chat.target[method] = () => ({ promise: Promise.resolve(), status: 'machine-restarted', key: method === 'pressBreak' ? 'BREAK' : undefined, requested: 4, consumed: 1, linesRequested: 1, linesDelivered: 0, end() {} });
};
// the Debugger has the machine stopped: the tools that must run it or press its keys refuse. The stop is
// made with the machine (it is part of the machine's state the refusal must leave as it was)
const stopped = (make) => () => { const s = make(); s.debug.halt(); return s; };
const big = (k) => 'x'.repeat(k);
const longProgram = Array.from({ length: 250 }, (_, i) => `${i + 1} REM ${'X'.repeat(230)}`).join('\n');   // ~60000 characters, over 24K of program

// tool -> outcomes: [label, machine, input, setup, expected code | success check]
const OK = (want) => ({ ok: want });
const OUTCOMES = {
  poke: [
    ['writes RAM', stub, { address: 0x3000, bytes: [9, 8] }, allow, OK((j) => JSON.stringify(j) === '{"address":12288,"length":2,"written":2,"skipped":0,"not_taken":[]}')],
    ['address out of range', stub, { address: 70000, bytes: [1] }, allow, C.BAD_ADDRESS],
    ['address as text', stub, { address: '$3000', bytes: [1] }, allow, C.NOT_A_NUMBER],
    ['no bytes', stub, { address: 0x3000, bytes: [] }, allow, C.EMPTY],
    ['a byte over 255', stub, { address: 0x3000, bytes: [256] }, allow, C.BAD_BYTE],
    ['too many bytes', stub, { address: 0x3000, bytes: new Array(Emu.POKE_MAX + 1).fill(1) }, allow, C.TOO_LARGE],
    ['past $FFFF', stub, { address: 0xFFFF, bytes: [1, 2] }, allow, C.PAST_END],
    ['ROM only', stub, { address: 0xFFF0, bytes: [1] }, allow, C.NOT_RAM],
    ['nobody to ask', stub, { address: 0x3000, bytes: [1] }, nobody, C.NO_CONSENT],
    ['"Just tell me the fix"', stub, { address: 0x3000, bytes: [1] }, decline, C.CONSENT_DECLINED],
    ['Stop while paused', stub, { address: 0x3000, bytes: [1] }, pausedThenStop, C.STOPPED],
    ['an uncoded failure inside', stub, { address: 0x3000, bytes: [1] }, raw('pokeBytes'), C.TOOL_FAILED],
  ],
  type_text: [
    ['types', stub, { text: 'PRINT 1\n' }, allow, OK((j) => JSON.stringify(j) === '{"requested":8,"consumed":8,"lines_requested":1,"lines_delivered":1}')],
    ['empty', stub, { text: '' }, allow, C.EMPTY],
    ['too long', stub, { text: big(Emu.TYPE_TEXT_MAX + 1) }, allow, C.TOO_LARGE],
    ['no key for it', stub, { text: 'café' }, allow, C.NOT_TYPABLE],
    ['the machine stops reading', stub, { text: 'AB' }, job('timeout', { at: { phase: 'press', index: 0, char: 'A' } }), C.NOT_CONSUMED],
    ['Stop while typing', stub, { text: 'AB' }, job('stopped'), C.STOPPED],
    ['the machine restarts while typing', stub, { text: 'AB' }, restarted('typeText'), C.MACHINE_RESTARTED],
    ['Stop on the consent card', stub, { text: 'AB' }, stopOnCard, C.STOPPED],
    ['nobody to ask', stub, { text: 'AB' }, nobody, C.NO_CONSENT],
    ['"Just tell me the fix"', stub, { text: 'AB' }, decline, C.CONSENT_DECLINED],
    ['an uncoded failure inside', stub, { text: 'AB' }, raw('typeText'), C.TOOL_FAILED],
    ['the Debugger has the machine stopped', stopped(stub), { text: 'AB' }, allow, C.MACHINE_STOPPED],
  ],
  load_basic: [
    ['loads', basic, { program: '10 PRINT "HI"\n20 GOTO 10' }, loadYes, OK((j) => JSON.stringify(Object.keys(j)) === '["lines","bytes","start","end"]' && j.lines === 2 && j.start === START && j.end === START + j.bytes - 1)],
    ['empty', basic, { program: '' }, loadYes, C.EMPTY],
    ['too long', basic, { program: big(Emu.BASIC_PROGRAM_TEXT_MAX + 1) }, loadYes, C.TOO_LARGE],
    ['no line number', basic, { program: 'PRINT 1' }, loadYes, C.BAD_LINE_NUMBER],
    ['a line too long', basic, { program: `10 REM ${'X'.repeat(260)}` }, loadYes, C.LINE_TOO_LONG],
    ['a character above $7E', basic, { program: '10 PRINT "É"' }, loadYes, C.NOT_TYPABLE],
    ['no BASIC ROMs', stub, { program: '10 END' }, loadYes, C.NO_BASIC],
    ['not at the prompt', () => basic({ ok: false }), { program: '10 END' }, loadYes, C.NOT_AT_PROMPT],
    ['does not fit', basic, { program: longProgram }, loadYes, C.PROGRAM_TOO_LARGE],
    ['pointers that describe no program', () => { const s = basic(); s.pokeBytes(P + 2, [0x30, 0x00], s.shownMachine); return s; }, { program: '10 END' }, loadYes, C.UNKNOWN_MACHINE],
    ['"Don\'t load"', basic, { program: '10 END' }, decline, C.LOAD_DECLINED],
    ['nobody to ask', basic, { program: '10 END' }, nobody, C.NO_CONSENT],
    ['Stop on its card', basic, { program: '10 END' }, stopOnCard, C.STOPPED],
    ['written but did not read back', basic, { program: '10 END' }, (s, chat) => {
      loadYes(s);
      const t = chat.target, poke = t.pokeBytes, read = t.readByte;
      let written = false;
      t.pokeBytes = (a, b) => { written = true; return poke(a, b); };
      t.readByte = (a) => (written ? 0 : read(a));
    }, C.NOT_RAM],
    ['an uncoded failure inside', basic, { program: '10 END' }, (s, chat) => { loadYes(s); chat.target.pokeBytes = () => { throw new Error('boom inside the emulator'); }; }, C.TOOL_FAILED],
  ],
  press_break: [
    ['read by a program scanning the keyboard', scanning, {}, allow, OK((j) => JSON.stringify(j) === '{"requested":1,"consumed":1}')],
    ['a program that never reads the keyboard', basic, {}, allow, C.NOT_CONSUMED],
    ['no ROMs: the stub reads no BREAK', stub, {}, allow, C.NOT_CONSUMED],
    ['the machine restarts while BREAK is held', stub, {}, restarted('pressBreak'), C.MACHINE_RESTARTED],
    ['nobody to ask', stub, {}, nobody, C.NO_CONSENT],
    ['"Just tell me the fix"', stub, {}, decline, C.CONSENT_DECLINED],
    ['Stop while paused', stub, {}, pausedThenStop, C.STOPPED],
    ['an uncoded failure inside', stub, {}, raw('pressBreak'), C.TOOL_FAILED],
    ['the Debugger has the machine stopped', stopped(stub), {}, allow, C.MACHINE_STOPPED],
  ],
  assemble_and_load: [
    ['assembles and writes', stub, { source: 'GO LDA #$41\n', org: 0x3000 }, allow,
      OK((j) => JSON.stringify(j) === '{"bytes":2,"written":2,"skipped":0,"ranges":[{"from":12288,"to":12289}],"start":12288,"symbols":{"GO":12288},"not_taken":[]}')],
    ['empty', stub, { source: '  ' }, allow, C.EMPTY],
    ['too long', stub, { source: big(Emu.SOURCE_MAX + 1) }, allow, C.TOO_LARGE],
    ['org out of range', stub, { source: ' NOP\n', org: 70000 }, allow, C.BAD_ADDRESS],
    ['org as text', stub, { source: ' NOP\n', org: '$3000' }, allow, C.NOT_A_NUMBER],
    ['bad source', stub, { source: ' LDQ #1\n', org: 0x3000 }, allow, C.ASSEMBLY_FAILED],
    ['org and ORG disagree', stub, { source: ' ORG $4000\n NOP\n', org: 0x3000 }, allow, C.ORG_CONFLICT],
    ['an INCLUDE that cannot be read', stub, { source: ' INCLUDE "x.inc"\n', org: 0x3000 },
      (s, chat) => { s.consent.setAllowed(true); chat.include = async () => { throw Object.assign(new Error('timed out'), { code: 'timeout' }); }; }, C.INCLUDE_UNREADABLE],
    ['past $FFFF', stub, { source: ' FCB 1,2\n', org: 0xFFFF }, allow, C.PAST_END],
    ['ROM only', stub, { source: ' FCB 1\n', org: 0xFFF0 }, allow, C.NOT_RAM],
    ['nobody to ask', stub, { source: ' NOP\n', org: 0x3000 }, nobody, C.NO_CONSENT],
    ['"Just tell me the fix"', stub, { source: ' NOP\n', org: 0x3000 }, decline, C.CONSENT_DECLINED],
    ['Stop while paused', stub, { source: ' NOP\n', org: 0x3000 }, pausedThenStop, C.STOPPED],
    ['an uncoded failure inside', stub, { source: ' NOP\n', org: 0x3000 }, raw('writeSegments'), C.TOOL_FAILED],
  ],
  run: [
    ['jumps', stub, { target: 0x3000 }, allow, OK((j) => JSON.stringify(j) === '{"how":"jump","target":12288}')],
    ['types RUN (the default), read by a program scanning the keyboard', scanning, {}, allow,
      OK((j) => JSON.stringify(j) === '{"how":"typed","target":"RUN","requested":4,"consumed":4,"lines_requested":1,"lines_delivered":1}')],
    ['RUN on a program that never reads the keyboard', basic, {}, allow, C.NOT_CONSUMED],
    ['the machine restarts while RUN is typed', basic, {}, restarted('run'), C.MACHINE_RESTARTED],
    ['not an address', stub, { target: 'banana' }, allow, C.BAD_TARGET],
    ['RUN without BASIC', stub, { target: 'RUN' }, allow, C.NO_BASIC],
    ['nobody to ask', stub, { target: 0x3000 }, nobody, C.NO_CONSENT],
    ['"Just tell me the fix"', stub, { target: 0x3000 }, decline, C.CONSENT_DECLINED],
    ['Stop while paused', stub, { target: 0x3000 }, pausedThenStop, C.STOPPED],
    ['an uncoded failure inside', stub, { target: 0x3000 }, raw('run'), C.TOOL_FAILED],
    ['a jump while the Debugger has the machine stopped', stopped(stub), { target: 0x3000 }, allow, C.MACHINE_STOPPED],
    ['RUN while the Debugger has the machine stopped', stopped(scanning), {}, allow, C.MACHINE_STOPPED],
  ],
};

// the codes a description names (whole words), from the shared table
const named = (text) => Object.keys(Emu.TOOL_ERRORS).filter((code) => new RegExp(`(^|[^a-z-])${code}([^a-z-]|$)`).test(text)).sort();

// a run that never reaches its summary (a call that never settles empties the event loop) must not pass
process.exitCode = 1;
(async () => {
  // ---- 1. every acting tool x every outcome, as the model receives it ----
  check('the outcome table covers exactly the acting tools', JSON.stringify(Object.keys(OUTCOMES).sort()) === JSON.stringify([...Emu.ACTING_TOOL_NAMES].sort()), Object.keys(OUTCOMES).join());
  for (const name of Emu.ACTING_TOOL_NAMES) {
    const seen = new Set();
    for (const [label, machine, input, setup, want] of OUTCOMES[name] || []) {
      const s = machine();
      const before = Emu.state.toJSON(s.shownMachine.snapshot());
      // the keyboard tools wait for the machine to read their keys, so the machine runs while they are in flight
      const r = await modelCall(s, name, input, setup, ['type_text', 'press_break', 'run'].includes(name) && (typeof want === 'object' || want === C.NOT_CONSUMED));
      if (typeof want === 'object') {
        check(`${name}: ${label}: a JSON result, not is_error`, r.isError === false && r.json && want.ok(r.json), r.raw);
        continue;
      }
      seen.add(want);
      const e = (r.json && r.json.error) || {};
      check(`${name}: ${label}: is_error, {"error":{code,remedy[,detail]}} with the code ${want} and its remedy`,
        r.isError === true && JSON.stringify(Object.keys(r.json || {})) === '["error"]' && e.code === want && e.remedy === Emu.TOOL_ERRORS[want]
        && Object.keys(e).every((k) => ['code', 'remedy', 'detail'].includes(k)) && (e.detail === undefined || typeof e.detail === 'string'), r.raw);
      // a refusal before the act changes nothing; tool-failed, not-consumed and stopped-while-typing are after it
      if (![C.TOOL_FAILED, C.NOT_CONSUMED, C.MACHINE_RESTARTED].includes(want) && !['Stop while typing', 'written but did not read back'].includes(label)) {
        check(`${name}: ${label}: nothing changed and no restore point`, Emu.state.toJSON(s.shownMachine.snapshot()) === before && r.chat.undo.length === 0, `${r.chat.undo.length} points`);
      }
    }
    const desc = Emu.actingTools().find((t) => t.name === name).description;
    check(`${name}: the codes its description names are exactly the codes it was shown to return`, JSON.stringify(named(desc)) === JSON.stringify([...seen].sort()),
      `description ${named(desc)} | returned ${[...seen].sort()}`);
  }
  // the Debugger has the machine stopped: the reads still work through the chat (and leave it stopped), and once the
  // person resumes it, typing works again
  {
    for (const [name, input] of [['screen_text', {}], ['peek', { address: 0x400, length: 4 }], ['machine_info', {}], ['disassemble', { address: 0x400, count: 2 }]]) {
      const s = stopped(stub)();   // (one chat per session: modelCall starts it)
      const r = await modelCall(s, name, input, allow);
      check(`stopped: ${name} reads the stopped machine through the chat, and leaves it stopped`, r.isError === false && s.paused, r.raw && r.raw.slice(0, 160));
    }
    // refused before the consent gate: the person is not shown a card for a call that cannot happen
    {
      const s = stopped(stub)();
      let asked = 0;
      const r = await modelCall(s, 'type_text', { text: 'A' }, (ss) => { ss.consent.asker = () => { asked++; Promise.resolve().then(() => ss.consent.answer(true)); }; });
      check('stopped: type_text is refused before anyone is asked (no consent card)', r.isError === true && r.json && r.json.error.code === C.MACHINE_STOPPED && asked === 0, `${asked} cards; ${r.raw}`);
    }
    const s = stopped(stub)();
    s.resume();
    const r = await modelCall(s, 'type_text', { text: 'A' }, allow, true);
    check('stopped: after Resume, type_text types again', r.isError === false && r.json && r.json.consumed === 1, r.raw);
    // the pre-act re-check: the Debugger stops the machine while the consent card waits, then the person allows it:
    // the call is refused there, synchronously with the change, and nothing is typed (O1)
    {
      const s2 = stub();
      const keys0 = s2.shownMachine.stubKeys.length;
      const r2 = await modelCall(s2, 'type_text', { text: 'AB' }, (ss) => { ss.consent.asker = () => { Promise.resolve().then(() => { ss.debug.halt(); ss.consent.answer(true); }); }; });
      check('stopped: halted while the consent card waits, then allowed: machine-stopped at the re-check, nothing typed or queued',
        r2.isError === true && r2.json && r2.json.error.code === C.MACHINE_STOPPED && s2.shownMachine.stubKeys.length === keys0 && s2.shownMachine.typist.queue.length === 0, r2.raw);
    }
    // load_basic writes memory only: it works on a stopped machine with BASIC (our stand-in BASIC fixture) and leaves
    // it stopped (O2)
    {
      const s3 = stopped(basic)();
      const r3 = await modelCall(s3, 'load_basic', { program: '10 PRINT "HI"\n20 GOTO 10' }, loadYes);
      check('stopped: load_basic loads into a stopped machine\'s BASIC and leaves it stopped', r3.isError === false && r3.json && r3.json.lines === 2 && s3.paused
        && s3.readByte(START + 2) === 0 && s3.readByte(START + 3) === 10, r3.raw);
    }
  }
  {
    const r = await modelCall(stub(), 'format_disk', {}, allow);
    check('an unknown tool is unknown-tool, coded', r.isError === true && r.json && r.json.error.code === C.UNKNOWN_TOOL && r.json.error.detail === 'format_disk', r.raw);
  }

  // ---- 2. schemas against the constants the code applies ----
  {
    const T = Object.fromEntries(Emu.actingTools().map((t) => [t.name, t]));
    const p = (tool, prop) => T[tool].input_schema.properties[prop];
    check('poke.address: integer, minimum/maximum = ADDRESS_MIN/ADDRESS_MAX', p('poke', 'address').type === 'integer' && p('poke', 'address').minimum === Emu.ADDRESS_MIN && p('poke', 'address').maximum === Emu.ADDRESS_MAX);
    check('poke.bytes: items BYTE_MIN-BYTE_MAX, minItems POKE_MIN, maxItems POKE_MAX', p('poke', 'bytes').items.minimum === Emu.BYTE_MIN && p('poke', 'bytes').items.maximum === Emu.BYTE_MAX
      && p('poke', 'bytes').minItems === Emu.POKE_MIN && p('poke', 'bytes').maxItems === Emu.POKE_MAX && p('poke', 'bytes').items.type === 'integer');
    check('type_text.text: 1 to TYPE_TEXT_MAX characters', p('type_text', 'text').minLength === 1 && p('type_text', 'text').maxLength === Emu.TYPE_TEXT_MAX);
    check('load_basic.program: 1 to BASIC_PROGRAM_TEXT_MAX characters', p('load_basic', 'program').minLength === 1 && p('load_basic', 'program').maxLength === Emu.BASIC_PROGRAM_TEXT_MAX);
    check('assemble_and_load.source: 1 to SOURCE_MAX characters; org ADDRESS_MIN-ADDRESS_MAX', p('assemble_and_load', 'source').minLength === 1 && p('assemble_and_load', 'source').maxLength === Emu.SOURCE_MAX
      && p('assemble_and_load', 'org').minimum === Emu.ADDRESS_MIN && p('assemble_and_load', 'org').maximum === Emu.ADDRESS_MAX && p('assemble_and_load', 'org').type === 'integer');
    check('run.target: anyOf an integer ADDRESS_MIN-ADDRESS_MAX or a string, nothing else', JSON.stringify(p('run', 'target').anyOf) === JSON.stringify([{ type: 'integer', minimum: Emu.ADDRESS_MIN, maximum: Emu.ADDRESS_MAX }, { type: 'string' }])
      && !('type' in p('run', 'target')) && !('minimum' in p('run', 'target')) && !('maximum' in p('run', 'target')), JSON.stringify(p('run', 'target')));
    check('required: poke address+bytes, type_text text, load_basic program, assemble_and_load source; press_break and run nothing',
      JSON.stringify(Object.fromEntries(Object.values(T).map((t) => [t.name, t.input_schema.required]))) === JSON.stringify({ poke: ['address', 'bytes'], type_text: ['text'], load_basic: ['program'], press_break: [], assemble_and_load: ['source'], run: [] }));
    check('every parameter has a description', Object.values(T).every((t) => Object.values(t.input_schema.properties).every((x) => typeof x.description === 'string' && x.description.length > 10)));
    // the numbers in the descriptions are the constants
    const range = `${Emu.ADDRESS_MIN}-${Emu.ADDRESS_MAX}`;
    check('the descriptions state the ranges from the constants', p('poke', 'address').description.includes(range) && p('assemble_and_load', 'org').description.includes(range) && p('run', 'target').description.includes(range)
      && p('poke', 'bytes').description.includes(`${Emu.BYTE_MIN}-${Emu.BYTE_MAX}`) && p('poke', 'bytes').description.includes(`${Emu.POKE_MIN} to ${Emu.POKE_MAX}`)
      && T.type_text.description.includes(`1 to ${Emu.TYPE_TEXT_MAX} characters`) && p('type_text', 'text').description.includes(`${Emu.TYPE_TEXT_MAX}`)
      && T.load_basic.description.includes(`1 to ${Emu.BASIC_PROGRAM_TEXT_MAX} characters`) && T.load_basic.description.includes(`(0-${Emu.BASIC_LINE_MAX})`)
      && p('assemble_and_load', 'source').description.includes(`1 to ${Emu.SOURCE_MAX} characters`));
    // the switch is called by one name, the page's: every acting tool's description sent to the model says so
    check('every acting tool description names "Let Claude use the emulator" and none says "use the machine"',
      Object.values(T).length === Emu.ACTING_TOOL_NAMES.length && Object.values(T).every((t) => t.description.includes('"Let Claude use the emulator"') && !/use the machine/i.test(t.description)),
      Object.values(T).filter((t) => !t.description.includes('"Let Claude use the emulator"') || /use the machine/i.test(t.description)).map((t) => t.name).join());
    check('the optional parameters state their defaults from the constants', p('run', 'target').description.includes(`omit for "${Emu.RUN_DEFAULT_TARGET}"`)
      && p('assemble_and_load', 'org').description.includes(`assembled at ${Emu.ASSEMBLE_DEFAULT_ORG}`));
    // and the code applies those defaults: run with no target types RUN (no BASIC here: no-basic, as "RUN" is);
    // assemble_and_load with no org and no ORG assembles at ASSEMBLE_DEFAULT_ORG
    const s = stub(); s.consent.setAllowed(true);
    const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY }) });
    const code = (name, input) => chat.runTool(name, input).then(() => null, (e) => e.code);
    check('run with no target behaves as "RUN"', await code('run', {}) === C.NO_BASIC && await code('run', { target: Emu.RUN_DEFAULT_TARGET }) === C.NO_BASIC);
    const a = await chat.runTool('assemble_and_load', { source: ' FCB 7\n' }).catch((e) => ({ ranges: [{ from: e.code }] }));
    check('assemble_and_load with no org and no ORG writes at ASSEMBLE_DEFAULT_ORG', a.ranges[0].from === Emu.ASSEMBLE_DEFAULT_ORG, JSON.stringify(a.ranges));
    // the boundaries the schemas state are the ones enforced: at the limit passes the check, one past is refused
    check('poke: POKE_MAX bytes pass, POKE_MAX+1 are too-large', (await code('poke', { address: 0x2000, bytes: new Array(Emu.POKE_MAX).fill(1) })) === null && await code('poke', { address: 0x2000, bytes: new Array(Emu.POKE_MAX + 1).fill(1) }) === C.TOO_LARGE);
    check('poke: BYTE_MAX passes, BYTE_MAX+1 and BYTE_MIN-1 are bad-byte', await code('poke', { address: 0x2000, bytes: [Emu.BYTE_MAX] }) === null && await code('poke', { address: 0x2000, bytes: [Emu.BYTE_MAX + 1] }) === C.BAD_BYTE && await code('poke', { address: 0x2000, bytes: [Emu.BYTE_MIN - 1] }) === C.BAD_BYTE);
    check('poke: ADDRESS_MAX+1 and ADDRESS_MIN-1 are bad-address', await code('poke', { address: Emu.ADDRESS_MAX + 1, bytes: [1] }) === C.BAD_ADDRESS && await code('poke', { address: Emu.ADDRESS_MIN - 1, bytes: [1] }) === C.BAD_ADDRESS);
    check('assemble_and_load: org ADDRESS_MAX+1 is bad-address; SOURCE_MAX characters pass the length check, SOURCE_MAX+1 do not',
      await code('assemble_and_load', { source: ' NOP\n', org: Emu.ADDRESS_MAX + 1 }) === C.BAD_ADDRESS
      && await code('assemble_and_load', { source: ` FCB 1\n*${'x'.repeat(Emu.SOURCE_MAX - 8)}`, org: 0x2000 }) === null && await code('assemble_and_load', { source: big(Emu.SOURCE_MAX + 1) }) === C.TOO_LARGE);
    check('run: ADDRESS_MAX+1 is bad-target', await code('run', { target: Emu.ADDRESS_MAX + 1 }) === C.BAD_TARGET);
    check('type_text: TYPE_TEXT_MAX+1 is too-large', await code('type_text', { text: big(Emu.TYPE_TEXT_MAX + 1) }) === C.TOO_LARGE);
    check('load_basic: BASIC_PROGRAM_TEXT_MAX+1 is too-large', await code('load_basic', { program: big(Emu.BASIC_PROGRAM_TEXT_MAX + 1) }) === C.TOO_LARGE);
  }

  // ---- 3. the gate and the restore point, for every acting tool ----
  {
    // the acting tools, from the schemas: a tool added there is covered here without editing this test
    const acting = Emu.machineTools().map((t) => t.name).filter((x) => !Emu.READ_ONLY_TOOLS.includes(x));
    check('the acting tools are the schemas\' non-read tools, and ACTING_TOOL_NAMES names exactly them', JSON.stringify(acting) === JSON.stringify([...Emu.ACTING_TOOL_NAMES]), acting.join());
    const valid = { poke: { address: 0x3000, bytes: [1] }, type_text: { text: 'A' }, load_basic: { program: '10 END' }, press_break: {}, assemble_and_load: { source: ' NOP\n', org: 0x3000 }, run: { target: 0x3000 } };
    // a target that records the order of the gate, the restore point and every change
    const rig = (gate) => {
      const s = basic(); const log = [];
      const real = s.chatTarget();
      const target = Object.create(real);
      for (const k of ['pokeBytes', 'writeSegments', 'run']) target[k] = (...a) => { log.push(`change:${k}`); return real[k](...a); };
      // the keyboard jobs end at once here (the machine is not run): the order is what is checked
      target.typeText = (text) => { log.push('change:typeText'); return { promise: Promise.resolve(), status: 'done', requested: text.length, consumed: text.length, linesRequested: 0, linesDelivered: 0 }; };
      target.pressBreak = () => { log.push('change:pressBreak'); return { promise: Promise.resolve(), status: 'done', key: 'BREAK', requested: 1, consumed: 1, linesRequested: 0, linesDelivered: 0 }; };
      target.snapshot = () => { log.push('restore-point'); return real.snapshot(); };
      Object.defineProperty(target, 'machine', { get: () => real.machine });
      const chat = new Emu.ChatSession({ backend: { send() {} }, target, gate: (name, input) => { log.push(`gate:${name}`); return gate(name, input); } });
      return { s, chat, log };
    };
    for (const name of acting) {
      const input = valid[name];
      check(`${name}: has valid input in this test (a new acting tool needs one here)`, !!input);
      if (!input) continue;
      // allowed: gate first, then the restore point, then the change
      const a = rig(() => null);
      let out = null; try { out = await a.chat.runTool(name, input); } catch (e) { out = e; }
      const firstChange = a.log.findIndex((x) => x.startsWith('change:'));
      check(`${name}: passes the gate, then the restore point, before its first change`, !(out instanceof Error) && a.log[0] === `gate:${name}` && a.log.indexOf('restore-point') === 1 && firstChange > 1 && a.chat.undo.length === 1,
        `${a.log.join(' > ')} ${out instanceof Error ? out.message : ''}`);
      // a gate that refuses: the gate's code, nothing changed, no restore point
      const b = rig(() => { throw new Emu.ToolError(C.CONSENT_DECLINED); });
      const before = Emu.state.toJSON(b.s.shownMachine.snapshot());
      let err = null; try { await b.chat.runTool(name, input); } catch (e) { err = e; }
      check(`${name}: a refusing gate stops it: its code, nothing changed, no restore point`, err && err.code === C.CONSENT_DECLINED && b.log.join() === `gate:${name}` && Emu.state.toJSON(b.s.shownMachine.snapshot()) === before && b.chat.undo.length === 0, b.log.join(' > '));
      // a gate that waits and is answered after the turn was stopped meanwhile: stopped (the check after the gate),
      // nothing changed
      const c = rig(() => { c.chat.controller.abort(); return new Promise((r) => setTimeout(r, 1)); });
      c.chat.controller = new AbortController();
      let st = null; try { await c.chat.runTool(name, input); } catch (e) { st = e; }
      check(`${name}: a turn stopped while the gate waited changes nothing (stopped)`, st && st.code === C.STOPPED && !c.log.some((x) => x.startsWith('change:')) && c.chat.undo.length === 0, c.log.join(' > '));
      // a turn already stopped (an earlier call of the same response was stopped) asks nobody: the gate is not called
      const e2 = rig(() => null);
      e2.chat.controller = new AbortController(); e2.chat.controller.abort();
      let st2 = null; try { await e2.chat.runTool(name, input); } catch (e) { st2 = e; }
      check(`${name}: after Stop, a later call in the turn is stopped without asking`, st2 && st2.code === C.STOPPED && e2.log.length === 0, e2.log.join(' > '));
      // anything uncoded inside is tool-failed, from runTool itself (not only once the backend has wrapped it)
      const d = rig(() => null);
      d.chat.withRestorePoint = () => { throw new TypeError('x is not a function'); };
      let tf = null; try { await d.chat.runTool(name, input); } catch (e) { tf = e; }
      check(`${name}: an uncoded exception leaves runTool as tool-failed`, tf instanceof Emu.ToolError && tf.code === C.TOOL_FAILED && tf.tool.detail === 'x is not a function', tf && tf.message);
    }
    // the restore point is kept before the act, so it is there while typing is still going in, and a not-ram
    // (nothing landed) takes it back, putting back the oldest point it had pushed out of the last 10
    {
      const s2 = stub(); s2.consent.setAllowed(true);
      const c2 = s2.startAsk({ backend: new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY }) });
      let finish = null;
      c2.target.typeText = (text) => ({ promise: new Promise((r) => { finish = r; }), status: 'done', requested: text.length, consumed: text.length, linesRequested: 1, linesDelivered: 1 });
      const pr = c2.runTool('type_text', { text: 'A' });
      await new Promise((r) => setImmediate(r));
      const during = c2.undo.length, points = s2.claudePoints.length;
      finish(); await pr;
      check('type_text: the restore point exists while the typing is still going in', during === 1 && points === 1, `${during} ${points}`);
      c2.undo = Array.from({ length: 10 }, (_, i) => ({ marker: i }));
      c2.snapped = false;
      let told = 0; c2.onRestorePoint = () => { told++; };
      const r = await c2.runTool('poke', { address: 0xFFF0, bytes: [1] }).then(() => 'RAN', (e) => e.code);
      check('not-ram keeps no restore point: the last 10 are untouched and none is announced', r === C.NOT_RAM && c2.undo.length === 10 && c2.undo[0].marker === 0 && c2.undo[9].marker === 9 && c2.snapped === false && told === 0, `${r} ${c2.undo.map((u) => u.marker)} told ${told}`);
    }
    // the Session's chats use the Session's gate: with nobody to ask, every acting tool is no-consent and nothing changes
    const s = basic();
    const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY }) });
    const before = Emu.state.toJSON(s.shownMachine.snapshot());
    const codes = [];
    for (const name of acting) codes.push(await chat.runTool(name, valid[name]).then(() => 'RAN', (e) => e.code));
    check('Session.startAsk: every acting tool goes through the Session\'s gate (nobody to ask: no-consent), nothing changed', codes.every((c) => c === C.NO_CONSENT) && Emu.state.toJSON(s.shownMachine.snapshot()) === before && chat.undo.length === 0, codes.join());
    // the turn aborted (Esc, BREAK: chat.abort(), not stopClaude) while a card or a pause waits: stopped, not a hang
    for (const [what, name, input, arrange] of [
      ['the consent card', 'poke', valid.poke, (s2) => { s2.consent.asker = () => {}; }],
      ['load_basic\'s card', 'load_basic', valid.load_basic, (s2) => { s2.consent.setAllowed(true); s2.consent.asker = () => {}; }],
      ['a pause', 'poke', valid.poke, (s2) => { s2.consent.setAllowed(true); s2.consent.paused = { held: { queue: [], stub: [] }, wake: [] }; }],
    ]) {
      const s2 = basic(); arrange(s2);
      const c2 = s2.startAsk({ backend: new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY }) });
      c2.controller = new AbortController();
      const before2 = Emu.state.toJSON(s2.shownMachine.snapshot());
      let settled = null;
      const pr = c2.runTool(name, input).then(() => 'RAN', (e) => e.code).then((c) => { settled = c; });
      await new Promise((r) => setImmediate(r));
      c2.abort();
      for (let i = 0; i < 50 && settled === null; i++) await new Promise((r) => setImmediate(r));
      check(`an abort while ${what} waits ends the call stopped, nothing changed, no card left up`, settled === C.STOPPED && s2.consent.pending === null && Emu.state.toJSON(s2.shownMachine.snapshot()) === before2 && c2.undo.length === 0, `${settled}`);
      if (settled === null) { s2.stopClaude(); await pr; }
    }
    // the restore point a tool keeps is stamped by the Session (claudePoints has its time)
    s.consent.setAllowed(true);
    await chat.runTool('poke', { address: 0x3000, bytes: [5] }).catch(() => null);
    check('the Session stamps each restore point a tool keeps', s.claudePoints.length === 1 && typeof s.claudePoints[0].at === 'number', JSON.stringify(s.claudePoints));
  }

  // ---- 3b. the pre-act re-check: a pause or a withdrawn switch during an async wait stops the change ----
  // A pause (a key the person pressed) or the switch turned off while a card waited or the tool's check ran (an
  // INCLUDE read) is seen just before the change: paused waits for Resume (Stop or Esc: stopped), a call that relied
  // on the switch is no-consent once it is off. Everything goes through the Session (pauseClaude, resumeClaude,
  // stopClaude, consent.answer, consent.setAllowed), as the page does.
  {
    const acting = [...Emu.ACTING_TOOL_NAMES];
    const valid = { poke: { address: 0x3000, bytes: [1] }, type_text: { text: 'A' }, load_basic: { program: '10 END' }, press_break: {}, assemble_and_load: { source: ' NOP\n', org: 0x3000 }, run: { target: 0x3000 } };
    const net = () => new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network'); }, apiKey: KEY });
    const tick = async (k = 30) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
    const at3000 = (s) => mem2(s.shownMachine, 0x3000, 2);
    const mem2 = (m, a, k) => Array.from({ length: k }, (_, i) => m.ram[a + i]);
    const inc = ' INCLUDE "x.inc"\n';
    // a chat in a turn (busy, a controller) whose INCLUDE reader runs `during` while the check waits
    const rig2 = (during) => {
      const s = basic(); s.consent.setAllowed(true);
      const chat = s.startAsk({ backend: net(), include: async () => { during(s, chat); return ' FCB $55,$AA\n'; } });
      chat.busy = true; chat.controller = new AbortController();
      return { s, chat };
    };
    const start = (chat, name, input) => { const st = { code: null }; st.p = chat.runTool(name, input).then(() => 'RAN', (e) => e.code).then((c) => { st.code = c; }); return st; };
    // a pause during the INCLUDE read: nothing lands until Resume, then it does
    for (const [end, endName, want] of [[(s) => s.resumeClaude(), 'Resume', 'RAN'], [(s) => s.stopClaude(), 'Stop', C.STOPPED], [(s, chat) => chat.abort(), 'Esc (the turn aborted)', C.STOPPED]]) {
      const { s, chat } = rig2((s1) => { s1.pauseClaude(); });
      const st = start(chat, 'assemble_and_load', { source: inc, org: 0x3000 });
      await tick();
      const paused = !!s.consent.paused, held = at3000(s).join(), heldUndo = chat.undo.length, waiting = st.code === null;
      end(s, chat); await tick(); await st.p;
      const landed = at3000(s).join() === '85,170';
      check(`assemble_and_load paused during its INCLUDE read: nothing lands while paused; ${endName} -> ${want}`,
        paused && waiting && held === '0,0' && heldUndo === 0 && st.code === want && landed === (want === 'RAN') && chat.undo.length === (want === 'RAN' ? 1 : 0),
        `paused ${paused} held ${held} -> ${st.code} ${at3000(s)}`);
    }
    // a pause while a card waits, then the person answers yes: still nothing until Resume
    for (const [what, name, input, arrange] of [
      ['the consent card', 'poke', { address: 0x3000, bytes: [0x55, 0xAA] }, (s) => { s.consent.setAllowed(false); }],
      ['load_basic\'s card', 'load_basic', { program: '10 END' }, () => {}],
    ]) {
      for (const [end, endName, want] of [[(s) => s.resumeClaude(), 'Resume', 'RAN'], [(s) => s.stopClaude(), 'Stop', C.STOPPED]]) {
        const s = basic(); s.consent.setAllowed(true);
        const chat = s.startAsk({ backend: net() });
        chat.busy = true; chat.controller = new AbortController();
        // an earlier call this turn: Claude is acting, so a key the person presses pauses it
        await chat.runTool('poke', { address: 0x3100, bytes: [1] });
        arrange(s);
        s.consent.asker = () => {};
        const before = Emu.state.toJSON(s.shownMachine.snapshot()), undo0 = chat.undo.length;
        const st = start(chat, name, input);
        await tick();
        const carded = !!s.consent.pending, pausedOk = s.pauseClaude();
        s.consent.answer(true); await tick();
        const heldSame = Emu.state.toJSON(s.shownMachine.snapshot()) === before && st.code === null;
        end(s, chat); await tick(); await st.p;
        const after = Emu.state.toJSON(s.shownMachine.snapshot()) === before;
        check(`${name}: paused while ${what} waits, then answered yes: nothing changes while paused; ${endName} -> ${want}`,
          carded && pausedOk && heldSame && st.code === want && after === (want !== 'RAN') && chat.undo.length === undo0,
          `card ${carded} paused ${pausedOk} held ${heldSame} -> ${st.code}`);
      }
    }
    // the switch turned off during the INCLUDE read: a call that relied on the switch is no-consent, nothing changed
    {
      const { s, chat } = rig2((s1) => { s1.consent.setAllowed(false); });
      const st = start(chat, 'assemble_and_load', { source: inc, org: 0x3000 }); await tick(); await st.p;
      check('the switch turned off while the INCLUDEs were read: no-consent, nothing written, no restore point', st.code === C.NO_CONSENT && at3000(s).join() === '0,0' && chat.undo.length === 0, `${st.code} ${at3000(s)}`);
    }
    // ... while a call allowed by its own card (Allow on the consent card) goes on: the person said yes to this call
    {
      const { s, chat } = rig2((s1) => { s1.consent.setAllowed(false); });
      s.consent.setAllowed(false); s.consent.asker = () => { Promise.resolve().then(() => s.consent.answer(true)); };
      const st = start(chat, 'assemble_and_load', { source: inc, org: 0x3000 }); await tick(); await st.p;
      check('a call allowed on its own card still acts when the switch goes off during its check (the card answered for it)', st.code === 'RAN' && at3000(s).join() === '85,170' && !s.consent.allowed, `${st.code} ${at3000(s)}`);
    }
    // a ChatSession built without a gate acts for nobody
    {
      const s = basic(); const before = Emu.state.toJSON(s.shownMachine.snapshot());
      const bare = new Emu.ChatSession({ backend: { send() {} }, target: s.chatTarget() });
      const codes = [];
      // (a call that would act is not left to hang the test: one that has not settled at once counts as acting)
      for (const name of acting) codes.push(await Promise.race([bare.runTool(name, valid[name]).then(() => 'RAN', (e) => e.code), new Promise((r) => setTimeout(() => r('PENDING'), 50))]));
      check('a ChatSession without a gate: every acting tool is no-consent, nothing changed', codes.every((c) => c === C.NO_CONSENT) && Emu.state.toJSON(s.shownMachine.snapshot()) === before && bare.undo.length === 0, codes.join());
    }
  }

  // ---- 4. the brief states the contract, from the code's own names ----
  {
    const on = Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'x', tools: true });
    const off = Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'x', tools: false });
    check('the brief states the tool contract when tools are on, and not when they are off', on.includes(Emu.TOOL_CONTRACT) && !off.includes(Emu.TOOL_CONTRACT));
    check('the contract names every acting and every read-only tool, the error shape, and only codes the table has',
      Emu.ACTING_TOOL_NAMES.every((x) => Emu.TOOL_CONTRACT.includes(x)) && Emu.READ_ONLY_TOOLS.every((x) => Emu.TOOL_CONTRACT.includes(x)) && Emu.TOOL_CONTRACT.includes('{"error":{"code","remedy","detail"}}')
      && JSON.stringify(named(Emu.TOOL_CONTRACT)) === JSON.stringify([C.CONSENT_DECLINED, C.LOAD_DECLINED, C.NO_CONSENT, C.STOPPED, C.MACHINE_RESTARTED].sort()), named(Emu.TOOL_CONTRACT).join());
  }

  // ---- 5. docs/claude.md lists every code with the remedy the model is given ----
  {
    const doc = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'claude.md'), 'utf8');
    const missing = Object.entries(Emu.TOOL_ERRORS).filter(([code, remedy]) => !doc.includes(`| \`${code}\` | ${remedy.replace(/\|/g, '\\|')} |`)).map(([c]) => c);
    check('docs/claude.md lists every code with its remedy, word for word', missing.length === 0, missing.join());
  }

  console.log(`\n${n - fail}/${n} acting-tool contract checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
