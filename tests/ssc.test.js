// Run: node tests/ssc.test.js
//
// The Speech/Sound Pak (stage 2), as MAME 0.264/0.289 build it
// (src/devices/bus/coco/coco_ssc.cpp). The Pak is a CoCo cartridge holding three devices: a TMS7040
// ("PIC") microcontroller running its own firmware, a GI SP0256 speech chip and an AY-3-8913 sound chip.
// The 6809 never talks to the SP0256 or the AY directly: it writes a command byte and interrupts the
// TMS7040, whose ports drive them.
//
// Every expected value below is read from that source, and the line is quoted next to the check:
//   $FF7D write: bit 0 high resets the SP0256; a 1 -> 0 transition resets the TMS7040 and the AY and
//                clears the busy flag (ff7d_write, case 0x00).
//   $FF7D read:  always $FF (ff7d_read, case 0x00).
//   $FF7E write: latch the byte for the TMS7040's port A, set busy, assert INT3 (ff7d_write, case 0x01).
//   $FF7E read:  $1F, plus bit 7 when the TMS7040 is NOT busy, bit 6 when the SP0256's SBY is high, bit 5
//                when the sound-activity circuit output is high (ff7d_read, case 0x01).
//   Port C bit 3 is BOTH the static RAM's R/W line (C_RRW) and the AY's BDIR (C_BDR) -- both are 0x08 --
//                separated only by the chip selects in bits 4 (C_RCS) and 6 (C_ACS), which the firmware
//                never asserts together.
// The device is exercised through the same Device interface every other cartridge uses (js/machines/bus.js),
// so a test drives readIO/writeIO exactly as the CoCo's memory map does.
const Emu = require('./load')();

// The verification images: ours, built from tools/mame-diff/ssc/. A user running a machine supplies their own
// dumps instead; these stand in so the device and MAME can be exercised without one (AGENTS.md hard rule 1).
const { buildPic, buildSp0256 } = require('../tools/mame-diff/ssc/gen-roms.js');
const PIC_ROM = buildPic();
const SP_ROM = buildSp0256();
const pak = (opts = {}) => new Emu.SpeechSoundPak(Object.assign({ tms7040Rom: PIC_ROM, sp0256Rom: SP_ROM }, opts));
// Drive the control bus the way firmware does: a port only drives the lines its DDR has made outputs (MAME's
// tms7000_pf_w calls the port_out callback with `data & m_port_ddr[port]`). Tests that poke the ports directly
// set the DDRs first, so they exercise the same mask the firmware lives under.
const outputs = (d) => { d.picPort(0x0109, 0xFF); d.picPort(0x010B, 0xFF); };   // port C DDR, port D DDR

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v, d = 2) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

// A host on the machine's time model: 1 tick = 1 us, a real event queue, and advance() to run time on.
// The device keeps its own clock on this scheduler (SlotDevice's AttoClock), so a test can let time pass and
// watch the card run by itself, exactly as it would in a machine.
function host() {
  const h = {
    t: 0,
    unitAttos: 1000000000000n,
    tickHz: 1e6,
    lineDelays: { cart: 0, nmi: 12, halt: 6 },
    lines: [],
    handlers: {},
    q: [],
    seq: 0,
    now: () => h.t,
    ioTime: () => Math.round(h.t),
    clockUnits: () => Math.round(h.t),
    tickAt: (u) => Math.round(h.t) + u,
    powerOnTick: () => 0,
    cartClockHz: 1e6,   // the port's clock equals tickHz: one tick per card cycle, as on the SAM machines
    schedule(at, name, arg) {
      h.q.push({ at, name, arg, seq: h.seq++ });
      h.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      return { at, name, arg };
    },
    cancel() {},
    on(name, fn) { h.handlers[name] = fn; },
    config: {},
    setLine(source, line, level) { h.lines.push([source, line, level]); },
    cartridgeChanged() {},
    cartSound() {},
    // let `us` microseconds pass, running every scheduled event on the way
    advance(us) {
      const end = h.t + us;
      while (h.q.length && h.q[0].at <= end) {
        const e = h.q.shift();
        h.t = Math.max(h.t, e.at);
        if (h.handlers[e.name]) h.handlers[e.name](e.arg);
      }
      h.t = end;
    },
  };
  return h;
}

// ---------------------------------------------------------------------------------------------------
// 1. the 6809 side: $FF7D and $FF7E, read and write, exactly as ff7d_read/ff7d_write have them
// ---------------------------------------------------------------------------------------------------
{
  const d = pak();
  d.attach(host());
  outputs(d);

  check('$FF7D reads $FF always (ff7d_read case 0)', d.readIO(0xFF7D) === 0xFF, hex(d.readIO(0xFF7D)));
  // $FF7E: $1F base. With the TMS7040 not busy, bit 7 is set.
  const status = d.readIO(0xFF7E);
  check('$FF7E reads the $1F base (ff7d_read case 1)', (status & 0x1F) === 0x1F, hex(status));
  check('$FF7E bit 7 is set while the TMS7040 is not busy', (status & 0x80) !== 0, hex(status));

  // a write to $FF7E hands the byte to the PIC. The card runs on its own clock, so the service takes time:
  // right after the write the flag is still set, and after enough time has passed it clears. That is the
  // behaviour a lockstep depends on.
  const h = host();
  const d2 = pak();
  d2.attach(h);
  // let the PIC get through its reset sequence first: the reset code drives port C itself (0 -> $FF), and that
  // 0 -> 1 edge on the busy line would clear the flag for the wrong reason if a command were written before it
  h.advance(2000);
  check('the PIC is in its wait loop before the command', d2.tms7040.pc === 0xF01C, hex(d2.tms7040.pc, 4));
  d2.writeIO(0xFF7E, 0x2A);
  check('a $FF7E write sets the busy flag at once (ff7d_write case 1)', (d2.readIO(0xFF7E) & 0x80) === 0, hex(d2.readIO(0xFF7E)));
  h.advance(2000);   // let the card run
  // The firmware leaves INT3 masked (IOCNT0 $0C is INT2's field, Figure 3-16), so the card does not service and
  // the flag stays set. Section 7 is the end-to-end case that enables INT3 and shows it clearing.
  check('with INT3 masked the flag stays set: the card takes no interrupt (Figure 3-16)',
    (d2.readIO(0xFF7E) & 0x80) === 0, hex(d2.readIO(0xFF7E)));
}

// ---------------------------------------------------------------------------------------------------
// 2. the reset line: $FF7D bit 0
// ---------------------------------------------------------------------------------------------------
{
  const d = pak();
  d.attach(host());
  outputs(d);
  // bit 0 high resets the SP0256
  d.writeIO(0xFF7D, 0x01);
  check('$FF7D bit 0 high resets the SP0256 (ff7d_write case 0)', d.sp0256.pc === 0, String(d.sp0256.pc));
  // a 1 -> 0 transition resets the TMS7040 and the AY and clears busy. Setting busy directly shows the
  // flag the transition clears; a real command is serviced at once, which section 7 covers.
  d.busy = true;
  check('busy is set before the falling edge', (d.readIO(0xFF7E) & 0x80) === 0);
  d.writeIO(0xFF7D, 0x00);
  check('the 1 -> 0 transition clears the busy flag', (d.readIO(0xFF7E) & 0x80) !== 0, hex(d.readIO(0xFF7E)));
}

