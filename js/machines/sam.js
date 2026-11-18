/*
 * SamMachine: the SAM-based family - Dragon 32/64/200, Tano Dragon, Tandy Color Computer 1/2
 * and clones. 6809 + MC6883 SAM + two MC6821 PIAs + MC6847 VDG (or MC6847T1).
 * Verified instruction-for-instruction (registers and cycle counts) against MAME; see tools/mame-diff.
 *
 * CPU rate (SAM R1..R0, the "speed POKEs"). MC6883 data sheet (Motorola, Advance Information; page numbers of
 * the 25-page scan): p. 11 "Changing the MPU Rate" and p. 16 "MPU Rate".
 *   00 slow: E = crystal / 16 for every cycle (one tick here).
 *   01 address dependent: crystal / 16 when the MPU addresses $0000-$7FFF or $FF00-$FF1F, crystal / 8
 *      otherwise (ROM, other I/O, and the $FFFF of internal cycles) (p. 11). With map type 1 the RAM above
 *      $8000 is slow too: the data sheet doesn't say, but p. 11 promises that this mode keeps VDG and refresh
 *      access transparent, which a fast RAM cycle would break (XRoar does the same).
 *   1x fast: crystal / 8 for every cycle, "by stealing the time that is normally used for VDG/REFRESH"
 *      (p. 11; Figure 3, p. 6: the VDG's time slot carries a second MPU address).
 * Each 6809 bus cycle is timed by the address it presents (cpu.cycleAddr). Changing speed costs odd cycle
 * lengths while the SAM keeps slow cycles interleaved with the VDG (Figure 8, p. 11, shows the stretched
 * cycles but not their length): 16 crystal clocks slow, 8 fast, 15 slow-to-fast, 17 fast-to-slow, or 25 when
 * an odd number of fast cycles has put the SAM out of step with the VDG. These lengths are XRoar's
 * (src/mc6883.c, mc6883_mem_cycle); tools/mame-diff/sam compares our timing with XRoar's per instruction.
 * With config.mameCompat, every cycle is fast at any non-zero rate and there are no transition cycles, as in
 * MAME 0.264 (src/devices/machine/6883sam.cpp, update_cpu_clock: "dual speed ???"); and a rate change
 * re-times the cycles already run in MAME's current scheduler slice at the new clock, as MAME's
 * set_unscaled_clock does (the same artefact as the CoCo 3's speed switch; see js/machines/coco3.js). That
 * model follows MAME's scheduler exactly (mameStop), including its whole-Hz clocks (mamePeriods).
 */
import { MC6821 } from '../chips/mc6821.js';
import { MC6847 } from '../chips/mc6847.js';
import { SAM6883 } from '../chips/sam6883.js';
import { cpus } from '../cpu/cpus.js';
import { Acia6551, InterruptHub } from './bus.js';
import { wireCocoPias } from './cocopia.js';
import { SerialPort } from './rs232.js';
import { Machine } from './machine.js';
import { TextConsole, banner, stubRom } from './stub.js';
import { state } from '../util.js';

const CLOCKS_PER_TICK = 4;  // this machine's tick is one CPU cycle = 4 VDG clocks
const VDG_BITS = 0xF8;      // PIA1 PB3-PB7: CSS, GM0 (INT/EXT), GM1, GM2, A/G
const LINE_CYCLES = 57;   // 228 VDG clocks
const RATE_BITS = 3 << 11;  // SAM R1..R0 in SAM6883.reg
const R1_BIT = 1 << 12;     // R1: fast everywhere, the VDG's time slot carries MPU addresses
const ACTIVE_START = 11.875; // first video byte, ticks after the line period starts (HS fall + 254 crystal clocks)
// cycle lengths in crystal clocks (1/16 tick): slow, fast, slow->fast, fast->slow, fast->slow re-interleaving
const SLOW = 16, FAST = 8, TO_FAST = 15, TO_SLOW = 17, TO_SLOW_RESYNC = 25;
const SYNC_CYCLE = 53;    // HS falls / FS changes at VDG clock 212 of the line
// The VDG is an NTSC part (262 lines). PAL machines pad each field to 312 lines by holding it for
// 25 lines at the top and 25 lines near the bottom; HS pulses are not seen during padding lines.
// resetOffset: CPU cycles between power-on (video timing origin) and the first instruction.
// xtal: the crystal as MAME 0.264 gives it in Hz (coco12.cpp XTAL(14'318'181), dragon.cpp 14.218_MHz_XTAL).
const TIMING = {
  ntsc: { tickHz: 14318180 / 16, xtal: 14318181, lines: 262, fsLow: 216, fsHigh: 248, pad: () => false, resetOffset: 4 },
  pal: { tickHz: 14218000 / 16, xtal: 14218000, lines: 312, fsLow: 241, fsHigh: 298, pad: (l) => l < 25 || (l >= 266 && l < 291), resetOffset: 4 },
};
// MAME's CPU cycle at the slow and fast rate in ticks (4 VDG clocks). MAME keeps every clock as whole Hz
// and every period as whole attoseconds (HZ_TO_ATTOSECONDS), so from 14.318181 MHz the CPU (/16 = 894886 Hz)
// runs 0.28 ppm slower than a quarter of the VDG clock (/4 = 3579545 Hz); from 14.218 MHz they divide exactly
function mamePeriods(xtal) {
  const as = (hz) => 10n ** 18n / BigInt(Math.floor(hz));
  const tick = 4n * as(xtal / 4);
  return [Number(as(xtal / 16)) / Number(tick), Number(as(xtal / 8)) / Number(tick)];
}

// no-ROM stub firmware (js/machines/stub.js): 16K at $8000, the Color BASIC call vectors at $A000
const STUB = stubRom('6809', 0x4000, 0x8000);

