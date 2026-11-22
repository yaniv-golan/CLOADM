/*
 * The on-screen panel: phones and tablets can't type otherwise. Two modes, chosen with a Keys | Joystick switch
 * when the machine has a joystick port of its own to offer:
 *
 * Keys: in landscape on a phone it is the design's split thumb keyboard, the screen between its halves with
 * BREAK, CLEAR, the switch and Menu under it; in portrait (or on a larger touch screen) a ten-column keyboard
 * under the screen. Upright, the screen takes what the panel leaves (UX R30). Keys go to the machine through HostInput.touch (the KeyQueue holds each press long enough
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
 * Pad: a D-pad (↑ ↓ ← →, 48 px keys), SPACE, ENTER, the running program's extra keys (Minesweeper's F) and
 * ABC, the keyboard for one key. The switch is Keys | Pad | Stick (Stick only where the machine has a joystick port
 * and not in the phone's chat). A bundled program opens in the mode it is played with (Session.programControls: 2048
 * and Minesweeper on the pad, LIZA on the keys; anything else on the keys).
 *
 * Shown by itself on touch screens (a coarse pointer, touch points without hover, or a first touch); the Input
 * tab's "On-screen keyboard" setting says Automatic, Always or Never, and Hide keys (⌄ in the strip, or Menu sideways)
 * hides it for the visit (⌨, Show keys, bottom right, brings it back). The mode is remembered per program and machine
 * (touchMode.<id>.<program>, or touchMode.<id>), and ?touch= sets it for the visit (js/config.js; never for an
 * embed, which has no panel of its own).
 */
import { charToKeys } from '../machines/keyboards.js';
import { touchJoystickOffered, STICK_RADIUS } from '../host/input.js';
import { $, ESC, markUndrawn } from './page.js';

// label -> machine key name, and the code the stub reads (ASCII; the arrows as BASIC's codes)
const SPECIAL = {
  '↑': ['UP', 94], '↓': ['DOWN', 10], '←': ['LEFT', 8], ENTER: ['ENTER', 13], SPACE: ['SPACE', 32],
  '→': ['RIGHT', 9], BREAK: ['BREAK', 3], CLEAR: ['CLEAR', 12],
};
// Pad mode (UX R30, R35): a D-pad (two rows; '' is a corner), and SPACE, ENTER, the running program's own extra keys
// (Session.programControls: Minesweeper's F) and ABC, the full keyboard for one key. BREAK is the strip's alone.
const DPAD = [['', '↑', ''], ['←', '↓', '→']];
const PAD_KEYS = ['SPACE', 'ENTER'];
const ARROW_NAMES = { '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right' };
// the panel's modes, in the switch's order; 'joystick' is the switch's Stick (the stored value and ?touch= keep R4's name)
const MODES = ['keys', 'pad', 'joystick'];
// the character SHIFT + key types (the Dragon layout's shifted symbols), for the stub
const SHIFTED = {};
for (let c = 32; c < 127; c++) { const ch = String.fromCharCode(c), k = charToKeys(ch); if (k && k.shift && !SHIFTED[k.key]) SHIFTED[k.key] = ch; }