// ---------------------------------------------------------------------------------------------------
// 3. the TMS7040's peripheral file: its ports drive the AY and the SP0256, and its status comes back
// ---------------------------------------------------------------------------------------------------
// Port C (P8, >0108) is the control bus. Bit 7 is the busy line back to the CoCo: the firmware clears it
// when it is done (ssc_port_c_w: "if ((m_tms7000_portc & C_BSY) == 0 && (data & C_BSY) == C_BSY) busy = false").
{
  const d = pak();
  d.attach(host());
  outputs(d);
  d.writeIO(0xFF7E, 0x10);   // make it busy
  // the firmware writes port C with bit 7 set: that is the "done" edge
  d.picPort(0x0108, 0x80);
  check('writing port C bit 7 set clears the CoCo busy flag (ssc_port_c_w)', (d.readIO(0xFF7E) & 0x80) !== 0, hex(d.readIO(0xFF7E)));
}
// The AY-3-8913 hangs off port C bits 6 (chip select, 0 = selected), 3 (BDIR) and 0 (BC1), with port D as
// the data bus (ssc_port_c_w: "BDIR = 1, BC1 = 1: latch address"; "BDIR = 1, BC1 = 0: write data").
{
  const d = pak();
  d.attach(host());
  outputs(d);
  d.picPort(0x010A, 0x07);   // port D: the AY address to latch
  d.picPort(0x0108, 0x09);   // port C: ACS=0 (bit 6 clear), BDIR=1 (bit 3), BC1=1 (bit 0): latch address
  // the AY's address latch takes the low nibble when the register-select pattern is applied
  check('port C with ACS clear and BDIR|BC1 set latches the AY address (ssc_port_c_w)', d.ay.latch === 0x07, hex(d.ay.latch));
  d.picPort(0x010A, 0x38);   // port D: AY data
  d.picPort(0x0108, 0x08);   // port C: ACS=0, BDIR=1, BC1=0: write data
  check('port C with ACS clear and BDIR set (BC1 clear) writes AY data (ssc_port_c_w)', d.ay.regs[0x07] === 0x38, hex(d.ay.regs[0x07]));
}
// ALD to the SP0256 is a falling edge of port C bit 5, with the allophone number on port D, and only when
// the port D value is below 64 (ssc_port_c_w: "&& (m_tms7000_portd < 64)").
{
  const d = pak();
  d.attach(host());
  outputs(d);
  d.picPort(0x010A, 0x05);   // port D: allophone 5
  d.picPort(0x0108, 0x20);   // port C: ALD high
  check('ALD high alone does not load an address', d.sp0256.lrq === true && d.sp0256.ald === 0);
  d.picPort(0x0108, 0x00);   // ALD falls
  // the chip takes entry 5 (a bit offset of 5 x 16 from $1000) and drops LRQ until its sequencer takes it
  check('the ALD falling edge loads the allophone (ssc_port_c_w)', d.sp0256.lrq === false && d.sp0256.ald === 0x05 << 4,
    `lrq ${d.sp0256.lrq} ald ${hex(d.sp0256.ald, 3)}`);
  // a port D value of 64 or more is not an allophone
  const d2 = pak();
  d2.attach(host());
  outputs(d2);
  d2.picPort(0x010A, 0x40);
  d2.picPort(0x0108, 0x20);
  d2.picPort(0x0108, 0x00);
  check('a port D value of 64 or more does not load an allophone', d2.sp0256.lrq === true && d2.sp0256.ald === 0, hex(d2.sp0256.ald, 3));
}
// The status read reflects the SP0256's SBY on bit 6 (ff7d_read case 1: "if (m_spo->sby_r()) data |= 0x40"):
// high while the chip is idle, low from an address load until the allophone has played. Entry 2 of our image
// (gen-roms.js) is a LOAD_E of repeat 1 at pitch 30: two pitch periods of 31 samples, under 10 ms at 10 kHz.
{
  const h = host();
  const d = pak();
  d.attach(h);
  outputs(d);
  check('$FF7E bit 6 is high while the SP0256 is idle', (d.readIO(0xFF7E) & 0x40) !== 0, hex(d.readIO(0xFF7E)));
  d.picPort(0x010A, 0x02);
  d.picPort(0x0108, 0x20);
  d.picPort(0x0108, 0x00);
  check('... low once an allophone is loaded (ff7d_read case 1)', (d.readIO(0xFF7E) & 0x40) === 0, hex(d.readIO(0xFF7E)));
  h.advance(20000);
  check('... and high again when it has played', (d.readIO(0xFF7E) & 0x40) !== 0, hex(d.readIO(0xFF7E)));
}

// ---------------------------------------------------------------------------------------------------
// 4. the 2 KB static RAM behind port C bit 4 and bit 3
// ---------------------------------------------------------------------------------------------------
// MAME: a write happens when RCS (bit 4) and RRW (bit 3) are both 0; the address is (port C << 8) + port B,
// masked to $7FF (ssc_port_c_w).
{
  const d = pak();
  d.attach(host());
  outputs(d);
  d.picPort(0x0106, 0x34);   // port B: low address
  d.picPort(0x010A, 0x55);   // port D: the byte
  d.picPort(0x0108, 0x00);   // port C: RCS and RRW both clear -> a write at (0 << 8) + $34
  check('port C bit 4 and 3 both clear writes the static RAM (ssc_port_c_w)', d.ram.length === 0x800 && d.ram[0x34] === 0x55, hex(d.ram[0x34]));
  // a read happens when RCS is clear and RRW is set
  d.picPort(0x0108, 0x08);   // RCS clear, RRW set -> read
  check('port C bit 4 clear and bit 3 set reads the static RAM (ssc_port_d_r)', d.portD === 0x55, hex(d.portD));
}

// ---------------------------------------------------------------------------------------------------
// 5. the TMS7040 runs our own firmware, from a 4 KB image whose vectors are at the top
// ---------------------------------------------------------------------------------------------------
// The PIC's region is 0x1000 bytes (coco_ssc.cpp ROM_REGION(0x1000, PIC_TAG)) and its reset vector is the
// last two bytes, >FFFE/>FFFF, so the firmware image is a complete 4 KB program, not a fragment.
{
  const d = pak();
  d.attach(host());
  outputs(d);
  check('the TMS7040 firmware image is 4 KB', d.firmware.length === 0x1000, String(d.firmware.length));
  // the reset vector must point into the image, or the PIC would execute nothing
  const vec = (d.firmware[0xFFE] << 8) | d.firmware[0xFFF];
  check('the firmware has a reset vector at >FFFE pointing into the image', vec >= 0xF000 && vec <= 0xFFFD, hex(vec, 4));
}

