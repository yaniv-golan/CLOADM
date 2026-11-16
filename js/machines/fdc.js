/*
 * Floppy disk controller cartridges, as MAME 0.264 builds them (src/devices/bus/coco/dragon_fdc.cpp,
 * coco_fdc.cpp), with up to four drives each:
 *
 * Dragon FDC ('dragonfdc', DragonDOS / Dragon Data's controller): WD2797 at 1 MHz (4 MHz / 4), 5.25" 80-track
 * double-sided drives (FLOPPY_525_QD). $FF40-$FF43 the WD2797 (mirrored at $FF50-$FF53), $FF48-$FF4F the
 * control latch (writes only; mirrored at $FF58-$FF5F):
 *   bits 1-0 drive select, 2 motor on (the selected drive only), 3 single density, 4 write precompensation,
 *   5 NMI enable. NMI = INTRQ and bit 5 (re-evaluated when INTRQ or DRQ changes, not on a latch write, as in
 *   MAME); CART = DRQ (PIA1 CB1, the FIRQ the DOS can use for data transfers).
 *   The WD2797 selects the side itself (command bit 1).
 * CoCo FDC ('cocofdc', Disk BASIC / RS-DOS): WD1773 at 8 MHz, 5.25" 40-track drives (FLOPPY_525_DD).
 *   $FF40-$FF47 DSKREG (writes only): bits 0-2 drive 0-2 select, 6 drive 3 select (and side 1 for drives
 *   0-2), 3 motor on (all drives), 5 double density and NMI enable, 7 HALT enable.
 *   $FF48-$FF4B the WD1773. NMI = INTRQ and bit 5; INTRQ clears bit 7; HALT = bit 7 and not DRQ, so a
 *   transfer loop runs one byte per DRQ without polling.
 * Premier FDC ('premierfdc', the Delta system, MAME premier_fdc): WD2791 at 1 MHz (2 MHz / 2), 5.25" 80-track
 *   double-sided drives. $FF40-$FF43 the WD2791 (no mirror; its data bus is inverted, so the CPU reads and
 *   writes every register as its complement), $FF44 the control latch (writes only): bits 1-0 drive select
 *   (the selected drive's motor runs, the others stop), 2 side, 3 8"/5.25" clock (not modelled by MAME),
 *   4 double density. The WD2791 compares the side (C and S flags) but does not select it. No interrupt
 *   or DRQ line reaches the slot (MAME's update_lines is empty): the DOS polls the status register.
 * Unused addresses in $FF40-$FF5F read 00, as MAME's boards return.
 * Lines reach the CPU through the cartridge slot's timers (js/machines/bus.js CartSlot, cococart.cpp set_line_timer):
 * NMI 12 and HALT 6 CPU cycles after the board changes them (coco.cpp machine_start: set_line_delay, "allowed one
 * more instruction to finish after the line is pulled"), CART at once (after the current access). Each line has a
 * pool of two timers used in turn (TIMER_POOL = 2), so a change still waiting is lost when two newer ones follow it
 * within the delay: the Dragon board re-sends NMI on every DRQ change, which can swallow a short NMI pulse.
 *
 * The DOS ROM is the user's (8K, at $C000; CTS; Dragon and Premier: a 16K region with the rest 00): none is bundled. Without one the cartridge space reads 00.
 *
 * Drives: mount(n, media) with media as js/chips/floppy.js describes (bytes, format, name, writeProtected,
 * onWrite); eject(n); setWriteProtect(n, on); flush() commits written tracks to the media now.
 */
import { SlotDevice, devices } from './bus.js';
import { WD17xx } from '../chips/wd17xx.js';
import { FloppyDrive } from '../chips/floppy.js';
import { NEVER } from '../chips/attotime.js';

