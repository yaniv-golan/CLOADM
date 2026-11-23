// Run: node tests/claude-actions.test.js
//
// What the page shows of Claude's actions and restore points, browser-free: the action
// record each acting call leaves on its turn (js/claude/actions.js, ChatSession.noteAction), the line a person reads
// for it, the folding of a busy turn, and the restore points' turns. No ROMs, no network: a Dragon 64 without ROMs
// (the stub takes typed keys, reads no BREAK) and a mocked API. AGENTS.md 4.6: no MAME oracle for page copy; the
// expected lines are the specified copy, written out here, not produced by the code under test.
//
// What is proved:
//  * each outcome from a real call through the real backend: done, partial (bytes not taken), declined, stopped
//    before and while (the ToolError's delivered count), keys not read (not-consumed), error (failureText);
//  * the copy of every line, as specified;
//  * reads are counted, never lines; a turn of more than 3 acting calls folds only its plain ✓ lines, the summary
//    counts them and the reads and never starts with ✓; partial, – and ✗ lines never fold;
//  * the records stay with their turn across later turns; each restore point knows its turn; a restore marks the
//    lines it took back " · undone at HH:MM" and leaves the earlier ones alone; the newest point is then the previous.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const KEY = 'sk-ant-ACTIONS-TEST-KEY-0123456789';

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } };
let ids = 0;
const tools = (uses) => sse([start, ...uses.flatMap((u, i) => [{ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${++ids}`, name: u[0], input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u[1]) } }, { type: 'content_block_stop', index: i }]),
{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
const text = (t) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);

function ask(replies) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64'); frames(s, 40);
  s.setClaudeKey(KEY); s.setClaudeAllowed(true);
  const fetch = async () => new Response(replies.shift() || text('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const chat = s.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }) });
  return { s, chat };
}
// one line, the machine running until the turn ends
async function line(s, chat, t, during = null) {
  let done = false;
  const p = chat.sendLine(t).then(() => { done = true; });
  for (let i = 0; i < 3000 && !done; i++) { frames(s, 1); if (during) during(i); await new Promise((r) => setImmediate(r)); }
  await p;
}
const lines = (chat, turn) => { const t = Emu.chatTurns(chat.messages).find((x) => x.turn === turn); return t ? t.actions.map((r) => Emu.actionLine(r).full) : null; };

process.exitCode = 1;
(async () => {
  // ---- every outcome, from real calls ----
  {
    const { s, chat } = ask([
      tools([['type_text', { text: 'DIR\n' }], ['type_text', { text: '10 A=1\n20 B=2\n30 C=3\n' }], ['poke', { address: 0x0400, bytes: [1, 2, 3] }],
        ['poke', { address: 0x7FFF, bytes: [1, 2] }], ['assemble_and_load', { source: ' FCB 1,2\n', org: 0x3000 }], ['assemble_and_load', { source: ' FCB 1,2,3,4\n', org: 0x7FFE }],
        ['press_break', {}], ['run', { target: 0x3000 }], ['run', { target: 'RUN' }], ['screen_text', {}], ['screen_text', {}], ['peek', { address: 0, length: 1 }]]),
      text('Done.'),
    ]);
    await line(s, chat, 'do everything');
    const got = lines(chat, 1);
    const want = [
      '✓ typed "DIR"',
      '✓ typed 3 lines',
      '✓ poked 3 bytes at $0400',
      '✓ poked 1 of 2 bytes at $7FFF',
      '✓ assembled and loaded 2 bytes at $3000',
      '✓ loaded 2 of 4 bytes at $7FFE (2 not taken)',
      '– pressed BREAK, but the machine didn\'t read the key',
      '✓ started $3000',
      `✗ couldn't run RUN: ${Emu.TOOL_ERRORS[Emu.TOOL_CODES.NO_BASIC]}`,
    ];
    check('one line per acting call, in order, in the specified words: done, partial, keys not read, error', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got, null, 1));
    const t = Emu.chatTurns(chat.messages)[0];
    check('reads are counted, never lines', JSON.stringify(t.reads) === '{"screen_text":2,"peek":1}' && t.actions.every((r) => !['screen_text', 'peek'].includes(r.tool)), JSON.stringify(t.reads));
    check('each record has its tool, a small summary of the input, the outcome and the time', t.actions.every((r) => typeof r.tool === 'string' && r.what && typeof r.outcome === 'string' && typeof r.time === 'number')
      && !JSON.stringify(t.actions).includes('20 B=2'), JSON.stringify(t.actions[1]));
    const block = Emu.actionBlock(t.actions, t.reads);
    check('nine acting calls fold: only plain ✓ lines fold; partial, – and ✗ stay; the summary counts them and the reads',
      block.summary === '5 actions · read the screen 2×, memory 1×' && block.lines.filter((l) => !l.folded).map((l) => l.full).join('|') === [want[3], want[5], want[6], want[8]].join('|'),
      `${block.summary} | ${block.lines.filter((l) => !l.folded).map((l) => l.full).join('|')}`);
    check('the summary never starts with ✓', !/^✓/.test(block.summary));
    check('the records are never sent to the API (apiMessages)', !JSON.stringify(Emu.apiMessages([...chat.messages, { role: 'user', content: 'q' }])).includes('"actions"'));
    s.endChat();
  }

  // ---- declined, stopped before, stopped while (a stopped turn makes no second request) ----
  {
    const { s, chat } = ask([tools([['type_text', { text: 'DIR\n' }]]), text('ok'), tools([['type_text', { text: 'DIR\n' }]]), tools([['type_text', { text: 'PRINT "A LONG LINE TO TYPE"\n' }]]), text('ok')]);
    s.setClaudeAllowed(false);
    s.claudeGate = () => { Promise.resolve().then(() => s.answerClaude(false)); };
    await line(s, chat, 'one');
    s.claudeGate = () => { Promise.resolve().then(() => s.stopClaude()); };
    await line(s, chat, 'two');
    s.setClaudeAllowed(true); s.claudeGate = null;
    let stopped = false;
    await line(s, chat, 'three', () => { if (!stopped && s.shownMachine.stubKeysTaken > 0 && chat.busy && s.claudeTool === 'type_text') { const taken = s.shownMachine.stubKeysTaken; if (taken >= 3) { stopped = true; s.stopClaude(); } } });
    check('"Just tell me the fix": – didn\'t type "DIR": you said no', JSON.stringify(lines(chat, 1)) === JSON.stringify(['– didn\'t type "DIR": you said no']), JSON.stringify(lines(chat, 1)));
    check('Stop on the card: – stopped before typing "DIR"', JSON.stringify(lines(chat, 2)) === JSON.stringify(['– stopped before typing "DIR"']), JSON.stringify(lines(chat, 2)));
    const t3 = Emu.chatTurns(chat.messages).find((x) => x.turn === 3);
    check('Stop while typing: – stopped while typing …, with the keys delivered from the ToolError', stopped && t3 && t3.actions[0].outcome === 'stopped' && t3.actions[0].delivered > 0
      && lines(chat, 3)[0] === '– stopped while typing "PRINT "A LONG LINE TO TYPE""', JSON.stringify(t3 && t3.actions));
    s.endChat();
  }

  // ---- load_basic's lines and run "RUN", from records built as the tools return them ----
  {
    const ok = Emu.actionLine(Emu.actionRecord('load_basic', { program: '10 A\n20 B\n' }, { result: { lines: 12, bytes: 99, start: 1, end: 99 } })).full;
    const no = Emu.actionLine(Emu.actionRecord('load_basic', { program: '10 A' }, { err: new Emu.ToolError(Emu.TOOL_CODES.LOAD_DECLINED) })).full;
    const ran = Emu.actionLine(Emu.actionRecord('run', {}, { result: { how: 'typed', target: 'RUN', requested: 4, consumed: 4 } })).full;
    const unread = Emu.actionLine(Emu.actionRecord('type_text', { text: 'DIR\n' }, { err: new Emu.ToolError(Emu.TOOL_CODES.NOT_CONSUMED) })).full;
    check('load_basic: ✓ loaded a 12-line BASIC program (the lines stored), – didn\'t load the program: you said no', ok === '✓ loaded a 12-line BASIC program' && no === '– didn\'t load the program: you said no', `${ok} | ${no}`);
    check('run "RUN": ✓ ran RUN; keys not read: – typed "DIR", but the machine didn\'t read the keys', ran === '✓ ran RUN' && unread === '– typed "DIR", but the machine didn\'t read the keys', `${ran} | ${unread}`);
    const few = Emu.actionBlock([Emu.actionRecord('press_break', {}, { result: {} }), Emu.actionRecord('press_break', {}, { result: {} })], { screen_text: 1 });
    check('three acting calls or fewer never fold', few.summary === null && few.lines.every((l) => !l.folded));
  }

  // ---- the records stay with their turn; restore points know their turn; a restore marks what it took back ----
  {
    const { s, chat } = ask([tools([['poke', { address: 0x3000, bytes: [1] }]]), text('one'), text('just talk'), tools([['poke', { address: 0x3001, bytes: [2] }]]), text('three')]);
    await line(s, chat, 'first');
    await line(s, chat, 'second');
    await line(s, chat, 'third');
    const pts = s.claudePoints;
    check('each restore point knows the turn it was taken in (newest first)', pts.length === 2 && pts[0].turn === 3 && pts[1].turn === 1, JSON.stringify(pts));
    check('the first turn\'s line survives later turns', JSON.stringify(lines(chat, 1)) === JSON.stringify(['✓ poked 1 byte at $3000']) && JSON.stringify(lines(chat, 2)) === '[]');
    const now = new Date();
    s.restoreClaude();
    const hhmm = now.toTimeString().slice(0, 5);
    check('Restore to the newest point: its turn\'s line says undone at the restore time; the earlier turn\'s does not', lines(chat, 3)[0] === `✓ poked 1 byte at $3001 · undone at ${hhmm}` && lines(chat, 1)[0] === '✓ poked 1 byte at $3000'
      && s.shownMachine.ram[0x3001] === 0 && s.shownMachine.ram[0x3000] === 1, JSON.stringify([lines(chat, 1), lines(chat, 3)]));
    check('and the newest point is now the previous one, in turn 1', s.claudePoints.length === 1 && s.claudePoints[0].turn === 1);
    s.restoreClaude();
    check('restoring that one marks turn 1 too, and no point is left', /undone at/.test(lines(chat, 1)[0]) && s.claudePoints.length === 0);
    s.endChat();
  }
  // a restore marks only what changed the machine: not a declined call, an error, or BREAK the machine never read
  {
    const { s, chat } = ask([tools([['poke', { address: 0x3000, bytes: [1] }], ['poke', { address: 70000, bytes: [1] }], ['press_break', {}]]), text('ok')]);
    await line(s, chat, 'go');
    s.restoreClaude();
    const got = lines(chat, 1);
    check('a restore marks the poke, not the refused poke nor the unread BREAK', /^✓ poked 1 byte at \$3000 · undone at \d\d:\d\d$/.test(got[0]) && !/undone/.test(got[1]) && !/undone/.test(got[2])
      && Emu.chatTurns(chat.messages)[0].actions[2].delivered === 0, JSON.stringify(got));
    s.endChat();
  }

  // ---- reads: counted on a line of their own when nothing folds; a failed read is a ✗ line ----
  {
    const { s, chat } = ask([tools([['screen_text', {}], ['screen_text', {}], ['peek', { address: 0, length: 1 }], ['peek', { address: 70000, length: 1 }]]), text('Read.'),
      tools([['poke', { address: 0x3000, bytes: [1] }], ['machine_info', {}]]), text('One.')]);
    await line(s, chat, 'look');
    await line(s, chat, 'poke');
    const [t1, t2] = Emu.chatTurns(chat.messages);
    const b1 = Emu.actionBlock(t1.actions, t1.reads), b2 = Emu.actionBlock(t2.actions, t2.reads);
    const peekErr = Emu.TOOL_ERRORS[Emu.TOOL_CODES.BAD_ADDRESS];
    check('a turn of reads only: the reads on a plain line, and the failed read as its own ✗ line with its failureText',
      b1.summary === null && b1.reads === 'read the screen 2×, memory 1×' && JSON.stringify(b1.lines.map((l) => l.full)) === JSON.stringify([`✗ couldn't read memory: ${peekErr}`]), JSON.stringify(b1));
    check('a turn with one action and one read: the action line, then "read the machine 1×"', b2.summary === null && b2.reads === 'read the machine 1×'
      && JSON.stringify(b2.lines.map((l) => l.full)) === JSON.stringify(['✓ poked 1 byte at $3000']), JSON.stringify(b2));
    const many = Emu.actionBlock([1, 2, 3, 4].map((i) => Emu.actionRecord('poke', { address: 0x3000 + i, bytes: [1] }, { result: { written: 1, length: 1, skipped: 0 }, seq: i })), { screen_text: 2 });
    check('when the ✓ lines fold, the reads are in the summary and not on a second line', many.summary === '4 actions · read the screen 2×' && many.reads === null, JSON.stringify(many.reads));
    const fails = Emu.actionBlock([1, 2, 3, 4].map((i) => Emu.actionRecord('peek', { address: 70000 }, { err: new Emu.ToolError(Emu.TOOL_CODES.BAD_ADDRESS, 70000), seq: i })), null);
    check('failed reads are lines but not acting calls: four of them fold nothing', fails.summary === null && fails.lines.length === 4 && fails.lines.every((l) => !l.folded));
    s.endChat();
  }

  // ---- the machine restarting under Claude's typing is not a Stop ----
  {
    const { s, chat } = ask([tools([['type_text', { text: 'PRINT "A LONG LINE TO TYPE"\n' }]]), text('ok')]);
    let reset = false;
    const sent = [];
    const emit = chat.emitTool.bind(chat);
    chat.emitTool = (nm, i, t, isErr, v) => { sent.push(t); emit(nm, i, t, isErr, v); };
    await line(s, chat, 'type', () => { if (!reset && s.shownMachine.stubKeysTaken >= 3) { reset = true; s.shownMachine.reset(false); } });
    const t = Emu.chatTurns(chat.messages)[0];
    const got = JSON.parse(sent[0] || '{}');
    // (a reset Claude's own keys did not cause also ends the turn, as before: the Session stops Claude for it; the call's
    // own result is what this checks)
    check('a reset while Claude types: the call is machine-restarted (not stopped), with how many keys went in',
      reset && got.error && got.error.code === 'machine-restarted' && /^\d+ of 28 keys typed$/.test(got.error.detail), `${sent[0]} ${chat.error && chat.error.message}`);
    check('its line: – typed "…", then the machine restarted', t.actions[0].outcome === 'restarted' && t.actions[0].delivered > 0
      && Emu.actionLine(t.actions[0]).full === '– typed "PRINT "A LONG LINE TO TYPE"", then the machine restarted', Emu.actionLine(t.actions[0]).full);
    s.endChat();
  }
  // the typist on its own: a reset after every key was read ends the job done; part-way, machine-restarted; Stop, stopped
  {
    const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64'); frames(s, 40);
    const m = s.shownMachine;
    const all = m.typist.typePaced('AB');
    for (let i = 0; i < 400 && !(all.consumed === all.requested && all.status === 'typing'); i++) frames(s, 1);
    const caught = all.status === 'typing';
    m.reset(false);
    check('a reset after every key was read (the last key\'s release cut short): the job ends done', caught && all.status === 'done', `${caught} ${all.status} ${all.consumed}/${all.requested}`);
    const part = m.typist.typePaced('ABCDEFGH');
    for (let i = 0; i < 400 && part.consumed < 2; i++) frames(s, 1);
    m.reset(false);
    check('a reset part-way: machine-restarted, with what went in', part.status === 'machine-restarted' && part.consumed >= 2 && part.consumed < 8, `${part.status} ${part.consumed}`);
    const stop = m.typist.typePaced('ABCDEFGH');
    for (let i = 0; i < 400 && stop.consumed < 2; i++) frames(s, 1);
    m.typist.clear();
    check('Stop (the typist cleared by the page) part-way is still stopped', stop.status === 'stopped');
  }

  console.log(`\n${n - fail}/${n} action line checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
