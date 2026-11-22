// The side-panel view's on-screen keys, for a phone or a tablet, where there is no keyboard to type with: the page's
// layout and key codes (js/ui/touch-layout.js), in the panel's width under the screen. Three modes:
//   Keys:  the ten-column keyboard;
//   Pad:   a D-pad, SPACE, ENTER, the running program's own extra keys (Minesweeper's F) and ABC (the keyboard for
//          one key, then back);
//   Stick: on a machine with a joystick port only, the key strip (SPACE, ENTER, 1, 2, Y, N, ABC), a stick on the
//          right joystick and FIRE, the page's own (HostInput.touchStick, touchFire).
// Under them, in every mode, one row: the Keys | Pad | Stick switch, CLEAR and BREAK. BREAK is there and nowhere else.
// A bundled program opens in the mode it is played with (Session.programControls: 2048 and Minesweeper on the Pad,
// LIZA and anything else on the Keys); the switch's choice is remembered per program and machine, in the view's
// storage when it works, else in memory for as long as the view lives, and a failing storage is never an error.
// A key reaches the machine when it COMMITS: the finger lifts where it went down, or stays HOLD_MS (a hold, for
// games); a finger that moves MOVE_PX first, or a touch the browser takes back, types nothing. SHIFT is sticky: it
// shifts the next key. Every key is the person's input (session.personInput), as a key on a keyboard is; nothing here
// touches Claude's chip or the tools.
// box: the shell's #keys; storage: { getItem, setItem } (localStorage, or anything that may throw); program() -> what
// runs and how it is played ({ id, input, extra }, as Session.programControls), or null.
// -> { apply(), shown, mode, hidden, setMode(mode), setHidden(on) }
import { FULL, STRIP, SHORT, DPAD, PAD_KEYS, ARROW_NAMES, MODES, HOLD_MS, MOVE_PX, keyPress, programMode } from '../../js/ui/touch-layout.js';
import { touchJoystickOffered, STICK_RADIUS } from '../../js/host/input.js';

// What the switch chose, per program and machine: the view's storage when it works, else memory. Every read and
// write is guarded; a read that fails or finds nothing gives null (the caller falls back to the program's mode).
export function modeMemory(storage, prefix = 'cloadm.touchMode.') {
  const mem = new Map();
  return {
    get(k) {
      let v = null;
      try { v = storage ? storage.getItem(prefix + k) : null; } catch (e) { v = null; }
      return v ?? (mem.has(k) ? mem.get(k) : null);
    },
    set(k, v) {
      mem.set(k, v);
      try { if (storage) storage.setItem(prefix + k, v); } catch (e) { /* memory only, for this view's life */ }
    },
  };
}

