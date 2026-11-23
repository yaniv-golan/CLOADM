/*
 * SpeechSoundPak: the CoCo Speech/Sound Pak cartridge (stage 2), as MAME 0.264/0.289 build
 * it (src/devices/bus/coco/coco_ssc.cpp, "CoCo S/SC PAK"). The Pak holds three devices, and the 6809 never
 * talks to the last two directly:
 *
 *   6809           $FF7D write  bit 0 high resets the SP0256; a 1 -> 0 transition resets the TMS7040 and
 *                              the AY-3-8913 and clears the busy flag
 *                  $FF7D read   always $FF
 *                  $FF7E write  latch the byte for the TMS7040's port A, set busy, assert INT3 on the TMS7040
 *                  $FF7E read   $1F, plus bit 7 when the TMS7040 is NOT busy, bit 6 when the SP0256's SBY is
 *                              high, bit 5 when the sound-activity circuit output is high
 *   TMS7040        the "PIC". Its port A receives the CoCo's command byte; its port C is a control bus and
 *                  its port D a data bus, both to the AY and the SP0256; bit 7 of port C is the busy line
 *                  back to the CoCo (writing it 1 after it was 0 clears the flag).
 *   AY-3-8913      selected by port C bit 6 (C_ACS, 0 = selected); BDIR is bit 3 (C_BDR) and BC1 is bit 0
 *                  (C_BC1); port D is the data bus.
 *   SP0256         its address is loaded by a falling edge of port C bit 5 (C_ALD) with the allophone number
 *                  on port D, and only when that number is below 64.
 *
 * PORT C BIT 3 DOES TWO JOBS. In coco_ssc.cpp, C_RRW (the static RAM's read/write line) and C_BDR (the AY's
 * BDIR) are both 0x08. Nothing breaks because the two blocks are gated by different chip selects — bit 4
 * (C_RCS) for the RAM and bit 6 (C_ACS) for the AY — and the firmware never asserts both. MAME warns if a
 * read selects both at once ("Reading RAM and PSG at the same time!"). This device models the bit once and
 * applies it to whichever block its chip select has enabled.
 *
 * Static RAM: 2 KB (MAME's "staticram", 2K). Its address is (port C << 8) + port B, masked to $7FF. A write
 * happens with bits 4 and 3 both clear; a read with bit 4 clear and bit 3 set; the byte travels on port D.
 *
 * ROMs: at run time the TMS7040's internal ROM and the SP0256-AL2's allophone data are the user's own dumps,
 * like BASIC and DOS (AGENTS.md hard rule 1). The device therefore requires both and rejects a wrong-sized
 * image by name. For verification the project substitutes its own TMS7040 firmware and hand-built SP0256 data
 * (tools/mame-diff/ssc/); those stand in for the user's files in MAME and in the tests, and never replace them.
 *
 * TIMING. The PIC runs at the SAME machine-cycle rate as the 6809, not half of it; the AY-8913's stream runs at
 * a quarter of it. The chain, from MAME's source:
 *   - coco_ssc.cpp line 170 `TMS7040(config, m_tms7040, DERIVED_CLOCK(2, 1))`, and lines 186/190 give the
 *     AY-8913 and the SAC the same DERIVED_CLOCK(2, 1). DERIVED_CLOCK is parent x num / den (device.h line 37
 *     and device.cpp's calculate_derived_clock), so at the CoCo's 894,886.25 Hz the input clock is
 *     1,789,772.5 Hz. `mame -listdevices` confirms 1.78 MHz.
 *   - tms7000.cpp line 125 sets `m_divider(2)`, and tms7000.h line 85 is
 *     `execute_clocks_to_cycles: (clocks + m_divider - 1) / m_divider`. The TMS7040 therefore counts one
 *     machine cycle per TWO input clocks: 1,789,772.5 / 2 = 894,886.25 cycles a second, exactly the 6809's
 *     rate.
 * So the card advances one cycle per machine cycle. The AY has no such divider: ay8910.cpp device_start
 * allocates its stream at `master_clock / 8` with master_clock = clock(), the full 1,789,772.5 Hz, so it makes
 * one sample per FOUR card cycles (223,721.6 a second). (An earlier revision stepped it every 8 card cycles;
 * measured against MAME's -wavwrite with ssc-tone.asm, that played every tone at half MAME's frequency.) The
 * SP0256 does not: it has its own 3.12 MHz crystal and makes its samples on its own grid (spGrid). The card's
 * timer is on the machine's
 * scheduler through SlotDevice's AttoClock, and catchUp() runs it to the machine's current time before any
 * access (AGENTS section 2), so it advances whether or not the 6809 is touching the card. The PIC's position
 * in time is part of saveState.
 */
import { SlotDevice, devices } from './bus.js';
import { CPU7000 } from '../cpu/cpu7000.js';
import { AY8910 } from '../chips/ay8910.js';
import { SP0256, XTAL as SP0256_XTAL, SAMPLE_CLOCKS as SP0256_CLOCKS } from '../chips/sp0256.js';
import { registry, state } from '../util.js';

