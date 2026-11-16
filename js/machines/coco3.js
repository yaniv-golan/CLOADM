/*
 * families.coco3: Tandy Color Computer 3 (profiles coco3, coco3p).
 * 6809E + GIME (js/chips/gime.js, GIME) + 2x MC6821, 128K or 512K RAM (config.ram).
 *
 * Time unit: this machine's "cycles" (this.cycle, frameCycles, audioEvents, tape timing, tickHz)
 * are GIME clocks (master crystal / 8 = 3.58 MHz NTSC), because the CPU runs at two speeds:
 * a CPU cycle is 4 clocks at 0.89 MHz and 2 clocks at 1.79 MHz (SAM R bits, $FFD6-$FFD9).
 * A scanline is 228 clocks; a frame is 262 lines (NTSC) or 312 (PAL).
 * cpu.totalCycles still counts CPU cycles (that is what the MAME comparison uses).
 *
 * this.mem is all of physical RAM. this.ram is the 64K window of physical RAM that the CPU sees
 * with the power-on / BASIC mapping (blocks $38-$3F), so code that pokes CPU addresses into
 * this.ram (BASIC program loading, screen inspection) works as on the other machines.
 *
 * Video: render() returns the GIME's 640 x 240 buffer (screenWidth x screenHeight, constant for
 * all modes; pixels are half as wide as tall, screenAspect 4:3). this.monitor = 'rgb' | 'composite'.
 *
 * Verified against MAME 0.264 (tools/mame-diff/coco3): identical instruction traces and cycle
 * counts, including GIME interrupts, timer and CPU speed changes, and identical video in all
 * tested modes apart from the text font designs (ours).
 */
import { GIME } from '../chips/gime.js';
import { MC6821 } from '../chips/mc6821.js';
import { cpus } from '../cpu/cpus.js';
import { InterruptHub } from './bus.js';
import { wireCocoPias } from './cocopia.js';
import { Machine } from './machine.js';
import { SerialPort } from './rs232.js';
import { TextConsole, banner, stubRom } from './stub.js';
import { state } from '../util.js';
import { hzToAttos } from '../chips/attotime.js';

const LINE = 228, HS_FALL = 212;
// an event at tick T is seen before an instruction starting at tick a when T < a + (clocks per cycle) (see ioTime);
// events on fractional ticks (the exact-time devices, js/chips/attoclock.js) too, whose times carry rounding error,
// so the bound is just under it: by 1e-6, or by a few steps of the double once ticks are large (past 2^34 ticks a
// fixed 1e-6 is less than half a step and the bound rounds back up to the tick itself)
const justUnder = (x) => x - Math.max(1e-6, x * 2 ** -50);
const MAME_TIME_LAG = 4;   // GIME clocks: MAME's machine time starts one CPU cycle after ours (see the constructor)

// no-ROM stub firmware (js/machines/stub.js): 32K internal ROM, vectors via the $FExx page
const STUB = stubRom('6809', 0x8000, 0x8000, { gime: true });

// CoCo 3 BASIC's RGB palette for compatibility modes (VDG colours, then SG/graphics black,
// green, black, buff and the text dark green, green, dark orange, orange)
const COMPAT_PALETTE = [18, 54, 9, 36, 63, 27, 45, 38, 0, 18, 0, 63, 0, 18, 0, 38];

