/*
 * Mc10Machine: Tandy MC-10 and Matra Alice. MC6803 + MC6847 + keyboard, 1-bit sound, cassette.
 * Hardware as in MAME's mc10 driver (src/mame/trs/mc10.cpp, 0.264):
 *   $0000-$001F  6803 on-chip registers            $0080-$00FF  6803 on-chip RAM
 *   $4000-$4FFF  4K RAM; $4000-$8FFF with the 16K expansion (config.ram 4 or 20)
 *   $BFFF        read: keyboard rows of the columns strobed low on port 1
 *                write: bit 2 GM2 + INT/EXT, 3 GM1, 4 GM0, 5 A/G, 6 CSS, 7 sound
 *   $E000-$FFFF  8K ROM
 *   port 1       keyboard column strobes (output)
 *   port 2       bit 0 cassette/printer out, bit 1 keyboard row 6 (CTRL, BREAK, SHIFT),
 *                bit 2 RS-232 in, bit 3 printer ready, bit 4 cassette in
 * Everything else reads 0 and ignores writes (as unmapped space does in MAME). The VDG always
 * shows RAM from $4000; its HS/FS outputs are not connected to the CPU, so nothing is timed
 * against the raster, so it schedules no video events.
 * Verified instruction-for-instruction (registers and cycle counts) against MAME; see tools/mame-diff/mc10.
 */
import { MC6847 } from '../chips/mc6847.js';
import { CPU6803 } from '../cpu/cpu6803.js';
import { cpus } from '../cpu/cpus.js';
import { InterruptHub } from './bus.js';
import { Machine } from './machine.js';
import { SerialPort } from './rs232.js';
import { TextConsole, banner, stubRom } from './stub.js';
import { state } from '../util.js';

const CPU_HZ = 3579545 / 4;      // E clock: 3.579545 MHz crystal / 4 (the CoCo's rate)
const CLOCKS_PER_TICK = 4;       // this machine's tick is one CPU cycle = 4 VDG clocks
const LINE_CYCLES = 57;          // 228 VDG clocks per line / 4
const LINES = 262;               // NTSC field
const BODY_START = 25;           // first active display line (after the top border)
// MAME 0.264's MC-10 timing, reproduced with config.mameCompat only (comparisons): MAME turns the 6803's
// 3.579545 MHz crystal into a cycle rate by rounding up (device_execute_interface clocks_to_cycles:
// (3579545 + 3) / 4 = 894887 Hz) while its VDG runs at 3579545 Hz, so a CPU cycle lasts MAME_R x 4 VDG
// clocks and the two drift apart by 0.84 ppm. Measured with tools/mame-diff/run.js mc10 --raster: MAME's
// latch writes land at exactly 4 x MAME_R x (the instruction's start cycle) VDG clocks.
const MAME_R = Number(10n ** 18n / 894887n) / Number(4n * (10n ** 18n / 3579545n));
const VIDEO_BITS = 0x7C;         // latch bits 2-6: GM2 and INT/EXT, GM1, GM0, A/G, CSS (bit 7 is sound)

// Keys without a switch of their own are CONTROL + a letter position (the arrow legends of the
// MC-10 keyboard; matrix positions as in MAME, the same positions on the Alice): [row, column]
const VIRTUAL = { LEFT: [0, 1], RIGHT: [2, 3], UP: [2, 7], DOWN: [3, 2], CLEAR: [2, 1] };
const CTRL = [6, 0];

// ---- no-ROM stub firmware ----
// POLCAT $F883 (poll keyboard: A = key or 0, Z set when none) and CHROUT $F9C6 (print A) are
// the MC-10 ROM entry points given in published MC-10 documentation (not verifiable against
// MAME, which has no knowledge of the ROM); no other ROM routine is assumed.
const STUB = stubRom('6803', 0x2000, 0xE000);

