// Run: node tests/chat-hooks.test.js
//
// The hooks a Session sets on its ChatSession (Session.gateTools), in place of replacing the chat's own methods:
//  * the consent gate (chat.gate) refusing an acting tool: the call fails, the machine is unchanged, and the
//    tool-call hooks (onToolStart, onToolEnd) still bracket it, so the page's "Using poke…" status clears;
//  * abort ordering: onAbort runs before the request is aborted, so the Session's pause has ended by the time the
//    turn's abort signal fires (an action waiting on the pause is refused, never run);
//  * the hooks survive install() (the chat's full-screen and BASIC views) and a machine change (adopt drops the
//    chat; the next chat is hooked afresh, and the old chat's hooks no longer touch the Session);
//  * no patched properties: abort, runTool and serveTool are the prototype's own, and the backend's runTool is the
//    one the ChatSession gave it.
// The backends are plain objects (no fetch): these tests drive backend.runTool as the real backend would.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const settle = () => new Promise((r) => setTimeout(r, 10));
const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
const KEY = 'sk-ant-HOOKS-TEST-KEY-0123456789';
const proto = Emu.ChatSession.prototype;
const backend = () => ({ send: async () => ({ text: '', stopReason: 'end_turn' }) });
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err }));
// nothing on the chat object shadows the class's methods
const unpatched = (chat) => ['abort', 'runTool', 'serveTool', 'callTool'].every((k) => !Object.hasOwn(chat, k) && chat[k] === proto[k]);
// the Session's hooks are set on this chat
const hooked = (chat) => ['onAbort', 'onToolStart', 'onToolEnd', 'onTurnEnd', 'gate', 'recheck'].every((k) => Object.hasOwn(chat, k) && typeof chat[k] === 'function')
  && chat.gate !== Emu.ChatSession.prototype.gate;

function session(machine = 'dragon64') {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(machine);
  s.setClaudeKey(KEY);
  return s;
}

