/*
 * Ask Claude, the side panel (a bottom sheet on a phone). The emulator keeps running beside it: clicking the screen gives the machine the keyboard,
 * clicking the message box gives Claude the keyboard. The conversation, the backend and the state are the
 * controller's (js/ui/claude.js), shared with the full screen chat.
 *   - desktop: 420 px on the right, the left edge drags it between 320 and 560 px (remembered); the drawer's tabs
 *     fold into a 64 px icon rail, and a rail icon opens that tab over the panel (Esc closes it); minimised, a
 *     strip at the top of the drawer shows the activity and Open; below 1100 px it lies over the drawer;
 *   - phone: a bottom sheet with peek, half and full heights (the handle or the header button changes it; the
 *     message box focused makes it full; while Claude acts it drops to peek); restore points and the switch sit
 *     in its ⋯ menu;
 *   - "Claude can read (emulator only)": screen text, memory; reading always works, acting asks first (the consent
 *     card: Allow / Just tell me the fix; Allow turns the switch on for the visit);
 *   - while a turn is in progress: a status line above the message box, with Stop: "Thinking…" while the reply
 *     comes (the model thinking or streaming), "Using <tool>…" while a tool runs, "Waiting for your OK" while a card
 *     asks (the card scrolled into view; on a phone the sheet leaves peek for it); the turn's errors end it with
 *     their message in the conversation (Session.claudeStatus, the controller's keyState);
 *   - while Claude acts: a pulsing ring on the screen and "Claude is typing line 120… Stop" at its top, a live
 *     log in the panel; Stop ends the turn; a key pressed on the machine while Claude acts pauses it ("Paused",
 *     with Resume and Stop on the screen; the full-screen chat has them in its bar), until the turn ends; while
 *     paused, Esc is Stop in every view (not also BREAK); in the browser's Fullscreen the status, Stop and Resume
 *     are on the screen itself, and leaving Fullscreen while paused (Esc there) stops Claude; on the page views (Share,
     the Library, Add ROMs, the Debugger) the status with Stop, Resume and Answer is at the bottom of the window
     (#viewClaude); every input of the person's to the machine pauses Claude (Session.personInput);
 *   - under each turn's reply, one small line per thing Claude did on the machine, and under the latest turn that
 *     changed it the restore line (js/ui/claude-lines.js; the last 10 points);
 *   - the API key states with the same texts as full screen: no key (the key form replaces the message box),
 *     refused (the form reopens, red), rate limited and offline (Try again; nothing retries by itself);
 *   - three example questions for what is on the machine now (js/claude/prompts.js, from the Session's state, never
 *     pixels), in one place at a time: the empty chat while the panel is open, the line under the screen (#screenNotes:
 *     whole questions only, a real note there taking the line; none on a phone) while it is closed. With a key a tap fills the message box (the strip's opens the panel first) and sends nothing; without
 *     one they sit under "You could ask, once Claude is connected:" ("Once Claude is connected:" leads the line under the
 *     screen), and a tap selects one (the strip's opens the
 *     panel with it) and offers "I have an API key" (the question fills the message box once the key is saved) and "I
 *     use Claude →" (the question is copied). They follow the Session's events and the machine (500 ms debounce) while
 *     there is no conversation, stay put while the box has text, a pointer is down or a question is selected, and say
 *     "Suggestions updated" politely.
 *     With "Suggest questions with Claude" on (Settings, under Claude features; off by default) and a key, opening the
 *     panel on an empty chat also sends ONE request to Claude Haiku with the screen's text and the machine's name
 *     (Session.claudeSuggestions, js/claude/suggest.js): the page's own questions show at once, and a valid answer
 *     within 3 s replaces them under "Suggested by Claude"; anything else keeps them. The line under the screen never
 *     asks Claude, a graphics screen has only the page's own, and a tap fills the message box and sends nothing.
 */
import { $, ESC, viewOpen, markUndrawn, claudeStatusText, touchPanel, TOUCH_PAUSED_TEXT } from './page.js';
import { PAUSED_CARD_TEXT, acceptClick, drawAccept, loadCardText } from './claude.js';
import { CLAUDE_PAUSED_SHORT } from '../session.js';
import { chatTurns } from '../claude/history.js';
import { actionLines, restoreLine, syncRows } from './claude-lines.js';
import { promptsNow } from '../claude/prompts.js';

const WIDTH_KEY = 'cloadm.askWidth';
export const SENDS_SUGGEST = "Suggested questions: the screen's text, when you open an empty chat.";
const RAIL = [['Media', 'tab-media'], ['Display', 'tab-display'], ['Input', 'tab-input'], ['POKEs', 'tab-pokes'], ['Machine', 'tab-machine']];
const phone = () => matchMedia('(max-width: 700px)').matches;
// keys that only change other keys (and lock keys): pressed or let go, they are not a key on the machine
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS']);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

