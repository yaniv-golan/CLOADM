/*
 * Expansion bus: devices plugged into a machine, and the interrupt hub they drive.
 *
 * Device interface (base class Device):
 *   attach(host)        the host is the machine (or a Multi-Pak slot standing in for it): now(), ioTime(),
 *                       schedule(at, name, arg, pri), cancel(e), on(name, fn), off(name) (the handler and its
 *                       queued events), tickHz, clockUnits(), unitAttos and tickAt(u) (exact time,
 *                       js/chips/attoclock.js), config, lineDelays and slotHz (the slot's clock, which its line
 *                       delays count), setLine(source, line, level) (irq, firq, nmi, halt, cart),
 *                       cartridgeChanged() and cartSound(source, level)
 *   detach()            taken out (ejected or replaced, a Multi-Pak's slots with it): drop the lines it asserts,
 *                       host.off() its events, its sound to 0, commit its media; then it has no host
 *   id                  the device's name in its host: its event names and line source (a Multi-Pak prefixes it)
 *   reset(hard)         the machine's reset line (hard: power-on; the machine's event queue was emptied)
 *   rom()               Uint8Array for the cartridge ROM space $C000-$FEFF (current bank), or null
 *   readIO(a)           cartridge I/O: SCS ($FF40-$FF5F) and the cartridge space ($FF60-$FFBF), where MAME's
 *   writeIO(a, v)       cartridges install handlers (cartridge_space(): Orchestra-90 $FF7A-$FF7B, Multi-Pak
 *                       $FF7F, CoCo Max $FF90-$FF97); readIO gives a value, or undefined where the cartridge does
 *                       not drive the bus; writeIO returns true when it has a handler at that address
 *   twiddleQ()          MAME's twiddle_q_lines(), called on every PIA1 write under config.mameCompat
 *   cartLineFollowsQ    true when the cartridge ties CART to Q (autostart via PIA1 CB1 / GIME EI0)
 *   syncAudio()         bring the cartridge's sound output up to now (before the machine closes a frame)
 *   saveState(); a device is recreated from a snapshot by its class's static fromState(s), found in devices[type]
 * A banked cartridge calls host.cartridgeChanged() after switching banks so the machine remaps.
 *
 * CartSlot: a cartridge slot's CART, NMI and HALT lines, as MAME 0.264's cococart_slot_device drives them
 * (src/devices/bus/coco/cococart.cpp): set_line_value() arms the line's next timer from a pool of two
 * (TIMER_POOL), set_line_timer() after the slot's delay (coco.cpp machine_start: NMI 12, HALT 6 CPU cycles on the
 * machine's slot; 0 in a Multi-Pak's slots), and set_line() passes the value on when the timer runs. A line can
 * be clear, asserted or 'q' (tied to the CPU's Q clock): MAME approximates Q by toggling the line five times,
 * each through the timer pool, when it is set to Q and whenever twiddle_q_lines() is called (on PIA1 writes,
 * coco.cpp ff20_write). A change still waiting is lost when two newer ones follow it within the delay.
 */
import { AttoClock } from '../chips/attoclock.js';
import { NEVER, hzToAttos } from '../chips/attotime.js';
import { MOS6551 } from '../chips/mos6551.js';
import { SerialPort } from './rs232.js';
import { Device } from './device.js';
import { CocoMax } from './cocomax.js';
import { registry } from '../util.js';