// Port C control bits, from coco_ssc.cpp lines 62-70.
const C_BC1 = 0x01;   // AY BC1
const C_RRW = 0x08;   // static RAM read/write  ... and the AY's BDIR (C_BDR, also 0x08)
const C_BDR = 0x08;
const C_RCS = 0x10;   // static RAM chip select (0 = selected)
const C_ALD = 0x20;   // SP0256 address load
const C_ACS = 0x40;   // AY chip select (0 = selected)
const C_BSY = 0x80;   // busy line back to the CoCo

// coco_ssc.cpp:59 `#define AY8913_GAIN 2.0`, the AY's route into the sound activity circuit (coco_ssc.cpp:182).
// The SAC passes its input through unchanged (cocossc_sac_device::sound_stream_update copies each sample) and
// its own route to the speaker is 1.0, which set_sound_enable() turns to 0.0 while the mux does not select the
// Pak (muxSelectsCart below). So what reaches the speaker is 2.0 x the AY's output, or nothing.
const AY_GAIN = 2.0;
// coco_ssc.cpp: SP0256_GAIN 1.75, the speech chip's route to the Pak's speaker. Its output is -32768..32764 of 32768
// (js/chips/sp0256.js, THE OUTPUT), so the Pak's speech level is out / 32768 x 1.75.
const SP_GAIN = 1.75;
// The speech chip's samples reach the sound path SP_LAG sample periods after the start of the period they belong to.
// A sample is made on the chip's own grid, when its period ends (or, for a status read or an address load, when it
// starts: spRun), up to a PIC instruction after the AY's samples for the same moment have been reported; the sound
// path takes levels in time order, so a speech sample is stamped where nothing before it can still arrive: two
// periods on, which is after the card's position whenever it is made. About 0.2 ms; docs/verification.md,
// "Deviations from MAME".
const SP_LAG = 2n;
// Card cycles per AY sample: the AY's input clock is twice the card's cycle rate (DERIVED_CLOCK(2, 1), and the
// TMS7040's divider of 2 is the PIC's own), and MAME streams it at that clock / 8. See TIMING above.
const AY_DIV = 4;

const TMS7040_ROM_SIZE = 0x1000;   // the PIC's region is 4 KB (coco_ssc.cpp ROM_REGION(0x1000, PIC_TAG))
const SP0256_ROM_SIZE = 0x800;     // the AL2 data, loaded at 0x1000 within the 0x10000 SP0256 region
// The user's two dumps, named as MAME's coco_ssc romset names them (`mame -listroms coco_ssc`): the ROM panel
// offers these sockets so a drop can be identified by name as well as by fitting the machine in use.
const SSC_ROM_SOCKETS = registry({
  tms7040: { id: 'tms7040', label: 'TMS7040 "PIC" ROM', size: TMS7040_ROM_SIZE, at: 0, files: ['pic-7040-510.bin'], crcs: [], aliases: [], bank: 0, required: true },
  sp0256: { id: 'sp0256', label: 'SP0256-AL2 allophone ROM', size: SP0256_ROM_SIZE, at: 0, files: ['sp0256-al2.bin'], crcs: [], aliases: [], bank: 0, required: false },
});
const SSC_ROM_PROFILE = { id: 'ssc', kind: 'cartridge', name: 'Speech/Sound Pak', roms: Object.values(SSC_ROM_SOCKETS) };

