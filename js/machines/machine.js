/*
 * Machine: base class for every emulated computer.
 *
 * Owns what is common to all models: the frame loop, a cycle-accurate event scheduler
 * (events can fire in the middle of an instruction when the CPU touches I/O), keyboard
 * matrix, the typist (auto-typing) and cassette deck, audio event capture, ROM slots, no-ROM stub
 * traps and program injection.
 *
 * A machine family subclass must:
 *   - be constructed as new Family(profile, config) by createMachine, with `config` resolved and
 *     validated against profile.options (js/machines/profiles.js), and read only this.config
 *   - call super(profile, config, { tickHz, lineCycles, lines, resetOffset, ramSize }); tickHz is the
 *     machine's time unit in ticks per second (the CPU clock on SAM/MC-10 machines, the GIME clock on the
 *     CoCo 3); frames, events, audio and tape timing are all in ticks
 *   - build its CPU as new cpus[config.cpu](this)
 *   - create this.cpu (a CPU core whose bus is the machine: read(addr) / write(addr, v);
 *     the core exposes pc, step() -> cycles, c (cycles of the current instruction),
 *     reset(), jump(addr), trace hook)
 *   - implement read(addr), write(addr, v), render() -> Uint32Array of screenWidth*screenHeight
 *   - implement resetHardware(), and startTimeline(hard) which schedules the family's first video
 *     events (line events reschedule themselves); register event handlers with this.on(name, fn)
 *   - set screenWidth, screenHeight, screenAspect
 *   - create this.interrupts = new InterruptHub(this.cpu) and route every interrupt source through
 *     setLine(source, line, level) (lines: irq, firq, nmi, halt; and cart, the cartridge port's CART line,
 *     which the family routes in cartLineChanged(level))
 *   - for a cartridge port: return true from hasCartridgePort, map cartPort (a Device) into
 *     $C000-$FEFF / $FF40-$FF5F, and remap in cartridgeChanged(); what the attached devices decide is
 *     settled in devicesAttached(), called whenever one is attached or detached
 *   - for no-ROM operation: map stub firmware (stubRom) and call installStub(); override
 *     stubActive() when the stub ROM can be mapped out
 *   - set Family.BASIC_POINTERS (address of BASIC's TXTTAB) for loadBasicProgram
 *   - call this.processEvents(this.ioTime()) before any I/O access whose result depends on time
 */
import { BusTaps } from './bustaps.js';
import { BeckerPort } from './becker.js';
import { devices } from './bus.js';
import { keyboards } from './keyboards.js';
import { Typist } from './typist.js';
import { CassetteDeck } from '../media/deck.js';
import { crc32, state } from '../util.js';

