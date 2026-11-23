/*
 * Cartridges without a disk controller, as MAME 0.264 builds them (src/devices/bus/coco):
 *
 * BankedRomCartridge ('banked', coco_pak.cpp coco_pak_banked_device, "banked_16k"; RPK PCB type "paged16k"):
 *   a 128K region (0x20000, ROMREGION_ERASE00) filled with the image, repeated when shorter (call_load);
 *   writing $FF40 selects the 16K bank at (value x $4000) mod $20000 shown at $C000-$FEFF. Other SCS addresses do
 *   nothing and read 00. Bank 0 at every reset; CART tied to Q at reset when auto-start is on.
 * GamesMaster ('gmc', coco_gmc.cpp): the banked cartridge plus an SN76489A at 4 MHz written at $FF41.
 * Orchestra90 ('orch90', coco_orch90.cpp): an 8K ROM (mirrored through $C000-$FEFF) and two 8-bit DACs written
 *   at $FF7A (left) and $FF7B (right), outside the SCS range; CART tied to Q from power-on (device_start).
 * MultiPak ('multi', coco_multi.cpp): four slots. $FF7F (read and write, "cartridge space"): bits 1-0 select the
 *   slot that gets SCS ($FF40-$FF5F), bits 5-4 the slot that gets CTS ($C000-$FEFF) and whose CART line reaches
 *   the machine; reading returns the selection OR $CC. At reset the selection follows the front-panel switch
 *   (slot 1-4: $CC/$DD/$EE/$FF; default slot 4) until $FF7F is written. NMI and HALT from any slot pass through
 *   (the last change wins, as in MAME's update_line). A cartridge in a Multi-Pak slot sees no line delay (only
 *   the machine's slot delays NMI and HALT), and the Multi-Pak's own slot toggles CART on PIA1 writes when it
 *   follows Q (twiddle_q_lines reaches only the machine's slot). A slot also takes a disk controller
 *   (js/machines/fdc.js; MAME offers one in slot 4 only, which is what run.js --fdc --multi compares). The slot's
 *   line timers run inside the Multi-Pak's: the machine's single time (host.attoNow, js/chips/attoclock.js)
 *   makes the Multi-Pak's timer count from the exact time the slot's fired, as MAME's do.
 *
 * Sound (Machine.cartSound, mono): the SN76489A's stream (2 MHz) and the Orchestra-90's DACs are reported as
 * level changes at their exact sample times, with MAME's route gains (GMC 1.0; Orchestra-90 0.5 per side, the two
 * sides summed). A register write takes effect from the first stream sample that starts at or after the write's
 * time (sound_stream::update() before the write; time_to_buffer_index rounds up).
 */
import { SlotDevice, devices, fillRegion } from './bus.js';
import { SN76489 } from '../chips/sn76489.js';
import { crc32, registry } from '../util.js';

const ATTO = 1000000000000000000n;

// ------------------------------------------------------------------ banked ROM (and the Games Master)
class BankedRomCartridge extends SlotDevice {
  constructor(bytes, { autostart = true } = {}, type = 'banked') {
    super(type);
    this.bytes = Uint8Array.from(bytes);
    this.autostart = autostart;
    this.region = fillRegion(this.bytes, 0x20000);
    this.pos = 0;
  }
  get name() { return 'Banked ROM cartridge'; }
  get bankBase() { return (this.pos * 0x4000) % 0x20000; }
  rom() { return this.region.subarray(this.bankBase, this.bankBase + 0x4000); }
  reset(hard) {
    super.reset(hard);
    this.lines.set('cart', this.autostart ? 'q' : 'clear');
    if (this.pos !== 0) { this.pos = 0; if (this.host) this.host.cartridgeChanged(); }
  }
  readIO(a) { return a < 0xFF60 ? 0x00 : undefined; }       // SCS reads 00; nothing in the cartridge space
  writeIO(a, v) {
    if (a === 0xFF40 && this.pos !== v) { this.pos = v; if (this.host) this.host.cartridgeChanged(); }
  }
  saveState() { return Object.assign(super.saveState(), { bytes: this.bytes.slice(), autostart: this.autostart, pos: this.pos }); }
  loadState(s) { super.loadState(s); this.pos = s.pos; }
  static fromState(s) { const d = new BankedRomCartridge(s.bytes, { autostart: s.autostart }); d.loadState(s); return d; }
}