class SpeechSoundPak extends SlotDevice {
  // { tms7040Rom, sp0256Rom }: the user's dumps. The PIC's ROM is required (the card cannot run without it); the
  // SP0256's allophone data is OPTIONAL: without it the Pak plays its music and stays silent where it would speak.
  // With no allophone ROM the SP0256 is present on the card's control bus - its LRQ and SBY lines still work - but
  // every fetch reads 0, an RTS, so an allophone ends at once and makes no sound. That is the documented empty case,
  // and it is explicit: the card and its snapshot record which of the two it is.
  constructor({ tms7040Rom = null, sp0256Rom = null, firmware = null, sp0256Data = null } = {}) {
    super('ssc');
    // The verification substitutions are explicit: a caller testing or comparing with MAME passes ours,
    // and a caller running a machine passes the user's. Nothing is defaulted, so neither path is silent.
    const pic = tms7040Rom || firmware;
    const speech = sp0256Rom || sp0256Data;
    if (!pic) throw new Error('Speech/Sound Pak: the TMS7040 ROM is required (the user supplies their own dump)');
    if (pic.length !== TMS7040_ROM_SIZE) {
      throw new Error(`Speech/Sound Pak: the TMS7040 ROM must be ${TMS7040_ROM_SIZE} bytes (4096, 4 KB); got ${pic.length}`);
    }
    if (speech && speech.length !== SP0256_ROM_SIZE) {
      throw new Error(`Speech/Sound Pak: the SP0256 ROM must be ${SP0256_ROM_SIZE} bytes (2048, 2 KB); got ${speech.length}`);
    }
    this.firmware = Uint8Array.from(pic);
    // null: no allophone data, the documented empty case. Kept as null rather than a zero-filled image, so a
    // snapshot says which it is and a caller can tell "not supplied" from "supplied as silence".
    this.sp0256Data = speech ? Uint8Array.from(speech) : null;
    this.ram = new Uint8Array(0x800);
    this.resetLine = 1;
    this.busy = false;
    this.portA = 0;         // what the CoCo last wrote, read by the PIC on its port A
    this.portB = 0;
    this.portC = 0;
    this.portD = 0;
    this.portCIn = 0;       // the PIC's reads of its ports come back as what it last wrote (there is no
    this.portDIn = 0;       // external driver on these lines in the SSC)
    this.soundActive = false;   // the SAC's envelope follower is above its threshold
    this.sacEnvelope = 0;
    this.cardPos = 0n;      // where the card's clock has run to, in machine ticks
    this.ayDiv = 0;         // card cycles into the AY's current sample period (0: the next cycle starts a sample)
    this.busWrites = null;  // the AY and SP0256 bus writes of the PIC instruction being run (atEnd), applied at its end
    this.spNext = 0n;       // the SP0256's next sample, by index on its own grid (spRun)
    this.spLrq = true;      // the SP0256's LRQ as the PIC's INT1 last saw it (ready: asserted)
    this.ayOut = new Float32Array(1);   // the AY's one output (single-output mode), one sample
    // The Pak's level as the machine's sound path last heard it: the AY's single output times AY_GAIN, or 0
    // while the sound mux does not select the Pak. It is reported to the host the way the Games Master and the
    // Orchestra-90 report theirs (Machine.cartSound), so the Pak sounds through the machine's one audio path.
    // MAME gives the Pak a speaker of its own (`ssc_audio`), and its recording sums every speaker, which is the
    // same as adding the Pak's level to the machine's.
    this.ayLevel = 0;
    // The speech chip's level, and its changes not yet passed to the sound path: [tick, level] in time order, each
    // stamped SP_LAG periods after its sample's start (spLevelAt). They are passed on in time order with the AY's
    // (flushSpeech), so the host hears one level, the sum.
    this.spLevel = 0;
    this.spQueue = [];
    this.spQueued = 0;      // the level of the queue's last entry (or spLevel when it is empty)
    // the card's timer must exist before loadState, because the clock restores into registered timers
    this.picTimer = this.clock.timer('ssc.pic', () => this.tickCard());
    this.lines.set('cart', 'clear');   // the Pak does not autostart (MAME leaves CART alone)
    this.buildChips();
  }

  buildChips() {
    // coco_ssc.cpp:180-182: the AY-3-8913 is built with set_flags(AY8910_SINGLE_OUTPUT), so MAME mixes its three
    // channels as one resistor network (js/chips/ay8910.js, 'single'), and routes it to the SAC with AY_GAIN.
    this.ay = new AY8910({ output: 'single' });
    this.sp0256 = new SP0256({ rom: this.sp0256Data });
    // the PIC: our CPU7000 core on the user's (or the verification) image, with the peripheral file hooked
    this.tms7040 = new CPU7000({ read: (a) => this.readPic(a), write: (a, v) => this.writePic(a, v) });
    this.tms7040.peripheral = (addr, value, isWrite) => this.peripheral(addr, value, isWrite);
    // the bus-level ports: port A receives from the CoCo, port C is the control bus, port D the data bus.
    // A read of a port serves the device its chip select lines and data bus select (readPortD), which is what
    // the firmware sees through its DDR-masked reads.
    this.tms7040.portIn = (name) => {
      if (name === 'A') return this.portA;
      // Port D has two sources, per its chip select: the static RAM or the AY's data register. The core masks
      // this by the DDR, so an output line still reads back the latch the firmware wrote.
      if (name === 'D') return this.readPortD();
      return 0xFF;
    };
    this.tms7040.portOut = (name, value) => {
      if (name === 'A') this.portA = value & 0xFF;
      else if (name === 'C') this.writePortC(value & 0xFF);
      else if (name === 'D') this.portD = value & 0xFF;
      else if (name === 'B') this.portB = value & 0xFF;
    };
    this.tms7040.reset();
  }

  get name() { return 'Speech/Sound Pak'; }
  rom() { return null; }   // the Pak presents no ROM at $C000; it only answers $FF7D-$FF7E

  reset(hard) {
    super.reset(hard);
    this.resetLine = 1;
    this.busy = false;
    this.portA = 0; this.portB = 0; this.portC = 0; this.portD = 0;
    this.ram.fill(0);
    this.tms7040.reset();
    this.ay.reset();
    this.sp0256.reset();
    // SlotDevice.reset(hard) disarms every timer, so the card's own clock has to be armed again here; without
    // this the card never ticks after a power-on reset and every command would time out.
    this.ayDiv = 0;
    // At power-on the card starts at the machine's power-on origin, as MAME resets its devices at time 0: not at
    // the CPU's first instruction, which is resetOffset ticks later (4 on the SAM machines). Measured against MAME
    // (gen-ay.js, a Lua tap on the PIC's port C): starting at the CPU's first instruction put every PIC write 4
    // cycles late. A soft reset happens where the machine is.
    this.cardPos = this.host ? BigInt(Math.floor(hard ? this.host.powerOnTick() : this.host.ioTime())) : 0n;
    // the speech chip's samples continue on its own grid from where the card starts, and its reset leaves LRQ high,
    // which MAME puts on the PIC's INT1 at once (sp0256 device_reset: m_drq_cb(1))
    this.spNext = this.host ? this.spFirstAt(this.attosAt(this.cardPos)) : 0n;
    this.spQueue.length = 0;
    this.spQueued = this.spLevel;
    this.spLrq = !this.sp0256.lrq;
    this.spLines();
    this.scheduleTick();
  }

