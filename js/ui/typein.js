/*
 * Type-in mode (the Library's "listing from the suitcase"): a pasted BASIC listing typed into the
 * running machine through its keyboard at keyboard speed, line by line, with the machine's screen beside it,
 * progress, and a check of the listing's line numbers. "Paste instantly" types the same keys with the
 * emulation running flat out. Listings are BASIC, so this needs the machine's BASIC ROMs; without them the card
 * says so and offers to add them. (The design's "From a photo…" needs text recognition, which CLOADM doesn't
 * have; it is not built.)
 *
 * The keys go through the Typist (js/machines/typist.js): each key is held 3 frames and released 2, so the
 * speed is the machine's frame rate / 5 keys a second, as a careful typist.
 *
 * The screen beside it is drawn at a whole number of device pixels per line, as the main screen's integer
 * scaling does (fitPicture), the largest that fits the card: stretched by a fraction with nearest-neighbour
 * pixels, some rows and columns would be drawn twice as thick as others and the text would look uneven. When
 * that whole number leaves the screen too small (under INTEGER_MIN of the card's width: a phone at 2× would get
 * half the card), it fills the card instead, by a fraction, as large text is easier to read than even text.
 */
import { CanvasPresenter } from '../video/canvas.js';
import { fitPicture } from '../video/layout.js';
import { checkListing } from '../session.js';
import { $ } from './page.js';

const KEY_FRAMES = 5;
// the smallest share of the card's width a whole-number scale may leave the screen at (a 1440 px window at 1× or
// 2× gets 74%; a 390 px phone at 2× 51%, at 3× 68%)
export const INTEGER_MIN = 0.7;       // Typist: 3 frames down + 2 up
export function setupTypein(page, { openRoms, isVisible }) {
  const { session } = page;
  const src = $('typeinSource'), canvas = $('typeinScreen'), screen = new CanvasPresenter(canvas);
  // the screen's size on the page: a whole number of device pixels per line, as wide as the card allows
  let sizedFor = '';
  function size(frame) {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, room = canvas.parentElement.clientWidth;
    const key = [room, dpr, frame.width, frame.height, frame.aspect].join();
    if (key === sizedFor || !room) return;
    sizedFor = key;
    let s = fitPicture({ areaW: room * dpr, areaH: Infinity, aspect: frame.aspect, lines: frame.height, integer: true });
    if (s.width < INTEGER_MIN * room * dpr) s = fitPicture({ areaW: room * dpr, areaH: Infinity, aspect: frame.aspect, lines: frame.height });
    canvas.style.width = `${s.width / dpr}px`;
    canvas.style.height = `${s.height / dpr}px`;
  }
  let job = null;    // { text, total, lines, turbo, wasTurbo }: the listing being typed

  const lines = () => src.value.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  function status() {
    const m = session.personMachine;   // the machine the listing goes into
    if (!m) return;                 // before the page has started a machine
    const needs = m.useStub;
    $('typeinNeeds').hidden = !needs;
    $('btnTypein').disabled = needs || !!job; $('btnTypeinFast').disabled = needs || !!job;
    const problems = checkListing(src.value);
    const check = $('typeinCheck');
    check.textContent = !lines().length ? '' : problems.length ? `Line check: ${problems.slice(0, 2).join('; ')}${problems.length > 2 ? ` and ${problems.length - 2} more` : ''}` : 'Line check: no problems';
    check.className = problems.length ? 'warn' : 'ok';
    if (!job) {
      $('typeinBar').style.width = '0%';
      $('typeinProgress').textContent = lines().length ? `${lines().length} lines · typing at ${(m.fps / KEY_FRAMES).toFixed(0)} keys/s` : 'Paste a listing above';
    }
  }
  function start(turbo) {
    const l = lines();
    if (!l.length) { page.status('Paste a listing first', true); return; }
    const text = `NEW\n${l.join('\n')}\n`;
    session.typeText(text);
    job = { text, total: text.length, lines: l, turbo, wasTurbo: session.turbo };
    if (turbo) session.turbo = true;
    status();
  }
  function tick() {
    if (!session.personMachine) { requestAnimationFrame(tick); return; }
    if (job) {
      const m = session.personMachine, left = m.typist.queue.length + (m.typist.state ? 1 : 0);
      const done = job.total - left;
      // which line the typist is on: count the line ends already typed (NEW is line 0)
      const ends = (job.text.slice(0, done).match(/\n/g) || []).length;
      const at = Math.min(job.lines.length, Math.max(1, ends));
      $('typeinBar').style.width = `${(100 * done / job.total).toFixed(1)}%`;
      $('typeinProgress').textContent = `Line ${job.lines[at - 1].match(/^\s*(\d+)/)?.[1] ?? at} of ${job.lines[job.lines.length - 1].match(/^\s*(\d+)/)?.[1] ?? job.lines.length}`
        + (job.turbo ? ' · flat out' : ` · typing at ${(m.fps / KEY_FRAMES).toFixed(0)} keys/s`);
      if (!m.typist.busy) {
        session.turbo = job.wasTurbo;
        job = null;
        $('typeinBar').style.width = '100%';
        $('typeinProgress').textContent = 'Typed in. Type RUN on the machine to run it.';
        $('btnTypein').disabled = false; $('btnTypeinFast').disabled = false;
      }
    }
    if (isVisible()) { const frame = session.machine.render(); size(frame); screen.present(frame); }
    requestAnimationFrame(tick);
  }
  $('btnTypein').onclick = () => start(false);
  $('btnTypeinFast').onclick = () => start(true);
  $('btnTypeinRoms').onclick = openRoms;
  src.addEventListener('input', status);
  session.on((ev) => { if (ev === 'machine' || ev === 'roms' || ev === 'firmware') { if (job) { session.turbo = job.wasTurbo; job = null; } status(); } });
  status();
  requestAnimationFrame(tick);
}