class Coco3Machine extends Machine {
  constructor(profile, config) {
    const pal = profile.video === 'pal';
    const master = pal ? 28475000 : 28636363;
    super(profile, config, { tickHz: master / 8, lineCycles: LINE, lines: pal ? 312 : 262, resetOffset: 20, ramSize: 1 });
    this.masterHz = master;
    if (config.mameCompat) this.unitAttos = 10n ** 18n / BigInt(Math.floor(master / 32)) / 4n;
    this.cpuClockHz = master / 32;          // nominal 6809 clock at normal speed
    // Exact time (Machine.clockUnits, for the disk drives' timers) is reckoned in GIME clocks of the real crystal.
    // config.mameCompat: as MAME's machine time, a quarter of its 6809 cycle (1e18 / 894886 attoseconds; the GIME
    // clock is 4 CPU cycles' worth at 0.89 MHz, 2 at 1.79 MHz) from one CPU cycle later than our reset point
    // (measured with tools/mame-diff/fdc: MAME coco3 reads the WD1773 first at 0.272549799639 s, 7 CPU cycles
    // after MAME coco does on the same firmware)
    if (config.mameCompat) this.unitAttos = (hzToAttos(Math.floor(this.cpuClockHz)) + 2n) / 4n;
    const kb = config.ram;
    this.mem = new Uint8Array(kb * 1024);
    this.ram = this.mem.subarray(0x70000 & (this.mem.length - 1), (0x70000 & (this.mem.length - 1)) + 0x10000);
    this.cpu = new cpus[config.cpu](this);
    this.cpu.mameCompat = !!config.mameCompat;   // MAME's m6809 SYNC timing (comparisons only)
    this.interrupts = new InterruptHub(this.cpu);
    this.pia0 = new MC6821();
    this.pia1 = new MC6821();
    this.pia1.b.c1 = false;          // CB1 (CART) starts low, as MAME's 6821 (m_in_cb1 = 0)
    this.gime = new GIME({ ram: this.mem, pal, rom: () => this.romImage(), cart: () => (this.cartPort ? this.cartPort.rom() : null) });
    this.div = 4;                 // GIME clocks per CPU cycle
    this.instrPc = 0;
    this.speedChange = -1;
    // HALT arriving inside an instruction (config.mameCompat; see fireEvent): the step that ran last, the HALT
    this.stepS = 0; this.stepN = 0; this.inStep = false; this.haltAt = -1;
    this.haltS = -1; this.haltK = 0; this.haltN = 0;
    this.sliceStart = 0;
    this.holdUntil = -Infinity;
    this.kbIrqLevel = false;
    this.screenWidth = GIME.WIDTH; this.screenHeight = GIME.HEIGHT; this.screenAspect = 4 / 3;
    this.setupIO();
    this.installStub(STUB.symbols, new TextConsole(this.ram, 0x400, () => (this.ram[0x88] << 8) | this.ram[0x89],
      (pos) => { this.ram[0x88] = pos >> 8; this.ram[0x89] = pos & 0xFF; }), () => this.stubInit());
    // MAME's scheduler-slice timing (only with config.mameCompat, for the comparisons): I/O accesses
    // that change an interrupt output end a slice, and events are seen per slice
    if (config.mameCompat) {
      this.syncIo = this.syncIoMame;
      this.processEvents = this.processEventsMame;
    } else this.syncIo = (fn) => fn();
    this.on('rise', (arg, at) => this.hsRiseEvent(at));
    this.on('fall', () => this.hsFallEvent());
    this.on('timer', () => { this.timerEvent = null; this.gime.timerExpired(); });
    this.timerEvent = null;
  }

  // ---------------- ROMs / cartridge ----------------
  romImage() { return this.roms.basic && this.roms.basic.length >= 0x8000 ? this.roms.basic : STUB.rom; }
  romsChanged() { this.gime.cartridgeChanged(); }
  get hasCartridgePort() { return true; }
  // CART (cartridge pin 8) drives PIA1 CB1 and the GIME's EI0, as MAME's coco3_state::cart_w
  cartLineChanged(level) { this.pia1.setC1('b', level); this.gime.setInput(GIME.INT.EI0, level); }
  // the cartridge slot runs on the driver's clock, the slow CPU rate (coco3.cpp: XTAL / 32, COCOCART_SLOT
  // DERIVED_CLOCK(1, 1)), at either CPU speed; its NMI and HALT delays count that clock
  get slotHz() { return this.masterHz / 32; }
  // exact time (Machine.clockUnits) with config.mameCompat: MAME's clocks. The CPU (DERIVED_CLOCK of
  // XTAL/32, 894886 Hz) spends 1e18/894886 as per cycle, 1e18/1789772 at the GIME's fast rate; a unit is a quarter
  // of the first, rounded down to 279365449 as (also exactly half of the second, rounded down), which runs 0.75 as
  // per tick short of MAME, 11 ps after 4 seconds. MAME's machine time counts 4 cycles before the first
  // instruction (as on the SAM machines, sam.js clockUnits), one fewer than our video origin (resetOffset 20 ticks).
  clockUnits() { return this.config.mameCompat ? super.clockUnits() - 4 : super.clockUnits(); }
  cartridgeChanged() { this.gime.cartridgeChanged(); }
  get monitor() { return this.gime.monitor; }
  set monitor(v) { this.gime.monitor = v === 'composite' ? 'composite' : 'rgb'; }
  // the Display tab: composite (1 or 2, the NTSC artifact phase) shows the composite monitor's palette and artifact
  // colours in the compatibility modes; 0 the RGB monitor's palette, without
  setComposite(setting) { this.monitor = setting ? 'composite' : 'rgb'; this.gime.artifact = setting; }