  // ---------------- the 6809 side (coco_ssc.cpp ff7d_read / ff7d_write) ----------------
  readIO(a) {
    if (a === 0xFF7D) return 0xFF;
    if (a === 0xFF7E) {
      this.catchUp();   // the status depends on time: run the card to this moment first (AGENTS section 2)
      if (this.host) this.spRun(this.host.ioTime(), true);   // and the speech chip (sby_r updates its stream)
      let data = 0x1F;
      if (!this.busy) data |= 0x80;
      if (this.sp0256.sby) data |= 0x40;
      // $FF7E bit 5 is the sound-activity circuit's output, and MAME's sound_activity_circuit_output()
      // ends `return !m_sound_active;` — the pin reads HIGH when the circuit is NOT making sound
      // (coco_ssc.cpp:540-550).
      if (!this.soundActive) data |= 0x20;
      return data;
    }
    return undefined;
  }

  writeIO(a, v) {
    if (a === 0xFF7D) {
      if (v & 1) {
        // MAME's device_reset brings the speech chip's stream up to now before it resets the chip
        this.catchUp();
        if (this.host) this.spRun(this.host.ioTime(), true);
        this.sp0256.reset();
        this.spLines();
      }
      if ((this.resetLine & 1) && !(v & 1)) {
        // A falling edge on the reset line at machine time X restarts the PIC at X. Catch the card up to X
        // first (never past it), so the PIC restarts from the same machine time however the 6809 is driven -
        // cpu.step() reaches this write between instructions, runCycles with cycles still to run.
        this.catchUp();
        this.tms7040.reset();
        this.ay.reset();
        this.busy = false;
        // the card is now caught up to the machine's time for this write; say so at the same ioTime() the
        // catch-up used, so the card's position never depends on how the 6809 is being driven
        this.cardPos = BigInt(Math.floor(this.host ? this.host.ioTime() : 0));
        this.scheduleTick();
      }
      this.resetLine = v;
      return true;
    }
    if (a === 0xFF7E) {
      this.portA = v & 0xFF;
      this.busy = true;
      this.tms7040.interrupt(3, true);   // INT3 on the PIC (TMS7000_INT3_LINE)
      this.catchUp();                    // the card runs to this moment, servicing the command in its own time
      return true;
    }
    return false;
  }

  // ---------------- the PIC's memory and peripheral file ----------------
  // The PIC's whole address space is the Pak's: >0000->007F the register file (RAM), >0100->01FF the
  // peripheral file, and the 4 KB internal ROM at the top (>F000->FFFF, coco_ssc.cpp's PIC_TAG region).
  // Everything else reads 0, as an unpopulated area of a single-chip part does.
  readPic(a) {
    a &= 0xFFFF;
    if (a >= 0xF000) return this.firmware[a - 0xF000];
    if (a < 0x80) return this.ram[a];
    return 0;
  }
  writePic(a, v) {
    a &= 0xFFFF;
    if (a < 0x80) this.ram[a] = v & 0xFF;
  }

  // The peripheral-file registers the board owns. IOCNT0 and the four general-purpose ports are the chip's
  // own (js/cpu/cpu7000.js: Figure 3-16 and Table 3-8), so they are handled by the core and never reach this
  // hook; an address this does not own falls through to the core's default.
  peripheral(addr, value, isWrite) {
    return undefined;
  }

  // A write to the PIC's port C, as the firmware would do it. Public because the tests drive the control bus
  // directly to check each chip-select path.
  picPort(addr, value) { return this.tms7040.write8(addr, value); }

  // Port C is the control bus (coco_ssc.cpp ssc_port_c_w).
  writePortC(data) {
    const prev = this.portC;
    // static RAM write: chip select and read/write both clear (C_RCS and C_RRW are bits 4 and 3)
    if ((data & C_RCS) === 0 && (data & C_RRW) === 0) {
      const addr = (((data & 0xFF) << 8) + this.portB) & 0x7FF;
      this.ram[addr] = this.portD;
    }
    // AY-3-8913, gated by its chip select (bit 6 clear)
    if ((data & C_ACS) === 0) {
      if ((data & (C_BDR | C_BC1)) === (C_BDR | C_BC1)) this.atEnd(this.ay, this.ay.addressW, this.portD);         // BDIR=1 BC1=1: latch address
      else if ((data & C_BDR) === C_BDR && (data & C_BC1) === 0) this.atEnd(this.ay, this.ay.dataW, this.portD);  // BDIR=1 BC1=0: write data
    }
    // SP0256: a falling edge of ALD, with the allophone number below 64
    if ((prev & C_ALD) === C_ALD && (data & C_ALD) === 0 && this.portD < 64) this.atEnd(this.sp0256, this.sp0256.loadAddress, this.portD);
    // the busy line back to the CoCo: a 0 -> 1 edge clears it
    if ((prev & C_BSY) === 0 && (data & C_BSY) === C_BSY) this.busy = false;
    this.portC = data;
  }

