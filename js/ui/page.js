/* What the page's panels share: the session, feedback (js/ui/feedback.js: toasts and attention), focus and file
 * helpers. */
import { SessionError } from '../session.js';
import { createFeedback, currentView } from './feedback.js';

export const $ = (id) => document.getElementById(id);
// The views that take the emulator's place, by their #hash (Share, the Library, Add ROMs, the Debugger), opened and
// closed through page.openView / page.closeView (the history model is page.openStep)
export const VIEWS = Object.freeze(['#share', '#library', '#add-roms', '#debugger']);
export const viewOpen = () => VIEWS.includes(location.hash);

export function createPage(session, audio) {
  const canvas = $('screen');
  const feedback = createFeedback();
  const LOAD = `${Date.now()}-${Math.random()}`;   // this page load's mark on the history entries it adds
  const viewFns = [feedback.viewChanged], stepFns = [];
  let shown = viewOpen() ? location.hash : '';
  function route() {
    const v = viewOpen() ? location.hash : '';
    if (v !== shown) {
      const closed = shown !== '' && v === '';
      shown = v;
      for (const fn of viewFns.slice()) fn();
      // A view that closes leaves the focus on the screen, whichever way it closed ("← Emulator", Esc, the browser's Back):
      // Back has no control of ours to take the focus (it stays on the page or on the opener's button), and the Ask panel
      // reopening over a conversation (js/ui/claude.js) takes it for its box; the screen is where typing goes.
      if (closed) canvas.focus();
    }
    for (const fn of stepFns.slice()) fn();
  }
  addEventListener('hashchange', route);
  addEventListener('popstate', route);
  const page = {
    session, audio, canvas, feedback,
    get machine() { return session.machine; },
    // an event's message (a toast; an error: a toast with Details), on the page shown now
    status(msg, isError = false) { feedback.toast(msg, { error: isError }); },
    toast: (text, opts) => feedback.toast(text, opts),
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
    toMachine(e) {
      return (e.target === canvas || e.target === document.body || e.target === document.documentElement)
        && e.key !== 'Tab' && e.key !== 'F12' && e.key !== 'F5' && !document.querySelector('dialog[open]')
        && !(e.key === 'Escape' && (e.defaultPrevented || page.escapable(e.target === canvas)));
    },
    // run fn, showing its message (or the error) as a toast
    attempt(fn) {
      try { const msg = fn(); if (msg) page.status(msg); return true; }
      catch (e) { page.status(e.message, true); if (!(e instanceof SessionError)) console.error(e); return false; }
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
    onView(fn, { every = false } = {}) { (every ? stepFns : viewFns).push(fn); },

    // ---- Esc ----
    // Every surface that can be closed registers here: rank (lower is on top: a confirmation over a menu over a
    // card over a view over the chat), whether it is open, and how it closes. Esc closes the topmost open one
    // (main.js). With the focus on the screen only a question waiting for an answer takes it (a confirmation, a card
    // above the screen: they answer "no") or Claude paused by the person's key (Esc is Stop then, in every view,
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
  };
  return page;
}
// the ranks of page.onEscape, top first
// (claude: Claude paused by a key, which Esc stops; under the questions on screen, over the views and the chat)
export const ESC = Object.freeze({ confirm: 10, menu: 20, card: 30, claude: 35, view: 40, chat: 50 });
