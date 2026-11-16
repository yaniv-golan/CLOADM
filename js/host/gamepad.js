/*
 * Gamepads: a small wrapper over navigator.getGamepads, so the rest of the page never touches the browser's
 * gamepad API and the mapping can be tested with a fake (tests/browser-check.js installs one).
 *
 * A pad is read as the two sticks and its buttons: axes 0 and 1 are the left stick, axes 2 and 3 the right
 * one (the W3C "standard" layout; a non-standard pad whose axes differ is not guessed at), and buttons are
 * booleans. The dead zone and which stick drives which joystick are js/host/input.js's business.
 */
// A browser's Gamepad.axes is -1..1 with Y down, which is also the emulated machines' sense (0 is up, 63
// down), so the axes pass through unchanged. Buttons are { pressed, value }: a trigger's analogue value
// counts as pressed past half.
const frameOf = (pad) => {
  const a = pad.axes || [];
  const buttons = (pad.buttons || []).map((b) => (typeof b === 'object' ? (b.pressed || b.value > 0.5) : !!b));
  return { id: pad.id || '', axes: [a[0] || 0, a[1] || 0], buttons };
};

class Gamepads {
  constructor(navigatorLike = typeof navigator === 'undefined' ? null : navigator) {
    this.port = navigatorLike;
  }
  // the pads connected now, as [frame, frame]: index 0 drives the right joystick, 1 the left (as the
  // machines number them: the "right" controller is joystick 0). Missing or empty slots read as null.
  read() {
    const list = (this.port && this.port.getGamepads && this.port.getGamepads()) || [];
    const pads = [];
    for (const pad of list) if (pad && pad.connected !== false) pads.push(frameOf(pad));
    return { right: pads[0] || null, left: pads[1] || null };
  }
}

export { Gamepads, frameOf };
