/*
 * Typist: types text into a machine through its keyboard matrix, one key per few frames, as a
 * person would (works with any ROM). A queued tape wait pauses typing until a cassette load has
 * finished (the motor ran and has stayed off for a second).
 */
import { charToKeys } from './keyboards.js';

class Typist {
  constructor(machine) {
    this.m = machine;
    this.queue = [];
    this.state = null;      // key held down / released, with frames left in that phase
  }
  type(text) { for (const ch of text) this.queue.push(ch); }
  waitTape() { this.queue.push({ waitTape: true }); }
  // press a key that is not a character (BREAK): queued like typing, so it goes down and comes back up
  // across frames exactly as a typed key does. A key set down and up inside one call is invisible - the CPU
  // reads the PIA, it is not sampled by the machine - so the press has to span frames to be seen at all.
  press(key) { this.queue.push({ press: key }); }
  get busy() { return this.queue.length > 0 || this.state !== null; }
  clear() { this.queue = []; this.state = null; }
  // once per frame
  step() {
    const m = this.m, st = this.state;
    if (st) {
      if (--st.frames > 0) return;
      if (st.down) {
        for (const k of st.keys) m.setKey(k, false);
        this.state = { down: false, frames: 2, keys: [] };
        return;
      }
      this.state = null;
    }
    if (!this.queue.length) return;
    const item = this.queue[0];
    if (typeof item === 'object' && item.press) {
      this.queue.shift();
      m.setKey(item.press, true);
      this.state = { down: true, frames: 3, keys: [item.press] };
      return;
    }
    if (typeof item === 'object') {
      const deck = m.deck;
      if (deck.motor) { item.started = true; item.settle = 0; }
      else if (item.started || !deck.tape || deck.tape.atEnd()) {
        item.settle = (item.settle || 0) + 1;
        if (item.settle > 50) this.queue.shift();
      }
      return;
    }
    this.queue.shift();
    const map = charToKeys(item);
    if (!map) return;
    const keys = map.shift ? ['SHIFT', map.key] : [map.key];
    for (const k of keys) m.setKey(k, true);
    this.state = { down: true, frames: 3, keys };
  }
}

export { Typist };