  // Port D is read back: the RAM when its chip select and read/write lines say so, else the AY's data
  // register when it is selected (coco_ssc.cpp ssc_port_d_r, which updates m_tms7000_portd and returns it).
  // The value is placed in the core's port D latch, because that is what the firmware reads back through a
  // DDR-masked read: "reading a port gives the value the port holds", which for port D is whatever the
  // selected device put on it.
  readPortD() {
    if ((this.portC & C_RCS) === 0 && (this.portC & C_RRW) === C_RRW) {
      const addr = (((this.portC & 0xFF) << 8) + this.portB) & 0x7FF;
      this.portD = this.ram[addr];
    }
    if ((this.portC & C_ACS) === 0) {
      if ((this.portC & C_BDR) === 0 && (this.portC & C_BC1) === C_BC1) this.portD = this.ay.dataR();
    }
    return this.portD;
  }

  // ---------------- running ----------------
  // The card's own clock: half the CoCo's (coco_ssc.cpp DERIVED_CLOCK(2, 1) for the PIC, the AY and the SAC).
  // SlotDevice already gives us an AttoClock on the machine's scheduler (this.clock), so the card's timer is
  // an exact attotime timer like the floppy drive's. `catchUp()` runs the card to the machine's current
  // time; it is called before any card access (AGENTS section 2: an access whose result depends on time
  // processes events first) and by the scheduled tick, so the card advances whether or not the 6809 is
  // touching it, and both paths agree about how far it has run.
  attach(host) {
    super.attach(host);
    // The timer exists from the constructor (loadState needs it) but only now does the clock have a host to
    // schedule on. A restored device runs attach() before loadState(), so a position already carried in from
    // a snapshot must not be overwritten here: only a fresh card starts at the machine's current time.
    if (!this.restored) this.cardPos = BigInt(Math.floor(host.ioTime()));
    this.scheduleTick();
  }

