// Run: node tests/claude-ask-acting.test.js
//
// The Ask panel's turn-scoped pause (the person's input pauses Claude: Session.personInput) together with the acting
// tools' one sequence (ChatSession.runTool: Stop -> gate -> check -> Stop -> re-check -> withRestorePoint). No MAME
// oracle (AGENTS.md 4.6, Claude chat terminal): a mocked Messages API, never the real one; no ROMs (the stub Dragon,
// and our own idle firmware as "BASIC" for load_basic, as tests/claude-acting-contract.test.js does).
//
// What is proved:
//  * A - the person's input while a gate card waits (the consent card on the turn's first acting call, load_basic's
//    card) pauses Claude: Allow on the card does not let the tool act, nothing changes and no restore point is
//    taken while paused; Stop then ends the call stopped with nothing changed;
//  * B - the person's input between the gate and the re-check (during assemble_and_load's INCLUDE read) pauses
//    Claude: nothing is written and no restore point is taken; Stop, or the turn's abort (Esc), ends it stopped;
//  * C - Resume after A: the waiting call acts, the turn goes on, and its next acting call goes through the gate
//    again (a card again once the switch is off); the pause and the gate's call state end with the turn, so a key in
//    a later turn that only answers in text is just the person's key.
//  * R11 (UX ruling "Allow and resume") - answerClaude(true, { resume: true }) answers and resumes in one step and the
//    call acts once; a no while paused acts on nothing and leaves the pause; the switch turned off while a call waits
//    paused refuses it on Resume (no-consent) whatever consent it relied on, a card answered for it included; the
//    switch turned on while paused does not resume; while paused the status is the pause's even with a card up.
// (D, Stop from the #viewClaude pill while a gate card waits, and R11 through the page in the side panel and the
// full-screen chat, are page checks: tools/browser-check.js, group askEsc.)
const Emu = require('./load')();
const C = Emu.TOOL_CODES;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const KEY = 'sk-ant-ASK-ACTING-KEY-0123456789';
let finished = false;
process.on('exit', () => { if (!finished) { console.log('FAIL the test did not finish (a turn never ended)'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async (k = 30) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return !!fn(); };
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(ms).then(() => 'timeout')]);
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };

