/*
 * MOS 6551 ACIA (the Dragon 64's serial port), following MAME 0.264's model (src/devices/machine/mos6551.cpp)
 * state for state, so that firmware runs identically in both.
 *
 * Registers (read / write): 0 receive data / transmit data, 1 status / programmed reset, 2 command, 3 control.
 * Status bits: 7 IRQ, 6 DSR, 5 DCD (both set = not asserted), 4 transmit data register empty, 3 receive data
 * register full, 2 overrun, 1 framing error, 0 parity error.
 *
 * The chip is clocked from outside: its internal baud rate generator divides the 1.8432 MHz crystal by the
 * control register's rate (internal_divider), and the host runs that clock (clockHz, onClock) and calls
 * clockEdge(level) on each edge; the receiver acts on rising edges, the transmitter on falling ones, 16 clocks a
 * bit. The clock runs only while DTR is asserted (command bit 0) or a character is being received
 * (update_divider). Lines: rxd / cts / dsr / dcd inputs (setRxd ...), onTxd / onRts / onDtr / onIrq outputs.
 *
 * onTrace(kind, byte), when set, hears the character boundaries (a diagnostic hook, not chip state): 'tx-load' the
 * transmitter takes a byte from the transmit data register (its start bit begins), 'tx' that byte's stop bit has
 * ended, 'rx' a received byte goes into the receive data register (with 'framing' and 'parity' after it when it
 * has those errors), 'overrun' a received byte is lost because the register was still full.
 */
import { state } from '../util.js';

const SR_PARITY_ERROR = 0x01, SR_FRAMING_ERROR = 0x02, SR_OVERRUN = 0x04, SR_RDRF = 0x08, SR_TDRE = 0x10;
const SR_DCD = 0x20, SR_DSR = 0x40, SR_IRQ = 0x80;
const IRQ_DCD = 1, IRQ_DSR = 2, IRQ_RDRF = 4, IRQ_TDRE = 8;
const START = 0, DATA = 1, STOP = 2;
const MARK = 0, TXD = 1, BREAK = 2;
const PARITY_NONE = 0, PARITY_ODD = 1, PARITY_EVEN = 3, PARITY_MARK = 5, PARITY_SPACE = 7;
const INTERNAL_DIVIDER = [1, 2304, 1536, 1048, 856, 768, 384, 192, 96, 64, 48, 32, 24, 16, 12, 6];
const TRANSMITTER_CONTROLS = [[0, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1]];   // tx irq, tx enable, break
export const ACIA_XTAL = 1843200;

export class MOS6551 {
  constructor() {
    this.onIrq = null;      // (asserted) => void
    this.onTxd = null;      // (level) => void
    this.onRts = null;      // (level) => void
    this.onDtr = null;      // (level) => void
    this.onClock = null;    // (hz) => void: the internal clock's rate changed (0: stopped)
    this.onTrace = null;    // (kind, byte) => void: character boundaries (see the header); not state
    this.control = 0; this.command = 0; this.status = 0; this.tdr = 0; this.rdr = 0;
    this.irqState = 0; this.irq = 0;
    this.txd = 0; this.rts = 0; this.dtr = 0;
    this.cts = 1; this.dsr = 1; this.dcd = 1; this.rxd = 1;
    this.divide = 0; this.clockScale = 0;
    this.wordlength = 0; this.extrastop = 0; this.brk = 0; this.echo = 0; this.parity = 0;
    this.rxState = START; this.rxClock = 0; this.rxBits = 0; this.rxShift = 0; this.rxParity = 0; this.rxCounter = 0;
    this.rxIrqEnable = 0; this.rxInternalClock = 0;
    this.txState = START; this.txOutput = MARK; this.txClock = 0; this.txBits = 0; this.txShift = 0; this.txParity = 0;
    this.txCounter = 0; this.txEnable = 0; this.txIrqEnable = 0; this.txInternalClock = 0;
  }
  // device_start: the outputs' first levels
  start() { this.outputTxd(1); this.outputRts(1); this.outputDtr(1); }
  reset() {
    this.status = SR_TDRE;
    if (this.dsr) this.status |= SR_DSR;
    if (this.dcd) this.status |= SR_DCD;
    this.rxState = START;
    this.rxCounter = 0;
    this.writeCommand(0);
    this.writeControl(0);
    this.irqState = 0;
    this.updateIrq();
  }
  // the internal clock's rate in Hz (0: stopped), as MAME's clock device takes it: crystal x scale, whole Hz
  get clockHz() { return this.clockScale ? Math.floor(ACIA_XTAL * this.clockScale) : 0; }