  // Machine ticks per card cycle. The card counts one cycle per cycle of the cartridge slot's clock: its input
  // clock is twice the slot's (DERIVED_CLOCK(2, 1)) but tms7000.cpp line 125 divides it by 2 before counting cycles
  // (see the TIMING note at the top). The slot's clock is the host's cartClockHz, fixed whatever the CPU's speed. On
  // the SAM machines a tick is that cycle (1); on the CoCo 3 a tick is a GIME clock, a quarter of it (4). An earlier revision returned 1 everywhere, so on the CoCo 3 the card ran 4 times
  // fast: measured with gen-ay.js, its AY program ended at 0.33 s where MAME's ends at 1.33 s.
  cardTicksPerCycle() { return this.host ? Math.max(1, Math.round(this.host.tickHz / this.host.cartClockHz)) : 1; }
  scheduleTick() {
    if (!this.host || !this.picTimer) return;
    this.picTimer.adjust(BigInt(this.cardTicksPerCycle()) * this.host.unitAttos);
  }
  // Run the card's cycles that are due by the machine's current time. Called before every card access and
  // from the scheduled tick, so the card advances on its own clock and not only when the 6809 touches it.
  //
  // The card's machine time is ioTime(): the bus-cycle time of the access within the instruction, the same
  // value every other device in the tree is timed against (AGENTS section 2; machine.js's ioTime() carries
  // the contract). MAME's equivalent is device_scheduler::time() / device_execute_interface::local_time(),
  // which likewise reports the cycle position inside the instruction currently running.
  //
  // ROUNDING. ioTime() is a machine tick as a float (it is fractional after a debugger step, which asks for
  // 1e-9 of a tick). The card counts whole cycles, one per machine cycle (TIMING above), so machine time is
  // converted by truncation: N.something ticks is N card cycles. That is MAME's own rule - the scheduler sizes
  // each device's slice with `divu_64x32(u64(delta) >> m_divshift, m_divisor)` (schedule.cpp, the "compute how
  // many cycles we want to execute" line), an integer division that truncates. Truncating also guarantees the
  // card is never run past the access that is asking, which is what the reset edge needs.
  catchUp() {
    if (!this.host) return;
    const now = BigInt(Math.floor(this.host.ioTime()));
    let guard = 0;
    while (this.cardPos < now && guard++ < 200000) this.stepCard();
  }
  // A bus write the PIC's current instruction makes to the AY or the SP0256 reaches the chip at the END of that
  // instruction: stepCard collects it and applies it once both chips have run up to that time. MAME's TMS7000 core
  // charges an instruction's cycles before it executes it (tms7000op.cpp, e.g. am_i2p: `m_icount -= 11` and then
  // the port write), so the write's time is the instruction's end, and each chip's stream is brought up to that
  // time, on its old state, before the write lands (ay8910 data_w and sp0256 ald_w call their stream's update()
  // first). Applying an AY write at the instruction's start put every AY change several card cycles early against
  // MAME's -wavwrite (gen-ay.js). Outside stepCard (a test driving the decode directly) there is no instruction,
  // and the write lands at once.
  atEnd(chip, fn, v) {
    if (this.busWrites) this.busWrites.push([chip, fn, v]);
    else fn.call(chip, v);
  }
  stepCard() {
    // one PIC instruction takes the cycles it takes: the card's position advances by the instruction's own
    // cycle count, not by one per instruction, or the card would run far ahead of the 6809 (an ISR of ~30
    // instructions would appear to complete in 30 cycles when it needs a few hundred).
    // config.mameCompat: a speech-chip sample that ends less than one card cycle after this instruction would start
    // is made first, so its LRQ change reaches INT1 before the instruction runs. MAME's scheduler gives a CPU the
    // time to its next timer (here the SP0256's per-sample timer) as a whole number of its cycles, rounded down, and
    // does not run it for none, so a timer due less than a cycle ahead fires before the instruction starts.
    // Measured with gen-speak.js: instructions starting 0.06 and 0.88 card cycles before a sample boundary read the
    // INT1 flag set on MAME and clear here, each moving one address load by a pass of the PIC's polling loop. A MAME
    // artefact (docs/verification.md); the hardware model takes the change after the instruction.
    if (this.host && this.host.config && this.host.config.mameCompat) {
      this.spRunTo(this.attosAt(this.cardPos) + this.host.unitAttos * BigInt(this.cardTicksPerCycle()), 'before');
    }
    this.busWrites = [];
    const cycles = this.tms7040.step();
    const writes = this.busWrites;
    this.busWrites = null;
    const start = this.cardPos, k = this.cardTicksPerCycle();
    this.cardPos += BigInt(Math.max(1, cycles) * k);
    // the AY's stream and the SP0256 are stepped for each cycle the PIC took. An AY sample is made at the START of
    // its period (every AY_DIV card cycles from power-on, MAME's sample k at time k / stream rate) and stamped with
    // that start: it is the level for its whole period. This instruction's AY writes land after the loop, at the
    // instruction's end T, so every sample that started before T plays the old registers and the first one to
    // start at or after T plays the new. That is MAME's order: a write calls the stream's update() up to T, and a
    // stream view's end index rounds UP (sound.h read_stream_view: time_to_buffer_index(end, true)), so the
    // sample in progress at T is made before the register changes. Measured against MAME's -wavwrite (gen-ay.js):
    // giving that sample the new value instead put tone channels half a period out of phase after a period
    // change, and stamping a sample at its period's end put every level change one AY sample late.
    //
    // config.mameCompat: MAME's AY samples fall on its own grid instead (mameAySamples below), so they are made
    // there, by the same rule: every sample that starts before the instruction's end, before its writes.
    const grid = this.host && this.host.config && this.host.config.mameCompat;
    if (grid) this.mameAySamples(start, this.cardPos);
    for (let i = 0; i < Math.max(1, cycles); i++) {
      if (!grid) {
        if (this.ayDiv === 0) this.stepAy(start + BigInt(i * k));
        this.ayDiv = (this.ayDiv + 1) % AY_DIV;
      }
    }
    // the SP0256's samples whose periods ended by now (its per-sample timer), then this instruction's writes, an
    // address load first bringing the speech chip up to the write's time
    this.spRun(this.cardPos, false);
    for (const [chip, fn, v] of writes) {
      if (chip === this.sp0256) this.spRun(this.cardPos, true);
      fn.call(chip, v);
      if (chip === this.sp0256) this.spLines();
    }
  }
  // ---------------- the SP0256's own clock ----------------
  // The speech chip runs from its own 3.12 MHz crystal (coco_ssc.cpp: SP0256(config, m_spo, XTAL(3'120'000))), one
  // sample every 312 of its clocks: 10 kHz (js/chips/sp0256.js, SOURCES). Under config.mameCompat, MAME's 0.264
  // divider, 336, as a whole-hertz stream: 3,120,000 / 336 = 9,285 samples a second, counted from each second's
  // start (docs/verification.md, "Deviations from MAME"). Sample i's period starts at spStart(i) attoseconds after
  // power-on.
  spGrid() {
    const compat = !!(this.host && this.host.config && this.host.config.mameCompat);
    const rate = BigInt(Math.floor(SP0256_XTAL / (compat ? SP0256_CLOCKS.mame : SP0256_CLOCKS.hardware)));
    return { rate, period: 10n ** 18n / rate };
  }
  spStart(i, g = this.spGrid()) { return (i / g.rate) * 10n ** 18n + (i % g.rate) * g.period; }
  spFirstAt(t, g = this.spGrid()) {
    const sec = 10n ** 18n;
    return (t / sec) * g.rate + ((t % sec) + g.period - 1n) / g.period;
  }
  attosAt(tick) {
    return (BigInt(Math.floor(Number(tick))) - BigInt(Math.round(this.host.powerOnTick()))) * this.host.unitAttos;
  }
  // Make the speech chip's samples up to machine tick `tick`, as MAME's stream does: on its per-sample timer every
  // sample whose period has ENDED (access false); for an access at `tick` (an address load, a status read, a reset)
  // every sample that has STARTED before it, the one in progress included (a stream update's end rounds up,
  // sound.h). LRQ changes reach the PIC's INT1 as each sample is made.
  spRun(tick, access) {
    if (!this.host) return;
    this.spRunTo(this.attosAt(tick), access ? 'access' : 'timer');
  }
  // the same at an exact time; 'before' makes the samples whose period ends strictly before `t`
  spRunTo(t, mode) {
    const g = this.spGrid();
    for (;;) {
      const edge = mode === 'access' ? this.spStart(this.spNext, g) : this.spStart(this.spNext + 1n, g);
      if (mode === 'timer' ? edge > t : edge >= t) break;
      const out = this.sp0256.sample();
      this.speechLevel(this.spNext, g, out);
      this.spNext++;
      this.spLines();
    }
  }
  // Speech sample i's output, as a level change for the sound path at its stamp (SP_LAG periods after its start). The
  // sound mux gates it as it gates the AY (muxSelectsCart; coco_ssc.cpp set_sound_enable sets both outputs' gain).
  speechLevel(i, g, out) {
    const level = this.muxSelectsCart() ? out / 32768 * SP_GAIN : 0;
    if (level === this.spQueued || !this.host) return;
    this.spQueued = level;
    const origin = BigInt(Math.round(this.host.powerOnTick()));
    let at = origin + this.spStart(i + SP_LAG, g) / this.host.unitAttos;
    if (at < this.cardPos) at = this.cardPos;    // never behind what the AY has already reported
    this.spQueue.push([Number(at), level]);
  }
  // Pass the queued speech levels stamped before `tick` to the sound path, each as the Pak's sum with the AY.
  flushSpeech(tick) {
    const q = this.spQueue;
    let n = 0;
    while (n < q.length && q[n][0] < tick) {
      this.spLevel = q[n][1];
      this.reportLevel(q[n][0]);
      n++;
    }
    if (n) q.splice(0, n);
  }
  // the Pak's level, the AY's plus the speech chip's, to the host's sound path
  reportLevel(at) {
    // a host without cartSound (a minimal test harness that only drives the card's clock) has no sound path
    if (this.host && typeof this.host.cartSound === 'function') this.host.cartSound(at, this.ayLevel + this.spLevel);
  }
  // before the machine closes a frame: every speech level stamped in it
  syncAudio(tick) { this.flushSpeech(tick); }
  // the SP0256's LRQ drives the PIC's INT1 (coco_ssc.cpp: data_request_callback().set_inputline(INT1)): asserted
  // while the chip is ready for an address
  spLines() {
    if (this.sp0256.lrq === this.spLrq) return;
    this.spLrq = this.sp0256.lrq;
    this.tms7040.interrupt(1, this.spLrq);
  }

