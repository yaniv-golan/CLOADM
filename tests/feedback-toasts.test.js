// The toast model of js/ui/feedback.js (createFeedback): order, bounds, duplicates, focus and dismissal, in Node
// with a minimal DOM stub and a fake clock. What the code does (line numbers are of js/ui/feedback.js):
//  * There is NO queue. "one at a time, a new one replaces it" (header, line 7; show() calls end('replaced') first,
//    line 61). Toasts therefore do not come out in FIFO order: the newest is shown and an earlier one is gone for
//    good (its onEnd('replaced') is called), and it never comes back when the newer one ends.
//  * What is held is bounded by construction: one toast showing (`cur`) plus `waiting`, a Map keyed by the page the
//    toast is for, so at most one waiting toast per page ('emulator', 'library', 'roms', 'share'); a newer toast for
//    the same page replaces it (toast(), lines 190-194).
//  * A toast raised for another page waits and shows when the user is there (viewChanged(), line 230), and is
//    dropped if it waited longer than WAIT = 60 s (`Date.now() - w.raised <= WAIT`).
//  * Duplicates are NOT coalesced: the same text twice is two toasts; the second replaces the first and its time
//    starts afresh.
//  * It shows for SHORT 4 s, or LONG 8 s with an action or Details (show(), line 64). It is paused while hovered or
//    focused (pause(), line 205: the timer is cleared and the time left is kept, at least 1 s), and resumed when
//    neither hover nor focus is inside it (resume()).
//  * dismiss(t) ends t only while it is still the one up ("a newer one stays"); clear() ends whatever is up. Ending
//    a toast does not bring any other forward: there is nothing behind it to advance to.
//  * The user's next action (pointerdown outside the toast) clears a toast that has been seen (next(), line 217);
//    leaving its page clears it (viewChanged()), and pagehide ends it ('closed').
// Not asserted here: the timer of a toast that REPLACES a focused one while the focus is still inside the box. The
// replacement is armed without a new focusin, so its 4 s run although the focus sits in the box: whether that meets
// R24 (kept while focused) is a question for the maintainers, not something this file settles by asserting it.
const path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the stub: just what feedback.js and page.js's $ and safeArea read ----
let now = 1_000_000;
let timers = [], nextTimer = 1, frames = [];
globalThis.Date = class extends Date { static now() { return now; } };
globalThis.setTimeout = (fn, ms = 0) => { const id = nextTimer++; timers.push({ id, at: now + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
// advance the clock, running the timers that fall due in order
const advance = (ms) => {
  const end = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = Math.max(now, due.at);
    due.fn();
  }
  now = end;
};
const frame = () => { const f = frames; frames = []; for (const fn of f) fn(); };

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); } remove(c) { this.set.delete(c); } contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); }
}
class El {
  constructor(id) { this.id = id; this.hidden = false; this.textContent = ''; this.style = {}; this.classList = new ClassList(); this.parentNode = null; this.listeners = {}; this.onclick = null; this.children = []; this.dataset = {}; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev, extra = {}) { for (const fn of this.listeners[ev] || []) fn(Object.assign({ type: ev, target: this, stopPropagation() {} }, extra)); }
  replaceChildren(...c) { this.children = c; this.textContent = c.map((x) => (typeof x === 'string' ? x : x.textContent || '')).join(''); }
  getBoundingClientRect() { return { left: 400, top: 600, width: 300, height: 40, right: 700, bottom: 640 }; }
  matches() { return false; }
  contains(n) { return n === this || this.kids.includes(n); }
  setAttribute() {} removeAttribute() {}
}
const els = {};
const get = (id) => (els[id] = els[id] || new El(id));
const box = get('toast'); box.kids = []; box.matches = (sel) => sel === ':hover' && state.hover;
const region = new El('toastRegion'); box.parentNode = region;
const inside = new El('toastButton'); box.kids.push(inside);   // something inside the toast that can hold the focus
const outside = new El('somewhere else');
const state = { hover: false };
const docListeners = {};
globalThis.document = {
  getElementById: get,
  querySelectorAll: () => [], querySelector: () => null,
  body: { classList: new ClassList() },
  documentElement: {},
  activeElement: null,
  addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
  createElement: (t) => new El(t),
};
const docFire = (ev, target, extra = {}) => { for (const fn of docListeners[ev] || []) fn(Object.assign({ type: ev, target, detail: 1 }, extra)); };
const winListeners = {};
globalThis.addEventListener = (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); };
globalThis.location = { hash: '' };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', display: 'block' });
globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
globalThis.matchMedia = () => ({ matches: false });

