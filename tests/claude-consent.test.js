// Run: node tests/claude-consent.test.js
//
// Claude's consent state (js/claude/consent.js), which the Session owns as session.consent:
//  * every decision on its own: a remembered allow asks nobody; "Don't ask again" on load_basic's card is
//    remembered (only while the switch is on); a card waiting is cleared, STOPPED, by the turn's abort; turning the
//    switch off refuses the card waiting; a pause revoked by the switch refuses the call waiting on it; the pre-act
//    re-check refuses a call that relied on a switch since turned off;
//  * the Session holds it as `consent`, and none of the old claude* names is left on the Session;
//  * nothing of it is saved: a snapshot and a settings export taken mid-chat (consent given, a card answered,
//    Claude paused) are byte-identical to the fixtures made at the commit before the move
//    (tests/fixtures/consent/), and the fixtures load and save back byte-identical;
//  * the API key reaches none of it: not the Consent object, the snapshot or the export.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const settle = () => new Promise((r) => setTimeout(r, 10));
// a call's outcome, or { hung: true } when it has not settled within 500 ms (a card nobody clears would leave the
// test with nothing pending, and Node would exit before the summary: a hang must be a failure, never silence)
const outcome = (p) => {
  let t;
  const hung = new Promise((r) => { t = setTimeout(() => r({ hung: true, err: {} }), 500); });
  return Promise.race([Promise.resolve(p).then((v) => ({ ok: true, v }), (err) => ({ ok: false, err })), hung]).finally(() => clearTimeout(t));
};
const FIX = path.join(__dirname, 'fixtures/consent');
const KEY = 'sk-ant-CONSENT-FIXTURE-KEY-0123456789';
const { Consent, STOPPED, TOOL_CODES } = Emu;

// a Consent with a page that records the cards it is asked to show, and a decide() with no load_basic plan
function consent() {
  const asked = [];
  const c = new Consent();
  c.asker = (name) => asked.push(name);
  return { c, asked };
}
const how = (extra = {}) => ({ load: () => ({ lines: 1, first: 10, last: 10, bytes: 8 }), acting: () => {}, signal: null, ...extra });

