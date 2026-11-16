/* MC6821 Peripheral Interface Adapter */
import { state } from '../util.js';

class Port {
  constructor() {
    this.ddr = 0; this.or = 0; this.cr = 0;
    this.irq1 = false; this.irq2 = false;
    this.c1 = true; // current C1 input level
    this.input = () => 0xFF;
    // called with outValue() when the output register is written, and when a DDR write changes the DDR (as MAME's
    // 6821pia.cpp calls a port's output callback: port_a_w, ddr_a_w)
    this.onOutput = null;
  }
  // value on the port pins: outputs driven, inputs from peripheral
  value() { return (this.or & this.ddr) | (this.input() & ~this.ddr & 0xFF); }
  // value seen by the peripheral on output pins (inputs float high)
  outValue() { return (this.or & this.ddr) | (~this.ddr & 0xFF); }
  // C2 as output (bit 5 set). Manual mode uses bit 3; other modes idle high.
  c2() {
    if (!(this.cr & 0x20)) return false;
    if (this.cr & 0x10) return !!(this.cr & 0x08);
    return true;
  }
  irq() { return (this.irq1 && (this.cr & 0x01) !== 0) || (this.irq2 && (this.cr & 0x28) === 0x08); }
}

const PORT_STATE = ['ddr', 'or', 'cr', 'irq1', 'irq2', 'c1'];

class MC6821 {
  saveState() { const S = state; return { a: S.save(this.a, PORT_STATE), b: S.save(this.b, PORT_STATE) }; }
  loadState(s) { const S = state; S.load(this.a, s.a, PORT_STATE); S.load(this.b, s.b, PORT_STATE); }

  constructor() {
    this.a = new Port();
    this.b = new Port();
    this.onChange = null; // called after any register write
    this.onIrq = null;    // called when irq state may have changed
  }
  reset() {
    for (const s of [this.a, this.b]) { s.ddr = 0; s.or = 0; s.cr = 0; s.irq1 = s.irq2 = false; }
    this.notifyIrq();
    if (this.onChange) this.onChange();
    // port A's pins are all inputs now, pulled high, which its output callback sees (MAME 6821pia.cpp
    // device_reset: out_a(0xff))
    if (this.a.onOutput) this.a.onOutput(this.a.outValue());
  }
  notifyIrq() { if (this.onIrq) this.onIrq(); }
  irqA() { return this.a.irq(); }
  irqB() { return this.b.irq(); }

  read(reg) {
    const s = (reg & 2) ? this.b : this.a;
    if (reg & 1) return (s.cr & 0x3F) | (s.irq1 ? 0x80 : 0) | (s.irq2 ? 0x40 : 0);
    if (s.cr & 0x04) {
      const v = s.value();
      if (s.irq1 || s.irq2) { s.irq1 = s.irq2 = false; this.notifyIrq(); }
      return v;
    }
    return s.ddr;
  }
  write(reg, v) {
    const s = (reg & 2) ? this.b : this.a;
    let out = false;
    if (reg & 1) { s.cr = v & 0x3F; this.notifyIrq(); }
    else if (s.cr & 0x04) { s.or = v; out = true; }
    else { out = s.ddr !== v; s.ddr = v; }
    if (this.onChange) this.onChange();
    if (out && s.onOutput) s.onOutput(s.outValue());
  }
  // set C1 input line level for a side ('a' or 'b')
  setC1(side, level) {
    const s = this[side];
    if (s.c1 === level) return;
    s.c1 = level;
    const rising = !!(s.cr & 0x02);
    if (level === rising) { s.irq1 = true; this.notifyIrq(); }
  }
}

export { MC6821 };