class Mc10Machine extends Machine {
  constructor(profile, config) {
    super(profile, config, { tickHz: CPU_HZ, lineCycles: LINE_CYCLES, lines: LINES, resetOffset: 0, ramSize: 0x10000 });
    // this.ram is an address-space view: RAM at $4000.., the 6803's on-chip RAM at $80-$FF
    this.ramEnd = 0x4000 + config.ram * 1024;
    this.rom = null;
    this.cpu = new cpus[config.cpu](this);
    this.cpu.mameCompat = config.mameCompat;   // two MAME bookkeeping artefacts (comparisons only)
    this.interrupts = new InterruptHub(this.cpu);   // no external sources: the 6803's interrupts are on-chip
    this.cpu.iram = this.ram.subarray(0x80, 0x100);
    this.vdg = new MC6847();
    this.bitBanger = new SerialPort(CPU_HZ, (b) => this.printed.push(b));   // the RS-232 port: a serial printer by default
    this.spanBytes = new Uint8Array(32);
    this.lineTicks = config.mameCompat ? LINE_CYCLES / MAME_R : LINE_CYCLES;   // one line in CPU cycles
    this.lineCount = 0;            // lines since power-on (MAME's HS-on count, for mameCompat)
    this.beam = null;              // the active scanline being drawn: { y, body, pos, fetched, pixel, rowStart, latch, lastMode, lineStart }
    this.on('line', (line, at) => this.lineEvent(line, at));
    this.vdg.artifact = 1;          // composite colour on, MAME's default ("Standard" phase)
    this.screenWidth = MC6847.WIDTH;
    this.screenHeight = MC6847.HEIGHT;
    this.pressed = new Set();
    this.strobe = 0;                // port 1 output as seen by the keyboard
    this.latch = 0;                 // $BFFF video/sound latch
    this.casReads = 0;
    this.lastCasRead = -1e9;
    this.deck.onInsert = () => { this.deck.setMotor(false); this.casReads = 0; };
    this.deck.motorless = true;   // no motor relay: a recording takes everything written to the cassette output
    this.stubCursor = 0x4000;
    this.installStub(STUB.symbols, new TextConsole(this.ram, 0x4000, () => this.stubCursor, (pos) => { this.stubCursor = pos; }),
      () => this.stubInit());
  }

  romsChanged() {
    const d = this.roms[this.profile.roms[0].id];
    if (!d) { this.rom = null; return; }
    const rom = new Uint8Array(0x2000).fill(0xFF);
    rom.set(d.subarray(Math.max(0, d.length - 0x2000)).subarray(0, 0x2000)); // an 8K image (or the top 8K of a larger one)
    this.rom = rom;
  }

