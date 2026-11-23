// Floppy disk controller cartridges (js/machines/fdc.js) with the WD2797/WD2791/WD1773 (js/chips/wd17xx.js) and the
// drives (js/chips/floppy.js), driven register by register on a bare host with a 1 MHz tick, so times read
// directly in microseconds. Expected values: stepping rates from the WD179x data sheet (Western Digital,
// FD179X-02 Floppy Disk Formatter/Controller Family, "Stepping rates" table: 6/12/20/30 ms at 1 MHz), CRCs
// computed independently (tools/mame-diff/fdc/images.js crc16), MAME's documented constants (register commit
// 16 clocks, command commit 12 clocks, index pulse 2 ms, slot NMI delay 12 and HALT delay 6 CPU cycles).
// The full behaviour, cycle by cycle, is checked against MAME by tools/mame-diff/run.js <profile> --fdc.
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (name, fn, re) => { let msg = null; try { fn(); } catch (e) { msg = e.message; } check(name, msg !== null && re.test(msg), msg === null ? 'did not throw' : msg); };

// a bare host: 1 tick = 1 us, events in time order; the machine's slot line delays (NMI 12, HALT 6 cycles)
class Host {
  constructor() { this.lineDelays = { cart: 0, nmi: 12, halt: 6 }; this.tickHz = 1e6; this.slotHz = 1e6; this.unitAttos = 1000000000000n; this.t = 0; this.q = []; this.handlers = {}; this.lines = []; this.seq = 0; }
  on(n, f) { this.handlers[n] = f; }
  off(n) { delete this.handlers[n]; this.q = this.q.filter((e) => e.name !== n); }
  cartSound() { }
  schedule(at, name, arg) { this.q.push({ at, name, arg, seq: this.seq++ }); this.q.sort((a, b) => a.at - b.at || a.seq - b.seq); }
  clockUnits() { return Math.round(this.t); }
  tickAt(u) { return Math.round(this.t) + u; }
  now() { return this.t; }
  setLine(src, line, level) { this.lines.push({ t: Math.round(this.t), line, level }); }
  advance(us) {
    const end = this.t + us;
    while (this.q.length && this.q[0].at <= end) { const e = this.q.shift(); this.t = Math.max(this.t, e.at); this.handlers[e.name](e.arg); }
    this.t = end;
  }
}
function board(type, disks) {
  const host = new Host();
  const fdc = new Emu.devices[type]({ rom: new Uint8Array(0x2000) });
  fdc.attach(host);
  fdc.reset(true);
  const writes = [];
  disks.forEach((d, i) => { if (d) fdc.mount(i, { bytes: d.bytes.slice(), format: d.format, name: d.name || '', writeProtected: !!d.wp, onWrite: (o, b) => writes.push({ drive: i, offset: o, bytes: b }) }); });
  return { host, fdc, writes };
}
// Dragon registers: $FF40-$FF43, latch $FF48
const D = { STAT: 0xFF40, TRK: 0xFF41, SEC: 0xFF42, DAT: 0xFF43, LATCH: 0xFF48 };
const waitNotBusy = (h, f, max = 2e6) => { let t = 0; while ((f.readIO(D.STAT) & 1) && t < max) { h.advance(1); t++; } return t; };
// type II transfers: take each byte on DRQ
// (until the command is taken, 12 clocks after the write, the status is still the type I one, whose bit 1
// is the index pulse)
function transfer(h, f, write = null) {
  const out = [];
  let t = 0;
  h.advance(14);
  for (;;) {
    const s = f.readIO(D.STAT);
    if (s & 2) { if (write) f.writeIO(D.DAT, write[out.length] || 0); out.push(write ? 0 : f.readIO(D.DAT)); }
    else if (!(s & 1)) return { bytes: out, status: s, t };
    h.advance(1); t++;
    if (t > 3e6) return { bytes: out, status: -1, t };
  }
}