// Interrupt hub: each source drives one CPU line (irq, firq, nmi, halt); a line is asserted while any
// of its sources is. NMI is edge-triggered on the CPU, so a rising NMI level calls cpu.nmi().
class InterruptHub {
  constructor(cpu) {
    this.cpu = cpu;
    this.levels = new Map();   // source + line -> { line, level } (a source may drive several lines)
  }
  set(source, line, level) {
    const key = `${source}/${line}`;
    const prev = this.levels.get(key);
    if (prev && prev.level === level) return;
    const was = this.asserted(line);
    this.levels.set(key, { line, level });
    const any = this.asserted(line);
    const cpu = this.cpu;
    if (line === 'irq') cpu.irqLine = any;
    else if (line === 'firq') cpu.firqLine = any;
    else if (line === 'halt') cpu.haltLine = any;
    else if (line === 'nmi' && any && !was) cpu.nmi();   // NMI is one wired line: its rising edge
  }
  // what one source drives on a line
  level(source, line) { const s = this.levels.get(`${source}/${line}`); return !!(s && s.level); }
  asserted(line) {
    for (const s of this.levels.values()) if (s.line === line && s.level) return true;
    return false;
  }
  // each source's level per line (the CPU's lines themselves are the CPU's state)
  saveState() { return [...this.levels].map(([key, s]) => [key, s.line, s.level]); }
  loadState(s) { this.levels = new Map(s.map(([key, line, level]) => [key, { line, level }])); }
}

const SLOT_LINES = ['cart', 'nmi', 'halt'];
const VALUES = ['clear', 'assert', 'q'];

class CartSlot {
  // clock: the owning machine's AttoClock; emit(line, level) passes a line on (every set_line, changed or not)
  constructor(clock, emit) {
    this.clock = clock;
    this.emit = emit;
    this.delays = { cart: 0, nmi: 0, halt: 0 };
    this.host = null;
    this.st = {};
    for (const l of SLOT_LINES) {
      this.st[l] = { value: 'clear', level: 0, qCount: 0, index: 0 };
      for (const i of [0, 1]) clock.timer(`line.${l}.${i}`, (p) => this.setLine(l, VALUES[p]));
    }
  }
  attach(host) {
    this.host = host;
    this.delays = Object.assign({ cart: 0, nmi: 0, halt: 0 }, host.lineDelays);
  }
  // power-on: every line clear, nothing waiting (the machine's event queue was emptied)
  clear() {
    for (const l of SLOT_LINES) {
      Object.assign(this.st[l], { value: 'clear', level: 0, qCount: 0, index: 0 });
      for (const i of [0, 1]) this.clock.timers.get(`line.${l}.${i}`).expire = NEVER;
    }
  }
  value(line) { return this.st[line].value; }
  level(line) { return this.st[line].level; }
  // set_line_value: value is 'clear', 'assert', 'q' or a boolean
  set(line, value) {
    if (value === true) value = 'assert'; else if (value === false) value = 'clear';
    this.timer(line, value);
  }
  // set_line_timer
  timer(line, value) {
    const s = this.st[line], d = this.delays[line];
    const delay = d && this.host ? BigInt(d) * hzToAttos(Math.floor(this.host.slotHz)) : 0n;
    this.clock.timers.get(`line.${line}.${s.index}`).adjust(delay, VALUES.indexOf(value));
    s.index = (s.index + 1) & 1;
  }
  // set_line
  setLine(line, value) {
    const s = this.st[line];
    if (s.value === value && value !== 'q') return;
    s.value = value;
    if (value === 'clear') { s.level = 0; s.qCount = 0; }
    else if (value === 'assert') { s.level = 1; s.qCount = 0; }
    else { s.level ^= 1; if (s.qCount++ < 4) this.timer(line, 'q'); }
    this.emit(line, !!s.level);
  }
  // twiddle_q_lines
  twiddleQ() {
    for (const l of SLOT_LINES) if (this.st[l].value === 'q') { this.st[l].qCount = 0; this.timer(l, 'q'); }
  }
  saveState() { const o = {}; for (const l of SLOT_LINES) o[l] = { ...this.st[l] }; return o; }
  loadState(s) { for (const l of SLOT_LINES) Object.assign(this.st[l], s[l]); }
}

