/*
 * The cassette panel, under the screen while a tape
 * is in the deck or the deck is recording: what the deck is doing (LOADING · BLOCK 14 OF 31, a read error, end
 * of tape), the cassette with its label and reels (the tape winds from left to right as it plays), the tape's
 * bytes as a waveform strip coloured up to the play position, the progress stripe in the VDG colours, the
 * counter, the bit frequencies, the motor, how fast it is going, and two controls: real speed (the Media tab's
 * "Fast tape loading", inverted) and "Skip the tape (load instantly)". A read error (BASIC's ?IO ERROR as the
 * motor stops) marks its block red and offers a rewind. "Hide the deck" folds it to its text and controls.
 *
 * It is the one deck that moves: its reels turn only while the tape really moves (the play position changed since
 * the last look), never at the end of the tape or with the motor on and the tape still; the slot's deck under the
 * screen is a still picture. The end of the tape is stamped on the cassette.
 *
 * The tape HUD: the panel is below the screen, often out of view, so while a tape plays (and for HUD_HOLD_MS after
 * it is inserted, stops or ends) a compact line on the screen's border says what it is doing: the name, S (BASIC
 * searching) or F (found, from BASIC's own report in the screen's top-left corner), the block and the progress,
 * playing or stopped, End of tape; with the Tape sound switch and "Deck", which opens the panel. It lies under the
 * picture's text area (or above it), never on it, and is not shown where there is no such place: placeHud. A
 * polite live region says once when a tape starts playing and once when it ends.
 *
 * Tape sound (js/host/tape-sound.js): the tape heard as a recorder's speaker plays it, on the page's side. On by
 * default, remembered (tapeSound), in the HUD and the Media tab.
 */
import { $, put, putStyle, putClass } from './page.js';

const pad3 = (n) => String(Math.max(0, Math.floor(n)) % 1000).padStart(3, '0');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const POLL_MS = 250;
const HUD_HOLD_MS = 5000;   // the HUD stays this long after a tape goes in, stops or ends

