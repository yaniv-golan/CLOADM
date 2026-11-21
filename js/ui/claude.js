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
 * (Session.claudeGate), Stop, the restore points, and the state the views draw: the reply streaming in, and the
 * API key state with its text (the same texts in both views). What Claude did and the restore line are drawn from
 * the conversation itself (js/ui/claude-lines.js).
 * The key is saved only in this browser (cloadm.anthropicKey, js/host/key-store.js), never in the machine, a
 * snapshot, a share link or a settings export.
 */
import { ClaudeBackend } from '../claude/backend.js';
import { claudeBrief } from '../claude/brief.js';
import { MemoryChannel } from '../claude/channel.js';
import { exampleReader } from '../host/example-reader.js';
import { ACTING_TOOL_NAMES } from '../claude/chat.js';
import { CLAUDE_PAUSED_TEXT } from '../session.js';
import { CanvasPresenter } from '../video/canvas.js';
import { cpuFamily } from '../cpu/cpus.js';
import { $, ESC, VIEWS, viewOpen, markUndrawn } from './page.js';
import { chatTurns } from '../claude/history.js';
import { actionLines, restoreLine } from './claude-lines.js';

const FIRMWARE_URL = 'examples/chat.bin';
// the tools that change the BASIC session (the rest only read), from the one list in js/claude/chat.js
const ACTING = new Set(ACTING_TOOL_NAMES);
// Claude's INCLUDE lines read from the same-origin examples/ folder only (js/host/example-reader.js)
const include = exampleReader();

// the API key states and their texts ("API key states")
export const KEY_TEXT = Object.freeze({
  refused: '[The API key was refused: check it and try again.]',
  'rate-limited': 'Your API account is rate limited. Nothing retries in the background; send again when you\'re ready.',
  offline: 'Could not reach Claude. Check your connection.',
});

// UX ruling R11: while Claude is paused (the person's key), a card's accept button gives consent and resumes in one
// click. The card says so in a line of its own; the decline button is unchanged and never resumes.
export const PAUSED_CARD_TEXT = Object.freeze({
  consent: 'Paused because you pressed a key. Allow and resume lets Claude go on and act on the machine for the rest of this session.',
  load: 'Paused because you pressed a key. Load and resume loads the program and lets Claude go on.',
});
// Draw a card's accept button for the pause as it is now: its label, and what a click on it will do (data-resume),
// so the click does what the button said when it was drawn, never what claudePaused says at click time
export function drawAccept(button, paused, plain, resumeLabel) {
  button.textContent = paused ? resumeLabel : plain;
  button.dataset.resume = paused ? '1' : '';
}
// the click on a card's accept button: yes, and Resume too only if the button read "… and resume" (drawAccept)
export const acceptClick = (session, button, opts = {}) => session.answerClaude(true, { ...opts, resume: button.dataset.resume === '1' });

// what load_basic's card says about the load it asks for (Session.claudePending.load)
export function loadCardText(load) {
  const span = load.lines === 1 ? `line ${load.first}` : `lines ${load.first} to ${load.last}`;
  return `Claude wants to load a ${load.lines}-line BASIC program (${span}, ${load.bytes} bytes) into your BASIC session. It replaces the program in memory; a restore point is made first, so restoring it brings yours back.`;
}

