// Run: node tests/claude-suggest.test.js
//
// "Suggest questions with Claude" (js/claude/suggest.js, Session.claudeSuggestions; the page is js/ui/ask.js and
// js/ui/claude-features.js): off by default, kept with the settings; no request with it off, with Claude features Off,
// without a key, or on a graphics screen; exactly one request when on, to Claude Haiku with about 150 tokens, carrying
// only the machine's name and the screen's text; at most one per distinct screen and one per 30 s; a 3 s timeout or an
// answer that is not 1-3 questions of at most 60 characters gives nothing (the page keeps its own questions); and the
// key goes only into the request's header: never the machine's memory, a snapshot, a settings export or a log. All with
// a mocked fetch. (The browser check's `askSuggest` group checks the page: the setting's states, the label and swap,
// the timeout fallback and that a tap sends nothing.)
const path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const KEY = 'sk-ant-SUGGEST-TEST-KEY-0123456789abcdef';
const answer = (text) => ({ ok: true, status: 200, json: async () => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }) });
const GOOD = JSON.stringify(['What does NO ROM LOADED mean?', 'How do I load a binary?', 'Which machine is this?']);

(async () => {
  const S = await import(path.join(__dirname, '..', 'js', 'claude', 'suggest.js'));
  // ---- the answer's rules ----
  const p = (text) => S.parseSuggestions({ content: [{ type: 'text', text }] });
  check('a valid answer: up to 3 questions', JSON.stringify(p(GOOD)) === GOOD);
  check('one or two questions are fine', p('["Why?"]').length === 1 && p('["A?","B?"]').length === 2);
  check('four questions: invalid', p('["a","b","c","d"]') === null);
  check('none: invalid', p('[]') === null);
  check('61 characters: invalid; 60: valid', p(JSON.stringify(['x'.repeat(61)])) === null && p(JSON.stringify(['x'.repeat(60)])).length === 1);
  check('not JSON: invalid', p('1. What is this?\n2. Why?') === null);
  check('not strings: invalid', p('[1,2]') === null && p('[{"q":"a"}]') === null && p('"a"') === null);
  check('an empty or blank question: invalid', p('["", "a"]') === null && p('["   "]') === null);
  check('a control character (a second line): invalid', p(JSON.stringify(['a\nb'])) === null);
  check('the same question twice: invalid', p('["a","a"]') === null);
  check('no text block, or no content: invalid', S.parseSuggestions({ content: [] }) === null && S.parseSuggestions({}) === null && S.parseSuggestions(null) === null);
  check('limits: Haiku, 150 tokens, 3 s, 30 s, 3 questions of 60', S.SUGGEST_MODEL === 'claude-haiku-5-5' && S.SUGGEST_MAX_TOKENS === 150
    && S.SUGGEST_TIMEOUT_MS === 3000 && S.SUGGEST_GAP_MS === 30000 && S.SUGGEST_MAX === 3 && S.SUGGEST_MAX_CHARS === 60);

  // ---- the Session: the setting ----
  const logged = [];
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(' ')); orig.apply(console, a); }; }
  const make = () => {
    const store = Emu.memoryStore();
    const s = new Emu.Session({ store });
    s.switchMachine('dragon64');
    for (let i = 0; i < 60; i++) s.shownMachine.runFrame();
    return s;
  };
  const calls = [];
  let reply = () => answer(GOOD);
  const fetch = async (url, init) => { calls.push({ url, init }); return reply(url, init); };
  const s = make();
  check('off by default', s.claudeSuggest === false);

  // ---- no request in each off case ----
  s.setClaudeKey(KEY);
  check('off: no request', await s.claudeSuggestions(fetch) === null && calls.length === 0);
  s.setClaudeSuggest(true);
  check('on: stored, and in a settings export', s.store.get('claudeSuggest') === '1' && s.exportSettings().settings.claudeSuggest === '1');
  s.setClaudeFeatures(false);
  check('Claude features Off: no request', await s.claudeSuggestions(fetch) === null && calls.length === 0);
  s.setClaudeFeatures(true);
  s.clearClaudeKey();
  check('no key: no request', await s.claudeSuggestions(fetch) === null && calls.length === 0);
  s.setClaudeKey(KEY);
  // a graphics screen: PMODE 4 (PIA1 PB $F8, SAM V 6)
  const g = make();
  g.setClaudeKey(KEY); g.setClaudeSuggest(true);
  const gm = g.shownMachine;
  gm.write(0xFF22, 0xF8);
  for (const a of [0xFFC0, 0xFFC3, 0xFFC5]) gm.write(a, 0);
  gm.runFrame();   // (the mode is read as the next frame shows it)
  check('a graphics screen: no text to send, no request', g.suggestInput() === null && await g.claudeSuggestions(fetch) === null && calls.length === 0);

  // ---- on: exactly one request, and what it carries ----
  const got = await s.claudeSuggestions(fetch);
  check('on, with a key and a text screen: exactly one request', calls.length === 1, String(calls.length));
  check('its questions come back', JSON.stringify(got) === GOOD, JSON.stringify(got));
  const req = calls[0], body = JSON.parse(req.init.body);
  check('to the Messages API, the key in x-api-key only', req.url === 'https://api.anthropic.com/v1/messages' && req.init.method === 'POST'
    && req.init.headers['x-api-key'] === KEY && !req.init.body.includes(KEY), JSON.stringify(req.init.headers).replace(KEY, '<key>'));
  check('the body: Haiku, 150 tokens, a system prompt and one user message, nothing else', JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['max_tokens', 'messages', 'model', 'system'])
    && body.model === 'claude-haiku-5-5' && body.max_tokens === 150 && body.messages.length === 1 && body.messages[0].role === 'user' && !body.stream && !body.tools, JSON.stringify(Object.keys(body)));
  // (the built-in firmware's screen without ROMs, as it prints it)
  const screen = 'DRAGON 64\nNO ROM LOADED - BUILT-IN STUB\n\nDROP A BINARY (.BIN .CAS .ROM)\nON THE SCREEN, OR LOAD THE\nROMS TO RUN BASIC.';
  check('the message: the machine\'s name and the screen\'s text, exactly', body.messages[0].content === `Machine: Dragon 64\nScreen text:\n${screen}`, JSON.stringify(body.messages[0].content));

  // ---- at most one per distinct screen, one per 30 s ----
  let clock = 1000;
  const t = make();
  t.setClaudeKey(KEY); t.setClaudeSuggest(true);
  const tc = [];
  const tf = async (u, i) => { tc.push(i); return answer(GOOD); };
  await t.claudeSuggestions(tf, { now: () => clock });
  clock += 40000;
  await t.claudeSuggestions(tf, { now: () => clock });
  check('the same screen again, even 40 s later: no second request', tc.length === 1, String(tc.length));
  t.shownMachine.ram[0x5E0] = 0x01;   // (a changed screen: an A on an empty row)
  await t.claudeSuggestions(tf, { now: () => clock });
  check('a different screen: one more', tc.length === 2 && JSON.parse(tc[1].body).messages[0].content !== JSON.parse(tc[0].body).messages[0].content, String(tc.length));
  t.shownMachine.ram[0x5E1] = 0x02;
  clock += 10000;
  check('another screen 10 s after that request: none (one per 30 s)', await t.claudeSuggestions(tf, { now: () => clock }) === null && tc.length === 2, String(tc.length));
  clock += 21000;
  await t.claudeSuggestions(tf, { now: () => clock });
  check('the same screen 31 s after the last request: one more', tc.length === 3, String(tc.length));

  // ---- the timeout, errors and invalid answers: nothing (the page keeps its own) ----
  const sug = (fetchFn, timeoutMs = 3000) => new S.Suggester({ fetch: fetchFn, key: () => KEY, timeoutMs });
  const input = { machine: 'Dragon 64', screen: 'OK' };
  let aborted = false;
  const hang = (u, init) => new Promise((res, rej) => { init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); });
  const t0 = Date.now(), slow = await sug(hang, 200).suggest(input), took = Date.now() - t0;
  check('no answer in time: nothing, the request abandoned', slow === null && aborted && took >= 190 && took < 1500, `${took} ms`);
  check('the default timeout is 3 s', new S.Suggester({ fetch: hang, key: () => KEY }).timeoutMs === 3000);
  check('an HTTP error: nothing', await sug(async () => ({ ok: false, status: 401, json: async () => ({}) })).suggest(input) === null);
  check('a network error: nothing', await sug(async () => { throw new Error('offline'); }).suggest(input) === null);
  check('an invalid answer (four questions): nothing', await sug(async () => answer('["a","b","c","d"]')).suggest(input) === null);
  check('an answer that is prose: nothing', await sug(async () => answer('Here are some questions: what is this?')).suggest(input) === null);

  // ---- the machine's name is part of the screen's key ----
  check('the screen hash covers the machine name: the same text on another machine is another screen', S.screenHash({ machine: 'Dragon 64', screen: 'OK' }) !== S.screenHash({ machine: 'Dragon 32', screen: 'OK' })
    && S.screenHash({ machine: 'Dragon 64', screen: 'OK' }) === S.screenHash({ machine: 'Dragon 64', screen: 'OK' }));
  {
    const calls2 = [];
    const f2 = async (u, i) => { calls2.push(i); return answer(GOOD); };
    const sg = new S.Suggester({ fetch: f2, key: () => KEY, now: (() => { let c = 0; return () => (c += 40000); })() });
    await sg.suggest({ machine: 'Dragon 64', screen: 'OK' });
    await sg.suggest({ machine: 'Dragon 32', screen: 'OK' });
    check('the same screen text on a different machine: a second request', calls2.length === 2, String(calls2.length));
  }

  // ---- the person's own WAD's level: its screen is never handed out (as the read-only tools refuse it) ----
  {
    const fs = require('fs');
    const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');
    const ENGINE = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', PIN.files.engine.path)));
    const LEVEL = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', PIN.files.level.path)));
    const w = new Emu.Session({ welcomeMenu: false, store: Emu.memoryStore() });
    w.switchMachine('dragon64', {}, { menu: false });
    w.setClaudeKey(KEY); w.setClaudeSuggest(true);
    for (let i = 0; i < 60; i++) w.shownMachine.runFrame();
    const wcalls = [];
    const wf = async (u, i) => { wcalls.push(i); return answer(GOOD); };
    check('a text screen, no user data: there is input to send', !!w.suggestInput() && !w.userDataIn() && !w.userDiskIn());
    // (the machine's own-WAD mark: what a level converted from the person's WAD sets)
    w.userDataMachines.add(w.personMachine);
    check('the own-WAD mark (userDataIn): no input, no request', w.userDataIn() && w.suggestInput() === null && await w.claudeSuggestions(wf) === null && wcalls.length === 0);
    w.userDataMachines.delete(w.personMachine);
    check('the mark off again: the input is back', !!w.suggestInput());
    // (the disk itself, still in a drive after a power cycle cleared the mark)
    w.startWyrmfire(ENGINE, LEVEL.slice(), { level: 'user', name: 'DOOM1.WAD' });
    w.powerCycle({ menu: false });
    for (let i = 0; i < 60; i++) w.personMachine.runFrame();
    check('a power cycle with the own-WAD disk still in (userDiskIn only): no input, no request', !w.userDataIn() && w.userDiskIn() && w.suggestInput() === null && await w.claudeSuggestions(wf) === null && wcalls.length === 0);
    await w.drives.eject(0);
    w.powerCycle({ menu: false });
    for (let i = 0; i < 60; i++) w.personMachine.runFrame();
    check('the disk out and a power cycle: the rule lifts (no user data)', !w.userDataIn() && !w.userDiskIn());
  }

  // ---- the key never leaks ----
  const keyBytes = Buffer.from(KEY);
  const has = (buf) => Buffer.from(buf).indexOf(keyBytes) >= 0;
  const m = s.personMachine;
  check('not in the machine\'s memory', !has(m.ram) && !has(Uint8Array.from({ length: 0x10000 }, (_, a) => m.peek(a))));
  const snap = JSON.stringify(m.saveState ? m.saveState() : s.snapshot());
  check('not in a snapshot', !snap.includes(KEY));
  const exp = JSON.stringify(s.exportSettings());
  check('not in a settings export (the setting is)', !exp.includes(KEY) && /claudeSuggest/.test(exp));
  check('never logged', !logged.some((l) => l.includes(KEY)) && logged.length > 0);

  process.exitCode = fail ? 1 : 0;
  console.log(fail ? `${fail} FAILED` : 'all passed');
})();