// the scripted Messages API: each request takes the next reply; { gate: true } holds it until open() is called
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [] } };
const end = (reason) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: {} }, { type: 'message_stop' }];
const textReply = (text) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
let toolN = 0;
const toolReply = (name, input) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${++toolN}`, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index: 0 }, ...end('tool_use')]);
function api(replies) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = replies.shift() || { body: textReply('ok') };
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      (async () => {
        if (r.gate) await new Promise((go) => { r.open = go; });
        resolve(new Response(r.body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      })();
    });
  };
  return { fetch, calls };
}

// a ROM-less Dragon 64 (the stub) with Ask open and a page that shows cards (claudeGate)
function stubAsk({ include = null } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  s.setClaudeKey(KEY);
  frames(s, 20);
  const replies = [];
  const a = api(replies);
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: a.fetch, apiKey: KEY }), include });
  const tools = [];
  chat.onToolUse = (name, input, text, isError, value) => tools.push({ name, isError, code: isError && value ? value.code : null });
  s.claudeGate = () => {};
  return { s, chat, replies, api: a, tools };
}
// a Dragon 64 with "BASIC" (our idle firmware) at its OK prompt, as tests/claude-acting-contract.test.js builds it
const START = 0x1E01, FRETOP = 0x7E00, P = 0x19;   // the Dragon's TXTTAB.. pointers at $19 [ITD App.8]
function basicAsk() {
  const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64');
  const m = s.shownMachine;
  const asm = Emu.assemble(' ORG $8000\nSTART STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\nIDLE BRA IDLE\n', '6809');
  const rom = new Uint8Array(0x4000).fill(0xFF); rom.set(asm.segments[0].data, 0);
  m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
  const w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  s.pokeBytes(START - 1, [0, 0, 0], m);
  w(P, START); w(P + 2, START + 2); w(P + 4, START + 2); w(P + 6, START + 2); w(P + 8, FRETOP);
  for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;
  m.ram[0x400 + 64] = 0x0F; m.ram[0x400 + 65] = 0x0B;   // "OK"
  frames(s, 3);
  s.setClaudeKey(KEY);
  const replies = [];
  const a = api(replies);
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch: a.fetch, apiKey: KEY }) });
  const tools = [];
  chat.onToolUse = (name, input, text, isError, value) => tools.push({ name, isError, code: isError && value ? value.code : null });
  s.claudeGate = () => {};
  return { s, chat, replies, api: a, tools };
}
const ram = (s, a, k) => Array.from({ length: k }, (_, i) => s.shownMachine.ram[a + i]).join();

(async () => {
  // ================= A: the person's input while a gate card waits =================
  {
    // A1: the consent card on the turn's first acting call (Claude has not acted yet this turn); the person's input
    // comes through Session.personInput, as every key on the page does
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(false);
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, { body: textReply('Done.') });
    const turn = chat.sendLine('poke it');
    await until(() => !!s.claudePending);
    const card = { pending: s.claudePending && s.claudePending.kind, acting: s.claudeBusyActing };
    const paused = s.personInput();
    const status1 = s.claudeStatus;
    s.answerClaude(true);
    await tick();
    const held = { ram: ram(s, 0x3000, 1), undo: chat.undo.length, busy: chat.busy, paused: !!s.claudePaused, status: s.claudeStatus && s.claudeStatus.phase };
    // (R11, an intended change: while paused the status is the pause's, not "Waiting for your OK"; the card stays)
    check('A1 the person\'s input while the consent card waits (the turn\'s first acting call) pauses Claude; the card stays up, the status is the pause\'s',
      card.pending === 'consent' && card.acting === false && paused === true && status1.phase === 'paused' && status1.text === 'Paused: you pressed a key · Claude\'s next action waits · Esc stops Claude', JSON.stringify({ card, paused, status1 }));
    check('A1 Allow on that card does not act while paused: nothing written, no restore point, the turn waits (status paused)',
      held.ram === '0' && held.undo === 0 && held.busy && held.paused && held.status === 'paused', JSON.stringify(held));
    s.stopClaude();
    const r = await within(turn);
    check('A1 Stop then ends the call stopped: nothing written, no restore point, no pause or call left, the turn ends',
      r !== 'timeout' && tools.length === 1 && tools[0].code === C.STOPPED && ram(s, 0x3000, 1) === '0' && chat.undo.length === 0
      && !s.claudePaused && s.claudeCall === null && !chat.busy && chat.error && chat.error.code === 'aborted', JSON.stringify({ tools, err: chat.error && chat.error.code, call: s.claudeCall }));
    s.endChat();
  }
  {
    // A2: load_basic's card (switch on: load_basic asks on every call). (Text the person types would also leave
    // BASIC away from its prompt, so the load would be refused not-at-prompt by its check: the pause alone is shown.)
    const { s, chat, replies, tools } = basicAsk();
    s.setClaudeAllowed(true);
    const ptrs = ram(s, P, 10);
    replies.push({ body: toolReply('load_basic', { program: '10 PRINT "HI"\n20 GOTO 10' }) }, { body: textReply('Loaded.') });
    const turn = chat.sendLine('load it');
    await until(() => !!s.claudePending);
    const kind = s.claudePending && s.claudePending.kind;
    const paused = s.personInput();
    s.answerClaude(true);
    await tick();
    const held = { ptrs: ram(s, P, 10) === ptrs, undo: chat.undo.length, busy: chat.busy };
    check('A2 the person\'s input while load_basic\'s card waits pauses Claude; Load it does not load while paused (no restore point)',
      kind === 'load' && paused && held.ptrs && held.undo === 0 && held.busy, JSON.stringify({ kind, paused, held }));
    s.stopClaude();
    const r = await within(turn);
    check('A2 Stop then: load_basic stopped, the program is not loaded, no restore point',
      r !== 'timeout' && tools[0] && tools[0].code === C.STOPPED && ram(s, P, 10) === ptrs && chat.undo.length === 0 && !s.claudePaused, JSON.stringify(tools));
    s.endChat();
  }

  {
    // A3: a call refused at its card ends its gate: while Claude then only thinks (the next request is out), the
    // person's key is just their key, not a pause (as in a turn that has not acted)
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(false);
    const next = { gate: true, body: textReply('Fine, here is how.') };
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, next);
    const turn = chat.sendLine('poke it');
    await until(() => !!s.claudePending);
    s.answerClaude(false);
    await until(() => !!next.open);
    const key = s.personInput();
    next.open();
    const r = await within(turn);
    check('A3 after a call refused at its card, a key while Claude thinks does not pause it; the turn ends normally',
      key === false && !s.claudePaused && r !== 'timeout' && tools[0].code === C.CONSENT_DECLINED && ram(s, 0x3000, 1) === '0' && !chat.error, JSON.stringify({ key, tools }));
    s.endChat();
  }

  // ================= B: the person's input between the gate and the re-check =================
  for (const [endName, endIt] of [['Stop', (s) => s.stopClaude()], ['the turn\'s abort (Esc)', (s, chat) => chat.abort()]]) {
    // the switch is on (no card): the gate passes at once, then the check reads an INCLUDE, and the person types meanwhile
    let s = null, reading = null;
    const include = async () => { s.typeText('X'); await new Promise((r) => { reading = r; }); return ' FCB $55,$AA\n'; };
    const rig = stubAsk({ include });
    s = rig.s;
    const { chat, replies, tools } = rig;
    s.setClaudeAllowed(true);
    replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3000 }) }, { body: textReply('Done.') });
    const turn = chat.sendLine('assemble');
    await until(() => !!reading);
    const paused = !!s.claudePaused;
    reading();
    await tick();
    const held = { ram: ram(s, 0x3000, 2), undo: chat.undo.length, busy: chat.busy, paused: !!s.claudePaused };
    check(`B the person's input during the check (an INCLUDE read) pauses Claude: when the read ends nothing is written and no restore point is taken (${endName})`,
      paused && held.ram === '0,0' && held.undo === 0 && held.busy && held.paused, JSON.stringify({ paused, held }));
    endIt(s, chat);
    const r = await within(turn);
    check(`B ${endName} then ends the call stopped: nothing written, no restore point, no pause left`,
      r !== 'timeout' && tools[0] && tools[0].code === C.STOPPED && ram(s, 0x3000, 2) === '0,0' && chat.undo.length === 0 && !s.claudePaused && s.claudeCall === null, JSON.stringify(tools));
    s.endChat();
  }

  // ================= R11: "Allow and resume" (UX ruling) =================
  {
    // answerClaude(true, { resume: true }) answers and resumes in one synchronous step: the call acts once
    // (acted: the poke's byte, or load_basic's end-of-program pointer moved)
    for (const [what, rig, tool, input, arrange, landed] of [
      ['the consent card', stubAsk, 'poke', { address: 0x3000, bytes: [0x55] }, (s) => s.setClaudeAllowed(false), (s) => ram(s, 0x3000, 1) === '85'],
      ['load_basic\'s card', basicAsk, 'load_basic', { program: '10 END' }, (s) => s.setClaudeAllowed(true), null],
    ]) {
      const { s, chat, replies, tools } = rig();
      arrange(s);
      const ptrs = ram(s, P + 2, 2);
      replies.push({ body: toolReply(tool, input) }, { body: textReply('Done.') });
      const turn = chat.sendLine('go');
      await until(() => !!s.claudePending);
      s.personInput();
      const before = { paused: !!s.claudePaused, card: !!s.claudePending };
      s.answerClaude(true, { resume: true });
      const sameStep = { paused: !!s.claudePaused, card: !!s.claudePending };
      const r = await within(turn);
      const acted = tool === 'poke' ? landed(s) : ram(s, P + 2, 2) !== ptrs;
      check(`R11 ${what}: answer with resume: yes and Resume in one synchronous step; the call acts exactly once, one restore point, the turn ends`,
        before.paused && before.card && !sameStep.paused && r !== 'timeout' && acted && tools.length === 1 && !tools[0].isError && chat.undo.length === 1 && !s.claudePaused,
        JSON.stringify({ before, sameStep, tools, undo: chat.undo.length }));
      s.endChat();
    }
  }
  {
    // a no while paused acts on nothing and leaves the pause; Resume then goes on (the call already refused)
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(false);
    const next = { gate: true, body: textReply('OK, here is the fix.') };
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, next);
    const turn = chat.sendLine('poke');
    await until(() => !!s.claudePending);
    s.personInput();
    s.answerClaude(false, { resume: true });
    await tick();
    const after = { paused: !!s.claudePaused, ram: ram(s, 0x3000, 1), code: tools[0] && tools[0].code, undo: chat.undo.length };
    check('R11 decline while paused: nothing acts (consent-declined), no restore point, and the pause stays (a no never resumes)',
      after.paused && after.ram === '0' && after.code === C.CONSENT_DECLINED && after.undo === 0, JSON.stringify(after));
    s.resumeClaude(); await until(() => !!next.open); next.open();
    const r = await within(turn);
    check('R11 decline while paused: Resume then lets the turn go on to its reply', r !== 'timeout' && !chat.error && ram(s, 0x3000, 1) === '0');
    s.endChat();
  }
  {
    // the bug: a card answered "Allow and resume", then a key during the INCLUDE read, the switch off, Resume: the
    // call must be refused (it relied on the card, so the switch check alone let it through)
    for (const [what, flip] of [['the switch off', (s) => s.setClaudeAllowed(false)], ['the switch off and on again', (s) => { s.setClaudeAllowed(false); s.setClaudeAllowed(true); }]]) {
      let s = null, reading = null;
      const include = async () => { s.personInput(); await new Promise((r) => { reading = r; }); return ' FCB $55,$AA\n'; };
      const rig = stubAsk({ include });
      s = rig.s;
      const { chat, replies, tools } = rig;
      s.setClaudeAllowed(false);
      replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3000 }) }, { body: textReply('Done.') });
      const turn = chat.sendLine('assemble');
      await until(() => !!s.claudePending);
      s.answerClaude(true, { resume: false });
      await until(() => !!reading);
      const paused = !!s.claudePaused;
      flip(s);
      reading(); await tick();
      const still = !!s.claudePaused;
      s.resumeClaude();
      const r = await within(turn);
      check(`R11 a call allowed on its card, paused during its check, ${what} while paused, then Resume: refused no-consent, nothing written, no restore point`,
        paused && still && r !== 'timeout' && tools[0] && tools[0].code === C.NO_CONSENT && ram(s, 0x3000, 2) === '0,0' && chat.undo.length === 0, JSON.stringify({ paused, still, tools }));
      s.endChat();
    }
  }
  {
    // F3: the refusal belongs to the pause it was made in: with the switch back on in the same turn the next acting
    // call acts, and the first call of the next turn, paused and resumed, acts
    let s = null, reading = null;
    const include = async () => { s.personInput(); await new Promise((r) => { reading = r; }); return ' FCB $55,$AA\n'; };
    const rig = stubAsk({ include });
    s = rig.s;
    const { chat, replies, tools } = rig;
    s.setClaudeAllowed(true);
    const second = { gate: true, body: toolReply('poke', { address: 0x3010, bytes: [0x11] }) };
    replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3000 }) }, second, { body: textReply('Done.') });
    const turn = chat.sendLine('assemble, then poke');
    await until(() => !!reading);
    s.setClaudeAllowed(false);
    reading(); await tick();
    s.resumeClaude();
    await until(() => !!second.open);
    const refused = tools[0] && tools[0].code;
    s.setClaudeAllowed(true);
    second.open();
    const r1 = await within(turn);
    const undo1 = chat.undo.length;
    check('F3 the switch back on in the same turn: the next acting call acts (ok, one restore point)',
      refused === C.NO_CONSENT && r1 !== 'timeout' && tools[1] && !tools[1].isError && ram(s, 0x3010, 1) === '17' && undo1 === 1, JSON.stringify({ refused, tools, undo1 }));
    // the next turn: its first call paused (a key while its INCLUDE is read) and resumed acts
    reading = null;
    replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3020 }) }, { body: textReply('Done.') });
    const turn2 = chat.sendLine('again');
    await until(() => !!reading);
    const paused2 = !!s.claudePaused;
    reading(); await tick();
    s.resumeClaude();
    const r2 = await within(turn2);
    check('F3 the next turn: its first call, paused and resumed, acts (ok, one more restore point)',
      paused2 && r2 !== 'timeout' && tools[2] && !tools[2].isError && ram(s, 0x3020, 2) === '85,170' && chat.undo.length === undo1 + 1, JSON.stringify({ paused2, t: tools[2], undo: chat.undo.length }));
    s.endChat();
  }
  {
    // F3 (same turn, a pause on the second call itself): refused in one pause, then the switch on, a second call
    // paused during its own check and resumed acts
    let s = null, reading = null, n = 0;
    const include = async () => { n++; s.personInput(); await new Promise((r) => { reading = r; }); return ' FCB $55,$AA\n'; };
    const rig = stubAsk({ include });
    s = rig.s;
    const { chat, replies, tools } = rig;
    s.setClaudeAllowed(true);
    const next = { gate: true, body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3030 }) };
    replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3000 }) }, next, { body: textReply('Done.') });
    const turn = chat.sendLine('assemble twice');
    await until(() => !!reading);
    s.setClaudeAllowed(false);
    reading(); reading = null; await tick();
    s.resumeClaude();
    await until(() => tools.length === 1 && !!next.open);
    s.setClaudeAllowed(true);
    next.open();
    await until(() => !!reading && n === 2);
    const paused = !!s.claudePaused;
    reading(); await tick();
    s.resumeClaude();
    const r = await within(turn);
    check('F3 same turn: refused once (switch off during its pause), then with the switch back on the next call, paused and resumed, acts (ok, undo 1)',
      tools[0].code === C.NO_CONSENT && paused && r !== 'timeout' && tools[1] && !tools[1].isError && ram(s, 0x3030, 2) === '85,170' && chat.undo.length === 1, JSON.stringify({ tools, undo: chat.undo.length }));
    s.endChat();
  }
  {
    // F4: the switch off while Claude's typing is held by a pause: Resume types none of it, and the call fails
    // no-consent (withdrawing consent stops all of Claude's input to the machine)
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(true);
    const text = 'PRINT "A LONG LINE THAT TAKES A WHILE TO TYPE"\n'.repeat(4);
    replies.push({ body: toolReply('type_text', { text }) }, { body: textReply('Typed.') });
    const turn = chat.sendLine('type');
    const m = s.shownMachine;
    await until(() => m.typist.queue.length > 50, 3000);
    frames(s, 10);
    const paused = s.personInput();
    const heldN = s.claudePaused && s.claudePaused.held.queue.length;
    s.setClaudeAllowed(false);
    s.resumeClaude();
    const right = { queue: m.typist.queue.length, stub: m.stubKeys.length };
    for (let i = 0; i < 60; i++) { frames(s, 1); await tick(1); }
    const r = await within(turn);
    check('F4 the switch off while typing is held: Resume puts none of it back (the held keys are dropped), the call fails no-consent, nothing more is typed',
      paused && heldN > 0 && right.queue === 0 && r !== 'timeout' && tools[0] && tools[0].code === C.NO_CONSENT && m.typist.queue.length === 0 && m.stubKeys.length === 0,
      JSON.stringify({ paused, heldN, right, tools }));
    s.endChat();
  }
  {
    // revoked, then Stop: Stop wins (stopped, not no-consent), nothing stays queued, and the next turn acts
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(true);
    const text = 'PRINT "A LONG LINE THAT TAKES A WHILE TO TYPE"\n'.repeat(4);
    replies.push({ body: toolReply('type_text', { text }) }, { body: textReply('Typed.') });
    const turn = chat.sendLine('type');
    const m = s.shownMachine;
    await until(() => m.typist.queue.length > 50, 3000);
    frames(s, 10);
    const paused = s.personInput();
    s.setClaudeAllowed(false);
    s.stopClaude();
    const r = await within(turn);
    const left = { queue: m.typist.queue.length, stub: m.stubKeys.length };
    check('F4 revoked then Stop: the call is stopped (not no-consent), nothing stays queued',
      paused && r !== 'timeout' && tools[0] && tools[0].code === C.STOPPED && left.queue === 0 && left.stub === 0, JSON.stringify({ tools, left }));
    s.setClaudeAllowed(true);
    replies.length = 0;   // (the stopped turn never asked for its last reply)
    replies.push({ body: toolReply('poke', { address: 0x3050, bytes: [0x77] }) }, { body: textReply('Done.') });
    const r2 = await within(chat.sendLine('poke'));
    check('F4 ... and the next turn acts', r2 !== 'timeout' && tools[1] && !tools[1].isError && s.shownMachine.ram[0x3050] === 0x77 && !s.claudePaused, JSON.stringify(tools[1]));
    s.endChat();
  }
  {
    // revoked, then Stop, on a gated call waiting in pauseWait (paused during its INCLUDE read, so it waits at the
    // re-check): Stop wins - the call is stopped, not no-consent - nothing is written, and the next turn acts
    let s = null, reading = null;
    const include = async () => { s.personInput(); await new Promise((r) => { reading = r; }); return ' FCB $55,$AA\n'; };
    const rig = stubAsk({ include });
    s = rig.s;
    const { chat, replies, tools } = rig;
    s.setClaudeAllowed(true);
    replies.push({ body: toolReply('assemble_and_load', { source: ' INCLUDE "x.inc"\n', org: 0x3000 }) }, { body: textReply('Done.') });
    const turn = chat.sendLine('assemble');
    await until(() => !!reading);
    reading(); await tick();
    const waiting = !!s.claudePaused && s.claudeCall !== null;
    s.setClaudeAllowed(false);
    s.stopClaude();
    const r = await within(turn);
    check('revoked then Stop on a gated call waiting in pauseWait: stopped (not no-consent), nothing written, no restore point',
      waiting && r !== 'timeout' && tools[0] && tools[0].code === C.STOPPED && ram(s, 0x3000, 2) === '0,0' && chat.undo.length === 0, JSON.stringify({ waiting, tools }));
    s.setClaudeAllowed(true);
    replies.length = 0;
    replies.push({ body: toolReply('poke', { address: 0x3060, bytes: [0x66] }) }, { body: textReply('Done.') });
    const r2 = await within(chat.sendLine('poke'));
    check('... and the next turn acts', r2 !== 'timeout' && tools[1] && !tools[1].isError && s.shownMachine.ram[0x3060] === 0x66, JSON.stringify(tools[1]));
    s.endChat();
  }
  {
    // the switch on while paused gives consent only: it does not resume
    const { s, chat, replies } = stubAsk();
    s.setClaudeAllowed(false);
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, { body: textReply('Done.') });
    const turn = chat.sendLine('poke');
    await until(() => !!s.claudePending);
    s.personInput();
    s.setClaudeAllowed(true);
    await tick();
    const held = { paused: !!s.claudePaused, card: !!s.claudePending, ram: ram(s, 0x3000, 1) };
    check('R11 the switch on while paused (a card up) does not resume: still paused, the card still up, nothing written',
      held.paused && held.card && held.ram === '0', JSON.stringify(held));
    s.stopClaude(); await within(turn);
    s.endChat();
  }

  {
    // paused at a card and then declined, the pause lasts while Claude only writes: the status says the next action
    // waits (not that it acts), and Claude is not "acting"; the next acting call then waits, and the status is the
    // plain pause again. (Claude acted earlier in this turn, so the turn counts as acting until the decline.)
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(true);
    const third = { gate: true, body: toolReply('poke', { address: 0x3002, bytes: [3] }) };
    const second = { gate: true, body: toolReply('poke', { address: 0x3001, bytes: [2] }) };
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [1] }) }, second, third, { body: textReply('Done.') });
    const turn = chat.sendLine('poke thrice');
    await until(() => !!second.open);
    s.setClaudeAllowed(false);
    second.open();
    await until(() => !!s.claudePending);
    s.personInput();
    s.answerClaude(false);
    await until(() => !!third.open);
    const writing = { status: s.claudeStatus, acting: s.claudeBusyActing, held: s.claudeHeld };
    third.open();
    await until(() => !!s.claudePending);
    s.answerClaude(true);
    await tick();
    const waiting = { status: s.claudeStatus, acting: s.claudeBusyActing, ram: ram(s, 0x3002, 1) };
    check('R11 paused at a card then declined: while Claude only writes, the status is the one paused text (its next action waits), and Claude is not acting',
      writing.status.phase === 'paused' && writing.status.text === 'Paused: you pressed a key · Claude\'s next action waits · Esc stops Claude' && writing.acting === false && writing.held === false
      && tools[1] && tools[1].code === C.CONSENT_DECLINED, JSON.stringify(writing));
    check('R11 ... the next acting call (allowed on its card) waits on the pause: the same paused text, acting again, nothing written',
      waiting.status.text === 'Paused: you pressed a key · Claude\'s next action waits · Esc stops Claude' && waiting.acting === true && waiting.ram === '0', JSON.stringify(waiting));
    s.stopClaude(); await within(turn);
    s.endChat();
  }

  // ================= F2: the embed API's changes are the person's input =================
  for (const [what, rig, act, landed] of [
    ['poke', stubAsk, (api) => api.poke(0x3100, [0x42]), (s) => s.shownMachine.ram[0x3100] === 0x42],
    ['loadBasic', basicAsk, (api) => api.loadBasic('10 PRINT "E"'), (s, ptrs) => ram(s, P + 2, 2) !== ptrs],
  ]) {
    // Claude's acting call waits at its card (the switch off): the embedding page's call pauses Claude first, then acts
    const { s, chat, replies, tools } = rig();
    s.setClaudeAllowed(false);
    const ptrs = ram(s, P + 2, 2);
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, { body: textReply('Done.') });
    const turn = chat.sendLine('poke');
    await until(() => !!s.claudePending);
    const api = new Emu.EmbedApi(s, () => {});
    let err = null;
    try { act(api); } catch (e) { err = e; }
    const r = { paused: !!s.claudePaused, landed: landed(s, ptrs), err: err && err.message };
    check(`F2 the embed API's ${what} while Claude's call waits at its card pauses Claude, then does what it was asked`, r.paused && r.landed && !err, JSON.stringify(r));
    s.answerClaude(true);
    await tick();
    check(`F2 after the embed ${what}: Allow (plain) does not act past the pause`, ram(s, 0x3000, 1) === '0' && chat.undo.length === 0 && !!s.claudePaused);
    s.stopClaude();
    await within(turn);
    check(`F2 after the embed ${what}: Stop ends the call stopped`, tools[0] && tools[0].code === C.STOPPED);
    s.endChat();
  }
  {
    // with no turn, the embed API's calls pause nothing (there is nothing to pause)
    const { s } = stubAsk();
    const api = new Emu.EmbedApi(s, () => {});
    api.poke(0x3100, [1]);
    check('F2 the embed API\'s poke with no turn in progress pauses nothing', !s.claudePaused && s.shownMachine.ram[0x3100] === 1);
    s.endChat();
  }

  // ================= F2: the joystick hook (gamepads, the mouse as joystick, the touch stick and FIRE) =================
  {
    const m = { joy: [[32, 32], [32, 32]], fire: [false, false] };
    const input = new Emu.HostInput(m, { set() {} });
    let calls = 0;
    input.onPlayer = () => { calls++; };
    const pad = (x, y, fire) => ({ axes: [x, y], buttons: [fire, false, false] });
    // idle polling and noise inside the dead zone: nothing
    for (let i = 0; i < 60; i++) input.setGamepad(0, pad((i % 7 - 3) * 0.05, (i % 5 - 2) * 0.05, false));
    const idle = calls;
    input.setGamepad(0, pad(0, 0, true));          // a fire press
    const fired = calls;
    for (let i = 0; i < 10; i++) input.setGamepad(0, pad(0, 0, true));   // held: the same press
    const held = calls;
    input.setGamepad(0, pad(0, 0, false));
    input.setGamepad(0, pad(0.9, 0, false));        // out of the dead zone
    const moved = calls;
    for (let i = 0; i < 10; i++) input.setGamepad(0, pad(0.8 + i * 0.01, 0.1, false));   // staying out: the same deflection
    const stays = calls;
    input.setGamepad(0, pad(0, 0, false));
    input.setGamepad(0, pad(0, -0.7, false));       // back to centre, then out again: a new deflection
    const again = calls;
    check('F2 joystick hook: idle polling and noise inside the dead zone are not the person\'s input; a fire press and a deflection out of the dead zone are, once each',
      idle === 0 && fired === 1 && held === 1 && moved === 2 && stays === 2 && again === 3, JSON.stringify({ idle, fired, held, moved, stays, again }));
    // hysteresis: resting at the edge of the dead zone with jitter fires once; back in only below 0.8 x DEAD_ZONE
    input.setGamepad(0, pad(0, 0, false));
    const before = calls, D = Emu.DEAD_ZONE;
    for (let i = 0; i < 40; i++) input.setGamepad(0, pad(i % 2 ? D + 0.01 : D - 0.01, 0, false));
    const jitter = calls - before;
    input.setGamepad(0, pad(Emu.PLAYER_BACK_IN * D - 0.01, 0, false));   // in again
    input.setGamepad(0, pad(D + 0.01, 0, false));                       // a new deflection
    check('F2 joystick hook: a stick jittering across the dead zone\'s edge fires once (hysteresis), and again only after it came back below 0.8 x the dead zone',
      jitter === 1 && calls - before === 2, JSON.stringify({ jitter, total: calls - before }));
    // one state per source: the mouse as joystick and pad 0 drive the same joystick without resetting each other
    input.setGamepad(0, pad(0.9, 0, false));          // the pad is out (a new deflection? it was out already: no)
    const padOut = calls;
    input.player('mouse', 0, 0, false);               // the mouse at the centre: its own state, the pad's stays out
    input.setGamepad(0, pad(0.9, 0, false));          // the pad still out: nothing new
    const shared = calls - padOut;
    input.player('mouse', 0.9, 0, false);             // the mouse's own deflection: once
    input.player('mouse', 0.95, 0.1, false);          // still out: nothing
    const mouse = calls - padOut;
    check('F2 joystick hook: each source has its own state (the mouse at the centre does not make the pad\'s held deflection fire again); the mouse\'s deflection fires once',
      shared === 0 && mouse === 1, JSON.stringify({ shared, mouse }));
    // the state ends with the pad and with the machine: a pad unplugged (clearGamepad) or a machine switched
    // (setMachine) and then pushed out again is a new push
    input.setGamepad(0, pad(0.9, 0, false));
    const c0 = calls;
    input.clearGamepad(0);
    input.setGamepad(0, pad(0.9, 0, false));
    const afterClear = calls - c0;
    input.player('mouse', 0.9, 0, false);
    const c1 = calls;
    input.setMachine(m);
    input.setGamepad(0, pad(0.9, 0, false));
    input.player('mouse', 0.9, 0, false);
    const afterSwitch = calls - c1;
    check('F2 joystick hook: pad out, unplugged (clearGamepad), out again fires once more; pad and mouse out, the machine switched (setMachine), out again each fire once more',
      afterClear === 1 && afterSwitch === 2, JSON.stringify({ afterClear, afterSwitch }));
    // the touch stick and its FIRE (js/ui/touch-keys.js) are the source 'touch': a drag out of the dead zone or a FIRE
    // press fires once each, with the pads' hysteresis; resting and jitter at the edge do not
    const R = Emu.STICK_RADIUS;
    const t0 = calls;
    for (let i = 0; i < 20; i++) input.touchStick((i % 3 - 1) * R * D * 0.5, 0);   // resting near the centre
    const rest = calls - t0;
    input.touchStick(R * 0.8, 0);                                                   // dragged out
    const out1 = calls - t0;
    for (let i = 0; i < 20; i++) input.touchStick(R * (i % 2 ? D + 0.02 : D - 0.02), 0);   // jitter at the edge
    const tJitter = calls - t0;
    input.touchStickRelease();
    input.touchFire(true);
    const tFire = calls - t0;
    input.touchFire(true);                                                          // held: the same press
    input.touchFire(false);
    input.touchStick(R * 0.8, 0);                                                   // out again after the release
    const tAgain = calls - t0;
    check('F2 joystick hook, touch: resting and jitter at the dead zone\'s edge are nothing; a drag out and a FIRE press fire once each; out again after a release fires again',
      rest === 0 && out1 === 1 && tJitter === 1 && tFire === 2 && tAgain === 3, JSON.stringify({ rest, out1, tJitter, tFire, tAgain }));
  }

  // ================= C: Resume after A =================
  {
    const { s, chat, replies, tools } = stubAsk();
    s.setClaudeAllowed(false);
    const gates = [];
    const gate = chat.gate;
    chat.gate = (name, input, call) => { gates.push(name); return gate(name, input, call); };
    const second = { gate: true, body: toolReply('poke', { address: 0x3001, bytes: [0xAA] }) };
    replies.push({ body: toolReply('poke', { address: 0x3000, bytes: [0x55] }) }, second, { body: textReply('Done.') });
    const turn = chat.sendLine('poke twice');
    await until(() => !!s.claudePending);
    s.personInput();
    s.answerClaude(true);
    await tick();
    const before = { ram: ram(s, 0x3000, 1), undo: chat.undo.length };
    s.resumeClaude();
    await until(() => !!second.open);
    const first = { ram: ram(s, 0x3000, 1), undo: chat.undo.length, paused: !!s.claudePaused, tool: tools[0] };
    check('C Resume after the pause during the card: the waiting poke acts (it was Allowed) with the turn\'s one restore point',
      before.ram === '0' && before.undo === 0 && first.ram === '85' && first.undo === 1 && !first.paused && first.tool && !first.tool.isError, JSON.stringify({ before, first }));
    // the person turns the switch off before Claude's next call: that call goes through the gate again and asks
    s.setClaudeAllowed(false);
    second.open();
    await until(() => !!s.claudePending);
    const again = { pending: s.claudePending && s.claudePending.kind, gates: gates.join(), ram: ram(s, 0x3001, 1) };
    s.answerClaude(true);
    const r = await within(turn);
    check('C the turn goes on: its next acting call goes through the gate again (the card again, the switch being off), then acts; the turn ends',
      again.pending === 'consent' && again.gates === 'poke,poke' && again.ram === '0' && r !== 'timeout' && ram(s, 0x3001, 1) === '170'
      && chat.messages.slice(-1)[0].content === 'Done.' && chat.undo.length === 1, JSON.stringify({ again, msgs: chat.messages.length }));
    check('C the turn\'s pause and gate state end with it: not paused, no call in flight, not acting',
      !s.claudePaused && s.claudeCall === null && s.claudeActing === null && !s.claudeBusyActing && s.claudeStatus === null, JSON.stringify({ call: s.claudeCall, acting: s.claudeActing }));
    // a later turn that only answers in text: a key the person presses is just their key
    const later = { gate: true, body: textReply('Just text.') };
    replies.push(later);
    const turn2 = chat.sendLine('and now?');
    await until(() => !!later.open);
    const key = s.personInput();
    later.open();
    await within(turn2);
    check('C a key in a later text-only turn does not pause Claude', key === false && !s.claudePaused, `${key}`);
    s.endChat();
  }

  finished = true;
  console.log(`\n${n - fail}/${n} ask + acting checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { finished = true; console.log('FAIL', e && e.stack); process.exitCode = 1; });