// ---------------- Dragon FDC (WD2797 at 1 MHz)
{
  const vdk = images.vdk(40, 2);
  const { host: h, fdc: f, writes } = board('dragonfdc', [{ bytes: vdk, format: 'vdk' }, { bytes: images.vdk(40, 1), format: 'vdk', wp: true }, null, { bytes: images.dmk(10, 2), format: 'dmk' }]);
  check('after reset the WD2797 is busy (its own restore, as MAME)', (f.readIO(D.STAT) & 1) === 1);
  f.writeIO(D.STAT, 0xd0); h.advance(17);
  check('force interrupt ends it', (f.readIO(D.STAT) & 1) === 0);
  f.writeIO(D.TRK, 0x55);
  check('track register: the old value at once (commit delay)', f.readIO(D.TRK) === 0);
  h.advance(17);
  check('track register: the new value 16 clocks later', f.readIO(D.TRK) === 0x55);
  check('unused register addresses read 00', f.readIO(0xFF44) === 0 && f.readIO(0xFF48) === 0);
  check('registers are mirrored at $FF50', f.readIO(0xFF51) === 0x55);

  // motor on, drive 0: the index pulse, 2 ms of every 200 ms revolution
  f.writeIO(D.LATCH, 0x04); f.writeIO(D.STAT, 0xd0); h.advance(20);
  const ip = (at) => { h.advance(at - h.t); return f.readIO(D.STAT) & 2; };
  const t0 = h.t - 20;
  check('index pulse high right after motor on', ip(t0 + 1000) === 2);
  check('index pulse low after 2 ms', ip(t0 + 2100) === 0);
  check('index pulse low at 199.9 ms', ip(t0 + 199900) === 0);
  check('index pulse high again at 200.1 ms', ip(t0 + 200100) === 2);

  // seek at 6 ms per step: 3 steps = 18 ms after the 12-clock command commit
  f.writeIO(D.STAT, 0x00); waitNotBusy(h, f);
  f.writeIO(D.DAT, 3); h.advance(20);
  const s0 = h.t;
  f.writeIO(D.STAT, 0x10);
  const took = waitNotBusy(h, f);
  check('seek 3 tracks at r=0 takes 3 x 6 ms (+12 us commit)', took >= 18012 && took <= 18014, String(took));
  check('track register 3 after the seek', f.readIO(D.TRK) === 3);
  f.writeIO(D.DAT, 5); h.advance(20);
  f.writeIO(D.STAT, 0x13);
  const took30 = waitNotBusy(h, f);
  check('seek 2 tracks at r=3 takes 2 x 30 ms', took30 >= 60012 && took30 <= 60014, String(took30));
  void s0;

  // read address: track, side, sector, length, CRC (CRC-CCITT over A1 A1 A1 FE ...)
  f.writeIO(D.STAT, 0xc0);
  const id = transfer(h, f);
  const crc = images.crc16([0xa1, 0xa1, 0xa1, 0xfe, id.bytes[0], id.bytes[1], id.bytes[2], id.bytes[3]]);
  check('read address: 6 bytes, track 5 side 0 size 1', id.bytes.length === 6 && id.bytes[0] === 5 && id.bytes[1] === 0 && id.bytes[3] === 1, id.bytes.join(','));
  check('read address: the CRC bytes are the ID field CRC', ((id.bytes[4] << 8) | id.bytes[5]) === crc && id.status === 0);
  check('read address puts the track number in the sector register', f.readIO(D.SEC) === 5);

  // read sector 3 (b = 1: IBM lengths)
  f.writeIO(D.SEC, 3); h.advance(20);
  f.writeIO(D.STAT, 0x88);
  const r3 = transfer(h, f);
  check('read sector: 256 bytes of track 5 side 0 sector 3', r3.bytes.length === 256 && r3.bytes.every((v, i) => v === images.sectorByte(5, 0, 3, i)) && r3.status === 0);
  // side 1 (S flag)
  f.writeIO(D.SEC, 9); h.advance(20);
  f.writeIO(D.STAT, 0x8a);
  const r9 = transfer(h, f);
  // `every` is true on an empty array, so the length and status are part of the assertion (AGENTS.md 1.3)
  check('read sector on side 1 (command S flag)', r9.bytes.length === 256 && r9.status === 0 && r9.bytes.every((v, i) => v === images.sectorByte(5, 1, 9, i)),
    `${r9.bytes.length} bytes, status ${r9.status}`);
  // lost data: nobody takes the bytes
  f.writeIO(D.SEC, 1); h.advance(20);
  f.writeIO(D.STAT, 0x88); waitNotBusy(h, f);
  check('lost data when DRQ is not served', (f.readIO(D.STAT) & 0x04) === 0x04);
  // record not found: five revolutions
  f.writeIO(D.SEC, 30); h.advance(20);
  f.writeIO(D.STAT, 0x88);
  const rnf = waitNotBusy(h, f);
  check('record not found after five index pulses (0.8-1.0 s)', (f.readIO(D.STAT) & 0x10) && rnf > 800000 && rnf < 1001000, String(rnf));

  // write sector 4, then read it back; the disk image changes there when the motor stops
  const data = Array.from({ length: 256 }, (_, i) => (i * 7 + 1) & 0xff);
  f.writeIO(D.SEC, 4); h.advance(20);
  f.writeIO(D.STAT, 0xa8);
  const w = transfer(h, f, data);
  check('write sector: 256 DRQs, status 0', w.bytes.length === 256 && w.status === 0);
  f.writeIO(D.SEC, 4); h.advance(20);
  f.writeIO(D.STAT, 0x88);
  { const back = transfer(h, f);
    check('the sector reads back what was written', back.bytes.length === 256 && back.status === 0 && back.bytes.every((v, i) => v === data[i]),
      `${back.bytes.length} bytes, status ${back.status}`); }
  f.writeIO(D.LATCH, 0x00);                                    // motor off: the drive commits its disk
  const off = 12 + ((5 * 2 + 0) * 18 + 3) * 256;
  const w0 = writes.filter((x) => x.drive === 0);
  check('the image is written back only where sector 4 of track 5 lies (changed ranges)', w0.length > 0 && w0.every((x) => x.offset >= off && x.offset + x.bytes.length <= off + 256 && x.bytes.every((v, i) => v === data[x.offset - off + i])), w0.map((x) => `${x.offset}+${x.bytes.length}`).join(' '));
  check('the drive\'s media bytes follow', f.drives[0].media.bytes.slice(off, off + 256).every((v, i) => v === data[i]));

  // write protect (drive 1)
  f.writeIO(D.LATCH, 0x05); f.writeIO(D.STAT, 0xd0); h.advance(40);
  check('type I status shows write protect on drive 1', (f.readIO(D.STAT) & 0x40) === 0x40);
  f.writeIO(D.SEC, 1); h.advance(20);
  f.writeIO(D.STAT, 0xa8);
  const wp = transfer(h, f, data);
  check('write sector on a protected disk: WP, no DRQ', wp.bytes.length === 0 && (wp.status & 0x40) === 0x40, `${wp.bytes.length} ${wp.status.toString(16)}`);

  // drive 2 has no disk: no index pulse; read address only ends by force interrupt
  f.writeIO(D.LATCH, 0x06); f.writeIO(D.STAT, 0xd0); h.advance(40);
  f.writeIO(D.STAT, 0xc0); h.advance(300000);
  check('drive without a disk: read address still busy after 300 ms', (f.readIO(D.STAT) & 1) === 1);
  f.writeIO(D.STAT, 0xd0); h.advance(40);
  check('force interrupt ends it', (f.readIO(D.STAT) & 1) === 0);

  // NMI on INTRQ (latch bit 5), 12 CPU cycles after the WD2797 raises it; D8 = interrupt at once
  f.writeIO(D.LATCH, 0x24);
  h.lines.length = 0;
  const td8 = h.t;
  f.writeIO(D.STAT, 0xd8);
  h.advance(100);
  const nmi = h.lines.find((l) => l.line === 'nmi' && l.level);
  check('force interrupt D8: NMI 16 + 12 us after the command', nmi && nmi.t - td8 === 28, nmi ? String(nmi.t - td8) : 'none');
  check('DRQ drives CART: CART follows it', (() => { h.lines.length = 0; f.writeIO(D.STAT, 0xd0); h.advance(40); f.writeIO(D.SEC, 2); h.advance(20); f.writeIO(D.STAT, 0x88); transfer(h, f); return h.lines.some((l) => l.line === 'cart' && l.level) && h.lines.some((l) => l.line === 'cart' && !l.level); })());

  throws('no drive 4', () => f.mount(4, { bytes: vdk, format: 'vdk' }), /no drive 4/);
  throws('a damaged image is refused at mount', () => f.mount(2, { bytes: vdk.slice(0, 1000), format: 'vdk' }), /header needs/);
}

