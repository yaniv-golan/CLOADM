/*
 * The feedback model (UX finding FB-1): no single status line. Every message
 * is one of four kinds, chosen by one question: does it describe a state that is still true, or an event that just
 * happened?
 *   1 inline status   a state true now, about one control: it lives on the control (the drives, the tape deck, the
 *                     ROM rows, the assembler's errors) and is the panels' own business, not this module's
 *   2 toast           an event the user caused whose result has no visible home: toast(text, opts). 4 s, or 8 s
 *                     with an action (Undo, Show, Load, Details); paused while hovered or focused; one at a time,
 *                     a new one replaces it. Light on dark, bottom centre (full width above the bottom edge on a
 *                     phone), role="status"
 *   3 attention       something blocking the user should act on: attention(text, opts), until resolved or
 *                     dismissed, orange, at most one per page, role="alert" once when it first appears
 *   4 on the machine  what the machine says itself (BASIC, the tape's S/F, typed POKEs): never repeated here
 * Rules: a message appears on the page where the user is; a toast raised for another page waits
 * and shows when the user is back there, and is dropped after a minute. The user's next action (a click, a change,
 * a drop) clears any toast about the previous one. An action's error is a toast with Details (8 s), its first
 * sentence on the toast and the rest under Details, unless it blocks the machine (attention).
 * Pages: 'library' while the Library is open (#library), 'roms' while adding ROMs (#add-roms), 'share' for Capture &
 * share (#share), else 'emulator'
 * (the Debugger is the emulator page's assembler panel today).
 */
import { $, safeArea } from './page.js';

const SHORT = 4000, LONG = 8000, WAIT = 60000;
// where a toast's action button stands inside its sentence (toast text 'Typing BASIC needs your BASIC ROM: {action}.')
const INLINE = '{action}';
export const currentView = () => ({ '#library': 'library', '#add-roms': 'roms', '#share': 'share' }[location.hash] || 'emulator');
// where an attention card sits on each page: over the screen on the emulator, under the header elsewhere
const ATTENTION_HOME = { emulator: () => document.querySelector('#monitor .tube'), library: () => document.querySelector('#library .libhead'), roms: () => document.querySelector('#romCard .libhead'), share: () => document.querySelector('#share > header') };

// "First sentence. The rest." -> [first, rest]; a message without a second sentence has no details
export function splitDetails(text) {
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  return m && m[1].length >= 12 ? [m[1], m[2]] : [text, null];
}