  // ---------------- bus (external accesses from the CPU) ----------------
  read(a) {
    if (a >= 0x4000 && a < this.ramEnd) return this.ram[a];
    if (a >= 0xE000) return (this.rom || STUB.rom)[a - 0xE000];
    if (a === 0xBFFF) { this.casReads = 0; return 0xFF & ~this.scanKeys(this.strobe); }
    return 0x00;
  }
  // Why a write at `a` would not be seen (see Machine.writeKind), for the write path the tools use
  // (Machine.poke). RAM is the fitted 4K or 20K above $4000 and the 6803's on-chip RAM at $0080-$00FF while
  // its RAM control register enables it (cpu.ramc bit 6; cpu6803.js write8). The ROM is $E000 and up. The
  // 6803's own registers are $0000-$0014. $BFFF is the video/sound latch: the CPU can write it
  // (Mc10Machine.write handles it), but poke() does not route there, so a poke there is lost and says so.
  writeKind(a) {
    a &= 0xFFFF;
    const cpu = this.cpu;
    if (a >= 0x80 && a < 0x100) return cpu && cpu.iram && (cpu.ramc & 0x40) ? null : 'undecoded';
    if (a < 0x15) return 'io';                     // the 6803's own registers, $0000-$0014 (cpu6803.js regWrite); $0015-$001F reach the bus, where nothing answers
    if (a >= 0x4000 && a < this.ramEnd) return null;
    if (a === 0xBFFF) return 'latch';              // writable by the CPU; a poke does not reach it
    if (a >= 0xE000) return 'rom';
    if (a >= 0x4000) return 'absent-ram';
    return 'undecoded';                            // the write never reaches a device
  }
  // A side-effect-free read (see Machine.peek): the fitted RAM, the ROM, and the 6803's on-chip RAM at
  // $0080-$00FF while its RAM control register enables it - the same addresses read() answers from memory.
  // The one address it cannot match is $BFFF, the keyboard: a real read there clears the cassette counter and
  // its value depends on which columns are strobed, so peek answers what a keyboard with no keys down gives.
  peek(a) {
    a &= 0xFFFF;
    if (a < 0x100) {
      const cpu = this.cpu;
      if (a >= 0x80 && cpu && cpu.iram && (cpu.ramc & 0x40)) return cpu.iram[a - 0x80];
    }
    if (a >= 0x4000 && a < this.ramEnd) return this.ram[a];
    if (a >= 0xE000) return (this.rom || STUB.rom)[a - 0xE000];
    if (a === 0xBFFF) return 0xFF;                 // the keyboard: no side-effect-free answer (see above)
    return 0x00;
  }
  write(a, v) {
    if (a >= 0x4000 && a < this.ramEnd) { this.ram[a] = v; return; }
    if (a === 0xBFFF) {
      if ((v ^ this.latch) & VIDEO_BITS) {
        // the time of the write: the start of its bus cycle, or in MAME the instruction's start (its 6801 core
        // advances the clock after an instruction); first bring the beam to the line it lands in
        // (MAME runs an instruction before a timer only if a whole cycle is left before it, so a line can
        // start under an instruction that then executes with an earlier time: see latchChanged)
        const t = this.config.mameCompat ? this.cycle : this.ioTime();
        if (this.config.mameCompat) this.processEventsBefore(t + 1); else this.processEvents(t);
        this.latchChanged(t, v);
      }
      this.latch = v;
      this.casReads = 0;
      this.setSoundLevel(v & 0x80 ? 1 : 0);
    }
  }
  // The video/sound latch just changed. The MC-10's CPU cannot see the raster (the VDG's sync
  // outputs are not wired to it), but the beam is at a definite position: the machine's time line
  // is the VDG's clock, so the current line and the position within it are known. If the beam is
  // inside the active display, the part of the line already converted keeps the old latch value
  // and the rest uses the new one - the VDG has no line buffer. Lines are drawn as they end, so
  // this only affects the line in progress.
  // at: the time of the write (see write). On hardware the VDG sees the new value at the end of the write's
  // bus cycle, as on the SAM machines (js/machines/sam.js modeChanged). In MAME it sees it at that time in its
  // own clock (MAME_R), and its mc6847 measures from the HS-on timer's start, which attotime_to_clocks
  // truncates to one clock early (mc6847.cpp get_clocks_since_hsync), so the write lands a clock later.
  //   One more MAME artefact: when the line's HS-on timer has fired but the instruction runs with a time
  // just before it (less than a cycle was left), the clocks since HS-on are negative, and stored unsigned
  // (video_flush's new_partial_scanline_clocks) they suppress every further split of that line, which is then
  // recorded whole, from position 0, with the mode it ends in (frozen).
  latchChanged(at, v) {
    const b = this.beam;
    if (!b) return;
    if (!b.frozen) {
      if (this.config.mameCompat) {
        const clocks = Math.floor(4 * MAME_R * at) - (228 * b.lineCount - 1);
        if (clocks < 0) b.frozen = true;
        else this.advanceBeam(MC6847.positionFromClock(clocks));
      } else this.advanceBeam(MC6847.positionFromClock((at + 1 - b.lineStart) * CLOCKS_PER_TICK));
    }
    b.latch = v;                                   // the rest of the line uses the new value
  }
  // Draw byte positions [from, to) of the beam's line with the latch value the beam holds,
  // fetching from the VDG's own address counter (the MC-10 has no SAM) as the beam passes.
  fetchAndDraw(b, from, to) {
    const mode = this.vdgMode(b.latch);
    const modulo = MC6847.sampleModulo(mode);
    const span = this.spanBytes;
    const size = this.ramEnd - 0x4000, wrap = size < 0x1800 ? size : 0x10000;
    // The VDG generates the address itself: the line's row times its bytes per row, both from the mode in
    // force when it reads position 0, then one more per fetched byte; b.fetched counts what this line has
    // already taken, so a span starting part way along continues the sequence (MAME's mc6847.cpp:
    // m_video_address = scanline / (192 / yres) * sample_count at position 0, then m_video_address++).
    if (from === 0) { const [bpl, rep] = MC6847.addressing(mode); b.rowStart = Math.floor(b.body / rep) * bpl; }
    let n = 0;
    for (let pos = from; pos < to; pos++) {
      if (pos % modulo === 0) span[n++] = this.ram[0x4000 + ((b.rowStart + b.fetched + n - 1) % wrap)];
    }
    b.fetched += n;
    if (n) b.lastMode = mode;
    b.pixel = this.vdg.drawSamples(b.y, mode, b.body % 12, span, n, b.pixel);
  }
  advanceBeam(pos) {
    const b = this.beam;
    if (!b) return;
    const to = Math.max(b.pos, Math.min(32, pos));
    if (to > b.pos) this.fetchAndDraw(b, b.pos, to);
    b.pos = to;
  }
  // 6803 port pins
  portRead(n) {
    if (n === 1) return this.strobe;   // the strobe lines read back (as MAME)
    if (n !== 2) return 0xFF;
    // P20 high; RS-232 in (bit 2): the device's RXD; printer ready (bit 3): its CTS (MAME mc10.cpp mc10_port2_r;
    // both 0 from MAME's default printer)
    let v = 0xE3 | (this.bitBanger.rxd(this.ioTime()) << 2) | (this.bitBanger.cts << 3);
    if (this.keyRowsForCols(this.strobe) & 0x40) v &= ~0x02;
    if (this.casInput()) v |= 0x10;
    return v;
  }
  portWrite(n, v) {
    if (n === 1) { this.strobe = v; this.casReads = 0; }
    else if (n === 2) {
      // P20: cassette out, and the serial printer's input (MAME mc10.cpp mc10_port2_w)
      this.deck.output(v & 1);
      this.bitBanger.txd(this.ioTime(), v & 1);
    }
  }