// A sound stream at a fixed rate, kept in step with machine time: samples up to (not including) the first one
// that starts at or after `attos` are produced with the chip's state before a change (MAME sound_stream::update).
class Stream {
  constructor(rate, produce) {
    this.rate = BigInt(rate);
    this.sampleAttos = ATTO / this.rate;
    this.produce = produce;     // (index) => value of sample `index`
    this.next = 0;              // index of the next sample to produce
    this.value = 0;
  }
  // index of the first sample starting at or after t (time_to_buffer_index(t, round_up))
  indexAt(t) { return Number((t + this.sampleAttos - 1n) / this.sampleAttos); }
  sync(t, onChange) {
    const end = this.indexAt(t);
    for (let k = this.next; k < end; k++) {
      const v = this.produce(k);
      if (v !== this.value) { this.value = v; onChange(k, v); }
    }
    if (end > this.next) this.next = end;
  }
  saveState() { return { next: this.next, value: this.value }; }
  loadState(s) { this.next = s.next; this.value = s.value; }
}

class GamesMaster extends BankedRomCartridge {
  constructor(bytes, opts = {}) {
    super(bytes, opts, 'gmc');
    this.psg = new SN76489();
    this.stream = new Stream(2000000, () => this.psg.sample());   // 4 MHz / 2
  }
  get name() { return 'Games Master Cartridge'; }
  // the stream up to machine time t (attoseconds), reporting level changes to the host
  syncTo(t) {
    this.stream.sync(t, (k, v) => {
      if (this.host) this.host.cartSound(Math.floor(this.clock.tickOf(BigInt(k) * this.stream.sampleAttos)), v / 32768);
    });
  }
  syncAudio(tick) { if (this.host) this.syncTo(this.clock.timeAt(tick)); }
  writeIO(a, v) {
    if (a === 0xFF41) { this.syncTo(this.clock.now()); this.psg.write(v); return; }
    super.writeIO(a, v);
  }
  saveState() { return Object.assign(super.saveState(), { psg: this.psg.saveState(), stream: this.stream.saveState() }); }
  loadState(s) { super.loadState(s); this.psg.loadState(s.psg); this.stream.loadState(s.stream); }
  static fromState(s) { const d = new GamesMaster(s.bytes, { autostart: s.autostart }); d.loadState(s); return d; }
}

// ------------------------------------------------------------------ Orchestra-90
class Orchestra90 extends SlotDevice {
  constructor(bytes) {
    super('orch90');
    this.bytes = Uint8Array.from(bytes);
    this.eprom = new Uint8Array(0x2000);          // ROMREGION_ERASE00, the image at its start
    this.eprom.set(this.bytes.subarray(0, 0x2000));
    this.left = 0; this.right = 0;
  }
  get name() { return 'Orchestra-90'; }
  rom() { return this.eprom; }
  reset(hard) {
    super.reset(hard);
    if (hard) this.lines.set('cart', 'q');      // device_start: "Orch-90 ties CART to Q"
  }
  readIO(a) { return a < 0xFF60 ? 0x00 : undefined; }       // SCS reads 00; the DACs are write-only
  writeIO(a, v) {
    if (a !== 0xFF7A && a !== 0xFF7B) return false;
    if (a === 0xFF7A) this.left = v; else this.right = v;
    // DAC_8BIT_R2R: value / 256, routed to its speaker at gain 0.5; mono here: the two sides summed
    if (this.host) this.host.cartSound(this.host.tickAt(-1), (this.left + this.right) / 512);
    return true;
  }
  saveState() { return Object.assign(super.saveState(), { bytes: this.bytes.slice(), left: this.left, right: this.right }); }
  loadState(s) { super.loadState(s); this.left = s.left; this.right = s.right; }
  static fromState(s) { const d = new Orchestra90(s.bytes); d.loadState(s); return d; }
}

// ------------------------------------------------------------------ Multi-Pak
const SLOT_LOOKUP = [0xCC, 0xDD, 0xEE, 0xFF];

