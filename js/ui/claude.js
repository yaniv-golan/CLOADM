/*
 * Claude in the emulator: one conversation, two views.
 *   - Ask Claude, the side panel beside the live machine (js/ui/ask.js; a bottom sheet on a phone);
 *   - Chat with Claude, full screen (this module): the machine itself becomes Claude. A second
 *     machine of the same model runs the chat firmware (examples/chat.bin) on screen; the BASIC session stays
 *     live beside it, in the picture-in-picture (a strip under the screen on a phone); Ctrl+B or "Show my BASIC
 *     session" swaps them.
 * The Side panel / Full screen switch moves the same conversation between them (Session.startChat and
 * Session.toSidePanel). This module is the controller both views use: the backend (js/claude/backend.js on the
 * browser's fetch, with the key from the host key store), the brief, the key, the consent question
 * (Session.claudeGate), Stop, the restore points, and the state the views draw: the reply streaming in, the
 * activity log, and the API key state with its text (the same texts in both views).
 * The key is saved only in this browser (cloadm.anthropicKey, js/host/key-store.js), never in the machine, a
 * snapshot, a share link or a settings export.
 */
import { ClaudeBackend } from '../claude/backend.js';
import { claudeBrief } from '../claude/brief.js';
import { MemoryChannel } from '../claude/channel.js';
import { exampleReader } from '../host/example-reader.js';
import { ACTING_TOOL_NAMES } from '../claude/chat.js';
import { CanvasPresenter } from '../video/canvas.js';
import { $, ESC, VIEWS, viewOpen } from './page.js';

const FIRMWARE_URL = 'examples/chat.bin';
// the tools that change the BASIC session (the rest only read), from the one list in js/claude/chat.js
const ACTING = new Set(ACTING_TOOL_NAMES);
// Claude's INCLUDE lines read from the same-origin examples/ folder only (js/host/example-reader.js)
const include = exampleReader();

// The line a person sees for a failed tool: the remedy for a coded error (its .tool.remedy), else its short
// message. Never the JSON the model received and never String(result) - a person reads a line on screen, not a
// blob. At module scope so a test can pin that, including that a String() regression fails it.
export function failureText(value) {
  const tool = value && value.tool;
  if (tool && tool.remedy) return tool.remedy;
  return String((value && value.message) || value || 'failed').slice(0, 80);
}

// the API key states and their texts ("API key states")
export const KEY_TEXT = Object.freeze({
  refused: '[The API key was refused: check it and try again.]',
  'rate-limited': 'Your API account is rate limited. Nothing retries in the background; send again when you\'re ready.',
  offline: 'Could not reach Claude. Check your connection.',
});
// what the activity log says for a tool call
const LOG = {
  type_text: (i) => { const n = String(i.text || '').split('\n').filter((l) => l.trim()).length; return `✓ typed ${n === 1 ? `"${String(i.text).trim()}"` : `${n} lines`}`; },
  poke: (i) => `✓ poked ${(i.bytes || []).length} byte(s) at $${(i.address || 0).toString(16).toUpperCase()}`,
  load_basic: (i) => { const n = String(i.program || '').split('\n').filter((l) => l.trim()).length; return `✓ loaded a ${n}-line BASIC program`; },
  press_break: () => '✓ pressed BREAK',
  assemble_and_load: (i) => `✓ assembled and loaded${i.org != null ? ` at $${Number(i.org).toString(16).toUpperCase()}` : ''}`,
  run: (i) => `✓ ran ${i.target == null ? 'RUN' : typeof i.target === 'number' ? `$${i.target.toString(16).toUpperCase()}` : i.target}`,
  screen_text: () => '· read the screen',
  peek: (i) => `· read memory at $${(i.address || 0).toString(16).toUpperCase()}`,
  machine_info: () => '· looked at the machine',
};

// what load_basic's card says about the load it asks for (Session.claudePending.load)
export function loadCardText(load) {
  const span = load.lines === 1 ? `line ${load.first}` : `lines ${load.first} to ${load.last}`;
  return `Claude wants to load a ${load.lines}-line BASIC program (${span}, ${load.bytes} bytes) into your BASIC session. It replaces the program in memory; a restore point is made first, so Undo brings yours back.`;
}