  // ---------------- keyboard: physical keys plus CONTROL combinations ----------------
  setKey(name, down) {
    if (!this.keyPos[name] && !VIRTUAL[name]) return;
    if (down) this.pressed.add(name); else this.pressed.delete(name);
    this.keyCols.fill(0);
    const press = ([r, c]) => { this.keyCols[c] |= 1 << r; };
    for (const k of this.pressed) {
      if (this.keyPos[k]) press(this.keyPos[k]);
      else { press(CTRL); press(VIRTUAL[k]); }
    }
  }
  clearKeys() { if (this.pressed) this.pressed.clear(); this.keyCols.fill(0); }

  // ---------------- cassette ----------------
  // The MC-10 has no motor control. The tape is started when the program polls the cassette
  // input in a tight loop (8 port 2 reads with no keyboard access in between) and stopped once it
  // has not been read for a quarter of a second, so a tape can be inserted before typing CLOAD.
  casInput() {
    const deck = this.deck;
    if (!deck.tape) return true; // no signal reads as 1 (as in MAME)
    this.lastCasRead = this.now();
    if (!deck.motor && ++this.casReads >= 8 && !deck.tape.atEnd()) deck.setMotor(true);
    return deck.level();
  }
  // (runTo, a debugger's run to the frame's end, goes on to Machine.runFrame: the tape check is after a closed frame)
  runFrame(runTo = null) {
    if (!super.runFrame(runTo)) return false;
    const deck = this.deck;
    if (deck.motor && (!deck.tape || deck.tape.atEnd() || this.now() - this.lastCasRead > this.tickHz / 4)) {
      deck.setMotor(false); this.casReads = 0;
    }
    return true;
  }

  // ---------------- video ----------------
  // VDG mode in the layout MC6847.render expects (bit 7 A/G, 6 GM2, 5 GM1, 4 GM0 or INT/EXT, 3 CSS)
  vdgMode(latch) {
    const l = latch === undefined ? this.latch : latch, ag = (l >> 5) & 1;
    return (ag << 7) | (((l >> 2) & 1) << 6) | (((l >> 3) & 1) << 5) |
      ((ag ? (l >> 4) & 1 : (l >> 2) & 1) << 4) | (((l >> 6) & 1) << 3);
  }
  render() { return this.vdg.frame; }
  // composite colour (the Display tab): 0 off (RGB), 1 or 2 the NTSC artifact phase
  setComposite(setting) { this.vdg.artifact = setting; }

