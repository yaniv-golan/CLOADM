/*
 * Western Digital floppy disk controllers: WD2797 (Dragon FDC, analog data separator), WD2791 (Premier / Delta
 * FDC, analog) and WD1773 (CoCo FDC, digital data separator). A port of MAME 0.264's wd_fdc.cpp and fdc_pll.cpp, so that every register,
 * command, status bit, DRQ and INTRQ change happens at MAME's time:
 *   - commands, track and sector writes take effect delay_register_commit / delay_command_commit clocks
 *     after the CPU write (doubled in FM);
 *   - type I commands step at the r1r0 rate, verify by reading an ID field, settle 30,000 clocks with h/V;
 *   - type II/III commands read and write bit by bit through the chip's data separator (MAME's PLL models,
 *     analog for the 179x/279x family, the WD1770 family's digital one), so DRQ rises when a byte has
 *     really passed the head; a record not found takes five index pulses;
 *   - the live bit state runs ahead and is rolled back when the CPU looks, as MAME's live_run/live_sync,
 *     which keeps the results identical to MAME's.
 * Time is exact (attotime, js/chips/attotime.js) through an AttoClock (js/chips/attoclock.js). The chip
 * knows nothing about machines: the board connects intrq(state), drq(state) and the drives.
 *
 *   new WD17xx(variant, clock, fdcClock, name, { forceReady })   variant 'wd2797' | 'wd2791' | 'wd1773'; fdcClock
 *                                          in Hz (1 MHz, 8 MHz); forceReady: READY tied active (default)
 *   onIntrq(level), onDrq(level)           callbacks
 *   read(reg) / write(reg, v)              0 status/command, 1 track, 2 sector, 3 data
 *   setFloppy(drive|null), ddenW(fm)       dden: true = FM (single density), as MAME's dden line
 *   reset()
 *
 * Variant parameters are MAME's (wd_fdc.cpp constructors). The WD2797 derives the sector length from the
 * ID field's length code and the command's b flag (calc_sector_size), selects the side with the command's
 * S flag (SSO) and has a head-load line; the WD1773 compares the side (C flag) and steps at 6/12/20/30 ms.
 * The WD2791 has the WD2797's timing and head load, but compares the side (C and S flags) instead of selecting
 * it, takes the length code alone, and has an inverted data bus: the CPU reads and writes every register as
 * its complement (bus_invert_value).
 */
import { NEVER, ZERO, mul, div, fromTicks, fromDouble, asDouble, fromMsec, toText, fromText } from './attotime.js';

const S_BUSY = 0x01, S_DRQ = 0x02, S_IP = 0x02, S_TR00 = 0x04, S_LOST = 0x04, S_CRC = 0x08, S_RNF = 0x10,
  S_HLD = 0x20, S_SPIN = 0x20, S_DDM = 0x20, S_WP = 0x40, S_NRDY = 0x80, S_MON = 0x80;
const I_RDY = 0x01, I_NRDY = 0x02, I_IDX = 0x04, I_IMM = 0x08;

// states (wd_fdc.h, same order)
const ST = {};
['IDLE', 'RESTORE', 'SEEK', 'STEP', 'READ_SECTOR', 'READ_TRACK', 'READ_ID', 'WRITE_TRACK', 'WRITE_SECTOR',
  'SPINUP', 'SPINUP_WAIT', 'SPINUP_DONE', 'SETTLE_WAIT', 'SETTLE_DONE', 'WRITE_PROTECT_WAIT', 'WRITE_PROTECT_DONE',
  'DATA_LOAD_WAIT', 'DATA_LOAD_WAIT_DONE', 'SEEK_MOVE', 'SEEK_WAIT_STEP_TIME', 'SEEK_WAIT_STEP_TIME_DONE',
  'SEEK_WAIT_STABILIZATION_TIME', 'SEEK_WAIT_STABILIZATION_TIME_DONE', 'SEEK_DONE', 'WAIT_INDEX', 'WAIT_INDEX_DONE',
  'SCAN_ID', 'SCAN_ID_FAILED', 'SECTOR_READ', 'SECTOR_WRITE', 'TRACK_DONE', 'INITIAL_RESTORE', 'DUMMY',
  'SEARCH_ADDRESS_MARK_HEADER', 'READ_HEADER_BLOCK_HEADER', 'READ_DATA_BLOCK_HEADER', 'READ_ID_BLOCK_TO_LOCAL',
  'READ_ID_BLOCK_TO_DMA', 'READ_ID_BLOCK_TO_DMA_BYTE', 'SEARCH_ADDRESS_MARK_DATA', 'SEARCH_ADDRESS_MARK_DATA_FAILED',
  'READ_SECTOR_DATA', 'READ_SECTOR_DATA_BYTE', 'READ_TRACK_DATA', 'READ_TRACK_DATA_BYTE', 'WRITE_TRACK_DATA',
  'WRITE_BYTE', 'WRITE_BYTE_DONE', 'WRITE_SECTOR_PRE', 'WRITE_SECTOR_PRE_BYTE'].forEach((n, i) => { ST[n] = i; });
const PT_NONE = 0, PT_CRC_1 = 1, PT_CRC_2 = 2;

export const WD_VARIANTS = {
  wd2797: {
    analog: true, stepTimes: [6000, 12000, 20000, 30000], delayRegisterCommit: 16, delayCommandCommit: 12, busInvert: 0,
    sideControl: true, sideCompare: false, headControl: true, hldTimeout: 15, motorControl: false, readyHooked: true,
    sectorSize: (size, command) => (command & 0x08 ? 128 << (size & 3) : 128 << ((size + 1) & 3)), settleTime: 60000,
  },
  wd1773: {
    analog: false, stepTimes: [12000, 24000, 40000, 60000], delayRegisterCommit: 16, delayCommandCommit: 48, busInvert: 0,
    sideControl: false, sideCompare: true, headControl: false, hldTimeout: 0, motorControl: false, readyHooked: true,
    sectorSize: (size) => 128 << (size & 3), settleTime: 60000,
  },
  // the data bus is inverted (bus_invert_value 0xff): registers read and write as the complement. ENMF is an
  // input MAME leaves unconnected on the boards that use the chip, so the PLL never halves its clock
  wd2791: {
    analog: true, stepTimes: [6000, 12000, 20000, 30000], delayRegisterCommit: 16, delayCommandCommit: 12, busInvert: 0xff,
    sideControl: false, sideCompare: true, headControl: true, hldTimeout: 15, motorControl: false, readyHooked: true,
    sectorSize: (size) => 128 << (size & 3), settleTime: 60000,
  },
};