// A cartridge with its own slot lines (CartSlot) and exact-time clock; subclasses use this.lines.
class SlotDevice extends Device {
  constructor(type) {
    super(type);
    this.clock = new AttoClock();
    this.lines = new CartSlot(this.clock, (l, v) => { if (this.host) this.host.setLine(this.id, l, v); });
  }
  attach(host) {
    super.attach(host);
    this.lines.attach(host);
    this.clock.attach(host, `${this.id}.timer`);
  }
  reset(hard) {
    if (hard) {
      for (const t of this.clock.timers.values()) t.expire = NEVER;
      this.clock.pending = null;
      this.lines.clear();
      if (this.host && this.slotLines !== false) for (const l of SLOT_LINES) this.host.setLine(this.id, l, false);
    }
  }
  // taken out: the lines it asserts are dropped (and nothing waits in its slot's timers), its sound goes to 0, its
  // clock's event and handler go
  detach() {
    if (this.host) {
      const asserted = SLOT_LINES.filter((l) => this.lines.level(l));
      this.lines.clear();
      if (this.slotLines !== false) for (const l of asserted) this.host.setLine(this.id, l, false);
      this.host.cartSound(this.host.tickAt(0), 0);
    }
    this.clock.detach();
    super.detach();
  }
  twiddleQ() { this.lines.twiddleQ(); }
  get cartLineFollowsQ() { return this.lines.value('cart') === 'q'; }
  saveState() { return { lines: this.lines.saveState(), clock: this.clock.saveState() }; }
  loadState(s) { this.lines.loadState(s.lines); this.clock.loadState(s.clock); }
}

// Plain ROM cartridge (Program Pak, MAME coco_pak.cpp 'cocopak'): its ROM fills a 32K region, repeated when
// shorter (cococart_slot_device::call_load); $C000-$FEFF reads the region's first 16K. CART is tied to Q at
// reset when auto-start is on (device_reset: the "Cart Auto-Start" setting).
class RomCartridge extends SlotDevice {
  constructor(bytes, { autostart = true } = {}) {
    super('rom');
    this.bytes = bytes;
    this.autostart = autostart;
    this.window = fillRegion(bytes, 0x8000);
  }
  get name() { return 'Program Pak'; }
  rom() { return this.window; }
  reset(hard) {
    super.reset(hard);
    this.lines.set('cart', this.autostart ? 'q' : 'clear');
  }
  saveState() { return Object.assign(super.saveState(), { bytes: this.bytes.slice(), autostart: this.autostart }); }
  static fromState(s) { const d = new RomCartridge(s.bytes.slice(), { autostart: s.autostart }); d.loadState(s); return d; }
}

// cococart_slot_device::call_load: the image fills the region, repeated from its start until full
function fillRegion(bytes, size) {
  const r = new Uint8Array(size);
  let n = Math.min(bytes.length, size);
  r.set(bytes.subarray(0, n));
  if (!n) return r;
  while (n < size) { const len = Math.min(n, size - n); r.copyWithin(n, 0, len); n += len; }
  return r;
}