const BOARDS = {
  dragonfdc: { name: 'Dragon FDC (WD2797)', chip: 'wd2797', fdcClock: 1000000, drive: '525qd' },
  premierfdc: { name: 'Premier FDC (WD2791)', chip: 'wd2791', fdcClock: 1000000, drive: '525qd' },
  cocofdc: { name: 'CoCo FDC (WD1773)', chip: 'wd1773', fdcClock: 8000000, drive: '525dd' },
  // built into the Dragon Alpha: no cartridge slot lines, READY not tied, drives 0 and 1 fitted (AlphaFdc below)
  alphafdc: { name: 'Dragon Alpha disk interface (WD2797)', chip: 'wd2797', fdcClock: 1000000, drive: '35dd', slot: false, forceReady: false, fitted: 2 },
};
class DiskController extends SlotDevice {
  constructor(type, { rom = null } = {}) {
    super(type);
    const b = BOARDS[type];
    this.slotLines = b.slot !== false;     // the Alpha's built-in interface has no slot lines
    this.board = b;
    this.romBytes = rom ? Uint8Array.from(rom) : null;
    this.cart = null;
    if (this.romBytes) {
      // Dragon, Premier: a 16K region, the ROM at its start and the rest 00 (ROMREGION_ERASE00); CoCo: the 8K ROM
      // repeated through the window (ROM_RELOAD), which the machine's modulo mapping gives
      if (type !== 'cocofdc' && this.romBytes.length < 0x4000) { this.cart = new Uint8Array(0x4000); this.cart.set(this.romBytes); }
      else this.cart = this.romBytes;
    }
    this.wd = new WD17xx(b.chip, this.clock, b.fdcClock, 'wd', { forceReady: b.forceReady !== false });
    this.drives = [0, 1, 2, 3].map((i) => new FloppyDrive(this.clock, `drive${i}`, b.drive));
    this.fitted = b.fitted || 4;    // drives present; the others take no disk and can't be selected
    this.dskreg = 0;
    this.intrq = false;
    this.drq = true;
    this.wd.onIntrq = (v) => { this.intrq = v; this.updateLines(); };
    this.wd.onDrq = (v) => { this.drq = v; this.updateLines(); };
    this.reset(true);
  }
  get name() { return this.board.name; }
  // taken out of the slot: written tracks are committed first
  detach() {
    this.flush();
    super.detach();
  }
  // coco_family_fdc_device_base::device_reset, then the WD's own reset (mr_w) and the drives'
  reset(hard) {
    super.reset(hard);
    this.dskreg = 0; this.intrq = false; this.drq = true;
    // every motor stops: a drive commits what was written (as monW does when its motor stops)
    for (const d of this.drives) { d.flush(); d.revStart = NEVER; d.revCount = 0; d.mon = 1; d.setReady(true); d.cacheClear(); }
    this.wd.reset();
  }
  rom() { return this.cart; }

  // ---------------- lines (cococart_slot_device::set_line_value)
  updateLines() {
    if (this.type === 'dragonfdc') {
      this.lines.set('nmi', this.intrq && !!(this.dskreg & 0x20));
      this.lines.set('cart', this.drq);
    } else if (this.type === 'cocofdc') {
      if (this.intrq) this.dskreg &= ~0x80;
      this.lines.set('nmi', this.intrq && !!(this.dskreg & 0x20));
      this.lines.set('halt', !this.drq && !!(this.dskreg & 0x80));
    }
  }

  // ---------------- registers
  dskregW(data) {
    if (this.type === 'dragonfdc') {
      for (let i = 0; i < 4; i++) this.drives[i].monW((data & 0x04) && i === (data & 0x03) ? 0 : 1);
      this.wd.setFloppy(this.drives[data & 0x03]);
      this.wd.ddenW(data & 0x08);
      this.dskreg = data;
    } else if (this.type === 'premierfdc') {
      for (let i = 0; i < 4; i++) this.drives[i].monW(i === (data & 0x03) ? 0 : 1);
      const sel = this.drives[data & 0x03];
      this.wd.setFloppy(sel);
      sel.ssW(data & 0x04 ? 1 : 0);
      this.wd.ddenW(!(data & 0x10));
      this.dskreg = data;
    } else {
      let drive = 0;
      if (data & 0x04) drive = 2; else if (data & 0x02) drive = 1; else if (data & 0x01) drive = 0; else if (data & 0x40) drive = 3;
      for (const d of this.drives) d.monW(data & 0x08 ? 0 : 1);
      const head = (data & 0x40) && drive !== 3 ? 1 : 0;
      this.dskreg = data;
      this.updateLines();
      const sel = this.drives[drive];
      this.wd.setFloppy(sel);
      sel.ssW(head);
      this.wd.ddenW(!(this.dskreg & 0x20));
    }
  }
  readIO(a) {
    if (a >= 0xFF60) return undefined;            // nothing in the cartridge space
    const off = a - 0xFF40;
    if (this.type === 'dragonfdc') {
      const r = off & 0xef;
      return r < 4 ? this.wd.read(r) : 0x00;
    }
    if (this.type === 'premierfdc') return off < 4 ? this.wd.read(off) : 0x00;
    const r = off & 0x1f;
    return r >= 8 && r < 12 ? this.wd.read(r - 8) : 0x00;
  }
  writeIO(a, v) {
    if (a >= 0xFF60) return;
    const off = a - 0xFF40;
    if (this.type === 'dragonfdc') {
      const r = off & 0xef;
      if (r < 4) this.wd.write(r, v);
      else if (r >= 8 && r < 16) this.dskregW(v);
      return;
    }
    if (this.type === 'premierfdc') {
      if (off < 4) this.wd.write(off, v);
      else if (off === 4) this.dskregW(v);
      return;
    }
    const r = off & 0x1f;
    if (r < 8) this.dskregW(v);
    else if (r < 12) this.wd.write(r - 8, v);
  }

