/*
 * CoCo Max Hi-Res input module (cartridge; MAME 0.264 src/devices/bus/coco/coco_max.cpp, coco_pak_max_device).
 *
 * The module holds one value; a read returns it and stages the next one, cycling through four registers:
 *   $FF90 read -> the Y position, then stages Y
 *   $FF91 read -> the X position, then stages X
 *   $FF92 read -> the left button (0 when pressed, $FF released), then stages the right button
 *   $FF93 read -> the right button, then stages ... (registers $FF94-$FF97: nothing connected, the staged
 *                 value stays what the last real register staged)
 * The positions are the mouse's in 0..255 (x to the right, y down); MAME's cocomax_x / cocomax_y input
 * ports with PORT_MINMAX(0, 255), read back by ff90_read.
 *
 * Because the read returns what the previous read left, the first read after any reset returns 0: the module
 * does not sample the mouse until its second read of the register.
 *
 * The mouse is the machine's (host.mouse, { x, y (0..1), left, right }, set by the host's input, js/host/input.js),
 * read after attach; with none set the module sees it centred with both buttons up. So the module is rebuilt
 * from a snapshot like any device, with fromState(s) alone.
 */
// Device comes from the machine layer; importing bus.js here would close a cycle (bus registers this class)
import { Device } from './device.js';

const CENTRED = Object.freeze({ x: 0.5, y: 0.5, left: false, right: false });

class CocoMax extends Device {
  constructor() {
    super('cocomax');
    this.staged = 0;
  }
  sample() { return (this.host && this.host.mouse) || CENTRED; }
  // positions as the module presents them: 0..255, x to the right and y downwards
  axis(v) { return Math.max(0, Math.min(255, Math.round((v || 0) * 255))); }
  readIO(a) {
    if (a < 0xFF90 || a > 0xFF97) return undefined;
    const out = this.staged;
    const m = this.sample();
    switch (a & 7) {
      case 0: this.staged = this.axis(m.y); break;
      case 1: this.staged = this.axis(m.x); break;
      case 2: this.staged = m.left ? 0x00 : 0xFF; break;
      case 3: this.staged = m.right ? 0x00 : 0xFF; break;
      default: break;          // $FF94-$FF97: nothing connected, the staged value stays
    }
    return out;
  }
  saveState() { return { staged: this.staged }; }
  static fromState(s) { const d = new CocoMax(); d.staged = s.staged; return d; }
}

export { CocoMax };