export function touchPanel(box, { session, input, wanted, program = () => session.programControls, storage = null, onPress = () => {}, onChange = () => {} }) {
  let shift = false, n = 0, once = false, hidden = false, shown = false, mode = 'keys', extrasFor = null;
  const memory = modeMemory(storage);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const setShift = (on) => { shift = on; for (const s of box.querySelectorAll('[data-key="SHIFT"]')) s.setAttribute('aria-pressed', String(on)); };

  // arrow: a D-pad key, named by its direction (← there is not the keyboard's DEL)
  function key(label, { arrow = false } = {}) {
    const t = label === '_' ? 'SPACE' : label;
    const b = el('button', `k${t.length > 2 ? ' wide' : ''}${t === 'SPACE' ? ' space' : ''}`, t);
    b.type = 'button';
    b.dataset.key = t;
    if (arrow) b.setAttribute('aria-label', ARROW_NAMES[t]);
    else if (t === '←') { b.setAttribute('aria-label', 'DEL (Backspace)'); b.replaceChildren(el('span', null, '←'), el('small', null, 'DEL')); }
    if (SHORT[t]) b.setAttribute('aria-label', `${t} (${SHORT[t]})`);
    if (t === 'SHIFT') b.setAttribute('aria-pressed', 'false');
    const id = `v${n++}`;
    let armed = null;   // { pointerId, x, y, timer, committed }
    const commit = () => {
      clearTimeout(armed.timer);
      armed.committed = true;
      if (t === 'SHIFT') { setShift(!shift); return; }
      const { names, code } = keyPress(t, shift);
      session.personInput();
      input.touch(id, names, code, true);
      if (once) queueMicrotask(() => { once = false; apply(); });   // ABC's one key: back to the Pad or the Stick after it
    };
    const end = () => {
      const was = armed;
      armed = null;
      clearTimeout(was.timer);
      b.classList.remove('down');
      if (t === 'SHIFT' || !was.committed) return;
      input.touch(id, null, 0, false);
      if (shift) setShift(false);
    };
    const mine = (e) => armed && e.pointerId === armed.pointerId;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (armed) return;
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer that can be captured */ }
      armed = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, committed: false, timer: setTimeout(commit, HOLD_MS) };
      b.classList.add('down');
      onPress();
    });
    b.addEventListener('pointermove', (e) => { if (mine(e) && !armed.committed && Math.hypot(e.clientX - armed.x, e.clientY - armed.y) > MOVE_PX) end(); });
    b.addEventListener('pointerup', (e) => { if (!mine(e)) return; if (!armed.committed) commit(); end(); });
    for (const ev of ['pointercancel', 'lostpointercapture']) b.addEventListener(ev, (e) => { if (mine(e)) end(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  const row = (labels, cls = 'krow') => { const r = el('div', cls); for (const l of labels) r.append(typeof l === 'string' ? key(l) : l); return r; };
  const abcKey = () => {
    const b = el('button', 'k wide', 'ABC');
    b.type = 'button'; b.dataset.abc = '';
    b.setAttribute('aria-label', 'ABC (the keyboard for one key)');
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(); once = true; apply(); });
    return b;
  };

  // Keys: the keyboard
  const full = el('div', 'kfull');
  full.id = 'keys-full';
  full.append(...FULL.map((r) => row(r.split(' '))));
  // Pad: the D-pad, then SPACE, ENTER, the program's extras and ABC
  const pad = el('div', 'kpadmode');
  pad.id = 'keys-pad';
  const arrows = el('div', 'karrows');
  for (const r of DPAD) for (const l of r) { if (!l) { arrows.append(el('span', 'kgap')); continue; } arrows.append(key(l, { arrow: true })); }
  const padKeys = el('div', 'kpadkeys'), extras = el('span', 'kextras');
  padKeys.append(...PAD_KEYS.map((l) => key(l)), extras, abcKey());
  pad.append(arrows, padKeys);
  // Stick: the strip (no BREAK: the bottom row has it), the stick and FIRE
  const strip = row(STRIP.filter((l) => l !== 'ABC' && l !== 'BREAK'), 'krow kstrip');
  strip.id = 'keys-strip';
  strip.append(abcKey());
  const stickPad = el('div', 'kpad'), knob = el('span', 'kknob'), fire = el('button', 'kfire', 'FIRE');
  stickPad.id = 'keys-stick'; stickPad.setAttribute('role', 'group'); stickPad.setAttribute('aria-label', 'Joystick'); knob.setAttribute('aria-hidden', 'true'); stickPad.append(knob);
  fire.type = 'button'; fire.id = 'keys-fire';
  const stickArea = el('div', 'kstick');
  stickArea.id = 'keys-joy';
  stickArea.append(stickPad, fire);
  let stickId = null, bx = 0, by = 0, fireId = null;
  const stickAt = (e) => {
    const dx = e.clientX - bx, dy = e.clientY - by, r = Math.hypot(dx, dy), k = r > STICK_RADIUS ? STICK_RADIUS / r : 1;
    input.touchStick(dx, dy);
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  };
  const releaseStick = () => { stickId = null; input.touchStickRelease(); knob.classList.remove('live'); knob.style.cssText = ''; };
  stickPad.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault();
    try { stickPad.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer that can be captured */ }
    stickId = e.pointerId; bx = e.clientX; by = e.clientY;
    const r = stickPad.getBoundingClientRect();
    knob.classList.add('live'); knob.style.left = `${bx - r.left}px`; knob.style.top = `${by - r.top}px`;
    session.personInput(); onPress(); stickAt(e);
  });
  stickPad.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); stickAt(e); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stickPad.addEventListener(ev, (e) => { if (e.pointerId === stickId) releaseStick(); });
  const fireUp = (e) => { if (e.pointerId !== fireId) return; fireId = null; fire.classList.remove('down'); input.touchFire(false); };
  fire.addEventListener('pointerdown', (e) => {
    if (fireId !== null) return;
    e.preventDefault();
    try { fire.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer that can be captured */ }
    fireId = e.pointerId; fire.classList.add('down'); session.personInput(); input.touchFire(true); onPress();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) fire.addEventListener(ev, fireUp);
  for (const x of [stickPad, fire]) x.addEventListener('contextmenu', (e) => e.preventDefault());

  // the bottom row, in every mode: the switch, CLEAR and BREAK
  const sw = el('div', 'kmode');
  sw.id = 'keys-mode'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'On-screen keys');
  for (const [m, label] of [['keys', 'Keys'], ['pad', 'Pad'], ['joystick', 'Stick']]) {
    const b = el('button', null, label);
    b.type = 'button'; b.dataset.mode = m;
    b.addEventListener('click', () => api.setMode(m));
    sw.append(b);
  }
  const bottom = row([sw, 'CLEAR', 'BREAK'], 'krow kbottom');
  bottom.id = 'keys-bottom';
  box.replaceChildren(full, pad, strip, stickArea, bottom);

  const offered = () => touchJoystickOffered(session.shownMachine);
  const modeKey = () => { const p = program(); return `${session.shownMachine.id}${p ? `.${p.id}` : ''}`; };
  // the mode to show: the one chosen for this program (if still a mode, and Stick only where offered), else the
  // program's own
  const chosen = () => {
    const def = programMode(program()), v = memory.get(modeKey());
    const m = MODES.includes(v) ? v : def;
    return m === 'joystick' && !offered() ? (def === 'pad' ? 'pad' : 'keys') : m;
  };
  function apply() {
    const on = wanted() && !hidden;
    const m = chosen(), show = once ? 'keys' : m;
    if (mode === 'joystick' && (m !== 'joystick' || once || !on)) { releaseStick(); input.touchFire(false); }
    mode = m;
    box.hidden = !on;
    full.hidden = show !== 'keys';
    pad.hidden = show !== 'pad';
    strip.hidden = stickArea.hidden = show !== 'joystick';
    const p = program(), want = (p && p.extra ? p.extra : []).join(' ');
    if (want !== extrasFor) { extrasFor = want; extras.replaceChildren(...(want ? want.split(' ') : []).map((l) => key(l))); }
    for (const b of sw.children) { b.hidden = b.dataset.mode === 'joystick' && !offered(); b.setAttribute('aria-pressed', String(b.dataset.mode === m)); }
    if (on !== shown || box.dataset.mode !== show) { shown = on; box.dataset.mode = show; onChange(); }
  }
  // a program starting or left, a load, a reset, another machine: the mode follows what runs
  session.on((ev) => { if (['program', 'menu', 'loaded', 'reset', 'welcome', 'firmware', 'machine'].includes(ev)) apply(); });
  const api = {
    apply,
    get shown() { return shown; },
    get mode() { return mode; },
    get hidden() { return hidden; },
    setMode(m) { if (!MODES.includes(m)) return; once = false; memory.set(modeKey(), m); apply(); },
    setHidden(on) { hidden = !!on; apply(); },
  };
  apply();
  return api;
}
