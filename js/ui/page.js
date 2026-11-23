/* What the page's panels share: the session, feedback (js/ui/feedback.js: toasts and attention), focus and file
 * helpers. */
import { SessionError } from '../session.js';
import { createFeedback, currentView } from './feedback.js';

export const $ = (id) => document.getElementById(id);
// Write a property, an inline style or a class only when it changes. Parts refreshed per frame or per poll (the slots
// row, the cassette panel, the tape HUD) use these, so an unchanged value costs no DOM write: setting even the same
// textContent, hidden or title is a mutation the browser has to process.
export const put = (el, key, value) => { if (el[key] !== value) el[key] = value; };
export const putStyle = (el, prop, value) => { if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value); };
export const putClass = (el, name, on) => { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); };
// The views that take the emulator's place, by their #hash (Share, the Library, Add ROMs, the Debugger), opened and
// closed through page.openView / page.closeView (the history model is page.openStep)
export const VIEWS = Object.freeze(['#share', '#library', '#add-roms', '#debugger']);
export const viewOpen = () => VIEWS.includes(location.hash);
// what a press can give the focus to: a press there takes it, so a surface that the press closes leaves it there
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), label, summary, [tabindex], [contenteditable="true"], [contenteditable=""]';
// The part of the window clear of a phone's notch, rounded corners and home indicator: the window less the
// safe-area insets the stylesheet keeps as --safe-t/r/b/l (play/index.html; all 0 off such a phone). Anything a
// script places over the page (a toast, the install offer) must lie inside it.
export function safeArea() {
  const s = getComputedStyle(document.documentElement), px = (n) => parseFloat(s.getPropertyValue(n)) || 0;
  return { left: px('--safe-l'), top: px('--safe-t'), right: innerWidth - px('--safe-r'), bottom: innerHeight - px('--safe-b') };
}

// What the stylesheet hides without the element's own hidden attribute: the emulator's layout, the app bar, the
// footer and the switch confirmation behind a view (body.share-open, .library-open, .roms-open, .debug-open), the
// app bar's links folded behind a phone's Menu, and the settings drawer and the ports under the screen while the
// touch keys or the full-screen chat take their place (body.touch-keys, .claude-open; the Ask rail shows the drawer). display: none already keeps them out of the tab order and the
// accessibility tree, but a reader view that works from the markup (Chrome's reading mode, Readability) does not
// see the stylesheet: each is also made inert and aria-hidden while it is not drawn, and given back when it is.
// An element hidden by its own hidden attribute is left to that attribute. The class changes that show or hide them
// call this at once, so a focus() that follows finds the element no longer inert; a MutationObserver (createPage)
// covers the rest.
const UNDRAWN = '.layout, #appbar, #appbar > nav, body > footer, #switchConfirm, .layout > .drawer, .slots';
// the on-screen panel is up (js/ui/touch-keys.js): the page's words say "tap", and BREAK is its button, not Esc
export const touchPanel = () => document.body.classList.contains('touch-keys');
// Claude's turn paused by the person's key, on a touch screen: there is no Esc to name there, so it says what
// Stop does; one text, short enough for every place that shows it. The Session's own text stays as it is (it is
// browser-free and names Esc): the page chooses.
export const TOUCH_PAUSED_TEXT = 'Paused: you tapped a key · Stop ends Claude\'s turn';
// a status's text (Session.claudeStatus), as the page shows it
export const claudeStatusText = (status) => (status && status.phase === 'paused' && touchPanel() ? TOUCH_PAUSED_TEXT : status && status.text);
// A view (Share, the Library, the Debugger, Add ROMs) shown or closed. A closed view is `hidden`, and also inert and aria-hidden:
// out of the tab order and the accessibility tree by its own state, not only because a stylesheet rule (css/tokens.css) draws
// [hidden] as nothing. Open it with the inert cleared in the same step, so the focus a view takes when it opens finds it.
export function showView(view, open) {
  view.hidden = !open;
  view.inert = !open;
  if (open) view.removeAttribute('aria-hidden'); else view.setAttribute('aria-hidden', 'true');
}

export function markUndrawn() {
  for (const el of document.querySelectorAll(UNDRAWN)) {
    const off = !el.hidden && getComputedStyle(el).display === 'none';
    if (el.inert === off) continue;
    el.inert = off;
    if (off) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
  }
}

