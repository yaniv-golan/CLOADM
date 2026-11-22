/* The screen: the frame loop, host input (keyboard, gamepads, the mouse), drag and drop, and the run controls. */
import { $ } from './page.js';
import { CanvasPresenter, GlPresenter } from '../video/canvas.js';
import { fitPicture, fitActive } from '../video/layout.js';
import { HostInput } from '../host/input.js';
import { Gamepads } from '../host/gamepad.js';
import { TapeListener } from '../host/tape-sound.js';

export function setupScreen(page, { loadPrograms, roms }) {
  const { session, audio, canvas } = page;
  // WebGL for the CRT look; without it, the pixels only (the Display tab says so)
  let presenter = null;
  try { presenter = GlPresenter.create(canvas); } catch (e) { presenter = null; }
  if (!presenter) presenter = new CanvasPresenter(canvas);
  page.crtAvailable = presenter.crt;
  // HostInput maps keys, gamepads and the mouse; its held keys go through the Session's KeyQueue, so a fast
  // typist's keys are applied in order at frame starts and none is lost (js/machines/keyqueue.js)
  const input = new HostInput(session.shownMachine, session.keys);
  const pads = new Gamepads();
  let havePads = false;
  const applyInputSettings = () => {
    input.mode = session.store.get('keyboardMode') === 'positional' ? 'positional' : 'translated';
    input.joyKeys = session.store.get('keyboardJoystick') === '1';
  };
  session.on((ev) => {
    if (ev === 'machine') { input.setMachine(session.shownMachine); applyInputSettings(); }
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
  // a gamepad, or the mouse as joystick, moved out of its dead zone or fire pressed: the person's input
  input.onPlayer = () => session.personInput();
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
  // the page's "Tape sound" (js/host/tape-sound.js): the tape's signal over each frame, read from the deck after it
  const tapeListener = new TapeListener();
  const tapeFrame = (m) => { const ev = tapeListener.frame(m.deck, m.frameCycles); return ev ? { events: ev, cycles: m.frameCycles } : null; };
  let shown = { picture: null, display: null, width: 0, height: 0, steps: -1, restores: 0 };
  let altTime = -Infinity, alt = null;
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = now - last; last = now;
    // the UI's per-frame work runs whether or not the machine does: the things it follows (the boot state,
    // the tape motor, whether audio has been unlocked) change without a frame, and the timers it replaces
    // ran while paused too. document.hidden is the exception -- nothing needs updating on a hidden page.
    if (document.hidden) return;
    page.tickUi();
    const m = session.shownMachine;
    let ran = 0;
    if (!paused) {
      readPads();
      ran = session.advance(dt, { onFrame: () => audio.pushFrame(m.audioEvents, m.frameCycles, m.fps, tapeFrame(m)), now: () => performance.now() });
      // Fast tape loading (and Turbo) run the machine flat out and push no frames' sound. The tape is still heard:
      // what passes the head at real speed, at its real pitch, for the real time that went by (the tape's own
      // tones, its leader and the gaps between blocks, as the deck flies through them). Played 30 to 60 times
      // faster, the signal would be far above hearing (its 1200/2400 Hz bits at 40-140 kHz): there is no truthful
      // fast-forward sound to give, and silence would hide that the tape is playing at all.
      if (ran && (session.turbo || session.tapeRunning)) {
        const ev = tapeListener.slice(m.deck, Math.min(dt, 100) / 1000 * m.tickHz);
        if (ev) audio.pushTape(Math.min(dt, 100), { events: ev, cycles: Math.min(dt, 100) / 1000 * m.tickHz });
      }
      fpsFrames += ran;
    }
    const picture = m.render(), box = fit(picture), display = session.display, steps = session.debugger ? session.debugger.steps : 0, restores = presenter.restores;
    if (ran || picture !== shown.picture || display !== shown.display || box.width !== shown.width || box.height !== shown.height || steps !== shown.steps || restores !== shown.restores) {
      presenter.present(picture, display, box.width, box.height);
      shown = { picture, display, width: box.width, height: box.height, steps, restores };
    }
    // the canvas's text alternative (#screenAlt, its fallback content): the screen as text for a screen reader or a
    // reader view, at most once a second, and written only when it changed
    if (now - altTime >= 1000) {
      altTime = now;
      const t = session.screenAlternative();
      if (t !== alt) { $('screenAlt').textContent = t; alt = t; }
    }
    if (paused) return;
    if (now - fpsTime >= 1000) { fps = fpsFrames * 1000 / (now - fpsTime); fpsFrames = 0; fpsTime = now; }
    const s = session.statusLine(fps);
    if (s !== lastStatus) { const el = $('status'); el.textContent = s; el.title = s; lastStatus = s; }   // the title carries what a narrow bar clips
  }
  requestAnimationFrame(tick);

  // ---- keyboard, gamepads and the mouse: all of it is HostInput's mapping (js/host/input.js) ----
  // Keys go to the machine only when the screen has focus (or nothing on the page has: a first visit, before
  // any click) and no dialog is open. Everywhere else the page keeps them: Tab moves focus, Enter and Space
  // press the focused button, arrows move a slider, Esc closes a dialog. Releases always go through, so no
  // machine key stays down, and leaving the screen releases them all. Tab and Shift+Tab never reach the machine:
  // they always move focus, so a keyboard user can leave the screen (and reach the page from a first visit, when
  // nothing has focus yet); no machine key needs Tab (CLEAR is Home or Delete).
  // (page.toMachine says which events go to the machine; js/ui/ask.js pauses Claude for the same ones, first)
  window.addEventListener('keydown', (e) => {
    if (!page.toMachine(e)) return;
    audio.start();
    if (input.keydown(e)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => input.keyup(e));
  window.addEventListener('blur', () => input.releaseAll());
  canvas.addEventListener('blur', () => input.releaseAll());
  // pasting text on the screen types it in
  window.addEventListener('paste', (e) => {
    if (!page.toMachine(e)) return;
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
    if ($('chkJoy').checked && !touchStickUp()) { input.player('mouse', x * 2 - 1, y * 2 - 1, input.mouse.left); const joy = session.shownMachine.joy[0]; joy[0] = Math.round(x * 63); joy[1] = Math.round(y * 63); }
  });
  canvas.addEventListener('mousedown', (e) => {
    input.setMouse({ x: input.mouse.x, y: input.mouse.y, left: true, right: input.mouse.right });
    if ($('chkJoy').checked && !touchStickUp()) { input.player('mouse', input.mouse.x * 2 - 1, input.mouse.y * 2 - 1, true); session.shownMachine.fire[0] = true; mouseFire = true; e.preventDefault(); }
    audio.start();
  });
  window.addEventListener('mouseup', () => {
    input.setMouse({ x: input.mouse.x, y: input.mouse.y, left: false, right: input.mouse.right });
    if (mouseFire) { mouseFire = false; session.shownMachine.fire[0] = false; input.player('mouse', input.mouse.x * 2 - 1, input.mouse.y * 2 - 1, false); }
  });
  canvas.addEventListener('contextmenu', (e) => {
    if (!session.shownMachine.cartPort || session.shownMachine.cartPort.type !== 'cocomax') return;
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

  // ---- the welcome menu by touch or click: a tap on one of its lines presses that line's number ----
  // (text row r of the 32x16 screen is lines 24 + 12r .. 35 + 12r of every 240-line frame). A menu line starts
  // with its number in inverse video at column 4 (both builds, every menu: the main one, the carry-on line, the
  // games menu), so the tapped row's cell there says which key it is. While the touch stick is showing, the
  // person is playing a game, not choosing a menu line: no tap goes to the menu then.
  canvas.addEventListener('pointerup', (e) => {
    if (!session.welcomeRunningOn) return;   // the machine ON SCREEN: this handler taps and types on session.shownMachine
    if (touchStickUp()) return;
    const m = session.shownMachine, r = canvas.getBoundingClientRect(), f = m.render();
    const row = Math.floor(((e.clientY - r.top) / r.height * f.height - 24) / 12);
    if (row < 0 || row > 15) return;
    const cell = m.peek((m.profile.textScreen || 0x400) + row * 32 + 4);
    if (cell >= 0x30 && cell <= 0x39) { audio.start(); session.typeText(String.fromCharCode(cell)); }
  });

  // ---- run controls ----
  // the screen shows a reset: no message
  $('btnReset').onclick = () => { session.reset(); page.focus(); };
  $('btnHardReset').onclick = () => { session.powerCycle({ reason: 'you power cycled the machine' }); page.focus(); };
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
