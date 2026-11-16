/*
 * Host input state, DOM-free: what the page has told us (keys held, a gamepad frame, the mouse) held the
 * way the emulated machine sees it. js/ui/screen.js turns browser events into these calls; everything here
 * runs in Node, so tests/input.test.js drives the mapping without a browser.
 *
 * Keyboard modes:
 *   translated  the character typed reaches the machine: Shift+2 is " on every machine, and a lower-case
 *               letter goes in as its capital because the machines have capitals only
 *   positional  the physical key's position decides: one map per layout (js/machines/keyboards.js
 *               positionalKeys), so an AZERTY user's Q types the machine's A, the key their fingers mean
 * A key is held as a machine key plus SHIFT where the character needs it, which is what the matrix has. A
 * release removes exactly what its press added, so chords and rollover work.
 *
 * The keyboard joystick (joyKeys) gives one joystick to the keys: W/A/S/D the left one, the numeric pad the
 * right one, F or the numpad 0 the button. Keys the joystick owns do not type.
 *
 * A gamepad arrives from js/host/gamepad.js as { axes: [x, y] in -1..1, buttons: [bool, ...] }; the dead
 * zone and the button map live here. The mouse arrives as an absolute position (0..1 across the picture) or
 * as relative motion, whichever the device in the machine reads.
 */
import { charToKeys, positionalKeys } from '../machines/keyboards.js';

// KeyboardEvent.key names that are a key of their own rather than a character
const SPECIAL = {
  Enter: 'ENTER', Backspace: 'LEFT', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
  Escape: 'BREAK', Home: 'CLEAR', Delete: 'CLEAR',
  Alt: 'ALT', Control: 'CTRL', F1: 'F1', F2: 'F2',   // CoCo 3 only; the other matrices have no such cells
};
// ASCII codes for the no-ROM stub's POLCAT, which reads a byte rather than the matrix
const STUB_CODES = { Enter: 13, Backspace: 8, ArrowLeft: 8, ArrowRight: 9, ArrowUp: 94, ArrowDown: 10, Escape: 3, Home: 12 };
const isModifier = (key) => key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';

// a stick position in -1..1 -> the machines' 0..63 axis (one end is 0, the other 63; centre is 32)
export const axisValue = (v) => Math.round((Math.max(-1, Math.min(1, v)) + 1) / 2 * 63);
export const DEAD_ZONE = 0.25;
export const BUTTON_MAP = [0, 2];   // joystick 0's button is the pad's first button, joystick 1's the third

// The keyboard joystick's key sets, by KeyboardEvent.code. The arrows are the right joystick only while the
// keyboard joystick is on (otherwise they are the machine's arrow keys).
const LETTER_KEYS = { KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, -1], KeyS: [0, 1] };
const PAD_KEYS = { Numpad4: [-1, 0], Numpad6: [1, 0], Numpad8: [0, -1], Numpad2: [0, 1] };
const ARROW_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const BUTTON_LEFT = new Set(['KeyF', 'Space']);      // the left joystick's button
const BUTTON_RIGHT = new Set(['Numpad0', 'NumpadEnter']);   // the right one's

class HostInput {
  // machine: the one in use; keys: its KeyQueue (js/machines/keyqueue.js), which applies the held set at frame
  // starts so a fast typist's keys are not lost between two keyboard scans
  constructor(machine, keys) {
    this.m = machine;
    this.keys = keys;
    this.mode = 'translated';
    this.joyKeys = false;
    this.heldKeys = new Map();              // event.code -> the machine keys its press added
    this.hostShift = false;
    this.keyJoy = [new Set(), new Set()];   // per joystick: the keys held
    this.pads = [null, null];               // per joystick: the last gamepad frame
    this.mouse = { x: 0.5, y: 0.5, left: false, right: false };
    this.mouseDx = 0; this.mouseDy = 0;
    if (machine) machine.mouse = this.mouse;
  }
  // the machine in use changed: its matrix is new, so nothing is held on it (keys, keyboard joystick, pads start
  // over); the mouse is handed to it
  setMachine(machine) { this.m = machine; if (machine) machine.mouse = this.mouse; this.heldKeys.clear(); this.keyJoy = [new Set(), new Set()]; this.pads = [null, null]; this.hostShift = false; }
  // a key map the machine does not have leaves setKey a no-op, so an ALT on a CoCo 1/2 types nothing
  get layout() { return positionalKeys[this.m.profile.keyboard] || {}; }

