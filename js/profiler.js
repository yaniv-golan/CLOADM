/*
 * Profiler: where a running program spends its CPU time, by address, and whether that time is spent waiting.
 *
 *   const p = new Profiler(hooks, { mode, every, symbols, buckets })   (session.profile(opts) makes one)
 *   p.report({ top })   -> { mode, every, total, halted, unattributed, rows, note }
 *   p.stop()            -> the final report; the probe and taps come off
 *   p.clear()           starts it empty again (an opened snapshot)
 *
 * mode 'cycles' (default) is exact: one probe (Machine.addProbe, through the Session's HostHooks so it follows the
 * machine in use) reads cpu.totalCycles before each step and charges what the counter moved since the last probe to
 * the address of the instruction that ran in between. cpu.totalCycles counts CPU cycles on every family (the CoCo 3's
 * too, whatever the GIME's clock did), so the totals equal its delta. No scheduler event is used: an event would show
 * up in snapshots and split the CoCo 3's MAME-compatible slices. 'samples' takes one PC every `every` CPU cycles from
 * the same probe (the instruction under way when the sample time passed), and counts samples instead of cycles.
 *
 * Cycles in which the CPU is held by HALT (a disk controller's transfer) run no instruction: the CPU marks those
 * steps (cpu.stepHalted), and the CoCo 3 passes the rest of a long halted wait in one go before the next probe (its
 * stepN is the cycles of the last step proper, the rest is the wait): both go to `halted`, not to an address. The
 * cycles of an interrupt's entry (stacking the registers) are charged to the instruction it interrupted.
 *
 * Storage is bounded: two 64K-entry Uint32Arrays (all cycles, spin cycles) keyed by CPU address, a 64K stamp table
 * for the spin test, and at most POLL_PCS addresses with their polled bytes. A report folds them into symbol ranges:
 * a symbol covers its address up to the next symbol's, at most SPAN bytes; addresses no symbol covers fold into
 * 256-byte pages (`unattributed` is their total). At most `buckets` ranges are kept, the largest; the others are
 * summed in one '(other)' row. Banked or MMU-mapped code that runs at one CPU address is counted together (`note`).
 *
 * Spin or compute: the instructions are taken in windows of WINDOW. A window is spin when it ran at most SPIN_PCS
 * distinct instruction addresses, wrote no RAM (any address outside the I/O space) and either read I/O or read one
 * RAM byte more than once (the bytes of the instruction being run do not count: those are its fetches). A row's
 * spin share is the part of its count made in spin windows, and `polls` the addresses those windows read. The read
 * and write taps behind this exist only while a profile runs; with none, the machine has no probe and no tap.
 */

export const WINDOW = 32;           // instructions in one spin-or-compute window
export const SPIN_PCS = 4;          // at most this many distinct instruction addresses in a spin window
export const SPAN = 0x1000;         // the most bytes one symbol covers
const POLLS_PER_PC = 8;             // polled addresses kept per instruction address
const POLL_PCS = 4096;              // instruction addresses that keep polled addresses
const WRAP = 0x100000000;

const hex = (a, n = 4) => `$${a.toString(16).toUpperCase().padStart(n, '0')}`;

// the address space the spin test counts as I/O: the 6809 machines' $FF00-$FFFF; the MC-10's $BF00-$BFFF page
// (keyboard read, VDG latch write). The 6803's on-chip registers ($0000-$001F: its ports, timer, serial) and on-chip
// RAM ($0080-$00FF) never reach the machine's bus (cpu6803.js read8/write8), so the taps see none of their accesses:
// a wait that polls only a 6803 port reads no I/O here, and is counted as compute.
function ioTest(m) {
  if (m && m.config && m.config.cpu === '6803') return (a) => a >= 0xBF00 && a <= 0xBFFF;
  return (a) => a >= 0xFF00;
}

function symbolList(symbols) {
  if (typeof symbols === 'function') symbols = symbols();
  if (!symbols) return [];
  const entries = symbols instanceof Map ? [...symbols] : Object.entries(symbols);
  const byAddr = new Map();
  for (const [name, a] of entries) {
    if (!Number.isInteger(a) || a < 0 || a > 0xFFFF) continue;
    const had = byAddr.get(a);
    if (had === undefined || name < had) byAddr.set(a, name);   // one name per address: the alphabetically first
  }
  return [...byAddr].sort((x, y) => x[0] - y[0]);
}

