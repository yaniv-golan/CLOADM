// The side-panel view's controls, apart from the emulator (connector/view/panel.js wires them to the Session):
//   menu()      a menu button and its role="menu" list, for the mouse and the keyboard;
//   fitScreen() the emulated screen sized to the panel, keeping its 4:3 picture and its pixels crisp;
//   activity()  the cue that Claude, not the person, is driving the machine.
// The elements are the view's (connector/build.js's shell), passed in by panel.js.

let openMenu = null;   // one menu open at a time

// button opens list (role="menu", its items role="menuitem" or "menuitemradio", tabindex -1). Click, Enter, Space or
// ArrowDown opens it on the first item, ArrowUp on the last; in it ArrowUp/ArrowDown/Home/End move, Enter or Space
// picks (the items are buttons), Escape closes it and gives the focus back to the button, Tab closes it and moves
// on, and a click elsewhere closes it. onOpen() refreshes the items before the menu shows. onPick(item) runs for
// the item picked, also an aria-disabled one (which says why it cannot run), after the menu has closed.
export function menu(button, list, { onOpen = null, onPick }) {
  const items = () => [...list.querySelectorAll('[role^="menuitem"]')].filter((i) => !i.hidden);
  const isOpen = () => !list.hidden;
  const close = (focus = true) => {
    if (!isOpen()) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (openMenu === api) openMenu = null;
    if (focus) button.focus();
  };
  const open = (at = 0) => {
    if (openMenu && openMenu !== api) openMenu.close(false);
    if (onOpen) onOpen();
    list.hidden = false;
    // kept inside the view: a menu that would run off the right edge moves left
    list.style.left = '';
    const over = list.getBoundingClientRect().right - (document.documentElement.clientWidth - 6);
    if (over > 0) list.style.left = `${parseFloat(getComputedStyle(list).left) - over}px`;
    button.setAttribute('aria-expanded', 'true');
    openMenu = api;
    const it = items();
    if (it.length) it[(at + it.length) % it.length].focus();
  };
  const api = { open, close, isOpen };
  button.addEventListener('click', () => (isOpen() ? close() : open(0)));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(0); } else if (e.key === 'ArrowUp') { e.preventDefault(); open(-1); }
  });
  list.addEventListener('keydown', (e) => {
    const it = items(), i = it.indexOf(document.activeElement), n = it.length;
    if (e.key === 'ArrowDown') it[(i + 1) % n].focus();
    else if (e.key === 'ArrowUp') it[(i - 1 + n) % n].focus();
    else if (e.key === 'Home') it[0].focus();
    else if (e.key === 'End') it[n - 1].focus();
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') { close(false); return; } else return;
    e.preventDefault();
  });
  list.addEventListener('click', (e) => {
    const item = e.target.closest('[role^="menuitem"]');
    if (!item || !list.contains(item)) return;
    close();
    onPick(item);
  });
  document.addEventListener('pointerdown', (e) => { if (isOpen() && !list.contains(e.target) && !button.contains(e.target)) close(false); });
  return api;
}

// A menu item: a button with a label and, after it, a tag (a short note: "BASIC", "needs ROMs"). attrs go on the button.
export function menuItem(label, { role = 'menuitem', tag = null, tagOk = false, attrs = {} } = {}) {
  const b = document.createElement('button');
  b.setAttribute('role', role);
  b.tabIndex = -1;
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  const l = document.createElement('span');
  l.className = 'label'; l.textContent = label;
  b.append(l);
  if (tag) { const t = document.createElement('span'); t.className = `tag${tagOk ? ' ok' : ''}`; t.textContent = tag; b.append(t); }
  return b;
}

// The size of the screen in CSS pixels inside a box availW x availH: the largest 4:3 picture that fits. When a whole
// number of device pixels per line comes within SNAP of that, it is taken instead (every line, and every pixel
// across, the same size); otherwise the browser scales the pixels without smoothing (image-rendering: pixelated).
export const SNAP = 0.9;
export function screenSize(availW, availH, { lines = 240, dpr = 1, aspect = 4 / 3 } = {}) {
  let h = Math.max(0, Math.min(availH, availW / aspect));
  const k = (h * dpr) / lines, whole = Math.floor(k);
  if (whole >= 1 && whole / k >= SNAP) h = (whole * lines) / dpr;
  h = Math.max(1, Math.floor(h));
  return { width: Math.max(1, Math.round(h * aspect)), height: h };
}

