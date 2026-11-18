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
// thrown out of the CPU's step when HALT holds an instruction past the end of the run (Coco3Machine.haltSuspend)
const SUSPEND = Object.freeze({ suspended: 'halt' });
// thrown out of the CPU's step when a suspended instruction, run again, doesn't make the accesses it logged (only a
// malformed snapshot can cause it: Coco3Machine.replayRead)
const REPLAY_MISMATCH = Object.freeze({ replay: 'mismatch' });

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
    this.haltDefer = null;   // an I/O access waiting for HALT to be released (haltWait); between steps, the suspended
                             // instruction (haltSuspend)
    this.ioShift = 0;        // ticks the rest of a step runs later than its start says (the wait in haltWait)
    // every bus access of the step so far, in order (busLogged): its address and the byte read or written. A step run
    // again after HALT suspended it gets its first replayN accesses from here (replayRead), not from the bus.
    this.busA = new Int32Array(256); this.busV = new Uint8Array(256); this.busN = 0;
    this.busAt = 0;          // the next access of a step run again
    this.replayN = -1;       // how many of its accesses are replayed (-1: not replaying)
    this.waitLimit = Infinity; // haltWait waits no later than this tick (the end of the run: runCycles)
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
  // The cartridge slot runs on the driver's clock (coco3.cpp: XTAL / 32, COCOCART_SLOT DERIVED_CLOCK(1, 1)).
  // Its line delays count that clock (HALT 6, NMI 12: js/machines/bus.js), and the SAM's speed change sets the
  // driver's clock (6883sam.cpp
  // update_cpu_clock: m_cpu->owner()->set_unscaled_clock), so at 1.78 MHz the delays are half as long.
  get slotHz() { return this.masterHz / (this.gime.fast ? 16 : 32); }
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
  // A step logs every bus access it makes (busLogged). A step run again after HALT suspended it (haltSuspend) replays
  // the accesses it had made before its held one (replayRead, replayWrite): each read returns the byte it returned
  // then, each write is not made again. Once is all the hardware saw, and the bytes read are the ones read then, not
  // memory as the instruction itself has changed it since (a 6309 TFM whose source overlaps its destination).
  read(a) {
    if (this.inStep) {
      if (this.replayN >= 0) return this.replayRead(a);
      const v = this.busRead(a);
      this.busLogged(a, v);
      return v;
    }
    return this.busRead(a);
  }
  busRead(a) {
    if (a < 0xFF00) return this.gime.read(a);
    // $FFE0-$FFFF always come from the last 32 bytes of the internal ROM (as MAME maps them)
    if (a >= 0xFFE0) return this.romImage()[0x7FE0 + (a & 0x1F)];
    return this.ioRead(a);
  }
  busLogged(a, v) {
    const n = this.busN;
    if (n === this.busA.length) {          // (a long 6309 TFM: the log grows, keeping what it holds)
      const A = new Int32Array(2 * n), V = new Uint8Array(2 * n);
      A.set(this.busA); V.set(this.busV); this.busA = A; this.busV = V;
    }
    this.busA[n] = a; this.busV[n] = v; this.busN = n + 1;
  }
  replayRead(a) {
    const i = this.busAt;
    if (i < this.replayN) {
      if (this.busA[i] !== a) throw REPLAY_MISMATCH;
      this.busAt = i + 1;
      return this.busV[i];
    }
    this.replayEnd(a);
    const v = this.busRead(a);
    this.busLogged(a, v);
    return v;
  }
  // -> true when the write was made before the step was suspended (replayed: not made again)
  replayWrite(a, v) {
    const i = this.busAt;
    if (i < this.replayN) {
      if (this.busA[i] !== a || this.busV[i] !== (v & 0xFF)) throw REPLAY_MISMATCH;
      this.busAt = i + 1;
      return true;
    }
    this.replayEnd(a);
    return false;
  }
  // the first access after the replayed ones is the held one: an I/O access in the bus cycle it was held in
  replayEnd(a) {
    if (a < 0xFF00 || a >= 0xFFE0 || this.cpu.cycleCount !== this.haltDefer.n) throw REPLAY_MISMATCH;
    this.replayN = -1;
  }
  ioRead(a) {
    this.ioSync();
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
    if (this.inStep) {
      if (this.replayN >= 0 && this.replayWrite(a, v)) return;   // made before the step was suspended (read())
      this.busWrite(a, v);
      this.busLogged(a, v & 0xFF);
    } else this.busWrite(a, v);
  }
  busWrite(a, v) {
    if (a < 0xFF00) { this.gime.write(a, v); return; }
    if (a >= 0xFFE0) return;
    this.ioWrite(a, v);
  }
  ioWrite(a, v) {
    this.ioSync();
    const t = this.ioTime();
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
    this.syncIo(() => {
      if (!this.gime.writeReg(a, v, t)) return;
      // A program's write is timed by clockChanged (the instruction's remaining cycles run at the new rate, with
      // MAME's slice model under mameCompat). A write from outside the CPU (the debugger's memory write) has no
      // instruction in flight: no cycle count to convert, so the divider takes the new rate directly and the next
      // instruction starts at it. (A tool poke goes through machine.poke, which skips the I/O page.)
      // An instruction HALT suspended (haltDefer) is timed on the old rate's grid; it is dropped first (haltCancel, as
      // for any change from outside while it waits: its halted time counts at the old rate), so the CPU, between
      // instructions, then runs at the new one.
      if (this.inStep) this.speedChange = this.cpu.cycleCount;
      else { this.haltCancel(!this.gime.fast); this.div = this.gime.fast ? 2 : 4; }   // (the rate before this write)
    }, true);
  }

  // ---------------- time line ----------------
  // Visibility rule (as in MAME's cycle-stepped 6809): an event at time T is seen by a bus
  // access whose cycle starts at a if T < a + (clocks per cycle); interrupts are sampled at
  // the start of an instruction by the same rule.
  ioTime() { return this.cycle + this.ioShift + Math.max(1, this.cpu.cycleCount) * this.div - 1; }
  clockUnits() { return super.clockUnits() - (this.config.mameCompat ? MAME_TIME_LAG : 0); }
  // Start of the current access cycle (the CPU counts the cycles of the instruction so far).
  accessStart() { return this.cycle + this.ioShift + Math.max(0, this.cpu.cycleCount - 1) * this.div; }

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
      // the wait of an instruction HALT suspended (haltSuspend): no further than this run goes, or else a frame
      this.waitLimit = Number.isFinite(end) ? end : Math.max(this.frameBase + this.frameCycles, this.cycle + this.div);
      // (the CPU's registers changed from outside since the instruction was suspended: it is dropped, haltCancel)
      this.cpuCheck();
      const resumed = this.haltDefer;
      if (resumed) {
        if (!this.haltResume()) continue;         // still halted: the time moved on to the limit
      } else {
        // the rest of a suspended instruction's wait (haltReleased: cpu.haltTail, one halted cycle a step) can be
        // seconds long; up to the next event and the end of the run nothing happens in it, so it goes at once (in a
        // debugger's single step too: no instruction runs in it, so there is nothing to stop at)
        if (cpu.haltTail > 1 && !cpu.haltLine) {
          const lim = Math.min(cpu.haltTail - 1, Math.floor((Math.min(end, this.nextEventAt()) - this.cycle) / this.div) - 1);
          if (lim > 0) { cpu.haltTail -= lim; cpu.totalCycles += lim; this.cycle += lim * this.div; }
        }
        this.processEvents(justUnder(this.cycle + this.div));
        if (stub && cpu.pc >= 0x8000 && cpu.pc < 0xFF00 && g.wr[cpu.pc >> 13] === g.sink) {
          const hook = hooks.get(cpu.pc);
          if (hook && cpu.willExecute()) hook();
        }
      }
      cpu.c = 0;
      this.instrPc = cpu.pc;
      const div = this.div;
      this.speedChange = resumed ? resumed.speedChange : -1;
      const start = this.cycle;
      let n;
      this.inStep = true;
      if (resumed) {
        // the suspended instruction again from its start (cpu.rerun): its bus accesses before the held one are
        // replayed (read), not made again
        try { n = cpu.rerun(); } catch (e) {
          if (e !== REPLAY_MISMATCH) throw e;
          n = -1;
        } finally { this.inStep = false; }
        if (n < 0 || this.replayN >= 0) { this.replayDropped(resumed, Math.max(0, n)); continue; }
      } else {
        this.busN = 0;
        cpu.mark();
        try { n = cpu.step(); } catch (e) {
          this.inStep = false;
          if (e !== SUSPEND) throw e;
          cpu.rewind();
          this.haltKeep(this.haltDefer);              // the registers and memory it waits with (cpuCheck)
          continue;
        }
        this.inStep = false;
      }
      this.stepS = start; this.stepN = n;
      if (this.haltAt >= 0) this.haltArrived();     // HALT came during this step's I/O
      const defer = this.haltDefer;
      this.haltDefer = null;
      this.ioShift = 0;
      if (this.speedChange < 0) this.cycle += n * div; else this.clockChanged(start, n, div);
      // an access in this step waited for HALT's release (haltWait): the rest of the instruction runs from there
      if (defer) { this.haltS = defer.s; this.haltK = defer.k; this.haltN = n; this.haltReleased(defer.rel); }
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
  // next instruction start where MAME's does (the SAM machines' model, js/machines/sam.js haltChanged), and an I/O
  // access after the stop point waits for the release (haltWait). MAME stops at the first check point ('@' in
  // m6809.lst; cpu.cycleNoStop marks cycles without one) once the whole cycles up to the event are spent.
  // In both modes, not only under config.mameCompat: the cartridge slot delays HALT (6 slot cycles, MAME's coco.cpp),
  // and that delay with a 6809 that finishes each instruction first (MC6809E data sheet: "the processor will halt at
  // the end of the current instruction") reads a halted transfer's data register before its DRQ. NitrOS-9's floppy
  // booter (boot_1773.asm) then reads every byte twice at 1.78 MHz and LSN 0 one byte off at 0.89 MHz. MAME's
  // pairing of the delay with the suspension is the one compared (run.js coco3 --fdc cocofdc --halt).
  fireEvent(e) {
    const was = this.cpu.haltLine;
    super.fireEvent(e);
    if (was === this.cpu.haltLine) return;
    if (this.cpu.haltLine) { this.haltAt = e.at; this.haltS = -1; if (!this.inStep) this.haltArrived(); }
    else { this.haltAt = -1; if (this.haltDefer) this.haltDefer.rel = e.at; else if (this.haltS >= 0) this.haltReleased(e.at); }
  }
  // An I/O access in an instruction that HALT suspended at an earlier check point: MAME's 6809 makes the access
  // only once HALT is released, so it reads (or writes) the device as it is then. A disk controller's halted
  // read loop depends on it: HALT, delayed by the cartridge slot, often arrives inside the LDA of the next byte,
  // before its read cycle. The machine's events run on until the release (haltDefer.rel), then up to the
  // access's own time; runCycles charges the rest of the instruction from the release (haltReleased).
  //
  // The wait goes no further than the run does (waitLimit: the end of the frame, or of the slice runCycles was
  // given). If HALT is still asserted there - a read sector on an empty drive never brings its DRQ - the
  // instruction is suspended (haltSuspend) and the frame ends; the machine's time, video and events run on,
  // frame after frame, while the CPU waits (haltResume).
  ioSync() {
    const d = this.haltDefer;
    if (d && d.resume) { d.resume = false; this.haltFinish(d); return; }   // the held access of a resumed step
    this.processEvents(justUnder(this.ioTime() + 1));
    this.haltWait();
  }
  haltWait() {
    // (only in an instruction: an interrupt's entry, which reaches I/O only with S in the I/O page, isn't held)
    if (this.haltAt < 0 || !this.inStep || this.haltDefer || !this.cpu.executing) return;
    const s = this.cycle, div = this.div, ns = this.cpu.cycleNoStop, cur = this.cpu.cycleCount - 1;
    let k = -1;
    for (let i = Math.max(1, Math.floor((this.haltAt - s) / div)); i <= cur; i++) if (!ns[i - 1]) { k = i; break; }
    if (k < 0) return;                            // no check point before this access: it happens now
    this.haltAt = -1;
    const d = this.haltDefer = { s, k, rel: -1, n: this.cpu.cycleCount, speedChange: this.speedChange, log: null, resume: false, regs: null, mem: null };
    if (this.haltRun(d)) this.haltFinish(d);
    else this.haltSuspend(d);
  }
  // the machine's events up to HALT's release, or to waitLimit -> false when HALT is still asserted there
  haltRun(d) {
    const q = this.queue, limit = this.waitLimit;
    while (this.cpu.haltLine && q.length && q[0].at < limit) {
      const before = q[0];
      this.processEvents(q[0].at);
      if (q[0] === before) return true;           // (nothing more can run: the access goes ahead)
    }
    return !(this.cpu.haltLine && q.length);
  }
  // the rest of the instruction, the held access included, runs from the release (on the cycle grid, as haltReleased)
  haltFinish(d) {
    if (d.rel < 0) return;
    this.ioShift = (Math.floor((d.rel - d.s) / this.div) - d.k) * this.div;
    this.processEvents(justUnder(this.ioTime() + 1));
  }
  // HALT still asserted at waitLimit: the step is abandoned (runCycles rewinds the CPU to the instruction's start)
  // and kept in haltDefer with the bus accesses it made before the held one (its log); the time moves on.
  haltSuspend(d) {
    d.log = [];
    for (let i = 0; i < this.busN; i++) d.log.push(this.busA[i], this.busV[i]);
    this.haltPark(d);
    throw SUSPEND;
  }
  // the time moves on to waitLimit (on the instruction's cycle grid). Between runs no instruction is under way: the
  // CPU's cycle count is 0, so an access from outside (the debugger, a loaded file's restore) is timed at the machine's
  // time, not the held access's, however long the instruction (a 6309 TFM's count reaches 196,611)
  haltPark(d) {
    const div = this.div;
    this.cycle = Math.max(this.cycle, d.s + Math.ceil((this.waitLimit - d.s) / div) * div);
    this.ioShift = 0;
    this.cpu.cycleCount = 0;
  }
  // a suspended instruction's wait goes on -> true when it can run again (HALT released, or nothing left to run).
  // While its events run, ioTime() is the held access's, as in haltWait (the CPU's cycleCount at the access, ioShift
  // back to the instruction's start); between runs it is the machine's time, for an access from outside the CPU.
  haltResume() {
    const d = this.haltDefer;
    if (d.rel < 0) {
      this.cpu.cycleCount = d.n; this.ioShift = d.s - this.cycle;
      const go = this.haltRun(d);
      this.ioShift = 0;
      if (!go) { this.haltPark(d); return false; }
      // HALT dropped outside an event (the cartridge taken out: its lines go at once, js/machines/bus.js detach):
      // released now, where the time has got to, not at the instruction's start
      if (d.rel < 0 && !this.cpu.haltLine) d.rel = this.cycle;
    }
    // run again from its start, as when it was suspended, its accesses so far replayed
    d.now = this.cycle;
    this.cycle = d.s; this.ioShift = 0;
    this.busN = 0;
    for (let i = 0; i < d.log.length; i += 2) this.busLogged(d.log[i], d.log[i + 1]);
    this.busAt = 0; this.replayN = this.busN;
    d.resume = true;
    return true;
  }
  // The CPU redirected from outside while an instruction is suspended: a jump or a loader (Machine.jump,
  // injectAndRun), the debugger setting a register, any write to the CPU's registers or to memory the instruction had
  // fetched, read or written before its held access (cpuCheck sees those at the next run, debugger check or snapshot).
  // The suspended instruction is dropped: the CPU is between instructions with the state it
  // was given, still halted while HALT is asserted, and runs from that state once HALT is released.
  // Source: the MC6809E data sheet (Motorola, MC6809E/D, "HALT" under the signal descriptions; page not cited, no copy
  // could be reached when this was written): HALT stops the processor "at the end of the present instruction" and it
  // remains halted "without loss of data", so on the hardware an outside change can only meet it between instructions. Our
  // suspended instruction has changed no register yet (cpu.rewind), so dropping it puts the CPU exactly there. The
  // bus accesses it made before its held one were made, and stay made. (MAME 0.264's debugger, writing PC, only sets
  // m_pc: its 6809 carries on through the rest of the old instruction's microcode from the new address,
  // m6809.cpp state_import; an artefact of the emulator with no hardware counterpart, not reproduced.)
  // (`fast`: the GIME's rate while the instruction waited; an outside speed write that drops it passes the rate before it)
  haltCancel(fast = this.gime.fast) {
    const d = this.haltDefer;
    if (!d || this.inStep) return;
    this.haltDefer = null; this.busN = 0; this.replayN = -1; this.ioShift = 0; this.haltS = -1;
    // the CPU has been halted from the instruction's start to now: those cycles count (as haltTail charges them for an
    // instruction that is kept), at the rate it ran, and after a speed change it made before its held access (in the
    // GIME already: the clock follows it) at the new rate from the end of that write's cycle (as clockChanged)
    let t = d.s, n = 0;
    if (d.speedChange >= 0) { n = d.speedChange; t = d.s + n * this.div; this.div = fast ? 2 : 4; }
    this.cpu.totalCycles += n + Math.max(0, Math.round((this.cycle - t) / this.div));
    this.redirects++;
  }
  cpuRedirected() { super.cpuRedirected(); this.haltCancel(); }
  // A suspended instruction run again that did not make the accesses it logged, or did not reach its held one (a
  // snapshot whose log doesn't belong to its instruction: replayRead). None of its accesses reached the bus, so it is
  // dropped as for a redirect (haltCancel): the CPU is between instructions where HALT's release found it, and runs
  // the instruction afresh.
  // (`ran`: the cycles the CPU counted if the replay ran the instruction to its end, the log holding all its accesses)
  replayDropped(d, ran) {
    this.replayN = -1;
    this.cpu.rewind();
    this.cpu.totalCycles -= ran;
    this.cycle = d.now;
    this.haltCancel();
  }
  get cpuHeld() { return this.haltDefer !== null && !this.inStep; }
  // what the suspended instruction waits with: the registers (cpu.mark; the 6309's too) and, as memory holds them now,
  // the bytes below the I/O page of every bus access it made (its log: its code, operands, stack, reads and writes;
  // not its idle cycles, which access nothing). The snapshot keeps the bytes (haltDefer.mem); a loaded file's
  // registers are its CPU's (mem: false).
  haltKeep(d, mem = true) {
    const cpu = this.cpu;
    cpu.mark();
    d.regs = Array.from(cpu.pre);
    if (!mem) return;
    const m = [];
    for (let i = 0; i < d.log.length; i += 2) { const a = d.log[i]; if (a < 0xFF00) m.push(a, this.peek(a)); }
    d.mem = m;
  }
  // an instruction suspended with registers or memory changed since (from outside: nothing else runs) is dropped
  cpuCheck() {
    const d = this.haltDefer;
    if (!d || this.inStep || !d.regs) return;
    this.cpu.mark();
    const p = this.cpu.pre, r = d.regs, mem = d.mem;
    let same = true;
    for (let i = 0; i < r.length && same; i++) if (p[i] !== r[i]) same = false;
    for (let i = 0; i < mem.length && same; i += 2) if (this.peek(mem[i]) !== mem[i + 1]) same = false;
    if (!same) this.haltCancel();
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
    // an instruction HALT had suspended is gone with the reset (the CPU starts again from the reset vector), and
    // so is the rest of a halted instruction's wait
    this.haltDefer = null; this.ioShift = 0; this.busN = 0; this.replayN = -1;
    this.haltAt = -1; this.haltS = -1; this.cpu.haltTail = 0;
    if (hard) this.holdUntil = -Infinity;
  }

  // ---------------- state ----------------
  memoryArray() { return this.mem; }
  saveState() {
    this.cpuCheck();   // (as the next run would: not saved stale)
    return Object.assign(super.saveState(), state.save(this, Coco3Machine.STATE), {
      gime: this.gime.saveState(), pia0: this.pia0.saveState(), pia1: this.pia1.saveState(),
      hires: Object.assign({}, this.hires.jet),   // the Hi-Res interface's one-shot (js/machines/cocopia.js)
      stepNoStop: Array.from(this.cpu.cycleNoStop.subarray(0, this.stepN)),   // the last step's check points (haltArrived)
      haltDefer: this.haltDefer && haltDeferState(this.haltDefer),   // the instruction HALT suspended (haltSuspend), or null
    });
  }
  loadState(s) {
    super.loadState(s);
    state.load(this, s, Coco3Machine.STATE);
    this.gime.loadState(s.gime); this.pia0.loadState(s.pia0); this.pia1.loadState(s.pia1);
    if (!s.hires) throw new Error('snapshot: missing "hires"');
    Object.assign(this.hires.jet, s.hires);
    if (!s.stepNoStop) throw new Error('snapshot: missing "stepNoStop"');
    // (no step is longer than the longest 6309 TFM: 6 + 3 x 65535 cycles, and a native-mode slack)
    if (!Array.isArray(s.stepNoStop) || s.stepNoStop.length > 6 + 3 * 0xFFFF + 8 || s.stepNoStop.some((v) => v !== 0 && v !== 1)) {
      throw new Error('snapshot: "stepNoStop" is not a list of 0 and 1 the length of a step');
    }
    this.cpu.reserveLog(s.stepNoStop.length);
    this.cpu.cycleNoStop.set(s.stepNoStop);
    // (a file from version 1 has no key: no instruction is suspended in it, as nothing suspended one then)
    if (!('haltDefer' in s) && this.restoringVersion >= 2) throw new Error('snapshot: missing "haltDefer"');
    const d = s.haltDefer || null;
    this.haltDefer = d && haltDeferState(d);
    if (this.haltDefer) { haltDeferTimes(this.haltDefer, this.cycle); this.cpu.cycleCount = 0; }   // (as haltPark)
    if (this.haltDefer) this.haltKeep(this.haltDefer, false);   // (the file's CPU; its memory came with haltDefer)
    // Between instructions the divider follows gime.fast, so derive it here: a snapshot saved while an outside write
    // left the divider at 4 restores at the rate the GIME says, instead of staying slow for good (a later write of the
    // same rate does not re-time). The one exception is an instruction HALT suspended after it changed the speed
    // (haltDefer.speedChange): it runs on at the saved, old divider and clockChanged moves to the new one, so the
    // file's divider stands.
    if (!(this.haltDefer && this.haltDefer.speedChange >= 0)) this.div = this.gime.fast ? 2 : 4;
    this.busN = 0; this.replayN = -1;
    this.ioShift = 0;
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

// the suspended instruction in a snapshot: where it started (s), its stop point (k), its held access (n), HALT's
// release (rel, -1 while waiting), the speed change it made before (speedChange), its bus accesses so far, address and
// byte (log: replayed when it runs again; one that doesn't match the instruction drops it, replayDropped) and the memory
// they touched below the I/O page, address and byte as it was when suspended (mem: the log's addresses there, in order;
// an outside change to a byte drops the instruction, cpuCheck)
function haltDeferState(d) {
  for (const k of ['s', 'k', 'rel', 'n', 'speedChange']) if (typeof d[k] !== 'number') throw new Error(`snapshot: "haltDefer.${k}" is not a number`);
  const pairs = (l, top) => Array.isArray(l) && l.length % 2 === 0 && l.every((v, i) => Number.isInteger(v) && v >= 0 && v <= (i % 2 ? 0xFF : top));
  if (!pairs(d.log, 0xFFFF)) throw new Error('snapshot: "haltDefer.log" is not a list of address, byte pairs');
  if (!pairs(d.mem, 0xFEFF)) throw new Error('snapshot: "haltDefer.mem" is not a list of address, byte pairs');
  const touched = d.log.filter((v, i) => i % 2 === 0 && v < 0xFF00);
  if (touched.length * 2 !== d.mem.length || touched.some((a, i) => d.mem[2 * i] !== a)) throw new Error('snapshot: "haltDefer.mem" is not the memory of "haltDefer.log"');
  return { s: d.s, k: d.k, rel: d.rel, n: d.n, speedChange: d.speedChange, log: d.log.slice(), resume: false, regs: null, mem: d.mem.slice() };
}

// a loaded suspended instruction's times, against the machine's (cycle): whole ticks; it started (s) no later than now;
// its held access (n, the CPU's cycle count at it) comes after its logged accesses, within the cycles they can take (a
// TFM takes 3 for 2 accesses), its stop point (k) before it and a speed change it made (speedChange, -1 for none) too;
// HALT's release (rel, -1 while waiting) between its start and the end of the CPU cycle under way now (an event's time:
// a released device's events need not fall on whole ticks; an access from outside while held sees events up to then,
// ioTime). Out of range they would run the machine's time
// far off (or the CPU's count), so the file is refused.
function haltDeferTimes(d, cycle) {
  const whole = (v) => Number.isSafeInteger(v);
  const accesses = d.log.length / 2;
  const bad = (what) => { throw new Error(`snapshot: "haltDefer.${what}" is out of range`); };
  if (!whole(d.s) || d.s < 0 || d.s > cycle) bad('s');
  if (!whole(d.n) || d.n < accesses + 1 || d.n > 2 * (accesses + 1) + 32) bad('n');
  if (!whole(d.k) || d.k < 1 || d.k > d.n) bad('k');
  if (!whole(d.speedChange) || d.speedChange < -1 || d.speedChange > d.n) bad('speedChange');
  if (!Number.isFinite(d.rel) || (d.rel !== -1 && (d.rel < d.s || d.rel >= cycle + 4))) bad('rel');
}

// saved in snapshots: the CPU's clock division and the clock-change model's slice (see clockChanged)
Coco3Machine.STATE = ['div', 'holdUntil', 'sliceStart', 'speedChange', 'kbIrqLevel', 'instrPc', 'stepS', 'stepN', 'haltAt', 'haltS', 'haltK', 'haltN'];

export { Coco3Machine };