export class Profiler {
  constructor(hooks, { mode = 'cycles', every = 1000, symbols = null, buckets = 4096 } = {}) {
    if (mode !== 'cycles' && mode !== 'samples') throw new RangeError(`profile: mode is 'cycles' or 'samples', not ${JSON.stringify(mode)}`);
    if (!Number.isInteger(every) || every < 1) throw new RangeError(`profile: every is a whole number of cycles from 1, not ${JSON.stringify(every)}`);
    if (!Number.isInteger(buckets) || buckets < 1 || buckets > 0x10000) throw new RangeError(`profile: buckets is a whole number from 1 to 65536, not ${JSON.stringify(buckets)}`);
    this.hooks = hooks;
    this.mode = mode;
    this.every = every;
    this.symbols = symbols;
    this.buckets = buckets;
    this.hist = new Uint32Array(0x10000);
    this.spinHist = new Uint32Array(0x10000);
    this.over = new Map();          // address -> 2^32 multiples a counter wrapped (a long run on one address)
    this.stamp = new Uint32Array(0x10000);
    this.wPc = new Uint16Array(WINDOW);
    this.wN = new Uint32Array(WINDOW);
    this.polls = new Map();         // instruction address -> Set of addresses its spin windows polled
    this.clear();
    this.running = true;
    this.removers = [];
    try {
      this.removers.push(hooks.addProbe((pc) => this.probe(pc)));
      this.removers.push(hooks.addReadTap({ start: 0, end: 0xFFFF }, (a) => this.read(a)));
      this.removers.push(hooks.addWriteTap({ start: 0, end: 0xFFFF }, (a) => this.write(a)));
    } catch (e) {
      for (const remove of this.removers) remove();
      throw e;
    }
  }

  // empty again; the next probe starts the count from where the machine is then
  clear() {
    this.hist.fill(0); this.spinHist.fill(0); this.over.clear(); this.polls.clear();
    this.halted = 0; this.total = 0; this.acc = 0;
    this.m = null;                  // the machine the counter base belongs to
    this.last = 0; this.lastPc = -1; this.curPc = -1;
    this.wid = 1; this.stamp.fill(0);
    this.openWindow();
  }
  openWindow() {
    this.wCount = 0; this.wPcs = []; this.wWrite = false; this.wPolls = [];
    if (++this.wid >= WRAP) { this.wid = 1; this.stamp.fill(0); }
  }

  probe(pc) {
    const m = this.hooks.machine;
    if (m !== this.m) {             // the first probe, or another machine (a switch, a snapshot): a fresh base
      this.m = m; this.io = ioTest(m);
      this.last = m.cpu.totalCycles; this.lastPc = -1; this.openWindow();
    } else this.settle();
    this.lastPc = pc;
    this.curPc = pc;
  }
  // charge what the cycle counter moved since the last probe
  settle() {
    const m = this.m;
    if (!m) return;
    const cpu = m.cpu, tc = cpu.totalCycles, d = tc - this.last;
    this.last = tc;
    if (d <= 0 || this.lastPc < 0) return;           // nothing ran (or the counter was set back: a new base)
    if (cpu.stepHalted) { this.charge(-1, d); return; }
    const sn = m.stepN;
    const n = typeof sn === 'number' && sn >= 0 && sn < d ? sn : d;
    const k = this.charge(this.lastPc, n);
    if (n < d) this.charge(-1, d - n);
    this.instruction(this.lastPc, k);
  }
  // add `cycles` to an address (or to halted: -1) -> the count added (cycles, or samples)
  charge(pc, cycles) {
    let k = cycles;
    if (this.mode === 'samples') {
      this.acc += cycles;
      if (this.acc < this.every) return 0;
      k = Math.floor(this.acc / this.every);
      this.acc -= k * this.every;
    }
    this.total += k;
    if (pc < 0) this.halted += k;
    else {
      const v = this.hist[pc] + k;
      if (v >= WRAP) { this.over.set(pc, (this.over.get(pc) || 0) + 1); this.hist[pc] = v - WRAP; } else this.hist[pc] = v;
    }
    return k;
  }
  // an instruction that ran: into the window, which closes after WINDOW of them
  instruction(pc, k) {
    const i = this.wCount;
    this.wPc[i] = pc; this.wN[i] = k;
    const pcs = this.wPcs;
    if (pcs.length <= SPIN_PCS && !pcs.includes(pc)) pcs.push(pc);
    if (++this.wCount < WINDOW) return;
    if (!this.wWrite && pcs.length <= SPIN_PCS && this.wPolls.length) {
      for (let j = 0; j < WINDOW; j++) this.spinHist[this.wPc[j]] += this.wN[j];
      for (const p of pcs) {
        let set = this.polls.get(p);
        if (!set) { if (this.polls.size >= POLL_PCS) continue; set = new Set(); this.polls.set(p, set); }
        for (const a of this.wPolls) if (set.size < POLLS_PER_PC) set.add(a);
      }
    }
    this.openWindow();
  }
  read(a) {
    if (this.m === null) return;
    if (this.io(a)) this.poll(a);
    else if (((a - this.curPc) & 0xFFFF) >= 5) {    // not the running instruction's own bytes (its fetches)
      if (this.stamp[a] === this.wid) this.poll(a);
      else this.stamp[a] = this.wid;
    }
  }
  poll(a) { if (this.wPolls.length < POLLS_PER_PC && !this.wPolls.includes(a)) this.wPolls.push(a); }
  write(a) { if (this.m !== null && !this.io(a)) this.wWrite = true; }