class SamMachine extends Machine {
  constructor(profile, config) {
    const t = TIMING[profile.video];
    super(profile, config, { tickHz: t.tickHz, lineCycles: LINE_CYCLES, lines: t.lines, resetOffset: t.resetOffset });
    this.timing = t;
    this.mameP = mamePeriods(t.xtal);
    if (config.mameCompat) this.unitAttos = 10n ** 18n / BigInt(Math.floor(t.xtal / 16));   // MAME's CPU cycle (clockUnits)
    // RAM installed: MAME's coco12.cpp installs the fitted RAM over $0000..ramSize-1 and leaves everything
    // above it unreadable (`nop_readwrite`), so absent RAM reads 0 and writes are lost (see ramAddr for which
    // RAM address a CPU address reaches).
    this.ramSize = config.ram * 1024;
    this.romBanks = [null, null];

    this.cpu = new cpus[config.cpu](this);
    this.cpu.mameCompat = !!config.mameCompat;   // MAME's m6809 SYNC timing (comparisons only)
    this.interrupts = new InterruptHub(this.cpu);
    if (profile.acia) { this.acia = new Acia6551(); this.acia.attach(this); }   // Dragon 64 serial port at $FF04-$FF07
    this.sam = new SAM6883();
    this.pia0 = new MC6821();
    this.pia1 = new MC6821();
    this.pia1.b.c1 = false;          // CB1 (CART) starts low, as MAME's 6821 (m_in_cb1 = 0)
    this.vdg = new MC6847();
    this.vdg.t1 = profile.vdg === 't1';
    this.vdg.pal = profile.video === 'pal';
    this.vdg.artifact = 1;          // composite colour on, MAME's default ("Standard" phase on NTSC)
    // Dragon 200-E: a character generator ROM in place of the internal set, reached through the driver's
    // rewired VDG inputs (profiles.js: profile.charGen). Without the ROM the chip's stripe pattern shows,
    // as on any Dragon.
    this.charRom = null;
    if (profile.charGen) {
      this.vdg.extIntFromData = !!profile.charGen.intExtFromData;
      // LK1 "Inverse Video" (MAME's dragon200e input ports: confsetting 0 "Inverse", 1 "Normal", value 1 the
      // default). MAME's driver asserts the VDG's INV input while the link reads 1, so its "Normal" position
      // is the one that inverts the picture. We follow the driver exactly, and the option names its setting.
      this.vdg.invInput = !config.inverseVideo;
      // char_rom_r(): (raster line << 8) | (PIA1 PB4 << 7) | byte, masked to the 4K chip. PB4 is an address
      // line into the character generator (MAME's dragon.cpp dragon200e_state::char_rom_r reads it as one),
      // so on the hardware the bank is whatever PB4 holds at the instant of each fetch, and a mid-line change
      // splits the line like any other VDG input.
      this.vdg.getCharRom = (byte, line, bank) => this.charRom ? this.charRom[((line << 8) | (bank << 7) | byte) & 0xFFF] : 0;
      // config.mameCompat: MAME calls char_rom_r() from screen_update, after the field has run, so one sample
      // of PB4 selects the bank for a whole field (gime/mc6847 draw a frame at a time). The comparison needs
      // that to match: with the hardware's per-fetch read, MAME's own frames of the raster firmware's PB4
      // sweeps differ by 1,148 and 778 px (cases 5 and 6), and held per field they agree exactly.
      this.charBankHold = !!config.mameCompat;
      this.charBankLatch = 0;
      this.vdgBankBit = 0x10;
      // config.mameCompat: MAME's own INTEXT bit (see the PIA1 write in write()). Its 200-E driver drives the VDG's INTEXT
      // from two places: sam_read() sets it from every fetched byte (/D7) and the CoCo/Dragon pia1_pb_changed()
      // sets it from PB4 on every port B write. When the two disagree, the PB write is a VDG mode change to
      // MAME's mc6847 (change_mode() -> video_flush()), and the line splits there, although nothing on the
      // screen changes. On the hardware PB4 reaches only the character generator (dragon.cpp's own
      // char_rom_r()), so this follows MAME only.
      this.mameIntextTrack = !!config.mameCompat;
      this.mameIntext = 0;
    } else { this.vdgBankBit = 0; this.charBankHold = false; this.charBankLatch = 0; this.mameIntextTrack = false; this.mameIntext = 0; }
    this.spanBytes = new Uint8Array(32);   // bytes fetched for one span of a line
    this.displayByteRead = (a) => this.displayByte(a);   // bound: the SAM calls it as a plain function
    this.beam = null;                // the active scanline being drawn: { y, body, mode, pos, bytes, lineStart }
    this.screenWidth = MC6847.WIDTH;
    this.screenHeight = MC6847.HEIGHT;

    // CPU rate: speed state carried from cycle to cycle, and the SAM register changes within a step
    this.runningFast = false;   // the last bus cycle was fast
    this.extendSlow = false;    // an odd number of fast cycles since the last slow one
    this.stepStart = 0;         // tick at which the current step started
    this.stepCycles = 0;        // the CPU's cycle count then
    this.stepReg = 0;           // SAM register at the start of the step
    this.regLog = [];           // [cycle index, register value from that cycle on, ...] during a step
    // MAME's scheduler slices (config.mameCompat only; see mameStop): the CPU's local time at the slice start
    this.sliceStart = 0;
    this.sliceBase = 0;         // cycles of the slice run before the current step
    this.sliceP = 1;            // period when the slice started (set at reset)
    this.inStep = false;
    this.haltInfo = null;       // HALT that arrived inside an instruction (mameCompat; see haltChanged)
    // fast rate (R1) video: the CPU's bus cycles while R1 is set, [start tick, RAM address or -1, fast], and
    // the RAM address the SAM last presented before them (see stolenByte)
    this.vlog = [];
    this.vz = 0;
    this.cycleStarts = new Float64Array(128);
    if (config.mameCompat) this.processEvents = this.processEventsMame;

    this.on('line', (line, at) => this.lineStart(line, at));
    this.on('hsFall', (line) => this.hsFall(line));
    this.wireIO();
    this.installStub(STUB.symbols, new TextConsole(this.ram, 0x400, () => (this.ram[0x88] << 8) | this.ram[0x89],
      (pos) => { this.ram[0x88] = pos >> 8; this.ram[0x89] = pos & 0xFF; }), () => this.stubInit());
  }

  get hasCartridgePort() { return true; }

  // one byte of the memory the SAM drives, at a display address the SAM counter produced (js/chips/sam6883.js
  // displayRead). The family's RAM mapping decides what is there; the Dragon 64 Plus overrides it with its
  // RAM banks and its video-RAM overlay.
  displayByte(a) { return this.ram[a]; }

