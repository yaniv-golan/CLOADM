/*
 * The feedback model: no single status line. Every message
 * is one of four kinds, chosen by one question: does it describe a state that is still true, or an event that just
 * happened?
 *   1 inline status   a state true now, about one control: it lives on the control (the drives, the tape deck, the
 *                     ROM rows, the assembler's errors) and is the panels' own business, not this module's
 *   2 toast           an event the user caused whose result has no visible home: toast(text, opts). 4 s, or 8 s
 *                     with an action (Undo, Show, Load, Details); paused while hovered or focused; one at a time,
 *                     a new one replaces it, a focused or hovered one too (the box stays up and keeps the focus).
 *                     Light on dark, bottom centre (full width above the bottom edge on a
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
  const box = $('toast'), textEl = $('toastText'), actEl = $('toastAction'), detEl = $('toastDetails'), moreEl = detEl, alsoEl = $('toastAlso');
  const el = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
  const attBox = $('attention'), attText = $('attentionText'), attAct = $('attentionAction');
  let cur = null;                     // { text, error, action, details, view, ends, onEnd, timer, left, paused }
  const waiting = new Map();          // view -> toast raised while the user was elsewhere
  let att = null;
  box.tabIndex = -1;                  // the focus's place when a toast replaces a focused one with another action

  // (a toast replaced by a newer one leaves the box up and its text to the newer one: no frame without a toast, no
  // focus dropped, one announcement)
  function end(reason) {
    if (!cur) return;
    const t = cur;
    cur = null;
    clearTimeout(t.timer);
    stopFollow();               // nothing places a toast that has gone
    pinnedArea = null;          // (the next toast's slot is placed from its own inputs)
    if (reason !== 'replaced') {
      box.hidden = true;
      topLayer(null);
      dropClass(box, 'error');
      textEl.textContent = ''; detEl.textContent = ''; actEl.textContent = '';
      alsoEl.hidden = true; alsoEl.replaceChildren();
    }
    unplace();
    dropClass(box, 'compact');   // (a form left on measured the NEXT toast's first frame)
    if (t.onEnd) t.onEnd(reason);
  }
  function arm() {
    clearTimeout(cur.timer);
    cur.started = Date.now();
    const t = cur;
    cur.timer = setTimeout(() => { if (cur === t) end('timeout'); }, cur.left);
  }
  function show(t) {
    // (a toast is in view from the frame it appears in: a newer one replaces it). A new toast replaces a
    // focused or hovered one too; "kept while focused" is about the box. What the user is doing with the box is read
    // before the old toast goes: with the focus inside it, the new one starts paused (its full time runs from the
    // focusout), and the focus stays on the action button only if the new toast carries the same action (the same
    // object); otherwise it moves to the box itself, so an Enter meant for the old action fires nothing
    const focused = !box.hidden && cur ? document.activeElement : null, hadFocus = !!focused && box.contains(focused);
    const sameAction = hadFocus && focused !== box && !alsoEl.contains(focused) && !!t.action && t.action === cur.action;
    end('replaced');
    cur = t;
    t.seen = false;
    t.paused = false;     // (paused at once below, in seen(), while the focus or the pointer is in the box)
    dropClass(box, 'compact');   // (a previous toast may have left the compact form on: measure this one fresh)
    decided = null;                 // a new toast: measure afresh
    t.left = t.action || t.also || t.details ? LONG : SHORT;
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
    // a second line with its own action ("The Dragon 64 keeps it until you switch off and on. [Switch off and on]")
    alsoEl.hidden = !t.also;
    if (t.also) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t.also.action.label;
      b.onclick = (e) => { e.stopPropagation(); if (cur !== t) return; end('action'); t.also.action.run(); };
      alsoEl.replaceChildren(el('span', t.also.text), b);
    } else alsoEl.replaceChildren();
    box.hidden = false;
    if (hadFocus) {
      const inline = textEl.querySelector ? textEl.querySelector('button') : null;
      const to = sameAction ? (at >= 0 ? inline : actEl) : box;
      if (to && document.activeElement !== to) to.focus({ preventScroll: true });
    }
    follow(t);      // its timer starts when it is first in view (seen)
  }
  // in view for the first time: from now its time runs
  // (under the pointer already, as a toast that replaced a hovered one: paused until the pointer leaves)
  function seen() {
    if (!cur || cur.seen) return;
    cur.seen = true;
    if (box.matches(':hover') || box.contains(document.activeElement)) cur.paused = true;
    if (!cur.paused) arm();
  }
  // Where a toast sits on the emulator page. Two rules, in this order: a toast is never invisible, and it
  // covers no control (the header, the machine controls, the slots and the cartridge card, the drawer, an attention
  // card, the on-screen keys, the chat's bar) where it can help it. The stylesheet's place first (bottom centre; full
  // width at the bottom on a phone) if it covers neither a control nor the screen; then, on a desktop, along the bottom
  // edge where nothing is under it (at 1440 x 900, below the settings drawer); then along the top edge; then on the
  // screen's border under its text (compact there if need be), never over the text itself (a toast never covers
  // screen text: it is the user's to read). Placed again every frame while it is up (follow), so a control that moves
  // or grows under it (the drawer filling in after the toast appeared) never ends up covered. When none of those
  // places is free, "never invisible" wins over "never covers a control": the toast takes a fixed slot at the top of
  // the viewport (#toastRegion.top: above everything but the dialogs), keeps that slot until it goes (it is not
  // placed again, so it does not jump about under the user's eyes), and its time starts there. That pin is
  // provisional at first: it is placed in the slot in the frame it appears in, but while a control that
  // decides where it may go is still in its own animation (a sheet opening), and for 300 ms at most, it is placed
  // again each frame and moves to a free place as soon as one opens (its position only: no DOM move, no text change,
  // no animation). It is pinned for good once those animations have finished or 300 ms have passed, and not while it
  // is hovered or focused (a provisional toast under the pointer or the focus is not moved either). A toast's time starts
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
    const t = box.getBoundingClientRect(), area = safeArea(), phone = innerWidth <= 700;
    const dialog = [...document.querySelectorAll('dialog:modal')].pop() || null;
    const cv = document.getElementById('screen'), tubeEl = document.querySelector('#monitor .tube');
    const boxOf = (o) => (o ? { left: o.left, top: o.top, right: o.right, bottom: o.bottom, width: o.width, height: o.height } : null);
    return {
      phone, area: { ...area },
      box: boxOf(t), classes: `${box.className}|${region.className}|${document.body ? document.body.className : ''}`,
      // the elements place() avoids: the controls, and #monitor itself (its bezel padding changes with the chat's
      // phone layout) with the screen and the tube inside it
      // (a control less the parts an opaque overlay hides, plus the overlay's own controls; under a modal
      // dialog only the dialog's controls, and no screen: the page is out of reach there)
      dialog: !!dialog,
      controls: avoidRects(dialog, phone).map(boxOf),
      screen: dialog ? [] : [...document.querySelectorAll('#monitor, #monitor .tube, #screen')].map((e) => e.getBoundingClientRect()).filter((o) => o.width && o.height).map(boxOf),
      tube: dialog ? null : boxOf(tubeEl && tubeEl.getBoundingClientRect()), canvas: dialog ? null : boxOf(cv && cv.getBoundingClientRect()),
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
  const PROVISIONAL = 300;
  // in an animation of its own that ends (an endless one, such as the screen's pulse while Claude acts, decides nothing)
  const animating = (e) => !!e.getAnimations && e.getAnimations().some((a) => (a.playState === 'running' || a.pending)
    && Number.isFinite(a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : 0));
  // a control, the screen or an occluding overlay still moving
  const moving = () => [...document.querySelectorAll(CONTROLS), ...document.querySelectorAll('#monitor, #monitor .tube, #screen'),
    ...document.querySelectorAll(OCCLUDES)].some(animating);
  // What covers part of a control. An overlay marked data-occludes is fully opaque (the Ask sheet, the attention
  // card; the browser check holds each to opacity 1 and an opaque background): a control's part under it can't be seen
  // or reached, so a toast may cover that part. The overlay's own controls are avoided in their own right (a toast
  // never covers the sheet's Stop, Done or tabs), and an overlay occludes only once it has settled (no animation of its
  // own running; the provisional pin takes the move). On a phone the toast never goes over the sheet at all (the phone's
  // header band: with no other place it pins at the top). While a modal <dialog> is open, only its controls count.
  const OCCLUDES = '[data-occludes]', INTERACTIVE = 'button, a[href], input, select, textarea, [role="tab"]';
  const shown = (o) => o.width && o.height;
  // r less the part of it under h: the pieces of r that show (none, one, or up to four)
  const subtract = (r, h) => {
    if (!hitsRect(r, h)) return [r];
    const top = Math.max(r.top, h.top), bottom = Math.min(r.bottom, h.bottom);
    return [{ left: r.left, right: r.right, top: r.top, bottom: h.top }, { left: r.left, right: r.right, top: h.bottom, bottom: r.bottom },
      { left: r.left, right: h.left, top, bottom }, { left: h.right, right: r.right, top, bottom }].filter((p) => p.right > p.left && p.bottom > p.top);
  };
  const avoidRects = (dialog, phone) => {
    const own = (root) => [...root.querySelectorAll(INTERACTIVE)].map((e) => e.getBoundingClientRect()).filter(shown);
    if (dialog) return own(dialog);
    const over = [...document.querySelectorAll(OCCLUDES)].filter((e) => !e.hidden && shown(e.getBoundingClientRect()) && !animating(e));
    const holes = over.map((e) => e.getBoundingClientRect());
    const out = [];
    for (const e of document.querySelectorAll(CONTROLS)) {
      const r = e.getBoundingClientRect();
      if (!shown(r)) continue;
      let parts = [r];
      over.forEach((o, i) => { if (o !== e && !o.contains(e)) parts = parts.flatMap((p) => subtract(p, holes[i])); });
      out.push(...parts);
    }
    for (const o of over) out.push(...own(o));
    if (phone) out.push(...holes);   // (on a phone, never over a sheet: the phone's header band)
    return out;
  };
  // over a modal dialog: in the dialog (the rest of the page is inert there: a toast outside it could be seen but not
  // reached) and in the top layer as a popover shown after the dialog, so above its contents; back where it was, out
  // of the top layer, when the dialog closes
  let layerFor = null, home = null;
  function topLayer(dialog) {
    if (dialog === layerFor) return;
    if (layerFor) {
      if (region.matches(':popover-open')) region.hidePopover();
      region.removeAttribute('popover');
      home.parent.insertBefore(region, home.next && home.next.parentNode === home.parent ? home.next : null);
    }
    layerFor = dialog;
    if (!dialog) return;
    home = { parent: region.parentNode, next: region.nextSibling };
    dialog.append(region);
    if (region.showPopover) { region.popover = 'manual'; region.showPopover(); }
    dialog.addEventListener('close', () => { if (layerFor === dialog) topLayer(null); }, { once: true });
  }
  const held = () => box.matches(':hover') || box.contains(document.activeElement);
  function place() {
    // under a modal dialog the toast goes into the dialog's top layer first, so everything below measures it there
    const dialog = box.hidden ? null : [...document.querySelectorAll('dialog:modal')].pop() || null;
    topLayer(dialog);
    // In the top slot (pinned): the toast stays there until it goes, so no re-decision. But the slot's TOP comes from
    // the safe area, which a phone's rotation changes (--safe-t is env(safe-area-inset-top): a notch at the top in
    // portrait, at the side in landscape). Keeping the pin's original top left it under the notch after a rotation, so
    // when the safe-area insets change the slot is re-applied from the new inputs -- the same slot, moved. This is the
    // only thing a pinned toast still reads, and only while the insets are unchanged does it cost nothing. A
    // provisional pin is held the same way while it is hovered or focused: it is not moved under the user;
    // otherwise it is decided again below, and moves to a free place as soon as one opens.
    if (cur && !box.hidden && (cur.pinned === true || (cur.pinned === 'provisional' && held()))) {
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
    if (d.kind === 'natural') { decided = d; if (cur) cur.pinned = false; dropClass(box, 'compact'); settle(); seen(); return; }
    if (d.kind === 'placed') { put(d.left, d.top, d.width); decided = d; if (cur) cur.pinned = false; settle(); seen(); return; }
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
          if (cur) cur.pinned = false;   // (a provisional pin that found a place is a placed toast now)
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
    // NO settle() here, and no `reapply` arm for 'top': a 'top' decision is never re-applied from the cache. Once the
    // pin is final, `place` returns at its first line on every later frame; while it is provisional, every
    // frame decides again, so the key is cleared and nothing can re-apply 'top' from it.
    measuredFor = null;
    // provisional first: final once the controls that decide its place have stopped moving, or after PROVISIONAL ms,
    // and not while it is hovered or focused
    if (cur) {
      if (!cur.pinned) { cur.pinned = 'provisional'; cur.pinnedAt = Date.now(); }
      if (Date.now() - cur.pinnedAt >= PROVISIONAL || !moving()) { if (!held()) cur.pinned = true; }
    }
    pinnedArea = `${I.area.top}|${I.area.left}|${I.area.bottom}|${I.area.right}|${I.phone}`;
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
    // placed at once, in the task that shows it (as the page always did: a toast is in view, and its time runs, from
    // the frame it appears in), then followed by the one chain
    place();
    if (cur === t) raf = requestAnimationFrame(step);
  }
  function stopFollow() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }
  // text: what happened; error: an action failed; action: { label, run } (Undo, Show, Load); also: a second line with
  // its own action, { text, action: { label, run } }; details: more text
  // (an error's sentences after the first go there by default); view: the page it belongs to (default: the one
  // shown); onEnd(reason): called once when it goes ('timeout', 'replaced', 'cleared', 'action', 'dropped', 'closed')
  function toast(text, { error = false, action = null, also = null, details, view = currentView(), onEnd = null } = {}) {
    if (details === undefined && error && !action) [text, details] = splitDetails(String(text));
    const t = { text: String(text), error, action, also, details: details || null, view, onEnd, raised: Date.now() };
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
    get current() { return cur ? { text: cur.text.replace(INLINE, cur.action ? cur.action.label : ''), error: cur.error, view: cur.view, also: cur.also ? cur.also.text : null } : null; },
    // the toast up, and whether its time is running (seen)
    get pending() { return (cur ? [cur] : []).map((t) => ({ text: t.text, seen: !!t.seen })); },
    get attentionText() { return att ? att.text : null; },
    // the placement's inputs, read from the page: the placement loop and its tests use it (the decision itself never
    // reads the DOM, so this is the one place that does)
    readPlacementInputs: readInputs,
  };
}
