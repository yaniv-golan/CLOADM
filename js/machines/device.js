/*
 * Device: the base class for anything plugged into a machine (a cartridge, an input module, a controller).
 * The interface and the bus it plugs into are described in js/machines/bus.js; this file holds only the base
 * class, so a device can subclass it without importing the registry that lists it.
 */
class Device {
  constructor(type) { this.type = type; this.id = type; this.host = null; }
  attach(host) { this.host = host; }
  // taken out of the machine (ejected, or replaced): let go of the host. A device that holds lines, timers or
  // media drops its lines, cancels its events and commits its media first, then calls this.
  detach() { this.host = null; }
  reset() { }
  rom() { return null; }
  readIO() { return undefined; }
  writeIO() { }
  twiddleQ() { }
  syncAudio() { }
  get cartLineFollowsQ() { return false; }
  saveState() { return {}; }
}

export { Device };