  // ---------------- ROMs ----------------
  romsChanged() {
    if (!this.hasRom) { this.romBanks = [null, null]; this.charRom = null; return; }
    const banks = [new Uint8Array(0x4000).fill(0xFF), null];
    let charRom = null;
    for (const s of this.profile.roms) {
      const data = this.roms[s.id];
      if (!data) continue;
      if (s.chip) { charRom = data.subarray(0, Math.min(s.size, data.length)); continue; }  // the 200-E's generator
      if (s.bank === 1 && !banks[1]) banks[1] = new Uint8Array(0x4000).fill(0xFF);
      banks[s.bank].set(data.subarray(0, Math.min(s.size, data.length)), s.at - 0x8000);
    }
    this.romBanks = banks;
    this.charRom = charRom;
  }
  currentRom() {
    const b = this.romBanks;
    if (!b[0]) return STUB.rom;
    if (b[1] && this.profile.bankSelect && !(this.pia1.b.outValue() & 0x04)) return b[1]; // Dragon 64: PIA1 PB2
    return b[0];
  }

  // ---------------- I/O wiring ----------------
  // PIA1 port B's input pins as MAME 0.264 wires them on every Dragon and CoCo 1/2 (coco.cpp coco_state::pia1_pb_r,
  // used by coco12.cpp and dragon.cpp): bit 2 is the RAM size sense, high with 16K-32K of RAM or, with 32K or
  // more, following PIA0 PB6 (a pin set as an input counts as high: PIA0 port B's three-state value is $FF,
  // tspb_handler); bit 0 is the RS-232 port's received data (rxd_r): on the CoCo the bit-banger's (a serial printer
  // by default, which holds it low), on the Dragon 64, 200 and Tano (profile rs232) the 6551's port (idle high with
  // nothing connected); the Dragon 32 has no port, and MAME's Alpha has the 6551 but no port (dgnalpha.cpp, so
  // m_rs232 is null), so 0; the other pins read 0
  pb1Input() {
    const k = this.config.ram, p0 = this.pia0;
    const serial = this.profile.keyboard !== 'dragon' ? () => this.bitBanger.rxd(this.ioTime())
      : this.profile.rs232 ? () => this.acia.port.rxd(this.ioTime()) : () => 0;
    return () => ((k >= 16 && k < 32) || (k >= 32 && (p0.b.outValue() & 0x40)) ? 0x04 : 0x00) | serial();
  }
  wireIO() {
    const dragon = this.profile.keyboard === 'dragon';
    wireCocoPias(this, { pb1Input: this.pb1Input(), hires: this.config.hires });
    if (dragon) {
      // Dragon parallel printer: PIA1 PA1 is the strobe; each PIA1 port A output with it high prints PIA0's port B
      // (MAME dragon.cpp pia1_pa_changed)
      this.pia1.a.onOutput = (v) => { if (v & 0x02) this.printed.push(this.pia0.b.outValue()); };
    } else {
      // CoCo bit-banger serial port: TXD is PIA1 PA1 (MAME coco.cpp update_prinout); a serial printer by default
      this.bitBanger = new SerialPort(this.tickHz, (b) => this.printed.push(b));
      this.pia1.a.onOutput = (v) => this.bitBanger.txd(this.ioTime(), (v >> 1) & 1);
    }
  }