export function setupAsk(page, claude) {
  const { session } = page;
  const ask = $('ask');
  let open = false, minimised = false, railTab = null, more = false;

  // ---------------- open, close, minimise ----------------
  // focus: false when the page opens the panel for a card, so keys typed on the machine stay with the machine
  function show({ focus = true } = {}) {
    open = true; minimised = false; closeAfterTurn = false;
    ask.hidden = false;
    document.body.classList.add('ask-open');
    markUndrawn();
    $('askRail').hidden = phone();
    if (phone()) setHeight('half');
    render();
    suggestWithClaude();
    if (focus && !phone() && !$('askInput').closest('[hidden]')) $('askInput').focus();
  }
  function hide({ keep = false } = {}) {
    open = false; closeAfterTurn = false;
    delete ask.dataset.restore;
    ask.hidden = true;
    $('askRail').hidden = true;
    setRail(null);
    document.body.classList.remove('ask-open');
    markUndrawn();
    if (!keep) minimised = false;
    render();
  }
  claude.registerPanel({ open: show, close: hide, get shown() { return open; } });
  // the header button: opens the side panel beside the person's machine, whatever is on it (the welcome menu
  // included), or closes what is open
  $('btnAsk').onclick = () => {
    if (open || session.claudeView === 'full') { claude.close(); return; }
    claude.openPanel();
  };
  // On a phone the person closing the sheet during a turn lowers it to peek instead, and it closes when the turn
  // ends: its peek line keeps the status and Stop (the drawer's strip is below the screen there, or hidden with the
  // touch keys). Closes the page makes itself (to full screen, a page view) always close.
  let closeAfterTurn = false;
  const personCloses = () => {
    if (phone() && open && session.claudeStatus) { delete ask.dataset.restore; setHeight('peek'); closeAfterTurn = true; render(); return; }
    claude.close();
  };
  $('btnAskClose').onclick = personCloses;
  page.onEscape(ESC.chat, () => open, personCloses);
  $('btnAskMin').onclick = () => { hide({ keep: true }); minimised = true; render(); page.focus(); };
  $('askStrip').onclick = () => claude.openPanel();
  $('btnAskFull').onclick = () => claude.openFull();
  $('btnAskSide').onclick = () => {};

  // ---------------- the width (desktop) and the height (phone) ----------------
  const setWidth = (w) => { const v = Math.max(320, Math.min(560, Math.round(w))); ask.style.setProperty('--ask-w', `${v}px`); return v; };
  try { const w = Number(localStorage.getItem(WIDTH_KEY)); if (w) setWidth(w); } catch (e) { /* no storage */ }
  $('askGrip').onpointerdown = (e) => {
    e.preventDefault();
    const right = ask.getBoundingClientRect().right;
    const move = (ev) => setWidth(right - ev.clientX);
    const up = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); try { localStorage.setItem(WIDTH_KEY, String(setWidth(right - ev.clientX))); } catch (x) { /* no storage */ } };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  // the phone's own keyboard: how much of the window it covers (the visual viewport shrinks above it)
  const keyboardInset = () => { const v = window.visualViewport; return v ? Math.max(0, Math.round(innerHeight - v.height - v.offsetTop)) : 0; };
  function setHeight(h) {
    // raised again (the handle, Open, the message box, a card): a close asked for during the turn no longer stands
    if (h !== 'peek') closeAfterTurn = false;
    ask.dataset.height = h;
    // the sheet's bottom edge sits on the phone's keyboard when it is up, else on the window's bottom edge
    const inset = phone() ? keyboardInset() : 0, bottom = innerHeight - inset;
    ask.style.setProperty('--sheet-bottom', `${inset}px`);
    // half: the conversation between the screen and the bottom; full: the screen keeps its top in view. At least
    // 160 px of sheet either way, so the message box always shows
    const s = $('screen').getBoundingClientRect();
    let top = h === 'full' ? Math.max(60, s.top + s.height * 0.35) : Math.max(s.bottom + 8, 120);
    top = Math.min(top, bottom - 160);
    ask.style.setProperty('--sheet-top', `${Math.round(top)}px`);
  }
  if (window.visualViewport) {
    const follow = () => { if (open && phone() && ask.dataset.height !== 'peek') setHeight(ask.dataset.height); };
    visualViewport.addEventListener('resize', follow);
    visualViewport.addEventListener('scroll', follow);
  }
  $('askHandle').onclick = () => setHeight(ask.dataset.height === 'peek' ? 'half' : ask.dataset.height === 'half' ? 'full' : 'peek');
  $('btnAskPeekOpen').onclick = () => setHeight('half');
  $('askInput').addEventListener('focus', () => { if (phone()) setHeight('full'); });
  addEventListener('resize', () => { if (open && phone() && ask.dataset.height !== 'peek') setHeight(ask.dataset.height); $('askRail').hidden = !open || phone(); });
  $('btnAskMore').onclick = () => { more = !more; ask.classList.toggle('more', more); $('btnAskMore').setAttribute('aria-expanded', String(more)); };

  // ---------------- the rail: the drawer's tabs over the panel ----------------
  for (const [name, tab] of RAIL) {
    const b = el('button', name);
    b.setAttribute('aria-label', name);
    b.onclick = () => setRail(railTab === tab ? null : tab);
    b.dataset.tab = tab;
    $('askRail').append(b);
  }
  function setRail(tab) {
    railTab = tab;
    document.body.classList.toggle('ask-rail-drawer', !!tab);
    markUndrawn();   // (now: the drawer the rail shows must take the focus its tab gives below)
    for (const b of $('askRail').children) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    if (tab) page.openSettings(tab);
  }
  // (a menu over the panel: Esc closes it first, on the screen too, and is then neither BREAK nor a pause)
  page.onEscape(ESC.menu, () => !!railTab, () => setRail(null));

  // ---------------- asking ----------------
  const send = () => { const v = $('askInput').value; if (!v.trim()) return; $('askInput').value = ''; claude.ask(v); };
  $('btnAskSend').onclick = send;
  $('askInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('btnAskRetry').onclick = () => claude.retry();
  $('btnAskAllow').onclick = () => acceptClick(session, $('btnAskAllow'));
  $('btnAskTell').onclick = () => session.consent.answer(false);
  $('btnAskLoad').onclick = () => acceptClick(session, $('btnAskLoad'), { dontAsk: $('chkAskLoadNoAsk').checked });
  $('btnAskLoadNo').onclick = () => session.consent.answer(false);
  $('chkAskMachine').onchange = () => session.consent.setAllowed($('chkAskMachine').checked);
  $('btnAskStop').onclick = () => claude.stop();
  $('btnAskStatusStop').onclick = () => claude.stop();
  $('btnAskPeekStop').onclick = () => claude.stop();
  $('btnAskStripStop').onclick = () => claude.stop();
  $('btnAskResume').onclick = () => { session.resumeClaude(); page.focus(); };
  // the panel's own status line has Resume too (where the open panel lies over the screen, it covers the pill's)
  $('btnAskStatusResume').onclick = () => { session.resumeClaude(); page.focus(); };
  // a key the person presses on the machine Claude is using pauses Claude (before the key itself is queued, so the
  // person's key goes in and Claude's held typing does not)
  // (pausedNow: the key being handled is the one that paused; an Esc that pauses Claude is still the person's BREAK.
  // It holds that key's code while the key is down: cleared by that key's keyup (not another's: a modifier let go
  // while Esc is held) and by any keydown but its own autorepeat, never by a timer, which a busy page can run after
  // the next key)
  // A modifier that paused Claude (Shift, and Ctrl or Alt where the machine has that key: the CoCo 3) holds the mark
  // for the chord it starts: the next key pressed while it is down takes the mark over (Shift then Esc is one press:
  // the Esc is BREAK, not Stop), and letting the modifier go first clears it.
  let pausedNow = null, modMark = false;
  addEventListener('keyup', (e) => { if (pausedNow && (e.code || e.key) === pausedNow) { pausedNow = null; modMark = false; } }, true);
  // (a key let go in another window never comes back as a keyup: leaving the page ends the press, as it lets go of
  // the machine's keys)
  addEventListener('blur', () => { pausedNow = null; modMark = false; });
  // (an autorepeat of that key is the same press: holding Esc to BREAK a program does not also stop Claude)
  addEventListener('keydown', (e) => {
    const code = e.code || e.key;
    // (a modifier pressed while the key is held is not another press: it leaves the mark, as its keyup does)
    if (!(e.repeat && code === pausedNow) && !MODIFIERS.has(e.key)) {
      if (modMark && pausedNow) { pausedNow = code; modMark = false; } else pausedNow = null;
    }
    // (the keys that go to the machine, page.toMachine: on the screen or with the focus on the page's body; an Esc
    // that a card, a confirmation, a menu (the rail's tab) or (off the screen) a view takes is not a key on the machine)
    const mod = { Shift: 'SHIFT', Control: 'CTRL', Alt: 'ALT' }[e.key];
    if (mod && !e.repeat && page.toMachine(e) && session.shownMachine.keyPos && session.shownMachine.keyPos[mod]) {
      if (session.personInput()) { pausedNow = code; modMark = true; }
      return;
    }
    if (!page.toMachine(e) || e.ctrlKey || e.metaKey || e.altKey || MODIFIERS.has(e.key)) return;
    if (session.personInput()) pausedNow = code;
  }, true);
  // Esc while paused: while Claude is paused, Esc stops Claude (the pause ends, the turn is aborted, the held keys are dropped) in
  // every view: the side panel, the phone sheet, minimised, the full-screen chat (its chat and BASIC views). It is
  // Stop only, not also BREAK. A confirmation, a menu or a card that is open takes the Esc first (page.onEscape).
  // Claude's own card waiting while paused registers no Esc of its own, so Esc there is this Stop: the card is
  // answered stopped (stopClaude), not as a no.
  page.onEscape(ESC.claude, () => !!session.consent.paused && !pausedNow, () => claude.stop());
  // the browser's Fullscreen shows #screenWrap alone: Claude's status with Stop and Resume is in it (#fsClaude).
  // The browser takes Esc there to leave Fullscreen, so leaving it while Claude is paused is that Esc: Stop.
  const fullscreen = () => (document.fullscreenElement || document.webkitFullscreenElement) === $('screenWrap');
  $('btnFsStop').onclick = () => { claude.stop(); page.focus(); };
  // the page views (Share, the Library, Add ROMs, the Debugger) hide the emulator and the panel: Claude's status with
  // Stop, Resume while paused, and Answer while a card waits (it closes the view, back to the panel with the card)
  $('btnViewStop').onclick = () => claude.stop();
  $('btnViewResume').onclick = () => session.resumeClaude();
  $('btnViewAnswer').onclick = () => { claude.openPanel(); page.closeView(); };
  $('btnFsResume').onclick = () => { session.resumeClaude(); page.focus(); };
  // (only a leave the person made stops Claude: the page's own leave, for a card, is not theirs, even when a key
  // pauses Claude before the browser reports it - pageLeft marks that leave until it is reported)
  let pageLeft = false;
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
      const ours = pageLeft;
      if (!fullscreen()) pageLeft = false;
      if (!fullscreen() && session.consent.paused && !ours) claude.stop();
      renderActing();
    });
  }
  // a point that can't be restored says why as an error toast; nothing changes and every point is kept
  // a disk that comes back unlinked from the Library says so after the restore's message (DiskDrives.restorePoint)
  const restore = (index) => page.attempt(() => { const r = session.restoreClaude(index); return r ? ['Restored: the machine is as it was before Claude\'s changes.', ...r.notices].join(' ') : null; });
  // the turns whose folded action lines the person opened (by turn number)
  const openTurns = new Set();
  // the key
  $('btnAskKeySave').onclick = () => {
    // the question chosen before the key: it fills the message box once the key is saved, not sent (read first: the
    // save redraws the questions, which lets the selection go)
    const q = chosen;
    let saved = false;
    try { claude.saveKey($('askKeyInput').value); $('askKeyInput').value = ''; $('askKeyErr').textContent = ''; editingKey = false; saved = true; }
    catch (e) { $('askKeyErr').textContent = e.message; }
    render();
    if (saved && q && !$('askComposer').hidden) { $('askInput').value = q; $('askInput').focus(); }
  };
  $('askKeyInput').onkeydown = (e) => { if (e.key === 'Enter') $('btnAskKeySave').click(); };
  let editingKey = false;
  $('btnAskKeyChange').onclick = () => { editingKey = true; render(); $('askKeyInput').focus(); };
  $('btnAskKeyForget').onclick = () => claude.forgetKey();
  // the emulated machine's name ("Dragon 64", "CoCo 1/2"), as the full screen card says it
  const modelName = () => { const m = session.personMachine; return m ? m.profile.name : ''; };

  // ---------------- the example questions ----------------
  // One set (js/claude/prompts.js), in one place at a time: the empty chat while the panel is open (#askSuggest), the
  // strip under the machine while it is closed (#askStripQs). None while a conversation is going, in the full-screen
  // chat, or with Claude features Off.
  // shown: the set's id; prompts: its questions; place: 'panel' | 'strip' | null, where they are drawn; chosen: the
  // question selected without a key (kept through opening the panel and entering the key); pointerDown: a press in the
  // panel or the strip (the questions do not move under a finger); panelEmpty: the open panel's chat is empty (render)
  let shown = null, prompts = [], place = null, chosen = null, pointerDown = false, sugTimer = null, noKeyShown = null, panelEmpty = false;
  // byClaude: the questions Claude suggested for the open panel's empty chat (in place of the set's), or null;
  // drawnBy: which were drawn last (a change redraws); sugAsk: the latest request's number (an older answer is dropped)
  let byClaude = null, drawnBy = null, sugAsk = 0;
  for (const box of [ask, $('askOpeners')]) box.addEventListener('pointerdown', () => { pointerDown = true; });
  for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { pointerDown = false; }, true);
  const frozen = () => !!$('askInput').value || pointerDown || chosen != null;
  const noKey = () => claude.keyState() === 'none';
  function where() {
    if (!session.claudeFeatures || session.claudeView === 'full') return null;
    if (open) return panelEmpty ? 'panel' : null;
    // (the strip is the line under the screen, #screenNotes: none on a phone, which has no room for it)
    if (phone() || !$('screenNotes').checkVisibility()) return null;
    const chat = session.chat;
    return !(chat && (chat.busy || chat.messages.length)) && !session.claudeStatus ? 'strip' : null;
  }
  // fresh: the conversation has just become empty (read the machine again); live: the debounced follow-up of a change
  function drawQuestions({ fresh = false, live = false } = {}) {
    const at = where(), nk = noKey();
    if (!at) {
      // (Off, or nowhere to show them: nothing is drawn, and with Off the machine is not read for them)
      if (!session.claudeFeatures) { shown = null; chosen = null; }
      byClaude = null;
      reveal($('askSuggestBy'), false);
      if (place) { $('askSuggest').replaceChildren(); $('askStripQs').replaceChildren($('askOpenLabel')); delete $('askSuggest').dataset.set; place = null; }
      reveal($('askSuggestLabel'), false); reveal($('askOpenLabel'), false); reveal($('askChoose'), false);
      return;
    }
    if (fresh) { shown = null; chosen = null; byClaude = null; }
    // (Claude's questions are the open panel's only: the line under the screen never has them)
    if (at !== 'panel') byClaude = null;
    if (noKeyShown && !nk) chosen = null;   // (a key now: the question chosen before it went into the message box)
    let announce = false, changed = false;
    if (!shown || live) {
      const set = promptsNow(session);
      if (!shown || (set.id !== shown && !frozen())) { announce = !!shown && set.id !== shown; changed = set.id !== shown; shown = set.id; prompts = set.prompts; }
    }
    // (the machine moved on to another set: Claude's questions were for the screen before)
    if (changed) byClaude = null;
    if (changed || at !== place || nk !== noKeyShown || byClaude !== drawnBy) {
      drawnBy = byClaude;
      const buttons = (byClaude || prompts).map((q) => {
        const b = el('button', q);
        if (nk && at === 'panel') b.setAttribute('aria-pressed', String(q === chosen));
        b.onclick = () => (at === 'panel' ? pick(q, b) : openWith(q));
        return b;
      });
      // (a rebuild in the same place keeps the keyboard: the question at the focused one's place takes the focus, so
      // the focus never drops to the page, where the next key would go to the machine)
      const had = document.activeElement, from = had && had.tagName === 'BUTTON' && (had.parentElement === $('askSuggest') || had.parentElement === $('askStripQs')) ? had.parentElement : null;
      const keep = from && at === place && from === (at === 'panel' ? $('askSuggest') : $('askStripQs')) ? [...from.querySelectorAll('button')].indexOf(had) : -1;
      // (one place at a time: the other is emptied; the strip keeps its lead label first)
      if (at === 'panel') { $('askStripQs').replaceChildren($('askOpenLabel')); $('askSuggest').replaceChildren(...buttons); }
      else { $('askSuggest').replaceChildren(); $('askStripQs').replaceChildren($('askOpenLabel'), ...buttons); }
      if (keep >= 0 && buttons[keep]) buttons[keep].focus({ preventScroll: true });
      $('askSuggest').dataset.set = byClaude ? 'claude' : shown;
      place = at; noKeyShown = nk;
    }
    reveal($('askSuggestBy'), at === 'panel' && !!byClaude);
    if (announce) $('askSuggestNote').textContent = 'Suggestions updated';
    reveal($('askSuggestLabel'), at === 'panel' && nk);
    reveal($('askChoose'), at === 'panel' && nk && chosen != null);
    if (at === 'strip') fitStrip(nk); else reveal($('askOpenLabel'), false);
  }
  // (written only when it changes: this runs a few times a second, and an attribute set to its own value is still a
  // change to anything watching the page)
  const reveal = (e, on) => { if (e.hidden === on) e.hidden = !on; };
  // the strip is one line of whole questions: those that do not fit in it whole are left out, never cut or scrolled.
  // Each question's width is measured once, shown (widths); the line is then laid out from them.
  const widths = new WeakMap();
  function fitStrip(lead = !$('askOpenLabel').hidden) {
    const box = $('askStripQs'), qs = [...box.querySelectorAll('button')], label = $('askOpenLabel');
    reveal(label, lead);
    if (!box.checkVisibility()) return;
    if (qs.some((b) => !widths.has(b))) { for (const b of qs) reveal(b, true); for (const b of qs) widths.set(b, b.getBoundingClientRect().width); }
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0, room = box.parentElement.clientWidth;
    let used = lead ? label.getBoundingClientRect().width + gap : 0, out = false;
    for (const b of qs) { out = out || used + widths.get(b) > room + 0.5; if (!out) used += widths.get(b) + gap; reveal(b, !out); }
    // (the lead alone is not a line: with no whole question it goes too)
    if (lead && qs.length && qs[0].hidden) reveal(label, false);
  }
  // (the slot's width, and the line itself showing: a note above it going away shows it, and it is fitted before it
  // is drawn)
  const fitWatch = new ResizeObserver(() => { if (place === 'strip') fitStrip(); });
  fitWatch.observe($('screenNotesBox'));
  fitWatch.observe($('askStripQs'));
  // The panel opened on an empty chat: with the setting on and a key, one request for Claude's questions (the Session
  // keeps to one per screen and one per 30 s, and every other rule). The answer is taken only if the panel is still
  // open on its empty chat and nothing holds the questions (text in the box, a press, a selection).
  async function suggestWithClaude() {
    if (where() !== 'panel' || noKey() || !session.claudeSuggest) return;
    const n = ++sugAsk;
    const qs = await session.claudeSuggestions((url, init) => fetch(url, init));
    if (!qs || n !== sugAsk || where() !== 'panel' || frozen()) return;
    byClaude = qs;
    drawQuestions();
    $('askSuggestNote').textContent = 'Suggestions updated';
  }
  // a question in the open panel: with a key it fills the message box; without one it is selected, and the two
  // choices come forward
  function pick(q, b) {
    if (!noKey()) { $('askInput').value = q; $('askInput').focus(); return; }
    chosen = q;
    for (const x of $('askSuggest').children) x.setAttribute('aria-pressed', String(x === b));
    $('askChoose').hidden = false;
    $('askChoose').scrollIntoView({ block: 'nearest' });
  }
  // a question in the strip: the panel opens with it, never sent (in the message box with a key; selected, with the two
  // choices in view, without one)
  function openWith(q) {
    if (noKey()) chosen = q;
    claude.openPanel();
    if (!noKey()) { $('askInput').value = q; if (!phone()) $('askInput').focus(); }
    else $('askChoose').scrollIntoView({ block: 'nearest' });
  }
  $('btnAskHaveKey').onclick = () => { $('askKeyForm').scrollIntoView({ block: 'nearest' }); $('askKeyInput').focus(); };
  $('btnAskUseClaude').onclick = async () => {
    const q = chosen;
    if (!q) return;
    try { await navigator.clipboard.writeText(q); page.toast('Question copied: paste it in Claude after you open CLOADM there.'); }
    catch (e) { page.toast(`The question could not be copied: ${q}`); }
  };
  // a change on the machine: the questions follow it after 500 ms of it, while they show and nothing holds them
  function suggestSoon() {
    if (sugTimer || !where()) return;
    sugTimer = setTimeout(() => { sugTimer = null; drawQuestions({ live: true }); }, 500);
  }
  session.on((ev) => {
    if (ev === 'claudefeatures') { drawQuestions({ fresh: true }); return; }
    if (ev === 'claudesuggest') { render(); return; }   // (Off clears them; On reads them afresh)
    if (ev !== 'chat') suggestSoon();
  });

  // ---------------- drawing ----------------
  let shownPending = null, wasChat = false;
  const SENDS = $('askSendsLine').textContent;
  function render() {
    const chat = session.chat, k = claude.keyState(), st = claude.state;
    $('btnAsk').setAttribute('aria-pressed', String(open || session.claudeView === 'full'));
    $('btnAskSide').setAttribute('aria-pressed', 'true');
    // the strip also stands in for a panel closed while a turn is in progress, so its status and Stop stay on screen
    $('askStrip').hidden = !(!open && session.chat && (minimised || (session.claudeStatus && session.claudeView !== 'full')));
    // what Claude can read: the code and the registers for the Debugger's question, else the screen and the program
    const code = st.context && st.context.code != null;
    $('askSee').replaceChildren(el('span', 'Claude can read (emulator only):'),
      el('span', code ? `The code at $${st.context.code.toString(16).toUpperCase().padStart(4, '0')}` : 'Screen text', 'chip'),
      el('span', code ? 'Registers and symbols' : 'Memory', 'chip'));
    $('askInput').placeholder = code ? 'Ask about this code…' : 'Ask about this machine…';
    // the empty state names the emulated machine (the BASIC session's, while the full screen chat is open)
    $('askEmptyModel').textContent = modelName();
    // what is sent: with Suggest questions on, the line also says what an empty chat sends
    const sends = session.claudeSuggest ? `${SENDS} ${SENDS_SUGGEST}` : SENDS;
    if ($('askSendsLine').textContent !== sends) $('askSendsLine').textContent = sends;
    // the conversation, turn by turn: the line, the reply, the turn's action lines, and the restore line under the
    // turn its newest point was taken in. Rows are kept by key and appended, never all replaced: #askMessages is a
    // live region, and a focused button in it keeps its focus.
    // (never an empty bubble: a message or a reply so far with no text shows nothing)
    const turns = chat ? chatTurns(chat.messages) : [];
    const points = session.claudePoints, busy = !!(chat && chat.busy);
    const current = busy && chat.line ? chat.line.turn : null;
    const rows = [];
    const bubble = (key, role, text) => {
      rows.push({ key, make: () => { const d = el('div', null, role === 'note' ? 'msg note' : 'msg'); d.dataset.role = role; return d; }, update: (d) => { if (d.textContent !== text) d.textContent = text; } });
    };
    const restoreRow = () => rows.push({ key: 'restore', make: () => el('div', null, 'restorebox'), update: (d) => restoreLine(d, { points, busy, restore, id: 'ask' }) });
    let failedShown = false, restoreShown = false;
    turns.forEach((t, i) => {
      const last = i === turns.length - 1, key = t.turn == null ? `i${i}` : `t${t.turn}`;
      // a turn that failed shows its line only as the failed line (st.failed), and only while it is the last
      if (!t.ended) { if (t.line.trim()) bubble(`${key}u`, 'user', t.line); } else if (last && st.failed) { bubble(`${key}u`, 'user', st.failed); failedShown = true; }
      const reply = t.turn === current ? st.text : t.reply;
      if (reply.trim()) bubble(`${key}a`, 'claude', reply);
      if (t.actions.length || Object.keys(t.reads).length) {
        rows.push({ key: `${key}x`, make: () => el('div', null, 'actions'), update: (d) => actionLines(d, {
          actions: t.actions, reads: t.reads, open: openTurns.has(key),
          toggle: () => { if (openTurns.has(key)) openTurns.delete(key); else openTurns.add(key); render(); },
        }) });
      }
      if (points.length && points[0].turn === t.turn) { restoreRow(); restoreShown = true; }
    });
    if (points.length && !restoreShown) restoreRow();
    if (st.failed && !failedShown) bubble('failed', 'user', st.failed);
    if (st.stopped) bubble('stopped', 'note', typeof st.stopped === 'string' ? `[stopped: ${st.stopped}]` : '[stopped]');
    if (st.unanswered) { if (st.unanswered.asked) bubble('unansweredq', 'user', st.unanswered.asked); bubble('unansweredn', 'note', st.unanswered.note); }
    const box = $('askMessages');
    const before = [...box.children].map((n) => `${n.dataset.key}:${n.textContent}`).join('\n');
    syncRows(box, rows);
    if ([...box.children].map((n) => `${n.dataset.key}:${n.textContent}`).join('\n') !== before) $('askBody').scrollTop = $('askBody').scrollHeight;
    const empty = !rows.length && !busy;
    $('askEmpty').hidden = !empty;
    panelEmpty = open && empty;
    // (a conversation that has just ended - a new chat - reads the machine afresh for the questions)
    const hasChat = !!(chat && chat.messages.length);
    if (wasChat && !hasChat) { shown = null; chosen = null; }
    wasChat = hasChat;
    // consent
    const pending = session.consent.pending;
    const loading = !!(pending && pending.kind === 'load');
    $('askLoad').hidden = !loading;
    if (loading) $('askLoadText').textContent = loadCardText(pending.load);
    else $('chkAskLoadNoAsk').checked = false;
    // "Don't ask again this session" only while the switch is on: with it off every load asks, so the box is not offered
    $('chkAskLoadNoAsk').closest('label').hidden = !session.consent.allowed;
    if (!session.consent.allowed) $('chkAskLoadNoAsk').checked = false;
    $('askConsent').hidden = !pending || loading;
    if (pending) $('askConsentText').textContent = `To do that, Claude needs to ${pending.name === 'poke' ? 'change memory' : pending.name === 'press_break' ? 'press BREAK' : pending.name === 'assemble_and_load' ? 'load a program into memory' : pending.name === 'run' ? 'start a program' : 'type into BASIC'}. With your permission it can type, POKE, run and press BREAK. You see everything happen on the screen, Stop works at any time, and a restore point is made first so restoring it puts everything back.`;
    // paused while the card waits: "Allow and resume" / "Load and resume", and the line that says why
    const pausedCard = !!pending && !!session.consent.paused;
    drawAccept($('btnAskAllow'), pausedCard, 'Allow', 'Allow and resume');
    drawAccept($('btnAskLoad'), pausedCard, 'Load it', 'Load and resume');
    $('askConsentPaused').hidden = !(pausedCard && !loading);
    $('askLoadPaused').hidden = !(pausedCard && loading);
    if (pausedCard) $(loading ? 'askLoadPaused' : 'askConsentPaused').textContent = PAUSED_CARD_TEXT[loading ? 'load' : 'consent'];
    $('chkAskMachine').checked = session.consent.allowed;
    // a card that has just come up is brought into view (a phone's sheet leaves peek for it): the person must see it
    // (or when the panel opens on it)
    // (only once the panel can be seen: not under a page view, which hides the layout)
    if (!pending || !open || !ask.getClientRects().length) shownPending = null;
    else if (pending !== shownPending) {
      shownPending = pending;
      // (back to the height the sheet had before Claude acted, or half)
      if (phone() && ask.dataset.height === 'peek') { setHeight(ask.dataset.restore || 'half'); delete ask.dataset.restore; }
      $(loading ? 'askLoad' : 'askConsent').scrollIntoView({ block: 'nearest' });
      // (a card taller than the room the sheet leaves it - a phone's half sheet - shows its top above; its buttons are
      // what the person must reach, so they come into view last)
      $(loading ? 'btnAskLoad' : 'btnAskAllow').scrollIntoView({ block: 'nearest' });
    }
    // the turn's status with Stop, whatever the turn is doing (thinking, a tool, a card waiting)
    const status = session.claudeStatus;
    // a sheet the person closed during the turn closes once the turn has ended
    if (closeAfterTurn && !status) { hide(); page.focus(); return; }
    $('askStatus').hidden = !status;
    if (status) $('askStatusText').textContent = claudeStatusText(status);
    $('btnAskStatusResume').hidden = !(status && session.consent.paused);
    // the key states
    const msg = k === 'refused' || k === 'rate-limited' || k === 'offline' || k === 'error';
    $('askKeyMsg').hidden = !msg || !!(chat && chat.busy);
    $('askKeyText').textContent = claude.keyText(k);
    $('btnAskRetry').hidden = !(k === 'rate-limited' || k === 'offline' || k === 'error');
    const form = k === 'none' || k === 'refused' || editingKey;
    $('askKeyForm').hidden = !form;
    $('askKeyForm').classList.toggle('refused', k === 'refused');
    $('askComposer').hidden = k === 'none';
    $('btnAskSend').disabled = k === 'refused' || !!(chat && chat.busy);
    $('askKeyLine').hidden = k === 'none';
    // the key's line says what its state IS, and the button does what it will do: a refused key is still stored (the
    // person may keep it or replace it), so the line says REFUSED and the button says Replace -- "Saved in this
    // browser." beside a refusal told the person the opposite of what just happened.
    const refused = k === 'refused';
    $('askKeyState').textContent = refused ? 'API key · Refused by Anthropic. Still saved in this browser.' : 'API key · Saved in this browser.';
    $('btnAskKeyChange').textContent = refused ? 'Replace' : 'Change';
    renderActing();
  }
  // every other Stop of the turn's, and whether the person can click it now: shown, in the window and not under
  // something else (#viewClaude itself does not count as covering one: it gives way to it)
  // (the touch keyboard lets clicks through (pointer-events: none) but hides what is under it unless that is lifted
  // above it, as the screen and the chat's status are)
  const STOPS = ['btnAskStatusStop', 'btnAskStripStop', 'btnAskStop', 'btnAskPeekStop', 'btnFsStop', 'btnClaudeStop', 'btnPipStop'];
  const lifted = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const z = Number(getComputedStyle(n).zIndex); if (z > 5) return true; } return false; };
  function reachable(id) {
    const e = $(id), r = e.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const x = r.left + r.width / 2, y = r.top + r.height / 2, at = document.elementFromPoint(x, y);
    if (!at || !(at === e || e.contains(at) || at.closest('#viewClaude'))) return false;
    const k = $('touchKeys').hidden ? null : $('touchKeys').getBoundingClientRect();
    return !(k && x >= k.left && x <= k.right && y >= k.top && y <= k.bottom && !lifted(e));
  }
  // the questions under the machine, the pill on the screen, the minimised strip and the phone's peek line
  function renderActing() {
    // (not while a card waits for the person: nothing acts then, and the card needs the sheet open)
    const busy = session.claudeBusyActing && !session.consent.pending && session.claudeView !== 'full';
    const text = claude.activity();
    $('askActing').hidden = !busy;
    if (busy) $('askActingText').textContent = text || 'Claude is using the machine…';
    $('btnAskResume').hidden = !session.consent.paused;
    $('monitor').classList.toggle('claude-acting', !!busy);
    if (busy && phone() && open && ask.dataset.height !== 'peek') { ask.dataset.restore = ask.dataset.height; setHeight('peek'); }
    if (!busy && phone() && open && ask.dataset.restore) { setHeight(ask.dataset.restore); delete ask.dataset.restore; }
    const status = session.claudeStatus;
    $('askPeekText').textContent = busy ? (text || 'Claude is acting…') : status ? claudeStatusText(status) : 'Ask about this machine';
    $('askStripText').textContent = busy ? (text || 'Claude is acting…') : status ? claudeStatusText(status) : 'Ready';
    // the lowered sheet and the minimised strip keep a Stop while a turn is in progress
    $('btnAskPeekStop').hidden = !status;
    $('btnAskStripStop').hidden = $('askStrip').hidden || !status;
    // the browser's Fullscreen: the turn's status with Stop (and Resume while paused), whatever the view; a card
    // waiting for an answer is outside it, so Fullscreen ends to show the card
    const fs = fullscreen() && !!(status || session.claudeBusyActing);
    $('fsClaude').hidden = !fs;
    // (one line there: the short paused text, which keeps "Esc stops Claude")
    if (fs) $('fsClaudeText').textContent = session.consent.paused ? (touchPanel() ? TOUCH_PAUSED_TEXT : CLAUDE_PAUSED_SHORT) : (session.claudeBusyActing && text) || claudeStatusText(status) || 'Claude is acting…';
    $('btnFsResume').hidden = !(fs && session.consent.paused);
    if (fullscreen() && session.consent.pending && document.exitFullscreen && !pageLeft) {
      pageLeft = true;
      document.exitFullscreen().catch(() => { pageLeft = false; });
    }
    // #viewClaude: the turn's status (or Claude's typing still going in) with Stop, Resume while paused, where nothing
    // else shows one: on a page view (they hide the emulator and the panel; Claude's own keys can open one: "3" at the
    // welcome menu is Add ROMs), and in any layout where no other Stop can be reached (the drawer's strip is hidden
    // under a phone's touch keyboard held sideways, for one). On a page view a waiting card has Answer.
    const need = !!(status || session.claudeBusyActing), inView = viewOpen() && need;
    // Measure in the REFERENCE state -- not floating -- then apply the answer. `body.claude-float` moves #toastRegion
    // (play/index.html:1140, bottom 8px -> 96px), which can lift a toast in its natural place OFF the very Stop whose
    // being covered is the reason to float. Deciding from whatever state the class is in makes the answer depend on its
    // own last output: float lifts the toast, the lifted toast leaves the Stop reachable, the next tick hides the pill,
    // the toast falls back over the Stop, and the pill returns -- the flash on and off that `flips <= 1` forbids, while
    // a turn runs and a toast is up. Dropping the class before measuring makes one page state always give one answer,
    // so it settles: floated while a toast covers the last Stop (the lift is then part of the fix and it stays), not
    // floated when a Stop is reachable anyway.
    document.body.classList.remove('claude-float');
    // ... and with the toast placed from this same page state. js/ui/feedback.js keeps its fallback slot off Claude's
    // Stops, but it places at the next frame, and this runs at once when the turn's status changes: a Stop that has just
    // appeared under a pinned toast read as covered here, the pill came up, and went 10 frames later when the toast had
    // moved off it.
    if (need) page.feedback.catchUp();
    const float = need && (inView || !STOPS.some(reachable));
    $('viewClaude').hidden = !float;
    $('viewClaude').classList.toggle('top', float && !inView && document.body.classList.contains('touch-keys'));
    document.body.classList.toggle('view-claude', inView);
    document.body.classList.toggle('claude-float', float && !inView);
    if (float) $('viewClaudeText').textContent = claudeStatusText(status) || text || 'Claude is acting…';
    $('btnViewResume').hidden = !(float && session.consent.paused);
    $('btnViewAnswer').hidden = !(inView && session.consent.pending);
    // the example questions (in the panel's empty chat, or on the line under the screen while it is closed:
    // drawQuestions), and the note line under the machine; nothing in full screen or with Claude features Off
    drawQuestions();
    if (session.claudeView === 'full' || !session.claudeFeatures) { $('askOpeners').hidden = true; return; }
    $('askMachineNote').textContent = busy ? 'Stop on the screen ends Claude\'s turn.' : open ? 'The emulator keeps running while you ask.' : '';
    $('askOpeners').hidden = !$('askMachineNote').textContent;
  }
  claude.onChange(render);
  // back from a page view (the Library, the Debugger…): a card that came up under it is brought into view now
  // (a page view hides the layout, the rail's tab with it: the tab closes, so no Esc goes to a menu that cannot be seen)
  page.onView(() => { if (viewOpen() && railTab) setRail(null); if (open) render(); else renderActing(); }, { every: true });
  // the screen changes without an event: the questions and the pill follow it a few times a second
  let tick = 0;
  page.onFrame(() => {
    if (++tick % 10 !== 0) return;
    renderActing();
    // (what the machine does without an event - RUN typed, a program ending - is seen here)
    if (shown && where() && promptsNow(session).id !== shown) suggestSoon();
  });
  render();
  return { show, hide, get open() { return open; } };
}
