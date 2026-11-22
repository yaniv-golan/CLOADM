/*
 * Dragon Professional (Alpha), as MAME 0.264 builds it (src/mame/trs/dgnalpha.cpp): a Dragon 64 with
 *   - a boot ROM: two 8K ROM banks behind the SAM's $8000-$BFFF (dragon64_state::page_rom). Bank 0, selected at
 *     reset, reads 00 at $8000-$9FFF (unfilled ROM region) and the 8K boot ROM at $A000-$BFFF; bank 1 is the
 *     16K BASIC ROM. PIA1 PB2 switches it as on the Dragon 64 (when PB2 is an output), and so does PIA2 PA2, but
 *     only when bit 2 of PIA2's port B DDR is set (MAME tests port_b_z_mask; the source says "PIA FIXME"). The
 *     switch is a latch, changed by those writes only.
 *   - a third MC6821 (PIA2) at $FF24-$FF27: PA0/PA1 drive the AY-3-8912's BDIR/BC1 (01 write data, 10 read
 *     data into port B, 11 latch address; a port A write or DDR change triggers it), PB0-PB7 its data bus, CB1
 *     the WD2797's DRQ; IRQA/IRQB to FIRQ; CA2 gates the disk NMI.
 *   - an AY-3-8912 at 1 MHz (js/chips/ay8910.js): three channels mixed into the speaker as MAME mixes them
 *     against the DAC (MAME_UNIT below); its port A is the disk latch (js/machines/fdc.js AlphaFdc).
 *   - a WD2797 at 1 MHz with four 3.5" drives, registers reversed at $FF2C-$FF2F (data, sector, track,
 *     status/command); INTRQ raises NMI when PIA2 CA2 is high (or an input, pulled up) as INTRQ rises, and
 *     drops it when INTRQ falls (fdc_intrq_w); NMI merges with the cartridge's.
 *   - a modem at $FF28-$FF2B: reads $FF, writes ignored (MAME emulates nothing more).
 * $FF20-$FF2F is mirrored at $FF30-$FF3F. The Dragon 64's 6551 at $FF04 is the same register stub.
 */
import { SamMachine } from './sam.js';
import { MC6821 } from '../chips/mc6821.js';
import { AY8910 } from '../chips/ay8910.js';
import { AlphaFdc } from './fdc.js';

const AY_HZ = 1000000 / 8;       // the AY's stream: clock / 8
// MAME's mix: each AY channel at 0.75; the 6-bit DAC (binary weighted, gain 2, range -1..1: code 63 swings
// 63/16) at 0.125. Our DAC's code 63 is level 1, so one of our units is MAME's 63/16 x 0.125
export const MAME_UNIT = 63 / 16 * 0.125;
const AY_GAIN = 0.75 / MAME_UNIT;

class AlphaMachine extends SamMachine {
  constructor(profile, config) {
    super(profile, config);
    this.romBank = 0;                 // 0: boot ROM, 1: BASIC (page_rom)
    this.pia2 = new MC6821();
    this.pia2.b.c1 = false;           // CB1 (DRQ) starts low (m_in_cb1 = 0)
    this.pia2Ca2 = false;             // m_out_ca2
    this.pia2InB = 0;                 // port B input pushed by an AY read (m_in_b); 00 until then
    this.pia2.b.input = () => this.pia2InB;
    this.pia2.onIrq = () => this.setLine('pia2', 'firq', this.pia2.irqA() || this.pia2.irqB());
    this.fdc = new AlphaFdc();
    this.ay = new AY8910({ portAWrite: (v) => this.fdc.select(v), portARead: () => 0 });
    this.ayOut = new Float32Array(3);
    this.aySamples = 0;               // AY stream samples run since time 0
    this.ayLevel = 0;
    this.dacLevel = 0;
    this.fdc.onIntrq = (v) => {
      if (v) { if (this.ca2OutputZ()) this.setLine('alphafdc', 'nmi', true); }
      else this.setLine('alphafdc', 'nmi', false);
    };
    this.fdc.onDrq = (v) => this.pia2.setC1('b', v);
    this.fdc.attach(this);
  }

  // ---------------- ROMs ----------------
  romsChanged() {
    if (!this.hasRom) { this.romBanks = [null, null]; return; }
    const boot = new Uint8Array(0x4000), basic = new Uint8Array(0x4000);   // unfilled region bytes read 00
    if (this.roms.boot) boot.set(this.roms.boot.subarray(0, 0x2000), 0x2000);
    if (this.roms.basic) basic.set(this.roms.basic.subarray(0, 0x4000));
    this.romBanks = [boot, basic];
  }
  currentRom() {
    const b = this.romBanks;
    if (!b[0]) return super.currentRom();          // the no-ROM stub
    return b[this.romBank];
  }