// ---------------------------------------------------------------- data separators
// fdc_pll_t (fdc_pll.cpp): the analog PLL of the 179x/279x
class AnalogPll {
  constructor() { this.period = 0n; this.periodAdjustBase = 0n; this.minPeriod = 0n; this.maxPeriod = 0n; this.ctime = 0n; this.phaseAdjust = 0n; this.freqHist = 0; this.writeStart = NEVER; this.writeBuffer = []; }
  copy() { const c = new AnalogPll(); Object.assign(c, this); c.writeBuffer = this.writeBuffer.slice(); return c; }
  setClock(period) {
    this.period = period;
    const d = asDouble(period);
    this.periodAdjustBase = fromDouble(d * 0.05);
    this.minPeriod = fromDouble(d * 0.75);
    this.maxPeriod = fromDouble(d * 1.25);
  }
  reset(when) { this.ctime = when; this.phaseAdjust = 0n; this.freqHist = 0; this.writeBuffer = []; this.writeStart = NEVER; }
  startWriting(tm) { this.writeStart = tm; this.writeBuffer = []; }
  stopWriting(floppy, tm) { this.commit(floppy, tm); this.writeStart = NEVER; }
  commit(floppy, tm) {
    if (this.writeStart >= NEVER || tm === this.writeStart) return;
    if (floppy) floppy.writeFlux(this.writeStart, tm, this.writeBuffer);
    this.writeStart = tm;
    this.writeBuffer = [];
  }
  // returns [bit or -1, tm]
  getNextBit(ref, floppy, limit) {
    const edge = floppy ? floppy.getNextTransition(this.ctime) : NEVER;
    const next = this.ctime + this.period + this.phaseAdjust;
    if (next > limit) return -1;
    this.ctime = next;
    ref.tm = next;
    if (edge >= NEVER || edge > next) { this.phaseAdjust = 0n; return 0; }
    const delta = edge - (next - div(this.period, 2));
    if (delta < 0n) this.phaseAdjust = -div(mul(-delta, 65), 100);
    else this.phaseAdjust = div(mul(delta, 65), 100);
    if (delta < 0n) this.freqHist = this.freqHist < 0 ? this.freqHist - 1 : -1;
    else if (delta > 0n) this.freqHist = this.freqHist > 0 ? this.freqHist + 1 : 1;
    else this.freqHist = 0;
    if (this.freqHist) {
      const afh = this.freqHist < 0 ? -this.freqHist : this.freqHist;
      if (afh > 1) {
        const aper = fromDouble(asDouble(this.periodAdjustBase) * asDouble(delta) / asDouble(this.period));
        this.period += aper;
        if (this.period < this.minPeriod) this.period = this.minPeriod;
        else if (this.period > this.maxPeriod) this.period = this.maxPeriod;
      }
    }
    return 1;
  }
  writeNextBit(bit, ref, floppy, limit) {
    if (this.writeStart >= NEVER) { this.writeStart = this.ctime; this.writeBuffer = []; }
    const etime = this.ctime + this.period;
    if (etime > limit) return true;
    if (bit && this.writeBuffer.length < 32) this.writeBuffer.push(this.ctime + div(this.period, 2));
    ref.tm = etime;
    this.ctime = etime;
    return false;
  }
  save() { return { period: toText(this.period), pab: toText(this.periodAdjustBase), min: toText(this.minPeriod), max: toText(this.maxPeriod), ctime: toText(this.ctime), phase: toText(this.phaseAdjust), freqHist: this.freqHist, writeStart: toText(this.writeStart), writeBuffer: this.writeBuffer.map(toText) }; }
  load(s) { this.period = fromText(s.period); this.periodAdjustBase = fromText(s.pab); this.minPeriod = fromText(s.min); this.maxPeriod = fromText(s.max); this.ctime = fromText(s.ctime); this.phaseAdjust = fromText(s.phase); this.freqHist = s.freqHist; this.writeStart = fromText(s.writeStart); this.writeBuffer = s.writeBuffer.map(fromText); }
}

// digital_pll_t (wd_fdc.cpp): the WD1770 family's counter-based separator
const PHA = [0xf, 0x7, 0x3, 0x1, 0, 0, 0, 0], PHS = [0, 0, 0, 0, 0x1, 0x3, 0x7, 0xf];
const FREQA = [[0xf, 0x7, 0x3, 0x1, 0, 0, 0, 0], [0x7, 0x3, 0x1, 0, 0, 0, 0, 0], [0x7, 0x3, 0x1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
const FREQS = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0x1, 0x3, 0x7], [0, 0, 0, 0, 0, 0x1, 0x3, 0x7], [0, 0, 0, 0, 0x1, 0x3, 0x7, 0xf]];
const DPLL_STATE = ['counter', 'increment', 'transitionTime', 'history', 'slot', 'phaseAdd', 'phaseSub', 'freqAdd', 'freqSub'];
class DigitalPll {
  constructor() { this.delays = []; this.ctime = 0n; this.writeStart = NEVER; this.writeBuffer = []; this.reset(0n); }
  copy() { const c = new DigitalPll(); Object.assign(c, this); c.writeBuffer = this.writeBuffer.slice(); return c; }
  setClock(period) { this.delays = []; for (let i = 0; i < 42; i++) this.delays.push(mul(period, i + 1)); }
  reset(when) {
    this.counter = 0; this.increment = 128; this.transitionTime = 0xffff; this.history = 0x80; this.slot = 0; this.ctime = when;
    this.phaseAdd = 0; this.phaseSub = 0; this.freqAdd = 0; this.freqSub = 0; this.writeBuffer = []; this.writeStart = NEVER;
  }
  startWriting(tm) { this.writeStart = tm; this.writeBuffer = []; }
  stopWriting(floppy, tm) { this.commit(floppy, tm); this.writeStart = NEVER; }
  commit(floppy, tm) {
    if (this.writeStart >= NEVER || tm === this.writeStart) return;
    if (floppy) floppy.writeFlux(this.writeStart, tm, this.writeBuffer);
    this.writeStart = tm;
    this.writeBuffer = [];
  }
  getNextBit(ref, floppy, limit) {
    const when = floppy ? floppy.getNextTransition(this.ctime) : NEVER;
    for (;;) {
      const etime = this.ctime + this.delays[this.slot];
      if (etime > limit) return -1;
      if (this.transitionTime === 0xffff && when < NEVER && etime >= when) this.transitionTime = this.counter;
      if (this.slot < 8) {
        const mask = 1 << this.slot;
        if (this.phaseAdd & mask) this.counter = (this.counter + 226) & 0xffff;
        else if (this.phaseSub & mask) this.counter = (this.counter + 30) & 0xffff;
        else this.counter = (this.counter + this.increment) & 0xffff;
        if ((this.freqAdd & mask) && this.increment < 140) this.increment++;
        else if ((this.freqSub & mask) && this.increment > 117) this.increment--;
      } else this.counter = (this.counter + this.increment) & 0xffff;
      this.slot++;
      ref.tm = etime;
      if (this.counter & 0x800) break;
    }
    const bit = this.transitionTime !== 0xffff ? 1 : 0;
    if (bit) {
      const cslot = this.transitionTime >> 8;
      this.phaseAdd = PHA[cslot];
      this.phaseSub = PHS[cslot];
      const way = this.transitionTime & 0x400 ? 1 : 0;
      if (this.history & 0x80) this.history = way ? 0x80 : 0x83;
      else if (this.history & 0x40) this.history = way ? this.history & 2 : (this.history & 2) | 1;
      this.freqAdd = FREQA[this.history & 3][cslot];
      this.freqSub = FREQS[this.history & 3][cslot];
      this.history = way ? (this.history >> 1) | 2 : this.history >> 1;
    } else this.phaseAdd = this.phaseSub = this.freqAdd = this.freqSub = 0;
    this.counter &= 0x7ff;
    this.ctime = ref.tm;
    this.transitionTime = 0xffff;
    this.slot = 0;
    return bit;
  }
  writeNextBit(bit, ref, floppy, limit) {
    if (this.writeStart >= NEVER) { this.writeStart = this.ctime; this.writeBuffer = []; }
    for (;;) {
      const etime = this.ctime + this.delays[this.slot];
      if (etime > limit) return true;
      const pre = this.counter;
      this.counter = (this.counter + this.increment) & 0xffff;
      if (bit && !(pre & 0x400) && (this.counter & 0x400) && this.writeBuffer.length < 32) this.writeBuffer.push(etime);
      this.slot++;
      ref.tm = etime;
      if (this.counter & 0x800) break;
    }
    this.counter &= 0x7ff;
    this.ctime = ref.tm;
    this.slot = 0;
    return false;
  }
  save() { const o = {}; for (const k of DPLL_STATE) o[k] = this[k]; o.delays = this.delays.map(toText); o.ctime = toText(this.ctime); o.writeStart = toText(this.writeStart); o.writeBuffer = this.writeBuffer.map(toText); return o; }
  load(s) { for (const k of DPLL_STATE) this[k] = s[k]; this.delays = s.delays.map(fromText); this.ctime = fromText(s.ctime); this.writeStart = fromText(s.writeStart); this.writeBuffer = s.writeBuffer.map(fromText); }
}