// ---------------------------------------------------------------------------------------------------
// 6. the user's own ROMs: required at run time, rejected when wrong, and never the project's own
// ---------------------------------------------------------------------------------------------------
// AGENTS.md hard rule 1: users supply their own dumps. The Pak needs the TMS7040's internal ROM (4 KB) and
// the SP0256-AL2's allophone data (2 KB), so the device must be constructible with them, refuse to run
// without them, and reject an image of the wrong size with a message that names the problem.
{
  // The PIC's ROM is required: the card cannot run without it. The SP0256's allophone data is NOT required any
  // more (speech is not implemented, so the music side must run without it). Its absence is the
  // documented empty case, kept as null rather than a zero-filled image so a snapshot can tell the two apart.
  let threw = null;
  try {
    const d = new Emu.SpeechSoundPak({ tms7040Rom: new Uint8Array(0x1000) });
    check('the Pak is built without the SP0256 ROM, as the documented empty case', d.sp0256Data === null, String(d.sp0256Data));
  } catch (e) { threw = e; }
  check('the Pak does not refuse to run without the SP0256 ROM', !threw, threw && threw.message);
  threw = null;
  try { new Emu.SpeechSoundPak({ sp0256Rom: new Uint8Array(0x800) }); } catch (e) { threw = e; }
  check('and it still refuses to run without the TMS7040 ROM', !!threw && /TMS7040/i.test(threw.message), threw && threw.message);
  threw = null;
  try { new Emu.SpeechSoundPak({ tms7040Rom: new Uint8Array(0x800), sp0256Rom: new Uint8Array(0x800) }); } catch (e) { threw = e; }
  check('a TMS7040 ROM of the wrong size is rejected', !!threw && /4096|4 KB|0x1000/i.test(threw.message), threw && threw.message);
  threw = null;
  try { new Emu.SpeechSoundPak({ tms7040Rom: new Uint8Array(0x1000), sp0256Rom: new Uint8Array(0x400) }); } catch (e) { threw = e; }
  check('an SP0256 ROM of the wrong size is rejected', !!threw && /2048|2 KB|0x800/i.test(threw.message), threw && threw.message);

  // built correctly, the user's images are the ones actually executed. The image is 4 KB and maps to
  // >F000->FFFF, so its byte at index 0xFFE is CPU address >FFFE, the reset vector's high half.
  const pic = new Uint8Array(0x1000); pic[0xFFE] = 0xF1; pic[0xFFF] = 0x00;
  const allophone = new Uint8Array(0x800); allophone[0x10] = 0xAB;
  const d = new Emu.SpeechSoundPak({ tms7040Rom: pic, sp0256Rom: allophone });
  d.attach(host());
  outputs(d);
  check('the TMS7040 runs the user\'s image',
    d.tms7040.read8(0xFFFE) === 0xF1 && d.tms7040.read8(0xFFFF) === 0x00,
    `${hex(d.tms7040.read8(0xFFFE))} ${hex(d.tms7040.read8(0xFFFF))}`);
  check('and takes its reset vector from the top of it', d.tms7040.pc === 0xF100, hex(d.tms7040.pc, 4));
  check('the SP0256 runs the user\'s data', d.sp0256.rom === d.sp0256Data && d.sp0256Data[0x10] === 0xAB, 'rom image');
}

// ---------------------------------------------------------------------------------------------------
// 7. the interrupt is gated by IOCNT0, not by the request alone (TMS7000 Family Data Manual Figure 3-16)
// ---------------------------------------------------------------------------------------------------
// This firmware writes %>0C to IOCNT0. Figure 3-16 puts INT2's enable in bit 2 and INT2's flag in bit 3, so
// $0C enables INT2 and leaves INT3 masked (INT3's enable is bit 4). The card therefore takes no interrupt and
// stays in its WAIT loop - which is exactly what MAME 0.264 does with the same image. That is the lockstep
// regression case: both sides sit in WAIT, and a core that took the interrupt anyway would diverge.
{
  const h = host();
  const d = pak();
  d.attach(h);
  const loads = [];
  const load = d.sp0256.loadAddress;
  d.sp0256.loadAddress = function (v) { loads.push(v); return load.call(this, v); };
  h.advance(2000);
  check('the firmware reaches its wait loop with interrupts enabled, without any card access',
    d.tms7040.intEnable && d.tms7040.pc >= 0xF000, `${hex(d.tms7040.pc, 4)} st ${hex(d.tms7040.st)}`);
  check("its IOCNT0 has INT3 masked: $0C sets INT2's enable and flag, not INT3's (Figure 3-16)",
    (d.tms7040.iocnt0 & 0x10) === 0 && (d.tms7040.iocnt0 & 0x04) !== 0, hex(d.tms7040.iocnt0));

  d.writeIO(0xFF7E, 0x33);   // a command: busy set, INT3 asserted
  h.advance(2000);
  check('with INT3 masked the card takes no interrupt and the busy flag stays set',
    (d.readIO(0xFF7E) & 0x80) === 0, hex(d.readIO(0xFF7E)));
  check('and the PIC is still in its WAIT loop', d.tms7040.pc === 0xF01C, hex(d.tms7040.pc, 4));
  check('the command did not reach the SP0256 or the AY', loads.length === 0 && d.ay.latch === 0,
    `${loads.length} address loads, AY latch ${hex(d.ay.latch)}`);
}

// 7b. with INT3 enabled per the manual, the same command is serviced end to end
// ---------------------------------------------------------------------------------------------------
// IOCNT0 bit 4 is INT3's enable (Figure 3-16). Enabling it is what makes the card service: the PIC takes the
// interrupt, runs our ISR, drives the SP0256 and the AY, and releases the busy line. Every step is checked, so
// a break anywhere in the chain (the interrupt gate, the firmware, the port wiring, the chip select decode)
// shows up. The firmware image that enables it lives in tools/mame-diff/ssc/ with the lockstep (item c).
{
  const h = host();
  const d = pak();
  d.attach(h);
  h.advance(2000);
  d.tms7040.writeIocnt0(0x30);   // INT3 enable (bit 4) + INT3 flag clear (bit 5): Figure 3-16
  const loads = [];
  const load = d.sp0256.loadAddress;
  d.sp0256.loadAddress = function (v) { loads.push(v); return load.call(this, v); };
  check('IOCNT0 $30 enables INT3', (d.tms7040.iocnt0 & 0x10) !== 0, hex(d.tms7040.iocnt0));

  d.writeIO(0xFF7E, 0x33);   // allophone 51, and a low nibble of 3 for the AY
  h.advance(2000);           // give the card the time to service it
  check('the firmware releases the busy line when it is done', (d.readIO(0xFF7E) & 0x80) !== 0, hex(d.readIO(0xFF7E)));
  // the allophone reached the chip, through its address load
  check('the SP0256 was given the allophone number', loads.length === 1 && loads[0] === 0x33, loads.map((v) => hex(v)).join(','));
  check('the AY latched a register from the command', d.ay.latch === 0x3, hex(d.ay.latch));
  check('and was written a data byte', d.ay.regs[3] === 0x3, hex(d.ay.regs[3]));
}

