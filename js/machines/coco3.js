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
import { HaltReplay, SUSPEND, justUnder, haltDeferState, haltDeferTimes } from './halt-replay.js';

const LINE = 228, HS_FALL = 212;
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
    this.gime = new GIME({ ram: this.mem, pal, mameCompat: config.mameCompat, rom: () => this.romImage(), cart: () => (this.cartPort ? this.cartPort.rom() : null) });
    this.div = 4;                 // GIME clocks per CPU cycle
    this.instrPc = 0;
    this.speedChange = -1;
    // HALT inside an instruction (js/machines/halt-replay.js): where it arrived and was released in the last step, an
    // instruction it suspended and its bus log, and the writes from outside queued while one is held
    this.halting = false;    // the HaltReplay sees the CPU's bus accesses (its logBus, kept in step by it)
    this.halt = new HaltReplay(this);
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
  devicesAttached() {
    this.halt.busHalt = !!(this.cartPort && this.cartPort.canHalt);
  }
  // the Machine interface (js/machines/machine.js), answered by the HALT model: whether the access under way is a
  // replayed one (bustaps.js), whether an instruction is held (the debugger, writewatch.js), the check for an outside
  // change that drops it (the debugger), and the cycles of the last step proper (the profiler)
  replaying() { return this.halt.replaying(); }
  get cpuHeld() { return this.halt.haltDefer !== null && !this.inStep; }
  cpuCheck() { this.halt.cpuCheck(); }
  get stepN() { return this.halt.stepN; }
  // (read and write test one machine field, halting, that the HaltReplay keeps equal to its logBus whenever either of
  // the two fields it is made of changes, not the getter: the call on every access cost 5-6% with the controller
  // attached, where the log runs and every access pays it. An attach or a hold shows on the next access: a step never
  // spans an attach.)
  // A device asserting HALT without declaring Device.canHalt would suspend an instruction against a log that is not
  // carried: replay would have nothing to replay and the instruction would be dropped instead of run again. Checked
  // here so a device added later that drives the line and forgets its declaration fails at the first HALT rather
  // than silently losing replay. A line from a source that is not the attached device (a test or the debugger
  // calling setLine) is not a device's and is left alone.
  //
  // This is a programmer error, not a state a person can reach: a device here is only ever constructed by this
  // repository's own code (js/machines/*.js, the Session, the page), never from a cartridge image, a BASIC program,
  // a key or a snapshot. So there is deliberately no user-readable message; the page's frame loop has no catch and
  // it surfaces there as an uncaught error, which is the loud answer a bug deserves. The message names the device
  // for whoever adds the next one.
  setLine(source, line, level) {
    // (only the device in the port is a device's line: a test, a tool or a host hook calling setLine is not, and its
    // HALT takes effect between instructions - see fireEvent)
    if (line === 'halt' && level && this.cartPort && source === this.cartPort.id && !this.cartPort.canHalt) {
      throw new Error(`HALT: the ${this.cartPort.type} in the cartridge port asserts the line but does not declare ` +
        'Device.canHalt, so the CoCo 3\'s bus log (js/machines/halt-replay.js logBus) is not carried and an instruction ' +
        'HALT holds cannot be run again');
    }
    super.setLine(source, line, level);
  }
  // CART (cartridge pin 8) drives PIA1 CB1 and the GIME's EI0, as MAME's coco3_state::cart_w
  cartLineChanged(level) { this.pia1.setC1('b', level); this.gime.setInput(GIME.INT.EI0, level); }
  // The cartridge slot runs on the driver's clock (coco3.cpp: XTAL / 32, COCOCART_SLOT DERIVED_CLOCK(1, 1)).
  // Its line delays count that clock (HALT 6, NMI 12: js/machines/bus.js), and the SAM's speed change sets the
  // driver's clock (6883sam.cpp
  // update_cpu_clock: m_cpu->owner()->set_unscaled_clock), so at 1.78 MHz the delays are half as long.
  get slotHz() { return this.masterHz / (this.gime.fast ? 16 : 32); }
  // the cartridge port's clock is the normal-speed CPU clock whatever the GIME's rate (MAME's ext slot: 894.88 kHz)
  get cartClockHz() { return this.masterHz / 32; }
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
  // A step logs every bus access it makes (busLogged) while a HALT-capable device is attached (logBus). A step run
  // again after HALT suspended it (haltSuspend) replays the accesses it had made before its held one (replayRead,
  // replayWrite): each read returns the byte it returned then, each write is not made again. Once is all the hardware
  // saw, and the bytes read are the ones read then, not memory as the instruction itself has changed it since (a 6309
  // TFM whose source overlaps its destination).
  read(a) {
    // (halting: the HaltReplay's logBus, kept on the machine so that this test is one field)
    if (this.inStep && this.halting) {
      const h = this.halt;
      if (h.replayN >= 0) return h.replayRead(a);
      const v = this.busRead(a);
      h.busLogged(a, v);
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
      if (this.halting) {
        const h = this.halt;
        if (h.replayN >= 0 && h.replayWrite(a, v)) return;   // made before the step was suspended (read())
        this.busWrite(a, v);
        h.busLogged(a, v & 0xFF);
      } else this.busWrite(a, v);
      return;
    }
    // (while an access waits, a later one waits behind it: in order, never landing ahead of it and then being
    // overwritten by it)
    if (this.halt.heldIo || this.halt.outsideWrites.length) { this.halt.outsideWrite(a, v); return; }
    this.busWrite(a, v);
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
      const was = this.gime.fast;   // (a write to R0 with R1 set, or the reverse, is reported but leaves the rate)
      if (!this.gime.writeReg(a, v, t)) return;
      // A program's write is timed by clockChanged (the instruction's remaining cycles run at the new rate, with
      // MAME's slice model under mameCompat). A write from outside the CPU (the debugger's memory write) has no
      // instruction in flight: no cycle count to convert, so the divider takes the new rate directly and the next
      // instruction starts at it. (A tool poke goes through machine.poke, which skips the I/O page.)
      // An instruction HALT suspended (haltDefer) is timed on the old rate's grid; it is dropped first (haltCancel, as
      // for any change from outside while it waits: its halted time counts at the old rate), so the CPU, between
      // instructions, then runs at the new one. Deviation from MAME (docs/verification.md, "Deviations from MAME"):
      // MAME 0.264 carries the held instruction on at the new clock, while ours runs it again from its start, its bus
      // accesses before the held one made again; only the debugger can write while an instruction is held, so no
      // firmware can observe it.
      if (this.inStep) this.speedChange = this.cpu.cycleCount;
      else { this.halt.haltCancel(was); this.div = this.gime.fast ? 2 : 4; }
    }, true);
  }

  // ---------------- time line ----------------
  // Visibility rule (as in MAME's cycle-stepped 6809): an event at time T is seen by a bus
  // access whose cycle starts at a if T < a + (clocks per cycle); interrupts are sampled at
  // the start of an instruction by the same rule. Between instructions there is no access, and cycleCount holds
  // the last step's (see Machine.ioTime), so the answer is now(). heldIo is the one between-step state that keeps
  // the in-step form: a suspended instruction's events run with the held access's time (haltResume). A parked
  // instruction has cycleCount 0 and is not held, so it takes now() - note that the in-step form would NOT give
  // now() there, since Math.max(1, 0) * div - 1 is div - 1 clocks, not 0.
  ioTime() { const h = this.halt; return this.inStep || h.heldIo ? this.cycle + h.ioShift + Math.max(1, this.cpu.cycleCount) * this.div - 1 : this.cycle; }
  // exact time (Machine.clockUnits) with config.mameCompat: MAME's clocks. The CPU (DERIVED_CLOCK of
  // XTAL/32, 894886 Hz) spends 1e18/894886 as per cycle, 1e18/1789772 at the GIME's fast rate; a unit is a quarter
  // of the first, rounded down to 279365449 as (also exactly half of the second, rounded down), which runs 0.75 as
  // per tick short of MAME, 11 ps after 4 seconds. MAME's machine time counts 4 cycles before the first
  // instruction (as on the SAM machines, sam.js clockUnits), one fewer than our video origin (resetOffset 20 ticks).
  clockUnits() { return super.clockUnits() - (this.config.mameCompat ? MAME_TIME_LAG : 0); }
  // MAME's time 0, in ticks: MAME_TIME_LAG GIME clocks (one CPU cycle) after our frame origin, as clockUnits counts
  powerOnTick() { return super.powerOnTick() + (this.config.mameCompat ? MAME_TIME_LAG : 0); }
  // Start of the current access cycle (the CPU counts the cycles of the instruction so far). Between instructions
  // there is no cycle in progress, and cycleCount holds the last step's, so it is now (see Machine.ioTime): an
  // outside write through syncIoMame would otherwise end a slice a whole instruction past its access.
  accessStart() { const h = this.halt; return this.inStep || h.heldIo ? this.cycle + h.ioShift + Math.max(0, this.cpu.cycleCount - 1) * this.div : this.cycle; }

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
    // A poke writes the memory image with no bus cycle and no timing, so it lands at once - unless an outside
    // write is still waiting to land: then it waits behind it, so the order the tool made them in is the order
    // the machine sees, and the later call's value is the final one (a poke made after a queued write to the same
    // byte must not be overwritten by it). A poke made while the machine is stalled waits with the queue.
    if (this.halt.outsideWrites.length) { this.halt.outsideWrites.push({ a: addr, v: v & 0xFF, poke: true }); return this.writeKind(addr) === null; }
    return this.pokeNow(addr, v);
  }
  pokeNow(addr, v) {
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
    const cpu = this.cpu, hooks = this.pcHooks, g = this.gime, h = this.halt;
    const stub = this.useStub;
    while (this.cycle < end && !this.stall && steps-- > 0) {
      // a write from outside made while an instruction was held (outsideWrite): between instructions, at the
      // machine's own time, where an outside access lands (the call only when one is queued: it returns at once
      // otherwise, and this is every instruction)
      if (h.outsideWrites.length) h.flushOutsideWrites();
      if (this.stall) break;                      // a flushed write stalled the machine: nothing runs under it
      // the wait of an instruction HALT suspended (haltSuspend): no further than this run goes, or else a frame
      h.waitLimit = Number.isFinite(end) ? end : Math.max(this.frameBase + this.frameCycles, this.cycle + this.div);
      // (the CPU's registers changed from outside since the instruction was suspended: it is dropped, haltCancel;
      // asked only while one is suspended, which is all cpuCheck looks at)
      if (h.haltDefer !== null) h.cpuCheck();
      const resumed = h.haltDefer;
      if (resumed) {
        if (!h.haltResume()) continue;         // still halted: the time moved on to the limit
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
      // (a probe sees each instruction once: a suspended one already had its call when it first started)
      if (this.pcWatch !== null && !resumed) this.pcWatch(cpu.pc);
      cpu.c = 0;
      this.instrPc = cpu.pc;
      const div = this.div;
      this.speedChange = resumed ? resumed.speedChange : -1;
      const start = this.cycle;
      let n;
      this.inStep = true;
      if (resumed) {
        // the suspended instruction again from its start, its bus accesses before the held one replayed (HaltReplay.rerun;
        // -1: dropped, as a replay that doesn't match its log is)
        n = h.rerun(resumed);
        if (n < 0) continue;
      } else {
        h.busN = 0;
        cpu.mark();
        try { n = cpu.step(); } catch (e) {
          this.inStep = false;
          if (e !== SUSPEND) throw e;
          cpu.rewind();
          h.haltKeep(h.haltDefer);              // the registers and memory it waits with (cpuCheck)
          continue;
        }
        this.inStep = false;
      }
      h.stepS = start; h.stepN = n;
      if (h.haltAt >= 0) h.haltArrived();     // HALT came during this step's I/O
      const defer = h.haltDefer;
      if (defer !== null) h.haltDefer = null;   // (a setter: it keeps the machine's halting flag; most steps have none)
      h.ioShift = 0;
      if (this.speedChange < 0) this.cycle += n * div; else this.clockChanged(start, n, div);
      // an access in this step waited for HALT's release (haltWait): the rest of the instruction runs from there
      if (defer) { h.haltS = defer.s; h.haltK = defer.k; h.haltN = n; h.haltReleased(defer.rel); }
    }
    // a queued outside write is owed even to a run that ends here: the CPU is parked (no instruction to wait for),
    // and the next runCycles may be a long way off, or never
    h.flushOutsideWrites();
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
    // Only a device's HALT can fall inside an instruction and suspend it (its slot line has the 6-cycle delay; that
    // is what makes the disk controller's held transfer work). This branch is for a line with no log carried for it.
    // In shipped code that means a non-device source, and the only one is a test hook: the slot's line timer (a
    // SlotDevice's CartSlot) is the only event here that asserts HALT, and a device's own assertion either carries
    // the log (it declares canHalt) or is refused before it gets here (setLine). Such a line halts the CPU between
    // instructions: it clears haltAt and returns before haltArrived, so it also skips that function's
    // mid-instruction accounting (haltS, haltK, haltN - and with them what haltReleased charges as haltTail).
    // (Suspending an instruction against an empty log would drop it instead of replaying it;
    // tests/coco3-buslog.test.js.)
    if (this.cpu.haltLine && !this.halt.logBus) { this.halt.haltAt = -1; return; }
    if (this.cpu.haltLine) { this.halt.haltAt = e.at; this.halt.haltS = -1; if (!this.inStep) this.halt.haltArrived(); }
    else { this.halt.haltAt = -1; if (this.halt.haltDefer) this.halt.haltDefer.rel = e.at; else if (this.halt.haltS >= 0) this.halt.haltReleased(e.at); }
  }
  // Before an I/O access: the machine's events up to its time, and HALT's part (js/machines/halt-replay.js): the held
  // access of a suspended step run again lands at its release (haltFinish), and an access in a step HALT has stopped
  // waits for the release (haltWait, which describes the wait). On the machine, not the HaltReplay: it is on every I/O
  // access, and the machine's own events (processEvents, replaced under config.mameCompat) are called from here.
  ioSync() {
    const h = this.halt, d = h.haltDefer;
    if (d && d.resume) { d.resume = false; h.haltFinish(d); return; }   // the held access of a resumed step
    this.processEvents(justUnder(this.ioTime() + 1));
    h.haltWait();
  }
  // an outside redirect (Machine.jump, the debugger) drops an instruction HALT suspended (HaltReplay.haltCancel)
  cpuRedirected() { super.cpuRedirected(); this.halt.haltCancel(); }

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
    this.halt.haltDefer = null; this.halt.ioShift = 0; this.halt.busN = 0; this.halt.replayN = -1;
    this.halt.haltAt = -1; this.halt.haltS = -1; this.cpu.haltTail = 0;
    if (hard) this.holdUntil = -Infinity;
    // a write from outside that was waiting to land goes too: the reset drops every access made while an
    // instruction was held, and the same write made while parked is wiped by a reset as well (haltCancel, from
    // resetHardware's memory and GIME reset). A snapshot carries the queue; a restore puts it back.
    this.halt.outsideWrites = [];
  }

  // ---------------- state ----------------
  memoryArray() { return this.mem; }
  saveState() {
    this.halt.cpuCheck();   // (as the next run would: not saved stale)
    return Object.assign(super.saveState(), state.save(this, Coco3Machine.STATE), state.save(this.halt, HaltReplay.STATE), {
      gime: this.gime.saveState(), pia0: this.pia0.saveState(), pia1: this.pia1.saveState(),
      hires: Object.assign({}, this.hires.jet),   // the Hi-Res interface's one-shot (js/machines/cocopia.js)
      stepNoStop: Array.from(this.cpu.cycleNoStop.subarray(0, this.halt.stepN)),   // the last step's check points (haltArrived)
      haltDefer: this.halt.haltDefer && haltDeferState(this.halt.haltDefer),   // the instruction HALT suspended (haltSuspend), or null
      // writes from outside queued while it was held (outsideWrite): of the machine, not only the tool, so they are
      // saved with it and a restore makes them as a run would, restoring into a machine that would have taken them
      outsideWrites: this.halt.outsideWrites.map((w) => ({ a: w.a, v: w.v, poke: w.poke })),
    });
  }
  loadState(s) {
    super.loadState(s);
    state.load(this, s, Coco3Machine.STATE);
    state.load(this.halt, s, HaltReplay.STATE);
    this.gime.loadState(s.gime, this.restoringVersion); this.pia0.loadState(s.pia0); this.pia1.loadState(s.pia1);
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
    this.halt.haltDefer = d && haltDeferState(d);
    if (this.halt.haltDefer) { haltDeferTimes(this.halt.haltDefer, this.cycle); this.cpu.cycleCount = 0; }   // (as haltPark)
    if (this.halt.haltDefer) this.halt.haltKeep(this.halt.haltDefer, false);   // (the file's CPU; its memory came with haltDefer)
    // (a version 1 or 2 file has no key: no write from outside was queued while an instruction was held then, as none
    // could be queued until this build held them, so it restores owing none - machine.js's version note, "3:")
    const q = s.outsideWrites === undefined ? [] : s.outsideWrites;
    if (!Array.isArray(q) || q.some((w) => !w || !Number.isInteger(w.a) || w.a < 0 || w.a > 0xFFFF || !Number.isInteger(w.v) || w.v < 0 || w.v > 0xFF || (w.poke !== undefined && typeof w.poke !== 'boolean')
      || (w.poke === true && w.a >= 0xFF00))) {   // (poke() refuses the I/O page: pokeNow would write the image beneath it)
      throw new Error('snapshot: "outsideWrites" is not a list of address, byte pairs (a poke below $FF00)');
    }
    this.halt.outsideWrites = q.map((w) => ({ a: w.a, v: w.v, poke: w.poke === true }));
    // Between instructions the divider follows gime.fast, so derive it here: a snapshot saved while an outside write
    // left the divider at 4 restores at the rate the GIME says, instead of staying slow for good (a later write of the
    // same rate does not re-time). The one exception is an instruction HALT suspended after it changed the speed
    // (haltDefer.speedChange): it runs on at the saved, old divider and clockChanged moves to the new one, so the
    // file's divider stands.
    if (!(this.halt.haltDefer && this.halt.haltDefer.speedChange >= 0)) this.div = this.gime.fast ? 2 : 4;
    this.halt.busN = 0; this.halt.replayN = -1;
    this.halt.ioShift = 0;
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
    // PIA1 port A: mark (PA1, the RS-232 out, high) in the output register BEFORE the DDR makes PA1 an output, as a
    // printer routine leaves the line between characters; made an output with 0 there, the line dropped to space and
    // the 600-baud serial printer read the drop as a start bit and printed a NUL at every start (MAME 0.264 too:
    // tools/mame-diff/sam/printer-stubinit.asm, run.js coco --printer --stub-init).
    // (A CoCo 3's PA1 is always the RS-232 out.)
    w(0xFF21, 0x34); w(0xFF20, 0x82);
    w(0xFF21, 0x00); w(0xFF20, 0xFE); w(0xFF21, 0x34);   // motor off
    w(0xFF23, 0x00); w(0xFF22, 0xFE); w(0xFF23, 0x3C);   // sound enabled
    w(0xFF20, 0x82); w(0xFF22, 0x04);                    // DAC mid (and the RS-232 out still at mark), text mode
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
// (the HALT model's fields follow them in the file, in the same object: HaltReplay.STATE)
Coco3Machine.STATE = ['div', 'holdUntil', 'sliceStart', 'speedChange', 'kbIrqLevel', 'instrPc'];

export { Coco3Machine };
