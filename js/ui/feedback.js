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
export const currentView = () => ({ '#library': 'library', '#add-roms': 'roms', '#share': 'share' }[location.hash] || 'emulator');
// where an attention card sits on each page: over the screen on the emulator, under the header elsewhere
const ATTENTION_HOME = { emulator: () => document.querySelector('#monitor .tube'), library: () => document.querySelector('#library .libhead'), roms: () => document.querySelector('#romCard .libhead'), share: () => document.querySelector('#share > header') };

// "First sentence. The rest." -> [first, rest]; a message without a second sentence has no details
export function splitDetails(text) {
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  return m && m[1].length >= 12 ? [m[1], m[2]] : [text, null];
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
    box.hidden = true;
    unplace();
    box.classList.remove('error');
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
    t.left = t.action || t.details ? LONG : SHORT;
    textEl.textContent = t.text;
    box.classList.toggle('error', !!t.error);
    actEl.hidden = !t.action && !t.details;
    actEl.textContent = t.action ? t.action.label : t.details ? 'Details' : '';
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
  const CONTROLS = 'header, .controls, .slots, aside.drawer, #attention, #touchKeys button, #claudeBar, #installOffer';
  const boxes = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((o) => o.width && o.height);
  const hits = (r, o) => !(r.bottom <= o.top || r.top >= o.bottom || r.right <= o.left || r.left >= o.right);
  // back to the stylesheet's place (a toast that ends, or one placed afresh)
  function unplace() {
    region.style.left = ''; region.style.top = ''; region.style.right = ''; region.style.bottom = '';
    region.style.transform = ''; region.style.width = '';
    region.classList.remove('top');
  }
  function place() {
    if (cur && cur.pinned && !box.hidden) return;   // in the top slot: kept there until it goes
    unplace();
    if (box.hidden) return;
    if (currentView() !== 'emulator') { seen(); return; }
    const r = box.getBoundingClientRect(), w = r.width, h = r.height, phone = innerWidth <= 700, area = safeArea();
    const controls = boxes(CONTROLS), screen = boxes('#monitor, #monitor .tube, #screen');   // (the phone chat's monitor has no box of its own)
    const rect = (left, top) => ({ left, top, right: left + w, bottom: top + h });
    // in view: inside the window less a phone's notch and home indicator (safeArea)
    const inView = (c) => c.left >= area.left && c.right <= area.right && c.top >= area.top && c.bottom <= area.bottom;
    const free = (c, avoid) => inView(c) && avoid.every((o) => !hits(c, o));
    const tries = [];   // [left, top, also avoid the screen?]
    tries.push([r.left, r.top, true]);
    if (!phone) {
      const xs = [];
      for (let x = area.left + 16; x + w <= area.right - 16; x += 8) xs.push(x);
      xs.sort((a, b) => Math.abs(a - r.left) - Math.abs(b - r.left));
      for (const x of xs) tries.push([x, r.top, true]);
    }
    // the screen: never over its text; below the text area, on the screen's border, if there is room
    // (compact there when the full toast does not fit)
    const tube = document.querySelector('#monitor .tube'), cv = document.getElementById('screen');
    const t = tube && tube.getBoundingClientRect(), c = cv && cv.getBoundingClientRect();
    const text = c && c.width ? (() => {
      const f = (cv.dataset.active || '0,0,1,1').split(',').map(Number);
      return { left: c.left + f[0] * c.width, top: c.top + f[1] * c.height, right: c.left + f[2] * c.width, bottom: c.top + f[3] * c.height };
    })() : null;
    // the band under the text, inside what shows of the screen
    const band = t && t.width && t.height && text ? { left: Math.max(t.left, c.left, area.left) + 8, right: Math.min(t.right, c.right, area.right) - 8,
      top: text.bottom + 2, bottom: Math.min(t.bottom, c.bottom, area.bottom) - 4 } : null;
    const offText = controls.concat(text ? [text] : []);
    tries.push([r.left, area.top + (phone ? 8 : 16), true]);
    const put = (x, y, width = null) => {
      region.style.transform = 'none'; region.style.bottom = 'auto'; region.style.right = 'auto';
      region.style.left = `${Math.round(x)}px`; region.style.top = `${Math.round(y)}px`;
      if (width !== null) region.style.width = `${Math.round(width)}px`;
    };
    box.classList.remove('compact');
    const at = tries.find(([x, y, avoidScreen]) => free(rect(x, y), avoidScreen ? controls.concat(screen) : controls));
    if (at) {
      if (at[0] !== r.left || at[1] !== r.top) put(at[0], at[1], phone ? w : null);
      seen();
      return;
    }
    // in the band under the screen's text: as it is if it fits, else compact (smaller type, narrowed to the band)
    if (band && band.right - band.left > 40 && band.bottom - band.top > 12) {
      for (const compact of [false, true]) {
        box.classList.toggle('compact', compact);
        const bw = Math.min(compact ? Infinity : w, band.right - band.left);
        put(0, 0, bw);
        const bb = box.getBoundingClientRect(), x = (band.left + band.right - bb.width) / 2, y = band.bottom - bb.height;
        const spot = { left: x, top: y, right: x + bb.width, bottom: y + bb.height };
        if (y >= band.top && free(spot, offText)) { put(x, y, bw); seen(); return; }
      }
      box.classList.remove('compact');
    }
    // nowhere it covers no control: the fixed slot at the top of the viewport, kept until the toast goes
    box.classList.remove('compact');
    unplace();
    region.style.top = phone ? '8px' : '16px'; region.style.bottom = 'auto';
    region.classList.add('top');
    if (cur) cur.pinned = true;
    seen();
  }
  // followed every frame while it is up: a control can move under it without the window scrolling or resizing
  // (the drawer filling in, a bar appearing above the slots), and it must never end up over one
  function follow(t) { if (cur !== t) return; place(); requestAnimationFrame(() => follow(t)); }
  // text: what happened; error: an action failed; action: { label, run } (Undo, Show, Load); details: more text
  // (an error's sentences after the first go there by default); view: the page it belongs to (default: the one
  // shown); onEnd(reason): called once when it goes ('timeout', 'replaced', 'cleared', 'action', 'dropped', 'closed')
  function toast(text, { error = false, action = null, details, view = currentView(), onEnd = null } = {}) {
    if (details === undefined && error && !action) [text, details] = splitDetails(String(text));
    const t = { text: String(text), error, action, details: details || null, view, onEnd, raised: Date.now() };
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
    get current() { return cur ? { text: cur.text, error: cur.error, view: cur.view } : null; },
    // the toast up, and whether its time is running (seen)
    get pending() { return (cur ? [cur] : []).map((t) => ({ text: t.text, seen: !!t.seen })); },
    get attentionText() { return att ? att.text : null; },
  };
}