  // ---- outputs ----
  outputIrq(irq) {
    if (this.irq !== irq) {
      this.irq = irq;
      if (this.irq) this.status &= ~SR_IRQ; else this.status |= SR_IRQ;
      if (this.onIrq) this.onIrq(!this.irq);
    }
  }
  outputTxd(txd) {
    if (this.txOutput === MARK) txd = 1;
    else if (this.txOutput === BREAK) txd = 0;
    if (this.txd !== txd) { this.txd = txd; if (this.onTxd) this.onTxd(txd); }
  }
  outputRts(v) { if (this.rts !== v) { this.rts = v; if (this.onRts) this.onRts(v); } }
  outputDtr(v) { if (this.dtr !== v) { this.dtr = v; if (this.onDtr) this.onDtr(v); } }
  updateIrq() { this.outputIrq(this.irqState !== 0 ? 0 : 1); }
  updateDivider() {
    let scale = INTERNAL_DIVIDER[this.control & 0x0F];
    this.txInternalClock = 1;
    this.divide = 16;
    scale = (!this.dtr || this.rxState !== START) ? 1 / scale : 0;
    // MAME device_t::set_clock_scale: nothing happens unless the scale changes; then the clock re-initialises
    if (scale !== this.clockScale) { this.clockScale = scale; if (this.onClock) this.onClock(this.clockHz); }
  }

  // ---- registers ----
  read(reg) {
    switch (reg & 3) {
      case 0: this.status &= ~(SR_PARITY_ERROR | SR_FRAMING_ERROR | SR_OVERRUN | SR_RDRF); return this.rdr;
      case 1: {
        let s = this.status;
        if (this.cts) s &= ~SR_TDRE;
        if (this.irqState !== 0) { this.irqState = 0; this.updateIrq(); }
        return s;
      }
      case 2: return this.command;
      default: return this.control;
    }
  }
  // the value a read would give, without its side effects (debugger, snapshots of the screen)
  peek(reg) {
    switch (reg & 3) {
      case 0: return this.rdr;
      case 1: return this.cts ? this.status & ~SR_TDRE : this.status;
      case 2: return this.command;
      default: return this.control;
    }
  }
  write(reg, v) {
    switch (reg & 3) {
      case 0: this.tdr = v; this.status &= ~SR_TDRE; break;
      case 1:
        this.status &= ~SR_OVERRUN;
        this.irqState &= ~(IRQ_DCD | IRQ_DSR);
        this.updateIrq();
        this.writeCommand(this.command & ~0x1F);
        break;
      case 2: this.writeCommand(v); break;
      default: this.writeControl(v);
    }
  }
  writeControl(v) {
    this.control = v;
    this.updateDivider();
    this.rxInternalClock = (v >> 4) & 1;
    this.wordlength = 8 - ((v >> 5) & 3);
    this.extrastop = (v >> 7) & 1;
  }
  writeCommand(v) {
    this.command = v;
    this.outputDtr(!(v & 1) ? 1 : 0);
    this.rxIrqEnable = !((v >> 1) & 1) && !this.dtr ? 1 : 0;
    const tc = TRANSMITTER_CONTROLS[(v >> 2) & 3];
    this.txIrqEnable = tc[0] && !this.dtr ? 1 : 0;
    this.txEnable = tc[1];
    this.brk = tc[2];
    this.echo = (v >> 4) & 1;
    this.parity = (v >> 5) & 7;
    if (!(this.parity & 1)) this.parity = PARITY_NONE;
    this.outputRts(!(this.txEnable || this.echo) ? 1 : 0);
    if (this.dtr || this.rts) { this.txOutput = MARK; this.outputTxd(1); }
    this.updateDivider();
  }
  stoplength() {
    if (this.extrastop === 1) {
      if (this.wordlength === 5 && this.parity === PARITY_NONE) return this.divide + this.divide / 2;
      if (this.wordlength < 8 || this.parity === PARITY_NONE) return this.divide * 2;
    }
    return this.divide;
  }

  // ---- input lines ----
  setRxd(v) { this.rxd = v; }
  setCts(v) {
    if (this.cts !== v) {
      this.cts = v;
      if (this.cts && this.txOutput === TXD) { this.txOutput = MARK; this.outputTxd(1); }
    }
  }
  setDsr(v) { this.dsr = v; }
  setDcd(v) { this.dcd = v; }