class Machine {
  constructor(profile, config, t) {
    this.profile = profile;
    this.config = config;     // resolved, frozen options (resolveConfig)
    this.id = profile.id;
    this.tickHz = t.tickHz;
    this.lineCycles = t.lineCycles;
    this.lines = t.lines;
    this.frameCycles = t.lineCycles * t.lines;
    this.fps = this.tickHz / this.frameCycles;
    this.unitAttos = BigInt(Math.round(1e18 / this.tickHz));   // see clockUnits()
    this.resetOffset = t.resetOffset || 0;
    this.ram = new Uint8Array(t.ramSize || 0x10000);
    this.roms = {};

    this.keyPos = keyboards[profile.keyboard];
    this.keyCols = new Uint8Array(8);    // per column: bitmask of pressed rows
    this.joy = [[32, 32], [32, 32]];     // [right, left][x, y], 0..63
    this.fire = [false, false];
    // whether the model has a joystick port at all (profiles.js `joystick: false`: the MC-10 and the Alice);
    // the page's touch joystick reads it (js/host/input.js touchJoystickOffered)
    this.hasJoystick = profile.joystick !== false;

    this.typist = new Typist(this);
    this.stubKeys = [];
    this.stubKeysTaken = 0;     // keys the stub's POLCAT has handed out (a count for the Session, not machine state)
    // How often the CPU has read the keyboard (observations for the paced typist, not machine state): keyScans
    // counts every read of the matrix (and every stub POLCAT call); colScans[c] counts the reads that drove
    // column c low, so a key in column c was visible to that read. ROM-independent: it is the bus, not BASIC.
    this.keyScans = 0;
    this.colScans = new Uint32Array(8);
    this.stubKeepCase = false;     // the stub's POLCAT hands over typed lower case as is (the chat firmware)
    this.pcHooks = new Map();   // pc -> fn, run when the instruction at pc is about to execute, while stubActive()
    // pc -> (), called with the address of every instruction before it runs while any probe is registered (addProbe):
    // the one probe itself, or a dispatcher over several; null with none, so runCycles pays one test. Host state, not
    // machine state: never in a snapshot.
    this.pcWatch = null;
    this.probes = [];
    // () -> (), called when a run of instructions ends while any run-end hook is registered (addRunEnd): the one hook
    // itself, or a dispatcher over several; null with none. Host state, like the probes.
    this.runEndWatch = null;
    this.runEnds = [];
    // the bus taps (js/machines/bustaps.js): read/write observers over address ranges, host state like the probes
    this.busTaps = new BusTaps(this);
    this.stubConsole = null;

    this.deck = new CassetteDeck(() => this.now());

    this.audioEvents = [];
    this.soundLevel = 0;
    // a cartridge's own sound output (cartSound), mixed into audioEvents when the frame ends
    this.cartAudio = [];
    this.cartLevel = 0;

    // Time: one absolute tick counter (CPU cycles, or GIME clocks on the CoCo 3), never rebased.
    this.cycle = 0;           // now, in ticks
    this.inStep = false;      // an instruction is running: between cycles of runCycles, false (see ioTime)
    this.frameBase = 0;       // tick at which the current frame started
    this.frameCount = 0;
    this.framesSinceReset = 0;
    // This run began as a snapshot loaded onto the machine (restore), not as a power-on or a Reset. Not emulated
    // state (a restored moment is the same machine either way), so it is not in Machine.STATE and never enters a
    // snapshot; every reset clears it, so it can never outlive the run it describes.
    this.restored = false;
    // Event queue: { at (tick), pri, seq, name, arg }, ordered by (at, pri, seq). Events are plain
    // data naming a handler registered with on(), so pending events can be saved in snapshots.
    this.queue = [];
    this.attoNow = null;      // the exact time of the timer an AttoClock is running (js/chips/attoclock.js), else null
    this.seq = 0;
    this.handlers = {};
    this.timelineStarted = false;

    this.cartPort = null;     // device in the cartridge port (families with a port)
    this.diskTraces = [];     // (kind, data, at, controller) => void: the disk controller's observers (addDiskTrace); not state
    // the printer: the bytes it has received (a Dragon's parallel port; a serial printer on the bit-banger
    // output of the other machines, through this.bitBanger)
    this.printed = [];
    this.bitBanger = null;    // SerialPort: the device on the bit-banger serial port (families with one)
    this.acia = null;         // Acia6551: the 6551 serial port (Dragon 64, 200, Tano), with its own SerialPort
    // the Becker port (DriveWire), where the configuration has one (option `becker`)
    this.becker = config.becker ? new BeckerPort(this) : null;
    // a Promise the machine is waiting for (a DriveWire sector being read or written), or null; runFrame stops
    // where it is and carries on from there when called again after it settles
    this.stall = null;
    this.restoringVersion = SNAPSHOT_VERSION;   // the layout loadState() reads: restore() sets that of the file
    this.frameOpen = false;
    this.debugger = null;     // a Debugger attached to this machine (js/debugger.js), or null
    this.redirects = 0;       // how many times the CPU was redirected from outside (cpuRedirected): the debugger's check
    this.mouse = null;        // the host's mouse { x, y (0..1), left, right } (js/host/input.js), or null: host input, not state
    this.screenWidth = 0; this.screenHeight = 0; this.screenAspect = 4 / 3;
  }

  // ---------------- the serial port ----------------
  // the device on the machine's serial port (a SerialPort: the bit-banger's, or the 6551's), or null
  get serialPort() { return this.bitBanger || (this.acia && this.acia.port) || null; }
  // the devices that can be plugged in: a bit-banger takes the serial printer (the Dragons print on their parallel
  // port instead), a terminal or a loopback plug; the 6551 starts with nothing plugged in
  get serialDevices() { return this.bitBanger ? ['printer', 'terminal', 'loopback'] : this.acia ? ['none', 'terminal', 'loopback'] : []; }
  // plug a device in ({ baud } for a terminal). The 6551's loopback plug holds CTS, DSR and DCD asserted (RTS and
  // DTR are not wired to the Dragon 64's port, as in MAME, so a plug that looped them back would stop the
  // transmitter)
  attachSerial(kind, opts = {}) {
    if (!this.serialDevices.includes(kind)) throw new Error(`no serial device "${kind}" on the ${this.profile.name}`);
    if (this.acia) this.acia.attachSerial(kind, kind === 'loopback' ? Object.assign({ handshake: 'asserted' }, opts) : opts);
    else this.bitBanger.attach(kind, opts);
  }

