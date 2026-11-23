/* Tape sound: the tape heard as a cassette recorder's own speaker plays it, on the host side.
 *
 * The page's "Tape sound" option. It is not the machine's sound: the machine's own audio (the sound mux, BASIC's
 * AUDIO ON) is emulated as MAME 0.264 does it, which mixes no tape signal (tools/mame-diff/sam/cass-sound.js). This
 * is a recorder's speaker beside the machine, whatever the machine routes. It reads the tape and changes nothing:
 * nothing here is machine state, and nothing goes into a snapshot.
 *
 * TapeListener follows the tape in the deck from frame to frame (browser-free; tests/tape-sound.test.js):
 *   frame(deck, frameCycles)  after a frame has run: the tape's signal over that frame, as level events
 *                             [cycle, level, ...] (level +1 or -1), or null when the tape did not move (stopped,
 *                             at its end, no tape, another tape, a seek)
 *   slice(deck, cycles)       the signal from where the tape is now, `cycles` long, read without moving it: what the
 *                             head passes at real speed, for fast loading (see js/ui/screen.js)
 * TapeVoice turns those events into samples, as a small speaker would play them: the box-filtered level, through a
 * two-pole low-pass (LOWPASS_HZ: the square's harsh edges rounded off) and a DC-blocking high-pass, so a tape that
 * stops holds its last level and fades to silence on its own, without a click.
 */

const LOWPASS_HZ = 3200;
const DEFAULT_VOLUME = 0.15;   // against the machine's 0.5: there, not loud (a modest volume)

// The level events of tape signal (js/media/tape.js: halves = entry lengths in ticks, levels = 0/1) from entry
// position (i, left) on, `ticks` long, starting at cycle `at` -> [cycle, level, ...]
function walk(tape, i, left, ticks, at, out = []) {
  const d = tape.halves, lv = tape.levels;
  let t = at, rest = ticks;
  while (rest > 0 && i < d.length) {
    const take = Math.min(left, rest);
    if (take > 0) out.push(t, lv[i] ? 1 : -1);
    t += take; rest -= take; left -= take;
    if (left <= 0) { i++; left = d[i] || 0; }
  }
  return out;
}
// ticks from position (i, left) to (j, jleft), j at or after i, counted up to `limit` (past it: Infinity); -1 if
// (j, jleft) is before (i, left)
function between(tape, i, left, j, jleft, limit) {
  if (j < i || (j === i && jleft > left)) return -1;
  if (j === i) return left - jleft;
  let n = left;
  for (let k = i + 1; k < j; k++) { n += tape.halves[k]; if (n > limit) return Infinity; }
  return n + (tape.halves[j] || 0) - jleft;
}

class TapeListener {
  constructor() { this.tape = null; this.idx = 0; this.left = 0; this.motor = false; }
  // remember where the tape is now (a new tape, a seek, a snapshot: carry on from here)
  mark(deck) {
    const t = deck.tape;
    this.tape = t; this.motor = deck.motor;
    if (t) { this.idx = t.idx; this.left = t.left; }
  }
  frame(deck, frameCycles) {
    const t = deck.tape, was = this.tape, i = this.idx, left = this.left, motorBefore = this.motor;
    this.mark(deck);
    if (!t || t !== was) return null;
    const ticks = between(t, i, left, t.idx, t.left, frameCycles);
    // not moving, or moved backwards (a rewind) or further than a frame (a seek, a skip): nothing to hear
    if (ticks <= 0 || ticks > frameCycles) return null;
    // a motor that came on during the frame: the tape moved at its end; one that went off: at its start
    const at = !motorBefore && deck.motor ? frameCycles - ticks : 0;
    return walk(t, i, left, ticks, at);
  }
  slice(deck, cycles) {
    const t = deck.tape;
    this.mark(deck);
    if (!t || !deck.playing) return null;
    return walk(t, t.idx, t.left, Math.round(cycles), 0);
  }
}

// events [cycle, level, ...] over `cycles` -> the level averaged over each of n sample windows (a box filter: a
// signal faster than the sample rate comes out as its average instead of aliasing), into out[0..n)
function boxAverage(events, cycles, n, out) {
  let ei = 0, level = events.length ? events[1] : 0;
  const step = cycles / n;
  for (let i = 0; i < n; i++) {
    const t0 = i * step, t1 = t0 + step;
    let acc = 0, t = t0;
    while (ei + 2 < events.length && events[ei + 2] < t1) {
      const c = Math.max(events[ei + 2], t0);
      acc += level * (c - t); t = c;
      ei += 2; level = events[ei + 1];
    }
    acc += level * (t1 - t);
    out[i] = acc / step;
  }
  return out;
}

class TapeVoice {
  constructor(rate) {
    this.rate = rate;
    this.a = 1 - Math.exp(-2 * Math.PI * LOWPASS_HZ / rate);
    this.held = 0;                 // the input level held when the tape doesn't move
    this.lp1 = 0; this.lp2 = 0;    // the low-pass stages
    this.prevIn = 0; this.prevOut = 0;   // the DC-blocking high-pass
    this.rms = 0;                  // of the last block rendered (the page's tests read it)
  }
  // events over `cycles` (null: the tape did not move, its last level held) -> n samples added to out, times volume
  mix(events, cycles, n, out, volume) {
    // nothing moving and the filters settled on the held level: silence, without running them
    if (!(events && events.length) && Math.abs(this.prevOut) < 1e-9 && Math.abs(this.lp1 - this.held) < 1e-9 && Math.abs(this.lp2 - this.held) < 1e-9) {
      this.lp1 = this.lp2 = this.prevIn = this.held; this.prevOut = 0; this.rms = 0;
      return;
    }
    const x = events && events.length ? boxAverage(events, cycles, n, new Float64Array(n)) : null;
    if (events && events.length) this.held = events[events.length - 1];
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = x ? x[i] : this.held;
      this.lp1 += this.a * (v - this.lp1);
      this.lp2 += this.a * (this.lp1 - this.lp2);
      const y = this.lp2 - this.prevIn + 0.995 * this.prevOut;
      this.prevIn = this.lp2; this.prevOut = y;
      sq += y * y;
      out[i] += y * volume;
    }
    this.rms = n ? Math.sqrt(sq / n) : 0;
  }
}

export { TapeListener, TapeVoice, boxAverage, LOWPASS_HZ, DEFAULT_VOLUME };