// Keeps canvas as large as the view allows: the stage's width, and the view's height less reserve() (the toolbar and
// the status line; Details, when open, scrolls instead of shrinking the screen), minus the stage's and the bezel's
// padding. On every resize of the panel, the host's fullscreen and side panel included, and on refresh() (a model
// whose picture has other lines). lines() -> the picture's height in lines.
export function fitScreen(stage, bezel, canvas, { lines = () => 240, reserve = () => 0 } = {}) {
  const fit = () => {
    const s = getComputedStyle(stage), b = getComputedStyle(bezel);
    const px = (st, a, z) => parseFloat(st[a]) + parseFloat(st[z]);
    const w = stage.clientWidth - px(s, 'paddingLeft', 'paddingRight') - px(b, 'paddingLeft', 'paddingRight');
    const h = innerHeight - reserve() - px(s, 'paddingTop', 'paddingBottom') - px(b, 'paddingTop', 'paddingBottom');
    const size = screenSize(w, Math.max(h, MIN_HEIGHT), { lines: lines(), dpr: devicePixelRatio || 1 });
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  };
  addEventListener('resize', fit);
  fit();
  return fit;
}
export const MIN_HEIGHT = 120;   // a view shorter than the toolbar and this scrolls rather than shrink the screen to nothing

// What Claude's tool call does to the machine, in a few words, and the keys it sends; null for a call that only
// reads (the screen, memory, registers) or lets time pass: the cue is for what the person could take for their own.
// model(id) -> a model's name, program(id) -> a bundled program's
export function claudeAction(name, args = {}, { model = (id) => id, program = (id) => id } = {}) {
  const keys = (k) => (Array.isArray(k) ? k.join(' + ') : String(k || ''));
  switch (name) {
    case 'type_text': return { what: 'is typing', keys: String(args.text || '').replace(/\r?\n/g, '⏎') };
    case 'press_keys': return { what: 'is pressing', keys: [keys(args.keys), args.joystick ? 'joystick' : ''].filter(Boolean).join(' · ') };
    case 'press_break': return { what: 'pressed', keys: 'BREAK' };
    case 'load_basic': return { what: 'is typing a BASIC program', keys: null };
    case 'load': return { what: `is loading ${args.program ? program(args.program) : String(args.path || '').split('/').pop() || 'a program'}`, keys: null };
    case 'assemble_and_load': return { what: 'is loading its own program', keys: null };
    case 'run': return { what: 'is running a program', keys: null };
    case 'poke': return { what: 'is changing memory', keys: null };
    case 'boot': case 'switch_machine': return { what: `is switching to the ${model(args.model)}`, keys: null };
    case 'reset': return { what: 'pressed Reset', keys: null };
    case 'power_cycle': return { what: 'switched the machine off and on', keys: null };
    default: return null;
  }
}

// The cue: el (the pill) with what (the action) and keys. show(action) while the call runs; done() lets it fade
// HOLD_MS after the call (at once, without the fade, for people who ask for reduced motion).
export const HOLD_MS = 1600;
export function activity(el, whatEl, keysEl) {
  let timer = null, fade = null;
  const MAX_KEYS = 40;
  return {
    shown: 0,
    show({ what, keys }) {
      clearTimeout(timer); clearTimeout(fade);
      whatEl.textContent = what;
      keysEl.hidden = !keys;
      keysEl.textContent = keys ? (keys.length > MAX_KEYS ? `…${keys.slice(-MAX_KEYS + 1)}` : keys) : '';
      el.classList.remove('fading');
      el.hidden = false;
      this.shown++;
    },
    done() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.hidden = true; return; }
        el.classList.add('fading');
        fade = setTimeout(() => { el.hidden = true; el.classList.remove('fading'); }, 450);
      }, HOLD_MS);
    },
  };
}