  // ---------------- memory map ----------------
  // The RAM address the SAM presents for a CPU address, or -1 where the CPU reaches no RAM (ROM, I/O). In the 64K
  // modes (M1 set): map type 1 (TY) makes $0000-$FEFF all RAM; in map type 0, page bit P1 moves $0000-$7FFF onto
  // the upper 32K of RAM. M1 clear (4K and 16K modes): $0000-$7FFF only, P1 and TY have no effect. As MAME 0.264
  // (src/devices/machine/6883sam.cpp, sam6883_device::read and ::write; MC6883 data sheet, Table 1 and the P1
  // note: "page #1 ... only in 64K mode, map type 0").
  ramAddr(a, reg) {
    if (a < 0x8000) return (reg & 0xC400) === 0x4400 ? a | 0x8000 : a;   // M1 (bit 14) and P1 (bit 10), TY (bit 15) clear
    return a < 0xFF00 && (reg & 0xC000) === 0xC000 ? a : -1;
  }
  // Why a write at `a` would not be seen (see Machine.writeKind): the I/O page, the vectors at $FFE0-$FFFF
  // (which come from the ROM's last 32 bytes on a 6809 machine), the ROM below $C000 in a map that shows it,
  // the cartridge ROM (with or without a cartridge fitted), and RAM the machine does not have fitted.
  // A fitted cartridge is ROM too: sam.js write() writes only where ramAddr says RAM, and no device takes a
  // bus write in $C000-$DFFF (cartridges install handlers in I/O, never in the ROM window), so a write there
  // is lost whether or not one is plugged in. Classifying it as writable made a poke of the byte it already
  // holds report false success - the same bug the vector page had.
  // Measured, not assumed: on a 4K CoCo, peek($1000) is $00 because MAME leaves RAM above the fitted size
  // unreadable. peek($FF00) is $FF for the whole I/O page because there is no side-effect-free way to read a
  // PIA port or the ACIA - peek answers $FF there rather than consulting them (see peek above).
  writeKind(a) {
    a &= 0xFFFF;
    if (a >= 0xFF00) return a < 0xFFE0 ? 'io' : 'rom';                    // I/O page; $FFE0-$FFFF is the ROM's vectors
    const ram = this.ramAddr(a, this.sam.reg);
    if (ram >= 0) return ram < this.ramSize ? null : 'absent-ram';
    return 'rom';                                        // the BASIC ROM below $C000, or the cartridge window
  }
  // $0000-$FEFF as the CPU sees it through the SAM: RAM, the BASIC ROM, the cartridge ROM; no side effects
  memRead(a) {
    if (a < 0x8000) {
      const r = (this.sam.reg & 0xC400) === 0x4400 ? a | 0x8000 : a;
      return r < this.ramSize ? this.ram[r] : 0x00;                       // absent RAM reads 0 (as in MAME)
    }
    if ((this.sam.reg & 0xC000) === 0xC000) return a < this.ramSize ? this.ram[a] : 0x00;
    if (a < 0xC000) return this.currentRom()[a - 0x8000];
    const cart = this.cartPort && this.cartPort.rom();
    if (cart && cart.length) return cart[(a - 0xC000) % cart.length];
    return 0x00;                                                           // empty cartridge slot (as in MAME)
  }
  // Tools (the Claude chat's peek and poke, the welcome program, the embed API, the debugger's memory view) read
  // and write memory without a bus cycle, but through the same map as the CPU: with P1 or map type 1 set the RAM
  // cell behind an address is not the one with its number. peek: the vectors come from the ROM, the I/O page reads
  // $FF (no register is read for a look). poke: RAM only, as the CPU's write (ROM and absent RAM take nothing).
  peek(a) {
    a &= 0xFFFF;
    if (a < 0xFF00) return this.memRead(a);
    return a >= 0xFFE0 ? this.currentRom()[a - 0xC000] : 0xFF;
  }
  poke(a, v) {
    const r = this.ramAddr(a & 0xFFFF, this.sam.reg);
    if (r >= 0 && r < this.ramSize) { this.ram[r] = v; return true; }
    return false;
  }
  read(a) {
    if (a < 0xFF00) return this.memRead(a);
    // the tick this write takes effect at (the last cycle of the instruction); every I/O
    // register below is timed against it
    const cartIO = a >= 0xFF40 && a < 0xFFC0 && this.cartPort;    // SCS and the cartridge space ($FF60-$FFBF)
    const t = (a < 0xFF60 || cartIO || (a >= 0xFFC0 && a < 0xFFE0)) ? this.ioTime() : 0;
    if (a < 0xFF60 || cartIO) this.processEvents(t);
    if (a < 0xFF20) {
      if (this.acia && (a & 0x1C) === 0x04) return this.acia.readIO(a & 3, t);
      return this.pia0.read(a & 3);
    }
    if (a < 0xFF40) return this.pia1.read(a & 3);
    if (this.becker && (a === 0xFF41 || a === 0xFF42)) return this.becker.readIO(a - 0xFF41);   // (before the cartridge, as MAME)
    if (cartIO) { const v = this.cartPort.readIO(a); if (v !== undefined) return v; }
    // $FF60-$FFBF: unassigned on a CoCo 1/2 and a Dragon; where no cartridge answers, the floating bus (MAME:
    // ff60_read -> floating_space_read)
    if (a >= 0xFF60 && a < 0xFFC0) return this.floatingBus();
    if (a < 0xFFE0) return 0xFF;
    return this.currentRom()[a - 0xC000];                                  // vectors from $BFE0-$BFFF
  }
  // $FF60-$FFBF with nothing there: the data bus holds the byte of the cycle before, a VMA cycle that reads $FFFF,
  // except in no-offset indexed mode (,R), where it is the next instruction's first byte (Darren A's
  // measurements, as MAME 0.264's coco.cpp floating_bus_read models them)
  floatingBus() {
    if (this.inFloatingRead) return 0xFF;                 // (MAME's guard against a read that lands here again)
    this.inFloatingRead = true;
    try {
      const cpu = this.cpu;
      let p = cpu.opPc, op = this.read(p);
      if (op === 0x10 || op === 0x11) op = this.read(p = (p + 1) & 0xFFFF);
      const noOffset = ((op & 0xF0) === 0x60 || (op & 0xF0) === 0xA0 || (op & 0xF0) === 0xE0) && (this.read((p + 1) & 0xFFFF) & 0xBF) === 0x84;
      return this.read(noOffset ? cpu.pc : 0xFFFF);
    } finally { this.inFloatingRead = false; }
  }
  write(a, v) {
    if (a < 0xFF00) {
      const r = this.ramAddr(a, this.sam.reg);
      if (r >= 0 && r < this.ramSize) this.ram[r] = v;                     // map type 0: writes to ROM are lost
      return;
    }
    // the tick this write takes effect at (the last cycle of the instruction); every I/O
    // register below is timed against it
    const cartIO = a >= 0xFF40 && a < 0xFFC0 && this.cartPort;    // SCS and the cartridge space ($FF60-$FFBF)
    const t = (a < 0xFF60 || cartIO || (a >= 0xFFC0 && a < 0xFFE0)) ? this.ioTime() : 0;
    if (a < 0xFF60 || cartIO) this.processEvents(t);
    if (a < 0xFF20) {
      // (an ACIA register write takes effect at the end of its bus cycle, MAME's time for it)
      if (this.acia && (a & 0x1C) === 0x04) this.acia.writeIO(a & 3, v, t + 1);
      else this.pia0.write(a & 3, v);
      return;
    }
    if (a < 0xFF40) {
      const pb = this.pia1.b, m0 = pb.outValue(), ddr0 = pb.ddr;
      this.pia1.write(a & 3, v);
      // only a change of the VDG's own mode inputs splits a line (MAME's mc6847 change_mode() flushes
      // only when its mode changes); PB0-PB2 are sound, RAM size and ROM select. The 200-E also reads
      // PB4 as its character generator's bank, so a change there is a video input too (char_rom_r()).
      let split = ((pb.outValue() ^ m0) & (VDG_BITS | this.vdgBankBit)) !== 0;
      // MAME's 6821 calls the port B handler on every write to the data register, and on a DDR write that
      // changes the DDR (6821pia.cpp port_b_w(), ddr_b_w()); its value has the input pins as 0
      const intext = this.mameIntextTrack && (a & 3) === 2 && ((pb.cr & 4) !== 0 || pb.ddr !== ddr0)
        ? ((pb.or & pb.ddr) >> 4) & 1 : -1;
      if (intext >= 0 && intext !== this.mameIntext) split = true;
      if (split) this.modeChanged(t);                // the flush fetches (and so moves mameIntext) first
      if (intext >= 0) this.mameIntext = intext;
      // MAME approximates a cartridge's CART tied to Q by toggling it on every PIA1 write (coco.cpp ff20_write)
      if (this.config.mameCompat && this.cartPort) this.cartPort.twiddleQ();
      return;
    }
    if (this.becker && (a === 0xFF41 || a === 0xFF42)) { this.becker.writeIO(a - 0xFF41, v); return; }   // (before the cartridge, as MAME)
    if (a < 0xFFC0) { if (this.cartPort) this.cartPort.writeIO(a, v); return; }   // SCS and the cartridge space
    if (a >= 0xFFC0 && a < 0xFFE0) {
      // A SAM write does NOT end the scanline being drawn: MAME's mc6847 calls video_flush()
      // only for the VDG mode bits (ag/gm/css/intext/inv), never for SAM V. The VDG reads a line's
      // bytes when it next flushes (a mode change or the line's end), with the SAM V in force then.
      this.processEvents(t);                                 // a rate change re-times the slice up to here
      this.sam.write(a - 0xFFC0);
      this.regLog.push(this.cpu.cycleCount, this.sam.reg);   // takes effect from the next bus cycle
    }
  }

