/*
 * The Display tab's "Old TV warm-up" (off by default; Session.oldTvWarmup, kept with the settings and so in a settings
 * export; no link sets it): a one-second warm-up drawn OVER the canvas at a power-on, the timeline of js/video/warmup.js.
 *
 * A power-on is the page starting, Switch off and on, and a machine switch (the Session's 'poweron' event: the machine
 * on screen switched on). It plays in the CRT view only, and never on a visit opened by a share link (#z=, #l=) or a
 * program page's start link, while the arrival card or a shared moment is up, with ?demo=1 or ?embed=1, with the
 * browser's Reduce motion, with Save data, or when the picture ran below 45 fps over the last 2 s (js/video/warmup.js,
 * warmupBlocked).
 *
 * It is the page's alone: #warmup is a sibling of the canvas that takes no pointer and no key (keys go to the machine
 * as ever), the canvas and every frame are untouched, so the machine, its frames, screenshots, share cards and GIFs
 * never hold it.
 */
import { $ } from './page.js';
import { warmupFrame, warmupBlocked, FrameRate, WARMUP_MS } from '../video/warmup.js';

// visit: what the visit was opened with, read once at its start { hash, start, demo, embed }
export function setupWarmup(page, visit = {}) {
  const { session, canvas } = page;
  const box = $('warmup'), top = box.querySelector('.wtop'), bot = box.querySelector('.wbot'),
    line = box.querySelector('.wline'), dim = box.querySelector('.wdim');
  const rate = new FrameRate();
  // startedAt: performance.now() of the warm-up playing, or null; frozen: a time held for a screenshot (the browser
  // check's freeze), or null; blocked: why the last power-on had none (warmupBlocked's reason), or null
  let startedAt = null, frozen = null, blocked = null, plays = 0;
  const media = (q) => { try { return matchMedia(q).matches; } catch (e) { return false; } };
  const context = () => ({
    on: session.oldTvWarmup,
    view: session.display.view,
    hash: visit.hash, start: visit.start, demo: visit.demo, embed: visit.embed,
    arrival: !!(session.arrivedFromLink || session.sharedMoment) || !$('arrival').hidden,
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    saveData: !!(navigator.connection && navigator.connection.saveData),
    slow: rate.slow(performance.now()),
  });
  function hide() { startedAt = null; frozen = null; if (!box.hidden) box.hidden = true; }
  function draw(t) {
    const f = warmupFrame(t);
    if (!f) { hide(); return; }
    // over the canvas, its size and place (the canvas is sized by the frame loop: js/ui/screen.js fit)
    Object.assign(box.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.offsetWidth}px`, height: `${canvas.offsetHeight}px` });
    const h = canvas.offsetHeight;
    // the black above and below the open part (all of it while it is a dot or a line)
    const cover = `${((1 - f.band) / 2) * 100}%`;
    top.style.height = cover; bot.style.height = cover;
    if (f.phase === 'dot') {
      Object.assign(line.style, { width: `${f.line * 100}%`, height: '2px', marginTop: '-1px', opacity: '1' });
    } else if (f.phase === 'open') {
      // the open part over-bright: white over the picture, the height of the open part
      Object.assign(line.style, { width: '100%', height: `${Math.max(2, f.band * h)}px`, marginTop: `${-Math.max(2, f.band * h) / 2}px`, opacity: String(f.bright) });
    } else line.style.opacity = '0';
    dim.style.opacity = String(1 - f.picture);
    box.dataset.phase = f.phase;
    if (box.hidden) box.hidden = false;
  }
  page.onFrame(() => {
    const now = performance.now();
    rate.tick(now);
    if (frozen != null) draw(frozen);
    else if (startedAt != null) draw(now - startedAt);
  });
  // a power-on: plays, or says why not (blocked)
  function play() {
    blocked = warmupBlocked(context());
    if (blocked) { hide(); return false; }
    startedAt = performance.now(); frozen = null; plays++;
    draw(0);
    return true;
  }
  session.on((ev) => {
    if (ev === 'poweron') play();
    // turned off, or the view left CRT, while it plays: it goes at once
    else if (ev === 'display' && startedAt != null && (!session.oldTvWarmup || session.display.view !== 'crt')) hide();
  });
  // the Display tab's checkbox
  const chk = $('chkWarmup');
  const show = () => { chk.checked = session.oldTvWarmup; };
  chk.onchange = () => session.setOldTvWarmup(chk.checked);
  session.on((ev) => { if (ev === 'display') show(); });
  show();
  return {
    play,
    // for the browser check: what is drawn now, and a time held (a screenshot at 300 ms), or released with null
    get state() { return { playing: !box.hidden, phase: box.hidden ? null : box.dataset.phase, blocked, plays, ms: WARMUP_MS, fps: rate.rate(performance.now()) }; },
    freeze(t) { if (t == null) { hide(); return; } frozen = t; draw(t); },
    // for the browser check: the frame-rate meter the 45 fps rule reads (FrameRate), which the check feeds a steady
    // history of frames before a power-on it expects to play, so a loaded runner's own frame rate cannot decide it
    rate,
  };
}