// ---------------- CoCo FDC (WD1773 at 8 MHz): DSKREG decoding, HALT transfers
{
  const { host: h, fdc: f } = board('cocofdc', [{ bytes: images.jvc(40, 2), format: 'jvc' }, null, null, null]);
  const C = { DSK: 0xFF40, STAT: 0xFF48, TRK: 0xFF49, SEC: 0xFF4A, DAT: 0xFF4B };
  check('CoCo: WD1773 at $FF48, DSKREG write-only (reads 00)', f.readIO(C.DSK) === 0 && (f.readIO(C.STAT) & 1) === 1);
  f.writeIO(C.STAT, 0xd0); h.advance(5);
  f.writeIO(0xFF47, 0x29);                                          // DSKREG mirror: drive 0, motor, double density
  check('DSKREG $FF40-$FF47: drive 0 selected, motor on', f.wd.floppy === f.drives[0] && f.drives[0].mon === 0);
  f.writeIO(C.DSK, 0x2a);
  check('bit 1 selects drive 1', f.wd.floppy === f.drives[1]);
  f.writeIO(C.DSK, 0x68);
  check('bit 6 alone selects drive 3', f.wd.floppy === f.drives[3] && f.drives[3].ss === 0);
  f.writeIO(C.DSK, 0x69);
  check('bit 6 with drive 0 selects side 1', f.wd.floppy === f.drives[0] && f.drives[0].ss === 1);
  f.writeIO(C.DSK, 0x29);
  // seek: WD1773 steps at 6 ms (12000 clocks x 4 at 8 MHz)
  f.writeIO(C.STAT, 0x00); let t = 0; while (f.readIO(C.STAT) & 1) { h.advance(1); t++; }
  f.writeIO(C.DAT, 2); h.advance(10);
  f.writeIO(C.STAT, 0x10); t = 0; while (f.readIO(C.STAT) & 1) { h.advance(1); t++; }
  check('WD1773 seeks 2 tracks in 2 x 6 ms (+48 x 4 clocks = 24 us commit)', t >= 12024 && t <= 12026, String(t));
  // HALT enable with no DRQ: the slot pulls HALT 6 CPU cycles later; INTRQ clears HALT enable
  f.writeIO(C.SEC, 1); h.advance(10);
  h.lines.length = 0;
  f.writeIO(C.STAT, 0x80);
  f.writeIO(C.DSK, 0xa9);
  h.advance(10);
  const halt = h.lines.find((l) => l.line === 'halt' && l.level);
  check('HALT asserted 6 us after DSKREG sets HALT enable without DRQ', halt && halt.t === h.t - 10 + 6, halt ? String(halt.t) : 'none');
  let n = 0;
  for (let i = 0; i < 400000 && n < 256; i++) { if (f.readIO(C.STAT) & 2) { f.readIO(C.DAT); n++; } h.advance(1); }
  h.advance(2000);
  check('256 bytes through HALT, then INTRQ clears HALT enable', n === 256 && (f.dskreg & 0x80) === 0);
  check('... and NMI follows INTRQ (DSKREG bit 5)', h.lines.some((l) => l.line === 'nmi' && l.level));
}