(async () => {
  // ---- a bare ChatSession: the hooks are plain properties, called by the class ----
  {
    const b = backend();
    const chat = new Emu.ChatSession({ backend: b });
    const viaBackend = b.runTool;
    check('a bare chat has no hooks, and its methods are the prototype\'s', chat.onAbort === null && chat.onToolStart === null && chat.onToolEnd === null && unpatched(chat));
    // abort with no hook and no request is harmless; with a hook it runs first, before the signal
    chat.abort();
    const order = [];
    chat.onAbort = (reason) => order.push(`hook:${reason}:${chat.controller.signal.aborted}`);
    chat.controller = new AbortController();
    chat.controller.signal.addEventListener('abort', () => order.push('signal'));
    chat.abort('why');
    check('abort: onAbort runs before the request is aborted, with the reason', order.join(',') === 'hook:why:false,signal' && chat.abortReason === 'why', order.join(','));
    // abort with no request in flight still tells the hook (a Stop between turns ends a pause too)
    chat.controller = null;
    const idle = [];
    chat.onAbort = (reason) => idle.push(reason);
    chat.abort('idle');
    check('abort with nothing in flight still calls onAbort', idle.join(',') === 'idle', idle.join(','));
    // tool hooks bracket every call the backend makes, refused or not
    const seen = [];
    chat.onToolStart = (name) => seen.push(`start:${name}`);
    chat.onToolEnd = (name) => seen.push(`end:${name}`);
    const r = await call(chat, 'poke', { address: 0x3000, bytes: [1] });
    check('a bare chat refuses an acting tool (no target, no consent) and the tool hooks bracket the call', !r.ok && r.err.code === Emu.TOOL_CODES.NO_CONSENT && seen.join(',') === 'start:poke,end:poke', seen.join(','));
    check('the backend\'s runTool is the one the ChatSession gave it', b.runTool === viaBackend && unpatched(chat));
  }

  // ---- the Session's gate refusing a tool (Ask Claude, the person declines the card) ----
  {
    const s = session();
    const m = s.shownMachine;
    const chat = s.startAsk({ backend: backend() });
    check('startAsk: the Session\'s hooks are set, nothing is patched', hooked(chat) && unpatched(chat));
    const during = [];
    s.claudeGate = (name) => { during.push(s.claudeTool); s.claudePending.resolve(false); };
    const before = m.ram[0x3000];
    const r = await call(chat, 'poke', { address: 0x3000, bytes: [(before + 1) & 0xff] });
    check('the gate refuses: the call fails declined and changes nothing', !r.ok && r.err.code === Emu.TOOL_CODES.CONSENT_DECLINED && m.ram[0x3000] === before, r.err && r.err.code);
    check('the gate was asked while the tool ran (claudeTool), and the status cleared after', during.length === 1 && during[0] === 'poke' && s.claudeTool === null && s.claudeCall === null);
    // nobody to ask: no consent
    s.claudeGate = null;
    const r2 = await call(chat, 'poke', { address: 0x3000, bytes: [9] });
    check('no page to ask: refused no-consent, unchanged', !r2.ok && r2.err.code === Emu.TOOL_CODES.NO_CONSENT && m.ram[0x3000] === before);
    // allowed: the same path acts
    s.setClaudeAllowed(true);
    const r3 = await call(chat, 'poke', { address: 0x3000, bytes: [9] });
    check('allowed: the call acts through the same hooks', r3.ok && m.ram[0x3000] === 9 && s.claudeTool === null);
    // onToolStart tells the page at once: a 'chat' event with the tool's name, while the call is still held (here, by
    // a card nobody has answered yet) and before the card itself is raised (claudePending, which emits on its own)
    s.setClaudeAllowed(false);
    let release = null;
    s.claudeGate = () => { release = () => s.claudePending.resolve(true); };
    const events = [];
    const off = s.on((ev) => { if (ev === 'chat') events.push({ tool: s.claudeTool, card: !!s.claudePending, done: settled }); });
    let settled = false;
    const held = call(chat, 'poke', { address: 0x3001, bytes: [3] }).then((res) => { settled = true; return res; });
    await settle();
    check('a tool start emits \'chat\' with claudeTool set, before the card and before the tool resolves',
      events.length > 0 && events[0].tool === 'poke' && !events[0].card && !events[0].done && !settled, JSON.stringify(events));
    release();
    const r4 = await held;
    off();
    check('the held call then acts, and its end emits \'chat\' with the status cleared', r4.ok && m.ram[0x3001] === 3
      && events.length >= 2 && events[events.length - 1].tool === null, JSON.stringify(events));
  }

  // ---- abort ordering through the Session: the pause ends before the request is aborted ----
  {
    const s = session();
    const m = s.shownMachine;
    const chat = s.startAsk({ backend: backend() });
    s.setClaudeAllowed(true);
    chat.busy = true;
    s.claudeActing = { name: 'type_text', input: { text: 'x' } };
    check('paused', s.pauseClaude() && s.claudePaused !== null);
    const waiting = call(chat, 'poke', { address: 0x3002, bytes: [7] });
    await settle();
    chat.controller = new AbortController();
    let pausedAtSignal = 'unset';
    chat.controller.signal.addEventListener('abort', () => { pausedAtSignal = s.claudePaused; });
    chat.abort('Stop');
    const r = await waiting;
    check('abort: the Session ended the pause before the request was aborted', pausedAtSignal === null, String(pausedAtSignal));
    check('abort: the action waiting on the pause is refused stopped, nothing changed', !r.ok && r.err.code === Emu.TOOL_CODES.STOPPED && m.ram[0x3002] !== 7, r.err && r.err.code);
    chat.busy = false;
    check('still no patched properties after an abort', unpatched(chat));
  }

  // ---- the hooks survive install() (the chat's two views) and a machine change (adopt) ----
  {
    const s = session();
    const chat = s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: 'B', tools: true });
    const basic = s.chatMachines.basic;
    check('startChat: hooked, nothing patched', hooked(chat) && unpatched(chat));
    const hooks = { onAbort: chat.onAbort, onToolStart: chat.onToolStart, onToolEnd: chat.onToolEnd, gate: chat.gate };
    check('install: the BASIC view and back', s.showChat('basic') && s.shownMachine === basic && s.showChat('chat'));
    check('install: the chat keeps the same hooks', Object.entries(hooks).every(([k, f]) => chat[k] === f) && unpatched(chat));
    s.claudeGate = null;
    s.setClaudeAllowed(true);
    const r = await call(chat, 'poke', { address: 0x3004, bytes: [0x42] });
    check('install: a tool call still goes through the hooks and acts on the BASIC session', r.ok && basic.ram[0x3004] === 0x42 && s.claudeTool === null);
    // a pause still ends on abort after the views moved
    chat.busy = true;
    s.claudeActing = { name: 'type_text', input: { text: 'x' } };
    s.pauseClaude();
    chat.abort();
    check('install: abort still ends the pause', s.claudePaused === null);
    chat.busy = false;
    // adopt (a machine switch) drops the chat; the next one is hooked afresh
    s.switchMachine('coco');
    check('adopt: the chat is dropped', s.chat === null);
    const chat2 = s.startChat({ backend: backend(), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: 'B', tools: true });
    check('adopt: the next chat is hooked, nothing patched', chat2 !== chat && hooked(chat2) && unpatched(chat2) && chat2.onToolStart !== chat.onToolStart);
    s.setClaudeAllowed(true);
    const basic2 = s.chatMachines.basic;
    const r2 = await call(chat2, 'poke', { address: 0x3006, bytes: [0x24] });
    check('adopt: the new chat\'s tools act through its hooks', r2.ok && basic2.ram[0x3006] === 0x24 && s.claudeTool === null);
    // the old chat's hooks no longer touch the Session
    s.claudeTool = 'mine';
    chat.onToolEnd('mine');
    chat2.busy = true;
    s.claudeActing = { name: 'type_text', input: { text: 'x' } };
    s.pauseClaude();
    chat.onAbort();
    check('adopt: the dropped chat\'s hooks leave the new chat\'s state alone', s.claudeTool === 'mine' && s.claudePaused !== null);
    chat2.abort();
    check('adopt: the new chat\'s abort ends its pause', s.claudePaused === null);
    chat2.busy = false;
    // Ask Claude after a switch: the same
    s.endChat();
    s.switchMachine('dragon64');
    const ask = s.startAsk({ backend: backend() });
    check('adopt: Ask Claude after a switch is hooked, nothing patched', hooked(ask) && unpatched(ask));
  }

  console.log(`\n${n - fail}/${n} chat hook checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