// ---------------------------------------------------------------------------------------------------
// 8. our 6809 diagnostic firmware runs to its HALT loop on a real CoCo with the Pak inserted
// ---------------------------------------------------------------------------------------------------
// This is the firmware the MAME comparison will run (tools/mame-diff/ssc/ssc.asm). Running it here first
// means the comparison is not the first thing to find out that the handshake does not terminate. The
// firmware drives every command path and ends at HALT; a time-out anywhere increments TIMEOUTS in RAM.
{
  const path = require('path');
  const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware.js');
  const asm = assembleFile(path.join(__dirname, '..', 'tools/mame-diff/ssc/ssc.asm'), '6809');
  const haltPc = asm.symbols.get('HALT');
  // boot.asm in place of BASIC, as the cartridge comparisons do, so the machine starts at $C000
  const fw = romImage(asm, 0xA000, 0x2000, 0x12);   // 8 KB at $A000, the CoCo's `bas` slot
  check('the firmware assembles into the BASIC slot with its vectors at $BFF2',
    fw.length === 0x2000 && ((fw[0x1FFE] << 8) | fw[0x1FFF]) === asm.symbols.get('RESET'), hex((fw[0x1FFE] << 8) | fw[0x1FFF], 4));
  const m = Emu.createMachine('coco', { mameCompat: true });
  // our firmware replaces BASIC; the Pak still goes in the extension slot
  m.setRoms({ bas: fw, extbas: fw });
  m.insertCartridge(pak());
  m.reset(true);
  // run until the HALT loop, with a bound that would be hit only if the handshake never completed. Driven
  // through the machine's own timing, so the card has a truthful ioTime() to run against.
  let steps = 0;
  while (m.cpu.pc !== haltPc && steps < 4000000) { m.runCycles(m.cycle + 1e-9); steps++; }
  check('the 6809 diagnostic firmware reaches its HALT loop', m.cpu.pc === haltPc, `pc ${hex(m.cpu.pc, 4)} after ${steps} instructions`);
  // The 6809 firmware waits for the busy flag to clear, and with this image it never does: IOCNT0 = $0C leaves
  // INT3 masked (Figure 3-16), so the card correctly refuses the interrupt and stays in WAIT. The firmware's
  // poll gives up after POLLMAX and counts a time-out, which is the observable both emulators must agree on.
  // It issues 37 commands (16 in ALLOOP, 4 in HILOOP, 16 in AYLOOP, 1 in section 6), and every one of them
  // times out: the card never takes the masked interrupt, so the flag never clears. Pinning the number
  // matters: "not zero" would also pass a firmware that never issued a command at all, and this is the
  // lockstep regression case for a core that took a masked interrupt.
  check('the card correctly refuses the masked interrupt, so all 37 commands time out',
    m.read(0x0410) === 37, String(m.read(0x0410)));
}

// The card's state at a given machine time must not depend on how the 6809 is driven. The lockstep drives the
// machine with runCycles; a hand-written test drives it with cpu.step(). If those two disagree at an I/O access,
// the comparison is measuring the driving loop, not the hardware - which is exactly how a busy-flag divergence
// appeared only under runCycles.
{
  const path = require('path');
  const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware.js');
  const asm = assembleFile(path.join(__dirname, '..', 'tools/mame-diff/ssc', 'ssc.asm'), '6809');
  const fw = romImage(asm, 0xA000, 0x2000, 0x12);

  // run the firmware one way, recording the card's state at every $FF7E access
  const trace = (mode) => {
    const m = Emu.createMachine('coco', { mameCompat: true });
    m.setRoms({ bas: fw, extbas: fw });
    m.insertCartridge(pak());
    m.reset(true);
    const p = m.cartPort, rows = [];
    // The card's state at each access, recorded from the I/O hooks themselves: polling cpu.pc between calls
    // only works when the caller runs one instruction at a time, and the whole point here is to compare that
    // with a caller that runs a whole slice per call.
    const note = (kind) => rows.push({ kind, tc: m.cpu.totalCycles, ioTime: m.ioTime(), cardPos: p.cardPos.toString(), busy: p.busy, picPC: p.tms7040.pc });
    const origRead = p.readIO.bind(p);
    p.readIO = (a) => { const v = origRead(a); if (a === 0xFF7E) note('R'); return v; };
    const origWrite = p.writeIO.bind(p);
    p.writeIO = (a, v) => { const r = origWrite(a, v); if (a === 0xFF7E) note('W'); return r; };
    // Both paths drive the machine through its own timing (runCycles), so every I/O access has a truthful
    // ioTime(). They differ in how much the caller asks for at a time, which is the real difference between
    // the debugger's single-step (one instruction per call) and the frame loop (a whole slice per call) - and
    // a chunk of many instructions per call is what exposed the original busy-flag divergence.
    // The card's state at a given machine time must not depend on that.
    const chunk = mode === 'step' ? 1e-9 : 198;
    const haltPc = asm.symbols.get('HALT');
    for (let i = 0; i < 4000000 && m.cpu.pc !== haltPc; i++) m.runCycles(m.cycle + chunk);
    return rows;
  };

  const stepped = trace('step'), framed = trace('frame');
  const fmt = (r) => `${r.kind}@io=${r.ioTime.toFixed(2)} cardPos=${r.cardPos} busy=${r.busy ? 'SET' : 'clear'} pic=${r.picPC.toString(16)}`;
  const common = Math.min(stepped.length, framed.length);
  let firstDiff = -1;
  for (let i = 0; i < common; i++) if (fmt(stepped[i]) !== fmt(framed[i])) { firstDiff = i; break; }
  check('the card is in the same state at every $FF7E access, one instruction per call or a slice per call',
    firstDiff === -1 && stepped.length >= 3 && stepped.length === framed.length,
    firstDiff === -1 ? `${common} accesses identical`
      : `access #${firstDiff}: step ${fmt(stepped[firstDiff])} | frame ${fmt(framed[firstDiff])}`);
}

