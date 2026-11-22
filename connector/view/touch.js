// The side-panel view's on-screen keys, for a phone or a tablet, where there is no keyboard to type with: the page's
// layout and key codes (js/ui/touch-layout.js), in the panel's width under the screen.
//   Keys:  the ten-column keyboard, then a row with CLEAR and BREAK (and the Keys | Stick switch);
//   Stick: on a machine with a joystick port, the key strip (SPACE, ENTER, BREAK, 1, 2, Y, N, and ABC for one key
//          from the keyboard), a stick on the right joystick and FIRE, the page's own (HostInput.touchStick, touchFire).
// BREAK is in the bottom row in either mode, never inside the keyboard. A key reaches the machine when it COMMITS: the
// finger lifts where it went down, or stays HOLD_MS (a hold, for games); a finger that moves MOVE_PX first, or a touch
// the browser takes back, types nothing. SHIFT is sticky: it shifts the next key. Every key is the person's input
// (session.personInput), as a key on a keyboard is; nothing here touches Claude's chip or the tools.
// box: the shell's #keys. -> { apply(), shown, mode, setMode(mode), setHidden(on) }
import { FULL, STRIP, SHORT, HOLD_MS, MOVE_PX, keyPress } from '../../js/ui/touch-layout.js';
import { touchJoystickOffered, STICK_RADIUS } from '../../js/host/input.js';

export function touchPanel(box, { session, input, wanted, onPress = () => {}, onChange = () => {} }) {
  let shift = false, n = 0, once = false, hidden = false, shown = false, mode = 'keys';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const shiftKeys = () => box.querySelectorAll('[data-key="SHIFT"]');
  const setShift = (on) => { shift = on; for (const s of shiftKeys()) s.setAttribute('aria-pressed', String(on)); };

  function key(label) {
    const t = label === '_' ? 'SPACE' : label;
    const b = el('button', `k${t.length > 2 ? ' wide' : ''}${t === 'SPACE' ? ' space' : ''}`, t);
    b.type = 'button';
    b.dataset.key = t;
    if (t === '←') { b.setAttribute('aria-label', 'DEL (Backspace)'); b.replaceChildren(el('span', null, '←'), el('small', null, 'DEL')); }
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
      if (once) queueMicrotask(() => { once = false; apply(); });   // ABC's one key: back to the stick after it
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

  // the keyboard
  const full = el('div', 'kfull');
  full.id = 'keys-full';
  full.append(...FULL.map((r) => row(r.split(' '))));
  // the stick, FIRE and the strip
  const strip = row(STRIP.filter((l) => l !== 'ABC'), 'krow kstrip');
  const abc = el('button', 'k wide', 'ABC');
  abc.type = 'button'; abc.id = 'keys-abc';
  abc.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(); once = true; apply(); });
  strip.append(abc);
  const pad = el('div', 'kpad'), knob = el('span', 'kknob'), fire = el('button', 'kfire', 'FIRE');
  pad.id = 'keys-stick'; pad.setAttribute('role', 'group'); pad.setAttribute('aria-label', 'Joystick'); knob.setAttribute('aria-hidden', 'true'); pad.append(knob);
  fire.type = 'button'; fire.id = 'keys-fire';
  const stickArea = el('div', 'kstick');
  stickArea.id = 'keys-joy';
  stickArea.append(pad, fire);
  let stickId = null, bx = 0, by = 0, fireId = null;
  const stickAt = (e) => {
    const dx = e.clientX - bx, dy = e.clientY - by, r = Math.hypot(dx, dy), k = r > STICK_RADIUS ? STICK_RADIUS / r : 1;
    input.touchStick(dx, dy);
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  };
  const releaseStick = () => { stickId = null; input.touchStickRelease(); knob.classList.remove('live'); knob.style.cssText = ''; };
  pad.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer that can be captured */ }
    stickId = e.pointerId; bx = e.clientX; by = e.clientY;
    const r = pad.getBoundingClientRect();
    knob.classList.add('live'); knob.style.left = `${bx - r.left}px`; knob.style.top = `${by - r.top}px`;
    session.personInput(); onPress(); stickAt(e);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); stickAt(e); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, (e) => { if (e.pointerId === stickId) releaseStick(); });
  const fireUp = (e) => { if (e.pointerId !== fireId) return; fireId = null; fire.classList.remove('down'); input.touchFire(false); };
  fire.addEventListener('pointerdown', (e) => {
    if (fireId !== null) return;
    e.preventDefault();
    try { fire.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer that can be captured */ }
    fireId = e.pointerId; fire.classList.add('down'); session.personInput(); input.touchFire(true); onPress();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) fire.addEventListener(ev, fireUp);
  for (const x of [pad, fire]) x.addEventListener('contextmenu', (e) => e.preventDefault());

  // the bottom row: the switch (a machine with a joystick port) and, in Keys, CLEAR and BREAK
  const sw = el('div', 'kmode');
  sw.id = 'keys-mode'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'On-screen keys');
  for (const [m, label] of [['keys', 'Keys'], ['stick', 'Stick']]) {
    const b = el('button', null, label);
    b.type = 'button'; b.dataset.mode = m;
    b.addEventListener('click', () => api.setMode(m));
    sw.append(b);
  }
  const bottom = row([sw, 'CLEAR', 'BREAK'], 'krow kbottom');
  bottom.id = 'keys-bottom';
  box.replaceChildren(full, strip, stickArea, bottom);

  const offered = () => touchJoystickOffered(session.machine);
  function apply() {
    const on = wanted() && !hidden;
    const m = offered() && session.store.get(`touchMode.${session.machine.id}`) === 'joystick' ? 'stick' : 'keys';
    const stick = m === 'stick' && !once;
    if (mode === 'stick' && (!stick || !on)) { releaseStick(); input.touchFire(false); }
    mode = m;
    box.hidden = !on;
    full.hidden = stick;
    strip.hidden = stickArea.hidden = m !== 'stick' || once;
    for (const k of bottom.querySelectorAll('.k')) k.hidden = m === 'stick';
    sw.hidden = !offered();
    for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    bottom.hidden = sw.hidden && m === 'stick';
    if (on !== shown || box.dataset.mode !== (stick ? 'stick' : 'keys')) { shown = on; box.dataset.mode = stick ? 'stick' : 'keys'; onChange(); }
  }
  const api = {
    apply,
    get shown() { return shown; },
    get mode() { return mode; },
    get hidden() { return hidden; },
    setMode(m) { once = false; session.store.set(`touchMode.${session.machine.id}`, m === 'stick' ? 'joystick' : 'keys'); apply(); },
    setHidden(on) { hidden = !!on; apply(); },
  };
  apply();
  return api;
}
