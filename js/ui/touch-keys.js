/*
 * The on-screen panel: phones and tablets can't type otherwise. Two modes, chosen with a Keys | Joystick switch
 * when the machine has a joystick port of its own to offer:
 *
 * Keys: in landscape on a phone it is the design's split thumb keyboard, the screen between its halves with
 * BREAK, CLEAR, the switch and Menu under it; in portrait (or on a larger touch screen) a ten-column keyboard
 * under the screen. Keys go to the machine through HostInput.touch (the KeyQueue holds each press long enough
 * for the machine to see it; the no-ROM stub gets the character). SHIFT is sticky: it shifts the next key.
 *
 * Joystick: one stick drives the right joystick (joystick 0, the same one the first gamepad drives): analogue
 * 0..63, the pads' own dead zone (js/host/input.js), no 8-way snap, the base where the finger goes down and a
 * full deflection at about 56 px of travel. FIRE is the joystick's button bit - on real hardware it shares its
 * row line with the keyboard's leftmost column, so FIRE plus a key can read as a key, exactly as a stick's fire
 * button does; on the CoCo 3 it also raises the GIME's keyboard interrupt (js/machines/cocopia.js, coco3.js).
 * The key strip (SPACE, ENTER, BREAK, 1, 2, Y, N and ABC) types one press into the machine; ABC brings the
 * keyboard back for one keypress and returns to the stick (upright the whole keyboard, under the screen; sideways
 * the split keyboard's halves, which are the two side columns there, as the screen has the height). Two fingers
 * work at once: the stick and FIRE are separate pointers, and each captures its own.
 *
 * Shown by itself on touch screens (a coarse pointer, touch points without hover, or a first touch); the Input
 * tab's "On-screen keyboard" setting says Automatic, Always or Never, and "Hide keys" (in Menu) hides it for the
 * visit (a Keys button brings it back). The mode is remembered per machine (touchMode.<id>), and ?touch= sets it
 * for the visit (js/config.js; never for an embed, which has no panel of its own).
 */
import { charToKeys } from '../machines/keyboards.js';
import { touchJoystickOffered, STICK_RADIUS } from '../host/input.js';
import { $, ESC } from './page.js';

// label -> machine key name, and the code the stub reads (ASCII; the arrows as BASIC's codes)
const SPECIAL = {
  '↑': ['UP', 94], '↓': ['DOWN', 10], '←': ['LEFT', 8], ENTER: ['ENTER', 13], SPACE: ['SPACE', 32],
  BREAK: ['BREAK', 3], CLEAR: ['CLEAR', 12],
};
// the character SHIFT + key types (the Dragon layout's shifted symbols), for the stub
const SHIFTED = {};
for (let c = 32; c < 127; c++) { const ch = String.fromCharCode(c), k = charToKeys(ch); if (k && k.shift && !SHIFTED[k.key]) SHIFTED[k.key] = ch; }

const SPLIT = {
  left: ['1 2 3 4 5 6', '↑ Q W E R T', '↓ A S D F G', 'SHIFT Z X C V B', '_'],
  right: ['7 8 9 0 : -', 'Y U I O P @', 'H J K L ; ENTER', 'N M , . / ←', '_ SHIFT'],
};
const FULL = ['1 2 3 4 5 6 7 8 9 0', 'Q W E R T Y U I O P', 'A S D F G H J K L ;', 'Z X C V B N M , . /', 'SHIFT ↑ ↓ ← _ : - @ ENTER'];
// joystick mode's key strip: the keys a game that asks "PRESS Y OR N" wants, and the space bar most use to
// start; ABC opens the full keyboard for one key, then back to the stick
const STRIP = ['SPACE', 'ENTER', 'BREAK', '1', '2', 'Y', 'N', 'ABC'];
const SHORT = { SPACE: 'SPC', ENTER: 'ENT', BREAK: 'BRK' };
// a key is committed when the finger lifts, or after HOLD_MS still; moving MOVE_PX first cancels it (key(), below)
export const HOLD_MS = 100, MOVE_PX = 10;