// ---------------- Premier FDC (WD2791 at 1 MHz): inverted bus, latch at $FF44, side compare, no lines
{
  const vdk = images.vdk(40, 2);
  const { host: h, fdc: f } = board('premierfdc', [{ bytes: vdk, format: 'vdk' }, { bytes: images.vdk(40, 1), format: 'vdk', wp: true }, null, null]);
  const P = { STAT: 0xFF40, TRK: 0xFF41, SEC: 0xFF42, DAT: 0xFF43, LATCH: 0xFF44 };
  // the CPU sees the complement of every register (MAME wd2791_device: bus_invert_value 0xff)
  const st = () => f.readIO(P.STAT) ^ 0xff;
  const cmd = (c) => f.writeIO(P.STAT, c ^ 0xff);
  const busy = () => { let t = 0; while ((st() & 1) && t < 3e6) { h.advance(1); t++; } return t; };
  // data bytes as the CPU reads and writes them (not complemented back)
  const xfer = (write = null) => {
    const out = [];
    h.advance(14);
    for (let t = 0; t < 3e6; t++) {
      const s = st();
      if (s & 2) { if (write) { f.writeIO(P.DAT, write[out.length]); out.push(0); } else out.push(f.readIO(P.DAT)); }
      else if (!(s & 1)) return { bytes: out, status: s };
      h.advance(1);
    }
    return { bytes: out, status: -1 };
  };
  check('Premier: after reset the WD2791 is busy (status read inverted: bit 0 low)', (f.readIO(P.STAT) & 1) === 0);
  cmd(0xd0); h.advance(17);
  check('Premier: force interrupt written inverted ($2F) ends it', (st() & 1) === 0);
  f.writeIO(P.TRK, 0xaa); h.advance(17);
  check('Premier: track register holds the complement of the byte written', f.wd.track === 0x55 && f.readIO(P.TRK) === 0xaa);
  check('Premier: the latch is write-only and nothing is mirrored ($FF44, $FF48, $FF50 read 00)', f.readIO(P.LATCH) === 0 && f.readIO(0xFF48) === 0 && f.readIO(0xFF50) === 0);
  f.writeIO(P.LATCH, 0x11);
  check('Premier latch $11: drive 1 selected, only its motor runs, double density', f.wd.floppy === f.drives[1] && f.drives[1].mon === 0 && f.drives[0].mon === 1 && f.wd.dden === false);
  f.writeIO(P.LATCH, 0x00);
  check('Premier latch $00: drive 0, its motor runs (no motor bit), single density', f.wd.floppy === f.drives[0] && f.drives[0].mon === 0 && f.drives[1].mon === 1 && f.wd.dden === true);
  f.writeIO(P.LATCH, 0x14);
  check('Premier latch bit 2 selects side 1', f.drives[0].ss === 1);
  cmd(0xd0); h.advance(40);
  cmd(0x00); busy();
  f.writeIO(P.DAT, 5 ^ 0xff); h.advance(40);
  cmd(0x10);
  const took = busy();
  check('Premier: seek 5 tracks at r=0 takes 5 x 6 ms (+12 us commit)', took >= 30012 && took <= 30014, String(took));
  // side 1 sector 2 of track 5, the data as the CPU reads it: the complement of the bytes on the disk
  f.writeIO(P.SEC, 2 ^ 0xff); h.advance(40);
  cmd(0x80);
  let r = xfer();
  const want = Array.from({ length: 256 }, (_, i) => images.sectorByte(5, 1, 2, i) ^ 0xff);
  check('Premier: read sector on side 1 (C = 0), 256 bytes, each the complement of the disk byte', r.status === 0 && r.bytes.length === 256 && want.every((v, i) => r.bytes[i] === v), `status ${r.status} n ${r.bytes.length}`);
  cmd(0x8a);
  r = xfer();
  check('Premier: side compare C = 1, S = 1 on side 1 finds the sector', r.status === 0 && r.bytes.length === 256);
  const t0 = h.t;
  cmd(0x82);
  r = xfer();
  check('Premier: side compare C = 1, S = 0 on side 1: record not found after five revolutions', r.status === 0x10 && r.bytes.length === 0 && h.t - t0 >= 800000 && h.t - t0 <= 1000000, `status ${r.status} after ${h.t - t0} us`);
  cmd(0x88);
  r = xfer();
  check('Premier: bit 3 without C changes neither the side nor the length (128 << code)', r.status === 0 && r.bytes.length === 256);
  // write sector 4 of track 5 side 0: the disk receives the complement of what the CPU writes
  f.writeIO(P.LATCH, 0x10);
  f.writeIO(P.SEC, 4 ^ 0xff); h.advance(40);
  const data = Array.from({ length: 256 }, (_, i) => (i * 7 + 1) & 0xff);
  cmd(0xa0);
  r = xfer(data);
  f.writeIO(P.LATCH, 0x12);                  // drive 2 selected: drive 0's motor stops and its track is committed
  f.flush();
  const off = 12 + ((5 * 2 + 0) * 18 + 3) * 256;
  const disk = f.drives[0].media.bytes;
  check('Premier: write sector: 256 bytes taken, the disk holds their complement', r.status === 0 && r.bytes.length === 256 && data.every((v, i) => disk[off + i] === (v ^ 0xff)), `status ${r.status}`);
  // `every` is true on an empty array: assert that line activity was recorded at all and that none of it is
  // an asserted NMI, HALT or CART (MAME's Premier update_lines is empty, so none may be raised)
  check('Premier: no NMI, HALT or CART line is ever asserted (MAME update_lines is empty)',
    h.lines.length > 0 && h.lines.every((l) => !(l.level && (l.line === 'nmi' || l.line === 'halt' || l.line === 'cart'))),
    `${h.lines.length} line changes`);
  f.writeIO(P.LATCH, 0x11);
  cmd(0xd0); h.advance(40);
  check('Premier: write-protected drive 1 shows WP in the type I status', (st() & 0x40) !== 0);
}

