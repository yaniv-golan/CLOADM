/*
 * Host key presses for the emulated keyboard matrix, in order and none lost.
 *
 * The host reports key changes at any moment, often several between two emulated frames when someone types
 * fast: a key pressed and released between two of the machine's keyboard scans would never be seen, and two
 * keys pressed in the same gap would reach the matrix together, in no order. So changes are queued and applied
 * at frame starts (step, called by the Session before each frame):
 *   - at most one new press a frame, in the order pressed;
 *   - a key stays down for at least `hold` frames, so the machine's scan (and BASIC's debounce) sees it;
 *   - a key pressed again is pressed only after it has been up for `gap` frames, so a double letter is two;
 *   - a press never overtakes an earlier change: keys overlap in the matrix only if they overlapped on the host
 *     (SHIFT is up before the next letter, a letter released before the next is pressed stays released);
 *     a release waits only for that key's own earlier changes, except a modifier's (SHIFT, CTRL, ALT): it waits
 *     until every earlier press has been down for `hold` frames, because those keys were pressed with it held
 *     (Shift held across "*+" and let go for the next ":" must not leave the "+" unshifted when the queue is
 *     behind the host).
 * The no-ROM stub reads key codes from its own queue (Machine.stubKeys), not the matrix.
 * Not in snapshots: queued keys are host-side input, not machine state.
 */
const MODIFIERS = new Set(['SHIFT', 'CTRL', 'ALT']);

export class KeyQueue {
  constructor({ hold = 3, gap = 2 } = {}) {
    this.hold = hold;
    this.gap = gap;
    this.want = new Set();     // keys the host holds now
    this.events = [];          // [name, down] not applied yet, in order
    this.down = new Map();     // key -> frame it went down in the matrix
    this.up = new Map();       // key -> frame it went up
    this.frame = 0;
    this.lastPress = -Infinity;   // the frame the latest press went into the matrix
  }
  // the host now holds exactly these keys (matrix names, SHIFT included)
  // (when several change at once: other keys go up before modifiers, and modifiers go down before other keys)
  set(names) {
    const next = new Set(names), mod = (k) => MODIFIERS.has(k);
    const ups = [...this.want].filter((k) => !next.has(k)), downs = [...next].filter((k) => !this.want.has(k));
    for (const k of [...ups.filter((k) => !mod(k)), ...ups.filter(mod)]) this.events.push([k, false]);
    for (const k of [...downs.filter(mod), ...downs.filter((k) => !mod(k))]) this.events.push([k, true]);
    this.want = next;
  }
  get pending() { return this.events.length; }
  // apply the changes that are due to machine m (setKey) at the start of a frame
  step(m) {
    this.frame++;
    const keep = [], blocked = new Set();
    let pressed = false, pressBlocked = false;
    for (const e of this.events) {
      const [k, down] = e;
      let ok;
      if (down) ok = !pressBlocked && !pressed && !blocked.has(k) && !this.down.has(k) && !(this.frame - (this.up.get(k) ?? -Infinity) < this.gap);
      else {
        ok = !blocked.has(k) && this.down.has(k) && this.frame - this.down.get(k) >= this.hold
          && (!MODIFIERS.has(k) || (!pressBlocked && !pressed && this.frame - this.lastPress >= this.hold));
      }
      if (ok) {
        m.setKey(k, down);
        if (down) { this.down.set(k, this.frame); this.lastPress = this.frame; pressed = true; } else { this.down.delete(k); this.up.set(k, this.frame); }
      } else if (down || this.down.has(k) || blocked.has(k)) {
        keep.push(e);
        blocked.add(k);
        pressBlocked = true;     // later presses keep their place behind it
      }
    }
    this.events = keep;
  }
  // forget everything (machine reset or switch): the matrix is cleared by the machine
  clear() { this.want.clear(); this.events = []; this.down.clear(); this.up.clear(); this.lastPress = -Infinity; }
}