export function setupTapePanel(page) {
  const { session, audio } = page;
  const panel = $('tapePanel'), wave = $('tapeWave'), hud = $('tapeHud');
  let lastPos = null, hudUntil = 0, wasMotor = false, hudTape = null;
  let waveFor = null, heights = [];
  let speed = { at: performance.now(), frame: 0, x: 0 };

  // bar heights from the tape's bytes (decorative, aria-hidden): one bar per stretch of the image
  function shape(t) {
    const n = 48, b = t.bytes, per = Math.max(1, Math.floor(b.length / n));
    heights = Array.from({ length: n }, (_, i) => {
      let ones = 0, count = 0;
      for (let j = i * per; j < Math.min(b.length, (i + 1) * per); j += Math.max(1, Math.floor(per / 16))) {
        let v = b[j]; while (v) { ones += v & 1; v >>= 1; } count++;
      }
      return count ? 0.2 + 0.7 * ones / (count * 8) : 0.1;
    });
    waveFor = t;
  }
  function drawWave(st) {
    const r = wave.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
    const g = wave.getContext('2d'), n = heights.length, step = w / n, bw = Math.max(2, step * 0.6);
    g.clearRect(0, 0, w, h);
    heights.forEach((v, i) => {
      const done = (i + 0.5) / n <= st.progress;
      const bad = st.error && Math.abs((i + 0.5) / n - st.progress) < 1.5 / n;
      g.fillStyle = bad ? '#D8202A' : done ? '#FF9A2E' : '#5C3A14';
      const bh = v * h * 0.85;
      g.fillRect(i * step + (step - bw) / 2, (h - bh) / 2, bw, bh);
    });
  }

  // S and F: BASIC's own report in the top-left corner of its text screen while the motor runs ("S" searching, "F name"
  // found); '' when the screen doesn't show one (another program, a graphics mode)
  function basicSays() {
    const top = (session.screenText()[0] || '');
    return /^S(\s|$)/.test(top) ? 'S' : /^F\s/.test(top) ? 'F' : '';
  }

  // The HUD where it can be seen and covers none of the picture's text: in the band between the text and the bottom
  // of what shows of the screen (the tube, or the wrapper alone in the browser's Fullscreen, cut to the viewport), else
  // in the band above the text, compact if it has to be. It must be on top where it lies (nothing else, such as touch
  // keys laid over the tube, covers it). With no such place (the phone chat shows the text edge to edge) it is not
  // shown: the cassette panel still says it all. -> whether it was placed
  let placedFor = '';
  function placeHud() {
    const wrap = $('screenWrap'), cv = $('screen'), w = wrap.getBoundingClientRect(), c = cv.getBoundingClientRect();
    // nothing it depends on changed (the boxes, the text area, the HUD's text, Fullscreen): left as it is, no writes
    const key = [w.left, w.top, w.width, w.height, c.left, c.top, c.width, c.height, wrap.parentElement.getBoundingClientRect().height, cv.dataset.active,
      innerWidth, innerHeight, !!document.fullscreenElement, $('hudName').textContent, $('hudState').textContent].join();
    if (key === placedFor) return !hud.classList.contains('noroom');
    placedFor = key;
    putClass(hud, 'noroom', false);
    if (!c.width || !w.width) { hud.classList.add('noroom'); return false; }
    const f = (cv.dataset.active || '0,0,1,1').split(',').map(Number);
    const textTop = c.top + f[1] * c.height, textBottom = c.top + f[3] * c.height;
    const shown = document.fullscreenElement === wrap ? w : wrap.parentElement.getBoundingClientRect();
    const top = Math.max(shown.top, 0), bottom = Math.min(shown.bottom, innerHeight);
    const bands = [[textBottom + 2, bottom - 2], [top + 2, textTop - 2]];
    const name = $('hudName');
    // on top at its centre and near both ends (elementFromPoint: null outside the viewport)
    const onTop = () => {
      const r = hud.getBoundingClientRect(), y = r.top + r.height / 2;
      return [r.left + 6, r.left + r.width / 2, r.right - 6].every((x) => { const e = document.elementFromPoint(x, y); return !!e && hud.contains(e); });
    };
    for (const compact of [false, true]) {
      putClass(hud, 'compact', compact);
      // measured from the left edge (an absolute box shrinks to the room right of where it was left)
      putStyle(hud, 'left', '0px');
      putStyle(hud, 'max-width', `${Math.max(120, Math.round(c.width - 12))}px`);
      // the progress bar gives way to the name where the two don't both fit
      putClass(hud, 'nobar', false);
      if (name.scrollWidth > name.clientWidth) putClass(hud, 'nobar', true);
      const h = hud.offsetHeight, x = c.left + (c.width - hud.offsetWidth) / 2;
      for (const [a, b] of bands) {
        if (b - a < h) continue;
        putStyle(hud, 'left', `${Math.round(x - w.left)}px`);
        putStyle(hud, 'top', `${Math.round((a + b - h) / 2 - w.top)}px`);
        if (onTop()) return true;
      }
    }
    putClass(hud, 'noroom', true);
    return false;
  }

  // one polite announcement when a tape starts and when it ends (the HUD's own text changes four times a second)
  let said = '';
  const announce = (key, text) => { if (key !== said) { said = key; $('hudSay').textContent = text; } };

  function updateHud(st, moving) {
    const now = performance.now();
    if (!st) { put(hud, 'hidden', true); wasMotor = false; hudTape = null; said = ''; return; }
    // a tape going in (dropped, opened, from a link) shows the HUD for a moment, before (or without) the motor
    if (session.machine.deck.tape !== hudTape) { hudTape = session.machine.deck.tape; hudUntil = now + HUD_HOLD_MS; }
    // the HUD shows while the tape plays and HUD_HOLD_MS after it stops or ends (or goes in: hudUntil); at the end
    // of the tape it goes even with the motor still on (BASIC may leave it on)
    const running = st.motor && st.progress < 1;
    if (running || (wasMotor && !running)) hudUntil = now + HUD_HOLD_MS;
    wasMotor = running;
    const show = running || now < hudUntil;
    if (running) announce(`play:${st.name}`, `Tape ${st.name} playing`);
    else if (st.progress >= 1) announce(`end:${st.name}`, `End of tape ${st.name}`);
    if (!show) { put(hud, 'hidden', true); return; }
    const state = st.error ? 'error' : st.progress >= 1 ? 'end' : moving ? 'playing' : st.motor ? 'waiting' : st.block ? 'stopped' : 'ready';
    put(hud.dataset, 'state', state);
    const says = st.motor && !st.error && st.progress < 1 ? basicSays() : '';
    put($('hudName'), 'textContent', st.name);
    put($('hudState'), 'textContent', state === 'error' ? `Read error · block ${st.error}`
      : state === 'end' ? 'End of tape'
        : `${says ? `${says} · ` : ''}${state === 'ready' ? 'In the deck' : state === 'stopped' ? 'Stopped · ' : ''}${state === 'ready' ? '' : `${Math.max(1, st.block)}/${st.blocks}`}`);
    putStyle($('hudBar'), 'width', `${(st.progress * 100).toFixed(1)}%`);
    put(hud, 'title', `${st.name}: ${$('hudState').textContent}${says === 'S' ? ' (S: BASIC is searching for the file)' : says === 'F' ? ' (F: BASIC found the file)' : ''}`);
    if ($('btnHudSound').getAttribute('aria-pressed') !== String(audio.tapeSound)) $('btnHudSound').setAttribute('aria-pressed', String(audio.tapeSound));
    put(hud, 'hidden', false);
    placeHud();
  }

  function update() {
    const m = session.machine;
    if (!m) return;
    const st = session.tapeStatus(), rec = session.tapeRecording;
    // moving: the play position changed since the last look (the motor alone says nothing: at the end of the tape,
    // or with the machine paused, it stays on and nothing turns)
    const pos = st ? `${m.deck.tape.idx}:${m.deck.tape.left}` : null;
    const moving = !!(st && st.playing && lastPos !== null && pos !== lastPos);
    lastPos = pos;
    updateHud(st, moving);
    put(panel, 'hidden', !st && !rec);
    if (panel.hidden) return;
    if (panel.hasAttribute('data-moving') !== moving) panel.toggleAttribute('data-moving', moving);
    // measured speed: emulated frames per real second against the machine's own rate
    const now = performance.now();
    if (now - speed.at >= 1000) { speed = { at: now, frame: m.frameCount, x: (m.frameCount - speed.frame) / m.fps / ((now - speed.at) / 1000) }; }
    const eyebrow = $('tapeEyebrow');
    putClass(eyebrow, 'error', !!(st && st.error));
    put($('tapeEnd'), 'hidden', !(st && st.progress >= 1));
    if (rec && !st) {
      put(eyebrow, 'textContent', m.deck.motor ? 'RECORDING · MOTOR ON' : 'RECORDING · WAITING FOR THE MOTOR');
      put($('tapeLabel'), 'textContent', 'Recording'); put($('tapeLength'), 'textContent', '');
      put(panel.dataset, 'state', 'recording');
      put($('btnSkipTape'), 'hidden', true); put($('btnTapeRetry'), 'hidden', true);
      put($('tapeCounter'), 'textContent', `motor ${m.deck.motor ? 'ON' : 'off'}`); put($('tapeSpeed'), 'textContent', '');
      putStyle($('tapeBar'), 'width', '0%');
      return;
    }
    if (waveFor !== m.deck.tape) shape(m.deck.tape);
    const p = m.profile.tape || {};
    put(eyebrow, 'textContent', st.error ? `READ ERROR · BLOCK ${st.error} OF ${st.blocks}`
      : st.progress >= 1 ? `END OF TAPE · ${st.blocks} BLOCKS`
        : st.motor ? `${rec ? 'RECORDING · ' : ''}LOADING · BLOCK ${Math.max(1, st.block)} OF ${st.blocks}`
          : `STOPPED · BLOCK ${st.block} OF ${st.blocks}`);
    put(panel.dataset, 'state', st.error ? 'error' : st.progress >= 1 ? 'end' : st.motor ? 'playing' : 'stopped');
    put($('tapeLabel'), 'textContent', st.name);
    put($('tapeLength'), 'textContent', mmss(st.duration));
    putStyle($('reelL'), '--wound', (1 - st.progress).toFixed(3));
    putStyle($('reelR'), '--wound', st.progress.toFixed(3));
    putStyle($('tapeBar'), 'width', `${(st.progress * 100).toFixed(1)}%`);
    // the stripe keeps its full-width colours: the bar only uncovers more of it
    putStyle($('tapeBar'), '--stripe-w', st.progress > 0 ? `${(100 / st.progress).toFixed(1)}%` : '100%');
    put($('tapeCounter'), 'textContent', `Counter ${pad3(st.seconds)} · ${p.zeroHz || 1200}/${p.oneHz || 2400} Hz · motor ${st.motor ? 'ON' : 'off'}`);
    put($('tapeSpeed'), 'textContent', !st.playing ? '' : st.realSpeed ? 'Real speed' : `Fast-forward ×${Math.max(1, Math.round(speed.x))}`);
    if ($('btnRealSpeed').getAttribute('aria-pressed') !== String(st.realSpeed)) $('btnRealSpeed').setAttribute('aria-pressed', String(st.realSpeed));
    put($('btnRealSpeed'), 'textContent', `Real speed: ${st.realSpeed ? 'on' : 'off'}`);
    put($('btnSkipTape'), 'hidden', st.progress >= 1);
    put($('btnTapeRetry'), 'hidden', !st.error);
    if (!panel.classList.contains('folded')) drawWave(st);
  }

  // Tape sound: one setting, in the HUD and the Media tab, remembered
  const setTapeSound = (on, remember = true) => {
    audio.tapeSound = on;
    $('chkTapeSound').checked = on;
    $('btnHudSound').setAttribute('aria-pressed', String(on));
    if (remember) session.store.set('tapeSound', on ? '1' : '0');
  };
  setTapeSound(session.store.get('tapeSound') !== '0', false);
  $('chkTapeSound').onchange = (e) => { setTapeSound(e.target.checked); if (e.target.checked) audio.start(); };
  $('btnHudSound').onclick = () => { setTapeSound(!audio.tapeSound); if (audio.tapeSound) audio.start(); page.focus(); };
  // the deck folded to its text and controls, or open again
  const fold = (folded) => {
    panel.classList.toggle('folded', folded);
    $('btnDeckFold').setAttribute('aria-expanded', String(!folded));
    $('btnDeckFold').textContent = folded ? 'Show the deck' : 'Hide the deck';
  };
  $('btnDeckFold').onclick = () => { fold(!panel.classList.contains('folded')); update(); };
  // "Deck" in the HUD: the panel, open, brought into view
  $('btnHudDeck').onclick = () => {
    fold(false); update();
    panel.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $('btnDeckFold').focus({ preventScroll: true });
  };
  // placed again as soon as the screen changes size (a window resize, Fullscreen, the chat), not at the next update:
  // the canvas is refitted after the window, and a HUD left where it was would lie on the grown picture's text
  const replace = () => { if (!hud.hidden) placeHud(); };
  new ResizeObserver(replace).observe($('screen'));
  new ResizeObserver(replace).observe($('screenWrap'));
  window.addEventListener('resize', replace);

  // real speed is the Media tab's "Fast tape loading" turned round: one setting, two places
  $('btnRealSpeed').onclick = () => {
    const box = $('chkFastTape');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    update();
  };
  $('btnSkipTape').onclick = () => { page.attempt(() => session.skipTape()); update(); page.focus(); };
  $('btnTapeRetry').onclick = () => { session.rewindTape(); page.status('Tape rewound: type CLOAD (or CLOADM) again'); update(); page.focus(); };
  session.on((ev) => {
    if (ev === 'machine' || ev === 'loaded' || ev === 'tape') update();
  });
  setInterval(update, POLL_MS);
  return { update };
}