  // ---------------- wiring ----------------
  setupIO() {
    const p0 = this.pia0, g = this.gime;
    // the GIME's interrupts are gated by $FF90 IEN/FEN (the PIAs' reach the CPU directly)
    g.onIrq = () => { this.setLine('gime-irq', 'irq', g.irqOut); this.setLine('gime-firq', 'firq', g.firqOut); };
    // GIME timer: one scheduled event per timer period; a restart replaces the pending one
    g.onTimer = (due) => {
      if (this.timerEvent) this.cancel(this.timerEvent);
      this.timerEvent = due !== Infinity ? this.schedule(due, 'timer') : null;
    };
    wireCocoPias(this, {
      noTapeHigh: true,
      // PB2: RAM size sense (follows PIA0 PB6 when 64K or more is fitted); PB0: serial in (the bit-banger's RXD)
      pb1Input: () => (p0.b.outValue() & 0x40 ? 0x04 : 0x00) | this.bitBanger.rxd(this.ioTime()),
      onChange: () => this.updateKeyboardIrq(),
      hires: this.config.hires,
    });
    // bit-banger serial port: TXD is PIA1 PA1 (as the CoCo 1/2); a serial printer by default
    this.bitBanger = new SerialPort(this.tickHz, (b) => this.printed.push(b));
    this.pia1.a.onOutput = (v) => this.bitBanger.txd(this.ioTime(), (v >> 1) & 1);
  }
  // GIME keyboard interrupt (EI1): any key row pulled low by a pressed key in a strobed column
  // or a joystick button. (MAME raises EI1 when the rows are all high instead, i.e. on key
  // release; that looks like an emulation artefact, so we follow the hardware description.)
  updateKeyboardIrq() {
    const p0 = this.pia0;
    let rows = this.keyRowsForCols(p0.b.outValue()) & 0x7F;
    if (this.fire[0] || this.fire[1]) rows |= 1;
    const level = rows !== 0;
    if (level !== this.kbIrqLevel) { this.kbIrqLevel = level; this.gime.setInput(GIME.INT.EI1, level); }
  }
  setKey(name, down) { super.setKey(name, down); this.updateKeyboardIrq(); }
  clearKeys() { super.clearKeys(); if (this.gime) this.updateKeyboardIrq(); }