// ---------------- reset and detach
// A reset stops every motor; a drive commits its written tracks when its motor stops (floppy.js monW), so a
// reset right after a write must commit too, not leave the data in the drive's flux image.
{
  const vdk = images.vdk(40, 2);
  const { host: h, fdc: f, writes } = board('dragonfdc', [{ bytes: vdk, format: 'vdk' }]);
  f.writeIO(D.STAT, 0xd0); h.advance(17);
  f.writeIO(D.LATCH, 0x04); f.writeIO(D.STAT, 0xd0); h.advance(20);
  const data = Array.from({ length: 256 }, (_, i) => (i * 5 + 3) & 0xff);
  f.writeIO(D.SEC, 4); h.advance(20);
  f.writeIO(D.STAT, 0xa8);
  check('reset after a write: the write went through', transfer(h, f, data).status === 0);
  check('...nothing committed yet (the motor is still on)', writes.length === 0);
  f.reset(false);
  const off = 12 + 3 * 256;                    // track 0 side 0 sector 4 (18 sectors of 256 bytes, 12-byte VDK header)
  check('reset after a write: the drive commits the written sector to the media', writes.length > 0 && f.drives[0].media.bytes.slice(off, off + 256).every((v, i) => v === data[i]), String(writes.length));
}
// Taking a controller out of the machine (eject, or another cartridge inserted) detaches it: it commits what was
// written, lets go of the lines it holds and its timers stop.
{
  const vdk = images.vdk(40, 2);
  const { host: h, fdc: f, writes } = board('dragonfdc', [{ bytes: vdk, format: 'vdk' }]);
  f.writeIO(D.STAT, 0xd0); h.advance(17);
  f.writeIO(D.LATCH, 0x24); f.writeIO(D.STAT, 0xd0); h.advance(40);    // motor on, NMI enabled
  const data = Array.from({ length: 256 }, (_, i) => (i * 3) & 0xff);
  f.writeIO(D.SEC, 2); h.advance(20);
  f.writeIO(D.STAT, 0xa8); transfer(h, f, data);
  f.writeIO(D.STAT, 0xd8); h.advance(100);                             // INTRQ at once: NMI asserted (after its 12 cycles)
  check('detach: NMI is asserted before', f.lines.level('nmi') === 1);
  h.lines.length = 0;
  f.detach();
  check('detach: the asserted NMI is dropped', h.lines.some((l) => l.line === 'nmi' && !l.level) && !h.lines.some((l) => l.level), JSON.stringify(h.lines));
  check('detach: written data is committed', writes.length > 0);
  check('detach: no event of the controller is left queued, no handler', !h.q.some((e) => e.name === 'dragonfdc.timer') && !h.handlers['dragonfdc.timer']);
  check('detach: the device has no host', f.host === null && f.clock.host === null);
}
// in a machine: eject a running controller and its timer events stop; insert another of the same type and only
// its own events run
{
  const m = Emu.createMachine('dragon64');
  const f = new Emu.devices.dragonfdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.vdk(40, 2), format: 'vdk', name: 'a.vdk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  m.write(0xFF48, 0x04);                       // motor on: the index timer runs
  for (let i = 0; i < 3; i++) m.runFrame();
  const queued = () => m.queue.filter((e) => e.name === 'dragonfdc.timer').length;
  check('in a machine: the running controller has a timer event queued', queued() === 1, String(queued()));
  let fired = 0;
  const fire = f.clock.fire.bind(f.clock); f.clock.fire = (g) => { fired++; fire(g); };
  m.ejectCartridge();
  for (let i = 0; i < 50; i++) m.runFrame();
  check('ejected: none of its timer events fire again, none queued', fired === 0 && queued() === 0, `fired ${fired}, queued ${queued()}`);
  const g = new Emu.devices.dragonfdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);                        // in again, then replaced by another: the first one is detached
  m.insertCartridge(g);
  check('replaced by another controller: the first is detached', f.host === null && g.host === m);
}
// a Multi-Pak ejected while the CoCo FDC in its slot 4 is in the middle of a read sector with HALT on DRQ: the
// controller's and the Multi-Pak's lines are dropped, and no timer event or handler of either is left
{
  const m = Emu.createMachine('coco');
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  const mp = new Emu.devices.multi([null, null, null, f]);
  m.insertCartridge(mp);
  m.reset(true);
  const written = [];
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk', onWrite: (o, b) => written.push(o) });
  m.write(0xFF40, 0x09);                       // drive 0, motor on
  for (let i = 0; i < 20; i++) m.runFrame();   // spin up
  m.write(0xFF4A, 1);                          // sector 1
  m.write(0xFF48, 0x80);                       // read sector
  m.write(0xFF40, 0x89);                       // HALT enable: the CPU waits for each DRQ
  let n = 0;
  while (!(f.wd.mainState === 4 && f.wd.live.state !== 0 && m.cpu.haltLine) && n++ < 200000) m.runCycles(m.cycle + 8);
  const names = () => m.queue.filter((e) => /^multi/.test(e.name)).map((e) => e.name);
  const handlers = () => Object.keys(m.handlers).filter((k) => /^multi/.test(k));
  check('Multi-Pak eject: the controller is reading with the CPU halted', (f.wd.mainState === 4) && m.cpu.haltLine, `main ${f.wd.mainState}, halt ${m.cpu.haltLine}`);
  check('Multi-Pak eject: before, the controller\'s and the Multi-Pak\'s timers are on the machine', names().length > 0 && handlers().length === 2, `${names()} / ${handlers()}`);
  m.ejectCartridge();
  check('Multi-Pak eject: no timer event and no handler of either is left', names().length === 0 && handlers().length === 0, `${names()} / ${handlers()}`);
  check('Multi-Pak eject: HALT and NMI are released', !m.cpu.haltLine && !f.lines.level('halt') && !mp.lines.level('halt') && !mp.lines.level('nmi'));
  check('Multi-Pak eject: neither has a host', mp.host === null && f.host === null && f.clock.host === null && mp.clock.host === null);
  const before = m.cpu.totalCycles;
  for (let i = 0; i < 5; i++) m.runFrame();
  check('Multi-Pak eject: the machine runs on', m.cpu.totalCycles > before);
}