class MultiPak extends SlotDevice {
  // carts: up to four devices (or null), slot 1 first; switchSlot: the front-panel switch, 1-4
  constructor(carts = [], { switchSlot = 4 } = {}) {
    super('multi');
    if (!Number.isInteger(switchSlot) || switchSlot < 1 || switchSlot > 4) throw new Error(`Multi-Pak switch: slot ${switchSlot} (slots 1-4)`);
    if (carts.length > 4) throw new Error('a Multi-Pak has four slots');
    this.switchSlot = switchSlot;
    this.slots = [0, 1, 2, 3].map((i) => carts[i] || null);
    for (const [i, c] of this.slots.entries()) {
      if (!c) continue;
      if (c instanceof MultiPak) throw new Error('a Multi-Pak cannot hold another Multi-Pak');
      c.id = `multi${i + 1}.${c.type}`;
    }
    this.select = 0xFF;      // device_start
    this.block = 0;
    this.levels = [0, 0, 0, 0];
  }
  get name() { return 'Multi-Pak Interface'; }
  attach(host) {
    super.attach(host);
    this.slots.forEach((c, i) => { if (c) c.attach(this.slotHost(host, i + 1)); });
  }
  // what a cartridge in slot n sees in place of the machine
  slotHost(m, n) {
    const mp = this;
    return {
      get tickHz() { return m.tickHz; },
      get unitAttos() { return m.unitAttos; },
      get slotHz() { return m.slotHz; },
      get cartClockHz() { return m.cartClockHz; },
      get config() { return m.config; },
      get attoNow() { return m.attoNow; },
      set attoNow(t) { m.attoNow = t; },
      lineDelays: { cart: 0, nmi: 0, halt: 0 },
      now: () => m.now(),
      ioTime: () => m.ioTime(),
      schedule: (...a) => m.schedule(...a),
      cancel: (...a) => m.cancel(...a),
      on: (...a) => m.on(...a),
      off: (name) => m.off(name),
      clockUnits: () => m.clockUnits(),
      tickAt: (u) => m.tickAt(u),
      powerOnTick: () => m.powerOnTick(),
      setLine: (src, line) => mp.updateLine(n, line),
      cartridgeChanged: () => { if (n === mp.ctsSlot) m.cartridgeChanged(); },
      // The machine's sound mux, passed through so a cartridge in a slot gates its audio the same way it would
      // in the machine's own slot: MAME's coco_multi.cpp forwards set_sound_enable to every slot. These are
      // getters to the MACHINE's PIAs, so a slot reads the live lines rather than a copy.
      get pia0() { return m.pia0; },
      get pia1() { return m.pia1; },
      cartSound: (tick, level) => { mp.levels[n - 1] = level; m.cartSound(tick, mp.levels[0] + mp.levels[1] + mp.levels[2] + mp.levels[3]); },
    };
  }
  // taken out: the cartridges in its slots first (their lines, events and media), then its own slot
  detach() {
    for (const c of this.slots) if (c) c.detach();
    super.detach();
  }
  get scsSlot() { return (this.select & 3) + 1; }
  get ctsSlot() { return ((this.select >> 4) & 3) + 1; }
  // it can assert HALT if anything in a slot can (a Multi-Pak's slots change only by a new Multi-Pak: the panel
  // builds one and the machine attaches it over the old, which is what devicesAttached then settles)
  get canHalt() { return this.slots.some((c) => !!c && c.canHalt); }
  cart(n) { return this.slots[n - 1]; }
  lineValue(n, line) { const c = this.cart(n); return c && c.lines ? c.lines.value(line) : 'clear'; }
  // update_line
  updateLine(n, line) {
    if (line === 'cart' && n !== this.ctsSlot) return;
    // (the slot's timer that passes the change on runs at its expiry, and this slot's delay counts from there:
    // the machine's single time, host.attoNow)
    this.lines.set(line, this.lineValue(n, line));
  }
  // set_select
  setSelect(v) {
    const old = this.lineValue(this.ctsSlot, 'cart');
    this.select = v;
    if (this.lineValue(this.ctsSlot, 'cart') !== old) this.updateLine(this.ctsSlot, 'cart');
    if (this.host) this.host.cartridgeChanged();
  }
  reset(hard) {
    super.reset(hard);
    for (const c of this.slots) if (c) c.reset(hard);
    this.setSelect(SLOT_LOOKUP[this.switchSlot - 1]);
    this.block = 0;
  }
  rom() { const c = this.cart(this.ctsSlot); return c ? c.rom() : null; }
  // SCS ($FF40-$FF5F) goes to the selected slot (00 from an empty one); in the cartridge space ($FF60-$FFBF) $FF7F
  // is the Multi-Pak's and the cartridges' own handlers share the rest (the last installed, slot 4's, wins)
  readIO(a) {
    if (a < 0xFF60) { const c = this.cart(this.scsSlot); const v = c ? c.readIO(a) : undefined; return v === undefined ? 0x00 : v; }
    if (a === 0xFF7F) return this.select | 0xCC;
    for (let i = 3; i >= 0; i--) { const c = this.slots[i]; if (c) { const v = c.readIO(a); if (v !== undefined) return v; } }
    return undefined;
  }
  writeIO(a, v) {
    if (a < 0xFF60) { const c = this.cart(this.scsSlot); if (c) c.writeIO(a, v); return true; }
    if (a === 0xFF7F) { this.block = 0xFF; this.setSelect(v); return true; }
    for (let i = 3; i >= 0; i--) { const c = this.slots[i]; if (c && c.writeIO(a, v)) return true; }
    return false;
  }
  syncAudio(tick) { for (const c of this.slots) if (c) c.syncAudio(tick); }
  saveState() {
    return Object.assign(super.saveState(), {
      switchSlot: this.switchSlot, select: this.select, block: this.block, levels: this.levels.slice(),
      slots: this.slots.map((c) => (c ? { type: c.type, state: c.saveState() } : null)),
    });
  }
  loadState(s) { super.loadState(s); this.select = s.select; this.block = s.block; this.levels = s.levels.slice(); }
  static fromState(s) {
    const d = new MultiPak(s.slots.map((x) => (x ? devices[x.type].fromState(x.state) : null)), { switchSlot: s.switchSlot });
    d.loadState(s);
    return d;
  }
}