(async () => {
  // ---- 1. a remembered allow asks nobody ----
  {
    const { c, asked } = consent();
    const call = {};
    const first = c.decide('poke', {}, call, how());
    check('switch off: the first acting call asks (a card)', first && typeof first.then === 'function' && asked.join() === 'poke' && c.pending && c.pending.kind === 'consent');
    c.answer(true);
    await first;
    check('Allow: the call goes on, relied on the card, and the allow is remembered', call.consent === 'card' && c.allowed === true && c.pending === null);
    const call2 = {};
    let acted = 0;
    const second = c.decide('poke', {}, call2, how({ acting: () => { acted++; } }));
    check('the next call asks nobody (remembered allow): synchronous, relied on the switch', second === null && asked.length === 1 && call2.consent === 'switch' && acted === 1);
  }

  // ---- 2. "Don't ask again" on load_basic's card is remembered, while the switch is on ----
  {
    const { c, asked } = consent();
    c.setAllowed(true);
    const p = c.decide('load_basic', {}, {}, how());
    check('load_basic asks even with the switch on', p && asked.join() === 'load_basic' && c.pending.kind === 'load' && c.pending.load.first === 10);
    c.answer(true, { dontAsk: true });
    await p;
    check('Load it + Don\'t ask again: remembered', c.loadNoAsk === true);
    const call = {};
    check('the next load asks nobody', c.decide('load_basic', {}, call, how()) === null && asked.length === 1 && call.consent === 'switch');
    c.setAllowed(false);
    const again = c.loadNoAsk === false ? outcome(c.decide('load_basic', {}, {}, how())) : null;
    check('switch off: forgotten, and the next load asks again', again !== null && asked.length === 2);
    c.answer(false);
    check('Don\'t load: declined', again && (await again).err.code === TOOL_CODES.LOAD_DECLINED);
    // with the switch off, "Don't ask again" counts for nothing
    const q = outcome(c.decide('load_basic', {}, {}, how()));
    c.answer(true, { dontAsk: true });
    await q;
    check('with the switch off, Don\'t ask again is not remembered', c.loadNoAsk === false);
    // a load that cannot happen is refused before any card
    const bad = (() => { try { c.decide('load_basic', {}, {}, how({ load: () => { throw new Emu.ToolError(TOOL_CODES.NO_CONSENT); } })); return null; } catch (e) { return e; } })();
    check('the load summary is checked before the card', bad && asked.length === 3);
  }

  // ---- 3. the turn's abort clears a waiting card, STOPPED ----
  {
    const { c } = consent();
    const ac = new AbortController();
    const r = outcome(c.decide('poke', {}, {}, how({ signal: ac.signal })));
    check('a card waits', c.pending !== null);
    ac.abort();
    const res = await r;
    check('abort: the card is cleared and the call fails stopped', c.pending === null && !res.ok && res.err.code === TOOL_CODES.STOPPED && c.allowed === false);
    const ac2 = new AbortController(); ac2.abort();
    const r2 = await outcome(c.ask('poke', {}, { kind: 'consent' }, ac2.signal));
    check('a card asked on a turn already aborted ends STOPPED at once', r2.ok && r2.v === STOPPED && c.pending === null);
    const none = new Consent();
    const r3 = await outcome(none.decide('poke', {}, {}, how()));
    check('nobody to ask: no-consent, nothing pending', !r3.ok && r3.err.code === TOOL_CODES.NO_CONSENT && none.pending === null);
  }

  // ---- 4. turning the switch off refuses the card waiting ----
  {
    const { c } = consent();
    c.setAllowed(true);
    const r = outcome(c.decide('load_basic', {}, {}, how()));
    c.setAllowed(false);
    const res = await r;
    check('switch off while load_basic\'s card waits: declined, cleared', !res.ok && res.err.code === TOOL_CODES.LOAD_DECLINED && c.pending === null);
  }

  // ---- 5. a pause revoked by the switch refuses the call waiting on it ----
  {
    const { c } = consent();
    c.setAllowed(true);
    c.pause({ queue: [], stub: [] });
    check('pause: counted', c.paused !== null && c.pauses === 1);
    const w = outcome(c.wait());
    c.setAllowed(false);
    const p = c.resume();
    const res = await w;
    check('switch off during the pause, then Resume: the waiting call is refused no-consent', p && p.revoked === true && c.paused === null && !res.ok && res.err.code === TOOL_CODES.NO_CONSENT);
    c.setAllowed(true);
    c.pause({ queue: [], stub: [] });
    const w2 = outcome(c.wait());
    c.resume();
    check('a pause not revoked: Resume lets the call go on', (await w2).ok && c.pauses === 2);
    c.pause({ queue: [], stub: [] });
    const w3 = outcome(c.wait());
    c.endPause();
    const r3 = await w3;
    check('the pause ended (Stop, the turn\'s end): the waiting call is refused stopped', !r3.ok && r3.err.code === TOOL_CODES.STOPPED && c.paused === null);
    check('resume and endPause with no pause return null', c.resume() === null && c.endPause() === null);
  }

  // ---- 6. the re-check refuses a call that relied on a switch since turned off ----
  {
    const { c } = consent();
    c.setAllowed(true);
    const call = {};
    c.decide('poke', {}, call, how());
    check('re-check with the switch still on: nothing', call.consent === 'switch' && c.recheck('poke', call) === null);
    c.setAllowed(false);
    const r = (() => { try { c.recheck('poke', call); return null; } catch (e) { return e; } })();
    check('switch off: the re-check refuses no-consent', r && r.code === TOOL_CODES.NO_CONSENT);
    check('a call that relied on its own card still holds', c.recheck('poke', { consent: 'card' }) === null);
    c.setAllowed(true);
    check('load_basic relying on the switch needs Don\'t ask again too', (() => { try { c.recheck('load_basic', { consent: 'switch' }); return false; } catch (e) { return e.code === TOOL_CODES.NO_CONSENT; } })());
    c.pause({ queue: [], stub: [] });
    const w = c.recheck('poke', call);
    check('paused: the re-check waits', w && typeof w.then === 'function');
    c.resume(); await w;
  }

  // ---- the Session holds it as consent, with none of the old names ----
  const OLD = ['claudeAllowed', 'claudeGate', 'claudeLoadNoAsk', 'claudePending', 'claudePaused', 'claudePauses', 'setClaudeAllowed', 'answerClaude'];
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    check('the Session owns a Consent', s.consent instanceof Consent && s.consent.allowed === false && s.consent.pending === null);
    check('none of the old names is on the Session or its prototype', OLD.every((k) => !(k in s)), OLD.filter((k) => k in s).join());
    let changes = 0;
    s.on((ev) => { if (ev === 'chat') changes++; });
    s.consent.setAllowed(true);
    check('a consent change is the Session\'s \'chat\' event', changes === 1);
  }

  // ---- snapshots and settings exports: byte-identical to the fixtures from the commit before the move ----
  {
    const snapFix = fs.readFileSync(path.join(FIX, 'mid-chat.snapshot.json'), 'utf8');
    const setFix = fs.readFileSync(path.join(FIX, 'settings.json'), 'utf8');
    // the fixtures' own scenario (made with the old names at the parent commit), with consent given, a card
    // answered for a poke, Claude paused while typing
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64');
    s.setClaudeKey(KEY);
    s.store.set('keyboardMode', 'positional'); s.store.set('tapeSound', '0');
    for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const chat = s.startAsk({ backend: { send: async () => ({ text: '', stopReason: 'end_turn' }) } });
    s.consent.setAllowed(true);
    await chat.backend.runTool('poke', { address: 0x3000, bytes: [1, 2, 3] });
    chat.busy = true;
    s.typeTextPaced('10 PRINT 1\n', s.shownMachine);
    s.claudeActing = { name: 'type_text', input: { text: '10 PRINT 1\n' } };
    check('the scenario pauses Claude', s.pauseClaude() && s.consent.paused !== null);
    const snap = Emu.state.toJSON(s.shownMachine.snapshot());
    const set = JSON.stringify(s.exportSettings());
    check('the snapshot taken mid-chat is byte-identical to the parent commit\'s', snap === snapFix, `${snap.length} vs ${snapFix.length}`);
    check('the settings export is byte-identical to the parent commit\'s', set === setFix, set);
    // load and save back
    const back = Emu.state.toJSON(Emu.restoreSnapshot(Emu.state.fromJSON(snapFix), s.shownMachine.roms).snapshot());
    check('the fixture snapshot loads and saves back byte-identical', back === snapFix);
    const t = new Emu.Session({ store: Emu.memoryStore() });
    t.importSettings(setFix);
    check('the fixture settings import and export back byte-identical', JSON.stringify(t.exportSettings()) === setFix);
    // the key: nowhere in the consent state, the snapshot or the export
    const c = s.consent;
    const seen = JSON.stringify(c, (k, v) => (typeof v === 'function' ? undefined : v)) + JSON.stringify(Object.keys(c)) + JSON.stringify(c.paused && c.paused.held);
    check('the API key is not in the consent state', !seen.includes(KEY) && !seen.includes('sk-ant'));
    check('the API key is not in the snapshot or the export', !snap.includes(KEY) && !set.includes(KEY) && !snapFix.includes('sk-ant') && !setFix.includes('sk-ant'));
    s.stopClaude();
    await settle();
  }

  console.log(`\n${n - fail}/${n} consent checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
