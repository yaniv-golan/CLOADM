// Run: node tests/profiler.test.js
//
// The hot-spot profiler (js/profiler.js, Session.profile). Oracles:
//   * cycles: synthetic programs whose cycles per routine are counted by hand from the data sheets (Motorola
//     MC6809E data sheet, the instruction cycle tables and the indexed-mode table: "+~" for ,X+ is 2 and for ,X 0;
//     Motorola MC6801/MC6803 data sheet, the instruction tables: BSR 6, RTS 5, LDX # 3, LDAA/STAA indexed 4, INX 3),
//     and the CPU's own counter: the profile's total equals the cpu.totalCycles delta exactly;
//   * spin or compute: loops whose nature is known by construction (docs/examples/framecount.asm's field-sync wait,
//     which polls $FF03; a RAM flag nobody sets; loops that write RAM or only count in a register);
//   * halted: the CoCo FDC's HALT holding the CPU on an empty drive (as tests/halt-held.test.js) - no instruction runs;
//   * host state: a profiled run and an unprofiled one leave the machines identical, a snapshot carries nothing of
//     it, and with no profile the machine has no probe and its bus is the family's own.
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();
const images = require('../tools/mame-diff/fdc/images');
const { HostHooks } = require('../js/hooks.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return !re || re.test(e.message); } };

const assemble = (src, cpu) => {
  const r = Emu.assemble(src, cpu);
  if (!r.ok) throw new Error('test program does not assemble: ' + JSON.stringify(r.errors));
  return r;
};
const session = (id) => { const s = new Emu.Session({ welcomeMenu: false }); s.switchMachine(id, {}, { menu: false }); return s; };
const row = (r, symbol) => r.rows.find((x) => x.symbol === symbol);
const cyclesPerFrame = (m) => { const t = m.cpu.totalCycles; m.runFrame(); return m.cpu.totalCycles - t; };
const busIntact = (m) => { const p = Object.getPrototypeOf(m); return !Object.hasOwn(m, 'read') && !Object.hasOwn(m, 'write') && m.read === p.read && m.write === p.write; };

// ---------------- 1. cycles: hand counts ----------------
// MAIN runs once, then LOOP ten times: two calls and the loop's own test. SUBA1's range is the inner loop and the RTS.
const PROG6809 = `
        ORG     $3000
START   ORCC    #$50
        LDS     #$7F00
MAIN    LDB     #10             ; 2
LOOP    BSR     SUBA            ; 7
        BSR     SUBB            ; 7
        DECB                    ; 2
        BNE     LOOP            ; 3                       LOOP: 19 x 10 = 190
DONE    BRA     DONE
SUBA    LDA     #5              ; 2                       SUBA: 2 x 10 = 20
SUBA1   DECA                    ; 2
        BNE     SUBA1           ; 3   (2 + 3) x 5 + 5 = 30 a call, x 10 = 300
        RTS                     ; 5
SUBB    LDX     #$3200          ; 3
        LDA     ,X+             ; 4 + 2
        STA     ,X              ; 4 + 0
        RTS                     ; 5   3 + 6 + 4 + 5 = 18 a call, x 10 = 180
        END     START
`;
const HAND6809 = { MAIN: 2, LOOP: 190, SUBA: 20, SUBA1: 300, SUBB: 180 };
const PROG6803 = `
        ORG     $4800
START   SEI
        LDS     #$4FF0
MAIN    LDAB    #10             ; 2
LOOP    BSR     SUBA            ; 6
        BSR     SUBB            ; 6
        DECB                    ; 2
        BNE     LOOP            ; 3                       LOOP: 17 x 10 = 170
DONE    BRA     DONE
SUBA    LDAA    #5              ; 2                       SUBA: 2 x 10 = 20
SUBA1   DECA                    ; 2
        BNE     SUBA1           ; 3   (2 + 3) x 5 + 5 = 30 a call, x 10 = 300
        RTS                     ; 5
SUBB    LDX     #$4A00          ; 3
        LDAA    0,X             ; 4
        STAA    1,X             ; 4
        INX                     ; 3
        RTS                     ; 5   3 + 4 + 4 + 3 + 5 = 19 a call, x 10 = 190
        END     START
`;
const HAND6803 = { MAIN: 2, LOOP: 170, SUBA: 20, SUBA1: 300, SUBB: 190 };

for (const [id, src, cpu, hand] of [['dragon64', PROG6809, '6809', HAND6809], ['coco3', PROG6809, '6809', HAND6809], ['mc10', PROG6803, '6803', HAND6803]]) {
  const s = session(id), res = assemble(src, cpu), sym = res.symbols;
  s.runAssembled(res);
  s.debug.runUntil(sym.get('MAIN'));
  check(`${id}: the program reached MAIN`, s.shownMachine.cpu.pc === sym.get('MAIN'));
  const t0 = s.shownMachine.cpu.totalCycles;
  const p = s.profile();
  s.debug.runUntil(sym.get('DONE'));
  const r = p.stop(), delta = s.shownMachine.cpu.totalCycles - t0;
  const want = Object.values(hand).reduce((a, b) => a + b, 0);
  check(`${id}: the profile's total is the cpu.totalCycles delta exactly (${r.total} = ${delta})`, r.total === delta && r.mode === 'cycles');
  check(`${id}: ... and the hand count (${want})`, r.total === want, `${r.total}`);
  for (const [name, n] of Object.entries(hand)) {
    const x = row(r, name);
    check(`${id}: ${name}: ${n} cycles, share ${(n / want).toFixed(4)}`, x && x.count === n && Math.abs(x.share - n / want) < 1e-12, JSON.stringify(x));
  }
  check(`${id}: every cycle is in a symbol's range; nothing halted`, r.unattributed === 0 && r.halted === 0 && r.rows.every((x) => x.symbol !== null));
  check(`${id}: a range runs from its symbol to the next one`, row(r, 'SUBA').start === sym.get('SUBA') && row(r, 'SUBA').end === sym.get('SUBA1') - 1);
  check(`${id}: the stopped profile has no probe and no tap left`, s.shownMachine.pcWatch === null && busIntact(s.shownMachine) && s.hooks.list.length === 0);
  check(`${id}: a report after stop is the same`, JSON.stringify(p.report()) === JSON.stringify(r));
}

// ---------------- 2. spin or compute ----------------
const SPIN6809 = `
        ORG     $3000
START   ORCC    #$50
        BRA     START
FLAGW   LDA     FLAG            ; a RAM flag nothing sets: the same RAM byte read again and again
        BEQ     FLAGW
        BRA     FLAGW
POLLW   LDA     $FF03           ; polls I/O, but writes RAM each time: compute
        STA     $3300
        BRA     POLLW
COMP    LDA     ,X+             ; a sum over a table, into RAM
        ADDA    SUM
        STA     SUM
        CMPX    #$3500
        BNE     COMP
        LDX     #$3400
        BRA     COMP
DELAY   LEAX    -1,X            ; a register countdown: no RAM, no I/O
        BNE     DELAY
        BRA     DELAY
FLAG    FCB     0
SUM     FCB     0
        END     START
`;
const profileAt = (s, res, label, frames, opts) => {
  s.debug.setRegister('pc', res.symbols.get(label));
  s.debug.setRegister('x', 0x3400);
  const p = s.profile(opts);
  s.runFrames(frames);
  return p.stop();
};
for (const id of ['dragon64', 'coco3']) {
  // the documented field-sync loop
  const s = session(id);
  s.runAssembled(assemble(fs.readFileSync(path.join(__dirname, '../docs/examples/framecount.asm'), 'utf8'), '6809'));
  s.runFrames(3);
  const p = s.profile();
  s.runFrames(20);
  const r = p.stop(), w = row(r, 'WAITFS');
  check(`${id}: framecount: WAITFS is the hot spot`, r.rows[0] === w && w.share > 0.99, JSON.stringify(r.rows[0]));
  check(`${id}: framecount: WAITFS is spin, polling $FF03`, w.spin.share > 0.98 && w.spin.polls.includes('$FF03'), JSON.stringify(w.spin));
  // the known loops
  const t = session(id), res = assemble(SPIN6809, '6809');
  t.runAssembled(res); t.runFrames(1);
  const flag = row(profileAt(t, res, 'FLAGW', 3), 'FLAGW');
  check(`${id}: a wait on a RAM flag is spin, polling the flag`, flag.spin.share > 0.99 && flag.spin.polls.join() === `$${res.symbols.get('FLAG').toString(16).toUpperCase()}`, JSON.stringify(flag));
  const poll = row(profileAt(t, res, 'POLLW', 3), 'POLLW');
  check(`${id}: a loop that polls I/O but writes RAM is compute`, poll.share > 0.99 && poll.spin.share === 0 && poll.spin.polls.length === 0, JSON.stringify(poll));
  const comp = row(profileAt(t, res, 'COMP', 3), 'COMP');
  check(`${id}: a sum into RAM is compute`, comp.share > 0.99 && comp.spin.share === 0, JSON.stringify(comp));
  const delay = row(profileAt(t, res, 'DELAY', 3), 'DELAY');
  check(`${id}: a register countdown is compute (it polls nothing)`, delay.share > 0.99 && delay.spin.share === 0, JSON.stringify(delay));
}
{ // the MC-10: the $BF00-$BFFF page (keyboard read, VDG latch write) is I/O; the 6803's own registers ($0000-$0014)
  // never reach the bus, so a port-1 strobe is no access the profile sees (and so no RAM write)
  const SPIN6803 = `
        ORG     $4800
START   SEI
        BRA     START
KEYW    LDAA    $BFFF
        BRA     KEYW
SCAN    LDAA    #$FE            ; a keyboard scan: strobe a column on port 1 ($0002), read the rows
        STAA    $02
        LDAB    $BFFF
        BRA     SCAN
RES15   LDAA    $BFFF           ; the same, writing $0015: the first address past the 6803's registers
        STAA    $15
        BRA     RES15
RES13   LDAA    $BFFF           ; the same, writing $0013 (the serial transmit register: on the chip, never the bus)
        STAA    $13
        BRA     RES13
RES     LDAA    $BFFF           ; the same, writing $0018: past the 6803's registers ($0000-$0014), so it reaches the bus
        STAA    $18
        BRA     RES
LATCH   LDAA    $BFFF           ; a wait that writes the VDG latch back each time
        STAA    $BFFF
        BRA     LATCH
PAGE    LDAA    $BFFF           ; the same, writing elsewhere in the $BFxx page (no RAM there)
        STAA    $BF00
        BRA     PAGE
COMP    LDAA    0,X
        ADDA    #1
        STAA    0,X
        INX
        CPX     #$4C00
        BNE     COMP
        LDX     #$4A00
        BRA     COMP
        END     START
`;
  const s = session('mc10'), res = assemble(SPIN6803, '6803');
  s.runAssembled(res); s.runFrames(1);
  const key = row(profileAt(s, res, 'KEYW', 3), 'KEYW');
  check('mc10: a keyboard poll is spin, polling $BFFF', key.spin.share > 0.99 && key.spin.polls.join() === '$BFFF', JSON.stringify(key));
  const scan = row(profileAt(s, res, 'SCAN', 3), 'SCAN');
  check('mc10: a keyboard scan writing port 1 ($0002) is spin, polling $BFFF', scan.share > 0.99 && scan.spin.share > 0.99 && scan.spin.polls.join() === '$BFFF', JSON.stringify(scan));
  const res15 = row(profileAt(s, res, 'RES15', 3), 'RES15'), res13 = row(profileAt(s, res, 'RES13', 3), 'RES13');
  check('mc10: a write to $0015, the first address past the registers, reaches the bus: a write the profile sees, not spin', res15.share > 0.99 && res15.spin.share === 0, JSON.stringify(res15));
  check('mc10: a write to $0013 (the serial transmit register) is on-chip: it never reaches the bus, so the wait is still spin', res13.share > 0.99 && res13.spin.share > 0.99, JSON.stringify(res13));
  const kinds = [0x13, 0x14, 0x15, 0x1F, 0x20].map((a) => s.shownMachine.writeKind(a));
  check('mc10: a poke below $0015 is refused as I/O (the registers), $0015-$001F and above as undecoded (nothing answers)', JSON.stringify(kinds) === '["io","io","undecoded","undecoded","undecoded"]', JSON.stringify(kinds));
  const res18 = row(profileAt(s, res, 'RES', 3), 'RES');
  check('mc10: a write to the reserved $0018 (past the 6803\'s registers, $0000-$0014) reaches the bus, so the profile sees it as a write: not spin', res18.share > 0.99 && res18.spin.share === 0, JSON.stringify(res18));
  const latch = row(profileAt(s, res, 'LATCH', 3), 'LATCH');
  check('mc10: a wait that writes the $BFxx latch is still spin', latch.share > 0.99 && latch.spin.share > 0.99, JSON.stringify(latch));
  const page = row(profileAt(s, res, 'PAGE', 3), 'PAGE');
  check('mc10: ... wherever in the $BF00-$BFFF page it writes', page.share > 0.99 && page.spin.share > 0.99, JSON.stringify(page));
  s.debug.setRegister('x', 0x4A00);
  const p = s.profile(); s.debug.setRegister('pc', res.symbols.get('COMP')); s.debug.setRegister('x', 0x4A00); s.runFrames(3);
  const comp = row(p.stop(), 'COMP');
  check('mc10: a loop over RAM is compute', comp.share > 0.99 && comp.spin.share === 0, JSON.stringify(comp));
}

// ---------------- 3. halted: the CoCo FDC's HALT on an empty drive ----------------
for (const id of ['coco', 'coco3']) {
  const m = Emu.createMachine(id);
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  f.mount(0, { bytes: images.jvc(40, 1), format: 'jvc', name: 'a.dsk' });
  for (let i = 0; i < 3; i++) m.runFrame();
  // READ SECTOR on drive 1 (empty) with HALT enabled, then the DOS loop: LDA $FF4B (held), STA ,X+, BRA
  [0xC6, 1, 0xF7, 0xFF, 0x4A, 0xC6, 0x80, 0xF7, 0xFF, 0x48, 0xC6, 0xAA, 0xF7, 0xFF, 0x40, 0x12, 0xB6, 0xFF, 0x4B, 0xA7, 0x80, 0x20, 0xF9]
    .forEach((b, i) => m.poke(0x3000 + i, b));
  m.cpu.x = 0x4000; m.cpu.pc = 0x3000; m.cpu.cc |= 0x50;
  const h = new HostHooks();
  h.attach(m);
  const t0 = m.cpu.totalCycles;
  const p = new Emu.Profiler(h, { symbols: { DOS: 0x3000 } });
  for (let i = 0; i < 10; i++) m.runFrame();
  // released (FORCE INTERRUPT: INTRQ clears the latch's HALT enable); the CoCo 3 counts a held instruction's wait
  // when it completes, the CoCo 2 a cycle at a time
  m.write(0xFF48, 0xD8);
  m.runFrame();
  const r = p.stop(), delta = m.cpu.totalCycles - t0;
  check(`${id}: held by HALT: the total is still the cycle delta (${r.total} = ${delta})`, r.total === delta);
  check(`${id}: ... the held part in the halted row (ten frames of eleven)`, r.halted > 0.85 * r.total && row(r, '(halted)').count === r.halted && row(r, '(halted)').spin === null, JSON.stringify(r.rows));
  check(`${id}: ... the rest at addresses: the DOS loop after the release, and the NMI the end of the command takes`, row(r, 'DOS').count > 1000 && r.rows.reduce((a, x) => a + x.count, 0) === r.total);
  const perFrame = cyclesPerFrame(m);
  check(`${id}: ... the halted cycles are the ten frames held, give or take a frame`, r.halted > 9 * perFrame && r.halted < 11 * perFrame, `${r.halted}, ${perFrame} a frame`);
}

// ---------------- 4. samples ----------------
{
  const s = session('dragon64');
  const fc = assemble(fs.readFileSync(path.join(__dirname, '../docs/examples/framecount.asm'), 'utf8'), '6809');
  s.runAssembled(fc); s.runFrames(3);
  const t0 = s.shownMachine.cpu.totalCycles;
  const p = s.profile({ mode: 'samples', every: 997 });
  s.runFrames(20);
  const r = p.stop(), delta = s.shownMachine.cpu.totalCycles - t0;
  check(`samples: one sample per ${r.every} cycles (${r.total} for ${delta})`, r.mode === 'samples' && r.total === Math.floor(delta / 997), `${r.total}`);
  check('samples: the field-sync wait is the hot spot, spin', row(r, 'WAITFS').share > 0.98 && row(r, 'WAITFS').spin.share > 0.9);
}

// ---------------- 5. folding: pages, the bucket bound, top ----------------
{
  const s = session('dragon64'), res = assemble(PROG6809, '6809');
  s.runAssembled(res); s.debug.runUntil(res.symbols.get('MAIN'));
  const p = s.profile({ symbols: {} });
  s.debug.runUntil(res.symbols.get('DONE'));
  const r = p.stop();
  check('no symbols: everything folds into 256-byte pages, all unattributed', r.rows.length === 1 && r.rows[0].symbol === null && r.rows[0].start === 0x3000 && r.rows[0].end === 0x30FF && r.unattributed === r.total && r.total === 692, JSON.stringify(r.rows));
  check('the report says the histogram is keyed by CPU address (banked code aliases)', /CPU address/.test(r.note) && /banked|MMU/.test(r.note));
  // a symbol covers at most SPAN bytes; past that, pages
  const q = s.profile({ symbols: { LOW: 0x1000 } });
  s.debug.setRegister('pc', res.symbols.get('MAIN')); s.debug.runUntil(res.symbols.get('DONE'));
  const rq = q.stop();
  check('a symbol far below the code covers at most 4K: the code is in pages', rq.rows.every((x) => x.symbol === null) && rq.unattributed === rq.total);
  // the bucket bound: five ranges, two kept
  const b = s.profile({ buckets: 2 });
  s.debug.setRegister('pc', res.symbols.get('MAIN')); s.debug.runUntil(res.symbols.get('DONE'));
  const rb = b.stop(), named = rb.rows.filter((x) => x.start !== null), other = row(rb, '(other)');
  check('buckets: 2: the two largest ranges are kept (SUBA1, LOOP)', named.length === 2 && named[0].symbol === 'SUBA1' && named[1].symbol === 'LOOP', JSON.stringify(rb.rows));
  check('buckets: 2: the other three ranges in one (other) row, the total kept', other && other.count === 2 + 20 + 180 && other.ranges === 3 && rb.rows.reduce((a, x) => a + x.count, 0) === rb.total);
  const t = s.profile();
  s.debug.setRegister('pc', res.symbols.get('MAIN')); s.debug.runUntil(res.symbols.get('DONE'));
  const rt = t.report({ top: 2 });
  t.stop();
  check('report({ top: 2 }): the two largest rows', rt.rows.length === 2 && rt.rows[0].symbol === 'SUBA1' && rt.ranges === 5);
  // a report while running counts up to now; the next probe adds nothing twice
  const u = s.profile();
  s.debug.setRegister('pc', res.symbols.get('MAIN'));
  const u0 = s.shownMachine.cpu.totalCycles;
  s.debug.runUntil(res.symbols.get('SUBA'));
  const mid = u.report();
  check('a report while running: the total so far', mid.total === s.shownMachine.cpu.totalCycles - u0, `${mid.total}`);
  s.debug.runUntil(res.symbols.get('DONE'));
  check('... and the final report still the hand count', u.stop().total === 692);
}

// ---------------- 6. Session: errors, snapshots, host state ----------------
{
  const s = session('dragon64');
  for (const bad of [{ mode: 'fast' }, { every: 0 }, { every: 1.5 }, { buckets: 0 }, { buckets: 0x10001 }]) {
    check(`profile(${JSON.stringify(bad)}) is refused`, throws(() => s.profile(bad)) && s.hooks.list.length === 0 && s.shownMachine.pcWatch === null);
  }
  const p = s.profile();
  check('report({ top: 0 }) is refused', throws(() => p.report({ top: 0 })));
  p.stop();
  check('with no profile: no probe, the bus is the family\'s own', s.shownMachine.pcWatch === null && busIntact(s.shownMachine));
}
(async () => {
  // a profiled run leaves the machine exactly as an unprofiled one, and its snapshot is the same
  const runs = [];
  for (const profiled of [false, true]) {
    const s = session('coco3');
    s.runAssembled(assemble(fs.readFileSync(path.join(__dirname, '../docs/examples/framecount.asm'), 'utf8'), '6809'));
    const p = profiled ? s.profile() : null;
    s.runFrames(30);
    const snap = JSON.stringify(s.shownMachine.saveState());
    runs.push({ s, p, snap, cycles: s.shownMachine.cpu.totalCycles });
  }
  check('a profiled run ends where an unprofiled one does (cycles, machine state)', runs[0].cycles === runs[1].cycles && runs[0].snap === runs[1].snap);
  // openSnapshot: the profile starts empty, and counts from the moment opened
  const { s, p } = runs[1];
  const { bytes } = await runs[0].s.snapshotFile();
  check('before: the profile counted', p.report().total > 0);
  s.openSnapshot(await s.readSnapshot(bytes));
  const r0 = p.report();
  check('openSnapshot: the profile starts empty', r0.total === 0 && r0.rows.length === 0 && r0.halted === 0);
  const t0 = s.shownMachine.cpu.totalCycles;
  s.runFrames(5);
  const r1 = p.stop();
  check('... and counts the opened machine from there (total = its cycle delta)', r1.total === s.shownMachine.cpu.totalCycles - t0 && row(r1, 'WAITFS').share > 0.99);
  check('... its probe and taps came off the new machine', s.shownMachine.pcWatch === null && busIntact(s.shownMachine));
  // a machine switch: the profile follows the machine in use (Session hooks)
  const q = s.profile();
  s.switchMachine('dragon64', {}, { menu: false });
  check('a machine switch: the profile\'s probe is on the new machine', s.shownMachine.pcWatch !== null && !busIntact(s.shownMachine));
  s.runAssembled(assemble(fs.readFileSync(path.join(__dirname, '../docs/examples/framecount.asm'), 'utf8'), '6809'));
  s.runFrames(5);
  check('... and counts there', q.stop().total > 0 && s.shownMachine.pcWatch === null);

  // ---------------- 7. the command line: --profile FILE[:cycles|samples] ... --profile-stop ----------------
  const os = require('os');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-profile-'));
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, '../cli/cloadm.js'), ...args], { cwd: dir, encoding: 'utf8' });
  const SRC = path.join(__dirname, '../docs/examples/framecount.asm');
  const a = cli(['--asm', SRC, '--frames', '5', '--profile', 'hot.txt', '--frames', '20', '--profile-stop', '--frames', '5']);
  const text = fs.existsSync(path.join(dir, 'hot.txt')) ? fs.readFileSync(path.join(dir, 'hot.txt'), 'utf8') : '';
  check('cli: --profile ... --profile-stop writes a text table, WAITFS first, spin, polling $FF03', a.status === 0 && /^\d+ cycles; halted 0/.test(text) && /^ *\d+\.\d%  +\d+  +\d+%  WAITFS \$3046-\$3068  polls .*\$FF03/m.test(text.split('\n')[2]), a.stderr + text);
  const b = cli(['--json', '--asm', SRC, '--frames', '5', '--profile', 'hot.json:samples', '--frames', '20']);
  const out = JSON.parse(b.stdout), step = out.steps.find((x) => x.step === 'profile');
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'hot.json'), 'utf8'));
  check('cli: --json: the file is the report as JSON, written when the run ends without --profile-stop', b.status === 0 && rep.mode === 'samples' && rep.every === 1000 && rep.rows[0].symbol === 'WAITFS' && rep.rows[0].spin.polls.includes('$FF03'));
  check('cli: --json: the profile step\'s result has the totals', step.file === 'hot.json' && step.mode === 'samples' && step.total === rep.total && step.total > 0 && step.rows === rep.rows.length);
  const sym = path.join(dir, 'game.map');
  fs.writeFileSync(sym, 'HOT $3046\n');
  const c = cli(['--asm', SRC, '--symbols', sym, '--profile', 'sym.txt', '--frames', '10']);
  check('cli: --symbols names the ranges', c.status === 0 && /HOT \$3046-\$4045\b/.test(fs.readFileSync(path.join(dir, 'sym.txt'), 'utf8')));
  // the guide's command line ("Finding hot spots"), run as written (the source path from the repository), and the
  // file it writes compared with the table the guide shows
  const guide = fs.readFileSync(path.join(__dirname, '../docs/automation.md'), 'utf8');
  const section = guide.slice(guide.indexOf('### Finding hot spots'));
  const line = /```sh\n(node cli\/cloadm\.js [^\n]*--profile [^\n]*)\n```/.exec(section);
  const table = /```text\n([\s\S]*?)```/.exec(section);
  check('the guide shows a --profile command line and its table', line && table, '');
  if (line && table) {
    const args = line[1].slice('node cli/cloadm.js '.length).split(/\s+/).map((x) => (x.startsWith('docs/') ? path.join(__dirname, '..', x) : x));
    const g = cli(args), file = path.join(dir, args[args.indexOf('--profile') + 1]);
    const got = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    check('the guide\'s command line writes exactly the table the guide shows', g.status === 0 && got === table[1], `${g.stderr}\n--- got\n${got}--- guide\n${table[1]}`);
  }
  const d = cli(['--frames', '1', '--profile-stop']);
  check('cli: --profile-stop with no profile is a usage error', d.status === 2 && /no profile to stop/.test(d.stderr), d.stderr);
  const e = cli(['--profile', ':samples']);
  check('cli: --profile needs a file', e.status === 2 && /FILE\[:cycles\|samples\]/.test(e.stderr), e.stderr);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})();