  // ---------------- ROMs ----------------
  setRoms(map) {
    for (const [id, data] of Object.entries(map)) {
      if (data) this.roms[id] = data; else delete this.roms[id];
    }
    this.romsChanged();
  }
  romsChanged() { /* subclass hook */ }
  get hasRom() { return this.profile.roms.filter((s) => s.required).every((s) => !!this.roms[s.id]); }
  get useStub() { return !this.hasRom; }
  // the frame count at which the current run began: changes with every reset and power-on, so it tells runs apart
  // (the Session's boot watchdog keys on it). A restored moment keeps the snapshot's frameCount and framesSinceReset,
  // so its resetAt is the run's start in the machine it was taken on, NOT a new machine's 0 - and it can coincide
  // with a power-on's in the same frame, which is why the boot watchdog also keys on `restored`, not only on this.
  get resetAt() { return this.frameCount - this.framesSinceReset; }
  stubActive() { return this.useStub; }
  // No-ROM stub: PC hooks at the stub firmware's entry points (symbols from stubRom):
  // RESET runs init(), POLCAT returns a queued key (A, Z clear) or none (Z set), CHROUT prints A on
  // the console, and the cassette/cursor routines return with carry set (error)
  installStub(symbols, console, init) {
    const cpu = this.cpu, { Z, C } = cpu.constructor.FLAGS, h = this.pcHooks;
    this.stubConsole = console;
    h.set(symbols.get('RESET'), init);
    h.set(symbols.get('POLCAT'), () => {
      this.keyScans++;
      if (this.stubKeys.length) { cpu.a = this.stubKeys.shift() & 0xFF; cpu.cc &= ~Z; this.stubKeysTaken++; }
      else { cpu.a = 0; cpu.cc |= Z; }
    });
    h.set(symbols.get('CHROUT'), () => console.putChar(cpu.a));
    for (const n of ['CSRDON', 'BLKIN', 'BLKOUT', 'WRTLDR']) if (symbols.has(n)) h.set(symbols.get(n), () => { cpu.cc |= C; });
    // the stub's own prompt: its idle loop and (6809) its line editor, and the console calls they make
    const span = (from, to) => (symbols.has(from) ? [[symbols.get(from), symbols.get(to)]] : []);
    this.stubPromptAt = { spans: [...span('IDLE', 'IDLEE'), ...span('KEY', 'PROMPTE')], calls: [symbols.get('POLCAT'), symbols.get('CHROUT')] };
  }
  // Is the stub firmware's own prompt what runs (its idle loop or line editor, or a POLCAT/CHROUT call made from
  // them), rather than a program? Then the screen is the stub's bare one (or the POKE lines typed at it).
  atStubPrompt() {
    const p = this.stubPromptAt;
    if (!p || !this.stubActive()) return false;
    const inside = (a) => p.spans.some(([lo, hi]) => a >= lo && a < hi);
    const pc = this.cpu.pc;
    if (inside(pc)) return true;
    if (!p.calls.includes(pc)) return false;
    // in a console call: where it returns to (the 6809 leaves S on the return address, the 6803 one byte below)
    return inside(this.cpu.returnAddress((a) => (this.peek ? this.peek(a) : this.ram[a])));
  }

  // ---------------- reset ----------------
  reset(hard) {
    if (hard) this.ram.fill(0);
    this.clearKeys();
    this.typist.clear('machine-restarted');   // Claude's typing ends: the machine restarted under it (not a Stop)
    // (an EXEC waiting for a load goes with the typist's queue, and its probe with it: Typist.clear)
    this.stubKeys = [];
    this.resetHardware(hard);
    this.cpu.reset(hard);
    if (hard) {
      // power-on: video timing restarts at the frame origin; the CPU starts resetOffset ticks later
      this.queue = [];
      this.cycle = this.frameBase + this.resetOffset;
      this.timelineStarted = true;
      this.startTimeline(true);
    }
    if (this.cartPort) this.cartPort.reset(hard);   // the cartridge port carries the reset line
    this.framesSinceReset = 0;
    this.restored = false;   // this run starts as a Reset or a power-on, whatever an earlier one was
    // whoever drives the machine is told it started over (the Session stops Claude acting on it); a host hook,
    // not machine state, so not in the snapshot
    if (this.onReset) this.onReset(hard);
  }