  // ---------------- media
  drive(n) {
    if (!Number.isInteger(n) || n < 0 || n >= this.fitted) throw new Error(`no drive ${n} (drives 0-${this.fitted - 1})`);
    return this.drives[n];
  }
  mount(n, media) { this.drive(n).mount(media); }
  eject(n) { this.drive(n).unmount(); }
  setWriteProtect(n, on) { this.drive(n).setWriteProtect(on); }
  flush() { for (const d of this.drives) d.flush(); }

  // ---------------- snapshots
  saveState() {
    return Object.assign(super.saveState(), {
      rom: this.romBytes ? this.romBytes.slice() : null,
      dskreg: this.dskreg, intrq: this.intrq, drq: this.drq,
      wd: this.wd.saveState(),
      drives: this.drives.map((d) => d.saveState()),
      floppy: this.wd.floppy ? this.drives.indexOf(this.wd.floppy) : -1,
    });
  }
  // onWrite: the host's media listeners per drive (not part of a snapshot)
  loadState(s, onWrite = []) {
    this.dskreg = s.dskreg; this.intrq = s.intrq; this.drq = s.drq;
    this.drives.forEach((d, i) => d.loadState(s.drives[i], onWrite[i] || null));
    this.wd.loadState(s.wd);
    this.wd.bind(s.floppy >= 0 ? this.drives[s.floppy] : null);
    super.loadState(s);
  }
}

class DragonFdc extends DiskController {
  constructor(opts) { super('dragonfdc', opts); }
  static fromState(s) { const d = new DragonFdc({ rom: s.rom }); d.loadState(s); return d; }
}
class CocoFdc extends DiskController {
  constructor(opts) { super('cocofdc', opts); }
  static fromState(s) { const d = new CocoFdc({ rom: s.rom }); d.loadState(s); return d; }
}
class PremierFdc extends DiskController {
  constructor(opts) { super('premierfdc', opts); }
  static fromState(s) { const d = new PremierFdc({ rom: s.rom }); d.loadState(s); return d; }
}
/*
 * The Dragon Alpha's built-in disk interface (MAME dgnalpha.cpp): a WD2797 at 1 MHz and four 3.5" double-density
 * drives (FLOPPY_35_DD). MAME fits drives 0 and 1 (2 and 3 only with slot options): so do we, and selecting 2 or 3
 * selects no drive. The machine maps the registers
 * (reversed, $FF2C data to $FF2F status/command) and routes the lines: INTRQ to NMI gated by PIA2 CA2, DRQ to
 * PIA2 CB1. The AY-3-8912's port A is the control latch (select(), psg_porta_write): bits 0-3 select a drive (the
 * highest set bit wins; none selects no drive), bit 5 is DDEN (1: single density), and every write starts all
 * the motors (MAME: "turning the motor on with bit 4 isn't giving the drive enough time to spin up").
 * The machine owns it: no slot lines, not a cartridge (no rom(), no fromState through `devices`).
 */
class AlphaFdc extends DiskController {
  constructor() {
    super('alphafdc');
    this.onIntrq = null;        // the machine's handlers, called when the line changes (the WD's callbacks)
    this.onDrq = null;
    this.wd.onIntrq = (v) => { this.intrq = v; if (this.onIntrq) this.onIntrq(v); };
    this.wd.onDrq = (v) => { this.drq = v; if (this.onDrq) this.onDrq(v); };
  }
  select(data) {
    let floppy = null;
    for (let n = 0; n < 4; n++) if (data & (1 << n)) floppy = n < this.fitted ? this.drives[n] : null;
    this.wd.setFloppy(floppy);
    for (let n = 0; n < this.fitted; n++) this.drives[n].monW(0);
    this.wd.ddenW(data & 0x20);
    this.dskreg = data;
  }
}
devices.dragonfdc = DragonFdc;
devices.premierfdc = PremierFdc;
devices.cocofdc = CocoFdc;

export { DiskController, DragonFdc, PremierFdc, CocoFdc, AlphaFdc, BOARDS as FDC_BOARDS };