// The Dragon 64's serial port: a 6551 ACIA (js/chips/mos6551.js) with its baud rate clock kept in exact time
// (js/chips/attoclock.js) as MAME's clock device keeps it (src/devices/machine/clock.cpp): when the rate changes,
// an init timer runs at once (attotime::zero) and sets the clock's period, 1/rate in whole attoseconds with the
// rate in whole Hz; the next edge comes half a period later unless the running clock's own next edge is sooner;
// edges alternate every half period, and a stopped clock keeps its level. Its IRQ drives the CPU's IRQ (MAME
// dragon.cpp: acia irq -> input merger -> maincpu irq). The device on the RS-232 port (none, loopback, terminal:
// js/machines/rs232.js) gives RXD and receives TXD; with nothing plugged in, CTS, DSR and DCD read asserted, as
// in MAME. The chip's DTR and RTS outputs are not wired to the port (as in MAME's dragon64).
class Acia6551 extends Device {
  constructor() {
    super('acia6551');
    this.chip = new MOS6551();
    this.port = new SerialPort(1, () => {});
    this.port.attach('none');
    this.signal = 0;           // the clock's level
    this.half = 0n;            // half a clock period in attoseconds (0: stopped)
    this.time = 0;             // the tick of the change the chip is reacting to (for the serial line)
    this.clock = new AttoClock();
    this.tInit = this.clock.timer('init', () => this.clockInit());
    this.tEdge = this.clock.timer('edge', () => this.clockTick());
  }
  attach(host) {
    super.attach(host);
    this.port.tickHz = host.tickHz;
    const c = this.chip;
    c.onIrq = (a) => host.setLine('acia', 'irq', a);
    c.onTxd = (level) => this.port.txd(this.time, level);
    c.onClock = () => this.tInit.adjust(0n);
    this.clock.attach(host, 'acia.timer');
    c.start();
  }
  // clock_device timer_init: the period from the chip's rate; the next edge half a period on, unless sooner
  clockInit() {
    const hz = this.chip.clockHz;
    if (!hz) { this.half = 0n; this.tEdge.adjust(NEVER); return; }
    this.half = hzToAttos(hz) / 2n;
    if (!this.tEdge.enabled() || this.tEdge.expire - this.clock.now() > this.half) this.tEdge.adjust(this.half);
  }
  // timer_tick: the level flips; the next edge half a period on
  clockTick() {
    this.signal ^= 1;
    if (this.half) this.tEdge.adjust(this.half);
    this.time = this.clock.tick;
    this.chip.setRxd(this.port.rxd(this.time));
    this.chip.clockEdge(this.signal);
  }
  // plug a device into the serial port ('none', 'loopback', 'terminal' with { baud })
  attachSerial(kind, opts) {
    this.port.attach(kind, opts);
    this.lines();
  }
  // CTS, DSR and DCD from the device: asserted (0) with nothing plugged in or a terminal (MAME's port with no
  // device, its null modem); a loopback plug's follow RTS and DTR, which the Dragon 64 does not wire out (as in
  // MAME), so they are not asserted unless the plug holds them asserted
  lines() { const p = this.port; this.chip.setCts(p.cts); this.chip.setDsr(p.dsr); this.chip.setDcd(p.dcd); }
  // power-on clears the time line (and the clock with it: MAME's clock device starts stopped, at level 0);
  // any reset resets the chip, which stops the clock at the rate of control register 0
  reset(hard) {
    if (hard) {
      for (const t of this.clock.timers.values()) t.expire = NEVER;
      this.clock.pending = null;
      this.signal = 0; this.half = 0n;
    }
    this.time = this.host.now();
    this.lines();
    this.chip.reset();
  }
  // (time-dependent accesses: the machine has run its events up to the access first)
  readIO(reg, at) { this.time = at; this.chip.setRxd(this.port.rxd(at)); return this.chip.read(reg); }
  writeIO(reg, v, at) { this.time = at; this.chip.write(reg, v); }
  saveState() {
    return { chip: this.chip.saveState(), port: this.port.saveState(), signal: this.signal, half: this.half.toString(), clock: this.clock.saveState() };
  }
  // after attach: the chip, the port and the clock (its pending event is in the machine's restored queue)
  loadState(s) {
    for (const k of ['chip', 'port', 'signal', 'half', 'clock']) if (!(k in s)) throw new Error(`snapshot: missing "acia.${k}"`);
    this.chip.loadState(s.chip); this.port.loadState(s.port);
    this.signal = s.signal; this.half = BigInt(s.half);
    this.clock.loadState(s.clock);
  }
}

// (the Dragon 64's 6551 is part of the machine, not a cartridge: it is not listed here)
export const devices = registry({ rom: RomCartridge, cocomax: CocoMax });

export { InterruptHub, CartSlot, Device, SlotDevice, RomCartridge, Acia6551, fillRegion, SLOT_LINES };
