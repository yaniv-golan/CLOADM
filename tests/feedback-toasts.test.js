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
//  * a new toast replaces a focused or hovered one, without hiding the box; it starts paused while the focus
//    is inside the box (or the pointer over it), and its full time runs from the focusout or pointerleave. The focus
//    stays on the action button only for the same action object, else it moves to the box (tabindex -1). A focus on
//    the second line's button (`also`) is not on the action: it moves to the box.
//  * A toast's `also` is a second line with its own button. It gives the toast the 8 s, a toast without one clears
//    it, its button does nothing once its toast is gone, and ending the toast (timeout or action) clears the line.
//  * a toast with no free place takes the top slot at once, provisionally: while a control is still in an
//    animation of its own (300 ms at most) it moves to a free place as soon as one opens; then it is pinned for good.
//    A hovered or focused provisional toast is not moved.
const path = require('path');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- the stub: just what feedback.js and page.js's $ and safeArea read ----
let now = 1_000_000;
let timers = [], nextTimer = 1, frames = [];
globalThis.Date = class extends Date { static now() { return now; } };
globalThis.setTimeout = (fn, ms = 0) => { const id = nextTimer++; timers.push({ id, at: now + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => { const id = nextFrame++; frames.push({ id, fn }); return id; };
// (the placement runs one cancellable chain: a cancelled frame does not run)
globalThis.cancelAnimationFrame = (id) => { frames = frames.filter((f) => f.id !== id); };
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
const frame = () => { const f = frames; frames = []; for (const { fn } of f) fn(); };

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
  contains(n) { return n === this || (this.kids || []).concat(this.children).some((c) => c === n || (c instanceof El && c.contains(n))); }
  setAttribute() {} removeAttribute() {}
  focus() { document.activeElement = this; focusCalls.push(this.id); }
}
const focusCalls = [];
const els = {};
const get = (id) => (els[id] = els[id] || new El(id));
const box = get('toast'); box.kids = []; box.matches = (sel) => sel === ':hover' && state.hover;
let boxRect = null;   // (the phone case below sets where the stylesheet puts the toast)
box.getBoundingClientRect = () => boxRect || { left: 400, top: 600, width: 300, height: 40, right: 700, bottom: 640 };
const region = new El('toastRegion'); box.parentNode = region;
const body = { insertBefore(el) { el.parentNode = body; } };
region.parentNode = body; region.nextSibling = null;
const layer = { open: false, shows: 0, attr: false };
Object.assign(region, { showPopover() { layer.open = true; layer.shows++; }, hidePopover() { layer.open = false; },
  matches: (sel) => sel === ':popover-open' && layer.open, removeAttribute(a) { if (a === 'popover') layer.attr = false; } });
Object.defineProperty(region, 'popover', { set: (v) => { layer.attr = !!v; }, get: () => (layer.attr ? 'manual' : null) });
const inside = new El('toastButton'); box.kids.push(inside);   // something inside the toast that can hold the focus
const outside = new El('somewhere else');
const state = { hover: false };
// the page's controls, for the placement tests: [{ rect, animations }] (none by default)
let controls = [];
// Opaque overlays ([data-occludes]) and a modal dialog, each with its own buttons
let overlays = [], modal = null;
const rectOf = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const overlay = (id, r, buttons = [], running = false) => ({ id, hidden: false, r, running, getBoundingClientRect() { return this.r; },
  getAnimations() { return this.running ? [{ playState: 'running', pending: false, effect: { getComputedTiming: () => ({ endTime: 200 }) } }] : []; },
  contains: () => false, querySelectorAll: () => buttons.map((b) => ({ getBoundingClientRect: () => b })) });
const control = (rect, running = false) => ({ getBoundingClientRect: () => rect.r, getAnimations: () => (rect.running ? [{ playState: 'running', pending: false, effect: { getComputedTiming: () => ({ endTime: 200 }) } }] : []), rect });
const docListeners = {};
globalThis.document = {
  getElementById: get,
  querySelectorAll: (sel) => (sel.includes('.controls') ? controls : sel === '[data-occludes]' ? overlays : sel === 'dialog:modal' && modal ? [modal] : []),
  querySelector: () => null,
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

  // ---- focus and hover keep a toast ----
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

  // ---- a new toast replaces a focused or hovered one, and where the focus goes ----
  const LONG_ACTION = (label) => ({ label, run() {} });
  {
    // focus on A's button, B with another action: B up and paused, focus on the box, the box never hidden
    const fb = fresh(), a = LONG_ACTION('Undo'), b = LONG_ACTION('Undo');
    fb.toast('A', { action: a });
    // every write of box.hidden = true is recorded (a hide and show within one task would leave no trace otherwise)
    let hides = 0, hiddenNow = box.hidden; const watch = () => {};
    Object.defineProperty(box, 'hidden', { configurable: true, get: () => hiddenNow, set: (v) => { if (v && !hiddenNow) hides++; hiddenNow = v; } });
    document.activeElement = get('toastAction'); box.kids.push(get('toastAction')); box.fire('focusin');
    focusCalls.length = 0;
    const log = [];
    fb.toast('B', { action: b, onEnd: (r) => log.push(r) }); watch(); frame(); watch();
    check('toast replacement, focus: the focus moves to the box when B has another action (equal label, other object)', document.activeElement === box && focusCalls.join() === 'toast', focusCalls.join());
    check('toast replacement, focus: the box is never hidden by the replacement', hides === 0 && box.hidden === false, `${hides} hides`);
    delete box.hidden; box.hidden = hiddenNow;
    advance(10000);
    check('toast replacement, focus: B, focused, is still up 10 s later (it started paused)', fb.current && fb.current.text === 'B' && log.length === 0);
    document.activeElement = outside; box.fire('focusout'); advance(0);
    advance(LONG - 1);
    check('toast replacement, focus: after the focus leaves, B has its full 8 s (up 1 ms before)', fb.current !== null);
    advance(1);
    check('toast replacement, focus: ... and goes at 8 s', fb.current === null && log.join() === 'timeout', log.join());
  }
  {
    // the same action object: the focus stays on the button
    const fb = fresh(), a = LONG_ACTION('Undo');
    fb.toast('A', { action: a });
    document.activeElement = get('toastAction'); box.fire('focusin');
    focusCalls.length = 0;
    fb.toast('B', { action: a }); frame();
    check('toast replacement, focus: with the same action object the focus stays on the button', document.activeElement === get('toastAction') && focusCalls.length === 0, focusCalls.join());
    advance(20000);
    check('toast replacement, focus: ... and B stays (paused while focused)', fb.current && fb.current.text === 'B');
    // no action: to the box
    fb.toast('C'); frame();
    check('toast replacement, focus: a new toast with no action takes the focus to the box', document.activeElement === box);
    advance(20000);
    check('toast replacement, focus: ... and stays while the box holds the focus', fb.current && fb.current.text === 'C');
    document.activeElement = null; box.fire('focusout'); advance(0); advance(SHORT);
    check('toast replacement, focus: ... its 4 s run from the focusout', fb.current === null);
  }
  {
    // the focus outside the box: nothing is focused, the new toast runs at once
    const fb = fresh();
    fb.toast('A'); document.activeElement = outside; focusCalls.length = 0;
    fb.toast('B'); advance(SHORT);
    check('toast replacement, focus: with the focus elsewhere a replacement takes no focus and runs its 4 s', fb.current === null && focusCalls.length === 0 && document.activeElement === outside);
  }
  {
    // hover: B, replacing a hovered A, stays until the pointer leaves, then its full time
    const fb = fresh();
    fb.toast('A'); state.hover = true; box.fire('pointerenter');
    fb.toast('B', { action: LONG_ACTION('Show') });
    advance(10000);
    check('toast replacement, hover: B, replacing a hovered toast, stays while hovered', fb.current && fb.current.text === 'B');
    state.hover = false; box.fire('pointerleave');
    advance(LONG - 1);
    check('toast replacement, hover: ... and has its full 8 s after the pointer leaves', fb.current !== null);
    advance(1);
    check('toast replacement, hover: ... then goes', fb.current === null);
  }

  // ---- a provisional pin ----
  {
    const all = { r: { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }, running: true };
    const shrink = () => { all.r = { left: 0, top: 0, right: 1280, bottom: 100, width: 1280, height: 100 }; };
    const reset = (running) => { all.r = { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }; all.running = running; controls = [control(all)]; };
    const top = () => region.classList.contains('top');
    // a control still moving: pinned in frame 1, moved to the free place when it opens
    reset(true);
    let fb = fresh();
    fb.toast('During a sheet');
    check('provisional pin: with no free place the toast is in the top slot at once, seen', top() && fb.pending[0].seen);
    advance(100); frame();
    check('provisional pin: ... still there while the control moves and nothing is free', top());
    shrink(); all.running = false; frame();
    check('provisional pin: ... and in the free place once the control has stopped (provisional pin)', !top() && fb.current !== null);
    fb.clear();
    // nothing moving: pinned for good at once
    reset(false); fb = fresh();
    fb.toast('Pinned');
    shrink(); frame(); frame();
    check('provisional pin: with no control in an animation the pin is final at once (kept when a place opens)', top());
    fb.clear();
    // still moving after 300 ms: pinned for good then
    reset(true); fb = fresh();
    fb.toast('Long sheet');
    advance(299); frame();
    check('provisional pin: provisional up to 300 ms', top() && fb.current.text === 'Long sheet');
    advance(1); frame();
    shrink(); frame(); frame();
    check('provisional pin: pinned for good at 300 ms although the control still moves', top());
    fb.clear();
    // hovered or focused: not moved
    for (const how of ['hovered', 'focused']) {
      reset(true); fb = fresh();
      fb.toast('Held');
      if (how === 'hovered') state.hover = true; else document.activeElement = inside;
      shrink(); all.running = false; frame(); frame();
      check(`provisional pin: a ${how} provisional toast is not moved`, top());
      state.hover = false; document.activeElement = null;
      fb.clear();
    }
    // landed in the slot while already hovered or focused, nothing moving: it stays provisional past 300 ms, and takes
    // a place that opened meanwhile once it is let go (the pin is made final only when it is not held)
    for (const how of ['hovered', 'focused']) {
      reset(false); fb = fresh();
      if (how === 'hovered') state.hover = true; else { fb.toast('Before'); document.activeElement = inside; }
      fb.toast('Landed held');
      advance(400); frame(); frame();
      shrink(); frame();
      check(`provisional pin: a toast that lands in the slot ${how} stays there past 300 ms while ${how}`, top() && fb.current.text === 'Landed held');
      state.hover = false; document.activeElement = null; frame();
      check(`provisional pin: ... and, let go, takes the place that opened (it was still provisional)`, !top() && fb.current !== null);
      fb.clear();
    }
    controls = [];
  }

  // ---- what an opaque overlay covers, its own controls, the phone's sheet and a modal dialog ----
  {
    const top = () => region.classList.contains('top');
    const placed = () => region.style.left || region.style.top || '';
    // a control over the whole window, all of it under an opaque overlay: the toast may cover that part
    const all = { r: rectOf(0, 0, 1280, 720), running: false };
    controls = [control(all)];
    overlays = [overlay('ask', rectOf(0, 0, 1280, 720), [rectOf(1200, 0, 1280, 40)])];
    let fb = fresh();
    fb.toast('Over the sheet');
    check('opaque overlays: the part of a control under an opaque overlay is not avoided (the toast is in its own place, not pinned)', !top() && placed() === '' && fb.pending[0].seen, JSON.stringify(region.style));
    fb.clear();
    // not settled yet: an overlay still in its own animation hides nothing (the toast takes the slot, provisionally)
    overlays[0].running = true; fb = fresh();
    fb.toast('Sheet still moving');
    check('opaque overlays: an overlay in its own animation occludes nothing yet (the toast is in the top slot)', top());
    overlays[0].running = false; frame();
    check('opaque overlays: ... and once it has settled the toast takes the place it frees (provisional pin)', !top());
    fb.clear();
    // the overlay's own buttons are avoided: one where the toast would go sends it elsewhere along the bottom edge
    overlays = [overlay('ask', rectOf(0, 0, 1280, 720), [rectOf(380, 590, 720, 650)])]; fb = fresh();
    fb.toast('Not over the Stop');
    const x = parseFloat(region.style.left);
    check('opaque overlays: the overlay\'s own controls are avoided in their own right (the toast moves along the bottom edge, clear of the button)',
      !top() && region.style.top === '600px' && (x + 300 <= 380 || x >= 720), JSON.stringify(region.style));
    fb.clear();
    // a phone: never over the sheet, even where it hides a control and has no button
    globalThis.innerWidth = 390; globalThis.innerHeight = 844; boxRect = rectOf(8, 700, 382, 740);
    all.r = rectOf(16, 600, 374, 1100);
    overlays = [overlay('sheet', rectOf(0, 680, 390, 844))]; fb = fresh();
    fb.toast('Phone, sheet at peek');
    check('opaque overlays: on a phone the toast does not go over the sheet: it goes to the top', region.style.top === '8px' && !top(), JSON.stringify(region.style));
    fb.clear();
    globalThis.innerWidth = 1280; globalThis.innerHeight = 720; boxRect = null;
    // a modal dialog: only its controls count, and the region goes into the top layer after it, out when it closes
    all.r = rectOf(0, 0, 1280, 720); overlays = [];
    fb = fresh(); layer.shows = 0;
    fb.toast('Before the dialog');
    check('opaque overlays: with no dialog the region is not a popover', !layer.attr && !layer.open && top());
    fb.clear();
    fb.toast('Under a dialog?');
    const closers = [];
    modal = { querySelectorAll: () => [{ getBoundingClientRect: () => rectOf(0, 0, 100, 40) }], append(el) { el.parentNode = modal; }, addEventListener: (ev, fn) => closers.push(fn) };
    frame();
    check('opaque overlays: a modal dialog opened while a toast is up: the region moves into it and is shown as a popover after it (the top layer)',
      layer.attr && layer.open && layer.shows === 1 && region.parentNode === modal);
    fb.clear();
    fb.toast('In the dialog');
    check('opaque overlays: under a modal dialog only its controls count (the page\'s controls do not pin the toast)', !top() && placed() === '' && layer.open);
    modal = null; closers.forEach((fn) => fn());
    check('opaque overlays: the dialog closed: the region leaves the top layer and goes back where it was, at once (its close event)', !layer.attr && !layer.open && region.parentNode === body);
    fb.clear(); controls = [];
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

  // ---- the second line (`also`): its time, its button, and replacing it ----
  {
    const alsoEl = get('toastAlso'), btnOf = () => alsoEl.children.find((c) => c instanceof El && c.id === 'button');
    const fb = fresh(), runs = [], ended = [];
    fb.toast('ROM removed.', { also: { text: 'The Dragon 64 keeps it until you switch off and on.', action: { label: 'Switch off and on', run: () => runs.push('a') } } });
    check('also: the line shows, with its text and button', alsoEl.hidden === false && alsoEl.textContent.includes('keeps it') && btnOf() && btnOf().textContent === 'Switch off and on');
    const old = btnOf();
    fb.toast('Something else.', { onEnd: (r) => ended.push(r) });
    check('also: a toast without one hides and empties the line', alsoEl.hidden === true && alsoEl.children.length === 0 && alsoEl.textContent === '');
    old.onclick({ stopPropagation() {} });
    check('also: the replaced toast\'s button does nothing (no run, the new toast stays)', runs.length === 0 && fb.current && fb.current.text === 'Something else.' && ended.length === 0);
    advance(SHORT);
    // LONG with `also` and no action, then cleared on timeout
    fb.toast('Two lines.', { also: { text: 'More.', action: { label: 'Go', run: () => runs.push('b') } } });
    advance(SHORT + 1);
    check('also: with an also line and no action it stays past 4 s', fb.current !== null && alsoEl.hidden === false);
    advance(LONG - SHORT - 2);
    check('also: ... and is still up 1 ms before 8 s', fb.current !== null);
    advance(1);
    check('also: ... it goes at 8 s, and the line is hidden and emptied', fb.current === null && alsoEl.hidden === true && alsoEl.children.length === 0);
    // cleared on its action
    const log = [];
    fb.toast('Three.', { onEnd: (r) => log.push(r), also: { text: 'Again.', action: { label: 'Go', run: () => runs.push('c') } } });
    btnOf().onclick({ stopPropagation() {} });
    check('also: its button runs once, ends the toast ("action") and clears the line', runs.join() === 'c' && log.join() === 'action' && fb.current === null && alsoEl.hidden === true && alsoEl.children.length === 0, `${runs.join()} ${log.join()}`);
  }
  {
    // the focus on the also button, a replacement with the same action object: the focus goes to the box, not the action
    const alsoEl = get('toastAlso'), fb = fresh(), a = LONG_ACTION('Undo');
    box.kids.push(alsoEl);
    fb.toast('A', { action: a, also: { text: 'More.', action: LONG_ACTION('Switch off and on') } });
    const ab = alsoEl.children.find((c) => c instanceof El && c.id === 'button');
    document.activeElement = ab; box.fire('focusin');
    focusCalls.length = 0;
    fb.toast('B', { action: a }); frame();
    check('also focus: from the also button, a replacement with the same action moves the focus to the box', document.activeElement === box && focusCalls.join() === 'toast', focusCalls.join());
    document.activeElement = null; box.fire('focusout'); advance(0); advance(LONG);
    box.kids.splice(box.kids.indexOf(alsoEl), 1);
  }

  // ---- afterGone: a one-shot "call me when no toast is up" (wyrmfire's chain waits out a replacement) ----
  {
    const fb = fresh();
    const got = [];
    fb.afterGone(() => got.push('at once'));
    check('afterGone: with no toast up it is called at once', got.join() === 'at once');
    fb.toast('x'); advance(SHORT);
    check('afterGone: it is one-shot (not called again when a toast later ends)', got.length === 1, got.join());

    const fb2 = fresh();
    const got2 = [];
    fb2.toast('holding');
    fb2.afterGone(() => got2.push('gone'));
    check('afterGone: with a toast up it waits (not called while it is up)', got2.length === 0);
    advance(SHORT);
    check('afterGone: ... and is called when that toast ends (timeout, box empty)', got2.join() === 'gone' && fb2.current === null, got2.join());

    const fb3 = fresh();
    const got3 = [];
    fb3.toast('chain A', { onEnd: (r) => { if (r === 'replaced') fb3.afterGone(() => { got3.push('chain B'); fb3.toast('chain B'); }); else got3.push('chain A end'); } });
    check('afterGone: the chain toast is up first', fb3.current && fb3.current.text === 'chain A');
    fb3.toast('unrelated');                                  // replaces chain A mid-chain (the bug's case)
    check('afterGone: replaced: the box stays with the newer toast and the wait does not fire',
      fb3.current && fb3.current.text === 'unrelated' && got3.length === 0, JSON.stringify(got3));
    fb3.toast('another unrelated');                          // a second replacement of the replacement
    check('afterGone: a replacement of the replacement still does not fire it',
      fb3.current && fb3.current.text === 'another unrelated' && got3.length === 0, JSON.stringify(got3));
    advance(SHORT);
    check('afterGone: when the last of the replacements ends, the wait fires and the chain goes on (never two at once)',
      got3.join() === 'chain B' && fb3.current && fb3.current.text === 'chain B', JSON.stringify(got3));
    advance(SHORT);
    check('afterGone: the chain\'s next toast ends on its own time, and nothing is left waiting',
      fb3.current === null && got3.join() === 'chain B', JSON.stringify(got3));

    // a view change while the chain waits: the toast it waits for may be cleared by the change, and one waiting
    // for the page being entered may show. The wait fires only once the box is settled: after that, never before it.
    const fb4 = fresh();
    const got4 = [];
    globalThis.location.hash = '';
    fb4.toast('chain A', { view: 'emulator', onEnd: (r) => { if (r === 'replaced') fb4.afterGone(() => { got4.push('chain B'); fb4.toast('chain B'); }); } });
    fb4.toast('unrelated', { view: 'library' });             // waits for the Library page (does not take the box)
    fb4.toast('now on the emulator', { view: 'emulator' });  // replaces chain A
    globalThis.location.hash = '#library'; fb4.viewChanged();  // clears 'now on the emulator', shows the waiting one
    check('afterGone: a view change that swaps the toast the chain waits for does not fire it early (a toast is up)',
      got4.length === 0 && fb4.current && fb4.current.text === 'unrelated', JSON.stringify([got4, fb4.current && fb4.current.text]));
    advance(SHORT);
    check('afterGone: ... and it fires when that toast ends', got4.join() === 'chain B' && fb4.current && fb4.current.text === 'chain B', JSON.stringify(got4));
  }

  // ---- the two holes the merge review found: a replaced WAITING toast's onEnd, and a waiter that throws ----
  {
    // a toast waiting for another page, replaced there by a newer one, ends 'replaced' OUTSIDE end() (toast()'s
    // waiting-map path). A waiter registered from that onEnd must WAIT (the newer toast is about to take the
    // waiting slot; the box it sees is empty), not fire at once
    const fb = fresh(), got = [];
    globalThis.location.hash = '';
    fb.toast('chain A', { view: 'library', onEnd: (r) => { if (r === 'replaced') fb.afterGone(() => { got.push('chain B'); fb.toast('chain B', { view: 'emulator' }); }); } });
    fb.toast('newer for the library', { view: 'library' });          // replaces chain A in the waiting map
    check('afterGone: a waiter registered from a replaced WAITING toast\'s onEnd does not fire at once (the newer one is about to show)',
      got.length === 0 && fb.current === null, JSON.stringify(got));
    globalThis.location.hash = '#library'; fb.viewChanged();          // the newer waiting toast shows
    check('afterGone: ... and not while the newer toast it waits out is up', got.length === 0 && fb.current && fb.current.text === 'newer for the library', JSON.stringify([got, fb.current && fb.current.text]));
    advance(SHORT);
    check('afterGone: ... and fires when that toast ends: the chain goes on (its next waits for its own page)',
      got.join() === 'chain B' && fb.current === null, JSON.stringify(got));
    globalThis.location.hash = ''; fb.viewChanged();                  // back on the emulator: the chain's next shows
    check('afterGone: ... and shows on its own page', fb.current && fb.current.text === 'chain B', JSON.stringify(fb.current && fb.current.text));
    advance(SHORT);
  }
  {
    // a waiter that throws does not stop the ones behind it: both get their turn, in order
    const fb = fresh(), got = [];
    let threw = false;
    fb.toast('holding');
    fb.afterGone(() => { threw = true; throw new Error('first waiter is broken'); });
    fb.afterGone(() => got.push('second waiter ran'));
    advance(SHORT);
    check('afterGone: a waiter that throws is caught (logged, not fatal), and the drain goes on', threw, JSON.stringify(got));
    check('afterGone: ... the waiter behind it still ran, in order', got.join() === 'second waiter ran', JSON.stringify(got));
    check('afterGone: ... and the box is not left held (the second waiter\'s toast may show)', fb.current === null || fb.current.text === 'second waiter ran', JSON.stringify(fb.current && fb.current.text));
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