const SPLIT = {
  left: ['1 2 3 4 5 6', '↑ Q W E R T', '↓ A S D F G', 'SHIFT Z X C V B', '_'],
  right: ['7 8 9 0 : -', 'Y U I O P @', 'H J K L ; ENTER', 'N M , . / ←', '_ SHIFT'],
};
// (→ after ←, UX R30; with it the bottom row overflowed at 320 px, so @ ends the third row)
const FULL = ['1 2 3 4 5 6 7 8 9 0', 'Q W E R T Y U I O P', 'A S D F G H J K L ; @', 'Z X C V B N M , . /', 'SHIFT ↑ ↓ ← → _ : - ENTER'];
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

  function key(label, { arrow = false } = {}) {
    const t = label === '_' ? 'SPACE' : label;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tk' + (t.length > 2 ? ' wide' : '') + (t === 'SPACE' ? ' space' : '');
    b.textContent = t;
    // ← is the Dragon's and CoCo's backspace: the glyph stays, a small DEL under it says so, and its name starts with
    // that visible word (WCAG 2.5.3, label in name): "DEL (Backspace)"
    if (arrow) b.setAttribute('aria-label', ARROW_NAMES[t]);
    else if (t === '←') {
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
  // the pad: the D-pad, then the keys; the program's extras go between BREAK and ABC (padExtras, from apply())
  const padArrows = Object.assign(document.createElement('div'), { className: 'padarrows' });
  for (const r of DPAD) for (const l of r) padArrows.append(l ? key(l, { arrow: true }) : Object.assign(document.createElement('span'), { className: 'tkgap' }));
  const padKeys = Object.assign(document.createElement('div'), { className: 'padkeys' });
  const padExtra = Object.assign(document.createElement('span'), { className: 'padextra' });
  padKeys.append(...PAD_KEYS.map((l) => key(l)), padExtra);
  $('touchPad').append(padArrows, padKeys);
  let extrasFor = '';
  function padExtras(keys) {
    if (keys.join() === extrasFor) return;
    extrasFor = keys.join();
    padExtra.replaceChildren(...keys.map((l) => key(l)));
  }
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
    strip.append(abc('tkAbc'));
  }
  padKeys.append(abc('tkPadAbc'));
  // ABC: the strip's (joystick mode) and the pad's
  function abc(id) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = id; b.className = 'tk wide abc'; b.textContent = 'ABC';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); page.audio.start(); showKeysOnce(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
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
    if (t.closest && t.closest('.abc')) return;       // ABC again: the keyboard it shows is already up
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

  // ---- the Keys | Pad | Stick switch: remembered per program and machine ----
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
  // The mode a program opens in comes from what it is played with (Session.programControls, UX R30): the arrows ->
  // Pad, a joystick -> Stick, the keyboard (LIZA, BASIC, anything else) -> Keys. The switch's choice is remembered per
  // program and machine (touchMode.<machine>.<program>), and per machine for no program in particular (R4's
  // touchMode.<machine>: BASIC, the welcome menu, a file).
  const program = () => session.programControls;
  const modeKey = () => { const p = program(); return `touchMode.${session.machine.id}${p ? `.${p.id}` : ''}`; };
  const modeFor = () => { const p = program(); return !p ? 'keys' : p.input === 'arrows' ? 'pad' : p.input === 'joystick' ? 'joystick' : 'keys'; };
  const wanted = () => { if (visitMode) return visitMode; const v = session.store.get(modeKey()); return MODES.includes(v) ? v : modeFor(); };
  // Stick where it is not offered (no port, the phone's chat) or while a gamepad drives the joystick: the program's
  // own mode if that is the pad, else Keys
  const modus = () => { if (!session.machine) return 'keys'; const w = wanted(); return w === 'joystick' && (padHere || !offer()) ? (modeFor() === 'pad' ? 'pad' : 'keys') : w; };
  function setMode(mode, { remember = true } = {}) {
    if (!session.machine) return;
    if (keysOnce) leave();   // the switch's own tap ends ABC: the mode it chooses is the one to show
    // using the switch takes the panel out of the link's mode: from here it is the person's choice
    visitMode = null;
    if (remember) session.store.set(modeKey(), mode);
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
  const sheet = $('tkMenuSheet');
  // a phone held sideways: the app bar gives way to the panel (play/index.html), so the panel's button is "Menu",
  // with the machine picker, Commands… and Hide keys; elsewhere the app bar has its own Menu and the panel's button
  // is ⌄, Hide keys (never two controls named Menu, UX R30)
  const sideways = matchMedia('(orientation: landscape) and (max-height: 500px)');
  // standing aside: the page has a text field the person types in with the phone's own keyboard (the chat's API
  // key form), so the machine keyboard steps out of its way until the field is gone
  let aside = false;
  const mode = () => session.store.get('touchKeys') || 'auto';
  // is the panel showing the stick now (the page's tap handling and the mouse-as-joystick ask: js/ui/screen.js)
  const stickActive = () => !box.hidden && !keysOnce && modus() === 'joystick';

  let stickWas = false;   // the stick's pieces were showing at the last apply()
  function apply() {
    const wantOn = !aside && (mode() === 'on' || (mode() === 'auto' && touchScreen()));
    const on = wantOn && !hidden;
    // the mode's classes (joystick, pad) stay up through ABC's one keypress: it takes the stick's or the pad's pieces
    // away and brings the keyboard into that mode's grid, never the keys mode's -- whose rows the screen occupies
    // sideways, and which would put the keyboard over it.
    const m = on ? modus() : 'keys';
    const joyMode = m === 'joystick', padMode = m === 'pad';
    const stick = joyMode && !keysOnce;
    box.hidden = !on;
    box.classList.toggle('joystick', joyMode);
    box.classList.toggle('pad', padMode);
    box.classList.toggle('keysonce', keysOnce);
    if (padMode) { const p = program(); padExtras(p ? p.extra : []); }
    box.dataset.mode = m;
    document.body.classList.toggle('touch-keys', on);
    document.body.classList.toggle('touch-stick', joyMode);
    document.body.classList.toggle('touch-pad', padMode);
    // Hide keys: the page keeps the touch layout's screen (upright, the whole width: play/index.html), and ⌨ (Show keys)
    // stands bottom right
    document.body.classList.toggle('touch-hidden', wantOn && hidden);
    // the menu button (see `sideways`; a phone's full-screen chat: the way back, js/ui/claude.js)
    const side = sideways.matches, chat = document.body.classList.contains('chat-phone'), tkMenu = $('tkMenu');
    tkMenu.textContent = chat ? '← Emulator' : side ? 'Menu' : '⌄';
    if (!chat && !side) tkMenu.setAttribute('aria-label', 'Hide keys'); else tkMenu.removeAttribute('aria-label');
    if (side && !chat) { tkMenu.setAttribute('aria-controls', 'tkMenuSheet'); tkMenu.setAttribute('aria-expanded', String(!sheet.hidden)); }
    else { tkMenu.removeAttribute('aria-controls'); tkMenu.removeAttribute('aria-expanded'); sheet.hidden = true; }
    const install = sheet.querySelector('[data-item="install"]');
    if (install) install.hidden = $('navInstall').hidden;
    markUndrawn();   // (the touch layout hides the app bar, the drawer and the ports: page.js)
    // Keys | Pad | Stick: Stick where the machine has a joystick port of its own and the panel is the machine's
    $('tkModeSwitch').hidden = !on;
    box.querySelector('[data-touchmode="joystick"]').hidden = !offer();
    for (const b of box.querySelectorAll('[data-touchmode]')) b.setAttribute('aria-pressed', String(b.dataset.touchmode === m));
    $('btnShowKeys').hidden = !hidden;   // only after Hide keys (the Input tab has the setting)
    $('selTouchKeys').value = mode();
    // losing the stick for ANY reason (hidden, Keys, a gamepad, ABC) lets go of it here: the pointer handlers
    // are not the only way out, and one that never fires must not leave the joystick held. Only on the transition:
    // while the stick is NOT up the joystick is someone else's (the mouse, the keyboard joystick) and must be left
    // as it is.
    if (stickWas && !stick) { releaseStick(); input.touchFire(false); }
    stickWas = stick;
  }
  // A phone held upright (UX R30): the panel decides and the screen takes the rest -- the largest 4:3 screen for which
  // the app bar, the screen, the strip and the panel fit in the visible height, at most the page's width (play/index.html,
  // "a phone held upright"). What lies above the monitor and from its foot to the panel's is measured here, as CSS
  // cannot; both are lengths of the page's own content, not of the window, so the stylesheet's 100svh does the rest.
  // (Unused sideways, where the monitor is fixed between the halves.)
  const monitor = document.querySelector('.layout > main > .monitor'), root = document.documentElement.style;
  function fit() {
    const m = monitor.getBoundingClientRect();
    root.setProperty('--tk-above', `${Math.round(m.top + scrollY)}px`);
    // (keys hidden: room for ⌨, Show keys, under the screen's corner)
    root.setProperty('--tk-below', `${box.hidden ? 56 : Math.round(box.getBoundingClientRect().bottom - m.bottom)}px`);
  }
  // (the monitor's own size changes with the result, but neither length depends on it: no loop)
  new ResizeObserver(fit).observe(document.querySelector('.layout > main'));
  new ResizeObserver(fit).observe($('appbar'));
  new ResizeObserver(fit).observe(box);
  // Safari 26 and later on an iPhone draws its bottom toolbar (the floating address bar) OVER the page, and neither
  // the viewport units nor env(safe-area-inset-bottom) take it out: the panel stops above it (--tk-bar in
  // play/index.html). Not an installed app (no toolbar) and not another browser on iOS (theirs is not over the page).
  const iosSafari = /iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent) && /Version\/(\d+)/.exec(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('float-bar', !!iosSafari && +iosSafari[1] >= 26 && !standalone);
  coarse.addEventListener('change', apply);
  sideways.addEventListener('change', apply);
  noHover.addEventListener('change', apply);
  $('selTouchKeys').onchange = (e) => { session.store.set('touchKeys', e.target.value); hidden = false; apply(); };
  $('btnShowKeys').onclick = () => { hidden = false; apply(); };
  // The panel's menu button (UX R30). Where the app bar shows (upright, a tablet) it is ⌄, Hide keys: the app bar's Menu
  // is the only Menu. Held sideways the app bar gives way to the panel, so it is "Menu": Machine… (the machine picker),
  // Commands…, Install CLOADM… (the app bar's link, out of sight there) and Hide keys. In a phone's chat (body.chat-phone, js/ui/claude.js) the app bar gives way to the chat bar, so
  // it is "← Emulator" and leaves the chat in one tap, as it always has: the way out must not need a second tap.
  sheet.innerHTML = '<button type="button" data-item="machine">Machine…</button><button type="button" data-item="commands">Commands…</button>'
    + '<button type="button" data-item="install">Install CLOADM…</button><button type="button" data-item="hide">Hide keys</button>';
  // (Install CLOADM… is the app bar's link, which held sideways is out of sight: here too, while it is offered)
  new MutationObserver(apply).observe($('navInstall'), { attributes: true, attributeFilter: ['hidden'] });
  const closeSheet = () => { sheet.hidden = true; $('tkMenu').setAttribute('aria-expanded', 'false'); };
  // a disclosure: it opens with the focus on its first button, and Esc gives the focus back to Menu
  $('tkMenu').onclick = () => {
    if (document.body.classList.contains('chat-phone')) { $('btnClaudeBack').click(); return; }
    if (!sideways.matches) { hidden = true; apply(); $('btnShowKeys').focus(); return; }   // ⌄: Hide keys
    sheet.hidden = !sheet.hidden;
    $('tkMenu').setAttribute('aria-expanded', String(!sheet.hidden));
    if (!sheet.hidden) sheet.querySelector('button:not([hidden])').focus();
  };
  sheet.onclick = (e) => {
    const b = e.target.closest('[data-item]');
    if (!b) return;
    closeSheet();
    if (b.dataset.item === 'machine') openMachines();
    else if (b.dataset.item === 'commands') $('navCommands').click();
    else if (b.dataset.item === 'install') $('navInstall').click();
    else if (b.dataset.item === 'hide') { hidden = true; apply(); }
  };
  // Machine…: the machine picker (#machineMenu), which lives in the app bar; held sideways the bar gives way to the
  // panel, so it comes back over the panel (body.machine-pick, play/index.html) while the picker is open
  function openMachines() {
    document.body.classList.add('machine-pick');
    $('machineBtn').click();
    const menu = $('machineMenu');
    const done = new MutationObserver(() => { if (menu.hidden) { done.disconnect(); document.body.classList.remove('machine-pick'); } });
    done.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    if (menu.hidden) { done.disconnect(); document.body.classList.remove('machine-pick'); }
  };
  // (open only while it shows: a panel that went away with it open must not take the screen's Esc)
  const sheetOpen = () => !sheet.hidden && sheet.checkVisibility();
  page.onEscape(ESC.menu, sheetOpen, () => { closeSheet(); $('tkMenu').focus(); });
  // a tap anywhere else closes it, the focus back on Menu unless the tap gave it to something (the panel's own keys
  // still type: the sheet is above the panel)
  page.outsidePress(sheetOpen, (t) => sheet.contains(t) || $('tkMenu').contains(t), (refocus) => { closeSheet(); if (refocus) $('tkMenu').focus(); });
  // a machine switch: the mode is that machine's own; a machine without a joystick port goes back to the keys
  // a program starting or left: the mode follows what runs (Session.programControls)
  session.on((ev) => {
    if (['program', 'menu', 'loaded', 'reset', 'welcome', 'firmware'].includes(ev)) { apply(); return; }
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