// CoCo 3: a read sector with HALT on DRQ whose DRQ doesn't come (drive 1 empty, after a read on drive 0 left the
// control latch's DRQ input low). HALT arrives inside the LDA of the data register, after a check point, so the access
// waits for HALT's release (HaltReplay.haltWait). The wait stops at the end of each frame and the instruction stays
// suspended (haltSuspend): frames go on, the machine's time and video with them, and the CPU stays halted until a
// disk in drive 1 brings the DRQ, or a Force Interrupt the INTRQ that drops HALT. Both timing models.
function emptyDriveRead(config) {
  const m = Emu.createMachine('coco3', config);
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  // the sector, READ SECTOR, then the control latch (drive, motor, DDEN, HALT enable), a NOP, and the DOS loop
  const DOS = [0x12, 0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF9];
  const prog = (dsk, sector, loop, pre) => [...pre, 0xC6, sector, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, dsk, 0xF7, 0xFF, 0x40, ...loop];
  // (interrupts masked, as a DOS reads; pre: code before, at $3000)
  const start = (dsk, sector = 1, loop = DOS, pre = []) => { prog(dsk, sector, loop, pre).forEach((b, i) => m.poke(0x3000 + i, b)); m.cpu.x = 0x4000; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50; };
  m.write(0xFF40, 0x29);
  for (let i = 0; i < 30; i++) m.runFrame();   // spin up
  start(0xA9);                                 // drive 0: a whole sector, then the loop runs on after INTRQ
  for (let i = 0; i < 30; i++) m.runFrame();
  return { m, f, start };
}
const LDA_PC = 0x3010;
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
  for (const release of ['disk', 'force interrupt']) {
    const { m, f, start } = emptyDriveRead(config);
    check(`coco3 empty drive (${label}): the read on drive 0 left DRQ low`, !f.drq && !m.cpu.haltLine);
    start(0xAA);                               // drive 1: empty
    // (a disk goes in after 20 frames: the controller's own count of index pulses, which start with the disk, is not
    // what this is about; a Force Interrupt after 120)
    const wait = release === 'disk' ? 20 : 120;
    const t0 = Date.now(), frame0 = m.frameCount, cycle0 = m.cycle;
    for (let i = 0; i < wait && Date.now() - t0 < 20000; i++) m.runFrame();
    let hs = 0;
    const rise = m.handlers.rise;
    m.handlers.rise = (arg, at) => { hs++; rise(arg, at); };
    for (let i = 0; i < 3; i++) m.runFrame();
    m.handlers.rise = rise;
    check(`coco3 empty drive (${label}): frames keep completing while the CPU waits`, m.frameCount - frame0 === wait + 3 && m.cycle - cycle0 >= (wait + 2) * m.frameCycles,
      `${m.frameCount - frame0} frames in ${Date.now() - t0} ms`);
    check(`coco3 empty drive (${label}): halted inside the LDA of the data register, suspended (not between instructions)`,
      m.cpu.haltLine && m.halt.haltDefer !== null && m.cpu.pc === LDA_PC && m.cpu.x === 0x4000,
      `pc ${m.cpu.pc.toString(16)} x ${m.cpu.x.toString(16)} halt ${m.cpu.haltLine} defer ${!!m.halt.haltDefer}`);
    check(`coco3 empty drive (${label}): the video runs on (every line's HS)`, hs >= 3 * 262 - 1 && hs <= 3 * 262 + 1, `${hs} HS rises in 3 frames`);
    let loops = 0;
    m.cpu.trace = (c) => { if (c.pc === LDA_PC) loops++; };
    if (release === 'disk') {
      f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
      for (let i = 0; i < 40 && m.cpu.x < 0x4100; i++) m.runFrame();
      const got = [...m.ram.subarray(0x4000, 0x4100)], want = Array.from({ length: 256 }, (_, i) => images.sectorByte(0, 0, 1, i));
      check(`coco3 empty drive (${label}): a disk put in drive 1 brings DRQ: the held LDA reads the sector's first byte, the loop the whole sector`,
        got.every((v, i) => v === want[i]) && m.halt.haltDefer === null, `first ${got.slice(0, 4)} want ${want.slice(0, 4)}`);
    } else {
      m.write(0xFF48, 0xD8);                   // Force Interrupt, immediate: INTRQ clears HALT enable
      for (let i = 0; i < 3; i++) m.runFrame();
      // (the held LDA's run after the release isn't traced: it was, when it started)
      check(`coco3 empty drive (${label}): a Force Interrupt's INTRQ releases HALT: the held LDA completes and the loop runs on`,
        !m.cpu.haltLine && m.halt.haltDefer === null && loops > 3000 && loops < 3300 && m.cpu.x === 0x4000 + loops + 1, `halt ${m.cpu.haltLine} loops ${loops} x ${m.cpu.x}`);
    }
    m.cpu.trace = null;
  }
}

