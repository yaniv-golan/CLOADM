/*
 * Old TV warm-up (the Display tab's "Old TV warm-up", off by default): one second at a power-on, drawn by the page
 * over the picture (js/ui/warmup.js), never by the machine. Browser-free, so the timeline and the rules are tested in
 * Node (tests/warmup.test.js).
 *
 * The timeline, WARMUP_MS (1000 ms) long:
 *     0-150 ms   a dot in the middle of a black screen becomes a horizontal line across it;
 *   150-450 ms   the line opens to the full height, showing the picture over-bright;
 *   450-1000 ms  the real picture fades from 40% to 100%.
 * No noise, no roll, no hum.
 *
 * warmupFrame(t) -> null once it is over (or before it starts), else
 *   { phase: 'dot' | 'open' | 'fade', line, band, bright, picture }
 *     line    the line's width, a fraction of the screen's (dot phase; 1 from then on)
 *     band    the open part's height, a fraction of the screen's (0 in the dot phase: the line alone shows)
 *     bright  how much white lies over the open part (0..1): the over-bright picture
 *     picture how much of the picture shows through (0..1): 0 while it is a dot, 0.4..1 while it fades
 */
import { PROGRAM_PAGES } from '../program-pages.js';

export const WARMUP_MS = 1000;
export const DOT_MS = 150, OPEN_MS = 450;
export const FADE_FROM = 0.4;
// the over-bright white over the opening picture: from this much at the line to this much at full height
export const BRIGHT_FROM = 0.6, BRIGHT_TO = 0.35;
const ease = (p) => 1 - (1 - p) * (1 - p);   // fast, then settling: an ease-out

export function warmupFrame(t) {
  if (!(t >= 0) || t >= WARMUP_MS) return null;
  if (t < DOT_MS) {
    const p = t / DOT_MS;
    return { phase: 'dot', line: 0.01 + 0.99 * ease(p), band: 0, bright: 1, picture: 0 };
  }
  if (t < OPEN_MS) {
    const p = (t - DOT_MS) / (OPEN_MS - DOT_MS);
    return { phase: 'open', line: 1, band: ease(p), bright: BRIGHT_FROM + (BRIGHT_TO - BRIGHT_FROM) * p, picture: 1 };
  }
  const p = (t - OPEN_MS) / (WARMUP_MS - OPEN_MS);
  return { phase: 'fade', line: 1, band: 1, bright: 0, picture: FADE_FROM + (1 - FADE_FROM) * p };
}

// The picture "runs slow" when fewer than SLOW_FPS frames a second were drawn over the last SLOW_WINDOW_MS. With less
// than that much history (the page has only just started) it is not known to be slow.
export const SLOW_FPS = 45, SLOW_WINDOW_MS = 2000;
export class FrameRate {
  constructor() { this.times = []; this.since = null; }
  // one frame drawn at `now` (ms)
  tick(now) {
    if (this.since == null) this.since = now;
    this.times.push(now);
    while (this.times.length && this.times[0] <= now - SLOW_WINDOW_MS) this.times.shift();
  }
  // the frames a second over the last SLOW_WINDOW_MS, or null with less history than that
  rate(now) {
    if (this.since == null || now - this.since < SLOW_WINDOW_MS) return null;
    const n = this.times.filter((t) => t > now - SLOW_WINDOW_MS).length;
    return n * 1000 / SLOW_WINDOW_MS;
  }
  slow(now) { const r = this.rate(now); return r != null && r < SLOW_FPS; }
}

// The programs whose start link the program pages (cloadm.dev/<id>/) send the visitor to: a visit opened with one of
// these is a program page's, and gets no warm-up. The page can't tell a program page's visit from another start= link
// to the same program (the landing's "Talk to LIZA" is the same link), so every start= naming a program counts.
// From the program pages' own list (js/program-pages.js), plus WYRMFIRE: it has no program page, but start=wyrmfire
// opens a program the same way and is linked to from its shelf and README, so it is treated as one.
export const PROGRAM_STARTS = Object.freeze([...PROGRAM_PAGES.map((p) => p.id), 'wyrmfire']);

// Why the warm-up does not play at a power-on, or null when it plays. ctx (every field optional):
//   on: the setting; view: the Display view ('crt' | 'sharp'); hash: location.hash at the visit's start;
//   start: the link's start=; demo, embed: ?demo=1, ?embed=1; arrival: a shared moment or the arrival card is up;
//   reducedMotion, saveData: the browser's preferences; slow: the picture ran below SLOW_FPS over SLOW_WINDOW_MS
export function warmupBlocked(ctx) {
  const c = ctx || {};
  if (!c.on) return 'off';
  if (c.view !== 'crt') return 'view';
  if (/^#[zl]=/.test(c.hash || '')) return 'shared-link';
  if (c.start && PROGRAM_STARTS.includes(c.start)) return 'program-page';
  if (c.arrival) return 'arrival';
  if (c.demo) return 'demo';
  if (c.embed) return 'embed';
  if (c.reducedMotion) return 'reduced-motion';
  if (c.saveData) return 'save-data';
  if (c.slow) return 'slow';
  return null;
}
