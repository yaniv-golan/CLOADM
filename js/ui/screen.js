/* The screen: the frame loop, host input (keyboard, gamepads, the mouse), drag and drop, and the run controls. */
import { $ } from './page.js';
import { CanvasPresenter, GlPresenter } from '../video/canvas.js';
import { fitPicture, fitActive } from '../video/layout.js';
import { HostInput } from '../host/input.js';
import { Gamepads } from '../host/gamepad.js';

export function setupScreen(page, { loadPrograms, roms }) {
  const { session, audio, canvas } = page;
  // WebGL for the CRT look; without it, the pixels only (the Display tab says so)
  let presenter = null;
  try { presenter = GlPresenter.create(canvas); } catch (e) { presenter = null; }
  if (!presenter) presenter = new CanvasPresenter(canvas);
  page.crtAvailable = presenter.crt;
  // HostInput maps keys, gamepads and the mouse; its held keys go through the Session's KeyQueue, so a fast
  // typist's keys are applied in order at frame starts and none is lost (js/machines/keyqueue.js)
  const input = new HostInput(session.machine, session.keys);
  const pads = new Gamepads();
  let havePads = false;
  const applyInputSettings = () => {
    input.mode = session.store.get('keyboardMode') === 'positional' ? 'positional' : 'translated';
    input.joyKeys = session.store.get('keyboardJoystick') === '1';
  };
  session.on((ev) => {
    if (ev === 'machine') { input.setMachine(session.machine); applyInputSettings(); }
    // the machine's sound level jumps for a reason that isn't sound: the output carries on from where it was
    if (['machine', 'firmware', 'reset', 'loaded'].includes(ev)) audio.discontinuity();
  });
  applyInputSettings();
  let paused = false, lastStatus = '';

  // ---- the canvas box: the picture's shape (4:3 on every machine, or the whole area) and integer scaling
  // (Display tab), as large as the screen area allows ----
  const area = $('screenWrap');
  const CROP_MARGIN = 2;   // CSS px: the first row clear of the tube's top edge (its ends are clear of the corners)
  // the area's size, read once per resize (reading it every frame would make the browser lay out the page)
  let areaW = area.clientWidth, areaH = area.clientHeight;
  let size = { width: 0, height: 0 }, key = '';
  function fit(picture) {
    // the area hidden (another view, such as Capture & share, in its place): it has no size, so the canvas keeps
    // the one it has; the frame loop runs while paused, and shrinking the canvas to nothing left the screen
    // invisible for a frame when the view closed
    if (!areaW || !areaH) return size;
    // where the picture's text area sits in the canvas, as fractions (left,top,right,bottom; empty: the whole
    // canvas), for what must not lie over it (js/ui/feedback.js: a toast never covers the screen's text)
    const a = picture.active;
    const act = a ? [a.x / picture.width, a.y / picture.height, (a.x + a.width) / picture.width, (a.y + a.height) / picture.height].join() : '';
    if (canvas.dataset.active !== act) canvas.dataset.active = act;
    // page.cropBorder: the chat on a phone shows the picture area without its border (fitActive), larger
    const crop = page.cropBorder && !!picture.active;
    const d = session.display, k = [picture.aspect, picture.height, areaW, areaH, d.aspect, d.integer, crop].join();
    if (k === key) return size;
    key = k;
    // (the text area fitted CROP_MARGIN short of the area's top and bottom, so its first and last rows are wholly in
    // view, clear of the tube's edge and rounded corners; the sides need none: a row's ends are not at a corner)
    size = crop ? fitActive({ areaW, areaH: areaH - 2 * CROP_MARGIN, frame: picture, integer: d.integer })
      : fitPicture({ areaW, areaH, aspect: picture.aspect, lines: picture.height, fill: d.aspect === 'fill', integer: d.integer });
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    return size;
  }
  new ResizeObserver(() => { areaW = area.clientWidth; areaH = area.clientHeight; }).observe(area);

  // gamepads: read once a frame while any is connected (the first pad is the right joystick, the second
  // the left one), so a pad plugged in mid-session just starts working
  window.addEventListener('gamepadconnected', () => { havePads = true; page.status('Gamepad connected'); });
  const readPads = () => {
    if (!havePads && !(navigator.getGamepads && [...navigator.getGamepads()].some(Boolean))) return;
    havePads = true;
    const { right, left } = pads.read();
    // only take a joystick back when a pad was driving it: the self-test and the mouse set these directly
    if (right) input.setGamepad(0, right); else if (input.pads[0]) input.clearGamepad(0);
    if (left) input.setGamepad(1, left); else if (input.pads[1]) input.clearGamepad(1);
  };

  // ---- frame loop ----
  // The picture goes to the presenter only when it changed: a frame ran, another machine's picture, the display
  // settings, the size, a debugger step, or a WebGL context restore (which leaves the canvas blank). A display
  // refreshing faster than the machine's frames (120/144 Hz) has
  // ticks with nothing new, and paused there is nothing new until a setting or the size changes.
  let last = performance.now(), fpsFrames = 0, fpsTime = last, fps = 0;
  let shown = { picture: null, display: null, width: 0, height: 0, steps: -1, restores: 0 };
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = now - last; last = now;
    // the UI's per-frame work runs whether or not the machine does: the things it follows (the boot state,
    // the tape motor, whether audio has been unlocked) change without a frame, and the timers it replaces
    // ran while paused too. document.hidden is the exception -- nothing needs updating on a hidden page.
    if (document.hidden) return;
    page.tickUi();
    const m = session.machine;
    let ran = 0;
    if (!paused) {
      readPads();
      ran = session.advance(dt, { onFrame: () => audio.pushFrame(m.audioEvents, m.frameCycles, m.fps), now: () => performance.now() });
      fpsFrames += ran;
    }
    const picture = m.render(), box = fit(picture), display = session.display, steps = session.debugger ? session.debugger.steps : 0, restores = presenter.restores;
    if (ran || picture !== shown.picture || display !== shown.display || box.width !== shown.width || box.height !== shown.height || steps !== shown.steps || restores !== shown.restores) {
      presenter.present(picture, display, box.width, box.height);
      shown = { picture, display, width: box.width, height: box.height, steps, restores };
    }
    if (paused) return;
    if (now - fpsTime >= 1000) { fps = fpsFrames * 1000 / (now - fpsTime); fpsFrames = 0; fpsTime = now; }
    const s = session.statusLine(fps);
    if (s !== lastStatus) { $('status').textContent = s; lastStatus = s; }
  }
  requestAnimationFrame(tick);

  // ---- keyboard, gamepads and the mouse: all of it is HostInput's mapping (js/host/input.js) ----
  // Keys go to the machine only when the screen has focus (or nothing on the page has: a first visit, before
  // any click) and no dialog is open. Everywhere else the page keeps them: Tab moves focus, Enter and Space
  // press the focused button, arrows move a slider, Esc closes a dialog. Releases always go through, so no
  // machine key stays down, and leaving the screen releases them all. Tab and Shift+Tab never reach the machine:
  // they always move focus, so a keyboard user can leave the screen (and reach the page from a first visit, when
  // nothing has focus yet); no machine key needs Tab (CLEAR is Home or Delete).
  const toMachine = (e) => (e.target === canvas || e.target === document.body || e.target === document.documentElement)
    && e.key !== 'Tab' && !document.querySelector('dialog[open]')
    // Esc closes what is open (page.escape, main.js) rather than being BREAK: off the screen anything, on it a
    // confirmation or a card
    && !(e.key === 'Escape' && (e.defaultPrevented || page.escapable(e.target === canvas)));
  window.addEventListener('keydown', (e) => {
    if (!toMachine(e) || e.key === 'F12' || e.key === 'F5') return;
    audio.start();
    if (input.keydown(e)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => input.keyup(e));
  window.addEventListener('blur', () => input.releaseAll());
  canvas.addEventListener('blur', () => input.releaseAll());
  // pasting text on the screen types it in
  window.addEventListener('paste', (e) => {
    if (!toMachine(e)) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    session.typeText(text);           // the machine shows what is typed
  });


  // the mouse: the right joystick's position while "Mouse = right joystick" is on, and the CoCo Max module's
  // own position (0..1 across the picture) whenever one is fitted. While the touch stick is showing it has the
  // joystick, so the mouse leaves it alone (the stick is what the person is holding).
  const touchStickUp = () => !!(page.touchKeys && page.touchKeys.stickActive && page.touchKeys.stickActive());
  // the mouse's own button: its press is remembered, so the release happens even if "Mouse = right joystick" was
  // turned off (or the touch stick came up) between the two, rather than leaving fire[0] held by nobody
  let mouseFire = false;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    input.setMouse({ x, y, left: input.mouse.left, right: input.mouse.right });
    if ($('chkJoy').checked && !touchStickUp()) { const joy = session.machine.joy[0]; joy[0] = Math.round(x * 63); joy[1] = Math.round(y * 63); }
  });
  canvas.addEventListener('mousedown', (e) => {
    input.setMouse({ x: input.mouse.x, y: input.mouse.y, left: true, right: input.mouse.right });
    if ($('chkJoy').checked && !touchStickUp()) { session.machine.fire[0] = true; mouseFire = true; e.preventDefault(); }
    audio.start();
  });
  window.addEventListener('mouseup', () => {
    input.setMouse({ x: input.mouse.x, y: input.mouse.y, left: false, right: input.mouse.right });
    if (mouseFire) { mouseFire = false; session.machine.fire[0] = false; }
  });
  canvas.addEventListener('contextmenu', (e) => {
    if (!session.machine.cartPort || session.machine.cartPort.type !== 'cocomax') return;
    e.preventDefault();
    input.setMouse({ x: input.mouse.x, y: input.mouse.y, left: input.mouse.left, right: true });
  });

  // the Input tab: the keyboard mode and the keyboard joystick, remembered
  const setMode = (mode) => {
    input.mode = mode;
    session.store.set('keyboardMode', mode);
    for (const b of document.querySelectorAll('#panel-input [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  };
  for (const b of document.querySelectorAll('#panel-input [data-mode]')) b.onclick = () => setMode(b.dataset.mode);
  setMode(input.mode);
  const joyKeys = $('chkKeyJoy');
  if (joyKeys) {
    joyKeys.checked = input.joyKeys;
    joyKeys.onchange = () => { input.joyKeys = joyKeys.checked; session.store.set('keyboardJoystick', joyKeys.checked ? '1' : '0'); };
  }

  // ---- drag and drop, anywhere on the page: files, folders and ZIPs; ROM images are recognised, the rest load
  // as programs. A "Drop to load" overlay shows while files are over the page; a drop never navigates away ----
  const wrap = $('screenWrap'), overlay = $('dropOverlay');
  let depth = 0;
  const files = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const showDrop = (on) => { overlay.hidden = !on; wrap.classList.toggle('drop', on); };
  window.addEventListener('dragenter', (e) => { if (!files(e)) return; e.preventDefault(); depth++; showDrop(true); });
  window.addEventListener('dragover', (e) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!files(e)) return; depth = Math.max(0, depth - 1); if (!depth) showDrop(false); });
  window.addEventListener('drop', async (e) => {
    depth = 0; showDrop(false);
    // a drop zone of its own took it already (the Add ROMs screen takes every file as a ROM): not again here
    if (e.defaultPrevented) return;
    if (!files(e) && !(e.dataTransfer && e.dataTransfer.items)) return;
    e.preventDefault();
    try { await roms.take(await roms.droppedFiles(e.dataTransfer), { onPrograms: loadPrograms }); }
    catch (err) { page.status(`That drop could not be read: ${err.message}`, true); }
  });

  // ---- the welcome menu by touch or click: a tap on one of its four lines presses that line's number ----
  // (text row r of the 32x16 screen is lines 24 + 12r .. 35 + 12r of every 240-line frame). While the touch
  // stick is showing, the person is playing a game, not choosing a menu line: no tap goes to the menu then.
  canvas.addEventListener('pointerup', (e) => {
    if (!session.welcomeRunning) return;
    if (touchStickUp()) return;
    const r = canvas.getBoundingClientRect(), f = session.machine.render();
    const row = Math.floor(((e.clientY - r.top) / r.height * f.height - 24) / 12);
    if (row >= 9 && row <= 12) { audio.start(); session.typeText(String(row - 8)); }
  });

  // ---- run controls ----
  // the screen shows a reset: no message
  $('btnReset').onclick = () => { session.reset(); page.focus(); };
  $('btnHardReset').onclick = () => { session.powerCycle(); page.focus(); };
  $('btnPause').onclick = () => {
    paused = !paused;
    document.body.classList.toggle('paused', paused);
    $('btnPause').textContent = paused ? 'Resume' : 'Pause';
    $('btnPause').classList.toggle('active', paused);
    audio.setActive(!paused && !document.hidden);
  };
  // a hidden tab runs no frames (see the frame loop): its sound context is suspended too
  document.addEventListener('visibilitychange', () => audio.setActive(!paused && !document.hidden));
  $('btnTurbo').onclick = () => { session.turbo = !session.turbo; $('btnTurbo').classList.toggle('active', session.turbo); };
  $('chkFastTape').onchange = (e) => { session.fastTape = e.target.checked; };
  session.fastTape = $('chkFastTape').checked;
  $('chkSound').onchange = (e) => { audio.enabled = e.target.checked; if (audio.enabled) audio.start(); };
  // fullscreen where the browser has it (not iPhone Safari): otherwise the button is not shown
  const goFull = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
  if (!goFull) $('btnFull').style.display = 'none';
  else $('btnFull').onclick = () => { Promise.resolve(goFull.call(wrap)).catch(() => page.status('Fullscreen is not available here', true)); };
  return { input, readPads };
}