  // ---------------- CPU rate ----------------
  get rateTimed() { return !!(this.stepReg & RATE_BITS) || this.regLog.length > 0 || this.runningFast; }
  // length in ticks of the first `count` bus cycles of the current step; commit: keep the speed state
  stepTime(count, commit, starts = null) {
    const addrs = this.cpu.cycleAddr, log = this.regLog, compat = this.config.mameCompat;
    let reg = this.stepReg, li = 0, fastNow = this.runningFast, extend = this.extendSlow, t = 0;
    for (let i = 0; i < count; i++) {
      while (li < log.length && log[li] <= i) { reg = log[li + 1]; li += 2; }
      if (starts) { starts[2 * i] = t / 16; starts[2 * i + 1] = reg; }
      const r = (reg >> 11) & 3;
      if (compat) { t += r ? FAST : SLOW; continue; }
      const a = addrs[i];
      const slowAddr = a < 0x8000 || (a < 0xFF00 && (reg >> 15) & 1) || (a & 0xFFE0) === 0xFF00;
      const fast = (r & 2) !== 0 || (r === 1 && !slowAddr);
      if (!fastNow) {
        if (!fast) t += SLOW;
        else { t += TO_FAST; fastNow = true; }
      } else if (!fast) {
        t += extend ? TO_SLOW_RESYNC : TO_SLOW;
        extend = false; fastNow = false;
      } else { t += FAST; extend = !extend; }
    }
    if (commit) { this.runningFast = fastNow; this.extendSlow = extend; }
    return t / 16;
  }
  regReach() { let r = 0; for (let i = 1; i < this.regLog.length; i += 2) r |= this.regLog[i]; return r; }

  // ---- fast rate (R1) video ----
  // "In the fast MPU rate mode, the time slot otherwise used for a VDG address is used for a second MPU
  // address" (MC6883 data sheet, Figure 3 note 1, p. 6); "neither VDG display nor dynamic RAM refresh are
  // available" (p. 11). The data sheet doesn't say what the VDG then shows. We take it, as XRoar does
  // (src/mc6883.c, mc6883_vdg_bytes), that the VDG latches RAM at the row and column the SAM last presented
  // for the MPU, and apply that per video byte: byte k of a line reads RAM at the last RAM address of the CPU
  // bus cycle in progress at its fetch time (ACTIVE_START + k ticks for 32-byte modes; XRoar's mc6847.h
  // places the active line 254 crystal clocks after HS falls). The SAM's video counter advances as usual.
  logVideoSlots(n, steal) {
    const log = this.vlog;
    if (!steal) {                                        // R1 clear for the whole step: note that stealing ended
      if (log.length && log[log.length - 1]) log.push(this.stepStart, -1, 0);
      return;
    }
    const st = this.cycleStarts, addrs = this.cpu.cycleAddr;
    for (let i = 0; i < n; i++) {
      const reg = st[2 * i + 1], a = addrs[i];
      log.push(this.stepStart + st[2 * i], this.ramAddr(a, reg), reg & R1_BIT ? 1 : 0);
    }
  }
  // the byte the VDG latches at tick t if the CPU had the VDG's slot then (the RAM at the last address the
  // SAM presented for the MPU), or -1 if the VDG had its own slot and reads through the display counter
  stolenByte(t) {
    const log = this.vlog;
    let z = this.vz, cur = -1;
    for (let j = 0; j < log.length && log[j] <= t; j += 3) { if (log[j + 1] >= 0) z = log[j + 1]; cur = j; }
    return cur >= 0 && log[cur + 2] ? this.ram[z] : -1;
  }
  // drop bus cycles before tick `at`, keeping the one in progress there
  pruneVideo(at) {
    const log = this.vlog;
    let i = 0;
    while (i + 3 < log.length && log[i + 3] <= at) { if (log[i + 1] >= 0) this.vz = log[i + 1]; i += 3; }
    if (i) log.splice(0, i);
    if (log.length === 3 && !log[2]) { if (log[1] >= 0) this.vz = log[1]; log.length = 0; }
  }

