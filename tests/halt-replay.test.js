// The CoCo 3's instruction held by the disk controller's HALT and run again once HALT is released
// (js/machines/halt-replay.js haltSuspend / haltResume): the run again must make exactly the reads the first run made. A 6309
// TFM whose source overlaps its destination reads bytes it has itself written; run again from memory, it would read
// those new bytes instead of the ones it read the first time.
//
// Oracle: the same program run with HALT disabled in the drive select latch (no hold) gives the memory and registers
// the held run must end with; for the overlapping forms the expected bytes are also derived independently from the
// TFM's definition (each destination byte gets the source byte as it was when read). Then a TFM long enough that its
// bus cycles pass the CPU's former 96-entry cycle log, and malformed suspended state in a snapshot.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const hex = (v) => '$' + v.toString(16).toUpperCase();

// a 6309 CoCo 3 with the CoCo FDC, drive 0 read once (as tests/halt-held.test.js); run(select, tfm) runs READ SECTOR on
// drive 1 (empty: no DRQ, HALT stays asserted while enabled) with the drive select byte `select`, then the TFM, then BRA *
function machine() {
  const m = Emu.createMachine('coco3', { cpu: '6309' });
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();
  return { m, f };
}
const HALT_ON = 0x8A, HALT_OFF = 0x0A;                  // drive 1, motor on, NMI off; with and without HALT
const FORCE_INTERRUPT = (m) => m.write(0xFF48, 0xD8);

// TFM op (0x38..0x3B) X to Y, W bytes; the memory from `fill` (address -> byte) set first. Held: suspended at frame ends
// for `frames` frames, then released. Returns memory snapshot and registers at BRA *.
function run({ op, x, y, w, fill, select, frames = 3, watch }) {
  const { m } = machine();
  for (const [a, v] of fill) m.poke(a, v);
  const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, select, 0xF7, 0xFF, 0x40,
    0x11, op, 0x12, 0x20, 0xFE];
  code.forEach((b, i) => m.poke(0x3000 + i, b));
  const BRA = 0x3000 + code.length - 2;
  m.cpu.x = x; m.cpu.y = y; m.cpu.w = w; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  let held = 0;
  for (let i = 0; i < frames; i++) { m.runFrame(); if (m.halt.haltDefer) held++; }
  FORCE_INTERRUPT(m);
  for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame();
  const mem = watch.map((a) => m.peek(a));
  return { held, done: m.cpu.pc === BRA && !m.halt.haltDefer, mem, regs: [m.cpu.x, m.cpu.y, m.cpu.w, m.cpu.a, m.cpu.cc & 0xF1] };   // (B and N, Z, V: LDB of the select byte)
}
const range = (a, n) => Array.from({ length: n }, (_, i) => (a + i) & 0xFFFF);