export function createPage(session, audio) {
  const canvas = $('screen');
  const feedback = createFeedback();
  const LOAD = `${Date.now()}-${Math.random()}`;   // this page load's mark on the history entries it adds
  const viewFns = [feedback.viewChanged], stepFns = [], firstFns = [];   // firstFns: the same step, before the views
  let shown = viewOpen() ? location.hash : '';
  function route() {
    const v = viewOpen() ? location.hash : '';
    // BEFORE the view branch: a beforeView handler runs on EVERY step, the way an `every: true` one does, and for
    // the same reason. The chat's close is one, and the routes that need it most change no hash at all - Back off
    // the full-screen chat, Esc off the screen, "← Emulator" (the chat is not a view). Placed inside the branch
    // below, it would never run on them and the person would be left in a chat Back and Esc cannot leave.
    for (const fn of firstFns.slice()) fn();
    if (v !== shown) {
      const closed = shown !== '' && v === '';
      shown = v;
      for (const fn of viewFns.slice()) fn();
      markUndrawn();   // (now, not on the class change's mutation: the focus below must find the emulator no longer inert)
      // A view that closes leaves the focus on the screen, whichever way it closed ("← Emulator", Esc, the browser's Back):
      // Back has no control of ours to take the focus (it stays on the page or on the opener's button), and the Ask panel
      // reopening over a conversation (js/ui/claude.js) takes it for its box; the screen is where typing goes.
      if (closed) canvas.focus();
    }
    for (const fn of stepFns.slice()) fn();
  }
  addEventListener('hashchange', route);
  addEventListener('popstate', route);
  // the other ways what is drawn changes: a class on the body or the app bar (a view, the phone's Menu, the touch
  // keys' machine menu) and the layout the window's size picks
  new MutationObserver(markUndrawn).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(markUndrawn).observe($('appbar'), { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', markUndrawn);
  const page = {
    session, audio, canvas, feedback,
    // an event's message (a toast; an error: a toast with Details), on the page shown now
    status(msg, isError = false) { feedback.toast(page.withReleased(msg), { error: isError }); },
    toast: (text, opts) => feedback.toast(page.withReleased(text), opts),
    // "The Debugger's stop at $C0F3 was released.", set by js/ui/debugger-stop.js when a launch released a stop,
    // goes on the launch's own toast (the next one raised in the same turn)
    releasedNote: null,
    withReleased(text) {
      const note = page.releasedNote;
      if (!note) return text;
      page.releasedNote = null;
      return `${text} ${note}`;
    },
    // for an action that finishes later: its messages go to the page it was started on, which shows them when
    // the user is back there (a minute at most)
    reporter() {
      const view = currentView();
      return (msg, isError = false, opts = {}) => feedback.toast(msg, Object.assign({ error: isError, view }, opts));
    },
    focus() { canvas.focus(); },
    // Does this key or paste event go to the machine? Only with the focus on the screen (or on nothing: the page's
    // body, a first visit before any click) and no dialog open. Tab always moves focus; F5 and F12 are the browser's;
    // Esc closes what is open instead (page.escape, main.js): off the screen anything, on it a confirmation or a card.
    // js/ui/screen.js sends what passes to the machine; js/ui/ask.js pauses Claude for the same keys.
    // the program last run (Session.lastRun) while it is what the screen shows now, else null: the page's Pause counts
    runningNow() { return page.session.lastRunOnScreen && !page.paused ? page.session.lastRun : null; },
    toMachine(e) {
      return (e.target === canvas || e.target === document.body || e.target === document.documentElement)
        && e.key !== 'Tab' && e.key !== 'F12' && e.key !== 'F5' && !document.querySelector('dialog[open]')
        && !(e.key === 'Escape' && (e.defaultPrevented || page.escapable(e.target === canvas)));
    },
    // run fn, showing its message (or the error) as a toast
    // split: msg -> [text, details] | null, for a message whose first part is the toast and the rest sits under Details
    attempt(fn, { split = null } = {}) {
      try {
        const msg = fn(), parts = msg && split ? split(msg) : null;
        if (parts) page.toast(parts[0], { details: parts[1] }); else if (msg) page.status(msg);
        return true;
      }
      catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return false; }
    },
    // put a tape in the deck and say so. With no BASIC running the toast offers Load it now (Skip the tape: the tape's
    // program loads and starts), then the usual start toast follows. -> whether the tape went in
    insertTape(name, bytes) {
      let msg;
      try { msg = page.session.insertTape(name, bytes); } catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return false; }
      if (page.session.basicRunning) page.status(msg);
      else page.toast(msg.replace(/\.$/, ': {action}'), { action: { label: 'Load it now', run: () => { page.attempt(() => page.session.skipTape()); page.sheets.closeTape(); } } });
      return true;
    },
    readFile: async (file) => new Uint8Array(await file.arrayBuffer()),
    // hand the user a file (bytes: Uint8Array or Blob)
    download(name, bytes, type = 'application/octet-stream') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    // opts: fetch options (the ROM URLs pass { redirect: 'error' })
    async fetchBytes(url, opts = {}) {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    // Per-frame work for the UI, run from the existing frame loop (js/ui/screen.js) instead of each panel
    // keeping its own setInterval. A panel that needs to follow something that changes over time (the tape
    // motor, the boot state) registers here and unregisters when it no longer needs to; a callback that
    // returns false after running is removed.
    onFrame(fn) {
      page.frameWork.push(fn);
      // removes this callback; it must mutate the same array tickUi() walks, so tickUi() splices in place
      return () => { const i = page.frameWork.indexOf(fn); if (i >= 0) page.frameWork.splice(i, 1); };
    },
    frameWork: [],
    // the Pause button holds the frame loop (js/ui/screen.js owns it): nothing runs, whatever is loaded
    paused: false,
    // Resume, wherever it is pressed (the Pause button, the stop strip, the Debugger's F5), ends both holds:
    // the page's Pause and a Debugger stop (js/ui/screen.js sets it)
    resumeAll: () => {},
    // run the frame callbacks; called once per animation frame by the screen loop, even when the machine ran
    // no frame (the things they follow can change without one, e.g. audio unlocking). A callback that returns
    // false is dropped. Iterating a copy lets a callback remove itself while it runs.
    tickUi() {
      if (!page.frameWork.length) return;
      for (const fn of page.frameWork.slice()) {
        if (!page.frameWork.includes(fn)) continue;
        // A failing callback must not stop the frame loop (which would stop the whole machine), so it is
        // reported and dropped, the way a throwing event listener would not take the page down with it.
        let drop = false;
        try { drop = fn() === false; }
        catch (e) { drop = true; console.error('frame callback failed and was removed', e); }
        if (drop) { const i = page.frameWork.indexOf(fn); if (i >= 0) page.frameWork.splice(i, 1); }
      }
    },

    // ---- the views and the full-screen chat: one history model for all of them ----
    // A view (Share, the Library, Add ROMs, the Debugger) and the full-screen chat each take the emulator's place,
    // and at most one of them is above the emulator at a time, in one history entry. Opening one from the emulator
    // adds that entry, so the browser's Back returns to the emulator; opening one from another (a view from the
    // chat, the chat from a view, a view from a view) replaces the entry, and the one it replaces closes (the chat
    // keeps its conversation for the side panel). "← Emulator" and Esc (page.toEmulator) go back over the entry when
    // this page load added it above the emulator; otherwise (a view or the chat the page was loaded on, an entry left
    // by an earlier load of the page, as after a reload) the entry itself becomes the emulator, so closing never
    // leaves the page and never lands on another view. Wherever it lands, the address is the emulator's: no view
    // hash, no app=claude.
    // The entries carry this load's token: history.state outlives a reload, and an entry of an earlier load has no
    // emulator entry of this load under it.
    onStep(kind) { const s = history.state; return !!(s && s.cloadm === LOAD && s[kind]); },
    openStep(state, url) {
      const s = history.state, own = !!(s && s.cloadm === LOAD);
      if (viewOpen() || page.onStep('claudeChat')) history.replaceState(Object.assign({}, state, { cloadm: LOAD, above: own && !!s.above }), '', url);
      else {
        // The entry under the new one is the emulator. A page loaded on ?app=claude has that in its address, and the
        // emulator entry must not: Back from the chat, or from a view after a reload (which can land on this entry in a
        // new load of the page), would open the chat again.
        const here = new URL(location.href);
        if (here.searchParams.has('app')) { here.searchParams.delete('app'); history.replaceState(history.state, '', here.href); }
        history.pushState(Object.assign({}, state, { cloadm: LOAD, above: true }), '', url);
      }
      route();
    },
    openView(hash) {
      if (location.hash === hash) return;
      page.openStep({ view: hash }, location.pathname + location.search + hash);   // (not relative: they resolve against <base>)
    },
    closeView() { if (viewOpen()) page.toEmulator(); },
    toEmulator() {
      const settle = () => {
        const u = new URL(location.href);
        if (u.searchParams.has('app')) u.searchParams.delete('app');
        if (VIEWS.includes(u.hash)) u.hash = '';
        const s = history.state, keep = s && (s.view || s.claudeChat) ? null : s;
        if (u.href !== location.href || keep !== s) history.replaceState(keep, '', u.href);
        route();
        page.focus();
      };
      const s = history.state;
      if (s && s.cloadm === LOAD && s.above) { addEventListener('popstate', settle, { once: true }); history.back(); }
      else settle();
    },
    // what follows the history: fn runs when the view shown changes (the views show or hide themselves), or, with
    // every: true, on every step (the chat checks whether its entry is still the current one). Both the browser's
    // hashchange and popstate lead here (a browser need not fire hashchange when Back crosses from a pushed entry to
    // a hash, or popstate for a typed #hash), and so do page.openStep and page.toEmulator.
    // beforeView: a handler that must run BEFORE the view handlers on every step, because it decides what the
    // view is above. The chat's is the one: opening a view over the full-screen chat closes the chat (its conversation
    // moves to the side panel), and a view handler that runs first (the Debugger's refresh) would build a debugger on
    // the chat machine - which the close then detaches, in the same route, so that no one ever sees it. Ordering it
    // first means the view handlers run after the chat is gone and nothing is built on it to throw away.
    onView(fn, { every = false, beforeView = false } = {}) { (beforeView ? firstFns : every ? stepFns : viewFns).push(fn); },

    // ---- Esc ----
    // Every surface that can be closed registers here: rank (lower is on top: a confirmation over a menu over a
    // card over a view over the chat), whether it is open, and how it closes. Esc closes the topmost open one
    // (main.js). With the focus on the screen only a question waiting for an answer takes it (a confirmation, a card
    // above the screen: they answer "no"; not an offer nobody asked for, ESC.offer, which leaves the screen's Esc to
    // the machine) or Claude paused by the person's key (Esc is Stop then, in every view,
    // and is not BREAK); otherwise Esc there is the machine's BREAK. The one exception is the full-screen chat
    // (opts.onScreen, a function): its screen is the chat firmware's prompt, where BREAK drops the typed line and
    // stops a streaming reply, so Esc there leaves the chat only when there is nothing for BREAK to do (an idle,
    // empty prompt). A control that uses Esc itself (a rename, the command box, the machine menu, the Ask rail) takes
    // it first and prevents the default.
    escapes: [],
    onEscape(rank, isOpen, close, opts = {}) { page.escapes.push({ rank, isOpen, close, onScreen: opts.onScreen || null }); page.escapes.sort((a, b) => a.rank - b.rank); },
    topEscape(fromScreen) { return page.escapes.find((x) => (!fromScreen || x.rank <= ESC.claude || (x.onScreen && x.onScreen())) && x.isOpen()); },
    escapable(fromScreen = false) { return !!page.topEscape(fromScreen); },
    escape(fromScreen = false) { const top = page.topEscape(fromScreen); if (top) top.close(); return !!top; },
    // A press outside a menu or a box that is open closes it: close(refocus). refocus is true when the press landed on
    // nothing that takes the focus, and close then gives it back to the surface's opener. The browser's own mousedown,
    // which comes after the pointerdown, would move the focus to the page's body: it is prevented then, so the focus
    // stays where close put it. That press, the one that closes the surface, therefore starts no text selection and
    // no drag; the next one does. (A touch's mousedown comes after the finger lifts. Every pointerdown sets keep
    // afresh, so a press that never sends a mousedown, a touch that scrolls, leaves nothing for a later one.)
    outsidePress(isOpen, inside, close) {
      let keep = false;
      addEventListener('pointerdown', (e) => {
        keep = false;
        if (!isOpen() || inside(e.target)) return;
        keep = !(e.target.closest && e.target.closest(FOCUSABLE));
        close(keep);
      }, true);
      addEventListener('mousedown', (e) => { if (keep) { keep = false; e.preventDefault(); } }, true);
    },
  };
  return page;
}
// the ranks of page.onEscape, top first
// (claude: Claude paused by a key, which Esc stops; under the questions on screen, over the views and the chat)
// (offer: a card nobody asked for, js/ui/install.js's automatic install offer. Below claude, so the screen's Esc
// never reaches it and stays the machine's BREAK; off the screen it is closed like any card, over the views.)
// (sheet: a phone's sheet, js/ui/phone-sheets.js: under the menus and cards that open over it, over Claude's panel)
export const ESC = Object.freeze({ confirm: 10, menu: 20, card: 30, sheet: 33, claude: 35, offer: 36, view: 40, chat: 50 });