  runCycles(end, steps = Infinity) {
    const cpu = this.cpu, hooks = this.pcHooks;
    const stub = this.useStub;
    while (this.cycle < end && !this.stall && steps-- > 0) {
      this.processEvents(this.cycle);
      if (this.haltInfo) this.haltResume();
      if (stub && this.stubActive()) {
        const hook = hooks.get(cpu.pc);
        if (hook && cpu.willExecute()) hook();
      }
      cpu.c = 0;
      this.stepStart = this.cycle; this.stepReg = this.sam.reg; this.regLog.length = 0;
      this.stepCycles = cpu.totalCycles;     // the CPU's count at the step's start (it moves on when the step ends)
      this.inStep = true;
      const n = cpu.step();
      if (this.config.mameCompat) this.processEventsMame();   // check points after the step's last access
      this.inStep = false;
      if (this.config.mameCompat) {
        this.sliceBase += n;
        this.cycle = this.sliceStart + this.sliceBase * this.periodAfter(n);
        if (this.haltInfo && this.haltInfo.n === null && this.haltInfo.stepTick === this.stepStart) this.haltInfo.n = n;
        this.haltResume();
      } else if (!this.rateTimed) this.cycle += n;              // slow throughout: one tick per cycle
      else {
        const steal = (this.stepReg | this.regReach()) & R1_BIT;
        if (steal && 2 * n > this.cycleStarts.length) this.cycleStarts = new Float64Array(2 * n);   // (a long 6309 TFM)
        this.cycle = this.stepStart + this.stepTime(n, true, steal ? this.cycleStarts : null);
        if (steal || this.vlog.length) this.logVideoSlots(n, steal);
      }
    }
    if (this.config.mameCompat) this.mameStop(0);
  }
  // ---- MAME's model (config.mameCompat): one clock for all cycles, scheduler slices as in MAME ----
  // MAME 0.264 runs the CPU in slices up to the next timer (src/emu/schedule.cpp, timeslice): a slice from
  // the CPU's local time S gets floor((event - S) / period) cycles; m6809 stops at the first check point
  // ('@' in m6809.lst; cpu.cycleNoStop marks cycles without one) once they are spent; its local time becomes
  // S + cycles run x the period at that moment (so a rate change re-times the whole slice, as
  // set_unscaled_clock does); events up to there (and less than a period beyond) fire before it runs on.
  period(reg) { return this.mameP[(reg >> 11) & 3 ? 1 : 0]; }
  // period after the first k cycles of the current step (a SAM write takes effect from the next cycle)
  periodAfter(k) {
    if (!this.inStep) return this.period(this.sam.reg);
    const log = this.regLog;
    let reg = this.stepReg;
    for (let i = 0; i < log.length && log[i] <= k; i += 2) reg = log[i + 1];
    return this.period(reg);
  }
  // the CPU can stop after k cycles of the current step
  mameStop(k) {
    const q = this.queue;
    while (q.length) {
      const pos = this.sliceBase + k;
      if (pos < Math.floor((q[0].at - this.sliceStart) / this.sliceP)) return;
      const p = this.periodAfter(k);              // the slice ends here
      this.sliceStart += pos * p; this.sliceBase = -k; this.sliceP = p;
      while (q.length && q[0].at < this.sliceStart + p) {
        const e = q.shift(), was = this.cpu.haltLine;
        this.fireEvent(e);
        if (was !== this.cpu.haltLine) this.haltChanged(e.at, k);
      }
    }
  }
  // HALT arriving at a check point inside an instruction suspends MAME's 6809 there (device_execute_interface::
  // suspend with eatcycles): its clock goes on in whole cycles from that point, and once HALT is released the
  // rest of the instruction runs. Our 6809 completes the instruction first; cpu.haltTail adds the cycles that
  // make the next instruction start where MAME's does: suspension point + whole cycles until the release +
  // the instruction's remaining cycles.
  haltChanged(at, k) {
    if (this.cpu.haltLine) this.haltInfo = this.inStep && k > 0 ? { stepTick: this.stepStart, k, n: null, release: null } : null;
    else if (this.haltInfo) this.haltInfo.release = at;
  }
  haltResume() {
    const h = this.haltInfo;
    if (!h || h.n === null || h.release === null) return;
    const p = this.mameP[0];
    const next = Math.floor((h.release - h.stepTick) / p) + h.n - h.k;      // cycles from the halted step's start
    this.cpu.haltTail = Math.max(0, next - Math.round((this.cycle - h.stepTick) / p));
    this.haltInfo = null;
  }
  // an I/O access in the current step (inside a step: the check points before the access; between steps: here)
  processEventsMame() {
    const cpu = this.cpu;
    if (!this.inStep) { this.mameStop(0); return; }
    const ns = cpu.cycleNoStop;
    for (let k = 1; k < cpu.cycleCount; k++) if (!ns[k - 1]) this.mameStop(k);
  }
  // exact time (see Machine.clockUnits): with config.mameCompat, MAME's CPU clock: whole cycles run, counting
  // the access's own cycle, and ticks reckoned from the current step (so a time a whole number of cycles away
  // lands exactly on that cycle). MAME's machine time is the CPU's cycles plus the resetOffset cycles before the
  // first one (measured on dgnalpha, whose drives start turning at time 0: an index pulse MAME sees at
  // 0.800002250668 s is at 710898 cycles)
  clockUnits() {
    if (!this.config.mameCompat) return super.clockUnits();
    return (this.inStep ? this.stepCycles + this.cpu.cycleCount : this.cpu.totalCycles) + this.resetOffset;
  }
  tickAt(units) {
    if (!this.config.mameCompat) return super.tickAt(units);
    const p = this.period(this.sam.reg);
    return this.inStep ? this.stepStart + (this.cpu.cycleCount + units) * p : this.cycle + units * p;
  }
  // tick at which the current bus access happens: at the slow rate, the start of the instruction's last cycle
  // (as verified against MAME); otherwise the start of the access's own cycle
  ioTime() {
    if (!this.rateTimed) return this.cycle + (this.cpu.c > 0 ? this.cpu.c - 1 : 0);
    return this.stepStart + this.stepTime(this.cpu.cycleCount - 1, false);
  }