// ---------------------------------------------------------------- the controller
const LIVE_KEYS = ['state', 'nextState', 'shiftReg', 'crc', 'bitCounter', 'byteCounter', 'previousType', 'dataSeparatorPhase', 'dataBitContext', 'dataReg'];
const newLive = () => ({ tm: NEVER, state: ST.IDLE, nextState: -1, shiftReg: 0, crc: 0, bitCounter: 0, byteCounter: 0, previousType: PT_NONE, dataSeparatorPhase: false, dataBitContext: false, dataReg: 0, idbuf: [0, 0, 0, 0, 0, 0] });
const copyLive = (l) => Object.assign({}, l, { idbuf: l.idbuf.slice() });
const shiftRegData = (sr) => {
  let v = 0;
  for (let i = 0; i < 8; i++) if (sr & (1 << (14 - 2 * i))) v |= 0x80 >> i;
  return v;
};
const crcBit = (crc, bit) => (((crc ^ (bit ? 0x8000 : 0)) & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)) & 0xffff;

const CHIP_STATE = ['dden', 'statusType1', 'intrq', 'drq', 'hld', 'hlt', 'mr', 'mainState', 'subState', 'command', 'track', 'sector', 'data', 'status',
  'intrqCond', 'lastDir', 'counter', 'motorTimeout', 'sectorSize', 'cmdBuffer', 'trackBuffer', 'sectorBuffer', 'delayInt', 'formatLastByte', 'formatLastByteCount'];

export class WD17xx {
  constructor(variant, clock, fdcClock, name = 'fdc', { forceReady = true } = {}) {
    const v = WD_VARIANTS[variant];
    if (!v) throw new Error(`unknown controller ${variant}`);
    this.variant = variant;
    this.v = v;
    this.clock = clock;
    this.fdcClock = fdcClock;
    this.clockRatio = v.analog ? 1 : 4;
    this.forceReady = forceReady;   // the cartridge boards tie READY (set_force_ready); the Dragon Alpha does not
    this.onIntrq = null;
    this.onDrq = null;
    this.tGen = clock.timer(`${name}.gen`, () => { this.liveSync(); this.doGeneric(); this.generalContinue(); });
    this.tCmd = clock.timer(`${name}.cmd`, () => { this.liveSync(); this.doCmdW(); this.generalContinue(); });
    this.tTrack = clock.timer(`${name}.track`, () => { this.liveSync(); this.doTrackW(); this.generalContinue(); });
    this.tSector = clock.timer(`${name}.sector`, () => { this.liveSync(); this.doSectorW(); this.generalContinue(); });
    this.floppy = null;
    this.pll = v.analog ? new AnalogPll() : new DigitalPll();
    this.checkpointPll = this.pll.copy();
    // device_start
    this.dden = false; this.status = 0; this.data = 0; this.track = 0; this.mr = true; this.delayInt = false;
    this.hlt = true; this.hld = false; this.intrq = false; this.drq = false;
    this.command = 0; this.sector = 0; this.mainState = ST.IDLE; this.subState = ST.IDLE; this.intrqCond = 0;
    this.statusType1 = true; this.lastDir = 1; this.counter = 0; this.motorTimeout = 0; this.sectorSize = 0;
    this.cmdBuffer = -1; this.trackBuffer = -1; this.sectorBuffer = -1;
    this.formatLastByte = 0; this.formatLastByteCount = 0;
    this.live = newLive();
    this.checkpointLive = copyLive(this.live);
  }
  setIntrq(v) { this.intrq = v; if (this.onIntrq) this.onIntrq(v); }
  setDrqLine(v) { this.drq = v; if (this.onDrq) this.onDrq(v); }
  delayCycles(tm, cycles) { tm.adjust(fromTicks(cycles * this.clockRatio, this.fdcClock)); }

  reset() { if (this.mr) { this.mrW(0); this.mrW(1); } }
  mrW(state) {
    if (this.mr && !state) {
      this.command = 0x03; this.mainState = ST.IDLE; this.subState = ST.IDLE; this.live.state = ST.IDLE;
      this.sector = 0x01; this.status = 0x00; this.cmdBuffer = this.trackBuffer = this.sectorBuffer = -1;
      this.counter = 0; this.statusType1 = true; this.lastDir = 1; this.mr = false;
      this.setIntrq(false);
      this.setDrqLine(false);
      if (this.v.headControl) this.hld = false;
      this.intrqCond = 0;
      this.liveAbort();
    } else if (state && !this.mr) {
      if (!this.v.motorControl) {
        this.status |= S_BUSY;
        this.subState = ST.INITIAL_RESTORE;
        this.tGen.adjust(ZERO);
      }
      this.mr = true;
    }
  }
  setFloppy(f) {
    if (this.floppy === f) return;
    const prevReady = this.floppy ? this.floppy.readyR() : 1;
    if (this.floppy) { this.floppy.indexCb = null; this.floppy.readyCb = null; }
    this.bind(f);
    const nextReady = f ? f.readyR() : 1;
    if (prevReady !== nextReady) this.readyCallback(f, nextReady);
  }
  // connect a drive's index and ready lines (set_floppy without its side effects, for snapshots)
  bind(f) {
    this.floppy = f;
    if (f) {
      f.indexCb = (st) => this.indexCallback(f, st);
      f.readyCb = (st) => this.readyCallback(f, st);
    }
  }
  ddenW(state) { this.dden = !!state; }

  commandEnd() {
    this.mainState = this.subState = ST.IDLE;
    this.motorTimeout = 0;
    if (this.status & S_BUSY) {
      if (!this.tCmd.enabled()) this.status &= ~S_BUSY;
      this.setIntrq(true);
    }
  }