  // ---------------- memory ----------------
  // byte on the data bus when nothing drives it: the next instruction byte after a no-offset
  // indexed access ("LDA ,X"), otherwise the byte at $FFFF (documented by Darren Atkinson; MAME
  // implements the same rule)
  floating() {
    let pc = this.instrPc, op = this.peek(pc);
    if (op === 0x10 || op === 0x11) op = this.peek(++pc);
    const hi = op & 0xF0;
    const noOff = (hi === 0x60 || hi === 0xA0 || hi === 0xE0) && (this.peek(pc + 1) & 0xBF) === 0x84;
    return this.peek(noOff ? this.cpu.pc : 0xFFFF);
  }
  // side-effect-free read
  peek(a) {
    a &= 0xFFFF;
    if (a < 0xFF00) return this.gime.read(a);
    if (a >= 0xFFE0) return this.romImage()[0x7FE0 + (a & 0x1F)];
    return 0xFF;
  }
  // Why a write at `a` would not be seen (see Machine.writeKind): the I/O page, the vectors at $FFE0-$FFFF
  // (which always come from the internal ROM's last 32 bytes, as read() does), and ROM in whichever slot the
  // MMU maps it to (the GIME's write view for that slot is its sink). There is no absent-RAM case here: the
  // GIME masks every block address with ramMask (gime.js physAddr), so a block index beyond the fitted RAM
  // wraps onto installed RAM instead of reading nothing (measured at 128K: slot 0 = block 40 reads back a
  // wrapped address and the write is visible).
  writeKind(a) {
    a &= 0xFFFF;
    if (a >= 0xFF00) return a < 0xFFE0 ? 'io' : 'rom';      // I/O page; $FFE0-$FFFF is the ROM's vectors
    const s = a >= 0xFE00 ? 8 : a >> 13;
    return this.gime.wr[s] === this.gime.sink ? 'rom' : null;
  }
  read(a) {
    if (a < 0xFF00) return this.gime.read(a);
    // $FFE0-$FFFF always come from the last 32 bytes of the internal ROM (as MAME maps them)
    if (a >= 0xFFE0) return this.romImage()[0x7FE0 + (a & 0x1F)];
    this.processEvents(justUnder(this.ioTime() + 1));
    if (a < 0xFF10) return this.syncIo(() => this.pia0.read(a & 3));
    if (a < 0xFF20) return 0x00;
    if (a < 0xFF30) return this.syncIo(() => this.pia1.read(a & 3));
    if (a < 0xFF60) {                               // SCS: cartridge I/O ($00 with nothing fitted)
      // (only while the GIME enables the spare chip select: MAME coco3_state::ff40_read)
      if (a >= 0xFF40 && !this.gime.scsEnabled) return 0x00;
      if (this.becker && (a === 0xFF41 || a === 0xFF42)) return this.becker.readIO(a - 0xFF41);   // (before the cartridge, as MAME)
      if (a >= 0xFF40 && this.cartPort) { const v = this.cartPort.readIO(a); if (v !== undefined) return v; }
      return 0x00;
    }
    // $FF60-$FF8F: unassigned, and a cartridge may answer for part of it (MAME: ff60_read ->
    // floating_space_read, the cartridge's address space). $FF90-$FF9F belongs to the GIME on a CoCo 3, so
    // the CoCo Max module, which uses those registers, is a CoCo 1/2 device and is not driven here.
    if (a < 0xFF90) { const v = this.cartPort ? this.cartPort.readIO(a) : undefined; return v === undefined ? this.floating() : v; }
    if (a < 0xFFC0) return this.syncIo(() => this.gime.readReg(a, () => this.floating()));
    return this.floating();
  }
  write(a, v) {
    if (a < 0xFF00) { this.gime.write(a, v); return; }
    if (a >= 0xFFE0) return;
    const t = this.ioTime();
    this.processEvents(justUnder(t + 1));
    if (a < 0xFF10) { this.syncIo(() => this.pia0.write(a & 3, v), true); return; }
    if (a < 0xFF20) return;
    if (a < 0xFF30) {
      this.syncIo(() => { this.pia1.write(a & 3, v); this.gime.piaWrite(a - 0xFF20, v); }, true);
      // MAME approximates a cartridge's CART tied to Q by toggling it on every PIA1 write (coco3_state::ff20_write)
      if (this.config.mameCompat && this.cartPort) this.cartPort.twiddleQ();
      return;
    }
    if (a >= 0xFF40 && a < 0xFF60) {
      if (!this.gime.scsEnabled) return;          // (MAME coco3_state::ff40_write)
      if (this.becker && (a === 0xFF41 || a === 0xFF42)) this.becker.writeIO(a - 0xFF41, v);
      else if (this.cartPort) this.cartPort.writeIO(a, v);
      return;
    }
    if (a < 0xFF90) { if (this.cartPort) this.cartPort.writeIO(a, v); return; }
    this.syncIo(() => { if (this.gime.writeReg(a, v, t)) this.speedChange = this.cpu.cycleCount; }, true);
  }

  // ---------------- time line ----------------
  // Visibility rule (as in MAME's cycle-stepped 6809): an event at time T is seen by a bus
  // access whose cycle starts at a if T < a + (clocks per cycle); interrupts are sampled at
  // the start of an instruction by the same rule.
  ioTime() { return this.cycle + Math.max(1, this.cpu.cycleCount) * this.div - 1; }
  clockUnits() { return super.clockUnits() - (this.config.mameCompat ? MAME_TIME_LAG : 0); }
  // Start of the current access cycle (the CPU counts the cycles of the instruction so far).
  accessStart() { return this.cycle + Math.max(0, this.cpu.cycleCount - 1) * this.div; }