  // ---------------- video timing ----------------
  // Video timing: each line's start event schedules its HS fall and the next line.
  startTimeline() { this.schedule(this.frameBase, 'line', 0, 0); }
  lineStart(line, at) {
    const t = this.timing;
    this.recordLine(line === 0 ? t.lines - 1 : line - 1);                // the line that just ended
    if (this.vlog.length) this.pruneVideo(at);
    if (!t.pad(line)) { this.pia0.setC1('a', true); this.sam.horizontalSync(); } // HS rises
    // CART tied to Q (MAME's model of it, under mameCompat, is the slot's twiddleQ on PIA1 writes)
    if (this.cartPort && this.cartPort.cartLineFollowsQ && !this.config.mameCompat) this.pia1.setC1('b', (line & 1) === 0);
    // start the new line: its borders are drawn now, the active part as the beam passes it
    const body = line - (t.fsLow - 191);
    if (body >= 0 && body <= 191) this.startActiveLine(line, body, at);
    this.schedule(at + SYNC_CYCLE, 'hsFall', line, 0);
    this.schedule(at + LINE_CYCLES, 'line', line + 1 === t.lines ? 0 : line + 1, 0);
  }
  // The beam has reached byte position `pos` of the current line: fetch (through the SAM) and draw what it
  // passed since b.pos with the mode that was in force. MAME's mc6847.cpp does the same: video_flush()
  // records [last flush, now) when the mode changes, and the rest of the line when it ends, so each byte is
  // read with the mode in force when the beam reached it. Positions 32..41 lie past the visible area, but
  // on a line that had a change the VDG still reads them (record_partial_body_scanline() caps a partial
  // line at 42, and record_scanline_res() calls input() at every sampled position up to there): those
  // reads advance the SAM's display counter without drawing. A line without a change stops at 32
  // (record_full_body_scanline).
  advanceBeam(pos) {
    const b = this.beam;
    const to = Math.min(42, pos);
    if (!b || to <= b.pos) return;
    if (b.pos < 32) this.fetchAndDraw(b, b.pos, Math.min(32, to));
    const modulo = Math.round(32 / MC6847.bytesPerLine(b.mode));
    for (let p = Math.max(32, b.pos); p < to; p++) if (p % modulo === 0) this.videoRead(b.fetched++);
    b.pos = to;
  }
  // The line ends: draw the rest of the visible part, and on a line that had a change make the reads past it.
  finishBeam() {
    const b = this.beam;
    if (!b) return;
    this.advanceBeam(b.split ? 42 : 32);
    this.vdg.endLine(b.y, b.lastMode, b.pixel, this.config.mameCompat);
    this.beam = null;
  }
  // Fetch and draw byte positions [from, to) of the beam's line with the beam's mode, advancing
  // the SAM counter for the bytes actually fetched.
  //   The VDG walks its 32 byte positions and reads video memory at every 32/bytes-per-line-th
  //   one, so the number of bytes a span contains depends on the mode in force for that span
  //   (MAME: `pos % sample_modulo == 0` with `sample_modulo = 32 / sample_count`).
  fetchAndDraw(b, from, to) {
    const span = this.spanBytes;
    // the 200-E's generator bank: read at each fetch (hardware) or held for the whole field (mameCompat)
    if (this.charBankHold) this.vdg.charBank = this.charBankLatch;
    else if (this.vdgBankBit) this.vdg.charBank = (this.pia1.b.outValue() >> 4) & 1;
    const modulo = Math.round(32 / MC6847.bytesPerLine(b.mode));
    let n = 0;
    // The VDG passes a monotonic byte index to the SAM (MAME: `input(m_video_address++)`), not
    // the sampled position: the SAM compares the low address bit with its counter's bit 0 to
    // decide whether to bump the counter, so the index must walk 0,1,2... across the whole line.
    // b.fetched counts the bytes already read earlier in this line, so a span that starts part
    // way along continues the sequence instead of restarting it.
    // displayRead() reads at the counter's current position and bumps it when the address bit
    // differs, so the index is the byte's number in the line (0 for the first), passed before the
    // count is incremented - exactly what MAME's `input(m_video_address++)` does.
    // A byte at position pos is fetched ACTIVE_START + pos ticks into the line period; at the fast rate the
    // CPU may hold the VDG's slot then (stolenByte; never with config.mameCompat, as in MAME).
    for (let pos = from; pos < to; pos++) {
      if (pos % modulo) continue;
      let v = this.videoRead(b.fetched + n);
      if (this.vlog.length) { const s = this.stolenByte(b.lineStart + ACTIVE_START + pos); if (s >= 0) v = s; }
      span[n++] = v;
    }
    b.fetched += n;
    if (n) b.lastMode = b.mode;
    b.pixel = this.vdg.drawSamples(b.y, b.mode, b.body % 12, span, n, b.pixel);
  }
  // One display byte through the SAM. With mameIntextTrack, MAME's 200-E sam_read() also sets the VDG's
  // INTEXT from the byte (/D7).
  videoRead(offset) {
    const v = this.sam.displayRead(this.displayByteRead, offset);
    if (this.mameIntextTrack) this.mameIntext = v & 0x80 ? 0 : 1;
    return v;
  }
  // The VDG mode just changed (a PIA1 write). If the beam is inside the active part of a line,
  // everything the beam has passed keeps the mode it was drawn with and the rest is drawn with
  // the new one - the VDG has no line buffer.
  // at: the tick at which the write's bus cycle starts (ioTime()). The PIA latches the data at the end of
  // that cycle (on the falling edge of E), so the VDG sees the new mode one tick later. MAME places every
  // split there too: tools/mame-diff/sam/run-raster.js finds each one a byte position later than the
  // cycle's start would give.
  modeChanged(at) {
    const cur = this.beam;
    if (!cur) return;
    const ticks = at + 1 - cur.lineStart;          // ticks since the line period (HS on) began
    // a tick is 4 VDG clocks (228 clocks per 57-tick line); positionFromClock takes clocks
    this.advanceBeam(MC6847.positionFromClock(ticks * CLOCKS_PER_TICK));
    cur.split = true;                             // this line's record will run on to position 42
    cur.mode = this.pia1.b.outValue();
  }
  startActiveLine(line, body, at) {
    const y = body + MC6847.BORDER_Y;
    const mode = this.pia1.b.outValue();
    this.beam = { y, body, mode, lastMode: mode, pos: 0, fetched: 0, pixel: 0, split: false, lineStart: at };
  }
  hsFall(line) {
    const t = this.timing, p0 = this.pia0;
    if (!t.pad(line)) p0.setC1('a', false);                                // HS falls
    if (line === t.fsLow) {
      p0.setC1('b', false);                                                // FS falls after the last active line
      // config.mameCompat: one bank per field, sampled where MAME samples it - after the picture is complete
      if (this.charBankHold) this.charBankLatch = (this.pia1.b.outValue() >> 4) & 1;
    } else if (line === t.fsHigh) {                                        // FS rises: counter reloads
      p0.setC1('b', true);
      this.sam.resetVideoCounter();
      // MAME resets the counter through the VDG's input callback (mc6847 field_sync_changed(): input(~0)),
      // which reads the byte at the display offset - and the 200-E's sam_read() takes INTEXT from it
      if (this.mameIntextTrack) this.mameIntext = this.displayByte(this.sam.counter & this.sam.counterMask) & 0x80 ? 0 : 1;
    }
  }
  // Draw a scanline into the frame when it ends. Active lines have already been drawn as the beam
  // passed them (startActiveLine, then a span per mid-line mode change), so this only finishes
  // the part after the last change and closes the borders; border lines are drawn here.
  recordLine(line) {
    const body = line - (this.timing.fsLow - 191);            // 0..191 for the active display
    const y = body + MC6847.BORDER_Y;
    if (y < 0 || y >= MC6847.HEIGHT) { this.beam = null; return; }
    if (body < 0 || body > 191) { this.vdg.borderLine(y, this.pia1.b.outValue()); this.beam = null; return; }
    const b = this.beam;
    if (b && b.y === y) {
      this.finishBeam();                           // draw the rest of the line as the beam leaves it
    } else {
      // No beam record: the line was never started, so the SAM counter was never advanced for it.
      // Start it now and draw it whole.
      const mode = this.pia1.b.outValue();
      this.beam = { y, body, mode, lastMode: mode, pos: 0, fetched: 0, pixel: 0, split: false, lineStart: this.cycle };
      this.finishBeam();
    }
  }