// The placement decision, as data in and data out -- PURE. It reads no document, no window, no element and no
// module state: everything it can consult is in `inputs`, which `readInputs()` builds. That is the point of the shape:
// a read the decision needs but the inputs do not carry cannot be written, so the decision and the identity of the
// decision (JSON.stringify(inputs)) cannot drift. (An earlier version kept a separate list as the cache key beside a
// place() that still read the DOM; three different omissions in that list passed every test.)
//   inputs: see readInputs()
//   -> { kind: 'natural' }                      the stylesheet's own place
//    | { kind: 'placed', left, top, width }     CSS px strings (width null: the stylesheet's width)
//    | { kind: 'band', band, offText, fullWidth } the band under the screen's text; the caller measures the two forms
//    | { kind: 'top' }                          the fixed slot at the top of the viewport
export function decide(I) {
  const { box: r, phone, area, controls, screen, tube: t, canvas: c, active, sideKeys = false } = I;
  const w = r.width, h = r.height;
  const hits = (a, o) => !(a.bottom <= o.top || a.top >= o.bottom || a.right <= o.left || a.left >= o.right);
  const rect = (left, top) => ({ left, top, right: left + w, bottom: top + h });
  const inView = (a) => a.left >= area.left && a.right <= area.right && a.top >= area.top && a.bottom <= area.bottom;
  const free = (a, avoid) => inView(a) && avoid.every((o) => !hits(a, o));
  const tries = [[r.left, r.top, true]];   // [left, top, also avoid the screen?]
  if (!phone) {
    const xs = [];
    for (let x = area.left + 16; x + w <= area.right - 16; x += 8) xs.push(x);
    xs.sort((a, b) => Math.abs(a - r.left) - Math.abs(b - r.left));
    for (const x of xs) tries.push([x, r.top, true]);
  }
  // the screen's visible text, and the band under it inside what shows of the screen. A phone held sideways with the
  // touch keys (sideKeys): the screen column has the window's height and the picture sits in the middle of its tube, so
  // the band reaches the tube's foot, the black glass under the picture: the one place there that covers neither the
  // text nor a key
  const text = c && c.width ? (() => {
    const f = (active || '0,0,1,1').split(',').map(Number);
    return { left: c.left + f[0] * c.width, top: c.top + f[1] * c.height, right: c.left + f[2] * c.width, bottom: c.top + f[3] * c.height };
  })() : null;
  const band = t && t.width && t.height && text ? { left: Math.max(t.left, c.left, area.left) + 8, right: Math.min(t.right, c.right, area.right) - 8,
    top: text.bottom + 2, bottom: Math.min(t.bottom, sideKeys ? Infinity : c.bottom, area.bottom) - 4 } : null;
  const offText = controls.concat(text ? [text] : []);
  tries.push([r.left, area.top + (phone ? 8 : 16), true]);
  const at = tries.find(([x, y, avoidScreen]) => free(rect(x, y), avoidScreen ? controls.concat(screen) : controls));
  if (at) {
    if (at[0] === r.left && at[1] === r.top) return { kind: 'natural' };
    // (the width the writer must set is the toast's own on a phone -- recorded here so it can be re-applied)
    return { kind: 'placed', left: `${Math.round(at[0])}px`, top: `${Math.round(at[1])}px`, width: phone ? `${Math.round(w)}px` : null };
  }
  if (band && band.right - band.left > 40 && band.bottom - band.top > 12) return { kind: 'band', band, offText, fullWidth: w };
  return { kind: 'top' };
}