// the four forms, each held on an I/O access after it has written bytes it reads. Only the two forms that move both
// pointers can end with other memory when the reads are wrong: r0+,r1 leaves only its last byte in its one destination,
// r0,r1+ copies its one source byte (onto itself too). Those two are compared all the same.
const cases = [
  // 38 X+,Y+: source $FEF0-$FF00 (its last byte PIA0's $FF00), destination one below: each byte read is the one the
  // previous byte overwrote... after it was read. The review's repro.
  { name: 'TFM X+,Y+ (W=17)', op: 0x38, x: 0xFEF0, y: 0xFEEF, w: 17, watch: range(0xFEEF, 17) },
  // the same past the 96-entry cycle log: 65 bytes, 132+ bus cycles
  { name: 'TFM X+,Y+ (W=65)', op: 0x38, x: 0xFEC0, y: 0xFEBF, w: 65, watch: range(0xFEBF, 65) },
  // 39 X-,Y-: source $0010 down through $0000, the ROM vectors $FFFF-$FFE0 and on to $FFDF (I/O); destination one above
  { name: 'TFM X-,Y- (W=50)', op: 0x39, x: 0x0010, y: 0x0011, w: 50, watch: range(0x0000, 0x12) },
  // 3A X+,Y: source $FEF0-$FF00, destination fixed at $FEF5, inside the source
  { name: 'TFM X+,Y (W=17)', op: 0x3A, x: 0xFEF0, y: 0xFEF5, w: 17, watch: range(0xFEF0, 16) },
  // 3B X,Y+: source fixed at $FEF8, destination $FEF0 up to the I/O page ($FF00, PIA0)
  { name: 'TFM X,Y+ (W=17)', op: 0x3B, x: 0xFEF8, y: 0xFEF0, w: 17, watch: range(0xFEF0, 16) },
];
for (const c of cases) {
  const fill = c.watch.map((a) => [a, 0x10 + (a & 0x7F)]);
  for (const a of range(0xFEC0, 0x40)) fill.push([a, 0x10 + (a & 0x7F)]);
  const free = run({ ...c, fill, select: HALT_OFF, watch: c.watch });
  const held = run({ ...c, fill, select: HALT_ON, watch: c.watch });
  check(`${c.name}: held ${held.held} frames, then completes`, held.held >= 2 && held.done && free.done, `held ${held.held} done ${held.done}/${free.done}`);
  const firstDiff = held.mem.findIndex((v, i) => v !== free.mem[i]);
  check(`${c.name}: held and run again, memory equals the run without HALT`, firstDiff < 0,
    firstDiff < 0 ? '' : `at ${hex(c.watch[firstDiff])}: held ${held.mem.slice(firstDiff, firstDiff + 4).map(hex)} free ${free.mem.slice(firstDiff, firstDiff + 4).map(hex)}`);
  check(`${c.name}: registers equal the run without HALT`, held.regs.every((v, i) => v === free.regs[i]), `${held.regs.map(hex)} vs ${free.regs.map(hex)}`);
  // independently: each destination byte is the source byte as it was when read (a byte in the fill, or one the TFM wrote
  // before; the last read is I/O, whatever it returned: its destination isn't checked)
  if (c.op !== 0x3B) {
    const mem = new Map(fill), dec = c.op === 0x39;
    let s = c.x, d = c.y;
    const io = (a) => a >= 0xFF00;
    for (let i = 0; i < c.w; i++) {
      const v = io(s) ? null : mem.get(s);
      if (!io(d)) mem.set(d, v);
      if (c.op !== 0x3B) s = (s + (dec ? -1 : 1)) & 0xFFFF;
      if (c.op !== 0x3A) d = (d + (dec ? -1 : 1)) & 0xFFFF;
    }
    const want = c.watch.map((a) => mem.get(a));
    const bad = want.findIndex((v, i) => v !== null && v !== undefined && v !== held.mem[i]);
    check(`${c.name}: held run's bytes are the source bytes as first read (derived from the definition)`, bad < 0,
      bad < 0 ? '' : `at ${hex(c.watch[bad])}: ${hex(held.mem[bad])}, want ${hex(want[bad])}`);
  }
}

// ---------------- a held instruction longer than the old 96-entry cycle log ----------------
// TFM X+,Y+ from $FEC0-$FF00 to $5000, 65 bytes (130 bus accesses, 201 cycles): the memory it waits with (cpuCheck)
// holds every byte it read, so a byte read late in it ($FEF0, the 49th) written from outside while it is held drops it
// (it then runs afresh and copies the new byte); a byte it never touched leaves it held, and it completes with the
// bytes it read.
function setupLong(m) {
  for (const a of range(0xFEC0, 0x40)) m.poke(a, a & 0xFF);
  const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, HALT_ON, 0xF7, 0xFF, 0x40,
    0x11, 0x38, 0x12, 0x20, 0xFE];
  code.forEach((b, i) => m.poke(0x3000 + i, b));
  m.cpu.x = 0xFEC0; m.cpu.y = 0x5000; m.cpu.w = 65; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  return 0x3000 + code.length - 2;
}
for (const [where, addr, dropped] of [['a byte it read late ($FEF0)', 0xFEF0, true], ['a byte it never touched ($6000)', 0x6000, false]]) {
  const { m } = machine();
  const BRA = setupLong(m);
  for (let i = 0; i < 2; i++) m.runFrame();
  const d = m.halt.haltDefer;
  const memAddrs = d ? d.mem.filter((v, i) => i % 2 === 0) : [];
  const all = range(0xFEC0, 64).every((a) => memAddrs.includes(a)) && range(0x5000, 64).every((a) => memAddrs.includes(a));
  const dbg = new Emu.Debugger(m);
  dbg.write(addr, [0xAB]);
  m.cpuCheck();
  const kept = !!m.halt.haltDefer;
  FORCE_INTERRUPT(m);
  for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) dbg.runFrame();
  dbg.detach();
  check(`TFM of 65 bytes held: the memory it waits with holds all 128 RAM bytes it touched`, !!d && all && !!d.log && d.log.length / 2 >= 130, `log ${d && d.log ? d.log.length / 2 : 0}`);
  check(`TFM of 65 bytes held, ${where} written from outside: ${dropped ? 'dropped, then run afresh (copies $AB)' : 'kept, completes with the byte it read ($F0)'}`,
    kept === !dropped && m.cpu.pc === BRA && m.peek(0x5030) === (dropped ? 0xAB : 0xF0) && m.peek(0x503F) === 0xFF,
    `kept ${kept} pc ${hex(m.cpu.pc)} $5030 ${hex(m.peek(0x5030))}`);
}