  // ---------------- type I
  seekStart(state) {
    this.mainState = state;
    this.status &= ~(S_CRC | S_RNF | S_SPIN);
    this.subState = this.v.motorControl ? ST.SPINUP : ST.SPINUP_DONE;
    this.statusType1 = true;
    if (this.v.headControl) { if (this.command & 0x08) this.setHld(); else this.dropHld(); }
    this.seekContinue();
  }
  seekContinue() {
    const fl = this.floppy;
    for (;;) {
      switch (this.subState) {
        case ST.SPINUP:
          if (!(this.status & S_MON)) { this.spinup(); return; }
          if (!(this.command & 0x08)) this.status |= S_SPIN;
          this.subState = ST.SPINUP_DONE;
          break;
        case ST.SPINUP_WAIT: return;
        case ST.SPINUP_DONE:
          if (this.mainState === ST.RESTORE && fl && !fl.trk00R()) { this.subState = ST.SEEK_WAIT_STEP_TIME; this.delayCycles(this.tGen, this.v.stepTimes[this.command & 3]); }
          if (this.mainState === ST.SEEK && this.track === this.data) {
            if (this.command & 0x04) { this.setHld(); this.subState = ST.SEEK_WAIT_STABILIZATION_TIME; this.delayCycles(this.tGen, 30000); return; }
            this.subState = ST.SEEK_DONE;
          }
          if (this.subState === ST.SPINUP_DONE) { this.counter = 0; this.subState = ST.SEEK_MOVE; }
          break;
        case ST.SEEK_MOVE:
          if (fl) { fl.dirW(this.lastDir); fl.stpW(0); fl.stpW(1); }
          if (this.mainState === ST.STEP && (this.command & 0x10)) this.track = (this.track + (this.lastDir ? -1 : 1)) & 0xff;
          this.counter++;
          this.subState = ST.SEEK_WAIT_STEP_TIME;
          this.delayCycles(this.tGen, this.v.stepTimes[this.command & 3]);
          return;
        case ST.SEEK_WAIT_STEP_TIME: return;
        case ST.SEEK_WAIT_STEP_TIME_DONE: {
          let done = false;
          switch (this.mainState) {
            case ST.RESTORE: done = !!(fl && !fl.trk00R()); break;
            case ST.SEEK: this.track = (this.track + (this.lastDir ? -1 : 1)) & 0xff; done = this.track === this.data; break;
            case ST.STEP: done = true; break;
          }
          if (done || this.counter === 255) {
            if (this.mainState === ST.RESTORE) this.track = 0;
            if (this.command & 0x04) { this.setHld(); this.subState = ST.SEEK_WAIT_STABILIZATION_TIME; this.delayCycles(this.tGen, 30000); return; }
            this.subState = ST.SEEK_DONE;
          } else this.subState = ST.SEEK_MOVE;
          break;
        }
        case ST.SEEK_WAIT_STABILIZATION_TIME: return;
        case ST.SEEK_WAIT_STABILIZATION_TIME_DONE: this.subState = ST.SEEK_DONE; break;
        case ST.SEEK_DONE:
          if (this.command & 0x04) {
            if (!this.isReady()) { this.status |= S_RNF; this.commandEnd(); return; }
            this.subState = ST.SCAN_ID; this.counter = 0; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER);
            return;
          }
          this.commandEnd();
          return;
        case ST.SCAN_ID:
          if (this.live.idbuf[0] !== this.track) { this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          if (this.live.crc) { this.status |= S_CRC; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          this.commandEnd();
          return;
        case ST.SCAN_ID_FAILED: this.status |= S_RNF; this.commandEnd(); return;
        default: return;
      }
    }
  }
  sectorMatches() {
    const id = this.live.idbuf;
    if (id[0] !== this.track || id[2] !== this.sector) return false;
    if (!this.v.sideCompare || (this.command & 2) === 0) return true;
    if (this.command & 8) return !!(id[1] & 1);
    return !(id[1] & 1);
  }
  isReady() { return !this.v.readyHooked || this.forceReady || !!(this.floppy && !this.floppy.readyR()); }

  // spin-up and settle, common to type II and III (the per-command *_continue loops)
  typeIIPrologue() {
    switch (this.subState) {
      case ST.SPINUP:
        if (!(this.status & S_MON)) { this.spinup(); return 'return'; }
        this.subState = ST.SPINUP_DONE;
        return 'loop';
      case ST.SPINUP_WAIT: return 'return';
      case ST.SPINUP_DONE:
        if (this.command & 4) { this.subState = ST.SETTLE_WAIT; this.delayCycles(this.tGen, this.v.settleTime); return 'return'; }
        this.subState = ST.SETTLE_DONE;
        return 'loop';
      case ST.SETTLE_WAIT: return 'return';
      default: return null;
    }
  }
  typeIIStart(state, clear) {
    if (!this.isReady()) { this.commandEnd(); return false; }
    this.mainState = state;
    this.status &= ~clear;
    this.updateSso();
    this.setHld();
    this.subState = this.v.motorControl ? ST.SPINUP : ST.SPINUP_DONE;
    this.statusType1 = false;
    return true;
  }
  readSectorStart() { if (this.typeIIStart(ST.READ_SECTOR, S_CRC | S_LOST | S_RNF | S_WP | S_DDM)) this.readSectorContinue(); }
  readSectorContinue() {
    for (;;) {
      const p = this.typeIIPrologue();
      if (p === 'return') return;
      if (p === 'loop') continue;
      switch (this.subState) {
        case ST.SETTLE_DONE: this.subState = ST.SCAN_ID; this.counter = 0; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return;
        case ST.SCAN_ID:
          if (!this.sectorMatches()) { this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          if (this.live.crc) { this.status |= S_CRC; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          this.sectorSize = this.v.sectorSize(this.live.idbuf[3], this.command);
          this.subState = ST.SECTOR_READ;
          this.liveStart(ST.SEARCH_ADDRESS_MARK_DATA);
          return;
        case ST.SCAN_ID_FAILED: this.status |= S_RNF; this.commandEnd(); return;
        case ST.SECTOR_READ:
          if (this.live.crc) this.status |= S_CRC;
          if ((this.command & 0x10) && !(this.status & S_RNF)) { this.sector = (this.sector + 1) & 0xff; this.subState = ST.SETTLE_DONE; }
          else { this.commandEnd(); return; }
          break;
        default: return;
      }
    }
  }
  readTrackStart() { if (this.typeIIStart(ST.READ_TRACK, S_LOST | S_RNF)) this.readTrackContinue(); }
  readTrackContinue() {
    for (;;) {
      const p = this.typeIIPrologue();
      if (p === 'return') return;
      if (p === 'loop') continue;
      switch (this.subState) {
        case ST.SETTLE_DONE: this.subState = ST.WAIT_INDEX; return;
        case ST.WAIT_INDEX: return;
        case ST.WAIT_INDEX_DONE: this.subState = ST.TRACK_DONE; this.liveStart(ST.READ_TRACK_DATA); return;
        case ST.TRACK_DONE: this.commandEnd(); return;
        default: return;
      }
    }
  }
  readIdStart() { if (this.typeIIStart(ST.READ_ID, S_WP | S_DDM | S_LOST | S_RNF)) this.readIdContinue(); }
  readIdContinue() {
    for (;;) {
      const p = this.typeIIPrologue();
      if (p === 'return') return;
      if (p === 'loop') continue;
      switch (this.subState) {
        case ST.SETTLE_DONE: this.subState = ST.SCAN_ID; this.counter = 0; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return;
        case ST.SCAN_ID: this.commandEnd(); return;
        case ST.SCAN_ID_FAILED: this.status |= S_RNF; this.commandEnd(); return;
        default: return;
      }
    }
  }
  writeTrackStart() {
    if (!this.typeIIStart(ST.WRITE_TRACK, S_WP | S_DDM | S_LOST | S_RNF)) return;
    this.formatLastByte = 0; this.formatLastByteCount = 0;
    this.writeTrackContinue();
  }
  writeTrackContinue() {
    for (;;) {
      const p = this.typeIIPrologue();
      if (p === 'return') return;
      if (p === 'loop') continue;
      switch (this.subState) {
        case ST.SETTLE_DONE:
          if (this.floppy && this.floppy.wptR()) { this.subState = ST.WRITE_PROTECT_WAIT; this.delayCycles(this.tGen, 145); return; }
          this.setDrq();
          this.subState = ST.DATA_LOAD_WAIT;
          this.delayCycles(this.tGen, 192);
          return;
        case ST.WRITE_PROTECT_WAIT: return;
        case ST.WRITE_PROTECT_DONE: this.status |= S_WP; this.commandEnd(); return;
        case ST.DATA_LOAD_WAIT: return;
        case ST.DATA_LOAD_WAIT_DONE:
          if (this.drq) { this.status |= S_LOST; this.dropDrq(); this.commandEnd(); return; }
          this.subState = ST.WAIT_INDEX;
          break;
        case ST.WAIT_INDEX: return;
        case ST.WAIT_INDEX_DONE:
          this.subState = ST.TRACK_DONE;
          this.liveStart(ST.WRITE_TRACK_DATA);
          this.pll.startWriting(this.clock.now());
          return;
        case ST.TRACK_DONE: this.commandEnd(); return;
        default: return;
      }
    }
  }
  writeSectorStart() { if (this.typeIIStart(ST.WRITE_SECTOR, S_CRC | S_LOST | S_RNF | S_WP | S_DDM)) this.writeSectorContinue(); }
  writeSectorContinue() {
    for (;;) {
      const p = this.typeIIPrologue();
      if (p === 'return') return;
      if (p === 'loop') continue;
      switch (this.subState) {
        case ST.SETTLE_DONE:
          if (this.floppy && this.floppy.wptR()) { this.subState = ST.WRITE_PROTECT_WAIT; this.delayCycles(this.tGen, 145); return; }
          this.subState = ST.SCAN_ID; this.counter = 0; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER);
          return;
        case ST.WRITE_PROTECT_WAIT: return;
        case ST.WRITE_PROTECT_DONE: this.status |= S_WP; this.commandEnd(); return;
        case ST.SCAN_ID:
          if (!this.sectorMatches()) { this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          if (this.live.crc) { this.status |= S_CRC; this.liveStart(ST.SEARCH_ADDRESS_MARK_HEADER); return; }
          this.sectorSize = this.v.sectorSize(this.live.idbuf[3], this.command);
          this.subState = ST.SECTOR_WRITE;
          this.liveStart(ST.WRITE_SECTOR_PRE);
          return;
        case ST.SCAN_ID_FAILED: this.status |= S_RNF; this.commandEnd(); return;
        case ST.SECTOR_WRITE:
          if (this.command & 0x10) { this.sector = (this.sector + 1) & 0xff; this.subState = ST.SPINUP_DONE; }
          else { this.commandEnd(); return; }
          break;
        default: return;
      }
    }
  }
  // ---------------- type IV
  interruptStart() {
    if (this.mainState === ST.WRITE_SECTOR && this.live.state === ST.WRITE_BYTE) { this.delayInt = true; return; }
    this.delayInt = false;
    if (this.status & S_BUSY) {
      this.mainState = this.subState = this.live.state = ST.IDLE;
      this.live.tm = NEVER;
      this.status &= ~S_BUSY;
      this.motorTimeout = 0;
    } else {
      this.statusType1 = true;
      this.dropDrq();
    }
    this.intrqCond = this.command & 0x0f;
    if (!this.intrq && (this.command & I_IMM)) this.setIntrq(true);
  }
  generalContinue() {
    if (this.live.state !== ST.IDLE) {
      this.liveRun();
      if (this.live.state !== ST.IDLE) return;
    }
    switch (this.mainState) {
      case ST.RESTORE: case ST.SEEK: case ST.STEP: this.seekContinue(); break;
      case ST.READ_SECTOR: this.readSectorContinue(); break;
      case ST.READ_TRACK: this.readTrackContinue(); break;
      case ST.READ_ID: this.readIdContinue(); break;
      case ST.WRITE_TRACK: this.writeTrackContinue(); break;
      case ST.WRITE_SECTOR: this.writeSectorContinue(); break;
      default: break;
    }
  }
  doGeneric() {
    switch (this.subState) {
      case ST.SETTLE_WAIT: this.subState = ST.SETTLE_DONE; break;
      case ST.WRITE_PROTECT_WAIT: this.subState = ST.WRITE_PROTECT_DONE; break;
      case ST.SEEK_WAIT_STEP_TIME: this.subState = ST.SEEK_WAIT_STEP_TIME_DONE; break;
      case ST.SEEK_WAIT_STABILIZATION_TIME: this.subState = ST.SEEK_WAIT_STABILIZATION_TIME_DONE; break;
      case ST.DATA_LOAD_WAIT: this.subState = ST.DATA_LOAD_WAIT_DONE; break;
      case ST.INITIAL_RESTORE: this.lastDir = 1; this.seekStart(ST.RESTORE); break;
      default: break;
    }
  }
  doCmdW() {
    this.command = this.cmdBuffer;
    this.cmdBuffer = -1;
    switch (this.command & 0xf0) {
      case 0x00: this.lastDir = 1; this.seekStart(ST.RESTORE); break;
      case 0x10: this.lastDir = this.data > this.track ? 0 : 1; this.seekStart(ST.SEEK); break;
      case 0x20: case 0x30: this.seekStart(ST.STEP); break;
      case 0x40: case 0x50: this.lastDir = 0; this.seekStart(ST.STEP); break;
      case 0x60: case 0x70: this.lastDir = 1; this.seekStart(ST.STEP); break;
      case 0x80: case 0x90: this.readSectorStart(); break;
      case 0xa0: case 0xb0: this.writeSectorStart(); break;
      case 0xc0: this.readIdStart(); break;
      case 0xd0: this.interruptStart(); break;
      case 0xe0: this.readTrackStart(); break;
      case 0xf0: this.writeTrackStart(); break;
    }
  }
  // ---------------- CPU interface
  cmdW(val) {
    if (!this.mr) return;
    if (this.intrq) this.setIntrq(false);
    if (this.cmdBuffer !== -1 && (val & 0xf0) !== 0xd0) return;
    this.cmdBuffer = val;
    const rc = this.v.delayRegisterCommit, cc = this.v.delayCommandCommit;
    if ((val & 0xf0) === 0xd0) this.delayCycles(this.tCmd, this.dden ? rc * 2 : rc);
    else {
      this.intrqCond = 0;
      this.dropDrq();
      this.status |= S_BUSY;
      this.delayCycles(this.tCmd, this.dden ? cc * 2 : cc);
    }
  }
  statusR() {
    if (this.intrq && !(this.intrqCond & I_IMM)) this.setIntrq(false);
    const fl = this.floppy;
    if (this.statusType1) { if (fl && fl.idxR()) this.status |= S_IP; else this.status &= ~S_IP; }
    else if (this.drq) this.status |= S_DRQ; else this.status &= ~S_DRQ;
    if (this.statusType1 && this.v.headControl) { if (this.hld && this.hlt) this.status |= S_HLD; else this.status &= ~S_HLD; }
    if (this.statusType1) {
      this.status &= ~(S_TR00 | S_WP);
      if (fl) { if (fl.wptR()) this.status |= S_WP; if (!fl.trk00R()) this.status |= S_TR00; }
    }
    if (this.v.readyHooked) { if (!this.isReady()) this.status |= S_NRDY; else this.status &= ~S_NRDY; }
    return this.status;
  }
  doTrackW() { this.track = this.trackBuffer; this.trackBuffer = -1; }
  trackW(val) {
    if (this.trackBuffer !== -1 || !this.mr) return;
    this.trackBuffer = val;
    this.delayCycles(this.tTrack, this.dden ? this.v.delayRegisterCommit * 2 : this.v.delayRegisterCommit);
  }
  doSectorW() { this.sector = this.sectorBuffer; this.sectorBuffer = -1; }
  sectorW(val) {
    if (!this.mr) return;
    this.sectorBuffer = val;
    if (!this.tSector.enabled()) this.delayCycles(this.tSector, this.dden ? this.v.delayRegisterCommit * 2 : this.v.delayRegisterCommit);
  }
  dataW(val) { if (!this.mr) return; this.data = val; this.dropDrq(); }
  dataR() { this.dropDrq(); return this.data; }
  write(reg, val) {
    val ^= this.v.busInvert;
    switch (reg) { case 0: this.cmdW(val); break; case 1: this.trackW(val); break; case 2: this.sectorW(val); break; case 3: this.dataW(val); break; }
  }
  read(reg) {
    const inv = this.v.busInvert;
    switch (reg) { case 0: return this.statusR() ^ inv; case 1: return this.track ^ inv; case 2: return this.sector ^ inv; case 3: return this.dataR() ^ inv; }
    return 0xff;
  }
  // peek for debuggers: no side effects; the values as the CPU reads them
  peek(reg) { return [this.status, this.track, this.sector, this.data][reg & 3] ^ this.v.busInvert; }

  spinup() {
    if (this.command & 0x08) this.subState = ST.SPINUP_DONE;
    else { this.subState = ST.SPINUP_WAIT; this.counter = 0; }
    this.status |= S_MON | S_SPIN;
  }
  readyCallback(floppy, state) {
    if (!floppy) return;
    this.liveSync();
    if (!this.v.readyHooked) return;
    if (!this.intrq && (((this.intrqCond & I_RDY) && !state) || ((this.intrqCond & I_NRDY) && state))) this.setIntrq(true);
  }
  indexCallback(floppy, state) {
    this.liveSync();
    if (!state) return;
    switch (this.subState) {
      case ST.IDLE:
        if (this.v.motorControl || this.v.headControl) {
          this.motorTimeout++;
          if (this.v.headControl && this.motorTimeout >= this.v.hldTimeout) this.dropHld();
        }
        if (!this.intrq && (this.intrqCond & I_IDX)) this.setIntrq(true);
        break;
      case ST.SPINUP_WAIT:
        this.counter++;
        if (this.counter === 6) { this.subState = ST.SPINUP_DONE; if (this.statusType1) this.status |= S_SPIN; }
        break;
      case ST.SCAN_ID:
        this.counter++;
        if (this.counter === 5) { this.subState = ST.SCAN_ID_FAILED; this.liveAbort(); }
        break;
      case ST.WAIT_INDEX: this.subState = ST.WAIT_INDEX_DONE; break;
      case ST.TRACK_DONE: this.liveAbort(); break;
      case ST.DUMMY: return;
      default: break;
    }
    this.generalContinue();
  }

  // ---------------- live (bit level)
  pllReset(fm, when) {
    const clocks = (this.v.analog ? 2 : 1) * (fm ? 2 : 1);
    this.pll.reset(when);
    this.pll.setClock(fromTicks(clocks, this.fdcClock));
  }
  liveStart(state) {
    const l = this.live;
    l.tm = this.clock.now();
    l.state = state; l.nextState = -1; l.shiftReg = 0; l.crc = 0xffff; l.bitCounter = 0; l.dataSeparatorPhase = false;
    l.dataReg = 0; l.previousType = PT_NONE; l.dataBitContext = false; l.byteCounter = 0;
    this.pllReset(this.dden, l.tm);
    this.checkpointLive = copyLive(l);
    this.checkpointPll = this.pll.copy();
    this.liveRun();
  }
  checkpoint() {
    this.pll.commit(this.floppy, this.live.tm);
    this.checkpointLive = copyLive(this.live);
    this.checkpointPll = this.pll.copy();
  }
  rollback() {
    this.live = copyLive(this.checkpointLive);
    this.pll = this.checkpointPll.copy();
  }
  liveDelay(state) {
    this.live.nextState = state;
    this.tGen.adjust(this.live.tm - this.clock.now());
  }
  liveSync() {
    if (this.live.tm < NEVER) {
      const now = this.clock.now();
      if (this.live.tm > now) {
        this.rollback();
        this.liveRun(now);
        this.pll.commit(this.floppy, this.live.tm);
      } else {
        this.pll.commit(this.floppy, this.live.tm);
        if (this.live.nextState !== -1) { this.live.state = this.live.nextState; this.live.nextState = -1; }
        if (this.live.state === ST.IDLE) { this.pll.stopWriting(this.floppy, this.live.tm); this.live.tm = NEVER; }
      }
      this.live.nextState = -1;
      this.checkpoint();
    }
  }
  liveAbort() {
    if (this.live.tm < NEVER && this.live.tm > this.clock.now()) { this.rollback(); this.liveRun(this.clock.now()); }
    this.pll.stopWriting(this.floppy, this.live.tm);
    this.live.tm = NEVER; this.live.state = ST.IDLE; this.live.nextState = -1;
  }
  readOneBit(limit) {
    const l = this.live;
    const bit = this.pll.getNextBit(l, this.floppy, limit);
    if (bit < 0) return true;
    l.shiftReg = ((l.shiftReg << 1) | bit) >>> 0;
    l.bitCounter++;
    if (l.dataSeparatorPhase) {
      l.dataReg = ((l.dataReg << 1) | bit) & 0xff;
      l.crc = crcBit(l.crc, bit);
    }
    l.dataSeparatorPhase = !l.dataSeparatorPhase;
    return false;
  }
  resetDataSync() { const l = this.live; l.dataSeparatorPhase = false; l.bitCounter = 0; l.dataReg = shiftRegData(l.shiftReg); }
  writeOneBit(limit) {
    const l = this.live;
    const bit = (l.shiftReg & 0x8000) !== 0;
    if (this.pll.writeNextBit(bit, l, this.floppy, limit)) return true;
    if (l.bitCounter & 1) l.crc = crcBit(l.crc, bit);
    l.shiftReg = (l.shiftReg << 1) >>> 0;
    l.bitCounter--;
    return false;
  }
  liveWriteRaw(raw) { this.live.shiftReg = raw; this.live.dataBitContext = !!(raw & 1); }
  liveWriteMfm(mfm) {
    let context = this.live.dataBitContext, raw = 0;
    for (let i = 0; i < 8; i++) {
      const bit = !!(mfm & (0x80 >> i));
      if (!(bit || context)) raw |= 0x8000 >> (2 * i);
      if (bit) raw |= 0x4000 >> (2 * i);
      context = bit;
    }
    this.live.shiftReg = raw;
    this.live.dataBitContext = context;
  }
  liveWriteFm(fm) {
    let raw = 0xaaaa;
    for (let i = 0; i < 8; i++) if (fm & (0x80 >> i)) raw |= 0x4000 >> (2 * i);
    this.live.dataReg = fm;
    this.live.shiftReg = raw;
    this.live.dataBitContext = !!(fm & 1);
  }
  liveRun(limit = NEVER) {
    const l0 = this.live;
    if (l0.state === ST.IDLE || l0.nextState !== -1) return;
    if (limit >= NEVER) {
      if (this.floppy) limit = this.floppy.timeNextIndex();
      if (limit >= NEVER) {
        limit = this.clock.now() + fromMsec(1);
        this.tGen.adjust(fromMsec(1));
      }
    }
    for (;;) {
      const l = this.live;
      switch (l.state) {
        case ST.SEARCH_ADDRESS_MARK_HEADER:
          if (this.readOneBit(limit)) return;
          if (!this.dden && (l.shiftReg & 0xffff) === 0x4489) { l.crc = 0x443b; this.resetDataSync(); l.state = ST.READ_HEADER_BLOCK_HEADER; }
          if (this.dden && (l.shiftReg & 0x7fffff) === 0x2af57e) {
            l.crc = 0xef21; this.resetDataSync();
            l.state = this.mainState === ST.READ_ID ? ST.READ_ID_BLOCK_TO_DMA : ST.READ_ID_BLOCK_TO_LOCAL;
          }
          break;
        case ST.READ_HEADER_BLOCK_HEADER: {
          if (this.readOneBit(limit)) return;
          if (l.bitCounter & 15) break;
          const slot = l.bitCounter >> 4;
          if (slot < 3) { if ((l.shiftReg & 0xffff) !== 0x4489) l.state = ST.SEARCH_ADDRESS_MARK_HEADER; break; }
          if (l.dataReg !== 0xfe && l.dataReg !== 0xff) { l.state = ST.SEARCH_ADDRESS_MARK_HEADER; break; }
          l.bitCounter = 0;
          l.state = this.mainState === ST.READ_ID ? ST.READ_ID_BLOCK_TO_DMA : ST.READ_ID_BLOCK_TO_LOCAL;
          break;
        }
        case ST.READ_ID_BLOCK_TO_LOCAL: {
          if (this.readOneBit(limit)) return;
          if (l.bitCounter & 15) break;
          const slot = (l.bitCounter >> 4) - 1;
          l.idbuf[slot] = l.dataReg;
          if (slot === 5) { this.liveDelay(ST.IDLE); return; }
          break;
        }
        case ST.READ_ID_BLOCK_TO_DMA:
          if (this.readOneBit(limit)) return;
          if (l.bitCounter & 15) break;
          this.liveDelay(ST.READ_ID_BLOCK_TO_DMA_BYTE);
          return;
        case ST.READ_ID_BLOCK_TO_DMA_BYTE:
          this.data = l.dataReg;
          if (l.bitCounter === 16) this.sector = this.data;
          this.setDrq();
          if (l.bitCounter === 16 * 6) {
            if (l.crc) this.status |= S_CRC;
            l.state = ST.IDLE;
            return;
          }
          l.state = ST.READ_ID_BLOCK_TO_DMA;
          this.checkpoint();
          break;
        case ST.SEARCH_ADDRESS_MARK_DATA:
          if (this.readOneBit(limit)) return;
          if (!this.dden) {
            if (l.bitCounter > 43 * 16) { this.liveDelay(ST.SEARCH_ADDRESS_MARK_DATA_FAILED); return; }
            if (l.bitCounter >= 28 * 16 && (l.shiftReg & 0xffff) === 0x4489) { l.crc = 0x443b; this.resetDataSync(); l.state = ST.READ_DATA_BLOCK_HEADER; }
          } else {
            if (l.bitCounter > 23 * 16) { this.liveDelay(ST.SEARCH_ADDRESS_MARK_DATA_FAILED); return; }
            const low = l.shiftReg & 0xffff;
            if (l.bitCounter >= 11 * 16 && (low === 0xf56a || low === 0xf56b || low === 0xf56e || low === 0xf56f)) {
              l.crc = low === 0xf56a ? 0x8fe7 : low === 0xf56b ? 0x9fc6 : low === 0xf56e ? 0xafa5 : 0xbf84;
              this.resetDataSync();
              if ((l.dataReg & 0xfe) === 0xf8) this.status |= S_DDM;
              l.state = ST.READ_SECTOR_DATA;
            }
          }
          break;
        case ST.READ_DATA_BLOCK_HEADER: {
          if (this.readOneBit(limit)) return;
          if (l.bitCounter & 15) break;
          const slot = l.bitCounter >> 4;
          if (slot < 3) {
            if ((l.shiftReg & 0xffff) !== 0x4489) { this.liveDelay(ST.SEARCH_ADDRESS_MARK_DATA_FAILED); return; }
            break;
          }
          if ((l.dataReg & 0xfe) !== 0xfa && (l.dataReg & 0xfe) !== 0xf8) { this.liveDelay(ST.SEARCH_ADDRESS_MARK_DATA_FAILED); return; }
          l.bitCounter = 0;
          if ((l.dataReg & 0xfe) === 0xf8) this.status |= S_DDM;
          this.liveDelay(ST.READ_SECTOR_DATA);
          return;
        }
        case ST.SEARCH_ADDRESS_MARK_DATA_FAILED:
          this.status |= S_RNF;
          l.state = ST.IDLE;
          return;
        case ST.READ_SECTOR_DATA: {
          if (this.readOneBit(limit)) return;
          if (l.bitCounter & 15) break;
          const slot = (l.bitCounter >> 4) - 1;
          if (slot < this.sectorSize) { this.liveDelay(ST.READ_SECTOR_DATA_BYTE); return; }
          if (slot < this.sectorSize + 2 && slot === this.sectorSize + 1) { this.liveDelay(ST.IDLE); return; }
          break;
        }
        case ST.READ_SECTOR_DATA_BYTE:
          this.data = l.dataReg;
          this.setDrq();
          l.state = ST.READ_SECTOR_DATA;
          this.checkpoint();
          break;
        case ST.READ_TRACK_DATA: {
          if (this.readOneBit(limit)) return;
          if (this.dden) {
            if ((l.shiftReg & 0x1ffff) === 0xabd5) { l.dataSeparatorPhase = false; l.bitCounter = 5 * 2; l.dataReg = 0xff; break; }
            else if (l.bitCounter === 16) { l.dataSeparatorPhase = false; l.bitCounter = 0; this.liveDelay(ST.READ_TRACK_DATA_BYTE); return; }
            break;
          }
          const low = l.shiftReg & 0xffff;
          if (l.bitCounter !== 16 && !(low === 0x4489 || low === 0x5224)) break;
          const output = l.bitCounter > 8;
          this.resetDataSync();
          if (output) { this.liveDelay(ST.READ_TRACK_DATA_BYTE); return; }
          break;
        }
        case ST.READ_TRACK_DATA_BYTE:
          this.data = l.dataReg;
          this.setDrq();
          l.state = ST.READ_TRACK_DATA;
          this.checkpoint();
          break;
        case ST.WRITE_TRACK_DATA:
          if (this.drq) { this.status |= S_LOST; this.data = 0; }
          if (this.data !== this.formatLastByte) { this.formatLastByte = this.data; this.formatLastByteCount = 1; }
          else this.formatLastByteCount++;
          if (this.dden) {
            switch (this.data) {
              case 0xf7:
                if (l.previousType === PT_CRC_2) { l.previousType = PT_NONE; this.liveWriteFm(0xf7); }
                else { l.previousType = PT_CRC_1; this.liveWriteFm(l.crc >> 8); }
                break;
              case 0xf8: this.liveWriteRaw(0xf56a); l.crc = 0xffff; l.previousType = PT_NONE; break;
              case 0xf9: this.liveWriteRaw(0xf56b); l.crc = 0xffff; l.previousType = PT_NONE; break;
              case 0xfa: this.liveWriteRaw(0xf56e); l.crc = 0xffff; l.previousType = PT_NONE; break;
              case 0xfb: this.liveWriteRaw(0xf56f); l.crc = 0xffff; l.previousType = PT_NONE; break;
              case 0xfc: this.liveWriteRaw(0xf77a); l.previousType = PT_NONE; break;
              case 0xfe: this.liveWriteRaw(0xf57e); l.crc = 0xffff; l.previousType = PT_NONE; break;
              default: l.previousType = PT_NONE; this.liveWriteFm(this.data); break;
            }
          } else {
            switch (this.data) {
              case 0xf5: this.liveWriteRaw(0x4489); l.crc = 0x968b; l.previousType = PT_NONE; break;
              case 0xf6: l.previousType = PT_NONE; this.liveWriteRaw(0x5224); break;
              case 0xf7:
                if (l.previousType === PT_CRC_2) { l.previousType = PT_NONE; this.liveWriteMfm(0xf7); }
                else { l.previousType = PT_CRC_1; this.liveWriteMfm(l.crc >> 8); }
                break;
              default: l.previousType = PT_NONE; this.liveWriteMfm(this.data); break;
            }
          }
          this.setDrq();
          l.state = ST.WRITE_BYTE;
          l.bitCounter = 16;
          this.checkpoint();
          break;
        case ST.WRITE_BYTE:
          if (this.writeOneBit(limit)) return;
          if (l.bitCounter === 0) { this.liveDelay(ST.WRITE_BYTE_DONE); return; }
          break;
        case ST.WRITE_BYTE_DONE:
          switch (this.subState) {
            case ST.TRACK_DONE:
              if (l.previousType === PT_CRC_1) {
                l.previousType = PT_CRC_2;
                if (this.dden) this.liveWriteFm(l.crc >> 8); else this.liveWriteMfm(l.crc >> 8);
                l.state = ST.WRITE_BYTE; l.bitCounter = 16;
                this.checkpoint();
              } else l.state = ST.WRITE_TRACK_DATA;
              break;
            case ST.SECTOR_WRITE: {
              l.state = ST.WRITE_BYTE; l.bitCounter = 16; l.byteCounter++;
              const n = l.byteCounter, ss = this.sectorSize;
              if (this.dden) {
                if (n < 6) this.liveWriteFm(0x00);
                else if (n < 7) { l.crc = 0xffff; this.liveWriteRaw(this.command & 1 ? 0xf56a : 0xf56f); }
                else if (n < ss + 7 - 1) { if (this.drq) { this.status |= S_LOST; this.data = 0; } this.liveWriteFm(this.data); this.setDrq(); }
                else if (n < ss + 7) { if (this.drq) { this.status |= S_LOST; this.data = 0; } this.liveWriteFm(this.data); }
                else if (n < ss + 7 + 2) this.liveWriteFm(l.crc >> 8);
                else if (n < ss + 7 + 3) this.liveWriteFm(0xff);
                else { this.pll.stopWriting(this.floppy, l.tm); l.state = ST.IDLE; if (this.delayInt) this.interruptStart(); return; }
              } else {
                if (n < 12) this.liveWriteMfm(0x00);
                else if (n < 15) this.liveWriteRaw(0x4489);
                else if (n < 16) { l.crc = 0xcdb4; this.liveWriteMfm(this.command & 1 ? 0xf8 : 0xfb); }
                else if (n < ss + 16 - 1) { if (this.drq) { this.status |= S_LOST; this.data = 0; } this.liveWriteMfm(this.data); this.setDrq(); }
                else if (n < ss + 16) { if (this.drq) { this.status |= S_LOST; this.data = 0; } this.liveWriteMfm(this.data); }
                else if (n < ss + 16 + 2) this.liveWriteMfm(l.crc >> 8);
                else if (n < ss + 16 + 3) this.liveWriteMfm(0xff);
                else { this.pll.stopWriting(this.floppy, l.tm); l.state = ST.IDLE; if (this.delayInt) this.interruptStart(); return; }
              }
              this.checkpoint();
              break;
            }
            default:
              this.liveAbort();
              return;
          }
          break;
        case ST.WRITE_SECTOR_PRE:
          if (this.readOneBit(limit)) return;
          if (l.bitCounter !== 16) break;
          this.liveDelay(ST.WRITE_SECTOR_PRE_BYTE);
          return;
        case ST.WRITE_SECTOR_PRE_BYTE:
          l.state = ST.WRITE_SECTOR_PRE;
          l.byteCounter++;
          l.bitCounter = 0;
          switch (l.byteCounter) {
            case 2: this.setDrq(); this.checkpoint(); break;
            case 10: if (this.drq) { this.status |= S_LOST; l.state = ST.IDLE; return; } break;
            case 11:
              if (this.dden) {
                l.state = ST.WRITE_BYTE; l.bitCounter = 16; l.byteCounter = 0; l.dataBitContext = !!(l.dataReg & 1);
                this.pll.startWriting(l.tm);
                this.liveWriteFm(0x00);
              }
              break;
            case 22:
              l.state = ST.WRITE_BYTE; l.bitCounter = 16; l.byteCounter = 0; l.dataBitContext = !!(l.dataReg & 1);
              this.pll.startWriting(l.tm);
              this.liveWriteMfm(0x00);
              break;
          }
          break;
        default:
          return;
      }
    }
  }
  setDrq() {
    if (this.drq) this.status |= S_LOST;
    else if (!(this.status & S_LOST)) this.setDrqLine(true);
  }
  dropDrq() { if (this.drq) this.setDrqLine(false); }
  setHld() {
    if (this.v.headControl && !this.hld) { this.hld = true; }
  }
  dropHld() {
    if (this.v.headControl && this.hld) { this.hld = false; }
  }
  updateSso() {
    if (!this.v.sideControl) return;
    if (this.floppy) this.floppy.ssW(this.command & 0x02 ? 1 : 0);
  }

  // ---------------- snapshots
  saveState() {
    const s = {};
    for (const k of CHIP_STATE) s[k] = this[k];
    const saveLive = (l) => { const o = {}; for (const k of LIVE_KEYS) o[k] = l[k]; o.tm = toText(l.tm); o.idbuf = l.idbuf.slice(); return o; };
    s.live = saveLive(this.live);
    s.checkpointLive = saveLive(this.checkpointLive);
    s.pll = this.pll.save();
    s.checkpointPll = this.checkpointPll.save();
    return s;
  }
  loadState(s) {
    for (const k of CHIP_STATE) { if (!(k in s)) throw new Error(`snapshot: controller is missing "${k}"`); this[k] = s[k]; }
    const loadLive = (o) => { const l = newLive(); for (const k of LIVE_KEYS) l[k] = o[k]; l.tm = fromText(o.tm); l.idbuf = o.idbuf.slice(); return l; };
    this.live = loadLive(s.live);
    this.checkpointLive = loadLive(s.checkpointLive);
    this.pll.load(s.pll);
    this.checkpointPll = this.pll.copy();
    this.checkpointPll.load(s.checkpointPll);
  }
}