  resetHardware(hard) {
    this.beam = null;
    this.sam.reset();
    this.runningFast = false; this.extendSlow = false; this.regLog.length = 0; this.stepReg = 0;
    this.vlog.length = 0;
    this.pia0.reset(); this.pia1.reset();
    if (this.acia) this.acia.reset(hard);
    // CoCo: PIA1 CA1 is the serial port's carrier detect, which the device drives from reset (MAME coco12.cpp:
    // rs232 dcd -> pia1 ca1): low from the printer or a terminal, which latches a falling edge
    if (this.profile.ca1Low) { this.pia1.a.c1 = true; this.pia1.setC1('a', !!this.bitBanger.dcd); }
  }

  reset(hard) {
    super.reset(hard);
    if (hard) { this.sliceStart = this.cycle; this.sliceBase = 0; this.sliceP = this.mameP[0]; }  // the CPU's clock starts here
  }

  render() { return this.vdg.frame; }
  // CART (cartridge pin 8) drives PIA1 CB1, as MAME's coco_state::cart_w
  cartLineChanged(level) { this.pia1.setC1('b', level); }
  // composite colour (the Display tab): 0 off (RGB), 1 or 2 the NTSC artifact phase; PAL machines blend lines
  setComposite(setting) { this.vdg.artifact = setting; }

  // ---------------- state ----------------
  saveState() {
    return Object.assign(super.saveState(), {
      sam: this.sam.saveState(), pia0: this.pia0.saveState(), pia1: this.pia1.saveState(),
      acia: this.acia ? this.acia.saveState() : null,
      // the scanline being drawn as the beam passes it: needed because lines are no longer drawn
      // whole at the next HS
      beam: this.beam ? Object.assign({}, this.beam) : null,
      vdg: this.vdg.saveState(),
      rate: { runningFast: this.runningFast, extendSlow: this.extendSlow, sliceStart: this.sliceStart, sliceBase: this.sliceBase, sliceP: this.sliceP,
        vlog: [...this.vlog], vz: this.vz, haltInfo: this.haltInfo ? { ...this.haltInfo } : null,
        charBankLatch: this.charBankLatch, mameIntext: this.mameIntext },
      // a Hi-Res interface's one-shot: armed, and when it fires (js/machines/cocopia.js)
      hires: Object.assign({}, this.hires.jet),
    });
  }
  loadState(s) {
    super.loadState(s);
    this.sam.loadState(s.sam); this.pia0.loadState(s.pia0); this.pia1.loadState(s.pia1);
    if (!this.acia !== !s.acia) throw new Error('snapshot: the serial chip does not match this machine');
    if (this.acia) this.acia.loadState(s.acia);
    // a mid-line beam record is part of the state (lines are drawn as the beam passes them)
    if (!('beam' in s)) throw new Error('snapshot: missing "beam"');
    if (!s.hires) throw new Error('snapshot: missing "hires"');
    this.beam = s.beam ? Object.assign({}, s.beam) : null;
    this.vdg.loadState(s.vdg);
    this.runningFast = s.rate.runningFast; this.extendSlow = s.rate.extendSlow;
    this.sliceStart = s.rate.sliceStart; this.sliceBase = s.rate.sliceBase; this.sliceP = s.rate.sliceP;
    this.vlog = [...s.rate.vlog]; this.vz = s.rate.vz;
    state.load(this, s.rate, ['charBankLatch', 'mameIntext']);
    if (!('haltInfo' in s.rate)) throw new Error('snapshot: missing "haltInfo"');
    this.haltInfo = s.rate.haltInfo ? { ...s.rate.haltInfo } : null;
    Object.assign(this.hires.jet, s.hires);
  }

  // ---------------- no-ROM stub ----------------
  stubActive() { return (this.sam.reg & 0xC000) !== 0xC000; }
  stubInit() {
    const w = (a, v) => this.write(a, v);
    w(0xFF01, 0x00); w(0xFF00, 0x00); w(0xFF01, 0x34);
    w(0xFF03, 0x00); w(0xFF02, 0xFF); w(0xFF03, 0x35);   // FS IRQ enabled
    w(0xFF21, 0x00); w(0xFF20, 0xFE); w(0xFF21, 0x34);   // motor off
    w(0xFF23, 0x00); w(0xFF22, 0xFE); w(0xFF23, 0x3C);   // sound enabled
    w(0xFF20, 0x80); w(0xFF22, 0x04);                    // DAC mid, text mode
    this.sam.reg = 0x0002 << 3;                           // text at $0400, map type 0
    const ram = this.ram;
    for (const a of [0x100, 0x103, 0x106, 0x109]) ram[a] = 0x3B;  // RTI
    const irq = STUB.symbols.get('IRQ'), firq = STUB.symbols.get('FIRQ');
    ram.set([0x7E, irq >> 8, irq & 0xFF], 0x10C);
    ram.set([0x7E, firq >> 8, firq & 0xFF], 0x10F);
    this.cpu.s = 0x03D0; this.cpu.nmiArmed = true;
    this.cpu.cc = 0x40;                                   // FIRQ masked, IRQ enabled
    this.stubConsole.print('\f' + banner(this.profile.name, 'DROP A BINARY (.BIN .CAS .ROM)'));
  }
}

export { SamMachine };