  // MAME's AY sample grid (config.mameCompat; a deviation documented in docs/verification.md). On the hardware the
  // AY makes one sample per AY_DIV card cycles. MAME keeps device clocks as whole hertz: the Pak is 894,886 Hz
  // (the slot's 894,886.25 truncated; 888,625 on the Dragon), the AY DERIVED_CLOCK(2, 1) of that, 1,789,772 Hz, and
  // its stream clock / 8 = 223,721 samples a second (integer division; 4 card cycles would be 223,721.56). A stream
  // sample's start is counted within each second, `second + index x period` with the period 1e18 / rate
  // attoseconds truncated (sound.cpp stream_buffer, time_to_buffer_index). So MAME's grid slips about half a sample
  // a second against the card's cycles, and a write near a sample boundary lands one sample later than on the
  // hardware grid: measured with gen-ay.js at 1.008 s, that put a tone half a period out of phase. Here the samples
  // whose MAME start is in [from, to) (machine ticks) are made, each stamped with the tick its start falls in.
  mameAySamples(from, to) {
    const host = this.host, unit = host.unitAttos, origin = BigInt(Math.round(host.powerOnTick()));
    const rate = BigInt(Math.floor(Math.floor(host.cartClockHz) * 2 / 8)), sec = 10n ** 18n, period = sec / rate;
    const attosOf = (tick) => (tick - origin) * unit;
    // the first sample starting at or after `t`: time_to_buffer_index rounding up, within t's second
    const firstAt = (t) => (t / sec) * rate + ((t % sec) + period - 1n) / period;
    const startOf = (i) => (i / rate) * sec + (i % rate) * period;
    const end = attosOf(to);
    for (let i = firstAt(attosOf(from)); ; i++) {
      const t = startOf(i);
      if (t >= end) break;
      this.stepAy(origin + t / unit);
    }
  }
  // One AY sample, and the level it leaves on the machine's sound path: the chip's single output times AY_GAIN.
  // The host is told only when the level changes - the same "report level changes" contract the Games Master
  // and the Orchestra-90 use, so the mixer sees the Pak exactly as it sees them.
  //
  // THE SOUND MUX GATES THE PAK, AND ONLY THE PAK. MAME's CoCo routes cartridge audio to the speaker only when
  // its sound mux selects it: soundmux_status() is SOUNDMUX_ENABLE (PIA1 CB2) | SOUNDMUX_SEL1 (PIA0 CA2) |
  // SOUNDMUX_SEL2 (PIA0 CB2), and bCartSoundEnable is an EQUALITY test - `status == (SOUNDMUX_ENABLE |
  // SOUNDMUX_SEL2)` (coco.cpp:555) - so the cartridge is heard when PIA1 CB2 is high, PIA0 CB2 is high AND PIA0
  // CA2 is LOW. A mux with all three high selects a different source and is silent, as source 3 is in MAME.
  // cacoco hands that to the cartridge as SOUND_ENABLE (coco.cpp:585-587), and coco_ssc.cpp:259-270 opens the
  // AY's and the SP0256's output gain only while it is asserted. So a Pak whose program has not selected it is
  // silent, and that is what this models. The Games Master and the Orchestra-90 feed the machine's own analogue
  // level in MAME and are not gated here; changing them is not this branch's business.
  muxSelectsCart() {
    const p0 = this.host && this.host.pia0, p1 = this.host && this.host.pia1;
    if (!p0 || !p1) return true;     // no PIA (a bare device in a test): nothing to gate on, so sound as before
    return p1.b.c2() && p0.b.c2() && !p0.a.c2();
  }
  // at: the machine tick this sample falls on (the card's position, by default)
  stepAy(at = this.cardPos) {
    this.ay.step(this.ayOut);
    // AY_GAIN is a power of two, so the product is exact in MAME's 32-bit float as well as here
    const level = this.muxSelectsCart() ? AY_GAIN * this.ayOut[0] : 0;
    this.flushSpeech(Number(at) + 1);   // the speech levels up to this sample first, so the host hears them in order
    if (level === this.ayLevel) return;
    this.ayLevel = level;
    // Report the change at the SAMPLE'S OWN time, not at the I/O access time. catchUp() runs many samples in one
    // batch (a status read after an idle stretch can step the AY dozens of times), and stamping them all with
    // host.tickAt(-1) collapses them onto a single tick - measured: 14 changes across 2,912 cycles, all on one
    // stamp. cardPos is the card's position in machine ticks and advances with every sample, so it IS the time
    // this sample happened; convert it to a tick the way the Games Master does (clock.tickOf), which is exact
    // and, unlike tickAt(-1), does not depend on where the 6809 happens to be.
    // cardPos IS the machine tick this sample happened at, so it is passed through unchanged. Building it as
    // tickAt(cardPos - tickAt(0)) is not equivalent: SamMachine.tickAt (js/machines/sam.js:465-468) converts
    // units to ticks at the CURRENT SAM rate, so composing it with a difference of ticks scales the answer by
    // that period. Measured at the fast rate, that form put every stamp 1,387 ticks from its sample's cardPos;
    // passing cardPos puts them 0 from it at both rates.
    this.reportLevel(Number(at));
  }
  tickCard() {
    if (!this.host) return;
    this.catchUp();
    this.scheduleTick();
  }

