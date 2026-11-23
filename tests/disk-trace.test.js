// The Session's disk controller trace and status (session.disk.trace, session.disk.status) and the disk part of
// session.diagnostics(), on the WD2797 (Dragon FDC), the WD2791 (Premier / Delta) and the WD1773 (CoCo FDC). The guests are
// small sector readers on the built-in firmware (no ROMs) against tools/mame-diff/fdc/images.js disks, whose
// bytes are a formula (sectorByte), so what a read should return is known here without running the code under
// test. Double density is 250 kbit/s: a byte every 32 us, about 28.6 CPU cycles at 0.894886 MHz, so a loop that
// takes 22 cycles a byte keeps up and one of 33 loses data. The controllers themselves are MAME-verified
// (tools/mame-diff/run.js <profile> --fdc); the last section shows a trace leaves those runs' hashes unchanged and
// sees the diagnostic firmware's full 256-byte reads.
const fs = require('fs'), os = require('os'), path = require('path');
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const refused = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof Emu.SessionError && re.test(e.message); } };
const asm = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

// The boards: the WD's registers (status/command at wd, data at wd + 3), the drive latch and its value for drive 0,
// motor on, double density (the CoCo's bit 5 also enables NMI: the guest's handler at $0109 returns at once).
const BOARDS = {
  dragonfdc: { machine: 'dragon64', wd: 0xFF40, latch: 0xFF48, on: 0x04 },
  premierfdc: { machine: 'dragon64', wd: 0xFF40, latch: 0xFF44, on: 0x10, invert: true },
  cocofdc: { machine: 'coco', wd: 0xFF48, latch: 0xFF40, on: 0x29 },
};
const hex = (v) => `$${v.toString(16).toUpperCase().padStart(2, '0')}`;
// read (or, with write, write) one sector of track 0, side 0 into $4000 with the CPU polling the status, then keep the
// final status at $3100 and spin at HALT. slow: 11 more cycles a byte (MUL). The WD2791's bus is inverted: the
// guest complements what it writes and reads, as the Delta DOS does.
function guest(board, { cmd, sector = 1, slow = false, write = false }) {
  const b = BOARDS[board], inv = b.invert ? '        COMB\n' : '', inva = b.invert ? '        COMA\n' : '';
  const lo = (a) => hex(a & 0xFF);
  const val = (v) => hex(b.invert ? v ^ 0xFF : v);
  return `
        ORG     $3000
START   ORCC    #$50
        LDA     #$7E            ; NMI (RAM vector $0109): JMP RETN
        STA     $0109
        LDX     #RETN
        STX     $010A
        LDA     #$FF
        TFR     A,DP
        LDA     #${hex(b.on)}
        STA     $${b.latch.toString(16).toUpperCase()}
        LDA     #${val(sector)}
        STA     <${lo(b.wd + 2)}
        LDX     #$4000
        LDA     #${val(cmd)}
        STA     <${lo(b.wd)}
        LDB     #6              ; until the command is taken (bit 1 is still the index pulse)
W       DECB
        BNE     W
${write ? `        LDB     ,X+             ; the byte to write, ready before DRQ asks for it
${inv}RD      LDA     <${lo(b.wd)}
${inva}        BITA    #$02
        BNE     GOT
        BITA    #$01
        BNE     RD
        BRA     DONE
GOT     STB     <${lo(b.wd + 3)}
        LDB     ,X+
${inv}` : `RD      LDA     <${lo(b.wd)}
${inva}        BITA    #$02
        BNE     GOT
        BITA    #$01
        BNE     RD
        BRA     DONE
GOT     LDB     <${lo(b.wd + 3)}
${inv}        STB     ,X+
`}${slow ? '        MUL\n' : ''}        BRA     RD
DONE    STA     $3100
HALT    BRA     HALT
RETN    RTI
        END     START`;
}
// a Session on the built-in firmware with the board in the cartridge port and drive 0 holding a 40-track image
function session(board, { writeProtected = false } = {}) {
  const b = BOARDS[board];
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(b.machine, {}, { menu: false });
  const fdc = new Emu.devices[board]({ rom: new Uint8Array(0x2000) });
  s.shownMachine.insertCartridge(fdc);
  const bytes = board === 'cocofdc' ? images.jvc(40, 1) : images.vdk(40, 2);
  fdc.mount(0, { bytes, format: board === 'cocofdc' ? 'jvc' : 'vdk', name: 'd0', writeProtected });
  return { s, fdc };
}
function run(board, opts, { writeProtected = false, frames = 30, limit } = {}) {
  const { s, fdc } = session(board, { writeProtected });
  const tr = s.disk.trace(limit ? { limit } : {});
  s.runAssembled(asm(guest(board, opts)));
  s.runFrames(frames);
  const ev = tr.events;
  return { s, fdc, tr, ev, done: ev.filter((e) => e.kind === 'done'), cmds: ev.filter((e) => e.kind === 'command'), halted: s.shownMachine.cpu.pc === asm(guest(board, opts)).symbols.get('HALT') };
}
const sectorOk = (s, n, sector = 1) => { for (let i = 0; i < n; i++) if (s.readByte(0x4000 + i) !== images.sectorByte(0, 0, sector, i)) return false; return true; };