  // MAME runs the CPU in scheduler slices; where a slice starts matters when the CPU clock rate
  // changes (see runCycles). A slice starts at every timer event (on the CPU's cycle grid) and
  // after any access that changes an interrupt output or restarts the GIME timer (MAME's
  // interrupt lines go through synchronize(), which ends the slice).
  syncIoMame(fn, isWrite) {
    const g = this.gime, p0 = this.pia0, p1 = this.pia1;
    const before = g.irq | (g.firq << 6) | ((g.regs[0] & 0x30) << 8) |
      (p0.irqA() << 14) | (p0.irqB() << 15) | (p1.irqA() << 16) | (p1.irqB() << 17);
    const due = g.timerDue;
    const r = fn();
    const after = g.irq | (g.firq << 6) | ((g.regs[0] & 0x30) << 8) |
      (p0.irqA() << 14) | (p0.irqB() << 15) | (p1.irqA() << 16) | (p1.irqB() << 17);
    if (before !== after || (g.timerDue !== due && g.timerDue < this.nextEventAt())) {
      // (the slice ends after a read cycle but at the start of a write cycle, as observed in MAME)
      this.sliceStart = this.accessStart() + (isWrite ? 0 : this.div);
      // a synchronisation also ends a slice that overran its events (see clockChanged)
      if (this.holdUntil > this.sliceStart) this.holdUntil = this.sliceStart;
    }
    return r;
  }
  processEventsMame(t) {
    if (t < this.holdUntil + this.div - 1) return;
    const q = this.queue;
    while (q.length && q[0].at <= t) {
      const e = q.shift();
      // the CPU stopped on its cycle grid at or before the event
      this.sliceStart = this.cycle + Math.floor((e.at - this.cycle) / this.div) * this.div;
      this.fireEvent(e);
    }
  }
  // write a CPU address under the current mapping (into RAM even where ROM is mapped)
  poke(addr, v) {
    addr &= 0xFFFF;
    if (addr >= 0xFF00) return false;
    let p = this.gime.physAddr(addr);
    if (p < 0) p = ((this.gime.blockFor(addr >> 13) * 0x2000) + (addr & 0x1FFF)) & (this.mem.length - 1);
    this.mem[p] = v;
    return this.writeKind(addr) === null;   // landed = the CPU sees it (a write under the ROM went to the RAM beneath)
  }

  // ---------------- time line ----------------
  // Video timing: HS rises at the start of each line and falls HS_FALL clocks later; each rise
  // schedules the line's fall and the next rise.
  startTimeline(hard) {
    // power-on: the field begins with scanline 0 at the timing origin, whose rise is not delivered
    if (hard) { this.schedule(this.frameBase + HS_FALL, 'fall', null, 0); this.schedule(this.frameBase + LINE, 'rise', null, 0); }
    else this.schedule(this.frameBase, 'rise', null, 0);
  }
  hsRiseEvent(at) {
    if (this.gime.hsRise()) this.pia0.setC1('a', true);
    // CART tied to Q (MAME's model of it, under mameCompat, is the slot's twiddleQ on PIA1 writes)
    if (this.cartPort && this.cartPort.cartLineFollowsQ && !this.config.mameCompat) {
      const q = (this.gime.physical & 1) === 0;
      this.pia1.setC1('b', q);
      this.gime.setInput(GIME.INT.EI0, q);
    }
    this.schedule(at + HS_FALL, 'fall', null, 0);
    this.schedule(at + LINE, 'rise', null, 0);
  }
  hsFallEvent() {
    const fs = this.gime.fsNext;
    if (this.gime.hsFall()) this.pia0.setC1('a', false);
    if (fs !== null) this.pia0.setC1('b', fs);
  }
  runCycles(end, steps = Infinity) {
    const cpu = this.cpu, hooks = this.pcHooks, g = this.gime;
    const stub = this.useStub;
    while (this.cycle < end && !this.stall && steps-- > 0) {
      this.processEvents(justUnder(this.cycle + this.div));
      if (stub && cpu.pc >= 0x8000 && cpu.pc < 0xFF00 && g.wr[cpu.pc >> 13] === g.sink) {
        const hook = hooks.get(cpu.pc);
        if (hook && cpu.willExecute()) hook();
      }
      cpu.c = 0;
      this.instrPc = cpu.pc;
      const div = this.div;
      this.speedChange = -1;
      const start = this.cycle;
      this.inStep = true;
      const n = cpu.step();
      this.inStep = false;
      this.stepS = start; this.stepN = n;
      if (this.haltAt >= 0) this.haltArrived();     // HALT came during this step's I/O
      if (this.speedChange < 0) { this.cycle += n * div; continue; }
      this.clockChanged(start, n, div);
    }
  }
  // The CPU clock rate changed during the instruction that started at `start` (n cycles; the
  // write was in cycle speedChange). On real hardware the remaining cycles simply run at the
  // new rate. MAME instead converts every cycle the CPU has run in the current scheduler slice
  // at the new rate, so the CPU's position on the time line jumps by (old - new) clocks per
  // cycle run since the slice started; when slowing down, the slice (sized in fast cycles)
  // also overruns the next event, which is only seen once the slice's cycle budget is spent.
  // config.mameCompat reproduces this artefact so that traces compare cycle for cycle.
  clockChanged(start, n, div) {
    const nd = this.gime.fast ? 2 : 4, m = this.speedChange;
    let t = start + m * div;                     // end of the write cycle
    if (this.config.mameCompat && nd !== div) {
      const S = this.sliceStart;
      const k = Math.max(0, Math.round((t - S) / div));
      t = S + k * nd;
      if (nd > div && this.queue.length) {
        const te = this.queue[0].at;
        if (te > S) this.holdUntil = S + Math.floor((te - S) / div) * nd;
      }
    }
    this.cycle = t + (n - m) * nd;
    this.div = nd;
  }