export function setupClaude(page) {
  const { session } = page;
  // what the views draw besides the conversation itself
  const state = {
    text: '',          // the reply streaming in
    log: [],           // this turn's activity
    asked: null,       // the last line asked (Try again sends it once more)
    context: null,     // what the question is about: null (the screen and the program) | { code: address } (the Debugger)
    failed: null,      // a line whose turn ended in an error (shown with the error until the next one)
    stopped: false,    // the last turn was stopped
    view: 'panel',     // the last view used this visit
    pip: false,        // full screen: the BASIC session's corner window is shown (hidden until Claude acts or Ctrl+B)
  };
  const listeners = new Set();
  const notify = () => { for (const f of listeners) f(); };
  // the phone layouts of the chat: portrait up to 700 px wide, or held sideways up to 500 px high
  const phoneQuery = matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  const phoneLayout = () => phoneQuery.matches;
  session.on((ev) => { if (ev === 'chat' || ev === 'machine' || ev === 'roms') notify(); });
  // the page asks; Session.answerClaude gives the answer (the views draw Session.claudePending)
  session.claudeGate = () => notify();

  const basicMachine = () => (session.chatMachines ? session.chatMachines.basic : session.machine);
  const brief = () => {
    const m = basicMachine();
    return claudeBrief({ machine: m.profile.name, ram: m.config.ram, cpu: m.config.cpu, hasBasic: m.hasRom && !session.nitros9On(m), edition: 'cloadm.dev', tools: true });
  };
  const backend = () => new ClaudeBackend({ fetch: (url, init) => fetch(url, init), apiKey: session.keyStore.get() || '' });
  function wire(chat) {
    // the restore point is logged when it is made, before the tool ends: a paced type_text runs until the machine
    // has read every key, and the person should see the restore point while it types
    const notePoint = () => {
      if (chat.undo.length > (state.points || 0)) state.log.push('✓ restore point made');
      state.points = chat.undo.length;
    };
    chat.onChange = () => { notePoint(); session.emit('chat'); };
    chat.onText = (t) => {
      if (!chat.busy || /^\r?\n\[.*\]\r?\n$/s.test(t)) return;   // status lines are the views' own
      state.text += t; notify();
    };
    chat.onToolUse = (name, input, result, isError, value) => {
      // Claude acting in full screen shows the BASIC session's window (and it stays until the person hides it)
      if (ACTING.has(name) && session.claudeView === 'full') state.pip = true;
      notePoint();
      // a coded failure shows its REMEDY, not the JSON the model received: a person reads the line on screen
      state.log.push(isError ? `✗ ${name}: ${failureText(value)}` : (LOG[name] || (() => `· ${name}`))(input || {}));
      notify();
    };
  }
  // the line a person sees for a failed tool is failureText at module scope (pure, and a test pins it)
  // the conversation, started in the side panel if there is none yet
  function ensure() {
    if (!session.chat) { wire(session.startAsk({ backend: backend(), brief: brief(), include })); state.log = []; }
    return session.chat;
  }
  // one line to Claude from either view's box (the firmware's own lines come through its channel)
  async function ask(text, { context = null } = {}) {
    const chat = ensure();
    text = String(text || '').trim();
    if (!text || chat.busy) return null;
    chat.brief = brief();
    Object.assign(state, { text: '', log: [], asked: text, failed: null, stopped: false, points: chat.undo.length, context });
    session.claudeActing = null;
    notify();
    const res = await chat.sendLine(text);
    if (!res && chat.error) {
      if (chat.error.code === 'aborted') state.stopped = true; else state.failed = text;
    }
    state.text = '';
    notify();
    return res;
  }
  const retry = () => (state.asked ? ask(state.asked, { context: state.context }) : null);
  // the Debugger's opener ("From the Debugger"): the code at the program counter and the
  // registers go with the question, so Claude reads exactly what is there
  function askAboutCode(addr) {
    const code = session.codeAt(addr);
    const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');
    openPanel();
    return ask(`What is this code doing? (${hex(code.from)}–${hex(code.to)})\n\n${code.text}\n\n${code.registers}`, { context: { code: code.from } });
  }
  function stop() { session.stopClaude(); state.stopped = true; notify(); }
  // the API key state: none | saved | refused | rate-limited | offline | error (another failure, its own text)
  function keyState() {
    if (!session.hasClaudeKey) return 'none';
    const e = session.chat && session.chat.error;
    if (!e || e.code === 'aborted') return 'saved';
    return { 'invalid-key': 'refused', 'rate-limited': 'rate-limited', network: 'offline', 'no-key': 'none' }[e.code] || 'error';
  }
  const keyText = (k) => KEY_TEXT[k] || (k === 'error' && session.chat && session.chat.error ? session.chat.error.message : '');
  function saveKey(value) {
    if (!String(value || '').trim()) throw new Error('Paste your API key first (it starts sk-ant-).');
    session.setClaudeKey(value);
    if (session.chat && session.chat.error && ['invalid-key', 'no-key'].includes(session.chat.error.code)) session.chat.error = null;
    notify();
  }
  function forgetKey() { session.clearClaudeKey(); notify(); }
  // what Claude is doing on the machine now, for the pill: "Claude is typing line 120…"
  function activity() {
    const a = session.claudeActing;
    if (!a || !session.claudeBusyActing) return null;
    if (session.claudePaused) return 'Paused: you pressed a key';
    if (a.name === 'type_text') {
      const m = basicMachine(), all = String(a.input.text || '');
      // the keys not yet pressed: Claude's typing waits in the typist's queue, one paced key at a time
      const left = m.typist.queue.filter((c) => c && c.paced !== undefined).length;
      const at = Math.max(0, Math.min(all.length - 1, all.length - left));
      const line = all.slice(all.lastIndexOf('\n', at - 1) + 1).split('\n')[0];
      const n = /^\s*(\d+)/.exec(line);
      return n ? `Claude is typing line ${n[1]}…` : 'Claude is typing…';
    }
    if (a.name === 'poke') return 'Claude is changing memory…';
    if (a.name === 'press_break') return 'Claude pressed BREAK…';
    if (a.name === 'assemble_and_load' || a.name === 'load_basic') return 'Claude is loading a program…';
    if (a.name === 'run') return 'Claude is starting a program…';
    return 'Claude is using the machine…';
  }

  // ---------------- the views ----------------
  let panel = null;   // js/ui/ask.js registers itself: { open, close, shown }
  function openPanel(question) {
    ensure();
    if (session.claudeView === 'full') closeFull({ toPanel: true });
    state.view = 'panel';
    if (panel) panel.open();
    if (question) ask(question);
  }
  // Chat with Claude, full screen: the chat machine on screen, the conversation (if any) moved to it
  let opening = null;
  async function openFull() {
    panelOnReturn = false;
    if (session.claudeView === 'full') { session.showChat('chat'); show(true); return session.chat; }
    if (opening) return opening;
    opening = (async () => {
      if (session.machine.config.cpu !== '6809') {
        if (session.chat) session.endChat();
        page.status(`The chat firmware needs a 6809, so the chat opens on a Dragon 64 (the ${session.machine.profile.name} has a ${session.machine.config.cpu}).`);
        session.switchMachine('dragon64');
      }
      const firmware = await page.fetchBytes(FIRMWARE_URL);
      // a machine with the Becker port on talks to the chat over DriveWire, as a real one would; otherwise the
      // firmware's mailbox carries it
      const drivewire = !!session.machine.config.becker;
      const had = session.chat;
      const chat = session.startChat({ backend: had ? had.backend : backend(), channel: drivewire ? undefined : new MemoryChannel(), firmware, brief: brief(), drivewire, include });
      if (chat !== had) { wire(chat); state.log = []; }
      state.view = 'full';
      state.pip = false;                  // the chat screen is the chat only, until Claude acts or Ctrl+B
      if (panel) panel.close({ keep: true });
      show(true);
      page.status('Chat with Claude: type on the screen and press ENTER.');
      page.focus();
      // without a key the key card comes first where the page stacks (a phone or a tablet), so the page starts at the
      // top rather than at the screen
      if (document.body.classList.contains('claude-nokey')) scrollTo(0, 0);
      return chat;
    })();
    try { return await opening; } catch (e) { page.status(`Chat: ${e.message}`, true); return null; } finally { opening = null; }
  }
  // leave full screen: to the side panel with the same conversation, or close the conversation
  function closeFull({ toPanel = false } = {}) {
    if (toPanel) session.toSidePanel(); else session.endChat();
    show(false);
    if (toPanel && panel) panel.open();
    page.focus();
  }
  // close the view (the panel's ✕, "← Emulator"): the conversation stays for the visit, so either view opens on it
  // again; a machine switch ends it
  function close() {
    if (session.claudeView === 'full') { session.toSidePanel(); show(false); }
    if (panel) panel.close();
    page.focus();
  }
  function show(on) {
    document.body.classList.toggle('claude-open', on);
    $('claude').hidden = !on;
    $('claudeBar').hidden = !on;
    $('claudeViewRow').hidden = !on;
    // the address says what is open, so a reload or a copied link opens the same. Opening the chat is one step in
    // the page's history (page.openStep): the browser's Back closes it (the app bar is hidden in the phone layout; Ctrl K still reaches the views), and
    // a view it replaces (a link to ?app=claude#debugger) closes
    const u = new URL(location.href);
    if (on) { u.searchParams.set('app', 'claude'); if (VIEWS.includes(u.hash)) u.hash = ''; } else u.searchParams.delete('app');
    if (on) opened = true;
    if (on && !page.onStep('claudeChat')) page.openStep({ claudeChat: true }, u.href);
    else if (u.href !== location.href) history.replaceState(history.state, '', u.href);
    render();
  }
  // the chat's history step: when it is no longer the current entry (Back, a view opened over the chat replacing it,
  // "← Emulator"), the full-screen chat closes. An entry an earlier load of the page left (history.state outlives a
  // reload) is not this load's step, so stepping back onto it leaves the chat too.
  // Landing off the step (Back to the entry the page was loaded on, still ?app=claude), the address drops app=claude
  // too, so a reload there opens what is shown; before the chat has first opened the link's app=claude is still to come.
  let opened = false;
  // A view opened over the full-screen chat moves the conversation to the side panel, which stays closed while the view
  // is up (the view has the page). Coming back to the emulator reopens the panel on the same conversation, however the
  // view closes ("← Emulator", Esc, Back), so a pending question, a streaming reply or Claude acting is there to see.
  // A view opened from the plain emulator never sets this.
  let panelOnReturn = false;
  page.onView(() => {
    if (page.onStep('claudeChat')) return;
    if (document.body.classList.contains('claude-open')) { const byView = viewOpen(); close(); if (byView) panelOnReturn = true; }
    else if (opened && new URL(location.href).searchParams.get('app') === 'claude') show(false);
  }, { every: true });
  page.onView(() => {
    if (viewOpen() || !panelOnReturn) return;
    panelOnReturn = false;
    if (session.chat && session.claudeView !== 'full') openPanel();
  });
  // "← Emulator" (and Esc) take the chat's step back, so no stale step is left behind
  const leave = () => page.toEmulator();
  $('btnClaudeBack').onclick = () => leave();
  // Esc off the screen leaves the full-screen chat the way "← Emulator" does, taking the history step back (the page's
  // one Esc path, page.onEscape); on the screen Esc is the machine's BREAK and stops a reply
  page.onEscape(ESC.chat, () => session.claudeView === 'full', leave);
  $('btnFullSide').onclick = () => closeFull({ toPanel: true });
  $('btnFullFull').onclick = () => {};

  // ---------------- the key (full screen) ----------------
  $('btnClaudeKeySave').onclick = () => {
    const input = $('claudeKeyInput');
    try { saveKey(input.value); input.value = ''; $('claudeKeyMsg').textContent = ''; editingKey = false; }
    catch (e) { $('claudeKeyMsg').textContent = e.message; render(); return; }
    render();
    // the key is in: typing goes to the chat at once (the focus was left on the page)
    if (session.claudeView === 'full') page.focus();
  };
  $('claudeKeyInput').onkeydown = (e) => { if (e.key === 'Enter') $('btnClaudeKeySave').click(); };
  let editingKey = false;
  $('btnClaudeKeyChange').onclick = () => { editingKey = true; render(); $('claudeKeyInput').focus(); };
  $('btnClaudeKeyForget').onclick = () => { forgetKey(); $('claudeKeyInput').value = ''; render(); };

  // ---------------- the BASIC session (full screen) ----------------
  $('chkClaudeTools').onchange = () => session.setClaudeAllowed($('chkClaudeTools').checked);
  $('btnClaudeAllow').onclick = () => session.answerClaude(true);
  $('btnClaudeTell').onclick = () => session.answerClaude(false);
  $('btnClaudeLoad').onclick = () => session.answerClaude(true, { dontAsk: $('chkClaudeLoadNoAsk').checked });
  $('btnClaudeLoadNo').onclick = () => session.answerClaude(false);
  $('btnClaudeUndo').onclick = () => { if (session.restoreClaude()) page.status('Restored: your BASIC session is as it was before Claude\'s changes.'); };
  // Ctrl+B, "Show my BASIC session" and a click on the window swap the views; swapping to the BASIC session shows the
  // window (the chat in it), swapping back hides it. Its close button hides it (and brings the chat back).
  function swap() {
    if (!session.chatMachines) return;
    if (session.chatView === 'chat') { state.pip = true; session.showChat('basic'); } else { session.showChat('chat'); state.pip = false; }
    notify(); page.focus();
  }
  function hidePip() { state.pip = false; if (session.chatView === 'basic') session.showChat('chat'); notify(); page.focus(); }
  $('btnClaudeView').onclick = swap;
  $('claudePipSwap').onclick = swap;
  $('btnPipClose').onclick = hidePip;
  $('btnPipStop').onclick = (e) => { e.stopPropagation(); stop(); };
  addEventListener('keydown', (e) => {
    // Ctrl+B swaps the chat and the BASIC session
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'b' || e.key === 'B') && session.chatMachines) { e.preventDefault(); e.stopPropagation(); swap(); return; }
    // BREAK (Esc on the screen) while a reply streams stops it; the firmware gets its BREAK too and gives a fresh
    // prompt. Off the screen Esc leaves the full screen instead (page.onEscape) and the reply goes on.
    if (e.key === 'Escape' && e.target === $('screen') && !page.escapable(true) && session.chat && session.chat.busy && session.chatView === 'chat') session.chat.abort();
  }, true);
  // a machine switch from the menu closes the chat
  session.on((ev) => { if (ev === 'machine' && !session.chat && document.body.classList.contains('claude-open')) show(false); });

  // the picture-in-picture: the machine off screen, drawn each frame while full screen is open
  const pip = new CanvasPresenter($('claudePipCanvas'));
  page.onFrame(() => {
    if (!session.chatMachines) return;
    const other = session.besideMachine();
    if (other) pip.present(other.render());
    renderActivity();
  });
  function renderActivity() {
    const busy = session.claudeBusyActing, text = activity();
    const basicOff = session.chatMachines && session.chatView === 'chat';
    $('claudePip').classList.toggle('acting', !!busy && basicOff);
    $('claudePipActing').hidden = !(busy && session.claudeView === 'full');
    if (busy && session.claudeView === 'full') $('claudePipActingText').textContent = basicOff ? 'Claude is typing in your BASIC session' : (text || 'Claude is using the machine');
  }

  function render() {
    if (!session.machine) return;         // (the page has no machine until it starts)
    const chat = session.chat, k = keyState(), full = session.claudeView === 'full';
    // the chat machine on the big screen: the page hides what is about BASIC (its key hint, the no-ROMs pill and card)
    document.body.classList.toggle('chat-screen', document.body.classList.contains('claude-open') && session.chatView === 'chat');
    // the key: the form (no key, refused, or Change), else one quiet line
    const form = k === 'none' || k === 'refused' || editingKey;
    $('claudeKeyCard').hidden = !form;
    $('claudeKeyCard').classList.toggle('refused', k === 'refused');
    $('claudeKeySaved').hidden = form;
    $('claudeKeyTag').textContent = 'Saved in this browser.';
    // a phone (body.chat-phone, play/index.html): the screen takes the room, its border cut off; without a key the
    // key card comes first and the machine keyboard stands aside for the phone's own
    const phoneChat = full && phoneLayout();
    document.body.classList.toggle('chat-phone', phoneChat);
    document.body.classList.toggle('claude-nokey', full && form);
    page.cropBorder = phoneChat && session.chatView === 'chat';
    if (page.touchKeys) page.touchKeys.standAside(phoneChat && form);
    // the on-screen keyboard's Menu leads out of the chat there (the app bar and its menu give way to the chat bar,
    // which the keyboard covers when the phone is held sideways)
    $('tkMenu').textContent = phoneChat ? '← Emulator' : 'Menu';
    // the help line: the key state's text (in brackets on the chat screen too, from the firmware)
    const help = chat && chat.busy ? 'Claude is thinking (it can take a minute). BREAK stops the reply.' : k === 'none' ? `[No API key yet: add one ${whereKey()}.]` : keyText(k);
    $('claudeHelp').textContent = help;
    $('claudeHelp').hidden = !help;
    // the BASIC session card: consent, the switch, the restore point
    const pend = session.claudePending;
    const loading = !!(pend && pend.kind === 'load');      // load_basic's own card, on every call
    const asking = !!pend && !loading;                     // the consent question
    $('claudeSession').classList.toggle('asking', !!pend);
    $('claudeConsentText').textContent = asking
      ? 'Claude wants to type into your BASIC session. With permission it can type, POKE, run and press BREAK. You can watch it in the corner of the screen, Stop it, and Undo everything: a restore point is made first.'
      : 'Claude reads it any time (screen and program). Typing, POKEs and running need your permission; loading a BASIC program asks every time (with the switch on, its card offers Don\'t ask again this session).';
    $('claudeConsentAsk').hidden = !asking;
    $('claudeLoad').hidden = !loading;
    if (loading) $('claudeLoadText').textContent = loadCardText(pend.load);
    else $('chkClaudeLoadNoAsk').checked = false;
    // "Don't ask again this session" only while the switch is on: with it off every load asks, so the box is not offered
    $('chkClaudeLoadNoAsk').closest('label').hidden = !session.claudeAllowed;
    if (!session.claudeAllowed) $('chkClaudeLoadNoAsk').checked = false;
    $('chkClaudeTools').checked = session.claudeAllowed;
    const points = session.claudePoints;
    $('claudeRestore').hidden = !points.length;
    if (points.length) $('claudeRestoreWhen').textContent = `Restore point · ${when(points[0].at)}, before Claude's changes`;
    const basic = session.chatMachines && session.chatMachines.basic;
    $('claudeSpec').textContent = basic ? `${basic.profile.name.replace(/^Tandy /, '')} · chat firmware, no ROM needed` : '';
    $('claudeBasicNote').textContent = basic && !basic.hasRom
      ? 'Your BASIC session has no BASIC ROMs, so it runs without ROMs: Claude can read and change memory, but BASIC programs need your ROMs.' : '';
    // the swap and the picture-in-picture
    const peeking = session.chatView === 'basic';
    $('claudePip').hidden = !full || !state.pip;
    // a strip under the screen at every width, never over the chat's text
    const tap = matchMedia('(max-width: 700px)').matches ? 'tap' : 'click';
    $('claudePipLabel').textContent = peeking ? 'Back to the chat' : 'Your BASIC session';
    $('claudePipSub').textContent = session.claudeBusyActing ? 'Claude is typing…' : peeking ? `Live chat · ${tap} to swap back` : `Live · ${tap} to show it`;
    $('btnClaudeView').textContent = peeking ? 'Back to the chat' : 'Show my BASIC session';
    $('btnClaudeView').classList.toggle('primary', peeking);
    renderActivity();
  }
  phoneQuery.addEventListener('change', () => render());
  // where the key card is, seen from the screen: the words follow the layout ("on the right" beside the screen on a
  // wide page, "above" on a phone, where it comes first)
  function whereKey() {
    const c = $('claudeKeyCard').getBoundingClientRect(), s = $('screen').getBoundingClientRect();
    if (!c.width || !s.width) return 'on the right';
    if (c.left >= s.right - 1) return 'on the right';
    if (c.bottom <= s.top + 1) return 'above';
    if (c.top >= s.bottom - 1) return 'below';
    return 'on the right';
  }
  listeners.add(render);
  render();

  return {
    // the views (ask.js, the Ctrl K box, the welcome menu, ?app=claude)
    openPanel, openFull, closeFull, close, open: openFull,
    // the conversation
    ask, retry, stop, ensure, state, askAboutCode, keyState, keyText, saveKey, forgetKey, activity,
    onChange: (f) => listeners.add(f), notify,
    registerPanel: (p) => { panel = p; },
  };
}

// "14:02"
export const when = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 5) : 'earlier');