  stop() {
    if (this.running) {
      this.settle();
      this.running = false;
      for (const remove of this.removers) remove();
      this.removers = [];
    }
    return this.report();
  }

  report({ top = 30 } = {}) {
    if (!Number.isInteger(top) || top < 1) throw new RangeError(`profile report: top is a whole number from 1, not ${JSON.stringify(top)}`);
    if (this.running) this.settle();          // (the next probe finds nothing more to charge for it)
    const count = (a) => this.hist[a] + (this.over.get(a) || 0) * WRAP;
    // the ranges: each symbol to the next (at most SPAN bytes); the rest in 256-byte pages
    const syms = symbolList(this.symbols);
    const owner = new Int32Array(0x10000).fill(-1);
    syms.forEach(([a], i) => {
      const end = Math.min(i + 1 < syms.length ? syms[i + 1][0] : 0x10000, a + SPAN);
      owner.fill(i, a, end);
    });
    const ranges = new Map();       // key -> { symbol, start, end, count, spin, polls }
    let unattributed = 0;
    for (let a = 0; a < 0x10000; a++) {
      const c = count(a);
      if (!c) continue;
      const i = owner[a];
      const key = i >= 0 ? `s${i}` : `p${a >> 8}`;
      let r = ranges.get(key);
      if (!r) {
        r = i >= 0
          ? { symbol: syms[i][1], start: syms[i][0], end: Math.min(i + 1 < syms.length ? syms[i + 1][0] : 0x10000, syms[i][0] + SPAN) - 1, count: 0, spin: 0, polls: new Set() }
          : { symbol: null, start: a & 0xFF00, end: a | 0xFF, count: 0, spin: 0, polls: new Set() };
        ranges.set(key, r);
      }
      r.count += c;
      r.spin += this.spinHist[a];
      const p = this.polls.get(a);
      if (p) for (const x of p) r.polls.add(x);
      if (i < 0) unattributed += c;
    }
    let list = [...ranges.values()].sort((x, y) => y.count - x.count || x.start - y.start);
    let other = null;
    if (list.length > this.buckets) {
      const rest = list.slice(this.buckets);
      list = list.slice(0, this.buckets);
      other = { symbol: '(other)', start: null, end: null, count: rest.reduce((s, r) => s + r.count, 0), ranges: rest.length, spin: null };
    }
    const total = this.total, share = (c) => (total ? c / total : 0);
    const rows = list.map((r) => ({
      symbol: r.symbol, start: r.start, end: r.end, count: r.count, share: share(r.count),
      spin: { share: r.count ? r.spin / r.count : 0, polls: [...r.polls].sort((x, y) => x - y).map((x) => hex(x)) },
    }));
    if (other) rows.push(Object.assign(other, { share: share(other.count) }));
    if (this.halted) rows.push({ symbol: '(halted)', start: null, end: null, count: this.halted, share: share(this.halted), spin: null });
    rows.sort((x, y) => y.count - x.count);
    return {
      mode: this.mode, every: this.mode === 'samples' ? this.every : null, total, halted: this.halted, unattributed,
      rows: rows.slice(0, top), ranges: list.length + (other ? other.ranges : 0),
      note: 'counts are keyed by CPU address: banked or MMU-mapped code that runs at one address is counted together',
    };
  }
}

// the report as a text table
export function profileText(r) {
  const unit = r.mode === 'samples' ? `samples (one every ${r.every} cycles)` : 'cycles';
  const lines = [`${r.total} ${unit}; halted ${r.halted}; outside any symbol ${r.unattributed}`];
  lines.push(`${'share'.padStart(6)}  ${'count'.padStart(12)}  ${'spin'.padStart(5)}  where`);
  for (const row of r.rows) {
    const where = row.start === null ? row.symbol : `${row.symbol || 'page'} ${hex(row.start)}-${hex(row.end)}`;
    const spin = row.spin ? `${(row.spin.share * 100).toFixed(0)}%` : '';
    const polls = row.spin && row.spin.polls.length ? `  polls ${row.spin.polls.join(' ')}` : '';
    lines.push(`${(row.share * 100).toFixed(1).padStart(5)}%  ${String(row.count).padStart(12)}  ${spin.padStart(5)}  ${where}${polls}`);
  }
  lines.push(`(${r.note})`);
  return lines.join('\n');
}