  // ---------------- events ----------------
  now() { return this.cycle; }
  // tick at which the current instruction touches the bus (loads read on their last cycle).
  // Between instructions there is no instruction touching the bus, and the CPU's cycle count still holds the
  // last instruction's (it is kept after the step: the trace and the debugger read it), so the answer is then
  // now(): anything past `cycle` would run the scheduler ahead of the machine for a tool that looks at it
  // between steps (a debugger's I/O write, a stub hook), and a restored machine, whose CPU comes back with no
  // cycle count, would answer differently from the original for the same access.
  ioTime() { return this.inStep && this.cpu.c > 0 ? this.cycle + this.cpu.c - 1 : this.cycle; }
  // Exact time for devices that keep it (js/chips/attoclock.js): clockUnits() counts whole units up to the
  // current bus access (the end of the access's cycle: MAME's 6809 counts a bus cycle before performing it), or
  // up to now between instructions; unitAttos is a unit in attoseconds; tickAt(u) is the tick u units after
  // that point. Here a unit is a tick; a family that follows MAME's clocks uses whole CPU cycles.
  clockUnits() { return this.ioTime() + 1; }
  tickAt(units) { return this.ioTime() + 1 + units; }
  on(name, fn) { this.handlers[name] = fn; }
  // a device going away: its handler and every event of that name still queued
  off(name) {
    delete this.handlers[name];
    const q = this.queue;
    for (let i = q.length - 1; i >= 0; i--) if (q[i].name === name) q.splice(i, 1);
  }
  // Schedule handler `name` at absolute tick `at`. pri orders events due at the same tick
  // (0: video timing, 1: other devices). Returns the event, which cancel() accepts.
  schedule(at, name, arg = null, pri = 1) {
    const e = { at, pri, seq: this.seq++, name, arg };
    const q = this.queue;
    let lo = 0, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, x = q[mid];
      if (x.at < at || (x.at === at && (x.pri < pri || (x.pri === pri && x.seq < e.seq)))) lo = mid + 1; else hi = mid;
    }
    q.splice(lo, 0, e);
    return e;
  }
  cancel(e) {
    const i = e ? this.queue.indexOf(e) : -1;
    if (i >= 0) this.queue.splice(i, 1);
  }
  nextEventAt() { return this.queue.length ? this.queue[0].at : Infinity; }
  // fire every event due at or before tick t (t may fall inside an instruction)
  processEvents(t) {
    const q = this.queue;
    while (q.length && q[0].at <= t) this.fireEvent(q.shift());
  }
  // fire the events due strictly before tick t (an exact bound: t - epsilon rounds to t once ticks pass 2^24)
  processEventsBefore(t) {
    const q = this.queue;
    while (q.length && q[0].at < t) this.fireEvent(q.shift());
  }
  fireEvent(e) { this.handlers[e.name](e.arg, e.at); }
  startTimeline() { /* family hook: schedule the first video events */ }

  // ---------------- probes ----------------
  // Observers of the instruction stream for the host (the Session's load detector; later the profiler): fn(pc) is
  // called before every instruction the CPU starts, in registration order, from runCycles. Not machine state: a
  // probe never goes in a snapshot, a reset leaves it, and the Session puts its own back on a new machine
  // (HostHooks). -> remove(), which takes this registration off (once; a second call does nothing). With no
  // probe, pcWatch is null; with one it is that probe (no dispatcher between), and a probe added or removed while
  // the probes run takes effect from the next instruction.
  addProbe(fn) {
    if (typeof fn !== 'function') throw new TypeError('addProbe: a probe is a function of the pc');
    const entry = { fn };
    this.probes = [...this.probes, entry];
    this.probesChanged();
    return () => {
      if (!this.probes.includes(entry)) return;
      this.probes = this.probes.filter((e) => e !== entry);
      this.probesChanged();
    };
  }
  probesChanged() {
    const list = this.probes;
    if (list.length === 0) this.pcWatch = null;
    else if (list.length === 1) this.pcWatch = list[0].fn;
    else {
      const fns = list.map((e) => e.fn);
      this.pcWatch = (pc) => { for (let i = 0; i < fns.length; i++) fns[i](pc); };
    }
  }
  // Run-end hooks: fn() is called when a run of instructions ends, before the machine goes on (the memory-write
  // observer delivers the writes of the last instruction there, js/writewatch.js): in runFrame once its instructions
  // are run, before the frame closes, and by the debugger after each instruction it steps. Host state like the probes,
  // in registration order; -> remove() (once). With none, runEndWatch is null.
  addRunEnd(fn) {
    if (typeof fn !== 'function') throw new TypeError('addRunEnd: a run-end hook is a function');
    const entry = { fn };
    this.runEnds = [...this.runEnds, entry];
    this.runEndsChanged();
    return () => {
      if (!this.runEnds.includes(entry)) return;
      this.runEnds = this.runEnds.filter((e) => e !== entry);
      this.runEndsChanged();
    };
  }
  runEndsChanged() {
    const fns = this.runEnds.map((e) => e.fn);
    this.runEndWatch = fns.length === 0 ? null : fns.length === 1 ? fns[0] : () => { for (let i = 0; i < fns.length; i++) fns[i](); };
  }
  // The CPU's access being made is one a CoCo 3 instruction resumed after HALT replays (made once already, before
  // it was suspended): the bus taps do not report it again. No other family replays.
  replaying() { return false; }

  // ---------------- frame loop ----------------
  // Run instructions until the tick reaches `end` (or at most `steps` instructions: the debugger's single step)
  runCycles(end, steps = Infinity) {
    const cpu = this.cpu, hooks = this.pcHooks;
    const stub = this.useStub;
    while (this.cycle < end && !this.stall && steps-- > 0) {
      this.processEvents(this.cycle);
      if (stub && this.stubActive()) {
        const hook = hooks.get(cpu.pc);
        if (hook && cpu.willExecute()) hook();
      }
      if (this.pcWatch !== null) this.pcWatch(cpu.pc);
      cpu.c = 0;
      let n;
      this.inStep = true;
      try { n = cpu.step(); } finally { this.inStep = false; }
      this.cycle += n;
    }
  }
  // wait for `promise` before running on (the instruction under way finishes first)
  waitFor(promise) {
    const p = promise.then(() => { if (this.stall === p) this.stall = null; }, () => { if (this.stall === p) this.stall = null; });
    this.stall = p;
  }
  // Run one frame. Returns false if the machine had to stop part way: this.stall (await it), or runTo(end)
  // returned false (a debugger passes its own runTo, which stops at a breakpoint or watchpoint). The frame stays
  // open, sound included, and the next runFrame carries on to the same end. true when the frame is done.
  runFrame(runTo = null) {
    if (!this.frameOpen) {
      if (!this.timelineStarted) { this.timelineStarted = true; this.startTimeline(false); }
      this.audioEvents.length = 0;
      this.audioEvents.push(0, this.soundLevel);
      this.cartAudio.length = 0;
      this.cartAudio.push(0, this.cartLevel);
      this.frameOpen = true;
    }
    const end = this.frameBase + this.frameCycles;
    const ran = runTo ? runTo(end) !== false : (this.runCycles(end), true);
    if (this.runEndWatch !== null) this.runEndWatch();   // (the frame's last instruction is done: before it closes)
    if (!ran || this.stall) return false;
    this.frameOpen = false;
    this.processEvents(end - 1);
    if (this.serialPort) this.serialPort.flush(end);
    this.frameEnd(end);
    if (this.cartPort) this.cartPort.syncAudio(end);
    this.mixCartAudio();
    this.deck.sync();
    this.frameCount++;
    this.framesSinceReset++;
    this.typist.step();
    this.frameBase = end;      // instruction overshoot simply continues into the next frame
    return true;
  }

  // ---------------- keyboard ----------------
  setKey(name, down) {
    const pos = this.keyPos[name];
    if (!pos) return;
    const [r, c] = pos;
    if (down) this.keyCols[c] |= (1 << r); else this.keyCols[c] &= ~(1 << r);
  }
  clearKeys() { this.keyCols.fill(0); }
  // rows pulled low by pressed keys in the columns that are driven low (active-low column mask)
  keyRowsForCols(colsLow) {
    let rows = 0;
    for (let c = 0; c < 8; c++) if (!(colsLow & (1 << c))) rows |= this.keyCols[c];
    return rows;
  }
  // The CPU reading the keyboard rows (the PIA's row port, the MC-10's $BFFF): counted for the paced typist, then
  // answered as keyRowsForCols. Only CPU reads come here; a model (the CoCo 3's keyboard interrupt) asks
  // keyRowsForCols directly, so it is not mistaken for the machine looking at the keyboard.
  scanKeys(colsLow) {
    this.keyScans++;
    for (let c = 0; c < 8; c++) if (!(colsLow & (1 << c))) this.colScans[c]++;
    return this.keyRowsForCols(colsLow);
  }
  // the code the no-ROM stub's POLCAT hands out for a typed character (Enter is 13)
  stubCode(ch) { return ch === '\n' || ch === '\r' ? 13 : (this.stubKeepCase ? ch : ch.toUpperCase()).charCodeAt(0) & 0x7F; }
  // columns pulled low by pressed keys in the rows that are driven low
  keyColsForRows(rowsLow) {
    let cols = 0;
    for (let c = 0; c < 8; c++) if (this.keyCols[c] & ~rowsLow) cols |= 1 << c;
    return cols;
  }

  // ---------------- sound ----------------
  setSoundLevel(level) {
    if (level === this.soundLevel) return;
    this.soundLevel = level;
    this.audioEvents.push(this.cycle - this.frameBase, level);
  }
  // a cartridge's sound output changes to `level` at `tick` (in this frame or later; devices report in time order)
  cartSound(tick, level) {
    if (level === this.cartLevel) return;
    this.cartLevel = level;
    this.cartAudio.push(Math.max(0, tick - this.frameBase), level);
  }
  // audioEvents := machine level + cartridge level, both stepwise in time
  mixCartAudio() {
    const c = this.cartAudio;
    if (c.length === 2 && c[1] === 0) return;
    const a = this.audioEvents.slice(), out = this.audioEvents;
    out.length = 0;
    let i = 0, j = 0, la = a[1], lc = c[1];
    out.push(0, la + lc);
    i = 2; j = 2;
    while (i < a.length || j < c.length) {
      let t;
      if (j >= c.length || (i < a.length && a[i] <= c[j])) { t = a[i]; la = a[i + 1]; i += 2; }
      else { t = c[j]; lc = c[j + 1]; j += 2; }
      const v = la + lc;
      if (out[out.length - 2] === t) out[out.length - 1] = v;
      else if (out[out.length - 1] !== v) out.push(t, v);
    }
  }
  // CPU cycles a slot holds its lines back (coco.cpp machine_start: set_line_delay), counted in the slot's clock
  get lineDelays() { return LINE_DELAYS; }
  get slotHz() { return this.tickHz; }

  // ---------------- bus ----------------
  setLine(source, line, level) {
    if (line === 'cart') this.cartLineChanged(!!level);
    else this.interrupts.set(source, line, level);
  }
  cartLineChanged() { /* family hook: the cartridge port's CART line */ }
  frameEnd() { /* family hook: bring sound generators up to the end of the frame */ }
  get hasCartridgePort() { return false; }
  // A port change cannot be made inside an instruction: it would let the step under way be suspended against a bus
  // log that started late (the CoCo 3's logBus is live, and rests on a step never spanning an attach). Refused
  // loudly, like a device driving HALT undeclared (coco3.js setLine): it is a programmer error, not a state a
  // person can reach - the page, the Session and the debugger all attach between frames - so there is no
  // user-readable message to write. (tests/coco3-buslog.test.js)
  insertCartridge(dev) {
    if (!this.hasCartridgePort) throw new Error(`the ${this.profile.name} has no cartridge port`);
    if (this.inStep) throw new Error('a cartridge cannot be attached inside an instruction: attach it between frames');
    if (this.cartPort) this.cartPort.detach();
    this.cartPort = dev;
    dev.attach(this);
    this.bindDiskTrace();
    this.cartridgeChanged();
    this.devicesAttached();
  }
  ejectCartridge() {
    if (!this.cartPort) return;
    if (this.inStep) throw new Error('a cartridge cannot be taken out inside an instruction: take it out between frames');
    this.cartPort.detach();
    this.cartPort = null;
    this.cartridgeChanged();
    this.devicesAttached();
  }
  cartridgeChanged() { /* family hook: remap the cartridge ROM space */ }
  // hear the disk controller (js/machines/fdc.js setDiskTrace): the machine's own, the one in the cartridge port or
  // in a Multi-Pak's slot, and one plugged in later. Any number, in the order added -> remove() (once). With none,
  // the controller has no hook at all.
  addDiskTrace(fn) {
    if (typeof fn !== 'function') throw new TypeError('addDiskTrace: a trace is a function (kind, data, at, controller)');
    const entry = { fn };
    this.diskTraces = [...this.diskTraces, entry];
    this.bindDiskTrace();
    return () => {
      if (!this.diskTraces.includes(entry)) return;
      this.diskTraces = this.diskTraces.filter((e) => e !== entry);
      this.bindDiskTrace();
    };
  }
  bindDiskTrace() {
    const list = this.diskTraces, port = this.cartPort;
    const fn = !list.length ? null : list.length === 1 ? list[0].fn : (kind, data, at, fdc) => { for (const e of list) e.fn(kind, data, at, fdc); };
    for (const d of [this.fdc, port, ...(port && port.slots ? port.slots : [])]) if (d && typeof d.setDiskTrace === 'function') d.setDiskTrace(fn);
  }
  // called whenever a device has been attached or detached (a cartridge in or out, a machine restored from a
  // snapshot, a Multi-Pak's slot changed): family hook for what the attached devices decide, such as the CoCo 3's
  // bus log (js/machines/halt-replay.js logBus)
  devicesAttached() { }

  // ---------------- state (snapshots) ----------------
  // Families extend saveState/loadState with their chips and fields (calling super). Input
  // state (keys held, auto-typing) is not saved: it belongs to the host, not the machine.
  // A debugger attached to this machine is saved with it (its breakpoints and watchpoints), so a restored
  // snapshot keeps the debugging setup; its trace and whether it was stopped are not machine state.
  memoryArray() { return this.ram; }
  saveState() {
    return Object.assign(state.save(this, Machine.STATE), {
      memory: this.memoryArray().slice(),
      cartridge: this.cartPort ? { type: this.cartPort.type, state: this.cartPort.saveState() } : null,
      interrupts: this.interrupts.saveState(),
      deck: this.deck.saveState(),
      bitBanger: this.bitBanger ? this.bitBanger.saveState() : null,
      becker: this.becker ? this.becker.saveState() : null,
      cpu: this.cpu.saveState(),
      // The picture. Lines are drawn as the beam passes them, so a snapshot taken mid-frame
      // leaves the rest of the frame undrawn: without the buffer the restored machine would show
      // a partly blank frame until the beam came round again.
      frame: this.snapshotPicture().data.slice(),
      debugger: this.debugger ? this.debugger.saveState() : null,
    });
  }
  loadState(s) {
    // the cartridge in the port goes first, while its events are still the ones queued: the snapshot's queue then
    // holds the restored device's (which has the same event names)
    if (this.cartPort) { this.cartPort.detach(); this.cartPort = null; }
    state.load(this, s, Machine.STATE);
    const mem = this.memoryArray();
    if (!s.memory || s.memory.length !== mem.length) throw new Error('snapshot: memory size does not match this configuration');
    mem.set(s.memory);
    this.deck.loadState(s.deck, this.restoringVersion, this.profile.tape);
    if (this.bitBanger) {
      if (!s.bitBanger) throw new Error('snapshot: missing "bitBanger"');
      this.bitBanger.loadState(s.bitBanger);
    }
    if (this.becker) {
      if (!('becker' in s)) throw new Error('snapshot: missing "becker"');
      this.becker.loadState(s.becker);
    }
    if (this.hasCartridgePort) {
      if (s.cartridge && !devices[s.cartridge.type]) throw new Error(`snapshot: unknown cartridge ${s.cartridge.type}`);
      // (the port is empty here: it was detached above, so ejectCartridge would return at once and never announce
      // it - the family must hear of this either way, as the CoCo 3's bus log needs of it)
      if (s.cartridge) this.insertCartridge(devices[s.cartridge.type].fromState(s.cartridge.state));
      this.devicesAttached();
    }
    // after the cartridge: what each source holds, so a source letting go of a line another still holds leaves
    // it held
    if (!s.interrupts) throw new Error('snapshot: missing "interrupts"');
    this.interrupts.loadState(s.interrupts);
    this.cpu.loadState(s.cpu);
    // restore the picture (see saveState): the frame the snapshot was taken in the middle of
    if (!s.frame) throw new Error('snapshot: missing "frame"');
    const pic = this.snapshotPicture().data;
    if (s.frame.length !== pic.length) throw new Error('snapshot: picture size does not match this machine');
    pic.set(s.frame);
    if (this.debugger) { if (s.debugger) this.debugger.loadState(s.debugger); else this.debugger.loadState({}); }
    this.clearKeys();
    this.typist.clear(); this.stubKeys = [];
  }
  romCrcs() {
    const out = {};
    for (const sl of this.profile.roms) if (this.roms[sl.id]) out[sl.id] = crc32(this.roms[sl.id]);
    return out;
  }
  // A snapshot names the machine, its config and the ROMs it ran with (by CRC, never the contents). Its
  // layout is versioned by SNAPSHOT_VERSION (below); js/media/snapshot.js writes it to and reads it from files.
  // the picture a snapshot carries as `frame`: the screen render() shows, unless a machine with more than one screen
  // says which (the Dragon 64 Plus: its VDG screen here, its 80-column one in its own state, whichever is shown)
  snapshotPicture() { return this.render(); }
  snapshot() {
    return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, machine: this.id, config: Object.assign({}, this.config), roms: this.romCrcs(), state: this.saveState() };
  }
  // Restores a snapshot of this very machine: same model, config and ROM set (the same sockets filled, with
  // the same CRCs). Anything else throws: state taken with other firmware would run differently.
  restore(snap) {
    this.checkSnapshot(snap);
    this.loadSnapshotState(snap);
    this.restored = true;   // this run began as a loaded moment: the Session's boot watchdog leaves it alone
  }
  // loads a snapshot's state in the layout of the file's version, without restore()'s checks (call checkSnapshot
  // first); a loader that reads a key newer files have can tell an older file's absence of it by restoringVersion
  loadSnapshotState(snap) {
    this.restoringVersion = snap.version;
    try { this.loadState(snap.state); } finally { this.restoringVersion = SNAPSHOT_VERSION; }
  }
  // restore()'s checks alone: throws why `snap` can't be restored here, and changes nothing
  checkSnapshot(snap) {
    if (!snap || snap.format !== SNAPSHOT_FORMAT) throw new Error('not a snapshot');
    if (!(snap.version >= SNAPSHOT_OLDEST && snap.version <= SNAPSHOT_VERSION)) throw new Error(`snapshot format version ${snap.version}; this version reads ${SNAPSHOT_OLDEST} to ${SNAPSHOT_VERSION}`);
    if (snap.machine !== this.id) throw new Error(`snapshot is for ${snap.machine}, not ${this.id}`);
    const keys = new Set([...Object.keys(snap.config), ...Object.keys(this.config)]);
    for (const k of keys) if (this.config[k] !== snap.config[k]) throw new Error(`snapshot needs ${k} = ${snap.config[k]} (this machine has ${this.config[k]})`);
    const mine = this.romCrcs();
    for (const slot of new Set([...Object.keys(snap.roms), ...Object.keys(mine)])) {
      if (mine[slot] !== snap.roms[slot]) throw new Error(`snapshot was taken ${snap.roms[slot] == null ? 'without' : 'with a different'} ${slot} ROM`);
    }
  }

  // ---------------- program loading ----------------
  ensureBooted(frames = 150) {
    // (a machine waiting for DriveWire cannot run on synchronously: it boots as far as it can)
    while (this.framesSinceReset < frames && this.runFrame());
  }
  // Why a write at `addr` would not be seen if it were made, or null when it would land in memory. This
  // exists because a read-back after a write cannot tell every case apart: an I/O register the emulation
  // leaves unhandled may read $FF, so writing $FF there reads back as if it took. Families override it; the
  // base class has no ROM and no I/O, so every address is plain RAM.
  writeKind(addr) { return null; }
  // Write a byte as a tool would (no bus cycle). Returns whether the byte landed in memory the CPU sees: the
  // base class is plain RAM, so always true; a family with ROM or I/O returns false for an address that takes no write.
  poke(addr, v) { this.ram[addr & 0xFFFF] = v; return true; }
  // A side-effect-free read of memory as the CPU sees it. Each family overrides this with its own map; the
  // base class is a plain RAM read, enough for a family with no ROM, cartridge or banked memory. Nothing here
  // may run a scheduler event, clear a status flag or read a FIFO: the Claude read-only tools use it to look
  // at the machine without touching it.
  peek(addr) { return this.ram[addr & 0xFFFF]; }
  // BASIC program in tokenised form: set BASIC's program/variable pointers (TXTTAB, VARTAB, ARYTAB,
  // ARYEND at the family's BASIC_POINTERS) and RUN. start defaults to the current TXTTAB.
  loadBasicProgram(data, start) {
    this.ensureBooted();
    const p = this.constructor.BASIC_POINTERS, ram = this.ram;
    if (start == null) start = (ram[p] << 8) | ram[p + 1];
    const end = (start + data.length) & 0xFFFF;
    for (let i = 0; i < data.length; i++) this.poke(start + i, data[i]);
    for (let i = 0; i < 8; i += 2) { const v = i ? end : start; ram[p + i] = v >> 8; ram[p + i + 1] = v & 0xFF; }
    this.typist.type('RUN\r');
  }
  // write segments into memory and start executing at exec (null: don't jump)
  injectAndRun(segments, exec) {
    if (this.useStub) {
      this.reset(true);
      while (this.framesSinceReset < 2 && this.runFrame());
    } else this.ensureBooted();
    for (const seg of segments) for (let i = 0; i < seg.data.length; i++) this.poke((seg.addr + i) & 0xFFFF, seg.data[i]);
    if (exec != null) this.jump(exec);
  }
  // start executing at addr, from outside the program (a tool, a loader)
  jump(addr) { this.cpu.jump(addr); this.cpuRedirected(); }
  // The CPU's registers were changed from outside: by a jump or the debugger. A family that keeps an instruction under
  // way between steps drops it here (the CoCo 3's instruction held by HALT, js/machines/halt-replay.js haltCancel); the base
  // class keeps none. The count tells the debugger that the instruction at the PC is a new one (js/debugger.js).
  cpuRedirected() { this.redirects++; }
  // an outside change made without cpuRedirected (a register written directly, memory the instruction under way had
  // read or fetched): the family notices it here (CoCo 3: haltCheck) and redirects; the base class keeps nothing
  cpuCheck() {}
  // an instruction is under way between steps, waiting for HALT's release (the CoCo 3's haltDefer): the debugger
  // doesn't count a step that leaves one (js/debugger.js)
  get cpuHeld() { return false; }
}