  // Scanlines are drawn as the beam passes (render-only events: the MC-10's CPU can't see the
  // VDG's sync signals). The VDG generates its own addresses from $4000, per its mode, wrapping
  // within the fitted RAM.
  startTimeline() { this.lineCount = 0; this.schedule(this.frameBase, 'line', 0, 0); }
  lineEvent(line, at) {
    this.recordLine(line === 0 ? LINES - 1 : line - 1);          // finish the line that ended
    // start the new line: fetch its data and record where the beam is, so a mid-line latch write
    // can split it
    const body = line - BODY_START;
    const y = body + MC6847.BORDER_Y;
    if (y >= 0 && y < MC6847.HEIGHT) {
      if (body < 0 || body > 191) this.beam = null;
      else {
        const mode = this.vdgMode();
        this.beam = { y, body, pos: 0, fetched: 0, pixel: 0, rowStart: 0, latch: this.latch, lastMode: mode, lineStart: at, lineCount: this.lineCount, frozen: false };
      }
    }
    this.lineCount++;
    this.schedule(at + this.lineTicks, 'line', line + 1 === LINES ? 0 : line + 1, 0);
  }
  // Finish a scanline: active lines were drawn as the beam passed (lineEvent, then a span per
  // mid-line latch change), so only the part after the last change is left; border lines are
  // drawn whole here.
  recordLine(line) {
    const body = line - BODY_START, y = body + MC6847.BORDER_Y;
    if (y < 0 || y >= MC6847.HEIGHT) { this.beam = null; return; }
    const b = this.beam;
    if (b && b.y === y) {
      if (b.frozen) Object.assign(b, { pos: 0, fetched: 0, pixel: 0 });   // recorded whole with its final mode (see latchChanged)
      this.advanceBeam(32);
      this.vdg.endLine(y, b.lastMode, b.pixel, this.config.mameCompat);
      this.beam = null;
    } else if (body < 0 || body > 191) this.vdg.borderLine(y, this.vdgMode());
  }

  resetHardware() {
    this.beam = null;
    this.strobe = 0;          // as MAME's driver_reset
    this.latch = 0;
    this.setSoundLevel(0);
    this.deck.setMotor(false);
    this.casReads = 0;
  }

  poke(a, v) {
    a &= 0xFFFF;
    if ((a >= 0x80 && a < 0x100) || (a >= 0x4000 && a < this.ramEnd)) this.ram[a] = v;
    // landed = the CPU would see it: the on-chip RAM only while its control register enables it (writeKind)
    return this.writeKind(a) === null;
  }

  // ---------------- state ----------------
  saveState() {
    return Object.assign(super.saveState(), state.save(this, Mc10Machine.STATE), {
      beam: this.beam ? Object.assign({}, this.beam) : null,
      vdg: this.vdg.saveState(),
    });
  }
  loadState(s) {
    super.loadState(s);
    state.load(this, s, Mc10Machine.STATE);
    if (!('beam' in s)) throw new Error('snapshot: missing "beam"');
    this.beam = s.beam ? Object.assign({}, s.beam) : null;
    this.vdg.loadState(s.vdg);
    this.pressed.clear();
  }

  // ---------------- no-ROM stub ----------------
  stubInit() {
    const cpu = this.cpu;
    cpu.write8(0x00, 0xFF); cpu.write8(0x02, 0xFF);   // port 1: keyboard strobes, all high
    cpu.write8(0x01, 0x01); cpu.write8(0x03, 0x01);   // port 2: P20 (cassette out) is an output
    this.write(0xBFFF, 0x00);                          // text mode, sound low
    cpu.s = this.ramEnd - 1;
    cpu.cc = 0xC0 | CPU6803.FLAGS.I;
    this.stubConsole.print('\f' + banner(this.profile.name, 'DROP A BINARY OR TAPE IMAGE').replace('ROMS', 'ROM'));
    cpu.pc = STUB.symbols.get('IDLE');
  }
}

// Micro Color BASIC's TXTTAB $93, VARTAB $95, ARYTAB $97, ARYEND $99 (the Color BASIC layout moved
// to $93; from MC-10 memory maps, not verified against a ROM here)
Mc10Machine.BASIC_POINTERS = 0x93;
Mc10Machine.STATE = ['strobe', 'latch', 'casReads', 'lastCasRead', 'stubCursor', 'lineCount'];

export { Mc10Machine };