  // HALT arriving at a check point inside an instruction suspends MAME's 6809 there (device_execute_interface::
  // suspend with eatcycles): its clock goes on in whole cycles from that point, and once HALT is released the rest
  // of the instruction runs. Our 6809 completes the instruction first; cpu.haltTail adds the cycles that make the
  // next instruction start where MAME's does (the SAM machines' model, js/machines/sam.js haltChanged). MAME stops
  // at the first check point ('@' in m6809.lst; cpu.cycleNoStop marks cycles without one) once the whole cycles
  // up to the event are spent. config.mameCompat only: the real 6809 finishes the instruction before it halts
  // (MC6809E data sheet, HALT: "the processor will halt at the end of the current instruction").
  fireEvent(e) {
    const was = this.cpu.haltLine;
    super.fireEvent(e);
    if (!this.config.mameCompat || was === this.cpu.haltLine) return;
    if (this.cpu.haltLine) { this.haltAt = e.at; this.haltS = -1; if (!this.inStep) this.haltArrived(); }
    else { this.haltAt = -1; if (this.haltS >= 0) this.haltReleased(e.at); }
  }
  // HALT asserted at tick haltAt: inside the step that just ran (stepS, stepN)?
  haltArrived() {
    const at = this.haltAt, s = this.stepS, n = this.stepN, div = this.div, ns = this.cpu.cycleNoStop;
    this.haltAt = -1;
    if (!(at > s && at < s + n * div)) return;
    for (let k = Math.max(1, Math.floor((at - s) / div)); k < n; k++) {
      if (!ns[k - 1]) { this.haltS = s; this.haltK = k; this.haltN = n; return; }
    }
  }
  // released at tick at (before the step starting at this.cycle): the rest of the suspended instruction
  haltReleased(at) {
    const div = this.div, next = Math.floor((at - this.haltS) / div) + this.haltN - this.haltK;
    this.cpu.haltTail = Math.max(0, next - Math.round((this.cycle - this.haltS) / div));
    this.haltS = -1;
  }

  // ---------------- reset ----------------
  resetHardware(hard) {
    // power-on RAM contents are undefined on real hardware; MAME fills with $FF, so do we
    if (hard) { this.mem.fill(0xFF); this.gime.powerOn(); } else this.gime.reset();
    this.div = 4;
    this.pia0.reset(); this.pia1.reset();
    // PIA1 CA1 is the serial port's carrier detect, driven by the device from reset (low from the printer or a
    // terminal), as on the CoCo 1/2
    this.pia1.a.c1 = true; this.pia1.setC1('a', !!this.bitBanger.dcd);
    this.kbIrqLevel = false;
  }
  reset(hard) {
    super.reset(hard);
    if (hard) this.holdUntil = -Infinity;
  }