// A $FF7D falling edge at machine time X restarts the PIC at X, in whichever way the 6809 is driven. The card
// must be caught up to exactly X first and never past it, and the PIC's progress starts at X. X is the I/O
// path's own time for that write - the same ioTime() every other device is timed against - not clockUnits(),
// which counts INTO the access.
{
  const path = require('path');
  const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware.js');
  const asm = assembleFile(path.join(__dirname, '..', 'tools/mame-diff', 'ssc', 'ssc.asm'), '6809');
  const fw = romImage(asm, 0xA000, 0x2000, 0x12);

  const atReset = (mode) => {
    const m = Emu.createMachine('coco', { mameCompat: true });
    m.setRoms({ bas: fw, extbas: fw });
    m.insertCartridge(pak());
    m.reset(true);
    const p = m.cartPort;
    let seen = null;
    const origWrite = p.writeIO.bind(p);
    p.writeIO = (a, v) => {
      if (a === 0xFF7D && (p.resetLine & 1) && !(v & 1) && !seen) {
        // X is the card's machine time for this write: ioTime(), the bus-cycle time of the access, which is
        // what every other device in the tree is timed against (AGENTS section 2) and what the card itself
        // catches up to. Both paths below drive through runCycles, so ioTime() is truthful in both. Rounded
        // down the way the card rounds it: whole machine cycles, truncating (see catchUp() in ssc.js).
        seen = { X: String(Math.floor(m.ioTime())), cardNow: String(p.cardPos), picPC: p.tms7040.pc };
      }
      const r = origWrite(a, v);
      if (seen && !seen.after) seen.after = { cardPos: String(p.cardPos), picPC: p.tms7040.pc, picCyc: p.tms7040.totalCycles };
      return r;
    };
    for (let i = 0; i < 4000000 && !(seen && seen.after); i++) {
      m.runCycles(m.cycle + (mode === 'step' ? 1e-9 : 198));   // one instruction per call, or a frame-sized slice
    }
    return seen;
  };

  const a = atReset('step'), b = atReset('frame');
  const show = (r) => r ? `X=${r.X} cardBefore=${r.cardNow} cardAfter=${r.after && r.after.cardPos} pic=${r.after && r.after.picPC.toString(16)} picCyc=${r.after && r.after.picCyc}` : 'not reached';
  console.log(`   step  ${show(a)}`);
  console.log(`   frame ${show(b)}`);

  // The card must be caught up to the machine's time for the write and never past it: ioTime() is a whole
  // machine tick and the card counts one cycle per tick, so the comparison is exact, and it must hold in both
  // paths.
  check('the PIC restarts at f000 in both paths (its cycle count is a lifetime counter, not cleared)',
    !!a && !!b && a.after.picPC === 0xF000 && b.after.picPC === 0xF000,
    `step pic=${a && a.after && a.after.picPC.toString(16)}; frame pic=${b && b.after && b.after.picPC.toString(16)}`);
  check('the reset write happens at the same machine time X in both paths', !!a && !!b && a.X === b.X, `step X=${a && a.X}, frame X=${b && b.X}`);
  check('the card is caught up to exactly X before the PIC restarts (both paths)',
    !!a && !!b && a.after.cardPos === a.X && b.after.cardPos === b.X,
    `step cardPos=${a && a.after && a.after.cardPos} vs X=${a && a.X}; frame cardPos=${b && b.after && b.after.cardPos} vs X=${b && b.X}`);
  check('a reset leaves the card at the same position under both drive paths',
    !!a && !!b && a.after.cardPos === b.after.cardPos,
    `step cardPos=${a && a.after && a.after.cardPos} | frame cardPos=${b && b.after && b.after.cardPos}`);
}

// ---------------------------------------------------------------------------------------------------
// 9. the same firmware with INT3 enabled: the ISR path, and the ordered device-write sequence it produces
// ---------------------------------------------------------------------------------------------------
// ssc.asm ships with WAITBUS bounded because the PIC's %>0C leaves INT3 masked (section 8). This case is the
// other side of that: gen-roms.js builds the PIC with $30 (INT3 enable, bit 4, and INT3 flag clear, bit 5 -
// Figure 3-16) and the 6809 with an unbounded wait, so every command is serviced through the ISR and the
// firmware reaches HALT. Its outcome - the sequence of SP0256 allophone loads and AY register writes - is the
// oracle: it is what the card was told to do, and it does not depend on how the two CPUs are interleaved. It is
// also compared against MAME 0.264 row for row (tools/mame-diff/ssc/compare.js; README, "Verification against
// MAME").
{
  const { runInt3 } = require('../tools/mame-diff/ssc/outcome.js');
  const r = runInt3();
  check('the INT3 case reaches HALT through the ISR', r.halted, `pc after ${r.steps} instructions`);
  // Reaching HALT is what proves every command was answered, because this build's wait is unbounded and has no
  // time-out path (gen-roms.js substitutes `INC TIMEOUTS` out): a command the card did not answer would leave the
  // 6809 polling forever. There is deliberately no separate TIMEOUTS check - $0410 cannot vary in this build, and
  // a check that cannot fail is not evidence (AGENTS.md hard rule 3). The masked case section 8 does count
  // time-outs, because that build keeps the bounded poll.
  check('every command was serviced: 37 rows, each with one AY address+data and an SP0256 load or none',
    r.lines.length === 37, String(r.lines.length));
  // the firmware's loops, in order: allophones 0-15, bytes $40-$43 (above 63, so no SP0256 load), AY 0-15, then
  // section 6's single $21 (which is below 64, so it is an allophone too)
  const sp = r.lines.filter((l) => l.includes('sp0256:load')).length;
  const ay = r.lines.filter((l) => l.includes('ay:addr')).length;
  check('the SP0256 saw 33 loads: 16 allophones, the 16 AY-loop bytes and section 6\'s $21', sp === 33, String(sp));
  check('the AY saw 37 register writes (every command selects it)', ay === 37, String(ay));
  check('the above-63 bytes carried no SP0256 load',
    r.lines.slice(16, 20).every((l) => !l.includes('sp0256:load') && l.includes('ay:addr')), r.lines.slice(16, 20).join(' | '));
  check('section 6\'s command reached the chips as allophone $21 and AY register 1',
    r.lines[36] === '37 sp0256:load=21 ay:addr=01 ay:data=01', r.lines[36]);
  // section 6 reads the status either side of a command and the firmware stores both: $0404 with busy set, $0405
  // once it has been released
  check('the firmware recorded busy at $0404 and cleared at $0405', r.ram[4] === 0x7F && r.ram[5] === 0xFF,
    `$0404=${hex(r.ram[4])} $0405=${hex(r.ram[5])}`);
}