export function setupTouchKeys(page, { input }) {
  const { session } = page;
  const box = $('touchKeys');
  let shift = false, n = 0;
  // SHIFT keys armed (a finger on them) but not yet committed: a key that commits under them commits them first
  const shiftArmed = new Set();

  function key(label) {
    const t = label === '_' ? 'SPACE' : label;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tk' + (t.length > 2 ? ' wide' : '') + (t === 'SPACE' ? ' space' : '');
    b.textContent = t;
    // ← is the Dragon's and CoCo's backspace: the glyph stays, a small DEL under it says so, and its name starts with
    // that visible word (WCAG 2.5.3, label in name): "DEL (Backspace)"
    if (t === '←') {
      b.setAttribute('aria-label', 'DEL (Backspace)');
      b.replaceChildren(Object.assign(document.createElement('span'), { className: 'glyph', textContent: '←' }),
        Object.assign(document.createElement('span'), { className: 'del', textContent: 'DEL' }));
    }
    b.dataset.key = t;
    const id = `k${n++}`;
    // A finger that lands on a key ARMS it (it shows pressed); the key reaches the machine only when it COMMITS:
    // the finger lifts where it went down (a tap), or stays there for HOLD_MS (a hold, for games). A finger that
    // moves more than MOVE_PX first, or a touch the browser takes away (pointercancel: it scrolled), cancels it,
    // and the machine never sees the key -- a drag or a scroll that starts on the keyboard types nothing. Once
    // committed the key is held until the finger lifts, however it wobbles. SHIFT commits the same way (its
    // toggle), so a drag over it changes nothing either -- unless another key commits while it is armed (a chord:
    // SHIFT held, a key tapped), which commits SHIFT first.
    let armed = null;   // { pointerId, x, y, timer, committed }
    const commit = () => {
      clearTimeout(armed.timer);
      armed.committed = true;
      if (t === 'SHIFT') { shiftArmed.delete(commit); shift = !shift; for (const s of box.querySelectorAll('[data-key="SHIFT"]')) s.setAttribute('aria-pressed', String(shift)); return; }
      // a chord: SHIFT held down, then a key tapped before SHIFT's own HOLD_MS -- the key is shifted, as it always was
      for (const c of [...shiftArmed]) c();
      const sp = SPECIAL[t], name = sp ? sp[0] : t;
      let code = sp ? sp[1] : t.charCodeAt(0);
      if (shift && !sp && SHIFTED[name]) code = SHIFTED[name].charCodeAt(0);
      // (the person's key: Claude acting on this machine pauses first, as for a key on the keyboard)
      session.personInput();
      input.touch(id, shift ? ['SHIFT', name] : [name], code, true);
      // ABC's one keypress is this one: the stick comes back after it (queued, so the key is in first)
      if (keysOnce) queueMicrotask(leave);
    };
    const press = (e) => {
      e.preventDefault();
      if (armed) return;   // a second finger on a key already down
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer we can capture */ }
      armed = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, committed: false, timer: setTimeout(commit, HOLD_MS) };
      if (t === 'SHIFT') shiftArmed.add(commit);
      b.classList.add('down');
      page.audio.start();
    };
    const end = () => {
      const was = armed;
      armed = null;
      clearTimeout(was.timer);
      shiftArmed.delete(commit);
      b.classList.remove('down');
      if (t === 'SHIFT' || !was.committed) return;
      input.touch(id, null, 0, false);
      if (shift) { shift = false; for (const s of box.querySelectorAll('[data-key="SHIFT"]')) s.setAttribute('aria-pressed', 'false'); }
    };
    const mine = (e) => armed && e.pointerId === armed.pointerId;
    if (t === 'SHIFT') b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerdown', press);
    b.addEventListener('pointermove', (e) => {
      if (mine(e) && !armed.committed && Math.hypot(e.clientX - armed.x, e.clientY - armed.y) > MOVE_PX) end();
    });
    b.addEventListener('pointerup', (e) => { if (!mine(e)) return; if (!armed.committed) commit(); end(); });
    // the browser took the touch (a scroll, a gesture) or the capture went: an armed key is cancelled, a held one let go
    for (const ev of ['pointercancel', 'lostpointercapture']) b.addEventListener(ev, (e) => { if (mine(e)) end(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  const rows = (list) => list.map((r) => { const row = document.createElement('div'); row.className = 'tkrow'; for (const l of r.split(' ')) row.append(key(l)); return row; });
  $('touchLeft').append(...rows(SPLIT.left));
  $('touchRight').append(...rows(SPLIT.right));
  $('touchFull').append(...rows(FULL));
  for (const [id, label] of [['tkBreak', 'BREAK'], ['tkClear', 'CLEAR']]) $(id).replaceWith(Object.assign(key(label), { id }));

  // ---- joystick mode: the stick, FIRE and the key strip ----
  const strip = $('touchStrip');
  for (const label of STRIP) {
    if (label !== 'ABC') {
      // SPACE, ENTER and BREAK carry a short label too (SPC, ENT, BRK), shown where the strip is narrow (a phone
      // held sideways, play/index.html); the button's name holds both, "SPACE (SPC)", so either visible label is in it
      const k = key(label), short = SHORT[label];
      if (short) { k.setAttribute('aria-label', `${label} (${short})`); k.replaceChildren(Object.assign(document.createElement('span'), { className: 'long', textContent: label }),
        Object.assign(document.createElement('span'), { className: 'short', textContent: short })); }
      strip.append(k); continue;
    }
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'tkAbc'; b.className = 'tk wide'; b.textContent = 'ABC';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); page.audio.start(); showKeysOnce(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    strip.append(b);
  }
  // ABC: the keyboard comes back for one keypress, then the stick does. A touch has IMPLICIT pointer capture on
  // the button it landed on, so the finger that pressed ABC lifts inside ABC itself: that pointerup says nothing
  // about the key the person still means to press. ABC is therefore ARMED by its own press and ended by the next
  // press (a tap of one finger, ABC then a key), or by a press anywhere else on the panel that is not a key;
  // pointercancel ends it too (the page took the touch away).
  // No pointer id is remembered for ABC's own press. A mouse is always pointer id 1 (a pen keeps its id), so an
  // id check would swallow every key after ABC for those devices. The arming press cannot end ABC by itself, for
  // two reasons: these listeners are added with capture on #touchKeys, and the capture phase past #touchKeys has
  // already run when ABC's own handler executes; and if the press did reach leaveOnKey later (bubble phase, or
  // these listeners changed to bubble), ABC is the target, and a press on ABC is left to its own handler below.
  let keysOnce = false;
  function showKeysOnce() {
    if (!keysOnce) {
      box.addEventListener('pointerdown', leaveOnKey, true);
      box.addEventListener('pointercancel', leaveOnCancel, true);
    }
    keysOnce = true;
    apply();
  }
  function leaveOnCancel() { if (keysOnce) leave(); }
  function leaveOnKey(e) {
    if (!keysOnce) return;
    const t = e.target;
    if (t.id === 'tkAbc') return;                     // ABC again: the keyboard it shows is already up
    // a key ends it when it commits (key(), above): a drag that cancels the key leaves the keyboard up
    if (t.closest && t.closest('.tk')) return;
    // Menu and the mode switch are the panel's own controls: leaving them to their handler (the switch ends ABC
    // through setMode, so the panel never shows ABC's keyboard in a mode whose switch is hidden)
    if (!(t.closest && (t.closest('.tkmode') || t.id === 'tkMenu'))) leave();
  }
  function leave() {
    keysOnce = false;
    box.removeEventListener('pointerdown', leaveOnKey, true);
    box.removeEventListener('pointercancel', leaveOnCancel, true);
    apply();
  }

  const zone = $('touchStick'), knob = $('touchKnob');
  let stickId = null, baseX = 0, baseY = 0;
  const stickAt = (e) => {
    const dx = e.clientX - baseX, dy = e.clientY - baseY;
    input.touchStick(dx, dy);
    const r = Math.hypot(dx, dy), k = r > STICK_RADIUS ? STICK_RADIUS / r : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  };
  zone.addEventListener('pointerdown', (e) => {
    if (stickId !== null || keysOnce) return;   // (hidden for ABC's press, but a capture can outlive the style)
    e.preventDefault();
    try { zone.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer we can capture */ }
    stickId = e.pointerId;
    baseX = e.clientX; baseY = e.clientY;
    const r = zone.getBoundingClientRect();
    knob.classList.add('live');
    knob.style.left = `${baseX - r.left}px`;
    knob.style.top = `${baseY - r.top}px`;
    page.audio.start();
    stickAt(e);
  });
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); stickAt(e); } });
  // let go of the stick wherever the release comes from: this zone's own pointer events, or the panel's apply()
  // when the stick goes away. The knob returns to its rest state with it.
  function releaseStick() {
    stickId = null;
    input.touchStickRelease();
    knob.classList.remove('live');
    knob.style.transform = ''; knob.style.left = ''; knob.style.top = '';
  }
  const stickEnd = (e) => { if (e.pointerId === stickId) releaseStick(); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) zone.addEventListener(ev, stickEnd);
  // the capture can be refused (the code above allows for it): without it a finger lifted outside the zone
  // sends no pointerup here, so the window's own release is the way out
  addEventListener('pointerup', (e) => { if (e.pointerId === stickId) releaseStick(); }, true);
  addEventListener('pointercancel', (e) => { if (e.pointerId === stickId) releaseStick(); }, true);
  zone.addEventListener('contextmenu', (e) => e.preventDefault());

  // FIRE: a pointer of its own, so the stick and FIRE are held at the same time
  const fire = $('touchFire');
  let fireId = null;   // FIRE's own pointer: another finger lifting must not let go of it
  const fireDown = (e) => {
    if (keysOnce || fireId !== null) return;   // (hidden for ABC's press, but a capture can outlive the style)
    e.preventDefault();
    try { fire.setPointerCapture(e.pointerId); } catch (err) { /* not a pointer we can capture */ }
    fireId = e.pointerId;
    fire.classList.add('down'); input.touchFire(true); page.audio.start();
  };
  const fireUp = () => { if (fireId === null) return; fireId = null; fire.classList.remove('down'); input.touchFire(false); };
  fire.addEventListener('pointerdown', fireDown);
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) fire.addEventListener(ev, fireUp);
  // the same way out as the stick's: if FIRE's capture is refused and the finger lifts outside it, no pointerup
  // reaches the button -- but only FIRE's own pointer ends it (the stick's finger is a different one)
  const fireEnd = (e) => { if (e.pointerId === fireId) fireUp(); };
  addEventListener('pointerup', fireEnd, true);
  addEventListener('pointercancel', fireEnd, true);
  fire.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- the Keys | Joystick switch: remembered per machine ----
  // offered only where the panel is the machine's: not in the phone's full-screen chat (body.chat-phone,
  // js/ui/claude.js), whose keys type into the chat and where a BASIC machine's joystick has no meaning
  const offer = () => touchJoystickOffered(session.machine) && !document.body.classList.contains('chat-phone');
  // a gamepad takes the joystick while it is connected (screen.js reads it every frame): the panel shows the
  // keys then, without overwriting the mode the person chose, and the stick comes back when the pad goes.
  // ?touch= (js/config.js) is the visit's own mode for every machine the visit shows: in force until the switch
  // is used, it never writes what the switch remembers for a machine.
  // how many gamepads are connected (0 when none): one leaving does not bring the stick back while another is
  // still driving joy[0]/fire[0] every frame
  const padCount = () => { try { return (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter((p) => p && p.connected !== false).length; } catch (e) { return 0; } };
  let padHere = padCount() > 0, visitMode = null;
  const wanted = () => visitMode || (session.store.get(`touchMode.${session.machine.id}`) === 'joystick' ? 'joystick' : 'keys');
  const modus = () => (padHere || !offer() || wanted() !== 'joystick' ? 'keys' : 'joystick');
  function setMode(mode, { remember = true } = {}) {
    if (!session.machine) return;
    if (keysOnce) leave();   // the switch's own tap ends ABC: the mode it chooses is the one to show
    // using the switch takes the panel out of the link's mode: from here it is the person's choice
    visitMode = null;
    if (remember) session.store.set(`touchMode.${session.machine.id}`, mode);
    for (const b of box.querySelectorAll('[data-touchmode]')) b.setAttribute('aria-pressed', String(b.dataset.touchmode === mode));
    box.dataset.mode = mode;
    // leaving the stick: nothing stays held on the joystick it drove
    if (mode !== 'joystick') { input.touchStickRelease(); input.touchFire(false); }
    apply();
  }
  for (const b of box.querySelectorAll('[data-touchmode]')) b.addEventListener('click', () => setMode(b.dataset.touchmode));
  // a link's ?touch= (js/config.js): this visit's mode. Taken up when the machine arrives (the link's machine
  // switches in after this panel is set up), and dropped for good when the switch is used.
  visitMode = page.linkTouch || null;

  // shown: Automatic (touch screens), Always or Never; "Hide keys" for this visit
  // a touch screen: a coarse pointer, or touch points and no hover, or a touch seen on the page
  const coarse = matchMedia('(pointer: coarse)'), noHover = matchMedia('(hover: none)');
  let touchSeen = false;
  // (once a touch screen, always one for this visit: the keyboard doesn't come and go with a passing media change)
  const touchScreen = () => (touchSeen = touchSeen || coarse.matches || (navigator.maxTouchPoints > 0 && noHover.matches));
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !touchSeen) { touchSeen = true; apply(); } }, { capture: true });
  let hidden = false;
  // standing aside: the page has a text field the person types in with the phone's own keyboard (the chat's API
  // key form), so the machine keyboard steps out of its way until the field is gone
  let aside = false;
  const mode = () => session.store.get('touchKeys') || 'auto';
  // is the panel showing the stick now (the page's tap handling and the mouse-as-joystick ask: js/ui/screen.js)
  const stickActive = () => !box.hidden && !keysOnce && modus() === 'joystick' && offer();

  let stickWas = false;   // the stick's pieces were showing at the last apply()
  function apply() {
    const on = !hidden && !aside && (mode() === 'on' || (mode() === 'auto' && touchScreen()));
    const joy = on && offer();
    // joystick mode (the classes follow joyMode, not stick): ABC's one keypress takes the stick's pieces away
    // and brings the keyboard into the joystick mode's grid, never the keys mode's -- whose rows the screen
    // occupies sideways, and which would put the keyboard over it.
    const joyMode = joy && modus() === 'joystick';
    const stick = joyMode && !keysOnce;
    box.hidden = !on;
    box.classList.toggle('joystick', !!joyMode);
    box.classList.toggle('keysonce', keysOnce);
    box.dataset.mode = modus();
    document.body.classList.toggle('touch-keys', on);
    document.body.classList.toggle('touch-stick', !!joyMode);
    // the switch where the panel is, for a machine that has a joystick port
    $('tkModeSwitch').hidden = !joy;
    for (const b of box.querySelectorAll('[data-touchmode]')) b.setAttribute('aria-pressed', String(b.dataset.touchmode === modus()));
    $('btnShowKeys').hidden = !hidden;   // only after Hide keys (the Input tab has the setting)
    $('selTouchKeys').value = mode();
    // losing the stick for ANY reason (hidden, Keys, a gamepad, ABC) lets go of it here: the pointer handlers
    // are not the only way out, and one that never fires must not leave the joystick held. Only on the transition:
    // while the stick is NOT up the joystick is someone else's (the mouse, the keyboard joystick) and must be left
    // as it is.
    if (stickWas && !stick) { releaseStick(); input.touchFire(false); }
    stickWas = stick;
  }
  // A phone held upright: the screen takes the height the page above it and the panel below leave (play/index.html,
  // "a phone held upright"). What lies above the monitor (the safe-area padding, the app bar however it wraps, an
  // offer) and from its foot to the panel's (the gap, the panel) is measured here, as CSS cannot; both are lengths of
  // the page's own content, not of the window, so the stylesheet's 100dvh does the rest. (Unused sideways, where
  // the monitor is fixed between the halves.)
  const monitor = document.querySelector('.layout > main > .monitor'), root = document.documentElement.style;
  // Safari 26 and later on an iPhone draws its bottom toolbar (the floating address bar) OVER the page, and neither
  // the viewport units nor env(safe-area-inset-bottom) take it out: the panel stops above it (--tk-bar in
  // play/index.html). Not an installed app (no toolbar) and not another browser on iOS (theirs is not over the page).
  const iosSafari = /iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent) && /Version\/(\d+)/.exec(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('float-bar', !!iosSafari && +iosSafari[1] >= 26 && !standalone);
  function fit() {
    if (box.hidden) return;
    const m = monitor.getBoundingClientRect(), k = box.getBoundingClientRect();
    root.setProperty('--tk-above', `${Math.round(m.top + scrollY)}px`);
    // (less the monitor's bottom margin: the install offer's room, which the stylesheet takes out itself)
    root.setProperty('--tk-below', `${Math.round(k.bottom - m.bottom - parseFloat(getComputedStyle(monitor).marginBottom || '0'))}px`);
  }
  // (the monitor's own size changes with the result, but neither length depends on it: no loop)
  new ResizeObserver(fit).observe(document.querySelector('.layout > main'));
  new ResizeObserver(fit).observe($('appbar'));
  new ResizeObserver(fit).observe(box);
  coarse.addEventListener('change', apply);
  noHover.addEventListener('change', apply);
  $('selTouchKeys').onchange = (e) => { session.store.set('touchKeys', e.target.value); hidden = false; apply(); };
  $('btnShowKeys').onclick = () => { hidden = false; apply(); };
  // Menu: the machine menu the app bar's Menu opens, plus "Hide keys" (which lives in Menu, so the strip has
  // the Keys | Joystick switch instead). In a phone's chat (body.chat-phone, js/ui/claude.js) the app bar gives
  // way to the chat bar, so Menu is "← Emulator" and leaves the chat in one tap, as it always has: the way out
  // must not need a second tap.
  const sheet = $('tkMenuSheet');
  sheet.innerHTML = '<button type="button" data-item="menu">Machine menu</button><button type="button" data-item="commands">Commands…</button><button type="button" data-item="hide">Hide keys</button>';
  const closeSheet = () => { sheet.hidden = true; $('tkMenu').setAttribute('aria-expanded', 'false'); };
  // a disclosure: it opens with the focus on its first button, and Esc gives the focus back to Menu
  $('tkMenu').onclick = () => {
    if (document.body.classList.contains('chat-phone')) { $('btnClaudeBack').click(); return; }
    sheet.hidden = !sheet.hidden;
    $('tkMenu').setAttribute('aria-expanded', String(!sheet.hidden));
    if (!sheet.hidden) sheet.querySelector('button').focus();
  };
  sheet.onclick = (e) => {
    const b = e.target.closest('[data-item]');
    if (!b) return;
    closeSheet();
    if (b.dataset.item === 'menu') $('btnMenu').click();
    else if (b.dataset.item === 'commands') $('navCommands').click();
    else if (b.dataset.item === 'hide') { hidden = true; apply(); }
  };
  // (open only while it shows: a panel that went away with it open must not take the screen's Esc)
  const sheetOpen = () => !sheet.hidden && sheet.checkVisibility();
  page.onEscape(ESC.menu, sheetOpen, () => { closeSheet(); $('tkMenu').focus(); });
  // a tap anywhere else closes it, the focus back on Menu unless the tap gave it to something (the panel's own keys
  // still type: the sheet is above the panel)
  page.outsidePress(sheetOpen, (t) => sheet.contains(t) || $('tkMenu').contains(t), (refocus) => { closeSheet(); if (refocus) $('tkMenu').focus(); });
  // a machine switch: the mode is that machine's own; a machine without a joystick port goes back to the keys
  session.on((ev) => {
    if (ev !== 'machine') return;
    // a stick the OLD machine's panel was driving is let go of, so nothing carries over. Only then: a machine whose
    // joystick the mouse or the keyboard joystick drives is the host's, and this panel must not recentre it.
    if (stickWas) { releaseStick(); input.touchFire(false); }
    stickWas = false;
    apply();
  });
  // a gamepad arriving: it drives the right joystick every frame, so the stick shows the keys while it is
  // connected, and the mode comes back when the pad disconnects (screen.js reports both)
  // (screen.js's own gamepadconnected toast says "Gamepad connected"; the panel's stand-down needs no second
  // toast of its own)
  addEventListener('gamepadconnected', () => { padHere = true; apply(); });
  addEventListener('gamepaddisconnected', () => { padHere = padCount() > 0; apply(); });
  apply();
  const standAside = (on) => { if (aside !== !!on) { aside = !!on; apply(); } };
  return { apply, standAside, setMode, stickActive };
}