(async () => {
// ---------------- the trace's events, a correct read ----------------
for (const board of ['dragonfdc', 'premierfdc', 'cocofdc']) {
  // read sector, single; the WD2797 takes the b flag (bit 3: the ID's length code as it is), the others ignore it
  const r = run(board, { cmd: 0x88 });
  const d = r.done[0] || {};
  check(`${board}: the guest read sector 1 and halted`, r.halted && sectorOk(r.s, 256));
  check(`${board}: one command and one done`, r.cmds.length === 1 && r.done.length === 1, JSON.stringify(r.ev.filter((e) => e.kind !== 'reg-write')));
  const c = r.cmds[0] || {};
  check(`${board}: the command event: read-sector $88, drive 0, side 0, track 0, sector 1, double density`,
    c.cmd === 0x88 && c.name === 'read-sector' && c.drive === 0 && c.side === 0 && c.track === 0 && c.sector === 1 && c.density === 'double', JSON.stringify(c));
  check(`${board}: a correct 256-byte read: bytes 256, requested 256, no lost data, crc, rnf or write protect`,
    d.bytes === 256 && d.requested === 256 && d.lostData === false && d.crc === false && d.rnf === false && d.writeProtect === false && d.name === 'read-sector', JSON.stringify(d));
  check(`${board}: the done status is the final one the guest read (not busy, no error bits)`, d.status === r.s.readByte(0x3100) && (d.status & 0x9D) === 0, `${d.status} ${r.s.readByte(0x3100)}`);
  check(`${board}: events carry at, frame and pc, in order`, r.ev.every((e, i) => Number.isInteger(e.at) && Number.isInteger(e.frame) && Number.isInteger(e.pc) && (i === 0 || e.at >= r.ev[i - 1].at)));
  const w = r.ev.filter((e) => e.kind === 'reg-write');
  const b = BOARDS[board];
  check(`${board}: reg-write events: the latch, the sector and the command, at their addresses, as the CPU wrote them`,
    w.length === 3 && w[0].reg === 'latch' && w[0].addr === b.latch && w[0].value === b.on && w[1].reg === 'sector' && w[1].addr === b.wd + 2 && w[1].value === (b.invert ? 0xFE : 1)
    && w[2].reg === 'command' && w[2].addr === b.wd && w[2].value === (b.invert ? 0x77 : 0x88), JSON.stringify(w));
  check(`${board}: the done comes after the command, the command after its register write`, r.ev.indexOf(r.cmds[0]) > r.ev.indexOf(w[2]) && r.ev.indexOf(r.done[0]) > r.ev.indexOf(r.cmds[0]));
  check(`${board}: the done's pc is the guest's (inside its polling loop)`, d.pc >= 0x3000 && d.pc < 0x3100, hex(d.pc));
}

// ---------------- the two driver bugs ----------------
{
  // a loop of 33 cycles a byte at double density: the WD sets lost data, the CPU took fewer than 256
  for (const board of ['dragonfdc', 'cocofdc']) {
    const r = run(board, { cmd: 0x88, slow: true }), d = r.done[0] || {};
    check(`${board}: a late DRQ reader (33 cycles a byte): lostData, and fewer than 256 bytes taken`, r.halted && d.lostData === true && d.requested === 256 && d.bytes > 0 && d.bytes < 256, JSON.stringify(d));
    // (the last one is whatever byte the WD had last put in the data register: it keeps them coming after the loss)
    check(`${board}: ...and the bytes it took before the loss are the sector's first ones`, d.bytes > 1 && sectorOk(r.s, d.bytes - 1));
  }
  // the WD2797 without the b flag: length code 1 means 512 bytes, so the chip runs on past the 256-byte sector
  const r = run('dragonfdc', { cmd: 0x80 }), d = r.done[0] || {};
  check('dragonfdc: the wrong sector-length bit ($80, no b flag): requested 512', r.halted && d.requested === 512 && d.bytes === 512, JSON.stringify(d));
  check('...the first 256 bytes are the sector\'s', sectorOk(r.s, 256));
  // the WD1773 has no b flag: $80 and $88 read the same 256 bytes
  const c = run('cocofdc', { cmd: 0x80 }), cd = c.done[0] || {};
  check('cocofdc: $80 reads 256 bytes (the length code alone)', cd.requested === 256 && cd.bytes === 256 && !cd.lostData, JSON.stringify(cd));
}

// ---------------- errors: record not found, write protect ----------------
for (const board of ['dragonfdc', 'premierfdc', 'cocofdc']) {
  // sector 19 is not on the track: five index pulses (1 s at 300 rpm), then record not found
  const r = run(board, { cmd: 0x88, sector: 19 }, { frames: 80 }), d = r.done[0] || {};
  check(`${board}: a missing sector reports rnf, no bytes and no requested length`, r.halted && d.rnf === true && d.bytes === 0 && d.requested === null && d.lostData === false, JSON.stringify(d));
  const wp = run(board, { cmd: 0xA8, write: true }, { writeProtected: true }), wd = wp.done[0] || {};
  check(`${board}: write sector on a write-protected disk reports writeProtect, no bytes`, wp.halted && wd.writeProtect === true && wd.bytes === 0 && wd.requested === null && wd.name === 'write-sector', JSON.stringify(wd));
  const ok = run(board, { cmd: 0xA8, write: true }), od = ok.done[0] || {};
  check(`${board}: write sector on a writable disk: 256 bytes taken, no errors`, ok.halted && od.bytes === 256 && od.requested === 256 && !od.writeProtect && !od.lostData, JSON.stringify(od));
}

// ---------------- the ring, stop, status ----------------
{
  const r = run('dragonfdc', { cmd: 0x88 }, { limit: 2 });
  check('a ring of 2 keeps the newest two (command, done) and counts the dropped', r.ev.length === 2 && r.ev[0].kind === 'command' && r.ev[1].kind === 'done' && r.tr.dropped === 3, `${r.ev.map((e) => e.kind)} ${r.tr.dropped}`);
  const { s } = session('dragonfdc');
  check('limit must be a whole number above 0', refused(() => s.disk.trace({ limit: 0 }), /limit/) && refused(() => s.disk.trace({ limit: 1.5 }), /limit/));
  const t = s.disk.trace();
  t.stop();
  check('a trace stopped takes the hook off the controller and the chip', s.drives.controller.trace === null && s.drives.controller.wd.onTrace === null);
  const quiet = new Emu.Session({ welcomeMenu: false });
  quiet.switchMachine('dragon64', {}, { menu: false });
  check('no disk controller: status() and diagnostics().disk are null', quiet.disk.status() === null && quiet.diagnostics().disk === null);
  // a trace started before the cartridge goes in hears it; a machine switch moves it
  const tr = quiet.disk.trace();
  const fdc = new Emu.devices.dragonfdc({ rom: new Uint8Array(0x2000) });
  quiet.shownMachine.insertCartridge(fdc);
  check('a controller plugged in after the trace started is traced', fdc.trace !== null && fdc.wd.onTrace !== null);
  quiet.shownMachine.ejectCartridge();
  check('...and one taken out is not', fdc.trace === null && fdc.wd.onTrace === null);
  quiet.switchMachine('coco', {}, { menu: false });
  const c = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  quiet.shownMachine.insertCartridge(c);
  check('a machine switch keeps the trace (install)', c.trace !== null);
  tr.stop();
  check('stopped: nothing is hooked', c.trace === null && c.wd.onTrace === null);
}
{
  // any number of traces at once, each its own ring; stopping one leaves the others running
  const { s, fdc } = session('dragonfdc');
  const a = s.disk.trace(), b = s.disk.trace({ limit: 2 });
  s.runAssembled(asm(guest('dragonfdc', { cmd: 0x88 })));
  s.runFrames(10);
  const da = a.events.find((e) => e.kind === 'done'), db = b.events.find((e) => e.kind === 'done');
  check('two traces at once both see the read: 256 bytes each (the byte count is per trace)', da && db && da.bytes === 256 && db.bytes === 256 && a.events.length === 5 && b.events.length === 2 && b.dropped === 3, `${a.events.length} ${b.events.length}`);
  a.stop();
  check('one stopped: the other still has the controller hooked', fdc.trace !== null && s.shownMachine.diskTraces.length === 1);
  b.stop();
  b.stop();
  check('both stopped (stop twice is harmless): nothing hooked', fdc.trace === null && fdc.wd.onTrace === null && s.shownMachine.diskTraces.length === 0);
  let msg = null;
  try { s.shownMachine.addDiskTrace(null); } catch (e) { msg = e.message; }
  check('addDiskTrace takes a function', /addDiskTrace/.test(msg || ''));
}
{
  // the Session's hooks move a trace all or nothing: a hook that refuses the next machine keeps every hook, the
  // trace too, on the machine in use, and the trace goes on recording there (it names that machine, not a shared one)
  const { s } = session('dragonfdc');
  const tr = s.disk.trace(), first = s.shownMachine;
  const bad = Emu.createMachine('dragon64');
  const refuse = s.hooks.add((m) => { if (m === bad) throw new Error('this hook refuses that machine'); return () => {}; });
  let refusedMsg = null;
  try { s.hooks.attach(bad); } catch (e) { refusedMsg = e.message; }
  s.runAssembled(asm(guest('dragonfdc', { cmd: 0x88 })));
  s.runFrames(10);
  const d = tr.events.find((e) => e.kind === 'done');
  check('a hook refusing the next machine leaves the disk trace recording on the machine it stayed on',
    refusedMsg === 'this hook refuses that machine' && s.shownMachine === first && bad.diskTraces.length === 0 && first.diskTraces.length === 1 && d && d.bytes === 256 && d.pc >= 0x3000 && d.pc < 0x3100 && d.frame > 0,
    `${refusedMsg}; ${JSON.stringify(d)}`);
  refuse(); tr.stop();
  check('...and stopped, it is off the machine', first.diskTraces.length === 0);
}
{
  // the hook is not state: a snapshot taken with a trace on is the one taken without
  const { s } = session('dragonfdc');
  s.runAssembled(asm(guest('dragonfdc', { cmd: 0x88 })));
  s.runFrames(1);
  const plain = JSON.stringify(s.shownMachine.saveState());
  const t = s.disk.trace();
  const traced = JSON.stringify(s.shownMachine.saveState());
  t.stop();
  check('a snapshot with a trace on holds nothing of it (the same state as without)', plain === traced && !/onTrace|diskTrace/.test(traced));
}
{
  // status() after a read: INTRQ is up (the command ended, and the guest's last status read came before it set?
  // no: the guest read the status after, which cleared it), so give it a fresh command end: a restore
  const { s, fdc } = session('dragonfdc');
  s.runAssembled(asm(`
        ORG     $3000
START   ORCC    #$50
        LDA     #$04
        STA     $FF48
        LDA     #$00            ; restore: INTRQ rises at its end, and nothing reads the status after
        STA     $FF40
HALT    BRA     HALT
        END     START`));
  s.runFrames(20);
  const before = fdc.wd.intrq;
  const st = s.disk.status();
  check('status(): a restore ended, decoded as type I: not busy, track 0, INTRQ up', before === true && st.type === 1 && st.busy === false && st.track0 === true && st.name === 'restore' && st.intrq === true && st.drive === 0 && st.density === 'double' && st.controller === 'dragonfdc' && st.chip === 'wd2797', JSON.stringify(st));
  check('status() does not read the register: INTRQ is still up after it (a read would have cleared it)', fdc.wd.intrq === true && s.disk.status().intrq === true);
  const dg = s.diagnostics();
  check('diagnostics().disk is the same status', JSON.stringify(dg.disk) === JSON.stringify(s.disk.status()));
  check('the WD\'s read() does clear it (the side effect status() must avoid)', (fdc.wd.read(0), fdc.wd.intrq === false));
  // a type II status: lost data shows as bit 2
  const r = run('dragonfdc', { cmd: 0x88, slow: true });
  const s2 = r.s.disk.status();
  check('status() after a late read: type II, lostData', s2.type === 2 && s2.lostData === true && s2.busy === false, JSON.stringify(s2));
}

// ---------------- force interrupt ----------------
{
  // a read of sector 19 (it would search for five revolutions) cut short by $D0
  const { s } = session('dragonfdc');
  const tr = s.disk.trace();
  s.runAssembled(asm(`
        ORG     $3000
START   ORCC    #$50
        LDA     #$04
        STA     $FF48
        LDA     #19
        STA     $FF42
        LDA     #$88
        STA     $FF40
        LDX     #2000
W       LEAX    -1,X
        BNE     W
        LDA     #$D0
        STA     $FF40
HALT    BRA     HALT
        END     START`));
  s.runFrames(20);
  const ev = tr.events.filter((e) => e.kind !== 'reg-write');
  check('a force interrupt: the read ends interrupted, then the $D0 command', ev.length === 3 && ev[0].name === 'read-sector' && ev[1].kind === 'done' && ev[1].interrupted === true && ev[1].cmd === 0x88 && ev[1].bytes === 0 && ev[1].requested === null && ev[2].name === 'force-interrupt', JSON.stringify(ev));
}
{
  // a seek to track 30 at 30 ms a step (about 0.9 s) cut short by $D0: a type I command reports requested 0 even
  // when interrupted (type I moves no data; the interrupted rule is for types II and III)
  const { s } = session('dragonfdc');
  const tr = s.disk.trace();
  s.runAssembled(asm(`
        ORG     $3000
START   ORCC    #$50
        LDA     #$04
        STA     $FF48
        LDA     #30
        STA     $FF43
        LDA     #$13
        STA     $FF40
        LDX     #5000
W       LEAX    -1,X
        BNE     W
        LDA     #$D0
        STA     $FF40
HALT    BRA     HALT
        END     START`));
  s.runFrames(20);
  const ev = tr.events.filter((e) => e.kind !== 'reg-write');
  check('a force-interrupted seek: done interrupted, requested 0 (type I), then the $D0 command', ev.length === 3 && ev[0].name === 'seek' && ev[1].kind === 'done' && ev[1].interrupted === true && ev[1].cmd === 0x13 && ev[1].requested === 0 && ev[2].name === 'force-interrupt', JSON.stringify(ev));
}

// ---------------- a trace leaves the chip as it is: INTRQ, DRQ, NMI, the CPU's lines ----------------
{
  // the Dragon FDC with NMI enabled (latch $24: motor, NMI enable, double density). The guest starts a read of
  // sector 1 and never touches the controller again: DRQ stays up (the cartridge's CART line), the WD sets lost
  // data and ends, and INTRQ rises to NMI, which the guest counts at $3200 and returns from. Nothing reads the status
  // after INTRQ rose, so a trace that read it (instead of computing it) would clear INTRQ and drop NMI.
  const GUEST = `
        ORG     $3000
START   ORCC    #$50
        CLR     $3200
        LDA     #$7E            ; NMI (RAM vector $0109): JMP NMIH
        STA     $0109
        LDX     #NMIH
        STX     $010A
        LDS     #$2F00          ; (NMI is armed once S is loaded)
        LDA     #$24
        STA     $FF48
        LDA     #1
        STA     $FF42
        LDA     #$88
        STA     $FF40
HALT    BRA     HALT
NMIH    INC     $3200
        RTI
        END     START`;
  const run = (traced) => {
    const { s, fdc } = session('dragonfdc');
    const tr = traced ? s.disk.trace() : null;
    s.runAssembled(asm(GUEST));
    const polled = [];
    for (let f = 0; f < 10; f++) { s.runFrames(1); if (traced) polled.push(s.disk.status()); }
    const m = s.shownMachine, c = m.cpu;
    return {
      wd: { intrq: fdc.wd.intrq, drq: fdc.wd.drq, status: fdc.wd.status }, board: { intrq: fdc.intrq, drq: fdc.drq },
      lines: { nmi: m.interrupts.level(fdc.id, 'nmi'), slotNmi: fdc.lines.level('nmi'), cart: fdc.lines.level('cart'), cb1: m.pia1.b.c1 },
      cpu: { nmiPending: c.nmiPending, nmiArmed: c.nmiArmed, firqLine: c.firqLine, irqLine: c.irqLine, haltLine: c.haltLine, pc: c.pc, cycles: c.totalCycles },
      nmis: s.readByte(0x3200), chip: JSON.stringify(fdc.wd.saveState()),
      done: tr ? tr.events.find((e) => e.kind === 'done') : null, polled,
    };
  };
  const plain = run(false), traced = run(true);
  const same = (k) => JSON.stringify(plain[k]) === JSON.stringify(traced[k]);
  check('the untraced run: INTRQ up, NMI asserted and taken once, DRQ up with the CART line, lost data', plain.wd.intrq && plain.lines.nmi && plain.nmis === 1 && plain.wd.drq && plain.lines.cart && (plain.wd.status & 0x04) !== 0, JSON.stringify(plain));
  check('with a trace and status() polled every frame: the WD\'s INTRQ, DRQ and status are the same', same('wd') && same('board'), `${JSON.stringify(plain.wd)} vs ${JSON.stringify(traced.wd)}`);
  check('...the NMI and CART lines (machine.interrupts) are the same', same('lines'), `${JSON.stringify(plain.lines)} vs ${JSON.stringify(traced.lines)}`);
  check('...the CPU\'s lines, PC and cycles, and the NMIs the guest took, are the same', same('cpu') && same('nmis'), `${JSON.stringify(plain.cpu)} vs ${JSON.stringify(traced.cpu)}`);
  check('...and the whole chip state is the same', same('chip'));
  check('...while the trace saw the read end with lost data and status() showed INTRQ up', traced.done && traced.done.lostData === true && traced.polled[traced.polled.length - 1].intrq === true, JSON.stringify(traced.done));
}

// ---------------- the regression runs with a trace on ----------------
{
  const hashes = JSON.parse(fs.readFileSync(path.join(__dirname, 'regress-hashes.json'), 'utf8'));
  const spec = require(path.join(__dirname, '../tools/mame-diff/fdc/spec.js'));
  const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };
  for (const [key, id, opts] of [['trace dragon64 fdc', 'dragon64', { regenerate: false }], ['trace coco fdc', 'coco', { regenerate: false }],
    ['trace dragon64 premierfdc', 'dragon64', { controller: 'premierfdc', regenerate: false }], ['trace coco3 cocofdc halt', 'coco3', { halt: true }],
    ['trace dgnalpha alphafdc', 'dgnalpha', { controller: 'alphafdc', regenerate: false }], ['trace coco cocofdc multi', 'coco', { controller: 'cocofdc', regenerate: false, multi: true }]]) {
    const t = spec.trace(id, opts), m = t.machine(), tr = new Emu.DiskTrace(1000000);
    tr.attach(m);
    const names = t.regs.map((r) => r.name);
    let h = 0x811C9DC5, n = 0, c0 = null, halted = false;
    m.cpu.trace = (c) => {
      if (c0 === null) c0 = c.totalCycles;
      for (const r of names) h = fnv(h, c[r]);
      h = fnv(h, c.totalCycles - c0);
      if (c.pc === t.haltPc) halted = true;
      n++;
    };
    for (let f = 0; f < 5000 && n < t.instructions; f++) m.runFrame();
    const want = hashes[key], hash = h.toString(16).padStart(8, '0');
    check(`${key} with a disk trace on: the regression hash is unchanged`, hash === want.hash && n === want.instructions && halted, `${hash} vs ${want.hash}`);
    const ev = tr.events(), done = ev.filter((e) => e.kind === 'done');
    const full = done.filter((e) => e.name === 'read-sector' && e.requested === 256 && e.bytes === 256 && !e.lostData && !e.crc && !e.rnf);
    check(`...the trace saw commands, ends and register writes, and full 256-byte reads`, ev.some((e) => e.kind === 'command') && ev.some((e) => e.kind === 'reg-write') && full.length > 0,
      `${ev.length} events, ${done.length} done, ${full.length} full reads`);
  }
}

// ---------------- the command line: --disk-trace and the disk in failures ----------------
{
  // the CLI mounts disks only with a disk ROM, so the run starts from a snapshot of the guest with its board and disk
  // in (taken before the guest has run an instruction)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-trace-'));
  const traceFile = path.join(dir, 't.jsonl'), snapFile = path.join(dir, 's.cloadm-state');
  const { s } = session('dragonfdc');
  s.runAssembled(asm(guest('dragonfdc', { cmd: 0x88 })));
  const snap = await s.snapshotFile();
  fs.writeFileSync(snapFile, snap.bytes);
  const cp = require('child_process');
  const cli = (args) => {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '../cli/cloadm.js'), ...args], { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch (e) { /* checked below */ }
    return { code: r.status, json, out: r.stdout, err: r.stderr };
  };
  // a run that fails (the text never comes): the trace is still written, and the error carries the disk
  let r = cli(['--json', '--load-snapshot', snapFile, '--disk-trace', traceFile, '--wait-for', 'text:NEVER', '--timeout', '1']);
  const j = r.json;
  check('--disk-trace on a failed run: the run failed with a timeout', r.code === 1 && j && j.error && j.error.code === 'timeout', `${r.code} ${r.out.slice(0, 300)} ${r.err.slice(0, 300)}`);
  check('...the error carries the disk controller\'s status, next to machine and serial', j && j.error && j.error.disk && j.error.disk.controller === 'dragonfdc' && j.error.disk.busy === false && j.error.disk.name === 'read-sector' && 'machine' in j.error && 'serial' in j.error, JSON.stringify(j && j.error && j.error.disk));
  const lines = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const d = lines.find((e) => e.kind === 'done');
  check('...and the trace file holds the read as JSON Lines: command, done with 256 bytes', lines.some((e) => e.kind === 'command' && e.name === 'read-sector') && d && d.bytes === 256 && d.requested === 256 && lines.every((e) => 'at' in e && 'frame' in e && 'pc' in e), `${lines.length} lines`);
  const step = j && j.steps.find((x) => x.step === 'disk-trace');
  check('--disk-trace: its step result names the file, with the events and dropped filled in at the end', step && step.file === traceFile && step.events === lines.length && step.dropped === 0, JSON.stringify(step));
  r = cli(['--json', '--machine', 'coco', '--disk-trace', traceFile, '--frames', '2']);
  check('--disk-trace: written on success too (no controller: no events)', r.code === 0 && fs.readFileSync(traceFile, 'utf8') === '' && r.json.steps[0].events === 0, `${r.code} ${r.err.slice(0, 200)}`);
  r = cli(['--json', '--machine', 'coco', '--wait-for', 'text:NEVER', '--timeout', '0.1']);
  check('a timeout without a disk controller: error.disk is null', r.code === 1 && r.json && r.json.error.disk === null, JSON.stringify(r.json && r.json.error).slice(0, 200));
  check('--describe lists disk-trace', require('../cli/cloadm.js').describe().steps.some((x) => x.name === 'disk-trace'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------- a full-screen chat: the trace, the status and diagnostics are the person's ----------------
// With the Claude chat full screen its own machine is on screen and the person's (the BASIC session) runs beside it.
// The disk is the person's: a trace started then goes on the BASIC session's controller and records its guest's read,
// status() and diagnostics() describe that machine, and the chat machine gets nothing.
{
  const b = BOARDS.dragonfdc, opts = { cmd: 0x88 };
  const s = new Emu.Session({ welcomeMenu: false, store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  s.switchMachine(b.machine, {}, { menu: false });
  const basic = s.shownMachine, fdc = new Emu.devices.dragonfdc({ rom: new Uint8Array(0x2000) });
  basic.insertCartridge(fdc);
  fdc.mount(0, { bytes: images.vdk(40, 2), format: 'vdk', name: 'd0' });
  s.runAssembled(asm(guest('dragonfdc', opts)));
  const firmware = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples/chat.bin')));
  s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware, brief: '', tools: false });
  const chatM = s.shownMachine;
  const tr = s.disk.trace();
  check('full screen: the chat machine is on screen and the trace is on the BASIC session\'s controller, not the chat machine',
    chatM !== basic && s.personMachine === basic && basic.diskTraces.length === 1 && chatM.diskTraces.length === 0);
  s.runFrames(30);
  const done = tr.events.filter((e) => e.kind === 'done');
  let same = true;
  for (let i = 0; i < 256; i++) if (basic.ram[0x4000 + i] !== images.sectorByte(0, 0, 1, i)) same = false;
  check('full screen: the trace records the BASIC guest\'s 256-byte read, and its RAM holds the sector', done.length === 1 && done[0].bytes === 256 && same, JSON.stringify(done));
  const st = s.disk.status(), d = s.diagnostics();
  check('full screen: status() is the BASIC session\'s controller (its sector register, peeked)', st && st.controller === fdc.type && st.sector === fdc.wd.peek(2), JSON.stringify(st));
  check('full screen: diagnostics() is the BASIC session\'s, pc, frame, now and cycles alike (the chat machine\'s differ)',
    d.pc === basic.cpu.pc && d.frame === basic.frameCount && d.now === basic.now() && d.cycles === basic.cpu.totalCycles
    && (chatM.frameCount !== basic.frameCount || chatM.cpu.totalCycles !== basic.cpu.totalCycles) && d.disk && d.disk.controller === fdc.type,
    JSON.stringify({ pc: d.pc, frame: d.frame, basic: basic.frameCount, chat: chatM.frameCount }));
  tr.stop();
  check('full screen: stopping the trace leaves both machines without one', basic.diskTraces.length === 0 && chatM.diskTraces.length === 0);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