export function createFeedback() {
  const box = $('toast'), textEl = $('toastText'), actEl = $('toastAction'), detEl = $('toastDetails'), moreEl = detEl;
  const attBox = $('attention'), attText = $('attentionText'), attAct = $('attentionAction');
  let cur = null;                     // { text, error, action, details, view, ends, onEnd, timer, left, paused }
  const waiting = new Map();          // view -> toast raised while the user was elsewhere
  let att = null;

  function end(reason) {
    if (!cur) return;
    const t = cur;
    cur = null;
    clearTimeout(t.timer);
    stopFollow();               // nothing places a toast that has gone
    pinnedArea = null;          // (the next toast's slot is placed from its own inputs)
    box.hidden = true;
    unplace();
    dropClass(box, 'error'); dropClass(box, 'compact');   // (a form left on measured the NEXT toast's first frame)
    textEl.textContent = ''; detEl.textContent = ''; actEl.textContent = '';
    if (t.onEnd) t.onEnd(reason);
  }
  function arm() {
    clearTimeout(cur.timer);
    cur.started = Date.now();
    const t = cur;
    cur.timer = setTimeout(() => { if (cur === t) end('timeout'); }, cur.left);
  }
  function show(t) {
    // (a toast is in view from the frame it appears in: a newer one replaces it)
    end('replaced');
    cur = t;
    t.seen = false;
    dropClass(box, 'compact');   // (a previous toast may have left the compact form on: measure this one fresh)
    decided = null;                 // a new toast: measure afresh
    t.left = t.action || t.details ? LONG : SHORT;
    // an action named in the sentence itself ("… your BASIC ROM: [Add ROMs]. Or …"): its button stands where the
    // text says {action}, so the sentence reads on through it; otherwise it follows the text
    const at = t.action ? t.text.indexOf(INLINE) : -1;
    if (at >= 0) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'inline'; b.textContent = t.action.label;
      b.onclick = (e) => { e.stopPropagation(); if (cur !== t) return; end('action'); t.action.run(); };
      textEl.replaceChildren(t.text.slice(0, at), b, t.text.slice(at + INLINE.length));
    } else textEl.textContent = t.text;
    box.classList.toggle('error', !!t.error);
    actEl.hidden = (!t.action || at >= 0) && !t.details;
    actEl.textContent = t.action && at < 0 ? t.action.label : t.details ? 'Details' : '';
    detEl.hidden = true;
    moreEl.textContent = t.details || '';
    box.hidden = false;
    follow(t);      // its timer starts when it is first in view (seen)
  }
  // in view for the first time: from now its time runs
  function seen() { if (cur && !cur.seen) { cur.seen = true; if (!cur.paused) arm(); } }
  // Where a toast sits on the emulator page. Two rules, in this order: a toast is never invisible (R24), and it
  // covers no control (the header, the machine controls, the slots and the cartridge card, the drawer, an attention
  // card, the on-screen keys, the chat's bar) where it can help it. The stylesheet's place first (bottom centre; full
  // width at the bottom on a phone) if it covers neither a control nor the screen; then, on a desktop, along the bottom
  // edge where nothing is under it (at 1440 x 900, below the settings drawer); then along the top edge; then on the
  // screen's border under its text (compact there if need be), never over the text itself (a toast never covers
  // screen text: it is the user's to read). Placed again every frame while it is up (follow), so a control that moves
  // or grows under it (the drawer filling in after the toast appeared) never ends up covered. When none of those
  // places is free, "never invisible" wins over "never covers a control": the toast takes a fixed slot at the top of
  // the viewport (#toastRegion.top: above everything but the dialogs), keeps that slot until it goes (it is not
  // placed again, so it does not jump about under the user's eyes), and its time starts there. A toast's time starts
  // when it is first in view, which is now always the frame it appears in. Elsewhere (the Library, Your ROMs, Share)
  // the stylesheet's place holds.
  const region = box.parentNode;
  // (the install offer too: a toast must never cover it, in any of its layouts)
  const CONTROLS = 'header, .controls, .slots, aside.drawer, #attention, #touchKeys button, #claudeBar, #installOffer, #tapeHud:not([hidden]), #btnShowKeys:not([hidden])';
  // Class changes that queue NO mutation when they change nothing. In a real browser `classList.remove('x')` and
  // `add('x')` queue a class-attribute mutation whether or not 'x' was there (measured in Chromium: 10 remove() calls
  // of an absent class on an element that has a class attribute give 10 records; `toggle('x', false)` gives 0), so a
  // placed toast that re-applied its placement every frame -- or a natural toast re-applying -- rewrote a class
  // attribute per frame even though nothing changed. `toggle(c, on)` is the one form that is silent when it changes
  // nothing, so every class change goes through these two and a call site cannot reintroduce the churn.
  const addClass = (el, c) => el.classList.toggle(c, true);
  const dropClass = (el, c) => el.classList.toggle(c, false);
  // ONE writer for the region's inline style, and it writes only what changed. Main wrote eleven properties every
  // frame (6 in unplace, 5 in put): 2,715 style-attribute writes in a 3 s load window, 2,714 of them byte-identical.
  // Clearing six already-empty properties every frame is exactly the thrash this fixes, so each writer compares before
  // it writes and leaves an already-correct property alone.
  const PROPS = ['left', 'top', 'right', 'bottom', 'transform', 'width'];
  // The stylesheet's own place: no inline style at all. Clear what a placed toast set, and only if something is there.
  function clearRegion() {
    // nothing inline to clear: leave it (the stylesheet's place already holds, and a stationary toast must cost no
    // writes at all -- clearing six already-empty properties every frame is exactly the thrash this fixes)
    if (region.style.cssText === '') return;
    for (const k of PROPS) if (region.style[k] !== '') region.style[k] = '';
    dropClass(region, 'top');
  }
  // Place the toast: { left, top, width|null } px values. Writes a property only when its value changes.
  // the writers' shared helpers (place() is a thin shell now: put/hitsRect/inViewOf are the only geometry it has)
  const px = (v) => (typeof v === 'number' ? `${Math.round(v)}px` : v);
  const put = (left, top, width = null) => placedAt(px(left), px(top), width === null ? null : px(width));
  const hitsRect = (r, o) => !(r.bottom <= o.top || r.top >= o.bottom || r.right <= o.left || r.left >= o.right);
  const inViewOf = (c, area) => c.left >= area.left && c.right <= area.right && c.top >= area.top && c.bottom <= area.bottom;
  function placedAt(left, top, width) {
    const want = { left, top, width };
    for (const k of ['left', 'top', 'width']) {
      const v = k === 'width' ? (width === null ? '' : width) : want[k];
      if (region.style[k] !== v) region.style[k] = v;
    }
    for (const [k, v] of [['transform', 'none'], ['right', 'auto'], ['bottom', 'auto']]) if (region.style[k] !== v) region.style[k] = v;
    dropClass(region, 'top');
  }
  // The fixed top slot: the class carries the rest, the two inline properties pin it away from the stylesheet's edge.
  // `area` and `phone` are the decision's own inputs, passed in rather than read again: a second `innerWidth` read here
  // was a DOM read outside readInputs(), so this writer could disagree with the key that recorded the decision.
  function placedTop(area, phone, barBottom = 0) {
    clearRegion();
    addClass(region, 'top');
    // the slot is inside the safe area: clear of a phone's notch (viewport-fit=cover) as well as of the top edge
    // and under the app bar where it shows (a toast never covers the bar's buttons)
    const top = `${Math.round(Math.max(area.top + (phone ? 8 : 16), barBottom ? barBottom + 8 : 0))}px`;
    if (region.style.top !== top) region.style.top = top;
    if (region.style.bottom !== 'auto') region.style.bottom = 'auto';
  }
  // back to the stylesheet's place (a toast that ends, or one placed afresh)
  function unplace() { clearRegion(); }
  // Everything place()'s decision reads, as one string: if it is unchanged the answer is unchanged, so a stationary
  // toast needs no measurement and no write. (The controls' geometry is in it: a control that grows under the toast is
  // a different answer, which is what the browser check's "a control grows under it" case needs.)
  let measuredFor = null, decided = null;
  // the safe-area key the pinned slot was last placed with (a phone's rotation changes --safe-t)
  let pinnedArea = null;
  // EVERY DOM read the placement needs, in one place and nowhere else. `place()` decides from exactly this object and
  // uses it as the identity of the decision, so an input cannot be read by the decision and forgotten by the key.
  function readInputs() {
    const t = box.getBoundingClientRect(), area = safeArea();
    const cv = document.getElementById('screen'), tubeEl = document.querySelector('#monitor .tube');
    const boxOf = (o) => (o ? { left: o.left, top: o.top, right: o.right, bottom: o.bottom, width: o.width, height: o.height } : null);
    return {
      phone: innerWidth <= 700, area: { ...area },
      box: boxOf(t), classes: `${box.className}|${region.className}|${document.body ? document.body.className : ''}`,
      // the elements place() avoids: the controls, and #monitor itself (its bezel padding changes with the chat's
      // phone layout) with the screen and the tube inside it
      controls: [...document.querySelectorAll(CONTROLS)].map((e) => e.getBoundingClientRect()).filter((o) => o.width && o.height).map(boxOf),
      screen: [...document.querySelectorAll('#monitor, #monitor .tube, #screen')].map((e) => e.getBoundingClientRect()).filter((o) => o.width && o.height).map(boxOf),
      tube: boxOf(tubeEl && tubeEl.getBoundingClientRect()), canvas: boxOf(cv && cv.getBoundingClientRect()),
      active: cv ? cv.dataset.active || '0,0,1,1' : '',
      // a phone held sideways with the touch keys (decide's band reaches the tube's foot there)
      sideKeys: !!(document.body && document.body.classList.contains('touch-keys')) && matchMedia('(orientation: landscape) and (max-height: 500px)').matches,
      // the app bar's bottom edge where it shows (the top slot stands under it: a toast never covers the bar's buttons)
      barBottom: (() => { const bar = document.getElementById('appbar'); if (!bar) return 0; const b = bar.getBoundingClientRect(); return b.height && b.bottom > 0 && getComputedStyle(bar).display !== 'none' ? b.bottom : 0; })(),
    };
  }
  // put back the placement an unchanged frame would have decided on (writes only if something moved). `decided` is
  // only ever 'natural' or 'placed' here: a 'top' toast is pinned and handled in `place` before the cache is read.
  function reapply() {
    if (decided.kind === 'natural') { unplace(); dropClass(box, 'compact'); return; }
    if (decided.compact !== undefined) box.classList.toggle('compact', decided.compact);
    placedAt(decided.left, decided.top, decided.width);
  }
  function place() {
    // In the top slot (pinned): the toast stays there until it goes, so no re-decision. But the slot's TOP comes from
    // the safe area, which a phone's rotation changes (--safe-t is env(safe-area-inset-top): a notch at the top in
    // portrait, at the side in landscape). Keeping the pin's original top left it under the notch after a rotation, so
    // when the safe-area insets change the slot is re-applied from the new inputs -- the same slot, moved. This is the
    // only thing a pinned toast still reads, and only while the insets are unchanged does it cost nothing.
    if (cur && cur.pinned && !box.hidden) {
      // the phone flag too: the slot's offset is 8 px on a phone and 16 px otherwise, so crossing 700 px with the
      // safe area unchanged still needs the slot re-applied (an 8 px offset left on a wide window, or the reverse).
      const A = readInputs(), a = A.area, areaKey = `${a.top}|${a.left}|${a.bottom}|${a.right}|${A.phone}`;
      if (areaKey !== pinnedArea) { placedTop(a, A.phone, A.barBottom); pinnedArea = areaKey; }
      return;
    }
    if (box.hidden) { unplace(); return; }
    if (currentView() !== 'emulator') { unplace(); seen(); return; }
    // Read, compare, and only when something changed decide and write. The decision needs the NATURAL box (no inline
    // style), so a previous placement is cleared before the decision is measured; a frame whose inputs are unchanged
    // puts the same placement back and satisfies every read from `decided`. `decided` is `{ ...verdict, compact }`
    // where `compact` is the form the band branch needed, so a re-apply writes the same thing without measuring.
    //
    // THE KEY IS THE STATE THE NEXT FRAME WILL COMPARE, so it is recorded AFTER the write, by `settle()`, from every
    // branch. The compare above reads the toast where it is now -- placed, once it has been placed -- so recording the
    // key before the write (at the natural spot) meant a placed toast could never hit: the probe was its placed rect,
    // the key its natural one, they differed every frame, and every frame cleared the region and wrote it again (12
    // style writes a frame on a phone's top-edge path, 10 on the desktop bottom-edge scan; main did 12 and 11). The
    // band path always recorded after its put(), which is why the band cached and the placed branch did not.
    const probe = readInputs();
    const key = JSON.stringify(probe);
    if (decided && key === measuredFor) { reapply(); seen(); return; }
    unplace();
    // the decision is measured from the NATURAL box, so this read follows unplace() (never reuse `probe`: it was taken
    // with the previous placement's inline style on, which would decide from the placed rect)
    const I = readInputs();
    const d = decide(I);
    // `settle()` records the key from the state the page is actually in now; `box`'s class and the region's own inline
    // style are both inputs, so this must follow the last write of each branch.
    const settle = () => { measuredFor = JSON.stringify(readInputs()); };
    if (d.kind === 'natural') { decided = d; dropClass(box, 'compact'); settle(); seen(); return; }
    if (d.kind === 'placed') { put(d.left, d.top, d.width); decided = d; settle(); seen(); return; }
    if (d.kind === 'band') {
      // the compact form is a layout question, so it is measured here; `decided` records which form fit, so the
      // re-apply never measures again
      for (const compact of [false, true]) {
        box.classList.toggle('compact', compact);
        const bw = Math.min(compact ? Infinity : d.fullWidth, d.band.right - d.band.left);
        put(0, 0, bw);
        const bb = box.getBoundingClientRect(), x = (d.band.left + d.band.right - bb.width) / 2, y = (d.band.bottom - bb.height);
        const spot = { left: x, top: y, right: x + bb.width, bottom: y + bb.height };
        if (y >= d.band.top && inViewOf(spot, I.area) && d.offText.every((o) => !hitsRect(spot, o))) {
          put(x, y, bw);
          decided = { kind: 'placed', left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, width: `${Math.round(bw)}px`, compact };
          settle();   // (after put(): the region's width is part of the key)
          seen(); return;
        }
      }
      dropClass(box, 'compact');
    }
    // nowhere it covers no control: the fixed slot at the top of the viewport, kept until the toast goes
    dropClass(box, 'compact');
    placedTop(I.area, I.phone, I.barBottom);
    decided = { kind: 'top' };
    // NO settle() here, and no `reapply` arm for 'top': pinning below makes `place` return at its first line on every
    // later frame, so this key is never compared again -- recording it would be a dead store (measured: reapply never
    // runs with a 'top' decision). The slot is kept by the pin, not by the cache.
    cur.pinned = true; pinnedArea = `${I.area.top}|${I.area.left}|${I.area.bottom}|${I.area.right}|${I.phone}`;
    seen();
  }
  // followed every frame while it is up: a control can move under it without the window scrolling or resizing
  // (the drawer filling in, a bar appearing above the slots), and it must never end up over one
  // One placement chain for the page, cancelled when no toast is up. On main every show() started its own and none
  // was ever cancelled: replacing a toast three times in a task left three chains placing the SAME frame (measured:
  // three different positions written per frame), and each toast of a session added a loop that only ever returned
  // early. `raf` is the chain in flight (null: none).
  let raf = null;
  function follow(t) {
    if (cur !== t || raf !== null) return;          // (a chain is already running for this toast)
    const step = () => {
      raf = null;
      if (cur !== t) return;                        // this toast is gone: the chain ends here
      place();
      if (cur === t) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopFollow() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }
  // text: what happened; error: an action failed; action: { label, run } (Undo, Show, Load); details: more text
  // (an error's sentences after the first go there by default); view: the page it belongs to (default: the one
  // shown); onEnd(reason): called once when it goes ('timeout', 'replaced', 'cleared', 'action', 'dropped', 'closed')
  function toast(text, { error = false, action = null, details, view = currentView(), onEnd = null } = {}) {
    if (details === undefined && error && !action) [text, details] = splitDetails(String(text));
    const t = { text: String(text), error, action, details: details || null, view, onEnd, raised: Date.now() };
    if (!action) t.text = t.text.replace(INLINE, '');
    if (view !== currentView()) {
      const old = waiting.get(view);
      if (old && old.onEnd) old.onEnd('replaced');
      waiting.set(view, t);
      return t;
    }
    show(t);
    return t;
  }
  actEl.onclick = (e) => {
    e.stopPropagation();
    if (!cur) return;
    if (cur.action) { const t = cur; end('action'); t.action.run(); return; }
    detEl.hidden = !detEl.hidden;      // Details: shows the rest of an error
    actEl.textContent = detEl.hidden ? 'Details' : 'Hide';
  };
  // paused while hovered or focused
  const pause = () => { if (cur && !cur.paused) { cur.paused = true; clearTimeout(cur.timer); if (cur.seen) cur.left = Math.max(1000, cur.left - (Date.now() - cur.started)); } };
  const resume = () => { if (cur && cur.paused && !box.matches(':hover') && !box.contains(document.activeElement)) { cur.paused = false; if (cur.seen) arm(); } };
  box.addEventListener('pointerenter', pause);
  box.addEventListener('pointerleave', resume);
  box.addEventListener('focusin', pause);
  box.addEventListener('focusout', () => setTimeout(resume, 0));
  // the user's next action clears the toast about the previous one (before the action's own handler runs)
  // (a text field's change fires when it loses focus, often as the field goes away after its own action: not one)
  const typed = (t) => t.matches && t.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="url"]');
  // A pointer gesture is the next action from its pointer-down; its click (at pointer-up) does not then clear a toast
  // the gesture itself raised (the on-screen keyboard acts at pointer-down: a key that starts a program says so
  // before the tap's click arrives)
  let downAt = -Infinity;
  const next = (e) => {
    if (!cur || !cur.seen || box.contains(e.target) || (e.type === 'change' && typed(e.target))) return;   // (one not seen yet is not cleared)
    if (e.type === 'click' && cur.raised >= downAt && e.detail > 0) return;   // raised by this gesture (a keyboard click has detail 0)
    end('cleared');
  };
  document.addEventListener('pointerdown', (e) => { next(e); downAt = Date.now(); }, true);
  for (const ev of ['click', 'change', 'drop']) document.addEventListener(ev, next, true);
  // leaving the page ends the toast, so what it was holding back happens (a Library delete is committed)
  addEventListener('pagehide', () => end('closed'));
  // another page (page.onView calls it on every change of view): the toast goes with the page it was about; one
  // raised for the page now shown appears
  function viewChanged() {
    const v = currentView();
    if (cur && cur.view !== v) end('cleared');
    const w = waiting.get(v);
    if (w) {
      waiting.delete(v);
      if (Date.now() - w.raised <= WAIT) show(w); else if (w.onEnd) w.onEnd('dropped');
    }
    renderAttention();
  }

  // ---------------- attention: one per page, until resolved or dismissed
  function renderAttention() {
    const v = currentView(), show = !!att && att.view === v;
    attBox.hidden = !show;
    if (!show) return;
    const home = ATTENTION_HOME[v]();
    if (v === 'emulator') { if (attBox.parentNode !== home) home.append(attBox); } else if (attBox.previousElementSibling !== home) home.after(attBox);
    attBox.classList.toggle('over', v === 'emulator');
    attText.textContent = att.text;
    attAct.hidden = !att.action;
    attAct.textContent = att.action ? att.action.label : '';
    if (!att.announced) { att.announced = true; attBox.setAttribute('role', 'alert'); } else attBox.removeAttribute('role');
  }
  function attention(text, { action = null, view = currentView(), key = null } = {}) {
    att = { text: String(text), action, view, key, announced: false };
    renderAttention();
  }
  // resolved: clear it (only the one with this key, when one is given)
  function resolve(key = null) { if (att && (key === null || att.key === key)) { att = null; renderAttention(); } }
  attAct.onclick = () => { if (att && att.action) att.action.run(); };
  $('attentionClose').onclick = () => resolve();

  return {
    toast, attention, resolve, viewChanged,
    clear: () => end('cleared'),
    // this toast goes now, if it is still the one up (a hint its program's first key has made moot); a newer one stays
    dismiss: (t) => { if (t && cur === t) end('cleared'); },
    // (text: with the action's label where an inline action stands, as the toast reads)
    get current() { return cur ? { text: cur.text.replace(INLINE, cur.action ? cur.action.label : ''), error: cur.error, view: cur.view } : null; },
    // the toast up, and whether its time is running (seen)
    get pending() { return (cur ? [cur] : []).map((t) => ({ text: t.text, seen: !!t.seen })); },
    get attentionText() { return att ? att.text : null; },
    // the placement's inputs, read from the page: the placement loop and its tests use it (the decision itself never
    // reads the DOM, so this is the one place that does)
    readPlacementInputs: readInputs,
  };
}
