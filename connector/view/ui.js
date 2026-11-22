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

// The size of the screen in CSS pixels in a box availW x availH (availH null: no limit, the width decides): the
// largest 4:3 picture that fits, to the pixel (R29: no dead space; the pixels are scaled without smoothing).
export function screenSize(availW, availH = null, { aspect = 4 / 3 } = {}) {
  const h = Math.max(1, Math.floor(Math.min(availH == null ? Infinity : availH, availW / aspect)));
  return { width: Math.max(1, Math.floor(h * aspect)), height: h };
}

// Is the view's height fixed by the host? In the side panel or fullscreen (displayMode), or when the host says it
// gives a height (containerDimensions.height). Otherwise the host sizes the view from its content ("inline"), and the
// screen follows the width only: reading the view's own height there would feed back into it.
export const fixedHeight = (ctx = {}) => (ctx.displayMode && ctx.displayMode !== 'inline') || typeof (ctx.containerDimensions || {}).height === 'number';

// Keeps canvas as large as the view allows: the stage's width; with a fixed height (fixedHeight(context())) also the
// view's height less reserve() (the toolbar and the status line), with a maxHeight from the host as a cap; minus the
// stage's and the bezel's padding. The canvas's backing store is its CSS size times devicePixelRatio, so the
// presenter draws each pixel crisp. Called on every resize of the view and by the caller (a mode or model change).
export function fitScreen(stage, bezel, canvas, { context = () => ({}), reserve = () => 0 } = {}) {
  const fit = () => {
    const s = getComputedStyle(stage), b = getComputedStyle(bezel);
    const px = (st, a, z) => parseFloat(st[a]) + parseFloat(st[z]);
    const padH = px(s, 'paddingTop', 'paddingBottom') + px(b, 'paddingTop', 'paddingBottom');
    const w = stage.clientWidth - px(s, 'paddingLeft', 'paddingRight') - px(b, 'paddingLeft', 'paddingRight');
    const ctx = context(), max = (ctx.containerDimensions || {}).maxHeight;
    const total = fixedHeight(ctx) ? innerHeight : typeof max === 'number' ? max : null;
    const size = screenSize(w, total == null ? null : Math.max(MIN_HEIGHT, total - reserve() - padH));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
  };
  addEventListener('resize', fit);
  fit();
  return fit;
}
export const MIN_HEIGHT = 120;   // a view shorter than the toolbar and this scrolls rather than shrink the screen to nothing

// Draws each frame into the canvas's backing store (fitScreen sizes it), every machine pixel a block of device
// pixels: nearest-neighbour, no smoothing. toRGBA(frame, pixels) fills a Uint32Array (js/video/frame.js).
export class CrispPresenter {
  constructor(canvas, toRGBA) { this.canvas = canvas; this.toRGBA = toRGBA; this.g = canvas.getContext('2d'); this.src = null; }
  present(frame) {
    if (!this.src || this.src.width !== frame.width || this.src.height !== frame.height) {
      this.src = new OffscreenCanvas(frame.width, frame.height);
      this.sg = this.src.getContext('2d');
      this.image = this.sg.createImageData(frame.width, frame.height);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }
    this.toRGBA(frame, this.pixels);
    this.sg.putImageData(this.image, 0, 0);
    this.g.imageSmoothingEnabled = false;
    this.g.drawImage(this.src, 0, 0, this.canvas.width, this.canvas.height);
  }
}