// ---------------- malformed suspended state in a snapshot ----------------
// A file whose haltDefer.log or .mem isn't a list of address, byte pairs, or whose mem isn't the log's memory, is refused
// with a message. A well-formed log that doesn't belong to the instruction (an access at another address, a write of
// another byte, one access too few or too many, the held access in another cycle) loads, and is dropped when the
// instruction runs again: no access of it reaches the bus, the CPU runs the instruction afresh after the release, and
// the memory ends as without HALT (the TFM copies $FEF0-$FF00 to $5000, not overlapping).
{
  const fresh = () => {
    const { m } = machine();
    for (const a of range(0xFEF0, 16)) m.poke(a, 0x40 + (a & 0x0F));
    const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, HALT_ON, 0xF7, 0xFF, 0x40, 0x11, 0x38, 0x12, 0x20, 0xFE];
    code.forEach((b, i) => m.poke(0x3000 + i, b));
    m.cpu.x = 0xFEF0; m.cpu.y = 0x5000; m.cpu.w = 17; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
    return m;
  };
  const BRA = 0x3012;
  const src = fresh();
  for (let i = 0; i < 2; i++) src.runFrame();
  const json = Emu.state.toJSON(src.saveState());
  const good = Emu.state.fromJSON(json);
  check('malformed state: the source snapshot holds a suspended TFM', !!good.haltDefer && good.haltDefer.log.length > 0);
  const memOf = (log, mem) => { const out = [], m = new Map(); for (let i = 0; i < mem.length; i += 2) m.set(mem[i], mem[i + 1]); for (let i = 0; i < log.length; i += 2) if (log[i] < 0xFF00) out.push(log[i], m.has(log[i]) ? m.get(log[i]) : 0); return out; };
  const variant = (fn) => { const s = Emu.state.fromJSON(json); fn(s.haltDefer); return s; };
  const lastWrite = (log) => { for (let i = log.length - 2; i >= 0; i -= 2) if (log[i] >= 0x5000 && log[i] < 0x5100) return i; return -1; };
  const refused = [
    ['a log of odd length', (d) => { d.log.push(1); }, /haltDefer\.log/],
    ['a log byte above 255', (d) => { d.log[1] = 256; }, /haltDefer\.log/],
    ['a log address above $FFFF', (d) => { d.log[0] = 0x10000; }, /haltDefer\.log/],
    ['a log that is not a list', (d) => { d.log = 'x'; }, /haltDefer\.log/],
    ['a mem address in the I/O page', (d) => { d.mem[0] = 0xFF00; }, /haltDefer\.mem/],
    ['a mem that is not the log\'s memory (an address changed)', (d) => { d.mem[2] = (d.mem[2] + 1) & 0xFFFF; }, /memory of "haltDefer\.log"/],
    ['a mem one pair short', (d) => { d.mem.length -= 2; }, /memory of "haltDefer\.log"/],
    // the times (a run that went on with them would put the machine's time, or the CPU's count, far off)
    ['a start after the machine\'s time', (d) => { d.s += 4e6; }, /haltDefer\.s" is out of range/],
    ['a start not a whole tick', (d) => { d.s += 1.5; }, /haltDefer\.s" is out of range/],
    ['a held access far past its log', (d) => { d.n = 1e9; }, /haltDefer\.n" is out of range/],
    ['a held access before its logged ones', (d) => { d.n = 2; }, /haltDefer\.n" is out of range/],
    ['a stop point before the instruction', (d) => { d.k = -1e6; }, /haltDefer\.k" is out of range/],
    ['a release after the machine\'s time', (d) => { d.rel = d.s + 4e6; }, /haltDefer\.rel" is out of range/],
    ['a speed change past the held access', (d) => { d.speedChange = d.n + 1; }, /haltDefer\.speedChange" is out of range/],
  ];
  for (const [name, fn, re] of refused) {
    const m = fresh();
    let err = null;
    try { m.loadState(variant(fn)); } catch (e) { err = e; }
    check(`malformed state, ${name}: refused with a message`, !!err && re.test(err.message), err ? err.message : 'loaded');
  }
  const dropped = [
    ['a logged read at another address', (d) => { d.log[2 * 4] ^= 1; d.mem = memOf(d.log, d.mem); }],
    ['a logged write of another byte', (d) => { d.log[lastWrite(d.log) + 1] ^= 0xFF; }],
    ['one access too few', (d) => { d.log.length -= 2; d.mem = memOf(d.log, d.mem); }],
    ['one access too many (the held one, logged)', (d) => { d.log.push(0xFF00, 0x00); d.n += 1; }],
    ['the held access in another cycle', (d) => { d.n += 1; }],
    // the log holding every access, the held one and the TFM's last write too: the replay runs the instruction to its
    // end, and the cycles it counted are taken back with it
    ['every access logged (the replay completes the instruction)', (d) => { d.log.push(0xFF00, 0x00, 0x5010, 0x00); d.mem.push(0x5010, 0xFF); d.n += 2; }]   // ($5010 as memory holds it: power-on $FF),
  ];
  const lags = [];
  for (const [name, fn] of dropped) {
    const m = fresh();
    let err = null;
    try { m.loadState(variant(fn)); } catch (e) { err = e; }
    const loaded = !err && !!m.halt.haltDefer;
    const r0 = m.redirects;
    let crash = null;
    try {
      m.runFrame();
      FORCE_INTERRUPT(m);
      for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame();
    } catch (e) { crash = e; }
    const ok = range(0x5000, 16).every((a) => m.peek(a) === 0x40 + (a & 0x0F));
    const lag = m.cpu.totalCycles - m.cycle / m.div;   // (the CPU's count against the machine's time: as in every drop)
    if (lags.length && lag !== lags[0]) check(`malformed state, ${name}: the CPU's cycle count keeps up with the time as in the other drops`, false, `${lag} vs ${lags[0]}`);
    lags.push(lag);
    check(`malformed state, ${name}: loads, dropped when run again (no crash), then runs afresh to the right bytes`,
      loaded && !crash && m.redirects === r0 + 1 && !m.halt.haltDefer && m.cpu.pc === BRA && ok && m.cpu.x === 0xFF01 && m.cpu.y === 0x5011,
      `err ${err && err.message} crash ${crash && crash.message} loaded ${loaded} redirects +${m.redirects - r0} pc ${hex(m.cpu.pc)} ok ${ok}`);
  }
  // and the well-formed file, for comparison: kept, completes with the bytes it read
  {
    const m = fresh();
    m.loadState(Emu.state.fromJSON(json));
    const r0 = m.redirects;
    m.runFrame(); FORCE_INTERRUPT(m);
    for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame();
    check('well-formed state: kept (no drop) and completes to the right bytes',
      m.redirects === r0 && m.cpu.pc === BRA && range(0x5000, 16).every((a) => m.peek(a) === 0x40 + (a & 0x0F)), `redirects +${m.redirects - r0} pc ${hex(m.cpu.pc)}`);
  }
}

// ---------------- outside accesses while held, and snapshots of it ----------------
// Between runs the CPU's cycle count is 0 (haltPark), so an access from outside is timed at the machine's time. A
// 6309 TFM of 384 bytes held on a sector not found, the debugger writing PIA0's $FF02 after every 211-tick slice: every
// snapshot taken while held (every 1000th, and each one whose release is already recorded) loads, and it completes.
{
  const mk = () => { const { m } = machine(); return m; };
  const setup = (m) => {
    const code = [0xC6, 99, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0x89, 0xF7, 0xFF, 0x40, 0x11, 0x38, 0x12, 0x20, 0xFE];
    code.forEach((b, i) => m.poke(0x3000 + i, b));
    Object.assign(m.cpu, { x: 0xFE00, y: 0x4000, w: 0x180, pc: 0x3000 }); m.cpu.cc |= 0x50;
  };
  const m = mk(); setup(m);
  const dbg = new Emu.Debugger(m);
  let held = 0, saved = 0, refused = null;
  for (let i = 0; i < 40000 && m.cpu.pc !== 0x3012; i++) {
    m.runCycles(m.cycle + 211);
    if (!m.halt.haltDefer) continue;
    held++;
    dbg.write(0xFF02, [0xFF]);
    if (held % 1000 === 1 || m.halt.haltDefer.rel >= 0) {
      saved++;
      try { mk().loadState(Emu.state.fromJSON(Emu.state.toJSON(m.saveState()))); } catch (e) { refused = e.message; }
    }
  }
  dbg.detach();
  check('a held TFM, the debugger writing I/O after every slice: every snapshot taken while held loads, and it completes',
    held > 1000 && saved > 1 && !refused && m.cpu.pc === 0x3012 && !m.halt.haltDefer, `held ${held} saved ${saved} refused ${refused} pc ${hex(m.cpu.pc)}`);
}
// a 6309 PSHU A,B with U=$FFDA: its first write ($FFD9) speeds the CPU up, the second ($FFD8) is held. Saved while held,
// restored (once, and through three round trips) and released by the debugger's Force Interrupt: each restored machine
// ends as the original, cycle for cycle
{
  const mk = () => { const { m } = machine(); return m; };
  const m = mk();
  [0xB7, 0xFF, 0xD8, 0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, HALT_ON, 0xF7, 0xFF, 0x40, 0x36, 0x06, 0x20, 0xFE]
    .forEach((b, i) => m.poke(0x3000 + i, b));
  Object.assign(m.cpu, { pc: 0x3000, d: 0x1234, u: 0xFFDA }); m.cpu.cc |= 0x50;
  m.runFrame();
  const d = m.halt.haltDefer;
  let js = Emu.state.toJSON(m.saveState());
  const once = mk(); once.loadState(Emu.state.fromJSON(js));
  let thrice = null;
  for (let r = 0; r < 3; r++) { thrice = mk(); thrice.loadState(Emu.state.fromJSON(js)); js = Emu.state.toJSON(thrice.saveState()); }
  const fin = (x) => { const g = new Emu.Debugger(x); g.write(0xFF48, [0xD8]); for (let i = 0; i < 3; i++) x.runFrame(); g.detach(); return [x.cpu.pc, x.cpu.u, x.cpu.totalCycles, x.cycle, x.div].join(); };
  const want = fin(m), a = fin(once), b = fin(thrice);
  check('a held PSHU that changed the speed, saved: restored once and through three round trips it ends as the original',
    !!d && d.speedChange >= 0 && a === want && b === want, `held ${!!d} ${a} / ${b} vs ${want}`);
}

// ---- a replayed write is not made again ----
// A held TFM X+,Y+ whose destination is the GIME's palette ($FFB0-$FFBF): its source runs into PIA0 ($FF00), so the read
// of $FF00, the 17th, is the held access, after 16 palette writes. Run again once HALT is released, the instruction
// replays those 16 writes from its log (HaltReplay.replayWrite) and does not make them again: each palette register
// reaches the GIME once, as on the hardware (one bus cycle each), and the palette ends as the run without HALT leaves it.
{
  const once = (select) => {
    const { m } = machine();
    for (let a = 0xFEF0; a < 0xFF00; a++) m.poke(a, (a * 7) & 0x3F);
    const code = [0xC6, 0x01, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, select, 0xF7, 0xFF, 0x40, 0x11, 0x38, 0x12, 0x20, 0xFE];
    code.forEach((b, i) => m.poke(0x3000 + i, b));
    const BRA = 0x3000 + code.length - 2;
    const orig = m.gime.writeReg.bind(m.gime);
    let writes = 0;
    m.gime.writeReg = (a, v, t) => { if (a >= 0xFFB0 && a <= 0xFFBF) writes++; return orig(a, v, t); };
    m.cpu.x = 0xFEF0; m.cpu.y = 0xFFB0; m.cpu.w = 17; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
    let held = 0;
    for (let i = 0; i < 3; i++) { m.runFrame(); if (m.halt.haltDefer) held++; }
    FORCE_INTERRUPT(m);
    for (let i = 0; i < 3 && m.cpu.pc !== BRA; i++) m.runFrame();
    m.gime.writeReg = orig;
    return { held, writes, done: m.cpu.pc === BRA, palette: Array.from(m.gime.palette.slice(0, 16)) };
  };
  const free = once(HALT_OFF), held = once(HALT_ON);
  check('a held TFM onto the palette: held, then completes', held.held >= 2 && held.done && free.done, `held ${held.held} done ${held.done}/${free.done}`);
  check('a held TFM onto the palette: each palette register is written once (the replayed writes are not made again)',
    held.writes === 16 && free.writes === 16, `held ${held.writes}, free ${free.writes} palette writes`);
  check('a held TFM onto the palette: the palette ends as the run without HALT leaves it', held.palette.join() === free.palette.join(), `${held.palette} vs ${free.palette}`);
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