  // ---------------- state ----------------
  memoryArray() { return this.mem; }
  saveState() {
    return Object.assign(super.saveState(), state.save(this, Coco3Machine.STATE), {
      gime: this.gime.saveState(), pia0: this.pia0.saveState(), pia1: this.pia1.saveState(),
      hires: Object.assign({}, this.hires.jet),   // the Hi-Res interface's one-shot (js/machines/cocopia.js)
      stepNoStop: Array.from(this.cpu.cycleNoStop.subarray(0, this.stepN)),   // the last step's check points (haltArrived)
    });
  }
  loadState(s) {
    super.loadState(s);
    state.load(this, s, Coco3Machine.STATE);
    this.gime.loadState(s.gime); this.pia0.loadState(s.pia0); this.pia1.loadState(s.pia1);
    if (!s.hires) throw new Error('snapshot: missing "hires"');
    Object.assign(this.hires.jet, s.hires);
    if (!s.stepNoStop) throw new Error('snapshot: missing "stepNoStop"');
    this.cpu.cycleNoStop.set(s.stepNoStop);
    this.gime.updateMemory();
    this.timerEvent = this.queue.find((e) => e.name === 'timer') || null;  // re-link the pending timer
  }

  // ---------------- stub firmware ----------------
  stubInit() {
    const w = (a, v) => this.write(a, v);
    // GIME: CoCo compatible, MMU on, constant $FExx page, 32K internal ROM; task 0 = blocks $38-$3F
    for (let i = 0; i < 8; i++) { w(0xFFA0 + i, 0x38 + i); w(0xFFA8 + i, 0x38 + i); }
    w(0xFF90, 0xCE); w(0xFF91, 0x00); w(0xFF92, 0x00); w(0xFF93, 0x00);
    w(0xFF98, 0x00); w(0xFF99, 0x00); w(0xFF9A, 0x00); w(0xFF9C, 0x0F);
    w(0xFF9D, 0xE0); w(0xFF9E, 0x00); w(0xFF9F, 0x00);
    COMPAT_PALETTE.forEach((c, i) => w(0xFFB0 + i, c));
    w(0xFF01, 0x00); w(0xFF00, 0x00); w(0xFF01, 0x34);
    w(0xFF03, 0x00); w(0xFF02, 0xFF); w(0xFF03, 0x35);   // FS IRQ enabled
    w(0xFF21, 0x00); w(0xFF20, 0xFE); w(0xFF21, 0x34);   // motor off
    w(0xFF23, 0x00); w(0xFF22, 0xFE); w(0xFF23, 0x3C);   // sound enabled
    w(0xFF20, 0x80); w(0xFF22, 0x04);                    // DAC mid, text mode
    for (let b = 0; b < 7; b++) w(0xFFC6 + b * 2 + (b === 1 ? 1 : 0), 0);  // SAM F = 2: text at $0400
    // secondary vectors at $FEEE..$FEFD jump to the CoCo 1/2 RAM vectors at $0100..$010F
    const pv = [0x0100, 0x0103, 0x010F, 0x010C, 0x0106, 0x0109];
    pv.forEach((dst, i) => { const a = 0xFEEE + i * 3; this.poke(a, 0x7E); this.poke(a + 1, dst >> 8); this.poke(a + 2, dst & 0xFF); });
    const ram = this.ram;
    for (const a of [0x100, 0x103, 0x106, 0x109]) ram[a] = 0x3B;  // RTI
    const irq = STUB.symbols.get('IRQ'), firq = STUB.symbols.get('FIRQ');
    ram.set([0x7E, irq >> 8, irq & 0xFF], 0x10C);
    ram.set([0x7E, firq >> 8, firq & 0xFF], 0x10F);
    this.cpu.s = 0x03D0; this.cpu.nmiArmed = true;
    this.cpu.cc = 0x40; // FIRQ masked, IRQ enabled
    this.stubConsole.print('\f' + banner(this.profile.name, 'DROP A BINARY (.BIN .CAS .ROM)').replace('ROMS', 'ROM'));
  }

  // ---------------- video ----------------
  render() { return this.gime.frame; }
}

// saved in snapshots: the CPU's clock division and the clock-change model's slice (see clockChanged)
Coco3Machine.STATE = ['div', 'holdUntil', 'sliceStart', 'speedChange', 'kbIrqLevel', 'instrPc', 'stepS', 'stepN', 'haltAt', 'haltS', 'haltK', 'haltN'];

export { Coco3Machine };