export function setupClaude(page) {
  const { session } = page;
  // what the views draw besides the conversation itself
  const state = {
    text: '',          // the reply streaming in
    asked: null,       // the last line asked (Try again sends it once more)
    context: null,     // what the question is about: null (the screen and the program) | { code: address } (the Debugger)
    failed: null,      // a line whose turn ended in an error (shown with the error until the next one)
    stopped: false,    // the last turn was stopped: true, or why the page stopped it ("you reset the machine")
    unanswered: null,  // the last question got no reply (a refusal, or nothing): { asked, note }
    view: 'panel',     // the last view used this visit
    pip: false,        // full screen: the BASIC session's corner window is shown (hidden until Claude acts or Ctrl+B)
  };
  const listeners = new Set();
  const notify = () => { for (const f of listeners) f(); };
  // the phone layouts of the chat: portrait up to 700 px wide, or held sideways up to 500 px high
  const phoneQuery = matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 500px)');
  const phoneLayout = () => phoneQuery.matches;
  session.on((ev, arg) => {
    // a Reset or a power cycle stopped Claude (Session.stopClaudeFor): the conversation says why
    if (ev === 'claude-stopped') { state.stopped = arg; notify(); }
    if (ev === 'chat' || ev === 'machine' || ev === 'roms') notify();
  });
  // the page asks; Session.answerClaude gives the answer (the views draw Session.claudePending)
  // a card the side panel would show while the panel is closed or minimised opens it: a question nobody can see
  // would hold the turn with no way to answer it
  // A card raised while a page view is up (Share, the Library, Add ROMs, the Debugger: they hide the panel) closes
  // the view, so the card shows: back to the emulator (page.closeView), where the panel opens on it (panelOnReturn)
  session.claudeGate = () => {
    if (session.claudeView !== 'full' && panel && !panel.shown) { if (viewOpen()) panelOnReturn = true; else panel.open({ focus: false }); }
    if (viewOpen()) page.closeView();
    notify();
  };

  const basicMachine = () => session.personMachine;
  // the brief for the view the replies are read in (the full-screen chat's screen, or this panel), from the BASIC
  // session's real state: what runs on it, and its own screen
  const brief = (view) => {
    const m = basicMachine();
    const software = session.nitros9On(m) ? 'nitros9' : m.hasRom ? 'basic' : 'none';
    return claudeBrief({ machine: m.profile.name, ram: m.config.ram, cpu: m.config.cpu, software, family: m.profile.family, edition: 'cloadm.dev', tools: true, view });
  };
  const backend = () => new ClaudeBackend({ fetch: (url, init) => fetch(url, init), apiKey: session.keyStore.get() || '' });
  function wire(chat) {
    // a turn starting, from either view's box or the full-screen chat's own lines (the firmware's channel): what the
    // panel said about the last turn ("[stopped: …]", a failed question, no reply) is that turn's, not this one's
    let wasBusy = chat.busy;
    chat.onChange = () => {
      if (chat.busy && !wasBusy) Object.assign(state, { stopped: false, failed: null, unanswered: null });
      wasBusy = chat.busy;
      session.emit('chat');
    };
    chat.onText = (t) => {
      if (!chat.busy || /^\r?\n\[.*\]\r?\n$/s.test(t)) return;   // status lines are the views' own
      state.text += t; notify();
    };
    chat.onToolUse = (name) => {
      // Claude acting in full screen shows the BASIC session's window (and it stays until the person hides it)
      if (ACTING.has(name) && session.claudeView === 'full') state.pip = true;
      notify();
    };
  }
  // the conversation, started in the side panel if there is none yet
  function ensure() {
    if (!session.chat) wire(session.startAsk({ backend: backend(), brief: brief('panel'), include }));
    return session.chat;
  }
  // one line to Claude from either view's box (the firmware's own lines come through its channel)
  async function ask(text, { context = null } = {}) {
    const chat = ensure();
    text = String(text || '').trim();
    if (!text || chat.busy) return null;
    chat.brief = brief(session.claudeView === 'full' ? 'full' : 'panel');
    Object.assign(state, { text: '', asked: text, failed: null, stopped: false, unanswered: null, context });
    session.claudeActing = null;
    notify();
    const res = await chat.sendLine(text);
    if (!res && chat.error) {
      if (chat.error.code === 'aborted') state.stopped = state.stopped || true; else state.failed = text;
    }
    // a reply with no text and no tool calls (a refusal, or nothing) is not kept in the conversation
    // (ChatSession.sendLine): the question and a note say what happened, so the turn is not silent
    // (after tool calls the question is kept, so only the note is added)
    if (res && !(res.text && res.text.trim()) && (res.stopReason === 'refusal' || !res.toolCalls)) {
      state.unanswered = { asked: res.toolCalls ? null : text, note: res.stopReason === 'refusal' ? '[Claude declined to answer this one.]' : '[Claude gave no reply.]' };
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
    if (session.claudePaused) return CLAUDE_PAUSED_TEXT;
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
    if (session.claudeView === 'full') { panelOnReturn = false; session.showChat('chat'); show(true); return session.chat; }
    if (opening) return opening;
    opening = (async () => {
      if (cpuFamily(session.shownMachine.config.cpu) !== '6809') {
        if (session.chat) session.endChat();
        page.status(`The chat firmware needs a 6809, so the chat opens on a Dragon 64 (the ${session.shownMachine.profile.name} has a ${session.shownMachine.config.cpu}).`);
        session.switchMachine('dragon64');
      }
      const firmware = await page.fetchBytes(FIRMWARE_URL);
      // a machine with the Becker port on talks to the chat over DriveWire, as a real one would; otherwise the
      // firmware's mailbox carries it
      const drivewire = !!session.shownMachine.config.becker;
      const had = session.chat;
      const chat = session.startChat({ backend: had ? had.backend : backend(), channel: drivewire ? undefined : new MemoryChannel(), firmware, brief: brief('full'), drivewire, include });
      if (chat !== had) wire(chat);
      // only now, with the chat really starting: if opening it failed above (the firmware did not load), the view the person
      // came from still reopens the Ask panel when it closes. Before show(true): the history step it takes runs the
      // view-closed callbacks, which would reopen the panel under the chat.
      panelOnReturn = false;
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
    $('emuHeading').hidden = on;   // the chat's bar is the heading then (one h1: its CHAT WITH CLAUDE)
    markUndrawn();   // (the chat hides the drawer and the ports: page.js)
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
  // BEFORE the view handlers (page.onView's beforeView): a view opened over the full-screen chat closes it, so a
  // view that builds on the machine in use (the Debugger's refresh, session.debug) must find the BASIC session
  // already back - never the chat machine, which would be detached again a moment later (PM 124).
  page.onView(() => {
    if (page.onStep('claudeChat')) return;
    if (document.body.classList.contains('claude-open')) { const byView = viewOpen(); close(); if (byView) panelOnReturn = true; }
    else if (opened && new URL(location.href).searchParams.get('app') === 'claude') show(false);
  }, { every: true, beforeView: true });
  page.onView(() => {
    if (viewOpen() || !panelOnReturn) return;
    panelOnReturn = false;
    // (the keyboard stays with the machine: coming back by the browser's Back does not focus the page)
    if (session.chat && session.claudeView !== 'full') { ensure(); state.view = 'panel'; if (panel) panel.open({ focus: false }); }
  });
  // "← Emulator" (and Esc) take the chat's step back, so no stale step is left behind
  const leave = () => page.toEmulator();
  $('btnClaudeBack').onclick = () => leave();
  // Esc in the full-screen chat is BREAK while BREAK has something to do (a reply streaming: it stops; a typed line:
  // the firmware drops it) and otherwise leaves the chat the way "← Emulator" does, taking the history step back (the
  // page's one Esc path, page.onEscape): on the screen only with an idle, empty prompt (Session.chatPromptEmpty), off
  // the screen always
  page.onEscape(ESC.chat, () => session.claudeView === 'full', leave, { onScreen: () => session.chatPromptEmpty });
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
  $('btnClaudeAllow').onclick = () => acceptClick(session, $('btnClaudeAllow'));
  $('btnClaudeTell').onclick = () => session.answerClaude(false);
  $('btnClaudeLoad').onclick = () => acceptClick(session, $('btnClaudeLoad'), { dontAsk: $('chkClaudeLoadNoAsk').checked });
  $('btnClaudeLoadNo').onclick = () => session.answerClaude(false);
  const restore = (index) => page.attempt(() => { const r = session.restoreClaude(index); return r ? ['Restored: your BASIC session is as it was before Claude\'s changes.', ...r.notices].join(' ') : null; });
  // the folded action lines the person opened in the card's strip (by turn number)
  const openTurns = new Set();
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
  $('btnClaudeStop').onclick = () => { stop(); if (session.claudeView === 'full') page.focus(); };
  // a key pressed on the BASIC session paused Claude: Resume (beside Stop) lets it go on
  $('btnClaudeResume').onclick = () => { session.resumeClaude(); if (session.claudeView === 'full') page.focus(); };
  addEventListener('keydown', (e) => {
    // Ctrl+B swaps the chat and the BASIC session
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'b' || e.key === 'B') && session.chatMachines) { e.preventDefault(); e.stopPropagation(); swap(); return; }
    // BREAK (Esc on the screen) while a reply streams stops it; the firmware gets its BREAK too and gives a fresh
    // prompt. A typed line is dropped by the firmware's BREAK. Only on an idle, empty prompt, or off the screen, does
    // Esc leave the full screen instead (page.onEscape); a reply goes on when Esc is pressed off the screen.
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
    if (!session.shownMachine) return;         // (the page has no machine until it starts)
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
    // (and while a card waits for the person, in any view: held sideways the keyboard covers the whole page, the card
    // with it; nothing of Claude's types meanwhile)
    if (page.touchKeys) page.touchKeys.standAside((phoneChat && form) || !!session.claudePending);
    // the panel's offer depends on body.chat-phone (touch-keys.js: a full-screen chat on a phone is not a BASIC
    // machine's screen, and the joystick is not offered there), so a change of it must be applied, not just the
    // class toggled: the stick, FIRE and the switch come and go with it
    if (page.touchKeys) page.touchKeys.apply();
    // the on-screen keyboard's Menu leads out of the chat there (the app bar and its menu give way to the chat bar,
    // which the keyboard covers when the phone is held sideways); touch-keys.js leaves in one tap with this label
    $('tkMenu').textContent = phoneChat ? '← Emulator' : 'Menu';
    // the help line: the key state's text (in brackets on the chat screen too, from the firmware)
    // (while a turn is in progress the status line says what it is doing, with Stop)
    const help = chat && chat.busy ? '' : k === 'none' ? `[No API key yet: add one ${whereKey()}.]` : keyText(k);
    $('claudeHelp').textContent = help;
    $('claudeHelp').hidden = !help;
    // the BASIC session card: consent, the switch, the restore point
    const pend = session.claudePending;
    const modelName = () => { const m = session.personMachine; return m ? m.profile.name : ''; };
    const loading = !!(pend && pend.kind === 'load');      // load_basic's own card, on every call
    const asking = !!pend && !loading;                     // the consent question
    $('claudeSession').classList.toggle('asking', !!pend);
    $('claudeConsentText').textContent = asking
      ? 'Claude wants to type into your BASIC session. With permission it can type, POKE, run and press BREAK. You can watch it in the corner of the screen, Stop it, and restore everything: a restore point is made first.'
      : `Claude can read this ${modelName()}'s screen text and memory at any time, nothing outside the emulator. Typing, POKEs and running need your permission; loading a BASIC program asks every time (with the switch on, its card offers Don\'t ask again this session).`;
    $('claudeConsentAsk').hidden = !asking;
    $('claudeLoad').hidden = !loading;
    if (loading) $('claudeLoadText').textContent = loadCardText(pend.load);
    else $('chkClaudeLoadNoAsk').checked = false;
    // R11: paused while the card waits: "Allow and resume" / "Load and resume", and the line that says why
    const pausedCard = !!pend && !!session.claudePaused;
    drawAccept($('btnClaudeAllow'), pausedCard, 'Allow', 'Allow and resume');
    drawAccept($('btnClaudeLoad'), pausedCard, 'Load it', 'Load and resume');
    $('claudeConsentPaused').hidden = !pausedCard;
    if (pausedCard) $('claudeConsentPaused').textContent = PAUSED_CARD_TEXT[loading ? 'load' : 'consent'];
    // "Don't ask again this session" only while the switch is on: with it off every load asks, so the box is not offered
    $('chkClaudeLoadNoAsk').closest('label').hidden = !session.claudeAllowed;
    if (!session.claudeAllowed) $('chkClaudeLoadNoAsk').checked = false;
    $('chkClaudeTools').checked = session.claudeAllowed;
    // the turn's status with Stop, in the bar (on top on a phone too): thinking, a tool running, a card waiting;
    // a card that has just come up is brought into view
    const status = full ? session.claudeStatus : null;
    $('claudeStatus').hidden = !status;
    if (status) $('claudeStatusText').textContent = status.text;
    // the bar is the full screen's only status, so a pause there has its Resume (the side panel's is on the screen)
    $('btnClaudeResume').hidden = !(status && session.claudePaused);
    if (!pend || !full) shownPending = null;
    else if (pend !== shownPending) { shownPending = pend; $('claudeSession').scrollIntoView({ block: 'center' }); }
    // the card's strip: the latest turn's action lines, then the restore line (R12, R13). Never printed on the chat
    // screen itself: its frames are the chat firmware's alone.
    const points = session.claudePoints, last = chat ? chatTurns(chat.messages).filter((t) => t.actions.length || Object.keys(t.reads).length).pop() : null;
    if (last) {
      const key = String(last.turn);
      actionLines($('claudeActions'), { actions: last.actions, reads: last.reads, open: openTurns.has(key), toggle: () => { if (openTurns.has(key)) openTurns.delete(key); else openTurns.add(key); render(); } });
    } else $('claudeActions').hidden = true;
    restoreLine($('claudeRestore'), { points, busy: !!(chat && chat.busy), restore, id: 'claude' });
    $('claudeRestore').hidden = !points.length && !last;
    const basic = session.chatMachines && session.chatMachines.basic;
    $('claudeSpec').textContent = basic ? `${basic.profile.name} · chat firmware, no ROM needed` : '';
    $('claudeBasicNote').textContent = basic && !basic.hasRom
      ? 'Your BASIC session has no BASIC ROMs, so it runs without ROMs: Claude can read and change its memory, but BASIC programs need your ROMs.' : '';
    // the swap and the picture-in-picture
    const peeking = session.chatView === 'basic';
    $('claudePip').hidden = !full || !state.pip;
    // a strip under the screen at every width, never over the chat's text
    const tap = matchMedia('(max-width: 700px)').matches ? 'tap' : 'click';
    $('claudePipLabel').textContent = peeking ? 'The chat · live' : 'Your BASIC session';
    $('claudePipSub').textContent = session.claudeBusyActing ? 'Claude is typing…' : peeking ? `Live chat · ${tap} to swap back` : `Live · ${tap} to show it`;
    $('btnClaudeView').textContent = peeking ? 'Back to the chat' : 'Show my BASIC session';
    $('btnClaudeView').classList.toggle('primary', peeking);
    renderActivity();
  }
  let shownPending = null;
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