// the same wait, released by an event (a disk in drive 1, sector 4: its DRQ comes when the sector passes the head, 11
// frames later), is the same instruction by instruction whether the run is one slice past the release, frames (the
// wait suspended at each frame's end and resumed) or slices of a few cycles. Two held accesses: the LDA of the DOS
// loop, and the write of INC $FF4B (its read, made before HALT, replayed when the instruction runs again).
// The HD6309 in native mode too (LDMD #1), its loop's LDA $FF4B,Y with a 16-bit offset: the native saving its post
// byte adds as the instruction goes must not be counted twice when the instruction runs again.
const INC_LOOP = [0x7C, 0xFF, 0x4B, 0x20, 0xFB];
const NATIVE_LOOP = [0x12, 0xA6, 0xA9, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF8], LDMD1 = [0x11, 0x3D, 0x01];
for (const [label, config, kind] of [['hardware timing', undefined, 'read'], ['MAME timing', { mameCompat: true }, 'read'],
  ['hardware timing', undefined, 'inc'], ['MAME timing', { mameCompat: true }, 'inc'],
  ['6309 native, hardware timing', { cpu: '6309' }, 'native'], ['6309 native, MAME timing', { cpu: '6309', mameCompat: true }, 'native']]) {
  const inc = kind === 'inc', runs = {};
  for (const how of ['one slice', 'frames', 'small slices']) {
    const { m, f, start } = emptyDriveRead(config);
    f.mount(1, { bytes: images.jvc(40, 1), format: 'jvc', name: 'b.dsk' });
    if (inc) start(0xAA, 4, INC_LOOP);
    else if (kind === 'native') { start(0xAA, 4, NATIVE_LOOP, LDMD1); m.cpu.y = 0; }
    else start(0xAA, 4);
    // the data register's accesses as the controller sees them (a replayed one is not made again)
    let reads = 0, writes = 0;
    const rd = f.readIO.bind(f), wr = f.writeIO.bind(f);
    f.readIO = (addr) => { if (addr === 0xFF4B && m.cycle < end) reads++; return rd(addr); };
    f.writeIO = (addr, v) => { if (addr === 0xFF4B && m.cycle < end) writes++; wr(addr, v); };
    let h = 0x811C9DC5, n = 0, suspended = 0;
    const fnv = (v) => { h = Math.imul(h ^ v, 16777619) >>> 0; };
    const end = m.cycle + 20 * m.frameCycles;
    // (the instructions that start before the end: a run in slices may start one or two more)
    m.cpu.trace = (c) => { if (m.cycle >= end) return; n++; for (const r of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc', 'dp', 'totalCycles']) fnv(c[r]); };
    if (how === 'one slice') m.runCycles(end);
    else if (how === 'frames') while (m.cycle < end) { m.runFrame(); if (m.halt.haltDefer) suspended++; }
    else while (m.cycle < end) { m.runCycles(m.cycle + 37); if (m.halt.haltDefer) suspended++; }
    m.cpu.trace = null;
    if (kind === 'native') runs.native = m.cpu.native;
    runs[how] = { h, n, suspended, x: m.cpu.x, io: `${reads}/${writes}/${f.wd.status}`, ram: [...m.ram.subarray(0x4000, 0x4100)].join() };
  }
  const a = runs['one slice'], b = runs.frames, c = runs['small slices'];
  const sector4 = Array.from({ length: 256 }, (_, i) => images.sectorByte(0, 0, 4, i)).join();
  check(`coco3 halted ${inc ? 'INC $FF4B' : kind === 'native' ? 'LDA $FF4B,Y' : 'read'} released by DRQ (${label}): suspended at frame ends and in small slices, the same trace${inc ? '' : ' and data'} as one slice`,
    a.n > 1000 && (inc || (a.x >= 0x4100 && a.ram === sector4)) && (kind !== 'native' || runs.native) && a.suspended === 0 && b.suspended >= 9 && a.io === b.io && a.io === c.io && b.suspended > 0 && c.suspended > 0 && a.h === b.h && a.h === c.h && a.ram === b.ram && a.ram === c.ram,
    JSON.stringify(runs, (k, v) => (k === 'ram' ? undefined : v)));
}

// the controller taken out of the slot while an instruction is suspended (its HALT goes at once, not through an
// event): released where the time has got to. The machine's time never goes back, and the next frame is one frame.
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
  const { m, start } = emptyDriveRead(config);
  start(0xAA);
  for (let i = 0; i < 600; i++) m.runFrame();
  const suspended = !!m.halt.haltDefer, cycle0 = m.cycle, total0 = m.cpu.totalCycles;
  m.ejectCartridge();
  const t0 = Date.now();
  m.runFrame();
  const ms = Date.now() - t0;
  check(`coco3 suspended by HALT for 600 frames, then the controller taken out (${label}): released, the time goes on from where it was`,
    suspended && !m.cpu.haltLine && m.halt.haltDefer === null && m.cycle >= cycle0 + m.frameCycles - 64 && m.cycle < cycle0 + 2 * m.frameCycles && ms < 200,
    `suspended ${suspended}, frame ${m.cycle - cycle0} ticks in ${ms} ms, ${m.cpu.totalCycles - total0} CPU cycles`);
}

// under the debugger (a breakpoint set, so frames run through Debugger.runTo, one step at a time): released after
// 600 suspended frames, the rest of the wait goes at once, and the next frame is one frame; a reset then starts the
// CPU at once (none of the wait is left)
for (const [label, config] of [['hardware timing', undefined], ['MAME timing', { mameCompat: true }]]) {
  const { m, start } = emptyDriveRead(config);
  start(0xAA);
  const dbg = new Emu.Debugger(m);
  dbg.addBreakpoint(0x0000);
  for (let i = 0; i < 600; i++) dbg.runFrame();
  const suspended = !!m.halt.haltDefer, cycle0 = m.cycle;
  m.write(0xFF48, 0xD8);                       // Force Interrupt, immediate: INTRQ clears HALT enable
  const t0 = Date.now();
  dbg.runFrame();
  const ms = Date.now() - t0;
  check(`coco3 under the debugger, released after 600 suspended frames (${label}): the next frame is one frame, at once`,
    suspended && !m.cpu.haltLine && m.halt.haltDefer === null && m.cycle >= cycle0 + m.frameCycles - 64 && m.cycle < cycle0 + 2 * m.frameCycles && ms < 1000,
    `suspended ${suspended}, frame ${m.cycle - cycle0} ticks in ${ms} ms`);
  dbg.detach();
}
// a reset with the rest of a halted wait still to run (cpu.haltTail, set here: the wait's charge above leaves none
// in a run) leaves none of it: the CPU runs at once
{
  const { m } = emptyDriveRead();
  m.cpu.haltTail = 1000000; m.halt.haltS = 5; m.halt.haltAt = 7;
  m.reset(true);
  let ran = 0;
  m.cpu.trace = () => { ran++; };
  m.runFrame();
  m.cpu.trace = null;
  check('coco3: a reset in the rest of a halted wait leaves none of it: the CPU runs at once', m.cpu.haltTail === 0 && m.halt.haltS === -1 && m.halt.haltAt === -1 && ran > 1000, `${ran} instructions`);
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