  // ---------------- PIA2 ----------------
  // ca2_output_z: CA2's output, or high (pulled up) while it is an input
  ca2OutputZ() { return this.pia2Ca2 || !(this.pia2.a.cr & 0x20); }
  // control_a_w's CA2 handling
  pia2ControlA(prevCr) {
    const cr = this.pia2.a.cr, wasOutput = !!(prevCr & 0x20);
    if (cr & 0x20) {
      if (cr & 0x10) { const set = !!(cr & 0x08); if (!wasOutput || this.pia2Ca2 !== set) this.pia2Ca2 = set; }
      else if (!wasOutput || !this.pia2Ca2) this.pia2Ca2 = true;
    }
  }
  // pia2_pa_w with the port A output (get_out_a_value: inputs pulled high)
  pia2PortA(data) {
    if (this.pia2.b.ddr & 0x04) this.romBank = data & 0x04 ? 0 : 1;
    const bOut = this.pia2.b.or & this.pia2.b.ddr;   // b_output: input pins read as 0
    switch (data & 3) {
      case 1: this.syncAy(this.ioTime()); this.ay.dataW(bOut); break;
      case 2: this.pia2InB = this.ay.dataR(); break;
      case 3: this.ay.addressW(bOut); break;
      default: break;
    }
  }

  // ---------------- memory map: $FF20-$FF3F ----------------
  read(a) {
    if (a < 0xFF20 || a >= 0xFF40 || (a & 0x0F) < 4) return super.read(a);
    this.processEvents(this.ioTime());
    const off = a & 0x0F;
    if (off < 8) return this.pia2.read(off & 3);
    if (off < 12) return 0xFF;                             // modem
    return this.fdc.wdRead(15 - off, a);                   // $FF2C data ... $FF2F status
  }
  write(a, v) {
    if (a < 0xFF20 || a >= 0xFF40) { super.write(a, v); return; }
    const off = a & 0x0F;
    if (off < 4) {
      // PIA1: port B data or DDR writes reach pia1_pb_changed (ROM paging through PB2)
      const p = this.pia1.b, ddr = p.ddr, isData = !!(p.cr & 0x04);
      super.write(a, v);
      if ((off & 3) === 2 && (isData || p.ddr !== ddr) && (p.ddr & 0x04)) this.romBank = p.or & 0x04 ? 0 : 1;
      return;
    }
    this.processEvents(this.ioTime());
    if (off < 8) {
      const p = this.pia2.a, reg = off & 3, ddr = p.ddr, cr = p.cr, isData = !!(cr & 0x04);
      this.pia2.write(reg, v);
      if (reg === 1) this.pia2ControlA(cr);
      else if (reg === 0 && (isData || p.ddr !== ddr)) this.pia2PortA(p.outValue());
      return;
    }
    if (off < 12) return;                                  // modem
    this.fdc.wdWrite(15 - off, v, a);
  }

  // ---------------- sound: the DAC (and single bit) plus the AY ----------------
  setSoundLevel(level) {
    this.syncAy(this.cycle);
    this.dacLevel = level;
    this.pushLevel(this.cycle);
  }
  pushLevel(cycle) {
    const level = this.dacLevel + this.ayLevel;
    if (level === this.soundLevel) return;
    this.soundLevel = level;
    this.audioEvents.push(Math.max(0, cycle - this.frameBase), level);
  }
  // run the AY's stream up to `cycle`, recording each change of its output
  syncAy(cycle) {
    const target = Math.floor(cycle * AY_HZ / this.tickHz);
    while (this.aySamples < target) {
      const o = this.ay.step(this.ayOut);
      this.aySamples++;
      const level = (o[0] + o[1] + o[2]) * AY_GAIN;
      if (level !== this.ayLevel) { this.ayLevel = level; this.pushLevel(this.aySamples * this.tickHz / AY_HZ); }
    }
  }
  frameEnd(end) { this.syncAy(end); }

  // ---------------- reset ----------------
  reset(hard) {
    super.reset(hard);
    // device_reset order as MAME adds them: the WD2797 and drives, the AY (its first register 7 write puts
    // $FF on port A: drive 3 selected, motors on, single density), PIA2 (port A pulled up: $FF latches the
    // AY address from port B), then machine_reset: the boot ROM bank
    // at power-on MAME resets its devices at time 0, resetOffset cycles before the CPU's first: the drives
    // start turning then
    const clock = this.fdc.clock;
    if (hard) clock.current = BigInt(this.clockUnits() - this.resetOffset) * this.unitAttos;
    try {
      this.fdc.reset(hard);
      this.ay.reset();
      this.pia2.reset();
      this.pia2Ca2 = false;
      this.pia2PortA(0xFF);
    } finally { clock.current = null; }
    this.fdc.clock.reschedule();
    this.romBank = 0;
    if (hard) { this.aySamples = Math.floor(this.cycle * AY_HZ / this.tickHz); this.ayLevel = 0; }
  }

  // ---------------- state ----------------
  saveState() {
    return Object.assign(super.saveState(), {
      alpha: {
        romBank: this.romBank, pia2: this.pia2.saveState(), pia2Ca2: this.pia2Ca2, pia2InB: this.pia2InB,
        ay: this.ay.saveState(), aySamples: this.aySamples, ayLevel: this.ayLevel, dacLevel: this.dacLevel,
        fdc: this.fdc.saveState(),
      },
    });
  }
  loadState(s) {
    super.loadState(s);
    if (!s.alpha) throw new Error('snapshot: missing "alpha"');
    const a = s.alpha;
    this.romBank = a.romBank; this.pia2.loadState(a.pia2); this.pia2Ca2 = a.pia2Ca2; this.pia2InB = a.pia2InB;
    this.ay.loadState(a.ay); this.aySamples = a.aySamples; this.ayLevel = a.ayLevel; this.dacLevel = a.dacLevel;
    this.fdc.loadState(a.fdc);
  }
}

export { AlphaMachine };