  // ---------------- keyboard ----------------
  // a browser keydown: { key, code, shiftKey, repeat }; true when the machine took the key
  keydown(e) {
    if (e.key === 'Shift') { this.hostShift = true; this.setMatrix(e.code, ['SHIFT']); return true; }
    if (this.joyKeys && this.joyKey(e, true)) return true;
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return this.modifier(e, true);
    if (e.ctrlKey || e.metaKey || e.altKey) return false;   // a browser shortcut, not ours to take
    const keys = this.machineKeys(e);
    if (!keys) return false;
    if (this.m.useStub && !e.repeat) this.pushStub(e);
    this.setMatrix(e.code, keys);
    return true;
  }
  keyup(e) {
    if (e.key === 'Shift') { this.hostShift = false; this.clearMatrix(e.code); return true; }
    if (this.joyKeys) this.joyKey(e, false);
    this.clearMatrix(e.code);
    return true;
  }
  // the machine keys one event types, SHIFT first when the character needs it
  machineKeys(e) {
    if (this.mode === 'positional') {
      const name = this.layout[e.code];
      return name ? [name] : null;
    }
    if (SPECIAL[e.key]) return [SPECIAL[e.key]];
    if (e.key.length !== 1) return null;
    const k = charToKeys(e.key);
    return k ? (k.shift ? ['SHIFT', k.key] : [k.key]) : null;
  }
  modifier(e, down) {
    if (this.mode === 'positional') {
      const name = this.layout[e.code];
      if (!name) return false;
      if (down) this.setMatrix(e.code, [name]); else this.clearMatrix(e.code);
      return true;
    }
    const name = SPECIAL[e.key];
    if (!name) return false;
    if (down) this.setMatrix(e.code, [name]); else this.clearMatrix(e.code);
    return true;
  }
  pushStub(e) {
    // the stub hands programs upper case, as BASIC's keyboard does, unless the program draws lower case itself
    // (the chat firmware: machine.stubKeepCase)
    const ch = e.key.length === 1 ? (this.m.stubKeepCase ? e.key : e.key.toUpperCase()) : '';
    const code = STUB_CODES[e.key] || (ch ? ch.charCodeAt(0) & 0x7F : 0);
    if (code) this.m.stubKeys.push(code);
  }
  // an on-screen key (js/ui/touch-keys.js) pressed or let go: machine key names (SHIFT first when it is held) and
  // the character code the no-ROM stub reads; independent of the keyboard mode, since there is no key position
  touch(id, keys, stubCode, down) {
    if (!down) { this.clearMatrix(`touch:${id}`); return; }
    if (this.m.useStub && stubCode) this.m.stubKeys.push(stubCode);
    this.setMatrix(`touch:${id}`, keys);
  }
  setMatrix(code, keys) { this.heldKeys.set(code, keys); this.publish(); }
  clearMatrix(code) { this.heldKeys.delete(code); this.publish(); }
  // hand the set of keys held now to the KeyQueue; it applies them at the next frame start, in order, so a
  // key pressed and released between two scans is not lost (js/machines/keyqueue.js)
  publish() {
    const held = new Set();
    for (const keys of this.heldKeys.values()) for (const k of keys) if (k !== 'SHIFT') held.add(k);
    if (this.hostShift || [...this.heldKeys.values()].some((keys) => keys.includes('SHIFT'))) held.add('SHIFT');
    this.keys.set(held);
  }
  releaseAll() {
    this.heldKeys.clear();
    this.hostShift = false;
    this.keyJoy = [new Set(), new Set()];
    this.keys.set(new Set());
  }

  // ---------------- keyboard joystick ----------------
  // true when the key belongs to the joystick, so it does not type
  joyKey(e, down) {
    const dir = PAD_KEYS[e.code] || ARROW_KEYS[e.code] || LETTER_KEYS[e.code];
    if (dir) {
      const joy = LETTER_KEYS[e.code] ? 1 : 0;
      const set = this.keyJoy[joy];
      if (down) set.add(e.code); else set.delete(e.code);
      const table = joy === 1 ? LETTER_KEYS : { ...PAD_KEYS, ...ARROW_KEYS };
      let x = 0, y = 0;
      for (const c of set) { const d = table[c]; if (d) { x += d[0]; y += d[1]; } }
      this.m.joy[joy][0] = axisValue(Math.sign(x));
      this.m.joy[joy][1] = axisValue(Math.sign(y));
      return true;
    }
    if (BUTTON_LEFT.has(e.code)) { this.m.fire[1] = down; return true; }
    if (BUTTON_RIGHT.has(e.code)) { this.m.fire[0] = down; return true; }
    return false;
  }

  // ---------------- gamepad ----------------
  // one gamepad frame from js/host/gamepad.js: two sticks in -1..1 and buttons as booleans
  setGamepad(joy, frame) {
    this.pads[joy] = frame;
    const [x, y] = frame.axes || [0, 0];
    this.m.joy[joy][0] = Math.abs(x) < DEAD_ZONE ? 32 : axisValue(x);
    this.m.joy[joy][1] = Math.abs(y) < DEAD_ZONE ? 32 : axisValue(y);
    this.m.fire[joy] = !!(frame.buttons && frame.buttons[BUTTON_MAP[joy]]);
  }
  clearGamepad(joy) {
    this.pads[joy] = null;
    this.m.joy[joy][0] = 32; this.m.joy[joy][1] = 32;
    this.m.fire[joy] = false;
  }

  // ---------------- mouse ----------------
  // an absolute position, 0..1 across the picture; Y grows downwards
  // it is also the machine's (machine.mouse), which a device or interface that reads the mouse's position
  // samples (js/machines/cocomax.js, the CoCo 3's Rat in js/machines/cocopia.js)
  setMouse(state) { this.mouse = Object.assign({ x: 0.5, y: 0.5, left: false, right: false }, state); if (this.m) this.m.mouse = this.mouse; }
  // relative motion, for a device that counts movement instead of position
  moveMouse(dx, dy) { this.mouseDx += dx; this.mouseDy += dy; }
  takeMouseMotion() { const d = [this.mouseDx, this.mouseDy]; this.mouseDx = this.mouseDy = 0; return d; }
}

export { HostInput, SPECIAL };