// What one of Claude's calls does, for the chip, the status line and the announcement. read: the tool's
// readOnlyHint (js/mcp/tools.js), which decides acting or reading. -> { read, now (while it runs), past (after it),
// keys (what it types or presses, or null) }. names: { model(id), program(id) } give the names people know.
export function describeCall(name, args = {}, { read = false, title = name, model = (id) => id, program = (id) => id } = {}) {
  if (read) {
    const what = ['screen_text', 'screenshot'].includes(name) ? 'the screen' : ['peek', 'find_bytes', 'disassemble'].includes(name) ? 'memory'
      : name === 'registers' ? 'the registers' : 'the machine';
    return { read: true, now: `Claude read ${what}`, past: `Claude read ${what}`, keys: null };
  }
  const keys = (k) => (Array.isArray(k) ? k.join(' + ') : String(k || ''));
  const loaded = args.program ? program(args.program) : String(args.path || '').split('/').pop() || 'a program';
  const say = (now, past, k = null) => ({ read: false, now, past, keys: k });
  switch (name) {
    case 'type_text': { const k = String(args.text || '').replace(/\r?\n/g, '↵'); return say('Claude is typing: ', 'Claude typed ', k); }
    case 'press_keys': return say('Claude is pressing: ', 'Claude pressed ', [keys(args.keys), args.joystick ? 'joystick' : ''].filter(Boolean).join(' · '));
    case 'press_break': return say('Claude is pressing: ', 'Claude pressed ', 'BREAK');
    case 'load_basic': return say('Claude is typing a BASIC program', 'Claude typed a BASIC program');
    case 'load': return say(`Claude is loading ${loaded}`, `Claude loaded ${loaded}`);
    case 'assemble_and_load': return say('Claude is loading its own program', 'Claude loaded its own program');
    case 'run': return say('Claude is running a program', 'Claude ran a program');
    case 'poke': return say('Claude is changing memory', 'Claude changed memory');
    case 'boot': case 'switch_machine': return say(`Claude is switching to the ${model(args.model)}`, `Claude switched to the ${model(args.model)}`);
    case 'reset': return say('Claude is resetting the machine', 'Claude reset the machine');
    case 'power_cycle': return say('Claude is switching the machine off and on', 'Claude switched the machine off and on');
    case 'run_frames': return say('Claude is running the machine', 'Claude ran the machine');
    case 'step': return say('Claude is stepping the CPU', 'Claude stepped the CPU');
    case 'set_display': return say('Claude is choosing the screen shown', 'Claude chose the screen shown');
    default: return say(`Claude: ${title}`, `Claude: ${title}`);
  }
}

// The chip on the bezel (R29). An acting call: the bezel takes Claude's colour and the chip says what it does, with
// the keys (the last KEYS_SHOWN characters) in Claude's colour as they reach the machine (typed(n)) and a cursor;
// done() shows what it did for HOLD_MS. A reading call: a quiet chip for READ_MS. The person's own input never comes
// here. els: { bezel, chip, text, keys, left }
export const KEYS_SHOWN = 24, HOLD_MS = 2000, READ_MS = 1500;
export function chip(els) {
  let timer = null, call = null;
  const draw = () => {
    const c = call, keys = c.d.keys || '';
    els.text.textContent = c.done ? c.d.past : c.d.now;
    const typed = keys.slice(0, c.typed), left = keys.slice(c.typed);
    const start = keys.length > KEYS_SHOWN ? keys.length - (KEYS_SHOWN - 1) : 0;   // the last characters, after an ellipsis
    els.keys.textContent = (start ? '…' : '') + typed.slice(Math.min(start, typed.length));
    els.left.textContent = left.slice(Math.max(0, start - typed.length));
    els.chip.classList.toggle('nokeys', !keys);
  };
  const hide = () => { els.chip.hidden = true; els.bezel.classList.remove('claude'); call = null; };
  return {
    shown: 0, reads: 0,
    get active() { return call; },
    start(d) {
      clearTimeout(timer);
      call = { d, typed: d.keys ? d.keys.length : 0, done: false };
      if (d.read) this.reads++; else this.shown++;
      els.chip.className = d.read ? 'read' : '';
      els.bezel.classList.toggle('claude', !d.read);
      els.chip.hidden = false;
      draw();
      if (d.read) timer = setTimeout(hide, READ_MS);
    },
    // n of the keys have reached the machine
    typed(n) { if (call && !call.done && !call.d.read && call.d.keys && n !== call.typed) { call.typed = Math.max(0, Math.min(n, call.d.keys.length)); draw(); } },
    done() {
      if (!call || call.d.read) return;
      call.done = true; call.typed = call.d.keys ? call.d.keys.length : 0;
      els.chip.className = 'done';
      draw();
      clearTimeout(timer);
      timer = setTimeout(hide, HOLD_MS);
    },
  };
}