  saveState() {
    return Object.assign(super.saveState(), {
      // the ROM images travel with the card, so a snapshot restores on any machine without its own copies
      firmware: this.firmware.slice(), sp0256Data: this.sp0256Data ? this.sp0256Data.slice() : null,
      ram: this.ram.slice(), resetLine: this.resetLine, busy: this.busy,
      portA: this.portA, portB: this.portB, portC: this.portC, portD: this.portD,
      cardPos: this.cardPos.toString(),   // the card's position in time, so a restored card resumes in step
      ayLevel: this.ayLevel, ayDiv: this.ayDiv, ay: this.ay.saveState(),
      spNext: this.spNext.toString(), spLrq: this.spLrq,
      spLevel: this.spLevel, spQueued: this.spQueued, spQueue: this.spQueue.map((e) => e.slice()),
      pic: this.tms7040.saveState(), sp: this.sp0256.saveState(),
    });
  }
  loadState(s) {
    super.loadState(s);
    this.ram.set(s.ram);
    this.resetLine = s.resetLine; this.busy = s.busy;
    this.portA = s.portA; this.portB = s.portB; this.portC = s.portC; this.portD = s.portD;
    this.cardPos = BigInt(s.cardPos);
    // The AY's state is checked before any chip's state is applied, so a damaged snapshot is refused with
    // state.load's message (`snapshot: missing "ay"`) instead of restoring part of the card. `ay` is a whole
    // object the AY loads itself, so its check has the same message shape.
    state.load(this, s, ['ayLevel', 'ayDiv', 'spLrq', 'spLevel', 'spQueued']);
    if (!Array.isArray(s.spQueue)) throw new Error('snapshot: missing "spQueue"');
    this.spQueue = s.spQueue.map((e) => [Number(e[0]), Number(e[1])]);
    if (!('spNext' in s)) throw new Error('snapshot: missing "spNext"');
    this.spNext = BigInt(s.spNext);
    if (!('ay' in s)) throw new Error('snapshot: missing "ay"');
    this.ay.loadState(s.ay);
    this.tms7040.loadState(s.pic);
    this.sp0256.loadState(s.sp);
  }
  static fromState(s) {
    const d = new SpeechSoundPak({ tms7040Rom: s.firmware, sp0256Rom: s.sp0256Data || null });
    d.loadState(s);
    // attach() runs before loadState() when the machine restores a device, so the restored position in time
    // is already set; mark it so attach() leaves it alone.
    d.cardPos = BigInt(s.cardPos);
    d.restored = true;
    return d;
  }
}

// A snapshot restores a device through devices[type].fromState, and the Pak's two ROM images travel in its
// state, so a restored machine rebuilds the same card (AGENTS 4.5).
devices.ssc = SpeechSoundPak;

export { SpeechSoundPak, SSC_ROM_PROFILE, TMS7040_ROM_SIZE, SP0256_ROM_SIZE, C_ALD, C_ACS, C_RCS, C_RRW, C_BDR, C_BC1, C_BSY };