// The boards a cartridge image can be put on, for the page's choice and the Session. 'auto': the Orchestra-90 by its
// ROM's CRC (MAME's ROM table: 15FB39AF), a banked board for images over 16K, a Program Pak otherwise.
// `ssc` is listed so the page can name it in the board menu, but it holds NO cartridge image: the Pak runs its own
// PIC firmware, which is user-supplied through the ROM panel (Session.insertSsc), so `imageRuns: false` makes
// cartridgeFor refuse an image for it rather than putting one on a board that has no ROM socket for it.
const CART_BOARDS = registry({
  auto: { name: 'Automatic' },
  pak: { name: 'Program Pak', max: 0x8000 },
  banked: { name: 'Banked ROM cartridge', max: 0x20000 },
  gmc: { name: 'Games Master Cartridge', max: 0x20000 },
  orch90: { name: 'Orchestra-90', max: 0x2000 },
  ssc: { name: 'Speech/Sound Pak (music only; speech not yet)', max: 0, imageRuns: false },
});
const ORCH90_CRC = '15FB39AF';               // crc32() gives upper-case hex
function cartridgeFor(bytes, board = 'auto') {
  if (!CART_BOARDS[board]) throw new Error(`unknown cartridge board "${board}" (have: ${Object.keys(CART_BOARDS).join(', ')})`);
  const b0 = CART_BOARDS[board];
  if (b0.imageRuns === false) throw new Error(`${b0.name}: this board takes no cartridge image. It runs its own firmware, which you add through the ROM panel, then insert the board.`);
  if (!bytes || !bytes.length) throw new Error('the cartridge image is empty');
  if (board === 'auto') board = crc32(bytes) === ORCH90_CRC ? 'orch90' : bytes.length > 0x4000 ? 'banked' : 'pak';
  const b = CART_BOARDS[board];
  if (bytes.length > b.max) throw new Error(`${b.name}: the image is ${bytes.length} bytes; this board holds up to ${b.max / 1024}K`);
  return board === 'pak' ? new devices.rom(Uint8Array.from(bytes)) : new devices[board](bytes);
}

devices.banked = BankedRomCartridge;
devices.gmc = GamesMaster;
devices.orch90 = Orchestra90;
devices.multi = MultiPak;

export { BankedRomCartridge, GamesMaster, Orchestra90, MultiPak, Stream, CART_BOARDS, cartridgeFor };