// ---------------------------------------------------------------------------------------------------
// 10. the AY's sound reaches the machine only when the CoCo's sound mux selects the Pak
// ---------------------------------------------------------------------------------------------------
// MAME's coco.cpp:555: bCartSoundEnable = soundmux_status() == (SOUNDMUX_ENABLE | SOUNDMUX_SEL2), where the
// status is SOUNDMUX_ENABLE (PIA1 CB2) | SOUNDMUX_SEL1 (PIA0 CA2) | SOUNDMUX_SEL2 (PIA0 CB2). It is an
// EQUALITY, so ENABLE and SEL2 must be set and SEL1 must be CLEAR; all three set selects a different source and
// the Pak is silent. Each C2 is driven from its PIA control register: bit 5 = C2 is an output, bit 4 = set/reset
// mode, bit 3 = the level in that mode (js/chips/mc6821.js Port.c2), so $38 is level 1 and $30 level 0.
{
  const Emu = require('../tests/load.js')();
  const { buildAsm } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  // one machine with our tone firmware in the Pak, so the AY has something to say
  const { toneFirmware } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { aySingleLevel } = require('../js/chips/ay8910.js');
  const m = Emu.createMachine('coco', { mameCompat: true });
  m.setRoms({ bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12), extbas: new Uint8Array(0x2000).fill(0x12) });
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: new Uint8Array(0x800) }));
  m.reset(true);
  // the firmware selects the mux and plays tone 1 (the sequence starts at frame 30 and the first tone runs for
  // a while); run far enough that a channel is actually sounding, then stop the machine so nothing overwrites
  // the PIA control registers while the gate is exercised
  for (let f = 0; f < 200; f++) m.runFrame();
  m.stalled = true;                        // stop runFrame from stepping the CPU
  m.runFrame = () => true;
  // set the three C2 lines explicitly. js/chips/mc6821.js Port.c2: bit 5 puts C2 in output mode, and in
  // set/reset mode (bit 4) the VALUE is bit 3 - so $38 = 0b00111000 is "set/reset mode, C2 high" and $30 is
  // "set/reset mode, C2 low".
  const setC2 = (port, v) => { port.cr = (port.cr & 0x07) | 0x20 | 0x10 | (v ? 0x08 : 0); };
  // what the card reports to the mixer: the gate decides it, so this observes the SOUND PATH. Note the AY's
  // silence is not zero - its single output with every channel at 0 is 0.158 of the supply, times the Pak's gain
  // of 2 - and that is what makes "level !== 0" useless on its own. The audible case below therefore requires the
  // level to DIFFER from that silence constant, and the closed cases require it to be 0.
  const SILENCE = 2 * aySingleLevel([0, 0, 0]);
  const reported = () => { m.cartPort.ayLevel = NaN; m.cartPort.stepAy(); return m.cartPort.ayLevel; };
  // a channel is audible when a tone or noise path is on AND its volume is non-zero; volEnabled alone is only the
  // waveform gate (ay8910.js:118), so it is true with every volume at 0
  const audible = () => m.cartPort.ay.volEnabled.some((on, c) => on && m.cartPort.ay.regs[8 + c] !== 0);
  check('a tone is playing at this point (so the audible case below is meaningful)',
    audible(), `volumes ${m.cartPort.ay.regs.slice(8, 11).join(',')} enabled ${m.cartPort.ay.volEnabled.join(',')}`);
  setC2(m.pia1.b, true); setC2(m.pia0.b, true); setC2(m.pia0.a, false);
  check('the mux selects the Pak with ENABLE|SEL2 and SEL1 clear (coco.cpp:555)', m.cartPort.muxSelectsCart(),
    `enable=${m.pia1.b.c2()} sel2=${m.pia0.b.c2()} sel1=${m.pia0.a.c2()}`);
  const lvl = reported();
  check('and the card reports the AY\'s SOUND, not its silence constant, to the mixer',
    Math.abs(lvl - SILENCE) > 1e-9, `level ${lvl}, silence constant ${SILENCE}`);
  // each closed case: the gate must silence the card, which is a claim about the reported level, not about
  // muxSelectsCart() alone (a gate removed from stepAy would leave this test reading true otherwise)
  for (const [label, setup] of [
    ['SEL1 also set selects another source', () => { setC2(m.pia0.a, true); }],
    ['ENABLE clear', () => { setC2(m.pia0.a, false); setC2(m.pia1.b, false); }],
    ['SEL2 clear', () => { setC2(m.pia1.b, true); setC2(m.pia0.b, false); }],
  ]) {
    setup();
    const l = reported();
    // a closed gate means the card contributes NOTHING: stepAy reports 0, not the AY's own idle level
    check(`${label}: the card contributes silence to the mixer`,
      !m.cartPort.muxSelectsCart() && l === 0, `level ${l} (expected 0), mux selects ${m.cartPort.muxSelectsCart()}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// 11. in a Multi-Pak slot the Pak is gated by the same machine mux
// ---------------------------------------------------------------------------------------------------
// MAME's coco_multi.cpp forwards set_sound_enable to every slot, so a cartridge in the Multi-Pak gates its audio
// exactly as one in the machine's own slot does. The slot host therefore has to pass the machine's PIAs through,
// or the gate finds no PIA and lets the card through unmuted.
{
  const Emu = require('../tests/load.js')();
  const { aySingleLevel } = require('../js/chips/ay8910.js');
  const { toneFirmware } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { buildAsm } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const m = Emu.createMachine('coco', { mameCompat: true });
  m.setRoms({ bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12), extbas: new Uint8Array(0x2000).fill(0x12) });
  const pak = new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: new Uint8Array(0x800) });
  m.insertCartridge(new Emu.devices.multi([pak, null, null, null]));
  m.reset(true);
  for (let f = 0; f < 200; f++) m.runFrame();
  m.stalled = true; m.runFrame = () => true;
  const inSlot = m.cartPort.slots[0];                  // the Pak, in slot 1
  const reported = () => { inSlot.ayLevel = NaN; inSlot.stepAy(); return inSlot.ayLevel; };
  const setC2 = (port, v) => { port.cr = (port.cr & 0x07) | 0x20 | 0x10 | (v ? 0x08 : 0); };
  // a tone is playing, so the open case below is meaningful
  check('Multi-Pak: a tone is playing in the slot',
    inSlot.ay.volEnabled.some((on, c) => on && inSlot.ay.regs[8 + c] !== 0),
    `volumes ${inSlot.ay.regs.slice(8, 11).join(',')}`);
  setC2(m.pia1.b, true); setC2(m.pia0.b, true); setC2(m.pia0.a, false);
  check('Multi-Pak: with the mux selecting the cartridge, the slotted Pak is heard',
    inSlot.muxSelectsCart() && Math.abs(reported() - 2 * aySingleLevel([0, 0, 0])) > 1e-9, `level ${inSlot.ayLevel}`);
  setC2(m.pia0.a, true);                               // all three high: another source
  check('Multi-Pak: with the mux selecting another source, the slotted Pak is silent',
    !inSlot.muxSelectsCart() && reported() === 0, `level ${inSlot.ayLevel}`);
}

// ---------------------------------------------------------------------------------------------------
// 12. every AY level change is stamped at its own card position, at both SAM rates
// ---------------------------------------------------------------------------------------------------
// catchUp() runs many AY samples in one batch. Each must be reported at the tick IT happened at (the card's
// position), not at the batch's access time: a single shared stamp collapses the batch onto one instant and the
// sound loses its timing. The two rates matter because the SAM rate POKE changes unitAttos, and an expression
// that mixes tickAt() into the arithmetic (tickAt(cardPos - tickAt(0))) is only correct at the normal rate -
// measured at the fast rate it put every stamp 1,387 ticks from its sample's position.
{
  const Emu = require('../tests/load.js')();
  const { buildAsm } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const { toneFirmware } = require('../tools/mame-diff/ssc/gen-roms.js');
  for (const fast of [false, true]) {
    const m = Emu.createMachine('coco', { mameCompat: true });
    m.setRoms({ bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12), extbas: new Uint8Array(0x2000).fill(0x12) });
    m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: new Uint8Array(0x800) }));
    m.reset(true);
    if (fast) m.write(0xFFD7, 0);                    // SAM R0: the fast rate
    for (let f = 0; f < 200; f++) m.runFrame();
    const rateBits = (m.sam.reg >> 11) & 3;
    const pak = m.cartPort;
    pak.cardPos -= 3000n;                            // force one batch large enough to hold several samples
    const rows = [];
    const orig = m.cartSound.bind(m);
    m.cartSound = (tick, level) => { rows.push({ stamp: tick, cardPos: Number(pak.cardPos) }); return orig(tick, level); };
    pak.catchUp();
    m.cartSound = orig;
    const distinct = new Set(rows.map((r) => r.stamp)).size;
    // A sample is stamped with the start of its own period, AY_DIV (4) card cycles long, which ends inside the PIC
    // instruction just run (js/machines/ssc.js stepCard; measured against MAME's -wavwrite). So every stamp is on
    // the AY's 4-cycle grid, is not after the card's position when it is reported, and is less than one
    // instruction (the TMS7000's longest is under 60 cycles) plus a period before it.
    let worst = 0, offGrid = 0;
    for (const r of rows) {
      worst = Math.max(worst, r.cardPos - r.stamp);
      if ((r.stamp - rows[0].stamp) % 4 !== 0 || r.stamp > r.cardPos) offGrid++;
    }
    const label = fast ? 'fast rate' : 'normal rate';
    check(`AY timestamps (${label}): the rate really changed`, fast ? rateBits === 1 : rateBits === 0, `SAM rate bits ${rateBits}`);
    check(`AY timestamps (${label}): several changes in one batch, each with its OWN stamp`,
      rows.length >= 2 && distinct === rows.length, `${rows.length} changes, ${distinct} distinct stamps`);
    check(`AY timestamps (${label}): each stamp is its sample's period start, within the instruction just run`,
      offGrid === 0 && worst < 64, `${offGrid} off the 4-cycle grid or ahead of the card, worst cardPos - stamp ${worst}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The card's clock against MAME's: the first AY write of gen-ay.js's program happens 129 card cycles after
// power-on and the second 216 after it. Those are MAME 0.264's own figures (a Lua tap on the PIC's port C,
// `coco -ext ssc`, the time of each write times 894,886 Hz); 129 is also the sum of the program's first
// instructions' cycle counts. Two bugs this pins:
// the card starting at the CPU's first instruction instead of the power-on origin (it read 133), and the card
// counting one cycle per machine tick on the CoCo 3, where a tick is a quarter of one (it ran 4 times fast).
{
  const { ourMachine } = require('../tools/mame-diff/ssc/audio.js');
  for (const profileId of ['coco', 'coco3']) {
    const m = ourMachine(profileId);
    const pak = m.cartPort;
    // in TIME, as card cycles of the port's 894,886 Hz clock: ticks x cartClockHz / tickHz (not the code's own
    // ticks-per-cycle, which a wrong rate would cancel out of)
    const writes = [];
    const orig = pak.ay.dataW;
    pak.ay.dataW = function (v) {
      writes.push(Math.round(Number(pak.cardPos - BigInt(m.powerOnTick())) * m.cartClockHz / m.tickHz));
      return orig.call(this, v);
    };
    for (let f = 0; f < 3; f++) m.runFrame();
    check(`card clock (${profileId}): the first AY write is 129 card cycles after power-on, as in MAME`,
      writes[0] === 129, `${writes[0]}`);
    // and the second at MAME's 216 (the same tap)
    check(`card clock (${profileId}): the second AY write at 216, as in MAME`, writes[1] === 216, `${writes[1]}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The AY's sample grid. On the hardware the AY makes one sample per 4 card cycles, so the first 894,886 card cycles
// (about a second) hold samples starting at 0, 4, ... 894,884: 223,722. MAME keeps clocks as whole hertz and runs
// the stream at 1,789,772 / 8 = 223,721 samples a second, each 1e18 / 223,721 = 4,469,853,075,929 attoseconds,
// while 894,886 card cycles of 1e18 / 894,886 attoseconds end at 999,999,999,999,449,554: 223,721 sample starts
// fall before that. config.mameCompat follows MAME's grid (docs/verification.md, "Deviations from MAME"); without
// it the hardware's. Both counted from the samples' stamps, the tick each sample starts in.
{
  const Emu = require('../tests/load.js')();
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const { ayPic, ayHost } = require('../tools/mame-diff/ssc/gen-ay.js');
  const { buildSp0256 } = require('../tools/mame-diff/ssc/gen-roms.js');
  for (const [mameCompat, want] of [[false, 223722], [true, 223721]]) {
    const m = Emu.createMachine('coco', { mameCompat });
    m.setRoms(Object.fromEntries(Emu.profiles.coco.roms.map((r) => [r.id, romImage(ayHost(), r.at, r.size, 0x12)])));
    m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: ayPic(), sp0256Rom: buildSp0256() }));
    m.reset(true);
    const pak = m.cartPort, origin = BigInt(m.powerOnTick());
    let count = 0;
    const stepAy = pak.stepAy.bind(pak);
    pak.stepAy = (at) => { if (at - origin < 894886n) count++; return stepAy(at); };
    while (pak.cardPos - origin < 894886n + 100n) m.runFrame();
    const label = mameCompat ? 'mameCompat: MAME\'s whole-hertz stream' : 'hardware: every 4 card cycles';
    check(`AY sample grid (${label}): ${want} samples start in the first 894,886 card cycles`, count === want, `${count}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The Pak's AY output as the machine hears it: MAME's single-output network at the Pak's gain of 2
// ---------------------------------------------------------------------------------------------------
// ssc-tone.asm plays channel A at volume 12 and B at 6 (C silent) with the mux open, so the Pak's level moves among
// the four combinations of the two square waves. MAME 0.264's -wavwrite of the same firmware holds exactly four
// levels (docs/verification.md, "The Speech/Sound Pak's AY sound"): 10,371, 11,110, 16,407 and 16,994 LSB of 32,767.
// Those are the expected values, from MAME's recording, not from this code. The CI has no MAME, so this is what
// keeps the Pak on its single output at gain 2 there: three legacy channel levels added, or the gain left out, give
// other numbers.
{
  const Emu = require('../tests/load.js')();
  const { buildAsm, toneFirmware } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const m = Emu.createMachine('coco', { mameCompat: true });
  m.setRoms({ bas: romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12), extbas: new Uint8Array(0x2000).fill(0x12) });
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: toneFirmware(), sp0256Rom: new Uint8Array(0x800) }));
  m.reset(true);
  const levels = new Set();
  const cartSound = m.cartSound.bind(m);
  m.cartSound = (tick, level) => { if (level !== 0) levels.add(Math.trunc(Math.fround(level) * 32767)); return cartSound(tick, level); };
  for (let f = 0; f < 120; f++) m.runFrame();
  const got = [...levels].sort((a, b) => a - b);
  check('the Pak\'s AY levels are MAME\'s four: 10371, 11110, 16407, 16994 LSB (single output, gain 2)',
    JSON.stringify(got) === JSON.stringify([10371, 11110, 16407, 16994]), got.join(','));
}

// ---------------------------------------------------------------------------------------------------
// An AY write lands after the samples that started before it
// ---------------------------------------------------------------------------------------------------
// On the hardware grid (no mameCompat) the AY makes a sample every 4 card cycles from power-on, at 0, 4, 8, ...
// A register write takes effect at the end of the PIC instruction that makes it (T, in card cycles), so the first
// sample to play the new value is the first to START at or after T: its stamp is T rounded up to a multiple of 4.
// In gen-ay.js's fixed-level steps every level change comes from the AY write just before it (a write that leaves
// the level as it was is followed by none), so each change must carry the stamp its latest write gives. A write applied before the instruction's samples are made
// would put the change on a sample that started before T (MAME's order: docs/verification.md, "When a write lands").
{
  const Emu = require('../tests/load.js')();
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const { ayPic, ayHost } = require('../tools/mame-diff/ssc/gen-ay.js');
  const { buildSp0256 } = require('../tools/mame-diff/ssc/gen-roms.js');
  const m = Emu.createMachine('coco', {});
  m.setRoms(Object.fromEntries(Emu.profiles.coco.roms.map((r) => [r.id, romImage(ayHost(), r.at, r.size, 0x12)])));
  m.insertCartridge(new Emu.SpeechSoundPak({ tms7040Rom: ayPic(), sp0256Rom: buildSp0256() }));
  m.reset(true);
  const pak = m.cartPort;
  let pending = null, pairs = 0, wrong = 0, firstWrong = '';
  // T is taken from the PIC, independently of when the card applies the write: the instruction that decodes an AY
  // data write (atEnd is called inside it) ends at its start plus its cycles. The latest such end is kept; a write
  // that changed nothing is replaced by the next.
  let wrote = false;
  const atEnd = pak.atEnd.bind(pak);
  pak.atEnd = (chip, fn, v) => { if (fn === pak.ay.dataW) wrote = true; return atEnd(chip, fn, v); };
  const step = pak.tms7040.step.bind(pak.tms7040);
  pak.tms7040.step = () => {
    const start = Number(pak.cardPos);
    const cycles = step();
    if (wrote) { pending = start + cycles; wrote = false; }
    return cycles;
  };
  const cartSound = m.cartSound.bind(m);
  m.cartSound = (tick, level) => {
    if (pending !== null) {
      const want = Math.ceil(pending / 4) * 4;
      pairs++;
      if (tick !== want) { wrong++; if (!firstWrong) firstWrong = `write at ${pending}: change stamped ${tick}, want ${want}`; }
      pending = null;
    }
    return cartSound(tick, level);
  };
  for (let f = 0; f < 30; f++) m.runFrame();      // the fixed-level steps: about the first 0.4 s
  check('each AY write first sounds on the first sample to start at or after its instruction\'s end',
    pairs > 50 && wrong === 0, `${pairs} writes, ${wrong} wrong${firstWrong ? `; ${firstWrong}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------
// The SP0256's timing against MAME's own recording. tests/fixtures/ssc/speech-mame.json holds what MAME 0.264 did
// with gen-speak.js's programs and speech image (tools/mame-diff/ssc/speech.js's Lua taps): the time of every
// address load (ALD falling edge) and every change in the $FF7E value the 6809 read, on coco and dragon64. Those
// values come from MAME, not from this code. The CI has no MAME, so this is what keeps there: the address load
// applied at the end of the PIC's instruction, the mameCompat LRQ-ahead rule (an LRQ change due less than a card
// cycle before a PIC instruction reaches INT1 first), the 9,285 Hz grid and the field widths, each of which moves
// loads by a polling pass or more when broken. Same limits as speech.js: each load within half a card cycle, each
// status change on the same 6809 read. To re-record: run speech.js's mame() for each profile and store its loads
// and status with the image it ran.
{
  const mameRec = require('./fixtures/ssc/speech-mame.json');
  const { ours, SECONDS } = require('../tools/mame-diff/ssc/speech.js');
  const { speechImage } = require('../tools/mame-diff/ssc/gen-speak.js');
  // the image MAME ran is stored with its recording and run as it is, so a wrong field width in the decoder misframes
  // it here (gen-speak.js would re-encode with the same wrong width); and the generator must still make that image,
  // or speech.js would compare MAME against something this recording never saw
  const image = new Uint8Array(Buffer.from(mameRec.image, 'base64'));
  check('SP0256 timing: gen-speak.js still builds the speech image MAME\'s recording was made with',
    Buffer.from(speechImage()).equals(Buffer.from(image)),
    Buffer.from(speechImage()).equals(Buffer.from(image)) ? `${image.length} bytes identical` : 'the image differs: re-record tests/fixtures/ssc/speech-mame.json with MAME');
  for (const profileId of ['coco', 'dragon64']) {
    const M = mameRec[profileId], O = ours(profileId, SECONDS, image);
    let worst = 0, bad = -1;
    for (let i = 0; i < Math.min(O.loads.length, M.loads.length); i++) {
      const dt = Math.abs(O.loads[i].t - M.loads[i].t) * O.cartClockHz;
      worst = Math.max(worst, dt);
      if ((O.loads[i].n !== M.loads[i].n || dt >= 0.5) && bad < 0) bad = i;
    }
    check(`SP0256 timing (${profileId}): all ${M.loads.length} address loads at MAME's recorded times, within half a card cycle`,
      O.loads.length === M.loads.length && bad < 0,
      `${O.loads.length} loads, worst ${worst.toFixed(3)} card cycles${bad >= 0 ? `; first off: load ${bad}, ours ${JSON.stringify(O.loads[bad])}, MAME's ${JSON.stringify(M.loads[bad])}` : ''}`);
    check(`SP0256 timing (${profileId}): every $FF7E change on MAME's 6809 read`,
      JSON.stringify(O.status) === JSON.stringify(M.status), `ours ${JSON.stringify(O.status)}, MAME's ${JSON.stringify(M.status)}`);
  }
}

console.log(`${n - fail}/${n} SSC checks passed`);
process.exitCode = fail ? 1 : 0;