  // ---- the internal clock (transmitter_clock, receiver_clock) ----
  clockEdge(level) {
    if (this.rxInternalClock) this.receiverClock(level);
    if (this.txClock === level) return;
    this.txClock = level;
    if (this.txClock || this.dtr) return;
    if (this.echo) this.outputTxd(!(this.status & SR_OVERRUN) ? this.rxd : 1);
    if (!this.txEnable) return;
    if (!this.cts && this.txOutput === MARK && !(this.status & SR_TDRE)) { this.txState = START; this.txCounter = 0; }
    this.txCounter++;
    switch (this.txState) {
      case START:
        this.txCounter = 0;
        this.txState = DATA;
        this.txShift = this.tdr;
        this.txBits = 0;
        this.txParity = 0;
        if (this.cts) this.txOutput = MARK;
        else if (!(this.status & SR_TDRE)) { this.txOutput = TXD; this.status |= SR_TDRE; if (this.onTrace) this.onTrace('tx-load', this.txShift); }
        else if (this.brk) this.txOutput = BREAK;
        else this.txOutput = MARK;
        if (this.txIrqEnable && this.txOutput !== BREAK) { this.irqState |= IRQ_TDRE; this.updateIrq(); }
        this.outputTxd(0);
        break;
      case DATA:
        if (this.txCounter === this.divide) {
          this.txCounter = 0;
          if (this.txBits < this.wordlength) {
            this.outputTxd((this.txShift >> this.txBits) & 1);
            this.txBits++;
            this.txParity ^= this.txd;
          } else if (this.txBits === this.wordlength && this.parity !== PARITY_NONE) {
            this.txBits++;
            if (this.parity === PARITY_ODD) this.txParity = this.txParity ? 0 : 1;
            else if (this.parity === PARITY_MARK) this.txParity = 1;
            else if (this.parity === PARITY_SPACE) this.txParity = 0;
            this.outputTxd(this.txParity);
          } else {
            this.txState = STOP;
            this.outputTxd(1);
          }
        }
        break;
      case STOP:
        if (this.txCounter >= this.stoplength()) {
          if (this.txOutput === BREAK) {
            if (!this.brk) { this.txCounter = 0; this.txState = STOP; this.txOutput = TXD; this.outputTxd(1); }
            else this.txCounter--;
          } else {
            if (this.onTrace && this.txOutput === TXD) this.onTrace('tx', this.txShift);
            this.txState = START; this.txCounter = 0;
          }
        }
        break;
    }
  }
  receiverClock(level) {
    if (this.rxClock === level) return;
    this.rxClock = level;
    if (!this.rxClock) return;
    if ((this.irqState & IRQ_DCD) === 0 && !this.dcd !== !(this.status & SR_DCD)) {
      this.status ^= SR_DCD;
      if (!this.dtr) { this.irqState |= IRQ_DCD; this.updateIrq(); }
    }
    if ((this.irqState & IRQ_DSR) === 0 && !this.dsr !== !(this.status & SR_DSR)) {
      this.status ^= SR_DSR;
      if (!this.dtr) { this.irqState |= IRQ_DSR; this.updateIrq(); }
    }
    this.rxCounter++;
    switch (this.rxState) {
      case START:
        if (this.rxCounter === 1 && !(!this.rxd && !this.dtr)) this.rxCounter = 0;
        if (this.rxCounter >= this.divide / 2) {
          if (!this.rxd) { this.rxState = DATA; this.rxCounter = 0; this.rxShift = 0; this.rxParity = 0; this.rxBits = 0; }
          else this.rxCounter = 0;
        }
        break;
      case DATA:
        if (this.rxCounter === this.divide) {
          this.rxCounter = 0;
          if (this.rxd) this.rxShift |= 1 << this.rxBits;
          this.rxBits++;
          this.rxParity ^= this.rxd;
          if ((this.rxBits === this.wordlength && this.parity === PARITY_NONE) ||
              (this.rxBits === this.wordlength + 1 && this.parity !== PARITY_NONE)) this.rxState = STOP;
        }
        break;
      case STOP:
        if (this.rxCounter >= this.stoplength()) {
          this.rxCounter = 0;
          if (!(this.status & SR_RDRF)) {
            if (!this.rxd) this.status |= SR_FRAMING_ERROR;
            if ((this.parity === PARITY_ODD && !this.rxParity) || (this.parity === PARITY_EVEN && this.rxParity)) this.status |= SR_PARITY_ERROR;
            this.rdr = this.rxShift & 0xFF;   // (an 8-bit register: with 8 bits and parity, the parity bit is shifted in as bit 8)
            if (this.wordlength === 7 && this.parity !== PARITY_NONE) this.rdr &= 0x7F;
            this.status |= SR_RDRF;
            if (this.onTrace) {
              this.onTrace('rx', this.rdr);
              if (this.status & SR_FRAMING_ERROR) this.onTrace('framing', this.rdr);
              if (this.status & SR_PARITY_ERROR) this.onTrace('parity', this.rdr);
            }
          } else {
            this.status |= SR_OVERRUN;
            if (this.onTrace) this.onTrace('overrun', this.rxShift & 0xFF);
          }
          if (this.rxIrqEnable) { this.irqState |= IRQ_RDRF; this.updateIrq(); }
          this.rxState = START;
          if (this.dtr) this.updateDivider();
        }
        break;
    }
  }
  saveState() { return state.save(this, MOS6551.STATE); }
  loadState(s) { state.load(this, s, MOS6551.STATE); }
}
MOS6551.STATE = ['control', 'command', 'status', 'tdr', 'rdr', 'irqState', 'irq', 'txd', 'rts', 'dtr', 'cts', 'dsr', 'dcd', 'rxd',
  'divide', 'clockScale', 'wordlength', 'extrastop', 'brk', 'echo', 'parity', 'rxState', 'rxClock', 'rxBits', 'rxShift', 'rxParity',
  'rxCounter', 'rxIrqEnable', 'rxInternalClock', 'txState', 'txOutput', 'txClock', 'txBits', 'txShift', 'txParity', 'txCounter',
  'txEnable', 'txIrqEnable', 'txInternalClock'];