(async () => {
  const { createFeedback } = await import(path.join(__dirname, '../js/ui/feedback.js'));
  const reasons = (log) => (reason) => log.push(reason);
  const fresh = () => { document.activeElement = null; state.hover = false; globalThis.location.hash = ''; timers = []; frames = []; return createFeedback(); };
  const SHORT = 4000, LONG = 8000, WAIT = 60000;

  // ---- one toast: its text, and its time ----
  {
    const fb = fresh(), ended = [];
    fb.toast('Disk 1 is in drive 0.', { onEnd: (r) => ended.push(r) });
    check('toast: it shows (text up, box not hidden)', fb.current && fb.current.text === 'Disk 1 is in drive 0.' && box.hidden === false);
    advance(SHORT - 1);
    check('toast: still up 1 ms before its 4 s', fb.current !== null && ended.length === 0);
    advance(1);
    check('toast: gone at 4 s, ended once with "timeout"', fb.current === null && box.hidden === true && ended.join() === 'timeout', ended.join());
    const withAction = fb.toast('Typing BASIC needs your BASIC ROM: {action}.', { action: { label: 'Add ROMs', run() {} } });
    advance(SHORT + 1);
    check('toast: with an action it stays past 4 s', fb.current !== null, withAction.text);
    advance(LONG - SHORT - 2);
    check('toast: ... and is still up 1 ms before 8 s', fb.current !== null);
    advance(1);
    check('toast: ... and goes at 8 s', fb.current === null);
    const err = fb.toast('The disk could not be read. It is not a disk image CLOADM knows.', { error: true });
    advance(LONG - 1);
    check('toast: an error with Details also gets the 8 s (up 1 ms before it)', fb.current !== null && err.details && err.details.startsWith('It is not'));
    advance(1);
    check('toast: ... and goes at 8 s', fb.current === null);
  }

  // ---- order: one at a time, the newest replaces; nothing comes back ----
  {
    const fb = fresh(), log = [];
    fb.toast('first', { onEnd: reasons(log) }); fb.toast('second', { onEnd: (r) => log.push(`b:${r}`) });
    check('order: a newer toast replaces the one up (the first is ended "replaced", the second is showing)', fb.current.text === 'second' && log.join() === 'replaced', log.join());
    fb.toast('third'); fb.toast('fourth'); fb.toast('fifth');
    check('order: five toasts raised together leave only the last one up (no FIFO queue)', fb.current.text === 'fifth' && fb.pending.length === 1, JSON.stringify(fb.pending));
    check('order: ... and the ones it replaced were each ended once, with "replaced" (the two that have an onEnd)', log.join() === 'replaced,b:replaced', log.join());
    advance(SHORT);
    check('order: when the last ends nothing comes back from before (no queue behind it)', fb.current === null && box.hidden === true && fb.pending.length === 0);
    check('order: onEnd is called once per toast (a replaced toast\'s own timeout never fires later)', log.join() === 'replaced,b:replaced', log.join());
  }

  // ---- duplicates are not coalesced ----
  {
    const fb = fresh(), log = [];
    fb.toast('Saved.', { onEnd: (r) => log.push(`1:${r}`) });
    advance(3000);
    fb.toast('Saved.', { onEnd: (r) => log.push(`2:${r}`) });
    check('duplicates: the same text raised again is a new toast: the first is replaced, not coalesced', log.join() === '1:replaced', log.join());
    advance(3999);
    check('duplicates: ... and the second has its own full 4 s (the first one\'s clock does not run it out)', fb.current !== null && log.length === 1);
    advance(1);
    check('duplicates: ... then it ends', fb.current === null && log.join() === '1:replaced,2:timeout', log.join());
  }

  // ---- what waits for another page: bounded, one per page, newest wins ----
  {
    const fb = fresh(), log = [];
    const mk = (view, text) => fb.toast(text, { view, onEnd: (r) => log.push(`${text}:${r}`) });
    mk('library', 'lib 1'); mk('library', 'lib 2'); mk('roms', 'roms 1'); mk('share', 'share 1');
    check('waiting: a toast for another page does not show', fb.current === null && box.hidden === true);
    check('waiting: a second toast for the same page replaces the first (one waits per page: 3 here, not 4)', log.join() === 'lib 1:replaced', log.join());
    for (let i = 0; i < 50; i++) mk('library', `again ${i}`);
    check('waiting: fifty more for one page still leave one waiting for it (bounded by the pages, not by the toasts raised)',
      log.length === 1 + 50 && log[log.length - 1] === 'again 48:replaced' && !log.some((l) => l.startsWith('roms') || l.startsWith('share')), `${log.length} ended: ${log.slice(-2)}`);
    globalThis.location.hash = '#library'; fb.viewChanged();
    check('waiting: on that page the newest waiting toast for it shows, and the others stay waiting', fb.current && fb.current.text === 'again 49' && fb.current.view === 'library', JSON.stringify(fb.current));
    globalThis.location.hash = '#share'; fb.viewChanged();
    check('waiting: leaving a page ends its toast "cleared" and shows the one waiting for the new page', fb.current && fb.current.text === 'share 1' && log.includes('again 49:cleared'), log.slice(-2).join());
    advance(SHORT);
    globalThis.location.hash = '#add-roms'; fb.viewChanged();
    check('waiting: and the one for the page after that', fb.current && fb.current.text === 'roms 1');
    advance(SHORT); globalThis.location.hash = '';
  }
  {
    // the minute: kept up to WAIT, dropped after it
    const fb = fresh(), log = [];
    fb.toast('on time', { view: 'library', onEnd: (r) => log.push(`on time:${r}`) });
    advance(WAIT);
    globalThis.location.hash = '#library'; fb.viewChanged();
    check('waiting: a toast that waited exactly 60 s still shows', fb.current && fb.current.text === 'on time' && log.length === 0, JSON.stringify(fb.current));
    advance(SHORT); globalThis.location.hash = ''; fb.viewChanged();
    fb.toast('late', { view: 'roms', onEnd: (r) => log.push(`late:${r}`) });
    advance(WAIT + 1);
    globalThis.location.hash = '#add-roms'; fb.viewChanged();
    check('waiting: one that waited longer than that is dropped (onEnd "dropped"), not shown', fb.current === null && log.join() === 'on time:timeout,late:dropped', log.join());
    globalThis.location.hash = '';
  }

  // ---- focus and hover keep a toast (R24) ----
  {
    const fb = fresh(), log = [];
    fb.toast('Held.', { onEnd: (r) => log.push(r) });
    advance(2000);
    document.activeElement = inside; box.fire('focusin');
    advance(60000);
    check('focus: a focused toast stays (a minute later it is still up, its time stopped)', fb.current !== null && log.length === 0 && box.hidden === false);
    document.activeElement = outside; box.fire('focusout'); advance(0);
    advance(1999);
    check('focus: when the focus leaves, the time that was left runs (2 s of the 4 had gone): up 1999 ms later', fb.current !== null);
    advance(1);
    check('focus: ... and it ends 2 s after the focus left', fb.current === null && log.join() === 'timeout', log.join());
  }
  {
    const fb = fresh(), log = [];
    fb.toast('Almost gone.', { onEnd: (r) => log.push(r) });
    advance(3900);
    state.hover = true; box.fire('pointerenter');
    advance(10000);
    check('hover: a hovered toast stays too', fb.current !== null);
    state.hover = false; box.fire('pointerleave');
    advance(999);
    check('hover: after the pointer leaves it has at least 1 s left (the floor), not the 100 ms it had', fb.current !== null);
    advance(1);
    check('hover: ... then it ends', fb.current === null && log.join() === 'timeout');
  }
  {
    // a focused toast does not block what comes after it
    const fb = fresh(), log = [];
    fb.toast('focused', { onEnd: (r) => log.push(r) });
    document.activeElement = inside; box.fire('focusin');
    fb.toast('newer');
    check('focus: a newer toast is not held back by a focused one: it replaces it at once (the old is ended "replaced")', fb.current.text === 'newer' && log.join() === 'replaced', log.join());
    document.activeElement = null;
  }

  // ---- dismissal ----
  {
    const fb = fresh(), log = [];
    const a = fb.toast('a', { onEnd: (r) => log.push(`a:${r}`) });
    fb.toast('b', { onEnd: (r) => log.push(`b:${r}`) });
    fb.dismiss(a);
    check('dismiss: dismissing a toast that was already replaced does nothing (the newer one stays)', fb.current && fb.current.text === 'b' && log.join() === 'a:replaced', log.join());
    const b = fb.toast('c', { onEnd: (r) => log.push(`c:${r}`) });
    fb.dismiss(b);
    check('dismiss: dismissing the one up ends it ("cleared")', fb.current === null && box.hidden === true && log.join() === 'a:replaced,b:replaced,c:cleared', log.join());
    check('dismiss: and nothing advances: the earlier toasts do not come back', fb.pending.length === 0 && fb.current === null);
    fb.dismiss(null); fb.dismiss(b);
    check('dismiss: dismissing nothing, or again, is harmless (no second onEnd)', log.length === 3, log.join());
    fb.toast('d'); fb.clear();
    check('clear: ends whatever is up', fb.current === null);
    const w = [];
    fb.toast('for the Library', { view: 'library', onEnd: (r) => w.push(r) });
    fb.toast('now'); fb.clear();
    check('dismiss: ending the toast up does not bring a waiting one for another page forward', fb.current === null && w.length === 0);
    globalThis.location.hash = '#library'; fb.viewChanged();
    check('dismiss: ... it waits for its own page', fb.current && fb.current.text === 'for the Library');
    advance(SHORT); globalThis.location.hash = '';
  }

  // ---- the user's next action and leaving ----
  {
    const fb = fresh(), log = [];
    fb.toast('Next action.', { onEnd: (r) => log.push(r) });
    docFire('pointerdown', inside);
    check('next action: a press inside the toast does not clear it', fb.current !== null && log.length === 0);
    docFire('pointerdown', outside);
    check('next action: a press elsewhere clears it ("cleared")', fb.current === null && log.join() === 'cleared', log.join());
    fb.toast('Unload.', { onEnd: (r) => log.push(r) });
    for (const fn of winListeners.pagehide || []) fn({ type: 'pagehide' });
    check('pagehide: ends the toast ("closed"), so what it was holding back happens', fb.current === null && log.join() === 'cleared,closed', log.join());
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
