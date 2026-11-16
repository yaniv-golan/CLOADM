/* What the page's panels share: the session, feedback (js/ui/feedback.js: toasts and attention), focus and file
 * helpers. */
import { SessionError } from '../session.js';
import { createFeedback, currentView } from './feedback.js';

export const $ = (id) => document.getElementById(id);
// The views that take the emulator's place, by their #hash (Share, the Library, Add ROMs, the Debugger), opened and
// closed through page.openView / page.closeView
export const VIEWS = Object.freeze(['#share', '#library', '#add-roms', '#debugger']);
export const viewOpen = () => VIEWS.includes(location.hash);

export function createPage(session, audio) {
  const canvas = $('screen');
  const feedback = createFeedback();
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

    // ---- the views: one history model for all of them ----
    // Opening a view from the emulator adds one history entry, so the browser's Back returns to the emulator;
    // opening one from another view replaces that entry, so there is never more than one view above the emulator.
    // Closing ("← Emulator", Esc) goes back over that entry; a view the page was loaded on (a link to #library)
    // has no entry of ours under it, so closing replaces it with the emulator instead of leaving the page.
    openView(hash) {
      if (location.hash === hash) return;
      if (viewOpen()) location.replace(location.pathname + location.search + hash); else location.hash = hash;   // (replace() resolves against <base>)
      history.replaceState({ view: hash }, '');
    },
    closeView() {
      if (!viewOpen()) return;
      addEventListener('hashchange', () => page.focus(), { once: true });   // the screen is back after the change
      if (history.state && history.state.view === location.hash) history.back();
      else { history.replaceState(null, '', location.pathname + location.search); dispatchEvent(new HashChangeEvent('hashchange')); }
    },

    // ---- Esc ----
    // Every surface that can be closed registers here: rank (lower is on top: a confirmation over a menu over a
    // card over a view over the chat), whether it is open, and how it closes. Esc closes the topmost open one
    // (main.js). With the focus on the screen only a question waiting for an answer takes it (a confirmation, a card
    // above the screen: they answer "no"); otherwise Esc there is the machine's BREAK, the full-screen chat
    // included (BREAK stops a streaming reply). A control that uses Esc itself (a rename, the command box, the
    // machine menu, the Ask rail) takes it first and prevents the default.
    escapes: [],
    onEscape(rank, isOpen, close) { page.escapes.push({ rank, isOpen, close }); page.escapes.sort((a, b) => a.rank - b.rank); },
    topEscape(fromScreen) { return page.escapes.find((x) => (!fromScreen || x.rank <= ESC.card) && x.isOpen()); },
    escapable(fromScreen = false) { return !!page.topEscape(fromScreen); },
    escape(fromScreen = false) { const top = page.topEscape(fromScreen); if (top) top.close(); return !!top; },
  };
  return page;
}
// the ranks of page.onEscape, top first
export const ESC = Object.freeze({ confirm: 10, menu: 20, card: 30, view: 40, chat: 50 });