// The snapshot layout. Bump SNAPSHOT_VERSION whenever any saveState() changes what it writes, and record here what
// changed. A page reads SNAPSHOT_OLDEST to SNAPSHOT_VERSION:
//   * a bump that only ADDS state keeps SNAPSHOT_OLDEST. A key an older file lacks must then keep the restored
//     machine's power-on value: restore() records the file's version (restoringVersion), the loader of the new key
//     takes its absence in an older file as that value, and a test shows an older file restoring while the same
//     file at the current version is refused;
//   * a bump that renames, removes or changes the meaning of state sets SNAPSHOT_OLDEST to the new version.
// Files from pre-release builds carry a different `format` identifier; js/media/snapshot.js refuses them by it.
//   1: the first layout.
//   2: the CoCo 3 adds `haltDefer`, an instruction HALT suspended (js/machines/halt-replay.js haltSuspend, with its bus
//      accesses so far, `log`, and the memory they touched, `mem`), or null; a version 1 file has none, and its machine restores with no instruction
//      suspended (none was, in version 1).
//   3: a tape in the deck adds `layout` (2): its position counts the entries of the signal js/media/tape.js plays,
//      silence and made-up leaders included. A version 1 or 2 file has none; its position counted a 128-byte leader
//      and then the image's bytes, and the tape restores at the same byte of the image (Tape.fromState). And the
//      CoCo 3 adds `outsideWrites`, the writes from outside the CPU queued while an instruction was held
//      (js/machines/halt-replay.js outsideWrite); a version 1 or 2 file has none and restores owing none (none could be
//      queued before this build held them).
//   4: the CoCo 3's GIME adds `vsc`, the vertical fine scroll ($FF9C) latched at the start of the field
//      (js/chips/gime.js vscLine). A version 1 to 3 file has none and restores with 0, as no field scrolled before
//      this build; the next field latches $FF9C.
export const SNAPSHOT_FORMAT = 'cloadm-state';
export const SNAPSHOT_VERSION = 4;
export const SNAPSHOT_OLDEST = 1;

Machine.BASIC_POINTERS = 0x19;   // Color BASIC / Dragon BASIC TXTTAB
Machine.STATE = ['cycle', 'frameBase', 'frameCount', 'framesSinceReset', 'queue', 'seq', 'timelineStarted', 'soundLevel', 'printed', 'cartLevel'];
const LINE_DELAYS = Object.freeze({ cart: 0, nmi: 12, halt: 6 });

export { Machine };
